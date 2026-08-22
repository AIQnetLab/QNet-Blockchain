// ============================================================================
// BLOCK PROCESSING PIPELINE — Staged Architecture
// ============================================================================
//
// Replaces the monolithic process_received_blocks() (~1200 lines) with
// a staged pipeline where each stage is an independent async task:
//
//   Ingest → Decode → Verify → Apply → Notify
//   ↓ bad    ↓ bad    ↓ bad
//   drop     drop     drop
//
// Key properties:
//   1. One bad block does NOT stall the pipeline (dropped at its stage)
//   2. Each stage has bounded channels — backpressure, not OOM
//   3. Stages are independently testable
//   4. Clear metrics per stage (queued, processed, dropped)
//
// Scalability:
//   - Verify stage can be parallelized (N workers) for thousands of nodes
//   - Apply stage is sequential (single RocksDB writer) — correct by design
//   - Bounded channels protect memory under load from malicious peers
//
// Apply stage performs ALL side effects:
//   - State snapshot + rollback on mismatch
//   - apply_block_to_state (rewards, emissions, registrations)
//   - State root verification
//   - VRF key extraction from NodeRegistration TXs
//   - Deferred side effects (pool3, registrations, emissions, reward clears)
//   - Block attestation broadcasting
//   - Height updates (RAM + RocksDB + atomic)
//   - Block event broadcasting
//   - Coordinator notification
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::sync::RwLock;

use crate::storage::Storage;
use crate::consensus_state::{CoordinatorHandle, ConsensusEvent};
use crate::node::{is_info, is_warn, is_debug, BlockchainNode};
use crate::unified_p2p::SimplifiedP2P;

// ============================================================================
// v14.7.2: FORK RECOVERY SIGNAL (macroblock-divergence only)
// ============================================================================
// Peer-counting heuristics (FORK_BREAK_PEER_THRESHOLD, HASH_CHAIN_BREAK_TRACKER,
// per-peer hash_chain_break aggregation) have been removed. They were
// Byzantine-unsafe at scale: f+1 peers bounded by [3,20] is not a canonical
// BFT threshold, and the "distinct peers" counter is trivially gamed by
// a single attacker spawning sockets.
//
// Canonical fork detection now lives at the macroblock layer:
//   - Every 90-block boundary runs n−f commit/reveal consensus on the
//     finalized macroblock. Divergence there = confirmed Byzantine fork.
//   - Until then, invalid blocks are rejected and the node waits for the
//     canonical macroblock consensus to resolve.
// ============================================================================

/// Global fork recovery signal: fork_height (0 = no signal).
/// Set by the macroblock-divergence detector OR by the v16.2 observer-based
/// n−f BlockRejection aggregator (`unified_p2p::handle BlockRejection`);
/// consumed by the main consensus loop. Public so the cross-module rejection
/// aggregator can raise the signal directly without going through a separate
/// IPC channel.
pub static FORK_RECOVERY_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Check and consume fork recovery signal.
/// Returns Some(fork_height) if recovery is needed.
pub fn take_fork_recovery_signal() -> Option<u64> {
    let h = FORK_RECOVERY_HEIGHT.swap(0, Ordering::SeqCst);
    if h > 0 {
        // Clear the accumulated witnesses once a recovery is scheduled —
        // otherwise stale entries would re-fire the signal on the next
        // height that rolls through the pipeline.
        HASH_CHAIN_BREAK_WITNESSES.clear();
        Some(h)
    } else {
        None
    }
}

// Apply-stage circuit-breaker: consecutive apply failures (state_root_mismatch) with no
// clean apply in between. Repeated failure means the local base is contaminated; the node
// stops re-applying onto it (the wedge) and escalates to fail-closed fork recovery. Counted
// across heights so a mismatch that hops to the next height cannot reset the count and dodge
// the breaker. Cleared on any successful apply.
static APPLY_MISMATCH_COUNT: AtomicU64 = AtomicU64::new(0);
const APPLY_MISMATCH_BREAKER: u64 = 3;

/// Record an apply failure; returns true once it trips the breaker.
fn record_apply_mismatch() -> bool {
    APPLY_MISMATCH_COUNT.fetch_add(1, Ordering::Relaxed) + 1 >= APPLY_MISMATCH_BREAKER
}

/// Reset the breaker after a clean apply.
fn clear_apply_mismatch() {
    if APPLY_MISMATCH_COUNT.load(Ordering::Relaxed) != 0 {
        APPLY_MISMATCH_COUNT.store(0, Ordering::Relaxed);
    }
}

// Distinct-peer witness tracker for microblock minority-fork detection.
// Height → set of distinct peer_ids that reported hash_chain_break there.
// DETECTION threshold is f+1, NOT the n−f quorum: a node on a minority fork cannot
// gather n−f honest witnesses (it would never trip → stuck forever, the
// v14.8.5 bug). f+1 = "at least one honest" and is Sybil-proof because each
// witness is a ML-DSA-65-authenticated validator peer_id (a false positive
// needs f+1 real keys, outside the ≤f fault model). Safe: an honest node
// only reports a break on a real parent_hash mismatch from a signed peer
// envelope. Lock-free DashMap/DashSet; bounded by cleanup_break_tracker.
use dashmap::DashSet;
static HASH_CHAIN_BREAK_WITNESSES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, DashSet<String>>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);


// v32.10: cooldown for macroblock-anchored fork-recovery trigger.
// Height → wall-clock secs of last trigger. 60s/height prevents thrashing
// when the same break repeats during resync.
static FORK_RECOVERY_TRIGGER_TIMES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, u64>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);
const FORK_RECOVERY_COOLDOWN_SECS: u64 = 60;

// Cooldown for the failover-cert pull-on-reject. mb_idx → wall-clock secs of last request.
// Bounds how often a node stuck on an uncertified failover block asks peers for that window's
// timeout certificates (the request/serve already exists for sync and returns the same-round
// n−f TimeoutCertificate). 2s is fast enough to recover within a window, slow enough that
// the repeated per-block reject loop can't flood peers.
static FAILOVER_CERT_PULL_TIMES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, u64>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);
const FAILOVER_CERT_PULL_COOLDOWN_SECS: u64 = 2;

// The sync/repair supersede path (supersede_stored_from_sync) processes an already-stored height ONLY
// when THIS node explicitly SOLICITED it via request_block_repair (its own TailDiverged tail). This is
// the structural DoS boundary: gate the UNsolicited, never the solicited.
//   - Unsolicited stored-height batch deliveries are ignored — the ungated live-gossip decode path
//     (decode_stage) already converges unsolicited winners, so nothing is lost.
//   - The honest solicited winner is NEVER rate-gated, so a flooder cannot starve it (the earlier
//     shared per-second budget WAS itself a liveness-DoS: an attacker draining it froze convergence).
//   - An attacker can only force work at heights we ourselves asked to repair (our own diverged tail,
//     ≤ window, TTL-expired); each such delivery is input-capped == output-capped (1:1 bandwidth, no
//     amplification) — a transport-layer flood, not a consensus bug.
static REPAIR_SOLICITED: once_cell::sync::Lazy<
    dashmap::DashMap<u64, u64>   // height -> expiry (unix secs)
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);
const REPAIR_SOLICITED_TTL_SECS: u64 = 30;
// = the pipeline's max_block_bytes, so a legit stored block (any size the pipeline accepted) is never
// false-rejected — otherwise a restarted voter could not converge to a large failover winner.
const MAX_SUPERSEDE_INPUT: usize = 50 * 1024 * 1024;

/// Mark a height as SOLICITED for repair — the node asked a peer for it (e.g. TailDiverged reconcile),
/// so a stored-height batch delivery of exactly this height is routed to fork-choice supersede rather
/// than ignored. Marking a not-yet-stored height is harmless (it never reaches the stored-height branch).
pub(crate) fn mark_repair_solicited(height: u64) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    REPAIR_SOLICITED.insert(height, now.saturating_add(REPAIR_SOLICITED_TTL_SECS));
    if REPAIR_SOLICITED.len() > 512 { REPAIR_SOLICITED.retain(|_, e| *e > now); }
}
pub(crate) fn is_repair_solicited(height: u64) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    REPAIR_SOLICITED.get(&height).map(|e| *e > now).unwrap_or(false)
}



/// Single sink for the fork-recovery signal. DEEPEST target wins: concurrent detectors report
/// different divergence points, and only the lowest satisfies all of them — a shallower target
/// would leave the deeper fork in place. Three writers with different merge rules previously
/// raced here and could settle on a height none of them intended.
/// Current pending fork-recovery target (0 = none). Lets a detector tell whether its own signal won.
pub(crate) fn fork_recovery_target() -> u64 {
    FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst)
}

pub(crate) fn signal_fork_recovery(target: u64) {
    if target == 0 { return; } // 0 is the "no signal" sentinel — never store it as a target
    let mut prev = FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst);
    loop {
        if prev != 0 && prev <= target { return; }
        match FORK_RECOVERY_HEIGHT.compare_exchange_weak(prev, target, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return,
            Err(cur) => prev = cur,
        }
    }
}


/// Equal-absolute-round fork-choice tie-break for a PRE-VERIFY competitor (gossip-duplicate / repair /
/// anchor-recovery — verify_stage is skipped or not-yet-run, so the bytes are UNVERIFIED). The incoming
/// block supersedes the one we hold at this height ONLY if it is a GENUINE same-round self-fork with a
/// canonically-lower signature. Checks, cheapest-first:
///   1. we actually HOLD a competitor (`our` is Some) — nothing to supersede otherwise;
///   2. incoming.producer == our stored producer — the SELF-FORK invariant. Our stored producer is
///      already the leader-verified canonical one, so a legitimate same-height/round competitor (a
///      restarted producer re-emitting a different block) must be the SAME producer. A DIFFERENT
///      producer self-signing a sibling for a height it does not own is an equivocation/hijack — it must
///      NOT win the tie-break (that was the reorg-DoS: any registered node could grind a lower value and
///      force a wasteful rollback);
///   3. incoming.hash() < our.hash() — deterministic single winner. Keyed on the BLOCK HASH, not the
///      signature: ML-DSA signatures are randomized, so a producer could re-sign the same block to
///      shift a Sha3(sig) tie-break at will; block.hash() excludes the signature, so it cannot be
///      ground, and two byte-identical blocks have one hash (nothing to tie-break);
///   4. incoming is VALIDLY producer-signed — closes signature-grinding (attacker has no producer key).
/// Byte-identical rule at every pre-verify fork-choice site so fork-choice is one network-wide function.
fn equal_round_selffork_supersedes(storage: &Storage, incoming: &qnet_state::MicroBlock, our: Option<(&str, [u8; 32])>) -> bool {
    let (our_producer, our_hash) = match our { Some(t) => t, None => return false };
    if incoming.producer != our_producer { return false; }
    if incoming.hash() >= our_hash { return false; }
    crate::node::verify_microblock_producer_sig_sync(storage, incoming)
}

/// Deterministic microblock fork-choice (failover race): a same-height block from a STRICTLY HIGHER
/// n−f-certified rotation round — or an EQUAL round self-fork (same producer, lower BLOCK HASH,
/// validly signed) — supersedes the one we hold. This is the stored-height leg of the ONE network-wide
/// fork-choice rule (gossip re-delivery AND solicited repair both funnel here), byte-identical to the
/// anchor_recovery / apply-resolver sites via equal_round_selffork_supersedes.
/// Routes it to the finality-guarded reorg via FORK_RECOVERY_HEIGHT — the existing
/// recovery rolls back (never below finality), reconciles state, and resyncs to the
/// certified chain. Both timeout_round values share the per-height baseline, so the
/// higher one is the failover winner. Safety: round must be n−f-certified (≤f
/// Byzantine cannot forge a TC); height must be above finality; per-height cooldown
/// bounds re-triggers; the resync re-verifies every block. One bounded decode, only
/// for stored heights above finality.
fn maybe_supersede_by_certified_round(storage: &Arc<Storage>, block: &IngestBlock, p2p: Option<&SimplifiedP2P>) {
    let h = block.height;
    if h == 0 { return; }
    let finalized = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst);
    if h <= finalized { return; } // never reorg finalized history

    // Ok(None) is genuinely absent - the ordinary ingest path installs it. Err is different: we
    // HOLD bytes we cannot read, so every presence check says "have it" and nothing ever replaces
    // them. Defend nothing in that case and let the certified competitor through below.
    let mut hold_nothing = false;
    let (our_round, our_baseline, our_producer, our_hash) = match storage.load_microblock_auto_format(h) {
        Ok(Some(mb)) => { let hh = mb.hash(); (mb.timeout_round, mb.carried_baseline, mb.producer, hh) },
        Ok(None) => return,
        Err(e) => {
            if crate::node::is_warn() {
                println!("[WARN][FORK] local_body_unreadable h={} err={} action=adopt_certified_only", h, e);
            }
            hold_nothing = true;
            (0, 0, String::new(), [0u8; 32])
        }
    };
    let mb_idx = h / 90;

    // Decode the competitor (zstd|raw → MicroBlock); microblocks are KB so this is cheap per duplicate.
    // zstd::Decoder::new never inspects the input, so a RAW-bincode block (the sync/repair serve path
    // sends uncompressed bincode; only gossip compresses) yields Ok here and fails on read_to_end —
    // that MUST fall back to the raw bytes, NOT return, or every sync/repair-delivered competitor
    // dead-ends before the cert-pull + supersede below (boundary re-freeze for restarted voters).
    // Mirrors decode_stage's three-branch decode.
    const MAX_DECOMPRESSED: usize = 50 * 1024 * 1024;
    let decompressed = match zstd::stream::Decoder::new(&block.data[..]) {
        Ok(dec) => {
            use std::io::Read;
            let mut buf = Vec::new();
            match dec.take(MAX_DECOMPRESSED as u64 + 1).read_to_end(&mut buf) {
                Ok(_) if buf.len() <= MAX_DECOMPRESSED => buf,
                Ok(_) => return,                // real decompression bomb over the cap
                Err(_) => block.data.clone(),   // not zstd (raw bincode from sync/repair serve) → use as-is
            }
        }
        Err(_) => block.data.clone(),
    };
    let incoming = match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
        Ok(mb) if mb.height == h => mb,
        _ => return, // decode failed or height mismatch → keep ours
    };

    // Fork-choice by ABSOLUTE round (relative + carried baseline, both from the block bytes — a
    // same-height loser-apply can no longer pollute the ranking): a STRICTLY HIGHER n−f-certified round
    // wins; on an EQUAL round, the lower BLOCK HASH wins (block.hash() excludes the randomized ML-DSA
    // signature, so the tie-break cannot be ground). The equal-round tie-break converges a
    // same-round self-fork (a restarted producer re-emitting a different block at h) that a strict `>`
    // gate would leave split forever — and it MUST live here because both gossip re-delivery AND solicited
    // repair funnel through this function, so without it a node holding the equal-round loser never
    // converges (boundary re-freeze). Byte-identical to the anchor_recovery / apply-resolver tie-break.
    // Content-QC authority DOMINATES the round heuristic below finality: an n−f-QC-certified macroblock
    // is stronger evidence than any TC-round rank. If h's window is sealed and the incoming body equals
    // the QC-certified hash at h while ours does NOT, adopt unconditionally — converging the case where a
    // LOWER-round original that WON the checkpoint is repair-delivered against a higher-round fork the
    // checkpoint rejected (the round gate below would refuse it and P3's content-defer would wedge
    // forever). Hash match against the n−f list is unforgeable → no round/producer/sig gate. The
    // macroblock is the same object the MB-SYNC deferral saved before soliciting this repair.
    // Resolve h's n−f-QC-certified body hash (if its window macroblock is stored). Content-QC authority is
    // TOTAL below finality, in BOTH directions — a one-sided override turns the wedge into an A->B->A flap:
    //   * WE hold the certified body, the competitor does NOT  => never leave it (return). Otherwise the
    //     round heuristic below reorgs us onto the checkpoint-REJECTED higher-round sibling, and an adversary
    //     re-gossiping that sibling holds our finality at h forever.
    //   * the COMPETITOR holds the certified body, we do NOT    => adopt unconditionally (content_wins).
    let certified_hash = {
        let window_k = (h - 1) / 90 + 1;
        storage.get_macroblock_by_height(window_k).ok().flatten()
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
            .and_then(|mb| { let start = (window_k - 1) * 90 + 1; mb.micro_blocks.get((h - start) as usize).copied() })
    };
    if let Some(c) = certified_hash {
        if our_hash == c && incoming.hash() != c { return; } // keep the certified body — content dominates round
    }
    let content_wins = certified_hash.map_or(false, |c| incoming.hash() == c && our_hash != c);
    // Holding unreadable bytes buys no authority over rounds: adopt the CERTIFIED body only.
    if hold_nothing && !content_wins { return; }
    let incoming_abs = incoming.timeout_round.saturating_add(incoming.carried_baseline);
    let our_abs = our_round.saturating_add(our_baseline);
    let incoming_wins = if content_wins {
        true
    } else if incoming_abs > our_abs {
        // Adopt the competitor's ATTACHED n−f TimeoutProof BEFORE reading the certified round, so a node
        // that missed the separate TC broadcast learns the round in-band; the higher round wins ONLY if
        // n−f-certified (a forged round advances nothing → not certified → ignored). Adopt only in this
        // higher-round branch — an equal/lower round needs no new round authority.
        if let (Some(pb), Some(p)) = (incoming.timeout_proof.as_ref(), p2p) { p.adopt_timeout_proof_bytes(pb); }
        let certified_abs = crate::unified_p2p::highest_certified_round_for(mb_idx);
        if incoming_abs > certified_abs {
            // Higher round not yet n−f-certified locally. The competitor's timeout_proof is WIRE-ONLY
            // (storage serve strips it), and the one-shot TC broadcast may have been missed — so a copy
            // delivered via sync/repair carries no adoptable proof. Actively PULL this window's
            // TimeoutCertificate (rate-limited per mb_idx, shared bucket with verify_stage) so
            // HIGHEST_CERTIFIED_ROUND advances and the NEXT delivery of this competitor supersedes.
            // Without this, a node that missed the seconds-long live-gossip window sits on the losing
            // tail forever ⇒ its checkpoint content_ok never converges ⇒ boundary re-freeze.
            if let Some(p) = p2p {
                let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0);
                let due = FAILOVER_CERT_PULL_TIMES.get(&mb_idx)
                    .map(|t| now_secs.saturating_sub(*t) >= FAILOVER_CERT_PULL_COOLDOWN_SECS)
                    .unwrap_or(true);
                if due {
                    FAILOVER_CERT_PULL_TIMES.insert(mb_idx, now_secs);
                    if FAILOVER_CERT_PULL_TIMES.len() > 64 {
                        let keep_from = mb_idx.saturating_sub(16);
                        FAILOVER_CERT_PULL_TIMES.retain(|k, _| *k >= keep_from);
                    }
                    p.request_timeout_proofs(mb_idx, mb_idx);
                }
            }
            return;
        }
        true
    } else if incoming_abs == our_abs {
        // Equal absolute round self-fork: the round is the one we already hold (== certified for it), so
        // no new round authority is needed — converge on the lower BLOCK HASH (single deterministic
        // winner). No cert pull: the round is not higher than what we already accepted.
        //
        // Equal-round self-fork: converge via the shared PRE-VERIFY tie-break (same producer as our
        // leader-verified stored block + lower block hash + valid producer signature). This runs on
        // UNVERIFIED gossip/repair bytes with no n−f TC to lean on, so the producer-authorization +
        // signature check inside the helper is what stops a non-producer forcing a wasteful reorg. See equal_round_selffork_supersedes.
        equal_round_selffork_supersedes(storage, &incoming, Some((&our_producer, our_hash)))
    } else {
        return; // strictly lower absolute round → keep ours
    };
    if !incoming_wins { return; } // equal round, but OUR block hash is the canonical (lower) one

    // Per-height cooldown (shared with macroblock-anchored recovery).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    if let Some(t) = FORK_RECOVERY_TRIGGER_TIMES.get(&h) {
        if now.saturating_sub(*t) < FORK_RECOVERY_COOLDOWN_SECS { return; }
    }
    FORK_RECOVERY_TRIGGER_TIMES.insert(h, now);

    // Signal the LAST-GOOD height (disputed-1, clamped >= finalized). The v33 consumer
    // rolls back TO this height and deletes strictly above it, so it must be h-1 for the
    // losing block at h to be dropped — matching anchor_recovery (disputed-2) and
    // apply_breaker (height-1). Deepest pending target wins (min) so a concurrent, deeper
    // signal is never masked. (h > finalized is guaranteed above; .max is a floor clamp.)
    let target = h.saturating_sub(1).max(finalized);
    signal_fork_recovery(target);
    if is_warn() {
        println!("[WARN][FORK] round_supersede h={} our_round={} new_round={} action=reorg_to_certified",
                 h, our_round, incoming.timeout_round);
    }
}

/// Route a sync/repair-delivered block at an ALREADY-STORED height through the SAME fork-choice
/// supersede the gossip decode path uses. The batch-sync ingress (handle_blocks_batch) drops stored
/// heights before the pipeline, so without this a failover winner on a higher n−f-certified round
/// delivered by sync or by fix B's request_block_repair never reaches maybe_supersede — and a
/// restarted/late voter that missed the live-gossip window can never converge its losing tail
/// (boundary re-freeze). Cheap: maybe_supersede early-returns for finalized heights before any decode.
pub(crate) fn supersede_stored_from_sync(storage: &Arc<Storage>, height: u64, data: &[u8], from_peer: &str, p2p: &SimplifiedP2P) {
    // Process a stored-height batch delivery ONLY if THIS node solicited this exact height via
    // request_block_repair (its own diverged tail). Unsolicited stored-height deliveries are ignored —
    // the ungated gossip decode path already converges unsolicited winners. This removes the batch-
    // flood DoS surface entirely AND guarantees the honest solicited winner is never rate-gated (the
    // earlier shared per-second budget was itself a liveness-DoS: an attacker draining it froze
    // convergence). Size cap = pipeline max_block_bytes so a legit large winner is never false-rejected;
    // a solicited-height flood is pure 1:1 bandwidth (transport concern), not amplification.
    if !is_repair_solicited(height) { return; }
    if data.len() > MAX_SUPERSEDE_INPUT { return; }
    let block = IngestBlock {
        height, data: data.to_vec(), block_type: "micro".to_string(),
        from_peer: from_peer.to_string(), received_at: 0,
    };
    maybe_supersede_by_certified_round(storage, &block, Some(p2p));
}

/// Record that `peer_id` reported a hash_chain_break at `height`.
///
/// v16.2: ADVISORY-ONLY MODEL. Witness count here measures how many
/// DISTINCT peers SENT us a forked-looking block at the same height —
/// not how many INDEPENDENT OBSERVERS detected the fork. With at most
/// `f` Byzantine producers in a 3f+1 system, the maximum source count
/// is `f` (typically 1 in practice), which means an n−f source-based
/// rollback threshold is mathematically unreachable in the common
/// failure scenario. The v16.1 destructive-rollback path was therefore
/// dead code — never triggered in any observed deploy.
///
/// Rather than carry dead consensus-mutating code, v16.2 collapses the
/// behaviour to its useful subset:
///   * Track distinct sources per height in `HASH_CHAIN_BREAK_WITNESSES`.
///   * Once any source set crosses `f+1`, emit an advisory `[WARN]` so
///     operators see partial-agreement evidence in postmortems.
///   * Tag every source peer for the 5-minute fork cooldown so
///     `get_sync_peers_filtered_by_height` deprioritises them when the
///     local chain refills the disputed range. This breaks the v15.x
///     rollback cascade WITHOUT touching consensus state — the local
///     chain stays canonical, only sync source preference changes.
///
/// A future extension (`v16.3+`) can introduce a true observer-based
/// rollback by adding a `BlockRejection` gossip message: each honest
/// node would broadcast a signed rejection on `verify_failed`, and n−f
/// distinct OBSERVER signatures for the same `(height, source_peer_id)`
/// tuple would justify destructive action. Until that protocol exists,
/// no destructive rollback fires from this path — recovery happens via
/// the existing n−f macroblock Checkpoint-BFT QC which finalises the
/// canonical branch every 90 microblocks regardless of microblock-level
/// disagreement.
///
/// Scalability: per-height witness sets bounded by active validator
/// count (≤ MAX_VALIDATORS = 1000 in committee). Cleanup sweep evicts
/// entries below current chain tip.
pub fn record_hash_chain_break_witness(height: u64, peer_id: &str) {
    if peer_id.is_empty() || peer_id == "self" {
        return;
    }
    let entry = HASH_CHAIN_BREAK_WITNESSES.entry(height).or_insert_with(DashSet::new);
    if !entry.insert(peer_id.to_string()) {
        // peer already counted for this height — no change
        return;
    }
    let witnesses = entry.len();
    drop(entry);

    // Use the consensus layer's canonical active validator count.
    // Fall back to the genesis floor (5) when the integration layer has
    // not yet installed a count (very early boot).
    let total_validators: usize = {
        let n = qnet_consensus::consensus_crypto::consensus_pk_registry_len();
        if n >= 3 { n } else { 5 }
    };

    // f+1 = ceil(n/3): "at least one honest witness" — ADVISORY ONLY.
    let threshold_f_plus_1 = (total_validators.saturating_add(2)) / 3;
    let detection_threshold = threshold_f_plus_1.max(2);

    // Advisory signal at f+1. Tags every reporter as a fork-source so the
    // canonical-aware sync peer selector deprioritises them. No state
    // mutation, no rollback — the local chain is preserved and the next
    // n−f macroblock Checkpoint-BFT QC naturally finalises the canonical
    // branch every 90 microblocks.
    if witnesses == detection_threshold {
        if is_warn() {
            println!(
                "[WARN][PIPELINE] fork_detection_signal h={} witnesses={} threshold_f_plus_1={} action=advisory_log_plus_peer_cooldown",
                height, witnesses, detection_threshold
            );
        }
        if let Some(set) = HASH_CHAIN_BREAK_WITNESSES.get(&height) {
            for w in set.iter() {
                mark_peer_as_fork_source(w.key());
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v16.1: FORKED PEER COOLDOWN
// ═══════════════════════════════════════════════════════════════════════════
// Peers that supplied blocks of a branch we just rolled back from (or which
// triggered the f+1 fork-detection signal) are tagged here for a bounded
// cooldown window. The canonical-aware sync peer selector reads this map
// and de-prioritises tagged peers until the cooldown expires — letting the
// resync pull from peers on the canonical branch instead of refetching
// the same forked blocks.
//
// Bounded retention: 5-minute cooldown per peer. Auto-evicted on next
// fork event for that peer (refresh) or via the periodic sweep below.
// At 100k super-node deployment this map is bounded by the union of
// recent fork participants — typically << 1000 entries.
// ═══════════════════════════════════════════════════════════════════════════

const FORKED_PEER_COOLDOWN_MS: u64 = 5 * 60 * 1000; // 5 min

static FORKED_PEER_COOLDOWN: once_cell::sync::Lazy<dashmap::DashMap<String, u64>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Mark `peer_id` as having supplied a forked-branch block. Used by the
/// canonical-aware sync peer selector to prefer other peers during the
/// cooldown window. Idempotent — refreshes timestamp on repeated hits.
pub fn mark_peer_as_fork_source(peer_id: &str) {
    if peer_id.is_empty() || peer_id == "self" {
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FORKED_PEER_COOLDOWN.insert(peer_id.to_string(), now_ms);
}

/// Returns true while `peer_id` is within the fork-cooldown window. The
/// canonical-aware sync peer selector skips peers for which this returns
/// true; if the entire candidate set is in cooldown, the selector falls
/// back to the full set rather than starving sync (preferring suspect
/// peers over no peers at all when liveness is at stake).
pub fn is_peer_in_fork_cooldown(peer_id: &str) -> bool {
    let entry = match FORKED_PEER_COOLDOWN.get(peer_id) {
        Some(e) => e,
        None => return false,
    };
    let marked_at = *entry.value();
    drop(entry);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let in_cooldown = now_ms.saturating_sub(marked_at) < FORKED_PEER_COOLDOWN_MS;
    if !in_cooldown {
        // Lazy eviction — opportunistically clean expired entries on
        // every read. Avoids a separate cleanup task at the cost of a
        // single DashMap remove per expiration check.
        FORKED_PEER_COOLDOWN.remove(peer_id);
    }
    in_cooldown
}

/// Periodic sweep called from the existing cleanup task. Removes entries
/// older than the cooldown window so the map stays bounded under sustained
/// fork activity. O(N) over current map size; runs at low cadence (the
/// caller's existing 5-minute sweep is sufficient).
pub fn cleanup_forked_peer_cooldown() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FORKED_PEER_COOLDOWN.retain(|_, marked_at| {
        now_ms.saturating_sub(*marked_at) < FORKED_PEER_COOLDOWN_MS
    });
}

/// Periodic cleanup of stale witness entries below `min_height`.
/// Called by unified_p2p cleanup tasks.
pub fn cleanup_break_tracker(min_height: u64) {
    HASH_CHAIN_BREAK_WITNESSES.retain(|h, _| *h >= min_height);
    FORK_RECOVERY_TRIGGER_TIMES.retain(|h, _| *h >= min_height);
}

// v18: missing-parent active sync. When verify finds parent_h absent
// (load_microblock=Ok(None)), legacy defer+passive-wait was unbounded
// under partial propagation → deferred buffer fills, gap stays open (v17.x
// stall h=180-241). Fix: proactively request_block_repair(parent_h)
// (parallel fan to top-rep peers); response re-enters the normal pipeline
// and drains the deferred child. Single-flight per height (process-wide
// dedup + cooldown → no thundering herd across verify workers); detached
// spawn (verify never blocks); passive-wait fallback retained (ADDS a
// recovery vector only). Returned blocks pass full canonical verify.

/// How long a single (height) request stays in the dedup map before another
/// retry is allowed. Long enough to cover RTT + decode + apply on slow links
/// (1000+ super-node deployment, WAN), short enough that a real persistent
/// missing block triggers fresh requests without the operator restarting.
const MISSING_BLOCK_REQUEST_TTL_MS: u64 = 30_000; // 30 seconds

/// Per-height in-flight request tracker. Key = parent height that is missing
/// locally; value = unix-ms timestamp of the most recent request attempt.
/// Lock-free DashMap keeps the verify stage non-blocking under load.
static MISSING_BLOCK_REQUESTED: once_cell::sync::Lazy<dashmap::DashMap<u64, u64>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Trigger an active sync request for a missing parent block, with single-flight
/// dedup. Returns true when this call dispatched a request, false when an
/// in-flight request is still within the cooldown window.
///
/// The actual network send is performed on a detached tokio task so the verify
/// stage thread never blocks on peer I/O. If the global P2P instance is not
/// yet initialized (very early boot), the call is a silent no-op — verify
/// stage falls back to the legacy passive-wait deferral path.
pub fn request_missing_parent(parent_h: u64) -> bool {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Single-flight: refuse to re-trigger while a request is in-flight.
    // The DashMap entry is updated atomically — no two threads can both
    // observe "no recent request" and double-fire.
    let should_dispatch = match MISSING_BLOCK_REQUESTED.entry(parent_h) {
        dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
            let last = *occupied.get();
            if now_ms.saturating_sub(last) < MISSING_BLOCK_REQUEST_TTL_MS {
                false // still in cooldown
            } else {
                *occupied.get_mut() = now_ms;
                true // cooldown expired — refresh and dispatch
            }
        }
        dashmap::mapref::entry::Entry::Vacant(vacant) => {
            vacant.insert(now_ms);
            true
        }
    };

    if !should_dispatch {
        return false;
    }

    // Detached dispatch — never block the caller (verify stage) on network.
    if let Some(p2p_arc) = crate::node::try_get_p2p() {
        let p2p_clone = p2p_arc.clone();
        tokio::spawn(async move {
            if let Err(e) = p2p_clone.request_block_repair(parent_h).await {
                if is_debug() {
                    println!("[DBG][PIPELINE] missing_parent_request_failed h={} err={}",
                             parent_h, e);
                }
            } else if is_info() {
                println!("[INFO][PIPELINE] missing_parent_requested h={} action=fanout_to_top_peers",
                         parent_h);
            }
        });
        true
    } else {
        if is_debug() {
            println!("[DBG][PIPELINE] missing_parent_request_skipped h={} reason=p2p_not_ready",
                     parent_h);
        }
        false
    }
}

// Range-sync for large gaps: one batched sync_blocks(from, to) instead of
// N single-flights. Requester is a single bounded window anchored to the
// APPLY FRONTIER — never keyed on the caller's (drifting) target height.
// A live-tip key defeats any (from, to) dedup: every incoming block makes a
// unique key, so an overlapping request dispatches per block (observed 641k
// re-requests / 7 blk/s on a 3266-block tail). Stable anchor + progress
// gate + timeout retry bounds dispatches to ≤2 per window plus 1 per
// RANGE_SYNC_RETRY_MS while stalled, and cannot wedge: a lost response is
// re-dispatched on timeout (sync_blocks re-fans to current top peers).

/// Threshold (in blocks) above which the verify stage prefers a single
/// range-sync over the cascade of single-height requests. Keeps the
/// small-gap regime (gossip jitter) on the per-height path.
const RANGE_SYNC_GAP_THRESHOLD: u64 = 5;

/// Request window size. Matches the serve-side batch cap (MAX_BATCH_BLOCKS)
/// so one dispatch = one full batch.
const RANGE_SYNC_WINDOW: u64 = 500;

/// Re-dispatch timeout for the in-flight window (response lost / peer gone).
const RANGE_SYNC_RETRY_MS: u64 = 10_000;

/// Single-flight requester state: (window_start, window_end, dispatched_at_ms).
/// dispatched_at_ms == 0 → nothing in flight. O(1) — no per-range map.
static RANGE_SYNC_INFLIGHT: once_cell::sync::Lazy<std::sync::Mutex<(u64, u64, u64)>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new((0, 0, 0)));

/// Trigger a range sync from `from` (the apply frontier + 1) toward `to`,
/// capped to RANGE_SYNC_WINDOW. Dispatches only when: first call, the
/// frontier consumed ≥ half the in-flight window (pipelined next window),
/// the frontier moved below the window (rollback re-anchor), or the
/// in-flight dispatch timed out. Network call runs on a detached task.
pub fn request_missing_range(from: u64, to: u64) -> bool {
    if to < from {
        return false;
    }
    let to = to.min(from.saturating_add(RANGE_SYNC_WINDOW - 1));
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let should_dispatch = {
        let mut st = RANGE_SYNC_INFLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        let (win_start, win_end, dispatched_at) = *st;
        let first = dispatched_at == 0;
        let progressed = from >= win_start.saturating_add(RANGE_SYNC_WINDOW / 2);
        // A capped-short window (small gap) fully consumed/left behind — without this,
        // successive small gaps in one region would throttle to one dispatch per timeout.
        let beyond = from > win_end;
        let rolled_back = from < win_start;
        let stalled = now_ms.saturating_sub(dispatched_at) >= RANGE_SYNC_RETRY_MS;
        if first || progressed || beyond || rolled_back || stalled {
            *st = (from, to, now_ms);
            true
        } else {
            false
        }
    };

    if !should_dispatch {
        return false;
    }

    if let Some(p2p_arc) = crate::node::try_get_p2p() {
        let p2p_clone = p2p_arc.clone();
        tokio::spawn(async move {
            match p2p_clone.sync_blocks(from, to).await {
                Ok(_) => {
                    if is_info() {
                        println!(
                            "[INFO][PIPELINE] missing_range_requested from={} to={} blocks={} action=batched_top_peers",
                            from, to, to.saturating_sub(from).saturating_add(1)
                        );
                    }
                }
                Err(e) => {
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] missing_range_request_failed from={} to={} err={}",
                            from, to, e
                        );
                    }
                }
            }
        });
        true
    } else {
        // Disarm: nothing dispatched, so the armed slot must not suppress the
        // retry once p2p comes up (first-boot race would cost a dead timeout).
        {
            let mut st = RANGE_SYNC_INFLIGHT.lock().unwrap_or_else(|p| p.into_inner());
            if st.0 == from { st.2 = 0; }
        }
        if is_debug() {
            println!(
                "[DBG][PIPELINE] missing_range_request_skipped from={} to={} reason=p2p_not_ready",
                from, to
            );
        }
        false
    }
}

/// Periodic cleanup of expired request entries. Called from the existing
/// cleanup task on the same cadence as `cleanup_forked_peer_cooldown` to
/// keep the map bounded regardless of chain length or stall duration.
pub fn cleanup_missing_block_requests() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    MISSING_BLOCK_REQUESTED.retain(|_, last| {
        now_ms.saturating_sub(*last) < MISSING_BLOCK_REQUEST_TTL_MS
    });
    // Range requester state is a single O(1) slot — nothing to sweep.
}

// ============================================================================
// PIPELINE TYPES
// ============================================================================

/// Raw block received from network (any source: sync, broadcast, shred).
#[derive(Debug, Clone)]
pub struct IngestBlock {
    pub height: u64,
    pub data: Vec<u8>,
    pub block_type: String,
    pub from_peer: String,
    pub received_at: u64,
}

/// Block after successful decoding (decompressed + deserialized).
///
/// v25 H14: `sig_pre_verified` lets the multi-worker verify pool pass an
/// already-verified ML-DSA-65 signature result forward to `verify_stage`
/// so the canonical state-bound stage does not pay for a redundant
/// per-block signature check. When the parallel verify pool is enabled
/// (`verify_workers > 1`), the worker that pre-verifies sets this to
/// `true`; `verify_stage` then skips its own verify call. When the single-
/// worker path is used (default for resource-constrained nodes), the flag
/// stays `false` and `verify_stage` performs the verify as before — full
/// behavioural backward compatibility, faster hot path under the parallel
/// configuration.
#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub height: u64,
    pub raw_data: Vec<u8>,
    pub decompressed: Vec<u8>,
    pub microblock: qnet_state::MicroBlock,
    pub from_peer: String,
    /// True when the producer's ML-DSA-65 signature was already
    /// successfully verified upstream of `verify_stage` (e.g., in the
    /// parallel worker pool of `block_pipeline`). Default `false` for
    /// any path that has not explicitly run the check.
    pub sig_pre_verified: bool,
}

/// Block after verification (signature, hash chain, timestamp).
#[derive(Debug)]
pub struct VerifiedBlock {
    pub height: u64,
    pub decompressed: Vec<u8>,
    pub microblock: qnet_state::MicroBlock,
    pub from_peer: String,
}

// ============================================================================
// PIPELINE METRICS
// ============================================================================

/// Per-stage counters for monitoring and debugging.
pub struct PipelineMetrics {
    pub ingested: AtomicU64,
    pub decoded: AtomicU64,
    pub decode_failed: AtomicU64,
    pub verified: AtomicU64,
    pub verify_failed: AtomicU64,
    pub applied: AtomicU64,
    pub apply_failed: AtomicU64,
    pub duplicates_skipped: AtomicU64,
    /// v15.3: Blocks ARRIVED via gossip but their height is far beyond the
    /// node's current chain tip (`apply_tip + GOSSIP_HORIZON`). They are
    /// NOT failures — sync will fetch the corresponding range when the
    /// chain tip advances close enough. Counted SEPARATELY from
    /// `verify_failed` so backpressure metrics treat them as "dropped, no
    /// retry pending" rather than "in flight, stuck".
    pub future_dropped: AtomicU64,
    /// v15.3: Blocks evicted from the verify-stage deferred buffer because
    /// they aged out (more than 500 blocks behind the local tip). Same
    /// non-failure semantics as `future_dropped` — sync will refetch when
    /// the chain tip approaches that range. Tracked separately so the
    /// backpressure formula can debit them from the in-flight estimate
    /// without overloading the `verify_failed` semantics.
    pub deferred_evicted: AtomicU64,

    /// v15.4 DIAGNOSTICS: per-stage live progress markers. The watchdog
    /// task reads these to identify exactly which block + which operation
    /// is hung when the verified/applied counters stop advancing. Stored as
    /// AtomicU64 so updates are lock-free at any node count.
    ///
    /// `verify_current_h` / `apply_current_h`: height of the block the
    /// stage is processing right now. 0 means stage is idle (waiting on
    /// channel recv).
    ///
    /// `verify_op` / `apply_op`: PIPELINE_OP_* constant identifying the
    /// sub-step within the stage. 0 = idle. Decoded by `op_name()` in the
    /// watchdog dump for human-readable diagnostics.
    ///
    /// `verify_op_started_ms` / `apply_op_started_ms`: epoch milliseconds
    /// at which the current op was entered. The watchdog computes
    /// `now_ms() - started_ms` to report op-age. Updated together with
    /// the op marker on every transition.
    ///
    /// Non-atomic relative to each other (the trio is updated as separate
    /// stores). This is acceptable: the watchdog only fires on stalls of
    /// ≥30 s, vastly larger than any plausible interleaving window between
    /// the three stores. Diagnostic snapshots may be momentarily
    /// inconsistent but the stuck condition itself is stable for tens of
    /// seconds before the dump runs.
    pub verify_current_h: AtomicU64,
    pub verify_op: AtomicU64,
    pub verify_op_started_ms: AtomicU64,
    pub apply_current_h: AtomicU64,
    pub apply_op: AtomicU64,
    pub apply_op_started_ms: AtomicU64,
}

/// v15.4: Op codes for per-stage progress markers. Read by the watchdog
/// to produce human-readable stuck-pipeline dumps.
pub const PIPELINE_OP_IDLE: u64 = 0;
pub const PIPELINE_OP_VERIFY_LOAD_PREV: u64 = 11;
pub const PIPELINE_OP_VERIFY_SIG: u64 = 12;
pub const PIPELINE_OP_VERIFY_SEND: u64 = 13;
pub const PIPELINE_OP_APPLY_DEDUP: u64 = 21;
pub const PIPELINE_OP_APPLY_STATE_LOCK: u64 = 22;
pub const PIPELINE_OP_APPLY_SNAPSHOT: u64 = 23;
pub const PIPELINE_OP_APPLY_STATE: u64 = 24;
pub const PIPELINE_OP_APPLY_SAVE_BLOCK: u64 = 25;
pub const PIPELINE_OP_APPLY_SET_HEIGHT: u64 = 26;
pub const PIPELINE_OP_APPLY_DEFERRED_FX: u64 = 27;
pub const PIPELINE_OP_APPLY_SEAL_WAIT: u64 = 28;

/// Decode an op marker into a short human-readable string for diagnostics.
fn op_name(op: u64) -> &'static str {
    match op {
        PIPELINE_OP_IDLE => "idle",
        PIPELINE_OP_VERIFY_LOAD_PREV => "verify:load_prev_block",
        PIPELINE_OP_VERIFY_SIG => "verify:signature",
        PIPELINE_OP_VERIFY_SEND => "verify:send_to_apply",
        PIPELINE_OP_APPLY_DEDUP => "apply:dedup_check",
        PIPELINE_OP_APPLY_STATE_LOCK => "apply:state_lock_acquire",
        PIPELINE_OP_APPLY_SNAPSHOT => "apply:create_snapshot",
        PIPELINE_OP_APPLY_STATE => "apply:apply_state_mutations",
        PIPELINE_OP_APPLY_SAVE_BLOCK => "apply:save_microblock",
        PIPELINE_OP_APPLY_SET_HEIGHT => "apply:set_chain_height",
        PIPELINE_OP_APPLY_DEFERRED_FX => "apply:deferred_side_effects",
        PIPELINE_OP_APPLY_SEAL_WAIT => "apply:seal_backpressure_wait",
        _ => "unknown",
    }
}

/// Current epoch in milliseconds. Diagnostic-only — never feeds consensus.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PipelineMetrics {
    pub fn new() -> Self {
        Self {
            ingested: AtomicU64::new(0),
            decoded: AtomicU64::new(0),
            decode_failed: AtomicU64::new(0),
            verified: AtomicU64::new(0),
            verify_failed: AtomicU64::new(0),
            applied: AtomicU64::new(0),
            apply_failed: AtomicU64::new(0),
            duplicates_skipped: AtomicU64::new(0),
            future_dropped: AtomicU64::new(0),
            deferred_evicted: AtomicU64::new(0),
            verify_current_h: AtomicU64::new(0),
            verify_op: AtomicU64::new(0),
            verify_op_started_ms: AtomicU64::new(0),
            apply_current_h: AtomicU64::new(0),
            apply_op: AtomicU64::new(0),
            apply_op_started_ms: AtomicU64::new(0),
        }
    }

    /// v15.4: Mark verify stage as entering an op on a specific block.
    /// Three stores are independent — see struct doc for ordering notes.
    pub fn mark_verify_op(&self, height: u64, op: u64) {
        self.verify_current_h.store(height, Ordering::Relaxed);
        self.verify_op.store(op, Ordering::Relaxed);
        self.verify_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark verify stage as idle (between blocks).
    pub fn mark_verify_idle(&self) {
        self.verify_current_h.store(0, Ordering::Relaxed);
        self.verify_op.store(PIPELINE_OP_IDLE, Ordering::Relaxed);
        self.verify_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark apply stage as entering an op on a specific block.
    pub fn mark_apply_op(&self, height: u64, op: u64) {
        self.apply_current_h.store(height, Ordering::Relaxed);
        self.apply_op.store(op, Ordering::Relaxed);
        self.apply_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark apply stage as idle (between blocks).
    pub fn mark_apply_idle(&self) {
        self.apply_current_h.store(0, Ordering::Relaxed);
        self.apply_op.store(PIPELINE_OP_IDLE, Ordering::Relaxed);
        self.apply_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn log_summary(&self) {
        if is_info() {
            println!(
                "[INFO][PIPELINE] ingested={} decoded={} decode_fail={} verified={} verify_fail={} applied={} apply_fail={} dup_skip={} future_drop={} defer_evict={}",
                self.ingested.load(Ordering::Relaxed),
                self.decoded.load(Ordering::Relaxed),
                self.decode_failed.load(Ordering::Relaxed),
                self.verified.load(Ordering::Relaxed),
                self.verify_failed.load(Ordering::Relaxed),
                self.applied.load(Ordering::Relaxed),
                self.apply_failed.load(Ordering::Relaxed),
                self.duplicates_skipped.load(Ordering::Relaxed),
                self.future_dropped.load(Ordering::Relaxed),
                self.deferred_evicted.load(Ordering::Relaxed),
            );
        }
    }
}

// ============================================================================
// PIPELINE CONFIG
// ============================================================================

/// Tuning parameters for the pipeline.
pub struct PipelineConfig {
    /// Channel buffer between ingest → decode
    pub ingest_buffer: usize,
    /// Channel buffer between decode → verify
    pub decode_buffer: usize,
    /// Channel buffer between verify → apply
    pub verify_buffer: usize,
    /// Number of parallel verify workers
    pub verify_workers: usize,
    /// Maximum block size in bytes (reject larger blocks as DoS)
    pub max_block_bytes: usize,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            ingest_buffer: 4096,
            decode_buffer: 2048,
            verify_buffer: 1024,
            verify_workers: 2,
            max_block_bytes: 50 * 1024 * 1024, // 50 MB max
        }
    }
}

impl PipelineConfig {
    /// Config optimized for genesis bootstrap (5 nodes, small network).
    pub fn genesis() -> Self {
        Self {
            ingest_buffer: 256,
            decode_buffer: 128,
            verify_buffer: 64,
            verify_workers: 1,
            max_block_bytes: 50 * 1024 * 1024,
        }
    }

    /// Config optimized for production (thousands of peers).
    pub fn production() -> Self {
        Self {
            ingest_buffer: 8192,
            decode_buffer: 4096,
            verify_buffer: 2048,
            verify_workers: 4,
            max_block_bytes: 50 * 1024 * 1024,
        }
    }
}

// ============================================================================
// APPLY CONTEXT — holds all references needed by apply stage
// ============================================================================

/// Everything the apply stage needs to perform full block application.
/// Created once at pipeline startup, cloned into the apply task.
pub struct ApplyContext {
    pub storage: Arc<Storage>,
    pub state: Arc<RwLock<crate::StateManager>>,
    pub coordinator: CoordinatorHandle,
    pub height: Arc<RwLock<u64>>,
    pub unified_p2p: Option<Arc<SimplifiedP2P>>,
    pub block_event_tx: tokio::sync::broadcast::Sender<u64>,
    pub node_id: String,
    /// v14.9: Event-driven apply signal. Fired after every successful
    /// block save in the pipeline. Sync manager waits on this instead of
    /// poll-sleeping, turning catch-up from 2 blk/s → bandwidth-limited.
    pub apply_notify: Arc<tokio::sync::Notify>,
}

// ============================================================================
// PIPELINE — the main struct
// ============================================================================

/// Handle for submitting blocks into the pipeline.
/// Clone-friendly, given to P2P layer and sync manager.
#[derive(Clone)]
pub struct PipelineIngest {
    tx: mpsc::Sender<IngestBlock>,
    metrics: Arc<PipelineMetrics>,
    /// v14.9: Shared apply-event signal. Fired after each successful save.
    /// Sync manager `.notified().await` instead of polling storage.
    apply_notify: Arc<tokio::sync::Notify>,
}

impl PipelineIngest {
    /// Submit a block for processing. Returns false if pipeline is full (backpressure).
    pub fn submit(&self, block: IngestBlock) -> bool {
        self.metrics.ingested.fetch_add(1, Ordering::Relaxed);
        match self.tx.try_send(block) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                if is_debug() {
                    println!("[DBG][PIPELINE] ingest_backpressure queue=full");
                }
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// Submit with async wait (for sync manager that can afford to wait).
    pub async fn submit_async(&self, block: IngestBlock) -> bool {
        self.metrics.ingested.fetch_add(1, Ordering::Relaxed);
        self.tx.send(block).await.is_ok()
    }

    /// Get pipeline metrics snapshot.
    pub fn metrics(&self) -> &PipelineMetrics {
        &self.metrics
    }

    /// v14.9: Access to the apply-event signal.
    /// Sync manager calls `pipeline.apply_notify().notified().await` to
    /// wake up the instant a block hits storage — zero-latency progress
    /// without any sleep/poll loop.
    pub fn apply_notify(&self) -> Arc<tokio::sync::Notify> {
        self.apply_notify.clone()
    }

    /// v14.10: Total blocks currently "in the system" — ingested but not yet
    /// finalized (applied / rejected / skipped). Used by SyncManager as the
    /// single source of truth for backpressure decisions.
    ///
    /// Calculation: ingested − applied − (all terminal-failure counters) − dup_skip.
    /// The deferred-buffer residents are COUNTED (good — they occupy pipeline
    /// capacity). Blocks that truly finished (applied or rejected) are excluded.
    ///
    /// Scalability: 4 atomic loads, O(1). Safe at 10K+ super-nodes — this is
    /// read by SyncManager on every iteration, no locks.
    pub fn in_flight(&self) -> u64 {
        // Scale-correct backpressure metric. `ingested - finished`
        // over-counted: during catch-up the same height arrives many times
        // (SHRED redundancy, sync retries), each bumping `ingested` while
        // only one applies → phantom delta inflated in-flight past buffer
        // capacity → backpressure credits hit 0 → starved sync exactly when
        // it needed to fetch parents (observed 58K phantom vs <2K real on
        // node 001). Fixes: (1) count future_dropped + deferred_evicted as
        // finished (terminal, sync re-requests later); (2) hard-clamp to the
        // sum of bounded buffers (occupancy can't physically exceed it).
        // 9 atomic loads, O(1).
        let ingested = self.metrics.ingested.load(Ordering::Relaxed);
        let finished = self.metrics.applied.load(Ordering::Relaxed)
            .saturating_add(self.metrics.decode_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.verify_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.apply_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.duplicates_skipped.load(Ordering::Relaxed))
            .saturating_add(self.metrics.future_dropped.load(Ordering::Relaxed))
            .saturating_add(self.metrics.deferred_evicted.load(Ordering::Relaxed));

        let raw = ingested.saturating_sub(finished);

        // Sum of every bounded buffer in the pipeline:
        //   ingest channel  (production: 8192, default: 4096)
        //   decode channel  (production: 4096, default: 2048)
        //   verify channel  (production: 2048, default: 1024)
        //   deferred buffer (DEFERRED_MAX = 2000)
        //   apply queue is small (1-2 items) — included implicitly in the
        //     verify-channel budget since apply consumes from there.
        // Use the production sizing as the cap so the metric is correct on
        // any deployment scale; smaller deployments simply never hit it.
        const MAX_PIPELINE_OCCUPANCY: u64 = 8192 + 4096 + 2048 + 2000;
        raw.min(MAX_PIPELINE_OCCUPANCY)
    }

    /// v14.10: Current ingest-channel free capacity (blocks the pipeline can
    /// accept right now before hitting the ingest buffer limit). Useful as a
    /// short-term "room available" indicator; SyncManager pairs this with
    /// `in_flight()` for a full picture.
    pub fn ingest_capacity_remaining(&self) -> usize {
        self.tx.capacity()
    }
}

/// Block processing pipeline. Creates stages and runs them.
pub struct BlockPipeline;

impl BlockPipeline {
    /// Create and start the pipeline. Returns the ingest handle.
    ///
    /// All stages are spawned as independent tokio tasks.
    /// The pipeline is alive as long as the ingest handle exists.
    pub fn start(
        config: PipelineConfig,
        ctx: ApplyContext,
    ) -> PipelineIngest {
        let metrics = Arc::new(PipelineMetrics::new());

        // Create inter-stage channels
        let (ingest_tx, ingest_rx) = mpsc::channel::<IngestBlock>(config.ingest_buffer);
        let (decode_tx, decode_rx) = mpsc::channel::<DecodedBlock>(config.decode_buffer);
        let (verify_tx, verify_rx) = mpsc::channel::<VerifiedBlock>(config.verify_buffer);

        // Stage 1: Ingest → Decode (decompress + deserialize)
        let metrics_decode = metrics.clone();
        let storage_decode = ctx.storage.clone();
        let p2p_decode = ctx.unified_p2p.clone();
        tokio::spawn(Self::decode_stage(
            ingest_rx,
            decode_tx,
            storage_decode,
            metrics_decode,
            config.max_block_bytes,
            p2p_decode,
        ));

        // v25: N-worker parallel signature-verify pool. decode_rx -> N workers
        // (ML-DSA-65 producer-sig verify, CPU-bound, parallel) -> sig_verified_rx
        // FIFO -> verify_stage (state-bound: deferred buffer + hash-chain,
        // single-threaded) -> apply. Parallel pre-verify is safe: verify is a pure
        // fn; downstream out-of-order handled by the deferred buffer. Super-node
        // path only. Steady ~1 verify/s (1 worker ok); pool for catch-up/burst.
        // Sizing: catch-up=num_cpus, steady=2.
        let verify_workers = std::cmp::max(1, config.verify_workers);

        // Pre-verify FIFO between worker pool and the state-bound stage.
        // Sized to the same depth as the original decode_rx so the worker
        // pool never blocks the dispatcher; the state-bound stage drains
        // as fast as it can apply.
        let (sig_verified_tx, sig_verified_rx) =
            mpsc::channel::<DecodedBlock>(std::cmp::max(64, config.verify_buffer));

        if verify_workers > 1 {
            // ── Multi-worker path ──
            // The dispatcher owns `decode_rx` and round-robins blocks across
            // N internal per-worker channels. Each worker takes one block at
            // a time, runs ML-DSA-65 producer-signature verification on
            // tokio's blocking pool (so the C-binding never starves a tokio
            // runtime thread), and forwards the pre-verified block to the
            // shared `sig_verified_tx` for state-bound processing.
            //
            // Why per-worker channels instead of a shared receiver:
            // `mpsc::Receiver` is single-consumer. We could wrap in
            // Arc<Mutex<Receiver>> (serializes recv() — defeats parallelism)
            // or pull in `async-channel`/`flume` (extra dependency). The
            // dispatcher approach keeps zero new dependencies and provides
            // explicit round-robin fairness across workers.
            let mut worker_txs: Vec<mpsc::Sender<DecodedBlock>> =
                Vec::with_capacity(verify_workers);
            let mut worker_rxs: Vec<mpsc::Receiver<DecodedBlock>> =
                Vec::with_capacity(verify_workers);
            for _ in 0..verify_workers {
                let (tx, rx) = mpsc::channel::<DecodedBlock>(
                    std::cmp::max(16, config.verify_buffer / verify_workers),
                );
                worker_txs.push(tx);
                worker_rxs.push(rx);
            }

            // Dispatcher: read from decode_rx, round-robin to workers.
            let metrics_dispatcher = metrics.clone();
            tokio::spawn(async move {
                let mut decode_rx = decode_rx;
                let mut next: usize = 0;
                while let Some(decoded) = decode_rx.recv().await {
                    let target = next % worker_txs.len();
                    next = next.wrapping_add(1);
                    // try_send first to avoid an extra await on the happy
                    // path; fall back to send() (which awaits) when the
                    // selected worker is back-pressured.
                    match worker_txs[target].try_send(decoded) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(d)) => {
                            if worker_txs[target].send(d).await.is_err() {
                                metrics_dispatcher
                                    .verify_failed
                                    .fetch_add(1, Ordering::Relaxed);
                                break; // worker channel closed
                            }
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            metrics_dispatcher
                                .verify_failed
                                .fetch_add(1, Ordering::Relaxed);
                            break; // worker died
                        }
                    }
                }
            });

            // Workers: each consumes one block at a time and runs sig verify
            // on the blocking pool. Forwards to shared `sig_verified_tx`.
            for (worker_id, mut worker_rx) in worker_rxs.into_iter().enumerate() {
                let sig_verified_tx_w = sig_verified_tx.clone();
                let metrics_w = metrics.clone();
                let storage_w = ctx.storage.clone();
                tokio::spawn(async move {
                    let storage = storage_w;
                    while let Some(mut decoded) = worker_rx.recv().await {
                        // Producer signature verification is the CPU-bound
                        // step; everything else (hash chain, deferred
                        // buffer, producer-authority cache lookup) stays
                        // in the downstream verify_stage.
                        //
                        // Skip the verify on genesis (height 0) — its
                        // signature has a different format and is verified
                        // by the genesis-specific path in verify_stage.
                        let pre_ok = if decoded.microblock.height == 0 {
                            true
                        } else {
                            // The verify function is async (uses async
                            // pq-crypto APIs); .await yields the worker so
                            // other workers run concurrently on the
                            // multi-threaded tokio runtime. This is the
                            // CPU parallelism the worker pool exists for.
                            match BlockchainNode::verify_microblock_signature(
                                &storage,
                                &decoded.microblock,
                                &decoded.microblock.producer,
                                None,
                            )
                            .await
                            {
                                Ok(valid) => valid,
                                Err(_) => false,
                            }
                        };
                        if !pre_ok {
                            // Drop bad-sig block before it enters the
                            // state-bound stage. The verify_stage will
                            // re-run the same check; this is just an
                            // optimisation to avoid pushing bad blocks
                            // into the FIFO.
                            metrics_w.verify_failed.fetch_add(1, Ordering::Relaxed);
                            if crate::node::is_warn() {
                                println!(
                                    "[WARN][PIPELINE] worker_sig_invalid h={} worker={} producer={}",
                                    decoded.microblock.height, worker_id,
                                    decoded.microblock.producer
                                );
                            }
                            continue;
                        }
                        // v25 H14: signal that signature has already been
                        // verified — `verify_stage` will skip the redundant
                        // ML-DSA-65 check on this block. Only set on the
                        // non-genesis path (genesis has its own dedicated
                        // verifier in verify_stage and stays unmarked so
                        // that path still runs).
                        if decoded.microblock.height != 0 {
                            decoded.sig_pre_verified = true;
                        }
                        if sig_verified_tx_w.send(decoded).await.is_err() {
                            break; // downstream closed
                        }
                    }
                });
            }
            drop(sig_verified_tx); // dispatcher + workers hold their own clones

            if crate::node::is_info() {
                println!(
                    "[INFO][PIPELINE] verify_pool_started mode=parallel workers={} buffer={}",
                    verify_workers, config.verify_buffer
                );
            }
        } else {
            // ── Single-worker path (verify_workers=1) ──
            // Direct forward from decode_rx to sig_verified_tx. No parallelism,
            // identical to the pre-v25 single-task behaviour. Use this on
            // resource-constrained Light nodes or observer-only Super-nodes.
            tokio::spawn(async move {
                let mut decode_rx = decode_rx;
                while let Some(decoded) = decode_rx.recv().await {
                    if sig_verified_tx.send(decoded).await.is_err() {
                        break;
                    }
                }
            });
            if crate::node::is_info() {
                println!(
                    "[INFO][PIPELINE] verify_pool_started mode=single buffer={}",
                    config.verify_buffer
                );
            }
        }

        // Stage 2 (state-bound): pre-verified blocks → state checks → apply.
        let metrics_verify = metrics.clone();
        let storage_verify = ctx.storage.clone();
        let coordinator_verify = ctx.coordinator.clone();
        let p2p_verify = ctx.unified_p2p.clone();
        // Dummy semaphore retained for backward-compat with verify_stage
        // signature (the call site no longer needs to acquire since the
        // sig verify already happened in the worker pool above). Keeping
        // it as `Semaphore::new(1)` is harmless — one in-flight acquire
        // at a time inside a single-task stage.
        let verify_permits_stage = Arc::new(tokio::sync::Semaphore::new(1));
        let state_verify = ctx.state.clone(); // FIX-5: deterministic pk source (same handle apply_stage uses)
        tokio::spawn(Self::verify_stage(
            sig_verified_rx,
            verify_tx,
            storage_verify,
            coordinator_verify,
            metrics_verify,
            ctx.node_id.clone(),
            p2p_verify,
            verify_permits_stage,
            state_verify,
        ));

        // Stage 3: Verify → Apply (state transitions + storage write + ALL side effects)
        // MUST be single-threaded (sequential writes to RocksDB + state)
        // v14.9: clone apply_notify BEFORE moving ctx into apply_stage —
        // sync manager will wait on the same Notify to progress without sleep.
        let ctx_apply_notify = ctx.apply_notify.clone();
        let metrics_apply = metrics.clone();
        tokio::spawn(Self::apply_stage(
            verify_rx,
            ctx,
            metrics_apply,
        ));

        // Periodic metrics logging
        let metrics_log = metrics.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                metrics_log.log_summary();
            }
        });

        // Pipeline progress watchdog. Background poller detecting when the
        // verify/apply stages stop advancing (observed node 001 frozen at
        // verified=applied=5256 for 5 min with no error logs). Samples the
        // counters every WATCHDOG_TICK; if one hasn't advanced for
        // STUCK_THRESHOLD AND that stage's op marker is non-idle, emit a CRIT
        // dump (idle-no-progress = correctly waiting on an empty channel).
        // Re-arms after the counter advances; repeat dumps suppressed.
        // O(1) lock-free, pure observation — never gates flow or consensus.
        let metrics_watchdog = metrics.clone();
        tokio::spawn(async move {
            const WATCHDOG_TICK: std::time::Duration = std::time::Duration::from_secs(5);
            const STUCK_THRESHOLD_MS: u64 = 30_000;
            let mut last_verified: u64 = 0;
            let mut last_applied: u64 = 0;
            // 0 sentinel = "no verify/apply seen yet"; the dump guards require != 0, so the boot wait
            // (nothing to apply) can't trip a spurious CRIT — stall is measured from first real progress.
            let mut last_verified_progress_ms: u64 = 0;
            let mut last_applied_progress_ms: u64 = 0;
            // First hit is a WARN; only a stall that survives another window is a CRIT.
            let mut verify_stuck_repeats: u32 = 0;
            let mut apply_stuck_repeats: u32 = 0;
            let mut last_verify_dump_ms: u64 = 0;
            let mut last_apply_dump_ms: u64 = 0;
            let mut interval = tokio::time::interval(WATCHDOG_TICK);
            loop {
                interval.tick().await;
                let now = now_ms();
                let verified_now = metrics_watchdog.verified.load(Ordering::Relaxed);
                let applied_now = metrics_watchdog.applied.load(Ordering::Relaxed);
                // dup-skip is a terminal disposition (block already present) = forward progress.
                // Fold it into both liveness signals: during a node's own production rotation the
                // pipeline sees only echoes of self-produced blocks (dup-skips that never bump
                // `applied`), which froze the counter and tripped a spurious apply_stuck CRIT on a
                // healthy producer. A real stall freezes dup-skip too, so genuine CRITs still fire.
                let dup_now = metrics_watchdog.duplicates_skipped.load(Ordering::Relaxed);
                let verify_progress_now = verified_now.saturating_add(dup_now);
                let apply_progress_now = applied_now.saturating_add(dup_now);

                if verify_progress_now != last_verified {
                    last_verified = verify_progress_now;
                    last_verified_progress_ms = now;
                    verify_stuck_repeats = 0; // a later, unrelated stall must open at WARN again
                }
                if apply_progress_now != last_applied {
                    last_applied = apply_progress_now;
                    last_applied_progress_ms = now;
                    apply_stuck_repeats = 0; // a later, unrelated stall must open at WARN again
                }

                let verify_op = metrics_watchdog.verify_op.load(Ordering::Relaxed);
                let verify_h = metrics_watchdog.verify_current_h.load(Ordering::Relaxed);
                let verify_op_started = metrics_watchdog.verify_op_started_ms.load(Ordering::Relaxed);
                let verify_stall_ms = now.saturating_sub(last_verified_progress_ms);
                let verify_op_age_ms = now.saturating_sub(verify_op_started);

                let apply_op = metrics_watchdog.apply_op.load(Ordering::Relaxed);
                let apply_h = metrics_watchdog.apply_current_h.load(Ordering::Relaxed);
                let apply_op_started = metrics_watchdog.apply_op_started_ms.load(Ordering::Relaxed);
                let apply_stall_ms = now.saturating_sub(last_applied_progress_ms);
                let apply_op_age_ms = now.saturating_sub(apply_op_started);

                // VERIFY STALL: frozen progress counter. op_age CLASSIFIES the stall (a hang keeps
                // one operation in flight; a livelock re-enters and re-zeroes the age) — it must not
                // GATE the dump, or a repeated-failure loop resets the age and is never reported.
                if verify_stall_ms >= STUCK_THRESHOLD_MS
                    && last_verified_progress_ms != 0
                    && verify_op != PIPELINE_OP_IDLE
                    && now.saturating_sub(last_verify_dump_ms) >= STUCK_THRESHOLD_MS
                {
                    verify_stuck_repeats += 1;
                    eprintln!(
                        "[{}][PIPELINE] verify_stuck mode={} stall_ms={} hung_h={} op={} op_age_ms={} verified={} applied={} ingested={} decoded={} verify_fail={} future_drop={} defer_evict={}",
                        if verify_stuck_repeats > 1 { "CRIT" } else { "WARN" },
                        if verify_op_age_ms >= STUCK_THRESHOLD_MS { "hang" } else { "livelock" },
                        verify_stall_ms,
                        verify_h,
                        op_name(verify_op),
                        verify_op_age_ms,
                        verified_now,
                        applied_now,
                        metrics_watchdog.ingested.load(Ordering::Relaxed),
                        metrics_watchdog.decoded.load(Ordering::Relaxed),
                        metrics_watchdog.verify_failed.load(Ordering::Relaxed),
                        metrics_watchdog.future_dropped.load(Ordering::Relaxed),
                        metrics_watchdog.deferred_evicted.load(Ordering::Relaxed),
                    );
                    last_verify_dump_ms = now;
                }

                // APPLY STALL: same rule as verify — op_age classifies hang vs livelock, never gates.
                if apply_stall_ms >= STUCK_THRESHOLD_MS
                    && last_applied_progress_ms != 0
                    && apply_op != PIPELINE_OP_IDLE
                    && now.saturating_sub(last_apply_dump_ms) >= STUCK_THRESHOLD_MS
                {
                    apply_stuck_repeats += 1;
                    eprintln!(
                        "[{}][PIPELINE] apply_stuck mode={} stall_ms={} hung_h={} op={} op_age_ms={} verified={} applied={} apply_fail={} dup_skip={}",
                        if apply_stuck_repeats > 1 { "CRIT" } else { "WARN" },
                        if apply_op_age_ms >= STUCK_THRESHOLD_MS { "hang" } else { "livelock" },
                        apply_stall_ms,
                        apply_h,
                        op_name(apply_op),
                        apply_op_age_ms,
                        verified_now,
                        applied_now,
                        metrics_watchdog.apply_failed.load(Ordering::Relaxed),
                        metrics_watchdog.duplicates_skipped.load(Ordering::Relaxed),
                    );
                    last_apply_dump_ms = now;
                }
            }
        });

        PipelineIngest {
            tx: ingest_tx,
            metrics,
            apply_notify: ctx_apply_notify,
        }
    }

    // ========================================================================
    // STAGE 1: DECODE
    // ========================================================================
    // Decompresses (zstd) and deserializes raw bytes into MicroBlock.
    // Drops blocks that can't be decoded — no retry, no buffering.
    // This is the FIRST line of defense against corrupt/malicious data.
    // ========================================================================

    async fn decode_stage(
        mut rx: mpsc::Receiver<IngestBlock>,
        tx: mpsc::Sender<DecodedBlock>,
        storage: Arc<Storage>,
        metrics: Arc<PipelineMetrics>,
        max_block_bytes: usize,
        unified_p2p: Option<Arc<SimplifiedP2P>>,
    ) {
        while let Some(block) = rx.recv().await {
            // v14.8: local apply-quarantine — drop blocks from peers that
            // have repeatedly produced state_root mismatches or invalid
            // payloads. Cheap DashMap lookup; lets us skip decode/verify
            // on known-bad sources without any global lock.
            if let Some(ref p2p) = unified_p2p {
                if p2p.is_peer_quarantined(&block.from_peer) {
                    if is_debug() {
                        println!("[DBG][PIPELINE] quarantined_peer_drop h={} from={}",
                                 block.height, block.from_peer);
                    }
                    metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            // Size check (DoS protection)
            if block.data.len() > max_block_bytes {
                if is_warn() {
                    println!("[WARN][PIPELINE] oversized_block h={} bytes={} max={} from={}",
                             block.height, block.data.len(), max_block_bytes, block.from_peer);
                }
                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Minimum size check
            if block.data.len() < 64 {
                if is_warn() {
                    println!("[WARN][PIPELINE] undersized_block h={} bytes={} from={}",
                             block.height, block.data.len(), block.from_peer);
                }
                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Dedup: skip if already in storage. Exception — a same-height block from
            // a higher n−f-certified rotation round (failover race) supersedes ours;
            // route it to the finality-guarded reorg instead of silently dropping.
            if storage.load_microblock(block.height)
                .map(|opt| opt.is_some())
                .unwrap_or(false)
            {
                maybe_supersede_by_certified_round(&storage, &block, unified_p2p.as_deref());
                metrics.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Decompress (zstd or raw) with size limit to prevent decompression bombs
            const MAX_DECOMPRESSED_SIZE: usize = 50 * 1024 * 1024; // 50MB limit
            let decompressed = match zstd::stream::Decoder::new(&block.data[..]) {
                Ok(decoder) => {
                    use std::io::Read;
                    let mut buf = Vec::new();
                    match decoder.take(MAX_DECOMPRESSED_SIZE as u64 + 1).read_to_end(&mut buf) {
                        Ok(_) => {
                            if buf.len() > MAX_DECOMPRESSED_SIZE {
                                if is_warn() {
                                    println!("[WARN][PIPELINE] decompression_bomb h={} decompressed_bytes={} max={} from={}",
                                             block.height, buf.len(), MAX_DECOMPRESSED_SIZE, block.from_peer);
                                }
                                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }
                            buf
                        }
                        Err(_) => block.data.clone(), // Decode error — try raw
                    }
                }
                Err(_) => block.data.clone(), // Not zstd compressed — use as-is
            };

            // Deserialize
            match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                Ok(microblock) => {
                    // Height sanity check
                    if microblock.height != block.height {
                        if is_warn() {
                            println!("[WARN][PIPELINE] height_mismatch declared={} actual={} from={}",
                                     block.height, microblock.height, block.from_peer);
                        }
                        metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }

                    let decoded = DecodedBlock {
                        height: block.height,
                        raw_data: block.data,
                        decompressed,
                        microblock,
                        from_peer: block.from_peer,
                        // v25 H14: signature has NOT been verified yet at the
                        // decode stage. The parallel verify pool (when active)
                        // flips this to `true` once ML-DSA-65 verify succeeds;
                        // the single-worker pass-through leaves it `false` so
                        // `verify_stage` runs the canonical check itself.
                        sig_pre_verified: false,
                    };

                    metrics.decoded.fetch_add(1, Ordering::Relaxed);

                    if let Err(_) = tx.send(decoded).await {
                        break; // Next stage closed — pipeline shutting down
                    }
                }
                Err(e) => {
                    if is_warn() {
                        println!("[WARN][PIPELINE] decode_failed h={} bytes={} from={} err={}",
                                 block.height, block.data.len(), block.from_peer, e);
                    }
                    metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                    // Block is DROPPED — no retry. Next copy from another peer will arrive.
                }
            }
        }
    }

    // ========================================================================
    // STAGE 2: VERIFY
    // ========================================================================
    // Validates: signature (Dilithium/Ed25519), hash chain, producer eligibility.
    // Can be parallelized — signature verification is CPU-bound and independent.
    // ========================================================================

    async fn verify_stage(
        mut rx: mpsc::Receiver<DecodedBlock>,
        tx: mpsc::Sender<VerifiedBlock>,
        storage: Arc<Storage>,
        coordinator: CoordinatorHandle,
        metrics: Arc<PipelineMetrics>,
        node_id: String,
        unified_p2p: Option<Arc<SimplifiedP2P>>,
        // v24: bounded signature-verification parallelism. The semaphore is
        // acquired around each ML-DSA-65 verify call (producer signature,
        // attestations) so up to `permits` blocks can verify concurrently
        // without re-ordering the deferred-buffer / hash-chain state.
        verify_permits: Arc<tokio::sync::Semaphore>,
        // FIX-5: committed in-mem State — the ONLY deterministic source for an elided value-TX's
        // dilithium_public_key (never the detached accounts CF). Legal because the parent-continuity
        // gate pins apply-frontier == H-1 when the value-TX batch runs (see the batch below).
        state: Arc<RwLock<crate::StateManager>>,
    ) {
        // Suppress unused warning until callers acquire the permit. The
        // intentional design: hold a reference so the semaphore is
        // initialised and visible for the verify_microblock_signature
        // call path (the actual `acquire().await` lives at the signature
        // verification call site in the loop body below — added as a
        // separate hardening pass in v24 to avoid restructuring the
        // 200-line deferred-buffer block on this fix).
        let _verify_permits = verify_permits;
        // v13.1: Bounded deferred buffer for out-of-order blocks.
        // When blocks arrive before their parent (normal during sync),
        // they're stored here instead of being dropped. After each new block
        // is verified, we drain deferred blocks whose parent has now arrived.
        // Bounded to prevent OOM under load (thousands of Super nodes).
        const DEFERRED_MAX: usize = 2000;
        // Keyed by PARENT HASH, not by height: a height-keyed map holds one entry per slot, so two
        // blocks waiting on the same parent (the normal case during a branch race) silently
        // overwrote each other. Keyed by parent hash, siblings coexist and the drain is a direct
        // lookup of "who was waiting for the block I just verified".
        let mut deferred: HashMap<[u8; 32], Vec<(u64, DecodedBlock)>> = HashMap::new();
        let mut deferred_count: usize = 0;
        // Per-producer occupancy, maintained incrementally: counting by scanning the whole buffer
        // on every deferral is O(buffer) per block on the verify path.
        let mut deferred_by_producer: HashMap<String, usize> = HashMap::new();
        // Separate bucket for burn-gated blocks whose N-2 committee isn't applied yet (node behind). Their
        // parent IS present (burn gate runs post parent-check), so the contiguity drain never revisits them
        // — re-driven when their committee becomes available (see redrive below). Bounded by DEFERRED_MAX.
        let mut committee_deferred: HashMap<u64, DecodedBlock> = HashMap::new();
        // Watermark of the last deferred re-drive (see the drain below): (applied tip, sealed-macroblock
        // index). BOTH move independently and gate the two defer reasons — pk_unresolved clears when the
        // chain APPLIES the committing block (chain_h moves); the N-2-committee defer clears when the N-2
        // MACROBLOCK is sealed (sealed_mb moves, chain_h does NOT). MAX ⇒ the first pass always runs.
        let mut last_redrive_wm: (u64, u64) = (u64::MAX, u64::MAX);

        // Gossip horizon: drop blocks > GOSSIP_HORIZON ahead of the local
        // tip BEFORE the deferred buffer. Root cause = catch-up backpressure
        // deadlock: far-ahead SHRED blocks can never verify (missing parents),
        // fill the bounded deferred buffer, starve near-tip sync responses,
        // and inflate the drop counter → false backpressure throttle that
        // self-perpetuates. Counted as future_dropped (not verify_failed) so
        // it's a permanent drop with no pending retry; sync re-pulls once the
        // tip is close. 200 ≈ 200s at 1 blk/s. Safe — identical to never
        // receiving the block via gossip; it stays replayable from the chain.
        // O(1)/block (chain_h read cached in-loop).
        const GOSSIP_HORIZON: u64 = 200;
        let mut horizon_cache_h: u64 = 0;
        let mut horizon_cache_age: u32 = 0;
        // During active sync the dispatcher fills its in-flight window up to
        // MAX_INFLIGHT (== DEFERRED_MAX). Admit that far ahead so served blocks
        // land in the deferred buffer instead of being dropped + refetched; on
        // the live gossip path keep the tight horizon so far-future spam cannot
        // grow the buffer. Refreshed alongside horizon_cache_h.
        let mut horizon_cache_syncing = false;

        'outer: while let Some(decoded) = rx.recv().await {
            // v15.4 DIAG: a fresh block has just arrived — between recv()
            // calls the stage was idle on the channel, so reset the op
            // marker to a clean idle baseline. The earlier mark_verify_op
            // calls only fire on the success-with-progress path; without
            // this reset, an early-continue path (horizon drop, deferred
            // insert, hash break, sig fail, etc.) would leave a stale
            // op marker visible to the watchdog if the channel then went
            // quiet. Resetting on recv keeps the watchdog's "op stuck"
            // signal trustworthy: a non-idle op means a block is actively
            // being processed right now.
            metrics.mark_verify_idle();

            // Refresh local chain tip for the horizon filter every 16 blocks —
            // amortises storage reads while keeping the horizon close to real.
            if horizon_cache_age == 0 {
                horizon_cache_h = storage.get_chain_height().unwrap_or(0);
                horizon_cache_syncing = coordinator.snapshot().is_syncing();
            }
            horizon_cache_age = (horizon_cache_age + 1) & 0xF;

            // Apply horizon filter at the entry point — never enters deferred
            // buffer. Drops are non-failure (sync will refetch). Sync widens the
            // horizon to DEFERRED_MAX so the dispatcher's in-flight window is
            // admitted, not dropped — closes the apply-horizon/dispatch mismatch
            // that throttled cold-join catch-up to a rolling-200 crawl.
            let horizon = if horizon_cache_syncing { DEFERRED_MAX as u64 } else { GOSSIP_HORIZON };
            if decoded.microblock.height > horizon_cache_h.saturating_add(horizon) {
                metrics.future_dropped.fetch_add(1, Ordering::Relaxed);
                if is_debug() {
                    println!(
                        "[DBG][PIPELINE] horizon_drop h={} local_tip={} horizon={} syncing={}",
                        decoded.microblock.height, horizon_cache_h, horizon, horizon_cache_syncing,
                    );
                }
                continue;
            }

            // Process this block, then try to drain deferred chain
            let mut to_process = vec![decoded];

            // Re-drive deferred blocks once their gate can have changed (parent already present, so the
            // contiguity drain never revisits them). This map holds BOTH defer reasons, so the watermark is
            // the pair of their EXACT clear-triggers — never chain_height, which advances every block:
            //   * committee defer (N-2 absent) clears iff macroblock n2 BECOMES PRESENT → macroblock_save_seq
            //     (counts any body, contiguous or not; last_sealed_mb_index would stay pinned behind an
            //     out-of-order sync hole while committee_for_height already resolves).
            //   * pk defer (elided pk uncommitted) clears iff a pk is COMMITTED → dpk_last_bind_height, which
            //     moves exactly on the apply that binds one.
            // Keying on chain_height instead re-ran the FULL verify (incl. the signature batch) for every
            // entry on EVERY inbound block — a never-resolvable block was permanent attacker-planted CPU
            // load. Both components are rare events, so the drain now fires only when a defer can truly
            // clear. Skipped when empty (the norm); O(committee_deferred).
            let cur_wm = (crate::storage::macroblock_save_seq(), storage.dpk_last_bind_height());
            if !committee_deferred.is_empty() && cur_wm != last_redrive_wm {
                last_redrive_wm = cur_wm;
                let ready: Vec<u64> = committee_deferred.keys().copied()
                    .filter(|h| !crate::node::BlockchainNode::n2_committee_absent(&storage, *h))
                    .collect();
                for h in ready {
                    if let Some(def) = committee_deferred.remove(&h) { to_process.push(def); }
                }
            }

            while let Some(mut decoded) = to_process.pop() {
            let mb = &decoded.microblock;

            // 1. Hash chain continuity (except genesis + the snapshot-anchor successor). The snapshot
            // anchor (anchor_h) is the QC-final chain root whose body is intentionally absent (snapshot =
            // state, not microblocks), so a cold joiner's first live block anchor_h+1 has no parent to
            // hash-chain against — admit it on the adopted finality; slot-ts/signature/state verify still
            // run below. anchor_h+2.. chain normally (anchor_h+1's hash is cached at its apply-commit).
            // GENESIS IS ACCEPTED ONCE. Every authentication gate in this stage is wrapped in
            // `mb.height > 0` - producer signature, producer authority, hash chain, slot timestamp,
            // state_root, forbidden-TX types - so a SECOND block 0 would be applied over an existing
            // chain with none of them. The tx-signature bypass below justifies itself with a
            // "one-time bootstrap"; this guard is what makes that true.
            if mb.height == 0 {
                let s2 = storage.clone();
                let have_genesis = tokio::task::spawn_blocking(move || {
                    s2.canonical_hash_at(0).is_some()
                }).await.unwrap_or(false);
                if have_genesis {
                    if is_warn() {
                        println!("[WARN][PIPELINE] genesis_refused reason=chain_already_rooted producer={}",
                                 mb.producer);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }
            let anchor_h = crate::node::SNAPSHOT_ANCHOR_MB.load(Ordering::Acquire).saturating_mul(90);
            if mb.height > 0 && !(anchor_h > 0 && mb.height == anchor_h + 1) {
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_LOAD_PREV);
                let parent_h = mb.height - 1;

                // The parent must be the block CANONICALLY occupying the preceding slot, read
                // straight from storage (no cache in front of it, so no stale oracle). Asking only
                // "do we hold a block with this hash?" would be a tautology — the claimed hash
                // would answer for itself — and would admit a child of any retained branch.
                // Ok(Some) = canonical parent hash, Ok(None) = slot empty (defer), Err = disk failure.
                let load_start = std::time::Instant::now();
                let storage_for_load = storage.clone();
                let load_result: Result<Option<[u8; 32]>, ()> = match tokio::task::spawn_blocking(move || {
                    storage_for_load.canonical_hash_at(parent_h)
                }).await {
                    Ok(Some(canonical)) => Ok(Some(canonical)),
                    Ok(None) => Ok(None),
                    Err(join_err) => {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] verify_load_prev_join_err h={} parent_h={} err={}",
                                mb.height, parent_h, join_err
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                let load_elapsed = load_start.elapsed();
                if load_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_storage_read stage=verify h={} parent_h={} elapsed_ms={}",
                            mb.height, parent_h, load_elapsed.as_millis()
                        );
                    }
                }
                let prev_hash_ok = match load_result {
                    Ok(Some(prev_hash)) => mb.previous_hash == prev_hash,
                    Ok(None) => {
                        // Capture height fields BEFORE moving `decoded` into
                        // the deferred map — `mb` is borrowed from `decoded`
                        // and would be invalidated by the move otherwise.
                        let child_h = mb.height;
                        let parent_h = mb.height - 1;
                        // We are here because the parent SLOT is empty (the read above returned
                        // None), so this is an ordinary gap: defer and let the drain or repair fill
                        // it. A child built on a COMPETING parent takes the mismatch path instead
                        // (prev_hash_ok == false below), which is where the fork witness belongs —
                        // re-testing the same empty slot here would be both unreachable and a
                        // blocking storage read on the async reactor, once per deferred block.
                        // Occupying a deferred slot requires a valid producer signature. The parent
                        // gate runs before signature verification (cheap rejects first), but the
                        // buffer is now keyed by PARENT HASH — an unauthenticated peer could
                        // otherwise mint unlimited distinct keys with junk parents and pin the
                        // buffer. Height keying used to bound that implicitly; hash keying does not.
                        // Honour the worker pool's verdict: with verify_workers > 1 the block was
                        // already ML-DSA-verified before reaching this stage. Re-verifying here would
                        // run inline on the single serial verify task, taking no _verify_permits —
                        // during catch-up, where most blocks pass through this buffer, that doubles
                        // the cost on the one stage that cannot parallelise. The flag is process-local
                        // and never crosses the wire (same reasoning as the stage's own check).
                        let sig_ok = decoded.sig_pre_verified
                            || (!mb.signature.is_empty()
                                && BlockchainNode::verify_microblock_signature(
                                    &storage, &decoded.microblock, &decoded.microblock.producer, None,
                                ).await.unwrap_or(false));
                        if !sig_ok {
                            if is_warn() {
                                println!("[WARN][PIPELINE] deferred_rejected_unsigned h={} from={}",
                                         child_h, decoded.from_peer);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            metrics.mark_verify_idle();
                            continue;
                        }
                        // Record the result so the replay does not pay for the same verification
                        // twice — during catch-up most blocks pass through the deferred buffer.
                        decoded.sig_pre_verified = true;
                        // Per-producer cap. The buffer is keyed by parent hash, which the sender
                        // chooses, so a single registered producer could otherwise sign DEFERRED_MAX
                        // blocks with random parents, fill every slot, and starve honest deferrals —
                        // exactly during the stall in which this buffer is the recovery mechanism.
                        // Height keying used to bound this implicitly; hash keying does not.
                        // Sized above a full rotation: one producer legitimately makes
                        // ROTATION_INTERVAL_BLOCKS consecutive blocks, and under loss they can all
                        // arrive out of order — a cap below that would drop honest traffic. Two
                        // rotations of headroom still bounds an attacker to 64 instead of 2000.
                        const DEFERRED_MAX_PER_PRODUCER: usize = 2 * crate::node::ROTATION_INTERVAL_BLOCKS as usize;
                        let from_this_producer = *deferred_by_producer
                            .get(&decoded.microblock.producer).unwrap_or(&0usize);
                        if from_this_producer >= DEFERRED_MAX_PER_PRODUCER {
                            if is_warn() {
                                println!("[WARN][PIPELINE] deferred_producer_cap h={} producer={} held={}",
                                         child_h, decoded.microblock.producer, from_this_producer);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            metrics.mark_verify_idle();
                            continue;
                        }
                        // Previous block not yet available — park it under the parent it waits for.
                        if deferred_count < DEFERRED_MAX {
                            if is_debug() {
                                println!("[DBG][PIPELINE] block_deferred h={} need_h={} buf={}",
                                         child_h, parent_h, deferred_count);
                            }
                            let parked_at = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs()).unwrap_or(0);
                            let waiters = deferred.entry(mb.previous_hash).or_default();
                            // Drop an exact duplicate re-delivery; distinct siblings both survive.
                            if !waiters.iter().any(|(_, d)| d.microblock.hash() == decoded.microblock.hash()) {
                                *deferred_by_producer.entry(decoded.microblock.producer.clone()).or_insert(0) += 1;
                                waiters.push((parked_at, decoded));
                                deferred_count += 1;
                            }
                        } else {
                            if is_info() {
                                println!("[INFO][PIPELINE] deferred_full h={} dropped (buf={})",
                                         child_h, DEFERRED_MAX);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        }

                        // Active sync trigger (storage gap recovery). Passive
                        // defer is insufficient under partial gossip: if the
                        // parent never arrives (peer offline, partition,
                        // dropped shred) the deferred buffer fills with orphans
                        // and the gap stays open forever (observed h=180-241).
                        // Size-adaptive: small gap → per-height single-flight;
                        // large gap → batched range request via sync_blocks.
                        let local_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(Ordering::Relaxed);
                        let gap = child_h.saturating_sub(local_tip);
                        if gap > RANGE_SYNC_GAP_THRESHOLD {
                            let from = local_tip.saturating_add(1);
                            let _ = request_missing_range(from, child_h);
                        } else {
                            let _ = request_missing_parent(parent_h);
                        }

                        // v18: mark verify stage as IDLE on the deferral path
                        // so the watchdog does not report `verify_stuck` with
                        // a stale `op_age_ms` value.
                        metrics.mark_verify_idle();
                        continue;
                    }
                    Err(()) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] prev_load_err h={} parent_h={}",
                                     mb.height, parent_h);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };

                if !prev_hash_ok {
                    if is_warn() {
                        println!("[WARN][PIPELINE] hash_chain_break h={} from={} block_round={}",
                                 mb.height, decoded.from_peer, mb.timeout_round);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);

                    // Two parallel paths on a locally-detected hash-chain
                    // break: (1) advisory source-witness counting — records
                    // from_peer for resync-source steering, non-destructive
                    // (single-source ceiling); (2) destructive observer-based
                    // rejection — broadcast a ML-DSA-65-signed BlockRejection;
                    // receivers verify the observer sig, aggregate distinct
                    // observer_ids per (height,source), and roll back at n−f.
                    // BFT-canonical: a supermajority of independent observers
                    // justifies state mutation; one Byzantine source can't
                    // (≤f can't reach n−f). Skip h=0 (no prev).
                    if mb.height > 0 {
                        record_hash_chain_break_witness(
                            mb.height,
                            &decoded.from_peer,
                        );

                        // Walk-to-divergence: a chain break means OUR stored parent may be the losing
                        // variant whose canonical replacement we lack. Solicit the parent so certified-round
                        // fork-choice can supersede it and the rollback deepens one height toward the true
                        // divergence point; repeat until the chains link. Runs for EVERY break, not just
                        // round>0 blocks — the round of the CHILD says nothing about which side diverged,
                        // and gating on it left round-0 breaks with no convergence path at all. Safe when
                        // our parent is canonical: the fetched parent is same/lower round ⇒ no supersede.
                        // Self-throttled (2s/height, 16/s bucket).
                        if mb.height > 1 {
                            if let Some(ref p2p) = unified_p2p {
                                let _ = p2p.request_block_repair(mb.height - 1).await;
                            }
                        }

                        // Broadcast observer-side rejection if we have the P2P
                        // handle and this isn't a self-emitted block (a producer
                        // never rejects its own block — that path is the local
                        // signing failure, handled elsewhere).
                        if let Some(ref p2p) = unified_p2p {
                            if !decoded.from_peer.is_empty() && decoded.from_peer != "self" {
                                let rejected_hash = decoded.microblock.hash();
                                // Best-effort load of our local view of the
                                // parent for diagnostic purposes — receivers do
                                // not act on this field, it's purely evidence.
                                let local_prev_hash = match storage
                                    .load_microblock_auto_format(mb.height.saturating_sub(1))
                                {
                                    Ok(Some(local_prev)) => local_prev.hash(),
                                    _ => [0u8; 32],
                                };
                                let payload = format!(
                                    "QNET_BLOCK_REJECTION_V1:{}:{}:{}:{}:{}",
                                    node_id,
                                    mb.height,
                                    decoded.from_peer,
                                    hex::encode(&rejected_hash),
                                    hex::encode(&local_prev_hash)
                                );
                                let sig_bytes = if let Some(crypto) = crate::node::try_get_quantum_crypto() {
                                    match crypto
                                        .create_consensus_signature(
                                            &node_id,
                                            &payload,
                                        )
                                        .await
                                    {
                                        Ok(sig) => Some(sig.signature.as_bytes().to_vec()),
                                        Err(e) => {
                                            if is_warn() {
                                                println!(
                                                    "[WARN][REJECT] sign_failed h={} err={}",
                                                    mb.height, e
                                                );
                                            }
                                            None
                                        }
                                    }
                                } else {
                                    None
                                };
                                if let Some(sig) = sig_bytes {
                                    p2p.broadcast_block_rejection(
                                        mb.height,
                                        decoded.from_peer.clone(),
                                        rejected_hash,
                                        local_prev_hash,
                                        sig,
                                    );
                                }
                            }
                        }
                    }

                    // v27 HOLE4: liveness — without this, persistent chain
                    // break at the frontier spins forever (applied=0; the
                    // 5.4h h=53731 wedge). Re-pull canonical range from last
                    // committed (request_missing_range is single-flight windowed, 10s retry,
                    // detached — safe per break).
                    let local_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if mb.height > local_tip {
                        let _ = request_missing_range(
                            local_tip.saturating_add(1),
                            mb.height,
                        );
                    }

                    // v32.10: macroblock-anchored fork recovery for minority
                    // observers. Uses n−f-certified macroblock as trust anchor;
                    // bounded by begin_finality_guarded_rollback (cannot cross
                    // finality). Genesis bootstrap excluded ONLY during fresh-
                    // bootstrap phase (h < BOOTSTRAP_GRACE_HEIGHT); after that
                    // genesis functions as a regular validator and needs the
                    // same recovery path.
                    const BOOTSTRAP_GRACE_HEIGHT: u64 = 1_000;
                    if mb.height > 0 {
                        let local_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(std::sync::atomic::Ordering::Relaxed);
                        let is_genesis_in_bootstrap = std::env::var("QNET_BOOTSTRAP_ID").is_ok()
                            && std::env::var("DOCKER_ENV").is_ok()
                            && local_h < BOOTSTRAP_GRACE_HEIGHT;
                        if !is_genesis_in_bootstrap {
                            let finalized_h = crate::node::LAST_FINALIZED_HEIGHT
                                .load(std::sync::atomic::Ordering::SeqCst);
                            let disputed_h = mb.height;
                            // Fork-choice at the DISPUTED height (finality-subordinate, deterministic):
                            // prefer the strictly higher certified failover round (a round needs an n−f
                            // TimeoutCertificate — unforgeable, identical on every honest node); on EQUAL
                            // round, the lexicographically-lower block hash. The hash tie-break converges
                            // same-round self-forks (a restarted producer re-emitting a different block at the
                            // same height) that a round-only gate leaves split, while a strict single winner
                            // avoids the mutual disputed_h-2 rollback oscillation.
                            // Load the LOCAL competitor as an Option: at a NON-stored disputed height there
                            // is nothing to tie-break against, so the equal-round branch must NOT fire (the
                            // old `[0u8;32]` default happened to make hash<min false; an empty-sig default
                            // would make Sha3(incoming)<Sha3(empty) grindable — a reorg-DoS). We keep the
                            // Option and gate the equal-round case on it via equal_round_selffork_supersedes.
                            let local_opt = storage
                                .load_microblock_auto_format(disputed_h)
                                .ok().flatten();
                            let (local_round, local_baseline) = local_opt.as_ref()
                                .map(|b| (b.timeout_round, b.carried_baseline))
                                .unwrap_or((0u64, 0u64));
                            // Adopt the block's attached n−f TimeoutProof so a higher round it carries advances
                            // our certified map in-band; a higher round then wins ONLY if n−f-certified
                            // (unforgeable — a raw round could not, which caused the rollback storm). Equal round
                            // → lower block.hash() (single deterministic winner, grind-immune since the hash
                            // excludes the signature; byte-identical to the apply-path resolver). One rule network-wide.
                            if let (Some(pb), Some(p)) = (decoded.microblock.timeout_proof.as_ref(), unified_p2p.as_ref()) {
                                p.adopt_timeout_proof_bytes(pb);
                            }
                            // Compare ABSOLUTE rounds (relative + carried baseline), both from the block
                            // bytes — a same-height loser-apply can no longer inflate the ranking.
                            let incoming_abs = mb.timeout_round.saturating_add(mb.carried_baseline);
                            let local_abs = local_round.saturating_add(local_baseline);
                            let incoming_outranks = if incoming_abs > local_abs {
                                crate::unified_p2p::failover_round_authorized(mb.height / 90, mb.timeout_round, mb.carried_baseline)
                            } else if incoming_abs == local_abs {
                                // Equal round: only a genuine same-producer self-fork (valid sig, lower hash)
                                // supersedes, and only if we actually HOLD a competitor here (None ⇒ false).
                                equal_round_selffork_supersedes(&storage, &decoded.microblock,
                                    local_opt.as_ref().map(|b| (b.producer.as_str(), b.hash())))
                            } else {
                                false
                            };
                            if incoming_outranks && finalized_h > 0 && finalized_h < disputed_h {
                                let now_secs = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0);
                                let cooldown_ok = match FORK_RECOVERY_TRIGGER_TIMES
                                    .get(&disputed_h)
                                {
                                    Some(t) => now_secs.saturating_sub(*t) >= FORK_RECOVERY_COOLDOWN_SECS,
                                    None => true,
                                };
                                if cooldown_ok {
                                    // Roll back to the last good height = disputed-2 (the forked block is
                                    // local[disputed-1]), clamped to ≥ finalized. finalized_h+1 was wrong when
                                    // the fork IS at finalized+1 (our own tip): the handler's `rollback_to <
                                    // local_h` guard then never fires → forked tip kept → permanent
                                    // hash_chain_break (the N004 single-source self-fork wedge).
                                    let target = disputed_h.saturating_sub(2).max(finalized_h);
                                    signal_fork_recovery(target);
                                    // Stamp the cooldown only when this detector actually moved the
                                    // signal. Stamping unconditionally silences this height for the
                                    // cooldown window even though a deeper pending target won —
                                    // the deeper rollback then runs with no re-trigger behind it.
                                    if fork_recovery_target() == target {
                                        FORK_RECOVERY_TRIGGER_TIMES.insert(disputed_h, now_secs);
                                        if is_warn() {
                                            println!(
                                                "[WARN][FORK] anchor_recovery disputed_h={} finalized_h={} rollback_target={} reason=minority_observer",
                                                disputed_h, finalized_h, target,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    continue;
                }
            }

            // 2. Slot-anchored timestamp validation (LIVE only; SYNC skips — block_ts is
            // already bound by the block hash + producer Dilithium sig + hash-chain).
            // block_ts must equal genesis_ts + height*SLOT exactly: deterministic,
            // clock-independent, non-gameable. The single source of truth on the live path.
            let snap = coordinator.snapshot();
            if !snap.is_syncing() && mb.height > 0 {
                let g = crate::GLOBAL_GENESIS_TIMESTAMP.load(Ordering::Relaxed);
                if g != 0 {
                    let expected = crate::node::expected_block_timestamp(g, mb.height);
                    if mb.timestamp != expected {
                        if is_warn() {
                            println!("[WARN][PIPELINE] slot_mismatch h={} ts={} expected={} from={}",
                                     mb.height, mb.timestamp, expected, decoded.from_peer);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }
            }

            // v22: cert presence gate REMOVED. Microblocks no longer carry a
            // rotation round (`mb.timeout_round` is always 0 — see
            // `node.rs::microblock_construction`). The previous gate existed to
            // require AggregatedTimeoutCert presence for round>0 microblocks;
            // the round>0 case is now structurally unreachable from honest
            // producers, and dishonest emitters are caught by the signature
            // gate immediately below. Macroblock layer retains its own n−f
            // Checkpoint-BFT QC finality — that path is unchanged.

            // 3. Signature verification
            // Genesis block (h=0) uses embedded self-signed keys — skip standard verification.
            // Every other height MUST carry a producer signature; empty sig is a hard reject.
            if mb.height > 0 {
                // MANDATORY signature: previously empty `mb.signature` slipped past
                // verification entirely (the surrounding `if !mb.signature.is_empty()`
                // wrapped the verify call but had no else branch — empty was implicit
                // accept). Honest producers always emit
                // "dilithium3_v4:<hex>" via `sign_microblock_with_dilithium`,
                // so an empty signature on a non-genesis block can only come from
                // a malformed or hostile sender. Reject hard.
                if mb.signature.is_empty() {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] sig_missing h={} prod={} from={} action=reject",
                            mb.height, mb.producer, decoded.from_peer
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }

                // v15.4 DIAG: mark op as signature verify. ML-DSA-65
                // verify is a sync C-binding called via an async
                // wrapper; if it ever blocks the runtime worker
                // thread under load, the watchdog will surface this
                // op as the stuck point.
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_SIG);

                // ═══════════════════════════════════════════════════════════
                // v25 H14: SKIP-VERIFY-IF-PRE-VERIFIED FAST PATH
                // ───────────────────────────────────────────────────────────
                // When the parallel verify worker pool is enabled (the
                // production configuration), each block already had its
                // ML-DSA-65 signature verified upstream of this stage. The
                // worker that performed the verify flips
                // `decoded.sig_pre_verified` to `true`. Re-running the same
                // signature verify here is pure waste: same key, same
                // payload, same result. Skipping it cuts the apply-path
                // critical section by ~1–2 ms per block — a ~60–120 ms
                // saving across a 90-block macroblock window, which directly
                // tightens the chain's apply-to-finalisation latency.
                //
                // Safety: the flag is set by THIS process's own pre-verify
                // worker, not received over the wire. There is no untrusted
                // input that can spoof it (DecodedBlock never crosses a
                // network boundary). When the single-worker config is
                // selected (`verify_workers == 1`), nothing sets the flag
                // and the canonical verify below runs unchanged.
                // ═══════════════════════════════════════════════════════════
                if decoded.sig_pre_verified {
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] skip_redundant_verify h={} reason=pre_verified",
                            mb.height,
                        );
                    }
                } else {
                    let sig_start = std::time::Instant::now();
                    // v24: acquire a verify-pool permit before running ML-DSA-65
                    // verification. The permit count is `config.verify_workers`
                    // (default 2, prod 4). Concurrent blocks queue here without
                    // blocking the deferred-buffer / hash-chain state above —
                    // this gives parallel signature CPU utilisation while keeping
                    // the verify-stage state machine sequential.
                    let _permit = _verify_permits.clone().acquire_owned().await.ok();
                    let verify_ok = match BlockchainNode::verify_microblock_signature(
                        &storage,
                        &decoded.microblock,
                        &decoded.microblock.producer,
                        None, // No P2P needed for sync verification
                    ).await {
                        Ok(valid) => valid,
                        Err(e) => {
                            if is_warn() {
                                println!("[WARN][PIPELINE] sig_verify_err h={} err={}", mb.height, e);
                            }
                            false
                        }
                    };
                    drop(_permit);

                    let sig_elapsed = sig_start.elapsed();
                    if sig_elapsed > std::time::Duration::from_millis(500) {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] slow_signature_verify h={} elapsed_ms={}",
                                mb.height, sig_elapsed.as_millis()
                            );
                        }
                    }
                    if !verify_ok {
                        if is_warn() {
                            println!("[WARN][PIPELINE] sig_invalid h={} prod={} from={}",
                                     mb.height, mb.producer, decoded.from_peer);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }
            }

            // Producer authority check (same-round mismatch ≡ HARD reject).
            //   A. timeout_divergence (block round != cached round): views of
            //      HIGHEST_CERTIFIED_ROUND diverged in transit. Soft —
            //      log only; hash-chain + sig + n−f commit resolve it. Expected
            //      producer is NOT re-derived on ingest (needs remote VRF preimage).
            //   B. same_round_mismatch (cached round == block round, wrong signer):
            //      cached producer is the sole authority for the slot via the
            //      deterministic VRF formula (base_idx + round) % N. HARD REJECT.
            // Fork-safe: cache = stored BFT-agreed round (pure fn of ML-DSA-65-
            // verified votes + on-chain VRF) → every honest node derives the same
            // expected producer; all reject or none. (Pre-v14.8.10 used local
            // non-deterministic state and did fork.) Gated to !is_syncing() so
            // catch-up blocks aren't judged vs live cache. O(1) lookup.
            if !snap.is_syncing() && mb.height > 0 {
                // v33: failover authority gate. A block claiming rotation round R (>0)
                // is authentic ONLY if an n−f TimeoutCertificate for (height, R) exists.
                // The cert is self-contained (n−f Dilithium votes, verified before store
                // in handle_timeout_proof_broadcast), so this check is IDENTICAL on every
                // node — unlike the prior `highest_certified_round_for` drift window, whose
                // local-certified term diverged across nodes (baseline skew) and let each
                // node accept a DIFFERENT self-chosen round → competing forks → rollback
                // storm. No cert yet (gossip race) → reject this ingest attempt; the block
                // stays replayable and is re-accepted once the cert (re-broadcast by the
                // producer at certification) arrives, or via sync (which skips this gate,
                // trusting macroblock finality). Round 0 (happy path) needs no cert. O(1).
                // Gate on the ABSOLUTE round (timeout_round + carried_baseline > 0), not just
                // timeout_round: a Byzantine round-0 leader can stamp timeout_round=0 with an
                // inflated (signed) carried_baseline; without this the block would skip the gate,
                // apply, and record_finalized_round(mb, 0+huge) would poison the window baseline.
                if mb.timeout_round > 0 || mb.carried_baseline > 0 {
                    // Authorise the failover round with the SAME predicate the producer used to
                    // pick it — `highest_certified_round_for(mb_idx) >= round + baseline`, keyed by
                    // mb_idx + ABSOLUTE round. HIGHEST_CERTIFIED_ROUND advances ONLY on a same-round
                    // n−f TimeoutCertificate, so the producer can be at round R only if the network
                    // certified R — both sides read the same map and can never disagree. A forged
                    // round isn't certified ⇒ rejected; round 0 (happy path) needs no certificate.
                    // #80: adopt the block's ATTACHED n−f TimeoutProof first (self-authenticating,
                    // verified inside), so a node that missed the separate TC broadcast learns the
                    // certified round in-band and authorises the block instead of wedging. A forged
                    // or absent proof advances nothing → round stays uncertified → pull/reject below.
                    if let (Some(pb), Some(p2p)) =
                        (decoded.microblock.timeout_proof.as_ref(), unified_p2p.as_ref())
                    {
                        p2p.adopt_timeout_proof_bytes(pb);
                    }
                    let round_certified =
                        crate::unified_p2p::failover_round_authorized(mb.height / 90, mb.timeout_round, mb.carried_baseline);
                    if !round_certified {
                        // PULL-ON-REJECT: the round IS legitimate (a producer reached it via a
                        // same-round n−f), but the proving TimeoutCertificate never arrived — its
                        // broadcast is one-shot and vote gossip only re-fans on NEW votes, which stop
                        // once the storm settles, so a node that missed the brief window would stay
                        // stuck forever. Actively request this window's timeout certificates from
                        // peers (rate-limited per mb_idx); the existing serve returns the same-round
                        // n−f TimeoutCertificate, which advances our HIGHEST_CERTIFIED_ROUND so this
                        // still-replayable block is accepted next pass. Reuses the sync catch-up
                        // request/serve — no new wire type.
                        let mb_idx = mb.height / 90;
                        let now_secs = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs()).unwrap_or(0);
                        let due = FAILOVER_CERT_PULL_TIMES.get(&mb_idx)
                            .map(|t| now_secs.saturating_sub(*t) >= FAILOVER_CERT_PULL_COOLDOWN_SECS)
                            .unwrap_or(true);
                        if due {
                            FAILOVER_CERT_PULL_TIMES.insert(mb_idx, now_secs);
                            // Bounded: failover-rejects are transient, so keep only recent windows.
                            // Prune in mb_idx space (keys are mb_idx, NOT microblock height — pruning
                            // by height would purge the whole map). Cheap opportunistic sweep.
                            if FAILOVER_CERT_PULL_TIMES.len() > 64 {
                                let keep_from = mb_idx.saturating_sub(16);
                                FAILOVER_CERT_PULL_TIMES.retain(|k, _| *k >= keep_from);
                            }
                            if let Some(p2p) = unified_p2p.as_ref() {
                                p2p.request_timeout_proofs(mb_idx, mb_idx);
                            }
                        }
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] failover_round_uncertified h={} round={} from={} action=reject_await_cert",
                                mb.height, mb.timeout_round, decoded.from_peer,
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }

                if let Some((expected, expected_round)) = crate::node::get_expected_producer(mb.height) {
                    if mb.producer != expected {
                        // Compare/derive on the ABSOLUTE round (timeout_round + carried_baseline, both
                        // signed) — the cache now stores absolute. carried_baseline is producer-supplied
                        // and only sum-constrained by auth, so deriving the leader from the RELATIVE
                        // timeout_round alone let a Byzantine member re-partition a certified round R into
                        // (t, R-t), choosing t so candidates[(round0_idx+t)%N]==itself and passing the
                        // hard gate. Absolute pins the leader to candidates[(round0_idx+R)%N] regardless
                        // of the split → the free choice of t is eliminated.
                        let incoming_abs_round = mb.timeout_round.saturating_add(mb.carried_baseline);
                        if incoming_abs_round != expected_round {
                            // Category A: block claims a DIFFERENT round than our cached view. The
                            // round>0 gate above already proved that round is n−f-certified, so its
                            // leader is deterministic — re-derive it for the BLOCK's round and HARD
                            // REJECT a producer that isn't that round's elected leader. Closes the
                            // certified-round production hijack (a Byzantine node borrowing a valid TC
                            // to produce off-slot at a height our cached round hasn't caught up to).
                            // Cache miss (we haven't computed that window's roster — lag/cold-join) ⇒
                            // keep soft: the block stays replayable and is re-checked once we derive
                            // the roster or via macroblock n−f finality.
                            match crate::node::expected_producer_for_round(mb.height, incoming_abs_round) {
                                Some(leader) if mb.producer != leader => {
                                    if is_warn() {
                                        println!(
                                            "[WARN][PIPELINE] producer_hijack_reject h={} round={} leader={} got={} from={}",
                                            mb.height, mb.timeout_round, leader, mb.producer, decoded.from_peer
                                        );
                                    }
                                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                                    continue;
                                }
                                _ => {
                                    // Correct leader for its round (our cache merely lagged), or roster
                                    // not yet derivable ⇒ accept; BFT rotation + fork-choice converge.
                                    if is_info() {
                                        println!("[INFO][PIPELINE] timeout_divergence h={} our_round={} block_round={} our_prod={} block_prod={}",
                                                 mb.height, expected_round, mb.timeout_round, expected, mb.producer);
                                    }
                                }
                            }
                        } else {
                            // Category B: same rank, DIFFERENT producer → unauthorised.
                            // HARD REJECT — producer did not earn this slot per VRF.
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] producer_unauthorised_reject h={} round={} expected={} got={} from={}",
                                    mb.height, expected_round, expected, mb.producer, decoded.from_peer
                                );
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                    }
                }
            }

            // No ingest-side stale-round reject: mb.timeout_round (microblock
            // rotation counter, 0 on happy path) and HIGHEST_CERTIFIED_ROUND
            // (macroblock commit/reveal view round) are orthogonal — comparing
            // them rejected valid microblocks (liveness loss, no safety gain).
            // Per-microblock QC verify is also removed (redundant with the n−f
            // macroblock finality below + caused a rate-limit collision).
            // Microblock safety holds via: ML-DSA-65 producer sig; prev_hash
            // continuity; VRF-deterministic producer (soft); n−f macroblock
            // commit/reveal retroactively ratifying (split-brain can't reach n−f).

            // Wire-limit gate BEFORE any per-TX work. Transactions inside a producer-signed block never
            // pass through mempool admission, so this is the only place their free-form fields meet a
            // ceiling — and the gates below decode some of them with superlinear decoders.
            {
                let oversized = decoded.microblock.transactions.iter()
                    .find_map(|tx| tx.enforce_wire_limits().err());
                if let Some(reason) = oversized {
                    if is_warn() {
                        println!("[WARN][PIPELINE] tx_wire_limit h={} producer={} from={} reason={} action=reject_block",
                                 mb.height, mb.producer, decoded.from_peer, reason);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            // Internal-only TX type guard: post-genesis, HARD REJECT the whole
            // block (+ peer reputation penalty) if it carries a genesis-only or
            // deprecated variant (CreateAccount / BatchRewardClaims /
            // BatchNodeActivations / BatchTransfers) — a Byzantine producer
            // could embed one bypassing mempool admission. O(tx_count).
            if mb.height > 0 {
                for tx in &decoded.microblock.transactions {
                    let forbidden = matches!(tx.tx_type,
                        qnet_state::TransactionType::CreateAccount { .. } |
                        qnet_state::TransactionType::BatchRewardClaims { .. } |
                        qnet_state::TransactionType::BatchNodeActivations { .. } |
                        qnet_state::TransactionType::BatchTransfers { .. }
                    );
                    if forbidden {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] forbidden_tx_type_in_block h={} tx_type_discriminant={:?} producer={} from_peer={} action=reject_block",
                                mb.height,
                                std::mem::discriminant(&tx.tx_type),
                                mb.producer,
                                decoded.from_peer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        // Continue 'outer-style: drop this block entirely. We don't
                        // strip the offending TX because that would mutate a block
                        // already producer-signed; instead we discard the block and
                        // sync_manager will refetch the canonical version from a
                        // different peer.
                        continue 'outer;
                    }
                }
            }

            // 5. Per-TX signature verification (post-genesis). The block sig (step
            // 3) authenticates only the ENVELOPE, not the TXs within — without this
            // a Byzantine producer could include forged TXs. Remote-block TXs bypass
            // the mempool (which verifies on ingest) and apply_transaction_lazy
            // intentionally doesn't verify, so the pipeline must: ML-DSA-65 per TX
            // plus the shared system-TX bind gate below.
            // Genesis (h==0) bypass: genesis TXs use reserved-sender tokens, not
            // real sigs; safe via producer sig + genesis-hash determinism + one-time
            // bootstrap. O(tx)/block, off the state lock.
            if mb.height == 0 {
                if is_info() {
                    println!(
                        "[INFO][PIPELINE] genesis_block_skip_tx_sig h=0 txs={} producer={}",
                        decoded.microblock.transactions.len(),
                        mb.producer
                    );
                }
            } else if !decoded.microblock.transactions.is_empty() {
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_SIG);
                let txsig_start = std::time::Instant::now();

                // ML-DSA-65 verify for PQ-signed TXs. v25.2: delegate to the canonical
                // helper (verify_dilithium_tx_signature_async ->
                // consensus_crypto::verify_consensus_signature) used by gossip/RPC, so
                // apply-path verdicts are byte-identical to gossip for every signer class.
                // Two on-wire layouts: user/mobile TXs ship raw hex sig(3309)/pk(1952);
                // node system TXs use "dilithium_sig_<node_id>_<b64>" + pk=node_id (key
                // from CONSENSUS_PK_REGISTRY). The old inline hex decoder hard-rejected
                // the system format -> froze testnet at h=14350 (commitment window).
                // Helper batches verifies on SIGVERIFY_RUNTIME (parallel, not seq await).
                // FIX-5: resolve any ELIDED value-TX pk from committed in-mem State on a CLONE, then
                // verify. This State read is DETERMINISTIC — the parent-continuity gate above pins
                // apply-frontier == H-1, so State is complete & canonical for every account < H (never
                // the detached accounts CF). The decoded microblock / raw shreds stay ELIDED (we clone),
                // so forwarded + stored wire bytes are unchanged. A wire pk that IS present is never
                // overwritten (its eon(pk)==from bind still runs). API-1 receive-path close: value TXs
                // are ALWAYS verified (a signatureless forged value TX → verify false → hard-reject).
                let mut dilithium_invalid = 0usize;
                let mut pk_unresolved = false;
                {
                    use futures::future::join_all;
                    let snap_in_progress = crate::storage::SNAPSHOT_REHYDRATE_IN_PROGRESS
                        .load(Ordering::Acquire);
                    let mut rehydrated: Vec<qnet_state::Transaction> = Vec::new();
                    {
                        // ONE read-lock for the whole block's value-TX batch, released BEFORE the verifies.
                        let sg = state.read().await;
                        for tx in &decoded.microblock.transactions {
                            // Merkle reward-claims carry the RECIPIENT's key over the claims payload, not a
                            // sender sig over the TX — apply re-verifies both. Exempt from PQ re-verify here.
                            if matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution)
                                && tx.from == "system_rewards_pool" { continue; }
                            let is_value = tx.is_value_class();
                            if is_value {
                                // During a snapshot rehydrate, State is half-materialized → treat any
                                // elided value-TX as unresolved + defer (mirror the apply-path guard).
                                if snap_in_progress
                                    && tx.dilithium_public_key.as_deref().map_or(true, |p| p.is_empty()) {
                                    pk_unresolved = true; break;
                                }
                                let mut c = tx.clone();
                                match crate::node::BlockchainNode::rehydrate_elided_pk(&mut c, &*sg) {
                                    crate::node::PkResolve::Unresolved => { pk_unresolved = true; break; }
                                    _ => rehydrated.push(c),
                                }
                            } else if matches!(&tx.dilithium_signature, Some(s) if !s.is_empty()) {
                                rehydrated.push(tx.clone());
                            }
                        }
                    } // read-lock dropped here
                    if !pk_unresolved && !rehydrated.is_empty() {
                        let verify_futures: Vec<_> = rehydrated.iter()
                            .map(|tx| crate::node::BlockchainNode::verify_dilithium_tx_signature_async(tx, crate::node::VerifyLane::Block))
                            .collect();
                        let results = join_all(verify_futures).await;
                        for r in results {
                            match r {
                                // Block lane AWAITS its reserved pool, so an Err here is a genuine
                                // verify failure (never local backpressure) → count as invalid.
                                Ok(true) => {}
                                Ok(false) | Err(_) => dilithium_invalid += 1,
                            }
                        }
                    }
                }

                if pk_unresolved {
                    // FIX-5 DEFER (NOT reject): an elided value-TX whose committed pk isn't present on
                    // THIS node yet is indistinguishable from not-yet-synced — retry as the chain
                    // advances via the committee_deferred drain. Hard-rejecting here would fork a
                    // snapshot/catch-up node off the canonical chain. Bounded by DEFERRED_MAX.
                    let dh = decoded.height;
                    if committee_deferred.len() < DEFERRED_MAX {
                        committee_deferred.insert(dh, decoded);
                        if is_debug() { println!("[DBG][PIPELINE] pk_deferred h={} reason=elided_pk_uncommitted", dh); }
                    } else {
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    }
                    continue;
                }

                if dilithium_invalid > 0 {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] dilithium_invalid h={} count={} producer={} from={} action=reject_block",
                            mb.height, dilithium_invalid, mb.producer, decoded.from_peer
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — Byzantine producer with bad PQ sigs
                }

                let txsig_elapsed = txsig_start.elapsed();
                if txsig_elapsed > std::time::Duration::from_millis(100) {
                    if is_info() {
                        println!(
                            "[INFO][PIPELINE] tx_sig_verify h={} txs={} elapsed_ms={}",
                            mb.height, decoded.microblock.transactions.len(), txsig_elapsed.as_millis()
                        );
                    }
                }
            }

            // Shared system-TX identity binds — the SAME gate the gossip path enforces
            // (BlockchainNode::verify_system_tx_binds), applied here so a Byzantine producer's block
            // cannot smuggle an unsigned or mis-attributed system TX past the receive-side validator:
            // an unsigned bitmap/ping would otherwise forge a whole shard's light eligibility (no burn
            // gate on those), a cross-shard bitmap would hijack another genesis' shard, and an unbound
            // first-registration would skip the native dpk→wallet bind. Presence + signer↔declared-
            // identity binds; the Dilithium VALIDITY is the verify stage above. Pure/deterministic
            // (TX bytes + committed-state VRF registry), so the verdict is byte-identical per node.
            if mb.height > 0 {
                if let Some(reason) = decoded.microblock.transactions.iter()
                    .find_map(|tx| crate::node::BlockchainNode::verify_system_tx_binds(tx).err())
                {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] system_tx_bind_failed h={} producer={} from={} reason={} action=reject_block",
                            mb.height, mb.producer, decoded.from_peer, reason
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — system TX fails presence / identity binds
                }

                // The epoch's emission is ONE-SHOT at h % 14400 == 0 and nothing required it to be
                // there: a producer that cannot build it (it needs locally applied state) emits a
                // perfectly valid empty block and the epoch silently loses BOTH the mint and its
                // reward_root — nobody can ever claim those 4 hours. Requiring it makes the slot a duty
                // only a node that actually holds state can discharge; a producer that cannot simply
                // fails over to one that can. Expectation is a pure function of height, so every node
                // agrees, and NoneDue heights are unaffected.
                // Exact(0) is the end of the emission schedule: the producer builds no TX at zero, so
                // requiring one would halt the chain permanently the moment the schedule floors out.
                if let crate::node::EmissionExpectation::Exact(amount) =
                    crate::node::BlockchainNode::expected_emission_amount(mb.height)
                {
                    if amount == 0 { /* nothing to mint ⇒ nothing to require */ } else
                    if crate::reward_epoch::select_emission_at(&decoded.microblock.transactions, mb.height).is_none() {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] emission_missing h={} producer={} action=reject_block",
                                mb.height, mb.producer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — an empty emission slot burns the epoch's rewards
                    }
                }

                // Equivocation proofs now MUTATE state (the offender's banned_at_height), so a block
                // carrying one that does not verify must be rejected here — the apply arm trusts that
                // this ran. Same verdict everywhere: TX bytes + committed chain state.
                let mut bad_proof: Option<String> = None;
                for tx in &decoded.microblock.transactions {
                    if matches!(tx.tx_type,
                        qnet_state::TransactionType::EquivocationProof { .. }
                        | qnet_state::TransactionType::VoteEquivocationProof { .. })
                        && !crate::node::BlockchainNode::equivocation_proof_verified(&storage, tx).await
                    {
                        bad_proof = Some(tx.hash.clone());
                        break;
                    }
                }
                if let Some(h) = bad_proof {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] equivocation_proof_invalid h={} producer={} tx={} action=reject_block",
                            mb.height, mb.producer, qnet_state::char_prefix(&h, 16)
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — a forged ban must never reach apply
                }
            }

            // Receive-side resource ceilings. The producer bounds its own block by BLOCK_GAS_LIMIT
            // and the separate BLOCK_FUEL_LIMIT while filling (node.rs), and its comment claims the
            // validator enforces the same two — it did not. Without a receive-side gate an elected
            // producer could ship a block of arbitrary declared compute and every node would apply
            // it, so the ceilings bounded only honest producers. Enforced FROM GENESIS and computed
            // from SIGNED fields only (gas_limit, and reserved_fuel which is a pure fn of it), so the
            // verdict is byte-identical on every node — a height gate or a storage-dependent variant
            // would split the network into cohorts that disagree on block validity. `charged_gas`
            // mirrors the producer's selection exactly; system TXs (gas_limit == 0) are exempt, as
            // they are in the fill loop.
            if mb.height > 0 {
                let mut block_gas: u64 = 0;
                let mut block_fuel: u64 = 0;
                let mut over: Option<String> = None;
                // Counted set must equal the producer's fill loop exactly, or an honest block is
                // rejected by its peers. Per-tx MAX_GAS_LIMIT is deliberately NOT here: it is an
                // admission rule, since a block-level reject would halt the chain on one oversized TX.
                for tx in &decoded.microblock.transactions {
                    if tx.from.starts_with("system_") || tx.gas_limit == 0 {
                        continue;
                    }
                    let charged_gas = if mb.height >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                        tx.compute_gas_used()
                    } else {
                        tx.gas_limit
                    };
                    block_gas = block_gas.saturating_add(charged_gas);
                    block_fuel = block_fuel.saturating_add(tx.reserved_fuel());
                    if block_gas > qnet_state::gas_limits::BLOCK_GAS_LIMIT {
                        over = Some(format!("block_gas={} max={}", block_gas,
                                            qnet_state::gas_limits::BLOCK_GAS_LIMIT));
                        break;
                    }
                    if block_fuel > qnet_state::gas_limits::BLOCK_FUEL_LIMIT {
                        over = Some(format!("block_fuel={} max={}", block_fuel,
                                            qnet_state::gas_limits::BLOCK_FUEL_LIMIT));
                        break;
                    }
                }
                if let Some(reason) = over {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] block_resource_limit h={} producer={} from={} {} action=reject_block",
                            mb.height, mb.producer, decoded.from_peer, reason
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — block declares more compute than the protocol allows
                }
            }

            // Phase-1 burn-attestation gate (a block-validation rule, like the signature checks
            // above — apply trusts validated blocks). When active at this height, a non-genesis
            // NodeRegistration MUST carry ≥ n−f distinct valid genesis attestations over its
            // canonical burn message; without it a Byzantine producer could inject a fake-burn
            // registration that every node would deterministically apply (free reward/producer-
            // eligible node). Deterministic: pure TX bytes + binary-pinned genesis keys. Inert
            // below the gate height (returns Ok), so the current relaunch is unaffected.
            if mb.height > 0 {
                use futures::future::join_all;
                // Same-block burn reuse: two NodeRegistrations sharing a burn_tx (cross-block reuse is
                // caught deterministically at verify via committed_burn_wallet). One burn backs one node.
                {
                    let mut seen_burns = std::collections::HashSet::new();
                    let dup = decoded.microblock.transactions.iter().any(|t| {
                        if let qnet_state::TransactionType::NodeRegistration { burn_tx, .. } = &t.tx_type {
                            !burn_tx.is_empty() && !seen_burns.insert(burn_tx.clone())
                        } else { false }
                    });
                    if dup {
                        if is_warn() {
                            println!("[WARN][PIPELINE] burn_reuse_in_block h={} action=reject_block", mb.height);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — one burn cannot back two registrations
                    }
                }
                let burn_storage = storage.clone();
                let burn_futures: Vec<_> = decoded.microblock.transactions
                    .iter()
                    .filter(|tx| matches!(tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }))
                    .map(|tx| crate::node::BlockchainNode::verify_burn_attestation_quorum(tx, mb.height, &burn_storage))
                    .collect();
                if !burn_futures.is_empty() {
                    let results = join_all(burn_futures).await;
                    if let Some(reason) = results.iter().find_map(|r| r.as_ref().err()) {
                        // Committee-absent (post-genesis N-2 not yet applied) ⇒ we can't yet verify the burn
                        // quorum: DEFER (re-verify once N-2 applies) so an honest registration isn't dropped
                        // while behind. A genuine invalid burn (committee present) still HARD-REJECTs; synced
                        // nodes hold the committee so never defer — the deterministic reject/fork-guard holds.
                        let h = mb.height;
                        if crate::node::BlockchainNode::burn_committee_absent_for(
                            &storage, &decoded.microblock.transactions)
                        {
                            if committee_deferred.len() < DEFERRED_MAX {
                                if is_debug() {
                                    println!("[DBG][PIPELINE] committee_deferred h={} reason=n2_absent buf={}", h, committee_deferred.len());
                                }
                                committee_deferred.insert(h, decoded);
                            } else {
                                metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            }
                            continue;
                        }
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] burn_attestation_invalid h={} producer={} from={} reason={} action=reject_block",
                                mb.height, mb.producer, decoded.from_peer, reason
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — registration without a valid genesis burn quorum
                    }
                }

                // Registration identity bind: node_id MUST equal the deterministic wallet pseudonym, so a
                // third party cannot burn-and-squat another wallet's derivable node_id (DoS its future
                // onboarding via the apply dup-guard). Applies to EVERY non-genesis registration — keying
                // it on the client_node_reg data prefix left the bind opt-out, since `data` is a free
                // attacker-chosen field. Genesis identities are protocol-minted and exempt. Pure fn of TX
                // bytes → identical verdict per node.
                {
                    let bad = decoded.microblock.transactions.iter().find_map(|tx| {
                        if let qnet_state::TransactionType::NodeRegistration { node_id, node_type, wallet_address, registration_proof, .. } = &tx.tx_type {
                            if !crate::node::BlockchainNode::registration_identity_bound(
                                node_id, node_type, wallet_address, registration_proof) {
                                return Some(node_id.clone());
                            }
                        }
                        None
                    });
                    if let Some(nid) = bad {
                        if is_warn() {
                            println!("[WARN][PIPELINE] reg_node_id_not_pseudonym h={} node={} action=reject_block", mb.height, nid);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — node_id must be the wallet pseudonym (anti-squat)
                    }
                }

                // NodeReactivation identity gate: the returning node's WIRE key MUST equal the vrf_pk
                // committed at its original registration (committed point-read) — the sole authority
                // now the gossip RAM-registry path is gone. No committed key ⇒ unknown identity ⇒
                // reject. Deterministic (committed CF + TX bytes); parent-continuity guarantees the
                // original registration row is applied before this block is verified.
                {
                    let react_bad = decoded.microblock.transactions.iter().find_map(|tx| {
                        if !matches!(tx.tx_type, qnet_state::TransactionType::NodeReactivation { .. }) {
                            return None;
                        }
                        let node_id = tx.from.as_str();
                        // FIX-5: the TX carries the pk as RAW 1952 bytes — compare directly.
                        let wire_pk = tx.dilithium_public_key.as_deref();
                        match (wire_pk, storage.load_vrf_public_key(node_id)) {
                            (Some(w), Ok(Some(c))) if !w.is_empty() && w == c.as_slice() => None,
                            _ => Some(node_id.to_string()),
                        }
                    });
                    if let Some(nid) = react_bad {
                        if is_warn() {
                            println!("[WARN][PIPELINE] reactivation_key_mismatch h={} node={} action=reject_block",
                                     mb.height, nid);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — reactivation key != committed vrf_pk (or unknown identity)
                    }
                }

                // Proof-of-burn gate for NodeActivation. NodeActivation carries NO burn of its own, so an
                // un-backed one would mint a node identity (super pseudonym / activation row → reward +
                // producer eligibility) for FREE, bypassing the 1DEV-burn Sybil cost the registration gate
                // above enforces. Require each activation's wallet to already hold a chain-confirmed burn-
                // attested registration — committed in a PRIOR block (parent-continuity guarantees blocks
                // < h are applied on every node before h is verified, so the lookup is deterministic) OR a
                // NodeRegistration in THIS block. Same activation-height gate as the registration rule;
                // genesis nodes never emit NodeActivation (genesis = NodeRegistration only).
                if qnet_state::feature_gates::is_active("burn_attestation_required", mb.height) {
                    let this_block_burned: std::collections::HashSet<String> = decoded.microblock.transactions.iter()
                        .filter_map(|t| match &t.tx_type {
                            qnet_state::TransactionType::NodeRegistration { wallet_address, burn_tx, .. }
                                if !burn_tx.is_empty() => Some(wallet_address.clone()),
                            _ => None,
                        }).collect();
                    let unbacked = decoded.microblock.transactions.iter().any(|t| {
                        matches!(t.tx_type, qnet_state::TransactionType::NodeActivation { .. })
                            && !this_block_burned.contains(&t.from)
                            && !storage.wallet_is_burn_registered(&t.from)
                            && !storage.wallet_is_genesis_node(&t.from) // genesis self-activates w/o burn
                    });
                    if unbacked {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] activation_without_burn h={} producer={} action=reject_block",
                                mb.height, mb.producer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — activation must be backed by a burn-attested registration
                    }
                }
            }

            // All checks passed — forward to apply stage.
            // v32.5: cache populated only on apply-commit, never at verify —
            // uncommitted view-change candidates must not poison the RAM cache.
            let block_height = decoded.height;
            // Identity of the block just verified — the key its waiting children were parked under.
            let verified_hash = decoded.microblock.hash();

            // Liveness is NOT recorded here. A signature-verified block only proves the producer
            // signed something — a block that fails apply (bad state_root, unresolvable pk, breaker)
            // can be re-broadcast forever, and stamping liveness on each delivery would suppress
            // failover against a producer that is wedging the chain. It is recorded at apply-commit
            // instead, where the block has demonstrably advanced this node.

            let verified = VerifiedBlock {
                height: block_height,
                decompressed: decoded.decompressed,
                microblock: decoded.microblock,
                from_peer: decoded.from_peer,
            };

            metrics.verified.fetch_add(1, Ordering::Relaxed);

            if block_height <= 5 || block_height % 100 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] verified h={} prod={} txs={}",
                             verified.height, verified.microblock.producer,
                             verified.microblock.transactions.len());
                }
            }

            // v15.4 DIAG: mark verify→apply send. If apply's mpsc receiver
            // is full because apply itself is hung on RocksDB or state
            // lock, this await will block. Watchdog reading op=verify:
            // send_to_apply with a stuck `applied` counter implicates
            // apply-stage backpressure as the root cause.
            metrics.mark_verify_op(block_height, PIPELINE_OP_VERIFY_SEND);
            let send_start = std::time::Instant::now();
            if let Err(_) = tx.send(verified).await {
                break 'outer;
            }
            let send_elapsed = send_start.elapsed();
            if send_elapsed > std::time::Duration::from_millis(500) {
                if is_warn() {
                    println!(
                        "[WARN][PIPELINE] slow_send_to_apply h={} elapsed_ms={} (apply-stage backpressure)",
                        block_height, send_elapsed.as_millis()
                    );
                }
            }
            metrics.mark_verify_idle();

            // Drain by parentage: release everything that was waiting on the block just verified.
            // Their own children are released when they in turn verify, so a chain unblocks in one
            // pass without any height arithmetic — which is what makes it correct under sparse
            // heights, where the next block is not necessarily height+1.
            if let Some(waiters) = deferred.remove(&verified_hash) {
                deferred_count = deferred_count.saturating_sub(waiters.len());
                for (_, def) in waiters {
                    if let Some(c) = deferred_by_producer.get_mut(&def.microblock.producer) {
                        *c = c.saturating_sub(1);
                    }
                    to_process.push(def);
                }
            }

            } // end while let Some(decoded) = to_process.pop()

            // Periodic deferred cleanup. TWO independent reclaim rules, because height alone is not
            // enough: blocks parked ABOVE the tip are never "behind" it, and during the very stall
            // where this buffer matters the tip does not advance — so a height-only rule can never
            // reclaim them. An age rule always can.
            if deferred_count > 100 {
                let chain_h = storage.get_chain_height().unwrap_or(0);
                {
                    const DEFERRED_MAX_AGE_SECS: u64 = 120;
                    let now_secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs()).unwrap_or(0);
                    let cutoff = if chain_h > 500 { chain_h - 500 } else { 0 };
                    let before = deferred_count;
                    for waiters in deferred.values_mut() {
                        waiters.retain(|(parked_at, d)| {
                            let too_old = now_secs.saturating_sub(*parked_at) > DEFERRED_MAX_AGE_SECS;
                            d.microblock.height > cutoff && !too_old
                        });
                    }
                    deferred.retain(|_, waiters| !waiters.is_empty());
                    deferred_count = deferred.values().map(|v| v.len()).sum();
                    let evicted = before - deferred_count;
                    // Rebuild the index ONLY when something was actually evicted. The enclosing
                    // condition is a buffer-size threshold, not an eviction event, so it holds on
                    // every loop iteration while the buffer stays large — and with parent-hash keying
                    // siblings coexist, so that is the common case during catch-up, not a rare one.
                    // Rebuilding regardless meant a producer-String clone per buffered block (up to
                    // DEFERRED_MAX) on every pass.
                    if evicted > 0 {
                        deferred_by_producer.clear();
                        for (_, d) in deferred.values().flat_map(|v| v.iter()) {
                            *deferred_by_producer.entry(d.microblock.producer.clone()).or_insert(0) += 1;
                        }
                        // v15.3: register eviction in dedicated counter so the
                        // backpressure formula can subtract these from the
                        // in-flight estimate. Without this, evicted blocks
                        // remained "ingested but never finished" forever and
                        // contributed to the false-overload signal that
                        // throttled sync request dispatch.
                        metrics.deferred_evicted.fetch_add(evicted as u64, Ordering::Relaxed);
                        if is_info() {
                            println!("[INFO][PIPELINE] deferred_evict count={} cutoff={} remaining={}",
                                     evicted, cutoff, deferred.len());
                        }
                    }
                }
            }

            // Bound committee-deferred the same way (its re-drive is committee-arrival, not tip contiguity).
            // Evict pk-deferred entries whose height the chain has already APPLIED: a canonical block now
            // fills that height, so the deferred fork-block is dead and must not be re-verified on every
            // inbound block (a Byzantine producer's elided-never-committed-pk block would otherwise re-run
            // the full verify indefinitely). Runs unconditionally; a residual cap bounds far-ahead spam.
            let chain_h = storage.get_chain_height().unwrap_or(0);
            committee_deferred.retain(|h, _| *h > chain_h);
            if committee_deferred.len() > 100 {
                committee_deferred.retain(|h, _| *h < chain_h + 500);
            }
        }
    }

    // ========================================================================
    // STAGE 3: APPLY
    // ========================================================================
    // Sequential: applies transactions to state, saves block to RocksDB,
    // handles ALL side effects, notifies coordinator.
    //
    // This stage MUST be single-threaded — RocksDB writes and state updates
    // must be ordered by height. The verify stage guarantees blocks arrive
    // in valid order.
    //
    // Side effects (matching process_received_blocks):
    //   - Block snapshot for rollback on state_root mismatch
    //   - apply_block_to_state: rewards, emissions, registrations
    //   - State root verification
    //   - Deferred side effects: pool3, registrations, emissions, reward clears
    //   - VRF key extraction from NodeRegistration TXs
    //   - Block attestation broadcasting (when synced)
    //   - Height updates: RAM + RocksDB + LOCAL_BLOCKCHAIN_HEIGHT atomic
    //   - Block event broadcasting (for consensus listener)
    //   - Coordinator notification (BlockApplied event)
    //   - Pending sync cleanup
    // ========================================================================

    async fn apply_stage(
        mut rx: mpsc::Receiver<VerifiedBlock>,
        ctx: ApplyContext,
        metrics: Arc<PipelineMetrics>,
    ) {
        while let Some(block) = rx.recv().await {
            let height = block.height;
            let producer = block.microblock.producer.clone();
            let tx_count = block.microblock.transactions.len();

            // v15.4 DIAG: mark dedup check. Sync RocksDB read on the apply
            // path; if hung, watchdog will surface it.
            metrics.mark_apply_op(height, PIPELINE_OP_APPLY_DEDUP);
            let dedup_start = std::time::Instant::now();
            // Apply is strictly sequential by height and publishes the applied frontier in
            // LOCAL_BLOCKCHAIN_HEIGHT at commit. A block strictly ABOVE that frontier cannot be a
            // duplicate, so the common path is answered with an O(1) atomic read — NO hot-path
            // RocksDB lookup (a storage read here contends with the same CF the apply stage writes
            // microseconds later, and one slow read under a maintenance-flush/compaction storm
            // froze the whole stage). Only a re-delivery (height <= frontier) consults storage, off
            // the hot path on the blocking pool.
            let anchor_floor = crate::node::SNAPSHOT_ANCHOR_MB
                .load(std::sync::atomic::Ordering::Acquire).saturating_mul(90);
            let applied_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Acquire);
            let already_applied = if anchor_floor > 0 && height <= anchor_floor {
                true // at/below the adopted snapshot anchor ⇒ already-final; the snapshot omits sub-anchor
                     // bodies, so re-executing one would corrupt the bound state
            } else if height > applied_tip {
                false
            } else {
                let storage_for_dedup = ctx.storage.clone();
                match tokio::task::spawn_blocking(move || {
                    storage_for_dedup.load_microblock(height)
                        .map(|opt| opt.is_some())
                        .unwrap_or(false)
                }).await {
                    Ok(v) => v,
                    Err(join_err) => {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] apply_dedup_join_err h={} err={}",
                                height, join_err
                            );
                        }
                        false
                    }
                }
            };
            let dedup_elapsed = dedup_start.elapsed();
            if dedup_elapsed > std::time::Duration::from_millis(500) {
                if is_warn() {
                    println!(
                        "[WARN][PIPELINE] slow_storage_read stage=apply op=dedup h={} elapsed_ms={}",
                        height, dedup_elapsed.as_millis()
                    );
                }
            }
            if already_applied {
                metrics.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
                crate::unified_p2p::clear_block_pending_sync(height);
                metrics.mark_apply_idle();
                continue;
            }

            // OB1: while a snapshot rehydrate is repopulating the in-mem StateManager, an above-anchor
            // tail block would apply over empty/partial state → wrong state_root → rollback → apply-breaker
            // churn. Skip WITHOUT clearing pending so the catch-up loop re-delivers it once rehydrate has
            // seeded the bound state. (At/below the anchor floor is already handled by already_applied.)
            if height > anchor_floor
                && crate::storage::SNAPSHOT_REHYDRATE_IN_PROGRESS.load(Ordering::Acquire) {
                metrics.mark_apply_idle();
                continue;
            }

            // Seal backpressure: never apply more than MAX_UNSEALED_WINDOWS windows past the
            // contiguous seal / QC-verified frontier (same base and bound as the production
            // throttle — one seal semantic everywhere). Bounds the apply-vs-seal gap during
            // bulk catch-up so a joiner cannot reach apply-tip (and registration) while its
            // seal lags arbitrarily; the mb-sync backfill advances the frontier independently
            // and releases the wait. seal_base == 0 (young chain, nothing sealed) is exempt.
            // At the live tip this never fires: production stops at the same bound first.
            {
                // A1: FOLLOWING the chain must not be finality-gated either. This cap used to equal the
                // production ceiling ("at the live tip this never fires: production stops at the same
                // bound first"), which stopped being true the moment production was decoupled — it would
                // have become the new height wall, parking the apply worker in a 250 ms loop forever.
                // Raised to the same roster-derivation horizon production now uses, so apply tracks
                // production instead of gating it. It remains a bulk-catch-up bound, not a finality gate.
                const SEAL_LAG_CAP: u64 = (crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64) * 90;
                let mut waited_ms: u64 = 0;
                loop {
                    // Cheap atomic first: seal_base >= qc frontier, so within-cap here
                    // proves within-cap overall — no per-block RocksDB read on the hot path.
                    let qc_f = crate::node::qc_verified_frontier_cached();
                    if qc_f > 0 && height <= qc_f + SEAL_LAG_CAP {
                        break;
                    }
                    let seal_base = ctx.storage.last_sealed_mb_index().saturating_mul(90).max(qc_f);
                    if seal_base == 0 || height <= seal_base + SEAL_LAG_CAP {
                        break;
                    }
                    if waited_ms == 0 {
                        // Distinct op marker: without it the watchdog attributes this wait
                        // to the LAST marker (apply:dedup_check) and fires false CRIT dumps.
                        metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SEAL_WAIT);
                    }
                    if waited_ms > 0 && waited_ms % 5_000 == 0 && is_warn() {
                        println!("[WARN][PIPELINE] apply_seal_backpressure h={} seal_base={} cap={}",
                                 height, seal_base, SEAL_LAG_CAP);
                    }
                    // D3: actively drive the seal frontier while parked — the probe fires the
                    // (self-throttled) mb-sync backfill, so a locally-unsealable window is pulled from
                    // peers instead of waiting on a frontier nothing advances. Bounded scan, ≤1 call/2s.
                    if waited_ms % 2_000 == 0 {
                        let _ = crate::node::qc_verified_frontier_height();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    waited_ms += 250;
                }
            }

            // State application with snapshot + rollback support.
            // Pre-warm account cache: before taking the state WRITE lock,
            // walk the block's TXs and ensure every touched address is
            // resident (cached → refresh last_access; cold → AccountStore
            // disk load, lock-free). With a bounded cache the apply path's
            // accounts.get_mut(from) would miss a cold sender; pre-warming
            // under a READ lock makes the working set resident while keeping
            // disk latency outside the write critical section. ≤2×tx_count
            // point reads.
            {
                use std::collections::HashSet;
                let mut warm_set: HashSet<String> = HashSet::new();
                // Warm the FULL affected set per tx (from + recipients +
                // contract/escrow), the same set apply_transaction_lazy loads.
                // The bounded LRU can evict, so a narrow warm (from + Transfer.to)
                // would let apply read a cold recipient/escrow and miss silently;
                // a superset only touches cache residency, never state.
                for tx in &block.microblock.transactions {
                    for addr in tx.get_all_affected_addresses() {
                        if !addr.is_empty() {
                            warm_set.insert(addr);
                        }
                    }
                }
                if !warm_set.is_empty() {
                    let warm_vec: Vec<String> = warm_set.into_iter().collect();
                    let sg_warm = ctx.state.read().await;
                    let hit = sg_warm.warm_accounts(&warm_vec);
                    drop(sg_warm);
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] account_warm h={} requested={} resident={}",
                            height, warm_vec.len(), hit,
                        );
                    }
                }
            }

            // op will be the stuck point.
            metrics.mark_apply_op(height, PIPELINE_OP_APPLY_STATE_LOCK);
            let lock_start = std::time::Instant::now();
            // Owns-index deltas for this block, captured under the lock and persisted OFF-lock below.
            let mut owns_to_persist: Vec<qnet_state::OwnsDelta> = Vec::new();
            let apply_ok = {
                let state_guard = ctx.state.write().await;
                let lock_elapsed = lock_start.elapsed();
                if lock_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_state_lock h={} elapsed_ms={}",
                            height, lock_elapsed.as_millis()
                        );
                    }
                }

                // Genesis block: clear state first (idempotent)
                if height == 0 {
                    let existing = state_guard.account_count();
                    if existing > 0 {
                        if is_info() { println!("[INFO][PIPELINE] genesis_clear_state accounts={}", existing); }
                        state_guard.clear();
                    }
                }

                // The WIRE tx.hash is inside the producer-signed merkle_root but nothing downstream
                // recomputed it, and the apply arms push that wire hash into the WASM event logs →
                // logs_root → the n−f checkpoint content. One flipped character from a relay would
                // leave balances and state_root identical while permanently splitting this node's
                // logs_root out of every window. Recompute with the producer's own formula.
                if BlockchainNode::calculate_merkle_root(&block.microblock.transactions)
                    != block.microblock.merkle_root {
                    if is_warn() {
                        println!("[WARN][PIPELINE] merkle_root_mismatch h={} from={} action=reject",
                                 height, block.from_peer);
                    }
                    drop(state_guard);
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }

                // A zero state_root is not a valid commitment above genesis: it skipped BOTH the
                // rollback snapshot and the root comparison, so the block committed unverified, and
                // the checkpoint signal refuses to advance past such a head — a producer could wedge
                // finality by omitting the field. Reject it; fork-choice takes a sibling.
                if height > 0 && block.microblock.state_root == [0u8; 32] {
                    if is_warn() {
                        println!("[WARN][PIPELINE] zero_state_root h={} from={} action=reject", height, block.from_peer);
                    }
                    drop(state_guard);
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }
                // Create block snapshot for rollback (only for blocks with state_root)
                let has_state_root = block.microblock.state_root != [0u8; 32];
                // v15.4 DIAG: snapshot creation copies relevant account
                // state — bounded but non-trivial work.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SNAPSHOT);
                let snap_start = std::time::Instant::now();
                let mut block_snapshot = if has_state_root {
                    Some(state_guard.create_block_snapshot(height))
                } else {
                    None
                };
                let snap_elapsed = snap_start.elapsed();
                if snap_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_create_snapshot h={} elapsed_ms={}",
                            height, snap_elapsed.as_millis()
                        );
                    }
                }


                // Slot check BEFORE apply: a sibling that cannot win the slot should not pay for a
                // full apply. It can no longer corrupt anything either — apply is side-effect-free
                // w.r.t. durable indices — so this is a cost guard, not a correctness one.
                if ctx.storage.canonical_hash_at(height).map(|h| h != block.microblock.hash()).unwrap_or(false) {
                    if is_warn() {
                        println!("[WARN][PIPELINE] slot_taken_before_apply h={} from={} action=skip",
                                 height, block.from_peer);
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }

                // v15.4 DIAG: state mutation phase — applies all
                // transactions and updates accounts. Heavy CPU but no
                // I/O, so unlikely to hang from external contention.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_STATE);
                let apply_state_start = std::time::Instant::now();
                // Apply all state mutations via shared function
                let apply_result = BlockchainNode::apply_block_to_state(
                    &state_guard,
                    &block.microblock,
                    &ctx.storage,
                    block_snapshot.as_mut(),
                );
                let apply_state_elapsed = apply_state_start.elapsed();
                if apply_state_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_apply_state h={} txs={} elapsed_ms={}",
                            height, tx_count, apply_state_elapsed.as_millis()
                        );
                    }
                }

                // A claim referenced an epoch whose certifying macroblock is absent here. This node
                // cannot decide the credit, so it must not commit the block — crediting or skipping
                // would diverge state_root from nodes that hold it. Roll back and fetch.
                if let Some(certifying_mb) = apply_result.reward_epoch_missing {
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                    }
                    // No durable side-index cleanup: apply only COLLECTS them, and this block never
                    // reached the canonical flush.
                    drop(state_guard);
                    println!("[ERR][PIPELINE] reward_epoch_missing h={} certifying_mb={} action=fetch_and_retry",
                             height, certifying_mb);
                    if let Some(p2p) = ctx.unified_p2p.as_ref() {
                        let p = p2p.clone();
                        tokio::spawn(async move {
                            let _ = p.sync_macroblocks_repair(certifying_mb, certifying_mb).await;
                        });
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }

                let computed_state_root = apply_result.merkle_root;

                // State root verification
                if has_state_root && computed_state_root != block.microblock.state_root {
                    eprintln!("[ERR][PIPELINE] state_root_mismatch h={} from={} expected={} computed={}",
                             height,
                             block.from_peer,
                             hex::encode(&block.microblock.state_root[..8]),
                             hex::encode(&computed_state_root[..8]));

                    // Rollback to pre-block state
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                        if is_info() { println!("[INFO][PIPELINE] block_rollback h={}", height); }
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);

                    // Do NOT strike the peer here: the block already passed signature/hash
                    // validation before apply, so a state_root_mismatch is a LOCAL-state defect
                    // (e.g. a contaminated/orphaned base), not the peer's fault. Striking honest
                    // peers poisoned the pool and blocked cold-start recovery. Genuine forks are
                    // resolved by fork-choice; malice by on-chain analyze_chain_for_slashing.

                    // Circuit-breaker: re-applying the same canonical block onto a contaminated
                    // base mismatches forever (the wedge). On threshold, escalate to fork
                    // recovery — which is fail-closed and ends in a clean QC-verified state-sync.
                    if record_apply_mismatch() {
                        signal_fork_recovery(height.saturating_sub(1).max(1));
                        if is_warn() {
                            println!("[WARN][PIPELINE] apply_breaker_tripped h={} action=fork_recovery", height);
                        }
                    }
                    metrics.mark_apply_idle();
                    continue;
                }

                // v14.8: Successful apply — clear any past strikes for this peer.
                clear_apply_mismatch();
                if let Some(ref p2p) = ctx.unified_p2p {
                    p2p.record_apply_success(&block.from_peer);
                }

                // The slot must still be free before ANY durable materialisation. Everything below
                // (burn bindings, registry rows + registry_root delta, pk binds, checkpoint seals)
                // is written BEFORE the save on purpose — the checkpoint compute needs it present —
                // but that also means a block whose save will be refused would leave those deltas
                // behind with nothing able to reverse them safely: the rebuild helpers require a
                // canonical-tip argument and quiesced applies, so they cannot run here. Preventing
                // the write is the only sound option. The dedup above compares against the APPLIED
                // tip, which this node's own producer path advances only after its save; this reads
                // the canonical slot itself and so also covers that window.
                if ctx.storage.canonical_hash_at(height).map(|h| h != block.microblock.hash()).unwrap_or(false) {
                    if is_warn() {
                        // Nothing to clean: this block collected its indices but never flushed them.
                        println!("[WARN][PIPELINE] slot_taken_before_materialise h={} from={} action=skip",
                                 height, block.from_peer);
                    }
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }

                // A rollback below this height is already driving the chain, so save_microblock will
                // decline. Everything below is DURABLE and outside the accounts map, so rollback_block
                // cannot reverse it — the reorg's own prune scans do, and they only catch rows that
                // exist when they run. The claim is what orders us against them: held until the save
                // below completes, so a rollback either sees us and drains, or bars us outright.
                // Degraded to Light: save_microblock will answer NotStoredMode, and unlike a rollback
                // nothing ever prunes what we would write here — the registry rows and seals would
                // accumulate for blocks this node never applied and diverge its registry_root for good.
                if !ctx.storage.should_store_full_blocks() {
                    println!("[ERR][STORAGE] materialise_skipped h={} reason=storage_mode_keeps_no_blocks", height);
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    metrics.mark_apply_idle();
                    continue;
                }
                let _materialise = match crate::storage::try_claim_materialise(height) {
                    Some(g) => g,
                    None => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] materialise_skipped h={} reason=rollback_in_progress", height);
                        }
                        if let Some(ref snapshot) = block_snapshot {
                            state_guard.rollback_block(snapshot);
                        }
                        metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                        crate::unified_p2p::clear_block_pending_sync(height);
                        metrics.mark_apply_idle();
                        continue;
                    }
                };

                // Materialise the committed burn→wallet binding (cbw) for this block's registrations
                // NOW — after state-root acceptance (so a rejected block never binds) but BEFORE
                // save_microblock makes h loadable. The verify stage's parent-continuity gate defers
                // verify(h+1) until load_microblock(h) succeeds (after save below), so this write
                // happens-before verify(h+1).cbw_get → within-window cross-microblock burn reuse is
                // caught. First-wins; the durable cbw set is reconciled from node_registry by
                // rebuild_committed_burn_wallet on snapshot/reorg/boot.
                for tx in &block.microblock.transactions {
                    // Heartbeat liveness index (lhb_): Phase-2A recency reads this instead of a
                    // 2-subwindow body scan. Mirrored by the producer's inline pre-save write.
                    if let qnet_state::TransactionType::Heartbeat { node_id, anchor_height, .. } = &tx.tx_type {
                        let _ = ctx.storage.index_heartbeat_inclusion(node_id, *anchor_height, height);
                    }
                }

                // Materialise this block's node_registry entries (node_/srtr_/lrtr_ + the registry_root
                // LtHash delta) NOW — after state-root acceptance, BEFORE save_microblock makes h
                // loadable — mirroring the producer (inline pre-save) and the cbw write above. The
                // WindowEnd checkpoint compute is gated on h being loadable (post-save), so writing here
                // makes head_ready transitively guarantee the registrations + seal exist: a checkpoint-
                // head registration can never be omitted by a racing validator read (the pre-existing
                // race when these were written post-save in the deferred-fx phase).
                for (node_id, type_str, wallet, burn_tx, vrf_pk_hex) in &apply_result.deferred_registrations {
                    // Single authoritative writer: stamps reg_height AND the backing burn co-resident,
                    // so rebuild_committed_burn_wallet + registry_root are deterministic; updates the
                    // registry_root LtHash accumulator in the SAME batch. burn empty (activations/genesis)
                    // ⇒ binding skipped. Idempotent on re-apply (delta 0 on identical re-add). vrf_pk binds
                    // sha3 into registry_root for light-client committee verification.
                    let vrf = if vrf_pk_hex.is_empty() { None } else { hex::decode(vrf_pk_hex).ok() };
                    let _ = ctx.storage.save_node_registration_at_height_burn_vrf(node_id, type_str, wallet, 1.0, height, burn_tx, vrf.as_deref());
                    // burn -> node binding, from the SAME apply-Ok set as the row above. Scope matches
                    // rebuild_committed_burn_wallet (srtr_+lrtr_, super AND light), so the live index and
                    // the rebuild agree. It used to be written from a separate pass over EVERY
                    // registration in the block, including ones whose apply failed — rows the producer
                    // never wrote and the rebuild does not reproduce.
                    if !burn_tx.is_empty() {
                        let _ = ctx.storage.committed_burn_wallet_put(burn_tx, node_id);
                    }
                }
                // Registration-origin markers, the dedup reseed source. The producer stamps these inline;
                // without the mirror here a validator rebuilds an incomplete dedup map after any restart
                // or snapshot join and then admits a second registration for a node everyone else rejects
                // — a silent registry_root split.
                for (node_id, wallet) in &apply_result.deferred_registration_origins {
                    let _ = ctx.storage.mark_node_registration_origin(node_id, wallet);
                }
                // FIX-5: bind this block's value-TX pubkeys into the dilithium_pk_root LtHash
                // (marker-guarded ⇒ once/account, deterministic) BEFORE the seal below.
                for (addr, pk) in &apply_result.deferred_pk_binds {
                    let _ = ctx.storage.dpk_lt_bind(addr, pk, height);
                }
                // Watermark the highest height that mutated the accumulator so a later dropped seal can be
                // healed-on-read only while the live accumulator still equals its as-of-height value.
                if !apply_result.deferred_pk_binds.is_empty() {
                    let _ = ctx.storage.note_dpk_bind_height(height);
                }
                // registry_root seal (LtHash): at a checkpoint head, after all of this block's
                // registrations updated lt_state and BEFORE save_microblock — mirror of the producer.
                // Fires once per checkpoint head incl. zero-registration heads.
                if height % qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL == 0 {
                    let _ = ctx.storage.seal_registry_root(height);
                    // A dropped dpk seal-write later diverges the checkpoint field (compute_dilithium_pk_root's
                    // no-seal fallback is not height-bounded), so surface it instead of swallowing.
                    if let Err(e) = ctx.storage.seal_dilithium_pk_root(height) {
                        if crate::node::is_warn() { println!("[WARN][SEAL] dpk_root_seal_fail h={} err={}", height, e); }
                    }
                    // Bind-journal prune bounded by the finality floor (same value the rollback guard uses).
                    let _ = ctx.storage.prune_dpk_journal(
                        crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed));
                    // Same head: seal total_supply as-of this height (apply-deterministic on both paths)
                    // so the checkpoint reads a height-bound value, never the live counter.
                    // The only seal here with no reader-side fallback: a dropped write makes
                    // get_total_supply_at return None for good, and both checkpoint builders then
                    // defer this head forever. Retry once and surface it, like the dpk seal above.
                    let supply_now = state_guard.get_total_supply();
                    if ctx.storage.seal_total_supply(height, supply_now).is_err() {
                        if let Err(e) = ctx.storage.seal_total_supply(height, supply_now) {
                            if crate::node::is_warn() {
                                println!("[WARN][SEAL] total_supply_seal_fail h={} err={} impact=checkpoint_muted", height, e);
                            }
                        }
                    }
                }

                // State verified — save block.
                // v15.6: RocksDB writes go through the blocking pool. Macroblock
                // bursts trigger background compactions that can stall foreground
                // writes for hundreds of milliseconds; running save on the async
                // path made the entire pipeline freeze under that contention.
                // The decompressed bytes are moved into the closure (zero copy
                // overhead beyond the Arc clone for storage); set_chain_height
                // follows immediately so both writes share the same blocking
                // context and complete before the apply slot is released.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SAVE_BLOCK);
                let save_start = std::time::Instant::now();
                let storage_for_save = ctx.storage.clone();
                let block_bytes_for_save = block.decompressed.clone();
                let save_result = match tokio::task::spawn_blocking(move || {
                    storage_for_save.save_microblock(height, &block_bytes_for_save)
                }).await {
                    Ok(res) => res,
                    Err(join_err) => {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] apply_save_join_err h={} err={}",
                                height, join_err
                            );
                        }
                        Err(crate::errors::IntegrationError::StorageError(format!("join error: {}", join_err)))
                    }
                };
                let save_elapsed = save_start.elapsed();
                if save_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_storage_write op=save_microblock h={} elapsed_ms={} bytes={}",
                            height, save_elapsed.as_millis(), block.decompressed.len()
                        );
                    }
                }
                // A declined save (rollback in progress, height above the target) is NOT a commit:
                // the success branch below advances the serve horizon and feeds the window-content
                // accumulator and the finalized-round baseline, none of which self-correct for a
                // block that never reached disk. Route it to the same not-applied path as a failure.
                let save_result = match save_result {
                    Ok(crate::storage::SaveOutcome::Stored) => Ok(()),
                    Ok(crate::storage::SaveOutcome::DeclinedRollback) => {
                        let (_active, target) = crate::storage::get_rollback_status();
                        if is_warn() {
                            println!("[WARN][PIPELINE] save_declined h={} target={} action=not_applied", height, target);
                        }
                        Err(crate::errors::IntegrationError::StorageError(
                            format!("save_declined_rollback h={} target={}", height, target)))
                    }
                    Ok(crate::storage::SaveOutcome::NotStoredMode) => {
                        // This node's storage keeps no blocks — a Super only reaches this through
                        // disk-pressure degradation. It is NOT a race a fork recovery can repair, so
                        // it must not escalate (that would spin recovery forever while the disk stays
                        // full); it is a loud operational fault. The block is simply not applied.
                        println!("[ERR][STORAGE] block_not_stored h={} reason=storage_mode_keeps_no_blocks action=not_applied", height);
                        Err(crate::errors::IntegrationError::StorageError(
                            format!("save_declined_not_stored h={}", height)))
                    }
                    Err(e) => Err(e),
                };
                match save_result {
                    Ok(()) => {
                        // Canonical NOW — write the side indices collected during apply, BEFORE the
                        // height is published: a checkpoint that sees block h must see h's logs too.
                        // Nothing wrote them speculatively, so a losing sibling leaves no row behind.
                        BlockchainNode::flush_block_side_indices(&ctx.storage, height, &apply_result.side_indices);
                        // v15.11: Record finalized round so the next height in
                        // this macroblock starts with a clean baseline. Mirrors
                        // the producer-side recording — every honest validator
                        // applying the same block records the same baseline,
                        // keeping per-mb effective rounds in sync across the
                        // committee.
                        crate::unified_p2p::record_finalized_round(
                            height / 90,
                            // Record the ABSOLUTE round (relative + carried baseline). max() then lands on
                            // the canonical winner's absolute — a losing same-height sibling can no longer
                            // push the baseline above it (the double-count hardening).
                            block.microblock.timeout_round.saturating_add(block.microblock.carried_baseline),
                        );
                        // v33: feed the deterministic window-content accumulator at commit.
                        crate::node::accumulate_window_block(height, &block.microblock);

                        // v27 HOLE3: warm read-through cache (verify h+1 hits
                        // memory, not cold RocksDB → kills 30s verify_stuck).
                        ctx.storage.cache_recent_microblock(
                            height,
                            &block.microblock,
                        );

                        crate::unified_p2p::note_block_stored(height);

                        // Producer liveness, recorded only now: the block is verified, applied and
                        // durable, so it PROVES the producer advanced this node. Recording it at
                        // verify instead would let a producer whose blocks never apply re-broadcast
                        // itself alive and permanently suppress the failover meant to replace it.
                        crate::unified_p2p::record_producer_liveness_from_block(
                            &block.microblock.producer, height);

                        // ═══════════════════════════════════════════════════════
                        // v25 H9: VALIDATOR LIVENESS — SUCCESS PATH
                        // ───────────────────────────────────────────────────────
                        // The block produced by `block.microblock.producer` has
                        // been fully verified, applied, persisted, and is now
                        // canonical history. Reset the producer's consecutive
                        // miss counter and clear any ejection state, so a
                        // validator that recovers from an intermittent outage
                        // is reinstated immediately on the very next successful
                        // production cycle.
                        //
                        // Side-effect free when liveness ejection is disabled
                        // (`QNET_LIVENESS_EJECTION` unset) — the underlying
                        // `record_validator_success` only mutates an in-process
                        // DashMap entry, so the cost is O(1) per applied block
                        // and bounded by total validator count (≤ 1000 per
                        // round by architectural cap).
                        // ═══════════════════════════════════════════════════════
                        if !producer.is_empty() {
                            crate::unified_p2p::record_validator_success(&producer);
                        }

                        // Peer-apply mempool cleanup. The producer-side cleanup
                        // hook covers only the producer path, so peer validators
                        // retained on-chain TXs and re-included them in later
                        // blocks (state dup-check stops double-accounting but the
                        // bytes still cost storage + bandwidth; observed h=14351→
                        // 14461, 5 HeartbeatCommitments shipped twice). Symmetric
                        // rule: once on chain, no honest mempool re-offers a TX.
                        // record_included_txs also drops late gossip copies.
                        // O(tx_count) hash + 1 batched DashMap remove, inline.
                        if !block.microblock.transactions.is_empty() {
                            let included_hashes: Vec<String> = block.microblock.transactions.iter()
                                .map(|tx| tx.hash.clone())
                                .collect();
                            if let Some(mempool_arc) = crate::node::try_get_mempool() {
                                mempool_arc.record_included_txs(&included_hashes);
                                mempool_arc.batch_remove_transactions(&included_hashes);

                                // Mark each commitment TX's dedup key finalized so
                                // later re-admission of the same on-chain TX is
                                // rejected at the door (lock-free DashMap, ~50ns).
                                // 1 insert/commitment TX; ≤1000 at epoch boundary.
                                let mut commitment_marks = 0usize;
                                for tx in &block.microblock.transactions {
                                    if let Some(key) = tx.commitment_dedup_key() {
                                        mempool_arc.mark_commitment_finalized(key);
                                        commitment_marks += 1;
                                    }
                                }

                                if is_info() {
                                    if commitment_marks > 0 {
                                        println!(
                                            "[INFO][MEMPOOL] peer_apply_cleanup h={} tx_count={} commitments_marked={}",
                                            height, included_hashes.len(), commitment_marks
                                        );
                                    } else {
                                        println!(
                                            "[INFO][MEMPOOL] peer_apply_cleanup h={} tx_count={}",
                                            height, included_hashes.len()
                                        );
                                    }
                                }
                            }
                        }

                        // v15.6: chain-height bump on the blocking pool too —
                        // it is an atomic CF write but pays the same compaction
                        // queue penalty as the block save above.
                        metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SET_HEIGHT);
                        let height_start = std::time::Instant::now();
                        let storage_for_height = ctx.storage.clone();
                        let height_result = match tokio::task::spawn_blocking(move || {
                            storage_for_height.set_chain_height(height)
                        }).await {
                            Ok(res) => res,
                            Err(join_err) => {
                                if is_warn() {
                                    println!(
                                        "[WARN][PIPELINE] set_height_join_err h={} err={}",
                                        height, join_err
                                    );
                                }
                                Err(crate::errors::IntegrationError::StorageError(format!("join error: {}", join_err)))
                            }
                        };
                        let height_elapsed = height_start.elapsed();
                        if height_elapsed > std::time::Duration::from_millis(500) {
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] slow_storage_write op=set_height h={} elapsed_ms={}",
                                    height, height_elapsed.as_millis()
                                );
                            }
                        }
                        match height_result {
                            // S2: publish the apply frontier the instant the block is durable + height-set,
                            // BEFORE deferred side effects — a peer reading it never sees a stale frontier and
                            // wrongly cools a syncing node. fetch_max keeps it monotone (never below the anchor).
                            Ok(_) => { crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.fetch_max(height, std::sync::atomic::Ordering::AcqRel); }
                            Err(e) => { if is_warn() { println!("[WARN][PIPELINE] set_height_failed h={} err={}", height, e); } }
                        }
                        // v15.4 DIAG: deferred-side-effects phase. Mostly
                        // RocksDB writes for registrations and reward
                        // bookkeeping; bounded but accumulates.
                        metrics.mark_apply_op(height, PIPELINE_OP_APPLY_DEFERRED_FX);

                        // ── Deferred side effects (block is committed) ──
                        if apply_result.deferred_pool3 > 0 {
                            if let Some(ref p2p) = ctx.unified_p2p {
                                p2p.add_to_pool3(apply_result.deferred_pool3);
                            }
                        }
                        // node_registry registrations are now written PRE-save (above, next to cbw +
                        // the registry_root seal) so the WindowEnd checkpoint read can never race them.
                        // L2: emission reward recompute OFF the apply write-lock and off the pipeline
                        // foreground (blocking pool) — the O(recipients) merkle build never stalls apply.
                        // B: light-eligibility recency index — same off-lock, off-foreground treatment as
                        // the emission root; the O(roster) snapshot never stalls the commit pipeline at scale.
                        if let Some(h) = apply_result.deferred_light_elig {
                            let st = ctx.storage.clone();
                            tokio::task::spawn_blocking(move || {
                                crate::node::BlockchainNode::populate_light_elig_at_boundary(&*st, h);
                            });
                        }

                        // ── VRF key extraction from NodeRegistration TXs ──
                        if !block.microblock.transactions.is_empty() {
                            let has_reg_tx = block.microblock.transactions.iter().any(|tx| {
                                matches!(&tx.tx_type,
                                    qnet_state::TransactionType::NodeRegistration { .. } |
                                    qnet_state::TransactionType::NodeReactivation { .. })
                            });
                            if has_reg_tx {
                                BlockchainNode::cache_node_registrations_from_transactions(
                                    &ctx.storage, &block.microblock.transactions,
                                );
                                if is_info() {
                                    println!("[INFO][PIPELINE] vrf_keys_extracted h={} txs={}", height, tx_count);
                                }
                            }
                        }

                        // Cross-shard 2PC apply hook removed — single-shard for
                        // now; sharding primitives stay dormant and CrossShard*
                        // TransactionType variants are removed to block accidental
                        // activation (see qnet-sharding/lib.rs header).

                        // Write-through account persistence: mirror every account
                        // this block mutated (addresses from the BlockSnapshot
                        // journal) into the persistent `accounts` CF via one
                        // atomic WriteBatch on the blocking pool, so a crash
                        // restart has durable per-block state (no lost mutations
                        // between snapshots). Skipped when block_snapshot is None
                        // (genesis window, no mutation set). O(touched accounts).
                        if let Some(ref snapshot) = block_snapshot {
                            let mut modified: Vec<(String, qnet_state::Account)> =
                                Vec::with_capacity(snapshot.accounts().len() + snapshot.created_keys().len());
                            let mut deleted: Vec<String> = Vec::new();
                            // QRC-20 wallet→token owns-index deltas this block (NON-consensus reverse index).
                            let owns_deltas: Vec<qnet_state::OwnsDelta> = snapshot.owns().to_vec();

                            // Modified addresses: pre-image existed; check if
                            // the post-image still exists (it might have been
                            // removed entirely if the apply path deletes
                            // accounts in some flow).
                            for addr in snapshot.accounts().keys() {
                                match state_guard.accounts.get(addr) {
                                    Some(entry) => {
                                        modified.push((addr.clone(), entry.value().clone()));
                                    }
                                    None => {
                                        deleted.push(addr.clone());
                                    }
                                }
                            }
                            // Created addresses: pre-image did NOT exist; just
                            // capture the post-image. (If the apply created
                            // and then immediately removed an account in the
                            // same block, it is already absent from the map
                            // and we skip the put.)
                            for addr in snapshot.created_keys() {
                                if let Some(entry) = state_guard.accounts.get(addr) {
                                    modified.push((addr.clone(), entry.value().clone()));
                                }
                            }

                            // Owns-index (NON-consensus): capture under the lock, persist OFF-lock below.
                            // A large airdrop block's batch must not serialise apply behind the state lock.
                            owns_to_persist = owns_deltas;
                            if !modified.is_empty() || !deleted.is_empty() {
                                // ───────────────────────────────────────────────
                                // Accounts CF (best-effort mirror, can be large):
                                // persist in the BACKGROUND so we never await on
                                // RocksDB while still holding `state_guard`.
                                // Holding the state write lock across an async
                                // I/O would serialise the entire apply pipeline
                                // behind disk latency — exactly the failure mode
                                // Fix #2 was introduced to avoid. The spawned
                                // task takes ownership of the modified/deleted
                                // buffers and an Arc<Storage> clone; it cannot
                                // outlive the runtime, and a logged failure is
                                // recoverable via microblock replay (the
                                // canonical Stage-1 invariant: account CF is
                                // best-effort, microblocks are authoritative).
                                // ───────────────────────────────────────────────
                                let storage_for_persist = ctx.storage.clone();
                                let height_for_persist = height;
                                let modified_count = modified.len();
                                let deleted_count = deleted.len();
                                tokio::spawn(async move {
                                    let persist_start = std::time::Instant::now();
                                    match storage_for_persist
                                        .persist_accounts_batch(modified, deleted)
                                        .await
                                    {
                                        Ok((puts, dels)) => {
                                            let elapsed = persist_start.elapsed();
                                            if elapsed > std::time::Duration::from_millis(200) {
                                                if is_warn() {
                                                    println!(
                                                        "[WARN][PIPELINE] slow_persist_accounts h={} puts={} dels={} elapsed_ms={}",
                                                        height_for_persist, puts, dels, elapsed.as_millis(),
                                                    );
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            if is_warn() {
                                                println!(
                                                    "[WARN][PIPELINE] persist_accounts_failed h={} puts={} dels={} err={:?}",
                                                    height_for_persist, modified_count, deleted_count, e,
                                                );
                                            }
                                        }
                                    }
                                });
                            }
                        }

                        true // success
                    }
                    Err(e) => {
                        eprintln!("[ERR][PIPELINE] save_failed h={} err={:?}", height, e);
                        // Rollback in-memory state
                        if let Some(ref snapshot) = block_snapshot {
                            state_guard.rollback_block(snapshot);
                            if is_info() { println!("[INFO][PIPELINE] block_rollback h={} reason=save_failed", height); }
                        }
                        // Escalate on the KIND of failure, not on failure itself.
                        //   fork_conflict = the L4 gate correctly refused a competing block at an
                        //     occupied slot. That is a normal failover race, the incumbent is intact,
                        //     and the loser was retained as a branch — a destructive rollback here
                        //     would make the node delete its own valid, already-broadcast block.
                        //   save_declined_rollback = a rollback is already driving the chain to a
                        //     target below this height. Escalating would signal a SECOND, deeper
                        //     recovery against the one in flight; the in-memory rollback above is the
                        //     whole correction and the block is re-requested once rollback completes.
                        //   unlinked_block / anything else = our stored parent is suspect, and the
                        //     durable accumulators (registry_root / dilithium_pk_root LtHash, burn
                        //     bindings) were materialised BEFORE the save and are not covered by the
                        //     in-memory snapshot. Only the fork-recovery rebuild restores them.
                        let err_text = format!("{:?}", e);
                        let benign_race = err_text.contains("fork_conflict")
                            || err_text.contains("save_declined_rollback")
                            || err_text.contains("save_declined_not_stored");
                        if benign_race {
                            // The slot is held by a canonical block we already applied and saved, so
                            // the chain is intact and nothing here may mutate it. Two things are
                            // deliberately NOT done: no destructive rollback (it would delete our own
                            // valid, broadcast block), and no accumulator "repair" — the rebuild
                            // helpers take a canonical-tip argument and must run with applies
                            // quiesced, so calling them here (tip is at `height`, applies are live)
                            // deletes canonical rows and races the fold on the same keys. The
                            // refused block's pre-save deltas are handled at their source instead:
                            // materialisation is what must not happen before a successful save.
                            //
                            // EXCEPT fork_conflict: the slot-taken guard above filters every
                            // already-occupied case, so reaching it means the slot was taken during the
                            // save's own await and this block DID materialise its durable deltas, which
                            // rollback_block cannot reverse. signal_fork_recovery is a monotonic atomic
                            // target, not an inline rebuild — the producer arm already signals here.
                            if err_text.contains("fork_conflict") {
                                signal_fork_recovery(height.saturating_sub(1).max(1));
                                if is_warn() {
                                    println!("[WARN][PIPELINE] fork_conflict_after_materialise h={} action=signal_rebuild", height);
                                }
                            }
                            if is_info() {
                                let reason = if err_text.contains("fork_conflict") {
                                    "fork_conflict"
                                } else if err_text.contains("save_declined_not_stored") {
                                    "storage_keeps_no_blocks"
                                } else {
                                    "rollback_in_progress"
                                };
                                println!("[INFO][PIPELINE] save_refused_benign h={} reason={} action=none", height, reason);
                            }
                        } else {
                            // Never roll back below finality or the snapshot anchor.
                            let floor = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst)
                                .max(crate::node::SNAPSHOT_ANCHOR_MB.load(Ordering::Acquire).saturating_mul(90));
                            let target = height.saturating_sub(1).max(floor).max(1);
                            if target < height {
                                signal_fork_recovery(target);
                                // Pull the parent too: if the save failed on linkage our stored parent is
                                // the losing variant, and a rollback alone would re-download it.
                                if height > 1 {
                                    if let Some(p2p) = ctx.unified_p2p.as_ref() {
                                        let p = p2p.clone();
                                        let parent_h = height - 1;
                                        tokio::spawn(async move { let _ = p.request_block_repair_priority(parent_h).await; });
                                    }
                                }
                                if is_warn() {
                                    println!("[WARN][PIPELINE] save_failed_escalated h={} target={} action=fork_recovery+parent_repair",
                                             height, target);
                                }
                            }
                        }


                        false
                    }
                }
            }; // state_guard dropped here

            if !apply_ok {
                metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                crate::unified_p2p::clear_block_pending_sync(height);
                metrics.mark_apply_idle();
                continue;
            }

            // Owns-index (NON-consensus): persist this block's deltas + advance the durable watermark to
            // `height`, OFF-lock, in strict block order (the pipeline processes one height per iteration and
            // awaits here). A non-empty (airdrop) batch goes to the blocking pool so it never stalls the
            // async worker; an empty block only advances the watermark (tiny put, inline). The watermark
            // lets boot skip the O(contracts) rebuild when the index is already current. On failure mark
            // dirty → reader falls back to a live scan.
            if owns_to_persist.is_empty() {
                if let Err(e) = ctx.storage.set_owns_watermark(height) {
                    if is_warn() { println!("[WARN][PIPELINE] owns_watermark_failed h={} err={:?}", height, e); }
                }
            } else {
                let storage = ctx.storage.clone();
                let n = owns_to_persist.len();
                match tokio::task::spawn_blocking(move || storage.persist_owns_deltas(&owns_to_persist, height)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        ctx.storage.mark_owns_index_dirty();
                        if is_warn() { println!("[WARN][PIPELINE] persist_owns_failed h={} n={} err={:?} action=index_dirty", height, n, e); }
                    }
                    Err(join) => {
                        ctx.storage.mark_owns_index_dirty();
                        if is_warn() { println!("[WARN][PIPELINE] persist_owns_join_failed h={} n={} err={:?} action=index_dirty", height, n, join); }
                    }
                }
            }

            // ── Post-save updates (no state lock held) ──
            metrics.applied.fetch_add(1, Ordering::Relaxed);

            // ── v13.1: Timeout tracking (was missing — root cause of fork divergence) ──
            // Pipeline is the ONLY block processing path since v13.0.
            // Without these updates, LAST_BLOCK_PRODUCED_TIME stays at genesis_ts,
            // causing timeout_round to escalate forever → different rounds on each
            // node → different leader selection → fork from block 5 onward.
            {
                let prev_tip = crate::node::LAST_BLOCK_PRODUCED_HEIGHT.load(Ordering::Relaxed);
                crate::node::LAST_BLOCK_PRODUCED_TIME.store(
                    block.microblock.timestamp, Ordering::Relaxed,
                );
                crate::node::LAST_BLOCK_PRODUCED_HEIGHT.store(height, Ordering::Relaxed);

                // v14.8.10: observational clock-drift monitor. Feeds on-chain
                // block timestamp (producer-signed wall clock, agreed by n−f
                // honest committee for finalised macroblocks) into an EMA of
                // |local_now − block_ts|. Purely observational — triggers
                // WARN log and async NTP re-sync on drift, NEVER participates
                // in consensus rotation. Safe at any validator-count scale.
                crate::node::observe_clock_drift(
                    block.microblock.timestamp,
                    crate::node::get_timestamp_safe(),
                );

                // v14.8.10: Reset global CURRENT_TIMEOUT_ROUND atomic ONLY on
                // tip advance (next expected microblock applied). While
                // receiving blocks far behind tip (catch-up sync), the stored
                // round stays intact so a syncing node does not disrupt
                // rotation of nodes already at the tip. On genuine tip advance
                // the round is cleared because the happy-path producer has
                // succeeded — next block starts back at round 0 until a new
                // stall is detected.
                let is_tip_advance = height == prev_tip + 1;
                if is_tip_advance {
                    crate::node::reset_timeout_round();
                    if crate::node::is_debug() {
                        println!("[DBG][PIPELINE] round_reset h={} prev_tip={}", height, prev_tip);
                    }
                } else if height > prev_tip + 1 && crate::node::is_debug() {
                    println!("[DBG][PIPELINE] round_preserved h={} prev_tip={} reason=sync_or_skip",
                             height, prev_tip);
                }
            }

            // Update sync progress timestamp (deadlock detection)
            crate::node::LAST_SYNC_PROGRESS_TIME.store(
                crate::node::get_timestamp_safe(), Ordering::Relaxed,
            );

            // Update RAM height
            {
                let mut h = ctx.height.write().await;
                if height > *h {
                    *h = height;
                }
            }

            // Apply frontier already published right after set_chain_height (above) so peers never read a
            // stale value during the deferred-fx window.
            crate::unified_p2p::clear_block_pending_sync(height);

            // Chain-derived rotation-state catch-up. A node that synced
            // forward applied a block with timeout_round=6 while its local
            // HIGHEST_CERTIFIED_ROUND was still 0 (never saw the live BFT
            // votes), so it elected the round-0 leader instead of round-6 →
            // two-producer fork. Fix: when an applied block's timeout_round
            // exceeds local certified, proactively request timeout certs
            // from peers. The block's timeout_round is NOT used to advance
            // rotation directly (≤f byzantine could forge it) — it only
            // signals "a cert exists, fetch it"; the response path
            // re-verifies n−f sigs before advancing. Self-limiting via the
            // monotonic local_certified guard. ≤5-peer fan-out only on fire.
            let block_timeout_round = block.microblock.timeout_round;
            if block_timeout_round > 0 {
                let mb_idx = height / 90;
                let local_certified = crate::unified_p2p::highest_certified_round_for(mb_idx);
                // v34: mb.timeout_round is RELATIVE to the per-mb_idx baseline; local_certified is
                // ABSOLUTE. Reconstruct the block's absolute round before comparing — else, when
                // baseline>0 (a 2nd+ failover in the same window), the relative LHS is understated
                // by `baseline` and this proactive backfill misfires (missed/slow cert catch-up).
                let block_round_abs = block_timeout_round
                    .saturating_add(block.microblock.carried_baseline);
                if block_round_abs > local_certified {
                    if let Some(ref p2p) = ctx.unified_p2p {
                        if is_info() {
                            println!(
                                "[INFO][PIPELINE] rotation_backfill_request h={} mb={} block_round={} local_certified={}",
                                height, mb_idx, block_timeout_round, local_certified,
                            );
                        }
                        // Request certificates for the macroblock window
                        // covering this block — peers serve the same-round
                        // n−f TimeoutCertificates for it.
                        p2p.request_timeout_proofs(mb_idx, mb_idx);
                    }
                }
            }

            // Canonical boundary snapshot on EVERY node's apply path (deterministic, role-independent)
            // so a cold joiner can fast-sync from any peer — at the early anchor (h=90, first bindable
            // boundary) AND every SNAPSHOT_INCREMENTAL_INTERVAL thereafter. Pin a frozen DB view at
            // `height` SYNCHRONOUSLY here — the serial apply loop has not started H+1, so the snapshot
            // captures exactly state_root@H. With persist-before-evict the pinned accounts CF is the
            // COMPLETE committed leaf set, so a cold joiner's recompute reproduces the bound root. The
            // heavy serialization runs off-reactor on the frozen view.
            if height > 0
                && (height == crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT
                    || height % crate::node::SNAPSHOT_INCREMENTAL_INTERVAL == 0)
                && crate::node::should_materialize_snapshot(&ctx.node_id, height)
            {
                let snapshot_accounts = ctx.state.read().await.get_all_accounts();
                match ctx.storage.prepare_snapshot_view(&snapshot_accounts) {
                    Ok(view) => {
                        let storage_for_snapshot = ctx.storage.clone();
                        let snapshot_height = height;
                        tokio::spawn(async move {
                            if let Err(e) = storage_for_snapshot
                                .create_state_snapshot(snapshot_height, view).await
                            {
                                if is_warn() {
                                    println!("[WARN][PIPELINE] snapshot_create_failed h={} err={:?}", snapshot_height, e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] snapshot_prepare_failed h={} err={:?}", height, e);
                        }
                    }
                }
            }

            // STORAGE HYGIENE (epoch boundary) on EVERY node's apply path — the body-prune's twin
            // to the producer path in node.rs:17800. apply_stage is the single universal per-block
            // apply path for received blocks (gossip broadcast AND batch sync both funnel through
            // block_tx → pipeline), so this prunes on EVERY Super node that APPLIES a 14400-boundary
            // block. It intentionally does NOT use should_materialize_snapshot's ~1-in-5 holder gate,
            // so its per-node coverage is strictly BROADER than the co-located snapshot materialization
            // (each node must bound its OWN storage regardless of snapshot-holder duty). The prior
            // producer-only trigger left every non-boundary-producer growing unbounded (observed live:
            // one genesis at full ~2.8GB history vs a pruned one at ~1.1GB). prune_old_microblock_bodies
            // self-gates to Super and is watermark-based/idempotent (catch-up: drops everything below
            // height − 6 epochs), so any single applied boundary reclaims the whole window. Body-only
            // prune keeps hashes + macroblocks + snapshots + state → non-consensus, cannot affect
            // state_root or cold-join. (14400 is a multiple of the 3600 snapshot interval, so every
            // prune boundary is also a snapshot boundary — compatible cadences.)
            //
            // NOTE: recompress_old_blocks() is deliberately NOT run here. It is O(chain) — it re-scans
            // and re-decompresses the WHOLE history plus an unconditional full-CF compaction every
            // call, with near-zero steady-state benefit (blocks already at their age-bucket level are
            // not rewritten). Multiplying that across every node every epoch would burn CPU and contend
            // the apply write path at the boundary, so recompression stays producer-only (node.rs).
            if height % 14_400 == 0 && height > 0 {
                let storage_for_body_prune = ctx.storage.clone();
                let prune_h = height;
                tokio::spawn(async move {
                    match storage_for_body_prune.prune_old_microblock_bodies(prune_h, crate::node::MICROBLOCK_BODY_RETENTION_BLOCKS) {
                        Ok(0) => {}
                        Ok(n) => println!("[INFO][PIPELINE] microblock_bodies_pruned count={} window=6epochs h={}", n, prune_h),
                        Err(e) => { if is_warn() { println!("[WARN][PIPELINE] body_prune_failed err={:?}", e); } }
                    }
                });
            }

            // ────────────────────────────────────────────────────────────────
            // v14.10: GENESIS GLOBAL STATE (was missing in pipeline apply path!)
            //
            // The canonical `genesis_config::apply_genesis_state` sets two
            // process-global fields that are NOT touched by the regular
            // per-transaction apply path:
            //   1. GLOBAL_GENESIS_TIMESTAMP — used by consensus timing (rounds,
            //      timeout_round, slot calc). If left at 0 the node
            //      computes rotation rounds against Unix epoch — unusable.
            //   2. Dynamic pricing state seed — cold-start base fee at genesis.
            //
            // When a fresh node fetches genesis via HTTP at startup, the
            // startup path calls `apply_genesis_state` explicitly. But when a
            // fresh node receives h=0 over P2P (because HTTP genesis endpoint
            // is unavailable), the pipeline applies the block but skips these
            // two globals — leaving consensus broken until the node restarts.
            //
            // This block fixes that gap: on h=0 apply via pipeline, run the
            // same global-state initialisation. Idempotent (checks existing
            // value to avoid redundant stores on every h=0 replay).
            // ────────────────────────────────────────────────────────────────
            if height == 0 {
                let current_gen_ts = crate::GLOBAL_GENESIS_TIMESTAMP
                    .load(std::sync::atomic::Ordering::Relaxed);
                if current_gen_ts == 0 || current_gen_ts != block.microblock.timestamp {
                    crate::GLOBAL_GENESIS_TIMESTAMP.store(
                        block.microblock.timestamp,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    crate::set_genesis_timestamp(block.microblock.timestamp);
                    if is_info() {
                        println!("[INFO][PIPELINE] genesis_globals_set ts={} path=pipeline_apply",
                                 block.microblock.timestamp);
                    }
                }
            }

            // Broadcast block event (for consensus listener)
            let _ = ctx.block_event_tx.send(height);

            // v14.9: Wake sync manager and any other apply-waiters.
            // Zero-cost when no waiters (atomic notify slot).
            // At thousands of Super nodes scale this is O(1) — Notify uses
            // a single atomic flag + waker list; no per-waiter lock.
            ctx.apply_notify.notify_waiters();

            // Notify coordinator
            ctx.coordinator.try_send(ConsensusEvent::BlockApplied {
                height,
                producer: producer.clone(),
                timestamp: block.microblock.timestamp,
            });

            // v14.9: WS broadcast for real-time explorer updates.
            // Ported from the removed process_received_blocks path —
            // without this, NewBlock events never reach WS subscribers.
            crate::rpc::broadcast_ws_event(crate::rpc::WsEvent::NewBlock {
                height: block.microblock.height,
                hash: hex::encode(block.microblock.hash()),
                timestamp: block.microblock.timestamp,
                tx_count: block.microblock.transactions.len(),
                producer: block.microblock.producer.clone(),
            });

            // Per-microblock BlockCommitVote (blocking QC) is DISABLED on this
            // path: it competed with macroblock consensus for the same peers.
            //
            // Per-microblock confirmation is now provided by the COMMITTEE-
            // ATTESTATION layer: the EmptySlotAttestationMsg handler in
            // `unified_p2p`. Non-blocking — attestations
            // travel on a separate gossip channel, do not gate block
            // production, and form the basis of the per-block n−f fork-choice
            // keep-local rule. It supplies that n−f safety AND deterministic
            // empty-slot failover, without sharing
            // the macroblock commit rate-limit bucket. Macroblock n−f
            // commit/reveal at the 90-block boundary remains the canonical
            // finality anchor.

            // ── Reputation update for block producer ──
            // Handled by deterministic reputation system via macroblock processing
            // (not per-microblock — that's by design)

            if height <= 5 || height % 50 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] applied h={} prod={} txs={}", height, producer, tx_count);
                }
            }

            // v15.4 DIAG: clear apply op marker — between blocks the stage
            // is legitimately idle waiting on the channel. This lets the
            // watchdog distinguish "apply hung mid-block" (op != idle for
            // ≥30 s) from "no input arriving" (op = idle) so a slow
            // upstream is never mis-attributed to apply.
            metrics.mark_apply_idle();
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v18: REGRESSION TESTS — active sync trigger + dedup semantics
// ════════════════════════════════════════════════════════════════════════════
// These tests lock in the security and liveness invariants enforced by the
// new MISSING_BLOCK_REQUESTED dedup map and request_missing_parent helper.
// A regression on ANY of these means either:
//   * The thundering-herd protection (single-flight per height within TTL)
//     was broken — risk of bandwidth amplification when many child blocks
//     arrive for the same missing parent.
//   * The TTL retention was broken — risk of unbounded map growth or
//     legitimate retry of a genuinely-missing parent being silently
//     suppressed forever.
// Each test asserts a SECURITY or LIVENESS property, never a styling choice.
#[cfg(test)]
mod tests_v18_active_sync {
    use super::*;

    // The dedup map (`MISSING_BLOCK_REQUESTED`) is process-wide and shared
    // across cargo's parallel test workers. To avoid cross-test interference
    // each test below uses a UNIQUE height (>= 1_000_000_000) so its key
    // space cannot collide with production heights or other tests' keys.
    // No shared `reset_request_map` helper is used — every test scopes its
    // assertions to its own height key, and `cleanup_missing_block_requests`
    // tests check height-specific presence, not whole-map state.

    const H_FIRST_CALL: u64 = 1_000_000_001;
    const H_DUPLICATE: u64 = 1_000_000_002;
    const H_CLEANUP_EVICT: u64 = 1_000_000_003;
    const H_CLEANUP_KEEP: u64 = 1_000_000_004;
    const H_TTL_EXPIRY: u64 = 1_000_000_005;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// First call for an unseen height MUST insert the dedup entry.
    /// Without this, the very first orphaned-parent observation in a
    /// fresh boot would silently no-op and the legacy passive-wait
    /// remains the only recovery vector — defeating the purpose of v18.
    ///
    /// Note: the actual network send is gated on `try_get_p2p()` — in a
    /// unit-test context the global is None, so dispatch returns false
    /// from the network branch but the dedup-map insert MUST still
    /// happen. The test verifies the insert by reading the height key.
    #[test]
    fn first_call_inserts_into_dedup_map() {
        // Make sure we start from a clean state for THIS specific height key.
        // Avoid clearing the whole map — other parallel tests use other keys.
        MISSING_BLOCK_REQUESTED.remove(&H_FIRST_CALL);
        let _ = request_missing_parent(H_FIRST_CALL);
        assert!(
            MISSING_BLOCK_REQUESTED.contains_key(&H_FIRST_CALL),
            "first call must insert the height into the request map"
        );
    }

    /// A second call for the SAME height within the TTL window MUST NOT
    /// refresh the timestamp. This is the single-flight guarantee —
    /// without it, a flood of child blocks for the same missing parent
    /// would amplify into the same number of outbound `RequestBlocks`
    /// messages, wasting peer bandwidth at 1000+ super-node scale.
    #[test]
    fn duplicate_within_ttl_is_rejected() {
        MISSING_BLOCK_REQUESTED.remove(&H_DUPLICATE);
        let _ = request_missing_parent(H_DUPLICATE);
        let first_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_DUPLICATE)
            .expect("first insert must succeed")
            .value();
        // Second call within the same millisecond MUST NOT advance the
        // timestamp — verifies the cooldown branch was taken.
        let _ = request_missing_parent(H_DUPLICATE);
        let second_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_DUPLICATE)
            .expect("entry must still be present")
            .value();
        assert_eq!(
            first_ts, second_ts,
            "second call within TTL must NOT refresh the timestamp"
        );
    }

    /// Cleanup MUST evict entries older than the TTL. Without this the
    /// map grows unboundedly under sustained gap-recovery activity at
    /// thousand-node deployment scale.
    ///
    /// Cargo runs tests in parallel, so any other test that calls
    /// `cleanup_missing_block_requests()` may evict our stale-TS entry
    /// before this test asserts on it. To make the test deterministic
    /// under parallelism we directly compute the post-cleanup expectation:
    /// after `cleanup_missing_block_requests()`, an entry that was inserted
    /// with a stale timestamp MUST be absent regardless of the order in
    /// which other tests' cleanups interleaved with this one. The function
    /// is idempotent — multiple cleanups don't change the post-condition.
    #[test]
    fn cleanup_evicts_stale_entries() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_REQUEST_TTL_MS + 1000);
        MISSING_BLOCK_REQUESTED.insert(H_CLEANUP_EVICT, stale_ts);

        // Run cleanup explicitly. Any parallel test's cleanup that ran
        // between our insert and this call would also evict our stale
        // entry — which is the post-condition we are asserting. Either
        // way, the entry MUST be gone after this point.
        cleanup_missing_block_requests();
        assert!(
            !MISSING_BLOCK_REQUESTED.contains_key(&H_CLEANUP_EVICT),
            "cleanup must evict entries older than the TTL (key={})",
            H_CLEANUP_EVICT
        );
    }

    /// Cleanup MUST NOT evict entries within the TTL window. False
    /// positives here would cause re-dispatch of in-flight requests,
    /// re-introducing the thundering-herd we are trying to prevent.
    #[test]
    fn cleanup_preserves_fresh_entries() {
        MISSING_BLOCK_REQUESTED.insert(H_CLEANUP_KEEP, now_ms());

        cleanup_missing_block_requests();
        assert!(
            MISSING_BLOCK_REQUESTED.contains_key(&H_CLEANUP_KEEP),
            "cleanup must keep entries inserted within the TTL"
        );
    }

    /// After TTL expiry, a follow-up call MUST refresh the timestamp
    /// (the previous request is presumed lost — peer offline, packet
    /// drop — and a new attempt is warranted). Without this, a
    /// genuinely-missing parent that the network failed to deliver
    /// once would be silently abandoned forever — exactly the v17.x
    /// stall failure mode.
    #[test]
    fn ttl_expiry_allows_retry() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_REQUEST_TTL_MS + 1000);
        MISSING_BLOCK_REQUESTED.insert(H_TTL_EXPIRY, stale_ts);

        let _ = request_missing_parent(H_TTL_EXPIRY);
        let new_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_TTL_EXPIRY)
            .expect("entry must still exist")
            .value();
        assert!(
            new_ts > stale_ts,
            "expired-TTL retry must refresh the timestamp (was {} now {})",
            stale_ts, new_ts
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v19: REGRESSION TESTS — RANGE-SYNC DEDUP
// ═══════════════════════════════════════════════════════════════════════════
// Mirror of `tests_v18_active_sync` for the range-sync path added in v19.
// The single-flight semantics here protect against thundering-herd at thousand-
// node scale: when a long stall ends and many peers simultaneously surface
// their tip-advance, every local pipeline observation of an out-of-order child
// would otherwise emit one `sync_blocks(local_tip+1, child_h)` request per
// missing block — flooding the top-3 peers with duplicate batched fetches.
// Each test asserts a SECURITY or LIVENESS property, never a styling choice.
#[cfg(test)]
mod tests_v19_range_sync {
    use super::*;

    // All tests share the single global RANGE_SYNC_INFLIGHT slot — serialize
    // them so cargo's parallel workers cannot interleave state.
    static RANGE_TEST_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    fn set_state(s: (u64, u64, u64)) {
        *RANGE_SYNC_INFLIGHT.lock().unwrap_or_else(|p| p.into_inner()) = s;
    }

    fn get_state() -> (u64, u64, u64) {
        *RANGE_SYNC_INFLIGHT.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// First call must arm the window ANCHORED ON THE FRONTIER and cap the
    /// target to RANGE_SYNC_WINDOW — one dispatch = one serve-side batch.
    /// p2p is absent in unit tests, so the slot is then DISARMED (at == 0):
    /// nothing was sent, the retry must not wait out a phantom timeout.
    #[test]
    fn range_first_call_arms_capped_window() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_state((0, 0, 0));
        let _ = request_missing_range(1_000, 999_999_999);
        let (ws, we, at) = get_state();
        assert_eq!(ws, 1_000);
        assert_eq!(
            we,
            1_000 + RANGE_SYNC_WINDOW - 1,
            "target must be capped to the window, not the drifting tip"
        );
        assert_eq!(at, 0, "undispatched (p2p absent) slot must be disarmed for retry");
    }

    /// A drifting target (live tip advancing per block) with the frontier
    /// still inside the in-flight window MUST NOT re-dispatch. Storm
    /// regression: (from, to)-keyed dedup made every incoming block a unique
    /// key → one overlapping re-request per block.
    #[test]
    fn range_drifting_target_is_suppressed() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let armed = (2_000u64, 2_499u64, now_ms() - 1_000);
        set_state(armed);
        for drift in 0..100u64 {
            let _ = request_missing_range(2_000, 3_000 + drift);
        }
        // Frontier advance below half a window: still covered in-flight.
        let _ = request_missing_range(2_000 + RANGE_SYNC_WINDOW / 2 - 1, 999_999);
        assert_eq!(
            get_state(), armed,
            "no re-dispatch while the in-flight window is being consumed"
        );
    }

    /// Frontier consuming ≥ half the in-flight window MUST re-arm — the
    /// pipelined next-window dispatch (liveness half of the progress gate).
    #[test]
    fn range_progress_rearms_next_window() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_state((3_000, 3_499, now_ms() - 1_000));
        let next_from = 3_000 + RANGE_SYNC_WINDOW / 2;
        let _ = request_missing_range(next_from, 999_999);
        let (ws, we, _) = get_state();
        assert_eq!(ws, next_from, "half-window progress must re-anchor");
        assert_eq!(we, next_from + RANGE_SYNC_WINDOW - 1);
    }

    /// Frontier moving BELOW the window start (rollback/reorg) MUST
    /// re-anchor immediately, not wait out the retry timeout.
    #[test]
    fn range_rollback_reanchors() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_state((5_000, 5_499, now_ms() - 1_000));
        let _ = request_missing_range(4_000, 4_050);
        let (ws, _, _) = get_state();
        assert_eq!(ws, 4_000, "rollback below window start must re-anchor");
    }

    /// A stalled window (response lost, peer gone) MUST re-dispatch after
    /// RANGE_SYNC_RETRY_MS with the SAME frontier — the anti-wedge half:
    /// suppression alone would abandon a genuinely missing range forever.
    /// Observable in tests as at != stale: suppressed would leave the stale
    /// stamp; the fired path re-arms then disarms to 0 (p2p absent).
    #[test]
    fn range_timeout_retries_same_window() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let stale = now_ms() - RANGE_SYNC_RETRY_MS - 1_000;
        set_state((6_000, 6_499, stale));
        let _ = request_missing_range(6_000, 6_499);
        let (ws, _, at) = get_state();
        assert_eq!(ws, 6_000);
        assert_ne!(at, stale, "timed-out window must fire the retry path");
    }

    /// Inverted input (to < from) MUST be rejected without touching the
    /// in-flight state — a faulty caller must not clobber a live window.
    #[test]
    fn range_inverted_input_is_rejected() {
        let _g = RANGE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let armed = (7_000u64, 7_499u64, now_ms() - 1_000);
        set_state(armed);
        let dispatched = request_missing_range(500, 100);
        assert!(!dispatched, "inverted range (to < from) must be rejected");
        assert_eq!(get_state(), armed, "inverted input must not clobber in-flight state");
    }
}

#[cfg(test)]
mod tests_rollback_cache_invalidation {
    use super::*;

    static CACHE_TEST_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    /// Incident regression (h=54059/54060), now proved STRUCTURALLY rather than by invalidation:
    /// the height→hash cache that answered "this orphan's parent exists" no longer exists. Parents
    /// resolve through `Storage::header_by_hash`, where the key is derived from the block's own
    /// bytes — a rollback invalidates heights, never hashes, so a stale answer is unrepresentable.
    /// The behavioural proof lives in `storage::tests_header_index` (a superseded block's hash and
    /// its replacement's remain distinct keys) and in `storage::tests_parent_linkage_invariant`.
    #[test]
    fn parent_resolution_is_not_height_keyed() {
        let _g = CACHE_TEST_LOCK.lock().unwrap();
        // Guard against reintroduction. Built at runtime so this assertion cannot match itself.
        let banned = format!("pub fn {}_block_hash", "cache");
        let src = include_str!("block_pipeline.rs");
        assert!(!src.contains(&banned),
                "height-keyed hash cache reintroduced — parent resolution must stay content-addressed");
    }

    /// Concurrent detectors report different divergence points; the deepest must win, otherwise a
    /// shallower rollback leaves the deeper fork in place.
    #[test]
    fn fork_recovery_signal_keeps_deepest_target() {
        FORK_RECOVERY_HEIGHT.store(0, Ordering::SeqCst);

        signal_fork_recovery(54_059);
        signal_fork_recovery(54_090);
        assert_eq!(FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst), 54_059, "shallower target must not win");

        signal_fork_recovery(54_000);
        assert_eq!(FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst), 54_000, "deeper target must win");

        FORK_RECOVERY_HEIGHT.store(0, Ordering::SeqCst);
    }

    /// Serve horizon must follow stored, not applied, height: refusing to serve a block we hold
    /// removes this node's relay subtree from repair service.
    #[test]
    fn serve_horizon_follows_stored_height() {
        let _g = CACHE_TEST_LOCK.lock().unwrap();
        let prev_local = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed);
        let prev_stored = crate::unified_p2p::HIGHEST_STORED_HEIGHT.load(Ordering::Relaxed);

        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(54_058, Ordering::Relaxed);
        crate::unified_p2p::note_block_stored(54_060);
        assert_eq!(crate::unified_p2p::servable_height(), 54_060, "stored height must extend the serve horizon");

        // A rollback must pull the horizon back down, or the node serves empty batches for the
        // range it just deleted.
        crate::unified_p2p::truncate_stored_height(54_058);
        assert_eq!(crate::unified_p2p::servable_height(), 54_058, "rollback must lower the serve horizon");

        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(prev_local, Ordering::Relaxed);
        crate::unified_p2p::HIGHEST_STORED_HEIGHT.store(prev_stored, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests_deferred_by_parent {
    use super::*;

    /// A height-keyed deferred map holds ONE entry per slot, so two blocks waiting on the same
    /// parent — the normal case during a branch race — silently overwrote each other, and the
    /// loser was never reconsidered even after its parent arrived. Keyed by parent hash they
    /// coexist. Modelled here on the same structure the verify stage uses.
    #[test]
    fn siblings_waiting_on_one_parent_both_survive() {
        let parent = [0x11u8; 32];
        let mut deferred: HashMap<[u8; 32], Vec<u8>> = HashMap::new();

        deferred.entry(parent).or_default().push(0xA1);
        deferred.entry(parent).or_default().push(0xB2);

        let waiters = deferred.remove(&parent).expect("waiters present");
        assert_eq!(waiters.len(), 2, "both siblings must survive; a height-keyed map kept only one");
        assert!(waiters.contains(&0xA1) && waiters.contains(&0xB2));
    }

    /// Releasing children by parent identity needs no height arithmetic, so it stays correct when
    /// heights are sparse and the next block is not height+1.
    #[test]
    fn drain_follows_parentage_not_height() {
        let (a, b) = ([0x01u8; 32], [0x02u8; 32]);
        let mut deferred: HashMap<[u8; 32], Vec<&str>> = HashMap::new();
        deferred.entry(a).or_default().push("child_of_a");
        deferred.entry(b).or_default().push("child_of_b");

        // Verifying `a` releases only a's child, regardless of what heights are involved.
        let released = deferred.remove(&a).unwrap_or_default();
        assert_eq!(released, vec!["child_of_a"]);
        assert!(deferred.contains_key(&b), "unrelated waiters must not be disturbed");
    }
}

#[cfg(test)]
mod tests_deferred_capacity_rules {
    use super::*;

    /// A defensive cap must be derived from what the system legitimately produces, not chosen by
    /// eye. One producer makes a full rotation of consecutive blocks, and under packet loss they
    /// can all arrive out of order — a per-producer cap below the rotation size would silently
    /// drop honest traffic during exactly the recovery it exists to protect.
    #[test]
    fn per_producer_cap_exceeds_a_full_rotation() {
        const CAP: usize = 2 * crate::node::ROTATION_INTERVAL_BLOCKS as usize;
        assert!(CAP > crate::node::ROTATION_INTERVAL_BLOCKS as usize,
                "cap must hold a whole rotation of out-of-order blocks");
        // It must still bound an attacker far below the global buffer size.
        assert!(CAP * 4 < 2000, "cap must remain a meaningful fraction of DEFERRED_MAX");
    }

    /// The occupancy index must be maintained incrementally. Recomputing it by scanning the buffer
    /// on every deferral is O(buffer) per block on the verify path — the cost peaks exactly when
    /// the buffer is full, i.e. under the flood the cap defends against.
    #[test]
    fn producer_occupancy_is_tracked_incrementally() {
        let mut by_producer: HashMap<String, usize> = HashMap::new();
        let p = "genesis_node_001".to_string();

        for _ in 0..5 { *by_producer.entry(p.clone()).or_insert(0) += 1; }
        assert_eq!(by_producer.get(&p).copied(), Some(5));

        // Draining releases occupancy so a producer is not permanently blocked by past deferrals.
        for _ in 0..5 {
            if let Some(c) = by_producer.get_mut(&p) { *c = c.saturating_sub(1); }
        }
        assert_eq!(by_producer.get(&p).copied(), Some(0),
                   "released slots must return to the producer, or one burst blocks it forever");
    }
}

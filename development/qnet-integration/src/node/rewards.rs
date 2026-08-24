//! Reward accounting: emission, epoch reward roots, sharded reward proofs, window rewards.

use super::*;

impl BlockchainNode {

    /// Split `pool` equally across `eligible` and ADD each share into `wmap`, keyed by wallet.
    /// Accumulating instead of returning is what lets two pools produce ONE globally wallet-sorted leaf
    /// set: a wallet holding both a super and a light identity must yield one aggregated leaf, or the
    /// sharded claim path sees duplicate leaves for the same wallet. Order-independent (sorted by
    /// node_id for the remainder, BTreeMap for the merge) and exactly conserving.
    pub(super) fn accumulate_equal_share(
        wmap: &mut std::collections::BTreeMap<String, u64>,
        eligible: &[(String, String)],
        pool: u64,
    ) {
        if eligible.is_empty() || pool == 0 { return; }
        let mut ordered: Vec<&(String, String)> = eligible.iter().collect();
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        let count = ordered.len() as u64;
        let per_node = pool / count;
        let remainder = pool % count;
        for (i, (_node_id, wallet)) in ordered.iter().enumerate() {
            let amt = per_node + if (i as u64) < remainder { 1 } else { 0 };
            *wmap.entry(wallet.clone()).or_insert(0) += amt;
        }
    }

    /// Operator (super/genesis) share of each emission, in basis points. The rest goes to users.
    ///
    /// A merged pool paid a phone and a 24/7 server the same amount, so at the target ratio of ~100
    /// light clients per operator the operator's income could not cover a server and running one was
    /// irrational. Splitting costs users little precisely because they outnumber operators: a quarter
    /// of the pool moves ~25x more to each operator while each user gives up ~a quarter.
    pub(crate) const OPERATOR_POOL_BP: u64 = 2_500;

    /// Two-pool emission split. Both pools feed ONE wallet map, so the leaf set stays globally
    /// wallet-sorted and duplicate-free. When one side has no eligible recipients its share goes to the
    /// other: at launch there are no light clients, and minting a share nobody can ever claim would
    /// silently strand it.
    pub(super) fn distribute_split_rewards(
        supers: &[(String, String)],
        lights: &[(String, String)],
        total: u64,
        epoch: u64,
    ) -> (Vec<(String, u64)>, String) {
        if total == 0 || (supers.is_empty() && lights.is_empty()) {
            return (Vec::new(), String::new());
        }
        let (op_pool, user_pool) = match (supers.is_empty(), lights.is_empty()) {
            (false, false) => {
                let op = total / 10_000 * Self::OPERATOR_POOL_BP
                    + (total % 10_000) * Self::OPERATOR_POOL_BP / 10_000;
                (op, total - op)
            }
            (false, true) => (total, 0),
            (true, false) => (0, total),
            (true, true) => return (Vec::new(), String::new()),
        };
        let mut wmap: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        Self::accumulate_equal_share(&mut wmap, supers, op_pool);
        Self::accumulate_equal_share(&mut wmap, lights, user_pool);
        if wmap.is_empty() { return (Vec::new(), String::new()); }
        let wallet_vec: Vec<(String, u64)> = wmap.into_iter().collect();
        let root = Self::epoch_reward_merkle_root(&wallet_vec, epoch);
        (wallet_vec, root)
    }

    /// Merkle root of a reward leaf-set for an epoch. Leaf = SHA3-256(wallet ‖ epoch_le ‖ amount_le),
    /// byte-identical to the emission distribution and the claim-proof builder. The SINGLE hasher for the
    /// verify-before-serve gate: any reconstructed leaf-set (frozen blob or live recompute) must hash to
    /// the n−f-committed reward_root before a node serves it — else the node returns "resyncing", never a
    /// wrong claimable amount (a per-node derived index can drift; the committed root is the only oracle).
    pub(crate) fn epoch_reward_merkle_root(wallets: &[(String, u64)], epoch: u64) -> String {
        if wallets.is_empty() { return String::new(); }
        let leaves: Vec<String> = wallets.iter()
            .map(|(w, a)| Self::reward_leaf_hash_hex(w, epoch, *a))
            .collect();
        qnet_core::crypto::merkle::compute_merkle_root(&leaves).unwrap_or_default()
    }

    /// Fixed reward-shard width (power of two). A claim loads exactly ONE shard ⇒ proof generation is
    /// O(REWARD_SHARD_SIZE) memory/CPU regardless of recipient count — the 10M-light-node claim path.
    pub(crate) const REWARD_SHARD_SIZE: usize = 4096;

    /// Reward merkle leaf (hex) — SHA3-256(wallet ‖ epoch_le ‖ amount_le). The SINGLE leaf-hash source
    /// shared by the monolithic root, the sharded structure, and the claim-proof builder, so every
    /// derivation is byte-identical.
    #[inline]
    pub(crate) fn reward_leaf_hash_hex(wallet: &str, epoch: u64, amount: u64) -> String {
        let mut h = Sha3_256::new();
        h.update(wallet.as_bytes());
        h.update(&epoch.to_le_bytes());
        h.update(&amount.to_le_bytes());
        hex::encode(h.finalize())
    }

    /// Streamed epoch reward build for the 10M-recipient target: aggregate per wallet through the
    /// `reward_agg` scratch CF (RocksDB orders bytewise = `BTreeMap<String,_>` order), then walk that
    /// order once, hashing leaves a shard at a time. Peak RAM is ONE shard (REWARD_SHARD_SIZE), not the
    /// whole leaf set — the in-memory path materialised the recipient map, the wallet vector AND the
    /// leaf-hash vector, several GB at 10M lights, on the producer and on every validator recomputing.
    ///
    /// Byte-identical to `distribute_split_rewards` by construction: same per-NODE split with the
    /// remainder to the first `remainder` node_ids, same wallet ordering, same leaf hash, and the
    /// shard-roots recombine through `merkle_continue_root` to exactly `compute_merkle_root` over the
    /// full set. Pinned by `streamed_reward_root_matches_in_memory`.
    ///
    /// Returns (recipient_count, total_paid, root_hex) — never the full vector, which is the point.
    /// `on_shard` receives each completed shard's (index, sorted (wallet, amount) slice) so the caller
    /// can persist it without a second pass.
    pub(super) fn build_epoch_rewards_streamed<L, F>(
        storage: &crate::storage::Storage,
        supers: &[(String, String)],
        lights: L,
        total: u64,
        epoch: u64,
        mut on_shard: F,
    ) -> Option<(usize, u64, String)>
    where
        // Re-invokable so lights are COUNTED then EMITTED without ever being collected: at the 10M
        // target the vector alone was ~1.5 GB. Must yield (node_id, wallet) in node_id order on both
        // passes — the roster prefix scan does, and the remainder rule depends on that order.
        L: Fn(&mut dyn FnMut(&str, &str)) -> crate::errors::IntegrationResult<()>,
        F: FnMut(usize, &[(String, u64)], [u8; 32]),
    {
        let mut light_count = 0usize;
        if let Err(e) = lights(&mut |_n, _w| { light_count += 1; }) {
            println!("[CRIT][REWARD] light_count_failed epoch={} err={}", epoch, e);
            return None;
        }
        if total == 0 || (supers.is_empty() && light_count == 0) {
            return Some((0, 0, String::new()));
        }
        let (op_pool, user_pool) = match (supers.is_empty(), light_count == 0) {
            (false, false) => {
                let op = total / 10_000 * Self::OPERATOR_POOL_BP
                    + (total % 10_000) * Self::OPERATOR_POOL_BP / 10_000;
                (op, total - op)
            }
            (false, true) => (total, 0),
            (true, false) => (0, total),
            (true, true) => return Some((0, 0, String::new())),
        };

        // Private key range for THIS build: two builds for the same epoch can legitimately run at
        // once (checkpoint/verify vs the producer), and a shared range would have one clearing while
        // the other writes.
        let build = storage.reward_agg_new_build();
        if let Err(e) = storage.reward_agg_clear(build) {
            println!("[CRIT][REWARD] agg_clear_failed epoch={} err={}", epoch, e);
            return None;
        }
        // One PUT per eligible node, batched. The per-node amount is the same arithmetic the in-memory
        // path uses; summing per wallet happens during the ordered scan below.
        const PUT_BATCH: usize = 20_000;
        let mut put_err = false;
        let flush = |buf: &mut Vec<(String, String, u64)>, err: &mut bool| {
            if buf.is_empty() || *err { buf.clear(); return; }
            if let Err(e) = storage.reward_agg_put_batch(build, buf) {
                println!("[CRIT][REWARD] agg_put_failed epoch={} err={}", epoch, e);
                *err = true;
            }
            buf.clear();
        };
        if !supers.is_empty() && op_pool > 0 {
            let mut ordered: Vec<&(String, String)> = supers.iter().collect();
            ordered.sort_by(|a, b| a.0.cmp(&b.0));
            let count = ordered.len() as u64;
            let (per_node, remainder) = (op_pool / count, op_pool % count);
            let mut buf: Vec<(String, String, u64)> = Vec::with_capacity(PUT_BATCH);
            for (i, (node_id, wallet)) in ordered.iter().enumerate() {
                buf.push((wallet.clone(), node_id.clone(),
                          per_node + if (i as u64) < remainder { 1 } else { 0 }));
                if buf.len() >= PUT_BATCH { flush(&mut buf, &mut put_err); }
            }
            flush(&mut buf, &mut put_err);
        }
        if light_count > 0 && user_pool > 0 && !put_err {
            let count = light_count as u64;
            let (per_node, remainder) = (user_pool / count, user_pool % count);
            let mut buf: Vec<(String, String, u64)> = Vec::with_capacity(PUT_BATCH);
            let mut i = 0u64;
            let emit = lights(&mut |node_id, wallet| {
                buf.push((wallet.to_string(), node_id.to_string(),
                          per_node + if i < remainder { 1 } else { 0 }));
                i += 1;
                if buf.len() >= PUT_BATCH { flush(&mut buf, &mut put_err); }
            });
            flush(&mut buf, &mut put_err);
            if emit.is_err() || i != count {
                // A second pass that yields a different set means the source moved under us; the
                // remainder assignment would no longer match any peer's.
                println!("[CRIT][REWARD] light_emit_unstable epoch={} counted={} emitted={}", epoch, count, i);
                let _ = storage.reward_agg_clear(build);
                return None;
            }
        }
        if put_err {
            let _ = storage.reward_agg_clear(build);
            return None;
        }

        let height = qnet_core::crypto::merkle::shard_height(Self::REWARD_SHARD_SIZE);
        let mut shard: Vec<(String, u64)> = Vec::with_capacity(Self::REWARD_SHARD_SIZE);
        let mut shard_roots: Vec<[u8; 32]> = Vec::new();
        let mut shard_idx = 0usize;
        let (mut count, mut paid) = (0usize, 0u64);
        let mut build_err: Option<String> = None;
        let scan = storage.reward_agg_for_each_wallet(build, |wallet, amt| {
            if build_err.is_some() { return; }
            count += 1;
            paid = paid.saturating_add(amt);
            shard.push((wallet.to_string(), amt));
            if shard.len() == Self::REWARD_SHARD_SIZE {
                let leaves: Vec<String> = shard.iter()
                    .map(|(w, a)| Self::reward_leaf_hash_hex(w, epoch, *a)).collect();
                match qnet_core::crypto::merkle::shard_subtree_root(&leaves, height) {
                    Ok(r) => { shard_roots.push(r); on_shard(shard_idx, &shard, r); shard_idx += 1; }
                    Err(e) => build_err = Some(e.to_string()),
                }
                shard.clear();
            }
        });
        if let Err(e) = scan {
            println!("[CRIT][REWARD] agg_scan_failed epoch={} err={}", epoch, e);
            let _ = storage.reward_agg_clear(build);
            return None;
        }
        if !shard.is_empty() && build_err.is_none() {
            // Trailing partial shard: subtree_root pads to the same height, matching reward_shard_roots.
            let leaves: Vec<String> = shard.iter()
                .map(|(w, a)| Self::reward_leaf_hash_hex(w, epoch, *a)).collect();
            let single = shard_roots.is_empty();
            let r = if single {
                qnet_core::crypto::merkle::compute_merkle_root(&leaves).ok()
                    .and_then(|h| hex::decode(h).ok())
                    .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
            } else {
                qnet_core::crypto::merkle::shard_subtree_root(&leaves, height).ok()
            };
            match r {
                Some(r) => { shard_roots.push(r); on_shard(shard_idx, &shard, r); }
                None => build_err = Some("shard_root_failed".to_string()),
            }
        }
        let _ = storage.reward_agg_clear(build);
        if let Some(e) = build_err {
            println!("[CRIT][REWARD] root_build_failed epoch={} err={}", epoch, e);
            return None;
        }
        if shard_roots.is_empty() { return Some((0, 0, String::new())); }
        let root = if shard_roots.len() == 1 {
            hex::encode(shard_roots[0])
        } else {
            hex::encode(qnet_core::crypto::merkle::merkle_continue_root(&shard_roots))
        };
        Some((count, paid, root))
    }

    /// Persist the per-epoch reward set as a SHARDED structure (10M-scale claim serving): the SORTED
    /// (wallet, amount) leaves split into REWARD_SHARD_SIZE-leaf shards + shard-meta (K subtree-roots +
    /// each shard's first wallet, for O(log K) locate). The shard-roots recombine to the SAME reward_root
    /// as the monolithic tree and per-shard proofs are byte-identical to it — reward_root, on-chain
    /// verify, and the mobile app are all unchanged. A claim then loads exactly ONE shard, never O(N).
    pub(crate) fn save_epoch_reward_sharded(storage: &crate::storage::Storage, epoch: u64, wallets: &[(String, u64)]) {
        if wallets.is_empty() {
            let _ = storage.delete_epoch_reward_shards(epoch);
            return;
        }
        let leaf_hashes: Vec<String> = wallets.iter()
            .map(|(w, a)| Self::reward_leaf_hash_hex(w, epoch, *a))
            .collect();
        let roots = match qnet_core::crypto::merkle::reward_shard_roots(&leaf_hashes, Self::REWARD_SHARD_SIZE) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut bounds: Vec<String> = Vec::with_capacity(roots.len());
        let mut s = 0usize;
        while s * Self::REWARD_SHARD_SIZE < wallets.len() {
            let start = s * Self::REWARD_SHARD_SIZE;
            let end = ((s + 1) * Self::REWARD_SHARD_SIZE).min(wallets.len());
            // Not a fork: reward_root is QC-authoritative and a dropped shard self-heals via
            // backfill on boot/post-cold-join. Surface the drop at WARN, don't fail the mint.
            if let Err(e) = storage.save_epoch_reward_shard(epoch, s, &wallets[start..end]) {
                println!("[WARN][REWARD] shard_persist_failed epoch={} shard={} err={}", epoch, s, e);
            }
            bounds.push(wallets[start].0.clone());
            s += 1;
        }
        if let Err(e) = storage.save_epoch_shard_meta(epoch, &roots, &bounds) {
            println!("[WARN][REWARD] shard_persist_failed epoch={} kind=meta err={}", epoch, e);
        }
        Self::prune_reward_shard_cache(storage, epoch);
    }

    /// Bound the sharded leaf-set CACHE: keep the newest SHARD_CACHE_RETAIN epochs (~0.5GB/epoch at
    /// 10M light ⇒ unbounded disk otherwise). Drops epoch_wshard_/epoch_shardmeta_ only —
    /// root/super_elig_/light_bm_ stay, so an older claim self-heals through backfill_reward_shards.
    /// Called from every shard writer so no path can forget it.
    pub(super) fn prune_reward_shard_cache(storage: &crate::storage::Storage, epoch: u64) {
        // Retention is in EPOCHS, but the key is a macroblock index that advances by MB_PER_EPOCH per
        // emission — subtracting the epoch count directly kept ~1.6 epochs, not 256.
        const SHARD_CACHE_RETAIN_EPOCHS: u64 = 256;
        let span = SHARD_CACHE_RETAIN_EPOCHS.saturating_mul(crate::reward_epoch::MB_PER_EPOCH);
        if let Some(floor) = epoch.checked_sub(span) {
            if floor > 0 {
                if let Err(e) = storage.prune_epoch_reward_shards(floor) {
                    println!("[WARN][REWARD] shard_prune_failed before_epoch={} err={}", floor, e);
                }
            }
        }
    }

    /// Resolve a wallet's claim for an epoch against the SHARDED reward structure, verified against the
    /// n−f-committed reward_root. O(shard): loads the shard-meta (K roots+bounds) + exactly ONE shard,
    /// never the full O(N) set. `want_proof=false` returns the amount only (pending display).
    pub(crate) fn reward_proof_from_shard(
        storage: &crate::storage::Storage,
        epoch: u64,
        committed_root: &str,
        wallet: &str,
        want_proof: bool,
    ) -> ShardClaim {
        let (roots, bounds) = match storage.load_epoch_shard_meta(epoch) {
            Ok(Some(m)) => m,
            _ => return ShardClaim::Absent,
        };
        if roots.is_empty() || bounds.len() != roots.len() {
            return ShardClaim::Absent;
        }
        // Verify the shard-roots recombine to the committed reward_root (O(K)). A snapshot-synced or
        // drifted node whose reconstructed structure disagrees must never serve a wrong claim.
        if !committed_root.is_empty() {
            let recombined = hex::encode(qnet_core::crypto::merkle::merkle_continue_root(&roots));
            if recombined != committed_root {
                return ShardClaim::Divergent;
            }
        }
        // Locate the shard: bounds[s] = ascending first wallet of shard s over the globally-sorted set,
        // so the target sits in the shard whose bound is the largest one not exceeding it.
        let s = match bounds.binary_search_by(|b| b.as_str().cmp(wallet)) {
            Ok(i) => i,
            Err(0) => return ShardClaim::NotRecipient,
            Err(i) => i - 1,
        };
        let shard = match storage.load_epoch_reward_shard(epoch, s) {
            Ok(Some(sh)) => sh,
            _ => return ShardClaim::Absent,
        };
        let idx = match shard.iter().position(|(w, _)| w == wallet) {
            Some(i) => i,
            None => return ShardClaim::NotRecipient,
        };
        let amount = shard[idx].1;
        if !want_proof {
            return ShardClaim::Proof(amount, Vec::new());
        }
        let shard_hashes: Vec<String> = shard.iter()
            .map(|(w, a)| Self::reward_leaf_hash_hex(w, epoch, *a))
            .collect();
        match qnet_core::crypto::merkle::generate_reward_proof_sharded(&shard_hashes, idx, &roots, s, Self::REWARD_SHARD_SIZE) {
            Ok(proof) => ShardClaim::Proof(amount, proof),
            Err(_) => ShardClaim::Divergent,
        }
    }

    /// Deterministic per-epoch reward distribution + merkle root, derived ENTIRELY from on-chain
    /// data (the rewarding macroblock's heartbeat snapshot + total_emission). Called by BOTH the
    /// emission producer and the apply-time recompute, so the committed root and every node's
    /// independently recomputed root are byte-identical. Resolves the eligible set from the
    /// macroblock, then delegates the split to the pure `distribute_split_rewards`.
    /// Returns (sorted wallet→amount pairs, merkle root hex); empty when no eligible / no emission.
    /// True iff epoch `epoch_num`'s settle point lies BELOW this node's cold-join anchor, i.e. its rows
    /// were never delivered to this node. The only sound reason to abstain from a reward root: every
    /// other absence is shared by the whole network and must be published, not deferred.
    pub(super) fn epoch_below_join_anchor(storage: &crate::storage::Storage, epoch_num: u64) -> bool {
        let anchor_mb = storage.snapshot_join_anchor_mb();
        if anchor_mb == 0 { return false; } // from-genesis node: it holds everything it should
        // Epoch E settles at (E+1)*14400 + HB_ANCHOR_MAX_LAG; compare in macroblock indices.
        // INCLUSIVE: the anchor macroblock itself is not replayed (its state arrives in the snapshot),
        // so a settle point landing exactly on it left no side indices here either.
        let settle_mb = ((epoch_num + 1) * 14_400 + HB_ANCHOR_MAX_LAG) / 90;
        settle_mb <= anchor_mb
    }

    /// Streamed twin of `compute_epoch_reward_distribution`: same inputs, same root, but it never
    /// materialises the recipient set. `persist_shards` writes each shard as it is produced, so the
    /// producer path gets the claim-serving structure from the same single pass.
    /// Returns (recipient_count, total_paid, root_hex). None = this node cannot reproduce the set.
    pub(crate) fn compute_epoch_reward_root(
        storage: &crate::storage::Storage,
        macroblock_index: u64,
        total_emission: u64,
        persist_shards: Option<u64>,
    ) -> Option<(usize, u64, String)> {
        let (supers, lights) = Self::gather_epoch_reward_sets(storage, macroblock_index)?;
        let epoch_for_leaf = macroblock_index;
        match persist_shards {
            Some(epoch) => {
                let mut roots: Vec<[u8; 32]> = Vec::new();
                let mut bounds: Vec<String> = Vec::new();
                let light_iter = |f: &mut dyn FnMut(&str, &str)| lights.for_each(storage, f);
                let out = Self::build_epoch_rewards_streamed(
                    storage, &supers, light_iter, total_emission, epoch_for_leaf,
                    |idx, shard, shard_root| {
                        if let Err(e) = storage.save_epoch_reward_shard(epoch, idx, shard) {
                            println!("[WARN][REWARD] shard_persist_failed epoch={} shard={} err={}", epoch, idx, e);
                        }
                        bounds.push(shard[0].0.clone());
                        // The root the BUILDER used for the committed value — never a second
                        // derivation. A recomputation here diverged for a single sub-shard epoch
                        // (natural vs padded height) and made every claim read as Divergent.
                        roots.push(shard_root);
                    })?;
                if !bounds.is_empty() {
                    if let Err(e) = storage.save_epoch_shard_meta(epoch, &roots, &bounds) {
                        println!("[WARN][REWARD] shard_persist_failed epoch={} kind=meta err={}", epoch, e);
                    }
                }
                Self::prune_reward_shard_cache(storage, epoch);
                Some(out)
            }
            None => Self::build_epoch_rewards_streamed(
                storage, &supers, |f: &mut dyn FnMut(&str, &str)| lights.for_each(storage, f),
                total_emission, epoch_for_leaf, |_, _, _| {}),
        }
    }

    /// THE eligibility gather for an emission window: (supers, lights) as (node_id, wallet), both in
    /// node_id order. Split out so the streamed root build and the legacy vector build read one source.
    /// None = this node cannot reproduce the set (abstain, never guess).
    pub(super) fn gather_epoch_reward_sets(
        storage: &crate::storage::Storage,
        macroblock_index: u64,
    ) -> Option<(Vec<(String, String)>, LightRewardSource)> {
        if macroblock_index < 160 { return Some((Vec::new(), LightRewardSource::default())); }
        let ws = (macroblock_index / 160 - 1) * 14400;
        let epoch_num = ws / 14400;

        let mut super_eligible: Vec<(String, String)> = Vec::new();
        let mut light_src = LightRewardSource::default();

        // SUPER/genesis: enumerate chain-registered nodes (deterministic CF) and keep those whose
        // on-chain heartbeat tally for the epoch is ≥ 9 — identical to the producer's emitter scan
        // but O(registered) and recomputable on every node without the macroblock snapshot.
        // Read the apply-time eligibility index (popcount≥9) for the epoch — O(eligible) prefix scan
        // — and map each to its reward wallet via the registration set, instead of an O(registered)
        // per-account scan. Identical set (index = same on-chain tally ∩ registrations); the split
        // sorts internally so push order is irrelevant. Deterministic + recomputable on every node.
        // A roster scan that FAILED is "cannot reproduce", not "no supers": silently skipping the
        // branch builds a root without them, which every peer Rejects. Abstain, like the
        // local-blindness paths below.
        let super_read = (storage.load_super_eligible(epoch_num), storage.super_registrations_sorted());
        if matches!(super_read, (Err(_), _) | (_, Err(_))) {
            println!("[CRIT][REWARD] super_roster_unreadable epoch={} action=abstain", epoch_num);
            return None;
        }
        if let (Ok(eligible_ids), Ok(supers)) = super_read {
            // Same reasoning as the light branch below: super_elig_{E} lives in the pending_rewards CF,
            // which a snapshot joiner does not hold below its anchor. An empty index while supers ARE
            // registered means "cannot reproduce", not "no super was eligible" — and at relaunch, when
            // the light roster is still empty, this is the branch that decides the whole root.
            // Abstain ONLY when the absence is LOCAL. An empty index on a from-genesis node is the
            // network-wide truth (nobody cleared the 9-of-10 bar), and returning None there makes EVERY
            // node defer — a permanent halt instead of an epoch that paid nobody. A snapshot joiner, by
            // contrast, simply does not hold the epoch's rows and must not vote on them.
            if eligible_ids.is_empty() && !supers.is_empty()
                && Self::epoch_below_join_anchor(storage, epoch_num)
            {
                if is_warn() {
                    println!("[WARN][REWARD] super_eligible_below_anchor epoch={} — abstaining", epoch_num);
                }
                return None;
            }
            let reg: std::collections::HashMap<String, String> = supers.into_iter().collect();
            for node_id in eligible_ids {
                if let Some(wallet) = reg.get(&node_id) {
                    if !wallet.is_empty() { super_eligible.push((node_id, wallet.clone())); }
                }
            }
        }

        // LIGHT: recompute from on-chain eligibility bitmaps mapped through the deterministic pre-epoch
        // roster (sorted node_registry, NOT the RAM mirror) using the SAME stable hash-shard the producer
        // used (light_shard_of + per-shard counter ⇒ bit i in shard g = i-th sorted node with shard==g), so
        // every node maps bits→nodes identically. STREAMED (one lrtr_ walk) — memory O(eligible), never an
        // O(roster) Vec on the emission path (at millions of light nodes that Vec was a multi-100MB spike).
        {
            let cutoff = light_roster_cutoff(epoch_num);
            let bitmaps = storage.load_light_bitmaps(epoch_num).unwrap_or_default();
            // A snapshot joiner holds no data below its anchor, so an epoch whose light bitmaps were
            // committed there reads back EMPTY here. Silently distributing to nobody produced a reward
            // root that differed from every from-genesis node — and the content check turns that into a
            // Reject, i.e. this node votes AGAINST every emission-window checkpoint forever. Absent
            // bitmaps for an epoch that actually has a light roster means "cannot reproduce", not
            // "nobody was eligible".
            // Same rule as the super branch: only LOCAL blindness abstains. A missing bitmap that every
            // node is missing (the shard owner was down through the commit window) costs that epoch its
            // light payout — bad, but bounded and recoverable. Deferring on it instead stops the chain
            // for good, because no later block can ever supply the row.
            if bitmaps.is_empty() && Self::epoch_below_join_anchor(storage, epoch_num) {
                let mut roster_nonempty = false;
                // Err here would leave roster_nonempty=false and skip the abstain below on exactly
                // the evidence that decides it.
                if storage.light_roster_for_each(cutoff, |_id, _w, _idx| { roster_nonempty = true; }).is_err() {
                    println!("[CRIT][REWARD] light_roster_unreadable epoch={} action=abstain", epoch_num);
                    return None;
                }
                if roster_nonempty {
                    if is_warn() {
                        println!("[WARN][REWARD] light_bitmaps_below_anchor epoch={} — abstaining", epoch_num);
                    }
                    return None;
                }
            }
            if !bitmaps.is_empty() {
                // NOT collected: the eligible lights are replayed on demand from the roster scan +
                // bitmaps (both already on disk). At the 10M target the vector alone was ~1.5 GB, and
                // the reward build needs two passes (count, then emit) — a replayable source gives
                // both for O(1) RAM. Deterministic: the roster scan is node_id-ordered, and the
                // shard-local index is derived in that same order on every pass and every node.
                light_src = LightRewardSource { cutoff, bitmaps };
            }
        }

        Some((super_eligible, light_src))
    }

    /// Legacy vector form, for the COLD callers that genuinely need the recipient list (claim serving
    /// and the shard backfill). Consensus paths use `compute_epoch_reward_root` and never build this.
    pub(crate) fn compute_epoch_reward_distribution(
        storage: &crate::storage::Storage,
        macroblock_index: u64,
        total_emission: u64,
    ) -> Option<(Vec<(String, u64)>, String)> {
        let (supers, light_src) = Self::gather_epoch_reward_sets(storage, macroblock_index)?;
        let mut lights: Vec<(String, String)> = Vec::new();
        if light_src.for_each(storage, &mut |n, w| lights.push((n.to_string(), w.to_string()))).is_err() {
            println!("[CRIT][REWARD] light_roster_unreadable mb={} action=abstain", macroblock_index);
            return None;
        }
        Some(Self::distribute_split_rewards(&supers, &lights, total_emission, macroblock_index))
    }

    /// Upper bound on declared gas. Admission-only (both ingress points) plus a producer-side drop.
    /// NOT a block rule and NOT in `Transaction::validate()` (the block path calls it): rejecting an
    /// oversized TX at the block would halt the chain instead of costing one TX.
    pub(crate) fn gas_limit_admissible(tx: &qnet_state::Transaction) -> bool {
        tx.gas_limit <= qnet_state::gas_limits::MAX_GAS_LIMIT
    }

    /// The ONE emission amount that is valid in the block at `height` — the exact mirror of the
    /// producer's build (node.rs, is_emission_block branch): Pool-1 from the height-derived halving
    /// schedule plus the pool2/pool3 totals sealed in the rewarding epoch's macroblock.
    ///
    /// PURE FUNCTION OF HEIGHT — no storage read, so every node reaches the same verdict and the
    /// rule is enforced by all of them. It used to load the rewarding epoch's macroblock for
    /// pool2/pool3, which made enforcement depend on whether the node still held a macroblock ~2
    /// epochs back: a recently synced node fell into a fail-open arm while long-running nodes
    /// enforced, so a bad amount split total_supply between the two cohorts instead of being
    /// rejected by everyone.
    ///
    /// PRECONDITION for dropping those terms: `ConsensusData::pool2_total_fees` and
    /// `pool3_total_activations` are never written — the sole macroblock construction site
    /// (consensus_v2_node.rs) leaves them `None`, so both sides always added 0. If either is ever
    /// populated, this must read the macroblock again AND handle its absence explicitly, or a node
    /// lacking it will compute a wrong expectation and reject an HONEST block. See
    /// core/qnet-state/src/block.rs where those fields are declared.
    pub(crate) fn expected_emission_amount(height: u64) -> EmissionExpectation {
        const EMISSION_BLOCK_INTERVAL: u64 = 14400;
        if height == 0 || height % EMISSION_BLOCK_INTERVAL != 0 {
            return EmissionExpectation::NoneDue;
        }
        // Emission is delayed one full epoch (the rewarding macroblock must be finalized first), so
        // the first two epochs have nothing to reward.
        if height / EMISSION_BLOCK_INTERVAL <= 1 {
            return EmissionExpectation::NoneDue;
        }
        // A ZERO amount is NOT an emission that must appear: once the halving schedule floors to 0 the
        // producer builds no emission TX at all (`if total_emission > 0`), so every consumer that reads
        // Exact(_) as "a TX must exist here" would wait forever — the block-accept presence gate would
        // reject honest blocks and the reward-root scan would defer every window. NoneDue is the single
        // verdict that keeps producer, validator and the window scan agreeing.
        match qnet_consensus::lazy_rewards::pool1_base_emission_at_height(height) {
            0 => EmissionExpectation::NoneDue,
            n => EmissionExpectation::Exact(n),
        }
    }


    /// Emission for a checkpoint window: finds the window's v3 system_emission TX and recomputes
    /// the distribution from its (epoch,total). Returns (root_hex, leaf_set, total, epoch) where
    /// `epoch` is the CANONICAL /90 macroblock-index reward epoch carried in the TX (the SAME key
    /// the producer/apply/claim use — NOT window_head_height/CHECKPOINT_INTERVAL). None off an
    /// emission boundary. Self-aligning with apply (same epoch/total inputs) ⇒ proposer/committee/
    /// apply roots are byte-identical. Cheap range gate avoids I/O on the 159/160 non-emission windows.
    /// Root only: both consumers discarded the rest of the old 4-tuple, and building it materialised
    /// the entire recipient set on every node. The root now comes from the streamed builder (peak RAM
    /// = one shard).
    pub(super) fn compute_window_reward(storage: &crate::storage::Storage, start_height: u64, end_height: u64)
        -> Option<String> {
        const EMISSION_BLOCK_INTERVAL: u64 = 14400;
        if !(start_height..=end_height).any(|h| h > 0 && h % EMISSION_BLOCK_INTERVAL == 0) {
            return None;
        }
        for h in start_height..=end_height {
            // Only a height the schedule actually pays at can carry the window's emission. Without
            // this the scan took the FIRST system_emission TX at ANY height in the window, so a
            // producer of one of the 29 preceding slots could plant an inert decoy TX (rejected at
            // apply, harmless there) and the scan would stop on it and return None — leaving the
            // real emission at the window's last block with no n−f-certified reward_root at all.
            if !matches!(Self::expected_emission_amount(h), EmissionExpectation::Exact(_)) {
                continue;
            }
            let mb = match storage.load_microblock_auto_format(h) { Ok(Some(m)) => m, _ => continue };
            // REVERSE: block apply is last-wins (its Phase-1 loop overwrites deferred_emission_root
            // for every matching TX), so a first-wins scan here would certify a different root than
            // the appliers installed if a producer put two v3 emission TXs in one block.
            for tx in mb.transactions.iter().rev() {
                if tx.from != "system_emission" { continue; }
                let data = match tx.data.as_ref() { Some(d) => d, None => continue };
                let parsed: serde_json::Value = match serde_json::from_str(data) { Ok(p) => p, _ => continue };
                if parsed.get("v").and_then(|v| v.as_u64()) != Some(3) { continue; }
                // Height-derived epoch key, identical to the applier's — never the TX's field. The
                // committee must not certify a root filed under a producer-chosen epoch, or one
                // producer can make n−f overwrite a past epoch's distribution.
                let epoch = Self::emission_mb_index(h);
                // Height-derived, like the epoch key and the mint amount. Reading it from the TX body
                // let a producer that lacks the epoch's eligibility indices (a snapshot-cold-joined
                // node) send total=0, which the schedule gate admits, and make the committee certify
                // reward_root=[0;32] for a fully minted epoch — deterministic, network-wide, no alarm.
                let total = crate::reward_epoch::canonical_total(epoch);
                // None ⇒ this node cannot reproduce the epoch's leaf set (a snapshot joiner whose light
                // bitmaps live below its anchor). Returning a computed-from-nothing root would make it
                // vote AGAINST every emission-window checkpoint; report no root instead so the caller
                // defers.
                let root_hex = match Self::compute_epoch_reward_root(storage, epoch, total, None) {
                    Some((_count, _paid, r)) => r,
                    None => return None,
                };
                // Return the schedule-validated (total, epoch) EVEN when this node cannot recompute
                // the leaf set. The root stays empty — callers that need a real root already treat
                // that as "no root" — but the certified-root adoption at finalization needs `total`
                // to size the epoch, and dropping it here wrote 0, which permanently disabled the
                // leaf-set self-heal (the split returns empty for total==0, so the
                // rebuilt root never matches and the epoch is memoised as unserveable).
                return Some(root_hex);
            }
        }
        None
    }

    /// The producer's inline apply has no journal, so an abandoned block leaves its transactions, mint
    /// and fee credit in live RAM state. There is no safe in-process repair: rebuilding takes no apply
    /// barrier, so it can rewind RAM below the storage tip and wedge the node for good. Fail CLOSED —
    /// stop producing for this process. A restart replays from storage and rebuilds RAM cleanly, which
    /// is the right remedy anyway: the only realistic trigger is a missing signing key.
    pub(super) fn abandon_inline_apply(saved_height: u64, abandoned_height: u64, reason: &str) {
        INLINE_APPLY_UNVOUCHED.store(saved_height.max(1), std::sync::atomic::Ordering::SeqCst);
        println!("[ERR][NODE] inline_apply_abandoned h={} reason={} vouched_to={} action=stop_producing_until_restart",
                 abandoned_height, reason, saved_height);
    }

    /// Checkpoint.reward_root for a window (n−f-certified, [0;32] off an emission boundary).
    /// `Some([0;32])` = this window is not an emission boundary (no root to publish).
    /// `None` = it IS one and this node cannot reproduce the leaf set — the caller must NOT publish.
    ///
    /// Collapsing the second case into `[0;32]` published a well-formed root meaning "this epoch paid
    /// nobody". If enough members were equally blind that root could be certified, and an entire epoch's
    /// emission would be permanently unclaimable — silent fund loss, not a visible reject.
    pub(super) fn compute_window_reward_root(storage: &crate::storage::Storage, start_height: u64, end_height: u64) -> Option<[u8; 32]> {
        match Self::compute_window_reward(storage, start_height, end_height) {
            Some(root_hex) => {
                if root_hex.is_empty() { return Some([0u8; 32]); }
                let b = hex::decode(&root_hex).ok()?;
                if b.len() != 32 { return None; }
                let mut o = [0u8; 32];
                o.copy_from_slice(&b);
                Some(o)
            }
            // compute_window_reward returns None both off-boundary and when the leaf set is underivable.
            // The discriminator MUST be the exact filter its scan loop uses — is there a height in this
            // window the schedule actually pays at. `is_reward_epoch(end_height/90)` was not: it is true
            // at height 14400 while expected_emission_amount(14400) is NoneDue, so the very first
            // epoch boundary after genesis read as "underivable", nobody signalled, and the chain
            // stopped ~4 h in. It also diverges again once the schedule floors to zero.
            None => {
                let pays = (start_height..=end_height).any(|h| {
                    matches!(Self::expected_emission_amount(h), EmissionExpectation::Exact(_))
                });
                if pays { None } else { Some([0u8; 32]) }
            }
        }
    }

    /// Level-1 sub-root for ONE block's committed logs — merkle over its ordered leaves (log_leaf per
    /// (tx_hash, in-block index, contract, data)); `[0;32]` for a log-less block. Deterministic on every
    /// node (same committed logs, same emit order). Stored at apply, folded into the window root at seal.
    pub fn block_logs_root_of(block_logs: &[(String, String, Vec<u8>)]) -> [u8; 32] {
        let leaves: Vec<Vec<u8>> = block_logs.iter().enumerate()
            .map(|(i, (tx, c, d))| qnet_state::wasm_exec::log_leaf(tx, i as u32, c, d)).collect();
        qnet_consensus::checkpoint_bft::logs_merkle_root(&leaves)
    }

    /// Per-block sub-roots across a window in height order — from the stored sub-root, else recomputed
    /// from the block's logs (robust across snapshot/upgrade), else `[0;32]` for a log-less block.
    pub fn collect_window_block_roots(storage: &crate::storage::Storage, start_height: u64, end_height: u64) -> Vec<[u8; 32]> {
        let mut roots = Vec::new();
        let mut h = start_height;
        while h <= end_height {
            let root = match storage.get_block_logs_root(h) {
                Some(r) => r,
                None => {
                    let logs = storage.get_block_logs(h);
                    if logs.is_empty() { [0u8; 32] } else { Self::block_logs_root_of(&logs) }
                }
            };
            roots.push(root);
            h = h.saturating_add(1);
        }
        roots
    }

    /// Checkpoint.logs_root for a window — ACTIVE from genesis (`logs_root_required` gate=0). SHARDED:
    /// a merkle over the per-block sub-roots (`logs_window_root`), so the seal folds ~90 small roots and a
    /// light-client proof touches ONE block, never the whole window. Byte-identical on every node (the
    /// property an n−f QC relies on). Window = [(K-1)*90+1, K*90] is FROZEN; a fresh-genesis-only commitment.
    pub(super) fn compute_window_logs_root(storage: &crate::storage::Storage, start_height: u64, end_height: u64) -> [u8; 32] {
        qnet_consensus::checkpoint_bft::logs_window_root(&Self::collect_window_block_roots(storage, start_height, end_height))
    }

    // Single apply_block_to_state() for ALL paths (startup replay, recovery
    // fast-forward, normal sync) → no replay-vs-live divergence. Caller
    // handles pre-image recording, state_root verify, rollback, deferred
    // side-effect persistence.

    /// Emission macroblock index minted at height `h` (0 = none). Shared by the validator apply
    /// (apply_block_to_state) and the producer-inline apply so total_supply mints byte-identically
    /// on both paths — the producer of an emission block must NOT skip the mint (else its supply
    /// diverges and the checkpoint never reaches n−f).
    pub fn emission_mb_index(h: u64) -> u64 {
        const EMISSION_BLOCK_INTERVAL: u64 = 14400;
        const MICROBLOCKS_PER_MB: u64 = 90;
        let current_epoch = h / EMISSION_BLOCK_INTERVAL;
        if current_epoch >= 2 {
            current_epoch.saturating_sub(2).saturating_add(1).saturating_mul(EMISSION_BLOCK_INTERVAL) / MICROBLOCKS_PER_MB
        } else {
            0
        }
    }

}

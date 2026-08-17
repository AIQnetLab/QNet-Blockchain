//! Reward epochs — single owner of an epoch's root, total and serveability.
//!
//! Epoch E's reward root IS the `reward_root` field of the checkpoint in macroblock `E+MB_PER_EPOCH`.
//! That macroblock is QC-verified before storage, so honest nodes hold identical bytes. Every other
//! reward table is a cache of it.
//!
//! An emission height is always a macroblock boundary (EMISSION_BLOCK_INTERVAL % MACROBLOCK_INTERVAL
//! == 0), so the certifying macroblock always exists and is unique.

use qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;

/// Microblocks between emissions (4 hours at one block per second).
pub const EMISSION_BLOCK_INTERVAL: u64 = 14_400;

/// Macroblocks per reward epoch. Derived, so the const assert below catches a constant drift.
pub const MB_PER_EPOCH: u64 = EMISSION_BLOCK_INTERVAL / MACROBLOCK_INTERVAL;

const _: () = assert!(
    EMISSION_BLOCK_INTERVAL % MACROBLOCK_INTERVAL == 0,
    "an emission height must be a macroblock boundary, or no single macroblock certifies its epoch"
);

/// The emission height that closed epoch `E`.
/// `None` on overflow: `epoch` can reach here from unauthenticated input, and a wrapped value would
/// alias a real height.
#[inline]
pub fn emission_height_of(epoch: u64) -> Option<u64> {
    (epoch / MB_PER_EPOCH).checked_add(1)?.checked_mul(EMISSION_BLOCK_INTERVAL)
}

/// The ONE macroblock index whose sealed checkpoint carries epoch `E`'s reward root.
/// `None` on overflow — an unchecked add here let a wrap-aliased epoch key be written and folded.
#[inline]
pub fn certifying_mb_index(epoch: u64) -> Option<u64> {
    epoch.checked_add(MB_PER_EPOCH)
}

/// The epoch a macroblock certifies, if it certifies one at all.
#[inline]
pub fn epoch_of_emission_mb(mb_index: u64) -> Option<u64> {
    if mb_index >= MB_PER_EPOCH && mb_index % MB_PER_EPOCH == 0 {
        Some(mb_index - MB_PER_EPOCH)
    } else {
        None
    }
}

/// True when `epoch` is a real reward-epoch key rather than an arbitrary number.
#[inline]
pub fn is_reward_epoch(epoch: u64) -> bool {
    epoch % MB_PER_EPOCH == 0
}

/// Amount epoch `E` distributes. A formula over height, NEVER read from a TX — which is what
/// bounds the money rather than only the supply counter. A producer cannot mint the scheduled
/// figure while funding the epoch with one nano, because it does not get to state the figure:
/// every node derives it here, and `select_emission_at` additionally requires the minted amount
/// to equal the same schedule at the same height.
#[inline]
pub fn canonical_total(epoch: u64) -> u64 {
    emission_height_of(epoch)
        .map(qnet_consensus::lazy_rewards::pool1_base_emission_at_height)
        .unwrap_or(0)
}

/// An accepted emission. All fields height-derived, never read from the TX body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EmissionFacts {
    pub epoch: u64,
    /// Amount to mint into total_supply.
    pub amount: u64,
    /// Size of the epoch's claimable distribution.
    pub total: u64,
}

/// THE emission selector — apply, producer-inline and the window recompute all use it, so they
/// cannot disagree on which TX is the block's emission. Last-wins on duplicates.
pub fn select_emission_at(txs: &[qnet_state::Transaction], h: u64) -> Option<EmissionFacts> {
    let expected = match crate::node::BlockchainNode::expected_emission_amount(h) {
        crate::node::EmissionExpectation::Exact(v) => v,
        crate::node::EmissionExpectation::NoneDue => return None,
    };
    let epoch = crate::node::BlockchainNode::emission_mb_index(h);
    txs.iter().rev().find(|tx| {
        tx.tx_type == qnet_state::TransactionType::RewardDistribution
            && tx.from == "system_emission"
            && tx.amount == expected
            // The BODY is what carries the distribution: compute_window_reward_root skips any emission
            // TX without a v3 payload, so accepting one on type+amount alone let a producer mint the
            // full epoch while leaving reward_root zero — and a zero root reads as "this epoch
            // distributed nothing". The epoch would be minted and unclaimable forever, deterministically
            // and with no alarm. Same predicate the window recompute uses, so they cannot drift.
            && tx.data.as_ref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .and_then(|p| p.get("v").and_then(|v| v.as_u64()))
                == Some(3)
    })?;
    Some(EmissionFacts { epoch, amount: expected, total: canonical_total(epoch) })
}

/// What apply may conclude about an epoch. No variant means "credit less" — a node that cannot
/// resolve the root must not produce a different state than one that can.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ApplyRoot {
    /// Certified root. All-zero means the epoch distributed nothing.
    Root([u8; 32]),
    /// Chain rule forbids the claim here. Pure fn of (epoch, height) ⇒ every node agrees. Callers may
    /// SKIP it: the predicate is NOT monotone in epoch (an off-grid number is RuleInvalid at any
    /// height while a higher real epoch is creditable), but an off-grid number is not an epoch and so
    /// forfeits nothing, and the too-early sub-case IS monotone.
    RuleInvalid,
    /// Certifying macroblock missing locally. Not a verdict: abort the block and fetch.
    LocalFault { certifying_mb: u64 },
}

/// The ONLY reward read permitted on a consensus path.
pub fn root_for_apply(
    storage: &crate::storage::Storage,
    epoch: u64,
    block_height: u64,
) -> ApplyRoot {
    let emission_h = match emission_height_of(epoch) {
        Some(h) => h,
        None => return ApplyRoot::RuleInvalid, // overflowed ⇒ not a real epoch
    };
    if !is_reward_epoch(epoch) || block_height <= emission_h {
        return ApplyRoot::RuleInvalid;
    }
    if let Ok(Some(root)) = storage.load_epoch_root(epoch) {
        return ApplyRoot::Root(root);
    }
    // Cache miss: re-derive from the macroblock if this node holds it. Only a genuinely absent
    // macroblock is a fault.
    let certifying_mb = match certifying_mb_index(epoch) {
        Some(m) => m,
        None => return ApplyRoot::RuleInvalid,
    };
    match storage.derive_epoch_root_from_macroblock(epoch) {
        Ok(Some(root)) => ApplyRoot::Root(root),
        _ => ApplyRoot::LocalFault { certifying_mb },
    }
}

/// LtHash lanes for one (epoch, root) pair. Lane addition is order-independent, which is what lets
/// the commitment resume from a stored prefix instead of re-walking the grid.
pub fn epoch_root_lanes(epoch: u64, root: &[u8; 32]) -> [u16; crate::registry_lthash::LANES] {
    use sha3::{Digest, Sha3_256};
    let mut seed = Sha3_256::new();
    Digest::update(&mut seed, b"qnet-reward-epoch-root-v1");
    Digest::update(&mut seed, epoch.to_le_bytes());
    Digest::update(&mut seed, root);
    let d = seed.finalize();
    let mut sb = [0u8; 32];
    sb.copy_from_slice(&d);
    crate::registry_lthash::lanes_from_seed(&sb)
}

/// Commitment over every epoch certified at or below the N-2 macroblock of `up_to_height`.
///
/// `None` = a covered epoch's root is missing here, so this node CANNOT compute the value. Never
/// fold a shorter set: a silently-short digest would be QC-signed and then used as the proof target
/// for a cold join, admitting a set the network never agreed on.
///
/// The N-2 bound is what makes this a consensus value rather than a node-local one: production may
/// run MAX_UNSEALED_WINDOWS ahead of an unsealed macroblock, so "closed by height" would differ
/// between honest nodes. A node that can vote on this window holds macroblock N-2 by construction.
pub fn epoch_root_commitment(storage: &crate::storage::Storage, up_to_height: u64) -> Option<[u8; 32]> {
    let n2 = (up_to_height / MACROBLOCK_INTERVAL).saturating_sub(2);
    let covered = |e: u64| certifying_mb_index(e).map_or(false, |m| m <= n2);
    // Resume from the stored prefix. The fold is append-only — a macroblock is never deleted and its
    // certified root can never change — so a prefix that is still covered is always still correct.
    // Without this the walk is O(chain-height) on every checkpoint, forever.
    let (mut e, mut acc, memo_last) = match storage.load_epoch_fold_head() {
        Some((last, lanes)) if covered(last) => (last + MB_PER_EPOCH, lanes, Some(last)),
        // Grid starts at ZERO: epoch 0 is real (macroblock MB_PER_EPOCH certifies it).
        _ => (0u64, [0u16; crate::registry_lthash::LANES], None),
    };
    let mut last_folded = memo_last;
    while covered(e) {
        let cached = match storage.load_epoch_root(e) {
            Ok(v) => v,
            Err(err) => {
                println!("[ERR][REWARDS] epoch_root_read_failed epoch={} err={:?} action=defer", e, err);
                None
            }
        };
        let root = match cached {
            Some(r) => r,
            // Row absent: derive from the macroblock, which is the authority anyway.
            None => {
                let derived = match storage.derive_epoch_root_from_macroblock(e) {
                    Ok(v) => v,
                    Err(err) => {
                        println!("[ERR][REWARDS] epoch_root_derive_failed epoch={} err={:?} action=defer", e, err);
                        None
                    }
                };
                match derived {
                    Some(r) => r,
                    None => {
                        if last_folded != memo_last {
                            if let Some(l) = last_folded { storage.save_epoch_fold_head(l, &acc); }
                        }
                        return None;
                    }
                }
            }
        };
        let lanes = epoch_root_lanes(e, &root);
        for (a, l) in acc.iter_mut().zip(lanes.iter()) { *a = a.wrapping_add(*l); }
        last_folded = Some(e);
        e += MB_PER_EPOCH;
    }
    if last_folded != memo_last {
        if let Some(l) = last_folded { storage.save_epoch_fold_head(l, &acc); }
    }
    let mut lt = crate::registry_lthash::LtHash::new();
    lt.add(&acc);
    Some(lt.root())
}

/// First covered epoch this node cannot resolve: `(certifying macroblock, absent)`. `absent=false`
/// means the macroblock is stored but unreadable — a LOCAL fault, never something to "repair" by
/// deleting it. A storage error yields `None`: it is transient, and acting on it would destroy data
/// that is fine. Cold path; resumes past the folded prefix.
pub fn first_unresolved_epoch_mb(storage: &crate::storage::Storage, up_to_height: u64) -> Option<(u64, bool)> {
    let n2 = (up_to_height / MACROBLOCK_INTERVAL).saturating_sub(2);
    let covered = |e: u64| certifying_mb_index(e).map_or(false, |m| m <= n2);
    let mut e = match storage.load_epoch_fold_head() {
        Some((last, _)) if covered(last) => last + MB_PER_EPOCH,
        _ => 0u64,
    };
    while let Some(m) = certifying_mb_index(e) {
        if m > n2 { break; }
        match storage.load_epoch_root(e) {
            Ok(Some(_)) => { e += MB_PER_EPOCH; continue; }
            Err(_) => return None,
            Ok(None) => {}
        }
        match storage.derive_epoch_root_from_macroblock(e) {
            Ok(Some(_)) => { e += MB_PER_EPOCH; continue; }
            Err(_) => return None,
            Ok(None) => {
                return match storage.get_macroblock_by_height(m) {
                    Ok(Some(_)) => Some((m, false)),
                    Ok(None) => Some((m, true)),
                    Err(_) => None,
                };
            }
        }
    }
    None
}


/// Every epoch referenced by the claim TXs in `txs`, resolvable at `height`? Err(certifying_mb) names
/// the first that is not. Lets the producer decide BEFORE it mutates anything — its inline apply has
/// no snapshot, so a fault discovered later cannot be undone.
pub fn claims_resolvable(
    storage: &crate::storage::Storage,
    txs: &[qnet_state::Transaction],
    height: u64,
) -> Result<(), u64> {
    for tx in txs {
        if tx.tx_type != qnet_state::TransactionType::RewardDistribution
            || tx.from != "system_rewards_pool" { continue; }
        let data = match tx.data.as_ref() { Some(d) => d, None => continue };
        let parsed: serde_json::Value = match serde_json::from_str(data) { Ok(p) => p, Err(_) => continue };
        let entries = match parsed.get("claims").and_then(|v| v.as_array()) { Some(a) => a, None => continue };
        for e in entries {
            let epoch = match e.get("epoch").and_then(|v| v.as_u64()) { Some(x) => x, None => continue };
            if let ApplyRoot::LocalFault { certifying_mb } = root_for_apply(storage, epoch, height) {
                return Err(certifying_mb);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Must agree with the node's existing height→epoch mapping, else roots are written under one
    /// key and read under another.
    #[test]
    fn epoch_key_matches_the_existing_derivation() {
        for k in 2..10_000u64 {
            let h = EMISSION_BLOCK_INTERVAL * k;
            let expected = crate::node::BlockchainNode::emission_mb_index(h);
            assert_eq!(expected, (k - 1) * MB_PER_EPOCH, "epoch key formula drifted at k={}", k);
            assert_eq!(emission_height_of(expected).unwrap(), h, "height/epoch round-trip broke at k={}", k);
        }
    }

    /// Exactly one macroblock certifies an epoch, and it is the one sealed AT the emission height.
    #[test]
    fn exactly_one_macroblock_certifies_an_epoch() {
        for k in 2..10_000u64 {
            let h = EMISSION_BLOCK_INTERVAL * k;
            let e = crate::node::BlockchainNode::emission_mb_index(h);
            assert_eq!(certifying_mb_index(e).unwrap() * MACROBLOCK_INTERVAL, h,
                       "the certifying macroblock is not the one sealed at the emission height");
            assert_eq!(h % MACROBLOCK_INTERVAL, 0,
                       "an emission height must be a macroblock boundary");
            assert_eq!(epoch_of_emission_mb(certifying_mb_index(e).unwrap()), Some(e),
                       "macroblock→epoch is not the inverse of epoch→macroblock");
        }
    }

    /// A macroblock that is not an epoch boundary certifies nothing — no second claimant.
    #[test]
    fn non_boundary_macroblocks_certify_nothing() {
        for idx in 0..(MB_PER_EPOCH * 5) {
            let certifies = epoch_of_emission_mb(idx).is_some();
            assert_eq!(certifies, idx >= MB_PER_EPOCH && idx % MB_PER_EPOCH == 0,
                       "macroblock {} claims the wrong certification status", idx);
        }
        // The first MB_PER_EPOCH macroblocks close no epoch (emission is delayed one full epoch).
        assert_eq!(epoch_of_emission_mb(0), None);
        assert_eq!(epoch_of_emission_mb(MB_PER_EPOCH - 1), None);
        assert_eq!(epoch_of_emission_mb(MB_PER_EPOCH), Some(0));
    }

    /// Pool solvency rests on one identity: what the emission MINTS into system_rewards_pool at
    /// height h is exactly what the epoch keyed at h distributes. If these ever diverged, the last
    /// claimants of an epoch would hit the fail-closed short-pool path with no way to recover.
    #[test]
    fn the_pool_is_credited_exactly_what_its_epoch_distributes() {
        for k in 2..5_000u64 {
            let h = EMISSION_BLOCK_INTERVAL * k;
            let minted = match crate::node::BlockchainNode::expected_emission_amount(h) {
                crate::node::EmissionExpectation::Exact(v) => v,
                crate::node::EmissionExpectation::NoneDue => continue,
            };
            let epoch = crate::node::BlockchainNode::emission_mb_index(h);
            assert_eq!(emission_height_of(epoch), Some(h),
                       "epoch<->height round trip broke at h={}", h);
            assert_eq!(canonical_total(epoch), minted,
                       "the distribution at epoch {} is not what height {} mints", epoch, h);
        }
    }

    /// The epoch's value is the schedule's value at its emission height — one derivation, no TX input.
    #[test]
    fn canonical_total_is_the_schedule_at_the_emission_height() {
        for k in 2..2_000u64 {
            let e = crate::node::BlockchainNode::emission_mb_index(EMISSION_BLOCK_INTERVAL * k);
            assert_eq!(
                canonical_total(e),
                qnet_consensus::lazy_rewards::pool1_base_emission_at_height(emission_height_of(e).unwrap()),
                "canonical_total drifted from the schedule at epoch {}", e);
        }
    }

    /// Every epoch key the chain can produce is a multiple of MB_PER_EPOCH.
    #[test]
    fn every_produced_epoch_key_is_a_reward_epoch() {
        for k in 2..10_000u64 {
            let e = crate::node::BlockchainNode::emission_mb_index(EMISSION_BLOCK_INTERVAL * k);
            assert!(is_reward_epoch(e), "epoch {} is not on the epoch grid", e);
        }
    }
}

#[cfg(test)]
mod tests_apply_authority {
    use super::*;
    use crate::storage::Storage;

    fn temp_storage() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (st, dir)
    }

    /// THE property of the redesign: a node WITHOUT the certifying macroblock must not decide.
    /// It may not credit and may not skip — either would give a different state_root than a node
    /// that holds it.
    #[test]
    fn missing_macroblock_is_a_fault_not_a_verdict() {
        let (st, _d) = temp_storage();
        let epoch = MB_PER_EPOCH; // first real epoch
        let h = emission_height_of(epoch).unwrap() + 1;

        match root_for_apply(&st, epoch, h) {
            ApplyRoot::LocalFault { certifying_mb } => {
                assert_eq!(Some(certifying_mb), certifying_mb_index(epoch));
            }
            other => panic!("absent root must be a fault, got {:?}", other),
        }

        st.seed_epoch_root_for_test(epoch, [7u8; 32]);
        assert_eq!(root_for_apply(&st, epoch, h), ApplyRoot::Root([7u8; 32]),
                   "with the macroblock stored the verdict is the certified root");
    }

    /// An epoch that distributed nothing is a real answer, not a fault: every node agrees on it.
    #[test]
    fn certified_empty_is_a_verdict() {
        let (st, _d) = temp_storage();
        let epoch = MB_PER_EPOCH;
        st.seed_epoch_root_for_test(epoch, [0u8; 32]);
        assert_eq!(root_for_apply(&st, epoch, emission_height_of(epoch).unwrap() + 1),
                   ApplyRoot::Root([0u8; 32]));
    }

    /// The chain rule is a pure function of (epoch, height), so it never depends on local data.
    #[test]
    fn rule_violations_never_touch_storage() {
        let (st, _d) = temp_storage();
        let epoch = MB_PER_EPOCH;
        // Claimed at or below its own emission height.
        assert_eq!(root_for_apply(&st, epoch, emission_height_of(epoch).unwrap()), ApplyRoot::RuleInvalid);
        // Not on the epoch grid.
        assert_eq!(root_for_apply(&st, epoch + 1, u64::MAX), ApplyRoot::RuleInvalid);
    }

    /// The epoch index is a range scan over the roots, so "listed" implies "has a root".
    #[test]
    fn index_cannot_list_an_epoch_without_a_root() {
        let (st, _d) = temp_storage();
        for e in [MB_PER_EPOCH, MB_PER_EPOCH * 3, MB_PER_EPOCH * 2] {
            st.seed_epoch_root_for_test(e, [1u8; 32]);
        }
        let listed = st.reward_epochs_from(0).expect("scan");
        assert_eq!(listed, vec![MB_PER_EPOCH, MB_PER_EPOCH * 2, MB_PER_EPOCH * 3], "ascending, deduped");
        for e in listed {
            assert!(st.load_epoch_root(e).unwrap().is_some(), "listed epoch {} has no root", e);
        }
    }
}

#[cfg(test)]
mod tests_cache_semantics {
    use super::*;
    use crate::storage::Storage;

    /// Wiping the root cache (what snapshot promotion does) must not change any verdict: the root
    /// re-derives from the macroblock the node already holds.
    #[test]
    fn wiping_the_root_cache_is_recoverable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let epoch = MB_PER_EPOCH;
        let h = emission_height_of(epoch).unwrap() + 1;

        st.seed_epoch_root_for_test(epoch, [9u8; 32]);
        assert_eq!(root_for_apply(&st, epoch, h), ApplyRoot::Root([9u8; 32]));

        // No macroblock stored, so after a wipe there is nothing to re-derive from: a fault, never
        // a silent different answer.
        st.wipe_epoch_root_cache_for_test();
        assert!(matches!(root_for_apply(&st, epoch, h), ApplyRoot::LocalFault { .. }),
                "a wiped cache with no macroblock must fault, not decide");
    }
}

#[cfg(test)]
mod tests_registration_dedup {
    use crate::storage::Storage;

    /// The dedup reseed source must be EXACTLY the registrations, not every registry row: an
    /// activation also writes a row, and reseeding from those rejects an honest registration.
    #[test]
    fn reseed_source_excludes_activation_rows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");

        // An activation-written row (pseudonym), with no registration behind it.
        st.save_node_registration_at_height_burn("act_node", "super", "wallet_a", 1.0, 10, "").unwrap();
        // A real registration.
        st.save_node_registration_at_height_burn("reg_node", "super", "wallet_r", 1.0, 20, "burn").unwrap();
        st.mark_node_registration_origin("reg_node", "wallet_r").unwrap();

        let origins = st.load_registration_origins().expect("origins");
        assert_eq!(origins, vec![("reg_node".to_string(), "wallet_r".to_string())],
                   "only registration-origin rows may seed the dedup map");
        assert!(st.load_confirmed_node_registrations().unwrap().len() >= 2,
                "the registry itself still holds both rows");
    }
}

#[cfg(test)]
mod tests_bitmap_determinism {
    use crate::storage::Storage;

    fn st() -> (Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        let s = Storage::new(d.path().to_str().unwrap()).expect("storage");
        (s, d)
    }

    /// The stored bitmap must not depend on the apply verdict: a node whose in-memory dedup map was
    /// wiped applies a TX another node dedups, and both must still resolve the same bitmap.
    #[test]
    fn first_write_wins_makes_the_value_verdict_independent() {
        let (s, _d) = st();
        s.save_light_bitmap(3, 0, 100, &[0xAA]).unwrap();
        s.save_light_bitmap(3, 0, 101, &[0xBB]).unwrap(); // a second apply must not change it
        assert_eq!(s.load_light_bitmaps(3).unwrap().get(&0).cloned(), Some(vec![0xAA]));
    }

    /// A rolled-back block's bitmap must not survive, or the reorged node resolves a bitmap the
    /// canonical chain never had — and first-write-wins would keep it forever.
    #[test]
    fn rollback_removes_bitmaps_written_above_the_target() {
        let (s, _d) = st();
        s.save_light_bitmap(3, 0, 50_000, &[0x11]).unwrap();  // canonical
        s.save_light_bitmap(3, 1, 60_000, &[0x22]).unwrap();  // written by a block later discarded
        let cleared = s.reconcile_reward_indices_above_epoch(55_000).unwrap();
        assert!(cleared >= 1, "the orphan bitmap must be cleared");
        let bms = s.load_light_bitmaps(3).unwrap();
        assert_eq!(bms.get(&0).cloned(), Some(vec![0x11]), "canonical bitmap kept");
        assert!(bms.get(&1).is_none(), "orphan bitmap removed");
    }
}

#[cfg(test)]
mod tests_commitment {
    use super::*;
    use crate::storage::Storage;

    fn st() -> (Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        (Storage::new(d.path().to_str().unwrap()).expect("storage"), d)
    }

    /// The digest is in Checkpoint::hash, so it must depend ONLY on the head height — never on which
    /// macroblocks this node happens to hold. Production may run ahead of an unsealed macroblock, so
    /// an epoch certified inside the N-2 frontier must not enter the fold.
    #[test]
    fn commitment_ignores_epochs_above_the_n2_frontier() {
        let (s, _d) = st();
        let e = MB_PER_EPOCH; // certified by macroblock 2*MB_PER_EPOCH
        s.seed_epoch_root_for_test(0, [1u8; 32]); // epoch 0 is on the grid and covered here
        s.seed_epoch_root_for_test(e, [5u8; 32]);

        // Head exactly at the certifying macroblock: e is inside N-2, so only epoch 0 folds.
        let at = certifying_mb_index(e).unwrap() * MACROBLOCK_INTERVAL;
        let only_zero = {
            let mut lt = crate::registry_lthash::LtHash::new();
            lt.add(&epoch_root_lanes(0, &[1u8; 32]));
            lt.root()
        };
        assert_eq!(epoch_root_commitment(&s, at), Some(only_zero),
                   "an epoch certified at the head is not yet N-2 settled");

        // Two macroblocks later it is settled and must be folded.
        let after = (certifying_mb_index(e).unwrap() + 2) * MACROBLOCK_INTERVAL;
        assert_ne!(epoch_root_commitment(&s, after), Some(crate::registry_lthash::LtHash::new().root()),
                   "a settled epoch must be committed");
    }

    /// Before any epoch closes every node folds the empty set — equality is trivial and universal.
    #[test]
    fn genesis_commitment_is_the_empty_digest() {
        let (s, _d) = st();
        assert_eq!(epoch_root_commitment(&s, 0), Some(crate::registry_lthash::LtHash::new().root()));
        assert_eq!(epoch_root_commitment(&s, EMISSION_BLOCK_INTERVAL), Some(crate::registry_lthash::LtHash::new().root()));
    }

    /// Order-independent: the same set folds to the same digest regardless of insertion order.
    #[test]
    fn commitment_is_order_independent() {
        let (a, _d1) = st();
        let (b, _d2) = st();
        let e1 = MB_PER_EPOCH;
        let e2 = MB_PER_EPOCH * 2;
        a.seed_epoch_root_for_test(0, [9u8; 32]);
        a.seed_epoch_root_for_test(e1, [1u8; 32]);
        a.seed_epoch_root_for_test(e2, [2u8; 32]);
        b.seed_epoch_root_for_test(e2, [2u8; 32]);
        b.seed_epoch_root_for_test(e1, [1u8; 32]);
        b.seed_epoch_root_for_test(0, [9u8; 32]);
        let h = (certifying_mb_index(e2).unwrap() + 2) * MACROBLOCK_INTERVAL;
        assert_eq!(epoch_root_commitment(&a, h), epoch_root_commitment(&b, h));
    }
}

#[cfg(test)]
mod tests_carry {
    use super::*;
    use crate::storage::Storage;

    fn st() -> (Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        (Storage::new(d.path().to_str().unwrap()).expect("storage"), d)
    }

    /// A gap inside the covered band must be visible, never folded away: a silently-short digest
    /// would be QC-signed and then used as the proof target for a cold join.
    #[test]
    fn commitment_is_none_when_a_covered_epoch_is_missing() {
        let (s, _d) = st();
        let e1 = MB_PER_EPOCH;
        let e2 = MB_PER_EPOCH * 2;
        s.seed_epoch_root_for_test(0, [1u8; 32]);
        // Only the later epoch is present; e1 is covered by the bound but absent.
        s.seed_epoch_root_for_test(e2, [3u8; 32]);
        let h = (certifying_mb_index(e2).unwrap() + 2) * MACROBLOCK_INTERVAL;
        assert!(epoch_root_commitment(&s, h).is_none(),
                "a missing covered epoch must surface as None, not a shorter fold");

        s.seed_epoch_root_for_test(e1, [2u8; 32]);
        assert!(epoch_root_commitment(&s, h).is_some(), "complete set folds");
    }

    /// The empty band is a real value, not a gap.
    #[test]
    fn commitment_is_some_empty_before_any_epoch_closes() {
        let (s, _d) = st();
        assert_eq!(epoch_root_commitment(&s, 0), Some(crate::registry_lthash::LtHash::new().root()));
    }

    /// The cache is a cache: a wiped row re-derives from the macroblock rather than becoming a gap.
    /// With no macroblock either, it is a genuine gap.
    #[test]
    fn missing_row_without_a_macroblock_is_a_gap() {
        let (s, _d) = st();
        let e = MB_PER_EPOCH;
        s.seed_epoch_root_for_test(0, [1u8; 32]);
        s.seed_epoch_root_for_test(e, [4u8; 32]);
        let h = (certifying_mb_index(e).unwrap() + 2) * MACROBLOCK_INTERVAL;
        assert!(epoch_root_commitment(&s, h).is_some());
        s.wipe_epoch_root_cache_for_test();
        assert!(epoch_root_commitment(&s, h).is_none(),
                "no row and no macroblock ⇒ this node cannot compute the value");
    }
}

#[cfg(test)]
mod tests_epoch_zero {
    use super::*;
    use crate::storage::Storage;

    /// Epoch 0 is real — macroblock MB_PER_EPOCH certifies it and the canonical writer stores its
    /// row. A commitment that starts the grid at MB_PER_EPOCH silently omits it while the snapshot
    /// carry folds it, so every cold join fails from the first anchor past that macroblock.
    #[test]
    fn epoch_zero_is_committed() {
        let d = tempfile::tempdir().expect("tempdir");
        let s = Storage::new(d.path().to_str().unwrap()).expect("storage");
        assert_eq!(epoch_of_emission_mb(MB_PER_EPOCH), Some(0), "epoch 0 is on the grid");

        s.seed_epoch_root_for_test(0, [7u8; 32]);
        // n2 = MB_PER_EPOCH ⇒ epoch 0 (certified at MB_PER_EPOCH) is covered.
        let h = (MB_PER_EPOCH + 2) * MACROBLOCK_INTERVAL;
        let folded = epoch_root_commitment(&s, h).expect("complete set");
        assert_ne!(folded, crate::registry_lthash::LtHash::new().root(),
                   "epoch 0 must enter the fold");

        // And its absence must be a gap, not a silently shorter fold.
        s.wipe_epoch_root_cache_for_test();
        assert!(epoch_root_commitment(&s, h).is_none(), "a missing epoch 0 is a gap");
    }
}

#[cfg(test)]
mod tests_key_validation {
    use super::*;

    /// An epoch key that overflows the certifying-macroblock add must be rejected everywhere, not
    /// wrapped into a small index. The wrap let an unauthenticated TX plant a row the carry folds
    /// and the commitment can never reach, permanently denying cold-join.
    #[test]
    fn overflowing_epoch_is_not_a_real_epoch() {
        assert_eq!(certifying_mb_index(u64::MAX), None);
        assert_eq!(certifying_mb_index(u64::MAX - MB_PER_EPOCH + 1), None);
        assert_eq!(certifying_mb_index(0), Some(MB_PER_EPOCH));
        assert_eq!(emission_height_of(u64::MAX), None);
    }

    /// The band test must not do arithmetic on an untrusted epoch.
    #[test]
    fn band_bound_is_expressed_without_adding_to_the_epoch() {
        // Largest epoch a certificate at n2 covers is n2 - MB_PER_EPOCH.
        for n2 in [0u64, MB_PER_EPOCH, MB_PER_EPOCH * 5] {
            let max_covered = n2.saturating_sub(MB_PER_EPOCH);
            if n2 >= MB_PER_EPOCH {
                assert!(certifying_mb_index(max_covered).unwrap() <= n2);
            }
            assert!(certifying_mb_index(max_covered + MB_PER_EPOCH).unwrap() > n2);
        }
    }

    /// Only grid-aligned epochs exist; an off-grid number is not an epoch.
    #[test]
    fn off_grid_epochs_are_rejected() {
        assert!(is_reward_epoch(0));
        assert!(is_reward_epoch(MB_PER_EPOCH));
        assert!(!is_reward_epoch(1));
        assert!(!is_reward_epoch(MB_PER_EPOCH + 1));
        assert!(!is_reward_epoch(u64::MAX));
    }
}

/// Fetch the macroblock a deferred commitment is waiting on. A generic sync nudge cannot reach it:
/// the hole sits at or below the seal frontier, which the forward sync paths never revisit.
pub fn request_epoch_root_repair(storage: &crate::storage::Storage, up_to_height: u64) {
    let (mb, absent) = match first_unresolved_epoch_mb(storage, up_to_height) {
        Some(v) => v,
        None => {
            // The commitment deferred but no repair target could be identified — a storage read
            // failed. Never silent: this defers finality and must be visible.
            println!("[ERR][REWARDS] epoch_root_target_unknown h={} action=defer_no_repair", up_to_height);
            return;
        }
    };
    if !absent {
        // Stored but unreadable. NEVER delete it: a QC-certified macroblock below the weak-
        // subjectivity floor can never be re-fetched, so dropping it turns a stall into a permanent
        // one. This is a local storage fault and needs an operator, not a protocol action.
        println!("[ERR][REWARDS] epoch_root_mb_no_usable_qc h={} mb={} action=operator_resync", up_to_height, mb);
        return;
    }
    println!("[WARN][REWARDS] epoch_root_gap h={} missing_mb={} action=defer+repair", up_to_height, mb);
    if let Some(p2p) = crate::node::try_get_p2p() {
        let p = p2p.clone();
        tokio::spawn(async move { let _ = p.sync_macroblocks_repair(mb, mb).await; });
    }
}

#[cfg(test)]
mod tests_fold_memo {
    use super::*;
    use crate::storage::Storage;

    fn st() -> (Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        (Storage::new(d.path().to_str().unwrap()).expect("storage"), d)
    }

    fn head_for(epochs: u64) -> u64 {
        // Head whose N-2 frontier covers epochs 0..epochs-1 on the grid.
        (certifying_mb_index((epochs - 1) * MB_PER_EPOCH).unwrap() + 2) * MACROBLOCK_INTERVAL
    }

    /// The memo is an optimisation, never a semantic change: warm and cold nodes at the same head
    /// must produce the same QC-signed digest.
    #[test]
    fn warm_memo_equals_cold_walk() {
        let (warm, _dw) = st();
        let (cold, _dc) = st();
        for i in 0..4u64 {
            let (e, r) = (i * MB_PER_EPOCH, [i as u8 + 1; 32]);
            warm.seed_epoch_root_for_test(e, r);
            cold.seed_epoch_root_for_test(e, r);
        }
        let h = head_for(4);
        // Warm it at a shorter head first, so the second call resumes from a stored prefix.
        assert!(epoch_root_commitment(&warm, head_for(2)).is_some());
        assert!(warm.load_epoch_fold_head().is_some(), "prefix persisted");
        assert_eq!(epoch_root_commitment(&warm, h), epoch_root_commitment(&cold, h));
    }

    /// A gap must persist the COMPLETE prefix and, once repaired, resume without skipping the
    /// repaired epoch — a skipped epoch is a digest no peer can reproduce.
    #[test]
    fn gap_persists_prefix_then_resumes_after_repair() {
        let (s, _d) = st();
        let (full, _df) = st();
        for i in 0..4u64 {
            full.seed_epoch_root_for_test(i * MB_PER_EPOCH, [i as u8 + 1; 32]);
        }
        // Epoch 2 missing → defer, but epochs 0..1 are a complete prefix and must be kept.
        for i in [0u64, 1, 3] {
            s.seed_epoch_root_for_test(i * MB_PER_EPOCH, [i as u8 + 1; 32]);
        }
        let h = head_for(4);
        assert!(epoch_root_commitment(&s, h).is_none(), "gap defers");
        let (last, _) = s.load_epoch_fold_head().expect("prefix kept across the gap");
        assert_eq!(last, MB_PER_EPOCH, "prefix stops at the epoch before the gap");
        assert_eq!(first_unresolved_epoch_mb(&s, h), certifying_mb_index(2 * MB_PER_EPOCH).map(|m| (m, true)));

        s.seed_epoch_root_for_test(2 * MB_PER_EPOCH, [3u8; 32]); // repair
        assert_eq!(epoch_root_commitment(&s, h), epoch_root_commitment(&full, h),
                   "resumed fold must equal the full walk");
    }
}

#[cfg(test)]
mod tests_light_bitmap_tiebreak {
    use crate::storage::Storage;

    fn st() -> (Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        (Storage::new(d.path().to_str().unwrap()).expect("storage"), d)
    }

    /// Arrival order is node-local; inclusion height is canonical. A node that sees the later
    /// inclusion first must still converge on the earlier one.
    #[test]
    fn lowest_inclusion_height_wins_regardless_of_arrival_order() {
        let (a, _da) = st();
        let (b, _db) = st();
        a.save_light_bitmap(7, 0, 200, &[0xAA]).expect("write");
        a.save_light_bitmap(7, 0, 100, &[0xBB]).expect("write");
        b.save_light_bitmap(7, 0, 100, &[0xBB]).expect("write");
        b.save_light_bitmap(7, 0, 200, &[0xAA]).expect("write");
        assert_eq!(a.load_light_bitmaps(7).ok(), b.load_light_bitmaps(7).ok(),
                   "both orders converge");
        assert_eq!(a.load_light_bitmaps(7).expect("read").get(&0).cloned(), Some(vec![0xBB]));

        a.save_light_bitmap(7, 0, 300, &[0xCC]).expect("write");
        assert_eq!(a.load_light_bitmaps(7).expect("read").get(&0).cloned(), Some(vec![0xBB]),
                   "a later inclusion never displaces the earlier one");
    }
}

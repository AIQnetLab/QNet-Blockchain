//! Consensus feature gates — coordinated activation heights for protocol-rule changes.
//!
//! A consensus-rule change that is "born active" diverges the instant one node runs it while peers
//! still run the old rule — the cause of the rolling-upgrade halt. Binding the change to an
//! activation HEIGHT lets operators roll out a new binary node-by-node: the new rule stays dormant
//! until `height`, then EVERY node switches at the same height — no cross-version divergence.
//!
//! To ship a rolling-safe consensus change:
//!   1. add `("feature_id", activation_height)` to `ACTIVATIONS` (a coordinated FUTURE height);
//!   2. gate the divergent code: `if feature_gates::is_active(id::FEATURE_ID, height) { new } else { old }`;
//!   3. deploy the binary to all nodes BEFORE `activation_height`.
//! Genesis-active rules need no entry — the default is active.

/// Coordinated activation height for the burn-attestation rule (`burn_attestation_required`):
/// at/after this height a NON-genesis NodeRegistration must carry a 2f+1 genesis burn-attestation
/// quorum (verify_burn_attestation_quorum); genesis identities are always exempt (is_legacy_genesis_node).
/// 0 = active from genesis — correct for a fresh genesis: no Sybil-free window, only the 5 genesis
/// bypass. Raise to a future height ONLY for a rolling upgrade of a live network, or to defer
/// activation until the burn flow (live Solana burn + reachable genesis RPC) is ready for non-genesis
/// onboarding; genesis bootstrap never needs it.
pub const BURN_ATTESTATION_GATE_HEIGHT: u64 = 0;

/// Coordinated activation height for the registry-root rule (`registry_root_required`): at/after this
/// height a checkpoint's `registry_root` (deterministic Super/genesis burn-registry digest over
/// {node_id,wallet,reg_height,burn}) MUST match the validator's independent recompute (consensus
/// content_ok) AND a snapshot's restored node_registry MUST match the anchor macroblock's committed
/// registry_root (snapshot binding). This closes the forgeable-snapshot vector for the burn→wallet
/// binding (an untrusted snapshot server rebinding a burn to its wallet in a transported node_registry).
/// 0 = ACTIVE FROM GENESIS, symmetric with BURN_ATTESTATION_GATE_HEIGHT — full production from the first
/// block, no staging window. Safe because registry_root is a pure function of the single chain-apply
/// writer (save_node_registration_inner: node_id/wallet/reg_height/burn are byte-identical on every
/// node); it deliberately does NOT hash vrf_pk (that key is not co-resident with the srtr_ row, so
/// hashing it would split the digest per node). Binding VRF-key integrity into the digest is a separate
/// follow-up (make vrf_pk_ co-resident with srtr_ first), not a reason to delay the burn-binding defence.
pub const REGISTRY_ROOT_GATE_HEIGHT: u64 = 0;

// The recent-Heartbeat recency rule (prev = cur-1 spans the epoch boundary, the flicker fix) is a
// GENESIS rule — no gate — because it is ALREADY the deployed live-net behavior (a mixed-version net
// stays in agreement without a coordinated flip).

/// Coordinated activation for the light-reward roster cutoff (`light_reg_epoch_roster`), gated on
/// epoch_start. At/after: roster freezes at the commit-window open (epoch_start + 14400 - 50), so a
/// light node registered mid-epoch earns for that epoch — INCLUDING epoch 0 and its own registration
/// epoch. BELOW: legacy epoch_start cutoff (empty epoch-0 roster ⇒ no epoch-0 light bitmap). 0 = ACTIVE
/// FROM GENESIS, symmetric with the other two gates — correct for a fresh genesis so light rewards work
/// from the first epoch. Raise to a future epoch boundary ONLY for a rolling upgrade of a LIVE chain:
/// creator and reader both read this cutoff, so an uncoordinated flip mid-chain would diverge the light
/// bitmap/reward_root. On a fresh genesis all nodes agree from h=0, so no staging window is needed.
pub const LIGHT_REG_EPOCH_ROSTER_GATE_HEIGHT: u64 = 0;

/// Activation for the consensus `logs_root` rule (`logs_root_required`): at/after this height a
/// checkpoint's logs_root (merkle root over the window's committed event logs — native QRC-20/721
/// transfer events AND WASM emit_log, recomputed identically from the deterministic per-block
/// receipts) MUST match the validator's recompute in content_ok, giving trustless light-client
/// transfer proofs. 0 = ACTIVE FROM GENESIS: correct for a fresh-genesis relaunch (identical binaries +
/// deterministic encoding ⇒ byte-identical root on every node from h=0; a mismatch fails content_ok
/// loudly, never silent). Raise to a coordinated future height ONLY to activate on a LIVE chain.
pub const LOGS_ROOT_GATE_HEIGHT: u64 = 0;

/// A light node's identity key is committed by its registration, as a 32-byte hash. Without it the
/// attestation path has nothing to check the device's ping delegation against and rejects every
/// attestation, so no light node can ever be eligible. 0 = ACTIVE FROM GENESIS, correct for a fresh
/// relaunch; light nodes registered BEFORE the activation carry no commitment and must re-register once.
/// ROLLING UPGRADE: raise this to a coordinated future height FIRST. The commitment lands in the light
/// registry row, and `registry_root` hashes that row's `vrf_pk_sha3` for light as well as super — so a
/// mixed fleet at gate 0 computes two different registry roots and forks on content_ok.
pub const LIGHT_KEY_COMMITMENT_GATE_HEIGHT: u64 = 0;

/// Every light shard is owned by three genesis nodes instead of one (`light_shard_backup_owners`),
/// which changes three rules that must flip together, so they share one gate:
///   - a shard's eligibility bitmap is accepted from any of its three owners, not only its own genesis;
///   - the commit window opens 150 blocks before the epoch end, not 50, so the three owners get
///     staggered deadlines instead of one shared 50-block dash;
///   - the roster cutoff moves with the window (`light_roster_cutoff`), so the roster an owner builds
///     its bitmap from is the same one the reward path reads. Left at 50 with a 150-block window, a
///     light node registering in the last 100 blocks before the freeze sits past the bitmap's
///     index_span and silently earns nothing for that epoch.
/// 0 = ACTIVE FROM GENESIS, correct for a fresh relaunch. ROLLING UPGRADE: raise to a coordinated
/// future EPOCH BOUNDARY (a multiple of 14400) first — the tx rule reads block height and the cutoff
/// reads epoch_start, and only on a boundary do the two cross together.
pub const LIGHT_SHARD_BACKUP_OWNERS_GATE_HEIGHT: u64 = 0;

/// Every gate name, spelled ONCE. A gate is asked for by constant, never by a literal, because an
/// unlisted name is genesis-active by design: a typo at a call site would not fail, it would silently
/// turn the new rule on everywhere and fork a half-upgraded fleet. A misspelled constant does not
/// compile.
pub mod id {
    pub const BURN_ATTESTATION_REQUIRED: &str = "burn_attestation_required";
    pub const REGISTRY_ROOT_REQUIRED: &str = "registry_root_required";
    pub const LIGHT_REG_EPOCH_ROSTER: &str = "light_reg_epoch_roster";
    pub const LOGS_ROOT_REQUIRED: &str = "logs_root_required";
    pub const REWARD_EPOCH_ROOT_REQUIRED: &str = "reward_epoch_root_required";
    pub const LIGHT_KEY_COMMITMENT: &str = "light_key_commitment";
    pub const LIGHT_SHARD_BACKUP_OWNERS: &str = "light_shard_backup_owners";
    /// Genesis-active on purpose: it is already the deployed behaviour, so a mixed fleet agrees
    /// without a coordinated flip. Listed here, and only here, so it is still spelled once.
    pub const RECENCY_SPAN_EPOCH: &str = "recency_span_epoch";
}

/// (feature id, activation height). Heights are hardcoded in the binary, so every node agrees
/// without on-chain governance. Genesis-active rules need no entry (the default is active);
/// only rules that must stay dormant until a coordinated height are listed.
const ACTIVATIONS: &[(&str, u64)] = &[
    (id::BURN_ATTESTATION_REQUIRED, BURN_ATTESTATION_GATE_HEIGHT),
    (id::REGISTRY_ROOT_REQUIRED, REGISTRY_ROOT_GATE_HEIGHT),
    (id::LIGHT_REG_EPOCH_ROSTER, LIGHT_REG_EPOCH_ROSTER_GATE_HEIGHT),
    (id::LOGS_ROOT_REQUIRED, LOGS_ROOT_GATE_HEIGHT),
    // ACTIVE FROM GENESIS. The commitment is now a pure function of certified chain data: it walks
    // the epoch grid bounded at N-2 (a voting node holds that macroblock by construction), resolves
    // each root from the certifying macroblock, and returns None on a gap — in which case the
    // emitter DEFERS instead of sealing a placeholder. The comparison and the snapshot carry that
    // proves against it must activate together: with the comparison off the field is QC-signed but
    // validated by nobody, and with the carry off a cold-joined node can never obtain pre-anchor
    // roots (their macroblocks sit below its weak-subjectivity floor).
    (id::REWARD_EPOCH_ROOT_REQUIRED, 0),
    (id::LIGHT_KEY_COMMITMENT, LIGHT_KEY_COMMITMENT_GATE_HEIGHT),
    (id::LIGHT_SHARD_BACKUP_OWNERS, LIGHT_SHARD_BACKUP_OWNERS_GATE_HEIGHT),
];

/// Core gate: active iff `feature` is unlisted (genesis-active default) or `height` has reached
/// its scheduled activation. Pure ⇒ identical on every node at the same height.
fn is_active_at(activations: &[(&str, u64)], feature: &str, height: u64) -> bool {
    match activations.iter().find(|(f, _)| *f == feature) {
        Some((_, activation_height)) => height >= *activation_height,
        None => true,
    }
}

/// True iff the consensus `feature` is active at `height` (see module docs).
pub fn is_active(feature: &str, height: u64) -> bool {
    is_active_at(ACTIVATIONS, feature, height)
}

#[cfg(test)]
mod tests {
    use super::is_active_at;

    #[test]
    fn gate_switches_at_activation_height() {
        let reg = &[("feat_x", 1000u64)][..];
        assert!(!is_active_at(reg, "feat_x", 999), "dormant before activation height");
        assert!(is_active_at(reg, "feat_x", 1000), "active exactly at activation height");
        assert!(is_active_at(reg, "feat_x", 5000), "active after activation height");
    }

    #[test]
    fn unlisted_feature_is_genesis_active() {
        let reg = &[("feat_x", 1000u64)][..];
        assert!(is_active_at(reg, "other", 0), "unlisted feature active from genesis");
    }

    #[test]
    fn production_registry_all_active() {
        // Unlisted rules are genesis-active (default) from height 0.
        assert!(super::is_active("any_current_rule", 0));
    }

    #[test]
    fn burn_attestation_active_from_genesis() {
        // gate=0 ⇒ active from block 0: a non-genesis NodeRegistration needs a 2f+1 genesis
        // burn-attestation immediately. Genesis identities bypass at the call site
        // (is_legacy_genesis_node), not here. (If re-gated to a future height for a rolling
        // upgrade, is_active would be false below it — covered by gate_switches_at_activation_height.)
        assert_eq!(super::BURN_ATTESTATION_GATE_HEIGHT, 0, "active-from-genesis on fresh genesis");
        assert!(super::is_active(super::id::BURN_ATTESTATION_REQUIRED, 0), "active from genesis");
        assert!(super::is_active(super::id::BURN_ATTESTATION_REQUIRED, 1), "active just after genesis");
        // No upper bound — the rule stays active at every block height (this is a HEIGHT, not any
        // registration cap; the network has no limit on the number of registrations).
        assert!(super::is_active(super::id::BURN_ATTESTATION_REQUIRED, u64::MAX), "active at the highest possible height");
    }

    // Every name in `id` is either scheduled in ACTIVATIONS or deliberately genesis-active, and the
    // two sets do not overlap. Without this, adding a constant and forgetting the registry entry ships
    // a rule that is born active on every node - the exact failure gates exist to prevent.
    #[test]
    fn every_gate_name_is_classified() {
        use super::id::*;
        const GENESIS_ACTIVE: &[&str] = &[RECENCY_SPAN_EPOCH];
        const SCHEDULED: &[&str] = &[
            BURN_ATTESTATION_REQUIRED, REGISTRY_ROOT_REQUIRED, LIGHT_REG_EPOCH_ROSTER,
            LOGS_ROOT_REQUIRED, REWARD_EPOCH_ROOT_REQUIRED, LIGHT_KEY_COMMITMENT,
            LIGHT_SHARD_BACKUP_OWNERS,
        ];
        for name in SCHEDULED {
            assert!(super::ACTIVATIONS.iter().any(|(f, _)| f == name),
                    "{} has a constant but no registry entry, so it is silently genesis-active", name);
            assert!(!GENESIS_ACTIVE.contains(name), "{} cannot be both scheduled and genesis-active", name);
        }
        for name in GENESIS_ACTIVE {
            assert!(!super::ACTIVATIONS.iter().any(|(f, _)| f == name),
                    "{} is documented as genesis-active but carries an activation height", name);
        }
        assert_eq!(super::ACTIVATIONS.len(), SCHEDULED.len(),
                   "a registry entry exists that no `id` constant names - it can only be reached by a literal");
        let mut names: Vec<&str> = super::ACTIVATIONS.iter().map(|(f, _)| *f).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "duplicate gate name in ACTIVATIONS: the first entry wins silently");
    }

    #[test]
    fn light_reg_epoch_roster_gate_activation() {
        // gate=0 ⇒ ACTIVE FROM GENESIS (fresh-genesis value, symmetric with burn_attestation/registry_root):
        // the commit-window roster cutoff applies from epoch 0, so a light node earns for its registration
        // epoch and epoch 0. (Re-gate to a future epoch boundary ONLY for a rolling upgrade of a live chain.)
        assert_eq!(super::LIGHT_REG_EPOCH_ROSTER_GATE_HEIGHT, 0, "active-from-genesis on fresh genesis");
        assert!(super::is_active(super::id::LIGHT_REG_EPOCH_ROSTER, 0), "active from genesis (epoch 0)");
        assert!(super::is_active(super::id::LIGHT_REG_EPOCH_ROSTER, 8 * 14_400), "active later too");
        assert!(super::is_active(super::id::LIGHT_REG_EPOCH_ROSTER, u64::MAX), "active at the highest height");
        // recency_span_epoch is NOT gated (genesis rule = deployed behavior) ⇒ unlisted ⇒ always active.
        assert!(super::is_active(super::id::RECENCY_SPAN_EPOCH, 0), "recency is genesis-active (matches deployed HEAD)");
    }
}

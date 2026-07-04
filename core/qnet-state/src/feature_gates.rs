//! Consensus feature gates — coordinated activation heights for protocol-rule changes.
//!
//! A consensus-rule change that is "born active" diverges the instant one node runs it while peers
//! still run the old rule — the cause of the rolling-upgrade halt. Binding the change to an
//! activation HEIGHT lets operators roll out a new binary node-by-node: the new rule stays dormant
//! until `height`, then EVERY node switches at the same height — no cross-version divergence.
//!
//! To ship a rolling-safe consensus change:
//!   1. add `("feature_id", activation_height)` to `ACTIVATIONS` (a coordinated FUTURE height);
//!   2. gate the divergent code: `if feature_gates::is_active("feature_id", height) { new } else { old }`;
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

/// (feature id, activation height). Heights are hardcoded in the binary, so every node agrees
/// without on-chain governance. Genesis-active rules need no entry (the default is active);
/// only rules that must stay dormant until a coordinated height are listed.
const ACTIVATIONS: &[(&str, u64)] = &[
    ("burn_attestation_required", BURN_ATTESTATION_GATE_HEIGHT),
    ("registry_root_required", REGISTRY_ROOT_GATE_HEIGHT),
    ("light_reg_epoch_roster", LIGHT_REG_EPOCH_ROSTER_GATE_HEIGHT),
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
        assert!(super::is_active("burn_attestation_required", 0), "active from genesis");
        assert!(super::is_active("burn_attestation_required", 1), "active just after genesis");
        // No upper bound — the rule stays active at every block height (this is a HEIGHT, not any
        // registration cap; the network has no limit on the number of registrations).
        assert!(super::is_active("burn_attestation_required", u64::MAX), "active at the highest possible height");
    }

    #[test]
    fn light_reg_epoch_roster_gate_activation() {
        // gate=0 ⇒ ACTIVE FROM GENESIS (fresh-genesis value, symmetric with burn_attestation/registry_root):
        // the commit-window roster cutoff applies from epoch 0, so a light node earns for its registration
        // epoch and epoch 0. (Re-gate to a future epoch boundary ONLY for a rolling upgrade of a live chain.)
        assert_eq!(super::LIGHT_REG_EPOCH_ROSTER_GATE_HEIGHT, 0, "active-from-genesis on fresh genesis");
        assert!(super::is_active("light_reg_epoch_roster", 0), "active from genesis (epoch 0)");
        assert!(super::is_active("light_reg_epoch_roster", 8 * 14_400), "active later too");
        assert!(super::is_active("light_reg_epoch_roster", u64::MAX), "active at the highest height");
        // recency_span_epoch is NOT gated (genesis rule = deployed behavior) ⇒ unlisted ⇒ always active.
        assert!(super::is_active("recency_span_epoch", 0), "recency is genesis-active (matches deployed HEAD)");
    }
}

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

/// (feature id, activation height). Empty on this chain — all current rules are genesis-active.
/// Heights are hardcoded in the binary, so every node agrees without on-chain governance.
const ACTIVATIONS: &[(&str, u64)] = &[];

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
        // No scheduled features on this chain ⇒ every gate active from height 0.
        assert!(super::is_active("any_current_rule", 0));
    }
}

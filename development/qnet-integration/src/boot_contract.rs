//! Boot contract: every long-lived subsystem the node depends on declares itself REQUIRED and
//! signs in when its task actually spawns. A grace period after bring-up, an auditor compares the
//! two sets and fails the process on any gap.
//!
//! Why this exists: a subsystem parked behind a branch production never takes compiles, links and
//! logs nothing. Nine background tasks — including the signed-head emitter and block repair — sat
//! that way for months and surfaced only when the chain stopped. A node that cannot run its own
//! required set must not stay in the validator population pretending to be healthy.

use dashmap::DashSet;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Subsystems whose absence degrades the node or the network.
pub mod names {
    pub const SIGNED_HEAD_EMITTER: &str = "signed_head_emitter";
    pub const PEER_CLEANUP: &str = "peer_cleanup";
    pub const BACKGROUND_REPAIR: &str = "background_repair";
    pub const BACKGROUND_HEIGHT_SYNC: &str = "background_height_sync";
    pub const REPUTATION_VALIDATION: &str = "reputation_validation";
    pub const REGIONAL_CLUSTERING: &str = "regional_clustering";
    pub const TX_CACHE_CLEANUP: &str = "tx_cache_cleanup";
    pub const RATE_LIMITER_CLEANUP: &str = "rate_limiter_cleanup";
    pub const STATIC_CACHE_CLEANUP: &str = "static_cache_cleanup";
    pub const QUIC_IDLE_REAPER: &str = "quic_idle_reaper";
    pub const EXTERNAL_IP_RESOLVER: &str = "external_ip_resolver";
    pub const COMMITTEE_LINKS: &str = "committee_links";
    pub const DEVICE_MIGRATION_MONITOR: &str = "device_migration_monitor";
}

static REQUIRED: Lazy<DashSet<&'static str>> = Lazy::new(DashSet::new);
static STARTED: Lazy<DashSet<&'static str>> = Lazy::new(DashSet::new);
static AUDIT_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// Declare a subsystem required for this node's role. Idempotent.
pub fn require(name: &'static str) {
    REQUIRED.insert(name);
}

/// Sign in from inside the spawned task. Call as the first statement of the task body, so the
/// record reflects a task that genuinely runs — not merely a starter function that was called.
pub fn started(name: &'static str) {
    STARTED.insert(name);
    if crate::node::is_info() {
        println!("[INFO][BOOT] subsystem_started name={}", name);
    }
}

/// Declare a required subsystem deliberately not applicable to this node's configuration. Satisfies
/// the contract and says why. Only for a branch that CHOSE not to spawn — never as a catch-all, or
/// the audit stops detecting the unreachable-task defect it exists for.
pub fn skipped(name: &'static str, reason: &str) {
    STARTED.insert(name);
    if crate::node::is_warn() {
        println!("[WARN][BOOT] subsystem_skipped name={} reason={}", name, reason);
    }
}

/// Required but never signed in.
pub fn missing() -> Vec<&'static str> {
    let mut m: Vec<&'static str> = REQUIRED
        .iter()
        .map(|e| *e.key())
        .filter(|n| !STARTED.contains(n))
        .collect();
    m.sort_unstable();
    m
}

/// Spawn the one-shot auditor. `grace` must exceed the slowest required task's own start delay.
/// Fails the process on a gap: a half-started node is worse than an absent one, and the container
/// restart gives the operator a loud, immediate signal instead of a silent months-long degradation.
pub fn spawn_audit(grace: Duration) {
    if AUDIT_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        let missing = missing();
        if missing.is_empty() {
            if crate::node::is_info() {
                println!(
                    "[INFO][BOOT] contract_satisfied required={} started={}",
                    REQUIRED.len(),
                    STARTED.len()
                );
            }
            return;
        }
        println!(
            "[FATAL][BOOT] subsystems_missing count={} names={} action=exit",
            missing.len(),
            missing.join(",")
        );
        let _ = std::io::Write::flush(&mut std::io::stdout());
        std::process::exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_reports_required_minus_started() {
        require("t_alpha");
        require("t_beta");
        STARTED.insert("t_alpha");
        let m = missing();
        assert!(m.contains(&"t_beta"));
        assert!(!m.contains(&"t_alpha"));
    }
}

#[cfg(test)]
mod tests_contract_semantics {
    use super::*;

    /// `skipped` satisfies the contract for a branch that deliberately did not spawn. If it ever
    /// stopped doing so, a legitimately-inapplicable subsystem would kill the process at boot.
    #[test]
    fn skipped_satisfies_the_contract() {
        require("t_skip_case");
        skipped("t_skip_case", "unit_test");
        assert!(!missing().contains(&"t_skip_case"));
    }

    /// A required subsystem that never signs in MUST be reported. This is the whole point: nine
    /// background tasks sat unreachable for months precisely because nothing asserted this.
    #[test]
    fn never_started_is_reported() {
        require("t_never_started");
        assert!(missing().contains(&"t_never_started"));
    }
}

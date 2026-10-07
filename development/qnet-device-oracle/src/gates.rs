//! Multiplicity gates (plan-technical R8, section 10) and the independent signals that corroborate a
//! second strike (9.3). The oracle is the one place that decides whether a gate holds a node back: in
//! log-only mode a high value is logged and reported as `gate_observed`, while the lease statement says
//! `ok`, so nodes never need a switch of their own.

use serde::{Deserialize, Serialize};

use crate::lease::DAY;
use crate::types::{Gate, Platform, Prov, Reason};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Gates {
    pub enforce: bool,
    /// iOS: attested keys per device over 30 days (R); an honest device with key rotation shows about 2.
    pub metric_bound: u32,
    /// Android: certificates issued to the device in 30 days (B), from the provisioning information.
    pub certs_bound: u32,
}

impl Default for Gates {
    fn default() -> Self {
        Gates { enforce: false, metric_bound: 4, certs_bound: 100 }
    }
}

/// Metric at or above this, measured inside the same 30 days, corroborates a second strike on iOS.
pub const CORROBORATING_METRIC: u32 = 3;
/// `recentDeviceActivity` level at or above this corroborates a second strike on Android.
pub const CORROBORATING_ACTIVITY: u8 = 3;
pub const METRIC_WINDOW: u64 = 30 * DAY;

impl Gates {
    pub fn observe(&self, platform: Platform, prov: Prov, metric: Option<u32>, certs: Option<u32>) -> Gate {
        match platform {
            Platform::Ios => match metric {
                Some(m) if m > self.metric_bound => Gate::MetricHigh,
                Some(_) => Gate::Ok,
                None => Gate::Na,
            },
            Platform::Android => match (prov, certs) {
                (Prov::Rkp, Some(c)) if c > self.certs_bound => Gate::CertsHigh,
                (Prov::Rkp, Some(_)) => Gate::Ok,
                _ => Gate::Na,
            },
        }
    }

    /// The gate value the lease statement carries.
    pub fn in_statement(&self, observed: Gate) -> Gate {
        if !self.enforce && observed.is_high() {
            Gate::Ok
        } else {
            observed
        }
    }

    pub fn holds_back(&self, observed: Gate) -> bool {
        self.enforce && observed.is_high()
    }
}

pub fn gate_reason(observed: Gate) -> Option<Reason> {
    match observed {
        Gate::MetricHigh => Some(Reason::MetricHigh),
        Gate::CertsHigh => Some(Reason::CertsHigh),
        _ => None,
    }
}

pub fn corroborated_ios(metric: Option<u32>, metric_at: u64, now: u64) -> bool {
    matches!(metric, Some(m) if m >= CORROBORATING_METRIC) && now < metric_at + METRIC_WINDOW
}

pub fn corroborated_android(activity_level: Option<u8>, certs_high: bool, att_key_multi: bool) -> bool {
    matches!(activity_level, Some(l) if l >= CORROBORATING_ACTIVITY) || certs_high || att_key_multi
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_above_the_bound_is_high_and_log_only_mode_reports_ok() {
        let g = Gates::default();
        assert_eq!(g.observe(Platform::Ios, Prov::Na, Some(4), None), Gate::Ok);
        let high = g.observe(Platform::Ios, Prov::Na, Some(5), None);
        assert_eq!(high, Gate::MetricHigh);
        assert_eq!(g.in_statement(high), Gate::Ok);
        assert!(!g.holds_back(high));
        let e = Gates { enforce: true, ..Gates::default() };
        assert_eq!(e.in_statement(high), Gate::MetricHigh);
        assert!(e.holds_back(high));
        assert_eq!(g.observe(Platform::Ios, Prov::Na, None, None), Gate::Na);
    }

    #[test]
    fn certs_gate_applies_to_remote_provisioned_chains_only() {
        let g = Gates::default();
        assert_eq!(g.observe(Platform::Android, Prov::Rkp, None, Some(101)), Gate::CertsHigh);
        assert_eq!(g.observe(Platform::Android, Prov::Rkp, None, Some(100)), Gate::Ok);
        assert_eq!(g.observe(Platform::Android, Prov::Factory, None, Some(1000)), Gate::Na);
    }

    #[test]
    fn corroboration_needs_a_recent_high_metric_or_an_android_signal() {
        let now = 1_790_000_000;
        assert!(corroborated_ios(Some(3), now - DAY, now));
        assert!(!corroborated_ios(Some(2), now, now));
        assert!(!corroborated_ios(Some(9), now - 31 * DAY, now));
        assert!(corroborated_android(Some(3), false, false));
        assert!(!corroborated_android(Some(2), false, false));
        assert!(corroborated_android(None, true, false));
        assert!(corroborated_android(None, false, true));
    }
}

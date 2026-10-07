//! Rate limits (plan-technical R6). Per node they only guard vendor quota; the real limits sit on the
//! hardware key and, on Android, the attestation key. Per-IP counters live in memory only.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;

use crate::lease::{DAY, HOUR};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct LimitParams {
    pub node_per_day: usize,
    pub node_per_30d: usize,
    pub rebinds_per_key_day: usize,
    pub foreign_per_att_key_day: usize,
    pub ip_per_hour: usize,
}

impl Default for LimitParams {
    fn default() -> Self {
        LimitParams { node_per_day: 6, node_per_30d: 20, rebinds_per_key_day: 1, foreign_per_att_key_day: 2, ip_per_hour: 30 }
    }
}

/// Event times inside a window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Times(pub Vec<u64>);

impl Times {
    /// `Err(retry_at)` when `limit` events already fall inside `window`.
    pub fn check(&self, limit: usize, window: u64, now: u64) -> Result<(), u64> {
        let mut live: Vec<u64> = self.0.iter().copied().filter(|&t| t + window > now).collect();
        if limit == 0 {
            return Err(now + window);
        }
        if live.len() < limit {
            return Ok(());
        }
        live.sort_unstable();
        Err(live[live.len() - limit] + window)
    }

    pub fn record(&mut self, now: u64, keep: u64) {
        self.0.push(now);
        self.0.retain(|&t| t + keep > now);
    }
}

/// Node bindings: 6 a day and 20 in 30 days; self-reclaims are not counted.
pub fn check_node(t: &Times, lp: &LimitParams, now: u64) -> Result<(), u64> {
    let a = t.check(lp.node_per_day, DAY, now);
    let b = t.check(lp.node_per_30d, 30 * DAY, now);
    match (a, b) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(x), Ok(())) | (Ok(()), Err(x)) => Err(x),
        (Err(x), Err(y)) => Err(x.max(y)),
    }
}

/// Rebinds of one hardware key: one a day, plus one free switch back to the wallet it left within 24 hours.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KeyRebinds {
    pub times: Times,
    pub last_from: Option<String>,
    pub last_to: Option<String>,
    pub last_at: u64,
    pub free_used_at: u64,
}

impl KeyRebinds {
    /// `Ok(true)` for the free switch back, `Ok(false)` for a counted rebind, `Err(retry_at)` otherwise.
    pub fn check(&self, from: &str, to: &str, lp: &LimitParams, now: u64) -> Result<bool, u64> {
        let back = self.last_from.as_deref() == Some(to) && self.last_to.as_deref() == Some(from);
        if back && now < self.last_at + DAY && self.free_used_at < self.last_at {
            return Ok(true);
        }
        self.times.check(lp.rebinds_per_key_day, DAY, now).map(|()| false)
    }

    pub fn record(&mut self, from: &str, to: &str, free: bool, now: u64) {
        if free {
            self.free_used_at = now;
        } else {
            self.times.record(now, DAY);
        }
        self.last_from = Some(from.to_string());
        self.last_to = Some(to.to_string());
        self.last_at = now;
    }
}

/// In-memory per-IP enrolment counter; addresses are never persisted or logged.
pub struct IpLimiter {
    map: Mutex<HashMap<IpAddr, Vec<u64>>>,
}

impl Default for IpLimiter {
    fn default() -> Self {
        IpLimiter { map: Mutex::new(HashMap::new()) }
    }
}

impl IpLimiter {
    pub fn check_and_record(&self, ip: IpAddr, limit: usize, now: u64) -> Result<(), u64> {
        let mut m = self.map.lock();
        if m.len() > 200_000 {
            m.retain(|_, v| v.iter().any(|&t| t + HOUR > now));
        }
        let v = m.entry(ip).or_default();
        v.retain(|&t| t + HOUR > now);
        if v.len() >= limit {
            let oldest = v.iter().copied().min().unwrap_or(now);
            return Err(oldest + HOUR);
        }
        v.push(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_790_000_000;

    #[test]
    fn node_limit_is_six_a_day_and_twenty_in_thirty_days() {
        let lp = LimitParams::default();
        let mut t = Times::default();
        for i in 0..6 {
            assert!(check_node(&t, &lp, T0 + i).is_ok());
            t.record(T0 + i, 30 * DAY);
        }
        assert_eq!(check_node(&t, &lp, T0 + 10), Err(T0 + DAY));
        assert!(check_node(&t, &lp, T0 + DAY).is_ok());
        let mut t = Times::default();
        for d in 0..20 {
            t.record(T0 + d * DAY, 30 * DAY);
        }
        assert_eq!(check_node(&t, &lp, T0 + 20 * DAY), Err(T0 + 30 * DAY));
    }

    #[test]
    fn one_rebind_a_day_plus_one_free_switch_back() {
        let lp = LimitParams::default();
        let mut k = KeyRebinds::default();
        assert_eq!(k.check("a", "b", &lp, T0), Ok(false));
        k.record("a", "b", false, T0);
        assert_eq!(k.check("b", "c", &lp, T0 + 60), Err(T0 + DAY));
        assert_eq!(k.check("b", "a", &lp, T0 + 60), Ok(true), "switching back is free once");
        k.record("b", "a", true, T0 + 60);
        assert_eq!(k.check("a", "b", &lp, T0 + 120), Err(T0 + DAY), "the free switch is used");
        let mut k2 = KeyRebinds::default();
        k2.record("a", "b", false, T0);
        assert!(k2.check("b", "a", &lp, T0 + DAY).is_ok());
        assert_eq!(k2.check("b", "a", &lp, T0 + DAY), Ok(false), "after 24 hours it is a normal rebind");
    }

    #[test]
    fn attestation_key_allows_two_foreign_claims_a_day() {
        let lp = LimitParams::default();
        let mut t = Times::default();
        t.record(T0, DAY);
        t.record(T0 + 1, DAY);
        assert_eq!(t.check(lp.foreign_per_att_key_day, DAY, T0 + 2), Err(T0 + DAY));
    }

    #[test]
    fn ip_limit_counts_per_hour_in_memory() {
        let l = IpLimiter::default();
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        for i in 0..30 {
            assert!(l.check_and_record(ip, 30, T0 + i).is_ok());
        }
        assert_eq!(l.check_and_record(ip, 30, T0 + 40), Err(T0 + HOUR));
        assert!(l.check_and_record(ip, 30, T0 + HOUR).is_ok());
    }
}

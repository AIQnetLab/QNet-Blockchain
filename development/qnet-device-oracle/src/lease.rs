//! The device slot lease (plan-technical section 9), as pure decisions over a slot read. The service does
//! the vendor I/O around it; everything here is deterministic given the read, the time and `GenSource`.
//!
//! Slot value `g = 2·b1 + b0`: 0 = never used or reset, 1..=3 = a generation the oracle chose at random.
//! Android adds the hold flag (third recall bit); iOS has no hold.

use serde::{Deserialize, Serialize};

use crate::civil::month_start;
use crate::types::{Effective, Gate, LeaseKind, Platform, Prov, Reason, State, Trust};

pub const HOUR: u64 = 3600;
pub use crate::civil::DAY;

#[derive(Clone, Debug)]
pub struct Params {
    /// Refresh interval, the interval inside the first period after a claim, and the grace after it.
    pub t: u64,
    pub t_first: u64,
    pub grace: u64,
    pub first_period: u64,
    /// Lease of factory-provisioned chains and of verdicts without the strong or licence signal.
    pub short_lease: u64,
    pub suspect_lease: u64,
    pub outage_cap: u64,
    /// Margin added to an outage extension so the lease outlives the next retry.
    pub outage_step: u64,
    pub strike_window: u64,
    pub anomaly_window: u64,
    pub anomalies_for_suspect: usize,
    pub pause: u64,
    pub hold_max: u64,
    pub released_keep: u64,
}

impl Params {
    /// `background_tokens`: the platforms produce vendor tokens in a background wake, so refreshes are
    /// frequent and silent; otherwise the longer interval applies on every platform.
    pub fn new(background_tokens: bool) -> Self {
        let (t, t_first, grace) = if background_tokens {
            (7 * DAY, 2 * DAY, 3 * DAY)
        } else {
            (14 * DAY, 14 * DAY, 7 * DAY)
        };
        Params {
            t,
            t_first,
            grace,
            first_period: 14 * DAY,
            short_lease: DAY,
            suspect_lease: 12 * HOUR,
            outage_cap: 7 * DAY,
            outage_step: HOUR,
            strike_window: 7 * DAY,
            anomaly_window: 90 * DAY,
            anomalies_for_suspect: 2,
            pause: 30 * DAY,
            hold_max: 30 * DAY,
            released_keep: 30 * DAY,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotRead {
    pub g: u8,
    pub hold: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotWrite {
    pub g: u8,
    pub hold: bool,
}

impl SlotWrite {
    pub fn bits(self) -> (bool, bool) {
        (self.g & 1 == 1, self.g & 2 == 2)
    }
}

pub fn slot_from_bits(b0: bool, b1: bool, hold: bool) -> SlotRead {
    SlotRead { g: (b1 as u8) << 1 | b0 as u8, hold }
}

/// Source of generations: uniform over {1, 2, 3} without `exclude`.
pub trait GenSource {
    fn pick(&mut self, exclude: u8) -> u8;
}

pub struct SysGen;

impl GenSource for SysGen {
    fn pick(&mut self, exclude: u8) -> u8 {
        let allowed: Vec<u8> = (1..=3).filter(|&g| g != exclude).collect();
        let n = allowed.len() as u8;
        // Rejection sampling below a multiple of n keeps the choice uniform.
        let limit = 255 - (255 % n);
        loop {
            let mut b = [0u8; 1];
            aws_lc_rs::rand::fill(&mut b).expect("system randomness");
            if b[0] < limit {
                return allowed[(b[0] % n) as usize];
            }
        }
    }
}

/// The oracle's record of one node's lease.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeLease {
    pub platform: Platform,
    pub prov: Prov,
    pub trust: Trust,
    /// The current device key: `hex(sha3(hw_pub))`, the key itself (hex) and `hex(device_tag)`.
    pub hw_key: String,
    pub hw_pub: String,
    pub device_tag: String,
    pub att_key: Option<String>,
    /// Generation this node last wrote and the one it wrote before that (0 = none).
    pub g: u8,
    pub g_prev: u8,
    /// A write whose outcome is unknown, and the value it replaced.
    pub pending: Option<u8>,
    pub pending_from: u8,
    /// Kept for a self-reclaim after Stop or a wallet switch.
    pub released_g: u8,
    pub released_at: u64,
    pub claimed_at: u64,
    /// Lease end from the last slot read, the outage extension on top of it, and the refresh time.
    pub lease_base: u64,
    pub extension: u64,
    pub refresh_at: u64,
    pub refreshes: u32,
    pub short: bool,
    pub strikes: Vec<u64>,
    pub anomalies: Vec<u64>,
    pub state: State,
    pub check: Option<Reason>,
    pub paused_until: u64,
    /// When this node's pause set the Android hold; 0 = none.
    pub hold_set_at: u64,
    pub gate: Gate,
    pub metric: Option<u32>,
    pub metric_at: u64,
    pub certs_issued: Option<u32>,
    pub att_key_multi: bool,
    pub updated_at: u64,
}

impl NodeLease {
    /// A record for a new binding, before its slot write and state are filled in.
    #[allow(clippy::too_many_arguments)]
    pub fn fresh(
        platform: Platform,
        prov: Prov,
        trust: Trust,
        hw_key: String,
        hw_pub: String,
        device_tag: String,
        att_key: Option<String>,
        now: u64,
    ) -> Self {
        NodeLease {
            platform,
            prov,
            trust,
            hw_key,
            hw_pub,
            device_tag,
            att_key,
            g: 0,
            g_prev: 0,
            pending: None,
            pending_from: 0,
            released_g: 0,
            released_at: 0,
            claimed_at: now,
            lease_base: now,
            extension: 0,
            refresh_at: now,
            refreshes: 0,
            short: false,
            strikes: Vec::new(),
            anomalies: Vec::new(),
            state: State::CheckPending,
            check: None,
            paused_until: 0,
            hold_set_at: 0,
            gate: Gate::Na,
            metric: None,
            metric_at: 0,
            certs_issued: None,
            att_key_multi: false,
            updated_at: now,
        }
    }

    pub fn lease_valid_until(&self) -> u64 {
        self.lease_base.saturating_add(self.extension)
    }

    pub fn strikes_live(&self, now: u64, p: &Params) -> usize {
        self.strikes.iter().filter(|&&t| t + p.strike_window > now).count()
    }

    pub fn anomalies_live(&self, now: u64, p: &Params) -> usize {
        self.anomalies.iter().filter(|&&t| t + p.anomaly_window > now).count()
    }

    /// A running pause, also after the record ended: Stop and re-link never shorten it.
    pub fn is_paused(&self, now: u64) -> bool {
        now < self.paused_until
    }

    /// Whether the node wrote a slot value of its own yet; a claim without a slot read did not.
    pub fn has_own_value(&self) -> bool {
        self.g != 0 || self.pending.is_some()
    }

    /// Clean before an outage: counting normally and not under a live strike.
    pub fn clean(&self, now: u64, p: &Params) -> bool {
        self.state == State::Active && self.strikes_live(now, p) == 0
    }

    /// Drops window entries that can no longer matter.
    pub fn trim(&mut self, now: u64, p: &Params) {
        self.strikes.retain(|&t| t + p.strike_window > now);
        self.anomalies.retain(|&t| t + p.anomaly_window > now);
    }

    /// `active` or `suspect` from the strike and anomaly windows.
    pub fn watched_state(&self, now: u64, p: &Params) -> State {
        if self.strikes_live(now, p) >= 1 || self.anomalies_live(now, p) >= p.anomalies_for_suspect {
            State::Suspect
        } else {
            State::Active
        }
    }

    /// Whether `g` is one of this node's own values: the recorded one or an unconfirmed write.
    fn owns(&self, g: u8) -> bool {
        g != 0 && (g == self.g || self.pending == Some(g))
    }

    /// Records a slot write and its outcome. `g_prev` keeps the node's own previous value, so a later
    /// read of it is a lost write (F5); a write with an unknown outcome stays pending.
    pub fn commit_write(&mut self, read_g: u8, w: SlotWrite, ok: bool) {
        if ok {
            if self.g != 0 {
                self.g_prev = self.g;
            }
            self.g = w.g;
            self.pending = None;
        } else {
            self.pending = Some(w.g);
            self.pending_from = read_g;
        }
    }

    /// Adopts an unconfirmed write that the read shows landed.
    fn adopt_pending(&mut self, read_g: u8) {
        if self.pending == Some(read_g) {
            if self.g != 0 {
                self.g_prev = self.g;
            }
            self.g = read_g;
            self.pending = None;
        }
    }

    /// Sets the lease window after a successful slot read. Live strikes, or the anomalies that make a node
    /// suspect, keep the suspect window under any state: a claim that waits for the next epoch or a check
    /// never lengthens it.
    pub fn renew(&mut self, now: u64, p: &Params) {
        let state = if self.watched_state(now, p) == State::Suspect { State::Suspect } else { self.state };
        let (refresh_at, valid_until) = lease_window(state, self.short, self.claimed_at, now, p);
        self.refresh_at = refresh_at;
        self.lease_base = valid_until;
        self.extension = 0;
    }
}

/// Claim classification of a slot read (plan-technical 9.2, claim rows).
pub fn classify(lease: Option<&NodeLease>, g: u8, now: u64, p: &Params) -> LeaseKind {
    if g == 0 {
        return LeaseKind::ClaimedVirgin;
    }
    if let Some(l) = lease {
        if l.owns(g) || (l.released_g == g && now < l.released_at + p.released_keep) {
            return LeaseKind::SelfReclaim;
        }
    }
    LeaseKind::ClaimedForeign
}

/// R5: the current epoch only for a never-used slot with a never-bound key, or for a self-reclaim.
pub fn effective(kind: LeaseKind, key_new: bool) -> Effective {
    match kind {
        LeaseKind::ClaimedVirgin if key_new => Effective::Now,
        LeaseKind::SelfReclaim => Effective::Now,
        _ => Effective::Next,
    }
}

/// `(refresh_at, lease_valid_until)` after a slot read at `now`.
pub fn lease_window(state: State, short: bool, claimed_at: u64, now: u64, p: &Params) -> (u64, u64) {
    if state == State::Suspect {
        return (now + p.suspect_lease / 2, now + p.suspect_lease);
    }
    if short {
        return (now + p.short_lease / 2, now + p.short_lease);
    }
    let t = if now < claimed_at + p.first_period { p.t_first } else { p.t };
    (now + t, now + t + p.grace)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimPlan {
    pub kind: LeaseKind,
    pub write: SlotWrite,
    pub effective: Effective,
    /// A claim by the install that holds the node's slot value, judged by the refresh rules (`plan_reclaim`).
    pub judged: Option<RefreshOutcome>,
}

/// A claim never refuses an occupied slot: it writes a fresh generation and classifies what it replaced.
/// `reset`: an approved support ticket cleared the slot, so the read counts as never used.
pub fn plan_claim(
    prev: Option<&NodeLease>,
    read: SlotRead,
    reset: bool,
    key_new: bool,
    now: u64,
    p: &Params,
    gen: &mut dyn GenSource,
) -> ClaimPlan {
    let kind = if reset { LeaseKind::ClaimedVirgin } else { classify(prev, read.g, now, p) };
    ClaimPlan {
        kind,
        write: SlotWrite { g: gen.pick(read.g), hold: false },
        effective: effective(kind, key_new),
        judged: None,
    }
}

/// The record a claim by the same install (same device key) is judged against: the live record when it
/// wrote a value of its own, or an ended one inside the keep window as if it still held the value it kept.
/// `None` for another key (a reinstall or another device), or when the record knows no value of its own.
pub fn same_install_probe(prev: &NodeLease, hw_key: &str, now: u64, p: &Params) -> Option<NodeLease> {
    if prev.hw_key != hw_key {
        return None;
    }
    if prev.state != State::Ended {
        return prev.has_own_value().then(|| prev.clone());
    }
    if prev.released_g == 0 || now >= prev.released_at + p.released_keep {
        return None;
    }
    let mut l = prev.clone();
    l.g = prev.released_g;
    l.pending = None;
    Some(l)
}

/// A claim by the install that already holds this node's slot value (`probe` from `same_install_probe`):
/// the read is judged as the record's next refresh would judge it, so claiming again never skips a slot
/// check. Another install's value is a strike and a second one inside the window with corroboration a
/// pause; the node's own or previous value is a self-reclaim, zero an anomaly.
#[allow(clippy::too_many_arguments)]
pub fn plan_reclaim(
    probe: &NodeLease,
    read: SlotRead,
    hold_expired: bool,
    corroborated: bool,
    key_new: bool,
    now: u64,
    p: &Params,
    gen: &mut dyn GenSource,
) -> ClaimPlan {
    let r = plan_refresh(probe, read, hold_expired, corroborated, now, p, gen);
    let kind = match r.outcome {
        RefreshOutcome::Pass | RefreshOutcome::LostWrite => LeaseKind::SelfReclaim,
        RefreshOutcome::Anomaly => LeaseKind::ClaimedVirgin,
        RefreshOutcome::Strike | RefreshOutcome::TwoStrikes => LeaseKind::ClaimedForeign,
        RefreshOutcome::Hold => LeaseKind::None,
    };
    // A claim always writes: the binding it makes starts from a value of its own. A hold that has not
    // run out is never cleared by it (the claim refuses such a read before it gets here).
    let write = r.write.unwrap_or_else(|| SlotWrite { g: gen.pick(read.g), hold: read.hold && !hold_expired });
    ClaimPlan { kind, write, effective: effective(kind, key_new), judged: Some(r.outcome) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshOutcome {
    Pass,
    LostWrite,
    Anomaly,
    Strike,
    TwoStrikes,
    Hold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefreshPlan {
    pub outcome: RefreshOutcome,
    pub write: Option<SlotWrite>,
}

/// Whether a foreign read now would be the second inside the strike window.
pub fn second_strike_pending(l: &NodeLease, now: u64, p: &Params) -> bool {
    l.strikes_live(now, p) >= 1
}

/// Decides a refresh (plan-technical 9.2 refresh rows, 9.3).
/// `hold_expired`: a set hold is past its time and may be cleared with this write.
/// `corroborated`: an independent signal agrees; consulted only on a second foreign read.
#[allow(clippy::too_many_arguments)]
pub fn plan_refresh(
    l: &NodeLease,
    read: SlotRead,
    hold_expired: bool,
    corroborated: bool,
    now: u64,
    p: &Params,
    gen: &mut dyn GenSource,
) -> RefreshPlan {
    if read.hold && !hold_expired {
        return RefreshPlan { outcome: RefreshOutcome::Hold, write: None };
    }
    let clearing_hold = read.hold;
    let g = read.g;
    let rotate = |gen: &mut dyn GenSource, hold: bool| Some(SlotWrite { g: gen.pick(g), hold });

    if !l.has_own_value() {
        // The claim had no slot read (outage, recall not evaluated): this read completes it. Its epoch
        // was already `next`, so neither an unused nor a foreign value is a signal against the node.
        return RefreshPlan { outcome: RefreshOutcome::Pass, write: rotate(gen, false) };
    }
    if l.owns(g) {
        // iOS rotates on every refresh, Android on every second one (recall writes are rationed).
        let due = l.platform == Platform::Ios || l.refreshes % 2 == 1;
        let write = if due || clearing_hold { rotate(gen, false) } else { None };
        return RefreshPlan { outcome: RefreshOutcome::Pass, write };
    }
    let lost = (l.g_prev != 0 && g == l.g_prev) || (l.pending.is_some() && g == l.pending_from);
    if lost {
        return RefreshPlan { outcome: RefreshOutcome::LostWrite, write: rotate(gen, false) };
    }
    if g == 0 {
        return RefreshPlan { outcome: RefreshOutcome::Anomaly, write: rotate(gen, false) };
    }
    if second_strike_pending(l, now, p) && corroborated {
        // The pause carries the hold on Android so the device cannot claim a new node meanwhile.
        let hold = l.platform == Platform::Android;
        return RefreshPlan { outcome: RefreshOutcome::TwoStrikes, write: rotate(gen, hold) };
    }
    RefreshPlan { outcome: RefreshOutcome::Strike, write: rotate(gen, false) }
}

/// Applies a refresh plan. `write_ok` is the vendor write's outcome when the plan wrote.
/// `gate_holds`: an enforced multiplicity gate keeps a gate-caused `check_pending`.
/// `hold_until`: the estimated end of a hold that pauses the node.
#[allow(clippy::too_many_arguments)]
pub fn apply_refresh(
    l: &mut NodeLease,
    read: SlotRead,
    plan: RefreshPlan,
    write_ok: Option<bool>,
    gate_holds: bool,
    hold_until: u64,
    now: u64,
    p: &Params,
) -> Reason {
    l.adopt_pending(read.g);
    if let (Some(w), Some(ok)) = (plan.write, write_ok) {
        l.commit_write(read.g, w, ok);
    }
    l.updated_at = now;
    let was_pending = l.state == State::CheckPending;
    match plan.outcome {
        RefreshOutcome::Hold => {
            l.state = State::Paused;
            l.check = None;
            l.paused_until = hold_until.max(now);
            return Reason::Hold;
        }
        RefreshOutcome::TwoStrikes => {
            l.strikes.push(now);
            l.state = State::Paused;
            l.check = None;
            l.paused_until = now + p.pause;
            if plan.write.map(|w| w.hold).unwrap_or(false) && write_ok == Some(true) {
                l.hold_set_at = now;
            }
            l.trim(now, p);
            return Reason::TwoStrikes;
        }
        RefreshOutcome::Strike => l.strikes.push(now),
        RefreshOutcome::Anomaly => l.anomalies.push(now),
        RefreshOutcome::Pass | RefreshOutcome::LostWrite => {}
    }
    l.trim(now, p);
    l.refreshes = l.refreshes.saturating_add(1);
    let gate_pending = matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh)) && gate_holds;
    if was_pending && gate_pending {
        l.state = State::CheckPending;
    } else {
        l.state = l.watched_state(now, p);
        l.check = None;
    }
    l.paused_until = 0;
    l.renew(now, p);
    match plan.outcome {
        RefreshOutcome::Strike => Reason::Strike,
        RefreshOutcome::Anomaly => Reason::Anomaly,
        _ if was_pending && l.state != State::CheckPending => Reason::CheckPassed,
        _ => Reason::RefreshOk,
    }
}

/// A vendor outage at refresh: a clean lease is extended by the outage length plus a retry margin,
/// capped. Returns whether the lease was extended; a lease that was not clean is left to lapse.
pub fn apply_outage(l: &mut NodeLease, outage_started: u64, now: u64, p: &Params) -> bool {
    if !l.clean(now, p) {
        return false;
    }
    let ext = (now.saturating_sub(outage_started) + p.outage_step).min(p.outage_cap);
    if ext > l.extension {
        l.extension = ext;
    }
    l.updated_at = now;
    true
}

/// Release: the slot is not written as free; the node keeps its value 30 days for a self-reclaim only.
/// `rotated`: the value written with the optional token, which the node keeps instead. The own value
/// before it stays in `g_prev`, so a later claim by the same install that reads it is a lost write.
pub fn apply_release(l: &mut NodeLease, rotated: Option<u8>, now: u64, reason: Reason) {
    let own = rotated.or(l.pending).unwrap_or(l.g);
    let before = match (rotated, l.pending) {
        (Some(_), pending) => pending.unwrap_or(l.g),
        (None, Some(_)) => l.g,
        (None, None) => l.g_prev,
    };
    l.released_g = own;
    l.released_at = now;
    l.g = 0;
    l.g_prev = if before == own { 0 } else { before };
    l.pending = None;
    l.state = State::Ended;
    l.check = Some(reason);
    l.updated_at = now;
}

fn split_yyyymm(yyyymm: u32) -> Option<(i64, u32)> {
    let (y, m) = ((yyyymm / 100) as i64, yyyymm % 100);
    (y >= 2000 && (1..=12).contains(&m)).then_some((y, m))
}

/// End of a hold. The oracle's own record of when it set the hold is exact; otherwise the recall write
/// date has month granularity, and the hold ends `hold_max` after the start of the write month, so it
/// never lasts longer than `hold_max` (plan: Android hold ≤ 30 days).
pub fn hold_until(exact_set_at: Option<u64>, write_month: Option<u32>, now: u64, p: &Params) -> u64 {
    if let Some(t) = exact_set_at {
        return t + p.hold_max;
    }
    if let Some((y, m)) = write_month.and_then(split_yyyymm) {
        return month_start(y, m) + p.hold_max;
    }
    now + p.hold_max
}

pub fn hold_expired(exact_set_at: Option<u64>, write_month: Option<u32>, now: u64, p: &Params) -> bool {
    if exact_set_at.is_none() && write_month.and_then(split_yyyymm).is_none() {
        return false;
    }
    now >= hold_until(exact_set_at, write_month, now, p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::civil::year_month;

    /// Deterministic generations: always the smallest allowed value.
    struct Low;
    impl GenSource for Low {
        fn pick(&mut self, exclude: u8) -> u8 {
            (1..=3).find(|&g| g != exclude).unwrap()
        }
    }

    const T0: u64 = 1_790_000_000;

    fn p() -> Params {
        Params::new(true)
    }

    fn lease(platform: Platform, g: u8) -> NodeLease {
        let mut l = NodeLease {
            platform,
            prov: if platform == Platform::Ios { Prov::Na } else { Prov::Rkp },
            trust: Trust::Store,
            hw_key: "aa".repeat(32),
            hw_pub: String::new(),
            device_tag: "bb".repeat(32),
            att_key: None,
            g,
            g_prev: 0,
            pending: None,
            pending_from: 0,
            released_g: 0,
            released_at: 0,
            claimed_at: T0,
            lease_base: 0,
            extension: 0,
            refresh_at: 0,
            refreshes: 0,
            short: false,
            strikes: vec![],
            anomalies: vec![],
            state: State::Active,
            check: None,
            paused_until: 0,
            hold_set_at: 0,
            gate: Gate::Ok,
            metric: None,
            metric_at: 0,
            certs_issued: None,
            att_key_multi: false,
            updated_at: T0,
        };
        l.renew(T0, &p());
        l
    }

    fn read(g: u8) -> SlotRead {
        SlotRead { g, hold: false }
    }

    // ---- claim rows ----

    #[test]
    fn claim_on_never_used_slot_is_virgin_and_current_epoch_for_a_new_key() {
        let plan = plan_claim(None, read(0), false, true, T0, &p(), &mut Low);
        assert_eq!(plan.kind, LeaseKind::ClaimedVirgin);
        assert_eq!(plan.effective, Effective::Now);
        assert_ne!(plan.write.g, 0);
        assert!(!plan.write.hold);
    }

    #[test]
    fn claim_on_never_used_slot_with_a_known_key_waits_for_the_next_epoch() {
        let plan = plan_claim(None, read(0), false, false, T0, &p(), &mut Low);
        assert_eq!(plan.kind, LeaseKind::ClaimedVirgin);
        assert_eq!(plan.effective, Effective::Next);
    }

    #[test]
    fn claim_reading_own_generation_is_a_self_reclaim() {
        let l = lease(Platform::Ios, 2);
        let plan = plan_claim(Some(&l), read(2), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.kind, LeaseKind::SelfReclaim);
        assert_eq!(plan.effective, Effective::Now);
        assert_ne!(plan.write.g, 2, "a claim always writes a value other than the one it read");
    }

    #[test]
    fn claim_reading_an_unconfirmed_own_write_is_a_self_reclaim() {
        let mut l = lease(Platform::Android, 1);
        l.pending = Some(3);
        assert_eq!(classify(Some(&l), 3, T0, &p()), LeaseKind::SelfReclaim);
    }

    #[test]
    fn claim_reading_released_generation_is_a_self_reclaim_for_30_days_only() {
        let mut l = lease(Platform::Ios, 3);
        apply_release(&mut l, None, T0, Reason::Released);
        assert_eq!(l.g, 0);
        assert_eq!(l.released_g, 3);
        assert_eq!(classify(Some(&l), 3, T0 + 29 * DAY, &p()), LeaseKind::SelfReclaim);
        assert_eq!(classify(Some(&l), 3, T0 + 30 * DAY, &p()), LeaseKind::ClaimedForeign);
    }

    #[test]
    fn claim_reading_another_generation_is_foreign_and_next_epoch() {
        let l = lease(Platform::Ios, 1);
        let plan = plan_claim(Some(&l), read(2), false, true, T0, &p(), &mut Low);
        assert_eq!(plan.kind, LeaseKind::ClaimedForeign);
        assert_eq!(plan.effective, Effective::Next);
        assert_ne!(plan.write.g, 2);
        let fresh = plan_claim(None, read(3), false, true, T0, &p(), &mut Low);
        assert_eq!(fresh.kind, LeaseKind::ClaimedForeign);
    }

    #[test]
    fn claim_with_approved_reset_counts_as_never_used() {
        let plan = plan_claim(None, SlotRead { g: 2, hold: true }, true, true, T0, &p(), &mut Low);
        assert_eq!(plan.kind, LeaseKind::ClaimedVirgin);
        assert_eq!(plan.effective, Effective::Now);
        assert!(!plan.write.hold, "the reset clears the hold with the claim write");
    }

    #[test]
    fn generations_are_never_zero_and_never_the_excluded_value() {
        let mut g = SysGen;
        for ex in 0..=3u8 {
            for _ in 0..200 {
                let v = g.pick(ex);
                assert!((1..=3).contains(&v) && v != ex);
            }
        }
    }

    // ---- refresh rows ----

    #[test]
    fn refresh_reading_own_value_passes_and_ios_rotates_every_time() {
        let l = lease(Platform::Ios, 2);
        let plan = plan_refresh(&l, read(2), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Pass);
        assert_eq!(plan.write, Some(SlotWrite { g: 1, hold: false }));
    }

    #[test]
    fn android_rotates_on_every_second_refresh() {
        let mut l = lease(Platform::Android, 2);
        let first = plan_refresh(&l, read(2), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(first.outcome, RefreshOutcome::Pass);
        assert_eq!(first.write, None);
        let r = apply_refresh(&mut l, read(2), first, None, false, 0, T0 + DAY, &p());
        assert_eq!(r, Reason::RefreshOk);
        let second = plan_refresh(&l, read(2), false, false, T0 + 2 * DAY, &p(), &mut Low);
        assert!(second.write.is_some());
    }

    #[test]
    fn refresh_reading_the_pending_value_adopts_it() {
        let mut l = lease(Platform::Ios, 1);
        l.pending = Some(3);
        l.pending_from = 1;
        let plan = plan_refresh(&l, read(3), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Pass);
        apply_refresh(&mut l, read(3), plan, Some(true), false, 0, T0 + DAY, &p());
        assert_eq!(l.pending, None);
        assert_eq!(l.g, plan.write.unwrap().g);
        assert_eq!(l.g_prev, 3);
    }

    #[test]
    fn refresh_reading_the_previous_value_is_a_lost_write_without_a_strike() {
        let mut l = lease(Platform::Ios, 2);
        l.g_prev = 3;
        let plan = plan_refresh(&l, read(3), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::LostWrite);
        assert!(plan.write.is_some());
        let r = apply_refresh(&mut l, read(3), plan, Some(true), false, 0, T0 + DAY, &p());
        assert_eq!(r, Reason::RefreshOk);
        assert!(l.strikes.is_empty());
        assert_eq!(l.state, State::Active);
    }

    #[test]
    fn refresh_reading_the_value_an_unconfirmed_write_replaced_is_a_lost_write() {
        let mut l = lease(Platform::Android, 2);
        l.pending = Some(1);
        l.pending_from = 3;
        let plan = plan_refresh(&l, read(3), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::LostWrite);
    }

    #[test]
    fn a_zero_read_after_a_virgin_claim_is_an_anomaly_not_a_lost_write() {
        let mut l = lease(Platform::Ios, 2);
        l.g_prev = 0;
        let plan = plan_refresh(&l, read(0), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Anomaly);
    }

    #[test]
    fn a_rotation_keeps_the_previous_own_value_for_the_lost_write_check() {
        let mut l = lease(Platform::Ios, 2);
        let plan = plan_refresh(&l, read(2), false, false, T0 + DAY, &p(), &mut Low);
        apply_refresh(&mut l, read(2), plan, Some(true), false, 0, T0 + DAY, &p());
        assert_eq!((l.g, l.g_prev), (1, 2));
        let lost = plan_refresh(&l, read(2), false, false, T0 + 2 * DAY, &p(), &mut Low);
        assert_eq!(lost.outcome, RefreshOutcome::LostWrite);
        let foreign = plan_refresh(&l, read(3), false, false, T0 + 2 * DAY, &p(), &mut Low);
        assert_eq!(foreign.outcome, RefreshOutcome::Strike);
    }

    #[test]
    fn refresh_reading_zero_is_an_anomaly_and_the_second_in_90_days_makes_suspect() {
        let mut l = lease(Platform::Ios, 2);
        l.g_prev = 1;
        let plan = plan_refresh(&l, read(0), false, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Anomaly);
        let r = apply_refresh(&mut l, read(0), plan, Some(true), false, 0, T0 + DAY, &p());
        assert_eq!(r, Reason::Anomaly);
        assert_eq!(l.state, State::Active, "one anomaly stays creditable and active");
        l.g_prev = 3;
        let now = T0 + 80 * DAY;
        let plan = plan_refresh(&l, read(0), false, false, now, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Anomaly);
        apply_refresh(&mut l, read(0), plan, Some(true), false, 0, now, &p());
        assert_eq!(l.state, State::Suspect);
        assert!(l.state.counts(), "suspect is still creditable");
        assert_eq!(l.lease_valid_until(), now + 12 * HOUR);
    }

    #[test]
    fn anomalies_older_than_90_days_do_not_count() {
        let mut l = lease(Platform::Ios, 2);
        l.anomalies = vec![T0];
        l.g_prev = 1;
        let now = T0 + 91 * DAY;
        let plan = plan_refresh(&l, read(0), false, false, now, &p(), &mut Low);
        apply_refresh(&mut l, read(0), plan, Some(true), false, 0, now, &p());
        assert_eq!(l.state, State::Active);
        assert_eq!(l.anomalies, vec![now]);
    }

    #[test]
    fn first_foreign_read_is_strike_one_suspect_with_a_12_hour_lease() {
        let mut l = lease(Platform::Ios, 2);
        l.g_prev = 1;
        let now = T0 + DAY;
        let plan = plan_refresh(&l, read(3), false, true, now, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Strike, "corroboration alone never pauses on a first strike");
        assert_ne!(plan.write.unwrap().g, 3);
        let r = apply_refresh(&mut l, read(3), plan, Some(true), false, 0, now, &p());
        assert_eq!(r, Reason::Strike);
        assert_eq!(l.state, State::Suspect);
        assert_eq!(l.lease_valid_until(), now + 12 * HOUR);
        assert_eq!(l.refresh_at, now + 6 * HOUR);
    }

    #[test]
    fn second_foreign_read_without_corroboration_stays_suspect() {
        let mut l = lease(Platform::Android, 2);
        l.strikes = vec![T0 + DAY];
        l.state = State::Suspect;
        l.g_prev = 1;
        let now = T0 + 3 * DAY;
        let plan = plan_refresh(&l, read(3), false, false, now, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Strike);
        apply_refresh(&mut l, read(3), plan, Some(true), false, 0, now, &p());
        assert_eq!(l.state, State::Suspect);
        assert_eq!(l.strikes.len(), 2);
    }

    #[test]
    fn second_foreign_read_with_corroboration_pauses_30_days_and_android_sets_the_hold() {
        let mut l = lease(Platform::Android, 2);
        l.strikes = vec![T0 + DAY];
        l.state = State::Suspect;
        l.g_prev = 1;
        let now = T0 + 3 * DAY;
        let plan = plan_refresh(&l, read(3), false, true, now, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::TwoStrikes);
        assert!(plan.write.unwrap().hold);
        let r = apply_refresh(&mut l, read(3), plan, Some(true), false, 0, now, &p());
        assert_eq!(r, Reason::TwoStrikes);
        assert_eq!(l.state, State::Paused);
        assert_eq!(l.paused_until, now + 30 * DAY);
        assert_eq!(l.hold_set_at, now);
        assert!(!l.state.counts());
    }

    #[test]
    fn ios_two_strike_pause_writes_no_hold() {
        let mut l = lease(Platform::Ios, 2);
        l.strikes = vec![T0 + DAY];
        l.g_prev = 1;
        let plan = plan_refresh(&l, read(3), false, true, T0 + 2 * DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::TwoStrikes);
        assert!(!plan.write.unwrap().hold);
        apply_refresh(&mut l, read(3), plan, Some(true), false, 0, T0 + 2 * DAY, &p());
        assert_eq!(l.hold_set_at, 0);
    }

    #[test]
    fn a_strike_outside_the_7_day_window_does_not_make_a_second() {
        let mut l = lease(Platform::Android, 2);
        l.strikes = vec![T0];
        l.g_prev = 1;
        let now = T0 + 8 * DAY;
        let plan = plan_refresh(&l, read(3), false, true, now, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Strike);
    }

    #[test]
    fn suspect_returns_to_active_once_the_strike_window_passes() {
        let mut l = lease(Platform::Ios, 2);
        l.strikes = vec![T0];
        l.state = State::Suspect;
        let now = T0 + 8 * DAY;
        let plan = plan_refresh(&l, read(2), false, false, now, &p(), &mut Low);
        apply_refresh(&mut l, read(2), plan, Some(true), false, 0, now, &p());
        assert_eq!(l.state, State::Active);
        assert!(l.strikes.is_empty());
    }

    #[test]
    fn a_set_hold_pauses_the_node_without_writing() {
        let mut l = lease(Platform::Android, 2);
        let now = T0 + DAY;
        let plan = plan_refresh(&l, SlotRead { g: 2, hold: true }, false, false, now, &p(), &mut Low);
        assert_eq!(plan, RefreshPlan { outcome: RefreshOutcome::Hold, write: None });
        let until = now + 10 * DAY;
        let r = apply_refresh(&mut l, SlotRead { g: 2, hold: true }, plan, None, false, until, now, &p());
        assert_eq!(r, Reason::Hold);
        assert_eq!(l.state, State::Paused);
        assert_eq!(l.paused_until, until);
    }

    #[test]
    fn an_expired_hold_is_cleared_with_the_refresh_write() {
        let l = lease(Platform::Android, 2);
        let plan = plan_refresh(&l, SlotRead { g: 2, hold: true }, true, false, T0 + DAY, &p(), &mut Low);
        assert_eq!(plan.outcome, RefreshOutcome::Pass);
        assert_eq!(plan.write.map(|w| w.hold), Some(false));
    }

    #[test]
    fn a_failed_write_stays_pending_and_the_next_read_of_it_passes() {
        let mut l = lease(Platform::Ios, 2);
        let now = T0 + DAY;
        let plan = plan_refresh(&l, read(2), false, false, now, &p(), &mut Low);
        let w = plan.write.unwrap();
        apply_refresh(&mut l, read(2), plan, Some(false), false, 0, now, &p());
        assert_eq!(l.pending, Some(w.g));
        assert_eq!(l.pending_from, 2);
        assert_eq!(l.g, 2);
        // Either value is the node's own next time.
        for g in [2, w.g] {
            let plan = plan_refresh(&l, read(g), false, false, now + DAY, &p(), &mut Low);
            assert_eq!(plan.outcome, RefreshOutcome::Pass);
        }
    }

    #[test]
    fn a_refresh_that_passes_clears_a_non_gate_check_pending() {
        let mut l = lease(Platform::Ios, 2);
        l.state = State::CheckPending;
        l.check = Some(Reason::VerdictFailed);
        let plan = plan_refresh(&l, read(2), false, false, T0 + DAY, &p(), &mut Low);
        let r = apply_refresh(&mut l, read(2), plan, Some(true), true, 0, T0 + DAY, &p());
        assert_eq!(r, Reason::CheckPassed);
        assert_eq!(l.state, State::Active);
    }

    #[test]
    fn an_enforced_gate_keeps_check_pending_through_a_refresh() {
        let mut l = lease(Platform::Ios, 2);
        l.state = State::CheckPending;
        l.check = Some(Reason::MetricHigh);
        let plan = plan_refresh(&l, read(2), false, false, T0 + DAY, &p(), &mut Low);
        let r = apply_refresh(&mut l, read(2), plan, Some(true), true, 0, T0 + DAY, &p());
        assert_eq!(r, Reason::RefreshOk);
        assert_eq!(l.state, State::CheckPending);
        let mut l2 = lease(Platform::Ios, 2);
        l2.state = State::CheckPending;
        l2.check = Some(Reason::MetricHigh);
        let plan = plan_refresh(&l2, read(2), false, false, T0 + DAY, &p(), &mut Low);
        apply_refresh(&mut l2, read(2), plan, Some(true), false, 0, T0 + DAY, &p());
        assert_eq!(l2.state, State::Active, "a log-only gate never holds a node back");
    }

    // ---- lease windows ----

    #[test]
    fn lease_window_uses_the_short_interval_in_the_first_14_days() {
        let p = p();
        assert_eq!(lease_window(State::Active, false, T0, T0 + DAY, &p), (T0 + 3 * DAY, T0 + 6 * DAY));
        let later = T0 + 20 * DAY;
        assert_eq!(lease_window(State::Active, false, T0, later, &p), (later + 7 * DAY, later + 10 * DAY));
        let slow = Params::new(false);
        assert_eq!(lease_window(State::Active, false, T0, later, &slow), (later + 14 * DAY, later + 21 * DAY));
    }

    #[test]
    fn short_leases_last_one_day() {
        assert_eq!(lease_window(State::Active, true, T0, T0, &p()), (T0 + 12 * HOUR, T0 + DAY));
    }

    // ---- outages ----

    #[test]
    fn an_outage_extends_a_clean_lease_by_its_length_capped_at_7_days() {
        let p = p();
        let mut l = lease(Platform::Ios, 2);
        let base = l.lease_base;
        let start = base - DAY;
        assert!(apply_outage(&mut l, start, base, &p));
        assert_eq!(l.lease_valid_until(), base + DAY + HOUR);
        assert!(apply_outage(&mut l, start, base + 20 * DAY, &p));
        assert_eq!(l.lease_valid_until(), base + 7 * DAY);
    }

    #[test]
    fn an_outage_never_extends_a_suspect_or_pending_lease() {
        let p = p();
        let mut l = lease(Platform::Ios, 2);
        l.strikes = vec![T0];
        assert!(!apply_outage(&mut l, T0, T0 + HOUR, &p));
        let mut l2 = lease(Platform::Ios, 2);
        l2.state = State::CheckPending;
        assert!(!apply_outage(&mut l2, T0, T0 + HOUR, &p));
        assert_eq!(l2.extension, 0);
    }

    #[test]
    fn a_successful_read_resets_the_outage_extension() {
        let p = p();
        let mut l = lease(Platform::Ios, 2);
        apply_outage(&mut l, T0, T0 + DAY, &p);
        assert!(l.extension > 0);
        let plan = plan_refresh(&l, read(2), false, false, T0 + 2 * DAY, &p, &mut Low);
        apply_refresh(&mut l, read(2), plan, Some(true), false, 0, T0 + 2 * DAY, &p);
        assert_eq!(l.extension, 0);
    }

    // ---- holds ----

    #[test]
    fn an_exact_hold_record_expires_after_30_days() {
        let p = p();
        assert!(!hold_expired(Some(T0), None, T0 + 29 * DAY, &p));
        assert!(hold_expired(Some(T0), None, T0 + 30 * DAY, &p));
    }

    #[test]
    fn a_month_granular_hold_never_lasts_longer_than_30_days() {
        let p = p();
        // 1_790_000_000 is 2026-09-21.
        assert_eq!(year_month(T0), (2026, 9));
        let end = month_start(2026, 9) + 30 * DAY;
        assert_eq!(year_month(end), (2026, 10), "September has 30 days: the hold ends on 1 October");
        assert!(!hold_expired(None, Some(202609), end - 1, &p));
        assert!(hold_expired(None, Some(202609), end, &p));
        // Written on the first possible day of its month, it lasts exactly 30 days; any later day, less.
        assert!(hold_until(None, Some(202609), T0, &p) - month_start(2026, 9) <= 30 * DAY);
        assert_eq!(hold_until(None, Some(202612), T0, &p), month_start(2026, 12) + 30 * DAY);
        assert!(!hold_expired(None, None, T0 + 400 * DAY, &p), "an undated hold waits for a support reset");
    }

    #[test]
    fn the_first_read_after_a_claim_without_one_completes_the_claim() {
        let p = p();
        for read_g in [0u8, 3] {
            let mut l = lease(Platform::Ios, 0);
            l.state = State::CheckPending;
            l.check = Some(Reason::ServiceUnavailable);
            l.strikes = vec![T0];
            assert!(!l.has_own_value());
            let plan = plan_refresh(&l, read(read_g), false, true, T0 + HOUR, &p, &mut Low);
            assert_eq!(plan.outcome, RefreshOutcome::Pass, "read {} is neither an anomaly nor a strike", read_g);
            let w = plan.write.unwrap();
            assert_ne!(w.g, read_g);
            let r = apply_refresh(&mut l, read(read_g), plan, Some(true), false, 0, T0 + HOUR, &p);
            assert_eq!(r, Reason::CheckPassed);
            assert_eq!((l.g, l.g_prev), (w.g, 0));
            assert_eq!(l.strikes, vec![T0], "no strike is added");
            assert!(l.anomalies.is_empty());
        }
    }

    #[test]
    fn a_pause_outlives_a_release() {
        let mut l = lease(Platform::Ios, 2);
        l.state = State::Paused;
        l.paused_until = T0 + 30 * DAY;
        apply_release(&mut l, None, T0 + DAY, Reason::Released);
        assert_eq!(l.state, State::Ended);
        assert!(l.is_paused(T0 + 2 * DAY));
        assert!(!l.is_paused(T0 + 30 * DAY));
    }

    #[test]
    fn release_forgets_the_generation_for_leasing() {
        let mut l = lease(Platform::Android, 2);
        apply_release(&mut l, Some(3), T0, Reason::Released);
        assert_eq!((l.g, l.released_g, l.state), (0, 3, State::Ended));
        assert_eq!(classify(Some(&l), 2, T0, &p()), LeaseKind::ClaimedForeign);
        assert_eq!(l.g_prev, 2, "the value before the release write is kept for a lost-write read");
    }

    // ---- a claim by the install that holds the node's value ----

    #[test]
    fn a_same_key_reclaim_is_judged_by_the_refresh_rules() {
        let p = p();
        let mut l = lease(Platform::Android, 2);
        l.g_prev = 1;
        let key = l.hw_key.clone();
        let probe = same_install_probe(&l, &key, T0 + DAY, &p).unwrap();
        // Another install's value: a strike, the claim waits for the next epoch.
        let plan = plan_reclaim(&probe, read(3), false, false, false, T0 + DAY, &p, &mut Low);
        assert_eq!((plan.kind, plan.effective, plan.judged), (LeaseKind::ClaimedForeign, Effective::Next, Some(RefreshOutcome::Strike)));
        assert_ne!(plan.write.g, 3);
        // A second one inside the window with corroboration pauses, and Android carries the hold.
        l.strikes = vec![T0 + DAY];
        let plan = plan_reclaim(&l, read(3), false, true, false, T0 + 2 * DAY, &p, &mut Low);
        assert_eq!(plan.judged, Some(RefreshOutcome::TwoStrikes));
        assert!(plan.write.hold);
        // The node's own value, or its previous one, is a self-reclaim; zero is an anomaly.
        let plan = plan_reclaim(&l, read(2), false, false, false, T0 + 2 * DAY, &p, &mut Low);
        assert_eq!((plan.kind, plan.effective, plan.judged), (LeaseKind::SelfReclaim, Effective::Now, Some(RefreshOutcome::Pass)));
        assert_ne!(plan.write.g, 2, "a claim always writes, also where a refresh would ration the write");
        let plan = plan_reclaim(&l, read(1), false, false, false, T0 + 2 * DAY, &p, &mut Low);
        assert_eq!((plan.kind, plan.judged), (LeaseKind::SelfReclaim, Some(RefreshOutcome::LostWrite)));
        let plan = plan_reclaim(&l, read(0), false, false, false, T0 + 2 * DAY, &p, &mut Low);
        assert_eq!((plan.kind, plan.effective, plan.judged), (LeaseKind::ClaimedVirgin, Effective::Next, Some(RefreshOutcome::Anomaly)));
    }

    #[test]
    fn the_same_install_probe_covers_a_live_value_and_a_released_one_inside_the_keep_window() {
        let p = p();
        let mut l = lease(Platform::Ios, 2);
        let key = l.hw_key.clone();
        assert!(same_install_probe(&l, &"cc".repeat(32), T0, &p).is_none(), "another key is a reinstall or another device");
        let mut fresh = lease(Platform::Ios, 0);
        fresh.state = State::CheckPending;
        assert!(same_install_probe(&fresh, &key, T0, &p).is_none(), "a claim without a slot read knows no value");
        apply_release(&mut l, None, T0, Reason::Released);
        let probe = same_install_probe(&l, &key, T0 + 29 * DAY, &p).unwrap();
        assert_eq!((probe.g, probe.pending), (2, None));
        assert!(same_install_probe(&l, &key, T0 + 30 * DAY, &p).is_none(), "past the keep window the value is forgotten");
    }

    #[test]
    fn a_live_strike_keeps_the_suspect_window_under_any_state() {
        let p = p();
        let mut l = lease(Platform::Ios, 2);
        l.strikes = vec![T0];
        l.state = State::PendingNextEpoch;
        l.renew(T0 + HOUR, &p);
        assert_eq!(l.lease_valid_until(), T0 + HOUR + 12 * HOUR);
        l.renew(T0 + 8 * DAY, &p);
        assert_eq!(l.lease_valid_until(), T0 + 8 * DAY + 5 * DAY, "the strike window over, the normal window again");
    }
}

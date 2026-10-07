//! The device record of a light node (A5), kept by all five genesis, and the rules that read it.
//!
//! - `r:{N}` in `light_device`: the record, keyed by the node id; it names the device by its per-network
//!   pseudonymous tag and `hw_key` = hex(sha3(hw_pub)), never by a vendor identifier.
//! - `ldk_{hw_key}` in `light_device_key`: which node a device key serves. One key serves one node at a time.
//! - `ldak_{hex(sha3(attestation key))}` in `light_device_attkey`: remotely provisioned Android attestation
//!   keys, at most one live node each. A factory attestation key is shared by a batch of devices and has no
//!   entry (owner decision O1).
//!
//! An entry is either final (a final statement's record binds the key) or an attestor's reservation (it
//! signed a statement for that node that is not final here yet), which lapses after
//! `KEY_RESERVATION_SECS`. An ended record frees its keys, once a timed pause it keeps has run out.

use serde::{Deserialize, Serialize};

use super::{DeviceState, LeaseKind, Effective, Gate, Op, Platform, Prov, Trust, ROTATION_GRACE_EPOCHS,
            KEY_RESERVATION_SECS, VOTE_TTL_SECS, AWAITING_TTL_SECS, OUTAGE_EXTENSION_CAP_SECS, REFRESH_LATE_SECS};

/// The reason of a pause the revocation list caused (section 6.3). It has no epoch (`until_epoch` 0): it
/// holds the record until a new enrolment, whose chain is checked against the list, replaces it.
pub const REVOKED: &str = "revoked";

/// What a record's state reads on this genesis besides the record, the chain and the clock (A14, section
/// 9.4 of the plan). Node-local and RPC policy only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Local {
    /// The revocation snapshot this genesis holds names a certificate of the record's chain: the record
    /// reads paused at once, before the signed change reaches it.
    pub revoked: bool,
    /// The device oracle has not answered this genesis since this Unix time; 0 while it answers.
    pub oracle_down_since: u64,
}

impl Local {
    /// The running node's view of `r`.
    pub fn of(r: &DeviceRecord) -> Local {
        Local { revoked: super::evidence::revoked_any(&r.serials), oracle_down_since: super::oracle::down_since() }
    }
}

/// What the oracle's lease statement said, kept with the record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseSummary {
    pub kind: LeaseKind,
    pub effective: Effective,
    pub gate: Gate,
    pub issued_at: u64,
    #[serde(default)]
    pub pi_digest: String,
}

/// A signed state change the record carries as proof of its current state (section 6.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateChange {
    pub node_id: String,
    pub state: DeviceState,
    pub state_seq: u64,
    pub until_epoch: u64,
    pub reason: String,
    /// The genesis that caused it and signed it with its consensus key.
    pub signer: String,
    /// Raw ML-DSA-65 signature, hex.
    pub sig: String,
    /// The statement whose record it changes.
    pub stmt_hash: String,
    /// The lease window a refresh renewed (Unix seconds): not signed, the causing genesis's word, as the
    /// window of a statement's lease is (`LeaseProof`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_valid_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_at: Option<u64>,
}

impl StateChange {
    /// A change of the record `r` to be signed by `signer` (the signature is set by the caller).
    pub fn of(r: &DeviceRecord, state: DeviceState, until_epoch: u64, reason: &str, signer: &str) -> StateChange {
        StateChange { node_id: r.node_id.clone(), state, state_seq: r.state_seq + 1, until_epoch, reason: reason.to_string(),
                      signer: signer.to_string(), sig: String::new(), stmt_hash: r.stmt_hash.clone(),
                      lease_valid_until: None, refresh_at: None }
    }

    pub fn preimage(&self) -> String {
        super::messages::state_preimage(&self.node_id, self.state, self.state_seq, self.until_epoch, &self.reason)
    }
}

/// One light node's device record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub node_id: String,
    pub platform: Platform,
    /// hex of the 65-byte device key.
    pub hw_pub: String,
    /// hex(sha3(hw_pub)).
    pub hw_key: String,
    /// hex(sha256(hw_pub)): the iOS key identifier an assertion names.
    pub key_id: String,
    /// hex of the per-network `device_tag`.
    pub device_tag: String,
    pub prov: Prov,
    pub trust: Trust,
    pub op: Op,
    /// The binding sequence the enrolment signed.
    pub seq: u64,
    pub issued_epoch: u64,
    pub effective_epoch: u64,
    pub state: DeviceState,
    #[serde(default)]
    pub state_seq: u64,
    /// The end of a pause; 0 otherwise.
    #[serde(default)]
    pub until_epoch: u64,
    /// The reason of the last state change, or why the record waits in `check_pending`
    /// (`token_missing`, `service_unavailable`, `metric_high`, `certs_high`, …).
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub lease: Option<LeaseSummary>,
    /// Unix seconds, from the oracle's claim.
    #[serde(default)]
    pub lease_valid_until: u64,
    #[serde(default)]
    pub refresh_at: u64,
    pub rotation_due_epoch: u64,
    /// The last iOS assertion counter or Android `hw_seq` this genesis took.
    #[serde(default)]
    pub last_counter: u64,
    #[serde(default)]
    pub att_key: Option<String>,
    #[serde(default)]
    pub certs_issued: Option<u64>,
    #[serde(default)]
    pub serials: Vec<String>,
    /// hex SHA3-256 of the statement preimage; empty on a provisional record.
    #[serde(default)]
    pub stmt_hash: String,
    /// The genesis that took the enrolment and holds the statement's full proof.
    #[serde(default)]
    pub ingress: String,
    /// b64url of the enrolment's challenge nonce (the support reference of its outcome).
    #[serde(default)]
    pub nonce: String,
    #[serde(default)]
    pub rebind_from: Option<String>,
    /// Kept only by the ingress while the statement's quorum or the oracle has not answered: never
    /// counted, never sent to another genesis.
    #[serde(default)]
    pub provisional: bool,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub last_change: Option<StateChange>,
}

impl DeviceRecord {
    pub fn live(&self) -> bool {
        self.state != DeviceState::Ended
    }

    pub fn device_tag_bytes(&self) -> Option<[u8; 32]> {
        hex::decode(&self.device_tag).ok()?.try_into().ok()
    }

    pub fn hw_pub_bytes(&self) -> Option<Vec<u8>> {
        hex::decode(&self.hw_pub).ok().filter(|b| b.len() == 65)
    }

    /// The support reference of the record's enrolment.
    pub fn reference(&self) -> Option<String> {
        let nonce = super::messages::nonce32(&self.nonce)?;
        Some(super::messages::reference(&nonce, &self.device_tag_bytes()?))
    }

    /// The state as of `epoch` (and Unix time `now`), for a node the chain has registered or not.
    /// Transitions that follow from the chain and the clock alone are read, not written, so every genesis
    /// derives the same state from the same record without a message: the registration applied
    /// (`awaiting_registration` → `active` or `pending_next_epoch`), the effective epoch reached, a pause
    /// over, a lapsed lease, an overdue rotation.
    pub fn state_at(&self, registered: bool, epoch: u64, now: u64) -> DeviceState {
        self.state_with(registered, epoch, now, Local::default())
    }

    /// The state every reader on the running node takes (the ping check, the pinger and a wake, the status,
    /// the device routes' answers): `state_at` with this genesis's revocation snapshot and oracle outage.
    pub fn state_now(&self, registered: bool, epoch: u64, now: u64) -> DeviceState {
        self.state_with(registered, epoch, now, Local::of(self))
    }

    /// `state_at` with the node-local facts `local`: a chain the revocation list names reads paused, and a
    /// clean lease the oracle's outage kept from renewing reads live for the outage's length, at most
    /// `OUTAGE_EXTENSION_CAP_SECS` past its end (plan section 9.4: no binding becomes creditable without a
    /// lease read, and none that was clean stops for an outage of up to a week).
    pub fn state_with(&self, registered: bool, epoch: u64, now: u64, local: Local) -> DeviceState {
        if self.provisional { return DeviceState::CheckPending; }
        let s = match self.state {
            DeviceState::AwaitingRegistration if !registered => {
                if now > self.created_at.saturating_add(AWAITING_TTL_SECS) {
                    return DeviceState::Ended;
                }
                return DeviceState::AwaitingRegistration;
            }
            DeviceState::AwaitingRegistration | DeviceState::PendingNextEpoch =>
                if self.effective_epoch <= epoch { DeviceState::Active } else { DeviceState::PendingNextEpoch },
            // A revocation holds until a new enrolment replaces the record.
            DeviceState::Paused if self.reason == REVOKED => DeviceState::Paused,
            // A pause over waits for the next refresh to confirm the device.
            DeviceState::Paused if self.until_epoch <= epoch => DeviceState::CheckPending,
            other => other,
        };
        if s != DeviceState::Ended && local.revoked { return DeviceState::Paused; }
        if s.counts() {
            // A state a refresh set early still counts only from the statement's effective epoch.
            if epoch < self.effective_epoch { return DeviceState::PendingNextEpoch; }
            // A leased record with no window has lapsed: its window arrives unsigned, and a window of 0 never
            // lapsing would keep a record creditable that the oracle can no longer reach (ND-3).
            let lapsed = if self.lease_valid_until == 0 { self.lease.is_some() }
                else { now > self.lease_valid_until.saturating_add(self.outage_grace(now, local.oracle_down_since)) };
            if lapsed {
                return DeviceState::CheckPending;
            }
            if epoch > self.rotation_due_epoch.saturating_add(ROTATION_GRACE_EPOCHS) { return DeviceState::CheckPending; }
        }
        s
    }

    /// How far an oracle outage that began at `down_since` stretches this record's lease: its length so far,
    /// capped, for a lease that was clean (`active`, no strike) and still valid when the outage began.
    pub fn outage_grace(&self, now: u64, down_since: u64) -> u64 {
        if down_since == 0 || self.state != DeviceState::Active || self.lease_valid_until < down_since { return 0; }
        now.saturating_sub(down_since).min(OUTAGE_EXTENSION_CAP_SECS)
    }

    /// A pause holds the record in `epoch`: a timed one until its epoch, a revocation until a new enrolment.
    pub fn paused_at(&self, epoch: u64) -> bool {
        self.state == DeviceState::Paused && (self.until_epoch > epoch || self.reason == REVOKED)
    }

    /// The epoch a timed pause holds the node until, or 0. It outlives the record's end (a Stop does not end
    /// a pause) and carries over to the node's next statement; a revocation has no epoch and does neither,
    /// since a new enrolment's chain is checked against the list.
    pub fn pause_until(&self, epoch: u64) -> u64 {
        if matches!(self.state, DeviceState::Paused | DeviceState::Ended) && self.until_epoch > epoch { self.until_epoch } else { 0 }
    }

    /// The refusal a device route gives while a pause holds the record: `device_slot_paused` with the
    /// pause's epoch (none for a revocation) and the enrolment's support reference.
    pub fn pause_refusal(&self) -> super::DeviceRefusal {
        super::DeviceRefusal {
            paused_until: (self.until_epoch > 0 && self.reason != REVOKED).then_some(self.until_epoch),
            reference: self.reference(),
            ..super::DeviceRefusal::new(super::DeviceReason::SlotPaused)
        }
    }

    /// The window of the next lease refresh the signed status gives the app (Unix seconds): from the
    /// oracle's refresh time, pushed later by a per-node jitter of up to a quarter of the time left, to the
    /// lease's end, or a day from now once the lease lapsed (the refresh is what brings it back). None when
    /// a refresh has nothing to renew: no lease, a provisional or ended record, a node not on chain, or a
    /// pause holding it.
    pub fn refresh_window(&self, registered: bool, epoch: u64, now: u64, local: Local) -> Option<(u64, u64)> {
        if self.provisional || !self.live() || !registered || (self.lease_valid_until == 0 && self.lease.is_none())
            || self.paused_at(epoch) || local.revoked {
            return None;
        }
        // A leased record with no window has lapsed (`state_now`): the refresh that brings it back is due now.
        if self.lease_valid_until == 0 {
            return Some((now, now.saturating_add(REFRESH_LATE_SECS)));
        }
        let start = if self.refresh_at > 0 { self.refresh_at.min(self.lease_valid_until) } else { self.lease_valid_until.saturating_sub(86_400) };
        let quarter = self.lease_valid_until.saturating_sub(start) / 4;
        let jitter = if quarter == 0 { 0 } else {
            let h = super::messages::sha3_256(format!("{}|{}", self.node_id, start).as_bytes());
            u64::from_le_bytes(h[..8].try_into().unwrap_or([0; 8])) % quarter
        };
        let from = start + jitter;
        let to = self.lease_valid_until.max(now.saturating_add(REFRESH_LATE_SECS)).max(from + 1);
        Some((from, to))
    }
}

/// Which of two final statements for one node is the current one: the higher binding sequence; at the
/// same sequence the later epoch; in one epoch a statement with a lease over one without; with leases the
/// later lease; last the higher statement hash, so every genesis picks the same one.
pub fn newer(a: &DeviceRecord, b: &DeviceRecord) -> bool {
    let key = |r: &DeviceRecord| (r.seq, r.issued_epoch, r.lease.is_some(), r.lease.as_ref().map_or(0, |l| l.issued_at),
                                  r.stmt_hash.clone());
    key(a) > key(b)
}

/// An entry of `ldk_` or `ldak_`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyEntry {
    pub node_id: String,
    pub seq: u64,
    /// A final statement's record holds the key; otherwise an attestor's reservation.
    pub final_: bool,
    pub at: u64,
}

impl KeyEntry {
    /// The entry still holds the key for its node, as of `now`: a final one while its record lives (the
    /// caller passes the record's liveness), a reservation for `KEY_RESERVATION_SECS`.
    pub fn holds(&self, record_live: bool, now: u64) -> bool {
        if self.final_ { record_live } else { now <= self.at.saturating_add(KEY_RESERVATION_SECS) }
    }
}

/// What `lki_{hex(key_id)}` keeps of a device key a final statement named: its point and provenance, and
/// the node it last served. An iOS assertion names only the key identifier, and the key may outlive the
/// record of the node it served (a Stop, then another wallet's node in the same install).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownKey {
    pub hw_pub: String,
    pub node_id: String,
    pub platform: Platform,
    pub prov: Prov,
    pub trust: Trust,
    /// The epoch this key must rotate by (R7): set when the key was attested fresh, kept by every later
    /// statement over it (a re-enrolment with the key, a rebind). 0 for an entry written before it was kept.
    #[serde(default)]
    pub rotation_due_epoch: u64,
}

/// An attestor's vote: the device it signed a statement for, at one binding sequence of a node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vote {
    pub hw_key: String,
    pub stmt_hash: String,
    pub at: u64,
}

impl Vote {
    /// Another device at the same node and sequence conflicts with this vote while a statement it covered
    /// could still gather signatures.
    pub fn blocks(&self, hw_key: &str, now: u64) -> bool {
        self.hw_key != hw_key && now <= self.at.saturating_add(VOTE_TTL_SECS)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn rec(seq: u64, epoch: u64, state: DeviceState) -> DeviceRecord {
        DeviceRecord {
            node_id: "light_mobile_6526ab8fd00ff8ca".into(), platform: Platform::Ios, hw_pub: "04".repeat(65),
            hw_key: "aa".repeat(32), key_id: "bb".repeat(32), device_tag: "cc".repeat(32), prov: Prov::Na,
            trust: Trust::Store, op: Op::Enrol, seq, issued_epoch: epoch, effective_epoch: epoch, state, state_seq: 0,
            until_epoch: 0, reason: String::new(), lease: None, lease_valid_until: 0, refresh_at: 0,
            rotation_due_epoch: epoch + 180, last_counter: 0, att_key: None, certs_issued: None, serials: vec![],
            stmt_hash: "dd".repeat(32), ingress: "genesis_node_001".into(), nonce: String::new(), rebind_from: None,
            provisional: false, created_at: 1_800_000_000, updated_at: 1_800_000_000, last_change: None,
        }
    }

    #[test]
    fn the_state_follows_the_chain_and_the_clock() {
        let now = 1_800_000_000;
        // awaiting_registration: until the registration applies, then per the effective epoch.
        let mut r = rec(1, 100, DeviceState::AwaitingRegistration);
        r.effective_epoch = 101;
        assert_eq!(r.state_at(false, 100, now), DeviceState::AwaitingRegistration);
        assert_eq!(r.state_at(true, 100, now), DeviceState::PendingNextEpoch);
        assert_eq!(r.state_at(true, 101, now), DeviceState::Active);
        assert_eq!(r.state_at(false, 100, now + AWAITING_TTL_SECS + 1), DeviceState::Ended, "24 h without a registration");
        // pending_next_epoch counts from its epoch.
        let mut p = rec(1, 100, DeviceState::PendingNextEpoch);
        p.effective_epoch = 101;
        assert_eq!(p.state_at(true, 100, now), DeviceState::PendingNextEpoch);
        assert_eq!(p.state_at(true, 101, now), DeviceState::Active);
        // A pause holds until its epoch, then waits for a refresh.
        let mut z = rec(1, 100, DeviceState::Paused);
        z.until_epoch = 280;
        assert_eq!(z.state_at(true, 279, now), DeviceState::Paused);
        assert_eq!(z.state_at(true, 280, now), DeviceState::CheckPending);
        // A lapsed lease and an overdue rotation stop the count; nothing else changes.
        let mut a = rec(1, 100, DeviceState::Active);
        a.lease_valid_until = now - 1;
        assert_eq!(a.state_at(true, 100, now), DeviceState::CheckPending);
        a.lease_valid_until = now + 1;
        assert_eq!(a.state_at(true, 100 + 180 + ROTATION_GRACE_EPOCHS, now), DeviceState::Active);
        assert_eq!(a.state_at(true, 100 + 180 + ROTATION_GRACE_EPOCHS + 1, now), DeviceState::CheckPending);
        // A provisional record never counts.
        let mut v = rec(1, 100, DeviceState::Active);
        v.provisional = true;
        assert_eq!(v.state_at(true, 100, now), DeviceState::CheckPending);
        // A record set active early (a refresh inside its first epoch) counts from its effective epoch.
        let mut e = rec(1, 100, DeviceState::Active);
        e.effective_epoch = 101;
        assert_eq!(e.state_at(true, 100, now), DeviceState::PendingNextEpoch);
        assert_eq!(e.state_at(true, 101, now), DeviceState::Active);
        // The 60-day limit: rotation due 30 days after the statement, creditable 30 days more, then not.
        let r = rec(1, 100, DeviceState::Suspect);
        assert_eq!(r.rotation_due_epoch, 100 + crate::light_device::ROTATION_PERIOD_EPOCHS);
        assert_eq!(r.state_at(true, 100 + 360, now), DeviceState::Suspect);
        assert_eq!(r.state_at(true, 100 + 361, now), DeviceState::CheckPending, "sixty days after the statement");
    }

    #[test]
    fn a_revocation_and_an_oracle_outage_read_through_the_local_view() {
        let now = 1_800_000_000;
        let mut a = rec(1, 100, DeviceState::Active);
        a.platform = Platform::Android;
        a.lease_valid_until = now - 10;
        // A lapsed lease stops the count; an outage that began while it was valid stretches it, by the
        // outage's length and never past the cap.
        assert_eq!(a.state_with(true, 100, now, Local::default()), DeviceState::CheckPending);
        let down = Local { oracle_down_since: now - 3_600, ..Local::default() };
        assert_eq!(a.state_with(true, 100, now, down), DeviceState::Active);
        let week = OUTAGE_EXTENSION_CAP_SECS;
        let long = Local { oracle_down_since: now - 10 - 3_600, ..Local::default() };
        assert_eq!(a.state_with(true, 100, now - 10 + week, long), DeviceState::Active, "a week past the lease's end");
        assert_eq!(a.state_with(true, 100, now - 10 + week + 1, long), DeviceState::CheckPending, "the cap");
        // Only a clean lease: a strike's suspect record, or a lease that had lapsed before the outage, waits.
        let suspect = DeviceRecord { state: DeviceState::Suspect, ..a.clone() };
        assert_eq!(suspect.state_with(true, 100, now, down), DeviceState::CheckPending);
        let late = Local { oracle_down_since: now - 5, ..Local::default() };
        assert_eq!(a.state_with(true, 100, now, late), DeviceState::CheckPending, "lapsed before the outage");
        // A new binding with no lease read never counts, outage or not.
        let pending = DeviceRecord { state: DeviceState::CheckPending, lease_valid_until: 0, ..a.clone() };
        assert_eq!(pending.state_with(true, 100, now, down), DeviceState::CheckPending);
        // A chain the list names reads paused at once, whatever it read before; an ended record stays ended.
        let revoked = Local { revoked: true, ..Local::default() };
        a.lease_valid_until = now + 10;
        assert_eq!(a.state_with(true, 100, now, revoked), DeviceState::Paused);
        assert_eq!(DeviceRecord { state: DeviceState::Ended, ..a.clone() }.state_with(true, 100, now, revoked), DeviceState::Ended);
        // The signed revocation pause has no epoch and holds until a new enrolment replaces the record.
        let mut p = a.clone();
        p.state = DeviceState::Paused;
        p.reason = REVOKED.into();
        assert_eq!(p.state_at(true, 100_000, now), DeviceState::Paused);
        assert!(p.paused_at(100_000));
        assert_eq!(p.pause_until(100), 0, "no epoch to carry over or to hold a new enrolment");
        assert_eq!(p.pause_refusal().paused_until, None);
        // A timed pause holds until its epoch, also once the record ended.
        let t = DeviceRecord { state: DeviceState::Paused, until_epoch: 280, reason: "two_strikes".into(), ..a.clone() };
        assert!(t.paused_at(279) && !t.paused_at(280));
        assert_eq!((t.pause_until(279), t.pause_until(280)), (280, 0));
        assert_eq!(DeviceRecord { state: DeviceState::Ended, ..t.clone() }.pause_until(279), 280);
        assert_eq!(t.pause_refusal().paused_until, Some(280));
    }

    /// ND-3: a lease window arrives unsigned. A leased record with none has lapsed (it used to count forever and
    /// never be sent to the oracle) and its refresh is due at once; a lease-less record is as before.
    #[test]
    fn a_leased_record_with_no_window_has_lapsed_and_is_due_a_refresh() {
        let now = 1_800_000_000;
        let mut r = rec(1, 100, DeviceState::Active);
        r.lease = Some(LeaseSummary { kind: LeaseKind::ClaimedVirgin, effective: Effective::Now, gate: Gate::Ok,
                                      issued_at: now, pi_digest: String::new() });
        r.lease_valid_until = now + 86_400;
        assert_eq!(r.state_with(true, 100, now, Local::default()), DeviceState::Active);
        r.lease_valid_until = 0;
        assert_eq!(r.state_with(true, 100, now, Local::default()), DeviceState::CheckPending, "no window: lapsed");
        assert_eq!(r.refresh_window(true, 100, now, Local::default()), Some((now, now + REFRESH_LATE_SECS)));
        let bare = DeviceRecord { lease: None, ..r.clone() };
        assert!(bare.refresh_window(true, 100, now, Local::default()).is_none(), "nothing to renew");
        assert_eq!(super::super::statement::clamp_lease_window(u64::MAX, Some(now)), now + crate::light_device::LEASE_WINDOW_MAX_SECS);
        assert_eq!(super::super::statement::clamp_lease_window(now + 5, Some(now)), now + 5);
        assert_eq!(super::super::statement::clamp_lease_window(now + 5, None), 0, "no signed time to measure from");
    }

    #[test]
    fn the_refresh_window_opens_at_the_oracles_time_with_a_stable_jitter() {
        let now = 1_800_000_000;
        let mut r = rec(1, 100, DeviceState::Active);
        r.refresh_at = now + 6 * 86_400;
        r.lease_valid_until = now + 7 * 86_400;
        let (from, to) = r.refresh_window(true, 100, now, Local::default()).unwrap();
        assert!(from >= r.refresh_at && from < r.refresh_at + 86_400 / 4 + 1, "{from}");
        assert_eq!(to, r.lease_valid_until);
        assert_eq!(r.refresh_window(true, 100, now + 5, Local::default()), Some((from, to)), "the same window on every read");
        let other = DeviceRecord { node_id: "light_mobile_dacc1355d21394a2".into(), ..r.clone() };
        let (f2, _) = other.refresh_window(true, 100, now, Local::default()).unwrap();
        assert!(f2 >= r.refresh_at && f2 < r.lease_valid_until);
        // A lapsed lease: the window stays open a day from now, the refresh brings the lease back.
        let lapsed = now + 8 * 86_400;
        assert_eq!(r.refresh_window(true, 100, lapsed, Local::default()).map(|w| w.1), Some(lapsed + REFRESH_LATE_SECS));
        // Nothing to renew: no lease, provisional, ended, not on chain, paused, revoked.
        assert!(DeviceRecord { lease_valid_until: 0, ..r.clone() }.refresh_window(true, 100, now, Local::default()).is_none());
        assert!(DeviceRecord { provisional: true, ..r.clone() }.refresh_window(true, 100, now, Local::default()).is_none());
        assert!(DeviceRecord { state: DeviceState::Ended, ..r.clone() }.refresh_window(true, 100, now, Local::default()).is_none());
        assert!(r.refresh_window(false, 100, now, Local::default()).is_none());
        let paused = DeviceRecord { state: DeviceState::Paused, until_epoch: 280, ..r.clone() };
        assert!(paused.refresh_window(true, 100, now, Local::default()).is_none());
        assert!(paused.refresh_window(true, 280, now, Local::default()).is_some(), "a pause over waits for a refresh");
        assert!(r.refresh_window(true, 100, now, Local { revoked: true, ..Local::default() }).is_none());
    }

    #[test]
    fn one_statement_is_the_current_one_everywhere() {
        let base = rec(10, 100, DeviceState::Active);
        let higher_seq = DeviceRecord { seq: 11, issued_epoch: 99, ..base.clone() };
        assert!(newer(&higher_seq, &base) && !newer(&base, &higher_seq));
        let later = DeviceRecord { issued_epoch: 101, ..base.clone() };
        assert!(newer(&later, &base));
        let leased = DeviceRecord { lease: Some(LeaseSummary { kind: LeaseKind::ClaimedVirgin, effective: Effective::Now,
            gate: Gate::Ok, issued_at: 5, pi_digest: String::new() }), ..base.clone() };
        assert!(newer(&leased, &base), "a lease beats none in one epoch");
        let other_hash = DeviceRecord { stmt_hash: "ee".repeat(32), ..base.clone() };
        assert!(newer(&other_hash, &base) != newer(&base, &other_hash), "a total order");
    }

    #[test]
    fn reservations_and_votes_lapse() {
        let now = 1_800_000_000;
        let res = KeyEntry { node_id: "n".into(), seq: 1, final_: false, at: now };
        assert!(res.holds(false, now + KEY_RESERVATION_SECS));
        assert!(!res.holds(false, now + KEY_RESERVATION_SECS + 1));
        let fin = KeyEntry { final_: true, ..res.clone() };
        assert!(fin.holds(true, now + 10 * KEY_RESERVATION_SECS));
        assert!(!fin.holds(false, now), "an ended record frees its key");
        let v = Vote { hw_key: "k1".into(), stmt_hash: "s".into(), at: now };
        assert!(v.blocks("k2", now + VOTE_TTL_SECS));
        assert!(!v.blocks("k1", now), "the same device again");
        assert!(!v.blocks("k2", now + VOTE_TTL_SECS + 1));
    }
}

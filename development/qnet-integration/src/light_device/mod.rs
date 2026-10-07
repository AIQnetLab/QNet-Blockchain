//! The device layer, Phase A: a light node is bound to one phone or tablet whose security hardware proves
//! the device (`docs/protocols/light-node-messages.md` sections 5 to 9).
//!
//! - [`stamp`]: the device challenge a device message answers (A1);
//! - [`evidence`]: the enrolment block `/light-node/bind` carries and its verification with
//!   `qnet-device-attest` (A2), the eligibility refusals and the factory-key tier (O1);
//! - [`oracle`]: the device oracle client over mutual TLS, its pinned key and its answers (A17, A18);
//! - [`statement`]: the device statement four of the five genesis sign, the state change and the bundle
//!   the genesis nodes send each other (A3, A4, A6);
//! - [`record`]: the device record and its indices `ldk_` / `ldak_` (A5), and the state every reader
//!   takes from it, the status fields among them (A13);
//! - [`ping`]: the ping reply with the device signature and its anchor, on ingress and relay (A7, A8);
//! - [`crl`]: the oracle's signed revocation snapshot and the per-epoch check of the stored chain serials
//!   (A14);
//! - [`monitor`]: the cross-owner diff of each shard's eligibility bitmaps (A16).
//!
//! RPC and P2P policy and local storage only. No block, apply or admission rule reads any of it: the
//! validators check the owner-signed eligibility bitmaps, never a device. Enforcement (refusing a reply
//! without the hardware signature) is the node-local constant [`LIGHT_DEVICE_ENFORCE_EPOCH`], off in
//! this roll, so every legacy reply keeps counting (A20); the five genesis start serving the layer at
//! once, from [`LIGHT_DEVICE_SERVE_EPOCH`], also off in this roll. The multiplicity gates' enforcement is the
//! oracle's (`gates.enforce`; it states `ok` while log-only) and the mainnet category and upload-key rules
//! are the verifier crate's policies, so neither needs a node constant. No vendor token, attestation object
//! or raw device key is logged, gossiped or written to the chain.

pub mod attest;
pub mod crl;
pub mod evidence;
pub mod messages;
pub mod monitor;
pub mod oracle;
pub mod ping;
pub mod record;
pub mod stamp;
pub mod statement;
pub mod store;

#[cfg(test)]
mod vectors_kat;

use serde::{Deserialize, Serialize};

pub const EPOCH_BLOCKS: u64 = 14_400;
/// A device challenge's stamp is valid this long at its issuer.
pub const CHALLENGE_TTL_SECS: u64 = 600;
/// Attestors take a lease statement at most this old (its `issued_at`).
pub const LEASE_MAX_AGE_SECS: u64 = 600;
/// Genesis clocks differ by up to this much.
pub const CLOCK_SKEW_SECS: u64 = 120;
/// Signatures of distinct genesis nodes that make a device statement final (`quorum_size(5)`).
pub const STATEMENT_QUORUM: usize = 4;
/// A device key rotates every 30 days (six epochs a day).
pub const ROTATION_PERIOD_EPOCHS: u64 = 180;
/// The node stays creditable this long after the rotation fell due, then waits in `check_pending`.
pub const ROTATION_GRACE_EPOCHS: u64 = 180;
/// From this epoch a shard owner refuses a reply without the hardware signature. Off in the first roll:
/// legacy replies keep counting until a later roll sets the number in the binary of all five genesis.
pub const LIGHT_DEVICE_ENFORCE_EPOCH: u64 = u64::MAX;
/// Enrolments one client address may start per hour (a carrier NAT fronts many phones).
pub const ENROL_PER_ADDR_PER_HOUR: usize = 30;
/// A statement signed by a retired oracle key is still taken this many epochs after the retirement.
pub const ORACLE_PREVIOUS_KEY_EPOCHS: u64 = 42;
/// An attestor's reservation of a device key for the node it signed a statement for, when that statement
/// never became final here: long enough that the final statement reaches every genesis first.
pub const KEY_RESERVATION_SECS: u64 = 86_400;
/// An attestor's vote for one device at one binding sequence of a node. A statement's lease is taken at
/// most `LEASE_MAX_AGE_SECS` after it was issued, so after this no statement the vote covered can still
/// gather signatures from an honest attestor.
pub const VOTE_TTL_SECS: u64 = LEASE_MAX_AGE_SECS + 2 * CLOCK_SKEW_SECS;
/// A record whose registration never applied is gone this long after the enrolment.
pub const AWAITING_TTL_SECS: u64 = crate::light_binding::PENDING_TTL_SECS;
/// An oracle outage stretches a clean lease by its length, at most this much (plan section 9.4).
pub const OUTAGE_EXTENSION_CAP_SECS: u64 = 7 * 86_400;
/// The longest lease window the oracle grants: its longest period and grace (14 + 7 days) plus its outage
/// extension. A window arrives unsigned beside a signed lease or state change, so every receiver clamps it to
/// this past the lease's signed issue time (a statement) or its own clock (a refresh), and reads a leased
/// record with no window as lapsed (ND-3).
pub const LEASE_WINDOW_MAX_SECS: u64 = 21 * 86_400 + OUTAGE_EXTENSION_CAP_SECS;
/// A lapsed lease's refresh window stays open this long from each status read.
pub const REFRESH_LATE_SECS: u64 = 86_400;
/// A revocation snapshot older than this raises an alert; it keeps being used (a list only ever refuses).
pub const CRL_MAX_AGE_SECS: u64 = 7 * 86_400;
/// How often a genesis asks the oracle for its revocation snapshot (the oracle refetches Google's list per
/// its cache lifetime, one to 24 hours).
pub const CRL_FETCH_SECS: u64 = 3_600;
/// A multiplicity gate holds a node in `check_pending`; its ingress asks the oracle again this often.
pub const RECHECK_SECS: u64 = 86_400;
/// How often a genesis asks the oracle whether it answers, when nothing else did.
pub const ORACLE_PROBE_SECS: u64 = 300;

/// The forms of the device layer a client switches on once two genesis list them (spec section 7).
pub const DEVICE_FEATURES: [&str; 2] = ["device_v1", "hwping_v2"];

/// From this epoch the five genesis serve the device layer together: they list `device_v1` and `hwping_v2`,
/// issue device challenges and take device blocks. Off in this roll. A later roll sets one number in the
/// binary of all five, an epoch after that roll (the one pinning the oracle key, or a later one) reaches
/// the last genesis: a leased statement needs four attestors whose binary verifies the lease, so a genesis
/// that listed the forms on its own pin while two others still ran without one would answer every
/// enrolment `device_stale`.
pub const LIGHT_DEVICE_SERVE_EPOCH: u64 = u64::MAX;

/// This node serves the device layer: it is one of the five genesis, the shared serve epoch is reached,
/// the oracle's key is pinned in the binary (so a lease can verify) and the oracle is configured (so a
/// device can be counted). Until then it lists neither `device_v1` nor `hwping_v2`, issues no device
/// challenge and takes no device block: the app never falls back to a plain reply after a refused
/// `ping_hw2`, so a genesis that cannot count a device must not invite one.
pub fn device_layer_served() -> bool {
    serving_genesis_id().is_some()
}

/// This node's genesis id while it serves the device layer (`device_layer_served`).
pub fn serving_genesis_id() -> Option<String> {
    if current_epoch() < LIGHT_DEVICE_SERVE_EPOCH || statement::OraclePins::production().keys.is_empty()
        || oracle::configured().is_none() {
        return None;
    }
    own_genesis_id()
}

/// The current epoch at this node's tip.
pub fn current_epoch() -> u64 {
    crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / EPOCH_BLOCKS
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

/// The epoch a Unix time `t` falls in, read from the current `epoch` at `now` (a block a second): the end of
/// a pause the oracle states in seconds, rounded up so the pause is never shorter.
pub fn epoch_at(t: u64, now: u64, epoch: u64) -> u64 {
    epoch + t.saturating_sub(now).div_ceil(EPOCH_BLOCKS)
}

/// A `trust = test` statement is taken only by a testnet node (spec section 9, the node-local test rule).
pub fn is_mainnet() -> bool {
    !crate::network_config::get_network_config().is_testnet()
}

/// Every read-modify-write of device records, key entries and votes on this node goes under this one lock:
/// device writes are rare (enrolments, statements, state changes), and one lock keeps each check-and-write
/// atomic against the others.
pub fn device_write_lock() -> parking_lot::MutexGuard<'static, ()> {
    static L: parking_lot::Mutex<()> = parking_lot::const_mutex(());
    L.lock()
}

/// This node's genesis id (`genesis_node_00N`) when it is one of the five genesis nodes, which alone carry
/// the device layer.
pub fn own_genesis_id() -> Option<String> {
    let id = crate::unified_p2p::GLOBAL_NODE_ID.read().clone();
    crate::genesis_constants::is_legacy_genesis_node(&id).then_some(id)
}

macro_rules! wire_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(s: &str) -> Option<$name> {
                match s { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

wire_enum!(
    /// The device's platform.
    Platform { Ios => "ios", Android => "android" }
);

impl Platform {
    /// The platform byte of `device_tag`.
    pub fn byte(self) -> u8 {
        match self { Platform::Ios => 0x01, Platform::Android => 0x02 }
    }
}

wire_enum!(
    /// How an Android attestation chain was provisioned; `na` on iOS (spec section 9).
    Prov { Rkp => "rkp", Factory => "factory", Na => "na" }
);

impl From<qnet_device_attest::Provisioning> for Prov {
    fn from(p: qnet_device_attest::Provisioning) -> Self {
        match p {
            qnet_device_attest::Provisioning::Rkp => Prov::Rkp,
            qnet_device_attest::Provisioning::Factory => Prov::Factory,
            qnet_device_attest::Provisioning::NotApplicable => Prov::Na,
        }
    }
}

wire_enum!(
    /// `store`: the app as the stores sign it; `test`: a build signed with the developer's own key.
    Trust { Store => "store", Test => "test" }
);

impl From<qnet_device_attest::Trust> for Trust {
    fn from(t: qnet_device_attest::Trust) -> Self {
        match t {
            qnet_device_attest::Trust::Store => Trust::Store,
            qnet_device_attest::Trust::Test => Trust::Test,
        }
    }
}

wire_enum!(
    /// What a device statement records.
    Op { Enrol => "enrol", Rotate => "rotate", Rebind => "rebind" }
);

wire_enum!(
    /// What the oracle's slot read found (section 6.1).
    LeaseKind { ClaimedVirgin => "claimed_virgin", SelfReclaim => "self_reclaim", ClaimedForeign => "claimed_foreign", None => "none" }
);

wire_enum!(
    Effective { Now => "now", Next => "next" }
);

wire_enum!(
    Gate { Ok => "ok", MetricHigh => "metric_high", CertsHigh => "certs_high", Na => "na" }
);

impl Gate {
    pub fn is_high(self) -> bool {
        matches!(self, Gate::MetricHigh | Gate::CertsHigh)
    }
}

wire_enum!(
    /// A device record's state (section 8).
    DeviceState {
        AwaitingRegistration => "awaiting_registration",
        PendingNextEpoch => "pending_next_epoch",
        Active => "active",
        Suspect => "suspect",
        CheckPending => "check_pending",
        Paused => "paused",
        Ended => "ended",
    }
);

impl DeviceState {
    /// A reply of a device in this state counts.
    pub fn counts(self) -> bool {
        matches!(self, DeviceState::Active | DeviceState::Suspect)
    }

    /// Order of severity: of two state changes at the same sequence the more severe wins, so a pause or
    /// an end never gives way to a lighter state (pauses and revocations never move backwards).
    pub fn severity(self) -> u8 {
        match self {
            DeviceState::Active => 0,
            DeviceState::PendingNextEpoch => 1,
            DeviceState::AwaitingRegistration => 2,
            DeviceState::Suspect => 3,
            DeviceState::CheckPending => 4,
            DeviceState::Paused => 5,
            DeviceState::Ended => 6,
        }
    }
}

wire_enum!(
    /// What a device challenge is for (section 5.2).
    Purpose { Enrol => "enrol", Rotate => "rotate", Refresh => "refresh", Release => "release", Reset => "reset" }
);

wire_enum!(
    /// The `/bind` refusals of the device block (section 8). `check_pending` is a state, not one of these.
    DeviceReason {
        Unsupported => "device_unsupported",
        NotGenuine => "device_not_genuine",
        AppUnrecognized => "device_app_unrecognized",
        Emulator => "device_emulator",
        Compromised => "device_compromised",
        Desktop => "device_desktop",
        SecondaryUser => "device_secondary_user",
        Unlicensed => "device_unlicensed",
        Stale => "device_stale",
        KeyInUse => "device_key_in_use",
        SlotPaused => "device_slot_paused",
        RateLimited => "device_rate_limited",
    }
);

impl DeviceReason {
    /// The same wire reason for a refusal of the shared evidence verifier.
    pub fn from_evidence(r: qnet_device_attest::Reason) -> DeviceReason {
        use qnet_device_attest::Reason as R;
        match r {
            R::Unsupported => DeviceReason::Unsupported,
            R::NotGenuine => DeviceReason::NotGenuine,
            R::AppUnrecognized => DeviceReason::AppUnrecognized,
            R::Emulator => DeviceReason::Emulator,
            R::Compromised => DeviceReason::Compromised,
            R::Desktop => DeviceReason::Desktop,
            R::SecondaryUser => DeviceReason::SecondaryUser,
            R::Unlicensed => DeviceReason::Unlicensed,
            R::Stale => DeviceReason::Stale,
        }
    }

    /// The app tries again later only after these (its transient set); every other one is final for the
    /// binding it refused.
    pub fn transient(self) -> bool {
        matches!(self, DeviceReason::Stale | DeviceReason::RateLimited)
    }

    pub fn message(self) -> &'static str {
        match self {
            DeviceReason::Unsupported => "This device cannot prove its hardware",
            DeviceReason::NotGenuine => "The device evidence does not verify",
            DeviceReason::AppUnrecognized => "The evidence does not name the store app",
            DeviceReason::Emulator => "The device key is not held in secure hardware",
            DeviceReason::Compromised => "The device does not boot a verified system",
            DeviceReason::Desktop => "Computers, TV, car and watch devices cannot run a node",
            DeviceReason::SecondaryUser => "The node runs only in the device's main profile",
            DeviceReason::Unlicensed => "The app is not licensed on this device",
            DeviceReason::Stale => "The device check is out of date; ask for a new challenge",
            DeviceReason::KeyInUse => "This device key belongs to another node",
            DeviceReason::SlotPaused => "The node is paused on this device",
            DeviceReason::RateLimited => "Too many device checks; try again later",
        }
    }
}

/// A refusal of the device block, as `/bind` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRefusal {
    pub reason: DeviceReason,
    /// Seconds until a transient refusal may be tried again.
    pub retry_after: Option<u64>,
    /// The epoch a pause ends (`device_slot_paused`).
    pub paused_until: Option<u64>,
    /// The support reference of the refused message, when the device key is known.
    pub reference: Option<String>,
}

impl DeviceRefusal {
    pub fn new(reason: DeviceReason) -> Self {
        DeviceRefusal { reason, retry_after: None, paused_until: None, reference: None }
    }

    pub fn retry(reason: DeviceReason, after: u64) -> Self {
        DeviceRefusal { retry_after: Some(after.max(1)), ..Self::new(reason) }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({ "success": false, "reason": self.reason.as_str(), "error": self.reason.message() });
        if let Some(s) = self.retry_after { v["retry_after_seconds"] = s.into(); }
        if let Some(e) = self.paused_until { v["paused_until"] = e.into(); }
        if let Some(r) = &self.reference { v["ref"] = r.clone().into(); }
        v
    }
}

/// Why the device step refused a binding: a binding reason (another device took the same sequence in a
/// split race) or a device reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepRefusal {
    Binding(crate::light_binding::Refusal),
    Device(DeviceRefusal),
}

impl StepRefusal {
    pub fn device(reason: DeviceReason) -> Self {
        StepRefusal::Device(DeviceRefusal::new(reason))
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            StepRefusal::Binding(r) => r.as_str(),
            StepRefusal::Device(d) => d.reason.as_str(),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        match self {
            StepRefusal::Binding(r) => r.to_json(),
            StepRefusal::Device(d) => d.to_json(),
        }
    }
}

impl From<DeviceRefusal> for StepRefusal {
    fn from(d: DeviceRefusal) -> Self {
        StepRefusal::Device(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_reasons_are_the_spec_values() {
        for r in [DeviceReason::Unsupported, DeviceReason::NotGenuine, DeviceReason::AppUnrecognized,
                  DeviceReason::Emulator, DeviceReason::Compromised, DeviceReason::Desktop,
                  DeviceReason::SecondaryUser, DeviceReason::Unlicensed, DeviceReason::Stale,
                  DeviceReason::KeyInUse, DeviceReason::SlotPaused, DeviceReason::RateLimited] {
            assert_eq!(DeviceReason::parse(r.as_str()), Some(r));
            assert!(r.as_str().starts_with("device_"));
            let j = DeviceRefusal::new(r).to_json();
            assert_eq!(j["success"], serde_json::json!(false));
            assert_eq!(j["reason"].as_str(), Some(r.as_str()));
        }
        // The crate's nine reasons map onto the same spellings.
        for r in qnet_device_attest::Reason::ALL {
            assert_eq!(DeviceReason::from_evidence(r).as_str(), r.as_str());
        }
        // The app's transient set: device_stale and device_rate_limited only.
        assert!(DeviceReason::Stale.transient() && DeviceReason::RateLimited.transient());
        assert!(!DeviceReason::KeyInUse.transient() && !DeviceReason::Desktop.transient());
    }

    #[test]
    fn states_and_their_order() {
        for s in ["awaiting_registration", "pending_next_epoch", "active", "suspect", "check_pending", "paused", "ended"] {
            assert_eq!(DeviceState::parse(s).map(|x| x.as_str()), Some(s));
        }
        assert!(DeviceState::Active.counts() && DeviceState::Suspect.counts());
        for s in [DeviceState::AwaitingRegistration, DeviceState::PendingNextEpoch, DeviceState::CheckPending,
                  DeviceState::Paused, DeviceState::Ended] {
            assert!(!s.counts(), "{s:?}");
        }
        assert!(DeviceState::Paused.severity() > DeviceState::Active.severity());
        assert!(DeviceState::Ended.severity() > DeviceState::Paused.severity());
        assert_eq!(VOTE_TTL_SECS, 840);
        assert_eq!(LIGHT_DEVICE_ENFORCE_EPOCH, u64::MAX, "enforcement is off in this roll");
    }

    /// A20: the enforcement constant is in the binary and off. Until a later roll sets it on all five
    /// genesis, a reply without the device signature counts, a binding without a device block is taken, and
    /// a node with no device record is pushed and woken as before, whatever the epoch.
    #[test]
    fn enforcement_is_off_in_this_roll_and_honest_old_clients_keep_working() {
        assert_eq!(LIGHT_DEVICE_ENFORCE_EPOCH, u64::MAX);
        for epoch in [0, 155, 1_000_000, u64::MAX - 1] {
            assert!(ping::legacy_counts(epoch), "a legacy reply counts in epoch {epoch}");
        }
        // No device layer without the oracle's pinned key and the shared serve epoch: this binary lists
        // neither device form, issues no device challenge and takes no device block.
        assert!(statement::ORACLE_KEYS.is_empty());
        assert_eq!(LIGHT_DEVICE_SERVE_EPOCH, u64::MAX, "the five genesis start serving together, in a later roll");
        assert!(!device_layer_served() && serving_genesis_id().is_none());
        assert_eq!(DEVICE_FEATURES, ["device_v1", "hwping_v2"]);
        assert_eq!(OUTAGE_EXTENSION_CAP_SECS, 7 * 86_400);
        assert_eq!(CRL_MAX_AGE_SECS, 7 * 86_400);
    }
}

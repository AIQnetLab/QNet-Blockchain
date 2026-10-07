//! Wire enums of the device layer (docs/protocols/light-node-messages.md sections 6 and 8).
//! Stored records are bincode, which encodes enum variants by position: append variants, never reorder.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Ios,
    Android,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Ios => "ios",
            Platform::Android => "android",
        }
    }
    /// Platform byte of `device_tag`.
    pub fn byte(self) -> u8 {
        match self {
            Platform::Ios => 0x01,
            Platform::Android => 0x02,
        }
    }
}

/// Provisioning of the Android attestation chain; `na` on iOS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Prov {
    Rkp,
    Factory,
    Na,
}

/// `store`: the app as the stores sign it. `test`: a build signed with our own upload or development key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    Store,
    Test,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseKind {
    ClaimedVirgin,
    SelfReclaim,
    ClaimedForeign,
    None,
}

impl LeaseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LeaseKind::ClaimedVirgin => "claimed_virgin",
            LeaseKind::SelfReclaim => "self_reclaim",
            LeaseKind::ClaimedForeign => "claimed_foreign",
            LeaseKind::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effective {
    Now,
    Next,
}

impl Effective {
    pub fn as_str(self) -> &'static str {
        match self {
            Effective::Now => "now",
            Effective::Next => "next",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gate {
    Ok,
    MetricHigh,
    CertsHigh,
    Na,
}

impl Gate {
    pub fn as_str(self) -> &'static str {
        match self {
            Gate::Ok => "ok",
            Gate::MetricHigh => "metric_high",
            Gate::CertsHigh => "certs_high",
            Gate::Na => "na",
        }
    }
    pub fn is_high(self) -> bool {
        matches!(self, Gate::MetricHigh | Gate::CertsHigh)
    }
}

/// Device record states the oracle reports. `awaiting_registration` belongs to the genesis nodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    PendingNextEpoch,
    Active,
    Suspect,
    CheckPending,
    Paused,
    Ended,
}

impl State {
    pub fn counts(self) -> bool {
        matches!(self, State::Active | State::Suspect)
    }
}

/// State-change reasons of section 6.3.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    RefreshOk,
    CheckPassed,
    Anomaly,
    Strike,
    TwoStrikes,
    LeaseLapsed,
    VerdictFailed,
    MetricHigh,
    CertsHigh,
    Hold,
    Released,
    Rebound,
    Superseded,
    Reset,
    /// A vendor or the oracle's own write path was unavailable: `check_pending` until it returns.
    ServiceUnavailable,
}

/// The `/bind` refusal reasons of spec section 8 that the oracle can return.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    DeviceNotGenuine,
    DeviceAppUnrecognized,
    DeviceCompromised,
    DeviceUnlicensed,
    DeviceStale,
    DeviceKeyInUse,
    DeviceSlotPaused,
    DeviceRateLimited,
    DeviceUnsupported,
    DeviceEmulator,
    DeviceDesktop,
    DeviceSecondaryUser,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::DeviceNotGenuine => "device_not_genuine",
            Refusal::DeviceAppUnrecognized => "device_app_unrecognized",
            Refusal::DeviceCompromised => "device_compromised",
            Refusal::DeviceUnlicensed => "device_unlicensed",
            Refusal::DeviceStale => "device_stale",
            Refusal::DeviceKeyInUse => "device_key_in_use",
            Refusal::DeviceSlotPaused => "device_slot_paused",
            Refusal::DeviceRateLimited => "device_rate_limited",
            Refusal::DeviceUnsupported => "device_unsupported",
            Refusal::DeviceEmulator => "device_emulator",
            Refusal::DeviceDesktop => "device_desktop",
            Refusal::DeviceSecondaryUser => "device_secondary_user",
        }
    }

    /// The same wire reason for a refusal of the shared evidence verifier.
    pub fn from_evidence(r: qnet_device_attest::Reason) -> Refusal {
        use qnet_device_attest::Reason as R;
        match r {
            R::Unsupported => Refusal::DeviceUnsupported,
            R::NotGenuine => Refusal::DeviceNotGenuine,
            R::AppUnrecognized => Refusal::DeviceAppUnrecognized,
            R::Emulator => Refusal::DeviceEmulator,
            R::Compromised => Refusal::DeviceCompromised,
            R::Desktop => Refusal::DeviceDesktop,
            R::SecondaryUser => Refusal::DeviceSecondaryUser,
            R::Unlicensed => Refusal::DeviceUnlicensed,
            R::Stale => Refusal::DeviceStale,
        }
    }
}

impl From<qnet_device_attest::Trust> for Trust {
    fn from(t: qnet_device_attest::Trust) -> Self {
        match t {
            qnet_device_attest::Trust::Store => Trust::Store,
            qnet_device_attest::Trust::Test => Trust::Test,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Enrol,
    Rotate,
    Rebind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    Testnet,
    Mainnet,
}

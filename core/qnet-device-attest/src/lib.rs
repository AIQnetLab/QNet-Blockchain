//! Offline verification of the hardware evidence that binds a QNet light node to one phone or tablet.
//!
//! Every check is a pure function: no network, no clock (callers pass `now`), no global state, so the
//! genesis attestors and the device oracle reach the same verdict on the same bytes. The messages
//! that carry this evidence are defined in `docs/protocols/light-node-messages.md`.
//!
//! - [`apple`]: App Attest attestation objects and assertions, and the device flags of an enrolment;
//! - [`receipt`]: App Attest receipts (the risk-metric carrier the oracle exchanges);
//! - [`android`]: hardware key attestation chains ending at a Google root;
//! - [`report`]: the device report an Android device key signs;
//! - [`play`]: Play Integrity verdicts, as the signed token inside the encrypted one;
//! - [`revocation`]: the attestation certificate status list;
//! - [`app`]: the identities of the QNet app that the evidence must name.
//!
//! A refusal is a [`Refusal`]: a precise cause for logs, and the stable wire [`Reason`] of the spec.

pub mod android;
pub mod app;
pub mod apple;
pub mod play;
pub mod receipt;
pub mod report;
pub mod revocation;

mod b64;
mod cbor;
mod crypto;
mod der;
mod time;
mod x509;

#[cfg(test)]
mod testutil;

pub use crypto::DevicePublicKey;

use std::fmt;

/// The stable `reason` a node returns for a refused device block (spec section 8). The node adds
/// the reasons that depend on its own records: `device_key_in_use`, `device_slot_paused`,
/// `device_rate_limited`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    Unsupported,
    NotGenuine,
    AppUnrecognized,
    Emulator,
    Compromised,
    Desktop,
    SecondaryUser,
    Unlicensed,
    Stale,
}

impl Reason {
    pub const ALL: [Reason; 9] = [
        Reason::Unsupported,
        Reason::NotGenuine,
        Reason::AppUnrecognized,
        Reason::Emulator,
        Reason::Compromised,
        Reason::Desktop,
        Reason::SecondaryUser,
        Reason::Unlicensed,
        Reason::Stale,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Unsupported => "device_unsupported",
            Reason::NotGenuine => "device_not_genuine",
            Reason::AppUnrecognized => "device_app_unrecognized",
            Reason::Emulator => "device_emulator",
            Reason::Compromised => "device_compromised",
            Reason::Desktop => "device_desktop",
            Reason::SecondaryUser => "device_secondary_user",
            Reason::Unlicensed => "device_unlicensed",
            Reason::Stale => "device_stale",
        }
    }
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a piece of evidence was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The bytes do not parse as the expected structure.
    Malformed(&'static str),
    /// A signature or key algorithm this verifier does not accept.
    UnsupportedAlgorithm,
    /// The certificate chain has the wrong number or kind of certificates.
    ChainShape,
    /// A certificate does not name the one above it as its issuer.
    ChainName,
    /// A certificate signature does not verify under the key above it.
    ChainSignature,
    /// The chain does not end at a pinned vendor root.
    UntrustedRoot,
    /// The chain ends at the Android software attestation root: no secure hardware.
    SoftwareRoot,
    /// A certificate that must be current has expired.
    CertificateExpired,
    /// A certificate that must be current is not valid yet.
    CertificateNotYetValid,
    /// A certificate of the chain is on the attestation status list.
    Revoked,
    /// An attestation extension sits in a certificate other than the one it belongs to.
    ExtensionMisplaced,
    /// The evidence was produced for another challenge.
    ChallengeMismatch,
    /// Android: the key lives in software, not in a TEE or StrongBox.
    SoftwareKeystore,
    /// Android: the chain and the key description disagree on the security level.
    SecurityLevelMismatch,
    /// Android: the bootloader is unlocked or the verified boot state is not `Verified`.
    BootUnverified,
    /// The attested key is not a hardware-generated P-256 signing key.
    KeyType,
    /// The evidence names another app (package, signing certificate, App ID).
    AppMismatch,
    /// A build signed with the developer's own key where only store builds are accepted.
    TestBuild,
    /// Android: a factory-provisioned chain where only remotely provisioned chains are accepted.
    FactoryProvisioned,
    /// iOS: the attestation statement format is not App Attest.
    AttestationFormat,
    /// iOS: the key identifier, credential id or embedded key disagree with the certified key.
    KeyIdMismatch,
    /// iOS: a fresh attestation must carry counter 0.
    CounterNotZero,
    /// iOS: an assertion counter must exceed the last one recorded.
    CounterNotIncreasing,
    /// iOS: the authenticator data names an unknown App Attest environment.
    UnknownEnvironment,
    /// iOS: the distribution category of the build is refused by policy.
    CategoryRefused(u32),
    /// iOS: the certified platform is not an iPhone or iPad one.
    PlatformRefused,
    /// iOS: the app reports that it runs on a Mac or a headset.
    DesktopFlags,
    /// A device signature or a signed-object signature does not verify.
    SignatureInvalid,
    /// iOS: the receipt was created too long ago.
    ReceiptStale,
    /// Android: the device report names a computer, TV, car, watch or a device without a touchscreen.
    FormFactor,
    /// Android: the app does not run in the device's main profile.
    SecondaryUser,
    /// Play Integrity: the verdict is too old or dated in the future.
    VerdictStale,
    /// Play Integrity: Google Play does not recognize this build.
    AppNotRecognized,
    /// Play Integrity: the device does not meet device integrity.
    DeviceIntegrity,
    /// Play Integrity: the device meets only virtual integrity (an emulator).
    VirtualDevice,
    /// Play Integrity: the install has no Play licence.
    Unlicensed,
    /// Play Integrity: Google did not evaluate the phone-or-tablet signal on a licensed install.
    FormFactorUnevaluated,
}

impl Refusal {
    /// The wire reason of the spec for this refusal.
    pub fn reason(&self) -> Reason {
        use Refusal::*;
        match self {
            Malformed(_) | UnsupportedAlgorithm | ChainShape | ChainName | ChainSignature
            | UntrustedRoot | Revoked | ExtensionMisplaced | SecurityLevelMismatch | KeyType
            | AttestationFormat | KeyIdMismatch | CounterNotZero | SignatureInvalid => {
                Reason::NotGenuine
            }
            SoftwareRoot | SoftwareKeystore | VirtualDevice => Reason::Emulator,
            CertificateExpired | CertificateNotYetValid | ChallengeMismatch
            | CounterNotIncreasing | ReceiptStale | VerdictStale => Reason::Stale,
            BootUnverified | DeviceIntegrity => Reason::Compromised,
            AppMismatch | TestBuild | UnknownEnvironment | CategoryRefused(_)
            | AppNotRecognized => Reason::AppUnrecognized,
            FactoryProvisioned => Reason::Unsupported,
            PlatformRefused | DesktopFlags | FormFactor | FormFactorUnevaluated => Reason::Desktop,
            SecondaryUser => Reason::SecondaryUser,
            Unlicensed => Reason::Unlicensed,
        }
    }

    /// A short stable code for logs.
    pub fn code(&self) -> &'static str {
        use Refusal::*;
        match self {
            Malformed(_) => "malformed",
            UnsupportedAlgorithm => "unsupported_algorithm",
            ChainShape => "chain_shape",
            ChainName => "chain_name",
            ChainSignature => "chain_signature",
            UntrustedRoot => "untrusted_root",
            SoftwareRoot => "software_root",
            CertificateExpired => "certificate_expired",
            CertificateNotYetValid => "certificate_not_yet_valid",
            Revoked => "revoked",
            ExtensionMisplaced => "extension_misplaced",
            ChallengeMismatch => "challenge_mismatch",
            SoftwareKeystore => "software_keystore",
            SecurityLevelMismatch => "security_level_mismatch",
            BootUnverified => "boot_unverified",
            KeyType => "key_type",
            AppMismatch => "app_mismatch",
            TestBuild => "test_build",
            FactoryProvisioned => "factory_provisioned",
            AttestationFormat => "attestation_format",
            KeyIdMismatch => "key_id_mismatch",
            CounterNotZero => "counter_not_zero",
            CounterNotIncreasing => "counter_not_increasing",
            UnknownEnvironment => "unknown_environment",
            CategoryRefused(_) => "category_refused",
            PlatformRefused => "platform_refused",
            DesktopFlags => "desktop_flags",
            SignatureInvalid => "signature_invalid",
            ReceiptStale => "receipt_stale",
            FormFactor => "form_factor",
            SecondaryUser => "secondary_user",
            VerdictStale => "verdict_stale",
            AppNotRecognized => "app_not_recognized",
            DeviceIntegrity => "device_integrity",
            VirtualDevice => "virtual_device",
            Unlicensed => "unlicensed",
            FormFactorUnevaluated => "form_factor_unevaluated",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Malformed(what) => write!(f, "{} ({})", self.code(), what),
            Refusal::CategoryRefused(c) => write!(f, "{} ({})", self.code(), c),
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for Refusal {}

/// Which signing identity the evidence names (spec section 9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Trust {
    /// The app as the App Store or Google Play signs it.
    Store,
    /// A build signed with the developer's own key; refused on mainnet.
    Test,
}

impl Trust {
    pub fn as_str(self) -> &'static str {
        match self {
            Trust::Store => "store",
            Trust::Test => "test",
        }
    }
}

/// How an Android attestation chain was provisioned (spec section 9); `NotApplicable` on iOS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provisioning {
    Rkp,
    Factory,
    NotApplicable,
}

impl Provisioning {
    pub fn as_str(self) -> &'static str {
        match self {
            Provisioning::Rkp => "rkp",
            Provisioning::Factory => "factory",
            Provisioning::NotApplicable => "na",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_reasons_are_the_spec_values() {
        let names: Vec<&str> = Reason::ALL.iter().map(|r| r.as_str()).collect();
        assert_eq!(
            names,
            [
                "device_unsupported",
                "device_not_genuine",
                "device_app_unrecognized",
                "device_emulator",
                "device_compromised",
                "device_desktop",
                "device_secondary_user",
                "device_unlicensed",
                "device_stale",
            ]
        );
    }

    #[test]
    fn statement_field_spellings() {
        assert_eq!(Trust::Store.as_str(), "store");
        assert_eq!(Trust::Test.as_str(), "test");
        assert_eq!(Provisioning::Rkp.as_str(), "rkp");
        assert_eq!(Provisioning::Factory.as_str(), "factory");
        assert_eq!(Provisioning::NotApplicable.as_str(), "na");
    }
}

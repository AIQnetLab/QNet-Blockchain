//! Every refusal maps to the wire reason the spec assigns it (light-node-messages.md section 8), and
//! every wire reason this crate can produce is reachable. The exhaustive match below fails to
//! compile when a refusal is added without deciding its reason here.

use qnet_device_attest::{Reason, Refusal};
use std::collections::HashSet;

fn spec_reason(r: &Refusal) -> Reason {
    match r {
        // The evidence does not prove genuine hardware running a genuine chain.
        Refusal::Malformed(_)
        | Refusal::UnsupportedAlgorithm
        | Refusal::ChainShape
        | Refusal::ChainName
        | Refusal::ChainSignature
        | Refusal::UntrustedRoot
        | Refusal::Revoked
        | Refusal::ExtensionMisplaced
        | Refusal::SecurityLevelMismatch
        | Refusal::KeyType
        | Refusal::AttestationFormat
        | Refusal::KeyIdMismatch
        | Refusal::CounterNotZero
        | Refusal::SignatureInvalid => Reason::NotGenuine,
        // No secure hardware: an emulator or a software keystore.
        Refusal::SoftwareRoot | Refusal::SoftwareKeystore | Refusal::VirtualDevice => Reason::Emulator,
        // Freshness: nonce, certificate windows, counters, receipt and verdict age.
        Refusal::CertificateExpired
        | Refusal::CertificateNotYetValid
        | Refusal::ChallengeMismatch
        | Refusal::CounterNotIncreasing
        | Refusal::ReceiptStale
        | Refusal::VerdictStale => Reason::Stale,
        Refusal::BootUnverified | Refusal::DeviceIntegrity => Reason::Compromised,
        Refusal::AppMismatch
        | Refusal::TestBuild
        | Refusal::UnknownEnvironment
        | Refusal::CategoryRefused(_)
        | Refusal::AppNotRecognized => Reason::AppUnrecognized,
        Refusal::FactoryProvisioned => Reason::Unsupported,
        Refusal::PlatformRefused | Refusal::DesktopFlags | Refusal::FormFactor | Refusal::FormFactorUnevaluated => {
            Reason::Desktop
        }
        Refusal::SecondaryUser => Reason::SecondaryUser,
        Refusal::Unlicensed => Reason::Unlicensed,
    }
}

fn all() -> Vec<Refusal> {
    vec![
        Refusal::Malformed("x"),
        Refusal::UnsupportedAlgorithm,
        Refusal::ChainShape,
        Refusal::ChainName,
        Refusal::ChainSignature,
        Refusal::UntrustedRoot,
        Refusal::SoftwareRoot,
        Refusal::CertificateExpired,
        Refusal::CertificateNotYetValid,
        Refusal::Revoked,
        Refusal::ExtensionMisplaced,
        Refusal::ChallengeMismatch,
        Refusal::SoftwareKeystore,
        Refusal::SecurityLevelMismatch,
        Refusal::BootUnverified,
        Refusal::KeyType,
        Refusal::AppMismatch,
        Refusal::TestBuild,
        Refusal::FactoryProvisioned,
        Refusal::AttestationFormat,
        Refusal::KeyIdMismatch,
        Refusal::CounterNotZero,
        Refusal::CounterNotIncreasing,
        Refusal::UnknownEnvironment,
        Refusal::CategoryRefused(3),
        Refusal::PlatformRefused,
        Refusal::DesktopFlags,
        Refusal::SignatureInvalid,
        Refusal::ReceiptStale,
        Refusal::FormFactor,
        Refusal::SecondaryUser,
        Refusal::VerdictStale,
        Refusal::AppNotRecognized,
        Refusal::DeviceIntegrity,
        Refusal::VirtualDevice,
        Refusal::Unlicensed,
        Refusal::FormFactorUnevaluated,
    ]
}

#[test]
fn every_refusal_has_the_spec_reason() {
    for r in all() {
        assert_eq!(r.reason(), spec_reason(&r), "{:?}", r);
    }
}

#[test]
fn codes_are_unique_and_every_reason_is_reachable() {
    let refusals = all();
    let codes: HashSet<&str> = refusals.iter().map(Refusal::code).collect();
    assert_eq!(codes.len(), refusals.len());
    let reasons: HashSet<Reason> = refusals.iter().map(Refusal::reason).collect();
    assert_eq!(reasons.len(), Reason::ALL.len());
}

#[test]
fn wire_reasons_appear_in_the_spec() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocols/light-node-messages.md");
    let spec = std::fs::read_to_string(path).unwrap();
    for r in Reason::ALL {
        assert!(spec.contains(&format!("`{}`", r.as_str())), "{} is not in the spec", r);
    }
}

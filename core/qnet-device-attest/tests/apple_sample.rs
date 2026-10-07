//! Apple's published sample from the Attestation Object Validation Guide: the attestation object, its
//! certificate chain to the real Apple App Attestation Root CA, and the ATTEST receipt inside it.

mod common;

use common::*;
use qnet_device_attest::apple::{self, Environment, IosPolicy};
use qnet_device_attest::receipt::{self, ReceiptKind};
use qnet_device_attest::{Refusal, Trust};

struct Sample {
    object: Vec<u8>,
    key_id: [u8; 32],
    client_data_hash: Vec<u8>,
    app_id: String,
    nonce: [u8; 32],
    app_id_hash: [u8; 32],
}

fn sample() -> Sample {
    let text = std::fs::read_to_string(testdata("apple/validation_guide_sample.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    Sample {
        object: b64(&s("attestationObject")),
        key_id: digest32(&b64(&s("keyId"))),
        // Apple's sample passes the challenge itself as clientDataHash; the protocol passes SHA-256(P).
        client_data_hash: s("serverChallenge").into_bytes(),
        app_id: format!("{}.{}", s("teamId"), s("bundleId")),
        nonce: digest32(&b64(&s("nonce"))),
        app_id_hash: digest32(&b64(&s("appIdSha256"))),
    }
}

// Inside the leaf's three days of validity, one minute after the receipt was created.
const RECEIPT_CREATED: i64 = 1_776_795_192; // 2026-04-21T18:13:12Z
const NOW: i64 = RECEIPT_CREATED + 60;

fn policy(app_id: &str) -> IosPolicy {
    IosPolicy {
        app_id: app_id.to_string(),
        allow_development: false,
        refused_categories: vec![],
        allowed_platforms: None,
    }
}

#[test]
fn apple_sample_attestation_verifies() {
    let s = sample();
    assert_eq!(sha256(s.app_id.as_bytes()), s.app_id_hash);
    let v = apple::verify_attestation(&s.object, &s.key_id, &s.client_data_hash, &policy(&s.app_id), NOW).unwrap();
    assert_eq!(v.environment, Environment::Production);
    assert_eq!(v.trust, Trust::Store);
    // The key identifier is SHA-256 of the certified point, and the credential id repeats it.
    assert_eq!(v.public_key.key_id(), s.key_id);
    assert_eq!(v.validation_category, Some(1));
    assert_eq!(v.bundle_version.as_deref(), Some("1"));
    assert_eq!(v.os_version.as_deref(), Some("27.0"));
    assert_eq!(v.os_build.as_deref(), Some("24A325b"));
    assert_eq!(v.platform.as_deref(), Some("iphoneos"));
    assert!(!v.receipt.is_empty());
    // The guide's intermediate value is SHA-256(authData ‖ clientDataHash).
    let at = find(&s.object, b"authData").unwrap() + b"authData".len();
    assert_eq!(s.object[at], 0x58);
    let len = s.object[at + 1] as usize;
    let auth_data = &s.object[at + 2..at + 2 + len];
    assert_eq!(sha256(&[auth_data, &s.client_data_hash].concat()), s.nonce);
}

#[test]
fn apple_sample_under_each_rule() {
    let s = sample();
    let run = |p: &IosPolicy, key_id: &[u8; 32], cdh: &[u8], now: i64| {
        apple::verify_attestation(&s.object, key_id, cdh, p, now)
    };
    let p = policy(&s.app_id);
    assert_eq!(run(&p, &s.key_id, &sha256(b"another challenge"), NOW).unwrap_err(), Refusal::ChallengeMismatch);
    let ours = policy("33H36C42XS.com.qnetmobile");
    assert_eq!(run(&ours, &s.key_id, &s.client_data_hash, NOW).unwrap_err(), Refusal::AppMismatch);
    assert_eq!(run(&p, &[0u8; 32], &s.client_data_hash, NOW).unwrap_err(), Refusal::KeyIdMismatch);
    assert_eq!(run(&p, &s.key_id, &s.client_data_hash, 1_776_700_000).unwrap_err(), Refusal::CertificateNotYetValid);
    assert_eq!(run(&p, &s.key_id, &s.client_data_hash, 1_776_970_000).unwrap_err(), Refusal::CertificateExpired);
    // Category 1 is an OS-distributed executable; the mainnet preset lets it through, a policy may not.
    let mut strict = p.clone();
    strict.refused_categories = vec![1];
    assert_eq!(run(&strict, &s.key_id, &s.client_data_hash, NOW).unwrap_err(), Refusal::CategoryRefused(1));
    let mut platform = p.clone();
    platform.allowed_platforms = Some(vec!["iphoneos".into()]);
    assert!(run(&platform, &s.key_id, &s.client_data_hash, NOW).is_ok());
    platform.allowed_platforms = Some(vec!["xros".into()]);
    assert_eq!(run(&platform, &s.key_id, &s.client_data_hash, NOW).unwrap_err(), Refusal::PlatformRefused);
}

#[test]
fn apple_sample_tampered_leaf_signature() {
    let s = sample();
    let leaf = b64(serde_json_field("leafCertificate").as_str());
    let at = find(&s.object, &leaf).expect("leaf inside the object");
    let mut object = s.object.clone();
    // The last byte of the leaf is inside its signature.
    object[at + leaf.len() - 1] ^= 0x01;
    let err = apple::verify_attestation(&object, &s.key_id, &s.client_data_hash, &policy(&s.app_id), NOW).unwrap_err();
    assert!(matches!(err, Refusal::ChainSignature | Refusal::Malformed(_)), "{:?}", err);
}

#[test]
fn apple_sample_receipt() {
    let s = sample();
    let v = apple::verify_attestation(&s.object, &s.key_id, &s.client_data_hash, &policy(&s.app_id), NOW).unwrap();
    let r = receipt::verify_receipt(&v.receipt, NOW).unwrap();
    assert_eq!(r.app_id, s.app_id);
    assert_eq!(r.kind, ReceiptKind::Attest);
    assert_eq!(r.public_key, v.public_key);
    assert_eq!(r.created_at, RECEIPT_CREATED);
    assert_eq!(r.environment.as_deref(), Some("production"));
    assert_eq!(r.risk_metric, None);
    assert_eq!(r.not_before, None);
    assert_eq!(r.expires_at, Some(RECEIPT_CREATED + 90 * 86_400));
    assert_eq!(r.token.as_deref().map(str::len), Some(88));
    assert!(r.check(&s.app_id, &v.public_key, 300, NOW).is_ok());
    assert_eq!(r.check(&s.app_id, &v.public_key, 300, RECEIPT_CREATED + 301).unwrap_err(), Refusal::ReceiptStale);
    // A receipt dated a little ahead of this clock passes; one far ahead does not.
    assert!(r.check(&s.app_id, &v.public_key, 300, RECEIPT_CREATED - 300).is_ok());
    assert_eq!(r.check(&s.app_id, &v.public_key, 300, RECEIPT_CREATED - 301).unwrap_err(), Refusal::ReceiptStale);
    assert_eq!(r.check("33H36C42XS.com.qnetmobile", &v.public_key, 300, NOW).unwrap_err(), Refusal::AppMismatch);
    let other = qnet_device_attest::DevicePublicKey::from_sec1(&[4u8; 65]).unwrap();
    assert_eq!(r.check(&s.app_id, &other, 300, NOW).unwrap_err(), Refusal::KeyIdMismatch);

    // The receipt signing certificate expires on 2027-02-18.
    assert_eq!(receipt::verify_receipt(&v.receipt, 1_803_000_000).unwrap_err(), Refusal::CertificateExpired);
    // A changed payload byte breaks the receipt signature ("ATTEST" becomes "ATTESU").
    let at = find(&v.receipt, b"ATTEST").unwrap();
    let mut tampered = v.receipt.clone();
    tampered[at + 5] = b'U';
    assert_eq!(receipt::verify_receipt(&tampered, NOW).unwrap_err(), Refusal::SignatureInvalid);
}

fn serde_json_field(key: &str) -> String {
    let text = std::fs::read_to_string(testdata("apple/validation_guide_sample.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v[key].as_str().unwrap().to_string()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

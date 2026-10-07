//! Play Integrity verdicts.
//!
//! A classic Play Integrity token is an encrypted token around a token Google signs with ES256. The
//! device oracle holds the decryption key and forwards the inner signed token, in compact form
//! `b64url(header).b64url(payload).b64url(r ‖ s)`; anyone with the app's public verification key
//! (from Play Console) checks it. `pi_digest` of the lease statement is SHA-256 of the payload bytes.
//! Attestors keep the derived fields of [`PlayVerdict`] and discard the token.

use crate::crypto::{sha256, DevicePublicKey};
use crate::{app, b64, Refusal, Trust};
use serde_json::Value;

const M: Refusal = Refusal::Malformed("play verdict");
const MAX_TOKEN: usize = 32 * 1024;

/// Local rules for Play Integrity verdicts.
#[derive(Clone, Debug)]
pub struct PlayPolicy {
    pub package: String,
    pub store_cert_digests: Vec<[u8; 32]>,
    pub test_cert_digests: Vec<[u8; 32]>,
    pub allow_test: bool,
    /// Oldest acceptable `timestampMillis`, relative to now.
    pub max_age_ms: u64,
    /// Latest acceptable `timestampMillis` ahead of now (clock skew).
    pub max_skew_ms: u64,
    /// On a licensed store install, require the app-access-risk verdict, which Google evaluates only
    /// on phones, tablets and foldables. Google returns it only when that optional verdict is switched
    /// on for the app in Play Console; without it every licensed install is refused.
    pub require_app_access_risk: bool,
}

impl PlayPolicy {
    pub fn mainnet() -> Self {
        PlayPolicy {
            package: app::ANDROID_PACKAGE.to_string(),
            store_cert_digests: vec![app::ANDROID_STORE_CERT_SHA256],
            test_cert_digests: vec![app::ANDROID_UPLOAD_CERT_SHA256],
            allow_test: false,
            max_age_ms: 10 * 60 * 1000,
            max_skew_ms: 60 * 1000,
            require_app_access_risk: true,
        }
    }

    pub fn testnet() -> Self {
        PlayPolicy { allow_test: true, ..Self::mainnet() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Licensing {
    Licensed,
    /// Passes with the one-day lease when the device verdict is met.
    Unevaluated,
    /// Only accepted for test builds.
    Unlicensed,
}

/// The device recall bits (beta) and their last write months (`YYYYMM`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeviceRecall {
    pub first: bool,
    pub second: bool,
    pub third: bool,
    pub written_first: Option<u32>,
    pub written_second: Option<u32>,
    pub written_third: Option<u32>,
}

/// The fields a valid verdict yields.
#[derive(Clone, Debug)]
pub struct PlayVerdict {
    /// `pi_digest`: SHA-256 of the payload bytes.
    pub payload_digest: [u8; 32],
    pub trust: Trust,
    pub timestamp_ms: u64,
    pub version_code: Option<u64>,
    pub licensing: Licensing,
    /// `MEETS_STRONG_INTEGRITY` present; without it the lease is one day.
    pub strong_integrity: bool,
    /// LEVEL_1 to LEVEL_4, `None` when unevaluated or not requested.
    pub activity_level: Option<u8>,
    pub device_recall: Option<DeviceRecall>,
    pub app_access_risk_present: bool,
}

/// Verifies a signed verdict token with the app's verification key, for the request nonce bytes
/// `expected_nonce`, at Unix time `now_ms` in milliseconds.
pub fn verify_verdict(
    token: &str,
    verification_key: &DevicePublicKey,
    expected_nonce: &[u8],
    policy: &PlayPolicy,
    now_ms: u64,
) -> Result<PlayVerdict, Refusal> {
    if token.len() > MAX_TOKEN {
        return Err(M);
    }
    let parts: Vec<&str> = token.split('.').collect();
    let &[header_b64, payload_b64, sig_b64] = &parts[..] else {
        return Err(M);
    };
    let header_bytes = b64::url_canonical(header_b64).ok_or(M)?;
    let header: Value = serde_json::from_slice(&header_bytes).map_err(|_| M)?;
    if header.get("alg").and_then(Value::as_str) != Some("ES256") {
        return Err(Refusal::UnsupportedAlgorithm);
    }
    if header.get("crit").is_some() {
        return Err(M);
    }
    let sig = b64::url_canonical(sig_b64).ok_or(M)?;
    if sig.len() != 64 {
        return Err(M);
    }
    let signing_input = &token[..header_b64.len() + 1 + payload_b64.len()];
    verification_key.verify_fixed(signing_input.as_bytes(), &sig)?;
    let payload = b64::url_canonical(payload_b64).ok_or(M)?;
    let v: Value = serde_json::from_slice(&payload).map_err(|_| M)?;

    let request = v.get("requestDetails").ok_or(M)?;
    if request.get("requestPackageName").and_then(Value::as_str) != Some(policy.package.as_str()) {
        return Err(Refusal::AppMismatch);
    }
    let nonce = request.get("nonce").and_then(Value::as_str).and_then(b64::lenient).ok_or(M)?;
    if nonce != expected_nonce {
        return Err(Refusal::ChallengeMismatch);
    }
    let timestamp_ms = uint_field(request.get("timestampMillis")).ok_or(M)?;
    let too_new = timestamp_ms > now_ms.saturating_add(policy.max_skew_ms);
    if too_new || now_ms.saturating_sub(timestamp_ms) > policy.max_age_ms {
        return Err(Refusal::VerdictStale);
    }

    let app = v.get("appIntegrity").ok_or(M)?;
    let recognition = app.get("appRecognitionVerdict").and_then(Value::as_str).ok_or(M)?;
    let digests: Vec<Vec<u8>> = match app.get("certificateSha256Digest") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            items.iter().map(|d| d.as_str().and_then(b64::lenient).ok_or(M)).collect::<Result<_, _>>()?
        }
        Some(_) => return Err(M),
    };
    let has = |set: &[[u8; 32]]| digests.iter().any(|d| set.iter().any(|s| s[..] == d[..]));
    let trust = if has(&policy.store_cert_digests) {
        Trust::Store
    } else if has(&policy.test_cert_digests) {
        Trust::Test
    } else {
        return Err(Refusal::AppMismatch);
    };
    if app.get("packageName").and_then(Value::as_str) != Some(policy.package.as_str()) {
        return Err(Refusal::AppMismatch);
    }
    if trust == Trust::Test && !policy.allow_test {
        return Err(Refusal::TestBuild);
    }
    // A locally signed build is unknown to Play; only store builds must be recognized.
    if trust == Trust::Store && recognition != "PLAY_RECOGNIZED" {
        return Err(Refusal::AppNotRecognized);
    }
    let version_code = uint_field(app.get("versionCode"));

    let device = v.get("deviceIntegrity").ok_or(M)?;
    let verdicts: Vec<&str> = match device.get("deviceRecognitionVerdict") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(|x| x.as_str().ok_or(M)).collect::<Result<_, _>>()?,
        Some(_) => return Err(M),
    };
    if !verdicts.contains(&"MEETS_DEVICE_INTEGRITY") {
        return Err(if verdicts.contains(&"MEETS_VIRTUAL_INTEGRITY") {
            Refusal::VirtualDevice
        } else {
            Refusal::DeviceIntegrity
        });
    }
    let strong_integrity = verdicts.contains(&"MEETS_STRONG_INTEGRITY");

    let licensing = match v.pointer("/accountDetails/appLicensingVerdict").and_then(Value::as_str) {
        Some("LICENSED") => Licensing::Licensed,
        Some("UNEVALUATED") => Licensing::Unevaluated,
        Some("UNLICENSED") => Licensing::Unlicensed,
        _ => return Err(M),
    };
    if licensing == Licensing::Unlicensed && trust == Trust::Store {
        return Err(Refusal::Unlicensed);
    }
    let app_access_risk_present = v.pointer("/environmentDetails/appAccessRiskVerdict").is_some();
    let licensed_store = trust == Trust::Store && licensing == Licensing::Licensed;
    if policy.require_app_access_risk && licensed_store && !app_access_risk_present {
        return Err(Refusal::FormFactorUnevaluated);
    }

    let activity_level = match device.pointer("/recentDeviceActivity/deviceActivityLevel").and_then(Value::as_str) {
        Some("LEVEL_1") => Some(1),
        Some("LEVEL_2") => Some(2),
        Some("LEVEL_3") => Some(3),
        Some("LEVEL_4") => Some(4),
        _ => None,
    };
    let device_recall = device.get("deviceRecall").map(|r| {
        let bit = |name: &str| r.pointer(&format!("/values/{}", name)).and_then(Value::as_bool).unwrap_or(false);
        let month = |name: &str| {
            r.pointer(&format!("/writeDates/{}", name)).and_then(Value::as_u64).and_then(|m| u32::try_from(m).ok())
        };
        DeviceRecall {
            first: bit("bitFirst"),
            second: bit("bitSecond"),
            third: bit("bitThird"),
            written_first: month("yyyymmFirst"),
            written_second: month("yyyymmSecond"),
            written_third: month("yyyymmThird"),
        }
    });

    Ok(PlayVerdict {
        payload_digest: sha256(&payload),
        trust,
        timestamp_ms,
        version_code,
        licensing,
        strong_integrity,
        activity_level,
        device_recall,
        app_access_risk_present,
    })
}

/// Protobuf JSON writes 64-bit integers as strings; plain numbers are accepted as well.
fn uint_field(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::play as t;

    fn policy() -> PlayPolicy {
        PlayPolicy {
            package: t::PACKAGE.to_string(),
            store_cert_digests: vec![t::STORE_DIGEST],
            test_cert_digests: vec![t::TEST_DIGEST],
            ..PlayPolicy::mainnet()
        }
    }

    fn run(v: &serde_json::Value, p: &PlayPolicy) -> Result<PlayVerdict, Refusal> {
        let signer = t::Signer::new();
        let token = signer.sign(v);
        verify_verdict(&token, &signer.public_key(), t::NONCE, p, t::NOW_MS)
    }

    #[test]
    fn store_verdict_passes() {
        let v = run(&t::verdict(), &policy()).unwrap();
        assert_eq!(v.trust, Trust::Store);
        assert_eq!(v.licensing, Licensing::Licensed);
        assert!(v.strong_integrity);
        assert_eq!(v.activity_level, Some(1));
        assert_eq!(v.version_code, Some(20));
        let recall = v.device_recall.unwrap();
        assert!(recall.first && !recall.second && !recall.third);
        assert_eq!(recall.written_first, Some(202609));
    }

    #[test]
    fn digest_is_of_the_payload_bytes() {
        let signer = t::Signer::new();
        let token = signer.sign(&t::verdict());
        let payload = b64::url_canonical(token.split('.').nth(1).unwrap()).unwrap();
        let v = verify_verdict(&token, &signer.public_key(), t::NONCE, &policy(), t::NOW_MS).unwrap();
        assert_eq!(v.payload_digest, sha256(&payload));
    }

    #[test]
    fn each_verdict_rule() {
        const VERDICTS: &str = "/deviceIntegrity/deviceRecognitionVerdict";
        let cases: Vec<(&str, serde_json::Value, Refusal)> = vec![
            ("/requestDetails/requestPackageName", "io.example.other".into(), Refusal::AppMismatch),
            ("/requestDetails/nonce", "b3RoZXI".into(), Refusal::ChallengeMismatch),
            ("/requestDetails/timestampMillis", (t::NOW_MS - 11 * 60 * 1000).to_string().into(), Refusal::VerdictStale),
            ("/requestDetails/timestampMillis", (t::NOW_MS + 2 * 60 * 1000).to_string().into(), Refusal::VerdictStale),
            ("/appIntegrity/appRecognitionVerdict", "UNRECOGNIZED_VERSION".into(), Refusal::AppNotRecognized),
            ("/appIntegrity/packageName", "io.example.other".into(), Refusal::AppMismatch),
            ("/appIntegrity/certificateSha256Digest", serde_json::json!([t::b64(&[7u8; 32])]), Refusal::AppMismatch),
            (VERDICTS, serde_json::json!([]), Refusal::DeviceIntegrity),
            (VERDICTS, serde_json::json!(["MEETS_BASIC_INTEGRITY"]), Refusal::DeviceIntegrity),
            (VERDICTS, serde_json::json!(["MEETS_VIRTUAL_INTEGRITY"]), Refusal::VirtualDevice),
            ("/accountDetails/appLicensingVerdict", "UNLICENSED".into(), Refusal::Unlicensed),
            ("/environmentDetails", serde_json::json!({}), Refusal::FormFactorUnevaluated),
            ("/accountDetails", serde_json::json!({}), M),
        ];
        for (path, value, want) in cases {
            let mut v = t::verdict();
            *v.pointer_mut(path).unwrap() = value;
            assert_eq!(run(&v, &policy()).unwrap_err(), want, "{}", path);
        }
    }

    #[test]
    fn unevaluated_licence_passes_without_the_form_factor_verdict() {
        let mut v = t::verdict();
        *v.pointer_mut("/accountDetails/appLicensingVerdict").unwrap() = "UNEVALUATED".into();
        *v.pointer_mut("/environmentDetails").unwrap() = serde_json::json!({});
        assert_eq!(run(&v, &policy()).unwrap().licensing, Licensing::Unevaluated);
    }

    #[test]
    fn test_builds() {
        let mut v = t::verdict();
        *v.pointer_mut("/appIntegrity/certificateSha256Digest").unwrap() = serde_json::json!([t::b64(&t::TEST_DIGEST)]);
        *v.pointer_mut("/appIntegrity/appRecognitionVerdict").unwrap() = "UNRECOGNIZED_VERSION".into();
        *v.pointer_mut("/accountDetails/appLicensingVerdict").unwrap() = "UNLICENSED".into();
        assert_eq!(run(&v, &policy()).unwrap_err(), Refusal::TestBuild);
        let mut p = policy();
        p.allow_test = true;
        assert_eq!(run(&v, &p).unwrap().trust, Trust::Test);
        // A test build still needs a genuine device.
        *v.pointer_mut("/deviceIntegrity/deviceRecognitionVerdict").unwrap() = serde_json::json!([]);
        assert_eq!(run(&v, &p).unwrap_err(), Refusal::DeviceIntegrity);
    }

    #[test]
    fn token_form() {
        let signer = t::Signer::new();
        let token = signer.sign(&t::verdict());
        let key = signer.public_key();
        let ok = |s: &str| verify_verdict(s, &key, t::NONCE, &policy(), t::NOW_MS);
        assert!(ok(&token).is_ok());
        let other = t::Signer::new().public_key();
        let err = verify_verdict(&token, &other, t::NONCE, &policy(), t::NOW_MS).unwrap_err();
        assert_eq!(err, Refusal::SignatureInvalid);
        let (head, rest) = token.split_once('.').unwrap();
        let hs256 = t::b64(br#"{"alg":"HS256"}"#);
        assert_eq!(ok(&format!("{}.{}", hs256, rest)).unwrap_err(), Refusal::UnsupportedAlgorithm);
        let crit = t::b64(br#"{"alg":"ES256","crit":["x"]}"#);
        assert_eq!(ok(&format!("{}.{}", crit, rest)).unwrap_err(), M);
        assert_eq!(ok(&format!("{}=.{}", head, rest)).unwrap_err(), M);
        assert_eq!(ok(&format!("{}.{}.x", head, rest)).unwrap_err(), M);
        assert_eq!(ok(head).unwrap_err(), M);
        let mut tampered = token.clone().into_bytes();
        let i = head.len() + 5;
        tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
        assert!(ok(std::str::from_utf8(&tampered).unwrap()).is_err());
    }
}

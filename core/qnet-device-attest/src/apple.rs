//! App Attest (iPhone and iPad): the attestation object of a new device key, the assertions the key
//! signs afterwards, and the device flags of an enrolment.
//!
//! The rules follow Apple's "Validating apps that connect to your server": the credential certificate
//! chains to the Apple App Attestation Root CA, its nonce extension equals
//! SHA-256(authenticatorData ‖ clientDataHash), the key identifier is SHA-256 of the certified point,
//! the RP ID hash is SHA-256 of the App ID, a fresh key has counter 0 and each assertion counter rises.
//! The `aaguid` names the environment: production builds are [`Trust::Store`], development builds
//! [`Trust::Test`].

use crate::cbor::{self, Value};
use crate::crypto::{sha256, sha256_two, DevicePublicKey, KeyKind};
use crate::der::{self, Reader, Tag};
use crate::x509::Certificate;
use crate::{app, Refusal, Trust};

/// Apple App Attestation Root CA (SHA-256 of the DER `1cb9823b…c932`).
pub const APP_ATTEST_ROOT_DER: &[u8] = include_bytes!("../roots/apple_app_attestation_root_ca.der");

const OID_NONCE: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02];
const OID_OS_INFO: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x07];

const AAGUID_PRODUCTION: &[u8; 16] = b"appattest\0\0\0\0\0\0\0";
// Apple's documents spell the development value two ways; both mean the development environment.
const AAGUID_DEVELOP: &[u8; 16] = b"appattestdevelop";
const AAGUID_SANDBOX: &[u8; 16] = b"appattestsandbox";

const FLAG_ATTESTED: u8 = 0x40;

/// Which App Attest environment produced the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Production,
    Development,
}

/// Local rules for App Attest evidence.
#[derive(Clone, Debug)]
pub struct IosPolicy {
    /// `<TeamID>.<bundle id>`.
    pub app_id: String,
    /// Accept development-environment keys (`trust = test`).
    pub allow_development: bool,
    /// Distribution categories (iOS 27 `apple_validation_category_01`) to refuse.
    pub refused_categories: Vec<u32>,
    /// When set, the leaf's platform string must be one of these; off until device tests fix the values.
    pub allowed_platforms: Option<Vec<String>>,
}

impl IosPolicy {
    /// Store builds only; development (3), enterprise and ad hoc (5), Developer ID (6) and other (10)
    /// builds refused.
    pub fn mainnet() -> Self {
        IosPolicy {
            app_id: app::IOS_APP_ID.to_string(),
            allow_development: false,
            refused_categories: vec![3, 5, 6, 10],
            allowed_platforms: None,
        }
    }

    /// Also accepts builds run from Xcode, so a locally built app runs the whole flow.
    pub fn testnet() -> Self {
        IosPolicy {
            app_id: app::IOS_APP_ID.to_string(),
            allow_development: true,
            refused_categories: Vec::new(),
            allowed_platforms: None,
        }
    }
}

/// What a valid attestation proves.
#[derive(Clone, Debug)]
pub struct VerifiedAttestation {
    pub public_key: DevicePublicKey,
    pub key_id: [u8; 32],
    pub environment: Environment,
    pub trust: Trust,
    /// iOS 27 and later: the distribution category of the build.
    pub validation_category: Option<u32>,
    /// iOS 27 and later: the bundle version of the build.
    pub bundle_version: Option<String>,
    /// Undocumented leaf fields, logged as signals only.
    pub os_version: Option<String>,
    pub os_build: Option<String>,
    pub platform: Option<String>,
    /// The ATTEST receipt, for the oracle's first receipt exchange.
    pub receipt: Vec<u8>,
}

/// What a valid assertion proves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedAssertion {
    pub counter: u32,
    pub validation_category: Option<u32>,
    pub bundle_version: Option<String>,
}

/// Verifies an attestation object for the key `key_id` over `client_data_hash` (SHA-256 of the
/// preimage in this protocol), at Unix time `now`.
pub fn verify_attestation(
    attestation_object: &[u8],
    key_id: &[u8; 32],
    client_data_hash: &[u8],
    policy: &IosPolicy,
    now: i64,
) -> Result<VerifiedAttestation, Refusal> {
    let root = Certificate::parse(APP_ATTEST_ROOT_DER)?;
    verify_attestation_with_root(attestation_object, key_id, client_data_hash, policy, now, &root)
}

pub(crate) fn verify_attestation_with_root(
    attestation_object: &[u8],
    key_id: &[u8; 32],
    client_data_hash: &[u8],
    policy: &IosPolicy,
    now: i64,
    root: &Certificate<'_>,
) -> Result<VerifiedAttestation, Refusal> {
    let obj = cbor::decode(attestation_object)?;
    let fmt = obj.get_text_key("fmt").and_then(Value::as_text).ok_or(Refusal::Malformed("fmt"))?;
    if fmt != "apple-appattest" {
        return Err(Refusal::AttestationFormat);
    }
    let stmt = obj.get_text_key("attStmt").ok_or(Refusal::Malformed("attStmt"))?;
    let auth_data = obj.get_text_key("authData").and_then(Value::as_bytes).ok_or(Refusal::Malformed("authData"))?;
    let x5c = match stmt.get_text_key("x5c") {
        Some(Value::Array(items)) => items,
        _ => return Err(Refusal::Malformed("x5c")),
    };
    let receipt = stmt.get_text_key("receipt").and_then(Value::as_bytes).ok_or(Refusal::Malformed("receipt"))?;
    if x5c.len() != 2 {
        return Err(Refusal::ChainShape);
    }
    let leaf_der = x5c[0].as_bytes().ok_or(Refusal::Malformed("x5c"))?;
    let ca_der = x5c[1].as_bytes().ok_or(Refusal::Malformed("x5c"))?;
    let leaf = Certificate::parse(leaf_der)?;
    let ca = Certificate::parse(ca_der)?;

    ca.verify_issued_by(root)?;
    leaf.verify_issued_by(&ca)?;
    ca.check_validity(now)?;
    leaf.check_validity(now)?;

    let ad = AuthData::parse(auth_data, true)?;
    let nonce = sha256_two(auth_data, client_data_hash);
    if leaf_nonce(&leaf)? != nonce {
        return Err(Refusal::ChallengeMismatch);
    }
    if leaf.spki.kind != KeyKind::P256 {
        return Err(Refusal::KeyType);
    }
    let public_key = DevicePublicKey::from_sec1(leaf.spki.key)?;
    if &public_key.key_id() != key_id {
        return Err(Refusal::KeyIdMismatch);
    }
    if ad.rp_id_hash != sha256(policy.app_id.as_bytes()) {
        return Err(Refusal::AppMismatch);
    }
    if ad.counter != 0 {
        return Err(Refusal::CounterNotZero);
    }
    let aaguid = ad.aaguid.ok_or(Refusal::Malformed("aaguid"))?;
    let environment = if aaguid == AAGUID_PRODUCTION {
        Environment::Production
    } else if aaguid == AAGUID_DEVELOP || aaguid == AAGUID_SANDBOX {
        Environment::Development
    } else {
        return Err(Refusal::UnknownEnvironment);
    };
    if ad.credential_id != Some(&key_id[..]) {
        return Err(Refusal::KeyIdMismatch);
    }
    let cose = ad.cose_key.as_ref().ok_or(Refusal::Malformed("cose key"))?;
    if !cose_key_matches(cose, &public_key) {
        return Err(Refusal::KeyIdMismatch);
    }
    let trust = match environment {
        Environment::Production => Trust::Store,
        Environment::Development => Trust::Test,
    };
    if trust == Trust::Test && !policy.allow_development {
        return Err(Refusal::TestBuild);
    }
    let (validation_category, bundle_version) = ad.extension_fields()?;
    if let Some(c) = validation_category {
        if policy.refused_categories.contains(&c) {
            return Err(Refusal::CategoryRefused(c));
        }
    }
    let (os_version, os_build, platform) = os_info(&leaf);
    if let Some(allowed) = &policy.allowed_platforms {
        match &platform {
            Some(p) if allowed.iter().any(|a| a == p) => {}
            _ => return Err(Refusal::PlatformRefused),
        }
    }
    Ok(VerifiedAttestation {
        public_key,
        key_id: *key_id,
        environment,
        trust,
        validation_category,
        bundle_version,
        os_version,
        os_build,
        platform,
        receipt: receipt.to_vec(),
    })
}

/// Verifies an assertion by a recorded key over `client_data_hash`; its counter must exceed
/// `last_counter` (0 right after the attestation).
pub fn verify_assertion(
    assertion: &[u8],
    public_key: &DevicePublicKey,
    app_id: &str,
    client_data_hash: &[u8],
    last_counter: u32,
) -> Result<VerifiedAssertion, Refusal> {
    let obj = cbor::decode(assertion)?;
    let signature = obj.get_text_key("signature").and_then(Value::as_bytes).ok_or(Refusal::Malformed("signature"))?;
    let auth_data = obj
        .get_text_key("authenticatorData")
        .and_then(Value::as_bytes)
        .ok_or(Refusal::Malformed("authenticatorData"))?;
    let ad = AuthData::parse(auth_data, false)?;
    let nonce = sha256_two(auth_data, client_data_hash);
    public_key.verify_der(&nonce, signature)?;
    if ad.rp_id_hash != sha256(app_id.as_bytes()) {
        return Err(Refusal::AppMismatch);
    }
    if ad.counter <= last_counter {
        return Err(Refusal::CounterNotIncreasing);
    }
    let (validation_category, bundle_version) = ad.extension_fields()?;
    Ok(VerifiedAssertion { counter: ad.counter, validation_category, bundle_version })
}

/// The device class an iOS enrolment reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Idiom {
    Phone,
    Pad,
}

/// Parses the iOS `flags` of an enrolment preimage: `mac=0,vision=0,idiom={phone|pad}` (spec 5.3).
pub fn parse_flags(flags: &str) -> Result<Idiom, Refusal> {
    let parts: Vec<&str> = flags.split(',').collect();
    let &[mac, vision, idiom] = &parts[..] else {
        return Err(Refusal::Malformed("flags"));
    };
    let bit = |part: &str, name: &str| -> Result<bool, Refusal> {
        match part.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            _ => Err(Refusal::Malformed("flags")),
        }
    };
    let on_mac = bit(mac, "mac")?;
    let on_vision = bit(vision, "vision")?;
    let idiom = match idiom {
        "idiom=phone" => Idiom::Phone,
        "idiom=pad" => Idiom::Pad,
        _ => return Err(Refusal::Malformed("flags")),
    };
    if on_mac || on_vision {
        return Err(Refusal::DesktopFlags);
    }
    Ok(idiom)
}

struct AuthData<'a> {
    rp_id_hash: [u8; 32],
    counter: u32,
    aaguid: Option<&'a [u8]>,
    credential_id: Option<&'a [u8]>,
    cose_key: Option<Value<'a>>,
    extensions: Option<Value<'a>>,
}

impl<'a> AuthData<'a> {
    /// `attested`: the attestation form with credential data; otherwise the 37-byte assertion form,
    /// which may carry an extensions map.
    fn parse(data: &'a [u8], attested: bool) -> Result<AuthData<'a>, Refusal> {
        const M: Refusal = Refusal::Malformed("authenticator data");
        if data.len() < 37 {
            return Err(M);
        }
        let mut rp_id_hash = [0u8; 32];
        rp_id_hash.copy_from_slice(&data[..32]);
        let flags = data[32];
        let counter = u32::from_be_bytes([data[33], data[34], data[35], data[36]]);
        let mut rest = &data[37..];
        let (mut aaguid, mut credential_id, mut cose_key) = (None, None, None);
        if attested {
            if flags & FLAG_ATTESTED == 0 || rest.len() < 18 {
                return Err(M);
            }
            aaguid = Some(&rest[..16]);
            let len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
            rest = &rest[18..];
            if rest.len() < len {
                return Err(M);
            }
            credential_id = Some(&rest[..len]);
            rest = &rest[len..];
            let (key, used) = cbor::decode_prefix(rest)?;
            cose_key = Some(key);
            rest = &rest[used..];
        }
        // Apple leaves the extension-data flag clear even when it appends the extensions map.
        let extensions = if rest.is_empty() {
            None
        } else {
            let ext = cbor::decode(rest)?;
            if !matches!(ext, Value::Map(_)) {
                return Err(M);
            }
            Some(ext)
        };
        Ok(AuthData { rp_id_hash, counter, aaguid, credential_id, cose_key, extensions })
    }

    fn extension_fields(&self) -> Result<(Option<u32>, Option<String>), Refusal> {
        let Some(ext) = &self.extensions else {
            return Ok((None, None));
        };
        let category = match ext.get_text_key("apple_validation_category_01") {
            None => None,
            Some(Value::Bytes(b)) if b.len() == 4 => Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            Some(v) => Some(
                v.as_int().and_then(|n| u32::try_from(n).ok()).ok_or(Refusal::Malformed("validation category"))?,
            ),
        };
        let version = match ext.get_text_key("apple_bundle_version_01") {
            None => None,
            Some(v) => Some(v.as_text().ok_or(Refusal::Malformed("bundle version"))?.to_string()),
        };
        Ok((category, version))
    }
}

/// The octet string inside the credential certificate's nonce extension.
fn leaf_nonce(leaf: &Certificate<'_>) -> Result<[u8; 32], Refusal> {
    const M: Refusal = Refusal::Malformed("nonce extension");
    let value = leaf.extension(OID_NONCE).ok_or(M)?;
    let mut r = Reader::der(value);
    let seq = r.expect_universal(der::SEQUENCE)?;
    r.finish()?;
    let mut s = seq.reader()?;
    let tagged = s.expect(Tag::context(1, true))?;
    s.finish()?;
    let mut t = tagged.reader()?;
    let octets = t.expect_universal(der::OCTET_STRING)?.octets()?;
    t.finish()?;
    octets.try_into().map_err(|_| M)
}

/// The EC2 COSE key must be the certified P-256 point.
fn cose_key_matches(cose: &Value<'_>, key: &DevicePublicKey) -> bool {
    let int = |k: i64| cose.get_int_key(k).and_then(Value::as_int);
    let bytes = |k: i64| cose.get_int_key(k).and_then(Value::as_bytes);
    let point = key.as_bytes();
    int(1) == Some(2)
        && int(3) == Some(-7)
        && int(-1) == Some(1)
        && bytes(-2) == Some(&point[1..33])
        && bytes(-3) == Some(&point[33..65])
}

/// OS version, build and platform from the leaf's OS-information extension; `None` on any
/// deviation, since Apple does not document the field.
fn os_info(leaf: &Certificate<'_>) -> (Option<String>, Option<String>, Option<String>) {
    let mut out = (None, None, None);
    let Some(value) = leaf.extension(OID_OS_INFO) else {
        return out;
    };
    let mut r = Reader::der(value);
    let Ok(seq) = r.expect_universal(der::SEQUENCE) else {
        return out;
    };
    let Ok(mut items) = seq.reader() else {
        return out;
    };
    while !items.is_empty() {
        let Ok(item) = items.read() else {
            return (None, None, None);
        };
        let text = || -> Option<String> {
            let mut ir = item.reader().ok()?;
            let inner = ir.read().ok()?;
            let bytes = inner.octets().ok()?;
            String::from_utf8(bytes.to_vec()).ok()
        };
        if item.tag.constructed {
            match item.tag.number {
                1400 => out.0 = text(),
                1403 => out.1 = text(),
                1026 => out.2 = text(),
                _ => {}
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::apple as t;

    fn policy() -> IosPolicy {
        IosPolicy {
            app_id: t::APP_ID.to_string(),
            allow_development: false,
            refused_categories: vec![3, 5, 6, 10],
            allowed_platforms: None,
        }
    }

    fn run(fx: &t::Fixture, p: &IosPolicy) -> Result<VerifiedAttestation, Refusal> {
        let root = Certificate::parse(&fx.root_der).unwrap();
        verify_attestation_with_root(&fx.object, &fx.key_id, &fx.client_data_hash, p, t::NOW, &root)
    }

    #[test]
    fn synthetic_attestation_passes() {
        let fx = t::Fixture::build(&t::Options::default());
        let v = run(&fx, &policy()).unwrap();
        assert_eq!(v.trust, Trust::Store);
        assert_eq!(v.validation_category, Some(4));
        assert_eq!(v.bundle_version.as_deref(), Some("20"));
        assert_eq!(v.platform.as_deref(), Some("iphoneos"));
        assert_eq!(v.os_version.as_deref(), Some("26.0"));
        assert_eq!(v.public_key.key_id(), fx.key_id);
    }

    #[test]
    fn development_keys_are_test_builds() {
        let fx = t::Fixture::build(&t::Options { aaguid: *b"appattestdevelop", ..Default::default() });
        assert_eq!(run(&fx, &policy()).unwrap_err(), Refusal::TestBuild);
        let mut p = policy();
        p.allow_development = true;
        assert_eq!(run(&fx, &p).unwrap().trust, Trust::Test);
        let fx = t::Fixture::build(&t::Options { aaguid: *b"appattestsandbox", ..Default::default() });
        assert_eq!(run(&fx, &p).unwrap().environment, Environment::Development);
    }

    #[test]
    fn each_attestation_rule() {
        let cases: Vec<(t::Options, Refusal)> = vec![
            (t::Options { aaguid: *b"somethingelse\0\0\0", ..Default::default() }, Refusal::UnknownEnvironment),
            (t::Options { counter: 1, ..Default::default() }, Refusal::CounterNotZero),
            (t::Options { credential_id: Some(vec![7u8; 32]), ..Default::default() }, Refusal::KeyIdMismatch),
            (t::Options { cose_mismatch: true, ..Default::default() }, Refusal::KeyIdMismatch),
            (t::Options { category: Some(5), ..Default::default() }, Refusal::CategoryRefused(5)),
            (t::Options { app_id: "OTHERTEAM1.com.qnetmobile".into(), ..Default::default() }, Refusal::AppMismatch),
            (t::Options { flags: 0x00, ..Default::default() }, Refusal::Malformed("authenticator data")),
            (t::Options { trailing: vec![0x01], ..Default::default() }, Refusal::Malformed("cbor")),
            (
                t::Options { category: None, bundle_version: None, trailing: vec![0x01], ..Default::default() },
                Refusal::Malformed("authenticator data"),
            ),
            (t::Options { wrong_nonce: true, ..Default::default() }, Refusal::ChallengeMismatch),
            (t::Options { leaf_p384: true, ..Default::default() }, Refusal::KeyType),
            (t::Options { leaf_expired: true, ..Default::default() }, Refusal::CertificateExpired),
            (t::Options { fmt: "packed".into(), ..Default::default() }, Refusal::AttestationFormat),
            (t::Options { extra_x5c: true, ..Default::default() }, Refusal::ChainShape),
            (t::Options { issuer_name_mismatch: true, ..Default::default() }, Refusal::ChainName),
        ];
        for (opts, want) in cases {
            let fx = t::Fixture::build(&opts);
            assert_eq!(run(&fx, &policy()).unwrap_err(), want, "{:?}", opts);
        }
    }

    #[test]
    fn platform_rule_is_opt_in() {
        let fx = t::Fixture::build(&t::Options { platform: "macosx".into(), ..Default::default() });
        assert!(run(&fx, &policy()).is_ok());
        let mut p = policy();
        p.allowed_platforms = Some(vec!["iphoneos".into()]);
        assert_eq!(run(&fx, &p).unwrap_err(), Refusal::PlatformRefused);
    }

    #[test]
    fn untrusted_root_fails_the_signature() {
        let fx = t::Fixture::build(&t::Options::default());
        let err = verify_attestation(&fx.object, &fx.key_id, &fx.client_data_hash, &policy(), t::NOW).unwrap_err();
        assert!(matches!(err, Refusal::ChainName | Refusal::ChainSignature), "{:?}", err);
    }

    #[test]
    fn flags() {
        assert_eq!(parse_flags("mac=0,vision=0,idiom=phone").unwrap(), Idiom::Phone);
        assert_eq!(parse_flags("mac=0,vision=0,idiom=pad").unwrap(), Idiom::Pad);
        assert_eq!(parse_flags("mac=1,vision=0,idiom=pad").unwrap_err(), Refusal::DesktopFlags);
        assert_eq!(parse_flags("mac=0,vision=1,idiom=pad").unwrap_err(), Refusal::DesktopFlags);
        for bad in [
            "",
            "mac=0,vision=0",
            "mac=0,vision=0,idiom=tv",
            "vision=0,mac=0,idiom=phone",
            "mac=2,vision=0,idiom=phone",
            "mac=0,vision=0,idiom=phone,x=1",
        ] {
            assert_eq!(parse_flags(bad).unwrap_err(), Refusal::Malformed("flags"), "{}", bad);
        }
    }
}

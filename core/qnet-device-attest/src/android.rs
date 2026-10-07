//! Android hardware key attestation: the certificate chain of a device key, from the key's
//! certificate to a Google root, and the key description inside it.
//!
//! Chain rules follow Google's reference verifier: at least three certificates, each named and signed
//! by the next; the root key is a pinned Google root; only the key's own certificate carries the key
//! description, and only the Google-issued attestation certificate of a remotely provisioned chain
//! carries provisioning information; every certificate is checked against the status list. The
//! key's certificate is dated by the device and is not checked for validity. A factory chain (its
//! top intermediate named by a serial number) stays trustworthy after it expires, because its keys
//! cannot be rotated; every other chain must be inside its validity dates.

use crate::cbor::{self, Value};
use crate::crypto::{DevicePublicKey, KeyKind};
use crate::der::{self, Reader, Tlv};
use crate::revocation::RevocationList;
use crate::x509::{name_attr, Certificate, OID_CN, OID_O, OID_SERIAL_NUMBER};
use crate::{app, Provisioning, Refusal, Trust};

/// Google's RSA attestation root (subject serialNumber `f92009e853b6b045`). Every issue of this root
/// carries the same key, so chains are matched by key.
pub const GOOGLE_ROOT_RSA_DER: &[u8] = include_bytes!("../roots/google_attestation_root_rsa.der");
/// Google's EC root "Key Attestation CA1", which signs chains from February 2026.
pub const GOOGLE_ROOT_EC_DER: &[u8] = include_bytes!("../roots/google_key_attestation_ca1.der");
/// The Android Keystore software attestation root, recognized only to name the refusal.
const SOFTWARE_ROOT_DER: &[u8] = include_bytes!("../roots/android_software_attestation_root.der");

const OID_KEY_DESCRIPTION: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11];
const OID_PROVISIONING_INFO: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x1e];

const MAX_CHAIN: usize = 8;
const MAX_PACKAGES: usize = 32;
const MAX_DIGESTS: usize = 10;

// AuthorizationList tags (KeyMint Tag.aidl numbers) and values used here.
const TAG_PURPOSE: u32 = 1;
const TAG_ALGORITHM: u32 = 2;
const TAG_EC_CURVE: u32 = 10;
const TAG_NO_AUTH_REQUIRED: u32 = 503;
const TAG_ORIGIN: u32 = 702;
const TAG_ROOT_OF_TRUST: u32 = 704;
const TAG_OS_VERSION: u32 = 705;
const TAG_OS_PATCH_LEVEL: u32 = 706;
const TAG_APPLICATION_ID: u32 = 709;
const TAG_VENDOR_PATCH_LEVEL: u32 = 718;
const TAG_BOOT_PATCH_LEVEL: u32 = 719;
const PURPOSE_SIGN: u64 = 2;
const ALGORITHM_EC: u64 = 3;
const CURVE_P256: u64 = 1;
const ORIGIN_GENERATED: u64 = 0;
const BOOT_VERIFIED: u64 = 0;

const M: Refusal = Refusal::Malformed("key description");

/// Where the attested key lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecurityLevel {
    TrustedEnvironment,
    StrongBox,
}

/// Local rules for Android key attestation.
#[derive(Clone, Debug)]
pub struct AndroidPolicy {
    pub package: String,
    /// SHA-256 of the store signing certificate (`trust = store`).
    pub store_cert_digests: Vec<[u8; 32]>,
    /// SHA-256 of the developer's own signing certificates (`trust = test`).
    pub test_cert_digests: Vec<[u8; 32]>,
    pub allow_test: bool,
    /// Accept factory-provisioned chains (they take the stricter lease and limits).
    pub allow_factory: bool,
}

impl AndroidPolicy {
    pub fn mainnet() -> Self {
        AndroidPolicy {
            package: app::ANDROID_PACKAGE.to_string(),
            store_cert_digests: vec![app::ANDROID_STORE_CERT_SHA256],
            test_cert_digests: vec![app::ANDROID_UPLOAD_CERT_SHA256],
            allow_test: false,
            allow_factory: true,
        }
    }

    /// Also accepts builds signed with the upload key, so a locally built app runs the whole flow.
    pub fn testnet() -> Self {
        AndroidPolicy { allow_test: true, ..Self::mainnet() }
    }
}

/// Provisioning information of a remotely provisioned attestation certificate.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProvisioningInfo {
    /// Certificates issued to the device in the last 30 days (Google's abuse signal).
    pub certs_issued: Option<u64>,
    /// "TEE" or "STRONG_BOX".
    pub attested_entity: Option<String>,
    pub lost_device: Option<bool>,
}

/// Encodings real devices produce that strict DER would refuse; accepted and reported.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Quirks {
    /// `deviceLocked` true encoded as a byte other than 0xFF.
    pub ber_boolean: bool,
    /// Authorization list tags out of ascending order.
    pub unordered_tags: bool,
}

/// What a valid chain proves.
#[derive(Clone, Debug)]
pub struct VerifiedKeyAttestation {
    pub public_key: DevicePublicKey,
    pub provisioning: Provisioning,
    pub security_level: SecurityLevel,
    pub trust: Trust,
    /// The key that signed the device key's certificate. A remotely provisioned one belongs to one app
    /// on one device (one live node per key); a factory one is shared by a batch of devices.
    pub attestation_key: Vec<u8>,
    pub provisioning_info: Option<ProvisioningInfo>,
    /// Serials of every certificate below the root, for the per-epoch status check.
    pub serials: Vec<String>,
    pub attestation_version: u64,
    pub keymint_version: u64,
    pub os_version: Option<u64>,
    pub os_patch_level: Option<u64>,
    pub vendor_patch_level: Option<u64>,
    pub boot_patch_level: Option<u64>,
    pub verified_boot_key: Vec<u8>,
    pub no_auth_required: bool,
    pub package_version: u64,
    pub quirks: Quirks,
}

/// Verifies a chain (DER certificates, the device key's first, the root last) for `challenge`
/// against the status list `revoked`, at Unix time `now`.
pub fn verify_key_attestation(
    chain: &[&[u8]],
    challenge: &[u8],
    policy: &AndroidPolicy,
    revoked: &RevocationList,
    now: i64,
) -> Result<VerifiedKeyAttestation, Refusal> {
    let roots = [Certificate::parse(GOOGLE_ROOT_RSA_DER)?, Certificate::parse(GOOGLE_ROOT_EC_DER)?];
    let root_keys: Vec<&[u8]> = roots.iter().map(|r| r.spki.raw).collect();
    verify_with_roots(chain, challenge, policy, revoked, now, &root_keys)
}

pub(crate) fn verify_with_roots(
    chain: &[&[u8]],
    challenge: &[u8],
    policy: &AndroidPolicy,
    revoked: &RevocationList,
    now: i64,
    root_keys: &[&[u8]],
) -> Result<VerifiedKeyAttestation, Refusal> {
    if chain.len() < 3 || chain.len() > MAX_CHAIN {
        return Err(Refusal::ChainShape);
    }
    let certs = chain.iter().map(|c| Certificate::parse(c)).collect::<Result<Vec<_>, _>>()?;
    let n = certs.len();
    let root = &certs[n - 1];
    if !root_keys.contains(&root.spki.raw) {
        let software = Certificate::parse(SOFTWARE_ROOT_DER)?;
        return Err(if root.spki.raw == software.spki.raw { Refusal::SoftwareRoot } else { Refusal::UntrustedRoot });
    }
    if !root.is_self_issued() {
        return Err(Refusal::ChainShape);
    }
    // Google classifies a chain by the certificate right below the root.
    let below_root = &certs[n - 2];
    let factory_shaped = name_attr(below_root.subject, OID_SERIAL_NUMBER).is_some();
    let rkp_shaped = !factory_shaped
        && name_attr(below_root.subject, OID_CN) == Some(&b"Droid CA2"[..])
        && name_attr(below_root.subject, OID_O) == Some(&b"Google LLC"[..]);

    for i in (0..n - 1).rev() {
        let cert = &certs[i];
        cert.verify_issued_by(&certs[i + 1])?;
        if i > 0 {
            match cert.check_validity(now) {
                Err(Refusal::CertificateExpired) if factory_shaped => {}
                other => other?,
            }
        }
    }
    let serials: Vec<String> = certs[..n - 1].iter().map(Certificate::serial_hex).collect();
    if serials.iter().any(|s| revoked.contains(s)) {
        return Err(Refusal::Revoked);
    }
    for (i, cert) in certs.iter().enumerate() {
        if i > 0 && cert.extension(OID_KEY_DESCRIPTION).is_some() {
            return Err(Refusal::ExtensionMisplaced);
        }
        if cert.extension(OID_PROVISIONING_INFO).is_some() && !(rkp_shaped && i == 1) {
            return Err(Refusal::ExtensionMisplaced);
        }
    }

    let leaf = &certs[0];
    let kd = KeyDescription::parse(leaf.extension(OID_KEY_DESCRIPTION).ok_or(M)?)?;
    if kd.challenge != challenge {
        return Err(Refusal::ChallengeMismatch);
    }
    let security_level = match (kd.attestation_level, kd.keymint_level) {
        (1, 1) => SecurityLevel::TrustedEnvironment,
        (2, 2) => SecurityLevel::StrongBox,
        (1..=2, 1..=2) => return Err(Refusal::SecurityLevelMismatch),
        _ => return Err(Refusal::SoftwareKeystore),
    };
    if rkp_shaped {
        let named = match name_attr(certs[1].subject, OID_O) {
            Some(b"TEE") => Some(SecurityLevel::TrustedEnvironment),
            Some(b"StrongBox") => Some(SecurityLevel::StrongBox),
            _ => None,
        };
        if named != Some(security_level) {
            return Err(Refusal::SecurityLevelMismatch);
        }
    }

    let hw = &kd.hardware;
    let key_ok = hw.uint(TAG_ALGORITHM)? == Some(ALGORITHM_EC)
        && hw.uint(TAG_EC_CURVE)? == Some(CURVE_P256)
        && hw.uint_set(TAG_PURPOSE)?.contains(&PURPOSE_SIGN)
        && hw.uint(TAG_ORIGIN)? == Some(ORIGIN_GENERATED)
        && leaf.spki.kind == KeyKind::P256;
    if !key_ok {
        return Err(Refusal::KeyType);
    }
    let public_key = DevicePublicKey::from_sec1(leaf.spki.key)?;

    let mut quirks = Quirks { unordered_tags: kd.software.unordered || hw.unordered, ..Quirks::default() };
    let rot = hw.get(TAG_ROOT_OF_TRUST).ok_or(Refusal::BootUnverified)?;
    let (boot_key, locked, state) = root_of_trust(rot, &mut quirks)?;
    if !locked || state != BOOT_VERIFIED {
        return Err(Refusal::BootUnverified);
    }

    let app_id = kd
        .software
        .get(TAG_APPLICATION_ID)
        .or_else(|| hw.get(TAG_APPLICATION_ID))
        .ok_or(Refusal::AppMismatch)?;
    let (package_version, digests) = application_id(app_id, &policy.package)?;
    let trust = if digests.iter().any(|d| policy.store_cert_digests.contains(d)) {
        Trust::Store
    } else if digests.iter().any(|d| policy.test_cert_digests.contains(d)) {
        Trust::Test
    } else {
        return Err(Refusal::AppMismatch);
    };
    if trust == Trust::Test && !policy.allow_test {
        return Err(Refusal::TestBuild);
    }

    let provisioning_info = match certs[1].extension(OID_PROVISIONING_INFO) {
        Some(v) if rkp_shaped => Some(provisioning_info(v)?),
        _ => None,
    };
    let provisioning = if provisioning_info.is_some() { Provisioning::Rkp } else { Provisioning::Factory };
    if provisioning == Provisioning::Factory && !policy.allow_factory {
        return Err(Refusal::FactoryProvisioned);
    }

    Ok(VerifiedKeyAttestation {
        public_key,
        provisioning,
        security_level,
        trust,
        attestation_key: certs[1].spki.key.to_vec(),
        provisioning_info,
        serials,
        attestation_version: kd.attestation_version,
        keymint_version: kd.keymint_version,
        os_version: hw.uint(TAG_OS_VERSION)?,
        os_patch_level: hw.uint(TAG_OS_PATCH_LEVEL)?,
        vendor_patch_level: hw.uint(TAG_VENDOR_PATCH_LEVEL)?,
        boot_patch_level: hw.uint(TAG_BOOT_PATCH_LEVEL)?,
        verified_boot_key: boot_key.to_vec(),
        no_auth_required: hw.get(TAG_NO_AUTH_REQUIRED).is_some(),
        package_version,
        quirks,
    })
}

struct KeyDescription<'a> {
    attestation_version: u64,
    attestation_level: u64,
    keymint_version: u64,
    keymint_level: u64,
    challenge: &'a [u8],
    software: AuthList<'a>,
    hardware: AuthList<'a>,
}

impl<'a> KeyDescription<'a> {
    fn parse(data: &'a [u8]) -> Result<Self, Refusal> {
        let mut r = Reader::der(data);
        let seq = r.expect_universal(der::SEQUENCE)?;
        r.finish()?;
        let mut s = seq.reader()?;
        let attestation_version = s.expect_universal(der::INTEGER)?.uint()?;
        let attestation_level = s.expect_universal(der::ENUMERATED)?.uint()?;
        let keymint_version = s.expect_universal(der::INTEGER)?.uint()?;
        let keymint_level = s.expect_universal(der::ENUMERATED)?.uint()?;
        let challenge = s.expect_universal(der::OCTET_STRING)?.octets()?;
        s.expect_universal(der::OCTET_STRING)?;
        let software = AuthList::parse(&s.expect_universal(der::SEQUENCE)?)?;
        let hardware = AuthList::parse(&s.expect_universal(der::SEQUENCE)?)?;
        s.finish()?;
        Ok(KeyDescription {
            attestation_version,
            attestation_level,
            keymint_version,
            keymint_level,
            challenge,
            software,
            hardware,
        })
    }
}

/// An AuthorizationList: `[tag] EXPLICIT value` entries, each tag at most once.
struct AuthList<'a> {
    entries: Vec<(u32, Tlv<'a>)>,
    unordered: bool,
}

impl<'a> AuthList<'a> {
    fn parse(seq: &Tlv<'a>) -> Result<Self, Refusal> {
        let mut entries: Vec<(u32, Tlv<'a>)> = Vec::new();
        let mut unordered = false;
        let mut r = seq.reader()?;
        while !r.is_empty() {
            let e = r.read()?;
            if e.tag.class != der::Class::Context || !e.tag.constructed {
                return Err(M);
            }
            let mut inner = e.reader()?;
            let value = inner.read()?;
            inner.finish()?;
            if let Some((last, _)) = entries.last() {
                if e.tag.number <= *last {
                    unordered = true;
                }
            }
            if entries.iter().any(|(t, _)| *t == e.tag.number) {
                return Err(M);
            }
            entries.push((e.tag.number, value));
        }
        Ok(AuthList { entries, unordered })
    }

    fn get(&self, tag: u32) -> Option<&Tlv<'a>> {
        self.entries.iter().find(|(t, _)| *t == tag).map(|(_, v)| v)
    }

    fn uint(&self, tag: u32) -> Result<Option<u64>, Refusal> {
        self.get(tag).map(|v| v.uint()).transpose()
    }

    fn uint_set(&self, tag: u32) -> Result<Vec<u64>, Refusal> {
        let Some(v) = self.get(tag) else {
            return Ok(Vec::new());
        };
        if !v.tag.is(der::SET) {
            return Err(M);
        }
        let mut out = Vec::new();
        let mut r = v.reader()?;
        while !r.is_empty() {
            out.push(r.read()?.uint()?);
        }
        Ok(out)
    }
}

fn root_of_trust<'a>(rot: &Tlv<'a>, quirks: &mut Quirks) -> Result<(&'a [u8], bool, u64), Refusal> {
    if !rot.tag.is(der::SEQUENCE) {
        return Err(M);
    }
    let mut r = rot.reader()?;
    let boot_key = r.expect_universal(der::OCTET_STRING)?.octets()?;
    let (locked, ber) = r.expect_universal(der::BOOLEAN)?.boolean_lenient()?;
    let state = r.expect_universal(der::ENUMERATED)?.uint()?;
    if !r.is_empty() {
        r.expect_universal(der::OCTET_STRING)?;
    }
    r.finish()?;
    quirks.ber_boolean |= ber;
    Ok((boot_key, locked, state))
}

/// Finds `package` in the AttestationApplicationId; returns its version and the signing digests.
fn application_id(tlv: &Tlv<'_>, package: &str) -> Result<(u64, Vec<[u8; 32]>), Refusal> {
    let bytes = tlv.octets()?;
    let mut r = Reader::der(bytes);
    let seq = r.expect_universal(der::SEQUENCE)?;
    r.finish()?;
    let mut s = seq.reader()?;
    let packages = s.expect_universal(der::SET)?;
    let digests = s.expect_universal(der::SET)?;
    s.finish()?;

    let mut version = None;
    let mut pr = packages.reader()?;
    let mut count = 0;
    while !pr.is_empty() {
        count += 1;
        if count > MAX_PACKAGES {
            return Err(M);
        }
        let info = pr.expect_universal(der::SEQUENCE)?;
        let mut ir = info.reader()?;
        let name = ir.expect_universal(der::OCTET_STRING)?.octets()?;
        let ver = ir.expect_universal(der::INTEGER)?.uint()?;
        ir.finish()?;
        std::str::from_utf8(name).map_err(|_| M)?;
        if name == package.as_bytes() {
            version = Some(ver);
        }
    }
    let mut out = Vec::new();
    let mut dr = digests.reader()?;
    while !dr.is_empty() {
        if out.len() == MAX_DIGESTS {
            return Err(M);
        }
        let d = dr.expect_universal(der::OCTET_STRING)?.octets()?;
        if let Ok(d) = <[u8; 32]>::try_from(d) {
            out.push(d);
        }
    }
    Ok((version.ok_or(Refusal::AppMismatch)?, out))
}

fn provisioning_info(value: &[u8]) -> Result<ProvisioningInfo, Refusal> {
    const P: Refusal = Refusal::Malformed("provisioning info");
    let map = cbor::decode(value)?;
    if !matches!(map, Value::Map(_)) {
        return Err(P);
    }
    let certs_issued = match map.get_int_key(1) {
        None => None,
        Some(v) => Some(v.as_int().and_then(|n| u64::try_from(n).ok()).ok_or(P)?),
    };
    // Informational only: no rule reads them, so another encoding never refuses a device.
    let attested_entity = map.get_int_key(4).and_then(Value::as_text).map(str::to_string);
    let lost_device = match map.get_int_key(6) {
        Some(Value::Bool(b)) => Some(*b),
        _ => None,
    };
    Ok(ProvisioningInfo { certs_issued, attested_entity, lost_device })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::android as t;

    fn run(
        fx: &t::Fixture,
        policy: &AndroidPolicy,
        revoked: &RevocationList,
        now: i64,
    ) -> Result<VerifiedKeyAttestation, Refusal> {
        let chain: Vec<&[u8]> = fx.chain.iter().map(Vec::as_slice).collect();
        verify_with_roots(&chain, t::CHALLENGE, policy, revoked, now, &[fx.root_spki.as_slice()])
    }

    fn policy() -> AndroidPolicy {
        AndroidPolicy {
            package: t::PACKAGE.to_string(),
            store_cert_digests: vec![t::STORE_DIGEST],
            test_cert_digests: vec![t::TEST_DIGEST],
            allow_test: false,
            allow_factory: true,
        }
    }

    fn check(opts: t::Options) -> Result<VerifiedKeyAttestation, Refusal> {
        run(&t::Fixture::build(&opts), &policy(), &RevocationList::default(), t::NOW)
    }

    #[test]
    fn synthetic_rkp_chain_passes() {
        let v = check(t::Options::default()).unwrap();
        assert_eq!(v.provisioning, Provisioning::Rkp);
        assert_eq!(v.security_level, SecurityLevel::TrustedEnvironment);
        assert_eq!(v.trust, Trust::Store);
        assert_eq!(v.provisioning_info.as_ref().unwrap().certs_issued, Some(3));
        assert_eq!(v.quirks, Quirks::default());
        assert_eq!(v.serials.len(), 4);
    }

    #[test]
    fn synthetic_factory_chain_and_strongbox() {
        let v = check(t::Options { factory: true, ..Default::default() }).unwrap();
        assert_eq!(v.provisioning, Provisioning::Factory);
        let mut p = policy();
        p.allow_factory = false;
        let fx = t::Fixture::build(&t::Options { factory: true, ..Default::default() });
        assert_eq!(run(&fx, &p, &RevocationList::default(), t::NOW).unwrap_err(), Refusal::FactoryProvisioned);
        let v = check(t::Options { level: 2, attest_org: "StrongBox".into(), ..Default::default() }).unwrap();
        assert_eq!(v.security_level, SecurityLevel::StrongBox);
    }

    #[test]
    fn rkp_shape_without_provisioning_info_is_factory() {
        let v = check(t::Options { provisioning_info: false, ..Default::default() }).unwrap();
        assert_eq!(v.provisioning, Provisioning::Factory);
    }

    #[test]
    fn test_builds_follow_policy() {
        assert_eq!(check(t::Options { digest: t::TEST_DIGEST, ..Default::default() }).unwrap_err(), Refusal::TestBuild);
        let mut p = policy();
        p.allow_test = true;
        let fx = t::Fixture::build(&t::Options { digest: t::TEST_DIGEST, ..Default::default() });
        assert_eq!(run(&fx, &p, &RevocationList::default(), t::NOW).unwrap().trust, Trust::Test);
    }

    #[test]
    fn each_chain_and_key_rule() {
        let cases: Vec<(t::Options, Refusal)> = vec![
            (t::Options { level: 0, ..Default::default() }, Refusal::SoftwareKeystore),
            (t::Options { keymint_level: Some(2), ..Default::default() }, Refusal::SecurityLevelMismatch),
            (t::Options { attest_org: "StrongBox".into(), ..Default::default() }, Refusal::SecurityLevelMismatch),
            (t::Options { locked: false, ..Default::default() }, Refusal::BootUnverified),
            (t::Options { boot_state: 1, ..Default::default() }, Refusal::BootUnverified),
            (t::Options { root_of_trust: false, ..Default::default() }, Refusal::BootUnverified),
            (t::Options { algorithm: 1, ..Default::default() }, Refusal::KeyType),
            (t::Options { origin: 2, ..Default::default() }, Refusal::KeyType),
            (t::Options { purpose_sign: false, ..Default::default() }, Refusal::KeyType),
            (t::Options { leaf_p384: true, ..Default::default() }, Refusal::KeyType),
            (t::Options { challenge: b"other".to_vec(), ..Default::default() }, Refusal::ChallengeMismatch),
            (t::Options { package: "io.example.other".into(), ..Default::default() }, Refusal::AppMismatch),
            (t::Options { digest: [9u8; 32], ..Default::default() }, Refusal::AppMismatch),
            (t::Options { key_description_in_attest: true, ..Default::default() }, Refusal::ExtensionMisplaced),
            (t::Options { provisioning_info_in_leaf: true, ..Default::default() }, Refusal::ExtensionMisplaced),
            (t::Options { issuer_name_mismatch: true, ..Default::default() }, Refusal::ChainName),
            (t::Options { rkp_expired: true, ..Default::default() }, Refusal::CertificateExpired),
            (t::Options { rkp_not_yet_valid: true, ..Default::default() }, Refusal::CertificateNotYetValid),
            (t::Options { duplicate_tag: true, ..Default::default() }, M),
            // Without the leaf, the attestation certificate's provisioning info sits at the bottom.
            (t::Options { drop_leaf: true, ..Default::default() }, Refusal::ExtensionMisplaced),
            (t::Options { drop_leaf: true, factory: true, ..Default::default() }, M),
        ];
        for (opts, want) in cases {
            let desc = format!("{:?}", opts);
            assert_eq!(check(opts).unwrap_err(), want, "{}", desc);
        }
    }

    #[test]
    fn expired_factory_intermediates_stay_valid() {
        assert!(check(t::Options { factory: true, rkp_expired: true, ..Default::default() }).is_ok());
        // Only a chain Google would call factory-provisioned: another top intermediate must be current.
        let plain = t::Options { factory: true, plain_top_name: true, ..Default::default() };
        assert_eq!(check(plain.clone()).unwrap().provisioning, Provisioning::Factory);
        let expired = t::Options { rkp_expired: true, ..plain };
        assert_eq!(check(expired).unwrap_err(), Refusal::CertificateExpired);
    }

    #[test]
    fn chain_length_is_not_fixed() {
        // A longer factory hierarchy verifies as Google's verifier accepts it.
        let v = check(t::Options { factory: true, extra_intermediate: true, ..Default::default() }).unwrap();
        assert_eq!(v.provisioning, Provisioning::Factory);
        assert_eq!(v.serials.len(), 4);
        let fx = t::Fixture::build(&t::Options::default());
        let two: Vec<&[u8]> = vec![&fx.chain[0], &fx.chain[4]];
        let err = verify_with_roots(&two, t::CHALLENGE, &policy(), &RevocationList::default(), t::NOW, &[&fx.root_spki])
            .unwrap_err();
        assert_eq!(err, Refusal::ChainShape);
    }

    #[test]
    fn informational_provisioning_fields_never_refuse() {
        let v = check(t::Options { provisioning_info_odd_types: true, ..Default::default() }).unwrap();
        let info = v.provisioning_info.unwrap();
        assert_eq!((info.certs_issued, info.attested_entity, info.lost_device), (Some(3), None, None));
    }

    #[test]
    fn revoked_serials() {
        let fx = t::Fixture::build(&t::Options::default());
        let serial = crate::x509::Certificate::parse(&fx.chain[1]).unwrap().serial_hex();
        let list = RevocationList::from_serials([serial.as_str()]).unwrap();
        assert_eq!(run(&fx, &policy(), &list, t::NOW).unwrap_err(), Refusal::Revoked);
    }

    #[test]
    fn lenient_encodings_are_reported() {
        let v = check(t::Options { ber_boolean: true, unordered: true, ..Default::default() }).unwrap();
        assert_eq!(v.quirks, Quirks { ber_boolean: true, unordered_tags: true });
    }

    #[test]
    fn unpinned_root() {
        let fx = t::Fixture::build(&t::Options::default());
        let chain: Vec<&[u8]> = fx.chain.iter().map(Vec::as_slice).collect();
        let none = RevocationList::default();
        let err = verify_key_attestation(&chain, t::CHALLENGE, &policy(), &none, t::NOW).unwrap_err();
        assert_eq!(err, Refusal::UntrustedRoot);
    }
}

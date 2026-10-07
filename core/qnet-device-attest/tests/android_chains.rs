//! Real device chains to the Google roots (see `testdata/android/NOTICE`): remotely provisioned and
//! factory chains, TEE and StrongBox, the RSA root and the 2026 EC root, and the refusals they must
//! produce.

mod common;

use common::*;
use qnet_device_attest::android::{self, AndroidPolicy, SecurityLevel, VerifiedKeyAttestation};
use qnet_device_attest::revocation::RevocationList;
use qnet_device_attest::{Provisioning, Refusal, Trust};

// Package and signing digest of the collector app that produced most of the chains.
const COLLECTOR: &str = "com.google.android.attestation";
const COLLECTOR_DIGEST: &str = "EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=";

fn policy(package: &str, digest_b64: &str) -> AndroidPolicy {
    AndroidPolicy {
        package: package.to_string(),
        store_cert_digests: vec![digest32(&b64(digest_b64))],
        test_cert_digests: vec![],
        allow_test: false,
        allow_factory: true,
    }
}

fn verify(file: &str, challenge: &[u8], policy: &AndroidPolicy, now: i64) -> Result<VerifiedKeyAttestation, Refusal> {
    let chain = pem_chain(&format!("android/{}", file));
    android::verify_key_attestation(&refs(&chain), challenge, policy, &RevocationList::default(), now)
}

const CAIMAN_TEE: &str = "caiman_sdk36_tee_ec_rkp.pem";
const CAIMAN_CHALLENGE: &[u8] = b"d688d763-6118-4ca6-94b2-e6cd9ed7e4e4";
const CAIMAN_NOW: i64 = 1_758_900_680;

#[test]
fn rkp_tee_chain_to_the_rsa_root() {
    let v = verify(CAIMAN_TEE, CAIMAN_CHALLENGE, &policy(COLLECTOR, COLLECTOR_DIGEST), CAIMAN_NOW).unwrap();
    assert_eq!(v.provisioning, Provisioning::Rkp);
    assert_eq!(v.security_level, SecurityLevel::TrustedEnvironment);
    assert_eq!(v.trust, Trust::Store);
    assert_eq!(v.attestation_version, 400);
    assert_eq!(v.keymint_version, 400);
    assert_eq!(v.os_version, Some(160_000));
    assert_eq!(v.os_patch_level, Some(202_511));
    assert_eq!(v.vendor_patch_level, Some(20_251_105));
    assert_eq!(v.boot_patch_level, Some(20_251_105));
    assert!(v.no_auth_required);
    assert_eq!(v.package_version, 0);
    assert_eq!(v.serials.len(), 4);
    assert_eq!(v.attestation_key.len(), 65);
    let info = v.provisioning_info.unwrap();
    assert!(info.certs_issued.is_some());
    assert_eq!(v.quirks, Default::default());
}

#[test]
fn rkp_strongbox_chain() {
    let v = verify(
        "caiman_sdk36_sb_ec_rkp.pem",
        b"7ccac1ea-4845-482e-858d-f6fa9aa8c295",
        &policy(COLLECTOR, COLLECTOR_DIGEST),
        1_758_900_646,
    )
    .unwrap();
    assert_eq!(v.provisioning, Provisioning::Rkp);
    assert_eq!(v.security_level, SecurityLevel::StrongBox);
    assert_eq!(v.attestation_version, 300);
}

#[test]
fn chains_to_the_2026_ec_root() {
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let v = verify("tegu_sdk36_tee_ec_2026_root.pem", b"6417f92c-daef-4cc1-8828-5bb39338ffd5", &p, 1_771_894_563);
    let v = v.unwrap();
    assert_eq!((v.provisioning, v.security_level), (Provisioning::Rkp, SecurityLevel::TrustedEnvironment));
    let v = verify("tegu_sdk36_sb_ec_2026_root.pem", b"90578e1d-f5bf-4ccf-a27f-a4f4d89ee21f", &p, 1_771_979_841);
    let v = v.unwrap();
    assert_eq!((v.provisioning, v.security_level), (Provisioning::Rkp, SecurityLevel::StrongBox));
    let v = verify("frankel_sdk37_tee_ec_2026.pem", b"e8652ec2-c321-4a3c-b115-95b59cff6835", &p, 1_788_561_021);
    let v = v.unwrap();
    assert_eq!(v.attestation_version, 500);
    assert_eq!(v.os_version, Some(170_000));
}

const OEM: &str = "oem_sdk33_tee_ec.pem";
const OEM_PACKAGE: &str = "com.android.vending";
const OEM_DIGEST: &str = "8P1sW0EPJcslw7UzRsiXL64w+O50Ed+RBICtay1g24M=";

fn oem_challenge() -> Vec<u8> {
    b64("Pq/k1d0AkN5aQrQytCSBr1zimWNlayWExZpJLeFtAMk=")
}

#[test]
fn factory_chain_from_another_manufacturer() {
    // 2026-06-04: the factory intermediate expired on 2026-05-24 and stays trustworthy.
    let v = verify(OEM, &oem_challenge(), &policy(OEM_PACKAGE, OEM_DIGEST), 1_780_585_145).unwrap();
    assert_eq!(v.provisioning, Provisioning::Factory);
    assert_eq!(v.security_level, SecurityLevel::TrustedEnvironment);
    assert!(v.provisioning_info.is_none());
    assert_eq!(v.attestation_version, 3);
    let mut rkp_only = policy(OEM_PACKAGE, OEM_DIGEST);
    rkp_only.allow_factory = false;
    assert_eq!(verify(OEM, &oem_challenge(), &rkp_only, 1_780_585_145).unwrap_err(), Refusal::FactoryProvisioned);
}

#[test]
fn ber_boolean_from_a_real_device() {
    let challenge = hex(concat!(
        "019B115A17FDF26B371309467080D0AEC1B5A0C1C6A7A3350B920560659FA79B97A21A751A9BF9F031323B99253619",
        "DCC4C31A4A8ABA0335006321620F2C70B3E80F0C504F6474B5F487898FE5877CF2D9D7C2CD255E235FA7"
    ));
    let digest = hex("3D7A1223019AA39D9EA0E3436AB7C0896BFB4FB679F4DE5FE7C23F326C8F994A");
    let p = AndroidPolicy {
        package: "com.google.android.apps.photos".into(),
        store_cert_digests: vec![digest32(&digest)],
        test_cert_digests: vec![],
        allow_test: false,
        allow_factory: true,
    };
    let v = verify("invalid_malformed_rot_device_locked.pem", &challenge, &p, 1_780_000_000).unwrap();
    assert!(v.quirks.ber_boolean);
    assert_eq!(v.package_version, 0x030D_266B);
}

#[test]
fn edited_key_certificate() {
    // The key description of this chain was reordered by hand after signing, so its certificate no
    // longer verifies (Google's verifier fails it too); an unordered list itself is accepted in the
    // synthetic chain tests.
    let p = policy("com.example.attestationcollector", "COpqbxUBTh4PcAZeUl0VJo+ONXwCSFZ2gRhz+N3mXEE=");
    let err = verify("invalid_tags_not_in_ascending_order.pem", b"challenge", &p, 1_780_000_000).unwrap_err();
    assert_eq!(err, Refusal::ChainSignature);
}

#[test]
fn unlocked_devices_are_compromised() {
    let collector = "com.google.wireless.android.security.attestationverifier.collector";
    let p = policy(collector, COLLECTOR_DIGEST);
    let err = verify("akita_sdk34_tee_ec_none.pem", b"challenge", &p, 1_727_389_885).unwrap_err();
    assert_eq!(err, Refusal::BootUnverified);
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let challenge = b"912895e0-3e19-4327-a0fb-91e2f3f46cdb";
    let err = verify("walleye_sdk27_tee_ec_none.pem", challenge, &p, 1_787_857_347).unwrap_err();
    assert_eq!(err, Refusal::BootUnverified);
}

#[test]
fn non_p256_device_keys() {
    let collector = "com.google.wireless.android.security.attestationverifier.collector";
    let p = policy(collector, COLLECTOR_DIGEST);
    assert_eq!(verify("akita_sdk34_tee_rsa_none.pem", b"challenge", &p, 1_727_389_884).unwrap_err(), Refusal::KeyType);
    let p = policy("android.keystore.cts", "bOzFDjSuMb+1Z4mG1tbTc2xXHe0vJFlSd5Ph8FTrDJs=");
    assert_eq!(verify("tokay_sdk37_tee_mldsa_rkp.pem", b"challenge", &p, 1_777_384_250).unwrap_err(), Refusal::KeyType);
    let err = verify("tokay_sdk37_tee_mldsa_factory.pem", b"challenge", &p, 1_777_375_215).unwrap_err();
    assert_eq!(err, Refusal::KeyType);
}

#[test]
fn software_attestation_root() {
    let p = policy("com.google.wireless.android.security.attestationverifier.collector", COLLECTOR_DIGEST);
    let err = verify("marlin_sdk29_tee_ec_none.pem", b"challenge", &p, 1_572_308_512).unwrap_err();
    assert_eq!(err, Refusal::SoftwareRoot);
}

#[test]
fn test_root_is_untrusted() {
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let err = verify("p256_sha384_intermediate.pem", b"challenge", &p, 1_780_000_000).unwrap_err();
    assert_eq!(err, Refusal::UntrustedRoot);
}

#[test]
fn rkp_chain_under_each_rule() {
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let run = |challenge: &[u8], p: &AndroidPolicy, now: i64| verify(CAIMAN_TEE, challenge, p, now);
    assert_eq!(run(b"another challenge", &p, CAIMAN_NOW).unwrap_err(), Refusal::ChallengeMismatch);
    // Remotely provisioned certificates live days to weeks; an expired one is refused.
    assert_eq!(run(CAIMAN_CHALLENGE, &p, 1_893_456_000).unwrap_err(), Refusal::CertificateExpired);
    assert_eq!(run(CAIMAN_CHALLENGE, &p, 1_577_836_800).unwrap_err(), Refusal::CertificateNotYetValid);
    let other_package = policy("io.aiqnet.wallet", COLLECTOR_DIGEST);
    assert_eq!(run(CAIMAN_CHALLENGE, &other_package, CAIMAN_NOW).unwrap_err(), Refusal::AppMismatch);
    let other_digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    assert_eq!(run(CAIMAN_CHALLENGE, &policy(COLLECTOR, other_digest), CAIMAN_NOW).unwrap_err(), Refusal::AppMismatch);
    let as_test = AndroidPolicy {
        store_cert_digests: vec![],
        test_cert_digests: vec![digest32(&b64(COLLECTOR_DIGEST))],
        ..p.clone()
    };
    assert_eq!(run(CAIMAN_CHALLENGE, &as_test, CAIMAN_NOW).unwrap_err(), Refusal::TestBuild);
    let allowed = AndroidPolicy { allow_test: true, ..as_test };
    assert_eq!(run(CAIMAN_CHALLENGE, &allowed, CAIMAN_NOW).unwrap().trust, Trust::Test);
}

#[test]
fn revoked_certificates() {
    let chain = pem_chain(&format!("android/{}", CAIMAN_TEE));
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let none = RevocationList::default();
    let v = android::verify_key_attestation(&refs(&chain), CAIMAN_CHALLENGE, &p, &none, CAIMAN_NOW).unwrap();
    for serial in &v.serials[1..] {
        let list = RevocationList::from_serials([serial.as_str(), "c8966fcb2fbb0d7a"]).unwrap();
        let err = android::verify_key_attestation(&refs(&chain), CAIMAN_CHALLENGE, &p, &list, CAIMAN_NOW).unwrap_err();
        assert_eq!(err, Refusal::Revoked);
    }
    // The same through Google's status format.
    let json = format!(
        r#"{{"entries": {{"{}": {{"status": "SUSPENDED", "reason": "KEY_COMPROMISE"}}}}}}"#,
        v.serials[2].to_uppercase()
    );
    let list = RevocationList::from_status_json(json.as_bytes()).unwrap();
    let err = android::verify_key_attestation(&refs(&chain), CAIMAN_CHALLENGE, &p, &list, CAIMAN_NOW).unwrap_err();
    assert_eq!(err, Refusal::Revoked);
}

#[test]
fn tampered_and_reshaped_chains() {
    let chain = pem_chain(&format!("android/{}", CAIMAN_TEE));
    let p = policy(COLLECTOR, COLLECTOR_DIGEST);
    let none = RevocationList::default();
    let check = |c: &[Vec<u8>]| android::verify_key_attestation(&refs(c), CAIMAN_CHALLENGE, &p, &none, CAIMAN_NOW);
    for i in 0..chain.len() - 1 {
        let mut c = chain.clone();
        let last = c[i].len() - 1;
        c[i][last] ^= 0x01;
        assert_eq!(check(&c).unwrap_err(), Refusal::ChainSignature, "certificate {}", i);
    }
    // Swapped intermediates, a dropped leaf, a doubled leaf, a chain of another device spliced in.
    let mut swapped = chain.clone();
    swapped.swap(1, 2);
    assert_eq!(check(&swapped).unwrap_err(), Refusal::ChainName);
    assert_eq!(check(&chain[1..]).unwrap_err(), Refusal::ExtensionMisplaced);
    let doubled: Vec<Vec<u8>> = std::iter::once(chain[0].clone()).chain(chain.iter().cloned()).collect();
    assert_eq!(check(&doubled).unwrap_err(), Refusal::ChainName);
    let other = pem_chain("android/caiman_sdk36_sb_ec_rkp.pem");
    let mut spliced = chain.clone();
    spliced[0] = other[0].clone();
    assert_eq!(check(&spliced).unwrap_err(), Refusal::ChainName);
    assert_eq!(check(&chain[..1]).unwrap_err(), Refusal::ChainShape);
}

//! Mutation tests: truncated, bit-flipped and spliced evidence never panics, and any change to
//! signed or checked bytes is refused. The generator is seeded, so failures reproduce.

mod common;

use common::*;
use qnet_device_attest::android::{self, AndroidPolicy};
use qnet_device_attest::apple::{self, IosPolicy};
use qnet_device_attest::play::{self, PlayPolicy};
use qnet_device_attest::receipt;
use qnet_device_attest::report;
use qnet_device_attest::revocation::RevocationList;
use qnet_device_attest::DevicePublicKey;

const APPLE_NOW: i64 = 1_776_795_252;

struct AppleSample {
    object: Vec<u8>,
    key_id: [u8; 32],
    cdh: Vec<u8>,
    policy: IosPolicy,
}

fn apple_sample() -> AppleSample {
    let text = std::fs::read_to_string(testdata("apple/validation_guide_sample.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    AppleSample {
        object: b64(&s("attestationObject")),
        key_id: digest32(&b64(&s("keyId"))),
        cdh: s("serverChallenge").into_bytes(),
        policy: IosPolicy {
            app_id: format!("{}.{}", s("teamId"), s("bundleId")),
            allow_development: false,
            refused_categories: vec![],
            allowed_platforms: None,
        },
    }
}

fn find(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len()).position(|w| w == needle).expect("needle")
}

#[test]
fn attestation_object_truncations() {
    let s = apple_sample();
    for len in 0..s.object.len() {
        let r = apple::verify_attestation(&s.object[..len], &s.key_id, &s.cdh, &s.policy, APPLE_NOW);
        assert!(r.is_err(), "{}", len);
    }
}

#[test]
fn attestation_object_mutations() {
    let s = apple_sample();
    assert!(apple::verify_attestation(&s.object, &s.key_id, &s.cdh, &s.policy, APPLE_NOW).is_ok());
    // Every byte of authData and of the two certificates is checked: a flip anywhere there fails.
    let receipt_at = find(&s.object, b"receipt");
    let auth_at = find(&s.object, b"authData");
    let mut rng = Rng::new(0x5eed_a771);
    for _ in 0..1000 {
        let mut m = s.object.clone();
        let i = rng.below(m.len());
        m[i] ^= 1 << rng.below(8);
        let r = apple::verify_attestation(&m, &s.key_id, &s.cdh, &s.policy, APPLE_NOW);
        let in_checked_bytes = (i > auth_at + 8) || (i < receipt_at && i > find(&s.object, b"x5c") + 3);
        if in_checked_bytes {
            assert!(r.is_err(), "flip at {} accepted", i);
        }
    }
    // Random splices and insertions anywhere: no panic.
    for _ in 0..1000 {
        let mut m = s.object.clone();
        let i = rng.below(m.len());
        match rng.below(3) {
            0 => m.insert(i, rng.next() as u8),
            1 => {
                m.remove(i);
            }
            _ => {
                let j = rng.below(m.len());
                m.swap(i, j);
            }
        }
        let _ = apple::verify_attestation(&m, &s.key_id, &s.cdh, &s.policy, APPLE_NOW);
    }
}

#[test]
fn receipt_mutations() {
    let s = apple_sample();
    let v = apple::verify_attestation(&s.object, &s.key_id, &s.cdh, &s.policy, APPLE_NOW).unwrap();
    let r = &v.receipt;
    for len in (0..r.len()).step_by(7) {
        assert!(receipt::verify_receipt(&r[..len], APPLE_NOW).is_err(), "{}", len);
    }
    let mut rng = Rng::new(0x0dd_ba11);
    for _ in 0..800 {
        let mut m = r.clone();
        let i = rng.below(m.len());
        m[i] ^= 1 << rng.below(8);
        let _ = receipt::verify_receipt(&m, APPLE_NOW);
    }
}

#[test]
fn assertion_mutations() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocols/light-node.vectors.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let ping = &v["device"]["ping"]["ios"];
    let assertion = b64url(ping["assertion"].as_str().unwrap());
    let pk = DevicePublicKey::from_sec1(&hex(v["device"]["keys"]["ios"]["publicKey"].as_str().unwrap())).unwrap();
    let cdh = digest32(&hex(ping["clientDataHash"].as_str().unwrap()));
    let app = format!("{}.com.qnetmobile", v["device"]["sampleTeamId"].as_str().unwrap());
    assert!(apple::verify_assertion(&assertion, &pk, &app, &cdh, 0).is_ok());
    for len in 0..assertion.len() {
        assert!(apple::verify_assertion(&assertion[..len], &pk, &app, &cdh, 0).is_err());
    }
    // Every byte of an assertion is framing, signature or signed data.
    for i in 0..assertion.len() {
        for bit in 0..8 {
            let mut m = assertion.clone();
            m[i] ^= 1 << bit;
            assert!(apple::verify_assertion(&m, &pk, &app, &cdh, 0).is_err(), "flip {}:{}", i, bit);
        }
    }
}

fn caiman() -> (Vec<Vec<u8>>, AndroidPolicy) {
    let chain = pem_chain("android/caiman_sdk36_tee_ec_rkp.pem");
    let policy = AndroidPolicy {
        package: "com.google.android.attestation".into(),
        store_cert_digests: vec![digest32(&b64("EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE="))],
        test_cert_digests: vec![],
        allow_test: false,
        allow_factory: true,
    };
    (chain, policy)
}

const CAIMAN_CHALLENGE: &[u8] = b"d688d763-6118-4ca6-94b2-e6cd9ed7e4e4";
const CAIMAN_NOW: i64 = 1_758_900_680;

#[test]
fn android_chain_mutations() {
    let (chain, policy) = caiman();
    let none = RevocationList::default();
    let run = |c: &[Vec<u8>]| android::verify_key_attestation(&refs(c), CAIMAN_CHALLENGE, &policy, &none, CAIMAN_NOW);
    assert!(run(&chain).is_ok());
    let mut rng = Rng::new(0xa77e_57ed);
    // Below the root every byte is signed, a signature, or framing checked against its copy.
    for _ in 0..1200 {
        let mut c = chain.clone();
        let k = rng.below(c.len() - 1);
        let i = rng.below(c[k].len());
        c[k][i] ^= 1 << rng.below(8);
        assert!(run(&c).is_err(), "flip in certificate {} at {} accepted", k, i);
    }
    // The root is pinned by key: flips there never panic.
    let root = chain.len() - 1;
    for _ in 0..300 {
        let mut c = chain.clone();
        let i = rng.below(c[root].len());
        c[root][i] ^= 1 << rng.below(8);
        let _ = run(&c);
    }
    for k in 0..chain.len() {
        for len in (0..chain[k].len()).step_by(11) {
            let mut c = chain.clone();
            c[k].truncate(len);
            assert!(run(&c).is_err());
        }
    }
}

#[test]
fn random_bytes_everywhere() {
    let mut rng = Rng::new(0xfeed_f00d);
    let (_, policy) = caiman();
    let s = apple_sample();
    let pk = DevicePublicKey::from_sec1(&[4u8; 65]).unwrap();
    for _ in 0..3000 {
        let len = rng.below(600);
        let data: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
        let _ = apple::verify_attestation(&data, &s.key_id, &s.cdh, &s.policy, APPLE_NOW);
        let _ = apple::verify_assertion(&data, &pk, "A.b", &s.cdh, 0);
        let _ = receipt::verify_receipt(&data, APPLE_NOW);
        let d: &[u8] = &data;
        let _ = android::verify_key_attestation(&[d, d, d, d], b"c", &policy, &RevocationList::default(), 0);
        let _ = RevocationList::from_status_json(&data);
        let _ = DevicePublicKey::from_spki_der(&data);
        let text = String::from_utf8_lossy(&data);
        let _ = report::DeviceReport::parse(&text);
        let _ = apple::parse_flags(&text);
        let _ = play::verify_verdict(&text, &pk, b"n", &PlayPolicy::mainnet(), 0);
        // Structured prefixes reach deeper parsers.
        let mut cbor = vec![0xa3];
        cbor.extend_from_slice(&data);
        let _ = apple::verify_attestation(&cbor, &s.key_id, &s.cdh, &s.policy, APPLE_NOW);
        let mut der = vec![0x30, 0x80, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
        der.extend_from_slice(&data);
        let _ = receipt::verify_receipt(&der, APPLE_NOW);
    }
}

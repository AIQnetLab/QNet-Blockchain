//! The device-layer part of the shared light-node vectors (`docs/protocols/light-node.vectors.json`),
//! checked with this crate's verifiers: every iOS assertion and every Android device signature.

mod common;

use common::*;
use qnet_device_attest::apple;
use qnet_device_attest::report;
use qnet_device_attest::{DevicePublicKey, Refusal};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocols/light-node.vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("light-node.vectors.json")).unwrap()
}

fn key(v: &Value, name: &str) -> DevicePublicKey {
    let k = &v["device"]["keys"][name];
    let pk = DevicePublicKey::from_sec1(&hex(k["publicKey"].as_str().unwrap())).unwrap();
    assert_eq!(pk.key_id().to_vec(), b64url(k["keyId"].as_str().unwrap()), "key id of {}", name);
    pk
}

fn app_id(v: &Value) -> String {
    format!("{}.{}", v["device"]["sampleTeamId"].as_str().unwrap(), v["constants"]["iosBundleId"].as_str().unwrap())
}

/// Checks one iOS assertion vector over `preimage`.
fn check_assertion(v: &Value, a: &Value, preimage: &str, pk: &DevicePublicKey) {
    let cdh = sha256(preimage.as_bytes());
    assert_eq!(cdh.to_vec(), hex(a["clientDataHash"].as_str().unwrap()), "clientDataHash of {}", preimage);
    let assertion = b64url(a["assertion"].as_str().unwrap());
    let counter = a["counter"].as_u64().unwrap() as u32;
    let app = app_id(v);
    let ok = apple::verify_assertion(&assertion, pk, &app, &cdh, counter - 1).unwrap();
    assert_eq!(ok.counter, counter);
    let refused =
        |app: &str, cdh: &[u8], last: u32| apple::verify_assertion(&assertion, pk, app, cdh, last).unwrap_err();
    assert_eq!(refused(&app, &cdh, counter), Refusal::CounterNotIncreasing);
    assert_eq!(refused("33H36C42XS.com.example", &cdh, 0), Refusal::AppMismatch);
    assert_eq!(refused(&app, &sha256(b"other"), 0), Refusal::SignatureInvalid);
}

fn check_android(pk: &DevicePublicKey, preimage: &str, sig_b64url: &str) {
    let sig = b64url(sig_b64url);
    pk.verify_der(preimage.as_bytes(), &sig).unwrap();
    let mut other = preimage.as_bytes().to_vec();
    other.push(b'x');
    assert_eq!(pk.verify_der(&other, &sig).unwrap_err(), Refusal::SignatureInvalid);
}

#[test]
fn rp_id_hash_is_the_app_id_hash() {
    let v = vectors();
    assert_eq!(sha256(app_id(&v).as_bytes()).to_vec(), hex(v["device"]["rpIdHash"].as_str().unwrap()));
}

#[test]
fn ios_assertions() {
    let v = vectors();
    let ios = key(&v, "ios");
    key(&v, "iosRotated");
    let mut seen = 0;
    for m in v["device"]["messages"].as_array().unwrap().iter().filter(|m| m["platform"] == "ios") {
        let preimage = m["preimage"].as_str().unwrap();
        for field in ["reenrolAssertion", "oldKey", "device"] {
            if m[field].is_object() {
                check_assertion(&v, &m[field], preimage, &ios);
                seen += 1;
            }
        }
    }
    let ping = &v["device"]["ping"]["ios"];
    check_assertion(&v, ping, ping["preimage"].as_str().unwrap(), &ios);
    assert_eq!(seen, 5);
}

#[test]
fn android_device_signatures() {
    let v = vectors();
    let android = key(&v, "android");
    let rotated = key(&v, "androidRotated");
    let r = &v["device"]["report"];
    let text = r["text"].as_str().unwrap();
    let rep = report::verify_device_report(text, &b64url(r["signatureDer"].as_str().unwrap()), &android).unwrap();
    assert!(rep.system_user && rep.touchscreen);
    let mut seen = 0;
    for m in v["device"]["messages"].as_array().unwrap().iter().filter(|m| m["platform"] == "android") {
        let preimage = m["preimage"].as_str().unwrap();
        for field in ["oldKey", "device"] {
            if let Some(sig) = m[field]["signatureDer"].as_str() {
                check_android(&android, preimage, sig);
                seen += 1;
            }
        }
        if let Some(sig) = m["newKeyReportSignatureDer"].as_str() {
            report::verify_device_report(text, &b64url(sig), &rotated).unwrap();
            assert_eq!(
                report::verify_device_report(text, &b64url(sig), &android).unwrap_err(),
                Refusal::SignatureInvalid
            );
        }
    }
    let ping = &v["device"]["ping"]["android"];
    check_android(&android, ping["preimage"].as_str().unwrap(), ping["signatureDer"].as_str().unwrap());
    assert_eq!(seen, 4);
}

#[test]
fn report_refusals_through_the_signed_path() {
    let v = vectors();
    let android = key(&v, "android");
    let r = &v["device"]["report"];
    let text = r["text"].as_str().unwrap();
    let sig = b64url(r["signatureDer"].as_str().unwrap());
    // A changed report no longer matches its signature.
    let desktop = text.replace("\"feature_pc\":false", "\"feature_pc\":true");
    assert_eq!(report::verify_device_report(&desktop, &sig, &android).unwrap_err(), Refusal::SignatureInvalid);
}

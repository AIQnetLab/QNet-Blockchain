//! The oracle's preimages and tags against the shared protocol vectors
//! (docs/protocols/light-node.vectors.json), the one source the app, the site and the node also test.

use qnet_device_oracle::messages::*;
use qnet_device_oracle::signer;
use qnet_device_oracle::types::{Effective, Gate, LeaseKind, Platform};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocols/light-node.vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).expect("vectors JSON")
}

fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for p in path {
        cur = &cur[*p];
    }
    cur.as_str().unwrap_or_else(|| panic!("missing {:?}", path))
}

fn tag32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

#[test]
fn device_tags_match() {
    let v = vectors();
    let chain = s(&v, &["constants", "chainId"]);
    for (platform, name) in [(Platform::Ios, "ios"), (Platform::Android, "android")] {
        let pubk = hex::decode(s(&v, &["device", "keys", name, "publicKey"])).unwrap();
        assert_eq!(hex::encode(device_tag(chain, platform, &pubk)), s(&v, &["device", "deviceTags", name]));
        assert_eq!(hex::encode(sha3_256(&pubk)), s(&v, &["device", "keys", name, "publicKeySha3"]));
    }
}

#[test]
fn lease_statements_match_and_their_signatures_verify() {
    let v = vectors();
    let chain = s(&v, &["constants", "chainId"]);
    let oracle_pk = hex::decode(s(&v, &["device", "oracle", "publicKey"])).unwrap();
    for st in v["device"]["statements"].as_array().unwrap() {
        let lease = st["lease"].as_str().unwrap();
        let f: Vec<&str> = lease.split('|').collect();
        let kind = match f[4] {
            "claimed_virgin" => LeaseKind::ClaimedVirgin,
            "self_reclaim" => LeaseKind::SelfReclaim,
            "claimed_foreign" => LeaseKind::ClaimedForeign,
            _ => LeaseKind::None,
        };
        let eff = if f[5] == "now" { Effective::Now } else { Effective::Next };
        let gate = match f[6] {
            "ok" => Gate::Ok,
            "metric_high" => Gate::MetricHigh,
            "certs_high" => Gate::CertsHigh,
            _ => Gate::Na,
        };
        let fields = &st["statementFields"];
        let rebuilt = lease_preimage(
            chain,
            fields["nodeId"].as_str().unwrap(),
            &tag32(fields["deviceTag"].as_str().unwrap()),
            kind,
            eff,
            gate,
            f[7],
            f[8].parse().unwrap(),
        );
        assert_eq!(rebuilt, lease);
        if let Some(payload) = st["piPayload"].as_str() {
            assert_eq!(hex::encode(sha256(payload.as_bytes())), f[7], "pi_digest is SHA-256 of the verdict payload");
        }
        let sig = hex::decode(st["oracleSignature"].as_str().unwrap()).unwrap();
        assert!(signer::verify(&oracle_pk, lease.as_bytes(), &sig), "the vector's oracle signature verifies here");
        let mut other = lease.as_bytes().to_vec();
        other[0] ^= 1;
        assert!(!signer::verify(&oracle_pk, &other, &sig));
    }
}

#[test]
fn revocation_snapshot_matches() {
    let v = vectors();
    let crl = &v["device"]["crl"];
    let serials = crl["serials"].as_array().unwrap().iter().map(|x| x.as_str().unwrap());
    let text = qnet_device_attest::revocation::RevocationList::from_serials(serials).unwrap().canonical_text();
    assert_eq!(text, s(crl, &["listText"]));
    assert_eq!(hex::encode(sha3_256(text.as_bytes())), s(crl, &["listSha3"]));
    assert_eq!(crl_preimage(s(crl, &["fetchedAt"]).parse().unwrap(), &text), s(crl, &["preimage"]));
}

#[test]
fn support_reference_matches() {
    let v = vectors();
    let st = &v["device"]["status"];
    let nonce: [u8; 32] = b64url_decode(s(st, &["refNonce"])).unwrap().try_into().unwrap();
    let tag = tag32(s(&v, &["device", "deviceTags", "android"]));
    assert_eq!(reference(&nonce, &tag), s(st, &["ref", "android"]));
}

#[test]
fn every_device_message_parses_and_play_nonces_match() {
    let v = vectors();
    let chain = s(&v, &["constants", "chainId"]);
    let report_sha3 = tag32(s(&v, &["device", "report", "sha3"]));
    for m in v["device"]["messages"].as_array().unwrap() {
        let pre = m["preimage"].as_str().unwrap();
        let parsed = parse_device_message(pre, chain).unwrap_or_else(|| panic!("refused {}", pre));
        assert_eq!(b64url(&parsed.nonce), m["nonce"].as_str().unwrap());
        assert!(parse_device_message(pre, "1338").is_none(), "another chain id is refused");
        assert!(parse_device_message(&format!("{} ", pre), chain).is_none());
        let Some(expected) = m["playNonce"].as_str() else { continue };
        let got = match m["name"].as_str().unwrap() {
            "enrol" => {
                assert_eq!(parsed.report_sha3, Some(report_sha3));
                let key = if m["platform"] == "android" { "android" } else { "ios" };
                let pubk = hex::decode(s(&v, &["device", "keys", key, "publicKey"])).unwrap();
                play_nonce_enrol(pre, &pubk, &report_sha3)
            }
            "rotate" => {
                assert_eq!(parsed.old_key.as_deref(), Some(s(&v, &["device", "keys", "android", "publicKeySha3"])));
                play_nonce(pre)
            }
            _ => play_nonce(pre),
        };
        assert_eq!(got, expected, "{}", m["name"]);
    }
}

#[test]
fn malformed_device_messages_are_refused() {
    let good = "qnet_dev_refresh:v1|1337|light_mobile_6526ab8fd00ff8ca|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA";
    assert!(parse_device_message(good, "1337").is_some());
    for bad in [
        "qnet_dev_refresh:v1|1337|light_mobile_6526AB8FD00FF8CA|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA",
        "qnet_dev_refresh:v1|1337|light_mobile_6526ab8fd00ff8ca|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA=",
        "qnet_dev_refresh:v1|1337|light_mobile_6526ab8fd00ff8ca|CKPOgMHXzZpRRiqe",
        "qnet_dev_refresh:v2|1337|light_mobile_6526ab8fd00ff8ca|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA",
        "qnet_dev_release:v1|1337|light_mobile_6526ab8fd00ff8ca|01790000000|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA",
        "qnet_dev_rebind:v1|1337|light_mobile_6526ab8fd00ff8ca|light_mobile_6526ab8fd00ff8ca|1|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA",
    ] {
        assert!(parse_device_message(bad, "1337").is_none(), "{}", bad);
    }
    let enrol = |flags: &str| {
        format!(
            "qnet_dev_enrol:v1|1337|light_mobile_6526ab8fd00ff8ca|d9fa370374e24333242eon847d1d354dcd87fe873823e|{}|1790000000|CKPOgMHXzZpRRiqe-KKo15GTt_9bFeoYexzDa-6tlhA|{}",
            "e3".repeat(32),
            flags
        )
    };
    assert!(parse_device_message(&enrol("mac=0,vision=0,idiom=pad"), "1337").is_some());
    for flags in ["mac=1,vision=0,idiom=phone", "mac=0,vision=1,idiom=pad", "mac=0,vision=0,idiom=desktop", "mac=0"] {
        assert!(parse_device_message(&enrol(flags), "1337").is_none(), "{}", flags);
    }
}

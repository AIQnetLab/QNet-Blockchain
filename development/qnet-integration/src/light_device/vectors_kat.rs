//! The device section of the shared contract file (`docs/protocols/light-node.vectors.json`), rebuilt byte
//! for byte with the node's own functions and checked with the node's own verifiers: every device
//! preimage, challenge hash and Play nonce, every device signature and assertion, the ping reply and its
//! wire form, the tags and the support reference, the lease and device statements with the oracle's
//! signature, the state change and the revocation snapshot. The app, the site, the extension and the
//! oracle test the same file.

use serde_json::Value;

use super::evidence::{Policies, Verifier};
use super::messages::{self, LeaseStatement, StatementFields};
use super::statement::{self, OraclePins};
use super::{DeviceState, Op, Platform, Prov, Trust, EPOCH_BLOCKS};
use crate::light_binding as lb;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../../docs/protocols/light-node.vectors.json")).expect("vectors parse")
}

fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    let mut cur = v;
    for p in path { cur = &cur[*p]; }
    cur.as_str().unwrap_or_else(|| panic!("missing {:?}", path))
}

fn num(v: &Value, path: &[&str]) -> u64 {
    s(v, path).parse().unwrap_or_else(|_| panic!("not a number {:?}", path))
}

fn unhex(h: &str) -> Vec<u8> {
    hex::decode(h).unwrap()
}

fn unb64(t: &str) -> Vec<u8> {
    messages::b64url_decode(t).unwrap_or_else(|| panic!("not canonical b64url: {t}"))
}

/// The node's verifier with the contract's sample Team ID in the App ID, so the file's assertions verify.
fn verifier(v: &Value) -> Verifier {
    let mut p = Policies::for_network(false);
    p.ios.app_id = format!("{}.{}", s(v, &["device", "sampleTeamId"]), s(v, &["constants", "iosBundleId"]));
    Verifier { policies: p, attest: |_, _, _, _, _| unreachable!("the file carries no vendor attestation objects") }
}

fn key(v: &Value, name: &str) -> Vec<u8> {
    unhex(s(v, &["device", "keys", name, "publicKey"]))
}

fn platform(m: &Value) -> Platform {
    Platform::parse(m["platform"].as_str().unwrap()).unwrap()
}

/// An iOS assertion of the file: its authenticator data and nonce rebuilt, and the CBOR verified with the
/// node's verifier over `preimage`, its counter above the one before.
fn check_ios_assertion(v: &Value, ver: &Verifier, pk: &[u8], a: &Value, preimage: &str) {
    let cdh = messages::sha256(preimage.as_bytes());
    assert_eq!(s(a, &["clientDataHash"]), hex::encode(cdh));
    let counter = a["counter"].as_u64().unwrap();
    let mut ad = unhex(s(v, &["device", "rpIdHash"]));
    ad.push(0);
    ad.extend_from_slice(&(counter as u32).to_be_bytes());
    assert_eq!(s(a, &["authenticatorData"]), hex::encode(&ad));
    let mut n = ad.clone();
    n.extend_from_slice(&cdh);
    assert_eq!(s(a, &["nonce"]), hex::encode(messages::sha256(&n)));
    let got = ver.verify_known_key(Platform::Ios, pk, &unb64(s(a, &["assertion"])), preimage, counter - 1).expect("assertion");
    assert_eq!(got as u64, counter);
    assert!(ver.verify_known_key(Platform::Ios, pk, &unb64(s(a, &["assertion"])), preimage, counter).is_err(),
            "a counter at or below the last one is refused");
    assert!(ver.verify_known_key(Platform::Ios, pk, &unb64(s(a, &["assertion"])), &format!("{preimage}x"), 0).is_err());
    let key = qnet_device_attest::DevicePublicKey::from_sec1(pk).unwrap();
    assert!(key.verify_der(&messages::sha256(&n), &unb64(s(a, &["signatureDer"]))).is_ok());
}

/// An Android device signature of the file, in both encodings.
fn check_android_sig(ver: &Verifier, pk: &[u8], d: &Value, preimage: &str) {
    assert!(ver.verify_known_key(Platform::Android, pk, &unb64(s(d, &["signatureDer"])), preimage, 0).is_ok());
    assert!(ver.verify_known_key(Platform::Android, pk, &unb64(s(d, &["signatureDer"])), &format!("{preimage}x"), 0).is_err());
    if let Some(raw) = d["signatureRaw"].as_str() {
        let key = qnet_device_attest::DevicePublicKey::from_sec1(pk).unwrap();
        assert!(key.verify_fixed(preimage.as_bytes(), &unhex(raw)).is_ok());
    }
}

/// The file's ping replies pass the shard owner's device check (spec 5.8 steps 4 and 5) against a record
/// holding the file's device keys, and give the counter it takes; with no record they name no device.
#[test]
fn the_contract_ping_replies_pass_the_node_device_check() {
    use super::ping::{self, Anchor, ReplyRefusal};
    let v = vectors();
    let ver = verifier(&v);
    let dir = tempfile::TempDir::new().unwrap();
    let st = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
    let p = &v["device"]["ping"];
    let node = s(p, &["nodeId"]);
    let anchor = Anchor::parse(s(p, &["challenge"])).expect("the file's anchor is a self-attestation");
    assert_eq!((anchor.height, anchor.hash.as_str()), (num(p, &["height"]), s(p, &["hash"])));
    let now = super::now_secs();
    let ios_wire = messages::parse_hwping_wire(s(&p["ios"], &["wire"])).unwrap();
    assert_eq!(ping::check_device_reply(&st, &ver, node, &anchor, &ios_wire, now).err(), Some(ReplyRefusal::NoRecord));
    for (platform, name) in [(Platform::Ios, "ios"), (Platform::Android, "android")] {
        let wire = messages::parse_hwping_wire(s(&p[name], &["wire"])).unwrap();
        let pk = key(&v, name);
        let mut r = crate::light_device::record::tests::rec(1, anchor.epoch(), DeviceState::Active);
        r.node_id = node.to_string();
        r.platform = platform;
        r.hw_pub = hex::encode(&pk);
        r.hw_key = hex::encode(messages::sha3_256(&pk));
        r.key_id = hex::encode(messages::sha256(&pk));
        r.device_tag = hex::encode(messages::device_tag(platform, &pk));
        let mut w = crate::storage::DeviceWrite::default();
        w.records.push(r);
        st.device_write(w).unwrap();
        let want = match platform { Platform::Ios => p[name]["counter"].as_u64().unwrap(), Platform::Android => num(&p[name], &["hwSeq"]) };
        let got = ping::check_device_reply(&st, &ver, node, &anchor, &wire, now).expect("the file's reply verifies");
        assert_eq!(got.counter, want, "{name}");
        assert!(ping::commit_device_reply(&st, &got));
        assert_eq!(ping::check_device_reply(&st, &ver, node, &anchor, &wire, now).err(), Some(ReplyRefusal::Counter), "{name}: once");
    }
}

#[test]
fn the_contract_device_vectors_match_the_node_byte_for_byte() {
    let v = vectors();
    let ver = verifier(&v);
    let mut checked = 0usize;

    // Constants.
    assert_eq!(s(&v, &["constants", "chainId"]), messages::chain_id());
    assert_eq!(v["constants"]["epochBlocks"].as_u64(), Some(EPOCH_BLOCKS));
    assert_eq!(v["constants"]["platformBytes"]["ios"].as_u64(), Some(Platform::Ios.byte() as u64));
    assert_eq!(v["constants"]["platformBytes"]["android"].as_u64(), Some(Platform::Android.byte() as u64));

    // Keys, key ids, the App ID hash.
    for name in ["ios", "iosRotated", "android", "androidRotated"] {
        let pk = key(&v, name);
        assert_eq!(pk.len(), 65);
        assert_eq!(s(&v, &["device", "keys", name, "publicKeySha3"]), hex::encode(messages::sha3_256(&pk)), "{name}");
        assert_eq!(s(&v, &["device", "keys", name, "keyId"]), messages::b64url(&messages::sha256(&pk)), "{name}");
        checked += 1;
    }
    assert_eq!(s(&v, &["device", "rpIdHash"]), hex::encode(messages::sha256(ver.policies.ios.app_id.as_bytes())));

    // The Android device report and its signature.
    let report = s(&v, &["device", "report", "text"]);
    assert_eq!(s(&v, &["device", "report", "sha3"]), hex::encode(messages::sha3_256(report.as_bytes())));
    let android_pk = qnet_device_attest::DevicePublicKey::from_sec1(&key(&v, "android")).unwrap();
    qnet_device_attest::report::verify_device_report(report, &unb64(s(&v, &["device", "report", "signatureDer"])), &android_pk)
        .expect("report");
    assert!(android_pk.verify_fixed(report.as_bytes(), &unhex(s(&v, &["device", "report", "signatureRaw"]))).is_ok());
    checked += 1;

    // Every device message.
    let w0 = &v["wallets"][0];
    let w1 = &v["wallets"][1];
    let (n0, n1) = (s(w0, &["nodeId"]), s(w1, &["nodeId"]));
    let wallet0 = s(w0, &["address"]);
    let pp_sha3 = s(&v, &["pingKey", "publicKeySha3"]);
    for m in v["device"]["messages"].as_array().unwrap() {
        let pre = s(m, &["preimage"]);
        let nonce = s(m, &["nonce"]);
        assert!(messages::nonce32(nonce).is_some());
        let p = platform(m);
        let (cur, rotated) = match p { Platform::Ios => ("ios", "iosRotated"), Platform::Android => ("android", "androidRotated") };
        let seq_of = |i: usize| pre.split('|').nth(i).unwrap().parse::<u64>().unwrap();
        match s(m, &["name"]) {
            "enrol" => {
                let flags = s(m, &["flags"]);
                assert_eq!(messages::enrol_preimage(n0, wallet0, pp_sha3, seq_of(5), nonce, flags), pre);
                match p {
                    Platform::Ios => {
                        assert_eq!(s(m, &["clientDataHash"]), hex::encode(messages::sha256(pre.as_bytes())));
                        qnet_device_attest::apple::parse_flags(flags).expect("phone or pad");
                        check_ios_assertion(&v, &ver, &key(&v, cur), &m["reenrolAssertion"], pre);
                    }
                    Platform::Android => {
                        assert_eq!(flags, messages::android_flags(report));
                        assert_eq!(s(m, &["attestationChallenge"]), hex::encode(messages::sha256(pre.as_bytes())));
                        assert_eq!(s(m, &["playNonce"]),
                                   messages::b64url(&messages::play_nonce_enrol_digest(pre, &key(&v, cur), report)));
                    }
                }
            }
            "rotate" => {
                let old_key = hex::encode(messages::sha3_256(&key(&v, cur)));
                assert_eq!(messages::rotate_preimage(n0, &old_key, pp_sha3, seq_of(5), nonce), pre);
                assert_eq!(s(m, &["newKey"]), rotated);
                match p {
                    Platform::Ios => {
                        assert_eq!(s(m, &["newKeyClientDataHash"]), hex::encode(messages::sha256(pre.as_bytes())));
                        check_ios_assertion(&v, &ver, &key(&v, cur), &m["oldKey"], pre);
                    }
                    Platform::Android => {
                        assert_eq!(s(m, &["newKeyAttestationChallenge"]), hex::encode(messages::sha256(pre.as_bytes())));
                        let new_pk = qnet_device_attest::DevicePublicKey::from_sec1(&key(&v, rotated)).unwrap();
                        qnet_device_attest::report::verify_device_report(report, &unb64(s(m, &["newKeyReportSignatureDer"])), &new_pk)
                            .expect("rotated key's report");
                        assert_eq!(s(m, &["playNonce"]), messages::b64url(&messages::play_nonce_digest(pre)));
                        check_android_sig(&ver, &key(&v, cur), &m["oldKey"], pre);
                    }
                }
            }
            "rebind" => {
                assert_eq!(messages::rebind_preimage(n0, n1, seq_of(4), nonce), pre);
                match p {
                    Platform::Ios => check_ios_assertion(&v, &ver, &key(&v, cur), &m["device"], pre),
                    Platform::Android => check_android_sig(&ver, &key(&v, cur), &m["device"], pre),
                }
                // The new wallet's key signs the same bytes (section 5.5).
                let k1 = s(w1, &["publicKey"]);
                assert_eq!(s(m, &["walletPublicKeySha3"]), lb::sha3_hex(&unhex(k1)));
                assert!(crate::rpc::verify_mobile_dilithium_signature(pre, s(m, &["walletSignature"]), k1), "wallet signature");
                assert!(!crate::rpc::verify_mobile_dilithium_signature(pre, s(m, &["walletSignature"]), s(w0, &["publicKey"])));
            }
            "refresh" => {
                assert_eq!(messages::refresh_preimage(n0, nonce), pre);
                match p {
                    Platform::Ios => check_ios_assertion(&v, &ver, &key(&v, cur), &m["device"], pre),
                    Platform::Android => {
                        assert_eq!(s(m, &["playNonce"]), messages::b64url(&messages::play_nonce_digest(pre)));
                        check_android_sig(&ver, &key(&v, cur), &m["device"], pre);
                    }
                }
            }
            "release" => {
                assert_eq!(messages::release_preimage(n0, seq_of(3), nonce), pre);
                match p {
                    Platform::Ios => check_ios_assertion(&v, &ver, &key(&v, cur), &m["device"], pre),
                    Platform::Android => check_android_sig(&ver, &key(&v, cur), &m["device"], pre),
                }
            }
            other => panic!("unknown device message {other}"),
        }
        checked += 1;
    }

    // The ping reply of both platforms.
    let ping = &v["device"]["ping"];
    let (h, hash) = (num(ping, &["height"]), s(ping, &["hash"]));
    assert_eq!((num(ping, &["epoch"]), s(ping, &["nodeId"])), (h / EPOCH_BLOCKS, n0));
    assert_eq!((num(&v, &["anchor", "height"]), s(&v, &["anchor", "hash"])), (h, hash));
    assert_eq!(s(ping, &["challenge"]), format!("selfattest:{}:{}", h, hash));
    let sigma = unhex(s(ping, &["sigma"]));
    assert_eq!(s(ping, &["sigmaSha3"]), hex::encode(messages::sha3_256(&sigma)));
    assert!(crate::rpc::verify_mobile_dilithium_signature(s(ping, &["challenge"]), s(ping, &["sigma"]), s(&v, &["pingKey", "publicKey"])),
            "σ is the ping key's signature over the anchor");
    for (p, name) in [(Platform::Ios, "ios"), (Platform::Android, "android")] {
        let r = &ping[name];
        let hw_seq = num(r, &["hwSeq"]);
        let pre = messages::hwping_preimage(n0, h, hash, &sigma, hw_seq);
        assert_eq!(s(r, &["preimage"]), pre, "{name}");
        let wire = messages::parse_hwping_wire(s(r, &["wire"])).expect("wire");
        assert_eq!((wire.sigma.as_slice(), wire.hw_seq), (sigma.as_slice(), hw_seq));
        match p {
            Platform::Ios => {
                check_ios_assertion(&v, &ver, &key(&v, "ios"), r, &pre);
                assert_eq!(wire.device_sig, unb64(s(r, &["assertion"])));
            }
            Platform::Android => {
                check_android_sig(&ver, &key(&v, "android"), r, &pre);
                assert_eq!(wire.device_sig, unb64(s(r, &["signatureDer"])));
            }
        }
        checked += 1;
    }

    // Tags, the public status's tag and the support reference.
    for (p, name) in [(Platform::Ios, "ios"), (Platform::Android, "android")] {
        assert_eq!(s(&v, &["device", "deviceTags", name]), hex::encode(messages::device_tag(p, &key(&v, name))));
        let nonce: [u8; 16] = unhex(s(&v, &["device", "status", "nonce"])).try_into().unwrap();
        let tag: [u8; 32] = unhex(s(&v, &["device", "deviceTags", name])).try_into().unwrap();
        assert_eq!(lb::device_tag_h(&nonce, &tag), s(&v, &["device", "status", "deviceTagH", name]));
        checked += 1;
    }
    let ref_nonce = messages::nonce32(s(&v, &["device", "status", "refNonce"])).unwrap();
    let android_tag: [u8; 32] = unhex(s(&v, &["device", "deviceTags", "android"])).try_into().unwrap();
    assert_eq!(messages::reference(&ref_nonce, &android_tag), s(&v, &["device", "status", "ref", "android"]));

    // The lease statements under the oracle's key, and the device statements over them.
    let oracle_pk = unhex(s(&v, &["device", "oracle", "publicKey"]));
    assert_eq!(s(&v, &["device", "oracle", "publicKeySha3"]), hex::encode(messages::sha3_256(&oracle_pk)));
    let pins = OraclePins { keys: vec![(oracle_pk.clone(), u64::MAX)] };
    for st in v["device"]["statements"].as_array().unwrap() {
        let lease_text = s(st, &["lease"]);
        let lease = LeaseStatement::parse(lease_text).expect("lease parses");
        assert_eq!(lease.preimage(), lease_text);
        let sig = unhex(s(st, &["oracleSignature"]));
        assert!(pins.verify(lease_text, &sig, 0), "the oracle's signature verifies under the pinned key");
        assert!(!pins.verify(&format!("{lease_text}0"), &sig, 0));
        assert!(!OraclePins { keys: vec![(oracle_pk.clone(), 10)] }.verify(lease_text, &sig, 10 + super::ORACLE_PREVIOUS_KEY_EPOCHS + 1),
                "a retired key stops signing 42 epochs after its retirement");
        if let Some(payload) = st["piPayload"].as_str() {
            assert_eq!(lease.pi_digest, hex::encode(messages::sha256(payload.as_bytes())));
        }
        let f = &st["statementFields"];
        let fields = StatementFields {
            node: s(f, &["nodeId"]).into(),
            device_tag: unhex(s(f, &["deviceTag"])).try_into().unwrap(),
            hw_key: s(f, &["hwPublicKeySha3"]).into(),
            platform: Platform::parse(s(f, &["platform"])).unwrap(),
            prov: Prov::parse(s(f, &["prov"])).unwrap(),
            trust: Trust::parse(s(f, &["trust"])).unwrap(),
            op: Op::parse(s(f, &["op"])).unwrap(),
            issued_epoch: num(f, &["issuedEpoch"]),
            effective_epoch: num(f, &["effectiveEpoch"]),
            state: DeviceState::parse(s(f, &["state"])).unwrap(),
            lease_hash: s(f, &["leaseSha3"]).into(),
        };
        assert_eq!(fields.preimage(), s(st, &["statement"]));
        assert_eq!(StatementFields::parse(s(st, &["statement"])), Some(fields.clone()));
        assert_eq!(messages::lease_hash(lease_text, &sig), fields.lease_hash, "sha3(L ‖ oracle signature)");
        assert_eq!((lease.node.as_str(), lease.device_tag), (fields.node.as_str(), fields.device_tag));
        let name = fields.platform.as_str();
        assert_eq!(fields.hw_key, hex::encode(messages::sha3_256(&key(&v, name))));
        assert_eq!(fields.device_tag, messages::device_tag(fields.platform, &key(&v, name)));
        // The node derives the same state and effective epoch from the lease.
        assert_eq!(statement::derive_state(Some(&lease), fields.op, true), fields.state);
        assert_eq!(statement::effective_epoch(Some(&lease), fields.op, fields.issued_epoch), fields.effective_epoch);
        assert!(statement::state_admissible(fields.state, Some(&lease), fields.op));
        checked += 1;
    }

    // The state change and the revocation snapshot.
    assert_eq!(messages::state_preimage(n0, DeviceState::Paused, 7, 335, "two_strikes"), s(&v, &["device", "stateChange", "preimage"]));
    let crl = &v["device"]["crl"];
    let list = qnet_device_attest::revocation::RevocationList::from_serials(
        crl["serials"].as_array().unwrap().iter().map(|x| x.as_str().unwrap())).unwrap();
    assert_eq!(list.canonical_text(), s(crl, &["listText"]));
    assert_eq!(hex::encode(messages::sha3_256(s(crl, &["listText"]).as_bytes())), s(crl, &["listSha3"]));
    assert_eq!(messages::crl_preimage(num(crl, &["fetchedAt"]), s(crl, &["listText"])), s(crl, &["preimage"]));
    checked += 2;

    assert_eq!(checked, 4 + 1 + 10 + 2 + 2 + 2 + 2, "every device vector of the file");
}

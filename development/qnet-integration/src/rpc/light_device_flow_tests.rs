//! The device layer after enrolment (A7-A12), with the five genesis of the enrolment tests: the ping reply
//! with the device signature on ingress and relay, the lease refresh, the key rotation and its limits, the
//! release with "Stop on this device", the key a released binding still held (owner decision (b)), a
//! rebind's effect on replies, and whom the pinger and a wake reach. The oracle is scripted; everything
//! else is the production code.

use super::*;
use crate::light_device::ping::{self, AnchorCache, ReplyCtx, ReplyRefusal, Route};

#[path = "light_device_upkeep_tests.rs"]
mod upkeep;

#[derive(Clone, Copy)]
enum Rot { Lease(LeaseKind, &'static str), Refuse(&'static str), Down }

/// An oracle that answers every route and keeps what it was asked.
struct ScriptOracle {
    sk: d3::SecretKey,
    claim: LeaseKind,
    /// The multiplicity gate the claim's lease names.
    gate: parking_lot::Mutex<Gate>,
    refresh: parking_lot::Mutex<Value>,
    recheck: parking_lot::Mutex<Value>,
    rotate: Rot,
    calls: parking_lot::Mutex<Vec<(String, Value)>>,
}

impl ScriptOracle {
    fn paths(&self) -> Vec<String> {
        self.calls.lock().iter().map(|(p, _)| p.clone()).collect()
    }

    fn lease(&self, node: &str, platform: Platform, hw_pub: &[u8], kind: LeaseKind) -> (String, String) {
        let effective = if matches!(kind, LeaseKind::ClaimedVirgin | LeaseKind::SelfReclaim) { Effective::Now } else { Effective::Next };
        let l = LeaseStatement { node: node.into(), device_tag: messages::device_tag(platform, hw_pub), lease: kind, effective,
                                 gate: *self.gate.lock(), pi_digest: String::new(), issued_at: ld::now_secs() };
        let text = l.preimage();
        let sig = raw_sign(&self.sk, &text);
        (text, sig)
    }
}

#[async_trait::async_trait]
impl OracleApi for ScriptOracle {
    async fn post(&self, path: &'static str, body: Value, _t: std::time::Duration) -> Result<Value, oracle::OracleError> {
        self.calls.lock().push((path.to_string(), body.clone()));
        let now = ld::now_secs();
        let node = body["node_id"].as_str().unwrap_or("").to_string();
        match path {
            "/v1/claim" => {
                let platform = Platform::parse(body["platform"].as_str().unwrap()).unwrap();
                let (text, sig) = self.lease(&node, platform, &hex::decode(body["hw_pub"].as_str().unwrap()).unwrap(), self.claim);
                Ok(json!({ "lease_statement": text, "oracle_sig": sig, "lease_valid_until": now + 7 * 86_400,
                           "refresh_at": now + 6 * 86_400, "state": "active" }))
            }
            "/v1/refresh" => {
                let v = self.refresh.lock().clone();
                if v.is_null() { Err(oracle::OracleError::Unavailable("unreachable")) } else { Ok(v) }
            }
            "/v1/rotate" => match self.rotate {
                Rot::Down => Err(oracle::OracleError::Unavailable("unreachable")),
                Rot::Refuse(r) => Err(oracle::OracleError::Refused { reason: DeviceReason::parse(r).unwrap(), reference: None,
                                                                     until: Some(now + 30 * 86_400), retry_at: None }),
                Rot::Lease(kind, state) => {
                    let platform = if body.get("dc_token").is_some() { Platform::Ios } else { Platform::Android };
                    let (text, sig) = self.lease(&node, platform, &hex::decode(body["hw_pub"].as_str().unwrap()).unwrap(), kind);
                    Ok(json!({ "lease_statement": text, "oracle_sig": sig, "lease_valid_until": now + 7 * 86_400,
                               "refresh_at": now + 6 * 86_400, "state": state, "paused_until": now + 30 * 86_400, "result": "pass" }))
                }
            },
            "/v1/release" => Ok(json!({ "state": "ended", "reason": "released" })),
            "/v1/refusal" => Ok(json!({ "ref": "00000000" })),
            "/v1/recheck" => {
                let v = self.recheck.lock().clone();
                if v.is_null() { Err(oracle::OracleError::Unavailable("unreachable")) } else { Ok(v) }
            }
            other => panic!("unexpected oracle route {other}"),
        }
    }

    async fn get(&self, _path: &'static str, _t: std::time::Duration) -> Result<Value, oracle::OracleError> {
        Err(oracle::OracleError::Unavailable("unreachable"))
    }
}

fn script(net: &Net, claim: LeaseKind, rotate: Rot) -> &'static ScriptOracle {
    Box::leak(Box::new(ScriptOracle { sk: net.oracle_sk.clone(), claim, gate: parking_lot::Mutex::new(Gate::Ok),
                                      refresh: parking_lot::Mutex::new(Value::Null), recheck: parking_lot::Mutex::new(Value::Null),
                                      rotate, calls: parking_lot::Mutex::new(Vec::new()) }))
}

/// A node bound to a device at every genesis: its wallet, binding, ping key and device key.
struct Bound {
    w: Wallet,
    seq: u64,
    pp: String,
    ping_sk: d3::SecretKey,
    hw: [u8; 65],
    kp: ring::signature::EcdsaKeyPair,
    platform: Platform,
}

impl Bound {
    fn hw_key(&self) -> String {
        hex::encode(messages::sha3_256(&self.hw))
    }
}

fn ping_pair() -> (String, d3::SecretKey) {
    let (pk, sk) = d3::keypair();
    (hex::encode(pk.as_bytes()), sk)
}

/// The v2 binding of `w` at `seq` for the ping key `pp` at every genesis, with the wallet's real delegation.
fn bind_everywhere(net: &Net, w: &Wallet, pp: &str, seq: u64) {
    let cert = sign_hex(&w.sk, &lb::delegation_v2_message(pp, &w.node, seq));
    for s in &net.stores {
        s.bind_light_v2(&w.node, pp, &cert, &w.pk_hex, seq, now()).unwrap().unwrap();
    }
}

/// Enrol a new wallet's node on `platform` through genesis 0 under the claim `oracle` answers, record the
/// statement at every genesis and bind it there.
fn enrol(net: &Net, platform: Platform, oracle: &'static ScriptOracle, addr: &str) -> Bound {
    let w = wallet();
    net.register(&w);
    let (pp, ping_sk) = ping_pair();
    let seq = now();
    let (hw, kp) = device_key();
    let block = match platform {
        Platform::Ios => ios_block(net, 0, &w, &pp, seq, &hw, &[]),
        Platform::Android => android_block(net, 0, &w, &pp, seq, &hw, &[3u8; 65], b"rkp"),
    };
    let token = if platform == Platform::Ios { ("dc_token", "t") } else { ("pi_token", "t") };
    let p = net.prepare(0, &bind(&w, &pp, seq, block, Some(token)), addr).unwrap().unwrap();
    match run(net.ctx(0, Some(oracle), &[1, 2, 3, 4]), p) {
        StepAnswer::Final(_) => {}
        other => panic!("{other:?}"),
    }
    net.sync_from(0, &w.node);
    bind_everywhere(net, &w, &pp, seq);
    Bound { w, seq, pp, ping_sk, hw, kp, platform }
}

const H: u64 = 155 * 14_400 + 50;

/// A canonical block at `h` at every genesis; its self-attestation challenge.
fn anchor_at(net: &Net, h: u64) -> String {
    let hash = messages::sha256(&h.to_be_bytes());
    for s in &net.stores { s.save_microblock_hash(h, &hash).unwrap(); }
    format!("selfattest:{}:{}", h, hex::encode(hash))
}

fn app_id(net: &Net) -> String {
    net.verifier.policies.ios.app_id.clone()
}

/// The device's signature of `preimage`: an iOS assertion at `counter`, or an Android DER signature.
fn device_sign(net: &Net, b: &Bound, kp: &ring::signature::EcdsaKeyPair, preimage: &str, counter: u32) -> Vec<u8> {
    match b.platform {
        Platform::Ios => ios_assertion(kp, &app_id(net), preimage, counter),
        Platform::Android => kp.sign(&ring::rand::SystemRandom::new(), preimage.as_bytes()).unwrap().as_ref().to_vec(),
    }
}

/// A `ping_hw2` reply of `b` to `challenge`, signed by the device key `kp`, at iOS `counter` / Android `hw_seq`.
fn hw_reply(net: &Net, b: &Bound, kp: &ring::signature::EcdsaKeyPair, challenge: &str, counter: u64) -> String {
    let sigma = d3::detached_sign(challenge.as_bytes(), &b.ping_sk).as_bytes().to_vec();
    let a = ping::Anchor::parse(challenge).unwrap();
    let hw_seq = if b.platform == Platform::Ios { 0 } else { counter };
    let pre = messages::hwping_preimage(&b.w.node, a.height, &a.hash, &sigma, hw_seq);
    let dev = device_sign(net, b, kp, &pre, counter as u32);
    format!("ping_hw2:{}.{}.{}", hex::encode(&sigma), messages::b64url(&dev), hw_seq)
}

fn legacy_reply(b: &Bound, challenge: &str) -> String {
    format!("ping_dilithium:{}", hex::encode(d3::detached_sign(challenge.as_bytes(), &b.ping_sk).as_bytes()))
}

fn verify(net: &Net, i: usize, node: &str, challenge: &str, sig: &str, route: Route, tip: u64) -> Result<(), ReplyRefusal> {
    let cache = AnchorCache::new();
    let ctx = ReplyCtx { storage: &net.stores[i], verifier: net.verifier, anchors: &cache, tip, now: now() };
    ping::verify_reply(&ctx, node, challenge, sig, route)
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

/// A state change of the record of `node` signed by genesis `j`, applied at every genesis.
fn change_everywhere(net: &Net, j: usize, node: &str, state: DeviceState, until: u64, reason: &str) {
    let r = net.stores[0].device_record(node).unwrap();
    let mut c = StateChange::of(&r, state, until, reason, &net.id(j));
    c.sig = raw_sign(&net.secrets[j].1, &c.preimage());
    for s in &net.stores {
        let got = apply_sync(s, net.genesis, net.mainnet, &DeviceSync { bundle: None, change: Some(c.clone()) }, None, now(), net.epoch);
        assert_eq!(got, Ok("changed"));
    }
}

#[test]
fn a_device_reply_is_checked_in_the_spec_order_on_ingress_and_relay() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Ios, o, "203.0.113.40");
    let (c, tip) = (anchor_at(&net, H), H + 100);
    // Another shard owner than the ingress takes it: every genesis holds the record.
    assert_eq!(verify(&net, 1, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 1), Route::Ingress, tip), Ok(()));
    // The counter was taken: the same reply again is refused (a replay past the epoch's dedupe).
    assert_eq!(verify(&net, 1, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 1), Route::Ingress, tip), Err(ReplyRefusal::Counter));
    // σ over another challenge (the device signed it): refused after the device checks, and the counter is
    // not spent on it.
    let other = anchor_at(&net, H + 1);
    let wrong_sigma = d3::detached_sign(other.as_bytes(), &b.ping_sk).as_bytes().to_vec();
    let a = ping::Anchor::parse(&c).unwrap();
    let pre = messages::hwping_preimage(&b.w.node, a.height, &a.hash, &wrong_sigma, 0);
    let forged = format!("ping_hw2:{}.{}.0", hex::encode(&wrong_sigma), messages::b64url(&device_sign(&net, &b, &b.kp, &pre, 2)));
    assert_eq!(verify(&net, 1, &b.w.node, &c, &forged, Route::Ingress, tip), Err(ReplyRefusal::Sigma));
    assert_eq!(verify(&net, 1, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 2), Route::Ingress, tip), Ok(()));
    // Relay admission: block_height must repeat the anchor's height; the tip's is not it.
    assert_eq!(verify(&net, 2, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 3), Route::Relay { block_height: tip }, tip),
               Err(ReplyRefusal::Anchor));
    assert_eq!(verify(&net, 2, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 3), Route::Relay { block_height: H }, tip), Ok(()));
    // A stockpiled reply: an anchor of the epoch before, or a hash that is not canonical.
    let stale = anchor_at(&net, H - 14_400);
    assert_eq!(verify(&net, 2, &b.w.node, &stale, &hw_reply(&net, &b, &b.kp, &stale, 4), Route::Relay { block_height: H - 14_400 }, tip),
               Err(ReplyRefusal::Anchor));
    let fake = format!("selfattest:{}:{}", H, "ee".repeat(32));
    assert_eq!(verify(&net, 2, &b.w.node, &fake, &hw_reply(&net, &b, &b.kp, &fake, 4), Route::Relay { block_height: H }, tip),
               Err(ReplyRefusal::Anchor));
    // A server stamp is never credited on relay; a device reply never answers one.
    let stamp = "ab".repeat(40);
    assert_eq!(verify(&net, 2, &b.w.node, &stamp, &legacy_reply(&b, &stamp), Route::Relay { block_height: H }, tip),
               Err(ReplyRefusal::StampOnRelay));
    assert_eq!(verify(&net, 0, &b.w.node, &stamp, &hw_reply(&net, &b, &b.kp, &c, 5), Route::Ingress, tip),
               Err(ReplyRefusal::Malformed));
    assert_eq!(verify(&net, 0, &b.w.node, &stamp, &legacy_reply(&b, &stamp), Route::Ingress, tip), Ok(()),
               "a stamp its issuer checked counts on ingress until the enforcement epoch");
    // compact_bin is refused for a light node; a device key the record does not hold signs nothing.
    assert_eq!(verify(&net, 0, &b.w.node, &c, "compact_bin:AAAA", Route::Ingress, tip), Err(ReplyRefusal::CompactBin));
    let (_, stranger) = device_key();
    assert_eq!(verify(&net, 0, &b.w.node, &c, &hw_reply(&net, &b, &stranger, &c, 9), Route::Ingress, tip),
               Err(ReplyRefusal::DeviceSignature));
    // A reply without the device signature still counts in this roll, also relayed with a later height of
    // its epoch, as a genesis of the previous binary relays it (its tip), never another epoch's.
    assert_eq!(verify(&net, 3, &b.w.node, &c, &legacy_reply(&b, &c), Route::Relay { block_height: H }, tip), Ok(()));
    assert_eq!(verify(&net, 4, &b.w.node, &c, &legacy_reply(&b, &c), Route::Relay { block_height: tip }, tip), Ok(()));
    assert_eq!(verify(&net, 4, &b.w.node, &c, &legacy_reply(&b, &c), Route::Relay { block_height: H - 1 }, tip), Err(ReplyRefusal::Anchor));
    assert_eq!(verify(&net, 4, &b.w.node, &c, &legacy_reply(&b, &c), Route::Relay { block_height: 156 * 14_400 }, tip),
               Err(ReplyRefusal::Anchor));
    // A node with no device record here: its legacy replies count, a device reply names no device.
    let v = wallet();
    net.register(&v);
    let (vpp, vsk) = ping_pair();
    bind_everywhere(&net, &v, &vpp, now());
    let legacy = Bound { w: v, seq: 0, pp: vpp, ping_sk: vsk, hw: b.hw, kp: device_key().1, platform: Platform::Ios };
    assert_eq!(verify(&net, 0, &legacy.w.node, &c, &legacy_reply(&legacy, &c), Route::Ingress, tip), Ok(()));
    assert_eq!(verify(&net, 0, &legacy.w.node, &c, &hw_reply(&net, &legacy, &legacy.kp, &c, 1), Route::Ingress, tip),
               Err(ReplyRefusal::NoRecord));
}

#[test]
fn a_device_reply_counts_only_while_its_record_does() {
    let net = Net::new(false);
    // A slot another node's generation held: the record counts from the next epoch.
    let o = script(&net, LeaseKind::ClaimedForeign, Rot::Down);
    let b = enrol(&net, Platform::Android, o, "203.0.113.41");
    let c = anchor_at(&net, H);
    let hw_seq = now() * 1000;
    assert_eq!(verify(&net, 0, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, hw_seq), Route::Ingress, H + 10),
               Err(ReplyRefusal::NotCounted));
    let next = anchor_at(&net, H + 14_400);
    assert_eq!(verify(&net, 0, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq), Route::Ingress, H + 14_410), Ok(()));
    // Android's hw_seq rises strictly and never runs far ahead of the clock.
    assert_eq!(verify(&net, 0, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq), Route::Ingress, H + 14_410),
               Err(ReplyRefusal::Counter));
    assert_eq!(verify(&net, 0, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq + 5 * 86_400_000), Route::Ingress, H + 14_410),
               Err(ReplyRefusal::Counter));
    assert_eq!(verify(&net, 1, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq + 1), Route::Ingress, H + 14_410), Ok(()));
    // Paused: nothing counts until the pause's epoch.
    change_everywhere(&net, 2, &b.w.node, DeviceState::Paused, 157, "two_strikes");
    assert_eq!(verify(&net, 1, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq + 2), Route::Ingress, H + 14_410),
               Err(ReplyRefusal::NotCounted));
    // Stop withdrew the binding: the record decides nothing, and the device's replies name no device.
    for s in &net.stores {
        s.withdraw_light_binding(&b.w.node, b.seq, &b.w.pk_hex, None, |_| Ok(true)).unwrap().unwrap();
    }
    assert_eq!(verify(&net, 1, &b.w.node, &next, &hw_reply(&net, &b, &b.kp, &next, hw_seq + 3), Route::Ingress, H + 14_410),
               Err(ReplyRefusal::NoRecord));
}

#[test]
fn a_refresh_renews_the_lease_everywhere_and_a_pause_it_reports_is_never_lifted() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Ios, o, "203.0.113.42");
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    let request = |i: usize, counter: u32, token: Option<&str>| {
        let ch = ld::stamp::issue(&net.id(i), &b.w.node, Purpose::Refresh, now());
        let sig = device_sign(&net, &b, &b.kp, &messages::refresh_preimage(&b.w.node, &ch.nonce), counter);
        RefreshRequest { node_id: b.w.node.clone(), nonce: ch.nonce, stamp: ch.stamp, sig: messages::b64url(&sig),
                         token: token.map(|t| t.to_string()) }
    };
    let t = now();
    *o.refresh.lock() = json!({ "result": "pass", "state": "active", "reason": "refresh_ok", "lease_valid_until": t + 9 * 86_400,
                                "refresh_at": t + 8 * 86_400, "paused_until": 0, "ref": "0a0b0c0d" });
    let req = request(0, 1, Some("dc"));
    let a = block_on(run_refresh(&ctx, &req, now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(true), Some("active")), "{a}");
    let (path, body) = o.calls.lock().last().cloned().unwrap();
    assert_eq!((path.as_str(), body["dc_token"].as_str(), body.get("pi_token")), ("/v1/refresh", Some("dc"), None));
    assert_eq!(body["preimage"].as_str(), Some(messages::refresh_preimage(&b.w.node, &req.nonce).as_str()));
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.lease_valid_until, r.refresh_at, r.state_seq, r.reason.as_str()), (t + 9 * 86_400, t + 8 * 86_400, 1, "refresh_ok"));
    // The change carries the window to the other genesis.
    let change = r.last_change.clone().unwrap();
    for (j, s) in net.stores.iter().enumerate().skip(1) {
        assert_eq!(apply_sync(s, net.genesis, false, &DeviceSync { bundle: None, change: Some(change.clone()) }, Some(&net.id(j)), now(), net.epoch),
                   Ok("changed"));
        assert_eq!(s.device_record(&b.w.node).unwrap().lease_valid_until, t + 9 * 86_400);
    }
    // A replay gets its first answer, without another oracle call.
    let calls = o.paths().len();
    assert_eq!(block_on(run_refresh(&ctx, &req, now())), a);
    assert_eq!(o.paths().len(), calls);
    // Another issuer's stamp, a signature by another key, no token.
    assert_eq!(block_on(run_refresh(&ctx, &request(1, 2, Some("dc")), now()))["reason"], json!("device_stale"));
    let mut bad = request(0, 2, Some("dc"));
    bad.sig = messages::b64url(&ios_assertion(&device_key().1, &app_id(&net), &messages::refresh_preimage(&b.w.node, &bad.nonce), 2));
    assert_eq!(block_on(run_refresh(&ctx, &bad, now()))["reason"], json!("bad_signature"));
    let no_token = block_on(run_refresh(&ctx, &request(0, 3, None), now()));
    assert_eq!((no_token["reason"].as_str(), no_token["retry_after_seconds"].is_u64()), (Some("device_stale"), true));
    // Two strikes: the node pauses here; a later "active" does not lift the pause while it runs.
    *o.refresh.lock() = json!({ "result": "two_strikes", "state": "paused", "reason": "two_strikes", "lease_valid_until": t + 86_400,
                                "refresh_at": t, "paused_until": t + 30 * 86_400, "ref": "0a0b0c0d" });
    let p = block_on(run_refresh(&ctx, &request(0, 4, Some("dc")), now()));
    assert_eq!((p["success"].as_bool(), p["reason"].as_str(), p["device_state"].as_str()),
               (Some(false), Some("device_slot_paused"), Some("paused")), "{p}");
    let until = p["paused_until"].as_u64().unwrap();
    assert!(until >= net.epoch + 30 * 6, "thirty days of epochs: {until}");
    *o.refresh.lock() = json!({ "result": "pass", "state": "active", "reason": "refresh_ok", "lease_valid_until": t + 9 * 86_400,
                                "refresh_at": t, "paused_until": 0 });
    let still = block_on(run_refresh(&ctx, &request(0, 5, Some("dc")), now()));
    assert_eq!(still["reason"], json!("device_slot_paused"), "{still}");
    assert_eq!(net.stores[0].device_record(&b.w.node).unwrap().until_epoch, until);
}

/// A rotation request of `b` at genesis 0: the new key `new_hw` attested over the preimage (the stand-in
/// vendor check), the old key `old_kp` signing the same preimage at `counter`.
fn rotation(net: &Net, b: &Bound, old_key: &str, new_hw: &[u8; 65], old_kp: &ring::signature::EcdsaKeyPair, counter: u32) -> RotateRequest {
    rotation_at(net, 0, b, old_key, new_hw, old_kp, counter)
}

/// `rotation` under a challenge genesis `i` issued.
fn rotation_at(net: &Net, i: usize, b: &Bound, old_key: &str, new_hw: &[u8; 65], old_kp: &ring::signature::EcdsaKeyPair,
               counter: u32) -> RotateRequest {
    let ch = ld::stamp::issue(&net.id(i), &b.w.node, Purpose::Rotate, now());
    let pre = messages::rotate_preimage(&b.w.node, old_key, &lb::sha3_hex(&hex::decode(&b.pp).unwrap()), b.seq, &ch.nonce);
    let mut att = new_hw.to_vec();
    att.extend_from_slice(&messages::sha256(pre.as_bytes()));
    let device = match b.platform {
        Platform::Ios => json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(new_hw)),
                                 "attestation": messages::b64url(&att), "nonce": ch.nonce, "stamp": ch.stamp }),
        Platform::Android => json!({ "platform": "android", "chain": [messages::b64url(&att), messages::b64url(&[3u8; 65]), messages::b64url(b"rkp")],
                                     "report": REPORT, "report_sig": messages::b64url(&[1u8; 70]), "nonce": ch.nonce, "stamp": ch.stamp }),
    };
    let token = |p: Platform| if p == Platform::Ios { (Some("dc".to_string()), None) } else { (None, Some("pi".to_string())) };
    let (dc_token, pi_token) = token(b.platform);
    RotateRequest { node_id: b.w.node.clone(), seq: b.seq, old_key: old_key.to_string(), device: Some(device),
                    old_sig: messages::b64url(&device_sign(net, b, old_kp, &pre, counter)), dc_token, pi_token }
}

#[test]
fn a_rotation_moves_the_node_to_its_new_key_and_the_old_one_stops() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let b = enrol(&net, Platform::Ios, o, "203.0.113.43");
    let due = net.epoch + ld::ROTATION_PERIOD_EPOCHS;
    assert_eq!(net.stores[0].device_record(&b.w.node).unwrap().rotation_due_epoch, due);
    let (new_hw, new_kp) = device_key();
    // Before it falls due: refused with the wait, nothing asked of the oracle.
    net.epoch = due - 1;
    let early = block_on(run_rotation(&net.ctx(0, Some(o), &[1, 2, 3, 4]), &rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 1), now()));
    assert_eq!((early["reason"].as_str(), early["retry_after_seconds"].as_u64()), (Some("device_rate_limited"), Some(ld::EPOCH_BLOCKS)));
    assert!(!o.paths().contains(&"/v1/rotate".to_string()));
    net.epoch = due;
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    // Not the key the record holds; the old key's signature by another key.
    let wrong = block_on(run_rotation(&ctx, &rotation(&net, &b, &"ab".repeat(32), &new_hw, &b.kp, 1), now()));
    assert_eq!(wrong["reason"], json!("stale_seq"));
    let forged = block_on(run_rotation(&ctx, &rotation(&net, &b, &b.hw_key(), &new_hw, &device_key().1, 1), now()));
    assert_eq!(forged["reason"], json!("bad_signature"));
    // The rotation: a statement of four over the new key, the binding's sequence kept.
    let req = rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 1);
    let a = block_on(run_rotation(&ctx, &req, now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str(), a["rotation_due"].as_u64()),
               (Some(true), Some("active"), Some(due + ld::ROTATION_PERIOD_EPOCHS)), "{a}");
    let (path, body) = o.calls.lock().iter().rev().find(|(p, _)| p == "/v1/rotate").cloned().unwrap();
    assert_eq!((path.as_str(), body["hw_pub"].as_str(), body["dc_token"].as_str()), ("/v1/rotate", Some(hex::encode(new_hw).as_str()), Some("dc")));
    net.sync_from(0, &b.w.node);
    let new_key = hex::encode(messages::sha3_256(&new_hw));
    for s in &net.stores {
        let r = s.device_record(&b.w.node).unwrap();
        assert_eq!((r.op, r.hw_key.as_str(), r.seq, r.effective_epoch, r.state_at(true, due, now())),
                   (Op::Rotate, new_key.as_str(), b.seq, due, DeviceState::Active));
        assert!(s.device_key_entry(&b.hw_key()).is_none(), "the old key is free");
        assert!(s.device_known_key(&hex::encode(messages::sha256(&b.hw))).is_none(), "and retired: no assertion by it names a device");
        assert_eq!(s.device_key_entry(&new_key).map(|e| e.node_id), Some(b.w.node.clone()));
    }
    // The replay of the same request is its first answer.
    assert_eq!(block_on(run_rotation(&ctx, &req, now())), a);
    // Replies: the old key's are refused, the new key's count.
    let h = due * ld::EPOCH_BLOCKS + 10;
    let c = anchor_at(&net, h);
    assert_eq!(verify(&net, 2, &b.w.node, &c, &hw_reply(&net, &b, &b.kp, &c, 7), Route::Ingress, h + 5), Err(ReplyRefusal::DeviceSignature));
    assert_eq!(verify(&net, 2, &b.w.node, &c, &hw_reply(&net, &b, &new_kp, &c, 1), Route::Ingress, h + 5), Ok(()));
}

#[test]
fn a_rotation_waits_for_its_lease_and_the_sixty_day_limit_holds_until_it_comes() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Android, o, "203.0.113.44");
    let due = net.epoch + ld::ROTATION_PERIOD_EPOCHS;
    // Past the 60-day limit the record no longer counts, and the rotation is still taken.
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!(r.state_at(true, due + ld::ROTATION_GRACE_EPOCHS, now()), DeviceState::Active);
    assert_eq!(r.state_at(true, due + ld::ROTATION_GRACE_EPOCHS + 1, now()), DeviceState::CheckPending);
    net.epoch = due + ld::ROTATION_GRACE_EPOCHS + 1;
    let (new_hw, _) = device_key();
    // The oracle is down: no rotation without its lease; the old key keeps what it had.
    let down = block_on(run_rotation(&net.ctx(0, Some(o), &[1, 2, 3, 4]), &rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 0), now()));
    assert_eq!((down["reason"].as_str(), down["retry_after_seconds"].as_u64()), (Some("device_stale"), Some(600)), "{down}");
    assert_eq!(net.stores[0].device_record(&b.w.node).unwrap().hw_key, b.hw_key());
    // The oracle's hold flag: refused, and the node pauses here.
    let held = script(&net, LeaseKind::ClaimedVirgin, Rot::Refuse("device_slot_paused"));
    let a = block_on(run_rotation(&net.ctx(0, Some(held), &[1, 2, 3, 4]), &rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 0), now()));
    assert_eq!(a["reason"], json!("device_slot_paused"), "{a}");
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.state, r.reason.as_str()), (DeviceState::Paused, "hold"));
    // With the lease, a rotation past the limit counts again at once.
    let mut net2 = Net::new(false);
    let fine = script(&net2, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let b2 = enrol(&net2, Platform::Android, fine, "203.0.113.45");
    net2.epoch = due + ld::ROTATION_GRACE_EPOCHS + 1;
    let (hw3, _) = device_key();
    let ok = block_on(run_rotation(&net2.ctx(0, Some(fine), &[1, 2, 3, 4]), &rotation(&net2, &b2, &b2.hw_key(), &hw3, &b2.kp, 0), now()));
    assert_eq!((ok["success"].as_bool(), ok["device_state"].as_str()), (Some(true), Some("active")), "{ok}");
}

/// A statement taken without a lease (no vendor token, the oracle out, a lease that did not verify) never
/// counted and its key never met the oracle's claim: neither a refresh, which would renew whatever the
/// oracle holds for the node (perhaps a previous device's lease), nor a rotation brings it to counting. It
/// waits for an enrolment with the token (owner decision (a)).
#[test]
fn a_statement_without_a_lease_is_never_refreshed_or_rotated_into_counting() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let w = wallet();
    net.register(&w);
    let (pp, ping_sk) = ping_pair();
    let seq = now();
    let (hw, kp) = device_key();
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), None), "203.0.113.56").unwrap().unwrap();
    let rec = match run(net.ctx(0, Some(o), &[1, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((rec.state, rec.reason.as_str(), rec.lease.is_none()), (DeviceState::CheckPending, "token_missing", true));
    net.sync_from(0, &w.node);
    bind_everywhere(&net, &w, &pp, seq);
    let b = Bound { w, seq, pp, ping_sk, hw, kp, platform: Platform::Ios };
    *o.refresh.lock() = json!({ "result": "pass", "state": "active", "reason": "refresh_ok", "lease_valid_until": now() + 9 * 86_400,
                                "refresh_at": now() + 8 * 86_400, "paused_until": 0 });
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    let ch = ld::stamp::issue(&net.id(0), &b.w.node, Purpose::Refresh, now());
    let sig = device_sign(&net, &b, &b.kp, &messages::refresh_preimage(&b.w.node, &ch.nonce), 1);
    let req = RefreshRequest { node_id: b.w.node.clone(), nonce: ch.nonce, stamp: ch.stamp, sig: messages::b64url(&sig), token: Some("dc".into()) };
    let a = block_on(run_refresh(&ctx, &req, now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(false), Some("check_pending")), "{a}");
    assert!(!o.paths().contains(&"/v1/refresh".to_string()), "the oracle is not asked");
    let r = net.stores[0].device_record(&b.w.node).unwrap();
    assert_eq!((r.state, r.state_seq, r.lease_valid_until), (DeviceState::CheckPending, 0, 0));
    assert!(block_on(commit_refresh(&ctx, r, String::new(), None, Some("dc".into()), oracle::BACKGROUND_CALL_TIMEOUT)).is_err());
    // Due for rotation: refused at the ingress (and by every attestor, the same check), no oracle call.
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (new_hw, _) = device_key();
    let rot = block_on(run_rotation(&net.ctx(0, Some(o), &[1, 2, 3, 4]), &rotation(&net, &b, &b.hw_key(), &new_hw, &b.kp, 2), now()));
    assert_eq!(rot["reason"], json!("device_stale"), "{rot}");
    assert!(!o.paths().contains(&"/v1/rotate".to_string()));
    assert_eq!(net.stores[0].device_record(&b.w.node).unwrap().hw_key, b.hw_key());
}

/// A genesis that missed a statement (down past its resends) heals it from any other genesis: one that is
/// not the statement's ingress keeps no proof and names the ingress, which is asked next, and the first
/// answer's newer change is applied on top.
#[test]
fn a_pull_from_a_genesis_without_the_proof_goes_on_to_the_statements_ingress() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let (hw, _) = device_key();
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "t"))), "203.0.113.57")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3]), p), StepAnswer::Final(_)));
    let bundle = net.stores[0].device_bundle(&w.node).unwrap();
    for j in 1..4 {
        let got = apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(bundle.clone()), change: None },
                             Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("recorded"));
    }
    // A change genesis 2 caused reached genesis 1 to 3, not the ingress.
    let r = net.stores[1].device_record(&w.node).unwrap();
    let mut c = StateChange::of(&r, DeviceState::Suspect, 0, "strike", &net.id(2));
    c.sig = raw_sign(&net.secrets[2].1, &c.preimage());
    for j in 1..4 {
        assert_eq!(apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: None, change: Some(c.clone()) }, None, now(), net.epoch),
                   Ok("changed"));
    }
    let a1 = device_get_answer(&net.stores[1], &w.node);
    assert_eq!((a1["bundle"].is_null(), a1["ingress"].as_str()), (true, Some(net.id(0).as_str())), "no proof here, and who has it");
    let ids: Vec<String> = (0..5).map(|k| net.id(k)).collect();
    let asked = parking_lot::Mutex::new(Vec::new());
    let fetch = |id: String| {
        asked.lock().push(id.clone());
        let v = Net::answer_of(&net.stores, &ids, &id, &w.node);
        async move { v }
    };
    assert!(block_on(pull_device_record_via(&net.stores[4], net.genesis, false, Some(&net.id(4)), &w.node, &net.id(1), fetch)));
    assert_eq!(*asked.lock(), vec![net.id(1), net.id(0)]);
    let got = net.stores[4].device_record(&w.node).expect("recorded from the ingress's proof");
    assert_eq!((got.stmt_hash.as_str(), got.state, got.state_seq), (r.stmt_hash.as_str(), DeviceState::Suspect, 1));
    assert!(net.stores[4].device_bundle(&w.node).is_none(), "only the ingress keeps the proof");
    // Held now: another pull asks no one else.
    asked.lock().clear();
    let again = |id: String| {
        asked.lock().push(id.clone());
        let v = Net::answer_of(&net.stores, &ids, &id, &w.node);
        async move { v }
    };
    assert!(!block_on(pull_device_record_via(&net.stores[4], net.genesis, false, Some(&net.id(4)), &w.node, &net.id(1), again)));
    assert_eq!(*asked.lock(), vec![net.id(1)]);
}

/// And as an attestor: a genesis that missed the statement signs the node's rotation, whose ingress is not
/// the enrolment's, after pulling the record through that ingress to the statement's.
#[test]
fn an_attestor_that_missed_the_statement_signs_a_rotation_through_another_ingress() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let w = wallet();
    net.register(&w);
    let (pp, ping_sk) = ping_pair();
    let seq = now();
    let (hw, kp) = device_key();
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "t"))), "203.0.113.58")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3]), p), StepAnswer::Final(_)));
    let bundle = net.stores[0].device_bundle(&w.node).unwrap();
    for j in 1..4 {
        apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(bundle.clone()), change: None }, Some(&net.id(j)), now(), net.epoch)
            .unwrap();
    }
    bind_everywhere(&net, &w, &pp, seq);
    assert!(net.stores[4].device_record(&w.node).is_none());
    let b = Bound { w, seq, pp, ping_sk, hw, kp, platform: Platform::Ios };
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (new_hw, _) = device_key();
    // Genesis 1 takes the rotation and reaches only 0, 2 and 4: genesis 4's signature is needed.
    let a = block_on(run_rotation(&net.ctx_pulling(1, Some(o), &[0, 2, 4]), &rotation_at(&net, 1, &b, &b.hw_key(), &new_hw, &b.kp, 1), now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(true), Some("active")), "{a}");
    assert!(net.stores[4].device_record(&b.w.node).is_some(), "pulled");
    assert_eq!(net.stores[1].device_record(&b.w.node).unwrap().hw_key, hex::encode(messages::sha3_256(&new_hw)));
}

/// An attestor that missed a rotation holds the node's record one key behind: the next rotation retires a key
/// it never recorded. It pulls the record through that rotation's ingress to the previous rotation's and signs,
/// so two such genesis cannot keep the node from ever rotating again.
#[test]
fn an_attestor_one_rotation_behind_catches_up_and_signs_the_next_rotation() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let b = enrol(&net, Platform::Ios, o, "203.0.113.59");
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (hw2, kp2) = device_key();
    // Genesis 0 takes the first rotation; its statement reaches 1 to 3, never 4.
    let a = block_on(run_rotation(&net.ctx(0, Some(o), &[1, 2, 3]), &rotation(&net, &b, &b.hw_key(), &hw2, &b.kp, 1), now()));
    assert_eq!(a["success"].as_bool(), Some(true), "{a}");
    let first = net.stores[0].device_bundle(&b.w.node).unwrap();
    for j in 1..4 {
        let got = apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(first.clone()), change: None },
                             Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("recorded"));
    }
    let key2 = hex::encode(messages::sha3_256(&hw2));
    assert_eq!(net.stores[4].device_record(&b.w.node).unwrap().hw_key, b.hw_key(), "one rotation behind");
    // The next rotation, through genesis 1, reaches only 0, 2 and 4: genesis 4's signature is needed.
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (hw3, _) = device_key();
    let req = rotation_at(&net, 1, &b, &key2, &hw3, &kp2, 1);
    let a = block_on(run_rotation(&net.ctx_pulling(1, Some(o), &[0, 2, 4]), &req, now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(true), Some("active")), "{a}");
    let key3 = hex::encode(messages::sha3_256(&hw3));
    assert_eq!(net.stores[1].device_record(&b.w.node).unwrap().hw_key, key3);
    assert_eq!(net.stores[4].device_record(&b.w.node).unwrap().hw_key, key2, "caught up with the first rotation");
    assert!(net.stores[4].device_bundle(&b.w.node).is_none(), "only the ingress keeps the proof");
}

/// An attestor holding an earlier record of the same key - it missed the re-link after a Stop (its record
/// ended), or the enrolment with the vendor token after one without it (its record has no lease) - is not
/// holding the record the rotation rests on: it pulls the ingress's and signs, so two such genesis cannot keep
/// the node from rotating. A later change of the statement it missed names a statement it never recorded.
#[test]
fn an_attestor_holding_an_earlier_record_of_the_same_key_pulls_and_signs_the_rotation() {
    // Stop, then the same device linked again at the next sequence; genesis 4 missed the re-link.
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let b = enrol(&net, Platform::Ios, o, "203.0.113.62");
    change_everywhere(&net, 0, &b.w.node, DeviceState::Ended, 0, "released");
    let (pp2, ping_sk2) = ping_pair();
    let seq2 = b.seq + 10;
    let p = net.prepare(0, &bind(&b.w, &pp2, seq2, ios_block(&net, 0, &b.w, &pp2, seq2, &b.hw, &[]), Some(("dc_token", "t2"))), "203.0.113.62")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3]), p), StepAnswer::Final(_)));
    let relinked = net.stores[0].device_bundle(&b.w.node).unwrap();
    for j in 1..4 {
        let got = apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(relinked.clone()), change: None },
                             Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("recorded"));
    }
    bind_everywhere(&net, &b.w, &pp2, seq2);
    let r4 = net.stores[4].device_record(&b.w.node).unwrap();
    assert_eq!((r4.state, r4.seq, r4.hw_key.as_str()), (DeviceState::Ended, b.seq, b.hw_key().as_str()), "the ended record of the same key");
    let r0 = net.stores[0].device_record(&b.w.node).unwrap();
    let mut c = StateChange::of(&r0, DeviceState::Suspect, 0, "strike", &net.id(2));
    c.sig = raw_sign(&net.secrets[2].1, &c.preimage());
    assert_eq!(apply_sync(&net.stores[4], net.genesis, false, &DeviceSync { bundle: None, change: Some(c) }, Some(&net.id(4)), now(), net.epoch),
               Ok("unknown_statement"), "the sync route pulls from its sender on this");
    let b2 = Bound { w: b.w, seq: seq2, pp: pp2, ping_sk: ping_sk2, hw: b.hw, kp: b.kp, platform: Platform::Ios };
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (hw3, _) = device_key();
    // Genesis 1 takes the rotation and reaches only 0, 2 and 4: genesis 4's signature is needed.
    let a = block_on(run_rotation(&net.ctx_pulling(1, Some(o), &[0, 2, 4]), &rotation_at(&net, 1, &b2, &b2.hw_key(), &hw3, &b2.kp, 1), now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(true), Some("active")), "{a}");
    assert_eq!(net.stores[4].device_record(&b2.w.node).unwrap().seq, seq2, "caught up with the re-link");

    // A first statement without the vendor token, then the enrolment with it at the same sequence; genesis 4
    // missed the second.
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Lease(LeaseKind::SelfReclaim, "active"));
    let w = wallet();
    net.register(&w);
    let (pp, ping_sk) = ping_pair();
    let seq = now();
    let (hw, kp) = device_key();
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), None), "203.0.113.63").unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3, 4]), p), StepAnswer::Final(ref r) if r.lease.is_none()));
    net.sync_from(0, &w.node);
    let p = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "t"))), "203.0.113.63")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3]), p), StepAnswer::Final(ref r) if r.lease.is_some()));
    let leased = net.stores[0].device_bundle(&w.node).unwrap();
    for j in 1..4 {
        let got = apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(leased.clone()), change: None },
                             Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("recorded"));
    }
    bind_everywhere(&net, &w, &pp, seq);
    assert!(net.stores[4].device_record(&w.node).unwrap().lease.is_none(), "the record without the lease");
    let b = Bound { w, seq, pp, ping_sk, hw, kp, platform: Platform::Ios };
    net.epoch += ld::ROTATION_PERIOD_EPOCHS;
    let (hw3, _) = device_key();
    let a = block_on(run_rotation(&net.ctx_pulling(1, Some(o), &[0, 2, 4]), &rotation_at(&net, 1, &b, &b.hw_key(), &hw3, &b.kp, 1), now()));
    assert_eq!((a["success"].as_bool(), a["device_state"].as_str()), (Some(true), Some("active")), "{a}");
    assert!(net.stores[4].device_record(&b.w.node).unwrap().lease.is_some(), "caught up with the leased statement");
}

/// The same for a rebind: an attestor that missed the re-link after a Stop holds the ended record of the node
/// the rebind leaves, of the same key. It pulls the ingress's live record and signs.
#[test]
fn an_attestor_holding_the_ended_record_a_rebind_leaves_pulls_and_signs() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let a = enrol(&net, Platform::Ios, o, "203.0.113.65");
    change_everywhere(&net, 0, &a.w.node, DeviceState::Ended, 0, "released");
    let (pp2, _) = ping_pair();
    let seq2 = a.seq + 10;
    let p = net.prepare(0, &bind(&a.w, &pp2, seq2, ios_block(&net, 0, &a.w, &pp2, seq2, &a.hw, &[]), Some(("dc_token", "t2"))), "203.0.113.65")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(o), &[1, 2, 3]), p), StepAnswer::Final(_)));
    let relinked = net.stores[0].device_bundle(&a.w.node).unwrap();
    for j in 1..4 {
        let got = apply_sync(&net.stores[j], net.genesis, false, &DeviceSync { bundle: Some(relinked.clone()), change: None },
                             Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("recorded"));
    }
    bind_everywhere(&net, &a.w, &pp2, seq2);
    assert!(!net.stores[4].device_record(&a.w.node).unwrap().live(), "genesis 4 holds the ended record");
    let v = wallet();
    net.register(&v);
    let (vpp, seq_b) = (ping_key(), now() + 20);
    let ch = ld::stamp::issue(&net.id(1), &v.node, Purpose::Enrol, now());
    let r = messages::rebind_preimage(&a.w.node, &v.node, seq_b, &ch.nonce);
    let block = json!({ "platform": "ios", "rebind_from": a.w.node, "sig": messages::b64url(&device_sign(&net, &a, &a.kp, &r, 5)),
                        "wallet_sig": sign_hex(&v.sk, &r), "nonce": ch.nonce, "stamp": ch.stamp });
    let p = net.prepare(1, &bind(&v, &vpp, seq_b, block, Some(("dc_token", "r"))), "203.0.113.65").unwrap().unwrap();
    // Genesis 1 takes the rebind and reaches only 0, 2 and 4: genesis 4's signature is needed.
    let rec = match run(net.ctx_pulling(1, Some(o), &[0, 2, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((rec.op, rec.node_id.as_str()), (Op::Rebind, v.node.as_str()));
    assert_eq!(net.stores[4].device_record(&a.w.node).unwrap().seq, seq2, "caught up with the re-link");
}

/// A relay reaching a shard owner a few blocks behind the genesis that credited it is held for the owner's
/// tip (`ping::RelayAnchor::AboveTip`), not dropped, and counts once the tip reaches the anchor: legacy and
/// device replies alike, as the previous binary (which read no anchor on relay) credited them.
#[test]
fn a_relay_anchored_above_the_owners_tip_counts_once_the_tip_reaches_it() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Ios, o, "203.0.113.64");
    let c = anchor_at(&net, H);
    let a = ping::Anchor::parse(&c).unwrap();
    let state = |tip: u64| ping::relay_anchor_state(&AnchorCache::new(), &a, tip, |h| net.stores[2].get_microblock_hash_hex(h).ok().flatten());
    let (legacy, hw) = (legacy_reply(&b, &c), hw_reply(&net, &b, &b.kp, &c, 1));
    assert_eq!(verify(&net, 2, &b.w.node, &c, &legacy, Route::Relay { block_height: H + 1 }, H - 3), Err(ReplyRefusal::Anchor),
               "not creditable as the owner stands");
    assert_eq!(state(H - 3), ping::RelayAnchor::AboveTip);
    let mut held = ping::HeldRelays::new();
    assert!(held.hold(&b.w.node, &net.id(0), true, false, H, now(), legacy.len(), (legacy.clone(), H + 1)));
    assert!(held.hold(&b.w.node, &net.id(3), true, true, H, now(), hw.len(), (hw.clone(), H)));
    assert!(held.take_due(H - 1, now()).0.is_empty());
    assert_eq!(state(H), ping::RelayAnchor::Current);
    let due = held.take_due(H, now()).0;
    assert_eq!(due.len(), 2);
    for (sig, block_height) in due {
        assert_eq!(verify(&net, 2, &b.w.node, &c, &sig, Route::Relay { block_height }, H), Ok(()));
    }
}

#[test]
fn stop_ends_the_device_record_everywhere_and_the_oracle_forgets_the_slot() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Ios, o, "203.0.113.46");
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    let release = |i: usize, counter: u32, kp: &ring::signature::EcdsaKeyPair| {
        let ch = ld::stamp::issue(&net.id(i), &b.w.node, Purpose::Release, now());
        let sig = device_sign(&net, &b, kp, &messages::release_preimage(&b.w.node, b.seq, &ch.nonce), counter);
        json!({ "nonce": ch.nonce, "stamp": ch.stamp, "sig": messages::b64url(&sig) })
    };
    // Another issuer's stamp, another key's signature, another binding's sequence: nothing ends.
    assert_eq!(release_step(&ctx, &b.w.node, b.seq, &release(1, 1, &b.kp), now()).err(), Some(StepRefusal::device(DeviceReason::Stale)));
    assert_eq!(release_step(&ctx, &b.w.node, b.seq, &release(0, 1, &device_key().1), now()).err(),
               Some(StepRefusal::Binding(Refusal::BadSignature)));
    assert_eq!(release_step(&ctx, &b.w.node, b.seq + 1, &release(0, 1, &b.kp), now()).err(), Some(StepRefusal::Binding(Refusal::StaleSeq)));
    let change = block_on(async {
        let c = release_step(&ctx, &b.w.node, b.seq, &release(0, 1, &b.kp), now()).expect("released");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        c
    });
    assert_eq!((change.state, change.reason.as_str(), change.until_epoch), (DeviceState::Ended, "released", 0));
    let (path, body) = o.calls.lock().iter().rev().find(|(p, _)| p == "/v1/release").cloned().expect("the oracle is told");
    assert_eq!((path.as_str(), body.get("dc_token")), ("/v1/release", None), "no token came, none goes");
    for (j, s) in net.stores.iter().enumerate() {
        if j > 0 {
            apply_sync(s, net.genesis, false, &DeviceSync { bundle: None, change: Some(change.clone()) }, None, now(), net.epoch).unwrap();
        }
        let r = s.device_record(&b.w.node).unwrap();
        assert_eq!((r.state, r.reason.as_str()), (DeviceState::Ended, "released"));
        assert!(s.device_key_entry(&b.hw_key()).is_none());
    }
    // A pause survives a Stop: the ended record keeps its epoch and a new enrolment of the node waits; the
    // oracle is told as at any Stop (its release keeps the slot's hold), and the device's key moves to no
    // other wallet's node until the pause's epoch.
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let p = enrol(&net, Platform::Ios, o, "203.0.113.47");
    change_everywhere(&net, 1, &p.w.node, DeviceState::Paused, net.epoch + 90, "two_strikes");
    let ctx = net.ctx(0, Some(o), &[1, 2, 3, 4]);
    let ch = ld::stamp::issue(&net.id(0), &p.w.node, Purpose::Release, now());
    let sig = device_sign(&net, &p, &p.kp, &messages::release_preimage(&p.w.node, p.seq, &ch.nonce), 1);
    let released_before = o.paths().iter().filter(|x| *x == "/v1/release").count();
    let c = block_on(async {
        let c = release_step(&ctx, &p.w.node, p.seq, &json!({ "nonce": ch.nonce, "stamp": ch.stamp, "sig": messages::b64url(&sig) }), now()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        c
    });
    assert_eq!((c.state, c.until_epoch), (DeviceState::Ended, net.epoch + 90));
    assert_eq!(o.paths().iter().filter(|x| *x == "/v1/release").count(), released_before + 1, "the oracle is told");
    assert!(net.stores[0].device_key_entry(&p.hw_key()).is_some(), "the paused key stays held");
    let (pp, seq) = (ping_key(), now() + 5);
    let (hw, _) = device_key();
    match net.prepare(0, &bind(&p.w, &pp, seq, ios_block(&net, 0, &p.w, &pp, seq, &hw, &[]), Some(("dc_token", "x"))), "203.0.113.47") {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.paused_until), (DeviceReason::SlotPaused, Some(net.epoch + 90))),
        other => panic!("{other:?}"),
    }
    let v = wallet();
    net.register(&v);
    let vpp = ping_key();
    let other_wallet = |net: &Net| bind(&v, &vpp, seq, ios_block(net, 0, &v, &vpp, seq, &p.hw, &[]), Some(("dc_token", "y")));
    match net.prepare(0, &other_wallet(&net), "203.0.113.47") {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.paused_until), (DeviceReason::SlotPaused, Some(net.epoch + 90))),
        other => panic!("{other:?}"),
    }
    // From the pause's epoch the ended record holds the key no more.
    net.epoch += 90;
    assert!(matches!(net.prepare(0, &other_wallet(&net), "203.0.113.47"), Ok(Some(_))));
}

/// A pause holds the device it paused on every path, not only the rebind's: while it runs, a binding its
/// device withdrew (or a later binding replaced) frees its key for no other wallet's node - neither a fresh
/// attestation of it nor an assertion by it - and nothing is released at the oracle. From its epoch the
/// key moves as any released one does.
#[test]
fn a_paused_device_moves_to_no_other_node_until_its_pause_ends() {
    let mut net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let a = enrol(&net, Platform::Ios, o, "203.0.113.55");
    let until = net.epoch + 90;
    change_everywhere(&net, 1, &a.w.node, DeviceState::Paused, until, "two_strikes");
    for s in &net.stores {
        s.withdraw_light_binding(&a.w.node, a.seq, &a.w.pk_hex, None, |_| Ok(true)).unwrap().unwrap();
    }
    let v = wallet();
    net.register(&v);
    let (vpp, seq) = (ping_key(), now());
    let paused = |r: Result<Option<PreparedDevice>, StepRefusal>| match r {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.paused_until), (DeviceReason::SlotPaused, Some(until))),
        other => panic!("{other:?}"),
    };
    paused(net.prepare(0, &bind(&v, &vpp, seq, ios_block(&net, 0, &v, &vpp, seq, &a.hw, &[]), Some(("dc_token", "b"))), "203.0.113.55"));
    let asserted = |net: &Net, counter: u32| {
        let ch = ld::stamp::issue(&net.id(2), &v.node, Purpose::Enrol, now());
        let e = messages::enrol_preimage(&v.node, &v.wallet, &lb::sha3_hex(&hex::decode(&vpp).unwrap()), seq, &ch.nonce, IOS_FLAGS);
        let block = json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(&a.hw)),
                            "assertion": messages::b64url(&ios_assertion(&a.kp, &app_id(net), &e, counter)), "flags": IOS_FLAGS,
                            "nonce": ch.nonce, "stamp": ch.stamp });
        bind(&v, &vpp, seq, block, Some(("dc_token", "c")))
    };
    paused(net.prepare(2, &asserted(&net, 1), "203.0.113.55"));
    assert!(!o.paths().contains(&"/v1/release".to_string()), "nothing released while the pause runs");
    // From the pause's epoch: the key moves, and the earlier node is released at the oracle first.
    net.epoch = until;
    let p = net.prepare(2, &asserted(&net, 3), "203.0.113.55").unwrap().unwrap();
    let rec = match run(net.ctx(2, Some(o), &[0, 1, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!(rec.node_id, v.node);
    assert!(o.paths().contains(&"/v1/release".to_string()));
}

/// Owner decision (b): wallet A's node ran on this install and A stopped it, but the release never reached
/// a genesis. Wallet B's fresh enrolment reuses the install's key: A's record ends first, at the genesis and
/// at the oracle, and B's statement is final without `device_key_in_use`.
#[test]
fn a_fresh_enrolment_ends_the_record_a_released_binding_left_on_its_key() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let a = enrol(&net, Platform::Ios, o, "203.0.113.48");
    for s in &net.stores {
        s.withdraw_light_binding(&a.w.node, a.seq, &a.w.pk_hex, None, |_| Ok(true)).unwrap().unwrap();
    }
    assert!(net.stores[0].device_record(&a.w.node).unwrap().live(), "no release came");
    let v = wallet();
    net.register(&v);
    let (vpp, seq) = (ping_key(), now());
    let ch = ld::stamp::issue(&net.id(0), &v.node, Purpose::Enrol, now());
    let e = messages::enrol_preimage(&v.node, &v.wallet, &lb::sha3_hex(&hex::decode(&vpp).unwrap()), seq, &ch.nonce, IOS_FLAGS);
    let block = json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(&a.hw)),
                        "assertion": messages::b64url(&ios_assertion(&a.kp, &app_id(&net), &e, 1)), "flags": IOS_FLAGS,
                        "nonce": ch.nonce, "stamp": ch.stamp });
    let p = net.prepare(0, &bind(&v, &vpp, seq, block, Some(("dc_token", "b"))), "203.0.113.48").unwrap().unwrap();
    assert_eq!(p.key_node.as_deref(), Some(a.w.node.as_str()));
    let before = o.paths().len();
    let rec = match run(net.ctx(0, Some(o), &[1, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!(rec.node_id, v.node);
    let asked: Vec<(String, Value)> = o.calls.lock()[before..].to_vec();
    let release = asked.iter().position(|(p, b)| p == "/v1/release" && b["node_id"] == json!(a.w.node)).expect("A released at the oracle");
    let claim = asked.iter().position(|(p, _)| p == "/v1/claim").expect("B's claim");
    assert!(release < claim, "released before B's claim: {:?}", asked.iter().map(|(p, _)| p).collect::<Vec<_>>());
    assert!(asked[release].1["preimage"].as_str().unwrap().starts_with(&format!("qnet_dev_release:v1|1337|{}|{}|", a.w.node, a.seq)));
    let old = net.stores[0].device_record(&a.w.node).unwrap();
    assert!(!old.live() && ["released", "superseded"].contains(&old.reason.as_str()), "{:?}", old.reason);
}

#[test]
fn after_a_rebind_the_old_nodes_replies_stop_and_the_new_one_counts_from_the_next_epoch() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let a = enrol(&net, Platform::Android, o, "203.0.113.49");
    let v = wallet();
    net.register(&v);
    let (vpp, vsk) = ping_pair();
    let seq_b = a.seq + 1;
    let ch = ld::stamp::issue(&net.id(1), &v.node, Purpose::Enrol, now());
    let r = messages::rebind_preimage(&a.w.node, &v.node, seq_b, &ch.nonce);
    let block = json!({ "platform": "android", "rebind_from": a.w.node, "sig": messages::b64url(&device_sign(&net, &a, &a.kp, &r, 0)),
                        "wallet_sig": sign_hex(&v.sk, &r), "nonce": ch.nonce, "stamp": ch.stamp });
    let p = net.prepare(1, &bind(&v, &vpp, seq_b, block, Some(("pi_token", "r"))), "203.0.113.49").unwrap().unwrap();
    let rec = match run(net.ctx(1, Some(o), &[0, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((rec.op, rec.state), (Op::Rebind, DeviceState::PendingNextEpoch));
    net.sync_from(1, &v.node);
    bind_everywhere(&net, &v, &vpp, seq_b);
    let b = Bound { w: v, seq: seq_b, pp: vpp, ping_sk: vsk, hw: a.hw, kp: device_key().1, platform: Platform::Android };
    let c = anchor_at(&net, H);
    let t = now() * 1000;
    assert_eq!(verify(&net, 0, &a.w.node, &c, &hw_reply(&net, &a, &a.kp, &c, t), Route::Ingress, H + 5), Err(ReplyRefusal::NotCounted),
               "the old node's record ended");
    assert_eq!(verify(&net, 0, &b.w.node, &c, &hw_reply(&net, &b, &a.kp, &c, t + 1), Route::Ingress, H + 5), Err(ReplyRefusal::NotCounted),
               "the new node waits for the next epoch");
    let next = anchor_at(&net, H + 14_400);
    assert_eq!(verify(&net, 0, &b.w.node, &next, &hw_reply(&net, &b, &a.kp, &next, t + 2), Route::Ingress, H + 14_405), Ok(()));
}

#[test]
fn the_pinger_and_a_wake_reach_a_device_only_while_its_record_counts() {
    let net = Net::new(false);
    let o = script(&net, LeaseKind::ClaimedVirgin, Rot::Down);
    let b = enrol(&net, Platform::Ios, o, "203.0.113.50");
    let s = &net.stores[0];
    let t = now();
    assert!(crate::rpc::device_pushable_at(s, &b.w.node, net.epoch, t), "active");
    // No record at all: an installed app's node, reached as before while legacy replies count.
    assert!(crate::rpc::device_pushable_at(s, "light_mobile_0000000000000001", net.epoch, t));
    change_everywhere(&net, 1, &b.w.node, DeviceState::Paused, net.epoch + 3, "two_strikes");
    assert!(!crate::rpc::device_pushable_at(s, &b.w.node, net.epoch, t), "paused");
    assert!(!crate::rpc::device_pushable_at(s, &b.w.node, net.epoch + 3, t), "a pause over waits for a refresh");
    let lapsed = net.stores[1].device_record(&b.w.node).unwrap();
    assert!(!lapsed.state_at(true, net.epoch + 10, lapsed.lease_valid_until + 1).counts(), "a lapsed lease stops the count");
    let f = script(&net, LeaseKind::ClaimedForeign, Rot::Down);
    let n = enrol(&net, Platform::Ios, f, "203.0.113.51");
    assert!(!crate::rpc::device_pushable_at(s, &n.w.node, net.epoch, t), "pending the next epoch");
    assert!(crate::rpc::device_pushable_at(s, &n.w.node, net.epoch + 1, t));
}

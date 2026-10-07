//! The device step end to end with five genesis in one process: each with its own storage and consensus
//! key, a scripted oracle signing with a test key the harness pins, and a vendor check that stands in for
//! the Apple and Google roots (the verifier crate tests those against the vendors' own samples). Everything
//! else - stamps, the wallet's delegation, the attestors' checks and votes, the quorum, the records, the
//! sync - is the production code.

use super::*;
use crate::light_binding as lb;
use crate::light_device::evidence::{Evidence, EvidenceRefusal, Policies};
use crate::light_device::record::KeyEntry;
use crate::light_device::statement::tests::{raw_sign, test_genesis};
use crate::light_device::{Effective, Gate, LeaseKind, Prov};
use pqcrypto_mldsa::mldsa65 as d3;
use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};

struct Wallet { sk: d3::SecretKey, pk_hex: String, wallet: String, node: String }

fn wallet() -> Wallet {
    let (pk, sk) = d3::keypair();
    let pk_hex = hex::encode(pk.as_bytes());
    let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).expect("eon");
    let node = generate_light_node_pseudonym(&wallet);
    Wallet { sk, pk_hex, wallet, node }
}

fn sign_hex(sk: &d3::SecretKey, msg: &str) -> String {
    hex::encode(d3::detached_sign(msg.as_bytes(), sk).as_bytes())
}

/// The stand-in vendor check: an attestation (iOS) or the first certificate (Android) is the device key,
/// then SHA-256 of the preimage, then `T` for a build signed with the developer's key; `refuse:<reason>`
/// makes it refuse. Android's second certificate is the attestation key, its third `rkp` or `factory`.
fn fake_attest(p: &Policies, b: &DeviceBlock, preimage: &str, _now: u64, _crl: &qnet_device_attest::revocation::RevocationList)
    -> Result<VerifiedDevice, EvidenceRefusal> {
    let (bytes, platform) = match &b.evidence {
        Evidence::IosAttestation { attestation, .. } => (attestation.as_slice(), Platform::Ios),
        Evidence::Android { chain, .. } => (chain[0].as_slice(), Platform::Android),
        _ => return Err(EvidenceRefusal { reason: DeviceReason::NotGenuine, code: "not_a_new_key" }),
    };
    if let Some(r) = bytes.strip_prefix(b"refuse:") {
        let reason = DeviceReason::parse(&format!("device_{}", String::from_utf8_lossy(r))).unwrap();
        return Err(EvidenceRefusal { reason, code: "scripted" });
    }
    if bytes.len() < 97 || bytes[65..97] != messages::sha256(preimage.as_bytes()) {
        return Err(EvidenceRefusal { reason: DeviceReason::Stale, code: "challenge_mismatch" });
    }
    let trust = if bytes.get(97) == Some(&b'T') { Trust::Test } else { Trust::Store };
    let allowed = match platform { Platform::Ios => p.ios.allow_development, Platform::Android => p.android.allow_test };
    if trust == Trust::Test && !allowed { return Err(EvidenceRefusal { reason: DeviceReason::AppUnrecognized, code: "test_build" }); }
    let (prov, att_key) = match &b.evidence {
        Evidence::Android { chain, .. } if chain[2] == b"rkp" => (Prov::Rkp, Some(hex::encode(messages::sha3_256(&chain[1])))),
        Evidence::Android { .. } => (Prov::Factory, None),
        _ => (Prov::Na, None),
    };
    // An Android chain's serials below the root: the attestation key's certificate stands for them.
    let serials = match &b.evidence {
        Evidence::Android { chain, .. } => vec![fake_serial(&chain[1])],
        _ => vec![],
    };
    Ok(VerifiedDevice { platform, hw_pub: bytes[..65].try_into().unwrap(), prov, trust, att_key, certs_issued: None,
                        serials, receipt: None, counter: 0, fresh: true })
}

/// The serial the stand-in vendor check gives the certificate `cert` (uppercase, with a leading zero, as a
/// chain may spell it; the list's form is lowercase without).
fn fake_serial(cert: &[u8]) -> String {
    format!("0{}", hex::encode_upper(&messages::sha3_256(cert)[..6]))
}

#[derive(Clone, Copy)]
enum Mode { Lease(LeaseKind, Effective, Gate), Refuse(&'static str, u64), Down }

struct FakeOracle { sk: d3::SecretKey, mode: Mode }

#[async_trait::async_trait]
impl OracleApi for FakeOracle {
    async fn post(&self, path: &'static str, body: Value, _t: std::time::Duration) -> Result<Value, oracle::OracleError> {
        if path == "/v1/refusal" {
            // A refusal the genesis filed for appeals: the oracle's field list, no token.
            for k in body.as_object().unwrap().keys() {
                assert!(["node_id", "platform", "hw_pub", "nonce", "reason", "evidence"].contains(&k.as_str()), "{k}");
            }
            return Ok(json!({ "ref": "00000000" }));
        }
        if path == "/v1/release" {
            // A key a released binding still held (owner decision (b)): the genesis releases that node first.
            for k in body.as_object().unwrap().keys() {
                assert!(["node_id", "preimage", "dc_token", "pi_token"].contains(&k.as_str()), "{k}");
            }
            return Ok(json!({ "state": "ended", "reason": "released" }));
        }
        assert_eq!(path, "/v1/claim");
        let platform = Platform::parse(body["platform"].as_str().unwrap()).unwrap();
        // Exactly the platform's token field, never the other one.
        assert!(body.get(oracle::token_field(platform)).is_some());
        assert!(body.get(if platform == Platform::Ios { "pi_token" } else { "dc_token" }).is_none());
        let now = ld::now_secs();
        match self.mode {
            Mode::Down => Err(oracle::OracleError::Unavailable("unreachable")),
            Mode::Refuse(r, t) => Err(oracle::OracleError::Refused {
                reason: DeviceReason::parse(r).unwrap(), reference: None,
                until: (r == "device_slot_paused").then_some(now + t), retry_at: (r != "device_slot_paused").then_some(now + t),
            }),
            Mode::Lease(lease, effective, gate) => {
                let hw_pub = hex::decode(body["hw_pub"].as_str().unwrap()).unwrap();
                let l = LeaseStatement { node: body["node_id"].as_str().unwrap().into(), device_tag: messages::device_tag(platform, &hw_pub),
                    lease, effective, gate, pi_digest: String::new(), issued_at: now };
                let text = l.preimage();
                Ok(json!({ "lease_statement": text, "oracle_sig": raw_sign(&self.sk, &text), "lease_valid_until": now + 7 * 86_400,
                           "refresh_at": now + 6 * 86_400, "state": "active" }))
            }
        }
    }

    async fn get(&self, _path: &'static str, _t: std::time::Duration) -> Result<Value, oracle::OracleError> {
        Err(oracle::OracleError::Unavailable("unreachable"))
    }
}

struct Net {
    genesis: &'static GenesisSet,
    secrets: Arc<Vec<(String, d3::SecretKey)>>,
    stores: Vec<Arc<crate::storage::Storage>>,
    _dirs: Vec<tempfile::TempDir>,
    pins: &'static OraclePins,
    oracle_sk: d3::SecretKey,
    verifier: &'static Verifier,
    mainnet: bool,
    epoch: u64,
}

impl Net {
    fn new(mainnet: bool) -> Net {
        let (g, secrets) = test_genesis();
        let (opk, osk) = d3::keypair();
        let mut stores = Vec::new();
        let mut dirs = Vec::new();
        for _ in 0..5 {
            let d = tempfile::TempDir::new().unwrap();
            stores.push(Arc::new(crate::storage::Storage::new(d.path().to_str().unwrap()).unwrap()));
            dirs.push(d);
        }
        Net {
            genesis: Box::leak(Box::new(g)),
            secrets: Arc::new(secrets),
            stores,
            _dirs: dirs,
            pins: Box::leak(Box::new(OraclePins { keys: vec![(opk.as_bytes().to_vec(), u64::MAX)] })),
            oracle_sk: osk,
            verifier: Box::leak(Box::new(Verifier { policies: Policies::for_network(mainnet), attest: fake_attest })),
            mainnet,
            epoch: 155,
        }
    }

    fn id(&self, i: usize) -> String { self.secrets[i].0.clone() }

    fn oracle(&self, mode: Mode) -> &'static dyn OracleApi {
        Box::leak(Box::new(FakeOracle { sk: self.oracle_sk.clone(), mode }))
    }

    fn ctx(&self, i: usize, oracle: Option<&'static dyn OracleApi>, reach: &[usize]) -> DeviceCtx {
        self.ctx_with(i, oracle, reach, false)
    }

    /// `ctx` whose attestors heal a record they miss by the production pull (`pulling_attestor`).
    fn ctx_pulling(&self, i: usize, oracle: Option<&'static dyn OracleApi>, reach: &[usize]) -> DeviceCtx {
        self.ctx_with(i, oracle, reach, true)
    }

    fn ctx_with(&self, i: usize, oracle: Option<&'static dyn OracleApi>, reach: &[usize], pulling: bool) -> DeviceCtx {
        let secrets = self.secrets.clone();
        let attestors: Vec<DeviceCtx> = (0..5).map(|j| if pulling { self.pulling_attestor(j) } else { self.attestor(j) }).collect();
        let reach: Vec<usize> = reach.to_vec();
        let ids: Vec<String> = (0..5).map(|j| self.id(j)).collect();
        DeviceCtx {
            storage: self.stores[i].clone(),
            own_id: self.id(i),
            sign: Arc::new(move |m: &str| Some(raw_sign(&secrets[i].1, m))),
            ask: Arc::new(move |member: String, req: AttestRequest| {
                let j = ids.iter().position(|x| *x == member).unwrap();
                let a = attestors[j].clone();
                let reachable = reach.contains(&j);
                Box::pin(async move { if reachable { Some(attest_answer(&a, &req).await) } else { None } })
            }),
            pull: None,
            oracle,
            verifier: self.verifier,
            genesis: self.genesis,
            pins: self.pins,
            epoch: self.epoch,
            mainnet: self.mainnet,
            distribute: false,
        }
    }

    fn attestor(&self, j: usize) -> DeviceCtx {
        let secrets = self.secrets.clone();
        DeviceCtx {
            storage: self.stores[j].clone(),
            own_id: self.id(j),
            sign: Arc::new(move |m: &str| Some(raw_sign(&secrets[j].1, m))),
            ask: Arc::new(|_, _| Box::pin(async { None })),
            pull: None,
            oracle: None,
            verifier: self.verifier,
            genesis: self.genesis,
            pins: self.pins,
            epoch: self.epoch,
            mainnet: self.mainnet,
            distribute: false,
        }
    }

    /// Ask genesis `id` in process for what it serves of `node` (`device_get_answer`).
    fn answer_of(stores: &[Arc<crate::storage::Storage>], ids: &[String], id: &str, node: &str) -> Option<Value> {
        ids.iter().position(|x| x == id).map(|k| device_get_answer(&stores[k], node))
    }

    /// The attestor `j` with the production pull-heal (`pull_device_record_via`) over the in-process genesis:
    /// the address it is handed is a genesis's, as `attest_answer` resolves the request's ingress.
    fn pulling_attestor(&self, j: usize) -> DeviceCtx {
        let mut a = self.attestor(j);
        let (stores, genesis, mainnet, own) = (self.stores.clone(), self.genesis, self.mainnet, self.id(j));
        let ids: Vec<String> = (0..5).map(|k| self.id(k)).collect();
        a.pull = Some(Arc::new(move |node: String, ip: String| {
            let (stores, ids, own) = (stores.clone(), ids.clone(), own.clone());
            Box::pin(async move {
                let Some(from) = crate::genesis_constants::GENESIS_NODE_IPS.iter().find(|(x, _)| *x == ip)
                    .map(|(_, id)| format!("genesis_node_{}", id)) else { return false; };
                let target = stores[j].clone();
                pull_device_record_via(&target, genesis, mainnet, Some(&own), &node, &from, |id: String| {
                    let v = Net::answer_of(&stores, &ids, &id, &node);
                    async move { v }
                }).await
            })
        }));
        a
    }

    fn register(&self, w: &Wallet) {
        let pk = hex::decode(&w.pk_hex).unwrap();
        for s in &self.stores {
            s.save_node_registration_at_height_burn_vrf(&w.node, "light", &w.wallet, 70.0, 100, "", Some(&pk)).unwrap();
        }
    }

    /// Send the final statement ingress `i` holds to every other genesis, as its push does.
    fn sync_from(&self, i: usize, node: &str) {
        let b = self.stores[i].device_bundle(node).expect("the ingress keeps the proof");
        for (j, s) in self.stores.iter().enumerate() {
            if j == i { continue; }
            let got = apply_sync(s, self.genesis, self.mainnet, &DeviceSync { bundle: Some(b.clone()), change: None },
                                 Some(&self.id(j)), ld::now_secs(), self.epoch);
            assert!(matches!(got, Ok("recorded") | Ok("same")), "{got:?}");
        }
    }

    fn prepare(&self, i: usize, req: &LightNodeBindRequest, addr: &str) -> Result<Option<PreparedDevice>, StepRefusal> {
        prepare_bind_device(&self.stores[i], req, true, Some(&self.id(i)), self.verifier,
                            Some(format!("{}:4000", addr).parse().unwrap()), ld::now_secs(), self.epoch)
    }
}

/// A new device key: its 65-byte point and, for a key that must really sign, its signer.
fn device_key() -> ([u8; 65], ring::signature::EcdsaKeyPair) {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    (kp.public_key().as_ref().try_into().unwrap(), kp)
}

/// A `/bind` request of `w`'s wallet for the ping key `pp` at `seq`, carrying `device` and its token.
fn bind(w: &Wallet, pp: &str, seq: u64, device: Value, token: Option<(&str, &str)>) -> LightNodeBindRequest {
    let mut r = LightNodeBindRequest {
        node_id: w.node.clone(),
        wallet_address: w.wallet.clone(),
        identity_pubkey: w.pk_hex.clone(),
        ping_pubkey: pp.to_string(),
        delegation_cert: sign_hex(&w.sk, &lb::delegation_v2_message(pp, &w.node, seq)),
        seq,
        ts: seq,
        device: Some(device),
        ..Default::default()
    };
    match token {
        Some(("dc_token", t)) => r.dc_token = Some(t.into()),
        Some((_, t)) => r.pi_token = Some(t.into()),
        None => {}
    }
    r
}

fn ping_key() -> String {
    let (pk, _) = d3::keypair();
    hex::encode(pk.as_bytes())
}

const IOS_FLAGS: &str = "mac=0,vision=0,idiom=phone";

/// The iOS enrolment block for the device key `hw`, over the preimage the node rebuilds.
fn ios_block(net: &Net, i: usize, w: &Wallet, pp: &str, seq: u64, hw: &[u8; 65], extra: &[u8]) -> Value {
    let c = ld::stamp::issue(&net.id(i), &w.node, Purpose::Enrol, ld::now_secs());
    let e = messages::enrol_preimage(&w.node, &w.wallet, &lb::sha3_hex(&hex::decode(pp).unwrap()), seq, &c.nonce, IOS_FLAGS);
    let mut att = hw.to_vec();
    att.extend_from_slice(&messages::sha256(e.as_bytes()));
    att.extend_from_slice(extra);
    json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(hw)), "attestation": messages::b64url(&att),
            "flags": IOS_FLAGS, "nonce": c.nonce, "stamp": c.stamp })
}

const REPORT: &str = "{\"arc\":false,\"automotive\":false,\"embedded\":false,\"feature_pc\":false,\"hsum\":false,\"leanback\":false,\"system_user\":true,\"touchscreen\":true,\"watch\":false}";

fn android_block(net: &Net, i: usize, w: &Wallet, pp: &str, seq: u64, hw: &[u8; 65], att_key: &[u8], prov: &[u8]) -> Value {
    let c = ld::stamp::issue(&net.id(i), &w.node, Purpose::Enrol, ld::now_secs());
    let e = messages::enrol_preimage(&w.node, &w.wallet, &lb::sha3_hex(&hex::decode(pp).unwrap()), seq, &c.nonce,
                                     &messages::android_flags(REPORT));
    let mut leaf = hw.to_vec();
    leaf.extend_from_slice(&messages::sha256(e.as_bytes()));
    json!({ "platform": "android", "chain": [messages::b64url(&leaf), messages::b64url(att_key), messages::b64url(prov)],
            "report": REPORT, "report_sig": messages::b64url(&[1u8; 70]), "nonce": c.nonce, "stamp": c.stamp })
}

fn run(ctx: DeviceCtx, p: PreparedDevice) -> StepAnswer {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
        .block_on(run_device_step(ctx, p, std::time::Duration::from_secs(20)))
}

fn now() -> u64 { ld::now_secs() }

#[test]
fn an_enrolment_becomes_a_statement_of_four_and_every_genesis_records_it() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let (hw, _) = device_key();
    let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "tok")));
    let p = net.prepare(0, &req, "203.0.113.1").unwrap().expect("a device block");
    assert!(p.held.is_none() && p.device.fresh);
    let ctx = net.ctx(0, Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok))), &[1, 2, 3, 4]);
    let rec = match run(ctx, p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((rec.state, rec.seq, rec.effective_epoch), (DeviceState::Active, seq, net.epoch));
    assert_eq!(rec.lease.as_ref().map(|l| l.kind), Some(LeaseKind::ClaimedVirgin));
    assert!(rec.lease_valid_until > now());
    let b = net.stores[0].device_bundle(&w.node).unwrap();
    assert!(net.genesis.count_valid(&b.statement, &b.sigs) >= ld::STATEMENT_QUORUM);
    net.sync_from(0, &w.node);
    for s in &net.stores {
        let r = s.device_record(&w.node).expect("every genesis records it");
        assert_eq!((r.stmt_hash.as_str(), r.state_at(true, net.epoch, now())), (rec.stmt_hash.as_str(), DeviceState::Active));
        assert_eq!(s.device_key_entry(&rec.hw_key).map(|e| (e.node_id, e.final_)), Some((w.node.clone(), true)));
    }
    // The same binding with the same key again is held: nothing to redo.
    let again = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "tok2")));
    assert!(net.prepare(0, &again, "203.0.113.1").unwrap().unwrap().held.is_some());
}

#[test]
fn without_a_token_or_an_oracle_the_binding_waits_in_check_pending() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let cases = [(None, Some(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)), "token_missing"),
                 (Some(("dc_token", "tok")), Some(Mode::Down), "service_unavailable"),
                 (Some(("dc_token", "tok")), None, "service_unavailable")];
    for (i, (token, oracle, reason)) in cases.into_iter().enumerate() {
        let (pp, seq) = (ping_key(), now() + 10 * i as u64);
        let (hw, _) = device_key();
        let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), token);
        let p = net.prepare(0, &req, "203.0.113.2").unwrap().unwrap();
        let rec = match run(net.ctx(0, oracle.map(|m| net.oracle(m)), &[1, 2, 3, 4]), p) {
            StepAnswer::Final(r) => *r, other => panic!("{other:?}"),
        };
        assert_eq!((rec.state, rec.reason.as_str(), rec.lease.is_none()), (DeviceState::CheckPending, reason, true), "{reason}");
        assert!(!rec.state_at(true, net.epoch + 5, now()).counts(), "never counted");
    }
    // A multiplicity gate over its bound waits too; a foreign slot counts from the next epoch.
    let (pp, seq) = (ping_key(), now() + 100);
    let (hw, _) = device_key();
    let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "t")));
    let p = net.prepare(0, &req, "203.0.113.2").unwrap().unwrap();
    let r = run(net.ctx(0, Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::MetricHigh))), &[1, 2, 3, 4]), p);
    assert!(matches!(r, StepAnswer::Final(ref x) if x.state == DeviceState::CheckPending), "{r:?}");
    let (pp, seq) = (ping_key(), now() + 200);
    let (hw, _) = device_key();
    let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "t")));
    let p = net.prepare(0, &req, "203.0.113.2").unwrap().unwrap();
    let r = run(net.ctx(0, Some(net.oracle(Mode::Lease(LeaseKind::ClaimedForeign, Effective::Next, Gate::Ok))), &[1, 2, 3, 4]), p);
    match r {
        StepAnswer::Final(x) => {
            assert_eq!((x.state, x.effective_epoch), (DeviceState::PendingNextEpoch, net.epoch + 1));
            assert_eq!(x.state_at(true, net.epoch + 1, now()), DeviceState::Active);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_oracle_refusal_refuses_the_binding_with_its_reason() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    for (reason, secs) in [("device_slot_paused", 30 * 86_400u64), ("device_rate_limited", 3600), ("device_key_in_use", 1)] {
        let (pp, seq) = (ping_key(), now());
        let (hw, _) = device_key();
        let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "tok")));
        let p = net.prepare(0, &req, "203.0.113.3").unwrap().unwrap();
        let reference = p.reference();
        match run(net.ctx(0, Some(net.oracle(Mode::Refuse(reason, secs))), &[1, 2, 3, 4]), p) {
            StepAnswer::Refused(StepRefusal::Device(d)) => {
                assert_eq!(d.reason.as_str(), reason);
                if reason != "device_key_in_use" { assert!(d.retry_after.unwrap() >= secs - 5, "{reason}"); }
                assert_eq!(d.reference.as_deref(), Some(reference.as_str()), "the screen can quote it");
                if reason == "device_slot_paused" { assert!(d.paused_until.is_some()); }
            }
            other => panic!("{reason}: {other:?}"),
        }
        assert!(net.stores[0].device_record(&w.node).is_none(), "nothing written");
    }
}

#[test]
fn a_quorum_short_of_four_is_transient_and_writes_no_record() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let (hw, _) = device_key();
    let req = bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), Some(("dc_token", "tok")));
    let p = net.prepare(0, &req, "203.0.113.4").unwrap().unwrap();
    // Two genesis down: three signatures at most.
    match run(net.ctx(0, Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok))), &[1, 2]), p) {
        StepAnswer::Refused(StepRefusal::Device(d)) => assert_eq!((d.reason, d.retry_after), (DeviceReason::Stale, Some(60))),
        other => panic!("{other:?}"),
    }
    assert!(net.stores[0].device_record(&w.node).is_none());
}

#[test]
fn a_split_race_yields_at_most_one_statement() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let lease = || Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)));
    let (k1, _) = device_key();
    let (k2, _) = device_key();
    let p1 = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &k1, &[]), Some(("dc_token", "a"))), "203.0.113.5")
        .unwrap().unwrap();
    let p2 = net.prepare(1, &bind(&w, &pp, seq, ios_block(&net, 1, &w, &pp, seq, &k2, &[]), Some(("dc_token", "b"))), "203.0.113.6")
        .unwrap().unwrap();
    // A partition: genesis 1's ingress reaches 3, genesis 2's reaches 4 and 5.
    let finals = |a: &StepAnswer| matches!(a, StepAnswer::Final(_)) as usize;
    let a1 = run(net.ctx(0, lease(), &[2]), p1.clone());
    let a2 = run(net.ctx(1, lease(), &[3, 4]), p2.clone());
    assert_eq!(finals(&a1) + finals(&a2), 0, "{a1:?} {a2:?}");
    // The partition heals: each ingress now reaches everyone, and still at most one statement is final -
    // here none, since each side's voters refuse the other device at this node and sequence.
    let b1 = run(net.ctx(0, lease(), &[1, 2, 3, 4]), p1.clone());
    let b2 = run(net.ctx(1, lease(), &[0, 2, 3, 4]), p2.clone());
    assert!(finals(&b1) + finals(&b2) <= 1, "{b1:?} {b2:?}");
    assert!(matches!(b1, StepAnswer::Refused(StepRefusal::Binding(Refusal::StaleSeq))), "{b1:?}");
    assert!(matches!(b2, StepAnswer::Refused(StepRefusal::Binding(Refusal::StaleSeq))), "{b2:?}");

    // Without a partition the first device's statement is final and the second is refused.
    let net = Net::new(false);
    net.register(&w);
    let p1 = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &k1, &[]), Some(("dc_token", "a"))), "203.0.113.5")
        .unwrap().unwrap();
    let p2 = net.prepare(1, &bind(&w, &pp, seq, ios_block(&net, 1, &w, &pp, seq, &k2, &[]), Some(("dc_token", "b"))), "203.0.113.6")
        .unwrap().unwrap();
    let a1 = run(net.ctx(0, lease(), &[1, 2, 3, 4]), p1);
    let a2 = run(net.ctx(1, lease(), &[0, 2, 3, 4]), p2);
    assert_eq!(finals(&a1), 1, "{a1:?}");
    assert!(matches!(a2, StepAnswer::Refused(StepRefusal::Binding(Refusal::StaleSeq))), "{a2:?}");

    // One device key for two nodes at once: the attestors that signed for the first refuse the second.
    let net = Net::new(false);
    let v = wallet();
    net.register(&w);
    net.register(&v);
    let (k, _) = device_key();
    let pv = ping_key();
    let p1 = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &k, &[]), Some(("dc_token", "a"))), "203.0.113.7")
        .unwrap().unwrap();
    let p2 = net.prepare(1, &bind(&v, &pv, seq, ios_block(&net, 1, &v, &pv, seq, &k, &[]), Some(("dc_token", "b"))), "203.0.113.8")
        .unwrap().unwrap();
    let a1 = run(net.ctx(0, lease(), &[2, 3]), p1);
    let a2 = run(net.ctx(1, lease(), &[0, 2, 3, 4]), p2);
    assert!(finals(&a1) + finals(&a2) <= 1, "{a1:?} {a2:?}");
    assert!(matches!(a2, StepAnswer::Refused(StepRefusal::Device(ref d)) if d.reason == DeviceReason::KeyInUse), "{a2:?}");
}

#[test]
fn one_device_key_serves_one_node_until_its_record_ends() {
    let net = Net::new(false);
    let (a, b) = (wallet(), wallet());
    net.register(&a);
    net.register(&b);
    let lease = || Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)));
    let (hw, _) = device_key();
    let (ppa, ppb, seq) = (ping_key(), ping_key(), now());
    let p = net.prepare(0, &bind(&a, &ppa, seq, ios_block(&net, 0, &a, &ppa, seq, &hw, &[]), Some(("dc_token", "a"))), "203.0.113.9")
        .unwrap().unwrap();
    let rec = match run(net.ctx(0, lease(), &[1, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    net.sync_from(0, &a.node);
    // Another node with the same key: refused at the ingress, before any vendor call.
    let req_b = bind(&b, &ppb, seq, ios_block(&net, 2, &b, &ppb, seq, &hw, &[]), Some(("dc_token", "b")));
    match net.prepare(2, &req_b, "203.0.113.10") {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.reference.is_some()), (DeviceReason::KeyInUse, true)),
        other => panic!("{other:?}"),
    }
    // Stop on this device ends the record everywhere (the change signed by the genesis that caused it); the
    // same install may then link the other wallet's node with the same key (owner decision (b)).
    let mut c = StateChange { node_id: a.node.clone(), state: DeviceState::Ended, state_seq: 1, until_epoch: 0, reason: "released".into(),
        signer: net.id(3), sig: String::new(), stmt_hash: rec.stmt_hash.clone(), lease_valid_until: None, refresh_at: None };
    c.sig = raw_sign(&net.secrets[3].1, &c.preimage());
    for (j, s) in net.stores.iter().enumerate() {
        let got = apply_sync(s, net.genesis, false, &DeviceSync { bundle: None, change: Some(c.clone()) }, Some(&net.id(j)), now(), net.epoch);
        assert_eq!(got, Ok("changed"));
    }
    let req_b = bind(&b, &ppb, seq, ios_block(&net, 2, &b, &ppb, seq, &hw, &[]), Some(("dc_token", "c")));
    let p = net.prepare(2, &req_b, "203.0.113.10").unwrap().unwrap();
    assert!(matches!(run(net.ctx(2, lease(), &[0, 1, 3, 4]), p), StepAnswer::Final(ref r) if r.node_id == b.node));
    assert_eq!(net.stores[2].device_key_entry(&rec.hw_key).map(|e: KeyEntry| e.node_id), Some(b.node.clone()));
}

/// Owner decision (b): "Stop on this device" withdraws the binding with the device's own ping key; its
/// device key then serves nothing, and a fresh enrolment of another wallet's node in the same install reuses
/// it without `device_key_in_use`. The earlier node's record ends when the new statement is final.
#[test]
fn a_binding_its_device_withdrew_frees_the_key_for_another_wallet_in_the_install() {
    let net = Net::new(false);
    let (a, b) = (wallet(), wallet());
    net.register(&a);
    net.register(&b);
    let lease = || Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)));
    let (hw, _) = device_key();
    let (ppa, ppb, seq) = (ping_key(), ping_key(), now());
    let p = net.prepare(0, &bind(&a, &ppa, seq, ios_block(&net, 0, &a, &ppa, seq, &hw, &[]), Some(("dc_token", "a"))), "203.0.113.15")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, lease(), &[1, 2, 3, 4]), p), StepAnswer::Final(_)));
    net.sync_from(0, &a.node);
    // A's binding at that sequence at every genesis (the bind and its token sync).
    for s in &net.stores {
        s.bind_light_v2(&a.node, &ppa, &"ab".repeat(3309), &a.pk_hex, seq, now()).unwrap().unwrap();
    }
    let enrol_b = |tag: &str| bind(&b, &ppb, seq, ios_block(&net, 1, &b, &ppb, seq, &hw, &[]), Some(("dc_token", tag)));
    match net.prepare(1, &enrol_b("b"), "203.0.113.16") {
        Err(StepRefusal::Device(d)) => assert_eq!(d.reason, DeviceReason::KeyInUse),
        other => panic!("{other:?}"),
    }
    // A's device stops: its unbind withdraws the binding at every genesis (the unbind and its sync).
    for s in &net.stores {
        s.withdraw_light_binding(&a.node, seq, &a.pk_hex, None, |_| Ok(true)).unwrap().unwrap();
    }
    let p = net.prepare(1, &enrol_b("c"), "203.0.113.16").unwrap().unwrap();
    assert!(matches!(run(net.ctx(1, lease(), &[0, 2, 3, 4]), p), StepAnswer::Final(ref r) if r.node_id == b.node));
    net.sync_from(1, &b.node);
    for s in &net.stores {
        let old = s.device_record(&a.node).unwrap();
        assert_eq!((old.state, old.reason.as_str()), (DeviceState::Ended, "superseded"));
    }
}

/// An iOS assertion of `preimage` by `kp`, as `generateAssertion` returns it: CBOR {signature,
/// authenticatorData}, the signature over SHA-256(authenticatorData ‖ SHA-256(preimage)).
fn ios_assertion(kp: &ring::signature::EcdsaKeyPair, app_id: &str, preimage: &str, counter: u32) -> Vec<u8> {
    let mut ad = messages::sha256(app_id.as_bytes()).to_vec();
    ad.push(0);
    ad.extend_from_slice(&counter.to_be_bytes());
    let mut n = ad.clone();
    n.extend_from_slice(&messages::sha256(preimage.as_bytes()));
    let sig = kp.sign(&ring::rand::SystemRandom::new(), &messages::sha256(&n)).unwrap();
    let mut out = vec![0xa2, 0x69];
    out.extend_from_slice(b"signature");
    out.extend_from_slice(&[0x58, sig.as_ref().len() as u8]);
    out.extend_from_slice(sig.as_ref());
    out.push(0x71);
    out.extend_from_slice(b"authenticatorData");
    out.extend_from_slice(&[0x58, ad.len() as u8]);
    out.extend_from_slice(&ad);
    out
}

/// The iOS app reuses the key the network holds: after "Stop on this device" another wallet's node in the
/// same install enrols with an assertion instead of a new attestation (owner decision (b)); the counter
/// must rise every time.
#[test]
fn a_reused_ios_key_asserts_for_another_wallets_node_after_a_stop() {
    let net = Net::new(false);
    let (a, b) = (wallet(), wallet());
    net.register(&a);
    net.register(&b);
    let lease = || Some(net.oracle(Mode::Lease(LeaseKind::SelfReclaim, Effective::Now, Gate::Ok)));
    let (hw, kp) = device_key();
    let (ppa, ppb, seq) = (ping_key(), ping_key(), now());
    let p = net.prepare(0, &bind(&a, &ppa, seq, ios_block(&net, 0, &a, &ppa, seq, &hw, &[]), Some(("dc_token", "a"))), "203.0.113.17")
        .unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, lease(), &[1, 2, 3, 4]), p), StepAnswer::Final(_)));
    net.sync_from(0, &a.node);
    for s in &net.stores {
        s.bind_light_v2(&a.node, &ppa, &"ab".repeat(3309), &a.pk_hex, seq, now()).unwrap().unwrap();
        s.withdraw_light_binding(&a.node, seq, &a.pk_hex, None, |_| Ok(true)).unwrap().unwrap();
    }
    let app_id = net.verifier.policies.ios.app_id.clone();
    let asserted = |i: usize, s: u64, counter: u32| {
        let c = ld::stamp::issue(&net.id(i), &b.node, Purpose::Enrol, now());
        let e = messages::enrol_preimage(&b.node, &b.wallet, &lb::sha3_hex(&hex::decode(&ppb).unwrap()), s, &c.nonce, IOS_FLAGS);
        let block = json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(&hw)),
                            "assertion": messages::b64url(&ios_assertion(&kp, &app_id, &e, counter)), "flags": IOS_FLAGS,
                            "nonce": c.nonce, "stamp": c.stamp });
        bind(&b, &ppb, s, block, Some(("dc_token", "b")))
    };
    let p = net.prepare(2, &asserted(2, seq, 1), "203.0.113.18").unwrap().unwrap();
    assert!(!p.device.fresh && p.key_node.as_deref() == Some(a.node.as_str()));
    let rec = match run(net.ctx(2, lease(), &[0, 1, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((rec.node_id.as_str(), rec.last_counter, rec.hw_pub.as_str()), (b.node.as_str(), 1, hex::encode(hw).as_str()));
    net.sync_from(2, &b.node);
    // A replayed counter is refused; a rising one goes through.
    match net.prepare(3, &asserted(3, seq + 1, 1), "203.0.113.18") {
        Err(StepRefusal::Device(d)) => assert_eq!(d.reason, DeviceReason::Stale),
        other => panic!("{other:?}"),
    }
    assert!(net.prepare(3, &asserted(3, seq + 1, 2), "203.0.113.18").unwrap().is_some());
    // A key identifier nobody recorded is not a device the network holds.
    let (other, okp) = device_key();
    let c = ld::stamp::issue(&net.id(3), &b.node, Purpose::Enrol, now());
    let e = messages::enrol_preimage(&b.node, &b.wallet, &lb::sha3_hex(&hex::decode(&ppb).unwrap()), seq + 2, &c.nonce, IOS_FLAGS);
    let block = json!({ "platform": "ios", "key_id": messages::b64url(&messages::sha256(&other)),
                        "assertion": messages::b64url(&ios_assertion(&okp, &app_id, &e, 1)), "flags": IOS_FLAGS,
                        "nonce": c.nonce, "stamp": c.stamp });
    match net.prepare(3, &bind(&b, &ppb, seq + 2, block, None), "203.0.113.18") {
        Err(StepRefusal::Device(d)) => assert_eq!(d.reason, DeviceReason::NotGenuine),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_remotely_provisioned_attestation_key_serves_one_live_node_and_a_factory_one_is_accepted() {
    let net = Net::new(false);
    let (a, b) = (wallet(), wallet());
    net.register(&a);
    net.register(&b);
    let lease = || Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok)));
    let (ppa, ppb, seq) = (ping_key(), ping_key(), now());
    let (k1, _) = device_key();
    let (k2, _) = device_key();
    let att = [7u8; 65];
    let p = net.prepare(0, &bind(&a, &ppa, seq, android_block(&net, 0, &a, &ppa, seq, &k1, &att, b"rkp"), Some(("pi_token", "a"))),
                        "203.0.113.11").unwrap().unwrap();
    assert_eq!(p.device.prov, Prov::Rkp);
    let rec = match run(net.ctx(0, lease(), &[1, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert!(rec.att_key.is_some());
    net.sync_from(0, &a.node);
    // A second key under the same remotely provisioned attestation key, for another node: one app instance.
    match net.prepare(1, &bind(&b, &ppb, seq, android_block(&net, 1, &b, &ppb, seq, &k2, &att, b"rkp"), Some(("pi_token", "b"))),
                      "203.0.113.12") {
        Err(StepRefusal::Device(d)) => assert_eq!(d.reason, DeviceReason::KeyInUse),
        other => panic!("{other:?}"),
    }
    // O1: a factory-provisioned chain is accepted; its attestation key is shared by a batch and indexes nothing.
    let p = net.prepare(1, &bind(&b, &ppb, seq, android_block(&net, 1, &b, &ppb, seq, &k2, &att, b"factory"), Some(("pi_token", "c"))),
                        "203.0.113.12").unwrap().unwrap();
    assert_eq!((p.device.prov, p.device.att_key.is_none()), (Prov::Factory, true));
    let r = match run(net.ctx(1, lease(), &[0, 2, 3, 4]), p) { StepAnswer::Final(r) => *r, other => panic!("{other:?}") };
    assert_eq!((r.prov, r.state), (Prov::Factory, DeviceState::Active));
}

#[test]
fn a_rebind_moves_the_device_key_to_the_new_wallets_node() {
    use ring::signature::KeyPair as _;
    let net = Net::new(false);
    let (a, b) = (wallet(), wallet());
    net.register(&a);
    net.register(&b);
    let (hw, signer) = device_key();
    assert_eq!(signer.public_key().as_ref(), &hw[..]);
    let (ppa, ppb, seq) = (ping_key(), ping_key(), now());
    let p = net.prepare(0, &bind(&a, &ppa, seq, android_block(&net, 0, &a, &ppa, seq, &hw, &[5u8; 65], b"rkp"), Some(("pi_token", "a"))),
                        "203.0.113.13").unwrap().unwrap();
    assert!(matches!(run(net.ctx(0, Some(net.oracle(Mode::Lease(LeaseKind::ClaimedVirgin, Effective::Now, Gate::Ok))), &[1, 2, 3, 4]), p),
                     StepAnswer::Final(_)));
    net.sync_from(0, &a.node);
    // Wallet B in the same install: the device key and B's wallet key sign the rebind message.
    let seq_b = seq + 1;
    let rebind_block = |wallet_sk: &d3::SecretKey| {
        let c = ld::stamp::issue(&net.id(1), &b.node, Purpose::Enrol, now());
        let r = messages::rebind_preimage(&a.node, &b.node, seq_b, &c.nonce);
        let rng = ring::rand::SystemRandom::new();
        let sig = signer.sign(&rng, r.as_bytes()).unwrap();
        json!({ "platform": "android", "rebind_from": a.node, "sig": messages::b64url(sig.as_ref()), "wallet_sig": sign_hex(wallet_sk, &r),
                "nonce": c.nonce, "stamp": c.stamp })
    };
    // Signed by another wallet's key: refused before any vendor call.
    let forged = bind(&b, &ppb, seq_b, rebind_block(&a.sk), Some(("pi_token", "x")));
    assert_eq!(net.prepare(1, &forged, "203.0.113.14").err(), Some(StepRefusal::Binding(Refusal::BadSignature)));
    let req = bind(&b, &ppb, seq_b, rebind_block(&b.sk), Some(("pi_token", "b")));
    let p = net.prepare(1, &req, "203.0.113.14").unwrap().unwrap();
    assert_eq!(p.rebind_from.as_deref(), Some(a.node.as_str()));
    let rec = match run(net.ctx(1, Some(net.oracle(Mode::Lease(LeaseKind::SelfReclaim, Effective::Now, Gate::Ok))), &[0, 2, 3, 4]), p) {
        StepAnswer::Final(r) => *r, other => panic!("{other:?}"),
    };
    // The new node counts from the next epoch, a switch back included; the old record ends now.
    assert_eq!((rec.op, rec.state, rec.effective_epoch), (Op::Rebind, DeviceState::PendingNextEpoch, net.epoch + 1));
    net.sync_from(1, &b.node);
    for s in &net.stores {
        let old = s.device_record(&a.node).unwrap();
        assert_eq!((old.state, old.reason.as_str()), (DeviceState::Ended, "rebound"));
        assert_eq!(s.device_key_entry(&rec.hw_key).map(|e| e.node_id), Some(b.node.clone()));
    }
}

#[test]
fn every_refusal_of_the_device_block_has_its_stable_reason() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let pp = ping_key();
    let (hw, _) = device_key();
    let seq = now();
    let reason = |r: Result<Option<PreparedDevice>, StepRefusal>| match r {
        Err(StepRefusal::Device(d)) => d.reason.as_str().to_string(),
        Err(StepRefusal::Binding(b)) => b.as_str().to_string(),
        Ok(p) => format!("accepted:{}", p.is_some()),
    };
    // An installed app sends no device block: it binds as before.
    let mut plain = bind(&w, &pp, seq, json!({}), None);
    plain.device = None;
    assert_eq!(reason(net.prepare(0, &plain, "198.51.100.1")), "accepted:false");
    // Stamps: another issuer's, another purpose's, a forged one.
    let block = ios_block(&net, 1, &w, &pp, seq, &hw, &[]);
    assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), "device_stale");
    let c = ld::stamp::issue(&net.id(0), &w.node, Purpose::Rotate, now());
    let mut block = ios_block(&net, 0, &w, &pp, seq, &hw, &[]);
    block["nonce"] = c.nonce.clone().into();
    block["stamp"] = c.stamp.clone().into();
    assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), "device_stale");
    // The flags of a Mac or a headset.
    let mut block = ios_block(&net, 0, &w, &pp, seq, &hw, &[]);
    block["flags"] = "mac=1,vision=0,idiom=pad".into();
    assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), "device_desktop");
    // Evidence over another preimage (a replay into another binding).
    let block = ios_block(&net, 0, &w, &pp, seq + 1, &hw, &[]);
    assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), "device_stale");
    // Every verdict of the vendor check keeps its wire reason.
    for r in ["unsupported", "not_genuine", "app_unrecognized", "emulator", "compromised", "desktop", "secondary_user", "unlicensed"] {
        let c = ld::stamp::issue(&net.id(0), &w.node, Purpose::Enrol, now());
        let att = format!("refuse:{}", r);
        let block = json!({ "platform": "ios", "key_id": messages::b64url(&[1u8; 32]), "attestation": messages::b64url(att.as_bytes()),
                            "flags": IOS_FLAGS, "nonce": c.nonce, "stamp": c.stamp });
        assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), format!("device_{}", r));
    }
    // A build signed with the developer's key: taken on testnet, refused on mainnet.
    let block = ios_block(&net, 0, &w, &pp, seq, &hw, b"T");
    let p = net.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1").unwrap().unwrap();
    assert_eq!(p.device.trust, Trust::Test);
    let main = Net::new(true);
    main.register(&w);
    let block = ios_block(&main, 0, &w, &pp, seq, &hw, b"T");
    assert_eq!(reason(main.prepare(0, &bind(&w, &pp, seq, block, None), "198.51.100.1")), "device_app_unrecognized");
    // A running pause, and a newer binding's record.
    let mut paused = crate::light_device::record::tests::rec(seq, net.epoch, DeviceState::Paused);
    paused.node_id = w.node.clone();
    paused.until_epoch = net.epoch + 10;
    let mut dw = crate::storage::DeviceWrite::default();
    dw.records.push(paused.clone());
    net.stores[0].device_write(dw).unwrap();
    match net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), None), "198.51.100.1") {
        Err(StepRefusal::Device(d)) => assert_eq!((d.reason, d.paused_until), (DeviceReason::SlotPaused, Some(net.epoch + 10))),
        other => panic!("{other:?}"),
    }
    let mut newer = paused.clone();
    newer.state = DeviceState::Active;
    newer.seq = seq + 50;
    let mut dw = crate::storage::DeviceWrite::default();
    dw.records.push(newer);
    net.stores[0].device_write(dw).unwrap();
    assert_eq!(reason(net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), None), "198.51.100.1")),
               "stale_seq");
    // Thirty enrolments an hour from one address, then device_rate_limited with the wait.
    let fresh = Net::new(false);
    let v = wallet();
    fresh.register(&v);
    let mut last = String::new();
    for i in 0..=ld::ENROL_PER_ADDR_PER_HOUR {
        let (k, _) = device_key();
        let r = fresh.prepare(0, &bind(&v, &pp, seq + i as u64, ios_block(&fresh, 0, &v, &pp, seq + i as u64, &k, &[]), None), "198.51.100.77");
        last = match r {
            Err(StepRefusal::Device(d)) => { assert!(d.retry_after.is_some()); d.reason.as_str().to_string() }
            other => reason(other),
        };
        if i < ld::ENROL_PER_ADDR_PER_HOUR { assert_eq!(last, "accepted:true", "enrolment {i}"); }
    }
    assert_eq!(last, "device_rate_limited");
}

/// The address's enrolment budget is spent only by evidence that verifies: anyone behind a carrier's shared
/// address can take a public challenge and send junk evidence, and the honest phones there still enrol.
#[test]
fn junk_evidence_spends_none_of_its_addresss_enrolment_budget() {
    let net = Net::new(false);
    let w = wallet();
    net.register(&w);
    let (pp, seq) = (ping_key(), now());
    let addr = "198.51.100.78";
    for i in 0..2 * ld::ENROL_PER_ADDR_PER_HOUR {
        let c = ld::stamp::issue(&net.id(0), &w.node, Purpose::Enrol, now());
        let block = json!({ "platform": "ios", "key_id": messages::b64url(&[1u8; 32]), "attestation": messages::b64url(b"refuse:not_genuine"),
                            "flags": IOS_FLAGS, "nonce": c.nonce, "stamp": c.stamp });
        match net.prepare(0, &bind(&w, &pp, seq, block, None), addr) {
            Err(StepRefusal::Device(d)) => assert_eq!(d.reason, DeviceReason::NotGenuine, "junk {i}"),
            other => panic!("junk {i}: {other:?}"),
        }
    }
    let (hw, _) = device_key();
    let honest = net.prepare(0, &bind(&w, &pp, seq, ios_block(&net, 0, &w, &pp, seq, &hw, &[]), None), addr);
    assert!(matches!(honest, Ok(Some(_))), "an honest phone behind the same address: {honest:?}");
}

/// `/bind` keeps the answer to a device message only under a stamp this genesis issued for the node's
/// enrolment, keyed by its nonce and the whole message, and never a transient refusal: a request whose
/// stamp does not verify, or another body under the same nonce, never decides what the real message gets.
#[test]
fn bind_keeps_an_answer_only_for_its_own_stamp_and_the_same_message() {
    let net = Net::new(false);
    let w = wallet();
    let (pp, seq) = (ping_key(), now());
    let (hw, _) = device_key();
    let block = ios_block(&net, 0, &w, &pp, seq, &hw, &[]);
    let req = bind(&w, &pp, seq, block.clone(), Some(("dc_token", "t")));
    let key = device_answer_key(&req, Some(&net.id(0)), now()).expect("its issuer's stamp");
    let nonce = block["nonce"].as_str().unwrap();
    assert!(key.starts_with(&format!("{}|", nonce)));
    // The same message (a wallet signature is randomized: the retry carries the one the app made).
    let same_as = |dc: &str| {
        let mut r = bind(&w, &pp, seq, block.clone(), Some(("dc_token", dc)));
        r.delegation_cert = req.delegation_cert.clone();
        r
    };
    assert_eq!(device_answer_key(&same_as("t"), Some(&net.id(0)), now()), Some(key.clone()), "the same message: the same answer");
    let other = device_answer_key(&same_as("u"), Some(&net.id(0)), now()).unwrap();
    assert_ne!(other, key, "another body under the same nonce is answered on its own");
    assert!(device_answer_key(&req, Some(&net.id(1)), now()).is_none(), "another issuer's stamp: neither looked up nor kept");
    assert!(device_answer_key(&req, None, now()).is_none(), "a node not serving the device layer");
    let mut forged = block.clone();
    forged["stamp"] = json!("v1.1800000600.00000000000000000000000000000000");
    assert!(device_answer_key(&bind(&w, &pp, seq, forged, None), Some(&net.id(0)), now()).is_none());
    let mut plain = bind(&w, &pp, seq, json!({}), None);
    plain.device = None;
    assert!(device_answer_key(&plain, Some(&net.id(0)), now()).is_none());
    assert!(transient_answer(&Refusal::RateLimited.to_json()));
    assert!(transient_answer(&StepRefusal::device(DeviceReason::Stale).to_json()));
    assert!(transient_answer(&DeviceRefusal::retry(DeviceReason::RateLimited, 60).to_json()));
    assert!(!transient_answer(&StepRefusal::device(DeviceReason::KeyInUse).to_json()));
    assert!(!transient_answer(&StepRefusal::Binding(Refusal::StaleSeq).to_json()));
    assert!(!transient_answer(&json!({ "success": true, "bound": true })));
}

#[path = "light_device_flow_tests.rs"]
mod flow;

/// No vendor token, attestation object, assertion, chain, raw device key or signature reaches a log line of
/// the device layer: every `println!` there formats only ids, codes, counts and references.
#[test]
fn tokens_and_device_evidence_never_reach_a_log_line() {
    let sources = [
        ("light_device/mod.rs", include_str!("../light_device/mod.rs")),
        ("light_device/evidence.rs", include_str!("../light_device/evidence.rs")),
        ("light_device/attest.rs", include_str!("../light_device/attest.rs")),
        ("light_device/oracle.rs", include_str!("../light_device/oracle.rs")),
        ("light_device/store.rs", include_str!("../light_device/store.rs")),
        ("light_device/statement.rs", include_str!("../light_device/statement.rs")),
        ("light_device/record.rs", include_str!("../light_device/record.rs")),
        ("light_device/stamp.rs", include_str!("../light_device/stamp.rs")),
        ("light_device/ping.rs", include_str!("../light_device/ping.rs")),
        ("light_device/crl.rs", include_str!("../light_device/crl.rs")),
        ("light_device/monitor.rs", include_str!("../light_device/monitor.rs")),
        ("rpc/light_device.rs", include_str!("light_device.rs")),
        ("rpc/light_status.rs", include_str!("light_status.rs")),
        ("rpc/light_bind.rs", include_str!("light_bind.rs")),
        ("rpc/light_unbind.rs", include_str!("light_unbind.rs")),
        ("node/device.rs", include_str!("../node/device.rs")),
    ];
    const FORBIDDEN: [&str; 14] = ["token", "attestation", "assertion", "chain", "hw_pub", "evidence", "report", "sig",
                                   "stamp", "body", "device_tag", "receipt", "raw", "jws"];
    let mut calls = 0;
    for (name, src) in sources {
        let src = src.split("#[cfg(test)]").next().unwrap();
        let mut rest = src;
        while let Some(i) = rest.find("println!(") {
            let call = &rest[i + "println!(".len()..];
            let mut depth = 1usize;
            let end = call.char_indices().find(|(_, c)| {
                match c { '(' => depth += 1, ')' => depth -= 1, _ => {} }
                depth == 0
            }).map(|(j, _)| j).unwrap_or(call.len());
            let args = &call[..end];
            // The format string names fields; only what follows it is formatted.
            let after_format = args.find("\",").map(|j| &args[j + 2..]).unwrap_or("");
            for word in FORBIDDEN {
                let formatted = after_format.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .any(|ident| ident == word || ident.starts_with(&format!("{}_", word)) || ident.ends_with(&format!("_{}", word)));
                assert!(!formatted, "{name}: a log line formats `{word}`: println!({args})");
            }
            calls += 1;
            rest = &call[end..];
        }
    }
    assert!(calls > 10, "the scan saw the device layer's log lines ({calls})");
}

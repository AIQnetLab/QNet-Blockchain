//! Test fixtures: a scripted vendor side, device keys, device messages and receipts. Nothing here reaches
//! a network. Receipt signatures are the shared verifier's concern and are tested there; here a receipt is
//! a handle whose verified fields the test chose.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use crate::alerts::Alerts;
use crate::config::Quota;
use crate::evidence::Sealer;
use crate::gates::Gates;
use crate::lease::{GenSource, Params};
use crate::limits::LimitParams;
use crate::messages::*;
use crate::service::{Oracle, Settings, Vendors};
use crate::signer::Signer;
use crate::store::Store;
use crate::types::Network;
use crate::upstream::appattest::{AppAttestData, ReceiptInfo, ReceiptVerifier};
use crate::upstream::devicecheck::DeviceCheck;
use crate::upstream::fake::{test_jwt, FakeHttp};
use crate::upstream::jwt::ServiceAccount;
use crate::upstream::playintegrity::tests::{policy, verdict_json, TokenMaker};
use crate::upstream::playintegrity::PlayIntegrity;

pub const T0: u64 = 1_790_000_000;
pub const WALLET: &str = "d9fa370374e24333242eon847d1d354dcd87fe873823e";
pub const PP: &str = "e3c8347558136174f62d15b004435df2eaedd49c05f7f0d027b35c33216a1d1c";
pub const APP_ID: &str = "TEAM123456.com.qnetmobile";
pub const STORE_DIGEST: [u8; 32] = [0x11; 32];

// ---- device keys ----

pub struct DeviceKey {
    pub public: Vec<u8>,
}

impl DeviceKey {
    pub fn new() -> Self {
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &SystemRandom::new()).unwrap();
        let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, doc.as_ref()).unwrap();
        DeviceKey { public: kp.public_key().as_ref().to_vec() }
    }
    pub fn hex(&self) -> String {
        hex::encode(&self.public)
    }
    pub fn key_hash(&self) -> String {
        hex::encode(sha3_256(&self.public))
    }
}

// ---- receipts ----

/// Receipts by handle: `register` returns the bytes a test passes where a receipt goes.
#[derive(Default)]
pub struct FakeReceipts {
    map: Mutex<HashMap<Vec<u8>, ReceiptInfo>>,
}

impl FakeReceipts {
    pub fn register(&self, info: ReceiptInfo) -> Vec<u8> {
        let mut m = self.map.lock();
        let handle = format!("receipt-{}", m.len()).into_bytes();
        m.insert(handle.clone(), info);
        handle
    }
}

impl ReceiptVerifier for FakeReceipts {
    fn verify(&self, der: &[u8], _now: u64) -> Result<ReceiptInfo, String> {
        self.map.lock().get(der).cloned().ok_or_else(|| "receipt: signature does not verify".into())
    }
}

// ---- device messages ----

pub fn node(n: u64) -> String {
    format!("light_mobile_{:016x}", n)
}

pub fn fresh_nonce() -> String {
    let mut b = [0u8; 32];
    aws_lc_rs::rand::fill(&mut b).unwrap();
    b64url(&b)
}

pub fn enrol_ios(n: &str) -> String {
    format!("qnet_dev_enrol:v1|1337|{}|{}|{}|1790000000|{}|mac=0,vision=0,idiom=phone", n, WALLET, PP, fresh_nonce())
}

pub const REPORT: &str = r#"{"arc":false,"automotive":false,"embedded":false,"feature_pc":false,"hsum":false,"leanback":false,"system_user":true,"touchscreen":true,"watch":false}"#;

pub fn enrol_android(n: &str) -> String {
    format!(
        "qnet_dev_enrol:v1|1337|{}|{}|{}|1790000000|{}|r={}",
        n,
        WALLET,
        PP,
        fresh_nonce(),
        hex::encode(sha3_256(REPORT.as_bytes()))
    )
}

pub fn refresh_msg(n: &str) -> String {
    format!("qnet_dev_refresh:v1|1337|{}|{}", n, fresh_nonce())
}

pub fn release_msg(n: &str) -> String {
    format!("qnet_dev_release:v1|1337|{}|1790000000|{}", n, fresh_nonce())
}

pub fn rotate_msg(n: &str, old_key: &str) -> String {
    format!("qnet_dev_rotate:v1|1337|{}|{}|{}|1790000000|{}", n, old_key, PP, fresh_nonce())
}

pub fn rebind_msg(from: &str, to: &str) -> String {
    format!("qnet_dev_rebind:v1|1337|{}|{}|1790086400|{}", from, to, fresh_nonce())
}

pub fn dc_bits(g: u8) -> Vec<u8> {
    if g == 0 {
        b"Bit State Not Found".to_vec()
    } else {
        serde_json::json!({"bit0": g & 1 == 1, "bit1": g & 2 == 2, "last_update_time": "2026-09"}).to_string().into_bytes()
    }
}

// ---- the harness ----

/// Generations handed out in order; falls back to the smallest allowed value.
pub struct Scripted(pub Arc<Mutex<VecDeque<u8>>>);

impl GenSource for Scripted {
    fn pick(&mut self, exclude: u8) -> u8 {
        let mut q = self.0.lock();
        while let Some(g) = q.pop_front() {
            if g != exclude && (1..=3).contains(&g) {
                return g;
            }
        }
        (1..=3).find(|&g| g != exclude).unwrap()
    }
}

pub struct Opts {
    pub network: Network,
    pub enforce: bool,
    pub test_digests: Vec<[u8; 32]>,
    pub bad_tokens_hourly: u64,
    pub background_tokens: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { network: Network::Testnet, enforce: false, test_digests: vec![], bad_tokens_hourly: 100, background_tokens: true }
    }
}

pub struct H {
    pub o: Oracle,
    pub http: Arc<FakeHttp>,
    pub clock: Arc<AtomicU64>,
    pub gens: Arc<Mutex<VecDeque<u8>>>,
    pub tm: TokenMaker,
    pub receipts: Arc<FakeReceipts>,
    pub _dir: tempfile::TempDir,
}

fn service_account_json() -> &'static str {
    static SA: OnceLock<String> = OnceLock::new();
    SA.get_or_init(|| {
        use aws_lc_rs::encoding::AsDer;
        let rsa = aws_lc_rs::rsa::KeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).unwrap();
        let der: aws_lc_rs::encoding::Pkcs8V1Der = rsa.as_der().unwrap();
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", b64_encode(der.as_ref()));
        serde_json::json!({"client_email": "oracle@test.iam", "token_uri": "https://auth.test/token",
                           "private_key_id": "k1", "private_key": pem})
        .to_string()
    })
}

impl H {
    pub fn new(opts: Opts) -> H {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.sticky("dc.test/v1/update_two_bits", 200, b"");
        http.sticky("auth.test/token", 200, br#"{"access_token":"AT","expires_in":3600}"#);
        http.sticky("pi.test/v1/io.aiqnet.wallet/deviceRecall:write", 200, b"{}");
        let clock = Arc::new(AtomicU64::new(T0));
        let gens = Arc::new(Mutex::new(VecDeque::new()));
        let tm = TokenMaker::new();
        let receipts = Arc::new(FakeReceipts::default());
        let jwt = test_jwt();
        let allow_test = opts.network == Network::Testnet;
        let vendors = Vendors {
            devicecheck: Some(DeviceCheck::new(http.clone(), jwt.clone(), "https://dc.test", "https://dcdev.test")),
            appattest: Some(AppAttestData::new(
                http.clone(),
                jwt,
                "https://aa.test",
                "https://aadev.test",
                APP_ID,
                receipts.clone(),
            )),
            play: Some(
                PlayIntegrity::new(
                    http.clone(),
                    tm.decrypt_key.clone(),
                    &tm.spki,
                    policy(opts.test_digests.clone(), allow_test),
                    "https://pi.test",
                    Some(ServiceAccount::from_json(service_account_json()).unwrap()),
                )
                .unwrap(),
            ),
            http: http.clone(),
        };
        let settings = Settings {
            network: opts.network,
            chain_id: "1337".into(),
            quota: Quota { play_daily: 10_000, bad_tokens_hourly: opts.bad_tokens_hourly },
            crl_url: "https://crl.test/attestation/status".into(),
            log_keep: 7 * 86_400,
        };
        let gates = Gates { enforce: opts.enforce, ..Gates::default() };
        let c = clock.clone();
        let o = Oracle::new(
            settings,
            Params::new(opts.background_tokens),
            gates,
            LimitParams::default(),
            Arc::new(Store::open(dir.path()).unwrap()),
            Signer::generate(),
            Sealer::from_bytes(&[9u8; 32]).unwrap(),
            vendors,
            Arc::new(Alerts::new(None, None, None, 0, "test".into())),
        )
        .with_clock(Box::new(move || c.load(Ordering::SeqCst)))
        .with_gen(Box::new(Scripted(gens.clone())));
        H { o, http, clock, gens, tm, receipts, _dir: dir }
    }

    pub fn at(&self, t: u64) {
        self.clock.store(t, Ordering::SeqCst);
    }

    pub fn now(&self) -> u64 {
        self.clock.load(Ordering::SeqCst)
    }

    pub fn gens(&self, v: &[u8]) {
        self.gens.lock().extend(v.iter().copied());
    }

    /// A receipt for `key` (base64 of its handle): an attestation receipt, or a metric receipt.
    pub fn receipt(&self, key: &DeviceKey, attest: bool, created: u64, metric: Option<u32>, not_before: Option<u64>) -> String {
        b64_encode(&self.receipts.register(ReceiptInfo {
            app_id: APP_ID.into(),
            public_key: key.public.clone(),
            attest,
            created_at: created,
            metric,
            not_before,
            expires_at: Some(created + 90 * 86_400),
        }))
    }

    /// A Play token for `nonce`; `edit` adjusts the verdict.
    pub fn pi_token(&self, nonce: &str, recall: Option<(bool, bool, bool)>, edit: impl FnOnce(&mut Value)) -> String {
        let mut v = verdict_json(nonce, self.now() * 1000, recall);
        v["appIntegrity"]["certificateSha256Digest"] = serde_json::json!([b64url(&STORE_DIGEST)]);
        edit(&mut v);
        self.tm.token(&v)
    }

    pub fn ios_claim(&self, n: &str, key: &DeviceKey, token: &str) -> crate::api::ClaimRequest {
        serde_json::from_value(serde_json::json!({
            "node_id": n, "platform": "ios", "op": "enrol", "preimage": enrol_ios(n), "hw_pub": key.hex(),
            "prov": "na", "trust": "store", "dc_token": token,
        }))
        .unwrap()
    }

    pub fn android_claim(
        &self,
        n: &str,
        key: &DeviceKey,
        recall: Option<(bool, bool, bool)>,
        edit: impl FnOnce(&mut Value),
    ) -> crate::api::ClaimRequest {
        let pre = enrol_android(n);
        let nonce = play_nonce_enrol(&pre, &key.public, &sha3_256(REPORT.as_bytes()));
        let token = self.pi_token(&nonce, recall, edit);
        serde_json::from_value(serde_json::json!({
            "node_id": n, "platform": "android", "op": "enrol", "preimage": pre, "hw_pub": key.hex(),
            "prov": "rkp", "trust": "store", "pi_token": token, "att_key": "aa".repeat(32),
        }))
        .unwrap()
    }

    pub fn android_refresh(&self, n: &str, recall: Option<(bool, bool, bool)>, edit: impl FnOnce(&mut Value)) -> crate::api::RefreshRequest {
        let pre = refresh_msg(n);
        let token = self.pi_token(&play_nonce(&pre), recall, edit);
        serde_json::from_value(serde_json::json!({"node_id": n, "preimage": pre, "pi_token": token})).unwrap()
    }

    pub fn ios_refresh(&self, n: &str, token: &str) -> crate::api::RefreshRequest {
        serde_json::from_value(serde_json::json!({"node_id": n, "preimage": refresh_msg(n), "dc_token": token})).unwrap()
    }

    /// The bits of the last recall write the oracle made.
    pub fn last_recall_write(&self) -> Option<(bool, bool, bool)> {
        let seen = self.http.seen.lock();
        let r = seen.iter().rev().find(|r| r.url.contains("deviceRecall:write"))?;
        let v: Value = serde_json::from_slice(&r.body).ok()?;
        let nv = &v["newValues"];
        Some((nv["bitFirst"].as_bool()?, nv["bitSecond"].as_bool()?, nv["bitThird"].as_bool()?))
    }

    pub fn last_dc_write(&self) -> Option<u8> {
        let seen = self.http.seen.lock();
        let r = seen.iter().rev().find(|r| r.url.contains("update_two_bits"))?;
        let v: Value = serde_json::from_slice(&r.body).ok()?;
        Some(v["bit0"].as_bool()? as u8 | (v["bit1"].as_bool()? as u8) << 1)
    }
}

pub fn recall_of(g: u8, hold: bool) -> Option<(bool, bool, bool)> {
    Some((g & 1 == 1, g & 2 == 2, hold))
}

pub fn g_of(w: (bool, bool, bool)) -> u8 {
    w.0 as u8 | (w.1 as u8) << 1
}

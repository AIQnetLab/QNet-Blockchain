//! Play Integrity classic tokens: local decryption with our developer-managed keys, and device recall
//! writes (the Android carrier of the device slot).
//!
//! A classic token is an encrypted envelope (AES key wrap + AES-GCM) around a verdict Google signed with
//! ES256. The oracle opens the envelope; the signed verdict inside is checked by `qnet-device-attest`
//! under the same rules the genesis attestors apply, and goes back to them as evidence.

use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use aws_lc_rs::key_wrap::{AesKek, KeyWrap, AES_256};
use parking_lot::Mutex;
use qnet_device_attest::play::{verify_verdict, PlayPolicy, PlayVerdict};
use qnet_device_attest::{DevicePublicKey, Refusal};
use serde_json::Value;
use std::sync::Arc;

use super::jwt::ServiceAccount;
use super::{classify_status, HttpClient, HttpRequest, Method, VendorError};
use crate::lease::SlotWrite;
use crate::messages::b64url_decode_lenient;

pub const PLAY_SCOPE: &str = "https://www.googleapis.com/auth/playintegrity";
const MAX_TOKEN: usize = 32 * 1024;

/// Opens a classic token to the signed verdict it carries (compact form).
pub fn jwe_decrypt(token: &str, key: &[u8]) -> Result<String, String> {
    if token.len() > MAX_TOKEN {
        return Err("token too long".into());
    }
    let parts: Vec<&str> = token.trim().split('.').collect();
    if parts.len() != 5 {
        return Err("token is not an encrypted envelope".into());
    }
    let header: Value = serde_json::from_slice(&b64url_decode_lenient(parts[0]).ok_or("envelope header")?)
        .map_err(|_| "envelope header is not JSON")?;
    if header.get("alg").and_then(Value::as_str) != Some("A256KW")
        || header.get("enc").and_then(Value::as_str) != Some("A256GCM")
    {
        return Err("unexpected envelope algorithms".into());
    }
    let wrapped = b64url_decode_lenient(parts[1]).ok_or("envelope key")?;
    let iv = b64url_decode_lenient(parts[2]).ok_or("envelope iv")?;
    let ct = b64url_decode_lenient(parts[3]).ok_or("envelope ciphertext")?;
    let tag = b64url_decode_lenient(parts[4]).ok_or("envelope tag")?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err("envelope iv or tag length".into());
    }
    let kek = AesKek::new(&AES_256, key).map_err(|_| "decryption key must be 32 bytes")?;
    let mut cek_buf = [0u8; 40];
    let cek = kek.unwrap(&wrapped, &mut cek_buf).map_err(|_| "envelope key does not unwrap")?;
    let aead = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, cek).map_err(|_| "content key length")?);
    let mut in_out = ct;
    in_out.extend_from_slice(&tag);
    let nonce = Nonce::try_assume_unique_for_key(&iv).map_err(|_| "envelope iv")?;
    let plain = aead
        .open_in_place(nonce, Aad::from(parts[0].as_bytes()), &mut in_out)
        .map_err(|_| "envelope does not decrypt")?;
    String::from_utf8(plain.to_vec()).map_err(|_| "signed verdict is not text".into())
}

/// Why a token was not usable.
#[derive(Debug)]
pub enum PiError {
    /// The envelope did not open with our key: not a token of our app, or corrupted.
    Envelope(String),
    /// The signed verdict inside was refused.
    Verdict(Refusal),
}

/// A refusal that says the token is not bound to this request (replayed, borrowed, stale), as opposed
/// to a verdict about the device.
pub fn unbound(r: &Refusal) -> bool {
    matches!(
        r,
        Refusal::ChallengeMismatch
            | Refusal::VerdictStale
            | Refusal::Malformed(_)
            | Refusal::SignatureInvalid
            | Refusal::UnsupportedAlgorithm
    )
}

/// A decoded token: the signed verdict (for the attestors), its payload digest and the checked fields.
pub struct Decoded {
    pub jws: String,
    pub pi_digest: String,
    pub verdict: PlayVerdict,
}

pub struct PlayIntegrity {
    http: Arc<dyn HttpClient>,
    decrypt_key: Vec<u8>,
    verify_key: DevicePublicKey,
    pub policy: PlayPolicy,
    base_url: String,
    account: Option<ServiceAccount>,
    token: Mutex<Option<(u64, String)>>,
}

impl PlayIntegrity {
    /// `verify_spki`: the verification key from the Play Console (DER SubjectPublicKeyInfo).
    pub fn new(
        http: Arc<dyn HttpClient>,
        decrypt_key: Vec<u8>,
        verify_spki: &[u8],
        policy: PlayPolicy,
        base_url: &str,
        account: Option<ServiceAccount>,
    ) -> Result<Self, String> {
        if decrypt_key.len() != 32 {
            return Err("the Play decryption key must be 32 bytes".into());
        }
        let verify_key = DevicePublicKey::from_spki_der(verify_spki)
            .map_err(|e| format!("the Play verification key must be a P-256 public key: {}", e))?;
        Ok(PlayIntegrity {
            http,
            decrypt_key,
            verify_key,
            policy,
            base_url: base_url.trim_end_matches('/').to_string(),
            account,
            token: Mutex::new(None),
        })
    }

    /// Opens and checks a token for `expected_nonce` (the digest the app's nonce encodes).
    pub fn decode(&self, token: &str, expected_nonce: &[u8], now_ms: u64) -> Result<Decoded, PiError> {
        let jws = jwe_decrypt(token, &self.decrypt_key).map_err(PiError::Envelope)?;
        let verdict =
            verify_verdict(&jws, &self.verify_key, expected_nonce, &self.policy, now_ms).map_err(PiError::Verdict)?;
        Ok(Decoded { pi_digest: hex::encode(verdict.payload_digest), jws, verdict })
    }

    fn access_token(&self, now: u64) -> Result<String, VendorError> {
        let mut c = self.token.lock();
        if let Some((exp, t)) = c.as_ref() {
            if now + 300 < *exp {
                return Ok(t.clone());
            }
        }
        let sa = self.account.as_ref().ok_or_else(|| VendorError::Config("no service account configured".into()))?;
        let assertion = sa.assertion(PLAY_SCOPE, now).map_err(VendorError::Config)?;
        let body = format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={}", assertion);
        let req = HttpRequest {
            method: Method::Post,
            url: sa.token_uri.clone(),
            headers: vec![("content-type", "application/x-www-form-urlencoded".into())],
            body: body.into_bytes(),
        };
        let resp = self.http.send(&req).map_err(|e| VendorError::Unavailable(format!("google auth {}", e)))?;
        if resp.status != 200 {
            return Err(match classify_status(resp.status, "google auth") {
                VendorError::Rejected(m) => VendorError::Config(m),
                other => other,
            });
        }
        let v: Value =
            serde_json::from_slice(&resp.body).map_err(|_| VendorError::Unavailable("google auth answer".into()))?;
        let t = v
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| VendorError::Unavailable("google auth token".into()))?;
        let exp = now + v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        *c = Some((exp, t.to_string()));
        Ok(t.to_string())
    }

    /// Writes the three recall bits with the device's integrity token.
    pub fn write_recall(&self, token: &str, w: SlotWrite, now: u64) -> Result<(), VendorError> {
        let access = self.access_token(now)?;
        let (b0, b1) = w.bits();
        let body = serde_json::json!({
            "integrityToken": token,
            "newValues": {"bitFirst": b0, "bitSecond": b1, "bitThird": w.hold},
        });
        let req = HttpRequest {
            method: Method::Post,
            url: format!("{}/v1/{}/deviceRecall:write", self.base_url, self.policy.package),
            headers: vec![("authorization", format!("Bearer {}", access)), ("content-type", "application/json".into())],
            body: body.to_string().into_bytes(),
        };
        let resp = self.http.send(&req).map_err(|e| VendorError::Unavailable(format!("recall {}", e)))?;
        if resp.status == 200 {
            return Ok(());
        }
        if resp.status == 401 {
            *self.token.lock() = None;
        }
        Err(classify_status(resp.status, "recall"))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::messages::b64url;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    pub const PACKAGE: &str = "io.aiqnet.wallet";

    /// Builds classic tokens the way Google does, with test keys.
    pub struct TokenMaker {
        pub decrypt_key: Vec<u8>,
        sign: EcdsaKeyPair,
        pub spki: Vec<u8>,
    }

    impl TokenMaker {
        pub fn new() -> Self {
            let rng = SystemRandom::new();
            let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            let sign = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref()).unwrap();
            let mut decrypt_key = vec![0u8; 32];
            aws_lc_rs::rand::fill(&mut decrypt_key).unwrap();
            // SubjectPublicKeyInfo of a P-256 point: fixed prefix plus the 65-byte point.
            let mut spki = hex::decode("3059301306072a8648ce3d020106082a8648ce3d030107034200").unwrap();
            spki.extend_from_slice(sign.public_key().as_ref());
            TokenMaker { decrypt_key, sign, spki }
        }

        pub fn token(&self, payload: &Value) -> String {
            let h = b64url(br#"{"alg":"ES256"}"#);
            let p = b64url(payload.to_string().as_bytes());
            let input = format!("{}.{}", h, p);
            let sig = self.sign.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
            let jws = format!("{}.{}", input, b64url(sig.as_ref()));
            let mut cek = [0u8; 32];
            aws_lc_rs::rand::fill(&mut cek).unwrap();
            let mut out = [0u8; 40];
            let wrapped = AesKek::new(&AES_256, &self.decrypt_key).unwrap().wrap(&cek, &mut out).unwrap().to_vec();
            let mut iv = [0u8; 12];
            aws_lc_rs::rand::fill(&mut iv).unwrap();
            let eh = b64url(br#"{"alg":"A256KW","enc":"A256GCM"}"#);
            let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &cek).unwrap());
            let mut buf = jws.into_bytes();
            let tag = key
                .seal_in_place_separate_tag(Nonce::assume_unique_for_key(iv), Aad::from(eh.as_bytes()), &mut buf)
                .unwrap();
            format!("{}.{}.{}.{}.{}", eh, b64url(&wrapped), b64url(&iv), b64url(&buf), b64url(tag.as_ref()))
        }
    }

    /// A store verdict of a licensed phone for `nonce` (the b64url text the app sends).
    pub fn verdict_json(nonce: &str, ts_ms: u64, recall: Option<(bool, bool, bool)>) -> Value {
        let mut di = serde_json::json!({
            "deviceRecognitionVerdict": ["MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"],
            "recentDeviceActivity": {"deviceActivityLevel": "LEVEL_1"},
        });
        if let Some((a, b, c)) = recall {
            di["deviceRecall"] = serde_json::json!({
                "values": {"bitFirst": a, "bitSecond": b, "bitThird": c},
                "writeDates": {"yyyymmFirst": 202609, "yyyymmSecond": 202609, "yyyymmThird": 202609},
            });
        }
        serde_json::json!({
            "requestDetails": {"requestPackageName": PACKAGE, "timestampMillis": ts_ms.to_string(), "nonce": nonce},
            "appIntegrity": {
                "appRecognitionVerdict": "PLAY_RECOGNIZED", "packageName": PACKAGE,
                "certificateSha256Digest": [b64url(&[0x11; 32])], "versionCode": "20",
            },
            "deviceIntegrity": di,
            "accountDetails": {"appLicensingVerdict": "LICENSED"},
            "environmentDetails": {"appAccessRiskVerdict": {"appsDetected": ["KNOWN_INSTALLED"]}},
        })
    }

    pub fn policy(test_digests: Vec<[u8; 32]>, allow_test: bool) -> PlayPolicy {
        PlayPolicy {
            package: PACKAGE.to_string(),
            store_cert_digests: vec![[0x11; 32]],
            test_cert_digests: test_digests,
            allow_test,
            ..PlayPolicy::mainnet()
        }
    }

    fn pi(m: &TokenMaker, http: Arc<crate::upstream::fake::FakeHttp>, account: Option<ServiceAccount>) -> PlayIntegrity {
        PlayIntegrity::new(http, m.decrypt_key.clone(), &m.spki, policy(vec![], false), "https://pi.test", account).unwrap()
    }

    #[test]
    fn a_token_opens_and_its_verdict_is_checked_by_the_shared_rules() {
        let m = TokenMaker::new();
        let nonce = [7u8; 32];
        let now_ms = 1_790_000_000_000;
        let v = verdict_json(&b64url(&nonce), now_ms, Some((true, false, false)));
        let p = pi(&m, Arc::new(crate::upstream::fake::FakeHttp::default()), None);
        let d = p.decode(&m.token(&v), &nonce, now_ms).unwrap();
        assert_eq!(d.verdict.activity_level, Some(1));
        let recall = d.verdict.device_recall.unwrap();
        assert!(recall.first && !recall.second && !recall.third);
        assert_eq!(recall.written_third, Some(202609));
        let payload = b64url_decode_lenient(d.jws.split('.').nth(1).unwrap()).unwrap();
        assert_eq!(d.pi_digest, hex::encode(crate::messages::sha256(&payload)));
        match p.decode(&m.token(&v), &[8u8; 32], now_ms) {
            Err(PiError::Verdict(r)) => assert!(unbound(&r)),
            _ => panic!("a foreign nonce must be refused"),
        }
    }

    #[test]
    fn a_token_under_other_keys_is_refused() {
        let a = TokenMaker::new();
        let b = TokenMaker::new();
        let t = a.token(&verdict_json("n", 1, None));
        assert!(jwe_decrypt(&t, &b.decrypt_key).is_err());
        assert!(jwe_decrypt("a.b.c", &a.decrypt_key).is_err());
        let wrong_signer = PlayIntegrity::new(
            Arc::new(crate::upstream::fake::FakeHttp::default()),
            a.decrypt_key.clone(),
            &b.spki,
            policy(vec![], false),
            "https://pi.test",
            None,
        )
        .unwrap();
        assert!(matches!(wrong_signer.decode(&t, b"n", 1), Err(PiError::Verdict(Refusal::SignatureInvalid))));
    }

    #[test]
    fn recall_write_uses_a_cached_access_token() {
        use aws_lc_rs::encoding::AsDer;
        let http = Arc::new(crate::upstream::fake::FakeHttp::default());
        let rsa = aws_lc_rs::rsa::KeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).unwrap();
        let der: aws_lc_rs::encoding::Pkcs8V1Der = rsa.as_der().unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            crate::messages::b64_encode(der.as_ref())
        );
        let sa_json = serde_json::json!({
            "client_email": "oracle@example.iam", "token_uri": "https://auth.test/token",
            "private_key_id": "k1", "private_key": pem,
        });
        let sa = ServiceAccount::from_json(&sa_json.to_string()).unwrap();
        let m = TokenMaker::new();
        let p = pi(&m, http.clone(), Some(sa));
        http.push("auth.test/token", 200, br#"{"access_token":"AT","expires_in":3600}"#);
        http.push("pi.test/v1/io.aiqnet.wallet/deviceRecall:write", 200, b"{}");
        http.push("pi.test/v1/io.aiqnet.wallet/deviceRecall:write", 503, b"");
        p.write_recall("TOKEN", SlotWrite { g: 2, hold: true }, 100).unwrap();
        assert!(matches!(p.write_recall("TOKEN", SlotWrite { g: 1, hold: false }, 200), Err(VendorError::Unavailable(_))));
        let seen = http.seen.lock();
        assert_eq!(seen.len(), 3, "the access token is fetched once");
        let body: Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(body["newValues"], serde_json::json!({"bitFirst": false, "bitSecond": true, "bitThird": true}));
        assert!(seen[1].headers.iter().any(|(k, v)| *k == "authorization" && v == "Bearer AT"));
    }
}

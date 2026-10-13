//! Short-lived public-CA certificates for the wallet plane, issued and renewed by the node itself.
//!
//! An RFC 8555 subset (directory, nonces, ES256 JWS, account, order with the `shortlived` profile and
//! `replaces`, tls-alpn-01 for an IP identifier, finalize, download) plus renewal information
//! (RFC 9773). The `shortlived` profile is the only one the CA issues for IP identifiers: about
//! 160 h, renewed in the CA's suggested window (about 80 h), so every renewal re-proves that 443
//! reaches this node.
//!
//! Pacing keeps up to 100k nodes far inside the CA's limits: one account per node, created only after
//! the 443 probe passes; the first order delayed by a uniform 0-6 h; failures backed off
//! 15 min -> 1 h -> 6 h -> 24 h (never below the CA's `Retry-After`); at most 3 failed authorizations
//! per identifier per rolling hour; renewals carry `replaces`, which exempts them from the CA's limits
//! while the replaced certificate shares the identifier and was not replaced before (a renewal without
//! it still counts against the failure and exact-set limits). The CA's pause after consecutive
//! failures is never reached: the backoff tops out at one attempt a day.
//! The schedule is persisted, each attempt as a failure before its first request (replaced by its
//! outcome), so a restart loop, even one that kills the process mid-attempt, never re-asks early.
//! Nothing here blocks boot or consensus.

use super::*;
use super::wallet_plane::{certified_key, CertStore, Installed};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use rand::Rng;
use ring::signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_FIXED_SIGNING};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The production directory of the public CA the genesis names' certificates come from. A compiled
/// constant: tests build the client against a local test CA through `CertManager::open_with`.
pub(crate) const ACME_DIRECTORY_URL: &str = "https://acme-v02.api.letsencrypt.org/directory";
/// The only profile the CA issues for IP identifiers.
pub(crate) const PROFILE: &str = "shortlived";
/// Failure backoff ladder, seconds.
pub(crate) const BACKOFF_SECS: [u64; 4] = [15 * 60, 3600, 6 * 3600, 24 * 3600];
/// Failed authorizations per identifier per rolling hour (the CA allows 5).
pub(crate) const AUTHZ_FAILURES_PER_HOUR: usize = 3;
/// The first-ever order waits a uniform random delay up to this, so a published image or genesis
/// starting to answer the probe never sends every node to the CA at once.
pub(crate) const FIRST_ORDER_JITTER_SECS: u64 = 6 * 3600;
/// A negative 443 probe is retried after this, plus or minus `PRECHECK_RETRY_JITTER_SECS` drawn each
/// time, so nodes that probed together do not come back together.
pub(crate) const PRECHECK_RETRY_SECS: u64 = 6 * 3600;
pub(crate) const PRECHECK_RETRY_JITTER_SECS: u64 = 3600;
/// A probe no genesis could answer (busy, rate-limited, unreachable) is retried after a uniform wait
/// between half of and the whole step, the step growing while it lasts: minutes, not a 6 h verdict.
pub(crate) const PRECHECK_BUSY_SECS: [u64; 4] = [10 * 60, 30 * 60, 2 * 3600, 6 * 3600];
/// A positive probe licenses orders for this long; a new issuance after it probes again.
pub(crate) const PRECHECK_VALID_SECS: u64 = 3600;
/// Renewal-information polls: per the CA's Retry-After, clamped to 1-12 h (at least twice a day).
pub(crate) const ARI_POLL_MIN_SECS: u64 = 3600;
pub(crate) const ARI_POLL_MAX_SECS: u64 = 12 * 3600;
const ARI_POLL_DEFAULT_SECS: u64 = 6 * 3600;
/// Without renewal information: renew at half the lifetime, +- this jitter.
pub(crate) const HALF_LIFE_JITTER_SECS: i64 = 3600;
/// `cert_expiring` is logged below this.
pub(crate) const EXPIRING_WARN_SECS: u64 = 24 * 3600;
/// A pending authorization lives 1 h at the CA; the challenge certificate stays armed no longer.
const CHALLENGE_ARM_TTL: Duration = Duration::from_secs(3600);
/// How long one authorization or order is polled before the attempt counts as failed.
const POLL_LIMIT: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const ERR_PREFIX: &str = "urn:ietf:params:acme:error:";

const ACCOUNT_KEY_FILE: &str = "account.key";
const ACCOUNT_URL_FILE: &str = "account.url";
const CERT_FILE: &str = "cert.pem";
const CERT_KEY_FILE: &str = "cert.key";
const STATE_FILE: &str = "acme_state.json";

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────

/// Where an issuance failed, as `acme_failed stage=` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stage {
    Precheck,
    Account,
    Order,
    Challenge,
    Finalize,
    Download,
    Verify,
}

impl Stage {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Stage::Precheck => "precheck",
            Stage::Account => "account",
            Stage::Order => "order",
            Stage::Challenge => "challenge",
            Stage::Finalize => "finalize",
            Stage::Download => "download",
            Stage::Verify => "verify",
        }
    }
}

/// What went wrong, as the schedule needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fault {
    RateLimited,
    Unavailable,
    BadNonce,
    AlreadyReplaced,
    TermsChanged(Option<String>),
    Paused(Option<String>),
    ProfileUnavailable,
    AuthorizationInvalid(String),
    Rejected(String),
    Transport(String),
    Timeout,
    Invalid(String),
    /// Recorded before an attempt starts and replaced by its outcome: what stays on disk when the
    /// process dies mid-attempt.
    Interrupted,
}

impl Fault {
    pub(crate) fn reason(&self) -> String {
        match self {
            Fault::RateLimited => "rate_limited".into(),
            Fault::Unavailable => "unavailable".into(),
            Fault::BadNonce => "bad_nonce".into(),
            Fault::AlreadyReplaced => "already_replaced".into(),
            Fault::TermsChanged(_) => "terms_changed".into(),
            Fault::Paused(_) => "paused".into(),
            Fault::ProfileUnavailable => "profile_unavailable".into(),
            Fault::AuthorizationInvalid(d) => format!("authorization_invalid:{}", short(d)),
            Fault::Rejected(d) => format!("rejected:{}", short(d)),
            Fault::Transport(d) => format!("transport:{}", short(d)),
            Fault::Timeout => "timeout".into(),
            Fault::Invalid(d) => format!("invalid:{}", short(d)),
            Fault::Interrupted => "interrupted".into(),
        }
    }
}

/// One line of a log value: no spaces (key=value), bounded.
fn short(s: &str) -> String {
    s.chars().map(|c| if c.is_whitespace() { '_' } else { c }).take(120).collect()
}

#[derive(Debug, Clone)]
pub(crate) struct AcmeError {
    pub(crate) stage: Stage,
    pub(crate) fault: Fault,
    /// The CA's Retry-After, seconds.
    pub(crate) retry_after: Option<u64>,
}

impl AcmeError {
    fn new(stage: Stage, fault: Fault) -> Self {
        Self { stage, fault, retry_after: None }
    }
}

// ─── Account key and JWS ────────────────────────────────────────────────────────────────────────

/// The node's CA account key: P-256, ES256 in the fixed 64-byte r||s form (RFC 7518 §3.4).
pub(crate) struct AccountKey {
    pkcs8: Vec<u8>,
    pair: EcdsaKeyPair,
}

impl AccountKey {
    pub(crate) fn generate() -> Result<Self, String> {
        let rng = ring::rand::SystemRandom::new();
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).map_err(|_| "account key generation failed")?;
        Self::from_pkcs8(doc.as_ref())
    }

    pub(crate) fn from_pkcs8(der: &[u8]) -> Result<Self, String> {
        let rng = ring::rand::SystemRandom::new();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der, &rng).map_err(|e| format!("account key: {}", e))?;
        Ok(Self { pkcs8: der.to_vec(), pair })
    }

    fn xy(&self) -> (String, String) {
        let pk = self.pair.public_key().as_ref();
        (B64URL.encode(&pk[1..33]), B64URL.encode(&pk[33..65]))
    }

    fn jwk(&self) -> Value {
        let (x, y) = self.xy();
        json!({ "crv": "P-256", "kty": "EC", "x": x, "y": y })
    }

    /// The JWK thumbprint (RFC 7638): SHA-256 of the required members in lexicographic order.
    pub(crate) fn thumbprint(&self) -> String {
        use sha2::Digest as _;
        let (x, y) = self.xy();
        let canonical = format!("{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}", x, y);
        B64URL.encode(sha2::Sha256::digest(canonical.as_bytes()))
    }

    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        let rng = ring::rand::SystemRandom::new();
        self.pair.sign(&rng, data).map(|s| s.as_ref().to_vec()).map_err(|_| "es256 sign failed".to_string())
    }
}

/// The key authorization's digest a tls-alpn-01 certificate carries (RFC 8737 §3).
pub(crate) fn key_authorization_digest(token: &str, thumbprint: &str) -> [u8; 32] {
    use sha2::Digest as _;
    let mut out = [0u8; 32];
    out.copy_from_slice(&sha2::Sha256::digest(format!("{}.{}", token, thumbprint).as_bytes()));
    out
}

// ─── The challenge side ─────────────────────────────────────────────────────────────────────────

/// What answers the CA's validation handshakes: the plane's resolver in production.
pub(crate) trait ChallengeResponder: Send + Sync {
    fn arm(&self, ip: Ipv4Addr, digest: &[u8; 32], ttl: Duration) -> Result<(), String>;
    fn disarm(&self);
}

impl ChallengeResponder for CertStore {
    fn arm(&self, ip: Ipv4Addr, digest: &[u8; 32], ttl: Duration) -> Result<(), String> {
        self.arm_challenge(ip, digest, ttl)
    }
    fn disarm(&self) {
        self.disarm_challenge()
    }
}

/// The responder an attempt runs with: before the challenge is armed (and so before it is posted) it
/// adds a provisional failed authorization to the provisional state already on disk, so a process
/// that dies during validation still counts it against the per-identifier cap.
struct AttemptRecorder {
    inner: Arc<CertStore>,
    dir: PathBuf,
    state: parking_lot::Mutex<TlsState>,
    now: u64,
}

impl ChallengeResponder for AttemptRecorder {
    fn arm(&self, ip: Ipv4Addr, digest: &[u8; 32], ttl: Duration) -> Result<(), String> {
        let mut st = self.state.lock();
        st.record_authorization_failure(self.now);
        if let Err(e) = serde_json::to_vec(&*st).map_err(|e| e.to_string())
            .and_then(|b| write_private(&self.dir, STATE_FILE, &b).map_err(|e| e.to_string()))
        {
            if is_warn() {
                println!("[WARN][WALLETTLS] state_save_failed err={}", e);
            }
        }
        drop(st);
        self.inner.arm_challenge(ip, digest, ttl)
    }
    fn disarm(&self) {
        self.inner.disarm_challenge()
    }
}

struct DisarmOnDrop<'a>(&'a dyn ChallengeResponder);

impl Drop for DisarmOnDrop<'_> {
    fn drop(&mut self) {
        self.0.disarm();
    }
}

// ─── Wire client ────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct Directory {
    new_nonce: String,
    new_account: String,
    new_order: String,
    renewal_info: Option<String>,
    pub(crate) terms: Option<String>,
    pub(crate) profiles: Vec<String>,
}

struct Reply {
    status: u16,
    location: Option<String>,
    retry_after: Option<u64>,
    links: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// Retry-After as seconds: delta-seconds or an HTTP date.
pub(crate) fn parse_retry_after(v: &str, now: u64) -> Option<u64> {
    let v = v.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(secs);
    }
    chrono::DateTime::parse_from_rfc2822(v).ok().map(|t| (t.timestamp().max(0) as u64).saturating_sub(now))
}

/// `Link: <url>;rel="name"` pairs.
fn parse_links(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for v in headers.get_all(reqwest::header::LINK).iter().filter_map(|v| v.to_str().ok()) {
        for part in v.split(',') {
            let mut pieces = part.split(';');
            let url = pieces.next().unwrap_or("").trim().trim_start_matches('<').trim_end_matches('>').to_string();
            for p in pieces {
                let p = p.trim();
                if let Some(rel) = p.strip_prefix("rel=") {
                    out.push((rel.trim_matches('"').to_string(), url.clone()));
                }
            }
        }
    }
    out
}

/// The ACME client: one account, one CA.
pub(crate) struct AcmeClient {
    http: reqwest::Client,
    directory_url: String,
    dir: Option<Directory>,
    nonce: Option<String>,
    account: AccountKey,
    kid: Option<String>,
}

impl AcmeClient {
    pub(crate) fn new(directory_url: &str, account: AccountKey, kid: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(format!("qnet-node/{}", crate::node::build_id()))
            .build()
            .unwrap_or_default();
        Self { http, directory_url: directory_url.to_string(), dir: None, nonce: None, account, kid }
    }

    pub(crate) fn kid(&self) -> Option<&str> {
        self.kid.as_deref()
    }

    pub(crate) async fn directory(&mut self, stage: Stage) -> Result<Directory, AcmeError> {
        if let Some(d) = &self.dir {
            return Ok(d.clone());
        }
        let resp = self.http.get(&self.directory_url).send().await
            .map_err(|e| AcmeError::new(stage, Fault::Transport(e.to_string())))?;
        if !resp.status().is_success() {
            let fault = if resp.status().as_u16() == 503 { Fault::Unavailable } else { Fault::Rejected(format!("directory_status_{}", resp.status().as_u16())) };
            let retry_after = resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok())
                .and_then(|v| parse_retry_after(v, wallet_plane::unix_now()));
            return Err(AcmeError { stage, fault, retry_after });
        }
        let v: Value = resp.json().await.map_err(|e| AcmeError::new(stage, Fault::Transport(e.to_string())))?;
        let s = |k: &str| v[k].as_str().map(str::to_string);
        let (Some(new_nonce), Some(new_account), Some(new_order)) = (s("newNonce"), s("newAccount"), s("newOrder")) else {
            return Err(AcmeError::new(stage, Fault::Rejected("directory_incomplete".into())));
        };
        let profiles = v["meta"]["profiles"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        let dir = Directory {
            new_nonce, new_account, new_order,
            renewal_info: s("renewalInfo"),
            terms: v["meta"]["termsOfService"].as_str().map(str::to_string),
            profiles,
        };
        self.dir = Some(dir.clone());
        Ok(dir)
    }

    async fn nonce(&mut self, stage: Stage) -> Result<String, AcmeError> {
        if let Some(n) = self.nonce.take() {
            return Ok(n);
        }
        let dir = self.directory(stage).await?;
        let resp = self.http.head(&dir.new_nonce).send().await
            .map_err(|e| AcmeError::new(stage, Fault::Transport(e.to_string())))?;
        resp.headers().get("replay-nonce").and_then(|v| v.to_str().ok()).map(str::to_string)
            .ok_or_else(|| AcmeError::new(stage, Fault::Rejected("no_nonce".into())))
    }

    fn jws(&self, url: &str, nonce: &str, payload: Option<&Value>, with_jwk: bool) -> Result<Value, String> {
        let mut protected = json!({ "alg": "ES256", "nonce": nonce, "url": url });
        match (&self.kid, with_jwk) {
            (Some(kid), false) => protected["kid"] = json!(kid),
            _ => protected["jwk"] = self.account.jwk(),
        }
        let p64 = B64URL.encode(protected.to_string().as_bytes());
        // POST-as-GET carries the empty payload.
        let b64 = payload.map(|v| B64URL.encode(v.to_string().as_bytes())).unwrap_or_default();
        let sig = self.account.sign(format!("{}.{}", p64, b64).as_bytes())?;
        Ok(json!({ "protected": p64, "payload": b64, "signature": B64URL.encode(sig) }))
    }

    /// One signed POST. A `badNonce` is retried once with the nonce it carried; any other problem
    /// document becomes its typed fault, with the CA's Retry-After.
    async fn post(&mut self, stage: Stage, url: &str, payload: Option<&Value>, accept: Option<&str>) -> Result<Reply, AcmeError> {
        let with_jwk = self.kid.is_none();
        let mut retried = false;
        loop {
            let nonce = self.nonce(stage).await?;
            let body = self.jws(url, &nonce, payload, with_jwk).map_err(|e| AcmeError::new(stage, Fault::Invalid(e)))?;
            let mut req = self.http.post(url).header(reqwest::header::CONTENT_TYPE, "application/jose+json").body(body.to_string());
            if let Some(a) = accept {
                req = req.header(reqwest::header::ACCEPT, a);
            }
            let resp = req.send().await.map_err(|e| {
                AcmeError::new(stage, if e.is_timeout() { Fault::Timeout } else { Fault::Transport(e.to_string()) })
            })?;
            let (status, location, retry_after, links) = {
                let h = resp.headers();
                self.nonce = h.get("replay-nonce").and_then(|v| v.to_str().ok()).map(str::to_string);
                (
                    resp.status().as_u16(),
                    h.get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string),
                    h.get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok())
                        .and_then(|v| parse_retry_after(v, wallet_plane::unix_now())),
                    parse_links(h),
                )
            };
            let body = resp.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
            let reply = Reply { status, location, retry_after, links, body };
            if reply.status < 400 {
                return Ok(reply);
            }
            let err = problem(stage, &reply);
            if err.fault == Fault::BadNonce && !retried {
                retried = true;
                continue;
            }
            return Err(err);
        }
    }

    /// The account: reused when its URL is known, created otherwise (no contact, terms agreed: the
    /// operator was told when 443 was published). Ok(true) when this call created it.
    pub(crate) async fn ensure_account(&mut self) -> Result<bool, AcmeError> {
        if self.kid.is_some() {
            return Ok(false);
        }
        let dir = self.directory(Stage::Account).await?;
        let reply = self.post(Stage::Account, &dir.new_account, Some(&json!({ "termsOfServiceAgreed": true })), None).await?;
        let kid = reply.location.ok_or_else(|| AcmeError::new(Stage::Account, Fault::Rejected("no_account_url".into())))?;
        self.kid = Some(kid);
        if is_info() {
            println!("[INFO][WALLETTLS] account_ready tos={}", dir.terms.as_deref().unwrap_or("none"));
        }
        Ok(true)
    }

    /// Changed terms: agree again under the operator's notice, and say which terms.
    async fn agree_terms(&mut self) -> Result<(), AcmeError> {
        let Some(kid) = self.kid.clone() else { return self.ensure_account().await.map(|_| ()) };
        self.dir = None;
        let dir = self.directory(Stage::Account).await?;
        self.post(Stage::Account, &kid, Some(&json!({ "termsOfServiceAgreed": true })), None).await?;
        if is_info() {
            println!("[INFO][WALLETTLS] terms_agreed tos={}", dir.terms.as_deref().unwrap_or("none"));
        }
        Ok(())
    }

    async fn new_order(&mut self, ip: Ipv4Addr, replaces: Option<&str>) -> Result<(String, Value), AcmeError> {
        let dir = self.directory(Stage::Order).await?;
        let mut payload = json!({ "identifiers": [{ "type": "ip", "value": ip.to_string() }], "profile": PROFILE });
        if let Some(r) = replaces {
            payload["replaces"] = json!(r);
        }
        let reply = self.post(Stage::Order, &dir.new_order, Some(&payload), None).await?;
        let url = reply.location.clone().ok_or_else(|| AcmeError::new(Stage::Order, Fault::Rejected("no_order_url".into())))?;
        Ok((url, reply.json()))
    }

    /// Poll a resource (POST-as-GET) until `done` says it left its transient states, at most 60 s.
    async fn poll(&mut self, stage: Stage, url: &str, transient: &[&str]) -> Result<Value, AcmeError> {
        let started = std::time::Instant::now();
        loop {
            let reply = self.post(stage, url, None, None).await?;
            let v = reply.json();
            let status = v["status"].as_str().unwrap_or("");
            if !transient.contains(&status) {
                return Ok(v);
            }
            if started.elapsed() >= POLL_LIMIT {
                return Err(AcmeError::new(stage, Fault::Timeout));
            }
            let wait = reply.retry_after.unwrap_or(2).clamp(1, 5);
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    }

    /// One full issuance for `ip`: order, tls-alpn-01, finalize with a fresh key, download, verify.
    pub(crate) async fn issue(&mut self, ip: Ipv4Addr, replaces: Option<&str>, responder: &dyn ChallengeResponder) -> Result<Issued, AcmeError> {
        // The directory is read afresh for each issuance (one GET about every 80 h): a profile the CA
        // offers again, or a moved URL or terms, is picked up without a restart.
        self.dir = None;
        let dir = self.directory(Stage::Order).await?;
        if !dir.profiles.iter().any(|p| p == PROFILE) {
            return Err(AcmeError::new(Stage::Order, Fault::ProfileUnavailable));
        }
        self.ensure_account().await?;
        let mut replaces = replaces.map(str::to_string);
        let mut terms_agreed = false;
        let mut account_renewed = false;
        let (order_url, order) = loop {
            match self.new_order(ip, replaces.as_deref()).await {
                Ok(o) => break o,
                // The CA does not take the held account URL (unknown, or not this key's): register the key
                // again, which answers the URL of the account the key holds, or opens one. Once.
                Err(e) if !account_renewed && self.kid.is_some()
                    && matches!(&e.fault, Fault::Rejected(k) if matches!(k.as_str(), "accountDoesNotExist" | "unauthorized" | "malformed")) =>
                {
                    account_renewed = true;
                    self.kid = None;
                    self.ensure_account().await?;
                }
                // The link refused: a crash between finalize and install left the old certificate replaced
                // already, or another account (a lost account key) requested it. Order again without it
                // (that order counts against the exact-set limit); left in, every renewal would fail.
                Err(e) if replaces.is_some() && matches!(e.fault, Fault::AlreadyReplaced | Fault::Rejected(_)) => replaces = None,
                Err(e) if matches!(e.fault, Fault::TermsChanged(_)) && !terms_agreed => {
                    if let Fault::TermsChanged(tos) = &e.fault {
                        if is_warn() {
                            println!("[WARN][WALLETTLS] acme_failed stage=account reason=terms_changed tos={} action=agree",
                                     tos.as_deref().unwrap_or("unknown"));
                        }
                    }
                    self.agree_terms().await?;
                    terms_agreed = true;
                }
                Err(e) => return Err(e),
            }
        };
        let authzs: Vec<String> = order["authorizations"].as_array()
            .map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let finalize = order["finalize"].as_str().map(str::to_string)
            .ok_or_else(|| AcmeError::new(Stage::Order, Fault::Rejected("no_finalize_url".into())))?;
        for authz_url in authzs {
            self.authorize(&authz_url, ip, responder).await?;
        }
        let (csr, key_pkcs8, key_raw) = csr_for(ip).map_err(|e| AcmeError::new(Stage::Finalize, Fault::Invalid(e)))?;
        self.post(Stage::Finalize, &finalize, Some(&json!({ "csr": B64URL.encode(&csr) })), None).await?;
        let done = self.poll(Stage::Finalize, &order_url, &["pending", "ready", "processing"]).await?;
        if done["status"].as_str() != Some("valid") {
            return Err(AcmeError::new(Stage::Finalize, Fault::Rejected(format!("order_{}", done["status"].as_str().unwrap_or("unknown")))));
        }
        let cert_url = done["certificate"].as_str().map(str::to_string)
            .ok_or_else(|| AcmeError::new(Stage::Download, Fault::Rejected("no_certificate_url".into())))?;
        let reply = self.post(Stage::Download, &cert_url, None, Some("application/pem-certificate-chain")).await?;
        let chain_pem = String::from_utf8(reply.body).map_err(|_| AcmeError::new(Stage::Download, Fault::Invalid("chain_not_text".into())))?;
        let (chain, facts) = verify_chain(&chain_pem, &key_raw, ip, wallet_plane::unix_now())
            .map_err(|e| AcmeError::new(Stage::Verify, Fault::Invalid(e)))?;
        Ok(Issued { chain_pem, chain, key_pkcs8, facts })
    }

    async fn authorize(&mut self, authz_url: &str, ip: Ipv4Addr, responder: &dyn ChallengeResponder) -> Result<(), AcmeError> {
        let authz = self.post(Stage::Challenge, authz_url, None, None).await?.json();
        match authz["status"].as_str() {
            // An authorization the CA still holds for this account (it reuses them for 7 h).
            Some("valid") => return Ok(()),
            Some("pending") => {}
            other => return Err(AcmeError::new(Stage::Challenge, Fault::AuthorizationInvalid(format!("authz_{}", other.unwrap_or("unknown"))))),
        }
        let challenge = authz["challenges"].as_array()
            .and_then(|cs| cs.iter().find(|c| c["type"].as_str() == Some("tls-alpn-01")))
            .cloned()
            .ok_or_else(|| AcmeError::new(Stage::Challenge, Fault::Rejected("no_tls_alpn_challenge".into())))?;
        let (Some(url), Some(token)) = (challenge["url"].as_str(), challenge["token"].as_str()) else {
            return Err(AcmeError::new(Stage::Challenge, Fault::Rejected("challenge_incomplete".into())));
        };
        if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(AcmeError::new(Stage::Challenge, Fault::Rejected("bad_token".into())));
        }
        let digest = key_authorization_digest(token, &self.account.thumbprint());
        responder.arm(ip, &digest, CHALLENGE_ARM_TTL).map_err(|e| AcmeError::new(Stage::Challenge, Fault::Invalid(e)))?;
        // Armed until the authorization leaves `pending`: each of the CA's vantage points handshakes.
        let _armed = DisarmOnDrop(responder);
        let url = url.to_string();
        self.post(Stage::Challenge, &url, Some(&json!({})), None).await?;
        let done = self.poll(Stage::Challenge, authz_url, &["pending", "processing"]).await?;
        match done["status"].as_str() {
            Some("valid") => Ok(()),
            other => {
                let detail = done["challenges"].as_array()
                    .and_then(|cs| cs.iter().find_map(|c| c["error"]["detail"].as_str().map(str::to_string)))
                    .unwrap_or_else(|| format!("authz_{}", other.unwrap_or("unknown")));
                Err(AcmeError::new(Stage::Challenge, Fault::AuthorizationInvalid(detail)))
            }
        }
    }

    /// The CA's suggested renewal window for a certificate (RFC 9773; unauthenticated GET), with its
    /// Retry-After.
    pub(crate) async fn renewal_info(&mut self, cert_id: &str) -> Result<((u64, u64), Option<u64>), AcmeError> {
        let dir = self.directory(Stage::Order).await?;
        let Some(base) = dir.renewal_info else {
            return Err(AcmeError::new(Stage::Order, Fault::Rejected("no_renewal_info".into())));
        };
        let url = format!("{}/{}", base.trim_end_matches('/'), cert_id);
        let resp = self.http.get(&url).send().await.map_err(|e| AcmeError::new(Stage::Order, Fault::Transport(e.to_string())))?;
        let retry_after = resp.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok())
            .and_then(|v| parse_retry_after(v, wallet_plane::unix_now()));
        if !resp.status().is_success() {
            return Err(AcmeError { stage: Stage::Order, fault: Fault::Rejected(format!("renewal_info_{}", resp.status().as_u16())), retry_after });
        }
        let v: Value = resp.json().await.map_err(|e| AcmeError::new(Stage::Order, Fault::Transport(e.to_string())))?;
        let t = |k: &str| v["suggestedWindow"][k].as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp().max(0) as u64);
        match (t("start"), t("end")) {
            (Some(s), Some(e)) if s <= e => Ok(((s, e), retry_after)),
            _ => Err(AcmeError::new(Stage::Order, Fault::Rejected("renewal_info_malformed".into()))),
        }
    }
}

/// A CSR for `ip` with a fresh P-256 key (never the account key): an empty subject, since the CA
/// refuses an IP common name and takes any other as an extra identifier, and the IP as the only
/// subject-alternative name. (CSR DER, the key's PKCS#8, the key's raw public point.)
pub(crate) fn csr_for(ip: Ipv4Addr) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.subject_alt_names = vec![rcgen::SanType::IpAddress(IpAddr::V4(ip))];
    params.alg = &rcgen::PKCS_ECDSA_P256_SHA256;
    let cert = rcgen::Certificate::from_params(params).map_err(|e| e.to_string())?;
    let csr = cert.serialize_request_der().map_err(|e| e.to_string())?;
    Ok((csr, cert.serialize_private_key_der(), cert.get_key_pair().public_key_raw().to_vec()))
}

/// A problem document as its typed fault (RFC 8555 §6.7, RFC 9773 §7.4).
fn problem(stage: Stage, reply: &Reply) -> AcmeError {
    let v = reply.json();
    let kind = v["type"].as_str().unwrap_or("").strip_prefix(ERR_PREFIX).unwrap_or("").to_string();
    let detail = v["detail"].as_str().unwrap_or("").to_string();
    let url_in = |s: &str| s.split_whitespace().find(|w| w.starts_with("https://"))
        .map(|w| w.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | '"')).to_string());
    let fault = match kind.as_str() {
        "badNonce" => Fault::BadNonce,
        // The consecutive-failure pause comes as a rate limit naming the page that lifts it.
        "rateLimited" if detail.to_ascii_lowercase().contains("pause") => Fault::Paused(url_in(&detail)),
        "rateLimited" => Fault::RateLimited,
        "alreadyReplaced" => Fault::AlreadyReplaced,
        "userActionRequired" => Fault::TermsChanged(
            reply.links.iter().find(|(rel, _)| rel == "terms-of-service").map(|(_, u)| u.clone())
                .or_else(|| v["instance"].as_str().map(str::to_string))),
        _ if reply.status == 503 => Fault::Unavailable,
        _ if reply.status == 409 && detail.to_ascii_lowercase().contains("replaced") => Fault::AlreadyReplaced,
        _ => Fault::Rejected(if kind.is_empty() { format!("http_{}", reply.status) } else { kind }),
    };
    AcmeError { stage, fault, retry_after: reply.retry_after }
}

// ─── Certificates ───────────────────────────────────────────────────────────────────────────────

/// What the node needs to know about a certificate it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertFacts {
    pub(crate) ip: Ipv4Addr,
    pub(crate) not_before: u64,
    pub(crate) not_after: u64,
    /// The renewal-information identifier (RFC 9773 §4.1), when the leaf names its issuer's key.
    pub(crate) cert_id: Option<String>,
}

/// A downloaded, verified issuance.
pub(crate) struct Issued {
    pub(crate) chain_pem: String,
    pub(crate) chain: Vec<Vec<u8>>,
    pub(crate) key_pkcs8: Vec<u8>,
    pub(crate) facts: CertFacts,
}

/// The DER certificates of a PEM chain, in order.
pub(crate) fn pem_certificates(pem: &str) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut body: Option<String> = None;
    for line in pem.lines().map(str::trim) {
        match (line, body.as_mut()) {
            ("-----BEGIN CERTIFICATE-----", None) => body = Some(String::new()),
            ("-----END CERTIFICATE-----", Some(b)) => {
                out.push(base64::engine::general_purpose::STANDARD.decode(b.as_bytes()).map_err(|_| "bad base64 in chain")?);
                body = None;
            }
            (l, Some(b)) => b.push_str(l),
            ("", None) => {}
            (_, None) => return Err("text outside a certificate block".into()),
        }
    }
    if body.is_some() {
        return Err("unterminated certificate block".into());
    }
    if out.is_empty() {
        return Err("no certificate".into());
    }
    Ok(out)
}

/// The checks before a chain is served (exactly as downloaded): every certificate parses; the leaf
/// holds the CSR's key, names exactly {iPAddress ip}, allows serverAuth and is valid now.
pub(crate) fn verify_chain(pem: &str, csr_key_raw: &[u8], ip: Ipv4Addr, now: u64) -> Result<(Vec<Vec<u8>>, CertFacts), String> {
    use x509_parser::extensions::{GeneralName, ParsedExtension};
    let chain = pem_certificates(pem)?;
    for der in &chain {
        x509_parser::parse_x509_certificate(der).map_err(|e| format!("chain_parse: {}", e))?;
    }
    let (_, leaf) = x509_parser::parse_x509_certificate(&chain[0]).map_err(|e| format!("leaf_parse: {}", e))?;
    if leaf.public_key().subject_public_key.data.as_ref() != csr_key_raw {
        return Err("leaf_key_mismatch".into());
    }
    let sans: Vec<GeneralName> = leaf.subject_alternative_name().map_err(|_| "san_parse")?
        .map(|s| s.value.general_names.clone()).unwrap_or_default();
    let ip_bytes = ip.octets();
    if sans.len() != 1 || !matches!(&sans[0], GeneralName::IPAddress(b) if *b == ip_bytes.as_slice()) {
        return Err("san_not_exactly_ip".into());
    }
    let server_auth = leaf.extended_key_usage().map_err(|_| "eku_parse")?.map_or(false, |e| e.value.server_auth);
    if !server_auth {
        return Err("no_server_auth".into());
    }
    let not_before = leaf.validity().not_before.timestamp().max(0) as u64;
    let not_after = leaf.validity().not_after.timestamp().max(0) as u64;
    if !(not_before <= now && now < not_after) {
        return Err("not_valid_now".into());
    }
    let aki = leaf.extensions().iter().find_map(|e| match e.parsed_extension() {
        ParsedExtension::AuthorityKeyIdentifier(a) => a.key_identifier.as_ref().map(|k| k.0.to_vec()),
        _ => None,
    });
    let cert_id = aki.map(|k| format!("{}.{}", B64URL.encode(k), B64URL.encode(leaf.raw_serial())));
    Ok((chain, CertFacts { ip, not_before, not_after, cert_id }))
}

/// Facts of a held certificate without the issuance-time checks (it may have expired since).
pub(crate) fn chain_facts(pem: &str) -> Result<(Vec<Vec<u8>>, CertFacts), String> {
    use x509_parser::extensions::{GeneralName, ParsedExtension};
    let chain = pem_certificates(pem)?;
    let (_, leaf) = x509_parser::parse_x509_certificate(&chain[0]).map_err(|e| format!("leaf_parse: {}", e))?;
    let sans: Vec<GeneralName> = leaf.subject_alternative_name().map_err(|_| "san_parse")?
        .map(|s| s.value.general_names.clone()).unwrap_or_default();
    let ip = match sans.as_slice() {
        [GeneralName::IPAddress(b)] if b.len() == 4 => Ipv4Addr::new(b[0], b[1], b[2], b[3]),
        _ => return Err("san_not_exactly_ipv4".into()),
    };
    let aki = leaf.extensions().iter().find_map(|e| match e.parsed_extension() {
        ParsedExtension::AuthorityKeyIdentifier(a) => a.key_identifier.as_ref().map(|k| k.0.to_vec()),
        _ => None,
    });
    let facts = CertFacts {
        ip,
        not_before: leaf.validity().not_before.timestamp().max(0) as u64,
        not_after: leaf.validity().not_after.timestamp().max(0) as u64,
        cert_id: aki.map(|k| format!("{}.{}", B64URL.encode(k), B64URL.encode(leaf.raw_serial()))),
    };
    Ok((chain, facts))
}

/// Whether the leaf (DER) certifies the public half of `key_pkcs8`.
pub(crate) fn leaf_holds_key(leaf_der: &[u8], key_pkcs8: &[u8]) -> bool {
    let Ok(key) = rcgen::KeyPair::from_der(key_pkcs8) else { return false };
    x509_parser::parse_x509_certificate(leaf_der)
        .map_or(false, |(_, leaf)| leaf.public_key().subject_public_key.data.as_ref() == key.public_key_raw())
}

// ─── Schedule ───────────────────────────────────────────────────────────────────────────────────

/// The persisted schedule. Times are unix seconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TlsState {
    /// The first-ever order waits until here (drawn once, after the first positive probe).
    #[serde(default)]
    pub(crate) first_order_not_before: Option<u64>,
    /// When the 443 probe last passed; cleared when an authorization fails.
    #[serde(default)]
    pub(crate) precheck_ok_at: Option<u64>,
    /// No probe before this.
    #[serde(default)]
    pub(crate) precheck_next: u64,
    /// Probes in a row that no genesis could answer, indexing PRECHECK_BUSY_SECS.
    #[serde(default)]
    pub(crate) precheck_busy_step: u8,
    /// No attempt before this (backoff).
    #[serde(default)]
    pub(crate) next_attempt_at: u64,
    /// Failures since the last success, indexing BACKOFF_SECS.
    #[serde(default)]
    pub(crate) backoff_step: u8,
    /// Failed authorizations of the last hour.
    #[serde(default)]
    pub(crate) authz_failures: Vec<u64>,
    #[serde(default)]
    pub(crate) renew_at: Option<u64>,
    #[serde(default)]
    pub(crate) ari_window: Option<(u64, u64)>,
    #[serde(default)]
    pub(crate) ari_next_poll: u64,
    #[serde(default)]
    pub(crate) issued_ever: bool,
    /// A validation failed since the last issuance: 443 may no longer reach this node (an opt-out, a
    /// firewall), so even a renewal of a held certificate waits for a fresh positive probe.
    #[serde(default)]
    pub(crate) probe_before_renewal: bool,
}

/// What the certificate side should do now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing before this time.
    Wait(u64),
    /// Prove host 443 reaches this process before any account or order.
    Precheck,
    Issue { replaces: Option<String> },
    PollRenewalInfo,
}

impl TlsState {
    /// Backoff and the per-identifier failure cap: Some(time) while an attempt must wait.
    fn attempt_blocked(&self, now: u64) -> Option<u64> {
        let mut until = if now < self.next_attempt_at { self.next_attempt_at } else { 0 };
        let recent: Vec<u64> = self.authz_failures.iter().copied().filter(|t| t + 3600 > now).collect();
        if recent.len() >= AUTHZ_FAILURES_PER_HOUR {
            until = until.max(recent.iter().min().copied().unwrap_or(now) + 3600);
        }
        (until > now).then_some(until)
    }

    /// The next step for `ip`, given the certificate held (`cert`, possibly expired or for another IP).
    pub(crate) fn plan(&self, cert: Option<&CertFacts>, ip: Ipv4Addr, now: u64) -> Step {
        if let Some(c) = cert.filter(|c| c.ip == ip && now < c.not_after) {
            let mut wake = u64::MAX;
            if c.cert_id.is_some() {
                if now >= self.ari_next_poll {
                    return Step::PollRenewalInfo;
                }
                wake = self.ari_next_poll;
            }
            let renew_at = self.renew_at.unwrap_or_else(|| half_life(c));
            if now >= renew_at {
                match self.attempt_blocked(now) {
                    None if self.probe_before_renewal && !self.probe_fresh(now) => {
                        if now >= self.precheck_next {
                            return Step::Precheck;
                        }
                        wake = wake.min(self.precheck_next);
                    }
                    None => return Step::Issue { replaces: c.cert_id.clone() },
                    Some(t) => wake = wake.min(t),
                }
            } else {
                wake = wake.min(renew_at);
            }
            return Step::Wait(wake);
        }
        // No usable certificate for this IP. The first-ever order waits out its drawn delay first (drawn
        // at the first positive probe) and probes again right before it orders, rather than every hour
        // of the wait; then the backoff, then the probe.
        if !self.issued_ever {
            if let Some(t) = self.first_order_not_before.filter(|t| *t > now) {
                return Step::Wait(t);
            }
        }
        // The backoff first: a probe is only worth asking for right before an order can follow it.
        if let Some(t) = self.attempt_blocked(now) {
            return Step::Wait(t);
        }
        if !self.probe_fresh(now) {
            return if now >= self.precheck_next { Step::Precheck } else { Step::Wait(self.precheck_next) };
        }
        // An expired certificate for the same IP is still the one this order replaces.
        Step::Issue { replaces: cert.filter(|c| c.ip == ip).and_then(|c| c.cert_id.clone()) }
    }

    fn probe_fresh(&self, now: u64) -> bool {
        self.precheck_ok_at.map_or(false, |t| t + PRECHECK_VALID_SECS > now)
    }

    /// A validation that failed (or may have, when an attempt was cut short after its challenge was
    /// armed): it counts against the per-identifier cap, and something else may answer 443 now, so the
    /// next order of any kind, a renewal included, waits for a fresh positive probe.
    pub(crate) fn record_authorization_failure(&mut self, now: u64) {
        self.authz_failures.push(now);
        self.precheck_ok_at = None;
        self.probe_before_renewal = true;
    }

    /// Whether the schedule has already failed for want of 443 or of the CA since its last success:
    /// failures are backing it off, or the last probe found 443 unreachable and its 6 h wait runs.
    pub(crate) fn failing(&self, now: u64) -> bool {
        self.backoff_step > 0
            || (self.precheck_ok_at.is_none() && self.precheck_busy_step == 0 && self.precheck_next > now)
    }

    /// A probe verdict. A positive first one draws the first-order delay; a negative one waits about
    /// 6 h. Returns the wait before the next probe (0 after a positive one).
    pub(crate) fn on_precheck(&mut self, ok: bool, now: u64, rng: &mut impl Rng) -> u64 {
        self.precheck_busy_step = 0;
        if ok {
            self.precheck_ok_at = Some(now);
            if !self.issued_ever && self.first_order_not_before.is_none() {
                self.first_order_not_before = Some(now + rng.gen_range(0..=FIRST_ORDER_JITTER_SECS));
            }
            0
        } else {
            self.precheck_ok_at = None;
            let wait = rng.gen_range(PRECHECK_RETRY_SECS - PRECHECK_RETRY_JITTER_SECS..=PRECHECK_RETRY_SECS + PRECHECK_RETRY_JITTER_SECS);
            self.precheck_next = now + wait;
            wait
        }
    }

    /// No genesis could give a verdict: neither permission to order nor a 6 h refusal. The next probe
    /// comes after a random wait of minutes, growing while it lasts, so a fleet that met busy genesis
    /// together returns spread out. Returns the wait.
    pub(crate) fn on_precheck_busy(&mut self, now: u64, rng: &mut impl Rng) -> u64 {
        let step = PRECHECK_BUSY_SECS[(self.precheck_busy_step as usize).min(PRECHECK_BUSY_SECS.len() - 1)];
        let wait = rng.gen_range(step / 2..=step);
        self.precheck_busy_step = self.precheck_busy_step.saturating_add(1).min(PRECHECK_BUSY_SECS.len() as u8);
        self.precheck_next = now + wait;
        wait
    }

    /// A certificate was installed: reset the backoff, poll renewal information at once, and until it
    /// answers plan the renewal at half the lifetime +- 1 h.
    pub(crate) fn on_issued(&mut self, facts: &CertFacts, now: u64, rng: &mut impl Rng) {
        self.issued_ever = true;
        self.backoff_step = 0;
        self.next_attempt_at = 0;
        self.precheck_ok_at = None;
        self.probe_before_renewal = false;
        self.ari_window = None;
        self.ari_next_poll = now;
        let jitter = rng.gen_range(-HALF_LIFE_JITTER_SECS..=HALF_LIFE_JITTER_SECS);
        self.renew_at = Some(half_life(facts).saturating_add_signed(jitter));
        self.authz_failures.retain(|t| t + 3600 > now);
    }

    /// A failed attempt: the next wait (seconds), never shorter than the CA's Retry-After.
    pub(crate) fn on_failure(&mut self, err: &AcmeError, now: u64) -> u64 {
        if matches!(err.fault, Fault::AuthorizationInvalid(_)) {
            self.record_authorization_failure(now);
        }
        self.authz_failures.retain(|t| t + 3600 > now);
        let step = (self.backoff_step as usize).min(BACKOFF_SECS.len() - 1);
        let mut wait = BACKOFF_SECS[step];
        if matches!(err.fault, Fault::Paused(_) | Fault::ProfileUnavailable) {
            wait = BACKOFF_SECS[BACKOFF_SECS.len() - 1];
        }
        wait = wait.max(err.retry_after.unwrap_or(0));
        self.backoff_step = self.backoff_step.saturating_add(1).min(BACKOFF_SECS.len() as u8);
        self.next_attempt_at = now + wait;
        wait
    }

    /// A renewal-information answer (or None when it could not be had). A changed window draws a new
    /// uniform renewal time inside it; a window already past means renew now.
    pub(crate) fn on_renewal_info(&mut self, window: Option<(u64, u64)>, retry_after: Option<u64>, now: u64, rng: &mut impl Rng) {
        match window {
            Some(w) => {
                if self.ari_window != Some(w) || self.renew_at.is_none() {
                    self.ari_window = Some(w);
                    self.renew_at = Some(if w.1 <= now { now } else { rng.gen_range(w.0.max(now)..=w.1) });
                }
                self.ari_next_poll = now + retry_after.unwrap_or(ARI_POLL_DEFAULT_SECS).clamp(ARI_POLL_MIN_SECS, ARI_POLL_MAX_SECS);
            }
            None => self.ari_next_poll = now + ARI_POLL_MIN_SECS,
        }
    }
}

/// Half the certificate's lifetime after its start.
fn half_life(c: &CertFacts) -> u64 {
    c.not_before + c.not_after.saturating_sub(c.not_before) / 2
}

// ─── Persistence ────────────────────────────────────────────────────────────────────────────────

/// `<data_dir>/wallet_tls`, on the node's persistent volume.
pub(crate) fn wallet_tls_dir() -> PathBuf {
    let base = std::env::var("QNET_STORAGE_PATH").ok().filter(|s| !s.is_empty())
        .or_else(|| std::env::var("QNET_DATA_DIR").ok().filter(|s| !s.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let docker = PathBuf::from("/app/data");
            if docker.is_dir() { docker } else { PathBuf::from("data") }
        });
    base.join("wallet_tls")
}

/// Create the directory owner-only (0700), and tighten it again on every open: the image entrypoint
/// widens the data volume's modes at each start.
pub(crate) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.path().is_file() {
                    let _ = std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(0o600));
                }
            }
        }
    }
    Ok(())
}

/// Write a file owner-only (0600) and atomically: a crash leaves the old copy or the new one.
pub(crate) fn write_private(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let tmp = dir.join(format!(".{}.tmp", name));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(name))
}

// ─── The manager ────────────────────────────────────────────────────────────────────────────────

/// The node's certificate side: the persisted schedule, the CA account and the held certificate,
/// driven one step at a time by the public RPC task (node/public_rpc.rs).
pub(crate) struct CertManager {
    dir: PathBuf,
    directory_url: String,
    state: TlsState,
    client: Option<AcmeClient>,
    facts: Option<CertFacts>,
    responder: Arc<CertStore>,
    last_expiring_warn: u64,
}

impl CertManager {
    /// Open the production manager: load what is on disk and install a held certificate that is
    /// still valid.
    pub(crate) fn open(dir: PathBuf, responder: Arc<CertStore>) -> Self {
        Self::open_with(dir, ACME_DIRECTORY_URL, responder)
    }

    /// The same against another directory: the test CA.
    pub(crate) fn open_with(dir: PathBuf, directory_url: &str, responder: Arc<CertStore>) -> Self {
        if let Err(e) = ensure_private_dir(&dir) {
            if is_warn() {
                println!("[WARN][WALLETTLS] dir_unusable path={} err={}", dir.display(), e);
            }
        }
        let state = std::fs::read(dir.join(STATE_FILE)).ok()
            .and_then(|b| serde_json::from_slice::<TlsState>(&b).ok())
            .unwrap_or_default();
        let mut m = Self { dir, directory_url: directory_url.to_string(), state, client: None, facts: None, responder, last_expiring_warn: 0 };
        m.load_certificate();
        m
    }

    fn load_certificate(&mut self) {
        let (Ok(pem), Ok(key)) = (std::fs::read_to_string(self.dir.join(CERT_FILE)), std::fs::read(self.dir.join(CERT_KEY_FILE))) else {
            return;
        };
        match chain_facts(&pem) {
            // The key and the chain are two files: a crash between their writes leaves a new key beside the
            // old chain. Such a pair is no certificate (every handshake would fail), so the next order
            // starts from none.
            Ok((chain, _)) if !leaf_holds_key(&chain[0], &key) => {
                if is_warn() {
                    println!("[WARN][WALLETTLS] held_cert_unusable err=key_mismatch action=reissue");
                }
            }
            Ok((chain, facts)) => {
                let now = wallet_plane::unix_now();
                if facts.not_before <= now && now < facts.not_after {
                    match certified_key(chain, &key) {
                        Ok(k) => self.responder.install(Installed { key: k, ip: facts.ip, not_before: facts.not_before, not_after: facts.not_after }),
                        Err(e) => if is_warn() { println!("[WARN][WALLETTLS] held_cert_unusable err={}", e); },
                    }
                }
                self.facts = Some(facts);
            }
            Err(e) => if is_warn() {
                println!("[WARN][WALLETTLS] held_cert_unreadable err={}", e);
            },
        }
    }

    pub(crate) fn facts(&self) -> Option<&CertFacts> {
        self.facts.as_ref()
    }

    pub(crate) fn state(&self) -> &TlsState {
        &self.state
    }

    /// Whether a CA account exists (created after the first positive probe).
    #[cfg(test)]
    pub(crate) fn has_account(&self) -> bool {
        self.client.as_ref().map_or(false, |c| c.kid().is_some()) || self.dir.join(ACCOUNT_URL_FILE).exists()
    }

    pub(crate) fn plan(&self, ip: Ipv4Addr, now: u64) -> Step {
        self.state.plan(self.facts.as_ref(), ip, now)
    }

    fn save_state(&self) {
        match serde_json::to_vec(&self.state) {
            Ok(b) => if let Err(e) = write_private(&self.dir, STATE_FILE, &b) {
                if is_warn() { println!("[WARN][WALLETTLS] state_save_failed err={}", e); }
            },
            Err(e) => if is_warn() { println!("[WARN][WALLETTLS] state_encode_failed err={}", e); },
        }
    }

    /// A probe verdict, persisted; the wait before the next probe.
    pub(crate) fn on_precheck(&mut self, ok: bool, now: u64) -> u64 {
        let wait = self.state.on_precheck(ok, now, &mut rand::thread_rng());
        self.save_state();
        wait
    }

    /// A probe no genesis could answer, persisted; the wait before the next one.
    pub(crate) fn on_precheck_busy(&mut self, now: u64) -> u64 {
        let wait = self.state.on_precheck_busy(now, &mut rand::thread_rng());
        self.save_state();
        wait
    }

    /// The account client, loading or creating the key (the key only: the account itself is
    /// registered at the first order). A key that cannot be read now is never replaced (that would lose
    /// the account); a missing or undecodable one is, and a new key never inherits the old account's URL.
    fn client(&mut self) -> Result<&mut AcmeClient, AcmeError> {
        if self.client.is_none() {
            let fail = |e: String| AcmeError::new(Stage::Account, Fault::Invalid(e));
            let held = match std::fs::read(self.dir.join(ACCOUNT_KEY_FILE)) {
                Ok(der) => match AccountKey::from_pkcs8(&der) {
                    Ok(k) => Some(k),
                    Err(e) => {
                        if is_warn() {
                            println!("[WARN][WALLETTLS] account_key_unusable err={} action=new_account", short(&e));
                        }
                        None
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(fail(format!("account_key_unreadable: {}", e))),
            };
            let (key, kid) = match held {
                Some(k) => {
                    let kid = std::fs::read_to_string(self.dir.join(ACCOUNT_URL_FILE)).ok()
                        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                    (k, kid)
                }
                None => {
                    // The URL goes first: a crash between the two leaves no key and no URL, never a new key
                    // paired with the old account's URL (every request it signed would be refused).
                    match std::fs::remove_file(self.dir.join(ACCOUNT_URL_FILE)) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(fail(format!("account_url_remove: {}", e))),
                    }
                    let k = AccountKey::generate().map_err(fail)?;
                    write_private(&self.dir, ACCOUNT_KEY_FILE, &k.pkcs8).map_err(|e| fail(format!("account_key_save: {}", e)))?;
                    (k, None)
                }
            };
            self.client = Some(AcmeClient::new(&self.directory_url, key, kid));
        }
        Ok(self.client.as_mut().expect("client set above"))
    }

    /// One issuance for `ip`: install, persist, log; on failure back off and log. Ok(facts) on success.
    ///
    /// The attempt is on disk as a failure before its first request (and its challenge as a failed
    /// authorization before it is posted): a crash, kill or restart mid-attempt leaves the backoff and
    /// the per-identifier cap in force, so a restart loop never re-asks the CA early. The outcome then
    /// replaces both.
    pub(crate) async fn issue(&mut self, ip: Ipv4Addr, replaces: Option<String>) -> Result<CertFacts, AcmeError> {
        let now = wallet_plane::unix_now();
        let before = self.state.clone();
        self.state.on_failure(&AcmeError::new(Stage::Order, Fault::Interrupted), now);
        self.save_state();
        let recorder = AttemptRecorder {
            inner: Arc::clone(&self.responder),
            dir: self.dir.clone(),
            state: parking_lot::Mutex::new(self.state.clone()),
            now,
        };
        let (result, new_kid) = match self.client() {
            Ok(client) => {
                let had_kid = client.kid().map(str::to_string);
                let r = client.issue(ip, replaces.as_deref(), &recorder).await;
                let new_kid = client.kid().filter(|k| had_kid.as_deref() != Some(*k)).map(str::to_string);
                (r, new_kid)
            }
            Err(e) => (Err(e), None),
        };
        self.state = before;
        // The account exists from its first order on (or was registered again): keep its URL so a restart
        // reuses it.
        if let Some(kid) = new_kid {
            if let Err(e) = write_private(&self.dir, ACCOUNT_URL_FILE, kid.as_bytes()) {
                if is_warn() { println!("[WARN][WALLETTLS] account_url_save_failed err={}", e); }
            }
        }
        match result {
            Ok(issued) => {
                let key = certified_key(issued.chain.clone(), &issued.key_pkcs8)
                    .map_err(|e| AcmeError::new(Stage::Verify, Fault::Invalid(e)));
                let key = match key {
                    Ok(k) => k,
                    Err(e) => return Err(self.failed(e, now)),
                };
                // Persist before swapping: a crash after the swap must not lose the key it serves.
                if let Err(e) = write_private(&self.dir, CERT_KEY_FILE, &issued.key_pkcs8)
                    .and_then(|_| write_private(&self.dir, CERT_FILE, issued.chain_pem.as_bytes()))
                {
                    if is_warn() { println!("[WARN][WALLETTLS] cert_save_failed err={}", e); }
                }
                let f = issued.facts.clone();
                self.responder.install(Installed { key, ip: f.ip, not_before: f.not_before, not_after: f.not_after });
                self.state.on_issued(&f, now, &mut rand::thread_rng());
                self.save_state();
                self.facts = Some(f.clone());
                if is_info() {
                    println!("[INFO][WALLETTLS] cert_issued ip={} not_after={} renewal={}",
                             f.ip, f.not_after, if replaces.is_some() { "replaces" } else { "new" });
                }
                Ok(f)
            }
            Err(e) => Err(self.failed(e, now)),
        }
    }

    fn failed(&mut self, e: AcmeError, now: u64) -> AcmeError {
        let wait = self.state.on_failure(&e, now);
        self.save_state();
        if is_warn() {
            let extra = match &e.fault {
                Fault::Paused(link) => format!(" unpause={}", link.as_deref().unwrap_or("unknown")),
                Fault::TermsChanged(tos) => format!(" tos={}", tos.as_deref().unwrap_or("unknown")),
                _ => String::new(),
            };
            println!("[WARN][WALLETTLS] acme_failed stage={} reason={} retry_in={}s{}", e.stage.name(), e.fault.reason(), wait, extra);
        }
        e
    }

    /// Ask the CA when to renew the held certificate.
    pub(crate) async fn poll_renewal_info(&mut self, now: u64) {
        let Some(cert_id) = self.facts.as_ref().and_then(|f| f.cert_id.clone()) else { return };
        let answer = match self.client() {
            Ok(c) => c.renewal_info(&cert_id).await,
            Err(e) => Err(e),
        };
        match answer {
            Ok((window, retry_after)) => self.state.on_renewal_info(Some(window), retry_after, now, &mut rand::thread_rng()),
            Err(e) => {
                if crate::node::is_debug() {
                    println!("[DBG][WALLETTLS] renewal_info_unavailable reason={}", e.fault.reason());
                }
                self.state.on_renewal_info(None, None, now, &mut rand::thread_rng());
            }
        }
        self.save_state();
    }

    /// `cert_expiring` while the held certificate has under 24 h left, at most hourly.
    pub(crate) fn warn_if_expiring(&mut self, now: u64) {
        let Some(f) = &self.facts else { return };
        if now < f.not_after && f.not_after - now < EXPIRING_WARN_SECS && now.saturating_sub(self.last_expiring_warn) >= 3600 {
            self.last_expiring_warn = now;
            if is_warn() {
                println!("[WARN][WALLETTLS] cert_expiring hours_left={}", (f.not_after - now) / 3600);
            }
        }
    }
}

#[cfg(test)]
#[path = "acme_tests.rs"]
mod tests;

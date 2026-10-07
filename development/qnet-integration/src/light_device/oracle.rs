//! The device oracle client (A17, A18): mutual TLS 1.3 to the oracle's hosts, the requests the genesis side
//! sends and how its answers map onto `/bind` reasons (`development/qnet-device-oracle/README.md`, "API").
//!
//! - Hosts are configuration: `QNET_DEVICE_ORACLE_URLS`, comma-separated `https://` URLs, the primary
//!   first. With none configured the node takes enrolments without a lease (`check_pending`, never counted).
//! - The client material is `{ca.crt, client.crt, client.key}` in `/opt/qnet-oracle-client`
//!   (`QNET_DEVICE_ORACLE_CLIENT_DIR`); only the oracle's own CA is trusted.
//! - Every oracle signature is verified under the key pinned in the binary (`statement::OraclePins`), never
//!   one the oracle sends.
//! - A standby answers `503 {"error":"standby"}`: the next host is asked.
//! - A refusal is HTTP 422 `{error, ref?, until?, retry_at?}` with the `/bind` reason in `error`.
//! - Vendor tokens travel on this route only: never logged, stored, gossiped or put in a block.
//! - Every call tells [`AVAILABILITY`] whether the oracle answered: an outage stretches clean leases.

use std::time::Duration;

use serde_json::{json, Value};

use super::{DeviceReason, DeviceRefusal, Op, Platform, Prov, Trust};

/// What an oracle call gave instead of an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OracleError {
    /// HTTP 422: a stated refusal with a `/bind` reason.
    Refused { reason: DeviceReason, reference: Option<String>, until: Option<u64>, retry_at: Option<u64> },
    /// No oracle configured, none reachable, only a standby, a timeout, or an answer that does not read:
    /// the enrolment goes on without a lease.
    Unavailable(&'static str),
}

impl OracleError {
    /// The `/bind` refusal for a stated refusal at Unix time `now`: `retry_at` becomes
    /// `retry_after_seconds`, and `until` of `device_slot_paused` the pause's end.
    pub fn refusal(&self, now: u64) -> Option<DeviceRefusal> {
        match self {
            OracleError::Refused { reason, reference, until, retry_at } => Some(DeviceRefusal {
                reason: *reason,
                retry_after: retry_at.map(|t| t.saturating_sub(now).max(1))
                    .or_else(|| until.filter(|_| *reason == DeviceReason::SlotPaused).map(|t| t.saturating_sub(now).max(1))),
                paused_until: until.filter(|_| *reason == DeviceReason::SlotPaused)
                    .map(|t| super::epoch_at(t, now, super::current_epoch())),
                reference: reference.clone(),
            }),
            OracleError::Unavailable(_) => None,
        }
    }
}

/// The oracle as the genesis side sees it: one POST or GET of the internal API.
#[async_trait::async_trait]
pub trait OracleApi: Send + Sync {
    async fn post(&self, path: &'static str, body: Value, timeout: Duration) -> Result<Value, OracleError>;
    async fn get(&self, path: &'static str, timeout: Duration) -> Result<Value, OracleError>;
}

/// The oracle over mutual TLS.
pub struct HttpOracle {
    urls: Vec<String>,
    client: reqwest::Client,
}

pub const DEFAULT_CLIENT_DIR: &str = "/opt/qnet-oracle-client";

impl HttpOracle {
    /// From the configuration; Err names what is missing (logged once, no secret in it).
    pub fn from_env() -> Result<HttpOracle, String> {
        let urls: Vec<String> = std::env::var("QNET_DEVICE_ORACLE_URLS").unwrap_or_default()
            .split(',').map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()).collect();
        if urls.is_empty() { return Err("QNET_DEVICE_ORACLE_URLS not set".into()); }
        if let Some(bad) = urls.iter().find(|u| !u.starts_with("https://")) {
            return Err(format!("oracle URL is not https: {}", bad));
        }
        let dir = std::env::var("QNET_DEVICE_ORACLE_CLIENT_DIR").unwrap_or_else(|_| DEFAULT_CLIENT_DIR.to_string());
        let read = |name: &str| std::fs::read(std::path::Path::new(&dir).join(name))
            .map_err(|e| format!("{}/{}: {}", dir, name, e));
        let (ca, cert, key) = (read("ca.crt")?, read("client.crt")?, read("client.key")?);
        let mut pem = key;
        pem.push(b'\n');
        pem.extend_from_slice(&cert);
        let identity = reqwest::Identity::from_pem(&pem).map_err(|e| format!("client identity: {}", e))?;
        let ca = reqwest::Certificate::from_pem(&ca).map_err(|e| format!("oracle CA: {}", e))?;
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .tls_built_in_root_certs(false)
            .add_root_certificate(ca)
            .identity(identity)
            .min_tls_version(reqwest::tls::Version::TLS_1_3)
            .https_only(true)
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("client: {}", e))?;
        Ok(HttpOracle { urls, client })
    }

    async fn send(&self, path: &'static str, body: Option<&Value>, timeout: Duration) -> Result<Value, OracleError> {
        let mut last = OracleError::Unavailable("no_oracle");
        let mut answered = false;
        for url in &self.urls {
            let req = match body {
                Some(b) => self.client.post(format!("{}{}", url, path)).json(b),
                None => self.client.get(format!("{}{}", url, path)),
            };
            let resp = match req.timeout(timeout).send().await {
                Ok(r) => r,
                Err(e) => {
                    last = OracleError::Unavailable(if e.is_timeout() { "timeout" } else { "unreachable" });
                    if crate::node::is_warn() {
                        println!("[WARN][DEVICE] oracle_call_failed path={} reason={}", path,
                                 if e.is_timeout() { "timeout" } else { "unreachable" });
                    }
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let answer: Value = resp.json().await.unwrap_or(Value::Null);
            match read_answer(status, answer) {
                Answer::Ok(v) => {
                    AVAILABILITY.note(true, super::now_secs());
                    return Ok(v);
                }
                Answer::Refused(e) => {
                    AVAILABILITY.note(true, super::now_secs());
                    return Err(e);
                }
                Answer::Next(why) => {
                    answered |= status < 500;
                    last = OracleError::Unavailable(why);
                    if crate::node::is_warn() {
                        println!("[WARN][DEVICE] oracle_host_skipped path={} status={} reason={}", path, status, why);
                    }
                }
            }
        }
        // A host that answers "not found" or "conflict" for one node is up: only a call no host answered
        // (unreachable, a timeout, only a standby, a server error) counts toward an outage.
        AVAILABILITY.note(answered, super::now_secs());
        Err(last)
    }
}

/// Whether the oracle answers this genesis (plan section 9.4): the Unix time since which no call got an
/// answer, 0 while it answers. A clean lease reads live through an outage of up to a week
/// (`DeviceRecord::state_with`); the first answer ends the outage.
pub struct Availability {
    down_since: std::sync::atomic::AtomicU64,
}

impl Availability {
    pub const fn new() -> Self {
        Availability { down_since: std::sync::atomic::AtomicU64::new(0) }
    }

    pub fn note(&self, answered: bool, now: u64) {
        use std::sync::atomic::Ordering::Relaxed;
        if answered {
            let was = self.down_since.swap(0, Relaxed);
            if was > 0 && crate::node::is_info() {
                println!("[INFO][DEVICE] oracle_outage_over lasted_secs={}", now.saturating_sub(was));
            }
        } else if self.down_since.compare_exchange(0, now.max(1), Relaxed, Relaxed).is_ok() && crate::node::is_warn() {
            println!("[WARN][ALERT] device_oracle_unreachable since={}", now);
        }
    }

    pub fn down_since(&self) -> u64 {
        self.down_since.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl Default for Availability {
    fn default() -> Self {
        Self::new()
    }
}

/// The running node's view of the configured oracle.
pub static AVAILABILITY: Availability = Availability::new();

/// Since when the configured oracle has not answered here; 0 while it answers or when none is configured.
pub fn down_since() -> u64 {
    AVAILABILITY.down_since()
}

#[async_trait::async_trait]
impl OracleApi for HttpOracle {
    async fn post(&self, path: &'static str, body: Value, timeout: Duration) -> Result<Value, OracleError> {
        self.send(path, Some(&body), timeout).await
    }

    async fn get(&self, path: &'static str, timeout: Duration) -> Result<Value, OracleError> {
        self.send(path, None, timeout).await
    }
}

/// How one host's answer is taken.
#[derive(Debug, PartialEq)]
pub(crate) enum Answer {
    Ok(Value),
    Refused(OracleError),
    /// Ask the next host (a standby, a server error, an answer that does not read).
    Next(&'static str),
}

pub(crate) fn read_answer(status: u16, body: Value) -> Answer {
    match status {
        200 if body.is_object() => Answer::Ok(body),
        422 => match body.get("error").and_then(|e| e.as_str()).and_then(DeviceReason::parse) {
            Some(reason) => Answer::Refused(OracleError::Refused {
                reason,
                reference: body.get("ref").and_then(|r| r.as_str())
                    .filter(|r| r.len() == 8 && r.bytes().all(|b| b.is_ascii_hexdigit())).map(|r| r.to_ascii_lowercase()),
                until: body.get("until").and_then(|u| u.as_u64()),
                retry_at: body.get("retry_at").and_then(|u| u.as_u64()),
            }),
            None => Answer::Next("unknown_refusal"),
        },
        503 if body.get("error").and_then(|e| e.as_str()) == Some("standby") => Answer::Next("standby"),
        200 => Answer::Next("unreadable"),
        _ => Answer::Next("status"),
    }
}

/// The configured oracle, if any. Read once; a configuration error is logged once and leaves none.
pub fn configured() -> Option<&'static dyn OracleApi> {
    static O: std::sync::OnceLock<Option<HttpOracle>> = std::sync::OnceLock::new();
    O.get_or_init(|| match HttpOracle::from_env() {
        Ok(o) => {
            println!("[INFO][DEVICE] oracle_configured hosts={}", o.urls.len());
            Some(o)
        }
        Err(e) => {
            println!("[INFO][DEVICE] oracle_not_configured reason={}", e);
            None
        }
    }).as_ref().map(|o| o as &dyn OracleApi)
}

/// A claim (the README asks at least 30 s: it can make three vendor round trips). It runs in the enrolment's
/// own task; `/bind` answers at its budget whatever the claim is doing (`BIND_DEVICE_BUDGET`).
pub const CLAIM_TIMEOUT: Duration = Duration::from_secs(30);
/// Any other call off the answer path.
pub const BACKGROUND_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// What `POST /v1/claim` needs (the oracle refuses unknown fields).
pub struct ClaimInput<'a> {
    pub node_id: &'a str,
    pub platform: Platform,
    pub op: Op,
    pub preimage: &'a str,
    pub hw_pub: &'a [u8],
    pub prov: Prov,
    pub trust: Trust,
    pub key_new: bool,
    pub att_key: Option<&'a str>,
    pub certs_issued: Option<u64>,
    pub att_key_multi: bool,
    pub receipt: Option<&'a [u8]>,
    pub token: &'a str,
    pub client_ip: Option<String>,
    pub evidence: Value,
}

pub fn claim_body(c: &ClaimInput<'_>) -> Value {
    use base64::Engine as _;
    let mut b = json!({
        "node_id": c.node_id,
        "platform": c.platform.as_str(),
        "op": c.op.as_str(),
        "preimage": c.preimage,
        "hw_pub": hex::encode(c.hw_pub),
        "prov": c.prov.as_str(),
        "trust": c.trust.as_str(),
        "key_new": c.key_new,
        "att_key_multi": c.att_key_multi,
        "evidence": c.evidence,
    });
    if let Some(a) = c.att_key { b["att_key"] = a.into(); }
    if let Some(n) = c.certs_issued { b["certs_issued"] = n.min(u32::MAX as u64).into(); }
    if let Some(r) = c.receipt { b["receipt"] = base64::engine::general_purpose::STANDARD.encode(r).into(); }
    b[token_field(c.platform)] = c.token.into();
    if let Some(ip) = &c.client_ip { b["client_ip"] = ip.clone().into(); }
    b
}

/// The token field of a platform: DeviceCheck on iOS, Play Integrity on Android.
pub fn token_field(platform: Platform) -> &'static str {
    match platform { Platform::Ios => "dc_token", Platform::Android => "pi_token" }
}

/// A token the oracle would take: printable ASCII, at most 16 KB.
pub fn token_shape_ok(t: &str) -> bool {
    !t.is_empty() && t.len() <= 16 * 1024 && t.bytes().all(|b| b > b' ' && b < 0x7f)
}

/// What a claim or a rotation gave the genesis side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimAnswer {
    pub lease_statement: String,
    pub oracle_sig: Vec<u8>,
    pub lease_valid_until: u64,
    pub refresh_at: u64,
    pub pi_jws: Option<String>,
    pub reference: Option<String>,
    /// The oracle's own view of the state (it carries strikes over: `suspect`).
    pub suspect: bool,
    /// A rotation whose slot read made the second strike: `paused` until `paused_until` (Unix seconds).
    pub paused: bool,
    pub paused_until: u64,
}

pub fn read_claim(v: &Value) -> Option<ClaimAnswer> {
    let lease_statement = v.get("lease_statement")?.as_str()?.to_string();
    let oracle_sig = hex::decode(v.get("oracle_sig")?.as_str()?).ok()?;
    let state = v.get("state").and_then(|x| x.as_str());
    Some(ClaimAnswer {
        lease_statement,
        oracle_sig,
        lease_valid_until: v.get("lease_valid_until").and_then(|x| x.as_u64()).unwrap_or(0),
        refresh_at: v.get("refresh_at").and_then(|x| x.as_u64()).unwrap_or(0),
        pi_jws: v.get("pi_jws").and_then(|x| x.as_str()).map(|s| s.to_string()),
        reference: v.get("ref").and_then(|x| x.as_str()).map(|s| s.to_string()),
        suspect: state == Some("suspect"),
        paused: state == Some("paused"),
        paused_until: v.get("paused_until").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

/// `POST /v1/refresh` (section 5.6): the token under the record's platform's field.
pub fn refresh_body(node_id: &str, platform: Platform, preimage: &str, token: &str) -> Value {
    let mut b = json!({ "node_id": node_id, "preimage": preimage });
    b[token_field(platform)] = token.into();
    b
}

/// `POST /v1/release` (section 5.7): a token only when the device sent one.
pub fn release_body(node_id: &str, platform: Platform, preimage: &str, token: Option<&str>) -> Value {
    let mut b = json!({ "node_id": node_id, "preimage": preimage });
    if let Some(t) = token { b[token_field(platform)] = t.into(); }
    b
}

/// What `POST /v1/rotate` needs (section 5.4; the oracle refuses unknown fields).
pub struct RotateInput<'a> {
    pub node_id: &'a str,
    pub platform: Platform,
    pub preimage: &'a str,
    /// The new device key.
    pub hw_pub: &'a [u8],
    pub prov: Prov,
    pub trust: Trust,
    pub att_key: Option<&'a str>,
    pub certs_issued: Option<u64>,
    pub receipt: Option<&'a [u8]>,
    pub token: &'a str,
    pub evidence: Value,
}

pub fn rotate_body(r: &RotateInput<'_>) -> Value {
    use base64::Engine as _;
    let mut b = json!({
        "node_id": r.node_id,
        "preimage": r.preimage,
        "hw_pub": hex::encode(r.hw_pub),
        "prov": r.prov.as_str(),
        "trust": r.trust.as_str(),
        "att_key_multi": false,
        "evidence": r.evidence,
    });
    if let Some(a) = r.att_key { b["att_key"] = a.into(); }
    if let Some(n) = r.certs_issued { b["certs_issued"] = n.min(u32::MAX as u64).into(); }
    if let Some(x) = r.receipt { b["receipt"] = base64::engine::general_purpose::STANDARD.encode(x).into(); }
    b[token_field(r.platform)] = r.token.into();
    b
}

/// What a refresh gave: the slot read's outcome and the lease the oracle keeps now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshAnswer {
    /// `pass`, `lost_write`, `anomaly`, `strike`, `two_strikes`, `hold`, `deferred`, `check_pending`, `paused`.
    pub result: String,
    pub state: super::DeviceState,
    /// The state change's reason, when the oracle names one (section 6.3).
    pub reason: Option<String>,
    pub lease_valid_until: u64,
    pub refresh_at: u64,
    /// Unix seconds; 0 when not paused.
    pub paused_until: u64,
    pub reference: Option<String>,
}

pub fn read_refresh(v: &Value) -> Option<RefreshAnswer> {
    let text = |k: &str| v.get(k).and_then(|x| x.as_str());
    let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let reason = text("reason").filter(|r| !r.is_empty() && r.len() <= 32 && r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        .map(|r| r.to_string());
    Some(RefreshAnswer {
        result: text("result")?.chars().take(32).collect(),
        state: super::DeviceState::parse(text("state")?)?,
        reason,
        lease_valid_until: num("lease_valid_until"),
        refresh_at: num("refresh_at"),
        paused_until: num("paused_until"),
        reference: text("ref").filter(|r| r.len() == 8 && r.bytes().all(|b| b.is_ascii_hexdigit())).map(|r| r.to_ascii_lowercase()),
    })
}

/// `POST /v1/recheck`: the daily recheck of a node a multiplicity gate holds.
pub fn recheck_body(node_id: &str) -> Value {
    json!({ "node_id": node_id })
}

/// What a recheck gave: the oracle's state now, why it changed (`check_passed` when the gate let the node
/// go), and when to ask again (Unix seconds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecheckAnswer {
    pub state: super::DeviceState,
    pub reason: Option<String>,
    pub next_check_at: u64,
}

pub fn read_recheck(v: &Value) -> Option<RecheckAnswer> {
    let reason = v.get("reason").and_then(|x| x.as_str())
        .filter(|r| !r.is_empty() && r.len() <= 32 && r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')).map(|r| r.to_string());
    Some(RecheckAnswer {
        state: super::DeviceState::parse(v.get("state")?.as_str()?)?,
        reason,
        next_check_at: v.get("next_check_at").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn an_outage_starts_at_the_first_unanswered_call_and_ends_at_the_first_answer() {
        let a = Availability::new();
        assert_eq!(a.down_since(), 0);
        a.note(false, 1_000);
        a.note(false, 2_000);
        assert_eq!(a.down_since(), 1_000, "the first failure dates the outage");
        a.note(true, 3_000);
        assert_eq!(a.down_since(), 0);
        a.note(false, 0);
        assert_eq!(a.down_since(), 1, "never mistaken for 'answering'");
        let r = read_recheck(&json!({"state": "active", "reason": "check_passed", "next_check_at": 99, "metric": 2})).unwrap();
        assert_eq!((r.state, r.reason.as_deref(), r.next_check_at), (crate::light_device::DeviceState::Active, Some("check_passed"), 99));
        assert_eq!(read_recheck(&json!({"state": "check_pending", "reason": null})).unwrap().reason, None);
        assert!(read_recheck(&json!({"state": "awake"})).is_none());
        assert_eq!(recheck_body("light_mobile_6526ab8fd00ff8ca"), json!({"node_id": "light_mobile_6526ab8fd00ff8ca"}));
    }

    #[test]
    fn answers_map_onto_bind_reasons() {
        assert_eq!(read_answer(200, json!({"lease_statement": "x"})), Answer::Ok(json!({"lease_statement": "x"})));
        assert_eq!(read_answer(503, json!({"error": "standby"})), Answer::Next("standby"));
        assert_eq!(read_answer(500, json!({"error": "internal"})), Answer::Next("status"));
        assert_eq!(read_answer(400, json!({"error": "bad_request"})), Answer::Next("status"));
        assert_eq!(read_answer(422, json!({"error": "something_else"})), Answer::Next("unknown_refusal"));
        let now = 1_800_000_000;
        let Answer::Refused(e) = read_answer(422, json!({"error": "device_rate_limited", "retry_at": now + 3600})) else { panic!() };
        let r = e.refusal(now).unwrap();
        assert_eq!((r.reason, r.retry_after), (DeviceReason::RateLimited, Some(3600)));
        assert_eq!(r.to_json()["retry_after_seconds"], json!(3600));
        let Answer::Refused(e) = read_answer(422, json!({"error": "device_slot_paused", "until": now + 30 * 86_400, "ref": "6972DF36"}))
            else { panic!() };
        let r = e.refusal(now).unwrap();
        assert_eq!(r.reason, DeviceReason::SlotPaused);
        assert_eq!(r.retry_after, Some(30 * 86_400));
        assert!(r.paused_until.is_some());
        assert_eq!(r.reference.as_deref(), Some("6972df36"));
        assert!(OracleError::Unavailable("timeout").refusal(now).is_none(), "an outage is no refusal");
    }

    #[test]
    fn a_claim_carries_exactly_the_fields_the_oracle_takes() {
        let body = claim_body(&ClaimInput {
            node_id: "light_mobile_6526ab8fd00ff8ca", platform: Platform::Android, op: Op::Enrol, preimage: "p",
            hw_pub: &[4u8; 65], prov: Prov::Rkp, trust: Trust::Store, key_new: true, att_key: Some(&"ab".repeat(32)),
            certs_issued: Some(u64::MAX), att_key_multi: false, receipt: None, token: "tok", client_ip: Some("203.0.113.9".into()),
            evidence: json!({}),
        });
        let allowed = ["node_id", "platform", "op", "preimage", "hw_pub", "prov", "trust", "key_new", "att_key",
                       "certs_issued", "att_key_multi", "receipt", "dc_token", "pi_token", "reset_ref", "client_ip", "evidence"];
        for k in body.as_object().unwrap().keys() {
            assert!(allowed.contains(&k.as_str()), "{k} is not a claim field");
        }
        assert_eq!(body["pi_token"], json!("tok"));
        assert!(body.get("dc_token").is_none());
        assert_eq!(body["certs_issued"], json!(u32::MAX as u64));
        assert!(token_shape_ok("abc.def-_") && !token_shape_ok("") && !token_shape_ok("a b"));
        assert!(!token_shape_ok(&"a".repeat(16 * 1024 + 1)));
    }

    #[test]
    fn refresh_rotate_and_release_carry_exactly_the_fields_the_oracle_takes() {
        let only = |body: &Value, allowed: &[&str]| {
            for k in body.as_object().unwrap().keys() { assert!(allowed.contains(&k.as_str()), "{k}"); }
        };
        let r = refresh_body("light_mobile_6526ab8fd00ff8ca", Platform::Ios, "p", "dc");
        only(&r, &["node_id", "preimage", "dc_token", "pi_token"]);
        assert_eq!((r["dc_token"].as_str(), r.get("pi_token")), (Some("dc"), None));
        let r = release_body("light_mobile_6526ab8fd00ff8ca", Platform::Android, "p", None);
        only(&r, &["node_id", "preimage", "dc_token", "pi_token"]);
        assert!(r.get("pi_token").is_none(), "no token, no field");
        let r = rotate_body(&RotateInput {
            node_id: "light_mobile_6526ab8fd00ff8ca", platform: Platform::Android, preimage: "p", hw_pub: &[4u8; 65],
            prov: Prov::Factory, trust: Trust::Store, att_key: None, certs_issued: Some(7), receipt: None, token: "pi",
            evidence: json!({}),
        });
        only(&r, &["node_id", "preimage", "hw_pub", "prov", "trust", "att_key", "certs_issued", "att_key_multi", "receipt",
                   "dc_token", "pi_token", "evidence"]);
        assert_eq!((r["pi_token"].as_str(), r["prov"].as_str()), (Some("pi"), Some("factory")));
        // The refresh answer's reasons are the state change's own; anything else is dropped.
        let a = read_refresh(&json!({"result": "two_strikes", "state": "paused", "reason": "two_strikes", "paused_until": 99,
                                     "lease_valid_until": 5, "refresh_at": 4, "ref": "ABCDEF01"})).unwrap();
        assert_eq!((a.state, a.reason.as_deref(), a.paused_until, a.reference.as_deref()),
                   (crate::light_device::DeviceState::Paused, Some("two_strikes"), 99, Some("abcdef01")));
        assert!(read_refresh(&json!({"result": "pass", "state": "awake"})).is_none());
        assert_eq!(read_refresh(&json!({"result": "pass", "state": "active", "reason": "Refresh OK"})).unwrap().reason, None);
    }
}

//! The oracle's operations: claim, refresh, release, rotate, recheck, the revocation snapshot and support
//! tickets. Each operation on a node runs under that node's lock, so its read-decide-write sequence against
//! the vendor slot is linearisable per node; vendor calls run outside any global lock.
//!
//! Order inside an operation: request shape → replay → node state → vendor read → decision → vendor write
//! → one atomic commit. A refusal commits nothing except its sealed evidence and support ticket.

use parking_lot::{Mutex, MutexGuard, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use crate::alerts::Alerts;
use crate::api::*;
use crate::config::Quota;
use crate::evidence::{self, EvClass, Sealer};
use crate::gates::{corroborated_android, corroborated_ios, gate_reason, Gates, METRIC_WINDOW};
use crate::lease::*;
use crate::limits::{check_node, IpLimiter, KeyRebinds, LimitParams, Times};
use crate::messages::*;
use crate::signer::Signer;
use crate::store::{Batch, Cf, Store};
use crate::types::*;
use crate::upstream::appattest::{AppAttestData, Exchange, ReceiptInfo};
use crate::upstream::crl::{self, Snapshot};
use crate::upstream::devicecheck::{AppleEnv, DeviceCheck};
use crate::upstream::playintegrity::{unbound, Decoded, PiError, PlayIntegrity};
use qnet_device_attest::play::{Licensing, PlayVerdict};
use crate::upstream::{HttpClient, Outages, Service, VendorError};

/// Tokens are remembered this long against replay; a retry of the same request inside the idempotency
/// window gets the first answer again.
const REPLAY_KEEP: u64 = DAY;
const IDEMPOTENT_WINDOW: u64 = 600;
const TICKET_KEEP: u64 = 90 * DAY;
const APPROVAL_VALID: u64 = 30 * DAY;
const LOCK_SHARDS: usize = 1024;
/// A revocation snapshot older than this raises an alert; nodes keep using it up to 7 days.
const CRL_ALERT_AGE: u64 = DAY;
/// Upper bound of pages one maintenance pass deletes per kind of expired record.
const MAINTENANCE_PAGES: usize = 200;
/// Pages of 1 000 tickets one maintenance pass reads.
const TICKET_PAGES_PER_PASS: usize = 100;

pub struct Vendors {
    pub devicecheck: Option<DeviceCheck>,
    pub appattest: Option<AppAttestData>,
    pub play: Option<PlayIntegrity>,
    pub http: Arc<dyn HttpClient>,
}

pub struct Settings {
    pub network: Network,
    pub chain_id: String,
    pub quota: Quota,
    pub crl_url: String,
    pub log_keep: u64,
}

/// Which node a device key belongs to (R3: one key, one node).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyOwner {
    pub node: String,
    pub since: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredReceipt {
    pub der: Vec<u8>,
    pub not_before: u64,
    pub expires: u64,
    pub metric: Option<u32>,
    pub measured_at: u64,
}

impl StoredReceipt {
    fn fresh(der: Vec<u8>, r: &ReceiptInfo, now: u64) -> Self {
        StoredReceipt {
            der,
            not_before: r.not_before.unwrap_or(now),
            expires: r.expires_at.unwrap_or(now + 90 * DAY),
            metric: r.metric,
            measured_at: now,
        }
    }
}

/// A support ticket: filed with every refusal or pause that shows a reference on the device.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ticket {
    pub node: String,
    pub platform: Platform,
    pub reason: String,
    pub created_at: u64,
    pub ev_key: Option<Vec<u8>>,
    pub approved_at: u64,
    pub approved_by: String,
    pub used_at: u64,
}

impl Ticket {
    pub fn usable(&self, node: &str, now: u64) -> bool {
        self.approved_at > 0 && self.used_at == 0 && now < self.approved_at + APPROVAL_VALID && self.node == node
    }
}

#[derive(Default)]
struct Counters {
    day: u64,
    play_decodes: u64,
    quota_alerted: bool,
    hour: u64,
    bad_tokens: u64,
}

/// A Play token that opened and was bound to its request: a verdict that passed, or one the device failed.
enum Play {
    Passed(Decoded),
    Failed(qnet_device_attest::Refusal),
}

/// The slot value a passed verdict carries.
fn verdict_slot(v: &PlayVerdict) -> Read {
    match &v.device_recall {
        Some(r) => Read::Slot(slot_from_bits(r.first, r.second, r.third), r.written_third),
        None => Read::NotEvaluated,
    }
}

/// The one-day lease: no strong-integrity signal, a licence Google did not confirm, or a test build.
fn verdict_short(v: &PlayVerdict) -> bool {
    !v.strong_integrity || v.licensing != Licensing::Licensed || v.trust == qnet_device_attest::Trust::Test
}

enum Read {
    Slot(SlotRead, Option<u32>),
    /// The platform gave no slot value (device recall not evaluated): no lease read, never an outage.
    NotEvaluated,
    Outage,
}

struct Ctx<'a> {
    node: &'a str,
    platform: Platform,
    reference: &'a str,
    evidence: Option<&'a Value>,
    op: &'static str,
}

pub struct Oracle {
    pub settings: Settings,
    pub params: Params,
    pub gates: Gates,
    pub limits: LimitParams,
    pub store: Arc<Store>,
    pub signer: Signer,
    pub sealer: Sealer,
    pub vendors: Vendors,
    pub outages: Outages,
    pub alerts: Arc<Alerts>,
    ip: IpLimiter,
    locks: Vec<Mutex<()>>,
    idem: Mutex<HashMap<[u8; 32], (u64, String, Value)>>,
    counters: Mutex<Counters>,
    crl: RwLock<Option<Snapshot>>,
    /// Last ticket key the maintenance scan reached.
    ticket_cursor: Mutex<Option<Vec<u8>>>,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
    gen: Mutex<Box<dyn GenSource + Send>>,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A database read that failed or did not decode answers 500: a decision never goes on as if the record
/// were missing (a missing pause, strike, owner, hold or replay entry would open the gate).
trait Db<T> {
    fn db(self) -> Result<T, ApiError>;
}

impl<T> Db<T> for Result<T, String> {
    fn db(self) -> Result<T, ApiError> {
        self.map_err(ApiError::Internal)
    }
}

fn env_of(t: Trust) -> AppleEnv {
    match t {
        Trust::Store => AppleEnv::Production,
        Trust::Test => AppleEnv::Development,
    }
}

fn ticketable(r: Refusal) -> bool {
    matches!(
        r,
        Refusal::DeviceSlotPaused
            | Refusal::DeviceNotGenuine
            | Refusal::DeviceCompromised
            | Refusal::DeviceUnlicensed
            | Refusal::DeviceAppUnrecognized
    )
}

fn limited(retry_at: u64) -> ApiError {
    ApiError::Refused { reason: Refusal::DeviceRateLimited, reference: None, until: None, retry_at: Some(retry_at) }
}

fn outcome_str(o: RefreshOutcome) -> &'static str {
    match o {
        RefreshOutcome::Pass => "pass",
        RefreshOutcome::LostWrite => "lost_write",
        RefreshOutcome::Anomaly => "anomaly",
        RefreshOutcome::Strike => "strike",
        RefreshOutcome::TwoStrikes => "two_strikes",
        RefreshOutcome::Hold => "hold",
    }
}

impl Oracle {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        settings: Settings,
        params: Params,
        gates: Gates,
        limits: LimitParams,
        store: Arc<Store>,
        signer: Signer,
        sealer: Sealer,
        vendors: Vendors,
        alerts: Arc<Alerts>,
    ) -> Self {
        Oracle {
            settings,
            params,
            gates,
            limits,
            store,
            signer,
            sealer,
            vendors,
            outages: Outages::default(),
            alerts,
            ip: IpLimiter::default(),
            locks: (0..LOCK_SHARDS).map(|_| Mutex::new(())).collect(),
            idem: Mutex::new(HashMap::new()),
            counters: Mutex::new(Counters::default()),
            crl: RwLock::new(None),
            ticket_cursor: Mutex::new(None),
            clock: Box::new(unix_now),
            gen: Mutex::new(Box::new(SysGen)),
        }
    }

    pub fn with_clock(mut self, clock: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    pub fn with_gen(self, gen: Box<dyn GenSource + Send>) -> Self {
        *self.gen.lock() = gen;
        self
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Locks node ids and device keys (`hex(sha3(hw_pub))`) in one order, so no two operations bind one key.
    fn lock_nodes(&self, nodes: &[&str]) -> Vec<MutexGuard<'_, ()>> {
        let mut idx: Vec<usize> = nodes
            .iter()
            .filter(|n| !n.is_empty())
            .map(|n| {
                let h = sha256(n.as_bytes());
                (u16::from_be_bytes([h[0], h[1]]) as usize) % LOCK_SHARDS
            })
            .collect();
        idx.sort_unstable();
        idx.dedup();
        idx.into_iter().map(|i| self.locks[i].lock()).collect()
    }

    // ---- counters and alerts ----

    fn roll(&self, c: &mut Counters, now: u64) {
        if c.day != now / DAY {
            c.day = now / DAY;
            c.play_decodes = 0;
            c.quota_alerted = false;
        }
        if c.hour != now / HOUR {
            c.hour = now / HOUR;
            c.bad_tokens = 0;
        }
    }

    fn count_play_decode(&self, now: u64) {
        let mut c = self.counters.lock();
        self.roll(&mut c, now);
        c.play_decodes += 1;
        if !c.quota_alerted && c.play_decodes * 2 >= self.settings.quota.play_daily {
            c.quota_alerted = true;
            let msg = format!("play_tokens_today={} daily_quota={}", c.play_decodes, self.settings.quota.play_daily);
            drop(c);
            self.alerts.raise("quota_half_used", &msg, now);
        }
    }

    /// A token that failed its binding: counted for the quota-burn alarm.
    fn bad_token(&self, now: u64) {
        let mut c = self.counters.lock();
        self.roll(&mut c, now);
        c.bad_tokens += 1;
        if c.bad_tokens == self.settings.quota.bad_tokens_hourly {
            drop(c);
            let msg = format!("unbound_tokens_this_hour={}", self.settings.quota.bad_tokens_hourly);
            self.alerts.raise("quota_burn", &msg, now);
        }
    }

    fn track<T>(&self, s: Service, r: Result<T, VendorError>) -> Result<T, VendorError> {
        let now = self.now();
        match &r {
            Ok(_) | Err(VendorError::Rejected(_)) => {
                if let Some(start) = self.outages.success(s) {
                    let msg = format!("service={} down_secs={}", s.as_str(), now.saturating_sub(start));
                    self.alerts.raise(&format!("vendor_recovered_{}", s.as_str()), &msg, now);
                }
            }
            Err(e) => {
                let (_, crossed) = self.outages.failure(s, now);
                if crate::log::is_warn() {
                    println!("[WARN][ORACLE] vendor_failed service={} err={}", s.as_str(), e.message());
                }
                if crossed {
                    self.alerts.raise(&format!("vendor_outage_{}", s.as_str()), &format!("service={}", s.as_str()), now);
                }
                if let VendorError::Config(m) = e {
                    self.alerts.raise(&format!("vendor_config_{}", s.as_str()), m, now);
                }
            }
        }
        r
    }

    // ---- replay and idempotency ----

    fn idem_get(&self, th: &[u8; 32], node: &str, now: u64) -> Option<Value> {
        let m = self.idem.lock();
        m.get(th).filter(|(t, n, _)| n == node && now < t + IDEMPOTENT_WINDOW).map(|(_, _, v)| v.clone())
    }

    fn idem_put(&self, th: [u8; 32], node: &str, v: &Value, now: u64) {
        let mut m = self.idem.lock();
        if m.len() > 50_000 {
            m.retain(|_, (t, _, _)| now < *t + IDEMPOTENT_WINDOW);
        }
        m.insert(th, (now, node.to_string(), v.clone()));
    }

    fn replayed(&self, th: &[u8; 32], now: u64) -> Result<bool, ApiError> {
        Ok(matches!(self.store.get::<u64>(Cf::Replay, th).db()?, Some(exp) if exp > now))
    }

    fn remember_token(&self, b: &mut Batch, th: &[u8; 32], now: u64) {
        let exp = now + REPLAY_KEEP;
        b.put(Cf::Replay, th, &exp);
        let mut k = exp.to_be_bytes().to_vec();
        k.extend_from_slice(th);
        b.put_raw(Cf::ReplayExp, k, vec![]);
    }

    // ---- refusals ----

    fn refuse(&self, r: Refusal, ctx: &Ctx, now: u64) -> ApiError {
        self.refuse_until(r, ctx, None, now)
    }

    /// A refusal the device shows with its reference gets sealed evidence and a support ticket.
    fn refuse_until(&self, r: Refusal, ctx: &Ctx, until: Option<u64>, now: u64) -> ApiError {
        let reference = ticketable(r).then(|| ctx.reference.to_string());
        if let Some(rf) = &reference {
            self.file_ticket(ctx, rf, r.as_str(), EvClass::Refused, json!({}), now);
        }
        if crate::log::is_info() {
            println!("[INFO][ORACLE] refused op={} node={} reason={}", ctx.op, ctx.node, r.as_str());
        }
        ApiError::Refused { reason: r, reference, until, retry_at: None }
    }

    fn file_ticket(&self, ctx: &Ctx, rf: &str, reason: &str, class: EvClass, extra: Value, now: u64) {
        let key = format!("{}:{}", rf, ctx.node);
        match self.store.get::<Ticket>(Cf::Ticket, &key) {
            Ok(None) => {}
            Ok(Some(_)) => return,
            Err(e) => {
                // Never overwrite a ticket that may exist (it may carry an approval).
                if crate::log::is_err() {
                    println!("[ERROR][ORACLE] ticket_read_failed err={}", e);
                }
                return;
            }
        }
        let mut b = Batch::default();
        let body = json!({
            "op": ctx.op, "platform": ctx.platform.as_str(), "node": ctx.node, "reason": reason,
            "evidence": ctx.evidence, "detail": extra,
        });
        let ev = evidence::add(&mut b, &self.sealer, ctx.node, class, Some(rf.to_string()), &body, now);
        let t = Ticket {
            node: ctx.node.to_string(),
            platform: ctx.platform,
            reason: reason.to_string(),
            created_at: now,
            ev_key: Some(ev),
            approved_at: 0,
            approved_by: String::new(),
            used_at: 0,
        };
        b.put(Cf::Ticket, key, &t);
        if let Err(e) = self.store.commit(b, now) {
            if crate::log::is_err() {
                println!("[ERROR][ORACLE] ticket_write_failed err={}", e);
            }
        }
    }

    // ---- request checks ----

    fn check_trust(&self, t: Trust) -> Result<(), ApiError> {
        if t == Trust::Test && self.settings.network == Network::Mainnet {
            return Err(ApiError::refused(Refusal::DeviceAppUnrecognized));
        }
        Ok(())
    }

    fn check_prov(platform: Platform, prov: Prov) -> Result<(), ApiError> {
        match (platform, prov) {
            (Platform::Ios, Prov::Na) | (Platform::Android, Prov::Rkp) | (Platform::Android, Prov::Factory) => Ok(()),
            _ => Err(ApiError::bad("prov does not match the platform")),
        }
    }

    /// The attestation key and its second-live-key signal count only for a remotely provisioned chain; a
    /// factory attestation key is shared by a batch of devices, so a limit or signal on it would hit them all.
    fn att_key_of(prov: Prov, att_key: &Option<String>, multi: bool) -> (Option<String>, bool) {
        if prov == Prov::Rkp {
            (att_key.clone(), multi)
        } else {
            (None, false)
        }
    }

    fn token<'a>(platform: Platform, dc: &'a Option<String>, pi: &'a Option<String>) -> Result<&'a str, ApiError> {
        let t = match platform {
            Platform::Ios => dc.as_deref(),
            Platform::Android => pi.as_deref(),
        };
        match t {
            Some(t) if !t.is_empty() && t.len() <= 16 * 1024 && t.bytes().all(|b| b > b' ' && b < 0x7f) => Ok(t),
            _ => Err(ApiError::bad("the platform token is missing or malformed")),
        }
    }


    // ---- vendor reads and writes ----

    fn ios_read(&self, token: &str, env: AppleEnv, ctx: &Ctx, now: u64) -> Result<Read, ApiError> {
        let dc = self.vendors.devicecheck.as_ref().ok_or_else(|| ApiError::Unavailable("ios is not configured".into()))?;
        match self.track(Service::DeviceCheck, dc.query(token, env, now * 1000)) {
            Ok(Some((b0, b1))) => Ok(Read::Slot(slot_from_bits(b0, b1, false), None)),
            Ok(None) => Ok(Read::Slot(SlotRead { g: 0, hold: false }, None)),
            Err(VendorError::Rejected(_)) => {
                self.bad_token(now);
                Err(self.refuse(Refusal::DeviceNotGenuine, ctx, now))
            }
            Err(_) => Ok(Read::Outage),
        }
    }

    /// Opens a Play token and checks its verdict for `nonce`. A token that does not open, or is not bound
    /// to this request (foreign nonce, stale, bad signature), is refused and counted for the quota-burn
    /// alarm; a verdict the device failed comes back as `Play::Failed`.
    fn play_read(&self, token: &str, nonce: &[u8; 32], ctx: &Ctx, now: u64) -> Result<Play, ApiError> {
        let play = self.vendors.play.as_ref().ok_or_else(|| ApiError::Unavailable("android is not configured".into()))?;
        self.count_play_decode(now);
        match play.decode(token, nonce, now * 1000) {
            Ok(d) => Ok(Play::Passed(d)),
            Err(PiError::Envelope(e)) => {
                if crate::log::is_info() {
                    println!("[INFO][ORACLE] play_token_unopened node={} err={}", ctx.node, e);
                }
                self.bad_token(now);
                Err(self.refuse(Refusal::DeviceNotGenuine, ctx, now))
            }
            Err(PiError::Verdict(r)) if unbound(&r) => {
                if crate::log::is_info() {
                    println!("[INFO][ORACLE] play_token_unbound node={} err={}", ctx.node, r);
                }
                self.bad_token(now);
                Err(self.refuse(Refusal::from_evidence(r.reason()), ctx, now))
            }
            Err(PiError::Verdict(r)) => Ok(Play::Failed(r)),
        }
    }

    /// Writes a slot value; `true` when the vendor confirmed it.
    fn write_slot(&self, platform: Platform, token: &str, env: AppleEnv, w: SlotWrite, now: u64) -> bool {
        match platform {
            Platform::Ios => {
                let Some(dc) = self.vendors.devicecheck.as_ref() else { return false };
                let (b0, b1) = w.bits();
                self.track(Service::DeviceCheck, dc.update(token, env, b0, b1, now * 1000)).is_ok()
            }
            Platform::Android => {
                let Some(play) = self.vendors.play.as_ref() else { return false };
                let r = play.write_recall(token, w, now);
                let service = if matches!(&r, Err(VendorError::Config(m)) if m.contains("google auth")) {
                    Service::GoogleAuth
                } else {
                    Service::PlayRecall
                };
                self.track(service, r).is_ok()
            }
        }
    }

    /// Decodes the attestation receipt of a newly attested key and checks it names this app and key,
    /// before any vendor call is made for the request.
    fn attest_receipt(&self, receipt_b64: Option<&str>, platform: Platform, hw_pub: &[u8], ctx: &Ctx, now: u64) -> Result<Option<Vec<u8>>, ApiError> {
        let Some(b) = receipt_b64 else { return Ok(None) };
        if platform != Platform::Ios {
            return Err(ApiError::bad("receipts belong to iOS"));
        }
        let der = b64_decode(b).ok_or_else(|| ApiError::bad("receipt is not base64"))?;
        if let Some(aa) = self.vendors.appattest.as_ref() {
            if aa.check(&der, hw_pub, false, now).is_err() {
                return Err(self.refuse(Refusal::DeviceNotGenuine, ctx, now));
            }
        }
        Ok(Some(der))
    }

    /// The iOS risk metric for `hw_pub`: exchanges the checked attestation receipt, or the stored one.
    /// Returns (metric, measurement failed, receipt to store).
    fn ios_metric(
        &self,
        attest: Option<Vec<u8>>,
        hw_key: &str,
        hw_pub: &[u8],
        env: AppleEnv,
        now: u64,
    ) -> (Option<u32>, bool, Option<StoredReceipt>) {
        let Some(aa) = self.vendors.appattest.as_ref() else { return (None, false, None) };
        let stored: Option<StoredReceipt> = match self.store.get(Cf::Receipt, hw_key) {
            Ok(s) => s,
            Err(e) => {
                if crate::log::is_err() {
                    println!("[ERROR][ORACLE] receipt_read_failed err={}", e);
                }
                return (None, true, None);
            }
        };
        let der = match attest {
            Some(der) => der,
            None => match &stored {
                Some(s) if now >= s.not_before => s.der.clone(),
                Some(s) => return (s.metric.filter(|_| now < s.measured_at + METRIC_WINDOW), false, None),
                None => return (None, false, None),
            },
        };
        match self.track(Service::AppAttestData, aa.exchange(&der, env, now)) {
            Ok(Exchange::New(new)) => match aa.check(&new, hw_pub, true, now) {
                Ok(r) => (r.metric, false, Some(StoredReceipt::fresh(new, &r, now))),
                Err(e) => {
                    self.alerts.raise("receipt_invalid", &e, now);
                    (None, true, None)
                }
            },
            Ok(Exchange::NotYet) => (stored.and_then(|s| s.metric.filter(|_| now < s.measured_at + METRIC_WINDOW)), false, None),
            Err(_) => (None, true, None),
        }
    }

    fn statement(&self, node: &str, tag: &[u8; 32], kind: LeaseKind, eff: Effective, gate: Gate, pi_digest: &str, now: u64) -> (String, String) {
        let l = lease_preimage(&self.settings.chain_id, node, tag, kind, eff, gate, pi_digest, now);
        let sig = hex::encode(self.signer.sign(l.as_bytes()));
        (l, sig)
    }

    fn hold_info(&self, l: Option<&NodeLease>, hw_key: &str) -> Result<Option<u64>, ApiError> {
        if let Some(t) = l.map(|l| l.hold_set_at).filter(|&t| t > 0) {
            return Ok(Some(t));
        }
        self.store.get(Cf::Hold, hw_key).db()
    }

    // ---- claim ----

    pub fn claim(&self, req: ClaimRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let chain = self.settings.chain_id.clone();
        let msg = parse_device_message(&req.preimage, &chain).ok_or_else(|| ApiError::bad("preimage"))?;
        let want = match req.op {
            Op::Enrol => MsgKind::Enrol,
            Op::Rebind => MsgKind::Rebind,
            Op::Rotate => return Err(ApiError::bad("rotation has its own route")),
        };
        if msg.kind != want || msg.node != req.node_id {
            return Err(ApiError::bad("preimage does not match the request"));
        }
        // Enrolment flags name the platform: the report hash on Android, the iOS flags otherwise.
        if msg.kind == MsgKind::Enrol && msg.report_sha3.is_some() != (req.platform == Platform::Android) {
            return Err(ApiError::bad("enrolment flags do not match the platform"));
        }
        let hw_pub = parse_hw_pub(&req.hw_pub).ok_or_else(|| ApiError::bad("hw_pub"))?;
        Self::check_prov(req.platform, req.prov)?;
        self.check_trust(req.trust)?;
        if req.att_key.as_deref().map(|a| !is_hex64(a)).unwrap_or(false) {
            return Err(ApiError::bad("att_key"));
        }
        let (att_key, att_key_multi) = Self::att_key_of(req.prov, &req.att_key, req.att_key_multi);
        let token = Self::token(req.platform, &req.dc_token, &req.pi_token)?;
        let node = req.node_id.as_str();
        let tag = device_tag(&chain, req.platform, &hw_pub);
        let hw_key = hex::encode(sha3_256(&hw_pub));
        let rf = reference(&msg.nonce, &tag);
        let env = env_of(req.trust);
        let from = msg.rebind_from.clone();
        let _guards = self.lock_nodes(&[node, from.as_deref().unwrap_or(""), &hw_key]);
        let ctx = Ctx { node, platform: req.platform, reference: &rf, evidence: req.evidence.as_ref(), op: "claim" };

        let th = sha256(token.as_bytes());
        if let Some(v) = self.idem_get(&th, node, now) {
            return Ok(v);
        }
        if self.replayed(&th, now)? {
            self.bad_token(now);
            return Err(ApiError::refused(Refusal::DeviceStale));
        }

        let prev: Option<NodeLease> = self.store.get(Cf::Lease, node).db()?;
        let owner: Option<KeyOwner> = self.store.get(Cf::Key, &hw_key).db()?;
        // The node the key served before, if another one. It holds the key while its live record still
        // names it; after Stop, a move to another device or a rotation the install may link another node.
        let left = owner.as_ref().map(|o| o.node.clone()).filter(|n| n != node);
        let left_lease: Option<NodeLease> = match &left {
            Some(o) => self.store.get(Cf::Lease, o).db()?,
            None => None,
        };
        if let Some(o) = &left {
            let held = left_lease.as_ref().map(|l| l.state != State::Ended && l.hw_key == hw_key).unwrap_or(false);
            if held && !(req.op == Op::Rebind && from.as_deref() == Some(o.as_str())) {
                return Err(ApiError::refused(Refusal::DeviceKeyInUse));
            }
        }
        let attest = self.attest_receipt(req.receipt.as_deref(), req.platform, &hw_pub, &ctx, now)?;
        let old: Option<NodeLease> = match from.as_deref() {
            Some(f) => self.store.get(Cf::Lease, f).db()?,
            None => None,
        };
        if let Some(o) = &old {
            if o.hw_key != hw_key && o.state != State::Ended {
                return Err(ApiError::Conflict("rebind_key_mismatch"));
            }
        }
        let key_new = owner.is_none() && req.key_new.unwrap_or(true);

        let ticket_key = req.reset_ref.as_deref().filter(|r| is_reference(r)).map(|r| format!("{}:{}", r, node));
        let ticket: Option<Ticket> = match &ticket_key {
            Some(k) => self.store.get::<Ticket>(Cf::Ticket, k).db()?.filter(|t| t.usable(node, now)),
            None => None,
        };
        let reset = ticket.is_some();

        if let Some(p) = &prev {
            if p.is_paused(now) && !reset {
                return Err(ApiError::Refused {
                    reason: Refusal::DeviceSlotPaused,
                    reference: None,
                    until: Some(p.paused_until),
                    retry_at: None,
                });
            }
        }
        if let Some(ip) = req.client_ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok()) {
            self.ip.check_and_record(ip, self.limits.ip_per_hour, now).map_err(limited)?;
        }
        // The node limit guards vendor quota: a claim that cannot be a self-reclaim is refused before any call.
        let may_reclaim = prev
            .as_ref()
            .map(|p| p.has_own_value() || (p.released_g != 0 && now < p.released_at + self.params.released_keep))
            .unwrap_or(false);
        if !may_reclaim || reset {
            let t: Times = self.store.get(Cf::Limit, format!("n:{}", node)).db()?.unwrap_or_default();
            check_node(&t, &self.limits, now).map_err(limited)?;
        }
        // A key moving to another node is a rebind for the per-key limit, whether or not the app sent one.
        let moved_from = from.clone().or_else(|| left.clone());
        let mut rebind: Option<(KeyRebinds, bool)> = None;
        if let Some(f) = moved_from.as_deref() {
            let k: KeyRebinds = self.store.get(Cf::Limit, format!("k:{}", hw_key)).db()?.unwrap_or_default();
            let free = k.check(f, node, &self.limits, now).map_err(limited)?;
            rebind = Some((k, free));
        }

        // Vendor read.
        let mut short = req.prov == Prov::Factory;
        let mut pi: Option<Decoded> = None;
        let read = match req.platform {
            Platform::Ios => self.ios_read(token, env, &ctx, now)?,
            Platform::Android => {
                let nonce = match (msg.kind, msg.report_sha3) {
                    (MsgKind::Enrol, Some(r)) => play_nonce_enrol_digest(&req.preimage, &hw_pub, &r),
                    (MsgKind::Rebind, _) => play_nonce_digest(&req.preimage),
                    _ => return Err(ApiError::bad("android enrolment without a report")),
                };
                let d = match self.play_read(token, &nonce, &ctx, now)? {
                    Play::Passed(d) => d,
                    Play::Failed(r) => return Err(self.refuse(Refusal::from_evidence(r.reason()), &ctx, now)),
                };
                if Trust::from(d.verdict.trust) != req.trust {
                    return Err(self.refuse(Refusal::DeviceAppUnrecognized, &ctx, now));
                }
                short |= verdict_short(&d.verdict);
                let read = verdict_slot(&d.verdict);
                pi = Some(d);
                read
            }
        };

        let mut clear_hold = false;
        if let Read::Slot(s, written) = &read {
            if s.hold && !reset {
                let exact = self.hold_info(prev.as_ref().filter(|p| p.hw_key == hw_key), &hw_key)?;
                if !hold_expired(exact, *written, now, &self.params) {
                    let until = hold_until(exact, *written, now, &self.params);
                    return Err(self.refuse_until(Refusal::DeviceSlotPaused, &ctx, Some(until), now));
                }
                clear_hold = true;
            }
        }

        let certs = if req.platform == Platform::Android { req.certs_issued } else { None };
        // A claim by the install that holds this node's slot value (the same device key, the record live or
        // released inside the keep window) is that value's next read: the refresh rules judge it, so claiming
        // again never skips a slot check. A value the install's last other node on this key wrote (a wallet
        // switch inside the install) is the install's own.
        let last_other = if from.is_some() { old.as_ref() } else { left_lease.as_ref() };
        let lineage = last_other.filter(|m| m.hw_key == hw_key);
        let probe = prev.as_ref().filter(|_| !reset).and_then(|p| same_install_probe(p, &hw_key, now, &self.params));
        let plan = match (&read, probe) {
            (Read::Slot(s, _), Some(mut probe))
                if !lineage.map_or(false, |m| classify(Some(m), s.g, now, &self.params) == LeaseKind::SelfReclaim) =>
            {
                probe.certs_issued = certs;
                probe.att_key_multi = att_key_multi;
                let foreign = !s.hold && classify(Some(&probe), s.g, now, &self.params) == LeaseKind::ClaimedForeign;
                let activity = pi.as_ref().and_then(|d| d.verdict.activity_level);
                let corroborated =
                    foreign && second_strike_pending(&probe, now, &self.params) && self.corroborate(&mut probe, activity, now)?;
                Some(plan_reclaim(&probe, *s, clear_hold, corroborated, key_new, now, &self.params, &mut **self.gen.lock()))
            }
            (Read::Slot(s, _), _) => Some(plan_claim(prev.as_ref(), *s, reset, key_new, now, &self.params, &mut **self.gen.lock())),
            _ => None,
        };
        let judged = plan.and_then(|p| p.judged);
        let two_strikes = judged == Some(RefreshOutcome::TwoStrikes);

        // Limits: self-reclaims are free; rebinds count per key; foreign claims per attestation key.
        let counted = plan.map(|p| p.kind) != Some(LeaseKind::SelfReclaim);
        let node_key = format!("n:{}", node);
        let mut node_times: Times = self.store.get(Cf::Limit, &node_key).db()?.unwrap_or_default();
        if counted {
            check_node(&node_times, &self.limits, now).map_err(limited)?;
        }
        let mut att: Option<(String, Times)> = None;
        if req.platform == Platform::Android && plan.map(|p| p.kind) == Some(LeaseKind::ClaimedForeign) {
            if let Some(a) = &att_key {
                let key = format!("a:{}", a);
                let t: Times = self.store.get(Cf::Limit, &key).db()?.unwrap_or_default();
                t.check(self.limits.foreign_per_att_key_day, DAY, now).map_err(limited)?;
                att = Some((key, t));
            }
        }

        // Vendor write.
        let mut established = false;
        let mut outage = matches!(read, Read::Outage);
        let mut pending = None;
        if let (Read::Slot(s, _), Some(p)) = (&read, &plan) {
            if self.write_slot(req.platform, token, env, p.write, now) {
                established = true;
            } else {
                outage = true;
                pending = Some((p.write.g, s.g));
            }
        }

        // Multiplicity gate.
        let (metric, metric_failed, receipt) = match req.platform {
            Platform::Ios => self.ios_metric(attest, &hw_key, &hw_pub, env, now),
            Platform::Android => (None, false, None),
        };
        let observed = self.gates.observe(req.platform, req.prov, metric, certs);
        let gate_hold = self.gates.holds_back(observed) || (self.gates.enforce && metric_failed);
        if observed.is_high() && !self.gates.enforce && crate::log::is_info() {
            println!("[INFO][ORACLE] gate_log_only node={} gate={}", node, observed.as_str());
        }

        let (kind, eff) = match (&plan, established) {
            (Some(p), true) => (p.kind, p.effective),
            _ => (LeaseKind::None, Effective::Next),
        };

        let mut l = NodeLease::fresh(
            req.platform,
            req.prov,
            req.trust,
            hw_key.clone(),
            hex::encode(&hw_pub),
            hex::encode(tag),
            att_key.clone(),
            now,
        );
        if let Some(p) = &prev {
            l.strikes = p.strikes.clone();
            l.anomalies = p.anomalies.clone();
            l.released_g = p.released_g;
            l.released_at = p.released_at;
            if p.hw_key == hw_key {
                l.hold_set_at = p.hold_set_at;
            }
        }
        if reset {
            l.strikes.clear();
            l.anomalies.clear();
            l.hold_set_at = 0;
        }
        if clear_hold {
            l.hold_set_at = 0;
        }
        l.trim(now, &self.params);
        // A judged read's strike or anomaly stands whatever the write did: the read is the evidence.
        match judged {
            Some(RefreshOutcome::Strike) | Some(RefreshOutcome::TwoStrikes) => l.strikes.push(now),
            Some(RefreshOutcome::Anomaly) => l.anomalies.push(now),
            _ => {}
        }
        let wrote_hold = established && plan.map_or(false, |p| p.write.hold);
        if let (true, Some(p), Read::Slot(s, _)) = (established, &plan, &read) {
            l.g = p.write.g;
            // Only a self-reclaim read one of this node's own values.
            l.g_prev = if p.kind == LeaseKind::SelfReclaim { s.g } else { 0 };
        }
        if let Some((w, r)) = pending {
            l.pending = Some(w);
            l.pending_from = r;
        }
        l.short = short;
        l.metric = metric;
        l.metric_at = if metric.is_some() { now } else { 0 };
        l.certs_issued = certs;
        l.att_key_multi = att_key_multi;
        l.gate = observed;
        if two_strikes {
            // A second foreign read inside the strike window, corroborated: paused as a refresh pauses.
            l.state = State::Paused;
            l.check = None;
            l.paused_until = now + self.params.pause;
            if wrote_hold {
                l.hold_set_at = now;
            }
        } else if gate_hold {
            l.state = State::CheckPending;
            l.check = gate_reason(observed).or(Some(Reason::ServiceUnavailable));
        } else if outage {
            l.state = State::CheckPending;
            l.check = Some(Reason::ServiceUnavailable);
        } else if eff == Effective::Now {
            l.state = l.watched_state(now, &self.params);
        } else {
            l.state = State::PendingNextEpoch;
        }
        if two_strikes {
            l.lease_base = now;
            l.refresh_at = l.paused_until;
        } else if outage {
            l.lease_base = now;
            l.refresh_at = now + self.params.outage_step;
        } else {
            l.renew(now, &self.params);
        }

        // A pause never takes the key from the live node the claim was to move it from.
        let keep_old = two_strikes && old.as_ref().map_or(false, |o| o.state != State::Ended);
        let mut b = Batch::default();
        b.put(Cf::Lease, node, &l);
        if !keep_old {
            b.put(Cf::Key, &hw_key, &KeyOwner { node: node.to_string(), since: now });
            if let (Some(f), Some(mut o)) = (from.as_deref(), old) {
                if o.state != State::Ended {
                    apply_release(&mut o, None, now, Reason::Rebound);
                    b.put(Cf::Lease, f, &o);
                }
            }
        }
        if counted {
            node_times.record(now, 30 * DAY);
            b.put(Cf::Limit, &node_key, &node_times);
        }
        if let (false, Some(f), Some((mut k, free))) = (keep_old, moved_from.as_deref(), rebind) {
            k.record(f, node, free, now);
            b.put(Cf::Limit, format!("k:{}", hw_key), &k);
        }
        if let Some((key, mut t)) = att {
            t.record(now, DAY);
            b.put(Cf::Limit, key, &t);
        }
        if let Some(r) = &receipt {
            b.put(Cf::Receipt, &hw_key, r);
        }
        if wrote_hold {
            b.put(Cf::Hold, &hw_key, &now);
        } else if reset || clear_hold {
            b.del(Cf::Hold, &hw_key);
        }
        if let (Some(k), Some(mut t)) = (ticket_key, ticket) {
            t.used_at = now;
            b.put(Cf::Ticket, k, &t);
        }
        let class = if two_strikes {
            EvClass::Paused
        } else if l.state == State::Suspect || judged == Some(RefreshOutcome::Strike) {
            EvClass::Suspect
        } else {
            EvClass::Accepted
        };
        if class != EvClass::Accepted {
            evidence::extend_for_review(&self.store, &mut b, node, now).db()?;
        }
        let body = json!({
            "op": req.op, "platform": req.platform.as_str(), "node": node,
            "result": {"lease": kind.as_str(), "effective": eff.as_str(), "gate_observed": observed.as_str(), "state": l.state,
                       "judged": judged.map(outcome_str)},
            "evidence": req.evidence,
            "verdict": pi.as_ref().and_then(|d| serde_json::from_slice::<Value>(&jws_payload(&d.jws)).ok()),
            "receipt": receipt.as_ref().map(|r| b64_encode(&r.der)),
            "reset": reset,
        });
        evidence::add(&mut b, &self.sealer, node, class, Some(rf.clone()), &body, now);
        self.remember_token(&mut b, &th, now);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        if two_strikes {
            self.file_ticket(&ctx, &rf, "two_strikes", EvClass::Paused, json!({}), now);
            if crate::log::is_info() {
                println!("[INFO][ORACLE] claim node={} result=two_strikes paused_until={}", node, l.paused_until);
            }
            return Err(ApiError::Refused {
                reason: Refusal::DeviceSlotPaused,
                reference: Some(rf),
                until: Some(l.paused_until),
                retry_at: None,
            });
        }

        let stmt_gate = self.gates.in_statement(observed);
        let pi_digest = pi.as_ref().map(|d| d.pi_digest.clone()).unwrap_or_default();
        let (statement, sig) = self.statement(node, &tag, kind, eff, stmt_gate, &pi_digest, now);
        let resp = json!({
            "lease_statement": statement,
            "oracle_sig": sig,
            "lease": kind,
            "effective": eff,
            "gate": stmt_gate,
            "gate_observed": observed,
            "state": l.state,
            "check": l.check,
            "lease_valid_until": l.lease_valid_until(),
            "refresh_at": l.refresh_at,
            "device_tag": hex::encode(tag),
            "pi_jws": pi.as_ref().map(|d| d.jws.clone()),
            "pi_digest": pi_digest,
            "metric": metric,
            "ref": rf,
            "superseded": prev.as_ref().map(|p| p.hw_key != hw_key && p.state != State::Ended).unwrap_or(false),
            "rebound_from": from,
            "reset": reset,
        });
        self.idem_put(th, node, &resp, now);
        if crate::log::is_info() {
            println!(
                "[INFO][ORACLE] claim node={} platform={} lease={} effective={} gate={} state={:?} judged={}",
                node,
                req.platform.as_str(),
                kind.as_str(),
                eff.as_str(),
                observed.as_str(),
                l.state,
                judged.map(outcome_str).unwrap_or("-")
            );
        }
        Ok(resp)
    }

    // ---- refresh ----

    pub fn refresh(&self, req: RefreshRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let msg = parse_device_message(&req.preimage, &self.settings.chain_id).ok_or_else(|| ApiError::bad("preimage"))?;
        if msg.kind != MsgKind::Refresh || msg.node != req.node_id {
            return Err(ApiError::bad("preimage does not match the request"));
        }
        let node = req.node_id.as_str();
        let _g = self.lock_nodes(&[node]);
        let mut l: NodeLease = self.store.get(Cf::Lease, node).db()?.ok_or(ApiError::NotFound("unknown_node"))?;
        if l.state == State::Ended {
            return Err(ApiError::Conflict("ended"));
        }
        let token = Self::token(l.platform, &req.dc_token, &req.pi_token)?;
        let tag: [u8; 32] = hex::decode(&l.device_tag).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| ApiError::Internal("tag".into()))?;
        let rf = reference(&msg.nonce, &tag);
        let ctx = Ctx { node, platform: l.platform, reference: &rf, evidence: None, op: "refresh" };
        if l.is_paused(now) {
            return Ok(json!({"result": "paused", "state": l.state, "paused_until": l.paused_until, "ref": rf}));
        }
        let th = sha256(token.as_bytes());
        if let Some(v) = self.idem_get(&th, node, now) {
            return Ok(v);
        }
        if self.replayed(&th, now)? {
            self.bad_token(now);
            return Err(ApiError::refused(Refusal::DeviceStale));
        }
        let env = env_of(l.trust);
        let mut activity = None;
        let mut verdict_json = None;
        let read = match l.platform {
            Platform::Ios => self.ios_read(token, env, &ctx, now)?,
            Platform::Android => {
                match self.play_read(token, &play_nonce_digest(&req.preimage), &ctx, now)? {
                    Play::Passed(d) if Trust::from(d.verdict.trust) == l.trust => {
                        activity = d.verdict.activity_level;
                        verdict_json = serde_json::from_slice::<Value>(&jws_payload(&d.jws)).ok();
                        l.short = verdict_short(&d.verdict) || l.prov == Prov::Factory;
                        verdict_slot(&d.verdict)
                    }
                    failed => {
                        // Rooted, unlicensed or no longer recognised: never a penalty, a check.
                        if crate::log::is_info() {
                            let code = match &failed {
                                Play::Failed(r) => r.code(),
                                Play::Passed(_) => "trust_changed",
                            };
                            println!("[INFO][ORACLE] refresh_verdict_failed node={} code={}", node, code);
                        }
                        l.state = State::CheckPending;
                        l.check = Some(Reason::VerdictFailed);
                        l.updated_at = now;
                        let mut b = Batch::default();
                        b.put(Cf::Lease, node, &l);
                        self.remember_token(&mut b, &th, now);
                        self.store.commit(b, now).map_err(ApiError::Internal)?;
                        return Ok(json!({"result": "check_pending", "state": l.state, "reason": Reason::VerdictFailed,
                                         "lease_valid_until": l.lease_valid_until(), "ref": rf}));
                    }
                }
            }
        };

        let (outcome, reason, wrote_hold, cleared_hold) = match read {
            Read::Outage => {
                let started = self.outages.started(Service::DeviceCheck).unwrap_or(now);
                let extended = apply_outage(&mut l, started, now, &self.params);
                let mut b = Batch::default();
                b.put(Cf::Lease, node, &l);
                self.store.commit(b, now).map_err(ApiError::Internal)?;
                return Ok(json!({"result": "deferred", "extended": extended, "state": l.state,
                                 "lease_valid_until": l.lease_valid_until(), "refresh_at": l.refresh_at}));
            }
            Read::NotEvaluated => {
                let was_pending = l.state == State::CheckPending;
                let gate_pending = matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh)) && self.gates.enforce;
                if !(was_pending && gate_pending) {
                    l.state = l.watched_state(now, &self.params);
                    l.check = None;
                }
                l.refreshes = l.refreshes.saturating_add(1);
                l.updated_at = now;
                l.renew(now, &self.params);
                let reason = if was_pending && l.state != State::CheckPending { Reason::CheckPassed } else { Reason::RefreshOk };
                (None, reason, false, false)
            }
            Read::Slot(s, written) => {
                let exact = self.hold_info(Some(&l), &l.hw_key)?;
                let h_expired = s.hold && hold_expired(exact, written, now, &self.params);
                let h_until = hold_until(exact, written, now, &self.params);
                let foreign = !s.hold
                    && l.has_own_value()
                    && classify(Some(&l), s.g, now, &self.params) == LeaseKind::ClaimedForeign;
                let corroborated = foreign && second_strike_pending(&l, now, &self.params) && self.corroborate(&mut l, activity, now)?;
                let plan = plan_refresh(&l, s, h_expired, corroborated, now, &self.params, &mut **self.gen.lock());
                let ok = plan.write.map(|w| self.write_slot(l.platform, token, env, w, now));
                let reason = apply_refresh(&mut l, s, plan, ok, self.gates.enforce, h_until, now, &self.params);
                let wrote_hold = plan.write.map(|w| w.hold).unwrap_or(false) && ok == Some(true);
                let cleared = h_expired && ok == Some(true);
                if cleared {
                    l.hold_set_at = 0;
                }
                (Some(plan.outcome), reason, wrote_hold, cleared)
            }
        };

        let mut b = Batch::default();
        if wrote_hold {
            b.put(Cf::Hold, &l.hw_key, &now);
        } else if cleared_hold {
            b.del(Cf::Hold, &l.hw_key);
        }
        match outcome {
            Some(RefreshOutcome::Strike) | Some(RefreshOutcome::TwoStrikes) | Some(RefreshOutcome::Hold) => {
                evidence::extend_for_review(&self.store, &mut b, node, now).db()?;
                let class = if l.state == State::Paused { EvClass::Paused } else { EvClass::Suspect };
                let body = json!({"op": "refresh", "platform": l.platform.as_str(), "node": node,
                                  "result": outcome.map(outcome_str), "state": l.state, "verdict": verdict_json});
                evidence::add(&mut b, &self.sealer, node, class, Some(rf.clone()), &body, now);
            }
            Some(RefreshOutcome::Anomaly) if l.state == State::Suspect => {
                evidence::extend_for_review(&self.store, &mut b, node, now).db()?;
            }
            _ => {}
        }
        b.put(Cf::Lease, node, &l);
        self.remember_token(&mut b, &th, now);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        if l.state == State::Paused {
            self.file_ticket(&ctx, &rf, if reason == Reason::Hold { "hold" } else { "two_strikes" }, EvClass::Paused, json!({}), now);
        }
        let resp = json!({
            "result": outcome.map(outcome_str).unwrap_or("pass"),
            "state": l.state,
            "reason": reason,
            "lease_valid_until": l.lease_valid_until(),
            "refresh_at": l.refresh_at,
            "paused_until": l.paused_until,
            "ref": rf,
        });
        self.idem_put(th, node, &resp, now);
        if crate::log::is_info() {
            println!("[INFO][ORACLE] refresh node={} result={} state={:?}", node, outcome.map(outcome_str).unwrap_or("pass"), l.state);
        }
        Ok(resp)
    }

    /// The independent signal a second strike needs (plan-technical 9.3). On iOS it may refresh the
    /// metric first, when Apple allows a new receipt.
    fn corroborate(&self, l: &mut NodeLease, activity: Option<u8>, now: u64) -> Result<bool, ApiError> {
        match l.platform {
            Platform::Ios => {
                if let (Some(aa), Some(s)) = (self.vendors.appattest.as_ref(), self.store.get::<StoredReceipt>(Cf::Receipt, &l.hw_key).db()?) {
                    let hw_pub = hex::decode(&l.hw_pub).unwrap_or_default();
                    if now >= s.not_before {
                        if let Ok(Exchange::New(new)) = self.track(Service::AppAttestData, aa.exchange(&s.der, env_of(l.trust), now)) {
                            if let Ok(r) = aa.check(&new, &hw_pub, true, now) {
                                l.metric = r.metric;
                                l.metric_at = now;
                                let mut b = Batch::default();
                                b.put(Cf::Receipt, &l.hw_key, &StoredReceipt::fresh(new, &r, now));
                                let _ = self.store.commit(b, now);
                            }
                        }
                    }
                }
                Ok(corroborated_ios(l.metric, l.metric_at, now))
            }
            Platform::Android => {
                let certs_high = self.gates.observe(Platform::Android, l.prov, None, l.certs_issued) == Gate::CertsHigh;
                Ok(corroborated_android(activity, certs_high, l.att_key_multi))
            }
        }
    }


    // ---- release ----

    pub fn release(&self, req: ReleaseRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let msg = parse_device_message(&req.preimage, &self.settings.chain_id).ok_or_else(|| ApiError::bad("preimage"))?;
        if msg.kind != MsgKind::Release || msg.node != req.node_id {
            return Err(ApiError::bad("preimage does not match the request"));
        }
        let node = req.node_id.as_str();
        let _g = self.lock_nodes(&[node]);
        let mut l: NodeLease = self.store.get(Cf::Lease, node).db()?.ok_or(ApiError::NotFound("unknown_node"))?;
        if l.state == State::Ended {
            return Ok(json!({"state": l.state, "reason": Reason::Released}));
        }
        let mut b = Batch::default();
        let mut rotated = None;
        let token = match l.platform {
            Platform::Ios => req.dc_token.as_deref(),
            Platform::Android => req.pi_token.as_deref(),
        };
        if let Some(token) = token.filter(|t| !t.is_empty()) {
            let th = sha256(token.as_bytes());
            if !self.replayed(&th, now)? {
                let own = l.pending.unwrap_or(l.g);
                let g = self.gen.lock().pick(own);
                let env = env_of(l.trust);
                // Android keeps whatever hold the device carries; iOS has none.
                let hold = match l.platform {
                    Platform::Ios => Some(false),
                    Platform::Android => {
                        let tag: [u8; 32] = hex::decode(&l.device_tag).ok().and_then(|v| v.try_into().ok()).unwrap_or([0; 32]);
                        let rf = reference(&msg.nonce, &tag);
                        let ctx = Ctx { node, platform: l.platform, reference: &rf, evidence: None, op: "release" };
                        match self.play_read(token, &play_nonce_digest(&req.preimage), &ctx, now) {
                            Ok(Play::Passed(d)) => d.verdict.device_recall.map(|r| r.third),
                            _ => None,
                        }
                    }
                };
                if let Some(hold) = hold {
                    if self.write_slot(l.platform, token, env, SlotWrite { g, hold }, now) {
                        rotated = Some(g);
                    }
                }
                self.remember_token(&mut b, &th, now);
            }
        }
        apply_release(&mut l, rotated, now, Reason::Released);
        b.put(Cf::Lease, node, &l);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        if crate::log::is_info() {
            println!("[INFO][ORACLE] release node={} rotated={}", node, rotated.is_some());
        }
        Ok(json!({"state": l.state, "reason": Reason::Released}))
    }

    // ---- rotate ----

    pub fn rotate(&self, req: RotateRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let chain = self.settings.chain_id.clone();
        let msg = parse_device_message(&req.preimage, &chain).ok_or_else(|| ApiError::bad("preimage"))?;
        if msg.kind != MsgKind::Rotate || msg.node != req.node_id {
            return Err(ApiError::bad("preimage does not match the request"));
        }
        let hw_pub = parse_hw_pub(&req.hw_pub).ok_or_else(|| ApiError::bad("hw_pub"))?;
        self.check_trust(req.trust)?;
        if req.att_key.as_deref().map(|a| !is_hex64(a)).unwrap_or(false) {
            return Err(ApiError::bad("att_key"));
        }
        let node = req.node_id.as_str();
        let hw_key = hex::encode(sha3_256(&hw_pub));
        let _g = self.lock_nodes(&[node, &hw_key]);
        let mut l: NodeLease = self.store.get(Cf::Lease, node).db()?.ok_or(ApiError::NotFound("unknown_node"))?;
        if l.state == State::Ended {
            return Err(ApiError::Conflict("ended"));
        }
        Self::check_prov(l.platform, req.prov)?;
        if msg.old_key.as_deref() != Some(l.hw_key.as_str()) {
            return Err(ApiError::Conflict("key_mismatch"));
        }
        let token = Self::token(l.platform, &req.dc_token, &req.pi_token)?;
        let tag = device_tag(&chain, l.platform, &hw_pub);
        let rf = reference(&msg.nonce, &tag);
        let ctx = Ctx { node, platform: l.platform, reference: &rf, evidence: req.evidence.as_ref(), op: "rotate" };
        if self.store.get::<KeyOwner>(Cf::Key, &hw_key).db()?.is_some() {
            return Err(ApiError::refused(Refusal::DeviceKeyInUse));
        }
        if l.is_paused(now) {
            return Err(ApiError::Refused { reason: Refusal::DeviceSlotPaused, reference: None, until: Some(l.paused_until), retry_at: None });
        }
        let th = sha256(token.as_bytes());
        if let Some(v) = self.idem_get(&th, node, now) {
            return Ok(v);
        }
        if self.replayed(&th, now)? {
            self.bad_token(now);
            return Err(ApiError::refused(Refusal::DeviceStale));
        }
        let attest = self.attest_receipt(req.receipt.as_deref(), l.platform, &hw_pub, &ctx, now)?;
        let env = env_of(req.trust);
        let mut pi: Option<Decoded> = None;
        let mut activity = None;
        let read = match l.platform {
            Platform::Ios => self.ios_read(token, env, &ctx, now)?,
            Platform::Android => {
                let d = match self.play_read(token, &play_nonce_digest(&req.preimage), &ctx, now)? {
                    Play::Passed(d) => d,
                    Play::Failed(r) => return Err(self.refuse(Refusal::from_evidence(r.reason()), &ctx, now)),
                };
                if Trust::from(d.verdict.trust) != req.trust {
                    return Err(self.refuse(Refusal::DeviceAppUnrecognized, &ctx, now));
                }
                activity = d.verdict.activity_level;
                l.short = verdict_short(&d.verdict) || req.prov == Prov::Factory;
                let read = verdict_slot(&d.verdict);
                pi = Some(d);
                read
            }
        };
        if matches!(read, Read::Outage) {
            // The old key keeps working until the rotation's hard limit; the app retries.
            return Err(ApiError::Unavailable("slot read unavailable".into()));
        }
        let (metric, metric_failed, receipt) = match l.platform {
            Platform::Ios => self.ios_metric(attest, &hw_key, &hw_pub, env, now),
            Platform::Android => (None, false, None),
        };
        if l.platform == Platform::Ios {
            l.metric = metric.or(l.metric);
            if metric.is_some() {
                l.metric_at = now;
            }
        }
        l.certs_issued = if l.platform == Platform::Android { req.certs_issued } else { None };
        let (att_key, att_key_multi) = Self::att_key_of(req.prov, &req.att_key, req.att_key_multi);
        l.att_key_multi = att_key_multi;

        let old_hw_key = l.hw_key.clone();
        // A node whose claim had no slot read gets that read's classification, not a self-reclaim.
        let mut claim_kind = None;
        let (outcome, wrote_hold, cleared_hold) = match read {
            Read::Slot(s, written) => {
                if !l.has_own_value() {
                    claim_kind = Some(classify(Some(&l), s.g, now, &self.params));
                }
                let exact = self.hold_info(Some(&l), &old_hw_key)?;
                let h_expired = s.hold && hold_expired(exact, written, now, &self.params);
                let h_until = hold_until(exact, written, now, &self.params);
                let foreign = !s.hold
                    && l.has_own_value()
                    && classify(Some(&l), s.g, now, &self.params) == LeaseKind::ClaimedForeign;
                let corroborated = foreign && second_strike_pending(&l, now, &self.params) && self.corroborate(&mut l, activity, now)?;
                let plan = plan_refresh(&l, s, h_expired, corroborated, now, &self.params, &mut **self.gen.lock());
                let ok = plan.write.map(|w| self.write_slot(l.platform, token, env, w, now));
                apply_refresh(&mut l, s, plan, ok, self.gates.enforce, h_until, now, &self.params);
                let cleared = h_expired && ok == Some(true);
                if cleared {
                    l.hold_set_at = 0;
                }
                (Some(plan.outcome), plan.write.map(|w| w.hold).unwrap_or(false) && ok == Some(true), cleared)
            }
            _ => {
                // No slot read: a gate hold waits for the new key's evidence below.
                let gate_pending = self.gates.enforce
                    && l.state == State::CheckPending
                    && matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh));
                if !gate_pending {
                    l.state = l.watched_state(now, &self.params);
                    l.check = None;
                }
                l.renew(now, &self.params);
                (None, false, false)
            }
        };
        if outcome == Some(RefreshOutcome::Hold) {
            let mut b = Batch::default();
            b.put(Cf::Lease, node, &l);
            self.store.commit(b, now).map_err(ApiError::Internal)?;
            self.file_ticket(&ctx, &rf, "hold", EvClass::Paused, json!({}), now);
            return Err(ApiError::Refused {
                reason: Refusal::DeviceSlotPaused,
                reference: Some(rf),
                until: Some(l.paused_until),
                retry_at: None,
            });
        }
        let kind = claim_kind.unwrap_or(match outcome {
            Some(RefreshOutcome::Pass) | Some(RefreshOutcome::LostWrite) => LeaseKind::SelfReclaim,
            Some(RefreshOutcome::Anomaly) => LeaseKind::ClaimedVirgin,
            Some(RefreshOutcome::Strike) | Some(RefreshOutcome::TwoStrikes) => LeaseKind::ClaimedForeign,
            _ => LeaseKind::None,
        });
        let eff = effective(kind, true);
        let observed = self.gates.observe(l.platform, req.prov, l.metric.filter(|_| l.platform == Platform::Ios), l.certs_issued);
        l.gate = observed;
        let holds = self.gates.holds_back(observed) || (self.gates.enforce && metric_failed);
        let gate_held = l.state == State::CheckPending && matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh));
        if holds && l.state.counts() {
            l.state = State::CheckPending;
            l.check = gate_reason(observed).or(Some(Reason::ServiceUnavailable));
        } else if gate_held && !holds && observed != Gate::Na {
            // The new key's evidence is the fresh measurement a gate hold waits for, and on Android the only
            // one (the certificate count comes with a chain). It passes: the hold ends with the rotation, as
            // the rotation's statement says, not at a daily recheck the genesis no longer asks for.
            l.state = l.watched_state(now, &self.params);
            l.check = None;
        }
        l.hw_key = hw_key.clone();
        l.hw_pub = hex::encode(&hw_pub);
        l.device_tag = hex::encode(tag);
        l.att_key = att_key;
        l.prov = req.prov;
        l.trust = req.trust;
        l.updated_at = now;

        let stmt_gate = self.gates.in_statement(observed);
        let pi_digest = pi.as_ref().map(|d| d.pi_digest.clone()).unwrap_or_default();
        let (statement, sig) = self.statement(node, &tag, kind, eff, stmt_gate, &pi_digest, now);

        let mut b = Batch::default();
        b.put(Cf::Lease, node, &l);
        b.put(Cf::Key, &hw_key, &KeyOwner { node: node.to_string(), since: now });
        if let Some(r) = &receipt {
            b.put(Cf::Receipt, &hw_key, r);
        }
        // The retired key's receipt is never exchanged again. The install's hold record and rebind history
        // move to the new key, so a rotation leaves no dead rows and resets no limit.
        b.del(Cf::Receipt, &old_hw_key);
        let old_hold: Option<u64> = self.store.get(Cf::Hold, &old_hw_key).db()?;
        if old_hold.is_some() {
            b.del(Cf::Hold, &old_hw_key);
        }
        if wrote_hold {
            b.put(Cf::Hold, &hw_key, &now);
        } else if let (Some(t), false) = (old_hold, cleared_hold) {
            b.put(Cf::Hold, &hw_key, &t);
        }
        let old_limit = format!("k:{}", old_hw_key);
        if let Some(k) = self.store.get::<KeyRebinds>(Cf::Limit, &old_limit).db()? {
            b.del(Cf::Limit, &old_limit);
            b.put(Cf::Limit, format!("k:{}", hw_key), &k);
        }
        let class = match l.state {
            State::Paused => EvClass::Paused,
            State::Suspect => EvClass::Suspect,
            _ => EvClass::Accepted,
        };
        if class != EvClass::Accepted {
            evidence::extend_for_review(&self.store, &mut b, node, now).db()?;
        }
        let body = json!({
            "op": "rotate", "platform": l.platform.as_str(), "node": node,
            "result": {"lease": kind.as_str(), "outcome": outcome.map(outcome_str), "state": l.state},
            "evidence": req.evidence,
            "verdict": pi.as_ref().and_then(|d| serde_json::from_slice::<Value>(&jws_payload(&d.jws)).ok()),
            "receipt": receipt.as_ref().map(|r| b64_encode(&r.der)),
        });
        evidence::add(&mut b, &self.sealer, node, class, Some(rf.clone()), &body, now);
        self.remember_token(&mut b, &th, now);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        if l.state == State::Paused {
            self.file_ticket(&ctx, &rf, "two_strikes", EvClass::Paused, json!({}), now);
        }
        let resp = json!({
            "lease_statement": statement,
            "oracle_sig": sig,
            "lease": kind,
            "effective": eff,
            "gate": stmt_gate,
            "gate_observed": observed,
            "result": outcome.map(outcome_str).unwrap_or("pass"),
            "state": l.state,
            "check": l.check,
            "lease_valid_until": l.lease_valid_until(),
            "refresh_at": l.refresh_at,
            "paused_until": l.paused_until,
            "device_tag": hex::encode(tag),
            "pi_jws": pi.as_ref().map(|d| d.jws.clone()),
            "pi_digest": pi_digest,
            "metric": metric,
            "ref": rf,
        });
        self.idem_put(th, node, &resp, now);
        Ok(resp)
    }

    // ---- daily recheck of a gate-held node ----

    pub fn recheck(&self, req: NodeRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let node = req.node_id.as_str();
        let _g = self.lock_nodes(&[node]);
        let mut l: NodeLease = self.store.get(Cf::Lease, node).db()?.ok_or(ApiError::NotFound("unknown_node"))?;
        let mut next_check = now + DAY;
        let mut b = Batch::default();
        if l.platform == Platform::Ios {
            if let (Some(aa), Some(s)) = (self.vendors.appattest.as_ref(), self.store.get::<StoredReceipt>(Cf::Receipt, &l.hw_key).db()?) {
                if now >= s.not_before {
                    let hw_pub = hex::decode(&l.hw_pub).unwrap_or_default();
                    match self.track(Service::AppAttestData, aa.exchange(&s.der, env_of(l.trust), now)) {
                        Ok(Exchange::New(new)) => {
                            if let Ok(r) = aa.check(&new, &hw_pub, true, now) {
                                l.metric = r.metric;
                                l.metric_at = now;
                                next_check = r.not_before.unwrap_or(now + DAY).max(now + HOUR);
                                b.put(Cf::Receipt, &l.hw_key, &StoredReceipt::fresh(new, &r, now));
                            }
                        }
                        Ok(Exchange::NotYet) => next_check = s.not_before.max(now + HOUR),
                        Err(_) => next_check = now + HOUR,
                    }
                } else {
                    next_check = s.not_before;
                }
            }
        }
        let observed = self.gates.observe(l.platform, l.prov, l.metric.filter(|_| l.platform == Platform::Ios), l.certs_issued);
        l.gate = observed;
        let mut reason = None;
        let gate_held = l.state == State::CheckPending && matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh));
        if gate_held && !self.gates.holds_back(observed) && observed != Gate::Na {
            l.state = l.watched_state(now, &self.params);
            l.check = None;
            reason = Some(Reason::CheckPassed);
        }
        l.updated_at = now;
        b.put(Cf::Lease, node, &l);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        // An Android count comes with an attestation chain only, so the stored one never changes: a node it
        // still holds needs a new chain, the device key rotation, which re-checks the gate itself.
        let still_held = l.state == State::CheckPending && matches!(l.check, Some(Reason::MetricHigh) | Some(Reason::CertsHigh));
        let needs = (still_held && l.platform == Platform::Android).then_some("rotation");
        Ok(json!({"state": l.state, "reason": reason, "check": l.check, "gate_observed": observed,
                  "metric": l.metric, "next_check_at": next_check, "needs": needs}))
    }

    pub fn pi_decode(&self, req: PiDecodeRequest) -> Result<Value, ApiError> {
        let now = self.now();
        let play = self.vendors.play.as_ref().ok_or_else(|| ApiError::Unavailable("android is not configured".into()))?;
        self.count_play_decode(now);
        let nonce = b64url_decode_lenient(&req.nonce).ok_or_else(|| ApiError::bad("nonce"))?;
        let d = match play.decode(&req.token, &nonce, now * 1000) {
            Ok(d) => d,
            Err(PiError::Envelope(_)) => {
                self.bad_token(now);
                return Err(ApiError::refused(Refusal::DeviceNotGenuine));
            }
            Err(PiError::Verdict(r)) => {
                if unbound(&r) {
                    self.bad_token(now);
                }
                return Err(ApiError::refused(Refusal::from_evidence(r.reason())));
            }
        };
        let v = &d.verdict;
        let licensing = match v.licensing {
            Licensing::Licensed => "licensed",
            Licensing::Unevaluated => "unevaluated",
            Licensing::Unlicensed => "unlicensed",
        };
        Ok(json!({
            "jws": d.jws, "pi_digest": d.pi_digest,
            "verdict": {"trust": Trust::from(v.trust), "licensing": licensing, "strong_integrity": v.strong_integrity,
                        "recall_evaluated": v.device_recall.is_some(), "activity_level": v.activity_level},
        }))
    }

    pub fn file_refusal(&self, req: RefusalRequest) -> Result<Value, ApiError> {
        let now = self.now();
        if !is_node_id(&req.node_id) || req.reason.is_empty() || req.reason.len() > 64 {
            return Err(ApiError::bad("node_id or reason"));
        }
        let hw_pub = parse_hw_pub(&req.hw_pub).ok_or_else(|| ApiError::bad("hw_pub"))?;
        let nonce: [u8; 32] =
            b64url_decode(&req.nonce).and_then(|v| v.try_into().ok()).ok_or_else(|| ApiError::bad("nonce"))?;
        let tag = device_tag(&self.settings.chain_id, req.platform, &hw_pub);
        let rf = reference(&nonce, &tag);
        let ctx = Ctx { node: &req.node_id, platform: req.platform, reference: &rf, evidence: req.evidence.as_ref(), op: "bind" };
        self.file_ticket(&ctx, &rf, &req.reason, EvClass::Refused, json!({}), now);
        Ok(json!({"ref": rf}))
    }

    // ---- support ----

    pub fn tickets(&self, rf: &str) -> Result<Value, ApiError> {
        if !is_reference(rf) {
            return Err(ApiError::bad("ref"));
        }
        let mut out = Vec::new();
        for (k, v) in self.store.scan(Cf::Ticket, format!("{}:", rf).as_bytes(), None, 50).db()? {
            let t = bincode::deserialize::<Ticket>(&v).map_err(|e| ApiError::Internal(format!("decode ticket: {}", e)))?;
            let ev = match &t.ev_key {
                Some(ek) => evidence::open(&self.store, &self.sealer, ek).db()?,
                None => None,
            }
            .map(|(r, body)| json!({"class": r.class, "created_at": r.created_at, "expires_at": r.expires_at, "body": body}));
            let node = String::from_utf8_lossy(&k[rf.len() + 1..]).to_string();
            out.push(json!({
                "node_id": node, "platform": t.platform, "reason": t.reason, "created_at": t.created_at,
                "approved_at": t.approved_at, "approved_by": t.approved_by, "used_at": t.used_at, "evidence": ev,
            }));
        }
        Ok(json!({"ref": rf, "tickets": out}))
    }

    pub fn approve(&self, req: ApproveRequest) -> Result<Value, ApiError> {
        let now = self.now();
        if !is_reference(&req.reference) || req.operator.trim().is_empty() || req.operator.len() > 64 {
            return Err(ApiError::bad("ref or operator"));
        }
        let found = self.store.scan(Cf::Ticket, format!("{}:", req.reference).as_bytes(), None, 50).db()?;
        let chosen: Vec<_> = found
            .into_iter()
            .filter(|(k, _)| req.node_id.as_deref().map(|n| k.ends_with(n.as_bytes())).unwrap_or(true))
            .collect();
        let (k, v) = match chosen.len() {
            0 => return Err(ApiError::NotFound("unknown_ref")),
            1 => chosen.into_iter().next().unwrap(),
            _ => return Err(ApiError::Conflict("several_tickets_name_the_node")),
        };
        let mut t: Ticket = bincode::deserialize(&v).map_err(|e| ApiError::Internal(e.to_string()))?;
        if t.used_at > 0 {
            return Err(ApiError::Conflict("already_used"));
        }
        t.approved_at = now;
        t.approved_by = req.operator.trim().to_string();
        let mut b = Batch::default();
        b.put(Cf::Ticket, &k, &t);
        self.store.commit(b, now).map_err(ApiError::Internal)?;
        if crate::log::is_warn() {
            println!("[WARN][ORACLE] reset_ticket_approved ref={} node={}", req.reference, t.node);
        }
        Ok(json!({"ref": req.reference, "node_id": t.node, "approved_at": now, "valid_until": now + APPROVAL_VALID}))
    }

    // ---- revocation snapshot ----

    /// Fetches the list when due; returns the seconds until the next attempt.
    pub fn refresh_crl(&self) -> u64 {
        let now = self.now();
        match self.track(Service::Crl, crl::fetch(self.vendors.http.as_ref(), &self.settings.crl_url)) {
            Ok((list, next)) => {
                let s = crl::snapshot(&list, now, &self.signer);
                if crate::log::is_info() {
                    println!("[INFO][ORACLE] crl_snapshot serials={} next_secs={}", s.serials.len(), next);
                }
                *self.crl.write() = Some(s);
                next
            }
            Err(_) => {
                let age = self.crl.read().as_ref().map(|s| now.saturating_sub(s.fetched_at)).unwrap_or(u64::MAX);
                if age > CRL_ALERT_AGE {
                    self.alerts.raise("crl_stale", &format!("snapshot_age_secs={}", age.min(99 * DAY)), now);
                }
                HOUR / 4
            }
        }
    }

    pub fn crl_snapshot(&self) -> Result<Value, ApiError> {
        match self.crl.read().as_ref() {
            Some(s) => Ok(serde_json::to_value(s).map_err(|e| ApiError::Internal(e.to_string()))?),
            None => Err(ApiError::Unavailable("no revocation snapshot yet".into())),
        }
    }

    // ---- maintenance ----

    /// Purges expired replay entries, evidence, tickets and old log entries.
    pub fn maintain(&self) {
        let now = self.now();
        // Page by page until nothing expired is left: a day of tokens at 10 M nodes clears in one pass.
        let failed = |what: &str, e: String| self.alerts.raise("maintenance_read_failed", &format!("{} {}", what, e), now);
        'replay: for _ in 0..MAINTENANCE_PAGES {
            let keys = match self.store.keys_below(Cf::ReplayExp, &(now + 1).to_be_bytes(), 10_000) {
                Ok(k) => k,
                Err(e) => {
                    failed("replay_exp", e);
                    break;
                }
            };
            if keys.is_empty() {
                break;
            }
            let mut b = Batch::default();
            for k in &keys {
                b.del(Cf::ReplayExp, k);
                if let Some(h) = k.get(8..) {
                    match self.store.get::<u64>(Cf::Replay, h) {
                        Ok(Some(exp)) if exp <= now => b.del(Cf::Replay, h),
                        Ok(_) => {}
                        Err(e) => {
                            failed("replay", e);
                            break 'replay;
                        }
                    }
                }
            }
            if self.store.commit(b, now).is_err() || keys.len() < 10_000 {
                break;
            }
        }
        for _ in 0..MAINTENANCE_PAGES {
            match evidence::purge(&self.store, now) {
                Ok(n) if n >= evidence::PURGE_PAGE => continue,
                Ok(_) => break,
                Err(e) => {
                    self.alerts.raise("evidence_purge_failed", &e, now);
                    break;
                }
            }
        }
        // Tickets have no expiry index: each pass scans a bounded slice, resuming where the last one stopped.
        let mut cursor = self.ticket_cursor.lock();
        for _ in 0..TICKET_PAGES_PER_PASS {
            let page = match self.store.scan(Cf::Ticket, b"", cursor.as_deref(), 1_000) {
                Ok(p) => p,
                Err(e) => {
                    failed("ticket", e);
                    break;
                }
            };
            if page.is_empty() {
                *cursor = None;
                break;
            }
            let mut b = Batch::default();
            for (k, v) in &page {
                if let Ok(t) = bincode::deserialize::<Ticket>(v) {
                    if now > t.created_at + TICKET_KEEP && (t.approved_at == 0 || now > t.approved_at + APPROVAL_VALID) {
                        b.del(Cf::Ticket, k);
                    }
                }
            }
            *cursor = page.last().map(|(k, _)| k.clone());
            if self.store.commit(b, now).is_err() {
                break;
            }
        }
        drop(cursor);
        self.idem.lock().retain(|_, (t, _, _)| now < *t + IDEMPOTENT_WINDOW);
        self.trim_replication_log();
    }

    /// Drops replication log entries older than `log_keep`. A standby runs only this: its records change
    /// through the primary's log alone, and it keeps the same window because, once promoted, it serves
    /// that log to the next standby.
    pub fn trim_replication_log(&self) {
        let before = self.now().saturating_sub(self.settings.log_keep);
        for _ in 0..MAINTENANCE_PAGES {
            if self.store.trim_log(before) < crate::store::TRIM_PAGE {
                break;
            }
        }
    }

    pub fn health(&self, role: &str) -> Value {
        let now = self.now();
        let crl_age = self.crl.read().as_ref().map(|s| now.saturating_sub(s.fetched_at));
        json!({
            "role": role,
            "network": self.settings.network,
            "seq": self.store.seq(),
            "schema": crate::store::SCHEMA,
            "synced": self.store.synced().ok(),
            "sync_in_progress": self.store.sync_in_progress().ok(),
            "crl_age_secs": crl_age,
            "outages": self.outages.snapshot().into_iter().map(|(s, t, n)| json!({"service": s, "since": t, "failures": n})).collect::<Vec<_>>(),
            "oracle_key_sha3": hex::encode(sha3_256(self.signer.public_key())),
        })
    }

    // ---- replication (primary side) ----

    pub fn replica_status(&self) -> Value {
        json!({"seq": self.store.seq(), "first_log_seq": self.store.first_log_seq(), "schema": crate::store::SCHEMA})
    }

    pub fn replica_log(&self, after: u64, limit: usize) -> Result<Value, ApiError> {
        let entries = self.store.log_after(after, limit.clamp(1, 1000)).map_err(|_| ApiError::Conflict("trimmed"))?;
        let blob = bincode::serialize(&entries).map_err(|e| ApiError::Internal(e.to_string()))?;
        Ok(json!({"entries": b64_encode(&blob), "count": entries.len(), "schema": crate::store::SCHEMA}))
    }

    pub fn replica_dump(&self, cf: &str, after: Option<&str>, limit: usize) -> Result<Value, ApiError> {
        let cf = Cf::parse(cf).ok_or_else(|| ApiError::bad("cf"))?;
        let after = match after {
            Some(h) if !h.is_empty() => Some(hex::decode(h).map_err(|_| ApiError::bad("after"))?),
            _ => None,
        };
        let page = self.store.scan(cf, b"", after.as_deref(), limit.clamp(1, 1000)).db()?;
        let blob = bincode::serialize(&page).map_err(|e| ApiError::Internal(e.to_string()))?;
        let last = page.last().map(|(k, _)| hex::encode(k));
        Ok(json!({"page": b64_encode(&blob), "count": page.len(), "last": last}))
    }
}

/// The payload bytes of a compact signed token (already verified by the caller).
fn jws_payload(jws: &str) -> Vec<u8> {
    jws.split('.').nth(1).and_then(b64url_decode_lenient).unwrap_or_default()
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

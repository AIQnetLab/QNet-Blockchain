//! Certified state proofs: `?mb=latest|<j>` on the account and token balance proof routes, and
//! `GET /api/v1/state/certified`. Every proof is built on a dedicated proof thread over a view whose
//! root the committee certified in macroblock j (`storage/proof_views.rs`); nothing here reads live
//! state or takes a state lock. Without `mb` the legacy handlers answer, byte for byte.
//!
//! A client verifies macroblock j itself and folds to that checkpoint's `state_root`, never to the
//! root served here, so a node can only withhold, serve an older index or refuse.

use super::*;
use crate::storage::{AccountAnswer, ContractStatus, ProofFailure, ProofSteps, ProofViews, Storage, TokenAnswer, View};
use qnet_state::{AccountLeafPreimage, LeafProofKind};
use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};
use warp::http::{header, HeaderValue, StatusCode};

/// The form of every certified body, errors included: a client tells a new node's answer from a
/// legacy body by it.
pub(crate) const PROOF_FORMAT: u32 = 2;
pub(crate) const CERTIFIED_PROOF_BUCKET: &str = "certified_proof";
pub(crate) const CERTIFIED_STATE_BUCKET: &str = "certified_state";
/// Bytes of explicit-index bodies kept for repeat reads: a hot-set cache, not the scaling mechanism.
pub(crate) const PROOF_ANSWER_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// Proof jobs one source (an IPv4 address or an IPv6 /64) may have queued or running.
pub(crate) const PROOF_PREFIX_INFLIGHT: u32 = 2;
/// A job not started this long after admission is dropped: its caller is answered `busy`.
const PROOF_START_DEADLINE: Duration = Duration::from_secs(1);
/// The longest a request waits for its proof.
const PROOF_ANSWER_DEADLINE: Duration = Duration::from_secs(3);
const KEY_MAX_CHARS: usize = 64;
const MB_MAX_DIGITS: usize = 20;
/// An explicit index names an irrevocable body; 300 s covers the window a client pins it and bounds a
/// shared cache's exposure if the index is ever retracted.
const CACHE_EXPLICIT: &str = "public, max-age=300, immutable";
const CACHE_LATEST: &str = "public, max-age=10";
const CACHE_STATE: &str = "public, max-age=5";
const CACHE_NONE: &str = "no-store";
const KIND_ACCOUNT: u8 = 0;
const KIND_TOKEN: u8 = 1;

/// Which view a request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MbSelector {
    Latest,
    Index(u64),
}

/// Whether the request asks for the certified form at all: any `mb` key, even a malformed one, which
/// then gets the typed 400 rather than a legacy body.
pub(crate) fn wants_certified(query: &[(String, String)]) -> bool {
    query.iter().any(|(k, _)| k == "mb")
}

/// Exactly one `mb`: `latest`, or a decimal index from 1 with at most 20 digits.
pub(crate) fn parse_mb(query: &[(String, String)]) -> Result<MbSelector, ()> {
    let mut values = query.iter().filter(|(k, _)| k == "mb").map(|(_, v)| v.as_str());
    let v = values.next().ok_or(())?;
    if values.next().is_some() {
        return Err(());
    }
    if v == "latest" {
        return Ok(MbSelector::Latest);
    }
    if v.is_empty() || v.len() > MB_MAX_DIGITS || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    match v.parse::<u64>() {
        Ok(j) if j >= 1 => Ok(MbSelector::Index(j)),
        _ => Err(()),
    }
}

/// An address, contract or holder as a path segment: 1 to 64 printable ASCII characters.
pub(crate) fn valid_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= KEY_MAX_CHARS && s.bytes().all(|b| b.is_ascii_graphic())
}

/// The source a limit counts a caller under: an IPv4 address (also one mapped into IPv6) as is, an
/// IPv6 address by its /64, the block one host is given.
pub(crate) fn limiter_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// The caller as the certified routes meter it.
#[derive(Debug, Clone, Copy)]
struct Source {
    key: IpAddr,
    /// Whitelisted (this host, operator-listed addresses): no rate limit and no in-flight cap.
    exempt: bool,
}

fn admit_source(remote: Option<SocketAddr>, bucket: &str, views: &ProofViews) -> Result<Source, warp::reply::Response> {
    let ip = remote.map(|a| a.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let key = limiter_key(ip);
    if is_ip_whitelisted(ip) {
        return Ok(Source { key, exempt: true });
    }
    let (allowed, retry_after) = API_RATE_LIMITER.check_rate_limit(key, bucket);
    if allowed {
        Ok(Source { key, exempt: false })
    } else {
        views.stats.rate_limited.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Err(rate_limited(retry_after))
    }
}

// ─── Replies ────────────────────────────────────────────────────────────────────────────────────

fn json_response(status: StatusCode, body: String, cache: &'static str, retry_after: Option<u64>) -> warp::reply::Response {
    let mut r = warp::reply::Response::new(warp::hyper::Body::from(body));
    *r.status_mut() = status;
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Some(secs) = retry_after {
        h.insert(header::RETRY_AFTER, HeaderValue::from(secs));
    }
    r
}

/// Every error of the new form: typed, `proof_format` 2, never stored by a cache.
fn error_response(status: StatusCode, error: &str, mut fields: serde_json::Map<String, Value>, retry_after: Option<u64>) -> warp::reply::Response {
    fields.insert("proof_format".into(), json!(PROOF_FORMAT));
    fields.insert("error".into(), json!(error));
    if let Some(secs) = retry_after {
        fields.insert("retry_after_seconds".into(), json!(secs));
    }
    json_response(status, Value::Object(fields).to_string(), CACHE_NONE, retry_after)
}

fn fields(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn bad_parameter(parameter: &str) -> warp::reply::Response {
    error_response(StatusCode::BAD_REQUEST, "bad_parameter", fields(&[("parameter", json!(parameter))]), None)
}

fn rate_limited(retry_after: u64) -> warp::reply::Response {
    error_response(StatusCode::TOO_MANY_REQUESTS, "rate_limited", serde_json::Map::new(), Some(retry_after.max(1)))
}

fn busy(views: &ProofViews) -> warp::reply::Response {
    views.stats.busy.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    error_response(StatusCode::SERVICE_UNAVAILABLE, "busy", serde_json::Map::new(), Some(1))
}

fn not_certified(views: &ProofViews, index: u64, newest: u64) -> warp::reply::Response {
    views.stats.not_certified.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    error_response(StatusCode::NOT_FOUND, "macroblock_not_certified",
                   fields(&[("macroblock_index", json!(index)), ("newest_certified_index", json!(newest))]), None)
}

fn not_retained(views: &ProofViews, index: u64, servable: &[u64]) -> warp::reply::Response {
    views.stats.not_retained.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    error_response(StatusCode::GONE, "view_not_retained",
                   fields(&[("macroblock_index", json!(index)), ("servable", json!(servable))]), None)
}

/// 503 for a state that passes: a node warming up retries in 30 s, disk pressure in 60, anything
/// else in 5.
fn unavailable(views: &ProofViews, reason: &str, servable: &[u64]) -> warp::reply::Response {
    views.stats.unavailable.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let retry = match reason { "warming" => 30, "disk_pressure" => 60, _ => 5 };
    error_response(StatusCode::SERVICE_UNAVAILABLE, "certified_state_unavailable",
                   fields(&[("reason", json!(reason)), ("servable", json!(servable))]), Some(retry))
}

/// What capture looks like from outside: a refusal, `warming` while no view is held yet, else `ok`.
fn capture_state(views: &ProofViews, held: usize) -> &'static str {
    match views.capture_state() {
        "ok" if held == 0 => "warming",
        s => s,
    }
}

// ─── Bodies ─────────────────────────────────────────────────────────────────────────────────────

/// An explicit-index body: one JSON object, so the `latest` form appends `servable` to it without
/// parsing it again. Built only from a non-empty map.
#[derive(Clone)]
struct ObjectBody(Arc<str>);

impl ObjectBody {
    fn of(map: serde_json::Map<String, Value>) -> Self {
        debug_assert!(!map.is_empty());
        ObjectBody(Value::Object(map).to_string().into())
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    /// The `latest` body: the same object with `servable` added as its last member.
    fn with_servable(&self, servable: &[u64]) -> String {
        let s = self.as_str();
        format!("{},\"servable\":{}}}", &s[..s.len() - 1], json!(servable))
    }
}

fn hex32(b: &[u8; 32]) -> Value {
    Value::String(hex::encode(b))
}

fn steps_json(steps: &ProofSteps) -> Value {
    Value::Array(steps.iter().map(|(sib, right)| json!({ "sibling": hex::encode(sib), "is_right": right })).collect())
}

fn kind_name(kind: &LeafProofKind) -> &'static str {
    match kind {
        LeafProofKind::Inclusion(_) => "inclusion",
        LeafProofKind::Absence => "absence",
        LeafProofKind::AbsenceInBucket(_) => "absence_in_bucket",
    }
}

fn bucket_entries(kind: &LeafProofKind) -> Option<Value> {
    match kind {
        LeafProofKind::AbsenceInBucket(entries) => Some(Value::Array(
            entries.iter().map(|(k, v)| json!({ "key": hex::encode(k), "leaf": hex::encode(v) })).collect(),
        )),
        _ => None,
    }
}

/// Every field the account leaf hashes besides the address, zero for an absent account. u64 values
/// are decimal strings, so a client reads them exactly; the u16 slot masks are numbers.
fn insert_leaf_fields(m: &mut serde_json::Map<String, Value>, balance: &str, nonce: &str, f: Option<&AccountLeafPreimage>) {
    let text = |x: u64| Value::String(x.to_string());
    m.insert(balance.into(), text(f.map_or(0, |f| f.balance)));
    m.insert(nonce.into(), text(f.map_or(0, |f| f.nonce)));
    m.insert("is_contract".into(), json!(f.map_or(false, |f| f.is_contract)));
    m.insert("is_node".into(), json!(f.map_or(false, |f| f.is_node)));
    m.insert("contract_code_hash".into(), json!(f.and_then(|f| f.contract_code_hash.clone())));
    m.insert("storage_root".into(), match f {
        Some(f) if f.is_contract => hex32(&f.storage_root),
        _ => Value::Null,
    });
    m.insert("heartbeat_epoch".into(), text(f.map_or(0, |f| f.heartbeat_epoch)));
    m.insert("heartbeat_slots".into(), json!(f.map_or(0, |f| f.heartbeat_slots)));
    m.insert("heartbeat_final_epoch".into(), text(f.map_or(0, |f| f.heartbeat_final_epoch)));
    m.insert("heartbeat_final_slots".into(), json!(f.map_or(0, |f| f.heartbeat_final_slots)));
    m.insert("last_claimed_epoch".into(), text(f.map_or(0, |f| f.last_claimed_epoch)));
    m.insert("banned_at_height".into(), text(f.map_or(0, |f| f.banned_at_height)));
}

fn anchor_fields(m: &mut serde_json::Map<String, Value>, view: &View) {
    m.insert("proof_format".into(), json!(PROOF_FORMAT));
    m.insert("macroblock_index".into(), json!(view.index));
    m.insert("state_height".into(), json!(view.height));
    m.insert("state_root".into(), hex32(&view.root));
}

/// The account body. There is no `block_height`: the APPLIED tip and the certified height never
/// share a field.
fn account_body(view: &View, address: &str, a: &AccountAnswer) -> ObjectBody {
    let mut m = serde_json::Map::new();
    anchor_fields(&mut m, view);
    m.insert("address".into(), json!(address));
    m.insert("exists".into(), json!(a.fields.is_some()));
    m.insert("proof_kind".into(), json!(kind_name(&a.kind)));
    insert_leaf_fields(&mut m, "balance", "nonce", a.fields.as_ref());
    m.insert("merkle_proof".into(), steps_json(&a.steps));
    if let Some(e) = bucket_entries(&a.kind) {
        m.insert("bucket_entries".into(), e);
    }
    ObjectBody::of(m)
}

fn token_body(view: &View, contract: &str, holder: &str, t: &TokenAnswer) -> ObjectBody {
    let mut m = serde_json::Map::new();
    anchor_fields(&mut m, view);
    m.insert("contract_address".into(), json!(contract));
    m.insert("holder".into(), json!(holder));
    m.insert("contract_status".into(), json!(t.status.name()));
    m.insert("account_proof_kind".into(), json!(kind_name(&t.account.kind)));
    m.insert("account_proof".into(), steps_json(&t.account.steps));
    if let Some(e) = bucket_entries(&t.account.kind) {
        m.insert("account_bucket_entries".into(), e);
    }
    insert_leaf_fields(&mut m, "account_balance", "account_nonce", t.account.fields.as_ref());
    if let (ContractStatus::Contract, Some(s)) = (t.status, t.storage.as_ref()) {
        m.insert("storage_proof_kind".into(), json!(kind_name(&s.kind)));
        m.insert("token_balance".into(), json!(s.value.as_deref().unwrap_or("0")));
        m.insert("storage_proof".into(), steps_json(&s.steps));
        if let Some(e) = bucket_entries(&s.kind) {
            m.insert("storage_bucket_entries".into(), e);
        }
    }
    ObjectBody::of(m)
}

// ─── Answer cache ───────────────────────────────────────────────────────────────────────────────

/// (index, view root, kind, address or contract, holder). The root makes a key name one irrevocable
/// body even if an index were ever certified twice across a retraction.
type CacheKey = (u64, [u8; 32], u8, Box<str>, Box<str>);

/// Byte-bounded LRU of explicit-index bodies.
pub(crate) struct AnswerCache {
    cap: usize,
    inner: parking_lot::Mutex<CacheInner>,
}

#[derive(Default)]
struct CacheInner {
    map: HashMap<CacheKey, (ObjectBody, u64)>,
    order: BTreeMap<u64, CacheKey>,
    bytes: usize,
    tick: u64,
}

fn entry_bytes(k: &CacheKey, v: &ObjectBody) -> usize {
    // Body, key text, and the two map entries' own overhead.
    v.as_str().len() + k.3.len() + k.4.len() + 160
}

impl AnswerCache {
    pub(crate) fn new(cap: usize) -> Self {
        Self { cap, inner: parking_lot::Mutex::new(CacheInner::default()) }
    }

    fn get(&self, k: &CacheKey) -> Option<ObjectBody> {
        let mut g = self.inner.lock();
        let inner = &mut *g;
        inner.tick += 1;
        let tick = inner.tick;
        let (body, old) = match inner.map.get_mut(k) {
            Some((body, t)) => (body.clone(), std::mem::replace(t, tick)),
            None => return None,
        };
        if let Some(key) = inner.order.remove(&old) {
            inner.order.insert(tick, key);
        }
        Some(body)
    }

    fn insert(&self, k: CacheKey, v: ObjectBody) {
        let size = entry_bytes(&k, &v);
        if size > self.cap {
            return;
        }
        let mut g = self.inner.lock();
        let inner = &mut *g;
        if let Some((old, t)) = inner.map.remove(&k) {
            inner.order.remove(&t);
            inner.bytes -= entry_bytes(&k, &old);
        }
        while inner.bytes + size > self.cap {
            let Some((_, oldest)) = inner.order.pop_first() else { break };
            if let Some((old, _)) = inner.map.remove(&oldest) {
                inner.bytes -= entry_bytes(&oldest, &old);
            }
        }
        inner.tick += 1;
        let tick = inner.tick;
        inner.order.insert(tick, k.clone());
        inner.map.insert(k, (v, tick));
        inner.bytes += size;
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.inner.lock().bytes
    }
}

static ANSWER_CACHE: Lazy<AnswerCache> = Lazy::new(|| AnswerCache::new(PROOF_ANSWER_CACHE_BYTES));

// ─── Proof pool ─────────────────────────────────────────────────────────────────────────────────

/// Dedicated proof threads: a quarter of the cores, at least 2 and at most 8, so proof traffic has a
/// fixed CPU share and never takes the runtime's blocking pool.
pub(crate) fn proof_threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 4).clamp(2, 8)
}

struct PoolJob {
    admitted: Instant,
    run: Box<dyn FnOnce() + Send>,
}

struct ProofPool {
    tx: crossbeam::channel::Sender<PoolJob>,
    threads: usize,
}

impl ProofPool {
    fn start() -> Self {
        let threads = proof_threads();
        let (tx, rx) = crossbeam::channel::bounded::<PoolJob>(4 * threads);
        let mut started = 0;
        for n in 0..threads {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("qnet-proof-{}", n))
                .spawn(move || {
                    while let Ok(job) = rx.recv() {
                        // Its caller stopped waiting: dropping the job answers it `busy`.
                        if job.admitted.elapsed() > PROOF_START_DEADLINE {
                            continue;
                        }
                        (job.run)();
                    }
                });
            match spawned {
                Ok(_) => started += 1,
                Err(e) => eprintln!("[ERR][RPC] proof_thread_spawn_failed n={} err={}", n, e),
            }
        }
        if is_info() {
            println!("[INFO][RPC] proof_pool_started threads={} queue={}", started, 4 * threads);
        }
        Self { tx, threads: started }
    }

    fn submit(&self, job: PoolJob) -> bool {
        self.threads > 0 && self.tx.try_send(job).is_ok()
    }
}

static PROOF_POOL: Lazy<ProofPool> = Lazy::new(ProofPool::start);

/// Jobs per source, queued or running. An entry exists only while its count is above zero.
static PROOF_INFLIGHT: Lazy<DashMap<IpAddr, u32>> = Lazy::new(DashMap::new);

/// One admitted job of a source; dropping it frees the slot.
struct InflightSlot(Option<IpAddr>);

impl InflightSlot {
    fn take(source: Source) -> Option<Self> {
        if source.exempt {
            return Some(InflightSlot(None));
        }
        let mut n = PROOF_INFLIGHT.entry(source.key).or_insert(0);
        if *n >= PROOF_PREFIX_INFLIGHT {
            return None;
        }
        *n += 1;
        Some(InflightSlot(Some(source.key)))
    }
}

impl Drop for InflightSlot {
    fn drop(&mut self) {
        if let Some(key) = self.0 {
            if let Some(mut n) = PROOF_INFLIGHT.get_mut(&key) {
                *n = n.saturating_sub(1);
            }
            PROOF_INFLIGHT.remove_if(&key, |_, n| *n == 0);
        }
    }
}

enum Pooled<T> {
    Done(T),
    Busy,
}

/// Run `job` on a proof thread under one of `source`'s in-flight slots: refused at once when the
/// source holds its two or the queue is full, `busy` when it does not start within 1 s or finish
/// within 3 s.
async fn run_pooled<T: Send + 'static>(source: Source, job: impl FnOnce() -> T + Send + 'static) -> Pooled<T> {
    let Some(slot) = InflightSlot::take(source) else { return Pooled::Busy };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let run = Box::new(move || {
        let _slot = slot;
        let _ = tx.send(job());
    });
    if !PROOF_POOL.submit(PoolJob { admitted: Instant::now(), run }) {
        return Pooled::Busy;
    }
    match tokio::time::timeout(PROOF_ANSWER_DEADLINE, rx).await {
        Ok(Ok(v)) => Pooled::Done(v),
        _ => Pooled::Busy,
    }
}

// ─── Handlers ───────────────────────────────────────────────────────────────────────────────────

/// The view a selector names, with every index this node serves (newest first). O(1) in memory: no
/// storage read decides a 404, 410 or 503.
fn select_view(views: &ProofViews, mb: MbSelector) -> Result<(Arc<View>, Vec<u64>), warp::reply::Response> {
    let set = views.current();
    let servable: Vec<u64> = set.views.iter().map(|v| v.index).collect();
    match mb {
        MbSelector::Latest => match set.views.first() {
            Some(v) => Ok((Arc::clone(v), servable)),
            None => Err(unavailable(views, capture_state(views, 0), &servable)),
        },
        MbSelector::Index(j) => {
            if let Some(v) = set.views.iter().find(|v| v.index == j) {
                return Ok((Arc::clone(v), servable));
            }
            let newest = views.newest_certified_index();
            if j > newest {
                Err(not_certified(views, j, newest))
            } else {
                Err(not_retained(views, j, &servable))
            }
        }
    }
}

fn served(views: &ProofViews, body: &ObjectBody, mb: MbSelector, servable: &[u64]) -> warp::reply::Response {
    views.stats.served.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    match mb {
        MbSelector::Latest => json_response(StatusCode::OK, body.with_servable(servable), CACHE_LATEST, None),
        MbSelector::Index(_) => json_response(StatusCode::OK, body.as_str().to_string(), CACHE_EXPLICIT, None),
    }
}

/// The steps shared by both proof routes once the target keys are valid: view, cache, pool, answer.
async fn certified_answer(
    storage: Arc<Storage>,
    source: Source,
    mb: MbSelector,
    kind: u8,
    keys: (String, String),
    build: fn(&Storage, &View, &str, &str) -> Result<ObjectBody, ProofFailure>,
) -> warp::reply::Response {
    let views = Arc::clone(storage.proof_views());
    let (view, servable) = match select_view(&views, mb) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let key: CacheKey = (view.index, view.root, kind, keys.0.as_str().into(), keys.1.as_str().into());
    if let Some(body) = ANSWER_CACHE.get(&key) {
        views.stats.cache_hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return served(&views, &body, mb, &servable);
    }
    let job_view = Arc::clone(&view);
    let job = move || build(&storage, &job_view, &keys.0, &keys.1);
    match run_pooled(source, job).await {
        Pooled::Done(Ok(body)) => {
            ANSWER_CACHE.insert(key, body.clone());
            served(&views, &body, mb, &servable)
        }
        Pooled::Done(Err(failure)) => unavailable(&views, failure.reason(), &servable),
        Pooled::Busy => busy(&views),
    }
}

fn build_account(storage: &Storage, view: &View, address: &str, _: &str) -> Result<ObjectBody, ProofFailure> {
    storage.certified_account_proof(view, address).map(|a| account_body(view, address, &a))
}

fn build_token(storage: &Storage, view: &View, contract: &str, holder: &str) -> Result<ObjectBody, ProofFailure> {
    storage.certified_token_proof(view, contract, holder).map(|t| token_body(view, contract, holder, &t))
}

/// `?mb=` on the account route: rate limit, parameters, then the certified answer.
pub(crate) async fn certified_account_reply(
    storage: Arc<Storage>,
    address: String,
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
) -> warp::reply::Response {
    let source = match admit_source(remote, CERTIFIED_PROOF_BUCKET, storage.proof_views()) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(mb) = parse_mb(&query) else { return bad_parameter("mb") };
    if !valid_key(&address) {
        return bad_parameter("address");
    }
    certified_answer(storage, source, mb, KIND_ACCOUNT, (address, String::new()), build_account).await
}

/// `?mb=` on the token route.
pub(crate) async fn certified_token_reply(
    storage: Arc<Storage>,
    contract: String,
    holder: String,
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
) -> warp::reply::Response {
    let source = match admit_source(remote, CERTIFIED_PROOF_BUCKET, storage.proof_views()) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(mb) = parse_mb(&query) else { return bad_parameter("mb") };
    if !valid_key(&contract) {
        return bad_parameter("contract");
    }
    if !valid_key(&holder) {
        return bad_parameter("holder");
    }
    certified_answer(storage, source, mb, KIND_TOKEN, (contract, holder), build_token).await
}

/// `/api/v1/state/certified`: the served views and the three heights, each under its own name.
pub(crate) fn state_certified_reply(storage: &Storage, remote: Option<SocketAddr>) -> warp::reply::Response {
    let views = storage.proof_views();
    if let Err(r) = admit_source(remote, CERTIFIED_STATE_BUCKET, views) {
        return r;
    }
    let set = views.current();
    let listed: Vec<Value> = set.views.iter()
        .map(|v| json!({ "macroblock_index": v.index, "state_height": v.height, "state_root": hex::encode(v.root) }))
        .collect();
    let body = json!({
        "proof_format": PROOF_FORMAT,
        "views": listed,
        "newest_certified_index": views.newest_certified_index(),
        "finalized_height": crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst),
        "applied_height": crate::node::local_height(),
        "capture": capture_state(views, set.views.len()),
    });
    json_response(StatusCode::OK, body.to_string(), CACHE_STATE, None)
}

pub(super) async fn handle_account_balance_proof_route(
    address: String,
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    if !wants_certified(&query) {
        return super::queries_api::handle_account_balance_with_proof(address, remote, blockchain).await
            .map(|r| r.into_response());
    }
    Ok(certified_account_reply(blockchain.get_storage(), address, query, remote).await)
}

pub(super) async fn handle_token_balance_proof_route(
    contract: String,
    holder: String,
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    if !wants_certified(&query) {
        return super::queries_api::handle_token_balance_with_proof(contract, holder, remote, blockchain).await
            .map(|r| r.into_response());
    }
    Ok(certified_token_reply(blockchain.get_storage(), contract, holder, query, remote).await)
}

pub(super) async fn handle_state_certified(
    remote: Option<SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    Ok(state_certified_reply(&blockchain.get_storage(), remote))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::proof_view_rig::*;
    use qnet_state::{Account, StateMerkleTree};

    const TOKEN: &str = "eon_cp_token";

    fn holder(i: u64) -> String {
        format!("eon_cp_h{:04}", i)
    }

    fn q(mb: &str) -> Vec<(String, String)> {
        vec![("mb".to_string(), mb.to_string())]
    }

    fn remote(ip: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(ip.parse().unwrap(), 0))
    }

    async fn parts(r: warp::reply::Response) -> (StatusCode, warp::http::HeaderMap, Value) {
        let status = r.status();
        let headers = r.headers().clone();
        let bytes = warp::hyper::body::to_bytes(r.into_body()).await.unwrap();
        (status, headers, serde_json::from_slice(&bytes).unwrap())
    }

    fn cache_control(h: &warp::http::HeaderMap) -> &str {
        h.get(header::CACHE_CONTROL).unwrap().to_str().unwrap()
    }

    fn hex_to_32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&hex::decode(s).unwrap());
        out
    }

    /// The leaf fields as a client reads them off the wire.
    fn preimage_from(v: &Value, balance: &str, nonce: &str) -> AccountLeafPreimage {
        let text = |k: &str| v[k].as_str().unwrap_or_else(|| panic!("{} is a string", k)).parse::<u64>().unwrap();
        let slots = |k: &str| u16::try_from(v[k].as_u64().unwrap_or_else(|| panic!("{} is a number", k))).unwrap();
        AccountLeafPreimage {
            balance: text(balance),
            nonce: text(nonce),
            is_contract: v["is_contract"].as_bool().unwrap(),
            is_node: v["is_node"].as_bool().unwrap(),
            contract_code_hash: v["contract_code_hash"].as_str().map(str::to_string),
            storage_root: v["storage_root"].as_str().map(hex_to_32).unwrap_or([0u8; 32]),
            heartbeat_epoch: text("heartbeat_epoch"),
            heartbeat_slots: slots("heartbeat_slots"),
            heartbeat_final_epoch: text("heartbeat_final_epoch"),
            heartbeat_final_slots: slots("heartbeat_final_slots"),
            last_claimed_epoch: text("last_claimed_epoch"),
            banned_at_height: text("banned_at_height"),
        }
    }

    fn steps_from(v: &Value) -> ProofSteps {
        v.as_array().unwrap().iter()
            .map(|s| (hex_to_32(s["sibling"].as_str().unwrap()), s["is_right"].as_bool().unwrap()))
            .collect()
    }

    fn entries_from(v: &Value) -> Vec<([u8; 32], [u8; 32])> {
        v.as_array().unwrap().iter()
            .map(|e| (hex_to_32(e["key"].as_str().unwrap()), hex_to_32(e["leaf"].as_str().unwrap())))
            .collect()
    }

    /// Wallets, a node, a banned node and a 40-holder token restored; holder 3 drained at block 45;
    /// view 1 certified at 90. `salt` makes each test's state (and root) its own, so no test reads
    /// another's cached answer; `before_capture` may change the live aux DB first.
    fn setup(salt: u64, before_capture: impl Fn(&Rig)) -> (Rig, [u8; 32]) {
        let r = rig();
        let mut all: Vec<(String, Account)> = (0..50)
            .map(|i| { let a = wallet(i, 10_000 + i + salt * 1_000); (a.address.clone(), a) }).collect();
        let mut node = Account::new("eon_cp_node".to_string());
        node.balance = 7 + salt;
        node.nonce = 4;
        node.is_node = true;
        node.heartbeat_epoch = 12;
        node.heartbeat_slots = 0x1FF;
        node.heartbeat_final_epoch = 11;
        node.heartbeat_final_slots = 0x3FF;
        node.last_claimed_epoch = 10;
        let mut banned = Account::new("eon_cp_banned".to_string());
        banned.balance = 5;
        banned.banned_at_height = 777;
        let mut t = Account::new(TOKEN.to_string());
        t.is_contract = true;
        t.contract_code_hash = Some("cd".repeat(32));
        t.contract_storage = (0..40).map(|i| (format!("balance:{}", holder(i)), format!("{}", 100 + i + salt))).collect();
        t.storage_root = StateMerkleTree::compute_storage_root(&t.contract_storage);
        for a in [node, banned, t] { all.push((a.address.clone(), a)); }
        r.sm.restore_accounts(all).expect("restore");
        let mut root = [0u8; 32];
        for h in 1..=90 {
            if h == 45 {
                let mut tok = r.sm.get_account(TOKEN).unwrap();
                tok.contract_storage.remove(&format!("balance:{}", holder(3)));
                r.sm.update_account(TOKEN.to_string(), tok);
            }
            root = block(&r, h);
        }
        settle(&r);
        before_capture(&r);
        certify(&r, 90, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        (r, root)
    }

    #[test]
    fn legacy_balance_proof_body_is_unchanged() {
        let (one, two, three, four) = (hex::encode([1u8; 32]), hex::encode([2u8; 32]), hex::encode([3u8; 32]), hex::encode([4u8; 32]));
        let proof = qnet_state::BalanceProof {
            address: "eon_golden".to_string(), balance: 5, nonce: 2, heartbeat_epoch: 3, heartbeat_slots: 7,
            heartbeat_final_epoch: 2, heartbeat_final_slots: 1, last_claimed_epoch: 9, banned_at_height: 0,
            is_node: true, proof: vec![([1u8; 32], true)], state_root: [2u8; 32], block_height: 77,
        };
        assert_eq!(super::super::queries_api::legacy_balance_proof_body(&proof).to_string(), format!(
            "{{\"address\":\"eon_golden\",\"balance\":5,\"banned_at_height\":0,\"block_height\":77,\"heartbeat_epoch\":3,\
             \"heartbeat_final_epoch\":2,\"heartbeat_final_slots\":1,\"heartbeat_slots\":7,\"is_node\":true,\
             \"last_claimed_epoch\":9,\"merkle_proof\":[{{\"is_right\":true,\"sibling\":\"{}\"}}],\"nonce\":2,\
             \"proof_valid\":true,\"state_root\":\"{}\"}}", one, two));
        assert_eq!(super::super::queries_api::legacy_balance_proof_missing("eon_golden").to_string(),
            "{\"address\":\"eon_golden\",\"balance\":0,\"block_height\":0,\"error\":\"account not found\",\
             \"merkle_proof\":[],\"nonce\":0,\"proof_valid\":false,\"state_root\":\"\"}");
        assert_eq!(super::super::queries_api::legacy_balance_proof_bad_address().to_string(),
            "{\"error\":\"Invalid address\",\"message\":\"Address parameter too long (max 64 characters)\"}");
        let token = qnet_state::TokenBalanceProof {
            contract_address: "eon_tok".to_string(), account_balance: 6, account_nonce: 1,
            contract_code_hash: Some("cd".to_string()), storage_root: [3u8; 32], heartbeat_epoch: 4, heartbeat_slots: 5,
            heartbeat_final_epoch: 3, heartbeat_final_slots: 2, last_claimed_epoch: 8, banned_at_height: 0, is_node: false,
            account_proof: vec![([1u8; 32], false)], holder: "eon_h".to_string(), token_balance: "250".to_string(),
            storage_proof: vec![([2u8; 32], true)], state_root: [4u8; 32], block_height: 99,
        };
        assert_eq!(super::super::queries_api::legacy_token_proof_body(&token).to_string(), format!(
            "{{\"account_balance\":\"6\",\"account_nonce\":1,\"account_proof\":[{{\"is_right\":false,\"sibling\":\"{}\"}}],\
             \"banned_at_height\":0,\"block_height\":99,\"contract_address\":\"eon_tok\",\"contract_code_hash\":\"cd\",\
             \"heartbeat_epoch\":4,\"heartbeat_final_epoch\":3,\"heartbeat_final_slots\":2,\"heartbeat_slots\":5,\
             \"holder\":\"eon_h\",\"is_node\":false,\"last_claimed_epoch\":8,\"proof_valid\":true,\"state_root\":\"{}\",\
             \"storage_proof\":[{{\"is_right\":true,\"sibling\":\"{}\"}}],\"storage_root\":\"{}\",\"token_balance\":\"250\"}}",
            one, four, two, three));
        assert_eq!(super::super::queries_api::legacy_token_proof_unprovable("eon_tok", "eon_h").to_string(),
            "{\"contract_address\":\"eon_tok\",\"error\":\"token balance not provable\",\"holder\":\"eon_h\",\
             \"proof_valid\":false,\"token_balance\":\"0\"}");
        assert_eq!(super::super::queries_api::legacy_token_proof_bad_parameter().to_string(),
            "{\"error\":\"Invalid parameter\",\"proof_valid\":false}");
        // The legacy routes still answer a rate limit with this 200 body.
        assert_eq!(rate_limit_body(42).to_string(),
            "{\"error\":\"Rate limit exceeded\",\"message\":\"Too many requests. Please wait 42 seconds before retrying.\",\
             \"retry_after_seconds\":42,\"success\":false}");
        // No `mb`, whatever else the query holds: the legacy handler answers.
        let pairs = |p: &[(&str, &str)]| p.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert!(!wants_certified(&pairs(&[])));
        assert!(!wants_certified(&pairs(&[("t", "1"), ("MB", "1")])));
        assert!(wants_certified(&pairs(&[("mb", "")])), "a malformed mb is the new form's typed 400");
    }

    #[tokio::test]
    async fn certified_balance_proof_fields_and_fold() {
        let (r, root) = setup(2, |_| {});
        let w5 = wallet(5, 0).address;
        for addr in ["eon_cp_node", "eon_cp_banned", w5.as_str(), TOKEN] {
            let (status, headers, v) = parts(certified_account_reply(r.st.clone(), addr.to_string(), q("1"), remote("198.51.100.2")).await).await;
            assert_eq!(status, StatusCode::OK, "{}: {}", addr, v);
            assert_eq!(cache_control(&headers), CACHE_EXPLICIT);
            assert_eq!(v["proof_format"], json!(2));
            assert_eq!(v["address"], json!(addr));
            assert_eq!(v["macroblock_index"], json!(1));
            assert_eq!(v["state_height"], json!(90));
            assert_eq!(v["state_root"], json!(hex::encode(root)));
            assert_eq!(v["exists"], json!(true));
            assert_eq!(v["proof_kind"], json!("inclusion"));
            for absent in ["block_height", "height", "servable", "bucket_entries"] {
                assert!(v.get(absent).is_none(), "{}: no {}", addr, absent);
            }
            let pre = preimage_from(&v, "balance", "nonce");
            assert_eq!(pre, AccountLeafPreimage::of(&r.sm.get_account(addr).unwrap()), "{}: every leaf field", addr);
            let steps = steps_from(&v["merkle_proof"]);
            assert!(qnet_state::verify_account_proof(addr, Some(&pre), &LeafProofKind::Inclusion(pre.leaf_hash(addr)), &steps, &root),
                    "{}: folds to the certified root", addr);
        }
        // Blocks after 90 never move an answer at view 1.
        let w37 = wallet(37, 0).address;
        let at_90 = AccountLeafPreimage::of(&r.sm.get_account(&w37).unwrap());
        for h in 91..=120 { block(&r, h); }
        settle(&r);
        assert_ne!(AccountLeafPreimage::of(&r.sm.get_account(&w37).unwrap()), at_90, "the live account moved on");
        let (status, _, v) = parts(certified_account_reply(r.st.clone(), w37.clone(), q("1"), remote("198.51.100.2")).await).await;
        assert_eq!(status, StatusCode::OK);
        let pre = preimage_from(&v, "balance", "nonce");
        assert_eq!(pre, at_90);
        assert!(qnet_state::verify_account_proof(&w37, Some(&pre), &LeafProofKind::Inclusion(pre.leaf_hash(&w37)), &steps_from(&v["merkle_proof"]), &root));
    }

    #[tokio::test]
    async fn certified_absence_proofs() {
        let (r, root) = setup(3, |_| {});
        let addr = "eon_cp_nobody";
        let (status, _, v) = parts(certified_account_reply(r.st.clone(), addr.to_string(), q("1"), remote("198.51.100.3")).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["exists"], json!(false));
        assert_eq!(v["proof_kind"], json!("absence"));
        for k in ["balance", "nonce", "heartbeat_epoch", "heartbeat_final_epoch", "last_claimed_epoch", "banned_at_height"] {
            assert_eq!(v[k], json!("0"), "{} is zero", k);
        }
        assert_eq!((v["heartbeat_slots"].clone(), v["heartbeat_final_slots"].clone()), (json!(0), json!(0)));
        assert_eq!((v["is_contract"].clone(), v["is_node"].clone()), (json!(false), json!(false)));
        assert!(v["contract_code_hash"].is_null() && v["storage_root"].is_null());
        let steps = steps_from(&v["merkle_proof"]);
        assert_eq!(steps.len(), qnet_state::state::PROOF_DEPTH, "exactly the 40 tree steps");
        assert!(qnet_state::verify_account_proof(addr, None, &LeafProofKind::Absence, &steps, &root));
        // Absence inside a shared bucket: the wire form carries the bucket's entries, sorted, and
        // decodes to exactly the proof the prover built (its verifier is pinned in qnet-state).
        let view = Arc::clone(&r.st.proof_views().current().views[0]);
        let entries: Vec<([u8; 32], [u8; 32])> = (1..=3u8).map(|i| ([i; 32], [0x40 + i; 32])).collect();
        let tree_steps: ProofSteps = (0..40u8).map(|i| ([i; 32], i % 3 == 0)).collect();
        let answer = AccountAnswer { kind: LeafProofKind::AbsenceInBucket(entries.clone()), steps: tree_steps.clone(), fields: None };
        let v: Value = serde_json::from_str(account_body(&view, "eon_cp_crafted", &answer).as_str()).unwrap();
        assert_eq!(v["proof_kind"], json!("absence_in_bucket"));
        assert_eq!(v["exists"], json!(false));
        assert_eq!(entries_from(&v["bucket_entries"]), entries);
        assert_eq!(steps_from(&v["merkle_proof"]), tree_steps);
        // No other negative form exists on the wire.
        let src = include_str!("certified_proofs.rs");
        let kinds = &src[src.find("fn kind_name").unwrap()..];
        let kinds = &kinds[..kinds.find("\n}").unwrap()];
        assert_eq!(kinds.matches("=> \"").count(), 3, "inclusion, absence, absence_in_bucket");
    }

    #[tokio::test]
    async fn certified_token_proof_statuses() {
        let (r, root) = setup(4, |_| {});
        let t = r.sm.get_account(TOKEN).unwrap();
        let ask = |contract: &str, h: &str| certified_token_reply(r.st.clone(), contract.to_string(), h.to_string(), q("1"), remote("198.51.100.4"));
        // A holder: both levels included and folded, the contract's storage root taken from its proven leaf.
        let (status, _, v) = parts(ask(TOKEN, &holder(1)).await).await;
        assert_eq!(status, StatusCode::OK, "{}", v);
        assert_eq!((v["contract_status"].clone(), v["account_proof_kind"].clone(), v["storage_proof_kind"].clone()),
                   (json!("contract"), json!("inclusion"), json!("inclusion")));
        let pre = preimage_from(&v, "account_balance", "account_nonce");
        assert_eq!(pre, AccountLeafPreimage::of(&t));
        assert!(pre.is_contract && v["storage_root"].is_string());
        assert!(qnet_state::verify_account_proof(TOKEN, Some(&pre), &LeafProofKind::Inclusion(pre.leaf_hash(TOKEN)), &steps_from(&v["account_proof"]), &root));
        let tb = v["token_balance"].as_str().unwrap().to_string();
        assert_eq!(Some(&tb), t.contract_storage.get(&format!("balance:{}", holder(1))));
        assert!(qnet_state::verify_storage_proof(&format!("balance:{}", holder(1)), Some(&tb),
            &LeafProofKind::Inclusion(StateMerkleTree::storage_leaf_value(&tb)), &steps_from(&v["storage_proof"]), &pre.storage_root));
        // A drained holder and one that never held: proven absent, balance "0".
        for h in [holder(3), holder(999)] {
            let (status, _, v) = parts(ask(TOKEN, &h).await).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!((v["storage_proof_kind"].clone(), v["token_balance"].clone()), (json!("absence"), json!("0")), "{}", h);
            assert!(qnet_state::verify_storage_proof(&format!("balance:{}", h), None, &LeafProofKind::Absence,
                                                     &steps_from(&v["storage_proof"]), &pre.storage_root));
        }
        // No such contract: 200 with the absence proof of its leaf, and no level 2.
        let (status, _, v) = parts(ask("eon_cp_no_contract", &holder(1)).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!((v["contract_status"].clone(), v["account_proof_kind"].clone()), (json!("absent"), json!("absence")));
        assert!(v.get("storage_proof").is_none() && v.get("token_balance").is_none());
        assert!(qnet_state::verify_account_proof("eon_cp_no_contract", None, &LeafProofKind::Absence, &steps_from(&v["account_proof"]), &root));
        // A plain account asked as a contract: 200 with its inclusion proof showing is_contract false.
        let w7 = wallet(7, 0).address;
        let (status, _, v) = parts(ask(&w7, &holder(1)).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!((v["contract_status"].clone(), v["account_proof_kind"].clone()), (json!("not_contract"), json!("inclusion")));
        let pre = preimage_from(&v, "account_balance", "account_nonce");
        assert!(!pre.is_contract && v.get("storage_proof").is_none());
        assert!(qnet_state::verify_account_proof(&w7, Some(&pre), &LeafProofKind::Inclusion(pre.leaf_hash(&w7)), &steps_from(&v["account_proof"]), &root));
    }

    #[tokio::test]
    async fn certified_proof_status_codes() {
        let w9 = wallet(9, 0).address;
        let (r, _) = setup(5, |r| delete_preimage(r, &wallet(9, 0).address));
        let from = remote("198.51.100.5");
        let ask = |pairs: Vec<(String, String)>, addr: &str| certified_account_reply(r.st.clone(), addr.to_string(), pairs, from);
        let typed = |v: &Value, error: &str| {
            assert_eq!(v["proof_format"], json!(2), "{}", v);
            assert_eq!(v["error"], json!(error), "{}", v);
        };
        let mut bad: Vec<Vec<(String, String)>> = ["abc", "", "0", "+1", "-1", "1.0", "LATEST", "100000000000000000000", "18446744073709551616"]
            .iter().map(|m| q(m)).collect();
        bad.push(vec![("mb".to_string(), "1".to_string()), ("mb".to_string(), "1".to_string())]);
        for pairs in bad {
            let (status, headers, v) = parts(ask(pairs.clone(), &w9).await).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{:?}", pairs);
            typed(&v, "bad_parameter");
            assert_eq!(v["parameter"], json!("mb"));
            assert_eq!(cache_control(&headers), CACHE_NONE);
        }
        let long = "x".repeat(65);
        for addr in ["", "a b", long.as_str()] {
            let (status, _, v) = parts(ask(q("1"), addr).await).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(v["parameter"], json!("address"));
        }
        let (status, _, v) = parts(certified_token_reply(r.st.clone(), TOKEN.to_string(), "h\u{e9}".to_string(), q("1"), from).await).await;
        assert_eq!((status, v["parameter"].clone()), (StatusCode::BAD_REQUEST, json!("holder")));
        // An index above the newest certified one.
        let (status, headers, v) = parts(ask(q("50"), &w9).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        typed(&v, "macroblock_not_certified");
        assert_eq!((v["macroblock_index"].clone(), v["newest_certified_index"].clone()), (json!(50), json!(1)));
        assert_eq!(cache_control(&headers), CACHE_NONE);
        // A certified view whose preimage row is missing and has no live row: 503 with Retry-After.
        let (status, headers, v) = parts(ask(q("1"), &w9).await).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        typed(&v, "certified_state_unavailable");
        assert_eq!((v["reason"].clone(), v["servable"].clone()), (json!("preimage_unavailable"), json!([1])));
        assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "5");
        // The source already holds its two proof slots: busy, retry in 1 s.
        let source = Source { key: limiter_key("198.51.100.55".parse().unwrap()), exempt: false };
        let held = (InflightSlot::take(source).unwrap(), InflightSlot::take(source).unwrap());
        let (status, headers, v) = parts(certified_account_reply(r.st.clone(), wallet(10, 0).address, q("1"), remote("198.51.100.55")).await).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        typed(&v, "busy");
        assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "1");
        drop(held);
        // Three newer views retire view 1: 410 with what is servable.
        let mut from_block = 91;
        for j in 2..=4u64 {
            let root = advance_to(&r, from_block, j * 90);
            from_block = j * 90 + 1;
            store_mb(&r, j, root);
        }
        wait_for("views 4, 3, 2", || view_indices(&r) == vec![4, 3, 2]);
        let (status, _, v) = parts(ask(q("1"), &w9).await).await;
        assert_eq!(status, StatusCode::GONE);
        typed(&v, "view_not_retained");
        assert_eq!(v["servable"], json!([4, 3, 2]));
        // A node with no view yet: 503 warming, retry in 30 s.
        let fresh = rig();
        let (status, headers, v) = parts(certified_account_reply(fresh.st.clone(), w9.clone(), q("latest"), from).await).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        typed(&v, "certified_state_unavailable");
        assert_eq!((v["reason"].clone(), v["servable"].clone()), (json!("warming"), json!([])));
        assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "30");
    }

    #[tokio::test]
    async fn certified_proof_rate_limit_answers_429_typed() {
        let (r, _) = setup(6, |_| {});
        let ip: IpAddr = "198.51.100.66".parse().unwrap();
        for _ in 0..600 {
            API_RATE_LIMITER.check_rate_limit(limiter_key(ip), CERTIFIED_PROOF_BUCKET);
        }
        let before = r.st.proof_views().stats.rate_limited.load(std::sync::atomic::Ordering::Relaxed);
        let (status, headers, v) = parts(certified_account_reply(r.st.clone(), wallet(1, 0).address, q("1"), Some(SocketAddr::new(ip, 0))).await).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!((v["proof_format"].clone(), v["error"].clone()), (json!(2), json!("rate_limited")));
        let wait = v["retry_after_seconds"].as_u64().unwrap();
        assert!(wait >= 1);
        assert_eq!(headers.get(header::RETRY_AFTER).unwrap().to_str().unwrap(), wait.to_string());
        assert_eq!(cache_control(&headers), CACHE_NONE);
        assert!(r.st.proof_views().stats.rate_limited.load(std::sync::atomic::Ordering::Relaxed) > before);
        // The legacy bucket is apart: the legacy route still answers this address in its own form, and
        // the certified state has its own bucket too.
        assert!(api_rate_limit_retry(Some(SocketAddr::new(ip, 0)), "read_only").is_ok());
        assert_eq!(state_certified_reply(&r.st, Some(SocketAddr::new(ip, 0))).status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn certified_proof_keys_ipv6_by_64() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(limiter_key(ip("2001:db8:1:2:aa::1")), ip("2001:db8:1:2::"));
        assert_eq!(limiter_key(ip("::ffff:198.51.100.9")), ip("198.51.100.9"));
        assert_eq!(limiter_key(ip("198.51.100.9")), ip("198.51.100.9"));
        let (r, _) = setup(7, |_| {});
        for _ in 0..600 {
            API_RATE_LIMITER.check_rate_limit(limiter_key(ip("2001:db8:77:1::1")), CERTIFIED_PROOF_BUCKET);
        }
        let ask = |from: &str| certified_account_reply(r.st.clone(), wallet(2, 0).address, q("1"), remote(from));
        assert_eq!(ask("2001:db8:77:1:ffff::2").await.status(), StatusCode::TOO_MANY_REQUESTS, "the whole /64 shares one bucket");
        assert_eq!(ask("2001:db8:77:2::1").await.status(), StatusCode::OK, "the next /64 does not");
        // The in-flight cap counts the /64 as one source as well.
        let source = |s: &str| Source { key: limiter_key(ip(s)), exempt: false };
        let first = InflightSlot::take(source("2001:db8:78:1::1")).unwrap();
        let second = InflightSlot::take(source("2001:db8:78:1::2")).unwrap();
        assert!(InflightSlot::take(source("2001:db8:78:1:9::3")).is_none());
        assert!(InflightSlot::take(source("2001:db8:78:2::1")).is_some());
        drop(first);
        assert!(InflightSlot::take(source("2001:db8:78:1::4")).is_some(), "a finished job frees its slot");
        drop(second);
        assert!(!PROOF_INFLIGHT.contains_key(&limiter_key(ip("2001:db8:78:1::1"))), "an idle source holds no entry");
        assert!(InflightSlot::take(Source { key: ip("127.0.0.1"), exempt: true }).is_some());
    }

    #[tokio::test]
    async fn cache_headers_by_form() {
        let (r, _) = setup(8, |_| {});
        let w4 = wallet(4, 0).address;
        let from = remote("198.51.100.8");
        let (status, headers, explicit) = parts(certified_account_reply(r.st.clone(), w4.clone(), q("1"), from).await).await;
        assert_eq!((status, cache_control(&headers)), (StatusCode::OK, CACHE_EXPLICIT));
        assert!(explicit.get("servable").is_none(), "an immutable body never carries the changing list");
        let (status, headers, mut latest) = parts(certified_account_reply(r.st.clone(), w4.clone(), q("latest"), from).await).await;
        assert_eq!((status, cache_control(&headers)), (StatusCode::OK, CACHE_LATEST));
        assert_eq!(latest["servable"], json!([1]));
        latest.as_object_mut().unwrap().remove("servable");
        assert_eq!(latest, explicit, "latest is the explicit body plus servable");
        let (status, headers, _) = parts(certified_account_reply(r.st.clone(), w4, q("x"), from).await).await;
        assert_eq!((status, cache_control(&headers)), (StatusCode::BAD_REQUEST, CACHE_NONE));
    }

    #[test]
    fn state_certified_names_three_heights_apart() {
        let fresh = rig();
        let r = state_certified_reply(&fresh.st, remote("198.51.100.9"));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(cache_control(r.headers()), CACHE_STATE);
        let body = |resp: warp::reply::Response| -> Value {
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            rt.block_on(async { serde_json::from_slice(&warp::hyper::body::to_bytes(resp.into_body()).await.unwrap()).unwrap() })
        };
        let v = body(r);
        assert_eq!((v["capture"].clone(), v["views"].clone()), (json!("warming"), json!([])));
        let (rig9, root) = setup(9, |_| {});
        let v = body(state_certified_reply(&rig9.st, remote("198.51.100.9")));
        assert_eq!(v["proof_format"], json!(2));
        assert_eq!(v["views"], json!([{ "macroblock_index": 1, "state_height": 90, "state_root": hex::encode(root) }]));
        assert_eq!(v["newest_certified_index"], json!(1));
        assert!(v["finalized_height"].is_u64() && v["applied_height"].is_u64());
        assert_eq!(v["capture"], json!("ok"));
        for absent in ["block_height", "height"] {
            assert!(v.get(absent).is_none(), "no {}", absent);
        }
    }

    #[test]
    fn logs_proof_waits_for_the_certified_window() {
        let r = rig();
        let gate = super::super::queries_api::logs_window_gate;
        assert_eq!(gate(&r.st, 90, 1_000), Err(json!({"error": "window_not_finalized", "window_end": 90})),
                   "applied but not certified");
        store_mb(&r, 1, [1u8; 32]);
        assert_eq!(gate(&r.st, 90, 1_000), Ok(1), "certified and applied");
        assert!(gate(&r.st, 90, 89).is_err(), "certified but not applied here");
        assert!(gate(&r.st, 180, 1_000).is_err());
        // The handler answers through the gate and names the macroblock in its 200 body.
        let src = include_str!("queries_api.rs");
        let handler = &src[src.find("pub(super) async fn handle_log_proof").unwrap()..];
        let handler = &handler[..handler.find("pub(super) async fn handle_token_transfers").unwrap()];
        assert!(handler.contains("logs_window_gate(&storage, end, blockchain.get_height().await)"));
        assert!(handler.contains("\"macroblock_index\": macroblock_index"));
    }

    #[test]
    fn answer_cache_is_byte_bounded_lru() {
        let cache = AnswerCache::new(10_000);
        let body = |n: usize| ObjectBody::of(fields(&[("x", json!("y".repeat(n)))]));
        let key = |i: u64| -> CacheKey { (i, [0u8; 32], KIND_ACCOUNT, format!("a{}", i).into(), "".into()) };
        for i in 0..100 {
            cache.insert(key(i), body(500));
            assert!(cache.bytes() <= 10_000);
        }
        assert!(cache.get(&key(0)).is_none(), "the oldest went first");
        let kept: Vec<u64> = (0..100).filter(|i| cache.inner.lock().map.contains_key(&key(*i))).collect();
        let oldest = kept[0];
        assert!(cache.get(&key(oldest)).is_some(), "a read refreshes it");
        cache.insert(key(100), body(500));
        assert!(cache.get(&key(oldest)).is_some(), "the refreshed entry outlives a newer one");
        assert!(cache.get(&key(oldest + 1)).is_none());
        cache.insert(key(200), body(20_000));
        assert!(cache.get(&key(200)).is_none(), "an entry over the cap is never stored");
        let roots = (key(5), { let mut k = key(5); k.1 = [9u8; 32]; k });
        cache.insert(roots.0.clone(), body(10));
        assert!(cache.get(&roots.1).is_none(), "another root is another body");
    }

    #[tokio::test]
    async fn parse_mb_accepts_exactly_one_selector() {
        let pairs = |p: &[(&str, &str)]| p.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert_eq!(parse_mb(&pairs(&[("mb", "latest")])), Ok(MbSelector::Latest));
        assert_eq!(parse_mb(&pairs(&[("mb", "7"), ("other", "x")])), Ok(MbSelector::Index(7)));
        assert_eq!(parse_mb(&pairs(&[("mb", "18446744073709551615")])), Ok(MbSelector::Index(u64::MAX)));
        for bad in ["", "0", "+1", "-1", "1.0", "LATEST", "0x1", "18446744073709551616", "100000000000000000000"] {
            assert_eq!(parse_mb(&pairs(&[("mb", bad)])), Err(()), "{:?}", bad);
        }
        assert_eq!(parse_mb(&pairs(&[("mb", "1"), ("mb", "1")])), Err(()), "a duplicate");
        assert_eq!(parse_mb(&pairs(&[])), Err(()));
        assert!(valid_key("eon_x") && valid_key(&"z".repeat(64)));
        let long = "z".repeat(65);
        for bad in ["", "a b", "a\tb", "\u{e9}", long.as_str()] {
            assert!(!valid_key(bad), "{:?}", bad);
        }
        // The route's query filter hands every pair to the handler and never rejects: a duplicate or
        // undecodable `mb` reaches the typed 400 instead of the HTTP layer's plain-text one.
        let f = warp::query::<Vec<(String, String)>>();
        let got = warp::test::request().path("/x?mb=1&mb=2&mb").filter(&f).await.unwrap();
        assert_eq!(got, pairs(&[("mb", "1"), ("mb", "2"), ("mb", "")]));
        assert!(warp::test::request().path("/x").filter(&f).await.unwrap().is_empty());
        assert!(warp::test::request().path("/x?%ZZ=%FF&mb=1").filter(&f).await.is_ok());
    }
}

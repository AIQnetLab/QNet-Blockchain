//! The wallet plane: the HTTPS listener a super node opens for wallets on container port 8443 (host
//! 443). It serves only the certified, non-identifying reads `wallet_route_allowed` lists, on its own
//! runtime, under connection, handshake, rate and egress caps, and every refusal it makes is typed.
//! Its certificate is a short-lived public-CA certificate for the node's IPv4 (rpc/acme.rs); the same
//! resolver answers the CA's tls-alpn-01 validation and the genesis 443 probe (rpc/node_serve.rs).
//!
//! The plane changes no consensus rule: it is a second door to routes every node already serves.

use super::*;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use warp::http::{header, HeaderValue, Method, StatusCode};
use warp::hyper::body::{HttpBody, SizeHint};
use warp::hyper::service::Service;
use warp::hyper::{Body, Request, Response};

/// The container port; the installer publishes host 443 to it (the entrypoint drops root, so the
/// node cannot bind 443 itself).
pub(crate) const WALLET_PLANE_PORT: u16 = 8443;
/// The ALPN identifier of a tls-alpn-01 validation handshake.
pub(crate) const ALPN_ACME_TLS: &[u8] = b"acme-tls/1";
/// SNI suffix of the genesis 443 probe; `.invalid` is reserved, so no real name ever ends in it.
pub(crate) const PROBE_SUFFIX: &str = ".probe.invalid";
/// Egress budget over plane response bodies: 100 Mbit/s with a 25 MB burst.
pub(crate) const EGRESS_BYTES_PER_SEC: f64 = 12_500_000.0;
pub(crate) const EGRESS_BURST_BYTES: f64 = 25_000_000.0;
const STATS_EVERY: Duration = Duration::from_secs(300);
const MASKED_WARN_EVERY_SECS: u64 = 3600;
/// The longest Retry-After a spent egress budget answers with.
const BUSY_RETRY_MAX_SECS: u64 = 60;
/// What a heavy answer is assumed to cost before the node has sent one: the clients' caps (a macroblock
/// proof at committee 1000 is about 7-8.6 MB).
const MB_PROOF_ESTIMATE_DEFAULT: u64 = 8 * 1024 * 1024;
const REGISTRY_ESTIMATE_DEFAULT: u64 = 16 * 1024 * 1024;
/// A heavy answer reserves at most this share of the burst: two in flight per key then hold an eighth
/// of it, so a client that never reads cannot hold the node's egress.
const RESERVE_SHARE_OF_BURST: f64 = 16.0;
/// Response bodies are handed to the transport in pieces of at most this size; each piece is what the
/// budget is charged and what counts as a response's progress.
pub(crate) const BODY_CHUNK: usize = 64 * 1024;
/// The length assumed for a body whose length is unknown (none on the plane today): the larger cap.
const UNKNOWN_BODY_LEN: u64 = REGISTRY_ESTIMATE_DEFAULT;

/// The TLS socket's peer as the plane saw it, and the key every per-address limit counts it under
/// (`plane_key`). A request extension, so no client can forge it; `client_addr` prefers it over any
/// X-Forwarded-For.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WalletPeer {
    pub(crate) peer: SocketAddr,
    pub(crate) key: IpAddr,
}

/// Marks a request that arrived through the wallet plane. Handlers read it to type their refusals
/// and to choose the plane's buckets; the gated routes refuse any request that carries it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WalletPlane;

// ─── Allowlist ──────────────────────────────────────────────────────────────────────────────────

/// The routes the plane serves. Anything else is refused at the wrapper and never reaches warp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WalletRoute {
    Healthz,
    StateCertified,
    AccountProof,
    TokenProof,
    LogsProof,
    MacroblockProof,
    Registry,
    ServeProof,
    NodesRpc,
    Whoami,
    Transaction,
}

impl WalletRoute {
    /// Routes whose bodies dominate egress: refused `busy` while the budget is spent.
    pub(crate) fn heavy(self) -> bool {
        matches!(self, WalletRoute::MacroblockProof | WalletRoute::Registry)
    }
}

fn decimal_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())
}

/// Whether the query names `mb` (any value: a malformed one gets the certified route's typed 400,
/// never the legacy handler, which serialises on the live tree).
fn query_has_mb(query: Option<&str>) -> bool {
    query.map_or(false, |q| url::form_urlencoded::parse(q.as_bytes()).any(|(k, _)| k == "mb"))
}

fn route_of(path: &str, query: Option<&str>) -> Option<WalletRoute> {
    let segs: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
    let key = |s: &str| super::certified_proofs::valid_key(s);
    let route = match segs.as_slice() {
        ["healthz"] => WalletRoute::Healthz,
        ["api", "v1", "state", "certified"] => WalletRoute::StateCertified,
        ["api", "v1", "account", a, "balance", "proof"] if key(a) && query_has_mb(query) => WalletRoute::AccountProof,
        ["api", "v1", "token", c, h, "balance", "proof"] if key(c) && key(h) && query_has_mb(query) => WalletRoute::TokenProof,
        ["api", "v1", "logs", "proof"] => WalletRoute::LogsProof,
        ["api", "v1", "macroblock", j, "proof"] if decimal_segment(j) => WalletRoute::MacroblockProof,
        ["api", "v1", "registry", "height", h] if decimal_segment(h) => WalletRoute::Registry,
        ["api", "v1", "node", "serve-proof"] => WalletRoute::ServeProof,
        ["api", "v1", "nodes", "rpc"] => WalletRoute::NodesRpc,
        ["api", "v1", "whoami"] => WalletRoute::Whoami,
        ["api", "v1", "transaction"] => WalletRoute::Transaction,
        _ => return None,
    };
    Some(route)
}

/// The plane's allowlist: the route a request may reach, or None (a typed 404 at the wrapper).
/// Literal segments compare raw, as warp's do, and the segment count is exact, so a path that passes
/// here can only reach the route it names or warp's own 404. A preflight passes for listed paths.
pub(crate) fn wallet_route_allowed(method: &Method, path: &str, query: Option<&str>) -> Option<WalletRoute> {
    let route = route_of(path, query)?;
    let ok = match *method {
        Method::GET => route != WalletRoute::Transaction,
        Method::POST => route == WalletRoute::Transaction,
        Method::OPTIONS => true,
        _ => false,
    };
    ok.then_some(route)
}

// ─── Client key ─────────────────────────────────────────────────────────────────────────────────

/// A peer inside the container's own networks means the runtime proxied the connection and hid the
/// client: every such peer shares one bucket (0.0.0.0, never whitelisted), so loopback cannot be
/// used to step around the limits.
fn masked_peer(ip: IpAddr) -> bool {
    ip.is_unspecified() || is_private_ip(&ip) || Some(ip) == *LOCAL_GATEWAY
}

/// The key a plane peer is counted under: an IPv4 address, an IPv6 /64 (`limiter_key`), or the one
/// shared bucket for a masked peer.
pub(crate) fn plane_key(peer: IpAddr) -> IpAddr {
    let key = limiter_key(peer);
    if masked_peer(key) {
        warn_masked();
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        key
    }
}

fn warn_masked() {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = unix_now();
    let last = LAST.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= MASKED_WARN_EVERY_SECS
        && LAST.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
        && is_warn()
    {
        println!("[WARN][WALLETRPC] client_ip_masked action=shared_bucket hint=publish_443_on_0.0.0.0");
    }
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Milliseconds on a process-wide monotonic clock (the connection watchdog's time base).
pub(crate) fn mono_ms() -> u64 {
    static BASE: Lazy<Instant> = Lazy::new(Instant::now);
    BASE.elapsed().as_millis() as u64
}

// ─── Typed refusals ─────────────────────────────────────────────────────────────────────────────

/// A refusal the wrapper itself makes. It carries `Access-Control-Allow-Origin: *` so a browser
/// wallet can read the code and `Retry-After` (warp's CORS filter never sees these requests).
fn plane_refusal(status: StatusCode, error: &str, retry_after: Option<u64>) -> warp::reply::Response {
    let mut r = error_response(status, error, serde_json::Map::new(), retry_after);
    r.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r.headers_mut().insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("retry-after"));
    r
}

/// The plane's typed 429 for a route bucket, counted in the stats.
pub(crate) fn plane_rate_limited(retry_after: u64) -> warp::reply::Response {
    PLANE_STATS.rate_limited.fetch_add(1, Ordering::Relaxed);
    rate_limited(retry_after)
}

/// The plane's typed `busy` (503) with its wait.
pub(crate) fn plane_busy(retry_after: u64) -> warp::reply::Response {
    PLANE_STATS.busy.fetch_add(1, Ordering::Relaxed);
    plane_refusal(StatusCode::SERVICE_UNAVAILABLE, "busy", Some(retry_after))
}

/// Warp rejections on the plane, typed: a listed path whose method, parameters or body warp refused.
pub(crate) async fn recover_rejection(r: Rejection) -> Result<warp::reply::Response, Rejection> {
    use warp::reject;
    let (status, error) = if r.is_not_found() {
        (StatusCode::NOT_FOUND, "not_found")
    } else if r.find::<reject::MethodNotAllowed>().is_some() {
        (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed")
    } else if r.find::<reject::PayloadTooLarge>().is_some() {
        (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large")
    } else if r.find::<reject::LengthRequired>().is_some() {
        (StatusCode::LENGTH_REQUIRED, "length_required")
    } else if r.find::<reject::UnsupportedMediaType>().is_some() {
        (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
    } else if r.find::<warp::filters::cors::CorsForbidden>().is_some() {
        (StatusCode::FORBIDDEN, "cors_forbidden")
    } else {
        (StatusCode::BAD_REQUEST, "bad_request")
    };
    Ok(plane_refusal(status, error, None))
}

// ─── Stats ──────────────────────────────────────────────────────────────────────────────────────

/// Counters for `[INFO][WALLETRPC] stats`. Never an address: counts only.
#[derive(Default)]
pub(crate) struct PlaneStats {
    pub(crate) handshakes: AtomicU64,
    pub(crate) handshake_failed: AtomicU64,
    pub(crate) refused_conn_cap: AtomicU64,
    pub(crate) refused_handshake: AtomicU64,
    pub(crate) served: AtomicU64,
    pub(crate) not_allowed: AtomicU64,
    pub(crate) rate_limited: AtomicU64,
    pub(crate) busy: AtomicU64,
    pub(crate) egress_bytes: AtomicU64,
    pub(crate) serve_proofs: AtomicU64,
    pub(crate) mb_cache_hits: AtomicU64,
    /// Connections the watchdog dropped for a stalled answer, a missed deadline or their age.
    pub(crate) stalled: AtomicU64,
}

pub(crate) static PLANE_STATS: Lazy<PlaneStats> = Lazy::new(PlaneStats::default);

fn take(c: &AtomicU64) -> u64 {
    c.swap(0, Ordering::Relaxed)
}

// ─── Egress budget ──────────────────────────────────────────────────────────────────────────────

/// Token bucket over response body bytes, charged as the transport takes them (`PlaneBody`), never when
/// a body is built: a client that does not read costs it nothing. A heavy answer reserves part of its
/// expected size before it is built (`reservation_for`) and is refused while the bucket cannot hold
/// that much, so a burst of requests waiting on one build is not all admitted against the same tokens.
pub(crate) struct EgressBudget {
    rate: f64,
    burst: f64,
    state: parking_lot::Mutex<(f64, Instant)>,
}

impl EgressBudget {
    pub(crate) fn new(rate: f64, burst: f64) -> Self {
        Self { rate, burst, state: parking_lot::Mutex::new((burst, Instant::now())) }
    }

    fn refill(&self, s: &mut (f64, Instant), now: Instant) {
        // Time only moves forward here: an earlier instant read on another thread refills nothing.
        if now > s.1 {
            s.0 = (s.0 + (now - s.1).as_secs_f64() * self.rate).min(self.burst);
            s.1 = now;
        }
    }

    /// The tokens held now (negative: in debt).
    #[cfg(test)]
    pub(crate) fn tokens_at(&self, now: Instant) -> f64 {
        let mut s = self.state.lock();
        self.refill(&mut s, now);
        s.0
    }

    #[cfg(test)]
    pub(crate) fn debit_at(&self, bytes: usize, now: Instant) {
        let mut s = self.state.lock();
        self.refill(&mut s, now);
        s.0 -= bytes as f64;
        PLANE_STATS.egress_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    /// Hold `bytes` (at most the burst) for an answer about to be built. Err is the wait in seconds
    /// until the bucket holds that much again: the debt and the shortfall over the rate.
    pub(crate) fn reserve_at(self: &Arc<Self>, bytes: u64, now: Instant) -> Result<Meter, u64> {
        let need = (bytes as f64).min(self.burst);
        let mut s = self.state.lock();
        self.refill(&mut s, now);
        if s.0 < need {
            let wait = ((need - s.0) / self.rate).ceil();
            return Err((wait.max(1.0) as u64).min(BUSY_RETRY_MAX_SECS));
        }
        s.0 -= need;
        Ok(Meter { budget: Arc::clone(self), held: need })
    }

    fn reserve(self: &Arc<Self>, bytes: u64) -> Result<Meter, u64> {
        self.reserve_at(bytes, Instant::now())
    }

    /// What a heavy answer expected to be `estimate` bytes reserves: at most a sixteenth of the burst.
    /// The rest is charged as it is sent, so an answer admitted against a part of its size can put the
    /// bucket in debt, which later heavy answers wait out.
    pub(crate) fn reservation_for(&self, estimate: u64) -> u64 {
        (estimate as f64).min(self.burst / RESERVE_SHARE_OF_BURST) as u64
    }

    #[cfg(test)]
    fn debit(&self, bytes: usize) {
        self.debit_at(bytes, Instant::now())
    }

    /// Bytes the transport took: `debit` of them come out of the bucket (the rest a reservation already
    /// paid for), all of them count as sent.
    fn charge(&self, debit: f64, sent: usize) {
        if debit > 0.0 {
            let mut s = self.state.lock();
            self.refill(&mut s, Instant::now());
            s.0 -= debit;
        }
        PLANE_STATS.egress_bytes.fetch_add(sent as u64, Ordering::Relaxed);
    }

    /// The unspent part of a reservation, given back.
    fn refund(&self, held: f64) {
        let mut s = self.state.lock();
        self.refill(&mut s, Instant::now());
        s.0 = (s.0 + held).min(self.burst);
    }
}

/// One answer's account with the budget. A heavy answer holds a reservation that its first bytes
/// spend; past it, and for every other answer, bytes are debited as the transport takes them. Whatever
/// is still held when the body ends or is dropped goes back, so an abandoned answer costs only what
/// was really handed over.
pub(crate) struct Meter {
    budget: Arc<EgressBudget>,
    held: f64,
}

impl Meter {
    fn unreserved(budget: &Arc<EgressBudget>) -> Self {
        Self { budget: Arc::clone(budget), held: 0.0 }
    }

    pub(crate) fn spend(&mut self, sent: usize) {
        let from_held = self.held.min(sent as f64);
        self.held -= from_held;
        self.budget.charge(sent as f64 - from_held, sent);
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        if self.held > 0.0 {
            self.budget.refund(self.held);
        }
    }
}

/// The plane's response body: the handler's body handed to the transport in pieces of at most
/// `BODY_CHUNK`, each charged to the egress budget and counted as its request's progress when hyper
/// takes it. hyper takes a piece only when the connection can carry it (an HTTP/2 window, room in the
/// socket), so a client that does not read neither drains the budget nor looks alive to the watchdog.
pub(crate) struct PlaneBody {
    inner: Body,
    pending: bytes::Bytes,
    meter: Meter,
    ticket: Option<Ticket>,
    _heavy: Option<HeavySlot>,
}

impl HttpBody for PlaneBody {
    type Data = bytes::Bytes;
    type Error = warp::hyper::Error;

    fn poll_data(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Self::Data, Self::Error>>> {
        let this = &mut *self;
        loop {
            if !this.pending.is_empty() {
                let chunk = this.pending.split_to(this.pending.len().min(BODY_CHUNK));
                this.meter.spend(chunk.len());
                if let Some(t) = &this.ticket {
                    t.progress(mono_ms());
                }
                return Poll::Ready(Some(Ok(chunk)));
            }
            match std::task::ready!(Pin::new(&mut this.inner).poll_data(cx)) {
                Some(Ok(b)) => this.pending = b,
                other => return Poll::Ready(other),
            }
        }
    }

    fn poll_trailers(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<Option<warp::http::HeaderMap>, Self::Error>> {
        Pin::new(&mut self.inner).poll_trailers(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.pending.is_empty() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let inner = self.inner.size_hint();
        let pending = self.pending.len() as u64;
        match inner.exact() {
            Some(n) => SizeHint::with_exact(n + pending),
            None => {
                let mut h = SizeHint::new();
                h.set_lower(inner.lower() + pending);
                if let Some(upper) = inner.upper() {
                    h.set_upper(upper + pending);
                }
                h
            }
        }
    }
}

/// One heavy answer in flight, counted per key and node-wide by its body's bytes until the body has
/// been handed over or dropped: downloads that stall cannot pin more memory than the caps.
pub(crate) struct HeavySlot {
    ctx: Arc<PlaneCtx>,
    key: IpAddr,
    bytes: u64,
}

impl HeavySlot {
    /// Count the body actually built instead of the estimate it was admitted on.
    fn resize(&mut self, bytes: u64) {
        if bytes >= self.bytes {
            self.ctx.heavy_bytes.fetch_add(bytes - self.bytes, Ordering::AcqRel);
        } else {
            self.ctx.heavy_bytes.fetch_sub(self.bytes - bytes, Ordering::AcqRel);
        }
        self.bytes = bytes;
    }
}

impl Drop for HeavySlot {
    fn drop(&mut self) {
        self.ctx.heavy_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        if let Some(mut n) = self.ctx.heavy_per_key.get_mut(&self.key) {
            *n = n.saturating_sub(1);
        }
        self.ctx.heavy_per_key.remove_if(&self.key, |_, n| *n == 0);
    }
}

/// The last heavy answer sizes this listener sent, per route: the estimate for a body not yet built
/// (bodies of neighbouring indices and heights are about the same size).
pub(crate) struct HeavySizes {
    mb_proof: AtomicU64,
    registry: AtomicU64,
}

impl HeavySizes {
    fn new() -> Self {
        Self { mb_proof: AtomicU64::new(MB_PROOF_ESTIMATE_DEFAULT), registry: AtomicU64::new(REGISTRY_ESTIMATE_DEFAULT) }
    }

    fn slot(&self, route: WalletRoute) -> Option<&AtomicU64> {
        match route {
            WalletRoute::MacroblockProof => Some(&self.mb_proof),
            WalletRoute::Registry => Some(&self.registry),
            _ => None,
        }
    }

    /// What `path` on a heavy route is expected to cost: the cached body when the node holds one, else
    /// the last such answer's size, else the clients' cap.
    pub(crate) fn estimate(&self, route: WalletRoute, path: &str) -> u64 {
        let last_segment = |i: usize| path.trim_start_matches('/').split('/').nth(i).and_then(|s| s.parse::<u64>().ok());
        let cached = match route {
            WalletRoute::MacroblockProof => last_segment(3).and_then(super::queries_api::cached_macroblock_proof_len),
            WalletRoute::Registry => last_segment(4).and_then(super::queries_api::cached_registry_len),
            _ => None,
        };
        cached.map(|n| n as u64).or_else(|| self.slot(route).map(|s| s.load(Ordering::Relaxed))).unwrap_or(0)
    }

    fn note(&self, route: WalletRoute, bytes: u64) {
        if let Some(s) = self.slot(route) {
            s.store(bytes, Ordering::Relaxed);
        }
    }
}

// ─── Certificates ───────────────────────────────────────────────────────────────────────────────

/// The serving certificate as installed: its key for the resolver and the facts the node acts on.
#[derive(Clone)]
pub(crate) struct Installed {
    pub(crate) key: Arc<CertifiedKey>,
    pub(crate) ip: Ipv4Addr,
    pub(crate) not_before: u64,
    pub(crate) not_after: u64,
}

struct Armed {
    sni: String,
    key: Arc<CertifiedKey>,
    until: Instant,
}

/// The plane's certificate resolver. The serving certificate is swapped in place, so a renewal drops
/// no live connection; the challenge and probe certificates are armed only while they are needed.
pub(crate) struct CertStore {
    current: parking_lot::RwLock<Option<Installed>>,
    challenge: parking_lot::RwLock<Option<Armed>>,
    probes: parking_lot::Mutex<Vec<Armed>>,
}

impl std::fmt::Debug for CertStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertStore").finish_non_exhaustive()
    }
}

/// The node's certificate store; one per process, shared by the listener, the certificate client
/// and the serving state.
pub(crate) static WALLET_CERTS: Lazy<Arc<CertStore>> = Lazy::new(|| Arc::new(CertStore::new()));

/// Probes armed at once: each genesis probe takes one, for seconds.
const PROBES_MAX: usize = 8;

impl CertStore {
    pub(crate) fn new() -> Self {
        Self { current: parking_lot::RwLock::new(None), challenge: parking_lot::RwLock::new(None), probes: parking_lot::Mutex::new(Vec::new()) }
    }

    pub(crate) fn install(&self, installed: Installed) {
        *self.current.write() = Some(installed);
    }

    pub(crate) fn installed(&self) -> Option<Installed> {
        self.current.read().clone()
    }

    /// The IP the installed certificate is valid for right now, if any.
    pub(crate) fn valid_ip(&self, now: u64) -> Option<Ipv4Addr> {
        self.current.read().as_ref().filter(|c| c.not_before <= now && now < c.not_after).map(|c| c.ip)
    }

    /// Arm the tls-alpn-01 certificate for `ip` until the authorization leaves `pending` (the CA
    /// validates from several places, each with its own handshake), at most `ttl`.
    pub(crate) fn arm_challenge(&self, ip: Ipv4Addr, key_authorization_digest: &[u8; 32], ttl: Duration) -> Result<(), String> {
        let key = challenge_cert(ip, key_authorization_digest)?;
        *self.challenge.write() = Some(Armed { sni: reverse_name(ip), key, until: Instant::now() + ttl });
        Ok(())
    }

    pub(crate) fn disarm_challenge(&self) {
        *self.challenge.write() = None;
    }

    /// Arm a throwaway certificate for `<marker>.probe.invalid`: a genesis probe that sees this name
    /// knows host 443 reaches this very process, not some other server on the address.
    pub(crate) fn arm_probe(&self, marker: &str, ttl: Duration) -> Result<(), String> {
        if marker.len() != 32 || !marker.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err("bad_marker".into());
        }
        let sni = format!("{}{}", marker, PROBE_SUFFIX);
        let key = self_signed_for_name(&sni)?;
        let mut probes = self.probes.lock();
        let now = Instant::now();
        probes.retain(|p| p.until > now);
        if probes.len() >= PROBES_MAX {
            return Err("probes_full".into());
        }
        probes.push(Armed { sni, key, until: now + ttl });
        Ok(())
    }

    pub(crate) fn disarm_probe(&self, marker: &str) {
        let sni = format!("{}{}", marker, PROBE_SUFFIX);
        self.probes.lock().retain(|p| p.sni != sni);
    }
}

impl ResolvesServerCert for CertStore {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let now = Instant::now();
        // A validation handshake offers acme-tls/1 and nothing else (RFC 8737 §3); it gets the
        // challenge certificate for the reverse name while one is armed, and never the serving one.
        let acme_only = hello.alpn().map_or(false, |mut it| it.next() == Some(ALPN_ACME_TLS) && it.next().is_none());
        if acme_only {
            let armed = self.challenge.read();
            return match (hello.server_name(), armed.as_ref()) {
                (Some(sni), Some(a)) if a.until > now && sni.eq_ignore_ascii_case(&a.sni) => Some(Arc::clone(&a.key)),
                _ => None,
            };
        }
        if let Some(sni) = hello.server_name() {
            if sni.len() > PROBE_SUFFIX.len() && sni[sni.len() - PROBE_SUFFIX.len()..].eq_ignore_ascii_case(PROBE_SUFFIX) {
                return self.probes.lock().iter()
                    .find(|p| p.until > now && p.sni.eq_ignore_ascii_case(sni))
                    .map(|p| Arc::clone(&p.key));
            }
        }
        // Clients connect by IP literal and send no SNI; any other name gets the serving one too. A
        // certificate outside its validity is not offered: with none valid, the handshake fails here.
        let unix = unix_now();
        self.current.read().as_ref()
            .filter(|c| c.not_before <= unix && unix < c.not_after)
            .map(|c| Arc::clone(&c.key))
    }
}

/// `d.c.b.a.in-addr.arpa`: the SNI of a tls-alpn-01 validation for an IPv4 identifier (RFC 8738 §6).
pub(crate) fn reverse_name(ip: Ipv4Addr) -> String {
    let o = ip.octets();
    format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
}

/// A rustls key from a DER chain (leaf first) and the leaf's PKCS#8 key.
pub(crate) fn certified_key(chain: Vec<Vec<u8>>, key_pkcs8: &[u8]) -> Result<Arc<CertifiedKey>, String> {
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8.to_vec()));
    let signer = rustls::crypto::aws_lc_rs::sign::any_supported_type(&key).map_err(|e| format!("key: {}", e))?;
    let chain: Vec<CertificateDer<'static>> = chain.into_iter().map(CertificateDer::from).collect();
    Ok(Arc::new(CertifiedKey::new(chain, signer)))
}

/// The tls-alpn-01 certificate (RFC 8737 §3, RFC 8738 §6): self-signed, a fresh P-256 key, the IP as
/// its only subject-alternative name and the critical acmeIdentifier extension over SHA-256 of the
/// key authorization.
pub(crate) fn challenge_cert(ip: Ipv4Addr, key_authorization_digest: &[u8; 32]) -> Result<Arc<CertifiedKey>, String> {
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, "tls-alpn-01");
    params.subject_alt_names = vec![rcgen::SanType::IpAddress(IpAddr::V4(ip))];
    params.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(key_authorization_digest)];
    params.alg = &rcgen::PKCS_ECDSA_P256_SHA256;
    let cert = rcgen::Certificate::from_params(params).map_err(|e| format!("challenge cert: {}", e))?;
    let der = cert.serialize_der().map_err(|e| format!("challenge cert: {}", e))?;
    certified_key(vec![der], &cert.serialize_private_key_der())
}

/// A throwaway self-signed certificate for one DNS name (the 443 probe).
fn self_signed_for_name(name: &str) -> Result<Arc<CertifiedKey>, String> {
    let cert = rcgen::generate_simple_self_signed(vec![name.to_string()]).map_err(|e| format!("probe cert: {}", e))?;
    let der = cert.serialize_der().map_err(|e| format!("probe cert: {}", e))?;
    certified_key(vec![der], &cert.serialize_private_key_der())
}

/// TLS 1.3 and 1.2 (1.2 only with ECDHE-ECDSA AEAD suites); the hybrid ML-KEM group first, then
/// X25519 and P-256; tickets from the provider's rotating ticketer; no 0-RTT. ALPN h2, http/1.1 and
/// acme-tls/1 in server order, so an ordinary client never lands on the validation protocol.
pub(crate) fn server_config(resolver: Arc<dyn ResolvesServerCert>) -> Result<rustls::ServerConfig, String> {
    use rustls::crypto::aws_lc_rs as p;
    let provider = rustls::crypto::CryptoProvider {
        cipher_suites: vec![
            p::cipher_suite::TLS13_AES_128_GCM_SHA256,
            p::cipher_suite::TLS13_AES_256_GCM_SHA384,
            p::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
            p::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            p::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            p::cipher_suite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
        ],
        kx_groups: vec![p::kx_group::X25519MLKEM768, p::kx_group::X25519, p::kx_group::SECP256R1],
        ..p::default_provider()
    };
    let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| format!("tls versions: {}", e))?
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec(), ALPN_ACME_TLS.to_vec()];
    cfg.ticketer = p::Ticketer::new().map_err(|e| format!("ticketer: {}", e))?;
    cfg.max_early_data_size = 0;
    cfg.ignore_client_order = true;
    Ok(cfg)
}

/// A TLS client that checks nothing about the server's certificate and only reports it: the genesis
/// 443 probe looks for its marker name, and a probe must not depend on a certificate the node has not
/// yet obtained. It does not check the handshake signature either: the certificate parser behind that
/// check refuses the tls-alpn-01 certificate's critical extension, and possession of a key the server
/// generated for itself proves nothing to a probe; only the names the certificate carries matter.
pub(crate) fn probe_client_config(alpn: &[&[u8]]) -> Result<rustls::ClientConfig, String> {
    report_only_client_config(alpn, &[&rustls::version::TLS13, &rustls::version::TLS12])
}

#[derive(Debug)]
struct ReportOnly(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for ReportOnly {
    fn verify_server_cert(
        &self, _end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8], _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self, _message: &[u8], _cert: &CertificateDer<'_>, _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self, _message: &[u8], _cert: &CertificateDer<'_>, _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `probe_client_config` for chosen protocol versions.
pub(crate) fn report_only_client_config(
    alpn: &[&[u8]],
    versions: &[&'static rustls::SupportedProtocolVersion],
) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(versions)
        .map_err(|e| format!("tls versions: {}", e))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ReportOnly(provider)))
        .with_no_client_auth();
    cfg.alpn_protocols = alpn.iter().map(|a| a.to_vec()).collect();
    Ok(cfg)
}

// ─── Listener ───────────────────────────────────────────────────────────────────────────────────

/// The plane's connection, handshake, HTTP and in-flight caps (code constants: no operator knob).
#[derive(Debug, Clone)]
pub(crate) struct Limits {
    pub(crate) conns_total: usize,
    pub(crate) conns_per_key: u32,
    pub(crate) handshakes: usize,
    /// Handshakes in flight per key: filling the node-wide slots takes many addresses, not a few.
    pub(crate) handshakes_per_key: u32,
    /// A connection that sends no byte of its hello within this is closed before the handshake.
    pub(crate) hello_timeout: Duration,
    pub(crate) handshake_timeout: Duration,
    /// HTTP/1 headers within this (also the next request on a kept-alive connection); on either
    /// protocol a new connection's first request.
    pub(crate) header_timeout: Duration,
    /// A connection with no request in flight for this long is closed.
    pub(crate) idle_timeout: Duration,
    /// A GET is answered within this of its arrival, or the connection goes.
    pub(crate) request_deadline: Duration,
    /// A POST's body is read and answered within this.
    pub(crate) post_deadline: Duration,
    /// An answer whose body hands nothing to the transport for this long is a stalled download.
    pub(crate) stall_timeout: Duration,
    /// Every body is fully handed over within `send_grace` plus its length at this many bytes a second.
    pub(crate) min_send_rate: u64,
    pub(crate) send_grace: Duration,
    /// A connection stops taking requests at this age and is dropped `retire_grace` later.
    pub(crate) conn_max_age: Duration,
    pub(crate) retire_grace: Duration,
    pub(crate) max_header_bytes: usize,
    pub(crate) h2_streams: u32,
    pub(crate) post_body_max: u64,
    /// Heavy answers (macroblock proofs, registry bodies) in flight per key, and node-wide by bytes.
    pub(crate) heavy_per_key: u32,
    pub(crate) heavy_inflight_bytes: u64,
}

impl Limits {
    pub(crate) fn production() -> Self {
        Self {
            conns_total: 8192,
            conns_per_key: 32,
            handshakes: 256,
            handshakes_per_key: 4,
            hello_timeout: Duration::from_secs(2),
            handshake_timeout: Duration::from_secs(5),
            header_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(60),
            request_deadline: Duration::from_secs(30),
            post_deadline: Duration::from_secs(10),
            stall_timeout: Duration::from_secs(20),
            min_send_rate: 64 * 1024,
            send_grace: Duration::from_secs(30),
            conn_max_age: Duration::from_secs(600),
            retire_grace: Duration::from_secs(60),
            max_header_bytes: 16 * 1024,
            h2_streams: 32,
            post_body_max: 64 * 1024,
            heavy_per_key: 2,
            heavy_inflight_bytes: 128 * 1024 * 1024,
        }
    }

    /// When a body of `len` bytes must have been handed over, counted from `now` (mono ms).
    fn send_deadline(&self, now: u64, len: u64) -> u64 {
        let rate = self.min_send_rate.max(1);
        now.saturating_add(self.send_grace.as_millis() as u64).saturating_add(len.saturating_mul(1000) / rate)
    }
}

/// The routes the plane hands requests to: the node's own warp routes behind a typed recover.
pub(crate) type PlaneRoutes = warp::filters::BoxedFilter<(warp::reply::Response,)>;

/// Everything one listener shares between its connections.
pub(crate) struct PlaneCtx {
    routes: PlaneRoutes,
    acceptor: tokio_rustls::TlsAcceptor,
    limits: Limits,
    egress: Arc<EgressBudget>,
    heavy: HeavySizes,
    conns: AtomicUsize,
    per_key: DashMap<IpAddr, u32>,
    handshakes: Arc<tokio::sync::Semaphore>,
    handshakes_per_key: DashMap<IpAddr, u32>,
    heavy_per_key: DashMap<IpAddr, u32>,
    heavy_bytes: AtomicU64,
}

/// Count one more for `key` in `map` unless it already holds `cap`; an entry exists only while its
/// count is above zero.
fn take_per_key(map: &DashMap<IpAddr, u32>, key: IpAddr, cap: u32) -> bool {
    let mut n = map.entry(key).or_insert(0);
    if *n >= cap {
        let empty = *n == 0;
        drop(n);
        if empty {
            map.remove_if(&key, |_, n| *n == 0);
        }
        return false;
    }
    *n += 1;
    true
}

fn give_per_key(map: &DashMap<IpAddr, u32>, key: IpAddr) {
    if let Some(mut n) = map.get_mut(&key) {
        *n = n.saturating_sub(1);
    }
    map.remove_if(&key, |_, n| *n == 0);
}

impl PlaneCtx {
    pub(crate) fn new(routes: PlaneRoutes, tls: rustls::ServerConfig, limits: Limits, egress: EgressBudget) -> Arc<Self> {
        Arc::new(Self {
            routes,
            acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(tls)),
            handshakes: Arc::new(tokio::sync::Semaphore::new(limits.handshakes)),
            limits,
            egress: Arc::new(egress),
            heavy: HeavySizes::new(),
            conns: AtomicUsize::new(0),
            per_key: DashMap::new(),
            handshakes_per_key: DashMap::new(),
            heavy_per_key: DashMap::new(),
            heavy_bytes: AtomicU64::new(0),
        })
    }

    pub(crate) fn open_connections(&self) -> usize {
        self.conns.load(Ordering::Relaxed)
    }

    /// Heavy answers in flight node-wide, by the bytes they were admitted or built at.
    pub(crate) fn heavy_bytes_in_flight(&self) -> u64 {
        self.heavy_bytes.load(Ordering::Relaxed)
    }

    fn admit_conn(self: &Arc<Self>, key: IpAddr) -> Option<ConnGuard> {
        if self.conns.fetch_add(1, Ordering::AcqRel) >= self.limits.conns_total {
            self.conns.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        if !take_per_key(&self.per_key, key, self.limits.conns_per_key) {
            self.conns.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(ConnGuard { ctx: Arc::clone(self), key })
    }

    /// A handshake slot: the key's share first, then the node-wide one.
    fn admit_handshake(self: &Arc<Self>, key: IpAddr) -> Option<HandshakeSlot> {
        if !take_per_key(&self.handshakes_per_key, key, self.limits.handshakes_per_key) {
            return None;
        }
        match Arc::clone(&self.handshakes).try_acquire_owned() {
            Ok(permit) => Some(HandshakeSlot { ctx: Arc::clone(self), key, _permit: permit }),
            Err(_) => {
                give_per_key(&self.handshakes_per_key, key);
                None
            }
        }
    }

    /// A heavy answer's slot: the key's share, then the node-wide bytes, admitted on `estimate`.
    fn admit_heavy(self: &Arc<Self>, key: IpAddr, estimate: u64) -> Option<HeavySlot> {
        if !take_per_key(&self.heavy_per_key, key, self.limits.heavy_per_key) {
            return None;
        }
        let before = self.heavy_bytes.fetch_add(estimate, Ordering::AcqRel);
        if before.saturating_add(estimate) > self.limits.heavy_inflight_bytes {
            self.heavy_bytes.fetch_sub(estimate, Ordering::AcqRel);
            give_per_key(&self.heavy_per_key, key);
            return None;
        }
        Some(HeavySlot { ctx: Arc::clone(self), key, bytes: estimate })
    }

    /// The response as the transport gets it: its body metered, its request's watch told the answer
    /// exists (from now on its body must keep moving and be handed over by its deadline).
    fn finish(&self, resp: warp::reply::Response, meter: Meter, mut heavy: Option<HeavySlot>, ticket: Ticket) -> Response<PlaneBody> {
        let (parts, inner) = resp.into_parts();
        let len = inner.size_hint().exact().unwrap_or(UNKNOWN_BODY_LEN);
        if let Some(h) = heavy.as_mut() {
            h.resize(len);
        }
        let now = mono_ms();
        ticket.responded(now, self.limits.send_deadline(now, len));
        Response::from_parts(parts, PlaneBody { inner, pending: bytes::Bytes::new(), meter, ticket: Some(ticket), _heavy: heavy })
    }
}

/// One admitted connection; dropping it frees its slots.
struct ConnGuard {
    ctx: Arc<PlaneCtx>,
    key: IpAddr,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.ctx.conns.fetch_sub(1, Ordering::AcqRel);
        give_per_key(&self.ctx.per_key, self.key);
    }
}

/// One handshake in flight; dropping it frees the key's share and the node-wide slot.
struct HandshakeSlot {
    ctx: Arc<PlaneCtx>,
    key: IpAddr,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        give_per_key(&self.ctx.handshakes_per_key, self.key);
    }
}

// ─── Connection watchdog ────────────────────────────────────────────────────────────────────────

/// What one connection is doing, for its watchdog. Only a request arriving and response bytes handed
/// to the transport count as progress: nothing the client sends (HTTP/2 pings, window updates and
/// settings, a trickled body) keeps a connection or an answer alive.
pub(crate) struct ConnWatch {
    opened: u64,
    state: parking_lot::Mutex<WatchState>,
    wake: tokio::sync::Notify,
}

#[derive(Default)]
struct WatchState {
    next_id: u64,
    active: std::collections::HashMap<u64, Activity>,
    /// When the last request ended, or the connection opened: the idle clock.
    quiet_since: u64,
    requests: u64,
}

#[derive(Debug, Clone, Copy)]
struct Activity {
    /// The arrival; once answered, the last body piece handed over.
    progress: u64,
    /// Answered and fully handed over by then, or the connection goes.
    deadline: u64,
    answered: bool,
}

/// The watchdog's verdict on a connection at one instant (times are mono ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Nothing is due before this time.
    Keep(u64),
    /// Old enough: take no new request, finish the ones in flight; look again at this time.
    Retire(u64),
    Drop(&'static str),
}

impl ConnWatch {
    pub(crate) fn new(now: u64) -> Arc<Self> {
        Arc::new(Self {
            opened: now,
            state: parking_lot::Mutex::new(WatchState { quiet_since: now, ..Default::default() }),
            wake: tokio::sync::Notify::new(),
        })
    }

    /// A request arrived: it must be answered within `within`.
    pub(crate) fn begin(self: &Arc<Self>, now: u64, within: Duration) -> Ticket {
        let id = {
            let mut s = self.state.lock();
            let id = s.next_id;
            s.next_id += 1;
            s.requests += 1;
            s.active.insert(id, Activity { progress: now, deadline: now.saturating_add(within.as_millis() as u64), answered: false });
            id
        };
        self.wake.notify_one();
        Ticket { watch: Arc::clone(self), id }
    }

    pub(crate) fn verdict(&self, now: u64, limits: &Limits) -> Verdict {
        let s = self.state.lock();
        let stall = limits.stall_timeout.as_millis() as u64;
        let mut next = u64::MAX;
        for a in s.active.values() {
            if now >= a.deadline {
                return Verdict::Drop("deadline");
            }
            next = next.min(a.deadline);
            if a.answered {
                let stalled_at = a.progress.saturating_add(stall);
                if now >= stalled_at {
                    return Verdict::Drop("stalled");
                }
                next = next.min(stalled_at);
            }
        }
        if s.active.is_empty() {
            let quiet = if s.requests == 0 { limits.header_timeout } else { limits.idle_timeout };
            let idle_at = s.quiet_since.saturating_add(quiet.as_millis() as u64);
            if now >= idle_at {
                return Verdict::Drop("idle");
            }
            next = next.min(idle_at);
        }
        let retire_at = self.opened.saturating_add(limits.conn_max_age.as_millis() as u64);
        let drop_at = retire_at.saturating_add(limits.retire_grace.as_millis() as u64);
        if now >= drop_at {
            return Verdict::Drop("max_age");
        }
        next = next.min(drop_at);
        if now >= retire_at {
            return Verdict::Retire(next);
        }
        Verdict::Keep(next.min(retire_at))
    }
}

/// One request's place in its connection's watch, carried by its answer's body; ending it (the body
/// handed over or dropped) restarts the connection's idle clock.
pub(crate) struct Ticket {
    watch: Arc<ConnWatch>,
    id: u64,
}

impl Ticket {
    fn responded(&self, now: u64, deadline: u64) {
        if let Some(a) = self.watch.state.lock().active.get_mut(&self.id) {
            *a = Activity { progress: now, deadline, answered: true };
        }
        self.watch.wake.notify_one();
    }

    fn progress(&self, now: u64) {
        if let Some(a) = self.watch.state.lock().active.get_mut(&self.id) {
            a.progress = now;
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        {
            let mut s = self.watch.state.lock();
            s.active.remove(&self.id);
            s.quiet_since = mono_ms();
        }
        self.watch.wake.notify_one();
    }
}

/// Drive `conn` until it ends (Ok) or its watchdog gives it up (Err with the reason; the connection is
/// dropped with the future). `retire` asks the connection to finish what is in flight and take no more.
pub(crate) async fn drive<F: std::future::Future>(
    mut conn: Pin<&mut F>,
    watch: &ConnWatch,
    limits: &Limits,
    mut retire: impl FnMut(Pin<&mut F>),
) -> Result<(), &'static str> {
    let mut retired = false;
    loop {
        let now = mono_ms();
        let next = match watch.verdict(now, limits) {
            Verdict::Drop(why) => return Err(why),
            Verdict::Retire(next) => {
                if !retired {
                    retired = true;
                    retire(conn.as_mut());
                }
                next
            }
            Verdict::Keep(next) => next,
        };
        let wait = Duration::from_millis(next.saturating_sub(now).max(1));
        tokio::select! {
            _ = conn.as_mut() => return Ok(()),
            _ = tokio::time::sleep(wait) => {}
            _ = watch.wake.notified() => {}
        }
    }
}

/// Accept connections until the listener fails. Over a connection or handshake cap (node-wide or the
/// key's share) a connection is closed at accept; a client that sends no hello within `hello_timeout`
/// is closed, the handshake has `handshake_timeout`; then the watchdog (`ConnWatch`) keeps a
/// connection only while its requests make progress.
pub(crate) async fn serve(listener: tokio::net::TcpListener, ctx: Arc<PlaneCtx>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                // Out of descriptors and the like: back off a moment instead of spinning.
                if is_warn() {
                    println!("[WARN][WALLETRPC] accept_failed err={}", e);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let key = plane_key(peer.ip());
        let Some(guard) = ctx.admit_conn(key) else {
            PLANE_STATS.refused_conn_cap.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let Some(handshake) = ctx.admit_handshake(key) else {
            PLANE_STATS.refused_handshake.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let ctx = Arc::clone(&ctx);
        tokio::spawn(async move {
            let _guard = guard;
            serve_conn(stream, peer, key, handshake, ctx).await;
        });
    }
}

async fn serve_conn(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    key: IpAddr,
    handshake: HandshakeSlot,
    ctx: Arc<PlaneCtx>,
) {
    let _ = stream.set_nodelay(true);
    // A connection that says nothing gives its handshake slot back early.
    if !matches!(tokio::time::timeout(ctx.limits.hello_timeout, stream.readable()).await, Ok(Ok(()))) {
        PLANE_STATS.handshake_failed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let tls = match tokio::time::timeout(ctx.limits.handshake_timeout, ctx.acceptor.accept(stream)).await {
        Ok(Ok(s)) => s,
        _ => {
            PLANE_STATS.handshake_failed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    drop(handshake);
    PLANE_STATS.handshakes.fetch_add(1, Ordering::Relaxed);
    let (alpn, probe) = {
        let (_, conn) = tls.get_ref();
        let probe = conn.server_name().map_or(false, |n| n.len() > PROBE_SUFFIX.len()
            && n[n.len() - PROBE_SUFFIX.len()..].eq_ignore_ascii_case(PROBE_SUFFIX));
        (conn.alpn_protocol().map(|p| p.to_vec()), probe)
    };
    if alpn.as_deref() == Some(ALPN_ACME_TLS) || probe {
        // A validation or probe handshake had only to see the certificate.
        let mut tls = tls;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut tls).await;
        return;
    }
    let mut http = warp::hyper::server::conn::Http::new();
    if alpn.as_deref() == Some(b"h2") {
        http.http2_only(true)
            .http2_max_concurrent_streams(ctx.limits.h2_streams)
            .http2_max_header_list_size(ctx.limits.max_header_bytes as u32);
    } else {
        http.http1_only(true)
            .http1_header_read_timeout(ctx.limits.header_timeout)
            .max_buf_size(ctx.limits.max_header_bytes.max(8192));
    }
    let watch = ConnWatch::new(mono_ms());
    let (svc_ctx, svc_watch) = (Arc::clone(&ctx), Arc::clone(&watch));
    let svc = warp::hyper::service::service_fn(move |req| plane_request(req, peer, key, Arc::clone(&svc_ctx), Arc::clone(&svc_watch)));
    let conn = http.serve_connection(tls, svc);
    tokio::pin!(conn);
    if let Err(why) = drive(conn.as_mut(), &watch, &ctx.limits, |c| c.graceful_shutdown()).await {
        if why != "idle" {
            PLANE_STATS.stalled.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// One request on the plane: its place in the connection's watch, the allowlist, a heavy answer's
/// in-flight slot and egress reservation, the trusted peer extensions, the node's own routes, then the
/// body metered as the transport takes it.
async fn plane_request(
    mut req: Request<Body>,
    peer: SocketAddr,
    key: IpAddr,
    ctx: Arc<PlaneCtx>,
    watch: Arc<ConnWatch>,
) -> Result<Response<PlaneBody>, Infallible> {
    let post = *req.method() == Method::POST;
    let ticket = watch.begin(mono_ms(), if post { ctx.limits.post_deadline } else { ctx.limits.request_deadline });
    let refuse = |r: warp::reply::Response, ticket: Ticket| -> Result<Response<PlaneBody>, Infallible> {
        Ok(ctx.finish(r, Meter::unreserved(&ctx.egress), None, ticket))
    };
    let Some(route) = wallet_route_allowed(req.method(), req.uri().path(), req.uri().query()) else {
        PLANE_STATS.not_allowed.fetch_add(1, Ordering::Relaxed);
        return refuse(plane_refusal(StatusCode::NOT_FOUND, "not_found", None), ticket);
    };
    if post {
        let declared = req.headers().get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        match declared {
            Some(n) if n <= ctx.limits.post_body_max => {}
            Some(_) => return refuse(plane_refusal(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", None), ticket),
            None => return refuse(plane_refusal(StatusCode::LENGTH_REQUIRED, "length_required", None), ticket),
        }
    }
    let (meter, heavy) = if route.heavy() && *req.method() == Method::GET {
        let estimate = ctx.heavy.estimate(route, req.uri().path());
        let Some(slot) = ctx.admit_heavy(key, estimate) else {
            return refuse(plane_busy(1), ticket);
        };
        match ctx.egress.reserve(ctx.egress.reservation_for(estimate)) {
            Ok(m) => (m, Some(slot)),
            Err(wait) => return refuse(plane_busy(wait), ticket),
        }
    } else {
        (Meter::unreserved(&ctx.egress), None)
    };
    req.extensions_mut().insert(WalletPeer { peer, key });
    req.extensions_mut().insert(WalletPlane);
    let mut svc = warp::service(ctx.routes.clone());
    let resp = match svc.call(req).await {
        Ok(r) => r,
        Err(never) => match never {},
    };
    PLANE_STATS.served.fetch_add(1, Ordering::Relaxed);
    if heavy.is_some() && resp.status() == StatusCode::OK {
        if let Some(n) = resp.body().size_hint().exact() {
            ctx.heavy.note(route, n);
        }
    }
    Ok(ctx.finish(resp, meter, heavy, ticket))
}

// ─── Start ──────────────────────────────────────────────────────────────────────────────────────

/// Why this node opens no wallet plane, or None when it does: only a super node that is not a
/// genesis identity and does not hide its address serves wallets.
pub(crate) fn plane_off_reason(node_type: crate::node::NodeType, node_id: &str) -> Option<&'static str> {
    if node_type != crate::node::NodeType::Super {
        return Some("light");
    }
    if node_id.starts_with("genesis_node_") {
        return Some("genesis_identity");
    }
    if std::env::var("QNET_HIDE_IP").is_ok() {
        return Some("hide_ip");
    }
    None
}

/// Worker threads of the plane's runtime: a quarter of the cores, 2 to 4, so wallet traffic never
/// takes a worker from consensus.
pub(crate) fn plane_threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 4).clamp(2, 4)
}

/// Open the plane on its own runtime and thread. Nothing here can stop the node: a failure is logged
/// and the plane stays closed (or retries its bind every minute).
pub(crate) fn start(routes: PlaneRoutes) {
    let threads = plane_threads();
    let spawned = std::thread::Builder::new().name("qnet-wallet-rt".into()).spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(threads)
            .thread_name("qnet-wallet-rt")
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[ERR][WALLETRPC] runtime_build_failed err={}", e);
                return;
            }
        };
        rt.block_on(run(routes, threads));
    });
    if let Err(e) = spawned {
        eprintln!("[ERR][WALLETRPC] thread_spawn_failed err={}", e);
    }
}

async fn run(routes: PlaneRoutes, threads: usize) {
    let cert_store: Arc<CertStore> = Arc::clone(&WALLET_CERTS);
    let tls = match server_config(cert_store) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ERR][WALLETRPC] tls_config_failed err={}", e);
            return;
        }
    };
    let ctx = PlaneCtx::new(routes, tls, Limits::production(), EgressBudget::new(EGRESS_BYTES_PER_SEC, EGRESS_BURST_BYTES));
    tokio::spawn(log_stats(Arc::clone(&ctx)));
    let addr = SocketAddr::from(([0, 0, 0, 0], WALLET_PLANE_PORT));
    loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if is_info() {
                    println!("[INFO][WALLETRPC] plane_listening addr={} threads={}", addr, threads);
                }
                serve(listener, Arc::clone(&ctx)).await;
            }
            Err(e) => {
                if is_warn() {
                    println!("[WARN][WALLETRPC] bind_failed addr={} err={} retry_in=60s", addr, e);
                }
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        }
    }
}

async fn log_stats(ctx: Arc<PlaneCtx>) {
    loop {
        tokio::time::sleep(STATS_EVERY).await;
        if !is_info() {
            continue;
        }
        let s = &*PLANE_STATS;
        let hours_left = WALLET_CERTS.installed()
            .map(|c| (c.not_after.saturating_sub(unix_now()) / 3600).to_string())
            .unwrap_or_else(|| "none".to_string());
        println!("[INFO][WALLETRPC] stats conns={} handshakes={} handshake_failed={} refused_conn_cap={} refused_handshake={} \
                  served={} not_allowed={} rate_limited={} busy={} stalled={} heavy_inflight_mb={} egress_mb={} serve_proofs={} \
                  mb_cache_hits={} cert_hours_left={}",
                 ctx.open_connections(), take(&s.handshakes), take(&s.handshake_failed), take(&s.refused_conn_cap),
                 take(&s.refused_handshake), take(&s.served), take(&s.not_allowed), take(&s.rate_limited), take(&s.busy),
                 take(&s.stalled), ctx.heavy_bytes_in_flight() / 1_000_000, take(&s.egress_bytes) / 1_000_000,
                 take(&s.serve_proofs), take(&s.mb_cache_hits), hours_left);
    }
}

#[cfg(test)]
#[path = "wallet_plane_tests.rs"]
mod tests;

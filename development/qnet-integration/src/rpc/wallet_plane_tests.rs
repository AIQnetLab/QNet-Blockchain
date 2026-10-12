//! The wallet plane: allowlist, client key, typed refusals, caps, egress, the connection watchdog,
//! runtime isolation and the certificate resolver, against real TLS connections on loopback.

use super::*;
use std::net::Ipv6Addr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────

fn get(path: &str) -> Request<Body> {
    Request::builder().method(Method::GET).uri(path).body(Body::empty()).unwrap()
}

fn routes_ok() -> PlaneRoutes {
    warp::any().map(|| warp::Reply::into_response("ok")).boxed()
}

/// A route set that answers every request with `len` zero bytes.
fn routes_sized(len: usize) -> PlaneRoutes {
    let body = bytes::Bytes::from(vec![0u8; len]);
    warp::any().map(move || warp::reply::Response::new(Body::from(body.clone()))).boxed()
}

/// A route set that counts what reaches it.
fn counting_routes(hits: Arc<AtomicUsize>) -> PlaneRoutes {
    warp::any()
        .map(move || {
            hits.fetch_add(1, Ordering::SeqCst);
            warp::Reply::into_response("reached")
        })
        .boxed()
}

fn ctx_with(routes: PlaneRoutes, limits: Limits, egress: EgressBudget, certs: Arc<CertStore>) -> Arc<PlaneCtx> {
    PlaneCtx::new(routes, server_config(certs).unwrap(), limits, egress)
}

fn plain_ctx(routes: PlaneRoutes) -> Arc<PlaneCtx> {
    ctx_with(routes, Limits::production(), EgressBudget::new(EGRESS_BYTES_PER_SEC, EGRESS_BURST_BYTES), Arc::new(CertStore::new()))
}

fn peer(ip: &str) -> SocketAddr {
    SocketAddr::new(ip.parse().unwrap(), 40000)
}

/// One request through the plane's wrapper from `ip` (its own key), on a connection of its own.
async fn call(ctx: &Arc<PlaneCtx>, req: Request<Body>, ip: &str) -> Response<PlaneBody> {
    plane_request(req, peer(ip), ip.parse().unwrap(), Arc::clone(ctx), ConnWatch::new(mono_ms())).await.unwrap()
}

async fn parts<B: HttpBody>(r: Response<B>) -> (StatusCode, warp::http::HeaderMap, Vec<u8>)
where
    B::Error: std::fmt::Debug,
{
    let status = r.status();
    let headers = r.headers().clone();
    let body = warp::hyper::body::to_bytes(r.into_body()).await.unwrap().to_vec();
    (status, headers, body)
}

/// A serving certificate for 127.0.0.1, self-signed, installed into `certs`.
fn install_loopback_cert(certs: &CertStore, label: &str) -> Vec<u8> {
    let now = unix_now();
    install_loopback_cert_valid(certs, label, now - 60, now + 3600)
}

/// As `install_loopback_cert`, installed with the given validity.
fn install_loopback_cert_valid(certs: &CertStore, label: &str, not_before: u64, not_after: u64) -> Vec<u8> {
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, label);
    params.subject_alt_names = vec![rcgen::SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST))];
    let cert = rcgen::Certificate::from_params(params).unwrap();
    let der = cert.serialize_der().unwrap();
    let key = certified_key(vec![der.clone()], &cert.serialize_private_key_der()).unwrap();
    certs.install(Installed { key, ip: Ipv4Addr::LOCALHOST, not_before, not_after });
    der
}

async fn start_plane_with(routes: PlaneRoutes, limits: Limits, egress: EgressBudget, certs: Arc<CertStore>) -> (SocketAddr, Arc<PlaneCtx>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ctx = ctx_with(routes, limits, egress, certs);
    tokio::spawn(serve(listener, Arc::clone(&ctx)));
    (addr, ctx)
}

async fn start_plane(routes: PlaneRoutes, limits: Limits, certs: Arc<CertStore>) -> (SocketAddr, Arc<PlaneCtx>) {
    start_plane_with(routes, limits, EgressBudget::new(EGRESS_BYTES_PER_SEC, EGRESS_BURST_BYTES), certs).await
}

type ClientTls = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

async fn tls_connect(addr: SocketAddr, sni: Option<&str>, alpn: &[&[u8]]) -> std::io::Result<ClientTls> {
    let cfg = probe_client_config(alpn).unwrap();
    let name = match sni {
        Some(n) => rustls::pki_types::ServerName::try_from(n.to_string()).unwrap(),
        None => rustls::pki_types::ServerName::IpAddress(addr.ip().into()),
    };
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp).await
}

fn leaf_of(tls: &ClientTls) -> Vec<u8> {
    tls.get_ref().1.peer_certificates().unwrap()[0].as_ref().to_vec()
}

/// One HTTP/1.1 request on an open connection; the status and body.
async fn http1(tls: &mut ClientTls, path: &str) -> std::io::Result<(u16, String)> {
    tls.write_all(format!("GET {} HTTP/1.1\r\nHost: plane\r\n\r\n", path).as_bytes()).await?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = tls.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let head = &text[..end];
            let len: usize = head.lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
                return Ok((status, text[end + 4..end + 4 + len].to_string()));
            }
        }
    }
}

/// Whether the peer closes a TCP connection within `within` (EOF or reset), sending nothing.
async fn closed_within(stream: &mut tokio::net::TcpStream, within: Duration) -> bool {
    let mut b = [0u8; 1];
    matches!(tokio::time::timeout(within, stream.read(&mut b)).await, Ok(Ok(0)) | Ok(Err(_)))
}

/// Wait until the listener holds no connection, at most `within`.
async fn all_closed(ctx: &PlaneCtx, within: Duration) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if ctx.open_connections() == 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    ctx.open_connections() == 0
}

// ─── Allowlist ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn wallet_plane_allows_only_the_listed_routes() {
    use WalletRoute::*;
    let g = |path: &str, q: Option<&str>| wallet_route_allowed(&Method::GET, path, q);
    let p = |path: &str| wallet_route_allowed(&Method::POST, path, None);
    // Exactly the listed reads, and the submit.
    let allowed: &[(Method, &str, Option<&str>, WalletRoute)] = &[
        (Method::GET, "/healthz", None, Healthz),
        (Method::GET, "/api/v1/state/certified", None, StateCertified),
        (Method::GET, "/api/v1/account/eon_x/balance/proof", Some("mb=7"), AccountProof),
        (Method::GET, "/api/v1/account/eon_x/balance/proof", Some("mb=latest"), AccountProof),
        (Method::GET, "/api/v1/account/eon_x/balance/proof", Some("mb="), AccountProof),
        (Method::GET, "/api/v1/token/eon_c/eon_h/balance/proof", Some("mb=3"), TokenProof),
        (Method::GET, "/api/v1/logs/proof", Some("tx_hash=ab&log_index=0"), LogsProof),
        (Method::GET, "/api/v1/macroblock/12/proof", None, MacroblockProof),
        (Method::GET, "/api/v1/galc/capsule", None, GalcCapsule),
        (Method::OPTIONS, "/api/v1/galc/capsule", None, GalcCapsule),
        (Method::GET, "/api/v1/registry/height/1080", None, Registry),
        (Method::GET, "/api/v1/node/serve-proof", Some("challenge=00"), ServeProof),
        (Method::GET, "/api/v1/nodes/rpc", Some("ids=super_node_0011223344556677"), NodesRpc),
        (Method::GET, "/api/v1/whoami", None, Whoami),
        (Method::POST, "/api/v1/transaction", None, Transaction),
        (Method::OPTIONS, "/api/v1/transaction", None, Transaction),
        (Method::OPTIONS, "/api/v1/state/certified", None, StateCertified),
    ];
    for (m, path, q, want) in allowed {
        assert_eq!(wallet_route_allowed(m, path, *q), Some(*want), "{} {} {:?}", m, path, q);
    }
    // Everything else every node serves: legacy proofs, unproven reads, the WebSocket, registration,
    // activation, device and ping routes, every gated path, the peer list.
    let refused_get: &[(&str, Option<&str>)] = &[
        ("/api/v1/account/eon_x/balance/proof", None),
        ("/api/v1/account/eon_x/balance/proof", Some("MB=1")),
        ("/api/v1/token/eon_c/eon_h/balance/proof", None),
        ("/api/v1/account/eon_x", None),
        ("/api/v1/account/eon_x/balance", None),
        ("/api/v1/account/eon_x/transactions", None),
        ("/api/v1/account/eon_x/tokens", None),
        ("/api/v1/validators/proof", None),
        ("/api/v1/peers", None),
        ("/api/v1/nodes/discovery", None),
        ("/api/v1/height", None),
        ("/api/v1/macroblock/12", None),
        ("/api/v1/macroblock/abc/proof", None),
        ("/api/v1/macroblock/-1/proof", None),
        ("/api/v1/macroblock/123456789012345678901/proof", None),
        ("/api/v1/registry/height/x", None),
        ("/api/v1/galc", None),
        ("/api/v1/galc/capsule/", None),
        ("/api/v1/galc/capsule/x", None),
        ("/api/v1/galc/capsules", None),
        ("/api/v1/block/latest", None),
        ("/api/v1/blocks/headers", None),
        ("/api/v1/archive", None),
        ("/api/v1/snapshot/latest", None),
        ("/api/v1/transaction/abcd", None),
        ("/api/v1/transactions/history", Some("address=eon_x")),
        ("/api/v1/mempool/status", None),
        ("/api/v1/node/health", None),
        ("/api/v1/node/secure-info", None),
        ("/api/v1/node/status", None),
        ("/api/v1/light-node/next-ping", None),
        ("/api/v1/light-node/device-challenge", None),
        ("/api/v1/rewards/pending/x", None),
        ("/api/v1/node-device", None),
        ("/api/v1/internal/fcm-token-get", None),
        ("/api/v1/internal/light-device-get", None),
        ("/api/v1/debug/consensus-position", None),
        ("/api/v1/benchmark/status", None),
        ("/api/v1/stats", None),
        ("/ws/subscribe", None),
        ("/health", None),
        ("/", None),
        ("/rpc", None),
        ("/healthz/", None),
        ("/api/v1/whoami/", None),
        ("//api/v1/whoami", None),
        ("/api/v1/state/certified/x", None),
        ("api/v1/whoami", None),
    ];
    for (path, q) in refused_get {
        assert_eq!(g(path, *q), None, "GET {} {:?}", path, q);
    }
    for path in ["/rpc", "/", "/api/v1/node-registration/submit", "/api/v1/node-reactivation/submit", "/api/v1/register-device",
                 "/api/v1/light-node/register", "/api/v1/light-node/ping-response", "/api/v1/light-node/bind", "/api/v1/p2p/message",
                 "/api/v1/shutdown", "/api/v1/internal/fcm-token-sync", "/api/v1/rewards/claim", "/api/v1/batch/transfer",
                 "/api/v1/contract/deploy", "/api/v1/bundle/submit", "/api/v1/macroblock/12/proof", "/api/v1/state/certified",
                 "/api/v1/galc/capsule"] {
        assert_eq!(p(path), None, "POST {}", path);
    }
    // Methods: a read is GET only, the submit POST only.
    assert_eq!(g("/api/v1/transaction", None), None);
    for m in [Method::PUT, Method::DELETE, Method::PATCH, Method::HEAD] {
        assert_eq!(wallet_route_allowed(&m, "/api/v1/state/certified", None), None, "{}", m);
        assert_eq!(wallet_route_allowed(&m, "/api/v1/transaction", None), None, "{}", m);
    }

    // Every first path segment the node's routes use: only the listed ones can pass at all.
    // Checkouts may carry CRLF; the scan reads LF.
    let src = include_str!("mod.rs").replace("\r\n", "\n");
    let src = src.as_str();
    let first_segments: std::collections::BTreeSet<&str> = src.match_indices("api_v1\n").filter_map(|(at, _)| {
        let rest = src[at..].split_once("warp::path(\"")?.1;
        // Only the segment that directly follows `api_v1`.
        let between = &src[at..at + src[at..].find("warp::path(\"")?];
        if between.lines().count() > 2 { return None; }
        rest.split('"').next()
    }).collect();
    assert!(first_segments.len() > 30, "segments read from mod.rs: {:?}", first_segments);
    let listed = ["state", "account", "token", "logs", "macroblock", "galc", "registry", "node", "nodes", "whoami", "transaction"];
    for seg in &first_segments {
        if listed.contains(seg) {
            continue;
        }
        for path in [format!("/api/v1/{}", seg), format!("/api/v1/{}/x", seg), format!("/api/v1/{}/x/y", seg)] {
            for m in [Method::GET, Method::POST, Method::OPTIONS, Method::DELETE] {
                assert_eq!(wallet_route_allowed(&m, &path, Some("mb=1")), None, "{} {}", m, path);
            }
        }
    }
}

#[tokio::test]
async fn refused_requests_never_reach_the_routes() {
    let hits = Arc::new(AtomicUsize::new(0));
    let ctx = plain_ctx(counting_routes(Arc::clone(&hits)));
    for path in ["/api/v1/peers", "/api/v1/account/eon_x/balance/proof", "/ws/subscribe", "/api/v1/internal/fcm-token-get",
                 "/api/v1/node-reactivation/submit", "/rpc", "/api/v1/light-node/next-ping"] {
        let (status, headers, body) = parts(call(&ctx, get(path), "198.51.100.7").await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{}", path);
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!((v["proof_format"].clone(), v["error"].clone()), (json!(2), json!("not_found")), "{}", path);
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "*");
    }
    let mut post = Request::builder().method(Method::POST).uri("/api/v1/node-registration/submit").body(Body::from("{}")).unwrap();
    post.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from_static("2"));
    assert_eq!(call(&ctx, post, "198.51.100.7").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(hits.load(Ordering::SeqCst), 0, "no refused request reached the routes");
    let r = call(&ctx, get("/api/v1/whoami"), "198.51.100.7").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn plane_requests_carry_the_trusted_peer_and_marker() {
    let routes: PlaneRoutes = warp::ext::optional::<WalletPeer>()
        .and(warp::ext::optional::<WalletPlane>())
        .and(super::client_addr())
        .map(|wp: Option<WalletPeer>, plane: Option<WalletPlane>, client: Option<SocketAddr>| {
            warp::Reply::into_response(format!("{:?}|{}|{:?}", wp.map(|w| (w.peer, w.key)), plane.is_some(), client))
        })
        .boxed();
    let ctx = plain_ctx(routes);
    let mut req = get("/api/v1/whoami");
    // A client-written header changes nothing on the plane.
    req.headers_mut().insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
    let p = peer("203.0.113.9");
    let r = plane_request(req, p, plane_key(p.ip()), ctx, ConnWatch::new(mono_ms())).await.unwrap();
    let (_, _, body) = parts(r).await;
    let body = String::from_utf8(body).unwrap();
    assert_eq!(body, format!("{:?}|true|{:?}", Some((p, p.ip())), Some(SocketAddr::new(p.ip(), 0))));
}

#[tokio::test]
async fn wallet_peer_replaces_forwarded_for() {
    let ca = super::client_addr();
    // On the plane: the TLS peer's key, whatever X-Forwarded-For says, even from a loopback socket.
    let plane = WalletPeer { peer: peer("203.0.113.9"), key: "203.0.113.9".parse().unwrap() };
    let got = warp::test::request().remote_addr(peer("127.0.0.1")).header("x-forwarded-for", "1.2.3.4")
        .extension(plane).filter(&ca).await.unwrap();
    assert_eq!(got, Some(SocketAddr::new("203.0.113.9".parse().unwrap(), 0)));
    // Off the plane: today's rule (a loopback proxy names the client in its last entry).
    let got = warp::test::request().remote_addr(peer("127.0.0.1")).header("x-forwarded-for", "9.9.9.9, 1.2.3.4").filter(&ca).await.unwrap();
    assert_eq!(got, Some(SocketAddr::new("1.2.3.4".parse().unwrap(), 0)));
    let got = warp::test::request().remote_addr(peer("198.51.100.3")).header("x-forwarded-for", "1.2.3.4").filter(&ca).await.unwrap();
    assert_eq!(got, Some(peer("198.51.100.3")));
    // One /64 is one source; another /64 is another.
    let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
    let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
    let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(plane_key(a), plane_key(b));
    assert_ne!(plane_key(a), plane_key(c));
    assert_eq!(plane_key(a), IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 0, 0, 0, 0)));
    // IPv4 as is, also when mapped.
    assert_eq!(plane_key("203.0.113.9".parse().unwrap()), "203.0.113.9".parse::<IpAddr>().unwrap());
    assert_eq!(plane_key("::ffff:203.0.113.9".parse().unwrap()), "203.0.113.9".parse::<IpAddr>().unwrap());
    // A peer the container runtime proxied (loopback, private, link-local) is one shared, unwhitelisted bucket.
    for masked in ["127.0.0.1", "::1", "10.1.2.3", "172.17.0.1", "192.168.1.5", "169.254.1.1", "fd00::1", "0.0.0.0"] {
        let k = plane_key(masked.parse().unwrap());
        assert_eq!(k, IpAddr::V4(Ipv4Addr::UNSPECIFIED), "{}", masked);
        assert!(!is_ip_whitelisted(k), "{}", masked);
    }
}

#[tokio::test]
async fn gated_routes_refuse_the_wallet_plane_marker() {
    let gate = super::gate_addr();
    let local = warp::test::request().remote_addr(peer("127.0.0.1")).filter(&gate).await.unwrap();
    assert_eq!(local, Some(peer("127.0.0.1")), "a local operator call is still local off the plane");
    let on_plane = warp::test::request().remote_addr(peer("127.0.0.1")).extension(WalletPlane).filter(&gate).await.unwrap();
    let nobody = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    assert_eq!(on_plane, Some(nobody), "through the plane a gated route sees nobody in particular");
    assert!(!is_internal_ip(&nobody.ip().to_string()) && !is_ip_whitelisted(nobody.ip()));
    assert!(!super::misc_api::is_genesis_peer_ip(&nobody.ip().to_string()));
    // Every gated path is outside the allowlist in the first place.
    for p in GATED_PATHS {
        let path = if p.ends_with('/') { format!("{}fcm-token-get", p) } else { p.to_string() };
        for m in [Method::GET, Method::POST, Method::OPTIONS] {
            assert_eq!(wallet_route_allowed(&m, &path, None), None, "{} {}", m, path);
        }
    }
}

#[tokio::test]
async fn wallet_plane_refusals_are_typed() {
    let typed = |status: StatusCode, headers: &warp::http::HeaderMap, body: &[u8], error: &str, retry: Option<&str>| {
        let v: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(v["proof_format"], json!(2), "{}", error);
        assert_eq!(v["error"], json!(error));
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store", "{}", error);
        assert_eq!(headers.get(header::RETRY_AFTER).map(|h| h.to_str().unwrap().to_string()).as_deref(), retry, "{} {}", error, status);
        if let Some(r) = retry {
            assert_eq!(v["retry_after_seconds"], json!(r.parse::<u64>().unwrap()));
        }
    };
    let (s, h, b) = parts(call(&plain_ctx(routes_ok()), get("/api/v1/peers"), "198.51.100.8").await).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    typed(s, &h, &b, "not_found", None);
    // A route bucket on the plane refuses typed with its wait, whatever the plain-plane form is.
    let key = SocketAddr::new("198.51.100.77".parse().unwrap(), 0);
    let mut refusal = None;
    for _ in 0..10 {
        if let Err(r) = super::route_limit(Some(key), Some(WalletPlane), "read_only", "whoami", false) {
            refusal = Some(r);
            break;
        }
    }
    let (s, h, b) = parts(refusal.expect("the whoami bucket refuses within 10")).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    typed(s, &h, &b, "rate_limited", Some("60"));
    // The plain plane keeps the legacy 200 body for the same route.
    let plain_key = SocketAddr::new("198.51.100.78".parse().unwrap(), 0);
    let mut legacy = None;
    for _ in 0..1000 {
        if let Err(r) = super::route_limit(Some(plain_key), None, "whoami", "whoami", false) {
            legacy = Some(r);
            break;
        }
    }
    let (s, _, b) = parts(legacy.unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&b).unwrap()["error"], json!("Rate limit exceeded"));
    // Busy, and the typed recover for what warp itself refuses on a listed path.
    let (s, h, b) = parts(plane_busy(2)).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    typed(s, &h, &b, "busy", Some("2"));
    let (s, h, b) = parts(recover_rejection(warp::reject::not_found()).await.unwrap()).await;
    typed(s, &h, &b, "not_found", None);
    // A submit over the cap, or without a length, is refused before warp.
    let ctx = plain_ctx(routes_ok());
    let mut big = Request::builder().method(Method::POST).uri("/api/v1/transaction").body(Body::empty()).unwrap();
    big.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(64 * 1024 + 1));
    let (s, h, b) = parts(call(&ctx, big, "198.51.100.9").await).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    typed(s, &h, &b, "payload_too_large", None);
    let chunked = Request::builder().method(Method::POST).uri("/api/v1/transaction").body(Body::empty()).unwrap();
    let (s, _, _) = parts(call(&ctx, chunked, "198.51.100.9").await).await;
    assert_eq!(s, StatusCode::LENGTH_REQUIRED);
    // The log proof's own refusals are typed on the plane, with their real statuses; port 8001 keeps
    // the 200 bodies old clients read.
    use super::queries_api::log_proof_refusal;
    let cases = [
        ("Invalid tx_hash", json!({"error": "Invalid tx_hash"}), StatusCode::BAD_REQUEST, "bad_parameter", None),
        ("Transaction not found", json!({"error": "Transaction not found"}), StatusCode::NOT_FOUND, "tx_not_found", None),
        ("window_not_finalized", json!({"error": "window_not_finalized", "window_end": 90}), StatusCode::NOT_FOUND, "window_not_finalized", Some("30")),
        ("window_pruned", json!({"error": "window_pruned", "window_start": 1, "window_end": 90, "oldest_available": 14_400}),
         StatusCode::GONE, "window_pruned", None),
        ("Log not found in window", json!({"error": "Log not found in window", "window_start": 1, "window_end": 90}),
         StatusCode::NOT_FOUND, "log_not_found", None),
    ];
    for (legacy_error, legacy, status, error, retry) in cases {
        let (s, h, b) = parts(log_proof_refusal(true, legacy_error, legacy.clone())).await;
        assert_eq!(s, status, "{}", error);
        typed(s, &h, &b, error, retry);
        let v: Value = serde_json::from_slice(&b).unwrap();
        for (k, want) in legacy.as_object().unwrap().iter().filter(|(k, _)| *k != "error") {
            assert_eq!(&v[k], want, "{} keeps {}", error, k);
        }
        let (s, _, b) = parts(log_proof_refusal(false, legacy_error, legacy.clone())).await;
        assert_eq!((s, serde_json::from_slice::<Value>(&b).unwrap()), (StatusCode::OK, legacy), "legacy body for {}", error);
    }
}

// ─── Egress ─────────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn egress_budget_sheds_heavy_routes() {
    // The bucket itself: burst, debt, refill at the rate; a reservation holds what it will cost.
    let t0 = Instant::now();
    let b = Arc::new(EgressBudget::new(1000.0, 2000.0));
    assert_eq!(b.tokens_at(t0), 2000.0);
    b.debit_at(5000, t0);
    assert_eq!(b.reserve_at(1, t0).err(), Some(4), "in debt: 3000 B of debt plus 1 B at 1000 B/s");
    assert!(b.reserve_at(1, t0 + Duration::from_secs(2)).is_err(), "still in debt after 2 s");
    assert!(b.reserve_at(1, t0 + Duration::from_millis(3100)).is_ok(), "refilled");
    let t1 = t0 + Duration::from_secs(100);
    assert_eq!(b.tokens_at(t1), 2000.0, "the burst caps the refill");
    let r1 = b.reserve_at(1500, t1).expect("1500 of 2000");
    assert_eq!(b.reserve_at(1000, t1).err(), Some(1), "only 500 left while the first answer is built");
    let r2 = b.reserve_at(500, t1).expect("exactly what is left");
    assert!(b.reserve_at(1, t1).is_err());
    drop(r2);
    assert!((b.tokens_at(t1) - 500.0).abs() < 1.0, "a dropped request gives its share back");
    let mut r1 = r1;
    r1.spend(100);
    drop(r1);
    assert!((b.tokens_at(t1) - 1900.0).abs() < 1.0, "charged the 100 bytes really sent");
    assert_eq!(b.reserve_at(10_000_000, t1 + Duration::from_secs(100)).err(), None, "a reservation is capped at the burst");
    assert_eq!(Arc::new(EgressBudget::new(1.0, 10.0)).reserve_at(1_000, t0).map(|_| ()).err(), None);
    // A heavy answer reserves at most a sixteenth of the burst.
    let budget = EgressBudget::new(1.0, 16_000_000.0);
    assert_eq!(budget.reservation_for(8 * 1024 * 1024), 1_000_000);
    assert_eq!(budget.reservation_for(400_000), 400_000);

    // On the plane: a spent budget sheds macroblock proofs and registry bodies, never the head reads,
    // and tells the client how long until the budget holds such an answer again.
    let hits = Arc::new(AtomicUsize::new(0));
    let ctx = ctx_with(counting_routes(Arc::clone(&hits)), Limits::production(), EgressBudget::new(1_000_000.0, 100.0), Arc::new(CertStore::new()));
    ctx.egress.debit(10_000_000);
    for path in ["/api/v1/macroblock/5/proof", "/api/v1/registry/height/90"] {
        let (s, h, _) = parts(call(&ctx, get(path), "198.51.100.10").await).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{}", path);
        assert_eq!(h.get(header::RETRY_AFTER).unwrap(), "10", "10 MB of debt at 1 MB/s");
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert_eq!(ctx.heavy_bytes_in_flight(), 0, "a refused heavy answer holds no slot");
    for path in ["/healthz", "/api/v1/state/certified"] {
        let r = call(&ctx, get(path), "198.51.100.10").await;
        assert_eq!(r.status(), StatusCode::OK, "{}", path);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    // Bodies served are counted against the budget.
    let ctx = ctx_with(routes_ok(), Limits::production(), EgressBudget::new(1.0, 5.0), Arc::new(CertStore::new()));
    let r = call(&ctx, get("/healthz"), "198.51.100.11").await;
    let _ = warp::hyper::body::to_bytes(r.into_body()).await.unwrap();
    assert!(ctx.egress.tokens_at(Instant::now()) > 0.0, "2 bytes of a 5-byte burst");
    for _ in 0..3 {
        let r = call(&ctx, get("/healthz"), "198.51.100.11").await;
        let _ = warp::hyper::body::to_bytes(r.into_body()).await.unwrap();
    }
    assert!(ctx.egress.tokens_at(Instant::now()) < 0.0, "8 bytes served from a 5-byte burst");
}

#[tokio::test]
async fn egress_is_charged_as_the_transport_takes_bytes() {
    // A heavy answer: its reservation is spent first, the rest debited as taken, and what was never
    // taken goes back when the body is dropped. A client that does not read costs nothing.
    const BODY: usize = 4 * 1024 * 1024;
    let burst = 100_000_000.0;
    let ctx = ctx_with(routes_sized(BODY), Limits::production(), EgressBudget::new(1.0, burst), Arc::new(CertStore::new()));
    let reserved = ctx.egress.reservation_for(MB_PROOF_ESTIMATE_DEFAULT) as f64;
    let tokens = || ctx.egress.tokens_at(Instant::now());
    let r = call(&ctx, get("/api/v1/macroblock/987650100/proof"), "198.51.100.40").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.body().size_hint().exact(), Some(BODY as u64), "the length is still announced");
    assert!((tokens() - (burst - reserved)).abs() < 100.0, "only the reservation is held before a byte is sent");
    let mut body = r.into_body();
    let mut taken = 0usize;
    while taken < 1024 * 1024 {
        let chunk = body.data().await.unwrap().unwrap();
        assert!(chunk.len() <= BODY_CHUNK);
        taken += chunk.len();
    }
    assert!((tokens() - (burst - reserved)).abs() < 100.0, "the first megabyte came out of the reservation");
    drop(body);
    assert!((tokens() - (burst - taken as f64)).abs() < 100.0, "dropped: charged what was taken, the rest given back");
    assert_eq!(ctx.heavy_bytes_in_flight(), 0);
    // A light answer: debited piece by piece, nothing before.
    let before = tokens();
    let r = call(&ctx, get("/healthz"), "198.51.100.40").await;
    assert!((tokens() - before).abs() < 100.0, "nothing charged for a body not yet taken");
    let n = warp::hyper::body::to_bytes(r.into_body()).await.unwrap().len();
    assert_eq!(n, BODY);
    assert!((before - tokens() - BODY as f64).abs() < 100.0, "the whole body once taken");
}

#[tokio::test]
async fn egress_reserves_before_a_burst_waits_on_one_build() {
    // Requests for one uncached index arrive while its build runs: each holds its share of the burst
    // before it waits, so only as many as the burst covers are admitted; the rest are told when to
    // come back and never reach the handler.
    const BODY: usize = 64 * 1024;
    let builds = Arc::new(AtomicUsize::new(0));
    let b2 = Arc::clone(&builds);
    let routes: PlaneRoutes = warp::any()
        .and_then(move || {
            let b = Arc::clone(&b2);
            async move {
                b.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok::<_, Rejection>(warp::reply::Response::new(Body::from(vec![0u8; BODY])))
            }
        })
        .boxed();
    let mut limits = Limits::production();
    limits.heavy_inflight_bytes = u64::MAX / 2;
    // A 16 MB burst: an 8 MiB estimate reserves 1 MB, so 16 fit.
    let ctx = ctx_with(routes, limits, EgressBudget::new(1.0, 16_000_000.0), Arc::new(CertStore::new()));
    let mut joins = Vec::new();
    for i in 0..20 {
        let ctx = Arc::clone(&ctx);
        joins.push(tokio::spawn(async move {
            let ip = format!("198.51.100.{}", 20 + i);
            let r = call(&ctx, get("/api/v1/macroblock/987654321/proof"), &ip).await;
            let status = r.status();
            let retry = r.headers().get(header::RETRY_AFTER).map(|v| v.to_str().unwrap().to_string());
            // Hold the answer until every request was admitted or refused.
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(r);
            (status, retry)
        }));
    }
    let mut served = 0;
    for j in joins {
        match j.await.unwrap() {
            (StatusCode::OK, _) => served += 1,
            (StatusCode::SERVICE_UNAVAILABLE, Some(retry)) => assert!(retry.parse::<u64>().unwrap() >= 1),
            other => panic!("{:?}", other),
        }
    }
    assert_eq!(served, 16, "a sixteenth of the burst each");
    assert_eq!(builds.load(Ordering::SeqCst), 16);
    // The answers were never read: each gave its reservation back, so the budget is whole again.
    assert!((ctx.egress.tokens_at(Instant::now()) - 16_000_000.0).abs() < 100.0);
    // The next estimate is the size really sent.
    assert_eq!(ctx.heavy.estimate(WalletRoute::MacroblockProof, "/api/v1/macroblock/1/proof"), BODY as u64);
    // Before any answer the estimate is the clients' cap; a registry answer has its own.
    let fresh = plain_ctx(routes_ok());
    assert_eq!(fresh.heavy.estimate(WalletRoute::MacroblockProof, "/api/v1/macroblock/1/proof"), 8 * 1024 * 1024);
    assert_eq!(fresh.heavy.estimate(WalletRoute::Registry, "/api/v1/registry/height/1"), 16 * 1024 * 1024);
    assert_eq!(fresh.heavy.estimate(WalletRoute::Healthz, "/healthz"), 0);
    assert_eq!(fresh.heavy.estimate(WalletRoute::GalcCapsule, "/api/v1/galc/capsule"), 0);
    assert!(!WalletRoute::GalcCapsule.heavy(), "the capsule is a light route");
}

#[tokio::test]
async fn heavy_answers_are_capped_per_key_and_node_wide() {
    // Two heavy answers in flight per key: a third waits until one has been handed over or dropped.
    const BODY: usize = 1024 * 1024;
    let mut limits = Limits::production();
    limits.heavy_inflight_bytes = 20 * 1024 * 1024;
    let ctx = ctx_with(routes_sized(BODY), limits, EgressBudget::new(1.0, 1e12), Arc::new(CertStore::new()));
    let mb = |i: u64| get(&format!("/api/v1/macroblock/{}/proof", 987_660_000 + i));
    let a1 = call(&ctx, mb(1), "198.51.100.50").await;
    let a2 = call(&ctx, mb(2), "198.51.100.50").await;
    assert_eq!((a1.status(), a2.status()), (StatusCode::OK, StatusCode::OK));
    assert_eq!(ctx.heavy_bytes_in_flight(), 2 * BODY as u64, "counted at the bodies' real size once built");
    let a3 = call(&ctx, mb(3), "198.51.100.50").await;
    assert_eq!(a3.status(), StatusCode::SERVICE_UNAVAILABLE, "the key's third heavy answer");
    assert_eq!(call(&ctx, mb(3), "198.51.100.51").await.status(), StatusCode::OK, "another key is not affected");
    drop(a1);
    assert_eq!(call(&ctx, mb(4), "198.51.100.50").await.status(), StatusCode::OK, "a slot came back");
    // Fully handed over frees the slot too.
    let _ = warp::hyper::body::to_bytes(a2.into_body()).await.unwrap();
    assert_eq!(ctx.heavy_bytes_in_flight(), 0);
    // Node-wide by bytes: with answers of 1 MiB known, 2.5 MiB holds two.
    let mut limits = Limits::production();
    limits.heavy_inflight_bytes = 5 * BODY as u64 / 2;
    let ctx = ctx_with(routes_sized(BODY), limits, EgressBudget::new(1.0, 1e12), Arc::new(CertStore::new()));
    ctx.heavy.note(WalletRoute::MacroblockProof, BODY as u64);
    let b = call(&ctx, mb(10), "198.51.100.60").await;
    let c = call(&ctx, mb(11), "198.51.100.61").await;
    assert_eq!((b.status(), c.status()), (StatusCode::OK, StatusCode::OK));
    assert_eq!(call(&ctx, mb(12), "198.51.100.62").await.status(), StatusCode::SERVICE_UNAVAILABLE, "over the node-wide bytes");
    drop(b);
    let d = call(&ctx, mb(12), "198.51.100.62").await;
    assert_eq!(d.status(), StatusCode::OK);
    drop((c, d));
    assert_eq!(ctx.heavy_bytes_in_flight(), 0);
    // Light answers take no heavy slot.
    let mut limits = Limits::production();
    limits.heavy_per_key = 0;
    let ctx = ctx_with(routes_ok(), limits, EgressBudget::new(1.0, 1e12), Arc::new(CertStore::new()));
    assert_eq!(call(&ctx, get("/api/v1/state/certified"), "198.51.100.63").await.status(), StatusCode::OK);
}

// ─── Certificates and the resolver ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn alpn_challenge_cert_only_for_pending_reverse_name() {
    let certs = Arc::new(CertStore::new());
    let (addr, _ctx) = start_plane(routes_ok(), Limits::production(), Arc::clone(&certs)).await;
    let rev = reverse_name(Ipv4Addr::LOCALHOST);
    assert_eq!(rev, "1.0.0.127.in-addr.arpa");
    let acme: &[&[u8]] = &[ALPN_ACME_TLS];
    // Nothing armed and nothing installed: no certificate for anyone.
    assert!(tls_connect(addr, Some(&rev), acme).await.is_err());
    assert!(tls_connect(addr, None, &[b"http/1.1"]).await.is_err());
    // Armed: the validation handshake gets the challenge certificate, negotiates acme-tls/1, and the
    // server closes after it; the CA's several vantage points each get it.
    let digest = [7u8; 32];
    certs.arm_challenge(Ipv4Addr::LOCALHOST, &digest, Duration::from_secs(60)).unwrap();
    for _ in 0..3 {
        let mut tls = tls_connect(addr, Some(&rev), acme).await.expect("validation handshake");
        assert_eq!(tls.get_ref().1.alpn_protocol(), Some(ALPN_ACME_TLS));
        let der = leaf_of(&tls);
        let (_, cert) = x509_parser::parse_x509_certificate(&der).unwrap();
        let sans = cert.subject_alternative_name().unwrap().unwrap().value.general_names.clone();
        assert_eq!(sans.len(), 1);
        assert!(matches!(&sans[0], x509_parser::extensions::GeneralName::IPAddress(b) if *b == [127, 0, 0, 1].as_slice()));
        let ext = cert.extensions().iter().find(|e| e.oid.to_id_string() == "1.3.6.1.5.5.7.1.31").expect("acmeIdentifier");
        assert!(ext.critical);
        assert_eq!(ext.value, [&[0x04, 0x20][..], &digest[..]].concat().as_slice(), "an OCTET STRING of the digest");
        assert_eq!(cert.subject(), cert.issuer(), "self-signed");
        let mut b = [0u8; 1];
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2), tls.read(&mut b)).await, Ok(Ok(0)) | Ok(Err(_))), "closed after the handshake");
    }
    // Only for the reverse name, only to an acme-tls/1-only hello.
    assert!(tls_connect(addr, Some("2.0.0.127.in-addr.arpa"), acme).await.is_err());
    assert!(tls_connect(addr, Some(&rev), &[b"h2", ALPN_ACME_TLS]).await.is_err(), "no serving cert installed yet");
    let serving = install_loopback_cert(&certs, "serving");
    let tls = tls_connect(addr, Some(&rev), &[b"h2", ALPN_ACME_TLS]).await.unwrap();
    assert_eq!(leaf_of(&tls), serving, "a mixed hello never sees the challenge certificate");
    assert_ne!(tls.get_ref().1.alpn_protocol(), Some(ALPN_ACME_TLS));
    // Disarmed, or past its lifetime: refused again.
    certs.disarm_challenge();
    assert!(tls_connect(addr, Some(&rev), acme).await.is_err());
    certs.arm_challenge(Ipv4Addr::LOCALHOST, &digest, Duration::from_millis(1)).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(tls_connect(addr, Some(&rev), acme).await.is_err());
    // The probe name gets the probe certificate, and only while it is armed (never the serving one).
    let marker = "0123456789abcdef0123456789abcdef";
    let probe_sni = format!("{}{}", marker, PROBE_SUFFIX);
    assert!(tls_connect(addr, Some(&probe_sni), &[b"http/1.1"]).await.is_err(), "a probe name with nothing armed gets nothing");
    certs.arm_probe(marker, Duration::from_secs(30)).unwrap();
    let probe = tls_connect(addr, Some(&probe_sni), &[b"http/1.1"]).await.unwrap();
    let probe_der = leaf_of(&probe);
    let (_, pc) = x509_parser::parse_x509_certificate(&probe_der).unwrap();
    assert!(pc.subject_alternative_name().unwrap().unwrap().value.general_names.iter()
        .any(|g| matches!(g, x509_parser::extensions::GeneralName::DNSName(d) if *d == probe_sni)));
    // The probe connection is closed after its handshake too.
    let mut probe = probe;
    let mut b = [0u8; 1];
    assert!(matches!(tokio::time::timeout(Duration::from_secs(2), probe.read(&mut b)).await, Ok(Ok(0)) | Ok(Err(_))));
    certs.disarm_probe(marker);
    assert!(tls_connect(addr, Some(&probe_sni), &[b"http/1.1"]).await.is_err());
    assert!(certs.arm_probe("not-hex", Duration::from_secs(1)).is_err());
}

#[tokio::test]
async fn cert_swap_keeps_live_connections() {
    let certs = Arc::new(CertStore::new());
    let a = install_loopback_cert(&certs, "first");
    let (addr, _ctx) = start_plane(routes_ok(), Limits::production(), Arc::clone(&certs)).await;
    let mut live = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    assert_eq!(leaf_of(&live), a);
    assert_eq!(http1(&mut live, "/healthz").await.unwrap(), (200, "ok".to_string()));
    let b = install_loopback_cert(&certs, "second");
    assert_ne!(a, b);
    for _ in 0..3 {
        assert_eq!(http1(&mut live, "/healthz").await.unwrap(), (200, "ok".to_string()), "the open connection keeps working");
    }
    let fresh = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    assert_eq!(leaf_of(&fresh), b, "a new connection gets the new certificate");
}

#[tokio::test]
async fn a_certificate_outside_its_validity_is_never_served() {
    let certs = Arc::new(CertStore::new());
    let (addr, _ctx) = start_plane(routes_ok(), Limits::production(), Arc::clone(&certs)).await;
    let now = unix_now();
    // Expired: the server offers no certificate, so the handshake fails on its side.
    install_loopback_cert_valid(&certs, "expired", now - 7200, now - 1);
    assert!(tls_connect(addr, None, &[b"http/1.1"]).await.is_err(), "an expired certificate is not offered");
    assert_eq!(certs.valid_ip(now), None);
    // Not valid yet: refused the same way.
    install_loopback_cert_valid(&certs, "future", now + 3600, now + 7200);
    assert!(tls_connect(addr, None, &[b"http/1.1"]).await.is_err(), "a not-yet-valid certificate is not offered");
    // The challenge path does not depend on a serving certificate.
    let rev = reverse_name(Ipv4Addr::LOCALHOST);
    certs.arm_challenge(Ipv4Addr::LOCALHOST, &[3u8; 32], Duration::from_secs(60)).unwrap();
    assert!(tls_connect(addr, Some(&rev), &[ALPN_ACME_TLS]).await.is_ok(), "validation still answers");
    certs.disarm_challenge();
    // A valid one is served again at once.
    let valid = install_loopback_cert(&certs, "valid");
    let mut tls = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    assert_eq!(leaf_of(&tls), valid);
    assert_eq!(http1(&mut tls, "/healthz").await.unwrap(), (200, "ok".to_string()));
}

#[tokio::test]
async fn tls_offers_only_modern_suites() {
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "suites");
    let (addr, _ctx) = start_plane(routes_ok(), Limits::production(), Arc::clone(&certs)).await;
    // TLS 1.3 by default; TLS 1.2 still negotiates (older phones), with an ECDHE-ECDSA AEAD suite.
    let tls = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    let suite = tls.get_ref().1.negotiated_cipher_suite().unwrap();
    assert_eq!(tls.get_ref().1.protocol_version(), Some(rustls::ProtocolVersion::TLSv1_3));
    assert!(format!("{:?}", suite.suite()).starts_with("TLS13_"));
    let tls12_only = report_only_client_config(&[b"http/1.1"], &[&rustls::version::TLS12]).unwrap();
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let t12 = tokio_rustls::TlsConnector::from(Arc::new(tls12_only))
        .connect(rustls::pki_types::ServerName::IpAddress(addr.ip().into()), tcp).await.unwrap();
    assert_eq!(t12.get_ref().1.protocol_version(), Some(rustls::ProtocolVersion::TLSv1_2));
    assert!(format!("{:?}", t12.get_ref().1.negotiated_cipher_suite().unwrap().suite()).starts_with("TLS_ECDHE_ECDSA_WITH_"));
    // The group list leads with the hybrid post-quantum group.
    let sc = server_config(certs).unwrap();
    assert_eq!(sc.alpn_protocols, vec![b"h2".to_vec(), b"http/1.1".to_vec(), ALPN_ACME_TLS.to_vec()]);
    assert_eq!(sc.max_early_data_size, 0);
}

// ─── Caps ───────────────────────────────────────────────────────────────────────────────────────

fn tight_limits() -> Limits {
    Limits {
        conns_total: 4,
        conns_per_key: 2,
        handshakes: 8,
        handshakes_per_key: 2,
        hello_timeout: Duration::from_millis(300),
        handshake_timeout: Duration::from_millis(400),
        header_timeout: Duration::from_millis(400),
        idle_timeout: Duration::from_millis(700),
        request_deadline: Duration::from_secs(5),
        post_deadline: Duration::from_secs(5),
        stall_timeout: Duration::from_secs(5),
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

#[tokio::test]
async fn connection_and_handshake_caps_hold() {
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "caps");
    let (addr, ctx) = start_plane(routes_ok(), tight_limits(), Arc::clone(&certs)).await;
    // Loopback peers are one masked key: two connections per key, the third closed at accept.
    let mut c1 = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut c2 = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(ctx.open_connections(), 2);
    let mut c3 = tokio::net::TcpStream::connect(addr).await.unwrap();
    assert!(closed_within(&mut c3, Duration::from_millis(250)).await, "over the per-key cap: closed at accept");
    // A connection that never says hello is dropped at the hello timeout, freeing its slot.
    let started = Instant::now();
    let c1_closed = closed_within(&mut c1, Duration::from_secs(5)).await;
    assert!(c1_closed, "hello timeout: open={} after {:?}", ctx.open_connections(), started.elapsed());
    assert!(closed_within(&mut c2, Duration::from_secs(5)).await);
    assert!(all_closed(&ctx, Duration::from_secs(1)).await, "slots freed");
    // Headers must arrive in time.
    let mut slow = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    slow.write_all(b"GET /healthz HTTP/1.1\r\nHost: pl").await.unwrap();
    let mut b = [0u8; 256];
    let r = tokio::time::timeout(Duration::from_millis(2000), slow.read(&mut b)).await;
    assert!(matches!(r, Ok(Ok(0)) | Ok(Err(_))) || matches!(r, Ok(Ok(n)) if String::from_utf8_lossy(&b[..n]).contains("408")),
            "a header read past the timeout is closed: {:?}", r.map(|x| x.map(|n| String::from_utf8_lossy(&b[..n]).to_string())));
    // A keep-alive connection must start its next request within the header timeout too.
    let mut keep = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    assert_eq!(http1(&mut keep, "/healthz").await.unwrap().0, 200);
    let started = Instant::now();
    let mut b = [0u8; 1];
    let r = tokio::time::timeout(Duration::from_secs(3), keep.read(&mut b)).await;
    assert!(matches!(r, Ok(Ok(0)) | Ok(Err(_))), "quiet keep-alive connection closed");
    assert!(started.elapsed() >= Duration::from_millis(300), "not before the header timeout: {:?}", started.elapsed());
    drop((slow, keep));
    // A connection with no request in flight is closed after the idle timeout (here shorter than the
    // header one).
    let mut idle_limits = tight_limits();
    idle_limits.header_timeout = Duration::from_secs(5);
    idle_limits.idle_timeout = Duration::from_millis(500);
    let (addr_idle, _ctx_idle) = start_plane(routes_ok(), idle_limits, Arc::clone(&certs)).await;
    let mut idle = tls_connect(addr_idle, None, &[b"http/1.1"]).await.unwrap();
    assert_eq!(http1(&mut idle, "/healthz").await.unwrap().0, 200);
    let started = Instant::now();
    let r = tokio::time::timeout(Duration::from_secs(4), idle.read(&mut b)).await;
    assert!(matches!(r, Ok(Ok(0)) | Ok(Err(_))), "idle connection closed: {:?}", r.map(|x| x.map(|n| n)));
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(400) && waited < Duration::from_secs(4), "closed by the idle watchdog: {:?}", waited);
    drop(idle);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The node-wide cap: per-key 2 here, so a fresh context with a node cap of 1 shows it.
    let mut one = tight_limits();
    one.conns_total = 1;
    one.conns_per_key = 32;
    let (addr1, ctx1) = start_plane(routes_ok(), one, Arc::clone(&certs)).await;
    let _held = tokio::net::TcpStream::connect(addr1).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(ctx1.open_connections(), 1);
    let mut over = tokio::net::TcpStream::connect(addr1).await.unwrap();
    assert!(closed_within(&mut over, Duration::from_millis(250)).await, "over the node-wide cap");
}

#[tokio::test]
async fn handshakes_are_capped_per_key() {
    // Eight connections allowed per key, but two handshakes in flight: a few addresses cannot hold
    // every node-wide handshake slot with connections that never say hello.
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "handshakes");
    let mut limits = tight_limits();
    limits.conns_total = 16;
    limits.conns_per_key = 8;
    limits.handshakes = 8;
    limits.hello_timeout = Duration::from_millis(600);
    limits.handshake_timeout = Duration::from_secs(3);
    let (addr, ctx) = start_plane(routes_ok(), limits, Arc::clone(&certs)).await;
    let mut c1 = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut c2 = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut c3 = tokio::net::TcpStream::connect(addr).await.unwrap();
    assert!(closed_within(&mut c3, Duration::from_millis(250)).await, "the key's third handshake is refused at accept");
    // The silent two are dropped at the hello timeout, well before the handshake timeout.
    let started = Instant::now();
    assert!(closed_within(&mut c1, Duration::from_secs(2)).await && closed_within(&mut c2, Duration::from_secs(2)).await);
    assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
    assert!(all_closed(&ctx, Duration::from_secs(1)).await);
    // Completed handshakes free their slots: more connections than handshake slots, all serving.
    let mut live = Vec::new();
    for _ in 0..4 {
        let mut tls = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
        assert_eq!(http1(&mut tls, "/healthz").await.unwrap().0, 200);
        live.push(tls);
    }
    assert!(ctx.handshakes_per_key.is_empty(), "no handshake slot held after the handshakes");
}

#[tokio::test]
async fn http2_pings_do_not_keep_a_connection_open() {
    // A client that pings every 100 ms but sends no request is closed at the idle time: control frames
    // are not progress.
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "pings");
    let mut limits = tight_limits();
    limits.idle_timeout = Duration::from_millis(600);
    let (addr, ctx) = start_plane(routes_ok(), limits, Arc::clone(&certs)).await;
    let tls = tls_connect(addr, None, &[b"h2"]).await.unwrap();
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"h2"[..]));
    let (mut send, conn) = warp::hyper::client::conn::Builder::new()
        .http2_only(true)
        .http2_keep_alive_interval(Duration::from_millis(100))
        .http2_keep_alive_while_idle(true)
        .handshake::<_, Body>(tls)
        .await
        .unwrap();
    let driver = tokio::spawn(conn);
    let r = send.send_request(Request::get("https://127.0.0.1/healthz").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(warp::hyper::body::to_bytes(r.into_body()).await.unwrap().as_ref(), b"ok");
    let started = Instant::now();
    assert!(tokio::time::timeout(Duration::from_secs(5), driver).await.is_ok(), "closed although the client kept pinging");
    assert!(started.elapsed() >= Duration::from_millis(450), "not before the idle time: {:?}", started.elapsed());
    assert!(all_closed(&ctx, Duration::from_secs(1)).await);
}

#[tokio::test]
async fn a_stalled_download_is_dropped_and_charged_only_what_was_taken() {
    // A client that asks for a large body and never reads: once the transport stops taking pieces the
    // answer is stalled and the connection goes; the budget is charged only what was handed over.
    const BODY: usize = 48 * 1024 * 1024;
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "stall");
    let mut limits = tight_limits();
    limits.stall_timeout = Duration::from_millis(600);
    limits.idle_timeout = Duration::from_secs(10);
    let burst = 1e9;
    let (addr, ctx) = start_plane_with(routes_sized(BODY), limits, EgressBudget::new(1.0, burst), Arc::clone(&certs)).await;
    let mut tls = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    tls.write_all(b"GET /healthz HTTP/1.1\r\nHost: plane\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(ctx.open_connections(), 1);
    assert!(all_closed(&ctx, Duration::from_secs(8)).await, "the stalled download was dropped");
    let charged = burst - ctx.egress.tokens_at(Instant::now());
    assert!(charged < (BODY / 2) as f64, "charged {} of {} bytes", charged, BODY);
    drop(tls);
}

#[tokio::test]
async fn a_trickled_post_body_is_dropped_at_its_deadline() {
    // A submit that declares 64 KiB and sends a byte now and then is closed at the POST deadline,
    // however busy it keeps the socket.
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "trickle");
    let mut limits = tight_limits();
    limits.post_deadline = Duration::from_millis(800);
    limits.header_timeout = Duration::from_secs(5);
    limits.idle_timeout = Duration::from_secs(10);
    let routes: PlaneRoutes = warp::any()
        .and(warp::body::bytes())
        .map(|b: bytes::Bytes| warp::Reply::into_response(b.len().to_string()))
        .boxed();
    let (addr, ctx) = start_plane(routes, limits, Arc::clone(&certs)).await;
    let tls = tls_connect(addr, None, &[b"http/1.1"]).await.unwrap();
    let (mut rd, mut wr) = tokio::io::split(tls);
    wr.write_all(b"POST /api/v1/transaction HTTP/1.1\r\nHost: plane\r\nContent-Length: 65536\r\n\r\n").await.unwrap();
    let writer = tokio::spawn(async move {
        for _ in 0..40 {
            if wr.write_all(b"x").await.is_err() || wr.flush().await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let started = Instant::now();
    let mut b = [0u8; 64];
    let r = tokio::time::timeout(Duration::from_secs(4), rd.read(&mut b)).await;
    assert!(matches!(r, Ok(Ok(0)) | Ok(Err(_))), "closed: {:?}", r.map(|x| x.map(|n| String::from_utf8_lossy(&b[..n]).to_string())));
    assert!(started.elapsed() >= Duration::from_millis(600), "not before the deadline: {:?}", started.elapsed());
    assert!(all_closed(&ctx, Duration::from_secs(1)).await);
    writer.abort();
}

#[test]
fn the_watchdog_counts_only_request_progress() {
    let mut l = tight_limits();
    l.header_timeout = Duration::from_millis(1_000);
    l.idle_timeout = Duration::from_millis(2_000);
    l.stall_timeout = Duration::from_millis(1_000);
    l.send_grace = Duration::from_millis(10_000);
    l.min_send_rate = 1_000;
    l.conn_max_age = Duration::from_millis(100_000);
    l.retire_grace = Duration::from_millis(10_000);
    // No request yet: the first must come within the header timeout.
    let w = ConnWatch::new(0);
    assert_eq!(w.verdict(500, &l), Verdict::Keep(1_000));
    assert_eq!(w.verdict(1_000, &l), Verdict::Drop("idle"));
    // A request in flight: no idle rule (and nothing the client sends moves anything), only its deadline.
    let w = ConnWatch::new(0);
    let t = w.begin(100, Duration::from_millis(5_000));
    assert_eq!(w.verdict(4_000, &l), Verdict::Keep(5_100));
    assert_eq!(w.verdict(5_100, &l), Verdict::Drop("deadline"));
    // Answered at 1 000 with 5 000 bytes: a piece at least every second, all of it by 1 000 + 10 000 + 5 000.
    t.responded(1_000, l.send_deadline(1_000, 5_000));
    assert_eq!(w.verdict(1_500, &l), Verdict::Keep(2_000));
    assert_eq!(w.verdict(2_000, &l), Verdict::Drop("stalled"));
    let mut now = 1_000;
    while now + 900 < 16_000 {
        now += 900;
        t.progress(now);
        assert_eq!(w.verdict(now + 100, &l), Verdict::Keep((now + 1_000).min(16_000)), "at {}", now);
    }
    assert_eq!(w.verdict(16_000, &l), Verdict::Drop("deadline"), "a slow trickle still ends at the send deadline");
    drop(t);
    // One stalled answer drops the connection, however busy its other streams keep it.
    let w = ConnWatch::new(0);
    let (a, b) = (w.begin(0, Duration::from_secs(30)), w.begin(0, Duration::from_secs(30)));
    a.responded(0, 1_000_000);
    b.responded(0, 1_000_000);
    a.progress(900);
    assert_eq!(w.verdict(1_000, &l), Verdict::Drop("stalled"));
    drop((a, b));
    // Requests over: the idle clock starts when the last one ended.
    let opened = mono_ms();
    let w = ConnWatch::new(opened);
    drop(w.begin(opened, Duration::from_secs(30)));
    let quiet = w.state.lock().quiet_since;
    assert!(quiet >= opened);
    assert_eq!(w.verdict(quiet + 1_999, &l), Verdict::Keep(quiet + 2_000));
    assert_eq!(w.verdict(quiet + 2_000, &l), Verdict::Drop("idle"));
    // Age: retired at 100 s (finish what is in flight), dropped 10 s later.
    let w = ConnWatch::new(0);
    let _long = w.begin(0, Duration::from_secs(1_000));
    assert_eq!(w.verdict(99_999, &l), Verdict::Keep(100_000));
    assert_eq!(w.verdict(100_000, &l), Verdict::Retire(110_000));
    assert_eq!(w.verdict(110_000, &l), Verdict::Drop("max_age"));
    // The send deadline grows with the body.
    assert_eq!(Limits::production().send_deadline(0, 8 * 1024 * 1024), 30_000 + 128_000);
}

#[test]
fn production_limits_are_the_specified_constants() {
    let l = Limits::production();
    assert_eq!((l.conns_total, l.conns_per_key, l.handshakes, l.handshakes_per_key), (8192, 32, 256, 4));
    assert_eq!((l.hello_timeout, l.handshake_timeout, l.header_timeout, l.idle_timeout),
               (Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(60)));
    assert_eq!((l.request_deadline, l.post_deadline, l.stall_timeout), (Duration::from_secs(30), Duration::from_secs(10), Duration::from_secs(20)));
    assert_eq!((l.min_send_rate, l.send_grace), (64 * 1024, Duration::from_secs(30)));
    assert_eq!((l.conn_max_age, l.retire_grace), (Duration::from_secs(600), Duration::from_secs(60)));
    assert_eq!((l.max_header_bytes, l.h2_streams, l.post_body_max), (16 * 1024, 32, 64 * 1024));
    assert_eq!((l.heavy_per_key, l.heavy_inflight_bytes), (2, 128 * 1024 * 1024));
    assert_eq!((EGRESS_BYTES_PER_SEC, EGRESS_BURST_BYTES), (12_500_000.0, 25_000_000.0));
    assert_eq!(WALLET_PLANE_PORT, 8443);
    let t = plane_threads();
    assert!((2..=4).contains(&t));
}

// ─── Runtime isolation and opt-out ──────────────────────────────────────────────────────────────

#[test]
fn wallet_runtime_is_isolated() {
    // The plane on its own runtime (as `start` builds it), every worker stalled by a blocking handler.
    let routes: PlaneRoutes = warp::any().map(|| {
        std::thread::sleep(Duration::from_secs(3));
        warp::Reply::into_response("slow")
    }).boxed();
    let threads = plane_threads();
    let plane_rt = tokio::runtime::Builder::new_multi_thread().worker_threads(threads).enable_all().build().unwrap();
    let certs = Arc::new(CertStore::new());
    install_loopback_cert(&certs, "isolated");
    let addr = plane_rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut limits = Limits::production();
        limits.conns_per_key = 64;
        limits.handshakes_per_key = 64;
        let ctx = ctx_with(routes, limits, EgressBudget::new(EGRESS_BYTES_PER_SEC, EGRESS_BURST_BYTES), certs);
        tokio::spawn(serve(listener, ctx));
        addr
    });
    // The main runtime: its own /healthz-like route must answer at once while the plane is stalled.
    let main_rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    main_rt.block_on(async move {
        for _ in 0..(threads * 2) {
            tokio::spawn(async move {
                if let Ok(mut tls) = tls_connect(addr, None, &[b"http/1.1"]).await {
                    let _ = http1(&mut tls, "/healthz").await;
                }
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let healthz = warp::path("healthz").map(|| "ok");
        let started = Instant::now();
        let r = warp::test::request().path("/healthz").reply(&healthz).await;
        assert_eq!(r.status(), 200);
        assert!(started.elapsed() < Duration::from_millis(200), "main runtime answered in {:?}", started.elapsed());
        // And a timer on the main runtime is not starved either.
        let t = Instant::now();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(t.elapsed() < Duration::from_millis(250));
    });
    plane_rt.shutdown_background();
}

#[test]
fn plane_opens_only_on_a_serving_super_node() {
    use crate::node::NodeType;
    assert_eq!(plane_off_reason(NodeType::Light, "light_mobile_0011223344556677"), Some("light"));
    assert_eq!(plane_off_reason(NodeType::Super, "genesis_node_001"), Some("genesis_identity"));
    // QNET_HIDE_IP is read at the call; this test only checks the branch order without it set.
    if std::env::var("QNET_HIDE_IP").is_err() {
        assert_eq!(plane_off_reason(NodeType::Super, "super_node_0011223344556677"), None);
    }
    let src = include_str!("wallet_plane.rs").replace("\r\n", "\n");
    let f = &src[src.find("pub(crate) fn plane_off_reason").unwrap()..];
    let f = &f[..f.find("\n}\n").unwrap()];
    assert!(f.contains("std::env::var(\"QNET_HIDE_IP\").is_ok()"), "the opt-out closes the plane");
}

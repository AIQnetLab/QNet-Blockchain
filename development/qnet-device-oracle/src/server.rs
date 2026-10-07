//! The internal API over mutual TLS 1.3 (hybrid post-quantum key exchange preferred). A client is known
//! by the SHA-256 of its certificate, and its role decides which routes it may call. Bodies are never
//! logged; the access line carries the route, the client name, the status and the time taken.

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc::{sync_channel, Receiver, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::api::*;
use crate::config::{ClientRole, Role};
use crate::messages::sha256;
use crate::service::Oracle;

const MAX_HEAD: usize = 16 * 1024;
const REQUESTS_PER_CONNECTION: usize = 100;
const IO_TIMEOUT: Duration = Duration::from_secs(15);

pub fn tls_config(cert: &Path, key: &Path, client_ca: &Path) -> Result<Arc<ServerConfig>, String> {
    let mut provider = rustls::crypto::aws_lc_rs::default_provider();
    provider.kx_groups = vec![
        rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768,
        rustls::crypto::aws_lc_rs::kx_group::X25519,
        rustls::crypto::aws_lc_rs::kx_group::SECP256R1,
    ];
    let provider = Arc::new(provider);
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("read {}: {}", cert.display(), e))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("parse {}: {}", cert.display(), e))?;
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| format!("read {}: {}", key.display(), e))?;
    let mut roots = RootCertStore::empty();
    for c in CertificateDer::pem_file_iter(client_ca).map_err(|e| format!("read {}: {}", client_ca.display(), e))? {
        roots.add(c.map_err(|e| e.to_string())?).map_err(|e| format!("client CA: {}", e))?;
    }
    let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|e| format!("client verifier: {}", e))?;
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|e| format!("server certificate: {}", e))?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

pub struct Server {
    oracle: Arc<Oracle>,
    tls: Arc<ServerConfig>,
    clients: HashMap<String, (String, ClientRole)>,
    role: Role,
    max_body: usize,
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
    close: bool,
}

type Reply = (u16, Value);

fn reply(r: Result<Value, ApiError>) -> Reply {
    match r {
        Ok(v) => (200, v),
        Err(e) => {
            if let ApiError::Internal(m) = &e {
                if crate::log::is_err() {
                    println!("[ERROR][HTTP] internal err={}", m);
                }
            }
            (e.status(), e.body())
        }
    }
}

fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    // The category only: a parse error's text can quote the body, and bodies carry tokens.
    serde_json::from_slice(body).map_err(|e| ApiError::BadRequest(format!("body: {:?}", e.classify())))
}

fn status_text(s: u16) -> &'static str {
    match s {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

impl Server {
    pub fn new(
        oracle: Arc<Oracle>,
        tls: Arc<ServerConfig>,
        clients: &[crate::config::Client],
        role: Role,
        max_body: usize,
    ) -> Self {
        let clients = clients.iter().map(|c| (c.sha256.clone(), (c.name.clone(), c.role))).collect();
        Server { oracle, tls, clients, role, max_body }
    }

    /// Accepts connections forever; `workers` threads serve them, `queue` more may wait.
    pub fn run(self: Arc<Self>, listener: TcpListener, workers: usize, queue: usize) {
        let (tx, rx) = sync_channel::<TcpStream>(queue.max(1));
        let rx: Arc<Mutex<Receiver<TcpStream>>> = Arc::new(Mutex::new(rx));
        for _ in 0..workers.max(1) {
            let rx = rx.clone();
            let me = self.clone();
            std::thread::spawn(move || loop {
                let next = rx.lock().map(|r| r.recv());
                match next {
                    Ok(Ok(tcp)) => me.serve(tcp),
                    _ => return,
                }
            });
        }
        let mut last_full_log = Instant::now() - Duration::from_secs(60);
        for s in listener.incoming() {
            let Ok(tcp) = s else { continue };
            if let Err(TrySendError::Full(_)) = tx.try_send(tcp) {
                if last_full_log.elapsed() > Duration::from_secs(30) && crate::log::is_warn() {
                    println!("[WARN][HTTP] queue_full connection_dropped");
                    last_full_log = Instant::now();
                }
            }
        }
    }

    fn serve(&self, tcp: TcpStream) {
        let _ = tcp.set_read_timeout(Some(IO_TIMEOUT));
        let _ = tcp.set_write_timeout(Some(IO_TIMEOUT));
        let _ = tcp.set_nodelay(true);
        let Ok(conn) = ServerConnection::new(self.tls.clone()) else { return };
        let mut s = StreamOwned::new(conn, tcp);
        while s.conn.is_handshaking() {
            if s.conn.complete_io(&mut s.sock).is_err() {
                return;
            }
        }
        let client = s
            .conn
            .peer_certificates()
            .and_then(|c| c.first())
            .map(|c| hex::encode(sha256(c.as_ref())))
            .and_then(|fp| self.clients.get(&fp).cloned());
        let Some((name, role)) = client else {
            if crate::log::is_warn() {
                println!("[WARN][HTTP] unknown_client_certificate");
            }
            let _ = write_reply(&mut s, (403, json!({"error": "forbidden"})), true);
            return;
        };
        let mut buf = Vec::new();
        for _ in 0..REQUESTS_PER_CONNECTION {
            let req = match read_request(&mut s, &mut buf, self.max_body) {
                Ok(Some(r)) => r,
                Ok(None) => return,
                Err(status) => {
                    let _ = write_reply(&mut s, (status, json!({"error": status_text(status)})), true);
                    return;
                }
            };
            let start = Instant::now();
            let close = req.close;
            let path = req.path.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.route(role, req)));
            let (status, body) = result.unwrap_or_else(|_| (500, json!({"error": "internal"})));
            let ms = start.elapsed().as_millis();
            if (status >= 400 && crate::log::is_info()) || crate::log::is_debug() {
                println!("[INFO][HTTP] route={} client={} status={} ms={}", path, name, status, ms);
            }
            if write_reply(&mut s, (status, body), close).is_err() || close {
                return;
            }
        }
    }

    fn route(&self, role: ClientRole, req: Request) -> Reply {
        let o = &self.oracle;
        let standby = self.role == Role::Standby;
        let role_name = match self.role {
            Role::Primary => "primary",
            Role::Standby => "standby",
        };
        if req.method == "GET" && req.path == "/v1/health" {
            return (200, o.health(role_name));
        }
        if standby && role != ClientRole::Replica {
            return (503, json!({"error": "standby"}));
        }
        let q = |k: &str| req.query.get(k).map(String::as_str);
        let num = |k: &str, d: u64| q(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(d);
        match (role, req.method.as_str(), req.path.as_str()) {
            (ClientRole::Genesis, "POST", "/v1/claim") => reply(parse(&req.body).and_then(|r| o.claim(r))),
            (ClientRole::Genesis, "POST", "/v1/refresh") => reply(parse(&req.body).and_then(|r| o.refresh(r))),
            (ClientRole::Genesis, "POST", "/v1/release") => reply(parse(&req.body).and_then(|r| o.release(r))),
            (ClientRole::Genesis, "POST", "/v1/rotate") => reply(parse(&req.body).and_then(|r| o.rotate(r))),
            (ClientRole::Genesis, "POST", "/v1/recheck") => reply(parse(&req.body).and_then(|r| o.recheck(r))),
            (ClientRole::Genesis, "POST", "/v1/pi-decode") => reply(parse(&req.body).and_then(|r| o.pi_decode(r))),
            (ClientRole::Genesis, "POST", "/v1/refusal") => reply(parse(&req.body).and_then(|r| o.file_refusal(r))),
            (ClientRole::Genesis, "GET", "/v1/crl") => reply(o.crl_snapshot()),
            (ClientRole::Support, "GET", "/v1/support/ticket") => reply(o.tickets(q("ref").unwrap_or(""))),
            (ClientRole::Support, "POST", "/v1/support/approve") => {
                reply(parse::<ApproveRequest>(&req.body).and_then(|r| o.approve(r)))
            }
            (ClientRole::Replica, "GET", "/v1/replica/status") if !standby => (200, o.replica_status()),
            (ClientRole::Replica, "GET", "/v1/replica/log") if !standby => {
                reply(o.replica_log(num("after", 0), num("limit", 500) as usize))
            }
            (ClientRole::Replica, "GET", "/v1/replica/dump") if !standby => {
                reply(o.replica_dump(q("cf").unwrap_or(""), q("after"), num("limit", 500) as usize))
            }
            (_, "GET" | "POST", _) => (404, json!({"error": "not_found"})),
            _ => (405, json!({"error": "method_not_allowed"})),
        }
    }
}

/// Reads one request; `Ok(None)` when the peer closed between requests, `Err(status)` for a bad one.
fn read_request<S: Read>(s: &mut S, buf: &mut Vec<u8>, max_body: usize) -> Result<Option<Request>, u16> {
    let mut chunk = [0u8; 8192];
    let head_len = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_HEAD {
            return Err(413);
        }
        match s.read(&mut chunk) {
            Ok(0) => return if buf.is_empty() { Ok(None) } else { Err(400) },
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return Ok(None),
        }
    };
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut r = httparse::Request::new(&mut headers);
    match r.parse(&buf[..head_len]) {
        Ok(httparse::Status::Complete(_)) => {}
        _ => return Err(400),
    }
    let method = r.method.unwrap_or("").to_string();
    let target = r.path.unwrap_or("").to_string();
    let http10 = r.version == Some(0);
    let mut len = 0usize;
    let mut close = http10;
    for h in r.headers.iter() {
        let v = std::str::from_utf8(h.value).unwrap_or("").trim();
        if h.name.eq_ignore_ascii_case("content-length") {
            len = v.parse().map_err(|_| 400u16)?;
        } else if h.name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(400);
        } else if h.name.eq_ignore_ascii_case("connection") {
            close = v.eq_ignore_ascii_case("close") || (http10 && !v.eq_ignore_ascii_case("keep-alive"));
        }
    }
    if len > max_body {
        return Err(413);
    }
    buf.drain(..head_len);
    while buf.len() < len {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return Err(400),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let body: Vec<u8> = buf.drain(..len).collect();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q),
        None => (target.clone(), ""),
    };
    let query = query
        .split('&')
        .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect();
    Ok(Some(Request { method, path, query, body, close }))
}

fn write_reply<S: Write>(s: &mut S, (status, body): Reply, close: bool) -> std::io::Result<()> {
    let body = body.to_string();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {}\r\n\r\n",
        status,
        status_text(status),
        body.len(),
        if close { "close" } else { "keep-alive" }
    );
    s.write_all(head.as_bytes())?;
    s.write_all(body.as_bytes())?;
    s.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_requests_with_bodies_and_keeps_the_rest_for_the_next() {
        let raw = b"POST /v1/claim?x=1 HTTP/1.1\r\nHost: o\r\nContent-Length: 4\r\n\r\nabcdGET /v1/health HTTP/1.1\r\nConnection: close\r\n\r\n";
        let mut cur = std::io::Cursor::new(raw.to_vec());
        let mut buf = Vec::new();
        let a = read_request(&mut cur, &mut buf, 1024).unwrap().unwrap();
        assert_eq!((a.method.as_str(), a.path.as_str(), a.body.as_slice(), a.close), ("POST", "/v1/claim", &b"abcd"[..], false));
        assert_eq!(a.query.get("x").map(String::as_str), Some("1"));
        let b = read_request(&mut cur, &mut buf, 1024).unwrap().unwrap();
        assert_eq!((b.path.as_str(), b.close), ("/v1/health", true));
        assert!(read_request(&mut cur, &mut buf, 1024).unwrap().is_none());
    }

    #[test]
    fn oversized_chunked_or_malformed_requests_are_refused() {
        let big = b"POST / HTTP/1.1\r\nContent-Length: 999999\r\n\r\n";
        assert_eq!(read_request(&mut std::io::Cursor::new(big.to_vec()), &mut Vec::new(), 1024).err(), Some(413));
        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(read_request(&mut std::io::Cursor::new(chunked.to_vec()), &mut Vec::new(), 1024).err(), Some(400));
        let junk = b"\x00\x01\x02\r\n\r\n";
        assert_eq!(read_request(&mut std::io::Cursor::new(junk.to_vec()), &mut Vec::new(), 1024).err(), Some(400));
    }

    struct Pki {
        ca: rcgen::Certificate,
        dir: tempfile::TempDir,
    }

    impl Pki {
        fn new() -> Self {
            let mut p = rcgen::CertificateParams::new(vec![]);
            p.alg = &rcgen::PKCS_ECDSA_P256_SHA256;
            p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
            p.distinguished_name.push(rcgen::DnType::CommonName, "oracle test ca");
            Pki { ca: rcgen::Certificate::from_params(p).unwrap(), dir: tempfile::tempdir().unwrap() }
        }
        /// Issues a certificate; returns (DER, PKCS#8 key).
        fn issue(&self, name: &str) -> (Vec<u8>, Vec<u8>) {
            let mut p = rcgen::CertificateParams::new(vec![name.to_string()]);
            p.alg = &rcgen::PKCS_ECDSA_P256_SHA256;
            p.distinguished_name.push(rcgen::DnType::CommonName, name);
            let c = rcgen::Certificate::from_params(p).unwrap();
            (c.serialize_der_with_signer(&self.ca).unwrap(), c.serialize_private_key_der())
        }
        fn write(&self, file: &str, label: &str, der: &[u8]) -> std::path::PathBuf {
            let path = self.dir.path().join(file);
            let pem = format!("-----BEGIN {l}-----\n{}\n-----END {l}-----\n", crate::messages::b64_encode(der), l = label);
            std::fs::write(&path, pem).unwrap();
            path
        }
    }

    fn client_config(pki: &Pki, cert: Option<(Vec<u8>, Vec<u8>)>) -> Arc<rustls::ClientConfig> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(pki.ca.serialize_der().unwrap())).unwrap();
        let b = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_root_certificates(roots);
        Arc::new(match cert {
            Some((c, k)) => b
                .with_client_auth_cert(vec![CertificateDer::from(c)], PrivateKeyDer::Pkcs8(k.into()))
                .unwrap(),
            None => b.with_no_client_auth(),
        })
    }

    fn get(addr: std::net::SocketAddr, cfg: Arc<rustls::ClientConfig>, path: &str) -> std::io::Result<(u16, Value)> {
        let tcp = TcpStream::connect(addr)?;
        tcp.set_read_timeout(Some(Duration::from_secs(10)))?;
        let conn = rustls::ClientConnection::new(cfg, "localhost".try_into().unwrap()).unwrap();
        let mut s = StreamOwned::new(conn, tcp);
        write!(s, "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n", path)?;
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        if out.is_empty() {
            return Err(std::io::Error::other("no answer"));
        }
        let text = String::from_utf8_lossy(&out).to_string();
        let status = text.get(9..12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("{}");
        Ok((status, serde_json::from_str(body).unwrap_or(Value::Null)))
    }

    #[test]
    fn mutual_tls_admits_listed_clients_by_role_only() {
        let pki = Pki::new();
        let (scert, skey) = pki.issue("localhost");
        let genesis = pki.issue("genesis-001");
        let support = pki.issue("support");
        let stranger = pki.issue("stranger");
        let cert_path = pki.write("server.crt", "CERTIFICATE", &scert);
        let key_path = pki.write("server.key", "PRIVATE KEY", &skey);
        let ca_path = pki.write("ca.crt", "CERTIFICATE", &pki.ca.serialize_der().unwrap());
        let tls = tls_config(&cert_path, &key_path, &ca_path).unwrap();
        let clients = vec![
            crate::config::Client { name: "genesis-001".into(), role: ClientRole::Genesis, sha256: hex::encode(sha256(&genesis.0)) },
            crate::config::Client { name: "support".into(), role: ClientRole::Support, sha256: hex::encode(sha256(&support.0)) },
        ];
        let crate::testkit::H { o, _dir, .. } = crate::testkit::H::new(crate::testkit::Opts::default());
        let server = Arc::new(Server::new(Arc::new(o), tls, &clients, Role::Primary, 64 * 1024));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || server.run(listener, 2, 8));

        let (s, v) = get(addr, client_config(&pki, Some(genesis.clone())), "/v1/health").unwrap();
        assert_eq!((s, v["role"].as_str()), (200, Some("primary")));
        let (s, v) = get(addr, client_config(&pki, Some(genesis.clone())), "/v1/crl").unwrap();
        assert_eq!((s, v["error"].as_str()), (503, Some("unavailable")));
        let (s, _) = get(addr, client_config(&pki, Some(support.clone())), "/v1/crl").unwrap();
        assert_eq!(s, 404, "a support certificate cannot call genesis routes");
        let (s, v) = get(addr, client_config(&pki, Some(support)), "/v1/support/ticket?ref=zz").unwrap();
        assert_eq!((s, v["error"].as_str()), (400, Some("bad_request")));
        let (s, _) = get(addr, client_config(&pki, Some(stranger)), "/v1/health").unwrap();
        assert_eq!(s, 403, "a certificate from our CA that is not listed is refused");
        assert!(get(addr, client_config(&pki, None), "/v1/health").is_err(), "no certificate, no connection");
    }
}

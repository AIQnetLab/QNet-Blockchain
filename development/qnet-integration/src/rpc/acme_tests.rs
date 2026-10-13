//! The certificate client against a local test CA that models the real one's rules: IP identifiers
//! only under `shortlived`, an empty CSR subject, the tls-alpn-01 validator (reverse-name SNI,
//! acme-tls/1, self-signed, one iPAddress SAN, critical acmeIdentifier) from several vantage points,
//! `replaces` with 409 `alreadyReplaced`, rate limits with Retry-After, `badNonce`, changed terms, the
//! pause, and renewal information. The validations hit the node's real wallet-plane listener.

use super::*;
use super::super::wallet_plane::{self, serve, server_config, EgressBudget, Limits, PlaneCtx, PlaneRoutes, ALPN_ACME_TLS};
use rand::RngCore;
use std::collections::{HashMap, HashSet, VecDeque};
use x509_parser::prelude::FromDer;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─── The test CA ────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Inject {
    BadNonce,
    RateLimited(u64),
    Unavailable(u64),
    TermsChanged,
    Paused,
    /// The next challenge POST never answers (the node dies during validation).
    HangChallenge,
}

struct Account {
    pk: Vec<u8>,
    thumbprint: String,
}

struct Order {
    ip: String,
    status: String,
    authz: u64,
    cert: Option<u64>,
}

struct Authz {
    ip: String,
    token: String,
    kid: String,
    status: String,
    error: Option<String>,
}

#[derive(Default)]
struct Seen {
    accounts_created: u32,
    validations: u32,
    csr_subjects_empty: Vec<bool>,
    replaces: Vec<Option<String>>,
    leaf_keys: Vec<Vec<u8>>,
    profiles: Vec<String>,
    terms_agreed: u32,
}

struct Mock {
    base: String,
    plane: SocketAddr,
    nonces: HashSet<String>,
    next: u64,
    accounts: HashMap<String, Account>,
    orders: HashMap<u64, Order>,
    authzs: HashMap<u64, Authz>,
    pems: HashMap<u64, String>,
    replaced: HashSet<String>,
    /// Certificate id (renewal-information form) to the account that ordered it.
    owners: HashMap<String, String>,
    profiles: Vec<&'static str>,
    inject: VecDeque<Inject>,
    terms_pending: bool,
    ari: Option<(i64, i64)>,
    ari_retry_after: Option<u64>,
    fail_validation: bool,
    issuer: rcgen::Certificate,
    issuer_der: Vec<u8>,
    seen: Seen,
}

type Shared = Arc<parking_lot::Mutex<Mock>>;

fn b64(b: &[u8]) -> String {
    B64URL.encode(b)
}

fn unb64(s: &str) -> Vec<u8> {
    B64URL.decode(s.as_bytes()).unwrap_or_default()
}

fn issuer() -> (rcgen::Certificate, Vec<u8>) {
    let mut p = rcgen::CertificateParams::default();
    p.distinguished_name = rcgen::DistinguishedName::new();
    p.distinguished_name.push(rcgen::DnType::CommonName, "test issuing authority");
    p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    p.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign, rcgen::KeyUsagePurpose::DigitalSignature];
    let c = rcgen::Certificate::from_params(p).unwrap();
    let der = c.serialize_der().unwrap();
    (c, der)
}

fn pem(der: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<String> = b.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n", lines.join("\n"))
}

/// A subject key the CA holds only as public bytes (from the CSR).
struct PublicOnly(Vec<u8>);

impl rcgen::RemoteKeyPair for PublicOnly {
    fn public_key(&self) -> &[u8] {
        &self.0
    }
    fn sign(&self, _msg: &[u8]) -> Result<Vec<u8>, rcgen::Error> {
        Err(rcgen::Error::RingUnspecified)
    }
    fn algorithm(&self) -> &'static rcgen::SignatureAlgorithm {
        &rcgen::PKCS_ECDSA_P256_SHA256
    }
}

/// A leaf for `ip` over `pk`, signed by the test issuer, valid `nb..na`, with extra SANs or without
/// serverAuth on request (the chain-check tests).
fn leaf(issuer: &rcgen::Certificate, pk: &[u8], sans: Vec<rcgen::SanType>, server_auth: bool, nb: i64, na: i64) -> Vec<u8> {
    let mut p = rcgen::CertificateParams::default();
    p.distinguished_name = rcgen::DistinguishedName::new();
    p.subject_alt_names = sans;
    if server_auth {
        p.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    } else {
        p.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    }
    // Seconds after the epoch, without naming the date type rcgen takes.
    p.not_before = rcgen::date_time_ymd(1970, 1, 1) + Duration::from_secs(nb as u64);
    p.not_after = rcgen::date_time_ymd(1970, 1, 1) + Duration::from_secs(na as u64);
    let mut serial = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut serial);
    serial[0] = (serial[0] & 0x7f) | 0x01;
    p.serial_number = Some(rcgen::SerialNumber::from_slice(&serial));
    p.use_authority_key_identifier_extension = true;
    p.key_pair = Some(rcgen::KeyPair::from_remote(Box::new(PublicOnly(pk.to_vec()))).unwrap());
    rcgen::Certificate::from_params(p).unwrap().serialize_der_with_signer(issuer).unwrap()
}

fn problem_reply(status: u16, kind: &str, detail: &str, retry_after: Option<u64>, links: &[(&str, &str)]) -> (u16, Vec<(String, String)>, String) {
    let mut h = vec![("content-type".to_string(), "application/problem+json".to_string())];
    if let Some(r) = retry_after {
        h.push(("retry-after".to_string(), r.to_string()));
    }
    for (rel, url) in links {
        h.push(("link".to_string(), format!("<{}>;rel=\"{}\"", url, rel)));
    }
    (status, h, json!({ "type": format!("{}{}", ERR_PREFIX, kind), "detail": detail, "status": status }).to_string())
}

fn ok_reply(status: u16, location: Option<String>, body: Value) -> (u16, Vec<(String, String)>, String) {
    let mut h = vec![("content-type".to_string(), "application/json".to_string())];
    if let Some(l) = location {
        h.push(("location".to_string(), l));
    }
    (status, h, body.to_string())
}

impl Mock {
    fn nonce(&mut self) -> String {
        self.next += 1;
        let n = format!("nonce-{}", self.next);
        self.nonces.insert(n.clone());
        n
    }

    fn id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    fn directory(&self) -> Value {
        let mut profiles = serde_json::Map::new();
        for p in &self.profiles {
            profiles.insert(p.to_string(), json!("a test profile"));
        }
        json!({
            "newNonce": format!("{}/nonce", self.base),
            "newAccount": format!("{}/new-acct", self.base),
            "newOrder": format!("{}/new-order", self.base),
            "renewalInfo": format!("{}/ari", self.base),
            "meta": { "termsOfService": format!("{}/terms-v2", self.base), "profiles": profiles },
        })
    }
}

/// Check the JWS and return (kid, payload) or a problem.
fn verify_jws(m: &mut Mock, url: &str, body: &[u8], new_account: bool) -> Result<(String, Option<Value>), (u16, Vec<(String, String)>, String)> {
    let jws: Value = serde_json::from_slice(body).map_err(|_| problem_reply(400, "malformed", "not json", None, &[]))?;
    let (p64, pl64, s64) = (jws["protected"].as_str().unwrap_or(""), jws["payload"].as_str().unwrap_or(""), jws["signature"].as_str().unwrap_or(""));
    let protected: Value = serde_json::from_slice(&unb64(p64)).map_err(|_| problem_reply(400, "malformed", "protected", None, &[]))?;
    if protected["alg"] != json!("ES256") || protected["url"].as_str() != Some(url) {
        return Err(problem_reply(400, "malformed", "alg or url", None, &[]));
    }
    if m.inject.front() == Some(&Inject::BadNonce) {
        m.inject.pop_front();
        return Err(problem_reply(400, "badNonce", "stale", None, &[]));
    }
    let nonce = protected["nonce"].as_str().unwrap_or("").to_string();
    if !m.nonces.remove(&nonce) {
        return Err(problem_reply(400, "badNonce", "unknown nonce", None, &[]));
    }
    let (kid, pk) = if new_account {
        let jwk = &protected["jwk"];
        let mut pk = vec![4u8];
        pk.extend(unb64(jwk["x"].as_str().unwrap_or("")));
        pk.extend(unb64(jwk["y"].as_str().unwrap_or("")));
        (String::new(), pk)
    } else {
        let kid = protected["kid"].as_str().unwrap_or("").to_string();
        let pk = m.accounts.get(&kid).map(|a| a.pk.clone()).ok_or_else(|| problem_reply(400, "accountDoesNotExist", "kid", None, &[]))?;
        (kid, pk)
    };
    let msg = format!("{}.{}", p64, pl64);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, &pk)
        .verify(msg.as_bytes(), &unb64(s64))
        .map_err(|_| problem_reply(401, "unauthorized", "bad signature", None, &[]))?;
    let payload = if pl64.is_empty() { None } else { serde_json::from_slice(&unb64(pl64)).ok() };
    if new_account {
        let jwk = &protected["jwk"];
        let canonical = format!("{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
                                jwk["x"].as_str().unwrap_or(""), jwk["y"].as_str().unwrap_or(""));
        use sha2::Digest as _;
        let thumbprint = b64(&sha2::Sha256::digest(canonical.as_bytes()));
        return Ok((thumbprint + "|" + &b64(&pk), payload));
    }
    Ok((kid, payload))
}

/// One tls-alpn-01 validation from one vantage point, as the CA's validator checks it.
async fn validate_once(plane: SocketAddr, ip: &str, expected: [u8; 32]) -> Result<(), String> {
    let ipv4: Ipv4Addr = ip.parse().map_err(|_| "ip")?;
    let cfg = wallet_plane::probe_client_config(&[ALPN_ACME_TLS])?;
    let name = rustls::pki_types::ServerName::try_from(wallet_plane::reverse_name(ipv4)).map_err(|e| e.to_string())?;
    let tcp = tokio::net::TcpStream::connect(plane).await.map_err(|e| e.to_string())?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp).await.map_err(|e| format!("handshake: {}", e))?;
    let conn = tls.get_ref().1;
    if conn.alpn_protocol() != Some(ALPN_ACME_TLS) {
        return Err("alpn".into());
    }
    let chain = conn.peer_certificates().ok_or("no certificate")?;
    if chain.len() != 1 {
        return Err("one certificate".into());
    }
    let (_, c) = x509_parser::parse_x509_certificate(chain[0].as_ref()).map_err(|e| e.to_string())?;
    let self_signed = c.subject() == c.issuer()
        && ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, c.public_key().subject_public_key.data.as_ref())
            .verify(c.tbs_certificate.as_ref(), c.signature_value.data.as_ref())
            .is_ok();
    if !self_signed {
        return Err("not self-signed".into());
    }
    let sans = c.subject_alternative_name().map_err(|_| "san")?.ok_or("no san")?.value.general_names.clone();
    if sans.len() != 1 || !matches!(&sans[0], x509_parser::extensions::GeneralName::IPAddress(b) if *b == ipv4.octets().as_slice()) {
        return Err("san must be exactly the ip".into());
    }
    let ids: Vec<_> = c.extensions().iter().filter(|e| e.oid.to_id_string() == "1.3.6.1.5.5.7.1.31").collect();
    if ids.len() != 1 || !ids[0].critical || ids[0].value != [&[0x04, 0x20][..], &expected[..]].concat().as_slice() {
        return Err("acmeIdentifier".into());
    }
    Ok(())
}

async fn handle(shared: Shared, method: String, path: String, body: bytes::Bytes) -> (u16, Vec<(String, String)>, String) {
    let base = shared.lock().base.clone();
    let url = format!("{}{}", base, path);
    let segs: Vec<String> = path.trim_start_matches('/').split('/').map(str::to_string).collect();
    match (method.as_str(), segs.iter().map(String::as_str).collect::<Vec<_>>().as_slice()) {
        ("GET", ["dir"]) => ok_reply(200, None, shared.lock().directory()),
        ("HEAD", ["nonce"]) | ("GET", ["nonce"]) => (200, vec![], String::new()),
        ("GET", ["ari", id]) => {
            let m = shared.lock();
            match m.ari {
                Some((s, e)) if m.pems.values().any(|_| true) => {
                    let now = wallet_plane::unix_now() as i64;
                    let t = |x: i64| chrono::DateTime::<chrono::Utc>::from_timestamp(now + x, 0).unwrap().to_rfc3339();
                    let mut r = ok_reply(200, None, json!({ "suggestedWindow": { "start": t(s), "end": t(e) }, "id": id }));
                    if let Some(ra) = m.ari_retry_after {
                        r.1.push(("retry-after".to_string(), ra.to_string()));
                    }
                    r
                }
                _ => problem_reply(404, "malformed", "no renewal info", None, &[]),
            }
        }
        ("POST", rest) => {
            let rest: Vec<String> = rest.iter().map(|s| s.to_string()).collect();
            post(shared, &url, &rest, &body).await
        }
        _ => problem_reply(404, "malformed", "no route", None, &[]),
    }
}

async fn post(shared: Shared, url: &str, segs: &[String], body: &[u8]) -> (u16, Vec<(String, String)>, String) {
    let new_account = segs.first().map(String::as_str) == Some("new-acct");
    let (kid, payload) = {
        let mut m = shared.lock();
        match verify_jws(&mut m, url, body, new_account) {
            Ok(x) => x,
            Err(p) => return p,
        }
    };
    let seg = |i: usize| segs.get(i).map(String::as_str).unwrap_or("");
    let num = |i: usize| seg(i).parse::<u64>().unwrap_or(0);
    match seg(0) {
        "new-acct" => {
            let mut m = shared.lock();
            if payload.as_ref().map(|p| p["termsOfServiceAgreed"] == json!(true)) != Some(true) {
                return problem_reply(400, "malformed", "terms", None, &[]);
            }
            let (thumb, pk64) = kid.split_once('|').unwrap();
            // A key that already holds an account gets that account back, as at the real CA.
            let pk = unb64(pk64);
            if let Some(existing) = m.accounts.iter().find(|(_, a)| a.pk == pk).map(|(k, _)| k.clone()) {
                return ok_reply(200, Some(existing), json!({ "status": "valid" }));
            }
            let n = m.id();
            let k = format!("{}/acct/{}", m.base, n);
            m.accounts.insert(k.clone(), Account { pk: unb64(pk64), thumbprint: thumb.to_string() });
            m.seen.accounts_created += 1;
            ok_reply(201, Some(k), json!({ "status": "valid" }))
        }
        "acct" => {
            let mut m = shared.lock();
            if payload.as_ref().map(|p| p["termsOfServiceAgreed"] == json!(true)) == Some(true) {
                m.terms_pending = false;
                m.seen.terms_agreed += 1;
            }
            ok_reply(200, None, json!({ "status": "valid" }))
        }
        "new-order" => {
            let mut m = shared.lock();
            match m.inject.front().cloned() {
                Some(Inject::RateLimited(s)) => { m.inject.pop_front(); return problem_reply(429, "rateLimited", "too many new orders", Some(s), &[]); }
                Some(Inject::Unavailable(s)) => { m.inject.pop_front(); return problem_reply(503, "serverInternal", "down", Some(s), &[]); }
                Some(Inject::Paused) => {
                    m.inject.pop_front();
                    return problem_reply(429, "rateLimited", "Your account is paused for this identifier, please visit https://ca.test/unpause?id=1.", None, &[]);
                }
                Some(Inject::TermsChanged) => {
                    m.inject.pop_front();
                    m.terms_pending = true;
                }
                _ => {}
            }
            if m.terms_pending {
                let tos = format!("{}/terms-v2", m.base);
                return problem_reply(403, "userActionRequired", "new terms", None, &[("terms-of-service", &tos)]);
            }
            let p = payload.unwrap_or(Value::Null);
            let profile = p["profile"].as_str().unwrap_or("").to_string();
            m.seen.profiles.push(profile.clone());
            let ids = p["identifiers"].as_array().cloned().unwrap_or_default();
            if ids.len() != 1 || ids[0]["type"] != json!("ip") || profile != PROFILE || !m.profiles.contains(&PROFILE) {
                return problem_reply(400, "rejectedIdentifier", "ip identifiers need the shortlived profile", None, &[]);
            }
            let replaces = p["replaces"].as_str().map(str::to_string);
            m.seen.replaces.push(replaces.clone());
            if let Some(r) = &replaces {
                if m.owners.get(r).map_or(false, |owner| *owner != kid) {
                    return problem_reply(403, "unauthorized", "requester account did not request the certificate being replaced by this order", None, &[]);
                }
                if !m.replaced.insert(r.clone()) {
                    return problem_reply(409, "alreadyReplaced", "certificate already replaced", None, &[]);
                }
            }
            let ip = ids[0]["value"].as_str().unwrap_or("").to_string();
            let az = m.id();
            let mut token = [0u8; 24];
            rand::thread_rng().fill_bytes(&mut token);
            m.authzs.insert(az, Authz { ip: ip.clone(), token: b64(&token), kid, status: "pending".into(), error: None });
            let o = m.id();
            m.orders.insert(o, Order { ip: ip.clone(), status: "pending".into(), authz: az, cert: None });
            let base = m.base.clone();
            ok_reply(201, Some(format!("{}/order/{}", base, o)), json!({
                "status": "pending", "identifiers": [{ "type": "ip", "value": ip }],
                "authorizations": [format!("{}/authz/{}", base, az)], "finalize": format!("{}/finalize/{}", base, o),
            }))
        }
        "authz" => {
            let m = shared.lock();
            let Some(a) = m.authzs.get(&num(1)) else { return problem_reply(404, "malformed", "authz", None, &[]) };
            let mut ch = json!({ "type": "tls-alpn-01", "url": format!("{}/chall/{}", m.base, num(1)), "token": a.token, "status": a.status });
            if let Some(e) = &a.error {
                ch["error"] = json!({ "type": format!("{}unauthorized", ERR_PREFIX), "detail": e });
            }
            ok_reply(200, None, json!({ "status": a.status, "identifier": { "type": "ip", "value": a.ip },
                "challenges": [{ "type": "http-01", "url": "x", "token": "t", "status": "pending" }, ch] }))
        }
        "chall" => {
            let hang = {
                let mut m = shared.lock();
                let hang = m.inject.front() == Some(&Inject::HangChallenge);
                if hang {
                    m.inject.pop_front();
                }
                hang
            };
            if hang {
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
            }
            let (plane, ip, expected, fail) = {
                let m = shared.lock();
                let Some(a) = m.authzs.get(&num(1)) else { return problem_reply(404, "malformed", "chall", None, &[]) };
                let thumb = m.accounts.get(&a.kid).map(|x| x.thumbprint.clone()).unwrap_or_default();
                (m.plane, a.ip.clone(), key_authorization_digest(&a.token, &thumb), m.fail_validation)
            };
            // Several vantage points, each its own handshake.
            let mut result = Ok(());
            for _ in 0..3 {
                let r = if fail { Err("forced failure".to_string()) } else { validate_once(plane, &ip, expected).await };
                shared.lock().seen.validations += 1;
                if r.is_err() {
                    result = r;
                    break;
                }
            }
            let mut m = shared.lock();
            let a = m.authzs.get_mut(&num(1)).unwrap();
            match result {
                Ok(()) => a.status = "valid".into(),
                Err(e) => { a.status = "invalid".into(); a.error = Some(e); }
            }
            let status = a.status.clone();
            if status == "valid" {
                for o in m.orders.values_mut().filter(|o| o.authz == num(1)) {
                    o.status = "ready".into();
                }
            } else {
                for o in m.orders.values_mut().filter(|o| o.authz == num(1)) {
                    o.status = "invalid".into();
                }
            }
            ok_reply(200, None, json!({ "type": "tls-alpn-01", "status": "processing" }))
        }
        "finalize" => {
            let csr_der = payload.as_ref().and_then(|p| p["csr"].as_str()).map(unb64).unwrap_or_default();
            let parsed = x509_parser::certification_request::X509CertificationRequest::from_der(&csr_der);
            let Ok((_, csr)) = parsed else { return problem_reply(400, "badCSR", "unparsable", None, &[]) };
            let mut m = shared.lock();
            let o = num(1);
            let Some(order) = m.orders.get(&o) else { return problem_reply(404, "malformed", "order", None, &[]) };
            if order.status != "ready" {
                return problem_reply(403, "orderNotReady", "not ready", None, &[]);
            }
            let ip: Ipv4Addr = order.ip.parse().unwrap();
            let info = &csr.certification_request_info;
            let subject_empty = info.subject.iter().count() == 0;
            m.seen.csr_subjects_empty.push(subject_empty);
            if !subject_empty {
                return problem_reply(400, "badCSR", "a CSR subject becomes an identifier", None, &[]);
            }
            let sans: Vec<Vec<u8>> = csr.requested_extensions().into_iter().flatten().filter_map(|e| match e {
                x509_parser::extensions::ParsedExtension::SubjectAlternativeName(s) => Some(s.general_names.iter().map(|g| match g {
                    x509_parser::extensions::GeneralName::IPAddress(b) => b.to_vec(),
                    _ => vec![],
                }).collect::<Vec<_>>()),
                _ => None,
            }).flatten().collect();
            if sans != vec![ip.octets().to_vec()] {
                return problem_reply(400, "badCSR", "names", None, &[]);
            }
            let pk = info.subject_pki.subject_public_key.data.to_vec();
            m.seen.leaf_keys.push(pk.clone());
            let now = wallet_plane::unix_now() as i64;
            let der = leaf(&m.issuer, &pk, vec![rcgen::SanType::IpAddress(IpAddr::V4(ip))], true, now - 60, now + 160 * 3600);
            let chain = format!("{}{}", pem(&der), pem(&m.issuer_der));
            let owner = m.orders.get(&o).and_then(|ord| m.authzs.get(&ord.authz)).map(|a| a.kid.clone()).unwrap_or_default();
            if let Some(id) = chain_facts(&chain).ok().and_then(|(_, f)| f.cert_id) {
                m.owners.insert(id, owner);
            }
            let c = m.id();
            m.pems.insert(c, chain);
            let order = m.orders.get_mut(&o).unwrap();
            order.status = "valid".into();
            order.cert = Some(c);
            let base = m.base.clone();
            ok_reply(200, None, json!({ "status": "processing", "finalize": format!("{}/finalize/{}", base, o) }))
        }
        "order" => {
            let m = shared.lock();
            let Some(order) = m.orders.get(&num(1)) else { return problem_reply(404, "malformed", "order", None, &[]) };
            let mut v = json!({ "status": order.status });
            if let Some(c) = order.cert {
                v["certificate"] = json!(format!("{}/cert/{}", m.base, c));
            }
            ok_reply(200, None, v)
        }
        "cert" => {
            let m = shared.lock();
            match m.pems.get(&num(1)) {
                Some(p) => (200, vec![("content-type".to_string(), "application/pem-certificate-chain".to_string())], p.clone()),
                None => problem_reply(404, "malformed", "cert", None, &[]),
            }
        }
        _ => problem_reply(404, "malformed", "no such resource", None, &[]),
    }
}

/// Start the test CA, validating against `plane`. (shared state, directory URL)
async fn start_ca(plane: SocketAddr) -> (Shared, String) {
    let (issuer, issuer_der) = issuer();
    let shared: Shared = Arc::new(parking_lot::Mutex::new(Mock {
        base: String::new(), plane, nonces: HashSet::new(), next: 0, accounts: HashMap::new(), orders: HashMap::new(),
        authzs: HashMap::new(), pems: HashMap::new(), replaced: HashSet::new(), owners: HashMap::new(), profiles: vec!["classic", PROFILE],
        inject: VecDeque::new(), terms_pending: false, ari: None, ari_retry_after: None, fail_validation: false,
        issuer, issuer_der, seen: Seen::default(),
    }));
    let s = Arc::clone(&shared);
    let route = warp::method()
        .and(warp::path::full())
        .and(warp::body::bytes())
        .and_then(move |m: warp::http::Method, p: warp::path::FullPath, body: bytes::Bytes| {
            let s = Arc::clone(&s);
            async move {
                let (status, headers, body) = handle(Arc::clone(&s), m.to_string(), p.as_str().to_string(), body).await;
                let nonce = s.lock().nonce();
                let mut r = warp::reply::Response::new(warp::hyper::Body::from(body));
                *r.status_mut() = warp::http::StatusCode::from_u16(status).unwrap();
                r.headers_mut().insert("replay-nonce", warp::http::HeaderValue::from_str(&nonce).unwrap());
                for (k, v) in headers {
                    r.headers_mut().append(warp::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), warp::http::HeaderValue::from_str(&v).unwrap());
                }
                Ok::<_, Rejection>(r)
            }
        });
    let (addr, server) = warp::serve(route).bind_ephemeral(([127, 0, 0, 1], 0));
    tokio::spawn(server);
    let base = format!("http://{}", addr);
    shared.lock().base = base.clone();
    (shared, format!("{}/dir", base))
}

/// The node's wallet plane on loopback with its own certificate store.
async fn start_plane() -> (SocketAddr, Arc<CertStore>) {
    let certs = Arc::new(CertStore::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let routes: PlaneRoutes = warp::path("healthz").map(|| warp::Reply::into_response("ok h=1")).boxed();
    let ctx = PlaneCtx::new(routes, server_config(Arc::clone(&certs) as Arc<dyn rustls::server::ResolvesServerCert>).unwrap(),
                            Limits::production(), EgressBudget::new(1e9, 1e9));
    tokio::spawn(serve(listener, ctx));
    (addr, certs)
}

fn tempdir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("qnet-acme-test-{}-{}", std::process::id(), rand::random::<u64>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// A manager past its probe and its first-order delay.
fn ready_manager(dir: PathBuf, url: &str, certs: Arc<CertStore>) -> CertManager {
    let mut m = CertManager::open_with(dir, url, certs);
    let now = wallet_plane::unix_now();
    m.on_precheck(true, now);
    m.state.first_order_not_before = Some(now);
    m
}

/// A TLS client that trusts only the test issuer, connecting by IP literal as a wallet does.
async fn wallet_fetch(addr: SocketAddr, issuer_der: &[u8]) -> Result<String, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(rustls::pki_types::CertificateDer::from(issuer_der.to_vec())).map_err(|e| e.to_string())?;
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13]).unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = tokio::net::TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(rustls::pki_types::ServerName::IpAddress(addr.ip().into()), tcp).await.map_err(|e| e.to_string())?;
    tls.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    tls.read_to_string(&mut out).await.ok();
    Ok(out)
}

// ─── Issuance, renewal, restart ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn acme_issues_and_renews_against_a_test_ca() {
    let (plane, certs) = start_plane().await;
    let (ca, url) = start_ca(plane).await;
    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    let now = wallet_plane::unix_now();
    assert_eq!(m.plan(LOOPBACK, now), Step::Issue { replaces: None });
    let first = m.issue(LOOPBACK, None).await.expect("first issuance");
    assert_eq!(first.ip, LOOPBACK);
    assert!(first.not_after > now + 150 * 3600 && first.not_before <= now);
    let first_id = first.cert_id.clone().expect("the leaf names its issuer's key: renewal information applies");
    assert_eq!(certs.valid_ip(wallet_plane::unix_now()), Some(LOOPBACK), "installed into the plane's resolver");
    // The attempt's provisional failure and failed authorization gave way to the outcome.
    assert_eq!((m.state().backoff_step, m.state().next_attempt_at, m.state().authz_failures.len()), (0, 0, 0));
    {
        let ca = ca.lock();
        assert_eq!(ca.seen.accounts_created, 1);
        assert!(ca.seen.validations >= 3, "validated from several vantage points");
        assert_eq!(ca.seen.csr_subjects_empty, vec![true]);
        assert_eq!(ca.seen.profiles, vec![PROFILE.to_string()]);
        assert_eq!(ca.seen.replaces, vec![None]);
    }
    for f in [ACCOUNT_KEY_FILE, ACCOUNT_URL_FILE, CERT_FILE, CERT_KEY_FILE, STATE_FILE] {
        assert!(dir.join(f).is_file(), "{} persisted", f);
    }
    // A wallet that trusts the CA reaches the plane by IP literal over TLS.
    let issuer_der = ca.lock().issuer_der.clone();
    let reply = wallet_fetch(plane, &issuer_der).await.expect("a wallet's TLS check passes");
    assert!(reply.starts_with("HTTP/1.1 200") && reply.ends_with("ok h=1"), "{}", reply);

    // Renewal: renewal information first; a window already past means at once, with `replaces`.
    assert_eq!(m.plan(LOOPBACK, wallet_plane::unix_now()), Step::PollRenewalInfo);
    ca.lock().ari = Some((-7200, -3600));
    ca.lock().ari_retry_after = Some(60);
    let now = wallet_plane::unix_now();
    m.poll_renewal_info(now).await;
    assert_eq!(m.state().renew_at, Some(now));
    assert_eq!(m.state().ari_next_poll, now + ARI_POLL_MIN_SECS, "Retry-After 60 s is clamped up to 1 h");
    assert_eq!(m.plan(LOOPBACK, now), Step::Issue { replaces: Some(first_id.clone()) });
    let second = m.issue(LOOPBACK, Some(first_id.clone())).await.expect("renewal");
    assert_ne!(second.cert_id, first.cert_id);
    {
        let ca = ca.lock();
        assert_eq!(ca.seen.replaces, vec![None, Some(first_id.clone())]);
        assert_eq!(ca.seen.leaf_keys.len(), 2);
        assert_ne!(ca.seen.leaf_keys[0], ca.seen.leaf_keys[1], "a fresh key every issuance");
        assert_eq!(ca.seen.accounts_created, 1, "one account per node");
    }
    // A crash after finalize: the old certificate is replaced already; the order goes again without it.
    let third = m.issue(LOOPBACK, Some(first_id.clone())).await.expect("409 alreadyReplaced retried without replaces");
    assert_eq!(ca.lock().seen.replaces, vec![None, Some(first_id.clone()), Some(first_id), None]);
    // Restart: everything comes back from disk; the account is reused; the held certificate is served.
    let certs2 = Arc::new(CertStore::new());
    let m2 = CertManager::open_with(dir.clone(), &url, Arc::clone(&certs2));
    assert_eq!(m2.facts(), Some(&third));
    assert_eq!(certs2.valid_ip(wallet_plane::unix_now()), Some(LOOPBACK));
    assert!(m2.has_account());
    assert_eq!(m2.state().issued_ever, true);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn acme_ca_errors_are_typed_and_honoured() {
    let (plane, certs) = start_plane().await;
    let (ca, url) = start_ca(plane).await;
    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    // A stale nonce is retried once and is not a failure.
    ca.lock().inject.push_back(Inject::BadNonce);
    m.issue(LOOPBACK, None).await.expect("badNonce retried");
    assert_eq!(m.state().backoff_step, 0);
    // 429 with a Retry-After longer than the backoff step: the longer wait wins.
    ca.lock().inject.push_back(Inject::RateLimited(5000));
    let e = m.issue(LOOPBACK, None).await.unwrap_err();
    assert_eq!((e.stage, e.fault.clone(), e.retry_after), (Stage::Order, Fault::RateLimited, Some(5000)));
    let now = wallet_plane::unix_now();
    assert!(m.state().next_attempt_at >= now + 4990 && m.state().next_attempt_at <= now + 5010);
    // 503 with a shorter Retry-After: the backoff step (now 1 h) wins.
    m.state.next_attempt_at = 0;
    ca.lock().inject.push_back(Inject::Unavailable(30));
    let e = m.issue(LOOPBACK, None).await.unwrap_err();
    assert_eq!((e.fault.clone(), e.retry_after), (Fault::Unavailable, Some(30)));
    assert!(m.state().next_attempt_at >= wallet_plane::unix_now() + 3590);
    // Changed terms: agreed again under the operator's notice, then the order proceeds.
    m.state.next_attempt_at = 0;
    ca.lock().inject.push_back(Inject::TermsChanged);
    m.issue(LOOPBACK, None).await.expect("terms agreed and order placed");
    assert_eq!(ca.lock().seen.terms_agreed, 1);
    // The pause: 24 h and the CA's unpause link.
    ca.lock().inject.push_back(Inject::Paused);
    let e = m.issue(LOOPBACK, None).await.unwrap_err();
    assert_eq!(e.fault, Fault::Paused(Some("https://ca.test/unpause?id=1".to_string())));
    assert!(m.state().next_attempt_at >= wallet_plane::unix_now() + 24 * 3600 - 10);
    // No `shortlived` in the directory: profile_unavailable, 24 h.
    let (plane2, certs2) = start_plane().await;
    let (ca2, url2) = start_ca(plane2).await;
    ca2.lock().profiles = vec!["classic"];
    let mut m2 = ready_manager(tempdir(), &url2, certs2);
    let e = m2.issue(LOOPBACK, None).await.unwrap_err();
    assert_eq!((e.stage, e.fault), (Stage::Order, Fault::ProfileUnavailable));
    assert!(m2.state().next_attempt_at >= wallet_plane::unix_now() + 24 * 3600 - 10);
    assert_eq!(ca2.lock().seen.accounts_created, 0, "no account for a CA that cannot issue for an IP");
    // The directory is read afresh for each issuance: the profile offered again needs no restart.
    ca2.lock().profiles = vec!["classic", PROFILE];
    m2.issue(LOOPBACK, None).await.expect("the profile is back in the directory");
    assert_eq!((m2.state().backoff_step, m2.state().next_attempt_at), (0, 0));
    // A failed validation counts against the per-identifier cap and asks for a new probe.
    let (plane3, certs3) = start_plane().await;
    let (ca3, url3) = start_ca(plane3).await;
    ca3.lock().fail_validation = true;
    let mut m3 = ready_manager(tempdir(), &url3, Arc::clone(&certs3));
    let e = m3.issue(LOOPBACK, None).await.unwrap_err();
    assert!(matches!(e.fault, Fault::AuthorizationInvalid(_)), "{:?}", e.fault);
    assert_eq!(e.stage, Stage::Challenge);
    assert_eq!(m3.state().authz_failures.len(), 1);
    assert_eq!(m3.state().precheck_ok_at, None);
    assert_eq!(certs3.valid_ip(wallet_plane::unix_now()), None, "nothing installed");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_challenge_is_armed_only_while_the_authorization_is_pending() {
    let (plane, certs) = start_plane().await;
    let (_ca, url) = start_ca(plane).await;
    let mut m = ready_manager(tempdir(), &url, Arc::clone(&certs));
    m.issue(LOOPBACK, None).await.unwrap();
    // After the issuance the reverse name answers nothing on acme-tls/1.
    let cfg = wallet_plane::probe_client_config(&[ALPN_ACME_TLS]).unwrap();
    let name = rustls::pki_types::ServerName::try_from(wallet_plane::reverse_name(LOOPBACK)).unwrap();
    let tcp = tokio::net::TcpStream::connect(plane).await.unwrap();
    assert!(tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp).await.is_err(), "disarmed after the authorization");
}

#[tokio::test]
async fn an_attempt_cut_short_is_on_disk_as_a_failure() {
    let (plane, certs) = start_plane().await;
    let (ca, url) = start_ca(plane).await;
    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    let t = wallet_plane::unix_now();
    assert_eq!(m.plan(LOOPBACK, t), Step::Issue { replaces: None });
    // The process dies while the CA validates (the attempt is dropped mid-flight, nothing after it runs).
    ca.lock().inject.push_back(Inject::HangChallenge);
    assert!(tokio::time::timeout(Duration::from_secs(5), m.issue(LOOPBACK, None)).await.is_err(), "the challenge hangs");
    drop(m);
    // The restart finds the attempt recorded: the backoff in force and the posted challenge counted, so
    // it does not order again at once.
    let m2 = CertManager::open_with(dir.clone(), &url, Arc::new(CertStore::new()));
    let st = m2.state();
    assert_eq!(st.backoff_step, 1);
    assert!(st.next_attempt_at >= t + BACKOFF_SECS[0] && st.next_attempt_at <= t + BACKOFF_SECS[0] + 10, "{}", st.next_attempt_at - t);
    assert_eq!(st.authz_failures.len(), 1, "a challenge posted and never seen through counts as a failed authorization");
    assert!(matches!(m2.plan(LOOPBACK, t + 60), Step::Wait(w) if w >= t + BACKOFF_SECS[0]), "{:?}", m2.plan(LOOPBACK, t + 60));
    // A crash before the challenge leaves the backoff only.
    let dir3 = tempdir();
    let mut m3 = ready_manager(dir3.clone(), "http://127.0.0.1:9/dir", Arc::new(CertStore::new()));
    let _ = m3.issue(LOOPBACK, None).await;
    let st3 = CertManager::open_with(dir3.clone(), "http://127.0.0.1:9/dir", Arc::new(CertStore::new())).state().clone();
    assert_eq!((st3.backoff_step, st3.authz_failures.len()), (1, 0), "an unreachable CA is one ordinary failure");
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(dir3);
}

/// The manager reopened from `dir` with a renewal due now (renewal information already polled).
fn renewal_due(dir: PathBuf, url: &str, certs: Arc<CertStore>) -> CertManager {
    let mut m = CertManager::open_with(dir, url, certs);
    let now = wallet_plane::unix_now();
    m.state.renew_at = Some(now);
    m.state.ari_next_poll = now + 3600;
    m
}

#[tokio::test]
async fn a_lost_account_key_does_not_stop_renewals() {
    let (plane, certs) = start_plane().await;
    let (ca, url) = start_ca(plane).await;
    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    let first = m.issue(LOOPBACK, None).await.expect("first issuance");
    let first_id = first.cert_id.clone().unwrap();
    let first_kid = std::fs::read_to_string(dir.join(ACCOUNT_URL_FILE)).unwrap();
    drop(m);

    // The account key is lost, its URL stays. A new key never signs under the old account's URL: a new
    // account is opened. Its renewal names a certificate another account ordered, which the CA refuses,
    // so the order goes again without the link instead of failing every renewal from now on.
    std::fs::remove_file(dir.join(ACCOUNT_KEY_FILE)).unwrap();
    let mut m = renewal_due(dir.clone(), &url, Arc::clone(&certs));
    assert_eq!(m.plan(LOOPBACK, wallet_plane::unix_now()), Step::Issue { replaces: Some(first_id.clone()) });
    let second = m.issue(LOOPBACK, Some(first_id.clone())).await.expect("renewed under a new account");
    let second_kid = std::fs::read_to_string(dir.join(ACCOUNT_URL_FILE)).unwrap();
    assert_ne!(second_kid, first_kid, "the new account's URL is kept");
    {
        let ca = ca.lock();
        assert_eq!(ca.seen.accounts_created, 2);
        assert_eq!(ca.seen.replaces, vec![None, Some(first_id.clone()), Some(first_id.clone()), None]);
    }
    assert_eq!(m.state().backoff_step, 0);
    drop(m);

    // The account URL is lost, the key stays: the key is registered again and its own account comes back.
    std::fs::remove_file(dir.join(ACCOUNT_URL_FILE)).unwrap();
    let mut m = renewal_due(dir.clone(), &url, Arc::clone(&certs));
    let second_id = second.cert_id.clone().unwrap();
    m.issue(LOOPBACK, Some(second_id.clone())).await.expect("renewed under the key's own account");
    assert_eq!(std::fs::read_to_string(dir.join(ACCOUNT_URL_FILE)).unwrap(), second_kid);
    assert_eq!(ca.lock().seen.accounts_created, 2, "no new account for a key that holds one");
    assert_eq!(ca.lock().seen.replaces.last(), Some(&Some(second_id)), "the same account's renewal keeps its link");
    drop(m);

    // A URL that is not this key's account (a file restored from elsewhere): registered again, once.
    std::fs::write(dir.join(ACCOUNT_URL_FILE), format!("{}/acct/999999", ca.lock().base)).unwrap();
    let mut m = renewal_due(dir.clone(), &url, Arc::clone(&certs));
    let third_id = m.facts().and_then(|f| f.cert_id.clone()).unwrap();
    m.issue(LOOPBACK, Some(third_id)).await.expect("the key's account found again");
    assert_eq!(std::fs::read_to_string(dir.join(ACCOUNT_URL_FILE)).unwrap(), second_kid);

    // A key file that does not decode is replaced, and its account URL with it.
    std::fs::write(dir.join(ACCOUNT_KEY_FILE), b"not a key").unwrap();
    let mut m = renewal_due(dir.clone(), &url, Arc::clone(&certs));
    let id = m.facts().and_then(|f| f.cert_id.clone()).unwrap();
    m.issue(LOOPBACK, Some(id)).await.expect("renewed under a fresh account");
    assert_eq!(ca.lock().seen.accounts_created, 3);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_held_certificate_is_served_only_with_its_own_key() {
    let (plane, certs) = start_plane().await;
    let (_ca, url) = start_ca(plane).await;
    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    let issued = m.issue(LOOPBACK, None).await.expect("issuance");
    drop(m);
    let fresh = CertManager::open_with(dir.clone(), &url, Arc::new(CertStore::new()));
    assert_eq!(fresh.facts(), Some(&issued), "a matching pair is loaded");
    // A crash between the two writes leaves a new key beside the old chain: not served, not held.
    let (_, other_key, _) = csr_for(LOOPBACK).unwrap();
    write_private(&dir, CERT_KEY_FILE, &other_key).unwrap();
    let store = Arc::new(CertStore::new());
    let m = CertManager::open_with(dir.clone(), &url, Arc::clone(&store));
    assert_eq!(store.valid_ip(wallet_plane::unix_now()), None);
    assert_eq!(m.facts(), None);
    assert!(matches!(m.plan(LOOPBACK, wallet_plane::unix_now()), Step::Precheck | Step::Issue { replaces: None }),
            "the next order starts from no certificate: {:?}", m.plan(LOOPBACK, wallet_plane::unix_now()));
    let _ = std::fs::remove_dir_all(dir);
}

// ─── The schedule (time injected) ───────────────────────────────────────────────────────────────

fn facts(nb: u64, na: u64, id: Option<&str>) -> CertFacts {
    CertFacts { ip: LOOPBACK, not_before: nb, not_after: na, cert_id: id.map(str::to_string) }
}

#[test]
fn acme_backoff_respects_ca_limits() {
    let mut rng = rand::thread_rng();
    let t0 = 1_800_000_000u64;
    let mut st = TlsState::default();
    // Boot: no probe yet, so the first thing is the probe; a negative one waits 6 h, give or take an hour.
    assert_eq!(st.plan(None, LOOPBACK, t0), Step::Precheck);
    let wait = st.on_precheck(false, t0, &mut rng);
    assert!((PRECHECK_RETRY_SECS - PRECHECK_RETRY_JITTER_SECS..=PRECHECK_RETRY_SECS + PRECHECK_RETRY_JITTER_SECS).contains(&wait));
    assert_eq!(st.plan(None, LOOPBACK, t0 + 60), Step::Wait(t0 + wait));
    let waits: HashSet<u64> = (0..50).map(|_| TlsState::default().on_precheck(false, t0, &mut rng)).collect();
    assert!(waits.len() > 1, "the 6 h retry is spread, not one instant for every node");
    // A positive one draws the first-order delay, once, within 0-6 h.
    st.on_precheck(true, t0 + PRECHECK_RETRY_SECS, &mut rng);
    let first = st.first_order_not_before.unwrap();
    assert!(first >= t0 + PRECHECK_RETRY_SECS && first <= t0 + PRECHECK_RETRY_SECS + FIRST_ORDER_JITTER_SECS);
    st.on_precheck(true, t0 + PRECHECK_RETRY_SECS + 10, &mut rng);
    assert_eq!(st.first_order_not_before, Some(first), "drawn once");
    // While the first-order delay runs nothing re-probes; once it is over, one fresh probe, then the order.
    let mut s = TlsState { precheck_ok_at: Some(t0), first_order_not_before: Some(t0 + 5 * 3600), ..Default::default() };
    for t in [t0 + 2 * 3600, t0 + 4 * 3600, t0 + 5 * 3600 - 1] {
        assert_eq!(s.plan(None, LOOPBACK, t), Step::Wait(t0 + 5 * 3600), "no probe at {}", t - t0);
    }
    assert_eq!(s.plan(None, LOOPBACK, t0 + 5 * 3600), Step::Precheck, "a fresh probe right before the first order");
    s.on_precheck(true, t0 + 5 * 3600, &mut rng);
    assert_eq!(s.plan(None, LOOPBACK, t0 + 5 * 3600 + 1), Step::Issue { replaces: None });
    // Genesis busy or unreachable: no verdict, so a short random wait that grows, never a 6 h refusal
    // nor permission to order; a verdict resets it.
    let mut s = TlsState::default();
    for step in [600u64, 1800, 7200, 21_600, 21_600] {
        let w = s.on_precheck_busy(t0, &mut rng);
        assert!(w >= step / 2 && w <= step, "{} within {}", w, step);
        assert_eq!(s.plan(None, LOOPBACK, t0 + 1), Step::Wait(t0 + w));
    }
    s.on_precheck(false, t0, &mut rng);
    assert_eq!(s.precheck_busy_step, 0);
    let w = s.on_precheck_busy(t0, &mut rng);
    assert!(w <= PRECHECK_BUSY_SECS[0]);
    // The ladder: 15 min, 1 h, 6 h, 24 h, then 24 h; never shorter than the CA's Retry-After.
    let err = |fault: Fault, retry: Option<u64>| AcmeError { stage: Stage::Order, fault, retry_after: retry };
    let mut s = TlsState::default();
    let mut waits = Vec::new();
    for _ in 0..6 {
        waits.push(s.on_failure(&err(Fault::Transport("x".into()), None), t0));
    }
    assert_eq!(waits, vec![900, 3600, 21_600, 86_400, 86_400, 86_400]);
    let mut s = TlsState::default();
    assert_eq!(s.on_failure(&err(Fault::RateLimited, Some(7200)), t0), 7200);
    assert_eq!(s.on_failure(&err(Fault::Unavailable, Some(10)), t0), 3600);
    let mut s = TlsState::default();
    assert_eq!(s.on_failure(&err(Fault::Paused(None), None), t0), 86_400, "a pause backs off a day at once");
    let mut s = TlsState::default();
    assert_eq!(s.on_failure(&err(Fault::ProfileUnavailable, None), t0), 86_400);
    // At most 3 failed authorizations per identifier per rolling hour, whatever the backoff says.
    let mut s = TlsState { precheck_ok_at: Some(t0), issued_ever: true, ..Default::default() };
    for i in 0..3 {
        s.on_failure(&err(Fault::AuthorizationInvalid("x".into()), None), t0 + i * 60);
        s.precheck_ok_at = Some(t0 + i * 60);
        s.next_attempt_at = 0;
    }
    assert_eq!(s.plan(None, LOOPBACK, t0 + 200), Step::Wait(t0 + 3600), "the third failure blocks until the first ages out");
    assert!(matches!(s.plan(None, LOOPBACK, t0 + 3601), Step::Precheck | Step::Issue { .. }));
    // An IP change after a first certificate orders at once (no first-order delay), still probed first.
    let mut s = TlsState { issued_ever: true, first_order_not_before: Some(t0 + 99_999), ..Default::default() };
    s.on_precheck(true, t0, &mut rng);
    assert_eq!(s.plan(Some(&facts(t0, t0 + 576_000, Some("a.b"))), "203.0.113.1".parse().unwrap(), t0), Step::Issue { replaces: None },
               "a certificate for another IP is no replacement");
    // An expired certificate for the same IP is still what the new order replaces.
    let mut s = TlsState { issued_ever: true, ..Default::default() };
    s.on_precheck(true, t0 + 600_000, &mut rng);
    assert_eq!(s.plan(Some(&facts(t0, t0 + 576_000, Some("a.b"))), LOOPBACK, t0 + 600_000), Step::Issue { replaces: Some("a.b".into()) });
    // A garbled state file never blocks boot: the manager opens with the default schedule.
    let dir = tempdir();
    std::fs::write(dir.join(STATE_FILE), b"{not json").unwrap();
    let m = CertManager::open_with(dir.clone(), "http://127.0.0.1:9/dir", Arc::new(CertStore::new()));
    assert_eq!(m.state(), &TlsState::default());
    // The schedule survives a restart.
    let mut m = CertManager::open_with(dir.clone(), "http://127.0.0.1:9/dir", Arc::new(CertStore::new()));
    let wait = m.on_precheck(false, t0);
    let reopened = CertManager::open_with(dir.clone(), "http://127.0.0.1:9/dir", Arc::new(CertStore::new()));
    assert_eq!(reopened.state().precheck_next, t0 + wait);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn renewal_follows_the_window_or_half_the_lifetime() {
    let mut rng = rand::thread_rng();
    let nb = 1_800_000_000u64;
    let na = nb + 160 * 3600;
    let f = facts(nb, na, Some("k.s"));
    let mut st = TlsState::default();
    st.on_issued(&f, nb, &mut rng);
    // Until renewal information answers: half the lifetime, +- 1 h; renewal information polled at once.
    let half = nb + 80 * 3600;
    let r = st.renew_at.unwrap();
    assert!(r >= half - 3600 && r <= half + 3600);
    assert_eq!(st.plan(Some(&f), LOOPBACK, nb), Step::PollRenewalInfo);
    // A window: uniform inside it, polled again per Retry-After clamped to 1-12 h.
    let w = (nb + 78 * 3600, nb + 82 * 3600);
    let mut seen = std::collections::BTreeSet::new();
    for i in 0..64 {
        let mut s = st.clone();
        s.ari_window = None;
        s.on_renewal_info(Some(w), Some(30 * 3600), nb + i, &mut rng);
        let r = s.renew_at.unwrap();
        assert!(r >= w.0 && r <= w.1, "{} in {:?}", r, w);
        seen.insert(r);
        assert_eq!(s.ari_next_poll, nb + i + ARI_POLL_MAX_SECS);
    }
    assert!(seen.len() > 32, "spread over the window");
    let mut s = st.clone();
    s.on_renewal_info(Some(w), Some(600), nb, &mut rng);
    assert_eq!(s.ari_next_poll, nb + ARI_POLL_MIN_SECS);
    let kept = s.renew_at;
    s.on_renewal_info(Some(w), None, nb + 3600, &mut rng);
    assert_eq!(s.renew_at, kept, "the same window keeps its drawn time");
    assert_eq!(s.plan(Some(&f), LOOPBACK, nb + 3601), Step::Wait(kept.unwrap().min(s.ari_next_poll)));
    // A window in the past (the CA's incident signal): renew now.
    s.on_renewal_info(Some((nb, nb + 10)), None, nb + 7200, &mut rng);
    assert_eq!(s.renew_at, Some(nb + 7200));
    assert_eq!(s.plan(Some(&f), LOOPBACK, nb + 7200), Step::Issue { replaces: Some("k.s".into()) });
    // A renewal whose validation failed (443 no longer reaches the node: an opt-out, a firewall) is
    // not retried blind: each later renewal waits for a fresh positive probe, and a negative one means
    // no order for about 6 h, the opted-out node's steady state.
    let err = AcmeError { stage: Stage::Challenge, fault: Fault::AuthorizationInvalid("x".into()), retry_after: None };
    let pf = facts(nb, na, None);
    let mut r = TlsState::default();
    r.on_issued(&pf, nb, &mut rng);
    let due = r.renew_at.unwrap();
    assert_eq!(r.plan(Some(&pf), LOOPBACK, due), Step::Issue { replaces: None }, "an ordinary renewal is not probed first");
    let wait = r.on_failure(&err, due);
    assert!(r.probe_before_renewal);
    let after = due + wait;
    assert_eq!(r.plan(Some(&pf), LOOPBACK, after), Step::Precheck, "a probe before the next renewal order");
    let neg = r.on_precheck(false, after, &mut rng);
    for t in [after + 1, after + neg - 1] {
        assert_eq!(r.plan(Some(&pf), LOOPBACK, t), Step::Wait(after + neg), "no order while 443 is unreachable");
    }
    assert_eq!(r.plan(Some(&pf), LOOPBACK, after + neg), Step::Precheck);
    r.on_precheck(true, after + neg, &mut rng);
    assert_eq!(r.plan(Some(&pf), LOOPBACK, after + neg + 1), Step::Issue { replaces: None }, "reachable again: renew");
    r.on_issued(&pf, after + neg + 2, &mut rng);
    assert!(!r.probe_before_renewal, "a success renews unprobed again");
    // An attempt cut short after its challenge was armed counts as that failure too.
    let mut cut = s.clone();
    cut.record_authorization_failure(nb + 7200);
    assert!(cut.probe_before_renewal && cut.precheck_ok_at.is_none() && cut.authz_failures.contains(&(nb + 7200)));
    // Unreachable: keep the half-life plan, ask again in an hour.
    let mut u = st.clone();
    u.on_renewal_info(None, None, nb, &mut rng);
    assert_eq!((u.renew_at, u.ari_next_poll), (st.renew_at, nb + ARI_POLL_MIN_SECS));
    // A certificate without an issuer key id renews at half its lifetime without polling.
    let plain = facts(nb, na, None);
    let mut p = TlsState::default();
    p.on_issued(&plain, nb, &mut rng);
    assert!(matches!(p.plan(Some(&plain), LOOPBACK, nb + 10), Step::Wait(t) if t == p.renew_at.unwrap()));
}

// ─── Wire pieces ────────────────────────────────────────────────────────────────────────────────

#[test]
fn csr_names_only_the_ip_with_a_fresh_key() {
    let (csr, key, raw) = csr_for(Ipv4Addr::new(203, 0, 113, 7)).unwrap();
    let (_, req) = x509_parser::certification_request::X509CertificationRequest::from_der(&csr).unwrap();
    assert_eq!(req.certification_request_info.subject.iter().count(), 0, "no common name: an IP CN is refused, any other one becomes an identifier");
    assert_eq!(req.certification_request_info.subject_pki.subject_public_key.data.as_ref(), raw.as_slice());
    let names: Vec<String> = req.requested_extensions().into_iter().flatten().filter_map(|e| match e {
        x509_parser::extensions::ParsedExtension::SubjectAlternativeName(s) => Some(format!("{:?}", s.general_names)),
        _ => None,
    }).collect();
    assert_eq!(names.len(), 1);
    assert!(names[0].contains("IPAddress([203, 0, 113, 7])") && !names[0].contains("DNSName"), "{}", names[0]);
    assert!(req.signature_algorithm.algorithm.to_id_string() == "1.2.840.10045.4.3.2", "ECDSA with SHA-256");
    let (_, _, raw2) = csr_for(Ipv4Addr::new(203, 0, 113, 7)).unwrap();
    assert_ne!(raw, raw2, "a fresh key each time");
    let account = AccountKey::generate().unwrap();
    assert_ne!(account.pair.public_key().as_ref(), raw.as_slice(), "never the account key");
    assert!(!key.is_empty());
}

#[test]
fn chain_checks_before_the_swap() {
    let (iss, iss_der) = issuer();
    let (_, _, pk) = csr_for(LOOPBACK).unwrap();
    let now = wallet_plane::unix_now() as i64;
    let chain = |der: Vec<u8>| format!("{}{}", pem(&der), pem(&iss_der));
    let ip = rcgen::SanType::IpAddress(IpAddr::V4(LOOPBACK));
    let good = chain(leaf(&iss, &pk, vec![ip.clone()], true, now - 60, now + 3600));
    let (served, f) = verify_chain(&good, &pk, LOOPBACK, now as u64).expect("a good chain");
    assert_eq!(served.len(), 2, "served exactly as downloaded");
    assert!(f.cert_id.as_deref().map_or(false, |id| id.contains('.')));
    let (_, _, other_pk) = csr_for(LOOPBACK).unwrap();
    assert_eq!(verify_chain(&good, &other_pk, LOOPBACK, now as u64).unwrap_err(), "leaf_key_mismatch");
    assert_eq!(verify_chain(&good, &pk, Ipv4Addr::new(127, 0, 0, 2), now as u64).unwrap_err(), "san_not_exactly_ip");
    let two = chain(leaf(&iss, &pk, vec![ip.clone(), rcgen::SanType::IpAddress(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)))], true, now - 60, now + 3600));
    assert_eq!(verify_chain(&two, &pk, LOOPBACK, now as u64).unwrap_err(), "san_not_exactly_ip");
    let dns = chain(leaf(&iss, &pk, vec![ip.clone(), rcgen::SanType::DnsName("x.test".into())], true, now - 60, now + 3600));
    assert_eq!(verify_chain(&dns, &pk, LOOPBACK, now as u64).unwrap_err(), "san_not_exactly_ip");
    let client_only = chain(leaf(&iss, &pk, vec![ip.clone()], false, now - 60, now + 3600));
    assert_eq!(verify_chain(&client_only, &pk, LOOPBACK, now as u64).unwrap_err(), "no_server_auth");
    let expired = chain(leaf(&iss, &pk, vec![ip.clone()], true, now - 7200, now - 60));
    assert_eq!(verify_chain(&expired, &pk, LOOPBACK, now as u64).unwrap_err(), "not_valid_now");
    let early = chain(leaf(&iss, &pk, vec![ip.clone()], true, now + 600, now + 7200));
    assert_eq!(verify_chain(&early, &pk, LOOPBACK, now as u64).unwrap_err(), "not_valid_now");
    let broken = format!("{}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", pem(&leaf(&iss, &pk, vec![ip], true, now - 60, now + 3600)));
    assert!(verify_chain(&broken, &pk, LOOPBACK, now as u64).unwrap_err().starts_with("chain_parse"));
    assert!(pem_certificates("junk\n").is_err());
    assert!(pem_certificates("").is_err());
    assert!(pem_certificates("-----BEGIN CERTIFICATE-----\nAAAA\n").is_err());
}

#[test]
fn problems_map_to_typed_faults() {
    let reply = |status: u16, kind: &str, detail: &str, retry: Option<u64>, links: Vec<(String, String)>| Reply {
        status, location: None, retry_after: retry, links,
        body: json!({ "type": format!("{}{}", ERR_PREFIX, kind), "detail": detail }).to_string().into_bytes(),
    };
    assert_eq!(problem(Stage::Order, &reply(400, "badNonce", "", None, vec![])).fault, Fault::BadNonce);
    let rl = problem(Stage::Order, &reply(429, "rateLimited", "too many", Some(90), vec![]));
    assert_eq!((rl.fault, rl.retry_after), (Fault::RateLimited, Some(90)));
    assert_eq!(problem(Stage::Order, &reply(429, "rateLimited", "Account paused, see https://ca.test/u?x=1.", None, vec![])).fault,
               Fault::Paused(Some("https://ca.test/u?x=1".into())));
    assert_eq!(problem(Stage::Order, &reply(409, "alreadyReplaced", "", None, vec![])).fault, Fault::AlreadyReplaced);
    assert_eq!(problem(Stage::Order, &reply(403, "userActionRequired", "", None, vec![("terms-of-service".into(), "https://ca.test/t".into())])).fault,
               Fault::TermsChanged(Some("https://ca.test/t".into())));
    assert_eq!(problem(Stage::Order, &reply(503, "serverInternal", "", Some(5), vec![])).fault, Fault::Unavailable);
    assert_eq!(problem(Stage::Order, &reply(400, "rejectedIdentifier", "", None, vec![])).fault, Fault::Rejected("rejectedIdentifier".into()));
    assert_eq!(parse_retry_after("120", 0), Some(120));
    assert_eq!(parse_retry_after("Thu, 01 Jan 1970 00:02:00 GMT", 60), Some(60));
    assert_eq!(parse_retry_after("soon", 0), None);
}

#[test]
fn thumbprint_and_key_authorization_are_canonical() {
    let k = AccountKey::generate().unwrap();
    let (x, y) = k.xy();
    use sha2::Digest as _;
    let manual = B64URL.encode(sha2::Sha256::digest(format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, x, y)));
    assert_eq!(k.thumbprint(), manual);
    let d = key_authorization_digest("tok", &manual);
    assert_eq!(d.to_vec(), sha2::Sha256::digest(format!("tok.{}", manual).as_bytes()).to_vec());
    // The key round-trips through its file form.
    let again = AccountKey::from_pkcs8(&k.pkcs8).unwrap();
    assert_eq!(again.thumbprint(), k.thumbprint());
    // The production directory and the profile are compiled constants.
    assert!(ACME_DIRECTORY_URL.starts_with("https://") && ACME_DIRECTORY_URL.ends_with("/directory"));
    assert_eq!(PROFILE, "shortlived");
}

#[cfg(unix)]
#[test]
fn key_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().join("wallet_tls");
    ensure_private_dir(&dir).unwrap();
    write_private(&dir, "k", b"secret").unwrap();
    std::fs::set_permissions(dir.join("k"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    ensure_private_dir(&dir).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(dir.join("k")).unwrap().permissions().mode() & 0o777, 0o600);
}

// ─── A real CA, run by hand (spec §12.3) ────────────────────────────────────────────────────────

/// Issuance against a real ACME directory from a host with a public IPv4 whose TCP 443 reaches this
/// process (bind 443 directly, or 8443 with host 443 forwarded to it). Never on a genesis host or the
/// explorer host. The directory is given at run time, staging first, then one production issuance:
///
/// ```text
/// QNET_TEST_ACME_DIRECTORY=<directory URL> QNET_TEST_PUBLIC_IP=<a.b.c.d> \
///   [QNET_TEST_PLANE_BIND=0.0.0.0:8443] [QNET_TEST_ACME_TRUSTED=1] \
///   cargo test -p qnet-integration --lib -- --ignored --nocapture real_ca_issues_for_this_hosts_ip
/// ```
///
/// Staging: issuance, renewal information, then a renewal that names the certificate it replaces.
/// Production (`QNET_TEST_ACME_TRUSTED=1`): one issuance, renewal information, then
/// `https://<ip>/healthz` through the public root store by IP literal, as a wallet connects.
#[tokio::test]
#[ignore]
async fn real_ca_issues_for_this_hosts_ip() {
    let url = std::env::var("QNET_TEST_ACME_DIRECTORY").expect("QNET_TEST_ACME_DIRECTORY: the directory URL");
    let ip: Ipv4Addr = std::env::var("QNET_TEST_PUBLIC_IP").expect("QNET_TEST_PUBLIC_IP: this host's public IPv4")
        .parse().expect("an IPv4 address");
    assert!(super::super::node_serve::is_public_unicast_v4(ip), "{} is not a public unicast address", ip);
    let bind = std::env::var("QNET_TEST_PLANE_BIND").unwrap_or_else(|_| format!("0.0.0.0:{}", wallet_plane::WALLET_PLANE_PORT));
    let trusted = std::env::var("QNET_TEST_ACME_TRUSTED").map_or(false, |v| v == "1");

    let certs = Arc::new(CertStore::new());
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {}: {}", bind, e));
    let routes: PlaneRoutes = warp::path("healthz").map(|| warp::Reply::into_response("ok h=1")).boxed();
    let ctx = PlaneCtx::new(routes, server_config(Arc::clone(&certs) as Arc<dyn rustls::server::ResolvesServerCert>).unwrap(),
                            Limits::production(), EgressBudget::new(1e9, 1e9));
    tokio::spawn(serve(listener, ctx));

    let dir = tempdir();
    let mut m = ready_manager(dir.clone(), &url, Arc::clone(&certs));
    let fail = |e: AcmeError| format!("stage={} reason={} retry_after={:?}", e.stage.name(), e.fault.reason(), e.retry_after);
    let first = m.issue(ip, None).await.unwrap_or_else(|e| panic!("issuance: {}", fail(e)));
    let now = wallet_plane::unix_now();
    assert_eq!(first.ip, ip);
    assert!(first.not_before <= now && now < first.not_after);
    let lifetime_h = (first.not_after - first.not_before) / 3600;
    assert!((100..=7 * 24).contains(&lifetime_h), "a short-lived certificate, got {} h", lifetime_h);
    let first_id = first.cert_id.clone().expect("the leaf names its issuer's key");
    let pem = std::fs::read_to_string(dir.join(CERT_FILE)).unwrap();
    let chain_len = pem_certificates(&pem).unwrap().len();
    assert!(chain_len >= 2, "the chain as downloaded, leaf first, got {} certificate(s)", chain_len);
    assert_eq!(certs.valid_ip(now), Some(ip), "installed into the resolver");
    println!("real_ca issued ip={} lifetime_h={} chain_len={} cert_id={}", ip, lifetime_h, chain_len, first_id);

    m.poll_renewal_info(now).await;
    let (start, end) = m.state().ari_window.expect("the CA answers renewal information");
    assert!(first.not_before < start && start <= end && end < first.not_after, "the window lies inside the lifetime");
    println!("real_ca renewal_window start={} end={} renew_at={:?}", start, end, m.state().renew_at);

    if trusted {
        let client = reqwest::Client::builder().use_rustls_tls().timeout(Duration::from_secs(10)).build().unwrap();
        let body = client.get(format!("https://{}/healthz", ip)).send().await
            .expect("the public root store accepts the chain for the IP literal")
            .text().await.unwrap();
        assert_eq!(body, "ok h=1");
        println!("real_ca wallet_fetch ok");
    } else {
        let second = m.issue(ip, Some(first_id.clone())).await.unwrap_or_else(|e| panic!("renewal: {}", fail(e)));
        assert_ne!(second.cert_id, Some(first_id), "a new certificate");
        assert_eq!(certs.valid_ip(wallet_plane::unix_now()), Some(ip));
        println!("real_ca renewed not_after={}", second.not_after);
    }
    let _ = std::fs::remove_dir_all(dir);
}

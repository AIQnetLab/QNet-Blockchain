//! The node's serving identity on the wallet plane, and the two discovery hints every node answers.
//!
//! - `GET /api/v1/node/serve-proof` (wallet plane only): the node's ServeCert, which its wallet key
//!   signed over a body the node composed, and a single-purpose serving key's signature over the
//!   client's fresh challenge, the cert hash and the node's IP. A client admits a node only on both.
//! - `GET /api/v1/nodes/rpc?ids=`: the committed `https://<IPv4>` endpoints of ids the client chose.
//!   A hint: the client trusts only the serve-proof the address then answers.
//! - `GET /api/v1/whoami[?probe=443&marker=]`: the caller's address as this node sees it, and whether
//!   host 443 at that address reaches the caller's own process. The connect-back goes only to the
//!   address this node's own socket gave it, never to one a header named, so no one can aim a node at
//!   a third party.
//!
//! The wallet key never signs anything a client chose: its one preimage here is the hash of a body
//! built from the node's own fields, under the kind `node_serve_cert`, which no transaction uses.

use super::*;
use super::wallet_plane::{plane_busy, plane_rate_limited, WalletPeer, WalletPlane, PLANE_STATS, PROBE_SUFFIX, WALLET_CERTS};
use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _, SecretKey as _};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;
use warp::http::StatusCode;
use zeroize::Zeroize;

pub(crate) const SERVE_CERT_VERSION: u8 = 1;
pub(crate) const MLDSA65_PK_BYTES: usize = 1952;
pub(crate) const MLDSA65_SK_BYTES: usize = 4032;
pub(crate) const MLDSA65_SIG_BYTES: usize = 3309;
/// A ServeCert lives at most 7 days and is re-issued every 72 h.
pub(crate) const SERVE_CERT_MAX_LIFETIME: u64 = 7 * 86_400;
pub(crate) const SERVE_CERT_REISSUE_SECS: u64 = 72 * 3600;
/// The serving key is replaced every 30 days.
pub(crate) const SERVE_KEY_ROTATE_SECS: u64 = 30 * 86_400;
pub(crate) const SERVE_PROOF_BUCKET: &str = "serve_proof";
pub(crate) const NODES_RPC_BUCKET: &str = "nodes_rpc";
pub(crate) const WHOAMI_BUCKET: &str = "whoami";
/// Node-wide serving signatures per second (ML-DSA-65 signing is ~0.5 ms: at most ~1% of a core).
const SERVE_SIGS_PER_SEC: u32 = 20;
/// Node-wide 443 probes per second.
const PROBES_PER_SEC: u32 = 20;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const NODES_RPC_MAX_IDS: usize = 64;
const SERVE_KEY_FILE: &str = "serve.key";
const SERVE_CERT_FILE: &str = "serve_cert.bin";
const SERVE_KEY_MAGIC: &[u8; 4] = b"QNSK";
pub(crate) const KIND_SERVE_CERT: &str = "node_serve_cert:";
pub(crate) const KIND_SERVE_PROOF: &str = "node_serve_proof:";

// ─── ServeCert ──────────────────────────────────────────────────────────────────────────────────

/// ServeCert v1: the wallet's delegation of a serving key, at one IP, for at most 7 days.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServeCert {
    pub(crate) node_id: String,
    pub(crate) wallet: String,
    pub(crate) ip: Ipv4Addr,
    pub(crate) issued_at: u64,
    pub(crate) not_after: u64,
    pub(crate) seq: u64,
    pub(crate) serve_pk: Vec<u8>,
    pub(crate) wallet_pk: Vec<u8>,
}

impl ServeCert {
    /// The canonical body (little-endian): version u8; node_id and wallet as u8 length + ASCII; the IP
    /// as 16 bytes (IPv4-mapped IPv6); issued_at, not_after, seq as u64; serve_pk; wallet_pk.
    pub(crate) fn encode_body(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(4100);
        b.push(SERVE_CERT_VERSION);
        b.push(self.node_id.len() as u8);
        b.extend_from_slice(self.node_id.as_bytes());
        b.push(self.wallet.len() as u8);
        b.extend_from_slice(self.wallet.as_bytes());
        b.extend_from_slice(&self.ip.to_ipv6_mapped().octets());
        b.extend_from_slice(&self.issued_at.to_le_bytes());
        b.extend_from_slice(&self.not_after.to_le_bytes());
        b.extend_from_slice(&self.seq.to_le_bytes());
        b.extend_from_slice(&self.serve_pk);
        b.extend_from_slice(&self.wallet_pk);
        b
    }

    /// Strict decode: version 1, printable ASCII names (node_id at most 64, wallet 45), an
    /// IPv4-mapped address, a lifetime of at most 7 days, `seq == issued_at`, exact length.
    pub(crate) fn decode_body(b: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader { b, at: 0 };
        if r.take(1)?[0] != SERVE_CERT_VERSION {
            return Err("version");
        }
        let node_id = r.name(64)?;
        let wallet = r.name(45)?;
        if wallet.len() != 45 {
            return Err("wallet_length");
        }
        let ip = std::net::Ipv6Addr::from(<[u8; 16]>::try_from(r.take(16)?).map_err(|_| "ip")?)
            .to_ipv4_mapped().ok_or("ip_not_ipv4")?;
        let issued_at = r.u64()?;
        let not_after = r.u64()?;
        let seq = r.u64()?;
        let serve_pk = r.take(MLDSA65_PK_BYTES)?.to_vec();
        let wallet_pk = r.take(MLDSA65_PK_BYTES)?.to_vec();
        if r.at != b.len() {
            return Err("trailing_bytes");
        }
        if not_after <= issued_at || not_after - issued_at > SERVE_CERT_MAX_LIFETIME {
            return Err("lifetime");
        }
        if seq != issued_at {
            return Err("seq");
        }
        Ok(Self { node_id, wallet, ip, issued_at, not_after, seq, serve_pk, wallet_pk })
    }
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.at.checked_add(n).ok_or("length")?;
        let s = self.b.get(self.at..end).ok_or("truncated")?;
        self.at = end;
        Ok(s)
    }
    fn u64(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "u64")?))
    }
    fn name(&mut self, max: usize) -> Result<String, &'static str> {
        let n = self.take(1)?[0] as usize;
        if n == 0 || n > max {
            return Err("name_length");
        }
        let s = self.take(n)?;
        if !s.iter().all(|c| c.is_ascii_graphic()) {
            return Err("name_chars");
        }
        Ok(String::from_utf8_lossy(s).into_owned())
    }
}

pub(crate) fn cert_hash(body: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha3_256::digest(body));
    out
}

/// What the wallet key signs: the chain tag, the kind `node_serve_cert:` and the hex of the body's
/// hash. The body is the node's own, so the wallet key is never a signing oracle.
pub(crate) fn serve_cert_preimage(hash: &[u8; 32]) -> String {
    format!("{}{}{}", qnet_state::transaction::chain_tag(), KIND_SERVE_CERT, hex::encode(hash))
}

/// What the serving key signs for a client: the chain tag, `node_serve_proof:`, the client's
/// challenge, the cert hash and the IP in dotted form.
pub(crate) fn serve_proof_preimage(challenge: &str, hash: &[u8; 32], ip: Ipv4Addr) -> String {
    format!("{}{}{}:{}:{}", qnet_state::transaction::chain_tag(), KIND_SERVE_PROOF, challenge, hex::encode(hash), ip)
}

fn mldsa_sign(sk: &[u8], msg: &[u8]) -> Result<Vec<u8>, String> {
    let mut key = pqcrypto_mldsa::mldsa65::SecretKey::from_bytes(sk).map_err(|e| format!("sk: {:?}", e))?;
    let sig = pqcrypto_mldsa::mldsa65::detached_sign(msg, &key).as_bytes().to_vec();
    wipe_secret_key(&mut key);
    Ok(sig)
}

/// Overwrite the signing library's copy of a secret key, which has no wipe of its own.
pub(crate) fn wipe_secret_key(key: &mut pqcrypto_mldsa::mldsa65::SecretKey) {
    // SAFETY: the type is one `[u8; N]` field (no padding, alignment 1), so these bytes are all of it
    // and all-zero is a valid value of it; `key` is borrowed mutably, so nothing else reads it meanwhile.
    let bytes = unsafe { std::slice::from_raw_parts_mut(key as *mut _ as *mut u8, std::mem::size_of_val(key)) };
    bytes.zeroize();
}

fn mldsa_verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (pqcrypto_mldsa::mldsa65::PublicKey::from_bytes(pk), pqcrypto_mldsa::mldsa65::DetachedSignature::from_bytes(sig)) else {
        return false;
    };
    pqcrypto_mldsa::mldsa65::verify_detached_signature(&sig, msg, &pk).is_ok()
}

/// The wallet's signature over a node-composed ServeCert.
pub(crate) fn sign_serve_cert(cert: &ServeCert, wallet_sk: &[u8]) -> Result<Vec<u8>, String> {
    mldsa_sign(wallet_sk, serve_cert_preimage(&cert_hash(&cert.encode_body())).as_bytes())
}

/// Everything a client checks about a ServeCert it was handed as `body ‖ wallet signature`: the
/// strict body, its lifetime around `now` (an hour of clock slack before issue), the wallet deriving
/// from its key, the node id being that wallet's pseudonym, and the wallet's signature.
pub(crate) fn verify_serve_cert(wire: &[u8], now: u64) -> Result<(ServeCert, [u8; 32]), &'static str> {
    if wire.len() <= MLDSA65_SIG_BYTES {
        return Err("short");
    }
    let (body, sig) = wire.split_at(wire.len() - MLDSA65_SIG_BYTES);
    let cert = ServeCert::decode_body(body)?;
    if now + 3600 < cert.issued_at || now > cert.not_after {
        return Err("not_current");
    }
    if crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&cert.wallet_pk).as_deref() != Some(cert.wallet.as_str()) {
        return Err("wallet_key");
    }
    if generate_super_node_pseudonym(&cert.wallet) != cert.node_id {
        return Err("pseudonym");
    }
    let hash = cert_hash(body);
    if !mldsa_verify(&cert.wallet_pk, serve_cert_preimage(&hash).as_bytes(), sig) {
        return Err("wallet_signature");
    }
    Ok((cert, hash))
}

/// The serving key's answer to a challenge, as a client checks it (the clients' reference; the node
/// itself never verifies one).
#[cfg(test)]
pub(crate) fn verify_serve_proof(cert: &ServeCert, hash: &[u8; 32], challenge: &str, sig: &[u8]) -> bool {
    mldsa_verify(&cert.serve_pk, serve_proof_preimage(challenge, hash, cert.ip).as_bytes(), sig)
}

// ─── Serving key and the node's ServeCert ───────────────────────────────────────────────────────

/// The single-purpose ML-DSA-65 key that answers client challenges. Random, node-local, rotated
/// every 30 days; it guards no money and no consensus role.
pub(crate) struct ServingKey {
    pub(crate) created_at: u64,
    pub(crate) pk: Vec<u8>,
    sk: Vec<u8>,
}

impl Drop for ServingKey {
    fn drop(&mut self) {
        self.sk.zeroize();
    }
}

impl ServingKey {
    pub(crate) fn generate(now: u64) -> Self {
        let (pk, sk) = pqcrypto_mldsa::mldsa65::keypair();
        Self { created_at: now, pk: pk.as_bytes().to_vec(), sk: sk.as_bytes().to_vec() }
    }

    pub(crate) fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        mldsa_sign(&self.sk, msg)
    }

    fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(13 + MLDSA65_PK_BYTES + MLDSA65_SK_BYTES);
        b.extend_from_slice(SERVE_KEY_MAGIC);
        b.push(1);
        b.extend_from_slice(&self.created_at.to_le_bytes());
        b.extend_from_slice(&self.pk);
        b.extend_from_slice(&self.sk);
        b
    }

    fn decode(b: &[u8]) -> Option<Self> {
        if b.len() != 13 + MLDSA65_PK_BYTES + MLDSA65_SK_BYTES || &b[..4] != SERVE_KEY_MAGIC || b[4] != 1 {
            return None;
        }
        let created_at = u64::from_le_bytes(b[5..13].try_into().ok()?);
        let pk = b[13..13 + MLDSA65_PK_BYTES].to_vec();
        let sk = b[13 + MLDSA65_PK_BYTES..].to_vec();
        Some(Self { created_at, pk, sk })
    }

    /// The held key, or a new one when none is held or it is due for rotation.
    pub(crate) fn load_or_rotate(dir: &Path, now: u64) -> Arc<Self> {
        if let Some(k) = std::fs::read(dir.join(SERVE_KEY_FILE)).ok().and_then(|b| Self::decode(&b)) {
            if now < k.created_at.saturating_add(SERVE_KEY_ROTATE_SECS) {
                return Arc::new(k);
            }
        }
        let k = Self::generate(now);
        if let Err(e) = super::acme::write_private(dir, SERVE_KEY_FILE, &k.encode()) {
            if is_warn() {
                println!("[WARN][WALLETRPC] serve_key_save_failed err={}", e);
            }
        }
        if is_info() {
            println!("[INFO][WALLETRPC] serve_key_rotated pk_hash={}", hex::encode(&Sha3_256::digest(&k.pk)[..8]));
        }
        Arc::new(k)
    }
}

/// The node's current ServeCert with its wallet signature.
#[derive(Clone)]
pub(crate) struct SignedServeCert {
    pub(crate) cert: ServeCert,
    pub(crate) body: Vec<u8>,
    pub(crate) wallet_sig: Vec<u8>,
    pub(crate) hash: [u8; 32],
}

impl SignedServeCert {
    pub(crate) fn wire(&self) -> Vec<u8> {
        let mut w = self.body.clone();
        w.extend_from_slice(&self.wallet_sig);
        w
    }
}

/// Compose and sign this node's ServeCert. The wallet key is derived from the mounted phrase for this
/// one signature and wiped; a phrase whose wallet does not own `node_id` signs nothing.
pub(crate) fn issue_serve_cert(node_id: &str, ip: Ipv4Addr, key: &ServingKey, mnemonic: &str, issued_at: u64) -> Result<SignedServeCert, String> {
    let (wallet_pk, mut wallet_sk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(mnemonic);
    let signed = (|| -> Result<SignedServeCert, String> {
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&wallet_pk).ok_or("wallet_key_size")?;
        if generate_super_node_pseudonym(&wallet) != node_id {
            return Err("node_id_is_not_this_wallets_pseudonym".to_string());
        }
        let cert = ServeCert {
            node_id: node_id.to_string(), wallet, ip, issued_at, not_after: issued_at + SERVE_CERT_MAX_LIFETIME, seq: issued_at,
            serve_pk: key.pk.clone(), wallet_pk: wallet_pk.clone(),
        };
        let body = cert.encode_body();
        let wallet_sig = sign_serve_cert(&cert, &wallet_sk)?;
        Ok(SignedServeCert { hash: cert_hash(&body), cert, body, wallet_sig })
    })();
    wallet_sk.zeroize();
    signed
}

pub(crate) fn save_serve_cert(dir: &Path, c: &SignedServeCert) {
    if let Err(e) = super::acme::write_private(dir, SERVE_CERT_FILE, &c.wire()) {
        if is_warn() {
            println!("[WARN][WALLETRPC] serve_cert_save_failed err={}", e);
        }
    }
}

/// The held ServeCert, if it still verifies.
pub(crate) fn load_serve_cert(dir: &Path, now: u64) -> Option<SignedServeCert> {
    let wire = std::fs::read(dir.join(SERVE_CERT_FILE)).ok()?;
    let (cert, hash) = verify_serve_cert(&wire, now).ok()?;
    let split = wire.len() - MLDSA65_SIG_BYTES;
    Some(SignedServeCert { cert, body: wire[..split].to_vec(), wallet_sig: wire[split..].to_vec(), hash })
}

/// Whether the held ServeCert must be issued again: none, 72 h old, another IP, another serving key, or
/// another node (a data volume kept under a new phrase: clients would refuse the old node's cert).
pub(crate) fn serve_cert_due(held: Option<&SignedServeCert>, node_id: &str, ip: Ipv4Addr, key: &ServingKey, now: u64) -> bool {
    match held {
        None => true,
        Some(c) => c.cert.node_id != node_id || c.cert.ip != ip || c.cert.serve_pk != key.pk
            || now >= c.cert.issued_at + SERVE_CERT_REISSUE_SECS || now >= c.cert.not_after,
    }
}

/// What the serve-proof route can answer right now.
#[derive(Clone)]
pub(crate) enum ServeStatus {
    NoCertificate,
    NotRegistered,
    NoWalletKey,
    Ready { cert: SignedServeCert, key: Arc<ServingKey> },
}

/// Set by the public RPC task (node/public_rpc.rs), read by the route.
pub(crate) static SERVE_STATUS: Lazy<parking_lot::RwLock<ServeStatus>> = Lazy::new(|| parking_lot::RwLock::new(ServeStatus::NoCertificate));

pub(crate) fn set_serve_status(s: ServeStatus) {
    *SERVE_STATUS.write() = s;
}

// ─── Small node-wide gates ──────────────────────────────────────────────────────────────────────

/// A fixed one-second window: at most `per_sec` admissions in each.
pub(crate) struct PerSecond {
    per_sec: u32,
    window: parking_lot::Mutex<(u64, u32)>,
}

impl PerSecond {
    pub(crate) const fn new(per_sec: u32) -> Self {
        Self { per_sec, window: parking_lot::const_mutex((0, 0)) }
    }

    pub(crate) fn admit_at(&self, now_sec: u64) -> bool {
        let mut w = self.window.lock();
        if w.0 != now_sec {
            *w = (now_sec, 0);
        }
        if w.1 >= self.per_sec {
            return false;
        }
        w.1 += 1;
        true
    }

    pub(crate) fn admit(&self) -> bool {
        self.admit_at(wallet_plane::unix_now())
    }
}

static SERVE_SIGS: PerSecond = PerSecond::new(SERVE_SIGS_PER_SEC);
static PROBES: PerSecond = PerSecond::new(PROBES_PER_SEC);
static PROBES_INFLIGHT: Lazy<DashSet<IpAddr>> = Lazy::new(DashSet::new);

/// A caller's one probe slot. Freed on drop, so a request dropped mid-probe (its client went away)
/// does not lock that caller out of probes until the process restarts.
struct ProbeSlot(IpAddr);

impl ProbeSlot {
    fn take(caller: IpAddr) -> Option<Self> {
        // Lazily: a slot built for a refused caller would free the holder's entry when dropped.
        PROBES_INFLIGHT.insert(caller).then(|| Self(caller))
    }
}

impl Drop for ProbeSlot {
    fn drop(&mut self) {
        PROBES_INFLIGHT.remove(&self.0);
    }
}

// ─── Routes ─────────────────────────────────────────────────────────────────────────────────────

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `challenge` exactly once (64 lowercase hex), `have` at most once (64 lowercase hex), nothing else.
fn serve_query(query: &[(String, String)]) -> Result<(String, Option<String>), &'static str> {
    let (mut challenge, mut have) = (None, None);
    for (k, v) in query {
        let slot = match k.as_str() { "challenge" => &mut challenge, "have" => &mut have, _ => return Err("query") };
        if slot.is_some() || !is_lower_hex(v, 64) {
            return Err(if k == "have" { "have" } else { "challenge" });
        }
        *slot = Some(v.clone());
    }
    Ok((challenge.ok_or("challenge")?, have))
}

fn serve_unavailable(reason: &str, retry: u64) -> warp::reply::Response {
    error_response(StatusCode::SERVICE_UNAVAILABLE, "serve_unavailable", fields(&[("reason", json!(reason))]), Some(retry))
}

/// The serve-proof answer, given the route's checks passed: the status, the TLS certificates, the
/// node-wide signature budget, the challenge and `have`.
pub(crate) fn serve_proof_reply(
    status: &ServeStatus,
    certs: &super::wallet_plane::CertStore,
    sigs: &PerSecond,
    challenge: &str,
    have: Option<&str>,
    newest_certified_index: u64,
    now: u64,
) -> warp::reply::Response {
    let (cert, key) = match status {
        ServeStatus::Ready { cert, key } => (cert, key),
        ServeStatus::NoCertificate => return serve_unavailable("no_certificate", 600),
        ServeStatus::NotRegistered => return serve_unavailable("not_registered", 600),
        ServeStatus::NoWalletKey => return serve_unavailable("no_wallet_key", 3600),
    };
    // The TLS certificate this answer rides on must be the one for the ServeCert's IP, valid now.
    if certs.valid_ip(now) != Some(cert.cert.ip) || now > cert.cert.not_after {
        return serve_unavailable("no_certificate", 600);
    }
    if !sigs.admit_at(now) {
        return serve_unavailable("busy", 1);
    }
    let sig = match key.sign(serve_proof_preimage(challenge, &cert.hash, cert.cert.ip).as_bytes()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ERR][WALLETRPC] serve_sign_failed err={}", e);
            return serve_unavailable("no_wallet_key", 3600);
        }
    };
    PLANE_STATS.serve_proofs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let hash_hex = hex::encode(cert.hash);
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut body = serde_json::Map::new();
    body.insert("v".into(), json!(1));
    if have != Some(hash_hex.as_str()) {
        body.insert("cert".into(), json!(b64.encode(cert.wire())));
    }
    body.insert("cert_hash".into(), json!(hash_hex));
    body.insert("sig".into(), json!(b64.encode(sig)));
    body.insert("newest_certified_index".into(), json!(newest_certified_index));
    json_response(StatusCode::OK, Value::Object(body).to_string(), CACHE_NONE, None)
}

/// GET /api/v1/node/serve-proof: wallet plane only (404 elsewhere), 6 per minute per source.
pub(super) async fn handle_serve_proof(
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
    plane: Option<WalletPlane>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    let status = SERVE_STATUS.read().clone();
    serve_proof_route(&query, remote, plane, &status, &WALLET_CERTS, &SERVE_SIGS, wallet_plane::unix_now(),
                      || blockchain.get_storage().proof_views().newest_certified_index())
}

/// The route's steps in order: the plane, the per-source limit, the query, then the answer.
pub(crate) fn serve_proof_route(
    query: &[(String, String)],
    remote: Option<SocketAddr>,
    plane: Option<WalletPlane>,
    status: &ServeStatus,
    certs: &super::wallet_plane::CertStore,
    sigs: &PerSecond,
    now: u64,
    newest: impl FnOnce() -> u64,
) -> Result<warp::reply::Response, Rejection> {
    if plane.is_none() {
        return Err(warp::reject::not_found());
    }
    if let Err(retry) = api_rate_limit_retry(remote, SERVE_PROOF_BUCKET) {
        return Ok(plane_rate_limited(retry));
    }
    let (challenge, have) = match serve_query(query) {
        Ok(q) => q,
        Err(p) => return Ok(bad_parameter(p)),
    };
    Ok(serve_proof_reply(status, certs, sigs, &challenge, have.as_deref(), newest(), now))
}

/// Strict IPv4 range check: no this-network, private, shared, loopback, link-local, protocol,
/// documentation, relay, benchmark, multicast or reserved address, so a hint can never point a
/// device at its own network.
pub(crate) fn is_public_unicast_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(o[0] == 0
        || o[0] == 10
        || (o[0] == 100 && (o[1] & 0xC0) == 64)
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (o[1] & 0xF0) == 16)
        || (o[0] == 192 && o[1] == 0 && (o[2] == 0 || o[2] == 2))
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 198 && (o[1] & 0xFE) == 18)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || o[0] >= 224)
}

/// `https://<IPv4>` (optionally `:443`), canonical dotted form, no path: the committed opt-in.
pub(crate) fn parse_https_ipv4_endpoint(endpoint: &str) -> Option<Ipv4Addr> {
    let rest = endpoint.strip_prefix("https://")?;
    let host = rest.strip_suffix(":443").unwrap_or(rest);
    let ip: Ipv4Addr = host.parse().ok()?;
    (ip.to_string() == host).then_some(ip)
}

fn valid_super_id(id: &str) -> bool {
    id.strip_prefix("super_node_").map_or(false, |h| is_lower_hex(h, 16))
}

/// `ids` exactly once: 1 to 64 super node ids, duplicates collapsed.
fn nodes_rpc_ids(query: &[(String, String)]) -> Result<Vec<String>, &'static str> {
    let mut ids = None;
    for (k, v) in query {
        if k != "ids" || ids.is_some() {
            return Err("ids");
        }
        ids = Some(v.as_str());
    }
    let mut out: Vec<String> = Vec::new();
    for id in ids.ok_or("ids")?.split(',') {
        if !valid_super_id(id) {
            return Err("ids");
        }
        if !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    if out.is_empty() || out.len() > NODES_RPC_MAX_IDS {
        return Err("ids");
    }
    Ok(out)
}

/// The listed ids' committed wallet-plane endpoints: O(ids) point reads of the persisted `nep_`
/// rows; an id without an `https://<public IPv4>` endpoint is left out.
pub(crate) fn nodes_rpc_entries(ids: &[String], load: impl Fn(&str) -> Option<String>) -> Vec<Value> {
    ids.iter()
        .filter_map(|id| {
            let ip = load(id).and_then(|ep| parse_https_ipv4_endpoint(&ep)).filter(|ip| is_public_unicast_v4(*ip))?;
            Some(json!({ "node_id": id, "ip": ip.to_string() }))
        })
        .collect()
}

/// GET /api/v1/nodes/rpc?ids=: both planes, 30 per minute per source. It answers only for ids the
/// client chose: no sampling mode exists, so no server can steer which nodes a client picks.
pub(super) async fn handle_nodes_rpc(
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    if let Err(retry) = api_rate_limit_retry(remote, NODES_RPC_BUCKET) {
        return Ok(plane_rate_limited(retry));
    }
    let ids = match nodes_rpc_ids(&query) {
        Ok(ids) => ids,
        Err(p) => return Ok(bad_parameter(p)),
    };
    let storage = blockchain.get_storage();
    let entries = nodes_rpc_entries(&ids, |id| storage.load_node_endpoint(id).ok().flatten());
    Ok(json_response(StatusCode::OK, json!({ "v": 1, "entries": entries }).to_string(), "public, max-age=60", None))
}

/// The caller's address with an IPv4-mapped IPv6 unwrapped.
fn plain_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_unicast_v4(v4),
        IpAddr::V6(v6) => {
            let s0 = v6.segments()[0];
            // Global unicast 2000::/3, minus documentation 2001:db8::/32.
            (s0 & 0xE000) == 0x2000 && !(s0 == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// `probe` (only "443") and `marker` (32 lowercase hex, only with probe), each at most once.
fn whoami_query(query: &[(String, String)]) -> Result<(bool, Option<String>), &'static str> {
    let (mut probe, mut marker) = (None, None);
    for (k, v) in query {
        match k.as_str() {
            "probe" if probe.is_none() && v == "443" => probe = Some(()),
            "marker" if marker.is_none() && is_lower_hex(v, 32) => marker = Some(v.clone()),
            "probe" => return Err("probe"),
            "marker" => return Err("marker"),
            _ => return Err("query"),
        }
    }
    if marker.is_some() && probe.is_none() {
        return Err("marker");
    }
    Ok((probe.is_some(), marker))
}

/// One connect-back to `target:port` within 2 s. `tcp` says something accepted; with a marker, `tls`
/// says the server there presented a certificate naming `<marker>.probe.invalid`, i.e. it is the
/// caller's own process. Nothing is sent beyond the handshake.
pub(crate) async fn probe_443(target: IpAddr, port: u16, marker: Option<&str>) -> (bool, Option<bool>) {
    let work = async {
        let stream = match tokio::net::TcpStream::connect(SocketAddr::new(target, port)).await {
            Ok(s) => s,
            Err(_) => return (false, marker.map(|_| false)),
        };
        let Some(marker) = marker else { return (true, None) };
        let name = format!("{}{}", marker, PROBE_SUFFIX);
        let tls = (|| {
            let cfg = wallet_plane::probe_client_config(&[b"http/1.1"]).ok()?;
            let server_name = rustls::pki_types::ServerName::try_from(name.clone()).ok()?;
            Some((tokio_rustls::TlsConnector::from(Arc::new(cfg)), server_name))
        })();
        let Some((connector, server_name)) = tls else { return (true, Some(false)) };
        let Ok(mut conn) = connector.connect(server_name, stream).await else { return (true, Some(false)) };
        let names_marker = conn.get_ref().1.peer_certificates()
            .and_then(|c| c.first())
            .and_then(|leaf| x509_parser::parse_x509_certificate(leaf.as_ref()).ok().map(|(_, cert)| {
                cert.subject_alternative_name().ok().flatten().map_or(false, |san| san.value.general_names.iter().any(|g| {
                    matches!(g, x509_parser::extensions::GeneralName::DNSName(d) if d.eq_ignore_ascii_case(&name))
                }))
            }))
            .unwrap_or(false);
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut conn).await;
        (true, Some(names_marker))
    };
    tokio::time::timeout(PROBE_TIMEOUT, work).await.unwrap_or((false, marker.map(|_| false)))
}

/// The caller's address as this node's own socket gives it: the TLS peer on the wallet plane, else
/// the socket peer unless that is loopback or `gateway` (a local terminator or the container runtime's
/// proxy speaking for someone else, whose address only a header names). None: header-only.
pub(crate) fn socket_client_ip(plane_peer: Option<&WalletPeer>, peer: Option<SocketAddr>, gateway: Option<IpAddr>) -> Option<IpAddr> {
    if let Some(p) = plane_peer {
        return Some(plain_ip(p.peer.ip()));
    }
    let ip = plain_ip(peer?.ip());
    (!ip.is_loopback() && Some(ip) != gateway.map(plain_ip)).then_some(ip)
}

/// The whoami answer for `caller`. `port` is 443 in production; `any_caller` lets a test probe a
/// loopback caller (the route never sets it).
pub(crate) async fn whoami_reply(caller: IpAddr, from_socket: bool, query: &[(String, String)], port: u16, any_caller: bool) -> warp::reply::Response {
    whoami_reply_with(caller, from_socket, query, any_caller, |ip, marker| async move {
        probe_443(ip, port, marker.as_deref()).await
    }).await
}

/// `whoami_reply` with the connect-back given: the production one is `probe_443`.
pub(crate) async fn whoami_reply_with<F, Fut>(
    caller: IpAddr,
    from_socket: bool,
    query: &[(String, String)],
    any_caller: bool,
    connect_back: F,
) -> warp::reply::Response
where
    F: FnOnce(IpAddr, Option<String>) -> Fut,
    Fut: std::future::Future<Output = (bool, Option<bool>)>,
{
    let (probe, marker) = match whoami_query(query) {
        Ok(q) => q,
        Err(p) => return bad_parameter(p),
    };
    let caller = plain_ip(caller);
    let mut body = serde_json::Map::new();
    body.insert("ip".into(), json!(caller.to_string()));
    if probe {
        if !from_socket {
            // Only a header named this address (behind a terminator, or the runtime's proxy): no
            // connect-back, since whoever wrote the header could aim it anywhere. No tcp443/tls443,
            // so the caller can tell "not probed here" from "probed and closed".
            body.insert("probe".into(), json!("caller_not_socket"));
        } else if !(any_caller || is_public_ip(caller)) {
            body.insert("tcp443".into(), json!(false));
            if marker.is_some() {
                body.insert("tls443".into(), json!(false));
            }
            body.insert("probe".into(), json!("caller_not_public"));
        } else {
            if !PROBES.admit() {
                return plane_busy(1);
            }
            // One probe at a time per caller.
            let Some(_slot) = ProbeSlot::take(caller) else {
                return plane_rate_limited(2);
            };
            let (tcp, tls) = connect_back(caller, marker).await;
            body.insert("tcp443".into(), json!(tcp));
            if let Some(tls) = tls {
                body.insert("tls443".into(), json!(tls));
            }
        }
    }
    json_response(StatusCode::OK, Value::Object(body).to_string(), CACHE_NONE, None)
}

/// GET /api/v1/whoami[?probe=443&marker=]: every node type, both planes, 2 per minute per source. On
/// the wallet plane the caller is the TLS peer itself, never a header; on port 8001 the reported
/// address follows the client address rules, but a probe runs only toward the socket's own peer.
pub(super) async fn handle_whoami(
    query: Vec<(String, String)>,
    remote: Option<SocketAddr>,
    plane_peer: Option<WalletPeer>,
    socket_peer: Option<SocketAddr>,
) -> Result<warp::reply::Response, Rejection> {
    if let Err(retry) = api_rate_limit_retry(remote, WHOAMI_BUCKET) {
        return Ok(plane_rate_limited(retry));
    }
    let from_socket = socket_client_ip(plane_peer.as_ref(), socket_peer, *LOCAL_GATEWAY);
    let caller = from_socket.or(remote.map(|r| r.ip())).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    Ok(whoami_reply(caller, from_socket.is_some(), &query, 443, false).await)
}

#[cfg(test)]
#[path = "node_serve_tests.rs"]
mod tests;

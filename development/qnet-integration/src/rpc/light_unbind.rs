//! `POST /api/v1/light-node/unbind` (U6): the node stops on its device. Signed by the bound device's ping
//! key at the binding's own sequence ("Stop on this device"), or by the wallet key K at that sequence from
//! any device that holds the wallet ("Unlink the device": the device that runs the node may be lost). The
//! binding is withdrawn, its floor refuses it and every older one on every copy path, the push record goes,
//! and the other genesis nodes take the same unbind from its own signature: sent at once and retried for
//! hours, and served with the withdrawn row, so a genesis that missed it takes it from a peer later. RPC
//! policy of the genesis nodes; no block rule reads any of it.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` sections 4 and 5.7.

use super::*;
use crate::light_binding::{self as lb, BindingRow, Refusal, UnbindRecord};

/// The bound device's ping key.
const PING_SIGNER: &str = "ping";
/// The wallet key K whose EON address owns the node.
const WALLET_SIGNER: &str = "wallet";

#[derive(Debug, Default, Deserialize)]
pub(super) struct UnbindRequest {
    #[serde(default)] pub(super) node_id: String,
    #[serde(default)] pub(super) seq: u64,
    #[serde(default)] pub(super) ts: u64,
    /// "ping": the bound device's key; "wallet": the wallet key K.
    #[serde(default)] pub(super) signer: String,
    /// ML-DSA-65 over `{chain_tag}light_unbind:{N}:{seq}:{ts}` (ping) or
    /// `{chain_tag}light_unbind_wallet:{N}:{seq}:{ts}` (wallet), hex.
    #[serde(default)] pub(super) sig: String,
    /// K, hex: required for the wallet form, empty for the ping form.
    #[serde(default)] pub(super) identity_pubkey: String,
    /// Device layer (light-node-messages section 5.7): the device's release `{nonce, stamp, sig, token?}`,
    /// read at the genesis that issued its challenge (the app sends it once `device_v1` is served). Only the
    /// bound device's hardware key makes one, so the wallet form never carries it.
    #[serde(default)] pub(super) device_release: Option<Value>,
}

/// An unbind as it travels between genesis nodes: enough for each to re-verify it from its signer's own
/// signature (the device's or the wallet key's), whatever binding it holds.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UnbindProof {
    pub(crate) node_id: String,
    pub(crate) seq: u64,
    pub(crate) ts: u64,
    pub(crate) signer: String,
    pub(crate) sig: String,
    /// K: the key the device's delegation verifies under (ping), or the key that signed (wallet).
    pub(crate) identity_pubkey: String,
    /// The key that signed and its delegation `v2.{seq}.{sig}`, so a genesis that missed the binding
    /// still sees the device was bound at that sequence. Empty for the wallet form.
    #[serde(default)] pub(crate) ping_pubkey: String,
    #[serde(default)] pub(crate) delegation_cert: String,
    #[serde(default)] pub(crate) origin_ip: String,
}

impl UnbindProof {
    /// The unbind a withdrawn row keeps at its floor, as a proof to re-verify.
    pub(crate) fn from_row(node_id: &str, row: &BindingRow) -> Option<Self> {
        let u = row.unbind.as_ref()?;
        (row.floor > 0 && row.ping_pubkey.is_empty()).then(|| UnbindProof {
            node_id: node_id.to_string(),
            seq: row.floor,
            ts: u.ts,
            signer: if u.signer.is_empty() { PING_SIGNER.to_string() } else { u.signer.clone() },
            sig: u.sig.clone(),
            identity_pubkey: row.identity_pubkey.clone(),
            ping_pubkey: u.ping_pubkey.clone(),
            delegation_cert: u.cert.clone(),
            origin_ip: String::new(),
        })
    }

    fn record(&self) -> UnbindRecord {
        UnbindRecord {
            ts: self.ts, sig: self.sig.clone(), ping_pubkey: self.ping_pubkey.clone(), cert: self.delegation_cert.clone(),
            // The ping form is stored as before, with no signer.
            signer: if self.signer == PING_SIGNER { String::new() } else { self.signer.clone() },
        }
    }
}

fn is_hex_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The shape checked wherever an unbind arrives: a light node id, a raw ML-DSA-65 signature, and the signer's
/// own fields (the wallet form: a sequence, K, and no device key or delegation).
fn unbind_shape_ok(node_id: &str, signer: &str, seq: u64, sig: &str, identity: &str, ping_pk: &str, cert: &str) -> bool {
    if !node_id.starts_with("light_") || node_id.len() > 128 || !is_hex_len(sig, lb::MLDSA65_SIG_HEX) {
        return false;
    }
    match signer {
        PING_SIGNER => true,
        WALLET_SIGNER => seq > 0 && is_hex_len(identity, lb::MLDSA65_PK_HEX) && ping_pk.is_empty() && cert.is_empty(),
        _ => false,
    }
}

/// K for the wallet form: the key the registration's commitment vouches for, and the key of the EON address
/// whose pseudonym the node id is.
fn wallet_unbind_key(storage: &crate::storage::Storage, node_id: &str, presented: &str) -> Result<String, Refusal> {
    let k = storage.resolve_light_identity_pk(node_id, Some(presented))
        .filter(|k| k.eq_ignore_ascii_case(presented))
        .ok_or(Refusal::IdentityMismatch)?;
    let owns = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(presented)
        .map_or(false, |w| generate_light_node_pseudonym(&w) == node_id);
    if owns { Ok(k) } else { Err(Refusal::IdentityMismatch) }
}

/// The unbind's signature, checked alike wherever it arrives. The ping form: K under the registration's
/// commitment, the device's delegation at exactly this sequence, and the device's signature. The wallet form:
/// K under the commitment and as the owner of the node id, and K's signature.
pub(crate) fn verify_unbind_proof(storage: &crate::storage::Storage, p: &UnbindProof) -> Result<(), Refusal> {
    if !unbind_shape_ok(&p.node_id, &p.signer, p.seq, &p.sig, &p.identity_pubkey, &p.ping_pubkey, &p.delegation_cert) {
        return Err(Refusal::BadRequest);
    }
    if !storage.is_node_registration_onchain(&p.node_id) {
        return Err(Refusal::NotRegistered);
    }
    if p.signer == WALLET_SIGNER {
        let k = wallet_unbind_key(storage, &p.node_id, &p.identity_pubkey)?;
        let signed = verify_mobile_dilithium_signature(&lb::light_unbind_wallet_message(&p.node_id, p.seq, p.ts), &p.sig, &k);
        return if signed { Ok(()) } else { Err(Refusal::BadSignature) };
    }
    if p.identity_pubkey.is_empty() { return Err(Refusal::IdentityMismatch); }
    let identity = storage.resolve_light_identity_pk(&p.node_id, Some(&p.identity_pubkey))
        .filter(|k| k.eq_ignore_ascii_case(&p.identity_pubkey))
        .ok_or(Refusal::IdentityMismatch)?;
    let signed = lb::parse_cert(&p.delegation_cert).and_then(|f| f.seq()) == Some(p.seq)
        && lb::verify_delegation(&p.delegation_cert, &p.ping_pubkey, &p.node_id, &identity).is_some()
        && verify_mobile_dilithium_signature(&lb::light_unbind_message(&p.node_id, p.seq, p.ts), &p.sig, &p.ping_pubkey);
    if signed { Ok(()) } else { Err(Refusal::BadSignature) }
}

/// What `/unbind` checks before it writes: shape, time, registration, then the signature (the device's under
/// the key stored for it, or K's under the commitment), and only then the binding's form and sequence. Nothing
/// about the stored binding is told to a caller who cannot sign with the bound device's key or the wallet key:
/// while any device is bound (legacy or v2) a signature by another key gets `bad_signature`, and "nothing
/// bound" (`stale_seq`: never bound, or withdrawn) is what the public status already says. Ok carries the
/// proof the other genesis nodes re-verify.
pub(super) fn check_unbind(storage: &crate::storage::Storage, req: &UnbindRequest, now: u64) -> Result<UnbindProof, Refusal> {
    let own_fields = match req.signer.as_str() {
        PING_SIGNER => req.identity_pubkey.is_empty(),
        // A release is made only by the bound device's hardware key.
        _ => req.device_release.is_none(),
    };
    if !own_fields || !unbind_shape_ok(&req.node_id, &req.signer, req.seq, &req.sig, &req.identity_pubkey, "", "") {
        return Err(Refusal::BadRequest);
    }
    if now.abs_diff(req.ts) > lb::FRESH_TS_WINDOW_SECS {
        return Err(Refusal::Expired);
    }
    if !storage.is_node_registration_onchain(&req.node_id) {
        return Err(Refusal::NotRegistered);
    }
    if req.signer == WALLET_SIGNER {
        return check_wallet_unbind(storage, req);
    }
    let row = storage.get_light_binding(&req.node_id)
        .filter(|r| r.device_bound())
        .ok_or(Refusal::StaleSeq)?;
    if !verify_mobile_dilithium_signature(&lb::light_unbind_message(&req.node_id, req.seq, req.ts), &req.sig, &row.ping_pubkey) {
        return Err(Refusal::BadSignature);
    }
    // A legacy-bound device has no sequence to withdraw at: told only to that device itself.
    lb::admit_unbind(Some(&row), req.seq)?;
    // The delegation is checked under the recorded K, as every peer will check it.
    let identity = storage.resolve_light_identity_pk(&req.node_id, None).ok_or(Refusal::BadSignature)?;
    let proof = UnbindProof {
        node_id: req.node_id.clone(),
        seq: req.seq,
        ts: req.ts,
        signer: PING_SIGNER.to_string(),
        sig: req.sig.clone(),
        identity_pubkey: identity,
        ping_pubkey: row.ping_pubkey,
        delegation_cert: row.cert,
        origin_ip: String::new(),
    };
    verify_unbind_proof(storage, &proof)?;
    Ok(proof)
}

/// The wallet form at the genesis the request reached, after shape, time and registration: K, its signature,
/// and only then the stored binding, which must be a v2 binding at exactly `seq`.
fn check_wallet_unbind(storage: &crate::storage::Storage, req: &UnbindRequest) -> Result<UnbindProof, Refusal> {
    let proof = UnbindProof {
        node_id: req.node_id.clone(),
        seq: req.seq,
        ts: req.ts,
        signer: WALLET_SIGNER.to_string(),
        sig: req.sig.clone(),
        identity_pubkey: req.identity_pubkey.clone(),
        ping_pubkey: String::new(),
        delegation_cert: String::new(),
        origin_ip: String::new(),
    };
    verify_unbind_proof(storage, &proof)?;
    let row = storage.get_light_binding(&req.node_id).filter(|r| r.device_bound()).ok_or(Refusal::StaleSeq)?;
    // A legacy binding has no sequence to withdraw at.
    lb::admit_unbind(Some(&row), req.seq)?;
    Ok(proof)
}

/// The device's release that goes with the unbind (section 5.7, A11), at the genesis that issued its
/// challenge: the device record ends here and at every genesis and the oracle forgets the node's slot for
/// leasing. It never decides the unbind: Stop works whether or not the release checks out. True when the
/// record ended.
fn device_layer_release(blockchain: &Arc<BlockchainNode>, req: &UnbindRequest, now: u64) -> bool {
    let (Some(block), Some(ctx)) = (req.device_release.as_ref(), DeviceCtx::of(blockchain)) else { return false; };
    match release_step(&ctx, &req.node_id, req.seq, block, now) {
        Ok(_) => true,
        Err(r) => {
            if crate::node::is_info() {
                println!("[INFO][LIGHT] unbind_device_release_refused node={} reason={}", req.node_id, r.as_str());
            }
            false
        }
    }
}

/// Withdraw the binding here and clear what served it: the resident push channel, the RPC device list,
/// a pending polling challenge. The withdrawn row keeps the proof, for peers that missed it. `origin`
/// applies the request's rule again under the node's lock; a copy from another genesis applies the copy
/// rule. Ok carries the row now and whether anything changed.
pub(crate) fn apply_unbind(
    storage: &crate::storage::Storage,
    p2p: Option<&crate::unified_p2p::SimplifiedP2P>,
    p: &UnbindProof,
    origin: bool,
    now: u64,
) -> Result<(BindingRow, bool), Refusal> {
    let mut changed = false;
    let written = storage.withdraw_light_binding(&p.node_id, p.seq, &p.identity_pubkey, Some(p.record()), |stored| {
        let verdict = if origin {
            lb::admit_unbind(stored, p.seq).map(|_| true)
        } else {
            lb::admit_unbind_copy(stored, p.seq, now)
        };
        changed = matches!(verdict, Ok(true));
        verdict
    });
    let row = match written {
        Ok(Ok(row)) => row,
        Ok(Err(r)) => return Err(r),
        Err(e) => {
            println!("[WARN][LIGHT] unbind_store_failed node={} err={}", p.node_id, e);
            return Err(Refusal::BadRequest);
        }
    };
    if changed {
        if let Some(p2p) = p2p {
            p2p.refresh_light_node_push_channel(storage, &p.node_id);
        }
        if let Some(node) = LIGHT_NODE_REGISTRY.lock().get_mut(&p.node_id) {
            node.devices.clear();
        }
        PENDING_CHALLENGES.lock().remove(&p.node_id);
    }
    Ok((row, changed))
}

pub(super) static UNBIND_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(5, 3600);

/// When a peer that did not take the unbind is asked again: a restart or a roll is over within minutes,
/// a longer outage within hours. After that the peer takes it from the withdrawn row (served by the
/// identity pull) when its push to the stopped device fails.
const UNBIND_SYNC_RETRY_SECS: [u64; 5] = [15, 60, 300, 1800, 7200];

/// Send the unbind to the other genesis nodes over the internal channel; each re-verifies it. A genesis
/// that has not applied the registration yet, or could not be reached, is asked again on the schedule.
pub(super) async fn sync_unbind_to_genesis_peers(mut proof: UnbindProof, our_ip: String) {
    const PATH: &str = "/api/v1/internal/light-unbind-sync";
    proof.origin_ip = our_ip.clone();
    let mut pending: Vec<&str> = crate::genesis_constants::GENESIS_NODE_IPS.iter()
        .map(|(ip, _)| *ip).filter(|ip| *ip != our_ip && !ip.is_empty()).collect();
    for (attempt, wait) in std::iter::once(0).chain(UNBIND_SYNC_RETRY_SECS).enumerate() {
        if pending.is_empty() { return; }
        if wait > 0 { tokio::time::sleep(std::time::Duration::from_secs(wait)).await; }
        let mut again = Vec::new();
        for ip in pending {
            // TLS only (L-1): a peer it does not reach is asked again on the schedule, and takes the withdrawn row from
            // the identity pull meanwhile.
            match genesis_internal_call_tls(ip, PATH, |c, url| c.post(url).json(&proof)).await {
                Ok(r) if r.status().is_success() => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] unbind_synced_to ip={} node={} attempt={}", ip, proof.node_id, attempt);
                    }
                }
                Ok(r) => {
                    let status = r.status();
                    let reason = r.json::<Value>().await.ok()
                        .and_then(|v| v["reason"].as_str().map(|s| s.to_string())).unwrap_or_default();
                    // A refusal on the proof itself will not change; anything else is asked again.
                    let settled = [Refusal::BadRequest, Refusal::BadSignature, Refusal::IdentityMismatch]
                        .iter().any(|r| r.as_str() == reason);
                    if !settled { again.push(ip); }
                    if crate::node::is_warn() {
                        println!("[WARN][LIGHT] unbind_sync_rejected ip={} status={} reason={} attempt={}", ip, status, reason, attempt);
                    }
                }
                Err(e) => {
                    again.push(ip);
                    if crate::node::is_warn() {
                        println!("[WARN][LIGHT] unbind_sync_failed ip={} err={} attempt={}", ip, e.without_url(), attempt);
                    }
                }
            }
        }
        pending = again;
    }
    if !pending.is_empty() && crate::node::is_warn() {
        println!("[WARN][LIGHT] unbind_sync_gave_up node={} peers={:?} action=peers_take_it_from_the_withdrawn_row",
                 proof.node_id, pending);
    }
}

/// Ask the other genesis nodes for a withdrawal of this node's binding that this genesis missed, and take
/// it when its proof verifies. Called when a push to the node's device failed because the provider no
/// longer knows the token: a device stops by unbinding and then deleting its token, and a device unlinked by
/// the wallet key deletes it once an owner tells it its binding is gone, so that failure is what a missed unbind
/// looks like from here. At most once per node per epoch; a few in flight.

pub(crate) fn repair_withdrawn_binding(node_id: &str, epoch: u64) {
    fn asked() -> &'static DashMap<String, u64> {
        static M: std::sync::OnceLock<DashMap<String, u64>> = std::sync::OnceLock::new();
        M.get_or_init(DashMap::new)
    }
    fn permits() -> &'static Arc<tokio::sync::Semaphore> {
        static S: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        S.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
    }
    let Some(storage) = crate::node::try_get_storage() else { return; };
    // Only a device a v2 binding names can have been withdrawn by an unbind.
    if !storage.get_light_binding(node_id).map_or(false, |b| b.v2 && b.device_bound()) { return; }
    if asked().len() > 65_536 { asked().clear(); }
    if asked().insert(node_id.to_string(), epoch) == Some(epoch) { return; }
    let Ok(permit) = permits().clone().try_acquire_owned() else {
        asked().remove(node_id);
        return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    let node = node_id.to_string();
    let our_ip = our_genesis_ip();
    handle.spawn(async move {
        let _permit = permit;
        let path = format!("/api/v1/internal/light-ping-keys-get?node_id={}", node);
        for (ip, _) in crate::genesis_constants::GENESIS_NODE_IPS {
            if *ip == our_ip || ip.is_empty() { continue; }
            let Some(v) = (match genesis_internal_call_tls(ip, &path, |c, url| c.get(url)).await {
                Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
                _ => None,
            }) else { continue; };
            let Some(proof) = pulled_unbind(&node, &v) else { continue; };
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let outcome = verify_unbind_proof(storage, &proof)
                .and_then(|_| apply_unbind(storage, crate::node::try_get_p2p().map(|p| p.as_ref()), &proof, false, now));
            match outcome {
                Ok((row, true)) => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] unbind_repaired node={} from={} floor={}", node, ip, row.floor);
                    }
                    return;
                }
                Ok((_, false)) => return,
                Err(r) => if crate::node::is_debug() {
                    println!("[DBG][LIGHT] unbind_repair_refused node={} from={} reason={}", node, ip, r.as_str());
                },
            }
        }
    });
}

/// The unbind a peer's identity-pull answer carries for a withdrawn row, if any.
pub(crate) fn pulled_unbind(node_id: &str, v: &Value) -> Option<UnbindProof> {
    if v["success"].as_bool() != Some(true) || !v["ping_pubkey"].as_str().unwrap_or("").is_empty() {
        return None;
    }
    let u = &v["unbind"];
    let s = |x: &Value, k: &str| x[k].as_str().unwrap_or("").to_string();
    let row = BindingRow {
        identity_pubkey: s(v, "identity_pubkey"),
        floor: v["floor"].as_u64().unwrap_or(0),
        v2: true,
        unbind: u.is_object().then(|| UnbindRecord {
            ts: u["ts"].as_u64().unwrap_or(0), sig: s(u, "sig"), ping_pubkey: s(u, "ping_pubkey"), cert: s(u, "cert"),
            signer: s(u, "signer"),
        }),

        ..Default::default()
    };
    UnbindProof::from_row(node_id, &row)
}

/// `POST /api/v1/light-node/unbind`.
pub(super) async fn handle_light_node_unbind(
    req: UnbindRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    // The address's budget of failed requests (L-2): an unbind that verifies spends none of it.
    if let Some(wait) = UNBIND_FAIL_LIMIT.blocked(remote_addr, now) {
        let mut v = Refusal::RateLimited.to_json();
        v["retry_after_seconds"] = json!(wait);
        return Ok(warp::reply::json(&v));
    }
    let storage = blockchain.get_storage();
    let proof = match check_unbind(&storage, &req, now) {
        Ok(p) => p,
        Err(r) => {
            UNBIND_FAIL_LIMIT.charge(remote_addr, now);
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] unbind_refused node={} signer={} reason={}", req.node_id, req.signer, r.as_str());
            }
            return Ok(warp::reply::json(&r.to_json()));
        }
    };
    // Spent only after the signature verified: a request that verifies always withdraws something.
    if !UNBIND_NODE_LIMIT.allows(&req.node_id, now) {
        return Ok(warp::reply::json(&Refusal::RateLimited.to_json()));
    }
    // The release reads the record at the binding's own sequence, so it runs before the withdrawal. The wallet
    // form carries none: the record ends with its binding (`binding_released`).
    let released = req.signer == PING_SIGNER && device_layer_release(&blockchain, &req, now);
    let p2p = blockchain.get_unified_p2p();
    match apply_unbind(&storage, p2p.as_deref(), &proof, true, now) {
        Ok((row, _)) => {
            if crate::node::is_info() {
                println!("[INFO][LIGHT] light_unbound node={} floor={} device_released={}", proof.node_id, row.floor, released);
            }
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(sync_unbind_to_genesis_peers(proof.clone(), our_genesis_ip()));
            }
            Ok(warp::reply::json(&json!({
                "success": true, "unbound": true, "node_id": proof.node_id, "binding_seq": row.bar(),
                "device_released": released,
            })))
        }
        Err(r) => Ok(warp::reply::json(&r.to_json())),
    }
}

/// `POST /api/v1/internal/light-unbind-sync`: another genesis's unbind, re-verified and applied under the
/// copy rule. Genesis callers only.
pub(super) async fn handle_internal_light_unbind_sync(
    remote_addr: Option<std::net::SocketAddr>,
    proof: UnbindProof,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let caller = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_genesis_peer_ip(&caller) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] unbind_sync_rejected_unauthorized caller={}", caller);
        }
        return Ok(warp::reply::with_status(
            warp::reply::json(&json!({"success": false, "error": "Unauthorized"})),
            warp::http::StatusCode::FORBIDDEN,
        ));
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let storage = blockchain.get_storage();
    let p2p = blockchain.get_unified_p2p();
    let outcome = verify_unbind_proof(&storage, &proof)
        .and_then(|_| apply_unbind(&storage, p2p.as_deref(), &proof, false, now));
    let (status, body) = match outcome {
        Ok((row, applied)) => {
            if applied && crate::node::is_info() {
                println!("[INFO][LIGHT] unbind_synced_from ip={} node={} floor={}", caller, proof.node_id, row.floor);
            }
            (warp::http::StatusCode::OK, json!({"success": true, "applied": applied, "binding_seq": row.bar()}))
        }
        // A newer binding is held here: the unbind is older than it and changes nothing.
        Err(Refusal::StaleSeq) => (warp::http::StatusCode::OK, json!({"success": true, "applied": false, "reason": "stale_seq"})),
        Err(r) => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] unbind_sync_refused ip={} node={} reason={}", caller, proof.node_id, r.as_str());
            }
            (warp::http::StatusCode::BAD_REQUEST, r.to_json())
        }
    };
    Ok(warp::reply::with_status(warp::reply::json(&body), status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};

    struct Keys { pk: d3::PublicKey, sk: d3::SecretKey, hex: String }
    fn keys() -> Keys {
        let (pk, sk) = d3::keypair();
        let hex = hex::encode(pk.as_bytes());
        Keys { pk, sk, hex }
    }
    fn sign(k: &Keys, msg: &str) -> String {
        hex::encode(d3::detached_sign(msg.as_bytes(), &k.sk).as_bytes())
    }
    fn storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (s, dir)
    }
    fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() }

    struct Node { wallet: Keys, w: String, id: String }
    fn node() -> Node {
        let wallet = keys();
        let w = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&wallet.hex).expect("eon");
        let id = crate::rpc::generate_light_node_pseudonym(&w);
        Node { wallet, w, id }
    }
    fn register(s: &crate::storage::Storage, n: &Node) {
        s.save_node_registration_at_height_burn_vrf(&n.id, "light", &n.w, 70.0, 100, "", Some(n.wallet.pk.as_bytes())).unwrap();
    }
    /// Bind `device` at `seq` with a push record, as `/bind` records it.
    fn bind(s: &crate::storage::Storage, n: &Node, device: &Keys, seq: u64) {
        let cert = sign(&n.wallet, &lb::delegation_v2_message(&device.hex, &n.id, seq));
        s.bind_light_v2(&n.id, &device.hex, &cert, &n.wallet.hex, seq, seq).unwrap().unwrap();
        assert!(s.save_fcm_token_seq(&n.id, "tok", "fcm", None, seq, seq).unwrap());
    }
    fn req(n: &Node, signer: &str, by: &Keys, seq: u64, ts: u64) -> UnbindRequest {
        UnbindRequest {
            node_id: n.id.clone(), seq, ts, signer: signer.into(),
            sig: sign(by, &lb::light_unbind_message(&n.id, seq, ts)), identity_pubkey: String::new(), device_release: None,
        }
    }
    /// The wallet form: `by` signs the wallet preimage and `k` is presented as K.
    fn wreq(n: &Node, by: &Keys, k: &str, seq: u64, ts: u64) -> UnbindRequest {
        UnbindRequest {
            node_id: n.id.clone(), seq, ts, signer: "wallet".into(),
            sig: sign(by, &lb::light_unbind_wallet_message(&n.id, seq, ts)), identity_pubkey: k.to_string(), device_release: None,
        }
    }

    #[test]
    fn stop_on_this_device_withdraws_the_binding_and_the_floor_holds() {
        let (s, _d) = storage();
        let n = node();
        register(&s, &n);
        let t = now();
        let phone = keys();
        bind(&s, &n, &phone, t - 60);
        let r = req(&n, "ping", &phone, t - 60, t);
        let proof = check_unbind(&s, &r, t).expect("the bound device stops the node");
        assert_eq!((proof.ping_pubkey.as_str(), proof.identity_pubkey.as_str()), (phone.hex.as_str(), n.wallet.hex.as_str()));
        let (row, changed) = apply_unbind(&s, None, &proof, true, t).expect("applied");
        assert!(changed);
        assert_eq!((row.ping_pubkey.as_str(), row.seq, row.floor, row.v2), ("", 0, t - 60, true));
        assert!(s.get_fcm_entry(&n.id).is_none(), "the push record is gone");
        assert!(s.get_light_ping_keys(&n.id).is_none(), "no key answers for the node");
        assert_eq!(s.get_light_binding(&n.id).map(|b| (b.device_bound(), b.bar())), Some((false, t - 60)));
        // The withdrawn row keeps the unbind, which re-verifies as the proof it came from.
        let kept = UnbindProof::from_row(&n.id, &s.get_light_binding(&n.id).unwrap()).expect("kept");
        assert_eq!(kept, proof);
        assert_eq!(verify_unbind_proof(&s, &kept), Ok(()));

        // A replay of the same unbind finds nothing to withdraw.
        assert_eq!(check_unbind(&s, &r, t).err(), Some(Refusal::StaleSeq));
        // The old binding never comes back: not its heal, not its push record.
        let old_cert = lb::format_v2_cert(t - 60, &sign(&n.wallet, &lb::delegation_v2_message(&phone.hex, &n.id, t - 60)));
        assert_eq!(s.save_light_ping_keys_identity(&n.id, &phone.hex, &old_cert, &n.wallet.hex).unwrap(),
                   crate::storage::PingKeyWrite::Refused(lb::Admit::Stale));
        assert!(!s.save_fcm_token_seq(&n.id, "tok", "fcm", None, t + 5, t - 60).unwrap(), "a raced refresh is not written back");
        assert!(!crate::rpc::legacy_attach_allowed(s.get_light_binding(&n.id).as_ref()), "the legacy register refuses");
        // "Use this device" rebinds above the floor, and the new binding carries no old unbind.
        assert_eq!(lb::admit_fresh(s.get_light_binding(&n.id).as_ref(), &phone.hex, t - 60, t), Err(Refusal::StaleSeq));
        assert_eq!(lb::admit_fresh(s.get_light_binding(&n.id).as_ref(), &phone.hex, t, t), Ok(false));
        bind(&s, &n, &keys(), t);
        let rebound = s.get_light_binding(&n.id).unwrap();
        assert_eq!((rebound.floor, rebound.unbind.is_none()), (t - 60, true));
    }

    #[test]
    fn an_unbind_by_another_device_a_stale_time_or_a_forgery_is_refused() {
        let (s, _d) = storage();
        let n = node();
        let t = now();
        let phone = keys();
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t, t), t).err(), Some(Refusal::NotRegistered));
        register(&s, &n);
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t, t), t).err(), Some(Refusal::StaleSeq), "nothing bound");
        bind(&s, &n, &phone, t - 60);
        let other = keys();
        assert_eq!(check_unbind(&s, &req(&n, "ping", &other, t - 60, t), t).err(), Some(Refusal::BadSignature),
                   "a device that is not the bound one");
        // The sequence is judged only for the bound device's own signature: a stranger learns nothing
        // about the stored sequence, whatever sequence it tries.
        for guess in [t - 61, t - 60, t - 59, 1] {
            assert_eq!(check_unbind(&s, &req(&n, "ping", &other, guess, t), t).err(), Some(Refusal::BadSignature), "{guess}");
        }
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t - 61, t), t).err(), Some(Refusal::StaleSeq));
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t - 60, t - 301), t).err(), Some(Refusal::Expired));
        assert_eq!(check_unbind(&s, &req(&n, "device", &phone, t - 60, t), t).err(), Some(Refusal::BadRequest));
        let mut short = req(&n, "ping", &phone, t - 60, t);
        short.sig = "ab".into();
        assert_eq!(check_unbind(&s, &short, t).err(), Some(Refusal::BadRequest));
        assert!(s.get_light_binding(&n.id).unwrap().device_bound(), "nothing was withdrawn");
    }

    /// Review r2, defect 3: nothing about the binding's form is told before a signature by the bound
    /// device (or, on the legacy register, by the committed key). A stranger's unbind gets
    /// `bad_signature` whether the bound device is legacy or v2; a legacy token refresh is judged against
    /// the binding's form only after its signature; the legacy register tells `bind_v2_required` only to
    /// a caller holding the committed key and its signature, and everyone else the same inert answer.
    #[test]
    fn a_stranger_cannot_tell_a_legacy_binding_from_a_v2_one_or_a_stop_from_never_bound() {
        let (s, _d) = storage();
        let n = node();
        register(&s, &n);
        let t = now();
        let phone = keys();
        let stranger = keys();
        let legacy_cert = sign(&n.wallet, &lb::delegation_v1_message(&phone.hex, &n.id));
        s.save_light_ping_keys_identity(&n.id, &phone.hex, &legacy_cert, &n.wallet.hex).unwrap();
        assert_eq!(check_unbind(&s, &req(&n, "ping", &stranger, t, t), t).err(), Some(Refusal::BadSignature), "legacy-bound");
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t, t), t).err(), Some(Refusal::StaleSeq),
                   "no sequence to withdraw: told to the legacy device itself");
        bind(&s, &n, &phone, t - 60);
        assert_eq!(check_unbind(&s, &req(&n, "ping", &stranger, t - 60, t), t).err(), Some(Refusal::BadSignature), "v2-bound");
        assert!(s.get_light_binding(&n.id).unwrap().device_bound(), "nothing was withdrawn");

        let src = include_str!("light_nodes.rs");
        let refresh = &src[src.find("async fn handle_light_node_token_refresh").unwrap()..];
        let refresh = &refresh[..refresh.find("pub(super) struct LightNodeRegisterRequest").unwrap()];
        assert!(refresh.find("token_refresh_bad_sig").unwrap() < refresh.find("Refusal::BindV2Required").unwrap(),
                "the refresh's form is judged after its signature");
        let register = &src[src.find("async fn handle_light_node_register").unwrap()..];
        let top = &register[..register.find("PURE STATELESS VERIFICATION").unwrap()];
        let inert = top.find("already_registered_reply(&pseudonym)").expect("the inert answer");
        let sig = top.find("verify_mobile_dilithium_signature(").expect("the key's signature");
        let v2 = top.find("Refusal::BindV2Required").expect("bind_v2_required");
        assert!(sig < inert && inert < v2, "the key and its signature before anything about the binding");
    }

    /// "Unlink the device" from any device that holds the wallet: K withdraws the binding stored now, at its own
    /// sequence, with no key of the device that runs the node (it may be lost).
    #[test]
    fn the_wallet_key_unlinks_the_bound_device_from_anywhere() {
        let (s, _d) = storage();
        let n = node();
        register(&s, &n);
        let t = now();
        let phone = keys();
        bind(&s, &n, &phone, t - 60);
        let r = wreq(&n, &n.wallet, &n.wallet.hex, t - 60, t);
        let proof = check_unbind(&s, &r, t).expect("the wallet key unlinks the device");
        assert_eq!((proof.signer.as_str(), proof.identity_pubkey.as_str(), proof.ping_pubkey.as_str(), proof.delegation_cert.as_str()),
                   ("wallet", n.wallet.hex.as_str(), "", ""));
        let (row, changed) = apply_unbind(&s, None, &proof, true, t).expect("applied");
        assert!(changed);
        assert_eq!((row.ping_pubkey.as_str(), row.seq, row.floor, row.v2, row.bar()), ("", 0, t - 60, true, t - 60));
        assert!(s.get_fcm_entry(&n.id).is_none(), "the push record is gone");
        assert!(!s.get_light_binding(&n.id).unwrap().device_bound(), "no device runs the node");
        // The withdrawn row keeps the wallet's unbind, which re-verifies as the proof it came from.
        let stored = s.get_light_binding(&n.id).unwrap();
        assert_eq!(stored.unbind.as_ref().map(|u| u.signer.as_str()), Some("wallet"));
        let kept = UnbindProof::from_row(&n.id, &stored).expect("kept");
        assert_eq!(kept, proof);
        assert_eq!(verify_unbind_proof(&s, &kept), Ok(()));
        // A replay finds nothing to withdraw, and the old device's binding never comes back.
        assert_eq!(check_unbind(&s, &r, t).err(), Some(Refusal::StaleSeq));
        assert_eq!(check_unbind(&s, &req(&n, "ping", &phone, t - 60, t), t).err(), Some(Refusal::StaleSeq));
        let old_cert = lb::format_v2_cert(t - 60, &sign(&n.wallet, &lb::delegation_v2_message(&phone.hex, &n.id, t - 60)));
        assert_eq!(s.save_light_ping_keys_identity(&n.id, &phone.hex, &old_cert, &n.wallet.hex).unwrap(),
                   crate::storage::PingKeyWrite::Refused(lb::Admit::Stale));
        // Use this device, on any device, rebinds above the floor.
        assert_eq!(lb::admit_fresh(s.get_light_binding(&n.id).as_ref(), &phone.hex, t, t), Ok(false));
        let tablet = keys();
        bind(&s, &n, &tablet, t);
        assert!(s.get_light_binding(&n.id).unwrap().device_bound());
        // The wallet key unlinks that binding too, at its own sequence.
        assert!(check_unbind(&s, &wreq(&n, &n.wallet, &n.wallet.hex, t, t), t).is_ok());
    }

    #[test]
    fn a_wallet_unbind_with_another_seq_key_form_or_time_is_refused() {
        let (s, _d) = storage();
        let n = node();
        let t = now();
        let k = n.wallet.hex.clone();
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k, t, t), t).err(), Some(Refusal::NotRegistered));
        register(&s, &n);
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k, t, t), t).err(), Some(Refusal::StaleSeq), "nothing bound");
        let phone = keys();
        bind(&s, &n, &phone, t - 60);
        // Another sequence than the stored binding's: told only after K's signature verified.
        for other in [t - 61, t - 59, t] {
            assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k, other, t), t).err(), Some(Refusal::StaleSeq), "{other}");
        }
        // Another wallet's key: the commitment does not vouch for it, whatever sequence it signs.
        let other = node();
        for guess in [t - 61, t - 60, t] {
            assert_eq!(check_unbind(&s, &wreq(&n, &other.wallet, &other.wallet.hex, guess, t), t).err(),
                       Some(Refusal::IdentityMismatch), "{guess}");
        }
        // K presented, signed by another key; and the ping form's preimage signed by K.
        assert_eq!(check_unbind(&s, &wreq(&n, &other.wallet, &k, t - 60, t), t).err(), Some(Refusal::BadSignature));
        let mut ping_preimage = wreq(&n, &n.wallet, &k, t - 60, t);
        ping_preimage.sig = sign(&n.wallet, &lb::light_unbind_message(&n.id, t - 60, t));
        assert_eq!(check_unbind(&s, &ping_preimage, t).err(), Some(Refusal::BadSignature));
        // The bound device's own key cannot use the wallet form.
        assert_eq!(check_unbind(&s, &wreq(&n, &phone, &phone.hex, t - 60, t), t).err(), Some(Refusal::IdentityMismatch));
        // Time, and the fields of each form.
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k, t - 60, t - 301), t).err(), Some(Refusal::Expired));
        let mut released = wreq(&n, &n.wallet, &k, t - 60, t);
        released.device_release = Some(json!({"nonce": "n", "stamp": "s", "sig": "x"}));
        assert_eq!(check_unbind(&s, &released, t).err(), Some(Refusal::BadRequest), "a release is the device's");
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, "", t - 60, t), t).err(), Some(Refusal::BadRequest), "no K");
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k[2..], t - 60, t), t).err(), Some(Refusal::BadRequest), "short K");
        assert_eq!(check_unbind(&s, &wreq(&n, &n.wallet, &k, 0, t), t).err(), Some(Refusal::BadRequest), "no sequence");
        let mut with_k = req(&n, "ping", &phone, t - 60, t);
        with_k.identity_pubkey = k.clone();
        assert_eq!(check_unbind(&s, &with_k, t).err(), Some(Refusal::BadRequest), "K on the ping form");
        assert!(s.get_light_binding(&n.id).unwrap().device_bound(), "nothing was withdrawn");
        // A legacy binding has no sequence to withdraw, by either key.
        let (l, _dl) = storage();
        register(&l, &n);
        let legacy_cert = sign(&n.wallet, &lb::delegation_v1_message(&phone.hex, &n.id));
        l.save_light_ping_keys_identity(&n.id, &phone.hex, &legacy_cert, &k).unwrap();
        assert_eq!(check_unbind(&l, &wreq(&n, &n.wallet, &k, t - 60, t), t).err(), Some(Refusal::StaleSeq));
        assert!(l.get_light_binding(&n.id).unwrap().device_bound());
    }

    /// The wallet form's copy at the other genesis nodes: verified from K's own signature, applied under the
    /// copy rule, and taken from a peer's withdrawn row by a genesis that missed it.
    #[test]
    fn another_genesis_takes_the_wallet_unbind_from_its_own_signature() {
        let n = node();
        let t = now();
        let phone = keys();
        let (a, _da) = storage();
        register(&a, &n);
        bind(&a, &n, &phone, t - 60);
        let proof = check_unbind(&a, &wreq(&n, &n.wallet, &n.wallet.hex, t - 60, t), t).unwrap();
        apply_unbind(&a, None, &proof, true, t).unwrap();
        let wire: UnbindProof = serde_json::from_str(&serde_json::to_string(&proof).unwrap()).unwrap();
        assert_eq!(wire, proof, "the proof survives the wire");

        // B holds the same binding: withdrawn, and a second copy changes nothing.
        let (b, _db) = storage();
        register(&b, &n);
        bind(&b, &n, &phone, t - 60);
        verify_unbind_proof(&b, &proof).expect("verified at B");
        assert_eq!(apply_unbind(&b, None, &proof, false, t).map(|(r, c)| (r.floor, c)), Ok((t - 60, true)));
        assert!(b.get_fcm_entry(&n.id).is_none());
        assert_eq!(apply_unbind(&b, None, &proof, false, t).map(|(_, c)| c), Ok(false));
        // C missed the binding and holds an older one: withdrawn up to the unbind's sequence.
        let (c, _dc) = storage();
        register(&c, &n);
        bind(&c, &n, &keys(), t - 600);
        verify_unbind_proof(&c, &proof).unwrap();
        assert_eq!(apply_unbind(&c, None, &proof, false, t).map(|(r, _)| r.floor), Ok(t - 60));
        // D already holds a newer binding: left alone.
        let (d, _dd) = storage();
        register(&d, &n);
        bind(&d, &n, &keys(), t);
        assert_eq!(apply_unbind(&d, None, &proof, false, t).err(), Some(Refusal::StaleSeq));
        assert!(d.get_light_binding(&n.id).unwrap().device_bound());

        // A forged copy is refused: another sequence, another key, a device key or delegation riding along.
        let mut moved = proof.clone();
        moved.seq = t;
        assert_eq!(verify_unbind_proof(&d, &moved), Err(Refusal::BadSignature));
        let other = node();
        let mut foreign = proof.clone();
        foreign.identity_pubkey = other.wallet.hex.clone();
        foreign.sig = sign(&other.wallet, &lb::light_unbind_wallet_message(&n.id, t - 60, t));
        assert_eq!(verify_unbind_proof(&d, &foreign), Err(Refusal::IdentityMismatch));
        let mut carried = proof.clone();
        carried.ping_pubkey = phone.hex.clone();
        assert_eq!(verify_unbind_proof(&d, &carried), Err(Refusal::BadRequest));
        let (e, _de) = storage();
        assert_eq!(verify_unbind_proof(&e, &proof), Err(Refusal::NotRegistered));

        // What A's identity pull serves for the withdrawn row carries the signer, and a genesis that missed the
        // unbind takes it from there.
        let served = crate::rpc::light_ping_keys_answer(&a.get_light_binding(&n.id).unwrap()).expect("served");
        assert_eq!(served["unbind"]["signer"], json!("wallet"));
        let (f, _df) = storage();
        register(&f, &n);
        bind(&f, &n, &phone, t - 60);
        let pulled = pulled_unbind(&n.id, &served).expect("the unbind rides with the row");
        assert_eq!(pulled, proof);
        verify_unbind_proof(&f, &pulled).expect("re-verified from K's own signature");
        assert_eq!(apply_unbind(&f, None, &pulled, false, t).map(|(r, c)| (r.floor, c)), Ok((t - 60, true)));
        assert!(!f.get_light_binding(&n.id).unwrap().device_bound());
        // A ping-key row is served as before, with no signer.
        let (g, _dg) = storage();
        register(&g, &n);
        bind(&g, &n, &phone, t - 60);
        let p = check_unbind(&g, &req(&n, "ping", &phone, t - 60, t), t).unwrap();
        apply_unbind(&g, None, &p, true, t).unwrap();
        let served = crate::rpc::light_ping_keys_answer(&g.get_light_binding(&n.id).unwrap()).unwrap();
        assert!(served["unbind"].get("signer").is_none());
        assert_eq!(pulled_unbind(&n.id, &served).map(|u| u.signer), Some("ping".to_string()));
    }


    #[test]
    fn another_genesis_takes_the_unbind_from_its_own_signature() {
        let n = node();
        let t = now();
        let phone = keys();
        let (a, _da) = storage();
        register(&a, &n);
        bind(&a, &n, &phone, t - 60);
        let proof = check_unbind(&a, &req(&n, "ping", &phone, t - 60, t), t).unwrap();
        apply_unbind(&a, None, &proof, true, t).unwrap();

        // B holds the same binding: withdrawn.
        let (b, _db) = storage();
        register(&b, &n);
        bind(&b, &n, &phone, t - 60);
        verify_unbind_proof(&b, &proof).expect("verified at B");
        assert_eq!(apply_unbind(&b, None, &proof, false, t).map(|(r, c)| (r.floor, c)), Ok((t - 60, true)));
        assert!(b.get_fcm_entry(&n.id).is_none());
        assert_eq!(apply_unbind(&b, None, &proof, false, t).map(|(_, c)| c), Ok(false), "a second copy changes nothing");

        // C missed the binding and holds an older one: withdrawn too, since the device's delegation shows it
        // was bound at that sequence.
        let (c, _dc) = storage();
        register(&c, &n);
        bind(&c, &n, &keys(), t - 600);
        verify_unbind_proof(&c, &proof).unwrap();
        assert_eq!(apply_unbind(&c, None, &proof, false, t).map(|(r, _)| r.floor), Ok(t - 60));

        // D already holds a newer binding: the older unbind leaves it alone.
        let (d, _dd) = storage();
        register(&d, &n);
        let new_phone = keys();
        bind(&d, &n, &new_phone, t);
        assert_eq!(apply_unbind(&d, None, &proof, false, t).err(), Some(Refusal::StaleSeq));
        assert!(d.get_light_binding(&n.id).unwrap().device_bound());

        // A forged copy is refused: a signature over another sequence, a delegation under another key.
        let mut forged = proof.clone();
        forged.sig = sign(&phone, &lb::light_unbind_message(&n.id, t - 60, t + 1));
        assert_eq!(verify_unbind_proof(&d, &forged), Err(Refusal::BadSignature));
        let mallory = keys();
        let mut foreign = proof.clone();
        foreign.ping_pubkey = mallory.hex.clone();
        foreign.delegation_cert = lb::format_v2_cert(t - 60, &sign(&mallory, &lb::delegation_v2_message(&mallory.hex, &n.id, t - 60)));
        foreign.sig = sign(&mallory, &lb::light_unbind_message(&n.id, t - 60, t));
        assert_eq!(verify_unbind_proof(&d, &foreign), Err(Refusal::BadSignature));
        let mut wrong_k = proof.clone();
        wrong_k.identity_pubkey = mallory.hex.clone();
        assert_eq!(verify_unbind_proof(&d, &wrong_k), Err(Refusal::IdentityMismatch));
        // A genesis that has not applied the registration cannot check it yet.
        let (e, _de) = storage();
        assert_eq!(verify_unbind_proof(&e, &proof), Err(Refusal::NotRegistered));
        // The proof survives the wire unchanged.
        let wire: UnbindProof = serde_json::from_str(&serde_json::to_string(&proof).unwrap()).unwrap();
        assert_eq!(wire, proof);
    }

    /// A genesis that missed the unbind takes it from a peer's withdrawn row, as the identity pull serves
    /// it, and only when it verifies.
    #[test]
    fn a_missed_unbind_is_taken_from_a_peers_withdrawn_row() {
        let n = node();
        let t = now();
        let phone = keys();
        let (a, _da) = storage();
        register(&a, &n);
        bind(&a, &n, &phone, t - 60);
        let proof = check_unbind(&a, &req(&n, "ping", &phone, t - 60, t), t).unwrap();
        apply_unbind(&a, None, &proof, true, t).unwrap();
        // What A's identity pull serves for the node.
        let served = crate::rpc::light_ping_keys_answer(&a.get_light_binding(&n.id).unwrap()).expect("a withdrawn row is served");
        assert_eq!((served["floor"].as_u64(), served["ping_pubkey"].as_str()), (Some(t - 60), Some("")));

        let (b, _db) = storage();
        register(&b, &n);
        bind(&b, &n, &phone, t - 60);
        let pulled = pulled_unbind(&n.id, &served).expect("the unbind rides with the row");
        assert_eq!(pulled, proof);
        verify_unbind_proof(&b, &pulled).expect("re-verified from the device's own signature");
        assert_eq!(apply_unbind(&b, None, &pulled, false, t).map(|(r, c)| (r.floor, c)), Ok((t - 60, true)));
        assert!(!b.get_light_binding(&n.id).unwrap().device_bound());

        // A served row whose unbind was tampered with changes nothing.
        let (c, _dc) = storage();
        register(&c, &n);
        bind(&c, &n, &phone, t - 60);
        let mut tampered = served.clone();
        tampered["floor"] = json!(t - 59);
        let p = pulled_unbind(&n.id, &tampered).unwrap();
        assert!(verify_unbind_proof(&c, &p).is_err());
        // A bound row carries no unbind to take.
        assert!(pulled_unbind(&n.id, &crate::rpc::light_ping_keys_answer(&c.get_light_binding(&n.id).unwrap()).unwrap()).is_none());
    }

    /// U16: the internal routes (push tokens, bindings, unbinds) answer the genesis addresses only. A
    /// request that reaches the node as loopback came through a terminator that passed no client on.
    #[test]
    fn internal_routes_answer_genesis_callers_only() {
        for (ip, _) in crate::genesis_constants::GENESIS_NODE_IPS {
            assert!(is_genesis_peer_ip(ip), "{ip}");
        }
        for caller in ["127.0.0.1", "::1", "", "10.0.0.1", "172.17.0.1", "195.246.231.53"] {
            assert!(!is_genesis_peer_ip(caller), "{caller}");
        }
    }
}

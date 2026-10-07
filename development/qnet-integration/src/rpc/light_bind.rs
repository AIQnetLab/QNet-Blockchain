//! `POST /api/v1/light-node/bind`: a fresh signed binding of a light node to one device (U2), the late
//! delivery of a first binding (U3), and the pending binding of a node whose registration has not
//! applied yet (U4). Policy of the RPC and of the shard owners only; no block rule reads any of it.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` sections 4 and 8.

use super::*;
use crate::light_binding::{self as lb, BindingRow, PendingBind, Refusal};

/// Its `Debug` names the node and the sequence only: the vendor tokens and the device evidence never reach
/// a log line.
#[derive(Default, serde::Deserialize)]
pub(super) struct LightNodeBindRequest {
    #[serde(default)] pub(super) node_id: String,
    #[serde(default)] pub(super) wallet_address: String,
    /// The wallet key K, hex (1952 bytes).
    #[serde(default)] pub(super) identity_pubkey: String,
    /// The device's ML-DSA-65 ping key, hex (1952 bytes).
    #[serde(default)] pub(super) ping_pubkey: String,
    /// K's signature over `{chain_tag}delegate_ping:v2:{ping_pubkey}:{node_id}:{seq}`, hex.
    #[serde(default)] pub(super) delegation_cert: String,
    #[serde(default)] pub(super) seq: u64,
    #[serde(default)] pub(super) ts: u64,
    /// K's signature over the attach preimage (light_binding::attach_v2_message), hex.
    #[serde(default)] pub(super) attach_sig: String,
    /// "fcm" (default) | "unifiedpush" | "polling".
    #[serde(default)] pub(super) push_type: Option<String>,
    #[serde(default)] pub(super) device_token: Option<String>,
    #[serde(default)] pub(super) endpoint: Option<String>,
    /// The device's platform, "android" or "ios" (`light_binding::platform_hint`): unsigned, shown by the public
    /// status only; anything else is no platform, and a bind is never refused for it.
    #[serde(default)] pub(super) platform: Option<String>,
    /// The device's model, a short marketing name (`light_binding::model_hint`): unsigned and shown by the public
    /// status only, like `platform`; anything else is no model, and a bind is never refused for it.
    #[serde(default)] pub(super) model: Option<String>,
    /// The wallet's registration consent, for a node the chain has not registered yet (U4).
    #[serde(default)] pub(super) consent: Option<BindConsent>,
    /// Device layer (light-node-messages sections 5.3 and 5.5): the enrolment or rebind block and its
    /// vendor token, checked by `light_device::prepare_bind_device` before anything is written. The token
    /// goes to the device oracle only; it is never logged, stored or sent to another genesis.
    #[serde(default)] pub(super) device: Option<serde_json::Value>,
    #[serde(default)] pub(super) dc_token: Option<String>,
    #[serde(default)] pub(super) pi_token: Option<String>,
}

impl std::fmt::Debug for LightNodeBindRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LightNodeBindRequest").field("node_id", &self.node_id).field("seq", &self.seq)
            .field("device", &self.device.is_some()).finish_non_exhaustive()
    }
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub(super) struct BindConsent {
    #[serde(default)] pub(super) burn_tx: String,
    #[serde(default)] pub(super) registration_proof: String,
    /// T: the consent's timestamp, which the sheet also uses as the binding's seq and ts.
    #[serde(default)] pub(super) timestamp: u64,
    /// K's signature over `{chain_tag}client_node_reg:{N}:{W}:{proof}:{T}`, hex.
    #[serde(default)] pub(super) consent_sig: String,
}

/// A verified binding ready to be recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FreshBinding {
    pub(crate) node_id: String,
    pub(crate) wallet: String,
    pub(crate) identity_pk: String,
    pub(crate) ping_pk: String,
    pub(crate) cert_sig: String,
    pub(crate) attach_sig: String,
    pub(crate) seq: u64,
    pub(crate) ts: u64,
    pub(crate) push_type: &'static str,
    pub(crate) token: String,
    pub(crate) endpoint: Option<String>,
    /// The binding this genesis already holds, sent again (its key at its sequence).
    pub(crate) resend: bool,
    /// The device's platform hint (`light_binding::platform_hint`), "" when the bind named none.
    pub(crate) platform: &'static str,
    /// The device's model hint (`light_binding::model_hint`), "" when the bind named none.
    pub(crate) model: String,
}

#[derive(Debug)]
pub(super) enum BindPath {
    /// The node is on chain: record the binding now.
    Fresh(FreshBinding),
    /// The registration has not applied: keep the binding until it does.
    Pending(PendingBind),
}

/// The consent a registration carries, checked with the verifier admission and block validation use
/// (`verify_node_lifecycle_dilithium` over the canonical client form).
pub(crate) fn consent_verifies(node_id: &str, wallet: &str, proof: &str, timestamp: u64, sig_hex: &str, identity_pk_hex: &str) -> bool {
    let (Ok(sig), Ok(pk)) = (hex::decode(sig_hex), hex::decode(identity_pk_hex)) else { return false; };
    let mut tx = crate::node::BlockchainNode::create_node_registration_tx_with_timestamp(
        node_id, qnet_state::NodeType::Light, wallet, proof, "", Some(timestamp));
    tx.data = Some(qnet_state::Transaction::client_registration_data(node_id, wallet, proof));
    tx.dilithium_signature = Some(sig);
    tx.dilithium_public_key = Some(pk);
    crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&tx)
}

/// Lowercase hex of the given length: the keys are written into preimages as text, so one spelling.
fn is_hex_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Everything `/bind` checks before it writes: shapes, the identity (node = pseudonym of the wallet, the
/// wallet = EON of the key, the key = the chain's commitment), the bounds that read only the clock, the
/// signatures, and only then the rules that read the stored binding. A caller without the wallet key's
/// signatures therefore learns nothing about the stored sequence or floor (every such request answers
/// `bad_signature`). Reads storage, writes nothing.
pub(super) fn check_bind(storage: &crate::storage::Storage, req: &LightNodeBindRequest, onchain: bool, now: u64) -> Result<BindPath, Refusal> {
    if !req.node_id.starts_with("light_") || req.wallet_address.is_empty() {
        return Err(Refusal::IdentityMismatch);
    }
    if !is_hex_len(&req.identity_pubkey, lb::MLDSA65_PK_HEX) || !is_hex_len(&req.ping_pubkey, lb::MLDSA65_PK_HEX)
        || !is_hex_len(&req.delegation_cert, lb::MLDSA65_SIG_HEX) || !is_hex_len(&req.attach_sig, lb::MLDSA65_SIG_HEX) {
        return Err(Refusal::BadSignature);
    }
    let push_type = lb::canonical_push_type(req.push_type.as_deref());
    // The record keeps exactly what the attach signs: the token for FCM, the endpoint for
    // UnifiedPush, nothing for polling.
    let (token, endpoint) = match push_type {
        "fcm" => (req.device_token.clone().unwrap_or_default(), None),
        "unifiedpush" => (String::new(), req.endpoint.clone().filter(|e| !e.is_empty())),
        _ => (String::new(), None),
    };
    if token.len() > 4096 || endpoint.as_ref().map_or(false, |e| e.len() > 2048) {
        return Err(Refusal::BadRequest);
    }
    match push_type {
        "unifiedpush" => match &endpoint {
            Some(e) if validate_unified_push_endpoint(e).is_ok() => {}
            _ => return Err(Refusal::BadRequest),
        },
        "fcm" if token.is_empty() => return Err(Refusal::BadRequest),
        _ => {}
    }
    if generate_light_node_pseudonym(&req.wallet_address) != req.node_id {
        return Err(Refusal::IdentityMismatch);
    }
    if crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&req.identity_pubkey).as_deref()
        != Some(req.wallet_address.as_str()) {
        return Err(Refusal::IdentityMismatch);
    }
    let target = lb::push_target(push_type, &token, endpoint.as_deref()).to_string();
    let platform = lb::platform_hint(req.platform.as_deref());
    let model = lb::model_hint(req.model.as_deref()).to_string();
    let signatures_hold = |seq: u64, ts: u64| -> bool {
        crate::rpc::verify_mobile_dilithium_signature(
            &lb::delegation_v2_message(&req.ping_pubkey, &req.node_id, seq), &req.delegation_cert, &req.identity_pubkey)
            && lb::attach_v2_message(&req.node_id, &req.ping_pubkey, &target, seq, ts)
                .map_or(false, |m| crate::rpc::verify_mobile_dilithium_signature(&m, &req.attach_sig, &req.identity_pubkey))
    };

    if onchain {
        let committed = storage.resolve_light_identity_pk(&req.node_id, Some(&req.identity_pubkey))
            .map_or(false, |k| k.eq_ignore_ascii_case(&req.identity_pubkey));
        if !committed { return Err(Refusal::IdentityMismatch); }
        // The bounds that read only the clock; the grace below never reaches past them.
        if req.seq == 0 { return Err(Refusal::StaleSeq); }
        if req.seq > now.saturating_add(lb::FUTURE_SEQ_SLACK_SECS) { return Err(Refusal::FutureSeq); }
        if req.ts > now.saturating_add(lb::FRESH_TS_WINDOW_SECS) { return Err(Refusal::Expired); }
        if !signatures_hold(req.seq, req.ts) { return Err(Refusal::BadSignature); }
        let stored = storage.get_light_binding(&req.node_id);
        // A re-send of the stored binding (its key at its sequence) answers bound at any age: it
        // changes nothing, and its push record never displaces a later refresh (signed-time order).
        let resend = lb::admit_fresh(stored.as_ref(), &req.ping_pubkey, req.seq, now)?;
        if !resend { lb::admit_attach_ts(stored.as_ref(), req.seq, req.ts, now)?; }
        return Ok(BindPath::Fresh(FreshBinding {
            node_id: req.node_id.clone(),
            wallet: req.wallet_address.clone(),
            identity_pk: req.identity_pubkey.clone(),
            ping_pk: req.ping_pubkey.clone(),
            cert_sig: req.delegation_cert.clone(),
            attach_sig: req.attach_sig.clone(),
            seq: req.seq,
            ts: req.ts,
            push_type,
            token,
            endpoint,
            resend,
            platform,
            model,
        }));
    }

    // U4: not on chain. Only a binding that comes with the wallet's own registration consent is kept,
    // and the sheet signs all three with T: seq = ts = T.
    let consent = match &req.consent { Some(c) => c, None => return Err(Refusal::NotRegistered) };
    if consent.burn_tx.len() > 100
        || bs58::decode(&consent.burn_tx).into_vec().map(|v| v.len()) != Ok(64) {
        return Err(Refusal::BadRequest);
    }
    let t = consent.timestamp;
    if req.seq != t || req.ts != t { return Err(Refusal::BadRequest); }
    if req.seq > now.saturating_add(lb::FUTURE_SEQ_SLACK_SECS) { return Err(Refusal::FutureSeq); }
    // The window the submit door applies to the same consent (registration_door::check_client_submit).
    if !lb::consent_ts_in_window(t, now) {
        return Err(Refusal::Expired);
    }
    let proof = blake3::hash(format!("{}:{}:{}", consent.burn_tx, req.node_id, req.wallet_address).as_bytes())
        .to_hex()[..32].to_string();
    if consent.registration_proof != proof || !is_hex_len(&consent.consent_sig, lb::MLDSA65_SIG_HEX) {
        return Err(Refusal::BadSignature);
    }
    if !consent_verifies(&req.node_id, &req.wallet_address, &proof, t, &consent.consent_sig, &req.identity_pubkey) {
        return Err(Refusal::BadSignature);
    }
    if !signatures_hold(req.seq, req.ts) { return Err(Refusal::BadSignature); }
    let dec = |h: &str| hex::decode(h).unwrap_or_default();
    Ok(BindPath::Pending(PendingBind {
        node_id: req.node_id.clone(),
        wallet: req.wallet_address.clone(),
        identity_pk: dec(&req.identity_pubkey),
        ping_pk: dec(&req.ping_pubkey),
        cert_sig: dec(&req.delegation_cert),
        attach_sig: dec(&req.attach_sig),
        seq: req.seq,
        ts: req.ts,
        push_type: push_type.to_string(),
        token,
        endpoint,
        burn_tx: consent.burn_tx.clone(),
        consent_ts: t,
        stored_at: now,
        platform: platform.to_string(),
        model,
    }))
}

/// Sliding-window limit per key: a node id, applied after the signatures verified (an IP is not a
/// device: a carrier NAT fronts thousands of them), or a client address where only an address is known.
pub(super) struct KeyedLimiter {
    max: usize,
    window: u64,
    map: std::sync::OnceLock<DashMap<String, Vec<u64>>>,
    swept: std::sync::atomic::AtomicU64,
}

impl KeyedLimiter {
    pub(super) const fn new(max: usize, window: u64) -> Self {
        KeyedLimiter { max, window, map: std::sync::OnceLock::new(), swept: std::sync::atomic::AtomicU64::new(0) }
    }

    /// Spend one slot of `key`'s window if one is free. Past 100k keys the idle ones are swept at most once a
    /// minute, not on every call (a flood of fresh keys made each call a full pass).
    pub(super) fn allows(&self, key: &str, now: u64) -> bool {
        let map = self.map.get_or_init(DashMap::new);
        let cutoff = now.saturating_sub(self.window);
        if map.len() > 100_000 {
            let last = self.swept.load(std::sync::atomic::Ordering::Relaxed);
            if now.saturating_sub(last) >= 60
                && self.swept.compare_exchange(last, now, std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed).is_ok()
            {
                map.retain(|_, v| v.last().map_or(false, |t| *t > cutoff));
            }
        }
        let mut e = map.entry(key.to_string()).or_default();
        e.retain(|t| *t > cutoff);
        if e.len() >= self.max { return false; }
        e.push(now);
        true
    }

    /// Whether a slot is free, without spending it; Err carries the seconds until one frees. For a
    /// caller that must pass two limits before it spends either.
    pub(super) fn check(&self, key: &str, now: u64) -> Result<(), u64> {
        let Some(map) = self.map.get() else { return Ok(()); };
        let Some(e) = map.get(key) else { return Ok(()); };
        let cutoff = now.saturating_sub(self.window);
        let live: Vec<u64> = e.iter().copied().filter(|t| *t > cutoff).collect();
        if live.len() < self.max { return Ok(()); }
        let oldest = live.iter().copied().min().unwrap_or(now);
        Err(oldest.saturating_add(self.window).saturating_sub(now).max(1))
    }
}

pub(super) static BIND_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(5, 3600);
pub(super) static TOKEN_REFRESH_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(6, 3600);
/// Pending bindings this node stores per hour, whatever their source: a backstop beside the burn each one needs
/// (`pending_burn_seen`) and the per-network share at the store's cap (M-10).
pub(super) static PENDING_BIND_GLOBAL_LIMIT: KeyedLimiter = KeyedLimiter::new(6_000, 3600);
/// New pending bindings this node holds in memory per hour (`lb::deferred_insert`): a flood turns the memory tier over
/// at most once an hour, so the bindings real users posted before it stay until their registration applies.
pub(super) static DEFERRED_BIND_GLOBAL_LIMIT: KeyedLimiter = KeyedLimiter::new(lb::DEFERRED_CAP, 3600);

/// The address a per-address limit counts a caller under: an IPv4 address (also one mapped into IPv6), an IPv6
/// address by its /64, the block one host is given (L-2).
pub(super) fn light_ip_key(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => { let s = v6.segments(); format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3]) }
        },
    }
}

/// A per-address limit on the light routes' unverified work (bind, unbind, token refresh, pending bind) that only a
/// failed request spends (L-2): one refused by its structural checks or its signatures, or a pending binding with no
/// burn behind it. A request whose signatures verify spends nothing here and is held by its node's own limit, so junk
/// from one host never locks a carrier NAT or a shared Wi-Fi out for long: `max` failures in `window` seconds block
/// the address for `block` seconds, like the ping route's wide, short limit. Keyed by `light_ip_key`.
pub(super) struct FailLimiter {
    max: usize,
    window: u64,
    block: u64,
    /// address -> (times of its failures in the window, blocked until).
    map: std::sync::OnceLock<DashMap<String, (Vec<u64>, u64)>>,
    swept: std::sync::atomic::AtomicU64,
}

impl FailLimiter {
    pub(super) const fn new(max: usize, window: u64, block: u64) -> Self {
        FailLimiter { max, window, block, map: std::sync::OnceLock::new(), swept: std::sync::atomic::AtomicU64::new(0) }
    }

    /// Seconds the caller still waits, None when it may try. A whitelisted address (`is_ip_whitelisted`) and an
    /// unknown one are never held. Spends nothing.
    pub(super) fn blocked(&self, remote: Option<std::net::SocketAddr>, now: u64) -> Option<u64> {
        let ip = remote.map(|a| a.ip()).filter(|ip| !is_ip_whitelisted(*ip))?;
        let map = self.map.get()?;
        let e = map.get(&light_ip_key(ip))?;
        (e.1 > now).then(|| e.1 - now)
    }

    /// The caller's request failed: one failure, and the block once there are `max` in the window.
    pub(super) fn charge(&self, remote: Option<std::net::SocketAddr>, now: u64) {
        let Some(ip) = remote.map(|a| a.ip()).filter(|ip| !is_ip_whitelisted(*ip)) else { return; };
        let map = self.map.get_or_init(DashMap::new);
        let cutoff = now.saturating_sub(self.window);
        if map.len() > 100_000 {
            let last = self.swept.load(std::sync::atomic::Ordering::Relaxed);
            if now.saturating_sub(last) >= 60
                && self.swept.compare_exchange(last, now, std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed).is_ok()
            {
                map.retain(|_, (times, until)| *until > now || times.last().map_or(false, |t| *t > cutoff));
            }
        }
        let mut e = map.entry(light_ip_key(ip)).or_default();
        e.0.retain(|t| *t > cutoff);
        e.0.push(now);
        if e.0.len() >= self.max {
            e.1 = now + self.block;
            e.0.clear();
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] light_route_address_blocked addr={} secs={}", light_ip_key(ip), self.block);
            }
        }
    }
}

/// Failures one address may make on each route before a short block (`FailLimiter`).
const ROUTE_FAILS_MAX: usize = 60;
const ROUTE_FAILS_WINDOW_SECS: u64 = 60;
const ROUTE_FAILS_BLOCK_SECS: u64 = 60;
pub(super) static BIND_FAIL_LIMIT: FailLimiter = FailLimiter::new(ROUTE_FAILS_MAX, ROUTE_FAILS_WINDOW_SECS, ROUTE_FAILS_BLOCK_SECS);
pub(super) static UNBIND_FAIL_LIMIT: FailLimiter = FailLimiter::new(ROUTE_FAILS_MAX, ROUTE_FAILS_WINDOW_SECS, ROUTE_FAILS_BLOCK_SECS);
pub(super) static TOKEN_REFRESH_FAIL_LIMIT: FailLimiter =
    FailLimiter::new(ROUTE_FAILS_MAX, ROUTE_FAILS_WINDOW_SECS, ROUTE_FAILS_BLOCK_SECS);

/// A pending binding is stored only for a burn this genesis has evidence of (M-10): it attested that burn for this very
/// node, or the pool holds the node's registration, or a submit for it is collecting attestations here. Fresh keys and
/// a random burn signature then store nothing; such a binding is at most held in memory (`lb::deferred_insert`).
pub(super) fn pending_burn_seen(storage: &crate::storage::Storage, p: &PendingBind, now: u64) -> bool {
    storage.attested_burn_get(&p.burn_tx).ok().flatten().as_deref() == Some(p.node_id.as_str())
        || pending_registration_tx(&p.node_id).is_some()
        || submit_in_flight(&p.node_id, now)
}

/// The answer to a pending binding held nowhere for now (no burn seen while a device step is asked, or an hourly
/// budget spent): a refusal the app sends again later (`rate_limited` with `retry_after_seconds`), never a final one.
/// Once the chain lists the node, the same binding is taken as a fresh one.
pub(super) fn pending_later_json(retry_after: u64) -> serde_json::Value {
    let mut v = Refusal::RateLimited.to_json();
    v["error"] = json!("The binding is not held here for now; it is sent again later");
    v["retry_after_seconds"] = json!(retry_after);
    v
}

/// The wait `pending_later_json` names: a minute, about the time a submit takes to reach the pool.
const PENDING_LATER_SECS: u64 = 60;

pub(super) fn our_genesis_ip() -> String {
    let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
    crate::genesis_constants::GENESIS_NODE_IPS.iter().find(|(_, id)| *id == bid)
        .map(|(ip, _)| ip.to_string()).unwrap_or_default()
}

/// Record a verified binding here and send it on (U2's effect): the binding row, this device's push
/// record under the binding's sequence (the old device's token is overwritten, or dropped when this
/// device has none), the resident push channel, the RPC device list, gossip, and the token sync to the
/// other genesis nodes with the device's proof. Ok carries the stored row.
pub(crate) fn apply_fresh_binding(
    storage: &crate::storage::Storage,
    p2p: Option<&crate::unified_p2p::SimplifiedP2P>,
    b: &FreshBinding,
    now: u64,
) -> Result<BindingRow, Refusal> {
    let before = storage.get_light_binding(&b.node_id);
    let row = match storage.bind_light_v2(&b.node_id, &b.ping_pk, &b.cert_sig, &b.identity_pk, b.seq, now) {
        Ok(Ok(row)) => row,
        Ok(Err(r)) => return Err(r),
        Err(e) => {
            println!("[WARN][LIGHT] bind_store_failed node={} err={}", b.node_id, e);
            return Err(Refusal::BadRequest);
        }
    };
    let row_unchanged = before.as_ref() == Some(&row);
    // A re-send of what this genesis already holds (the app posts to two owners, gossip and the token
    // sync may arrive first, a retry after a lost answer) writes nothing and is not sent on again, unless it
    // names the platform or the model a record without one lacks.
    let push_held = storage.get_fcm_entry(&b.node_id).map_or(false, |e| e.seq == b.seq && e.token == b.token
        && e.push_type == b.push_type && e.endpoint == b.endpoint && (b.platform.is_empty() || !e.platform.is_empty())
        && (b.model.is_empty() || !e.model.is_empty()));
    if row_unchanged && push_held {
        return Ok(row);
    }
    // A v2 push record is ordered by (seq, the signed time of the message that set it): the attach
    // here, the token refresh later. A replayed attach therefore never takes back a channel a later
    // refresh of the same binding set, here or at any peer.
    let record_ts = b.ts;
    match storage.save_fcm_token_seq_platform(&b.node_id, &b.token, b.push_type, b.endpoint.as_deref(), record_ts, b.seq, b.platform, &b.model) {
        Ok(true) => {}
        // Older than the channel this binding already has: the replay of an earlier attach.
        Ok(false) if row_unchanged => return Ok(row),
        Ok(false) => {}
        Err(e) => println!("[WARN][LIGHT] bind_push_record_failed node={} err={}", b.node_id, e),
    }
    let push_type = match b.push_type {
        "unifiedpush" => crate::unified_p2p::PushType::UnifiedPush,
        "polling" => crate::unified_p2p::PushType::Polling,
        _ => crate::unified_p2p::PushType::FCM,
    };
    if let Some(p2p) = p2p {
        p2p.refresh_light_node_push_channel(storage, &b.node_id);
        p2p.gossip_light_binding(&b.node_id, &b.wallet, &b.identity_pk, &b.ping_pk, &row.cert, push_type, now);
    }
    // One binding, one device: the list names this device only.

    if let Some(node) = LIGHT_NODE_REGISTRY.lock().get_mut(&b.node_id) {
        node.devices = vec![LightNodeDevice {
            wallet_address: b.wallet.clone(),
            device_token_hash: String::new(),
            device_id: row.device_fp.clone(),
            last_active: now,
            is_active: true,
        }];
    }
    let proof = TokenSyncProof {
        identity_pubkey: b.identity_pk.clone(),
        ping_pubkey: b.ping_pk.clone(),
        delegation_cert: row.cert.clone(),
        kind: "attach".to_string(),
        sig: b.attach_sig.clone(),
        sig_ts: b.ts,
    };
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let (node, token, pt, endpoint, seq) = (b.node_id.clone(), b.token.clone(), b.push_type.to_string(), b.endpoint.clone(), b.seq);
        let our_ip = our_genesis_ip();
        let (platform, model) = (b.platform, b.model.clone());
        handle.spawn(async move {
            sync_fcm_token_to_genesis_peers(&node, &token, &pt, endpoint.as_deref(), &our_ip, record_ts, seq, Some(proof), "", platform, &model).await;
        });
    }
    Ok(row)
}

/// The key under which `/bind` keeps the answer to a request with a device block: its nonce and a digest of
/// the whole request, and only when the block's stamp is one this genesis issued for this node's enrolment
/// and has not expired (`issuer`: this genesis while it serves the device layer). A request whose stamp does
/// not verify is neither looked up nor kept, and another body under the same nonce is answered on its own,
/// so neither decides the answer the real message gets.
pub(super) fn device_answer_key(req: &LightNodeBindRequest, issuer: Option<&str>, now: u64) -> Option<String> {
    let d = req.device.as_ref()?;
    let field = |k: &str| d.get(k).and_then(|x| x.as_str());
    let (nonce, stamp) = (field("nonce")?, field("stamp")?);
    if !crate::light_device::stamp::verify(issuer?, &req.node_id, crate::light_device::Purpose::Enrol, nonce, stamp, now) {
        return None;
    }
    let opt = |s: &Option<String>| s.clone().unwrap_or_default();
    let consent = req.consent.as_ref()
        .map(|c| format!("{}|{}|{}|{}", c.burn_tx, c.registration_proof, c.timestamp, c.consent_sig)).unwrap_or_default();
    let parts = [req.node_id.clone(), req.wallet_address.clone(), req.identity_pubkey.clone(), req.ping_pubkey.clone(),
                 req.delegation_cert.clone(), req.seq.to_string(), req.ts.to_string(), req.attach_sig.clone(), opt(&req.push_type),
                 opt(&req.device_token), opt(&req.endpoint), consent, d.to_string(), opt(&req.dc_token), opt(&req.pi_token)];
    let digest = lb::sha3_hex(parts.join("\n").as_bytes());
    Some(format!("{}|{}", nonce, &digest[..32]))
}

/// An answer a retry of the same message may get otherwise, which is therefore not kept: a limit's refusal,
/// or `device_stale` (the quorum or this node's context not reached; the app asks for a new challenge).
pub(super) fn transient_answer(v: &serde_json::Value) -> bool {
    v["success"].as_bool() == Some(false)
        && matches!(v["reason"].as_str(), Some("device_stale" | "device_rate_limited" | "rate_limited"))
}

pub(super) async fn handle_light_node_bind(
    req: LightNodeBindRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    // The address's budget of failed requests (L-2): a request that verifies spends none of it.
    if let Some(wait) = BIND_FAIL_LIMIT.blocked(remote_addr, now) {
        let mut v = Refusal::RateLimited.to_json();
        v["retry_after_seconds"] = json!(wait);
        return Ok(warp::reply::json(&v));
    }
    let storage = blockchain.get_storage();
    let onchain = storage.is_node_registration_onchain(&req.node_id);
    let source = lb::pending_source_key(remote_addr.map(|a| a.ip()));
    let path = match check_bind(&storage, &req, onchain, now) {
        Ok(p) => p,
        Err(r) => {
            BIND_FAIL_LIMIT.charge(remote_addr, now);
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] bind_refused node={} reason={}", req.node_id, r.as_str());
            }
            return Ok(warp::reply::json(&r.to_json()));
        }
    };
    // M-10: a pending binding is stored only for a burn this genesis has evidence of. With none (the QNet Link sheet
    // posts its binding before the site submits the registration) it is held in memory only, and promoted when the
    // chain applies the registration (`lb::deferred_insert`). While this genesis serves the device layer such a binding
    // is sent again later instead, so no device work is spent on it; once the chain lists the node it is taken as a
    // fresh one. A re-send of what is pending already stores nothing and needs no evidence.
    let mut in_memory = false;
    if let BindPath::Pending(p) = &path {
        if lb::pending_admits(&storage, p, now) == Ok(false) && !pending_burn_seen(&storage, p, now) {
            BIND_FAIL_LIMIT.charge(remote_addr, now);
            if crate::light_device::device_layer_served() {
                if crate::node::is_info() {
                    println!("[INFO][LIGHT] pending_bind_deferred node={} reason=no_burn_seen", p.node_id);
                }
                return Ok(warp::reply::json(&pending_later_json(PENDING_LATER_SECS)));
            }
            in_memory = true;
        }
    }
    // The device block (light-node-messages section 5.3): a replay of a message this genesis answered gets
    // that answer again, with no vendor call and no attestor round (`device_answer_key`).
    let issuer = crate::light_device::serving_genesis_id();
    let answer_key = device_answer_key(&req, issuer.as_deref(), now);
    if let Some(answer) = answer_key.as_deref().and_then(|k| DEVICE_ANSWERS.get(&req.node_id, k, now)) {
        return Ok(warp::reply::json(&answer));
    }
    let answer = |v: serde_json::Value| {
        if let Some(k) = answer_key.as_deref().filter(|_| !transient_answer(&v)) {
            DEVICE_ANSWERS.put(&req.node_id, k, v.clone(), now);
        }
        warp::reply::json(&v)
    };
    let epoch = crate::light_device::current_epoch();
    let prepared = match prepare_bind_device(&storage, &req, matches!(path, BindPath::Fresh(_)),
        issuer.as_deref(), crate::light_device::evidence::Verifier::production(),
        remote_addr, now, epoch)
    {
        Ok(p) => p,
        Err(r) => {
            if crate::node::is_info() {
                println!("[INFO][DEVICE] bind_device_refused node={} reason={}", req.node_id, r.as_str());
            }
            return Ok(answer(r.to_json()));
        }
    };
    // The node's budget is spent only by a request that changes something. A re-send of what this
    // genesis holds (the app's post to two owners, its U3 re-send, a replay by anyone who saw the
    // request) answers without it, and a replay of an earlier binding is refused before it, so replays
    // cannot lock the device out of a real change.
    let changes = match &path {
        BindPath::Fresh(b) => !b.resend,
        BindPath::Pending(p) => match lb::pending_admits(&storage, p, now) {
            Ok(holds) if !in_memory => !holds,
            // Held in memory: the memory tier's own rule.
            Ok(_) => match lb::deferred_admits(p, now) {
                Ok(holds) => !holds,
                Err(r) => return Ok(answer(r.to_json())),
            },
            Err(r) => return Ok(answer(r.to_json())),
        },
    } || prepared.as_ref().map_or(false, |p| p.held.is_none());
    if changes && !BIND_NODE_LIMIT.allows(&req.node_id, now) {
        return Ok(answer(Refusal::RateLimited.to_json()));
    }
    // The node-wide backstops on what the pending store takes, past the burn each entry needs, and on what the memory
    // tier takes (M-10).
    let budget_spent = || if in_memory { !DEFERRED_BIND_GLOBAL_LIMIT.allows("", now) } else { !PENDING_BIND_GLOBAL_LIMIT.allows("", now) };
    if changes && matches!(path, BindPath::Pending(_)) && budget_spent() {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] pending_bind_deferred node={} reason=hourly_budget_spent in_memory={}", req.node_id, in_memory);
        }
        return Ok(answer(pending_later_json(PENDING_LATER_SECS)));
    }
    // The device first: a device that cannot prove its hardware binds nothing. A step still running at the
    // budget leaves the binding taken with a provisional record, which its final statement replaces.
    let device = match prepared {
        None => None,
        Some(p) if p.held.is_some() => p.held.clone(),
        Some(p) => match DeviceCtx::of(&blockchain) {
            None => return Ok(answer(crate::light_device::StepRefusal::device(crate::light_device::DeviceReason::Stale).to_json())),
            Some(ctx) => match run_device_step(ctx, p, BIND_DEVICE_BUDGET).await {
                StepAnswer::Final(r) | StepAnswer::Waiting(r) => Some(*r),
                StepAnswer::Refused(r) => {
                    if crate::node::is_info() {
                        println!("[INFO][DEVICE] bind_device_refused node={} reason={}", req.node_id, r.as_str());
                    }
                    return Ok(answer(r.to_json()));
                }
            },
        },
    };
    let with_device = |mut v: serde_json::Value| {
        if let Some(d) = &device {
            let registered = storage.is_node_registration_onchain(&d.node_id);
            v["device_state"] = d.state_now(registered, epoch, now).as_str().into();
            v["effective_epoch"] = d.effective_epoch.into();
        }
        v
    };
    match path {
        BindPath::Fresh(b) => {
            let p2p = blockchain.get_unified_p2p();
            match apply_fresh_binding(&storage, p2p.as_deref(), &b, now) {
                Ok(row) => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] light_bound node={} seq={} device={} push={}",
                                 b.node_id, row.seq, row.device_fp, b.push_type);
                    }
                    Ok(answer(with_device(json!({
                        "success": true, "bound": true, "node_id": b.node_id,
                        "seq": row.seq, "device_fp": row.device_fp,
                    }))))
                }
                Err(r) => Ok(answer(r.to_json())),
            }
        }
        BindPath::Pending(p) => {
            let device_fp = lb::device_fp(&hex::encode(&p.ping_pk)).unwrap_or_default();
            // The store's reads and writes, and a promotion's, run on a blocking thread (M-10), never on a worker
            // of the runtime consensus shares. A binding with no burn seen goes to the memory tier only.
            let inserted = {
                let (storage, p, source) = (storage.clone(), p.clone(), source.clone());
                tokio::task::spawn_blocking(move || -> Result<Option<Result<BindingRow, Refusal>>, Refusal> {
                    if in_memory {
                        lb::deferred_insert(&p, &source, now)?;
                    } else {
                        lb::pending_insert_from(&storage, &p, &source, now)?;
                    }
                    // The registration may have applied between the check and the insert, after its
                    // promotion looked and found nothing: promote now rather than wait for the re-send.
                    Ok(if storage.is_node_registration_onchain(&p.node_id) { promote_pending_binding(&storage, &p.node_id) } else { None })
                }).await.unwrap_or(Err(Refusal::BadRequest))
            };
            match inserted {
                Ok(promoted) => {
                    match promoted {
                        Some(Ok(row)) => return Ok(answer(with_device(json!({
                            "success": true, "bound": true, "node_id": p.node_id,
                            "seq": row.seq, "device_fp": row.device_fp,
                        })))),
                        Some(Err(r)) => return Ok(answer(r.to_json())),
                        // Not on chain yet, or taken by the promotion the apply started, which records it.
                        None => {}
                    }
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] light_bind_pending node={} seq={} device={} held={}", p.node_id, p.seq, device_fp,
                                 if in_memory { "memory" } else { "store" });
                    }
                    Ok(answer(with_device(json!({
                        "success": true, "bound": false, "pending": true, "node_id": p.node_id,
                        "seq": p.seq, "device_fp": device_fp,
                    }))))
                }
                Err(r) => Ok(answer(r.to_json())),
            }
        }
    }
}

/// A registration applied longer ago than this (a boot replay, a catch-up) gets no follow-up beyond the
/// pending promotion: its binding was settled when it first applied.
const APPLIED_FOLLOW_UP_MAX_AGE_SECS: u64 = 3600;
/// The follow-up gossips the binding this long after the apply: the other nodes apply the same block
/// within seconds, and one that has not yet refuses a binding for a node not on chain (H8).
const APPLIED_GOSSIP_DELAY_SECS: u64 = 10;

/// Called for every light registration the chain applies (validator and producer inline apply alike,
/// through `admit_light_from_chain`), with the block's time. Never touches storage or the network on the
/// apply path; a task, off it:
/// - promotes a pending binding (U4), stored or held in memory;
/// - for a registration applied just now, checks a binding this genesis took before the registration
///   applied (the legacy register) against the key the registration committed - dropping one written
///   under another key, with the push record written under that key - then sets the resident push
///   channel to what is pushed (the chain's admission seeds it as polling), and gossips a vouched
///   binding to the node's shard owners, so the peers that refused it while the node was not on chain
///   take it now. The drop is cleanup: every reader judges a legacy row under the commitment anyway
///   (`light_push::device_reach`), so one this check misses (a late apply) links no device either.
pub(crate) fn on_light_registration_applied(node_id: &str, registered_at: u64) {
    let pending = lb::pending_may_contain(node_id) || lb::deferred_may_contain(node_id);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let recent = now.saturating_sub(registered_at) <= APPLIED_FOLLOW_UP_MAX_AGE_SECS;
    if !pending && !recent { return; }
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    let node = node_id.to_string();
    handle.spawn(async move {
        let Some(storage) = crate::node::try_get_storage() else { return; };
        // The pending store's reads and writes, on a blocking thread (M-10).
        if pending {
            let n = node.clone();
            let _ = tokio::task::spawn_blocking(move || promote_pending_binding(storage, &n)).await;
        }
        if !recent { return; }
        let vouched = vouch_local_binding(storage, &node);
        if let Some(p2p) = crate::node::try_get_p2p() {
            p2p.refresh_light_node_push_channel(storage, &node);
        }
        let Some((row, identity)) = vouched else { return; };
        tokio::time::sleep(std::time::Duration::from_secs(APPLIED_GOSSIP_DELAY_SECS)).await;
        // Still the binding held here, and the wallet the chain registered it under.
        if storage.get_light_binding(&node).as_ref() != Some(&row) { return; }
        let Some(wallet) = storage.load_node_registration(&node).ok().flatten().map(|(_, w, _)| w) else { return; };
        let push_type = match push_channel(storage, &node) {
            Some(PushChannel::Fcm(_)) => crate::unified_p2p::PushType::FCM,
            Some(PushChannel::UnifiedPush(_)) => crate::unified_p2p::PushType::UnifiedPush,
            None => crate::unified_p2p::PushType::Polling,
        };
        if let Some(p2p) = crate::node::try_get_p2p() {
            p2p.gossip_light_binding(&node, &wallet, &identity, &row.ping_pubkey, &row.cert, push_type, now);
            if crate::node::is_info() {
                println!("[INFO][LIGHT] binding_gossiped_on_apply node={} v2={}", node, row.v2);
            }
        }
    });
}

/// The binding this genesis holds for a node whose registration just applied, checked against the key
/// the registration committed: Some((row, K)) when a device is bound and its delegation verifies under K.
/// A legacy row whose key or delegation does not verify was written before the registration applied by
/// someone holding another wallet key (the legacy register checks the delegation only under the key the
/// caller presents); it is dropped with the push record written under its key, so neither is left to
/// read as the node's device. A row with no recorded key (an older binary's) is left as it is.
pub(crate) fn vouch_local_binding(storage: &crate::storage::Storage, node_id: &str) -> Option<(BindingRow, String)> {
    let row = storage.get_light_binding(node_id).filter(|b| b.device_bound() && !b.identity_pubkey.is_empty())?;
    let vouched = storage.resolve_light_identity_pk(node_id, Some(&row.identity_pubkey))
        .filter(|k| k.eq_ignore_ascii_case(&row.identity_pubkey)
            && lb::verify_delegation(&row.cert, &row.ping_pubkey, node_id, k).is_some());
    match vouched {
        Some(k) => Some((row, k)),
        None => {
            if !row.v2 && storage.drop_unvouched_light_binding(node_id, &row).unwrap_or(false) && crate::node::is_warn() {
                println!("[WARN][LIGHT] unvouched_binding_dropped node={} reason=key_not_committed", node_id);
            }
            None
        }
    }
}

/// Promote a node's pending binding once its registration applied: the key must be the one the
/// registration committed, and the binding must still be the newest (the app may have re-sent it to
/// the bind route meanwhile). None when nothing was pending.
fn promote_pending_binding(storage: &crate::storage::Storage, node_id: &str) -> Option<Result<BindingRow, Refusal>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    // Stored or held in memory: both are taken out, and of two the later consent wins.
    let p = match (lb::pending_take(storage, node_id, now), lb::deferred_take(node_id, now)) {
        (Some(stored), Some(held)) => if held.seq > stored.seq { held } else { stored },
        (stored, held) => stored.or(held)?,
    };
    let identity = hex::encode(&p.identity_pk);
    let committed = storage.resolve_light_identity_pk(node_id, Some(&identity))
        .map_or(false, |k| k.eq_ignore_ascii_case(&identity));
    if !committed {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] pending_bind_identity_not_committed node={}", node_id);
        }
        return Some(Err(Refusal::IdentityMismatch));
    }
    let b = FreshBinding {
        node_id: p.node_id.clone(),
        wallet: p.wallet.clone(),
        identity_pk: identity,
        ping_pk: hex::encode(&p.ping_pk),
        cert_sig: hex::encode(&p.cert_sig),
        attach_sig: hex::encode(&p.attach_sig),
        seq: p.seq,
        ts: p.ts,
        push_type: lb::canonical_push_type(Some(p.push_type.as_str())),
        token: p.token.clone(),
        endpoint: p.endpoint.clone(),
        resend: false,
        platform: lb::platform_hint(Some(p.platform.as_str())),
        model: lb::model_hint(Some(p.model.as_str())).to_string(),
    };
    let p2p = crate::node::try_get_p2p();
    let result = apply_fresh_binding(storage, p2p.map(|p| p.as_ref()), &b, now);
    match &result {
        Ok(row) => if crate::node::is_info() {
            println!("[INFO][LIGHT] pending_bind_promoted node={} seq={} device={}", node_id, row.seq, row.device_fp);
        },
        Err(r) => if crate::node::is_info() {
            println!("[INFO][LIGHT] pending_bind_dropped node={} reason={}", node_id, r.as_str());
        },
    }
    Some(result)
}

/// The legacy `/light-node/register` may re-attach an on-chain node only while no v2 binding was ever
/// made for it: after that only `/bind` changes the device.
pub(crate) fn legacy_attach_allowed(stored: Option<&BindingRow>) -> bool {
    stored.map_or(true, |b| b.never_v2())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};

    struct Wallet { pk: d3::PublicKey, sk: d3::SecretKey, pk_hex: String, wallet: String, node: String }

    fn wallet() -> Wallet {
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).expect("eon");
        let node = generate_light_node_pseudonym(&wallet);
        Wallet { pk, sk, pk_hex, wallet, node }
    }

    fn sign(sk: &d3::SecretKey, msg: &str) -> String {
        hex::encode(d3::detached_sign(msg.as_bytes(), sk).as_bytes())
    }

    fn storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (s, dir)
    }

    fn register(s: &crate::storage::Storage, w: &Wallet) {
        s.save_node_registration_at_height_burn_vrf(&w.node, "light", &w.wallet, 70.0, 100, "", Some(w.pk.as_bytes()))
            .expect("register");
        assert!(s.is_node_registration_onchain(&w.node));
    }

    /// A device's binding request at `seq`/`ts`, signed by the wallet.
    fn bind_req(w: &Wallet, ping_pk: &str, token: &str, seq: u64, ts: u64) -> LightNodeBindRequest {
        LightNodeBindRequest {
            node_id: w.node.clone(),
            wallet_address: w.wallet.clone(),
            identity_pubkey: w.pk_hex.clone(),
            ping_pubkey: ping_pk.to_string(),
            delegation_cert: sign(&w.sk, &lb::delegation_v2_message(ping_pk, &w.node, seq)),
            seq,
            ts,
            attach_sig: sign(&w.sk, &lb::attach_v2_message(&w.node, ping_pk, token, seq, ts).unwrap()),
            push_type: Some("fcm".into()),
            device_token: Some(token.into()),
            ..Default::default()
        }
    }

    fn ping_key() -> (String, d3::SecretKey) {
        let (pk, sk) = d3::keypair();
        (hex::encode(pk.as_bytes()), sk)
    }

    fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() }

    #[test]
    fn a_newer_binding_wins_and_takes_the_push_channel() {
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp1, _) = ping_key();
        let b1 = match check_bind(&s, &bind_req(&w, &pp1, "tok1", t, t), true, t) {
            Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}"),
        };
        let row = apply_fresh_binding(&s, None, &b1, t).expect("bound");
        assert_eq!((row.seq, row.v2), (t, true));
        assert_eq!(row.cert, lb::format_v2_cert(t, &b1.cert_sig));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.token, e.seq)), Some(("tok1".to_string(), t)));

        // The same binding again (the app posts it to two genesis nodes): accepted, nothing changes.
        let again = match check_bind(&s, &bind_req(&w, &pp1, "tok1", t, t), true, t) {
            Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}"),
        };
        // A re-send spends none of the node's budget, so a replay cannot lock the device out.
        assert!(!b1.resend && again.resend);
        assert_eq!(apply_fresh_binding(&s, None, &again, t).map(|r| r.seq), Ok(t));

        // Another device at a higher seq takes the node and the push channel.
        let (pp2, _) = ping_key();
        let b2 = match check_bind(&s, &bind_req(&w, &pp2, "tok2", t + 1, t), true, t) {
            Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}"),
        };
        apply_fresh_binding(&s, None, &b2, t).expect("taken over");
        let stored = s.get_light_binding(&w.node).unwrap();
        assert_eq!((stored.ping_pubkey.as_str(), stored.seq), (pp2.as_str(), t + 1));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.token, e.seq)), Some(("tok2".to_string(), t + 1)));

        // The first device cannot take it back, neither by bind nor by a copy of its old delegation.
        assert_eq!(check_bind(&s, &bind_req(&w, &pp1, "tok1", t, t), true, t).err(), Some(Refusal::StaleSeq));
        let old_cert = lb::format_v2_cert(t, &b1.cert_sig);
        assert_eq!(s.save_light_ping_keys_identity(&w.node, &pp1, &old_cert, &w.pk_hex).unwrap(),
                   crate::storage::PingKeyWrite::Refused(lb::Admit::Stale), "a heal with a lower seq is refused");
        assert_eq!(s.save_light_ping_keys_identity(&w.node, &pp1, "legacycert", &w.pk_hex).unwrap(),
                   crate::storage::PingKeyWrite::Refused(lb::Admit::V1AfterV2));
        assert_eq!(s.get_light_binding(&w.node).unwrap().ping_pubkey, pp2);
        // A legacy push record never replaces the v2 one.
        assert_eq!(s.save_fcm_token(&w.node, "legacy", "fcm", None, t + 100).unwrap(), false);
        assert!(!legacy_attach_allowed(s.get_light_binding(&w.node).as_ref()), "the legacy register refuses");
    }

    #[test]
    fn bind_refuses_future_stale_expired_foreign_and_forged_requests() {
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp, _) = ping_key();
        // Future seq.
        let r = bind_req(&w, &pp, "tok", t + 601, t);
        assert_eq!(check_bind(&s, &r, true, t).err(), Some(Refusal::FutureSeq));
        // Stale ts outside the window and not a first-binding grace (seq != ts).
        let r = bind_req(&w, &pp, "tok", t, t - 400);
        assert_eq!(check_bind(&s, &r, true, t).err(), Some(Refusal::Expired));
        // A day-old pre-signed first binding (seq = ts) is accepted while the node was never bound...
        let old = t - 23 * 3600;
        let first = match check_bind(&s, &bind_req(&w, &pp, "tok", old, old), true, t) {
            Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}"),
        };
        apply_fresh_binding(&s, None, &first, t).expect("late first binding");
        // ...and never again once a binding exists.
        let (pp2, _) = ping_key();
        let late = bind_req(&w, &pp2, "tok", old + 1, old + 1);
        assert_eq!(check_bind(&s, &late, true, t).err(), Some(Refusal::Expired));
        // A forged attach (signed over another token) does not verify.
        let mut forged = bind_req(&w, &pp2, "tok", t, t);
        forged.device_token = Some("attacker".into());
        assert_eq!(check_bind(&s, &forged, true, t).err(), Some(Refusal::BadSignature));
        // Another wallet's key for this node.
        let other = wallet();
        let mut foreign = bind_req(&other, &pp2, "tok", t, t);
        foreign.node_id = w.node.clone();
        assert_eq!(check_bind(&s, &foreign, true, t).err(), Some(Refusal::IdentityMismatch));
        foreign.wallet_address = w.wallet.clone();
        assert_eq!(check_bind(&s, &foreign, true, t).err(), Some(Refusal::IdentityMismatch));
        // Not registered and no consent.
        let unreg = wallet();
        let (pp3, _) = ping_key();
        assert_eq!(check_bind(&s, &bind_req(&unreg, &pp3, "tok", t, t), false, t).err(), Some(Refusal::NotRegistered));
        // Malformed.
        let mut short = bind_req(&w, &pp2, "tok", t + 5, t);
        short.attach_sig = "00".into();
        assert_eq!(check_bind(&s, &short, true, t).err(), Some(Refusal::BadSignature));
        // Someone holding only the node's public wallet key learns nothing about the stored sequence or
        // floor: whatever sequence it tries, the answer is bad_signature (the stored one is `old`).
        let (pp4, _) = ping_key();
        for guess in [1, old - 1, old, old + 1, t] {
            let mut probe = bind_req(&other, &pp4, "tok", guess, guess);
            probe.node_id = w.node.clone();
            probe.wallet_address = w.wallet.clone();
            probe.identity_pubkey = w.pk_hex.clone();
            assert_eq!(check_bind(&s, &probe, true, t).err(), Some(Refusal::BadSignature), "seq {guess}");
        }
    }

    #[test]
    fn a_consented_binding_waits_for_the_registration_and_is_promoted_under_its_key() {
        let (s, _d) = storage();
        let w = wallet();
        let t = now() - 3600; // the user came back an hour later
        let (pp, _) = ping_key();
        let burn_tx = bs58::encode([7u8; 64]).into_string();
        let proof = blake3::hash(format!("{}:{}:{}", burn_tx, w.node, w.wallet).as_bytes()).to_hex()[..32].to_string();
        let consent_msg = crate::node::BlockchainNode::chain_bind(&format!("client_node_reg:{}:{}:{}:{}", w.node, w.wallet, proof, t));
        let mut req = bind_req(&w, &pp, "tok", t, t);
        req.consent = Some(BindConsent {
            burn_tx: burn_tx.clone(), registration_proof: proof.clone(), timestamp: t,
            consent_sig: sign(&w.sk, &consent_msg),
        });
        let pending = match check_bind(&s, &req, false, now()) {
            Ok(BindPath::Pending(p)) => p, other => panic!("{other:?}"),
        };
        assert_eq!((pending.seq, pending.consent_ts), (t, t));

        // A consent for another burn does not bind this one.
        let mut wrong = LightNodeBindRequest { consent: req.consent.clone(), ..bind_req(&w, &pp, "tok", t, t) };
        wrong.consent.as_mut().unwrap().registration_proof = "0".repeat(32);
        assert_eq!(check_bind(&s, &wrong, false, now()).err(), Some(Refusal::BadSignature));
        // The binding's seq and ts are the consent's T.
        let mut drift = LightNodeBindRequest { consent: req.consent.clone(), ..bind_req(&w, &pp, "tok", t + 1, t + 1) };
        drift.consent.as_mut().unwrap().timestamp = t;
        assert_eq!(check_bind(&s, &drift, false, now()).err(), Some(Refusal::BadRequest));

        // Stored, then taken at promotion; the registration commits the key it was checked under.
        assert!(!lb::pending_holds(&s, &pending, now()));
        lb::pending_insert(&s, &pending, now()).expect("pending stored");
        assert!(lb::pending_may_contain(&w.node));
        assert!(lb::pending_holds(&s, &pending, now()), "the same binding again changes nothing");
        assert!(!lb::pending_holds(&s, &PendingBind { seq: t + 1, ..pending.clone() }, now()));
        assert_eq!(lb::pending_insert(&s, &pending, now()), Ok(()), "the same binding again is a no-op");
        assert_eq!(lb::pending_insert(&s, &PendingBind { seq: t - 1, ..pending.clone() }, now()), Err(Refusal::StaleSeq),
                   "an earlier consent does not replace a later one");
        // The route decides that before it spends the node's budget: a replayed earlier pending bind, or
        // another key at the same sequence, is refused without spending, so it cannot lock the device out.
        assert_eq!(lb::pending_admits(&s, &PendingBind { seq: t - 1, ..pending.clone() }, now()), Err(Refusal::StaleSeq));
        assert_eq!(lb::pending_admits(&s, &PendingBind { ping_pk: vec![9; 4], ..pending.clone() }, now()), Err(Refusal::StaleSeq));
        assert_eq!(lb::pending_admits(&s, &pending, now()), Ok(true), "the same binding: a no-op");
        assert_eq!(lb::pending_admits(&s, &PendingBind { seq: t + 1, ..pending.clone() }, now()), Ok(false), "a later one is stored");
        register(&s, &w);
        let row = promote_pending_binding(&s, &w.node).expect("pending").expect("promoted");
        assert_eq!((row.seq, row.ping_pubkey.as_str()), (t, pp.as_str()));
        assert!(!lb::pending_may_contain(&w.node));
        assert!(s.get_light_pending_bind(&w.node).is_none(), "taken out of the store");
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.token, e.seq)), Some(("tok".to_string(), t)));
        assert!(promote_pending_binding(&s, &w.node).is_none(), "promoted once");
        // The app's re-send of the same pre-signed binding (U3) is then a no-op that still answers bound.
        let resend = match check_bind(&s, &bind_req(&w, &pp, "tok", t, t), true, now()) {
            Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}"),
        };
        assert_eq!(apply_fresh_binding(&s, None, &resend, now()).map(|r| r.seq), Ok(t));

        // The pending store keeps its cap: at the cap the oldest entry goes.
        let cap = lb::pending_index_len() + 2;
        let mk = |i: u64| PendingBind { node_id: format!("light_cap_test_{i}"), stored_at: 1000 + i, ..pending.clone() };
        for i in 0..3 { lb::pending_insert_capped(&s, &mk(i), &format!("10.0.{i}.0/24"), now(), cap).expect("insert"); }
        assert!(lb::pending_index_len() <= cap);
        assert!(s.get_light_pending_bind("light_cap_test_2").is_some(), "the newest stays");
        // An expired entry is never promoted, and taking it clears it from the store.
        let expired = PendingBind { node_id: "light_cap_test_old".into(), consent_ts: 1, stored_at: 5000, ..pending.clone() };
        lb::pending_insert_capped(&s, &expired, "", now(), usize::MAX).expect("insert");
        assert!(s.get_light_pending_bind("light_cap_test_old").is_some());
        assert!(lb::pending_take(&s, "light_cap_test_old", now()).is_none());
        assert!(s.get_light_pending_bind("light_cap_test_old").is_none());

        // NB-4: at the cap the flood's network loses its own oldest entries, never the real users' older ones,
        // and a network that would hold the most is refused outright.
        let e = |k: &str, at: u64, src: &str| (k.to_string(), at, src.to_string());
        let full = vec![e("user_a", 1, "1.2.3.0/24"), e("user_b", 2, "5.6.7.0/24"), e("junk_0", 10, "6.6.6.0/24"),
                        e("junk_1", 11, "6.6.6.0/24")];
        assert_eq!(lb::pending_victim(&full, "9.9.9.0/24"), Ok(Some("junk_0".to_string())), "the flood loses its oldest");
        assert_eq!(lb::pending_victim(&full, "6.6.6.0/24"), Err(Refusal::RateLimited), "the flood's newcomer is refused");
        let spread = vec![e("user_a", 5, "1.2.3.0/24"), e("user_b", 2, "5.6.7.0/24")];
        assert_eq!(lb::pending_victim(&spread, "9.9.9.0/24"), Ok(Some("user_a".to_string())),
                   "all equal: the smaller network key, deterministically");
        // The store records the network and reads it back from its meta row.
        lb::pending_insert_from(&s, &PendingBind { node_id: "light_nb4_src".into(), ..pending.clone() }, "6.6.6.0/24", now())
            .expect("insert");
        assert!(s.light_pending_bind_meta().iter().any(|(n, _, _, src)| n == "light_nb4_src" && src == "6.6.6.0/24"));
        assert_eq!(lb::pending_source_key(Some("203.0.113.77".parse().unwrap())), "203.0.113.0/24");
        assert_eq!(lb::pending_source_key(Some("2001:db8:1:2:aa::1".parse().unwrap())), "2001:db8:1:2::/64");
        assert_eq!(lb::pending_source_key(Some("::ffff:198.51.100.9".parse().unwrap())), "198.51.100.0/24");
    }

    /// A binding the legacy register took before the registration applied is checked against the key the
    /// registration committed once it applies: one written under another wallet key (anyone who rebuilt
    /// the activation code from public burn data) is dropped with its legacy push record and never reads
    /// as the node's device; the owner's own is vouched for, and gossiped under that key.
    #[test]
    fn a_pre_registration_binding_under_another_key_is_dropped_when_the_registration_applies() {
        let (s, _d) = storage();
        let w = wallet();
        let mallory = wallet();
        let (pp_m, _) = ping_key();
        // Before the registration: the legacy register records the key the delegation was checked under.
        let planted = sign(&mallory.sk, &lb::delegation_v1_message(&pp_m, &w.node));
        s.save_light_ping_keys_identity(&w.node, &pp_m, &planted, &mallory.pk_hex).unwrap();
        s.save_fcm_token_by(&w.node, "mallory_token", "fcm", None, 10, &lb::record_writer(&mallory.pk_hex)).unwrap();
        register(&s, &w);
        // Every reader judges the row under the commitment: it links nothing even before the check runs
        // (a genesis that applies the block late never runs it).
        assert!(!crate::rpc::device_linked(&s, &w.node), "not a device, checked or not");
        assert!(vouch_local_binding(&s, &w.node).is_none());
        assert!(s.get_light_binding(&w.node).is_none(), "dropped");
        assert!(s.get_fcm_entry(&w.node).is_none(), "with the push record written under its key");
        assert!(!crate::rpc::device_linked(&s, &w.node));

        // The owner's own pre-registration binding (an installed app) is vouched for.
        let (pp, _) = ping_key();
        let own = sign(&w.sk, &lb::delegation_v1_message(&pp, &w.node));
        s.save_light_ping_keys_identity(&w.node, &pp, &own, &w.pk_hex).unwrap();
        s.save_fcm_token_by(&w.node, "own_token", "fcm", None, 11, &lb::record_writer(&w.pk_hex)).unwrap();
        let (row, k) = vouch_local_binding(&s, &w.node).expect("vouched");
        assert_eq!((row.ping_pubkey.as_str(), k.as_str()), (pp.as_str(), w.pk_hex.as_str()));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.token), Some("own_token".to_string()));
        assert_eq!(crate::rpc::push_channel(&s, &w.node), Some(crate::rpc::PushChannel::Fcm("own_token".into())));

        // The drop takes only the record written under the dropped row's key (review r2, defect 4): the
        // owner's record, synced here after a plant and before the registration applied, stays.
        let w3 = wallet();
        let (pp3, _) = ping_key();
        let planted3 = sign(&mallory.sk, &lb::delegation_v1_message(&pp3, &w3.node));
        s.save_light_ping_keys_identity(&w3.node, &pp3, &planted3, &mallory.pk_hex).unwrap();
        s.save_fcm_token_by(&w3.node, "mallory_token", "fcm", None, 10, &lb::record_writer(&mallory.pk_hex)).unwrap();
        assert!(s.save_fcm_token_by(&w3.node, "owner_token", "fcm", None, 12, &lb::record_writer(&w3.pk_hex)).unwrap(),
                "before the registration applies records merge last-writer-wins");
        register(&s, &w3);
        assert!(vouch_local_binding(&s, &w3.node).is_none());
        assert!(s.get_light_binding(&w3.node).is_none(), "the planted row is dropped");
        assert_eq!(s.get_fcm_entry(&w3.node).map(|e| e.token), Some("owner_token".to_string()), "the owner's record stays");
        // The owner's row comes back (gossip on apply): its record is its channel at once.
        let own3 = sign(&w3.sk, &lb::delegation_v1_message(&pp3, &w3.node));
        s.save_light_ping_keys_identity(&w3.node, &pp3, &own3, &w3.pk_hex).unwrap();
        assert_eq!(crate::rpc::push_channel(&s, &w3.node), Some(crate::rpc::PushChannel::Fcm("owner_token".into())));
        // A row an older binary wrote with no key is left as it is; a v2 binding is never dropped.
        let w2 = wallet();
        register(&s, &w2);
        s.save_light_ping_keys(&w2.node, &pp, "legacycert").unwrap();
        assert!(vouch_local_binding(&s, &w2.node).is_none());
        assert!(s.get_light_binding(&w2.node).is_some());
        assert!(s.drop_unvouched_light_binding(&w.node, &BindingRow { v2: true, ..row.clone() }).map_or(true, |d| !d));
    }

    /// Review r2, defect 2: the legacy register judges the chain again after its seconds of burn and price
    /// checks, with nothing awaited between that check and its writes, so a registration that applied
    /// meanwhile (after its own check ran) is re-attached only under the committed key.
    #[test]
    fn the_legacy_register_judges_the_chain_again_right_before_it_writes() {
        let src = include_str!("light_nodes.rs");
        let body = &src[src.find("async fn handle_light_node_register(").expect("register")..];
        let body = &body[..body.find("/// SECURE: Handle node info with activation code").expect("the next handler")];
        let last_await = body.find("live_activation_pricing().await").expect("the price check");
        let recheck = body.find("reason=registered_meanwhile").expect("the re-check");
        let row_write = body.find("p2p.register_light_node(registration)").expect("the binding write");
        let record_write = body.find("save_fcm_token_by(").expect("the record write");
        assert!(last_await < recheck && recheck < row_write && row_write < record_write);
        assert!(!body[recheck..record_write].contains(".await"), "nothing awaited between the check and the writes");
        let judged = &body[body[..recheck].rfind("is_node_registration_onchain(&light_node_pseudonym)").expect("on chain")..recheck];
        assert!(judged.contains("resolve_light_identity_pk("), "under the committed key");
    }

    /// Review r3 (attacker 4): a legacy registration not on chain yet is taken only when the wallet that
    /// names the node derives from a credential the caller proves (the chain door's rule), so nobody's
    /// burn attaches a device or a push record to someone else's node before its registration applies.
    /// Checked first on that path, before any network wait, and never counted as a failed attempt (a
    /// stranger could lock the victim's wallet with it).
    #[test]
    fn the_legacy_register_takes_only_a_wallet_derived_from_the_callers_credential() {
        let (w, mallory) = (wallet(), wallet());
        assert!(legacy_register_wallet_bound(&w.wallet, &w.pk_hex, "SoLaNaBurnWallet1111111111111111111111111"));
        assert!(!legacy_register_wallet_bound(&w.wallet, &mallory.pk_hex, "SoLaNaBurnWallet1111111111111111111111111"),
                "another key, another burn: someone else's node");
        let sol = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
        let bridged = crate::crypto::solana_derivation::eon_from_solana_address(sol);
        assert!(legacy_register_wallet_bound(&bridged, &mallory.pk_hex, sol), "a wallet bridged from the burning address");
        assert!(!legacy_register_wallet_bound(&bridged, &mallory.pk_hex, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFiN"));
        assert!(!legacy_register_wallet_bound(&w.wallet, &w.pk_hex[2..], &w.wallet), "a key that is not the wallet's");
        let src = include_str!("light_nodes.rs");
        let body = &src[src.find("async fn handle_light_node_register(").expect("register")..];
        let fresh = body.find("if !reactivating_existing {").expect("the fresh path");
        let check = body.find("legacy_register_wallet_bound(").expect("the ownership rule");
        let first_wait = fresh + body[fresh..].find(".await").expect("the burn check waits");
        assert!(fresh < check && check < body.find("verify_code_ownership_stateless(").expect("the code check") && check < first_wait);
        let refusal = &body[check..check + body[check..].find("return Ok(").expect("refused")];
        assert!(!refusal.contains("record_wallet_reg_failure"), "not a failed attempt");
    }

    /// M-8: the legacy register's static signature replays. Replayed for an on-chain node never bound under v2, its
    /// current delegation writes nothing new, so the push record stays the owner's; an older delegation of the node (a
    /// key it moved away from) is refused as older and rolls the ping key back nowhere, by the register or by gossip;
    /// only a key the wallet newly delegates changes them.
    #[tokio::test]
    async fn a_replayed_legacy_register_moves_neither_the_push_record_nor_the_ping_key() {
        use crate::storage::PingKeyWrite;
        use crate::unified_p2p::{LightNodeRegistrationData, NodeType, PushType, Region, SimplifiedP2P};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = Arc::new(crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let mut p2p = SimplifiedP2P::new("test_m8_node".into(), NodeType::Super, Region::Europe, 8113);
        p2p.set_storage(s.clone());
        let w = wallet();
        register(&s, &w);
        let t = now();
        let cert = |pp: &str| sign(&w.sk, &lb::delegation_v1_message(pp, &w.node));
        let reg = |pp: &str, cert: &str| LightNodeRegistrationData {
            node_id: w.node.clone(), wallet_address: w.wallet.clone(), device_token_hash: String::new(),
            quantum_pubkey: w.pk_hex.clone(), registered_at: t, signature: String::new(), push_type: PushType::FCM,
            unified_push_endpoint: None, last_seen: t, consecutive_failures: 0, is_active: true,
            ping_pubkey: pp.to_string(), ping_delegation_cert: cert.to_string(),
        };
        let ((pp0, _), (pp1, _)) = (ping_key(), ping_key());
        let (c0, c1) = (cert(&pp0), cert(&pp1));
        // The owner's first device, then the key it moved to, and its push record.
        assert_eq!(p2p.register_light_node(reg(&pp0, &c0)), Some(PingKeyWrite::Applied));
        assert_eq!(p2p.register_light_node(reg(&pp1, &c1)), Some(PingKeyWrite::Applied));
        assert!(s.save_fcm_token_by(&w.node, "tok_owner", "fcm", None, t, &lb::record_writer(&w.pk_hex)).unwrap());
        let row = s.get_light_binding(&w.node).unwrap();
        assert_eq!((row.ping_pubkey.as_str(), row.retired_fps.clone()), (pp1.as_str(), vec![lb::device_fp(&pp0).unwrap()]));
        assert_eq!(BindingRow::from_json(&row.to_json()), row, "the retired keys survive the stored form");
        // A replay of the current delegation with the attacker's token: nothing new, so the record stays.
        let replay = p2p.register_light_node(reg(&pp1, &c1));
        assert_eq!(replay, Some(PingKeyWrite::Unchanged));
        assert!(!crate::rpc::legacy_record_write_allowed(true, replay));
        // A replay of the older delegation: refused as older, by the register and by any copy path.
        let old = p2p.register_light_node(reg(&pp0, &c0));
        assert_eq!(old, Some(PingKeyWrite::Refused(lb::Admit::Stale)));
        assert!(!crate::rpc::legacy_record_write_allowed(true, old));
        assert_eq!(s.save_light_ping_keys_identity(&w.node, &pp0, &c0, &w.pk_hex).unwrap(), PingKeyWrite::Refused(lb::Admit::Stale));
        assert_eq!(s.get_light_binding(&w.node).map(|b| b.ping_pubkey), Some(pp1.clone()), "the ping key stays");
        assert_eq!(crate::rpc::push_channel(&s, &w.node), Some(crate::rpc::PushChannel::Fcm("tok_owner".into())));
        // A key the wallet newly delegates applies, and the record may follow it; a fresh registration writes as before.
        let (pp2, _) = ping_key();
        let fresh = p2p.register_light_node(reg(&pp2, &cert(&pp2)));
        assert_eq!(fresh, Some(PingKeyWrite::Applied));
        assert!(crate::rpc::legacy_record_write_allowed(true, fresh));
        assert!(crate::rpc::legacy_record_write_allowed(false, None));
        assert_eq!(s.get_light_binding(&w.node).map(|b| b.retired_fps.len()), Some(2));
        // The route writes the record and syncs it only through the rule.
        let src = include_str!("light_nodes.rs");
        let body = &src[src.find("async fn handle_light_node_register(").expect("register")..];
        let body = &body[..body.find("/// SECURE: Handle node info with activation code").expect("the next handler")];
        let rule = body.find("let record_allowed = legacy_record_write_allowed(reactivating_existing, key_write);").expect("the rule");
        let gate = body.find("let has_channel = record_allowed && (").expect("the gate");
        assert!(body.find("let key_write = p2p.register_light_node(registration);").unwrap() < rule && rule < gate);
        assert!(gate < body.find("save_fcm_token_by(").unwrap() && gate < body.find("sync_fcm_token_to_genesis_peers(").unwrap());
    }

    /// A pending binding is promoted from both apply paths: the validator's commit and the producer's
    /// inline apply each admit a light registration through `admit_light_from_chain`, which hands the
    /// node to the promotion once its resident entry exists (the promotion sets its push channel).
    #[test]
    fn both_apply_paths_hand_a_light_registration_to_the_promotion() {
        let prop = include_str!("../unified_p2p/propagation.rs");
        let rest = &prop[prop.find("pub fn admit_light_from_chain").expect("admit")..];
        let entry = rest.find("self.admit_light_entry_from_chain(").expect("the entry first");
        let hook = rest.find("crate::rpc::on_light_registration_applied(").expect("then the promotion");
        assert!(entry < hook && hook < 1000, "entry {entry}, hook {hook}");
        assert!(include_str!("../block_pipeline.rs").contains("p2p.admit_light_from_chain("), "validator");
        assert!(include_str!("../node/production.rs").contains("p2p.admit_light_from_chain("), "producer");
    }

    /// H8: a gossiped binding lands only for a light node the chain registered, under the key its
    /// registration committed, with a delegation that verifies and is newer than the stored one. The
    /// message's other fields (push channel, activity, wallet) are not taken.
    #[tokio::test]
    async fn gossip_takes_only_a_newer_verified_binding_of_an_onchain_node() {
        use crate::unified_p2p::{NetworkMessage, NodeType, PushType, Region, SimplifiedP2P};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = Arc::new(crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let mut p2p = SimplifiedP2P::new("test_h8_node".into(), NodeType::Super, Region::Europe, 8111);
        p2p.set_storage(s.clone());
        let w = wallet();
        let t = now();
        let cert = |pp: &str, seq: u64| lb::format_v2_cert(seq, &sign(&w.sk, &lb::delegation_v2_message(pp, &w.node, seq)));
        let msg = |wallet: &str, pp: &str, cert: &str| NetworkMessage::LightNodeRegistration {
            node_id: w.node.clone(), wallet_address: wallet.to_string(), device_token_hash: "h".into(),
            quantum_pubkey: w.pk_hex.clone(), registered_at: t, signature: "s".into(), gossip_hop: 0,
            push_type: PushType::FCM, unified_push_endpoint: None, last_seen: t, consecutive_failures: 0,
            is_active: true, ping_pubkey: pp.to_string(), ping_delegation_cert: cert.to_string(),
        };
        let binding = || s.get_light_binding(&w.node).map(|b| (b.ping_pubkey, b.seq));
        let (pp1, _) = ping_key();

        p2p.handle_message("peer", msg(&w.wallet, &pp1, &cert(&pp1, t)));
        assert_eq!(binding(), None, "not on chain: nothing lands");
        register(&s, &w);
        let other = wallet();
        p2p.handle_message("peer", msg(&other.wallet, &pp1, &cert(&pp1, t)));
        assert_eq!(binding(), None, "the node id is not the wallet's pseudonym");
        let forged = lb::format_v2_cert(t, &sign(&other.sk, &lb::delegation_v2_message(&pp1, &w.node, t)));
        p2p.handle_message("peer", msg(&w.wallet, &pp1, &forged));
        assert_eq!(binding(), None, "a delegation under another key");

        p2p.handle_message("peer", msg(&w.wallet, &pp1, &cert(&pp1, t)));
        assert_eq!(binding(), Some((pp1.clone(), t)));
        let (pp2, _) = ping_key();
        p2p.handle_message("peer", msg(&w.wallet, &pp2, &cert(&pp2, t + 5)));
        assert_eq!(binding(), Some((pp2.clone(), t + 5)), "a newer binding replaces it");
        p2p.handle_message("peer", msg(&w.wallet, &pp1, &cert(&pp1, t)));
        let legacy = sign(&w.sk, &lb::delegation_v1_message(&pp1, &w.node));
        p2p.handle_message("peer", msg(&w.wallet, &pp1, &legacy));
        assert_eq!(binding(), Some((pp2.clone(), t + 5)), "the replaced binding and a legacy one stay out");
        assert!(s.get_fcm_entry(&w.node).is_none(), "no push channel from gossip");
        assert!(p2p.get_light_node(&w.node).is_none(), "no resident entry from gossip");
    }

    /// A replayed attach never takes back the channel a later refresh of the same binding set: a v2
    /// push record is ordered by the signed time of the message that set it, here and at every peer.
    #[test]
    fn a_replayed_attach_does_not_undo_a_later_token_refresh() {
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp, ping_sk) = ping_key();
        let req = bind_req(&w, &pp, "tok_a", t, t);
        let b = match check_bind(&s, &req, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        let row = apply_fresh_binding(&s, None, &b, t).expect("bound");
        // The device refreshes its token a minute later (ping key); a peer relays the record here.
        let refresh = FcmTokenSyncRequest {
            pseudonym: w.node.clone(), token: "tok_b".into(), push_type: "fcm".into(),
            endpoint: Some("https://unsigned.example".into()), origin_ip: "1.2.3.4".into(), ts: Some(1), seq: Some(t), platform: None, model: None,
            proof: Some(TokenSyncProof {
                identity_pubkey: w.pk_hex.clone(), ping_pubkey: pp.clone(), delegation_cert: row.cert.clone(),
                kind: "refresh".into(), sig: sign(&ping_sk, &lb::token_refresh_v2_message(&w.node, "tok_b", t, t + 60)),
                sig_ts: t + 60,
            }),
            writer: None,
        };
        assert_eq!(apply_token_sync(&s, None, &refresh, t + 60), SyncOutcome::Applied);
        let e = s.get_fcm_entry(&w.node).expect("record");
        assert_eq!((e.token.as_str(), e.seq, e.updated_at, e.endpoint), ("tok_b", t, t + 60, None),
                   "ordered by the signed time; the unsigned endpoint is not stored");
        // Ten minutes on, a replay of the original bind is a re-send: bound, and nothing changes.
        let replay = match check_bind(&s, &req, true, t + 600) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        assert_eq!(apply_fresh_binding(&s, None, &replay, t + 600).map(|r| r.seq), Ok(t));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.token), Some("tok_b".to_string()));
    }

    fn sync_req(w: &Wallet, pp: &str, cert: &str, token: &str, seq: u64, sig_ts: u64, ts: u64) -> FcmTokenSyncRequest {
        FcmTokenSyncRequest {
            pseudonym: w.node.clone(), token: token.into(), push_type: "fcm".into(), endpoint: None,
            origin_ip: "1.2.3.4".into(), ts: Some(ts), seq: Some(seq), platform: None, model: None,
            proof: Some(TokenSyncProof {
                identity_pubkey: w.pk_hex.clone(), ping_pubkey: pp.into(), delegation_cert: cert.into(),
                kind: "attach".into(),
                sig: sign(&w.sk, &lb::attach_v2_message(&w.node, pp, token, seq, sig_ts).unwrap()),
                sig_ts,
            }),
            writer: None,
        }
    }

    #[test]
    fn the_internal_sync_carries_a_newer_binding_and_refuses_a_lower_seq() {
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp_new, _) = ping_key();
        let (pp_old, _) = ping_key();
        let cert = |pp: &str, seq: u64| lb::format_v2_cert(seq, &sign(&w.sk, &lb::delegation_v2_message(pp, &w.node, seq)));

        let newer = sync_req(&w, &pp_new, &cert(&pp_new, t + 10), "tok_new", t + 10, t, t);
        assert_eq!(apply_token_sync(&s, None, &newer, t), SyncOutcome::Applied);
        assert_eq!(s.get_light_binding(&w.node).map(|b| b.seq), Some(t + 10), "the binding arrived with the token");

        let older = sync_req(&w, &pp_old, &cert(&pp_old, t + 5), "tok_old", t + 5, t, t + 50);
        assert_eq!(apply_token_sync(&s, None, &older, t), SyncOutcome::Stale("stale_seq"));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.token), Some("tok_new".to_string()));

        // A legacy record (no proof) is refused for a v2-bound node...
        let legacy = FcmTokenSyncRequest { seq: None, proof: None, ts: Some(t + 99), ..older.clone_plain() };
        assert_eq!(apply_token_sync(&s, None, &legacy, t), SyncOutcome::Refused("proof_required"));
        // ...a forged proof (token swapped after signing) is refused...
        let mut forged = sync_req(&w, &pp_new, &cert(&pp_new, t + 10), "tok_new", t + 10, t, t + 1);
        forged.token = "attacker".into();
        assert_eq!(apply_token_sync(&s, None, &forged, t), SyncOutcome::Refused("bad_proof"));
        // ...and a pulled record is taken only at the stored seq.
        assert!(!apply_pulled_push_record(&s, None, &w.node, "pulled", "fcm", None, t + 2, t + 5, ""));
        assert!(apply_pulled_push_record(&s, None, &w.node, "pulled", "fcm", None, t + 2, t + 10, ""));

        // A genesis that has not applied the registration yet refuses a v2 record it cannot check; the
        // sender tries it once more a little later.
        let unapplied = wallet();
        let early = sync_req(&unapplied, &pp_new, &cert(&pp_new, t + 10), "tok_new", t + 10, t, t);
        assert_eq!(apply_token_sync(&s, None, &early, t), SyncOutcome::Refused("not_registered"));

        // A node with no v2 binding keeps the legacy last-writer-wins merge.
        let w2 = wallet();
        register(&s, &w2);
        let l1 = FcmTokenSyncRequest { pseudonym: w2.node.clone(), ts: Some(100), ..legacy.clone_plain() };
        assert_eq!(apply_token_sync(&s, None, &l1, t), SyncOutcome::Applied);
        let l0 = FcmTokenSyncRequest { ts: Some(99), ..l1.clone_plain() };
        assert_eq!(apply_token_sync(&s, None, &l0, t), SyncOutcome::Stale("stale"));
    }

    /// 04.10: the bind's platform hint (unsigned, display-only) is kept with the binding's push record, through a
    /// pending binding's promotion and the token sync; anything else is no platform and never a refusal; an entry
    /// an older binary stored in the pending store still reads.
    #[test]
    fn the_binds_platform_hint_is_kept_with_its_binding_and_never_refuses() {
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp, _) = ping_key();
        let mut req = bind_req(&w, &pp, "tok", t, t);
        req.platform = Some("windows".into());
        let b = match check_bind(&s, &req, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        assert_eq!(b.platform, "", "an unknown platform is no platform, and the bind passes");
        req.platform = Some("ios".into());
        let b = match check_bind(&s, &req, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        apply_fresh_binding(&s, None, &b, t).expect("bound");
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.seq, e.platform)), Some((t, "ios".to_string())));
        // A re-send with no hint keeps it; a re-send names it to a record that has none.
        let mut plain = b.clone();
        plain.platform = "";
        apply_fresh_binding(&s, None, &plain, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.platform), Some("ios".to_string()));
        let (pp2, _) = ping_key();
        let mut r2 = bind_req(&w, &pp2, "tok2", t + 1, t);
        r2.platform = None;
        let b2 = match check_bind(&s, &r2, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        apply_fresh_binding(&s, None, &b2, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.platform), Some(String::new()), "a new binding's record drops the old device's");
        let mut named = b2.clone();
        named.platform = "android";
        named.resend = true;
        apply_fresh_binding(&s, None, &named, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.platform), Some("android".to_string()));
        // The token sync carries it to a peer with the device's attach.
        let (peer, _dp) = storage();
        register(&peer, &w);
        let row = s.get_light_binding(&w.node).unwrap();
        let mut sync = sync_req(&w, &pp2, &row.cert, "tok2", t + 1, t, t);
        sync.platform = Some("android".into());
        assert_eq!(apply_token_sync(&peer, None, &sync, t), SyncOutcome::Applied);
        assert_eq!(peer.get_fcm_entry(&w.node).map(|e| e.platform), Some("android".to_string()));
        let wire: FcmTokenSyncRequest = serde_json::from_str(&serde_json::to_string(&sync).unwrap()).unwrap();
        assert_eq!(wire.platform.as_deref(), Some("android"));
        assert!(!serde_json::to_string(&sync_req(&w, &pp2, &row.cert, "tok2", t + 1, t, t)).unwrap().contains("platform"),
                "a record that names none sends none");

        // A pending binding keeps its hint through the promotion.
        let (p, _dp2) = storage();
        let w2 = wallet();
        let tc = now() - 60;
        let (pp3, _) = ping_key();
        let burn_tx = bs58::encode([8u8; 64]).into_string();
        let proof = blake3::hash(format!("{}:{}:{}", burn_tx, w2.node, w2.wallet).as_bytes()).to_hex()[..32].to_string();
        let consent_msg = crate::node::BlockchainNode::chain_bind(&format!("client_node_reg:{}:{}:{}:{}", w2.node, w2.wallet, proof, tc));
        let mut preq = bind_req(&w2, &pp3, "tok3", tc, tc);
        preq.platform = Some("android".into());
        preq.consent = Some(BindConsent { burn_tx, registration_proof: proof, timestamp: tc, consent_sig: sign(&w2.sk, &consent_msg) });
        let pending = match check_bind(&p, &preq, false, now()) { Ok(BindPath::Pending(x)) => x, other => panic!("{other:?}") };
        assert_eq!(pending.platform, "android");
        lb::pending_insert(&p, &pending, now()).unwrap();
        assert_eq!(p.get_light_pending_bind(&w2.node).map(|x| x.platform), Some("android".to_string()));
        register(&p, &w2);
        promote_pending_binding(&p, &w2.node).expect("pending").expect("promoted");
        assert_eq!(p.get_fcm_entry(&w2.node).map(|e| e.platform), Some("android".to_string()));

        // The layout an older binary stored (no platform) still decodes, with none.
        #[derive(serde::Serialize)]
        struct Old<'a> {
            node_id: &'a str, wallet: &'a str, identity_pk: Vec<u8>, ping_pk: Vec<u8>, cert_sig: Vec<u8>, attach_sig: Vec<u8>,
            seq: u64, ts: u64, push_type: &'a str, token: &'a str, endpoint: Option<String>, burn_tx: &'a str,
            consent_ts: u64, stored_at: u64,
        }
        let old = bincode::serialize(&Old {
            node_id: &pending.node_id, wallet: &pending.wallet, identity_pk: pending.identity_pk.clone(),
            ping_pk: pending.ping_pk.clone(), cert_sig: pending.cert_sig.clone(), attach_sig: pending.attach_sig.clone(),
            seq: pending.seq, ts: pending.ts, push_type: &pending.push_type, token: &pending.token, endpoint: None,
            burn_tx: &pending.burn_tx, consent_ts: pending.consent_ts, stored_at: pending.stored_at,
        }).unwrap();
        assert_eq!(PendingBind::decode(&old), Some(PendingBind { platform: String::new(), ..pending.clone() }));
        assert_eq!(PendingBind::decode(&bincode::serialize(&pending).unwrap()), Some(pending.clone()));
    }

    /// 06.10: the bind's model hint (unsigned, display-only, a short marketing name) is checked like the platform's,
    /// never a refusal; kept with the binding's push record, a re-send naming it to a record that has none; replaced or
    /// dropped by the next binding; carried by the token sync and through a pending binding's promotion; an entry
    /// either older layout of the pending store holds still reads; a request from an app without the field binds as
    /// before.
    #[test]
    fn the_binds_model_hint_is_kept_with_its_binding_and_never_refuses() {
        // What a model may be: ASCII letters, digits, spaces and a few marks, 1 to 40 bytes once trimmed.
        assert_eq!(lb::model_hint(Some("Acme Phone 7 Pro (5G)")), "Acme Phone 7 Pro (5G)");
        assert_eq!(lb::model_hint(Some("  Acme X-2, 128/8+  ")), "Acme X-2, 128/8+");
        assert_eq!(lb::model_hint(Some(&"a".repeat(lb::MODEL_HINT_MAX))), "a".repeat(lb::MODEL_HINT_MAX));
        for bad in [None, Some(""), Some("   "), Some(&*"a".repeat(lb::MODEL_HINT_MAX + 1)), Some("Ann's phone"),
                    Some("Phone\u{00e9}"), Some("a\nb"), Some("<b>x</b>"), Some("x\"y"), Some("a;b"), Some("tel\u{0000}")] {
            assert_eq!(lb::model_hint(bad), "", "{bad:?}");
        }
        let (s, _d) = storage();
        let w = wallet();
        register(&s, &w);
        let t = now();
        let (pp, _) = ping_key();
        // An app without the field: the same request as before, no model.
        let legacy: LightNodeBindRequest = serde_json::from_value(serde_json::json!({
            "node_id": w.node, "wallet_address": w.wallet, "seq": t, "platform": "android",
        })).unwrap();
        assert_eq!((legacy.model.as_deref(), legacy.platform.as_deref()), (None, Some("android")));
        let mut req = bind_req(&w, &pp, "tok", t, t);
        req.model = Some("Ann's phone".into());
        let b = match check_bind(&s, &req, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        assert_eq!(b.model, "", "a model that is not one is none, and the bind passes");
        req.platform = Some("android".into());
        req.model = Some(" Acme Phone 7 ".into());
        let b = match check_bind(&s, &req, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        assert_eq!((b.platform, b.model.as_str()), ("android", "Acme Phone 7"));
        apply_fresh_binding(&s, None, &b, t).expect("bound");
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.seq, e.platform, e.model)),
                   Some((t, "android".to_string(), "Acme Phone 7".to_string())));
        // A re-send with no model keeps it.
        let mut plain = b.clone();
        plain.model = String::new();
        apply_fresh_binding(&s, None, &plain, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.model), Some("Acme Phone 7".to_string()));
        // The next binding replaces it with its own, or drops it when it names none.
        let (pp2, _) = ping_key();
        let mut r2 = bind_req(&w, &pp2, "tok2", t + 1, t);
        r2.platform = Some("ios".into());
        r2.model = Some("Acme Tab 3".into());
        let b2 = match check_bind(&s, &r2, true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        apply_fresh_binding(&s, None, &b2, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.platform, e.model)), Some(("ios".to_string(), "Acme Tab 3".to_string())));
        let (pp3, _) = ping_key();
        let b3 = match check_bind(&s, &bind_req(&w, &pp3, "tok3", t + 2, t), true, t) { Ok(BindPath::Fresh(b)) => b, other => panic!("{other:?}") };
        apply_fresh_binding(&s, None, &b3, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.model), Some(String::new()), "a new binding's record drops the old device's");
        // A re-send names it to a record that has none (an app updated between its binding and a re-send).
        let mut named = b3.clone();
        named.model = "Acme Phone 8".into();
        named.resend = true;
        apply_fresh_binding(&s, None, &named, t).unwrap();
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| e.model), Some("Acme Phone 8".to_string()));
        // The token sync carries it to a peer with the device's attach; a record that names none sends none.
        let (peer, _dp) = storage();
        register(&peer, &w);
        let row = s.get_light_binding(&w.node).unwrap();
        let mut sync = sync_req(&w, &pp3, &row.cert, "tok3", t + 2, t, t);
        sync.model = Some("Acme Phone 8".into());
        assert_eq!(apply_token_sync(&peer, None, &sync, t), SyncOutcome::Applied);
        assert_eq!(peer.get_fcm_entry(&w.node).map(|e| e.model), Some("Acme Phone 8".to_string()));
        let wire: FcmTokenSyncRequest = serde_json::from_str(&serde_json::to_string(&sync).unwrap()).unwrap();
        assert_eq!(wire.model.as_deref(), Some("Acme Phone 8"));
        assert!(!serde_json::to_string(&sync_req(&w, &pp3, &row.cert, "tok3", t + 2, t, t)).unwrap().contains("model"));
        // A sync whose model is not one stores none.
        let (peer2, _dp3) = storage();
        register(&peer2, &w);
        sync.model = Some("<b>x</b>".into());
        assert_eq!(apply_token_sync(&peer2, None, &sync, t), SyncOutcome::Applied);
        assert_eq!(peer2.get_fcm_entry(&w.node).map(|e| e.model), Some(String::new()));

        // A pending binding keeps its model through the promotion.
        let (p, _dp2) = storage();
        let w2 = wallet();
        let tc = now() - 60;
        let (pp4, _) = ping_key();
        let burn_tx = bs58::encode([9u8; 64]).into_string();
        let proof = blake3::hash(format!("{}:{}:{}", burn_tx, w2.node, w2.wallet).as_bytes()).to_hex()[..32].to_string();
        let consent_msg = crate::node::BlockchainNode::chain_bind(&format!("client_node_reg:{}:{}:{}:{}", w2.node, w2.wallet, proof, tc));
        let mut preq = bind_req(&w2, &pp4, "tok4", tc, tc);
        preq.platform = Some("ios".into());
        preq.model = Some("Acme Tab 3".into());
        preq.consent = Some(BindConsent { burn_tx, registration_proof: proof, timestamp: tc, consent_sig: sign(&w2.sk, &consent_msg) });
        let pending = match check_bind(&p, &preq, false, now()) { Ok(BindPath::Pending(x)) => x, other => panic!("{other:?}") };
        assert_eq!((pending.platform.as_str(), pending.model.as_str()), ("ios", "Acme Tab 3"));
        lb::pending_insert(&p, &pending, now()).unwrap();
        assert_eq!(p.get_light_pending_bind(&w2.node).map(|x| x.model), Some("Acme Tab 3".to_string()));
        register(&p, &w2);
        promote_pending_binding(&p, &w2.node).expect("pending").expect("promoted");
        assert_eq!(p.get_fcm_entry(&w2.node).map(|e| (e.platform, e.model)), Some(("ios".to_string(), "Acme Tab 3".to_string())));

        // The layout before `model` (with `platform`) still decodes, with its platform and no model.
        #[derive(serde::Serialize)]
        struct WithPlatform<'a> {
            node_id: &'a str, wallet: &'a str, identity_pk: Vec<u8>, ping_pk: Vec<u8>, cert_sig: Vec<u8>, attach_sig: Vec<u8>,
            seq: u64, ts: u64, push_type: &'a str, token: &'a str, endpoint: Option<String>, burn_tx: &'a str,
            consent_ts: u64, stored_at: u64, platform: &'a str,
        }
        let v2 = bincode::serialize(&WithPlatform {
            node_id: &pending.node_id, wallet: &pending.wallet, identity_pk: pending.identity_pk.clone(),
            ping_pk: pending.ping_pk.clone(), cert_sig: pending.cert_sig.clone(), attach_sig: pending.attach_sig.clone(),
            seq: pending.seq, ts: pending.ts, push_type: &pending.push_type, token: &pending.token, endpoint: None,
            burn_tx: &pending.burn_tx, consent_ts: pending.consent_ts, stored_at: pending.stored_at, platform: "ios",
        }).unwrap();
        assert_eq!(PendingBind::decode(&v2), Some(PendingBind { model: String::new(), ..pending.clone() }));
        assert_eq!(PendingBind::decode(&bincode::serialize(&pending).unwrap()), Some(pending.clone()));
    }

    impl FcmTokenSyncRequest {

        fn clone_plain(&self) -> Self {
            FcmTokenSyncRequest {
                pseudonym: self.pseudonym.clone(), token: self.token.clone(), push_type: self.push_type.clone(),
                endpoint: self.endpoint.clone(), origin_ip: self.origin_ip.clone(), ts: self.ts,
                seq: self.seq, proof: self.proof.clone(), writer: self.writer.clone(), platform: self.platform.clone(),
                model: self.model.clone(),

            }
        }
    }

    /// M-10: a pending binding is stored only for a burn this genesis has seen for that very node (it attested it, the
    /// pool holds the registration, or a submit for it is collecting attestations here); otherwise the answer is a
    /// refusal the app sends again later, and nothing is stored. The store's I/O runs on a blocking thread, behind a
    /// node-wide hourly backstop.
    #[test]
    fn a_pending_binding_is_stored_only_for_a_burn_seen_here() {
        let (s, _d) = storage();
        let w = wallet();
        let (pp, _) = ping_key();
        let t = now();
        let burn_tx = bs58::encode([9u8; 64]).into_string();
        let p = PendingBind {
            node_id: w.node.clone(), wallet: w.wallet.clone(), identity_pk: hex::decode(&w.pk_hex).unwrap(),
            ping_pk: hex::decode(&pp).unwrap(), cert_sig: vec![1], attach_sig: vec![2], seq: t, ts: t,
            push_type: "fcm".into(), token: "tok".into(), endpoint: None, burn_tx: burn_tx.clone(), consent_ts: t,
            stored_at: t, platform: String::new(), model: String::new(),
        };
        assert!(!pending_burn_seen(&s, &p, t), "fresh keys and a random burn");
        s.attested_burn_put(&burn_tx, "light_mobile_someone_else").unwrap();
        assert!(!pending_burn_seen(&s, &p, t), "a burn attested for another node");
        s.attested_burn_put(&burn_tx, &w.node).unwrap();
        assert!(pending_burn_seen(&s, &p, t), "the burn this genesis attested for this node");
        let later = pending_later_json(PENDING_LATER_SECS);
        assert_eq!((later["success"].clone(), later["reason"].clone(), later["retry_after_seconds"].clone()),
                   (json!(false), json!("rate_limited"), json!(PENDING_LATER_SECS)), "a reason the app retries");
        assert!(transient_answer(&later), "never kept as the final answer of a device message");
        let src = include_str!("light_bind.rs");
        let h = &src[src.find("pub(super) async fn handle_light_node_bind(").unwrap()..];
        let h = &h[..h.find("/// A registration applied longer ago than this").unwrap()];
        let seen = h.find("!pending_burn_seen(&storage, p, now)").expect("the burn decides");
        assert!(h.find("check_bind(&storage, &req, onchain, now)").unwrap() < seen);
        assert!(seen < h.find("prepare_bind_device(").unwrap(), "before any device work");
        // With the device layer served, no burn seen is sent again later, before any device work.
        let served = h.find("if crate::light_device::device_layer_served() {").expect("the device layer decides");
        assert!(seen < served && served < h.find("prepare_bind_device(").unwrap());
        assert!(h.contains("PENDING_BIND_GLOBAL_LIMIT.allows(\"\", now)") && h.contains("DEFERRED_BIND_GLOBAL_LIMIT.allows(\"\", now)"));
        let insert = h.find("lb::pending_insert_from(&storage, &p, &source, now)?;").unwrap();
        assert!(h[..insert].rfind("tokio::task::spawn_blocking(").is_some(), "the store's I/O off the runtime");
        // No burn seen: the memory tier, never the store.
        let held = h.find("lb::deferred_insert(&p, &source, now)?;").expect("the memory tier");
        assert!(h[..held].rfind("if in_memory {").unwrap() > h[..held].rfind("tokio::task::spawn_blocking(").unwrap());
    }

    /// M-10: a binding whose burn this genesis has not seen (the QNet Link sheet posts it before the site submits the
    /// registration) is held in memory only, under the store's rules and cap, and the registration's apply promotes it,
    /// so the phone is linked when the registration lands without waiting for the app to run again.
    #[test]
    fn a_binding_with_no_burn_seen_waits_in_memory_and_the_registration_promotes_it() {
        let (s, _d) = storage();
        let w = wallet();
        let t = now() - 60;
        let burn_tx = bs58::encode([5u8; 64]).into_string();
        let pending_at = |pp: &str, ts: u64| {
            let proof = blake3::hash(format!("{}:{}:{}", burn_tx, w.node, w.wallet).as_bytes()).to_hex()[..32].to_string();
            let msg = crate::node::BlockchainNode::chain_bind(&format!("client_node_reg:{}:{}:{}:{}", w.node, w.wallet, proof, ts));
            let mut req = bind_req(&w, pp, "tok", ts, ts);
            req.consent = Some(BindConsent { burn_tx: burn_tx.clone(), registration_proof: proof, timestamp: ts, consent_sig: sign(&w.sk, &msg) });
            match check_bind(&s, &req, false, now()) { Ok(BindPath::Pending(p)) => p, other => panic!("{other:?}") }
        };
        let (pp, _) = ping_key();
        let p = pending_at(&pp, t);
        assert!(!pending_burn_seen(&s, &p, now()), "no burn known here");

        // The tier's rules, on a tier of its own.
        let mut tier = lb::DeferredTier::default();
        assert_eq!(tier.insert(&p, "10.0.1.0/24", now(), 2), Ok(false));
        assert_eq!(tier.insert(&p, "10.0.1.0/24", now(), 2), Ok(true), "the same binding again is a no-op");
        assert!(tier.holds(&p, now()));
        assert_eq!(tier.insert(&PendingBind { seq: t - 1, ..p.clone() }, "", now(), 2), Err(Refusal::StaleSeq));
        assert_eq!(tier.insert(&PendingBind { ping_pk: vec![9; 4], ..p.clone() }, "", now(), 2), Err(Refusal::StaleSeq));
        let later = PendingBind { seq: t + 1, ..p.clone() };
        assert_eq!(tier.insert(&later, "10.0.1.0/24", now(), 2), Ok(false), "a later consent replaces it");
        assert_eq!(tier.len(), 1);
        // At the cap: expired entries go first, then the oldest of the network holding the most, and a binding from a
        // network that would then hold the most is refused.
        let mk = |k: &str, at: u64| PendingBind { node_id: k.into(), stored_at: at, ..p.clone() };
        assert_eq!(tier.insert(&PendingBind { consent_ts: 1, ..mk("light_old", 1) }, "10.0.9.0/24", now(), 2), Ok(false));
        assert_eq!(tier.insert(&mk("light_b", 5), "10.0.2.0/24", now(), 2), Ok(false));
        assert!(!tier.contains("light_old") && tier.contains("light_b") && tier.len() == 2, "the expired one went");
        assert_eq!(tier.insert(&mk("light_a2", 6), "10.0.1.0/24", now(), 2), Err(Refusal::RateLimited));
        assert_eq!(tier.insert(&mk("light_c", 7), "10.0.3.0/24", now(), 2), Ok(false));
        assert_eq!(tier.len(), 2);
        assert!(tier.take("light_c", now()).is_some() && tier.take("light_c", now()).is_none(), "taken once");
        assert!(tier.take("light_old", now()).is_none());

        // Held in memory, nothing stored; the registration's apply promotes it under the key it commits.
        assert_eq!(lb::deferred_insert(&p, "10.0.1.0/24", now()), Ok(false));
        assert!(lb::deferred_may_contain(&w.node) && lb::deferred_holds(&p, now()));
        // The route decides before it spends the node's budget: an earlier consent is refused, the same one is a no-op.
        assert_eq!(lb::deferred_admits(&PendingBind { seq: t - 1, ..p.clone() }, now()), Err(Refusal::StaleSeq));
        assert_eq!(lb::deferred_admits(&p, now()), Ok(true));
        let h = include_str!("light_bind.rs");
        let changes = &h[h.find("let changes = match &path {").unwrap()..h.find("if changes && !BIND_NODE_LIMIT.allows(").unwrap()];
        assert!(changes.contains("lb::deferred_admits(p, now)"));
        assert!(s.get_light_pending_bind(&w.node).is_none(), "nothing written to the store");
        register(&s, &w);
        let row = promote_pending_binding(&s, &w.node).expect("held").expect("promoted");
        assert_eq!((row.seq, row.ping_pubkey.as_str()), (t, pp.as_str()));
        assert!(!lb::deferred_may_contain(&w.node));
        assert_eq!(s.get_fcm_entry(&w.node).map(|e| (e.token, e.seq)), Some(("tok".to_string(), t)));
        assert!(promote_pending_binding(&s, &w.node).is_none(), "promoted once");
        let src = include_str!("light_bind.rs");
        let apply = &src[src.find("pub(crate) fn on_light_registration_applied(").unwrap()..];
        assert!(apply[..apply.find("handle.spawn(").unwrap()].contains("lb::deferred_may_contain(node_id)"), "the apply looks in memory too");

        // Stored and held both: the later consent wins and both are taken out.
        let w2 = wallet();
        let (pp2, _) = ping_key();
        let (pp3, _) = ping_key();
        let consent = |pp: &str, ts: u64| {
            let proof = blake3::hash(format!("{}:{}:{}", burn_tx, w2.node, w2.wallet).as_bytes()).to_hex()[..32].to_string();
            let msg = crate::node::BlockchainNode::chain_bind(&format!("client_node_reg:{}:{}:{}:{}", w2.node, w2.wallet, proof, ts));
            let mut req = bind_req(&w2, pp, "tok2", ts, ts);
            req.consent = Some(BindConsent { burn_tx: burn_tx.clone(), registration_proof: proof, timestamp: ts, consent_sig: sign(&w2.sk, &msg) });
            match check_bind(&s, &req, false, now()) { Ok(BindPath::Pending(p)) => p, other => panic!("{other:?}") }
        };
        lb::pending_insert(&s, &consent(&pp2, t), now()).expect("stored");
        lb::deferred_insert(&consent(&pp3, t + 1), "", now()).expect("held");
        register(&s, &w2);
        let row = promote_pending_binding(&s, &w2.node).expect("pending").expect("promoted");
        assert_eq!((row.seq, row.ping_pubkey.as_str()), (t + 1, pp3.as_str()));
        assert!(!lb::deferred_may_contain(&w2.node) && s.get_light_pending_bind(&w2.node).is_none());
    }

    /// L-2: the per-address limit of bind, unbind, token refresh and pending bind counts only failed requests, keys an
    /// IPv6 address by its /64, blocks for a minute, and holds back neither a request that verified nor another address.
    #[test]
    fn only_failed_requests_count_against_an_address_and_a_block_is_short() {
        let l = FailLimiter::new(3, 60, 60);
        let a: std::net::SocketAddr = "203.0.113.7:4000".parse().unwrap();
        let b: std::net::SocketAddr = "203.0.113.8:4000".parse().unwrap();
        let t = 1_000u64;
        assert_eq!(l.blocked(Some(a), t), None);
        l.charge(Some(a), t);
        l.charge(Some(a), t + 1);
        assert_eq!(l.blocked(Some(a), t + 1), None, "two failures");
        l.charge(Some(a), t + 2);
        assert_eq!(l.blocked(Some(a), t + 2), Some(60), "the third blocks it");
        assert_eq!(l.blocked(Some(b), t + 2), None, "another address of the same network is not held");
        assert_eq!(l.blocked(Some(a), t + 62), None, "a minute, not an hour");
        assert_eq!(l.blocked(None, t), None, "an unknown address is never held");
        // An IPv6 host has a /64: every address in it counts together; a mapped IPv4 counts as that IPv4.
        let v6 = |s: &str| -> std::net::SocketAddr { format!("[{s}]:443").parse().unwrap() };
        assert_eq!(light_ip_key("2001:db8:1:2:aa::1".parse().unwrap()), "2001:db8:1:2::/64");
        assert_eq!(light_ip_key("::ffff:198.51.100.9".parse().unwrap()), "198.51.100.9");
        assert_eq!(light_ip_key("198.51.100.9".parse().unwrap()), "198.51.100.9");
        for i in 1..=3 { l.charge(Some(v6(&format!("2001:db8:1:2::{i}"))), t); }
        assert!(l.blocked(Some(v6("2001:db8:1:2:ffff::9")), t).is_some(), "the whole /64");
        assert!(l.blocked(Some(v6("2001:db8:1:3::1")), t).is_none(), "the next /64 is not");
        // Each route charges only its refusals; a request that verified is held by its node's own limit.
        let bind = include_str!("light_bind.rs");
        let h = &bind[bind.find("pub(super) async fn handle_light_node_bind(").unwrap()..];
        let h = &h[..h.find("/// A registration applied longer ago than this").unwrap()];
        assert_eq!(h.matches("BIND_FAIL_LIMIT.charge(remote_addr, now);").count(), 2, "a refused check, no burn seen");
        assert!(!h.contains("check_api_rate_limit("));
        let unbind = include_str!("light_unbind.rs");
        let u = &unbind[unbind.find("pub(super) async fn handle_light_node_unbind(").unwrap()..];
        let u = &u[..u.find("UNBIND_NODE_LIMIT.allows(").unwrap()];
        assert!(u.contains("UNBIND_FAIL_LIMIT.charge(remote_addr, now);") && !u.contains("check_api_rate_limit("));
        let nodes = include_str!("light_nodes.rs");
        let r = &nodes[nodes.find("pub(super) async fn handle_light_node_token_refresh(").unwrap()..];
        let r = &r[..r.find("pub(super) struct LightNodeRegisterRequest").unwrap()];
        let verified = r.find("// The refresh belongs to the stored binding.").unwrap();
        assert_eq!(r[..verified].matches("return fail(").count(), 8, "every refusal up to the signature");
        assert!(!r[verified..].contains("return fail(") && !r.contains("check_api_rate_limit("));
        let m = include_str!("mod.rs");
        for gone in ["\"light_node_bind\"", "\"light_node_unbind\"", "\"light_node_token_refresh\"", "\"light_node_pending_bind\""] {
            assert!(!m.contains(gone), "{gone}: no hour-long per-address bucket");
        }
    }
}

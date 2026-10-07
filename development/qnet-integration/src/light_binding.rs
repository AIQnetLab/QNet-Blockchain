//! Light-node binding v2: which device answers for a light node, and the order of its bindings.
//!
//! A binding names the node's ping key, carries a delegation signed by the wallet key over a sequence
//! number, and wins over every binding with a lower number. Every path that copies a ping key - the
//! bind route, the self-attest heal, the identity pull, gossip and the genesis token sync - admits it
//! through the rules here, so a device that was replaced cannot come back through any of them.
//!
//! Operational state and RPC/P2P policy only. Block validation reads none of it: validators check the
//! owner-signed eligibility bitmaps, never a device signature.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` section 4.

use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};

/// A binding sequence may run this far ahead of this node's clock.
pub const FUTURE_SEQ_SLACK_SECS: u64 = 600;
/// The same bound for a copy of a binding another genesis took (heal, pull, gossip, token sync). That
/// genesis held the sequence to its own clock, and genesis clocks differ, so a copy is held only to a
/// bound no honest binding reaches: it still refuses a sequence written in milliseconds.
pub const COPY_FUTURE_SEQ_SLACK_SECS: u64 = 86_400;
/// An attach or a token refresh is fresh within this many seconds of this node's clock.
pub const FRESH_TS_WINDOW_SECS: u64 = 300;
/// How old a registration consent may be when the node takes it, at submit and at `/bind` (U5): the
/// cabinet signs the owner bind only when the user comes back to the page, which may be hours later.
pub const CONSENT_MAX_AGE_SECS: u64 = 86_400;
/// A pending binding lives until its consent is this old, plus the app's own 10-minute margin.
pub const PENDING_TTL_SECS: u64 = 86_400 + 600;
/// How old the pre-signed attach of a node's first binding may be when it arrives (U3): as long as the app
/// keeps re-sending it and this node keeps it pending. Shorter, a re-send in the last ten minutes to a node
/// whose registration applied at the consent's edge was always refused `expired` (PX-04).
pub const FIRST_BIND_GRACE_SECS: u64 = PENDING_TTL_SECS;
/// Pending bindings one genesis keeps; the oldest goes first. Best effort: a lost entry is re-sent by
/// the app under U3.
pub const PENDING_CAP: usize = 20_000;

/// ML-DSA-65 sizes in hex.
pub const MLDSA65_PK_HEX: usize = 1952 * 2;
pub const MLDSA65_SIG_HEX: usize = 3309 * 2;

/// What this binary serves of the light-node contract; a client switches a form on only when two
/// genesis nodes both list it.
pub const LIGHT_NODE_FEATURES: &[&str] = &["bind_v2", "delegation_v2", "token_refresh_v2", "pending_bind", "consent_24h",
    "uptime", "status_signed", "unbind_v2", "push_v2", "wake", "unbind_wallet"];

/// Listed while a light registration judged at this node's next block takes the owner bind in its v2 form,
/// without a time (`owner_bind_v2_allowed`, from the `wallet_one_node` gate): a client that can sign only that
/// form waits until two genesis nodes list it before it takes a burn. Not `bind_v2`, the device binding.
pub const OWNER_BIND_V2_FEATURE: &str = "owner_bind_v2";

/// What this node lists: the binary's forms, the device layer's two (`device_v1`, `hwping_v2`) only where a
/// device can be counted (`light_device::device_layer_served`), and `owner_bind_v2` once its next block takes it.
pub fn light_node_features() -> Vec<&'static str> {
    let next = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire).saturating_add(1);
    features_at(crate::light_device::device_layer_served(), next)
}

pub fn features_with(device_layer: bool) -> Vec<&'static str> {
    let mut f = LIGHT_NODE_FEATURES.to_vec();
    if device_layer { f.extend(crate::light_device::DEVICE_FEATURES); }
    f
}

/// `features_with`, plus `owner_bind_v2` when a light registration judged at `next_height` takes that bind.
pub fn features_at(device_layer: bool, next_height: u64) -> Vec<&'static str> {
    let mut f = features_with(device_layer);
    if crate::node::BlockchainNode::owner_bind_v2_allowed(&qnet_state::NodeType::Light, next_height) {
        f.push(OWNER_BIND_V2_FEATURE);
    }
    f
}

/// The consent window (`light-node-messages.md` section 4): at most a day old, at most five minutes
/// ahead of this node's clock. Block validation reads no age; this is the RPC's policy.
pub fn consent_ts_in_window(t: u64, now: u64) -> bool {
    t >= now.saturating_sub(CONSENT_MAX_AGE_SECS) && t <= now.saturating_add(FRESH_TS_WINDOW_SECS)
}

/// A stored or gossiped delegation certificate: the legacy form, or `v2.{seq}.{sig}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertForm<'a> {
    V1(&'a str),
    V2 { seq: u64, sig: &'a str },
}

impl CertForm<'_> {
    pub fn seq(&self) -> Option<u64> {
        match self { CertForm::V2 { seq, .. } => Some(*seq), CertForm::V1(_) => None }
    }
}

/// Parse a certificate string. A legacy cert is hex or a `dilithium_sig_` envelope and never starts
/// with `v2.`; a `v2.` string that does not parse exactly is refused, never read as legacy.
pub fn parse_cert(cert: &str) -> Option<CertForm<'_>> {
    match cert.strip_prefix("v2.") {
        None => (!cert.is_empty()).then_some(CertForm::V1(cert)),
        Some(rest) => {
            let (seq, sig) = rest.split_once('.')?;
            let canonical = !seq.is_empty() && seq.len() <= 20
                && seq.bytes().all(|b| b.is_ascii_digit())
                && !(seq.len() > 1 && seq.starts_with('0'));
            if !canonical || sig.is_empty() || sig.contains('.') { return None; }
            let seq: u64 = seq.parse().ok()?;
            (seq > 0).then_some(CertForm::V2 { seq, sig })
        }
    }
}

/// The stored and gossiped form of a v2 delegation: the sequence rides in the existing string field,
/// so the gossip message keeps its field list and an old peer stores it opaquely.
pub fn format_v2_cert(seq: u64, sig_hex: &str) -> String {
    format!("v2.{}.{}", seq, sig_hex)
}

pub fn sha3_hex(bytes: &[u8]) -> String {
    hex::encode(Sha3_256::digest(bytes))
}

pub fn delegation_v1_message(ping_pk_hex: &str, node_id: &str) -> String {
    format!("delegate_ping:{}:{}", ping_pk_hex, node_id)
}

/// `{chain_tag}delegate_ping:v2:{pp}:{N}:{seq}`, signed by the wallet key. The copy paths take a binding
/// on this delegation alone, and one wallet key gives the same node id on every QNet chain, so the chain
/// tag keeps a delegation from one chain out of another chain's gossip.
pub fn delegation_v2_message(ping_pk_hex: &str, node_id: &str, seq: u64) -> String {
    format!("{}delegate_ping:v2:{}:{}:{}", qnet_state::transaction::chain_tag(), ping_pk_hex, node_id, seq)
}

/// `{chain_tag}light_attach:{N}:{hex(sha3(pp))}:{hex(sha3(push_target))}:{seq}:{ts}`, signed by the
/// wallet key. None when the ping key is not hex.
pub fn attach_v2_message(node_id: &str, ping_pk_hex: &str, push_target: &str, seq: u64, ts: u64) -> Option<String> {
    let pp = hex::decode(ping_pk_hex).ok()?;
    Some(format!("{}light_attach:{}:{}:{}:{}:{}", qnet_state::transaction::chain_tag(),
        node_id, sha3_hex(&pp), sha3_hex(push_target.as_bytes()), seq, ts))
}

/// `{chain_tag}token_refresh:{N}:{hex(sha3(push_target))}:{seq}:{ts}`, signed by the ping key.
pub fn token_refresh_v2_message(node_id: &str, push_target: &str, seq: u64, ts: u64) -> String {
    format!("{}token_refresh:{}:{}:{}:{}", qnet_state::transaction::chain_tag(),
        node_id, sha3_hex(push_target.as_bytes()), seq, ts)
}

/// `{chain_tag}light_status:{N}:{ts}`, signed by the ping key or the wallet key (the signed status).
pub fn light_status_message(node_id: &str, ts: u64) -> String {
    format!("{}light_status:{}:{}", qnet_state::transaction::chain_tag(), node_id, ts)
}

/// `{chain_tag}light_poll:{N}:{ts}`, signed by the ping key: a poll of the pending-challenge route that counts as the
/// device's fetch of its challenge.
pub fn light_poll_message(node_id: &str, ts: u64) -> String {
    format!("{}light_poll:{}:{}", qnet_state::transaction::chain_tag(), node_id, ts)
}

/// `{chain_tag}light_unbind:{N}:{seq}:{ts}`, signed by the bound device's ping key at its own sequence.
pub fn light_unbind_message(node_id: &str, seq: u64, ts: u64) -> String {
    format!("{}light_unbind:{}:{}:{}", qnet_state::transaction::chain_tag(), node_id, seq, ts)
}

/// `{chain_tag}light_unbind_wallet:{N}:{seq}:{ts}`, signed by the wallet key K whose EON address owns the node,
/// at the sequence of the binding it withdraws. The token cannot meet the ping form's (`light_unbind:` has the
/// colon straight after it), and the chain tag keeps it on one chain, as for the delegation.
pub fn light_unbind_wallet_message(node_id: &str, seq: u64, ts: u64) -> String {
    format!("{}light_unbind_wallet:{}:{}:{}", qnet_state::transaction::chain_tag(), node_id, seq, ts)
}

/// The public status's device tag: first 16 hex of SHA3-256(`qnet_device_tag_h:v1|` ‖ nonce ‖
/// device_tag), over the 16 nonce bytes of the query. It changes with every nonce, so it tells the
/// device that knows its own tag "this device" and tells nobody else anything.
pub fn device_tag_h(nonce: &[u8; 16], device_tag: &[u8; 32]) -> String {
    let mut h = Sha3_256::new();
    h.update(b"qnet_device_tag_h:v1|");
    h.update(nonce);
    h.update(device_tag);
    hex::encode(h.finalize())[..16].to_string()
}

/// First 16 hex of SHA3-256(`qnet_device_fp:` ‖ ping public key bytes).
pub fn device_fp(ping_pk_hex: &str) -> Option<String> {
    let pp = hex::decode(ping_pk_hex).ok()?;
    let mut h = Sha3_256::new();
    h.update(b"qnet_device_fp:");
    h.update(&pp);
    Some(hex::encode(h.finalize())[..16].to_string())
}

/// The wallet key a legacy push record was accepted under, as the record keeps it: hex SHA3-256 of the key
/// bytes, the form of the key commitment a light registration puts on chain. Empty for a key that is not
/// hex. A legacy record carries no signature of its own, so this is what ties it to a legacy binding row
/// (`BindingRow::identity_pubkey`), or - with no row here yet - to the registration's commitment.
pub fn record_writer(identity_pk_hex: &str) -> String {
    match hex::decode(identity_pk_hex) {
        Ok(pk) if !pk.is_empty() => sha3_hex(&pk),
        _ => String::new(),
    }
}

/// The device's platform as a bind names it (`Platform.OS` of the app; an iPad is "ios"): "android" or
/// "ios", and "" for anything else or nothing. Unsigned and never a reason to refuse: the public status shows
/// it, nothing decides on it.
pub fn platform_hint(platform: Option<&str>) -> &'static str {
    match platform {
        Some("android") => "android",
        Some("ios") => "ios",
        _ => "",
    }
}

/// The longest device model a bind may name, in bytes (ASCII only).
pub const MODEL_HINT_MAX: usize = 40;

/// The device's model as a bind names it (a short marketing name the app builds, never an identifier): the trimmed
/// text when it is 1 to `MODEL_HINT_MAX` ASCII letters, digits, spaces and `. , + ( ) / -`, else "". Unsigned and
/// never a reason to refuse, like `platform_hint`: the public status shows it, nothing decides on it.
pub fn model_hint(model: Option<&str>) -> &str {
    let m = model.unwrap_or("").trim();
    let ok = !m.is_empty() && m.len() <= MODEL_HINT_MAX
        && m.bytes().all(|b| b.is_ascii_alphanumeric() || b" .,+()/-".contains(&b));
    if ok { m } else { "" }
}

/// Canonical push channel name, as stored in `fcm_tokens`.
pub fn canonical_push_type(push_type: Option<&str>) -> &'static str {
    match push_type {
        Some("unifiedpush") => "unifiedpush",
        Some("polling") => "polling",
        _ => "fcm",
    }
}

/// The string the device signs as its push target: the endpoint for UnifiedPush, the token for FCM,
/// nothing for polling.
pub fn push_target<'a>(push_type: &str, token: &'a str, endpoint: Option<&'a str>) -> &'a str {
    match push_type {
        "unifiedpush" => endpoint.unwrap_or(""),
        "polling" => "",
        _ => token,
    }
}

/// Verify a delegation certificate under the node's identity key, in whichever form it comes.
/// Returns the form that verified.
pub fn verify_delegation<'a>(cert: &'a str, ping_pk_hex: &str, node_id: &str, identity_pk_hex: &str) -> Option<CertForm<'a>> {
    let form = parse_cert(cert)?;
    let ok = match form {
        CertForm::V1(sig) => crate::rpc::verify_mobile_dilithium_signature(
            &delegation_v1_message(ping_pk_hex, node_id), sig, identity_pk_hex),
        CertForm::V2 { seq, sig } => crate::rpc::verify_mobile_dilithium_signature(
            &delegation_v2_message(ping_pk_hex, node_id, seq), sig, identity_pk_hex),
    };
    ok.then_some(form)
}

/// One light node's row in `light_ping_keys`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BindingRow {
    pub ping_pubkey: String,
    pub cert: String,
    pub identity_pubkey: String,
    /// The current v2 binding's sequence; 0 for a legacy binding or none.
    pub seq: u64,
    /// Every sequence at or below this is refused (raised by an unbind).
    pub floor: u64,
    pub bound_at: u64,
    /// A v2 binding was ever made for this node: legacy certificates are refused from then on.
    pub v2: bool,
    pub device_fp: String,
    /// On a withdrawn row: the device's own unbind at the floor, so a genesis that missed it can take it
    /// from any peer and re-verify it (the identity pull serves it).
    pub unbind: Option<UnbindRecord>,
    /// The `device_fp` of each legacy ping key this row held before its current one, the latest
    /// `RETIRED_FPS_MAX`: a legacy delegation names no sequence, so this is how a copy of an older one is told
    /// from a new key (`admit_copy`).
    pub retired_fps: Vec<String>,
}

/// Retired legacy ping keys a row remembers.
pub const RETIRED_FPS_MAX: usize = 8;

/// The signed facts of an unbind at the floor: the withdrawn device's key and v2 delegation and its signature
/// over `light_unbind:{N}:{floor}:{ts}`, or (`signer` "wallet") the wallet key's signature over
/// `light_unbind_wallet:{N}:{floor}:{ts}`, with no device key or delegation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnbindRecord {
    pub ts: u64,
    pub sig: String,
    pub ping_pubkey: String,
    pub cert: String,
    /// "" for the bound device's ping key, "wallet" for the wallet key.
    pub signer: String,
}

impl UnbindRecord {
    /// The stored and served form. The signer is written only for the wallet form, so a ping-key row stays as
    /// before and an older binary reads it unchanged.
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({ "ts": self.ts, "sig": self.sig, "ping_pubkey": self.ping_pubkey, "cert": self.cert });
        if !self.signer.is_empty() { v["signer"] = serde_json::json!(self.signer); }
        v
    }
}

impl BindingRow {
    pub fn from_json(v: &serde_json::Value) -> Self {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let n = |k: &str| v[k].as_u64().unwrap_or(0);
        let unbind = v["unbind"].as_object().map(|u| {
            let s = |k: &str| u.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            UnbindRecord {
                ts: u.get("ts").and_then(|x| x.as_u64()).unwrap_or(0),
                sig: s("sig"),
                ping_pubkey: s("ping_pubkey"),
                cert: s("cert"),
                signer: s("signer"),
            }
        });
        BindingRow {
            ping_pubkey: s("ping_pubkey"),
            cert: s("ping_delegation_cert"),
            identity_pubkey: s("identity_pubkey"),
            seq: n("seq"),
            floor: n("floor"),
            bound_at: n("bound_at"),
            v2: v["v2"].as_bool().unwrap_or(false),
            device_fp: s("device_fp"),
            unbind,
            retired_fps: v["retired_fps"].as_array().map(|a| a.iter().filter_map(|x| x.as_str())
                .take(RETIRED_FPS_MAX).map(str::to_string).collect()).unwrap_or_default(),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({
            "ping_pubkey": self.ping_pubkey,
            "ping_delegation_cert": self.cert,
            "identity_pubkey": self.identity_pubkey,
            "seq": self.seq,
            "floor": self.floor,
            "bound_at": self.bound_at,
            "v2": self.v2,
            "device_fp": self.device_fp,
        });
        // Only a withdrawn row carries it: a bound row stays as small as before.
        if let Some(u) = &self.unbind {
            v["unbind"] = u.to_json();
        }
        // Only a legacy row that changed its key carries them.
        if !self.retired_fps.is_empty() {
            v["retired_fps"] = serde_json::json!(self.retired_fps);
        }
        v
    }

    /// The legacy row that replaces this one with `ping_pk`: this row's key, when another, joins the retired ones.
    pub fn retired_with(&self, ping_pk: &str) -> Vec<String> {
        let mut out = self.retired_fps.clone();
        if !self.v2 && !self.ping_pubkey.is_empty() && self.ping_pubkey != ping_pk {
            if let Some(fp) = device_fp(&self.ping_pubkey) {
                out.retain(|f| *f != fp);
                out.push(fp);
            }
        }
        let extra = out.len().saturating_sub(RETIRED_FPS_MAX);
        out.drain(..extra);
        out
    }

    /// No v2 binding was ever made and none was withdrawn: the state a first binding's late delivery
    /// (U3) and legacy certificates are allowed in.
    pub fn never_v2(&self) -> bool {
        never_v2_of(self.v2, self.floor)
    }

    /// The sequence a newer binding must beat.
    pub fn bar(&self) -> u64 {
        if self.v2 { self.seq.max(self.floor) } else { self.floor }
    }

    /// A device answers for the node: a ping key is stored and was not withdrawn. A legacy binding
    /// counts; a v2 row counts while it carries a sequence (an unbind leaves only the floor).
    pub fn device_bound(&self) -> bool {
        device_bound_of(!self.ping_pubkey.is_empty(), self.v2, self.seq)
    }

    /// The writer (`record_writer`) a legacy push record must carry to belong to this row: a legacy row's
    /// own key. None for a v2 row, and for a legacy row an older binary wrote with no key.
    pub fn legacy_writer(&self) -> Option<String> {
        legacy_writer_of(self.v2, &self.identity_pubkey)
    }

    /// A push record at `seq`, written under `writer`, belongs to this binding: for a v2 row a record at
    /// its own sequence (the device signed it under this binding); for a legacy row a legacy record
    /// written under the row's own key, or one whose writer is not known (an older binary's, or an older
    /// peer's copy). A replaced device's record, one for a binding not here yet and one written under
    /// another key belong to nothing.
    pub fn owns_record(&self, seq: u64, writer: &str) -> bool {
        owns_record_of(self.v2, self.seq, || self.legacy_writer(), seq, writer)
    }

    /// The row after an unbind at `seq`: no device and no push channel, every sequence up to `seq`
    /// refused from then on, the proven wallet key kept (or `identity` when none was recorded), and the
    /// unbind's own proof, which a genesis that missed it takes from here.
    pub fn withdrawn(stored: Option<&BindingRow>, seq: u64, identity: &str, proof: Option<UnbindRecord>) -> BindingRow {
        let prev = stored.cloned().unwrap_or_default();
        let identity_pubkey = if prev.identity_pubkey.is_empty() { identity.to_string() } else { prev.identity_pubkey };
        // The proof belongs to the floor: a copy of an older unbind leaves both as they are.
        let unbind = match seq.cmp(&prev.floor) {
            std::cmp::Ordering::Greater => proof,
            std::cmp::Ordering::Equal => proof.or(prev.unbind),
            std::cmp::Ordering::Less => prev.unbind,
        };
        BindingRow { identity_pubkey, floor: prev.floor.max(seq), v2: true, unbind, ..Default::default() }
    }
}

fn never_v2_of(v2: bool, floor: u64) -> bool {
    !v2 && floor == 0
}

fn device_bound_of(has_key: bool, v2: bool, seq: u64) -> bool {
    has_key && (!v2 || seq > 0)
}

fn legacy_writer_of(v2: bool, identity_pubkey: &str) -> Option<String> {
    if v2 || identity_pubkey.is_empty() { return None; }
    Some(record_writer(identity_pubkey)).filter(|w| !w.is_empty())
}

fn owns_record_of(v2: bool, row_seq: u64, legacy_writer: impl FnOnce() -> Option<String>, seq: u64, writer: &str) -> bool {
    if seq != row_seq { return false; }
    if v2 { return seq > 0; }
    writer.is_empty() || legacy_writer().map_or(true, |k| k == writer)
}

/// The fields of a binding row that decide how its device is reached (`light_push::device_reach`) and whether a device
/// record still belongs to it (`light_device::attest::binding_released`), read without the bytes of its keys and
/// certificates (`Storage::light_binding_reach`): the pinger reads it for every node it may push (M-11). Its rules are
/// `BindingRow`'s own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BindingReach {
    /// A ping key is stored.
    pub has_key: bool,
    pub seq: u64,
    pub floor: u64,
    pub v2: bool,
    /// The recorded wallet key of a legacy row (whose record writer and vouching read it); empty for a v2 row.
    pub identity_pubkey: String,
}

impl BindingReach {
    pub fn of(row: &BindingRow) -> Self {
        BindingReach {
            has_key: !row.ping_pubkey.is_empty(),
            seq: row.seq,
            floor: row.floor,
            v2: row.v2,
            identity_pubkey: if row.v2 { String::new() } else { row.identity_pubkey.clone() },
        }
    }

    pub fn never_v2(&self) -> bool {
        never_v2_of(self.v2, self.floor)
    }

    pub fn device_bound(&self) -> bool {
        device_bound_of(self.has_key, self.v2, self.seq)
    }

    pub fn owns_record(&self, seq: u64, writer: &str) -> bool {
        owns_record_of(self.v2, self.seq, || legacy_writer_of(self.v2, &self.identity_pubkey), seq, writer)
    }
}

/// The unbind rule at the genesis the request reached: exactly the binding stored now is withdrawn, by its own
/// device (the ping-key form, "Stop on this device") or by the wallet key at that binding's sequence (the
/// wallet-key form, from any device that holds the wallet). The floor then refuses the withdrawn binding and
/// every older one.
pub fn admit_unbind(stored: Option<&BindingRow>, seq: u64) -> Result<(), Refusal> {
    match stored {
        Some(s) if s.v2 && s.device_bound() && seq == s.seq => Ok(()),
        _ => Err(Refusal::StaleSeq),
    }
}

/// The same unbind copied to another genesis (re-verified from the signer's own signature there): it
/// withdraws the binding at that sequence or any older one, never a newer one. Ok(false) = already
/// withdrawn here, nothing to write.
pub fn admit_unbind_copy(stored: Option<&BindingRow>, seq: u64, now: u64) -> Result<bool, Refusal> {
    if seq == 0 { return Err(Refusal::BadRequest); }
    if seq > now.saturating_add(COPY_FUTURE_SEQ_SLACK_SECS) { return Err(Refusal::FutureSeq); }
    match stored {
        Some(s) if seq <= s.floor => Ok(false),
        Some(s) if s.v2 && s.seq > seq => Err(Refusal::StaleSeq),
        _ => Ok(true),
    }
}

/// Verdict on a ping key copied from somewhere other than the bind route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    Apply,
    /// The binding already stored; nothing to write, nothing to forward.
    Same,
    /// An older binding than the stored one: the device was replaced.
    Stale,
    /// A legacy certificate after a v2 binding exists.
    V1AfterV2,
    FutureSeq,
    Malformed,
}

/// The copy rule (self-attest heal, identity pull, gossip, token sync, the legacy register). A lagging peer
/// catching up may bring the binding already stored or a newer one; nothing older, and nothing legacy once a
/// v2 binding exists. A legacy delegation names no sequence and the legacy register's signature replays, so a
/// legacy key this row held before its current one is refused as older (M-8).
pub fn admit_copy(stored: Option<&BindingRow>, ping_pk: &str, cert: &str, now: u64) -> Admit {
    let form = match parse_cert(cert) { Some(f) => f, None => return Admit::Malformed };
    if ping_pk.is_empty() { return Admit::Malformed; }
    let same_key = stored.map_or(false, |s| s.ping_pubkey == ping_pk);
    match form {
        CertForm::V1(_) => {
            if stored.map_or(false, |s| !s.never_v2()) { return Admit::V1AfterV2; }
            if same_key && stored.map_or(false, |s| s.cert == cert) { return Admit::Same; }
            let retired = stored.zip(device_fp(ping_pk)).map_or(false, |(s, fp)| s.retired_fps.contains(&fp));
            if !same_key && retired { Admit::Stale } else { Admit::Apply }
        }
        CertForm::V2 { seq, .. } => {
            if seq > now.saturating_add(COPY_FUTURE_SEQ_SLACK_SECS) { return Admit::FutureSeq; }
            let Some(s) = stored else { return Admit::Apply; };
            if seq <= s.floor { return Admit::Stale; }
            let current = if s.v2 { s.seq } else { 0 };
            if seq > current { Admit::Apply }
            else if seq == current && same_key { Admit::Same }
            else { Admit::Stale }
        }
    }
}

/// Stable refusal reasons of the binding routes (`light-node-messages.md` section 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotRegistered,
    IdentityMismatch,
    StaleSeq,
    FutureSeq,
    BadSignature,
    Expired,
    RateLimited,
    BadRequest,
    BindV2Required,
}

impl Refusal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Refusal::NotRegistered => "not_registered",
            Refusal::IdentityMismatch => "identity_mismatch",
            Refusal::StaleSeq => "stale_seq",
            Refusal::FutureSeq => "future_seq",
            Refusal::BadSignature => "bad_signature",
            Refusal::Expired => "expired",
            Refusal::RateLimited => "rate_limited",
            Refusal::BadRequest => "bad_request",
            Refusal::BindV2Required => "bind_v2_required",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Refusal::NotRegistered => "The node is not registered on the QNet network",
            Refusal::IdentityMismatch => "The node, the wallet and the wallet key do not belong together",
            Refusal::StaleSeq => "A newer binding exists for this node",
            Refusal::FutureSeq => "The binding sequence is ahead of the network clock",
            Refusal::BadSignature => "A signature does not verify",
            Refusal::Expired => "The request is too old or too far in the future",
            Refusal::RateLimited => "Too many requests for this node",
            Refusal::BadRequest => "The request is malformed",
            Refusal::BindV2Required => "This node is bound with /light-node/bind; use it",
        }
    }

    /// The answer every refusal gives: never `success: true`.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "success": false, "reason": self.as_str(), "error": self.message() })
    }
}

/// The fresh-binding rule of `/light-node/bind`: a sequence above everything stored and not ahead of
/// this node's clock. Re-sending the stored binding (the same key at the same sequence) is accepted
/// as a no-op, because the app posts one binding to two genesis nodes and gossip may beat it.
/// Ok(true) marks that re-send.
pub fn admit_fresh(stored: Option<&BindingRow>, ping_pk: &str, seq: u64, now: u64) -> Result<bool, Refusal> {
    if seq == 0 { return Err(Refusal::StaleSeq); }
    if seq > now.saturating_add(FUTURE_SEQ_SLACK_SECS) { return Err(Refusal::FutureSeq); }
    let Some(s) = stored else { return Ok(false); };
    if seq > s.bar() { return Ok(false); }
    if s.v2 && seq == s.seq && seq > s.floor && s.ping_pubkey == ping_pk { return Ok(true); }
    Err(Refusal::StaleSeq)
}

/// The attach timestamp: within the fresh window, or - for a node that never had a v2 binding - a
/// pre-signed first binding up to a day old whose sequence is its timestamp (U3). A replay of it is
/// harmless: it is the user's own device, and every later binding has a higher sequence.
pub fn admit_attach_ts(stored: Option<&BindingRow>, seq: u64, ts: u64, now: u64) -> Result<(), Refusal> {
    if now.abs_diff(ts) <= FRESH_TS_WINDOW_SECS { return Ok(()); }
    let first = stored.map_or(true, |s| s.never_v2());
    let in_grace = ts >= now.saturating_sub(FIRST_BIND_GRACE_SECS) && ts <= now.saturating_add(FRESH_TS_WINDOW_SECS);
    if first && seq == ts && in_grace { Ok(()) } else { Err(Refusal::Expired) }
}

/// A binding for a node whose registration has not applied yet (U4). Stored by the genesis the app
/// posted it to and promoted when the registration applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingBind {
    pub node_id: String,
    pub wallet: String,
    pub identity_pk: Vec<u8>,
    pub ping_pk: Vec<u8>,
    pub cert_sig: Vec<u8>,
    pub attach_sig: Vec<u8>,
    pub seq: u64,
    pub ts: u64,
    pub push_type: String,
    pub token: String,
    pub endpoint: Option<String>,
    pub burn_tx: String,
    pub consent_ts: u64,
    pub stored_at: u64,
    /// The device's platform hint (`platform_hint`), "" when the bind named none. After the fields of the first
    /// layout, for the stored layouts.
    pub platform: String,
    /// The device's model hint (`model_hint`), "" when the bind named none. Last, for the stored layouts.
    pub model: String,
}

/// The stored layout before `platform` (and, followed by the platform, the one before `model`): bincode is
/// positional, so an entry an older binary stored decodes only as one of these.
#[derive(Deserialize)]
struct PendingBindV1 {
    node_id: String,
    wallet: String,
    identity_pk: Vec<u8>,
    ping_pk: Vec<u8>,
    cert_sig: Vec<u8>,
    attach_sig: Vec<u8>,
    seq: u64,
    ts: u64,
    push_type: String,
    token: String,
    endpoint: Option<String>,
    burn_tx: String,
    consent_ts: u64,
    stored_at: u64,
}

impl PendingBind {
    pub fn expired(&self, now: u64) -> bool {
        now > self.consent_ts.saturating_add(PENDING_TTL_SECS)
    }

    /// A stored entry, in this layout, the one before `model` (read with no model) or the one before `platform`
    /// (read with neither).
    pub fn decode(raw: &[u8]) -> Option<PendingBind> {
        if let Ok(p) = bincode::deserialize::<PendingBind>(raw) { return Some(p); }
        let (o, platform) = bincode::deserialize::<(PendingBindV1, String)>(raw).ok()
            .or_else(|| bincode::deserialize::<PendingBindV1>(raw).ok().map(|o| (o, String::new())))?;
        Some(PendingBind {
            node_id: o.node_id, wallet: o.wallet, identity_pk: o.identity_pk, ping_pk: o.ping_pk, cert_sig: o.cert_sig,
            attach_sig: o.attach_sig, seq: o.seq, ts: o.ts, push_type: o.push_type, token: o.token, endpoint: o.endpoint,
            burn_tx: o.burn_tx, consent_ts: o.consent_ts, stored_at: o.stored_at, platform, model: String::new(),
        })
    }
}

/// One pending binding as the RAM index holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingMeta {
    stored_at: u64,
    consent_ts: u64,
    /// The network it was posted from (`pending_source_key`).
    source: String,
}

impl PendingMeta {
    fn expires_at(&self) -> u64 {
        self.consent_ts.saturating_add(PENDING_TTL_SECS)
    }
}

/// The RAM index of pending bindings. It mirrors the column family, so the apply path asks "is anything pending for
/// this node" without a storage read, and keeps the orders the eviction at the cap reads as entries come and go, so a
/// full store picks its victim in O(log n) (M-10): each network's entries, oldest first; the networks by how many they
/// hold; every entry by when it expires.
#[derive(Debug, Default)]
struct PendingIndex {
    by_node: std::collections::HashMap<String, PendingMeta>,
    by_source: std::collections::HashMap<String, std::collections::BTreeSet<(u64, String)>>,
    /// (entries held, network), the network reversed so that of equal loads the smaller network key sorts last.
    by_load: std::collections::BTreeSet<(usize, std::cmp::Reverse<String>)>,
    by_expiry: std::collections::BTreeSet<(u64, String)>,
}

impl PendingIndex {
    fn len(&self) -> usize {
        self.by_node.len()
    }

    fn contains(&self, node_id: &str) -> bool {
        self.by_node.contains_key(node_id)
    }

    fn load_of(&self, source: &str) -> usize {
        self.by_source.get(source).map_or(0, |s| s.len())
    }

    /// Move `source` in the load order from `before` entries to its count now.
    fn reload(&mut self, source: &str, before: usize) {
        if before > 0 { self.by_load.remove(&(before, std::cmp::Reverse(source.to_string()))); }
        let now = self.load_of(source);
        if now > 0 { self.by_load.insert((now, std::cmp::Reverse(source.to_string()))); }
    }

    fn insert(&mut self, node_id: &str, m: PendingMeta) {
        self.remove(node_id);
        let before = self.load_of(&m.source);
        self.by_source.entry(m.source.clone()).or_default().insert((m.stored_at, node_id.to_string()));
        self.reload(&m.source, before);
        self.by_expiry.insert((m.expires_at(), node_id.to_string()));
        self.by_node.insert(node_id.to_string(), m);
    }

    fn remove(&mut self, node_id: &str) -> Option<PendingMeta> {
        let m = self.by_node.remove(node_id)?;
        let before = self.load_of(&m.source);
        if let Some(set) = self.by_source.get_mut(&m.source) {
            set.remove(&(m.stored_at, node_id.to_string()));
            if set.is_empty() { self.by_source.remove(&m.source); }
        }
        self.reload(&m.source, before);
        self.by_expiry.remove(&(m.expires_at(), node_id.to_string()));
        Some(m)
    }

    /// Take out every entry expired at `now`; their node ids, for the store.
    fn take_expired(&mut self, now: u64) -> Vec<String> {
        let mut out = Vec::new();
        while let Some((at, node)) = self.by_expiry.first().cloned() {
            if at >= now { break; }
            self.remove(&node);
            out.push(node);
        }
        out
    }

    /// Which entry goes when the store is full and one posted from `source` arrives: the oldest of the network holding
    /// the most (of equal loads the smaller network key, so every genesis picks alike; of equal times the smaller node
    /// id). Refused when the newcomer's own network would then hold more than any other: it is the flood.
    fn victim(&self, source: &str) -> Result<Option<String>, Refusal> {
        let Some((held, std::cmp::Reverse(heaviest))) = self.by_load.last() else { return Ok(None); };
        if self.load_of(source) + 1 > *held { return Err(Refusal::RateLimited); }
        Ok(self.by_source.get(heaviest).and_then(|s| s.first()).map(|(_, node)| node.clone()))
    }
}

fn pending_index() -> &'static parking_lot::Mutex<PendingIndex> {
    static M: std::sync::OnceLock<parking_lot::Mutex<PendingIndex>> = std::sync::OnceLock::new();
    M.get_or_init(|| parking_lot::Mutex::new(PendingIndex::default()))
}

/// One lock stripe per node for the read, compare and write of its stored entry, so two inserts for one node never
/// interleave while the index lock is held for memory work only.
fn pending_node_lock(node_id: &str) -> parking_lot::MutexGuard<'static, ()> {
    static LOCKS: std::sync::OnceLock<Vec<parking_lot::Mutex<()>>> = std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| (0..64).map(|_| parking_lot::Mutex::new(())).collect());
    let h = node_id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    locks[(h % locks.len() as u64) as usize].lock()
}

/// The network a pending binding was posted from, the unit its fair share is counted in: an IPv4 /24, an
/// IPv6 /64. Fresh keys cost nothing, so one network holding many pending bindings is the flood, and at the
/// cap its entries go first (NB-4).
pub fn pending_source_key(ip: Option<std::net::IpAddr>) -> String {
    match ip.map(|ip| match ip {
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }) {
        Some(std::net::IpAddr::V4(v4)) => { let o = v4.octets(); format!("{}.{}.{}.0/24", o[0], o[1], o[2]) }
        Some(std::net::IpAddr::V6(v6)) => { let s = v6.segments(); format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3]) }
        None => String::new(),
    }
}

static PENDING_INDEX_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PENDING_INDEX_INIT: parking_lot::Mutex<()> = parking_lot::const_mutex(());

/// Load the index from storage once. Reads only the small meta rows, outside the index lock.
pub fn pending_index_init(storage: &crate::storage::Storage) {
    use std::sync::atomic::Ordering;
    if PENDING_INDEX_READY.load(Ordering::Acquire) { return; }
    let _g = PENDING_INDEX_INIT.lock();
    if PENDING_INDEX_READY.load(Ordering::Acquire) { return; }
    let rows = storage.light_pending_bind_meta();
    {
        let mut ix = pending_index().lock();
        for (node, stored_at, consent_ts, source) in rows {
            ix.insert(&node, PendingMeta { stored_at, consent_ts, source });
        }
    }
    PENDING_INDEX_READY.store(true, Ordering::Release);
}

/// False only when the index is loaded and holds nothing for the node: until it is loaded the answer
/// is "maybe", and the caller's spawned task loads it and looks.
pub fn pending_may_contain(node_id: &str) -> bool {
    !PENDING_INDEX_READY.load(std::sync::atomic::Ordering::Acquire) || pending_index().lock().contains(node_id)
}

/// What storing `p` would do, decided before the node's budget is spent: Ok(true) = this very binding
/// (its key at its sequence) is already pending, a no-op; Ok(false) = it would be stored; Err = an older
/// consent, or another key at the same sequence, which the insert refuses. A replay of an earlier pending
/// bind therefore costs the node nothing and cannot lock the device out of its next real bind.
pub fn pending_admits(storage: &crate::storage::Storage, p: &PendingBind, now: u64) -> Result<bool, Refusal> {
    if !pending_may_contain(&p.node_id) { return Ok(false); }
    match storage.get_light_pending_bind(&p.node_id).filter(|e| !e.expired(now)) {
        None => Ok(false),
        Some(e) if p.seq == e.seq && p.ping_pk == e.ping_pk => Ok(true),
        Some(e) if p.seq <= e.seq => Err(Refusal::StaleSeq),
        Some(_) => Ok(false),
    }
}

/// This very binding (its key at its sequence) is already pending here: storing it again is a no-op.
pub fn pending_holds(storage: &crate::storage::Storage, p: &PendingBind, now: u64) -> bool {
    pending_admits(storage, p, now) == Ok(true)
}

/// Store a pending binding. One per node: a later consent replaces an earlier one, the same one is a
/// no-op, an earlier one is refused. At the cap, expired entries go first, then the oldest of the network
/// holding the most (`pending_source_key`), so a flood from a few networks evicts its own entries, not the
/// real users' still waiting for their registration. Storage I/O: the route calls it on a blocking thread.
pub fn pending_insert(storage: &crate::storage::Storage, p: &PendingBind, now: u64) -> Result<(), Refusal> {
    pending_insert_capped(storage, p, "", now, PENDING_CAP)
}

/// `pending_insert` of a binding posted from the network `source`.
pub fn pending_insert_from(storage: &crate::storage::Storage, p: &PendingBind, source: &str, now: u64) -> Result<(), Refusal> {
    pending_insert_capped(storage, p, source, now, PENDING_CAP)
}

/// The index decides under its lock, in memory only, what goes and where the new entry stands; the store is read and
/// written outside it, under the node's own stripe (`pending_node_lock`).
pub(crate) fn pending_insert_capped(storage: &crate::storage::Storage, p: &PendingBind, source: &str, now: u64, cap: usize)
    -> Result<(), Refusal>
{
    pending_index_init(storage);
    let _node = pending_node_lock(&p.node_id);
    if let Some(existing) = storage.get_light_pending_bind(&p.node_id) {
        if !existing.expired(now) {
            if p.seq < existing.seq { return Err(Refusal::StaleSeq); }
            if p.seq == existing.seq && p.ping_pk == existing.ping_pk { return Ok(()); }
            if p.seq == existing.seq { return Err(Refusal::StaleSeq); }
        }
    }
    let meta = PendingMeta { stored_at: p.stored_at, consent_ts: p.consent_ts, source: source.to_string() };
    let (evicted, refused) = {
        let mut ix = pending_index().lock();
        let mut evicted = Vec::new();
        let mut refused = None;
        if !ix.contains(&p.node_id) && ix.len() >= cap {
            evicted = ix.take_expired(now);
            while ix.len() >= cap {
                match ix.victim(source) {
                    Ok(Some(k)) => { ix.remove(&k); evicted.push(k); }
                    Ok(None) => break,
                    Err(r) => { refused = Some(r); break; }
                }
            }
        }
        if refused.is_none() { ix.insert(&p.node_id, meta.clone()); }
        (evicted, refused)
    };
    for k in &evicted {
        let _ = storage.delete_light_pending_bind(k);
    }
    if let Some(r) = refused { return Err(r); }
    if storage.put_light_pending_bind_from(p, source).is_err() {
        let mut ix = pending_index().lock();
        if ix.by_node.get(&p.node_id) == Some(&meta) { ix.remove(&p.node_id); }
        return Err(Refusal::BadRequest);
    }
    Ok(())
}

/// `PendingIndex::victim` over `entries` (node id, stored_at, network): the eviction rule on its own, for tests.
#[cfg(test)]
pub(crate) fn pending_victim(entries: &[(String, u64, String)], source: &str) -> Result<Option<String>, Refusal> {
    let mut ix = PendingIndex::default();
    for (k, at, s) in entries {
        ix.insert(k, PendingMeta { stored_at: *at, consent_ts: u64::MAX / 2, source: s.clone() });
    }
    ix.victim(source)
}

/// Take a node's pending binding out of the store: the promotion reads it once, whatever it decides.
pub fn pending_take(storage: &crate::storage::Storage, node_id: &str, now: u64) -> Option<PendingBind> {
    pending_index_init(storage);
    let _node = pending_node_lock(node_id);
    // The index mirrors the store, so a node it does not hold costs no storage read or write.
    pending_index().lock().remove(node_id)?;
    let p = storage.get_light_pending_bind(node_id);
    let _ = storage.delete_light_pending_bind(node_id);
    p.filter(|p| !p.expired(now))
}

/// Pending bindings held in memory only: those whose burn this genesis has no evidence of yet (M-10). The QNet Link
/// sheet posts its binding before the site submits the registration, so the burn is seldom known here at that moment.
/// Nothing is written to storage. At most this many are held, under the store's own rules (one per node, a later
/// consent replaces an earlier one; at the cap expired entries go first, then the oldest of the network holding the
/// most), and one is promoted only when the chain applies the node's registration, the chain's own proof of the burn.
/// A restart or a flood may drop one; the app sends the binding again once the chain lists the node (U3).
pub const DEFERRED_CAP: usize = 2_000;

/// The memory tier: its index and the bindings it holds.
#[derive(Debug, Default)]
pub(crate) struct DeferredTier {
    index: PendingIndex,
    entries: std::collections::HashMap<String, PendingBind>,
}

impl DeferredTier {
    /// Hold `p`, posted from the network `source`. Ok(true) = this very binding (its key at its sequence) is held
    /// already, a no-op; an earlier consent, or another key at the same sequence, is refused.
    pub(crate) fn insert(&mut self, p: &PendingBind, source: &str, now: u64, cap: usize) -> Result<bool, Refusal> {
        if self.admits(p, now)? { return Ok(true); }
        if !self.index.contains(&p.node_id) && self.index.len() >= cap {
            for k in self.index.take_expired(now) { self.entries.remove(&k); }
            while self.index.len() >= cap {
                let Some(k) = self.index.victim(source)? else { break; };
                self.index.remove(&k);
                self.entries.remove(&k);
            }
        }
        self.index.insert(&p.node_id, PendingMeta { stored_at: p.stored_at, consent_ts: p.consent_ts, source: source.to_string() });
        self.entries.insert(p.node_id.clone(), p.clone());
        Ok(false)
    }

    /// What holding `p` would do (`pending_admits`' rule): Ok(true) = this very binding is held already, Ok(false) =
    /// it would be held, Err = an earlier consent or another key at the same sequence than the one held.
    pub(crate) fn admits(&self, p: &PendingBind, now: u64) -> Result<bool, Refusal> {
        match self.entries.get(&p.node_id).filter(|e| !e.expired(now)) {
            None => Ok(false),
            Some(e) if p.seq == e.seq && p.ping_pk == e.ping_pk => Ok(true),
            Some(e) if p.seq <= e.seq => Err(Refusal::StaleSeq),
            Some(_) => Ok(false),
        }
    }

    /// This very binding is held, unexpired.
    pub(crate) fn holds(&self, p: &PendingBind, now: u64) -> bool {
        self.admits(p, now) == Ok(true)
    }

    pub(crate) fn contains(&self, node_id: &str) -> bool {
        self.index.contains(node_id)
    }

    /// Take the node's binding out, unexpired.
    pub(crate) fn take(&mut self, node_id: &str, now: u64) -> Option<PendingBind> {
        self.index.remove(node_id)?;
        self.entries.remove(node_id).filter(|p| !p.expired(now))
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.index.len()
    }
}

fn deferred_tier() -> &'static parking_lot::Mutex<DeferredTier> {
    static M: std::sync::OnceLock<parking_lot::Mutex<DeferredTier>> = std::sync::OnceLock::new();
    M.get_or_init(|| parking_lot::Mutex::new(DeferredTier::default()))
}

/// Hold a pending binding posted from the network `source` in memory (`DEFERRED_CAP`); Ok(true) = held already.
pub fn deferred_insert(p: &PendingBind, source: &str, now: u64) -> Result<bool, Refusal> {
    deferred_tier().lock().insert(p, source, now, DEFERRED_CAP)
}

/// What holding a binding in memory would do (`DeferredTier::admits`), decided before the node's budget is spent, so a
/// replay of an earlier one costs the node nothing.
pub fn deferred_admits(p: &PendingBind, now: u64) -> Result<bool, Refusal> {
    deferred_tier().lock().admits(p, now)
}

/// This very binding is held in memory already: a re-send of it changes nothing.
pub fn deferred_holds(p: &PendingBind, now: u64) -> bool {
    deferred_tier().lock().holds(p, now)
}

/// A binding is held in memory for the node (the memory tier's `pending_may_contain`).
pub fn deferred_may_contain(node_id: &str) -> bool {
    deferred_tier().lock().contains(node_id)
}

/// Take the node's binding held in memory: the promotion reads it once, whatever it decides.
pub fn deferred_take(node_id: &str, now: u64) -> Option<PendingBind> {
    deferred_tier().lock().take(node_id, now)
}

#[cfg(test)]
pub(crate) fn pending_index_len() -> usize {
    pending_index().lock().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pp: &str, seq: u64, floor: u64, v2: bool) -> BindingRow {
        let cert = if v2 { format_v2_cert(seq, "ab") } else { "cd".to_string() };
        BindingRow { ping_pubkey: pp.into(), cert, seq, floor, v2, ..Default::default() }
    }

    #[test]
    fn a_v2_cert_round_trips_through_the_gossip_string() {
        let s = format_v2_cert(1_790_000_000, "00ff");
        assert_eq!(s, "v2.1790000000.00ff");
        assert_eq!(parse_cert(&s), Some(CertForm::V2 { seq: 1_790_000_000, sig: "00ff" }));
        // A legacy cert (hex or envelope) is read as legacy.
        assert_eq!(parse_cert("00ff"), Some(CertForm::V1("00ff")));
        assert_eq!(parse_cert("dilithium_sig_light_x_AAAA"), Some(CertForm::V1("dilithium_sig_light_x_AAAA")));
        // A v2 string that is not exactly canonical is refused, never taken as legacy.
        for bad in ["v2.", "v2.12", "v2..ab", "v2.0.ab", "v2.012.ab", "v2.1a.ab", "v2.1.", "v2.1.a.b",
                    "v2.99999999999999999999999.ab", ""] {
            assert_eq!(parse_cert(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_fresh_binding_needs_a_higher_seq_below_the_clock_and_above_the_floor() {
        let now = 1_800_000_000;
        assert_eq!(admit_fresh(None, "pp", now, now), Ok(false));
        assert_eq!(admit_fresh(None, "pp", 0, now), Err(Refusal::StaleSeq));
        assert_eq!(admit_fresh(None, "pp", now + FUTURE_SEQ_SLACK_SECS, now), Ok(false));
        assert_eq!(admit_fresh(None, "pp", now + FUTURE_SEQ_SLACK_SECS + 1, now), Err(Refusal::FutureSeq));
        let stored = row("pp", 100, 0, true);
        assert_eq!(admit_fresh(Some(&stored), "new", 101, now), Ok(false), "newer wins");
        assert_eq!(admit_fresh(Some(&stored), "new", 100, now), Err(Refusal::StaleSeq), "equal seq, other key");
        assert_eq!(admit_fresh(Some(&stored), "new", 99, now), Err(Refusal::StaleSeq));
        assert_eq!(admit_fresh(Some(&stored), "pp", 100, now), Ok(true), "the stored binding re-sent");
        // After an unbind the floor holds even though the row carries no binding.
        let unbound = row("", 0, 150, true);
        assert_eq!(admit_fresh(Some(&unbound), "pp", 150, now), Err(Refusal::StaleSeq));
        assert_eq!(admit_fresh(Some(&unbound), "pp", 151, now), Ok(false));
        // A legacy row is beaten by any v2 binding.
        let legacy = row("pp", 0, 0, false);
        assert_eq!(admit_fresh(Some(&legacy), "pp", 1, now), Ok(false));
    }

    #[test]
    fn a_copy_never_brings_back_an_older_or_a_legacy_binding() {
        let now = 1_800_000_000;
        let stored = row("pp", 100, 0, true);
        assert_eq!(admit_copy(Some(&stored), "old", &format_v2_cert(99, "ab"), now), Admit::Stale);
        assert_eq!(admit_copy(Some(&stored), "old", &format_v2_cert(100, "ab"), now), Admit::Stale);
        assert_eq!(admit_copy(Some(&stored), "pp", &format_v2_cert(100, "ef"), now), Admit::Same);
        assert_eq!(admit_copy(Some(&stored), "new", &format_v2_cert(101, "ab"), now), Admit::Apply);
        assert_eq!(admit_copy(Some(&stored), "old", "legacycert", now), Admit::V1AfterV2);
        // A binding another genesis took ahead of this node's clock is still a copy to take; only a
        // sequence no clock produces is refused.
        assert_eq!(admit_copy(Some(&stored), "new", &format_v2_cert(now + 3600, "ab"), now), Admit::Apply);
        assert_eq!(admit_copy(Some(&stored), "new", &format_v2_cert(now + COPY_FUTURE_SEQ_SLACK_SECS + 1, "ab"), now),
                   Admit::FutureSeq);
        assert_eq!(admit_copy(Some(&stored), "new", &format_v2_cert(now * 1000, "ab"), now), Admit::FutureSeq);
        assert_eq!(admit_copy(Some(&stored), "new", "v2.x.ab", now), Admit::Malformed);
        let floored = row("", 0, 200, true);
        assert_eq!(admit_copy(Some(&floored), "pp", &format_v2_cert(200, "ab"), now), Admit::Stale);
        assert_eq!(admit_copy(Some(&floored), "pp", "legacycert", now), Admit::V1AfterV2);
        // Before any v2 binding the legacy behaviour is unchanged.
        let legacy = row("pp", 0, 0, false);
        assert_eq!(admit_copy(Some(&legacy), "other", "legacycert", now), Admit::Apply);
        assert_eq!(admit_copy(Some(&legacy), "pp", "cd", now), Admit::Same);
        assert_eq!(admit_copy(None, "pp", "legacycert", now), Admit::Apply);
        // M-8: a legacy key the row held before its current one is a copy of an older delegation, refused; a key it
        // never held is a new one. The row keeps the latest RETIRED_FPS_MAX it moved away from.
        let (k0, k1, k2) = ("ab".repeat(8), "cd".repeat(8), "ef".repeat(8));
        let rotated = BindingRow { retired_fps: row(&k0, 0, 0, false).retired_with(&k1), ..row(&k1, 0, 0, false) };
        assert_eq!(rotated.retired_fps, vec![device_fp(&k0).unwrap()]);
        assert_eq!(admit_copy(Some(&rotated), &k0, "legacycert0", now), Admit::Stale);
        assert_eq!(admit_copy(Some(&rotated), &k2, "legacycert2", now), Admit::Apply, "a key never held");
        assert_eq!(admit_copy(Some(&rotated), &k1, "cd", now), Admit::Same);
        assert_eq!(rotated.retired_with(&k2), vec![device_fp(&k0).unwrap(), device_fp(&k1).unwrap()]);
        assert_eq!(rotated.retired_with(&k1), rotated.retired_fps, "the same key retires nothing");
        let full = BindingRow { retired_fps: (0..RETIRED_FPS_MAX).map(|i| format!("{i:016x}")).collect(), ..row(&k1, 0, 0, false) };
        let next = full.retired_with(&k2);
        assert_eq!((next.len(), next.last().cloned()), (RETIRED_FPS_MAX, device_fp(&k1)), "the oldest goes first");
        assert!(row(&k1, 100, 0, true).retired_with(&k2).is_empty(), "a v2 row retires no legacy key");
    }

    #[test]
    fn a_late_first_binding_is_accepted_only_while_the_node_was_never_bound() {
        let now = 1_800_000_000;
        let t = now - 23 * 3600;
        assert_eq!(admit_attach_ts(None, now - 10, now - 10, now), Ok(()));
        assert_eq!(admit_attach_ts(None, t, t, now), Ok(()), "a day-old pre-signed first binding");
        assert_eq!(admit_attach_ts(None, t + 1, t, now), Err(Refusal::Expired), "seq must be its ts");
        assert_eq!(admit_attach_ts(None, now - 90_000, now - 90_000, now), Err(Refusal::Expired));
        // PX-04: the app re-sends the pre-signed binding, and this node keeps it pending, until T + 24 h + 10 min;
        // a re-send in those last ten minutes is still taken, one past them is not.
        let edge = now - PENDING_TTL_SECS;
        assert_eq!(admit_attach_ts(None, edge, edge, now), Ok(()), "the last re-send the app makes");
        assert_eq!(admit_attach_ts(None, now - 86_400 - 300, now - 86_400 - 300, now), Ok(()));
        assert_eq!(admit_attach_ts(None, edge - 1, edge - 1, now), Err(Refusal::Expired));
        let legacy = row("pp", 0, 0, false);
        assert_eq!(admit_attach_ts(Some(&legacy), t, t, now), Ok(()), "a legacy binding is not a v2 one");
        let bound = row("pp", 100, 0, true);
        assert_eq!(admit_attach_ts(Some(&bound), t, t, now), Err(Refusal::Expired));
        let unbound = row("", 0, 100, true);
        assert_eq!(admit_attach_ts(Some(&unbound), t, t, now), Err(Refusal::Expired));
    }

    #[test]
    fn every_refusal_answers_success_false_with_a_stable_reason() {
        for r in [Refusal::NotRegistered, Refusal::IdentityMismatch, Refusal::StaleSeq, Refusal::FutureSeq,
                  Refusal::BadSignature, Refusal::Expired, Refusal::RateLimited, Refusal::BadRequest,
                  Refusal::BindV2Required] {
            let j = r.to_json();
            assert_eq!(j["success"], serde_json::json!(false));
            assert_eq!(j["reason"].as_str(), Some(r.as_str()));
        }
    }

    #[test]
    fn the_push_target_is_what_the_device_registers() {
        assert_eq!(push_target("fcm", "tok", Some("https://e")), "tok");
        assert_eq!(push_target("unifiedpush", "tok", Some("https://e")), "https://e");
        assert_eq!(push_target("unifiedpush", "tok", None), "");
        assert_eq!(push_target("polling", "tok", Some("https://e")), "");
        assert_eq!(canonical_push_type(Some("unifiedpush")), "unifiedpush");
        assert_eq!(canonical_push_type(Some("polling")), "polling");
        assert_eq!(canonical_push_type(None), "fcm");
        assert_eq!(canonical_push_type(Some("apns")), "fcm");
    }

    /// The contract file's node messages, rebuilt with the node's own functions and checked with the
    /// node's own verifier (`docs/protocols/light-node.vectors.json`, section 10 of the messages doc).
    #[test]
    fn the_contract_vectors_match_the_node_preimages_and_verify() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../docs/protocols/light-node.vectors.json"))
            .expect("vectors parse");
        assert_eq!(v["constants"]["chainTag"].as_str(), Some(qnet_state::transaction::chain_tag().as_str()));
        let ping_pk = v["pingKey"]["publicKey"].as_str().expect("ping key");
        assert_eq!(v["pingKey"]["publicKeySha3"].as_str().unwrap(), sha3_hex(&hex::decode(ping_pk).unwrap()));
        let mut checked = 0;
        for (wi, w) in v["wallets"].as_array().expect("wallets").iter().enumerate() {
            let k = w["publicKey"].as_str().unwrap();
            let wallet = w["address"].as_str().unwrap();
            let node = w["nodeId"].as_str().unwrap();
            assert_eq!(crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(k).as_deref(), Some(wallet));
            assert_eq!(crate::rpc::generate_light_node_pseudonym(wallet), node);
            let n = &v["node"][wi];
            assert_eq!(n["nodeId"].as_str(), Some(node));
            let msg = |name: &str| n["messages"].as_array().unwrap().iter()
                .find(|m| m["name"].as_str() == Some(name)).unwrap_or_else(|| panic!("{name}")).clone();
            let num = |m: &serde_json::Value, k: &str| m["inputs"][k].as_str().unwrap().parse::<u64>().unwrap();
            let signer_key = |m: &serde_json::Value| match m["signer"].as_str() {
                Some("wallet") => k.to_string(),
                Some("ping") => ping_pk.to_string(),
                other => panic!("signer {other:?}"),
            };

            let d = msg("delegationV2");
            let built = delegation_v2_message(d["inputs"]["pingPublicKey"].as_str().unwrap(), node, num(&d, "seq"));
            let filed = d["preimage"].as_str().unwrap();
            let cert = format_v2_cert(num(&d, "seq"), d["signature"].as_str().unwrap());
            // Strict (PX-01): the filed delegation is the node's own, chain tag in front, and it verifies. A file
            // regenerated in the untagged form fails here instead of passing and meeting bad_signature live.
            assert!(filed.starts_with(&qnet_state::transaction::chain_tag()), "the delegation carries the chain tag");
            assert_eq!(built, filed);
            assert_eq!(verify_delegation(&cert, ping_pk, node, k).and_then(|f| f.seq()), Some(num(&d, "seq")));
            checked += 1;

            for name in ["attachV2", "attachV2NoPushTarget"] {
                let a = msg(name);
                let target = a["inputs"]["pushTarget"].as_str().unwrap();
                assert_eq!(sha3_hex(target.as_bytes()), a["inputs"]["pushTargetSha3"].as_str().unwrap());
                let built = attach_v2_message(node, ping_pk, target, num(&a, "seq"), num(&a, "ts")).unwrap();
                assert_eq!(built, a["preimage"].as_str().unwrap(), "{name}");
                assert!(crate::rpc::verify_mobile_dilithium_signature(&built, a["signature"].as_str().unwrap(), &signer_key(&a)));
                checked += 1;
            }

            let r = msg("tokenRefreshV2");
            let built = token_refresh_v2_message(node, r["inputs"]["pushTarget"].as_str().unwrap(), num(&r, "seq"), num(&r, "ts"));
            assert_eq!(built, r["preimage"].as_str().unwrap());
            assert!(crate::rpc::verify_mobile_dilithium_signature(&built, r["signature"].as_str().unwrap(), &signer_key(&r)));
            checked += 1;

            // The consent is checked at /bind (U4) with the admission verifier itself.
            let c = msg("consent");
            let proof = c["inputs"]["proof"].as_str().unwrap();
            assert_eq!(proof, &blake3::hash(format!("{}:{}:{}", n["burnTx"].as_str().unwrap(), node, wallet).as_bytes())
                .to_hex()[..32]);
            assert!(crate::rpc::consent_verifies(node, wallet, proof, num(&c, "ts"),
                c["signature"].as_str().unwrap(), k), "consent");
            checked += 1;

            // The signed status, by either key: the same preimage.
            for name in ["statusByPingKey", "statusByWalletKey"] {
                let s = msg(name);
                let built = light_status_message(node, num(&s, "ts"));
                assert_eq!(built, s["preimage"].as_str().unwrap(), "{name}");
                assert!(crate::rpc::verify_mobile_dilithium_signature(&built, s["signature"].as_str().unwrap(), &signer_key(&s)),
                        "{name}");
                checked += 1;
            }

            let u = msg("unbind");
            let built = light_unbind_message(node, num(&u, "seq"), num(&u, "ts"));
            assert_eq!(built, u["preimage"].as_str().unwrap());
            assert!(crate::rpc::verify_mobile_dilithium_signature(&built, u["signature"].as_str().unwrap(), &signer_key(&u)));
            checked += 1;

            // The wallet-key unbind.
            let u = msg("walletUnbind");
            assert_eq!(u["signer"].as_str(), Some("wallet"));
            let built = light_unbind_wallet_message(node, num(&u, "seq"), num(&u, "ts"));
            assert_eq!(built, u["preimage"].as_str().unwrap(), "walletUnbind");
            assert!(crate::rpc::verify_mobile_dilithium_signature(&built, u["signature"].as_str().unwrap(), k), "walletUnbind");
            checked += 1;

            // The claim quote is checked by the claim route's own key rule (H12).
            let c = msg("claimRewards");
            assert_eq!(crate::node::BlockchainNode::chain_bind(&format!("claim_rewards:{}:{}", node, wallet)),
                       c["preimage"].as_str().unwrap());
            assert_eq!(crate::rpc::claim_quote_signer_ok(node, wallet, c["signature"].as_str().unwrap(), k), Ok(()));
            checked += 1;

            // The claim payload (PX-02): the node's own preimage over claims_data and the wallet key's signature.
            let p = msg("claimPayload");
            let data = p["inputs"]["claimsData"].as_str().unwrap();
            assert_eq!(sha3_hex(data.as_bytes()), p["inputs"]["claimsDataSha3"].as_str().unwrap());
            let built = crate::node::BlockchainNode::claim_sign_message(wallet, data, num(&p, "ts"));
            assert_eq!(built, p["preimage"].as_str().unwrap());
            assert!(crate::rpc::verify_mobile_dilithium_signature(&built, p["signature"].as_str().unwrap(), &signer_key(&p)));
            checked += 1;
        }
        assert_eq!(checked, 2 * 11, "every node message of both wallets");
        // The claims_data shape the node quotes and sums (its step-2 check reads `claims[].amount`). The contract
        // file's sample still carries another shape, to be regenerated in this one (node-final-docs, PX-02).
        let quoted = format!(r#"{{"claims":[{{"epoch":155,"amount":12500000000,"proof":[["{}","L"]]}}]}}"#, "ab".repeat(32));
        assert_eq!(qnet_state::Transaction::claim_entries_total(&quoted), Some(12_500_000_000));

        // The public status's device tag, for the test devices of both platforms.
        let st = &v["device"]["status"];
        let nonce: [u8; 16] = hex::decode(st["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
        for platform in ["ios", "android"] {
            let tag: [u8; 32] = hex::decode(v["device"]["deviceTags"][platform].as_str().unwrap()).unwrap()
                .try_into().unwrap();
            assert_eq!(device_tag_h(&nonce, &tag), st["deviceTagH"][platform].as_str().unwrap(), "{platform}");
        }
    }

    #[test]
    fn an_unbind_withdraws_the_binding_and_its_floor_holds() {
        let now = 1_800_000_000;
        let bound = row("pp", 100, 0, true);
        // The device withdraws exactly the binding it holds.
        assert_eq!(admit_unbind(Some(&bound), 100), Ok(()));
        assert_eq!(admit_unbind(Some(&bound), 99), Err(Refusal::StaleSeq), "an older binding's device");
        assert_eq!(admit_unbind(Some(&bound), 101), Err(Refusal::StaleSeq));
        assert_eq!(admit_unbind(Some(&row("pp", 0, 0, false)), 0), Err(Refusal::StaleSeq),
                   "a legacy binding has no sequence to withdraw");
        assert_eq!(admit_unbind(None, 100), Err(Refusal::StaleSeq));

        let proof = UnbindRecord { ts: now, sig: "s".into(), ping_pubkey: "pp".into(), cert: bound.cert.clone(),
                                   ..Default::default() };
        let after = BindingRow::withdrawn(Some(&BindingRow { identity_pubkey: "k".into(), ..bound.clone() }), 100, "other",
                                          Some(proof.clone()));
        assert_eq!((after.ping_pubkey.as_str(), after.cert.as_str(), after.seq, after.floor, after.v2), ("", "", 0, 100, true));
        assert_eq!(after.identity_pubkey, "k", "the proven wallet key stays");
        assert_eq!(after.unbind.as_ref(), Some(&proof), "the unbind's proof stays with its floor");
        assert_eq!(BindingRow::from_json(&after.to_json()), after, "and survives the stored form");
        assert!(after.to_json()["unbind"].get("signer").is_none(), "a ping-key row is stored as before");
        assert!(bound.to_json().get("unbind").is_none(), "a bound row carries none");
        // The wallet-key form keeps its signer and no device key.
        let by_wallet = UnbindRecord { ts: now, sig: "w".into(), signer: "wallet".into(), ..Default::default() };
        let w_after = BindingRow::withdrawn(Some(&bound), 100, "k", Some(by_wallet.clone()));
        assert_eq!(w_after.to_json()["unbind"]["signer"], serde_json::json!("wallet"));
        assert_eq!(BindingRow::from_json(&w_after.to_json()).unbind, Some(by_wallet));
        assert!(!after.device_bound());
        assert_eq!(after.bar(), 100, "a new binding must beat the floor");
        // A copy of an older unbind leaves the floor and its proof alone.
        let older = BindingRow::withdrawn(Some(&after), 90, "k", Some(UnbindRecord { ts: 1, ..proof.clone() }));
        assert_eq!((older.floor, older.unbind.as_ref()), (100, Some(&proof)));
        // The replay of the same unbind finds nothing to withdraw.
        assert_eq!(admit_unbind(Some(&after), 100), Err(Refusal::StaleSeq));
        // Nothing at or under the floor comes back: not by bind, not by any copy path.
        assert_eq!(admit_fresh(Some(&after), "pp", 100, now), Err(Refusal::StaleSeq));
        assert_eq!(admit_copy(Some(&after), "pp", &format_v2_cert(100, "ab"), now), Admit::Stale);
        assert_eq!(admit_copy(Some(&after), "pp", "legacycert", now), Admit::V1AfterV2);
        assert_eq!(admit_attach_ts(Some(&after), now - 3600, now - 3600, now), Err(Refusal::Expired));
        assert_eq!(admit_fresh(Some(&after), "new", 101, now), Ok(false), "Use this device rebinds above it");
        // A genesis that missed the v2 binding and still holds a legacy one leaves the legacy path too
        // when the unbind's copy reaches it.
        let legacy_after = BindingRow::withdrawn(Some(&row("pp", 0, 0, false)), 500, "k", None);
        assert!(!legacy_after.never_v2());

        // The copy at another genesis withdraws that binding or an older one, never a newer one.
        assert_eq!(admit_unbind_copy(Some(&bound), 100, now), Ok(true));
        assert_eq!(admit_unbind_copy(Some(&row("pp", 90, 0, true)), 100, now), Ok(true), "it missed the bind");
        assert_eq!(admit_unbind_copy(Some(&row("pp", 120, 0, true)), 100, now), Err(Refusal::StaleSeq), "a newer binding");
        assert_eq!(admit_unbind_copy(Some(&after), 100, now), Ok(false), "already withdrawn");
        assert_eq!(admit_unbind_copy(None, 100, now), Ok(true));
        assert_eq!(admit_unbind_copy(Some(&bound), 0, now), Err(Refusal::BadRequest));
        assert_eq!(admit_unbind_copy(Some(&bound), now + COPY_FUTURE_SEQ_SLACK_SECS + 1, now), Err(Refusal::FutureSeq));
    }

    #[test]
    fn a_withdrawn_binding_answers_for_no_device() {
        assert!(row("pp", 0, 0, false).device_bound(), "a legacy binding");
        assert!(row("pp", 100, 0, true).device_bound(), "a v2 binding");
        assert!(!row("", 0, 150, true).device_bound(), "after an unbind only the floor is left");
        assert!(!row("pp", 0, 150, true).device_bound(), "a v2 row without a sequence binds nothing");
        assert!(!BindingRow::default().device_bound());
    }

    /// A push record belongs to a binding only at its sequence, and a legacy one only under its key.
    #[test]
    fn a_push_record_belongs_to_one_binding() {
        let (k, m) = ("ab".repeat(1952), "cd".repeat(1952));
        let (wk, wm) = (record_writer(&k), record_writer(&m));
        assert_eq!(wk.len(), 64);
        assert_eq!(wk, sha3_hex(&hex::decode(&k).unwrap()), "the chain's commitment form");
        assert_ne!(wk, wm);
        assert_eq!(record_writer(&k.to_uppercase()), wk, "the key's bytes, whatever the hex case");
        assert_eq!(record_writer("not hex"), "");
        let v2 = row("pp", 200, 0, true);
        assert!(v2.owns_record(200, ""));
        assert!(!v2.owns_record(100, ""), "a replaced device's record");
        assert!(!v2.owns_record(0, &wk), "a legacy record");
        assert_eq!(v2.legacy_writer(), None);
        let legacy = BindingRow { identity_pubkey: k.clone(), ..row("pp", 0, 0, false) };
        assert_eq!(legacy.legacy_writer(), Some(wk.clone()));
        assert!(legacy.owns_record(0, &wk));
        assert!(!legacy.owns_record(0, &wm), "written under another key");
        assert!(legacy.owns_record(0, ""), "an older binary's record");
        assert!(!legacy.owns_record(200, ""), "a v2 record for a binding not here yet");
        assert!(row("pp", 0, 0, false).owns_record(0, &wm), "a row with no recorded key takes any legacy record");
        assert!(!row("", 0, 150, true).owns_record(0, ""), "a withdrawn row owns nothing");
    }

    /// The slim view of a row (`BindingReach`) answers every question the pinger asks exactly as the row does.
    #[test]
    fn the_slim_view_of_a_row_answers_as_the_row() {
        let k = "ab".repeat(32);
        let wk = record_writer(&k);
        let rows = [row("pp", 200, 0, true), row("", 0, 150, true), row("pp", 0, 0, false),
                    BindingRow { identity_pubkey: k.clone(), ..row("pp", 0, 0, false) }, row("pp", 300, 120, true)];
        for r in &rows {
            let v = BindingReach::of(r);
            assert_eq!((v.never_v2(), v.device_bound()), (r.never_v2(), r.device_bound()), "{r:?}");
            for (seq, writer) in [(0u64, ""), (0, wk.as_str()), (0, "ff"), (200, ""), (300, wk.as_str()), (100, "")] {
                assert_eq!(v.owns_record(seq, writer), r.owns_record(seq, writer), "{r:?} {seq} {writer}");
            }
            assert_eq!(v.identity_pubkey.is_empty(), r.v2 || r.identity_pubkey.is_empty(), "no key bytes for a v2 row");
        }
    }

    /// M-10: the pending store's index keeps its orders as entries come and go, so the cap's victim is found without a
    /// pass over the store: expired entries first, then the oldest of the network holding the most, and the network that
    /// would hold the most refused outright.
    #[test]
    fn the_pending_index_picks_its_victim_from_orders_kept_as_entries_come_and_go() {
        let m = |at: u64, consent: u64, src: &str| PendingMeta { stored_at: at, consent_ts: consent, source: src.to_string() };
        let mut ix = PendingIndex::default();
        assert_eq!(ix.victim("a"), Ok(None), "an empty store");
        ix.insert("u1", m(5, 1_000, "1.2.3.0/24"));
        ix.insert("j1", m(10, 1_000, "6.6.6.0/24"));
        ix.insert("j2", m(11, 1_000, "6.6.6.0/24"));
        ix.insert("j3", m(9, 1_000, "6.6.6.0/24"));
        assert_eq!(ix.len(), 4);
        assert_eq!(ix.victim("9.9.9.0/24"), Ok(Some("j3".to_string())), "the flood's oldest");
        assert_eq!(ix.victim("6.6.6.0/24"), Err(Refusal::RateLimited), "the flood's newcomer");
        // Replacing an entry moves it, removing one updates every order.
        ix.insert("j3", m(20, 1_000, "1.2.3.0/24"));
        assert_eq!((ix.load_of("6.6.6.0/24"), ix.load_of("1.2.3.0/24")), (2, 2));
        assert_eq!(ix.victim("9.9.9.0/24"), Ok(Some("u1".to_string())), "equal loads: the smaller network key");
        assert_eq!(ix.remove("u1").map(|e| e.stored_at), Some(5));
        assert_eq!(ix.victim("9.9.9.0/24"), Ok(Some("j1".to_string())));
        assert_eq!(ix.remove("u1"), None);
        // Expiry by consent time plus the store's lifetime, oldest first, every order cleared.
        ix.insert("old", m(1, 10, "5.5.5.0/24"));
        let expired = ix.take_expired(10 + PENDING_TTL_SECS + 1);
        assert_eq!(expired, vec!["old".to_string()]);
        assert!(!ix.contains("old") && ix.load_of("5.5.5.0/24") == 0 && ix.by_source.get("5.5.5.0/24").is_none());
        assert!(ix.take_expired(1_000).is_empty(), "nothing else expired");
        let total: usize = ix.by_source.values().map(|s| s.len()).sum();
        assert_eq!((total, ix.by_expiry.len(), ix.by_load.iter().map(|(n, _)| n).sum::<usize>()), (ix.len(), ix.len(), ix.len()));
    }
}

//! Ping replies (A7, A8, spec section 5.8): the anchor a reply signs and the device's own signature over it,
//! checked by a shard owner on its HTTP ingress and on relay admission alike, in the spec's order:
//! structure, the anchor, one reply per node per epoch (the callers' dedupe), the device record, the device
//! signature and its counter, then σ under the node's ping key (the shared verifier
//! `SimplifiedP2P::verify_light_ping_signature`, which calls into here).
//!
//! Before `LIGHT_DEVICE_ENFORCE_EPOCH` a reply without the device signature counts as it does today, so
//! installed apps keep working; a `ping_hw2` reply counts only when every check passes. A server stamp is
//! credited only by its issuer on HTTP ingress, never on relay (only the issuer can check it). A relay
//! anchored above this owner's tip waits for the tip (`HeldRelays`) instead of being refused. RPC and P2P
//! policy: no block rule reads any of it.

use super::messages::{self, HwPingWire};
use super::record::DeviceRecord;
use super::{store, Platform, EPOCH_BLOCKS, LIGHT_DEVICE_ENFORCE_EPOCH};
use crate::storage::Storage;

/// An Android `hw_seq` further ahead of this node's clock than this is refused: the app takes
/// `max(now_ms, last + 1)`, and a far one would lock the key's counter.
pub const MAX_HW_SEQ_AHEAD_MS: u64 = 86_400_000;
/// Only blocks at least this far below the tip are remembered as checked anchors: one near the tip may
/// still be replaced.
const ANCHOR_CACHE_DEPTH: u64 = 64;

/// Why a reply is not credited. Logged by code; the ping route's answer does not name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyRefusal {
    /// Not one of the reply forms, or a device reply to anything but a self-attestation.
    Malformed,
    /// The anchor is not a canonical block of the current epoch at most the tip, or a relay's
    /// `block_height` does not fit it (`relay_height_fits`).
    Anchor,
    /// A relayed reply to a server stamp.
    StampOnRelay,
    /// A reply without the device signature from the enforcement epoch on.
    Legacy,
    /// `compact_bin:` for a light node.
    CompactBin,
    /// No device record here decides the node's replies.
    NoRecord,
    /// The record does not count in the anchor's epoch (its state, its effective epoch, its lease or rotation).
    NotCounted,
    /// The device signature does not verify under the recorded key.
    DeviceSignature,
    /// The iOS counter or Android `hw_seq` is not above the last one taken.
    Counter,
    /// σ does not verify under the node's ping key and delegation.
    Sigma,
}

impl ReplyRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            ReplyRefusal::Malformed => "malformed",
            ReplyRefusal::Anchor => "anchor",
            ReplyRefusal::StampOnRelay => "stamp_on_relay",
            ReplyRefusal::Legacy => "legacy_after_enforcement",
            ReplyRefusal::CompactBin => "compact_bin_light",
            ReplyRefusal::NoRecord => "no_device_record",
            ReplyRefusal::NotCounted => "device_not_counted",
            ReplyRefusal::DeviceSignature => "device_signature",
            ReplyRefusal::Counter => "device_counter",
            ReplyRefusal::Sigma => "ping_signature",
        }
    }
}

/// Where a reply is checked: the HTTP ingress (its caller already checked a stamp it issued) or relay
/// admission, with the record's unsigned `block_height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Ingress,
    Relay { block_height: u64 },
}

/// A reply without the device signature still counts in `epoch`.
pub fn legacy_counts(epoch: u64) -> bool {
    epoch < LIGHT_DEVICE_ENFORCE_EPOCH
}

/// `selfattest:{h}:{hash}`: the block every reply signs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub height: u64,
    pub hash: String,
}

impl Anchor {
    /// The exact form only: a decimal height and a 64-hex hash.
    pub fn parse(challenge: &str) -> Option<Anchor> {
        let (h, hash) = challenge.strip_prefix("selfattest:")?.split_once(':')?;
        if !messages::is_decimal(h) || !messages::is_hex64(hash) { return None; }
        Some(Anchor { height: h.parse().ok()?, hash: hash.to_string() })
    }

    pub fn epoch(&self) -> u64 {
        self.height / EPOCH_BLOCKS
    }
}

/// Anchors already found canonical in the current epoch.
pub struct AnchorCache {
    inner: std::sync::OnceLock<parking_lot::RwLock<(u64, std::collections::HashMap<u64, String>)>>,
}

impl AnchorCache {
    pub const fn new() -> Self {
        AnchorCache { inner: std::sync::OnceLock::new() }
    }

    fn map(&self) -> &parking_lot::RwLock<(u64, std::collections::HashMap<u64, String>)> {
        self.inner.get_or_init(|| parking_lot::RwLock::new((u64::MAX, std::collections::HashMap::new())))
    }

    fn hit(&self, a: &Anchor) -> bool {
        let m = self.map().read();
        m.0 == a.epoch() && m.1.get(&a.height) == Some(&a.hash)
    }

    fn put(&self, a: &Anchor) {
        let mut m = self.map().write();
        if m.0 != a.epoch() { *m = (a.epoch(), std::collections::HashMap::new()); }
        if m.1.len() < EPOCH_BLOCKS as usize { m.1.insert(a.height, a.hash.clone()); }
    }
}

impl Default for AnchorCache {
    fn default() -> Self {
        Self::new()
    }
}

static ANCHORS: AnchorCache = AnchorCache::new();

/// The anchor is a canonical block of the tip's epoch at most the tip (`canonical` gives a height's hash).
pub fn anchor_current(cache: &AnchorCache, a: &Anchor, tip: u64, canonical: impl FnOnce(u64) -> Option<String>) -> bool {
    if a.height > tip || a.epoch() != tip / EPOCH_BLOCKS { return false; }
    if cache.hit(a) { return true; }
    let ok = canonical(a.height).map_or(false, |c| c == a.hash);
    if ok && a.height.saturating_add(ANCHOR_CACHE_DEPTH) <= tip { cache.put(a); }
    ok
}

/// `anchor_current` against this node's chain.
pub fn anchor_on_chain(storage: &Storage, a: &Anchor, tip: u64) -> bool {
    anchor_current(&ANCHORS, a, tip, |h| storage.get_microblock_hash_hex(h).ok().flatten())
}

/// A relayed record's unsigned `block_height` fits the anchor it carries: its height, for a `ping_hw2`
/// reply (spec section 5.8). A legacy reply, while legacy replies count, may carry any later height of the
/// anchor's epoch: a genesis of the previous binary relays with its tip, and the height adds nothing the
/// anchor does not already prove (σ signs `h`, the anchor must be of the current epoch, and the credit goes
/// by `block_height`'s epoch, which is then the same).
pub fn relay_height_fits(a: &Anchor, block_height: u64, device_reply: bool) -> bool {
    if block_height == a.height { return true; }
    !device_reply && legacy_counts(a.epoch()) && block_height > a.height && block_height / EPOCH_BLOCKS == a.epoch()
}

/// What a relayed reply must show before any signature is checked: an anchor its record's unsigned
/// `block_height` fits (`relay_height_fits`). A server stamp is never credited on relay.
pub fn relay_anchor(challenge: &str, signature: &str, block_height: u64) -> Result<Anchor, ReplyRefusal> {
    match Anchor::parse(challenge) {
        None => Err(ReplyRefusal::StampOnRelay),
        Some(a) if !relay_height_fits(&a, block_height, signature.starts_with("ping_hw2:")) => Err(ReplyRefusal::Anchor),
        Some(a) => Ok(a),
    }
}

/// How long a relayed reply whose anchor is above this owner's tip waits for the tip to reach it.
pub const RELAY_HOLD_SECS: u64 = 60;
/// Relayed replies held at once. Non-genesis relays share at most half, one pinger at most a quarter, so
/// a registered relay cannot crowd the genesis relays out.
pub const RELAY_HOLD_MAX: usize = 4096;
/// Bytes the held replies may take together, whatever their count.
pub const RELAY_HOLD_BYTES_MAX: usize = 32 * 1024 * 1024;
/// The largest reply (`light_node_signature`) or pinger signature a relay may carry. An honest reply is under
/// 8 KB (a `ping_hw2` wire: σ in hex and a device signature of at most 1 KB; a legacy `ping_dilithium`
/// envelope), and so is a pinger's signature; nothing signs this field on relay, so it is bounded here.
pub const RELAY_FIELD_MAX: usize = 16 * 1024;
/// The largest challenge a relay may carry (`selfattest:{h}:{hash}` is 86 bytes).
pub const RELAY_CHALLENGE_MAX: usize = 256;

/// A non-genesis relay's pinger: registered on chain, with the consensus key the chain committed for it bound
/// in the key registry, so its signature is checked under that key. A light node registers no consensus key,
/// and an id with no binding would be verified trust-on-first-sight: anyone could sign as it.
pub fn relay_pinger_admissible(storage: &Storage, pinger: &str) -> bool {
    storage.node_reg_height(pinger).ok().flatten().is_some()
        && storage.load_vrf_public_key(pinger).ok().flatten().map_or(false, |committed| {
            qnet_consensus::consensus_crypto::get_consensus_pk(pinger).as_deref() == Some(committed.as_slice())
        })
}

/// A relayed attestation's fields, before anything reads the chain, verifies or holds it: each bounded, and
/// the reply in a form `verify_reply` can take (a parsed `ping_hw2` wire, or a `ping_dilithium` envelope;
/// the heartbeat form only for a non-light identity). A reply nobody could credit is dropped at once.
pub fn relay_fields_well_formed(node: &str, challenge: &str, reply: &str, pinger_sig: &str) -> bool {
    if challenge.is_empty() || challenge.len() > RELAY_CHALLENGE_MAX || reply.len() > RELAY_FIELD_MAX
        || pinger_sig.len() > RELAY_FIELD_MAX {
        return false;
    }
    sigma_text(reply).is_some() || (reply.starts_with("compact_bin:") && !node.starts_with("light_"))
}

/// A relayed reply's anchor against this owner's chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayAnchor {
    /// A canonical block of the tip's epoch at most the tip (`anchor_current`).
    Current,
    /// Above the tip, in its epoch or the next: this owner is behind the genesis that credited the reply at
    /// its own tip. Held until the tip reaches it (`HeldRelays`), then checked again in full.
    AboveTip,
    Refused,
}

/// `anchor_current` for a relay, which may wait for this owner's tip instead (`RelayAnchor::AboveTip`).
pub fn relay_anchor_state(cache: &AnchorCache, a: &Anchor, tip: u64, canonical: impl FnOnce(u64) -> Option<String>) -> RelayAnchor {
    if a.height > tip {
        let tip_epoch = tip / EPOCH_BLOCKS;
        return if a.epoch() == tip_epoch || a.epoch() == tip_epoch + 1 { RelayAnchor::AboveTip } else { RelayAnchor::Refused };
    }
    if anchor_current(cache, a, tip, canonical) { RelayAnchor::Current } else { RelayAnchor::Refused }
}

/// Whether the gossip-echo dedupe, which keys on this owner's LOCAL epoch, may drop a relayed reply: not
/// when its anchor is in a later epoch than the tip's. The node was usually credited here in the tip's epoch
/// already (one reply per node per epoch, slot numbers repeat), so that reply would read as an echo; it is
/// held for the tip instead (`RelayAnchor::AboveTip`) and deduped again once the tip reaches it.
pub fn relay_echo_dedupe_applies(parsed: &Result<Anchor, ReplyRefusal>, tip: u64) -> bool {
    !matches!(parsed, Ok(a) if a.epoch() > tip / EPOCH_BLOCKS)
}

/// `relay_anchor_state` against this node's chain.
pub fn relay_anchor_on_chain(storage: &Storage, a: &Anchor, tip: u64) -> RelayAnchor {
    relay_anchor_state(&ANCHORS, a, tip, |h| storage.get_microblock_hash_hex(h).ok().flatten())
}

/// Relayed replies waiting for this owner's tip to reach their anchors (`RelayAnchor::AboveTip`): one per
/// (node, pinger), which is what a gossip echo repeats, bounded in time (`RELAY_HOLD_SECS`) and number
/// (`RELAY_HOLD_MAX`). A held reply is checked again in full once due; nothing is credited on holding.
pub struct HeldRelays<T> {
    held: std::collections::HashMap<(String, String), HeldRelay<T>>,
    per_pinger: std::collections::HashMap<String, usize>,
    non_genesis: usize,
    bytes: usize,
}

struct HeldRelay<T> {
    anchor_height: u64,
    since: u64,
    genesis: bool,
    /// Sent to this owner by the pinger itself, not forwarded by a peer.
    direct: bool,
    size: usize,
    item: T,
}

impl<T> HeldRelays<T> {
    pub fn new() -> Self {
        HeldRelays { held: std::collections::HashMap::new(), per_pinger: std::collections::HashMap::new(), non_genesis: 0,
                     bytes: 0 }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Hold `item` (`size` bytes) until the tip reaches `anchor_height`. False when already held, or full by
    /// count or bytes. The copy the pinger sent itself (`direct`) replaces one a peer forwarded first: nothing
    /// signs the reply on relay, so a forwarder could otherwise park a tampered copy ahead of the real one.
    #[allow(clippy::too_many_arguments)]
    pub fn hold(&mut self, node: &str, pinger: &str, genesis: bool, direct: bool, anchor_height: u64, now: u64, size: usize,
                item: T) -> bool {
        let key = (node.to_string(), pinger.to_string());
        if let Some(h) = self.held.get_mut(&key) {
            if !direct || h.direct || self.bytes - h.size + size > RELAY_HOLD_BYTES_MAX { return false; }
            self.bytes = self.bytes - h.size + size;
            *h = HeldRelay { anchor_height, since: now, genesis, direct, size, item };
            return true;
        }
        if self.held.len() >= RELAY_HOLD_MAX || self.bytes.saturating_add(size) > RELAY_HOLD_BYTES_MAX
            || (!genesis && self.non_genesis >= RELAY_HOLD_MAX / 2)
            || self.per_pinger.get(pinger).map_or(false, |n| *n >= RELAY_HOLD_MAX / 4) {
            return false;
        }
        *self.per_pinger.entry(pinger.to_string()).or_insert(0) += 1;
        if !genesis { self.non_genesis += 1; }
        self.bytes += size;
        self.held.insert(key, HeldRelay { anchor_height, since: now, genesis, direct, size, item });
        true
    }

    /// Take the held replies whose anchor the tip reached, to be checked again; those held longer than
    /// `RELAY_HOLD_SECS` are dropped. Returns the due ones and the count dropped.
    pub fn take_due(&mut self, tip: u64, now: u64) -> (Vec<T>, usize) {
        let keys: Vec<(String, String)> = self.held.iter()
            .filter(|(_, h)| h.anchor_height <= tip || now.saturating_sub(h.since) >= RELAY_HOLD_SECS)
            .map(|(k, _)| k.clone()).collect();
        let (mut due, mut dropped) = (Vec::new(), 0);
        for k in keys {
            let Some(h) = self.held.remove(&k) else { continue; };
            if let Some(n) = self.per_pinger.get_mut(&k.1) {
                *n -= 1;
                if *n == 0 { self.per_pinger.remove(&k.1); }
            }
            if !h.genesis { self.non_genesis -= 1; }
            self.bytes -= h.size;
            if h.anchor_height <= tip { due.push(h.item); } else { dropped += 1; }
        }
        (due, dropped)
    }
}

impl<T> Default for HeldRelays<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// A relayed device reply refused for this: the relaying genesis credited it on its own ingress (it relays
/// nothing else), so this owner's record of the node is missing or behind it (a statement or a state change
/// that never reached it) and a pull of that genesis's record heals it. A fault of the reply itself (its
/// anchor, its counter, σ) is not healed by a pull.
pub fn heals_by_record_pull(r: ReplyRefusal) -> bool {
    matches!(r, ReplyRefusal::NoRecord | ReplyRefusal::NotCounted | ReplyRefusal::DeviceSignature)
}

/// The ping key's signature in a reply, in the form `verify_mobile_dilithium_signature` takes: the inner
/// string of `ping_dilithium:`, or σ's hex of `ping_hw2:`.
pub fn sigma_text(signature: &str) -> Option<String> {
    if let Some(inner) = signature.strip_prefix("ping_dilithium:") {
        return Some(inner.to_string());
    }
    messages::parse_hwping_wire(signature).map(|w| hex::encode(w.sigma))
}

/// The device record that decides a node's replies here: the record, while its binding holds it (a Stop
/// or a later binding releases it, `attest::binding_released`). A provisional record decides too: it
/// never counts.
pub fn governing_record(storage: &Storage, node: &str) -> Option<DeviceRecord> {
    storage.device_record(node).filter(|r| !super::attest::binding_released(storage, r))
}

/// A device reply that passed steps 4 and 5: the key and the counter to take once σ verifies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwAccepted {
    pub hw_key: String,
    pub counter: u64,
}

/// Steps 4 and 5 of a `ping_hw2` reply: a record here that counts in the anchor's epoch (its state from
/// `active` or `suspect`, its effective epoch reached, lease and rotation inside their windows), and the
/// device signature under the recorded key with the counter above the last one taken. Nothing written.
pub fn check_device_reply(storage: &Storage, verifier: &super::evidence::Verifier, node: &str, a: &Anchor, w: &HwPingWire,
                          now: u64) -> Result<HwAccepted, ReplyRefusal> {
    let r = governing_record(storage, node).ok_or(ReplyRefusal::NoRecord)?;
    let registered = storage.is_node_registration_onchain(node);
    if !r.state_now(registered, a.epoch(), now).counts() || r.effective_epoch > a.epoch() {
        return Err(ReplyRefusal::NotCounted);
    }
    let hw_pub = r.hw_pub_bytes().ok_or(ReplyRefusal::NoRecord)?;
    let preimage = messages::hwping_preimage(node, a.height, &a.hash, &w.sigma, w.hw_seq);
    let last = store::last_counter(storage, &r);
    let counter = match r.platform {
        Platform::Ios => verifier.verify_known_key(Platform::Ios, &hw_pub, &w.device_sig, &preimage, last)
            .map_err(|e| if e.code == "counter_not_increasing" { ReplyRefusal::Counter } else { ReplyRefusal::DeviceSignature })? as u64,
        Platform::Android => {
            verifier.verify_known_key(Platform::Android, &hw_pub, &w.device_sig, &preimage, last)
                .map_err(|_| ReplyRefusal::DeviceSignature)?;
            if w.hw_seq <= last || w.hw_seq > now.saturating_mul(1000).saturating_add(MAX_HW_SEQ_AHEAD_MS) {
                return Err(ReplyRefusal::Counter);
            }
            w.hw_seq
        }
    };
    Ok(HwAccepted { hw_key: r.hw_key, counter })
}

/// Take the reply's counter once σ verified; false when another reply took an equal or higher one first.
pub fn commit_device_reply(storage: &Storage, a: &HwAccepted) -> bool {
    store::take_counter(storage, &a.hw_key, a.counter)
}

/// What the shared verifier reads besides the reply.
pub struct ReplyCtx<'a> {
    pub storage: &'a Storage,
    pub verifier: &'a super::evidence::Verifier,
    pub anchors: &'a AnchorCache,
    /// This node's tip.
    pub tip: u64,
    pub now: u64,
}

impl<'a> ReplyCtx<'a> {
    /// The running node's: its production verifier and anchor cache.
    pub fn production(storage: &'a Storage, tip: u64) -> ReplyCtx<'a> {
        ReplyCtx { storage, verifier: super::evidence::Verifier::production(), anchors: &ANCHORS, tip, now: super::now_secs() }
    }
}

/// The shared verifier of a light node's reply (`SimplifiedP2P::verify_light_ping_signature`): section 5.8
/// in its order, the per-epoch dedupe being the callers' (it runs before this). Structure; the anchor (on
/// relay fitted by `block_height`; a stamp only on ingress, whose caller checked it, and only while
/// legacy replies count); for `ping_hw2:` the device record and signature; σ under the node's ping key and
/// the delegation the chain vouches for; then the device counter is taken.
pub fn verify_reply(ctx: &ReplyCtx<'_>, node: &str, challenge: &str, signature: &str, route: Route) -> Result<(), ReplyRefusal> {
    if node.is_empty() || challenge.is_empty() || signature.is_empty() { return Err(ReplyRefusal::Malformed); }
    if signature.starts_with("compact_bin:") { return Err(ReplyRefusal::CompactBin); }
    let hw = match signature.strip_prefix("ping_dilithium:") {
        Some(_) => None,
        None => Some(messages::parse_hwping_wire(signature).ok_or(ReplyRefusal::Malformed)?),
    };
    let epoch = ctx.tip / EPOCH_BLOCKS;
    let anchor = Anchor::parse(challenge);
    match (&anchor, route) {
        (Some(a), Route::Relay { block_height }) if !relay_height_fits(a, block_height, hw.is_some()) => return Err(ReplyRefusal::Anchor),
        (None, Route::Relay { .. }) => return Err(ReplyRefusal::StampOnRelay),
        (None, Route::Ingress) if hw.is_some() => return Err(ReplyRefusal::Malformed),
        _ => {}
    }
    if let Some(a) = &anchor {
        let storage = ctx.storage;
        if !anchor_current(ctx.anchors, a, ctx.tip, |h| storage.get_microblock_hash_hex(h).ok().flatten()) {
            return Err(ReplyRefusal::Anchor);
        }
    }
    let accepted = match (&hw, &anchor) {
        (Some(w), Some(a)) => Some(check_device_reply(ctx.storage, ctx.verifier, node, a, w, ctx.now)?),
        _ if !legacy_counts(epoch) => return Err(ReplyRefusal::Legacy),
        _ => None,
    };
    let (ping_pk_hex, delegation_cert) = ctx.storage.get_light_ping_keys(node).ok_or(ReplyRefusal::Sigma)?;
    if ping_pk_hex.is_empty() || delegation_cert.is_empty() { return Err(ReplyRefusal::Sigma); }
    // Supers commit the key itself; a light node commits its hash and the key was recorded when the device
    // proved the delegation. Either way the delegation is checked under a key the chain vouches for - an
    // identity with neither is refused. The stored delegation is checked in whichever form the binding was
    // made (a legacy row never holds a v2 cert and a v2 row never a legacy one: the writer refuses both).
    let identity = ctx.storage.resolve_light_identity_pk(node, None).ok_or(ReplyRefusal::Sigma)?;
    if crate::light_binding::verify_delegation(&delegation_cert, &ping_pk_hex, node, &identity).is_none() {
        return Err(ReplyRefusal::Sigma);
    }
    let sigma = sigma_text(signature).ok_or(ReplyRefusal::Malformed)?;
    if !crate::rpc::verify_mobile_dilithium_signature(challenge, &sigma, &ping_pk_hex) { return Err(ReplyRefusal::Sigma); }
    if let Some(a) = accepted {
        if !commit_device_reply(ctx.storage, &a) { return Err(ReplyRefusal::Counter); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_anchor_is_the_exact_self_attestation_of_a_canonical_block_of_the_current_epoch() {
        let hash = "ab".repeat(32);
        let a = Anchor::parse(&format!("selfattest:2241838:{}", hash)).unwrap();
        assert_eq!((a.height, a.epoch()), (2_241_838, 155));
        for bad in [format!("selfattest:02241838:{}", hash), format!("selfattest:2241838:{}", hash.to_uppercase()),
                    format!("selfattest:2241838:{}00", hash), "selfattest:1:2".to_string(), format!("stamp:{}", hash)] {
            assert!(Anchor::parse(&bad).is_none(), "{bad}");
        }
        let cache = AnchorCache::new();
        let canonical = |h: u64| (h == 2_241_838).then(|| "ab".repeat(32));
        let tip = 2_241_838 + 100;
        assert!(anchor_current(&cache, &a, tip, canonical));
        assert!(anchor_current(&cache, &a, tip, |_| None), "remembered once deep enough");
        assert!(!anchor_current(&cache, &a, 2_241_837, canonical), "above the tip");
        assert!(!anchor_current(&cache, &a, 156 * EPOCH_BLOCKS, canonical), "a past epoch's block");
        let other = Anchor { hash: "cd".repeat(32), ..a.clone() };
        assert!(!anchor_current(&cache, &other, tip, canonical), "not the canonical hash");
        // Near the tip a block is checked every time: it may still be replaced.
        let fresh = AnchorCache::new();
        assert!(anchor_current(&fresh, &a, 2_241_838 + 3, canonical));
        assert!(!anchor_current(&fresh, &a, 2_241_838 + 3, |_| None));
    }

    #[test]
    fn a_relay_needs_an_anchor_its_block_height_fits() {
        let c = format!("selfattest:100:{}", "ab".repeat(32));
        let (hw, legacy) = ("ping_hw2:00.AA.0", "ping_dilithium:00");
        assert_eq!(relay_anchor(&c, hw, 100).map(|a| a.height), Ok(100));
        assert_eq!(relay_anchor(&c, hw, 101), Err(ReplyRefusal::Anchor), "a device reply: a tampered or tip height");
        // A legacy reply relayed by a genesis of the previous binary carries its tip: any later height of the
        // anchor's epoch, never an earlier one or another epoch's.
        assert_eq!(relay_anchor(&c, legacy, 100).map(|a| a.height), Ok(100));
        assert_eq!(relay_anchor(&c, legacy, EPOCH_BLOCKS - 1).map(|a| a.height), Ok(100));
        assert_eq!(relay_anchor(&c, legacy, 99), Err(ReplyRefusal::Anchor));
        assert_eq!(relay_anchor(&c, legacy, EPOCH_BLOCKS), Err(ReplyRefusal::Anchor), "the next epoch");
        assert_eq!(relay_anchor(&"00".repeat(40), legacy, 100), Err(ReplyRefusal::StampOnRelay), "a server stamp");
        assert!(legacy_counts(155) && legacy_counts(u64::MAX - 1), "legacy replies count in this roll");
        // A record missing or behind the relaying genesis's is pulled; the reply's own faults are not healed.
        for r in [ReplyRefusal::NoRecord, ReplyRefusal::NotCounted, ReplyRefusal::DeviceSignature] {
            assert!(heals_by_record_pull(r), "{r:?}");
        }
        for r in [ReplyRefusal::Malformed, ReplyRefusal::Anchor, ReplyRefusal::StampOnRelay, ReplyRefusal::Legacy,
                  ReplyRefusal::CompactBin, ReplyRefusal::Counter, ReplyRefusal::Sigma] {
            assert!(!heals_by_record_pull(r), "{r:?}");
        }
        let sigma = "11".repeat(3309);
        assert_eq!(sigma_text(&format!("ping_dilithium:{}", "ab")).as_deref(), Some("ab"));
        assert_eq!(sigma_text(&format!("ping_hw2:{}.AQID.7", sigma)).as_deref(), Some(sigma.as_str()));
        assert!(sigma_text("compact_bin:xyz").is_none());
    }

    /// An owner behind the relaying genesis holds the reply until its tip reaches the anchor, as the previous
    /// binary (which read no anchor on relay) credited it: in the tip's epoch or the next, never an earlier one.
    #[test]
    fn a_relay_anchored_above_the_tip_waits_for_it() {
        let a = Anchor { height: 155 * EPOCH_BLOCKS + 50, hash: "ab".repeat(32) };
        let canonical = |h: u64| (h == 155 * EPOCH_BLOCKS + 50).then(|| "ab".repeat(32));
        let cache = AnchorCache::new();
        assert_eq!(relay_anchor_state(&cache, &a, a.height + 10, canonical), RelayAnchor::Current);
        assert_eq!(relay_anchor_state(&cache, &a, a.height - 3, canonical), RelayAnchor::AboveTip, "three blocks behind");
        assert_eq!(relay_anchor_state(&cache, &a, 155 * EPOCH_BLOCKS - 2, canonical), RelayAnchor::AboveTip, "behind across the boundary");
        assert_eq!(relay_anchor_state(&cache, &a, 153 * EPOCH_BLOCKS + 10, canonical), RelayAnchor::Refused, "two epochs ahead");
        assert_eq!(relay_anchor_state(&cache, &a, 156 * EPOCH_BLOCKS, canonical), RelayAnchor::Refused, "the epoch moved on");
        let other = Anchor { hash: "cd".repeat(32), ..a.clone() };
        assert_eq!(relay_anchor_state(&cache, &other, a.height + 10, canonical), RelayAnchor::Refused);
        // Across the boundary the node was credited here in the tip's epoch, so the local-epoch echo dedupe
        // must let the next epoch's reply through to the hold; in the tip's own epoch it still dedupes.
        assert!(!relay_echo_dedupe_applies(&Ok(a.clone()), 155 * EPOCH_BLOCKS - 2), "anchor in the next epoch");
        assert!(relay_echo_dedupe_applies(&Ok(a.clone()), a.height - 3), "anchor above the tip, same epoch");
        assert!(relay_echo_dedupe_applies(&Ok(a.clone()), a.height + 10));
        assert!(relay_echo_dedupe_applies(&Err(ReplyRefusal::StampOnRelay), 155 * EPOCH_BLOCKS - 2));

        let mut held: HeldRelays<u32> = HeldRelays::new();
        assert!(held.hold("n1", "genesis_node_002", true, false, 100, 1_000, 1, 1));
        assert!(!held.hold("n1", "genesis_node_002", true, false, 100, 1_000, 1, 9), "an echo of a held reply");
        assert!(held.hold("n1", "genesis_node_003", true, false, 100, 1_000, 1, 2), "another pinger's relay of it");
        assert!(held.hold("n2", "genesis_node_002", true, false, 105, 1_010, 1, 3));
        assert_eq!(held.take_due(99, 1_030), (vec![], 0));
        let (mut due, dropped) = held.take_due(100, 1_030);
        due.sort();
        assert_eq!((due, dropped, held.len()), (vec![1, 2], 0, 1), "the tip reached the anchor");
        assert_eq!(held.take_due(104, 1_010 + RELAY_HOLD_SECS), (vec![], 1), "held too long");
        assert!(held.is_empty());
        // One pinger holds at most a quarter, non-genesis pingers together at most half.
        for i in 0..RELAY_HOLD_MAX / 4 {
            assert!(held.hold(&format!("n{i}"), "super_a", false, false, 100, 1_000, 1, 0));
        }
        assert!(!held.hold("x", "super_a", false, false, 100, 1_000, 1, 0));
        for i in 0..RELAY_HOLD_MAX / 4 {
            assert!(held.hold(&format!("n{i}"), "super_b", false, false, 100, 1_000, 1, 0));
        }
        assert!(!held.hold("x", "super_c", false, false, 100, 1_000, 1, 0), "non-genesis relays hold half");
        assert!(held.hold("x", "genesis_node_001", true, false, 100, 1_000, 1, 0), "a genesis relay still finds room");
        assert_eq!(held.take_due(100, 1_000).0.len(), RELAY_HOLD_MAX / 2 + 1);
        assert!(held.hold("x", "super_c", false, false, 100, 1_000, 1, 0), "room again once taken");
    }

    /// ND-1: a registered light node signs no consensus key, and an unbound id was verified trust-on-first-
    /// sight, so anyone could sign relays as any light node. A non-genesis pinger needs its committed key bound.
    #[test]
    fn a_relay_pinger_signs_under_its_committed_consensus_key() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::PublicKey as _;
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (light, sup) = ("light_nd1_relay_pinger", "super_nd1_relay_pinger");
        storage.save_node_registration_at_height_burn_vrf(light, "light", "walletL", 1.0, 1, "", None).unwrap();
        assert!(!relay_pinger_admissible(&storage, light), "a light node has no consensus key");
        assert!(!relay_pinger_admissible(&storage, "super_nd1_unregistered"));
        let (pk, _) = d3::keypair();
        storage.save_vrf_public_key(sup, &hex::encode(pk.as_bytes())).unwrap();
        storage.save_node_registration_at_height_burn_vrf(sup, "super", "walletS", 1.0, 1, "", Some(pk.as_bytes())).unwrap();
        assert!(!relay_pinger_admissible(&storage, sup), "committed but not bound: its signature would be first-sight");
        assert!(qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(sup, pk.as_bytes()));
        assert!(relay_pinger_admissible(&storage, sup));
    }

    /// ND-1: a relay's reply is held only when bounded and in a creditable form, the held set is bounded in
    /// bytes as well as count, and the copy the pinger sent itself replaces one a peer forwarded first.
    #[test]
    fn a_held_relay_is_bounded_in_size_and_the_pingers_own_copy_wins() {
        let anchor = format!("selfattest:100:{}", "ab".repeat(32));
        let hw = format!("ping_hw2:{}.{}.{}", "0a".repeat(3309), "AAAA", 5);
        assert!(relay_fields_well_formed("light_n1", &anchor, &hw, "compact_bin:x"));
        assert!(relay_fields_well_formed("light_n1", &anchor, "ping_dilithium:dilithium_sig_x_AAAA", "sig"));
        let padded = format!("ping_dilithium:{}", "A".repeat(10 * 1024 * 1024));
        assert!(!relay_fields_well_formed("light_n1", &anchor, &padded, "sig"), "a 10 MB reply is dropped at once");
        assert!(!relay_fields_well_formed("light_n1", &anchor, "junk", "sig"), "no creditable form");
        assert!(!relay_fields_well_formed("light_n1", &anchor, "compact_bin:x", "sig"), "the heartbeat form is no light reply");
        assert!(!relay_fields_well_formed("light_n1", &anchor, &hw, &"s".repeat(RELAY_FIELD_MAX + 1)));
        assert!(!relay_fields_well_formed("light_n1", &"s".repeat(RELAY_CHALLENGE_MAX + 1), &hw, "sig"));
        assert!(!relay_fields_well_formed("light_n1", "", &hw, "sig"));

        let mut held: HeldRelays<u32> = HeldRelays::new();
        let big = RELAY_HOLD_BYTES_MAX / 2;
        assert!(held.hold("n1", "genesis_node_002", true, false, 100, 1_000, big, 1));
        assert!(held.hold("n2", "genesis_node_002", true, false, 100, 1_000, big, 2));
        assert!(!held.hold("n3", "genesis_node_003", true, false, 100, 1_000, 1, 3), "the byte budget is spent");
        assert_eq!(held.bytes(), RELAY_HOLD_BYTES_MAX);
        // A forwarded copy of n1 is held; the pinger's own copy replaces it, and nothing replaces that.
        assert!(!held.hold("n1", "genesis_node_002", true, false, 100, 1_000, big, 7), "a second forwarded copy");
        assert!(held.hold("n1", "genesis_node_002", true, true, 100, 1_000, big, 8), "the pinger's own copy");
        assert!(!held.hold("n1", "genesis_node_002", true, true, 100, 1_000, big, 9));
        let (mut due, _) = held.take_due(100, 1_001);
        due.sort();
        assert_eq!(due, vec![2, 8]);
        assert_eq!(held.bytes(), 0);
    }
}

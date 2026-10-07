//! `GET` and `POST /api/v1/light-node/status`: status v2 (U9) with the counted epochs of the uptime
//! index (U10). One view of a light node, computed one way whatever this genesis holds in RAM: from
//! the chain row, the binding row, the committed recency and uptime indices, the current epoch's
//! attestations and the pool.
//!
//! The public form is the minimum a page without keys needs (owner decision AF20), plus the burn of the
//! registration (owner decision (c)) and the public view of the device that runs the node (04.10): its
//! platform and (06.10) model, the day it was linked, the epoch of its last answer and its state, and (05.10)
//! the epoch and reason of its last miss and whether that push reached the phone. The signed form, by the node's
//! ping key or its wallet key, adds the binding's exact sequence, the registration record, the device record's state,
//! lease window, rotation and pause (A13), whether the app should register its push token again, and the device's
//! timeline (H-1): the time of its last counted answer, the times and the app's outcome of its last miss, and its last
//! answer. Reads only; RPC policy, no block rule reads any of it.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` sections 4 and 7.

use super::*;
use crate::light_binding::{self as lb, BindingRow, Refusal};
use crate::storage::{LightUptime, LIGHT_UPTIME_WINDOW};

const EPOCH_BLOCKS: u64 = 14_400;
/// One epoch in seconds, at one block a second: how long a device linked just now may take to give its first
/// answer before the public status calls it offline.
const LINK_GRACE_SECS: u64 = EPOCH_BLOCKS;
/// A registration's first three epochs (12 h at one block a second) read active before the first
/// answer, but only while a device is linked: with none, nothing can answer.
pub(crate) const FRESH_GRACE_BLOCKS: u64 = 3 * EPOCH_BLOCKS;

/// `counted` of the status. Of the epochs since the node's registration that this genesis indexed,
/// at most the last 64, how many the node was counted in; and the last epoch it was counted in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Counted {
    pub(crate) epochs_since_registration: u64,
    pub(crate) counted: u64,
    pub(crate) last_counted_epoch: Option<u64>,
}

/// The device layer's part of the status (light-node-messages sections 5.9 and 7, A13). All empty for a
/// node with no device record here (an installed app's, or one this genesis never recorded).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DeviceStatus {
    /// The bound device's `device_tag`; the public form shows it only hashed with the caller's nonce.
    pub(crate) device_tag: Option<[u8; 32]>,
    pub(crate) device_state: Option<&'static str>,
    pub(crate) effective_epoch: Option<u64>,
    /// Unix seconds, jittered.
    pub(crate) refresh_window: Option<(u64, u64)>,
    pub(crate) rotation_due: Option<u64>,
    pub(crate) paused_until: Option<u64>,
    pub(crate) reset_ref: Option<String>,
}

/// The device record's part of the status, read as every other reader reads it (`state_now`: the chain,
/// the clock, this genesis's revocation snapshot and oracle outage). The tag names the key the record holds
/// now (after a rotation the new one, which is how the app settles an unanswered rotation). A record its
/// binding released (Stop, or a later binding) or that ended says `ended` and names no device; a timed
/// pause it kept is still reported, since a new enrolment of the node waits for it.
pub(crate) fn device_status_of(r: &crate::light_device::record::DeviceRecord, released: bool, registered: bool,
                               epoch: u64, now: u64, local: crate::light_device::record::Local) -> DeviceStatus {
    use crate::light_device::DeviceState;
    let state = if released { DeviceState::Ended } else { r.state_with(registered, epoch, now, local) };
    let pause_until = r.pause_until(epoch);
    if state == DeviceState::Ended {
        return DeviceStatus {
            device_state: Some(state.as_str()),
            paused_until: (pause_until > 0).then_some(pause_until),
            reset_ref: r.reference(),
            ..DeviceStatus::default()
        };
    }
    DeviceStatus {
        device_tag: r.device_tag_bytes(),
        device_state: Some(state.as_str()),
        effective_epoch: Some(r.effective_epoch),
        refresh_window: r.refresh_window(registered, epoch, now, local),
        rotation_due: Some(r.rotation_due_epoch),
        paused_until: if state == DeviceState::Paused { r.pause_refusal().paused_until } else { None },
        reset_ref: r.reference(),
    }
}

fn device_status(storage: &crate::storage::Storage, record: Option<&crate::light_device::record::DeviceRecord>,
                 registered: bool) -> DeviceStatus {
    let Some(r) = record else { return DeviceStatus::default(); };
    let released = crate::light_device::attest::binding_released(storage, r);
    let local = crate::light_device::record::Local::of(r);
    device_status_of(r, released, registered, crate::light_device::current_epoch(), crate::light_device::now_secs(), local)
}

/// The status's `device`: the device that runs the node. `null` in the answer while the node is not on chain. The
/// public form shows its coarse part (`public_json`): which kind of device, since which day, the epoch of its last
/// answer, its state and its last miss as an epoch and a reason. The times and what the app did are the signed
/// form's alone (`signed_json`), as they tell when the owner's phone and app were in use (H-1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceView {
    /// "android", "ios" or "unknown"; None while no device is bound.
    pub(crate) platform: Option<&'static str>,
    /// The model its bind named (`light_binding::model_hint`); None while no device is bound and when not known.
    pub(crate) model: Option<String>,
    /// The UTC day (Unix seconds at 00:00) of the binding's sequence; None while no device is bound and for a
    /// legacy binding. The sequence is the device's own time when it bound, alike at every genesis.
    pub(crate) linked_since: Option<u64>,
    /// The epoch the node last answered in: this one when it answered in it, else the last epoch it was counted
    /// in.
    pub(crate) last_answer_epoch: Option<u64>,
    /// Unix seconds of the answer that counted the node in its latest counted epoch, from this genesis's rows for
    /// the current epoch and the two before (`last_counted_answer_at`); None when it holds none.
    pub(crate) last_answer_at: Option<u64>,
    /// "online", "offline", "unlinked" or "other_device_pending".
    pub(crate) state: &'static str,
    /// The latest epoch the node was not counted in, as this genesis saw it (`shown_miss`); None while no device is
    /// bound, and where this genesis recorded none.
    pub(crate) last_miss: Option<LightMiss>,
    /// The node's last answer that counted, as this genesis took it; None while no device is bound.
    pub(crate) last_answer: Option<LastAnswer>,
}

impl DeviceView {
    /// What anyone may read: no time of an answer, a wake or a delivery, and nothing of what the app did.
    pub(crate) fn public_json(&self) -> Value {
        json!({
            "platform": self.platform,
            "model": self.model,
            "linked_since": self.linked_since,
            "last_answer_epoch": self.last_answer_epoch,
            "state": self.state,
            "last_miss": self.last_miss.as_ref().map(LightMiss::public_json),
        })
    }

    /// What the node's own keys may read: the public fields, the time of the last counted answer, the miss in full
    /// and the last answer.
    pub(crate) fn signed_json(&self) -> Value {
        let mut v = self.public_json();
        v["last_answer_at"] = json!(self.last_answer_at);
        v["last_miss"] = self.last_miss.as_ref().map_or(Value::Null, LightMiss::to_json);
        v["last_answer"] = self.last_answer.as_ref().map_or(Value::Null, LastAnswer::to_json);
        v
    }
}

/// The device view from the vouched binding and the final liveness. `other_device_pending`: nothing counted the
/// node in this epoch or the last two, and the device linked less than an epoch ago has not answered yet.
/// `platform` and `model` are the bound device's (`device_hints`).
pub(crate) fn device_view(onchain: bool, binding: Option<&BindingRow>, needs_reactivation: bool, platform: &'static str,
                          model: &str, last_answer_epoch: Option<u64>, now: u64) -> Option<DeviceView> {
    if !onchain { return None; }
    let bound = binding.filter(|b| b.device_bound());
    let state = match bound {
        None => "unlinked",
        Some(_) if !needs_reactivation => "online",
        Some(b) if b.v2 && b.seq > 0 && now < b.seq.saturating_add(LINK_GRACE_SECS) => "other_device_pending",
        Some(_) => "offline",
    };
    Some(DeviceView {
        platform: bound.map(|_| if platform.is_empty() { "unknown" } else { platform }),
        model: bound.and_then(|_| (!model.is_empty()).then(|| model.to_string())),
        linked_since: bound.filter(|b| b.seq > 0).map(|b| b.seq - b.seq % 86_400),
        last_answer_epoch,
        last_answer_at: None,
        state,
        last_miss: None,
        last_answer: None,
    })
}

/// The last finished epoch's candidate miss by the dormant rule (`not_woken_inactive`), read from the committed index
/// as every genesis holds it: the node was past its first WAKE_GRACE_EPOCHS epochs for the whole of it (registered
/// before the epoch WAKE_GRACE_EPOCHS + 1 earlier) and was counted in none of it and the two before, all three
/// indexed here with a row of its shard (`done`). The status then holds it to the rule itself (`proven_dormant`).
/// Derived when read, so a node the network stopped waking costs no write an epoch.
pub(crate) fn dormant_miss(reg_height: Option<u64>, cur_height: u64, row: Option<LightUptime>, done: u64) -> Option<LightMiss> {
    let end = last_finished_epoch(cur_height)?;
    let reg_epoch = reg_height? / EPOCH_BLOCKS;
    let window = (1u64 << WAKE_GRACE_EPOCHS) - 1;
    let dormant = reg_epoch + WAKE_GRACE_EPOCHS < end
        && done & window == window
        && row.map_or(0, |r| r.aligned_to(end)) & window == 0;
    dormant.then(|| LightMiss {
        epoch: end,
        reason: MissReason::NotWokenInactive,
        woken_at: None,
        answered_at: None,
        delivery_delay_secs: None,
        refused: None,
        recorded_at: 0,
        delivered_at: None,
        app_outcome: None,
        by_push: false,
    })
}

/// The last finished epoch's miss the network caused (`not_committed`, F8): the node was in its roster, this genesis
/// indexed the epoch (`done`, bit k = epoch `end - k`), and the node's shard committed no row in it (`committed`, the
/// same bits). Nobody of the shard could be counted, so the epoch is never the device's.
pub(crate) fn not_committed_miss(reg_height: Option<u64>, cur_height: u64, done: u64, committed: u64) -> Option<LightMiss> {
    let end = last_finished_epoch(cur_height)?;
    let failed = first_counted_epoch(reg_height?) <= end && done & 1 == 1 && committed & 1 == 0;
    failed.then(|| LightMiss {
        epoch: end,
        reason: MissReason::NotCommitted,
        woken_at: None,
        answered_at: None,
        delivery_delay_secs: None,
        refused: None,
        recorded_at: 0,
        delivered_at: None,
        app_outcome: None,
        by_push: false,
    })
}

/// Either of the two finished epochs the recency verdict reads (`light_elig_shards` of each, None when not derived
/// here) says nothing of the device in `shard`: not derived, or the shard committed no row (F8). Its absence from
/// the committed index is then the network's, and the node is not called in need of reactivation for it.
pub(crate) fn recent_neutral(elig_shards: [Option<u8>; 2], shard: usize) -> bool {
    elig_shards.iter().any(|m| m.map_or(true, |m| shard >= 8 || m & (1u8 << shard) == 0))
}

/// The device view's `last_miss`: of the record this genesis holds since the binding it holds (`LightPushRow::since`)
/// and the derived one (`dormant_miss` proven by the dormant rule, or `not_committed_miss`), the later epoch, at one
/// epoch the one that tells more.
pub(crate) fn shown_miss(stored: Option<LightMiss>, dormant: Option<LightMiss>) -> Option<LightMiss> {
    match (stored, dormant) {
        (Some(s), Some(d)) => Some(LightMiss::merge(Some(s), d)),
        (s, d) => s.or(d),
    }
}

/// The time of the answer that counted `node_id` in its latest counted epoch: the newest of this genesis's rows
/// for the current epoch and the two before. Only a shard owner holds them; elsewhere None. The stamp is the
/// pinger's, so every owner that took the same answer reports the same time.
pub(crate) fn last_counted_answer_at(storage: &crate::storage::Storage, node_id: &str, cur_height: u64) -> Option<u64> {
    let cur = cur_height / EPOCH_BLOCKS;
    (0..3u64).filter_map(|k| cur.checked_sub(k)).find_map(|e| storage.light_counted_answer_at(node_id, e))
}

/// The bound device's platform, a display hint: the device record's when a record holds this very binding (it
/// is the platform the device proved), else the hint its bind named, kept with the push record of the same
/// binding, else "" (`unknown`). A genesis that took the binding only by gossip or the identity pull, before the
/// token sync reached it, knows none.
#[cfg(test)]
fn device_platform(storage: &crate::storage::Storage, node_id: &str, binding: &BindingRow,
                   record: Option<&crate::light_device::record::DeviceRecord>) -> &'static str {
    device_hints(storage, node_id, binding, record).0
}

/// The bound device's platform (as `device_platform` says it) and model, both display hints. The model is the one
/// the bind named, kept with the push record of the same binding, else "": also when the bind named a platform
/// other than the one the device record of this binding proved, since then neither hint describes that device.
fn device_hints(storage: &crate::storage::Storage, node_id: &str, binding: &BindingRow,
                record: Option<&crate::light_device::record::DeviceRecord>) -> (&'static str, String) {
    if !(binding.v2 && binding.seq > 0 && binding.device_bound()) { return ("", String::new()); }
    let entry = storage.get_fcm_entry(node_id).filter(|e| e.seq == binding.seq);
    let named = entry.as_ref().map_or("", |e| lb::platform_hint(Some(e.platform.as_str())));
    let model = entry.as_ref().map_or("", |e| lb::model_hint(Some(e.model.as_str()))).to_string();
    match record.filter(|r| r.seq == binding.seq).map(|r| r.platform.as_str()) {
        Some(proven) if !named.is_empty() && named != proven => (proven, String::new()),
        Some(proven) => (proven, model),
        None => (named, model),
    }
}

/// One light node as the status reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LightStatus {
    pub(crate) node_id: String,
    /// This genesis knows the node at all (chain row or RAM registry): the legacy `success`.
    pub(crate) known: bool,
    pub(crate) onchain: bool,
    pub(crate) registered_height: Option<u64>,
    pub(crate) burn_tx: Option<String>,
    pub(crate) registration_pending: bool,
    pub(crate) binding: Option<BindingRow>,
    pub(crate) answered_this_epoch: bool,
    pub(crate) needs_reactivation: bool,
    pub(crate) is_active: bool,
    pub(crate) counted: Counted,
    /// (next_ping_time, next_ping_window), the legacy polling hint.
    pub(crate) next_ping: (u64, u64),
    pub(crate) device: DeviceStatus,
    /// The `device` (None while the node is not on chain): coarse in the public form, whole in the signed one.
    pub(crate) device_view: Option<DeviceView>,
    /// The forms this node serves (`light_binding::light_node_features`).
    pub(crate) features: Vec<&'static str>,
    /// This node is at the network's height, so its "not registered" can be relied on (`absence_vouch`,
    /// as verify-activation computes it).
    pub(crate) authoritative: bool,
    /// This genesis cannot push the bound device (`push_reregister`): the signed form asks the app to register
    /// its push token again.
    pub(crate) push_reregister: bool,
}

impl LightStatus {
    pub(crate) fn device_bound(&self) -> bool {
        self.binding.as_ref().map_or(false, |b| b.device_bound())
    }
}

/// `(needs_reactivation, is_active)`. A node needs reactivation when it is on chain and neither the
/// committed index (last two epochs) nor this epoch's attestations nor the shard owner count it, past
/// its first epochs. It is active when one of those counts it, or in its first epochs with a device
/// linked: before that grace made a node with no device read active for up to 12 h.
pub(crate) fn liveness(onchain: bool, attested_recent: bool, answered: bool, fresh: bool, device_bound: bool,
                       owner_active: bool) -> (bool, bool) {
    let counted = attested_recent || answered || owner_active;
    let needs_reactivation = onchain && !counted && !fresh;
    let is_active = onchain && (counted || (fresh && device_bound));
    (needs_reactivation, is_active)
}

/// The first epoch a registration at `reg_height` can be counted in: its own epoch when it applied
/// before that epoch's light roster froze, else the next (`light_roster_cutoff`, the reward reader's
/// rule).
fn first_counted_epoch(reg_height: u64) -> u64 {
    let e = reg_height / EPOCH_BLOCKS;
    if reg_height < crate::node::light_roster_cutoff(e) { e } else { e + 1 }
}

/// The last finished epoch at `cur_height`, the one the latest epoch pass indexes.
fn last_finished_epoch(cur_height: u64) -> Option<u64> {
    (cur_height / EPOCH_BLOCKS).checked_sub(1)
}

/// `counted` from the uptime row and the epochs this genesis indexed (`done`: bit k = epoch `end - k`,
/// `end` the last finished epoch). Only indexed epochs are in the count on either side, so a genesis
/// that joined late or missed a pass never reports an epoch as missed that it never looked at.
pub(crate) fn counted_view(reg_height: Option<u64>, cur_height: u64, row: Option<LightUptime>, done: u64) -> Counted {
    let (Some(reg_height), Some(end)) = (reg_height, last_finished_epoch(cur_height)) else {
        return Counted::default();
    };
    let last_counted_epoch = row.and_then(|r| r.last_counted_at_or_before(end));
    let first = first_counted_epoch(reg_height);
    if first > end {
        return Counted { last_counted_epoch, ..Counted::default() };
    }
    let span = (end - first + 1).min(LIGHT_UPTIME_WINDOW);
    let window = if span >= 64 { u64::MAX } else { (1u64 << span) - 1 };
    let indexed = done & window;
    let hits = row.map_or(0, |r| r.aligned_to(end)) & indexed;
    Counted {
        epochs_since_registration: indexed.count_ones() as u64,
        counted: hits.count_ones() as u64,
        last_counted_epoch,
    }
}

/// Everything the status reports about `node_id`. `ask_owner` lets a genesis that does not count the
/// node consult its shard owner (never on a call that is itself that consultation).
pub(crate) async fn light_status(blockchain: &BlockchainNode, node_id: &str, ask_owner: bool) -> LightStatus {
    let storage = blockchain.get_storage();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    // On-chain = the registration row is applied: node-independent and durable, unlike RAM presence,
    // which gossip lags. The client gates its self-attest on it.
    let (registered_height, burn) = storage.node_registration_record(node_id);
    let onchain = registered_height.is_some();
    let cur_height = storage.get_chain_height().unwrap_or(0);
    let p2p = blockchain.get_unified_p2p();
    let known = onchain || p2p.as_ref().map_or(false, |p| p.get_light_node(node_id).is_some());
    // A bound row counts only under the chain's commitment, as the pusher and a wake judge it: a legacy
    // row written under another wallet key before the registration applied is no device of this node.
    let binding = storage.get_light_binding(node_id)
        .filter(|b| !b.device_bound() || crate::rpc::binding_vouched(&storage, node_id, b));
    let device_bound = binding.as_ref().map_or(false, |b| b.device_bound());
    // This epoch's attestations converge across the genesis by gossip; the committed index covers the
    // last two finished epochs. Both are node-independent, so any genesis gives the same answer.
    let mut answered = p2p.as_ref().map_or(false, |p| p.has_attestation_in_window(node_id));
    let attested_recent = onchain && storage.light_attested_recent_onchain(node_id, cur_height);
    let fresh = registered_height.map_or(false, |h| cur_height.saturating_sub(h) < FRESH_GRACE_BLOCKS);
    let (mut needs_reactivation, mut is_active) = liveness(onchain, attested_recent, answered, fresh, device_bound, false);
    // This epoch's view is shard-owner RAM: before calling an on-chain node inactive, ask every other owner (F13),
    // so every genesis returns one verdict whichever owner took the answer.
    if onchain && !is_active && ask_owner {
        if let Some(v) = super::light_nodes::shard_owners_view(node_id).await {
            answered |= v.answered;
            if v.active || v.answered {
                (needs_reactivation, is_active) = liveness(onchain, attested_recent, answered, fresh, device_bound, true);
            }
        }
    }
    // F8: an epoch of the two the verdict reads that this genesis did not derive, or in which the node's shard
    // committed no row, says nothing of the device.
    let shard = crate::node::light_shard_of(node_id);
    let e = cur_height / EPOCH_BLOCKS;
    let recent_shards = [e.checked_sub(1).and_then(|x| storage.light_elig_shards(x)),
                         e.checked_sub(2).and_then(|x| storage.light_elig_shards(x))];
    if needs_reactivation && recent_neutral(recent_shards, shard) {
        needs_reactivation = false;
    }
    // A registration the pool holds or a submit collecting attestations here: the cabinet offers no
    // second burn meanwhile.
    let registration_pending = !onchain
        && (pending_registration_tx(node_id).is_some() || submit_in_flight(node_id, now));
    // Only the epochs this genesis indexed in which the node's shard committed a row count (F8).
    let (uptime, done_raw, committed) = match (onchain, last_finished_epoch(cur_height)) {
        (true, Some(end)) => {
            let (d, c) = storage.light_uptime_done_masks(end, shard);
            (storage.light_uptime(node_id), d, c)
        }
        _ => (None, 0, 0),
    };
    let done = done_raw & committed;
    let counted = match (onchain, last_finished_epoch(cur_height)) {
        (true, Some(_)) => counted_view(registered_height, cur_height, uptime, done),
        _ => Counted::default(),
    };
    let record = storage.device_record(node_id);
    let (platform, model) = match (&binding, onchain) {
        (Some(b), true) => device_hints(&storage, node_id, b, record.as_ref()),
        _ => ("", String::new()),
    };
    // This epoch on the clock `has_attestation_in_window` reads, else the last epoch the node was counted in.
    let last_answer = if answered { Some(crate::unified_p2p::SimplifiedP2P::get_current_window_number()) }
                      else { counted.last_counted_epoch };
    let mut device_view = device_view(onchain, binding.as_ref(), needs_reactivation, platform, &model, last_answer, now);
    if let Some(d) = device_view.as_mut() { d.last_answer_at = last_counted_answer_at(&storage, node_id, cur_height); }
    // Why the node was last not counted and its last answer, while a device is bound: only what came after the
    // binding held here, so never the device it replaced.
    let bound_at = binding.as_ref().filter(|b| b.device_bound()).map(|b| b.bound_at);
    if let (Some(d), Some(bound_at)) = (device_view.as_mut(), bound_at) {
        let row = stored_row(&storage, node_id).unwrap_or_default().since(bound_at);
        // The dormant rule's miss only where it holds as the pusher applies it: two proven device misses before the
        // epoch (`proven_dormant`, an owner's reach records); a genesis that cannot prove them shows none.
        let dormant = dormant_miss(registered_height, cur_height, uptime, done)
            .filter(|m| proven_dormant(&storage, &REACH_CACHE, &DormantFacts::read(&storage, m.epoch), node_id, shard, m.epoch));
        d.last_miss = shown_miss(row.miss, dormant.or_else(|| not_committed_miss(registered_height, cur_height, done_raw, committed)));
        d.last_answer = row.answer;
    }
    let push_reregister = onchain && device_bound && push_reregister(&storage, node_id, cur_height / EPOCH_BLOCKS);
    LightStatus {
        node_id: node_id.to_string(),
        known,
        onchain,
        registered_height,
        burn_tx: if onchain { burn } else { None },
        registration_pending,
        binding,
        answered_this_epoch: answered,
        needs_reactivation,
        is_active,
        counted,
        next_ping: crate::unified_p2p::SimplifiedP2P::get_next_ping_time(node_id),
        device: device_status(&storage, record.as_ref(), onchain),
        device_view,
        features: lb::light_node_features(),
        authoritative: super::absence_vouch(blockchain).await.2,
        push_reregister,
    }
}

/// The public form: the minimum a page without keys needs, plus the names installed apps read, which
/// state nothing beyond it. No exact sequence or binding time, no push channel, no device record. The one piece
/// of the registration record it names is `burn_tx`, public on Solana and in the chain's registration row
/// already (owner decision (c)): a cabinet with no keys recovers a phone-only user's code from it. `device`
/// (04.10) says which kind of device runs the node and (06.10) its model, since which day, its last answer's epoch
/// and its state, so every screen can tell "offline" from "unlinked" from "linked to another device just now", and
/// its last miss as an epoch, a reason and whether the push reached the phone (`DeviceView::public_json`).
pub(crate) fn public_json(s: &LightStatus, nonce: Option<&[u8; 16]>) -> Value {
    let device_bound = s.device_bound();
    let mut v = json!({
        "success": s.known,
        "node_id": s.node_id,
        "onchain_registered": s.onchain,
        "registration_pending": s.registration_pending,
        "device_bound": device_bound,
        "answered_this_epoch": s.answered_this_epoch,
        "needs_reactivation": s.needs_reactivation,
        "is_active": s.is_active,
        "counted": {
            "epochs_since_registration": s.counted.epochs_since_registration,
            "counted": s.counted.counted,
            "last_counted_epoch": s.counted.last_counted_epoch,
        },
        "burn_tx": s.burn_tx,
        "device": s.device_view.as_ref().map(DeviceView::public_json),
        "features": s.features,
        "authoritative": s.authoritative,

        // Read by installed apps (1.2 and earlier) under these names.
        "has_attestation_current_slot": s.answered_this_epoch,
        "next_ping_time": s.next_ping.0,
        "next_ping_window": s.next_ping.1,
    });
    if !s.known {
        v["error"] = json!("Node not found");
    }
    let _ = nonce;
    v
}

/// The signed form: the public fields and what only the node's own keys may read. `device_tag_h` is here
/// only: an install keeps its device tag across a rebind or a wallet switch, so answered to anyone for a nonce
/// the caller picks, it linked two wallets to one phone (ND-7). `device` is whole here: the time of the last
/// counted answer, the last miss with its times and what the app did, and the last answer (H-1).
pub(crate) fn signed_json(s: &LightStatus, nonce: Option<&[u8; 16]>) -> Value {
    let mut v = public_json(s, nonce);
    v["device"] = s.device_view.as_ref().map_or(Value::Null, DeviceView::signed_json);
    if let (Some(nonce), Some(tag), true) = (nonce, s.device.device_tag.as_ref(), s.device_bound()) {
        v["device_tag_h"] = json!(lb::device_tag_h(nonce, tag));
    }
    let bound = s.binding.as_ref().filter(|b| b.device_bound());
    // The sequence a new binding must beat (`seq = max(now, binding_seq + 1)`); 0 exactly while the
    // node was never bound under v2, which is when a pre-signed first binding is still taken (U3).
    v["binding_seq"] = json!(s.binding.as_ref().map_or(0, |b| b.bar()));
    v["bound_at"] = json!(bound.map(|b| b.bound_at).filter(|t| *t > 0));
    v["registered_height"] = json!(s.registered_height);
    v["burn_tx"] = json!(s.burn_tx);
    let d = &s.device;
    v["device_state"] = json!(d.device_state);
    v["effective_epoch"] = json!(d.effective_epoch);
    v["refresh_window"] = d.refresh_window.map_or(Value::Null, |(from, to)| json!({"from": from, "to": to}));
    v["rotation_due"] = json!(d.rotation_due);
    v["paused_until"] = json!(d.paused_until);
    v["ref"] = json!(d.reset_ref);
    // Signed only: whether this genesis can push the device says how the device is reached.
    v["push_reregister"] = json!(s.push_reregister);
    v
}

/// The status query's nonce: exactly 32 lowercase hex (16 bytes). Anything else is no nonce.
fn parse_nonce(s: Option<&str>) -> Option<[u8; 16]> {
    let s = s?;
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return None; }
    hex::decode(s).ok()?.try_into().ok()
}

/// `GET /api/v1/light-node/status?node_id=&nonce=`: the public form.
pub(super) async fn handle_light_node_status(
    params: HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let node_id = match params.get("node_id") {
        Some(id) if !id.is_empty() && id.len() <= 128 => id.clone(),
        _ => return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id parameter required"
        }))),
    };
    // `fwd=1` marks the shard-owner consultation of another genesis: answered from this view alone.
    let s = light_status(&blockchain, &node_id, !params.contains_key("fwd")).await;
    let nonce = parse_nonce(params.get("nonce").map(|n| n.as_str()));
    Ok(warp::reply::json(&public_json(&s, nonce.as_ref())))
}

#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct SignedStatusRequest {
    #[serde(default)] pub(super) node_id: String,
    #[serde(default)] pub(super) ts: u64,
    /// "ping" (the node's stored ping key) or "wallet" (the wallet key K).
    #[serde(default)] pub(super) signer: String,
    /// ML-DSA-65 signature over `{chain_tag}light_status:{N}:{ts}`, hex.
    #[serde(default)] pub(super) sig: String,
    /// K, hex, for `signer: "wallet"` on a node that recorded no wallet key yet (it was never bound);
    /// taken only when the chain's commitment vouches for it.
    #[serde(default)] pub(super) identity_pubkey: Option<String>,
    /// As in the public query.
    #[serde(default)] pub(super) nonce: Option<String>,
}

/// Who signed a status request, checked cheapest first: shape, time, registration, the key, then the
/// signature. `bad_signature` says the signature does not verify under the node's current key of that
/// kind: for a ping key, that this device is not the one bound.
pub(super) fn check_signed_status(storage: &crate::storage::Storage, req: &SignedStatusRequest, now: u64) -> Result<(), Refusal> {
    let hex_ok = |s: &str, len: usize| s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !req.node_id.starts_with("light_") || req.node_id.len() > 128 || !hex_ok(&req.sig, lb::MLDSA65_SIG_HEX) {
        return Err(Refusal::BadRequest);
    }
    if now.abs_diff(req.ts) > lb::FRESH_TS_WINDOW_SECS {
        return Err(Refusal::Expired);
    }
    if !storage.is_node_registration_onchain(&req.node_id) {
        return Err(Refusal::NotRegistered);
    }
    let message = lb::light_status_message(&req.node_id, req.ts);
    let key = match req.signer.as_str() {
        "ping" => {
            let row = storage.get_light_binding(&req.node_id).filter(|b| b.device_bound()).ok_or(Refusal::BadSignature)?;
            // The stored delegation under the key the chain vouches for, as the ping reply checks it.
            let identity = storage.resolve_light_identity_pk(&req.node_id, None).ok_or(Refusal::BadSignature)?;
            if lb::verify_delegation(&row.cert, &row.ping_pubkey, &req.node_id, &identity).is_none() {
                return Err(Refusal::BadSignature);
            }
            row.ping_pubkey
        }
        "wallet" => {
            let presented = req.identity_pubkey.as_deref().filter(|k| !k.is_empty());
            if presented.map_or(false, |k| !hex_ok(k, lb::MLDSA65_PK_HEX)) {
                return Err(Refusal::BadRequest);
            }
            storage.resolve_light_identity_pk(&req.node_id, presented).ok_or(Refusal::IdentityMismatch)?
        }
        _ => return Err(Refusal::BadRequest),
    };
    if !crate::rpc::verify_mobile_dilithium_signature(&message, &req.sig, &key) {
        return Err(Refusal::BadSignature);
    }
    Ok(())
}

/// `POST /api/v1/light-node/status`: the signed form.
pub(super) async fn handle_light_node_status_signed(
    req: SignedStatusRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if check_api_rate_limit(remote_addr, "light_node_status_signed").is_err() {
        return Ok(warp::reply::json(&Refusal::RateLimited.to_json()));
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if let Err(r) = check_signed_status(&blockchain.get_storage(), &req, now) {
        if crate::node::is_debug() {
            println!("[DBG][LIGHT] status_signed_refused node={} signer={} reason={}", req.node_id, req.signer, r.as_str());
        }
        return Ok(warp::reply::json(&r.to_json()));
    }
    let s = light_status(&blockchain, &req.node_id, true).await;
    let nonce = parse_nonce(req.nonce.as_deref());
    Ok(warp::reply::json(&signed_json(&s, nonce.as_ref())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};

    const E: u64 = EPOCH_BLOCKS;

    const NOW: u64 = 1_800_000_000;

    fn status(binding: Option<BindingRow>) -> LightStatus {
        let device = device_view(true, binding.as_ref(), false, "android", "", Some(150), NOW);
        LightStatus {
            node_id: "light_mobile_0123456789abcdef".into(),
            known: true,
            onchain: true,
            registered_height: Some(100 * E + 5),
            burn_tx: Some("burn".into()),
            registration_pending: false,
            binding,
            answered_this_epoch: true,
            needs_reactivation: false,
            is_active: true,
            counted: Counted { epochs_since_registration: 6, counted: 5, last_counted_epoch: Some(150) },
            next_ping: (1_800_000_000, 125),
            device: DeviceStatus::default(),
            device_view: device,
            features: lb::light_node_features(),
            authoritative: true,
            push_reregister: false,
        }
    }

    fn bound_row() -> BindingRow {
        BindingRow { ping_pubkey: "ab".into(), cert: lb::format_v2_cert(1_790_000_000, "cd"), identity_pubkey: "ef".into(),
                     seq: 1_790_000_000, floor: 0, bound_at: 1_790_000_010, v2: true, device_fp: "fp".into(), unbind: None,
                     retired_fps: Vec::new() }
    }

    #[test]
    fn a_fresh_node_reads_active_only_with_a_device() {
        // (onchain, recent, answered, fresh, bound, owner) -> (needs_reactivation, is_active)
        assert_eq!(liveness(true, false, false, true, false, false), (false, false), "fresh, nothing linked: not active");
        assert_eq!(liveness(true, false, false, true, true, false), (false, true), "fresh with a device");
        assert_eq!(liveness(true, false, false, false, true, false), (true, false), "past the grace, silent");
        assert_eq!(liveness(true, true, false, false, false, false), (false, true), "counted last epoch");
        assert_eq!(liveness(true, false, true, false, false, false), (false, true), "answered this epoch");
        assert_eq!(liveness(true, false, false, false, false, true), (false, true), "the shard owner counts it");
        assert_eq!(liveness(false, true, true, true, true, true), (false, false), "not on chain: neither");
    }

    #[test]
    fn the_public_form_is_the_minimum_and_every_genesis_renders_it_alike() {
        let s = status(Some(bound_row()));
        let v = public_json(&s, None);
        let keys: std::collections::BTreeSet<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        let want: std::collections::BTreeSet<&str> = [
            "success", "node_id", "onchain_registered", "registration_pending", "device_bound", "answered_this_epoch",
            "needs_reactivation", "is_active", "counted", "burn_tx", "device", "features", "authoritative",
            "has_attestation_current_slot", "next_ping_time", "next_ping_window",
        ].into_iter().collect();
        assert_eq!(keys, want, "no exact sequence, channel or device record in public");
        assert_eq!(v["device"], json!({"platform": "android", "model": null, "linked_since": 1_789_948_800u64,
                                       "last_answer_epoch": 150, "state": "online", "last_miss": null}));
        assert!(v.get("push_reregister").is_none(), "how the device is reached is never public");
        assert_eq!(v["counted"], json!({"epochs_since_registration": 6, "counted": 5, "last_counted_epoch": 150}));
        assert_eq!(v["device_bound"], json!(true));
        // Owner decision (c): the registration's burn, public on Solana and in the chain row already.
        assert_eq!(v["burn_tx"], json!("burn"));
        // The old handler answered from two branches (RAM registry hit or miss) with different fields.
        // There is one view now; RAM presence feeds only the legacy success flag. A node the RAM
        // registry holds before the chain does carries the same fields.
        let ram_only = LightStatus { onchain: false, registered_height: None, burn_tx: None, is_active: false,
                                     counted: Counted::default(), device_view: None, ..status(Some(bound_row())) };
        let r = public_json(&ram_only, None);
        assert_eq!(r.as_object().unwrap().keys().map(|k| k.as_str()).collect::<std::collections::BTreeSet<_>>(), want);
        assert_eq!((r["success"].clone(), r["onchain_registered"].clone()), (json!(true), json!(false)));
        // A node nobody knows: every field still there, so a client reads a verdict, not a gap.
        let absent = LightStatus { known: false, onchain: false, registered_height: None, burn_tx: None, binding: None,
                                   answered_this_epoch: false, is_active: false, counted: Counted::default(),
                                   device_view: None, ..status(None) };
        let a = public_json(&absent, None);
        assert_eq!(a["success"], json!(false));
        assert_eq!(a["device"], Value::Null, "no device view for a node not on chain");
        assert_eq!(a["error"], json!("Node not found"));
        for k in &want { assert!(a.get(*k).is_some(), "{k}"); }
        assert_eq!(a["counted"], json!({"epochs_since_registration": 0, "counted": 0, "last_counted_epoch": null}));
    }

    /// 04.10: the public device view tells online, offline, unlinked and a device linked just now apart, and is
    /// null while the node is not on chain. Every genesis renders it alike: the day comes from the binding's
    /// sequence, never from the genesis's own clock.
    #[test]
    fn the_public_device_view_names_the_state_platform_day_and_last_answer() {
        let seq = 1_790_000_123u64;
        let day = seq - seq % 86_400;
        let row = BindingRow { seq, cert: lb::format_v2_cert(seq, "cd"), ..bound_row() };
        let view = |b: Option<&BindingRow>, needs: bool, platform: &'static str, last: Option<u64>, now: u64| {
            device_view(true, b, needs, platform, "", last, now).unwrap()
        };
        assert_eq!(device_view(false, Some(&row), false, "ios", "Acme 7", Some(3), NOW), None, "not on chain: null");
        // Online: counted (or in its first epochs) with a device bound.
        assert_eq!(view(Some(&row), false, "ios", Some(155), NOW),
                   DeviceView { platform: Some("ios"), model: None, linked_since: Some(day), last_answer_epoch: Some(155),
                                  last_answer_at: None, state: "online", last_miss: None, last_answer: None });
        // Offline: bound, not counted in this epoch or the last two, linked longer than an epoch ago.
        let off = view(Some(&row), true, "", Some(150), seq + LINK_GRACE_SECS);
        assert_eq!((off.state, off.platform, off.last_answer_epoch), ("offline", Some("unknown"), Some(150)));
        // Linked less than an epoch ago and not answered yet.
        assert_eq!(view(Some(&row), true, "android", None, seq + LINK_GRACE_SECS - 1).state, "other_device_pending");
        assert_eq!(view(Some(&row), true, "android", None, seq).state, "other_device_pending");
        // Unlinked: no binding, or a withdrawn one; no platform, no day.
        let withdrawn = BindingRow { ping_pubkey: String::new(), seq: 0, floor: seq, ..row.clone() };
        for b in [None, Some(&withdrawn)] {
            assert_eq!(view(b, true, "ios", Some(140), NOW),
                       DeviceView { platform: None, model: None, linked_since: None, last_answer_epoch: Some(140),
                                      last_answer_at: None, state: "unlinked", last_miss: None, last_answer: None });
        }
        // A legacy binding has no sequence: no day, and never "just linked".
        let legacy = BindingRow { cert: "legacy".into(), seq: 0, v2: false, ..row.clone() };
        let l = view(Some(&legacy), true, "", None, NOW);
        assert_eq!((l.state, l.linked_since, l.platform), ("offline", None, Some("unknown")));
        // Rendered in the public form by its epoch only; the answer's second is the signed form's (H-1).
        let mut s = status(Some(row.clone()));
        s.device_view = Some(DeviceView { last_answer_at: Some(1_790_050_000), ..off });
        let v = public_json(&s, None);
        assert_eq!(v["device"], json!({"platform": "unknown", "model": null, "linked_since": day, "last_answer_epoch": 150,
                                       "state": "offline", "last_miss": null}));
        let signed = signed_json(&s, None);
        assert_eq!(signed["device"], json!({"platform": "unknown", "model": null, "linked_since": day, "last_answer_epoch": 150,
                                            "last_answer_at": 1_790_050_000u64, "state": "offline", "last_miss": null,
                                            "last_answer": null}));
        assert!(holds(&signed["device"], &v["device"]), "the signed device carries everything the public one does");
        s.device_view = None;
        assert_eq!(public_json(&s, None)["device"], Value::Null);
        assert_eq!(signed_json(&s, None)["device"], Value::Null);
    }

    /// `big` carries every field of `small` with the same value, nested objects field by field.
    fn holds(big: &Value, small: &Value) -> bool {
        match (big, small) {
            (Value::Object(b), Value::Object(s)) => s.iter().all(|(k, v)| b.get(k).map_or(false, |bv| holds(bv, v))),
            _ => big == small,
        }
    }

    /// H-1: the public status, which anyone reads for any wallet's node, carries no timeline of the owner's phone: no
    /// time of an answer, a wake or a delivery, no delay, no refusal code and nothing of what the app did. Those are the
    /// signed form's, which only the node's ping key or its wallet key reads; the GET route serves the public form only.
    #[test]
    fn the_public_status_carries_no_timeline_of_the_phone() {
        let mut s = status(Some(bound_row()));
        if let Some(dv) = s.device_view.as_mut() {
            dv.last_answer_at = Some(1_800_000_100);
            dv.last_miss = Some(LightMiss { epoch: 160, reason: MissReason::WokenNoAnswer, woken_at: Some(1_799_990_000),
                                            answered_at: None, delivery_delay_secs: Some(240), refused: None, recorded_at: 9,
                                            delivered_at: Some(1_799_990_240), app_outcome: Some(AppOutcome::Swiped),
                                            by_push: true });
            dv.last_answer = Some(LastAnswer { at: 1_800_000_100, delivery_delay_secs: Some(30), handling_secs: Some(2) });
        }
        let p = public_json(&s, None);
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
        let set = |k: &[&str]| k.iter().map(|x| x.to_string()).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(keys(&p["device"]), set(&["platform", "model", "linked_since", "last_answer_epoch", "state", "last_miss"]));
        assert_eq!(p["device"]["last_miss"], json!({"epoch": 160, "reason": "woken_no_answer", "delivered": true}));
        let wire = p.to_string();
        for leak in ["1800000100", "1799990000", "1799990240", "swiped", "delivery_delay_secs", "handling_secs", "woken_at",
                     "app_outcome", "last_answer_at"] {
            assert!(!wire.contains(leak), "{leak} in the public form");
        }
        // The signed form has it all, and everything public too.
        let v = signed_json(&s, None);
        assert!(holds(&v["device"], &p["device"]));
        assert_eq!(v["device"]["last_answer_at"], json!(1_800_000_100u64));
        assert_eq!(v["device"]["last_miss"], json!({"epoch": 160, "reason": "woken_no_answer", "delivered": true,
            "woken_at": 1_799_990_000u64, "answered_at": null, "delivery_delay_secs": 240, "refused": null,
            "delivered_at": 1_799_990_240u64, "app_outcome": "swiped"}));
        assert_eq!(v["device"]["last_answer"], json!({"at": 1_800_000_100u64, "delivery_delay_secs": 30, "handling_secs": 2}));
        // `delivered`: false for a push that never reached the phone, unknown where nothing told.
        let miss = |r: MissReason| LightMiss { reason: r, delivered_at: None, delivery_delay_secs: None, app_outcome: None,
                                               ..s.device_view.as_ref().unwrap().last_miss.clone().unwrap() };
        assert_eq!(miss(MissReason::NotDelivered).public_json()["delivered"], json!(false));
        assert_eq!(miss(MissReason::WokenNoAnswer).public_json()["delivered"], Value::Null);
        assert_eq!(miss(MissReason::NotWokenInactive).public_json(), json!({"epoch": 160, "reason": "not_woken_inactive",
                                                                           "delivered": null}));
        // The keyless route answers with the public form only.
        let src = include_str!("light_status.rs");
        let get = &src[src.find("pub(super) async fn handle_light_node_status(").unwrap()..];
        let get = &get[..get.find("#[derive(Debug, Default, serde::Deserialize)]").unwrap()];
        assert!(get.contains("public_json(&s, nonce.as_ref())") && !get.contains("signed_json("));
    }

    /// 05.10: the device view says why the node was last not counted and how its last answer reached it. The dormant
    /// rule's miss is derived from the committed index, alike at every genesis; a record written here wins at its
    /// epoch, and a later epoch wins over both.
    #[test]
    fn the_device_view_names_the_last_miss_and_the_last_answer() {
        let reg = Some(100 * E + 5);
        let cur = 160 * E + 10;
        let done = u64::MAX;
        let row = LightUptime::mark(None, 156);
        let d = dormant_miss(reg, cur, row, done).expect("silent in 157, 158 and 159: not woken in 159");
        assert_eq!((d.epoch, d.reason, d.woken_at), (159, MissReason::NotWokenInactive, None));
        assert_eq!(dormant_miss(reg, cur, LightUptime::mark(None, 157), done), None, "counted in 157: still woken in 159");
        assert!(dormant_miss(reg, cur, None, done).is_some(), "never counted, registered long ago");
        assert_eq!(dormant_miss(reg, cur, row, done & !1), None, "an epoch this genesis did not index says nothing");
        assert_eq!(dormant_miss(Some(156 * E + 14_399), cur, None, done), None, "fresh for part of 159: pushed");
        assert!(dormant_miss(Some(155 * E + 14_399), cur, None, done).is_some());
        assert_eq!(dormant_miss(reg, 0, None, done), None, "no finished epoch");
        let stored = |e, r| LightMiss { epoch: e, reason: r, woken_at: Some(5), answered_at: None, delivery_delay_secs: None,
                                        refused: None, recorded_at: 9, delivered_at: None, app_outcome: None, by_push: true };
        assert_eq!(shown_miss(Some(stored(158, MissReason::WokenNoAnswer)), Some(d.clone())).map(|m| m.epoch), Some(159));
        assert_eq!(shown_miss(Some(stored(159, MissReason::WokenNoAnswer)), Some(d.clone())).map(|m| m.reason),
                   Some(MissReason::WokenNoAnswer), "what this genesis saw tells more at the same epoch");
        assert_eq!(shown_miss(Some(stored(160, MissReason::AnsweredLate)), Some(d.clone())).map(|m| m.epoch), Some(160));
        assert_eq!(shown_miss(None, Some(d.clone())), Some(d));
        assert_eq!(shown_miss(None, None), None);
        // Rendered in the public form by its epoch and reason, and in full in the signed one (H-1).
        let mut s = status(Some(bound_row()));
        if let Some(dv) = s.device_view.as_mut() {
            dv.last_miss = Some(LightMiss { answered_at: Some(1_800_000_900), delivery_delay_secs: Some(7_200),
                                            ..stored(160, MissReason::AnsweredLate) });
            dv.last_answer = Some(LastAnswer { at: 1_799_000_000, delivery_delay_secs: None, handling_secs: Some(2) });
        }
        let p = public_json(&s, None);
        assert_eq!(p["device"]["last_miss"], json!({"epoch": 160, "reason": "answered_late", "delivered": true}));
        assert!(p["device"].get("last_answer").is_none(), "the last answer is the signed form's");
        let v = signed_json(&s, None);
        assert_eq!(v["device"]["last_miss"], json!({"epoch": 160, "reason": "answered_late", "delivered": true, "woken_at": 5,
            "answered_at": 1_800_000_900u64, "delivery_delay_secs": 7_200, "refused": null, "delivered_at": null,
            "app_outcome": null}));
        // A record refined by the device's receipts serves when the push reached it and what the app did, or that it
        // never reached it; at one epoch `not_delivered` tells more than the dormant rule's and the plain wake.
        let refined = LightMiss { delivered_at: Some(1_800_000_300), delivery_delay_secs: Some(240),
                                  app_outcome: Some(AppOutcome::Swiped), ..stored(160, MissReason::WokenNoAnswer) };
        assert_eq!((refined.to_json()["delivered_at"].clone(), refined.to_json()["app_outcome"].clone()),
                   (json!(1_800_000_300u64), json!("swiped")));
        assert_eq!(shown_miss(Some(stored(159, MissReason::NotDelivered)), dormant_miss(reg, cur, row, done)).map(|m| m.reason),
                   Some(MissReason::NotDelivered));
        assert_eq!(stored(159, MissReason::NotDelivered).to_json()["reason"], json!("not_delivered"));
        assert_eq!(v["device"]["last_answer"], json!({"at": 1_799_000_000u64, "delivery_delay_secs": null, "handling_secs": 2}));
        assert!(holds(&v["device"], &p["device"]));
        // The status reads the row since the binding held here, beside the dormant rule's miss, only while bound.
        let src = include_str!("light_status.rs");
        let body = &src[src.find("pub(crate) async fn light_status(").unwrap()..];
        let body = &body[..body.find("        push_reregister,\n    }").unwrap()];
        assert!(body.contains("let bound_at = binding.as_ref().filter(|b| b.device_bound()).map(|b| b.bound_at);"));
        assert!(body.contains("let row = stored_row(&storage, node_id).unwrap_or_default().since(bound_at);"));
        assert!(body.contains("dormant_miss(registered_height, cur_height, uptime, done)"));
    }

    /// The platform: the device record's while it holds this binding, else the hint the bind named, kept with the
    /// binding's own push record, else unknown; a token refresh keeps it and a new binding's record drops it.
    #[test]
    fn the_device_platform_comes_from_the_record_then_the_binds_hint() {
        use crate::light_device::record::tests::rec;
        use crate::light_device::{DeviceState, Platform};
        let (storage, _dir) = temp_storage();
        let node = "light_mobile_platform000000";
        let seq = 1_790_000_000u64;
        let row = BindingRow { seq, cert: lb::format_v2_cert(seq, "cd"), ..bound_row() };
        assert_eq!(device_platform(&storage, node, &row, None), "", "nothing known");
        storage.save_fcm_token_seq_platform(node, "tok", "fcm", None, seq, seq, "ios", "").unwrap();
        assert_eq!(device_platform(&storage, node, &row, None), "ios", "the bind's hint");
        // A token refresh of the same binding names none and keeps it.
        storage.save_fcm_token_seq(node, "tok2", "fcm", None, seq + 60, seq).unwrap();
        assert_eq!(storage.get_fcm_entry(node).map(|e| (e.token, e.platform)), Some(("tok2".to_string(), "ios".to_string())));
        // The record of this binding wins: the platform the device proved.
        let mut r = rec(1, 150, DeviceState::Active);
        r.node_id = node.into();
        r.seq = seq;
        r.platform = Platform::Android;
        assert_eq!(device_platform(&storage, node, &row, Some(&r)), "android");
        // A record of another binding is not this device's.
        r.seq = seq - 5;
        assert_eq!(device_platform(&storage, node, &row, Some(&r)), "ios");
        // A newer binding's record with no hint: unknown, not the old device's platform.
        storage.save_fcm_token_seq(node, "tok3", "fcm", None, seq + 100, seq + 100).unwrap();
        assert_eq!(device_platform(&storage, node, &BindingRow { seq: seq + 100, ..row.clone() }, None), "");
        assert_eq!(device_platform(&storage, node, &row, None), "", "the old binding's record is gone");
        // Anything but the two platforms is no platform; a bind is never refused for it.
        assert_eq!(lb::platform_hint(Some("android")), "android");
        assert_eq!(lb::platform_hint(Some("ios")), "ios");
        for other in [Some("ipados"), Some("web"), Some(""), Some("IOS"), None] {
            assert_eq!(lb::platform_hint(other), "", "{other:?}");
        }
        // A legacy or withdrawn binding names no platform.
        assert_eq!(device_platform(&storage, node, &BindingRow { cert: "legacy".into(), seq: 0, v2: false, ..row.clone() }, None), "");
    }

    /// 06.10: the model the bind named is served next to the platform while that binding holds a device: kept with
    /// the binding's own push record through a token refresh, dropped by a newer binding that names none and with the
    /// unbind, never shown for a binding that names a platform other than the one its device record proved, and null
    /// wherever none is known.
    #[test]
    fn the_device_model_is_the_binds_hint_served_beside_the_platform() {
        use crate::light_device::record::tests::rec;
        use crate::light_device::{DeviceState, Platform};
        let (storage, _dir) = temp_storage();
        let node = "light_mobile_model00000000";
        let seq = 1_790_000_000u64;
        let row = BindingRow { seq, cert: lb::format_v2_cert(seq, "cd"), ..bound_row() };
        assert_eq!(device_hints(&storage, node, &row, None), ("", String::new()), "nothing known");
        storage.save_fcm_token_seq_platform(node, "tok", "fcm", None, seq, seq, "android", "Acme Phone 7").unwrap();
        assert_eq!(device_hints(&storage, node, &row, None), ("android", "Acme Phone 7".to_string()));
        // A token refresh of the same binding names neither and keeps both; a write naming only the platform (an older
        // peer's sync) keeps the model.
        storage.save_fcm_token_seq(node, "tok2", "fcm", None, seq + 60, seq).unwrap();
        storage.save_fcm_token_seq_platform(node, "tok3", "fcm", None, seq + 61, seq, "android", "").unwrap();
        assert_eq!(storage.get_fcm_entry(node).map(|e| (e.token, e.platform, e.model)),
                   Some(("tok3".to_string(), "android".to_string(), "Acme Phone 7".to_string())));
        // The device record of this binding: its proven platform, and the model while the bind named the same one.
        let mut r = rec(1, 150, DeviceState::Active);
        r.node_id = node.into();
        r.seq = seq;
        r.platform = Platform::Android;
        assert_eq!(device_hints(&storage, node, &row, Some(&r)), ("android", "Acme Phone 7".to_string()));
        r.platform = Platform::Ios;
        assert_eq!(device_hints(&storage, node, &row, Some(&r)), ("ios", String::new()), "hints of another device: no model");
        // Served beside the platform; null while unknown or nothing is bound.
        let shown = |model: &str| {
            let mut s = status(Some(row.clone()));
            s.device_view = device_view(true, Some(&row), false, "android", model, Some(150), NOW);
            public_json(&s, None)["device"].clone()
        };
        assert_eq!((shown("Acme Phone 7")["platform"].clone(), shown("Acme Phone 7")["model"].clone()),
                   (json!("android"), json!("Acme Phone 7")));
        assert_eq!(shown("")["model"], Value::Null);
        let withdrawn = BindingRow { ping_pubkey: String::new(), seq: 0, floor: seq, ..row.clone() };
        assert_eq!(device_view(true, Some(&withdrawn), true, "android", "Acme Phone 7", None, NOW).map(|d| d.model), Some(None));
        // A stored model that is not a model (a hand-written row) is none.
        let raw = json!({"token": "tok3", "push_type": "fcm", "endpoint": "", "updated_at": seq + 61, "seq": seq,
                         "platform": "android", "model": "<b>x</b>"});
        storage.put_registry_row_for_test("fcm_tokens", node.as_bytes(), raw.to_string().as_bytes());
        assert_eq!(device_hints(&storage, node, &row, None), ("android", String::new()));
        // A newer binding's record that names none: no model, not the old device's.
        storage.save_fcm_token_seq(node, "tok5", "fcm", None, seq + 100, seq + 100).unwrap();
        assert_eq!(device_hints(&storage, node, &BindingRow { seq: seq + 100, ..row.clone() }, None), ("", String::new()));
        assert_eq!(device_hints(&storage, node, &row, None), ("", String::new()), "the old binding's record is gone");
        // A newer binding that names its own replaces it.
        storage.save_fcm_token_seq_platform(node, "tok6", "fcm", None, seq + 200, seq + 200, "ios", "Acme Tab 3").unwrap();
        let newer = BindingRow { seq: seq + 200, ..row.clone() };
        assert_eq!(device_hints(&storage, node, &newer, None), ("ios", "Acme Tab 3".to_string()));
        // The unbind deletes the push record, and with it the model.
        storage.withdraw_light_binding(node, seq + 200, "", None, |_| Ok(true)).unwrap().unwrap();
        assert!(storage.get_fcm_entry(node).is_none());
        assert_eq!(device_hints(&storage, node, &newer, None), ("", String::new()));
    }

    /// X1: a genesis behind the network says so, so a client can discount its "not listed" as it discounts

    /// verify-activation's (both read `absence_vouch`).
    #[test]
    fn a_behind_node_marks_its_not_listed_as_not_authoritative() {
        let behind = LightStatus { known: false, onchain: false, registered_height: None, burn_tx: None, binding: None,
                                   answered_this_epoch: false, is_active: false, counted: Counted::default(),
                                   authoritative: false, ..status(None) };
        let v = public_json(&behind, None);
        assert_eq!((v["onchain_registered"].clone(), v["authoritative"].clone()), (json!(false), json!(false)));
        assert_eq!(signed_json(&behind, None)["authoritative"], json!(false));
        assert_eq!(public_json(&status(None), None)["authoritative"], json!(true));
    }

    /// ND-7: an install keeps its device tag across a rebind or a wallet switch, so the tag answered to anyone
    /// for a nonce the caller picks linked two wallets to one phone. It is in the signed form only.
    #[test]
    fn the_device_tag_shows_only_hashed_with_a_nonce_only_while_bound_and_only_signed() {
        let nonce = [7u8; 16];
        let tag = [9u8; 32];
        let mut s = status(Some(bound_row()));
        s.device.device_tag = Some(tag);
        assert!(signed_json(&s, None).get("device_tag_h").is_none(), "no nonce, no tag");
        assert_eq!(signed_json(&s, Some(&nonce))["device_tag_h"], json!(lb::device_tag_h(&nonce, &tag)));
        assert!(public_json(&s, Some(&nonce)).get("device_tag_h").is_none(), "never in the public form");
        s.binding = Some(BindingRow { ping_pubkey: String::new(), seq: 0, floor: 1_790_000_000, ..bound_row() });
        assert!(signed_json(&s, Some(&nonce)).get("device_tag_h").is_none(), "unbound: no tag");
        assert_eq!(parse_nonce(Some("0123456789abcdef0123456789abcdef")).map(|n| n[0]), Some(0x01));
        for bad in ["0123", "0123456789ABCDEF0123456789ABCDEF", "zz23456789abcdef0123456789abcdef", ""] {
            assert_eq!(parse_nonce(Some(bad)), None, "{bad}");
        }
    }

    #[test]
    fn the_signed_form_adds_the_binding_and_the_registration_record() {
        let s = status(Some(bound_row()));
        let v = signed_json(&s, None);
        assert_eq!(v["binding_seq"], json!(1_790_000_000u64));
        assert_eq!(v["bound_at"], json!(1_790_000_010u64));
        assert_eq!(v["registered_height"], json!(100 * E + 5));
        assert_eq!(v["burn_tx"], json!("burn"));
        for k in ["device_state", "effective_epoch", "refresh_window", "rotation_due", "paused_until", "ref"] {
            assert_eq!(v[k], Value::Null, "{k}: empty until the device layer");
        }
        assert_eq!(v["push_reregister"], json!(false));
        assert_eq!(signed_json(&LightStatus { push_reregister: true, ..status(Some(bound_row())) }, None)["push_reregister"], json!(true));
        // Everything public is in the signed form too (the signed `device` adds the timeline, H-1).
        for (k, val) in public_json(&s, None).as_object().unwrap() { assert!(holds(&v[k.as_str()], val), "{k}"); }
        // After an unbind: no device, and the sequence to beat is the floor.
        let unbound = status(Some(BindingRow { ping_pubkey: String::new(), seq: 0, floor: 1_790_000_500, ..bound_row() }));
        let u = signed_json(&unbound, None);
        assert_eq!((u["binding_seq"].clone(), u["bound_at"].clone(), u["device_bound"].clone()),
                   (json!(1_790_000_500u64), Value::Null, json!(false)));
        // Never bound: 0, the state a pre-signed first binding is taken in.
        assert_eq!(signed_json(&status(None), None)["binding_seq"], json!(0));
        let legacy = status(Some(BindingRow { cert: "legacy".into(), seq: 0, v2: false, ..bound_row() }));
        assert_eq!(signed_json(&legacy, None)["binding_seq"], json!(0));
        assert_eq!(signed_json(&legacy, None)["device_bound"], json!(true));
    }

    #[test]
    fn the_signed_form_carries_the_device_record_and_the_public_one_only_its_hashed_tag() {
        use crate::light_device::record::{tests::rec, Local, REVOKED};
        use crate::light_device::{messages, DeviceState};
        let (now, epoch) = (1_800_000_000u64, 155u64);
        let nonce = [7u8; 16];
        let mut r = rec(1, epoch, DeviceState::Active);
        r.nonce = messages::b64url(&[9u8; 32]);
        r.lease_valid_until = now + 7 * 86_400;
        r.refresh_at = now + 6 * 86_400;
        let view = |r: &crate::light_device::record::DeviceRecord, released: bool, local: Local| {
            let mut s = status(Some(bound_row()));
            s.device = device_status_of(r, released, true, epoch, now, local);
            (public_json(&s, Some(&nonce)), signed_json(&s, Some(&nonce)))
        };
        let (p, v) = view(&r, false, Local::default());
        assert_eq!(v["device_tag_h"], json!(lb::device_tag_h(&nonce, &r.device_tag_bytes().unwrap())));
        assert!(p.get("device_tag_h").is_none(), "the hashed tag is the signed form's (ND-7)");
        for k in ["device_state", "effective_epoch", "refresh_window", "rotation_due", "paused_until", "ref"] {
            assert!(p.get(k).is_none(), "{k} is the signed form's");
        }
        assert_eq!((v["device_state"].as_str(), v["effective_epoch"].as_u64(), v["rotation_due"].as_u64()),
                   (Some("active"), Some(epoch), Some(epoch + crate::light_device::ROTATION_PERIOD_EPOCHS)));
        let (from, to) = (v["refresh_window"]["from"].as_u64().unwrap(), v["refresh_window"]["to"].as_u64().unwrap());
        assert!(from >= r.refresh_at && from < to && to == r.lease_valid_until, "{from} {to}");
        assert_eq!(v["paused_until"], Value::Null);
        assert_eq!(v["ref"].as_str().map(|x| x.len()), Some(8));
        // Paused by two strikes until epoch 280: the state and its epoch, and no refresh to make.
        let paused = crate::light_device::record::DeviceRecord { state: DeviceState::Paused, until_epoch: 280,
                                                                 reason: "two_strikes".into(), ..r.clone() };
        let (_, v) = view(&paused, false, Local::default());
        assert_eq!((v["device_state"].as_str(), v["paused_until"].as_u64(), v["refresh_window"].is_null()), (Some("paused"), Some(280), true));
        // A revocation: paused with no epoch; the snapshot's view shows it before the signed change comes.
        let revoked = crate::light_device::record::DeviceRecord { state: DeviceState::Paused, reason: REVOKED.into(), ..r.clone() };
        let (_, v) = view(&revoked, false, Local::default());
        assert_eq!((v["device_state"].as_str(), v["paused_until"].clone()), (Some("paused"), Value::Null));
        let (_, v) = view(&r, false, Local { revoked: true, ..Local::default() });
        assert_eq!(v["device_state"].as_str(), Some("paused"));
        // Released by a Stop: ended, no device named; a timed pause it kept is still reported.
        let (p, v) = view(&paused, true, Local::default());
        assert!(p.get("device_tag_h").is_none() && v.get("device_tag_h").is_none());
        assert_eq!((v["device_state"].as_str(), v["paused_until"].as_u64(), v["effective_epoch"].clone()),
                   (Some("ended"), Some(280), Value::Null));
        // After a rotation the tag names the new key: the app settles an unanswered rotation by it.
        let rotated = crate::light_device::record::DeviceRecord { device_tag: "ee".repeat(32), ..r.clone() };
        let (_, v) = view(&rotated, false, Local::default());
        assert_eq!(v["device_tag_h"], json!(lb::device_tag_h(&nonce, &[0xee; 32])));
        // An outage keeps a clean lease counting in the status as in the ping check.
        let lapsed = crate::light_device::record::DeviceRecord { lease_valid_until: now - 60, ..r.clone() };
        assert_eq!(view(&lapsed, false, Local::default()).1["device_state"].as_str(), Some("check_pending"));
        assert_eq!(view(&lapsed, false, Local { oracle_down_since: now - 3_600, ..Local::default() }).1["device_state"].as_str(),
                   Some("active"));
    }

    #[test]
    fn the_device_forms_are_listed_only_where_a_device_can_be_counted() {
        let base = lb::light_node_features();
        assert!(!base.contains(&"device_v1") && !base.contains(&"hwping_v2"), "no pinned oracle key in this binary");
        assert_eq!(base, lb::LIGHT_NODE_FEATURES.to_vec());
        let served = lb::features_with(true);
        assert!(served.contains(&"device_v1") && served.contains(&"hwping_v2"));
        assert_eq!(&served[..lb::LIGHT_NODE_FEATURES.len()], lb::LIGHT_NODE_FEATURES);
    }

    fn up(last: u64, mask: u64) -> Option<LightUptime> { Some(LightUptime { last, mask }) }

    #[test]
    fn counted_epochs_run_from_registration_over_the_indexed_epochs() {
        // Registered in epoch 100 before its roster froze: epoch 100 counts. Now in epoch 106, so
        // epochs 100..=105 are finished.
        let reg = 100 * E + 5;
        let cur = 106 * E + 10;
        let all = u64::MAX;
        // Counted in 105, 104, 102, 101, 100 (bits 0,1,3,4,5 from 105).
        let row = up(105, 0b11_1011);
        assert_eq!(counted_view(Some(reg), cur, row, all),
                   Counted { epochs_since_registration: 6, counted: 5, last_counted_epoch: Some(105) });
        // A registration after the freeze counts from the next epoch.
        let late = 100 * E + (E - 1);
        assert_eq!(counted_view(Some(late), cur, row, all).epochs_since_registration, 5);
        // An epoch this genesis never indexed is in neither count.
        let done_without_103 = all & !(1 << 2);
        assert_eq!(counted_view(Some(reg), cur, up(105, 0b11_1111), done_without_103),
                   Counted { epochs_since_registration: 5, counted: 5, last_counted_epoch: Some(105) });
        // Never counted.
        assert_eq!(counted_view(Some(reg), cur, None, all),
                   Counted { epochs_since_registration: 6, counted: 0, last_counted_epoch: None });
        // Nothing finished since the registration yet.
        assert_eq!(counted_view(Some(106 * E), cur, None, all), Counted::default());
        // Not on chain.
        assert_eq!(counted_view(None, cur, row, all), Counted::default());
        // Long registered: the window is the last 64 epochs, and counted never exceeds it.
        let c = counted_view(Some(5 * E), cur, up(105, u64::MAX), all);
        assert_eq!((c.epochs_since_registration, c.counted), (64, 64));
    }

    #[test]
    fn the_uptime_mask_survives_an_epoch_gap_and_any_order() {
        let mut row = LightUptime::mark(None, 100);
        assert_eq!(row, up(100, 1));
        row = LightUptime::mark(row, 101);
        assert_eq!(row, up(101, 0b11));
        // Nobody counted it for five epochs, then again: the gap reads as missed epochs.
        row = LightUptime::mark(row, 107);
        assert_eq!(row, up(107, 0b1100_0001));
        assert_eq!(counted_view(Some(100 * E), 108 * E, row, u64::MAX),
                   Counted { epochs_since_registration: 8, counted: 3, last_counted_epoch: Some(107) });
        // A backfill of a missed epoch after later ones fills its bit; a repeat changes nothing.
        row = LightUptime::mark(row, 104).or(row);
        assert_eq!(row, up(107, 0b1100_1001));
        assert_eq!(LightUptime::mark(row, 104), None);
        assert_eq!(LightUptime::mark(row, 107), None);
        // Older than the window of the stored row: unknown, left alone.
        assert_eq!(LightUptime::mark(row, 107 - 64), None);
        // A gap past the window starts over.
        assert_eq!(LightUptime::mark(row, 107 + 64), up(107 + 64, 1));
        // Read later, the mask shifts; read from before a pass finished, later bits drop out.
        let r = row.unwrap();
        assert_eq!(r.aligned_to(110), 0b1100_1001 << 3);
        assert_eq!(r.aligned_to(106), 0b1100_1001 >> 1);
        assert_eq!(r.last_counted_at_or_before(106), Some(104));
        assert_eq!(r.aligned_to(107 + 64), 0);
        // The stored form round-trips and refuses anything else.
        assert_eq!(LightUptime::decode(&r.encode()), Some(r));
        assert_eq!(LightUptime::decode(&[0u8; 15]), None);
        assert_eq!(LightUptime::decode(&[0u8; 16]), None, "a row always has its last epoch set");
    }

    fn temp_storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (s, dir)
    }

    /// `last_answer_at` is the newest counted answer of the current epoch and the two before, none older.
    #[test]
    fn the_last_answer_is_the_newest_counted_one_of_three_epochs() {
        let (storage, _dir) = temp_storage();
        let node = "light_mobile_0123456789abcdef";
        assert_eq!(last_counted_answer_at(&storage, node, 152 * E + 5), None);
        storage.save_light_epoch_eligible(149, node, 1_790_000_000).unwrap();
        assert_eq!(last_counted_answer_at(&storage, node, 152 * E + 5), None, "three epochs back is out of the window");
        storage.save_light_epoch_eligible(150, node, 1_790_010_000).unwrap();
        assert_eq!(last_counted_answer_at(&storage, node, 152 * E + 5), Some(1_790_010_000));
        storage.save_light_epoch_eligible(152, node, 1_790_040_000).unwrap();
        assert_eq!(last_counted_answer_at(&storage, node, 152 * E + 5), Some(1_790_040_000), "the newest wins");
    }

    #[test]
    fn the_epoch_pass_indexes_uptime_once_and_only_epochs_it_saw() {
        let (storage, _dir) = temp_storage();
        storage.save_node_registration_at_height_burn("light_mobile_aa", "light", "wa", 70.0, 10, "burnA").unwrap();
        storage.save_node_registration_at_height_burn("light_mobile_bb", "light", "wb", 70.0, 11, "burnB").unwrap();
        let idx = |n: &str| -> usize {
            let mut out = None;
            storage.light_roster_for_each(u64::MAX, |id, _, i| if id == n { out = Some(i as usize) }).unwrap();
            out.expect("in roster")
        };
        let (a, b) = (idx("light_mobile_aa"), idx("light_mobile_bb"));
        let shard_a = crate::node::light_shard_of("light_mobile_aa");
        let shard_b = crate::node::light_shard_of("light_mobile_bb");
        // Epoch 3: only A counted. Its bitmap row is written for A's shard, and an empty one for B's.
        let mut bm_a = vec![0u8; 8];
        bm_a[a / 8] |= 1 << (a % 8);
        storage.save_light_bitmap(3, shard_a, 3 * E + 14_300, &bm_a).unwrap();
        if shard_b != shard_a { storage.save_light_bitmap(3, shard_b, 3 * E + 14_300, &vec![0u8; 8]).unwrap(); }
        // Epoch 5 has no bitmap here: never marked.
        let cutoff = |e: u64| crate::node::light_roster_cutoff(e);
        assert_eq!(storage.snapshot_light_eligible(3, cutoff(3)).unwrap(), 1);
        assert_eq!(storage.snapshot_light_eligible(5, cutoff(5)).unwrap(), 0);
        assert!(storage.light_uptime_derived(3) && !storage.light_uptime_derived(5));
        assert_eq!(storage.light_uptime("light_mobile_aa"), up(3, 1));
        assert_eq!(storage.light_uptime("light_mobile_bb"), None);
        assert_eq!(storage.light_uptime_done_mask(5), 0b100, "epoch 3 seen from 5");
        // Running the pass again (the boot re-run) marks nothing twice; the uptime-only pass is a no-op.
        storage.snapshot_light_eligible(3, cutoff(3)).unwrap();
        storage.snapshot_light_uptime(3, cutoff(3)).unwrap();
        assert_eq!(storage.light_uptime("light_mobile_aa"), up(3, 1));
        // Epoch 4: both counted, through the uptime-only pass (recency rows already derived earlier).
        let mut bm4a = vec![0u8; 8];
        bm4a[a / 8] |= 1 << (a % 8);
        let mut bm4b = if shard_b == shard_a { bm4a.clone() } else { vec![0u8; 8] };
        bm4b[b / 8] |= 1 << (b % 8);
        if shard_b == shard_a {
            storage.save_light_bitmap(4, shard_a, 4 * E + 14_300, &bm4b).unwrap();
        } else {
            storage.save_light_bitmap(4, shard_a, 4 * E + 14_300, &bm4a).unwrap();
            storage.save_light_bitmap(4, shard_b, 4 * E + 14_300, &bm4b).unwrap();
        }
        assert_eq!(storage.snapshot_light_uptime(4, cutoff(4)).unwrap(), 2);
        assert!(!storage.light_elig_derived(4), "the uptime-only pass writes no recency rows");
        assert_eq!(storage.light_uptime("light_mobile_aa"), up(4, 0b11));
        assert_eq!(storage.light_uptime("light_mobile_bb"), up(4, 1));
        assert_eq!(storage.light_uptime_done_mask(5), 0b110);
        // Seen from epoch 6 (height in epoch 6, so 5 is the last finished; 5 was not indexed here).
        let c = counted_view(Some(10), 6 * E + 1, storage.light_uptime("light_mobile_aa"), storage.light_uptime_done_mask(5));
        assert_eq!(c, Counted { epochs_since_registration: 2, counted: 2, last_counted_epoch: Some(4) });
        let c = counted_view(Some(11), 6 * E + 1, storage.light_uptime("light_mobile_bb"), storage.light_uptime_done_mask(5));
        assert_eq!(c, Counted { epochs_since_registration: 2, counted: 1, last_counted_epoch: Some(4) });
        assert_eq!(storage.node_registration_record("light_mobile_aa"), (Some(10), Some("burnA".to_string())));
        assert_eq!(storage.node_registration_record("light_mobile_none"), (None, None));
    }

    /// F8: an epoch in which the node's shard committed no row is the network's miss: in neither number of `counted`,
    /// never the dormant rule's, named `not_committed`, and no reason to call the node in need of reactivation.
    #[test]
    fn an_epoch_whose_shard_committed_no_row_is_never_the_devices() {
        let (storage, _dir) = temp_storage();
        let node = "light_mobile_f8_0000";
        storage.save_node_registration_at_height_burn(node, "light", "w8", 70.0, 10, "b8").unwrap();
        let mut idx = 0usize;
        storage.light_roster_for_each(u64::MAX, |id, _, i| if id == node { idx = i as usize }).unwrap();
        let shard = crate::node::light_shard_of(node);
        let other = (shard + 1) % 5;
        let mut bm = vec![0u8; 8];
        bm[idx / 8] |= 1 << (idx % 8);
        // Epoch 3: its shard committed a row with the node. Epoch 4: only another shard committed.
        storage.save_light_bitmap(3, shard, 3 * E + 14_300, &bm).unwrap();
        storage.save_light_bitmap(4, other, 4 * E + 14_300, &vec![0u8; 8]).unwrap();
        let cutoff = |e: u64| crate::node::light_roster_cutoff(e);
        storage.snapshot_light_eligible(3, cutoff(3)).unwrap();
        storage.snapshot_light_eligible(4, cutoff(4)).unwrap();
        assert_eq!(storage.light_elig_shards(3), Some(1u8 << shard));
        assert_eq!(storage.light_elig_shards(4), Some(1u8 << other));
        assert_eq!(storage.light_elig_shards(5), None, "not derived here");
        let (done, committed) = storage.light_uptime_done_masks(4, shard);
        assert_eq!((done, committed), (0b11, 0b10), "both indexed, only epoch 3 committed for its shard");
        assert_eq!(storage.light_uptime_done_masks(4, other), (0b11, 0b01));
        let cur = 5 * E + 1;
        let c = counted_view(Some(10), cur, storage.light_uptime(node), done & committed);
        assert_eq!(c, Counted { epochs_since_registration: 1, counted: 1, last_counted_epoch: Some(3) }, "epoch 4 is in neither number");
        let m = not_committed_miss(Some(10), cur, done, committed).expect("epoch 4 not committed");
        assert_eq!((m.epoch, m.reason, m.to_json()["reason"].clone()), (4, MissReason::NotCommitted, json!("not_committed")));
        assert_eq!(not_committed_miss(Some(10), 4 * E + 1, 0b1, 0b1), None, "committed");
        assert_eq!(not_committed_miss(Some(10), cur, 0b10, 0b00), None, "not indexed here: says nothing");
        assert_eq!(not_committed_miss(Some(5 * E), cur, done, committed), None, "registered after it");
        assert_eq!(dormant_miss(Some(10), cur, None, done & committed), None, "an uncommitted epoch never makes a node dormant");
        // It outranks every other reason of its epoch; a later epoch's record still wins.
        let stored = |e: u64, r: MissReason| LightMiss { epoch: e, reason: r, woken_at: None, answered_at: None, delivery_delay_secs: None,
                                                        refused: None, recorded_at: 1, delivered_at: None, app_outcome: None, by_push: false };
        assert_eq!(shown_miss(Some(stored(4, MissReason::AnsweredLate)), Some(m.clone())).map(|x| x.reason), Some(MissReason::NotCommitted));
        assert_eq!(shown_miss(Some(stored(5, MissReason::NotSent)), Some(m)).map(|x| x.reason), Some(MissReason::NotSent));
        // The recency verdict: an epoch not derived, or one the shard committed nothing in, is neutral.
        assert!(recent_neutral([Some(1u8 << other), Some(1u8 << shard)], shard));
        assert!(recent_neutral([None, Some(0b1_1111)], shard));
        assert!(!recent_neutral([Some(1u8 << shard), Some(0b1_1111)], shard));
        // The status reads all of it.
        let src = include_str!("light_status.rs");
        let body = &src[src.find("pub(crate) async fn light_status(").unwrap()..src.find("pub(crate) fn public_json(s: &LightStatus").unwrap()];
        assert!(body.contains("storage.light_uptime_done_masks(end, shard)") && body.contains("let done = done_raw & committed;"));
        assert!(body.contains("recent_neutral(recent_shards, shard)") && body.contains("not_committed_miss(registered_height, cur_height, done_raw, committed)"));
        assert!(body.contains("proven_dormant(&storage, &REACH_CACHE"), "the dormant miss only as the pusher proves it");
        assert!(body.contains("shard_owners_view(node_id)"), "every other owner is asked");
    }

    #[test]
    fn the_boot_backfill_indexes_the_window_it_holds_bitmaps_for_once() {
        let (storage, _dir) = temp_storage();
        storage.save_node_registration_at_height_burn("light_mobile_cc", "light", "wc", 70.0, 10, "burnC").unwrap();
        let mut idx = 0usize;
        storage.light_roster_for_each(u64::MAX, |id, _, i| if id == "light_mobile_cc" { idx = i as usize }).unwrap();
        let shard = crate::node::light_shard_of("light_mobile_cc");
        let mut bm = vec![0u8; 8];
        bm[idx / 8] |= 1 << (idx % 8);
        // Counted in epochs 2 and 4; epoch 3's blocks never reached this node (no bitmap at all).
        storage.save_light_bitmap(2, shard, 2 * E + 14_300, &bm).unwrap();
        storage.save_light_bitmap(4, shard, 4 * E + 14_300, &bm).unwrap();
        let h = 6 * E; // epoch 5 finished: the window here is epochs 0..=5
        assert_eq!(crate::node::BlockchainNode::backfill_light_uptime(&storage, h), 2);
        assert_eq!(crate::node::BlockchainNode::backfill_light_uptime(&storage, h), 0, "an indexed epoch is not walked again");
        assert_eq!(storage.light_uptime("light_mobile_cc"), up(4, 0b101));
        let c = counted_view(Some(10), h, storage.light_uptime("light_mobile_cc"), storage.light_uptime_done_mask(5));
        assert_eq!(c, Counted { epochs_since_registration: 2, counted: 2, last_counted_epoch: Some(4) },
                   "epochs with no bitmap here are in neither count");
        assert_eq!(crate::node::BlockchainNode::backfill_light_uptime(&storage, E - 1), 0, "nothing finished yet");
    }

    struct Keys { pk: d3::PublicKey, sk: d3::SecretKey, pk_hex: String }
    fn keys() -> Keys {
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        Keys { pk, sk, pk_hex }
    }
    fn sign(k: &Keys, msg: &str) -> String {
        hex::encode(d3::detached_sign(msg.as_bytes(), &k.sk).as_bytes())
    }

    #[test]
    fn a_signed_status_is_read_only_by_the_nodes_own_keys() {
        let (storage, _dir) = temp_storage();
        let wallet = keys();
        let w = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&wallet.pk_hex).expect("eon");
        let node = crate::rpc::generate_light_node_pseudonym(&w);
        let now = 1_800_000_000u64;
        let req = |signer: &str, sig: String, ts: u64, k: Option<String>| SignedStatusRequest {
            node_id: node.clone(), ts, signer: signer.into(), sig, identity_pubkey: k, nonce: None,
        };
        let msg = lb::light_status_message(&node, now);
        // Not on chain yet.
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, Some(wallet.pk_hex.clone())), now),
                   Err(Refusal::NotRegistered));
        // Registered with the commitment of K.
        storage.save_node_registration_at_height_burn_vrf(&node, "light", &w, 70.0, 100, "burnW", Some(wallet.pk.as_bytes())).unwrap();
        // The wallet form: K presented (nothing recorded yet), or recorded by a binding.
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, Some(wallet.pk_hex.clone())), now), Ok(()));
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, None), now),
                   Err(Refusal::IdentityMismatch), "no key recorded and none presented");
        let other = keys();
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&other, &msg), now, Some(other.pk_hex.clone())), now),
                   Err(Refusal::IdentityMismatch), "a key the chain does not vouch for");
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&other, &msg), now, Some(wallet.pk_hex.clone())), now),
                   Err(Refusal::BadSignature));
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, Some(wallet.pk_hex.clone())), now + 301),
                   Err(Refusal::Expired));
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, Some(wallet.pk_hex.clone())), now + 300),
                   Ok(()), "within the five minutes");
        // The ping form: nothing bound yet, so no ping key is this node's.
        let ping = keys();
        assert_eq!(check_signed_status(&storage, &req("ping", sign(&ping, &msg), now, None), now), Err(Refusal::BadSignature));
        // Bound: the stored ping key reads it, another device's does not.
        let seq = now - 60;
        let cert = sign(&wallet, &lb::delegation_v2_message(&ping.pk_hex, &node, seq));
        storage.bind_light_v2(&node, &ping.pk_hex, &cert, &wallet.pk_hex, seq, now).unwrap().unwrap();
        assert_eq!(check_signed_status(&storage, &req("ping", sign(&ping, &msg), now, None), now), Ok(()));
        let old_phone = keys();
        assert_eq!(check_signed_status(&storage, &req("ping", sign(&old_phone, &msg), now, None), now), Err(Refusal::BadSignature));
        // The wallet key is now recorded by the binding, so it need not be presented.
        assert_eq!(check_signed_status(&storage, &req("wallet", sign(&wallet, &msg), now, None), now), Ok(()));
        // Malformed.
        assert_eq!(check_signed_status(&storage, &req("device", sign(&ping, &msg), now, None), now), Err(Refusal::BadRequest));
        assert_eq!(check_signed_status(&storage, &req("ping", "ab".into(), now, None), now), Err(Refusal::BadRequest));
        // Signed over another node or another time: refused.
        let other_ts = lb::light_status_message(&node, now - 1);
        assert_eq!(check_signed_status(&storage, &req("ping", sign(&ping, &other_ts), now, None), now), Err(Refusal::BadSignature));
    }
}

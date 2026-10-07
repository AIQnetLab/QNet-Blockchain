//! Pushes to a light node's device (U12, U13) and "I'm back" (U11). One payload on every platform, naming
//! no node; pushes only to an on-chain node with a device bound to it: a round of up to three pushes a
//! quarter of an hour apart from its drawn slot and one retry round an hour later, each only while the node
//! has not answered this epoch, every push living only until its epoch's commit; a wake capped per node and
//! held to a tenth of the push budget. Every push and every answer belongs to its own epoch: nothing is moved to the next.
//! What each node got is kept for the epoch and its miss recorded at the commit, refined by the receipts the
//! device sends with a later answer; with the node's last answer it is one row per node (`LightPushRow`, the
//! status's `device.last_miss` and `device.last_answer`). Push policy of the genesis nodes; no block rule
//! reads any of it.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` sections 4, 5.8, 5.10 and 7.

use super::*;

const EPOCH_BLOCKS: u64 = 14_400;
const SLOTS_PER_EPOCH: u64 = 240;

/// Pushes one genesis sends per second, wakes included. At ten million light nodes a genesis pushes its
/// fifth (two million): first pushes come at about 240 a second over the epoch's first 138 slots, and the
/// repeats and retry pushes to the nodes that have not answered keep the whole under the epoch's share even
/// at answer rates well below the measured ones (`the_push_load_at_ten_million_stays_under_the_budget`);
/// first pushes still fit while a genesis covers all three of its shards. Five of them together stay far
/// below the provider's project quota.
pub(crate) const FCM_PUSHES_PER_SEC: u64 = 1000;
/// The share of that budget "I'm back" may take.
pub(crate) const WAKE_PUSHES_PER_SEC: u64 = FCM_PUSHES_PER_SEC / 10;
/// The rest, paced evenly, for the epoch's pushes of one shard (`EPOCH_PACER`).
pub(crate) const EPOCH_PUSHES_PER_SEC: u64 = FCM_PUSHES_PER_SEC - WAKE_PUSHES_PER_SEC;
/// Most shards one genesis pushes: its own and the two it backs up.
pub(crate) const MAX_COVERED_SHARDS: u64 = 3;
/// The most one genesis sends a second: three shards' share and the wakes. A genesis covering a shard paces at its
/// share more (`epoch_push_rate`), so a takeover sheds nothing; each shard has one pushing owner at a time (two only
/// for the minutes of a hand-back), so the five together stay at five shares, far below the provider's quota.
pub(crate) const PUSH_QUOTA_PER_SEC: u64 = MAX_COVERED_SHARDS * EPOCH_PUSHES_PER_SEC + WAKE_PUSHES_PER_SEC;

/// The epoch pushes' pace while covering `covered` shards: one shard's share each.
pub(crate) fn epoch_push_rate(covered: usize) -> u64 {
    EPOCH_PUSHES_PER_SEC * (covered as u64).clamp(1, MAX_COVERED_SHARDS)
}
/// One collapse key for every push: a later push replaces an undelivered one on the device.
pub(crate) const PUSH_COLLAPSE_KEY: &str = "epoch";
/// The least a push may live: closer to its epoch's commit than this, none goes out, as its answer would most
/// likely come after the commit and count for nothing. Only a wake or a tick catching up after a stall comes this
/// close: the schedule's last push leaves minutes before (`every_push_repeat_and_retry_leaves_before_the_commit`).
pub(crate) const PUSH_MIN_LIFETIME_SECS: u64 = 60;
/// Pushes of one round at most: the drawn slot's and two repeats ROUND_SPACING_SLOTS apart.
pub(crate) const ROUND_PUSHES: u64 = 3;
/// Slots between two pushes of a round: a quarter of an hour. Repeats a slot apart went out before the device could
/// answer the first (a phone took pushes in three slots in a row and answered nine slots later), so they only added
/// traffic, the provider's quota and iOS background pushes; a repeat a quarter of an hour on finds a device that missed.
pub(crate) const ROUND_SPACING_SLOTS: u64 = 15;
/// Slots after its due slot a push may still go out in, once: when it found no instant in its slot (`SendOutcome::Unsent`)
/// or a short stall missed its tick (the grace read, `ping_buckets_to_read`).
pub(crate) const DUE_GRACE_SLOTS: u64 = 2;
/// The first push is drawn over the epoch's first 138 slots: a push drawn in the second half was missed half as often
/// again as one in the first, and the rounds need the room after it. The retry round's last repeat is then due in slot
/// 137 + 60 + 30 = 227 at the latest, and its grace ends in slot 229, minutes before the commit.
pub(crate) const FIRST_PUSH_SLOTS: u64 = 138;
/// The draw of the rounds of three pushes a slot apart that came before: the first 168 slots, kept for the rest of the
/// window a genesis switches to the spaced rounds in (`spaced_rounds_from`).
pub(crate) const UNSPACED_FIRST_PUSH_SLOTS: u64 = 168;
/// The one retry round starts this many slots (an hour) after the drawn slot, for a node still silent.
pub(crate) const RETRY_AFTER_SLOTS: u64 = 60;
/// Most pushes a node gets at one owner rank in an epoch: its round and the retry round.
pub(crate) const MAX_PUSHES_PER_EPOCH: u8 = 2 * ROUND_PUSHES as u8;

/// The fewest slots between two pushes to one node with the spaced rounds: a due point's push leaves within its grace,
/// so the next one comes at least this much later, and a push a stall's catch-up made late meets the next due point when
/// that one is nearer, instead of being repeated a slot or two after it.
pub(crate) const MIN_PUSH_GAP_SLOTS: u64 = ROUND_SPACING_SLOTS - DUE_GRACE_SLOTS;

/// One due point of a node's epoch, as a tick reads it (`PushLedger::may_push`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Due {
    /// A push or challenge that went out in this absolute slot (epoch * 240 + slot) or after it meets the due point.
    pub(crate) met_from: u64,
    /// A repeat of a push of its round: due only to a node this genesis offered a push in the epoch, unless the round
    /// began before this genesis held the node's shard (`round`).
    pub(crate) repeat: bool,
    /// The absolute slot the first push of its round is due in.
    pub(crate) round: u64,
}

impl Due {
    /// Due in `slot` alone: before the spaced rounds each slot of a round was a due point of its own.
    pub(crate) fn once(slot: u64) -> Due {
        Due { met_from: slot, repeat: false, round: slot }
    }

    /// A due point of the spaced rounds in `slot`, `into_round` slots after its round's first push (0 for that push):
    /// met by any push from MIN_PUSH_GAP_SLOTS - 1 slots before it, which reaches no earlier due point's grace.
    pub(crate) fn spaced(slot: u64, into_round: u64) -> Due {
        Due { met_from: slot.saturating_sub(MIN_PUSH_GAP_SLOTS - 1), repeat: into_round > 0, round: slot.saturating_sub(into_round) }
    }
}

/// The due points of a spaced epoch as offsets from the drawn slot, earliest first, each with how far into its round it
/// falls (0 for a round's first push, else a repeat): the round (0, 15, 30) and the retry round (60, 75, 90). The round's
/// first push and the retry round's are due to every node not counted, so the retry round survives a restart of this
/// genesis; the repeats to a node offered a push here, or one whose round began before this genesis held its shard.
pub(crate) fn spaced_due_offsets() -> impl Iterator<Item = (u64, u64)> {
    [0, RETRY_AFTER_SLOTS].into_iter()
        .flat_map(|start| (0..ROUND_PUSHES).map(move |i| (start + i * ROUND_SPACING_SLOTS, i * ROUND_SPACING_SLOTS)))
}

/// Where this genesis keeps the window its early first-push draw starts at (node-local).
const FIRST_PUSH_DRAW_KEY: &str = "light_first_push_draw_window";
/// Where it keeps the window its spaced rounds start at (node-local).
const SPACED_ROUNDS_KEY: &str = "light_spaced_rounds_window";

/// The window the early first-push draw starts at on this genesis (P-1): the one its first ping stored, else, once
/// `live` names the epoch the network stands behind, the window after it, stored now; None before that. Kept, so a
/// restart mid-window draws the live window as it began: drawn again, a node whose new slot had passed while its old one
/// had not came got no push that epoch. Never stored from a tip behind the network: a genesis back from a long stop
/// would store a window it is already past, and draw the live epoch anew though it pushed part of it before.
pub(crate) fn first_push_draw_from(storage: &crate::storage::Storage, live: Option<u64>) -> Option<u64> {
    stored_switch_window(storage, FIRST_PUSH_DRAW_KEY, live)
}

/// The window the spaced rounds and their draw over FIRST_PUSH_SLOTS start at on this genesis: the one its first ping on
/// a release with them stored, else the window after `live`, stored now (None while the epoch the network stands behind
/// is not known). Kept like the early draw's, so a restart mid-window keeps the live window's draw and rounds as the
/// window began; the window the release lands in runs the old schedule to its end (`ping_draw_slots`).
pub(crate) fn spaced_rounds_from(storage: &crate::storage::Storage, live: Option<u64>) -> Option<u64> {
    stored_switch_window(storage, SPACED_ROUNDS_KEY, live)
}

/// The window kept under `key`, else the window after `live`, stored now.
fn stored_switch_window(storage: &crate::storage::Storage, key: &str, live: Option<u64>) -> Option<u64> {
    if let Some(w) = storage.load_raw(key).ok().flatten()
        .and_then(|v| <[u8; 8]>::try_from(v.as_slice()).ok()).map(u64::from_be_bytes) {
        return Some(w);
    }
    let from = live?.saturating_add(1);
    if let Err(e) = storage.save_raw(key, &from.to_be_bytes()) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] push_schedule_store_failed key={} from={} err={}", key, from, e);
        }
    }
    Some(from)
}

/// Where this genesis keeps the last slot its push tick read and since when it read every due point of its own shard
/// in that window (node-local, `push_read_mark`).
const PUSH_READ_MARK_KEY: &str = "light_push_read_mark";

/// The last absolute slot this genesis's push tick read before a restart, and the absolute slot from which it had read
/// every due point of its own shard in that window (`unified_p2p::ShardReads`). A restart whose first tick joins that
/// read sends no due point the run before it read again (its ledger is gone), and keeps whether the shard is also read
/// under another owner's draw.
pub(crate) fn push_read_mark(storage: &crate::storage::Storage) -> Option<(u64, u64)> {
    let v = storage.load_raw(PUSH_READ_MARK_KEY).ok().flatten()?;
    let b = <[u8; 16]>::try_from(v.as_slice()).ok()?;
    Some((u64::from_be_bytes(b[..8].try_into().ok()?), u64::from_be_bytes(b[8..].try_into().ok()?)))
}

/// Keep the slot a push tick read and its own shard's first due slot read since (`push_read_mark`), once a tick.
pub(crate) fn keep_push_read_mark(storage: &crate::storage::Storage, last: u64, read_from: u64) {
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&last.to_be_bytes());
    b[8..].copy_from_slice(&read_from.to_be_bytes());
    if let Err(e) = storage.save_raw(PUSH_READ_MARK_KEY, &b) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] push_read_mark_store_failed slot={} err={}", last, e);
        }
    }
}

/// The height at which `epoch`'s light commit window opens (`light_commit_window`): the shard's bitmap is
/// built from then on, so an answer to that epoch's challenge after it counts for nothing.
pub(crate) fn commit_opens_at(epoch: u64) -> u64 {
    epoch.saturating_mul(EPOCH_BLOCKS) + EPOCH_BLOCKS - crate::node::light_commit_window(epoch)
}

/// How long a push for `epoch` sent at `tip` lives: until that epoch's commit opens, at one block a second,
/// never longer (a block is never stamped ahead of the wall clock, so the blocks left are at most the seconds
/// left). None once the tip left the epoch, at or after the commit, or with less than PUSH_MIN_LIFETIME_SECS
/// left: no push goes out then, and the next epoch gets its own.
pub(crate) fn push_lifetime(epoch: u64, tip: u64) -> Option<u64> {
    if tip / EPOCH_BLOCKS != epoch { return None; }
    let left = commit_opens_at(epoch).checked_sub(tip)?;
    (left >= PUSH_MIN_LIFETIME_SECS).then_some(left)
}

/// The tip lies between its epoch's commit and the epoch's end: an answer now counts in no epoch (B-2).
pub(crate) fn in_commit_gap(tip: u64) -> bool {
    tip >= commit_opens_at(tip / EPOCH_BLOCKS)
}

/// The answer to a reply that came inside the gap (`in_commit_gap`): the epoch's commit is closed and the reply
/// counts for nothing. It names no later epoch: nothing is moved there, and that epoch is answered by its own pushes
/// and the app's own answers in it.
pub(crate) fn gap_reply(node_id: &str) -> Value {
    json!({
        "success": false,
        "node_id": node_id,
        "counted": false,
        "reason": "epoch_closed",
        "error": "The epoch's commit is closed: this answer counts for nothing",
    })
}

// ── M-6: the answer route and /height under overload ──

/// The least and the most a shed request is asked to wait (`shed_retry_after`).
pub(crate) const SHED_RETRY_MIN_SECS: u64 = 60;
pub(crate) const SHED_RETRY_MAX_SECS: u64 = 300;
/// What an answer retried after the wait still needs before its epoch's commit: a slot, for the client's own round
/// trips to the owners.
pub(crate) const SHED_DEADLINE_MARGIN_SECS: u64 = 60;

/// How long a request shed at `tip` is asked to wait (`Retry-After`), `draw` a random number. Spread over
/// SHED_RETRY_MIN_SECS to SHED_RETRY_MAX_SECS, so shed clients come back apart, and never past the current epoch's commit
/// less SHED_DEADLINE_MARGIN_SECS (at one block a second), so an answer retried then still lands in its own epoch. With
/// less than the least left before that point, spread over what is left; with nothing left (the margin and the commit
/// window), past the epoch's end, by up to SHED_RETRY_MIN_SECS, when the next epoch's answers begin.
pub(crate) fn shed_retry_after(tip: u64, draw: u64) -> u64 {
    let spread = |lo: u64, hi: u64| lo + draw % (hi - lo + 1);
    let epoch = tip / EPOCH_BLOCKS;
    let left = commit_opens_at(epoch).saturating_sub(tip).saturating_sub(SHED_DEADLINE_MARGIN_SECS);
    if left >= SHED_RETRY_MIN_SECS {
        spread(SHED_RETRY_MIN_SECS, left.min(SHED_RETRY_MAX_SECS))
    } else if left > 0 {
        spread(left.min(10), left)
    } else {
        (epoch + 1) * EPOCH_BLOCKS - tip + spread(0, SHED_RETRY_MIN_SECS)
    }
}

/// A node-wide bound on one route's work (M-6): requests in flight at once, and requests in one second. Checked before
/// any storage read or signature check, after the per-address limit, so one address's flood is refused by its own limit
/// and spends none of it.
pub(crate) struct LoadBudget {
    max_in_flight: u64,
    per_sec: u64,
    in_flight: std::sync::atomic::AtomicU64,
    /// The Unix second `count` is of.
    second: std::sync::atomic::AtomicU64,
    count: std::sync::atomic::AtomicU64,
}

/// One request inside a `LoadBudget`; it leaves the in-flight count when dropped.
pub(crate) struct LoadPermit<'a>(&'a LoadBudget);

impl Drop for LoadPermit<'_> {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

impl LoadBudget {
    pub(crate) const fn new(max_in_flight: u64, per_sec: u64) -> Self {
        use std::sync::atomic::AtomicU64;
        LoadBudget { max_in_flight, per_sec, in_flight: AtomicU64::new(0), second: AtomicU64::new(0), count: AtomicU64::new(0) }
    }

    /// A permit while the route is under both bounds at `now` (Unix seconds); None past either.
    pub(crate) fn enter(&self, now: u64) -> Option<LoadPermit<'_>> {
        use std::sync::atomic::Ordering::Relaxed;
        let s = self.second.load(Relaxed);
        if s != now && self.second.compare_exchange(s, now, Relaxed, Relaxed).is_ok() {
            self.count.store(0, Relaxed);
        }
        if self.count.fetch_add(1, Relaxed) >= self.per_sec { return None; }
        if self.in_flight.fetch_add(1, Relaxed) >= self.max_in_flight {
            self.in_flight.fetch_sub(1, Relaxed);
            return None;
        }
        Some(LoadPermit(self))
    }
}

/// The answer route's budget: twice the most pushes one genesis sends a second (PUSH_QUOTA_PER_SEC), as every
/// push asks one answer and the app answers on its own too.
pub(crate) static PING_ANSWER_BUDGET: LoadBudget = LoadBudget::new(512, 2 * PUSH_QUOTA_PER_SEC);
/// `/height`'s: the app reads it before each answer, and peers and pages read it too.
pub(crate) static HEIGHT_READ_BUDGET: LoadBudget = LoadBudget::new(1024, 4 * PUSH_QUOTA_PER_SEC);

/// A caller no budget holds back: an unknown address (as the per-address limit treats it), a whitelisted one
/// (`is_ip_whitelisted`) and another genesis.
fn budget_exempt(remote: Option<std::net::SocketAddr>) -> bool {
    remote.map_or(true, |a| is_ip_whitelisted(a.ip()) || is_genesis_peer_ip(&a.ip().to_string()))
}

/// The 503 a request past `budget` gets, None while it is inside (then `permit` holds it there): `Retry-After` and
/// `retry_after_seconds` from `shed_retry_after` at this node's tip. Reads no storage.
pub(crate) fn shed_past<'a>(budget: &'a LoadBudget, remote: Option<std::net::SocketAddr>, permit: &mut Option<LoadPermit<'a>>)
    -> Option<warp::reply::Response>
{
    if budget_exempt(remote) { return None; }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    *permit = budget.enter(now);
    if permit.is_some() { return None; }
    let tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
    Some(shed_reply(shed_retry_after(tip, rand::random::<u64>())))
}

/// The overload answer: HTTP 503 with `Retry-After` and the same wait in the body.
pub(crate) fn shed_reply(retry_after: u64) -> warp::reply::Response {
    let body = json!({
        "success": false,
        "reason": "overloaded",
        "error": "The node is busy; try again later",
        "retry_after_seconds": retry_after,
    });
    warp::reply::with_status(
        warp::reply::with_header(warp::reply::json(&body), "Retry-After", retry_after.to_string()),
        warp::http::StatusCode::SERVICE_UNAVAILABLE,
    ).into_response()
}

/// Wakes one node may get per epoch, and the least time between two (unified plan R8). The wake is
/// unsigned, so a stranger's wake counts too: three per epoch, ten minutes apart, leave the owner an "I'm
/// back" of their own unless a stranger keeps spending them every ten minutes.
pub(crate) const WAKES_PER_NODE_PER_EPOCH: u32 = 3;
pub(crate) const WAKE_NODE_COOLDOWN_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushAction {
    /// The epoch's push: answer if not yet answered.
    Epoch,
    /// "I'm back" from the web: answer now.
    Wake,
}

impl PushAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self { PushAction::Epoch => "epoch", PushAction::Wake => "wake" }
    }
}

/// The block a device answers with (`selfattest:{h}:{hash}`): two below this node's tip, so every genesis
/// already holds it, and never before the current epoch's first block, the only one an answer counts in.
pub(crate) fn push_anchor(storage: &crate::storage::Storage, tip: u64) -> Option<String> {
    let h = tip.saturating_sub(2).max(tip - tip % EPOCH_BLOCKS);
    let hash = storage.get_microblock_hash_hex(h).ok().flatten()?;
    Some(format!("{}:{}", h, hash))
}

/// The data of every push on every platform: what to do, the block to answer with and when this genesis sent
/// it (Unix seconds, its clock; the provider takes string values only). The device knows which node it runs, so
/// nothing names the node. `sent_at` comes back with the answer (`AnswerTiming`).
pub(crate) fn push_data(action: PushAction, anchor: &str, sent_at: u64) -> Value {
    json!({ "action": action.as_str(), "anchor": anchor, "sent_at": sent_at.to_string() })
}

/// The provider message for one device token: data only, collapsed, living `ttl` seconds (`push_lifetime`). On
/// Android high priority: a normal-priority data message is held while the device sleeps and does not start the
/// app, so answers came late or not at all. On iOS the background form (push type background, priority 5,
/// content-available only), the one a data-only update may take; the system discards it for an app the user swiped
/// away.
pub(crate) fn fcm_message(token: &str, action: PushAction, anchor: &str, now: u64, ttl: u64) -> Value {
    json!({
        "message": {
            "token": token,
            "data": push_data(action, anchor, now),
            "android": {
                "collapse_key": PUSH_COLLAPSE_KEY,
                "ttl": format!("{}s", ttl),
                "priority": "high"
            },
            "apns": {
                "headers": {
                    "apns-push-type": "background",
                    "apns-priority": "5",
                    "apns-collapse-id": PUSH_COLLAPSE_KEY,
                    "apns-expiration": now.saturating_add(ttl).to_string()
                },
                "payload": { "aps": { "content-available": 1 } }
            }
        }
    })
}

/// Where a push to a node's device goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PushChannel {
    Fcm(String),
    UnifiedPush(String),
}

impl PushChannel {
    pub(crate) fn name(&self) -> &'static str {
        match self { PushChannel::Fcm(_) => "fcm", PushChannel::UnifiedPush(_) => "unifiedpush" }
    }

    /// The provider whose credentials this genesis holds: its refusals are this genesis's own (`PushHealth`). A push
    /// server endpoint is the device owner's choice, any host, so its refusals are that host's or the device's: one
    /// dead endpoint would silence every owner that pushes it.
    pub(crate) fn is_provider(&self) -> bool {
        matches!(self, PushChannel::Fcm(_))
    }
}

/// The node's pushable channel: a token or an endpoint from its push record, and only from a record that
/// belongs to the device linked here (`device_reach`). A record left by a replaced device, one for a
/// binding that has not reached this genesis, one written under another wallet key, a polling device's
/// and an empty one give none: the device is woken by a stamped challenge for its next poll, and the
/// record is pulled again from the genesis that serves the device (`push_record_degraded`).
pub(crate) fn push_channel(storage: &crate::storage::Storage, node_id: &str) -> Option<PushChannel> {
    device_reach(storage, node_id).flatten()
}

/// How this genesis reaches a node's device: None when no device is linked here, else the channel to push
/// on (None: a stamped challenge). One reading for the pinger, the wake, the heal and the poll:
/// - a binding row the chain vouches for (`binding_vouched`) links its device, pushed on a record that
///   belongs to it (`BindingRow::owns_record`); a withdrawn binding links nothing, whatever record is left;
/// - with no such row here, an installed app's legacy record links its device when the chain vouches for
///   the key it was written under (`Storage::unbound_record_writer_ok`). A record someone planted before
///   the registration applied carries its own key and links nothing. Writes follow the same rule
///   (`Storage::save_fcm_token_by`).
pub(crate) fn device_reach(storage: &crate::storage::Storage, node_id: &str) -> Option<Option<PushChannel>> {
    reach_with(storage, node_id, storage.light_binding_reach(node_id).as_ref())
}

/// `device_reach` with the node's binding row already read (`Storage::light_binding_reach`).
fn reach_with(storage: &crate::storage::Storage, node_id: &str, binding: Option<&crate::light_binding::BindingReach>)
    -> Option<Option<PushChannel>>
{
    let record = storage.get_fcm_entry(node_id);
    if let Some(row) = binding {
        if !row.never_v2() && !row.device_bound() { return None; }
        if row.device_bound() && storage.light_binding_reach_vouched(node_id, row) {
            return Some(record.filter(|e| row.owns_record(e.seq, &e.writer)).and_then(|e| record_target(&e)));
        }
    }
    let e = record.filter(|e| e.seq == 0)?;
    if !storage.unbound_record_writer_ok(node_id, &e.writer) { return None; }
    record_target(&e).map(Some)
}

/// A record's push target. A UnifiedPush endpoint counts only while it passes the check every write path
/// runs, so one stored before a path ran it is never delivered to.
fn record_target(e: &crate::storage::FcmEntry) -> Option<PushChannel> {
    match crate::light_binding::canonical_push_type(Some(e.push_type.to_ascii_lowercase().as_str())) {
        "fcm" if !e.token.is_empty() => Some(PushChannel::Fcm(e.token.clone())),
        "unifiedpush" => e.endpoint.clone().filter(|ep| validate_unified_push_endpoint(ep).is_ok()).map(PushChannel::UnifiedPush),
        _ => None,
    }
}

/// The shard owner's push record needs healing: nothing it holds is a channel of the binding here. A
/// pull brings the serving genesis's record, taken only when it belongs (`apply_pulled_push_record`).
pub(crate) fn push_record_degraded(storage: &crate::storage::Storage, node_id: &str) -> bool {
    push_channel(storage, node_id).is_none()
}

/// The client UnifiedPush deliveries use. It follows no redirect: the endpoint is the device owner's, and
/// a redirect would turn this genesis's POST - which a wake triggers on demand - toward whatever host the
/// endpoint names, this host's own ports included.
fn push_http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build().unwrap_or_default())
}

/// The provider refused a push because the device's token or endpoint no longer exists (FCM
/// `UNREGISTERED` / 404, a push server's 404 or 410), as opposed to a transient or quota failure.
pub(crate) fn push_target_gone(err: &str) -> bool {
    err.contains("UNREGISTERED") || err.contains("404 Not Found") || err.contains("410 Gone")
}

/// Send one push living `ttl` seconds; Ok when the provider took it. Neither the token nor the endpoint is logged.
pub(crate) async fn deliver_push(channel: &PushChannel, action: PushAction, anchor: &str, ttl: u64) -> Result<(), String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    match channel {
        PushChannel::Fcm(token) => FCM_SERVICE.send_message(&fcm_message(token, action, anchor, now, ttl)).await,
        PushChannel::UnifiedPush(endpoint) => {
            // Checked again where the POST goes out, whatever path built the channel.
            if validate_unified_push_endpoint(endpoint).is_err() {
                return Err("unifiedpush endpoint refused".to_string());
            }
            // The same delivery options in the push server's own headers.
            let r = push_http().post(endpoint)
                .header("TTL", ttl.to_string())
                .header("Urgency", "high")
                .header("Topic", PUSH_COLLAPSE_KEY)
                .json(&push_data(action, anchor, now))
                .send().await
                .map_err(|e| format!("unifiedpush network error: {}", e.without_url()))?;
            if r.status().is_success() { Ok(()) } else { Err(format!("unifiedpush status {}", r.status())) }
        }
    }
}

// ── U13: whom the pinger pushes, and what each node got this epoch ──

/// What one send was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    /// The provider took the push.
    Accepted,
    /// The provider says the device's token or endpoint no longer exists (`push_target_gone`).
    Gone,
    /// Any other failure.
    Failed,
    /// A challenge left for a device this genesis has no push channel for (`store_polling_challenge`).
    Polled,
    /// Nothing went out: the pacer had no instant left in the slot, or the tick had no anchor. The system's, never
    /// the device's: not one of the epoch's pushes, and no miss of the device (`not_sent`).
    Unsent,
    /// Not pushed: the dormant rule holds (`proven_dormant`). Kept so the node stays dormant until it answers: its
    /// epoch goes into the reach record like a reached one, and the next selection skips it without a read.
    Dormant,
}

/// What this genesis did for one node in one epoch: read at the epoch's commit (`take_epoch`, `PushEntry::miss`)
/// and by the signed status (`gone_in`). Unix seconds; 0 for none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PushEntry {
    pub(crate) epoch: u64,
    /// Pushes and challenges handed out this epoch, one a due point at most.
    pub(crate) sends: u8,
    /// The absolute slot (epoch * 240 + slot) of the last record of any kind.
    pub(crate) last_slot: u64,
    /// The absolute slot of the last push or challenge handed out: none goes out again for a due point it meets
    /// (`Due::met_from`).
    pub(crate) sent_slot: Option<u64>,
    /// When the provider took the first push (an epoch push or a wake).
    pub(crate) woken_at: u64,
    /// The slot the first challenge was left in for a device with no push channel.
    pub(crate) polled_slot: Option<u64>,
    /// When the device fetched a challenge.
    pub(crate) fetched_at: u64,
    pub(crate) gone: bool,
    /// The code of an answer refused in time (`ReplyRefusal::as_str`, or `superseded`), and when it came.
    pub(crate) refused: Option<&'static str>,
    pub(crate) refused_at: u64,
    /// Pushes due that never went out (`SendOutcome::Unsent`).
    pub(crate) unsent: u8,
    /// Held by the dormant rule this epoch (`SendOutcome::Dormant`).
    pub(crate) dormant: bool,
    /// The absolute slot the dormant rule last held it in: like a push, it closes the due points it meets.
    pub(crate) dormant_slot: Option<u64>,
}

impl PushEntry {
    /// The device was reached this epoch: a push the provider took (a wake included), a challenge it fetched, or the
    /// provider saying its token is gone; or the dormant rule held it, so a dormant node stays dormant until it
    /// answers instead of being woken every third epoch. What a reach record keeps (`proven_dormant`).
    pub(crate) fn reached(&self) -> bool {
        self.woken_at > 0 || self.fetched_at > 0 || self.gone || self.dormant
    }

    /// Why a node with this entry was not counted, when it gave no answer before the commit: the answer refused,
    /// else woken (a push taken or a challenge fetched), else nothing to push to, else every push due failed at the
    /// provider or never went out (`not_sent`, the system's miss). `now` is when the miss is recorded.
    pub(crate) fn miss(&self, now: u64) -> Option<LightMiss> {
        let nz = |t: u64| (t > 0).then_some(t);
        let woken = match (nz(self.woken_at), nz(self.fetched_at)) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let reason = if self.refused.is_some() {
            MissReason::AnswerRefused
        } else if woken.is_some() {
            MissReason::WokenNoAnswer
        } else if self.gone || self.polled_slot.is_some() {
            MissReason::NoPushAddress
        } else if self.sends > 0 || self.unsent > 0 {
            MissReason::NotSent
        } else {
            // Nothing went out, or the dormant rule held the node: the status derives `not_woken_inactive` when read,
            // so a node the network stopped waking costs no write an epoch.
            return None;
        };
        Some(LightMiss {
            epoch: self.epoch,
            reason,
            woken_at: woken,
            answered_at: self.refused.and(nz(self.refused_at)),
            delivery_delay_secs: None,
            refused: self.refused.map(str::to_string),
            recorded_at: now,
            delivered_at: None,
            app_outcome: None,
            by_push: self.woken_at > 0 && self.fetched_at == 0,
        })
    }
}

/// The epoch's `PushEntry` per node at this genesis. An entry goes when its node answers (`answered`, `prune`)
/// and at the commit (`take_epoch`), so at most the silent nodes of one epoch are held.
pub(crate) struct PushLedger {
    map: std::sync::OnceLock<DashMap<String, PushEntry>>,
    /// The last epoch the cap was reported in (`LEDGER_CAP`), u64::MAX for none.
    cap_warned: std::sync::atomic::AtomicU64,
}

/// A bound no honest epoch reaches: every node of the three shards one genesis may cover, at two million a shard
/// (ten million nodes over five shards). Past it new nodes go unrecorded (their round's first push and the retry
/// round's still go out, in each slot of their grace; a repeat only in the round after a restart or a takeover), and a
/// WARN says so once an epoch (L-3).
const LEDGER_CAP: usize = MAX_COVERED_SHARDS as usize * 2_000_000;

impl PushLedger {
    pub(crate) const fn new() -> Self {
        PushLedger { map: std::sync::OnceLock::new(), cap_warned: std::sync::atomic::AtomicU64::new(u64::MAX) }
    }

    fn map(&self) -> &DashMap<String, PushEntry> {
        self.map.get_or_init(DashMap::new)
    }

    fn entry(&self, node_id: &str, epoch: u64) -> Option<dashmap::mapref::one::RefMut<'_, String, PushEntry>> {
        let m = self.map();
        if m.len() >= LEDGER_CAP && !m.contains_key(node_id) {
            if self.cap_warned.swap(epoch, std::sync::atomic::Ordering::Relaxed) != epoch && crate::node::is_warn() {
                println!("[WARN][LIGHT] push_ledger_full entries={} cap={} epoch={} action=new_nodes_unrecorded",
                         m.len(), LEDGER_CAP, epoch);
            }
            return None;
        }
        let mut e = m.entry(node_id.to_string()).or_default();
        if e.epoch != epoch { *e = PushEntry { epoch, ..PushEntry::default() }; }
        Some(e)
    }

    /// A push may go out to the node in `abs_slot` (epoch * 240 + slot) for one of `dues`, the due points its tick read
    /// it for: nothing was recorded for it in this slot yet, nothing that meets that due point went out and the dormant
    /// rule did not hold it there (one push or hold a due point: a push shed in its slot is tried in the next slot of its
    /// grace), fewer than MAX_PUSHES_PER_EPOCH went out in the epoch, and a repeat only to a node this genesis offered a
    /// push in the epoch (sent or shed, not answered here, not pruned as counted elsewhere) or whose round began before
    /// `held_from()`, the slot since which this genesis holds the records of the node's shard (its first tick after a
    /// restart, or the tick it took the shard over at): those nodes' first pushes went out from a record it does not
    /// have. A node only woken, refused or held dormant here gets no repeat. A RAM read, made before any storage read;
    /// `held_from` is asked only for a repeat of such a node.
    pub(crate) fn may_push(&self, node_id: &str, abs_slot: u64, dues: &[Due], held_from: impl Fn() -> u64) -> bool {
        let (closed, offered) = match self.map().get(node_id) {
            Some(e) if e.epoch == abs_slot / SLOTS_PER_EPOCH => {
                if e.last_slot >= abs_slot || e.sends >= MAX_PUSHES_PER_EPOCH { return false; }
                (e.sent_slot.max(e.dormant_slot), e.sends > 0 || e.unsent > 0)
            }
            _ => (None, false),
        };
        let mut held = None;
        dues.iter().any(|d| {
            closed.map_or(true, |s| s < d.met_from)
                && (!d.repeat || offered || d.round < *held.get_or_insert_with(&held_from))
        })
    }

    pub(crate) fn record(&self, node_id: &str, abs_slot: u64, outcome: SendOutcome, now: u64) {
        let Some(mut e) = self.entry(node_id, abs_slot / SLOTS_PER_EPOCH) else { return; };
        e.last_slot = abs_slot;
        // A push that never went out is not one of the round's six: the next slot of its due point tries again. Nor is
        // a node the dormant rule held; its hold closes the due point, so it is read again only at the next one.
        match outcome {
            SendOutcome::Unsent => { e.unsent = e.unsent.saturating_add(1); return; }
            SendOutcome::Dormant => { e.dormant = true; e.dormant_slot = Some(abs_slot); return; }
            _ => {}
        }
        e.sends = e.sends.saturating_add(1);
        e.sent_slot = Some(abs_slot);
        match outcome {
            SendOutcome::Accepted if e.woken_at == 0 => e.woken_at = now,
            SendOutcome::Gone => e.gone = true,
            SendOutcome::Polled if e.polled_slot.is_none() => e.polled_slot = Some(abs_slot),
            _ => {}
        }
    }

    /// A wake went out to the node in `abs_slot`: the provider took the push, or (`polled`) a challenge was left
    /// for its poll. Not one of the epoch's pushes: the round and the retry round are left as they were.
    pub(crate) fn woke(&self, node_id: &str, abs_slot: u64, polled: bool, now: u64) {
        let Some(mut e) = self.entry(node_id, abs_slot / SLOTS_PER_EPOCH) else { return; };
        if polled {
            e.polled_slot.get_or_insert(abs_slot);
        } else if e.woken_at == 0 {
            e.woken_at = now;
        }
    }

    /// The device fetched a challenge in `epoch`: only for a node a challenge was left for here this epoch, so a
    /// poll in its name adds no entry. The poll route calls it only for a poll the device signed (L-5).
    pub(crate) fn fetched(&self, node_id: &str, epoch: u64, now: u64) {
        if let Some(mut e) = self.map().get_mut(node_id) {
            if e.epoch == epoch && e.polled_slot.is_some() && e.fetched_at == 0 { e.fetched_at = now; }
        }
    }

    /// A challenge was left for the node here in `epoch` and no fetch of it was counted yet (`fetched`).
    pub(crate) fn awaits_fetch(&self, node_id: &str, epoch: u64) -> bool {
        self.map().get(node_id).map_or(false, |e| e.epoch == epoch && e.polled_slot.is_some() && e.fetched_at == 0)
    }

    /// A refusal of an answer in `epoch` is kept for the node already.
    pub(crate) fn refused_in(&self, node_id: &str, epoch: u64) -> bool {
        self.map().get(node_id).map_or(false, |e| e.epoch == epoch && e.refused.is_some())
    }

    /// An answer in `epoch` was refused with `code` at `now`; the first refusal is kept.
    pub(crate) fn refused(&self, node_id: &str, epoch: u64, code: &'static str, now: u64) {
        if let Some(mut e) = self.entry(node_id, epoch) {
            if e.refused.is_none() {
                e.refused = Some(code);
                e.refused_at = now;
            }
        }
    }

    /// The dormant rule held the node in `epoch` here already: the selection skips it without a read.
    pub(crate) fn held_dormant(&self, node_id: &str, epoch: u64) -> bool {
        self.map().get(node_id).map_or(false, |e| e.epoch == epoch && e.dormant)
    }

    /// The provider said the node's token or endpoint is gone in `epoch`.
    pub(crate) fn gone_in(&self, node_id: &str, epoch: u64) -> bool {
        self.map().get(node_id).map_or(false, |e| e.epoch == epoch && e.gone)
    }

    /// The node answered: nothing to record for it.
    pub(crate) fn answered(&self, node_id: &str) {
        self.map().remove(node_id);
    }

    /// When the provider took the node's first push in `epoch` (None for none).
    pub(crate) fn woken_at(&self, node_id: &str, epoch: u64) -> Option<u64> {
        self.map().get(node_id).filter(|e| e.epoch == epoch && e.woken_at > 0).map(|e| e.woken_at)
    }

    /// Keep only `epoch`'s entries of nodes that have not answered.
    pub(crate) fn prune(&self, epoch: u64, mut answered: impl FnMut(&str) -> bool) {
        self.map().retain(|id, e| e.epoch == epoch && !answered(id));
    }

    /// Take `epoch`'s entries out at its commit, and drop every older one. The entries are moved out, not copied: at
    /// the cap a copy doubled the ledger for the length of the pass.
    pub(crate) fn take_epoch(&self, epoch: u64) -> Vec<(String, PushEntry)> {
        let mut out = Vec::new();
        self.map().retain(|k, e| {
            if e.epoch == epoch { out.push((k.clone(), std::mem::take(e))); }
            e.epoch > epoch
        });
        out
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map().len()
    }

    #[cfg(test)]
    fn get(&self, node_id: &str) -> Option<PushEntry> {
        self.map().get(node_id).map(|e| e.clone())
    }
}

pub(crate) static PUSH_LEDGER: PushLedger = PushLedger::new();

/// Epoch pushes leave in one even stream of `per_sec`: each takes the next free instant and waits for it, so a
/// slot's pushes spread over the slot. Sent all at once they met the per-second cap together, and every push not
/// through within a second failed - at ten million nodes most of a slot's twelve thousand.
pub(crate) struct PushPacer {
    /// The next free instant and the gap between two, in nanoseconds: the gap rounded up, so the stream never runs
    /// above its rate.
    next_ns: std::sync::atomic::AtomicU64,
    gap_ns: std::sync::atomic::AtomicU64,
}

/// The gap between two pushes at `per_sec`, in nanoseconds, rounded up.
const fn pace_gap_ns(per_sec: u64) -> u64 {
    let per_sec = if per_sec == 0 { 1 } else { per_sec };
    (1_000_000_000 + per_sec - 1) / per_sec
}

impl PushPacer {
    pub(crate) const fn new(per_sec: u64) -> Self {
        PushPacer { next_ns: std::sync::atomic::AtomicU64::new(0), gap_ns: std::sync::atomic::AtomicU64::new(pace_gap_ns(per_sec)) }
    }

    /// Pace at `per_sec` from the next instant on (`epoch_push_rate` of the shards covered).
    pub(crate) fn set_rate(&self, per_sec: u64) {
        self.gap_ns.store(pace_gap_ns(per_sec), std::sync::atomic::Ordering::Relaxed);
    }

    /// Reserve the first free instant at or after `now_us` (Unix microseconds); None, reserving nothing, when it
    /// falls after `deadline_us`. A free instant more than a pace window past the deadline was reserved before this
    /// genesis's clock was set back: the stream starts again now, instead of shedding every push until the clock
    /// catches up (servers' clocks are set as they are).
    pub(crate) fn reserve(&self, now_us: u64, deadline_us: u64) -> Option<u64> {
        use std::sync::atomic::Ordering::Relaxed;
        let gap = self.gap_ns.load(Relaxed);
        let (now, deadline) = (now_us.saturating_mul(1_000), deadline_us.saturating_mul(1_000));
        let mut next = self.next_ns.load(Relaxed);
        loop {
            let at = if next > deadline.saturating_add(PACE_WINDOW_US * 1_000) { now } else { next.max(now) };
            if at > deadline { return None; }
            match self.next_ns.compare_exchange_weak(next, at.saturating_add(gap), Relaxed, Relaxed) {
                Ok(_) => return Some(at / 1_000),
                Err(seen) => next = seen,
            }
        }
    }
}

pub(crate) static EPOCH_PACER: PushPacer = PushPacer::new(EPOCH_PUSHES_PER_SEC);
/// How long after it was offered a push may still wait for its instant: inside the slot it was offered in.
pub(crate) const PACE_WINDOW_US: u64 = 55_000_000;

/// What one ping tick did, for its one summary line: each push is logged only at DEBUG, as at ten million nodes a
/// line a push is hundreds a second.
#[derive(Default)]
pub(crate) struct PushTally {
    pub(crate) accepted: std::sync::atomic::AtomicU64,
    pub(crate) failed: std::sync::atomic::AtomicU64,
    pub(crate) gone: std::sync::atomic::AtomicU64,
    pub(crate) polled: std::sync::atomic::AtomicU64,
    pub(crate) shed: std::sync::atomic::AtomicU64,
    first_err: std::sync::OnceLock<String>,
    /// The pushes sent over the provider's channel (`PushChannel::is_provider`), those it answered (took, or said the
    /// token is gone) and its first refusal, for `PushHealth`.
    provider_sent: std::sync::atomic::AtomicU64,
    provider_answered: std::sync::atomic::AtomicU64,
    provider_err: std::sync::OnceLock<String>,
}

impl PushTally {
    /// A push the provider of `channel` took.
    pub(crate) fn took(&self, channel: &PushChannel) {
        use std::sync::atomic::Ordering::Relaxed;
        self.accepted.fetch_add(1, Relaxed);
        if channel.is_provider() {
            self.provider_sent.fetch_add(1, Relaxed);
            self.provider_answered.fetch_add(1, Relaxed);
        }
    }

    /// A push the provider of `channel` refused (`gone`: the token or endpoint no longer exists, the answer of a
    /// working provider); the first error is kept.
    pub(crate) fn failed(&self, channel: &PushChannel, gone: bool, err: &str) {
        use std::sync::atomic::Ordering::Relaxed;
        let n = if gone { &self.gone } else { &self.failed };
        n.fetch_add(1, Relaxed);
        let err: String = err.chars().take(160).collect();
        if channel.is_provider() {
            self.provider_sent.fetch_add(1, Relaxed);
            if gone {
                self.provider_answered.fetch_add(1, Relaxed);
            } else {
                let _ = self.provider_err.set(err.clone());
            }
        }
        let _ = self.first_err.set(err);
    }

    /// (pushes sent over the provider's channel, pushes it answered), for `PushHealth`.
    pub(crate) fn provider_answers(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (self.provider_sent.load(Relaxed), self.provider_answered.load(Relaxed))
    }

    /// The provider's first refusal of the tick.
    pub(crate) fn provider_err(&self) -> Option<&str> {
        self.provider_err.get().map(String::as_str)
    }

    /// The summary line: `offered` nodes, the pushes sent and what came of them. At WARN when a push failed or was
    /// shed, else at INFO.
    pub(crate) fn summary(&self, slot: u64, offered: usize) -> (bool, String) {
        let get = |n: &std::sync::atomic::AtomicU64| n.load(std::sync::atomic::Ordering::Relaxed);
        let (accepted, failed, gone, polled, shed) = (get(&self.accepted), get(&self.failed), get(&self.gone), get(&self.polled), get(&self.shed));
        let mut line = format!("push_tick slot={} offered={} sent={} accepted={} failed={} gone={} polled={} shed={}",
                               slot, offered, accepted + failed + gone, accepted, failed, gone, polled, shed);
        if let Some(e) = self.first_err.get() {
            line.push_str(&format!(" first_err=\"{}\"", e));
        }
        (failed + gone + shed > 0, line)
    }

    pub(crate) fn log(&self, slot: u64, offered: usize) {
        match self.summary(slot, offered) {
            (true, line) if crate::node::is_warn() => println!("[WARN][LIGHT] {}", line),
            (false, line) if crate::node::is_info() => println!("[INFO][LIGHT] {}", line),
            _ => {}
        }
    }
}

/// (epoch, slot, absolute slot `epoch * 240 + slot`) at `height`, all three from that one height: a tick at an
/// epoch's boundary never pairs one epoch's slot with the next epoch's number (L-4).
pub(crate) fn light_ping_slot_at(height: u64) -> (u64, u64, u64) {
    let (epoch, slot) = (height / EPOCH_BLOCKS, (height % EPOCH_BLOCKS) / (EPOCH_BLOCKS / SLOTS_PER_EPOCH));
    (epoch, slot, epoch * SLOTS_PER_EPOCH + slot)
}

/// One ping tick's selection (`SimplifiedP2P::get_light_nodes_to_ping`): the absolute slot it read, which the tick
/// stamps its pushes with and judges the epoch's commit by, and each node to push with its rank and how its device is
/// reached (`push_reach_at`: the channel, or None for a stamped challenge), decided once in the selection (M-11).
#[derive(Debug, Default)]
pub(crate) struct LightPingSelection {
    pub(crate) now_slot: u64,
    pub(crate) nodes: Vec<(String, crate::unified_p2p::PingerRole, Option<PushChannel>)>,
}

/// Whether the pinger pushes this node in `abs_slot` (epoch * 240 + slot) for a push due in that slot alone, as in a
/// window before the spaced rounds (`Due::once`, each slot of a round a due point of its own): the ledger allows it
/// (`PushLedger::may_push`), the chain registered it, and a device is linked to it (`push_reach_at`). It models only
/// that window's rule; the spaced rounds' due points are tested on the ledger itself.
#[cfg(test)]
pub(crate) fn light_push_target(storage: &crate::storage::Storage, node_id: &str, abs_slot: u64) -> bool {
    PUSH_LEDGER.may_push(node_id, abs_slot, &[Due::once(abs_slot)], || 0)
        && push_reach_at(storage, node_id, crate::light_device::current_epoch(), crate::light_device::now_secs()).is_some()
}

/// The pinger's decision for one node the ledger let through (`PushLedger::may_push`, read in RAM before this) and how
/// its device is reached: None when it is not pushed, else the channel to push on (None: a stamped challenge for its
/// poll). The registration, then one slim read of the binding row (`Storage::light_binding_reach`), which the push
/// record's check and the device layer's share instead of each reading the row again (M-11). `epoch` and `now` are the
/// device layer's (`device_pushable_at`).
pub(crate) fn push_reach_at(storage: &crate::storage::Storage, node_id: &str, epoch: u64, now: u64)
    -> Option<Option<PushChannel>>
{
    if !storage.is_node_registration_onchain(node_id) { return None; }
    let binding = storage.light_binding_reach(node_id);
    let reach = reach_with(storage, node_id, binding.as_ref())?;
    device_pushable_with(storage, node_id, binding.as_ref(), true, epoch, now).then_some(reach)
}

// ── The node's last miss and last answer here (`device.last_miss`, `device.last_answer` of the status) ──

/// A registration's first epochs, pushed whatever came before (the dormant rule never reaches it): 43,200 s. From
/// then on a node stops being woken only after two proven device misses in a row (`proven_dormant`); an answer of
/// its own, the app's or "I'm back", brings it back in the epoch it is given.
pub(crate) const WAKE_GRACE_EPOCHS: u64 = 3;

/// Why a node was not counted in an epoch. Of two records for the same epoch the one of higher `rank` (what it
/// tells) is kept, here and by every reader; the value is the row's code and never changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissReason {
    /// Not pushed: a proven device miss in each of the two epochs before (the dormant rule, `proven_dormant`).
    NotWokenInactive = 1,
    /// No push channel and no challenge fetched, or the provider says the token is gone.
    NoPushAddress = 2,
    /// Pushed (the provider took it) or a challenge fetched, and no answer before the commit.
    WokenNoAnswer = 3,
    /// An answer came in time and was refused.
    AnswerRefused = 4,
    /// The answer came after the commit.
    AnsweredLate = 5,
    /// A push the provider took that the device, answering later, reports it never received (`refine_miss`).
    NotDelivered = 6,
    /// Every push due failed at the provider or never went out (shed by the pacing, no anchor): the system's miss,
    /// never the device's, and never one toward the dormant rule.
    NotSent = 7,
    /// The node's shard committed no row in the epoch: nobody of it could be counted. The system's miss.
    NotCommitted = 8,
}

impl MissReason {
    const ALL: [MissReason; 8] = [MissReason::NotWokenInactive, MissReason::NoPushAddress, MissReason::WokenNoAnswer,
                                  MissReason::AnswerRefused, MissReason::AnsweredLate, MissReason::NotDelivered,
                                  MissReason::NotSent, MissReason::NotCommitted];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            MissReason::NotWokenInactive => "not_woken_inactive",
            MissReason::NoPushAddress => "no_push_address",
            MissReason::WokenNoAnswer => "woken_no_answer",
            MissReason::AnswerRefused => "answer_refused",
            MissReason::AnsweredLate => "answered_late",
            MissReason::NotDelivered => "not_delivered",
            MissReason::NotSent => "not_sent",
            MissReason::NotCommitted => "not_committed",
        }
    }

    /// What a record tells, rising: `not_sent` above only the dormant rule's, `not_delivered` between
    /// `answer_refused` and `answered_late`, and `not_committed`, which settles the epoch for the whole shard, last.
    pub(crate) fn rank(self) -> u8 {
        match self {
            MissReason::NotWokenInactive => 1,
            MissReason::NotSent => 2,
            MissReason::NoPushAddress => 3,
            MissReason::WokenNoAnswer => 4,
            MissReason::AnswerRefused => 5,
            MissReason::NotDelivered => 6,
            MissReason::AnsweredLate => 7,
            MissReason::NotCommitted => 8,
        }
    }

    fn from_code(c: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|r| *r as u8 == c)
    }
}

/// What the app did with a push it received, as its receipts say (`PushReceipts`). Display data; the value is the
/// row's code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppOutcome {
    Answered = 1,
    /// The app was not opened since the phone started, so it may not answer (the parity rule).
    NotOpenedSinceBoot = 2,
    /// The app was swiped away since it was last opened (the parity rule).
    Swiped = 3,
    /// The push arrived after its epoch's commit: an answer then counts for nothing.
    AfterCommit = 4,
    /// The app answered and no genesis took the answer.
    AnswerFailed = 5,
    /// The epoch was already counted for the node.
    AlreadyCounted = 6,
    /// The app held no key to sign with.
    NoKey = 7,
}

impl AppOutcome {
    const ALL: [AppOutcome; 7] = [AppOutcome::Answered, AppOutcome::NotOpenedSinceBoot, AppOutcome::Swiped,
                                  AppOutcome::AfterCommit, AppOutcome::AnswerFailed, AppOutcome::AlreadyCounted, AppOutcome::NoKey];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AppOutcome::Answered => "answered",
            AppOutcome::NotOpenedSinceBoot => "not_opened_since_boot",
            AppOutcome::Swiped => "swiped",
            AppOutcome::AfterCommit => "after_commit",
            AppOutcome::AnswerFailed => "answer_failed",
            AppOutcome::AlreadyCounted => "already_counted",
            AppOutcome::NoKey => "no_key",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|o| o.as_str() == s)
    }

    fn from_code(c: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|o| *o as u8 == c)
    }
}

/// A node's miss of one epoch as this shard owner saw it. Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LightMiss {
    pub(crate) epoch: u64,
    pub(crate) reason: MissReason,
    /// When the provider took the epoch's first push for the device, or the device fetched its challenge.
    pub(crate) woken_at: Option<u64>,
    /// When the late answer, or the refused one, came.
    pub(crate) answered_at: Option<u64>,
    /// How long the push took to reach the device, when the late answer or the device's receipt told.
    pub(crate) delivery_delay_secs: Option<u64>,
    pub(crate) refused: Option<String>,
    /// When this genesis wrote the record. Not served: the status shows only what came after the binding it holds
    /// (`LightPushRow::since`).
    pub(crate) recorded_at: u64,
    /// When the push reached the device, on this genesis's clock, when the late answer or the device's receipt told.
    pub(crate) delivered_at: Option<u64>,
    /// What the app did with that push, when its receipt told.
    pub(crate) app_outcome: Option<AppOutcome>,
    /// Woken only by a push the provider took, no challenge fetched: the one miss a receipt may turn `not_delivered`.
    /// Not served.
    pub(crate) by_push: bool,
}

impl LightMiss {
    /// What the row keeps of `prior` and `new`: the later epoch; at one epoch the reason that tells more (of two
    /// equal ones the first), with the wake time and, but for `not_delivered`, the delivery either of them knew.
    pub(crate) fn merge(prior: Option<LightMiss>, new: LightMiss) -> LightMiss {
        let Some(prior) = prior else { return new; };
        if new.epoch != prior.epoch {
            return if new.epoch > prior.epoch { new } else { prior };
        }
        let (mut keep, other) = if new.reason.rank() > prior.reason.rank() { (new, prior) } else { (prior, new) };
        keep.woken_at = keep.woken_at.or(other.woken_at);
        if keep.reason != MissReason::NotDelivered {
            if keep.delivered_at.is_none() {
                keep.delivered_at = other.delivered_at;
                keep.delivery_delay_secs = keep.delivery_delay_secs.or(other.delivery_delay_secs);
            }
            keep.app_outcome = keep.app_outcome.or(other.app_outcome);
        }
        keep
    }

    /// Whether the push reached the phone: true when a receipt or the answer dated its delivery or told what the app
    /// did with it, false for `not_delivered`, else not known.
    pub(crate) fn delivered(&self) -> Option<bool> {
        if self.reason == MissReason::NotDelivered { return Some(false); }
        (self.delivered_at.is_some() || self.delivery_delay_secs.is_some() || self.app_outcome.is_some()).then_some(true)
    }

    /// The public status's form (H-1): the epoch, the reason and `delivered`. No time and nothing of what the app did.
    pub(crate) fn public_json(&self) -> Value {
        json!({ "epoch": self.epoch, "reason": self.reason.as_str(), "delivered": self.delivered() })
    }

    /// The signed status's form: the public one with the times, the refusal code and what the app did.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "epoch": self.epoch,
            "reason": self.reason.as_str(),
            "delivered": self.delivered(),
            "woken_at": self.woken_at,
            "answered_at": self.answered_at,
            "delivery_delay_secs": self.delivery_delay_secs,
            "refused": self.refused,
            "delivered_at": self.delivered_at,
            "app_outcome": self.app_outcome.map(AppOutcome::as_str),
        })
    }
}

/// The node's last answer that counted, as this genesis took it. Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LastAnswer {
    /// When the answer reached this genesis.
    pub(crate) at: u64,
    pub(crate) delivery_delay_secs: Option<u64>,
    pub(crate) handling_secs: Option<u64>,
}

impl LastAnswer {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "at": self.at, "delivery_delay_secs": self.delivery_delay_secs, "handling_secs": self.handling_secs })
    }
}

/// One node's row here (`Storage::light_push_row`): its last miss and its last answer, each overwritten by the
/// next. Node-local, never gossiped; read by the status alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LightPushRow {
    pub(crate) miss: Option<LightMiss>,
    pub(crate) answer: Option<LastAnswer>,
}

const ROW_VERSION: u8 = 2;
/// The refusal code a row keeps, at most this long.
const REFUSED_MAX: usize = 32;
/// A word for "none".
const NO_TIME: u64 = u64::MAX;

fn word(v: &[u8], at: &mut usize) -> Option<u64> {
    let w = v.get(*at..*at + 8)?;
    *at += 8;
    Some(u64::from_be_bytes(w.try_into().ok()?))
}

fn opt_word(v: &[u8], at: &mut usize) -> Option<Option<u64>> {
    word(v, at).map(|w| (w != NO_TIME).then_some(w))
}

impl LightPushRow {
    /// Version 2: the version byte, a byte of flags (1 a miss, 2 an answer), then 8-byte big-endian words, u64::MAX
    /// for none. The miss: epoch, a reason byte, woken_at, answered_at, the delay, recorded_at, the refusal code (a
    /// length byte and its bytes), delivered_at, an outcome byte (0 none) and a byte of miss flags (1 `by_push`).
    /// The answer: at, the delay and the handling. Version 1, read too, ends the miss at the refusal code.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(112);
        v.push(ROW_VERSION);
        v.push(self.miss.is_some() as u8 | (self.answer.is_some() as u8) << 1);
        let put = |v: &mut Vec<u8>, w: Option<u64>| v.extend_from_slice(&w.unwrap_or(NO_TIME).to_be_bytes());
        if let Some(m) = &self.miss {
            put(&mut v, Some(m.epoch));
            v.push(m.reason as u8);
            put(&mut v, m.woken_at);
            put(&mut v, m.answered_at);
            put(&mut v, m.delivery_delay_secs);
            put(&mut v, Some(m.recorded_at));
            let refused = m.refused.as_deref().unwrap_or("").as_bytes();
            let refused = &refused[..refused.len().min(REFUSED_MAX)];
            v.push(refused.len() as u8);
            v.extend_from_slice(refused);
            put(&mut v, m.delivered_at);
            v.push(m.app_outcome.map_or(0, |o| o as u8));
            v.push(m.by_push as u8);
        }
        if let Some(a) = &self.answer {
            put(&mut v, Some(a.at));
            put(&mut v, a.delivery_delay_secs);
            put(&mut v, a.handling_secs);
        }
        v
    }

    pub(crate) fn decode(v: &[u8]) -> Option<Self> {
        if v.len() < 2 || !(1..=ROW_VERSION).contains(&v[0]) || v[1] > 3 { return None; }
        let mut at = 2usize;
        let miss = if v[1] & 1 != 0 {
            let epoch = word(v, &mut at)?;
            let reason = MissReason::from_code(*v.get(at)?)?;
            at += 1;
            let (woken_at, answered_at, delay) = (opt_word(v, &mut at)?, opt_word(v, &mut at)?, opt_word(v, &mut at)?);
            let recorded_at = word(v, &mut at)?;
            let len = *v.get(at)? as usize;
            let refused = std::str::from_utf8(v.get(at + 1..at + 1 + len)?).ok()?;
            at += 1 + len;
            let (delivered_at, app_outcome, by_push) = if v[0] >= 2 {
                let delivered_at = opt_word(v, &mut at)?;
                let outcome = match *v.get(at)? { 0 => None, c => Some(AppOutcome::from_code(c)?) };
                let flags = *v.get(at + 1)?;
                if flags > 1 { return None; }
                at += 2;
                (delivered_at, outcome, flags == 1)
            } else {
                (None, None, false)
            };
            Some(LightMiss { epoch, reason, woken_at, answered_at, delivery_delay_secs: delay,
                             refused: (!refused.is_empty()).then(|| refused.to_string()), recorded_at,
                             delivered_at, app_outcome, by_push })
        } else {
            None
        };
        let answer = if v[1] & 2 != 0 {
            Some(LastAnswer { at: word(v, &mut at)?, delivery_delay_secs: opt_word(v, &mut at)?, handling_secs: opt_word(v, &mut at)? })
        } else {
            None
        };
        (at == v.len()).then_some(LightPushRow { miss, answer })
    }

    /// The row as the status serves it under a binding this genesis stored at `bound_at`: what came before was
    /// another binding's, so another device's.
    pub(crate) fn since(self, bound_at: u64) -> LightPushRow {
        LightPushRow {
            miss: self.miss.filter(|m| m.recorded_at >= bound_at),
            answer: self.answer.filter(|a| a.at >= bound_at),
        }
    }
}

/// One lock stripe per node for the read-merge-write of its row.
fn row_lock(node_id: &str) -> parking_lot::MutexGuard<'static, ()> {
    static LOCKS: std::sync::OnceLock<Vec<parking_lot::Mutex<()>>> = std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| (0..64).map(|_| parking_lot::Mutex::new(())).collect());
    let h = node_id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    locks[(h % locks.len() as u64) as usize].lock()
}

/// The node's row here, if any.
pub(crate) fn stored_row(storage: &crate::storage::Storage, node_id: &str) -> Option<LightPushRow> {
    storage.light_push_row(node_id).and_then(|v| LightPushRow::decode(&v))
}

/// Change the node's row under its lock; `f` says whether it changed it. True when a row was written.
fn update_row(storage: &crate::storage::Storage, node_id: &str, f: impl FnOnce(&mut LightPushRow) -> bool) -> bool {
    let _g = row_lock(node_id);
    let mut row = stored_row(storage, node_id).unwrap_or_default();
    if !f(&mut row) { return false; }
    match storage.put_light_push_row(node_id, &row.encode()) {
        Ok(()) => true,
        Err(e) => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] push_row_write_failed node={} err={}", node_id, e);
            }
            false
        }
    }
}

/// Merge `m` into the node's row. True when it changed the row.
fn merge_miss(storage: &crate::storage::Storage, node_id: &str, m: LightMiss) -> bool {
    update_row(storage, node_id, |row| {
        let merged = LightMiss::merge(row.miss.clone(), m);
        if row.miss.as_ref() == Some(&merged) { return false; }
        row.miss = Some(merged);
        true
    })
}

/// This genesis owns the node's light shard (any rank): the misses it records are read from it.
pub(crate) fn owns_light_shard(node_id: &str) -> bool {
    our_genesis_idx().map_or(false, |i| crate::node::light_owner_rank(crate::node::light_shard_of(node_id), i).is_some())
}

/// The misses of `epoch` from its entries (`take_epoch`), recorded at `now`: every node with no answer in it
/// (`answered_in`, this genesis's own record of the epoch) whose entry names a reason.
pub(crate) fn epoch_misses(entries: Vec<(String, PushEntry)>, answered_in: impl Fn(&str) -> bool, now: u64) -> Vec<(String, LightMiss)> {
    entries.into_iter()
        .filter(|(id, _)| !answered_in(id))
        .filter_map(|(id, e)| e.miss(now).map(|m| (id, m)))
        .collect()
}

/// The nodes of `epoch`'s entries this genesis reached (`PushEntry::reached`) with no answer of the epoch here: what
/// its reach records keep (`save_reach_records`). A node that answered at another owner whose relay was lost is
/// here too: the committed index, which the dormant rule reads as well, still counts it.
pub(crate) fn reached_unanswered(entries: &[(String, PushEntry)], answered_in: impl Fn(&str) -> bool) -> Vec<String> {
    entries.iter().filter(|(id, e)| e.reached() && !answered_in(id)).map(|(id, _)| id.clone()).collect()
}

/// Merge the epoch's misses into their rows. Returns the rows changed.
pub(crate) fn save_misses(storage: &crate::storage::Storage, misses: Vec<(String, LightMiss)>) -> usize {
    misses.into_iter().filter(|(id, m)| merge_miss(storage, id, m.clone())).count()
}

/// The node's row already holds a late answer to `epoch`, or a miss of a later epoch: a late answer to `epoch`
/// would change nothing.
pub(crate) fn late_recorded(storage: &crate::storage::Storage, node_id: &str, epoch: u64) -> bool {
    stored_row(storage, node_id).and_then(|r| r.miss)
        .map_or(false, |m| m.epoch > epoch || (m.epoch == epoch && m.reason == MissReason::AnsweredLate))
}

/// An answer to `epoch`'s challenge came at `now`, after that epoch's commit opened: the node's miss of `epoch`
/// becomes `answered_late`, credited nowhere, keeping when it was woken; the first late answer is kept. When the
/// answer told its handling, the push reached the device that long before `now` (`delivered_at`).
pub(crate) fn record_late_answer(storage: &crate::storage::Storage, node_id: &str, epoch: u64, now: u64, d: Delivery) -> bool {
    let late = LightMiss {
        epoch,
        reason: MissReason::AnsweredLate,
        woken_at: PUSH_LEDGER.woken_at(node_id, epoch),
        answered_at: Some(now),
        delivery_delay_secs: d.delay_secs,
        refused: None,
        recorded_at: now,
        delivered_at: d.handling_secs.map(|h| now.saturating_sub(h)),
        app_outcome: None,
        by_push: false,
    };
    merge_miss(storage, node_id, late)
}

/// An answer that counted the node came at `now`: its last answer here, and what the push receipts it carried tell
/// of the node's last miss (`refine_miss`, `answered_at` the answer's own device time). A report covers the epochs
/// before its answer's own (`answer_epoch`, of the anchor), so a miss of that epoch or a later one, recorded while the
/// answer was being taken, is left as it is. One write.
pub(crate) fn record_answer(storage: &crate::storage::Storage, node_id: &str, now: u64, d: Delivery,
                            receipts: Option<&PushReceipts>, answered_at: Option<u64>, answer_epoch: Option<u64>) -> bool {
    update_row(storage, node_id, |row| {
        row.answer = Some(LastAnswer { at: now, delivery_delay_secs: d.delay_secs, handling_secs: d.handling_secs });
        let covered = row.miss.as_ref().filter(|m| answer_epoch.map_or(false, |a| m.epoch < a));
        if let Some(refined) = covered.zip(receipts).and_then(|(m, r)| refine_miss(m, r, answered_at, now)) {
            row.miss = Some(refined);
        }
        true
    })
}

// ── What the device says of the pushes it received (`push_receipts` of an answer, light-node-messages 5.10) ──

/// Receipts one report may carry, and its text at most.
pub(crate) const PUSH_RECEIPTS_MAX: usize = 8;
pub(crate) const PUSH_RECEIPTS_MAX_BYTES: usize = 2048;
/// The longest a receipt may be held on the device before the answer that reports it and still date its push.
const MAX_RECEIPT_AGE_SECS: u64 = 7 * 86_400;

/// One push the device received: its epoch (of the push's anchor), the push's `sent_at` (the sending genesis's
/// clock), when the device took it (the device's clock) and what the app did with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PushReceipt {
    pub(crate) epoch: u64,
    pub(crate) sent_at: Option<u64>,
    pub(crate) received_at: u64,
    /// None for an outcome this genesis does not know.
    pub(crate) outcome: Option<AppOutcome>,
}

/// The device's record of the pushes it received and did not answer, every one from epoch `since` on. Unsigned
/// display data that rides in a verified answer: it never changes crediting, only the node's last miss here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushReceipts {
    pub(crate) since: u64,
    pub(crate) pushes: Vec<PushReceipt>,
}

impl PushReceipts {
    /// From the answer's `push_receipts`, JSON text in a string field (a genesis of an earlier release takes a body of
    /// strings only, and ignores the field). None when absent, over PUSH_RECEIPTS_MAX_BYTES, with more than
    /// PUSH_RECEIPTS_MAX receipts, or malformed: a report is read whole or not at all.
    pub(crate) fn from_params(p: &HashMap<String, String>) -> Option<Self> {
        let text = p.get("push_receipts")?;
        if text.len() > PUSH_RECEIPTS_MAX_BYTES { return None; }
        let v: Value = serde_json::from_str(text).ok()?;
        // Numbers, or decimal strings as every other answer field.
        let num = |x: Option<&Value>| match x? {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse::<u64>().ok(),
            _ => None,
        };
        let since = num(v.get("since"))?;
        let list = v.get("pushes")?.as_array()?;
        if list.len() > PUSH_RECEIPTS_MAX { return None; }
        let pushes = list.iter().map(|e| Some(PushReceipt {
            epoch: num(e.get("epoch"))?,
            sent_at: num(e.get("sent_at")).filter(|t| *t > 0),
            received_at: num(e.get("received_at")).filter(|t| *t > 0)?,
            outcome: e.get("outcome").and_then(Value::as_str).and_then(AppOutcome::parse),
        })).collect::<Option<Vec<_>>>()?;
        Some(PushReceipts { since, pushes })
    }
}

/// What a report (`r`, carried by an answer that reached this genesis at `now`, sent at the device's `answered_at`)
/// tells of the miss `m`; None when nothing. Only a `woken_no_answer` not refined before is refined:
/// - the device received a push of that epoch: the first one it received dates the delivery on this genesis's clock,
///   `now - (answered_at - received_at)`, so the device's clock cancels out (`delivered_at`, never before the push's
///   `sent_at`; the delay from it), and names what the app did with it (`app_outcome`);
/// - it received none, its record holds every push from that epoch on and only a push the provider took woke the
///   node (`by_push`): `not_delivered`, the push service or the phone held it.
pub(crate) fn refine_miss(m: &LightMiss, r: &PushReceipts, answered_at: Option<u64>, now: u64) -> Option<LightMiss> {
    if m.reason != MissReason::WokenNoAnswer || m.delivered_at.is_some() || m.app_outcome.is_some() { return None; }
    let refined = match r.pushes.iter().filter(|p| p.epoch == m.epoch).min_by_key(|p| p.received_at) {
        Some(p) => {
            // Before its push left, past what another genesis's clock may be off: the device's clock moved between the
            // receipt and the answer, and the two times date nothing.
            let delivered_at = answered_at
                .and_then(|a| a.checked_sub(p.received_at))
                .filter(|held| *held <= MAX_RECEIPT_AGE_SECS)
                .map(|held| now.saturating_sub(held))
                .filter(|d| p.sent_at.map_or(true, |s| s <= d.saturating_add(SENT_AT_SKEW_SECS)));
            let delay = delivered_at.zip(p.sent_at)
                .map(|(d, s)| d.saturating_sub(s))
                .filter(|t| *t <= MAX_DELIVERY_SECS);
            LightMiss { delivered_at, delivery_delay_secs: delay, app_outcome: p.outcome, ..m.clone() }
        }
        None if m.by_push && r.since <= m.epoch => LightMiss { reason: MissReason::NotDelivered, ..m.clone() },
        None => return None,
    };
    (refined != *m).then_some(refined)
}

/// A reply anchored in the epoch before the tip's, which the ping route refuses as stale: when this genesis owns
/// the node's shard, the anchor is canonical and `σ` verifies under the node's ping key, it is that node's answer
/// to the ended epoch, and its miss of that epoch becomes `answered_late`. The reply is refused all the same.
pub(crate) fn note_stale_answer(storage: &crate::storage::Storage, node_id: &str, challenge: &str, signature: &str,
                                tip: u64, now: u64, d: Delivery) -> bool {
    let Some(a) = crate::light_device::ping::Anchor::parse(challenge) else { return false; };
    if a.epoch() + 1 != tip / EPOCH_BLOCKS || !owns_light_shard(node_id) || late_recorded(storage, node_id, a.epoch()) {
        return false;
    }
    // A node counted in that epoch here missed nothing: a stray repeat of its answer is no late one.
    if storage.light_counted_answer_at(node_id, a.epoch()).is_some() { return false; }
    stale_answer_verifies(storage, node_id, challenge, signature, &a)
        && record_late_answer(storage, node_id, a.epoch(), now, d)
}

/// `note_stale_answer`'s check: the anchor canonical here and `σ` under the node's ping key.
fn stale_answer_verifies(storage: &crate::storage::Storage, node_id: &str, challenge: &str, signature: &str,
                         a: &crate::light_device::ping::Anchor) -> bool {
    if storage.get_microblock_hash_hex(a.height).ok().flatten().as_deref() != Some(a.hash.as_str()) { return false; }
    let Some(sigma) = crate::light_device::ping::sigma_text(signature) else { return false; };
    let Some(pp) = storage.get_light_ping_keys(node_id).map(|(k, _)| k) else { return false; };
    verify_mobile_dilithium_signature(challenge, &sigma, &pp)
}

/// The refusal codes an answer in time may be recorded with (`PushLedger::refused`). A bad signature or a malformed
/// reply is anyone's, and would hide that the device did not answer, so it is never one. Of these, `superseded` and
/// `device_counter` come only after a signature of the node's own verified (its presented ping key's, the device's);
/// the node's state decides the other three before any signature is checked, so `note_refusal` takes them only once
/// `σ` verifies under the node's own ping key (`answer_signed_by_node`): a stranger cannot cause any of them.
pub(crate) fn refusal_recorded(code: &str) -> bool {
    matches!(code, "superseded" | "device_not_counted" | "no_device_record" | "device_counter" | "legacy_after_enforcement")
}

/// The refusals a reply with the device signature (`ping_hw2:`) gets from the device layer.
fn device_refusal(code: &str) -> bool {
    matches!(code, "device_not_counted" | "no_device_record" | "device_counter")
}

/// The refusals decided before any signature of the reply is checked (`light_device::ping::check_device_reply`,
/// `verify_reply`): recorded only once `σ` verified under the node's own key.
fn refusal_needs_sigma(code: &str) -> bool {
    matches!(code, "device_not_counted" | "no_device_record" | "legacy_after_enforcement")
}

/// `σ` of a reply verifies under the node's stored ping key and the delegation the chain vouches for, as the shared
/// verifier checks it (`light_device::ping::verify_reply`): the reply is the node's own. `σ` first, so a forged reply
/// costs one ML-DSA-65 check.
pub(crate) fn answer_signed_by_node(storage: &crate::storage::Storage, node_id: &str, challenge: &str, signature: &str) -> bool {
    let Some(sigma) = crate::light_device::ping::sigma_text(signature) else { return false; };
    ping_key_signed(storage, node_id, challenge, &sigma)
}

/// `sig` (hex) of `message` verifies under the node's stored ping key, and that key's delegation under the identity
/// the chain vouches for. The signature first, so a forged one costs one ML-DSA-65 check.
pub(crate) fn ping_key_signed(storage: &crate::storage::Storage, node_id: &str, message: &str, sig: &str) -> bool {
    let Some((pp, cert)) = storage.get_light_ping_keys(node_id) else { return false; };
    if pp.is_empty() || cert.is_empty() || !verify_mobile_dilithium_signature(message, sig, &pp) { return false; }
    storage.resolve_light_identity_pk(node_id, None)
        .map_or(false, |identity| crate::light_binding::verify_delegation(&cert, &pp, node_id, &identity).is_some())
}

/// An answer in time was refused with `code` at `tip`: kept for the epoch's miss (`answer_refused`) when this genesis
/// owns the node's shard and the refusal is the node's own (`refusal_recorded`), checked by both routes alike.
pub(crate) fn note_refusal(storage: &crate::storage::Storage, node_id: &str, tip: u64, code: &'static str, now: u64,
                           challenge: &str, signature: &str) {
    note_refusal_in(&PUSH_LEDGER, storage, node_id, tip, code, now, challenge, signature, owns_light_shard(node_id),
                    crate::light_device::device_layer_served());
}

/// `note_refusal` into `ledger`, with this genesis's shard ownership (`owner`) and whether it serves the device layer
/// (`served`). While it does not, no honest app sends a device reply, so a device refusal is a stranger's and is not
/// kept. A refusal decided before any signature is kept only once `σ` verified under the node's own key, and only the
/// first of the epoch, so a node costs at most one such check an epoch.
#[allow(clippy::too_many_arguments)]
pub(crate) fn note_refusal_in(ledger: &PushLedger, storage: &crate::storage::Storage, node_id: &str, tip: u64,
                              code: &'static str, now: u64, challenge: &str, signature: &str, owner: bool, served: bool) {
    if !refusal_recorded(code) || !owner || (device_refusal(code) && !served) { return; }
    let epoch = tip / EPOCH_BLOCKS;
    if ledger.refused_in(node_id, epoch) || !storage.is_node_registration_onchain(node_id) { return; }
    if refusal_needs_sigma(code) && !answer_signed_by_node(storage, node_id, challenge, signature) { return; }
    ledger.refused(node_id, epoch, code, now);
}

/// The longest a push may take to its answer and still be measured: it lives until its epoch's commit, and a late
/// answer to it, recorded for its epoch and credited nowhere, may come in the next.
const MAX_DELIVERY_SECS: u64 = 2 * EPOCH_BLOCKS;
/// How far ahead of this genesis's clock the `sent_at` of another genesis may be.
const SENT_AT_SKEW_SECS: u64 = 120;

/// What an answer tells about the push it answers (light-node-messages section 5.10): when the genesis sent it
/// (its clock, the push's `sent_at`), when the device got it and when it answered (the device's clock). Unix
/// seconds; each may be absent (an older app, an answer of the app's own).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AnswerTiming {
    pub(crate) sent_at: Option<u64>,
    pub(crate) received_at: Option<u64>,
    pub(crate) answered_at: Option<u64>,
}

/// What this genesis makes of an `AnswerTiming`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Delivery {
    pub(crate) delay_secs: Option<u64>,
    pub(crate) handling_secs: Option<u64>,
}

impl AnswerTiming {
    /// From the answer's fields, decimal Unix seconds.
    pub(crate) fn from_params(p: &HashMap<String, String>) -> Self {
        let t = |k: &str| p.get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|t| *t > 0);
        AnswerTiming { sent_at: t("sent_at"), received_at: t("received_at"), answered_at: t("answered_at") }
    }

    /// At `now`, this genesis's clock: the app's own handling of the push, from the device's clock alone
    /// (`answered_at - received_at`), and the push's delivery, the time from sending to this answer less that
    /// handling (`(now - sent_at) - handling`), so the device's clock cancels out. None for what the answer does
    /// not tell, or a time out of range.
    pub(crate) fn measure(&self, now: u64) -> Delivery {
        let handling = match (self.received_at, self.answered_at) {
            (Some(r), Some(a)) if a >= r && a - r <= MAX_DELIVERY_SECS => Some(a - r),
            _ => None,
        };
        let transit = self.sent_at
            .filter(|s| *s <= now.saturating_add(SENT_AT_SKEW_SECS))
            .map(|s| now.saturating_sub(s))
            .filter(|t| *t <= MAX_DELIVERY_SECS);
        // Handling longer than the whole transit, past what another genesis's clock may be off: the device's clock moved
        // between its two times, which then tell nothing (a late answer would date its delivery before the push left).
        let handling = handling.filter(|h| transit.map_or(true, |t| *h <= t + SENT_AT_SKEW_SECS));
        Delivery { delay_secs: transit.zip(handling).map(|(t, h)| t.saturating_sub(h)), handling_secs: handling }
    }
}

/// A ping-response body's fields as the handler reads them: strings as sent, numbers and booleans in their text
/// form, anything else left out. A genesis before this one takes a body of strings only, so the app sends the
/// timing fields as strings; this one takes them either way.
pub(crate) fn answer_fields(body: HashMap<String, Value>) -> HashMap<String, String> {
    body.into_iter().filter_map(|(k, v)| match v {
        Value::String(s) => Some((k, s)),
        Value::Number(n) => Some((k, n.to_string())),
        Value::Bool(b) => Some((k, b.to_string())),
        _ => None,
    }).collect()
}

/// The signed status's `push_reregister`: a device is linked here and this genesis cannot push it - it holds no
/// push channel of the binding, or the provider said in `epoch` that the token is gone. The app then registers its
/// push token again.
pub(crate) fn push_reregister(storage: &crate::storage::Storage, node_id: &str, epoch: u64) -> bool {
    match device_reach(storage, node_id) {
        None => false,
        Some(None) => true,
        Some(Some(_)) => PUSH_LEDGER.gone_in(node_id, epoch),
    }
}

/// A device is linked to the node here (`device_reach`).
#[cfg(test)]
pub(crate) fn device_linked(storage: &crate::storage::Storage, node_id: &str) -> bool {
    device_reach(storage, node_id).is_some()
}

/// The node's device may poll for its challenge here: this genesis does not push it (`device_reach`), so
/// the pinger and a wake leave it a stamped challenge. A record someone else left is no push channel and
/// never locks the owner out of it.
pub(crate) fn light_poll_allowed(storage: &crate::storage::Storage, node_id: &str) -> bool {
    !matches!(device_reach(storage, node_id), Some(Some(_)))
}

/// A binding row's key, judged as every other reader judges it (`Storage::light_binding_vouched`) -
/// whether or not the check at the apply ran here (a genesis that applied the block late, or a row
/// written after that check). The public status reads a bound row through it too.
pub(crate) fn binding_vouched(storage: &crate::storage::Storage, node_id: &str, row: &crate::light_binding::BindingRow) -> bool {
    storage.light_binding_vouched(node_id, row)
}

/// The device layer's part of whom the pinger and a wake reach (A12): a device whose record here decides
/// its replies (`light_device::ping::governing_record`) only while that record counts - `active` or
/// `suspect`, its effective epoch reached, lease and rotation inside their windows. A node with no such
/// record is an installed app's: pushed as before until the enforcement epoch, whose replies it can no
/// longer give after.
pub(crate) fn device_layer_pushable(storage: &crate::storage::Storage, node_id: &str) -> bool {
    device_pushable_at(storage, node_id, crate::light_device::current_epoch(), crate::light_device::now_secs())
}

/// `device_layer_pushable` in `epoch` at Unix time `now`.
pub(crate) fn device_pushable_at(storage: &crate::storage::Storage, node_id: &str, epoch: u64, now: u64) -> bool {
    device_pushable_with(storage, node_id, storage.light_binding_reach(node_id).as_ref(),
                         storage.is_node_registration_onchain(node_id), epoch, now)
}

/// `device_pushable_at` with the node's binding row and registration already read: the record that governs its
/// replies is the device record that binding still holds (`light_device::ping::governing_record`).
fn device_pushable_with(storage: &crate::storage::Storage, node_id: &str, binding: Option<&crate::light_binding::BindingReach>,
                        onchain: bool, epoch: u64, now: u64) -> bool {
    match storage.device_record(node_id).filter(|r| !crate::light_device::attest::binding_released_by(binding, r)) {
        Some(r) => r.state_now(onchain, epoch, now).counts(),
        None => crate::light_device::ping::legacy_counts(epoch),
    }
}

// ── U11: "I'm back" ──

#[derive(Debug, Default, Deserialize)]
pub(super) struct WakeRequest {
    #[serde(default)] pub(super) node_id: String,
    /// Set by a genesis handing the wake to the node's owner; honoured only from a genesis address.
    #[serde(default)] pub(super) fwd: bool,
}

/// The answers of `/light-node/wake`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WakeAnswer {
    Sent,
    AlreadyAnswered,
    NoDevice,
    NotRegistered,
    Cooldown,
}

impl WakeAnswer {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            WakeAnswer::Sent => "sent",
            WakeAnswer::AlreadyAnswered => "already_answered",
            WakeAnswer::NoDevice => "no_device",
            WakeAnswer::NotRegistered => "not_registered",
            WakeAnswer::Cooldown => "cooldown",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [WakeAnswer::Sent, WakeAnswer::AlreadyAnswered, WakeAnswer::NoDevice, WakeAnswer::NotRegistered, WakeAnswer::Cooldown]
            .into_iter().find(|a| a.as_str() == s)
    }

    pub(crate) fn to_json(self, node_id: &str, retry_after: Option<u64>) -> Value {
        let mut v = json!({ "success": self == WakeAnswer::Sent, "reason": self.as_str(), "node_id": node_id });
        if let Some(s) = retry_after { v["retry_after_seconds"] = json!(s); }
        v
    }
}

/// What a wake finds before anything is sent; the same at every genesis (the chain row, the binding
/// row, the push record, this epoch's gossiped answers). Ok carries the channel to push on, or None for a
/// device with no push channel (a polling one), which is woken the way the pinger wakes it: a stamped
/// challenge for its next poll. So `no_device` means exactly what the public status says (no device
/// bound) and never tells how a bound device is reached.
pub(crate) fn wake_precheck(storage: &crate::storage::Storage, node_id: &str, answered: bool) -> Result<Option<PushChannel>, WakeAnswer> {
    wake_registered(storage, node_id)?;
    if answered { return Err(WakeAnswer::AlreadyAnswered); }
    match device_reach(storage, node_id) {
        Some(channel) if device_layer_pushable(storage, node_id) => Ok(channel),
        _ => Err(WakeAnswer::NoDevice),
    }
}

/// The one check a genesis that does not own the node's shard makes itself (F9): the chain registered the node.
/// The binding row, the push record and the epoch's answers reach a non-owner only by chance, so everything else
/// is the owners' to answer.
pub(crate) fn wake_registered(storage: &crate::storage::Storage, node_id: &str) -> Result<(), WakeAnswer> {
    if !node_id.starts_with("light_") || node_id.len() > 128 || !storage.is_node_registration_onchain(node_id) {
        return Err(WakeAnswer::NotRegistered);
    }
    Ok(())
}

/// Where a wake for a node of `shard` goes out (U11): its owner sends it; any other genesis hands it on
/// once, to the owners in rank order; a backup owner sends it itself only when the ranks above it
/// cannot be reached. Returns (genesis to hand it to, in order; whether to send here after them).
pub(crate) fn wake_plan(shard: usize, our_idx: Option<usize>, forwarded: bool) -> (Vec<usize>, bool) {
    if forwarded { return (Vec::new(), true); }
    let owners = crate::node::light_shard_owners(shard);
    match our_idx.and_then(|i| crate::node::light_owner_rank(shard, i)) {
        Some(rank) => (owners[..rank].to_vec(), true),
        None => (owners.to_vec(), false),
    }
}

/// The wakes each node got at this sender: (epoch, wakes in it, time of the last).
pub(crate) struct WakeLedger {
    map: std::sync::OnceLock<DashMap<String, (u64, u32, u64)>>,
}

impl WakeLedger {
    pub(crate) const fn new() -> Self {
        WakeLedger { map: std::sync::OnceLock::new() }
    }

    /// Take one of the node's wakes in `epoch`. Ok carries the previous send time (for `release`); Err the
    /// seconds until the node may be woken again.
    pub(crate) fn reserve(&self, node_id: &str, epoch: u64, now: u64, secs_to_next_epoch: u64) -> Result<u64, u64> {
        let map = self.map.get_or_init(DashMap::new);
        if map.len() > 100_000 {
            map.retain(|_, e| e.0 >= epoch || now.saturating_sub(e.2) < WAKE_NODE_COOLDOWN_SECS);
        }
        let mut e = map.entry(node_id.to_string()).or_insert((epoch, 0, 0));
        if e.0 != epoch { *e = (epoch, 0, e.2); }
        if e.1 >= WAKES_PER_NODE_PER_EPOCH { return Err(secs_to_next_epoch.max(1)); }
        let since = now.saturating_sub(e.2);
        if e.2 > 0 && since < WAKE_NODE_COOLDOWN_SECS { return Err(WAKE_NODE_COOLDOWN_SECS - since); }
        let prev = e.2;
        *e = (epoch, e.1 + 1, now);
        Ok(prev)
    }

    /// Give back a wake whose push did not go out.
    pub(crate) fn release(&self, node_id: &str, epoch: u64, prev_last: u64) {
        if let Some(mut e) = self.map.get_or_init(DashMap::new).get_mut(node_id) {
            if e.0 == epoch && e.1 > 0 { *e = (epoch, e.1 - 1, prev_last); }
        }
    }
}

static WAKE_LEDGER: WakeLedger = WakeLedger::new();

fn our_genesis_idx() -> Option<usize> {
    let id = std::env::var("QNET_BOOTSTRAP_ID").ok()?;
    ["001", "002", "003", "004", "005"].iter().position(|g| *g == id)
}

/// How long a wake handed to one owner may take, connection included: three owners in turn stay inside the
/// cabinet's eight seconds.
const WAKE_FORWARD_SECS: u64 = 2;

/// Hand a wake to the genesis at `idx`; its answer when it gave one of the five. Over TLS only and within
/// WAKE_FORWARD_SECS: a plain retry after a timeout doubled the wait on an unreachable owner. An owner behind the
/// network answers 503 and is passed over like an unreachable one.
async fn forward_wake(idx: usize, node_id: &str) -> Option<Value> {
    let (ip, _) = crate::genesis_constants::GENESIS_NODE_IPS.get(idx)?;
    let body = json!({ "node_id": node_id, "fwd": true });
    let r = genesis_internal_call_tls(ip, "/api/v1/light-node/wake", |c, url| c.post(url).json(&body)
        .timeout(std::time::Duration::from_secs(WAKE_FORWARD_SECS))).await.ok()?;
    if !r.status().is_success() { return None; }
    let v: Value = r.json().await.ok()?;
    let answer = WakeAnswer::parse(v["reason"].as_str()?)?;
    Some(answer.to_json(node_id, v["retry_after_seconds"].as_u64()))
}

/// Send the wake from here, within the node's cap and the wake budget. A device with no push channel
/// gets its challenge for its next poll (`polling_challenge`), within the same cap. Close to the epoch's commit
/// (`push_lifetime`) an answer would count for nothing, so nothing goes out until the next epoch starts.
async fn send_wake(blockchain: &BlockchainNode, node_id: &str, channel: Option<&PushChannel>) -> (WakeAnswer, Option<u64>) {
    let storage = blockchain.get_storage();
    let tip = blockchain.get_height().await;
    let epoch = tip / EPOCH_BLOCKS;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let Some(ttl) = push_lifetime(epoch, tip) else {
        return (WakeAnswer::Cooldown, Some((EPOCH_BLOCKS - tip % EPOCH_BLOCKS).max(1)));
    };
    let Some(channel) = channel else {
        return match WAKE_LEDGER.reserve(node_id, epoch, now, EPOCH_BLOCKS - tip % EPOCH_BLOCKS) {
            Ok(_) => {
                store_polling_challenge(node_id, push_anchor(&storage, tip).as_deref(), now);
                PUSH_LEDGER.woke(node_id, tip / 60, true, now);
                if crate::node::is_debug() {
                    println!("[DBG][LIGHT] wake_sent node={} channel=polling epoch={}", node_id, epoch);
                }
                (WakeAnswer::Sent, None)
            }
            Err(retry) => (WakeAnswer::Cooldown, Some(retry)),
        };
    };
    let Some(anchor) = push_anchor(&storage, tip) else {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] wake_anchor_unavailable node={} tip={}", node_id, tip);
        }
        return (WakeAnswer::Cooldown, Some(60));
    };
    let prev = match WAKE_LEDGER.reserve(node_id, epoch, now, EPOCH_BLOCKS - tip % EPOCH_BLOCKS) {
        Ok(p) => p,
        Err(retry) => return (WakeAnswer::Cooldown, Some(retry)),
    };
    if !WAKE_RATE_LIMITER.try_acquire() {
        WAKE_LEDGER.release(node_id, epoch, prev);
        return (WakeAnswer::Cooldown, Some(1));
    }
    match deliver_push(channel, PushAction::Wake, &anchor, ttl).await {
        Ok(()) => {
            PUSH_LEDGER.woke(node_id, tip / 60, false, now);
            if crate::node::is_debug() {
                println!("[DBG][LIGHT] wake_sent node={} channel={} epoch={}", node_id, channel.name(), epoch);
            }
            (WakeAnswer::Sent, None)
        }
        Err(e) => {
            WAKE_LEDGER.release(node_id, epoch, prev);
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] wake_push_failed node={} channel={} err={}", node_id, channel.name(), e);
            }
            (WakeAnswer::Cooldown, Some(60))
        }
    }
}

/// `POST /api/v1/light-node/wake` ("I'm back"): one silent push to the node's bound device. Unsigned: the
/// worst a stranger can do is the node's few wakes of an epoch, silent pushes to the owner's own device
/// that carry nothing. Every answer is `WakeAnswer::to_json`; a shard owner behind the network gives its
/// `cooldown` with status 503, so a caller (a genesis handing the wake on, or the cabinet) asks the next owner.
pub(super) async fn handle_light_node_wake(
    req: WakeRequest,
    remote_addr: Option<std::net::SocketAddr>,
    from_page: bool,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use warp::http::StatusCode;
    let reply = |v: Value, code: StatusCode| Ok(warp::reply::with_status(warp::reply::json(&v), code));
    // Only another genesis forwards a wake past the address limit; a page never does (gate_client).
    let caller = gate_client(remote_addr, from_page).map(|a| a.ip().to_string()).unwrap_or_default();
    let forwarded = req.fwd && is_genesis_peer_ip(&caller);
    if !forwarded {
        if let Err(retry) = api_rate_limit_retry(remote_addr, "light_node_wake") {
            return reply(WakeAnswer::Cooldown.to_json(&req.node_id, Some(retry)), StatusCode::OK);
        }
    }
    let storage = blockchain.get_storage();
    let shard = crate::node::light_shard_of(&req.node_id);
    let owner = our_genesis_idx().and_then(|i| crate::node::light_owner_rank(shard, i)).is_some();
    if !owner && !forwarded {
        // F9: a non-owner checks the registration alone and hands the wake to the owners in rank order.
        if let Err(a) = wake_registered(&storage, &req.node_id) {
            return reply(a.to_json(&req.node_id, None), StatusCode::OK);
        }
        for idx in wake_plan(shard, our_genesis_idx(), false).0 {
            if let Some(v) = forward_wake(idx, &req.node_id).await {
                return reply(v, StatusCode::OK);
            }
        }
        return reply(WakeAnswer::Cooldown.to_json(&req.node_id, Some(60)), StatusCode::OK);
    }
    // F14: an owner behind the network holds a stale epoch and anchor; the next owner sends the wake.
    if this_genesis_behind() {
        return reply(WakeAnswer::Cooldown.to_json(&req.node_id, Some(60)), StatusCode::SERVICE_UNAVAILABLE);
    }
    let answered = blockchain.get_unified_p2p().map_or(false, |p| p.has_attestation_in_window(&req.node_id));
    let channel = match wake_precheck(&storage, &req.node_id, answered) {
        Ok(c) => c,
        Err(a) => return reply(a.to_json(&req.node_id, None), StatusCode::OK),
    };
    let (hand_to, send_here) = wake_plan(shard, our_genesis_idx(), forwarded);
    for idx in hand_to {
        if let Some(v) = forward_wake(idx, &req.node_id).await {
            return reply(v, StatusCode::OK);
        }
    }
    if !send_here {
        return reply(WakeAnswer::Cooldown.to_json(&req.node_id, Some(60)), StatusCode::OK);
    }
    let (answer, retry) = send_wake(&blockchain, &req.node_id, channel.as_ref()).await;
    reply(answer.to_json(&req.node_id, retry), StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::light_binding as lb;

    fn storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (s, dir)
    }

    fn keys_of(s: &serde_json::Map<String, Value>) -> Vec<&str> {
        let mut k: Vec<&str> = s.keys().map(|k| k.as_str()).collect();
        k.sort();
        k
    }

    #[test]
    fn no_push_names_the_node() {
        let node = "light_mobile_0123456789abcdef";
        let anchor = format!("{}:{}", 2_241_838u64, "ab".repeat(32));
        for action in [PushAction::Epoch, PushAction::Wake] {
            let data = push_data(action, &anchor, 1_800_000_000);
            assert_eq!(keys_of(data.as_object().unwrap()), vec!["action", "anchor", "sent_at"]);
            assert_eq!(data["sent_at"], json!("1800000000"), "a string, the one value type the provider takes");
            let m = fcm_message("tok", action, &anchor, 1_800_000_000, 3600);
            assert_eq!(m["message"]["data"], data, "the same data on every platform");
            let wire = m.to_string();
            for leak in [node, "node_id", "challenge", "response_url", "ping_response", "notification"] {
                assert!(!wire.contains(leak), "{leak} in {wire}");
            }
            assert_eq!(m["message"]["android"], json!({"collapse_key": "epoch", "ttl": "3600s", "priority": "high"}));
            let h = &m["message"]["apns"]["headers"];
            assert_eq!((h["apns-push-type"].as_str(), h["apns-priority"].as_str(), h["apns-collapse-id"].as_str()),
                       (Some("background"), Some("5"), Some("epoch")));
            assert_eq!(h["apns-expiration"].as_str(), Some("1800003600"));
            assert_eq!(m["message"]["apns"]["payload"]["aps"], json!({"content-available": 1}));
        }
        assert_eq!(push_data(PushAction::Wake, "5:ab", 7)["action"], json!("wake"));
        // The pinger builds no other payload: the old one carried the node id, a challenge and a URL.
        let pinger = include_str!("light_nodes.rs");
        for gone in ["\"response_url\"", "\"ping_response\"", "\"quantum_secure\""] {
            assert!(!pinger.contains(gone), "{gone} is still built");
        }
    }

    #[test]
    fn the_anchor_is_a_block_of_the_current_epoch_this_node_holds() {
        let (s, _d) = storage();
        let e = EPOCH_BLOCKS;
        for h in [10 * e, 10 * e + 1, 10 * e + 7] {
            s.save_microblock_hash(h, &[h as u8; 32]).unwrap();
        }
        assert_eq!(push_anchor(&s, 10 * e + 9), Some(format!("{}:{}", 10 * e + 7, hex::encode([(10 * e + 7) as u8; 32]))));
        // Two below the tip would fall in the last epoch: the epoch's first block instead.
        assert_eq!(push_anchor(&s, 10 * e + 1), Some(format!("{}:{}", 10 * e, hex::encode([(10 * e) as u8; 32]))));
        assert_eq!(push_anchor(&s, 10 * e), Some(format!("{}:{}", 10 * e, hex::encode([(10 * e) as u8; 32]))));
        assert_eq!(push_anchor(&s, 10 * e + 50), None, "a block this node lacks: no push rather than a bad anchor");
    }

    /// A polling device answers the block the pushed devices answer with, whichever genesis it polled: the
    /// relay of that answer is credited by every shard owner, where a server stamp would count only at its
    /// issuer (a non-owner's own credit is in no owner's bitmap).
    #[test]
    fn a_polling_device_gets_the_anchor_every_shard_owner_credits_on_relay() {
        use crate::light_device::ping::{self, ReplyRefusal};
        let (s, _d) = storage();
        let e = EPOCH_BLOCKS;
        let tip = 10 * e + 9;
        s.save_microblock_hash(10 * e + 7, &[7u8; 32]).unwrap();
        let node = "light_mobile_0123456789abcdef";
        let now = 1_800_000_000;
        let anchor = push_anchor(&s, tip).expect("the block two below the tip");
        let (c, exp) = polling_challenge(node, Some(&anchor), now);
        assert_eq!(c, format!("selfattest:{}", anchor));
        assert!(exp > now);
        let a = ping::Anchor::parse(&c).expect("the self-attestation form every installed app signs");
        assert_eq!(a.height, 10 * e + 7);
        assert_eq!(ping::relay_anchor(&c, "ping_dilithium:00", a.height).map(|x| x.height), Ok(a.height));
        assert_eq!(ping::relay_anchor(&c, "ping_dilithium:00", tip).map(|x| x.height), Ok(a.height),
                   "relayed with a later height of its epoch, as a genesis of the previous binary does");
        assert!(polling_challenge_answerable(&c, tip));
        assert!(!polling_challenge_answerable(&c, 11 * e), "an anchor of an epoch that ended is not handed out");
        // A node lacking the anchor's block falls back to its server stamp, handed out while legacy replies
        // count and credited at this genesis alone.
        let (stamp, _) = polling_challenge(node, None, now);
        assert!(ping::Anchor::parse(&stamp).is_none() && stamp.len() == 80);
        assert!(polling_challenge_answerable(&stamp, tip));
        assert_eq!(ping::relay_anchor(&stamp, "ping_dilithium:00", tip).err(), Some(ReplyRefusal::StampOnRelay));
    }

    /// Whom the pinger pushes, on the rule of a window before the spaced rounds (`light_push_target`: each slot a due
    /// point of its own, so once a slot).
    #[test]
    fn the_pinger_pushes_only_on_chain_nodes_with_a_bound_device_once_a_slot_before_the_spaced_rounds() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        let epoch = 9_000_001 * SLOTS_PER_EPOCH + 17;
        assert!(!light_push_target(&s, &node, epoch), "not on chain");
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        assert!(!light_push_target(&s, &node, epoch), "on chain, no device bound");
        let (pp, _) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        let seq = 1_800_000_000;
        let cert = hex::encode(d3::detached_sign(lb::delegation_v2_message(&pp_hex, &node, seq).as_bytes(), &sk).as_bytes());
        s.bind_light_v2(&node, &pp_hex, &cert, &pk_hex, seq, seq).unwrap().unwrap();
        assert!(light_push_target(&s, &node, epoch), "on chain and bound");
        PUSH_LEDGER.record(&node, epoch, SendOutcome::Accepted, 1_800_000_000);
        assert!(!light_push_target(&s, &node, epoch), "pushed in this slot");
        assert!(light_push_target(&s, &node, epoch + 1), "the next slot, a due point of its own before the spaced rounds");
        assert!(light_push_target(&s, &node, epoch + SLOTS_PER_EPOCH), "and again next epoch");
        // After an unbind nothing is pushed, whatever push record a raced write could leave.
        s.withdraw_light_binding(&node, seq, &pk_hex, None, |st| lb::admit_unbind(st, seq).map(|_| true))
            .unwrap().unwrap();
        assert!(!light_push_target(&s, &node, epoch + 2), "unbound");
        s.save_fcm_token(&node, "tok", "fcm", None, seq + 9).unwrap();
        assert!(!light_push_target(&s, &node, epoch + 2), "a withdrawn binding links nothing");
        // A legacy binding (installed apps) still counts as a linked device.
        let legacy = "light_mobile_legacy00000000";
        s.save_node_registration_at_height_burn(legacy, "light", "w", 70.0, 100, "b").unwrap();
        s.save_light_ping_keys(legacy, &pp_hex, "legacycert").unwrap();
        assert!(light_push_target(&s, legacy, epoch));
        // So does an installed app's push channel whose key has not reached this genesis yet (a record
        // from before writers were kept); a node the chain registered with nothing linked gets nothing.
        let early = "light_mobile_early000000000";
        s.save_node_registration_at_height_burn(early, "light", "w2", 70.0, 100, "b2").unwrap();
        assert!(!light_push_target(&s, early, epoch), "registered, never linked");
        s.save_fcm_token(early, "", "polling", None, 3).unwrap();
        assert!(!light_push_target(&s, early, epoch), "a polling record is no push channel");
        s.save_fcm_token(early, "tok", "fcm", None, 4).unwrap();
        assert!(light_push_target(&s, early, epoch));
    }

    /// The channel is read from the push record only when it belongs to the binding held here (review r2,
    /// defect 1): a replaced device's record, a legacy record for a v2 binding and a record written under
    /// another wallet key give none; the device gets a challenge and the record reads as degraded, so it
    /// is pulled again. A legacy row the chain does not vouch for links nothing, whether or not the check
    /// at the apply ran.
    #[test]
    fn only_a_record_of_the_binding_held_here_is_a_push_channel() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        let bind = |seq: u64| {
            let (pp, _) = d3::keypair();
            let pp_hex = hex::encode(pp.as_bytes());
            let cert = hex::encode(d3::detached_sign(lb::delegation_v2_message(&pp_hex, &node, seq).as_bytes(), &sk).as_bytes());
            s.bind_light_v2(&node, &pp_hex, &cert, &pk_hex, seq, seq).unwrap().unwrap();
        };
        // Phone A bound at 100 with token A; phone B binds at 200 but its record has not reached here.
        bind(100);
        s.save_fcm_token_seq(&node, "tok_a", "fcm", None, 100, 100).unwrap();
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_a".into())));
        bind(200);
        assert_eq!(push_channel(&s, &node), None, "the old phone's record is no channel of the new binding");
        assert_eq!(wake_precheck(&s, &node, false), Ok(None), "a wake is a challenge, not a push to the old phone");
        assert!(light_push_target(&s, &node, 7), "still pushed: by a challenge");
        assert!(push_record_degraded(&s, &node), "and pulled again");
        // The pulled record of the binding held here heals it.
        assert!(crate::rpc::apply_pulled_push_record(&s, None, &node, "tok_b", "fcm", None, 200, 200, ""));
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_b".into())));
        assert!(!push_record_degraded(&s, &node));

        // A legacy node: a record written under another wallet key is no channel of the owner's row, is
        // refused once the chain vouches for the row, and the owner's own record displaces it.
        let (lpk, lsk) = d3::keypair();
        let lpk_hex = hex::encode(lpk.as_bytes());
        let lwallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&lpk_hex).unwrap();
        let lnode = crate::rpc::generate_light_node_pseudonym(&lwallet);
        let (mpk, msk) = d3::keypair();
        let mpk_hex = hex::encode(mpk.as_bytes());
        let (pp, _) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        // Before the registration: a planted row and record under another key (review r2, defect 1 (b)).
        let planted = hex::encode(d3::detached_sign(lb::delegation_v1_message(&pp_hex, &lnode).as_bytes(), &msk).as_bytes());
        s.save_light_ping_keys_identity(&lnode, &pp_hex, &planted, &mpk_hex).unwrap();
        assert!(s.save_fcm_token_by(&lnode, "tok_m", "fcm", None, 10, &lb::record_writer(&mpk_hex)).unwrap());
        s.save_node_registration_at_height_burn_vrf(&lnode, "light", &lwallet, 70.0, 100, "", Some(lpk.as_bytes())).unwrap();
        assert!(!device_linked(&s, &lnode), "a row the chain does not vouch for links nothing, checked or not");
        assert_eq!(wake_precheck(&s, &lnode, false), Err(WakeAnswer::NoDevice));
        // With no row the chain vouches for, a record links the device only under the committed key.
        let (cpk, _) = d3::keypair();
        let cpk_hex = hex::encode(cpk.as_bytes());
        let cwallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&cpk_hex).unwrap();
        let cnode = crate::rpc::generate_light_node_pseudonym(&cwallet);
        s.save_node_registration_at_height_burn_vrf(&cnode, "light", &cwallet, 70.0, 100, "", Some(cpk.as_bytes())).unwrap();
        s.save_fcm_token_by(&cnode, "tok_planted", "fcm", None, 10, &lb::record_writer(&mpk_hex)).unwrap();
        assert!(!device_linked(&s, &cnode), "a record written under another key, no row: nothing linked");
        assert_eq!(wake_precheck(&s, &cnode, false), Err(WakeAnswer::NoDevice));
        s.save_fcm_token_by(&cnode, "tok_owner", "fcm", None, 11, &lb::record_writer(&cpk_hex)).unwrap();
        assert_eq!(push_channel(&s, &cnode), Some(PushChannel::Fcm("tok_owner".into())),
                   "an installed app's record under the committed key, before its row arrives");
        // The owner's row arrives (gossip, pull): the planted record is still no channel of it.
        let own = hex::encode(d3::detached_sign(lb::delegation_v1_message(&pp_hex, &lnode).as_bytes(), &lsk).as_bytes());
        s.save_light_ping_keys_identity(&lnode, &pp_hex, &own, &lpk_hex).unwrap();
        assert!(device_linked(&s, &lnode));
        assert_eq!(push_channel(&s, &lnode), None, "a record written under another key");
        assert!(!s.save_fcm_token_by(&lnode, "tok_m2", "fcm", None, 50, &lb::record_writer(&mpk_hex)).unwrap(),
                "refused while the owner's row is vouched for");
        assert!(s.save_fcm_token_by(&lnode, "tok_o", "fcm", None, 5, &lb::record_writer(&lpk_hex)).unwrap(),
                "the owner's own record displaces it, whatever the times");
        assert_eq!(push_channel(&s, &lnode), Some(PushChannel::Fcm("tok_o".into())));
        // A legacy record for a v2 binding is none of its channel.
        s.save_fcm_token(&node, "legacy", "fcm", None, 1_000).unwrap();
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_b".into())), "never written over a v2 record");
    }

    fn light_wallet() -> (pqcrypto_mldsa::mldsa65::PublicKey, String, String, String) {
        use pqcrypto_traits::sign::PublicKey as _;
        let (pk, _) = pqcrypto_mldsa::mldsa65::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        (pk, pk_hex, wallet, node)
    }

    /// Review r3 (consensus D1, attacker 1): a registration applied before key commitments has no
    /// commitment to judge a record's writer by, and every write path after it applied checks the
    /// wallet-derived key. With no row here its installed app's stamped record links the device, and the
    /// write side merges such records by time, as before.
    #[test]
    fn a_registration_without_a_commitment_keeps_its_installed_app_pushed_with_no_row_here() {
        let (s, _d) = storage();
        let (_pk, pk_hex, wallet, node) = light_wallet();
        let writer = lb::record_writer(&pk_hex);
        assert!(s.save_fcm_token_by(&node, "tok_0", "fcm", None, 5, &writer).unwrap());
        assert_eq!(device_reach(&s, &node), None, "not on chain here: nothing linked");
        s.save_node_registration_at_height_burn(&node, "light", &wallet, 70.0, 100, "b").unwrap();
        assert_eq!(s.light_registration_commitment(&node), Some(None), "the fixture carries no commitment");
        assert!(s.save_fcm_token_by(&node, "tok_1", "fcm", None, 6, &writer).unwrap(), "a legacy refresh's stamped record");
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_1".into())));
        assert!(light_push_target(&s, &node, 9_100_001) && !push_record_degraded(&s, &node));
        assert_eq!(wake_precheck(&s, &node, false), Ok(Some(PushChannel::Fcm("tok_1".into()))));
        assert!(!light_poll_allowed(&s, &node), "a pushed device");
        // A pulled copy stamped by another genesis is taken the same way.
        assert!(crate::rpc::apply_pulled_push_record(&s, None, &node, "tok_2", "fcm", None, 7, 0, &writer));
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_2".into())));
    }

    /// Review r3 (consensus D2, attacker 4): with no binding row here, an on-chain registration's
    /// commitment is the one key a legacy record may be written under, as it is the one the read takes:
    /// another key's record is refused whatever its time (the sync included), the owner's displaces one
    /// planted before the registration applied, and a record from an older peer (no writer) still merges
    /// by time.
    #[test]
    fn with_no_row_here_the_commitment_decides_whose_legacy_record_is_written() {
        use pqcrypto_traits::sign::PublicKey as _;
        let (s, _d) = storage();
        let (pk, pk_hex, wallet, node) = light_wallet();
        let (_m, m_hex, _, _) = light_wallet();
        let (own, planted) = (lb::record_writer(&pk_hex), lb::record_writer(&m_hex));
        // Before the registration applies records merge by time: the later plant is held.
        assert!(s.save_fcm_token_by(&node, "tok_o", "fcm", None, 100, &own).unwrap());
        assert!(s.save_fcm_token_by(&node, "tok_m", "fcm", None, 200, &planted).unwrap());
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        assert_eq!(push_channel(&s, &node), None, "the plant links nothing");
        assert!(push_record_degraded(&s, &node));
        // The owner's record displaces it whatever the times: a pull of the owner's copy, or its app's refresh.
        assert!(crate::rpc::apply_pulled_push_record(&s, None, &node, "tok_o", "fcm", None, 100, 0, &own));
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_o".into())));
        // Another key's record is refused, later or not, and by the legacy sync too.
        assert!(!s.save_fcm_token_by(&node, "tok_m2", "fcm", None, 900, &planted).unwrap());
        let sync = FcmTokenSyncRequest {
            pseudonym: node.clone(), token: "tok_m3".into(), push_type: "fcm".into(), endpoint: None,
            origin_ip: String::new(), ts: Some(950), seq: None, proof: None, writer: Some(planted.clone()), platform: None, model: None,
        };
        assert_eq!(apply_token_sync(&s, None, &sync, 1_000), SyncOutcome::Stale("stale"));
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_o".into())));
        // An older peer's record carries no writer and merges by time, as before the roll.
        assert!(s.save_fcm_token(&node, "tok_old_peer", "fcm", None, 960).unwrap());
        assert_eq!(push_channel(&s, &node), Some(PushChannel::Fcm("tok_old_peer".into())));
    }

    /// Review r3 (attacker 2): the endpoint the genesis nodes POST to on each push and wake passes the
    /// endpoint check on every path - the legacy refresh, the sync, the pull - and one stored by a path
    /// that never ran it is no channel and is never delivered to. An address in place of a name is a
    /// public one and no genesis node's.
    #[tokio::test]
    async fn no_path_aims_the_genesis_posts_at_an_unchecked_endpoint() {
        let genesis = format!("https://{}/api/v1/light-node/wake", crate::genesis_constants::GENESIS_NODE_IPS[0].0);
        for bad in ["http://127.0.0.1:8001/api/v1/light-node/wake", "https://127.0.0.1/x", "https://10.1.2.3/x",
                    "https://172.16.0.9/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://0.0.0.0/x",
                    "https://100.64.0.1/x", "https://255.255.255.255/x", "https://localhost/x", "https://[::1]/x",
                    "https://0x7f.1/x", genesis.as_str()] {
            assert!(validate_unified_push_endpoint(bad).is_err(), "{bad}");
        }
        for good in ["https://ntfy.sh/topic", "https://push.example.net/x", "https://93.184.216.34/up"] {
            assert!(validate_unified_push_endpoint(good).is_ok(), "{good}");
        }
        let (s, _d) = storage();
        let node = "light_mobile_endpoint0000000";
        s.save_node_registration_at_height_burn(node, "light", "w", 70.0, 100, "b").unwrap();
        s.save_light_ping_keys(node, "ab", "legacycert").unwrap();
        let bad = "http://127.0.0.1:8001/api/v1/light-node/wake";
        let sync = FcmTokenSyncRequest {
            pseudonym: node.into(), token: String::new(), push_type: "unifiedpush".into(), endpoint: Some(bad.into()),
            origin_ip: String::new(), ts: Some(5), seq: None, proof: None, writer: None, platform: None, model: None,
        };
        assert_eq!(apply_token_sync(&s, None, &sync, 10), SyncOutcome::Refused("bad_endpoint"));
        assert!(!crate::rpc::apply_pulled_push_record(&s, None, node, "", "unifiedpush", Some(bad), 5, 0, ""));
        assert!(s.get_fcm_entry(node).is_none(), "neither path stored it");
        // A record an older binary stored unchecked: no channel, so the device gets a challenge instead.
        s.save_fcm_token(node, "", "unifiedpush", Some(bad), 6).unwrap();
        assert_eq!(push_channel(&s, node), None);
        assert_eq!(wake_precheck(&s, node, false), Ok(None));
        let err = deliver_push(&PushChannel::UnifiedPush(bad.into()), PushAction::Wake, "5:ab", 60).await.unwrap_err();
        assert!(!err.contains("127.0.0.1"), "the endpoint is not logged");
        // The legacy token refresh checks the endpoint in either form.
        let src = include_str!("light_nodes.rs");
        let refresh = &src[src.find("async fn handle_light_node_token_refresh(").unwrap()..];
        let refresh = &refresh[..refresh.find("let inner_sig =").unwrap()];
        assert!(refresh.contains("let endpoint_sent = if req.seq.is_some() { Some(target.as_str()) } else { req.endpoint.as_deref()"));
        assert!(refresh.contains("validate_unified_push_endpoint(ep)"));
    }

    /// Review r3 (attacker 3): whether a device polls, and the resident channel, follow the record that
    /// belongs to the device linked here: a record written under another key leaves a polling owner its
    /// challenge and the resident entry polling; the owner's own record makes it pushed.
    #[tokio::test]
    async fn a_record_someone_else_left_never_locks_a_polling_device_out() {
        use crate::unified_p2p::{NodeType, PushType, Region, SimplifiedP2P};
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = std::sync::Arc::new(crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        let (_m, m_hex, _, _) = light_wallet();
        // A plant before the registration applied, then the owner's polling app: its row, no record.
        assert!(s.save_fcm_token_by(&node, "tok_m", "fcm", None, 10, &lb::record_writer(&m_hex)).unwrap());
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        let (pp, _) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        let cert = hex::encode(d3::detached_sign(lb::delegation_v1_message(&pp_hex, &node).as_bytes(), &sk).as_bytes());
        s.save_light_ping_keys_identity(&node, &pp_hex, &cert, &pk_hex).unwrap();
        assert!(light_poll_allowed(&s, &node), "the planted record is no push channel of the owner's device");
        assert_eq!(wake_precheck(&s, &node, false), Ok(None), "the pinger and a wake leave it a challenge");
        let p2p = SimplifiedP2P::new("test_poll_node".into(), NodeType::Super, Region::Europe, 8112);
        p2p.restore_light_nodes_from_storage(vec![(node.clone(), wallet.clone(), "light".into(), 1)]);
        p2p.update_device_tokens_from_storage(&s);
        assert!(matches!(p2p.get_light_node(&node).map(|n| n.push_type), Some(PushType::Polling)), "not at boot");
        p2p.refresh_light_node_push_channel(&s, &node);
        assert!(matches!(p2p.get_light_node(&node).map(|n| n.push_type), Some(PushType::Polling)), "nor on an event");
        // The owner's own record displaces the plant: pushed, and the resident entry says so.
        assert!(s.save_fcm_token_by(&node, "tok_o", "fcm", None, 5, &lb::record_writer(&pk_hex)).unwrap());
        assert!(!light_poll_allowed(&s, &node));
        p2p.refresh_light_node_push_channel(&s, &node);
        assert!(matches!(p2p.get_light_node(&node).map(|n| n.push_type), Some(PushType::FCM)));
        // The poll route decides from storage, never the resident entry.
        let src = include_str!("light_nodes.rs");
        let poll = &src[src.find("async fn handle_light_node_pending_challenge(").unwrap()..];
        let poll = &poll[..poll.find("// Check for pending challenge").unwrap()];
        assert!(poll.contains("light_poll_allowed(") && !poll.contains("push_type"));
    }

    /// A push to a token the provider no longer knows is told apart from a transient failure: it starts
    /// the missed-unbind repair. UnifiedPush follows no redirect.
    #[test]
    fn a_gone_push_target_is_told_apart_and_no_redirect_is_followed() {
        assert!(push_target_gone("FCM API error: 404 Not Found - {\"error\":{\"status\":\"NOT_FOUND\",\"details\":[{\"errorCode\":\"UNREGISTERED\"}]}}"));
        assert!(push_target_gone("unifiedpush status 404 Not Found"));
        assert!(push_target_gone("unifiedpush status 410 Gone"));
        for transient in ["FCM API error: 429 Too Many Requests - quota", "FCM API error: 503 Service Unavailable - x",
                          "FCM network error: timed out", "unifiedpush status 307 Temporary Redirect",
                          "FCM API error: 400 Bad Request - INVALID_ARGUMENT"] {
            assert!(!push_target_gone(transient), "{transient}");
        }
        let src = include_str!("light_push.rs");
        let client = &src[src.find("fn push_http()").unwrap()..];
        assert!(client[..client.find("fn push_target_gone").unwrap()].contains(".redirect(reqwest::redirect::Policy::none())"));
        // The pinger reads the channel from the push record alone (never the resident entry), in the selection
        // (`push_reach_at`), and repairs on a gone target.
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("for (light_node, role, channel) in nodes_to_ping {"));
        assert!(include_str!("../unified_p2p/propagation.rs")
            .contains("crate::rpc::push_reach_at(storage, &node_id, device_epoch, device_now)"));
        assert!(!pinger.contains("light_node.unified_push_endpoint"), "no fallback to the resident entry");
        assert!(pinger.contains("repair_withdrawn_binding(node_id, abs_slot / 240)"));
    }

    /// The selection itself applies the rule, outside the registry lock.
    #[test]
    fn the_ping_selection_applies_the_push_target_rule() {
        let prop = include_str!("../unified_p2p/propagation.rs");
        let body = &prop[prop.find("pub(crate) fn get_light_nodes_to_ping").expect("selection")..];
        let body = &body[..body.find("fn maybe_pull_push_channel").expect("the next function")];
        let drop_registry = body.find("drop(registry)").expect("the registry lock is released");
        let rule = body.find("crate::rpc::push_reach_at(").expect("the rule");
        assert!(drop_registry < rule, "storage reads run after the lock is released");
    }

    #[test]
    fn a_wake_answers_why_before_it_sends() {
        let (s, _d) = storage();
        let node = "light_mobile_wake000000000000";
        assert_eq!(wake_precheck(&s, "super_x", false), Err(WakeAnswer::NotRegistered));
        assert_eq!(wake_precheck(&s, node, false), Err(WakeAnswer::NotRegistered));
        s.save_node_registration_at_height_burn(node, "light", "w", 70.0, 100, "b").unwrap();
        assert_eq!(wake_precheck(&s, node, true), Err(WakeAnswer::AlreadyAnswered));
        assert_eq!(wake_precheck(&s, node, false), Err(WakeAnswer::NoDevice), "no device bound");
        // A bound device with no push channel is woken by a challenge for its next poll: the answer does
        // not tell a polling device from a pushed one.
        s.save_light_ping_keys(node, "ab", "legacycert").unwrap();
        assert_eq!(wake_precheck(&s, node, false), Ok(None), "bound, nothing to push to");
        s.save_fcm_token(node, "", "polling", None, 5).unwrap();
        assert_eq!(wake_precheck(&s, node, false), Ok(None), "a polling device");
        s.save_fcm_token(node, "tok", "fcm", None, 6).unwrap();
        assert_eq!(wake_precheck(&s, node, false), Ok(Some(PushChannel::Fcm("tok".into()))));
        s.save_fcm_token(node, "", "unifiedpush", Some("https://push.example.net/x"), 7).unwrap();
        assert_eq!(wake_precheck(&s, node, false), Ok(Some(PushChannel::UnifiedPush("https://push.example.net/x".into()))));
        // An installed app whose key has not reached this genesis yet is woken on its channel.
        let early = "light_mobile_wake_early00000";
        s.save_node_registration_at_height_burn(early, "light", "w2", 70.0, 100, "b2").unwrap();
        s.save_fcm_token(early, "tok2", "fcm", None, 8).unwrap();
        assert_eq!(wake_precheck(&s, early, false), Ok(Some(PushChannel::Fcm("tok2".into()))));
        // The answers the site reads, and success only for a push that went out.
        for (a, r) in [(WakeAnswer::Sent, "sent"), (WakeAnswer::AlreadyAnswered, "already_answered"),
                       (WakeAnswer::NoDevice, "no_device"), (WakeAnswer::NotRegistered, "not_registered"),
                       (WakeAnswer::Cooldown, "cooldown")] {
            let j = a.to_json(node, None);
            assert_eq!((j["reason"].as_str(), j["success"].as_bool()), (Some(r), Some(a == WakeAnswer::Sent)));
            assert_eq!(WakeAnswer::parse(r), Some(a));
        }
        assert_eq!(WakeAnswer::Cooldown.to_json(node, Some(42))["retry_after_seconds"], json!(42));
    }

    #[test]
    fn only_the_shard_owner_sends_a_wake() {
        for shard in 0..5usize {
            let owners = crate::node::light_shard_owners(shard);
            // The owner sends; nobody else is asked.
            assert_eq!(wake_plan(shard, Some(owners[0]), false), (vec![], true));
            // A backup asks the ranks above it first and sends only if none can be reached.
            assert_eq!(wake_plan(shard, Some(owners[1]), false), (vec![owners[0]], true));
            assert_eq!(wake_plan(shard, Some(owners[2]), false), (vec![owners[0], owners[1]], true));
            // Any other node only hands it on, in rank order, and never sends.
            let outsider = (0..5).find(|i| !owners.contains(i)).unwrap();
            assert_eq!(wake_plan(shard, Some(outsider), false), (owners.to_vec(), false));
            assert_eq!(wake_plan(shard, None, false), (owners.to_vec(), false), "a node that is no genesis");
            // A wake a genesis handed on is sent where it arrived.
            assert_eq!(wake_plan(shard, Some(outsider), true), (vec![], true));
        }
    }

    #[test]
    fn a_node_gets_three_wakes_an_epoch_ten_minutes_apart_and_a_failed_push_is_given_back() {
        let l = WakeLedger::new();
        let (n, e, t) = ("light_mobile_cap", 100u64, 1_800_000_000u64);
        assert_eq!(WAKES_PER_NODE_PER_EPOCH, 3, "unified plan R8");
        assert_eq!(l.reserve(n, e, t, 5000), Ok(0));
        assert_eq!(l.reserve(n, e, t + 100, 4900), Err(WAKE_NODE_COOLDOWN_SECS - 100), "ten minutes apart");
        assert_eq!(l.reserve(n, e, t + 600, 4400), Ok(t));
        assert_eq!(l.reserve(n, e, t + 1200, 3800), Ok(t + 600));
        assert_eq!(l.reserve(n, e, t + 3000, 2000), Err(2000), "three per epoch: wait for the next");
        // Next epoch, but inside the pause after the last wake.
        assert_eq!(l.reserve(n, e + 1, t + 1300, 14_000), Err(WAKE_NODE_COOLDOWN_SECS - 100));
        assert_eq!(l.reserve(n, e + 1, t + 1200 + WAKE_NODE_COOLDOWN_SECS, 14_000), Ok(t + 1200));
        // A push that did not go out gives its wake back, and the pause with it.
        let other = "light_mobile_cap2";
        let prev = l.reserve(other, e, t, 5000).unwrap();
        l.release(other, e, prev);
        assert_eq!(l.reserve(other, e, t + 1, 5000), Ok(0));
        assert_eq!(WAKE_PUSHES_PER_SEC * 10, FCM_PUSHES_PER_SEC, "wakes take a tenth of the push budget");
    }

    /// R-c: a push lives exactly until the commit of the epoch it is for, at one block a second, and none goes out
    /// at or after it, nor with less than the floor left; the provider message and the push server's header carry
    /// that lifetime. G-1: between the commit and the epoch's end the gap reply says only that the commit is closed,
    /// and names no later epoch.
    #[test]
    fn a_push_lives_until_its_epochs_commit_and_none_goes_out_after_it() {
        let e = 300u64;
        let start = e * EPOCH_BLOCKS;
        let commit = commit_opens_at(e);
        assert_eq!(commit, start + EPOCH_BLOCKS - crate::node::light_commit_window(e));
        assert_eq!(push_lifetime(e, start), Some(commit - start));
        assert_eq!(push_lifetime(e, commit - 600), Some(600));
        assert_eq!(PUSH_MIN_LIFETIME_SECS, 60, "a minute for the delivery, the app's wake and its answer");
        assert_eq!(push_lifetime(e, commit - PUSH_MIN_LIFETIME_SECS), Some(PUSH_MIN_LIFETIME_SECS));
        assert_eq!(push_lifetime(e, commit - PUSH_MIN_LIFETIME_SECS + 1), None, "under the floor");
        assert_eq!(push_lifetime(e, commit), None, "at the commit");
        assert_eq!(push_lifetime(e, start + EPOCH_BLOCKS - 1), None, "in the gap");
        assert_eq!(push_lifetime(e, start + EPOCH_BLOCKS), None, "the next epoch gets its own");
        assert_eq!(push_lifetime(e + 1, start + EPOCH_BLOCKS), Some(commit_opens_at(e + 1) - start - EPOCH_BLOCKS));
        assert!(!in_commit_gap(commit - 1) && in_commit_gap(commit) && in_commit_gap(start + EPOCH_BLOCKS - 1));
        assert!(!in_commit_gap(start + EPOCH_BLOCKS));
        let h = gap_reply("light_mobile_gap");
        assert_eq!(keys_of(h.as_object().unwrap()), vec!["counted", "error", "node_id", "reason", "success"]);
        assert_eq!((h["success"].clone(), h["counted"].clone(), h["reason"].clone()), (json!(false), json!(false), json!("epoch_closed")));
        assert!(!h.to_string().contains("next"), "nothing points at another epoch: {h}");
        let src = include_str!("light_push.rs");
        let body = &src[src.find("pub(crate) fn gap_reply(").unwrap()..];
        assert!(!body[..body.find("\n}\n").unwrap()].contains("EPOCH_BLOCKS"), "the reply is built from nothing of the next epoch");
        // The lifetime reaches the provider on both platforms, from the moment of sending.
        let m = fcm_message("tok", PushAction::Epoch, "1:ab", 1_800_000_000, 437);
        assert_eq!(m["message"]["android"]["ttl"], json!("437s"));
        assert_eq!(m["message"]["apns"]["headers"]["apns-expiration"], json!("1800000437"));
        assert_eq!(m["message"]["data"]["sent_at"], json!("1800000000"));
        let src = include_str!("light_push.rs");
        let up = &src[src.find("PushChannel::UnifiedPush(endpoint) => {").unwrap()..];
        assert!(up[..up.find("send().await").unwrap()].contains(".header(\"TTL\", ttl.to_string())"));
        // The pinger and a wake send nothing once the commit opened.
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("let open = push_lifetime(abs_slot / 240, tip).is_some();"));
        assert!(pinger.contains("let Some(ttl) = push_lifetime(abs_slot / 240, crate::node::local_height()) else { return; };"));
        let wake = &src[src.find("async fn send_wake(").unwrap()..];
        assert!(wake[..wake.find("let Some(channel) = channel").unwrap()].contains("push_lifetime(epoch, tip)"));
    }

    /// R-a: a round of three pushes a quarter of an hour apart and one retry round of three from an hour after the
    /// drawn slot, one a due point, while the node has not answered; its answer ends them, and the next epoch starts
    /// afresh. Before the spaced rounds each slot of a round was a due point of its own: three a slot apart.
    #[test]
    fn a_node_gets_a_round_and_a_retry_round_once_a_due_point_until_it_answers() {
        let l = PushLedger::new();
        let (n, t) = ("light_mobile_round", 1_800_000_000u64);
        let s = 500 * SLOTS_PER_EPOCH + 40;
        assert_eq!(MAX_PUSHES_PER_EPOCH, 6);
        assert_eq!((ROUND_SPACING_SLOTS, DUE_GRACE_SLOTS, MIN_PUSH_GAP_SLOTS, RETRY_AFTER_SLOTS), (15, 2, 13, 60));
        let offsets: Vec<(u64, u64)> = spaced_due_offsets().collect();
        assert_eq!(offsets, vec![(0, 0), (15, 15), (30, 30), (60, 0), (75, 15), (90, 30)]);
        for (i, (offset, into_round)) in offsets.iter().copied().enumerate() {
            let due = Due::spaced(s + offset, into_round);
            assert_eq!((due.repeat, due.round), (into_round > 0, s + offset - into_round));
            assert!(l.may_push(n, s + offset, &[due], || 0), "push {} at slot {}", i + 1, s + offset);
            l.record(n, s + offset, SendOutcome::Accepted, t + offset * 60);
            for late in 0..=DUE_GRACE_SLOTS {
                assert!(!l.may_push(n, s + offset + late, &[due], || 0), "one push a due point, its grace included");
            }
        }
        let past = Due::spaced(s + 105, 15);
        assert!(!l.may_push(n, s + 105, &[past], || 0), "a round and a retry round, no more");
        assert_eq!(l.woken_at(n, 500), Some(t), "the first push the provider took");
        assert!(l.may_push(n, s + SLOTS_PER_EPOCH, &[Due::spaced(s + SLOTS_PER_EPOCH, 0)], || 0), "the next epoch starts afresh");
        assert!(!l.may_push(n, s + SLOTS_PER_EPOCH + 15, &[Due::spaced(s + SLOTS_PER_EPOCH + 15, 15)], || 0),
                "a repeat of the next epoch only after its own first push");
        l.answered(n);
        assert_eq!(l.get(n), None, "an answer ends the epoch's record");
        // A failed send is spent for its due point, and the next due point may be taken.
        let m = "light_mobile_round_failed";
        l.record(m, s, SendOutcome::Failed, t);
        assert!(!l.may_push(m, s + 1, &[Due::spaced(s, 0)], || 0) && l.may_push(m, s + 15, &[Due::spaced(s + 15, 15)], || 0));
        assert_eq!(l.woken_at(m, 500), None);
        // Before the spaced rounds: once a slot, three a slot apart and the retry round, six in all.
        let o = "light_mobile_round_unspaced";
        for (i, slot) in [s, s + 1, s + 2, s + 60, s + 61, s + 62].into_iter().enumerate() {
            assert!(l.may_push(o, slot, &[Due::once(slot)], || 0), "push {} at slot {}", i + 1, slot);
            l.record(o, slot, SendOutcome::Accepted, t + i as u64 * 60);
            assert!(!l.may_push(o, slot, &[Due::once(slot)], || 0), "once a slot");
        }
        assert!(!l.may_push(o, s + 63, &[Due::once(s + 63)], || 0), "six, no more");
        // Pruning keeps only this epoch's silent nodes.
        l.record("light_old", s - SLOTS_PER_EPOCH, SendOutcome::Accepted, t);
        l.record("light_answered", s, SendOutcome::Accepted, t);
        l.prune(500, |id| id == "light_answered");
        assert!(l.get("light_old").is_none() && l.get("light_answered").is_none() && l.get(m).is_some());
        // The selection stops a counted node, and the pinger checks again right before it sends.
        let prop = include_str!("../unified_p2p/propagation.rs");
        assert!(prop.contains("if this_epoch(node_id) { continue; }"));
        let pinger = include_str!("light_nodes.rs");
        let send = &pinger[pinger.find("let Some(at) = EPOCH_PACER.reserve(").unwrap()..];
        assert!(send[..send.find("deliver_push(").unwrap()].contains("has_attestation_in_window(node_id)"));
    }

    /// The reason a miss names comes from what this genesis did for the node in the epoch, most telling first.
    #[test]
    fn each_miss_names_why_from_what_this_genesis_did() {
        let base = PushEntry { epoch: 77, ..PushEntry::default() };
        let now = 1_800_100_000u64;
        let miss = |e: &PushEntry| e.miss(now).map(|m| (m.reason, m.woken_at, m.answered_at, m.refused));
        assert_eq!(miss(&base), None, "nothing went out: nothing of the device's to report");
        assert_eq!(miss(&PushEntry { sends: 3, ..base.clone() }), Some((MissReason::NotSent, None, None, None)),
                   "every send failed at the provider: the system's miss, attributed");
        assert_eq!(miss(&PushEntry { unsent: 2, ..base.clone() }), Some((MissReason::NotSent, None, None, None)),
                   "shed by the pacing or no anchor: not sent");
        // Reached: a push the provider took, a challenge fetched, the token gone; never a failed, shed or unfetched one.
        for (e, reached) in [(PushEntry { woken_at: 9, ..base.clone() }, true), (PushEntry { fetched_at: 9, ..base.clone() }, true),
                             (PushEntry { gone: true, ..base.clone() }, true), (PushEntry { sends: 6, ..base.clone() }, false),
                             (PushEntry { unsent: 6, ..base.clone() }, false), (PushEntry { polled_slot: Some(3), ..base.clone() }, false),
                             (base.clone(), false)] {
            assert_eq!(e.reached(), reached, "{e:?}");
        }
        assert_eq!(miss(&PushEntry { woken_at: 9, ..base.clone() }), Some((MissReason::WokenNoAnswer, Some(9), None, None)));
        assert_eq!(miss(&PushEntry { polled_slot: Some(5), ..base.clone() }), Some((MissReason::NoPushAddress, None, None, None)));
        assert_eq!(miss(&PushEntry { polled_slot: Some(5), fetched_at: 12, ..base.clone() }),
                   Some((MissReason::WokenNoAnswer, Some(12), None, None)), "a fetched challenge woke it");
        assert_eq!(miss(&PushEntry { gone: true, ..base.clone() }), Some((MissReason::NoPushAddress, None, None, None)));
        assert_eq!(miss(&PushEntry { woken_at: 9, fetched_at: 4, ..base.clone() }).map(|m| m.1), Some(Some(4)), "the earlier wake");
        assert_eq!(miss(&PushEntry { woken_at: 9, refused: Some("device_counter"), refused_at: 30, ..base.clone() }),
                   Some((MissReason::AnswerRefused, Some(9), Some(30), Some("device_counter".to_string()))));
        let m = PushEntry { woken_at: 9, ..base.clone() }.miss(now).unwrap();
        assert_eq!((m.epoch, m.recorded_at, m.delivery_delay_secs), (77, now, None));
        // Woken by a push alone: the one wake a receipt may later show never reached the device.
        assert!(m.by_push);
        assert!(!PushEntry { polled_slot: Some(5), fetched_at: 12, ..base.clone() }.miss(now).unwrap().by_push);
        assert!(!PushEntry { woken_at: 9, polled_slot: Some(5), fetched_at: 12, ..base.clone() }.miss(now).unwrap().by_push,
                "a challenge the device fetched did reach it");
        // Only the nodes with no answer of the epoch here are misses.
        let entries = vec![("light_a".to_string(), PushEntry { woken_at: 9, ..base.clone() }),
                           ("light_b".to_string(), PushEntry { woken_at: 9, ..base.clone() }),
                           ("light_c".to_string(), base.clone())];
        let out = epoch_misses(entries, |id| id == "light_b", now);
        assert_eq!(out.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), vec!["light_a"]);
        // The ledger records each kind: a wake, a poll, a fetch (only of a challenge left here), a refusal.
        let l = PushLedger::new();
        let slot = 77 * SLOTS_PER_EPOCH + 3;
        l.woke("light_w", slot, false, 100);
        l.woke("light_w", slot + 5, false, 200);
        assert_eq!(l.get("light_w").map(|e| (e.woken_at, e.sends)), Some((100, 0)), "a wake is not one of the round's pushes");
        l.fetched("light_stranger", 77, 50);
        assert_eq!(l.len(), 1, "a poll in a node's name adds no entry");
        l.record("light_p", slot, SendOutcome::Polled, 10);
        l.fetched("light_p", 77, 60);
        assert_eq!(l.get("light_p").map(|e| (e.polled_slot, e.fetched_at)), Some((Some(slot), 60)));
        l.refused("light_p", 77, "device_counter", 70);
        l.refused("light_p", 77, "superseded", 80);
        assert_eq!(l.get("light_p").map(|e| (e.refused, e.refused_at)), Some((Some("device_counter"), 70)), "the first refusal");
        l.record("light_g", slot, SendOutcome::Gone, 10);
        assert!(l.gone_in("light_g", 77) && !l.gone_in("light_g", 78) && !l.gone_in("light_p", 77));
        // Taken out at the commit, older entries dropped with it.
        l.record("light_old", slot - SLOTS_PER_EPOCH, SendOutcome::Accepted, 5);
        let taken = l.take_epoch(77);
        assert_eq!(taken.len(), 3);
        assert_eq!(l.len(), 0);
    }

    /// Only the refusals a stranger cannot cause for someone else's node become `answer_refused`: a bad signature
    /// would otherwise hide that the device itself never answered.
    #[test]
    fn a_refusal_counts_only_when_the_node_itself_caused_it() {
        use crate::light_device::ping::ReplyRefusal as R;
        for r in [R::NotCounted, R::NoRecord, R::Counter, R::Legacy] {
            assert!(refusal_recorded(r.as_str()), "{}", r.as_str());
        }
        assert!(refusal_recorded("superseded"));
        for r in [R::Malformed, R::Anchor, R::StampOnRelay, R::CompactBin, R::DeviceSignature, R::Sigma] {
            assert!(!refusal_recorded(r.as_str()), "{}", r.as_str());
        }
        // The ingress records each refusal through the one gate.
        let src = include_str!("light_nodes.rs");
        let h = &src[src.find("async fn handle_light_node_ping_response(").unwrap()..];
        let h = &h[..h.find("pub(super) async fn handle_light_node_next_ping(").unwrap()];
        assert_eq!(h.matches("note_refusal(").count(), 3, "the device check, a replaced device and the shared verifier");
        assert_eq!(h.matches("now, &challenge, &signature);").count(), 3, "each with the reply, for the σ check");
    }

    /// M-7: a refusal the node's state decides before any signature is checked (`no_device_record`,
    /// `device_not_counted`, `legacy_after_enforcement`) is kept only once σ verifies under the node's own ping key and
    /// delegation; a stranger's reply with a garbage σ leaves no entry and no `answer_refused`. While the device layer is
    /// not served no device refusal is kept at all. `superseded` (σ checked under the presented key) stays as it was.
    #[test]
    fn a_refusal_decided_before_any_signature_is_kept_only_under_the_nodes_own_key() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        let (pp, ping_sk) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        let seq = 1_800_000_000;
        let cert = hex::encode(d3::detached_sign(lb::delegation_v2_message(&pp_hex, &node, seq).as_bytes(), &sk).as_bytes());
        s.bind_light_v2(&node, &pp_hex, &cert, &pk_hex, seq, seq).unwrap().unwrap();
        let tip = 400 * EPOCH_BLOCKS + 7;
        let challenge = format!("selfattest:{}:{}", tip - 2, "ab".repeat(32));
        let sig = |k: &d3::SecretKey| format!("ping_dilithium:{}", hex::encode(d3::detached_sign(challenge.as_bytes(), k).as_bytes()));
        let garbage = format!("ping_dilithium:{}", "00".repeat(lb::MLDSA65_SIG_HEX / 2));
        let (_, stranger) = d3::keypair();
        assert!(answer_signed_by_node(&s, &node, &challenge, &sig(&ping_sk)));
        assert!(!answer_signed_by_node(&s, &node, &challenge, &garbage));
        assert!(!answer_signed_by_node(&s, &node, &challenge, &sig(&stranger)), "another key");
        assert!(!answer_signed_by_node(&s, &node, "selfattest:1:00", &sig(&ping_sk)), "over another anchor");

        let l = PushLedger::new();
        for code in ["no_device_record", "device_not_counted", "legacy_after_enforcement"] {
            for forged in [&garbage, &sig(&stranger)] {
                note_refusal_in(&l, &s, &node, tip, code, 5, &challenge, forged, true, true);
            }
        }
        assert_eq!(l.len(), 0, "a stranger's reply leaves no entry");
        let misses = epoch_misses(l.take_epoch(400), |_| false, 9);
        assert!(misses.iter().all(|(_, m)| m.reason != MissReason::AnswerRefused), "and no answer_refused");
        // The device layer not served: no device refusal, even under the node's own key.
        for code in ["no_device_record", "device_not_counted", "device_counter"] {
            note_refusal_in(&l, &s, &node, tip, code, 5, &challenge, &sig(&ping_sk), true, false);
        }
        assert_eq!(l.len(), 0);
        // The node's own reply: kept, the first of the epoch only.
        note_refusal_in(&l, &s, &node, tip, "no_device_record", 5, &challenge, &sig(&ping_sk), true, true);
        note_refusal_in(&l, &s, &node, tip, "device_not_counted", 6, &challenge, &sig(&ping_sk), true, true);
        assert_eq!(l.get(&node).map(|e| (e.refused, e.refused_at)), Some((Some("no_device_record"), 5)));
        let m = epoch_misses(l.take_epoch(400), |_| false, 9);
        assert_eq!(m.iter().map(|(_, m)| (m.reason, m.refused.clone())).collect::<Vec<_>>(),
                   vec![(MissReason::AnswerRefused, Some("no_device_record".to_string()))]);
        // Not a device refusal: kept under the node's key whether or not the device layer is served.
        note_refusal_in(&l, &s, &node, tip, "legacy_after_enforcement", 7, &challenge, &sig(&ping_sk), true, false);
        assert_eq!(l.get(&node).and_then(|e| e.refused), Some("legacy_after_enforcement"));
        l.take_epoch(400);
        // `superseded`: its σ was checked under the presented key by the route; not anyone's signature here.
        note_refusal_in(&l, &s, &node, tip, "superseded", 8, &challenge, &garbage, true, true);
        assert_eq!(l.get(&node).and_then(|e| e.refused), Some("superseded"));
        l.take_epoch(400);
        // Never at a genesis that does not own the shard, never for a node not on chain, never for anyone's code.
        note_refusal_in(&l, &s, &node, tip, "no_device_record", 5, &challenge, &sig(&ping_sk), false, true);
        note_refusal_in(&l, &s, "light_mobile_not_registered", tip, "superseded", 5, &challenge, &garbage, true, true);
        note_refusal_in(&l, &s, &node, tip, "ping_signature", 5, &challenge, &sig(&ping_sk), true, true);
        assert_eq!(l.len(), 0);
    }

    /// E-1: the delivery delay is the time from sending to the answer less the app's own handling; both handling
    /// times come from the device's clock, so a device clock hours off measures the same.
    #[test]
    fn the_delivery_delay_is_free_of_the_devices_clock() {
        let now = 1_800_000_500u64;
        let sent = now - 400;
        for skew in [0i64, 3 * 3600, -5 * 3600, 86_400 * 30] {
            let dev = |t: u64| (t as i64 + skew) as u64;
            let t = AnswerTiming { sent_at: Some(sent), received_at: Some(dev(sent + 310)), answered_at: Some(dev(sent + 330)) };
            assert_eq!(t.measure(now), Delivery { delay_secs: Some(380), handling_secs: Some(20) }, "skew {skew}");
        }
        // Nothing told, or only part of it: no delay; handling stands on its own.
        assert_eq!(AnswerTiming::default().measure(now), Delivery::default());
        assert_eq!(AnswerTiming { sent_at: Some(sent), ..AnswerTiming::default() }.measure(now), Delivery::default());
        assert_eq!(AnswerTiming { received_at: Some(10), answered_at: Some(15), ..AnswerTiming::default() }.measure(now),
                   Delivery { delay_secs: None, handling_secs: Some(5) });
        // Out of range: answered before received, a send time ahead of this clock past the skew, a push older than
        // two epochs. A send time a little ahead (another genesis's clock) reads as no delay.
        assert_eq!(AnswerTiming { received_at: Some(20), answered_at: Some(15), ..AnswerTiming::default() }.measure(now).handling_secs, None);
        let full = |s: u64| AnswerTiming { sent_at: Some(s), received_at: Some(1), answered_at: Some(1) }.measure(now).delay_secs;
        assert_eq!(full(now + 60), Some(0));
        assert_eq!(full(now + SENT_AT_SKEW_SECS + 1), None);
        assert_eq!(full(now - MAX_DELIVERY_SECS), Some(MAX_DELIVERY_SECS));
        assert_eq!(full(now - MAX_DELIVERY_SECS - 1), None);
        // Handling a little longer than the transit (another genesis's clock) floors at zero; longer past that skew (a
        // device clock that jumped mid-answer) tells nothing, so no late answer dates its delivery before its push.
        assert_eq!(AnswerTiming { sent_at: Some(now - 10), received_at: Some(100), answered_at: Some(160) }.measure(now).delay_secs, Some(0));
        assert_eq!(AnswerTiming { sent_at: Some(now - 10), received_at: Some(100), answered_at: Some(100 + 10 + SENT_AT_SKEW_SECS) }.measure(now),
                   Delivery { delay_secs: Some(0), handling_secs: Some(10 + SENT_AT_SKEW_SECS) });
        let jumped = AnswerTiming { sent_at: Some(sent), received_at: Some(sent + 310), answered_at: Some(sent + 330 + 3600) };
        assert_eq!(jumped.measure(now), Delivery::default());
        assert_eq!(AnswerTiming { sent_at: None, ..jumped }.measure(now).handling_secs, Some(3620), "with no send time nothing to hold it against");
        // From the answer's fields, as strings or as the numbers the route turns into text; anything else is none.
        let mut p = HashMap::new();
        p.insert("sent_at".to_string(), "1800000100".to_string());
        p.insert("received_at".to_string(), " 1800000200 ".to_string());
        p.insert("answered_at".to_string(), "x".to_string());
        assert_eq!(AnswerTiming::from_params(&p), AnswerTiming { sent_at: Some(1_800_000_100), received_at: Some(1_800_000_200), answered_at: None });
        let body: HashMap<String, Value> = serde_json::from_value(json!({
            "node_id": "light_x", "sent_at": 1_800_000_100u64, "received_at": "1800000200", "flag": true,
            "nested": {"a": 1}, "list": [1], "none": null,
        })).unwrap();
        let f = answer_fields(body);
        assert_eq!(f.get("sent_at").map(String::as_str), Some("1800000100"));
        assert_eq!(f.get("received_at").map(String::as_str), Some("1800000200"));
        assert_eq!(f.get("flag").map(String::as_str), Some("true"));
        assert!(!f.contains_key("nested") && !f.contains_key("list") && !f.contains_key("none"));
        assert_eq!(AnswerTiming::from_params(&f).sent_at, Some(1_800_000_100));
        // The route takes the body through it.
        let routes = include_str!("mod.rs");
        assert!(routes.contains(".and(warp::body::json::<HashMap<String, Value>>().map(answer_fields))"));
    }

    fn miss(epoch: u64, reason: MissReason, woken: Option<u64>, at: u64) -> LightMiss {
        LightMiss { epoch, reason, woken_at: woken, answered_at: None, delivery_delay_secs: None, refused: None, recorded_at: at,
                    delivered_at: None, app_outcome: None, by_push: woken.is_some() }
    }

    /// The row: one per node, its last miss and last answer, read back exactly; anything else reads as none. A row of
    /// the first version is still read.
    #[test]
    fn the_push_row_round_trips_and_refuses_what_it_did_not_write() {
        let full = LightPushRow {
            miss: Some(LightMiss { epoch: 210, reason: MissReason::AnsweredLate, woken_at: Some(1_800_000_000),
                                   answered_at: Some(1_800_009_000), delivery_delay_secs: Some(0),
                                   refused: None, recorded_at: 1_800_009_000, delivered_at: Some(1_800_008_990),
                                   app_outcome: None, by_push: false }),
            answer: Some(LastAnswer { at: 1_799_990_000, delivery_delay_secs: Some(12), handling_secs: None }),
        };
        let refined = LightMiss { reason: MissReason::WokenNoAnswer, app_outcome: Some(AppOutcome::NoKey), by_push: true,
                                  answered_at: None, ..full.miss.clone().unwrap() };
        for row in [full.clone(), LightPushRow::default(), LightPushRow { miss: None, ..full.clone() },
                    LightPushRow { answer: None, ..full.clone() },
                    LightPushRow { miss: Some(refined.clone()), ..full.clone() },
                    LightPushRow { miss: Some(LightMiss { reason: MissReason::NotDelivered, ..refined.clone() }), answer: None },
                    LightPushRow { miss: Some(LightMiss { refused: Some("x".repeat(40)), ..full.miss.clone().unwrap() }), answer: None }] {
            let back = LightPushRow::decode(&row.encode()).expect("decodes");
            let want_refused = row.miss.as_ref().and_then(|m| m.refused.clone()).map(|r| r[..r.len().min(REFUSED_MAX)].to_string());
            assert_eq!(back.miss.as_ref().and_then(|m| m.refused.clone()), want_refused, "the code is kept to its bound");
            if row.miss.as_ref().and_then(|m| m.refused.as_ref()).map_or(true, |r| r.len() <= REFUSED_MAX) { assert_eq!(back, row); }
        }
        for o in AppOutcome::ALL {
            let row = LightPushRow { miss: Some(LightMiss { app_outcome: Some(o), ..refined.clone() }), answer: None };
            assert_eq!(LightPushRow::decode(&row.encode()), Some(row));
            assert_eq!(AppOutcome::parse(o.as_str()), Some(o));
        }
        let enc = full.encode();
        assert!(enc.len() < 112, "a small row: {} bytes", enc.len());
        for bad in [vec![], vec![3u8, 1], vec![0u8, 0], vec![2u8, 4], enc[..enc.len() - 1].to_vec(), [enc.clone(), vec![0]].concat()] {
            assert_eq!(LightPushRow::decode(&bad), None, "{bad:?}");
        }
        let mut wrong_reason = enc.clone();
        wrong_reason[10] = 9;
        assert_eq!(LightPushRow::decode(&wrong_reason), None);
        // The miss's last three bytes: an outcome this genesis does not know, a flag it does not know.
        let miss_end = enc.len() - 24;
        let mut wrong_outcome = enc.clone();
        wrong_outcome[miss_end - 2] = 99;
        assert_eq!(LightPushRow::decode(&wrong_outcome), None);
        let mut wrong_flag = enc.clone();
        wrong_flag[miss_end - 1] = 2;
        assert_eq!(LightPushRow::decode(&wrong_flag), None);
        // A first-version row: the miss ends at the refusal code.
        let mut v1 = enc[..miss_end - 10].to_vec();
        v1[0] = 1;
        v1.extend_from_slice(&enc[miss_end..]);
        let back = LightPushRow::decode(&v1).expect("a version 1 row");
        assert_eq!(back.miss, Some(LightMiss { delivered_at: None, ..full.miss.clone().unwrap() }));
        assert_eq!(back.answer, full.answer);
        // What came before the binding held here was another device's.
        let since = full.clone().since(1_800_000_000);
        assert_eq!((since.miss.is_some(), since.answer.is_none()), (true, true));
        assert_eq!(full.clone().since(0), full);
        // The JSON the signed status serves; `by_push` is not served.
        assert_eq!(full.miss.as_ref().unwrap().to_json(), json!({"epoch": 210, "reason": "answered_late", "delivered": true,
            "woken_at": 1_800_000_000u64,
            "answered_at": 1_800_009_000u64, "delivery_delay_secs": 0, "refused": null, "delivered_at": 1_800_008_990u64,
            "app_outcome": null}));
        assert_eq!(refined.to_json()["app_outcome"], json!("no_key"));
        assert_eq!(full.answer.unwrap().to_json(), json!({"at": 1_799_990_000u64, "delivery_delay_secs": 12, "handling_secs": null}));
    }

    /// The row keeps the latest epoch, at one epoch the reason that tells more, as every reader does; a late
    /// answer turns the epoch's miss into `answered_late` and keeps when the node was woken, whichever was written
    /// first; the last answer sits beside it.
    #[test]
    fn a_miss_is_merged_by_epoch_then_by_what_it_tells() {
        let m = |e, r, w| miss(e, r, w, 1);
        assert_eq!(LightMiss::merge(None, m(5, MissReason::NoPushAddress, None)).reason, MissReason::NoPushAddress);
        assert_eq!(LightMiss::merge(Some(m(5, MissReason::AnsweredLate, None)), m(6, MissReason::NotWokenInactive, None)).epoch, 6);
        assert_eq!(LightMiss::merge(Some(m(6, MissReason::NotWokenInactive, None)), m(5, MissReason::AnsweredLate, None)).epoch, 6);
        let kept = LightMiss::merge(Some(m(5, MissReason::AnsweredLate, None)), m(5, MissReason::WokenNoAnswer, Some(9)));
        assert_eq!((kept.reason, kept.woken_at), (MissReason::AnsweredLate, Some(9)), "the wake time either knew");
        let first = LightMiss { answered_at: Some(1), ..m(5, MissReason::AnsweredLate, None) };
        let second = LightMiss { answered_at: Some(2), ..m(5, MissReason::AnsweredLate, None) };
        assert_eq!(LightMiss::merge(Some(first.clone()), second).answered_at, Some(1), "the first of two equal ones");
        let mut order = MissReason::ALL.to_vec();
        order.sort_by_key(|r| r.rank());
        assert_eq!(order.iter().rev().map(|r| r.as_str()).collect::<Vec<_>>(),
                   vec!["not_committed", "answered_late", "not_delivered", "answer_refused", "woken_no_answer", "no_push_address",
                        "not_sent", "not_woken_inactive"],
                   "the readers' order");
        assert_eq!(MissReason::ALL.iter().map(|r| *r as u8).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5, 6, 7, 8], "the row's codes stay");
        // The two system misses round-trip in a row like every other reason.
        for r in [MissReason::NotSent, MissReason::NotCommitted] {
            let row = LightPushRow { miss: Some(m(9, r, None)), answer: None };
            assert_eq!(LightPushRow::decode(&row.encode()), Some(row));
        }
        // A late answer over a receipt-refined wake keeps what the receipt told; `not_delivered` never shows a delivery.
        let told = LightMiss { delivered_at: Some(40), delivery_delay_secs: Some(30), app_outcome: Some(AppOutcome::Swiped),
                               ..m(5, MissReason::WokenNoAnswer, Some(10)) };
        let late = LightMiss::merge(Some(told.clone()), m(5, MissReason::AnsweredLate, None));
        assert_eq!((late.reason, late.woken_at, late.delivered_at, late.delivery_delay_secs, late.app_outcome),
                   (MissReason::AnsweredLate, Some(10), Some(40), Some(30), Some(AppOutcome::Swiped)));
        let held = LightMiss::merge(Some(told), m(5, MissReason::NotDelivered, None));
        assert_eq!((held.reason, held.delivered_at, held.app_outcome), (MissReason::NotDelivered, None, None));
        assert_eq!(LightMiss::merge(Some(m(5, MissReason::NotDelivered, Some(10))), m(5, MissReason::AnswerRefused, None)).reason,
                   MissReason::NotDelivered, "ranked above a refusal");

        let (s, _d) = storage();
        let node = "light_mobile_row0000000000000";
        assert_eq!(stored_row(&s, node), None);
        assert_eq!(save_misses(&s, vec![(node.to_string(), m(200, MissReason::WokenNoAnswer, Some(1_800_000_000)))]), 1);
        assert!(!late_recorded(&s, node, 200));
        let late = Delivery { delay_secs: Some(5_400), handling_secs: Some(3) };
        assert!(record_late_answer(&s, node, 200, 1_800_009_000, late));
        let row = stored_row(&s, node).unwrap().miss.unwrap();
        assert_eq!((row.reason, row.woken_at, row.answered_at, row.delivery_delay_secs, row.delivered_at),
                   (MissReason::AnsweredLate, Some(1_800_000_000), Some(1_800_009_000), Some(5_400), Some(1_800_008_997)));
        assert!(late_recorded(&s, node, 200) && late_recorded(&s, node, 199) && !late_recorded(&s, node, 201));
        assert!(!record_late_answer(&s, node, 200, 1_800_009_500, Delivery::default()), "the first late answer is kept");
        assert_eq!(save_misses(&s, vec![(node.to_string(), m(200, MissReason::WokenNoAnswer, Some(1)))]), 0,
                   "the commit's record written after the late answer changes nothing");
        assert!(record_answer(&s, node, 1_800_020_000, Delivery { delay_secs: Some(4), handling_secs: Some(1) }, None, None, None));
        let r = stored_row(&s, node).unwrap();
        assert_eq!(r.miss.map(|m| m.reason), Some(MissReason::AnsweredLate), "the answer sits beside the miss");
        assert_eq!(r.answer, Some(LastAnswer { at: 1_800_020_000, delivery_delay_secs: Some(4), handling_secs: Some(1) }));
        assert_eq!(save_misses(&s, vec![(node.to_string(), m(201, MissReason::NoPushAddress, None))]), 1);
        assert_eq!(stored_row(&s, node).unwrap().miss.map(|m| (m.epoch, m.reason)), Some((201, MissReason::NoPushAddress)));
        assert!(!record_late_answer(&s, node, 200, 1_800_030_000, Delivery::default()), "an older epoch never overwrites a newer");
        // The rows sit apart from the push record they share a column with.
        assert!(s.get_fcm_entry(node).is_none());
    }

    fn receipts_text(since: u64, pushes: &[(u64, Option<u64>, u64, &str)]) -> HashMap<String, String> {
        let list: Vec<Value> = pushes.iter()
            .map(|(e, s, r, o)| json!({"epoch": e, "sent_at": s, "received_at": r, "outcome": o})).collect();
        HashMap::from([("push_receipts".to_string(), json!({"since": since, "pushes": list}).to_string())])
    }

    /// F-2: the device's receipts are read whole or not at all, within their bound, from a string field only (a
    /// genesis of an earlier release takes a body of strings only and ignores the field).
    #[test]
    fn push_receipts_are_read_whole_within_their_bound() {
        let p = receipts_text(200, &[(200, Some(1_800_000_000), 1_800_000_100, "swiped"), (201, None, 1_800_014_500, "later_code")]);
        assert_eq!(PushReceipts::from_params(&p), Some(PushReceipts { since: 200, pushes: vec![
            PushReceipt { epoch: 200, sent_at: Some(1_800_000_000), received_at: 1_800_000_100, outcome: Some(AppOutcome::Swiped) },
            PushReceipt { epoch: 201, sent_at: None, received_at: 1_800_014_500, outcome: None },
        ]}), "an outcome this genesis does not know is still a receipt");
        let strings = HashMap::from([("push_receipts".to_string(),
            r#"{"since":"7","pushes":[{"epoch":"7","sent_at":"5","received_at":"9","outcome":"no_key"}]}"#.to_string())]);
        assert_eq!(PushReceipts::from_params(&strings).map(|r| (r.since, r.pushes[0].sent_at, r.pushes[0].outcome)),
                   Some((7, Some(5), Some(AppOutcome::NoKey))), "decimal strings as every other answer field");
        assert_eq!(PushReceipts::from_params(&receipts_text(9, &[])), Some(PushReceipts { since: 9, pushes: vec![] }),
                   "none received and unanswered since epoch 9");
        let full: Vec<(u64, Option<u64>, u64, &str)> = (0..PUSH_RECEIPTS_MAX as u64).map(|i| (100 + i, Some(1_800_000_000 + i), 1_800_000_001 + i, "after_commit")).collect();
        assert_eq!(PushReceipts::from_params(&receipts_text(100, &full)).map(|r| r.pushes.len()), Some(PUSH_RECEIPTS_MAX));
        assert!(receipts_text(100, &full)["push_receipts"].len() <= PUSH_RECEIPTS_MAX_BYTES, "a full report fits its bound");
        let over: Vec<_> = full.iter().cloned().chain([(200, None, 1_800_100_000, "swiped")]).collect();
        assert_eq!(PushReceipts::from_params(&receipts_text(100, &over)), None, "more receipts than the bound");
        let padded = HashMap::from([("push_receipts".to_string(),
            format!(r#"{{"since":1,"pushes":[],"pad":"{}"}}"#, "x".repeat(PUSH_RECEIPTS_MAX_BYTES)))]);
        assert_eq!(PushReceipts::from_params(&padded), None, "longer than the bound");
        for bad in [r#"{"pushes":[]}"#, r#"{"since":1}"#, r#"{"since":1,"pushes":[{"epoch":1,"outcome":"swiped"}]}"#,
                    r#"{"since":1,"pushes":[{"epoch":1,"received_at":0}]}"#, r#"{"since":-1,"pushes":[]}"#, "not json", "[]"] {
            let p = HashMap::from([("push_receipts".to_string(), bad.to_string())]);
            assert_eq!(PushReceipts::from_params(&p), None, "{bad}");
        }
        assert_eq!(PushReceipts::from_params(&HashMap::new()), None);
        // The route keeps a string field and leaves out an object: a report sent as an object reads as none.
        let body: HashMap<String, Value> = serde_json::from_value(json!({
            "node_id": "light_x", "push_receipts": {"since": 1, "pushes": []},
        })).unwrap();
        assert_eq!(PushReceipts::from_params(&answer_fields(body)), None);
        let body: HashMap<String, Value> = serde_json::from_value(json!({
            "node_id": "light_x", "push_receipts": "{\"since\":1,\"pushes\":[]}",
        })).unwrap();
        assert_eq!(PushReceipts::from_params(&answer_fields(body)), Some(PushReceipts { since: 1, pushes: vec![] }));
    }

    /// F-2: a receipt dates the push's arrival on this genesis's clock, whatever the device's clock says, names what
    /// the app did with it, and never reaches past its bound; no receipt of a push the provider took, from a device
    /// whose record covers that epoch, is `not_delivered`. Only a plain `woken_no_answer` is refined, once.
    #[test]
    fn a_receipt_refines_the_miss_free_of_the_devices_clock() {
        let e = 300u64;
        let sent = 1_800_000_000u64;
        let woke = LightMiss { epoch: e, reason: MissReason::WokenNoAnswer, woken_at: Some(sent), answered_at: None,
                               delivery_delay_secs: None, refused: None, recorded_at: sent + 14_000,
                               delivered_at: None, app_outcome: None, by_push: true };
        // The push reached the phone 90 s after it left; the next answer went out 20,000 s later and took 2 s.
        let (arrived, answered, now) = (sent + 90, sent + 20_090, sent + 20_092);
        for skew in [0i64, 3 * 3600, -5 * 3600, 86_400 * 30] {
            let dev = |t: u64| (t as i64 + skew) as u64;
            let r = PushReceipts { since: e - 3, pushes: vec![
                PushReceipt { epoch: e - 1, sent_at: Some(sent - 14_400), received_at: dev(sent - 14_000), outcome: Some(AppOutcome::Answered) },
                PushReceipt { epoch: e, sent_at: Some(sent + 60), received_at: dev(arrived + 60), outcome: Some(AppOutcome::AnswerFailed) },
                PushReceipt { epoch: e, sent_at: Some(sent), received_at: dev(arrived), outcome: Some(AppOutcome::Swiped) },
            ]};
            let m = refine_miss(&woke, &r, Some(dev(answered)), now).expect("refined");
            assert_eq!((m.reason, m.delivered_at, m.delivery_delay_secs, m.app_outcome),
                       (MissReason::WokenNoAnswer, Some(arrived + 2), Some(92), Some(AppOutcome::Swiped)),
                       "skew {skew}: the first push of the epoch it received, dated on this clock");
            assert_eq!((m.woken_at, m.recorded_at, m.by_push), (woke.woken_at, woke.recorded_at, true));
        }
        let one = |sent_at: Option<u64>, received_at: u64| PushReceipts { since: e,
            pushes: vec![PushReceipt { epoch: e, sent_at, received_at, outcome: Some(AppOutcome::NotOpenedSinceBoot) }] };
        let at = |r: &PushReceipts, answered_at: Option<u64>| refine_miss(&woke, r, answered_at, now).map(|m| (m.delivered_at, m.delivery_delay_secs, m.app_outcome));
        // The bound: a receipt held past seven days, an answer before its receipt or none told dates nothing, and the
        // outcome still stands.
        let base = 1_000_000u64;
        assert_eq!(at(&one(None, base), Some(base + MAX_RECEIPT_AGE_SECS)).map(|t| t.0), Some(Some(now - MAX_RECEIPT_AGE_SECS)));
        assert_eq!(at(&one(None, base), Some(base + MAX_RECEIPT_AGE_SECS + 1)), Some((None, None, Some(AppOutcome::NotOpenedSinceBoot))));
        // A device clock that moved between the receipt and the answer dates the delivery before its push left: past
        // another genesis's clock skew nothing is dated, and the outcome stands.
        let back = now - sent;
        assert_eq!(at(&one(Some(sent), base), Some(base + back + SENT_AT_SKEW_SECS)).map(|t| (t.0, t.1)), Some((Some(sent - SENT_AT_SKEW_SECS), Some(0))));
        assert_eq!(at(&one(Some(sent), base), Some(base + back + SENT_AT_SKEW_SECS + 1)), Some((None, None, Some(AppOutcome::NotOpenedSinceBoot))));
        assert_eq!(at(&one(Some(sent), base), Some(base + back + 5 * 3600)), Some((None, None, Some(AppOutcome::NotOpenedSinceBoot))));
        assert_eq!(at(&one(Some(sent), base), Some(base - 1)), Some((None, None, Some(AppOutcome::NotOpenedSinceBoot))));
        assert_eq!(at(&one(Some(sent), base), None), Some((None, None, Some(AppOutcome::NotOpenedSinceBoot))));
        // The delay from `sent_at`: none without it, a little ahead (another genesis's clock) is no delay, far ahead
        // or older than two epochs measures nothing.
        let held = 100u64;
        assert_eq!(at(&one(None, base), Some(base + held)), Some((Some(now - held), None, Some(AppOutcome::NotOpenedSinceBoot))));
        assert_eq!(at(&one(Some(now - held + 60), base), Some(base + held)).map(|t| t.1), Some(Some(0)));
        assert_eq!(at(&one(Some(now - held + SENT_AT_SKEW_SECS + 1), base), Some(base + held)).map(|t| t.1), Some(None));
        assert_eq!(at(&one(Some(now - held - MAX_DELIVERY_SECS), base), Some(base + held)).map(|t| t.1), Some(Some(MAX_DELIVERY_SECS)));
        assert_eq!(at(&one(Some(now - held - MAX_DELIVERY_SECS - 1), base), Some(base + held)).map(|t| t.1), Some(None));
        // No receipt of that epoch: never delivered, only when the record covers it and a push alone woke the node.
        let none = |since: u64| PushReceipts { since, pushes: vec![PushReceipt { epoch: e + 1, sent_at: None, received_at: 5, outcome: None }] };
        let nd = refine_miss(&woke, &none(e), Some(9), now).expect("not delivered");
        assert_eq!((nd.reason, nd.delivered_at, nd.app_outcome, nd.woken_at), (MissReason::NotDelivered, None, None, Some(sent)));
        assert_eq!(nd.to_json()["reason"], json!("not_delivered"));
        assert_eq!(refine_miss(&woke, &none(e - 5), None, now).map(|m| m.reason), Some(MissReason::NotDelivered));
        assert_eq!(refine_miss(&woke, &none(e + 1), Some(9), now), None, "the record starts after that epoch: it cannot tell");
        assert_eq!(refine_miss(&LightMiss { by_push: false, ..woke.clone() }, &none(e), Some(9), now), None,
                   "a fetched challenge did reach the device");
        // Only a plain wake with no answer, once.
        for r in [MissReason::AnsweredLate, MissReason::AnswerRefused, MissReason::NoPushAddress, MissReason::NotWokenInactive,
                  MissReason::NotDelivered] {
            assert_eq!(refine_miss(&LightMiss { reason: r, ..woke.clone() }, &one(Some(sent), base), Some(base + 5), now), None, "{}", r.as_str());
            assert_eq!(refine_miss(&LightMiss { reason: r, ..woke.clone() }, &none(e), Some(9), now), None, "{}", r.as_str());
        }
        let told = refine_miss(&woke, &one(Some(sent), base), Some(base + 5), now).unwrap();
        assert_eq!(refine_miss(&told, &none(e), Some(9), now), None, "the first report is kept");
        let unknown = PushReceipts { since: e, pushes: vec![PushReceipt { epoch: e, sent_at: None, received_at: 5, outcome: None }] };
        assert_eq!(refine_miss(&woke, &unknown, None, now), None, "a receipt that tells nothing changes nothing");

        // Through the row: the counted answer's report refines the node's last miss in the same write, the first report
        // is kept, a later epoch's miss is never touched by a report of an older one.
        let (s, _d) = storage();
        let node = "light_mobile_receipts0000000";
        assert_eq!(save_misses(&s, vec![(node.to_string(), woke.clone())]), 1);
        let report = PushReceipts::from_params(&receipts_text(e, &[(e, Some(sent), 1_000, "answer_failed")])).unwrap();
        assert!(record_answer(&s, node, now, Delivery::default(), Some(&report), Some(1_000 + 20_002), Some(e + 2)));
        let row = stored_row(&s, node).unwrap();
        assert_eq!(row.miss.as_ref().map(|m| (m.reason, m.delivered_at, m.delivery_delay_secs, m.app_outcome)),
                   Some((MissReason::WokenNoAnswer, Some(now - 20_002), Some(90), Some(AppOutcome::AnswerFailed))));
        assert_eq!(row.answer.map(|a| a.at), Some(now));
        assert_eq!(row.miss.unwrap().to_json()["app_outcome"], json!("answer_failed"));
        let nothing = PushReceipts::from_params(&receipts_text(e, &[])).unwrap();
        assert!(record_answer(&s, node, now + 10, Delivery::default(), Some(&nothing), Some(5), Some(e + 2)));
        assert_eq!(stored_row(&s, node).unwrap().miss.map(|m| m.reason), Some(MissReason::WokenNoAnswer), "the first report is kept");
        let other = "light_mobile_receipts0000001";
        save_misses(&s, vec![(other.to_string(), woke.clone())]);
        save_misses(&s, vec![(other.to_string(), LightMiss { epoch: e + 1, ..woke.clone() })]);
        assert!(record_answer(&s, other, now, Delivery::default(), Some(&nothing), Some(5), Some(e + 2)));
        let m = stored_row(&s, other).unwrap().miss.unwrap();
        assert_eq!((m.epoch, m.reason), (e + 1, MissReason::NotDelivered), "the report covers the newest miss");
        let report_old = PushReceipts::from_params(&receipts_text(e, &[(e, Some(sent), 1_000, "swiped")])).unwrap();
        assert!(record_answer(&s, other, now + 5, Delivery::default(), Some(&report_old), Some(1_005), Some(e + 2)));
        assert_eq!(stored_row(&s, other).unwrap().miss.map(|m| (m.epoch, m.reason, m.app_outcome)),
                   Some((e + 1, MissReason::NotDelivered, None)), "a receipt of an older epoch touches nothing");
        // A report covers the epochs before its answer's own: a miss of that epoch (recorded while the answer was being
        // taken) or a reply naming no epoch (a server stamp) leaves the miss as it is.
        let third = "light_mobile_receipts0000002";
        save_misses(&s, vec![(third.to_string(), woke.clone())]);
        assert!(record_answer(&s, third, now, Delivery::default(), Some(&nothing), Some(5), Some(e)));
        assert!(record_answer(&s, third, now, Delivery::default(), Some(&nothing), Some(5), None));
        assert_eq!(stored_row(&s, third).unwrap().miss.map(|m| m.reason), Some(MissReason::WokenNoAnswer));
        assert!(record_answer(&s, third, now, Delivery::default(), Some(&nothing), Some(5), Some(e + 1)));
        assert_eq!(stored_row(&s, third).unwrap().miss.map(|m| m.reason), Some(MissReason::NotDelivered));
        // The ingress passes the answer's anchor epoch.
        assert!(include_str!("light_nodes.rs").contains("receipts.as_ref(), timing.answered_at,\r\n                      anchor.as_ref().map(|a| a.epoch()));")
                || include_str!("light_nodes.rs").contains("receipts.as_ref(), timing.answered_at,\n                      anchor.as_ref().map(|a| a.epoch()));"));

        // The ingress reads the report only on the counted path, after the shared verifier, at a shard owner.
        let src = include_str!("light_nodes.rs");
        let h = &src[src.find("async fn handle_light_node_ping_response(").unwrap()..];
        let h = &h[..h.find("pub(super) async fn handle_light_node_next_ping(").unwrap()];
        let read = h.find("PushReceipts::from_params(&params)").expect("read");
        assert_eq!(h.matches("PushReceipts::").count(), 1);
        assert!(h.find("if let Err(r) = verify_light_node_signature(").unwrap() < read);
        assert!(h.find("gossip_light_node_attestation").unwrap() < read);
        assert!(h[..read].rfind("if owns_light_shard(&node_id) {").unwrap() > h.find("PUSH_LEDGER.answered(&node_id);").unwrap());
    }

    /// A reply anchored in the ended epoch is that node's late answer when the anchor is canonical and its ping
    /// key signed it; anyone else's signature, or an unknown block, records nothing.
    #[test]
    fn a_stale_answer_is_late_only_under_the_nodes_own_ping_key() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let node = "light_mobile_stale00000000000";
        let (pp, sk) = d3::keypair();
        s.save_light_ping_keys(node, &hex::encode(pp.as_bytes()), "legacycert").unwrap();
        let h = 300 * EPOCH_BLOCKS + 50;
        s.save_microblock_hash(h, &[3u8; 32]).unwrap();
        let challenge = format!("selfattest:{}:{}", h, hex::encode([3u8; 32]));
        let a = crate::light_device::ping::Anchor::parse(&challenge).unwrap();
        let sign = |k: &d3::SecretKey| format!("ping_dilithium:{}", hex::encode(d3::detached_sign(challenge.as_bytes(), k).as_bytes()));
        assert!(stale_answer_verifies(&s, node, &challenge, &sign(&sk), &a));
        let (_, other) = d3::keypair();
        assert!(!stale_answer_verifies(&s, node, &challenge, &sign(&other), &a), "another key");
        let unknown = format!("selfattest:{}:{}", h + 1, hex::encode([3u8; 32]));
        let ua = crate::light_device::ping::Anchor::parse(&unknown).unwrap();
        assert!(!stale_answer_verifies(&s, node, &unknown, &sign(&sk), &ua), "a block this genesis lacks");
        // Only for the epoch just before the tip's, and only at a shard owner.
        assert!(!note_stale_answer(&s, node, &challenge, &sign(&sk), 302 * EPOCH_BLOCKS, 1, Delivery::default()));
        assert_eq!(note_stale_answer(&s, node, &challenge, &sign(&sk), 301 * EPOCH_BLOCKS + 5, 1, Delivery::default()),
                   owns_light_shard(node));
        assert_eq!(stored_row(&s, node).is_some(), owns_light_shard(node));
        // A node counted in that epoch here missed nothing, whatever repeat of its answer comes after.
        let (s2, _d2) = storage();
        s2.save_light_ping_keys(node, &hex::encode(pp.as_bytes()), "legacycert").unwrap();
        s2.save_microblock_hash(h, &[3u8; 32]).unwrap();
        s2.save_light_epoch_eligible(300, node, 1_800_000_000).unwrap();
        assert!(!note_stale_answer(&s2, node, &challenge, &sign(&sk), 301 * EPOCH_BLOCKS + 5, 1, Delivery::default()));
        assert!(stored_row(&s2, node).is_none());
        // The ingress runs it on a stale anchor, and records a gap answer as late after the shared verifier.
        let src = include_str!("light_nodes.rs");
        let h = &src[src.find("async fn handle_light_node_ping_response(").unwrap()..];
        assert!(h.contains("let late = note_stale_answer(&blockchain.get_storage(), &node_id, &challenge, &signature, tip, now,"));
        let gap = &h[h.find("if in_commit_gap(tip) {").unwrap()..];
        let gap = &gap[..gap.find("return Ok(warp::reply::json(&gap_reply(&node_id)));").unwrap()];
        assert!(gap.contains("verify_light_node_signature(") && gap.contains("record_late_answer("));
        assert!(gap.contains("let epoch = tip / 14400;"), "late for the epoch the answer came in, its own");
        assert!(!gap.contains("gossip_light_node_attestation"), "a gap answer is credited nowhere");
        assert!(h.find("if in_commit_gap(tip) {").unwrap() < h.find("gossip_light_node_attestation").unwrap());
    }

    /// P-1: the window the early draw starts at is stored by this genesis's first ping and kept: a restart mid-window
    /// draws the live window as it began, so no node's slot moves under it. It is stored only from a tip the network
    /// stands behind, and a stored one is read at once.
    #[test]
    fn the_early_draw_window_is_kept_across_restarts() {
        let (s, _d) = storage();
        assert_eq!(first_push_draw_from(&s, None), None, "nothing stored while the live epoch is not known");
        assert_eq!(first_push_draw_from(&s, Some(500)), Some(501), "the window after the first ping");
        assert_eq!(first_push_draw_from(&s, Some(507)), Some(501), "a restart in a later window keeps it");
        assert_eq!(first_push_draw_from(&s, None), Some(501), "read at once after a restart, behind or not");
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("SimplifiedP2P::arm_push_schedule(first_push_draw_from(&storage, live), spaced_rounds_from(&storage, live));"));
        assert!(pinger.contains("let live = (head > 0 && !pinger_behind(tip, head)).then_some(epoch);"));
        // The spaced rounds keep a window of their own under their own key, stored the same way.
        assert_ne!(FIRST_PUSH_DRAW_KEY, SPACED_ROUNDS_KEY);
        assert_eq!(spaced_rounds_from(&s, None), None);
        assert_eq!(spaced_rounds_from(&s, Some(700)), Some(701), "the window after the first ping on a release with them");
        assert_eq!(spaced_rounds_from(&s, Some(700)), Some(701), "a restart in the same window keeps it");
        assert_eq!(first_push_draw_from(&s, Some(700)), Some(501), "the early draw's window untouched");
        // The read mark: the last slot read and the own shard's first due slot read since, kept together.
        assert_eq!(push_read_mark(&s), None);
        keep_push_read_mark(&s, 700 * SLOTS_PER_EPOCH + 41, 700 * SLOTS_PER_EPOCH + 3);
        assert_eq!(push_read_mark(&s), Some((700 * SLOTS_PER_EPOCH + 41, 700 * SLOTS_PER_EPOCH + 3)));
    }

    /// P-2: the signed status asks the app to register its push token again exactly while a device is linked here
    /// and this genesis cannot push it.
    #[test]
    fn the_app_is_asked_to_register_its_token_again_only_when_it_cannot_be_pushed() {
        let (s, _d) = storage();
        let node = "light_mobile_rereg000000000";
        assert!(!push_reregister(&s, node, 9), "not on chain");
        s.save_node_registration_at_height_burn(node, "light", "w", 70.0, 100, "b").unwrap();
        assert!(!push_reregister(&s, node, 9), "no device linked");
        s.save_light_ping_keys(node, "ab", "legacycert").unwrap();
        assert!(push_reregister(&s, node, 9), "linked, nothing to push to");
        s.save_fcm_token(node, "", "polling", None, 5).unwrap();
        assert!(push_reregister(&s, node, 9), "a polling device");
        s.save_fcm_token(node, "tok", "fcm", None, 6).unwrap();
        assert!(!push_reregister(&s, node, 9), "pushed");
        PUSH_LEDGER.record(node, 9 * SLOTS_PER_EPOCH + 1, SendOutcome::Gone, 7);
        assert!(push_reregister(&s, node, 9), "the provider says the token is gone");
        assert!(!push_reregister(&s, node, 10), "for that epoch");
    }

    /// P-1 at scale: ten million light nodes on five genesis, each pushing its own shard's two million. A slot's
    /// pushes are its first pushes, the repeats to the still silent nodes drawn 15 and 30 slots before, and the retry
    /// round to those drawn 60, 75 and 90 slots before. At answer rates far below the live ones (half still silent at
    /// the round's repeats, two fifths at the retry round) every slot fits the pacer's window and every second the
    /// epoch's share of the budget, wakes included under the whole; a genesis covering all three of its shards still
    /// sends every first push. Nobody answering at all is more than the share: the pacer then sheds the slot's later
    /// pushes, which come last in its order (`push_reads`), and no push fails at the provider.
    #[test]
    fn the_push_load_at_ten_million_stays_under_the_budget() {
        const NODES: u64 = 10_000_000;
        let per_genesis = NODES / 5;
        let sample = 168_000u64;
        let scale = per_genesis as f64 / sample as f64;
        let mut first = vec![0f64; SLOTS_PER_EPOCH as usize];
        for i in 0..sample {
            let id = format!("light_mobile_{:016x}", i.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            first[crate::unified_p2p::SimplifiedP2P::slot_in_draw(&id, 300, FIRST_PUSH_SLOTS) as usize] += scale;
        }
        assert!(first[FIRST_PUSH_SLOTS as usize..].iter().all(|n| *n == 0.0), "no first push after the first 138 slots");
        // A slot's load from the first pushes `f` of each slot: each due point weighted by the share still silent there.
        let load = |f: &[f64], s: i64, repeat: f64, retry: f64| -> f64 {
            spaced_due_offsets().map(|(offset, _)| {
                let d = s - offset as i64;
                let silent = if offset == 0 { 1.0 } else if offset < RETRY_AFTER_SLOTS { repeat } else { retry };
                if d >= 0 { silent * f[d as usize] } else { 0.0 }
            }).sum()
        };
        let per_slot = |s: i64, repeat: f64, retry: f64| load(&first, s, repeat, retry);
        let peak_slot = (0..SLOTS_PER_EPOCH as i64).map(|s| per_slot(s, 0.5, 0.4)).fold(0.0, f64::max);
        let pacer = PushPacer::new(EPOCH_PUSHES_PER_SEC);
        let now = 1_800_000_000_000_000u64;
        let window = std::iter::repeat(()).take_while(|_| pacer.reserve(now, now + PACE_WINDOW_US).is_some()).count() as f64;
        assert!(window >= (EPOCH_PUSHES_PER_SEC * PACE_WINDOW_US / 1_000_000) as f64);
        assert!(peak_slot <= window, "peak slot {peak_slot:.0} pushes over the pacer's {window:.0}");
        let peak_sec = peak_slot / 60.0;
        assert!(peak_sec <= EPOCH_PUSHES_PER_SEC as f64, "{peak_sec:.0}/s");
        assert!(peak_sec + (WAKE_PUSHES_PER_SEC as f64) < FCM_PUSHES_PER_SEC as f64);
        let first_peak = first.iter().cloned().fold(0.0, f64::max);
        assert!(3.0 * first_peak <= window, "three shards' first pushes fit a slot");
        let silent = (0..SLOTS_PER_EPOCH as i64).map(|s| per_slot(s, 1.0, 1.0)).fold(0.0, f64::max);
        assert!(silent > window, "nobody answering is shed by the pacer, not refused by the provider");
        // The numbers: about 240 first pushes a second (some 260 in the busiest slot), some 790 at the peak with the
        // repeats and the retry round at these answer rates.
        assert!((200.0..300.0).contains(&(first_peak / 60.0)) && (650.0..850.0).contains(&peak_sec), "{} {}", first_peak / 60.0, peak_sec);

        // F6: a genesis covering two or three shards (their owners down) paces at that many shares, within the quota:
        // every slot of every shard's first pushes, repeats and retry round fits, where one share sheds a third and
        // more of it.
        let shard_firsts = |j: u64| {
            let mut f = vec![0f64; SLOTS_PER_EPOCH as usize];
            for i in 0..sample {
                let id = format!("light_mobile_{:016x}", (i | (j << 40)).wrapping_mul(0x9E37_79B9_7F4A_7C15));
                f[crate::unified_p2p::SimplifiedP2P::slot_in_draw(&id, 300, FIRST_PUSH_SLOTS) as usize] += scale;
            }
            f
        };
        let slot_load = |f: &[f64], s: i64| load(f, s, 0.5, 0.4);
        let window_at = |rate: u64| {
            let p = PushPacer::new(EPOCH_PUSHES_PER_SEC);
            p.set_rate(rate);
            std::iter::repeat(()).take_while(|_| p.reserve(now, now + PACE_WINDOW_US).is_some()).count() as f64
        };
        let all: Vec<Vec<f64>> = (0..MAX_COVERED_SHARDS).map(shard_firsts).collect();
        for k in [2usize, 3] {
            let demand = (0..SLOTS_PER_EPOCH as i64).map(|s| all[..k].iter().map(|f| slot_load(f, s)).sum::<f64>()).fold(0.0, f64::max);
            let paced = window_at(epoch_push_rate(k));
            assert!(demand <= paced, "{k} shards: peak slot {demand:.0} over the pacer's {paced:.0}");
            assert!(demand > 1.3 * window, "{k} shards at one share would shed: {demand:.0} against {window:.0}");
            assert!(epoch_push_rate(k) + WAKE_PUSHES_PER_SEC <= PUSH_QUOTA_PER_SEC, "within the quota");
            let first_k = (0..SLOTS_PER_EPOCH as usize).map(|s| all[..k].iter().map(|f| f[s]).sum::<f64>()).fold(0.0, f64::max);
            assert!(first_k / 60.0 < epoch_push_rate(k) as f64, "{k} shards' first pushes fit their pace");
        }
        assert_eq!((epoch_push_rate(0), epoch_push_rate(1), epoch_push_rate(3), epoch_push_rate(9)),
                   (EPOCH_PUSHES_PER_SEC, EPOCH_PUSHES_PER_SEC, 3 * EPOCH_PUSHES_PER_SEC, 3 * EPOCH_PUSHES_PER_SEC));
        assert_eq!(PUSH_QUOTA_PER_SEC, 2_800);
        // The pinger paces at the shards it covers, and the provider's limiter allows the quota.
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("EPOCH_PACER.set_rate(epoch_push_rate(covered_shards()));"));
        assert!(pinger.contains("FcmRateLimiter::with_rate(PUSH_QUOTA_PER_SEC)"));
    }

    /// The pacing survives this genesis's clock being set back: a full slot sheds as before, but after a step back of
    /// an hour the next push goes now, not an hour later (every push of that hour shed and recorded `not_sent`).
    #[test]
    fn the_pacing_starts_again_when_the_clock_is_set_back() {
        let p = PushPacer::new(EPOCH_PUSHES_PER_SEC);
        let t = 1_800_000_000_000_000u64;
        let n = std::iter::repeat(()).take_while(|_| p.reserve(t, t + PACE_WINDOW_US).is_some()).count() as u64;
        assert!(n >= EPOCH_PUSHES_PER_SEC * PACE_WINDOW_US / 1_000_000, "one slot's instants: {n}");
        assert_eq!(p.reserve(t, t + PACE_WINDOW_US), None, "a full slot sheds");
        assert!(p.reserve(t + PACE_WINDOW_US, t + 2 * PACE_WINDOW_US).is_some(), "the next slot has room");
        let back = t - 3_600_000_000;
        assert_eq!(p.reserve(back, back + PACE_WINDOW_US), Some(back), "an hour set back: at once");
        assert_eq!(p.reserve(back, back + PACE_WINDOW_US), Some(back + 1_000_000 / EPOCH_PUSHES_PER_SEC), "and paced on");
    }

    /// F3/F6: a push the pacing shed, or one with no anchor, is recorded but is none of the round's six and never a
    /// reach of the device: the next slot of its due point tries again, and its epoch says `not_sent`.
    #[test]
    fn an_unsent_push_is_recorded_neutral_and_off_the_cap() {
        let l = PushLedger::new();
        let (n, t) = ("light_mobile_unsent", 1_800_000_000u64);
        let s = 700 * SLOTS_PER_EPOCH + 10;
        // Shed in its slot, the push of a due point is tried in each slot of its grace, and still once only.
        let due = Due::spaced(s, 0);
        for slot in s..=s + DUE_GRACE_SLOTS {
            assert!(l.may_push(n, slot, &[due], || 0), "slot {slot}");
            l.record(n, slot, SendOutcome::Unsent, t);
            assert!(!l.may_push(n, slot, &[due], || 0), "once a slot");
        }
        let repeat = Due::spaced(s + ROUND_SPACING_SLOTS, ROUND_SPACING_SLOTS);
        assert!(l.may_push(n, s + ROUND_SPACING_SLOTS, &[repeat], || 0), "never sent: the repeat is due, the node offered here");
        l.record(n, s + ROUND_SPACING_SLOTS, SendOutcome::Unsent, t);
        assert!(l.may_push(n, s + ROUND_SPACING_SLOTS + 1, &[repeat], || 0), "the next slot of its grace");
        l.record(n, s + ROUND_SPACING_SLOTS + 1, SendOutcome::Accepted, t);
        assert!(!l.may_push(n, s + ROUND_SPACING_SLOTS + 2, &[repeat], || 0), "out once: none again for that due point");
        let e = l.get(n).unwrap();
        assert_eq!((e.sends, e.unsent, e.reached()), (1, 4, true));
        // Unsent at every slot is never one of the six: before the spaced rounds, twenty slots shed and still six sends.
        let n = "light_mobile_unsent_unspaced";
        for slot in s..s + 20 {
            assert!(l.may_push(n, slot, &[Due::once(slot)], || 0), "slot {slot}");
            l.record(n, slot, SendOutcome::Unsent, t);
            assert!(!l.may_push(n, slot, &[Due::once(slot)], || 0), "once a slot");
        }
        let e = l.get(n).unwrap();
        assert_eq!((e.sends, e.unsent, e.reached()), (0, 20, false));
        for (i, slot) in (s + 20..s + 26).enumerate() {
            assert!(l.may_push(n, slot, &[Due::once(slot)], || 0), "push {} still allowed", i + 1);
            l.record(n, slot, SendOutcome::Failed, t);
        }
        assert!(!l.may_push(n, s + 26, &[Due::once(s + 26)], || 0), "six real sends");
        let taken: Vec<(String, PushEntry)> = l.take_epoch(700).into_iter().filter(|(id, _)| id == n).collect();
        assert_eq!(taken[0].1.miss(t).map(|m| m.reason), Some(MissReason::NotSent));
        assert!(reached_unanswered(&taken, |_| false).is_empty(), "never a reach");
        let woke = vec![("light_a".to_string(), PushEntry { epoch: 700, woken_at: 5, ..PushEntry::default() }),
                        ("light_b".to_string(), PushEntry { epoch: 700, woken_at: 5, ..PushEntry::default() }),
                        ("light_c".to_string(), PushEntry { epoch: 700, gone: true, ..PushEntry::default() })];
        assert_eq!(reached_unanswered(&woke, |id| id == "light_b"), vec!["light_a".to_string(), "light_c".to_string()]);
    }

    /// F9: a genesis that does not own the node's shard checks only the registration and hands the wake on; an owner
    /// behind the network answers 503 so the next owner sends it; a hand-off is TLS only and bounded.
    #[test]
    fn a_non_owner_checks_only_the_registration_and_hands_the_wake_on() {
        let (s, _d) = storage();
        let node = "light_mobile_wake_f9_0000000";
        assert_eq!(wake_registered(&s, "super_x"), Err(WakeAnswer::NotRegistered));
        assert_eq!(wake_registered(&s, node), Err(WakeAnswer::NotRegistered));
        s.save_node_registration_at_height_burn(node, "light", "w", 70.0, 100, "b").unwrap();
        assert_eq!(wake_registered(&s, node), Ok(()), "no binding here is no reason to answer no_device");
        assert_eq!(wake_precheck(&s, node, false), Err(WakeAnswer::NoDevice), "an owner holds the binding and says so");
        let src = include_str!("light_push.rs");
        let h = &src[src.find("pub(super) async fn handle_light_node_wake(").unwrap()..];
        let h = &h[..h.find("
}
").unwrap()];
        let non_owner = &h[h.find("if !owner && !forwarded {").unwrap()..h.find("this_genesis_behind()").unwrap()];
        assert!(non_owner.contains("wake_registered(") && !non_owner.contains("wake_precheck("));
        assert!(h.find("this_genesis_behind()").unwrap() < h.find("wake_precheck(").unwrap());
        assert!(h.contains("StatusCode::SERVICE_UNAVAILABLE"));
        let fwd = &src[src.find("async fn forward_wake(").unwrap()..];
        assert!(fwd[..fwd.find("
}
").unwrap()].contains("genesis_internal_call_tls(") && WAKE_FORWARD_SECS * 3 < 8);
    }

    /// L-3: the ledger holds every node of the three shards one genesis may cover, says once an epoch when it is full,
    /// and the commit moves an epoch's entries out (older ones dropped, newer ones kept) instead of copying them.
    #[test]
    fn the_push_ledger_holds_three_shards_and_the_commit_moves_its_entries_out() {
        assert_eq!(LEDGER_CAP, 6_000_000);
        assert_eq!(LEDGER_CAP, MAX_COVERED_SHARDS as usize * 2_000_000);
        let l = PushLedger::new();
        l.record("light_old", 799 * SLOTS_PER_EPOCH + 3, SendOutcome::Accepted, 5);
        l.record("light_now", 800 * SLOTS_PER_EPOCH + 3, SendOutcome::Accepted, 6);
        l.record("light_now2", 800 * SLOTS_PER_EPOCH + 4, SendOutcome::Polled, 7);
        l.record("light_next", 801 * SLOTS_PER_EPOCH + 1, SendOutcome::Accepted, 8);
        let mut taken = l.take_epoch(800);
        taken.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(taken.iter().map(|(k, e)| (k.as_str(), e.epoch, e.woken_at)).collect::<Vec<_>>(),
                   vec![("light_now", 800, 6), ("light_now2", 800, 0)]);
        assert_eq!(l.len(), 1, "the older entry dropped, the newer kept");
        assert_eq!(l.get("light_next").map(|e| e.epoch), Some(801));
        assert!(l.take_epoch(800).is_empty(), "moved out once");
        let src = include_str!("light_push.rs");
        let entry = &src[src.find("    fn entry(&self, node_id: &str, epoch: u64)").unwrap()..];
        let entry = &entry[..entry.find("\n    }\n").unwrap()];
        assert!(entry.contains("self.cap_warned.swap(epoch, std::sync::atomic::Ordering::Relaxed) != epoch")
            && entry.contains("push_ledger_full"), "a WARN once an epoch at the cap");
    }

    /// M-6: a request past the budget waits one to five minutes, drawn at random, and never past its epoch's commit less a
    /// slot, so an answer retried then still counts in its own epoch; near the commit it waits for what is left, and with
    /// nothing left it comes back after the epoch's end.
    #[test]
    fn a_shed_request_waits_one_to_five_minutes_and_never_past_its_epochs_commit() {
        let e = 900u64;
        let commit = commit_opens_at(e);
        for tip in [e * EPOCH_BLOCKS, e * EPOCH_BLOCKS + 7_000, commit - SHED_DEADLINE_MARGIN_SECS - SHED_RETRY_MAX_SECS] {
            let waits: Vec<u64> = (0..2_000u64).map(|d| shed_retry_after(tip, d.wrapping_mul(0x9e37_79b9_7f4a_7c15))).collect();
            assert!(waits.iter().all(|w| (SHED_RETRY_MIN_SECS..=SHED_RETRY_MAX_SECS).contains(w)), "tip {tip}");
            assert!(waits.iter().any(|w| *w < 90) && waits.iter().any(|w| *w > 270), "spread over the range");
            assert!(waits.iter().all(|w| tip + w <= commit - SHED_DEADLINE_MARGIN_SECS));
        }
        // Less than five minutes left before the deadline: never past it.
        for left in [SHED_RETRY_MIN_SECS + 30, SHED_RETRY_MIN_SECS, 30, 5, 1] {
            let tip = commit - SHED_DEADLINE_MARGIN_SECS - left;
            for d in 0..500u64 {
                let w = shed_retry_after(tip, d);
                assert!(w >= 1 && tip + w <= commit - SHED_DEADLINE_MARGIN_SECS, "left {left}: {w}");
            }
        }
        // Nothing left in the epoch: after its end, by at most a minute.
        for tip in [commit - SHED_DEADLINE_MARGIN_SECS, commit, (e + 1) * EPOCH_BLOCKS - 1] {
            for d in 0..500u64 {
                let w = shed_retry_after(tip, d);
                assert!(tip + w >= (e + 1) * EPOCH_BLOCKS && tip + w <= (e + 1) * EPOCH_BLOCKS + SHED_RETRY_MIN_SECS, "{tip}: {w}");
            }
        }
        // The budget: in flight at once and a second's worth; a permit leaves when dropped.
        let b = LoadBudget::new(2, 3);
        let (p1, p2) = (b.enter(100), b.enter(100));
        assert!(p1.is_some() && p2.is_some());
        assert!(b.enter(100).is_none(), "two in flight");
        drop(p1);
        assert!(b.enter(100).is_none(), "three this second");
        drop(p2);
        let p3 = b.enter(101);
        assert!(p3.is_some(), "a new second, room in flight");
        // The answer: 503, Retry-After and the same wait in the body.
        let r = shed_reply(123);
        assert_eq!(r.status(), warp::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.headers().get("Retry-After").and_then(|v| v.to_str().ok()), Some("123"));
        // Before any storage read or signature work, after the address's own limit, on both routes.
        let nodes = include_str!("light_nodes.rs");
        let h = &nodes[nodes.find("pub(super) async fn handle_light_node_ping_response(").unwrap()..];
        let h = &h[..h.find("async fn answer_light_node_ping(").unwrap()];
        let limit = h.find("check_api_rate_limit(remote_addr, \"light_node_ping\")").unwrap();
        let shed = h.find("shed_past(&PING_ANSWER_BUDGET, remote_addr, &mut permit)").unwrap();
        assert!(limit < shed && shed < h.find("answer_light_node_ping(params, blockchain)").unwrap());
        let m = include_str!("mod.rs");
        let height = &m[m.find("let chain_height = api_v1").unwrap()..];
        let height = &height[..height.find("blockchain.get_height().await").unwrap()];
        assert!(height.contains("shed_past(&HEIGHT_READ_BUDGET, remote_addr, &mut permit)"));
    }

    /// L-5: handing a polling challenge out marks nothing; the device counts as having fetched it only for a poll its
    /// ping key signed, under the delegation the chain vouches for. The route answers a pushed device as one whose slot is
    /// not due, is limited per address, and leaves the map's sweep to the ping loop.
    #[test]
    fn a_challenge_counts_as_fetched_only_for_a_poll_the_device_signed() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        let (pp, ping_sk) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        let seq = 1_800_000_000;
        let cert = hex::encode(d3::detached_sign(lb::delegation_v2_message(&pp_hex, &node, seq).as_bytes(), &sk).as_bytes());
        s.bind_light_v2(&node, &pp_hex, &cert, &pk_hex, seq, seq).unwrap().unwrap();
        let ts = 1_800_000_100u64;
        let msg = lb::light_poll_message(&node, ts);
        let sig = |k: &d3::SecretKey, m: &str| hex::encode(d3::detached_sign(m.as_bytes(), k).as_bytes());
        let (_, stranger) = d3::keypair();
        assert!(ping_key_signed(&s, &node, &msg, &sig(&ping_sk, &msg)));
        assert!(!ping_key_signed(&s, &node, &msg, &sig(&stranger, &msg)), "another key");
        assert!(!ping_key_signed(&s, &node, &lb::light_poll_message(&node, ts + 1), &sig(&ping_sk, &msg)), "another time");
        assert!(!ping_key_signed(&s, &node, &msg, &sig(&sk, &msg)), "the wallet key is not the ping key");
        // The ledger waits for a fetch only of a challenge the pinger left this epoch.
        let l = PushLedger::new();
        assert!(!l.awaits_fetch(&node, 500));
        l.record(&node, 500 * SLOTS_PER_EPOCH + 9, SendOutcome::Polled, 10);
        assert!(l.awaits_fetch(&node, 500) && !l.awaits_fetch(&node, 501));
        l.fetched(&node, 500, 11);
        assert!(!l.awaits_fetch(&node, 500), "counted once");
        assert_eq!(l.get(&node).map(|e| e.fetched_at), Some(11));
        // The route: limited per address first, a pushed device answered as one not due, no fetch without the signature.
        let src = include_str!("light_nodes.rs");
        let h = &src[src.find("pub(super) async fn handle_light_node_pending_challenge(").unwrap()..];
        let h = &h[..h.find("fn note_poll_fetched(").unwrap()];
        assert!(h.find("check_api_rate_limit(remote_addr, \"read_only\")").unwrap() < h.find("get_light_node(").unwrap());
        assert!(h.find("get_light_node(").unwrap() < h.find("light_poll_allowed(").unwrap(), "RAM before storage");
        assert!(h.contains("if !light_poll_allowed(&storage, &node_id) || !device_layer_pushable(&storage, &node_id) {\n        return Ok(no_challenge(\"Not your ping slot yet\"));"));
        assert!(!h.contains("This endpoint is only for polling-mode nodes") && !h.contains("PUSH_LEDGER.fetched("));
        assert!(!h.contains(".retain("), "the sweep runs in the ping loop");
        assert!(src.contains("sweep_polling_challenges(tip, "));
        let note = &src[src.find("fn note_poll_fetched(").unwrap()..];
        let note = &note[..note.find("\n}\n").unwrap()];
        assert!(note.find("PUSH_LEDGER.awaits_fetch(").unwrap() < note.find("ping_key_signed(").unwrap());
    }

    /// M-11: the selection decides how each node's device is reached, from one slim read of its binding row that skips
    /// the keys and certificates, and the push uses that channel without reading again; the slim read says what the whole
    /// row says.
    #[test]
    fn the_selection_hands_each_push_its_channel_from_one_slim_read() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as _, PublicKey as _};
        let (s, _d) = storage();
        let (pk, sk) = d3::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&pk_hex).unwrap();
        let node = crate::rpc::generate_light_node_pseudonym(&wallet);
        let (epoch, now) = (crate::light_device::current_epoch(), crate::light_device::now_secs());
        assert_eq!(push_reach_at(&s, &node, epoch, now), None, "not on chain");
        s.save_node_registration_at_height_burn_vrf(&node, "light", &wallet, 70.0, 100, "", Some(pk.as_bytes())).unwrap();
        assert_eq!(push_reach_at(&s, &node, epoch, now), None, "no device");
        let (pp, _) = d3::keypair();
        let pp_hex = hex::encode(pp.as_bytes());
        let seq = 1_800_000_000;
        let cert = hex::encode(d3::detached_sign(lb::delegation_v2_message(&pp_hex, &node, seq).as_bytes(), &sk).as_bytes());
        s.bind_light_v2(&node, &pp_hex, &cert, &pk_hex, seq, seq).unwrap().unwrap();
        assert_eq!(push_reach_at(&s, &node, epoch, now), Some(None), "bound, no channel: a challenge");
        s.save_fcm_token_seq(&node, "tok_sel", "fcm", None, seq, seq).unwrap();
        assert_eq!(push_reach_at(&s, &node, epoch, now), Some(Some(PushChannel::Fcm("tok_sel".into()))));
        assert_eq!(push_reach_at(&s, &node, epoch, now), device_reach(&s, &node), "one reading");
        // The slim read and the whole row agree, for a legacy row too.
        let whole = |s: &crate::storage::Storage, n: &str| s.get_light_binding(n).map(|b| lb::BindingReach::of(&b));
        assert_eq!(s.light_binding_reach(&node), whole(&s, &node));
        assert_eq!(s.light_binding_reach(&node).map(|r| (r.device_bound(), r.v2, r.seq, r.identity_pubkey.is_empty())),
                   Some((true, true, seq, true)), "a v2 row keeps no key bytes");
        let legacy = "light_mobile_slim_legacy00";
        s.save_light_ping_keys_identity(legacy, &pp_hex, "legacycert", &pk_hex).unwrap();
        assert_eq!(s.light_binding_reach(legacy), whole(&s, legacy));
        assert!(s.light_binding_reach(legacy).map_or(false, |r| !r.v2 && r.identity_pubkey == pk_hex && r.never_v2()));
        assert_eq!(s.light_binding_reach("light_mobile_none"), None);
        // The push future takes the selection's channel and reads nothing again.
        let nodes = include_str!("light_nodes.rs");
        let tick = &nodes[nodes.find("for (light_node, role, channel) in nodes_to_ping {").unwrap()..];
        let tick = &tick[..tick.find("while futures.next().await.is_some() {}").unwrap()];
        assert!(!tick.contains("push_channel(") && !tick.contains("device_reach("));
    }

    /// L-4: the tick reads its slot and epoch from one height, stamps every push with that slot and judges the commit in
    /// its epoch; the hourly cleanup runs in its own task, so it never delays a tick past the slot it read.
    #[test]
    fn the_tick_stamps_its_pushes_with_the_slot_of_one_height() {
        assert_eq!(light_ping_slot_at(5 * EPOCH_BLOCKS - 1), (4, 239, 4 * SLOTS_PER_EPOCH + 239));
        assert_eq!(light_ping_slot_at(5 * EPOCH_BLOCKS), (5, 0, 5 * SLOTS_PER_EPOCH));
        let mut last = 0;
        for h in 5 * EPOCH_BLOCKS - 200..5 * EPOCH_BLOCKS + 200 {
            let (e, s, abs) = light_ping_slot_at(h);
            assert_eq!((abs / SLOTS_PER_EPOCH, abs % SLOTS_PER_EPOCH), (e, s));
            assert_eq!(e, h / EPOCH_BLOCKS);
            assert!(abs >= last, "never a slot of a later epoch before the boundary");
            last = abs;
        }
        // A slot stamped by the tick leaves the rest of its epoch open to the node's repeat pushes.
        let l = PushLedger::new();
        let (_, _, abs) = light_ping_slot_at(5 * EPOCH_BLOCKS + 3);
        l.record("light_l4", abs, SendOutcome::Accepted, 1);
        let next = abs + ROUND_SPACING_SLOTS;
        assert!(l.may_push("light_l4", next, &[Due::spaced(next, ROUND_SPACING_SLOTS)], || 0), "the round's next due point");
        let nodes = include_str!("light_nodes.rs");
        let tick = &nodes[nodes.find("let selection = if behind {").unwrap()..];
        assert!(tick.contains("let abs_slot = selection.now_slot;")
            && tick.contains("let open = push_lifetime(abs_slot / 240, tip).is_some();"));
        assert!(!nodes.contains("SimplifiedP2P::get_current_window_number() * 240 + current_slot"));
        let cleanup = &nodes[nodes.find("if current_slot % 60 == cleanup_slot_offset").unwrap()..];
        let cleanup = &cleanup[..cleanup.find("blockchain.cleanup_old_storage_data().await;").unwrap()];
        assert!(cleanup.contains("tokio::spawn(async move {"));
        let prop = include_str!("../unified_p2p/propagation.rs");
        let sel = &prop[prop.find("pub(crate) fn get_light_nodes_to_ping(&self, tip: u64)").unwrap()..];
        assert!(sel[..sel.find("our_node_id").unwrap()].contains("light_ping_slot_at(tip)"));
    }
}

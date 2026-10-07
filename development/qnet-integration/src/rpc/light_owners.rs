//! The three owners of a light shard (`light_shard_owners`: the shard's own genesis and the next two) and what
//! they decide together (05.10): which owner pushes the shard, from the ping ticks each sends the others
//! (`OwnerLiveness`) while its provider takes its pushes (`PushHealth`); which node the network stops waking, only
//! after two proven device misses
//! (`proven_dormant`, from the reach records each pushing owner keeps and the others pull); how one relayed answer
//! is verified once (`RelayClaims`); and when a genesis behind the network stays quiet (`pinger_behind`). Push
//! policy of the genesis nodes; no block rule reads any of it.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` section 5.10.

use super::*;
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};

const EPOCH_BLOCKS: u64 = 14_400;

// ── Which owner pushes: ping ticks and owner liveness (F5) ──

/// The `node_type` of a genesis's ping tick: an announcement signed like every other, sent straight to the other
/// genesis after each ping tick it completed, and never relayed. It goes out as `ping_tick_type`, naming the sender's
/// push schedule.
pub(crate) const PING_TICK_NODE_TYPE: &str = "genesis_ping_tick";

/// The `node_type` a ping tick goes out with: `genesis_ping_tick:{first}:{spaced}`, the windows the sender's early
/// first-push draw and its spaced rounds start at (u64::MAX for one not armed), so the owners of its shards read a shard
/// it pushed as it did (`OwnerSchedules`).
pub(crate) fn ping_tick_type(first_push_from: u64, spaced_from: u64) -> String {
    format!("{}:{}:{}", PING_TICK_NODE_TYPE, first_push_from, spaced_from)
}

/// Whether an announcement's `node_type` is a ping tick, and the push schedule it names: Some(None) for a tick that
/// names none (an earlier build) or a malformed one, None for any other announcement.
pub(crate) fn ping_tick_schedule(node_type: &str) -> Option<Option<(u64, u64)>> {
    if node_type == PING_TICK_NODE_TYPE { return Some(None); }
    let rest = node_type.strip_prefix(PING_TICK_NODE_TYPE)?.strip_prefix(':')?;
    let mut parts = rest.split(':').map(|p| p.parse::<u64>().ok());
    Some(match (parts.next().flatten(), parts.next().flatten(), parts.next()) {
        (Some(first), Some(spaced), None) => Some((first, spaced)),
        _ => None,
    })
}

/// Where this genesis keeps the push schedules the other genesis' ticks named (node-local, `OwnerSchedules`).
const OWNER_SCHEDULES_KEY: &str = "light_owner_schedules";

/// The push schedule each genesis's ping ticks named (`ping_tick_type`): the windows its early draw and its spaced rounds
/// start at, u64::MAX for one never heard naming one (a genesis of an earlier release, which draws over the bounded
/// range). A genesis that starts pushing a shard inside an epoch, by a takeover or back after a stop, reads it under the
/// draws of the shard's other owners too (`unified_p2p::foreign_draws`). Kept across a restart, so the schedule of an
/// owner that went quiet before it is known all the same.
pub(crate) struct OwnerSchedules {
    state: parking_lot::Mutex<([(u64, u64); 5], bool)>,
}

impl OwnerSchedules {
    pub(crate) const fn new() -> Self {
        OwnerSchedules { state: parking_lot::const_mutex(([(u64::MAX, u64::MAX); 5], false)) }
    }

    /// The schedule a verified tick of genesis `idx` named.
    pub(crate) fn learn(&self, idx: usize, schedule: (u64, u64)) {
        if idx >= 5 { return; }
        let mut g = self.state.lock();
        if g.0[idx] != schedule {
            g.0[idx] = schedule;
            g.1 = true;
        }
    }

    /// Each genesis's schedule, u64::MAX for one not known.
    pub(crate) fn get(&self) -> [(u64, u64); 5] {
        self.state.lock().0
    }

    /// The schedules kept before a restart (`OWNER_SCHEDULES_KEY`); one learned since is kept.
    pub(crate) fn restore(&self, storage: &crate::storage::Storage) {
        let Some(v) = storage.load_raw(OWNER_SCHEDULES_KEY).ok().flatten() else { return; };
        if v.len() != 5 * 16 { return; }
        let mut g = self.state.lock();
        for (idx, c) in v.chunks_exact(16).enumerate() {
            let w = |b: &[u8]| u64::from_be_bytes(b.try_into().unwrap_or([0xff; 8]));
            if g.0[idx] == (u64::MAX, u64::MAX) { g.0[idx] = (w(&c[..8]), w(&c[8..])); }
        }
    }

    /// Store the schedules when one changed since the last store.
    pub(crate) fn keep(&self, storage: &crate::storage::Storage) {
        let mut g = self.state.lock();
        if !g.1 { return; }
        let bytes: Vec<u8> = g.0.iter().flat_map(|(f, s)| f.to_be_bytes().into_iter().chain(s.to_be_bytes())).collect();
        match storage.save_raw(OWNER_SCHEDULES_KEY, &bytes) {
            Ok(()) => g.1 = false,
            Err(e) => if crate::node::is_warn() {
                println!("[WARN][LIGHT] owner_schedules_store_failed err={}", e);
            },
        }
    }
}

pub(crate) static OWNER_SCHEDULES: OwnerSchedules = OwnerSchedules::new();
/// The hop a ping tick goes out with: the relay limit, so a node of an earlier release drops it unread.
pub(crate) const PING_TICK_HOP: u8 = 3;
/// Slots an owner may be silent before the rank below covers its shard: ten ping ticks missed in a row. A restart
/// or a slow minute never causes a hand-over; a shard is never left unpushed for long.
pub(crate) const COVER_AFTER_SILENT_SLOTS: u64 = 10;
/// Ticks in a row an owner must be heard again before the rank below hands its shard back.
pub(crate) const RELEASE_AFTER_ALIVE_SLOTS: u32 = 3;
const SLOT_SECS: u64 = 60;
/// A tick heard this recently counts for the evaluating tick: one tick and a half.
const TICK_FRESH_SECS: u64 = 90;
/// The least time between two ticks of one genesis that are verified; a closer one is dropped unread.
const TICK_MIN_GAP_SECS: u64 = 15;

#[derive(Debug, Clone, Copy)]
struct OwnerState {
    /// When the latest tick was heard here, on this genesis's clock (0 for none in this process).
    heard: u64,
    /// That tick's own time, on the sender's clock: the next must be newer, unless the sender was silent a tick and a
    /// half (its clock was set back). Never compared with this genesis's clock, so any spread between the two is fine.
    last_ts: u64,
    /// Evaluations in a row with a fresh tick, while covering.
    alive: u32,
    covering: bool,
}

const QUIET: OwnerState = OwnerState { heard: 0, last_ts: 0, alive: 0, covering: false };

/// What this genesis knows of the other four as pushers: the ping ticks it heard from each. An owner is judged
/// silent only from ticks, which come from the push loop itself, so a genesis whose push loop is wedged, that is
/// behind the network (it then sends none, `pinger_behind`), or whose provider takes none of its pushes
/// (`PushHealth`), is taken over while its other announcements go on. A genesis never heard ticking, by this process
/// or one before it (`OWNER_TICKING_KEY`), is one of an earlier release and judged as before, by the age of its last
/// announcement of any kind; one heard ticking before a restart is judged by its ticks at once, so an owner that went
/// quiet before this genesis restarted is taken over all the same. Nothing is judged silent before this process
/// listened for COVER_AFTER_SILENT_SLOTS (a freshly started genesis took over all three of its shards).
pub(crate) struct OwnerLiveness {
    state: parking_lot::Mutex<([OwnerState; 5], u64)>,
    /// The genesis heard ticking, here or before a restart (bit idx), and the mask last stored. Never cleared: an
    /// owner rolled back to a release that sends no tick is covered, its shard pushed twice and never lost.
    ticking: AtomicU8,
    stored: AtomicU8,
}

/// Where this genesis keeps which genesis it heard ticking (node-local, `OwnerLiveness`).
const OWNER_TICKING_KEY: &str = "light_owner_ticking";

impl OwnerLiveness {
    pub(crate) const fn new() -> Self {
        OwnerLiveness { state: parking_lot::const_mutex(([QUIET; 5], 0)), ticking: AtomicU8::new(0), stored: AtomicU8::new(0) }
    }

    /// The genesis this one heard ticking before a restart (`OWNER_TICKING_KEY`).
    pub(crate) fn restore(&self, storage: &crate::storage::Storage) {
        if let Some(mask) = storage.load_raw(OWNER_TICKING_KEY).ok().flatten().and_then(|v| v.first().copied()) {
            self.ticking.fetch_or(mask & 0b1_1111, Ordering::Relaxed);
            self.stored.store(mask & 0b1_1111, Ordering::Relaxed);
        }
    }

    /// Store the genesis heard ticking, when one was heard first since the last store.
    pub(crate) fn keep(&self, storage: &crate::storage::Storage) {
        let mask = self.ticking.load(Ordering::Relaxed);
        if mask == self.stored.load(Ordering::Relaxed) { return; }
        match storage.save_raw(OWNER_TICKING_KEY, &[mask]) {
            Ok(()) => self.stored.store(mask, Ordering::Relaxed),
            Err(e) => if crate::node::is_warn() {
                println!("[WARN][LIGHT] owner_ticking_store_failed err={}", e);
            },
        }
    }

    /// A tick of genesis `idx` with its own time `ts` is worth verifying at `now`: not too soon after the last one
    /// taken, and newer than it on the sender's own clock, or after a silence of a tick and a half (the sender's clock
    /// was set back). However far apart the two clocks read (servers' clocks differ), ticks are heard. Checked before
    /// the signature, so a flood costs no verification; only the genesis itself can send one (`ping_tick_sender`).
    pub(crate) fn tick_admissible(&self, idx: usize, ts: u64, now: u64) -> bool {
        if idx >= 5 { return false; }
        let s = self.state.lock().0[idx];
        // None of this process, or heard "later" than now: this genesis's own clock was set back.
        let Some(since) = (s.heard > 0).then(|| now.checked_sub(s.heard)).flatten() else { return true; };
        since >= TICK_MIN_GAP_SECS && (ts > s.last_ts || since > TICK_FRESH_SECS)
    }

    /// A verified tick of genesis `idx`, its own time `ts`, heard at `now` (`tick_admissible`'s rule).
    pub(crate) fn heard(&self, idx: usize, ts: u64, now: u64) {
        if idx >= 5 { return; }
        let mut g = self.state.lock();
        let s = &mut g.0[idx];
        let reset = s.heard == 0 || now.checked_sub(s.heard).map_or(true, |since| since > TICK_FRESH_SECS);
        if ts > s.last_ts || reset {
            s.last_ts = ts;
            s.heard = now;
        }
        self.ticking.fetch_or(1 << idx, Ordering::Relaxed);
    }

    /// One evaluation per ping tick of genesis `me`: which genesis are alive as pushers. Covering starts once an
    /// owner was silent COVER_AFTER_SILENT_SLOTS and ends once it was heard RELEASE_AFTER_ALIVE_SLOTS evaluations in a
    /// row. `legacy_age(idx)` is the age of genesis `idx`'s last announcement of any kind (None for none).
    pub(crate) fn judge(&self, me: usize, now: u64, legacy_age: impl Fn(usize) -> Option<u64>) -> [bool; 5] {
        let mut g = self.state.lock();
        // This genesis's clock set back: a tick heard "later" than now is no fresh one (a covered owner is not handed
        // back for it) and the silence is counted from now, so a step back delays a cover by ten slots at most and
        // never ends one; the listening starts again.
        if g.1 == 0 || g.1 > now { g.1 = now; }
        let listened = now.saturating_sub(g.1);
        let threshold = COVER_AFTER_SILENT_SLOTS * SLOT_SECS;
        let ticking = self.ticking.load(Ordering::Relaxed);
        let mut alive = [true; 5];
        for (idx, s) in g.0.iter_mut().enumerate() {
            if idx == me { continue; }
            if s.heard > now { s.heard = now.saturating_sub(TICK_FRESH_SECS + 1).max(1); }
            // Heard ticking before a restart and not since: silent for as long as this process listened.
            let ticks = s.heard > 0 || ticking & (1 << idx) != 0;
            let silent_for = match (s.heard > 0, ticks) {
                (true, _) => now.saturating_sub(s.heard),
                (false, true) => u64::MAX,
                (false, false) => legacy_age(idx).unwrap_or(u64::MAX),
            };
            let silent = listened >= threshold && silent_for >= threshold;
            if s.covering {
                let fresh = s.heard > 0 && now.saturating_sub(s.heard) <= TICK_FRESH_SECS;
                s.alive = if fresh { s.alive + 1 } else { 0 };
                // An owner known to tick is handed back for its ticks alone, never for a listening started again.
                if (s.heard > 0 && s.alive >= RELEASE_AFTER_ALIVE_SLOTS) || (!ticks && !silent) {
                    s.covering = false;
                    s.alive = 0;
                }
            } else if silent {
                s.covering = true;
                s.alive = 0;
            }
            alive[idx] = !s.covering;
        }
        alive
    }
}

pub(crate) static OWNER_LIVENESS: OwnerLiveness = OwnerLiveness::new();

/// The genesis index a ping tick from `node_id` names, when it came straight from that genesis (`from_peer` its
/// address or its id): a tick is never relayed, so no peer can speak for an owner that went silent.
pub(crate) fn ping_tick_sender(node_id: &str, from_peer: &str) -> Option<usize> {
    let ip = crate::genesis_constants::genesis_ip_for_node_id(node_id)?;
    if from_peer.split(':').next() != Some(ip) && from_peer != node_id { return None; }
    let digits = format!("{:0>3}", node_id.strip_prefix("genesis_node_")?);
    ["001", "002", "003", "004", "005"].iter().position(|g| *g == digits)
}

/// The shards this genesis covered at its last ping tick (`get_light_nodes_to_ping`): its own and those it took over.
static COVERED_SHARDS: AtomicUsize = AtomicUsize::new(1);

pub(crate) fn set_covered_shards(n: usize) {
    COVERED_SHARDS.store(n.clamp(1, 3), Ordering::Relaxed);
}

pub(crate) fn covered_shards() -> usize {
    COVERED_SHARDS.load(Ordering::Relaxed)
}

// ── A genesis whose provider takes none of its pushes stays quiet ──

/// Ticks in a row in which the provider answered none of the pushes sent to it before this genesis stops sending
/// ping ticks: five minutes, and the owners below cover its shards COVER_AFTER_SILENT_SLOTS later.
pub(crate) const QUIET_AFTER_FAILED_TICKS: u32 = 5;

/// Where this genesis keeps its push standing (node-local): restarted while its provider fails, it stays quiet
/// instead of ticking until the owners below hand its shards back.
const PUSH_HEALTH_KEY: &str = "light_push_health";

/// Whether the provider answers this genesis's pushes, from what each completed tick sent it (`PushTally`). A genesis
/// whose provider refuses every push (its credentials broken, the provider failing on this host) still completes its
/// ticks, and its ping tick would keep the owners below off its shards while the devices lose their epochs. So it
/// sends its tick only while the provider did not fail QUIET_AFTER_FAILED_TICKS ticks in a row, a failed tick being
/// one that sent the provider pushes and saw none answered (a token gone is an answer: the provider worked). A tick
/// that sent the provider nothing changes nothing, so sparse pushes neither silence a working genesis nor wake a quiet
/// one, and one push answered resumes it. Only the provider whose credentials this genesis holds is judged
/// (`PushChannel::is_provider`): a push server endpoint is the device owner's, any host, and one dead or hostile
/// endpoint would silence every owner pushing it; its answers never hide the provider's outage either.
pub(crate) struct PushHealth {
    failed: parking_lot::Mutex<u32>,
}

impl PushHealth {
    pub(crate) const fn new() -> Self {
        PushHealth { failed: parking_lot::const_mutex(0) }
    }

    /// One completed tick: the pushes sent to the provider and those it answered. Returns whether this genesis sends
    /// its ping tick, and whether that changed with this tick.
    pub(crate) fn after_tick(&self, sent: u64, answered: u64) -> (bool, bool) {
        let mut failed = self.failed.lock();
        let before = *failed < QUIET_AFTER_FAILED_TICKS;
        if answered > 0 {
            *failed = 0;
        } else if sent > 0 {
            *failed = failed.saturating_add(1);
        }
        let now = *failed < QUIET_AFTER_FAILED_TICKS;
        (now, now != before)
    }

    /// `after_tick` for the pinger's tick `slot` (`tally`, None when it sent no push): whether this genesis sends its
    /// ping tick. When that changes the standing is stored, and one line logged.
    pub(crate) fn settle_tick(&self, storage: &crate::storage::Storage, tally: Option<&PushTally>, slot: u64) -> bool {
        let (sent, answered) = tally.map_or((0, 0), PushTally::provider_answers);
        let (working, changed) = self.after_tick(sent, answered);
        if !changed { return working; }
        let ticks = *self.failed.lock();
        if let Err(e) = storage.save_raw(PUSH_HEALTH_KEY, &ticks.to_be_bytes()) {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] push_health_store_failed err={}", e);
            }
        }
        if working {
            if crate::node::is_info() {
                println!("[INFO][LIGHT] push_provider_answering slot={} action=ping_tick_resumed", slot);
            }
        } else if crate::node::is_warn() {
            println!("[WARN][LIGHT] push_provider_failing failed_ticks={} slot={} first_err=\"{}\" action=no_ping_tick",
                     ticks, slot, tally.and_then(PushTally::provider_err).unwrap_or(""));
        }
        working
    }

    /// The standing this genesis stored before a restart (`PUSH_HEALTH_KEY`).
    pub(crate) fn restore(&self, storage: &crate::storage::Storage) {
        let Some(ticks) = storage.load_raw(PUSH_HEALTH_KEY).ok().flatten()
            .and_then(|v| <[u8; 4]>::try_from(v.as_slice()).ok()).map(u32::from_be_bytes) else { return; };
        *self.failed.lock() = ticks;
        if ticks >= QUIET_AFTER_FAILED_TICKS && crate::node::is_warn() {
            println!("[WARN][LIGHT] push_provider_failing failed_ticks={} source=stored action=no_ping_tick", ticks);
        }
    }
}

pub(crate) static PUSH_HEALTH: PushHealth = PushHealth::new();

// ── A genesis behind the network stays quiet (F14) ──

/// How far a pushing genesis's tip may lag the corroborated head: a minute of blocks.
pub(crate) const PUSH_MAX_LAG_BLOCKS: u64 = 60;

/// This genesis is behind the network (`head`, the corroborated head, 0 when unknown): its epoch is not the head's,
/// or its tip lags more than PUSH_MAX_LAG_BLOCKS. It then sends no push, hands out no polling challenge, sends no
/// wake and no ping tick: its anchor and its epoch are stale, and the owners below take its shards over.
pub(crate) fn pinger_behind(tip: u64, head: u64) -> bool {
    head > 0 && (head / EPOCH_BLOCKS > tip / EPOCH_BLOCKS || head.saturating_sub(tip) > PUSH_MAX_LAG_BLOCKS)
}

/// `pinger_behind` for this node now.
pub(crate) fn this_genesis_behind() -> bool {
    let head = crate::node::try_get_p2p().map_or(0, |p| p.corroborated_head_ceiling());
    pinger_behind(crate::node::local_height(), head)
}

// ── Which node the network stops waking: proven device misses (F1, F3) ──

/// Most bytes a reach record decompresses to: the eligibility bitmap's own bound.
const REACH_MAX_BYTES: usize = qnet_state::transaction::MAX_BITMAP_DECOMPRESSED;

/// A reach record: the nodes of one shard a genesis reached in one epoch (a push the provider took, a challenge the
/// device fetched, or the provider saying the token is gone), or held there by the dormant rule, that gave it no
/// answer, as a bitmap over their permanent roster index (bit i = reg_index i, the eligibility bitmap's layout),
/// compressed. None past the bound.
pub(crate) fn encode_reach(indices: &[u32]) -> Option<Vec<u8>> {
    let len = indices.iter().max().map_or(0, |m| *m as usize / 8 + 1);
    if len > REACH_MAX_BYTES { return None; }
    let mut bm = vec![0u8; len];
    for i in indices {
        bm[*i as usize / 8] |= 1 << (i % 8);
    }
    zstd::encode_all(&bm[..], 3).ok()
}

/// A reach record's bitmap, within the bound.
pub(crate) fn decode_reach(record: &[u8]) -> Option<Vec<u8>> {
    crate::unified_p2p::decompress_zstd_bounded(record, REACH_MAX_BYTES).ok()
}

fn bit(bm: &[u8], i: u32) -> bool {
    bm.get(i as usize / 8).map_or(false, |b| b & (1 << (i % 8)) != 0)
}

/// The reach records held here, per (epoch, shard) the OR of every owner's: whichever owner pushed the node, its
/// proof that the device was reached counts at all three, so all three stop waking a dormant node alike.
pub(crate) struct ReachCache {
    map: parking_lot::Mutex<HashMap<(u64, usize), Arc<Vec<u8>>>>,
    /// Bumped by every `forget`: an OR read while a record was being stored is not kept.
    stored: AtomicU64,
}

impl ReachCache {
    pub(crate) fn new() -> Self {
        ReachCache { map: parking_lot::Mutex::new(HashMap::new()), stored: AtomicU64::new(0) }
    }

    /// Some owner's record shows the node at `reg_index` of `shard` reached and silent in `epoch`.
    pub(crate) fn reached(&self, storage: &crate::storage::Storage, epoch: u64, shard: usize, reg_index: u32) -> bool {
        bit(&self.record(storage, epoch, shard), reg_index)
    }

    fn record(&self, storage: &crate::storage::Storage, epoch: u64, shard: usize) -> Arc<Vec<u8>> {
        if let Some(r) = self.map.lock().get(&(epoch, shard)) { return r.clone(); }
        let stored = self.stored.load(Ordering::Acquire);
        let mut or: Vec<u8> = Vec::new();
        for signer in crate::node::light_shard_owners(shard) {
            if let Some(bm) = storage.light_reach(epoch, shard, signer).and_then(|r| decode_reach(&r)) {
                if or.len() < bm.len() { or.resize(bm.len(), 0); }
                for (o, b) in or.iter_mut().zip(bm.iter()) { *o |= b; }
            }
        }
        self.keep(epoch, shard, Arc::new(or), stored)
    }

    /// Keep the OR of (epoch, shard) read since `stored`, unless a record was stored meanwhile: one missing from it,
    /// kept for the epoch, would leave this owner pushing a node the others hold dormant. Read again next time instead.
    fn keep(&self, epoch: u64, shard: usize, or: Arc<Vec<u8>>, stored: u64) -> Arc<Vec<u8>> {
        let mut m = self.map.lock();
        m.retain(|(e, _), _| e.saturating_add(3) >= epoch);
        if self.stored.load(Ordering::Acquire) == stored {
            m.insert((epoch, shard), or.clone());
        }
        or
    }

    /// A record of (epoch, shard) was stored here: read it again.
    pub(crate) fn forget(&self, epoch: u64, shard: usize) {
        let mut m = self.map.lock();
        self.stored.fetch_add(1, Ordering::AcqRel);
        m.remove(&(epoch, shard));
    }
}

pub(crate) static REACH_CACHE: Lazy<ReachCache> = Lazy::new(ReachCache::new);

/// Store this genesis's (`signer`) reach records of `epoch`: `nodes` it reached, or held dormant, that gave it no answer
/// (`reached_unanswered`), one record per shard, by roster index (a node with no roster entry is left out: it cannot be
/// counted, so its miss proves nothing). Returns the nodes recorded.
pub(crate) fn save_reach_records(storage: &crate::storage::Storage, epoch: u64, signer: usize, nodes: &[String]) -> usize {
    let mut by_shard: [Vec<u32>; 5] = Default::default();
    for id in nodes {
        if let Some((_, reg_index)) = storage.light_roster_entry(id) {
            by_shard[crate::node::light_shard_of(id)].push(reg_index);
        }
    }
    let mut recorded = 0;
    for (shard, indices) in by_shard.iter().enumerate() {
        if indices.is_empty() { continue; }
        let Some(record) = encode_reach(indices) else { continue; };
        match storage.put_light_reach(epoch, shard, signer, &record) {
            Ok(()) => {
                recorded += indices.len();
                REACH_CACHE.forget(epoch, shard);
            }
            Err(e) => if crate::node::is_warn() {
                println!("[WARN][LIGHT] reach_record_store_failed epoch={} shard={} err={}", epoch, shard, e);
            },
        }
    }
    recorded
}

/// What decides whether a node of a shard can be dormant in an epoch (two point reads): the shards whose two epochs
/// before were both derived here and committed a row (bit g, shard g). In any other shard the silence of either epoch is
/// not the device's to answer for, so none of its nodes is dormant: they are all pushed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DormantFacts {
    pub(crate) decidable: u8,
}

impl DormantFacts {
    pub(crate) fn read(storage: &crate::storage::Storage, epoch: u64) -> Self {
        let mut decidable = 0b1_1111u8;
        for back in 1..=2u64 {
            decidable &= match epoch.checked_sub(back) {
                Some(e) => storage.light_elig_shards(e).unwrap_or(0),
                None => 0,
            };
        }
        DormantFacts { decidable }
    }

    /// No node of `shard` can be dormant this epoch.
    pub(crate) fn neutral(&self, shard: usize) -> bool {
        shard >= 5 || self.decidable & (1u8 << shard) == 0
    }
}

/// The dormant rule, the only one that stops waking a node: `node_id` of `shard` gave a proven device miss in both
/// epochs before `epoch`. An epoch is a proven device miss when the committed index was derived here and the
/// node's shard committed a row (`facts`), the node was in that epoch's roster and is absent from its committed
/// index, and an owner's reach record shows its device was reached (a push the provider took, which counts even
/// when the phone's system then held it, alike on every platform; a challenge it fetched; or its token gone), or
/// that the rule itself held it then, so a dormant node stays dormant until it answers. Anything not known, a
/// failed or shed send, a send never made, an owner down, is no miss of the device's.
pub(crate) fn proven_dormant(storage: &crate::storage::Storage, reach: &ReachCache, facts: &DormantFacts,
                             node_id: &str, shard: usize, epoch: u64) -> bool {
    let (Some(e1), Some(e2)) = (epoch.checked_sub(1), epoch.checked_sub(2)) else { return false; };
    if facts.neutral(shard) { return false; }
    let Some((reg_height, reg_index)) = storage.light_roster_entry(node_id) else { return false; };
    for e in [e1, e2] {
        if reg_height >= crate::node::light_roster_cutoff(e) || !reach.reached(storage, e, shard, reg_index) { return false; }
    }
    !storage.light_counted_in(e1, node_id) && !storage.light_counted_in(e2, node_id)
}

// ── The other owners' reach records: served and pulled ──

/// The last epoch whose misses and reach records this genesis decided, plus one (0 for none yet).
static REACH_DECIDED: AtomicU64 = AtomicU64::new(0);

pub(crate) fn mark_reach_decided(epoch: u64) {
    REACH_DECIDED.fetch_max(epoch.saturating_add(1), Ordering::Relaxed);
}

fn reach_decided(epoch: u64) -> bool {
    REACH_DECIDED.load(Ordering::Relaxed) > epoch
}

/// Blocks into an epoch before the records of the one just ended are pulled: every owner decided it when its commit
/// opened, 150 blocks before that epoch's end.
const REACH_PULL_AFTER_BLOCKS: u64 = 30;
/// How long a pull that found nothing decided waits before it is tried again.
const REACH_PULL_RETRY_SECS: u64 = 300;

/// The other owners' reach records this genesis pulled, per (epoch, shard, owner): 0 once settled (the record taken,
/// or the owner said it holds none), else when to try again.
pub(crate) struct ReachPulls {
    state: DashMap<(u64, usize, usize), u64>,
}

impl ReachPulls {
    pub(crate) fn new() -> Self {
        ReachPulls { state: DashMap::new() }
    }

    /// The records genesis `our_idx` still lacks at `tip` and `now`, each claimed until REACH_PULL_RETRY_SECS from
    /// now: of the two epochs before the tip's (the one just ended once REACH_PULL_AFTER_BLOCKS passed), for each
    /// shard it owns, from each other owner. At most twelve an epoch.
    pub(crate) fn due(&self, our_idx: usize, tip: u64, now: u64) -> Vec<(u64, usize, usize)> {
        let epoch = tip / EPOCH_BLOCKS;
        self.state.retain(|(e, _, _), _| e.saturating_add(2) >= epoch);
        let mut due = Vec::new();
        let ended = (tip % EPOCH_BLOCKS >= REACH_PULL_AFTER_BLOCKS).then(|| epoch.checked_sub(1)).flatten();
        for d in [ended, epoch.checked_sub(2)].into_iter().flatten() {
            for shard in (0..5usize).filter(|sh| crate::node::light_owner_rank(*sh, our_idx).is_some()) {
                for owner in crate::node::light_shard_owners(shard).into_iter().filter(|o| *o != our_idx) {
                    let key = (d, shard, owner);
                    let next = self.state.get(&key).map(|v| *v);
                    // A retry time further off than one wait was set before this genesis's clock was set back: due now.
                    if next.map_or(true, |t| t != 0 && (t <= now || t > now + REACH_PULL_RETRY_SECS)) {
                        self.state.insert(key, now + REACH_PULL_RETRY_SECS);
                        due.push(key);
                    }
                }
            }
        }
        due
    }

    pub(crate) fn settle(&self, key: (u64, usize, usize)) {
        self.state.insert(key, 0);
    }
}

pub(crate) static REACH_PULLS: Lazy<ReachPulls> = Lazy::new(ReachPulls::new);

/// What a pulled answer gives: the owner's record, none, or nothing decided yet (None).
pub(crate) fn pulled_reach(v: &Value) -> Option<Option<Vec<u8>>> {
    if v["success"].as_bool() != Some(true) { return None; }
    match v["reach"].as_str() {
        None => Some(None),
        Some(text) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(text).ok()?;
            decode_reach(&bytes)?;
            Some(Some(bytes))
        }
    }
}

/// Pull the other owners' reach records this genesis lacks (`ReachPulls::due`), each over TLS from that owner, and
/// store each one taken: so a backup that covers a shard stops waking exactly the nodes its primary proved dormant.
pub(crate) fn pull_reach_records(storage: Arc<crate::storage::Storage>, our_idx: usize, tip: u64, now: u64) {
    for key in REACH_PULLS.due(our_idx, tip, now) {
        let (epoch, shard, owner) = key;
        if storage.light_reach(epoch, shard, owner).is_some() {
            REACH_PULLS.settle(key);
            continue;
        }
        let Some((ip, _)) = crate::genesis_constants::GENESIS_NODE_IPS.get(owner) else { continue; };
        let storage = storage.clone();
        tokio::spawn(async move {
            let path = format!("/api/v1/internal/light-reach-get?epoch={}&shard={}", epoch, shard);
            let v: Option<Value> = match genesis_internal_call_tls(ip, &path, |c, url| c.get(url)).await {
                Ok(r) if r.status().is_success() => r.json().await.ok(),
                _ => None,
            };
            match v.as_ref().and_then(pulled_reach) {
                Some(Some(record)) => {
                    if storage.put_light_reach(epoch, shard, owner, &record).is_ok() {
                        REACH_CACHE.forget(epoch, shard);
                        REACH_PULLS.settle(key);
                        if crate::node::is_debug() {
                            println!("[DBG][LIGHT] reach_record_pulled epoch={} shard={} owner={}", epoch, shard, owner + 1);
                        }
                    }
                }
                Some(None) => REACH_PULLS.settle(key),
                None => if crate::node::is_debug() {
                    println!("[DBG][LIGHT] reach_record_pull_pending epoch={} shard={} owner={}", epoch, shard, owner + 1);
                },
            }
        });
    }
}

/// `GET /api/v1/internal/light-reach-get?epoch=&shard=`: this genesis's reach record of a shard's epoch, to the
/// other genesis only: `{success: true, epoch, shard, signer, reach}` with `reach` the record (base64) or null when
/// it holds none of an epoch it decided; `{success: false, reason: "not_decided"}` before it decided that epoch.
pub(super) async fn handle_internal_light_reach_get(
    remote_addr: Option<std::net::SocketAddr>,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let caller_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    let reply = |v: Value, code: warp::http::StatusCode| Ok(warp::reply::with_status(warp::reply::json(&v), code));
    if !is_genesis_peer_ip(&caller_ip) {
        return reply(json!({"success": false, "error": "Unauthorized"}), warp::http::StatusCode::FORBIDDEN);
    }
    let num = |k: &str| params.get(k).and_then(|v| v.parse::<u64>().ok());
    let (Some(epoch), Some(shard)) = (num("epoch"), num("shard").filter(|s| *s < 5)) else {
        return reply(json!({"success": false, "error": "epoch and shard required"}), warp::http::StatusCode::BAD_REQUEST);
    };
    let Some(our) = std::env::var("QNET_BOOTSTRAP_ID").ok().and_then(|id| ["001", "002", "003", "004", "005"].iter().position(|g| *g == id)) else {
        return reply(json!({"success": false, "reason": "not_decided"}), warp::http::StatusCode::OK);
    };
    let shard = shard as usize;
    let answer = match blockchain.get_storage().light_reach(epoch, shard, our) {
        Some(record) => json!({"success": true, "epoch": epoch, "shard": shard, "signer": format!("genesis_node_{:03}", our + 1),
                               "reach": base64::engine::general_purpose::STANDARD.encode(record)}),
        None if reach_decided(epoch) => json!({"success": true, "epoch": epoch, "shard": shard,
                                              "signer": format!("genesis_node_{:03}", our + 1), "reach": Value::Null}),
        None => json!({"success": false, "reason": "not_decided"}),
    };
    reply(answer, warp::http::StatusCode::OK)
}

// ── One relayed answer, verified once (F7) ──

/// The relayed answers in verification here. A copy takes the claim before any signature is checked; a concurrent
/// copy of the same reply finds it taken and is dropped, and once the first is admitted the echo check drops the
/// rest (`light_relay_seen`). The claim is on the reply itself, so a tampered copy never keeps the real one out.
pub(crate) struct RelayClaims {
    set: std::sync::OnceLock<DashSet<String>>,
}

/// A claim, released when dropped.
pub(crate) struct RelayClaim<'a> {
    set: &'a DashSet<String>,
    key: String,
}

impl Drop for RelayClaim<'_> {
    fn drop(&mut self) {
        self.set.remove(&self.key);
    }
}

impl RelayClaims {
    pub(crate) const fn new() -> Self {
        RelayClaims { set: std::sync::OnceLock::new() }
    }

    /// Claim the relay of `reply` for `node_id` in `epoch`; None while another copy of it is in verification.
    pub(crate) fn claim(&self, node_id: &str, epoch: u64, reply: &str) -> Option<RelayClaim<'_>> {
        let set = self.set.get_or_init(DashSet::new);
        let h = blake3::hash(reply.as_bytes());
        let key = format!("{}:{}:{}", node_id, epoch, hex::encode(&h.as_bytes()[..8]));
        // Built only when taken: a claim built and dropped would release the holder's.
        set.insert(key.clone()).then(|| RelayClaim { set, key })
    }
}

pub(crate) static RELAY_CLAIMS: RelayClaims = RelayClaims::new();

/// A relayed answer anchored at `block_height` may be credited in the local epoch `local_epoch`: its anchor is of that
/// epoch and before the epoch's commit opened (`commit_opens_at`). The ingress refuses an answer in the commit
/// window; a relay is held to the same line, so every owner's row, a backup's included, commits only answers given
/// in time (F2).
pub(crate) fn relay_creditable(block_height: u64, local_epoch: u64) -> bool {
    block_height / EPOCH_BLOCKS == local_epoch && block_height < commit_opens_at(local_epoch)
}

/// Where an answer goes from the genesis that took it: the owners of the node's shard, itself left out, and nobody
/// else. A relay reaches exactly the three that credit it; an owner that missed one is healed by a backup's row
/// (F2) and never blamed for it (F1).
pub(crate) fn light_relay_targets(shard: usize, our_idx: Option<usize>) -> Vec<usize> {
    crate::node::light_shard_owners(shard).into_iter().filter(|o| Some(*o) != our_idx).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    const E: u64 = EPOCH_BLOCKS;

    fn storage() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (s, dir)
    }

    /// `n` node ids of `shard`, the same on every call.
    fn ids_of(shard: usize, n: usize, tag: &str) -> Vec<String> {
        (0..).map(|i| format!("light_mobile_{}{:05}", tag, i)).filter(|id| crate::node::light_shard_of(id) == shard).take(n).collect()
    }

    /// The chain's registrations, alike at every owner (the same order gives the same roster index).
    fn register(owners: &[&Storage], ids: &[String]) {
        for s in owners {
            for id in ids {
                s.save_node_registration_at_height_burn(id, "light", &format!("w_{}", id), 70.0, 100, &format!("b_{}", id)).unwrap();
            }
        }
    }

    fn idx(s: &Storage, id: &str) -> u32 {
        s.light_roster_entry(id).expect("in the roster").1
    }

    fn bits(indices: &[u32]) -> Vec<u8> {
        let mut bm = vec![0u8; indices.iter().max().map_or(1, |m| *m as usize / 8 + 1)];
        for i in indices { bm[*i as usize / 8] |= 1 << (i % 8); }
        bm
    }

    /// A row of `signer` for `shard` in `epoch` landing on chain: applied by every owner alike.
    fn commit(owners: &[&Storage], epoch: u64, shard: usize, signer: usize, indices: &[u32]) {
        for s in owners {
            s.save_light_bitmap_from(epoch, shard, signer, epoch * E + 14_300, &bits(indices)).unwrap();
        }
    }

    /// The epoch pass at each owner (the boundary after `epoch`).
    fn derive(owners: &[&Storage], epoch: u64) {
        for s in owners {
            s.snapshot_light_eligible(epoch, crate::node::light_roster_cutoff(epoch)).unwrap();
        }
    }

    // ── F5: owner liveness ──

    #[test]
    fn an_owner_is_covered_after_ten_silent_slots_and_handed_back_after_three_heard() {
        let l = OwnerLiveness::new();
        let t0 = 1_800_000_000u64;
        let none = |_: usize| None;
        // Boot guard: nothing is judged silent before this process listened for ten slots, whatever it knows.
        for k in 0..COVER_AFTER_SILENT_SLOTS {
            assert_eq!(l.judge(0, t0 + k * 60, none), [true; 5], "slot {k}: still listening");
        }
        // From then on an owner never heard ticking and never announced is covered.
        assert_eq!(l.judge(0, t0 + 600, none), [true, false, false, false, false]);
        // Owner 1 starts ticking: still covered for two more evaluations, handed back at the third.
        let mut t = t0 + 600;
        for k in 0..RELEASE_AFTER_ALIVE_SLOTS {
            t += 60;
            assert!(l.tick_admissible(1, t - 5, t));
            l.heard(1, t - 5, t);
            let alive = l.judge(0, t, none)[1];
            assert_eq!(alive, k + 1 == RELEASE_AFTER_ALIVE_SLOTS, "evaluation {}", k + 1);
        }
        // A wedged push loop: owner 1 stops ticking while its other announcements go on (legacy age 0). It is
        // judged by ticks alone once heard ticking, so it is taken over after ten silent slots, not before.
        for k in 1..COVER_AFTER_SILENT_SLOTS {
            assert!(l.judge(0, t + k * 60, |_| Some(0))[1], "slot {k}");
        }
        assert!(!l.judge(0, t + COVER_AFTER_SILENT_SLOTS * 60, |_| Some(0))[1], "taken over");
        // A genesis of an earlier release, never heard ticking, is judged by its announcements as before.
        let fresh_legacy = |i: usize| if i == 2 { Some(30) } else { None };
        assert!(l.judge(0, t + 700, fresh_legacy)[2]);
        // Ourselves: always alive.
        assert!(l.judge(3, t + 800, none)[3]);
    }

    #[test]
    fn a_tick_is_taken_only_straight_from_its_genesis_newer_and_spaced() {
        let l = OwnerLiveness::new();
        let now = 1_800_000_000u64;
        assert!(l.tick_admissible(2, now - 3, now));
        l.heard(2, now - 3, now);
        assert!(!l.tick_admissible(2, now - 3, now + 30), "a replay of the same tick");
        assert!(!l.tick_admissible(2, now + 1, now + 5), "too soon after the last");
        assert!(l.tick_admissible(2, now + 55, now + 60));
        assert!(l.tick_admissible(2, now + 7_200, now + 60), "its clock far ahead: heard all the same");
        l.heard(2, now + 7_200, now + 60);
        assert!(!l.tick_admissible(2, now + 100, now + 120), "older on its own clock, within a tick and a half");
        assert!(l.tick_admissible(2, now + 200, now + 60 + TICK_FRESH_SECS + 1), "its clock set back: heard again");
        assert!(!l.tick_admissible(5, now, now), "no such genesis");
        let ip = crate::genesis_constants::GENESIS_NODE_IPS[1].0;
        let other = crate::genesis_constants::GENESIS_NODE_IPS[3].0;
        assert_eq!(ping_tick_sender("genesis_node_002", &format!("{}:10876", ip)), Some(1));
        assert_eq!(ping_tick_sender("genesis_node_002", "genesis_node_002"), Some(1));
        assert_eq!(ping_tick_sender("genesis_node_2", &format!("{}:8001", ip)), Some(1), "the unpadded id");
        assert_eq!(ping_tick_sender("genesis_node_002", &format!("{}:10876", other)), None, "relayed by another host");
        assert_eq!(ping_tick_sender("super_node_1", &format!("{}:10876", ip)), None);
        // The receiver branches on the tick before the relay limit, the active map and the re-gossip.
        let peers = include_str!("../unified_p2p/peers.rs");
        let arm = &peers[peers.find("NetworkMessage::ActiveNodeAnnouncement {").expect("the arm")..];
        let tick = arm.find("if let Some(schedule) = crate::rpc::ping_tick_schedule(&node_type) {").expect("the tick branch");
        assert!(tick < arm.find("if gossip_hop >= 3").unwrap() && tick < arm.find("self.active_full_super_nodes.insert(").unwrap());
        assert_eq!(PING_TICK_HOP, 3, "at the relay limit, so an earlier release drops it unread");
        // Sent after every completed tick, never while behind or while a provider answers none of its pushes.
        let pinger = include_str!("light_nodes.rs");
        let send = pinger.find("p2p.announce_ping_tick().await;").expect("sent");
        let settle = pinger.find("let pushing = PUSH_HEALTH.settle_tick(&blockchain_for_pings.get_storage(), tick_tally.as_deref(), current_slot);").expect("judged");
        assert!(pinger[..send].rfind("if !behind && pushing {").is_some() && pinger.find("tally.log(current_slot, offered);").unwrap() < settle && settle < send);
        assert!(pinger.contains("PUSH_HEALTH.restore(&blockchain_for_pings.get_storage());"));
        assert!(pinger.contains("OWNER_LIVENESS.restore(&blockchain_for_pings.get_storage());"));
        assert!(pinger[send..].contains("OWNER_LIVENESS.keep(&blockchain_for_pings.get_storage());"));
    }

    /// A ping tick names its sender's push schedule in its `node_type`, which the signature covers; a tick of an earlier
    /// build names none and still counts for liveness; any other announcement is no tick. What each genesis named is
    /// kept, across a restart too, and an owner never heard naming one is taken for the bounded draw.
    #[test]
    fn a_ping_tick_names_its_push_schedule_and_it_is_kept() {
        assert_eq!(ping_tick_type(301, 501), "genesis_ping_tick:301:501");
        assert_eq!(ping_tick_schedule(&ping_tick_type(301, 501)), Some(Some((301, 501))));
        assert_eq!(ping_tick_schedule(&ping_tick_type(u64::MAX, u64::MAX)), Some(Some((u64::MAX, u64::MAX))), "not armed");
        assert_eq!(ping_tick_schedule("genesis_ping_tick"), Some(None), "an earlier build");
        assert_eq!(ping_tick_schedule("genesis_ping_tick:7"), Some(None));
        assert_eq!(ping_tick_schedule("genesis_ping_tick:7:8:9"), Some(None));
        assert_eq!(ping_tick_schedule("genesis_ping_tickx:7:8"), None);
        assert_eq!(ping_tick_schedule("super"), None);
        let (dir, s) = {
            let dir = tempfile::TempDir::new().expect("tempdir");
            let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
            (dir, s)
        };
        let o = OwnerSchedules::new();
        assert_eq!(o.get(), [(u64::MAX, u64::MAX); 5], "none heard: the bounded draw");
        o.learn(2, (40, 41));
        o.learn(7, (1, 1));
        o.keep(&s);
        let after = OwnerSchedules::new();
        after.learn(4, (50, 51));
        after.restore(&s);
        assert_eq!(after.get()[2], (40, 41), "kept across a restart");
        assert_eq!(after.get()[4], (50, 51), "one heard since is not overwritten");
        assert_eq!(after.get()[0], (u64::MAX, u64::MAX));
        drop(dir);
        // The sender names the windows it armed; the receiver checks the signature over the type as sent.
        let prop = include_str!("../unified_p2p/propagation.rs");
        assert!(prop.contains("let node_type = crate::rpc::ping_tick_type(FIRST_PUSH_DRAW_WINDOW.load("));
        assert!(prop.contains("let data = format!(\"active:{}:{}:{}:{}:{}\", node_id, node_type, shard_id, reputation as u64, timestamp);"));
        assert!(prop.contains("crate::rpc::OWNER_SCHEDULES.learn(idx, schedule);"));
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("OWNER_SCHEDULES.restore(&blockchain_for_pings.get_storage());"));
        assert!(pinger.contains("OWNER_SCHEDULES.keep(&blockchain_for_pings.get_storage());"));
    }

    /// The audit's case: with a thousand super nodes a backup heard a live owner's gossiped announcement within ten
    /// minutes only by chance. Ticks go straight from owner to owner: lost ticks and an irregular tick length never
    /// make a takeover, where the gossip reading made many.
    #[test]
    fn random_gossip_at_a_thousand_peers_makes_no_takeover_and_ticks_none() {
        let mut rng: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; rng };
        let t0 = 1_800_000_000u64;
        let (l, mut legacy_seen) = (OwnerLiveness::new(), t0);
        let mut owner_t = t0;
        let (mut spurious_ticks, mut spurious_gossip) = (0, 0);
        // Gossip: about 288 of 1,000 peers receive an announcement (fan-out sqrt(n) capped at 8, three hops).
        let reach = 288u64;
        for minute in 0..20_000u64 {
            let now = t0 + minute * 60 + next() % 20;
            // The owner completes a tick every 40-110 s; a fifth of its ticks are lost on the way.
            loop {
                let gap = 40 + next() % 70;
                if owner_t + gap > now { break; }
                owner_t += gap;
                if next() % 5 != 0 && l.tick_admissible(1, owner_t, now) { l.heard(1, owner_t, now); }
                if next() % 1000 < reach { legacy_seen = owner_t; }
            }
            if !l.judge(0, now, |_| None)[1] { spurious_ticks += 1; }
            if minute >= COVER_AFTER_SILENT_SLOTS && now.saturating_sub(legacy_seen) >= COVER_AFTER_SILENT_SLOTS * 60 { spurious_gossip += 1; }
        }
        assert_eq!(spurious_ticks, 0, "a live owner is never taken over from its ticks");
        assert!(spurious_gossip > 0, "the gossip reading would have taken it over: {spurious_gossip}");
    }

    /// Servers' clocks differ, by any amount: the sender's clock only orders its own ticks. Over 8,000 slots with ticks
    /// 40-110 s apart and a fifth of them lost: an owner an hour ahead, one an hour behind and one whose clock is set
    /// back two hours are never taken over; a restart of seven minutes makes no takeover; an owner that stops is
    /// covered after ten slots and handed back three ticks after it returns; and this genesis's own clock set back an
    /// hour neither hands a covered owner back nor covers a live one.
    #[test]
    fn ticks_are_heard_whatever_the_clocks_read() {
        let mut rng: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; rng };
        let l = OwnerLiveness::new();
        let t0 = 1_800_000_000u64;
        // Each owner's clock against the real time.
        let offset = |i: usize, minute: u64| -> i64 {
            match i { 1 => 3_600, 2 => -3_600, 3 if minute >= 3_000 => -7_200, _ => 0 }
        };
        // Owner 4: restarted for seven minutes at slot 4,000, stopped from 6,000, back at 7,000; it loses no tick, so its
        // silences are exactly these. Our own clock is set back an hour from slot 6,500, while owner 4 is covered.
        let down = |minute: u64| (4_000..4_007).contains(&minute) || (6_000..7_000).contains(&minute);
        let mut last_tick = [t0; 5];
        let (mut covered_at, mut released_at) = (None, None);
        for minute in 0..8_000u64 {
            let real = t0 + minute * 60 + next() % 20;
            let mine = if minute >= 6_500 { real - 3_600 } else { real };
            for i in 1..5usize {
                loop {
                    let gap = 40 + next() % 70;
                    if last_tick[i] + gap > real { break; }
                    last_tick[i] += gap;
                    let lost = if i == 4 { down(minute) } else { next() % 5 == 0 };
                    if lost { continue; }
                    let ts = (last_tick[i] as i64 + offset(i, minute)) as u64;
                    if l.tick_admissible(i, ts, mine) { l.heard(i, ts, mine); }
                }
            }
            let alive = l.judge(0, mine, |_| None);
            assert!(alive[1] && alive[2] && alive[3], "slot {minute}: a live owner taken over {alive:?}");
            if minute < 6_000 {
                assert!(alive[4], "slot {minute}: a restart of seven minutes makes no takeover");
            } else if !alive[4] && covered_at.is_none() {
                covered_at = Some(minute);
            } else if alive[4] && covered_at.is_some() && released_at.is_none() {
                released_at = Some(minute);
            }
            if (6_020..7_000).contains(&minute) {
                assert!(!alive[4], "slot {minute}: still covered, our clock set back or not");
            }
        }
        let (covered_at, released_at) = (covered_at.expect("covered"), released_at.expect("handed back"));
        assert!((6_008..=6_012).contains(&covered_at), "covered at slot {covered_at}");
        assert!((7_002..=7_015).contains(&released_at), "handed back at slot {released_at}");
    }

    /// A backup restarted while its primary is quiet (its provider refuses every push, `PushHealth`, its other
    /// announcements going on) covers the primary's shard ten slots after it listened, as the backup that never
    /// restarted does: it remembers the primary ticks. Without that it judged the primary by its announcements and left
    /// the shard to the failing primary. The primary is handed back three ticks after it resumes, a step back of this
    /// genesis's clock hands nothing back, and a genesis never heard ticking (an earlier release) is judged as before.
    #[test]
    fn a_backup_restarted_while_its_primary_is_quiet_still_covers_it() {
        let (s, _d) = storage();
        let t0 = 1_800_000_000u64;
        let announcing = |_: usize| Some(0u64);
        let before = OwnerLiveness::new();
        before.keep(&s);
        assert_eq!(s.load_raw(OWNER_TICKING_KEY).ok().flatten(), None, "nothing heard, nothing stored");
        for k in 0..5u64 {
            before.heard(1, t0 + k * 60, t0 + k * 60);
        }
        before.keep(&s);
        assert_eq!(s.load_raw(OWNER_TICKING_KEY).ok().flatten(), Some(vec![0b10]));
        // Restarted at t1: genesis 1 went quiet meanwhile and sends no tick, while its announcements go on.
        let t1 = t0 + 3_600;
        let restarted = OwnerLiveness::new();
        let forgetful = OwnerLiveness::new();
        restarted.restore(&s);
        for k in 0..COVER_AFTER_SILENT_SLOTS {
            assert!(restarted.judge(0, t1 + k * 60, announcing)[1], "slot {k}: still listening");
        }
        for k in COVER_AFTER_SILENT_SLOTS..COVER_AFTER_SILENT_SLOTS + 30 {
            assert!(!restarted.judge(0, t1 + k * 60, announcing)[1], "slot {k}: covered");
            assert!(forgetful.judge(0, t1 + k * 60, announcing)[1], "slot {k}: the announcements alone kept it");
        }
        // This genesis's clock set back an hour while covering: the listening starts again, the cover holds.
        let back = t1 + 40 * 60 - 3_600;
        for k in 0..COVER_AFTER_SILENT_SLOTS + 2 {
            assert!(!restarted.judge(0, back + k * 60, announcing)[1], "set back, slot {k}: still covered");
        }
        // Genesis 1 resumes: handed back at its third tick heard.
        let mut t = back + (COVER_AFTER_SILENT_SLOTS + 2) * 60;
        for k in 0..RELEASE_AFTER_ALIVE_SLOTS {
            t += 60;
            assert!(restarted.tick_admissible(1, t, t));
            restarted.heard(1, t, t);
            assert_eq!(restarted.judge(0, t, announcing)[1], k + 1 == RELEASE_AFTER_ALIVE_SLOTS, "tick {}", k + 1);
        }
        // Never heard ticking: judged by its announcements, as before.
        assert!(restarted.judge(0, t + 60, announcing)[2], "never heard ticking, announcing: alive");
        assert!(!restarted.judge(0, t + 120, |i| (i != 2).then_some(0))[2], "never heard ticking, never announced: covered");
    }

    // ── A genesis whose provider takes none of its pushes ──

    /// Quiet after QUIET_AFTER_FAILED_TICKS ticks in a row with pushes sent and none answered; back at one answered.
    /// Partial failures never count, and a burst of refusals shorter than that never silences a genesis.
    #[test]
    fn a_genesis_goes_quiet_after_five_failed_ticks_and_resumes_on_one_answer() {
        let h = PushHealth::new();
        assert_eq!(QUIET_AFTER_FAILED_TICKS, 5);
        for k in 1..QUIET_AFTER_FAILED_TICKS {
            assert_eq!(h.after_tick(400, 0), (true, false), "failed tick {k}: still ticking");
        }
        assert_eq!(h.after_tick(400, 0), (false, true), "quiet at the fifth");
        assert_eq!(h.after_tick(400, 0), (false, false));
        assert_eq!(h.after_tick(0, 0), (false, false), "a tick with no push: still quiet");
        assert_eq!(h.after_tick(400, 1), (true, true), "one push answered: ticking again");
        assert_eq!(h.after_tick(400, 0), (true, false), "the count starts again");
        for k in 0..100 {
            assert_eq!(h.after_tick(400, 1 + k % 3), (true, false), "a provider taking some pushes is working");
        }
        // Bursts of refusals one tick short of the rule, each ended by one answered push, for a thousand ticks: never quiet.
        let h = PushHealth::new();
        for tick in 0..1_000u32 {
            let answered = u64::from(tick % QUIET_AFTER_FAILED_TICKS == QUIET_AFTER_FAILED_TICKS - 1);
            assert_eq!(h.after_tick(900, answered), (true, false), "tick {tick}");
        }
        // The pinger counts each push on its channel.
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("tally.took(&channel);") && pinger.contains("tally.failed(&channel, gone, &e);"));
    }

    /// Only the provider whose credentials this genesis holds is judged. A push server endpoint is the device owner's,
    /// any host: one that refuses every push (down, or hostile) silences no owner that pushes it, which would otherwise
    /// cascade to all three owners of its shard; and push servers answering never hide the provider's outage.
    #[test]
    fn only_the_provider_is_judged_never_a_push_server() {
        let (fcm, up) = (PushChannel::Fcm("t".into()), PushChannel::UnifiedPush("https://push.example/x".into()));
        assert!(fcm.is_provider() && !up.is_provider());
        let h = PushHealth::new();
        for tick in 0..100 {
            let t = PushTally::default();
            for _ in 0..3 { t.failed(&up, false, "status 503 Service Unavailable"); }
            assert_eq!(t.provider_answers(), (0, 0));
            assert_eq!(h.after_tick(t.provider_answers().0, t.provider_answers().1), (true, false), "tick {tick}: a dead endpoint");
        }
        // The provider refusing everything while the push servers answer: quiet all the same, back on the provider.
        let refused = |up_answers: u64| {
            let t = PushTally::default();
            t.failed(&fcm, false, "API error: 401 Unauthorized - x");
            for _ in 0..up_answers { t.took(&up); }
            t
        };
        for _ in 1..QUIET_AFTER_FAILED_TICKS {
            assert!(h.settle_tick(&storage().0, Some(&refused(12)), 1));
        }
        let t = refused(12);
        assert_eq!(t.provider_answers(), (1, 0));
        assert_eq!(t.provider_err(), Some("API error: 401 Unauthorized - x"));
        assert!(!h.settle_tick(&storage().0, Some(&t), 1), "quiet whatever the push servers answer");
        let t = PushTally::default();
        t.took(&fcm);
        assert!(h.settle_tick(&storage().0, Some(&t), 2));
    }

    /// A token the provider says is gone is its answer: a genesis whose every push meets a gone token is working. A
    /// shed or polled node sends nothing to a provider, so it changes nothing.
    #[test]
    fn a_token_gone_counts_as_a_working_provider() {
        let (fcm, up) = (PushChannel::Fcm("t".into()), PushChannel::UnifiedPush("https://push.example/x".into()));
        let gone_err = "API error: 404 Not Found - UNREGISTERED";
        assert!(push_target_gone(gone_err) && push_target_gone("status 410 Gone"));
        let h = PushHealth::new();
        for tick in 0..20 {
            let t = PushTally::default();
            for _ in 0..10 { t.failed(&fcm, true, gone_err); }
            t.failed(&up, true, "status 410 Gone");
            t.shed.fetch_add(5, Ordering::Relaxed);
            t.polled.fetch_add(5, Ordering::Relaxed);
            assert_eq!(t.provider_answers(), (10, 10));
            assert_eq!(t.provider_err(), None, "a gone token is no refusal");
            assert_eq!(h.after_tick(10, 10), (true, false), "tick {tick}: every token gone, the provider worked");
        }
        // Refusals of any other kind are no answer; the summary line is as before.
        let t = PushTally::default();
        t.failed(&up, false, "status 500 Internal Server Error");
        t.failed(&fcm, false, "network error: timed out");
        t.failed(&fcm, push_target_gone("API error: 401 Unauthorized"), "API error: 401 Unauthorized");
        t.took(&up);
        assert_eq!(t.provider_answers(), (2, 0));
        assert_eq!(t.provider_err(), Some("network error: timed out"), "the provider's own first refusal");
        assert_eq!(t.summary(7, 4).1, "push_tick slot=7 offered=4 sent=4 accepted=1 failed=3 gone=0 polled=0 shed=0 first_err=\"status 500 Internal Server Error\"");
        // Only shed or polled: nothing sent, nothing changes, in either standing.
        let t = PushTally::default();
        t.shed.fetch_add(900, Ordering::Relaxed);
        t.polled.fetch_add(900, Ordering::Relaxed);
        assert_eq!(t.provider_answers(), (0, 0));
    }

    /// Sparse pushes: a tick that sent nothing neither silences a working genesis nor wakes a quiet one, so the
    /// standing changes once into an outage and once out of it, never in between.
    #[test]
    fn sparse_pushes_never_flap_the_standing() {
        let h = PushHealth::new();
        let (outage, back) = (300u64, 600u64);
        let mut changes = Vec::new();
        for tick in 0..1_000u64 {
            // One push every seventh tick; before the outage every other one of them refused.
            let sent = u64::from(tick % 7 == 0);
            let answered = match tick {
                t if t < outage => sent * u64::from(t % 14 == 0),
                t if t < back => 0,
                _ => sent,
            };
            let (ticking, changed) = h.after_tick(sent, answered);
            if changed { changes.push((tick, ticking)); }
            if tick < outage { assert!(ticking, "tick {tick}: sparse and partly refused, still working"); }
        }
        let first_failed = (outage..).find(|t| t % 7 == 0).unwrap();
        let quiet = first_failed + 7 * (QUIET_AFTER_FAILED_TICKS as u64 - 1);
        let resumed = (back..).find(|t| t % 7 == 0).unwrap();
        assert_eq!(changes, vec![(quiet, false), (resumed, true)], "one change each way");
        // Ticks with no push at all, in either standing: nothing changes.
        let h = PushHealth::new();
        for _ in 0..1_000 { assert_eq!(h.after_tick(0, 0), (true, false)); }
        for _ in 0..QUIET_AFTER_FAILED_TICKS { h.after_tick(1, 0); }
        for _ in 0..1_000 { assert_eq!(h.after_tick(0, 0), (false, false)); }
    }

    /// A genesis restarted while quiet stays quiet until a push is answered: ticking at once would hand its shards
    /// back for the ten slots until the owners below covered them again.
    #[test]
    fn a_quiet_genesis_stays_quiet_across_a_restart() {
        let (s, _d) = storage();
        let fcm = PushChannel::Fcm("t".into());
        let refused = PushTally::default();
        refused.failed(&fcm, false, "credentials refused");
        let h = PushHealth::new();
        for k in 1..=QUIET_AFTER_FAILED_TICKS {
            assert_eq!(h.settle_tick(&s, Some(&refused), k as u64), k < QUIET_AFTER_FAILED_TICKS, "tick {k}");
        }
        let restarted = PushHealth::new();
        restarted.restore(&s);
        assert!(!restarted.settle_tick(&s, None, 10), "restarted: quiet, no push yet");
        let taken = PushTally::default();
        taken.took(&fcm);
        assert!(restarted.settle_tick(&s, Some(&taken), 11), "one push taken: ticking");
        let again = PushHealth::new();
        again.restore(&s);
        assert!(again.settle_tick(&s, None, 12), "the resumed standing is kept too");
        let fresh = PushHealth::new();
        fresh.restore(&storage().0);
        assert!(fresh.settle_tick(&s, None, 13), "nothing stored: ticking");
    }

    /// A provider-wide outage: every genesis's pushes are refused, so every genesis goes quiet and covers the shards it
    /// backs up, paced within its cap (900 a second for each shard covered, three at most: 2,700 a second, 2,800 with
    /// the wakes). With the provider back each resumes, and three heard ticks later every shard is pushed by its own
    /// genesis alone again.
    #[test]
    fn a_provider_wide_outage_stays_within_the_cap_and_recovery_hands_every_shard_back() {
        let t0 = 1_800_000_000u64;
        let lives: [OwnerLiveness; 5] = std::array::from_fn(|_| OwnerLiveness::new());
        let health: [PushHealth; 5] = std::array::from_fn(|_| PushHealth::new());
        let (down, up) = (30u64, 90u64);
        let (mut quiet_at, mut resumed_at) = ([None; 5], [None; 5]);
        let mut covered_by_minute = Vec::new();
        for minute in 0..160u64 {
            let now = t0 + minute * 60;
            let mut covered = [0usize; 5];
            for g in 0..5 {
                let alive = lives[g].judge(g, now, |_| None);
                let shards = crate::node::light_shards_to_cover(g, &|i| alive[i]);
                assert!(shards.contains(&(g, 0)), "minute {minute}: genesis {g} always pushes its own shard");
                covered[g] = shards.len();
                let rate = epoch_push_rate(covered[g]);
                assert!(rate == covered[g] as u64 * EPOCH_PUSHES_PER_SEC && rate + WAKE_PUSHES_PER_SEC <= PUSH_QUOTA_PER_SEC);
            }
            covered_by_minute.push(covered);
            for g in 0..5 {
                // Some three hundred pushes for each shard covered: all refused in the outage, nine in ten taken else.
                let sent = 300 * covered[g] as u64;
                let answered = if (down..up).contains(&minute) { 0 } else { sent * 9 / 10 };
                let (ticking, changed) = health[g].after_tick(sent, answered);
                match (changed, ticking) {
                    (true, false) => quiet_at[g] = Some(minute),
                    (true, true) => resumed_at[g] = Some(minute),
                    _ => {}
                }
                if ticking {
                    for o in (0..5).filter(|o| *o != g) {
                        if lives[o].tick_admissible(g, now, now) { lives[o].heard(g, now, now); }
                    }
                }
            }
        }
        // Each genesis's last tick goes out after its fourth refused tick, and it is quiet from the fifth.
        let last_tick = down + QUIET_AFTER_FAILED_TICKS as u64 - 2;
        assert_eq!(quiet_at, [Some(last_tick + 1); 5]);
        assert_eq!(resumed_at, [Some(up); 5]);
        let covers_all = last_tick + COVER_AFTER_SILENT_SLOTS;
        let hands_back = up + RELEASE_AFTER_ALIVE_SLOTS as u64;
        for (minute, covered) in covered_by_minute.iter().enumerate() {
            let m = minute as u64;
            let want = if (covers_all..hands_back).contains(&m) { MAX_COVERED_SHARDS as usize } else { 1 };
            assert_eq!(*covered, [want; 5], "minute {m}");
        }
        // The pacer at each count of shards covered: at most that many shares in any second, so at three shards
        // 2,700 epoch pushes a second and the quota with the wakes.
        let t = 1_800_000_000_000_000u64;
        for k in 1..=MAX_COVERED_SHARDS as usize {
            let pacer = PushPacer::new(EPOCH_PUSHES_PER_SEC);
            pacer.set_rate(epoch_push_rate(k));
            let instants: Vec<u64> = std::iter::from_fn(|| pacer.reserve(t, t + PACE_WINDOW_US)).collect();
            let mut peak = 0usize;
            let mut j = 0usize;
            for i in 0..instants.len() {
                while j < instants.len() && instants[j] < instants[i] + 1_000_000 { j += 1; }
                peak = peak.max(j - i);
            }
            assert_eq!(peak as u64, k as u64 * EPOCH_PUSHES_PER_SEC, "{k} shards: the busiest second");
            assert!(instants.len() as u64 >= k as u64 * EPOCH_PUSHES_PER_SEC * PACE_WINDOW_US / 1_000_000, "{k} shards: a full slot's instants");
        }
        assert_eq!(epoch_push_rate(MAX_COVERED_SHARDS as usize) + WAKE_PUSHES_PER_SEC, PUSH_QUOTA_PER_SEC);
        assert_eq!(PUSH_QUOTA_PER_SEC, 2_800);
    }

    #[test]
    fn a_genesis_behind_the_network_stays_quiet() {
        assert!(!pinger_behind(10 * E + 100, 0), "no corroborated head: not judged");
        assert!(!pinger_behind(10 * E + 100, 10 * E + 100 + PUSH_MAX_LAG_BLOCKS));
        assert!(pinger_behind(10 * E + 100, 10 * E + 101 + PUSH_MAX_LAG_BLOCKS), "more than a minute behind");
        assert!(pinger_behind(11 * E - 2, 11 * E + 1), "another epoch");
        assert!(!pinger_behind(10 * E + 500, 10 * E + 400), "ahead of the head");
        // No push, no tick, no polling challenge, no wake while behind.
        let pinger = include_str!("light_nodes.rs");
        assert!(pinger.contains("let selection = if behind {")
            && pinger.contains("tokio::task::spawn_blocking(move || p2p.get_light_nodes_to_ping(tip)).await.unwrap_or_default()"));
        assert!(pinger.contains("if gap || this_genesis_behind() {"));
        assert!(include_str!("light_push.rs").contains("if this_genesis_behind() {"));
    }

    // ── F1, F3: the dormant rule ──

    #[test]
    fn a_reach_record_round_trips_within_its_bound() {
        let rec = encode_reach(&[0, 7, 8, 1_000_003]).unwrap();
        let bm = decode_reach(&rec).unwrap();
        assert!(bit(&bm, 0) && bit(&bm, 7) && bit(&bm, 8) && bit(&bm, 1_000_003));
        assert!(!bit(&bm, 1) && !bit(&bm, 1_000_002) && !bit(&bm, 9_000_000));
        assert_eq!(decode_reach(&encode_reach(&[]).unwrap()), Some(Vec::new()));
        assert!(encode_reach(&[(REACH_MAX_BYTES * 8) as u32]).is_none(), "past the bound");
        assert!(rec.len() < 200, "sparse records are small: {}", rec.len());
        // As the internal route serves it and a puller takes it; a record that does not decode is no record.
        let served = json!({"success": true, "epoch": 9, "shard": 2, "signer": "genesis_node_003",
                            "reach": base64::engine::general_purpose::STANDARD.encode(&rec)});
        assert_eq!(pulled_reach(&served), Some(Some(rec.clone())));
        assert_eq!(pulled_reach(&json!({"success": true, "reach": null})), Some(None), "none of a decided epoch");
        assert_eq!(pulled_reach(&json!({"success": false, "reason": "not_decided"})), None);
        assert_eq!(pulled_reach(&json!({"success": true, "reach": "bm90IHpzdGQ="})), None);
    }

    /// Each owner pulls the two others' records of the two epochs before, once each, retried while not decided.
    #[test]
    fn the_other_owners_records_are_pulled_once_each() {
        let p = ReachPulls::new();
        let now = 1_800_000_000u64;
        let tip = 50 * E + 10;
        let due = p.due(0, tip, now);
        assert!(due.iter().all(|(e, _, _)| *e == 48), "the epoch just ended waits for its owners to decide it");
        assert_eq!(due.len(), 3 * 2, "three shards owned, two other owners each");
        assert!(due.iter().all(|(_, sh, o)| *o != 0 && crate::node::light_owner_rank(*sh, 0).is_some()
            && crate::node::light_owner_rank(*sh, *o).is_some()));
        assert!(p.due(0, tip, now + 10).is_empty(), "claimed meanwhile");
        p.settle(due[0]);
        let later = p.due(0, 50 * E + 40, now + REACH_PULL_RETRY_SECS);
        assert_eq!(later.len(), 6 + 5, "epoch 49 now, and the five of 48 not settled");
        assert!(!later.contains(&due[0]));
        // This genesis's clock set back an hour: the claims made before it are due at once, not an hour later.
        assert_eq!(p.due(0, 50 * E + 41, now - 3_600).len(), 6 + 5);
    }

    /// The audit's tests of the rule, at one owner: memory empty but the committed index counts the node: pushed;
    /// every push failed or shed in both epochs: pushed; reached twice with no answer: dormant, and held so the next
    /// epoch (no flip-flop); a shard with no row: neutral; the records survive a restart.
    #[test]
    fn only_two_proven_device_misses_make_a_node_dormant() {
        let (dir, cache) = (tempfile::TempDir::new().unwrap(), ReachCache::new());
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let shard = 2usize;
        let ids = ids_of(shard, 4, "rule");
        let (counted, failed, silent, other) = (&ids[0], &ids[1], &ids[2], &ids[3]);
        register(&[&s], &ids);
        let ix = |id: &str| idx(&s, id);
        let (e2, e1, e0) = (40u64, 41u64, 42u64);
        // Both epochs committed and derived; `counted` is in the index, the others are not.
        for e in [e2, e1] {
            commit(&[&s], e, shard, shard, &[ix(counted)]);
            derive(&[&s], e);
        }
        // This owner reached `counted` (it answered at another owner) and `silent`; `failed` only failed or was shed.
        for e in [e2, e1] {
            let entries = vec![(counted.clone(), PushEntry { epoch: e, woken_at: 5, ..PushEntry::default() }),
                               (failed.clone(), PushEntry { epoch: e, sends: 3, unsent: 3, ..PushEntry::default() }),
                               (silent.clone(), PushEntry { epoch: e, woken_at: 5, ..PushEntry::default() })];
            let reached = reached_unanswered(&entries, |_| false);
            assert_eq!(save_reach_records(&s, e, shard, &reached), 2);
        }
        let facts = DormantFacts::read(&s, e0);
        assert!(!facts.neutral(shard));
        let dormant = |id: &str, e: u64, f: &DormantFacts| proven_dormant(&s, &cache, f, id, shard, e);
        assert!(!dormant(counted, e0, &facts), "the committed index counts it: pushed");
        assert!(!dormant(failed, e0, &facts), "every push failed or shed: the system's miss, pushed");
        assert!(!dormant(other, e0, &facts), "never reached: pushed");
        assert!(dormant(silent, e0, &facts), "reached twice, no answer: dormant");
        // E0: held dormant (nothing pushed); its record carries the hold, so E0+1 keeps it dormant.
        let held = vec![(silent.clone(), PushEntry { epoch: e0, dormant: true, ..PushEntry::default() })];
        assert_eq!(held[0].1.miss(9), None, "a hold writes no row: the status derives it");
        save_reach_records(&s, e0, shard, &reached_unanswered(&held, |_| false));
        commit(&[&s], e0, shard, shard, &[ix(counted)]);
        derive(&[&s], e0);
        let next = DormantFacts::read(&s, e0 + 1);
        let fresh_cache = ReachCache::new();
        assert!(proven_dormant(&s, &fresh_cache, &next, silent, shard, e0 + 1), "stays dormant: no flip-flop");
        // Its own answer in E0 + 1 (the app, or "I'm back") puts it in that epoch's index: pushed again in E0 + 2.
        commit(&[&s], e0 + 1, shard, shard, &[ix(counted), ix(silent)]);
        derive(&[&s], e0 + 1);
        assert!(!proven_dormant(&s, &fresh_cache, &DormantFacts::read(&s, e0 + 2), silent, shard, e0 + 2), "back from its own answer");
        // A shard that committed no row in either epoch before: neutral for all its nodes.
        let lonely = (0..5).find(|g| *g != shard).unwrap();
        assert!(DormantFacts::read(&s, e0).neutral(lonely), "no row of that shard");
        assert!(DormantFacts::read(&s, 1).neutral(shard), "not derived here");
        assert!(DormantFacts::default().neutral(shard));
        // The records survive a restart: reopened, the same verdict.
        drop(s);
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        assert!(proven_dormant(&s, &ReachCache::new(), &DormantFacts::read(&s, e0), silent, shard, e0));
    }

    /// A backup reading a shard's records while the primary's pulled record is being stored keeps no OR without it: its
    /// next read sees the record, so it holds the node dormant as the other owners do, not for an epoch after.
    #[test]
    fn a_record_pulled_while_the_or_is_read_is_not_lost() {
        let (s, _d) = storage();
        let shard = 2usize;
        let ids = ids_of(shard, 1, "race");
        register(&[&s], &ids);
        let i = idx(&s, &ids[0]);
        let (cache, epoch) = (ReachCache::new(), 30u64);
        // The read began with no record held ...
        let stored = cache.stored.load(Ordering::Acquire);
        let read = Arc::new(Vec::new());
        // ... the pull stored the primary's record meanwhile ...
        s.put_light_reach(epoch, shard, shard, &encode_reach(&[i]).unwrap()).unwrap();
        cache.forget(epoch, shard);
        // ... so the OR read before it is not kept.
        assert!(!bit(&cache.keep(epoch, shard, read, stored), i));
        assert!(!cache.map.lock().contains_key(&(epoch, shard)));
        assert!(cache.reached(&s, epoch, shard, i), "read again: the record counts");
        assert!(cache.map.lock().contains_key(&(epoch, shard)), "kept when nothing was stored meanwhile");
    }

    /// F11: the sweep is per shard. The own shard has rows in both epochs before, a covered shard has none: the
    /// dormant nodes of the own shard stay unpushed while every node of the covered shard is pushed.
    #[test]
    fn the_recovery_sweep_covers_only_the_shard_that_failed() {
        let (s, _d) = storage();
        let (own, covered) = (1usize, 0usize);
        let ids = ids_of(own, 2, "own");
        register(&[&s], &ids);
        for e in [60u64, 61] {
            commit(&[&s], e, own, own, &[idx(&s, &ids[0])]);
            derive(&[&s], e);
            let silent = vec![(ids[1].clone(), PushEntry { epoch: e, woken_at: 1, ..PushEntry::default() })];
            save_reach_records(&s, e, own, &reached_unanswered(&silent, |_| false));
        }
        let facts = DormantFacts::read(&s, 62);
        assert!(!facts.neutral(own) && facts.neutral(covered), "{:05b}", facts.decidable);
        assert!(proven_dormant(&s, &ReachCache::new(), &facts, &ids[1], own, 62), "the own shard's dormant node stays unpushed");
        let prop = include_str!("../unified_p2p/propagation.rs");
        assert!(prop.contains("let check = !fresh && !facts.neutral(shard) && !answered_before;"), "applied by the node's shard");
    }

    // ── Three owners together ──

    /// F2: the primary restarts in under 600 s; meanwhile the device answers backup 1, and the relay to the primary
    /// is lost. The primary's row lacks it, backup 1's row adds exactly it, backup 2 stands down: the answer is in the OR.
    #[test]
    fn a_restart_under_600_s_keeps_an_answer_taken_at_backup_1_in_the_or() {
        let shard = 3usize;
        let [p, b1, _] = crate::node::light_shard_owners(shard);
        let (sp, _a) = storage();
        let (s1, _b) = storage();
        let (s2, _c) = storage();
        let all = [&sp, &s1, &s2];
        let ids = ids_of(shard, 3, "f2");
        register(&all, &ids);
        let (a, c, d) = (idx(&sp, &ids[0]), idx(&sp, &ids[1]), idx(&sp, &ids[2]));
        let epoch = 70u64;
        // Each owner's answers of the epoch: the primary lost `a` in its restart; backup 1 took `a` and holds the
        // relays of `c` and `d`; backup 2 got the relays of `a` and `c`.
        let (held_p, held_1, held_2) = (vec![c, d], vec![a, c, d], vec![a, c]);
        // The primary emits first, from its own memory, at the window's open.
        commit(&all, epoch, shard, p, &held_p);
        let or = |s: &Storage| s.load_light_bitmaps(epoch).unwrap().get(&shard).cloned();
        assert!(!crate::node::light_owner_stands_down(1, false, None), "backup 1 compares before it stands down");
        let missing_1 = crate::node::light_missing_bits(&held_1, or(&s1).as_deref());
        assert_eq!(missing_1, vec![a], "backup 1 emits only what the OR lacks");
        assert!(!crate::node::light_owner_stands_down(1, false, Some(missing_1.len())));
        commit(&all, epoch, shard, b1, &missing_1);
        let missing_2 = crate::node::light_missing_bits(&held_2, or(&s2).as_deref());
        assert!(missing_2.is_empty() && crate::node::light_owner_stands_down(2, false, Some(0)), "backup 2 stands down");
        for s in all {
            let bm = or(s).unwrap();
            assert!([a, c, d].iter().all(|i| bit(&bm, *i)), "every answer is in the OR at every owner");
        }
        derive(&all, epoch);
        assert!(all.iter().all(|s| s.light_counted_in(epoch, &ids[0])), "the device is counted");
        // Only an answer anchored before the commit opened is admitted by relay, so the extra row holds nothing late.
        let opens = crate::rpc::commit_opens_at(epoch);
        assert!(relay_creditable(opens - 1, epoch));
        assert!(!relay_creditable(opens, epoch), "a relay anchored in the commit window");
        assert!(!relay_creditable(epoch * E - 1, epoch), "another epoch's");
        // The commit loop compares at the backup's deadline and emits the missing bits only.
        let life = include_str!("../node/lifecycle.rs");
        assert!(life.contains("eligible_indices = crate::node::light_missing_bits(&eligible_indices, or_rows.map(|v| v.as_slice()));"));
        assert!(life.contains("light_owner_stands_down(target_rank, false, or_rows.map(|_| eligible_indices.len()))"));
    }

    /// F1: the primary is down from early E-2 to early E. Backup 1 covered and committed both epochs with device D;
    /// the primary's memory and reach records hold nothing of them. Back at E it pushes D: the committed index
    /// counts it, and nothing proves a miss.
    #[test]
    fn a_primary_down_for_two_epochs_pushes_again_when_it_returns() {
        let shard = 4usize;
        let b1 = crate::node::light_shard_owners(shard)[1];
        let (sp, _a) = storage();
        let (s1, _b) = storage();
        let ids = ids_of(shard, 2, "f1");
        register(&[&sp, &s1], &ids);
        let dev = idx(&sp, &ids[0]);
        for e in [80u64, 81] {
            commit(&[&sp, &s1], e, shard, b1, &[dev]);
            derive(&[&sp, &s1], e);
        }
        let facts = DormantFacts::read(&sp, 82);
        assert!(!facts.neutral(shard), "both epochs committed by backup 1 and derived at the primary");
        assert!(!proven_dormant(&sp, &ReachCache::new(), &facts, &ids[0], shard, 82), "pushed again at the primary");
        // Even a record of backup 1's that names the device (reached on another push of the epoch) proves nothing
        // while the committed index counts it.
        let entries = vec![(ids[0].clone(), PushEntry { epoch: 81, woken_at: 3, ..PushEntry::default() })];
        save_reach_records(&sp, 81, b1, &reached_unanswered(&entries, |_| false));
        assert!(!proven_dormant(&sp, &ReachCache::new(), &facts, &ids[0], shard, 82));
    }

    /// Dormant after two proven misses on all three owners, and pushes stop on the backups too: the primary reached
    /// the device twice with no answer; each backup pulled the primary's records (as the internal route serves them),
    /// so a backup that covers the shard in E holds it dormant as the primary would.
    #[test]
    fn two_proven_misses_make_the_node_dormant_at_all_three_owners() {
        let shard = 0usize;
        let owners = crate::node::light_shard_owners(shard);
        let (sp, _a) = storage();
        let (s1, _b) = storage();
        let (s2, _c) = storage();
        let all = [&sp, &s1, &s2];
        let ids = ids_of(shard, 2, "dorm");
        register(&all, &ids);
        let (live, gone) = (&ids[0], &ids[1]);
        for e in [90u64, 91] {
            commit(&all, e, shard, owners[0], &[idx(&sp, live)]);
            derive(&all, e);
            let pushed = vec![(gone.clone(), PushEntry { epoch: e, woken_at: 7, ..PushEntry::default() })];
            save_reach_records(&sp, e, owners[0], &reached_unanswered(&pushed, |_| false));
            // Each backup pulls the record as served.
            let rec = sp.light_reach(e, shard, owners[0]).unwrap();
            let served = json!({"success": true, "epoch": e, "shard": shard, "signer": "genesis_node_001",
                                "reach": base64::engine::general_purpose::STANDARD.encode(&rec)});
            for b in [&s1, &s2] {
                b.put_light_reach(e, shard, owners[0], &pulled_reach(&served).unwrap().unwrap()).unwrap();
            }
        }
        for (i, s) in all.iter().enumerate() {
            let facts = DormantFacts::read(s, 92);
            assert!(proven_dormant(s, &ReachCache::new(), &facts, gone, shard, 92), "owner rank {i}: dormant");
            assert!(!proven_dormant(s, &ReachCache::new(), &facts, live, shard, 92), "owner rank {i}: the live node is pushed");
        }
        // A backup that has not pulled the records cannot prove the misses: it pushes (the safe direction).
        let (s3, _d) = storage();
        register(&[&s3], &ids);
        for e in [90u64, 91] {
            commit(&[&s3], e, shard, owners[0], &[idx(&s3, live)]);
            derive(&[&s3], e);
        }
        assert!(!proven_dormant(&s3, &ReachCache::new(), &DormantFacts::read(&s3, 92), gone, shard, 92));
        // The selection holds a dormant node through the ledger, so the next epoch's record carries it.
        let prop = include_str!("../unified_p2p/propagation.rs");
        assert!(prop.contains("crate::rpc::PUSH_LEDGER.record(&node_id, now_slot, crate::rpc::SendOutcome::Dormant, now_secs);"));
    }

    /// "I'm back" or the app opened during a dormant epoch: the owner that takes the answer relays it to the other
    /// two and to nobody else; each admits it (anchored before the commit), so all three hold it in the same epoch and
    /// the node is pushed again from the next one at every owner.
    #[test]
    fn a_return_is_seen_by_all_three_owners_in_the_same_epoch() {
        let shard = 1usize;
        let owners = crate::node::light_shard_owners(shard);
        for taker in [Some(owners[0]), Some(owners[1]), Some(owners[2]), Some((shard + 3) % 5), None] {
            let targets = light_relay_targets(shard, taker);
            let mut seen: Vec<usize> = targets.clone();
            if let Some(t) = taker.filter(|t| owners.contains(t)) { seen.push(t); }
            seen.sort();
            assert_eq!(seen, owners.to_vec(), "taken at {taker:?}: all three owners hold it, nobody else is sent it");
            assert!(targets.iter().all(|t| owners.contains(t)));
        }
        let epoch = 100u64;
        assert!(relay_creditable(epoch * E + 7_000, epoch), "admitted at every owner");
        // In the next epoch, at every owner: the answer is in the committed index, so nothing proves a miss.
        let (s0, _a) = storage();
        let (s1, _b) = storage();
        let (s2, _c) = storage();
        let all = [&s0, &s1, &s2];
        let ids = ids_of(shard, 2, "back");
        register(&all, &ids);
        let (i, other) = (idx(&s0, &ids[0]), idx(&s0, &ids[1]));
        // Held dormant in 98 and 99 at the primary (pulled by both backups), answered in 100.
        for e in [98u64, 99] {
            commit(&all, e, shard, owners[0], &[other]);
            derive(&all, e);
            let held = vec![(ids[0].clone(), PushEntry { epoch: e, dormant: true, ..PushEntry::default() })];
            for s in all { save_reach_records(s, e, owners[0], &reached_unanswered(&held, |_| false)); }
        }
        assert!(all.iter().all(|s| proven_dormant(s, &ReachCache::new(), &DormantFacts::read(s, 100), &ids[0], shard, 100)));
        commit(&all, epoch, shard, owners[0], &[i, other]);
        derive(&all, epoch);
        for s in all {
            assert!(!proven_dormant(s, &ReachCache::new(), &DormantFacts::read(s, 101), &ids[0], shard, 101), "pushed again in 101");
        }
        // The origination sends to these targets only, and a relay is never gossiped on.
        let prop = include_str!("../unified_p2p/propagation.rs");
        let orig = &prop[prop.find("pub fn gossip_light_node_attestation(").unwrap()..];
        let orig = &orig[..orig.find("pub(super) fn genesis_index(").unwrap()];
        assert!(orig.contains("crate::rpc::light_relay_targets(shard, our_idx)") && !orig.contains("gossip_to_random_peers"));
        let fin = &prop[prop.find("pub(super) fn finish_light_relay(").unwrap()..];
        let fin = &fin[..fin.find("pub(super) fn hold_relayed_attestation(").unwrap()];
        assert!(!fin.contains("gossip_to_random_peers"));
    }

    // ── F7: one verification per relayed answer ──

    #[test]
    fn concurrent_copies_of_a_relay_are_verified_and_admitted_once() {
        let claims = RelayClaims::new();
        let admitted: DashSet<String> = DashSet::new();
        let (verified, admissions) = (AtomicUsize::new(0), AtomicUsize::new(0));
        const N: usize = 16;
        let gate = std::sync::Barrier::new(N);
        let done = std::sync::Barrier::new(N);
        std::thread::scope(|sc| {
            for _ in 0..N {
                sc.spawn(|| {
                    gate.wait();
                    // The echo check first (`light_relay_seen`), then the claim, then the signature checks.
                    let claim = if admitted.contains("light_x") { None } else { claims.claim("light_x", 7, "ping_hw2:sig") };
                    done.wait();
                    if let Some(_c) = claim {
                        verified.fetch_add(1, Ordering::SeqCst);
                        if admitted.insert("light_x".to_string()) { admissions.fetch_add(1, Ordering::SeqCst); }
                    }
                });
            }
        });
        assert_eq!((verified.load(Ordering::SeqCst), admissions.load(Ordering::SeqCst)), (1, 1));
        // Released once done; a tampered copy is claimed apart, so it never keeps the real one out.
        assert!(claims.claim("light_x", 7, "ping_hw2:sig").is_some());
        let held = claims.claim("light_x", 7, "ping_hw2:sig").unwrap();
        assert!(claims.claim("light_x", 7, "ping_hw2:tampered").is_some());
        assert!(claims.claim("light_x", 7, "ping_hw2:sig").is_none());
        drop(held);
        assert!(claims.claim("light_x", 8, "ping_hw2:sig").is_some(), "another epoch");
        // The receiver checks ownership, then claims, before the pinger's signature.
        let peers = include_str!("../unified_p2p/peers.rs");
        let arm = &peers[peers.find("NetworkMessage::LightNodeAttestation {").unwrap()..];
        let owner = arm.find("if !self.node_in_my_shard_for_epoch(relay_epoch, &light_node_id) {").expect("owner check");
        let claim = arm.find("crate::rpc::RELAY_CLAIMS.claim(").expect("claim");
        let sig = arm.find("self.verify_dilithium_heartbeat_signature(&attestation_data").expect("pinger signature");
        assert!(owner < claim && claim < sig);
    }

    /// F13: a status asks every other owner, and a node is answered or active when any of them says so.
    #[test]
    fn the_owners_view_is_answered_or_active_when_any_owner_says_so() {
        let r = |onchain: bool, answered: bool, active: bool| json!({"onchain_registered": onchain, "answered_this_epoch": answered, "is_active": active});
        assert_eq!(OwnersView::of(&[]), None);
        assert_eq!(OwnersView::of(&[json!({"success": false})]), None, "no verdict");
        assert_eq!(OwnersView::of(&[r(true, false, false), r(true, true, true)]), Some(OwnersView { answered: true, active: true }));
        assert_eq!(OwnersView::of(&[r(true, false, false), r(true, false, false)]), Some(OwnersView { answered: false, active: false }));
        assert_eq!(OwnersView::of(&[r(false, true, false)]), Some(OwnersView { answered: false, active: false }),
                   "an owner that does not see the node on chain says nothing of its answer");
        let src = include_str!("light_nodes.rs");
        let f = &src[src.find("pub(super) async fn shard_owners_view(").unwrap()..];
        assert!(f.contains("crate::node::light_shard_owners(shard).into_iter()") && f.contains("futures::future::join_all(asks)"));
    }
}

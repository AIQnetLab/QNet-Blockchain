//! Block propagation: shredding, erasure coding, the relay tree and chunk repair.

use super::*;

/// The last reading of what decides the dormant rule (`rpc::DormantFacts`), `epoch << 8 | decidable shard mask`, so its
/// change is logged once. A shard outside the mask committed no row (or was not derived here) in one of the two epochs
/// before, so every node of it is pushed: the recovery sweep, per shard (F11).
static DORMANT_FACTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

/// Place newly admitted light nodes into their ping-slot buckets. Returns how many were placed —
/// a node outside the shards we cover belongs to no bucket of ours. Pure, so the invariant "a node
/// admitted between rebuilds is pingable in its slot" is testable without a live node.
pub(super) fn index_new_light_nodes(
    buckets: &mut [Vec<String>],
    ids: Vec<String>,
    window: u64,
    covered_mask: usize,
) -> usize {
    let mut placed = 0usize;
    for id in ids {
        if covered_mask & (1 << crate::node::light_shard_of(&id)) == 0 { continue; }
        let slot = SimplifiedP2P::calculate_randomized_slot(&id, window) as usize;
        if let Some(b) = buckets.get_mut(slot) { b.push(id); placed += 1; }
    }
    placed
}

/// Widest gap (in slots) one ping tick reads back over. A live chain moves a few slots per 60 s tick; a
/// wider gap means the loop fell behind (a stalled loop or a fast resync) and reads only the grace
/// slots. A node a whole epoch behind the chain reads only the grace slots too (get_light_nodes_to_ping).
const MAX_PING_CATCHUP_SLOTS: u64 = 15;

/// First window drawn from the bounded slot range. Every genesis switches at this window roll rather than
/// at its own restart: a restart mid-window would re-draw the live window, and a device whose old slot had
/// not come while its new one had passed would get no ping that epoch. Node-local, not a consensus rule;
/// the upgrade must reach every genesis before this window's first block (104 * 14,400 = 1,497,600).
const BOUNDED_SLOT_DRAW_FROM_WINDOW: u64 = 104;

/// The first window whose first push is drawn over the epoch's first UNSPACED_FIRST_PUSH_SLOTS (P-1): the window
/// after the one this genesis first pinged in, stored from a tip the network stands behind and kept in its storage
/// (`rpc::first_push_draw_from`), so no restart re-draws a live window. Until armed, and on a node that never pings, the
/// bounded draw stays.
static FIRST_PUSH_DRAW_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

/// The first window drawn over FIRST_PUSH_SLOTS with its rounds spaced (`rpc::ROUND_SPACING_SLOTS`): the window after
/// the one this genesis first pinged in on a release with them, stored from a tip the network stands behind and kept
/// (`rpc::spaced_rounds_from`). A switch at a restart mid-window would re-draw the live window, and a device whose old
/// slot had not come while its new one had passed would get no push that epoch; so the window the release lands in keeps
/// its draw to its end, as it began.
///
/// Mixed versions in the epoch of the roll. The release before this one draws every node over the bounded range (232
/// slots), pushes it in that slot and the next two, sends no retry round and stores no window, so a genesis upgraded in
/// epoch W stores W + 1 for the early draw and the spaced rounds alike. In W it draws every node into the slot the
/// release before does and pushes it in the same three slots, and also sends a retry round an hour on that the release
/// before does not: no node is pushed less. From W + 1 it draws over 138 slots and spaces its rounds, while a genesis the
/// roll reaches later keeps the bounded draw to the end of the epoch it is upgraded in; so for as long as the roll takes
/// (minutes per genesis, longer when it stops at a milestone), the owners of one shard may draw an epoch differently. A
/// shard is pushed by one owner at a time, and a hand-over inside an epoch (a cover after ten silent slots, or the
/// hand-back) between owners on different draws would leave unpushed the nodes whose due points under the new pusher's
/// draw had passed while those under the old pusher's had not come. So a genesis that starts pushing a shard inside an
/// epoch, or after a gap in its reads (`ShardReads`), reads it to the epoch's end under each other owner's draw too, as
/// that owner's ping ticks name it (`foreign_draws`, `rpc::OwnerSchedules`; the bounded draw for one never heard naming
/// one), with its own round shape: every node whose first push or retry round under the draw of whoever pushed the
/// shard before is still due gets it, however long the roll takes. Node-local, not a consensus rule; the tests
/// `the_roll_from_the_release_before_drops_no_node` and `a_cover_between_owners_on_different_draws_drops_no_node` play
/// the roll through.
static SPACED_ROUND_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

/// How many slots `window`'s first push is drawn over when the early draw starts at `first_push_from` and the spaced
/// rounds at `spaced_from`.
pub(crate) fn ping_draw_slots(window: u64, first_push_from: u64, spaced_from: u64) -> u64 {
    if window >= spaced_from {
        crate::rpc::FIRST_PUSH_SLOTS
    } else if window >= first_push_from {
        crate::rpc::UNSPACED_FIRST_PUSH_SLOTS
    } else if window >= BOUNDED_SLOT_DRAW_FROM_WINDOW {
        240 - crate::node::light_commit_window(window).div_ceil(60) - 2 - crate::rpc::LIGHT_CHALLENGE_TTL_SECS.div_ceil(60)
    } else {
        240
    }
}

/// Whether `window`'s rounds are spaced on this genesis (`SPACED_ROUND_WINDOW`).
pub(crate) fn spaced_rounds_in(window: u64) -> bool {
    window >= SPACED_ROUND_WINDOW.load(std::sync::atomic::Ordering::Relaxed)
}

/// Buckets one ping tick reads, newest first: the grace read {slot, slot-1, slot-2} (mod 240) of every
/// slot passed since `last_read` (absolute slots, window * 240 + slot), a new window from its slot 0. A
/// first tick, a rollback or a gap past MAX_PING_CATCHUP_SLOTS reads only the grace slots, with the gap.
pub(super) fn ping_buckets_to_read(last_read: Option<u64>, now: u64) -> (Vec<usize>, u64) {
    let slot = now % 240;
    let (first, gap) = match last_read {
        Some(l) if l < now && now - l <= MAX_PING_CATCHUP_SLOTS => ((l + 1).max(now - slot), 0),
        Some(l) if l < now => (now, now - l),
        _ => (now, 0),
    };
    let span = now - first;
    ((0..=span + 2).map(|g| ((slot + 240 - g) % 240) as usize).collect(), gap)
}

/// Buckets one push tick reads, first pushes first: the grace read (`ping_buckets_to_read`), then the same
/// slots RETRY_AFTER_SLOTS earlier, the retry round of the nodes drawn there (R-a, P-1). The retry read never
/// wraps into the window's end: those slots' first pushes have not come yet.
pub(super) fn push_buckets_to_read(last_read: Option<u64>, now: u64) -> (Vec<usize>, u64) {
    let (mut buckets, gap) = ping_buckets_to_read(last_read, now);
    let slot = (now % 240) as usize;
    let retry = crate::rpc::RETRY_AFTER_SLOTS as usize;
    let retry_read: Vec<usize> = (0..buckets.len()).filter_map(|g| slot.checked_sub(g + retry)).collect();
    buckets.extend(retry_read);
    (buckets, gap)
}

/// One bucket a push tick reads (a drawn slot) and the due points it is read for, earliest first
/// (`rpc::PushLedger::may_push`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushRead {
    pub(crate) bucket: usize,
    pub(crate) dues: Vec<crate::rpc::Due>,
}

/// What one push tick at absolute slot `now` reads, first pushes first, and the gap a tick without continuity skipped.
/// Before the spaced rounds (`spaced` false) the buckets of `push_buckets_to_read`, each slot a due point of its own.
/// With them each due point of the round and of the retry round (`rpc::spaced_due_offsets`) that came since the last
/// tick, with its grace: the drawn slot `slot - g - offset` for each g of the grace read (`ping_buckets_to_read`), due in
/// `slot - g`, never wrapping into the window's end. A bucket two due points reach in one catch-up tick is read once,
/// with both, and a push a catch-up made late meets the next due point when that one is nearer than
/// `rpc::MIN_PUSH_GAP_SLOTS` (`rpc::Due::spaced`): no two pushes this genesis records for a node go out closer. `done` is
/// the last slot a run of this genesis before a restart read, when this tick's reads join it (`rpc::push_read_mark`): no
/// due point up to it is read again with the spaced rounds, as its push went out or was shed once already and the
/// record that would close it went with the restart.
///
/// Scale (M-11): at ten million light nodes on five genesis a shard holds two million, about 14,500 a bucket over 138
/// slots. A tick on the regular pace reads three buckets for each of the six due points, 18 against the 6 of the rounds
/// a slot apart. Every id read gets one ledger read in RAM (about 0.1 us) under the slot index's lock alone, the light
/// registry's not held (`get_light_nodes_to_ping`); only the ids it lets through get the eligibility and registry tests
/// under those locks, and the storage reads for a silent one. The round's first push and the retry round's let through
/// what they did before. The four repeats add some 174,000 ids a tick (522,000 for three shards), some 17 ms of ledger
/// reads a tick a shard, and let through only a node offered a push here in the epoch (sent or shed, not answered here,
/// pruned every ten slots once counted elsewhere). No grace slot passes once its due point's push went out or the dormant
/// rule held the node there, and a hold offers no repeat: a node held dormant is read twice an epoch, at the round's
/// first push and the retry round's (six times with the rounds a slot apart). For the one round after a restart or a
/// takeover, whose first pushes went out from a record this genesis does not have, a repeat lets through any node of the
/// shard not counted (`rpc::PushLedger::may_push`), its shard read with one hash per id only then. A per-slot index of
/// the pushed nodes would read only the silent ones, but hold some 1.3 million ids (30 slots of three shards); the
/// buckets hold nothing new, and the retry round read from them survives a restart of this genesis.
pub(super) fn push_reads(last_read: Option<u64>, now: u64, spaced: bool, done: Option<u64>) -> (Vec<PushRead>, u64) {
    if !spaced {
        let (buckets, gap) = push_buckets_to_read(last_read, now);
        let reads = buckets.into_iter().map(|bucket| PushRead { bucket, dues: vec![crate::rpc::Due::once(now)] }).collect();
        return (reads, gap);
    }
    let (grace, gap) = ping_buckets_to_read(last_read, now);
    let slot = now % 240;
    let mut reads: Vec<PushRead> = Vec::new();
    let mut at = [usize::MAX; 240];
    for (offset, into_round) in crate::rpc::spaced_due_offsets() {
        for g in 0..grace.len() as u64 {
            let Some(bucket) = slot.checked_sub(g + offset).map(|b| b as usize) else { break; };
            if done.map_or(false, |d| now - g <= d) { break; }
            let due = crate::rpc::Due::spaced(now - g, into_round);
            match at[bucket] {
                usize::MAX => {
                    at[bucket] = reads.len();
                    reads.push(PushRead { bucket, dues: vec![due] });
                }
                i => reads[i].dues.push(due),
            }
        }
    }
    (reads, gap)
}

/// What this genesis read of each light shard it pushes in the live window, one entry a shard, so a shard that changed
/// hands inside the epoch is read as the owner before it pushed it (`foreign_draws`) and a round begun before this
/// genesis held its records still gets its repeats (`rpc::PushLedger::may_push`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShardReads {
    /// The shards pushed at this process's last tick (none before its first).
    pub(crate) mask: usize,
    /// The first absolute due slot from which every due point of the shard was read here: kept while the ticks join (no
    /// gap), and for the own shard across a restart whose first tick joins the run before (`rpc::push_read_mark`). Past
    /// its epoch's first slot, another owner may have pushed the shard before in the epoch.
    pub(crate) read_from: [u64; 5],
    /// The first absolute due slot whose push this process's ledger records for the shard: its first tick, or the tick
    /// it took the shard over at.
    pub(crate) held_from: [u64; 5],
    /// The last slot the run before this process read, when its first tick joined that read (`rpc::push_read_mark`): no
    /// due point up to it is read again in this process (`push_reads`).
    pub(crate) done: Option<u64>,
}

impl ShardReads {
    pub(crate) const fn new() -> Self {
        ShardReads { mask: 0, read_from: [0; 5], held_from: [0; 5], done: None }
    }

    /// One tick pushing the shards of `covered` (a mask; `own` this genesis's shard), its reads starting at due slot
    /// `first_due` and joining this process's last ones (`joined`). A shard pushed at the last tick too keeps what it
    /// had; one newly pushed starts at `first_due`, except the own shard on the first tick after a restart whose reads
    /// join the run before, which keeps that run's `resumed`.
    pub(crate) fn advance(&mut self, covered: usize, own: usize, first_due: u64, joined: bool, resumed: Option<u64>) {
        for sh in 0..5 {
            let bit = 1 << sh;
            if covered & bit == 0 || (joined && self.mask & bit != 0) { continue; }
            self.read_from[sh] = if sh == own { resumed.unwrap_or(first_due) } else { first_due };
            self.held_from[sh] = first_due;
        }
        self.mask = covered;
    }
}

static SHARD_READS: parking_lot::Mutex<ShardReads> = parking_lot::const_mutex(ShardReads::new());

/// The draws besides its own that genesis `me` reads `shard` under in `window`, once another owner may have pushed it
/// earlier in the window (`ShardReads::read_from`): each other owner's draw, from the schedule its ticks named
/// (`schedules`, `rpc::OwnerSchedules`; u64::MAX, the bounded draw, for one never heard naming one), that differs from
/// its own (`schedules[me]`). None when the owners agree, as they do outside the epochs of a roll.
pub(crate) fn foreign_draws(window: u64, me: usize, shard: usize, schedules: &[(u64, u64); 5]) -> Vec<u64> {
    let draw = |g: usize| ping_draw_slots(window, schedules[g].0, schedules[g].1);
    let own = draw(me);
    let mut out = Vec::new();
    for g in crate::node::light_shard_owners(shard) {
        let d = draw(g);
        if g != me && d != own && !out.contains(&d) { out.push(d); }
    }
    out
}

/// How many times the slot index was built: the positions `ForeignIndex` keeps are of one build.
static SLOT_INDEX_BUILDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The slot index is stale (the queue of admitted ids overflowed): the next tick builds it again. A flag rather than a
/// write to the index, so a writer of the registry never waits on the index.
static SLOT_INDEX_STALE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The slot index's ids again under other owners' draws (`foreign_draws`), as positions in its buckets, so it holds no
/// id of its own (eight bytes a node: some 16 MB for a shard of two million): per draw, the shards read under it and its
/// 240 buckets. Built only while a shard is read under another draw, in the epochs of a roll; empty otherwise.
pub(crate) struct ForeignIndex {
    /// The slot index build it follows (`SLOT_INDEX_BUILDS`) and the (draw, shards) it was asked for.
    key: (u64, Vec<(u64, usize)>),
    draws: Vec<(u64, usize, Vec<Vec<(u8, u32)>>)>,
    /// How many ids of each index bucket are placed.
    placed: Vec<usize>,
}

impl ForeignIndex {
    pub(crate) const fn new() -> Self {
        ForeignIndex { key: (u64::MAX, Vec::new()), draws: Vec::new(), placed: Vec::new() }
    }

    /// Follow the slot index `buckets` (build `build`, of `window`) for `wanted` (draw, shards): built again when either
    /// changes, else extended with the ids the index gained since. One hash for the shard and one for the slot per id.
    pub(crate) fn sync(&mut self, buckets: &[Vec<String>], build: u64, window: u64, wanted: &[(u64, usize)]) {
        if self.key.0 != build || self.key.1 != wanted || self.placed.len() != buckets.len() {
            self.key = (build, wanted.to_vec());
            self.draws = wanted.iter().map(|(d, m)| (*d, *m, vec![Vec::new(); 240])).collect();
            self.placed = vec![0; buckets.len()];
        }
        if self.draws.is_empty() { return; }
        for (b, ids) in buckets.iter().enumerate() {
            for (i, id) in ids.iter().enumerate().skip(self.placed[b]) {
                let bit = 1usize << crate::node::light_shard_of(id);
                for (draw, mask, out) in self.draws.iter_mut() {
                    if *mask & bit != 0 {
                        out[SimplifiedP2P::slot_in_draw(id, window, *draw) as usize].push((b as u8, i as u32));
                    }
                }
            }
            self.placed[b] = ids.len();
        }
    }

    /// The ids drawn into `bucket` under every draw it follows, out of the slot index `buckets`.
    pub(crate) fn ids<'a>(&'a self, buckets: &'a [Vec<String>], bucket: usize) -> impl Iterator<Item = &'a String> + 'a {
        self.draws.iter().flat_map(move |(_, _, out)| out.get(bucket).into_iter().flatten()
            .filter_map(move |(b, i)| buckets.get(*b as usize).and_then(|ids| ids.get(*i as usize))))
    }
}

static FOREIGN_INDEX: parking_lot::Mutex<ForeignIndex> = parking_lot::const_mutex(ForeignIndex::new());

/// Single admission point for the resident light registry: role cap with inactive-first eviction plus
/// the trimmed entry (heavy crypto lives in the VRF/ping-key CFs). Gossip and bulk sync both pass here.
/// Caller holds the write lock, so a bulk merge takes it once.
pub(super) fn admit_light_registration(
    registry: &mut std::collections::HashMap<String, LightNodeRegistrationData>,
    reg: LightNodeRegistrationData,
) -> bool {
    make_room_for(registry, 1);
    registry.insert(reg.node_id.clone(), LightNodeRegistrationData {
        quantum_pubkey: String::new(), signature: String::new(),
        ping_pubkey: String::new(), ping_delegation_cert: String::new(),
        device_token_hash: String::new(),
        ..reg
    }).is_none()
}

/// Free space for `incoming` new entries if the role cap needs it. Separate from admission because a
/// bulk merge must pay the scan ONCE, not once per entry.
pub(super) fn make_room_for(
    registry: &mut std::collections::HashMap<String, LightNodeRegistrationData>,
    incoming: usize,
) {
    let cap = light_registry_cap();
    if registry.len() + incoming > cap {
        // Inactive-first, then oldest, so live nodes are never dropped while dead entries remain.
        // Selection is a bounded heap, not a clone-and-sort of the whole map: at the genesis cap that
        // was 10M key clones and an O(N log N) sort under the write lock.
        // The batch is a slice of the cap, not a constant — the one pass is the expensive part and
        // must be amortised over many admissions at 10M as well as at 100k.
        let evict_batch = (cap / 100).clamp(1, 10_000).max(incoming);
        let mut worst: std::collections::BinaryHeap<(bool, u64, String)> = std::collections::BinaryHeap::new();
        for (k, v) in registry.iter() {
            let key = (v.is_active, v.registered_at);
            if worst.len() >= evict_batch {
                match worst.peek() {
                    Some(w) if key < (w.0, w.1) => { worst.pop(); }
                    _ => continue,
                }
            }
            worst.push((key.0, key.1, k.clone()));
        }
        let evicted = worst.len();
        for (_, _, key) in worst { registry.remove(&key); }
        if crate::node::is_info() {
            println!("[INFO][P2P] registry_evicted count={} cap={}", evicted, cap);
        }
    }
}

impl SimplifiedP2P {
    /// Admit into the registry and keep the ping index in step. Every writer of the resident registry
    /// goes through here, so a node is pingable from the slot after the one that admitted it without
    /// anything being rebuilt. Caller holds the registry write lock; this takes the pending queue
    /// after it, the same order the ping loop uses (registry, then index).
    pub(super) fn admit_light(
        &self,
        registry: &mut std::collections::HashMap<String, LightNodeRegistrationData>,
        reg: LightNodeRegistrationData,
    ) -> bool {
        let id = reg.node_id.clone();
        let is_new = admit_light_registration(registry, reg);
        if is_new { self.queue_for_ping_index(id); }
        is_new
    }

    /// Queue a newly admitted id for placement in the ping index, bounded. Only a node with ping duty
    /// drains this; on any other node it would grow with every registration and never shrink. Past the
    /// cap the queue is dropped and the index marked stale, so the next slot that DOES run rebuilds
    /// from the registry - correct either way, and the memory is bounded on every node type.
    fn queue_for_ping_index(&self, id: String) {
        const PENDING_MAX: usize = 50_000;
        // Only the ping loop drains this, and only a shard owner runs it. Anywhere else the queue has
        // no reader, so queuing would retain an id per registration for the life of the process - at
        // ten million light nodes, a gigabyte of heap that is written and never read.
        if !is_genesis_pinger() { return; }
        let mut q = self.light_ping_pending.write();
        if q.len() >= PENDING_MAX {
            q.clear();
            drop(q);
            SLOT_INDEX_STALE.store(true, std::sync::atomic::Ordering::Relaxed); // force a full pass on the next slot
            return;
        }
        q.push(id);
    }

    /// Admit a light node the chain just registered. The resident registry is otherwise fed only by
    /// this node's own RPC, by gossip and by a boot restore — so a node that missed the gossip did not
    /// learn about it until it restarted, and a bulk P2P reconciliation existed to paper over that.
    /// Derived from the applied block instead, the registry is a function of the chain continuously,
    /// and gossip is only a latency optimisation.
    pub fn admit_light_from_chain(&self, node_id: &str, wallet: &str, registered_at: u64) {
        self.admit_light_entry_from_chain(node_id, wallet, registered_at);
        // A binding the app posted before the registration applied is promoted now, and one this
        // genesis took before it is checked and sent on, off this path. After the entry exists: the
        // follow-up sets the entry's push channel.
        crate::rpc::on_light_registration_applied(node_id, registered_at);
    }

    fn admit_light_entry_from_chain(&self, node_id: &str, wallet: &str, registered_at: u64) {
        let mut registry = self.light_node_registry.write();
        // The chain wins over gossip for the fields the chain decides. A gossiped entry carries the
        // sender's own wallet and timestamp; leaving it in place would let a peer's claim outlive the
        // committed one. Local fields (push type, last_seen) are not the chain's to set, and an entry
        // whose registration is later rolled back is left behind - the boot restore reconciles it, so
        // this map is a superset of the chain, never a subset.
        if let Some(e) = registry.get_mut(node_id) {
            e.wallet_address = wallet.to_string();
            e.registered_at = registered_at;
            return;
        }
        self.admit_light(&mut registry, LightNodeRegistrationData {
            node_id: node_id.to_string(),
            wallet_address: wallet.to_string(),
            device_token_hash: String::new(),
            quantum_pubkey: String::new(),
            registered_at,
            signature: String::new(),
            push_type: PushType::Polling,
            unified_push_endpoint: None,
            last_seen: registered_at,
            consecutive_failures: 0,
            is_active: true,
            ping_pubkey: String::new(),
            ping_delegation_cert: String::new(),
        });
    }

    /// Track blocks without ping commitment for monitoring
    /// Uses thread-local static for simplicity (no struct modification needed)
    pub fn increment_missing_commitment_count(&self) -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static MISSING_COMMITMENT_COUNT: AtomicU64 = AtomicU64::new(0);
        MISSING_COMMITMENT_COUNT.fetch_add(1, Ordering::Relaxed) + 1
    }
    
    /// Gossip message to random peers (for scalable propagation)
    pub fn gossip_to_random_peers(&self, message: NetworkMessage, count: usize) {
        use rand::seq::SliceRandom;
        
        // The lock-free table is the ONLY peer set: add_peer is its single writer, so there is no
        // second map to consult. Fewer peers than `count` simply sends to all of them.
        let peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        let mut rng = rand::rngs::OsRng;
        let selected: Vec<_> = peers.choose_multiple(&mut rng, count.min(peers.len())).collect();
        
        for peer in selected {
            self.send_network_message(&peer.addr, message.clone());
        }
    }
    
    /// v4.3: Gossip to random peers EXCLUDING the sender (prevents echo loops)
    /// Used by VRF claim relay to avoid sending claim back to the node that sent it
    pub fn gossip_to_random_peers_excluding(&self, message: NetworkMessage, count: usize, exclude_peer: &str) {
        use rand::seq::SliceRandom;
        
        let peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .filter(|r| {
                // Exclude the sender by addr prefix (IP match)
                let peer_addr = r.value().addr.as_str();
                let exclude_ip = exclude_peer.split(':').next().unwrap_or(exclude_peer);
                let peer_ip = peer_addr.split(':').next().unwrap_or(peer_addr);
                peer_ip != exclude_ip
            })
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        let mut rng = rand::rngs::OsRng;
        let selected: Vec<_> = peers.choose_multiple(&mut rng, count.min(peers.len())).collect();
        
        for peer in selected {
            self.send_network_message(&peer.addr, message.clone());
        }
    }
    
    /// OPTIMIZATION v2.19.19: Gossip to K closest neighbors using Kademlia distance (v2.51: lock-free)
    pub fn gossip_to_k_neighbors(&self, message: NetworkMessage, k: usize) {
        let mut peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        // Sort by Kademlia distance (bucket_index) - closest first
        // This ensures messages go to DHT neighbors for efficient propagation
        peers.sort_by_key(|p| p.bucket_index);
        
        // Take K closest neighbors
        let k_neighbors: Vec<_> = peers.into_iter().take(k).collect();

        for peer in k_neighbors {
            self.send_network_message(&peer.addr, message.clone());
        }
    }

    /// Relay a verified genesis signed-head to NON-genesis neighbors only, excluding the origin and
    /// the immediate sender. The genesis mesh already exchanges heads via direct emit, so relaying back
    /// to it is pure fan-in; restricting to non-genesis k-closest pushes the tip OUTWARD to deep
    /// followers with zero fan-in onto the 5 genesis at thousands-of-joiner scale.
    pub(super) fn relay_signed_head(&self, message: NetworkMessage, origin_id: &str, sender_addr: &str, k: usize) {
        let mut peers: Vec<_> = self.connected_peers_lockfree.iter()
            .map(|r| r.value().clone())
            .filter(|p| p.id != origin_id
                && p.addr != sender_addr
                && !crate::genesis_constants::is_legacy_genesis_node(&p.id))
            .collect();
        if peers.is_empty() { return; }
        peers.sort_by_key(|p| p.bucket_index);
        for peer in peers.into_iter().take(k) {
            self.send_network_message(&peer.addr, message.clone());
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v5.1: KADEMLIA DHT — FIND_NODE iterative lookup + periodic bucket refresh
    // ═══════════════════════════════════════════════════════════════════════════

    /// Sync connected peers into the Kademlia routing table.
    /// Called periodically and after peer add/remove.
    pub fn sync_peers_to_kademlia(&self) {
        let now = self.current_timestamp();
        for entry in self.connected_peers_lockfree.iter() {
            let p = entry.value();
            self.kademlia_table.upsert(&p.id, &p.addr, p.reputation, now);
        }
    }

    /// Handle incoming FindNode request: return K closest peers from our routing table.
    pub fn handle_find_node(&self, from_peer: &str, requester_id: &str, target_hash: &[u8], request_id: u64) {
        if target_hash.len() != 32 { return; }
        let mut th = [0u8; 32];
        th.copy_from_slice(target_hash);

        let closest = self.kademlia_table.find_closest(&th, KADEMLIA_K);
        let pairs: Vec<(String, String)> = closest.into_iter()
            .filter(|p| p.node_id != requester_id)
            .map(|p| (p.node_id, p.addr))
            .collect();

        let response = NetworkMessage::FindNodeResponse {
            responder_id: self.node_id.clone(),
            closest_peers: pairs,
            request_id,
        };
        self.send_network_message(from_peer, response);
    }

    /// Handle incoming FindNodeResponse: merge discovered peers into routing table.
    pub fn handle_find_node_response(&self, closest_peers: &[(String, String)]) {
        let now = self.current_timestamp();
        for (node_id, addr) in closest_peers {
            if node_id == &self.node_id { continue; }
            self.kademlia_table.upsert(node_id, addr, 70.0, now);
        }
    }

    /// Iterative Kademlia lookup: find K closest peers to a target node ID.
    /// Sends FIND_NODE to ALPHA closest known peers, collects responses,
    /// repeats until no closer peers are discovered or max hops reached.
    pub fn kademlia_lookup(&self, target_node_id: &str) {
        let target_hash = KademliaRoutingTable::hash_node_id(target_node_id);
        let initial = self.kademlia_table.find_closest(&target_hash, KADEMLIA_ALPHA);

        if initial.is_empty() { return; }

        let request_id = self.current_timestamp();
        for peer in initial.iter().take(KADEMLIA_ALPHA) {
            let msg = NetworkMessage::FindNode {
                requester_id: self.node_id.clone(),
                target_hash: target_hash.to_vec(),
                request_id,
            };
            self.send_network_message(&peer.addr, msg);
        }

        if crate::node::is_debug() {
            println!("[DBG][DHT] kademlia_lookup target={} sent_to={} table_size={}",
                     qnet_state::char_prefix(&target_node_id, 16),
                     initial.len(), self.kademlia_table.total_peers());
        }
    }

    /// Start background task that periodically refreshes stale k-buckets
    /// by performing lookups for random IDs in each stale bucket range.
    pub fn start_kademlia_refresh_task(&self) {
        let table = self.kademlia_table.clone();
        let connected = self.connected_peers_lockfree.clone();
        let node_id = self.node_id.clone();
        let kademlia_table_for_sync = self.kademlia_table.clone();
        let peer_id_to_addr = self.peer_id_to_addr.clone();

        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        handle.spawn(async move {
            let mut interval = tokio::time::interval(
                std::time::Duration::from_secs(KADEMLIA_REFRESH_INTERVAL_SECS)
            );

            loop {
                interval.tick().await;

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_secs();

                // Sync connected peers into routing table
                for entry in connected.iter() {
                    let p = entry.value();
                    kademlia_table_for_sync.upsert(&p.id, &p.addr, p.reputation, now);
                }

                let stale = table.stale_buckets(now);
                if stale.is_empty() { continue; }

                for bucket_idx in stale.iter().take(3) {
                    // Generate random target in this bucket's range
                    let mut target = [0u8; 32];
                    let byte_idx = bucket_idx / 8;
                    let bit_idx = 7 - (bucket_idx % 8);
                    if byte_idx < 32 {
                        target[byte_idx] = 1u8 << bit_idx;
                    }
                    // XOR with local hash to get target in this bucket
                    let local_hash = KademliaRoutingTable::hash_node_id(&node_id);
                    for i in 0..32 { target[i] ^= local_hash[i]; }

                    let closest = table.find_closest(&target, KADEMLIA_ALPHA);
                    for peer in closest {
                        if let Some(addr_entry) = peer_id_to_addr.get(&peer.node_id) {
                            // Would send FindNode here but we don't have &self in async
                            // The sync_peers_to_kademlia + periodic peer exchange covers this
                            let _ = addr_entry.value();
                        }
                    }

                    table.mark_refreshed(*bucket_idx, now);
                }

                if crate::node::is_debug() {
                    println!("[DBG][DHT] refresh stale_buckets={} total_peers={}",
                             stale.len(), table.total_peers());
                }
            }
        });

        if crate::node::is_info() {
            println!("[INFO][DHT] Kademlia routing table refresh task started (interval={}s)",
                     KADEMLIA_REFRESH_INTERVAL_SECS);
        }
    }

    /// Get the Kademlia routing table (for external access/monitoring)
    pub fn get_kademlia_table(&self) -> &Arc<KademliaRoutingTable> {
        &self.kademlia_table
    }

    // ═══════════════════════════════════════════════════════════════════════════
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v5.1: KADEMLIA DHT — iterative lookup, FIND_NODE handler, periodic refresh
    // ═══════════════════════════════════════════════════════════════════════════

    /// Sync connected peers into the Kademlia routing table.
    /// Called after add_peer_lockfree / periodically to keep DHT in sync.
    pub fn kademlia_sync_from_peers(&self) {
        let now = self.current_timestamp();
        for entry in self.connected_peers_lockfree.iter() {
            let p = entry.value();
            self.kademlia_table.upsert(&p.id, &p.addr, p.reputation, now);
        }
    }

    /// Verify signature for heartbeat (ASYNC version)
    /// PRODUCTION: Supports pure ML-DSA-65 (ML-DSA-65) formats (binary, JSON, legacy)
    pub async fn verify_dilithium_heartbeat_signature_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::quantum_crypto::DilithiumSignature;
                // Check for empty/invalid signatures
        if signature.is_empty() || signature.len() < 100 {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: too short ({} chars, need 100+)", signature.len());
            }
            return false;
        }
        
        // Binary compact P2P signature (bincode+zstd)
        if signature.starts_with("pq_p2p_bin:") {
            return self.verify_pq_p2p_binary_async(message, signature, node_id).await;
        }

        // LEGACY: JSON P2P signature (parse-only; no current producer)
        if signature.starts_with("pq_p2p:") {
            return self.verify_pq_p2p_signature_async(message, signature, node_id).await;
        }

        // LEGACY: full binary signature (parse-only; no current producer)
        if signature.starts_with("pq_bin:") {
            return self.verify_pq_bin_signature_sync(message, signature, node_id);
        }

        // v2.49.2: COMPACT PQ binary signature
        if signature.starts_with("compact_bin:") {
            return self.verify_compact_bin_signature_sync(message, signature, node_id);
        }
        
        // LEGACY FORMAT: Pure Dilithium signature (for backward compatibility)
        if !signature.starts_with("dilithium_sig_") {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: unknown prefix (got: {}...)",
                         qnet_state::char_prefix(&signature, 20));
            }
            return false;
        }
        
        // PRODUCTION v2.50: Lock-free heartbeat verification
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][HEARTBEAT] verify_skip reason=crypto_not_initialized");
                }
                return false;
            }
        };
        
        // Create DilithiumSignature struct
        let dilithium_sig = DilithiumSignature {
            signature: signature.to_string(),
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            strength: "quantum-resistant".to_string(),
        };
        
        // Verify using real Dilithium
        match crypto.verify_dilithium_signature(message, &dilithium_sig, node_id).await {
            Ok(valid) => {
                if valid {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Dilithium signature verified for {}", node_id);
                    }
                } else {
                    // v25.3: governed — collapses spoofer flood (shares the
                    // per-claimed-id window with the consensus-layer sites).
                    qnet_consensus::consensus_crypto::log_sig_reject(
                        node_id,
                        &format!("[ERR][P2P] Invalid Dilithium signature for {}", node_id),
                    );
                }
                valid
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error for {}: {}", node_id, e);
                }
                false  // NO FALLBACK - reject invalid signatures
            }
        }
    }

    /// OPTIMIZED v2.24: Verify PQ P2P BINARY signature (bincode+zstd)
    pub(super) async fn verify_pq_p2p_binary_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
                use sha3::{Sha3_256, Digest};
        use base64::engine::general_purpose;
        use base64::Engine;
        
        // Parse pq_p2p_bin signature (strip_prefix — no length coupling)
        let base64_data = match signature.strip_prefix("pq_p2p_bin:") {
            Some(rest) => rest,
            None => return false,
        };
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to decode base64: {}", e);
                }
                return false;
            }
        };
        
        let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to parse binary signature: {}", e);
                }
                return false;
            }
        };
        
        // v2.24: Direct node_id comparison
        if compact_sig.node_id != node_id {
            if crate::node::is_info() {
                println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
        let mut hasher = Sha3_256::new();
        hasher.update(message.as_bytes());
        let message_hash = hasher.finalize();

        // Verify Dilithium signature
        if compact_sig.dilithium_key_signature.is_empty() {
            if crate::node::is_info() {
                println!("[ERR][P2P] REJECTED: No Dilithium key signature!");
            }
            return false;
        }

        // PRODUCTION v2.50: Lock-free quantum crypto
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] pq_p2p_bin_verify_skip reason=crypto_not_initialized");
                }
                return false;
            }
        };

        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Convert RAW bytes to signature string
        use crate::crypto::pq_crypto::encode_dilithium_signature;
        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
        
        let dilithium_key_sig = DilithiumSignature {
            signature: signature_string,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: compact_sig.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
            Ok(true) => {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Binary signature verified (v2.24)");
                }
                true
            }
            Ok(false) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium signature INVALID!");
                }
                false
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error: {}", e);
                }
                false
            }
        }
    }
    
    /// LEGACY: Verify PQ P2P JSON signature (pure ML-DSA-65)
    pub(super) async fn verify_pq_p2p_signature_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
                use sha3::{Sha3_256, Digest};
        
        // Parse pq_p2p signature (strip_prefix — no length coupling)
        let json_str = match signature.strip_prefix("pq_p2p:") {
            Some(rest) => rest,
            None => return false,
        };
        let compact_sig: CompactPqSignature = match serde_json::from_str(json_str) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to parse PQ signature: {}", e);
                }
                return false;
            }
        };

        // v2.24: Direct node_id comparison
        if compact_sig.node_id != node_id {
            if crate::node::is_info() {
                println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
        let mut hasher = Sha3_256::new();
        hasher.update(message.as_bytes());
        let message_hash = hasher.finalize();

        // OPTIMIZED v2.23: RAW bytes, single Dilithium signature (includes message_hash)
        if compact_sig.dilithium_key_signature.is_empty() {
            if crate::node::is_info() {
                println!("[ERR][P2P] REJECTED: No Dilithium key signature!");
            }
            return false;
        }

        // PRODUCTION v2.50: Lock-free quantum crypto
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][CRYPTO] verify_skip reason=not_initialized");
                }
                return false;
            }
        };

        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // OPTIMIZED v2.23: Convert RAW bytes to signature string
        use crate::crypto::pq_crypto::encode_dilithium_signature;
        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
        
        let dilithium_key_sig = DilithiumSignature {
            signature: signature_string,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: compact_sig.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
            Ok(true) => {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Signature verified (Dilithium3)");
                }
                true
            }
            Ok(false) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium signature INVALID!");
                }
                false
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error: {}", e);
                }
                false
            }
        }
    }
    
    /// Verify a LIGHT node's reply to its ping challenge. SINGLE implementation — the HTTP ingress and
    /// the gossip relay must accept exactly the same set, or a relay admits what the ingress rejects.
    /// Runs the checks of light-node-messages section 5.8 in its order, the per-epoch dedupe being the
    /// callers' (it runs before this): structure, the anchor, the device record and the device signature
    /// with its counter (`ping_hw2:` only), then σ under the node's ping key.
    ///
    /// - `ping_dilithium:` (no device signature) is fail-closed on the chain: the delegation cert is
    ///   verified under the key the chain vouches for, so an identity with none is refused. It counts
    ///   until `LIGHT_DEVICE_ENFORCE_EPOCH`, so installed apps keep working.
    /// - `ping_hw2:` counts only when the device record here counts and its key signed the anchor.
    /// - `compact_bin:` is refused for light nodes: for an identity absent from the registry it fell back
    ///   to trust-on-first-verify against the key the message itself carries.
    ///
    /// The anchor `selfattest:{h}:{hash}` must be a canonical block of this node's current epoch; on relay
    /// the record's unsigned `block_height` must equal `h` (a legacy reply's may be any later height of
    /// that epoch, `ping::relay_height_fits`), and a server stamp is never credited (only its issuer can
    /// check it, which the ingress did before calling this).
    pub fn verify_light_ping_signature(&self, node_id: &str, challenge: &str, signature: &str,
                                       route: crate::light_device::ping::Route) -> Result<(), crate::light_device::ping::ReplyRefusal> {
        use crate::light_device::ping::{self, ReplyRefusal};
        // Only a non-light identity still takes the heartbeat form (no light reply is one).
        if signature.starts_with("compact_bin:") && !node_id.starts_with("light_") && !node_id.is_empty() && !challenge.is_empty() {
            return self.verify_dilithium_heartbeat_signature(challenge, signature, node_id).then_some(()).ok_or(ReplyRefusal::Sigma);
        }
        let storage = self.storage.as_deref().or_else(|| crate::node::try_get_storage().map(|s| s.as_ref()))
            .ok_or(ReplyRefusal::Sigma)?;
        let tip = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        ping::verify_reply(&ping::ReplyCtx::production(storage, tip), node_id, challenge, signature, route)
    }

    /// Verify signature for heartbeat (SYNC version)
    /// SAFE: Uses std::thread::spawn to isolate runtime, avoiding nested runtime panic
    /// Supports pure ML-DSA-65 (ML-DSA-65) formats (binary, JSON, legacy)

    pub fn verify_dilithium_heartbeat_signature(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::quantum_crypto::DilithiumSignature;

        // Check for empty/invalid signatures
        if signature.is_empty() || signature.len() < 100 {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: too short ({} chars, need 100+)", signature.len());
            }
            return false;
        }
        
        // Binary compact P2P signature (bincode+zstd)
        if signature.starts_with("pq_p2p_bin:") {
            return self.verify_pq_p2p_binary_sync(message, signature, node_id);
        }

        // LEGACY: JSON P2P signature (parse-only; no current producer)
        if signature.starts_with("pq_p2p:") {
            return self.verify_pq_p2p_signature_sync(message, signature, node_id);
        }

        // LEGACY: full binary signature (parse-only; no current producer)
        // Format: "pq_bin:<base64_bincode_zstd>" with embedded certificate
        if signature.starts_with("pq_bin:") {
            return self.verify_pq_bin_signature_sync(message, signature, node_id);
        }

        // v2.49.2: COMPACT PQ binary signature
        // Format: "compact_bin:<base64_bincode_zstd>" requires pre-shared certificate
        if signature.starts_with("compact_bin:") {
            return self.verify_compact_bin_signature_sync(message, signature, node_id);
        }
        
        // LEGACY FORMAT: Pure Dilithium signature
        if !signature.starts_with("dilithium_sig_") {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: unknown prefix (got: {}...)",
                         qnet_state::char_prefix(&signature, 20));
            }
            return false;
        }
        
        // CRITICAL FIX: Use std::thread::spawn to isolate runtime
        // This prevents "Cannot start a runtime from within a runtime" panic
        // when called from async context (e.g., warp RPC handlers)
        let message = message.to_string();
        let signature = signature.to_string();
        let node_id = node_id.to_string();
        
        // Reused process-wide runtime: a QC verifies up to committee-size signatures; the old path
        // built + tore down a tokio runtime PER signature (67–1000× per QC). One shared runtime
        // (init once) drops that to the Dilithium open alone; the thread still isolates block_on
        // from an enclosing async caller (RPC). Init failure ⇒ thread panic ⇒ join Err ⇒ reject.
        use std::sync::OnceLock;
        static SIG_VERIFY_RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        let handle = std::thread::spawn(move || {
            let rt = SIG_VERIFY_RT.get_or_init(|| {
                tokio::runtime::Runtime::new().expect("sig_verify runtime init")
            });
            {
                    rt.block_on(async move {
                        // PRODUCTION v2.50: Lock-free quantum crypto in isolated thread
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c,
                            None => {
                                if crate::node::is_warn() {
                                    println!("[WARN][HEARTBEAT] verify_skip reason=crypto_not_initialized");
                                }
                                return false;
                            }
                        };
                        
                        let crypto = match Some(crypto.as_ref()) {
            Some(c) => c,
            None => return false, // Crypto not initialized
        };
                        
                        let dilithium_sig = DilithiumSignature {
                            signature: signature.clone(),
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&message, &dilithium_sig, &node_id).await {
                            Ok(valid) => {
                                if valid {
                                    if crate::node::is_info() {
                                        println!("[INFO][P2P] Dilithium signature verified for {}", node_id);
                                    }
                                } else {
                                    // v25.3: governed — collapses spoofer flood
                                    // (shares the per-claimed-id window with the
                                    // consensus-layer reject sites).
                                    qnet_consensus::consensus_crypto::log_sig_reject(
                                        &node_id,
                                        &format!("[ERR][P2P] Invalid Dilithium signature for {}", node_id),
                                    );
                                }
                                valid
                            }
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Dilithium verification error for {}: {}", node_id, e);
                                }
                                false  // NO FALLBACK - reject invalid signatures
                            }
                        }
                    })
            }
        });
        
        // Wait for thread to complete (with timeout for safety)
        match handle.join() {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Verification thread panicked");
                }
                false
            }
        }
    }
    
    /// v2.48: Verify consensus signature (commit/reveal) using Dilithium
    /// Wrapper around verify_dilithium_heartbeat_signature for consistent API
    pub fn verify_consensus_signature(&self, node_id: &str, message: &str, signature: &str) -> bool {
        // Use the same verification logic as heartbeat (supports all formats)
        self.verify_dilithium_heartbeat_signature(message, signature, node_id)
    }

    /// IDENTITY-IP ANCHORING — preserved for direct-only message types.
    ///
    /// **v17.1 status: NOT called from any current handler.** The original
    /// design used this gate on every genesis-bearing inbound message, but
    /// every such message in v17 is gossip-relayed: `from_peer` is the
    /// IP of the relay that forwarded the packet, NOT of the originator
    /// who signed it. Anchoring the relay's IP to the originator's
    /// genesis slot rejected legitimate gossip and broke 2f+1 quorum on
    /// testnet (visible as `genesis_ip_mismatch ... REJECTED` warns and a
    /// stuck macroblock #2). Identity binding for genesis nodes is now
    /// enforced exclusively at the cryptographic layer:
    ///
    ///   * `genesis_anchors.json` pre-pins the canonical ML-DSA-65 PK for
    ///     every `genesis_node_N` at startup
    ///     (see `install_genesis_anchors_at_startup`).
    ///   * `register_consensus_pk_from_chain` is strict — any later
    ///     attempt to register a different PK for the same genesis slot
    ///     is hard-rejected (`genesis_pk_first_seen_rejected`).
    ///   * `verify_consensus_signature` (Fix #2 in quantum_crypto.rs)
    ///     no longer falls back to the legacy bootstrap path, so a
    ///     squatter cannot ride past the signature check.
    ///
    /// The helper is retained for any future message type that is
    /// guaranteed point-to-point (no relays) — for those, IP anchoring
    /// is a free additional defence-in-depth layer.
    ///
    /// Returns `true` when the gate ALLOWS (non-genesis identity OR
    /// matching IP), `false` (with WARN log) when it REJECTS.
    #[allow(dead_code)]
    pub(super) fn check_genesis_ip_gate(&self, node_id: &str, from_peer: &str, msg_tag: &str) -> bool {
        if !crate::genesis_constants::is_legacy_genesis_node(node_id) {
            // Not a genesis identity — gate doesn't apply.
            return true;
        }
        let sender_ip = from_peer.split(':').next().unwrap_or("");
        match crate::genesis_constants::genesis_ip_for_node_id(node_id) {
            Some(expected) if expected == sender_ip => true,
            Some(expected) => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][{}] genesis_ip_mismatch node={} sender_ip={} expected_ip={} REJECTED",
                        msg_tag, node_id, sender_ip, expected
                    );
                }
                false
            }
            None => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][{}] genesis_unknown_slot node={} REJECTED",
                        msg_tag, node_id
                    );
                }
                false
            }
        }
    }
    
    /// OPTIMIZED v2.24: Verify PQ P2P BINARY signature (SYNC version)
    pub(super) fn verify_pq_p2p_binary_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        let message = message.to_string();
        let signature = signature.to_string();
        let node_id = node_id.to_string();
        
        // Use std::thread::spawn to isolate runtime
        let handle = std::thread::spawn(move || {
            use crate::pq_crypto::CompactPqSignature;
            use crate::quantum_crypto::DilithiumSignature;
            use sha3::{Sha3_256, Digest};
            use base64::engine::general_purpose;
            use base64::Engine;
            
            // Parse binary signature (strip_prefix — no length coupling)
            let base64_data = match signature.strip_prefix("pq_p2p_bin:") {
                Some(rest) => rest,
                None => return false,
            };
            let binary_data = match general_purpose::STANDARD.decode(base64_data) {
                Ok(data) => data,
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Failed to decode base64 (sync): {}", e);
                    }
                    return false;
                }
            };
            
            let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
                Ok(sig) => sig,
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Failed to parse binary signature (sync): {}", e);
                    }
                    return false;
                }
            };
            
            // v2.24: Direct node_id comparison
            if compact_sig.node_id != node_id {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
                }
                return false;
            }
            
            // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
            let mut hasher = Sha3_256::new();
            hasher.update(message.as_bytes());
            let message_hash = hasher.finalize();

            // Verify Dilithium via runtime
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    rt.block_on(async {
                        // PRODUCTION v2.50: Lock-free quantum crypto
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
                            Ok(true) => {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] Binary signature verified (sync v2.24)");
                                }
                                true
                            }
                            _ => false
                        }
                    })
                }
                Err(_) => false
            }
        });
        
        handle.join().unwrap_or(false)
    }
    
    /// v2.49.2: Verify FULL PQ binary signature (with embedded certificate)
    /// Format: "pq_bin:<base64_bincode_zstd>" - legacy full-signature parse (no current producer)
    pub(super) fn verify_pq_bin_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::{PqSignature, PqCrypto};
        use base64::{Engine as _, engine::general_purpose};

        // Parse binary signature: "pq_bin:<base64_bincode_zstd>" (strip_prefix — no length coupling)
        let base64_data = match signature.strip_prefix("pq_bin:") {
            Some(rest) => rest,
            None => return false,
        };
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin base64 decode failed: {}", e);
                }
                return false;
            }
        };

        let pq_sig: PqSignature = match PqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin signature parse failed: {}", e);
                }
                return false;
            }
        };

        // Verify node_id matches certificate
        if pq_sig.certificate.node_id != node_id {
            if crate::node::is_warn() {
                println!("[WARN][CONS] pq_bin node_id mismatch: {} vs {}",
                         pq_sig.certificate.node_id, node_id);
            }
            return false;
        }
        
        // CRITICAL v2.49.3: commit_hash is HEX string, must decode to bytes for verification
        // Signature was created on decoded bytes, not on HEX string!
        let message_bytes: Vec<u8> = match hex::decode(message) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Fallback: if not valid hex, use as-is (for non-commit messages)
                message.as_bytes().to_vec()
            }
        };
        
        // v2.49.3: Use thread with TIMEOUT to prevent deadlock
        // Previous version caused deadlock when all tokio workers blocked on join()
        let (tx, rx) = std::sync::mpsc::channel();
        let node_id_clone = pq_sig.certificate.node_id.clone();
        let serial_clone = pq_sig.certificate.serial_number.clone();
        
        std::thread::spawn(move || {
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build() 
            {
                Ok(rt) => {
                    rt.block_on(async move {
                        let verifier = PqCrypto::new(node_id_clone.clone());
                        match verifier.verify_signature(&message_bytes, &pq_sig).await {
                            Ok(true) => {
                                if crate::node::is_debug() {
                                    println!("[DBG][CONS] pq_bin_verified node={} cert={}",
                                             node_id_clone,
                                             qnet_state::char_prefix(&serial_clone, 8));
                                }
                                true
                            }
                            Ok(false) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] pq_bin_invalid node={}", node_id_clone);
                                }
                                false
                            }
                            Err(e) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] pq_bin_error node={} err={}", node_id_clone, e);
                                }
                                false
                            }
                        }
                    })
                }
                Err(_) => false
            };
            let _ = tx.send(result);
        });
        
        // v2.49.3: Wait with 10 second timeout to prevent deadlock
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin verification timeout for node={}", node_id);
                }
                false
            }
        }
    }
    
    /// v2.49.2: Verify COMPACT PQ binary signature (requires pre-shared certificate)
    /// Format: "compact_bin:<base64_bincode_zstd>" - used for microblock signatures
    pub(super) fn verify_compact_bin_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
        use sha3::{Sha3_256, Digest};
        use base64::{Engine as _, engine::general_purpose};
        
        // Parse binary signature: "compact_bin:<base64_bincode_zstd>"
        let base64_data = &signature[12..]; // Skip "compact_bin:" prefix
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin base64 decode failed: {}", e);
                }
                return false;
            }
        };
        
        let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin signature parse failed: {}", e);
                }
                return false;
            }
        };
        
        // Verify node_id matches
        if compact_sig.node_id != node_id {
            if crate::node::is_warn() {
                println!("[WARN][CONS] compact_bin node_id mismatch: {} vs {}", 
                         compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // CRITICAL v2.49.2: message is HEX string, must decode to bytes for verification
        // Signature was created on decoded bytes, not on HEX string!
        let message_bytes: Vec<u8> = match hex::decode(message) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Fallback: if not valid hex, use as-is (for non-commit messages)
                message.as_bytes().to_vec()
            }
        };
        
        // Verify Dilithium signature on message hash (pure ML-DSA-65)
        let mut hasher = Sha3_256::new();
        hasher.update(&message_bytes);
        let message_hash = hasher.finalize();

        // v2.49.3: Verify Dilithium signature with TIMEOUT to prevent deadlock
        let node_id_clone = node_id.to_string();
        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => {
                    rt.block_on(async move {
                        // PRODUCTION v2.50: Lock-free quantum crypto
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &node_id_clone).await {
                            Ok(true) => {
                                if crate::node::is_debug() {
                                    println!("[DBG][CONS] compact_bin_verified node={}", node_id_clone);
                                }
                                true
                            }
                            Ok(false) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] compact_bin_invalid node={}", node_id_clone);
                                }
                                false
                            }
                            Err(e) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] compact_bin_error node={} err={:?}", node_id_clone, e);
                                }
                                false
                            }
                        }
                    })
                }
                Err(_) => false
            };
            let _ = tx.send(result);
        });
        
        // v2.49.3: Wait with 10 second timeout to prevent deadlock
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin verification timeout for node={}", node_id);
                }
                false
            }
        }
    }
    
    /// LEGACY: Verify PQ P2P JSON signature (SYNC version) - pure ML-DSA-65
    pub(super) fn verify_pq_p2p_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        let message = message.to_string();
        let signature = signature.to_string();
        let _node_id = node_id.to_string();
        
        // Use std::thread::spawn to isolate runtime
        let handle = std::thread::spawn(move || {
            use crate::pq_crypto::CompactPqSignature;
            use crate::quantum_crypto::DilithiumSignature;
            use sha3::{Sha3_256, Digest};
            
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    rt.block_on(async move {
                        // Parse pq_p2p signature (strip_prefix — no length coupling)
                        let json_str = match signature.strip_prefix("pq_p2p:") {
                            Some(rest) => rest,
                            None => return false,
                        };
                        let compact_sig: CompactPqSignature = match serde_json::from_str(json_str) {
                            Ok(sig) => sig,
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Failed to parse PQ signature: {}", e);
                                }
                                return false;
                            }
                        };

                        // Pure ML-DSA-65 (P8): Dilithium is the sole authenticator
                        if compact_sig.dilithium_key_signature.is_empty() {
                            if crate::node::is_info() {
                                println!("[ERR][P2P] Missing Dilithium key signature!");
                            }
                            return false;
                        }

                        // Create message hash
                        let mut hasher = Sha3_256::new();
                        hasher.update(message.as_bytes());
                        let message_hash = hasher.finalize();

                        // PRODUCTION v2.50: Lock-free quantum crypto for Dilithium verification
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        // OPTIMIZED v2.23: Convert RAW bytes to signature string
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        // OPTIMIZED v2.23: Single Dilithium signature verification
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
                            Ok(true) => {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] PQ signature verified (Dilithium3)");
                                }
                                true
                            }
                            _ => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Dilithium signature INVALID!");
                                }
                                false
                            }
                        }
                    })
                }
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Cannot create runtime: {}", e);
                    }
                    false
                }
            }
        });
        
        match handle.join() {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] PQ verification thread panicked");
                }
                false
            }
        }
    }
    
    /// Update node reputation by delta (general purpose)
    /// DEPRECATED v2.21.5: Reputation now managed via blockchain (DeterministicReputationState)
    /// Use slashing events for penalties, process_block/macroblock for rewards
    #[deprecated(note = "Use DeterministicReputationState - reputation changes via blockchain only")]
    pub fn update_reputation_by_delta(&self, _node_id: &str, _delta: f64) {
        // v2.21.5: No-op - reputation managed via blockchain
        // Rewards: process_block (+2% rotation), process_macroblock (+1% consensus)
        // Penalties: slashing events in macroblock
    }
    
    /// PASSIVE RECOVERY: +1% for nodes in recovery zone (10-69%)
    /// - Only applies to Super nodes with reputation 10 <= rep < 70
    /// - Caps at 70 (consensus threshold) - nodes must earn higher through consensus participation
    /// - Light nodes: EXCLUDED (fixed at 70)
    /// - Banned nodes (<10): EXCLUDED (no passive recovery)
    /// - JAILED nodes: EXCLUDED (must wait for jail to expire first!)
    /// SCALABILITY: O(1) per node, called once per 4 hours
    /// DEPRECATED: PassiveRecovery removed - not synchronized across network
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WHY REMOVED:
    /// 1. Not deterministic (each node on own timer)
    /// 2. Not synchronized (no P2P message)
    /// 3. Abuse potential (get +1% for doing nothing)
    ///
    /// NEW ARCHITECTURE: Use DeterministicReputationState from blockchain data
    /// Recovery happens when node successfully produces blocks again
    /// ═══════════════════════════════════════════════════════════════════════════
    #[deprecated(note = "Use DeterministicReputationState - PassiveRecovery not synchronized")]
    #[allow(dead_code)]
    pub fn apply_passive_recovery(&self, _node_id: &str) -> bool {
        // DISABLED: Always returns false
        // Reputation recovery now happens through block production
        false
    }
    
    /// Get peer address by node ID for heartbeat
    pub(super) fn get_peer_address_for_heartbeat(&self, node_id: &str) -> Option<String> {
        self.peer_id_to_addr.get(node_id).map(|r| r.value().clone())
    }
    
    /// Sign P2P message with PQ cryptography (ASYNC version) - pure ML-DSA-65
    /// PRODUCTION: Use this in async contexts (warp handlers, tokio tasks)
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per message
    /// Returns compact PQ signature JSON string
    /// NO FALLBACK - unsigned messages are rejected by the network
    pub async fn sign_dilithium_async(&self, message: &str, node_id: &str) -> Option<String> {
        use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
        use std::sync::Arc;

        // Get or create PQ crypto instance (thread-safe global cache)
        let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
            Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
        }).await;

        let mut instances_guard = instances.lock().await;

        // v2.24: Use node_id directly
        let normalized_node_id = node_id.to_string();

        // Create instance if not exists
        if !instances_guard.contains_key(&normalized_node_id) {
            let mut pq = PqCrypto::new(normalized_node_id.clone());
            if let Err(e) = pq.initialize().await {
                if crate::node::is_info() {
                    println!("[ERR][CRYPTO] CRITICAL: PQ crypto init failed: {} - SKIPPING OPERATION", e);
                }
                return None;
            }
            instances_guard.insert(normalized_node_id.clone(), pq);
        }

        let pq = match instances_guard.get_mut(&normalized_node_id) {
            Some(h) => h,
            None => return None, // Should never happen but prevents panic
        };

        // Check certificate rotation
        if pq.needs_rotation() {
            if let Err(e) = pq.rotate_certificate().await {
                if crate::node::is_info() {
                    println!("[WARN][CRYPTO] Certificate rotation failed: {}", e);
                }
            }
        }

        // CRITICAL: Sign RAW message with pure ML-DSA-65 (ML-DSA-65)
        // Using sign_raw_message_compact which hashes the message before signing
        // This ensures consistency with verification which also hashes
        // OPTIMIZED v2.24: bincode+zstd instead of JSON
        match pq.sign_raw_message_compact(message.as_bytes()).await {
            Ok(compact_sig) => {
                // Serialize to bincode+zstd+base64
                match compact_sig.to_binary_compressed() {
                    Ok(binary_data) => {
                        let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                        let sig_with_prefix = format!("pq_p2p_bin:{}", base64_data);
                        if crate::node::is_info() {
                            println!("[INFO][CRYPTO] PQ P2P signature created (bincode v2.24)");
                        }
                        if crate::node::is_info() {
                            println!("[INFO][CRYPTO] Size: {} bytes (optimized)", binary_data.len());
                        }
                        Some(sig_with_prefix)
                    }
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][CRYPTO] Failed to serialize PQ signature: {}", e);
                        }
                        None
                    }
                }
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][CRYPTO] CRITICAL: PQ signing failed: {} - SKIPPING OPERATION", e);
                }
                None
            }
        }
    }
    
    /// Sign heartbeat message with PQ cryptography (SYNC version for std::thread::spawn ONLY)
    /// WARNING: Only use in pure sync contexts where NO tokio runtime exists!
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per heartbeat
    /// PRODUCTION: Returns None if signing fails - heartbeat will be skipped
    /// NO FALLBACK - unsigned heartbeats are rejected by the network
    pub(super) fn sign_heartbeat_dilithium(&self, message: &str, node_id: &str) -> Option<String> {
        use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
        use std::sync::Arc;
        
        // Create NEW runtime - safe because we're in std::thread::spawn (no existing runtime)
        match tokio::runtime::Runtime::new() {
            Ok(rt) => {
                let node_id_owned = node_id.to_string();
                let message_owned = message.to_string();
                
                let result = rt.block_on(async move {
                    // Get or create PQ crypto instance (thread-safe global cache)
                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                    }).await;

                    let mut instances_guard = instances.lock().await;

                    // v2.24: Use node_id directly
                    let normalized_node_id = node_id_owned.clone();

                    // Create instance if not exists
                    if !instances_guard.contains_key(&normalized_node_id) {
                        let mut pq = PqCrypto::new(normalized_node_id.clone());
                        if let Err(e) = pq.initialize().await {
                            if crate::node::is_info() {
                                println!("[ERR][P2P] PQ crypto init failed: {}", e);
                            }
                            return Err(anyhow::anyhow!("PQ init failed: {}", e));
                        }
                        instances_guard.insert(normalized_node_id.clone(), pq);
                    }

                    let pq = match instances_guard.get_mut(&normalized_node_id) {
            Some(h) => h,
            None => return Err(anyhow::anyhow!("PQ instance missing")),
        };

                    // Check certificate rotation
                    if pq.needs_rotation() {
                        let _ = pq.rotate_certificate().await;
                    }

                    // CRITICAL: Sign RAW message with pure ML-DSA-65 (hashes before signing)
                    pq.sign_raw_message_compact(message_owned.as_bytes()).await
                });
                
                match result {
                    Ok(compact_sig) => {
                        // OPTIMIZED v2.24: bincode+zstd
                        match compact_sig.to_binary_compressed() {
                            Ok(binary_data) => {
                                let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                                Some(format!("pq_p2p_bin:{}", base64_data))
                            }
                            Err(_) => None
                        }
                    }
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][P2P] CRITICAL: PQ signing failed: {} - SKIPPING HEARTBEAT", e);
                        }
                        None
                    }
                }
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] CRITICAL: Runtime creation failed: {} - SKIPPING HEARTBEAT", e);
                }
                None
            }
        }
    }
    
    
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v2.50.0: POOL 2 & POOL 3 METHODS - Deterministic reward calculation
    // These values are accumulated locally and written to MacroBlock at emission time
    // All nodes then use SAME values from blockchain for identical reward calculation
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Add transaction fee to Pool 2 accumulator (called when TX is processed)
    /// v3.18: Pool 2 removed - fees go directly to block producer
    /// This method kept for backward compatibility (does nothing)
    pub fn add_to_pool2(&self, fee_amount: u64) {
        self.pool2_accumulated_fees.fetch_add(fee_amount, Ordering::SeqCst);
    }
    
    /// Add activation payment to Pool 3 accumulator (Phase 2 only)
    /// Pool 3: Distributed equally to ALL eligible nodes (Light + Full + Super)
    pub fn add_to_pool3(&self, activation_amount: u64) {
        self.pool3_accumulated_activations.fetch_add(activation_amount, Ordering::SeqCst);
    }
    
    /// Get Pool 2 accumulated fees for MacroBlock inclusion (async for API compatibility)
    /// Called during EMISSION MacroBlock creation to record fees in blockchain
    /// Returns current accumulation and resets to 0
    pub async fn get_pool2_accumulated_fees(&self) -> u64 {
        // Atomic swap: read and reset in one operation (no race conditions)
        self.pool2_accumulated_fees.swap(0, Ordering::SeqCst)
    }
    
    /// Get Pool 3 accumulated activations for MacroBlock inclusion (async for API compatibility)
    /// Called during EMISSION MacroBlock creation to record activations in blockchain
    /// Returns current accumulation and resets to 0 (Phase 2 only, Phase 1 always returns 0)
    pub async fn get_pool3_accumulated_activations(&self) -> u64 {
        // Atomic swap: read and reset in one operation (no race conditions)
        self.pool3_accumulated_activations.swap(0, Ordering::SeqCst)
    }
    
    /// Get current Pool 2 balance without resetting (for monitoring)
    pub fn peek_pool2_fees(&self) -> u64 {
        self.pool2_accumulated_fees.load(Ordering::SeqCst)
    }
    
    /// Get current Pool 3 balance without resetting (for monitoring)
    pub fn peek_pool3_activations(&self) -> u64 {
        self.pool3_accumulated_activations.load(Ordering::SeqCst)
    }
    
    /// Get Light Node registry (for ping service)
    pub fn get_light_node_registry(&self) -> HashMap<String, LightNodeRegistrationData> {
        self.light_node_registry.read().clone()
    }

    /// Point-read one light node without cloning the whole registry (scale: millions of entries).
    pub fn get_light_node(&self, node_id: &str) -> Option<LightNodeRegistrationData> {
        self.light_node_registry.read().get(node_id).cloned()
    }
    
    /// Register Light node locally and gossip to network. Returns what the ping-key write did (None with no
    /// storage or on a storage error): the legacy register changes an on-chain node's push record only for a
    /// key it applied (M-8).
    pub fn register_light_node(&self, registration: LightNodeRegistrationData) -> Option<crate::storage::PingKeyWrite> {
        // C: ping keys → dedicated CF (read per-ping); resident entry keeps pubkey/sig/ping-keys EMPTY so
        // it stays ~300B at tens of millions of nodes. The key the delegation was checked under is
        // recorded with it: every reader re-checks it against the chain's commitment, and when the
        // registration applies a row under a key the chain did not commit is dropped
        // (`vouch_local_binding`).
        let key_write = self.storage.as_ref().and_then(|s| s.save_light_ping_keys_identity(&registration.node_id,
            &registration.ping_pubkey, &registration.ping_delegation_cert, &registration.quantum_pubkey).ok());
        {
            let mut registry = self.light_node_registry.write();
            self.admit_light(&mut registry, registration.clone());
        }

        let msg = Self::light_registration_gossip(registration);
        self.gossip_to_random_peers(msg, 5);
        if crate::node::is_info() {
            println!("[INFO][P2P] Light node registration gossiped to network");
        }
        key_write
    }

    /// The gossip of a light registration: the FULL `registration` values, NOT the trimmed resident entry,
    /// except the UnifiedPush endpoint. It is a push capability (anyone holding it can POST to the device), no
    /// receiver reads it (the push channel comes from the genesis-only token sync), and gossip reaches
    /// arbitrary peers (NB-2).
    pub(crate) fn light_registration_gossip(registration: LightNodeRegistrationData) -> NetworkMessage {
        NetworkMessage::LightNodeRegistration {
            node_id: registration.node_id,
            wallet_address: registration.wallet_address,
            device_token_hash: registration.device_token_hash,
            quantum_pubkey: registration.quantum_pubkey,
            registered_at: registration.registered_at,
            signature: registration.signature,
            gossip_hop: 0,
            push_type: registration.push_type,
            unified_push_endpoint: None,
            last_seen: registration.last_seen,
            consecutive_failures: registration.consecutive_failures,
            is_active: registration.is_active,
            ping_pubkey: registration.ping_pubkey,
            ping_delegation_cert: registration.ping_delegation_cert,
        }
    }
    
    /// Rehydrate the node_id -> endpoint IP registry from the committed node_registry CF.
    /// The RAM map is written only by the block-apply registration scan, so after a restart it
    /// is empty and every IP-identity gate that consults it falls through to "unbound, allow" —
    /// the pre-verify cutoff that refuses an impostor before the ML-DSA verify is then off for
    /// the whole post-restart window. Genesis addresses come from the pinned binary table, so a
    /// persisted row must never restate one.
    pub(super) fn restore_node_endpoints(&self) {
        let storage = match self.storage.as_deref()
            .or_else(|| crate::node::try_get_storage().map(|s| s.as_ref()))
        {
            Some(s) => s,
            None => return,
        };

        let endpoints = match storage.load_all_node_endpoints() {
            Ok(e) => e,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][REG] node_endpoints_restore_failed err={}", e);
                }
                return;
            }
        };

        let mut restored = 0usize;
        for (node_id, endpoint) in &endpoints {
            if node_id.starts_with("genesis_node_") { continue; }
            if crate::genesis_constants::get_node_endpoint_ip(node_id).is_some() { continue; }
            crate::genesis_constants::register_node_endpoint(node_id, endpoint);
            restored = restored.saturating_add(1);
        }

        if crate::node::is_info() {
            println!("[INFO][REG] node_endpoints_restored count={} scanned={}", restored, endpoints.len());
        }
    }

    /// v4.3: Restore light node registry from blockchain storage (RocksDB) on startup.
    /// Populates the in-memory P2P registry from persisted NodeRegistration data.
    /// Called once during node initialization so registry survives restarts.
    /// Without this, all in-memory registries would be empty after restart,
    /// and light nodes would be invisible until they re-register or gossip arrives.
    /// This is the GUARANTEED path — gossip sync is supplementary.
    pub fn restore_light_nodes_from_storage(&self, nodes: Vec<(String, String, String, u64)>) -> usize {
        let mut added = 0;
        let mut registry = self.light_node_registry.write();

        // The cap is enforced by stopping, not by evicting: at boot the map is empty, so there is
        // nothing to evict and a chain holding more than the cap would otherwise blow straight past it.
        let cap = light_registry_cap();
        for (node_id, wallet_address, _node_type, registered_at) in nodes {
            if registry.len() >= cap {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] restore_capped restored={} cap={} reason=registry_full", added, cap);
                }
                break;
            }
            if !registry.contains_key(&node_id) {
                // Through the shared admission like every other writer, so the trimming, the cap and
                // the ping index cannot diverge between the paths that fill this map.
                // B: liveness is derived from on-chain attestation recency, not a persisted flag — seed
                // active; the ping-wakeup scheduler re-derives whom to wake from committed eligibility.
                self.admit_light(&mut registry, LightNodeRegistrationData {
                    node_id: node_id.clone(),
                    wallet_address,
                    device_token_hash: String::new(),
                    quantum_pubkey: String::new(),
                    registered_at,
                    signature: String::new(),
                    push_type: PushType::Polling,
                    unified_push_endpoint: None,
                    last_seen: registered_at,
                    consecutive_failures: 0,
                    is_active: true,
                    ping_pubkey: String::new(),         // Populated on re-registration
                    ping_delegation_cert: String::new(),// Populated on re-registration
                });
                added += 1;
            }
        }
        
        if added > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] restored_from_storage light_nodes={} total_registry={}", added, registry.len());
            }
        }
        
        added
    }
    
    /// Restore the resident push channels after a restart, once, right after
    /// `restore_light_nodes_from_storage` (which seeds every entry as polling): each from what this
    /// genesis pushes the node on (`rpc::push_channel`), as `refresh_light_node_push_channel` sets it.
    pub fn update_device_tokens_from_storage(
        &self,
        storage: &crate::storage::Storage,
    ) {
        let mut registry = self.light_node_registry.write();

        let mut updated = 0usize;
        for node in registry.values_mut() {
            // Only a node holding a record with a token or an endpoint can have a channel: one point
            // read for every other node, as before.
            if storage.get_fcm_entry(&node.node_id).map_or(true, |e| e.token.is_empty() && e.endpoint.is_none()) { continue; }
            let Some(channel) = crate::rpc::push_channel(storage, &node.node_id) else { continue; };
            Self::set_resident_channel(node, Some(channel));
            updated += 1;
        }

        if updated > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] fcm_tokens_restored from_rocksdb count={} total_registry={}",
                         updated, registry.len());
            }
        }
    }

    // ========================================================================
    // PRODUCTION: Sharded Light Node Ping System
    // ========================================================================
    
    
    /// DEPRECATED: Old fixed 256-shard calculation (kept for backward compatibility)
    pub fn calculate_light_node_shard(light_node_id: &str) -> u8 {
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(light_node_id.as_bytes());
        let hash = hasher.finalize();
        hash[0]  // First byte = shard (0-255)
    }
    
    /// Get current slot number (0-239 within 4h window, each slot = 1 minute)
    /// Ping slot (0-239) of the CURRENT reward epoch, driven by BLOCK HEIGHT — NOT wall-clock — so the
    /// ping schedule shares ONE clock with rewards/attestations (both height/14400). Wall-clock windows sit
    /// on a different grid than block-epochs, so a node's slot could fall entirely outside an epoch's
    /// block-span → that epoch got 0 pings (observed live: epoch 1 pinged twice, epoch 3 zero). Anchoring
    /// to height puts exactly one ping inside every epoch. 240 slots × 60 blocks = one 14400-block epoch.
    pub fn get_current_slot() -> u64 {
        let h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        (h % 14400) / 60  // 0-239
    }

    /// Current ping window = the reward EPOCH (block height / 14400), so slot randomization
    /// (calculate_randomized_slot) and the attestation epoch (record_light_epoch_eligible) share one clock.
    pub fn get_current_window_number() -> u64 {
        LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400
    }
    
    /// Ping slot of a light node in `window_number`, re-randomised per window. From
    /// BOUNDED_SLOT_DRAW_FROM_WINDOW the draw leaves out the last slots: on the regular one-slot tick a
    /// node's primary and two grace pushes, and the lifetime of the last challenge, end before the light
    /// commit window opens. From the window `arm_push_schedule` names for the early draw it is the epoch's first
    /// UNSPACED_FIRST_PUSH_SLOTS, which leaves the retry round an hour later room before the commit: a push drawn
    /// late in the epoch was missed half as often again as an early one. From the window it names for the spaced
    /// rounds it is the first FIRST_PUSH_SLOTS, which leaves the spaced round and retry round that room.
    pub fn calculate_randomized_slot(light_node_id: &str, window_number: u64) -> u64 {
        use std::sync::atomic::Ordering::Relaxed;
        let (first_push_from, spaced_from) = (FIRST_PUSH_DRAW_WINDOW.load(Relaxed), SPACED_ROUND_WINDOW.load(Relaxed));
        Self::slot_in_draw(light_node_id, window_number, ping_draw_slots(window_number, first_push_from, spaced_from))
    }

    /// The slot of `light_node_id` in `window_number` drawn over the first `slots` slots.
    pub(crate) fn slot_in_draw(light_node_id: &str, window_number: u64, slots: u64) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        light_node_id.hash(&mut hasher);
        window_number.hash(&mut hasher);  // Randomize per window!
        hasher.finish() % slots.max(1)
    }

    /// Start the early first-push draw (P-1) at `first_push_from` and the spaced rounds at `spaced_from`, each once per
    /// process and each once known: the pinger calls it on every tick with a known height, with the windows this
    /// genesis's first arm stored (`rpc::first_push_draw_from`, `rpc::spaced_rounds_from`; None until one is stored from
    /// a tip the network stands behind), so every restart keeps the draw and the rounds the live window began with.
    pub fn arm_push_schedule(first_push_from: Option<u64>, spaced_from: Option<u64>) {
        use std::sync::atomic::Ordering::Relaxed;
        if let Some(w) = first_push_from {
            let _ = FIRST_PUSH_DRAW_WINDOW.compare_exchange(u64::MAX, w, Relaxed, Relaxed);
        }
        if let Some(w) = spaced_from {
            let _ = SPACED_ROUND_WINDOW.compare_exchange(u64::MAX, w, Relaxed, Relaxed);
        }
    }
    
    /// Get next ping time for a Light node (for polling fallback)
    /// Returns (timestamp, window_number) for the next scheduled ping
    pub fn get_next_ping_time(light_node_id: &str) -> (u64, u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let current_window = height / 14400;
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        // Target BLOCK of the node's slot this epoch; if already passed, the same slot next epoch.
        let slot_block = current_window * 14400 + node_slot * 60;
        let (target_block, window) = if slot_block > height {
            (slot_block, current_window)
        } else {
            let next_window = current_window + 1;
            let next_slot = Self::calculate_randomized_slot(light_node_id, next_window);
            (next_window * 14400 + next_slot * 60, next_window)
        };
        // Wall-clock estimate for polling clients (~1 block/s from the local tip).
        let ping_time = now + target_block.saturating_sub(height);
        (ping_time, window)
    }
    
    /// Determine if Light node should be pinged in current slot (randomized per window)
    /// Returns true if node's slot matches current slot
    /// GRACE PERIOD: Also returns true for 2 slots after the primary slot (retry window)
    pub fn is_light_node_ping_slot(light_node_id: &str) -> bool {
        let current_slot = Self::get_current_slot();
        let current_window = Self::get_current_window_number();
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        
        // GRACE PERIOD: Primary slot + 2 retry slots (3 minutes total window)
        // This handles network delays and temporary unavailability
        let slot_diff = if current_slot >= node_slot {
            current_slot - node_slot
        } else {
            // Handle wrap-around at slot 240
            240 - node_slot + current_slot
        };
        
        slot_diff <= 2  // Primary slot (0) + 2 retry slots (1, 2)
    }
    
    /// Check if this is the PRIMARY slot for Light node (not retry)
    pub fn is_light_node_primary_slot(light_node_id: &str) -> bool {
        let current_slot = Self::get_current_slot();
        let current_window = Self::get_current_window_number();
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        
        current_slot == node_slot
    }
    
    /// Determine pinger role for this node given a Light node
    /// Uses deterministic selection: hash(light_node_id + slot) → sorted active nodes → top 3
    pub fn get_pinger_role(&self, light_node_id: &str) -> PingerRole {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let current_slot = Self::get_current_slot();
        
        // Get sorted active Super node IDs (v2.51: lock-free)
        let active_node_ids: Vec<String> = {
            let mut sorted: Vec<_> = self.active_full_super_nodes.iter()
                .filter(|entry| entry.value().reputation >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION)
                .map(|entry| entry.value().node_id.clone())
                .collect();
            sorted.sort();
            sorted
        };
        
        if active_node_ids.is_empty() {
            // Fallback: Genesis nodes are always active
            if self.node_id.starts_with("genesis_node_") {
                return PingerRole::Primary;
            }
            return PingerRole::None;
        }
        
        // Deterministic selection: hash(light_node_id + slot) → index into sorted nodes
        let mut hasher = DefaultHasher::new();
        format!("{}:{}", light_node_id, current_slot).hash(&mut hasher);
        let hash = hasher.finish();
        
        let primary_idx = (hash as usize) % active_node_ids.len();
        let backup1_idx = (primary_idx + 1) % active_node_ids.len();
        let backup2_idx = (primary_idx + 2) % active_node_ids.len();
        
        // Check if we are primary, backup1, or backup2
        if active_node_ids.get(primary_idx) == Some(&self.node_id) {
            PingerRole::Primary
        } else if active_node_ids.get(backup1_idx) == Some(&self.node_id) {
            PingerRole::Backup1
        } else if active_node_ids.get(backup2_idx) == Some(&self.node_id) {
            PingerRole::Backup2
        } else {
            PingerRole::None
        }
    }
    
    /// True iff an attestation for this light node in this slot of the CURRENT epoch is already held.
    /// Built by attestation_key, the one builder every writer goes through: the key rolled by hand here
    /// carried no epoch, matched nothing an insert had produced, and so answered false for a node that
    /// had already replied - re-pinging it and re-issuing it a challenge for the rest of the slot. O(1).
    pub fn has_attestation(&self, light_node_id: &str, slot: u64) -> bool {
        let key = Self::attestation_key(light_node_id, slot);
        let attestations = self.light_node_attestations.read();
        attestations.contains_key(&key)
    }

    /// True iff this light node already attested in the CURRENT reward epoch — checked against the
    /// block-epoch eligibility set (record_light_epoch_eligible keys by block_height/14400), i.e. the
    /// SAME clock as the reward. Skips re-pinging a node that already proved liveness this epoch. O(1).
    pub fn has_attestation_in_window(&self, light_node_id: &str) -> bool {
        let epoch = Self::get_current_window_number();
        self.epoch_light_eligible.read().get(&epoch)
            .map(|s| s.contains(light_node_id)).unwrap_or(false)
    }

    /// `f` with a test of whether a node attested in `epoch` here, for a pass over many nodes (the push ledger's
    /// prune): the lock is taken once, and yielded every 4,096 tests to an answer waiting to record itself, instead of
    /// taken for every node (M-11).
    pub(crate) fn with_counted_in<R>(&self, epoch: u64, f: impl FnOnce(&mut dyn FnMut(&str) -> bool) -> R) -> R {
        let mut guard = self.epoch_light_eligible.read();
        let mut tests = 0u32;
        let mut counted = |id: &str| {
            tests = tests.wrapping_add(1);
            if tests % 4096 == 0 {
                parking_lot::RwLockReadGuard::bump(&mut guard);
            }
            guard.get(&epoch).map_or(false, |s| s.contains(id))
        };
        f(&mut counted)
    }
    
    /// Get Light nodes to ping in current slot
    /// ARCHITECTURE v2.89: ONLY Genesis nodes ping Light nodes (reliability guarantee)
    ///   - 5 Genesis nodes → each pings 20% of ALL Light nodes (2M each for 10M total)
    ///   - Genesis nodes are ALWAYS online → 100% coverage guaranteed
    ///   - Non-Genesis nodes return empty list
    /// 
    /// RELIABILITY: Genesis nodes are stable infrastructure under our control
    /// If ANY Super node could ping, node failures = lost pings = lost rewards
    /// With Genesis-only pinging: 100% reliability, 100% coverage
    /// 
    /// SCALABILITY: 2M pings per Genesis per epoch = 139 pings/sec = easily handled
    ///
    /// The slot and the epoch come from `tip`, the tick's one height load (L-4). Storage point reads: the ping loop
    /// runs it on a blocking thread, never on a runtime worker (M-11).
    pub(crate) fn get_light_nodes_to_ping(&self, tip: u64) -> crate::rpc::LightPingSelection {
        let (current_window, current_slot, now_slot) = crate::rpc::light_ping_slot_at(tip);
        let our_node_id = &self.node_id;
        let mut result = crate::rpc::LightPingSelection { now_slot, nodes: Vec::new() };

        // v2.89: ONLY Genesis nodes ping Light nodes (5 fixed shard owners, always online).
        if !is_genesis_pinger() { return result; }
        let our_genesis_idx = std::env::var("QNET_BOOTSTRAP_ID")
            .ok().and_then(|id| id.parse::<usize>().ok())
            .map(|id| id.saturating_sub(1)).unwrap_or(0);

        if crate::node::is_info() {
            println!("[INFO][GENESIS-PING] Genesis node {} (idx={}) checking Light nodes to ping slot={}",
                     our_node_id, our_genesis_idx, current_slot);
        }

        // Which shards we push this slot (F5). Our own always; a shard we back up only while every owner ranked
        // above us is judged silent from the ping ticks it sends after each completed tick (`OwnerLiveness`):
        // a primary whose push loop is wedged, that is behind the network, or whose provider answers none of its
        // pushes (`PushHealth`), sends none and is taken over though its other announcements go on. Pushing is what PRODUCES the answers the bitmap commits, so a shard whose
        // genesis is down needs a stand-in here, not only at commit time. Covering starts after ten silent slots
        // and ends after three heard in a row, so a slow minute never hands a shard over and back.
        let now_ts = self.current_timestamp();
        let alive = crate::rpc::OWNER_LIVENESS.judge(our_genesis_idx, now_ts, |idx| {
            // A genesis never heard ticking here (an earlier release) is judged by its last announcement of any kind.
            let id = format!("genesis_node_{:03}", idx + 1);
            self.active_full_super_nodes.get(&id).map(|e| now_ts.saturating_sub(e.value().last_seen))
        });
        let covered = crate::node::light_shards_to_cover(our_genesis_idx, &|idx| alive[idx]);
        let covered_mask: usize = covered.iter().fold(0, |m, (sh, _)| m | (1 << sh));
        crate::rpc::set_covered_shards(covered.len());
        if covered_mask != 1 << our_genesis_idx && crate::node::is_warn() {
            println!("[WARN][GENESIS-PING] shard_takeover idx={} covering={:?} reason=owner_silent",
                     our_genesis_idx, covered.iter().map(|(sh, _)| *sh).collect::<Vec<_>>());
        }

        // "Dormant" must mean the DEVICE stopped answering, never that nobody asked (F1, F3). A node is left
        // unpushed only after a proven device miss in each of the two epochs before (`rpc::proven_dormant`). An
        // epoch this genesis did not derive, or in which the node's shard committed no row, proves nothing: every
        // node of that shard is pushed (the recovery sweep, per shard, F11). Two point reads a tick, never latched:
        // the first ticks of an epoch may run before the boundary pass derived the epoch just ended, and a latched
        // "not derived" would push every dormant node for the whole epoch. Logged when it changes.
        let facts = match self.storage.as_deref().or_else(|| crate::node::try_get_storage().map(|s| s.as_ref())) {
            Some(st) => crate::rpc::DormantFacts::read(st, current_window),
            None => crate::rpc::DormantFacts::default(),
        };
        let packed = current_window << 8 | facts.decidable as u64;
        if DORMANT_FACTS.swap(packed, std::sync::atomic::Ordering::Relaxed) != packed {
            let sweeping: Vec<usize> = covered.iter().map(|(sh, _)| *sh).filter(|sh| facts.neutral(*sh)).collect();
            if !sweeping.is_empty() && crate::node::is_warn() {
                println!("[WARN][GENESIS-PING] shard_recovery_sweep shards={:?} epoch={} reason=last_two_epochs_not_committed_or_not_derived",
                         sweeping, current_window);
            }
        }
        let registry = self.light_node_registry.read();
        let reg_len = registry.len();

        // A full pass ONLY when what the slot is derived from changes: the window (the slot is
        // re-randomised per window, deliberately) or the set of shards we cover. Keying it on the
        // registry SIZE as well meant one registration rebuilt everything — at ten million light nodes
        // that is ten million id clones under this read lock, on a slot that fires every minute.
        // Stable hash-shard (light_shard_of): a node's shard never moves as the registry grows.
        let stale = SLOT_INDEX_STALE.swap(false, std::sync::atomic::Ordering::Relaxed);
        let need_rebuild = {
            let c = self.light_ping_slot_cache.read();
            c.0 != current_window || c.2 != covered_mask
        } || stale;
        if need_rebuild {
            // The id snapshot AND the pending queue are taken together, under the read lock that
            // excludes every writer. That is what makes them consistent: the queue is only ever filled
            // by a writer holding the WRITE lock, so nothing can be admitted between the two, and the
            // snapshot therefore already contains every queued id. Clearing after releasing the lock
            // would drop whatever was admitted in the gap - present in neither the buckets nor the
            // queue. Hashing and bucketing run outside the lock, so block apply, which admits under
            // the write lock, is not held behind the part that does not need the map.
            let ours: Vec<String> = registry.keys()
                .filter(|id| covered_mask & (1 << crate::node::light_shard_of(id)) != 0)
                .cloned().collect();
            drop(std::mem::take(&mut *self.light_ping_pending.write()));
            drop(registry);
            let mut buckets: Vec<Vec<String>> = vec![Vec::new(); 240];
            index_new_light_nodes(&mut buckets, ours, current_window, covered_mask);
            *self.light_ping_slot_cache.write() = (current_window, buckets, covered_mask);
            SLOT_INDEX_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        } else {
            // Everything admitted since the last slot, placed in O(new). A node queued after the take is placed at the
            // next tick, so the registry's lock is not needed for it.
            drop(registry);
            let newly = std::mem::take(&mut *self.light_ping_pending.write());
            if !newly.is_empty() {
                let mut c = self.light_ping_slot_cache.write();
                let placed = index_new_light_nodes(&mut c.1, newly, current_window, covered_mask);
                if placed > 0 && crate::node::is_debug() {
                    println!("[DBG][GENESIS-PING] slot_index_extended placed={} epoch={}", placed, current_window);
                }
            }
        }

        // Read the buckets of every due point that came since the last tick, with its grace (`push_reads`): with the
        // spaced rounds the drawn slot, 15 and 30 slots on, and the retry round 60, 75 and 90 slots on; before them the
        // grace slots {cur, cur-1, cur-2} and the same slots an hour earlier. A node already counted this epoch is never
        // pushed. A fresh one (its first WAKE_GRACE_EPOCHS epochs), one of a shard the dormant rule cannot decide this
        // epoch (`facts`), and one whose answer this genesis holds for one of the two epochs before, are pushed at once;
        // for the rest the dormant rule is read from storage after the locks are released. Liveness authority is
        // on-chain; this is a whom-to-wake decision.
        // A whole epoch behind the chain (resync): the slots passed belong to epochs already committed,
        // so the tick reads only the grace slots.
        let behind = self.corroborated_head_ceiling() / 14400 > current_window;
        let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        const WAKE_GRACE_EPOCHS: u64 = crate::rpc::WAKE_GRACE_EPOCHS;
        let storage = self.storage.as_deref().or_else(|| crate::node::try_get_storage().map(|s| s.as_ref()));
        let window_start = current_window * 240;
        // The first tick after a restart: the run before kept the last slot it read (`rpc::push_read_mark`). In this
        // window and within the catch-up bound, this tick's reads join it, and no due point that run read is read
        // again: each of those pushes went out or was shed once, and the record that would close it is gone.
        let last_read = self.light_ping_last_read.swap(now_slot, std::sync::atomic::Ordering::Relaxed);
        let first_tick = last_read == u64::MAX;
        let resumed = if first_tick && !behind { storage.and_then(crate::rpc::push_read_mark) } else { None }
            .filter(|(l, _)| *l >= window_start && *l < now_slot && now_slot - *l <= MAX_PING_CATCHUP_SLOTS);
        let last = if behind { None } else if first_tick { resumed.map(|(l, _)| l) } else { Some(last_read) };
        let mut reads_state = SHARD_READS.lock();
        if first_tick { reads_state.done = resumed.map(|(l, _)| l); }
        let (reads, gap) = push_reads(last, now_slot, spaced_rounds_in(current_window), reads_state.done);
        if gap > 0 && crate::node::is_info() {
            println!("[INFO][GENESIS-PING] ping_read_gap gap_slots={} max={} slot={} action=grace_slots_only",
                     gap, MAX_PING_CATCHUP_SLOTS, current_slot);
        }
        // Since when every due point of each shard pushed was read here, and since when this process records its pushes
        // (`ShardReads`), kept with the slot read for the next restart.
        let joined = last.is_some() && gap == 0;
        let first_due = match (resumed, last) {
            (Some((l, _)), _) => l + 1,
            (None, Some(l)) if joined && l < now_slot => (l + 1).saturating_sub(crate::rpc::DUE_GRACE_SLOTS),
            _ => now_slot.saturating_sub(crate::rpc::DUE_GRACE_SLOTS),
        }.max(window_start);
        reads_state.advance(covered_mask, our_genesis_idx, first_due, joined, resumed.map(|(_, r)| r));
        let shard_reads = *reads_state;
        drop(reads_state);
        if let Some(st) = storage {
            crate::rpc::keep_push_read_mark(st, now_slot, shard_reads.read_from[our_genesis_idx]);
        }
        // A shard another owner may have pushed earlier in the window is read under that owner's draw too, where it
        // differs from ours (`foreign_draws`): in the epochs of a roll, never otherwise.
        let mut schedules = crate::rpc::OWNER_SCHEDULES.get();
        schedules[our_genesis_idx] = (FIRST_PUSH_DRAW_WINDOW.load(std::sync::atomic::Ordering::Relaxed),
                                      SPACED_ROUND_WINDOW.load(std::sync::atomic::Ordering::Relaxed));
        let mut wanted: Vec<(u64, usize)> = Vec::new();
        for (sh, _) in covered.iter().filter(|(sh, _)| shard_reads.read_from[*sh] > window_start) {
            for d in foreign_draws(current_window, our_genesis_idx, *sh, &schedules) {
                match wanted.iter_mut().find(|(x, _)| *x == d) {
                    Some(w) => w.1 |= 1 << sh,
                    None => wanted.push((d, 1 << sh)),
                }
            }
        }
        wanted.sort_unstable();
        if !wanted.is_empty() && crate::node::is_debug() {
            println!("[DBG][GENESIS-PING] foreign_draws draws={:?} slot={}", wanted, current_slot);
        }
        // A repeat of a round begun before this process held its shard's records (a restart, a takeover) is due to any
        // node not counted; the shard is hashed only while such a round is read.
        let oldest_round = reads.iter().flat_map(|r| r.dues.iter()).filter(|d| d.repeat).map(|d| d.round).min();
        let orphans = oldest_round.map_or(false, |o| covered.iter().any(|(sh, _)| shard_reads.held_from[*sh] > o));
        let held_from = |id: &str| if orphans { shard_reads.held_from[crate::node::light_shard_of(id)] } else { 0 };
        // The ledger first, in RAM, under the slot index's locks alone: one push a due point and MAX_PUSHES_PER_EPOCH an
        // epoch at this rank, a repeat only to a node offered a push here (U13, `PushLedger::may_push`). The registry's
        // lock is not held, so block apply admits meanwhile (no writer of it takes the slot index's, so taking it after
        // them waits on nothing that waits on them); before the eligibility lock, which the ledger's prune takes under
        // its own, and before any storage read.
        let cache = self.light_ping_slot_cache.read();
        let mut foreign = FOREIGN_INDEX.lock();
        foreign.sync(&cache.1, SLOT_INDEX_BUILDS.load(std::sync::atomic::Ordering::Relaxed), current_window, &wanted);
        let mut due: Vec<&String> = Vec::new();
        for r in &reads {
            due.extend(cache.1.get(r.bucket).into_iter().flatten().chain(foreign.ids(&cache.1, r.bucket))
                .filter(|id| crate::rpc::PUSH_LEDGER.may_push(id, now_slot, &r.dues, || held_from(id))));
        }
        if !wanted.is_empty() {
            // A node drawn into two buckets this tick reads is offered once.
            let mut seen = std::collections::HashSet::with_capacity(due.len());
            due.retain(|id| seen.insert(*id));
        }
        let registry = self.light_node_registry.read();
        let elig = self.epoch_light_eligible.read();
        let held_in = |id: &str, e: Option<u64>| e.and_then(|e| elig.get(&e)).map_or(false, |s| s.contains(id));
        let this_epoch = |id: &str| elig.get(&current_window).map(|s| s.contains(id)).unwrap_or(false);
        // (node id, role, shard, whether the dormant rule must be read for it)
        let mut candidates: Vec<(String, PingerRole, usize, bool)> = Vec::new();
        for node_id in due {
            let node = match registry.get(node_id) { Some(n) => n, None => continue };
            if this_epoch(node_id) { continue; }  // already attested this epoch — nothing to wake
            let shard = crate::node::light_shard_of(node_id);
            let role = match crate::node::light_owner_rank(shard, our_genesis_idx) {
                Some(0) => PingerRole::Primary,
                Some(1) => PingerRole::Backup1,
                Some(_) => PingerRole::Backup2,
                None => continue,
            };
            let fresh = now_secs.saturating_sub(node.registered_at) < WAKE_GRACE_EPOCHS * 14400;
            let answered_before = held_in(node_id, current_window.checked_sub(1)) || held_in(node_id, current_window.checked_sub(2));
            let check = !fresh && !facts.neutral(shard) && !answered_before;
            candidates.push((node_id.clone(), role, shard, check));
        }
        drop(elig);
        drop(registry);
        drop(foreign);
        drop(cache);
        // The dormant rule, then: push only an on-chain node with a device bound to it, with how its device is reached
        // (`rpc::push_reach_at`), so the push itself reads nothing again. These are storage point reads, so they run
        // after the locks above are released.
        match storage {
            Some(storage) => {
                let (device_epoch, device_now) = (crate::light_device::current_epoch(), crate::light_device::now_secs());
                let mut dormant = 0usize;
                for (node_id, role, shard, check) in candidates {
                    // Two proven device misses: not woken, and held so (`SendOutcome::Dormant`) until its own answer, so
                    // the epoch counts toward the rule next epoch too and the node never flips back every third epoch.
                    if check && (crate::rpc::PUSH_LEDGER.held_dormant(&node_id, current_window)
                        || crate::rpc::proven_dormant(storage, &crate::rpc::REACH_CACHE, &facts, &node_id, shard, current_window)) {
                        crate::rpc::PUSH_LEDGER.record(&node_id, now_slot, crate::rpc::SendOutcome::Dormant, now_secs);
                        dormant += 1;
                        continue;
                    }
                    if let Some(reach) = crate::rpc::push_reach_at(storage, &node_id, device_epoch, device_now) {
                        result.nodes.push((node_id, role, reach));
                    }
                }
                if dormant > 0 && crate::node::is_debug() {
                    println!("[DBG][GENESIS-PING] dormant_skipped count={} slot={}", dormant, current_slot);
                }
            }
            None => result.nodes.clear(),
        }

        if crate::node::is_debug() && !result.nodes.is_empty() {
            println!("[DBG][GENESIS-PING] Genesis {} has {} Light nodes to ping this slot (registry: {})",
                     our_genesis_idx + 1, result.nodes.len(), reg_len);
        }
        result
    }
    
    /// Shard-owner push-channel self-heal: when nothing we hold for a my-shard node is a channel of
    /// its binding here (no record, a polling one, or one left by a replaced device or written under
    /// another key) while another genesis just served its attestation, pull that genesis's record and
    /// apply it under the binding order (`apply_pulled_push_record`), storage and RAM registry together.
    /// Bounded: only degraded my-shard nodes, once per (node, epoch), 64k dedup cap.
    pub(super) fn maybe_pull_push_channel(node_id: &str, attestor_id: &str, epoch: u64) {
        fn pull_dedup() -> &'static dashmap::DashMap<String, u64> {
            static M: std::sync::OnceLock<dashmap::DashMap<String, u64>> = std::sync::OnceLock::new();
            M.get_or_init(dashmap::DashMap::new)
        }
        let degraded = match crate::node::try_get_storage() {
            Some(s) => crate::rpc::push_record_degraded(s, node_id),
            None => return,
        };
        if !degraded { return; }
        let Some(ip) = Self::genesis_peer_ip(attestor_id) else { return; };
        if pull_dedup().len() > 65_536 { pull_dedup().clear(); }
        if pull_dedup().insert(node_id.to_string(), epoch) == Some(epoch) { return; }
        let node = node_id.to_string();
        let src_ip = ip.to_string();
        tokio::spawn(async move {
            let path = format!("/api/v1/internal/fcm-token-get?node_id={}", node);
            let v: serde_json::Value = match crate::rpc::genesis_internal_call_tls(&src_ip, &path, |c, url| c.get(url)).await.ok()
                .and_then(|r| if r.status().is_success() { Some(r) } else { None })
            {
                Some(r) => match r.json().await { Ok(v) => v, Err(_) => return },
                None => return,
            };
            let (token, pt) = (v["token"].as_str().unwrap_or(""), v["push_type"].as_str().unwrap_or(""));
            let endpoint = v["endpoint"].as_str().filter(|e| !e.is_empty());
            if v["success"].as_bool() != Some(true) || (token.is_empty() && endpoint.is_none()) || pt.is_empty() { return; }
            // Applied here rather than through this node's own sync route: the route wants a signed
            // proof for a v2 binding, and a pulled record carries none. It is taken only for the
            // binding this node already holds (or, with no v2 binding, as before).
            let applied = crate::node::try_get_storage().map_or(false, |s| crate::rpc::apply_pulled_push_record(
                s, crate::node::try_get_p2p().map(|p| p.as_ref()), &node, token, pt, endpoint,
                v["ts"].as_u64().unwrap_or(0), v["seq"].as_u64().unwrap_or(0), v["writer"].as_str().unwrap_or("")));
            if applied {
                if crate::node::is_info() {
                    println!("[INFO][LIGHT] push_channel_pulled node={} from={} push={}", node, src_ip, pt);
                }
            } else if crate::node::is_debug() {
                println!("[DBG][LIGHT] push_channel_pull_failed node={} from={}", node, src_ip);
            }
        });
    }

    /// IP of the genesis peer `attestor_id` names; None for a non-genesis id or for this node itself.
    pub(super) fn genesis_peer_ip(attestor_id: &str) -> Option<&'static str> {
        // Pad so the legacy unpadded id form ("genesis_node_1") still resolves.
        let digits = format!("{:0>3}", attestor_id.strip_prefix("genesis_node_")?);
        if std::env::var("QNET_BOOTSTRAP_ID").ok().as_deref() == Some(digits.as_str()) { return None; }
        crate::genesis_constants::GENESIS_NODE_IPS.iter().find(|(_, id)| *id == digits).map(|(ip, _)| *ip)
    }

    /// A relayed attestation this node already took: the gossip echo, and ONLY the echo. The key must live
    /// in the same unit as the credit it guards: eligibility is per EPOCH, slot numbers repeat every epoch,
    /// and the map is retained 24 h = 6 epochs. Keyed on {id}:{slot} alone, an attestation suppressed that
    /// device's replies in the same slot for six epochs — the shard owner dropped the relayed reply before
    /// recording eligibility, and the device lost those rewards. The LOCAL epoch is used, not the message
    /// block_height, which is relay-tamperable. Built by the SAME helper the writer uses, so a dedupe read
    /// can never look up a shape the insert does not produce. The eligibility set is read too: the map stops
    /// deduping past its bound, and the set is the eligibility record itself.
    pub(super) fn light_relay_seen(&self, light_node_id: &str, slot: u64) -> bool {
        if self.light_node_attestations.read().contains_key(&Self::attestation_key(light_node_id, slot)) { return true; }
        let local_epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        self.epoch_light_eligible.read().get(&local_epoch).map_or(false, |s| s.contains(light_node_id))
    }

    /// The last steps of a relayed attestation whose pinger checked out, and whose anchor this node's tip
    /// has reached: the device's own signature over the challenge, the only thing proving the phone
    /// answered, under the same verifier the HTTP ingress uses (so relay and ingress accept an identical
    /// set); the heal of a refusal a pull can mend; admission and the re-gossip.
    pub(super) fn finish_light_relay(&self, attestation: LightNodeAttestation, gossip_hop: u8) {
        use crate::light_device::ping::{self, ReplyRefusal};
        let (node, pinger) = (attestation.light_node_id.clone(), attestation.pinger_id.clone());
        let route = ping::Route::Relay { block_height: attestation.block_height };
        if let Err(refusal) = self.verify_light_ping_signature(&node, &attestation.challenge, &attestation.light_node_signature, route) {
            // A node holds ping keys and device records only for the shards it owns, so a relay for any other
            // shard fails here by construction and is nothing to report: three fifths of the fleet's
            // attestations reach each node that way, and at WARN they buried the cases that do mean
            // something — a shard this node owns, where a pull below has to heal a row.
            let epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
            if !self.node_in_my_shard_for_epoch(epoch, &node) {
                if crate::node::is_debug() {
                    println!("[DBG][P2P] light_sig_other_shard node={} pinger={} reason={}", node, pinger, refusal.as_str());
                }
            } else if crate::node::is_warn() {
                println!("[WARN][P2P] light_sig_invalid node={} pinger={} reason={}", node, pinger, refusal.as_str());
            }
            match refusal {
                // An owner the device never replied to directly holds no identity row for it, or a stale one.
                ReplyRefusal::Sigma => self.maybe_pull_light_identity(attestation),
                // Or the device record the relaying genesis holds, or its latest statement or change, never
                // reached this one.
                r if ping::heals_by_record_pull(r) => self.maybe_pull_device_record(attestation),
                _ => {}
            }
            return;
        }
        let (slot, block_height) = (attestation.slot, attestation.block_height);
        // Store through the single writer, and record eligibility for a my-shard node: the same admission
        // the identity pull finishes with. Light nodes keep the FIXED reputation of 70: no change here.
        // Not relayed further (F7): the genesis that took the answer sent it to every owner itself.
        self.admit_relayed_attestation(attestation);
        if crate::node::is_info() {
            println!("[INFO][P2P] Light node {} attested by {} in slot {} height={} hop={}", node, pinger, slot, block_height, gossip_hop);
        }
    }

    /// Hold a relayed attestation of a my-shard node whose anchor is above this node's tip (this owner is
    /// behind the genesis that credited it), and finish it (`finish_light_relay`) once the tip reaches the
    /// anchor: one drain task while anything is held, bounded by `ping::HeldRelays` in count and bytes.
    /// Nothing is credited on holding, and a reply still held after `ping::RELAY_HOLD_SECS` is dropped as
    /// before. Only a genesis pinger's relay is held: their keys are pinned, and only genesis nodes ping
    /// light nodes; any other relay is judged at once or dropped. `direct`: the pinger sent it itself.
    pub(super) fn hold_relayed_attestation(&self, a: LightNodeAttestation, anchor_height: u64, gossip_hop: u8, direct: bool) {
        use crate::light_device::ping::HeldRelays;
        type Held = parking_lot::Mutex<HeldRelays<(LightNodeAttestation, u8)>>;
        fn held() -> &'static Held {
            static H: std::sync::OnceLock<Held> = std::sync::OnceLock::new();
            H.get_or_init(|| parking_lot::Mutex::new(HeldRelays::new()))
        }
        static DRAINING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        use std::sync::atomic::Ordering::{Relaxed, SeqCst};
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
        let (node, pinger) = (a.light_node_id.clone(), a.pinger_id.clone());
        let genesis = pinger.starts_with("genesis_node_");
        if !genesis {
            return;
        }
        let now = crate::light_device::now_secs();
        let size = a.light_node_signature.len() + a.pinger_signature.len() + a.challenge.len() + node.len() + pinger.len() + 64;
        if !held().lock().hold(&node, &pinger, genesis, direct, anchor_height, now, size, (a, gossip_hop)) {
            if crate::node::is_debug() {
                println!("[DBG][P2P] light_relay_not_held node={} pinger={} anchor={}", node, pinger, anchor_height);
            }
            return;
        }
        if crate::node::is_debug() {
            println!("[DBG][P2P] light_relay_held node={} pinger={} anchor={} tip={}", node, pinger, anchor_height,
                     LOCAL_BLOCKCHAIN_HEIGHT.load(Relaxed));
        }
        if DRAINING.swap(true, SeqCst) { return; }
        handle.spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let tip = LOCAL_BLOCKCHAIN_HEIGHT.load(Relaxed);
                let (due, dropped) = held().lock().take_due(tip, crate::light_device::now_secs());
                if dropped > 0 && crate::node::is_debug() {
                    println!("[DBG][P2P] light_relay_hold_expired count={} tip={}", dropped, tip);
                }
                if let Some(p2p) = crate::node::try_get_p2p() {
                    for (a, hop) in due {
                        if !p2p.light_relay_seen(&a.light_node_id, a.slot) { p2p.finish_light_relay(a, hop); }
                    }
                }
                if held().lock().is_empty() {
                    DRAINING.store(false, SeqCst);
                    // A hold that came in meanwhile found the task running: take it on again.
                    if held().lock().is_empty() || DRAINING.swap(true, SeqCst) { return; }
                }
            }
        });
    }

    /// Admit a relayed attestation whose device signature verified. Eligibility is recorded only for a
    /// node in one of our shards and only for the CURRENT local epoch: block_height is not signed, and a
    /// forged future height would drive the prune in record_light_epoch_eligible and wipe the live set.
    /// Only an answer anchored before its epoch's commit opened (`relay_creditable`): a backup's row commits
    /// what it holds (F2), and no answer may count in an epoch it was not given in time for.
    pub(super) fn admit_relayed_attestation(&self, a: LightNodeAttestation) {
        let (node, pinger, block_height, answered_at) =
            (a.light_node_id.clone(), a.pinger_id.clone(), a.block_height, a.timestamp);
        self.store_attestation(a);
        let local_epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        if !crate::rpc::relay_creditable(block_height, local_epoch) {
            if crate::node::is_debug() {
                println!("[DBG][P2P] light_relay_after_commit node={} pinger={} height={}", node, pinger, block_height);
            }
            return;
        }
        if self.node_in_my_shard_for_epoch(local_epoch, &node) {
            self.record_light_epoch_eligible(block_height, &node, answered_at);
            // The attestor just served this node, so its push channel is live: heal ours if degraded.
            Self::maybe_pull_push_channel(&node, &pinger, local_epoch);
        }
    }

    /// Heal a relay that failed here although a genesis pinger verified it: this node holds no identity row
    /// for the device, or a stale one (the ping key rotates on every reinstall). Pull the pinger's row once
    /// per (node, epoch), admit it only under the chain commitment and only if its ping key signs the held
    /// challenge (so a stale or forged row never lands), then admit the relay.
    pub(super) fn maybe_pull_light_identity(&self, a: LightNodeAttestation) {
        fn pull_dedup() -> &'static dashmap::DashMap<String, u64> {
            static M: std::sync::OnceLock<dashmap::DashMap<String, u64>> = std::sync::OnceLock::new();
            M.get_or_init(dashmap::DashMap::new)
        }
        // Every established node of a shard pulls once after a rollout; in-flight pulls stay bounded.
        fn pull_permits() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
            static S: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
            S.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(32)))
        }
        let local_epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        if crate::light_device::ping::sigma_text(&a.light_node_signature).is_none()
            || !self.node_in_my_shard_for_epoch(local_epoch, &a.light_node_id) { return; }
        // Already recorded here this epoch: this node's row is current, so a copy that fails was tampered
        // with, and a pull could not help.
        if self.epoch_light_eligible.read().get(&local_epoch).map_or(false, |s| s.contains(&a.light_node_id)) { return; }
        let Some(storage) = crate::node::try_get_storage() else { return; };
        let Some(ip) = Self::genesis_peer_ip(&a.pinger_id) else { return; };
        if pull_dedup().len() > 65_536 { pull_dedup().clear(); }
        if pull_dedup().insert(a.light_node_id.clone(), local_epoch) == Some(local_epoch) { return; }
        let Ok(permit) = pull_permits().clone().try_acquire_owned() else {
            pull_dedup().remove(&a.light_node_id);
            return;
        };
        tokio::spawn(async move {
            let _permit = permit;
            let node = a.light_node_id.clone();
            let path = format!("/api/v1/internal/light-ping-keys-get?node_id={}", node);
            let v: serde_json::Value = match crate::rpc::genesis_internal_call_tls(ip, &path, |c, url| c.get(url)).await.ok()
                .filter(|r| r.status().is_success())
            {
                Some(r) => match r.json().await { Ok(v) => v, Err(_) => return },
                None => {
                    if crate::node::is_debug() {
                        println!("[DBG][LIGHT] light_identity_pull_failed node={} from={}", node, ip);
                    }
                    return;
                }
            };
            let field = |k: &str| v[k].as_str().unwrap_or("").to_string();
            let (pp, cert, presented) = (field("ping_pubkey"), field("ping_delegation_cert"), field("identity_pubkey"));
            if v["success"].as_bool() != Some(true) || pp.is_empty() || cert.is_empty() { return; }
            // The three checks the HTTP ingress runs before it records an identity (light_nodes.rs).
            let inner_sig = crate::light_device::ping::sigma_text(&a.light_node_signature).unwrap_or_default();
            let admitted = storage.resolve_light_identity_pk(&node, Some(presented.as_str())).filter(|id| {
                crate::light_binding::verify_delegation(&cert, &pp, &node, id).is_some()
                    && crate::rpc::verify_mobile_dilithium_signature(&a.challenge, &inner_sig, &pp)
            });
            let Some(identity) = admitted else {
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] light_identity_pull_rejected node={} from={}", node, ip);
                }
                return;
            };
            // The binding order holds here too: a peer still holding a replaced device's row cannot
            // bring it back, and a newer row catches this node up.
            match storage.save_light_ping_keys_identity(&node, &pp, &cert, &identity) {
                Ok(w) if w.holds() => {}
                Ok(w) => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] light_identity_pull_superseded node={} from={} verdict={:?}", node, ip, w);
                    }
                    return;
                }
                Err(_) => return,
            }
            if crate::node::is_info() {
                println!("[INFO][LIGHT] light_identity_pulled node={} from={}", node, ip);
            }
            // Admitted through the shared verifier with the row now held: a device reply's own checks and
            // its counter run there, as for any relay. A new binding's row releases the device record the
            // old one held, so a missed statement of the new binding shows only now: pull it too.
            if let Some(p2p) = crate::node::try_get_p2p() {
                let route = crate::light_device::ping::Route::Relay { block_height: a.block_height };
                match p2p.verify_light_ping_signature(&a.light_node_id, &a.challenge, &a.light_node_signature, route) {
                    Ok(()) => p2p.admit_relayed_attestation(a),
                    Err(r) if crate::light_device::ping::heals_by_record_pull(r) => p2p.maybe_pull_device_record(a),
                    Err(_) => {}
                }
            }
        });
    }

    /// Heal a device reply relayed by a genesis that holds the node's device record when this owner holds
    /// none or one behind it (`ping::heals_by_record_pull`): a statement's or a change's sync missed it (the
    /// sender re-sends it for an hour, then pulls heal). Pull the
    /// pinger's record once per (node, epoch) - from the statement's ingress when the pinger keeps no proof,
    /// every signature re-verified here - then admit the reply through the shared verifier.
    pub(super) fn maybe_pull_device_record(&self, a: LightNodeAttestation) {
        fn pull_dedup() -> &'static dashmap::DashMap<String, u64> {
            static M: std::sync::OnceLock<dashmap::DashMap<String, u64>> = std::sync::OnceLock::new();
            M.get_or_init(dashmap::DashMap::new)
        }
        fn pull_permits() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
            static S: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
            S.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(8)))
        }
        let local_epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        if !a.light_node_signature.starts_with("ping_hw2:") || !self.node_in_my_shard_for_epoch(local_epoch, &a.light_node_id) { return; }
        let Some(storage) = crate::node::try_get_storage() else { return; };
        let Some(ip) = Self::genesis_peer_ip(&a.pinger_id) else { return; };
        if pull_dedup().len() > 65_536 { pull_dedup().clear(); }
        if pull_dedup().insert(a.light_node_id.clone(), local_epoch) == Some(local_epoch) { return; }
        let Ok(permit) = pull_permits().clone().try_acquire_owned() else {
            pull_dedup().remove(&a.light_node_id);
            return;
        };
        tokio::spawn(async move {
            let _permit = permit;
            let genesis = crate::light_device::statement::GenesisSet::production();
            let pulled = crate::rpc::pull_device_record(storage, genesis, crate::light_device::is_mainnet(), &a.light_node_id, ip).await;
            if !pulled { return; }
            // The record now held may be a new binding's whose ping key this node missed too: pull that row.
            if let Some(p2p) = crate::node::try_get_p2p() {
                let route = crate::light_device::ping::Route::Relay { block_height: a.block_height };
                match p2p.verify_light_ping_signature(&a.light_node_id, &a.challenge, &a.light_node_signature, route) {
                    Ok(()) => p2p.admit_relayed_attestation(a),
                    Err(crate::light_device::ping::ReplyRefusal::Sigma) => p2p.maybe_pull_light_identity(a),
                    Err(_) => {}
                }
            }
        });
    }

    /// Set a light node's resident push channel (token refresh, token sync, bind, unbind, apply) to what
    /// this genesis pushes it on (`rpc::push_channel`), polling when nothing: never a stored record that
    /// is not the linked device's. `last_seen` is not touched: it is public in `/node/status`, and a
    /// binding change is not the device being seen (it would date every bind, refresh and unbind).
    pub fn refresh_light_node_push_channel(&self, storage: &crate::storage::Storage, node_id: &str) {
        let channel = crate::rpc::push_channel(storage, node_id);
        if let Some(node) = self.light_node_registry.write().get_mut(node_id) {
            Self::set_resident_channel(node, channel);
        }
    }

    fn set_resident_channel(node: &mut LightNodeRegistrationData, channel: Option<crate::rpc::PushChannel>) {
        (node.push_type, node.unified_push_endpoint) = match channel {
            Some(crate::rpc::PushChannel::Fcm(_)) => (PushType::FCM, None),
            Some(crate::rpc::PushChannel::UnifiedPush(e)) => (PushType::UnifiedPush, Some(e)),
            None => (PushType::Polling, None),
        };
    }

    /// Gossip a verified binding, to the node's shard owners directly (random gossip reaches a given
    /// genesis only by chance on a large network, and they are the ones that push and credit) and to
    /// random peers. The receiver re-checks it (identity under the chain commitment, delegation,
    /// sequence) and takes nothing else from the message: the static wallet signature is no longer sent
    /// (S2) and neither is a token hash (H6). The chain-decided fields ride along only because the
    /// message's field list is fixed.
    pub fn gossip_light_binding(&self, node_id: &str, wallet: &str, identity_pk: &str, ping_pk: &str, cert: &str, push_type: PushType, now: u64) {
        let msg = NetworkMessage::LightNodeRegistration {
            node_id: node_id.to_string(),
            wallet_address: wallet.to_string(),
            device_token_hash: String::new(),
            quantum_pubkey: identity_pk.to_string(),
            registered_at: now,
            signature: String::new(),
            gossip_hop: 0,
            push_type,
            unified_push_endpoint: None,
            last_seen: now,
            consecutive_failures: 0,
            is_active: true,
            ping_pubkey: ping_pk.to_string(),
            ping_delegation_cert: cert.to_string(),
        };
        for owner in crate::node::light_shard_owners(crate::node::light_shard_of(node_id)) {
            let id = format!("genesis_node_{:03}", owner + 1);
            if id == self.node_id { continue; }
            if let Some(addr) = self.get_peer_addr_by_id(&id) {
                self.send_network_message(&addr, msg.clone());
            }
        }
        self.gossip_to_random_peers(msg, 5);
    }

    /// THE single writer for the attestation map. Both callers - the origination path (this genesis
    /// took the device's reply directly) and the gossip relay - go through here, so the key shape and
    /// the capacity bound cannot drift apart again.
    ///
    /// The key carries the EPOCH because that is the unit the credit it guards lives in: slot numbers
    /// repeat every epoch and the map is retained for RETENTION_PERIOD_SECS, so a slot-only key
    /// suppressed a device in every later epoch whose reply fell in the same slot.
    pub(super) fn attestation_key(light_node_id: &str, slot: u64) -> String {
        let epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        format!("{}:{}:{}", light_node_id, slot, epoch)
    }

    pub(super) fn store_attestation(&self, mut a: LightNodeAttestation) {
        // Readers take the key and the header only; the ~12 KB of signatures were verified on arrival.
        a.light_node_signature = String::new();
        a.pinger_signature = String::new();
        a.challenge = String::new();
        let key = Self::attestation_key(&a.light_node_id, a.slot);
        // Local time: the attestation's own stamp is the pinger's, anywhere within the relay's +-300 s.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let mut attestations = self.light_node_attestations.write();
        if attestations.len() >= MAX_ATTESTATIONS_SIZE {
            // One sweep a minute at most: a sweep that frees nothing must not run on every insert. A key
            // of an earlier epoch can no longer dedupe an echo, so it goes with the expired ones.
            static LAST_SWEEP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            if now.saturating_sub(LAST_SWEEP.load(std::sync::atomic::Ordering::Relaxed)) >= 60 {
                LAST_SWEEP.store(now, std::sync::atomic::Ordering::Relaxed);
                let cutoff = now.saturating_sub(RETENTION_PERIOD_SECS);
                let live = format!(":{}", LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400);
                let before = attestations.len();
                attestations.retain(|k, v| v.timestamp > cutoff && k.ends_with(&live));
                let removed = before - attestations.len();
                if removed > 0 && crate::node::is_info() {
                    println!("[INFO][P2P] attestations_pruned removed={} kept={}", removed, attestations.len());
                }
            }
            // Still full: the map only dedupes echoes, and eligibility is recorded apart from it.
            if attestations.len() >= MAX_ATTESTATIONS_SIZE { return; }
        }
        attestations.insert(key, a);
    }

    /// Gossip Light Node attestation after successful ping
    pub fn gossip_light_node_attestation(&self, attestation: LightNodeAttestation) {
        let msg = NetworkMessage::LightNodeAttestation {
            light_node_id: attestation.light_node_id.clone(),
            pinger_id: attestation.pinger_id.clone(),
            slot: attestation.slot,
            timestamp: attestation.timestamp,
            light_node_signature: attestation.light_node_signature.clone(),
            pinger_signature: attestation.pinger_signature.clone(),
            challenge: attestation.challenge.clone(),
            gossip_hop: 0,
            block_height: attestation.block_height, // v2.59: For epoch-based filtering
        };
        
        // Store locally first + record into the per-epoch eligibility set (the live origination
        // path: this genesis received the light node's ping reply directly).
        let shard = crate::node::light_shard_of(&attestation.light_node_id);
        self.record_light_epoch_eligible(attestation.block_height, &attestation.light_node_id, attestation.timestamp);
        self.store_attestation(attestation);

        // F7: to the other owners of the shard, directly, and to nobody else: they alone credit it, and random gossip
        // made some thirteen verified copies of each answer. Each send is acknowledged where the transport allows; an
        // owner that missed one anyway is healed by a backup's row (F2) and never blamed for it (F1).
        let our_idx = Self::genesis_index(&self.node_id);
        for owner in crate::rpc::light_relay_targets(shard, our_idx) {
            if let Some(addr) = self.genesis_addr(owner) {
                self.send_owner_relay(addr, msg.clone());
            }
        }
    }

    /// The genesis index (0..5) of `node_id`, padded or not.
    pub(super) fn genesis_index(node_id: &str) -> Option<usize> {
        let digits = format!("{:0>3}", node_id.strip_prefix("genesis_node_")?);
        ["001", "002", "003", "004", "005"].iter().position(|g| *g == digits)
    }

    /// Where genesis `idx` is reached: its connected address, else its address in the binary's table.
    pub(super) fn genesis_addr(&self, idx: usize) -> Option<String> {
        let id = format!("genesis_node_{:03}", idx + 1);
        if id == self.node_id { return None; }
        self.get_peer_addr_by_id(&id)
            .or_else(|| crate::genesis_constants::GENESIS_NODE_IPS.get(idx).map(|(ip, _)| format!("{}:8001", ip)))
    }

    /// Send an answer's relay to an owner and wait for its acknowledgement, in the background and bounded; without
    /// the acknowledged transport, or past the bound, as a plain send.
    fn send_owner_relay(&self, addr: String, msg: NetworkMessage) {
        static IN_FLIGHT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        let permits = IN_FLIGHT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(512))).clone();
        let (Ok(handle), Some(p2p), Ok(permit)) =
            (tokio::runtime::Handle::try_current(), crate::node::try_get_p2p(), permits.try_acquire_owned()) else {
            self.send_network_message(&addr, msg);
            return;
        };
        handle.spawn(async move {
            let _permit = permit;
            if let Err(e) = p2p.send_critical_tx_with_ack(&addr, msg.clone()).await {
                if e.contains("QUIC not enabled") {
                    p2p.send_network_message(&addr, msg);
                } else if crate::node::is_debug() {
                    println!("[DBG][P2P] light_owner_relay_unacked addr={} err={}", crate::unified_p2p::get_privacy_id_for_addr(&addr), e);
                }
            }
        });
    }
    
    /// v2.89: Get total registered Light node count
    pub fn get_light_node_count(&self) -> usize {
        let registry = self.light_node_registry.read();
        registry.len()
    }
    
    /// Register this node as active Super node and broadcast announcement (ASYNC)
    /// PRODUCTION: Use this in async contexts (warp handlers, tokio tasks)
    /// Called on startup and periodically (every 10 min)
    pub async fn register_as_active_node_async(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_str = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => return, // Light nodes don't register
        };
        
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(&self.node_id);
        
        // Only register if rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=low_rep rep={:.1} min={:.0}",
                         reputation, qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION);
            }
            return;
        }

        // v9.3: Don't register if more than 1 macroblock behind network.
        // Syncing nodes must not participate in consensus — they can be selected
        // as producer but can't produce, causing network stall.
        // The corroborated head, not the single highest claim: one node advertising a height nobody else holds
        // kept every other node out of the registry (04.10).
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        let network_height = self.corroborated_behind_head().unwrap_or_else(|| self.get_max_peer_height());
        if network_height > 90 && local_height + 90 < network_height {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=syncing local={} net={} gap={}",
                         local_height, network_height, network_height - local_height);
            }
            return;
        }

        // Register locally (v2.51: lock-free)
        self.active_full_super_nodes.insert(self.node_id.clone(), ActiveNodeInfo {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            last_seen: now,
            block_height: local_height,
        });
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] registered_async node={} type={} h={} total={}",
                     self.node_id, node_type_str, local_height, self.active_full_super_nodes.len());
        }
        
        // Sign with ASYNC Dilithium (proper quantum-resistant signature)
        let announcement_data = format!("active:{}:{}:{}:{}:{}", 
            self.node_id, node_type_str, self.shard_id, reputation as u64, now);
        let signature = match self.sign_dilithium_async(&announcement_data, &self.node_id).await {
            Some(sig) => sig,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][ACTIVE] announce_skip reason=dilithium_unavailable");
                }
                return; // Skip announcement if signing fails
            }
        };
        
        let msg = NetworkMessage::ActiveNodeAnnouncement {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            timestamp: now,
            signature,
            gossip_hop: 0,
        };

        // v9.2: Adaptive fan-out — sqrt(peers), min 3, max 8.
        // 5 peers → 3, 25 peers → 5, 64 peers → 8 (cap).
        // Combined with 3-hop re-gossip (fan-out 3 each), total propagation:
        //   hop0: sqrt(n) peers, hop1: ×3, hop2: ×3 = sqrt(n) × 9
        //   At 1000 nodes: ~32 × 9 = ~288 messages (vs 5 × 9 = 45 fixed).
        //   At 5 nodes: 3 × 9 = 27 (covers all, same as before).
        // This matches epidemic gossip theory: O(sqrt(n)) fan-out achieves
        // O(log n) propagation rounds with high probability.
        let peer_count = self.connected_peers_lockfree.len().max(1);
        let adaptive_fanout = ((peer_count as f64).sqrt().ceil() as usize).clamp(3, 8);
        self.gossip_to_random_peers(msg, adaptive_fanout);
    }

    /// F5: after each ping tick it completed, a genesis pinger tells the other four, straight and signed, that it
    /// pushes, naming its push schedule (`rpc::ping_tick_type`). Their owner liveness reads nothing else of it, so a
    /// genesis whose push loop stopped, that is behind the network, or whose provider answered none of its pushes five
    /// ticks in a row (the loop then skips this, `rpc::PushHealth`), is taken over within ten slots; the schedule tells
    /// the owner that takes a shard over, or the one it hands it back to, how the other pushed it (`foreign_draws`).
    pub async fn announce_ping_tick(&self) {
        if !is_genesis_pinger() { return; }
        let now = self.current_timestamp();
        let reputation = self.get_node_reputation_from_blockchain(&self.node_id);
        let node_type = crate::rpc::ping_tick_type(FIRST_PUSH_DRAW_WINDOW.load(std::sync::atomic::Ordering::Relaxed),
                                                   SPACED_ROUND_WINDOW.load(std::sync::atomic::Ordering::Relaxed));
        let data = format!("active:{}:{}:{}:{}:{}", self.node_id, node_type, self.shard_id, reputation as u64, now);
        let Some(signature) = self.sign_dilithium_async(&data, &self.node_id).await else {
            if crate::node::is_warn() {
                println!("[WARN][GENESIS-PING] ping_tick_unsigned reason=dilithium_unavailable");
            }
            return;
        };
        let msg = NetworkMessage::ActiveNodeAnnouncement {
            node_id: self.node_id.clone(),
            node_type,
            shard_id: self.shard_id,
            reputation,
            timestamp: now,
            signature,
            gossip_hop: crate::rpc::PING_TICK_HOP,
        };
        for idx in 0..5usize {
            if let Some(addr) = self.genesis_addr(idx) {
                self.send_network_message(&addr, msg.clone());
            }
        }
    }

    /// A ping tick another genesis sent (`announce_ping_tick`): taken only straight from that genesis, newer than its
    /// last and not too soon after it, before its signature is verified; never relayed, never in the active map. The
    /// push schedule it names (`schedule`, from `node_type`, which the signature covers) is kept for its sender.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn take_ping_tick(&self, from_peer: &str, node_id: &str, node_type: &str, schedule: Option<(u64, u64)>,
                                 shard_id: u8, reputation: f64, timestamp: u64, signature: &str) {
        let Some(idx) = crate::rpc::ping_tick_sender(node_id, from_peer) else {
            if crate::node::is_debug() {
                println!("[DBG][GENESIS-PING] ping_tick_refused node={} reason=not_direct", node_id);
            }
            return;
        };
        let now = self.current_timestamp();
        if Self::genesis_index(&self.node_id) == Some(idx) || !crate::rpc::OWNER_LIVENESS.tick_admissible(idx, timestamp, now) {
            return;
        }
        let data = format!("active:{}:{}:{}:{}:{}", node_id, node_type, shard_id, reputation as u64, timestamp);
        if !self.verify_dilithium_heartbeat_signature(&data, signature, node_id) {
            if crate::node::is_warn() {
                println!("[WARN][GENESIS-PING] ping_tick_sig_invalid node={}", node_id);
            }
            return;
        }
        crate::rpc::OWNER_LIVENESS.heard(idx, timestamp, now);
        if let Some(schedule) = schedule {
            crate::rpc::OWNER_SCHEDULES.learn(idx, schedule);
        }
    }

    /// Register this node as active Super node (SYNC version for std::thread::spawn)
    /// WARNING: Only use in pure sync contexts where NO tokio runtime exists!
    pub fn register_as_active_node(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_str = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => return, // Light nodes don't register
        };
        
        // Get current reputation
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(&self.node_id);
        
        // Only register if rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=low_rep rep={:.1} min={:.0}",
                         reputation, qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION);
            }
            return;
        }

        // v9.3: Don't register if syncing (>1 macroblock behind), read from the corroborated head.
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        let network_height = self.corroborated_behind_head().unwrap_or_else(|| self.get_max_peer_height());
        if network_height > 90 && local_height + 90 < network_height {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=syncing local={} net={} gap={}",
                         local_height, network_height, network_height - local_height);
            }
            return;
        }

        // Register locally (v2.51: lock-free)
        self.active_full_super_nodes.insert(self.node_id.clone(), ActiveNodeInfo {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            last_seen: now,
            block_height: local_height,
        });
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] registered node={} type={} h={} total={}",
                     self.node_id, node_type_str, local_height, self.active_full_super_nodes.len());
        }
        
        // Sign with SYNC Dilithium (creates new runtime - safe in std::thread::spawn)
        let announcement_data = format!("active:{}:{}:{}:{}:{}", 
            self.node_id, node_type_str, self.shard_id, reputation as u64, now);
        let signature = match self.sign_heartbeat_dilithium(&announcement_data, &self.node_id) {
            Some(sig) => sig,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][ACTIVE] announce_skip reason=dilithium_unavailable");
                }
                return; // Skip announcement if signing fails
            }
        };
        
        let msg = NetworkMessage::ActiveNodeAnnouncement {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            timestamp: now,
            signature,
            gossip_hop: 0,
        };

        // v9.2: Adaptive fan-out (same formula as async version)
        let peer_count = self.connected_peers_lockfree.len().max(1);
        let adaptive_fanout = ((peer_count as f64).sqrt().ceil() as usize).clamp(3, 8);
        self.gossip_to_random_peers(msg, adaptive_fanout);
    }

    /// Request active nodes list from peers (on startup)
    pub fn request_active_nodes_sync(&self) {
        let request = NetworkMessage::ActiveNodesRequest {
            requester_id: self.node_id.clone(),
        };
        self.gossip_to_random_peers(request, 3);
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] sync_request sent_to=3_peers");
        }
    }
    
    /// Update active nodes from heartbeat (proves node is online)
    #[allow(dead_code)]
    pub(super) fn update_active_nodes_from_heartbeat(&self, node_id: &str, node_type: &str, timestamp: u64) {
        // Get current reputation
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(node_id);
        
        // Only track nodes with rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            return;
        }
        
        // Calculate shard from node_id
        let shard_id = Self::calculate_light_node_shard(node_id);
        
        // v9.3: Get peer height for sync tracking
        let peer_height = self.connected_peers_lockfree.iter()
            .find(|e| e.value().id == node_id)
            .map(|e| e.value().last_block_height)
            .unwrap_or(0);

        // Update active nodes map (v2.51: lock-free)
        self.active_full_super_nodes.insert(node_id.to_string(), ActiveNodeInfo {
            node_id: node_id.to_string(),
            node_type: node_type.to_string(),
            shard_id,
            reputation,
            last_seen: timestamp,
            block_height: peer_height,
        });
    }
    
    /// v9.3: Cleanup stale active nodes (not seen in 15 minutes) + height-based + capacity cap
    pub fn cleanup_stale_active_nodes(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let cutoff = now - (15 * 60);  // 15 minutes ago
        // Liveness reference = the QC-verified finalized frontier (convergent — every healthy node
        // agrees on it), NOT the peer-height median. That median is biased up by the producer's
        // pre-finality tip (relay-raised onto every relaying peer), so an honest peer reporting its
        // applied tip read ~200 below it and was false-evicted. A peer at/above the finalized
        // frontier is caught up by construction; only one genuinely below finality trips the gate.
        let network_height = crate::node::qc_verified_frontier_cached();

        // v33: snapshot the LIVE connected-peer height per node_id (refreshed every
        // HealthPing, ~15s — the authoritative committed tip) BEFORE the retain, so we
        // never nest DashMap locks. The height-based eviction below uses
        // max(gossip_snapshot, live_height): active_full_super_nodes.block_height is a
        // gossip snapshot that lags badly (observed: snap h=2160 while the node was
        // really at the tip 3148) and false-evicted healthy nodes → active-set churn
        // and a quorum risk at scale. A genuinely-behind node still evicts because its
        // live height is also behind.
        // Only a FRESH, authenticated height counts. A gossip-inserted peer carries sentinel
        // last_block_height=0 / attested_at=0 until its own signed signal lands; judging it by that 0
        // false-evicts a healthy peer (a cold-joiner's genesis sources before the first HealthPing). So
        // a peer with no fresh attestation is "height unknown" (live_known=false) → skip its height test.
        let mut live_heights: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for e in self.connected_peers_lockfree.iter() {
            let p = e.value();
            if p.last_block_height == 0 { continue; }
            if now.saturating_sub(p.last_height_attested_at) > PEER_HEIGHT_ATTEST_TTL_SECS { continue; }
            let slot = live_heights.entry(p.id.clone()).or_insert(0);
            if p.last_block_height > *slot {
                *slot = p.last_block_height;
            }
        }

        // A node still catching up has no trustworthy first-hand peer heights and DEPENDS on its peers —
        // never height-evict while we are ourselves below the frontier (the 15-min last_seen TTL still
        // reaps genuinely dead peers). Closes the cold-join "evict all sources → stall" failure.
        // Only a node that is itself synchronized (per the coordinator FSM — the single sync-status
        // source) may height-evict a peer it measures behind; the bootstrap window is always exempt.
        let self_synced = network_height <= 180 || crate::node::coordinator_is_synchronized();

        // v2.51: Lock-free cleanup — stale by time
        let before = self.active_full_super_nodes.len();
        self.active_full_super_nodes.retain(|node_id, v| {
            // Remove if not seen in 15 minutes
            if v.last_seen <= cutoff {
                return false;
            }
            // Height-evict ONLY a node we directly measure (>2 macroblocks below the QC frontier).
            // Don't apply during bootstrap (network_height <= 180) or to self (async local height).
            // v33: judge by the freshest known height, not the lagging gossip snapshot.
            // A node known only via a relayed ActiveNodeAnnouncement is NOT in connected_peers, so it
            // has no first-hand height sample (live_known=false; its gossip block_height is 0 when the
            // announcer wasn't a direct peer). Judging it by that sentinel 0 would false-evict a
            // healthy super-node at scale, where most of the active set is reached only by gossip — so
            // skip the height test for it and let the 15-min last_seen TTL (refreshed by continued
            // announcements) reap it if it actually goes silent. A genuinely-stuck DIRECT peer
            // (live_known, low height) still evicts.
            // Genesis/bootstrap nodes are the anchored sync sources of last resort — never height-evict
            // them (the 15-min TTL above still reaps a genuinely dead one).
            if crate::genesis_constants::is_legacy_genesis_node(node_id) {
                return true;
            }
            let live_known = live_heights.contains_key(node_id);
            let live_h = live_heights.get(node_id).copied().unwrap_or(0);
            let effective_h = v.block_height.max(live_h);
            if self_synced && live_known && network_height > 180 && effective_h + 180 < network_height && *node_id != self.node_id {
                if crate::node::is_info() {
                    println!("[INFO][P2P] evict_desynced node={} snap={} live={} net={}", node_id, v.block_height, live_h, network_height);
                }
                return false;
            }
            true
        });
        let removed = before - self.active_full_super_nodes.len();

        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] removed {} stale/desynced active nodes", removed);
            }
        }

        // v9.0: Capacity cap to prevent unbounded memory growth at scale.
        // If still over limit after TTL eviction, evict oldest entries.
        const MAX_ACTIVE_NODES: usize = 10_000;
        let current_len = self.active_full_super_nodes.len();
        if current_len > MAX_ACTIVE_NODES {
            // Collect (key, last_seen) sorted by last_seen ascending
            let mut entries: Vec<(String, u64)> = self.active_full_super_nodes.iter()
                .map(|e| (e.key().clone(), e.value().last_seen))
                .collect();
            entries.sort_by_key(|e| e.1);

            let to_evict = current_len - MAX_ACTIVE_NODES;
            for (key, _) in entries.iter().take(to_evict) {
                self.active_full_super_nodes.remove(key);
            }
            if crate::node::is_warn() {
                println!("[WARN][CLEANUP] capacity_evict count={} cap={}", to_evict, MAX_ACTIVE_NODES);
            }
        }
    }
    
    /// Get count of active Super nodes (v2.51: lock-free)
    pub fn get_active_node_count(&self) -> usize {
        self.active_full_super_nodes.len()
    }
    
    /// Get list of active Super nodes with their status (v2.51: lock-free)
    /// Returns Vec<(node_id, node_type, last_seen)>
    pub fn get_active_full_super_nodes(&self) -> Vec<(String, String, u64)> {
        self.active_full_super_nodes.iter()
            .map(|entry| (entry.value().node_id.clone(), entry.value().node_type.clone(), entry.value().last_seen))
            .collect()
    }
    
    /// Byzantine-safe head ceiling: the (f+1)-th highest fresh last_block_height over CURRENTLY-connected
    /// in-set peers (round committee ∪ genesis). >=f+1 members attesting a height ⇒ >=1 honest ⇒ a real
    /// lower bound on the true tip, so stragglers cannot demote a tip the honest majority attests (a median
    /// would). 0 if <f+1 fresh corroborators ⇒ the clamp trusts raw (bootstrap/isolated). Self EXCLUDED
    /// (peer-only). SYNC-HINT oracle ONLY — sanctioned consumers: clamp_overclaim, the registration arm
    /// test (arm_deficit_exceeded: server arm gate and client submit), snapshot discovery's tip and the
    /// light ping loop's behind check — liveness hints only, never consensus/failover.
    pub fn corroborated_head_ceiling(&self) -> u64 {
        let corroborated = frontier_order_statistic(self.fresh_in_set_peer_heights());
        ceiling_with_own_tip(
            corroborated,
            LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// The head f+1 in-set nodes stand behind, this node's own tip counted as one of them: the (f+1)-th highest of
    /// {own tip} ∪ fresh in-set peer heights, f from the in-set size (committee ∪ genesis). None below f+1 values: then
    /// nothing can be corroborated and the caller keeps its old reading. SYNC-HINT ONLY, like the ceiling above.
    pub fn corroborated_behind_head(&self) -> Option<u64> {
        let n_inset = {
            let cc = CURRENT_COMMITTEE.read();
            cc.members.union(&cc.genesis_ids).count()
        };
        corroborated_head(
            LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed),
            self.fresh_in_set_peer_heights(),
            n_inset,
        )
    }

    // failover_frontier_ceiling REMOVED: the failover vote key is a pure function of the voter's
    // OWN verified chain + f+1 committee-signed window amplification — peer-claimed heights are
    // sync hints only and must never derive a consensus key (eclipse/staleness split honest votes).

    /// Fresh (attested within TTL) last_block_height of currently-connected in-set peers (committee ∪
    /// genesis). Shared builder for the head oracle, the failover frontier, and the production
    /// corroboration gate — a stale or unattested height must never be evidence we are at the tip.
    pub(crate) fn fresh_in_set_peer_heights(&self) -> Vec<u64> {
        let cc = CURRENT_COMMITTEE.read().clone();
        let now = self.current_timestamp();
        self.connected_peers_lockfree.iter()
            .filter(|e| {
                let p = e.value();
                let in_set = cc.members.contains(&p.id) || cc.genesis_ids.contains(&p.id)
                    || crate::genesis_constants::get_genesis_id_by_ip(p.addr.split(':').next().unwrap_or("")).is_some();
                in_set && p.last_block_height > 0
                    && now.saturating_sub(p.last_height_attested_at) < PEER_HEIGHT_ATTEST_TTL_SECS
            })
            .map(|e| peer_height_with_evidence(&e.value().id, e.value().last_block_height))
            .collect()
    }

    /// WIDENED head ceiling for the arm-liveness ladder ONLY. The newtype hard-quarantines the value:
    /// clamp_overclaim / get_best_peer_height / sync targeting / failover take u64 and CANNOT consume
    /// it by accident. Contributors are fresh connected NON-in-set peers (both link directions),
    /// Sybil-capped at ≤2 per /16 chosen by lexicographically-lowest peer id (not by height — the pick
    /// is not attacker-steerable), ≤16 total; each height is clamped to local_tip + DEFICIT_BOUND_WIDE
    /// + HEAD_OVERCLAIM_MARGIN before the order statistic (a HealthPing binds authorship, not truth —
    /// a tracking liar can otherwise defer the joiner forever). 0 if <4 capped contributors.
    pub fn corroborated_head_ceiling_widened(&self, local_tip: u64) -> WidenedCeiling {
        let cc = CURRENT_COMMITTEE.read().clone();
        let now = self.current_timestamp();
        let clamp = local_tip
            .saturating_add(DEFICIT_BOUND_WIDE)
            .saturating_add(HEAD_OVERCLAIM_MARGIN);
        let mut by_prefix: std::collections::BTreeMap<String, Vec<(String, u64)>> = std::collections::BTreeMap::new();
        for e in self.connected_peers_lockfree.iter() {
            let p = e.value();
            let ip = p.addr.split(':').next().unwrap_or("");
            let in_set = cc.members.contains(&p.id) || cc.genesis_ids.contains(&p.id)
                || crate::genesis_constants::get_genesis_id_by_ip(ip).is_some();
            if in_set { continue; } // strict oracle territory
            if p.last_block_height == 0
                || now.saturating_sub(p.last_height_attested_at) >= PEER_HEIGHT_ATTEST_TTL_SECS { continue; }
            let prefix = match extract_subnet_prefix(ip, 2) { Some(pfx) => pfx, None => continue };
            by_prefix.entry(prefix).or_default().push((p.id.clone(), p.last_block_height));
        }
        let mut contributors: Vec<u64> = Vec::new();
        'outer: for (_, mut peers) in by_prefix {
            peers.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, h) in peers.into_iter().take(2) {
                contributors.push(h.min(clamp));
                if contributors.len() >= 16 { break 'outer; }
            }
        }
        WidenedCeiling(frontier_order_statistic(contributors))
    }

    /// Tier-1.5 of the arm-liveness ladder: dial the EXACT strict-predicate set
    /// (CURRENT_COMMITTEE.members ∪ genesis_ids) so a starved joiner earns strict corroborators.
    /// NOT committee_for_height(tip) — a starved joiner's finality lags its tip, and epoch-skewed
    /// members are absent from the predicate ⇒ add zero corroborators. Salt-ranked, capped, skips
    /// already-connected; genesis IPs are the pinned always-present floor.
    pub fn dial_in_set_for_arm(&self) {
        const ARM_DIAL_K: usize = 16;
        let cc = CURRENT_COMMITTEE.read().clone();
        use sha3::{Digest, Sha3_256};
        let salt = { let mut h = Sha3_256::new(); h.update(self.node_id.as_bytes()); h.finalize() };
        let mut ranked: Vec<(u64, String)> = cc.members.iter().chain(cc.genesis_ids.iter())
            .filter(|id| **id != self.node_id)
            .map(|id| {
                let mut h = Sha3_256::new(); h.update(&salt); h.update(id.as_bytes());
                let d = h.finalize();
                (u64::from_le_bytes(d[0..8].try_into().unwrap_or([0u8; 8])), id.clone())
            })
            .collect();
        ranked.sort_by_key(|(k, _)| *k);
        let mut addrs: Vec<String> = Vec::new();
        for (_, id) in ranked {
            if addrs.len() >= ARM_DIAL_K { break; }
            if self.peer_id_to_addr.contains_key(&id) { continue; }
            let addr = if id.starts_with("genesis_node_") {
                match Self::resolve_genesis_node_address(&id) { Some(a) => a, None => continue }
            } else {
                match crate::genesis_constants::get_node_endpoint_ip(&id) { Some(ip) => format!("{}:8001", ip), None => continue }
            };
            if self.connected_peers_lockfree.contains_key(&addr) { continue; }
            addrs.push(addr);
        }
        if !addrs.is_empty() {
            if crate::node::is_info() {
                println!("[INFO][REG] arm_dial_in_set count={}", addrs.len());
            }
            self.connect_to_bootstrap_peers(&addrs);
        }
    }

    /// Anti-forgery CEILING for the height oracle (single source for get_best/get_max_peer_height): a
    /// verified head binds AUTHORSHIP not truth, so overrule a raw more than one macroblock above the
    /// (f+1)-corroborated tip — but NEVER below it (a stale-low median must not demote a tip the honest
    /// majority attests). ceiling==0 (bootstrap / no corroborator) => trust raw.
    pub fn clamp_overclaim(&self, raw: u64) -> u64 {
        let ceiling = self.corroborated_head_ceiling();
        if ceiling > 0 && raw > ceiling.saturating_add(HEAD_OVERCLAIM_MARGIN) {
            // Fires only on a demotion — lets a live replay tell "honest majority truly at ceiling"
            // from "a fresh-high tip was dropped".
            if crate::node::is_info() {
                println!("[WARN][ORACLE] overclaim_demote raw={} ceiling={} margin={}", raw, ceiling, HEAD_OVERCLAIM_MARGIN);
            }
            ceiling
        } else { raw }
    }

    /// v9.5: Highest reported height among connected peers — the tip oracle for the behind-decision,
    /// production-unlock and fork-resync, over-claim-clamped against the committee/genesis median.
    pub fn get_best_peer_height(&self) -> u64 {
        // Re-derived from what the peers say NOW (freshly attested table heights, fresh signed heads),
        // never from a monotone high-water: after the highest peers rolled back, the old maximum kept
        // every node "behind" a target nobody held and production stayed gated on all six.
        let now = self.current_timestamp();
        let table = best_of_attested(
            self.connected_peers_lockfree.iter()
                .map(|e| (e.value().last_block_height, e.value().last_height_attested_at)),
            now,
        );
        // Never below our own applied tip: the frontier is provably at least the chain we hold.
        let raw = table.max(signed_head_fresh_max(now))
            .max(LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed));
        BEST_PEER_HEIGHT.store(raw, std::sync::atomic::Ordering::Relaxed);
        self.clamp_overclaim(raw)
    }

    /// Re-sign LATEST_SIGNED_HEAD on finality advance so a cold-joiner's replied/co-sent head is fresh to
    /// within one rotation, not one 15s tick. Throttled (per-block Dilithium signing is wasted at scale);
    /// the 15s emit tick stays the backstop. height+sig kept consistent (verified over from:ts:height).
    pub fn refresh_signed_head_throttled(&self, height: u64) {
        if height == 0 || (height % HEAD_RESIGN_INTERVAL != 0 && height % 90 != 0) { return; }
        let id_guard = self.wallet_identity.read();
        let identity = match &*id_guard { Some(i) => i, None => return };
        let ts = self.current_timestamp();
        let payload = format!("QNET_HEALTH_PING_V1:{}:{}:{}", self.node_id, ts, height);
        if let Ok(sig) = identity.sign(payload.as_bytes()) {
            *LATEST_SIGNED_HEAD.write() = Some((self.node_id.clone(), ts, height, hex::encode(&sig)));
        }
    }

    /// v9.5: Recalculate BEST_PEER_HEIGHT from scratch by scanning all connected peers.
    /// Called when a peer disconnects (conditional: only if the disconnected peer's height
    /// was >= current BEST_PEER_HEIGHT). Also called periodically (every 30s) as safety net.
    /// O(N) where N = connected peers, but runs infrequently.
    pub fn recalculate_best_peer_height(&self) {
        // Follows the peers down as well as up; get_best_peer_height re-derives the same value.
        let now = self.current_timestamp();
        let new_best = best_of_attested(
            self.connected_peers_lockfree.iter()
                .map(|e| (e.value().last_block_height, e.value().last_height_attested_at)),
            now,
        ).max(signed_head_fresh_max(now));
        BEST_PEER_HEIGHT.store(new_best, std::sync::atomic::Ordering::Relaxed);
    }

    /// Get node reputation by ID
    /// DEPRECATED: Use get_node_reputation_from_blockchain() instead
    #[deprecated(note = "Use get_node_reputation_from_blockchain() for v2.21.5+")]
    pub fn get_node_reputation(&self, node_id: &str) -> f64 {
        // v2.21.5: Redirect to blockchain source
        self.get_node_reputation_from_blockchain(node_id)
    }
    
    /// Cleanup old attestations (older than 24 hours)
    pub fn cleanup_old_attestations(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let cutoff = now - (24 * 60 * 60);  // 24 hours ago
        
        let mut attestations = self.light_node_attestations.write();
        let before = attestations.len();
        attestations.retain(|_, v| v.timestamp > cutoff);
        let removed = before - attestations.len();
        
        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] Removed {} old attestations (>24h)", removed);
            }
        }
    }
    
    // ========================================================================
    // PRODUCTION: Methods for reward calculation (used by block producer)
    // ========================================================================
    
    /// Get all Light node attestations for a 4h window (for Merkle commitment)
    /// Returns Vec<(light_node_id, slot, pinger_id, timestamp)>
    /// DEPRECATED: Use get_attestations_for_block_range for deterministic emission
    pub fn get_attestations_for_window(&self, window_start_timestamp: u64) -> Vec<(String, u64, String, u64)> {
        let window_end = window_start_timestamp + (4 * 60 * 60);
        
        let attestations = self.light_node_attestations.read();
        attestations.values()
            .filter(|a| a.timestamp >= window_start_timestamp && a.timestamp < window_end)
            .map(|a| (a.light_node_id.clone(), a.slot, a.pinger_id.clone(), a.timestamp))
            .collect()
    }
    
    /// v2.64: Get Light node attestations filtered by BLOCK HEIGHT (deterministic!)
    /// Returns Vec<(light_node_id, slot, pinger_id, timestamp, block_height)>
    pub fn get_attestations_for_block_range(&self, start_height: u64, end_height: u64) -> Vec<(String, u64, String, u64, u64)> {
        let attestations = self.light_node_attestations.read();
        
        let result: Vec<_> = attestations.values()
            .filter(|a| a.block_height >= start_height && a.block_height < end_height)
            .map(|a| (a.light_node_id.clone(), a.slot, a.pinger_id.clone(), a.timestamp, a.block_height))
            .collect();
        
        // v2.95: Only log when there are attestations (avoid spam when no Light nodes)
        if !result.is_empty() && crate::node::is_info() {
            println!("[INFO][ATTESTATION] block_range_filter start={} end={} found={}", 
                     start_height, end_height, result.len());
        }
        
        result
    }
    
    /// v2.78: Get ALL ACTIVE registered Light node IDs for pinging
    /// FILTERS OUT:
    /// - Offline nodes (is_active=false, consecutive_failures>=5)
    /// - Ensures 100% coverage of ONLINE Light nodes only
    /// Returns Vec of active Light node IDs currently in registry
    pub fn get_all_light_node_ids(&self) -> Vec<String> {
        let registry = self.light_node_registry.read();
        registry.values()
            .filter(|node| {
                // PRODUCTION: Only active nodes
                // Offline nodes (>5 consecutive failures) are excluded
                node.is_active && node.consecutive_failures < 5
            })
            .map(|node| node.node_id.clone())
            .collect()
    }
    

    /// Is `node_id` in THIS genesis's shard? Stable hash-shard (crate::node::light_shard_of) — O(1),
    /// roster-size-INDEPENDENT, no cache: a node's shard never changes as the roster grows, so record-time
    /// and bitmap-build-time always agree. Non-genesis ⇒ false (its eligibility feeds no committed bitmap).
    pub(super) fn node_in_my_shard_for_epoch(&self, _epoch: u64, node_id: &str) -> bool {
        let idx = match std::env::var("QNET_BOOTSTRAP_ID").ok()
            .filter(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .and_then(|id| id.parse::<usize>().ok())
        {
            Some(n) => n.saturating_sub(1),
            None => return false,
        };
        // Every shard this node OWNS, primary or backup. A backup that recorded nothing could only
        // ever commit an empty bitmap for the shard it is meant to cover, which is no cover at all.
        // Memory cost is three fifths of the registry instead of one fifth, and only on genesis nodes.
        crate::node::light_owner_rank(crate::node::light_shard_of(node_id), idx).is_some()
    }

    /// Record an attested light node into the per-epoch eligibility set (uncapped) + prune old epochs.
    /// `answered_at` is the attestation's own stamp (the pinger's), kept with the persisted row: the status
    /// reports it as the node's last answer.
    pub(super) fn record_light_epoch_eligible(&self, block_height: u64, light_node_id: &str, answered_at: u64) {
        const EPOCH_BLOCKS: u64 = 14400;
        let epoch = block_height / EPOCH_BLOCKS;
        let (inserted, new_epoch) = {
            let mut map = self.epoch_light_eligible.write();
            let new_epoch = !map.contains_key(&epoch);
            let inserted = map.entry(epoch).or_default().insert(light_node_id.to_string());
            if map.len() > 3 {
                let keep_from = epoch.saturating_sub(2);
                map.retain(|e, _| *e >= keep_from);
            }
            (inserted, new_epoch)
        };
        // Persist for genesis restart resilience (bitmap is built from RAM); prune old persisted epochs
        // only on the first attestation of a new epoch — O(roster) once/epoch, not per ping.
        if inserted {
            if let Some(storage) = crate::node::try_get_storage() {
                let _ = storage.save_light_epoch_eligible(epoch, light_node_id, answered_at);
                if new_epoch { let _ = storage.prune_light_epoch_eligible(epoch.saturating_sub(2)); }
            }
        }
    }

    /// Boot rebuild of the per-epoch light-eligibility map from storage (genesis restart resilience):
    /// without it a restart drops a shard's pre-restart attestations before the boundary bitmap TX.
    pub fn rebuild_light_eligible_from_storage(&self, current_height: u64) {
        let from_epoch = (current_height / 14400).saturating_sub(2);
        if let Some(storage) = crate::node::try_get_storage() {
            if let Ok(entries) = storage.load_light_epoch_eligible(from_epoch) {
                if entries.is_empty() { return; }
                let n = entries.len();
                let mut map = self.epoch_light_eligible.write();
                for (epoch, node_id) in entries { map.entry(epoch).or_default().insert(node_id); }
                drop(map);
                if crate::node::is_info() {
                    println!("[INFO][LIGHT-BITMAP] epoch_eligible_rebuilt entries={} from_epoch={}", n, from_epoch);
                }
            }
        }
    }

    /// All light node_ids attested in `epoch` (uncapped union of received + gossiped pings).
    pub fn get_light_eligible_for_epoch(&self, epoch: u64) -> Vec<String> {
        self.epoch_light_eligible.read().get(&epoch)
            .map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// Get eligible Light nodes for rewards in current window
    /// Returns Vec<(node_id, wallet_address)> for nodes with at least 1 attestation
    /// DEPRECATED: Use get_eligible_light_nodes_by_height for deterministic emission
    pub fn get_eligible_light_nodes(&self, window_start_timestamp: u64) -> Vec<(String, String)> {
        let attestations = self.get_attestations_for_window(window_start_timestamp);
        let registry = self.light_node_registry.read();
        
        // Dedupe by node_id (only need 1 attestation per Light node)
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut eligible = Vec::new();
        
        for (node_id, _, _, _) in attestations {
            if seen.insert(node_id.clone()) {
                if let Some(reg) = registry.get(&node_id) {
                    eligible.push((node_id, reg.wallet_address.clone()));
                }
            }
        }
        
        eligible
    }
    
    /// v2.64: Get eligible Light nodes by BLOCK HEIGHT (deterministic!)
    pub fn get_eligible_light_nodes_by_height(&self, start_height: u64, end_height: u64) -> Vec<(String, String)> {
        let attestations = self.get_attestations_for_block_range(start_height, end_height);
        let registry = self.light_node_registry.read();
        
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut eligible = Vec::new();
        
        for (node_id, _, _, _, _) in attestations {
            if seen.insert(node_id.clone()) {
                if let Some(reg) = registry.get(&node_id) {
                    eligible.push((node_id.clone(), reg.wallet_address.clone()));
                }
            }
        }
        
        if crate::node::is_info() {
            println!("[INFO][LIGHT_ELIGIBILITY] block_range h={}-{} eligible={}", 
                     start_height, end_height, eligible.len());
        }
        
        eligible
    }
    
    /// Get Light node wallet address from registry
    pub fn get_light_node_wallet(&self, node_id: &str) -> Option<String> {
        let registry = self.light_node_registry.read();
        registry.get(node_id).map(|r| r.wallet_address.clone())
    }
}

#[cfg(test)]
mod tests_attestation_dedup {
    use super::*;

    fn epoch_now() -> u64 { SimplifiedP2P::get_current_window_number() }

    fn attestation(id: &str, slot: u64) -> LightNodeAttestation {
        LightNodeAttestation {
            light_node_id: id.to_string(),
            pinger_id: "genesis_node_001".to_string(),
            slot,
            timestamp: 1_700_000_000,
            light_node_signature: "device_sig".to_string(),
            pinger_signature: "pinger_sig".to_string(),
            challenge: "challenge".to_string(),
            block_height: LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// The dedupe read has to find what the write put there. It did not: the write keyed
    /// {id}:{slot}:{epoch} through attestation_key while this read rolled {id}:{slot} by hand, so a
    /// device that had already answered read back as unattested - a backup owner pinged it a second
    /// time and the challenge endpoint handed it another challenge for the rest of the slot. Asserted
    /// through the public reader, so writer and reader can only agree by sharing the one builder.
    #[test]
    fn an_answered_node_reads_back_as_attested_in_that_slot() {
        let p2p = SimplifiedP2P::new("test_attest_node".into(), NodeType::Super, Region::Europe, 8101);
        let (id, slot) = ("light_attest_0001", 137u64);

        assert!(!p2p.has_attestation(id, slot), "nothing stored yet");

        // The key stamps the epoch of LOCAL_BLOCKCHAIN_HEIGHT, a process global other tests in this
        // binary move under us (serve_horizon_follows_stored_height parks it three epochs away behind
        // a lock private to its own module). A write and a read that saw different epochs prove
        // nothing either way, so assert only across a window in which that reading held still.
        let mut proven = false;
        for _ in 0..64 {
            let before = epoch_now();
            p2p.store_attestation(attestation(id, slot));
            let found = p2p.has_attestation(id, slot);
            if epoch_now() == before {
                assert!(found, "the reader must find the key the writer produced");
                proven = true;
                break;
            }
        }
        assert!(proven, "the height global never held still long enough to assert");

        // Scoped to the one slot and the one device: every other ping opportunity stays open.
        assert!(!p2p.has_attestation(id, slot + 1), "the next slot is a fresh ping, not a suppressed one");
        assert!(!p2p.has_attestation("light_attest_0002", slot), "another device is not covered by it");
    }
}

#[cfg(test)]
mod tests_ping_slot_index {
    use super::*;

    /// A node admitted between rebuilds must be pingable in its slot without a rebuild. The index was
    /// keyed on the registry SIZE, so one registration rebuilt all 240 buckets - at ten million light
    /// nodes, ten million id clones under the read lock, on a loop that runs every slot.
    #[test]
    fn a_node_admitted_between_rebuilds_lands_in_its_slot() {
        let ids: Vec<String> = (0..40).map(|i| format!("light_{:04}", i)).collect();
        let window = 47u64;

        // Every shard covered: every id is placed, each in the slot the ping loop will read.
        let mut buckets: Vec<Vec<String>> = vec![Vec::new(); 240];
        assert_eq!(index_new_light_nodes(&mut buckets, ids.clone(), window, 0b11111), ids.len());
        for id in &ids {
            let s = SimplifiedP2P::calculate_randomized_slot(id, window) as usize;
            assert!(buckets[s].contains(id), "{} missing from slot {}", id, s);
        }

        // One shard covered: exactly that shard's ids belong to our buckets, and nothing else.
        let expect = ids.iter().filter(|id| crate::node::light_shard_of(id) == 0).count();
        assert!(expect > 0 && expect < ids.len(), "the fixture must exercise both sides");
        let mut only_shard0: Vec<Vec<String>> = vec![Vec::new(); 240];
        assert_eq!(index_new_light_nodes(&mut only_shard0, ids.clone(), window, 0b00001), expect);

        // The slot is re-randomised per window on purpose, which is why a window roll is the one
        // thing that still costs a full pass.
        let moved = ids.iter().filter(|id|
            SimplifiedP2P::calculate_randomized_slot(id, window)
                != SimplifiedP2P::calculate_randomized_slot(id, window + 1)).count();
        assert!(moved > 0, "a new window must move slots, or rebuilding on one would be pointless");
    }

    /// Guard against reintroduction: the rebuild keys on what the slot is DERIVED from, never on how
    /// many entries the registry happens to hold.
    #[test]
    fn the_slot_index_is_not_rebuilt_on_a_size_change() {
        let src = include_str!("propagation.rs");
        let cond = src.split("let need_rebuild = {").nth(1).expect("the rebuild condition")
            .split('}').next().expect("its body");
        assert!(cond.contains("current_window"), "a window roll re-randomises every slot");
        assert!(cond.contains("covered_mask"), "a shard takeover changes which ids are ours");
        let size_term = format!("reg{}", "_len");
        assert!(!cond.contains(&size_term), "keying on the registry size rebuilds 240 buckets per registration");
    }

    /// At one slot per tick a tick reads exactly the grace slots, as before; at any faster pace up to the
    /// bound it still reads every slot it passed, and a window entered from the previous one from slot 0.
    #[test]
    fn a_ping_tick_reads_every_slot_it_passed() {
        let w = 240 * 6;
        assert_eq!(ping_buckets_to_read(Some(w + 99), w + 100), (vec![100, 99, 98], 0));
        for step in [1u64, 2, 3, 5, 9, MAX_PING_CATCHUP_SLOTS] {
            let (mut read, mut last, mut now) = (vec![false; 240], None, w - 100);
            while now < w + 240 {
                let (buckets, gap) = ping_buckets_to_read(last, now);
                assert_eq!(gap, 0, "step {} is within the bound", step);
                if now >= w { for s in buckets { read[s] = true; } }
                last = Some(now);
                now += step;
            }
            let top = (last.unwrap() - w) as usize;
            assert!(read[..=top].iter().all(|r| *r), "step {}: a slot of the window went unread", step);
        }
    }

    /// A first tick or a rollback has nothing to catch up, and a gap past the bound is a loop behind the
    /// tip: each reads only the grace slots. Slot 0 still wraps onto the window's last two buckets.
    #[test]
    fn a_ping_tick_without_continuity_reads_only_the_grace_slots() {
        let now = 240 * 9 + 50;
        assert_eq!(ping_buckets_to_read(None, now), (vec![50, 49, 48], 0), "first tick");
        assert_eq!(ping_buckets_to_read(Some(now + 4), now), (vec![50, 49, 48], 0), "rollback");
        assert_eq!(ping_buckets_to_read(Some(now), now), (vec![50, 49, 48], 0), "no slot passed");
        let far = MAX_PING_CATCHUP_SLOTS + 1;
        assert_eq!(ping_buckets_to_read(Some(now - far), now), (vec![50, 49, 48], far), "gap past the bound");
        assert_eq!(ping_buckets_to_read(None, 240 * 9), (vec![0, 239, 238], 0), "slot 0 wraps");
    }

    /// From the switch window a reply to the last push of the last slot a node can draw, sent while its
    /// challenge still lives, lands before the owner builds the epoch bitmap; before it the full range
    /// stays, so a restart re-draws nothing.
    #[test]
    fn every_ping_slot_and_its_grace_end_before_the_commit_window() {
        let before = BOUNDED_SLOT_DRAW_FROM_WINDOW - 1;
        let top_before = (0..5_000)
            .map(|i| SimplifiedP2P::calculate_randomized_slot(&format!("light_{:05}", i), before))
            .max().unwrap();
        assert!((235..240).contains(&top_before), "window {} still draws all 240 slots", before);
        for window in [BOUNDED_SLOT_DRAW_FROM_WINDOW, BOUNDED_SLOT_DRAW_FROM_WINDOW + 1, 4096] {
            let opens_at = 14_400 - crate::node::light_commit_window(window);
            let top = (0..5_000)
                .map(|i| SimplifiedP2P::calculate_randomized_slot(&format!("light_{:05}", i), window))
                .max().unwrap();
            let ttl = crate::rpc::LIGHT_CHALLENGE_TTL_SECS;
            assert!((top + 3) * 60 + ttl <= opens_at, "window {}: a reply to slot {}'s last push can land after the bitmap is built", window, top);
            assert_eq!(top + 3 + ttl.div_ceil(60), opens_at / 60, "window {}: the draw uses every slot that fits", window);
        }
    }

    /// P-1: from the window armed for the spaced rounds the first push falls in the epoch's first 138 slots, and the
    /// retry round's last repeat, with its grace and a push's whole minute, ends at least five minutes before the commit.
    /// In a window armed only for the early draw (the one a genesis switches in) the first 168 slots, whose retry round of
    /// three a slot apart ends as early. The windows before keep the draw they began with.
    #[test]
    fn the_first_push_is_drawn_early_and_the_retry_round_ends_before_the_commit() {
        use crate::rpc::{DUE_GRACE_SLOTS, FIRST_PUSH_SLOTS, RETRY_AFTER_SLOTS, ROUND_PUSHES, ROUND_SPACING_SLOTS};
        let (from, spaced) = (4_000u64, 4_002u64);
        assert_eq!(ping_draw_slots(spaced, from, spaced), FIRST_PUSH_SLOTS);
        assert_eq!(ping_draw_slots(spaced + 1, from, spaced), FIRST_PUSH_SLOTS);
        assert_eq!(ping_draw_slots(spaced - 1, from, spaced), crate::rpc::UNSPACED_FIRST_PUSH_SLOTS, "the early draw until the spaced window");
        assert_eq!(ping_draw_slots(from - 1, from, spaced), 240 - 3 - 2 - 3, "the bounded draw until the armed window");
        assert_eq!(ping_draw_slots(BOUNDED_SLOT_DRAW_FROM_WINDOW - 1, from, spaced), 240);
        assert_eq!(ping_draw_slots(from, u64::MAX, u64::MAX), 232, "never armed: the bounded draw");
        assert_eq!(ping_draw_slots(from, from, from), FIRST_PUSH_SLOTS, "both armed at once: a genesis that never pinged before");
        assert_eq!(FIRST_PUSH_SLOTS, 138);
        // The earlier of the two commit openings, whatever the gate: 150 blocks before the epoch's end.
        let opens_at = 14_400 - crate::node::light_commit_window(spaced).max(150);
        // (window, the last push's offset from the drawn slot): the spaced retry round's last repeat and its grace; the
        // retry round of three a slot apart, each slot a due point of its own.
        let last_spaced = RETRY_AFTER_SLOTS + (ROUND_PUSHES - 1) * ROUND_SPACING_SLOTS + DUE_GRACE_SLOTS;
        for (window, last_offset) in [(spaced, last_spaced), (from, RETRY_AFTER_SLOTS + ROUND_PUSHES - 1)] {
            let draw = ping_draw_slots(window, from, spaced);
            let slots: Vec<u64> = (0..20_000)
                .map(|i| SimplifiedP2P::slot_in_draw(&format!("light_{:05}", i), window, draw))
                .collect();
            let top = *slots.iter().max().unwrap();
            assert_eq!(top, draw - 1, "window {window}: every early slot is used");
            assert!(slots.iter().filter(|s| **s < draw / 2).count() > 9_000, "window {window}: spread over the range");
            let last = top + last_offset;
            assert_eq!(last, 229, "window {window}: the schedule's last push is in slot 229");
            assert!((last + 1) * 60 + 300 <= opens_at, "window {window}: the last push leaves five minutes before the commit");
        }
        // The same id and window keep their slot: the draw is a function of both, nothing else.
        assert_eq!(SimplifiedP2P::slot_in_draw("light_x", 7, 232), SimplifiedP2P::slot_in_draw("light_x", 7, 232));
        // Arming names the windows the early draw and the spaced rounds start at, once (a window no other test reaches).
        SimplifiedP2P::arm_push_schedule(None, None);
        SimplifiedP2P::arm_push_schedule(Some(u64::MAX - 2), Some(u64::MAX - 2));
        SimplifiedP2P::arm_push_schedule(Some(6), Some(6));
        assert_eq!(FIRST_PUSH_DRAW_WINDOW.load(std::sync::atomic::Ordering::Relaxed), u64::MAX - 2, "armed once, at the first call");
        assert_eq!(SPACED_ROUND_WINDOW.load(std::sync::atomic::Ordering::Relaxed), u64::MAX - 2, "armed once, at the first call");
        assert!(!spaced_rounds_in(4096) && spaced_rounds_in(u64::MAX - 2));
        assert_eq!(SimplifiedP2P::calculate_randomized_slot("light_x", 4096), SimplifiedP2P::slot_in_draw("light_x", 4096, 232));
    }

    /// G-1: every push of a node's epoch - with the spaced rounds its first push, the repeats 15 and 30 slots on and the
    /// retry round of three an hour after the drawn slot, each due point with its grace; in the window a genesis switches
    /// in, the round of three a slot apart and its retry round - is read on the regular tick at exactly those slots, and
    /// leaves with five minutes left for its delivery and answer before the epoch's commit, whatever slot the node drew,
    /// whichever owner rank sends it and wherever in its minute the tick and the pacer put it. The epoch still drawn over
    /// the bounded range keeps its own: its round's last push leaves more than a minute before the commit. A tick
    /// catching up after a stall may read a slot later, and the lifetime rule lets nothing out at or after the commit,
    /// nor with less than its floor left.
    #[test]
    fn every_push_repeat_and_retry_leaves_before_the_commit() {
        use crate::rpc::{DUE_GRACE_SLOTS, FIRST_PUSH_SLOTS, RETRY_AFTER_SLOTS, ROUND_PUSHES, UNSPACED_FIRST_PUSH_SLOTS};
        // No owner rank waits before it pushes: a backup that covers a shard pushes at once (its ranks above are
        // silent by then), so the schedule is the same at every rank.
        assert!(!include_str!("../rpc/light_nodes.rs").contains("get_ping_delay"), "no backup wait");
        let backup = 0u64;
        let paced = crate::rpc::PACE_WINDOW_US.div_ceil(1_000_000);
        let (round, retry) = (ROUND_PUSHES, RETRY_AFTER_SLOTS);
        // The slots a node drawn at s is read in: each due point and its grace; before the spaced rounds each slot of a
        // round, a due point of its own.
        let spaced_reads = |s: u64| -> Vec<u64> {
            crate::rpc::spaced_due_offsets().flat_map(|(o, _)| (0..=DUE_GRACE_SLOTS).map(move |g| s + o + g)).collect()
        };
        let unspaced_reads = |s: u64| -> Vec<u64> { (0..round).map(|i| s + i).chain((0..round).map(|i| s + retry + i)).collect() };
        for window in [4_000u64, 4_096] {
            // The earlier of the two commit openings, whatever the gate: 150 blocks before the epoch's end.
            let commit = 14_400 - crate::node::light_commit_window(window).max(150);
            let base = window * 240;
            let read_in = |s: u64, spaced: bool| -> Vec<u64> {
                (0..240u64).filter(|t| {
                    push_reads(t.checked_sub(1).map(|p| base + p), base + t, spaced, None).0.iter().any(|r| r.bucket == s as usize)
                }).collect()
            };
            for (draw, spaced) in [(FIRST_PUSH_SLOTS, true), (UNSPACED_FIRST_PUSH_SLOTS, false)] {
                let mut last = 0u64;
                for s in 0..draw {
                    let reads = read_in(s, spaced);
                    let want = if spaced { spaced_reads(s) } else { unspaced_reads(s) };
                    assert_eq!(reads, want, "window {window}, slot {s}, spaced {spaced}: a round of three and a retry round of three");
                    let t = *reads.last().unwrap();
                    // The tick may fire at the slot's last second; then the pacer.
                    let leaves = (t + 1) * 60 + backup + paced;
                    assert!(leaves + 300 <= commit, "slot {s}: its last push leaves at block {leaves}, the commit opens at {commit}");
                    last = last.max(t);
                }
                assert_eq!(last, 229, "spaced {spaced}: the schedule's last push is in slot 229");
            }
            // The bounded draw, rounds a slot apart: the round's last push leaves more than a minute before the commit; a
            // retry round drawn late is left to the lifetime rule below.
            let opens = crate::rpc::commit_opens_at(window) - window * 14_400;
            for s in 0..ping_draw_slots(window, u64::MAX, u64::MAX) {
                let reads = read_in(s, false);
                assert_eq!(reads[..3].to_vec(), vec![s, s + 1, s + 2], "bounded slot {s}");
                assert!((s + round) * 60 + backup + paced + 60 < opens, "bounded slot {s}: the round's last push");
            }
            // A catch-up tick: whatever it reads, no push leaves at or after the commit or under the floor.
            let floor = crate::rpc::PUSH_MIN_LIFETIME_SECS;
            let e0 = window * 14_400;
            for h in [commit - floor - 1, commit - floor, commit - floor + 1, commit - 1, commit, 14_399] {
                let lives = crate::rpc::push_lifetime(window, e0 + h);
                assert_eq!(lives.is_some(), h + floor <= crate::rpc::commit_opens_at(window) - e0, "block {h}");
                assert!(lives.map_or(true, |l| e0 + h + l <= crate::rpc::commit_opens_at(window)), "it ends at the commit");
            }
        }
        assert!(backup <= 60 && paced <= 55);
    }

    /// R-a and P-1: a tick reads the grace slots, then the same slots an hour earlier; first pushes come first,
    /// and the retry read never wraps into the window's last slots.
    #[test]
    fn a_push_tick_reads_the_round_then_the_retry_round() {
        let w = 240 * 9;
        let retry = crate::rpc::RETRY_AFTER_SLOTS as usize;
        assert_eq!(push_buckets_to_read(Some(w + 99), w + 100), (vec![100, 99, 98, 100 - retry, 99 - retry, 98 - retry], 0));
        assert_eq!(push_buckets_to_read(None, w + 61), (vec![61, 60, 59, 1, 0], 0), "no wrap below slot 0");
        assert_eq!(push_buckets_to_read(None, w + 10), (vec![10, 9, 8], 0), "no retry before slot 60");
        assert_eq!(push_buckets_to_read(None, w), (vec![0, 239, 238], 0));
        // A catch-up tick reads both rounds of every slot passed.
        let (b, gap) = push_buckets_to_read(Some(w + 95), w + 100);
        assert_eq!(gap, 0);
        assert_eq!(b[..7].to_vec(), (94..=100).rev().collect::<Vec<usize>>());
        assert_eq!(b[7..].to_vec(), (94 - retry..=100 - retry).rev().collect::<Vec<usize>>());
        // Over one window at one slot a tick, a node drawn at slot s is read at s, s+1, s+2 and at s+60, s+61,
        // s+62: a round of three and a retry round of three.
        for s in [0usize, 59, 107, 167] {
            let reads: Vec<u64> = (0..240u64).filter(|t| {
                push_buckets_to_read(t.checked_sub(1).map(|p| w + p), w + t).0.contains(&s)
            }).collect();
            let s = s as u64;
            let want: Vec<u64> = [s, s + 1, s + 2, s + 60, s + 61, s + 62].into_iter().filter(|t| *t < 240).collect();
            assert_eq!(reads, want, "slot {s}");
        }
        // Before the spaced rounds every read is a due point of the tick's own slot alone.
        let (reads, gap) = push_reads(Some(w + 99), w + 100, false, None);
        assert_eq!((reads.iter().map(|r| r.bucket).collect::<Vec<_>>(), gap), push_buckets_to_read(Some(w + 99), w + 100));
        assert_eq!(push_reads(Some(w + 99), w + 100, false, Some(w + 99)).0, reads, "a restart's mark changes nothing here");
        assert!(reads.iter().all(|r| r.dues == vec![crate::rpc::Due::once(w + 100)]));
    }

    /// With the spaced rounds a tick reads each due point that came since the last tick with its grace: the drawn slots
    /// 0, 15, 30, 60, 75 and 90 slots back, first pushes first, the repeats marked with their round's first slot, never
    /// wrapping below slot 0; a bucket two due points reach in one catch-up tick is read once, with both, earliest first.
    /// After a restart whose tick joins the run before it, no due point that run read is read again.
    #[test]
    fn a_spaced_tick_reads_each_due_point_with_its_grace() {
        use crate::rpc::Due;
        let w = 240 * 9;
        let (reads, gap) = push_reads(Some(w + 99), w + 100, true, None);
        assert_eq!(gap, 0);
        let buckets: Vec<usize> = reads.iter().map(|r| r.bucket).collect();
        assert_eq!(buckets, vec![100, 99, 98, 85, 84, 83, 70, 69, 68, 40, 39, 38, 25, 24, 23, 10, 9, 8]);
        for (i, r) in reads.iter().enumerate() {
            let (g, offset_index) = ((i % 3) as u64, i / 3);
            let into_round = [0, 15, 30, 0, 15, 30][offset_index];
            assert_eq!(r.dues, vec![Due::spaced(w + 100 - g, into_round)], "bucket {}", r.bucket);
            assert_eq!(r.dues[0].round, w + r.bucket as u64 + [0, 0, 0, 60, 60, 60][offset_index], "bucket {}", r.bucket);
        }
        assert_eq!(push_reads(None, w + 10, true, None).0.iter().map(|r| r.bucket).collect::<Vec<_>>(), vec![10, 9, 8], "nothing before slot 0");
        assert_eq!(push_reads(None, w, true, None).0.iter().map(|r| r.bucket).collect::<Vec<_>>(), vec![0], "no wrap into the window's end");
        assert_eq!(push_reads(None, w + 16, true, None).0.iter().map(|r| r.bucket).collect::<Vec<_>>(), vec![16, 15, 14, 1, 0]);
        // A catch-up over 15 slots: the round's first push of slot 85 and its first repeat (due in slot 100) meet in
        // bucket 85, read once with both.
        let (reads, gap) = push_reads(Some(w + 85), w + 100, true, None);
        assert_eq!(gap, 0);
        let b85: Vec<&PushRead> = reads.iter().filter(|r| r.bucket == 85).collect();
        assert_eq!(b85.len(), 1);
        assert_eq!(b85[0].dues, vec![Due::spaced(w + 85, 0), Due::spaced(w + 100, 15)]);
        let mut seen = reads.iter().map(|r| r.bucket).collect::<Vec<_>>();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), reads.len(), "every bucket once");
        // A stall past the bound reads the grace slots only, as before.
        let (reads, gap) = push_reads(Some(w + 80), w + 100, true, None);
        assert_eq!(gap, 20);
        assert_eq!(reads.len(), 18);
        // The first tick after a restart whose run before read up to slot 99: only the due points of slot 100; the next
        // tick reads the grace of slot 101 down to slot 100, never 99 again.
        let (reads, _) = push_reads(Some(w + 99), w + 100, true, Some(w + 99));
        assert!(reads.iter().all(|r| r.dues.iter().all(|d| d.met_from + crate::rpc::MIN_PUSH_GAP_SLOTS - 1 == w + 100)));
        assert_eq!(reads.iter().map(|r| r.bucket).collect::<Vec<_>>(), vec![100, 85, 70, 40, 25, 10]);
        let (reads, _) = push_reads(Some(w + 100), w + 101, true, Some(w + 99));
        assert_eq!(reads.iter().map(|r| r.bucket).collect::<Vec<_>>(), vec![101, 100, 86, 85, 71, 70, 41, 40, 26, 25, 11, 10]);
        assert_eq!(push_reads(Some(w + 101), w + 102, true, Some(w + 99)).0, push_reads(Some(w + 101), w + 102, true, None).0,
                   "three slots on, nothing left to skip");
    }

    /// One genesis pushing one light shard in the tests: its push schedule (the windows its early draw and its spaced
    /// rounds start at), its ledger, what it read (`ShardReads`), the slot it last read in this process and the mark it
    /// keeps across a restart (`rpc::push_read_mark`). `tick` runs what the selection runs for the shard.
    struct SimOwner {
        me: usize,
        schedule: (u64, u64),
        ledger: crate::rpc::PushLedger,
        reads: ShardReads,
        last: Option<u64>,
        mark: Option<(u64, u64)>,
        /// Whether a shard another owner may have pushed earlier in the window is read under that owner's draw too.
        foreign: bool,
    }

    impl SimOwner {
        fn new(me: usize, schedule: (u64, u64)) -> Self {
            SimOwner { me, schedule, ledger: crate::rpc::PushLedger::new(), reads: ShardReads::new(), last: None, mark: None, foreign: true }
        }

        /// A restart: the ledger, the reads and the slot last read go; the mark stays.
        fn restart(&mut self) {
            self.ledger = crate::rpc::PushLedger::new();
            self.reads = ShardReads::new();
            self.last = None;
        }

        /// One tick at absolute slot `now` pushing `shard`, knowing the other owners' schedules as `known`:
        /// `bucket(draw, b)` the nodes (indices into `nodes`) drawn into bucket b under a draw, `counted` the
        /// selection's eligibility test and `outcome` what an offer came to. The nodes offered, in order.
        #[allow(clippy::too_many_arguments)]
        fn tick(&mut self, now: u64, shard: usize, known: [(u64, u64); 5], nodes: &[String],
                bucket: &dyn Fn(u64, usize) -> Vec<usize>, counted: &dyn Fn(usize) -> bool,
                outcome: &dyn Fn(usize) -> crate::rpc::SendOutcome) -> Vec<usize> {
            let (w, ws) = (now / 240, now / 240 * 240);
            let first_tick = self.last.is_none();
            let resumed = if first_tick { self.mark } else { None }
                .filter(|(l, _)| *l >= ws && *l < now && now - *l <= MAX_PING_CATCHUP_SLOTS);
            let last = if first_tick { resumed.map(|(l, _)| l) } else { self.last };
            if first_tick { self.reads.done = resumed.map(|(l, _)| l); }
            let (reads, gap) = push_reads(last, now, w >= self.schedule.1, self.reads.done);
            let mut seen: Vec<usize> = reads.iter().map(|r| r.bucket).collect();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(seen.len(), reads.len(), "slot {now}: a bucket read twice in one tick");
            let joined = last.is_some() && gap == 0;
            let first_due = match (resumed, last) {
                (Some((l, _)), _) => l + 1,
                (None, Some(l)) if joined && l < now => (l + 1).saturating_sub(crate::rpc::DUE_GRACE_SLOTS),
                _ => now.saturating_sub(crate::rpc::DUE_GRACE_SLOTS),
            }.max(ws);
            self.reads.advance(1 << shard, self.me, first_due, joined, resumed.map(|(_, r)| r));
            self.last = Some(now);
            self.mark = Some((now, self.reads.read_from[self.me]));
            let mut schedules = known;
            schedules[self.me] = self.schedule;
            let mut draws = vec![ping_draw_slots(w, self.schedule.0, self.schedule.1)];
            if self.foreign && self.reads.read_from[shard] > ws {
                draws.extend(foreign_draws(w, self.me, shard, &schedules));
            }
            let held = self.reads.held_from[shard];
            let mut offered: Vec<usize> = Vec::new();
            let mut once = std::collections::HashSet::new();
            for r in &reads {
                for d in &draws {
                    for i in bucket(*d, r.bucket) {
                        if !once.contains(&i) && self.ledger.may_push(&nodes[i], now, &r.dues, || held) {
                            once.insert(i);
                            offered.push(i);
                        }
                    }
                }
            }
            offered.retain(|i| !counted(*i));
            for i in &offered { self.ledger.record(&nodes[*i], now, outcome(*i), 1_800_000_000 + now); }
            offered
        }
    }

    /// One owner's pushes to a node drawn in slot `s` of window `w`, one tick at each slot of `ticks` (rising), each as
    /// the selection runs it (`SimOwner::tick`): skipped once `counted` says it is counted, asked of the ledger
    /// (`PushLedger::may_push`), and `outcome` of the slot recorded. At `restart` the genesis starts again: an empty ledger,
    /// its read mark kept. Every tick offers the node once at most. The slots a push, a challenge or a hold went out in.
    fn sim(w: u64, s: u64, spaced: bool, ticks: impl IntoIterator<Item = u64>, counted: impl Fn(u64) -> bool,
           outcome: impl Fn(u64) -> crate::rpc::SendOutcome, restart: Option<u64>) -> Vec<u64> {
        let schedule = if spaced { (0, 0) } else { (0, u64::MAX) };
        let mut o = SimOwner::new(0, schedule);
        let nodes = ["light_mobile_sim".to_string()];
        let mut sent = Vec::new();
        for t in ticks {
            if restart == Some(t) { o.restart(); }
            let (c, out) = (counted(t), outcome(t));
            let offered = o.tick(w * 240 + t, 0, [schedule; 5], &nodes, &|_, b| if b as u64 == s { vec![0] } else { vec![] },
                                 &|_| c, &|_| out);
            assert!(offered.len() <= 1, "slot {t}: the node offered {} times in one tick", offered.len());
            if !offered.is_empty() && out != crate::rpc::SendOutcome::Unsent { sent.push(t); }
        }
        sent
    }

    /// Owner decision of 06.10: the first push in the drawn slot, a repeat 15 slots later and a last one 30 slots
    /// later, each only while the node is not counted; the retry round the same from 60 slots after the drawn slot; one
    /// push a due point, MAX_PUSHES_PER_EPOCH at most, and none once the node is counted.
    #[test]
    fn a_round_is_three_pushes_fifteen_slots_apart_and_the_retry_round_an_hour_on() {
        use crate::rpc::SendOutcome::{Accepted, Failed, Gone, Polled};
        let w = 4_100u64;
        for s in [0u64, 1, 47, 89, 90, 120, 137] {
            let never = sim(w, s, true, 0..240, |_| false, |_| Accepted, None);
            assert_eq!(never, vec![s, s + 15, s + 30, s + 60, s + 75, s + 90], "slot {s}");
            assert_eq!(never.len(), crate::rpc::MAX_PUSHES_PER_EPOCH as usize);
            for round in [&never[..3], &never[3..]] {
                assert!(round.windows(2).all(|p| p[1] - p[0] == crate::rpc::ROUND_SPACING_SLOTS), "slot {s}: {round:?}");
            }
            assert!(*never.last().unwrap() <= 229);
            // A push that failed at the provider, or found the token gone, or a challenge left for a poll, went out too:
            // its due point is spent, and the next one tries again.
            for o in [Failed, Gone, Polled] {
                assert_eq!(sim(w, s, true, 0..240, |_| false, |_| o, None), never, "slot {s}: {o:?}");
            }
            // Counted after any push: nothing more in the epoch, of the round or of the retry round.
            for k in 1..=never.len() {
                let answered = never[k - 1] + 1;
                assert_eq!(sim(w, s, true, 0..240, |t| t >= answered, |_| Accepted, None), never[..k].to_vec(), "slot {s}, k {k}");
            }
            // Counted before the drawn slot (the app's own answer): no push at all.
            assert!(sim(w, s, true, 0..240, |t| t + 1 >= s, |_| Accepted, None).is_empty(), "slot {s}");
        }
        // The ledger alone holds the line too: once a node answered here (its entry gone) no repeat is due to it, and
        // a node never offered here gets no repeat; the round's first push and the retry round's are due to anyone.
        let l = crate::rpc::PushLedger::new();
        let base = w * 240 + 40;
        assert!(l.may_push("light_a", base, &[crate::rpc::Due::spaced(base, 0)], || 0));
        assert!(!l.may_push("light_a", base + 15, &[crate::rpc::Due::spaced(base + 15, 15)], || 0), "never offered here");
        l.record("light_a", base, Accepted, 1);
        assert!(!l.may_push("light_a", base + 1, &[crate::rpc::Due::spaced(base, 0)], || 0), "one push a due point");
        assert!(l.may_push("light_a", base + 15, &[crate::rpc::Due::spaced(base + 15, 15)], || 0));
        l.answered("light_a");
        assert!(!l.may_push("light_a", base + 15, &[crate::rpc::Due::spaced(base + 15, 15)], || 0), "answered here");
        // A round begun before this genesis held the shard's records (a restart, a takeover): its repeat is due to a
        // node it has no record of; a round begun after, not.
        assert!(l.may_push("light_b", base + 15, &[crate::rpc::Due::spaced(base + 15, 15)], || base + 1), "held since after its round began");
        assert!(!l.may_push("light_b", base + 15, &[crate::rpc::Due::spaced(base + 15, 15)], || base), "held since its round began");
        // The selection skips a counted node before anything is read, and the pinger checks again right before it sends.
        let src = include_str!("propagation.rs");
        let sel = &src[src.find("pub(crate) fn get_light_nodes_to_ping(&self, tip: u64)").unwrap()..];
        let sel = &sel[..sel.find("fn maybe_pull_push_channel").unwrap()];
        let ledger = sel.find("crate::rpc::PUSH_LEDGER.may_push(id, now_slot, &r.dues, || held_from(id))").expect("the ledger in RAM");
        let elig = sel.find("let elig = self.epoch_light_eligible.read();").expect("the eligibility lock");
        assert!(ledger < elig, "the ledger is read before the eligibility lock is taken");
        assert!(elig < sel.find("if this_epoch(node_id) { continue; }").unwrap());
        assert!(sel.find("if this_epoch(node_id) { continue; }").unwrap() < sel.find("crate::rpc::push_reach_at(").unwrap());
        assert!(sel.contains("spaced_rounds_in(current_window)"));
        // The registry's lock is not held while the ledger is read: dropped before, taken again after.
        let regained = sel.rfind("let registry = self.light_node_registry.read();").unwrap();
        let released = sel[..ledger].rfind("drop(registry);").expect("released before the ledger");
        assert!(!sel[released..ledger].contains("light_node_registry") && ledger < regained && regained < elig);
        // No writer of the registry waits on the slot index: a full queue only marks it stale.
        let queue = &src[src.find("fn queue_for_ping_index(&self, id: String)").unwrap()..];
        let queue = &queue[..queue.find("q.push(id);").unwrap()];
        assert!(!queue.contains("light_ping_slot_cache") && queue.contains("SLOT_INDEX_STALE.store(true"));
    }

    /// A push that found no instant in its slot is tried in the next slots of its due point, and a tick a short stall
    /// missed is caught up, but one push at most goes out for a due point, and none closer than MIN_PUSH_GAP_SLOTS to the
    /// last: a push a catch-up made late meets the next due point when that one is nearer.
    #[test]
    fn a_shed_push_or_a_missed_tick_is_tried_again_within_its_due_point_once() {
        use crate::rpc::SendOutcome::{Accepted, Unsent};
        let (w, s) = (4_100u64, 40u64);
        let all = |_: u64| false;
        // Shed in the drawn slot: out in the next, and the repeat still 15 slots after the drawn slot.
        assert_eq!(sim(w, s, true, 0..240, all, |t| if t == s { Unsent } else { Accepted }, None),
                   vec![s + 1, s + 15, s + 30, s + 60, s + 75, s + 90]);
        // The retry round's push shed twice goes out in the last slot of its grace.
        assert_eq!(sim(w, s, true, 0..240, all, |t| if t == s + 60 || t == s + 61 { Unsent } else { Accepted }, None),
                   vec![s, s + 15, s + 30, s + 62, s + 75, s + 90]);
        // Shed in every slot of its grace: no push for that due point, and the next one tries (the node is held here).
        assert_eq!(sim(w, s, true, 0..240, all, |t| if (s..=s + 2).contains(&t) { Unsent } else { Accepted }, None),
                   vec![s + 15, s + 30, s + 60, s + 75, s + 90]);
        // Shed at every slot: nothing goes out, ever (`not_sent`), and the node is still offered once a tick.
        assert!(sim(w, s, true, 0..240, all, |_| Unsent, None).is_empty());
        // A stall that missed the drawn slot's tick: the next tick sends it, and the repeat keeps its slot.
        let ticks = |skip: std::ops::Range<u64>| (0..240u64).filter(move |t| !skip.contains(t));
        assert_eq!(sim(w, s, true, ticks(s..s + 1), all, |_| Accepted, None), vec![s + 1, s + 15, s + 30, s + 60, s + 75, s + 90]);
        assert_eq!(sim(w, s, true, ticks(s..s + 2), all, |_| Accepted, None), vec![s + 2, s + 15, s + 30, s + 60, s + 75, s + 90]);
        // Caught up later than its grace: the push stands in for the repeat 15 slots after the drawn slot, which would
        // otherwise follow it within MIN_PUSH_GAP_SLOTS.
        assert_eq!(sim(w, s, true, ticks(s..s + 14), all, |_| Accepted, None), vec![s + 14, s + 30, s + 60, s + 75, s + 90]);
        // One catch-up tick reaching the drawn slot's due point and the first repeat's, the first push already out: one
        // push, for the repeat.
        assert_eq!(sim(w, s, true, ticks(s + 1..s + 15), all, |_| Accepted, None), vec![s, s + 15, s + 30, s + 60, s + 75, s + 90]);
        assert_eq!(sim(w, s, true, ticks(s + 3..s + 17), all, |_| Accepted, None), vec![s, s + 17, s + 30, s + 60, s + 75, s + 90]);
        // Every pair of pushes at least MIN_PUSH_GAP_SLOTS apart, whatever stall of up to the catch-up bound.
        for start in s..s + 95 {
            for len in 1..=MAX_PING_CATCHUP_SLOTS {
                let sent = sim(w, s, true, ticks(start..start + len), all, |_| Accepted, None);
                assert!(sent.windows(2).all(|p| p[1] - p[0] >= crate::rpc::MIN_PUSH_GAP_SLOTS), "stall {start}+{len}: {sent:?}");
                assert!(sent.len() <= crate::rpc::MAX_PUSHES_PER_EPOCH as usize);
            }
        }
    }

    /// A restart loses the ledger but keeps the slot it last read (`rpc::push_read_mark`): a first tick that joins it
    /// sends no due point the run before read, and a repeat of a round begun before the restart is still due to the
    /// node, whose record went with the restart (`ShardReads::held_from`); the retry round is read from the buckets an
    /// hour back. A restart in any slot sends the node what an uninterrupted genesis sends, one push a due point; one
    /// down past the catch-up bound loses only the due points of its stop.
    #[test]
    fn a_restart_sends_no_due_point_twice_and_keeps_the_round() {
        use crate::rpc::SendOutcome::{Accepted, Unsent};
        let (w, s) = (4_100u64, 30u64);
        let never = |_: u64| false;
        let all = sim(w, s, true, 0..240, never, |_| Accepted, None);
        assert_eq!(all, vec![s, s + 15, s + 30, s + 60, s + 75, s + 90]);
        for restart in 1..240 {
            assert_eq!(sim(w, s, true, 0..240, never, |_| Accepted, Some(restart)), all, "restart at slot {restart}");
        }
        // Down for a while: a stop within the catch-up bound is caught up (a late push stands in for the next due point
        // when that one is nearer); a longer one loses the due points it was down for, nothing else.
        let down = |from: u64, len: u64| (0..240u64).filter(move |t| !(from..from + len).contains(t));
        assert_eq!(sim(w, s, true, down(s + 10, 10), never, |_| Accepted, Some(s + 20)), vec![s, s + 20, s + 60, s + 75, s + 90]);
        assert_eq!(sim(w, s, true, down(s + 5, 20), never, |_| Accepted, Some(s + 25)), vec![s, s + 30, s + 60, s + 75, s + 90]);
        assert_eq!(sim(w, s, true, down(s + 62, 20), never, |_| Accepted, Some(s + 82)), vec![s, s + 15, s + 30, s + 60, s + 90]);
        // A push shed in the slot before a restart loses the rest of its grace: never a duplicate, the round goes on.
        assert_eq!(sim(w, s, true, 0..240, never, |t| if t == s { Unsent } else { Accepted }, Some(s + 1)),
                   vec![s + 15, s + 30, s + 60, s + 75, s + 90]);
        // Whatever the stop, one push a due point: never two closer than MIN_PUSH_GAP_SLOTS, six at most.
        for from in 1..200u64 {
            for len in [0u64, 1, 2, 5, 13, 15, 16, 30] {
                let sent = sim(w, s, true, down(from, len), never, |_| Accepted, Some(from + len));
                assert!(sent.windows(2).all(|p| p[1] - p[0] >= crate::rpc::MIN_PUSH_GAP_SLOTS), "stop {from}+{len}: {sent:?}");
                assert!(sent.len() <= crate::rpc::MAX_PUSHES_PER_EPOCH as usize, "stop {from}+{len}: {sent:?}");
            }
        }
        // The mark of an earlier window, or of a slot ahead of the tip (a rollback), is not joined.
        let mut o = SimOwner::new(0, (0, 0));
        let nodes = ["light_mobile_sim".to_string()];
        o.mark = Some((w * 240 - 1, 0));
        let b = |_: u64, bucket: usize| if bucket == 0 { vec![0] } else { vec![] };
        assert_eq!(o.tick(w * 240, 0, [(0, 0); 5], &nodes, &b, &|_| false, &|_| Accepted), vec![0]);
        assert_eq!(o.reads.done, None);
        o.restart();
        o.mark = Some((w * 240 + 9, 0));
        o.tick(w * 240 + 5, 0, [(0, 0); 5], &nodes, &b, &|_| false, &|_| Accepted);
        assert_eq!(o.reads.done, None, "a mark ahead of the tip");
        // The selection keeps the mark every tick and joins it on its first tick only.
        let src = include_str!("propagation.rs");
        assert!(src.contains("crate::rpc::keep_push_read_mark(st, now_slot, shard_reads.read_from[our_genesis_idx]);"));
        assert!(src.contains("if first_tick { reads_state.done = resumed.map(|(l, _)| l); }"));
    }

    /// A node the dormant rule holds is read again only at the round's first push and the retry round's: a hold closes
    /// its due point's grace like a push, and a node only held, woken or refused here is offered no repeat. Twice an
    /// epoch, where with the rounds a slot apart it was six times. Once its shard's facts turn neutral it is pushed at
    /// the next of those two, and its repeats follow.
    #[test]
    fn a_dormant_hold_closes_its_due_point_and_offers_no_repeat() {
        use crate::rpc::SendOutcome::{Accepted, Dormant};
        let (w, s) = (4_100u64, 40u64);
        let never = |_: u64| false;
        assert_eq!(sim(w, s, true, 0..240, never, |_| Dormant, None), vec![s, s + 60]);
        assert_eq!(sim(w, s, true, 0..240, never, |t| if t < s + 10 { Dormant } else { Accepted }, None),
                   vec![s, s + 60, s + 75, s + 90]);
        // Before the spaced rounds each slot of a round is a due point of its own: held in each, as before.
        assert_eq!(sim(w, s, false, 0..240, never, |_| Dormant, None), vec![s, s + 1, s + 2, s + 60, s + 61, s + 62]);
        // On the ledger: a hold closes its due point and offers no repeat; a woken or refused node gets its first push
        // and no repeat until one went out here.
        let l = crate::rpc::PushLedger::new();
        let d = w * 240 + s;
        l.record("light_held", d, Dormant, 1);
        for g in 1..=crate::rpc::DUE_GRACE_SLOTS {
            assert!(!l.may_push("light_held", d + g, &[crate::rpc::Due::spaced(d, 0)], || 0), "grace slot {g}");
        }
        assert!(!l.may_push("light_held", d + 15, &[crate::rpc::Due::spaced(d + 15, 15)], || 0));
        assert!(!l.may_push("light_held", d + 16, &[crate::rpc::Due::spaced(d + 15, 15)], || 0));
        assert!(l.may_push("light_held", d + 60, &[crate::rpc::Due::spaced(d + 60, 0)], || 0), "the retry round's first push");
        l.woke("light_woken", d - 5, false, 1);
        l.refused("light_refused", w, "superseded", 1);
        for n in ["light_woken", "light_refused"] {
            assert!(!l.may_push(n, d + 15, &[crate::rpc::Due::spaced(d + 15, 15)], || 0), "{n}: no repeat");
            assert!(l.may_push(n, d, &[crate::rpc::Due::spaced(d, 0)], || 0), "{n}: its first push");
        }
    }

    /// The nodes of a test shard in window `w`, bucketed under each draw an owner may use there.
    struct SimShard {
        nodes: Vec<String>,
        by_draw: Vec<(u64, Vec<Vec<usize>>)>,
    }

    impl SimShard {
        fn new(w: u64, n: usize) -> Self {
            let nodes: Vec<String> = (0..n).map(|i| format!("light_mix_{i:05}")).collect();
            let draws = [ping_draw_slots(w, u64::MAX, u64::MAX), crate::rpc::UNSPACED_FIRST_PUSH_SLOTS, crate::rpc::FIRST_PUSH_SLOTS];
            let by_draw = draws.iter().map(|d| {
                let mut b = vec![Vec::new(); 240];
                for (i, id) in nodes.iter().enumerate() { b[SimplifiedP2P::slot_in_draw(id, w, *d) as usize].push(i); }
                (*d, b)
            }).collect();
            SimShard { nodes, by_draw }
        }

        fn bucket(&self, draw: u64, b: usize) -> Vec<usize> {
            self.by_draw.iter().find(|(d, _)| *d == draw).map(|(_, x)| x[b].clone()).unwrap_or_default()
        }

        /// The nodes whose slot under `draw` is in `slots`.
        fn drawn_in(&self, draw: u64, slots: std::ops::Range<u64>) -> Vec<usize> {
            slots.flat_map(|t| self.bucket(draw, t as usize)).collect()
        }
    }

    /// A genesis pushing the test shard: one of the release before this one (it reads the grace slots, pushes each node
    /// drawn there over the bounded range and keeps no record), or of this one.
    enum Pusher {
        Earlier(Option<u64>),
        This(SimOwner),
    }

    /// What an owner does in a slot: ticks, starts again first, or starts again on this release with a schedule.
    #[derive(Clone, Copy)]
    enum Step {
        Tick,
        Restart,
        UpgradeTo((u64, u64)),
    }

    /// Shard 0 over window `w`, nobody answering: owner o (genesis o) ticks in the slots `plan(o, t)` names, knowing the
    /// others' schedules as `known(o, t)` says. How many pushes each node got.
    fn run_shard(w: u64, shard: &SimShard, pushers: &mut [Pusher], plan: &dyn Fn(usize, u64) -> Option<Step>,
                 known: &dyn Fn(usize, u64) -> [(u64, u64); 5]) -> Vec<usize> {
        let mut got = vec![0usize; shard.nodes.len()];
        let bounded = ping_draw_slots(w, u64::MAX, u64::MAX);
        for t in 0..240u64 {
            let now = w * 240 + t;
            for o in 0..pushers.len() {
                let Some(step) = plan(o, t) else { continue; };
                match step {
                    Step::Tick => {}
                    Step::Restart => match &mut pushers[o] {
                        Pusher::Earlier(last) => *last = None,
                        Pusher::This(p) => p.restart(),
                    },
                    Step::UpgradeTo(s) => pushers[o] = Pusher::This(SimOwner::new(o, s)),
                }
                let offered = match &mut pushers[o] {
                    Pusher::Earlier(last) => {
                        let (buckets, _) = ping_buckets_to_read(*last, now);
                        *last = Some(now);
                        buckets.into_iter().flat_map(|b| shard.bucket(bounded, b)).collect::<Vec<_>>()
                    }
                    Pusher::This(p) => p.tick(now, 0, known(o, t), &shard.nodes, &|d, b| shard.bucket(d, b),
                                              &|_| false, &|_| crate::rpc::SendOutcome::Accepted),
                };
                for i in offered { got[i] += 1; }
            }
        }
        got
    }

    fn unpushed(got: &[usize]) -> Vec<usize> {
        got.iter().enumerate().filter(|(_, n)| **n == 0).map(|(i, _)| i).collect()
    }

    /// The spaced rounds and their draw start at a window boundary this genesis stores at its first ping on a release
    /// with them, from a tip the network stands behind: the window it lands in keeps the early draw and the rounds a slot
    /// apart to its end, a restart later in that window keeps them too (drawn again, a node whose new slot had passed
    /// while its old one had not would get no push), and every window from the stored one on is spaced, across any
    /// restart.
    #[test]
    fn the_spaced_rounds_start_at_a_kept_window_boundary_never_at_a_restart() {
        use crate::rpc::{first_push_draw_from, spaced_rounds_from, FIRST_PUSH_SLOTS, UNSPACED_FIRST_PUSH_SLOTS};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        assert_eq!(first_push_draw_from(&s, Some(300)), Some(301), "the early draw armed long ago");
        // Behind the network nothing is stored. The release lands in window 500, mid-window: 500 runs the old schedule
        // to its end.
        assert_eq!(spaced_rounds_from(&s, None), None, "behind the network");
        let (early, spaced) = (first_push_draw_from(&s, Some(500)).unwrap(), spaced_rounds_from(&s, Some(500)).unwrap());
        assert_eq!((early, spaced), (301, 501));
        assert_eq!(ping_draw_slots(500, early, spaced), UNSPACED_FIRST_PUSH_SLOTS, "window 500 keeps the draw it began with");
        // A restart later in window 500 reads the stored window, behind the network or not: still the old draw, and the
        // old reads.
        assert_eq!(spaced_rounds_from(&s, None), Some(501));
        let again = spaced_rounds_from(&s, Some(500)).unwrap();
        assert_eq!(again, 501);
        assert_eq!(ping_draw_slots(500, first_push_draw_from(&s, Some(500)).unwrap(), again), UNSPACED_FIRST_PUSH_SLOTS);
        let now = 500 * 240 + 120;
        assert_eq!(push_reads(Some(now - 1), now, 500 >= again, None).0.iter().map(|r| r.bucket).collect::<Vec<_>>(),
                   push_buckets_to_read(Some(now - 1), now).0);
        // From the boundary on the spaced draw and rounds, also after a restart in a later window.
        assert_eq!(ping_draw_slots(501, early, spaced), FIRST_PUSH_SLOTS);
        assert_eq!(spaced_rounds_from(&s, Some(507)), Some(501), "a restart in a later window keeps it");
        assert_eq!(ping_draw_slots(507, early, spaced_rounds_from(&s, Some(507)).unwrap()), FIRST_PUSH_SLOTS);
        // A genesis that never pinged: both start at the window after its first ping, the bounded draw until then.
        let fresh_dir = tempfile::TempDir::new().expect("tempdir");
        let fresh = crate::storage::Storage::new(fresh_dir.path().to_str().unwrap()).expect("storage");
        let (e, sp) = (first_push_draw_from(&fresh, Some(800)).unwrap(), spaced_rounds_from(&fresh, Some(800)).unwrap());
        assert_eq!((e, sp), (801, 801));
        assert_eq!(ping_draw_slots(800, e, sp), ping_draw_slots(800, u64::MAX, u64::MAX), "the bounded draw");
        assert_eq!(ping_draw_slots(801, e, sp), FIRST_PUSH_SLOTS);
        // The rounds' shape follows the same window: the selection asks for the window it reads.
        let src = include_str!("propagation.rs");
        assert!(src.contains("spaced_rounds_in(current_window), reads_state.done);"));
        assert!(src.contains("pub(crate) fn spaced_rounds_in(window: u64) -> bool {
    window >= SPACED_ROUND_WINDOW.load("));
    }

    /// Mixed versions in the epochs of the roll from the release running before (`SPACED_ROUND_WINDOW`): it draws over
    /// the bounded range, reads only the grace slots, sends no retry round and stores no window. A genesis upgraded in
    /// window W stores W + 1 for both its windows, so in W it draws every node into the slot the release before does,
    /// reads those slots too and adds a retry round: no node is pushed less. The primary and its backup are upgraded
    /// in W, the primary's restart long enough for a cover; every node of the shard gets a push in W and in W + 1.
    /// When the roll straddles W + 1, the backup spaced there and the primary still on the bounded draw until its own
    /// restart, a cover between them still leaves no node unpushed.
    #[test]
    fn the_roll_from_the_release_before_drops_no_node() {
        let w = 4_200u64;
        let (fresh, upgraded) = ((u64::MAX, u64::MAX), (w + 1, w + 1));
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        assert_eq!((crate::rpc::first_push_draw_from(&s, Some(w)), crate::rpc::spaced_rounds_from(&s, Some(w))), (Some(w + 1), Some(w + 1)),
                   "upgraded in W from storage the release before never wrote");
        // In W the same draw as the release before, and its grace reads among the reads.
        assert_eq!(ping_draw_slots(w, upgraded.0, upgraded.1), ping_draw_slots(w, fresh.0, fresh.1));
        for t in 0..240u64 {
            let (now, last) = (w * 240 + t, t.checked_sub(1).map(|p| w * 240 + p));
            let ours: Vec<usize> = push_reads(last, now, w >= upgraded.1, None).0.iter().map(|r| r.bucket).collect();
            let before = ping_buckets_to_read(last, now).0;
            assert_eq!(ours[..before.len()].to_vec(), before, "slot {t}: the grace reads, then the retry round's");
        }
        // W: the backup (1) was upgraded early in W, while it covered nothing; the primary (0) at slot 150, down
        // fifteen slots: the backup covers from 160 until three ticks after the primary is back at 165. W + 1: both
        // spaced, the primary pushing alone.
        let shard_w = SimShard::new(w, 3_000);
        let mut pushers = [Pusher::Earlier(None), Pusher::This(SimOwner::new(1, upgraded))];
        let plan = |o: usize, t: u64| -> Option<Step> {
            match (o, t) {
                (0, 150..=164) => None,
                (0, 165) => Some(Step::UpgradeTo(upgraded)),
                (0, _) => Some(Step::Tick),
                (1, 160..=167) => Some(Step::Tick),
                _ => None,
            }
        };
        // The backup hears the primary's schedule from its first tick on this release; the primary has the backup's.
        let known = |o: usize, t: u64| -> [(u64, u64); 5] {
            let mut k = [fresh; 5];
            if o == 1 && t >= 166 { k[0] = upgraded; }
            if o == 0 { k[1] = upgraded; }
            k
        };
        let got = run_shard(w, &shard_w, &mut pushers, &plan, &known);
        assert_eq!(unpushed(&got), Vec::<usize>::new(), "epoch W");
        let shard_next = SimShard::new(w + 1, 3_000);
        let both = |_: usize, _: u64| [upgraded; 5];
        let got = run_shard(w + 1, &shard_next, &mut pushers, &|o, _| (o == 0).then_some(Step::Tick), &both);
        assert_eq!(unpushed(&got), Vec::<usize>::new(), "epoch W + 1");
        // The roll straddles W + 1: the backup spaced there, the primary on the release before until its restart at 100,
        // down fifteen slots and back on this release (its windows W + 2), the backup covering from 110 to 118.
        let late = (w + 2, w + 2);
        let mut pushers = [Pusher::Earlier(None), Pusher::This(SimOwner::new(1, upgraded))];
        let plan = |o: usize, t: u64| -> Option<Step> {
            match (o, t) {
                (0, 115) => Some(Step::UpgradeTo(late)),
                (0, 100..=114) => None,
                (0, _) => Some(Step::Tick),
                (1, 110..=117) => Some(Step::Tick),
                _ => None,
            }
        };
        let known = |o: usize, t: u64| -> [(u64, u64); 5] {
            let mut k = [fresh; 5];
            if o == 0 { k[1] = upgraded; }
            if o == 1 && t >= 116 { k[0] = late; }
            k
        };
        let got = run_shard(w + 1, &shard_next, &mut pushers, &plan, &known);
        assert_eq!(unpushed(&got), Vec::<usize>::new(), "epoch W + 1, the roll straddling it");
    }

    /// A cover inside an epoch of the roll: a primary on the draw before the switch goes silent inside the epoch and its
    /// backup, on the spaced draw, covers. The backup reads the shard under the primary's draw too (`foreign_draws`, the
    /// schedule from the primary's ticks, the bounded draw for one of the release before), so every node still gets its
    /// first push or its retry round; without that a seventh to a fifth of the shard got nothing. A restart late in the epoch
    /// (silent at 180, covered from 190, back at 200) leaves unpushed only nodes a single shared draw leaves unpushed
    /// too: those drawn into the ten silent slots with no room left for a retry round.
    #[test]
    fn a_cover_between_owners_on_different_draws_drops_no_node() {
        let w = 4_300u64;
        let shard = SimShard::new(w, 4_000);
        let fresh = (u64::MAX, u64::MAX);
        let spaced = (w, w);
        // The primary silent from slot 100 to the epoch's end, the backup covering from 110.
        let silent_at_100 = |o: usize, t: u64| match o { 0 if t < 100 => Some(Step::Tick), 1 if t >= 110 => Some(Step::Tick), _ => None };
        for (old, earlier) in [((w + 1, w + 1), false), ((w - 40, w + 1), false), (fresh, true)] {
            let known = |_: usize, _: u64| [old, spaced, fresh, fresh, fresh];
            let run = |foreign: bool| {
                let primary = if earlier { Pusher::Earlier(None) } else { Pusher::This(SimOwner::new(0, old)) };
                let mut backup = SimOwner::new(1, spaced);
                backup.foreign = foreign;
                run_shard(w, &shard, &mut [primary, Pusher::This(backup)], &silent_at_100, &known)
            };
            assert_eq!(unpushed(&run(true)), Vec::<usize>::new(), "primary {old:?}");
            let lost = unpushed(&run(false)).len();
            assert!(lost * 20 > shard.nodes.len(), "primary {old:?}: read under its own draw alone the cover left {lost} unpushed");
            if earlier { continue; }
            // The primary back at 130 after a restart longer than the catch-up bound, the backup handing back at 133.
            let back_at_130 = |o: usize, t: u64| match (o, t) {
                (0, 130) => Some(Step::Restart),
                (0, 100..=129) => None,
                (0, _) => Some(Step::Tick),
                (1, 110..=132) => Some(Step::Tick),
                _ => None,
            };
            let got = run_shard(w, &shard, &mut [Pusher::This(SimOwner::new(0, old)), Pusher::This(SimOwner::new(1, spaced))],
                                &back_at_130, &known);
            assert_eq!(unpushed(&got), Vec::<usize>::new(), "primary {old:?} back at 130");
        }
        // A restart late in the epoch: the backup spaced, the primary on the release before, restarted for its upgrade
        // at 180 and back at 200 on this release (its windows W + 1); the backup covers from 190 until three ticks after
        // 200. The backup never hears a schedule from the primary of the release before (the bounded draw); the primary
        // hears the backup's from its second tick on.
        let plan = |o: usize, t: u64| match (o, t) {
            (0, 200) => Some(Step::UpgradeTo((w + 1, w + 1))),
            (0, 180..=199) => None,
            (0, _) => Some(Step::Tick),
            (1, 190..=202) => Some(Step::Tick),
            _ => None,
        };
        let run = |backup: (u64, u64), foreign: bool| {
            let mut b = SimOwner::new(1, backup);
            b.foreign = foreign;
            let known = |o: usize, t: u64| if o == 0 && t > 200 { [fresh, backup, fresh, fresh, fresh] } else { [fresh; 5] };
            run_shard(w, &shard, &mut [Pusher::Earlier(None), Pusher::This(b)], &plan, &known)
        };
        let mixed = unpushed(&run(spaced, true));
        let same = unpushed(&run((w + 1, w + 1), true));
        let bounded = ping_draw_slots(w, u64::MAX, u64::MAX);
        assert!(!same.is_empty() && same.iter().all(|i| shard.drawn_in(bounded, 180..190).contains(i)), "the silence alone");
        assert!(mixed.iter().all(|i| same.contains(i)), "no node a single draw reaches is left: {} of {}", mixed.len(), same.len());
        assert!(unpushed(&run(spaced, false)).len() > mixed.len(), "the foreign draw is what reaches them");
    }

    /// A hand-back between owners armed for the spaced draw in different epochs, so they draw the live epoch differently:
    /// the backup covered the shard from before the epoch, the primary takes it back inside it. The primary starts
    /// pushing inside the epoch and reads the shard under the backup's draw too, so every node gets its first push or its
    /// retry round, whichever of the two is on the spaced draw and wherever in the epoch the hand-back falls.
    #[test]
    fn a_hand_back_between_owners_armed_in_different_epochs_drops_no_node() {
        let w = 4_400u64;
        let shard = SimShard::new(w, 4_000);
        let (spaced, bounded) = ((w, w), (w + 1, w + 1));
        for (primary, backup) in [(spaced, bounded), (bounded, spaced)] {
            for back in [30u64, 120, 200] {
                let plan = |o: usize, t: u64| match o { 0 if t >= back => Some(Step::Tick), 1 if t < back + 3 => Some(Step::Tick), _ => None };
                let known = |_: usize, _: u64| [primary, backup, (u64::MAX, u64::MAX), (u64::MAX, u64::MAX), (u64::MAX, u64::MAX)];
                let run = |foreign: bool| {
                    let mut p = SimOwner::new(0, primary);
                    p.foreign = foreign;
                    run_shard(w, &shard, &mut [Pusher::This(p), Pusher::This(SimOwner::new(1, backup))], &plan, &known)
                };
                assert_eq!(unpushed(&run(true)), Vec::<usize>::new(), "primary {primary:?}, back at {back}");
                if back == 120 {
                    assert!(!unpushed(&run(false)).is_empty(), "primary {primary:?}: its own draw alone leaves nodes out");
                }
            }
        }
    }

    /// The foreign draws: only an owner of the shard whose draw differs, each draw once; the index of them follows the
    /// slot index by position, is built again when the index or the draws asked change, extended with the ids the index
    /// gained, and empty when no draw is asked.
    #[test]
    fn the_foreign_index_follows_the_slot_index() {
        let w = 4_500u64;
        let (fresh, spaced, early) = ((u64::MAX, u64::MAX), (w, w), (w - 3, w + 1));
        let all_spaced = [spaced; 5];
        assert!(foreign_draws(w, 0, 0, &all_spaced).is_empty(), "the owners agree");
        let mut s = all_spaced;
        s[3] = fresh;
        assert!(foreign_draws(w, 0, 0, &s).is_empty(), "genesis 3 owns no part of shard 0");
        assert_eq!(foreign_draws(w, 0, 3, &s), vec![ping_draw_slots(w, u64::MAX, u64::MAX)]);
        s[4] = early;
        assert_eq!(foreign_draws(w, 2, 2, &s), vec![ping_draw_slots(w, u64::MAX, u64::MAX), crate::rpc::UNSPACED_FIRST_PUSH_SLOTS],
                   "each other owner's draw once, in owner order");
        assert!(foreign_draws(w, 0, 0, &[fresh; 5]).is_empty());
        // The index.
        let ids: Vec<String> = (0..600).map(|i| format!("light_fx_{i:04}")).collect();
        let mut buckets: Vec<Vec<String>> = vec![Vec::new(); 240];
        for id in &ids[..400] { buckets[SimplifiedP2P::slot_in_draw(id, w, crate::rpc::FIRST_PUSH_SLOTS) as usize].push(id.clone()); }
        let shard0 = |id: &str| crate::node::light_shard_of(id) == 0;
        let bounded = ping_draw_slots(w, u64::MAX, u64::MAX);
        let mut f = ForeignIndex::new();
        let check = |f: &ForeignIndex, buckets: &[Vec<String>], n: usize| {
            for b in 0..240 {
                let mut got: Vec<&String> = f.ids(buckets, b).collect();
                got.sort();
                let mut want: Vec<&String> = ids[..n].iter().filter(|id| shard0(id) && SimplifiedP2P::slot_in_draw(id, w, bounded) == b as u64).collect();
                want.sort();
                assert_eq!(got, want, "bucket {b}");
            }
        };
        f.sync(&buckets, 7, w, &[(bounded, 1)]);
        check(&f, &buckets, 400);
        for id in &ids[400..] { buckets[SimplifiedP2P::slot_in_draw(id, w, crate::rpc::FIRST_PUSH_SLOTS) as usize].push(id.clone()); }
        f.sync(&buckets, 7, w, &[(bounded, 1)]);
        check(&f, &buckets, 600);
        // A new build of the slot index (positions changed): built again.
        buckets.iter_mut().for_each(|b| b.reverse());
        f.sync(&buckets, 8, w, &[(bounded, 1)]);
        check(&f, &buckets, 600);
        f.sync(&buckets, 8, w, &[]);
        assert_eq!((0..240).map(|b| f.ids(&buckets, b).count()).sum::<usize>(), 0, "nothing asked, nothing held");
        // The selection syncs it under the slot index's lock and offers a node read under two draws once.
        let src = include_str!("propagation.rs");
        assert!(src.contains("foreign.sync(&cache.1, SLOT_INDEX_BUILDS.load(std::sync::atomic::Ordering::Relaxed), current_window, &wanted);"));
        assert!(src.contains("due.retain(|id| seen.insert(*id));"));
    }

    /// What a genesis read of each shard: kept while its ticks join, started again by a gap, a new cover or a restart,
    /// and for its own shard across a restart that joins the run before.
    #[test]
    fn shard_reads_follow_joined_ticks_covers_and_restarts() {
        let ws = 4_600u64 * 240;
        let mut r = ShardReads::new();
        r.advance(1 << 2, 2, ws, false, None);
        assert_eq!((r.read_from[2], r.held_from[2]), (ws, ws), "a first tick at the epoch's start");
        r.advance(1 << 2, 2, ws + 40, true, None);
        assert_eq!(r.read_from[2], ws, "joined: kept");
        r.advance(1 << 2 | 1 << 1, 2, ws + 50, true, None);
        assert_eq!((r.read_from[1], r.held_from[1], r.read_from[2]), (ws + 50, ws + 50, ws), "a cover starts at its tick");
        r.advance(1 << 2 | 1 << 1, 2, ws + 70, false, None);
        assert_eq!((r.read_from[1], r.read_from[2]), (ws + 70, ws + 70), "a gap starts both again");
        let mut after = ShardReads::new();
        after.advance(1 << 2, 2, ws + 81, true, Some(ws));
        assert_eq!((after.read_from[2], after.held_from[2]), (ws, ws + 81), "a restart joining the run before: reads kept, records not");
    }
}

#[cfg(test)]
mod tests_genesis_peer_ip {
    use super::*;

    /// Padded and legacy unpadded genesis ids name one peer; any other id is not a genesis peer.
    #[test]
    fn genesis_ids_resolve_and_others_do_not() {
        // The helper skips the node itself, so ask for a genesis that is not this process.
        let n = if std::env::var("QNET_BOOTSTRAP_ID").ok().as_deref() == Some("001") { "002" } else { "001" };
        let padded = SimplifiedP2P::genesis_peer_ip(&format!("genesis_node_{}", n));
        assert!(padded.is_some(), "genesis_node_{} is a genesis peer", n);
        assert_eq!(SimplifiedP2P::genesis_peer_ip(&format!("genesis_node_{}", n.trim_start_matches('0'))), padded);
        assert_eq!(SimplifiedP2P::genesis_peer_ip("super_node_12"), None);
        assert_eq!(SimplifiedP2P::genesis_peer_ip("genesis_node_0001"), None);
        assert_eq!(SimplifiedP2P::genesis_peer_ip("genesis_node_"), None);
    }
}

#[cfg(test)]
mod light_registration_gossip_tests {
    use super::*;

    /// NB-2: a UnifiedPush endpoint is a push capability, and registration gossip reaches arbitrary peers for
    /// three hops while no receiver reads it. Neither the origin nor a forward carries it.
    #[test]
    fn a_registration_gossip_carries_no_push_endpoint() {
        let r = LightNodeRegistrationData {
            node_id: "light_mobile_nb2".to_string(), wallet_address: "w".to_string(), device_token_hash: String::new(),
            quantum_pubkey: "k".to_string(), registered_at: 1, signature: String::new(), push_type: PushType::UnifiedPush,
            unified_push_endpoint: Some("https://ntfy.sh/upXYZ".to_string()), last_seen: 1, consecutive_failures: 0,
            is_active: true, ping_pubkey: String::new(), ping_delegation_cert: String::new(),
        };
        match SimplifiedP2P::light_registration_gossip(r) {
            NetworkMessage::LightNodeRegistration { unified_push_endpoint, push_type, .. } => {
                assert_eq!(unified_push_endpoint, None);
                assert_eq!(push_type, PushType::UnifiedPush);
            }
            _ => panic!("not a registration"),
        }
        let peers = include_str!("peers.rs");
        let fwd = &peers[peers.find("let _ = (device_token_hash, signature, unified_push_endpoint);").expect("the forward")..];
        assert!(fwd[..fwd.find("gossip_to_random_peers(forward_msg, 3)").unwrap()].contains("unified_push_endpoint: None,"));
    }
}

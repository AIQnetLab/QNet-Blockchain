//! Certified proof views. At every boundary height 90j the node pins O(1) RocksDB snapshots of the
//! tree DB and the aux DB, each taken exactly behind the finalize of block 90j. A pair becomes a
//! served view only when the stored macroblock j carries a checkpoint whose `state_root` equals the
//! snapshot's root row, so a proof built over the view folds to a root the committee certified.
//! Uncertified heights are never served; views do not survive a restart.

use super::*;
use super::tree_db::{CF_ACCT_LEAVES, CF_ACCT_NODES, CF_TREE_META, META_SEQ, ROOT_DEPTH};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::AtomicUsize;
use std::time::{Duration, Instant};

/// Certified views held: the window {c, c-1, c-2} a client accepts.
pub const PROOF_VIEWS_KEPT: usize = 3;
/// Uncertified boundary snapshots held: two cover a seal lag of up to 180 blocks.
pub const PROOF_CANDIDATES_KEPT: usize = 2;
/// Held views are retired oldest-first while the derived DBs' SST total exceeds this times live data.
pub const VIEW_SPACE_AMP_LIMIT: f64 = 3.0;
/// Disk pressure releases views at the cached 95% and resumes below this fresh measurement.
pub const VIEWS_RESUME_PCT: f64 = 90.0;

const MB_INTERVAL: u64 = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
const TICK: Duration = Duration::from_secs(2);
const CANDIDATE_RECHECK: Duration = Duration::from_secs(30);
const REVALIDATE_EVERY: Duration = Duration::from_secs(60);
const FRESH_MEASURE_EVERY: Duration = Duration::from_secs(60);
const STATS_EVERY: Duration = Duration::from_secs(300);
const LEGACY_POLL_EVERY: Duration = Duration::from_secs(10);
const LEGACY_RETIRE_WINDOW: Duration = Duration::from_secs(3600);
/// How far down a deleted top macroblock is searched for the next stored one.
const NEWEST_PROBE_DEPTH: u64 = 1024;
/// Below this many SST bytes the space-amplification ratio is noise.
const SPACE_AMP_MIN_BYTES: u64 = 256 * 1024 * 1024;

/// Read options for every proof-path read: random proof traffic must never evict the consensus
/// working set from the shared block cache.
pub(crate) fn no_cache() -> rocksdb::ReadOptions {
    let mut ro = rocksdb::ReadOptions::default();
    ro.fill_cache(false);
    ro
}

/// One half of a candidate, from the thread that wrote it.
pub(crate) enum Part {
    /// Tree DB snapshot taken behind the account-tree finalize, with that finalize's root.
    Tree([u8; 32], PinnedDbSnapshot),
    /// Aux DB snapshot taken behind the same finalize's aux job.
    Aux(PinnedDbSnapshot),
}

/// A served view: the state after block `height` = 90 * `index`, certified by macroblock `index`.
pub struct View {
    pub index: u64,
    pub height: u64,
    pub root: [u8; 32],
    pub tree: Arc<PinnedDbSnapshot>,
    pub aux: Arc<PinnedDbSnapshot>,
    seq: u64,
}

/// The served views, newest first. Readers clone the `Arc` under a brief read lock.
#[derive(Default)]
pub struct ViewSet {
    pub views: Vec<Arc<View>>,
}

struct Candidate {
    height: u64,
    seq: u64,
    tree: Option<([u8; 32], Arc<PinnedDbSnapshot>)>,
    aux: Option<Arc<PinnedDbSnapshot>>,
    /// Re-read the macroblock at the next tick.
    due: bool,
    checked_at: Option<Instant>,
}

impl Candidate {
    fn new(height: u64, seq: u64) -> Self {
        Self { height, seq, tree: None, aux: None, due: false, checked_at: None }
    }
    fn complete(&self) -> bool { self.tree.is_some() && self.aux.is_some() }
}

/// Counters of the certified read path, logged in `stats`. The RPC layer bumps them.
#[derive(Default)]
pub struct ProofStats {
    pub served: AtomicU64,
    pub cache_hits: AtomicU64,
    pub busy: AtomicU64,
    pub rate_limited: AtomicU64,
    pub not_certified: AtomicU64,
    pub not_retained: AtomicU64,
    pub unavailable: AtomicU64,
    pub self_check_failed: AtomicU64,
    pub preimage_fallback: AtomicU64,
}

type Probe<T> = Box<dyn Fn() -> T + Send + Sync>;

/// Measurements the worker acts on, replaceable so tests can drive them.
struct Probes {
    /// The storage layer's cached usage at or above its critical mark.
    critically_full: Probe<bool>,
    /// A fresh usage measurement in percent, taken now.
    fresh_usage_pct: Probe<Option<f64>>,
    /// (total SST bytes, estimated live bytes) over both derived DBs.
    space: Probe<(u64, u64)>,
}

#[derive(Default)]
struct Registry {
    candidates: BTreeMap<u64, Candidate>,
    views: BTreeMap<u64, Arc<View>>,
    mismatch_logged: BTreeSet<u64>,
    missed_logged: BTreeSet<u64>,
}

struct Timers {
    revalidate: Instant,
    fresh: Instant,
    stats: Instant,
    legacy: Instant,
}

/// The views registry and its worker.
pub struct ProofViews {
    reg: parking_lot::Mutex<Registry>,
    published: parking_lot::RwLock<Arc<ViewSet>>,
    newest_certified: AtomicU64,
    store_write_failed: AtomicBool,
    /// The tree DB's own write-failure latch, set on its writer thread ahead of any later marker.
    tree_write_failed: Arc<AtomicBool>,
    aux_active: Arc<AtomicBool>,
    aux_queued: Arc<AtomicUsize>,
    disk_latched: AtomicBool,
    /// Disk-pressure episodes that released the views.
    pressure_releases: AtomicU64,
    pub stats: ProofStats,
    main: Arc<DB>,
    tree: Arc<DB>,
    aux: Arc<DB>,
    tree_rebuilt: Arc<AtomicBool>,
    legacy_done: AtomicBool,
    probes: parking_lot::RwLock<Probes>,
    wake: parking_lot::Mutex<bool>,
    wake_cv: parking_lot::Condvar,
    shutdown: AtomicBool,
    worker: parking_lot::Mutex<Option<std::thread::JoinHandle<()>>>,
    timers: parking_lot::Mutex<Timers>,
    born: Instant,
    /// `macroblock_save_seq()` at the last tick: a change makes every candidate due.
    last_save_seq: AtomicU64,
}

/// What a stored macroblock says about a height.
enum Certified {
    Absent,
    Unreadable,
    Root { head: u64, cp_root: [u8; 32], mb_root: [u8; 32] },
}

fn sum_property(dbs: &[&DB], cfs: &[&str], name: &str) -> u64 {
    let mut total = 0u64;
    for db in dbs {
        for cf in cfs {
            if let Some(h) = db.cf_handle(cf) {
                total += db.property_int_value_cf(&h, name).ok().flatten().unwrap_or(0);
            }
        }
    }
    total
}

/// Total size of the files under `dir`, or None when it cannot be walked.
pub(crate) fn dir_size(dir: &Path) -> Option<u64> {
    fn walk(d: &Path, total: &mut u64) -> std::io::Result<()> {
        for entry in std::fs::read_dir(d)? {
            let entry = entry?;
            let p = entry.path();
            if p.is_dir() { walk(&p, total)?; } else if let Ok(m) = entry.metadata() { *total += m.len(); }
        }
        Ok(())
    }
    let mut total = 0u64;
    walk(dir, &mut total).ok().map(|_| total)
}

impl ProofViews {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        main: Arc<DB>,
        tree: Arc<DB>,
        aux: Arc<DB>,
        tree_rebuilt: Arc<AtomicBool>,
        tree_write_failed: Arc<AtomicBool>,
        aux_active: Arc<AtomicBool>,
        aux_queued: Arc<AtomicUsize>,
    ) -> Arc<Self> {
        let (t, a) = (tree.clone(), aux.clone());
        let space: Probe<(u64, u64)> = Box::new(move || {
            let dbs: [&DB; 2] = [&*t, &*a];
            let cfs: Vec<&str> = super::tree_db::TREE_CFS.iter().chain(super::aux_db::AUX_CFS.iter()).copied().collect();
            (sum_property(&dbs, &cfs, "rocksdb.total-sst-files-size"),
             sum_property(&dbs, &cfs, "rocksdb.estimate-live-data-size"))
        });
        let now = Instant::now();
        Arc::new(Self {
            reg: parking_lot::Mutex::new(Registry::default()),
            published: parking_lot::RwLock::new(Arc::new(ViewSet::default())),
            newest_certified: AtomicU64::new(0),
            store_write_failed: AtomicBool::new(false),
            tree_write_failed,
            aux_active,
            aux_queued,
            disk_latched: AtomicBool::new(false),
            pressure_releases: AtomicU64::new(0),
            stats: ProofStats::default(),
            main,
            tree,
            aux,
            tree_rebuilt,
            legacy_done: AtomicBool::new(false),
            probes: parking_lot::RwLock::new(Probes {
                critically_full: Box::new(|| false),
                fresh_usage_pct: Box::new(|| None),
                space,
            }),
            wake: parking_lot::Mutex::new(false),
            wake_cv: parking_lot::Condvar::new(),
            shutdown: AtomicBool::new(false),
            worker: parking_lot::Mutex::new(None),
            timers: parking_lot::Mutex::new(Timers { revalidate: now, fresh: now, stats: now, legacy: now }),
            born: now,
            last_save_seq: AtomicU64::new(super::macroblock_save_seq()),
        })
    }

    /// Start the worker thread `qnet-proof-views`.
    pub(crate) fn start(self: &Arc<Self>) -> IntegrationResult<()> {
        let me = Arc::clone(self);
        let handle = std::thread::Builder::new()
            .name("qnet-proof-views".to_string())
            .spawn(move || {
                while !me.shutdown.load(Ordering::SeqCst) {
                    {
                        let mut woken = me.wake.lock();
                        if !*woken { me.wake_cv.wait_for(&mut woken, TICK); }
                        *woken = false;
                    }
                    if me.shutdown.load(Ordering::SeqCst) { break; }
                    me.tick(Instant::now());
                }
            })
            .map_err(|e| IntegrationError::Other(format!("proof_views_spawn_failed: {}", e)))?;
        *self.worker.lock() = Some(handle);
        Ok(())
    }

    /// Stop and join the worker and release every snapshot, so the DBs can close.
    pub(crate) fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.wake_now();
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
        let gone = std::mem::take(&mut *self.reg.lock());
        *self.published.write() = Arc::new(ViewSet::default());
        drop(gone);
    }

    fn wake_now(&self) {
        *self.wake.lock() = true;
        self.wake_cv.notify_all();
    }

    /// The storage layer's usage probes: the cached critical mark and a fresh measurement.
    pub(crate) fn set_disk_probes(&self, critically_full: Probe<bool>, fresh_usage_pct: Probe<Option<f64>>) {
        let mut p = self.probes.write();
        p.critically_full = critically_full;
        p.fresh_usage_pct = fresh_usage_pct;
    }

    #[cfg(test)]
    pub(crate) fn set_space_probe(&self, space: Probe<(u64, u64)>) {
        self.probes.write().space = space;
    }

    pub(crate) fn init_newest(&self, idx: u64) {
        self.newest_certified.fetch_max(idx, Ordering::SeqCst);
    }

    /// The served views, newest first.
    pub fn current(&self) -> Arc<ViewSet> {
        self.published.read().clone()
    }

    /// The highest macroblock index this node stores, never below a served view.
    pub fn newest_certified_index(&self) -> u64 {
        let newest_view = self.current().views.first().map_or(0, |v| v.index);
        self.newest_certified.load(Ordering::SeqCst).max(newest_view)
    }

    /// Why captures are refused right now, if they are.
    pub(crate) fn refusal(&self) -> Option<&'static str> {
        if self.store_write_failed.load(Ordering::SeqCst) || self.tree_write_failed.load(Ordering::SeqCst) {
            Some("store_write_failed")
        } else if !self.aux_active.load(Ordering::SeqCst) {
            Some("aux_untrusted")
        } else if self.disk_latched.load(Ordering::SeqCst) {
            Some("disk_pressure")
        } else {
            None
        }
    }

    /// The capture state `/state/certified` reports: the first refusal that holds, or `ok`.
    pub fn capture_state(&self) -> &'static str {
        self.refusal().unwrap_or("ok")
    }

    pub(crate) fn set_store_write_failed(&self, failed: bool) {
        self.store_write_failed.store(failed, Ordering::SeqCst);
    }

    /// Routine churn is INFO only near the certified frontier; a long replay logs it at DBG.
    fn near_frontier(&self, index: u64) -> bool {
        index + 3 >= self.newest_certified_index()
    }

    /// Log one refused or dropped offer.
    pub(crate) fn drop_offer(&self, height: u64, reason: &str) {
        let routine = matches!(reason, "superseded" | "cap" | "retracted");
        if routine {
            if self.near_frontier(height / MB_INTERVAL) {
                if crate::node::is_info() {
                    println!("[INFO][PROOFVIEW] candidate_dropped height={} reason={}", height, reason);
                }
            } else if crate::node::is_debug() {
                println!("[DBG][PROOFVIEW] candidate_dropped height={} reason={}", height, reason);
            }
        } else if crate::node::is_warn() {
            println!("[WARN][PROOFVIEW] candidate_dropped height={} reason={}", height, reason);
        }
    }

    /// A part checks its own snapshot before it may join a candidate: the tree part must show
    /// exactly its finalize's seq and root row (no root row for the empty tree).
    fn check_tree_part(snap: &PinnedDbSnapshot, seq: u64, root: &[u8; 32]) -> Result<(), &'static str> {
        let stored = snap.get_cf_opt(CF_TREE_META, META_SEQ, no_cache())
            .map_err(|_| "root_row_mismatch")?
            .filter(|v| v.len() == 8)
            .map(|v| u64::from_le_bytes(v[..8].try_into().unwrap_or([0u8; 8])));
        if stored != Some(seq) {
            return Err("seq_mismatch");
        }
        let row = snap.get_cf_opt(CF_ACCT_NODES, &super::tree_db::node_db_key(ROOT_DEPTH, &[0u8; 32]), no_cache())
            .map_err(|_| "root_row_mismatch")?;
        let ok = if *root == qnet_state::StateMerkleTree::empty_root() {
            row.is_none()
        } else {
            row.as_deref() == Some(&root[..])
        };
        if ok { Ok(()) } else { Err("root_row_mismatch") }
    }

    /// Hand one part of the candidate at `height` to the registry. Never blocks a writer: the own
    /// snapshot check happens before the lock, and nothing under the lock reads or logs.
    pub(crate) fn offer_part(&self, height: u64, seq: u64, part: Part) {
        if let Part::Tree(root, ref snap) = part {
            if let Err(reason) = Self::check_tree_part(snap, seq, &root) {
                self.drop_offer(height, reason);
                return;
            }
        }
        if let Some(reason) = self.refusal() {
            self.drop_offer(height, reason);
            return;
        }
        let mut dropped: Vec<(u64, &'static str, Candidate)> = Vec::new();
        let mut stale = false;
        let mut complete = false;
        {
            let mut reg = self.reg.lock();
            // A newer finalize offered at H means the state went back to H: anything above it from an
            // older finalize is an abandoned branch. Seqs follow apply order, so a part that merely
            // arrives late (its pair landed first on the other writer) never drops a newer candidate.
            let above: Vec<u64> = reg.candidates.range(height + 1..)
                .filter(|(_, c)| c.seq < seq).map(|(h, _)| *h).collect();
            for h in above {
                if let Some(c) = reg.candidates.remove(&h) { dropped.push((h, "superseded", c)); }
            }
            let entry = reg.candidates.entry(height).or_insert_with(|| Candidate::new(height, seq));
            if entry.seq < seq {
                let old = std::mem::replace(entry, Candidate::new(height, seq));
                dropped.push((height, "superseded", old));
            } else if entry.seq > seq {
                stale = true;
            }
            if !stale {
                match part {
                    Part::Tree(root, snap) => entry.tree = Some((root, Arc::new(snap))),
                    Part::Aux(snap) => entry.aux = Some(Arc::new(snap)),
                }
                complete = entry.complete();
                if complete { entry.due = true; }
            }
            while reg.candidates.len() > PROOF_CANDIDATES_KEPT {
                if let Some((h, c)) = reg.candidates.pop_first() { dropped.push((h, "cap", c)); }
            }
        }
        if stale {
            self.drop_offer(height, "stale_part");
        }
        for (h, reason, c) in dropped {
            self.drop_offer(h, reason);
            drop(c);
        }
        if complete {
            self.wake_now();
        }
    }

    fn read_certified(&self, index: u64) -> Certified {
        let cf = match self.main.cf_handle("microblocks") { Some(cf) => cf, None => return Certified::Unreadable };
        let raw = match self.main.get_cf(&cf, format!("macroblock_{}", index).as_bytes()) {
            Ok(Some(raw)) if !raw.is_empty() => raw,
            Ok(_) => return Certified::Absent,
            Err(_) => return Certified::Unreadable,
        };
        let mb = match crate::node::BlockchainNode::macroblock_plaintext(raw)
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()) {
            Some(mb) => mb,
            None => return Certified::Unreadable,
        };
        let cp = match mb.consensus_data.checkpoint_qc.as_deref()
            .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                   qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok()) {
            Some((cp, _)) => cp,
            None => return Certified::Unreadable,
        };
        Certified::Root { head: cp.window_head_height, cp_root: cp.state_root, mb_root: mb.state_root }
    }

    fn publish(reg: &Registry, published: &parking_lot::RwLock<Arc<ViewSet>>) {
        let views: Vec<Arc<View>> = reg.views.values().rev().cloned().collect();
        *published.write() = Arc::new(ViewSet { views });
    }

    /// Promote the complete candidate at `height` if the stored macroblock certifies its root. The
    /// stored row is the authority, never a save hook.
    pub(crate) fn try_promote(&self, height: u64) {
        let (seq, root) = {
            let mut reg = self.reg.lock();
            match reg.candidates.get_mut(&height) {
                Some(c) if c.complete() => {
                    c.due = false;
                    c.checked_at = Some(Instant::now());
                    (c.seq, c.tree.as_ref().map(|(r, _)| *r).unwrap_or([0u8; 32]))
                }
                _ => return,
            }
        };
        let index = height / MB_INTERVAL;
        let (head, cp_root, mb_root) = match self.read_certified(index) {
            Certified::Root { head, cp_root, mb_root } => (head, cp_root, mb_root),
            Certified::Absent | Certified::Unreadable => return,
        };
        if head != height || cp_root != root || mb_root != root {
            let (first, gone) = {
                let mut reg = self.reg.lock();
                let first = reg.mismatch_logged.insert(index);
                let same = reg.candidates.get(&height).map_or(false, |c| c.seq == seq);
                let gone = if same { reg.candidates.remove(&height) } else { None };
                (first, gone)
            };
            if first {
                eprintln!("[ERR][PROOFVIEW] certified_root_mismatch index={} candidate={} certified={} head={}",
                          index, hex::encode(&root[..8]), hex::encode(&cp_root[..8]), head);
            }
            drop(gone);
            return;
        }
        let (retired, promoted, views) = {
            let mut reg = self.reg.lock();
            if !reg.candidates.get(&height).map_or(false, |c| c.seq == seq && c.complete()) {
                return;
            }
            let c = reg.candidates.remove(&height).expect("present");
            let (root, tree) = c.tree.expect("complete");
            let view = Arc::new(View { index, height, root, tree, aux: c.aux.expect("complete"), seq });
            reg.views.insert(index, view);
            let mut retired = Vec::new();
            while reg.views.len() > PROOF_VIEWS_KEPT {
                if let Some((i, v)) = reg.views.pop_first() { retired.push((i, v)); }
            }
            Self::publish(&reg, &self.published);
            (retired, index, reg.views.len())
        };
        let near = self.near_frontier(promoted);
        if near {
            if crate::node::is_info() {
                println!("[INFO][PROOFVIEW] view_promoted index={} height={} root={} views={}",
                         promoted, height, hex::encode(&root[..8]), views);
            }
        } else if crate::node::is_debug() {
            println!("[DBG][PROOFVIEW] view_promoted index={} height={} root={} views={}",
                     promoted, height, hex::encode(&root[..8]), views);
        }
        for (i, v) in retired {
            if near {
                if crate::node::is_info() {
                    println!("[INFO][PROOFVIEW] view_retired index={} reason=superseded", i);
                }
            } else if crate::node::is_debug() {
                println!("[DBG][PROOFVIEW] view_retired index={} reason=superseded", i);
            }
            drop(v);
        }
    }

    /// Macroblock `idx` became present: the candidate at 90·idx is due now.
    pub(crate) fn on_macroblock_saved(&self, idx: u64) {
        self.newest_certified.fetch_max(idx, Ordering::SeqCst);
        if let Some(c) = self.reg.lock().candidates.get_mut(&(idx * MB_INTERVAL)) {
            c.due = true;
        }
        self.wake_now();
    }

    fn macroblock_stored(&self, index: u64) -> bool {
        self.main.cf_handle("microblocks")
            .and_then(|cf| self.main.get_cf(&cf, format!("macroblock_{}", index).as_bytes()).ok().flatten())
            .map_or(false, |v| !v.is_empty())
    }

    /// Macroblock `idx` was deleted: a view at idx goes back to the candidates, unserved, and
    /// re-promotes if the certified copy is stored again with the same root. `last_sealed` floors
    /// the newest certified index, capped below idx since its hint may still name idx.
    pub(crate) fn on_macroblock_deleted(&self, idx: u64, last_sealed: u64) {
        let (demoted, dropped) = {
            let mut reg = self.reg.lock();
            let demoted = reg.views.remove(&idx).map(|v| {
                let mut c = Candidate::new(v.height, v.seq);
                c.tree = Some((v.root, v.tree.clone()));
                c.aux = Some(v.aux.clone());
                reg.candidates.insert(v.height, c);
                idx
            });
            let mut dropped = Vec::new();
            while reg.candidates.len() > PROOF_CANDIDATES_KEPT {
                if let Some((h, c)) = reg.candidates.pop_first() { dropped.push((h, c)); }
            }
            if demoted.is_some() { Self::publish(&reg, &self.published); }
            (demoted, dropped)
        };
        if let Some(i) = demoted {
            if crate::node::is_warn() {
                println!("[WARN][PROOFVIEW] view_demoted index={} reason=macroblock_deleted", i);
            }
        }
        for (h, c) in dropped { self.drop_offer(h, "cap"); drop(c); }
        if self.newest_certified.load(Ordering::SeqCst) == idx {
            let floor = last_sealed.min(idx.saturating_sub(1));
            let found = (idx.saturating_sub(NEWEST_PROBE_DEPTH)..idx).rev().find(|k| *k > 0 && self.macroblock_stored(*k));
            let newest = found.unwrap_or(0).max(floor);
            let _ = self.newest_certified.compare_exchange(idx, newest, Ordering::SeqCst, Ordering::SeqCst);
        }
    }

    /// The chain above `target` was abandoned: candidates and views above it go.
    pub(crate) fn retract_above(&self, target: u64) {
        let (cands, views) = {
            let mut reg = self.reg.lock();
            let cands: Vec<(u64, Candidate)> = {
                let hs: Vec<u64> = reg.candidates.range(target + 1..).map(|(h, _)| *h).collect();
                hs.into_iter().filter_map(|h| reg.candidates.remove(&h).map(|c| (h, c))).collect()
            };
            let idxs: Vec<u64> = reg.views.iter().filter(|(_, v)| v.height > target).map(|(i, _)| *i).collect();
            let views: Vec<Arc<View>> = idxs.into_iter().filter_map(|i| reg.views.remove(&i)).collect();
            if !views.is_empty() { Self::publish(&reg, &self.published); }
            (cands, views)
        };
        for (h, c) in cands { self.drop_offer(h, "retracted"); drop(c); }
        for v in views {
            if crate::node::is_warn() {
                println!("[WARN][PROOFVIEW] view_retracted index={} target={}", v.index, target);
            }
        }
    }

    /// Drop every view and candidate. Returns how many entries went.
    pub(crate) fn release_all(&self) -> usize {
        let gone = {
            let mut reg = self.reg.lock();
            let gone = (std::mem::take(&mut reg.candidates), std::mem::take(&mut reg.views));
            Self::publish(&reg, &self.published);
            gone
        };
        gone.0.len() + gone.1.len()
    }

    /// Re-read every held view's macroblock: a view whose certificate vanished or changed is
    /// demoted. Catches a deletion path that ever bypasses the hook.
    pub(crate) fn revalidate_views(&self) {
        let held: Vec<(u64, [u8; 32])> = self.current().views.iter().map(|v| (v.index, v.root)).collect();
        for (index, root) in held {
            let ok = matches!(self.read_certified(index),
                Certified::Root { cp_root, mb_root, .. } if cp_root == root && mb_root == root);
            if ok { continue; }
            let demoted = {
                let mut reg = self.reg.lock();
                let v = reg.views.remove(&index);
                if let Some(ref v) = v {
                    let mut c = Candidate::new(v.height, v.seq);
                    c.tree = Some((v.root, v.tree.clone()));
                    c.aux = Some(v.aux.clone());
                    reg.candidates.insert(v.height, c);
                    while reg.candidates.len() > PROOF_CANDIDATES_KEPT { reg.candidates.pop_first(); }
                    Self::publish(&reg, &self.published);
                }
                v
            };
            if demoted.is_some() && crate::node::is_warn() {
                println!("[WARN][PROOFVIEW] view_demoted index={} reason=revalidate_failed", index);
            }
        }
    }

    /// One pass of the worker. Correctness never depends on a hook arriving: due candidates and
    /// candidates unchecked for 30 s are re-read every pass.
    pub(crate) fn tick(&self, now: Instant) {
        self.disk_pressure_step(now);
        // An atomic read: storage is read only when some macroblock became present since the last tick.
        let save_seq = super::macroblock_save_seq();
        let saved = self.last_save_seq.swap(save_seq, Ordering::SeqCst) != save_seq;
        let due: Vec<u64> = {
            let reg = self.reg.lock();
            reg.candidates.values()
                .filter(|c| c.complete() && (saved || c.due
                    || c.checked_at.map_or(true, |t| now.duration_since(t) >= CANDIDATE_RECHECK)))
                .map(|c| c.height)
                .collect()
        };
        for h in due { self.try_promote(h); }
        let (revalidate, stats, legacy) = {
            let mut t = self.timers.lock();
            let r = now.duration_since(t.revalidate) >= REVALIDATE_EVERY;
            if r { t.revalidate = now; }
            let s = now.duration_since(t.stats) >= STATS_EVERY;
            if s { t.stats = now; }
            let l = now.duration_since(t.legacy) >= LEGACY_POLL_EVERY;
            if l { t.legacy = now; }
            (r, s, l)
        };
        if revalidate {
            self.revalidate_views();
            self.space_amplification_step();
        }
        if legacy { self.legacy_retirement_step(now); }
        if stats { self.log_stats(); }
        self.view_missed_step();
    }

    /// Release every view once per pressure episode, never compacting; resume only on a fresh
    /// measurement below `VIEWS_RESUME_PCT`, never on the hourly cached value.
    pub(crate) fn disk_pressure_step(&self, now: Instant) {
        if !self.disk_latched.load(Ordering::SeqCst) {
            if (self.probes.read().critically_full)() {
                self.disk_latched.store(true, Ordering::SeqCst);
                self.pressure_releases.fetch_add(1, Ordering::SeqCst);
                let released = self.release_all();
                self.timers.lock().fresh = now;
                if crate::node::is_warn() {
                    println!("[WARN][PROOFVIEW] views_released reason=disk_pressure released={}", released);
                }
            }
            return;
        }
        {
            let mut t = self.timers.lock();
            if now.duration_since(t.fresh) < FRESH_MEASURE_EVERY { return; }
            t.fresh = now;
        }
        if let Some(pct) = (self.probes.read().fresh_usage_pct)() {
            if pct < VIEWS_RESUME_PCT {
                self.disk_latched.store(false, Ordering::SeqCst);
                if crate::node::is_info() {
                    println!("[INFO][PROOFVIEW] views_resumed pct={:.1}", pct);
                }
            }
        }
    }

    /// Retire the oldest view while the derived DBs hold more than `VIEW_SPACE_AMP_LIMIT` times
    /// their live data: at very high churn the snapshots would otherwise pin several copies.
    pub(crate) fn space_amplification_step(&self) {
        let (total, live) = (self.probes.read().space)();
        if live == 0 || total < SPACE_AMP_MIN_BYTES || (total as f64) <= VIEW_SPACE_AMP_LIMIT * live as f64 {
            return;
        }
        let retired = {
            let mut reg = self.reg.lock();
            if reg.views.len() < 2 { return; }
            let r = reg.views.pop_first();
            Self::publish(&reg, &self.published);
            r
        };
        if let Some((i, v)) = retired {
            if crate::node::is_info() {
                println!("[INFO][PROOFVIEW] view_retired index={} reason=space_amplification total={} live={}", i, total, live);
            }
            drop(v);
        }
    }

    fn legacy_retirement_step(&self, now: Instant) {
        if self.legacy_done.load(Ordering::SeqCst) { return; }
        if now.duration_since(self.born) >= LEGACY_RETIRE_WINDOW {
            self.legacy_done.store(true, Ordering::SeqCst);
            return;
        }
        if self.tree_rebuilt.load(Ordering::SeqCst) {
            super::tree_db::retire_legacy_merkle(&self.main);
            self.legacy_done.store(true, Ordering::SeqCst);
        }
    }

    /// A certified index this node applied past and holds no view or candidate for, once each.
    fn view_missed_step(&self) {
        let newest = self.newest_certified.load(Ordering::SeqCst);
        let applied = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::SeqCst);
        let mut missed = Vec::new();
        {
            let mut reg = self.reg.lock();
            let newest_view = reg.views.keys().next_back().copied().unwrap_or(0);
            for index in newest.saturating_sub(2)..=newest {
                if index == 0 || index <= newest_view || index.saturating_mul(MB_INTERVAL) > applied { continue; }
                if reg.candidates.contains_key(&(index * MB_INTERVAL)) { continue; }
                if reg.missed_logged.insert(index) { missed.push(index); }
            }
            let floor = newest.saturating_sub(16);
            reg.missed_logged.retain(|i| *i >= floor);
            reg.mismatch_logged.retain(|i| *i >= floor);
        }
        if crate::node::is_warn() {
            for index in missed {
                println!("[WARN][PROOFVIEW] view_missed index={} reason=no_candidate", index);
            }
        }
    }

    fn log_stats(&self) {
        if !crate::node::is_info() { return; }
        let (views, candidates) = {
            let reg = self.reg.lock();
            (reg.views.len(), reg.candidates.len())
        };
        // What RocksDB itself holds open, in-flight proofs included: the bound is per DB.
        let (tree_snaps, aux_snaps) = self.rocksdb_snapshots();
        let snapshots = tree_snaps.max(aux_snaps);
        let s = &self.stats;
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        println!("[INFO][PROOFVIEW] stats served={} cache_hits={} busy={} rate_limited={} not_certified={} not_retained={} \
                  unavailable={} self_check_failed={} preimage_fallback={} views={} candidates={} snapshots={} \
                  aux_queue_bytes={} newest_certified_index={}",
                 g(&s.served), g(&s.cache_hits), g(&s.busy), g(&s.rate_limited), g(&s.not_certified), g(&s.not_retained),
                 g(&s.unavailable), g(&s.self_check_failed), g(&s.preimage_fallback), views, candidates, snapshots,
                 self.aux_queued.load(Ordering::Relaxed), self.newest_certified_index());
    }

    /// (candidate heights, view indices).
    #[cfg(test)]
    pub(crate) fn held(&self) -> (Vec<u64>, Vec<u64>) {
        let reg = self.reg.lock();
        (reg.candidates.keys().copied().collect(), reg.views.keys().copied().collect())
    }

    /// The candidate at `height`: (seq, has tree part, has aux part).
    #[cfg(test)]
    pub(crate) fn candidate(&self, height: u64) -> Option<(u64, bool, bool)> {
        self.reg.lock().candidates.get(&height).map(|c| (c.seq, c.tree.is_some(), c.aux.is_some()))
    }

    /// RocksDB snapshots currently open on the (tree, aux) DBs.
    pub(crate) fn rocksdb_snapshots(&self) -> (u64, u64) {
        let n = |db: &DB| db.property_int_value("rocksdb.num-snapshots").ok().flatten().unwrap_or(0);
        (n(&self.tree), n(&self.aux))
    }
}

impl Storage {
    /// Queue the proof view capture at boundary `height` behind this block's rows. Called under the
    /// lock that applied the block, after its rows and before the frontier moves. Both parts are
    /// taken on the writer threads; nothing here waits for I/O.
    pub fn request_proof_view(&self, sg: &crate::StateManager, height: u64) {
        if height == 0 || height % MB_INTERVAL != 0 {
            return;
        }
        let views = &self.persistent.views;
        views.set_store_write_failed(sg.merkle_store_write_failed());
        if let Some(reason) = views.refusal() {
            views.drop_offer(height, reason);
            return;
        }
        if sg.merkle_is_dirty() {
            if crate::node::is_warn() {
                println!("[WARN][PROOFVIEW] marker_on_dirty_tree height={}", height);
            }
            return;
        }
        let seq = sg.merkle_row_seq();
        self.persistent.aux.send_marker(height, seq);
        let tree = self.persistent.tree.db.clone();
        let v = Arc::clone(views);
        sg.after_merkle_flush(height, Box::new(move |root, seq| {
            let snap = PinnedDbSnapshot::of(&tree);
            v.offer_part(height, seq, Part::Tree(root, snap));
        }));
    }

    /// The certified proof views (read path).
    pub fn proof_views(&self) -> &Arc<ProofViews> {
        &self.persistent.views
    }
}

/// A frozen tree read through one view: the account tree from the tree snapshot, or one
/// contract's storage tree from the aux snapshot. Every read skips the block cache, range reads
/// re-seek one raw iterator, and every failure is reported, never read as absence.
pub(crate) struct SnapshotTreeReader<'a> {
    snap: &'a PinnedDbSnapshot,
    leaves_cf: &'static str,
    nodes_cf: &'static str,
    prefix: Option<[u8; 32]>,
    iter: Option<rocksdb::DBRawIteratorWithThreadMode<'a, DB>>,
}

impl<'a> SnapshotTreeReader<'a> {
    /// The account tree of a view.
    pub(crate) fn accounts(view: &'a View) -> Self {
        Self { snap: &view.tree, leaves_cf: CF_ACCT_LEAVES, nodes_cf: CF_ACCT_NODES, prefix: None, iter: None }
    }

    /// Contract `contract_hash`'s storage tree in a view. Its rows under single buckets may be left
    /// over from an earlier node set, so it is proven with `StoredRows::Branches`.
    pub(crate) fn storage(view: &'a View, contract_hash: [u8; 32]) -> Self {
        Self {
            snap: &view.aux,
            leaves_cf: super::aux_db::CF_STOR_LEAVES,
            nodes_cf: super::aux_db::CF_STOR_NODES,
            prefix: Some(contract_hash),
            iter: None,
        }
    }

    fn key(&self, tail: &[u8]) -> Vec<u8> {
        let mut k = Vec::with_capacity(32 + tail.len());
        if let Some(p) = self.prefix { k.extend_from_slice(&p); }
        k.extend_from_slice(tail);
        k
    }
}

impl qnet_state::TreeReader for SnapshotTreeReader<'_> {
    fn node(&mut self, depth: u32, key: &[u8; 32]) -> Result<Option<[u8; 32]>, qnet_state::ReadFault> {
        let k = self.key(&super::tree_db::node_db_key(depth, key));
        match self.snap.get_cf_opt(self.nodes_cf, &k, no_cache()) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Ok(Some(out)) }
            Ok(Some(_)) => Err(qnet_state::ReadFault::Malformed),
            Ok(None) => Ok(None),
            Err(_) => Err(qnet_state::ReadFault::Io),
        }
    }

    fn leaves(&mut self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Result<Vec<([u8; 32], [u8; 32])>, qnet_state::ReadFault> {
        let lo_k = self.key(lo);
        let hi_k = self.key(hi);
        let key_len = hi_k.len();
        if self.iter.is_none() {
            self.iter = Some(self.snap.raw_iterator_cf_opt(self.leaves_cf, no_cache()).ok_or(qnet_state::ReadFault::Io)?);
        }
        let it = self.iter.as_mut().expect("created above");
        let mut out = Vec::new();
        it.seek(&lo_k);
        while it.valid() && out.len() < limit {
            let (k, v) = match (it.key(), it.value()) { (Some(k), Some(v)) => (k, v), _ => break };
            if k > &hi_k[..] { break; }
            if k.len() != key_len || v.len() != 32 { return Err(qnet_state::ReadFault::Malformed); }
            let mut key = [0u8; 32];
            let mut val = [0u8; 32];
            key.copy_from_slice(&k[key_len - 32..]);
            val.copy_from_slice(v);
            out.push((key, val));
            it.next();
        }
        it.status().map_err(|_| qnet_state::ReadFault::Io)?;
        Ok(out)
    }
}

/// A storage with a state manager attached as a node wires them, for the tests of every layer that
/// reads certified views.
#[cfg(test)]
pub(crate) mod rig {
    use super::*;
    use qnet_state::Account;

    pub(crate) struct Rig {
        pub(crate) st: Arc<Storage>,
        pub(crate) sm: crate::StateManager,
        pub(crate) dir: tempfile::TempDir,
    }

    pub(crate) fn attach(st: &Storage) -> crate::StateManager {
        let sm = crate::StateManager::new();
        sm.set_merkle_node_store(st.merkle_node_store());
        sm.set_proof_aux_sink(st.proof_aux_sink());
        sm
    }

    pub(crate) fn rig() -> Rig {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Arc::new(Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let sm = attach(&st);
        Rig { st, sm, dir }
    }

    pub(crate) fn wallet(i: u64, balance: u64) -> Account {
        let mut a = Account::new(format!("eon_pv_{:06}", i));
        a.balance = balance;
        a
    }

    /// One block: some balances move, the tree finalizes. Returns the root after it.
    pub(crate) fn block(r: &Rig, h: u64) -> [u8; 32] {
        for i in 0..3 {
            let a = wallet((h * 7 + i) % 50, 1_000 + h * 10 + i);
            r.sm.update_account(a.address.clone(), a);
        }
        r.sm.finalize_merkle()
    }

    /// Everything the two writers hold has been handed to the registry.
    pub(crate) fn settle(r: &Rig) {
        r.sm.merkle_flush_barrier();
        r.st.persistent.aux.drain();
    }

    /// Apply blocks up to `h` (a boundary) and request its view.
    pub(crate) fn advance_to(r: &Rig, from: u64, h: u64) -> [u8; 32] {
        let mut root = [0u8; 32];
        for b in from..=h { root = block(r, b); }
        r.st.request_proof_view(&r.sm, h);
        settle(r);
        root
    }

    /// Request the view at boundary `h` after the caller applied its blocks, and certify it.
    pub(crate) fn certify(r: &Rig, h: u64, root: [u8; 32]) {
        r.st.request_proof_view(&r.sm, h);
        settle(r);
        store_mb(r, h / MB_INTERVAL, root);
    }

    pub(crate) fn certified_mb(j: u64, root: [u8; 32]) -> qnet_state::MacroBlock {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate};
        let cp = Checkpoint {
            index: j, parent_qc: None, window_head_height: j * MB_INTERVAL, window_mb_hashes: vec![[7u8; 32]],
            state_root: root, beacon: [3u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32], total_supply: 0, timestamp: 0,
            proposer: "genesis_node_001".to_string(), proposer_sig: Vec::new(), recovery_anchor: None,
        };
        let qc = QuorumCertificate { checkpoint_hash: cp.hash(), index: j, signers: Vec::new(),
                                     sig_merkle_root: [0u8; 32], sigs: Vec::new() };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp, qc)).unwrap());
        qnet_state::MacroBlock::new(j, 0, [0u8; 32], vec![[7u8; 32]], root, cd)
    }

    /// Store macroblock `j` certifying `root`, as a seal or a sync ingest does.
    pub(crate) fn store_mb(r: &Rig, j: u64, root: [u8; 32]) {
        let cf = r.st.persistent.db.cf_handle("microblocks").unwrap();
        r.st.persistent.db.put_cf(&cf, format!("macroblock_{}", j).as_bytes(), bincode::serialize(&certified_mb(j, root)).unwrap()).unwrap();
        r.st.persistent.views.on_macroblock_saved(j);
    }

    pub(crate) fn wait_for(what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {}", what);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(crate) fn view_indices(r: &Rig) -> Vec<u64> {
        r.st.proof_views().current().views.iter().map(|v| v.index).collect()
    }

    /// Drop `address`'s preimage row from the live aux DB, so the next capture holds none for it.
    pub(crate) fn delete_preimage(r: &Rig, address: &str) {
        let db = r.st.persistent.aux.db();
        let cf = db.cf_handle(super::super::aux_db::CF_ACCT_PRE).unwrap();
        db.delete_cf(&cf, qnet_state::StateMerkleTree::hash_address(address)).unwrap();
    }

    /// Write `account` as the live accounts row (and a contract's slots), as the accounts mirror does.
    pub(crate) fn put_live_account(r: &Rig, account: &Account) {
        let db = &r.st.persistent.db;
        let rows = db.cf_handle("accounts").unwrap();
        db.put_cf(&rows, account.address.as_bytes(), bincode::serialize(account).unwrap()).unwrap();
        let slots = db.cf_handle("contract_storage").unwrap();
        for (k, v) in &account.contract_storage {
            db.put_cf(&slots, format!("{}\x00{}", account.address, k).as_bytes(), v.as_bytes()).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::rig::*;
    use qnet_state::{Account, AccountLeafPreimage, LeafProofKind, StateMerkleTree};
    use std::collections::HashMap;

    #[test]
    fn snapshot_reads_equal_live_reads_and_stay_frozen() {
        let r = rig();
        let root = advance_to(&r, 1, 90);
        let tree_snap = PinnedDbSnapshot::of(&r.st.persistent.tree.db);
        let aux_snap = PinnedDbSnapshot::of(r.st.persistent.aux.db_arc());
        let read_all = |snap: &PinnedDbSnapshot, cf: &str| -> Vec<(Vec<u8>, Vec<u8>)> {
            let mut it = snap.raw_iterator_cf_opt(cf, no_cache()).expect("family");
            it.seek_to_first();
            let mut out = Vec::new();
            while it.valid() { out.push((it.key().unwrap().to_vec(), it.value().unwrap().to_vec())); it.next(); }
            out
        };
        let live = |db: &DB, cf: &str| -> Vec<(Vec<u8>, Vec<u8>)> {
            let h = db.cf_handle(cf).unwrap();
            db.iterator_cf(&h, rocksdb::IteratorMode::Start).map(|kv| { let (k, v) = kv.unwrap(); (k.to_vec(), v.to_vec()) }).collect()
        };
        let before_tree = read_all(&tree_snap, CF_ACCT_NODES);
        let before_pre = read_all(&aux_snap, super::super::aux_db::CF_ACCT_PRE);
        assert_eq!(before_tree, live(&r.st.persistent.tree.db, CF_ACCT_NODES), "a fresh snapshot reads what the live DB holds");
        assert_eq!(before_pre, live(r.st.persistent.aux.db(), super::super::aux_db::CF_ACCT_PRE));
        for h in 91..=290 { block(&r, h); }
        settle(&r);
        assert_eq!(read_all(&tree_snap, CF_ACCT_NODES), before_tree, "200 later blocks do not move the tree snapshot");
        assert_eq!(read_all(&aux_snap, super::super::aux_db::CF_ACCT_PRE), before_pre, "nor the aux snapshot");
        assert_ne!(live(&r.st.persistent.tree.db, CF_ACCT_NODES), before_tree, "while the live tree moved on");
        let row = tree_snap.get_cf_opt(CF_ACCT_NODES, &super::super::tree_db::node_db_key(ROOT_DEPTH, &[0u8; 32]), no_cache()).unwrap();
        assert_eq!(row.as_deref(), Some(&root[..]), "the snapshot's root row is the root at 90");
    }

    #[test]
    fn views_promote_only_on_matching_certified_root() {
        let r = rig();
        // Offer first, macroblock after.
        let root90 = advance_to(&r, 1, 90);
        assert!(view_indices(&r).is_empty(), "uncertified: not served");
        store_mb(&r, 1, root90);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        // Macroblock first, offer after.
        let mut root180 = [0u8; 32];
        for h in 91..=180 { root180 = block(&r, h); }
        store_mb(&r, 2, root180);
        r.st.request_proof_view(&r.sm, 180);
        settle(&r);
        wait_for("view 2", || view_indices(&r) == vec![2, 1]);
        // A certificate for another root: never served.
        let _ = advance_to(&r, 181, 270);
        store_mb(&r, 3, [0xEE; 32]);
        wait_for("mismatch dropped", || r.st.proof_views().held().0.is_empty());
        assert_eq!(view_indices(&r), vec![2, 1], "a root the certificate does not name is never served");
    }

    #[test]
    fn views_hold_at_most_three_views_and_two_candidates() {
        let r = rig();
        let mut roots: HashMap<u64, [u8; 32]> = HashMap::new();
        let mut next_block = 1;
        let mut stored = 0u64;
        for k in 1..=20u64 {
            roots.insert(k, advance_to(&r, next_block, k * MB_INTERVAL));
            next_block = k * MB_INTERVAL + 1;
            // Seal lag of 0, 1 or 2 windows (0-180 blocks).
            let lag = k % 3;
            while stored + lag < k {
                stored += 1;
                store_mb(&r, stored, roots[&stored]);
            }
            std::thread::sleep(Duration::from_millis(30));
            let (cands, views) = r.st.proof_views().held();
            assert!(cands.len() <= PROOF_CANDIDATES_KEPT && views.len() <= PROOF_VIEWS_KEPT, "k={} {:?} {:?}", k, cands, views);
            let (t, a) = r.st.proof_views().rocksdb_snapshots();
            assert!(t <= 5 && a <= 5, "k={}: snapshots tree={} aux={}", k, t, a);
        }
        while stored < 20 { stored += 1; store_mb(&r, stored, roots[&stored]); }
        wait_for("the newest three", || view_indices(&r) == vec![20, 19, 18]);
        let (t, a) = r.st.proof_views().rocksdb_snapshots();
        assert!(t <= 5 && a <= 5);
    }

    #[test]
    fn offer_never_blocks_a_writer() {
        let r = rig();
        let root = advance_to(&r, 1, 90);
        store_mb(&r, 1, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        // A slow reader holds the served set while the writers offer.
        let views = r.st.proof_views().clone();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let reader = std::thread::spawn(move || {
            let guard = views.published.read();
            let _pinned = guard.views.first().cloned();
            held_tx.send(()).unwrap();
            let _ = done_rx.recv();
        });
        held_rx.recv().unwrap();
        let mut times = Vec::new();
        for h in 91..=110 {
            block(&r, h);
            r.sm.merkle_flush_barrier();
            let snap = PinnedDbSnapshot::of(&r.st.persistent.tree.db);
            let t0 = Instant::now();
            r.st.proof_views().offer_part(180, r.sm.merkle_row_seq(), Part::Tree(r.sm.get_merkle_state_root(), snap));
            times.push(t0.elapsed());
        }
        times.sort();
        assert!(times[times.len() / 2] < Duration::from_millis(10), "median offer {:?}", times[times.len() / 2]);
        assert!(*times.last().unwrap() < Duration::from_millis(250), "worst offer {:?}", times.last());
        done_tx.send(()).unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn a_new_offer_drops_candidates_at_or_above_its_height() {
        let r = rig();
        let _ = advance_to(&r, 1, 90);
        let first = r.st.proof_views().candidate(90).expect("candidate at 90").0;
        let _ = advance_to(&r, 91, 180);
        assert!(r.st.proof_views().candidate(180).is_some());
        let stale_aux = PinnedDbSnapshot::of(&r.st.persistent.aux.db_arc());
        // The chain went back to 90 and re-applied it: a newer finalize offered at 90.
        block(&r, 90);
        r.st.request_proof_view(&r.sm, 90);
        settle(&r);
        let now = r.st.proof_views().candidate(90).expect("candidate at 90");
        assert!(now.0 > first && now.1 && now.2, "the re-applied 90 replaced the old candidate");
        assert!(r.st.proof_views().candidate(180).is_none(), "the abandoned 180 is gone");
        // A late part of the old finalize is dropped, not paired.
        r.st.proof_views().offer_part(90, first, Part::Aux(stale_aux));
        assert_eq!(r.st.proof_views().candidate(90).map(|c| c.0), Some(now.0));
    }

    #[test]
    fn parts_from_different_finalizes_never_pair() {
        let r = rig();
        for h in 1..=90 { block(&r, h); }
        settle(&r);
        let s = r.sm.merkle_row_seq();
        let root = r.sm.get_merkle_state_root();
        r.st.proof_views().offer_part(90, s, Part::Tree(root, PinnedDbSnapshot::of(&r.st.persistent.tree.db)));
        block(&r, 91);
        settle(&r);
        let s2 = r.sm.merkle_row_seq();
        assert!(s2 > s);
        r.st.proof_views().offer_part(90, s2, Part::Aux(PinnedDbSnapshot::of(&r.st.persistent.aux.db_arc())));
        store_mb(&r, 1, root);
        std::thread::sleep(Duration::from_millis(200));
        r.st.proof_views().tick(Instant::now());
        assert!(view_indices(&r).is_empty(), "a tree part of seq s and an aux part of seq s+1 never make a view");
    }

    #[test]
    fn deleting_a_macroblock_demotes_its_view() {
        let r = rig();
        let root = advance_to(&r, 1, 90);
        store_mb(&r, 1, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        r.st.persistent.delete_macroblock(1).expect("delete");
        assert!(view_indices(&r).is_empty(), "a deleted macroblock's view is not served");
        assert!(r.st.proof_views().candidate(90).is_some(), "it waits as a candidate");
        store_mb(&r, 1, root);
        wait_for("re-promoted", || view_indices(&r) == vec![1]);
        r.st.retract_chain_position_above(0);
        assert!(view_indices(&r).is_empty());
        assert!(r.st.proof_views().held().0.is_empty(), "retraction drops it outright");
    }

    #[test]
    fn revalidation_demotes_a_view_whose_macroblock_vanished() {
        let r = rig();
        let root = advance_to(&r, 1, 90);
        store_mb(&r, 1, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        // A deletion that bypasses the hook.
        let cf = r.st.persistent.db.cf_handle("microblocks").unwrap();
        r.st.persistent.db.delete_cf(&cf, b"macroblock_1").unwrap();
        assert_eq!(view_indices(&r), vec![1]);
        r.st.proof_views().revalidate_views();
        assert!(view_indices(&r).is_empty(), "the 60 s re-validation demotes it");
    }

    #[test]
    fn newest_certified_index_tracks_saves_and_deletes() {
        let r = rig();
        let v = r.st.proof_views();
        assert_eq!(v.newest_certified_index(), 0);
        store_mb(&r, 5, [1u8; 32]);
        store_mb(&r, 3, [1u8; 32]);
        assert_eq!(v.newest_certified_index(), 5, "out-of-order saves raise it");
        r.st.persistent.delete_macroblock(5).expect("delete");
        assert_eq!(v.newest_certified_index(), 3, "deleting the top lowers it to the next stored index");
        r.st.persistent.delete_macroblock(1).expect("delete below");
        assert_eq!(v.newest_certified_index(), 3, "deleting below the top changes nothing");
    }

    #[test]
    fn proofs_at_a_view_ignore_later_blocks() {
        let r = rig();
        let token = "eon_pv_token";
        let holders: HashMap<String, String> = (0..2_000u64)
            .map(|i| (format!("balance:eon_pv_h{:05}", i), format!("{}", 1 + i % 977))).collect();
        let mut c = Account::new(token.to_string());
        c.is_contract = true;
        c.contract_code_hash = Some("cd".repeat(32));
        c.contract_storage = holders;
        c.storage_root = StateMerkleTree::compute_storage_root(&c.contract_storage);
        let mut all: Vec<(String, Account)> = (0..5_000u64).map(|i| { let a = wallet(i, 10_000 + i); (a.address.clone(), a) }).collect();
        all.push((token.to_string(), c));
        r.sm.restore_accounts(all).expect("restore");
        let mut rng = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || { rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); rng >> 17 };
        let mut models: HashMap<u64, (HashMap<String, Account>, [u8; 32])> = HashMap::new();
        for h in 1..=300u64 {
            for _ in 0..20 {
                let i = next() % 5_200; // some new accounts too
                let a = wallet(i, 1 + next() % 1_000_000);
                r.sm.update_account(a.address.clone(), a);
            }
            if h % 3 == 0 {
                let mut tok = r.sm.get_account(token).unwrap();
                for _ in 0..5 {
                    let k = format!("balance:eon_pv_h{:05}", next() % 2_100);
                    if next() % 4 == 0 { tok.contract_storage.remove(&k); } else { tok.contract_storage.insert(k, format!("{}", next() % 99_999)); }
                }
                r.sm.update_account(token.to_string(), tok);
            }
            let root = r.sm.finalize_merkle();
            if h % MB_INTERVAL == 0 {
                r.st.request_proof_view(&r.sm, h);
                settle(&r);
                models.insert(h / MB_INTERVAL, (r.sm.get_all_accounts().into_iter().collect(), root));
                store_mb(&r, h / MB_INTERVAL, root);
            }
        }
        wait_for("three views", || view_indices(&r) == vec![3, 2, 1]);
        let set = r.st.proof_views().current();
        for view in set.views.iter() {
            let (model, root) = &models[&view.index];
            assert_eq!(view.root, *root);
            let mut t = StateMerkleTree::new();
            for (a, acc) in model { t.insert_lazy(a, acc); }
            assert_eq!(t.finalize(), *root, "the model is the state at 90j");
            let mut reader = SnapshotTreeReader::accounts(view);
            let mut probe: Vec<String> = (0..5_200u64).step_by(173).map(|i| wallet(i, 0).address).collect();
            probe.push(token.to_string());
            for addr in probe {
                let key = StateMerkleTree::hash_address(&addr);
                let p = qnet_state::prove_leaf(&mut reader, &key).expect("proves");
                assert_eq!(p.steps, t.generate_proof(&addr), "index {} {}: steps of the model tree", view.index, addr);
                match model.get(&addr) {
                    Some(acc) => {
                        let raw = view.aux.get_cf_opt(super::super::aux_db::CF_ACCT_PRE, &key, no_cache()).unwrap().expect("preimage row");
                        let pre = AccountLeafPreimage::decode(&raw).expect("decodes");
                        assert_eq!(pre, AccountLeafPreimage::of(acc));
                        assert!(qnet_state::verify_account_proof(&addr, Some(&pre), &p.kind, &p.steps, root));
                    }
                    None => {
                        assert_eq!(p.kind, LeafProofKind::Absence);
                        assert!(qnet_state::verify_account_proof(&addr, None, &p.kind, &p.steps, root));
                    }
                }
            }
            // The token: its storage tree at 90j, from the aux snapshot.
            let tok = &model[token];
            let mut model_storage = StateMerkleTree::build_storage_tree(&tok.contract_storage);
            assert_eq!(model_storage.root(), tok.storage_root);
            let mut sreader = SnapshotTreeReader::storage(view, StateMerkleTree::hash_address(token));
            for i in (0..2_100u64).step_by(97) {
                let k = format!("balance:eon_pv_h{:05}", i);
                let sk = StateMerkleTree::hash_storage_key(&k);
                let p = qnet_state::prove_leaf_in(&mut sreader, &sk, qnet_state::StoredRows::Branches).expect("proves");
                assert_eq!(p.steps, model_storage.generate_raw_proof(&k), "index {} {}", view.index, k);
                let value = tok.contract_storage.get(&k).map(|s| s.as_str());
                if let Some(v) = value {
                    let ck = super::super::aux_db::stor_leaf_key(&StateMerkleTree::hash_address(token), &sk);
                    let raw = view.aux.get_cf_opt(super::super::aux_db::CF_STOR_PRE, &ck, no_cache()).unwrap().expect("value row");
                    assert_eq!(raw, v.as_bytes());
                }
                assert!(qnet_state::verify_storage_proof(&k, value, &p.kind, &p.steps, &tok.storage_root));
            }
        }
    }

    #[test]
    fn boot_replay_restores_views() {
        let r = rig();
        let accts: Vec<(String, Account)> = (0..40u64).map(|i| { let a = wallet(i, 500 + i); (a.address.clone(), a) }).collect();
        // Tier 1: the anchor restore at 90, its macroblock already stored.
        let anchor = r.sm.restore_accounts_streamed(accts.clone().into_iter()).expect("restore");
        store_mb(&r, 1, anchor);
        r.st.request_proof_view(&r.sm, 90);
        settle(&r);
        wait_for("the anchor view", || view_indices(&r) == vec![1]);
        // The replay above it: blocks 91..270 with their macroblocks stored before they replay.
        let mut roots = HashMap::new();
        {
            let probe = rig();
            probe.sm.restore_accounts_streamed(accts.clone().into_iter()).expect("restore");
            for h in 91..=270 { let root = block(&probe, h); if h % MB_INTERVAL == 0 { roots.insert(h / MB_INTERVAL, root); } }
        }
        store_mb(&r, 2, roots[&2]);
        store_mb(&r, 3, roots[&3]);
        for h in 91..=270 {
            block(&r, h);
            if h % MB_INTERVAL == 0 { r.st.request_proof_view(&r.sm, h); }
        }
        settle(&r);
        wait_for("views after the first boot", || view_indices(&r) == vec![3, 2, 1]);
        // Restart: views do not survive it, and the same boot brings them back.
        let path = r.dir.path().to_str().unwrap().to_string();
        let Rig { st, sm, dir } = r;
        drop(sm);
        drop(st);
        let st = Arc::new(Storage::new(&path).expect("reopen"));
        assert!(st.proof_views().current().views.is_empty(), "no view survives a restart");
        let sm = attach(&st);
        let r = Rig { st, sm, dir };
        let anchor2 = r.sm.restore_accounts_streamed(accts.into_iter()).expect("restore");
        assert_eq!(anchor2, anchor);
        r.st.request_proof_view(&r.sm, 90);
        settle(&r);
        wait_for("the anchor view after the restart", || view_indices(&r) == vec![1]);
        for h in 91..=270 {
            block(&r, h);
            if h % MB_INTERVAL == 0 { r.st.request_proof_view(&r.sm, h); }
        }
        settle(&r);
        wait_for("views after the restart", || view_indices(&r) == vec![3, 2, 1]);
    }

    #[test]
    fn capture_refused_after_store_write_failure() {
        let r = rig();
        for h in 1..=89 { block(&r, h); }
        settle(&r);
        // A chunked write that fails at its second chunk leaves neither root row nor seq.
        r.st.persistent.tree.chunk_bytes.store(256, Ordering::SeqCst);
        r.st.persistent.tree.fail_at_chunk.store(2, Ordering::SeqCst);
        let root = block(&r, 90);
        r.sm.merkle_flush_barrier();
        r.st.persistent.tree.fail_at_chunk.store(0, Ordering::SeqCst);
        r.st.persistent.tree.chunk_bytes.store(super::super::tree_db::TREE_WRITE_CHUNK_BYTES, Ordering::SeqCst);
        assert!(r.sm.merkle_store_write_failed(), "the failure latched");
        r.st.proof_views().offer_part(90, r.sm.merkle_row_seq(), Part::Tree(root, PinnedDbSnapshot::of(&r.st.persistent.tree.db)));
        assert!(r.st.proof_views().candidate(90).is_none(), "the partial write fails its own row checks");
        r.st.request_proof_view(&r.sm, 90);
        settle(&r);
        assert!(r.st.proof_views().candidate(90).is_none(), "refused: store_write_failed");
        assert_eq!(r.st.proof_views().capture_state(), "store_write_failed");
        // Later good writes do not lift it; only a full reset does.
        let _ = advance_to(&r, 91, 180);
        assert!(r.st.proof_views().candidate(180).is_none());
        let all = r.sm.get_all_accounts();
        r.sm.restore_accounts(all).expect("full reset");
        let _ = advance_to(&r, 181, 270);
        assert!(r.st.proof_views().candidate(270).is_some(), "capture resumes after the reset");
        assert_eq!(r.st.proof_views().capture_state(), "ok");
    }

    // The request at 90 is made while block 89's delta is still queued, so nothing has failed yet
    // when it is checked. The delta then fails and block 90's lands: its seq and root row are right,
    // but the tree it shows lacks block 89's rows. The marker behind them must refuse the capture.
    #[test]
    fn a_write_failing_after_the_request_still_refuses_the_capture() {
        struct Release<'a>(&'a AtomicBool);
        impl Drop for Release<'_> {
            fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
        }
        let r = rig();
        for h in 1..=88 { block(&r, h); }
        settle(&r);
        let tree = &r.st.persistent.tree;
        let release = Release(&tree.hold);
        tree.hold.store(true, Ordering::SeqCst);
        block(&r, 89);
        tree.fail_seq.store(r.sm.merkle_row_seq(), Ordering::SeqCst);
        let root = block(&r, 90);
        r.st.request_proof_view(&r.sm, 90);
        assert_eq!(r.st.proof_views().capture_state(), "ok", "nothing had failed when the capture was asked for");
        drop(release);
        settle(&r);
        tree.fail_seq.store(0, Ordering::SeqCst);
        assert!(r.st.proof_views().candidate(90).map_or(true, |c| !c.1), "no tree part over a store that lost block 89's rows");
        assert_eq!(r.st.proof_views().capture_state(), "store_write_failed");
        store_mb(&r, 1, root);
        r.st.proof_views().tick(Instant::now());
        assert!(view_indices(&r).is_empty(), "never served");
        // The next full reset rebuilds the store and lifts the latch.
        let all = r.sm.get_all_accounts();
        r.sm.restore_accounts(all).expect("full reset");
        assert_eq!(r.st.proof_views().capture_state(), "ok");
        let root180 = advance_to(&r, 91, 180);
        store_mb(&r, 2, root180);
        wait_for("view 2 after the reset", || view_indices(&r) == vec![2]);
    }

    #[test]
    fn disk_pressure_releases_views_once_and_resumes_on_a_fresh_measurement() {
        let r = rig();
        let full = Arc::new(AtomicBool::new(false));
        let pct = Arc::new(AtomicU64::new(97));
        let (f, p) = (full.clone(), pct.clone());
        r.st.proof_views().set_disk_probes(
            Box::new(move || f.load(Ordering::SeqCst)),
            Box::new(move || Some(p.load(Ordering::SeqCst) as f64)),
        );
        let root = advance_to(&r, 1, 90);
        store_mb(&r, 1, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        let v = r.st.proof_views();
        let t0 = Instant::now();
        full.store(true, Ordering::SeqCst);
        v.disk_pressure_step(t0);
        assert!(view_indices(&r).is_empty(), "released under pressure");
        assert_eq!(v.capture_state(), "disk_pressure");
        v.disk_pressure_step(t0 + Duration::from_secs(1));
        v.disk_pressure_step(t0 + Duration::from_secs(2));
        assert_eq!(v.pressure_releases.load(Ordering::SeqCst), 1, "one release per episode");
        full.store(false, Ordering::SeqCst); // the hourly cached value is not the resume signal
        pct.store(92, Ordering::SeqCst);
        v.disk_pressure_step(t0 + Duration::from_secs(61));
        assert_eq!(v.capture_state(), "disk_pressure", "a fresh 92% is not enough");
        pct.store(85, Ordering::SeqCst);
        v.disk_pressure_step(t0 + Duration::from_secs(90));
        assert_eq!(v.capture_state(), "disk_pressure", "fresh measurements are 60 s apart");
        v.disk_pressure_step(t0 + Duration::from_secs(122));
        assert_eq!(v.capture_state(), "ok", "resumed below 90% on a fresh measurement");
        assert!(!include_str!("proof_views.rs").contains(concat!("compact", "_range")), "views never compact");
    }

    #[test]
    fn space_amplification_retires_the_oldest_view() {
        let r = rig();
        let mut from = 1;
        for j in 1..=3u64 {
            let root = advance_to(&r, from, j * MB_INTERVAL);
            from = j * MB_INTERVAL + 1;
            store_mb(&r, j, root);
        }
        wait_for("three views", || view_indices(&r) == vec![3, 2, 1]);
        let v = r.st.proof_views();
        v.set_space_probe(Box::new(|| (4 << 30, 1 << 30)));
        v.space_amplification_step();
        assert_eq!(view_indices(&r), vec![3, 2], "the oldest goes first");
        v.space_amplification_step();
        assert_eq!(view_indices(&r), vec![3]);
        v.space_amplification_step();
        assert_eq!(view_indices(&r), vec![3], "never the newest");
        v.set_space_probe(Box::new(|| (2 << 30, 1 << 30)));
        let _ = advance_to(&r, from, 4 * MB_INTERVAL);
        assert!(v.candidate(4 * MB_INTERVAL).is_some(), "candidates are never retired for space");
    }
}

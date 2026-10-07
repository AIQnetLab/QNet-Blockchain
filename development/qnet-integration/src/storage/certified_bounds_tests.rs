//! Bounds of the certified proof views under load, measured rather than assumed: what the views
//! hold (snapshots, registry entries, aux queue, memtables) and the disk their snapshots pin while
//! every block rewrites thousands of accounts; and the cost of one certified proof (latency and
//! store reads) over a view of many accounts and a large token. The light runs are part of the
//! suite; the `_target` runs are the same code at larger sizes, run on demand with `--ignored`.

use super::*;
use super::aux_db::AUX_CFS;
use super::proof_views::rig::*;
use super::proof_views::{SnapshotTreeReader, View, PROOF_CANDIDATES_KEPT, PROOF_VIEWS_KEPT};
use super::tree_db::TREE_CFS;
use qnet_state::{Account, MicroBlock, StateMerkleTree, Transaction, TransactionType};
use std::time::{Duration, Instant};

const MB: u64 = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
const MIB: f64 = 1024.0 * 1024.0;
/// What the derived DBs may hold in memtables: their `db_write_buffer_size` budgets.
const MEMTABLE_BUDGET: u64 = (256 + 128) * 1024 * 1024;

fn sum_prop(db: &DB, cfs: &[&str], name: &str) -> u64 {
    cfs.iter()
        .filter_map(|cf| db.cf_handle(cf))
        .map(|h| db.property_int_value_cf(&h, name).ok().flatten().unwrap_or(0))
        .sum()
}

/// Flush and fully compact every family, the bottommost level included (by default a manual
/// compaction leaves it as it is): what is left on disk is exactly what the held snapshots and the
/// live rows need.
fn compact_all(db: &DB, cfs: &[&str]) {
    let mut opts = rocksdb::CompactOptions::default();
    opts.set_bottommost_level_compaction(rocksdb::BottommostLevelCompaction::Force);
    for cf in cfs {
        let h = db.cf_handle(cf).expect("family");
        db.flush_cf(&h).expect("flush");
        db.compact_range_cf_opt(&h, None::<&[u8]>, None::<&[u8]>, &opts);
    }
}

fn live_estimate(r: &Rig) -> u64 {
    sum_prop(&r.st.persistent.tree.db, &TREE_CFS, "rocksdb.estimate-live-data-size")
        + sum_prop(r.st.persistent.aux.db(), &AUX_CFS, "rocksdb.estimate-live-data-size")
}

fn sst_bytes(r: &Rig) -> u64 {
    sum_prop(&r.st.persistent.tree.db, &TREE_CFS, "rocksdb.total-sst-files-size")
        + sum_prop(r.st.persistent.aux.db(), &AUX_CFS, "rocksdb.total-sst-files-size")
}

fn memtable_bytes(r: &Rig) -> u64 {
    sum_prop(&r.st.persistent.tree.db, &TREE_CFS, "rocksdb.cur-size-all-mem-tables")
        + sum_prop(r.st.persistent.aux.db(), &AUX_CFS, "rocksdb.cur-size-all-mem-tables")
}

fn transfer(from: &str, to: &str, amount: u64, nonce: u64) -> Transaction {
    Transaction::new(from.to_string(), Some(to.to_string()), amount, nonce, 0, qnet_state::gas_limits::TRANSFER, nonce,
                     None, TransactionType::Transfer { from: from.to_string(), to: to.to_string(), amount }, None)
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 17
    }
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() { return Duration::ZERO; }
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

#[derive(Clone, Copy)]
struct Churn {
    accounts: u64,
    transfers_per_block: u64,
    windows: u64,
    /// The account tree's node cache cap: below the leaf count, as at 10M accounts against the
    /// default 2M, so finalize reads the store and writes synchronously.
    cache_cap: usize,
    with_views: bool,
}

#[derive(Default, Debug)]
struct ChurnReport {
    blocks: u64,
    max_tree_snapshots: u64,
    max_aux_snapshots: u64,
    max_views: usize,
    max_candidates: usize,
    max_aux_queue: usize,
    max_memtables: u64,
    max_block_cache: usize,
    /// (index, SST bytes after a full compaction with the views of that moment held, snapshots held,
    /// RocksDB's own live-data estimate at that moment).
    retained: Vec<(u64, u64, u64, u64)>,
    /// SST bytes after every view was released and the DBs compacted: the live rows alone.
    live: u64,
    apply_ms: Vec<Duration>,
    views_at_end: Vec<u64>,
}

/// Every block moves `transfers_per_block` random transfers through the consensus apply funnel;
/// boundaries request a view and macroblocks are stored 30 blocks after their boundary, as sealed.
fn run_churn(p: Churn) -> ChurnReport {
    let r = rig();
    r.sm.set_merkle_node_cache_cap(p.cache_cap);
    let accts: Vec<(String, Account)> = (0..p.accounts).map(|i| { let a = wallet(i, 1_000_000_000_000); (a.address.clone(), a) }).collect();
    let names: Vec<String> = accts.iter().map(|(a, _)| a.clone()).collect();
    r.sm.restore_accounts(accts).expect("restore");
    settle(&r);
    let mut nonces = vec![0u64; p.accounts as usize];
    let mut rng = Lcg(0x5EED_0000 ^ p.accounts ^ p.transfers_per_block);
    let mut roots: HashMap<u64, [u8; 32]> = HashMap::new();
    let mut rep = ChurnReport::default();
    let last = p.windows * MB + 30;
    for h in 1..=last {
        let txs: Vec<Transaction> = (0..p.transfers_per_block).map(|_| {
            let from = (rng.next() % p.accounts) as usize;
            let mut to = (rng.next() % p.accounts) as usize;
            if to == from { to = (to + 1) % p.accounts as usize; }
            nonces[from] += 1;
            transfer(&names[from], &names[to], 1 + rng.next() % 1_000, nonces[from])
        }).collect();
        let mb = MicroBlock::new(h, h, [0u8; 32], txs, "genesis_node_001".to_string());
        let t0 = Instant::now();
        let mut snap = r.sm.create_block_snapshot(h);
        let res = crate::node::BlockchainNode::apply_block_to_state(&r.sm, &mb, &r.st, Some(&mut snap));
        if p.with_views {
            r.st.request_proof_view(&r.sm, h);
        }
        r.sm.retain_block_journal(snap);
        rep.apply_ms.push(t0.elapsed());
        if h % MB == 0 {
            roots.insert(h / MB, res.merkle_root);
        }
        if p.with_views && h % MB == 30 && h > MB {
            let j = (h - 30) / MB;
            store_mb(&r, j, roots[&j]);
        }
        let (t, a) = r.st.proof_views().rocksdb_snapshots();
        rep.max_tree_snapshots = rep.max_tree_snapshots.max(t);
        rep.max_aux_snapshots = rep.max_aux_snapshots.max(a);
        let (cands, views) = r.st.proof_views().held();
        rep.max_candidates = rep.max_candidates.max(cands.len());
        rep.max_views = rep.max_views.max(views.len());
        rep.max_aux_queue = rep.max_aux_queue.max(r.st.persistent.aux.queued_bytes());
        rep.max_memtables = rep.max_memtables.max(memtable_bytes(&r));
        rep.max_block_cache = rep.max_block_cache.max(r.st.persistent.block_cache.get_usage());
        if h % MB == 30 && h > MB {
            settle(&r);
            if p.with_views {
                let j = (h - 30) / MB;
                wait_for("the sealed view", || view_indices(&r).first() == Some(&j));
            }
            compact_all(&r.st.persistent.tree.db, &TREE_CFS);
            compact_all(r.st.persistent.aux.db(), &AUX_CFS);
            let (t, a) = r.st.proof_views().rocksdb_snapshots();
            rep.retained.push(((h - 30) / MB, sst_bytes(&r), t.max(a), live_estimate(&r)));
        }
    }
    settle(&r);
    rep.blocks = last;
    rep.views_at_end = view_indices(&r);
    r.st.proof_views().release_all();
    compact_all(&r.st.persistent.tree.db, &TREE_CFS);
    compact_all(r.st.persistent.aux.db(), &AUX_CFS);
    rep.live = sst_bytes(&r);
    assert_eq!(r.st.proof_views().rocksdb_snapshots(), (0, 0), "released views hold no snapshot");
    rep
}

fn print_churn(p: &Churn, rep: &ChurnReport) {
    let mut ms = rep.apply_ms.clone();
    ms.sort();
    println!("[MEASURE][CHURN] accounts={} transfers_per_block={} blocks={} cache_cap={} views={}",
             p.accounts, p.transfers_per_block, rep.blocks, p.cache_cap, p.with_views);
    println!("[MEASURE][CHURN] max_snapshots tree={} aux={} max_views={} max_candidates={} max_aux_queue_mib={:.2} \
              max_memtables_mib={:.1} max_block_cache_mib={:.1}",
             rep.max_tree_snapshots, rep.max_aux_snapshots, rep.max_views, rep.max_candidates,
             rep.max_aux_queue as f64 / MIB, rep.max_memtables as f64 / MIB, rep.max_block_cache as f64 / MIB);
    println!("[MEASURE][CHURN] apply_ms p50={:.1} p99={:.1} max={:.1}",
             percentile(&ms, 0.5).as_secs_f64() * 1e3, percentile(&ms, 0.99).as_secs_f64() * 1e3,
             ms.last().map_or(0.0, |d| d.as_secs_f64() * 1e3));
    for (j, bytes, snaps, est) in &rep.retained {
        println!("[MEASURE][CHURN] sealed_index={} sst_mib={:.2} snapshots={} vs_live={:.2} rocksdb_live_estimate_mib={:.2}",
                 j, *bytes as f64 / MIB, snaps, *bytes as f64 / rep.live.max(1) as f64, *est as f64 / MIB);
    }
    println!("[MEASURE][CHURN] live_sst_mib={:.2}", rep.live as f64 / MIB);
}

fn assert_churn_bounds(p: &Churn, rep: &ChurnReport) {
    // Held entries, plus the one capture a writer may be checking at the instant of the sample
    // before the registry takes or drops it.
    let cap = (PROOF_VIEWS_KEPT + PROOF_CANDIDATES_KEPT) as u64 + 1;
    assert!(rep.max_tree_snapshots <= cap && rep.max_aux_snapshots <= cap,
            "snapshots tree={} aux={} over {}", rep.max_tree_snapshots, rep.max_aux_snapshots, cap);
    assert!(rep.max_views <= PROOF_VIEWS_KEPT && rep.max_candidates <= PROOF_CANDIDATES_KEPT);
    assert!(rep.max_aux_queue <= AUX_QUEUE_CAP_BYTES, "aux queue {} over its cap", rep.max_aux_queue);
    assert!(rep.max_memtables <= MEMTABLE_BUDGET, "memtables {} over their budget", rep.max_memtables);
    if p.with_views {
        let newest = p.windows;
        assert_eq!(rep.views_at_end, vec![newest, newest - 1, newest - 2], "the newest three certified views");
        // A snapshot pins at most one superseded copy of each row: never more than one live set each.
        for (j, bytes, snaps, _) in &rep.retained {
            let bound = (snaps + 1) * rep.live + rep.live / 5 + (1 << 20);
            assert!(*bytes <= bound, "index {}: {} bytes on disk with {} snapshots, bound {}", j, bytes, snaps, bound);
        }
    }
}

const CHURN_SUITE: Churn = Churn { accounts: 10_000, transfers_per_block: 1_000, windows: 5, cache_cap: 4_000, with_views: true };

// Every block rewrites about 2k of 10k accounts with the node cache under the leaf count (the
// synchronous store path a 10M-account node runs): the views stay inside their caps and the disk
// their snapshots pin stays within one live copy per snapshot.
#[test]
fn views_stay_bounded_under_heavy_churn() {
    let rep = run_churn(CHURN_SUITE);
    print_churn(&CHURN_SUITE, &rep);
    assert_churn_bounds(&CHURN_SUITE, &rep);
}

// Target-like sizes: 13k transfers per 1 s block (the measured max) over 200k accounts, the node
// cache at a tenth of the leaves; once with views and once without, so the apply-path cost of the
// views is the difference.
#[test]
#[ignore]
fn views_stay_bounded_under_heavy_churn_target() {
    let with = Churn { accounts: 200_000, transfers_per_block: 13_000, windows: 4, cache_cap: 20_000, with_views: true };
    let rep = run_churn(with);
    print_churn(&with, &rep);
    assert_churn_bounds(&with, &rep);
    let without = Churn { with_views: false, ..with };
    let base = run_churn(without);
    print_churn(&without, &base);
}

/// A reader that counts what a proof asks of the store.
struct Counting<R> {
    inner: R,
    nodes: u64,
    seeks: u64,
    entries: u64,
}

impl<R: qnet_state::TreeReader> qnet_state::TreeReader for Counting<R> {
    fn node(&mut self, depth: u32, key: &[u8; 32]) -> Result<Option<[u8; 32]>, qnet_state::ReadFault> {
        self.nodes += 1;
        self.inner.node(depth, key)
    }
    fn leaves(&mut self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Result<Vec<([u8; 32], [u8; 32])>, qnet_state::ReadFault> {
        self.seeks += 1;
        let out = self.inner.leaves(lo, hi, limit)?;
        self.entries += out.len() as u64;
        Ok(out)
    }
}

#[derive(Default)]
struct Cost {
    latency: Vec<Duration>,
    nodes: u64,
    seeks: u64,
    entries: u64,
    max_nodes: u64,
    max_seeks: u64,
}

impl Cost {
    fn add(&mut self, d: Duration, nodes: u64, seeks: u64, entries: u64) {
        self.latency.push(d);
        self.nodes += nodes;
        self.seeks += seeks;
        self.entries += entries;
        self.max_nodes = self.max_nodes.max(nodes);
        self.max_seeks = self.max_seeks.max(seeks);
    }
    fn report(&mut self, what: &str) -> Duration {
        self.latency.sort();
        let n = self.latency.len().max(1) as f64;
        println!("[MEASURE][PROOF] {} n={} p50_us={:.0} p90_us={:.0} p99_us={:.0} max_us={:.0} node_reads_avg={:.1} \
                  node_reads_max={} seeks_avg={:.1} seeks_max={} leaf_entries_avg={:.1}",
                 what, self.latency.len(),
                 percentile(&self.latency, 0.5).as_secs_f64() * 1e6, percentile(&self.latency, 0.9).as_secs_f64() * 1e6,
                 percentile(&self.latency, 0.99).as_secs_f64() * 1e6,
                 self.latency.last().map_or(0.0, |d| d.as_secs_f64() * 1e6),
                 self.nodes as f64 / n, self.max_nodes, self.seeks as f64 / n, self.max_seeks, self.entries as f64 / n);
        percentile(&self.latency, 0.99)
    }
}

const COST_TOKEN: &str = "eon_cost_token";

/// One certified view over `accounts` wallets and a token with `holders` holders, flushed to SST so
/// reads take the path a long-running node's reads take. Returns the rig and the view.
fn cost_view(accounts: u64, holders: u64) -> (Rig, Arc<View>) {
    let r = rig();
    let mut all: Vec<(String, Account)> = (0..accounts).map(|i| { let a = wallet(i, 10_000 + i); (a.address.clone(), a) }).collect();
    let mut t = Account::new(COST_TOKEN.to_string());
    t.is_contract = true;
    t.contract_code_hash = Some("ef".repeat(32));
    t.contract_storage = (0..holders).map(|i| (format!("balance:eon_cost_h{:07}", i), format!("{}", 1 + i))).collect();
    t.storage_root = StateMerkleTree::compute_storage_root(&t.contract_storage);
    all.push((COST_TOKEN.to_string(), t));
    r.sm.restore_accounts(all).expect("restore");
    let mut root = [0u8; 32];
    for h in 1..=MB { root = block(&r, h); }
    certify(&r, MB, root);
    wait_for("the view", || view_indices(&r) == vec![1]);
    for (db, cfs) in [(&*r.st.persistent.tree.db, &TREE_CFS[..]), (r.st.persistent.aux.db(), &AUX_CFS[..])] {
        for cf in cfs { db.flush_cf(&db.cf_handle(cf).unwrap()).expect("flush"); }
    }
    let view = Arc::clone(&r.st.proof_views().current().views[0]);
    (r, view)
}

/// Latency of the full certified build (prove, preimage, self-check) and the reads the prover makes,
/// for present and absent accounts and for present and absent token holders.
fn measure_cost(accounts: u64, holders: u64, samples: u64) -> [Duration; 4] {
    let (r, view) = cost_view(accounts, holders);
    let mut rng = Lcg(accounts ^ holders);
    let mut account_in = Cost::default();
    let mut account_out = Cost::default();
    for k in 0..samples {
        let (addr, present) = if k % 2 == 0 {
            (wallet(rng.next() % accounts, 0).address, true)
        } else {
            (format!("eon_cost_absent_{}", rng.next()), false)
        };
        let key = StateMerkleTree::hash_address(&addr);
        let mut counting = Counting { inner: SnapshotTreeReader::accounts(&view), nodes: 0, seeks: 0, entries: 0 };
        qnet_state::prove_leaf(&mut counting, &key).expect("proves");
        let t0 = Instant::now();
        let a = r.st.certified_account_proof(&view, &addr).expect("certified");
        let d = t0.elapsed();
        assert_eq!(a.fields.is_some(), present);
        let c = if present { &mut account_in } else { &mut account_out };
        c.add(d, counting.nodes, counting.seeks, counting.entries);
    }
    let mut token_in = Cost::default();
    let mut token_out = Cost::default();
    let c = StateMerkleTree::hash_address(COST_TOKEN);
    for k in 0..samples / 2 {
        let (holder, present) = if k % 2 == 0 {
            (format!("eon_cost_h{:07}", rng.next() % holders), true)
        } else {
            (format!("eon_cost_nobody_{}", rng.next()), false)
        };
        let sk = StateMerkleTree::hash_storage_key(&format!("balance:{}", holder));
        let mut counting = Counting { inner: SnapshotTreeReader::storage(&view, c), nodes: 0, seeks: 0, entries: 0 };
        qnet_state::prove_leaf_in(&mut counting, &sk, qnet_state::StoredRows::Branches).expect("proves");
        let t0 = Instant::now();
        let t = r.st.certified_token_proof(&view, COST_TOKEN, &holder).expect("certified");
        let d = t0.elapsed();
        assert_eq!(t.storage.as_ref().and_then(|s| s.value.as_ref()).is_some(), present);
        let target = if present { &mut token_in } else { &mut token_out };
        // The storage level's reads; the contract leaf costs one account proof on top.
        target.add(d, counting.nodes, counting.seeks, counting.entries);
    }
    println!("[MEASURE][PROOF] accounts={} holders={} tree_sst_mib={:.1} aux_sst_mib={:.1}", accounts, holders,
             sum_prop(&r.st.persistent.tree.db, &TREE_CFS, "rocksdb.total-sst-files-size") as f64 / MIB,
             sum_prop(r.st.persistent.aux.db(), &AUX_CFS, "rocksdb.total-sst-files-size") as f64 / MIB);
    let p99 = [account_in.report("account_present"), account_out.report("account_absent"),
               token_in.report("token_holder_present"), token_out.report("token_holder_absent")];
    // The walk is bounded by the tree shape, never by the number of accounts or holders: at most one
    // node read per level and a handful of seeks per level above the first foreign depth.
    let levels = qnet_state::state::PROOF_DEPTH as u64;
    for c in [&account_in, &account_out, &token_in, &token_out] {
        assert!(c.max_nodes <= levels, "node reads {} over one per level", c.max_nodes);
        assert!(c.max_seeks <= 4 + 3 * levels, "seeks {} over the walk's bound", c.max_seeks);
    }
    p99
}

// A view over 50k accounts and a 10k-holder token: every proof stays a bounded walk, and the
// per-request latency is reported.
#[test]
fn certified_proof_cost_per_request() {
    let p99 = measure_cost(50_000, 10_000, 600);
    for d in p99 {
        assert!(d < Duration::from_millis(100), "p99 {:?}", d);
    }
}

#[test]
#[ignore]
fn certified_proof_cost_per_request_target() {
    let _ = measure_cost(1_000_000, 200_000, 4_000);
}

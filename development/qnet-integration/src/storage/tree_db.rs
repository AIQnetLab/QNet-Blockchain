//! The state-tree DB at `<data_dir>/state_tree`: the account tree consensus reads (leaves and
//! nodes) and nothing else. A RocksDB snapshot covers a whole DB, so keeping the tree apart from the
//! main DB lets a certified proof view pin tree rows only, not every superseded accounts row.

use super::*;
use std::sync::atomic::AtomicUsize;

pub(crate) const TREE_DB_DIR: &str = "state_tree";
pub(crate) const CF_ACCT_LEAVES: &str = "acct_leaves";
pub(crate) const CF_ACCT_NODES: &str = "acct_nodes";
pub(crate) const CF_TREE_META: &str = "tree_meta";
pub(crate) const TREE_CFS: [&str; 3] = [CF_ACCT_LEAVES, CF_ACCT_NODES, CF_TREE_META];

/// No WriteBatch of either derived DB exceeds this.
pub const TREE_WRITE_CHUNK_BYTES: usize = 64 * 1024 * 1024;

pub(crate) const META_FORMAT: &[u8] = b"format";
pub(crate) const META_SEQ: &[u8] = b"seq";
/// Present only while a chunked delta is partly written.
pub(crate) const META_WRITE_OPEN: &[u8] = b"write_open";
/// Root of the last full rebuild that landed completely.
pub(crate) const META_REBUILT_ROOT: &[u8] = b"rebuilt_root";
const TREE_FORMAT: u64 = 1;

/// Where the account tree's root row lives: depth TREE_DEPTH, the all-zero key.
pub(crate) const ROOT_DEPTH: u32 = 256;

/// Estimated batch bytes per row kind (key + value + write-batch record overhead).
const LEAF_PUT_BYTES: usize = 32 + 32 + 16;
const LEAF_DEL_BYTES: usize = 32 + 16;
const NODE_PUT_BYTES: usize = 36 + 32 + 16;
const NODE_DEL_BYTES: usize = 36 + 16;

/// 4-byte big-endian depth then the 32-byte key: depth-major order, fixed 36-byte width.
#[inline]
pub(crate) fn node_db_key(depth: u32, key: &[u8; 32]) -> [u8; 36] {
    let mut k = [0u8; 36];
    k[..4].copy_from_slice(&depth.to_be_bytes());
    k[4..].copy_from_slice(key);
    k
}

/// The open tree DB and what this process learned about it.
pub(crate) struct TreeDb {
    pub(crate) db: Arc<DB>,
    /// Set once a full-rebuild delta landed completely in this process: from then on the tree DB
    /// is this boot's own, and the legacy merkle families of the main DB may go.
    pub(crate) rebuilt: Arc<AtomicBool>,
    /// Set by a failed write and cleared by the next full reset: until then rows may be missing, so
    /// no view is captured. Set on the writer thread itself, so a capture marker queued behind a
    /// failed write sees it; a latch read when the capture was requested cannot.
    pub(crate) write_failed: Arc<AtomicBool>,
    /// The rows this DB's writer wrote, for the views' estimate of what their snapshots pin.
    pub(crate) sketch: Arc<super::row_sketch::RowSketch>,
    /// Bytes per WriteBatch; tests lower it to drive chunked writes with few rows.
    pub(crate) chunk_bytes: Arc<AtomicUsize>,
    /// 1-based chunk index whose write fails (0 = none), for the interrupted-write tests.
    pub(crate) fail_at_chunk: Arc<AtomicUsize>,
    /// The delta with this seq fails whole (0 = none).
    #[cfg(test)]
    pub(crate) fail_seq: Arc<AtomicU64>,
    /// Writes wait while set, so a test can queue deltas and markers behind one.
    #[cfg(test)]
    pub(crate) hold: Arc<AtomicBool>,
}

/// Sketch families of the tree DB.
const FAMILY_LEAVES: usize = 0;
const FAMILY_NODES: usize = 1;

impl TreeDb {
    pub(crate) fn store(&self) -> TreeDbStore {
        TreeDbStore {
            db: self.db.clone(),
            rebuilt: self.rebuilt.clone(),
            write_failed: self.write_failed.clone(),
            sketch: self.sketch.clone(),
            chunk_bytes: self.chunk_bytes.clone(),
            fail_at_chunk: self.fail_at_chunk.clone(),
            #[cfg(test)]
            fail_seq: self.fail_seq.clone(),
            #[cfg(test)]
            hold: self.hold.clone(),
        }
    }
}

fn tree_db_options() -> Options {
    let mut opts = Options::default();
    opts.create_if_missing(true);
    opts.create_missing_column_families(true);
    opts.set_use_fsync(true);
    opts.set_max_open_files(-1);
    opts.set_bytes_per_sync(1_048_576);
    opts.set_db_write_buffer_size(256 * 1024 * 1024);
    opts.set_max_total_wal_size(256 * 1024 * 1024);
    opts.set_max_background_jobs(4);
    opts.set_max_log_file_size(64 * 1024 * 1024);
    opts.set_keep_log_file_num(4);
    opts.set_level_compaction_dynamic_level_bytes(true);
    opts
}

/// Whole-key bloom over partitioned filters, as the merkle families had: most node reads ask for
/// rows that do not exist, which the filter answers without touching an SST.
pub(crate) fn hash_cf_options(cache: &rocksdb::Cache, write_buffer: usize, compression: rocksdb::DBCompressionType) -> Options {
    let mut cf = Options::default();
    cf.set_compression_type(compression);
    cf.set_write_buffer_size(write_buffer);
    cf.set_max_write_buffer_number(4);
    cf.set_target_file_size_base(64 * 1024 * 1024);
    let mut b = rocksdb::BlockBasedOptions::default();
    b.set_block_cache(cache);
    b.set_block_size(16384);
    b.set_format_version(5);
    b.set_bloom_filter(10.0, false);
    b.set_cache_index_and_filter_blocks(true);
    b.set_pin_l0_filter_and_index_blocks_in_cache(true);
    b.set_index_type(rocksdb::BlockBasedIndexType::TwoLevelIndexSearch);
    b.set_partition_filters(true);
    b.set_whole_key_filtering(true);
    cf.set_block_based_table_factory(&b);
    cf
}

fn tree_descriptors(path: &Path, cache: &rocksdb::Cache) -> Vec<ColumnFamilyDescriptor> {
    let none = rocksdb::DBCompressionType::None;
    let mut cfs = vec![
        ColumnFamilyDescriptor::new(CF_ACCT_LEAVES, hash_cf_options(cache, 32 * 1024 * 1024, none)),
        ColumnFamilyDescriptor::new(CF_ACCT_NODES, hash_cf_options(cache, 64 * 1024 * 1024, none)),
        ColumnFamilyDescriptor::new(CF_TREE_META, hash_cf_options(cache, 4 * 1024 * 1024, none)),
    ];
    // Downgrade-safe: a family a newer binary added must still be declared to open.
    if let Ok(existing) = DB::list_cf(&Options::default(), path) {
        for name in existing {
            if name != "default" && !TREE_CFS.contains(&name.as_str()) {
                eprintln!("[WARN][STORAGE] tree_db_unknown_cf name={} action=open_generic", name);
                cfs.push(ColumnFamilyDescriptor::new(&name, Options::default()));
            }
        }
    }
    cfs
}

/// Open a RocksDB with retries: a fast container restart can find the previous LOCK still held.
pub(crate) fn open_with_retry(what: &str, open: impl Fn() -> Result<DB, rocksdb::Error>) -> IntegrationResult<DB> {
    let mut last_err = String::new();
    for attempt in 1u32..=10 {
        match open() {
            Ok(db) => return Ok(db),
            Err(e) => {
                last_err = e.to_string();
                eprintln!("[WARN][STORAGE] {}_open attempt={}/10 err={}", what, attempt, e);
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }
    eprintln!("[CRIT][STORAGE] {}_open_failed attempts=10 err={}", what, last_err);
    Err(IntegrationError::StorageError(format!("{} open failed after 10 attempts: {}", what, last_err)))
}

/// Whether the tree DB holds any account leaf.
pub(crate) fn tree_has_leaves(db: &DB) -> bool {
    cf_has_rows(db, CF_ACCT_LEAVES)
}

fn cf_has_rows(db: &DB, cf: &str) -> bool {
    match db.cf_handle(cf) {
        Some(h) => db.iterator_cf(&h, rocksdb::IteratorMode::Start).next().is_some(),
        None => false,
    }
}

/// Open `<data_dir>/state_tree`. It is kept across restarts (one boot path does not rebuild the
/// tree) and wiped in exactly two cases: a chunked write was interrupted, or the main DB's legacy
/// merkle families hold rows, which means an older binary ran after the last retirement.
pub(crate) fn open_tree_db(data_dir: &Path, cache: &rocksdb::Cache, legacy_rows_present: bool) -> IntegrationResult<TreeDb> {
    let path = data_dir.join(TREE_DB_DIR);
    std::fs::create_dir_all(&path)?;
    let open = || open_with_retry("tree_db", || DB::open_cf_descriptors(&tree_db_options(), &path, tree_descriptors(&path, cache)));
    let mut db = open()?;
    let interrupted = db.cf_handle(CF_TREE_META)
        .and_then(|cf| db.get_cf(&cf, META_WRITE_OPEN).ok().flatten())
        .is_some();
    let populated = TREE_CFS.iter().any(|cf| cf_has_rows(&db, cf));
    let reason = if interrupted {
        Some("interrupted_chunked_write")
    } else if legacy_rows_present && populated {
        Some("legacy_rows_present")
    } else {
        None
    };
    if let Some(reason) = reason {
        drop(db);
        DB::destroy(&tree_db_options(), &path)
            .map_err(|e| IntegrationError::StorageError(format!("tree_db_destroy_failed: {}", e)))?;
        println!("[WARN][STORAGE] tree_db_wiped reason={}", reason);
        db = open()?;
    }
    let meta = db.cf_handle(CF_TREE_META)
        .ok_or_else(|| IntegrationError::StorageError("tree_meta column family not found".to_string()))?;
    if db.get_cf(&meta, META_FORMAT)?.is_none() {
        db.put_cf(&meta, META_FORMAT, TREE_FORMAT.to_le_bytes())?;
    }
    Ok(TreeDb {
        db: Arc::new(db),
        rebuilt: Arc::new(AtomicBool::new(false)),
        write_failed: Arc::new(AtomicBool::new(false)),
        sketch: Arc::new(super::row_sketch::RowSketch::new(2)),
        chunk_bytes: Arc::new(AtomicUsize::new(TREE_WRITE_CHUNK_BYTES)),
        fail_at_chunk: Arc::new(AtomicUsize::new(0)),
        #[cfg(test)]
        fail_seq: Arc::new(AtomicU64::new(0)),
        #[cfg(test)]
        hold: Arc::new(AtomicBool::new(false)),
    })
}

/// The account tree's store over the tree DB.
pub(crate) struct TreeDbStore {
    db: Arc<DB>,
    rebuilt: Arc<AtomicBool>,
    write_failed: Arc<AtomicBool>,
    sketch: Arc<super::row_sketch::RowSketch>,
    chunk_bytes: Arc<AtomicUsize>,
    fail_at_chunk: Arc<AtomicUsize>,
    #[cfg(test)]
    fail_seq: Arc<AtomicU64>,
    #[cfg(test)]
    hold: Arc<AtomicBool>,
}

impl TreeDbStore {
    fn cf(&self, name: &str) -> Result<&rocksdb::ColumnFamily, String> {
        self.db.cf_handle(name).ok_or_else(|| format!("tree DB column family '{}' not found", name))
    }

    fn write_chunk(&self, batch: WriteBatch, index: usize) -> Result<(), String> {
        if self.fail_at_chunk.load(Ordering::SeqCst) == index {
            return Err(format!("injected chunk failure index={}", index));
        }
        self.db.write(batch).map_err(|e| e.to_string())
    }

    /// The rows a landed delta changed. A rebuild replaces the whole node set, so the node family's
    /// live rows start over with it.
    fn note_rows(&self, d: &qnet_state::AcctDelta) {
        let mut b = self.sketch.batch();
        for k in &d.leaf_dels { b.delete(k); }
        for (k, _) in &d.leaf_puts { b.put(FAMILY_LEAVES, k, 32); }
        if d.wipe_nodes {
            b.wipe_family(FAMILY_NODES);
        } else {
            for (depth, k) in &d.node_dels { b.delete(&node_db_key(*depth, k)); }
        }
        for ((depth, k), _) in &d.node_puts { b.put(FAMILY_NODES, &node_db_key(*depth, k), 32); }
    }
}

impl qnet_state::MerkleNodeStore for TreeDbStore {
    fn get_leaf(&self, key: &[u8; 32]) -> Option<[u8; 32]> { self.try_get_leaf(key).ok().flatten() }

    fn try_get_leaf(&self, key: &[u8; 32]) -> Result<Option<[u8; 32]>, ()> {
        let cf = match self.db.cf_handle(CF_ACCT_LEAVES) {
            Some(cf) => cf,
            None => { MERKLE_LEAF_READ_ERRS.fetch_add(1, Ordering::Relaxed); return Err(()); }
        };
        // Keys-only probes must not evict the hot working set from the block cache.
        let mut ro = rocksdb::ReadOptions::default();
        ro.fill_cache(false);
        match self.db.get_cf_opt(&cf, &key[..], &ro) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Ok(Some(out)) }
            Ok(None) => Ok(None),
            _ => { MERKLE_LEAF_READ_ERRS.fetch_add(1, Ordering::Relaxed); Err(()) }
        }
    }

    fn get_node(&self, depth: u32, key: &[u8; 32]) -> Option<[u8; 32]> {
        let cf = self.db.cf_handle(CF_ACCT_NODES)?;
        let v = self.db.get_cf(&cf, &node_db_key(depth, key)[..]).ok().flatten()?;
        if v.len() == 32 { let mut out = [0u8; 32]; out.copy_from_slice(&v); Some(out) } else { None }
    }

    /// A subtree is a contiguous key range: one seek plus at most `limit` steps.
    fn leaves_under(&self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Vec<([u8; 32], [u8; 32])> {
        let cf = match self.db.cf_handle(CF_ACCT_LEAVES) { Some(cf) => cf, None => return Vec::new() };
        let mut out = Vec::new();
        if limit == 0 { return out; }
        let mut ro = rocksdb::ReadOptions::default();
        ro.set_iterate_upper_bound({ let mut end = hi.to_vec(); end.push(0u8); end });
        ro.fill_cache(false);
        let mode = rocksdb::IteratorMode::From(&lo[..], rocksdb::Direction::Forward);
        for item in self.db.iterator_cf_opt(&cf, ro, mode) {
            let (k, v) = match item { Ok(kv) => kv, Err(_) => break };
            if k.len() != 32 || k.as_ref() > &hi[..] { break; }
            if v.len() != 32 { continue; }
            let mut key = [0u8; 32];
            let mut val = [0u8; 32];
            key.copy_from_slice(&k);
            val.copy_from_slice(&v);
            out.push((key, val));
            if out.len() >= limit { break; }
        }
        out
    }

    fn all_leaves(&self) -> Vec<([u8; 32], [u8; 32])> {
        let cf = match self.db.cf_handle(CF_ACCT_LEAVES) { Some(cf) => cf, None => return Vec::new() };
        let mut out = Vec::new();
        for item in self.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            // A dropped row silently shrinks the leaf set recompute_root then calls complete.
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(_) => { MERKLE_LEAF_READ_ERRS.fetch_add(1, Ordering::Relaxed); continue; }
            };
            if k.len() != 32 || v.len() != 32 {
                MERKLE_LEAF_READ_ERRS.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let mut key = [0u8; 32];
            let mut val = [0u8; 32];
            key.copy_from_slice(&k);
            val.copy_from_slice(&v);
            out.push((key, val));
        }
        out
    }

    fn wipe_for_full_reset(&self) -> Result<(), String> {
        let cf = self.cf(CF_ACCT_LEAVES)?;
        // Leaf keys are exactly 32 bytes, so a 33-byte upper bound covers every one of them.
        self.db.delete_range_cf(cf, &[0u8; 1][..], &[0xFFu8; 33][..]).map_err(|e| e.to_string())?;
        // Every earlier write has landed or failed by now (the reset drains the queue first), and the
        // rebuild that follows replaces what any of them left behind.
        self.write_failed.store(false, Ordering::SeqCst);
        self.sketch.batch().wipe_family(FAMILY_LEAVES);
        Ok(())
    }

    fn put_batch(&self, d: &qnet_state::AcctDelta) -> Result<(), String> {
        #[cfg(test)]
        {
            while self.hold.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            if d.seq != 0 && self.fail_seq.load(Ordering::SeqCst) == d.seq {
                self.write_failed.store(true, Ordering::SeqCst);
                return Err(format!("injected delta failure seq={}", d.seq));
            }
        }
        let written = self.put_batch_rows(d);
        match written {
            Ok(()) => self.note_rows(d),
            Err(_) => self.write_failed.store(true, Ordering::SeqCst),
        }
        written
    }

    fn stored_seq(&self) -> u64 {
        self.db.cf_handle(CF_TREE_META)
            .and_then(|cf| self.db.get_cf(&cf, META_SEQ).ok().flatten())
            .filter(|v| v.len() == 8)
            .map(|v| u64::from_le_bytes(v[..8].try_into().unwrap_or([0u8; 8])))
            .unwrap_or(0)
    }
}

impl TreeDbStore {
    /// One finalize's delta in WriteBatches of at most `chunk_bytes`. A delta that fits is one
    /// atomic batch. A larger one marks `write_open` in its first chunk and carries the root row,
    /// `seq`, `rebuilt_root` and the `write_open` delete in its last: a failed chunk stops the
    /// rest, so a partial write never shows this finalize's root or seq, and the next open wipes it.
    fn put_batch_rows(&self, d: &qnet_state::AcctDelta) -> Result<(), String> {
        let leaf_cf = self.cf(CF_ACCT_LEAVES)?;
        let node_cf = self.cf(CF_ACCT_NODES)?;
        let meta_cf = self.cf(CF_TREE_META)?;
        let root_key = (ROOT_DEPTH, [0u8; 32]);

        // Full rebuild: the node set goes first, as its own write, so no stale node survives.
        if d.wipe_nodes {
            self.db.delete_range_cf(node_cf, &[0u8; 1][..], &[0xFFu8; 37][..]).map_err(|e| e.to_string())?;
        }
        let root_put = d.node_puts.iter().rev().find(|(k, _)| *k == root_key).map(|(_, v)| *v);
        let root_del = !d.wipe_nodes && root_put.is_none() && d.node_dels.iter().any(|k| *k == root_key);
        let node_dels: &[(u32, [u8; 32])] = if d.wipe_nodes { &[] } else { &d.node_dels };
        let total = d.leaf_dels.len() * LEAF_DEL_BYTES + d.leaf_puts.len() * LEAF_PUT_BYTES
            + node_dels.len() * NODE_DEL_BYTES + d.node_puts.len() * NODE_PUT_BYTES;
        let chunk = self.chunk_bytes.load(Ordering::Relaxed).max(1);
        let chunked = total > chunk;

        let mut batch = WriteBatch::default();
        let mut bytes = 0usize;
        let mut index = 1usize;
        if chunked {
            batch.put_cf(meta_cf, META_WRITE_OPEN, [1u8]);
        }
        macro_rules! step {
            ($n:expr) => {
                bytes += $n;
                if chunked && bytes >= chunk {
                    self.write_chunk(std::mem::take(&mut batch), index)?;
                    index += 1;
                    bytes = 0;
                }
            };
        }
        // Leaves are disjoint by contract; node deletes precede node puts so a re-put wins.
        for k in &d.leaf_dels { batch.delete_cf(leaf_cf, &k[..]); step!(LEAF_DEL_BYTES); }
        for (k, v) in &d.leaf_puts { batch.put_cf(leaf_cf, &k[..], &v[..]); step!(LEAF_PUT_BYTES); }
        for (depth, k) in node_dels {
            if (*depth, *k) == root_key { continue; }
            batch.delete_cf(node_cf, &node_db_key(*depth, k)[..]);
            step!(NODE_DEL_BYTES);
        }
        for ((depth, k), v) in &d.node_puts {
            if (*depth, *k) == root_key { continue; }
            batch.put_cf(node_cf, &node_db_key(*depth, k)[..], &v[..]);
            step!(NODE_PUT_BYTES);
        }
        let root_db_key = node_db_key(ROOT_DEPTH, &[0u8; 32]);
        match root_put {
            Some(r) => batch.put_cf(node_cf, &root_db_key[..], &r[..]),
            None if root_del => batch.delete_cf(node_cf, &root_db_key[..]),
            None => {}
        }
        batch.put_cf(meta_cf, META_SEQ, d.seq.to_le_bytes());
        if d.wipe_nodes {
            batch.put_cf(meta_cf, META_REBUILT_ROOT, root_put.unwrap_or([0u8; 32]));
        }
        if chunked {
            batch.delete_cf(meta_cf, META_WRITE_OPEN);
        }
        self.write_chunk(batch, index)?;
        if d.wipe_nodes {
            self.rebuilt.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

impl Storage {
    /// The account tree's store over the tree DB. Handed to `StateManager::set_merkle_node_store`
    /// at boot; the in-RAM maps become bounded read-through caches over it.
    pub fn merkle_node_store(&self) -> std::sync::Arc<dyn qnet_state::MerkleNodeStore> {
        std::sync::Arc::new(self.persistent.tree.store())
    }

    /// Delete the main DB's legacy merkle families once this boot's own full rebuild has landed in
    /// the tree DB. Before that a downgrade can still use them, and a boot that never rebuilds keeps
    /// them. Returns whether rows were deleted. The views worker runs the same check on its tick.
    #[cfg(test)]
    pub(crate) fn retire_legacy_merkle_if_rebuilt(&self) -> bool {
        if !self.persistent.tree.rebuilt.load(Ordering::SeqCst) {
            return false;
        }
        retire_legacy_merkle(&self.persistent.db)
    }
}

/// The main DB's legacy merkle families: empty after retirement, still declared so an older binary
/// opens the DB.
pub(crate) const LEGACY_MERKLE_CFS: [&str; 2] = ["merkle_leaves", "merkle_nodes"];

pub(crate) fn legacy_merkle_rows_present(db: &DB) -> bool {
    LEGACY_MERKLE_CFS.iter().any(|cf| cf_has_rows(db, cf))
}

/// Range-delete and compact both legacy families when either holds a key.
pub(crate) fn retire_legacy_merkle(db: &DB) -> bool {
    if !legacy_merkle_rows_present(db) {
        return false;
    }
    for name in LEGACY_MERKLE_CFS {
        if let Some(cf) = db.cf_handle(name) {
            if let Err(e) = db.delete_range_cf(&cf, &[0u8; 1][..], &[0xFFu8; 37][..]) {
                println!("[WARN][STORAGE] legacy_merkle_cf_retire_failed cf={} err={}", name, e);
                return false;
            }
        }
    }
    for name in LEGACY_MERKLE_CFS {
        if let Some(cf) = db.cf_handle(name) {
            db.compact_range_cf(&cf, None::<&[u8]>, None::<&[u8]>);
        }
    }
    if crate::node::is_info() {
        println!("[INFO][STORAGE] legacy_merkle_cf_retired rows_present=true");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (st, dir)
    }

    fn delta(leaves: &[([u8; 32], [u8; 32])], nodes: &[((u32, [u8; 32]), [u8; 32])], seq: u64, wipe: bool) -> qnet_state::AcctDelta {
        qnet_state::AcctDelta { leaf_puts: leaves.to_vec(), node_puts: nodes.to_vec(), seq, wipe_nodes: wipe, ..Default::default() }
    }

    #[test]
    fn tree_db_opens_reopens_and_keeps_legacy_cfs_declared() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap().to_string();
        {
            let st = Storage::new(&path).expect("open");
            let store = st.merkle_node_store();
            store.put_batch(&delta(&[([1u8; 32], [2u8; 32])], &[((ROOT_DEPTH, [0u8; 32]), [3u8; 32])], 7, true)).expect("write");
            assert_eq!(store.stored_seq(), 7);
        }
        let st = Storage::new(&path).expect("reopen");
        let store = st.merkle_node_store();
        assert_eq!(store.get_leaf(&[1u8; 32]), Some([2u8; 32]), "rows survive a reopen");
        assert_eq!(store.get_node(ROOT_DEPTH, &[0u8; 32]), Some([3u8; 32]));
        assert_eq!(store.stored_seq(), 7);
        for cf in LEGACY_MERKLE_CFS {
            assert!(crate::storage::persistent::ALL_COLUMN_FAMILIES.contains(&cf), "{} stays declared", cf);
            assert!(st.persistent.db.cf_handle(cf).is_some(), "{} still opens", cf);
        }
    }

    // The account tree's contract on a real DB: leaf deletes remove exactly one leaf, and a
    // rebuild drops the whole old node set.
    #[test]
    fn tree_db_store_honors_the_delta_contract() {
        let (st, _dir) = open();
        let store = st.merkle_node_store();
        let v = |b: u8| [b; 32];
        store.put_batch(&delta(&[([1u8; 32], v(11)), ([2u8; 32], v(22)), ([3u8; 32], v(33))], &[], 1, false)).expect("seed");
        store.put_batch(&qnet_state::AcctDelta { leaf_dels: vec![[2u8; 32]], seq: 2, ..Default::default() }).expect("del");
        assert_eq!(store.get_leaf(&[2u8; 32]), None);
        assert_eq!(store.all_leaves().len(), 2);
        store.put_batch(&delta(&[], &[((0, [0xAA; 32]), v(1)), ((5, [0xBB; 32]), v(2))], 3, false)).expect("nodes");
        store.put_batch(&delta(&[], &[((7, [0xCC; 32]), v(9))], 4, true)).expect("rebuild");
        assert_eq!(store.get_node(0, &[0xAA; 32]), None, "old node wiped by the rebuild");
        assert_eq!(store.get_node(5, &[0xBB; 32]), None);
        assert_eq!(store.get_node(7, &[0xCC; 32]), Some(v(9)));
        assert_eq!(store.get_leaf(&[1u8; 32]), Some(v(11)), "leaves are never wiped by a node rebuild");
        store.wipe_for_full_reset().expect("wipe");
        assert!(store.all_leaves().is_empty());
        assert!(st.persistent.tree.rebuilt.load(Ordering::SeqCst), "a landed rebuild is noted");
    }

    #[test]
    fn tree_db_wipes_itself_after_an_interrupted_chunked_write() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap().to_string();
        {
            let st = Storage::new(&path).expect("open");
            st.merkle_node_store().put_batch(&delta(&[([9u8; 32], [9u8; 32])], &[], 1, false)).expect("seed");
            let meta = st.persistent.tree.db.cf_handle(CF_TREE_META).unwrap();
            st.persistent.tree.db.put_cf(&meta, META_WRITE_OPEN, [1u8]).unwrap();
        }
        let st = Storage::new(&path).expect("reopen");
        let store = st.merkle_node_store();
        assert!(store.all_leaves().is_empty(), "an interrupted write wipes the tree DB");
        assert_eq!(store.stored_seq(), 0);
    }

    #[test]
    fn tree_db_is_wiped_when_legacy_rows_are_present() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap().to_string();
        {
            let st = Storage::new(&path).expect("open");
            st.merkle_node_store().put_batch(&delta(&[([4u8; 32], [4u8; 32])], &[], 1, false)).expect("seed");
            // An older binary rebuilt into the legacy families after the last retirement.
            let cf = st.persistent.db.cf_handle("merkle_leaves").unwrap();
            st.persistent.db.put_cf(&cf, [5u8; 32], [5u8; 32]).unwrap();
        }
        let st = Storage::new(&path).expect("reopen");
        assert!(st.merkle_node_store().all_leaves().is_empty(), "a stale tree DB is wiped");
    }

    #[test]
    fn legacy_merkle_cfs_retire_only_after_this_boots_rebuild() {
        let (st, _dir) = open();
        let cf = st.persistent.db.cf_handle("merkle_nodes").unwrap();
        st.persistent.db.put_cf(&cf, [1u8; 36], [1u8; 32]).unwrap();
        assert!(!st.retire_legacy_merkle_if_rebuilt(), "no rebuild yet: the legacy tree stays");
        assert!(legacy_merkle_rows_present(&st.persistent.db));
        st.merkle_node_store().put_batch(&delta(&[], &[((ROOT_DEPTH, [0u8; 32]), [6u8; 32])], 3, false)).expect("incremental");
        assert!(!st.retire_legacy_merkle_if_rebuilt(), "an incremental delta is not a rebuild");
        st.merkle_node_store().put_batch(&delta(&[([2u8; 32], [2u8; 32])], &[((ROOT_DEPTH, [0u8; 32]), [6u8; 32])], 4, true)).expect("rebuild");
        // The views worker may get there first on its own poll; either way they are gone.
        let _ = st.retire_legacy_merkle_if_rebuilt();
        assert!(!legacy_merkle_rows_present(&st.persistent.db), "after this boot's rebuild the legacy rows go");
        assert!(!st.retire_legacy_merkle_if_rebuilt(), "once");
    }

    #[test]
    fn chunked_put_batch_writes_the_root_row_last() {
        let (st, _dir) = open();
        let store = st.merkle_node_store();
        let leaves: Vec<([u8; 32], [u8; 32])> = (0..300u32).map(|i| { let mut k = [0u8; 32]; k[..4].copy_from_slice(&i.to_be_bytes()); (k, [7u8; 32]) }).collect();
        let root = ((ROOT_DEPTH, [0u8; 32]), [0xABu8; 32]);
        store.put_batch(&delta(&[], &[((ROOT_DEPTH, [0u8; 32]), [0x11u8; 32])], 5, false)).expect("prior finalize");
        // About 300 leaf rows of 80 bytes in chunks of 8 KB: three chunks.
        st.persistent.tree.chunk_bytes.store(8_192, Ordering::SeqCst);
        st.persistent.tree.fail_at_chunk.store(2, Ordering::SeqCst);
        assert!(store.put_batch(&delta(&leaves, &[root], 6, false)).is_err(), "the second chunk fails");
        assert_eq!(store.get_node(ROOT_DEPTH, &[0u8; 32]), Some([0x11u8; 32]), "the root row did not land");
        assert_eq!(store.stored_seq(), 5, "neither did the seq");
        let meta = st.persistent.tree.db.cf_handle(CF_TREE_META).unwrap();
        assert!(st.persistent.tree.db.get_cf(&meta, META_WRITE_OPEN).unwrap().is_some(), "the write is marked open");
        st.persistent.tree.fail_at_chunk.store(0, Ordering::SeqCst);
        store.put_batch(&delta(&leaves, &[root], 7, false)).expect("a whole chunked write");
        assert_eq!(store.get_node(ROOT_DEPTH, &[0u8; 32]), Some([0xABu8; 32]));
        assert_eq!(store.stored_seq(), 7);
        assert!(st.persistent.tree.db.get_cf(&meta, META_WRITE_OPEN).unwrap().is_none(), "closed by the last chunk");
        assert_eq!(store.all_leaves().len(), 300);
    }
}

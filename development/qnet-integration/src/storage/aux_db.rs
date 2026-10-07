//! The aux DB at `<data_dir>/state_aux`: what a certified proof needs and consensus never reads —
//! account leaf preimages and every contract storage tree with its raw values. Every row is derived
//! and re-emitted by the full reset each boot performs, so the DB is recreated at every open and
//! written without a WAL, by one writer thread, off the apply path.

use super::*;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;

pub(crate) const AUX_DB_DIR: &str = "state_aux";
pub(crate) const CF_ACCT_PRE: &str = "acct_pre";
pub(crate) const CF_STOR_LEAVES: &str = "stor_leaves";
pub(crate) const CF_STOR_NODES: &str = "stor_nodes";
pub(crate) const CF_STOR_PRE: &str = "stor_pre";
pub(crate) const CF_AUX_META: &str = "aux_meta";
pub(crate) const AUX_CFS: [&str; 5] = [CF_ACCT_PRE, CF_STOR_LEAVES, CF_STOR_NODES, CF_STOR_PRE, CF_AUX_META];
pub(crate) const AUX_META_SEQ: &[u8] = b"seq";

/// Bytes queued for the writer before `enqueue` holds the caller back.
pub const AUX_QUEUE_CAP_BYTES: usize = 256 * 1024 * 1024;
/// A wait longer than this on a full queue is reported (at most once a minute).
const BACKPRESSURE_WARN_MS: u128 = 100;

fn aux_db_options() -> Options {
    let mut opts = Options::default();
    opts.create_if_missing(true);
    opts.create_missing_column_families(true);
    opts.set_use_fsync(false);
    opts.set_max_open_files(-1);
    opts.set_db_write_buffer_size(128 * 1024 * 1024);
    opts.set_max_background_jobs(2);
    opts.set_max_log_file_size(64 * 1024 * 1024);
    opts.set_keep_log_file_num(4);
    opts.set_level_compaction_dynamic_level_bytes(true);
    opts
}

fn aux_descriptors(cache: &rocksdb::Cache) -> Vec<ColumnFamilyDescriptor> {
    use super::tree_db::hash_cf_options;
    let lz4 = rocksdb::DBCompressionType::Lz4;
    let none = rocksdb::DBCompressionType::None;
    vec![
        ColumnFamilyDescriptor::new(CF_ACCT_PRE, hash_cf_options(cache, 32 * 1024 * 1024, lz4)),
        ColumnFamilyDescriptor::new(CF_STOR_LEAVES, hash_cf_options(cache, 32 * 1024 * 1024, none)),
        ColumnFamilyDescriptor::new(CF_STOR_NODES, hash_cf_options(cache, 32 * 1024 * 1024, none)),
        ColumnFamilyDescriptor::new(CF_STOR_PRE, hash_cf_options(cache, 32 * 1024 * 1024, lz4)),
        ColumnFamilyDescriptor::new(CF_AUX_META, hash_cf_options(cache, 4 * 1024 * 1024, none)),
    ]
}

/// Destroy and recreate `<data_dir>/state_aux`: whatever it held came from an earlier process.
pub(crate) fn open_aux_db(data_dir: &Path, cache: &rocksdb::Cache) -> IntegrationResult<Arc<DB>> {
    let path = data_dir.join(AUX_DB_DIR);
    let db = super::tree_db::open_with_retry("aux_db", || {
        if path.exists() {
            DB::destroy(&aux_db_options(), &path)?;
        }
        DB::open_cf_descriptors(&aux_db_options(), &path, aux_descriptors(cache))
    })?;
    Ok(Arc::new(db))
}

#[inline]
pub(crate) fn stor_leaf_key(c: &[u8; 32], k: &[u8; 32]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(c);
    out[32..].copy_from_slice(k);
    out
}

#[inline]
pub(crate) fn stor_node_key(c: &[u8; 32], depth: u32, k: &[u8; 32]) -> [u8; 68] {
    let mut out = [0u8; 68];
    out[..32].copy_from_slice(c);
    out[32..36].copy_from_slice(&depth.to_be_bytes());
    out[36..].copy_from_slice(k);
    out
}

enum AuxMsg {
    Job(qnet_state::AuxJob),
    WipeAll,
    Marker { height: u64, seq: u64 },
}

impl AuxMsg {
    fn bytes(&self) -> usize {
        match self { AuxMsg::Job(j) => j.bytes.max(1), _ => 1 }
    }
}

/// The aux writer: one FIFO, one thread, byte-capped. Implements the state crate's sink.
pub(crate) struct AuxWriter {
    db: Arc<DB>,
    queue: parking_lot::Mutex<VecDeque<AuxMsg>>,
    cv: parking_lot::Condvar,
    queued_bytes: Arc<AtomicUsize>,
    /// Shared with the views registry: false after a failed write until the next full reset.
    active: Arc<AtomicBool>,
    shutdown: AtomicBool,
    last_backpressure_log: parking_lot::Mutex<Option<std::time::Instant>>,
    views: Arc<super::proof_views::ProofViews>,
    /// The rows this writer wrote, for the views' estimate of what their snapshots pin.
    sketch: Arc<super::row_sketch::RowSketch>,
    worker: parking_lot::Mutex<Option<std::thread::JoinHandle<()>>>,
    #[cfg(test)]
    pub(crate) fail_next: AtomicBool,
}

/// Sketch families of the aux DB, in `AUX_CFS` order (the meta row is not counted).
pub(crate) const AUX_SKETCH_FAMILIES: usize = 4;
const FAMILY_ACCT_PRE: usize = 0;
const FAMILY_STOR_LEAVES: usize = 1;
const FAMILY_STOR_NODES: usize = 2;
const FAMILY_STOR_PRE: usize = 3;

impl AuxWriter {
    pub(crate) fn start(
        db: Arc<DB>,
        views: Arc<super::proof_views::ProofViews>,
        sketch: Arc<super::row_sketch::RowSketch>,
        active: Arc<AtomicBool>,
        queued_bytes: Arc<AtomicUsize>,
    ) -> IntegrationResult<Arc<Self>> {
        let w = Arc::new(Self {
            db,
            queue: parking_lot::Mutex::new(VecDeque::new()),
            cv: parking_lot::Condvar::new(),
            queued_bytes,
            active,
            shutdown: AtomicBool::new(false),
            last_backpressure_log: parking_lot::Mutex::new(None),
            views,
            sketch,
            worker: parking_lot::Mutex::new(None),
            #[cfg(test)]
            fail_next: AtomicBool::new(false),
        });
        let me = Arc::clone(&w);
        let handle = std::thread::Builder::new()
            .name("qnet-aux-writer".to_string())
            .spawn(move || me.run())
            .map_err(|e| IntegrationError::Other(format!("aux_writer_spawn_failed: {}", e)))?;
        *w.worker.lock() = Some(handle);
        Ok(w)
    }

    /// Stop the writer and join it. Queued rows are dropped: the DB is recreated at the next open.
    pub(crate) fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cv.notify_all();
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
    }

    fn push(&self, msg: AuxMsg) {
        let bytes = msg.bytes();
        let mut q = self.queue.lock();
        q.push_back(msg);
        self.queued_bytes.fetch_add(bytes, Ordering::SeqCst);
        self.cv.notify_all();
    }

    /// Queue the capture marker for `height` behind everything queued so far: it pins the DB once
    /// the finalize job carrying `seq` has landed and hands the aux part of a view to the registry.
    pub(crate) fn send_marker(&self, height: u64, seq: u64) {
        self.push(AuxMsg::Marker { height, seq });
    }

    pub(crate) fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::SeqCst)
    }

    pub(crate) fn db(&self) -> &DB {
        &self.db
    }

    #[cfg(test)]
    pub(crate) fn db_arc(&self) -> &Arc<DB> {
        &self.db
    }

    /// Wait until everything queued so far has been processed.
    #[cfg(test)]
    pub(crate) fn drain(&self) {
        let mut q = self.queue.lock();
        while !q.is_empty() || self.queued_bytes.load(Ordering::SeqCst) > 0 {
            if self.shutdown.load(Ordering::SeqCst) { return; }
            self.cv.wait_for(&mut q, std::time::Duration::from_millis(50));
        }
    }

    fn run(self: Arc<Self>) {
        // Set by a failed write: the rows on disk miss that write, so nothing lands and no capture
        // is taken until a full wipe has been processed. Also set from the start when the sink
        // opened inactive: a kept tree with a fresh aux DB is consistent only after a full reset.
        let mut poisoned = !self.active.load(Ordering::SeqCst);
        loop {
            let msg = {
                let mut q = self.queue.lock();
                loop {
                    if self.shutdown.load(Ordering::SeqCst) { return; }
                    if let Some(m) = q.pop_front() { break m; }
                    self.cv.wait_for(&mut q, std::time::Duration::from_millis(500));
                }
            };
            let bytes = msg.bytes();
            match msg {
                AuxMsg::Job(job) => {
                    if !poisoned {
                        match self.write_job(&job) {
                            Ok(()) => self.note_rows(&job),
                            Err(e) => {
                                poisoned = true;
                                self.fail(&e);
                            }
                        }
                    }
                }
                AuxMsg::WipeAll => match self.wipe_all() {
                    Ok(()) => {
                        poisoned = false;
                        let mut b = self.sketch.batch();
                        for f in 0..AUX_SKETCH_FAMILIES { b.wipe_family(f); }
                    }
                    Err(e) => { poisoned = true; self.fail(&e); }
                },
                AuxMsg::Marker { height, seq } => {
                    if poisoned {
                        self.views.drop_offer(height, "aux_untrusted");
                    } else {
                        self.capture(height, seq);
                    }
                }
            }
            self.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
            let _q = self.queue.lock();
            self.cv.notify_all();
        }
    }

    /// The rows a landed job changed. A contract wipe pins every row of that contract, and the full
    /// emit that follows it re-puts them, so the puts account for it.
    fn note_rows(&self, job: &qnet_state::AuxJob) {
        let mut b = self.sketch.batch();
        for (k, v) in &job.acct_pre {
            match v { Some(p) => b.put(FAMILY_ACCT_PRE, &k[..], p.len()), None => b.delete(&k[..]) }
        }
        for ((c, k), v) in &job.stor_leaves {
            let key = stor_leaf_key(c, k);
            match v { Some(_) => b.put(FAMILY_STOR_LEAVES, &key, 32), None => b.delete(&key) }
        }
        for ((c, d, k), v) in &job.stor_nodes {
            let key = stor_node_key(c, *d, k);
            match v { Some(_) => b.put(FAMILY_STOR_NODES, &key, 32), None => b.delete(&key) }
        }
        for ((c, k), v) in &job.stor_pre {
            let key = stor_leaf_key(c, k);
            match v { Some(raw) => b.put(FAMILY_STOR_PRE, &key, raw.len()), None => b.delete(&key) }
        }
    }

    fn capture(&self, height: u64, seq: u64) {
        // Rows written from here on are changes after this capture.
        self.sketch.start_stripe(seq);
        let snap = PinnedDbSnapshot::of(&self.db);
        let stored = snap.get_cf_opt(CF_AUX_META, AUX_META_SEQ, super::proof_views::no_cache())
            .ok().flatten()
            .filter(|v| v.len() == 8)
            .map(|v| u64::from_le_bytes(v[..8].try_into().unwrap_or([0u8; 8])));
        if stored != Some(seq) {
            self.views.drop_offer(height, "aux_seq_mismatch");
            return;
        }
        self.views.offer_part(height, seq, super::proof_views::Part::Aux(snap));
    }

    fn fail(&self, e: &str) {
        self.active.store(false, Ordering::SeqCst);
        eprintln!("[ERR][PROOFVIEW] aux_write_failed err={}", e);
    }

    fn cf(&self, name: &str) -> Result<&rocksdb::ColumnFamily, String> {
        self.db.cf_handle(name).ok_or_else(|| format!("aux column family '{}' not found", name))
    }

    fn write(&self, batch: WriteBatch) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err("injected aux failure".to_string());
        }
        let mut wo = rocksdb::WriteOptions::default();
        wo.disable_wal(true);
        self.db.write_opt(batch, &wo).map_err(|e| e.to_string())
    }

    /// Contract wipes first, as range deletes in their own write; then the rows in batches of at
    /// most `TREE_WRITE_CHUNK_BYTES`, the finalize's seq in the last one.
    fn write_job(&self, job: &qnet_state::AuxJob) -> Result<(), String> {
        let (pre_cf, leaf_cf, node_cf, spre_cf, meta_cf) =
            (self.cf(CF_ACCT_PRE)?, self.cf(CF_STOR_LEAVES)?, self.cf(CF_STOR_NODES)?, self.cf(CF_STOR_PRE)?, self.cf(CF_AUX_META)?);
        if !job.wipes.is_empty() {
            let mut b = WriteBatch::default();
            for c in &job.wipes {
                let mut hi = c.to_vec();
                hi.extend_from_slice(&[0xFFu8; 37]);
                for cf in [leaf_cf, node_cf, spre_cf] {
                    b.delete_range_cf(cf, &c[..], &hi[..]);
                }
            }
            self.write(b)?;
        }
        let chunk = super::tree_db::TREE_WRITE_CHUNK_BYTES;
        let mut batch = WriteBatch::default();
        let mut bytes = 0usize;
        let mut step = |batch: &mut WriteBatch, n: usize| -> Result<(), String> {
            bytes += n;
            if bytes >= chunk {
                self.write(std::mem::take(batch))?;
                bytes = 0;
            }
            Ok(())
        };
        for (k, v) in &job.acct_pre {
            match v {
                Some(p) => batch.put_cf(pre_cf, &k[..], p),
                None => batch.delete_cf(pre_cf, &k[..]),
            }
            step(&mut batch, 48 + v.as_ref().map_or(0, |p| p.len()))?;
        }
        for ((c, k), v) in &job.stor_leaves {
            let key = stor_leaf_key(c, k);
            match v { Some(l) => batch.put_cf(leaf_cf, &key[..], &l[..]), None => batch.delete_cf(leaf_cf, &key[..]) }
            step(&mut batch, 112)?;
        }
        for ((c, d, k), v) in &job.stor_nodes {
            let key = stor_node_key(c, *d, k);
            match v { Some(h) => batch.put_cf(node_cf, &key[..], &h[..]), None => batch.delete_cf(node_cf, &key[..]) }
            step(&mut batch, 116)?;
        }
        for ((c, k), v) in &job.stor_pre {
            let key = stor_leaf_key(c, k);
            match v { Some(raw) => batch.put_cf(spre_cf, &key[..], raw), None => batch.delete_cf(spre_cf, &key[..]) }
            step(&mut batch, 80 + v.as_ref().map_or(0, |r| r.len()))?;
        }
        if let Some(seq) = job.seq {
            batch.put_cf(meta_cf, AUX_META_SEQ, seq.to_le_bytes());
        }
        if !batch.is_empty() {
            self.write(batch)?;
        }
        Ok(())
    }

    fn wipe_all(&self) -> Result<(), String> {
        let mut b = WriteBatch::default();
        for name in AUX_CFS {
            b.delete_range_cf(self.cf(name)?, &[0u8; 1][..], &[0xFFu8; 69][..]);
        }
        self.write(b)
    }
}

impl qnet_state::ProofAuxSink for AuxWriter {
    fn enqueue(&self, job: qnet_state::AuxJob) {
        if !self.active.load(Ordering::SeqCst) {
            return;
        }
        let bytes = job.bytes.max(1);
        let t0 = std::time::Instant::now();
        {
            let mut q = self.queue.lock();
            loop {
                let queued = self.queued_bytes.load(Ordering::SeqCst);
                if queued == 0 || queued + bytes <= AUX_QUEUE_CAP_BYTES || self.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                self.cv.wait_for(&mut q, std::time::Duration::from_millis(100));
            }
            q.push_back(AuxMsg::Job(job));
            self.queued_bytes.fetch_add(bytes, Ordering::SeqCst);
            self.cv.notify_all();
        }
        let waited = t0.elapsed().as_millis();
        if waited > BACKPRESSURE_WARN_MS && crate::node::is_warn() {
            let mut last = self.last_backpressure_log.lock();
            if last.map_or(true, |t| t.elapsed() >= std::time::Duration::from_secs(60)) {
                *last = Some(std::time::Instant::now());
                println!("[WARN][PROOFVIEW] aux_backpressure waited_ms={} queued_bytes={}", waited, self.queued_bytes());
            }
        }
    }

    fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn reset_all(&self) {
        self.push(AuxMsg::WipeAll);
        self.active.store(true, Ordering::SeqCst);
    }
}

impl Storage {
    /// The proof aux sink, handed to `StateManager::set_proof_aux_sink` at boot.
    pub fn proof_aux_sink(&self) -> Arc<dyn qnet_state::ProofAuxSink> {
        self.persistent.aux.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aux_db_is_recreated_at_open() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap().to_string();
        {
            let st = Storage::new(&path).expect("open");
            let mut job = qnet_state::AuxJob::default();
            job.acct_pre.push(([1u8; 32], Some(vec![1, 2, 3])));
            job.seq = Some(9);
            job.bytes = 100;
            qnet_state::ProofAuxSink::enqueue(st.persistent.aux.as_ref(), job);
            st.persistent.aux.drain();
            let cf = st.persistent.aux.db.cf_handle(CF_ACCT_PRE).unwrap();
            assert_eq!(st.persistent.aux.db.get_cf(&cf, [1u8; 32]).unwrap(), Some(vec![1, 2, 3]));
        }
        let st = Storage::new(&path).expect("reopen");
        let db = &st.persistent.aux.db;
        for name in AUX_CFS {
            let cf = db.cf_handle(name).expect("family");
            assert!(db.iterator_cf(&cf, rocksdb::IteratorMode::Start).next().is_none(), "{} is empty after open", name);
        }
    }

    // A failed write stops every later job and capture until a full wipe has been processed.
    #[test]
    fn a_failed_aux_write_poisons_until_the_wipe() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("open");
        let aux = st.persistent.aux.clone();
        let job = |k: u8, seq: Option<u64>| {
            let mut j = qnet_state::AuxJob::default();
            j.acct_pre.push(([k; 32], Some(vec![k])));
            j.seq = seq;
            j.bytes = 80;
            j
        };
        aux.fail_next.store(true, Ordering::SeqCst);
        qnet_state::ProofAuxSink::enqueue(aux.as_ref(), job(1, None));
        aux.drain();
        assert!(!qnet_state::ProofAuxSink::active(aux.as_ref()), "the failure takes the sink down");
        qnet_state::ProofAuxSink::enqueue(aux.as_ref(), job(2, Some(5)));
        aux.drain();
        let cf = aux.db.cf_handle(CF_ACCT_PRE).unwrap();
        assert!(aux.db.get_cf(&cf, [2u8; 32]).unwrap().is_none(), "nothing lands while inactive");
        qnet_state::ProofAuxSink::reset_all(aux.as_ref());
        qnet_state::ProofAuxSink::enqueue(aux.as_ref(), job(3, Some(6)));
        aux.drain();
        assert_eq!(aux.db.get_cf(&cf, [3u8; 32]).unwrap(), Some(vec![3]), "rows land again after the wipe");
    }
}

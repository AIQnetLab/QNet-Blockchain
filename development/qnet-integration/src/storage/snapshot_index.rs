//! How boundary snapshots are stored. A frame, the byte string [sha3(32) | uncompressed_len(8) | zstd], is
//! split into SNAPSHOT_CHUNK_SIZE rows `snap_chunk_{height:020}_{i:06}`, next to its manifest (per-chunk sha3)
//! `snap_manifest_{height:020}` and one small index row `snap_idx_{height:020}` = [chunk count u32 | frame
//! length u64]. The index row and manifest land in the batch that completes the frame, so a frame exists
//! exactly when its index row does. Retention, discovery and every height lookup read index rows; serving a
//! chunk reads its index row and the chunk row. No frame is ever one value.

use super::*;
use rocksdb::{AsColumnFamilyRef, Direction, IteratorMode, ReadOptions};
use sha3::{Digest, Sha3_256};

pub(crate) const SNAP_IDX_PREFIX: &[u8] = b"snap_idx_";
/// Just past every index key: the iterator bound that keeps a scan off the rows beside it.
const SNAP_IDX_END: &[u8] = b"snap_idx`";
/// A frame being written: its rows go if the process stops before the frame completes.
const SNAP_WIP_PREFIX: &[u8] = b"snap_wip_";
const SNAP_WIP_END: &[u8] = b"snap_wip`";
/// Frame header: sha3 of the compressed stream, then the uncompressed length.
const HEADER: usize = 40;

pub(crate) fn idx_key(height: u64) -> String { format!("snap_idx_{:020}", height) }
fn chunk_key(height: u64, index: u64) -> String { format!("snap_chunk_{:020}_{:06}", height, index) }
fn chunk_from(height: u64) -> String { format!("snap_chunk_{:020}_", height) }
fn chunk_to(height: u64) -> String { format!("snap_chunk_{:020}`", height) }
fn manifest_key(height: u64) -> String { format!("snap_manifest_{:020}", height) }
fn wip_key(height: u64) -> String { format!("snap_wip_{:020}", height) }
/// The single-value layout, split into chunk rows at boot.
fn legacy_frame_key(height: u64) -> String { format!("full_snap_{}", height) }

fn height_after(key: &[u8], prefix: &[u8]) -> Option<u64> {
    std::str::from_utf8(key.strip_prefix(prefix)?).ok()?.parse().ok()
}

fn chunk_size() -> usize { Storage::SNAPSHOT_CHUNK_SIZE }

fn io_other(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

fn snapshots_cf(db: &DB) -> IntegrationResult<&rocksdb::ColumnFamily> {
    db.cf_handle("snapshots")
        .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))
}

/// Stage the rows that complete a frame: its manifest and index row. The work-in-progress marker goes too.
fn stage_seal(batch: &mut WriteBatch, cf: &impl AsColumnFamilyRef, manifest: &SnapshotManifest) -> IntegrationResult<()> {
    let bytes = bincode::serialize(manifest).map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
    batch.put_cf(cf, manifest_key(manifest.height).as_bytes(), &bytes);
    let mut idx = Vec::with_capacity(12);
    idx.extend_from_slice(&(manifest.chunk_count as u32).to_le_bytes());
    idx.extend_from_slice(&manifest.total_size.to_le_bytes());
    batch.put_cf(cf, idx_key(manifest.height).as_bytes(), &idx);
    batch.delete_cf(cf, wip_key(manifest.height).as_bytes());
    Ok(())
}

/// Stage a whole frame held in memory: chunk rows, manifest and index row in one batch.
fn stage_frame_bytes(batch: &mut WriteBatch, cf: &impl AsColumnFamilyRef, height: u64, frame: &[u8])
    -> IntegrationResult<SnapshotManifest> {
    let size = chunk_size();
    let mut hashes = Vec::new();
    for (i, chunk) in frame.chunks(size).enumerate() {
        batch.put_cf(cf, chunk_key(height, i as u64).as_bytes(), chunk);
        hashes.push(hex::encode(Sha3_256::digest(chunk)));
    }
    if hashes.is_empty() {
        batch.put_cf(cf, chunk_key(height, 0).as_bytes(), b"");
        hashes.push(hex::encode(Sha3_256::digest(b"")));
    }
    let manifest = SnapshotManifest {
        height,
        total_size: frame.len() as u64,
        chunk_size: size as u64,
        chunk_count: hashes.len() as u64,
        chunk_hashes: hashes,
    };
    stage_seal(batch, cf, &manifest)?;
    Ok(manifest)
}

fn stage_rows_delete(batch: &mut WriteBatch, cf: &impl AsColumnFamilyRef, height: u64) {
    batch.delete_range_cf(cf, chunk_from(height).as_bytes(), chunk_to(height).as_bytes());
    batch.delete_cf(cf, manifest_key(height).as_bytes());
}

/// Stage the deletion of everything stored for one snapshot height.
pub(crate) fn stage_delete(batch: &mut WriteBatch, cf: &impl AsColumnFamilyRef, height: u64) {
    stage_rows_delete(batch, cf, height);
    batch.delete_cf(cf, idx_key(height).as_bytes());
    batch.delete_cf(cf, wip_key(height).as_bytes());
    batch.delete_cf(cf, legacy_frame_key(height).as_bytes());
    batch.delete_cf(cf, format!("state_snap_{}", height).as_bytes());
}

fn within(lower: &[u8], upper: &[u8]) -> ReadOptions {
    let mut ro = ReadOptions::default();
    ro.set_iterate_lower_bound(lower.to_vec());
    ro.set_iterate_upper_bound(upper.to_vec());
    ro
}

/// Heights of the retained frames, ascending.
pub(crate) fn indexed_heights(db: &DB, cf: &impl AsColumnFamilyRef) -> IntegrationResult<Vec<u64>> {
    let mut out = Vec::new();
    for item in db.iterator_cf_opt(cf, within(SNAP_IDX_PREFIX, SNAP_IDX_END), IteratorMode::Start) {
        let (k, _) = item?;
        if let Some(h) = height_after(&k, SNAP_IDX_PREFIX) { out.push(h); }
    }
    Ok(out)
}

/// The highest retained frame height at or below `ceiling`.
pub(crate) fn highest_le(db: &DB, cf: &impl AsColumnFamilyRef, ceiling: u64) -> IntegrationResult<Option<u64>> {
    let start = idx_key(ceiling);
    let mode = IteratorMode::From(start.as_bytes(), Direction::Reverse);
    for item in db.iterator_cf_opt(cf, within(SNAP_IDX_PREFIX, SNAP_IDX_END), mode) {
        let (k, _) = item?;
        if let Some(h) = height_after(&k, SNAP_IDX_PREFIX) { return Ok(Some(h)); }
    }
    Ok(None)
}

/// Writes one frame's bytes into chunk rows as they arrive. Chunk 0 stays in memory until `seal`: it carries
/// the header, which an encoder learns only at the end. Every later chunk is written as soon as it fills, so
/// memory holds two chunks. Dropped unsealed, it removes what it wrote.
pub(crate) struct FrameRows {
    db: Arc<DB>,
    height: u64,
    /// The bytes are a compressed stream whose header `seal` fills in; otherwise the header arrives first.
    encoding: bool,
    head: Vec<u8>,
    cur: Vec<u8>,
    /// Index of `cur`; 0 while chunk 0 is still filling.
    next: u64,
    hashes: Vec<String>,
    /// sha3 over every byte past the header.
    body: Sha3_256,
    total: u64,
    sealed: bool,
}

impl FrameRows {
    pub(crate) fn begin(db: &Arc<DB>, height: u64, encoding: bool) -> IntegrationResult<Self> {
        let cf = snapshots_cf(db)?;
        db.put_cf(&cf, wip_key(height).as_bytes(), b"")?;
        let mut head = Vec::with_capacity(chunk_size());
        if encoding { head.resize(HEADER, 0); }
        Ok(Self {
            db: Arc::clone(db), height, encoding, head, cur: Vec::new(), next: 0, hashes: Vec::new(),
            body: Sha3_256::new(), total: if encoding { HEADER as u64 } else { 0 }, sealed: false,
        })
    }

    /// For received bytes: the header's hash is the hash of the stream that followed it.
    pub(crate) fn body_matches_header(&self) -> bool {
        self.total >= HEADER as u64 && self.head[..32] == self.body.clone().finalize()[..]
    }

    pub(crate) fn len(&self) -> u64 { self.total }

    fn flush_cur(&mut self) -> std::io::Result<()> {
        let cf = self.db.cf_handle("snapshots").ok_or_else(|| io_other("snapshots column family not found"))?;
        self.db.put_cf(&cf, chunk_key(self.height, self.next).as_bytes(), &self.cur).map_err(io_other)?;
        self.hashes.push(hex::encode(Sha3_256::digest(&self.cur)));
        self.cur.clear();
        self.next += 1;
        Ok(())
    }

    /// Stage chunk 0, the last partial chunk, the manifest and the index row into `batch`: the frame exists
    /// once the batch lands. `uncompressed_len` fills the header of an encoded frame.
    pub(crate) fn seal(mut self, uncompressed_len: u64, batch: &mut WriteBatch) -> IntegrationResult<SnapshotManifest> {
        let cf = snapshots_cf(&self.db)?;
        // Callers seal under the snapshot fence; a missing marker means the rows went while they were written.
        if self.db.get_cf(cf, wip_key(self.height).as_bytes())?.is_none() {
            return Err(IntegrationError::StorageError(format!("snapshot_rows_removed_while_writing h={}", self.height)));
        }
        if self.encoding {
            let hash = self.body.clone().finalize();
            self.head[..32].copy_from_slice(&hash);
            self.head[32..HEADER].copy_from_slice(&uncompressed_len.to_le_bytes());
        }
        let mut hashes = Vec::with_capacity(self.hashes.len() + 2);
        hashes.push(hex::encode(Sha3_256::digest(&self.head)));
        hashes.append(&mut self.hashes);
        batch.put_cf(&cf, chunk_key(self.height, 0).as_bytes(), &self.head);
        let mut count = self.next.max(1);
        if !self.cur.is_empty() {
            batch.put_cf(&cf, chunk_key(self.height, self.next).as_bytes(), &self.cur);
            hashes.push(hex::encode(Sha3_256::digest(&self.cur)));
            count = self.next + 1;
        }
        let manifest = SnapshotManifest {
            height: self.height,
            total_size: self.total,
            chunk_size: chunk_size() as u64,
            chunk_count: count,
            chunk_hashes: hashes,
        };
        stage_seal(batch, &cf, &manifest)?;
        self.sealed = true;
        Ok(manifest)
    }
}

impl std::io::Write for FrameRows {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let header_left = (HEADER as u64).saturating_sub(self.total) as usize;
        if header_left < buf.len() { self.body.update(&buf[header_left..]); }
        let size = chunk_size();
        let mut rest = buf;
        while !rest.is_empty() {
            let chunk = if self.next == 0 { &mut self.head } else { &mut self.cur };
            let take = (size - chunk.len()).min(rest.len());
            chunk.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            self.total += take as u64;
            if self.next == 0 {
                if self.head.len() == size { self.next = 1; }
            } else if self.cur.len() == size {
                self.flush_cur()?;
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

impl Drop for FrameRows {
    fn drop(&mut self) {
        if self.sealed { return; }
        if let Ok(cf) = snapshots_cf(&self.db) {
            let mut batch = WriteBatch::default();
            stage_rows_delete(&mut batch, &cf, self.height);
            batch.delete_cf(&cf, wip_key(self.height).as_bytes());
            if let Err(e) = self.db.write(batch) {
                println!("[WARN][SNAPSHOT] unfinished_frame_cleanup_failed h={} err={} action=boot_sweep", self.height, e);
            }
        }
    }
}

/// A stored frame's bytes, read chunk by chunk from a pinned view: retention may retire the frame meanwhile
/// and the reader still sees all of it.
pub struct FrameReader {
    view: PinnedDbSnapshot,
    height: u64,
    next: u64,
    count: u64,
    total: u64,
    buf: Vec<u8>,
    pos: usize,
}

impl FrameReader {
    pub fn total_size(&self) -> u64 { self.total }

    fn load(&self, index: u64) -> std::io::Result<Vec<u8>> {
        let cf = self.view.db.cf_handle("snapshots").ok_or_else(|| io_other("snapshots column family not found"))?;
        self.view.snap.get_cf(&cf, chunk_key(self.height, index).as_bytes()).map_err(io_other)?
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::UnexpectedEof,
                format!("snapshot h={} chunk {} missing", self.height, index)))
    }

    /// The next whole chunk; None after the last. Not to be mixed with `Read`.
    pub fn next_chunk(&mut self) -> Option<std::io::Result<Vec<u8>>> {
        if self.next == self.count { return None; }
        let chunk = self.load(self.next);
        self.next += 1;
        Some(chunk)
    }
}

impl std::io::Read for FrameReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos == self.buf.len() {
            if self.next == self.count { return Ok(0); }
            self.buf = self.load(self.next)?;
            self.next += 1;
            self.pos = 0;
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// This process's one writer of a snapshot height: a frame's rows land outside the fence.
pub(crate) struct HeightClaim<'a> {
    set: &'a parking_lot::Mutex<std::collections::HashSet<u64>>,
    height: u64,
}

impl Drop for HeightClaim<'_> {
    fn drop(&mut self) { self.set.lock().remove(&self.height); }
}

impl Storage {
    /// Boot pass over the snapshot store: drop the rows of every frame whose write never finished, split each
    /// single-value frame of the earlier layout into chunk rows, and drop the retired state_snap_ frames. The
    /// single value stays until retention retires its frame, so a binary without chunk rows still restores
    /// from it.
    pub fn ensure_snapshot_index(&self) -> IntegrationResult<()> {
        let db = &self.persistent.db;
        let cf = snapshots_cf(db)?;
        let _fence = self.snapshot_fence();
        let mut sweep = WriteBatch::default();
        let mut unfinished = 0usize;
        for item in db.iterator_cf_opt(&cf, within(SNAP_WIP_PREFIX, SNAP_WIP_END), IteratorMode::Start) {
            let (k, _) = item?;
            if let Some(h) = height_after(&k, SNAP_WIP_PREFIX) {
                if db.get_cf(&cf, idx_key(h).as_bytes())?.is_none() { stage_rows_delete(&mut sweep, &cf, h); }
                sweep.delete_cf(&cf, &k);
                unfinished += 1;
            }
        }
        let mut retired = 0usize;
        for item in db.iterator_cf_opt(&cf, within(b"state_snap_", b"state_snap`"), IteratorMode::Start) {
            let (k, _) = item?;
            sweep.delete_cf(&cf, &k);
            retired += 1;
        }
        sweep.delete_cf(&cf, b"latest_state_snap");
        db.write(sweep)?;
        // One batch per frame not split yet.
        let mut split = 0usize;
        for item in db.iterator_cf_opt(&cf, within(b"full_snap_", b"full_snap`"), IteratorMode::Start) {
            let (k, v) = item?;
            let h = match height_after(&k, b"full_snap_") { Some(h) => h, None => continue };
            if db.get_cf(&cf, idx_key(h).as_bytes())?.is_some() { continue; }
            let mut batch = WriteBatch::default();
            stage_rows_delete(&mut batch, &cf, h);
            stage_frame_bytes(&mut batch, &cf, h, &v)?;
            db.write(batch)?;
            split += 1;
        }
        if unfinished + retired + split > 0 {
            println!("[INFO][SNAPSHOT] snapshot_store_prepared unfinished_dropped={} single_value_split={} retired_dropped={}",
                     unfinished, split, retired);
        }
        Ok(())
    }

    /// Held by every write of snapshot frames, their index rows and the newest-frame pointer.
    pub(crate) fn snapshot_fence(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.persistent.snapshot_write_lock.lock()
    }

    /// Bumped by every snapshot prune: a capture taken under an older value describes a chain this node
    /// has since abandoned.
    pub(crate) fn snapshot_generation(&self) -> u64 {
        self.persistent.snapshot_gen.load(Ordering::Acquire)
    }

    pub(crate) fn claim_snapshot_height(&self, height: u64) -> IntegrationResult<HeightClaim<'_>> {
        let set = &self.persistent.snapshot_writing;
        if !set.lock().insert(height) {
            return Err(IntegrationError::StorageError(format!("snapshot_height_busy h={}", height)));
        }
        Ok(HeightClaim { set, height })
    }

    pub(crate) fn snapshot_exists(&self, height: u64) -> IntegrationResult<bool> {
        let db = &self.persistent.db;
        Ok(db.get_cf(&snapshots_cf(db)?, idx_key(height).as_bytes())?.is_some())
    }

    /// Start writing the frame at `height` in chunk rows.
    pub(crate) fn begin_frame(&self, height: u64, encoding: bool) -> IntegrationResult<FrameRows> {
        FrameRows::begin(&self.persistent.db, height, encoding)
    }

    /// Store complete frame bytes at `height`, replacing a frame stored there. The newest-frame pointer is
    /// not moved.
    #[cfg(test)]
    pub(crate) fn store_frame_bytes(&self, height: u64, frame: &[u8]) -> IntegrationResult<SnapshotManifest> {
        let _claim = self.claim_snapshot_height(height)?;
        let db = &self.persistent.db;
        let cf = snapshots_cf(db)?;
        let _fence = self.snapshot_fence();
        let mut batch = WriteBatch::default();
        stage_delete(&mut batch, &cf, height);
        let manifest = stage_frame_bytes(&mut batch, &cf, height, frame)?;
        db.write(batch)?;
        Ok(manifest)
    }

    /// Open the frame stored at `height`; None when no frame is indexed there.
    pub fn open_frame(&self, height: u64) -> IntegrationResult<Option<FrameReader>> {
        let view = PinnedDbSnapshot::of(&self.persistent.db);
        let meta = {
            let cf = snapshots_cf(&view.db)?;
            view.snap.get_cf(&cf, idx_key(height).as_bytes())?
        };
        let (count, total) = match meta {
            Some(v) if v.len() >= 12 => (
                u32::from_le_bytes(v[0..4].try_into().expect("4 bytes")) as u64,
                u64::from_le_bytes(v[4..12].try_into().expect("8 bytes")),
            ),
            _ => return Ok(None),
        };
        Ok(Some(FrameReader { view, height, next: 0, count, total, buf: Vec::new(), pos: 0 }))
    }

    /// The stored manifest of the frame at `height`: one row.
    pub fn get_snapshot_manifest(&self, height: u64) -> IntegrationResult<Option<SnapshotManifest>> {
        let db = &self.persistent.db;
        match db.get_cf(&snapshots_cf(db)?, manifest_key(height).as_bytes())? {
            Some(v) => Ok(Some(bincode::deserialize(&v).map_err(|e| IntegrationError::DeserializationError(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// One stored chunk of the frame at `height`: the index row, then the chunk row.
    pub fn get_snapshot_chunk(&self, height: u64, chunk_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        if !self.snapshot_exists(height)? { return Ok(None); }
        let db = &self.persistent.db;
        Ok(db.get_cf(&snapshots_cf(db)?, chunk_key(height, chunk_index).as_bytes())?)
    }

    /// The whole frame at `height` in memory, for tests.
    #[cfg(test)]
    pub fn get_snapshot_data(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        use std::io::Read;
        match self.open_frame(height)? {
            Some(mut r) => {
                let mut out = Vec::new();
                r.read_to_end(&mut out)?;
                Ok(Some(out))
            }
            None => Ok(None),
        }
    }

    /// Write a chunk row the downloader verified against its manifest.
    pub(crate) fn put_frame_chunk(db: &DB, height: u64, index: u64, bytes: &[u8]) -> IntegrationResult<()> {
        db.put_cf(&snapshots_cf(db)?, chunk_key(height, index).as_bytes(), bytes)?;
        Ok(())
    }

    /// Complete a frame whose chunk rows were written one by one, with the manifest they were checked against.
    pub(crate) fn seal_downloaded_frame(&self, manifest: &SnapshotManifest) -> IntegrationResult<()> {
        let db = &self.persistent.db;
        let cf = snapshots_cf(db)?;
        let _fence = self.snapshot_fence();
        if db.get_cf(cf, wip_key(manifest.height).as_bytes())?.is_none() {
            return Err(IntegrationError::StorageError(format!(
                "snapshot_rows_removed_while_downloading h={}", manifest.height)));
        }
        let mut batch = WriteBatch::default();
        stage_seal(&mut batch, &cf, manifest)?;
        db.write(batch)?;
        Ok(())
    }

    /// Drop everything at a height the caller holds and no frame is indexed at: what a download that did not
    /// finish left behind.
    pub(crate) fn abort_frame(&self, _claim: &HeightClaim<'_>, height: u64) {
        if let Ok(cf) = snapshots_cf(&self.persistent.db) {
            let _fence = self.snapshot_fence();
            let mut batch = WriteBatch::default();
            stage_delete(&mut batch, &cf, height);
            let _ = self.persistent.db.write(batch);
        }
    }

    /// Mark a frame whose chunk rows are about to be written one by one.
    pub(crate) fn mark_frame_in_progress(&self, height: u64) -> IntegrationResult<()> {
        let db = &self.persistent.db;
        db.put_cf(&snapshots_cf(db)?, wip_key(height).as_bytes(), b"")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn open() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (st, dir)
    }

    fn rows_of(st: &Storage, lower: &str, upper: &str) -> usize {
        let cf = st.persistent.db.cf_handle("snapshots").expect("cf");
        st.persistent.db.iterator_cf_opt(&cf, within(lower.as_bytes(), upper.as_bytes()), IteratorMode::Start).count()
    }

    // A frame larger than one chunk is stored as chunk rows, served one row per chunk, and read back whole.
    #[test]
    fn a_frame_is_stored_as_chunk_rows_and_served_one_row_per_chunk() {
        let (st, _d) = open();
        let size = chunk_size();
        let frame: Vec<u8> = (0..(2 * size + 12_345)).map(|i| (i % 251) as u8).collect();
        let manifest = st.store_frame_bytes(7_200, &frame).expect("store");
        assert_eq!(manifest.chunk_count, 3);
        assert_eq!(st.get_snapshot_manifest(7_200).expect("manifest").expect("present").chunk_hashes, manifest.chunk_hashes);
        for (i, want) in frame.chunks(size).enumerate() {
            let got = st.get_snapshot_chunk(7_200, i as u64).expect("chunk").expect("present");
            assert_eq!(got, want);
            assert_eq!(hex::encode(Sha3_256::digest(&got)), manifest.chunk_hashes[i]);
        }
        assert_eq!(st.get_snapshot_data(7_200).expect("read").expect("present"), frame);
        let cf = st.persistent.db.cf_handle("snapshots").expect("cf");
        let mut batch = WriteBatch::default();
        stage_delete(&mut batch, &cf, 7_200);
        st.persistent.db.write(batch).expect("delete");
        assert!(st.get_snapshot_chunk(7_200, 0).expect("chunk").is_none());
        assert_eq!(rows_of(&st, "snap_chunk_", "snap_chunk`"), 0, "no chunk row outlives its frame");
    }

    // The streaming writer produces the same rows as the in-memory split, and fills an encoder's header.
    #[test]
    fn streamed_rows_match_the_whole_frame_split() {
        let (st, _d) = open();
        let size = chunk_size();
        let body: Vec<u8> = (0..(size + 999)).map(|i| (i % 13) as u8).collect();
        let mut rows = st.begin_frame(90, true).expect("begin");
        for piece in body.chunks(7_777) { rows.write_all(piece).expect("write"); }
        let mut batch = WriteBatch::default();
        let manifest = rows.seal(123, &mut batch).expect("seal");
        st.persistent.db.write(batch).expect("land");
        let frame = st.get_snapshot_data(90).expect("read").expect("present");
        assert_eq!(&frame[..32], &Sha3_256::digest(&body)[..], "the header hashes the stream after it");
        assert_eq!(u64::from_le_bytes(frame[32..40].try_into().unwrap()), 123);
        assert_eq!(&frame[40..], &body[..]);
        let (other, _d2) = open();
        assert_eq!(other.store_frame_bytes(90, &frame).expect("store").chunk_hashes, manifest.chunk_hashes);
        assert_eq!(rows_of(&st, "snap_wip_", "snap_wip`"), 0);
    }

    // A frame whose write stopped halfway leaves no rows: dropped unsealed, or found at boot.
    #[test]
    fn an_unfinished_frame_leaves_no_rows() {
        let (st, _d) = open();
        let size = chunk_size();
        {
            let mut rows = st.begin_frame(3_600, false).expect("begin");
            rows.write_all(&vec![1u8; 2 * size]).expect("write");
        }
        assert_eq!(rows_of(&st, "snap_chunk_", "snap_chunk`"), 0, "dropped unsealed");
        assert!(!st.snapshot_exists(3_600).expect("exists"));
        // A crash between the chunk rows and the seal: the boot pass finds the marker.
        st.mark_frame_in_progress(3_600).expect("mark");
        Storage::put_frame_chunk(&st.persistent.db, 3_600, 1, &[9u8; 16]).expect("chunk");
        st.ensure_snapshot_index().expect("boot pass");
        assert_eq!(rows_of(&st, "snap_chunk_", "snap_chunk`"), 0);
        assert_eq!(rows_of(&st, "snap_wip_", "snap_wip`"), 0);
    }

    // A single-value frame of the earlier layout becomes chunk rows at boot, byte for byte.
    #[test]
    fn a_single_value_frame_is_split_at_boot() {
        let (st, _d) = open();
        let frame: Vec<u8> = (0..(chunk_size() + 5)).map(|i| (i % 7) as u8).collect();
        let cf = st.persistent.db.cf_handle("snapshots").expect("cf");
        st.persistent.db.put_cf(&cf, b"full_snap_14400", &frame).expect("old layout");
        st.ensure_snapshot_index().expect("boot pass");
        assert_eq!(st.get_snapshot_data(14_400).expect("read").expect("present"), frame);
        assert_eq!(st.get_snapshot_manifest(14_400).expect("manifest").expect("present").chunk_count, 2);
        assert!(st.persistent.db.get_cf(&cf, b"full_snap_14400").expect("get").is_some(),
                "the single value stays for a binary that reads only it");
        st.ensure_snapshot_index().expect("second pass splits nothing again");
        let mut batch = WriteBatch::default();
        stage_delete(&mut batch, &cf, 14_400);
        st.persistent.db.write(batch).expect("retire");
        assert!(st.persistent.db.get_cf(&cf, b"full_snap_14400").expect("get").is_none(), "retirement takes both");
    }

    // A streamed frame that ends exactly on a chunk boundary seals without an empty tail chunk.
    #[test]
    fn a_frame_of_whole_chunks_has_no_empty_tail() {
        let (st, _d) = open();
        let size = chunk_size();
        let mut rows = st.begin_frame(3_600, true).expect("begin");
        rows.write_all(&vec![5u8; 2 * size - HEADER]).expect("write");
        let mut batch = WriteBatch::default();
        let manifest = rows.seal(7, &mut batch).expect("seal");
        st.persistent.db.write(batch).expect("land");
        assert_eq!(manifest.chunk_count, 2);
        assert_eq!(manifest.total_size, (2 * size) as u64);
        assert_eq!(st.get_snapshot_data(3_600).expect("read").expect("present").len(), 2 * size);
    }

    // A macroblock drop reaching a frame that is being written leaves its rows to the writer.
    #[test]
    fn a_macroblock_drop_leaves_a_frame_being_written() {
        let (st, _d) = open();
        let claim = st.claim_snapshot_height(90).expect("claim");
        let mut rows = st.begin_frame(90, false).expect("begin");
        rows.write_all(&vec![1u8; chunk_size() + 1]).expect("write");
        st.persistent.delete_macroblock(1).expect("drop");
        let mut batch = WriteBatch::default();
        rows.seal(0, &mut batch).expect("seal: every row is still there");
        st.persistent.db.write(batch).expect("land");
        drop(claim);
        assert_eq!(st.get_snapshot_data(90).expect("read").expect("present").len(), chunk_size() + 1);
        st.persistent.delete_macroblock(1).expect("drop");
        assert!(!st.snapshot_exists(90).expect("exists"), "unclaimed: the frame goes with its macroblock");
    }

    // A frame whose rows were removed while it was written is not sealed.
    #[test]
    fn a_frame_whose_rows_went_is_not_sealed() {
        let (st, _d) = open();
        let mut rows = st.begin_frame(7_200, false).expect("begin");
        rows.write_all(&vec![2u8; chunk_size() + 1]).expect("write");
        let cf = st.persistent.db.cf_handle("snapshots").expect("cf");
        let mut del = WriteBatch::default();
        stage_delete(&mut del, &cf, 7_200);
        st.persistent.db.write(del).expect("delete");
        let mut batch = WriteBatch::default();
        assert!(rows.seal(0, &mut batch).is_err());
        assert!(!st.snapshot_exists(7_200).expect("exists"));
    }

    fn frame_of(payload: &[u8], declared: u64) -> Vec<u8> {
        let compressed = zstd::encode_all(payload, 3).expect("zstd");
        let mut frame = Sha3_256::digest(&compressed).to_vec();
        frame.extend_from_slice(&declared.to_le_bytes());
        frame.extend_from_slice(&compressed);
        frame
    }

    fn payload(tail: &[u8]) -> Vec<u8> {
        let mut p = vec![0x02u8];
        p.extend_from_slice(&2u32.to_le_bytes());
        p.extend_from_slice(&90u64.to_le_bytes());
        p.extend_from_slice(&0u64.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(b"a");
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(b"v");
        p.extend_from_slice(tail);
        p
    }

    // The parser holds a frame to its header: the declared length both ways, the stream hash, and nothing
    // after the last section.
    #[test]
    fn a_frame_is_held_to_its_header() {
        let walk = |f: &[u8]| Storage::walk_frame(&mut &f[..], |_, _, _| Ok(()));
        let good = payload(b"");
        let n = good.len() as u64;
        assert_eq!(walk(&frame_of(&good, n)).expect("valid"), 90);
        assert!(walk(&frame_of(&good, n + 1)).is_err(), "shorter than declared");
        assert!(walk(&frame_of(&good, n - 1)).is_err(), "longer than declared");
        let trailing = payload(b"REWARDS_V1REWARDS_ENDx");
        assert!(walk(&frame_of(&trailing, trailing.len() as u64)).is_err(), "bytes after the sections");
        let mut tampered = frame_of(&good, n);
        tampered[0] ^= 1;
        assert!(walk(&tampered).is_err(), "the hash covers the stream");
    }

    // One writer per height: a second claim waits for the first to go.
    #[test]
    fn a_snapshot_height_has_one_writer() {
        let (st, _d) = open();
        let first = st.claim_snapshot_height(90).expect("first");
        assert!(st.claim_snapshot_height(90).is_err());
        drop(first);
        assert!(st.claim_snapshot_height(90).is_ok());
    }
}

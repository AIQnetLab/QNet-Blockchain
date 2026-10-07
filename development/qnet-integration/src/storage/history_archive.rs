//! Durable block history. Super nodes drop microblock bodies a day after they are produced; a node
//! started with QNET_ARCHIVE=1 first writes every finalized epoch into one segment file under
//! `<data_dir>/archive`, and holds body pruning until it has. Off-consensus and node-local: apply,
//! sync and finality never read it; RPC serves it where the retention window no longer can.
//!
//! A segment proves itself. Next to the epoch's microblocks it carries the macroblocks that certify
//! them, with their committee signatures and the signers' public keys: signatures → checkpoint →
//! window block hashes → block → transactions, without trusting whoever serves the file. Blocks are
//! checked before they are written (committed slot hash, certified window list, merkle root).
//! Producer signatures, VRF proofs and timeout proofs are left out: none is part of the block hash,
//! and the certificate proves more than they do (that the block is final, not only who produced it).
//!
//! Layout, little-endian: header `QARC | version u8 | epoch u64 | first u64 | last u64`; frames
//! `{ zstd_len u32 | zstd({ len u32 | record }*) }*`, each closed near FRAME_TARGET_BYTES, holding first
//! the blocks (bincode MicroBlock) and then the macroblocks (bincode `(MacroBlock bytes, [(signer, pk)])`);
//! block index and macroblock index, each `count u32 | { key u64 | frame_offset u64 | record_offset u32 }*`
//! (key = height, macroblock index); footer `block_index_offset u64 | macro_index_offset u64 | QARX`.
//! Writing streams frame by frame and one read decodes one frame, so memory stays bounded by a frame
//! however busy the epoch was.

use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

/// Blocks per segment: one emission epoch.
pub const SEGMENT_BLOCKS: u64 = 14_400;
/// Longest the archive may hold body and transaction pruning back. Past it the rows go anyway and the
/// segment records them as missing: a stuck archive must not fill the disk.
pub const ARCHIVE_HOLD_MAX_BLOCKS: u64 = 7 * 86_400;
/// Epochs written per mid-epoch pass, so a first enable or a long outage never turns into one unbounded pass.
pub const EPOCHS_PER_RUN: u64 = 6;
const SEGMENT_MAGIC: &[u8; 4] = b"QARC";
const INDEX_MAGIC: &[u8; 4] = b"QARX";
/// Bump when the layout, MicroBlock, MacroBlock or Transaction changes its bincode form.
const SEGMENT_VERSION: u8 = 1;
const HEADER_LEN: u64 = 4 + 1 + 8 * 3;
const FOOTER_LEN: u64 = 8 + 8 + 4;
const INDEX_ENTRY_LEN: u64 = 8 + 8 + 4;
/// Uncompressed bytes a frame collects before it is closed.
const FRAME_TARGET_BYTES: usize = 1 << 20;
const ZSTD_LEVEL: i32 = 6;
const INDEXES_CACHED: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentMeta {
    pub epoch: u64,
    pub first_height: u64,
    pub last_height: u64,
    pub blocks: u64,
    /// Inclusive height ranges holding a committed block whose body this node no longer had.
    pub missing: Vec<(u64, u64)>,
    /// Macroblocks carried (every window that covers a height of the epoch this node holds).
    pub macroblocks: u64,
    /// Of those, macroblocks whose committee signatures were already stripped when the segment was written.
    pub macroblocks_unsigned: u64,
    pub bytes: u64,
    /// SHA3-256 of the segment file.
    pub sha3: String,
}

/// An archived macroblock and the public key of every signer of its certificate.
pub type ArchivedMacroblock = (qnet_state::MacroBlock, Vec<(String, Vec<u8>)>);

/// (key, frame offset, record offset inside the decoded frame), ascending by key.
type IndexEntries = Vec<(u64, u64, u32)>;

struct SegmentIndex {
    blocks: IndexEntries,
    macroblocks: IndexEntries,
}

pub struct HistoryArchive {
    dir: PathBuf,
    metas: RwLock<BTreeMap<u64, SegmentMeta>>,
    writer: parking_lot::Mutex<()>,
    indexes: parking_lot::Mutex<VecDeque<(u64, Arc<SegmentIndex>)>>,
    /// The last decoded frame, (epoch, frame offset, bytes): a header page reads many blocks from one frame.
    frame: parking_lot::Mutex<Option<(u64, u64, Arc<Vec<u8>>)>>,
    /// One pass right after start, so a restart or a roll shows at once whether the archive can write.
    boot_pass_due: AtomicBool,
}

impl HistoryArchive {
    /// Open `dir`, dropping what an interrupted write left behind: temp files, and a segment whose
    /// meta was never written (the meta is renamed into place last).
    pub fn open(dir: PathBuf) -> IntegrationResult<Self> {
        std::fs::create_dir_all(&dir)
            .map_err(|e| IntegrationError::StorageError(format!("archive dir {}: {}", dir.display(), e)))?;
        let mut metas = BTreeMap::new();
        let mut segments = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| IntegrationError::StorageError(format!("archive read_dir: {}", e)))? {
            let path = match entry { Ok(e) => e.path(), Err(_) => continue };
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if name.ends_with(".tmp") {
                let _ = std::fs::remove_file(&path);
            } else if let Some(epoch) = parse_epoch(&name, ".json") {
                match std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<SegmentMeta>(&b).ok()) {
                    Some(m) if m.epoch == epoch => { metas.insert(epoch, m); }
                    _ => if crate::node::is_warn() { println!("[WARN][HISTORY] meta_unreadable file={}", name); },
                }
            } else if let Some(epoch) = parse_epoch(&name, ".qarc") {
                segments.push(epoch);
            }
        }
        let arch = Self {
            dir,
            metas: RwLock::new(BTreeMap::new()),
            writer: parking_lot::Mutex::new(()),
            indexes: parking_lot::Mutex::new(VecDeque::new()),
            frame: parking_lot::Mutex::new(None),
            boot_pass_due: AtomicBool::new(true),
        };
        for epoch in segments {
            if !metas.contains_key(&epoch) { let _ = std::fs::remove_file(arch.segment_path(epoch)); }
        }
        metas.retain(|e, _| arch.segment_path(*e).is_file());
        *arch.metas.write() = metas;
        Ok(arch)
    }

    /// True once per process: the first pass after start, whatever the height.
    pub fn take_boot_pass(&self) -> bool {
        self.boot_pass_due.swap(false, Ordering::AcqRel)
    }

    fn segment_path(&self, epoch: u64) -> PathBuf { self.dir.join(format!("seg_{:08}.qarc", epoch)) }
    fn meta_path(&self, epoch: u64) -> PathBuf { self.dir.join(format!("seg_{:08}.json", epoch)) }

    /// The epoch after the highest one written; None before the first segment.
    pub fn next_epoch(&self) -> Option<u64> {
        self.metas.read().keys().next_back().map(|e| e + 1)
    }

    pub fn segments(&self, from_epoch: u64, limit: usize) -> Vec<SegmentMeta> {
        self.metas.read().range(from_epoch..).take(limit).map(|(_, m)| m.clone()).collect()
    }

    /// The segment file and its meta, for a download.
    pub fn segment_file(&self, epoch: u64) -> Option<(PathBuf, SegmentMeta)> {
        let meta = self.metas.read().get(&epoch).cloned()?;
        Some((self.segment_path(epoch), meta))
    }

    /// The archived block at `height`, if a segment holds it.
    pub fn block(&self, height: u64) -> Option<qnet_state::MicroBlock> {
        let block: qnet_state::MicroBlock = self.record(height / SEGMENT_BLOCKS, height, |i| &i.blocks)?;
        (block.height == height).then_some(block)
    }

    /// The archived macroblock `index` with its signers' keys. A window on an epoch boundary sits in two
    /// segments; the one that starts at it is asked first.
    pub fn macroblock(&self, index: u64) -> Option<ArchivedMacroblock> {
        let head = index.saturating_mul(qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL);
        let epochs = [head / SEGMENT_BLOCKS, head.saturating_sub(1) / SEGMENT_BLOCKS];
        epochs.iter().find_map(|&e| {
            let (raw, keys): (Vec<u8>, Vec<(String, Vec<u8>)>) = self.record(e, index, |i| &i.macroblocks)?;
            let mb: qnet_state::MacroBlock = bincode::deserialize(&raw).ok()?;
            (mb.height == index).then_some((mb, keys))
        })
    }

    /// One record of `epoch`'s segment by its key in the index `pick` selects.
    fn record<T: serde::de::DeserializeOwned>(&self, epoch: u64, key: u64, pick: fn(&SegmentIndex) -> &IndexEntries) -> Option<T> {
        if !self.metas.read().contains_key(&epoch) { return None; }
        let path = self.segment_path(epoch);
        let result = (|| -> Result<Option<T>, String> {
            let index = self.index_of(epoch, &path)?;
            let entries = pick(&index);
            let Ok(i) = entries.binary_search_by_key(&key, |e| e.0) else { return Ok(None) };
            let (_, frame_offset, record_offset) = entries[i];
            let frame = self.frame_at(epoch, &path, frame_offset)?;
            read_record(&frame, record_offset).map(Some)
        })();
        match result {
            Ok(r) => r,
            Err(e) => {
                if crate::node::is_warn() { println!("[WARN][HISTORY] segment_unreadable epoch={} key={} err={}", epoch, key, e); }
                None
            }
        }
    }

    fn index_of(&self, epoch: u64, path: &Path) -> Result<Arc<SegmentIndex>, String> {
        if let Some((_, idx)) = self.indexes.lock().iter().find(|(e, _)| *e == epoch) {
            return Ok(idx.clone());
        }
        let idx = Arc::new(read_index(path)?);
        let mut cache = self.indexes.lock();
        cache.push_back((epoch, idx.clone()));
        while cache.len() > INDEXES_CACHED { cache.pop_front(); }
        Ok(idx)
    }

    fn frame_at(&self, epoch: u64, path: &Path, offset: u64) -> Result<Arc<Vec<u8>>, String> {
        if let Some((e, o, f)) = self.frame.lock().as_ref() {
            if *e == epoch && *o == offset { return Ok(f.clone()); }
        }
        let frame = Arc::new(read_frame(path, offset)?);
        *self.frame.lock() = Some((epoch, offset, frame.clone()));
        Ok(frame)
    }

    /// Put a finished segment in place: file rename, then its meta the same way. A crash between the
    /// two leaves a segment without a meta, which the next open deletes.
    fn commit(&self, epoch: u64, tmp: &Path, meta: &SegmentMeta) -> IntegrationResult<()> {
        let io = |e: std::io::Error| IntegrationError::StorageError(format!("archive commit epoch={}: {}", epoch, e));
        std::fs::rename(tmp, self.segment_path(epoch)).map_err(io)?;
        let meta_bytes = serde_json::to_vec(meta)
            .map_err(|e| IntegrationError::SerializationError(format!("archive meta: {}", e)))?;
        write_atomic(&self.meta_path(epoch), &meta_bytes)?;
        self.forget_cached(&[epoch]);
        self.metas.write().insert(epoch, meta.clone());
        Ok(())
    }

    fn forget_cached(&self, epochs: &[u64]) {
        self.indexes.lock().retain(|(e, _)| !epochs.contains(e));
        let mut frame = self.frame.lock();
        if frame.as_ref().map_or(false, |(e, _, _)| epochs.contains(e)) { *frame = None; }
    }

    /// Delete every segment reaching above `target`. Meta first, so a crash in between leaves a
    /// meta-less segment the next open removes, never a meta naming a deleted file.
    fn retract_above(&self, target: u64) -> u64 {
        let _w = self.writer.lock();
        let doomed: Vec<u64> = self.metas.read().values().filter(|m| m.last_height > target).map(|m| m.epoch).collect();
        for &epoch in &doomed {
            let _ = std::fs::remove_file(self.meta_path(epoch));
            let _ = std::fs::remove_file(self.segment_path(epoch));
            self.metas.write().remove(&epoch);
        }
        self.forget_cached(&doomed);
        doomed.len() as u64
    }
}

fn parse_epoch(name: &str, ext: &str) -> Option<u64> {
    name.strip_prefix("seg_")?.strip_suffix(ext)?.parse().ok()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> IntegrationResult<()> {
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let io = |e: std::io::Error| IntegrationError::StorageError(format!("archive write {}: {}", path.display(), e));
    let mut f = std::fs::File::create(&tmp).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

/// Streams one segment to disk: records collect into a frame, a full frame is compressed and written,
/// and only the indexes (20 bytes per record) are kept until the end.
struct SegmentWriter {
    file: std::io::BufWriter<std::fs::File>,
    pos: u64,
    hasher: sha3::Sha3_256,
    frame: Vec<u8>,
    frame_records: Vec<(bool, u64, u32)>,
    blocks: IndexEntries,
    macroblocks: IndexEntries,
}

impl SegmentWriter {
    fn create(path: &Path, epoch: u64, first: u64, last: u64) -> std::io::Result<Self> {
        let mut w = Self {
            file: std::io::BufWriter::new(std::fs::File::create(path)?),
            pos: 0,
            hasher: sha3::Sha3_256::new(),
            frame: Vec::new(),
            frame_records: Vec::new(),
            blocks: Vec::new(),
            macroblocks: Vec::new(),
        };
        w.emit(SEGMENT_MAGIC)?;
        w.emit(&[SEGMENT_VERSION])?;
        for v in [epoch, first, last] { w.emit(&v.to_le_bytes())?; }
        Ok(w)
    }

    fn emit(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.pos += bytes.len() as u64;
        Ok(())
    }

    fn put_block(&mut self, block: &qnet_state::MicroBlock) -> Result<(), String> {
        let raw = bincode::serialize(block).map_err(|e| format!("h={} encode: {}", block.height, e))?;
        self.put(false, block.height, &raw)
    }

    fn put_macroblock(&mut self, index: u64, record: &(Vec<u8>, Vec<(String, Vec<u8>)>)) -> Result<(), String> {
        let raw = bincode::serialize(record).map_err(|e| format!("macroblock {} encode: {}", index, e))?;
        self.put(true, index, &raw)
    }

    fn put(&mut self, macroblock: bool, key: u64, raw: &[u8]) -> Result<(), String> {
        let record_offset = u32::try_from(self.frame.len()).map_err(|_| "frame over 4 GiB".to_string())?;
        let len = u32::try_from(raw.len()).map_err(|_| format!("record {} over 4 GiB", key))?;
        self.frame_records.push((macroblock, key, record_offset));
        self.frame.extend_from_slice(&len.to_le_bytes());
        self.frame.extend_from_slice(raw);
        if self.frame.len() >= FRAME_TARGET_BYTES { self.close_frame().map_err(|e| e.to_string())?; }
        Ok(())
    }

    fn close_frame(&mut self) -> std::io::Result<()> {
        if self.frame.is_empty() { return Ok(()); }
        let z = zstd::bulk::compress(&self.frame, ZSTD_LEVEL)?;
        let len = u32::try_from(z.len()).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "compressed frame over 4 GiB"))?;
        let frame_offset = self.pos;
        self.emit(&len.to_le_bytes())?;
        self.emit(&z)?;
        for (macroblock, key, ro) in self.frame_records.drain(..) {
            if macroblock { self.macroblocks.push((key, frame_offset, ro)); } else { self.blocks.push((key, frame_offset, ro)); }
        }
        self.frame.clear();
        Ok(())
    }

    fn emit_index(&mut self, entries: &IndexEntries) -> std::io::Result<()> {
        let count = u32::try_from(entries.len()).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "index too long"))?;
        self.emit(&count.to_le_bytes())?;
        for (key, fo, ro) in entries {
            self.emit(&key.to_le_bytes())?;
            self.emit(&fo.to_le_bytes())?;
            self.emit(&ro.to_le_bytes())?;
        }
        Ok(())
    }

    /// Flush the last frame, both indexes and the footer; fsync. Returns (file bytes, sha3, blocks, macroblocks).
    fn finish(mut self) -> std::io::Result<(u64, String, u64, u64)> {
        self.close_frame()?;
        let (blocks, macroblocks) = (std::mem::take(&mut self.blocks), std::mem::take(&mut self.macroblocks));
        let block_index_offset = self.pos;
        self.emit_index(&blocks)?;
        let macro_index_offset = self.pos;
        self.emit_index(&macroblocks)?;
        self.emit(&block_index_offset.to_le_bytes())?;
        self.emit(&macro_index_offset.to_le_bytes())?;
        self.emit(INDEX_MAGIC)?;
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        let sha3 = hex::encode(std::mem::take(&mut self.hasher).finalize());
        Ok((self.pos, sha3, blocks.len() as u64, macroblocks.len() as u64))
    }
}

fn u64_at(b: &[u8], o: usize) -> u64 { u64::from_le_bytes(b[o..o + 8].try_into().unwrap_or([0u8; 8])) }

/// Both indexes of a segment file, checked against the header range, each other and the file length.
fn read_index(path: &Path) -> Result<SegmentIndex, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < HEADER_LEN + 8 + FOOTER_LEN { return Err("file too short".into()); }
    let mut head = [0u8; HEADER_LEN as usize];
    f.read_exact(&mut head).map_err(|e| format!("header: {}", e))?;
    if &head[..4] != SEGMENT_MAGIC { return Err("bad magic".into()); }
    if head[4] != SEGMENT_VERSION { return Err(format!("version {}", head[4])); }
    let (first, last) = (u64_at(&head, 13), u64_at(&head, 21));

    let mut foot = [0u8; FOOTER_LEN as usize];
    f.seek(SeekFrom::Start(len - FOOTER_LEN)).map_err(|e| e.to_string())?;
    f.read_exact(&mut foot).map_err(|e| format!("footer: {}", e))?;
    if &foot[16..] != INDEX_MAGIC { return Err("bad index magic".into()); }
    let (block_off, macro_off) = (u64_at(&foot, 0), u64_at(&foot, 8));
    if block_off < HEADER_LEN || macro_off < block_off + 4 || macro_off + 4 > len - FOOTER_LEN {
        return Err("index offsets out of range".into());
    }
    let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let blocks = read_entries(&mut f, block_off, macro_off, (first, last))?;
    let macroblocks = read_entries(&mut f, macro_off, len - FOOTER_LEN, (first / mi, last.div_ceil(mi)))?;
    if blocks.iter().chain(macroblocks.iter()).any(|e| e.1 < HEADER_LEN || e.1 >= block_off) {
        return Err("index entry points outside the frames".into());
    }
    Ok(SegmentIndex { blocks, macroblocks })
}

/// One index occupying exactly [start, end): ascending keys inside `range`.
fn read_entries(f: &mut std::fs::File, start: u64, end: u64, range: (u64, u64)) -> Result<IndexEntries, String> {
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut count = [0u8; 4];
    f.read_exact(&mut count).map_err(|e| format!("index count: {}", e))?;
    let count = u32::from_le_bytes(count) as u64;
    if start + 4 + count * INDEX_ENTRY_LEN != end { return Err("index length does not match its span".into()); }
    if count > range.1.saturating_sub(range.0) + 1 { return Err(format!("index count {} exceeds the range", count)); }
    let mut raw = vec![0u8; (count * INDEX_ENTRY_LEN) as usize];
    f.read_exact(&mut raw).map_err(|e| format!("index: {}", e))?;
    let mut out: IndexEntries = Vec::with_capacity(count as usize);
    for e in raw.chunks_exact(INDEX_ENTRY_LEN as usize) {
        let key = u64_at(e, 0);
        if key < range.0 || key > range.1 || out.last().map_or(false, |p| key <= p.0) {
            return Err(format!("index key {} out of order or range", key));
        }
        out.push((key, u64_at(e, 8), u32::from_le_bytes(e[16..20].try_into().unwrap_or([0u8; 4]))));
    }
    Ok(out)
}

/// One decoded frame: its compressed bytes must lie inside the file.
fn read_frame(path: &Path, offset: u64) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut zlen = [0u8; 4];
    f.read_exact(&mut zlen).map_err(|e| format!("frame length: {}", e))?;
    let zlen = u32::from_le_bytes(zlen) as u64;
    if offset + 4 + zlen > len.saturating_sub(FOOTER_LEN) { return Err("frame past the file".into()); }
    let mut z = vec![0u8; zlen as usize];
    f.read_exact(&mut z).map_err(|e| format!("frame: {}", e))?;
    zstd::stream::decode_all(&z[..]).map_err(|e| format!("frame decode: {}", e))
}

fn read_record<T: serde::de::DeserializeOwned>(frame: &[u8], offset: u32) -> Result<T, String> {
    let o = offset as usize;
    let len = frame.get(o..o + 4).ok_or("record past the frame")?;
    let len = u32::from_le_bytes(len.try_into().unwrap_or([0u8; 4])) as usize;
    let raw = frame.get(o + 4..o + 4 + len).ok_or("record past the frame")?;
    bincode::deserialize(raw).map_err(|e| format!("record decode: {}", e))
}

/// Inclusive ranges over ascending heights.
fn height_ranges(sorted: &[u64]) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    for &h in sorted {
        match out.last_mut() {
            Some(last) if h == last.1 + 1 => last.1 = h,
            _ => out.push((h, h)),
        }
    }
    out
}

/// What filling a segment found besides its blocks.
struct Filled {
    missing: Vec<(u64, u64)>,
    macroblocks_unsigned: u64,
}

impl Storage {
    /// Attach the archive at `dir`. Called once, from `Storage::new` when QNET_ARCHIVE=1.
    pub fn open_history_archive(&self, dir: PathBuf) -> IntegrationResult<()> {
        let arch = HistoryArchive::open(dir.clone())?;
        if crate::node::is_info() {
            println!("[INFO][HISTORY] enabled dir={} segments={} next_epoch={:?}", dir.display(), arch.metas.read().len(), arch.next_epoch());
        }
        let _ = self.history_archive.set(Arc::new(arch));
        Ok(())
    }

    pub fn history_archive(&self) -> Option<&Arc<HistoryArchive>> {
        self.history_archive.get()
    }

    /// The archived block at `height`, for RPC reads once the body has left the retention window.
    pub fn archived_block(&self, height: u64) -> Option<qnet_state::MicroBlock> {
        self.history_archive.get()?.block(height)
    }

    /// The archived macroblock `index` with its signers' keys, for proofs once the node stripped its signatures.
    pub fn archived_macroblock(&self, index: u64) -> Option<ArchivedMacroblock> {
        self.history_archive.get()?.macroblock(index)
    }

    /// The header of an archived block, for header pages past the retention window.
    pub fn archived_header(&self, height: u64) -> Option<super::chain_reads::MicroBlockHeader> {
        self.archived_block(height).map(|b| super::chain_reads::MicroBlockHeader {
            height: b.height, timestamp: b.timestamp, previous_hash: b.previous_hash,
            merkle_root: b.merkle_root, tx_count: b.transactions.len(), producer: b.producer,
        })
    }

    /// Where a fresh archive starts: the first epoch whose every body is still on disk. Block 0 is
    /// never pruned, so the probe starts at 1; a chain still holding block 1 starts at epoch 0.
    fn archive_start_epoch(&self) -> Option<u64> {
        let lowest = self.persistent.lowest_stored_microblock_from(1).ok().flatten()?;
        Some(if lowest <= 1 { 0 } else { lowest.div_ceil(SEGMENT_BLOCKS) })
    }

    /// Height below which body and transaction pruning may run while the archive still owes epochs.
    /// None = no archive, or it has fallen further behind than ARCHIVE_HOLD_MAX_BLOCKS.
    pub fn archive_hold_floor(&self, tip: u64) -> Option<u64> {
        let arch = self.history_archive.get()?;
        let floor = arch.next_epoch().or_else(|| self.archive_start_epoch())?.saturating_mul(SEGMENT_BLOCKS);
        if tip.saturating_sub(floor) > ARCHIVE_HOLD_MAX_BLOCKS {
            println!("[ERR][HISTORY] hold_released floor={} tip={} max={} action=prune_resumes", floor, tip, ARCHIVE_HOLD_MAX_BLOCKS);
            return None;
        }
        Some(floor)
    }

    /// Write every epoch not yet archived whose blocks and certifying macroblocks are final at `finalized`
    /// (the window covering the epoch's last block ends one height past it), at most `max_epochs` per
    /// call. Stops at the first epoch it cannot write; the hold keeps its bodies.
    pub fn archive_finalized_epochs(&self, finalized: u64, max_epochs: u64) -> u64 {
        let arch = match self.history_archive.get() { Some(a) => a.clone(), None => return 0 };
        let _w = arch.writer.lock();
        let mut next = match arch.next_epoch().or_else(|| self.archive_start_epoch()) { Some(e) => e, None => return 0 };
        let mut written = 0;
        while written < max_epochs {
            let first = next * SEGMENT_BLOCKS;
            let last = first + SEGMENT_BLOCKS - 1;
            if last + 1 > finalized { break; }
            let started = std::time::Instant::now();
            match self.write_segment(&arch, next, first, last) {
                Ok(m) => if crate::node::is_info() {
                    println!("[INFO][HISTORY] segment_written epoch={} heights={}..{} blocks={} missing_ranges={} macroblocks={} unsigned={} bytes={} ms={}",
                             m.epoch, m.first_height, m.last_height, m.blocks, m.missing.len(), m.macroblocks,
                             m.macroblocks_unsigned, m.bytes, started.elapsed().as_millis());
                },
                Err(e) => { println!("[ERR][HISTORY] segment_refused epoch={} err={}", next, e); break; }
            }
            next += 1;
            written += 1;
        }
        written
    }

    /// Stream the finalized blocks of [first, last] and their macroblocks into a segment and commit it.
    /// Any block that is not the certified one refuses the whole segment, and the partial file is removed.
    fn write_segment(&self, arch: &HistoryArchive, epoch: u64, first: u64, last: u64) -> Result<SegmentMeta, String> {
        let tmp = arch.segment_path(epoch).with_extension("qarc.tmp");
        let mut writer = SegmentWriter::create(&tmp, epoch, first, last).map_err(|e| format!("create: {}", e))?;
        let filled = self.fill_segment(&mut writer, first, last);
        let finished = filled.and_then(|f| writer.finish().map(|w| (f, w)).map_err(|e| format!("finish: {}", e)));
        let (filled, (bytes, sha3, blocks, macroblocks)) = match finished {
            Ok(v) => v,
            Err(e) => { let _ = std::fs::remove_file(&tmp); return Err(e); }
        };
        let meta = SegmentMeta {
            epoch, first_height: first, last_height: last, blocks, missing: filled.missing,
            macroblocks, macroblocks_unsigned: filled.macroblocks_unsigned, bytes, sha3,
        };
        if let Err(e) = arch.commit(epoch, &tmp, &meta) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(meta)
    }

    /// Verify, strip and write each committed block of [first, last], then every stored macroblock whose
    /// window covers one of those heights, with the public keys of its certificate's signers.
    fn fill_segment(&self, writer: &mut SegmentWriter, first: u64, last: u64) -> Result<Filled, String> {
        let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        let mut missing = Vec::new();
        let mut window: Option<(u64, Option<Vec<[u8; 32]>>)> = None;
        for h in first..=last {
            let Some(expected) = self.canonical_hash_at(h) else { continue };
            let mut mb = match self.load_microblock_auto_format(h) {
                Ok(Some(mb)) => mb,
                Ok(None) => { missing.push(h); continue; }
                Err(e) => return Err(format!("h={} unreadable: {}", h, e)),
            };
            if mb.hash() != expected { return Err(format!("h={} body does not hash to the committed slot", h)); }
            // Block 0 is anchored by the genesis hash vote; every later block by its transactions too.
            if h > 0 && !Self::block_content_bound(&mb) { return Err(format!("h={} transactions do not rebuild the merkle root", h)); }
            if h > 0 {
                let idx = (h + mi - 1) / mi;
                if window.as_ref().map(|w| w.0) != Some(idx) {
                    let certified = self.plain_macroblock(idx).map(|(m, _)| m.micro_blocks);
                    window = Some((idx, certified));
                }
                if let Some((_, Some(list))) = &window {
                    if list.get((h - ((idx - 1) * mi + 1)) as usize) != Some(&expected) {
                        return Err(format!("h={} is not the block macroblock {} certified", h, idx));
                    }
                }
            }
            mb.signature = Vec::new();
            mb.vrf_proof = None;
            mb.timeout_proof = None;
            writer.put_block(&mb)?;
        }

        let mut macroblocks_unsigned = 0;
        for idx in ((first + mi - 1) / mi).max(1)..=((last + mi - 1) / mi) {
            let Some((mb, raw)) = self.plain_macroblock(idx) else { continue };
            let signers = mb.consensus_data.checkpoint_qc.as_ref()
                .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok())
                .map(|(_, qc)| if qc.sigs.is_empty() { Vec::new() } else { qc.signers })
                .unwrap_or_default();
            if signers.is_empty() { macroblocks_unsigned += 1; }
            let keys: Vec<(String, Vec<u8>)> = signers.into_iter()
                .filter_map(|s| self.load_vrf_public_key(&s).ok().flatten().map(|pk| (s, pk)))
                .collect();
            writer.put_macroblock(idx, &(raw, keys))?;
        }
        Ok(Filled { missing: height_ranges(&missing), macroblocks_unsigned })
    }

    /// A stored macroblock decoded, with its plaintext bincode bytes.
    fn plain_macroblock(&self, idx: u64) -> Option<(qnet_state::MacroBlock, Vec<u8>)> {
        let raw = self.get_macroblock_by_height(idx).ok().flatten()
            .and_then(crate::node::BlockchainNode::macroblock_plaintext)?;
        let mb = bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok()?;
        Some((mb, raw))
    }

    /// Rollback hook: segments reaching above `target` describe abandoned chain.
    pub fn retract_archive_above(&self, target: u64) {
        if let Some(arch) = self.history_archive.get() {
            let n = arch.retract_above(target);
            if n > 0 && crate::node::is_warn() { println!("[WARN][HISTORY] segments_retracted count={} above={}", n, target); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(storage: &Storage, to: u64) -> Vec<[u8; 32]> {
        let mut parent = [0u8; 32];
        let mut hashes = Vec::new();
        for h in 0..=to {
            let mut mb = qnet_state::MicroBlock::new(h, 1_000 + h, parent, vec![], "genesis_node_001".to_string());
            mb.merkle_root = crate::node::BlockchainNode::calculate_merkle_root(&mb.transactions);
            mb.signature = vec![7u8; 64];
            mb.vrf_proof = Some(vec![9u8; 64]);
            parent = mb.hash();
            hashes.push(parent);
            storage.save_microblock(h, &bincode::serialize(&mb).expect("ser")).expect("save");
        }
        hashes
    }

    fn archived(dir: &tempfile::TempDir) -> Storage {
        let st = Storage::new(dir.path().join("db").to_str().unwrap()).expect("storage");
        st.open_history_archive(dir.path().join("archive")).expect("archive");
        st
    }

    /// A macroblock certifying window `idx` of `hashes`, signed by one registered signer.
    async fn certify(st: &Storage, hashes: &[[u8; 32]], idx: u64, signer: &str) {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate};
        let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL as usize;
        let window: Vec<[u8; 32]> = hashes[(idx as usize - 1) * mi + 1..=idx as usize * mi].to_vec();
        let cp = Checkpoint {
            index: idx, parent_qc: None, window_head_height: idx * mi as u64, window_mb_hashes: window.clone(),
            state_root: [0u8; 32], beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: 1000, proposer: signer.to_string(), proposer_sig: Vec::new(), recovery_anchor: None,
        };
        let qc = QuorumCertificate {
            checkpoint_hash: cp.hash(), index: idx, signers: vec![signer.to_string()],
            sig_merkle_root: [0u8; 32], sigs: vec![b"sig".to_vec()],
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp, qc)).expect("qc"));
        st.save_macroblock(idx, &qnet_state::MacroBlock::new(idx, 0, [0u8; 32], window, [0u8; 32], cd)).await.expect("mb");
    }

    // A finalized epoch round-trips: same block hashes, proofs stripped, reopened from disk.
    #[test]
    fn a_finalized_epoch_is_written_once_and_read_back_without_proofs() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = archived(&dir);
        let hashes = chain(&st, SEGMENT_BLOCKS + 10);
        assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS - 1, EPOCHS_PER_RUN), 0, "the window over the last block is not final yet");
        assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS + 10, EPOCHS_PER_RUN), 1);
        assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS + 10, EPOCHS_PER_RUN), 0, "written once");
        let arch = st.history_archive().expect("archive");
        let meta = arch.segments(0, 10).pop().expect("meta");
        assert_eq!((meta.first_height, meta.last_height, meta.blocks), (0, SEGMENT_BLOCKS - 1, SEGMENT_BLOCKS));
        assert!(meta.missing.is_empty());
        let file = std::fs::read(arch.segment_file(0).expect("file").0).expect("read");
        assert_eq!(meta.bytes, file.len() as u64);
        assert_eq!(meta.sha3, hex::encode(sha3::Sha3_256::digest(&file)));
        for h in [0, 1, 777, SEGMENT_BLOCKS - 1] {
            let b = st.archived_block(h).expect("archived");
            assert_eq!(b.hash(), hashes[h as usize]);
            assert!(b.signature.is_empty() && b.vrf_proof.is_none());
        }
        assert!(st.archived_block(SEGMENT_BLOCKS).is_none());
        let reopened = HistoryArchive::open(dir.path().join("archive")).expect("reopen");
        assert_eq!(reopened.next_epoch(), Some(1));
        assert_eq!(reopened.block(4321).map(|b| b.hash()), Some(hashes[4321]));
    }

    // The segment carries the certificates of its windows with the signers' keys, so it proves itself;
    // the window on the boundary is found in the segment that ends with it.
    #[tokio::test]
    async fn a_segment_carries_the_certificates_of_its_windows() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = archived(&dir);
        let hashes = chain(&st, SEGMENT_BLOCKS + 90);
        st.save_vrf_public_key("signer_a", &hex::encode([5u8; 64])).expect("pk");
        for idx in [1u64, 2, 160] { certify(&st, &hashes, idx, "signer_a").await; }
        assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS + 90, EPOCHS_PER_RUN), 1);
        let meta = st.history_archive().expect("archive").segments(0, 1).pop().expect("meta");
        assert_eq!((meta.macroblocks, meta.macroblocks_unsigned), (3, 0));
        let (mb, keys) = st.archived_macroblock(160).expect("boundary window");
        assert_eq!(mb.micro_blocks.last(), Some(&hashes[SEGMENT_BLOCKS as usize]));
        assert_eq!(keys, vec![("signer_a".to_string(), vec![5u8; 64])]);
        assert!(st.archived_macroblock(3).is_none(), "a window never certified is not invented");
    }

    // Memory stays bounded by a frame: a busy epoch is written in many frames, and any block is read
    // back from its own frame through the index.
    #[test]
    fn a_segment_is_framed_and_indexed_for_one_block_reads() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().join("seg.qarc");
        let mut w = SegmentWriter::create(&path, 3, 3 * SEGMENT_BLOCKS, 4 * SEGMENT_BLOCKS - 1).expect("create");
        let mut blocks = Vec::new();
        for i in 0..40u64 {
            let mut mb = qnet_state::MicroBlock::new(3 * SEGMENT_BLOCKS + i * 7, 1, [i as u8; 32], vec![], "p".to_string());
            mb.signature = vec![(i % 251) as u8; 100_000];   // ~100 KB a block: a frame every ~10 blocks
            w.put_block(&mb).expect("put");
            blocks.push(mb);
        }
        let (bytes, _, count, macroblocks) = w.finish().expect("finish");
        assert_eq!((count, macroblocks, bytes), (40, 0, std::fs::metadata(&path).expect("meta").len()));
        let index = read_index(&path).expect("index");
        let frames: std::collections::BTreeSet<u64> = index.blocks.iter().map(|e| e.1).collect();
        assert!(frames.len() >= 4, "many frames, got {}", frames.len());
        for (i, b) in blocks.iter().enumerate() {
            let (h, fo, ro) = index.blocks[i];
            assert_eq!(h, b.height);
            let back: qnet_state::MicroBlock = read_record(&read_frame(&path, fo).expect("frame"), ro).expect("record");
            assert_eq!(&back, b);
        }
        let mut damaged = std::fs::read(&path).expect("read");
        let n = damaged.len();
        damaged[n - 1] ^= 0xFF;
        std::fs::write(&path, &damaged).expect("write");
        assert!(read_index(&path).is_err(), "a damaged footer is refused");
    }

    // A body that is not the committed block refuses the segment; nothing is written.
    #[test]
    fn a_block_off_the_committed_chain_refuses_the_segment() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = archived(&dir);
        chain(&st, SEGMENT_BLOCKS);
        let meta = st.persistent.db.cf_handle("metadata").expect("metadata cf");
        st.persistent.db.put_cf(&meta, crate::storage::mb_hash_key(500).as_bytes(), [0xEEu8; 32]).expect("hash row");
        assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS, EPOCHS_PER_RUN), 0);
        let arch = st.history_archive().expect("archive");
        assert_eq!(arch.next_epoch(), None);
        assert!(!arch.segment_path(0).exists() && !arch.segment_path(0).with_extension("qarc.tmp").exists(), "no partial file left");
    }

    // The certified window list is the authority: a stored block it does not name is not archived.
    #[tokio::test]
    async fn a_block_the_certified_window_does_not_name_refuses_the_segment() {
        // A macroblock object is written once, so each window gets its own store.
        for forged in [true, false] {
            let dir = tempfile::TempDir::new().expect("tempdir");
            let st = archived(&dir);
            let hashes = chain(&st, SEGMENT_BLOCKS);
            let mut window: Vec<[u8; 32]> = hashes[1..=90].to_vec();
            if forged { window[4] = [0xABu8; 32]; }
            let mb = qnet_state::MacroBlock::new(1, 0, [0u8; 32], window, [0u8; 32], qnet_state::ConsensusData::default());
            st.save_macroblock(1, &mb).await.expect("mb1");
            let expected = if forged { 0 } else { 1 };
            assert_eq!(st.archive_finalized_epochs(SEGMENT_BLOCKS, EPOCHS_PER_RUN), expected, "forged window = {}", forged);
        }
    }

    // Pruning waits for the archive, but never longer than the hold allows.
    #[test]
    fn the_hold_floor_follows_the_archive_and_releases_past_the_cap() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = archived(&dir);
        chain(&st, SEGMENT_BLOCKS + 5);
        assert_eq!(st.archive_hold_floor(SEGMENT_BLOCKS + 5), Some(0));
        st.archive_finalized_epochs(SEGMENT_BLOCKS + 5, EPOCHS_PER_RUN);
        assert_eq!(st.archive_hold_floor(SEGMENT_BLOCKS + 5), Some(SEGMENT_BLOCKS));
        assert_eq!(st.archive_hold_floor(SEGMENT_BLOCKS + ARCHIVE_HOLD_MAX_BLOCKS + 1), None);
        let plain_dir = tempfile::TempDir::new().expect("tempdir");
        let plain = Storage::new(plain_dir.path().to_str().unwrap()).expect("storage");
        assert_eq!(plain.archive_hold_floor(10_000_000), None, "no archive, no hold");
    }

    // A rollback below an archived epoch removes it, on disk too.
    #[test]
    fn a_rollback_retracts_segments_above_the_target() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = archived(&dir);
        chain(&st, 2 * SEGMENT_BLOCKS + 1);
        assert_eq!(st.archive_finalized_epochs(2 * SEGMENT_BLOCKS + 1, EPOCHS_PER_RUN), 2);
        assert!(st.archived_block(SEGMENT_BLOCKS + 5).is_some());
        st.retract_archive_above(SEGMENT_BLOCKS + 100);
        let arch = st.history_archive().expect("archive");
        assert_eq!(arch.next_epoch(), Some(1));
        assert!(arch.segment_file(1).is_none());
        assert!(st.archived_block(SEGMENT_BLOCKS + 5).is_none(), "no cached index or frame outlives its segment");
        assert_eq!(HistoryArchive::open(dir.path().join("archive")).expect("reopen").next_epoch(), Some(1));
    }

    // A segment whose meta never landed is an interrupted write, not history.
    #[test]
    fn open_drops_a_segment_without_its_meta() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let adir = dir.path().join("archive");
        std::fs::create_dir_all(&adir).expect("dir");
        std::fs::write(adir.join("seg_00000003.qarc"), b"partial").expect("seg");
        std::fs::write(adir.join("seg_00000004.qarc.tmp"), b"tmp").expect("tmp");
        let arch = HistoryArchive::open(adir.clone()).expect("open");
        assert_eq!(arch.next_epoch(), None);
        assert!(!adir.join("seg_00000003.qarc").exists() && !adir.join("seg_00000004.qarc.tmp").exists());
    }
}

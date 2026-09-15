//! Boundary snapshots off the apply path. The applying code takes an O(1) pin of the reward and registry rows
//! it wrote and queues a pin of the accounts behind the boundary block's rows on the mirror thread; the frame is
//! encoded and written from those two frozen views on one background thread, so the next block never waits.

use super::*;
use std::sync::mpsc::{sync_channel, SyncSender};

/// Heights that carry a boundary snapshot: the early anchor and every incremental interval.
pub fn is_snapshot_boundary(height: u64) -> bool {
    height > 0
        && (height == crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT
            || height % crate::node::SNAPSHOT_INCREMENTAL_INTERVAL == 0)
}

/// A frozen boundary view on its way to the frame writer.
struct BoundaryCapture {
    storage: Arc<Storage>,
    height: u64,
    views: FrameViews,
    expected_leaves: Option<u64>,
    /// Snapshot generation and block hash at request time: a rollback in between drops the frame.
    fence: (u64, [u8; 32]),
    rt: Option<tokio::runtime::Handle>,
}

/// A boundary frame's two views, each the state at the height for what it serves: the mirror's pin (accounts
/// and contract slots, queued behind the block's rows) and the pin taken under the lock that applied the block
/// (reward and registry rows, which the apply writes directly).
pub struct FrameViews {
    pub accounts: PinnedDbSnapshot,
    pub side: PinnedDbSnapshot,
}

/// One frame is written at a time, with one more waiting; boundaries are an hour apart.
static FRAME_WRITER: std::sync::OnceLock<Option<SyncSender<BoundaryCapture>>> = std::sync::OnceLock::new();

fn submit(cap: BoundaryCapture) {
    let writer = FRAME_WRITER.get_or_init(|| {
        let (tx, rx) = sync_channel::<BoundaryCapture>(1);
        match std::thread::Builder::new()
            .name("qnet-boundary-snap".to_string())
            .spawn(move || {
                // A job that panics is logged and the next one runs (dev and test builds; release aborts).
                for cap in rx {
                    let h = cap.height;
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| write_capture(cap))).is_err() {
                        eprintln!("[ERR][STORAGE] boundary_writer_job_panicked h={} action=next_job", h);
                    }
                }
            })
        {
            Ok(_) => Some(tx),
            Err(e) => {
                eprintln!("[ERR][STORAGE] boundary_writer_spawn_failed err={}", e);
                None
            }
        }
    });
    let height = cap.height;
    match writer.as_ref().map(|tx| tx.try_send(cap)) {
        Some(Ok(())) => {}
        Some(Err(std::sync::mpsc::TrySendError::Full(_))) =>
            println!("[WARN][STORAGE] boundary_snapshot_dropped h={} reason=writer_busy", height),
        _ => eprintln!("[ERR][STORAGE] boundary_snapshot_dropped h={} reason=writer_down", height),
    }
}

fn write_capture(cap: BoundaryCapture) {
    let BoundaryCapture { storage, height, views, expected_leaves, fence, rt } = cap;
    if let Err(e) = storage.write_boundary_frame(height, views, expected_leaves, Some(fence)) {
        println!("[WARN][STORAGE] snapshot_create_failed h={} err={:?}", height, e);
        return;
    }
    // Every 12 h the written frame also goes to IPFS where the operator enabled it.
    let ipfs = std::env::var("IPFS_ENABLED").map(|v| v == "1").unwrap_or(false);
    let written = matches!(storage.get_highest_snapshot_height_le(height), Ok(Some(h)) if h == height);
    if ipfs && written && height % crate::node::SNAPSHOT_FULL_INTERVAL == 0 {
        if let Some(rt) = rt {
            rt.spawn(async move {
                match storage.upload_snapshot_to_ipfs(height).await {
                    Ok(cid) => println!("[INFO][NODE] ipfs_upload h={} cid={}", height, cid),
                    Err(e) => println!("[WARN][NODE] ipfs_upload_failed h={} err={}", height, e),
                }
            });
        }
    }
}

impl Storage {
    /// Queue the boundary snapshot at `height` behind the block's rows. The caller holds the state lock that
    /// applied the block, so the pin sees exactly the state at `height`; nothing heavy runs here.
    pub fn request_boundary_pin(self: &Arc<Self>, sg: &crate::StateManager, height: u64) {
        let hash = match self.load_microblock_hash(height) {
            Ok(Some(h)) => h,
            _ => {
                println!("[WARN][STORAGE] boundary_pin_skipped h={} reason=block_hash_unavailable", height);
                return;
            }
        };
        // Strict count gate only while the RAM leaf set is the complete authority.
        let expected_leaves = if sg.merkle_leaves_complete() { Some(sg.merkle_leaf_count() as u64) } else { None };
        // A failed write left rows behind; the heal rewrites them off the apply path. No frame this boundary.
        if self.mirror_stale() {
            println!("[WARN][STORAGE] boundary_pin_skipped h={} reason=mirror_stale", height);
            return;
        }
        // Reward and registry rows as of this block: the caller still holds the lock that applied it.
        let side = PinnedDbSnapshot::of(&self.persistent.db);
        let fence = (self.snapshot_generation(), hash);
        let storage = Arc::clone(self);
        let rt = tokio::runtime::Handle::try_current().ok();
        self.mirror_pin(height, Box::new(move |accounts| {
            submit(BoundaryCapture { storage, height, views: FrameViews { accounts, side }, expected_leaves, fence, rt })
        }));
    }

    /// Body expiry at every 14,400 boundary: microblock bodies older than the retention window go (Super only,
    /// watermark-based, so one boundary reclaims the whole backlog). Hashes, macroblocks, snapshots and state stay.
    pub fn prune_bodies_at_epoch(self: &Arc<Self>, height: u64) {
        if height == 0 || height % 14_400 != 0 {
            return;
        }
        let storage = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            match storage.prune_old_microblock_bodies(height, crate::node::MICROBLOCK_BODY_RETENTION_BLOCKS) {
                Ok(0) => {}
                Ok(n) => println!("[INFO][STORAGE] microblock_bodies_pruned count={} h={}", n, height),
                Err(e) => println!("[WARN][STORAGE] body_prune_failed h={} err={:?}", height, e),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_are_the_early_anchor_and_every_interval() {
        assert!(!is_snapshot_boundary(0));
        assert!(is_snapshot_boundary(crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT));
        assert!(is_snapshot_boundary(crate::node::SNAPSHOT_INCREMENTAL_INTERVAL * 3));
        assert!(!is_snapshot_boundary(180));
        assert!(!is_snapshot_boundary(crate::node::SNAPSHOT_INCREMENTAL_INTERVAL + 90));
    }

    // The frame written for a boundary is the state at that block even with the next block's rows queued
    // right behind the pin; the caller only queues.
    #[test]
    fn a_boundary_frame_is_the_state_at_its_block() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Arc::new(Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let meta = st.persistent.db.cf_handle("metadata").expect("metadata cf");
        st.persistent.db.put_cf(&meta, crate::storage::mb_hash_key(90).as_bytes(), [7u8; 32]).expect("hash row");
        let mut a = qnet_state::Account::new("w".to_string());
        a.balance = 1;
        let sg = crate::StateManager::new();
        sg.restore_accounts(vec![("w".to_string(), a.clone())]).expect("restore");
        st.mirror_block_delta(90, vec![("w".to_string(), a.clone())], Vec::new());
        st.request_boundary_pin(&sg, 90);
        a.balance = 2;
        st.mirror_block_delta(91, vec![("w".to_string(), a)], Vec::new());

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let frame = loop {
            if let Some(f) = st.get_snapshot_data(90).expect("read") { break f; }
            assert!(std::time::Instant::now() < deadline, "the frame was not written");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        // [sha3(32) | len(8) | zstd([0x02 | version(4) | height(8) | timestamp(8) | key_len | key | value_len | value ..])]
        let body = zstd::decode_all(&frame[40..]).expect("zstd");
        let mut at = 1 + 4 + 8 + 8;
        let klen = u32::from_le_bytes(body[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        assert_eq!(&body[at..at + klen], b"w");
        at += klen;
        let vlen = u32::from_le_bytes(body[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        let pinned: qnet_state::Account = bincode::deserialize(&body[at..at + vlen]).expect("account");
        assert_eq!(pinned.balance, 1, "the frame is the state at 90, not 91");
        st.mirror_barrier();
        assert_eq!(st.load_account("w").expect("load").map(|x| x.balance), Some(2), "the live row moved on");
    }

    // A registry row the next block writes is not in the boundary's frame: that pin is taken under the lock
    // that applied the boundary block, before anything later can write.
    #[test]
    fn a_boundary_frame_holds_the_registry_rows_of_its_block_only() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Arc::new(Storage::new(dir.path().to_str().unwrap()).expect("storage"));
        let meta = st.persistent.db.cf_handle("metadata").expect("metadata cf");
        st.persistent.db.put_cf(&meta, crate::storage::mb_hash_key(90).as_bytes(), [7u8; 32]).expect("hash row");
        let cf = st.registry_cf_for_test();
        st.put_registry_row_for_test(&cf, b"node_at_90", br#"{"node_type":"super","wallet":"w90","reg_height":90}"#);
        st.request_boundary_pin(&crate::StateManager::new(), 90);
        st.put_registry_row_for_test(&cf, b"node_at_91", br#"{"node_type":"super","wallet":"w91","reg_height":91}"#);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let frame = loop {
            if let Some(f) = st.get_snapshot_data(90).expect("read") { break f; }
            assert!(std::time::Instant::now() < deadline, "the frame was not written");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let body = zstd::decode_all(&frame[40..]).expect("zstd");
        let has = |needle: &[u8]| body.windows(needle.len()).any(|w| w == needle);
        assert!(has(b"node_at_90"), "the boundary block's row is in its frame");
        assert!(!has(b"node_at_91"), "a later block's row is not");
    }
}

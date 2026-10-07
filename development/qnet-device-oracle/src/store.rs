//! The oracle's database: RocksDB column families plus a replication log. Every commit is one atomic,
//! fsynced write batch together with its log entry, so the standby replays exactly the primary's order.

use parking_lot::Mutex;
use rocksdb::{ColumnFamilyDescriptor, IteratorMode, Options, WriteBatch, WriteOptions, DB};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Data column families. Bincode encodes this enum by position inside log entries: append, never reorder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Cf {
    /// node id → `NodeLease`
    Lease,
    /// hex(sha3(hw_pub)) → `KeyOwner`
    Key,
    /// hex(sha3(hw_pub)) → `StoredReceipt`
    Receipt,
    /// hex(sha3(hw_pub)) → time the oracle set the Android hold for that install
    Hold,
    /// `ref:node` → `Ticket`
    Ticket,
    /// sha256(token) → expiry, and expiry ‖ sha256(token) → () for the purge
    Replay,
    ReplayExp,
    /// `n:node` / `k:hw_key` / `a:att_key` → limit windows
    Limit,
    /// evidence key → `EvRecord`, and expiry ‖ evidence key → () for the purge
    Ev,
    EvExp,
}

impl Cf {
    pub const ALL: [Cf; 10] =
        [Cf::Lease, Cf::Key, Cf::Receipt, Cf::Hold, Cf::Ticket, Cf::Replay, Cf::ReplayExp, Cf::Limit, Cf::Ev, Cf::EvExp];

    pub fn name(self) -> &'static str {
        match self {
            Cf::Lease => "lease",
            Cf::Key => "key",
            Cf::Receipt => "receipt",
            Cf::Hold => "hold",
            Cf::Ticket => "ticket",
            Cf::Replay => "replay",
            Cf::ReplayExp => "replay_exp",
            Cf::Limit => "limit",
            Cf::Ev => "ev",
            Cf::EvExp => "ev_exp",
        }
    }

    pub fn parse(s: &str) -> Option<Cf> {
        Cf::ALL.iter().copied().find(|c| c.name() == s)
    }
}

const LOG: &str = "log";
const META: &str = "meta";
/// Log entries one trim call deletes at most.
pub const TRIM_PAGE: usize = 10_000;
const META_SEQ: &[u8] = b"seq";
const META_SYNCED: &[u8] = b"synced";
/// Set while a standby's full sync runs: from before its wipe until its last page is in.
const META_SYNCING: &[u8] = b"syncing";
const META_SCHEMA: &[u8] = b"schema";

/// Layout of the stored records. Bincode is positional, so any change to a stored type raises this
/// together with a migration; a database of another layout is refused at open and by a standby's sync.
pub const SCHEMA: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WriteOp {
    Put(Cf, Vec<u8>, Vec<u8>),
    Del(Cf, Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub seq: u64,
    pub ts: u64,
    pub ops: Vec<WriteOp>,
}

#[derive(Default)]
pub struct Batch {
    ops: Vec<WriteOp>,
}

impl Batch {
    pub fn put<T: Serialize>(&mut self, cf: Cf, key: impl AsRef<[u8]>, v: &T) {
        let bytes = bincode::serialize(v).expect("records serialize");
        self.ops.push(WriteOp::Put(cf, key.as_ref().to_vec(), bytes));
    }
    pub fn put_raw(&mut self, cf: Cf, key: impl AsRef<[u8]>, v: Vec<u8>) {
        self.ops.push(WriteOp::Put(cf, key.as_ref().to_vec(), v));
    }
    pub fn del(&mut self, cf: Cf, key: impl AsRef<[u8]>) {
        self.ops.push(WriteOp::Del(cf, key.as_ref().to_vec()));
    }
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

pub struct Store {
    db: DB,
    seq: Mutex<u64>,
}

fn be(n: u64) -> [u8; 8] {
    n.to_be_bytes()
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self, String> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        let mut names: Vec<&str> = Cf::ALL.iter().map(|c| c.name()).collect();
        names.push(LOG);
        names.push(META);
        let cfs = names.iter().map(|n| ColumnFamilyDescriptor::new(*n, Options::default()));
        let db = DB::open_cf_descriptors(&opts, dir, cfs).map_err(|e| format!("open database: {}", e))?;
        let seq = {
            let meta = db.cf_handle(META).ok_or("meta family missing")?;
            match db.get_cf(meta, META_SCHEMA).map_err(|e| e.to_string())? {
                Some(v) if v.len() == 4 => {
                    let found = u32::from_be_bytes(v[..4].try_into().unwrap());
                    if found != SCHEMA {
                        return Err(format!("database schema {} but this build reads schema {}: migrate it first", found, SCHEMA));
                    }
                }
                Some(_) => return Err("database schema marker is malformed".into()),
                None => {
                    let mut wo = WriteOptions::default();
                    wo.set_sync(true);
                    db.put_cf_opt(meta, META_SCHEMA, SCHEMA.to_be_bytes(), &wo).map_err(|e| format!("database write: {}", e))?;
                }
            }
            match db.get_cf(meta, META_SEQ).map_err(|e| e.to_string())? {
                Some(v) if v.len() == 8 => u64::from_be_bytes(v[..8].try_into().unwrap()),
                None => 0,
                Some(_) => return Err("database sequence marker is malformed".into()),
            }
        };
        Ok(Store { db, seq: Mutex::new(seq) })
    }

    fn cf(&self, name: &str) -> &rocksdb::ColumnFamily {
        self.db.cf_handle(name).expect("column family opened at start")
    }

    /// A record's bytes; `Ok(None)` only when it is absent. A read error is an error, never a missing
    /// record: every decision reads through here, and a missing pause, strike or owner opens the gate.
    pub fn get_raw(&self, cf: Cf, key: impl AsRef<[u8]>) -> Result<Option<Vec<u8>>, String> {
        self.db.get_cf(self.cf(cf.name()), key).map_err(|e| format!("read {}: {}", cf.name(), e))
    }

    /// A decoded record; one that does not decode is an error, like a failed read.
    pub fn get<T: DeserializeOwned>(&self, cf: Cf, key: impl AsRef<[u8]>) -> Result<Option<T>, String> {
        match self.get_raw(cf, key)? {
            None => Ok(None),
            Some(v) => bincode::deserialize(&v).map(Some).map_err(|e| format!("decode {}: {}", cf.name(), e)),
        }
    }

    pub fn seq(&self) -> u64 {
        *self.seq.lock()
    }

    fn write_ops(&self, wb: &mut WriteBatch, ops: &[WriteOp]) {
        for op in ops {
            match op {
                WriteOp::Put(cf, k, v) => wb.put_cf(self.cf(cf.name()), k, v),
                WriteOp::Del(cf, k) => wb.delete_cf(self.cf(cf.name()), k),
            }
        }
    }

    fn write(&self, wb: WriteBatch) -> Result<(), String> {
        let mut wo = WriteOptions::default();
        wo.set_sync(true);
        self.db.write_opt(wb, &wo).map_err(|e| format!("database write: {}", e))
    }

    /// Commits a batch atomically with its log entry; returns the entry's sequence number.
    pub fn commit(&self, b: Batch, now: u64) -> Result<u64, String> {
        if b.ops.is_empty() {
            return Ok(self.seq());
        }
        let mut seq = self.seq.lock();
        let next = *seq + 1;
        let entry = LogEntry { seq: next, ts: now, ops: b.ops };
        let mut wb = WriteBatch::default();
        self.write_ops(&mut wb, &entry.ops);
        wb.put_cf(self.cf(LOG), be(next), bincode::serialize(&entry).map_err(|e| e.to_string())?);
        wb.put_cf(self.cf(META), META_SEQ, be(next));
        self.write(wb)?;
        *seq = next;
        Ok(next)
    }

    /// Applies a primary's log entry on the standby, in order.
    pub fn apply_replica(&self, e: &LogEntry) -> Result<(), String> {
        let mut seq = self.seq.lock();
        if e.seq <= *seq {
            return Ok(());
        }
        if e.seq != *seq + 1 {
            return Err(format!("replication gap local={} entry={}", *seq, e.seq));
        }
        let mut wb = WriteBatch::default();
        self.write_ops(&mut wb, &e.ops);
        wb.put_cf(self.cf(LOG), be(e.seq), bincode::serialize(e).map_err(|x| x.to_string())?);
        wb.put_cf(self.cf(META), META_SEQ, be(e.seq));
        self.write(wb)?;
        *seq = e.seq;
        Ok(())
    }

    pub fn first_log_seq(&self) -> Option<u64> {
        let mut it = self.db.iterator_cf(self.cf(LOG), IteratorMode::Start);
        it.next().and_then(|r| r.ok()).map(|(k, _)| u64::from_be_bytes(k[..8].try_into().unwrap()))
    }

    /// Log entries after `after`; `Err` when the entries right after it were already trimmed.
    pub fn log_after(&self, after: u64, limit: usize) -> Result<Vec<LogEntry>, String> {
        if let Some(first) = self.first_log_seq() {
            if after + 1 < first {
                return Err("trimmed".into());
            }
        }
        let start = be(after + 1);
        let it = self.db.iterator_cf(self.cf(LOG), IteratorMode::From(&start, rocksdb::Direction::Forward));
        let mut out = Vec::new();
        for r in it.take(limit) {
            let (_, v) = r.map_err(|e| e.to_string())?;
            out.push(bincode::deserialize(&v).map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Drops up to one page of log entries older than `before_ts`, always keeping the newest one.
    pub fn trim_log(&self, before_ts: u64) -> usize {
        let last = self.seq();
        let mut wb = WriteBatch::default();
        let mut n = 0;
        for r in self.db.iterator_cf(self.cf(LOG), IteratorMode::Start) {
            let Ok((k, v)) = r else { break };
            let Ok(e) = bincode::deserialize::<LogEntry>(&v) else { break };
            if e.ts >= before_ts || e.seq >= last {
                break;
            }
            wb.delete_cf(self.cf(LOG), k);
            n += 1;
            if n >= TRIM_PAGE {
                break;
            }
        }
        if n > 0 {
            let _ = self.write(wb);
        }
        n
    }

    /// Up to `limit` entries of `cf` whose keys start with `prefix`, after `start_after` if given. A read
    /// error fails the scan rather than cutting it short: a short page reads as the end of the family.
    pub fn scan(
        &self,
        cf: Cf,
        prefix: &[u8],
        start_after: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
        let from = start_after.map(|k| k.to_vec()).unwrap_or_else(|| prefix.to_vec());
        let it = self.db.iterator_cf(self.cf(cf.name()), IteratorMode::From(&from, rocksdb::Direction::Forward));
        let mut out = Vec::new();
        for r in it {
            let (k, v) = r.map_err(|e| format!("scan {}: {}", cf.name(), e))?;
            if !k.starts_with(prefix) {
                break;
            }
            if start_after.map(|s| k.as_ref() == s).unwrap_or(false) {
                continue;
            }
            out.push((k.to_vec(), v.to_vec()));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// Keys of `cf` below `to`, in order, up to `limit` (for expiry indexes keyed by big-endian time).
    pub fn keys_below(&self, cf: Cf, to: &[u8], limit: usize) -> Result<Vec<Vec<u8>>, String> {
        let mut out = Vec::new();
        for r in self.db.iterator_cf(self.cf(cf.name()), IteratorMode::Start) {
            let (k, _) = r.map_err(|e| format!("scan {}: {}", cf.name(), e))?;
            if k.as_ref() >= to {
                break;
            }
            out.push(k.to_vec());
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    fn meta(&self, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        self.db.get_cf(self.cf(META), key).map_err(|e| format!("read meta: {}", e))
    }

    /// The database holds a complete copy: a primary's own, or a standby's finished full sync.
    pub fn synced(&self) -> Result<bool, String> {
        Ok(self.meta(META_SYNCED)?.is_some())
    }

    /// A standby's full sync wiped this database and has not finished.
    pub fn sync_in_progress(&self) -> Result<bool, String> {
        Ok(self.meta(META_SYNCING)?.is_some())
    }

    fn is_empty(&self) -> Result<bool, String> {
        if self.seq() != 0 {
            return Ok(false);
        }
        let mut names: Vec<&str> = Cf::ALL.iter().map(|c| c.name()).collect();
        names.push(LOG);
        for name in names {
            if let Some(r) = self.db.iterator_cf(self.cf(name), IteratorMode::Start).next() {
                r.map_err(|e| format!("scan {}: {}", name, e))?;
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Checks the database may serve as a primary, marking a new, empty one as the source of truth. A
    /// standby copy whose full sync never finished, or any database with records it never marked synced,
    /// is refused: serving from it would forget pauses, strikes, key owners, holds and replays.
    pub fn claim_primary(&self) -> Result<(), String> {
        if self.synced()? {
            return Ok(());
        }
        if self.sync_in_progress()? {
            return Err("this database is a standby copy whose full sync never finished: \
                        promote a synced standby or restore a backup"
                .into());
        }
        if !self.is_empty()? {
            return Err("this database holds records it never marked synced: refusing to serve from it".into());
        }
        self.mark_synced()
    }

    /// Standby full sync: marks the sync as running, then empties every data family and the log before
    /// copying the primary. A crash anywhere after the first write leaves the database unsynced.
    pub fn wipe(&self) -> Result<(), String> {
        let mut seq = self.seq.lock();
        let mut wb = WriteBatch::default();
        wb.delete_cf(self.cf(META), META_SYNCED);
        wb.put_cf(self.cf(META), META_SYNCING, b"1");
        self.write(wb)?;
        let mut names: Vec<&str> = Cf::ALL.iter().map(|c| c.name()).collect();
        names.push(LOG);
        for name in names {
            loop {
                let keys: Vec<Box<[u8]>> = self
                    .db
                    .iterator_cf(self.cf(name), IteratorMode::Start)
                    .take(10_000)
                    .map(|r| r.map(|(k, _)| k).map_err(|e| format!("scan {}: {}", name, e)))
                    .collect::<Result<_, _>>()?;
                if keys.is_empty() {
                    break;
                }
                let mut wb = WriteBatch::default();
                for k in keys {
                    wb.delete_cf(self.cf(name), k);
                }
                self.write(wb)?;
            }
        }
        let mut wb = WriteBatch::default();
        wb.put_cf(self.cf(META), META_SEQ, be(0));
        self.write(wb)?;
        *seq = 0;
        Ok(())
    }

    /// Writes one page of a full sync without logging it.
    pub fn put_snapshot_page(&self, cf: Cf, page: &[(Vec<u8>, Vec<u8>)]) -> Result<(), String> {
        let mut wb = WriteBatch::default();
        for (k, v) in page {
            wb.put_cf(self.cf(cf.name()), k, v);
        }
        self.write(wb)
    }

    /// Ends a full sync: the standby continues from the primary's log after `seq`.
    pub fn finish_sync(&self, seq: u64) -> Result<(), String> {
        let mut s = self.seq.lock();
        let mut wb = WriteBatch::default();
        wb.put_cf(self.cf(META), META_SEQ, be(seq));
        wb.put_cf(self.cf(META), META_SYNCED, b"1");
        wb.delete_cf(self.cf(META), META_SYNCING);
        self.write(wb)?;
        *s = seq;
        Ok(())
    }

    /// Marks a primary's own database as the source of truth (nothing to sync from).
    fn mark_synced(&self) -> Result<(), String> {
        let mut wb = WriteBatch::default();
        wb.put_cf(self.cf(META), META_SYNCED, b"1");
        self.write(wb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commits_are_logged_in_order_and_replay_on_a_standby() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let primary = Store::open(a.path()).unwrap();
        let standby = Store::open(b.path()).unwrap();
        let mut batch = Batch::default();
        batch.put(Cf::Lease, "n1", &42u32);
        batch.put(Cf::Key, "k1", &"n1".to_string());
        assert_eq!(primary.commit(batch, 100).unwrap(), 1);
        let mut batch = Batch::default();
        batch.del(Cf::Key, "k1");
        assert_eq!(primary.commit(batch, 200).unwrap(), 2);
        assert_eq!(primary.get::<u32>(Cf::Lease, "n1").unwrap(), Some(42));
        assert_eq!(primary.get::<String>(Cf::Key, "k1").unwrap(), None);

        let log = primary.log_after(0, 10).unwrap();
        assert_eq!(log.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert!(standby.apply_replica(&log[1]).is_err(), "a gap is refused");
        for e in &log {
            standby.apply_replica(e).unwrap();
        }
        standby.apply_replica(&log[0]).unwrap();
        assert_eq!(standby.seq(), 2);
        assert_eq!(standby.get::<u32>(Cf::Lease, "n1").unwrap(), Some(42));
        assert_eq!(standby.get::<String>(Cf::Key, "k1").unwrap(), None);
    }

    #[test]
    fn the_sequence_survives_a_restart_and_the_log_trims_by_time() {
        let d = tempfile::tempdir().unwrap();
        {
            let s = Store::open(d.path()).unwrap();
            for t in [10, 20, 30] {
                let mut b = Batch::default();
                b.put(Cf::Limit, format!("x{}", t), &t);
                s.commit(b, t).unwrap();
            }
            assert_eq!(s.trim_log(25), 2);
            assert_eq!(s.first_log_seq(), Some(3));
            assert!(s.log_after(0, 10).is_err(), "trimmed entries force a full sync");
            assert_eq!(s.log_after(2, 10).unwrap().len(), 1);
        }
        let s = Store::open(d.path()).unwrap();
        assert_eq!(s.seq(), 3);
    }

    #[test]
    fn scan_and_expiry_index() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        let mut b = Batch::default();
        for k in ["a:1", "a:2", "a:3", "b:1"] {
            b.put(Cf::Ticket, k, &1u8);
        }
        for t in [5u64, 15, 25] {
            b.put_raw(Cf::ReplayExp, be(t), vec![]);
        }
        s.commit(b, 1).unwrap();
        let all: Vec<Vec<u8>> = s.scan(Cf::Ticket, b"a:", None, 10).unwrap().into_iter().map(|(k, _)| k).collect();
        assert_eq!(all, vec![b"a:1".to_vec(), b"a:2".to_vec(), b"a:3".to_vec()]);
        let after: Vec<Vec<u8>> = s.scan(Cf::Ticket, b"a:", Some(b"a:1"), 10).unwrap().into_iter().map(|(k, _)| k).collect();
        assert_eq!(after.len(), 2);
        assert_eq!(s.keys_below(Cf::ReplayExp, &be(20), 10).unwrap().len(), 2);
    }

    #[test]
    fn wipe_then_snapshot_pages_then_log() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        let mut b = Batch::default();
        b.put(Cf::Lease, "old", &1u8);
        s.commit(b, 1).unwrap();
        s.wipe().unwrap();
        assert_eq!(s.get::<u8>(Cf::Lease, "old").unwrap(), None);
        assert_eq!(s.seq(), 0);
        s.put_snapshot_page(Cf::Lease, &[(b"n".to_vec(), bincode::serialize(&7u8).unwrap())]).unwrap();
        s.finish_sync(40).unwrap();
        assert!(s.synced().unwrap());
        assert_eq!(s.seq(), 40);
        let e = LogEntry { seq: 41, ts: 2, ops: vec![WriteOp::Del(Cf::Lease, b"n".to_vec())] };
        s.apply_replica(&e).unwrap();
        assert_eq!(s.get::<u8>(Cf::Lease, "n").unwrap(), None);
    }

    #[test]
    fn only_an_empty_or_synced_database_serves_as_a_primary() {
        // A new, empty database becomes the source of truth.
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.claim_primary().unwrap();
        assert!(s.synced().unwrap());
        let mut b = Batch::default();
        b.put(Cf::Lease, "n", &1u8);
        s.commit(b, 1).unwrap();
        s.claim_primary().unwrap();

        // A standby promoted in the middle of a full sync: wiped, part of the primary copied.
        let d = tempfile::tempdir().unwrap();
        let standby = Store::open(d.path()).unwrap();
        standby.put_snapshot_page(Cf::Lease, &[(b"n".to_vec(), bincode::serialize(&1u8).unwrap())]).unwrap();
        standby.finish_sync(10).unwrap();
        standby.wipe().unwrap();
        assert!(standby.claim_primary().is_err(), "nothing copied yet: an empty store that was wiped is not new");
        standby.put_snapshot_page(Cf::Key, &[(b"k".to_vec(), bincode::serialize(&2u8).unwrap())]).unwrap();
        assert!(standby.claim_primary().is_err(), "a partial copy never serves");
        assert!(!standby.synced().unwrap() && standby.sync_in_progress().unwrap());
        drop(standby);
        let reopened = Store::open(d.path()).unwrap();
        assert!(reopened.claim_primary().is_err(), "a restart does not forget the unfinished sync");
        reopened.finish_sync(12).unwrap();
        reopened.claim_primary().unwrap();
        assert!(!reopened.sync_in_progress().unwrap());

        // Records that were never marked synced (written before this marker existed) never serve either.
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.put_snapshot_page(Cf::Lease, &[(b"n".to_vec(), bincode::serialize(&1u8).unwrap())]).unwrap();
        assert!(s.claim_primary().is_err());
    }

    #[test]
    fn a_record_that_does_not_decode_is_an_error_not_a_missing_record() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        let mut b = Batch::default();
        b.put_raw(Cf::Lease, "n", vec![1]);
        s.commit(b, 1).unwrap();
        assert_eq!(s.get::<u8>(Cf::Lease, "absent").unwrap(), None);
        assert!(s.get::<(u64, u64)>(Cf::Lease, "n").is_err(), "a short record must not read as absent");
    }

    #[test]
    fn a_database_of_another_schema_is_refused_at_open() {
        let d = tempfile::tempdir().unwrap();
        drop(Store::open(d.path()).unwrap());
        {
            let mut opts = Options::default();
            opts.create_missing_column_families(true);
            let mut names: Vec<&str> = Cf::ALL.iter().map(|c| c.name()).collect();
            names.push(LOG);
            names.push(META);
            let db = DB::open_cf(&opts, d.path(), names).unwrap();
            db.put_cf(db.cf_handle(META).unwrap(), META_SCHEMA, (SCHEMA + 1).to_be_bytes()).unwrap();
        }
        let err = Store::open(d.path()).err().unwrap();
        assert!(err.contains("schema"), "{}", err);
    }
}

//! The one writer of the accounts column family. Every row change goes through one ordered queue drained by
//! a dedicated thread, so the CF follows the applied state in apply order, and a pin queued behind a block's
//! rows sees the state at that block and nothing later.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};

/// Ops that may wait before the caller is held back.
const MIRROR_QUEUE: usize = 256;
/// Rows per RocksDB batch for a write that is not a block's; a block's rows are one batch.
const WRITE_CHUNK: usize = 10_000;

/// What runs on the mirror thread with a pinned view.
pub(super) type PinThen = Box<dyn FnOnce(PinnedDbSnapshot) + Send>;

enum MirrorOp {
    /// Rows to write. `height` is set for an applied block's rows; `resolved` names addresses a heal found
    /// no longer resident, so nothing is owed for them.
    Write {
        height: Option<u64>,
        puts: Vec<(String, qnet_state::Account)>,
        dels: Vec<String>,
        resolved: Vec<String>,
        done: Option<SyncSender<bool>>,
    },
    /// Pin the DB for the boundary at this height once everything ahead has landed.
    Pin(u64, PinThen),
    /// Resolves once everything ahead has landed.
    Barrier(SyncSender<bool>),
    /// The addresses whose rows a failed write left behind, at this point of the queue.
    Missed(SyncSender<Vec<String>>),
    /// The CF and RAM are about to be replaced wholesale: every row is refused until Open.
    Close(SyncSender<bool>),
    /// RAM holds the replaced state, or nothing: rows are taken again.
    Open,
    #[cfg(test)]
    Stale,
    /// The next write fails without touching the DB.
    #[cfg(test)]
    FailNext,
}

pub(crate) struct AccountMirror {
    tx: Option<SyncSender<MirrorOp>>,
    /// Set by a failed write; cleared once nothing a failed write left behind remains. No pin while set.
    stale: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AccountMirror {
    pub(super) fn start(db: Arc<DB>) -> IntegrationResult<Self> {
        let (tx, rx) = sync_channel::<MirrorOp>(MIRROR_QUEUE);
        let stale = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stale);
        let worker = std::thread::Builder::new()
            .name("qnet-acct-mirror".to_string())
            .spawn(move || run(db, rx, flag))
            .map_err(|e| IntegrationError::Other(format!("account_mirror_spawn_failed: {}", e)))?;
        Ok(Self { tx: Some(tx), stale, worker: Some(worker) })
    }

    /// Queue an op. A full queue holds the caller back until the writer catches up.
    fn send(&self, op: MirrorOp) {
        let tx = match &self.tx { Some(tx) => tx, None => return };
        match tx.try_send(op) {
            Ok(()) => {}
            Err(TrySendError::Full(op)) => {
                if crate::node::is_warn() {
                    println!("[WARN][STORAGE] account_mirror_backpressure depth={}", MIRROR_QUEUE);
                }
                if wait_blocking(|| tx.send(op)).is_err() { self.down(); }
            }
            Err(TrySendError::Disconnected(_)) => self.down(),
        }
    }

    fn down(&self) {
        if !self.stale.swap(true, Ordering::SeqCst) {
            eprintln!("[ERR][STORAGE] account_mirror_down action=writes_fail_pins_skipped");
        }
    }

    fn ticketed(&self, puts: Vec<(String, qnet_state::Account)>, dels: Vec<String>, resolved: Vec<String>) -> MirrorTicket {
        let (done, rx) = sync_channel(1);
        let rows = puts.len() + dels.len();
        self.send(MirrorOp::Write { height: None, puts, dels, resolved, done: Some(done) });
        MirrorTicket { rx, rows }
    }
}

impl Drop for AccountMirror {
    fn drop(&mut self) {
        drop(self.tx.take()); // the thread drains what is queued, then exits
        if let Some(worker) = self.worker.take() {
            // The last store handle can go inside a pin callback, on the mirror thread itself.
            if worker.thread().id() != std::thread::current().id() {
                let _ = worker.join();
            }
        }
    }
}

fn run(db: Arc<DB>, rx: Receiver<MirrorOp>, stale: Arc<AtomicBool>) {
    // Deletes a failed write left undone go again with every later write until one lands; a later put of the
    // same row supersedes its delete. Puts a failed write carried stay `missed` until a later write of the
    // address lands (queue order makes its value at least as new); the mirror is stale while any remain.
    let mut undone: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut missed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut closed = false;
    #[cfg(test)]
    let mut fail_next = false;
    while let Ok(op) = rx.recv() {
        match op {
            MirrorOp::Write { height, puts, dels, resolved, done } => {
                if closed {
                    // Read from the RAM a wholesale replacement is discarding.
                    if let Some(done) = done { let _ = done.send(false); }
                    continue;
                }
                let t0 = std::time::Instant::now();
                for (addr, _) in &puts { undone.remove(addr); }
                let retried = undone.len();
                let mut dels = dels;
                dels.extend(undone.iter().cloned());
                #[cfg(test)]
                let injected = std::mem::take(&mut fail_next);
                #[cfg(not(test))]
                let injected = false;
                let res = if injected { Err("injected".to_string()) } else { write_rows(&db, &puts, &dels, height.is_some()) };
                let ok = match res {
                    Ok(()) => {
                        undone.clear();
                        for (addr, _) in &puts { missed.remove(addr); }
                        for addr in dels.iter().chain(resolved.iter()) { missed.remove(addr); }
                        if missed.is_empty() && stale.swap(false, Ordering::SeqCst) {
                            println!("[INFO][STORAGE] account_mirror_healed rows={} retried_dels={}", puts.len(), retried);
                        }
                        true
                    }
                    Err(e) => {
                        stale.store(true, Ordering::SeqCst);
                        undone.extend(dels.iter().cloned());
                        missed.extend(puts.iter().map(|(addr, _)| addr.clone()));
                        println!("[WARN][STORAGE] account_mirror_write_failed h={} puts={} dels={} undone={} err={}",
                                 height.unwrap_or(0), puts.len(), dels.len(), undone.len(), e);
                        false
                    }
                };
                let ms = t0.elapsed().as_millis();
                if ms > 200 && crate::node::is_warn() {
                    println!("[WARN][STORAGE] slow_account_mirror h={} puts={} dels={} ms={}",
                             height.unwrap_or(0), puts.len(), dels.len(), ms);
                }
                if let Some(done) = done { let _ = done.send(ok); }
            }
            MirrorOp::Pin(height, then) => {
                if closed || stale.load(Ordering::SeqCst) {
                    // Dropping `then` tells its waiter the pin was refused.
                    println!("[WARN][STORAGE] account_pin_skipped h={} reason=mirror_stale", height);
                    continue;
                }
                let view = PinnedDbSnapshot::of(&db);
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || then(view))).is_err() {
                    eprintln!("[ERR][STORAGE] account_pin_callback_panicked h={}", height);
                }
            }
            MirrorOp::Barrier(done) => { let _ = done.send(true); }
            MirrorOp::Missed(reply) => { let _ = reply.send(missed.iter().cloned().collect()); }
            MirrorOp::Close(done) => {
                // What was owed or undone describes the CF being replaced.
                undone.clear();
                missed.clear();
                closed = true;
                let _ = done.send(true);
            }
            MirrorOp::Open => {
                closed = false;
                missed.clear();
                stale.store(false, Ordering::SeqCst);
            }
            #[cfg(test)]
            MirrorOp::Stale => stale.store(true, Ordering::SeqCst),
            #[cfg(test)]
            MirrorOp::FailNext => fail_next = true,
        }
    }
}

/// Write rows; `atomic` keeps them in one batch (an applied block's rows), otherwise they go in chunks.
fn write_rows(db: &DB, puts: &[(String, qnet_state::Account)], dels: &[String], atomic: bool) -> Result<(), String> {
    let accounts = db.cf_handle("accounts").ok_or("accounts column family not found")?;
    let slots = db.cf_handle("contract_storage");
    let mut batch = WriteBatch::default();
    let mut rows = 0usize;
    for (addr, account) in puts {
        let bytes = bincode::serialize(account).map_err(|e| e.to_string())?;
        batch.put_cf(&accounts, addr.as_bytes(), &bytes);
        // A contract's slots go in the same batch as its row.
        if account.is_contract {
            if let Some(ref slots) = slots {
                for (k, v) in &account.contract_storage {
                    batch.put_cf(slots, format!("{}\x00{}", addr, k).as_bytes(), v.as_bytes());
                }
            }
        }
        rows += 1;
        if !atomic && rows % WRITE_CHUNK == 0 {
            db.write(std::mem::take(&mut batch)).map_err(|e| e.to_string())?;
        }
    }
    for addr in dels {
        batch.delete_cf(&accounts, addr.as_bytes());
    }
    db.write(batch).map_err(|e| e.to_string())
}

impl PinnedDbSnapshot {
    /// O(1) point-in-time view of the whole DB.
    pub(super) fn of(db: &Arc<DB>) -> Self {
        let snap = db.snapshot();
        // SAFETY: the view holds its own Arc<DB>, dropped after `snap` (field order), so the DB outlives the
        // borrow this extends to 'static; only the lifetime changes.
        let snap: rocksdb::SnapshotWithThreadMode<'static, DB> = unsafe { std::mem::transmute(snap) };
        PinnedDbSnapshot { snap, db: Arc::clone(db) }
    }
}

/// Resolves when its write has landed: true iff it succeeded.
pub struct MirrorTicket {
    rx: Receiver<bool>,
    rows: usize,
}

impl MirrorTicket {
    pub fn rows(&self) -> usize { self.rows }

    /// Blocking wait. On a runtime worker the worker is handed back to the scheduler first.
    pub fn wait(self) -> bool {
        let rx = self.rx;
        wait_blocking(move || rx.recv().unwrap_or(false))
    }

    /// Async wait, off the runtime's workers.
    pub async fn landed(self) -> bool {
        let rx = self.rx;
        tokio::task::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false)
    }
}

/// Run a blocking wait. On a multi-thread runtime the worker is handed to the scheduler first; anywhere else
/// it simply blocks: the mirror runs on its own thread, so nothing it waits for needs this one.
pub(super) fn wait_blocking<R>(f: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if matches!(h.runtime_flavor(), tokio::runtime::RuntimeFlavor::MultiThread) => tokio::task::block_in_place(f),
        _ => f(),
    }
}

/// The rows one applied block changed, at their post-block values; a journaled address the block removed is
/// a delete. Read under the lock that applied the block.
pub fn account_delta(sg: &crate::StateManager, snap: &qnet_state::BlockSnapshot)
    -> (Vec<(String, qnet_state::Account)>, Vec<String>) {
    let mut puts = Vec::with_capacity(snap.accounts().len() + snap.created_keys().len());
    let mut dels = Vec::new();
    for addr in snap.accounts().keys() {
        match sg.accounts.get(addr) {
            Some(e) => puts.push((addr.clone(), e.value().clone())),
            None => dels.push(addr.clone()),
        }
    }
    for addr in snap.created_keys() {
        if let Some(e) = sg.accounts.get(addr) {
            puts.push((addr.clone(), e.value().clone()));
        }
    }
    (puts, dels)
}

impl Storage {
    /// Queue one applied block's rows behind everything queued before it.
    pub fn mirror_block_delta(&self, height: u64, puts: Vec<(String, qnet_state::Account)>, dels: Vec<String>) {
        if puts.is_empty() && dels.is_empty() {
            return;
        }
        self.mirror.send(MirrorOp::Write { height: Some(height), puts, dels, resolved: Vec::new(), done: None });
    }

    /// Queue rows that are not a block's (an undo, a true-up, an eviction); the ticket resolves once they land.
    pub fn mirror_enqueue(&self, puts: Vec<(String, qnet_state::Account)>, dels: Vec<String>) -> MirrorTicket {
        self.mirror.ticketed(puts, dels, Vec::new())
    }

    /// Rows a heal owes, from the live state; `resolved` names addresses no longer resident.
    fn mirror_heal(&self, puts: Vec<(String, qnet_state::Account)>, resolved: Vec<String>) -> MirrorTicket {
        self.mirror.ticketed(puts, Vec::new(), resolved)
    }

    /// Rewrite the rows a failed write left behind, from the live state, a page at a time under a read lock:
    /// O(what was missed), never on the apply path. True once the mirror follows the state again.
    pub async fn heal_mirror(&self, state: &tokio::sync::RwLock<crate::StateManager>) -> bool {
        const PAGE: usize = 10_000;
        if !self.mirror_stale() {
            return true;
        }
        let (reply, rx) = sync_channel(1);
        self.mirror.send(MirrorOp::Missed(reply));
        let missed = match tokio::task::spawn_blocking(move || rx.recv()).await {
            Ok(Ok(missed)) => missed,
            _ => return false,
        };
        for page in missed.chunks(PAGE) {
            // Read and queued under one read lock, so a later block's row for the same address lands after it.
            let ticket = {
                let sg = state.read().await;
                let (mut puts, mut resolved) = (Vec::with_capacity(page.len()), Vec::new());
                for addr in page {
                    match sg.accounts.get(addr) {
                        Some(e) => puts.push((addr.clone(), e.value().clone())),
                        None => resolved.push(addr.clone()),
                    }
                }
                self.mirror_heal(puts, resolved)
            };
            if !ticket.landed().await {
                println!("[WARN][STORAGE] account_mirror_heal_failed missed={}", missed.len());
                return false;
            }
        }
        // Only undone deletes left: one empty write carries them.
        if self.mirror_stale() {
            let _ = self.mirror_heal(Vec::new(), Vec::new()).landed().await;
        }
        !self.mirror_stale()
    }

    /// The accounts CF is about to be replaced wholesale, and RAM with it: everything queued so far lands, and
    /// every row queued after this is refused until `end_state_replacement` (it was read from the RAM the
    /// replacement discards). Applies pause on the flag meanwhile.
    pub fn begin_state_replacement(&self) {
        SNAPSHOT_REHYDRATE_IN_PROGRESS.store(true, Ordering::SeqCst);
        let (done, rx) = sync_channel(1);
        self.mirror.send(MirrorOp::Close(done));
        let _ = wait_blocking(move || rx.recv());
    }

    /// RAM holds the replaced state, or nothing: rows are taken again and applies resume.
    pub fn end_state_replacement(&self) {
        self.mirror.send(MirrorOp::Open);
        SNAPSHOT_REHYDRATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }

    /// `mirror_enqueue`, then wait for it.
    pub fn mirror_write_durable(&self, puts: Vec<(String, qnet_state::Account)>, dels: Vec<String>)
        -> IntegrationResult<()> {
        let rows = puts.len() + dels.len();
        if self.mirror_enqueue(puts, dels).wait() {
            Ok(())
        } else {
            Err(IntegrationError::StorageError(format!("account_mirror_write_failed rows={}", rows)))
        }
    }

    /// Every resident account of `sg` as one write, read under the caller's lock (genesis, block 0, reconcile).
    pub fn mirror_full_write(&self, sg: &crate::StateManager) -> MirrorTicket {
        self.mirror.ticketed(sg.get_all_accounts(), Vec::new(), Vec::new())
    }

    /// True after a failed write, until nothing it left behind remains.
    pub fn mirror_stale(&self) -> bool {
        self.mirror.stale.load(Ordering::SeqCst)
    }

    /// Wait until everything queued so far has landed.
    pub fn mirror_barrier(&self) {
        let (done, rx) = sync_channel(1);
        self.mirror.send(MirrorOp::Barrier(done));
        let _ = wait_blocking(move || rx.recv());
    }

    /// Pin the DB behind everything queued so far; `then` runs on the mirror thread. Skipped while stale.
    pub(super) fn mirror_pin(&self, height: u64, then: PinThen) {
        self.mirror.send(MirrorOp::Pin(height, then));
    }

    /// A pinned view behind everything queued so far.
    pub fn pin_view(&self) -> IntegrationResult<PinnedDbSnapshot> {
        let (tx, rx) = sync_channel(1);
        self.mirror_pin(0, Box::new(move |view| { let _ = tx.send(view); }));
        wait_blocking(move || rx.recv())
            .map_err(|_| IntegrationError::StorageError("pin_refused reason=mirror_stale".to_string()))
    }

    #[cfg(test)]
    pub(super) fn mirror_force_stale(&self) {
        self.mirror.send(MirrorOp::Stale);
        self.mirror_barrier();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let st = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (st, dir)
    }

    fn acct(addr: &str, balance: u64) -> qnet_state::Account {
        let mut a = qnet_state::Account::new(addr.to_string());
        a.balance = balance;
        a
    }

    fn balance(st: &Storage, addr: &str) -> Option<u64> {
        st.load_account(addr).expect("load").map(|a| a.balance)
    }

    // Rows land in queue order, and a pin queued between two blocks' rows sees the first block and not the second.
    #[test]
    fn a_pin_sees_exactly_the_rows_queued_before_it() {
        let (st, _d) = open();
        st.mirror_block_delta(1, vec![("w".to_string(), acct("w", 1))], Vec::new());
        let (tx, rx) = sync_channel(1);
        st.mirror_pin(1, Box::new(move |view| { let _ = tx.send(view); }));
        st.mirror_block_delta(2, vec![("w".to_string(), acct("w", 2))], Vec::new());
        st.mirror_barrier();
        assert_eq!(balance(&st, "w"), Some(2), "the live row is the newest");
        let view = rx.recv().expect("pinned");
        let cf = view.db.cf_handle("accounts").expect("accounts cf");
        let raw = view.snap.get_cf(&cf, b"w").expect("read").expect("row");
        let pinned: qnet_state::Account = bincode::deserialize(&raw).expect("decode");
        assert_eq!(pinned.balance, 1, "the pin is the state at the block it was queued behind");
    }

    // A durable write has landed when it returns, deletes included.
    #[test]
    fn a_durable_write_is_readable_when_it_returns() {
        let (st, _d) = open();
        st.mirror_write_durable(vec![("a".to_string(), acct("a", 5))], Vec::new()).expect("write");
        assert_eq!(balance(&st, "a"), Some(5));
        st.mirror_write_durable(Vec::new(), vec!["a".to_string()]).expect("delete");
        assert_eq!(balance(&st, "a"), None);
    }

    // After a failed write no pin is taken until the whole resident set has been written again.
    #[test]
    fn a_stale_mirror_takes_no_pin_until_a_full_write_lands() {
        let (st, _d) = open();
        st.mirror_force_stale();
        assert!(st.mirror_stale());
        assert!(st.pin_view().is_err(), "a stale mirror takes no pin");
        let sg = crate::StateManager::new();
        sg.accounts.insert("x".to_string(), acct("x", 3));
        assert!(st.mirror_full_write(&sg).wait());
        assert!(!st.mirror_stale(), "the whole-set write heals it");
        assert!(st.pin_view().is_ok());
        assert_eq!(balance(&st, "x"), Some(3));
    }

    // A delete that failed goes again with the next write, unless a later write put the row back; once it has
    // landed nothing is owed and the mirror is whole again.
    #[test]
    fn a_failed_delete_is_retried_and_healing_waits_for_it() {
        let (st, _d) = open();
        st.mirror_write_durable(vec![("x".to_string(), acct("x", 1)), ("y".to_string(), acct("y", 1))], Vec::new())
            .expect("rows");
        st.mirror.send(MirrorOp::FailNext);
        assert!(st.mirror_write_durable(Vec::new(), vec!["x".to_string(), "y".to_string()]).is_err());
        assert!(st.mirror_stale());
        assert_eq!(balance(&st, "x"), Some(1), "the failed delete left the row");
        st.mirror_block_delta(5, vec![("y".to_string(), acct("y", 2))], Vec::new());
        st.mirror_barrier();
        assert_eq!(balance(&st, "x"), None, "the delete went again with the next write");
        assert_eq!(balance(&st, "y"), Some(2), "a later put wins over the earlier failed delete");
        assert!(!st.mirror_stale(), "nothing the failed write left behind remains");
    }

    // A failed put is owed until the heal rewrites that address from the live state; the heal takes no
    // whole-set copy and a pin is refused until it lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_put_is_healed_from_the_live_state() {
        let (st, _d) = open();
        st.mirror.send(MirrorOp::FailNext);
        assert!(st.mirror_write_durable(vec![("p".to_string(), acct("p", 7))], Vec::new()).is_err());
        assert!(st.mirror_stale());
        st.mirror_block_delta(6, vec![("q".to_string(), acct("q", 1))], Vec::new());
        st.mirror_barrier();
        assert!(st.mirror_stale(), "another address's rows do not pay what p is owed");
        let sg = tokio::sync::RwLock::new(crate::StateManager::new());
        sg.read().await.accounts.insert("p".to_string(), acct("p", 8));
        assert!(st.heal_mirror(&sg).await);
        assert!(!st.mirror_stale());
        assert_eq!(balance(&st, "p"), Some(8), "the heal wrote the live value");
    }

    // While a wholesale replacement runs no row lands and no pin is taken; Open takes rows again.
    #[test]
    fn a_closed_mirror_refuses_rows_until_it_opens() {
        let (st, _d) = open();
        st.begin_state_replacement();
        assert!(st.mirror_write_durable(vec![("r".to_string(), acct("r", 1))], Vec::new()).is_err());
        assert!(st.pin_view().is_err());
        st.end_state_replacement();
        st.mirror_write_durable(vec![("r".to_string(), acct("r", 2))], Vec::new()).expect("open again");
        assert_eq!(balance(&st, "r"), Some(2));
        assert!(!crate::storage::SNAPSHOT_REHYDRATE_IN_PROGRESS.load(Ordering::SeqCst));
    }

    // The store closes when its last handle goes: the mirror thread holds none past its queue.
    #[test]
    fn dropping_the_store_stops_the_mirror_thread() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap().to_string();
        {
            let st = Storage::new(&path).expect("open");
            st.mirror_write_durable(vec![("a".to_string(), acct("a", 1))], Vec::new()).expect("write");
        }
        let st = Storage::new(&path).expect("reopen after the RocksDB lock was released");
        assert_eq!(balance(&st, "a"), Some(1));
    }

    // Tickets resolve on a current-thread runtime, awaited or waited on.
    #[tokio::test]
    async fn tickets_resolve_on_a_current_thread_runtime() {
        let (st, _d) = open();
        assert!(st.mirror_enqueue(vec![("t".to_string(), acct("t", 9))], Vec::new()).landed().await);
        st.mirror_write_durable(vec![("u".to_string(), acct("u", 1))], Vec::new()).expect("sync wait inside a runtime");
        assert_eq!(balance(&st, "t"), Some(9));
        assert_eq!(balance(&st, "u"), Some(1));
    }
}

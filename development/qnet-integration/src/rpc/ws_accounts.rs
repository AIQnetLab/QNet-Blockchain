//! Account events over the node websocket: which connections follow which address, and the hint each committed
//! block sends them. Node-local and off the commit path: a block hands its followed addresses to the hub task in one
//! step that never waits, and the task sends the connections their events once the node serves the block.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tokio::sync::mpsc;

/// Most `account:` channels one connection may follow; a request for more is refused before the upgrade.
pub(super) const MAX_ACCOUNT_CHANNELS: usize = 20;
/// Account events queued for one connection. A client this far behind loses the next ones; its wallet still polls.
const ACCOUNT_QUEUE: usize = 64;
/// Committed blocks waiting for the hub task; past this a block's events are dropped, never waited for.
const BLOCK_QUEUE: usize = 256;
/// Dropped events are reported at most once per this many seconds, with the count and the seconds since the first.
const DROP_REPORT_SECS: u64 = 60;

/// The connections following each address, each with the queue its socket drains.
pub(super) struct AccountHub {
    subs: DashMap<String, Vec<(u64, mpsc::Sender<WsEvent>)>>,
    /// Connections holding at least one account channel: with none, a block never touches the map.
    connections: AtomicUsize,
    next_id: AtomicU64,
    /// The committed blocks' followed addresses on their way to the hub task (`run`), started by the first account
    /// channel on the runtime its connection runs on.
    blocks: std::sync::OnceLock<mpsc::Sender<(u64, Vec<String>)>>,
    /// The height the node serves: a block's events wait for it (`served_by`).
    served: fn() -> u64,
    drops: parking_lot::Mutex<Drops>,
    /// Some dropped event awaits its report: all a block reads when nothing was dropped.
    drops_pending: AtomicBool,
}

/// Dropped events not reported yet, when the first of them came, and when the last report went out (Unix seconds).
#[derive(Default)]
struct Drops {
    count: u64,
    since: u64,
    reported_at: u64,
}

/// The node's hub. A block is served once the node's published tip (`node::local_height`) reaches it, which happens
/// before the block's NewBlock frame goes out.
pub(super) static ACCOUNT_HUB: Lazy<AccountHub> = Lazy::new(|| AccountHub::new(crate::node::local_height));

/// One connection's account channels, taken out of the hub when this drops: the connection ending or unwinding.
pub(super) struct AccountSubs {
    hub: &'static AccountHub,
    id: u64,
    addresses: Vec<String>,
}

impl Drop for AccountSubs {
    fn drop(&mut self) { self.hub.unsubscribe(self.id, &self.addresses); }
}

impl AccountHub {
    fn new(served: fn() -> u64) -> Self {
        Self {
            subs: DashMap::new(),
            connections: AtomicUsize::new(0),
            next_id: AtomicU64::new(0),
            blocks: std::sync::OnceLock::new(),
            served,
            drops: parking_lot::Mutex::new(Drops::default()),
            drops_pending: AtomicBool::new(false),
        }
    }

    /// Register one connection for `addresses` (distinct, see `account_channel_addresses`) and hand it its queue. The
    /// first account channel starts the hub task.
    pub(super) fn subscribe(&'static self, addresses: Vec<String>) -> (AccountSubs, mpsc::Receiver<WsEvent>) {
        let (tx, rx) = mpsc::channel(ACCOUNT_QUEUE);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        for addr in &addresses {
            self.subs.entry(addr.clone()).or_default().push((id, tx.clone()));
        }
        if !addresses.is_empty() {
            self.connections.fetch_add(1, Ordering::AcqRel);
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                self.blocks.get_or_init(|| {
                    let (blocks, queue) = mpsc::channel(BLOCK_QUEUE);
                    rt.spawn(self.run(queue));
                    blocks
                });
            }
        }
        (AccountSubs { hub: self, id, addresses }, rx)
    }

    fn unsubscribe(&self, id: u64, addresses: &[String]) {
        for addr in addresses {
            if let Some(mut subs) = self.subs.get_mut(addr) { subs.retain(|(i, _)| *i != id); }
            self.subs.remove_if(addr, |_, subs| subs.is_empty());
        }
        if !addresses.is_empty() { self.connections.fetch_sub(1, Ordering::AcqRel); }
    }

    /// The commit path: of the addresses the block at `height` touched, the distinct ones a connection follows go to the
    /// hub task in one `try_send`; returns how many. O(touched) lookups, whatever the number of followers, and never
    /// waits: an address whose entry is being written is handed on for the task to look up, and a full queue drops the
    /// block's events.
    pub(super) fn notify_block<'a>(&self, height: u64, touched: impl IntoIterator<Item = &'a str>) -> usize {
        self.report_dropped(height, 0);
        if self.connections.load(Ordering::Acquire) == 0 { return 0; }
        let Some(blocks) = self.blocks.get() else { return 0; };
        let mut seen = std::collections::HashSet::new();
        let followed: Vec<String> = touched.into_iter()
            .filter(|addr| seen.insert(*addr) && !matches!(self.subs.try_get(*addr), dashmap::try_result::TryResult::Absent))
            .map(str::to_string)
            .collect();
        let n = followed.len();
        if n == 0 { return 0; }
        match blocks.try_send((height, followed)) {
            Ok(()) => n,
            Err(_) => {
                self.report_dropped(height, n as u64);
                0
            }
        }
    }

    /// The hub task: each committed block's events, once the node serves the block, to every connection following one
    /// of its addresses.
    async fn run(&'static self, mut blocks: mpsc::Receiver<(u64, Vec<String>)>) {
        while let Some((height, addresses)) = blocks.recv().await {
            self.served_by(height).await;
            self.fan_out(height, &addresses);
        }
    }

    /// Until the node serves `height`: its tip moves before the block's NewBlock frame, which wakes this, so a wallet
    /// reading at once reads the block. A block the node serves already (a replay) goes at once.
    async fn served_by(&self, height: u64) {
        if (self.served)() >= height { return; }
        let mut wake = WS_BROADCASTER.subscribe();
        while (self.served)() < height {
            if let Err(broadcast::error::RecvError::Closed) = wake.recv().await { return; }
        }
    }

    /// One BalanceUpdate per address to every connection following it; returns how many were queued. A full queue
    /// drops that event.
    fn fan_out(&self, height: u64, addresses: &[String]) -> usize {
        let (mut queued, mut dropped) = (0usize, 0u64);
        for addr in addresses {
            let Some(subs) = self.subs.get(addr) else { continue; };
            for (_, tx) in subs.iter() {
                match tx.try_send(WsEvent::BalanceUpdate { address: addr.clone(), block_height: height }) {
                    Ok(()) => queued += 1,
                    Err(mpsc::error::TrySendError::Full(_)) => dropped += 1,
                    Err(mpsc::error::TrySendError::Closed(_)) => {} // its connection is leaving
                }
            }
        }
        self.report_dropped(height, dropped);
        queued
    }

    /// Count `n` dropped events (0: only what awaits its report) and log them (`note_drops`).
    fn report_dropped(&self, height: u64, n: u64) {
        if n == 0 && !self.drops_pending.load(Ordering::Acquire) { return; }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        if let Some(line) = self.note_drops(height, n, now) {
            if is_warn() { println!("[WARN][WS] {}", line); }
        }
    }

    /// Count `n` dropped events at `now`; the report once DROP_REPORT_SECS passed since the last one: the count and the
    /// seconds since the first of them, at the first block past the window, one that drops nothing included.
    fn note_drops(&self, height: u64, n: u64, now: u64) -> Option<String> {
        let mut d = self.drops.lock();
        if n > 0 {
            if d.count == 0 { d.since = now; }
            d.count += n;
            self.drops_pending.store(true, Ordering::Release);
        }
        if d.count == 0 || now < d.reported_at.saturating_add(DROP_REPORT_SECS) { return None; }
        let line = format!("account_events_dropped h={} dropped={} span_s={}", height, d.count, now.saturating_sub(d.since));
        d.count = 0;
        d.reported_at = now;
        self.drops_pending.store(false, Ordering::Release);
        Some(line)
    }
}

/// The committed block at `height` touched `addresses`: hint every connection following one of them.
pub(crate) fn notify_account_block<'a>(height: u64, addresses: impl IntoIterator<Item = &'a str>) {
    ACCOUNT_HUB.notify_block(height, addresses);
}

/// The distinct addresses a connection's `account:` channels follow, lowercased as blocks carry them, or why the
/// request is refused: one that is not an address, or more than MAX_ACCOUNT_CHANNELS of them.
pub(super) fn account_channel_addresses(channels: &[WsChannel]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for ch in channels {
        let WsChannel::Account(raw) = ch else { continue };
        let addr = raw.to_ascii_lowercase();
        validate_eon_address_with_error(&addr).map_err(|e| format!("Invalid account channel: {}", e))?;
        if out.contains(&addr) { continue; }
        if out.len() == MAX_ACCOUNT_CHANNELS {
            return Err(format!("Too many account channels: at most {} per connection", MAX_ACCOUNT_CHANNELS));
        }
        out.push(addr);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hub whose blocks the node always serves. A test with no runtime starts no hub task.
    fn hub() -> &'static AccountHub { Box::leak(Box::new(AccountHub::new(|| u64::MAX))) }
    /// `hub` with the hub task's queue in the test's hands: what the commit path hands on, up to `cap` blocks.
    fn queued_hub(cap: usize) -> (&'static AccountHub, mpsc::Receiver<(u64, Vec<String>)>) {
        let h = hub();
        let (blocks, queue) = mpsc::channel(cap);
        assert!(h.blocks.set(blocks).is_ok());
        (h, queue)
    }
    fn addr(tag: &str) -> String { qnet_state::transaction::derive_contract_address(tag, 0) }
    fn drain(rx: &mut mpsc::Receiver<WsEvent>) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::BalanceUpdate { address, block_height } => out.push((address, block_height)),
                other => panic!("only account events reach the queue, got {:?}", other),
            }
        }
        out.sort();
        out
    }

    // The commit path hands the hub task each followed address the block touched, once, and nothing when it touched none;
    // the task sends one event per address to each connection following it, and nothing for an address it did not touch.
    #[test]
    fn a_block_hints_each_followed_address_once() {
        let (h, mut blocks) = queued_hub(8);
        let (a, b, c, d) = (addr("a"), addr("b"), addr("c"), addr("d"));
        let (_wallet, mut wallet_rx) = h.subscribe(vec![a.clone(), b.clone(), c.clone()]);
        let (_watcher, mut watcher_rx) = h.subscribe(vec![b.clone()]);
        assert_eq!(h.notify_block(7, [a.as_str(), b.as_str(), d.as_str(), b.as_str()]), 2);
        let (height, followed) = blocks.try_recv().expect("handed on");
        assert_eq!((height, &followed), (7, &vec![a.clone(), b.clone()]));
        assert_eq!(h.fan_out(height, &followed), 3);
        let mut want = vec![(a.clone(), 7), (b.clone(), 7)];
        want.sort();
        assert_eq!(drain(&mut wallet_rx), want);
        assert_eq!(drain(&mut watcher_rx), vec![(b.clone(), 7)]);
        assert_eq!(h.notify_block(8, [d.as_str()]), 0, "an address nobody follows hands nothing on");
        assert!(blocks.try_recv().is_err());
        assert!(drain(&mut wallet_rx).is_empty() && drain(&mut watcher_rx).is_empty());
    }

    // A connection leaving takes its channels with it; the hub forgets an address with its last follower, and with no
    // connection left a block hands nothing on.
    #[test]
    fn a_closed_connection_leaves_the_hub() {
        let (h, mut blocks) = queued_hub(8);
        let a = addr("leave");
        let (first, _first_rx) = h.subscribe(vec![a.clone()]);
        let (second, mut second_rx) = h.subscribe(vec![a.clone()]);
        drop(first);
        assert_eq!(h.fan_out(1, &[a.clone()]), 1);
        assert_eq!(drain(&mut second_rx), vec![(a.clone(), 1)]);
        drop(second);
        assert!(!h.subs.contains_key(&a), "the address leaves with its last follower");
        assert_eq!(h.connections.load(Ordering::Acquire), 0);
        assert_eq!(h.fan_out(2, &[a.clone()]), 0);
        assert_eq!(h.notify_block(2, [a.as_str()]), 0);
        assert!(blocks.try_recv().is_err());
        let (_none, _rx) = h.subscribe(Vec::new());
        assert_eq!(h.connections.load(Ordering::Acquire), 0, "a connection with no account channel is not counted");
    }

    // A slow client's full queue drops the newest events; a full queue of blocks drops the block's events at the commit
    // path. Neither ever holds the block up, and both are counted for the report.
    #[test]
    fn a_full_queue_drops_instead_of_blocking() {
        let h = hub();
        let a = addr("slow");
        let (_subs, mut rx) = h.subscribe(vec![a.clone()]);
        let queued: usize = (0..ACCOUNT_QUEUE as u64 + 36).map(|height| h.fan_out(height, &[a.clone()])).sum();
        assert_eq!(queued, ACCOUNT_QUEUE);
        let got = drain(&mut rx);
        assert_eq!(got.len(), ACCOUNT_QUEUE);
        assert_eq!(got.last(), Some(&(a.clone(), ACCOUNT_QUEUE as u64 - 1)), "the oldest are kept, the newest dropped");
        assert_eq!(h.fan_out(500, &[a.clone()]), 1, "a drained queue takes events again");
        let (q, mut blocks) = queued_hub(2);
        let (_s, _r) = q.subscribe(vec![a.clone()]);
        assert_eq!((0..5u64).map(|height| q.notify_block(height, [a.as_str()])).collect::<Vec<_>>(), vec![1, 1, 0, 0, 0]);
        assert_eq!(q.drops.lock().count, 2, "the first drop was reported at once, the next two wait for the minute");
        assert_eq!(blocks.try_recv().map(|b| b.0), Ok(0));
    }

    // Dropped events are reported at most once a minute with the seconds they span; a count left at the end of a window
    // goes out with the next block past it, one that drops nothing.
    #[test]
    fn dropped_events_are_reported_with_their_span() {
        let h = hub();
        let t = 1_800_000_000u64;
        assert_eq!(h.note_drops(1, 3, t).as_deref(), Some("account_events_dropped h=1 dropped=3 span_s=0"));
        assert_eq!(h.note_drops(2, 2, t + 10), None, "within the minute: counted");
        assert_eq!(h.note_drops(3, 1, t + 50), None);
        assert!(h.drops_pending.load(Ordering::Acquire));
        assert_eq!(h.note_drops(4, 0, t + 59), None);
        assert_eq!(h.note_drops(5, 0, t + 60).as_deref(), Some("account_events_dropped h=5 dropped=3 span_s=50"));
        assert!(!h.drops_pending.load(Ordering::Acquire));
        assert_eq!(h.note_drops(6, 0, t + 7_200), None, "nothing left to report");
        assert_eq!(h.note_drops(7, 1, t + 7_300).as_deref(), Some("account_events_dropped h=7 dropped=1 span_s=0"));
        // Every block flushes what awaits its report, a block with no connection included.
        let src = include_str!("ws_accounts.rs");
        let commit = &src[src.find("pub(super) fn notify_block<'a>(").unwrap()..];
        assert!(commit[..commit.find("self.connections.load(").unwrap()].contains("self.report_dropped(height, 0);"));
    }

    // A block meeting a subscription being written hands that address on instead of waiting for the writer.
    #[test]
    fn a_shard_being_written_is_passed_on_not_waited_on() {
        let (h, mut blocks) = queued_hub(8);
        let a = addr("busy");
        let (_subs, mut rx) = h.subscribe(vec![a.clone()]);
        let writer = h.subs.get_mut(&a).expect("followed");
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let a_in = a.clone();
        std::thread::spawn(move || { let _ = done_tx.send(h.notify_block(1, [a_in.as_str()])); });
        let handed = done_rx.recv_timeout(std::time::Duration::from_secs(5));
        drop(writer);
        assert_eq!(handed, Ok(1), "the block went on while the shard was written");
        let (height, followed) = blocks.try_recv().expect("handed on");
        assert_eq!(h.fan_out(height, &followed), 1);
        assert_eq!(drain(&mut rx), vec![(a, 1)]);
    }

    // The hub task holds a block's events until the node serves it: the tip moves before the block's NewBlock frame,
    // which wakes the task. A block the node serves already goes at once.
    #[tokio::test]
    async fn the_hub_task_sends_a_block_once_the_node_serves_it() {
        static SERVED: AtomicU64 = AtomicU64::new(0);
        let h: &'static AccountHub = Box::leak(Box::new(AccountHub::new(|| SERVED.load(Ordering::Acquire))));
        let a = addr("served");
        let (_subs, mut rx) = h.subscribe(vec![a.clone()]);
        async fn next(rx: &mut mpsc::Receiver<WsEvent>, ms: u64) -> Option<u64> {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), rx.recv()).await {
                Ok(Some(WsEvent::BalanceUpdate { block_height, .. })) => Some(block_height),
                _ => None,
            }
        }
        SERVED.store(9, Ordering::Release);
        assert_eq!(h.notify_block(9, [a.as_str()]), 1);
        assert_eq!(next(&mut rx, 5_000).await, Some(9));
        assert_eq!(h.notify_block(10, [a.as_str()]), 1);
        assert_eq!(next(&mut rx, 200).await, None, "not served yet");
        SERVED.store(10, Ordering::Release);
        broadcast_ws_event(WsEvent::NewBlock { height: 10, hash: "h".into(), timestamp: 0, tx_count: 0, producer: "p".into() });
        assert_eq!(next(&mut rx, 5_000).await, Some(10));
    }

    // At most MAX_ACCOUNT_CHANNELS distinct addresses per connection, each a valid address; a repeat or another
    // letter case of one counts once, and the other channel kinds are not account channels.
    #[test]
    fn account_channels_are_limited_and_checked() {
        let addrs: Vec<String> = (0..=MAX_ACCOUNT_CHANNELS as u64)
            .map(|i| qnet_state::transaction::derive_contract_address("ws_limit", i)).collect();
        let chans = |list: &[String]| list.iter().map(|a| WsChannel::Account(a.clone())).collect::<Vec<_>>();
        assert_eq!(account_channel_addresses(&chans(&addrs[..MAX_ACCOUNT_CHANNELS])), Ok(addrs[..MAX_ACCOUNT_CHANNELS].to_vec()));
        let over = account_channel_addresses(&chans(&addrs)).unwrap_err();
        assert_eq!(over, "Too many account channels: at most 20 per connection");
        let mut repeats = chans(&addrs[..MAX_ACCOUNT_CHANNELS]);
        repeats.push(WsChannel::Account(addrs[0].clone()));
        repeats.push(WsChannel::Account(addrs[1].to_ascii_uppercase()));
        assert_eq!(account_channel_addresses(&repeats).map(|v| v.len()), Ok(MAX_ACCOUNT_CHANNELS));
        assert!(account_channel_addresses(&[WsChannel::Account("nobody".into())]).unwrap_err().starts_with("Invalid account channel: "));
        let url = format!("blocks,mempool,contract:x,account:{}", addrs[0].to_ascii_uppercase());
        assert_eq!(account_channel_addresses(&parse_ws_channels(&url)), Ok(vec![addrs[0].clone()]));
    }

    // The frame the wallet reads: `type` BalanceUpdate, `data.address`, `data.block_height`, sent by the
    // connection's send loop straight from its queue.
    #[tokio::test]
    async fn the_send_loop_forwards_account_events_as_the_wallet_reads_them() {
        let (_feed, mut rx) = broadcast::channel::<WsEvent>(8);
        let h = hub();
        let a = addr("frame");
        let (_subs, mut account_rx) = h.subscribe(vec![a.clone()]);
        assert_eq!(h.fan_out(77, &[a.clone()]), 1);
        let mut reader = tokio::spawn(std::future::pending::<()>());
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let frames_in = frames.clone();
        let done = tokio::time::timeout(std::time::Duration::from_secs(5),
            forward_until_closed(&mut rx, &mut account_rx, &mut reader, |_| false, move |text| {
                frames_in.lock().unwrap().push(text);
                async { Err("stop".to_string()) }
            })).await;
        reader.abort();
        assert!(done.is_ok());
        let frames = frames.lock().unwrap();
        let v: Value = serde_json::from_str(&frames[0]).expect("json");
        assert_eq!(v, json!({ "type": "BalanceUpdate", "data": { "address": a, "block_height": 77 } }));
    }

    // End to end on the shared commit hook: a block applied by the apply path and written by the one side-index
    // writer both block paths call hands the node's hub its sender and recipient, and no other address; the hub task's
    // queue is the test's here, so nothing waits for the node's tip.
    #[test]
    fn a_committed_block_hints_the_addresses_it_touched() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (from, to, idle) = (addr("e2e_from"), addr("e2e_to"), addr("e2e_idle"));
        let st = qnet_state::State::new();
        let mut funded = qnet_state::Account::default();
        funded.address = from.clone();
        funded.balance = 1_000_000_000_000;
        st.restore_accounts(vec![(from.clone(), funded)]).expect("restore");
        let tx = qnet_state::Transaction::new(from.clone(), Some(to.clone()), 5_000, 1, 0, qnet_state::gas_limits::TRANSFER, 0,
            None, qnet_state::TransactionType::Transfer { from: from.clone(), to: to.clone(), amount: 5_000 }, None);
        let mb = qnet_state::MicroBlock {
            height: 4_242, timestamp: 0, transactions: vec![tx], producer: "genesis_node_001".to_string(),
            signature: vec![0u8; 64], merkle_root: [7u8; 32], previous_hash: [0u8; 32],
            vrf_output: None, vrf_proof: None, fees_collected: 0,
            state_root: [0u8; 32], timeout_round: 0, carried_baseline: 0, timeout_proof: None,
        };
        let (blocks, mut queue) = mpsc::channel(8);
        assert!(ACCOUNT_HUB.blocks.set(blocks).is_ok(), "only this test feeds the node's hub");
        let (_wallet, mut wallet_rx) = ACCOUNT_HUB.subscribe(vec![from.clone(), to.clone(), idle.clone()]);
        let (_watcher, mut watcher_rx) = ACCOUNT_HUB.subscribe(vec![idle.clone()]);
        let r = BlockchainNode::apply_block_to_state(&st, &mb, &storage, None);
        assert_eq!(st.get_account(&to).map(|a| a.balance), Some(5_000), "the transfer applied");
        BlockchainNode::flush_block_side_indices(&storage, mb.height, &r.side_indices);
        let (height, mut followed) = queue.try_recv().expect("handed on");
        followed.sort();
        let mut want = vec![from.clone(), to.clone()];
        want.sort();
        assert_eq!((height, &followed), (4_242, &want));
        assert_eq!(ACCOUNT_HUB.fan_out(height, &followed), 2);
        assert_eq!(drain(&mut wallet_rx), want.into_iter().map(|a| (a, 4_242)).collect::<Vec<_>>());
        assert!(drain(&mut watcher_rx).is_empty(), "an address the block did not touch hears nothing");
    }
}

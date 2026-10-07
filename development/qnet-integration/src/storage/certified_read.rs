//! The certified read side: proofs built over one held view's snapshots, never over live state.
//! Every read skips the block cache and every failure is an answer of its own. The only live reads
//! are single rows, accepted only when they hash to the leaf the view proves.

use super::*;
use super::aux_db::{stor_leaf_key, stor_node_key, CF_ACCT_PRE, CF_STOR_NODES, CF_STOR_PRE};
use super::proof_views::{no_cache, SnapshotTreeReader, View};
use super::tree_db::ROOT_DEPTH;
use qnet_state::{AccountLeafPreimage, LeafProofKind, ProveError, StateMerkleTree, StoredRows};
use std::collections::BTreeSet;

/// A live accounts row longer than this is never decoded by the preimage fallback: a plain account
/// with its ML-DSA key is about 2.1 KB, and only a contract's storage map makes a row large.
const FALLBACK_ROW_MAX_BYTES: usize = 64 * 1024;
/// Failed self-checks already logged, per (index, kind): a broken view is reported once, counted always.
static SELF_CHECK_LOGGED: parking_lot::Mutex<BTreeSet<(u64, &'static str)>> = parking_lot::const_mutex(BTreeSet::new());
const SELF_CHECK_LOGGED_MAX: usize = 64;

pub type ProofSteps = Vec<([u8; 32], bool)>;

/// An account at one view: its proof and, for an inclusion, every field its leaf hashes.
#[derive(Debug, Clone)]
pub struct AccountAnswer {
    pub kind: LeafProofKind,
    pub steps: ProofSteps,
    /// Some exactly when `kind` is an inclusion.
    pub fields: Option<AccountLeafPreimage>,
}

/// What the proven contract leaf is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractStatus {
    Absent,
    NotContract,
    Contract,
}

impl ContractStatus {
    pub fn name(self) -> &'static str {
        match self {
            ContractStatus::Absent => "absent",
            ContractStatus::NotContract => "not_contract",
            ContractStatus::Contract => "contract",
        }
    }
}

/// One storage key of a contract at one view.
#[derive(Debug, Clone)]
pub struct StorageAnswer {
    pub kind: LeafProofKind,
    pub steps: ProofSteps,
    /// The raw stored value; Some exactly when `kind` is an inclusion.
    pub value: Option<String>,
}

/// A holder's token balance at one view: the contract leaf, then its storage key when it is a contract.
#[derive(Debug, Clone)]
pub struct TokenAnswer {
    pub account: AccountAnswer,
    pub status: ContractStatus,
    /// Some exactly when `status` is `Contract`.
    pub storage: Option<StorageAnswer>,
}

/// Why no proof could be built at a view. Each is a retryable refusal, never a negative answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofFailure {
    /// The leaf's fields are neither in the view nor in one live row that hashes to it.
    PreimageUnavailable,
    /// The view does not hold the storage tree the proven contract leaf names.
    StorageUnavailable,
    /// A snapshot read failed or returned a malformed row.
    ReadError,
    /// The view lacks a row it must hold, or a proof failed its own fold.
    Inconsistent,
    /// The key's bucket holds more entries than a proof reads or an absence answer carries.
    BucketOversize,
}

impl ProofFailure {
    pub fn reason(self) -> &'static str {
        match self {
            ProofFailure::PreimageUnavailable => "preimage_unavailable",
            ProofFailure::StorageUnavailable => "storage_unavailable",
            ProofFailure::ReadError => "read_error",
            ProofFailure::Inconsistent => "inconsistent",
            ProofFailure::BucketOversize => "bucket_oversize",
        }
    }
}

/// A live accounts row as the preimage fallback sees it.
enum LiveRow {
    /// No row, a contract, or a row too large to be a plain account: never accepted.
    Unusable,
    Plain(qnet_state::Account),
}

impl Storage {
    /// Proof of `address` at `view`: inclusion with every leaf field, or absence with its proof.
    pub fn certified_account_proof(&self, view: &View, address: &str) -> Result<AccountAnswer, ProofFailure> {
        let key = StateMerkleTree::hash_address(address);
        let proof = {
            let mut reader = SnapshotTreeReader::accounts(view);
            qnet_state::prove_leaf(&mut reader, &key).map_err(|e| self.prove_failed(view, "account", &key, e))?
        };
        let fields = match &proof.kind {
            LeafProofKind::Inclusion(leaf) => Some(self.account_fields(view, address, &key, leaf)?),
            LeafProofKind::Absence | LeafProofKind::AbsenceInBucket(_) => None,
        };
        if !qnet_state::verify_account_proof(address, fields.as_ref(), &proof.kind, &proof.steps, &view.root) {
            return Err(self.self_check_failed(view, "account", &key));
        }
        Ok(AccountAnswer { kind: proof.kind, steps: proof.steps, fields })
    }

    /// Proof of `holder`'s balance in `contract` at `view`. A contract that is absent or not a contract
    /// is answered by the level-1 proof alone: a proven negative is an answer.
    pub fn certified_token_proof(&self, view: &View, contract: &str, holder: &str) -> Result<TokenAnswer, ProofFailure> {
        let account = self.certified_account_proof(view, contract)?;
        let (status, storage) = match &account.fields {
            None => (ContractStatus::Absent, None),
            Some(f) if !f.is_contract => (ContractStatus::NotContract, None),
            Some(f) => (ContractStatus::Contract, Some(self.storage_answer(view, contract, holder, &f.storage_root)?)),
        };
        Ok(TokenAnswer { account, status, storage })
    }

    /// The fields behind an included account leaf: the view's own preimage row, else one live plain
    /// account row that hashes to the same leaf. A contract never takes the live path.
    fn account_fields(&self, view: &View, address: &str, key: &[u8; 32], leaf: &[u8; 32]) -> Result<AccountLeafPreimage, ProofFailure> {
        match view.aux.get_cf_opt(CF_ACCT_PRE, key, no_cache()) {
            Ok(Some(raw)) => {
                if let Some(p) = AccountLeafPreimage::decode(&raw) {
                    if p.leaf_hash(address) == *leaf {
                        return Ok(p);
                    }
                }
            }
            Ok(None) => {}
            Err(_) => return Err(ProofFailure::ReadError),
        }
        self.persistent.views.stats.preimage_fallback.fetch_add(1, Ordering::Relaxed);
        match self.live_plain_account(address) {
            Ok(LiveRow::Plain(acc)) => {
                let p = AccountLeafPreimage::of(&acc);
                if p.leaf_hash(address) == *leaf { Ok(p) } else { Err(ProofFailure::PreimageUnavailable) }
            }
            Ok(LiveRow::Unusable) => Err(ProofFailure::PreimageUnavailable),
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][PROOFVIEW] preimage_fallback_read_failed index={} err={}", view.index, e);
                }
                Err(ProofFailure::PreimageUnavailable)
            }
        }
    }

    /// One live accounts row, read past the block cache. A contract's row carries its whole storage
    /// map, so an address with stored slots, or a row too large for a plain account, is never decoded.
    fn live_plain_account(&self, address: &str) -> Result<LiveRow, String> {
        let db = &self.persistent.db;
        let slots = db.cf_handle("contract_storage").ok_or("contract_storage family missing")?;
        let prefix = format!("{}\x00", address);
        let mut it = db.raw_iterator_cf_opt(&slots, no_cache());
        it.seek(prefix.as_bytes());
        if it.valid() && it.key().map_or(false, |k| k.starts_with(prefix.as_bytes())) {
            return Ok(LiveRow::Unusable);
        }
        it.status().map_err(|e| e.to_string())?;
        drop(it);
        #[cfg(test)]
        tests::ACCOUNT_ROW_READS.with(|n| n.set(n.get() + 1));
        let accounts = db.cf_handle("accounts").ok_or("accounts family missing")?;
        let row = match db.get_pinned_cf_opt(&accounts, address.as_bytes(), &no_cache()).map_err(|e| e.to_string())? {
            Some(row) => row,
            None => return Ok(LiveRow::Unusable),
        };
        if row.len() > FALLBACK_ROW_MAX_BYTES {
            return Ok(LiveRow::Unusable);
        }
        let acc: qnet_state::Account = bincode::deserialize(&row).map_err(|e| e.to_string())?;
        Ok(if acc.is_contract { LiveRow::Unusable } else { LiveRow::Plain(acc) })
    }

    /// `balance:{holder}` in the storage tree of `contract`, which the view must hold at exactly the
    /// root the proven contract leaf names (no root row for the empty tree).
    fn storage_answer(&self, view: &View, contract: &str, holder: &str, storage_root: &[u8; 32]) -> Result<StorageAnswer, ProofFailure> {
        let c = StateMerkleTree::hash_address(contract);
        let row = view.aux.get_cf_opt(CF_STOR_NODES, &stor_node_key(&c, ROOT_DEPTH, &[0u8; 32]), no_cache())
            .map_err(|_| ProofFailure::ReadError)?;
        let held = if *storage_root == StateMerkleTree::empty_root() {
            row.is_none()
        } else {
            row.as_deref() == Some(&storage_root[..])
        };
        if !held {
            return Err(ProofFailure::StorageUnavailable);
        }
        // The QRC-20 balance slot, as the token contract stores it.
        let slot = format!("balance:{}", holder);
        let sk = StateMerkleTree::hash_storage_key(&slot);
        let proof = {
            let mut reader = SnapshotTreeReader::storage(view, c);
            qnet_state::prove_leaf_in(&mut reader, &sk, StoredRows::Branches)
                .map_err(|e| self.prove_failed(view, "storage", &sk, e))?
        };
        let value = match &proof.kind {
            LeafProofKind::Inclusion(leaf) => Some(self.storage_value(view, &c, contract, &slot, &sk, leaf)?),
            LeafProofKind::Absence | LeafProofKind::AbsenceInBucket(_) => None,
        };
        if !qnet_state::verify_storage_proof(&slot, value.as_deref(), &proof.kind, &proof.steps, storage_root) {
            return Err(self.self_check_failed(view, "storage", &sk));
        }
        Ok(StorageAnswer { kind: proof.kind, steps: proof.steps, value })
    }

    /// The raw value behind an included storage leaf: the view's own row, else the one live slot row
    /// of the main DB, either accepted only when it hashes to the leaf.
    fn storage_value(&self, view: &View, c: &[u8; 32], contract: &str, slot: &str, sk: &[u8; 32], leaf: &[u8; 32])
        -> Result<String, ProofFailure> {
        let hashes = |v: &[u8]| std::str::from_utf8(v).ok()
            .filter(|s| StateMerkleTree::storage_leaf_value(s) == *leaf)
            .map(str::to_string);
        match view.aux.get_cf_opt(CF_STOR_PRE, &stor_leaf_key(c, sk), no_cache()) {
            Ok(Some(raw)) => {
                if let Some(v) = hashes(&raw) {
                    return Ok(v);
                }
            }
            Ok(None) => {}
            Err(_) => return Err(ProofFailure::ReadError),
        }
        self.persistent.views.stats.preimage_fallback.fetch_add(1, Ordering::Relaxed);
        let db = &self.persistent.db;
        let cf = db.cf_handle("contract_storage").ok_or(ProofFailure::PreimageUnavailable)?;
        match db.get_pinned_cf_opt(&cf, format!("{}\x00{}", contract, slot).as_bytes(), &no_cache()) {
            Ok(Some(raw)) => hashes(&raw).ok_or(ProofFailure::PreimageUnavailable),
            Ok(None) => Err(ProofFailure::PreimageUnavailable),
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][PROOFVIEW] preimage_fallback_read_failed index={} err={}", view.index, e);
                }
                Err(ProofFailure::PreimageUnavailable)
            }
        }
    }

    fn prove_failed(&self, view: &View, kind: &'static str, key: &[u8; 32], e: ProveError) -> ProofFailure {
        match e {
            ProveError::Read(_) => ProofFailure::ReadError,
            ProveError::BucketOversize(_) => ProofFailure::BucketOversize,
            ProveError::Inconsistent => self.self_check_failed(view, kind, key),
        }
    }

    /// A view that cannot prove its own root: logged once per index and kind, counted every time.
    fn self_check_failed(&self, view: &View, kind: &'static str, key: &[u8; 32]) -> ProofFailure {
        self.persistent.views.stats.self_check_failed.fetch_add(1, Ordering::Relaxed);
        let first = {
            let mut logged = SELF_CHECK_LOGGED.lock();
            let first = logged.insert((view.index, kind));
            while logged.len() > SELF_CHECK_LOGGED_MAX {
                logged.pop_first();
            }
            first
        };
        if first {
            eprintln!("[ERR][PROOFVIEW] proof_self_check_failed index={} kind={} key={}",
                      view.index, kind, hex::encode(&key[..6]));
        }
        ProofFailure::Inconsistent
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use super::super::proof_views::rig::*;
    use qnet_state::Account;

    thread_local! {
        /// Live accounts rows the preimage fallback read on this thread.
        pub(in crate::storage) static ACCOUNT_ROW_READS: std::cell::Cell<u64> = std::cell::Cell::new(0);
    }

    const TOKEN: &str = "eon_cr_token";

    fn token(holders: u64) -> Account {
        let mut c = Account::new(TOKEN.to_string());
        c.is_contract = true;
        c.contract_code_hash = Some("ab".repeat(32));
        c.contract_storage = (0..holders).map(|i| (format!("balance:eon_cr_h{:04}", i), format!("{}", 100 + i))).collect();
        c.storage_root = StateMerkleTree::compute_storage_root(&c.contract_storage);
        c
    }

    /// `wallets` accounts and the token restored, blocks 1..=90 applied, view 1 certified.
    /// `before_capture` may change the live aux DB first, so the captured view misses what it removed.
    fn certified(wallets: u64, before_capture: impl Fn(&Rig)) -> (Rig, Arc<View>) {
        let r = rig();
        let mut all: Vec<(String, Account)> = (0..wallets.max(50))
            .map(|i| { let a = wallet(i, 10_000 + i); (a.address.clone(), a) }).collect();
        let t = token(40);
        all.push((t.address.clone(), t));
        r.sm.restore_accounts(all).expect("restore");
        let mut root = [0u8; 32];
        for h in 1..=90 { root = block(&r, h); }
        settle(&r);
        before_capture(&r);
        certify(&r, 90, root);
        wait_for("view 1", || view_indices(&r) == vec![1]);
        let view = Arc::clone(&r.st.proof_views().current().views[0]);
        (r, view)
    }

    // A contract's live row carries its whole storage map, so a contract whose preimage the view
    // lacks is refused at once: the accounts row is never read, and StateManager is out of reach by
    // the signature itself.
    #[test]
    fn contract_preimage_miss_never_reads_live_state() {
        let w3 = wallet(3, 0).address;
        let (r, view) = certified(50, |r| {
            delete_preimage(r, TOKEN);
            delete_preimage(r, &wallet(3, 0).address);
        });
        put_live_account(&r, &r.sm.get_account(TOKEN).unwrap());
        ACCOUNT_ROW_READS.with(|n| n.set(0));
        assert_eq!(r.st.certified_account_proof(&view, TOKEN).unwrap_err(), ProofFailure::PreimageUnavailable);
        assert_eq!(r.st.certified_token_proof(&view, TOKEN, "eon_cr_h0001").unwrap_err(), ProofFailure::PreimageUnavailable);
        assert_eq!(ACCOUNT_ROW_READS.with(|n| n.get()), 0, "a contract's row is never read");
        // A plain account is served from its one live row while that row hashes to the view's leaf.
        let live = r.sm.get_account(&w3).unwrap();
        put_live_account(&r, &live);
        let used = r.st.proof_views().stats.preimage_fallback.load(Ordering::Relaxed);
        let a = r.st.certified_account_proof(&view, &w3).expect("served from the live row");
        assert_eq!(a.fields, Some(AccountLeafPreimage::of(&live)));
        assert_eq!(ACCOUNT_ROW_READS.with(|n| n.get()), 1, "exactly one row read");
        assert!(r.st.proof_views().stats.preimage_fallback.load(Ordering::Relaxed) > used);
        // Once the live row moves on, it no longer hashes to the view's leaf: refused, never guessed.
        let mut moved = live.clone();
        moved.balance += 1;
        put_live_account(&r, &moved);
        assert_eq!(r.st.certified_account_proof(&view, &w3).unwrap_err(), ProofFailure::PreimageUnavailable);
    }

    #[test]
    fn storage_tree_not_held_at_the_leaf_root_is_unavailable() {
        let (r, view) = certified(50, |r| {
            let db = r.st.persistent.aux.db();
            let cf = db.cf_handle(CF_STOR_NODES).unwrap();
            db.delete_cf(&cf, stor_node_key(&StateMerkleTree::hash_address(TOKEN), ROOT_DEPTH, &[0u8; 32])).unwrap();
        });
        assert!(r.st.certified_account_proof(&view, TOKEN).is_ok(), "the contract leaf itself still proves");
        assert_eq!(r.st.certified_token_proof(&view, TOKEN, "eon_cr_h0001").unwrap_err(), ProofFailure::StorageUnavailable);
    }

    // Random proof traffic must not evict the consensus working set: proof reads add nothing to the
    // shared block cache, while the same rows read with default options do.
    #[test]
    fn proof_reads_do_not_fill_the_block_cache() {
        let (r, view) = certified(2_000, |_| {});
        let flush = |db: &DB, cfs: &[&str]| for name in cfs { db.flush_cf(db.cf_handle(name).unwrap()).unwrap(); };
        flush(&r.st.persistent.tree.db, &super::super::tree_db::TREE_CFS);
        flush(r.st.persistent.aux.db(), &super::super::aux_db::AUX_CFS);
        let cache = &r.st.persistent.block_cache;
        let before = cache.get_usage();
        for i in 0..2_000u64 {
            r.st.certified_account_proof(&view, &wallet(i, 0).address).expect("present");
            r.st.certified_account_proof(&view, &format!("eon_cr_absent_{}", i)).expect("absent");
        }
        for i in 0..40u64 {
            r.st.certified_token_proof(&view, TOKEN, &format!("eon_cr_h{:04}", i)).expect("holder");
        }
        let after = cache.get_usage();
        assert!(after <= before + 64 * 1024, "proof reads filled the block cache: {} -> {}", before, after);
        // The control: the same families read with default options do fill it.
        for (snap, cf) in [(&view.tree, super::super::tree_db::CF_ACCT_NODES), (&view.aux, CF_ACCT_PRE)] {
            let mut it = snap.raw_iterator_cf_opt(cf, rocksdb::ReadOptions::default()).unwrap();
            it.seek_to_first();
            while it.valid() { it.next(); }
        }
        assert!(cache.get_usage() > after + 64 * 1024, "control reads must fill the cache: {} -> {}", after, cache.get_usage());
    }
}

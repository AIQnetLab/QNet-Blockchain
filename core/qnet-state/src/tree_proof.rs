//! A read-only prover over any frozen tree view, and the verifiers a client mirrors.
//!
//! The prover walks the same compressed fold as `StateMerkleTree::generate_leaf_proof`, through a
//! reader that reports its own failures instead of reading them as absence. It never repairs or
//! guesses: a branch the node set should hold and does not is `Inconsistent`, not a default hash.
//! Every negative answer carries a proof: an empty bucket proves absence with the zero seed, and a
//! shared bucket proves it with all of the bucket's entries. A view whose rows under single buckets
//! may be left over from an earlier node set is proven with `StoredRows::Branches`.

use crate::leaf_preimage::AccountLeafPreimage;
use crate::state::{StateMerkleTree, BUCKET_DEPTH, PROOF_DEPTH, TREE_DEPTH};

/// Why a reader could not answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFault {
    /// The store failed the read.
    Io,
    /// A stored value has the wrong shape.
    Malformed,
}

/// A frozen view of one tree: point reads of stored nodes and ordered range reads of leaves.
pub trait TreeReader {
    /// The stored node at (depth, key); Ok(None) when the node set holds none there.
    fn node(&mut self, depth: u32, key: &[u8; 32]) -> Result<Option<[u8; 32]>, ReadFault>;
    /// Leaves with keys in the inclusive range [lo, hi], ascending, at most `limit`.
    fn leaves(&mut self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Result<Vec<([u8; 32], [u8; 32])>, ReadFault>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeafProofKind {
    /// The key holds this leaf.
    Inclusion([u8; 32]),
    /// The key's bucket is empty.
    Absence,
    /// The key's bucket holds these entries, sorted, and the key is not among them.
    AbsenceInBucket(Vec<([u8; 32], [u8; 32])>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafProof {
    pub kind: LeafProofKind,
    /// The in-bucket path (inclusion only), then exactly PROOF_DEPTH tree steps.
    pub steps: Vec<([u8; 32], bool)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProveError {
    Read(ReadFault),
    /// The view holds a branch without its stored node: the node set lost a row it must hold.
    Inconsistent,
    /// A bucket larger than the prover reads or an absence answer carries.
    BucketOversize(usize),
}

impl From<ReadFault> for ProveError {
    fn from(f: ReadFault) -> Self { ProveError::Read(f) }
}

/// Entries one bucket read may return before the prover refuses the bucket.
pub const PROOF_BUCKET_READ_CAP: usize = 4096;
/// Entries an absence-in-bucket answer may carry: the verifier's bucket-path bound.
pub const ABSENCE_BUCKET_ENTRIES_MAX: usize = 64;

enum Span {
    Empty,
    Single([u8; 32], [u8; 32]),
    Branch,
}

/// How far a view's stored node rows can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredRows {
    /// Every stored row is current: the account tree, whose store follows the tree exactly.
    Exact,
    /// Rows at branch positions are current, but a row under a single bucket may be left over from
    /// an earlier node set: a mirrored contract tree re-installed from a fresh build keeps rows its
    /// previous lineage stored and the fresh build does not. Those hashes are derived from leaves.
    Branches,
}

/// Proof for `key` in a tree whose stored rows are all current (the account tree).
pub fn prove_leaf<R: TreeReader>(r: &mut R, key: &[u8; 32]) -> Result<LeafProof, ProveError> {
    prove_leaf_in(r, key, StoredRows::Exact)
}

/// Proof for `key` in the tree the reader views, trusting its stored rows as `rows` says.
pub fn prove_leaf_in<R: TreeReader>(r: &mut R, key: &[u8; 32], rows: StoredRows) -> Result<LeafProof, ProveError> {
    let bucket = StateMerkleTree::bucket_of(key);
    let entries = bucket_entries(r, &bucket)?;
    let mut steps: Vec<([u8; 32], bool)> = Vec::with_capacity(PROOF_DEPTH + 8);
    let kind = match entries.iter().position(|(k, _)| k == key) {
        Some(found) => {
            bucket_path(&entries, found, &mut steps);
            LeafProofKind::Inclusion(entries[found].1)
        }
        None if entries.is_empty() => LeafProofKind::Absence,
        None if entries.len() <= ABSENCE_BUCKET_ENTRIES_MAX => LeafProofKind::AbsenceInBucket(entries),
        None => return Err(ProveError::BucketOversize(entries.len())),
    };
    let defaults = StateMerkleTree::default_hashes();
    // Below `ffd` every sibling is provably empty, so the walk reads nothing there.
    let ffd = first_foreign_depth(r, key)?;
    let mut node_key = bucket;
    for depth in BUCKET_DEPTH..TREE_DEPTH {
        let mut sibling_key = node_key;
        StateMerkleTree::flip_bit(&mut sibling_key, depth);
        let sibling = if depth + 1 < ffd { defaults[depth] } else { resolve(r, depth, &sibling_key, rows)? };
        steps.push((sibling, StateMerkleTree::get_bit(key, depth)));
        StateMerkleTree::clear_bit(&mut node_key, depth);
    }
    Ok(LeafProof { kind, steps })
}

/// Verify one proof of `key` against `root`. Each kind is checked exactly; nothing defaults.
pub fn verify_leaf(key: &[u8; 32], kind: &LeafProofKind, steps: &[([u8; 32], bool)], root: &[u8; 32]) -> bool {
    match kind {
        // A real leaf is never zero; the zero value is the absence seed and has its own kind.
        LeafProofKind::Inclusion(leaf) => *leaf != [0u8; 32] && StateMerkleTree::verify_leaf_proof(key, *leaf, steps, root),
        LeafProofKind::Absence => steps.len() == PROOF_DEPTH && StateMerkleTree::verify_leaf_proof(key, [0u8; 32], steps, root),
        LeafProofKind::AbsenceInBucket(entries) => verify_absence_in_bucket(key, entries, steps, root),
    }
}

/// An account proof: `preimage` Some proves the account holds exactly these fields, None proves it
/// does not exist.
pub fn verify_account_proof(
    address: &str,
    preimage: Option<&AccountLeafPreimage>,
    kind: &LeafProofKind,
    steps: &[([u8; 32], bool)],
    root: &[u8; 32],
) -> bool {
    let key = StateMerkleTree::hash_address(address);
    match (preimage, kind) {
        (Some(p), LeafProofKind::Inclusion(leaf)) => p.leaf_hash(address) == *leaf && verify_leaf(&key, kind, steps, root),
        (None, LeafProofKind::Absence) | (None, LeafProofKind::AbsenceInBucket(_)) => verify_leaf(&key, kind, steps, root),
        _ => false,
    }
}

/// A contract-storage proof: `value` Some proves the key holds this raw value, None proves the key
/// is not stored.
pub fn verify_storage_proof(
    key_preimage: &str,
    value: Option<&str>,
    kind: &LeafProofKind,
    steps: &[([u8; 32], bool)],
    root: &[u8; 32],
) -> bool {
    let key = StateMerkleTree::hash_storage_key(key_preimage);
    match (value, kind) {
        (Some(v), LeafProofKind::Inclusion(leaf)) =>
            StateMerkleTree::storage_leaf_value(v) == *leaf && verify_leaf(&key, kind, steps, root),
        (None, LeafProofKind::Absence) | (None, LeafProofKind::AbsenceInBucket(_)) => verify_leaf(&key, kind, steps, root),
        _ => false,
    }
}

fn verify_absence_in_bucket(
    key: &[u8; 32],
    entries: &[([u8; 32], [u8; 32])],
    steps: &[([u8; 32], bool)],
    root: &[u8; 32],
) -> bool {
    if steps.len() != PROOF_DEPTH || entries.is_empty() || entries.len() > ABSENCE_BUCKET_ENTRIES_MAX {
        return false;
    }
    let bucket = StateMerkleTree::bucket_of(key);
    let mut prev: Option<&[u8; 32]> = None;
    for (k, v) in entries {
        if StateMerkleTree::bucket_of(k) != bucket || k == key || *v == [0u8; 32] {
            return false;
        }
        if prev.map_or(false, |p| k <= p) {
            return false;
        }
        prev = Some(k);
    }
    let seed = StateMerkleTree::bucket_fold(entries.iter().map(|(k, v)| StateMerkleTree::bucket_leaf(k, v)).collect());
    fold_tree_steps(key, seed, steps) == *root
}

/// The PROOF_DEPTH tree steps from a bucket hash to the root, with flags bound to the key's bits.
fn fold_tree_steps(key: &[u8; 32], seed: [u8; 32], steps: &[([u8; 32], bool)]) -> [u8; 32] {
    use sha3::{Digest, Sha3_256};
    let mut current = seed;
    let mut buffer = [0u8; 64];
    for (i, (sibling, is_right)) in steps.iter().enumerate() {
        let depth = BUCKET_DEPTH + i;
        if *is_right != StateMerkleTree::get_bit(key, depth) {
            return [0u8; 32];
        }
        if *is_right {
            buffer[..32].copy_from_slice(sibling);
            buffer[32..].copy_from_slice(&current);
        } else {
            buffer[..32].copy_from_slice(&current);
            buffer[32..].copy_from_slice(sibling);
        }
        current.copy_from_slice(&Sha3_256::digest(&buffer));
    }
    current
}

/// The in-bucket mini-merkle path of entry `idx`, positional flags, exactly as the live prover.
fn bucket_path(entries: &[([u8; 32], [u8; 32])], mut idx: usize, steps: &mut Vec<([u8; 32], bool)>) {
    use sha3::{Digest, Sha3_256};
    let mut level: Vec<[u8; 32]> = entries.iter().map(|(k, v)| StateMerkleTree::bucket_leaf(k, v)).collect();
    while level.len() > 1 {
        let sib = idx ^ 1;
        if sib < level.len() {
            steps.push((level[sib], idx & 1 == 1));
        }
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut buffer = [0u8; 64];
        for pair in level.chunks(2) {
            if pair.len() == 2 {
                buffer[..32].copy_from_slice(&pair[0]);
                buffer[32..].copy_from_slice(&pair[1]);
                let mut h = [0u8; 32];
                h.copy_from_slice(&Sha3_256::digest(&buffer));
                next.push(h);
            } else {
                next.push(pair[0]);
            }
        }
        level = next;
        idx /= 2;
    }
}

fn bucket_entries<R: TreeReader>(r: &mut R, bucket: &[u8; 32]) -> Result<Vec<([u8; 32], [u8; 32])>, ProveError> {
    let (lo, hi) = StateMerkleTree::subtree_bounds(BUCKET_DEPTH, bucket);
    let entries = r.leaves(&lo, &hi, PROOF_BUCKET_READ_CAP + 1)?;
    if entries.len() > PROOF_BUCKET_READ_CAP {
        return Err(ProveError::BucketOversize(entries.len()));
    }
    Ok(entries)
}

fn bucket_hash<R: TreeReader>(r: &mut R, bucket: &[u8; 32]) -> Result<[u8; 32], ProveError> {
    let entries = bucket_entries(r, bucket)?;
    if entries.is_empty() {
        return Ok(StateMerkleTree::default_hashes()[BUCKET_DEPTH]);
    }
    Ok(StateMerkleTree::bucket_fold(entries.iter().map(|(k, v)| StateMerkleTree::bucket_leaf(k, v)).collect()))
}

fn first_leaf<R: TreeReader>(r: &mut R, lo: &[u8; 32], hi: &[u8; 32]) -> Result<Option<[u8; 32]>, ProveError> {
    Ok(r.leaves(lo, hi, 1)?.first().map(|(k, _)| *k))
}

/// Mirror of the live `subtree_probe`: empty, exactly one bucket, or two or more buckets.
fn probe<R: TreeReader>(r: &mut R, depth: usize, key: &[u8; 32]) -> Result<Span, ProveError> {
    let (lo, hi) = StateMerkleTree::subtree_bounds(depth, key);
    let first = match first_leaf(r, &lo, &hi)? {
        None => return Ok(Span::Empty),
        Some(k) => k,
    };
    let bucket = StateMerkleTree::bucket_of(&first);
    let (_, bucket_hi) = StateMerkleTree::subtree_bounds(BUCKET_DEPTH, &bucket);
    if bucket_hi < hi {
        let mut next_lo = bucket_hi;
        for i in (0..32).rev() {
            let (v, carry) = next_lo[i].overflowing_add(1);
            next_lo[i] = v;
            if !carry { break; }
        }
        if first_leaf(r, &next_lo, &hi)?.is_some() {
            return Ok(Span::Branch);
        }
    }
    Ok(Span::Single(bucket, bucket_hash(r, &bucket)?))
}

/// Mirror of the live `first_foreign_depth`.
fn first_foreign_depth<R: TreeReader>(r: &mut R, key: &[u8; 32]) -> Result<usize, ProveError> {
    let own = StateMerkleTree::bucket_of(key);
    let foreign = |span: Span| match span {
        Span::Empty => false,
        Span::Single(b, _) => b != own,
        Span::Branch => true,
    };
    if !foreign(probe(r, TREE_DEPTH, key)?) {
        return Ok(TREE_DEPTH + 1);
    }
    let (mut lo, mut hi) = (BUCKET_DEPTH, TREE_DEPTH);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if foreign(probe(r, mid, key)?) { hi = mid; } else { lo = mid + 1; }
    }
    Ok(lo)
}

/// Mirror of the live `node_resolve`, read-only: a missing branch is an error, never a guess.
/// Under `StoredRows::Branches` the leaves classify the subtree first and a stored row is read only
/// for a branch, the one place a current row is guaranteed.
fn resolve<R: TreeReader>(r: &mut R, depth: usize, key: &[u8; 32], rows: StoredRows) -> Result<[u8; 32], ProveError> {
    if depth <= BUCKET_DEPTH {
        return bucket_hash(r, &StateMerkleTree::bucket_of(key));
    }
    if rows == StoredRows::Exact {
        if let Some(v) = r.node(depth as u32, key)? {
            return Ok(v);
        }
    }
    match probe(r, depth, key)? {
        Span::Empty => Ok(StateMerkleTree::default_hashes()[depth]),
        Span::Single(b, bh) => Ok(StateMerkleTree::lonely_chain_hash_over(StateMerkleTree::default_hashes(), &b, bh, depth)),
        Span::Branch if rows == StoredRows::Branches => r.node(depth as u32, key)?.ok_or(ProveError::Inconsistent),
        Span::Branch => Err(ProveError::Inconsistent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MerkleNodeStore;
    use crate::Account;
    use std::collections::{BTreeMap, HashMap};
    use std::sync::Arc;

    /// A reader over a store the live tree flushed into.
    struct StoreReader<'a>(&'a dyn MerkleNodeStore);
    impl TreeReader for StoreReader<'_> {
        fn node(&mut self, depth: u32, key: &[u8; 32]) -> Result<Option<[u8; 32]>, ReadFault> {
            Ok(self.0.get_node(depth, key))
        }
        fn leaves(&mut self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Result<Vec<([u8; 32], [u8; 32])>, ReadFault> {
            Ok(self.0.leaves_under(lo, hi, limit))
        }
    }

    /// A reader over plain maps, for hand-built views.
    #[derive(Default, Clone)]
    struct MapReader {
        leaves: BTreeMap<[u8; 32], [u8; 32]>,
        nodes: HashMap<(u32, [u8; 32]), [u8; 32]>,
        hidden: Option<(u32, [u8; 32])>,
        fail_leaves: bool,
    }
    impl TreeReader for MapReader {
        fn node(&mut self, depth: u32, key: &[u8; 32]) -> Result<Option<[u8; 32]>, ReadFault> {
            if self.hidden == Some((depth, *key)) { return Ok(None); }
            Ok(self.nodes.get(&(depth, *key)).copied())
        }
        fn leaves(&mut self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Result<Vec<([u8; 32], [u8; 32])>, ReadFault> {
            if self.fail_leaves { return Err(ReadFault::Io); }
            Ok(self.leaves.range(*lo..=*hi).take(limit).map(|(k, v)| (*k, *v)).collect())
        }
    }

    fn account(i: u64) -> Account {
        let mut a = Account::new(format!("eon_tp_{:06}", i));
        a.balance = 1_000 + i * 7;
        a.nonce = i % 13;
        a
    }

    /// The live tree over `n` accounts, plus the same view as plain maps.
    fn built(n: u64) -> (StateMerkleTree, MapReader, Vec<Account>) {
        let accts: Vec<Account> = (0..n).map(account).collect();
        let mut t = StateMerkleTree::new();
        for a in &accts { t.insert_lazy(&a.address, a); }
        t.finalize();
        let reader = MapReader {
            leaves: t.leaves.clone(),
            nodes: t.intermediate_nodes.clone(),
            ..Default::default()
        };
        (t, reader, accts)
    }

    /// A key sharing `of`'s bucket but not equal to it.
    fn co_bucket(of: &[u8; 32]) -> [u8; 32] {
        let mut k = *of;
        k[31] ^= 0x01;
        k
    }

    #[test]
    fn prover_matches_live_generate_proof() {
        // Store-backed live tree with a small cache cap, as a super node runs it at scale.
        let store = Arc::new(crate::state::tests_support::MapNodeStore::default());
        let mut t = StateMerkleTree::new();
        t.set_node_store(store.clone());
        t.set_node_cache_cap(1_000);
        let accts: Vec<Account> = (0..10_000u64).map(account).collect();
        for chunk in accts.chunks(2_500) {
            for a in chunk { t.insert_lazy(&a.address, a); }
            t.finalize();
        }
        t.flush_barrier();
        let root = t.root();
        let mut reader = StoreReader(store.as_ref());
        for a in accts.iter().step_by(20) {
            let key = StateMerkleTree::hash_address(&a.address);
            let live = t.generate_proof(&a.address);
            let p = prove_leaf(&mut reader, &key).expect("proves");
            assert_eq!(p.steps, live, "identical steps for a present key");
            assert_eq!(p.kind, LeafProofKind::Inclusion(StateMerkleTree::hash_account(a)));
            assert!(verify_leaf(&key, &p.kind, &p.steps, &root));
            let pre = AccountLeafPreimage::of(a);
            assert!(verify_account_proof(&a.address, Some(&pre), &p.kind, &p.steps, &root));
        }
        for i in 0..200u64 {
            let addr = format!("eon_absent_{}", i);
            let key = StateMerkleTree::hash_address(&addr);
            let p = prove_leaf(&mut reader, &key).expect("proves");
            assert_eq!(p.kind, LeafProofKind::Absence, "an empty bucket");
            assert_eq!(p.steps, t.generate_proof(&addr), "identical steps for an absent key");
            assert!(verify_account_proof(&addr, None, &p.kind, &p.steps, &root));
        }
        for a in accts.iter().step_by(97) {
            let member = StateMerkleTree::hash_address(&a.address);
            let key = co_bucket(&member);
            let p = prove_leaf(&mut reader, &key).expect("proves");
            match &p.kind {
                LeafProofKind::AbsenceInBucket(entries) => assert!(entries.iter().any(|(k, _)| *k == member)),
                other => panic!("expected absence in bucket, got {:?}", other),
            }
            let member_steps = t.generate_proof(&a.address);
            assert_eq!(p.steps[..], member_steps[member_steps.len() - PROOF_DEPTH..], "the co-member's tree steps");
            assert!(verify_leaf(&key, &p.kind, &p.steps, &root));
        }
    }

    #[test]
    fn prover_refuses_a_missing_branch() {
        let (_t, mut reader, accts) = built(512);
        let key = StateMerkleTree::hash_address(&accts[0].address);
        // The sibling at the top level covers half the keyspace: a branch, always stored.
        let mut sib = StateMerkleTree::bucket_of(&key);
        for d in BUCKET_DEPTH..TREE_DEPTH - 1 { StateMerkleTree::clear_bit(&mut sib, d); }
        StateMerkleTree::flip_bit(&mut sib, TREE_DEPTH - 1);
        assert!(reader.nodes.contains_key(&((TREE_DEPTH - 1) as u32, sib)), "the branch row exists");
        reader.hidden = Some(((TREE_DEPTH - 1) as u32, sib));
        assert_eq!(prove_leaf(&mut reader, &key), Err(ProveError::Inconsistent));
    }

    // A row left over under a single bucket misleads a prover that trusts every row; the branches
    // mode derives that hash from the leaves and still proves.
    #[test]
    fn branches_mode_ignores_a_stale_chain_row() {
        let (t, mut reader, accts) = built(512);
        let root = t.root_unchecked();
        let mut found = None;
        for a in &accts {
            let key = StateMerkleTree::hash_address(&a.address);
            let ffd = first_foreign_depth(&mut reader, &key).unwrap();
            if ffd <= BUCKET_DEPTH + 1 || ffd > TREE_DEPTH { continue; }
            let d = ffd - 1;
            let mut sib = StateMerkleTree::bucket_of(&key);
            for x in BUCKET_DEPTH..d { StateMerkleTree::clear_bit(&mut sib, x); }
            StateMerkleTree::flip_bit(&mut sib, d);
            if matches!(probe(&mut reader, d, &sib).unwrap(), Span::Single(..)) {
                found = Some((key, d, sib));
                break;
            }
        }
        let (key, d, sib) = found.expect("a single-bucket sibling on some path");
        reader.nodes.insert((d as u32, sib), [0xAB; 32]);
        let exact = prove_leaf(&mut reader, &key).expect("proves");
        assert!(!verify_leaf(&key, &exact.kind, &exact.steps, &root), "trusting the stale row breaks the fold");
        let branches = prove_leaf_in(&mut reader, &key, StoredRows::Branches).expect("proves");
        assert!(verify_leaf(&key, &branches.kind, &branches.steps, &root), "the leaves give the current hash");
    }

    #[test]
    fn prover_propagates_read_faults() {
        let (_t, mut reader, accts) = built(64);
        reader.fail_leaves = true;
        let key = StateMerkleTree::hash_address(&accts[3].address);
        assert_eq!(prove_leaf(&mut reader, &key), Err(ProveError::Read(ReadFault::Io)));
    }

    #[test]
    fn absence_in_bucket_verifier_rejects_forgeries() {
        let (t, mut reader, accts) = built(256);
        let root = t.root_unchecked();
        let member = StateMerkleTree::hash_address(&accts[5].address);
        // A crowded bucket: three foreign members around the asked key.
        for j in 0..3u8 {
            let mut k = member;
            k[30] ^= 0x10 + j;
            reader.leaves.insert(k, [0x40 + j; 32]);
        }
        let mut crowded = StateMerkleTree::new();
        for (k, v) in &reader.leaves { crowded.leaves.insert(*k, *v); }
        crowded.dirty = true;
        let root2 = crowded.finalize();
        assert_ne!(root, root2);
        let reader2 = MapReader { leaves: crowded.leaves.clone(), nodes: crowded.intermediate_nodes.clone(), ..Default::default() };
        let key = co_bucket(&member);
        let p = prove_leaf(&mut reader2.clone(), &key).expect("proves");
        let entries = match &p.kind { LeafProofKind::AbsenceInBucket(e) => e.clone(), k => panic!("{:?}", k) };
        assert!(entries.len() >= 2);
        assert!(verify_leaf(&key, &p.kind, &p.steps, &root2), "the honest answer verifies");

        let forged = |e: Vec<([u8; 32], [u8; 32])>, s: &[([u8; 32], bool)]| verify_leaf(&key, &LeafProofKind::AbsenceInBucket(e), s, &root2);
        let mut with_key = entries.clone();
        with_key.push((key, [1u8; 32]));
        with_key.sort();
        assert!(!forged(with_key, &p.steps), "the key among the entries");
        let mut unsorted = entries.clone();
        unsorted.swap(0, 1);
        assert!(!forged(unsorted, &p.steps), "unsorted entries");
        let mut outside = entries.clone();
        outside[0].0[0] ^= 0x80;
        outside.sort();
        assert!(!forged(outside, &p.steps), "an entry outside the bucket");
        assert!(!forged(entries[1..].to_vec(), &p.steps), "a dropped entry");
        let mut zero = entries.clone();
        zero[0].1 = [0u8; 32];
        assert!(!forged(zero, &p.steps), "a zero leaf");
        let many: Vec<([u8; 32], [u8; 32])> = (0..65u8).map(|i| { let mut k = member; k[31] = i; k[30] = 0xEE; (k, [1u8; 32]) }).collect();
        assert!(!forged(many, &p.steps), "65 entries");
        assert!(!forged(entries.clone(), &p.steps[1..]), "39 steps");
        let mut longer = p.steps.clone();
        longer.push(([0u8; 32], false));
        assert!(!forged(entries.clone(), &longer), "41 steps");
        assert!(!verify_leaf(&key, &LeafProofKind::Absence, &p.steps, &root2), "plain absence over a crowded bucket");
        assert!(!verify_leaf(&key, &LeafProofKind::Inclusion([0u8; 32]), &p.steps, &root2), "a zero inclusion leaf");
    }

    fn hex32(b: &[u8; 32]) -> String { hex::encode(b) }

    /// Fixed inputs, fixed outputs: the client verifiers assert the same hex.
    #[test]
    fn golden_vectors_for_clients() {
        let mut plain = Account::new("eon_golden_plain".to_string());
        plain.balance = 5_000_000_000;
        plain.nonce = 3;
        plain.heartbeat_epoch = 12;
        plain.heartbeat_slots = 0x01FF;
        plain.last_claimed_epoch = 10;
        let mut contract = Account::new("eon_golden_contract".to_string());
        contract.is_contract = true;
        contract.contract_code_hash = Some("c0de".repeat(16));
        contract.contract_storage.insert("balance:eon_golden_plain".to_string(), "250".to_string());
        contract.contract_storage.insert("total_supply".to_string(), "1000".to_string());
        contract.storage_root = StateMerkleTree::compute_storage_root(&contract.contract_storage);
        let plain_leaf = StateMerkleTree::hash_account(&plain);
        let contract_leaf = StateMerkleTree::hash_account(&contract);
        let storage_leaf = StateMerkleTree::storage_leaf_value("250");

        let mut t = StateMerkleTree::new();
        t.insert_lazy(&plain.address, &plain);
        t.insert_lazy(&contract.address, &contract);
        let root = t.finalize();
        let mut reader = MapReader { leaves: t.leaves.clone(), nodes: t.intermediate_nodes.clone(), ..Default::default() };
        let inc = prove_leaf(&mut reader, &StateMerkleTree::hash_address(&plain.address)).unwrap();
        assert!(verify_account_proof(&plain.address, Some(&AccountLeafPreimage::of(&plain)), &inc.kind, &inc.steps, &root));
        let abs = prove_leaf(&mut reader, &StateMerkleTree::hash_address("eon_golden_absent")).unwrap();
        assert_eq!(abs.kind, LeafProofKind::Absence);
        assert!(verify_account_proof("eon_golden_absent", None, &abs.kind, &abs.steps, &root));
        // Absence inside a shared bucket: a raw key next to the plain account's.
        let shared = co_bucket(&StateMerkleTree::hash_address(&plain.address));
        let aib = prove_leaf(&mut reader, &shared).unwrap();
        assert!(matches!(aib.kind, LeafProofKind::AbsenceInBucket(_)));
        assert!(verify_leaf(&shared, &aib.kind, &aib.steps, &root));
        let step_digest = |s: &[([u8; 32], bool)]| {
            use sha3::{Digest, Sha3_256};
            let mut h = Sha3_256::new();
            for (sib, right) in s { h.update(sib); h.update([*right as u8]); }
            let mut out = [0u8; 32];
            out.copy_from_slice(&h.finalize());
            out
        };
        let got = [
            ("plain_leaf", hex32(&plain_leaf)),
            ("plain_bucket_leaf", hex32(&StateMerkleTree::bucket_leaf(&StateMerkleTree::hash_address(&plain.address), &plain_leaf))),
            ("contract_leaf", hex32(&contract_leaf)),
            ("storage_leaf", hex32(&storage_leaf)),
            ("root", hex32(&root)),
            ("inclusion_steps", hex32(&step_digest(&inc.steps))),
            ("absence_steps", hex32(&step_digest(&abs.steps))),
            ("absence_in_bucket_steps", hex32(&step_digest(&aib.steps))),
        ];
        let moved: Vec<&str> = got.iter().zip(GOLDEN.iter())
            .filter(|((name, hex), (wname, whex))| name != wname || hex != whex)
            .map(|((name, _), _)| *name)
            .collect();
        assert!(moved.is_empty(), "golden vectors moved {:?}; computed {:?}", moved, got);
    }

    /// The absence-in-bucket steps equal the inclusion steps: the plain account sits alone in its
    /// bucket, so its proof is the 40 tree steps its co-bucket key shares.
    const GOLDEN: [(&str, &str); 8] = [
        ("plain_leaf", "47f4cd00ad826f7c9691e514a4fed334c47500ac6ef6348f940e870aab861143"),
        ("plain_bucket_leaf", "741dc4bca2f11ef5ea8876fafba04a4dacde276fdd09e20bcdf241feb8dde1c8"),
        ("contract_leaf", "91853f19011f659eb002d4607613af2de14f0eff5a76cdec958e1d767096ebfd"),
        ("storage_leaf", "c6865e0b2be779fead42ae16e784ef8e8aa35faf3f73a8d759ae43adbb97c126"),
        ("root", "466262ba15c449ca1c068c5ecf5a003ca64dba74a9e079787ac869531fba149b"),
        ("inclusion_steps", "b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947"),
        ("absence_steps", "f0870bc01ff5aa768bd7cfda24cbae6bd995a47e55c8656ff23db36b1133a8f1"),
        ("absence_in_bucket_steps", "b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947"),
    ];
}

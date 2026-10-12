//! Genesis-Anchored Live Checkpoint (GALC): a live, genesis-multisigned weak-subjectivity pin.
//!
//! Genesis nodes periodically sign (mb_index, mb_hash, committee_digest_anchor, committee_digest_pred)
//! of a finalized macroblock and gossip the partial; any super node aggregates >=2f+1 partials into a
//! self-authenticating capsule and relays it. A cold joiner verifies the capsule against the EMBEDDED
//! genesis public keys (the same binary trust root as the WS pin) and uses it as the lineage-walk ROOT
//! — bounding the walk to a few macroblocks at ANY chain age, no manual per-release pin rotation. The
//! bulk snapshot/block data still comes distributed from all super nodes; the capsule is a tiny self-
//! authenticating control object. Fail-closed: an unverified/absent capsule degrades to the binary pin,
//! leaving the warm/genesis path bit-for-bit inert.
//!
//! The capsule carries TWO per-macroblock committee digests — committee_fields_digest(K) (anchor) and
//! committee_fields_digest(K-1) (predecessor) — because MacroBlock::hash() excludes consensus_data, and
//! BOTH K and K-1 feed the forward N-2 committee derivation. Checking each at its own pin branch lets a
//! hash-trusted macroblock be accepted ONLY with consensus_data that matches the genesis-signed digest,
//! through ANY ingress path, with no K<->K-1 store-order deadlock.

use std::sync::atomic::{AtomicU64, Ordering};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use std::collections::HashMap;

pub const GALC_VERSION: u16 = 1;
const DOMAIN: &[u8] = b"QNET_GENESIS_CHECKPOINT_v1";
const MI: u64 = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;

/// Macroblocks per state snapshot (= node::SNAPSHOT_INCREMENTAL_INTERVAL / 90). The compile-assert pins
/// the two cadences together so they can never drift.
pub const SNAPSHOT_INCREMENTAL_INTERVAL_MB: u64 = 40;
const _: () = assert!(SNAPSHOT_INCREMENTAL_INTERVAL_MB * 90 == crate::node::SNAPSHOT_INCREMENTAL_INTERVAL);

/// Cadence (in macroblocks) at which genesis nodes mint a capsule for the latest FINALIZED macroblock.
/// DERIVED from the snapshot cadence so every capsule co-locates with a state-snapshot anchor ⇒ a cold
/// joiner's snapshot anchor == the capsule root (lineage walk ≈ 0). Deterministic K = (finalized_mb /
/// GALC_MINT_INTERVAL) * GALC_MINT_INTERVAL ⇒ all genesis sign the SAME (K, hash, digests) and aggregate.
pub const GALC_MINT_INTERVAL: u64 = SNAPSHOT_INCREMENTAL_INTERVAL_MB;

/// Self-authenticating genesis-signed weak-subjectivity checkpoint. `mb_hash` = MacroBlock::hash()@K
/// (body only). `committee_digest_anchor/pred` = committee_fields_digest of K and K-1 respectively,
/// binding the consensus_data committee inputs (eligible_producers + randomness_beacon) the body hash
/// omits. `sigs` = >=2f+1 distinct (genesis_id, sig) over the preimage.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GenesisCheckpoint {
    pub version: u16,
    pub network_id: [u8; 32],
    pub mb_index: u64,
    pub mb_hash: [u8; 32],
    pub committee_digest_anchor: [u8; 32],
    pub committee_digest_pred: [u8; 32],
    pub minted_at_height: u64,
    pub sigs: Vec<(String, String)>,
}

/// Canonical signed message (a domain-tagged hex string — the consensus signer/verifier work over
/// `&str`). `minted_at_height` is bound for integrity but is NOT a security input (freshness comes
/// from the walk bound + monotonic adoption, never from this self-reported field).
pub fn preimage(
    version: u16, network_id: &[u8; 32], mb_index: u64, mb_hash: &[u8; 32],
    digest_anchor: &[u8; 32], digest_pred: &[u8; 32], minted_at_height: u64,
) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        std::str::from_utf8(DOMAIN).unwrap_or("QNET_GENESIS_CHECKPOINT_v1"),
        version, hex::encode(network_id), mb_index, hex::encode(mb_hash),
        hex::encode(digest_anchor), hex::encode(digest_pred), minted_at_height,
    )
}

/// Deterministic SHA3-256 over ONE macroblock's committee-critical body fields — eligible_producers,
/// randomness_beacon, consensus_committee and banned_validators. Present/absent flags on EVERY field so
/// None and empty-Vec never collide. The WS pin / capsule carry this for K and K-1; the hash-trust
/// branch checks the served macroblock against it, closing the forged-body forge (MacroBlock::hash()
/// omits consensus_data entirely).
///
/// v2 adds the last two fields. `consensus_committee` is now the signature-checking set for a relaxed
/// checkpoint anchored on this macroblock, and `banned_validators` is already trusted verbatim by
/// load_macroblock_ban_set — at the two pin branches both were unauthenticated. Zero migration cost:
/// the binary pin is (0,[0;32]) with zero digests at fresh genesis and capsules re-mint hourly.
pub fn committee_fields_digest(mb: &qnet_state::MacroBlock) -> [u8; 32] {
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(b"QNET_COMMITTEE_FIELDS_v2");
    match mb.consensus_data.eligible_producers.as_deref() {
        Some(elig) => { h.update([1u8]); h.update((elig.len() as u32).to_le_bytes()); h.update(elig); }
        None => { h.update([0u8]); }
    }
    match mb.consensus_data.randomness_beacon {
        Some(b) => { h.update([1u8]); h.update(b); }
        None => { h.update([0u8]); }
    }
    match mb.consensus_data.consensus_committee.as_deref() {
        Some(cmt) => {
            h.update([1u8]);
            h.update((cmt.len() as u32).to_le_bytes());
            for id in cmt { h.update((id.len() as u32).to_le_bytes()); h.update(id.as_bytes()); }
        }
        None => { h.update([0u8]); }
    }
    match mb.consensus_data.banned_validators.as_deref() {
        Some(b) => { h.update([1u8]); h.update((b.len() as u32).to_le_bytes()); h.update(b); }
        None => { h.update([0u8]); }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

// Adopted GALC root (monotonic by index). 0 ⇒ none held ⇒ the binary pin governs. The root is 13 words
// (index + hash + 2 digests) published as ONE unit: ADOPT_LOCK serializes writers (no torn/regressed
// publish; the monotonic guard is race-free under it) and GALC_SEQ is a seqlock so a reader never observes
// an index from one capsule with a hash from another.
pub static GALC_MB: AtomicU64 = AtomicU64::new(0);
static GALC_HASH: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
static GALC_DIGEST_ANCHOR: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
static GALC_DIGEST_PRED: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
static GALC_SEQ: AtomicU64 = AtomicU64::new(0);                 // seqlock generation: even=stable, odd=writing
static ADOPT_LOCK: Lazy<parking_lot::Mutex<()>> = Lazy::new(|| parking_lot::Mutex::new(()));

fn store32(slot: &[AtomicU64; 4], h: &[u8; 32]) {
    for i in 0..4 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&h[i * 8..i * 8 + 8]);
        slot[i].store(u64::from_le_bytes(b), Ordering::SeqCst);
    }
}
fn load32(slot: &[AtomicU64; 4]) -> [u8; 32] {
    let mut h = [0u8; 32];
    for i in 0..4 {
        h[i * 8..i * 8 + 8].copy_from_slice(&slot[i].load(Ordering::SeqCst).to_le_bytes());
    }
    h
}

/// Effective hash-trust ROOT = max-by-index of the binary WS pin (+ its committee digests) and the
/// adopted GALC root. Returns (index, mb_hash, digest_anchor[K], digest_pred[K-1]). verify_v2_macroblock's
/// hash-trust branch roots in THIS, so a fresh capsule shortens the walk; with no capsule it is bit-
/// identical to the binary pin (warm/genesis inert). SEPARATE from effective_ws_checkpoint() (the
/// finality floor) — a capsule never advances finality.
pub fn effective_pin_checkpoint() -> (u64, [u8; 32], [u8; 32], [u8; 32]) {
    let (bi, bh) = crate::genesis_constants::ws_checkpoint();
    let (bda, bdp) = crate::genesis_constants::ws_checkpoint_committee_digests();
    // Seqlock read: retry while a writer is mid-publish (odd seq) or the seq changed across the read, so the
    // (index, hash, digests) tuple is always from ONE capsule — never torn across two vintages.
    loop {
        let s1 = GALC_SEQ.load(Ordering::Acquire);
        if s1 & 1 != 0 { std::hint::spin_loop(); continue; }
        let gi = GALC_MB.load(Ordering::SeqCst);
        let (gh, ga, gp) = (load32(&GALC_HASH), load32(&GALC_DIGEST_ANCHOR), load32(&GALC_DIGEST_PRED));
        if GALC_SEQ.load(Ordering::Acquire) != s1 { std::hint::spin_loop(); continue; }
        return if gi > bi { (gi, gh, ga, gp) } else { (bi, bh, bda, bdp) };
    }
}

/// Local network identity = genesis block (height 0) hash. Deterministic across honest nodes; binds a
/// capsule to THIS chain (anti cross-network/relaunch replay). None before block 0 is held.
pub fn local_network_id(storage: &crate::storage::Storage) -> Option<[u8; 32]> {
    storage.genesis_anchor() // durable: outlives the body, the tx rows AND the height->hash alias
}

/// Cheap pre-checks (no post-quantum opens): version (fail-closed on unknown), network_id, index ≥ 2
/// (needs a predecessor for the committee binding), and a sane signer count. DoS guard before any
/// Dilithium verify AND before any task spawn on the receive path.
pub fn pre_check(c: &GenesisCheckpoint, expected_network_id: &[u8; 32]) -> bool {
    if c.version != GALC_VERSION { return false; }
    if &c.network_id != expected_network_id { return false; }
    if c.mb_index < 2 { return false; }
    let n = crate::genesis_constants::genesis_node_count();
    let need = qnet_consensus::checkpoint_bft::quorum_size(n);
    c.sigs.len() >= need && c.sigs.len() <= n
}

/// Verify a capsule: pre-checks, then >=2f+1 DISTINCT valid signatures from the EMBEDDED genesis keys
/// over the preimage (never peer-supplied keys — the permanent trust root). Returns true iff trusted.
pub async fn verify_capsule(c: &GenesisCheckpoint, expected_network_id: &[u8; 32]) -> bool {
    if !pre_check(c, expected_network_id) { return false; }
    let need = qnet_consensus::checkpoint_bft::quorum_size(crate::genesis_constants::genesis_node_count());
    let pre = preimage(c.version, &c.network_id, c.mb_index, &c.mb_hash,
        &c.committee_digest_anchor, &c.committee_digest_pred, c.minted_at_height);
    let mut valid: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (gid, sig) in &c.sigs {
        if valid.contains(gid) { continue; }                              // distinct only
        if !crate::genesis_constants::is_legacy_genesis_node(gid) { continue; } // genesis signers only
        let pk = match crate::genesis_constants::get_genesis_anchor_pk(gid) { Some(p) => p, None => continue };
        if qnet_consensus::consensus_crypto::verify_consensus_signature_bound(gid, &pre, sig, &pk).await {
            valid.insert(gid.clone());
        }
        if valid.len() >= need { break; } // lazy stop
    }
    valid.len() >= need
}

/// Adopt a VERIFIED capsule as the GALC root, monotonically by index. Caller MUST have run
/// verify_capsule. Only raises the hash-trust root; never touches the finality floor / SNAPSHOT_ANCHOR.
pub fn adopt_verified(c: &GenesisCheckpoint) {
    let _g = ADOPT_LOCK.lock();                                 // serialize writers: guard+publish is atomic
    if c.mb_index <= GALC_MB.load(Ordering::SeqCst) { return; } // monotonic-up (race-free under the lock)
    // SeqCst on BOTH seq RMWs (not Release): Release orders only PRIOR writes before the RMW, leaving
    // the SUBSEQUENT data stores free to become visible before the odd-seq publication on a weakly
    // ordered target — a reader could then read a torn (index, hash, digest) tuple across two even
    // seq reads. SeqCst on the seq RMWs + the already-SeqCst data stores gives a single total order.
    GALC_SEQ.fetch_add(1, Ordering::SeqCst);                    // enter write (odd) — readers retry
    store32(&GALC_HASH, &c.mb_hash);
    store32(&GALC_DIGEST_ANCHOR, &c.committee_digest_anchor);
    store32(&GALC_DIGEST_PRED, &c.committee_digest_pred);
    GALC_MB.store(c.mb_index, Ordering::SeqCst);
    GALC_SEQ.fetch_add(1, Ordering::SeqCst);                    // exit write (even) — snapshot consistent
    println!("[INFO][GALC] root_adopted mb={} hash={}", c.mb_index, hex::encode(&c.mb_hash[..8]));
}

// Bounds concurrent post-quantum capsule verifies so a full-capsule flood (rising mb_index bypasses the
// stale-skip) cannot accumulate unbounded Dilithium work on detached tasks.
static VERIFY_SEM: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(8));

/// Verify then adopt + hold (the full-capsule receive path). Returns true if adopted. Cheap stale-skip
/// + a concurrency permit gate the expensive verify (DoS).
pub async fn receive_capsule(c: &GenesisCheckpoint, storage: &crate::storage::Storage) -> bool {
    if c.mb_index <= GALC_MB.load(Ordering::SeqCst) { return false; } // skip stale before any verify
    let nid = match local_network_id(storage) { Some(n) => n, None => return false };
    if !pre_check(c, &nid) { return false; }                            // cheap, pre-quantum
    let _permit = match VERIFY_SEM.try_acquire() { Ok(p) => p, Err(_) => return false }; // bound PQ work
    if !verify_capsule(c, &nid).await { return false; }
    adopt_verified(c);
    store_held(c.clone());
    persist_held(storage, c);
    true
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Production: partial-sig aggregation (genesis mint → >=2f+1 → assembled capsule), held-capsule serving.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

struct Bucket {
    version: u16,
    network_id: [u8; 32],
    mb_index: u64,
    mb_hash: [u8; 32],
    committee_digest_anchor: [u8; 32],
    committee_digest_pred: [u8; 32],
    minted_at_height: u64,
    sigs: HashMap<String, String>, // genesis_id → sig
}

// Aggregation keyed by sha3(preimage): a byzantine genesis signing a DIFFERENT tuple forms its own
// (never-quorum) bucket instead of poisoning the honest one. Bounded — the genesis set is tiny.
static PARTIALS: Lazy<RwLock<HashMap<[u8; 32], Bucket>>> = Lazy::new(|| RwLock::new(HashMap::new()));
// Latest complete capsule held for serving a cold joiner + rebroadcast.
static HELD: Lazy<RwLock<Option<GenesisCheckpoint>>> = Lazy::new(|| RwLock::new(None));

/// Entry count of the partial-signature buckets, for the memory census.
pub fn holder_census() -> Vec<(&'static str, u64)> {
    vec![("galc_partials", PARTIALS.read().len() as u64), ("galc_v2_buckets", V2.bucket_count() as u64)]
}
// Highest macroblock index this node has already minted a partial for (anti re-mint).
static LAST_MINTED: AtomicU64 = AtomicU64::new(0);

fn preimage_hash(pre: &str) -> [u8; 32] {
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(pre.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

/// The latest complete capsule this node holds (serve to a cold joiner / rebroadcast). None until one.
pub fn held() -> Option<GenesisCheckpoint> { HELD.read().clone() }

fn store_held(c: GenesisCheckpoint) {
    let mut g = HELD.write();
    if g.as_ref().map_or(true, |h| c.mb_index > h.mb_index) { *g = Some(c); }
}

/// Persist the held capsule (tiny self-authenticating object) so a restart/dormant-return node serves +
/// roots from it before sync. Best-effort.
fn persist_held(storage: &crate::storage::Storage, c: &GenesisCheckpoint) {
    if let Ok(bytes) = bincode::serialize(c) {
        let _ = storage.put_galc_held(&bytes);
    }
}

/// A capsule assembled from P2P partials: adopted and persisted like a minted one, so a restart serves
/// and roots from it too.
pub fn adopt_assembled(c: &GenesisCheckpoint) {
    adopt_verified(c);
    if let Some(storage) = crate::node::try_get_storage() { persist_held(storage, c); }
}

/// Drop the capsule held in `slot` when it names a macroblock above `target`.
fn drop_held_above(slot: &RwLock<Option<GenesisCheckpoint>>, target: u64) -> bool {
    let mut g = slot.write();
    if g.as_ref().map_or(false, |c| c.mb_index.saturating_mul(MI) > target) {
        *g = None;
        return true;
    }
    false
}

/// The operator rollback to `target` (`abandon_chain_claims_above`, which drops the disk copies): the v1
/// and v2 capsules held in RAM for chain above it go too, and so do v2 partials and the mint marks above
/// it. It runs at boot before the persisted roots load, so the adopted v1 root is not set yet.
pub fn on_rollback(target: u64) {
    let v1 = drop_held_above(&HELD, target);
    LAST_MINTED.fetch_min(target / MI, Ordering::SeqCst);
    let v2 = V2.on_rollback(target);
    if v1 || v2 {
        println!("[INFO][GALC] held_dropped target={} v1={} v2={}", target, v1, v2);
    }
}

/// Boot: reload the persisted capsule, re-verify against the EMBEDDED genesis keys (a tampered/stale-
/// network capsule is rejected — verify checks network_id == block-0 hash), and re-adopt monotonically.
pub async fn load_persisted(storage: &crate::storage::Storage) {
    let nid = match local_network_id(storage) { Some(n) => n, None => return };
    let bytes = match storage.get_galc_held() { Ok(Some(b)) => b, _ => return };
    let c = match bincode::deserialize::<GenesisCheckpoint>(&bytes) { Ok(c) => c, Err(_) => return };
    if verify_capsule(&c, &nid).await {
        adopt_verified(&c);
        store_held(c);
        println!("[INFO][GALC] reloaded_persisted_root mb={}", GALC_MB.load(Ordering::SeqCst));
    }
}

/// Determine the next macroblock index to mint a partial for: the latest FINALIZED macroblock that is a
/// multiple of GALC_MINT_INTERVAL and is newer than what we already minted/adopted. None ⇒ nothing to do.
pub fn next_mint_index(finalized_height: u64) -> Option<u64> {
    let fin_mb = finalized_height / 90;
    if fin_mb < GALC_MINT_INTERVAL { return None; }
    let k = (fin_mb / GALC_MINT_INTERVAL) * GALC_MINT_INTERVAL;
    if k < 2 { return None; }
    if k <= LAST_MINTED.load(Ordering::SeqCst) || k <= GALC_MB.load(Ordering::SeqCst) { return None; }
    Some(k)
}

/// Mark `k` as minted (call after broadcasting the partial) so we don't re-sign it every boundary.
pub fn mark_minted(k: u64) { LAST_MINTED.fetch_max(k, Ordering::SeqCst); }

/// Verify ONE genesis partial signature over its claimed fields (embedded-genesis key only).
pub async fn verify_partial(
    version: u16, network_id: &[u8; 32], mb_index: u64, mb_hash: &[u8; 32],
    digest_anchor: &[u8; 32], digest_pred: &[u8; 32], minted_at_height: u64, genesis_id: &str, sig: &str,
) -> bool {
    if version != GALC_VERSION || mb_index < 2 { return false; }
    if !crate::genesis_constants::is_legacy_genesis_node(genesis_id) { return false; }
    let pk = match crate::genesis_constants::get_genesis_anchor_pk(genesis_id) { Some(p) => p, None => return false };
    // Bound concurrent post-quantum verifies (DoS): the receive handler spawns a detached task per message
    // and the cheap pre-checks above cannot screen a SPOOFED genesis_id (only the sig can), so a flood would
    // otherwise pile unbounded Dilithium work. Drop when no permit is free — a real partial re-arrives on the
    // ~hourly mint cadence. Mirrors receive_capsule's gate; mint_tick uses add_partial and is unaffected.
    let _permit = match VERIFY_SEM.try_acquire() { Ok(p) => p, Err(_) => return false };
    let pre = preimage(version, network_id, mb_index, mb_hash, digest_anchor, digest_pred, minted_at_height);
    qnet_consensus::consensus_crypto::verify_consensus_signature_bound(genesis_id, &pre, sig, &pk).await
}

/// Add a VERIFIED partial; when >=2f+1 DISTINCT accumulate for one preimage, assemble the capsule,
/// hold it, and return it (the caller adopts + relays). Caller MUST have run verify_partial.
#[allow(clippy::too_many_arguments)]
pub fn add_partial(
    version: u16, network_id: [u8; 32], mb_index: u64, mb_hash: [u8; 32],
    digest_anchor: [u8; 32], digest_pred: [u8; 32], minted_at_height: u64, genesis_id: String, sig: String,
) -> Option<GenesisCheckpoint> {
    if mb_index <= GALC_MB.load(Ordering::SeqCst) { return None; } // already past this root
    let pre = preimage(version, &network_id, mb_index, &mb_hash, &digest_anchor, &digest_pred, minted_at_height);
    let key = preimage_hash(&pre);
    let need = qnet_consensus::checkpoint_bft::quorum_size(crate::genesis_constants::genesis_node_count());
    let mut g = PARTIALS.write();
    let cur = GALC_MB.load(Ordering::SeqCst);
    g.retain(|_, b| b.mb_index > cur);
    let b = g.entry(key).or_insert_with(|| Bucket {
        version, network_id, mb_index, mb_hash, committee_digest_anchor: digest_anchor,
        committee_digest_pred: digest_pred, minted_at_height, sigs: HashMap::new(),
    });
    b.sigs.insert(genesis_id, sig);
    if b.sigs.len() < need { return None; }
    let capsule = GenesisCheckpoint {
        version: b.version, network_id: b.network_id, mb_index: b.mb_index, mb_hash: b.mb_hash,
        committee_digest_anchor: b.committee_digest_anchor, committee_digest_pred: b.committee_digest_pred,
        minted_at_height: b.minted_at_height,
        sigs: b.sigs.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
    };
    g.remove(&key);
    drop(g);
    store_held(capsule.clone());
    Some(capsule)
}

/// Genesis mint tick (call periodically on every node). If this node holds a genesis key, sign a
/// partial for the latest FINALIZED macroblock on the cadence and broadcast it — partials aggregate to
/// a capsule on every node. No-op for non-genesis / nothing-new (cheap gates first).
pub async fn mint_tick(
    storage: &crate::storage::Storage,
    p2p: &crate::unified_p2p::SimplifiedP2P,
    wallet: &Option<std::sync::Arc<crate::crypto::vrf::WalletIdentity>>,
    node_id: &str,
) {
    if !crate::genesis_constants::is_legacy_genesis_node(node_id) { return; }
    // v2 first: partials parked for a K not stored yet, then this node's own v2 partial. Own cadence.
    retry_parked_v2(storage).await;
    mint_v2(storage, p2p, wallet, node_id).await;
    let fin = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst);
    let k = match next_mint_index(fin) { Some(k) => k, None => return };
    let kb = match storage.get_macroblock_by_height(k).ok().flatten()
        .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()) { Some(m) => m, None => return };
    let k1 = match storage.get_macroblock_by_height(k - 1).ok().flatten()
        .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()) { Some(m) => m, None => return };
    let network_id = match local_network_id(storage) { Some(n) => n, None => return };
    let mb_hash = kb.hash();
    let digest_anchor = committee_fields_digest(&kb);
    let digest_pred = committee_fields_digest(&k1);
    let minted_at_height = k * 90;
    let pre = preimage(GALC_VERSION, &network_id, k, &mb_hash, &digest_anchor, &digest_pred, minted_at_height);
    let sig = match wallet.as_ref().and_then(|w| w.sign_consensus(node_id, pre.as_bytes()).ok()) {
        Some(s) => s, None => return,
    };
    mark_minted(k);
    if let Some(cap) = add_partial(GALC_VERSION, network_id, k, mb_hash, digest_anchor, digest_pred,
        minted_at_height, node_id.to_string(), sig.clone()) {
        adopt_verified(&cap);
        persist_held(storage, &cap);
        relay_capsule(p2p, &cap).await;
    }
    p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::GenesisCheckpointSig {
        version: GALC_VERSION, network_id, mb_index: k, mb_hash, committee_digest_anchor: digest_anchor,
        committee_digest_pred: digest_pred, minted_at_height, genesis_id: node_id.to_string(), sig,
    }).await;
    println!("[INFO][GALC] minted_partial mb={} hash={}", k, hex::encode(&mb_hash[..8]));
}

/// Relay a complete capsule once (so a super that missed the partial gossip can still serve it). Best-
/// effort, control-lane; receivers dedup by monotonic mb_index. Called by genesis on assembly only
/// (not from receive_capsule) — bounded fan-out, no relay loop.
pub async fn relay_capsule(p2p: &crate::unified_p2p::SimplifiedP2P, c: &GenesisCheckpoint) {
    if let Ok(data) = bincode::serialize(c) {
        let _ = p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::GenesisCheckpoint { data }).await;
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GALC v2: the wallet capsule (docs/protocols/galc-capsule-v2.md). A node release, not a block rule:
// its own type, state, cadence and disk key, and it never raises GALC_MB, so v1 minting and the v1
// root are untouched. Partials travel only between genesis nodes; the capsule only over HTTP.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

pub const GALC_V2_VERSION: u16 = 2;
const DOMAIN_V2: &str = "QNET_GENESIS_CHECKPOINT_v2";
/// Macroblocks between wallet capsules. GALC_MINT_INTERVAL stays tied to the snapshot cadence.
pub const GALC_V2_MINT_INTERVAL: u64 = 10;
/// Parked partials (K not stored here yet): the newest K only, one per genesis signer.
const V2_PARKED_MAX: usize = 5;

/// The wallet capsule: v1's fields plus `Checkpoint::hash` of K (`cp_hash_anchor`) and of K-1
/// (`cp_hash_pred`), which fold the registry, state and logs roots a wallet's walk binds to. v1's
/// struct gets no fields: its bincode is read on disk, at boot, at rollback and over P2P.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GenesisCheckpointV2 {
    pub version: u16,
    pub network_id: [u8; 32],
    pub mb_index: u64,
    pub mb_hash: [u8; 32],
    pub committee_digest_anchor: [u8; 32],
    pub committee_digest_pred: [u8; 32],
    pub minted_at_height: u64,
    pub cp_hash_anchor: [u8; 32],
    pub cp_hash_pred: [u8; 32],
    pub sigs: Vec<(String, String)>,
}

impl GenesisCheckpointV2 {
    /// The text the genesis keys sign: integers in decimal, hashes in lowercase hex.
    pub fn preimage(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            DOMAIN_V2, self.version, hex::encode(self.network_id), self.mb_index, hex::encode(self.mb_hash),
            hex::encode(self.committee_digest_anchor), hex::encode(self.committee_digest_pred),
            self.minted_at_height, hex::encode(self.cp_hash_anchor), hex::encode(self.cp_hash_pred),
        )
    }

    /// The HTTP body. `compact` drops each signature's key trailer, which only the HTTP form may do:
    /// clients verify against the embedded keys.
    pub fn to_json(&self, compact: bool) -> serde_json::Value {
        let sig = |s: &String| if compact {
            qnet_consensus::consensus_crypto::strip_embedded_pk(s).unwrap_or_else(|| s.clone())
        } else { s.clone() };
        serde_json::json!({
            "version": self.version,
            "network_id": hex::encode(self.network_id),
            "mb_index": self.mb_index,
            "mb_hash": hex::encode(self.mb_hash),
            "committee_digest_anchor": hex::encode(self.committee_digest_anchor),
            "committee_digest_pred": hex::encode(self.committee_digest_pred),
            "minted_at_height": self.minted_at_height,
            "cp_hash_anchor": hex::encode(self.cp_hash_anchor),
            "cp_hash_pred": hex::encode(self.cp_hash_pred),
            "sigs": self.sigs.iter().map(|(id, s)| serde_json::json!([id, sig(s)])).collect::<Vec<_>>(),
        })
    }

    /// The route's ETag: one per (K, cpA).
    pub fn etag(&self) -> String {
        format!("\"2-{}-{}\"", self.mb_index, &hex::encode(self.cp_hash_anchor)[..8])
    }
}

/// The checks before any ML-DSA work, by the names the spec gives them.
pub fn pre_check_v2(c: &GenesisCheckpointV2, network_id: &[u8; 32]) -> Result<(), &'static str> {
    if c.version != GALC_V2_VERSION { return Err("version"); }
    if &c.network_id != network_id { return Err("network_id"); }
    if c.mb_index < 2 { return Err("index"); }
    if c.mb_index % GALC_V2_MINT_INTERVAL != 0 { return Err("interval"); }
    if c.mb_index.checked_mul(MI) != Some(c.minted_at_height) { return Err("minted_at_height"); }
    let n = crate::genesis_constants::genesis_node_count();
    if c.sigs.len() < qnet_consensus::checkpoint_bft::quorum_size(n) || c.sigs.len() > n {
        return Err("signature_count");
    }
    Ok(())
}

/// Whether at least quorum DISTINCT genesis ids carry a valid signature over the capsule's preimage, each
/// checked under the key `pk_of` gives (the embedded genesis keys in production, never a peer's). The
/// full form is checked as the nodes check it; the compact HTTP form only when `compact_ok`.
pub async fn quorum_signed_v2(
    c: &GenesisCheckpointV2, pk_of: impl Fn(&str) -> Option<Vec<u8>>, compact_ok: bool,
) -> bool {
    use qnet_consensus::consensus_crypto::{verify_consensus_signature_bound, verify_consensus_signature_compact};
    let need = qnet_consensus::checkpoint_bft::quorum_size(crate::genesis_constants::genesis_node_count());
    let pre = c.preimage();
    let mut valid: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for (gid, sig) in &c.sigs {
        if valid.contains(gid.as_str()) || !crate::genesis_constants::is_legacy_genesis_node(gid) { continue; }
        let pk = match pk_of(gid) { Some(p) => p, None => continue };
        if verify_consensus_signature_bound(gid, &pre, sig, &pk).await
            || (compact_ok && verify_consensus_signature_compact(gid, &pre, sig, &pk))
        {
            valid.insert(gid.as_str());
        }
        if valid.len() >= need { break; }
    }
    valid.len() >= need
}

/// A stored capsule's full check against the embedded genesis keys (boot reload).
pub async fn verify_capsule_v2(c: &GenesisCheckpointV2, network_id: &[u8; 32]) -> bool {
    pre_check_v2(c, network_id).is_ok()
        && quorum_signed_v2(c, crate::genesis_constants::get_genesis_anchor_pk, false).await
}

/// Why the certified checkpoint of macroblock `j` cannot be a capsule root, or None: the rules a wallet
/// applies to the proofs of K and K-1 that a node can judge on its own copy.
pub fn root_problem(j: u64, cp: &qnet_consensus::checkpoint_bft::Checkpoint, qc_hash: &[u8; 32]) -> Option<&'static str> {
    if cp.hash() != *qc_hash { return Some("qc_hash"); }
    if cp.window_head_height != j.saturating_mul(MI) { return Some("window_head_height"); }
    if cp.recovery_anchor.is_some() { return Some("recovery_anchor"); }
    None
}

/// Stored macroblock `j`, its certified checkpoint and the hash its QC signed.
fn certified_at(storage: &crate::storage::Storage, j: u64)
    -> Option<(qnet_state::MacroBlock, qnet_consensus::checkpoint_bft::Checkpoint, [u8; 32])>
{
    let raw = storage.get_macroblock_by_height(j).ok().flatten()?;
    let mb = crate::node::BlockchainNode::macroblock_plaintext(raw)
        .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())?;
    let (cp, qc): (qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate) =
        mb.consensus_data.checkpoint_qc.as_ref().and_then(|b| bincode::deserialize(b).ok())?;
    Some((mb, cp, qc.checkpoint_hash))
}

/// `Checkpoint::hash` of this node's certified checkpoint for macroblock `j`, if it stores one.
pub fn own_checkpoint_hash(storage: &crate::storage::Storage, j: u64) -> Option<[u8; 32]> {
    certified_at(storage, j).map(|(_, cp, _)| cp.hash())
}

/// The roots of a capsule at K on this node: macroblocks K and K-1 and their checkpoint hashes.
enum V2Roots {
    Bound { kb: qnet_state::MacroBlock, k1b: qnet_state::MacroBlock, cp_a: [u8; 32], cp_p: [u8; 32] },
    /// K or K-1 is not stored here (yet).
    Missing,
    Refused(&'static str),
}

fn roots_at(storage: &crate::storage::Storage, k: u64) -> V2Roots {
    if k < 2 { return V2Roots::Refused("index"); }
    let ((kb, cpk, qk), (k1b, cpk1, qk1)) = match (certified_at(storage, k), certified_at(storage, k - 1)) {
        (Some(a), Some(p)) => (a, p),
        _ => return V2Roots::Missing,
    };
    if let Some(why) = root_problem(k, &cpk, &qk).or_else(|| root_problem(k - 1, &cpk1, &qk1)) {
        return V2Roots::Refused(why);
    }
    V2Roots::Bound { kb, k1b, cp_a: cpk.hash(), cp_p: cpk1.hash() }
}

/// A v2 partial as GenesisCheckpointSig carries it. The signer's cpA and cpP never travel: a receiver
/// checks the signature against its own K and K-1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V2Partial {
    pub network_id: [u8; 32],
    pub mb_index: u64,
    pub mb_hash: [u8; 32],
    pub committee_digest_anchor: [u8; 32],
    pub committee_digest_pred: [u8; 32],
    pub minted_at_height: u64,
    pub genesis_id: String,
    pub sig: String,
}

impl V2Partial {
    /// The capsule this partial signs if its K and K-1 are the receiver's (no signatures yet).
    pub fn capsule(&self, cp_hash_anchor: [u8; 32], cp_hash_pred: [u8; 32]) -> GenesisCheckpointV2 {
        GenesisCheckpointV2 {
            version: GALC_V2_VERSION, network_id: self.network_id, mb_index: self.mb_index, mb_hash: self.mb_hash,
            committee_digest_anchor: self.committee_digest_anchor, committee_digest_pred: self.committee_digest_pred,
            minted_at_height: self.minted_at_height, cp_hash_anchor, cp_hash_pred, sigs: Vec::new(),
        }
    }
}

/// One aggregation: the capsule without signatures and the verified ones by signer.
struct V2Bucket {
    capsule: GenesisCheckpointV2,
    sigs: std::collections::BTreeMap<String, String>,
}

#[derive(Default)]
struct V2Inner {
    held: Option<GenesisCheckpointV2>,
    /// K of the held capsule (0: none). Only rises, except on a rollback below it.
    index: u64,
    last_minted: u64,
    /// By preimage hash, so a signer of other fields forms its own bucket and never poisons this one.
    buckets: HashMap<[u8; 32], V2Bucket>,
    parked: Vec<V2Partial>,
    /// This node's (K, cpA, cpP), read once per K.
    roots: Option<(u64, [u8; 32], [u8; 32])>,
}

/// The v2 state: held capsule, index, mint mark, partials. Separate from every v1 holder.
#[derive(Default)]
pub struct GalcV2 {
    inner: parking_lot::Mutex<V2Inner>,
}

impl GalcV2 {
    pub fn held(&self) -> Option<GenesisCheckpointV2> { self.inner.lock().held.clone() }
    pub fn index(&self) -> u64 { self.inner.lock().index }
    fn bucket_count(&self) -> usize { self.inner.lock().buckets.len() }

    /// The receive filter before any storage read or ML-DSA work: a genesis signer, K on the cadence
    /// with its minted height, at most one above this node's finalized macroblock and above the index.
    /// The network id is checked when the caller has it (the spawned half).
    pub fn admit(&self, p: &V2Partial, finalized_mb: u64, network_id: Option<&[u8; 32]>) -> Result<(), &'static str> {
        if !crate::genesis_constants::is_legacy_genesis_node(&p.genesis_id) { return Err("signer"); }
        if network_id.map_or(false, |n| n != &p.network_id) { return Err("network_id"); }
        if p.mb_index < GALC_V2_MINT_INTERVAL || p.mb_index % GALC_V2_MINT_INTERVAL != 0 { return Err("interval"); }
        if p.mb_index.checked_mul(MI) != Some(p.minted_at_height) { return Err("minted_at_height"); }
        if p.mb_index > finalized_mb.saturating_add(1) { return Err("above_finalized"); }
        if p.mb_index <= self.index() { return Err("stale"); }
        Ok(())
    }

    /// The next K this genesis node signs: its finalized macroblock rounded down to the cadence.
    pub fn next_mint(&self, finalized_mb: u64) -> Option<u64> {
        let k = finalized_mb / GALC_V2_MINT_INTERVAL * GALC_V2_MINT_INTERVAL;
        let g = self.inner.lock();
        (k >= GALC_V2_MINT_INTERVAL && k > g.last_minted && k > g.index).then_some(k)
    }

    pub fn mark_minted(&self, k: u64) {
        let mut g = self.inner.lock();
        g.last_minted = g.last_minted.max(k);
    }

    /// Keep a partial whose K is not stored here yet, for the next tick: the newest K only, one per signer.
    pub fn park(&self, p: V2Partial) {
        let mut g = self.inner.lock();
        match g.parked.first().map(|q| q.mb_index) {
            Some(k) if p.mb_index < k => return,
            Some(k) if p.mb_index > k => g.parked.clear(),
            _ => {}
        }
        g.parked.retain(|q| q.genesis_id != p.genesis_id);
        if g.parked.len() < V2_PARKED_MAX { g.parked.push(p); }
    }

    pub fn take_parked(&self) -> Vec<V2Partial> { std::mem::take(&mut self.inner.lock().parked) }

    fn cached_roots(&self, k: u64) -> Option<([u8; 32], [u8; 32])> {
        self.inner.lock().roots.filter(|(rk, ..)| *rk == k).map(|(_, a, p)| (a, p))
    }

    fn cache_roots(&self, k: u64, cp_a: [u8; 32], cp_p: [u8; 32]) { self.inner.lock().roots = Some((k, cp_a, cp_p)); }

    /// Add a VERIFIED partial. A signer counts once, at its highest K, which bounds the buckets by the
    /// genesis set. At quorum the capsule is assembled, held and returned for the caller to persist.
    pub fn add_verified(&self, capsule: GenesisCheckpointV2, genesis_id: String, sig: String) -> Option<GenesisCheckpointV2> {
        let need = qnet_consensus::checkpoint_bft::quorum_size(crate::genesis_constants::genesis_node_count());
        let k = capsule.mb_index;
        let mut g = self.inner.lock();
        if k <= g.index { return None; }
        if g.buckets.values().any(|b| b.capsule.mb_index > k && b.sigs.contains_key(&genesis_id)) { return None; }
        let key = preimage_hash(&capsule.preimage());
        for (bk, b) in g.buckets.iter_mut() {
            if *bk != key { b.sigs.remove(&genesis_id); }
        }
        g.buckets.retain(|_, b| !b.sigs.is_empty());
        let b = g.buckets.entry(key).or_insert_with(|| V2Bucket {
            capsule: GenesisCheckpointV2 { sigs: Vec::new(), ..capsule },
            sigs: std::collections::BTreeMap::new(),
        });
        b.sigs.insert(genesis_id, sig);
        if b.sigs.len() < need { return None; }
        let b = g.buckets.remove(&key)?;
        let mut cap = b.capsule;
        cap.sigs = b.sigs.into_iter().collect();
        g.held = Some(cap.clone());
        g.index = k;
        g.buckets.retain(|_, b| b.capsule.mb_index > k);
        g.parked.retain(|p| p.mb_index > k);
        Some(cap)
    }

    /// Hold a capsule verified at boot when it is newer than the one held.
    pub fn adopt(&self, c: GenesisCheckpointV2) -> bool {
        let mut g = self.inner.lock();
        if c.mb_index <= g.index { return false; }
        g.index = c.mb_index;
        g.held = Some(c);
        true
    }

    /// A rollback to `target`: the capsule, partials, roots and mint mark above it name abandoned chain.
    /// True when the held capsule went.
    pub fn on_rollback(&self, target: u64) -> bool {
        let above = |k: u64| k.saturating_mul(MI) > target;
        let mut g = self.inner.lock();
        let dropped = g.held.as_ref().map_or(false, |c| above(c.mb_index));
        if dropped {
            g.held = None;
            g.index = 0;
        }
        g.buckets.retain(|_, b| !above(b.capsule.mb_index));
        g.parked.retain(|p| !above(p.mb_index));
        if g.roots.map_or(false, |(k, ..)| above(k)) { g.roots = None; }
        g.last_minted = g.last_minted.min(target / MI);
        dropped
    }
}

static V2: Lazy<GalcV2> = Lazy::new(GalcV2::default);

/// The wallet capsule this node holds, if any (the HTTP route serves it).
pub fn held_v2() -> Option<GenesisCheckpointV2> { V2.held() }

fn persist_v2(storage: &crate::storage::Storage, c: &GenesisCheckpointV2) {
    if let Ok(bytes) = bincode::serialize(c) {
        let _ = storage.put_galc_v2_held(&bytes);
    }
}

/// Whether this node's own K and K-1 are roots that hash to the capsule's cpA and cpP.
fn binds_here(storage: &crate::storage::Storage, c: &GenesisCheckpointV2) -> bool {
    matches!(roots_at(storage, c.mb_index),
             V2Roots::Bound { cp_a, cp_p, .. } if cp_a == c.cp_hash_anchor && cp_p == c.cp_hash_pred)
}

/// Boot: reload the persisted wallet capsule, verify it again against the embedded genesis keys and hold it
/// only while it binds to this node's K and K-1. A recovery decree re-certifies above its target without
/// deleting the capsule; holding the old one would raise the index and refuse the re-certified K for good.
pub async fn load_persisted_v2(storage: &crate::storage::Storage) {
    let nid = match local_network_id(storage) { Some(n) => n, None => return };
    let bytes = match storage.get_galc_v2_held() { Ok(Some(b)) => b, _ => return };
    let c = match bincode::deserialize::<GenesisCheckpointV2>(&bytes) { Ok(c) => c, Err(_) => return };
    if !verify_capsule_v2(&c, &nid).await { return; }
    if !binds_here(storage, &c) {
        println!("[WARN][GALC] v2_reload_unbound mb={} action=not_held", c.mb_index);
        return;
    }
    if V2.adopt(c) {
        println!("[INFO][GALC] v2_reloaded mb={}", V2.index());
    }
}

/// This node's cpA and cpP for K: Err(None) while K or K-1 is not stored, Err(Some) when either cannot
/// be a root.
fn own_roots_v2(storage: &crate::storage::Storage, k: u64) -> Result<([u8; 32], [u8; 32]), Option<&'static str>> {
    if let Some(r) = V2.cached_roots(k) { return Ok(r); }
    match roots_at(storage, k) {
        V2Roots::Bound { cp_a, cp_p, .. } => {
            V2.cache_roots(k, cp_a, cp_p);
            Ok((cp_a, cp_p))
        }
        V2Roots::Missing => Err(None),
        V2Roots::Refused(why) => Err(Some(why)),
    }
}

fn finalized_mb() -> u64 { crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst) / MI }

/// Partials are sent only from one genesis node to another, never relayed, so a genesis node takes one only
/// from the signer's own genesis address. Anything else (a super, a spoofed signer) is dropped before it can
/// read storage or displace the signer's parked partial.
pub fn v2_sender_ok(own_is_genesis: bool, genesis_id: &str, from_peer: &str) -> bool {
    own_is_genesis
        && crate::genesis_constants::genesis_ip_for_node_id(genesis_id) == Some(from_peer.split(':').next().unwrap_or(""))
}

/// A v2 partial from P2P: the sender and cheap filters on the caller's task, the storage read and the ML-DSA
/// verify on a spawned one.
pub fn receive_partial_v2(p: V2Partial, from_peer: &str) {
    if !v2_sender_ok(crate::light_device::own_genesis_id().is_some(), &p.genesis_id, from_peer) { return; }
    if V2.admit(&p, finalized_mb(), None).is_err() { return; }
    tokio::spawn(async move {
        if let Some(storage) = crate::node::try_get_storage() { take_partial_v2(storage, p).await; }
    });
}

/// Root, verify and aggregate one partial; park it while its K is not stored here or no verify slot is free.
async fn take_partial_v2(storage: &crate::storage::Storage, p: V2Partial) {
    let nid = match local_network_id(storage) { Some(n) => n, None => return };
    if V2.admit(&p, finalized_mb(), Some(&nid)).is_err() { return; }
    let (cp_a, cp_p) = match own_roots_v2(storage, p.mb_index) {
        Ok(r) => r,
        Err(None) => return V2.park(p),
        Err(Some(why)) => {
            if crate::node::is_warn() { println!("[WARN][GALC] v2_partial_unrooted mb={} reason={}", p.mb_index, why); }
            return;
        }
    };
    let pk = match crate::genesis_constants::get_genesis_anchor_pk(&p.genesis_id) { Some(k) => k, None => return };
    let capsule = p.capsule(cp_a, cp_p);
    let valid = {
        let _permit = match VERIFY_SEM.try_acquire() { Ok(permit) => permit, Err(_) => return V2.park(p) };
        qnet_consensus::consensus_crypto::verify_consensus_signature_bound(&p.genesis_id, &capsule.preimage(), &p.sig, &pk).await
    };
    if !valid { return; }
    if let Some(cap) = V2.add_verified(capsule, p.genesis_id, p.sig) {
        persist_v2(storage, &cap);
        println!("[INFO][GALC] v2_assembled mb={} via=p2p", cap.mb_index);
    }
}

async fn retry_parked_v2(storage: &crate::storage::Storage) {
    for p in V2.take_parked() { take_partial_v2(storage, p).await; }
}

/// A genesis node signs the wallet capsule for its newest finalized K on the cadence, only when the
/// certified checkpoints of K and K-1 are roots a wallet accepts, and sends the partial to the genesis
/// nodes it is connected to (a node without v2 drops version 2).
async fn mint_v2(
    storage: &crate::storage::Storage,
    p2p: &crate::unified_p2p::SimplifiedP2P,
    wallet: &Option<std::sync::Arc<crate::crypto::vrf::WalletIdentity>>,
    node_id: &str,
) {
    let k = match V2.next_mint(finalized_mb()) { Some(k) => k, None => return };
    let network_id = match local_network_id(storage) { Some(n) => n, None => return };
    let (kb, k1b, cp_a, cp_p) = match roots_at(storage, k) {
        V2Roots::Bound { kb, k1b, cp_a, cp_p } => (kb, k1b, cp_a, cp_p),
        V2Roots::Missing => return,
        V2Roots::Refused(why) => {
            V2.mark_minted(k);
            println!("[WARN][GALC] v2_mint_refused mb={} reason={}", k, why);
            return;
        }
    };
    V2.cache_roots(k, cp_a, cp_p);
    let capsule = GenesisCheckpointV2 {
        version: GALC_V2_VERSION, network_id, mb_index: k, mb_hash: kb.hash(),
        committee_digest_anchor: committee_fields_digest(&kb), committee_digest_pred: committee_fields_digest(&k1b),
        minted_at_height: k * MI, cp_hash_anchor: cp_a, cp_hash_pred: cp_p, sigs: Vec::new(),
    };
    let sig = match wallet.as_ref().and_then(|w| w.sign_consensus(node_id, capsule.preimage().as_bytes()).ok()) {
        Some(s) => s, None => return,
    };
    V2.mark_minted(k);
    let msg = crate::unified_p2p::NetworkMessage::GenesisCheckpointSig {
        version: GALC_V2_VERSION, network_id, mb_index: k, mb_hash: capsule.mb_hash,
        committee_digest_anchor: capsule.committee_digest_anchor, committee_digest_pred: capsule.committee_digest_pred,
        minted_at_height: capsule.minted_at_height, genesis_id: node_id.to_string(), sig: sig.clone(),
    };
    if let Some(cap) = V2.add_verified(capsule, node_id.to_string(), sig) {
        persist_v2(storage, &cap);
        println!("[INFO][GALC] v2_assembled mb={} via=mint", cap.mb_index);
    }
    let sent = p2p.send_to_genesis_peers(&msg).await;
    println!("[INFO][GALC] v2_minted_partial mb={} sent={}", k, sent);
}

/// Certified macroblocks for GALC v2 tests (this module and the capsule route's).
#[cfg(test)]
pub(crate) mod test_support {
    use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate};

    /// A checkpoint for macroblock `j` (window head j*90), optionally carrying a recovery anchor.
    pub(crate) fn checkpoint(j: u64, recovery_anchor: Option<(u64, [u8; 32])>) -> Checkpoint {
        Checkpoint {
            index: j, parent_qc: None, window_head_height: j * 90, window_mb_hashes: vec![[(j % 251) as u8; 32]],
            state_root: [1u8; 32], beacon: [2u8; 32], epoch_commitment: [3u8; 32], reward_root: [0u8; 32],
            registry_root: [4u8; 32], logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: 1_790_000_000 + j, proposer: "genesis_node_001".to_string(),
            proposer_sig: Vec::new(), recovery_anchor,
        }
    }

    /// Store macroblock `j` sealed with `cp` under a QC that signed `qc_hash`.
    pub(crate) async fn seal(st: &crate::storage::Storage, j: u64, cp: &Checkpoint, qc_hash: [u8; 32]) {
        let qc = QuorumCertificate {
            checkpoint_hash: qc_hash, index: cp.index, signers: Vec::new(), sig_merkle_root: [0u8; 32], sigs: Vec::new(),
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp.clone(), qc)).expect("encode"));
        let mb = qnet_state::MacroBlock::new(j, cp.timestamp, [0u8; 32], cp.window_mb_hashes.clone(), cp.state_root, cd);
        st.save_macroblock(j, &mb).await.expect("seal");
    }

    /// Macroblocks K-1 and K, each under the QC of its own hash. Returns their checkpoints.
    pub(crate) async fn seal_pair(st: &crate::storage::Storage, k: u64) -> (Checkpoint, Checkpoint) {
        let (pred, anchor) = (checkpoint(k - 1, None), checkpoint(k, None));
        seal(st, k - 1, &pred, pred.hash()).await;
        seal(st, k, &anchor, anchor.hash()).await;
        (pred, anchor)
    }

    pub(crate) fn temp_storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        (st, dir)
    }
}

#[cfg(test)]
mod v2_tests {
    use super::*;
    use super::test_support::*;
    use qnet_consensus::checkpoint_bft::{Checkpoint, QcRef};
    use serde_json::Value;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/protocols/galc-capsule-v2.vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file")).expect("vectors json")
    }

    fn field<'a>(o: &'a serde_json::Map<String, Value>, k: &str) -> &'a Value {
        o.get(k).unwrap_or(&Value::Null)
    }

    /// Lowercase hex of 32 bytes, as the spec requires; anything else is `shape`.
    fn h32(v: &Value) -> Result<[u8; 32], &'static str> {
        let s = v.as_str().ok_or("shape")?;
        if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("shape"); }
        let mut out = [0u8; 32];
        hex::decode_to_slice(s, &mut out).map_err(|_| "shape")?;
        Ok(out)
    }

    /// The wire capsule as the node's type.
    fn parse_capsule(v: &Value) -> Result<GenesisCheckpointV2, &'static str> {
        let o = v.as_object().ok_or("shape")?;
        let num = |k: &str| field(o, k).as_u64().ok_or("shape");
        let sigs = field(o, "sigs").as_array().ok_or("shape")?.iter().map(|e| {
            let pair = e.as_array().filter(|p| p.len() == 2).ok_or("shape")?;
            Ok((pair[0].as_str().ok_or("shape")?.to_string(), pair[1].as_str().ok_or("shape")?.to_string()))
        }).collect::<Result<Vec<_>, &'static str>>()?;
        Ok(GenesisCheckpointV2 {
            version: u16::try_from(num("version")?).map_err(|_| "shape")?,
            network_id: h32(field(o, "network_id"))?,
            mb_index: num("mb_index")?,
            mb_hash: h32(field(o, "mb_hash"))?,
            committee_digest_anchor: h32(field(o, "committee_digest_anchor"))?,
            committee_digest_pred: h32(field(o, "committee_digest_pred"))?,
            minted_at_height: num("minted_at_height")?,
            cp_hash_anchor: h32(field(o, "cp_hash_anchor"))?,
            cp_hash_pred: h32(field(o, "cp_hash_pred"))?,
            sigs,
        })
    }

    /// The proof route's checkpoint JSON as the consensus type (total_supply as a number or a string). A hash
    /// that is not lowercase hex is `shape`, which a root reports as `root_shape`.
    fn parse_checkpoint(v: &Value) -> Result<Checkpoint, &'static str> {
        let h = |k: &str| h32(&v[k]);
        let n = |k: &str| v[k].as_u64().or_else(|| v[k].as_str().and_then(|s| s.parse().ok())).ok_or("shape");
        let parent_qc = match v["parent_qc"].as_object() {
            Some(p) => Some(QcRef { checkpoint_hash: h32(&p["checkpoint_hash"])?, index: p["index"].as_u64().ok_or("shape")? }),
            None => None,
        };
        let recovery_anchor = match v["recovery_anchor"].as_array() {
            Some(a) if a.len() == 2 => Some((a[0].as_u64().ok_or("shape")?, h32(&a[1])?)),
            Some(_) => return Err("shape"),
            None => None,
        };
        Ok(Checkpoint {
            index: n("index")?,
            parent_qc,
            window_head_height: n("window_head_height")?,
            window_mb_hashes: v["window_mb_hashes"].as_array().ok_or("shape")?.iter().map(h32).collect::<Result<_, _>>()?,
            state_root: h("state_root")?, beacon: h("beacon")?, epoch_commitment: h("epoch_commitment")?,
            reward_root: h("reward_root")?, registry_root: h("registry_root")?, logs_root: h("logs_root")?,
            dilithium_pk_root: h("dilithium_pk_root")?, reward_epoch_root: h("reward_epoch_root")?,
            total_supply: n("total_supply")?, timestamp: n("timestamp")?,
            proposer: v["proposer"].as_str().ok_or("shape")?.to_string(), proposer_sig: Vec::new(),
            recovery_anchor,
        })
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array().expect("list").iter().map(|s| s.as_str().expect("string").to_string()).collect()
    }

    fn test_keys(v: &Value) -> std::collections::HashMap<String, Vec<u8>> {
        v["keys"].as_array().expect("keys").iter()
            .map(|k| (k["id"].as_str().unwrap().to_string(), hex::decode(k["publicKey"].as_str().unwrap()).unwrap()))
            .collect()
    }

    fn nid(v: &Value) -> [u8; 32] { h32(&v["networkId"]).expect("network id") }

    /// The Rust preimage, checkpoint hashes, epoch commitments, wire form and compact signatures reproduce
    /// the vectors the wallet clients are tested against, byte for byte.
    #[test]
    fn galc_v2_vectors_reproduce_byte_for_byte() {
        let v = vectors();
        let c = &v["constants"];
        assert_eq!(c["domain"], json_str(DOMAIN_V2));
        assert_eq!(c["version"].as_u64(), Some(GALC_V2_VERSION as u64));
        assert_eq!(c["mintInterval"].as_u64(), Some(GALC_V2_MINT_INTERVAL));
        assert_eq!(c["macroblockInterval"].as_u64(), Some(MI));
        assert_eq!(c["genesisCount"].as_u64(), Some(crate::genesis_constants::genesis_node_count() as u64));
        assert_eq!(c["quorum"].as_u64(), Some(qnet_consensus::checkpoint_bft::quorum_size(5) as u64));

        for p in v["preimages"].as_array().expect("preimages") {
            let mut fields = p["fields"].clone();
            fields["sigs"] = serde_json::json!([]);
            let cap = parse_capsule(&fields).expect("fields");
            assert_eq!(cap.preimage(), p["preimage"].as_str().unwrap());
            // The receiver's path: the partial's fields plus its own cpA and cpP.
            let partial = V2Partial {
                network_id: cap.network_id, mb_index: cap.mb_index, mb_hash: cap.mb_hash,
                committee_digest_anchor: cap.committee_digest_anchor, committee_digest_pred: cap.committee_digest_pred,
                minted_at_height: cap.minted_at_height, genesis_id: "genesis_node_001".into(), sig: String::new(),
            };
            assert_eq!(partial.capsule(cap.cp_hash_anchor, cap.cp_hash_pred), cap);
        }

        for (j, root) in v["roots"].as_object().expect("roots") {
            let cp = parse_checkpoint(&root["checkpoint"]).expect("vector root");
            assert_eq!(hex::encode(cp.hash()), v["checkpointHashes"][j].as_str().unwrap(), "checkpoint hash of {}", j);
            let eligible = hex::decode(root["eligible_raw"].as_str().unwrap()).unwrap();
            let ec = qnet_consensus::checkpoint_bft::epoch_commitment(&eligible, &strings(&root["committee"]), &strings(&root["banned"]));
            assert_eq!(hex::encode(ec), v["epochCommitments"][j].as_str().unwrap(), "epoch commitment of {}", j);
            assert_eq!(ec, cp.epoch_commitment);
            let j: u64 = j.parse().unwrap();
            assert_eq!(root_problem(j, &cp, &cp.hash()), None, "a root a wallet takes is one the node mints on");
        }

        // The wire capsule: the node's JSON is the same object, and its compact form the vectors' compact signatures.
        let wire = &v["capsule"];
        let cap = parse_capsule(wire).expect("wire capsule");
        assert_eq!(cap.to_json(false), *wire);
        assert_eq!(cap.preimage(), v["preimages"][0]["preimage"].as_str().unwrap());
        let compact = cap.to_json(true);
        for (i, (id, _)) in cap.sigs.iter().enumerate() {
            let want = &v["signatures"][format!("capsule/{}/compact", id)];
            assert_eq!(compact["sigs"][i][1], *want, "compact form of {}", id);
        }
        assert_eq!(cap.etag(), format!("\"2-{}-{}\"", cap.mb_index, &hex::encode(cap.cp_hash_anchor)[..8]));
    }

    fn json_str(s: &str) -> Value { Value::String(s.to_string()) }

    /// The node's judgement of one vector case: the checks, the signatures under the test keys, and the
    /// root rules on the case's proofs of K and K-1.
    async fn judge(v: &Value, case: &Value) -> &'static str {
        let keys = test_keys(v);
        let mut wire = case["capsule"].clone();
        if let Some(sigs) = wire["sigs"].as_array_mut() {
            for e in sigs.iter_mut() {
                let name = e[1].as_str().unwrap_or_default().to_string();
                e[1] = v["signatures"][&name].clone();
            }
        }
        let c = match parse_capsule(&wire) { Ok(c) => c, Err(why) => return why };
        if let Err(why) = pre_check_v2(&c, &nid(v)) { return why; }
        let compact_ok = case["httpOnly"].as_bool().unwrap_or(false);
        if !quorum_signed_v2(&c, |id: &str| keys.get(id).cloned(), compact_ok).await { return "signatures"; }
        let roots = case.get("roots").unwrap_or(&v["roots"]);
        for (j, want) in [(c.mb_index, c.cp_hash_anchor), (c.mb_index - 1, c.cp_hash_pred)] {
            let r = &roots[j.to_string()];
            // The client's shape rule: hashes and the eligible bytes in lowercase hex.
            let cp = match parse_checkpoint(&r["checkpoint"]) { Ok(cp) => cp, Err(_) => return "root_shape" };
            let raw = r["eligible_raw"].as_str().unwrap_or_default();
            if raw.len() % 2 != 0 || !raw.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return "root_shape"; }
            if r["index"].as_u64() != Some(j) { return "root_index"; }
            match root_problem(j, &cp, &want) {
                Some("qc_hash") => return "cp_hash",
                Some("window_head_height") => return "root_index",
                Some(why) => return why,
                None => {}
            }
            let eligible = hex::decode(raw).unwrap_or_default();
            if eligible.is_empty() { return "eligible"; }
            let ec = qnet_consensus::checkpoint_bft::epoch_commitment(&eligible, &strings(&r["committee"]), &strings(&r["banned"]));
            if ec != cp.epoch_commitment { return "epoch_commitment"; }
        }
        "accepted"
    }

    /// Every vector case ends as the spec says. The head rule is the client's alone (a node has no head
    /// hint; it judges K against its own finalized macroblock), so there the node accepts.
    #[tokio::test]
    async fn galc_v2_vector_cases_are_judged_as_the_spec_says() {
        let v = vectors();
        let cases = v["cases"].as_array().expect("cases");
        assert!(cases.len() >= 20);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let expect = case["expect"].as_str().unwrap();
            let got = judge(&v, case).await;
            match expect {
                "above_head" | "below_pin" => assert_eq!(got, "accepted", "{}: a client-only rule", name),
                _ => assert_eq!(got, expect, "{}", name),
            }
        }
    }

    fn capsule_at(k: u64) -> GenesisCheckpointV2 {
        GenesisCheckpointV2 {
            version: GALC_V2_VERSION, network_id: [9u8; 32], mb_index: k, mb_hash: [5u8; 32],
            committee_digest_anchor: [6u8; 32], committee_digest_pred: [7u8; 32], minted_at_height: k * MI,
            cp_hash_anchor: [8u8; 32], cp_hash_pred: [10u8; 32], sigs: Vec::new(),
        }
    }

    fn partial_at(k: u64, signer: &str) -> V2Partial {
        let c = capsule_at(k);
        V2Partial {
            network_id: c.network_id, mb_index: k, mb_hash: c.mb_hash, committee_digest_anchor: c.committee_digest_anchor,
            committee_digest_pred: c.committee_digest_pred, minted_at_height: c.minted_at_height,
            genesis_id: signer.to_string(), sig: format!("sig_{}", signer),
        }
    }

    /// Four distinct genesis signers assemble; a repeated signer counts once; the capsule is held with its
    /// signatures in signer order and raises the v2 index; a signer of other fields forms its own bucket.
    #[test]
    fn galc_v2_state_assembles_at_quorum_distinct_signers() {
        let s = GalcV2::default();
        let add = |k: u64, who: &str| s.add_verified(capsule_at(k), who.to_string(), format!("sig_{}", who));
        assert!(add(100, "genesis_node_003").is_none());
        assert!(add(100, "genesis_node_003").is_none(), "a repeated signer counts once");
        assert!(add(100, "genesis_node_001").is_none());
        let mut other = capsule_at(100);
        other.mb_hash = [0xEE; 32];
        assert!(s.add_verified(other, "genesis_node_005".into(), "x".into()).is_none(), "other fields: own bucket");
        assert!(add(100, "genesis_node_002").is_none(), "three of four");
        assert_eq!(s.bucket_count(), 2);
        let cap = add(100, "genesis_node_004").expect("the fourth distinct signer assembles it");
        let ids: Vec<&str> = cap.sigs.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004"]);
        assert_eq!(cap.preimage(), capsule_at(100).preimage(), "the signatures do not enter the preimage");
        assert_eq!(s.held(), Some(cap));
        assert_eq!(s.index(), 100);
        assert_eq!(s.bucket_count(), 0, "buckets at or below the index go");
        assert!(add(100, "genesis_node_005").is_none(), "nothing at or below the index aggregates");

        // A signer counts once, at its highest K: its partial moves with it, so the buckets stay bounded.
        assert!(add(110, "genesis_node_001").is_none());
        assert!(add(120, "genesis_node_001").is_none());
        assert_eq!(s.bucket_count(), 1);
        assert!(add(110, "genesis_node_001").is_none(), "a lower K than its own is ignored");
        assert_eq!(s.bucket_count(), 1);
    }

    /// The receive filter: a genesis signer, this network, K on the cadence with its height, at most one
    /// above the finalized macroblock, above the index.
    #[test]
    fn galc_v2_receive_filter() {
        let s = GalcV2::default();
        let nid = [9u8; 32];
        assert_eq!(s.admit(&partial_at(100, "genesis_node_002"), 99, Some(&nid)), Ok(()));
        assert_eq!(s.admit(&partial_at(100, "super_node_0011223344556677"), 99, Some(&nid)), Err("signer"));
        assert_eq!(s.admit(&partial_at(100, "genesis_node_002"), 99, Some(&[1u8; 32])), Err("network_id"));
        assert_eq!(s.admit(&partial_at(100, "genesis_node_002"), 99, None), Ok(()), "the cheap half has no network id");
        let mut off = partial_at(105, "genesis_node_002");
        off.minted_at_height = 105 * MI;
        assert_eq!(s.admit(&off, 200, None), Err("interval"));
        assert_eq!(s.admit(&partial_at(0, "genesis_node_002"), 200, None), Err("interval"));
        let mut minted = partial_at(100, "genesis_node_002");
        minted.minted_at_height += 1;
        assert_eq!(s.admit(&minted, 200, None), Err("minted_at_height"));
        assert_eq!(s.admit(&partial_at(100, "genesis_node_002"), 98, None), Err("above_finalized"));
        for who in ["genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004"] {
            s.add_verified(capsule_at(100), who.into(), "s".into());
        }
        assert_eq!(s.admit(&partial_at(100, "genesis_node_005"), 200, None), Err("stale"));

        // The sender: a genesis receiver, and the signer's own genesis address (never relayed).
        let ip2 = crate::genesis_constants::genesis_ip_for_node_id("genesis_node_002").expect("genesis ip");
        let ip3 = crate::genesis_constants::genesis_ip_for_node_id("genesis_node_003").expect("genesis ip");
        assert!(v2_sender_ok(true, "genesis_node_002", &format!("{}:8001", ip2)));
        assert!(!v2_sender_ok(true, "genesis_node_002", &format!("{}:8001", ip3)), "another genesis node relaying");
        assert!(!v2_sender_ok(true, "genesis_node_002", "203.0.113.7:8001"), "a super spoofing the signer");
        assert!(!v2_sender_ok(false, "genesis_node_002", &format!("{}:8001", ip2)), "a super never aggregates v2");
        assert!(!v2_sender_ok(true, "super_node_0011223344556677", "203.0.113.7:8001"));

        // Parked: the newest K only, one per signer, at most five.
        s.park(partial_at(110, "genesis_node_001"));
        s.park(partial_at(110, "genesis_node_001"));
        s.park(partial_at(100, "genesis_node_002"));
        assert_eq!(s.take_parked().len(), 1);
        s.park(partial_at(110, "genesis_node_001"));
        s.park(partial_at(120, "genesis_node_002"));
        let parked = s.take_parked();
        assert_eq!(parked.iter().map(|p| p.mb_index).collect::<Vec<_>>(), vec![120]);
        assert!(s.take_parked().is_empty());
    }

    /// Mint on the cadence: the finalized macroblock rounded down, once per K, never at or below the index.
    #[test]
    fn galc_v2_mint_cadence() {
        let s = GalcV2::default();
        assert_eq!(s.next_mint(9), None, "no K below the first interval");
        assert_eq!(s.next_mint(107), Some(100));
        s.mark_minted(100);
        assert_eq!(s.next_mint(109), None);
        assert_eq!(s.next_mint(110), Some(110));
        assert!(s.adopt(capsule_at(120)));
        assert_eq!(s.next_mint(125), None, "the held capsule is newer");
        assert!(!s.adopt(capsule_at(110)), "adopted only when newer");
    }

    /// v2 never moves the v1 root: no GALC_MB write, no v1 adoption, no v1 holder in its code.
    #[test]
    fn galc_v2_never_moves_the_v1_root() {
        let before = (GALC_MB.load(Ordering::SeqCst), effective_pin_checkpoint());
        let s = GalcV2::default();
        for who in ["genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004"] {
            s.add_verified(capsule_at(1_000_000), who.into(), "s".into());
        }
        assert_eq!(s.index(), 1_000_000);
        assert_eq!((GALC_MB.load(Ordering::SeqCst), effective_pin_checkpoint()), before);
        let src = include_str!("galc.rs").replace("\r\n", "\n");
        let start = src.find("// GALC v2: the wallet capsule").expect("v2 section");
        let end = src[start..].find("#[cfg(test)]").map(|e| start + e).expect("v2 section end");
        let v2 = &src[start..end];
        for forbidden in ["GALC_MB.", "adopt_verified(", "store_held(", "HELD.", "LAST_MINTED.", "put_galc_held("] {
            assert!(!v2.contains(forbidden), "the v2 code touches a v1 holder: {}", forbidden);
        }
    }

    /// The mint signs only K whose checkpoints of K and K-1 a wallet would root at: the QC signed this
    /// checkpoint, its window head is j*90 and it carries no recovery anchor.
    #[tokio::test]
    async fn galc_v2_mint_refuses_unrootable_checkpoints() {
        let k = 38_960;
        let (st, _d) = temp_storage();
        assert!(matches!(roots_at(&st, k), V2Roots::Missing));
        let (pred, anchor) = seal_pair(&st, k).await;
        match roots_at(&st, k) {
            V2Roots::Bound { cp_a, cp_p, kb, .. } => {
                assert_eq!((cp_a, cp_p), (anchor.hash(), pred.hash()));
                assert_eq!(kb.height, k);
            }
            _ => panic!("K and K-1 are roots"),
        }
        assert_eq!(own_checkpoint_hash(&st, k), Some(anchor.hash()));

        let (st, _d) = temp_storage();
        let pred = checkpoint(k - 1, None);
        seal(&st, k - 1, &pred, pred.hash()).await;
        let anchor = checkpoint(k, None);
        seal(&st, k, &anchor, [0xAB; 32]).await;
        assert!(matches!(roots_at(&st, k), V2Roots::Refused("qc_hash")), "the QC signed another checkpoint");

        let (st, _d) = temp_storage();
        seal(&st, k - 1, &pred, pred.hash()).await;
        let relaxed = checkpoint(k, Some((k - 6, [0x11; 32])));
        seal(&st, k, &relaxed, relaxed.hash()).await;
        assert!(matches!(roots_at(&st, k), V2Roots::Refused("recovery_anchor")));

        let (st, _d) = temp_storage();
        let mut shifted = checkpoint(k - 1, None);
        shifted.window_head_height += 1;
        seal(&st, k - 1, &shifted, shifted.hash()).await;
        seal(&st, k, &anchor, anchor.hash()).await;
        assert!(matches!(roots_at(&st, k), V2Roots::Refused("window_head_height")), "K-1 is judged too");
    }

    /// The boot reload holds a capsule only while this node's K and K-1 hash to its cpA and cpP: after a recovery
    /// decree re-certified K, the old capsule is not held, so the re-certified K can assemble.
    #[tokio::test]
    async fn galc_v2_reload_holds_only_a_binding_capsule() {
        let k = 38_960;
        let (st, _d) = temp_storage();
        let (pred, anchor) = seal_pair(&st, k).await;
        let mut c = capsule_at(k);
        let (empty, _e) = temp_storage();
        (c.cp_hash_anchor, c.cp_hash_pred) = (anchor.hash(), pred.hash());
        assert!(!binds_here(&empty, &c), "K not stored here");
        assert!(binds_here(&st, &c));
        // The same K-1, K certified over another checkpoint (the chain a decree re-certified).
        let (moved, _m) = temp_storage();
        seal(&moved, k - 1, &pred, pred.hash()).await;
        let mut recertified = checkpoint(k, None);
        recertified.timestamp += 1;
        seal(&moved, k, &recertified, recertified.hash()).await;
        assert!(!binds_here(&moved, &c), "K re-certified: the capsule names the old checkpoint");
        let src = include_str!("galc.rs").replace("\r\n", "\n");
        let load = &src[src.find("pub async fn load_persisted_v2").expect("load")..];
        let load = &load[..load.find("\n}\n").expect("end")];
        assert!(load.find("binds_here(storage, &c)").expect("checked") < load.find("V2.adopt(c)").expect("adopt"));
    }

    /// A rollback below K drops the v1 and v2 capsules held in RAM (their disk copies go in
    /// abandon_chain_claims_above, which calls on_rollback), the v2 index with it, so a re-minted lower K
    /// assembles again. At or below the target they stay.
    #[test]
    fn galc_rollback_clears_ram_for_v1_and_v2() {
        let v1 = |k: u64| GenesisCheckpoint {
            version: 1, network_id: [0u8; 32], mb_index: k, mb_hash: [0u8; 32], committee_digest_anchor: [0u8; 32],
            committee_digest_pred: [0u8; 32], minted_at_height: k * MI, sigs: Vec::new(),
        };
        let slot = RwLock::new(Some(v1(100)));
        assert!(!drop_held_above(&slot, 100 * MI), "a capsule at the target stays");
        assert!(drop_held_above(&slot, 100 * MI - 1));
        assert!(slot.read().is_none());

        let s = GalcV2::default();
        let assemble = |k: u64| {
            let mut out = None;
            for who in ["genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004"] {
                out = s.add_verified(capsule_at(k), who.into(), "s".into());
            }
            out
        };
        assert!(assemble(100).is_some());
        s.mark_minted(100);
        s.park(partial_at(110, "genesis_node_001"));
        assert!(!s.on_rollback(100 * MI), "at the target: kept");
        assert_eq!(s.index(), 100);
        assert!(s.on_rollback(95 * MI));
        assert_eq!((s.held(), s.index()), (None, 0));
        assert!(s.take_parked().is_empty());
        assert_eq!(s.next_mint(99), None, "the mint mark stands at the target");
        assert_eq!(s.next_mint(100), Some(100), "the mark came down from 100: the re-made 100 is signed");
        assert!(assemble(90).is_some(), "a lower K assembles again");

        let snaps = include_str!("storage/snapshots.rs").replace("\r\n", "\n");
        let abandon = &snaps[snaps.find("pub fn abandon_chain_claims_above").expect("abandon")..];
        let abandon = &abandon[..abandon.find("\n    }\n").expect("end")];
        assert!(abandon.contains("batch.delete_cf(&meta, b\"galc_v2_held\")"));
        assert!(abandon.contains("crate::galc::on_rollback(target)"));
    }

    /// A node without v2 drops version 2: its only branch is the v1 one, which both the P2P filter and every
    /// v1 check gate on GALC_VERSION, so a v2 partial never reaches v1 aggregation.
    #[tokio::test]
    async fn galc_v1_paths_ignore_version_2() {
        assert_eq!(GALC_VERSION, 1);
        assert_ne!(GALC_VERSION, GALC_V2_VERSION);
        let z = [0u8; 32];
        assert!(!verify_partial(GALC_V2_VERSION, &z, 100, &z, &z, &z, 9000, "genesis_node_001", "dilithium_sig_x").await);
        let mut c = GenesisCheckpoint {
            version: GALC_V2_VERSION, network_id: z, mb_index: 100, mb_hash: z, committee_digest_anchor: z,
            committee_digest_pred: z, minted_at_height: 9000,
            sigs: (1..=4).map(|i| (format!("genesis_node_00{}", i), String::new())).collect(),
        };
        assert!(!pre_check(&c, &z));
        c.version = GALC_VERSION;
        assert!(pre_check(&c, &z));
        let peers = include_str!("unified_p2p/peers.rs").replace("\r\n", "\n");
        let arm = &peers[peers.find("NetworkMessage::GenesisCheckpointSig {").expect("arm")..];
        let v1 = arm.find("if version == crate::galc::GALC_VERSION").expect("v1 branch gated on its version");
        let v2 = arm.find("} else if version == crate::galc::GALC_V2_VERSION {").expect("v2 branch");
        assert!(v1 < v2);
    }
}

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

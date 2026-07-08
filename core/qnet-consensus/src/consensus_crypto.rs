//! # Consensus Cryptography Module (v2.24)
//!
//! ## Overview
//! Provides quantum-resistant signature verification for Byzantine consensus with a
//! single pure CRYSTALS-Dilithium3 (ML-DSA-65) signature. Defense-in-depth: both P2P and Consensus
//! layers perform cryptographic verification.
//!
//! ## Architecture (Defense-in-Depth)
//! 
//! ### Core Layer (This Module)
//! - **Purpose**: Independent cryptographic verification at consensus level
//! - **Validates**: Real Dilithium signatures via `dilithium3::open()`
//! - **Why**: Defense-in-depth - don't trust P2P layer alone
//!
//! ### Development Layer (qnet-integration)
//! - **Purpose**: Full cryptographic verification at P2P level
//! - **Validates**: Dilithium3 signatures, certificates
//! - **Location**: `node.rs::verify_microblock_signature()`
//!
//! ## Signature Formats (v2.24 - Bincode + Zstd)
//!
//! ### Wire Format Prefixes
//! - `compact_bin:` - Compact signature (bincode+zstd) - **PRODUCTION**
//! - `pq_bin:` - Full signature (bincode+zstd) - **LEGACY** (parse-only)
//! - `compact:` - Compact signature (JSON) - **LEGACY**
//! - `pq:` - Full signature (JSON) - **LEGACY**
//! - `dilithium_sig_` - Pure Dilithium (PRODUCTION)
//!
//! ### 1. Compact Signatures (Microblocks - ~2.6KB bincode)
//! ```text
//! CompactPqSignature {
//!   node_id: String,
//!   cert_serial: String,
//!   dilithium_key_signature: Vec<u8>,  // Dilithium RAW bytes (~2500 bytes)
//!   signed_at: u64,
//! }
//! ```
//! - **Wire format**: `compact_bin:<base64(zstd(bincode(sig)))>`
//! - **Bandwidth**: ~2.6KB bincode (was 5KB JSON, was 22KB base64)
//! - **Certificate**: Referenced by serial, cached at P2P layer
//! - **Used for**: High-frequency microblocks (1/sec)
//!
//! ### 2. Full Signatures (Macroblocks - ~5KB bincode)
//! ```text
//! PqSignature {
//!   certificate: PqCertificate,
//!   dilithium_key_signature: Vec<u8>,  // RAW bytes
//!   signed_at: u64,
//! }
//! ```
//! - **Wire format**: `pq_bin:<base64(zstd(bincode(sig)))>`
//! - **Bandwidth**: ~5KB bincode (was 27KB JSON)
//! - **Used for**: Low-frequency macroblocks (every 90 blocks)
//! - **Verification**: Immediate (certificate embedded)
//!
//! ## Security Model (Defense-in-Depth)
//!
//! ### Layer 1: P2P Verification (node.rs)
//! 1. All received blocks verified with full crypto
//! 2. CRYSTALS-Dilithium3 signature verification (NIST post-quantum) — sole authenticator
//! 3. Certificate validation from cache/network
//! 4. **Only verified blocks enter consensus**
//!
//! ### Layer 2: Consensus Validation (This Module)
//! 1. Structural validation of pre-verified blocks
//! 2. Format checks, component presence
//! 3. Byzantine consensus (requires 2/3+ honest nodes)
//! 4. **Malicious blocks cannot reach consensus threshold**
//!
//! ## NIST/Cisco Compliance
//! - **Post-Quantum**: CRYSTALS-Dilithium3 / ML-DSA-65 (NIST standard) — sole authenticator
//! - **Hashing**: SHA3-256 (NIST approved)
//! - **Signature**: a single pure Dilithium3 signature establishes validity
//!
//! ## Performance
//! - **Compact signatures**: 75% bandwidth reduction
//! - **Certificate caching**: 100K LRU cache
//! - **Zero downtime**: Microblocks continue during macroblock consensus
//! - **Scalability**: Supports millions of nodes (max 1000 validators in consensus)

use base64::{Engine as _, engine::general_purpose};
use pqcrypto_traits::sign::{PublicKey as PQPublicKey, SignedMessage as PQSignedMessage, DetachedSignature as PQDetachedSignature};

// Consensus-layer PK registry (v14.8/v20) — anti-squat, anti-self-attest.
// Two cryptographically authenticated registration paths:
//   1) ANCHORED GENESIS: the fixed 5 genesis PKs are hard-coded in
//      genesis_anchor_pks(), immutable, PINNED (never evicted) — closes
//      the "race node_001 to register a fake PK first" window.
//   2) PROOF-OF-OWNERSHIP: post-genesis super joiners must pass
//      register_consensus_pk_with_proof() — a Dilithium3 sig over
//      "qnet-pk-register-v1:{node_id}" by the private key for `pk`.
// Once registered a PK is IMMUTABLE for the process lifetime (different-PK
// re-register rejected; same-PK is an idempotent no-op).
// v20 scale: cap 100k (QNET_PK_REGISTRY_CAP env); LRU idle-eviction of
// non-pinned entries silent > QNET_PK_REGISTRY_IDLE_DAYS (default 30),
// activity-driven (real participation, not registration order). Cap-full:
// single-shot evict most-stale non-pinned, else reject (pk_registry_full).

/// Per-entry record held inside the registry. The PK bytes never change
/// after insert; the `pinned` flag is decided at insert time and stays
/// constant for the entry's lifetime.
#[derive(Debug, Clone)]
struct PkEntry {
    pk: Vec<u8>,
    /// True for genesis-anchor entries — never evicted by idle-sweep.
    pinned: bool,
    /// Wall-clock seconds at insertion (for telemetry / debug only).
    registered_at: u64,
}

lazy_static::lazy_static! {
    /// Trusted PK registry: node_id -> PkEntry (PK + pinned flag).
    static ref CONSENSUS_PK_REGISTRY: parking_lot::RwLock<std::collections::HashMap<String, PkEntry>> =
        parking_lot::RwLock::new(std::collections::HashMap::new());

    /// Lock-free last-activity tracker for LRU eviction. Updated on every
    /// successful PK lookup and on explicit `observe_pk_activity` calls
    /// from signature-verification paths. Decoupled from the registry so
    /// hot-read paths do not contend with eviction sweeps.
    static ref LAST_ACTIVITY: dashmap::DashMap<String, std::sync::atomic::AtomicU64> =
        dashmap::DashMap::new();

    /// Permanent attacker PK blacklist (canonical SECURITY surface).
    ///
    /// Keyed by the 32-byte SHA3-256 fingerprint of the EXTRACTED
    /// (attacker-supplied) Dilithium3 public key — NOT by node_id,
    /// because a single attacker key can be replayed under many spoofed
    /// identities and a single node_id can be squatted by many
    /// attacker keys. The fingerprint is post-quantum collision-
    /// resistant and stable across restarts.
    ///
    /// SEMANTICS: This is a HARD, process-lifetime ban. Any PK in this
    /// set has been observed presenting itself as a registered identity
    /// whose canonical PK does not match. In a permissionless registry
    /// where each node controls exactly one keypair (CONSENSUS_PK_REGISTRY
    /// is immutable once bound — see `register_consensus_pk_with_origin`),
    /// a single Tier-2 mismatch is conclusive proof of an impersonation
    /// attempt — there is no legitimate cause. We therefore admit a key
    /// to the blacklist on the FIRST observed mismatch.
    ///
    /// PERSISTENCE: When an integrator (qnet-integration) installs a
    /// `ATTACKER_PK_PERSIST_CALLBACK` at boot, every insertion is
    /// mirrored to durable storage. On restart the integrator replays
    /// the persisted set via `seed_attacker_pk_blacklist` BEFORE the
    /// QUIC listener opens, so a known attacker cannot regain a
    /// transient verification budget across reboots.
    ///
    /// BOUNDED MEMORY: Map size is soft-capped at `ATTACKER_PK_BLACKLIST_CAP`.
    /// At the cap we evict the oldest 25% by `last_seen_unix_s` so a
    /// key-rotating attacker (each spoofed connection presents a fresh
    /// Dilithium3 keypair) cannot grow the table unboundedly. At cap
    /// (≤ 1 MB resident) this still retains 12 000 distinct attacker
    /// keys — well above any realistic adversary's churn budget.
    static ref ATTACKER_PK_BLACKLIST: dashmap::DashMap<[u8; 32], AttackerRecord> =
        dashmap::DashMap::new();

    /// Optional persistence callback. When `Some`, every
    /// `record_attacker_pk` mirrors the (fingerprint, record) pair to
    /// the integrator's storage layer (RocksDB metadata CF in the
    /// canonical wiring). Registered exactly once at boot via
    /// `set_attacker_pk_persist_callback`; never replaced.
    static ref ATTACKER_PK_PERSIST_CALLBACK:
        parking_lot::RwLock<Option<std::sync::Arc<dyn Fn(&[u8; 32], &AttackerRecord) + Send + Sync>>> =
        parking_lot::RwLock::new(None);
}

/// Durable record for a single blacklisted attacker public key.
///
/// Kept compact (≤ 64 bytes resident excluding the `last_node_id` short
/// string) so the in-memory set scales to the soft cap without bloat.
#[derive(Debug, Clone)]
pub struct AttackerRecord {
    /// Wall-clock UNIX seconds at first observed mismatch.
    pub first_seen_unix_s: u64,
    /// Wall-clock UNIX seconds at most recent mismatch.
    pub last_seen_unix_s: u64,
    /// Running mismatch count across the process lifetime (post-restart
    /// the value resumes from the persisted record).
    pub offense_count: u32,
    /// `node_id` that the attacker most recently CLAIMED to be. Helpful
    /// for forensic correlation against the registry; never used for
    /// authorisation decisions.
    pub last_claimed_node_id: String,
}

/// Soft cap on `ATTACKER_PK_BLACKLIST`. At 12K entries × ~96 bytes
/// (`AttackerRecord` + DashMap shard overhead) the resident footprint
/// is ≤ 1 MB, comfortable on every super-node. Eviction is lazy (only
/// checked on insert) so the hot read path is unaffected.
const ATTACKER_PK_BLACKLIST_CAP: usize = 12_288;

/// Eviction batch fraction (25 % oldest by `last_seen_unix_s`) applied
/// when the cap is hit. Drops the least-recently-seen attackers; an
/// active attacker still in the wild will be re-inserted on its next
/// connection attempt because the Tier-2 check is always evaluated.
const ATTACKER_PK_EVICT_FRACTION: usize = 4;

// Security-reject log rate governor. Garbage-sig floods fail the cheap
// structural checks before the PK is parsed, so they are unblacklistable
// and previously emitted one [ERR][CONSENSUS] line each (~13k lines/20h
// under a spoofer → log-DoS / disk fill). This rate-limits LOG OUTPUT
// only — the rejection stays unconditional, security boundary unchanged.
// Per claimed node_id: first N/window fully visible (a real node's
// transient fault is never hidden), one suppression notice, then a single
// sig_reject_flood summary at window roll. Keyed per node_id so one
// identity's flood can't starve another's; bounded by soft cap + LRU.

lazy_static::lazy_static! {
    /// claimed_node_id → rolling-window reject-log state.
    static ref SIG_REJECT_LOG_GOVERNOR: dashmap::DashMap<String, SigRejectLogState> =
        dashmap::DashMap::new();
}

#[derive(Debug, Clone)]
struct SigRejectLogState {
    /// UNIX seconds when the current window opened.
    window_start_s: u64,
    /// Detailed reject lines already emitted in the current window.
    logged_in_window: u32,
    /// Reject lines suppressed in the current window (reported on roll).
    suppressed_in_window: u64,
}

/// Rolling window length for the reject-log governor.
const SIG_REJECT_LOG_WINDOW_S: u64 = 60;
/// Detailed reject lines allowed per claimed identity per window before
/// suppression engages. Small enough to collapse a flood, large enough
/// that a genuine transient fault on a real node is still visible.
const SIG_REJECT_LOG_PER_WINDOW: u32 = 5;
/// Soft cap on the governor map (≤ ~1 MB resident at this size).
const SIG_REJECT_GOVERNOR_CAP: usize = 8_192;

enum SigRejectLogAction {
    /// Under the per-window cap — caller emits its detailed reject line.
    Emit,
    /// Cap just crossed — caller emits ONE suppression notice instead.
    EmitSuppressNotice,
    /// Over the cap — caller stays silent (rejection already happened).
    Suppress,
}

fn sig_reject_log_decision(claimed_node_id: &str) -> SigRejectLogAction {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Lazy soft-eviction (only when a NEW identity would grow past cap).
    if !SIG_REJECT_LOG_GOVERNOR.contains_key(claimed_node_id)
        && SIG_REJECT_LOG_GOVERNOR.len() >= SIG_REJECT_GOVERNOR_CAP
    {
        let mut entries: Vec<(String, u64)> = SIG_REJECT_LOG_GOVERNOR
            .iter()
            .map(|e| (e.key().clone(), e.value().window_start_s))
            .collect();
        entries.sort_by_key(|(_, w)| *w);
        let to_drop = entries.len() / 4;
        for (k, _) in entries.into_iter().take(to_drop) {
            SIG_REJECT_LOG_GOVERNOR.remove(&k);
        }
    }

    let mut action = SigRejectLogAction::Emit;
    let mut flood_summary: Option<u64> = None;

    SIG_REJECT_LOG_GOVERNOR
        .entry(claimed_node_id.to_string())
        .and_modify(|st| {
            if now.saturating_sub(st.window_start_s) >= SIG_REJECT_LOG_WINDOW_S {
                // Window rolled: report any suppression from the closed
                // window, then reopen counting this rejection as #1.
                if st.suppressed_in_window > 0 {
                    flood_summary = Some(st.suppressed_in_window);
                }
                st.window_start_s = now;
                st.logged_in_window = 1;
                st.suppressed_in_window = 0;
                action = SigRejectLogAction::Emit;
            } else if st.logged_in_window < SIG_REJECT_LOG_PER_WINDOW {
                st.logged_in_window += 1;
                action = SigRejectLogAction::Emit;
            } else if st.logged_in_window == SIG_REJECT_LOG_PER_WINDOW {
                st.logged_in_window += 1; // mark the notice as emitted
                action = SigRejectLogAction::EmitSuppressNotice;
            } else {
                st.suppressed_in_window = st.suppressed_in_window.saturating_add(1);
                action = SigRejectLogAction::Suppress;
            }
        })
        .or_insert_with(|| SigRejectLogState {
            window_start_s: now,
            logged_in_window: 1,
            suppressed_in_window: 0,
        });

    if let Some(n) = flood_summary {
        eprintln!(
            "[WARN][SECURITY] sig_reject_flood claimed_node={} window_s={} suppressed={} action=window_rolled_still_under_attack",
            claimed_node_id, SIG_REJECT_LOG_WINDOW_S, n
        );
    }
    action
}

/// Rate-governed security-reject logger.
///
/// `full_line` is the exact `[ERR][...]` line the call site would have
/// emitted unconditionally before v25.3. The rejection has ALREADY
/// happened at the call site (the caller `return false`s immediately
/// after) — this governs only whether the line reaches the log, so an
/// attacker flooding pre-PK-parse garbage cannot DoS logging. First
/// `SIG_REJECT_LOG_PER_WINDOW` per claimed identity per window pass
/// through verbatim; then one suppression notice; then silence with a
/// per-window flood summary. Security semantics are unchanged.
pub fn log_sig_reject(claimed_node_id: &str, full_line: &str) {
    match sig_reject_log_decision(claimed_node_id) {
        SigRejectLogAction::Emit => eprintln!("{}", full_line),
        SigRejectLogAction::EmitSuppressNotice => eprintln!(
            "[WARN][SECURITY] sig_reject_log_suppressed claimed_node={} window_s={} threshold={} action=silencing_until_window_roll",
            claimed_node_id, SIG_REJECT_LOG_WINDOW_S, SIG_REJECT_LOG_PER_WINDOW
        ),
        SigRejectLogAction::Suppress => { /* rejection already enforced at call site */ }
    }
}

/// Compute the 32-byte SHA3-256 fingerprint of an extracted public key.
/// Collision-resistant and post-quantum safe; fits as a DashMap key
/// with no allocations on the lookup path.
pub fn pk_fingerprint(pk: &[u8]) -> [u8; 32] {
    use sha3::{Sha3_256, Digest};
    let mut h = Sha3_256::new();
    h.update(pk);
    let out = h.finalize();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    buf
}

/// Install the persistence callback. Idempotent — re-registration is a
/// no-op so a botched re-init cannot strip an already-installed sink.
///
/// Called exactly once during integrator boot, AFTER the storage handle
/// is open and BEFORE the QUIC listener accepts inbound traffic. The
/// callback runs synchronously on the rejection hot path, so the
/// integrator implementation MUST be cheap (≤ µs) — the canonical
/// implementation is a single `db.put_cf(metadata, key, value)`.
pub fn set_attacker_pk_persist_callback<F>(cb: F)
where
    F: Fn(&[u8; 32], &AttackerRecord) + Send + Sync + 'static,
{
    let mut slot = ATTACKER_PK_PERSIST_CALLBACK.write();
    if slot.is_some() {
        return; // idempotent
    }
    *slot = Some(std::sync::Arc::new(cb));
}

/// Seed the in-memory blacklist from durable storage. Called once at
/// boot by the integrator AFTER `set_attacker_pk_persist_callback` and
/// BEFORE the network listener opens. Existing entries are preserved
/// (additive) so a second boot-time replay cannot silently shrink the
/// set.
pub fn seed_attacker_pk_blacklist(entries: Vec<([u8; 32], AttackerRecord)>) {
    for (fp, rec) in entries {
        ATTACKER_PK_BLACKLIST.entry(fp).or_insert(rec);
    }
}

/// O(1) hot-path check. Returns true iff `extracted_pk`'s SHA3-256
/// fingerprint is in the permanent blacklist. Safe to call from any
/// thread; lock-free DashMap read.
pub fn is_pk_blacklisted(extracted_pk: &[u8]) -> bool {
    let fp = pk_fingerprint(extracted_pk);
    ATTACKER_PK_BLACKLIST.contains_key(&fp)
}

/// Variant used by callers that already hold a precomputed fingerprint
/// (e.g. boot-time replay or operator tooling).
pub fn is_pk_fp_blacklisted(fp: &[u8; 32]) -> bool {
    ATTACKER_PK_BLACKLIST.contains_key(fp)
}

/// Telemetry: number of distinct attacker keys currently retained.
pub fn attacker_pk_blacklist_len() -> usize {
    ATTACKER_PK_BLACKLIST.len()
}

/// Operator override: remove a single attacker fingerprint from the
/// blacklist (e.g. after forensic confirmation of a false positive
/// caused by an off-chain key-rotation flow). Returns true if an entry
/// was actually removed. Does NOT touch persistent storage — the
/// integrator clears the durable row from its own admin surface.
pub fn clear_attacker_pk(fp: &[u8; 32]) -> bool {
    ATTACKER_PK_BLACKLIST.remove(fp).is_some()
}

/// Operator override: clear the entire in-memory blacklist. Intended
/// for development resets and post-incident reconciliation; production
/// operators are expected to clear individual entries.
pub fn clear_attacker_pk_blacklist_all() -> usize {
    let n = ATTACKER_PK_BLACKLIST.len();
    ATTACKER_PK_BLACKLIST.clear();
    n
}

/// Record one pk-mismatch offense from `extracted_pk` (the attacker-
/// supplied key) under the registered identity `claimed_node_id`.
///
/// Behaviour:
///   * First sighting → insert a fresh `AttackerRecord`. Persistence
///     callback runs. Returns `(record_after, was_first)` with
///     `was_first = true` — the caller emits one `[CRIT][SECURITY]`
///     discovery line.
///   * Subsequent sightings → bump `offense_count`, refresh
///     `last_seen_unix_s` and `last_claimed_node_id`. Persistence
///     callback runs (idempotent overwrite of the same row).
///     Returns `was_first = false` — the caller stays silent.
///
/// Lazy soft-eviction: at cap we drop the oldest 25 % by
/// `last_seen_unix_s` before insertion so a key-rotating attacker
/// cannot grow the table without bound.
pub fn record_attacker_pk(extracted_pk: &[u8], claimed_node_id: &str) -> (AttackerRecord, bool) {
    let fp = pk_fingerprint(extracted_pk);
    let now_s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Lazy soft-eviction (only when over cap and NEW key incoming).
    if !ATTACKER_PK_BLACKLIST.contains_key(&fp)
        && ATTACKER_PK_BLACKLIST.len() >= ATTACKER_PK_BLACKLIST_CAP
    {
        // Collect into a Vec first so we don't hold any DashMap shard
        // locks across the sort + remove loop.
        let mut entries: Vec<([u8; 32], u64)> = ATTACKER_PK_BLACKLIST
            .iter()
            .map(|e| (*e.key(), e.value().last_seen_unix_s))
            .collect();
        entries.sort_by_key(|(_, last)| *last);
        let to_drop = entries.len() / ATTACKER_PK_EVICT_FRACTION;
        for (k, _) in entries.into_iter().take(to_drop) {
            ATTACKER_PK_BLACKLIST.remove(&k);
        }
    }

    let mut was_first = false;
    let record = ATTACKER_PK_BLACKLIST
        .entry(fp)
        .and_modify(|r| {
            r.offense_count = r.offense_count.saturating_add(1);
            r.last_seen_unix_s = now_s;
            // Track the most recently claimed identity for forensic
            // correlation; truncate to a sane length to bound storage.
            r.last_claimed_node_id = claimed_node_id
                .chars()
                .take(96)
                .collect::<String>();
        })
        .or_insert_with(|| {
            was_first = true;
            AttackerRecord {
                first_seen_unix_s: now_s,
                last_seen_unix_s: now_s,
                offense_count: 1,
                last_claimed_node_id: claimed_node_id
                    .chars()
                    .take(96)
                    .collect::<String>(),
            }
        })
        .clone();

    // Mirror to durable storage if the integrator wired one up. We
    // clone the Arc out of the lock so the callback runs without
    // holding the RwLock — eliminates contention with `set_*` (which
    // is also one-shot at boot, but the discipline matters).
    let cb_arc = ATTACKER_PK_PERSIST_CALLBACK.read().clone();
    if let Some(cb) = cb_arc {
        cb(&fp, &record);
    }

    (record, was_first)
}

/// Canonical challenge prefix for proof-of-ownership. Versioned so a future
/// rotation (e.g. v2 with timestamp binding) cannot replay v1 registrations.
pub const PK_REGISTER_CHALLENGE_PREFIX: &str = "qnet-pk-register-v1:";

/// Default registry cap when the env override is absent. Memory-budget knob, not a correctness
/// bound: the durable on-chain PK registration is the source of truth and an evicted entry
/// re-resolves on the next apply. Set to the active-super ceiling so it does not thrash at
/// hundreds-of-thousands of nodes. Operators override at boot via `QNET_PK_REGISTRY_CAP`.
const DEFAULT_PK_REGISTRY_CAP: usize = 1_000_000;

/// Hard upper bound on the cap, regardless of env override. At 1M entries
/// the registry consumes ~2 GB RAM; we refuse caps higher than that until
/// a tiered (hot/warm/cold) backend lands in v25+.
const MAX_PK_REGISTRY_CAP_HARD: usize = 1_000_000;

/// Default idle threshold for LRU eviction (30 days in seconds).
/// Overridable via `QNET_PK_REGISTRY_IDLE_DAYS`.
///
/// Choice rationale: 30 days is longer than the longest consecutive
/// stall observed in any major BFT chain (Tendermint p99 outage ≈ 7
/// days). A node silent for a full month is operationally dead; freeing
/// its slot is correct.
const DEFAULT_IDLE_THRESHOLD_SECS: u64 = 30 * 24 * 60 * 60;

/// Read the active registry capacity (env override or default).
/// Re-read on every consultation so operators can tune at runtime via
/// process restart without code changes.
pub fn consensus_pk_registry_cap() -> usize {
    std::env::var("QNET_PK_REGISTRY_CAP")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.min(MAX_PK_REGISTRY_CAP_HARD))
        .unwrap_or(DEFAULT_PK_REGISTRY_CAP)
}

/// Read the active idle threshold for LRU eviction (env override or default).
pub fn consensus_pk_registry_idle_threshold_secs() -> u64 {
    std::env::var("QNET_PK_REGISTRY_IDLE_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|days| days * 24 * 60 * 60)
        .unwrap_or(DEFAULT_IDLE_THRESHOLD_SECS)
}

/// Current wall-clock seconds (UNIX epoch). Local helper to avoid
/// re-importing `SystemTime` everywhere in this file.
#[inline]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mark `node_id` as having just produced a signature-verified consensus
/// message. Lock-free atomic update — safe to call from any thread on every
/// verify-success path. Unknown node_ids are tracked as well so that if they
/// later register, the activity record is already current.
pub fn observe_pk_activity(node_id: &str) {
    let now = now_secs();
    LAST_ACTIVITY
        .entry(node_id.to_string())
        .and_modify(|t| t.store(now, std::sync::atomic::Ordering::Relaxed))
        .or_insert_with(|| std::sync::atomic::AtomicU64::new(now));
}

/// Read the last-activity timestamp for `node_id` (UNIX seconds).
/// Returns `None` for nodes never observed.
pub fn last_pk_activity(node_id: &str) -> Option<u64> {
    LAST_ACTIVITY
        .get(node_id)
        .map(|r| r.load(std::sync::atomic::Ordering::Relaxed))
}

/// Try to evict the single most-stale non-pinned entry whose age exceeds
/// `idle_threshold_secs`. Returns `Some(node_id)` on eviction, `None`
/// otherwise. Used as the in-line make-room path inside register_*().
fn try_evict_one_stale_entry(
    registry: &mut std::collections::HashMap<String, PkEntry>,
    idle_threshold_secs: u64,
) -> Option<String> {
    let now = now_secs();
    let mut staleest_id: Option<String> = None;
    let mut staleest_idle: u64 = 0;

    for (id, entry) in registry.iter() {
        if entry.pinned {
            continue; // Never evict genesis anchors
        }
        let last = LAST_ACTIVITY
            .get(id)
            .map(|r| r.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(entry.registered_at);
        let idle = now.saturating_sub(last);
        if idle >= idle_threshold_secs && idle > staleest_idle {
            staleest_idle = idle;
            staleest_id = Some(id.clone());
        }
    }

    if let Some(id) = staleest_id.as_ref() {
        registry.remove(id);
        LAST_ACTIVITY.remove(id);
        println!(
            "[INFO][CONSENSUS] pk_evicted_idle node={} idle_secs={} reason=cap_full_and_stale",
            id, staleest_idle
        );
    }
    staleest_id
}

/// Background sweep: evict ALL non-pinned entries idle longer than the
/// threshold. Called from the integration layer's periodic cleanup loop
/// (hourly or longer). Returns count evicted.
///
/// Invariant: pinned entries (genesis anchors) are NEVER evicted, regardless
/// of staleness — BFT safety requires their PKs always available for
/// verification.
pub fn evict_idle_consensus_pks(idle_threshold_secs: u64) -> usize {
    let now = now_secs();
    let mut to_evict: Vec<String> = Vec::new();

    {
        let registry = CONSENSUS_PK_REGISTRY.read();
        for (id, entry) in registry.iter() {
            if entry.pinned {
                continue;
            }
            let last = LAST_ACTIVITY
                .get(id)
                .map(|r| r.load(std::sync::atomic::Ordering::Relaxed))
                .unwrap_or(entry.registered_at);
            if now.saturating_sub(last) >= idle_threshold_secs {
                to_evict.push(id.clone());
            }
        }
    }

    if to_evict.is_empty() {
        return 0;
    }

    let mut registry = CONSENSUS_PK_REGISTRY.write();
    let mut count = 0usize;
    for id in &to_evict {
        if let Some(entry) = registry.get(id) {
            // Re-check pinned (defensive — could have been re-anchored mid-sweep)
            if entry.pinned {
                continue;
            }
            registry.remove(id);
            LAST_ACTIVITY.remove(id);
            count += 1;
        }
    }
    drop(registry);

    if count > 0 {
        println!(
            "[INFO][CONSENSUS] pk_idle_sweep_done evicted={} threshold_secs={} remaining={}",
            count,
            idle_threshold_secs,
            consensus_pk_registry_len()
        );
    }
    count
}

/// Explicit deactivation of a registered PK. Intended for future use by a
/// signed `NodeDeactivation` TX apply path or by operator tooling. Refuses
/// to remove pinned (genesis-anchor) entries — anchors can only be rotated
/// through a network-wide upgrade ceremony, not a runtime call.
///
/// Returns `true` on successful removal, `false` if the entry was not
/// present or was pinned.
pub fn deactivate_consensus_pk(node_id: &str) -> bool {
    let mut registry = CONSENSUS_PK_REGISTRY.write();
    match registry.get(node_id) {
        Some(entry) if entry.pinned => {
            eprintln!(
                "[WARN][CONSENSUS] pk_deactivate_refused_pinned node={} reason=genesis_anchor",
                node_id
            );
            false
        }
        Some(_) => {
            registry.remove(node_id);
            LAST_ACTIVITY.remove(node_id);
            println!("[INFO][CONSENSUS] pk_deactivated node={}", node_id);
            true
        }
        None => false,
    }
}

/// Build the canonical challenge string for proof-of-ownership.
/// The joiner MUST sign exactly this byte string with their Dilithium3 key.
#[inline]
pub fn pk_register_challenge(node_id: &str) -> String {
    format!("{}{}", PK_REGISTER_CHALLENGE_PREFIX, node_id)
}

/// Register a genesis node PK WITHOUT proof-of-ownership, but ONLY if the
/// node_id matches an anchored genesis identity AND the PK matches the
/// hard-coded anchor. Used once per process at startup for bootstrap.
///
/// Returns true on success, false if identity is not genesis or PK does not
/// match the anchor. NEVER overwrites an existing entry.
pub fn register_genesis_pk(node_id: &str, pk_bytes: &[u8]) -> bool {
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] genesis_pk_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }

    // Anchored genesis check: PK must match the one baked into this binary.
    // Anchors live in genesis_anchor_pks() and are the source of truth.
    let anchors = genesis_anchor_pks();
    let Some(anchor_pk) = anchors.get(node_id) else {
        eprintln!("[ERR][CONSENSUS] genesis_pk_unknown_identity node={}", node_id);
        return false;
    };
    if anchor_pk.as_slice() != pk_bytes {
        eprintln!("[ERR][CONSENSUS] genesis_pk_mismatch node={} anchor={}.. provided={}..",
                  node_id, hex::encode(&anchor_pk[..8]), hex::encode(&pk_bytes[..8]));
        return false;
    }

    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.pk.as_slice() == pk_bytes {
            // Idempotent re-register
            return true;
        }
        eprintln!("[ERR][CONSENSUS] genesis_pk_already_registered_different node={}", node_id);
        return false;
    }
    let now = now_secs();
    registry.insert(
        node_id.to_string(),
        PkEntry {
            pk: pk_bytes.to_vec(),
            pinned: true, // v20: genesis anchors are NEVER evicted
            registered_at: now,
        },
    );
    drop(registry);
    LAST_ACTIVITY
        .entry(node_id.to_string())
        .or_insert_with(|| std::sync::atomic::AtomicU64::new(now));
    println!(
        "[INFO][CONSENSUS] genesis_pk_registered node={} total={} pinned=true",
        node_id,
        consensus_pk_registry_len()
    );
    true
}

/// Register a node PK whose ownership has already been proven by inclusion
/// of a signature-validated NodeRegistration transaction on-chain.
///
/// This is the production path: when a NodeRegistration TX is applied to
/// state, the block's canonical order + the TX's Dilithium3 signature over
/// `canonical_bytes` already constitute cryptographic proof that the
/// submitter holds the private key corresponding to `pk_bytes`. All nodes
/// processing the same block agree on the (node_id, pk) binding, so there
/// is no network race to squat.
///
/// Anti-squat: if node_id is a genesis identity, PK must match the anchor.
/// Immutability: re-registration with a different PK is rejected.
/// Idempotent: re-registration with the same PK is a no-op.
pub fn register_consensus_pk_from_chain(node_id: &str, pk_bytes: &[u8]) -> bool {
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] chain_pk_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }
    if node_id.is_empty() || node_id.len() > 128 {
        eprintln!("[ERR][CONSENSUS] chain_pk_invalid_node_id len={}", node_id.len());
        return false;
    }

    // Structural validation: PK must parse as a Dilithium3 public key
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    if dilithium3::PublicKey::from_bytes(pk_bytes).is_err() {
        eprintln!("[ERR][CONSENSUS] chain_pk_parse_failed node={}", node_id);
        return false;
    }

    // Anti-squat against genesis anchors (compile-time-installed — optional).
    // NB: in production the primary anti-squat line of defence is IP-based:
    // the P2P layer refuses to even pass a VRF/announce through for a genesis
    // identity unless it arrives from the canonical genesis IP. This anchor
    // check is a defence-in-depth layer for operators who choose to bake PKs
    // into the binary during network fork / upgrade ceremonies.
    let anchors = genesis_anchor_pks();
    if let Some(anchor_pk) = anchors.get(node_id) {
        if anchor_pk.as_slice() != pk_bytes {
            eprintln!("[ERR][CONSENSUS] chain_pk_genesis_squat_attempt node={}", node_id);
            return false;
        }
    }

    // Immutability + capacity (with v20 LRU eviction on cap-full)
    let cap = consensus_pk_registry_cap();
    let idle_threshold = consensus_pk_registry_idle_threshold_secs();
    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.pk.as_slice() == pk_bytes {
            return true;
        }
        eprintln!("[ERR][CONSENSUS] chain_pk_immutable_violation node={}", node_id);
        return false;
    }
    if registry.len() >= cap {
        // Try in-line eviction of one stale entry before rejecting.
        if try_evict_one_stale_entry(&mut registry, idle_threshold).is_none() {
            eprintln!(
                "[WARN][CONSENSUS] pk_registry_full size={} cap={} idle_threshold_secs={} \
                 hint=raise_QNET_PK_REGISTRY_CAP_or_lower_QNET_PK_REGISTRY_IDLE_DAYS",
                registry.len(), cap, idle_threshold
            );
            return false;
        }
    }
    let now = now_secs();
    registry.insert(
        node_id.to_string(),
        PkEntry {
            pk: pk_bytes.to_vec(),
            pinned: false, // v20: chain-registered nodes participate in LRU eviction
            registered_at: now,
        },
    );
    let total = registry.len();
    drop(registry);
    LAST_ACTIVITY
        .entry(node_id.to_string())
        .or_insert_with(|| std::sync::atomic::AtomicU64::new(now));
    if total % 100 == 0 || total < 16 {
        println!("[INFO][CONSENSUS] chain_pk_registered node={} total={} cap={}",
                 node_id, total, cap);
    }
    true
}

/// Register a non-genesis node PK with cryptographic proof-of-ownership.
///
/// The joiner must provide a Dilithium3 detached signature over the canonical
/// challenge string `qnet-pk-register-v1:{node_id}` using the private key
/// corresponding to `pk_bytes`. Signature is verified against `pk_bytes`
/// before the entry is written.
///
/// Returns true on success. Fails if:
///   - pk_bytes is not exactly 1952 bytes
///   - challenge_sig does not verify under pk_bytes
///   - registry is full
///   - node_id is anchored as genesis with a DIFFERENT PK (anti-squat)
///   - node_id is already registered with a DIFFERENT PK (immutability)
pub fn register_consensus_pk_with_proof(
    node_id: &str,
    pk_bytes: &[u8],
    challenge_sig: &[u8],
) -> bool {
    // 1. Structural validation
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] pk_register_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }
    if node_id.is_empty() || node_id.len() > 128 {
        eprintln!("[ERR][CONSENSUS] pk_register_invalid_node_id len={}", node_id.len());
        return false;
    }

    // 2. Anti-squat: if node_id is a genesis identity, PK must match the anchor
    let anchors = genesis_anchor_pks();
    if let Some(anchor_pk) = anchors.get(node_id) {
        if anchor_pk.as_slice() != pk_bytes {
            eprintln!("[ERR][CONSENSUS] pk_register_genesis_squat_attempt node={}", node_id);
            return false;
        }
    }

    // 3. Cryptographic proof-of-ownership: verify Dilithium3 detached signature
    //    over canonical challenge using the pk being registered
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    let public_key = match dilithium3::PublicKey::from_bytes(pk_bytes) {
        Ok(pk) => pk,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_register_parse_failed node={}", node_id);
            return false;
        }
    };
    let detached_sig = match dilithium3::DetachedSignature::from_bytes(challenge_sig) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_register_sig_parse_failed node={}", node_id);
            return false;
        }
    };
    let challenge = pk_register_challenge(node_id);
    if dilithium3::verify_detached_signature(&detached_sig, challenge.as_bytes(), &public_key).is_err() {
        eprintln!("[ERR][CONSENSUS] pk_register_proof_invalid node={}", node_id);
        return false;
    }

    // 4. Immutability + capacity (with v20 LRU eviction on cap-full)
    let cap = consensus_pk_registry_cap();
    let idle_threshold = consensus_pk_registry_idle_threshold_secs();
    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.pk.as_slice() == pk_bytes {
            // Idempotent: same node re-proving same PK is fine
            return true;
        }
        eprintln!("[ERR][CONSENSUS] pk_register_immutable_violation node={}", node_id);
        return false;
    }
    if registry.len() >= cap {
        // Try in-line eviction of one stale entry before rejecting.
        if try_evict_one_stale_entry(&mut registry, idle_threshold).is_none() {
            eprintln!(
                "[WARN][CONSENSUS] pk_registry_full size={} cap={} idle_threshold_secs={} \
                 hint=raise_QNET_PK_REGISTRY_CAP_or_lower_QNET_PK_REGISTRY_IDLE_DAYS",
                registry.len(), cap, idle_threshold
            );
            return false;
        }
    }
    let now = now_secs();
    registry.insert(
        node_id.to_string(),
        PkEntry {
            pk: pk_bytes.to_vec(),
            pinned: false, // v20: proof-registered nodes participate in LRU eviction
            registered_at: now,
        },
    );
    let total = registry.len();
    drop(registry);
    LAST_ACTIVITY
        .entry(node_id.to_string())
        .or_insert_with(|| std::sync::atomic::AtomicU64::new(now));
    println!("[INFO][CONSENSUS] pk_registered_with_proof node={} total={} cap={}",
             node_id, total, cap);
    true
}

/// Check if a node has a registered PK in the consensus layer.
pub fn has_consensus_pk(node_id: &str) -> bool {
    CONSENSUS_PK_REGISTRY.read().contains_key(node_id)
}

/// Retrieve a registered PK (returns None if not registered).
///
/// v20: Every successful lookup updates the activity tracker — the
/// signature-verification path is the canonical "this node is alive" signal
/// for LRU eviction. The update is lock-free (DashMap + AtomicU64), so the
/// read-hot consensus path stays wait-free.
pub fn get_consensus_pk(node_id: &str) -> Option<Vec<u8>> {
    let pk = CONSENSUS_PK_REGISTRY.read().get(node_id).map(|e| e.pk.clone());
    if pk.is_some() {
        observe_pk_activity(node_id);
    }
    pk
}

/// Current registry size (for metrics / diagnostics).
pub fn consensus_pk_registry_len() -> usize {
    CONSENSUS_PK_REGISTRY.read().len()
}

/// Count of pinned (genesis-anchor) entries — never evicted by idle-sweep.
/// Used by tests and diagnostics to verify the pin invariant.
pub fn consensus_pk_registry_pinned_count() -> usize {
    CONSENSUS_PK_REGISTRY.read().values().filter(|e| e.pinned).count()
}

/// Anchored genesis public keys. These 5 nodes form the initial validator set.
/// PKs are derived from the deterministic genesis keypairs shipped in
/// `genesis_constants.rs` in the integration layer. The consensus layer
/// holds the anchored map so that the registry cannot be squatted at boot.
///
/// Returns an empty map until anchored keys are wired in (see
/// `set_genesis_anchor_pks`). This function is intentionally lock-cheap
/// because it's consulted on every registration call.
fn genesis_anchor_pks() -> std::collections::HashMap<String, Vec<u8>> {
    GENESIS_ANCHOR_PKS.read().clone()
}

lazy_static::lazy_static! {
    /// One-shot anchor map, populated at startup by the integration layer
    /// via `set_genesis_anchor_pks`. After the first non-empty installation,
    /// further calls are rejected to keep the anchor immutable.
    static ref GENESIS_ANCHOR_PKS: parking_lot::RwLock<std::collections::HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(std::collections::HashMap::new());
}

/// Read-only access to the genesis anchor for a single identity. Returns
/// None when no anchor map is installed (cold boot before anchor file is
/// loaded) or when `node_id` is not a genesis identity.
///
/// Used by the integration layer at `initialize_wallet_identity` to refuse
/// boot when the locally-loaded keypair does not match the anchored PK,
/// preventing the v15.x pk_mismatch class of incidents.
pub fn get_consensus_pk_anchor(node_id: &str) -> Option<Vec<u8>> {
    GENESIS_ANCHOR_PKS.read().get(node_id).cloned()
}

/// Number of installed genesis anchors. 0 when no anchor file has been
/// loaded yet — used by callers to decide whether to enforce strict binding.
pub fn genesis_anchor_pks_len() -> usize {
    GENESIS_ANCHOR_PKS.read().len()
}

/// Install the genesis anchor PK map. Called exactly once at process start
/// by the integration layer, BEFORE any `register_consensus_pk_with_proof`
/// call, with the deterministic genesis PKs for the 5 anchor nodes.
///
/// Returns true on first successful install, false if anchors are already
/// installed (immutable) or the provided map is structurally invalid.
pub fn set_genesis_anchor_pks(anchors: std::collections::HashMap<String, Vec<u8>>) -> bool {
    if anchors.is_empty() {
        return false;
    }
    for (node_id, pk) in &anchors {
        if pk.len() != 1952 {
            eprintln!("[ERR][CONSENSUS] anchor_install_invalid_pk_size node={} size={}", node_id, pk.len());
            return false;
        }
    }
    let mut guard = GENESIS_ANCHOR_PKS.write();
    if !guard.is_empty() {
        eprintln!("[WARN][CONSENSUS] anchor_install_rejected already_installed={}", guard.len());
        return false;
    }
    let count = anchors.len();
    *guard = anchors;
    println!("[INFO][CONSENSUS] genesis_anchors_installed count={}", count);
    true
}

/// Verify consensus signature using pure Dilithium3 (ML-DSA-65) cryptography
pub async fn verify_consensus_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // SECURITY: Strict validation requirements
    // OPTIMIZED v2.24: Bincode + Zstd format
    // Actual sizes: Compact ~2.6KB bincode, Full ~5KB bincode (vs 27KB JSON legacy)
    if signature.is_empty() || signature.len() < 100 || signature.len() > 18000 {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_signature_length len={} limit=18000", signature.len());
        return false;
    }
    
    // Check signature format
    if signature.starts_with("compact_bin:") {
        // OPTIMIZED v2.24: Binary compact signature (2.6KB vs 5KB JSON!)
        verify_compact_binary_signature(node_id, message, signature).await
    } else if signature.starts_with("compact:") {
        // Legacy: Compact PQ signature JSON (5KB)
        verify_compact_pq_signature(node_id, message, signature).await
    } else if signature.starts_with("pq_bin:") {
        // Binary signature (5KB vs 27KB JSON)
        verify_pq_binary_signature(node_id, message, signature).await
    } else if signature.starts_with("pq:") {
        // Legacy: full signature with certificate JSON (parse-only; no current producer)
        verify_pq_signature(node_id, message, signature).await
    } else if signature.starts_with("dilithium_sig_") {
        // This is a pure Dilithium signature
        verify_dilithium_signature(node_id, message, signature).await
    } else {
        println!("[ERR][CONSENSUS_CRYPTO] unknown_signature_format");
        false
    }
}

/// OPTIMIZED v2.24: Verify compact BINARY signature for microblocks (bincode+zstd)
/// Format: "compact_bin:<base64_bincode_zstd_data>"
/// Size: ~2.6KB (vs 5KB JSON, 50% reduction!)
async fn verify_compact_binary_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    if !signature.starts_with("compact_bin:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_compact_bin_format");
        return false;
    }
    
    let base64_data = &signature[12..]; // Skip "compact_bin:" prefix
    
    // Decode base64
    let binary_data = match general_purpose::STANDARD.decode(base64_data) {
        Ok(data) => data,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] compact_bin_base64_decode_failed err={}", e);
            return false;
        }
    };
    
    // Decompress zstd with a HARD output ceiling.
    //
    // `zstd::decode_all` allocates whatever the stream demands; an adversarial
    // input ~1000× its on-the-wire size could OOM every receiver. Honest
    // compact_bin signatures are ~2.6 KB; the largest plausible variant
    // (`pq_bin` with embedded certificate) is ~5 KB. A 256 KB ceiling
    // is ~50× the largest legitimate payload — generous head-room for future
    // protocol additions while making decompression-bomb DoS impossible
    // in this code path.
    const MAX_COMPACT_BIN_DECOMPRESSED: usize = 256 * 1024;
    let decompressed = match decode_zstd_bounded(binary_data.as_slice(), MAX_COMPACT_BIN_DECOMPRESSED) {
        Ok(data) => data,
        Err(e) => {
            println!(
                "[ERR][CONSENSUS_CRYPTO] compact_bin_decompress_failed input_bytes={} err={}",
                binary_data.len(), e
            );
            return false;
        }
    };
    
    // Deserialize with bincode - use Vec<u8> for serde_bytes compatibility
    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct CompactSig {
        node_id: String,
        cert_serial: String,  // Used for certificate lookup
        #[serde(with = "serde_bytes")]
        dilithium_key_signature: Vec<u8>,
        signed_at: u64,
    }
    
    let compact_sig: CompactSig = match bincode::deserialize(&decompressed) {
        Ok(sig) => sig,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] compact_bin_deserialize_failed err={}", e);
            return false;
        }
    };
    
    // Verify node_id matches
    if compact_sig.node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, compact_sig.node_id);
        return false;
    }
    
    // Decode message hash
    let message_hash = match hex::decode(message) {
        Ok(hash) => hash,
        Err(_) => message.as_bytes().to_vec(),
    };

    // Pure ML-DSA-65 (P8): Dilithium signs the re-rooted preimage message_hash || signed_at.
    // Must use to_le_bytes() to match pq_crypto.rs signing byte-for-byte.
    let mut encapsulated_data = Vec::new();
    encapsulated_data.extend_from_slice(&message_hash);
    encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
    let encapsulated_hex = hex::encode(&encapsulated_data);
    
    // Convert RAW Dilithium bytes to signature format for verification
    // Format: "dilithium_sig_<node_id>_<base64_signature_data>"
    let dilithium_sig_base64 = general_purpose::STANDARD.encode(&compact_sig.dilithium_key_signature);
    let dilithium_sig_string = format!("dilithium_sig_{}_{}", node_id, dilithium_sig_base64);
    
    let dilithium_valid = verify_dilithium_signature(node_id, &encapsulated_hex, &dilithium_sig_string).await;
    
    if !dilithium_valid {
        println!("[ERR][CONSENSUS_CRYPTO] dilithium_verification_failed format=compact_bin");
        return false;
    }
    
    println!("[INFO][CONSENSUS_CRYPTO] compact_bin_signature_verified version=v2.24");
    true
}

/// LEGACY: Verify compact JSON signature for microblocks
/// For macroblocks, full signatures are used (verified by verify_pq_signature)
async fn verify_compact_pq_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse compact signature format: "compact:<json_data>"
    if !signature.starts_with("compact:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_compact_signature_format");
        return false;
    }
    
    let json_data = &signature[8..]; // Skip "compact:" prefix
    
    // SIGNATURE ARCHITECTURE:
    // - Microblocks: Compact signatures with certificate lookup
    // - Macroblocks: Full signatures with embedded certificate
    // - This function only handles microblock verification
    
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_data) {
        // Verify structure has required fields (NIST/Cisco compliance)
        // Pure ML-DSA-65: RAW bytes format (Dilithium is the sole authenticator)
        if parsed.get("node_id").is_some() &&
           parsed.get("cert_serial").is_some() &&
           parsed.get("dilithium_key_signature").is_some() {  // Pure ML-DSA-65: Dilithium is the sole authenticator
            
            // Extract fields from compact signature
            if let (Some(sig_node_id), Some(cert_serial)) = 
                (parsed.get("node_id").and_then(|v| v.as_str()),
                 parsed.get("cert_serial").and_then(|v| v.as_str())) {
                
                // Verify node_id matches
                if sig_node_id != node_id {
                    println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, sig_node_id);
                    return false;
                }
                
                // PRODUCTION: Cryptographic verification with certificate lookup
                // For microblocks, we need the certificate to verify compact signatures
                
                // dilithium_key_signature is RAW bytes (array of u8 in JSON)
                let dilithium_key_bytes: Option<Vec<u8>> = parsed.get("dilithium_key_signature")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        let mut bytes = Vec::new();
                        for val in arr {
                            if let Some(n) = val.as_u64() {
                                if n <= 255 {
                                    bytes.push(n as u8);
                                } else {
                                    return None;
                                }
                            } else {
                                return None;
                            }
                        }
                        Some(bytes)
                    });
                
                // Extract signed_at timestamp for encapsulated_data reconstruction
                let signed_at = parsed.get("signed_at")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                
                // Pure ML-DSA-65 (P8): only the Dilithium sig + timestamp are required
                if dilithium_key_bytes.is_none() || signed_at == 0 {
                    println!("[ERR][CONSENSUS_CRYPTO] compact_sig_missing_components dilithium={} timestamp={}",
                        if dilithium_key_bytes.is_some() {"ok"} else {"missing"},
                        if signed_at > 0 {"ok"} else {"missing"});
                    return false;
                }

                let dilithium_key_raw = dilithium_key_bytes.expect("Checked above");

                // PRODUCTION: Real cryptographic verification with certificates
                // CRITICAL FIX: message is HEX string, must decode to bytes first!
                // sign_message_compact() uses RAW message bytes for hash
                use sha3::{Sha3_256, Digest};
                let message_bytes = match hex::decode(message) {
                    Ok(bytes) => bytes,
                    Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
                };
                let mut hasher = Sha3_256::new();
                hasher.update(&message_bytes);
                let message_hash = hasher.finalize();
                let _message_hash_str = hex::encode(&message_hash); // For debugging if needed
                
                // PRODUCTION: Structural validation at consensus level
                // ARCHITECTURE: Clean separation - core validates structure,
                // development layer (qnet-integration) handles full crypto with certificates
                //
                // Why this architecture:
                // 1. Core modules cannot depend on development modules
                // 2. Certificates are managed at P2P layer (qnet-integration)
                // 3. Full crypto verification happens BEFORE consensus at P2P level:
                //    - node.rs::verify_microblock_signature() for received blocks
                //    - All blocks entering consensus are pre-verified
                // 4. This provides defense-in-depth with clean architecture
                
                // Validate RAW bytes Dilithium signature
                if dilithium_key_raw.len() < 2500 {
                    println!("[ERR][CONSENSUS_CRYPTO] invalid_dilithium_key_sig_size size={} min=2500", dilithium_key_raw.len());
                    return false;
                }

                // Pure ML-DSA-65 (P8): Dilithium signs the re-rooted preimage message_hash || signed_at
                let mut encapsulated_data = Vec::new();
                encapsulated_data.extend_from_slice(&message_hash);
                encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
                let encapsulated_hex = hex::encode(&encapsulated_data);
                
                // Convert RAW bytes back to signature string format for verify_dilithium_signature
                let dilithium_sig_string = format!(
                    "dilithium_sig_{}_{}",
                    node_id,
                    general_purpose::STANDARD.encode(&dilithium_key_raw)
                );
                
                // Verify Dilithium KEY signature (binds ephemeral key + message + timestamp)
                let dilithium_key_valid = verify_dilithium_signature(
                    node_id,
                    &encapsulated_hex,  // CRITICAL: Use encapsulated_data, not just message_hash!
                    &dilithium_sig_string
                ).await;
                
                if !dilithium_key_valid {
                    println!("[ERR][CONSENSUS_CRYPTO] dilithium_signature_verification_failed note=possible_quantum_attack");
                    return false;
                }
                
                println!("[INFO][CONSENSUS_CRYPTO] signatures_verified node={} cert={} dilithium=ok", node_id, cert_serial);
                
                return true;
            }
        }
    }
    
    println!("[ERR][CONSENSUS_CRYPTO] compact_signature_structure_invalid");
    false
}

/// OPTIMIZED v2.24: Verify binary PQ (Dilithium3) signature (bincode+zstd instead of JSON)
/// Size: ~5KB vs 27KB JSON - 81% reduction!
async fn verify_pq_binary_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse binary signature format: "pq_bin:<base64_bincode_data>" (strip_prefix — no length coupling)
    let base64_data = match signature.strip_prefix("pq_bin:") {
        Some(rest) => rest,
        None => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_pq_bin_format");
            return false;
        }
    };
    
    // Decode base64
    let binary_data = match general_purpose::STANDARD.decode(base64_data) {
        Ok(data) => data,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] pq_bin_base64_decode_failed err={}", e);
            return false;
        }
    };
    
    println!("[INFO][CONSENSUS_CRYPTO] verifying_pq_bin_signature size_kb={}", binary_data.len() / 1024);
    
    // Decompress and deserialize
    use std::io::Read;
    let mut decoder = match zstd::Decoder::new(&binary_data[..]) {
        Ok(d) => d,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] zstd_decode_failed err={}", e);
            return false;
        }
    };
    let mut decompressed = Vec::new();
    if let Err(e) = decoder.read_to_end(&mut decompressed) {
        println!("[ERR][CONSENSUS_CRYPTO] zstd_read_failed err={}", e);
        return false;
    }
    
    // Deserialize bincode to get signature components
    // We use serde_json::Value as intermediate since bincode struct may differ
    #[derive(serde::Deserialize)]
    struct BinaryPqSignature {
        certificate: BinaryCertificate,
        #[serde(with = "serde_bytes")]
        dilithium_key_signature: Vec<u8>,
        signed_at: u64,
    }

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct BinaryCertificate {
        node_id: String,
        dilithium_signature: String,
        issued_at: u64,
        expires_at: u64,  // Used for certificate expiration check
        serial_number: String,
    }
    
    let sig: BinaryPqSignature = match bincode::deserialize(&decompressed) {
        Ok(s) => s,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] bincode_deserialize_failed err={}", e);
            return false;
        }
    };
    
    // Verify certificate belongs to claimed node
    if sig.certificate.node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] cert_node_id_mismatch cert_node={} expected={}", sig.certificate.node_id, node_id);
        return false;
    }
    
    // Check certificate expiration with GRACE PERIOD
    // v2.64: 60 second grace period for network propagation delays (intercontinental latency)
    const CERTIFICATE_GRACE_PERIOD_SECS: u64 = 60;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now > sig.certificate.expires_at + CERTIFICATE_GRACE_PERIOD_SECS {
        println!("[ERR][CONSENSUS_CRYPTO] certificate_expired grace_period_secs={}", CERTIFICATE_GRACE_PERIOD_SECS);
        return false;
    }
    
    // Compute message hash
    // CRITICAL FIX: message is HEX string, must decode to bytes first!
    // sign_message() hashes RAW bytes, so we must match that
    use sha3::{Sha3_256, Digest};
    let message_bytes = match hex::decode(message) {
        Ok(bytes) => bytes,
        Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
    };
    let mut hasher = Sha3_256::new();
    hasher.update(&message_bytes);
    let message_hash = hasher.finalize();
    
    // Pure ML-DSA-65 (P8): Dilithium signs the re-rooted preimage message_hash || signed_at
    let mut encapsulated_data = Vec::new();
    encapsulated_data.extend_from_slice(&message_hash);
    encapsulated_data.extend_from_slice(&sig.signed_at.to_le_bytes());
    let encapsulated_hex = hex::encode(&encapsulated_data);
    
    // Convert RAW bytes back to signature string format for verification
    let dilithium_sig_string = format!(
        "dilithium_sig_{}_{}",
        node_id,
        general_purpose::STANDARD.encode(&sig.dilithium_key_signature)
    );
    
    // Verify Dilithium KEY signature (covers message_hash + timestamp)
    let dilithium_key_valid = verify_dilithium_signature(
        node_id,
        &encapsulated_hex,
        &dilithium_sig_string,
    ).await;
    
    if !dilithium_key_valid {
        println!("[ERR][CONSENSUS_CRYPTO] dilithium_key_sig_verification_failed");
        return false;
    }
    
    // Pure ML-DSA-65 (P8): the Dilithium key signature (sole authenticator) covers the re-rooted
    // preimage message_hash || signed_at. Ed25519 legs and struct fields are fully removed.
    println!("[INFO][CONSENSUS_CRYPTO] pq_bin_signature_verified format=bincode");
    true
}

/// Verify PQ signature (pure Dilithium3 / ML-DSA-65 with certificate)
/// CRITICAL FIX: Now performs REAL Dilithium verification per NIST/Cisco requirements
async fn verify_pq_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse signature format: "pq:<json_data>" (strip_prefix — no length coupling)
    let json_data = match signature.strip_prefix("pq:") {
        Some(rest) => rest,
        None => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_pq_signature_format");
            return false;
        }
    };
    
    // Parse JSON to extract signature components
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_data) {
        // Check required fields
        let has_certificate = parsed.get("certificate").is_some();

        // OPTIMIZED v2.23: Parse RAW bytes from JSON array
        let dilithium_key_bytes: Option<Vec<u8>> = parsed.get("dilithium_key_signature")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                let mut bytes = Vec::new();
                for val in arr {
                    if let Some(n) = val.as_u64() {
                        if n <= 255 {
                            bytes.push(n as u8);
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                }
                Some(bytes)
            });
            
        let signed_at = parsed.get("signed_at")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        
        if !has_certificate {
            println!("[ERR][CONSENSUS_CRYPTO] pq_sig_missing_required_fields");
            return false;
        }

        // Pure ML-DSA-65: verify with the Dilithium sig (sole authenticator)
        if let Some(dilithium_raw) = dilithium_key_bytes {
            if signed_at > 0 {
                println!("[INFO][CONSENSUS_CRYPTO] verifying_pq_dilithium_signature");
                
                // Compute message hash
                // CRITICAL FIX: message is HEX string, must decode to bytes first!
                use sha3::{Sha3_256, Digest};
                let message_bytes = match hex::decode(message) {
                    Ok(bytes) => bytes,
                    Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
                };
                let mut hasher = Sha3_256::new();
                hasher.update(&message_bytes);
                let message_hash = hasher.finalize();
                
                let mut encapsulated_data = Vec::new();
                encapsulated_data.extend_from_slice(&message_hash);
                encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
                let encapsulated_hex = hex::encode(&encapsulated_data);
                
                // Convert RAW bytes back to signature string format
                let dilithium_sig_string = format!(
                    "dilithium_sig_{}_{}",
                    node_id,
                    general_purpose::STANDARD.encode(&dilithium_raw)
                );
                
                // Verify Dilithium KEY signature (covers message_hash + timestamp)
                let dilithium_key_valid = verify_dilithium_signature(
                    node_id,
                    &encapsulated_hex,
                    &dilithium_sig_string
                ).await;
                
                if !dilithium_key_valid {
                    println!("[ERR][CONSENSUS_CRYPTO] pq_dilithium_signature_failed");
                    return false;
                }
                
                println!("[INFO][CONSENSUS_CRYPTO] pq_signature_verified node={} dilithium=ok", node_id);
                return true;
            }
        }
        
        // SECURITY: Legacy bypass REMOVED — Dilithium verification is MANDATORY
        // PQ signatures without valid Dilithium fields are rejected
        println!("[WARN][CONSENSUS_CRYPTO] pq_sig_rejected reason=missing_dilithium_fields");
        return false;
    }

    println!("[ERR][CONSENSUS_CRYPTO] invalid_pq_signature_structure");
    false
}

/// Verify pure Dilithium signature
async fn verify_dilithium_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // PRODUCTION: Parse Dilithium signature format
    if !signature.starts_with("dilithium_sig_") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_signature_format expected_prefix=dilithium_sig_");
        return false;
    }
    
    let prefix = "dilithium_sig_";
    let signature_part = &signature[prefix.len()..];
    
    // Find the LAST '_' to separate node_id from base64 signature
    let last_underscore_pos = signature_part.rfind('_');
    if last_underscore_pos.is_none() {
        println!("[ERR][CONSENSUS_CRYPTO] signature_format_invalid missing=separator");
        return false;
    }
    
    let separator_pos = last_underscore_pos.expect("Checked is_none above");
    let extracted_node_id = &signature_part[..separator_pos];
    let signature_base64 = &signature_part[separator_pos + 1..];
    
    // Validate extracted node_id matches expected
    if extracted_node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, extracted_node_id);
        return false;
    }
    
    // Decode base64 signature
    let signature_bytes = match general_purpose::STANDARD.decode(signature_base64) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[ERR][CONSENSUS] sig_base64_decode_failed node={} err={}", node_id, e);
            return false;
        }
    };

    // Combined format: [sig_len(4)] + [SignedMessage(sig+msg)] + [pk_len(4)] + [pk(1952)]
    // Minimum size: ML-DSA-65 signature (3309 bytes) + message + metadata
    if signature_bytes.len() < 3309 {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_too_small node={} size={} min=3309",
                 node_id, signature_bytes.len()));
        return false;
    }

    // CRITICAL: Call actual ML-DSA-65 verification through async runtime
    let valid = verify_with_real_dilithium(node_id, message, &signature_bytes).await;

    if valid {
        println!("[INFO][CONSENSUS] sig_verified node={}", node_id);
    } else {
        // Governed: a spoofer flooding garbage under a claimed identity
        // would otherwise emit one of these per frame. Rejection is
        // already final (the inner verify returned false); this only
        // rate-limits the log line.
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_invalid node={}", node_id));
    }

    valid
}

/// Verify signature with real CRYSTALS-Dilithium
async fn verify_with_real_dilithium(
    node_id: &str,
    message: &str,
    signature_bytes: &[u8],
) -> bool {
    // Verify signature structure: all-zero is trivially invalid
    if signature_bytes.iter().all(|&b| b == 0) {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_all_zeros node={}", node_id));
        return false;
    }

    // Entropy check on the ML-DSA-65 signature part (3309 bytes, CTILDEBYTES=48)
    let sig_part = &signature_bytes[..std::cmp::min(3309, signature_bytes.len())];
    let unique_bytes: std::collections::HashSet<_> = sig_part.iter().collect();
    if unique_bytes.len() < 200 {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_low_entropy node={} unique={} threshold=200",
                 node_id, unique_bytes.len()));
        return false;
    }

    // Parse combined format: [sig_len(4)] + [SignedMessage(sig+msg)] + [pk_len(4)] + [pk(1952)]
    if signature_bytes.len() < 8 {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_too_short node={} size={}", node_id, signature_bytes.len()));
        return false;
    }

    let signed_len = u32::from_le_bytes([
        signature_bytes[0],
        signature_bytes[1],
        signature_bytes[2],
        signature_bytes[3],
    ]) as usize;

    // ML-DSA-65 SignedMessage must be at least 3309 bytes (sig) + 1 byte (msg) = 3310 minimum
    if signed_len <= 3309 || 4 + signed_len >= signature_bytes.len() {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_format_invalid node={} signed_len={}", node_id, signed_len));
        return false;
    }
    
    // Extract public key from the end of signature
    let pk_len_start = 4 + signed_len;
    if pk_len_start + 4 > signature_bytes.len() {
        println!("[ERR][CONSENSUS_CRYPTO] missing_public_key_length_field");
        return false;
    }
    
    let pk_len = u32::from_le_bytes([
        signature_bytes[pk_len_start],
        signature_bytes[pk_len_start + 1],
        signature_bytes[pk_len_start + 2],
        signature_bytes[pk_len_start + 3],
    ]) as usize;
    
    let pk_start = pk_len_start + 4;
    
    // CRITICAL: Dilithium3 public key MUST be exactly 1952 bytes (NIST standard)
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    if pk_len != dilithium3::public_key_bytes() {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] pk_size_invalid node={} got={} expected={}",
                 node_id, pk_len, dilithium3::public_key_bytes()));
        return false;
    }

    if pk_start + pk_len != signature_bytes.len() {
        log_sig_reject(node_id, &format!("[ERR][CONSENSUS] sig_len_mismatch node={}", node_id));
        return false;
    }

    // Extract components
    let signed_message_bytes = &signature_bytes[4..4 + signed_len];
    let public_key_bytes = &signature_bytes[pk_start..pk_start + pk_len];

    // ─────────────────────────────────────────────────────────────────────
    // Permanent attacker-PK fast path (defence-in-depth).
    // ─────────────────────────────────────────────────────────────────────
    // O(1) DashMap lookup. If this PK has been recorded as an impersonator
    // in a prior verification (current run or replayed from durable
    // storage on boot via `seed_attacker_pk_blacklist`), drop the message
    // here — before the registry-lock dance and the ~3.3 KB Dilithium3
    // open call. We bump the offense counter so telemetry stays correct
    // and persistence reflects renewed activity, but emit no log line:
    // the original `[CRIT][SECURITY] attacker_pk_blacklisted` discovery
    // event is the canonical record; subsequent silent drops are the
    // expected steady state.
    if is_pk_blacklisted(public_key_bytes) {
        let _ = record_attacker_pk(public_key_bytes, node_id);
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Identity → public-key binding policy (three tiers)
    // ─────────────────────────────────────────────────────────────────────
    //
    // Tier 1 (HARD MATCH): registry has a binding for `node_id` and the
    //   extracted PK matches it. The signature is identity-bound.
    //
    // Tier 2 (HARD REJECT — non-match): registry has a binding for `node_id`
    //   and the extracted PK does NOT match. This is a hostile identity
    //   claim — a peer holding their own valid Dilithium3 keypair attempting
    //   to spoof an already-bound identity. Reject. There is NO legitimate
    //   reason to accept a different PK for an identity once the registry
    //   has locked one in (registry entries are immutable for the process
    //   lifetime; see register_consensus_pk_from_chain immutability check).
    //
    // Tier 3 (POLICY-DEPENDENT — no binding):
    //   * If `node_id` matches a Genesis pattern (`"genesis_node_*"`):
    //     HARD REJECT. Genesis identities MUST be in the registry before any
    //     inbound signature is accepted. They are populated either by
    //       (1) self-registration at boot (initialize_wallet_identity calls
    //           register_consensus_pk_from_chain with the local keypair
    //           BEFORE P2P comes up); or
    //       (2) the genesis anchor file shipped by the operator
    //           (install_genesis_anchors_at_startup, then anchored PKs are
    //           embedded into the genesis NodeRegistration TX which feeds
    //           cache_node_registrations_from_transactions_with_dashmap →
    //           register_consensus_pk_from_chain).
    //     Accepting a first-seen Genesis PK here would lock the identity to
    //     whatever PK the network sees first, opening the squat-on-bootstrap
    //     window that the anchor system exists to close.
    //   * Otherwise (Super-node, Light-node, generic identity):
    //     Accept (TOFV) and continue to math verification. Super-node
    //     identities reach steady-state binding via signed
    //     `NodeRegistration` TX (proof-of-ownership in the TX payload),
    //     which is applied to chain state and mirrored into this registry
    //     before any cross-restart binding is needed. The TOFV path lets
    //     a freshly-joined Super-node's first announcement be accepted in
    //     the small window between its TX broadcast and chain finality.
    //
    // NOTE on math: regardless of tier, the Dilithium3 signature is
    // cryptographically verified under `dilithium3::open` further down. This
    // tier block only governs the identity → key binding decision, not the
    // mathematical validity of the signature itself.
    //
    // SCALABILITY: registry uses parking_lot::RwLock + HashMap with capacity
    // 50K — supports tens of thousands of Super-nodes. Read path is
    // wait-free; the write path runs exactly once per identity registration
    // (one-shot per node lifetime). The genesis prefix check is a fixed-cost
    // string comparison — O(1) regardless of network size.
    {
        let registry = CONSENSUS_PK_REGISTRY.read();
        match registry.get(node_id) {
            Some(entry) if entry.pk.as_slice() == public_key_bytes => {
                // Tier 1: bound and matches — proceed to math verification.
                // v20: drop the read lock BEFORE recording activity so the
                // hot path stays wait-free.
                drop(registry);
                observe_pk_activity(node_id);
            }
            Some(entry) => {
                // Tier 2: bound, mismatch — hostile identity claim. Hard reject.
                //
                // SECURITY ESCALATION (v25.1): CONSENSUS_PK_REGISTRY is
                // immutable once bound — every node controls exactly one
                // identity keypair. A mismatch is therefore conclusive
                // evidence of an impersonation attempt: there is NO
                // legitimate cause. We:
                //
                //   1. Hard-reject the math step (always — correctness
                //      boundary).
                //   2. Permanently blacklist the attacker's extracted PK
                //      by SHA3-256 fingerprint, mirrored to durable
                //      storage when the integrator has installed a
                //      persistence callback.
                //   3. Emit exactly ONE `[CRIT][SECURITY]` discovery log
                //      line on first sighting of this attacker key; all
                //      subsequent rejections from the same PK are silent
                //      (the entry counts up but produces no log noise).
                //
                // Upstream layers (QUIC handshake, consensus dispatcher)
                // consult `is_pk_blacklisted` BEFORE reaching this code
                // path, so a recidivist attacker is dropped at the
                // transport boundary and never causes a verification
                // attempt. This site is the install path for new
                // attacker keys and the last-line backstop.
                let pk_for_log = hex::encode(&public_key_bytes[..8.min(public_key_bytes.len())]);
                let registered_for_log = hex::encode(&entry.pk[..8.min(entry.pk.len())]);
                drop(registry);
                let (record, was_first) = record_attacker_pk(public_key_bytes, node_id);
                if was_first {
                    eprintln!(
                        "[CRIT][SECURITY] attacker_pk_blacklisted node={} registered={}.. extracted={}.. first_seen={} action=permanent_ban",
                        node_id,
                        registered_for_log,
                        pk_for_log,
                        record.first_seen_unix_s,
                    );
                }
                return false;
            }
            None => {
                // Tier 3: policy depends on identity class.
                if node_id.starts_with("genesis_node_") {
                    // Genesis identity with no registry binding. Three causes:
                    //   (a) a race against a not-yet-completed self-register
                    //       — transient, resolves once the legitimate sender's
                    //       VrfKeyAnnounce or self-register completes;
                    //   (b) a squat attempt from a non-genesis peer
                    //       presenting their own keypair under a genesis
                    //       node_id; or
                    //   (c) the FIRST sync of a fresh-bootstrap cluster: the
                    //       anchor file does not yet exist and the
                    //       cross-registration round-trip via VrfKeyAnnounce
                    //       has not completed for this peer yet.
                    //
                    // v19.1: The previous policy was a blanket hard-reject.
                    // That broke case (c) end-to-end — fresh genesis clusters
                    // could not bootstrap because the very first cross-peer
                    // consensus message was rejected before the registry
                    // could be populated, leaving every genesis node
                    // permanently isolated.
                    //
                    // Aligned policy:
                    //   * If anchors are loaded (`genesis_anchor_pks_len() > 0`),
                    //     the registry MUST already contain every genesis PK
                    //     (anchors are mirrored into the registry at install
                    //     time). A Tier-3 hit on a genesis identity in that
                    //     state is an actual squat attempt → hard reject.
                    //   * If anchors are absent AND `QNET_BOOTSTRAP_FRESH=1`
                    //     is set (operator opted into the fresh-bootstrap
                    //     race window — same gate that allows the process
                    //     to start in `anchors_missing_boot_decision`), this
                    //     is case (c). Admit (TOFV) and let signature math
                    //     below decide the outcome. An attacker without the
                    //     SK for the claimed PK cannot produce a valid
                    //     signature, so the cryptographic floor is
                    //     preserved; the only state we relax is the
                    //     anchor-binding precheck — which by definition does
                    //     not exist yet during fresh bootstrap.
                    //   * Otherwise (no anchors AND no opt-in) it is a
                    //     misconfigured deploy. Hard reject so the operator
                    //     sees the failure and either deploys anchors or
                    //     opts into fresh mode explicitly.
                    //
                    // Security note: the TOFV admit DOES NOT register the
                    // PK. Registration happens through:
                    //   (1) `VrfKeyAnnounce` handler (inline self-signature
                    //       verify + register_consensus_pk_from_chain), or
                    //   (2) signed `NodeRegistration` TX application.
                    // Both are themselves cryptographic proofs of ownership.
                    // Tier-3 here only widens the message-acceptance gate
                    // during the documented fresh window so those
                    // registration flows can complete.
                    let extracted_prefix = if public_key_bytes.len() >= 8 {
                        hex::encode(&public_key_bytes[..8])
                    } else {
                        String::new()
                    };
                    let anchors_loaded = genesis_anchor_pks_len() > 0;
                    let fresh_opt_in =
                        std::env::var("QNET_BOOTSTRAP_FRESH").as_deref() == Ok("1");
                    if tier3_genesis_first_seen_admit(anchors_loaded, fresh_opt_in) {
                        // Case (c): admit TOFV, signature math below is the gate.
                        println!(
                            "[WARN][CONSENSUS] genesis_pk_first_seen_admit_fresh_window \
                             node={} extracted={}.. anchors_loaded=false bootstrap_fresh=true \
                             hint=signature_math_will_decide",
                            node_id, extracted_prefix
                        );
                        // fall through to math verification
                    } else {
                        eprintln!(
                            "[CRIT][CONSENSUS] genesis_pk_first_seen_rejected node={} extracted={}.. \
                             anchors_loaded={} bootstrap_fresh={} action=hard_reject \
                             hint=deploy_anchors_or_set_QNET_BOOTSTRAP_FRESH",
                            node_id, extracted_prefix, anchors_loaded, fresh_opt_in
                        );
                        return false;
                    }
                } else {
                    // Non-genesis identity (Super-node, Light-node, etc.). TOFV
                    // is acceptable; chain-state will lock the canonical binding
                    // shortly via NodeRegistration TX application, after which
                    // any future mismatch is caught by Tier 2 above.
                    if public_key_bytes.len() >= 8 {
                        println!("[WARN][CONSENSUS] pk_first_seen node={} extracted={}..",
                                 node_id, hex::encode(&public_key_bytes[..8]));
                    }
                }
            }
        }
    }

    // Parse ML-DSA-65 public key
    let public_key = match dilithium3::PublicKey::from_bytes(public_key_bytes) {
        Ok(pk) => pk,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_parse_failed node={}", node_id);
            return false;
        }
    };

    // Parse SignedMessage (signature + message combined)
    let signed_message = match dilithium3::SignedMessage::from_bytes(signed_message_bytes) {
        Ok(sm) => sm,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] signed_msg_parse_failed node={}", node_id);
            return false;
        }
    };

    // ML-DSA-65 (FIPS 204) verification via pqcrypto-mldsa
    match dilithium3::open(&signed_message, &public_key) {
        Ok(recovered_message) => {
            let expected_msg = message.as_bytes();
            // Constant-time comparison to prevent timing side-channel attacks
            if ct_eq(recovered_message.as_slice(), expected_msg) {
                println!("[INFO][CONSENSUS] mldsa65_verified node={} pk={}...",
                         node_id, hex::encode(&public_key_bytes[..8]));
                return true;
            } else {
                // Recovered != expected: stale/cross-round signature or forgery. Rejection
                // is unconditional (security boundary); expected at low rate ⇒ WARN, not ERR.
                eprintln!("[WARN][CONSENSUS] sig_reject node={} reason=msg_mismatch", node_id);
                return false;
            }
        }
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] mldsa65_verify_failed node={}", node_id);
            return false;
        }
    }
}

/// Verify a consensus Dilithium3 signature against an EXPLICIT expected public key, bypassing the
/// in-RAM CONSENSUS_PK_REGISTRY identity binding. Burn-attestation validation MUST be a pure
/// function of on-chain state: the registry is RAM-resident + idle-evicted (non-deterministic across
/// nodes → fork) and its Tier-3 path TOFV-accepts a first-seen PK (forge surface for non-genesis).
/// Here the PK embedded in the signature MUST equal `expected_pk` (the caller's on-chain key:
/// load_vrf_public_key, or a pinned genesis anchor); only then is the ML-DSA-65 math run. Same
/// signature wire format as verify_with_real_dilithium; identity binding is the explicit PK match.
pub async fn verify_consensus_signature_bound(
    node_id: &str, message: &str, signature: &str, expected_pk: &[u8],
) -> bool {
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    if !signature.starts_with("dilithium_sig_") { return false; }
    let part = &signature["dilithium_sig_".len()..];
    let sep = match part.rfind('_') { Some(p) => p, None => return false };
    if &part[..sep] != node_id { return false; } // sig carries its claimed id; must match
    let bytes = match general_purpose::STANDARD.decode(&part[sep + 1..]) { Ok(b) => b, Err(_) => return false };
    if bytes.len() < 8 { return false; }
    // Combined format: [sig_len(4)] + [SignedMessage] + [pk_len(4)] + [pk(1952)] (same as verify path).
    let signed_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if signed_len <= 3309 || 4 + signed_len >= bytes.len() { return false; }
    let pk_len_start = 4 + signed_len;
    if pk_len_start + 4 > bytes.len() { return false; }
    let pk_len = u32::from_le_bytes([
        bytes[pk_len_start], bytes[pk_len_start + 1], bytes[pk_len_start + 2], bytes[pk_len_start + 3],
    ]) as usize;
    let pk_start = pk_len_start + 4;
    if pk_len != dilithium3::public_key_bytes() || pk_start + pk_len != bytes.len() { return false; }
    let signed_message_bytes = &bytes[4..4 + signed_len];
    let public_key_bytes = &bytes[pk_start..pk_start + pk_len];
    // On-chain identity binding: the embedded PK MUST be the node's registered key. Deterministic
    // (expected_pk comes from finalized state) and forge-proof (wrong PK rejected before open).
    if public_key_bytes != expected_pk { return false; }
    let public_key = match dilithium3::PublicKey::from_bytes(public_key_bytes) { Ok(p) => p, Err(_) => return false };
    let signed_message = match dilithium3::SignedMessage::from_bytes(signed_message_bytes) { Ok(s) => s, Err(_) => return false };
    match dilithium3::open(&signed_message, &public_key) {
        Ok(recovered) => ct_eq(recovered.as_slice(), message.as_bytes()),
        Err(_) => false,
    }
}

/// Constant-time byte slice comparison -- prevents timing side-channel attacks.
/// Returns true only if slices are equal in length and content.
/// FIX L-C2ct: Also constant-time for length to prevent length-based timing leaks.
#[inline(never)]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        // Still do full comparison to avoid timing leak on length mismatch
        let max_len = a.len().max(b.len());
        let mut result: u8 = 1; // Start with "not equal" since lengths differ
        for i in 0..max_len {
            let byte_a = a.get(i).copied().unwrap_or(0);
            let byte_b = b.get(i).copied().unwrap_or(0);
            result |= byte_a ^ byte_b;
        }
        std::hint::black_box(result);
        return false; // Always false for different lengths, but took constant time
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    // Use black_box to prevent compiler from optimising the loop away
    std::hint::black_box(diff) == 0
}

/// Decompress zstd bytes with a hard output ceiling.
///
/// Used by every signature-format verifier on the inbound P2P path so a
/// hostile peer cannot weaponise zstd's typical-thousand-fold expansion
/// ratio into an OOM. The streaming `Read::take` adapter caps the total
/// bytes read from the decoder; a payload that decodes to more than
/// `max_output_bytes` short-circuits with `Err(InvalidData)` before the
/// inner buffer is allowed to grow further.
///
/// Scalability: O(N) in `output_size`. The pre-sized `Vec` capacity is
/// 1 MiB or `max_output_bytes` (whichever is smaller), so small-but-
/// frequent verifications do not pay a full max-size allocation each call.
pub(crate) fn decode_zstd_bounded(input: &[u8], max_output_bytes: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = zstd::Decoder::new(input)?;
    let initial_cap = max_output_bytes.min(1 * 1024 * 1024);
    let mut output: Vec<u8> = Vec::with_capacity(initial_cap);
    let cap_plus_one = max_output_bytes.saturating_add(1) as u64;
    let mut bounded = decoder.by_ref().take(cap_plus_one);
    let _ = bounded.read_to_end(&mut output)?;
    if output.len() > max_output_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "decompressed_size_exceeds_cap output_bytes={} cap_bytes={}",
                output.len(), max_output_bytes
            ),
        ));
    }
    Ok(output)
}

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — Fix #20 (bounded zstd) + Tier-3 binding policy
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests_v17_security {
    use super::*;

    fn zstd_compress_for_test(input: &[u8]) -> Vec<u8> {
        zstd::encode_all(input, 1).expect("zstd encode for test must succeed")
    }

    /// Fix #20: decoded bytes equal input on a payload below the cap.
    #[test]
    fn decode_zstd_bounded_accepts_payload_below_cap() {
        let original = b"compact_bin signature test payload".to_vec();
        let compressed = zstd_compress_for_test(&original);
        let decoded = decode_zstd_bounded(&compressed, 1024).expect("below cap must decode");
        assert_eq!(decoded, original);
    }

    /// Fix #20: an exact-cap payload is accepted; the implementation's
    /// `cap_plus_one` reader plus `<= cap` post-check allow equality.
    #[test]
    fn decode_zstd_bounded_accepts_payload_at_exact_cap() {
        let original = vec![0x55u8; 5 * 1024];
        let compressed = zstd_compress_for_test(&original);
        let decoded = decode_zstd_bounded(&compressed, original.len())
            .expect("exact-size must decode");
        assert_eq!(decoded.len(), original.len());
    }

    /// Fix #20: decoded bytes one over the cap MUST yield InvalidData.
    /// Regression here re-opens the bomb class on the consensus layer.
    #[test]
    fn decode_zstd_bounded_rejects_payload_above_cap() {
        let original = vec![0xAAu8; 2048];
        let compressed = zstd_compress_for_test(&original);
        let result = decode_zstd_bounded(&compressed, original.len() - 1);
        assert!(result.is_err(), "must reject above-cap output");
        let err = result.err().unwrap();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("decompressed_size_exceeds_cap"));
    }

    /// Fix #20: classic decompression bomb — small input, huge output.
    /// The cap is on OUTPUT bytes, not input bytes; a small input that
    /// expands far past the cap MUST be rejected even though the input
    /// alone is well within any reasonable network packet size.
    #[test]
    fn decode_zstd_bounded_rejects_high_ratio_bomb() {
        // 512 KB of zeros compresses to a few KB — but exceeds an 8 KB
        // output cap by ~64×. Real-world bombs hit 1000× ratios.
        let original = vec![0u8; 512 * 1024];
        let compressed = zstd_compress_for_test(&original);
        assert!(compressed.len() < 8 * 1024,
            "fixture sanity: compressed payload must be small relative to original");
        let result = decode_zstd_bounded(&compressed, 8 * 1024);
        assert!(result.is_err(), "decompression bomb must be rejected on output cap");
    }

    /// Fix #20: malformed zstd input MUST return Err (and not panic) so a
    /// hostile peer cannot crash the verifier with a bogus stream.
    #[test]
    fn decode_zstd_bounded_rejects_malformed_input() {
        let garbage: Vec<u8> = (0..256).map(|i| (i * 31 + 17) as u8).collect();
        let result = decode_zstd_bounded(&garbage, 4096);
        assert!(result.is_err(), "malformed zstd must error gracefully");
    }

    /// Fix #20: empty payload decodes to empty output without error.
    /// Edge case ensures the bounded reader does not regress to a
    /// "minimum 1 byte" requirement.
    #[test]
    fn decode_zstd_bounded_empty_payload_round_trip() {
        let compressed = zstd_compress_for_test(&[]);
        let decoded = decode_zstd_bounded(&compressed, 4096).expect("empty must decode");
        assert!(decoded.is_empty());
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v20: REGRESSION TESTS — PK REGISTRY SCALING
// ═══════════════════════════════════════════════════════════════════════════
// These tests verify the LRU + idle-eviction + pinned-anchor invariants of
// the v20 consensus PK registry. The registry is a process-wide singleton,
// so cargo's parallel test workers share state. Each test below isolates
// its assertions to UNIQUE node_ids it owns — collisions with the genesis
// anchor namespace or other tests' keys are avoided by a per-test prefix.
//
// Each test exercises a SECURITY or LIVENESS property:
//   * pinned anchors must NEVER be evicted (BFT safety — verifies depend on
//     anchored PKs being available even after long stalls)
//   * LRU eviction must respect the idle-threshold (no false-positive evict)
//   * cap-full path must attempt eviction before rejecting a new joiner
//   * deactivation must refuse to remove pinned entries
//   * env override must control runtime cap / idle-threshold
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests_v20_pk_registry {
    use super::*;
    use std::sync::atomic::Ordering;

    /// Build a syntactically valid 1952-byte Dilithium3 PK seed for tests.
    /// Real cryptographic validity is irrelevant for these registry-level
    /// tests because they exercise the storage + eviction logic, not the
    /// signature math (covered separately by `tests_v17_security`).
    fn fake_pk_bytes(seed: u8) -> Vec<u8> {
        // Build deterministic 1952 bytes; structural parsing checks are
        // exercised in their dedicated tests, not here.
        let mut v = vec![seed; 1952];
        // Make first byte distinct per seed for easier debug output
        v[0] = seed;
        v
    }

    /// Helper that bypasses parse-validation for tests. Inserts a synthetic
    /// entry directly into the registry under a test-owned key prefix.
    /// Pinned flag controls whether LRU eviction can later remove it.
    fn install_test_entry(node_id: &str, pk_bytes: &[u8], pinned: bool, last_seen: u64) {
        let mut registry = CONSENSUS_PK_REGISTRY.write();
        registry.insert(
            node_id.to_string(),
            PkEntry {
                pk: pk_bytes.to_vec(),
                pinned,
                registered_at: last_seen,
            },
        );
        drop(registry);
        LAST_ACTIVITY
            .entry(node_id.to_string())
            .and_modify(|t| t.store(last_seen, Ordering::Relaxed))
            .or_insert_with(|| std::sync::atomic::AtomicU64::new(last_seen));
    }

    fn cleanup_test_entry(node_id: &str) {
        CONSENSUS_PK_REGISTRY.write().remove(node_id);
        LAST_ACTIVITY.remove(node_id);
    }

    /// Pinned (genesis-anchor) entries MUST survive an idle sweep regardless
    /// of how long they have been silent. BFT safety relies on anchored PKs
    /// being available for verification when a recovered genesis node
    /// re-broadcasts after a long offline window.
    #[test]
    fn pinned_anchor_survives_idle_sweep() {
        let id = "v20_test_pinned_anchor_survives";
        let pk = fake_pk_bytes(0xAA);
        // Insert with `last_seen` 10 years ago — far past any realistic
        // idle threshold.
        let ancient_ts = now_secs().saturating_sub(10 * 365 * 24 * 60 * 60);
        install_test_entry(id, &pk, true, ancient_ts);

        // 1-second idle threshold: every non-pinned entry would evict.
        let _ = evict_idle_consensus_pks(1);

        assert!(
            has_consensus_pk(id),
            "pinned anchor {} MUST survive idle sweep regardless of age",
            id
        );
        cleanup_test_entry(id);
    }

    /// Non-pinned entries idle longer than the threshold MUST be evicted by
    /// the periodic sweep — this is the LRU contract that frees registry
    /// slots for new joiners.
    #[test]
    fn idle_non_pinned_entry_is_evicted() {
        let id = "v20_test_idle_evicted";
        let pk = fake_pk_bytes(0xBB);
        let ancient_ts = now_secs().saturating_sub(60 * 60 * 24 * 60); // 60 days ago
        install_test_entry(id, &pk, false, ancient_ts);

        // 30-day threshold — entry is well past it.
        let evicted = evict_idle_consensus_pks(30 * 24 * 60 * 60);

        assert!(evicted >= 1, "at least one entry must be evicted, got {}", evicted);
        assert!(
            !has_consensus_pk(id),
            "stale non-pinned entry {} MUST be removed by sweep",
            id
        );
    }

    /// Fresh non-pinned entries MUST NOT be evicted. False positives here
    /// would re-introduce the pre-v20 cap-full rejection symptom: every
    /// honest joiner registering normally would suddenly be evicted by an
    /// over-aggressive sweep, violating the "active = retained" contract.
    #[test]
    fn fresh_non_pinned_entry_is_preserved() {
        let id = "v20_test_fresh_preserved";
        let pk = fake_pk_bytes(0xCC);
        let now = now_secs();
        install_test_entry(id, &pk, false, now);

        // 30-day threshold — entry is fresh (≤ 1 sec old).
        let _ = evict_idle_consensus_pks(30 * 24 * 60 * 60);

        assert!(
            has_consensus_pk(id),
            "fresh non-pinned entry {} MUST survive (not stale)",
            id
        );
        cleanup_test_entry(id);
    }

    /// `deactivate_consensus_pk` MUST remove a non-pinned entry and return
    /// true. This is the explicit-unregister path used by future
    /// NodeDeactivation TX apply hooks and by operator tooling.
    #[test]
    fn deactivate_removes_non_pinned_entry() {
        let id = "v20_test_deactivate_removes";
        let pk = fake_pk_bytes(0xDD);
        install_test_entry(id, &pk, false, now_secs());

        let removed = deactivate_consensus_pk(id);

        assert!(removed, "deactivate must succeed for non-pinned entry");
        assert!(
            !has_consensus_pk(id),
            "deactivated entry {} must no longer be in registry",
            id
        );
    }

    /// `deactivate_consensus_pk` MUST refuse to remove a pinned (genesis-
    /// anchor) entry and return false. Anchors can only be rotated through
    /// a network-wide upgrade ceremony; no runtime call may take them out.
    #[test]
    fn deactivate_refuses_pinned_entry() {
        let id = "v20_test_deactivate_refuses_pinned";
        let pk = fake_pk_bytes(0xEE);
        install_test_entry(id, &pk, true, now_secs());

        let removed = deactivate_consensus_pk(id);

        assert!(!removed, "deactivate MUST refuse pinned anchor");
        assert!(
            has_consensus_pk(id),
            "pinned anchor {} must still be in registry after refused deactivate",
            id
        );
        cleanup_test_entry(id);
    }

    /// `try_evict_one_stale_entry` MUST select the most-stale eligible
    /// entry (largest idle time), not just any stale entry. Without this,
    /// LRU semantics degrade to FIFO — the oldest insertion would always
    /// vacate even if it is in fact more recently active than other
    /// entries.
    #[test]
    fn in_line_eviction_picks_most_stale() {
        let id_old = "v20_test_evict_pick_oldest";
        let id_recent = "v20_test_evict_pick_recent";
        let pk_old = fake_pk_bytes(0x10);
        let pk_recent = fake_pk_bytes(0x11);

        let now = now_secs();
        install_test_entry(id_old, &pk_old, false, now.saturating_sub(60 * 24 * 3600));
        install_test_entry(id_recent, &pk_recent, false, now.saturating_sub(40 * 24 * 3600));

        let mut reg = CONSENSUS_PK_REGISTRY.write();
        let evicted = try_evict_one_stale_entry(&mut reg, 30 * 24 * 3600);
        drop(reg);

        assert_eq!(
            evicted.as_deref(),
            Some(id_old),
            "in-line eviction must pick the most-stale entry, got {:?}",
            evicted
        );
        // Cleanup the survivor; the evicted entry was already removed by the helper.
        cleanup_test_entry(id_recent);
    }

    /// `consensus_pk_registry_cap` MUST honour the `QNET_PK_REGISTRY_CAP`
    /// env override at runtime. Operators tuning a high-density deployment
    /// rely on this to lift the default 100K cap without code changes.
    /// Hard-bound MUST clamp values above MAX_PK_REGISTRY_CAP_HARD.
    #[test]
    fn env_override_controls_cap() {
        // SAFETY: this test mutates a process-global env var. Cargo runs
        // tests in parallel by default, so we serialise via a unique
        // override value that is restored at the end of the test.
        let prev = std::env::var("QNET_PK_REGISTRY_CAP").ok();
        std::env::set_var("QNET_PK_REGISTRY_CAP", "777");
        let cap_with_override = consensus_pk_registry_cap();
        // Restore IMMEDIATELY before any assertion so a panic does not leak
        // the env var into other tests in this module.
        match prev {
            Some(v) => std::env::set_var("QNET_PK_REGISTRY_CAP", v),
            None => std::env::remove_var("QNET_PK_REGISTRY_CAP"),
        }
        assert_eq!(cap_with_override, 777, "env override must be honoured");

        // Verify hard bound clamp without leaking env state across tests.
        std::env::set_var("QNET_PK_REGISTRY_CAP", "999999999999"); // way over hard bound
        let cap_clamped = consensus_pk_registry_cap();
        std::env::remove_var("QNET_PK_REGISTRY_CAP");
        assert_eq!(
            cap_clamped, MAX_PK_REGISTRY_CAP_HARD,
            "cap larger than MAX_PK_REGISTRY_CAP_HARD must clamp"
        );
    }

    /// `observe_pk_activity` MUST update the timestamp on subsequent calls.
    /// Without this the activity tracker would remain frozen at the first
    /// observation and every entry would look idle to the sweep.
    #[test]
    fn observe_pk_activity_updates_timestamp() {
        let id = "v20_test_observe_updates";
        observe_pk_activity(id);
        let first = last_pk_activity(id).expect("first observation must record");

        // Wait for the wall clock to advance by at least one second so the
        // timestamp delta is observable. `now_secs` is 1-sec granularity.
        std::thread::sleep(std::time::Duration::from_millis(1100));

        observe_pk_activity(id);
        let second = last_pk_activity(id).expect("second observation must record");

        assert!(
            second > first,
            "second observation timestamp ({}) must be later than first ({})",
            second, first
        );
        LAST_ACTIVITY.remove(id);
    }
}

// Regression tests pinning the Tier-3 first-seen genesis policy: anchors
// loaded → strict reject (anchor squat). Asserted via the pure policy
// helper below, which isolates the decision from the Dilithium3 math
// (keypair/signature path is covered by integration tests).

/// Pure-logic helper for the Tier 3 first-seen genesis policy.
///
/// Returns `true` when the connection should ADMIT the first-seen claim
/// (TOFV — signature math will gate further), `false` when it MUST be
/// hard-rejected as an identity squat or misconfigured deploy.
///
/// Single source of truth for the v19.1 policy: the inline verify-path
/// uses this helper too (see `verify_dilithium_signature` Tier 3
/// branch), keeping production behaviour and unit-test assertions in
/// lockstep.
pub(crate) fn tier3_genesis_first_seen_admit(
    anchors_loaded: bool,
    fresh_opt_in: bool,
) -> bool {
    !anchors_loaded && fresh_opt_in
}

#[cfg(test)]
mod tests_v19_1_tier3_fresh_window {
    use super::*;

    /// Anchors loaded means every legitimate genesis PK is already in the
    /// registry. A first-seen claim for a genesis identity in that state
    /// is an actual squat attempt → MUST hard reject regardless of any
    /// fresh-bootstrap opt-in flag. This is the steady-state security
    /// invariant for genesis identity-key binding.
    #[test]
    fn tier3_strict_when_anchors_loaded() {
        // Even with QNET_BOOTSTRAP_FRESH=1 set: anchors are authoritative.
        assert!(
            !tier3_genesis_first_seen_admit(/*anchors_loaded=*/ true, /*fresh_opt_in=*/ true),
            "anchors loaded + fresh opt-in MUST reject (squat attempt under loaded anchors)"
        );
        assert!(
            !tier3_genesis_first_seen_admit(/*anchors_loaded=*/ true, /*fresh_opt_in=*/ false),
            "anchors loaded + no opt-in MUST reject"
        );
    }

    /// The fresh-bootstrap path: no anchors yet AND operator opted in via
    /// QNET_BOOTSTRAP_FRESH=1. This is the only state in which a first-seen
    /// genesis claim is admitted — the signature math below the policy
    /// gate is what actually verifies the message. Without this admit,
    /// fresh genesis clusters cannot bootstrap (the v19.0 regression).
    #[test]
    fn tier3_admit_when_fresh_window_open() {
        assert!(
            tier3_genesis_first_seen_admit(/*anchors_loaded=*/ false, /*fresh_opt_in=*/ true),
            "anchors absent + fresh opt-in MUST admit (case (c) bootstrap)"
        );
    }

    /// Misconfigured deploy: anchors absent AND no opt-in. The operator
    /// did not deploy `genesis_anchors.json` and did not set
    /// `QNET_BOOTSTRAP_FRESH=1`. Hard reject so the failure is visible
    /// in operational logs (`anchors_loaded=false bootstrap_fresh=false`)
    /// and the operator has to make an explicit choice. Silent admit
    /// here would hide a deploy bug AND open the squat-on-bootstrap
    /// race that the anchor file exists to close.
    #[test]
    fn tier3_strict_when_no_anchors_no_opt_in() {
        assert!(
            !tier3_genesis_first_seen_admit(/*anchors_loaded=*/ false, /*fresh_opt_in=*/ false),
            "anchors absent + no opt-in MUST reject (misconfigured deploy)"
        );
    }
}

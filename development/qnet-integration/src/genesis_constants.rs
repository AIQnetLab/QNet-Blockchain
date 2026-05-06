//! Genesis node constants - centralized to avoid duplication

/// Genesis bootstrap activation codes (PRODUCTION)
/// These are the ONLY 5 codes that can bootstrap the QNet blockchain
/// Security: codes are protected by IP whitelist + wallet binding + Dilithium3 signature,
/// so the sequential pattern is not a vulnerability.
pub const GENESIS_BOOTSTRAP_CODES: &[&str] = &[
    "QNET-BOOT-0001-STRAP",
    "QNET-BOOT-0002-STRAP",
    "QNET-BOOT-0003-STRAP",
    "QNET-BOOT-0004-STRAP",
    "QNET-BOOT-0005-STRAP",
];

/// Genesis node wallet addresses (PRODUCTION)
/// These are the predefined wallet addresses for Genesis nodes
/// Format: 19 hex + "eon" + 15 hex + 8 hex SHA3-256 checksum = 45 chars
/// v4.1: Updated to 45-char format with 8-hex (4-byte) SHA3-256 checksum
pub const GENESIS_WALLETS: &[(&str, &str)] = &[
    ("001", "f36ff465a0944fd06cdeonfca0ad004ff9db42e16dbab"), // Genesis Node #1
    ("002", "0bac6225a082de1f659eond0c96f1706cf19cc7abf70a"), // Genesis Node #2
    ("003", "d216bb23fbe7f853636eon3f16b378b919227e009fb4f"), // Genesis Node #3
    ("004", "e5bffcbe8d8cc90afa1eond9c4c2a4e75101e25dc1113"), // Genesis Node #4
    ("005", "02af45d56bd1f5d9002eon0eb1c522f96a2f42dfb74cb"), // Genesis Node #5
];

/// Genesis node IP addresses (PRODUCTION)
/// These IPs are authorized to run Genesis nodes
pub const GENESIS_NODE_IPS: &[(&str, &str)] = &[
    ("154.38.160.39", "001"),    // Genesis Node #1 - North America
    ("62.171.157.44", "002"),    // Genesis Node #2 - Europe
    ("161.97.86.81", "003"),     // Genesis Node #3 - Europe  
    ("5.189.130.160", "004"),  // Genesis Node #4 - Europe
    ("162.244.25.114", "005"),   // Genesis Node #5 - Europe
];

/// Legacy genesis node IDs (single-digit form, kept for backward compatibility
/// with code paths that still emit the unpadded representation).
pub const LEGACY_GENESIS_NODES: &[&str] = &[
    "genesis_node_1",
    "genesis_node_2",
    "genesis_node_3",
    "genesis_node_4",
    "genesis_node_5"
];

/// Check if given activation code is a Genesis bootstrap code
pub fn is_genesis_bootstrap_code(code: &str) -> bool {
    GENESIS_BOOTSTRAP_CODES.contains(&code)
}

/// Check if a `node_id` refers to a Genesis bootstrap node.
///
/// Accepts BOTH representations the codebase emits:
///   * Production / 3-digit form: `"genesis_node_001"` … `"genesis_node_005"`
///     (the form actually written into chain state and used in production logs)
///   * Legacy / 1-digit form: `"genesis_node_1"` … `"genesis_node_5"`
///     (the form embedded in `LEGACY_GENESIS_NODES`, kept for older callers
///     that have not been migrated)
///
/// Both representations MUST be recognised: the IP-gate, the anti-squat check
/// in `consensus_crypto::register_*`, and the genesis-identity hard-reject in
/// `verify_with_real_dilithium` all key on this function. A bug here that
/// returned `false` for the production form silently disables every gate it
/// guards, which is the v16.x identity-squat class.
///
/// Scalability: the check is O(N) over `GENESIS_NODE_IPS` where N == 5. The
/// genesis set is fixed at network birth; this function will never be called
/// in a hot path that scales with super-node count.
pub fn is_legacy_genesis_node(node_id: &str) -> bool {
    let Some(suffix) = node_id.strip_prefix("genesis_node_") else {
        return false;
    };
    // Match against the canonical bootstrap_id table. We compare the suffix
    // against BOTH the padded form ("001") and the leading-zero-stripped form
    // ("1") so callers using either representation get the same answer.
    for (_ip, bootstrap_id) in GENESIS_NODE_IPS {
        let unpadded = bootstrap_id.trim_start_matches('0');
        if suffix == *bootstrap_id || (!unpadded.is_empty() && suffix == unpadded) {
            return true;
        }
    }
    false
}

/// Resolve the canonical genesis IP for a given `node_id` of either form
/// (`"genesis_node_001"` or `"genesis_node_1"`). Returns `None` if the
/// `node_id` is not a genesis identity.
///
/// Used by every IP-gate site to compare the sender's source IP against the
/// hard-coded genesis IP for the claimed identity, with format normalisation
/// done in one place rather than copy-pasted at each call site.
pub fn genesis_ip_for_node_id(node_id: &str) -> Option<&'static str> {
    let suffix = node_id.strip_prefix("genesis_node_")?;
    // Normalise to padded 3-digit form expected by GENESIS_NODE_IPS keys.
    let padded = match suffix.len() {
        1 => format!("00{}", suffix),
        2 => format!("0{}", suffix),
        _ => suffix.to_string(),
    };
    get_genesis_ip_by_id(&padded)
}

/// v14.7: Count of genesis validators — hard floor for quorum computation
/// when the live validator set cache is empty (cold-start / pre-handshake).
/// Every genesis node has an entry in `GENESIS_NODE_IPS`.
pub fn genesis_node_count() -> usize {
    GENESIS_NODE_IPS.len()
}

/// Get Genesis node IP by bootstrap ID (001-005)
pub fn get_genesis_ip_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (ip, id) in GENESIS_NODE_IPS {
        if id == &bootstrap_id {
            return Some(ip);
        }
    }
    None
}

/// Get Genesis bootstrap ID by IP address  
pub fn get_genesis_id_by_ip(ip: &str) -> Option<&'static str> {
    for (genesis_ip, id) in GENESIS_NODE_IPS {
        if genesis_ip == &ip {
            return Some(id);
        }
    }
    None
}

/// Get Genesis node region by IP address using EXISTING constants and comments
pub fn get_genesis_region_by_ip(ip: &str) -> Option<&'static str> {
    // EXISTING: Use GENESIS_NODE_IPS mapping with regions from production deployment comments
    match ip {
        "154.38.160.39" => Some("NorthAmerica"), // Genesis Node #1 - North America (from comments)
        "62.171.157.44" => Some("Europe"),       // Genesis Node #2 - Europe (from comments)
        "161.97.86.81" => Some("Europe"),        // Genesis Node #3 - Europe (from comments)
        "5.189.130.160" => Some("Europe"),     // Genesis Node #4 - Europe (from comments)
        "162.244.25.114" => Some("Europe"),      // Genesis Node #5 - Europe (CORRECTED)
        _ => None,
    }
}

/// Get all genesis node IPs as a Vec<String>.
/// Used by genesis_config and sync_manager for HTTP fallback.
pub fn get_genesis_ips() -> Vec<String> {
    GENESIS_NODE_IPS.iter().map(|(ip, _)| ip.to_string()).collect()
}

/// Get Genesis wallet address by bootstrap ID (001-005)
pub fn get_genesis_wallet_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (id, wallet) in GENESIS_WALLETS {
        if id == &bootstrap_id {
            return Some(wallet);
        }
    }
    None
}


// =========================================================================
// v4.0: VRF Public Key Registry for producer verification
// Maps node_id → Dilithium3 public key (hex)
// Populated during node registration, used for VRF proof verification
// =========================================================================

use std::collections::HashMap;

lazy_static::lazy_static! {
    /// Global registry: node_id → dilithium3_pk_hex
    /// Thread-safe, updated on node registration
    pub static ref VRF_PK_REGISTRY: parking_lot::RwLock<HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(HashMap::new());
}

/// FIX L-G1: Maximum VRF registry size to prevent unbounded growth
const MAX_VRF_REGISTRY_SIZE: usize = 50_000;

/// Register a node's VRF public key.
///
/// Genesis-side effect: when this call brings the VRF registry up to the
/// full set of 5 genesis identities (and an anchor file does not yet exist
/// on disk), `try_autowrite_genesis_anchors_locked` writes it atomically.
/// On every subsequent restart the strict identity-anchor guard at
/// `initialize_wallet_identity` activates with a non-empty anchor map,
/// closing the bootstrap race window for genesis-to-genesis traffic.
pub fn register_vrf_public_key(node_id: &str, pk_bytes: &[u8]) {
    if pk_bytes.len() != 1952 {
        println!("[WARN][VRF_REG] invalid pk_size={} node={}", pk_bytes.len(), node_id);
        return;
    }
    // PRODUCTION: Single write lock to eliminate TOCTOU race condition
    let mut registry = VRF_PK_REGISTRY.write();
    if registry.len() >= MAX_VRF_REGISTRY_SIZE && !registry.contains_key(node_id) {
        println!("[WARN][VRF_REG] registry_full size={}", registry.len());
        return;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    println!("[INFO][VRF_REG] pk_registered node={} total={}", node_id, registry.len());

    // Auto-genesis-anchor write. Triggered only for genesis identity inserts,
    // and only fires the disk-write code path when the registry now contains
    // all 5 genesis PKs. Idempotent — subsequent calls observe the file on
    // disk and short-circuit. Safe to call under the write lock: I/O cost is
    // amortised across the lifetime of the process (writes ≤ 1).
    if node_id.starts_with("genesis_node_") {
        // `registry` is a parking_lot::RwLockWriteGuard. Function arguments
        // do not trigger Deref coercion the way method calls do, so pass
        // an explicit `&*registry` to obtain `&HashMap<String, Vec<u8>>`.
        try_autowrite_genesis_anchors_locked(&*registry);
    }
}

/// Internal: when all 5 genesis identities are present in the VRF registry
/// and `genesis_anchors.json` does not yet exist, write it atomically.
///
/// Why this exists
/// ───────────────
/// The clean-bootstrap path of a genesis cluster looks like:
///   1. Each node generates a fresh Dilithium3 keypair on first start
///      (the `dilithium_keypair.bin` file is absent).
///   2. After P2P comes online each node broadcasts a `VrfKeyAnnounce`,
///      gossiped + IP-gated against the canonical Genesis IPs. Receivers
///      install the canonical (node_id → PK) binding into the in-memory
///      VRF and consensus registries.
///   3. After this cross-registration completes, every node has all 5
///      genesis PKs in memory but the binding still lives ONLY in memory.
///      A subsequent restart loses it and reruns the same dance, which
///      keeps the strict anchor guard at `initialize_wallet_identity`
///      disabled (anchor map empty → guard skipped).
///
/// Persisting `genesis_anchors.json` as soon as the in-memory cross-set is
/// complete eliminates the disabled-guard window from boot N+1 onward:
///   * boot N+1: `install_genesis_anchors_at_startup` reads the file →
///     anchor map populated → strict guard enforces local PK == anchor.
///   * Genesis NodeRegistration TXs at later epochs embed the anchored PK
///     (see `create_genesis_registration_txs` at node.rs).
///   * The Tier-3 hard-reject for genesis pk_first_seen
///     (consensus_crypto.rs) becomes redundant defence-in-depth rather
///     than a bootstrap-blocker.
///
/// Idempotency / safety
/// ────────────────────
///   * No-op when the registry is incomplete (< 5 genesis entries).
///   * No-op when the file already exists (operator-provided OR previous
///     auto-write). Operator-managed anchors are never overwritten.
///   * Atomic write: `*.tmp` + fsync + rename. A crash mid-write leaves the
///     previous file (or absence) untouched.
///   * Logged at `[INFO][GENESIS] anchors_autowritten` on success and
///     `[WARN][GENESIS] anchors_autowrite_*` on every failure mode. Never
///     panics — fallback path is exactly the original behaviour (anchors
///     missing → VrfKeyAnnounce TOFV continues to repopulate on each boot).
///
/// Scalability note
/// ────────────────
/// The branch only triggers for `node_id.starts_with("genesis_node_")`,
/// which is a fixed set of 5. For thousands of Super-node insertions this
/// function performs zero I/O work — the prefix check is the only added
/// cost on the hot path.
fn try_autowrite_genesis_anchors_locked(
    registry: &HashMap<String, Vec<u8>>,
) {
    use std::path::Path;

    let path = Path::new(GENESIS_ANCHORS_PATH);

    // Don't clobber an existing file. Operator-supplied anchors take
    // precedence and any earlier auto-write is already there.
    if path.exists() {
        return;
    }

    // Need exactly the 5 canonical genesis IDs. Use GENESIS_NODE_IPS as the
    // source of truth — adding/removing genesis identities anywhere in the
    // codebase MUST go through that table.
    let mut anchors: HashMap<String, String> = HashMap::with_capacity(GENESIS_NODE_IPS.len());
    for (_ip, bootstrap_id) in GENESIS_NODE_IPS {
        let node_id = format!("genesis_node_{}", bootstrap_id);
        match registry.get(&node_id) {
            Some(pk_bytes) if pk_bytes.len() == 1952 => {
                anchors.insert(node_id, hex::encode(pk_bytes));
            }
            _ => return, // incomplete set — wait for next call
        }
    }

    // Serialise. `serde_json::to_string_pretty` keeps the file
    // human-inspectable for the operator; ordering is HashMap-iter (not
    // stable across runs, but we don't depend on stability — only on
    // membership).
    let json = match serde_json::to_string_pretty(&anchors) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[WARN][GENESIS] anchors_autowrite_serialize_fail err={}", e);
            return;
        }
    };

    // Atomic on POSIX: write tmp, fsync, rename.
    let tmp_path = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp_path, json.as_bytes()) {
        eprintln!("[WARN][GENESIS] anchors_autowrite_tmp_fail path={:?} err={}", tmp_path, e);
        return;
    }
    // Best-effort fsync of the file before rename. Errors here are non-fatal
    // — the rename will still take effect, just without a hard durability
    // guarantee, which matches the existing operator-write workflow.
    if let Ok(f) = std::fs::OpenOptions::new().read(true).open(&tmp_path) {
        let _ = f.sync_all();
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        eprintln!("[WARN][GENESIS] anchors_autowrite_rename_fail src={:?} dst={:?} err={}",
                  tmp_path, path, e);
        // Leave behind the tmp for operator inspection.
        return;
    }

    println!(
        "[INFO][GENESIS] anchors_autowritten path={} count={} hint=will_be_loaded_on_next_restart",
        GENESIS_ANCHORS_PATH, anchors.len()
    );
}

/// Get a node's VRF public key for proof verification
pub fn get_vrf_public_key(node_id: &str) -> Option<Vec<u8>> {
    VRF_PK_REGISTRY.read().get(node_id).cloned()
}

/// Check if node has registered VRF key
pub fn has_vrf_key(node_id: &str) -> bool {
    VRF_PK_REGISTRY.read().contains_key(node_id)
}

/// Get all registered VRF public keys (for full election verification)
pub fn get_all_vrf_keys() -> HashMap<String, Vec<u8>> {
    VRF_PK_REGISTRY.read().clone()
}

// =========================================================================
// v16.1: GENESIS DILITHIUM ANCHOR LOADER (chain-anchored identity binding)
// =========================================================================
//
// Identity-key binding for the 5 genesis bootstrap nodes is anchored at boot
// time from a JSON file shipped with the deployment. Once installed via
// `consensus_crypto::set_genesis_anchor_pks`, the anchor map is immutable and
// guards every subsequent registration: any PK that does not match the anchor
// is rejected as a squat attempt.
//
// File format (`/app/data/genesis_anchors.json`):
//   { "genesis_node_001": "<hex_1952_bytes>", ... "genesis_node_005": "..." }
//
// Operator workflow:
//   1. On a clean cluster, every bootstrap node generates its own keypair
//      (lazy, on first start) under `/app/data/keys/dilithium_keypair.bin`.
//   2. Operator collects each node's PK (hex from `pk_hash` log or RPC) and
//      writes them all into ONE JSON file deployed to every node BEFORE the
//      first restart that loads anchors.
//   3. Subsequent restarts read the file and install anchors at startup,
//      BEFORE P2P comes online — closes the trust-on-first-verify race that
//      caused the v15.x pk_mismatch deadlock.
//
// Operational property: keypair files MUST be backed up. If a node's
// `dilithium_keypair.bin` is lost while the anchor map still binds the old
// PK, the node refuses to start (via `initialize_wallet_identity`'s strict
// guard) — operator must restore from backup.
//
// Scalability: anchors are bounded to the 5 genesis identities. For
// thousands of super-node operators, identity-key binding is established via
// signed `NodeRegistration` transactions (already implemented at
// `cache_node_registrations_from_transactions_with_dashmap`), which carry
// `dilithium_public_key` in TX payload and feed `register_consensus_pk_from_chain`.
// =========================================================================

/// Default location of the genesis anchors JSON file inside the container.
pub const GENESIS_ANCHORS_PATH: &str = "/app/data/genesis_anchors.json";

/// Load genesis Dilithium3 anchor PKs from `path`. Returns empty map if file
/// missing or malformed (logged as WARN, not fatal — boot proceeds without
/// anchors so a fresh cluster can complete first-time keygen + anchor write).
///
/// Format: JSON object `{ node_id: pk_hex_1952_bytes }`. Each PK MUST decode
/// to exactly 1952 bytes; invalid entries are skipped with WARN.
pub fn load_genesis_anchor_pks_from_file(path: &str) -> HashMap<String, Vec<u8>> {
    use std::fs;
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => {
            // Not present is normal for first cluster boot — operator writes
            // the file after collecting PKs. Don't WARN at this stage.
            return HashMap::new();
        }
    };

    let parsed: HashMap<String, String> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[WARN][GENESIS] anchors_parse_fail path={} err={}", path, e);
            return HashMap::new();
        }
    };

    let mut out = HashMap::with_capacity(parsed.len());
    for (node_id, pk_hex) in parsed {
        match hex::decode(&pk_hex) {
            Ok(bytes) if bytes.len() == 1952 => {
                out.insert(node_id, bytes);
            }
            Ok(bytes) => {
                eprintln!(
                    "[WARN][GENESIS] anchor_invalid_size node={} got={} expected=1952",
                    node_id, bytes.len()
                );
            }
            Err(e) => {
                eprintln!("[WARN][GENESIS] anchor_hex_decode_fail node={} err={}", node_id, e);
            }
        }
    }
    out
}

/// One-shot startup hook: load anchors from `GENESIS_ANCHORS_PATH` and
/// install them into BOTH the consensus-layer anchor map AND the working
/// registries (VRF + consensus PK). Idempotent.
///
/// Returns the count of anchors installed (0 if the file is absent — caller
/// may then proceed in fresh-cluster mode where keys are exchanged via
/// `VrfKeyAnnounce` and the file is auto-written by
/// `try_autowrite_genesis_anchors_locked` once cross-registration completes).
///
/// Two-step propagation
/// ────────────────────
/// 1. `set_genesis_anchor_pks` populates the immutable anchor map. The
///    strict identity-anchor guard at `initialize_wallet_identity` reads
///    this and refuses to start when the local keypair does not match.
///    `register_consensus_pk_from_chain` reads it as the anti-squat check.
///
/// 2. **Pre-population of the working registries** (this function): for
///    every anchored identity we also call
///      * `register_vrf_public_key` → `VRF_PK_REGISTRY`
///      * `register_consensus_pk_from_chain` → `CONSENSUS_PK_REGISTRY`
///    so that EVERY inbound genesis-bound signature finds a Tier-1 match
///    from t=0. Without this step, even with the anchor file present,
///    the working registry would still be filled lazily by inbound
///    `VrfKeyAnnounce` messages — leaving a brief race window where
///    cross-genesis traffic could be hard-rejected by the Tier-3 genesis
///    no-binding policy.
///
/// MUST be called BEFORE any P2P traffic is accepted (specifically, before
/// the first `VrfLeaderClaim` / `VrfKeyAnnounce` could trigger a TOFV path).
///
/// Scalability: 5 genesis entries — fixed cost regardless of network size.
pub fn install_genesis_anchors_at_startup() -> usize {
    let map = load_genesis_anchor_pks_from_file(GENESIS_ANCHORS_PATH);
    if map.is_empty() {
        // First-boot path: no anchor file yet. Caller logs the appropriate
        // INFO; we return 0 so caller can decide whether to fail or proceed.
        return 0;
    }
    let count = map.len();

    // Pre-populate working registries BEFORE handing the map off to
    // `set_genesis_anchor_pks` — registering against an empty anchor map
    // skips the anti-squat branch in `register_consensus_pk_from_chain`,
    // and once the anchor map is set the same calls would be no-ops on the
    // immutability check anyway. This ordering is intentional and makes the
    // pre-population path a single straight line.
    for (node_id, pk_bytes) in &map {
        register_vrf_public_key(node_id, pk_bytes);
        if !qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(node_id, pk_bytes) {
            eprintln!(
                "[WARN][GENESIS] anchor_prepopulate_failed node={} reason=registry_or_size_check",
                node_id
            );
        }
    }

    let installed = qnet_consensus::consensus_crypto::set_genesis_anchor_pks(map);
    if installed {
        println!(
            "[INFO][GENESIS] anchors_installed count={} src={} prepopulated_registries=true",
            count, GENESIS_ANCHORS_PATH
        );
        count
    } else {
        // Already installed (immutable). Treat as success, but log so an
        // operator restart with a different file is visible.
        println!("[INFO][GENESIS] anchors_already_installed count={}", count);
        count
    }
}

/// Lookup the anchored PK for a given genesis node_id. Returns None if no
/// anchor map is installed, or if the node_id is not a genesis identity.
pub fn get_genesis_anchor_pk(node_id: &str) -> Option<Vec<u8>> {
    qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id)
}

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — v17 identity-binding hardening
// ════════════════════════════════════════════════════════════════════════════
// Tests below lock in the security invariants enforced by Fixes #1, #5, #6.
// Regressions on these tests indicate either a removed gate or a re-introduced
// format bug. Every test asserts a SECURITY property, never a styling choice.
#[cfg(test)]
mod tests_v17_security {
    use super::*;

    /// Fix #1: `is_legacy_genesis_node` MUST accept the production 3-digit
    /// form. The pre-fix function did exact match against `LEGACY_GENESIS_NODES`
    /// (1-digit) which silently turned every IP-gate into dead code for
    /// real production identities.
    #[test]
    fn is_legacy_genesis_node_accepts_production_3digit_form() {
        for id in &[
            "genesis_node_001",
            "genesis_node_002",
            "genesis_node_003",
            "genesis_node_004",
            "genesis_node_005",
        ] {
            assert!(
                is_legacy_genesis_node(id),
                "production 3-digit form must be recognised: {}", id
            );
        }
    }

    /// Fix #1: backward compatibility — the legacy 1-digit form must still
    /// be recognised so existing call sites that may still emit it are
    /// covered. This prevents a regression where someone narrows the matcher
    /// to "production-only" and breaks legacy paths that have not been
    /// migrated.
    #[test]
    fn is_legacy_genesis_node_accepts_legacy_1digit_form() {
        for id in &[
            "genesis_node_1",
            "genesis_node_2",
            "genesis_node_3",
            "genesis_node_4",
            "genesis_node_5",
        ] {
            assert!(
                is_legacy_genesis_node(id),
                "legacy 1-digit form must be recognised: {}", id
            );
        }
    }

    /// Fix #1 negative: anything outside the genesis namespace MUST NOT
    /// trigger the gate. Specifically:
    ///   * out-of-range numeric suffix (006, 999, 0)
    ///   * non-genesis prefixes (super_node_*, light_node_*, plain text)
    ///   * empty / malformed strings
    #[test]
    fn is_legacy_genesis_node_rejects_non_genesis() {
        for id in &[
            "",
            "genesis_node_",
            "genesis_node_0",
            "genesis_node_006",
            "genesis_node_999",
            "genesis_node_001x",
            "super_node_001",
            "light_node_42",
            "node_random",
            "Genesis_Node_001", // wrong case prefix
        ] {
            assert!(
                !is_legacy_genesis_node(id),
                "non-genesis identity must be rejected: {:?}", id
            );
        }
    }

    /// Fix #1 helper: `genesis_ip_for_node_id` returns the canonical genesis
    /// IP regardless of which form the caller supplies. Centralised
    /// normalisation is what lets every IP-gate site share one
    /// implementation via `check_genesis_ip_gate`.
    #[test]
    fn genesis_ip_for_node_id_normalises_both_forms() {
        // Pull expected IPs from the canonical table — never hard-code IPs
        // in tests; this ensures the test stays correct if the genesis set
        // is ever rotated via constants edit.
        for (expected_ip, bootstrap_id) in GENESIS_NODE_IPS {
            // Production 3-digit form, e.g. "genesis_node_001"
            let padded = format!("genesis_node_{}", bootstrap_id);
            assert_eq!(
                genesis_ip_for_node_id(&padded),
                Some(*expected_ip),
                "padded form must resolve: {}", padded
            );
            // Legacy 1-digit form, e.g. "genesis_node_1"
            let unpadded = format!("genesis_node_{}", bootstrap_id.trim_start_matches('0'));
            assert_eq!(
                genesis_ip_for_node_id(&unpadded),
                Some(*expected_ip),
                "unpadded form must resolve: {}", unpadded
            );
        }
    }

    /// Fix #1 negative: non-genesis identities resolve to None.
    #[test]
    fn genesis_ip_for_node_id_rejects_non_genesis() {
        for id in &[
            "",
            "super_node_001",
            "genesis_node_006",
            "random_string",
            "genesis_node_",
        ] {
            assert_eq!(
                genesis_ip_for_node_id(id), None,
                "must not resolve a non-genesis id to an IP: {:?}", id
            );
        }
    }

    /// Fix #1 surface area: `genesis_node_count()` MUST agree with the
    /// `GENESIS_NODE_IPS` table — the historical bug was that count and
    /// matcher disagreed, leaving exactly one identity off the gates.
    #[test]
    fn genesis_node_count_matches_ip_table() {
        assert_eq!(genesis_node_count(), GENESIS_NODE_IPS.len());
    }
}


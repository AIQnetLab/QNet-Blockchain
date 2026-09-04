//! Node construction and bring-up: new_with_config, start, background task wiring.

use super::*;

impl BlockchainNode {
    /// Create a new blockchain node with default settings (backward compatibility)
    pub async fn new(data_dir: &str, p2p_port: u16, bootstrap_peers: Vec<String>) -> Result<Self, QNetError> {
        // Region is a vestigial cosmetic tag (no consensus/topology role) — fixed
        // default, no geo-IP/network detection at boot.
        let region = Region::Europe;
        
        Self::new_with_config(
            data_dir,
            p2p_port,
            bootstrap_peers,
            NodeType::Super, // v3.18: Full removed, default to Super
            region,
        ).await
    }
    
    /// Create a new blockchain node with full configuration
    pub async fn new_with_config(
        data_dir: &str,
        p2p_port: u16,
        bootstrap_peers: Vec<String>,
        node_type: NodeType,
        region: Region,
    ) -> Result<Self, QNetError> {
        // STATE MACHINE: Starting initialization
        set_node_state(NodeState::Initializing);

        // Pin the genesis consensus keys FIRST. init_quic below opens the listener, and an inbound
        // handshake arriving before the anchor map exists cannot resolve the peer's key — it is
        // admitted as transport-only instead of identity-verified. Pure over embedded constants,
        // idempotent, fail-closed.
        let _ = crate::genesis_constants::install_genesis_anchors_at_startup();

        // =========================================================================
        // PHASE 0.1: QUANTUM CRYPTO INITIALIZATION (v2.50)
        // Initialize global quantum crypto EARLY - required for all signature operations
        // Uses OnceCell+Arc for lock-free access after initialization
        // =========================================================================
        if let Err(e) = init_global_quantum_crypto().await {
            set_node_state(NodeState::Error {
                reason: format!("Quantum crypto initialization failed: {}", e),
                recoverable: false,
            });
            return Err(QNetError::ValidationError(format!("Crypto init failed: {}", e)));
        }
        
        // =========================================================================
        // PHASE 0.2: SYSTEM REQUIREMENTS CHECK (v3.1)
        // CRITICAL: Verify minimum RAM before proceeding.
        // Super server nodes require 4 GB RAM minimum.
        // (Light nodes are mobile apps and do not run this server code path;
        // v3.18: the "Full" tier was removed from the protocol.)
        // =========================================================================
        {
            const MIN_RAM_SERVER_MB: u64 = 4_000;  // 4GB minimum for server nodes
            
            // Get total system memory
            let total_ram_mb: u64 = std::fs::read_to_string("/proc/meminfo")
                .ok()
                .and_then(|meminfo| {
                    meminfo.lines()
                        .find(|line| line.starts_with("MemTotal:"))
                        .and_then(|line| {
                            line.split_whitespace()
                                .nth(1)
                                .and_then(|kb| kb.parse::<u64>().ok())
                                .map(|kb| kb / 1024)
                        })
                })
                .unwrap_or(8_000); // Assume 8GB if can't detect (non-Linux)
            
            // v3.18: Super node type removed
            if total_ram_mb < MIN_RAM_SERVER_MB {
                let node_type_str = match node_type {
                    NodeType::Super => "Super",
                    NodeType::Light => "Light", // Should never happen - Light nodes are mobile apps
                };
                
                println!("\n");
                println!("╔══════════════════════════════════════════════════════════════════╗");
                println!("║                    INSUFFICIENT SYSTEM MEMORY                     ║");
                println!("╠══════════════════════════════════════════════════════════════════╣");
                println!("║  Detected RAM:  {:>5} MB                                         ║", total_ram_mb);
                println!("║  Required RAM:  {:>5} MB                                         ║", MIN_RAM_SERVER_MB);
                println!("╠══════════════════════════════════════════════════════════════════╣");
                println!("║  QNet Super server nodes require minimum 4 GB RAM                ║");
                println!("║  to operate reliably without constant OOM crashes.               ║");
                println!("║                                                                  ║");
                println!("║  Options:                                                        ║");
                println!("║  1. Upgrade server RAM to at least 4 GB                          ║");
                println!("║  2. Set QNET_SKIP_RAM_CHECK=1 to force start (NOT RECOMMENDED)   ║");
                println!("╚══════════════════════════════════════════════════════════════════╝");
                println!("\n");
                
                // Allow override for testing/development only
                if std::env::var("QNET_SKIP_RAM_CHECK").is_err() {
                    set_node_state(NodeState::Error {
                        reason: format!("Insufficient RAM: {}MB < {}MB required", total_ram_mb, MIN_RAM_SERVER_MB),
                        recoverable: false,
                    });
                    return Err(QNetError::ValidationError(format!(
                        "Insufficient RAM: {} MB detected, {} MB required for {} node. \
                         Set QNET_SKIP_RAM_CHECK=1 to override (not recommended).",
                        total_ram_mb, MIN_RAM_SERVER_MB, node_type_str
                    )));
                } else {
                    println!("[WARN][MEMORY] QNET_SKIP_RAM_CHECK set - proceeding despite low RAM");
                    println!("[WARN][MEMORY] Node may experience frequent crashes and poor performance!");
                }
            } else {
                println!("[INFO][MEMORY] system_check_passed total_ram={}MB required={}MB", 
                         total_ram_mb, MIN_RAM_SERVER_MB);
            }
        }
        
        // =========================================================================
        // PHASE 0.3: PRE-FLIGHT CHECKS (v2.19.22)
        // CRITICAL: Validate ports and connectivity BEFORE anything else
        // This prevents "ghost nodes" that appear online but can't sync blocks
        // =========================================================================
        
        // Get external IP for connectivity checks
        let external_ip = std::env::var("EXTERNAL_IP")
            .or_else(|_| std::env::var("HOST_IP"))
            .ok();
        
        // v2.103: Pre-flight checks are MANDATORY - no skip option for operators
        // This prevents "ghost nodes" that appear online but can't sync blocks
        // Skip conditions:
        //   - QNET_PREFLIGHT_DONE=1 : Already passed in qnet-node.rs (genesis sync)
        //   - QNET_DEV_SKIP_PREFLIGHT=1 : Internal dev-only flag (not documented)
        let preflight_already_done = std::env::var("QNET_PREFLIGHT_DONE").is_ok();
        let skip_preflight_dev = std::env::var("QNET_DEV_SKIP_PREFLIGHT").is_ok();
        
        if !preflight_already_done && !skip_preflight_dev {
            match crate::preflight_checks::run_preflight_checks(external_ip.as_deref()).await {
                Ok(result) => {
                    if !result.critical_failures.is_empty() {
                        // Should not happen - run_preflight_checks returns Err on critical failures
                        // STATE MACHINE: Fatal pre-flight error
                        set_node_state(NodeState::Error {
                            reason: format!("Pre-flight critical failures: {:?}", result.critical_failures),
                            recoverable: false,
                        });
                        return Err(QNetError::NetworkError(
                            format!("Pre-flight checks failed: {:?}", result.critical_failures)
                        ));
                    }
                    if result.passed {
                        if is_info() { println!("[INFO][NODE] preflight_ok checks_passed"); }
                    } else {
                        let failed: Vec<&str> = result.checks.iter().filter(|c| !c.passed).map(|c| c.name.as_str()).collect();
                        if is_warn() { println!("[WARN][NODE] preflight_incomplete failed={}", failed.join(",")); }
                    }
                }
                Err(e) => {
                    // CRITICAL: Pre-flight checks failed - do NOT start the node
                    
                    // STATE MACHINE: Fatal error
                    set_node_state(NodeState::Error {
                        reason: format!("Pre-flight checks failed: {}", e),
                        recoverable: false,
                    });
                    
                    eprintln!("");
                    eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    eprintln!("[CRIT][NODE] PRE-FLIGHT CHECKS FAILED");
                    eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    eprintln!("{}", e);
                    eprintln!("");
                    eprintln!("Node cannot start until these issues are fixed.");
                    eprintln!("This prevents 'ghost nodes' that appear online but cannot sync.");
                    eprintln!("");
                    eprintln!("Required ports (must be open in firewall!):");
                    eprintln!("  - TCP 8001  : REST API");
                    eprintln!("  - TCP 9876  : P2P Network");
                    eprintln!("  - TCP 9877  : P2P Network (regional)");
                    eprintln!("  - UDP 10876 : QUIC Transport (block sync)");
                    eprintln!("");
                    eprintln!("Docker example:");
                    eprintln!("  -p 8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876/udp");
                    eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    eprintln!("");
                    
                    return Err(QNetError::NetworkError(
                        format!("Pre-flight checks failed: {}", e)
                    ));
                }
            }
        } else {
            // Internal dev flag - not for operators
            if is_warn() { println!("[WARN][NODE] preflight_skipped dev_mode"); }
        }
        
        // NOTE: Light node server blocking is already implemented in bin/qnet-node.rs (lines 78-83, 173-184)
        // No need to duplicate the check here
        
        // Initialize storage
        if is_debug() { println!("[DBG][NODE] storage_init path={}", data_dir); }
        bind_stuck_restart_dir(data_dir);
        let storage = match Storage::new(data_dir) {
            Ok(storage) => {
                if is_debug() { println!("[DBG][NODE] storage_init_ok"); }
                
                let storage_arc = Arc::new(storage);

                // PRODUCTION v2.50: Set global storage using OnceCell (lock-free)
                init_global_storage(storage_arc.clone());

                // ─────────────────────────────────────────────────────────
                // SECURITY: Restore the permanent attacker-PK blacklist
                // ─────────────────────────────────────────────────────────
                // The blacklist is the cryptographic boundary against
                // identity impersonation: any ML-DSA-65 public key that
                // has been observed presenting itself under a bound
                // registry identity it does not own is permanently
                // rejected. Without a durable mirror, a restart would
                // reset the set and grant every known attacker a fresh
                // window of free verification attempts.
                //
                // Order matters: the seed call MUST complete BEFORE
                // anything that could trigger a `verify_with_real_dilithium`
                // path (P2P listener, RPC, consensus reactor). All of
                // those come up downstream of this point in the boot
                // sequence, so the seed-then-callback ordering here is
                // sufficient.
                //
                // The persistence callback is the only place the lower
                // crate gets write access to durable storage; we resolve
                // the storage handle through `try_get_storage` at every
                // call so the callback never captures a stale clone.
                match storage_arc.as_ref().load_all_attacker_pk_entries() {
                    Ok(seeds) => {
                        let n = seeds.len();
                        qnet_consensus::consensus_crypto::seed_attacker_pk_blacklist(seeds);
                        if n > 0 && is_info() {
                            println!(
                                "[INFO][SECURITY] attacker_pk_blacklist_restored entries={} source=metadata_cf",
                                n,
                            );
                        }
                    }
                    Err(e) => {
                        println!(
                            "[WARN][SECURITY] attacker_pk_blacklist_load_failed err={} action=continue_empty",
                            e,
                        );
                    }
                }
                qnet_consensus::consensus_crypto::set_attacker_pk_persist_callback(
                    |fp, rec| {
                        if let Some(storage) = try_get_storage() {
                            if let Err(e) = storage.save_attacker_pk_entry(fp, rec) {
                                // Single warn line; the in-memory entry
                                // already exists, so a transient write
                                // failure costs durability but not
                                // correctness.
                                eprintln!(
                                    "[WARN][SECURITY] attacker_pk_persist_failed fp={}.. err={}",
                                    hex::encode(&fp[..8]),
                                    e,
                                );
                            }
                        }
                    },
                );

                // v3.36: Initialize dynamic gas pricing (EIP-1559 style)
                qnet_state::init_dynamic_gas_pricing();
                
                // PRODUCTION: Set storage path for registry to read activations
                std::env::set_var("QNET_STORAGE_PATH", data_dir);
                if is_debug() { println!("[DBG][NODE] storage_path_env={}", data_dir); }
                
                // CRITICAL FIX v2.64: Verify and repair chain_height desync at startup
                // Detects if metadata CF is stuck but blocks CF has newer blocks
                // Uses binary search O(log n) - only runs once at startup
                if is_info() { println!("[INFO][NODE] verify_chain_height_start"); }
                match storage_arc.as_ref().verify_and_repair_chain_height() {
                    Ok(repaired) => {
                        if repaired {
                            println!("[INFO][NODE] chain_height_repaired desync_fixed=true");
                        } else if is_debug() {
                            println!("[DBG][NODE] chain_height_ok no_desync");
                        }
                    }
                    Err(e) => {
                        println!("[WARN][NODE] chain_height_verify_failed error={}", e);
                    }
                }

                // v5.5: SECONDARY RECOVERY — DB integrity cross-check.
                // If chain_height is still 0 after verify_and_repair, scan DB for any stored
                // blocks. This catches cases where metadata CF lost chain_height but blocks
                // CF has data (OOM kill, power loss during RocksDB flush).
                {
                    let current_ch = storage_arc.get_chain_height().unwrap_or(0);
                    if current_ch == 0 {
                        // Check if blocks exist despite chain_height=0
                        if let Ok(Some(_)) = storage_arc.load_microblock(0) {
                            // Genesis exists — scan forward to find actual height
                            if is_info() { println!("[INFO][NODE] chain_height_zero_but_genesis_exists scanning"); }
                            let mut scan_h = 0u64;
                            let mut last_found = 0u64;
                            let mut gap = 0u64;
                            loop {
                                scan_h += 1;
                                if storage_arc.load_microblock(scan_h).unwrap_or(None).is_some() {
                                    last_found = scan_h;
                                    gap = 0;
                                } else {
                                    gap += 1;
                                    if gap > 10 { break; } // Same gap tolerance as verify_and_repair
                                }
                                if scan_h > 200_000 { break; } // Safety limit
                            }
                            if last_found > 0 {
                                println!("[INFO][NODE] chain_height_recovered from_scan h={}", last_found);
                                let _ = storage_arc.set_chain_height(last_found);
                            }
                        } else if is_info() {
                            println!("[INFO][NODE] chain_height_zero no_genesis fresh_node");
                        }
                    }
                }
                
                // v10.2: HASH INDEX MIGRATION — build O(1) prev_hash lookup index.
                // Enables prev_hash validation without loading full block body.
                // Migration is idempotent (flag in metadata CF) and runs once.
                match storage_arc.migrate_microblock_hash_index() {
                    Ok(count) => {
                        if count > 0 {
                            println!("[INFO][NODE] hash_index_migrated blocks={}", count);
                        } else if is_debug() {
                            println!("[DBG][NODE] hash_index already_migrated");
                        }
                    }
                    Err(e) => {
                        // Non-fatal: prev_hash validation will fall back to loading full blocks
                        if is_warn() { println!("[WARN][NODE] hash_index_migration_fail err={}", e); }
                    }
                }

                storage_arc
            }
            Err(e) => {
                eprintln!("[ERR][NODE] storage_init_fail err={}", e);
                // STATE MACHINE: Fatal storage error
                set_node_state(NodeState::Error {
                    reason: format!("Storage initialization failed: {}", e),
                    recoverable: false,
                });
                return Err(QNetError::StorageError(format!("Storage init error: {}", e)));
            }
        };
        
        // Initialize state manager
        let state = Arc::new(RwLock::new(StateManager::new()));
        // Publish it: the A1 roster derivation reads applied state from an associated fn.
        init_global_state(state.clone());

        // ═══════════════════════════════════════════════════════════════════════
        // v15.10 STAGE-2: WIRE DISK-BACKED ACCOUNT STORE + LRU CACHE BOUND
        // ───────────────────────────────────────────────────────────────────
        // The state manager holds the in-memory account map as a bounded LRU
        // cache; here we install the persistent fallback (RocksDB `accounts`
        // CF via Storage's AccountStore impl) and read the cache cap from the
        // environment. With this in place the warm-cache pass at block-apply
        // time can transparently load cold accounts on demand, and the
        // periodic eviction sweep can keep the in-memory map at or below
        // the configured size.
        //
        // CAPACITY CHOICE (1 000+ super nodes, 100 M+ accounts)
        // ───────────────────────────────────────────────────────────────────
        // Default 500 000 accounts × ~600 B avg = ~300 MB working set —
        // covers the active wallet set for production transfer traffic
        // while leaving room on a 4-8 GB super node for the rest of the
        // runtime (mempool, network buffers, blockchain caches). A
        // value of 0 disables eviction entirely (legacy / tooling /
        // benchmark mode); operators with very large RAM budgets can
        // raise the cap to keep more accounts hot.
        // ═══════════════════════════════════════════════════════════════════════
        {
            let cache_capacity: usize = std::env::var("QNET_ACCOUNT_CACHE_CAPACITY")
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(500_000);
            let state_setup = state.read().await;
            state_setup.set_disk_store(storage.clone() as Arc<dyn qnet_state::AccountStore>);
            state_setup.set_cache_capacity(cache_capacity);
            // Disk-backed Merkle node store: ALWAYS ON. The in-mem tree costs ~233 nodes/leaf
            // (measured: tests_smt_node_growth::measure_intermediate_nodes_per_leaf; the old
            // "bounded by 2N" note was false by ~245x), so at the 10M-account target the tree is
            // ~2.35e9 entries. That cannot live in RAM, and a threshold that flips the backend
            // mid-life would migrate the authority under a running chain. The store is the
            // authority from block 0; `intermediate_nodes`/`leaves` become bounded read-through
            // caches. Not a consensus knob: the root is a pure function of the leaf set, so a
            // store-backed root is byte-identical to an in-mem one.
            //
            // Cache cap sizes RAM, not correctness — a cold entry reloads from the store.
            let node_cache_cap: usize = std::env::var("QNET_MERKLE_NODE_CACHE_CAP")
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(2_000_000);
            state_setup.set_merkle_node_store(storage.merkle_node_store());
            state_setup.set_merkle_node_cache_cap(node_cache_cap);
            if is_info() {
                println!("[INFO][MERKLE] node_store=rocksdb cache_cap={}", node_cache_cap);
            }
            drop(state_setup);
            if is_info() {
                println!(
                    "[INFO][CACHE] account_cache_init capacity={} disk_store=wired",
                    cache_capacity,
                );
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // v15.10 STAGE-2: BACKGROUND EVICTION SWEEP
        // ───────────────────────────────────────────────────────────────────
        // Every 60 seconds, scan the in-memory account map; if it exceeds
        // the configured cap, evict the entries with the oldest last-access
        // timestamps until the size drops back to the cap. Evicted accounts
        // remain durable on disk (Stage-1 write-through guaranteed that)
        // and reload transparently on the next read through the warm-cache
        // pass.
        //
        // Runs as a long-lived `tokio::spawn` so it never blocks the apply
        // pipeline. Eviction is best-effort — if a sweep is in flight when
        // a block apply starts, both run concurrently and the only
        // observable effect is one extra point read for any account that
        // happens to be in flight.
        // ═══════════════════════════════════════════════════════════════════
        {
            let state_evict = state.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                tick.tick().await; // skip immediate first tick
                loop {
                    tick.tick().await;
                    let sg = state_evict.read().await;
                    let before = sg.cache_size();
                    let cap = sg.cache_capacity_value();
                    let evicted = sg.evict_cold_accounts();
                    drop(sg);
                    if evicted > 0 && is_info() {
                        println!(
                            "[INFO][CACHE] evict_swept before={} after={} evicted={} capacity={}",
                            before, before.saturating_sub(evicted), evicted, cap,
                        );
                    }
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════════
        // v7.1: RESTORE FORK FLAGS FROM PERSISTENT STORAGE
        // Fork activation state persisted in RocksDB metadata CF.
        // Ensures fork flags survive restarts without relying on snapshot
        // format or replay coverage. Reset on full replay (TIER 3),
        // re-activated at the correct block by accrue_pending_rewards().
        // ═══════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════
        // v5.1: STATE RECOVERY PIPELINE
        // Three-tier approach: snapshot → incremental replay → full replay
        // Guarantees state is ALWAYS restored correctly after any restart.
        // ═══════════════════════════════════════════════════════════════════
        if is_info() { println!("[INFO][STATE] loading_latest_snapshot"); }

        let pre_snapshot_chain_height = storage.get_chain_height().unwrap_or(0);
        let mut restored_snapshot_height: u64 = 0;

        // ── TIER 1: Try loading state snapshots, newest anchored first. A candidate whose
        // restored root fails the QC-bound anchor verify is rejected and the next-older one
        // is tried — one bad snapshot must not force a from-genesis replay while a provable
        // older candidate sits one key away.
        let mut rejected_snapshots: Vec<u64> = Vec::new();
        'tier1: while restored_snapshot_height == 0 {
        match storage.load_latest_state_snapshot(&rejected_snapshots).await {
            Ok(Some((snapshot_height, state_root, accounts_data, snap_total_supply))) => {
                rejected_snapshots.push(snapshot_height);
                if snapshot_height > pre_snapshot_chain_height {
                    eprintln!("[WARN][STATE] snapshot_ahead_of_chain snapshot_h={} chain_h={} action=discard",
                              snapshot_height, pre_snapshot_chain_height);
                } else if !accounts_data.is_empty() {
                    // v5.1: Try bincode with allow_trailing_bytes for forward compatibility
                    let deserialize_result = bincode::DefaultOptions::new()
                        .with_fixint_encoding()
                        .allow_trailing_bytes()
                        .deserialize::<Vec<(String, qnet_state::Account)>>(&accounts_data)
                        .or_else(|_| {
                            // Fallback: standard bincode (handles old format)
                            bincode::deserialize::<Vec<(String, qnet_state::Account)>>(&accounts_data)
                        });

                    match deserialize_result {
                        Ok(accounts) => {
                            let state_guard = state.write().await;
                            match (*state_guard).restore_accounts(accounts.clone()) {
                                Ok(_) => {
                                    // Verify BEFORE seeding chain_state, so the check hashes exactly what the
                                    // snapshot restored. `state_root` is the anchor macroblock's QC-bound root,
                                    // so a match proves the accounts reproduce certified state.
                                    //
                                    // total_supply is NOT a format discriminator: 0 is legitimate on a chain that
                                    // has not emitted yet, and `anchor_root_and_supply` already returns None (⇒
                                    // full replay) when the supply is genuinely unavailable. Gating on the VALUE
                                    // discarded sound snapshots and paid a from-genesis replay on every restart.
                                    let computed_merkle = state_guard.finalize_merkle();
                                    if computed_merkle == state_root {
                                        // snapshot_height is a MICROBLOCK HEIGHT. Restore chain height, the TIER-2
                                        // replay floor and the emission watermark from it — the replay then mints
                                        // ONLY the gap (snap, tip] and never re-mints counted emissions.
                                        {
                                            let mut cs = state_guard.chain_state.write();
                                            cs.total_supply = snap_total_supply;
                                            cs.height = snapshot_height;
                                            cs.last_minted_emission_mb = Self::emission_mb_index(snapshot_height);
                                        }
                                        restored_snapshot_height = snapshot_height;
                                        if is_info() {
                                            println!("[INFO][STATE] snapshot_verified h={} accounts={} total_supply={} root={} size={}KB",
                                                     snapshot_height, accounts.len(), snap_total_supply,
                                                     hex::encode(&state_root[..8]), accounts_data.len() / 1024);
                                        }
                                    } else if let Some(addr) = state_guard.repair_single_phantom(&state_root) {
                                        // One extra leaf over the certified root — the accounts-CF phantom
                                        // a rolled-back block left behind. Repaired against the 2f+1 root
                                        // (verified, not guessed); its CF row goes too, so no later
                                        // snapshot resurrects it. State is now the certified state.
                                        storage.purge_phantom_account(&addr);
                                        println!("[WARN][STATE] snapshot_repaired_phantom h={} addr={} root={}",
                                                 snapshot_height, addr, hex::encode(&state_root[..8]));
                                        {
                                            let mut cs = state_guard.chain_state.write();
                                            cs.total_supply = snap_total_supply;
                                            cs.height = snapshot_height;
                                            cs.last_minted_emission_mb = Self::emission_mb_index(snapshot_height);
                                        }
                                        restored_snapshot_height = snapshot_height;
                                    } else {
                                        eprintln!("[ERR][STATE] snapshot_merkle_mismatch expected={} computed={} action=clear_and_full_replay",
                                                  hex::encode(&state_root[..8]), hex::encode(&computed_merkle[..8]));
                                        // The accounts do not reproduce certified state — clear them so the
                                        // from-genesis replay rebuilds from nothing, and zero chain_state with
                                        // them so no baseline survives from the snapshot just rejected.
                                        state_guard.clear();
                                        {
                                            let mut cs = state_guard.chain_state.write();
                                            cs.total_supply = 0;
                                            cs.height = 0;
                                            cs.last_minted_emission_mb = 0;
                                        }
                                        restored_snapshot_height = 0;
                                    }
                                }
                                Err(e) => {
                                    // The restore wipes the map and then inserts row by row, so a
                                    // mid-iteration failure leaves an arbitrary PREFIX of the
                                    // snapshot behind. Falling through to a from-genesis replay on
                                    // top of that would apply every credit, transfer and fee in the
                                    // prefix a SECOND time and produce a root no peer shares. Clear
                                    // first, exactly as the two sibling failure arms above do.
                                    state_guard.clear();
                                    {
                                        let mut cs = state_guard.chain_state.write();
                                        cs.total_supply = 0;
                                        cs.height = 0;
                                        cs.last_minted_emission_mb = 0;
                                    }
                                    restored_snapshot_height = 0;
                                    eprintln!("[WARN][STATE] restore_fail err={} action=clear_and_full_replay", e);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[WARN][STATE] deserialize_fail err={} — falling back to full replay", e);
                        }
                    }
                } else {
                    if is_info() { println!("[INFO][STATE] snapshot_empty height={}", snapshot_height); }
                }
            }
            Ok(None) => {
                if rejected_snapshots.is_empty() {
                    if is_info() { println!("[INFO][STATE] no_snapshot fresh_start"); }
                }
                break 'tier1;
            }
            Err(e) => {
                eprintln!("[WARN][STATE] snapshot_load_fail err={} — falling back to full replay", e);
                break 'tier1;
            }
        }
        }

        // ═══════════════════════════════════════════════════════════════════
        // v5.1: GUARANTEED STATE REPLAY
        // TIER 2: If snapshot loaded partially → replay from snapshot to tip
        // TIER 3: If snapshot FAILED → replay ALL blocks from genesis
        // This ensures state is NEVER empty after restart.
        // ═══════════════════════════════════════════════════════════════════
        // Set only when the boot state is PROVEN canonical: a verified snapshot with no
        // tail to replay, or a zero-error replay whose final root matched the tip block.
        // Gates the boot CF true-up — deleting against an unproven leaf set would turn a
        // designed local stall into durable-mirror destruction.
        let mut boot_state_proven = false;
        if pre_snapshot_chain_height > 0 {
            let replay_start = if restored_snapshot_height > 0 {
                // TIER 2: Snapshot loaded — only replay blocks after snapshot
                restored_snapshot_height.saturating_add(1)
            } else {
                // TIER 3: Snapshot failed — full replay from genesis (block 0)
                0
            };
            if replay_start > pre_snapshot_chain_height && restored_snapshot_height > 0 {
                boot_state_proven = true; // snapshot root already anchor-verified, no tail
            }

            if replay_start == 0 {
                // A full replay executes block 0. Its body is loaded from disk, so the genesis
                // restore (file/HTTP) has to happen HERE — the boot's own load_genesis runs long
                // after this loop, and a replay without genesis builds an unprovable state.
                let have_genesis = matches!(storage.load_microblock_auto_format(0), Ok(Some(_)));
                if !have_genesis {
                    let cfg = crate::genesis_config::GenesisConfig::from_env();
                    match crate::genesis_config::load_genesis(&storage, &cfg).await {
                        crate::genesis_config::GenesisResult::Loaded { block, source } => {
                            println!("[INFO][GENESIS] pre_replay_restored source={} txs={}", source, block.transactions.len());
                        }
                        _ => println!("[ERR][GENESIS] pre_replay_unavailable — replay will start above genesis"),
                    }
                }
            }
            if replay_start <= pre_snapshot_chain_height {
                let replay_end = pre_snapshot_chain_height;
                let replay_count = replay_end.saturating_sub(replay_start).saturating_add(1);
                let replay_mode = if restored_snapshot_height > 0 { "incremental" } else { "full" };
                println!("[INFO][STATE] {}_replay start={} end={} blocks={}",
                         replay_mode, replay_start, replay_end, replay_count);

                let replay_time = std::time::Instant::now();
                let mut replayed = 0u64;
                let mut replay_errors = 0u64;
                let mut last_replayed_block_timestamp: u64 = 0;
                let log_interval = std::cmp::max(replay_count / 20, 1000); // Log progress ~20 times or every 1000 blocks

                for h in replay_start..=replay_end {
                    match storage.load_microblock_auto_format(h) {
                        Ok(Some(microblock)) => {
                            last_replayed_block_timestamp = microblock.timestamp;
                            let state_guard = state.write().await;

                            // v10.0: Use shared apply_block_to_state (replay mode: no snapshot, no emission check)
                            let apply_result = Self::apply_block_to_state(
                                &state_guard, &microblock, &storage, None);
                            // Same as the reconcile replay: the block is canonical, so flush now.
                            Self::flush_block_side_indices(&storage, microblock.height, &apply_result.side_indices);
                            // A replay that credits fewer claims than the network produces a state
                            // this node can never reconcile. Stop the replay rather than build on it.
                            if let Some(certifying_mb) = apply_result.reward_epoch_missing {
                                println!("[CRIT][STATE] replay_reward_epoch_missing h={} certifying_mb={} action=stop_replay",
                                         microblock.height, certifying_mb);
                                break;
                            }


                            // Re-seal total_supply at checkpoint heads: a post-restart finality redrive reads
                            // get_total_supply_at(head), which (unlike registry_root) does NOT recompute on miss
                            // → without this re-seal that checkpoint would defer forever. Mirrors the live pipeline.
                            if h % qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL == 0 {
                                let _ = storage.seal_total_supply(h, state_guard.get_total_supply());
                            }

                            replayed += 1;

                            // Progress logging for long replays
                            if replayed % log_interval == 0 {
                                let pct = (replayed as f64 / replay_count as f64 * 100.0) as u32;
                                let elapsed = replay_time.elapsed();
                                println!("[INFO][REPLAY] progress={}/{}  {}%  elapsed={:.1}s",
                                         replayed, replay_count, pct, elapsed.as_secs_f64());
                            }
                        }
                        Ok(None) => {
                            // Block missing in storage — skip but count error
                            if replay_errors < 5 {
                                println!("[WARN][REPLAY] block_missing h={}", h);
                            }
                            replay_errors += 1;
                            if h == 0 {
                                // A state built without genesis is unprovable; ask for the rebuild here,
                                // not only at the post-replay root check (which this may never reach).
                                crate::block_pipeline::mark_state_suspect();
                                crate::sync_manager::request_wholesale_state_resync();
                            }
                        }
                        Err(e) => {
                            if replay_errors < 5 {
                                eprintln!("[WARN][REPLAY] load_fail h={} err={}", h, e);
                            }
                            replay_errors += 1;
                            if h == 0 {
                                crate::block_pipeline::mark_state_suspect();
                                crate::sync_manager::request_wholesale_state_resync();
                            }
                        }
                    }
                }

                let elapsed = replay_time.elapsed();
                println!("[INFO][STATE] {}_replay_done replayed={}/{} errors={} elapsed={:.2}s",
                         replay_mode, replayed, replay_count, replay_errors, elapsed.as_secs_f64());

                // v5.2: Set LAST_BLOCK_PRODUCED_TIME to timestamp of last replayed block
                // This ensures correct timeout_round calculation after restart.
                // Without this, node thinks last block was "now" → local_delay=0 → timeout_round=0
                // → picks wrong producer → consensus deadlock with nodes that have been stalled.
                if last_replayed_block_timestamp > 0 {
                    LAST_BLOCK_PRODUCED_TIME.store(last_replayed_block_timestamp, std::sync::atomic::Ordering::Relaxed);
                    if is_info() {
                        let now_ts = get_timestamp_safe();
                        let stale = now_ts.saturating_sub(last_replayed_block_timestamp);
                        println!("[INFO][STATE] last_block_time_from_replay ts={} stale={}s",
                                 last_replayed_block_timestamp, stale);
                    }
                }

                // Verify final merkle root matches the last block's state_root
                // NOTE: block.state_root stores finalize_merkle() output (merkle root),
                // NOT calculate_state_root() which includes height+total_supply.
                if replayed > 0 {
                    // Owns-index (NON-consensus): NOT force-dirtied here. Replay rebuilds in-memory state up
                    // to the persisted tip, which wallet_token already covers; the durable owns-watermark
                    // (below) lets the boot gate rebuild ONLY when it actually lags the tip (unclean shutdown
                    // that lost the last deltas) — no multi-GB rebuild on every clean restart.
                    if let Ok(Some(last_block)) = storage.load_microblock_auto_format(pre_snapshot_chain_height) {
                        if last_block.state_root != [0u8; 32] {
                            let state_guard = state.write().await;
                            let final_merkle = state_guard.finalize_merkle();
                            if final_merkle == last_block.state_root {
                                boot_state_proven = replay_errors == 0;
                                println!("[INFO][STATE] replay_verified merkle_root={} h={}",
                                         hex::encode(&final_merkle[..8]), pre_snapshot_chain_height);
                            } else {
                                // Post-replay state divergence — should be impossible once the replay floor is
                                // correct (CRIT-1). If it ever fires, the node's checkpoint content will not
                                // match peers (content_ok) so it CANNOT finalize/sign — it stalls locally
                                // (no network fork) until an operator restart/resync rebuilds canonical state.
                                eprintln!("[ERR][STATE] replay_merkle_drift expected={} computed={} h={} — node cannot finalize until resync",
                                          hex::encode(&last_block.state_root[..8]),
                                          hex::encode(&final_merkle[..8]),
                                          pre_snapshot_chain_height);
                                crate::block_pipeline::mark_state_suspect(); // abstain from certifying until resynced
                                crate::sync_manager::request_wholesale_state_resync(); // self-heal, no operator restart
                            }
                        }
                    }
                }
            }
        }

        // CF↔merkle true-up at boot — ONLY on a proven state (verified snapshot with no
        // tail, or zero-error replay whose root matched the tip). An unproven leaf set
        // must never drive CF deletions.
        if boot_state_proven {
            // Staged candidates first (a rollback or decree prune that never reached its
            // reconcile), then the small-deployment full sweep as the belt.
            Self::trueup_staged_candidates(&state, &storage).await;
            Self::trueup_accounts_cf(&state, &storage).await;
        }

        // v5.1: Initialize restart-sensitive statics from recovered chain state
        // Without this, statics start at 0 and cause spurious behavior on first tick:
        //   - METRIC_LAST_RESET=0 → immediate metrics dump with empty/stale data
        //   - LAST_VRF_KEY_ANNOUNCE_HEIGHT=0 → redundant VRF key broadcast on first block
        if pre_snapshot_chain_height > 0 {
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            METRIC_LAST_RESET.store(now_secs, std::sync::atomic::Ordering::Relaxed);

            // Suppress immediate VRF re-announce: pretend we announced recently.
            // The node will still announce at the next 90-block boundary.
            let vrf_init = if pre_snapshot_chain_height > 45 {
                pre_snapshot_chain_height - 45
            } else {
                0
            };
            LAST_VRF_KEY_ANNOUNCE_HEIGHT.store(vrf_init, std::sync::atomic::Ordering::Relaxed);

            // v9.0: Initialize finalized height/round to prevent accepting stale consensus msgs.
            // CONTENT-GATED (P3): never boot-finalize a window whose local bodies diverge from the QC —
            // a node that applied a losing fork (chain_height reflects it) but hasn't been repaired to
            // canonical must NOT pin finality on the fork across the restart (else the finality-guarded
            // rollback can never heal it). Ceiling = highest content-matching sealed window <= chain_height.
            let finalized_round = Self::boot_content_finality_ceiling(&storage, pre_snapshot_chain_height);
            LAST_FINALIZED_CONSENSUS_ROUND.store(finalized_round, std::sync::atomic::Ordering::SeqCst);
            LAST_FINALIZED_HEIGHT.store(finalized_round, std::sync::atomic::Ordering::SeqCst);

            // The anti-double-sign watermark must survive the restart, or a node that rolled back and
            // came up again would happily sign a height it already signed.
            let (signed_hwm, signed_window, signed_round, signed_last_h) =
                storage.load_highest_signed_mark().ok().flatten().unwrap_or((0, 0, 0, 0));
            HIGHEST_SIGNED_HEIGHT.store(signed_hwm, std::sync::atomic::Ordering::SeqCst);
            LAST_SIGNED_WINDOW.store(signed_window, std::sync::atomic::Ordering::SeqCst);
            LAST_SIGNED_ROUND.store(signed_round, std::sync::atomic::Ordering::SeqCst);
            LAST_SIGNED_HEIGHT.store(signed_last_h, std::sync::atomic::Ordering::SeqCst);

            if is_info() {
                println!("[INFO][STATE] restart_statics_init chain_h={} metric_reset=now vrf_announce_h={} finalized_round={} signed_hwm={}",
                         pre_snapshot_chain_height, vrf_init, finalized_round, signed_hwm);
            }
        }

        // Initialize production-ready mempool with AUTO-SCALING
        // v2.27.2: BENCHMARK MODE gets 10x larger mempool for 100K+ TPS testing
        let benchmark_mode = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        
        let auto_mempool_size = if let Some(manual_size) = std::env::var("QNET_MEMPOOL_SIZE")
            .ok()
            .and_then(|s| s.parse().ok()) {
            // Manual override
            manual_size
        } else {
            // AUTO-TUNE: Scale mempool based on network size
            // Use same network size estimation as storage sharding
            let network_size = storage.estimate_network_size_for_config();
            
            let base_size = match network_size {
                0..=100 => 200_000,        // Genesis/test: 200k (v4.1: 2x)
                101..=10_000 => 1_000_000, // Small network: 1M (v4.1: 2x)
                10_001..=100_000 => 2_000_000,  // Medium network: 2M (v4.1: 2x)
                _ => 2_000_000,            // Large network: 2M
            };
            
            // BENCHMARK MODE: 10x larger mempool for 100K+ TPS testing!
            let calculated_size = if benchmark_mode {
                let boosted = base_size * 10;  // 1M for genesis, 5M for small, etc.
                if is_info() { println!("[INFO][MEMPOOL] benchmark_mode capacity={}", boosted); }
                boosted
            } else {
                base_size
            };
            
            if is_info() { println!("[INFO][MEMPOOL] auto_scale network={} capacity={}", 
                    network_size, calculated_size); }
            
            calculated_size
        };
        
        let mempool_config = qnet_mempool::SimpleMempoolConfig {
            max_size: auto_mempool_size,
            // Per-gas-unit floor (single source of truth). MIN_GAS_PRICE * TRANSFER_gas = 0.0001 QNC min
            // transfer fee. Was mistakenly set to 100_000 (a total-fee value used as a per-unit price ⇒
            // 1 QNC min transfer, which silently dropped every user TX at admission).
            min_gas_price: qnet_state::transaction::MIN_GAS_PRICE,
            max_per_sender: std::env::var("QNET_MAX_PER_SENDER")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10_000),
        };
        
        // CRITICAL v2.26: No outer RwLock - SimpleMempool is already thread-safe (DashMap + parking_lot)
        // This eliminates 100K TPS bottleneck from external lock contention
        let mempool = Arc::new(qnet_mempool::SimpleMempool::new(mempool_config));

        // PRODUCTION v2.50: Set global mempool using OnceCell (lock-free)
        init_global_mempool(mempool.clone());

        // Persistent mempool — install storage hooks. Every admit/remove is
        // mirrored to the `mempool` CF via these callbacks; a clean restart
        // replays the CF through add_binary_transaction, restoring the exact
        // pre-crash queue. Arc<dyn Fn> keeps the mempool crate storage-free
        // (tests leave the hooks unset). One put_cf/delete_cf per call; boot
        // restore (≤500k entries) runs in spawn_blocking.
        {
            let storage_admit = storage.clone();
            let storage_remove = storage.clone();
            let admit_cb: Arc<dyn Fn(&str, &[u8], u64) + Send + Sync> =
                Arc::new(move |hash: &str, payload: &[u8], ts: u64| {
                    if let Err(e) = storage_admit.save_pending_tx(hash, payload, ts) {
                        if is_warn() {
                            println!("[WARN][MEMPOOL] persist_admit_failed hash={} err={:?}",
                                     qnet_state::char_prefix(&hash, 16), e);
                        }
                    }
                });
            let remove_cb: Arc<dyn Fn(&str) + Send + Sync> =
                Arc::new(move |hash: &str| {
                    if let Err(e) = storage_remove.delete_pending_tx(hash) {
                        if is_warn() {
                            println!("[WARN][MEMPOOL] persist_remove_failed hash={} err={:?}",
                                     qnet_state::char_prefix(&hash, 16), e);
                        }
                    }
                });
            mempool.set_persistence_hooks(admit_cb, remove_cb);
        }

        // ────────────────────────────────────────────────────────────────────
        // v15.9: BOOT-TIME REHYDRATION — replay every persisted TX back into
        // the in-RAM mempool. Done before the node starts accepting new
        // P2P traffic so any TX that was admitted before the previous
        // shutdown is immediately available to the next block producer.
        //
        // The scan + replay runs on the blocking pool because at large
        // mempool sizes (≥ 100 000 entries) the RocksDB iteration plus
        // per-entry `add_binary_transaction` work is not trivial and we
        // do not want it on the tokio reactor.
        // ────────────────────────────────────────────────────────────────────
        {
            let storage_load = storage.clone();
            let mempool_load = mempool.clone();
            match tokio::task::spawn_blocking(move || {
                let entries = storage_load.load_all_pending_txs()
                    .unwrap_or_else(|e| {
                        eprintln!("[WARN][MEMPOOL] persist_load_failed err={:?}", e);
                        Vec::new()
                    });
                let total = entries.len();
                let (mut admitted, mut expired) = (0u64, 0u64);
                // TTL is measured from an in-process Instant, so rehydration hands every entry a
                // fresh age and a TX that has been pending for days looks new after each restart —
                // it could never expire. The persisted admission wall-clock is the real age: drop
                // what is already past the TTL and purge it, so stale entries cannot outlive
                // restarts, re-enter blocks and fail apply forever.
                let ttl_secs: u64 = crate::node::mempool_ttl_secs();
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                for (tx_hash, payload, admission_ts) in entries {
                    if admission_ts > 0 && now_secs.saturating_sub(admission_ts) > ttl_secs {
                        let _ = storage_load.delete_pending_tx(&tx_hash);
                        expired += 1;
                        continue;
                    }
                    // Best-effort gas_price decode for priority-queue ordering.
                    // If the persisted payload deserialises as a Transaction
                    // we use its `gas_price`; otherwise we admit at 0 (system
                    // priority will be re-derived inside add_binary_transaction
                    // via `is_system_tx()` parsing).
                    let gas_price = bincode::deserialize::<qnet_state::Transaction>(&payload)
                        .map(|tx| tx.gas_price)
                        .unwrap_or(0);
                    // Rehydrated admit keeps the ORIGINAL admission age (RAM clock
                    // back-dated, disk ts restored) — the plain path re-stamped both
                    // with `now`, granting survivors a fresh TTL on every restart.
                    if mempool_load.add_binary_transaction_rehydrated(payload, tx_hash, gas_price, admission_ts) {
                        admitted += 1;
                    }
                }
                (total, admitted, expired)
            }).await {
                Ok((total, admitted, expired)) => {
                    if total > 0 && is_info() {
                        println!("[INFO][MEMPOOL] persist_restore total={} admitted={} expired={}",
                                 total, admitted, expired);
                    }
                }
                Err(e) => {
                    eprintln!("[WARN][MEMPOOL] persist_restore_join_failed err={:?}", e);
                }
            }
        }
        
        // Generate unique node_id for Byzantine consensus
        let node_id = Self::generate_unique_node_id(node_type).await;
        
        // Genesis-ID validation: gate on BOTH BOOTSTRAP_ID and DOCKER_ENV
        // (genesis compose always sets both). Super-nodes have DOCKER_ENV only
        // and must NOT trigger this validation.
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() && std::env::var("DOCKER_ENV").is_ok() {
            if !node_id.starts_with("genesis_node_") {
                eprintln!("[ERR][NODE] genesis_invalid_id id={} expected=genesis_node_XXX", node_id);
                eprintln!("[ERR][NODE] check_env QNET_BOOTSTRAP_ID={:?}",
                         std::env::var("QNET_BOOTSTRAP_ID"));
                set_node_state(NodeState::Error {
                    reason: "Genesis node cannot start with fallback ID".to_string(),
                    recoverable: false,
                });
                eprintln!("[CRIT][GEN] genesis_fallback_id_fatal msg=check_QNET_BOOTSTRAP_ID");
                std::process::exit(1);
            } else {
                if is_info() { println!("[INFO][NODE] genesis_id_validated id={}", node_id); }
            }
        }
        
        // Validate no process ID in production node IDs (fallback detection)
        // v4.3: Use starts_with to avoid false positive when Docker PID=1 matches "001"
        let fallback_pattern = format!("node_{}_", std::process::id());
        if node_id.starts_with(&fallback_pattern) {
            if is_warn() { println!("[WARN][NODE] fallback_id id={} not_for_production", node_id); }
        }
        // v2: legacy CommitRevealConsensus engine removed — Checkpoint-BFT is the only consensus.
        
        // Validator disabled for now
        
        // SYNC: Check if we need to catch up with the network
        if let Ok(Some((from, to, current))) = storage.load_sync_progress() {
            if is_debug() { println!("[DBG][SYNC] prev_progress {}/{} from={}", current, to, from); }
            // Will resume sync after P2P initialization
        }
        
        // Get current height from storage
        if is_debug() { println!("[DBG][NODE] loading_chain_height"); }
        let mut height = match storage.get_chain_height() {
            Ok(height) => {
                if is_debug() { println!("[DBG][NODE] chain_height={}", height); }
                
                // CRITICAL FIX: Initialize P2P local height for message filtering
                // v9.0: Release ordering pairs with Acquire in consensus paths
                crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
                    height,
                    std::sync::atomic::Ordering::Release
                );
                // Warm-restart cold-joiner: reload the persisted snapshot anchor on the main boot path,
                // before the verify pipeline accepts blocks, so SNAPSHOT_ANCHOR_MB is set when anchor+1
                // first arrives. No-op for fresh/genesis; consensus-listener boot reloads again as backstop.
                // Complete any snapshot promote interrupted by a crash BEFORE reloading the anchor
                // (idempotent: re-copies from the intact staging, then clears the marker).
                if let Some(s) = try_get_storage() { s.recover_pending_snapshot_promote(Some(&state)).await; }
                reload_snapshot_anchor();
                // A recovered promote may have advanced chain_height — re-read so the rest of boot
                // (integrity checks, p2p height) uses the promoted height, not the pre-recovery value.
                let height = try_get_storage().and_then(|s| s.get_chain_height().ok()).unwrap_or(height);
                // Plain store, not fetch_max: a recovered REGRESS promote legitimately LOWERS the
                // height, and no concurrent height writer is live yet at this point of boot.
                crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(height, std::sync::atomic::Ordering::Release);
                if is_debug() { println!("[DBG][NODE] p2p_height_init={}", height); }

                height
            }
            Err(e) => {
                eprintln!("[ERR][NODE] chain_height_fail err={}", e);
                return Err(QNetError::StorageError(format!("Failed to get chain height: {}", e)));
            }
        };
        
        // DATA CONSISTENCY CHECK: Detect potential issues but NEVER auto-delete
        let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                              std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1";
        
        // Identify which network we're on
        let network_type = std::env::var("QNET_NETWORK")
            .unwrap_or_else(|_| "testnet".to_string());
        
        // Check for potential data inconsistencies
        if is_genesis_node && height > 0 {
            // Genesis phase is first 1000 blocks
            if height > 1000 {
                if is_info() { println!("[INFO][NODE] post_genesis network={} h={} age_days={}", 
                         network_type, height, height / (24 * 60 * 60)); }
            } else {
                if is_info() { println!("[INFO][NODE] genesis_phase network={} h={} remaining={}", 
                         network_type, height, 1000 - height); }
            }
            
            // Check data integrity (but don't delete!)
            match storage.get_block_hash(height) {
                Ok(Some(hash)) => {
                    if is_info() { println!("[INFO][NODE] integrity_ok hash={}...", &hash[..8]); }
                }
                Ok(None) => {
                    if is_warn() { println!("[WARN][NODE] block_missing h={} possible_corruption", height); }
                }
                Err(e) => {
                    if is_warn() { println!("[WARN][NODE] integrity_check_fail err={}", e); }
                }
            }
            
            // Warn if mixing networks (but still allow it)
            if height > 1000 && is_genesis_node {
                if is_info() { println!("[INFO][NODE] genesis_post_data network={}", network_type); }
            }
        }
        
        // If user explicitly requests reset via environment variable
        if std::env::var("QNET_FORCE_RESET").unwrap_or_default() == "1" {
            let confirm = std::env::var("QNET_CONFIRM_RESET").unwrap_or_default();
            if confirm == "YES" {
                if is_warn() { println!("[WARN][NODE] force_reset_confirmed"); }
                
                if let Err(e) = storage.reset_chain_height() {
                    eprintln!("[ERR][NODE] reset_fail err={}", e);
                } else {
                    height = 0;
                    if is_info() { println!("[INFO][NODE] reset_h=0"); }
                }
            } else {
                if is_warn() { println!("[WARN][NODE] reset_not_confirmed h={}", height); }
            }
        }
        
        // Performance configuration
        let perf_config = PerformanceConfig::default();
        
        // Security configuration (production mode)
        let security_config = qnet_core::security::SecurityConfig::production(node_id.clone());
        
        // Microblock interval (spec: exactly 1 second, June-2025)
        // For production, always use 1 second interval
        let microblock_interval = Duration::from_secs(
            env::var("QNET_MICROBLOCK_INTERVAL")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|v| *v >= 1)
                .unwrap_or(1) // Always 1 second for production
        );
        
        // Create unified P2P with regional clustering
        if is_debug() { println!("[DBG][P2P] unified_p2p_init"); }
        
        // v3.18: Super node type removed
        let unified_node_type = match node_type {
            NodeType::Light => UnifiedNodeType::Light,
            NodeType::Super => UnifiedNodeType::Super,
        };
        
        let unified_region = match region {
            Region::NorthAmerica => UnifiedRegion::NorthAmerica,
            Region::Europe => UnifiedRegion::Europe,
            Region::Asia => UnifiedRegion::Asia,
            Region::SouthAmerica => UnifiedRegion::SouthAmerica,
            Region::Africa => UnifiedRegion::Africa,
            Region::Oceania => UnifiedRegion::Oceania,
        };
        
        // FIX H1: Bounded channels with backpressure — prevents OOM under flood
        // Capacity sized for burst tolerance: 5K blocks, 50K txs
        let (block_tx, mut block_rx) = tokio::sync::mpsc::channel(5_000);

        // v5.6: Extended with from_peer_addr so responses reach unregistered new nodes
        let (sync_request_tx, mut sync_request_rx) = tokio::sync::mpsc::channel::<(u64, u64, String, String)>(1_000);

        // PRODUCTION v2.19.12: Create macroblock sync channels
        let (macroblock_tx, mut macroblock_rx) = tokio::sync::mpsc::channel(1_000);
        let (macroblock_sync_tx, mut macroblock_sync_rx) = tokio::sync::mpsc::channel::<(u64, u64, String, String)>(1_000);

        // PRODUCTION v2.19.22: Create QUIC message channel for full message processing
        // QoS: consensus/high-priority lane.
        let (quic_message_tx, mut quic_message_rx) = tokio::sync::mpsc::channel::<(String, crate::unified_p2p::NetworkMessage)>(10_000);
        // QoS bulk lane: bounded smaller (droppable) so a cold-sync flood is
        // shed at ingress instead of starving consensus. Drained by its own task.
        let (quic_bulk_tx, mut quic_bulk_rx) = tokio::sync::mpsc::channel::<(String, crate::unified_p2p::NetworkMessage)>(2_000);
        // QoS finality lane: reserved for non-redundant n−f checkpoint/round-change msgs.
        // Sized to the committee(≤1000) n−f rate (a full overlapping vote+timeout round +
        // dedup dups < 4096), NOT the 10k gossip lane; a drop here is UNREPAIRABLE.
        // INVARIANT: if the committee cap ever exceeds 1000, scale to ≥ ~4× committee.
        let (quic_finality_tx, mut quic_finality_rx) = tokio::sync::mpsc::channel::<(String, crate::unified_p2p::NetworkMessage)>(4_096);

        // PRODUCTION v2.19.25: Create transaction processing channel
        let (transaction_tx, mut transaction_rx) = tokio::sync::mpsc::channel::<crate::unified_p2p::ReceivedTransaction>(50_000);
        
        if is_debug() { println!("[DBG][P2P] simplified_p2p_create"); }
        let mut unified_p2p_instance = SimplifiedP2P::new(
            node_id.clone(),
            unified_node_type,
            unified_region,
            p2p_port,
        );
        
        // v2.76: Set storage reference for scalable heartbeat persistence (millions of nodes)
        unified_p2p_instance.set_storage(storage.clone());
        
        // PRODUCTION: Set block processing channel for received blocks
        unified_p2p_instance.set_block_channel(block_tx);
        unified_p2p_instance.set_sync_request_channel(sync_request_tx);
        
        // PRODUCTION v2.19.12: Set macroblock sync channels
        unified_p2p_instance.set_macroblock_channel(macroblock_tx);
        unified_p2p_instance.set_macroblock_sync_channel(macroblock_sync_tx);
        
        // PRODUCTION v2.19.22: Set QUIC message channel for full message processing
        unified_p2p_instance.set_quic_message_channel(quic_message_tx);
        unified_p2p_instance.set_quic_bulk_channel(quic_bulk_tx);
        unified_p2p_instance.set_quic_finality_channel(quic_finality_tx);
        
        // PRODUCTION v2.19.25: Set transaction channel for mempool integration
        unified_p2p_instance.set_transaction_channel(transaction_tx);
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION FIX v2.30: Load certificate history from disk
        // ONLY for Super nodes — Light nodes don't participate in consensus!
        // (v3.18: the "Full" tier was removed from the protocol.)
        // ═══════════════════════════════════════════════════════════════════════════
        if node_type != NodeType::Light {
            // Use QNET_STORAGE_PATH (set during init) with fallback to "data"
            let storage_path = std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "data".to_string());
            let data_dir = std::path::Path::new(&storage_path);
            if data_dir.exists() {
                {
                    let mut cert_manager = unified_p2p_instance.certificate_manager.write();
                    match cert_manager.load_from_disk(data_dir) {
                        Ok(_) => { if is_info() { println!("[INFO][NODE] cert_history_loaded path={}", storage_path); } }
                        Err(e) => { if is_warn() { println!("[WARN][NODE] cert_load_fail err={}", e); } }
                    }
                }
            }
        } else {
            if is_info() { println!("[INFO][NODE] skip_cert_history reason=light_node"); }
        }
        
        // CRITICAL: Initialize all Genesis node reputations deterministically at startup
        // This prevents race conditions where different nodes see different candidate lists
        Self::initialize_genesis_reputations(&unified_p2p_instance).await;
        
        // GENESIS BOOTSTRAP LOGIC:
        // - 5 Genesis nodes use special codes QNET-BOOT-000X-STRAP or QNET_BOOTSTRAP_ID env var
        // - They don't require standard activation, they bootstrap the network
        // - All Genesis nodes MUST run on port 8001
        // - Regular nodes require standard activation codes QNET-XXXXXX-XXXXXX-XXXXXX
        // - Light nodes are mobile-only and cannot run on servers
        
        // P2P FIX: Add Genesis bootstrap peers ONLY for Genesis nodes themselves
        // SCALABILITY: Regular nodes (Full/Light) should discover peers via DHT, not direct Genesis connection
        // This prevents Genesis nodes from being overwhelmed when millions of nodes join
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            use crate::unified_p2p::get_genesis_bootstrap_ips;
            let genesis_ips = get_genesis_bootstrap_ips();
            let genesis_peers: Vec<String> = genesis_ips.iter()
                .map(|ip| format!("{}:8001", ip))
                .collect();
            
            if is_info() { println!("[INFO][P2P] genesis_bootstrap peers={}", genesis_peers.len()); }
            unified_p2p_instance.add_discovered_peers(&genesis_peers);
            
            // P2P FIX: Start peer exchange after adding Genesis peers
            // This ensures the exchange protocol has peers to work with
            // NOTE: Genesis reconnection is handled separately in main loop (every 10 seconds)
            let initial_peers = unified_p2p_instance.get_discovery_peers();
            let peer_count = initial_peers.len();
            
            if !initial_peers.is_empty() {
                unified_p2p_instance.start_peer_exchange_protocol(initial_peers);
                if is_info() { println!("[INFO][P2P] peer_exchange_started peers={}", peer_count); }
            } else {
                if is_debug() { println!("[DBG][P2P] no_peers_yet reconnect_later"); }
            }
        } else {
            // SCALABILITY: Regular nodes (Full/Light) in production with millions of nodes
            // Should NOT directly connect to Genesis nodes to avoid overload
            // They will discover peers through DHT and peer exchange protocol
            if is_info() { println!("[INFO][P2P] dht_discovery type={:?}", node_type); }
        }
        
        // PRODUCTION v2.19.21: Initialize QUIC transport for high-performance P2P
        // High-performance binary protocol for production networks
        {
            // Get external IP for QUIC
            let external_ip = std::env::var("EXTERNAL_IP")
                .or_else(|_| std::env::var("HOST_IP"))
                .unwrap_or_else(|_| "0.0.0.0".to_string());
            
            // Get certificate serial from PQ crypto
            let cert_serial = format!("cert_{}_{}", node_id, 
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs());
            
            if let Err(e) = unified_p2p_instance.init_quic(&external_ip, &cert_serial).await {
                // QUIC is REQUIRED for v2.19.22+
                // Without QUIC, node cannot participate in P2P network
                eprintln!("[ERR][QUIC] init_fail err={}", e);
                eprintln!("[ERR][QUIC] required_for_p2p open_udp_10876");
                
                // STATE MACHINE: Fatal network error
                set_node_state(NodeState::Error {
                    reason: format!("QUIC transport failed: {}", e),
                    recoverable: false,
                });
                
                return Err(QNetError::NetworkError(
                    format!("QUIC transport required but failed to initialize: {}. Open UDP port 10876.", e)
                ));
            }
        }
        
        let unified_p2p = Arc::new(unified_p2p_instance);
        
        // Start unified P2P (must start before blockchain creation)
        unified_p2p.start();
        
        // QUANTUM AUTO-SCALING: Automatically enable sharding for large networks
        let auto_enable_sharding = || -> bool {
            // Check manual override first
            if env::var("QNET_ENABLE_SHARDING").unwrap_or_default() == "1" {
                return true;
            }
            
            // AUTO-DETECTION based on the GLOBAL active Super-node population
            // (NOT local peers!). v3.18: "Full" tier removed.
            // Light nodes are NOT counted - only consensus-participating nodes
            let active_nodes = unified_p2p.get_active_full_super_nodes();
            let network_size = active_nodes.len();
            
            // Auto-enable when network grows (same threshold for all node types)
            if network_size >= 1000 {
                if is_info() { println!("[INFO][SHARD] auto_enabled nodes={} threshold=1000", network_size); }
                return true;
            }
            
            false
        };
        
        // Initialize sharding components for production.
        // SHARDING DEFERRED (user decision: single-shard 50k TPS is sufficient). The coordinator is
        // pinned OFF (`if false`) so the unhardened cross-shard path can NEVER auto-arm at scale: with
        // shard_coordinator == None, adjust_shard_count (its sole caller is behind a Some(..) guard) is
        // unreachable so total_shards stays 1, and cross-shard TX routing (also Some-guarded) is skipped
        // — network-wide, deterministically, regardless of node count or QNET_ENABLE_SHARDING. The
        // qnet_sharding crate + auto_enable_sharding stay intact; re-arm later by restoring the guard
        // (after SHARD-1/2/3 hardening).
        let shard_coordinator: Option<Arc<qnet_sharding::ShardCoordinator>> =
            if false && (perf_config.enable_sharding || auto_enable_sharding()) {
                let coordinator = Arc::new(qnet_sharding::ShardCoordinator::new());
                if is_info() { println!("[INFO][SHARD] connect shard_id={}", unified_p2p.get_shard_id()); }
                Some(coordinator)
            } else {
                None
            };
        
        let parallel_validator = if perf_config.parallel_validation {
            Some(Arc::new(qnet_sharding::ParallelValidator::new(
                perf_config.parallel_threads,
            )))
        } else {
            None
        };
        
        // Initialize archive replication manager
        if is_debug() { println!("[DBG][NODE] archive_manager_init"); }
        let mut archive_manager = crate::archive_manager::ArchiveReplicationManager::new();
        
        // Initialize reward manager with Genesis timestamp
        if is_debug() { println!("[DBG][NODE] rewards_system_init"); }
        
        // Check if this is a Genesis bootstrap node (local check)
        let _is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        // CRITICAL v2.32 / v8.0: Genesis timestamp MUST come from Genesis block #0.
        // NEVER fallback to SystemTime::now() — that creates a per-node genesis_ts
        // causing ALL synced blocks to fail TIMESTAMP_INVALID validation.
        // Sentinel 0 disables timestamp checks until the real genesis block arrives.
        storage.adopt_genesis_anchor(); // one-time: pin the identity a long-running node already has
        let genesis_timestamp = match storage.load_microblock_auto_format(0) {
            Ok(Some(genesis_block)) => {
                if is_info() { println!("[INFO][GEN] loaded_ts={}", genesis_block.timestamp); }
                // Apply genesis registrations canonically (reg_height 0 + vrf co-resident) so a former
                // creator — which only cached them without height/vrf — is byte-identical to synced peers.
                // Idempotent (immutable once stamped).
                Self::apply_genesis_registrations(&storage, &genesis_block.transactions);
                genesis_block.timestamp
            }
            Ok(None) => {
                if is_info() { println!("[INFO][GEN] no_genesis_block sentinel=0 waiting_for_network"); }
                0 // Sentinel — timestamp validation disabled until genesis synced
            }
            Err(e) => {
                // Expired tx rows with the header retained: timing comes from the header (registrations
                // are already stamped from an earlier boot); the body returns via store-only backfill.
                let header_ts = storage.block_timestamp_at(0).ok().flatten().unwrap_or(0);
                if header_ts > 0 {
                    println!("[WARN][GEN] body_unreadable err={} using_header_ts={}", e, header_ts);
                } else {
                    eprintln!("[ERR][GEN] load_fail err={} sentinel=0 waiting_for_network", e);
                }
                header_ts
            }
        };
        
        // CRITICAL: Update global pricing state with Genesis timestamp
        // This enables dynamic pricing in quantum_crypto.rs
        crate::set_genesis_timestamp(genesis_timestamp);
        if is_info() { println!("[INFO][PRICING] init genesis_ts={}", genesis_timestamp); }
        
        
        // Get node IP for archive registration - use ENV or auto-detect
        let node_ip = match std::env::var("QNET_PUBLIC_IP") {
            Ok(ip) => format!("{}:{}", ip, p2p_port),
            Err(_) => {
                // PRODUCTION: Auto-detect public IP or use P2P discovered address
                // For now, fallback to local for development only
                if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
                    if is_warn() { println!("[WARN][NODE] public_ip_not_set"); }
                }
                format!("0.0.0.0:{}", p2p_port) // Listen on all interfaces
            }
        };
        
        // Register node for MANDATORY archival responsibilities (no choice)
        if let Err(e) = archive_manager.register_archive_node(&node_id, node_type, &node_ip).await {
            if is_warn() { println!("[WARN][NODE] archive_reg_fail err={}", e); }
        } else {
            // v3.18: Super node type removed
            let quota = match node_type {
                NodeType::Light => 0,
                NodeType::Super => 8,
            };
            if is_info() { println!("[INFO][NODE] archive_reg chunks={}", quota); }
        }
        
        // Initialize Parallel Executor if sharding is enabled
        let parallel_executor = if let (Some(ref shard_coord), Some(ref parallel_val)) = (&shard_coordinator, &parallel_validator) {
            let executor = Arc::new(crate::parallel_executor::ParallelExecutor::new(
                shard_coord.clone(),
                parallel_val.clone(),
            ));
            if is_info() { println!("[INFO][EXEC] parallel_executor_init"); }
            Some(executor)
        } else {
            None
        };
        
        // Initialize Adaptive BFT for adaptive timeouts
        // CRITICAL: Balance between 1 block/sec target and network latency
        // PRODUCTION: Must account for broadcast time (800-900ms) + processing + consensus
        // v2.26.7: Extended timeout in benchmark mode to prevent deadlock during stress tests
        let benchmark_mode_timeout = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let adaptive_bft_config = crate::adaptive_bft::AdaptiveBftConfig {
            base_timeout_ms: if benchmark_mode_timeout { 10000 } else { 5000 },  // 10s base in benchmark
            timeout_multiplier: 1.5,    
            max_timeout_ms: if benchmark_mode_timeout { 60000 } else { 15000 }, // 60s in benchmark, 15s in prod
            min_timeout_ms: 3000,       // 3 seconds minimum
            latency_window_size: 100,   
        };
        let adaptive_bft = Arc::new(crate::adaptive_bft::AdaptiveBft::new(adaptive_bft_config));
        if is_info() { println!("[INFO][BFT] adaptive_timeout_manager=ready"); }
        
        // Initialize Pre-execution manager
        let pre_execution_config = crate::pre_execution::PreExecutionConfig {
            lookahead_blocks: 3,      // Pre-execute 3 blocks ahead
            max_tx_per_block: 200000,  // 200K TX/block max (v4.1: 2x)
            cache_size: 600000,       // Cache 3 blocks × 200K TX
            timeout_ms: 500,          // 500ms timeout
        };
        let pre_execution = Arc::new(crate::pre_execution::PreExecutionManager::new(pre_execution_config));
        if is_info() { println!("[INFO][PREEXEC] speculative_exec=ready"); }
        
        // Initialize event-based block notification system
        // Channel capacity: 100 (enough for burst of blocks, old events auto-dropped)
        let (block_event_tx, _block_event_rx) = tokio::sync::broadcast::channel(100);
        if is_info() { println!("[INFO][EVENTS] block_notifications=ready"); }
        
        // Reputation is derived deterministically from on-chain state ({70 floor |
        // 0 if a verified equivocation proof is recorded}); no RAM engine to seed.
        
        // MEV PROTECTION: Initialize optional private bundle mempool
        // ARCHITECTURE: Dynamic 0-20% allocation protects public TX throughput
        // MEV protection (private bundles) — ALWAYS ON, no flag. Idle cost is ZERO: dynamic
        // allocation reserves 0% block space until a bundle is actually submitted, so it engages
        // only under real demand and never penalises public TXs when unused. Per-node, not a
        // consensus param (a node composes its own blocks; validators accept any valid block ⇒
        // on/off could never fork) — so there is no reason to expose an operator toggle.
        let mev_mempool = {
            let bundle_config = qnet_mempool::BundleAllocationConfig {
                min_allocation: 0.0,     // 0% minimum (no reservation when no demand)
                max_allocation: 0.20,    // 20% maximum (protects public TXs ≥80%)
                max_txs_per_bundle: 10,  // Max 10 TXs per bundle
                min_reputation: 80.0,    // 80% reputation required (anti-spam)
                gas_premium: 1.20,       // +20% gas (compensates block space inefficiency)
                max_lifetime_sec: 60,    // 60 seconds max (prevents mempool bloat)
                submission_fanout: 3,    // Submit to 3 producers (load distribution)
            };
            if is_info() { println!("[INFO][MEV] protection=on allocation=0-20%"); }
            Some(Arc::new(qnet_mempool::MevProtectedMempool::new(mempool.clone(), bundle_config)))
        };
        

        if is_debug() { println!("[DBG][NODE] creating_struct"); }
        
        let mut blockchain = Self {
            storage,
            state,
            mempool,
            // validator, // disabled for compilation
            unified_p2p: Some(unified_p2p),
            node_id: node_id.clone(),
            node_type,
            region,
            mev_mempool,
            rotation_tracker: Arc::new(RotationTracker::new()),
            p2p_port,
            bootstrap_peers,
            perf_config,
            security_config,
            height: Arc::new(RwLock::new(height)),
            is_running: Arc::new(RwLock::new(false)),
            current_microblocks: Arc::new(RwLock::new(Vec::new())),
            last_microblock_time: Arc::new(RwLock::new(Instant::now())),
            microblock_interval,
            is_leader: Arc::new(RwLock::new(false)), // PRODUCTION: Dynamic producer selection based on reputation rotation
            
            // DYNAMIC: Block production timing (no timestamp dependency)  
            last_block_attempt: Arc::new(tokio::sync::Mutex::new(None)),
            

            
            // PRODUCTION: Initialize consensus phase synchronization
            consensus_nonce_storage: Arc::new(RwLock::new(HashMap::new())),
            
            shard_coordinator,
            parallel_validator,
            archive_manager: Arc::new(tokio::sync::RwLock::new(archive_manager)),
            // v2.96: DashMap for confirmation tracking + retry
            heartbeat_commitment_tracker: Arc::new(DashMap::new()),
            bitmap_commitment_tracker: Arc::new(DashMap::new()),
            parallel_executor,
            adaptive_bft,
            pre_execution,
            block_event_tx,
            node_registration_cache: Arc::new(DashMap::new()),
            wallet_identity: None,
            vrf_instance: None,
            // L1 architecture: initialized in start() after storage/state ready
            coordinator_handle: None,
            pipeline_ingest: None,
            sync_handle: None,
        };
        
        // v4.3: Initialize global P2P instance for TX broadcast from activation_validation.rs
        if let Some(ref p2p) = blockchain.unified_p2p {
            init_global_p2p(p2p.clone());
        }
        
        // PRODUCTION v4.0: Initialize WalletIdentity from QNET_WALLET_SEED
        if let Some(wallet_seed) = load_wallet_seed("QNET_WALLET_SEED") {
            match blockchain.initialize_wallet_identity(&wallet_seed) {
                Ok(()) => println!("[INFO][NODE] wallet_identity initialized from QNET_WALLET_SEED"),
                // FATAL: identity-anchor mismatch / keypair-derivation failure is the documented
                // halt_startup case (a wrong seed → a key no peer's registry accepts → silent
                // signature invalidation = the pk_mismatch/h=781 incident). Must HALT, not run as a
                // non-signing zombie with the wrong key already cached. Matches genesis_fallback_id_fatal.
                Err(e) => {
                    eprintln!("[CRIT][NODE] wallet_identity_init_fatal err={} action=halt_startup", e);
                    std::process::exit(1);
                }
            }
        } else if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            // Genesis nodes: generate identity from bootstrap config
            let genesis_seed = load_wallet_seed("QNET_GENESIS_SEED").ok_or(std::env::VarError::NotPresent)
                .unwrap_or_else(|_| format!("genesis_bootstrap_{}", node_id));
            match blockchain.initialize_wallet_identity(&genesis_seed) {
                Ok(()) => println!("[INFO][NODE] genesis wallet_identity initialized"),
                Err(e) => {
                    eprintln!("[CRIT][NODE] genesis_wallet_identity_fatal err={} action=halt_startup", e);
                    std::process::exit(1);
                }
            }
        }
        
        // v5.0: Share wallet identity with P2P layer for ML-DSA-65-signed HealthPing
        if let (Some(ref identity), Some(ref p2p)) = (&blockchain.wallet_identity, &blockchain.unified_p2p) {
            p2p.set_wallet_identity(identity.clone());
        }

        // BOOTSTRAP-WINDOW MINIMISATION: aggressive VrfKeyAnnounce schedule.
        //
        // Why so aggressive
        // ─────────────────
        // Each genesis identity self-registers in its OWN registry at boot
        // (initialize_wallet_identity → register_consensus_pk_from_chain).
        // Cross-registration happens ONLY after peers receive a verified
        // `VrfKeyAnnounce`. Until cross-registration completes, the Tier-3
        // hard-reject for unbound genesis identities (consensus_crypto.rs)
        // drops every inter-genesis non-Vrf message.
        //
        // The historical one-shot 15s timer left a 15-20s blackout window
        // during which producer/heartbeat/active-announce traffic was
        // discarded — visible on a fresh cluster as missed early blocks
        // and pacemaker timeouts. We now broadcast on a tightening schedule:
        //
        //   * t = 1s  : first broadcast (P2P binding is typically done
        //               within <1s of process start; if a peer is not yet
        //               connected the send is a silent no-op, retried next).
        //   * t = 1s..30s : every 2s — catches every peer that finishes
        //                   QUIC handshake during the boot phase.
        //   * t = 30s..600s : every 60s — covers late-joiners (operator
        //                     starting nodes in sequence rather than
        //                     parallel).
        //   * t > 600s : the per-90-block schedule (already implemented at
        //                node.rs ~19273) takes over as steady-state
        //                maintenance.
        //
        // Auto-anchor knock-on
        // ────────────────────
        // `register_vrf_public_key` in genesis_constants.rs triggers an
        // atomic anchor-file write when all 5 genesis PKs are present. The
        // tightened schedule means that file lands on disk within ~2-4s of
        // process start instead of 15-20s, so even Boot 1 has near-zero
        // window when the operator subsequently restarts.
        //
        // Cost
        // ────
        // 15 × ML-DSA-65 sign + ~75 small UDP sends in the first 30s. At
        // ~3KB per signed announce that's < 250KB/30s ≈ 8KB/s — utterly
        // negligible vs. block traffic. Bounded to genesis identities (5).
        if let Some(ref p2p) = blockchain.unified_p2p {
            let p2p_clone = p2p.clone();
            tokio::spawn(async move {
                use tokio::time::{sleep, Duration, Instant};
                // Phase 1: brief settle for the QUIC binder + first peer
                // handshakes. 1s is more than enough on healthy networks
                // and reduces Boot-1 window dramatically vs. the previous
                // 15s wait.
                sleep(Duration::from_secs(1)).await;
                let start = Instant::now();

                // Phase 2: tight cadence during the bootstrap phase.
                while start.elapsed() < Duration::from_secs(30) {
                    p2p_clone.broadcast_vrf_key_announce();
                    sleep(Duration::from_secs(2)).await;
                }

                // Phase 3: maintenance cadence for late-joiners.
                while start.elapsed() < Duration::from_secs(600) {
                    p2p_clone.broadcast_vrf_key_announce();
                    sleep(Duration::from_secs(60)).await;
                }
                // After 10 min the steady-state per-90-block schedule
                // continues to handle any remaining propagation needs.
            });
        }

        // v5.1: Start Kademlia DHT routing table refresh task
        if let Some(ref p2p) = blockchain.unified_p2p {
            p2p.start_kademlia_refresh_task();
        }

        if is_debug() { println!("[DBG][NODE] created node_id={}", node_id); }
        
        // v4.0: Restore VRF public keys from persistent storage
        // v14.8: Also mirror each key into the consensus-layer registry.
        // Keys in persistent storage were all installed from chain-validated
        // NodeRegistration / NodeReactivation TXs, so they are authenticated.
        {
            match blockchain.storage.load_all_vrf_public_keys() {
                Ok(keys) => {
                    let count = keys.len();
                    for (nid, pk_bytes) in keys {
                        crate::genesis_constants::register_vrf_public_key(&nid, &pk_bytes);
                        let _ = qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(&nid, &pk_bytes);
                    }
                    if count > 0 {
                        println!("[INFO][NODE] vrf_pk_restored count={}", count);
                    }
                }
                Err(e) => {
                    println!("[WARN][NODE] vrf_pk_restore err={}", e);
                }
            }
        }

        // Genesis vrf_pk uniformity (CRITICAL): each node persists ONLY its OWN genesis key to storage
        // (peers are RAM-pinned by install_genesis_anchors_at_startup; the block-0 save is short-circuited
        // by has_vrf_key). But verify_burn_attestation_quorum resolves an attestor's PK ONLY from storage
        // (no RAM/anchor source, by design — registry eviction → fork, TOFV → forge). Without this seed,
        // every node would skip a PEER genesis attestor's sig → a non-genesis (super OR light) burn-
        // attested registration could never reach the 2f+1 quorum → onboarding is dead. Seed all pinned
        // genesis pks (O(5), idempotent, pre-P2P) so vrf_pk_ is byte-identical on every node.
        // Written UNCONDITIONALLY, not only when absent: this is also the repair path. The row is
        // reachable by anything that could once write it — the block-body registration scan does not
        // filter by apply success — and a poisoned genesis row is the worst case, because the burn
        // quorum above reads storage as its ONLY source and the boot reload re-imports the row into
        // RAM without re-authenticating it. Re-stamping the pinned value every boot makes such a row
        // survive at most until the next restart. O(5), idempotent, pre-P2P.
        for (gid, pk_hex) in crate::genesis_constants::GENESIS_CONSENSUS_PKS {
            if let Err(e) = blockchain.storage.save_vrf_public_key(gid, pk_hex) {
                println!("[WARN][NODE] genesis_vrf_seed_fail id={} err={}", gid, e);
            }
        }

        // No wallet reverse-index migration: wallet→node is resolved by deriving the id (pure fn of the
        // wallet) and point-reading node_<id> — there is no stored reverse index to backfill.

        // Reward-roster indices (srtr_/lrtr_) one-time migration for pre-index DBs. Marker-guarded so
        // the O(N) scan runs once, not on every restart (millions of light nodes). Fresh genesis sets
        // the marker on an empty registry; subsequent registrations index via the apply funnel.
        // Snapshot fast-sync reconciles separately at restore time.
        if !blockchain.storage.roster_index_built() {
            match blockchain.storage.backfill_roster_indices() {
                Ok(count) => {
                    let _ = blockchain.storage.set_roster_index_built();
                    if count > 0 { println!("[INFO][NODE] roster_index_migrated entries={}", count); }
                }
                Err(e) => println!("[WARN][NODE] roster_index_backfill err={}", e),
            }
        }

        // Native-QNC rich-list index (display-only) one-time build for a pre-index DB. Marker-guarded
        // so the O(holders) scan runs once, not on every restart. Snapshot/reorg rebuild separately.
        if !blockchain.storage.richlist_index_built() {
            // Marker ONLY after a rebuild that actually saw accounts. A transient error, or a boot
            // that ran before state was restored (empty accounts CF), leaves it unset so the next
            // boot retries — otherwise the O(N) build is skipped forever and the index depends
            // entirely on the incremental affected-address path.
            match Self::rebuild_richlist_index().await {
                Ok(0) => {
                    if is_info() {
                        println!("[INFO][RICHLIST] boot_rebuild_skipped reason=accounts_empty action=retry_next_boot");
                    }
                }
                Ok(_) => { let _ = blockchain.storage.set_richlist_index_built(); }
                Err(e) => { if is_warn() { println!("[WARN][RICHLIST] boot_rebuild_failed err={} — retry next boot", e); } }
            }
        }

        // Wallet→token index (NON-consensus): rebuild ONLY when it's not current — not built/clean, OR the
        // durable owns-watermark lags the tip (unclean shutdown lost the last deltas). A clean restart has
        // watermark == tip → skip the O(contracts) rebuild entirely. Rebuild from the in-memory tip (NOT the
        // accounts CF, whose replayed tail can lag). Empty state → empty index = truth.
        let owns_tip = blockchain.storage.get_chain_height().unwrap_or(0);
        if blockchain.storage.owns_index_built() && blockchain.storage.owns_watermark() >= owns_tip {
            crate::storage::OWNS_INDEX_READY.store(true, std::sync::atomic::Ordering::Relaxed);
        } else {
            // Derive only the live owns KEYS under the read guard (no contract_storage clones).
            let keys: Vec<Vec<u8>> = {
                let sg = blockchain.state.read().await;
                let mut keys = Vec::new();
                for e in sg.accounts.iter() {
                    if e.value().is_contract {
                        keys.extend(crate::storage::Storage::owns_index_keys(e.key(), &e.value().contract_storage));
                    }
                }
                keys
            };
            match blockchain.storage.rebuild_owns_from_keys(&keys, owns_tip) {
                Ok(rebuilt) => { if is_info() { println!("[INFO][NODE] owns_index_rebuilt_from_state keys={} up_to={}", rebuilt, owns_tip); } }
                Err(e) => {
                    // Leave dirty (READY stays false) so the reader scans and the next boot retries.
                    blockchain.storage.mark_owns_index_dirty();
                    println!("[WARN][NODE] owns_index_rebuild_failed err={} action=scan_fallback", e);
                }
            }
        }

        // Settle-point index first — it is the INPUT the shard heal below rebuilds from, and the one
        // write in this chain that gets a single block per epoch and no retry. A node that was catching
        // up across that block heals here instead of carrying the gap for the life of its database.
        {
            let boot_h = blockchain.storage.get_chain_height().unwrap_or(0);
            let sm = blockchain.get_state_manager();
            let st = sm.read().await;
            crate::node::BlockchainNode::backfill_settle_indices(&st, &blockchain.storage, boot_h);
            crate::node::BlockchainNode::backfill_light_recency(&blockchain.storage, boot_h);
        }

        // Heal any reward epoch holding a certified root but an Absent local shard (freeze-race / snapshot
        // join) so pending/claim serve the certified amount identically to a from-genesis node.
        let _ = crate::node::BlockchainNode::backfill_reward_shards(&blockchain.storage);
        // Anything the local rebuild could not reproduce — its inputs are gone — is pulled from a peer
        // and accepted only against this node's own certified root.
        crate::node::BlockchainNode::repair_unservable_reward_epochs(&blockchain.storage).await;

        // Rebuild the committed burn→wallet index (cbw) from node_registry at boot: migrates a pre-cbw
        // DB and self-heals a stale cbw left by a crash mid-reorg. Unconditional but super-scoped
        // (srtr_ roster only, O(supers)) — trivial for a genesis launch; bounded by the local height.
        {
            let boot_h = blockchain.storage.get_chain_height().unwrap_or(0);
            match blockchain.storage.rebuild_committed_burn_wallet(boot_h) {
                Ok(n) if n > 0 => println!("[INFO][NODE] cbw_rebuilt_at_boot bindings={} up_to={}", n, boot_h),
                Ok(_) => {}
                Err(e) => println!("[WARN][NODE] cbw_rebuild_boot err={}", e),
            }

            // registry_root LtHash (metadata CF, not snapshot-carried): ONE scan recomputes the
            // accumulator at the boot tip AND prunes any crash-mid-reorg orphans (reg_height > tip), so a
            // restarted / snapshot-joined / crash-recovered node is byte-identical to a from-genesis node.
            // No-op prune on a clean boot. Same derived-from-roster discipline as cbw.
            match blockchain.storage.rebuild_registry_lthash(boot_h) {
                Ok(n) if n > 0 => println!("[INFO][NODE] registry_lthash_rebuilt_at_boot orphans_pruned={} up_to={}", n, boot_h),
                Ok(_) => {}
                // HALT, not warn. This scan IS the registry_root the node will publish in every
                // checkpoint; a failure leaves the accumulator stale and un-pruned, so the node signs
                // a root no peer reproduces and is rejected from consensus with nothing in the log
                // tying it back here. Same rule as the wallet-identity init above.
                Err(e) => {
                    eprintln!("[CRIT][NODE] registry_lthash_rebuild_fatal err={} up_to={} action=halt_startup", e, boot_h);
                    std::process::exit(1);
                }
            }
            // The commitment-dedup maps are derived from block history, and a snapshot restore
            // rebuilds the chain view without them: a restarted node would hold dedup entries only
            // for the blocks it replayed, so a duplicate NodeRegistration naming an already-known
            // node_id is admitted here and rejected by from-genesis peers — the block still applies
            // everywhere (a registration has no account effect, so state_root matches) while only
            // this node rewrites the registry row and its registry_root delta. Reseeded from the
            // durable registry AFTER the prune above, which drops rows above the tip.
            {
                let sg = blockchain.state.read().await;
                if let Err(e) = blockchain.storage.reseed_commitment_dedup(&*sg) {
                    println!("[WARN][NODE] commitment_dedup_reseed_boot err={:?}", e);
                }
            }
            // FIX-5: dilithium_pk_root LtHash (metadata CF, not snapshot-carried) — recompute the pk
            // accumulator + count-markers so a restarted / crash-recovered node is byte-identical to a
            // from-genesis node. Derive from the in-memory tip (NOT the accounts CF, whose best-effort
            // replayed tail an unclean restart can drop → scanning it would omit rows AND clear their
            // markers, forking dpk_root forever). Same authoritative-source discipline as owns above.
            let dpk_binds: Vec<(String, Vec<u8>)> = {
                let sg = blockchain.state.read().await;
                sg.accounts.iter()
                    .filter_map(|e| e.value().dilithium_public_key.as_ref()
                        .filter(|pk| pk.len() == 1952)
                        .map(|pk| (e.key().clone(), pk.clone())))
                    .collect()
            };
            match blockchain.storage.rebuild_dilithium_pk_lthash_from(&dpk_binds) {
                Ok(n) if n > 0 => println!("[INFO][NODE] dilithium_pk_lthash_rebuilt_at_boot bindings={}", n),
                Ok(_) => {}
                Err(e) => println!("[WARN][NODE] dilithium_pk_lthash_rebuild_boot err={}", e),
            }
            // B: re-derive the light_elig_ recency index for the last few committed epochs so a restarted /
            // snapshot-joined node answers status recency identically until the next boundary refresh.
            {
                let e = boot_h / 14400;
                for d in 1..=3u64 {
                    let ep = match e.checked_sub(d) { Some(x) => x, None => break };
                    let _ = blockchain.storage.snapshot_light_eligible(ep, light_roster_cutoff(ep));
                }
            }
        }
        
        // v4.3: Restore P2P light node registry from blockchain storage (RocksDB)
        // CRITICAL: Without this, all in-memory registries are empty after restart.
        // Light nodes would be invisible for pinging until they re-register via mobile app.
        // This ensures data consistency: blockchain state = source of truth for "node exists".
        if let Some(ref p2p) = blockchain.unified_p2p {
            match blockchain.storage.load_all_node_registrations() {
                Ok(nodes) if !nodes.is_empty() => {
                    let restored = p2p.restore_light_nodes_from_storage(nodes);
                    println!("[INFO][NODE] p2p_registry_restored from_storage={}", restored);
                }
                Ok(_) => println!("[INFO][NODE] p2p_registry_restore no_nodes_in_storage"),
                Err(e) => println!("[WARN][NODE] p2p_registry_restore err={}", e),
            }

            // Restore FCM push types from local fcm_tokens CF so the ping service
            // delivers real push notifications immediately after a node restart.
            // (restore_light_nodes_from_storage defaults to Polling for privacy.)
            p2p.update_device_tokens_from_storage(&*blockchain.storage);

            // Rebuild the per-epoch light-eligibility map so a mid-epoch restart keeps this genesis
            // shard's attestations for the boundary bitmap TX (else those light nodes lose the reward).
            let boot_h = blockchain.storage.get_chain_height().unwrap_or(0);
            p2p.rebuild_light_eligible_from_storage(boot_h);
        }

        
        // ═══════════════════════════════════════════════════════════════════
        // L1 ARCHITECTURE: ConsensusCoordinator + BlockPipeline + SyncManager
        // Replaces monolithic process_received_blocks and ad-hoc sync
        // ═══════════════════════════════════════════════════════════════════

        // 1. Start ConsensusCoordinator — single state machine for all phases
        let initial_height = blockchain.storage.get_chain_height().unwrap_or(0);
        let (coordinator, coordinator_handle) = crate::consensus_state::ConsensusCoordinator::new(1024);
        // Set initial height from storage
        if initial_height > 0 {
            coordinator_handle.try_send(crate::consensus_state::ConsensusEvent::BlockApplied {
                height: initial_height,
                producer: "restored".to_string(),
                timestamp: get_timestamp_safe(),
            });
        }
        blockchain.coordinator_handle = Some(coordinator_handle.clone());
        *GLOBAL_COORDINATOR.write() = Some(coordinator_handle.clone());
        tokio::spawn(coordinator.run());
        if is_info() { println!("[INFO][COORD] started initial_height={}", initial_height); }

        // 2. Genesis loading via file-based config (no p2p deadlock possible)
        {
            let genesis_config = crate::genesis_config::GenesisConfig::from_env();
            match crate::genesis_config::load_genesis(&blockchain.storage, &genesis_config).await {
                crate::genesis_config::GenesisResult::Loaded { block, source } => {
                    if is_info() { println!("[INFO][GENESIS] loaded source={} txs={}", source, block.transactions.len()); }
                    // Apply genesis state (PK registrations, initial balances)
                    crate::genesis_config::apply_genesis_state(&block, &blockchain.state, &blockchain.storage).await;
                    coordinator_handle.try_send(crate::consensus_state::ConsensusEvent::GenesisLoaded {
                        timestamp: block.timestamp,
                    });
                    // Export genesis file for other nodes
                    let export_path = std::path::PathBuf::from("/app/data/genesis.bin");
                    let _ = crate::genesis_config::export_genesis(&blockchain.storage, &export_path).await;
                }
                crate::genesis_config::GenesisResult::NeedsCreation => {
                    if is_info() { println!("[INFO][GENESIS] node_001_creation_mode"); }
                    // Node 001 will create genesis in the production loop
                }
                crate::genesis_config::GenesisResult::HeaderOnly { timestamp } => {
                    // Timing is authoritative from the header; the coordinator must not sit in
                    // LoadingGenesis (is_syncing) for the whole uptime over expired tx rows.
                    crate::set_genesis_timestamp(timestamp);
                    coordinator_handle.try_send(crate::consensus_state::ConsensusEvent::GenesisLoaded { timestamp });
                    crate::genesis_config::spawn_genesis_restore(blockchain.storage.clone(), coordinator_handle.clone());
                }
                crate::genesis_config::GenesisResult::NotAvailable { tried } => {
                    eprintln!("[WARN][GENESIS] not_available tried={:?} — will wait for p2p sync", tried);
                    crate::genesis_config::spawn_genesis_restore(blockchain.storage.clone(), coordinator_handle.clone());
                    // Genesis will arrive via sync — not fatal
                }
            }
        }

        // 3. Start BlockPipeline with full apply context
        let pipeline_config = if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            crate::block_pipeline::PipelineConfig::genesis()
        } else {
            crate::block_pipeline::PipelineConfig::production()
        };

        let apply_ctx = crate::block_pipeline::ApplyContext {
            storage: blockchain.storage.clone(),
            state: blockchain.state.clone(),
            coordinator: coordinator_handle.clone(),
            height: blockchain.height.clone(),
            unified_p2p: blockchain.unified_p2p.clone(),
            block_event_tx: blockchain.block_event_tx.clone(),
            node_id: blockchain.node_id.clone(),
            // v14.9: Event-driven apply signal — sync manager waits on this
            // instead of sleep/poll, scaling cleanly to 10K+ Super nodes.
            apply_notify: Arc::new(tokio::sync::Notify::new()),
        };

        let pipeline_ingest = crate::block_pipeline::BlockPipeline::start(pipeline_config, apply_ctx);
        blockchain.pipeline_ingest = Some(pipeline_ingest.clone());
        init_global_pipeline_ingest(pipeline_ingest.clone());
        if is_info() { println!("[INFO][PIPELINE] started stages=3"); }

        // 4. Start SyncManager (wave-based block download)
        if let Some(ref p2p) = blockchain.unified_p2p {
            let sync_config = crate::sync_manager::SyncConfig::default();
            let (sync_manager, sync_handle) = crate::sync_manager::SyncManager::new(
                sync_config,
                blockchain.storage.clone(),
                p2p.clone(),
                pipeline_ingest.clone(),
                coordinator_handle.clone(),
                // SAME handle the apply pipeline uses (apply_ctx.state above) — cold-join
                // snapshot rehydrate must seed the in-mem state the pipeline reads.
                blockchain.state.clone(),
            );
            blockchain.sync_handle = Some(sync_handle.clone());
            tokio::spawn(sync_manager.run());
            if is_info() { println!("[INFO][SYNC] manager_started"); }
        }

        // 5. Pipeline ingest is routed via block_rx → pipeline legacy drain below
        //    P2P sends blocks via block_tx, which are drained into PipelineIngest

        // LEGACY: Keep old block_rx alive but drain it into pipeline
        // This handles any code that still uses the old block_tx channel.
        //
        // v14.10: Use `submit_async` (blocks until pipeline has room) instead of
        // `submit` (drops on full). The credit-based backpressure in SyncManager
        // guarantees in_flight ≤ MAX_INFLIGHT, so blocking here only happens
        // transiently under burst load. Dropping was catastrophic because a
        // dropped h=0 (genesis) would permanently deadlock the pipeline —
        // every subsequent block fails hash-chain verify with no way to recover.
        let pipeline_for_legacy = pipeline_ingest.clone();
        tokio::spawn(async move {
            while let Some(received_block) = block_rx.recv().await {
                let ingest = crate::block_pipeline::IngestBlock {
                    height: received_block.height,
                    data: received_block.data,
                    block_type: received_block.block_type,
                    from_peer: received_block.from_peer,
                    received_at: received_block.timestamp,
                };
                if !pipeline_for_legacy.submit_async(ingest).await {
                    // submit_async returns false only on channel-closed (shutdown).
                    if is_warn() {
                        println!("[WARN][PIPELINE] legacy_drain_closed — pipeline shut down");
                    }
                    break;
                }
            }
        });
        
        // MEV PROTECTION: Start periodic bundle cleanup task
        if let Some(ref mev_pool) = blockchain.mev_mempool {
            let mev_pool_for_cleanup = mev_pool.clone();
            tokio::spawn(async move {
                if is_info() { println!("[INFO][MEV] bundle_cleanup_task=started interval=30s"); }
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    
                    let current_time = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    
                    let removed = mev_pool_for_cleanup.cleanup_expired_bundles(current_time);
                    if removed > 0 {
                        if is_debug() { println!("[DBG][MEV] cleanup expired_bundles={}", removed); }
                    }
                }
            });
        }
        
        // PROTOCOL: Periodic cleanup of included_tx_hashes (prevents unbounded memory growth)
        {
            let mempool_for_included = blockchain.mempool.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(300)); // 5 min
                loop {
                    interval.tick().await;
                    mempool_for_included.cleanup_included_tx_hashes();
                }
            });
        }
        
        // PROTOCOL: Periodic cleanup of committed_epochs in state (keep last 3 epochs)
        {
            let state_for_cleanup = blockchain.state.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(600)); // 10 min
                let epoch_interval: u64 = 14400;
                loop {
                    interval.tick().await;
                    let state = state_for_cleanup.read().await;
                    let chain_state = state.chain_state.read();
                    let current_epoch = chain_state.height / epoch_interval;
                    drop(chain_state);
                    state.cleanup_committed_epochs(current_epoch);
                }
            });
        }
        
        // Register Genesis nodes in reward system and start processing
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
            
            
            // v2.95: Genesis nodes are ALREADY registered in block 0 via NodeRegistration TX
            // DO NOT create duplicate Activation TX - this was causing spurious TX on block ~61
            // Genesis registration is handled by genesis block creation, not runtime activation
            if is_info() { 
                println!("[INFO][REGISTRY] genesis_node_{} already registered in genesis block (no duplicate TX)", bootstrap_id); 
            }
            
            // Reward processing is handled by RPC system, not by individual nodes
            // This ensures centralized control of emission and distribution
            if bootstrap_id == "001" {
                if is_info() { println!("[INFO][REWARDS] ping_receiver=ready"); }
            }
        }
        
        // Start sync request handler AFTER blockchain is created
        // v5.6: Now receives from_peer_addr for routing to unregistered peers
        let blockchain_clone = blockchain.clone();
        tokio::spawn(async move {
            // Bounded-parallel serving: one multi-MB serve must not head-of-line
            // block every other peer's request behind it.
            const SYNC_SERVE_CONCURRENCY: usize = 4;
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(SYNC_SERVE_CONCURRENCY));
            while let Some((from_height, to_height, requester_id, from_peer_addr)) = sync_request_rx.recv().await {
                let permit = match permits.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let bc = blockchain_clone.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(e) = bc.handle_sync_request(from_height, to_height, requester_id, from_peer_addr).await {
                        eprintln!("[ERR][SYNC] handle_request_failed err={}", e);
                    }
                });
            }
        });
        
        // PRODUCTION v2.19.12: Start macroblock sync request handler
        let blockchain_for_macrosync = blockchain.clone();
        tokio::spawn(async move {
            while let Some((from_index, to_index, requester_id, from_addr)) = macroblock_sync_rx.recv().await {
                // Handle macroblock sync request
                if let Err(e) = blockchain_for_macrosync.handle_macroblock_sync_request(from_index, to_index, requester_id, from_addr).await {
                    eprintln!("[ERR][MB-SYNC] handle_request_failed err={}", e);
                }
            }
        });
        
        // PRODUCTION v2.19.12: Start macroblock receiver handler
        // v3.2: CRITICAL FIX - Clear pending sync on errors to prevent stuck entries
        // v14.8.2: Peer rotation when our node lacks the N-2 snapshot required
        // for strict canonical validation — see process_received_macroblock.
        let blockchain_for_macroblocks = blockchain.clone();
        tokio::spawn(async move {
            while let Some(received_macroblock) = macroblock_rx.recv().await {
                let index = received_macroblock.height;
                // v14.8.2: Capture peer identity BEFORE consuming the message so we
                // can cooldown the right sender if the sync gap is on our side.
                let from_peer_hint = received_macroblock.from_peer.clone();
                // Process received macroblock
                if let Err(e) = blockchain_for_macroblocks.process_received_macroblock(received_macroblock).await {
                    // v3.2: CRITICAL - Clear pending sync on error to allow re-request
                    crate::unified_p2p::clear_macroblock_pending_sync(index);

                    // v14.8.2: Detect the canonical "need_mb_prev:{X}" error emitted
                    // by process_received_macroblock when our disk is missing the
                    // N-2 snapshot required to validate the incoming macroblock.
                    //
                    // Two responses:
                    //   1. Cool down the PEER we just received from. Not because
                    //      they are malicious — they aren't; it's OUR sync gap —
                    //      but SYNC_PEER_COOLDOWN's selector will pick a different
                    //      peer for our follow-up sync request. That gives us
                    //      deterministic peer rotation without explicitly wiring
                    //      a ranked peer list through the call chain.
                    //   2. Request the missing macroblock N-2. sync_macroblocks_inner
                    //      honours SYNC_PEER_COOLDOWN, so step 1 is what routes us
                    //      to a different peer.
                    //
                    // When N-2 arrives, its own processing will populate the eligible
                    // snapshot; a future retry of the original macroblock (from any
                    // peer) will then pass the strict committee-size check.
                    let err_str = e.to_string();
                    // F6 fix (v34): recognise BOTH the legacy "need_mb_prev:{X}" error AND the v2
                    // Checkpoint-BFT defer "v2_qc_defer_anchor … need_mb_n2={X}". Both mean "we lack
                    // macroblock X needed to validate this one" → the SAME targeted N-2 backfill.
                    // Previously only the legacy prefix matched (and it is no longer produced), so a
                    // v2 anchor-miss fell through to a generic log and recovered only via coarse
                    // periodic retries — same class as the microblock-window repair, one layer up.
                    let missing_idx_opt: Option<u64> = err_str
                        .strip_prefix("Sync error: need_mb_prev:")
                        .or_else(|| err_str.strip_prefix("need_mb_prev:"))
                        .and_then(|s| s.split_whitespace().next())
                        .and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| {
                            // v2 form: pull the digits right after "need_mb_n2="
                            err_str.split("need_mb_n2=").nth(1).map(|s| {
                                s.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>()
                            }).filter(|s| !s.is_empty()).and_then(|s| s.parse::<u64>().ok())
                        })
                        .or_else(|| {
                            // "v2_qc_defer_anchor … need_pin={X}": lacking the GALC pin macroblock X to
                            // verify this one → same targeted backfill as N-2 (else only coarse retries).
                            err_str.split("need_pin=").nth(1).map(|s| {
                                s.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>()
                            }).filter(|s| !s.is_empty()).and_then(|s| s.parse::<u64>().ok())
                        })
                        .or_else(|| {
                            // "v2_rc_defer_anchor … need_anchor={X}": the relaxed-QC resolver lacks the
                            // span's anchor macroblock. Same targeted backfill; without it the node
                            // re-requests from the same peer and recovers only on coarse retries —
                            // during a halt, which is exactly what the span exists to shorten.
                            err_str.split("need_anchor=").nth(1).map(|s| {
                                s.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>()
                            }).filter(|s| !s.is_empty()).and_then(|s| s.parse::<u64>().ok())
                        });
                    if let Some(missing_idx) = missing_idx_opt {
                        if crate::node::is_warn() {
                            println!("[WARN][MB-SYNC] need_n_minus_2 mb={} missing_n2={} peer={} — cooling peer + requesting N-2 from rotation",
                                     index, missing_idx, from_peer_hint);
                        }
                        // Cool down the source peer so the next call picks a different one.
                        crate::unified_p2p::record_sync_peer_failure(&from_peer_hint);

                        // v32.15: batched range fetch on cold-sync. When the local macroblock store
                        // is empty (fresh node), single-step N-2 backtracking produces O(N)
                        // round-trips. Detect and fetch the whole prefix [0..missing_idx] in one go.
                        // Nudge the single sync coordinator to backfill the missing N-2 anchor; the
                        // macroblock retry passes the strict committee check once it lands.
                        crate::sync_manager::nudge_sync_check();
                        // Expected rotation flow, not a failure.
                        continue;
                    }
                    eprintln!("[ERR][MB-SYNC] process_failed idx={} err={}", index, e);
                }
            }
        });
        
        // Gossip-lane drain: the drain NEVER runs handler code. Every message goes to a
        // bounded spawn_blocking pool, so one wedged handler eats one worker — not the lane
        // (a single poisoned message once deadlocked this consumer fleet-wide). Bounded wait
        // then shed: gossip is re-gossiped/idempotent, and an exhausted pool must not turn
        // back into a blocked drain.
        let blockchain_for_quic = blockchain.clone();
        tokio::spawn(async move {
            const GOSSIP_POOL_WORKERS: usize = 8;
            const GOSSIP_POOL_WAIT_MS: u64 = 5_000;
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(GOSSIP_POOL_WORKERS));
            let mut last_shed_log = std::time::Instant::now();
            let mut last_shed: u64 = 0;
            while let Some((from_peer, message)) = quic_message_rx.recv().await {
                crate::node::GOSSIP_LANE_DRAINED_MS.store(
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default().as_millis() as u64,
                    std::sync::atomic::Ordering::Relaxed);
                if last_shed_log.elapsed().as_secs() >= 30 {
                    let s = crate::unified_p2p::GOSSIP_POOL_SHED
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if s > last_shed && is_warn() {
                        println!("[WARN][QUIC] gossip_pool_shed total={} delta={} window=30s reason=workers_busy",
                                 s, s - last_shed);
                    }
                    last_shed = s;
                    last_shed_log = std::time::Instant::now();
                }
                if let Some(ref p2p) = blockchain_for_quic.unified_p2p {
                    let permit = match tokio::time::timeout(
                        std::time::Duration::from_millis(GOSSIP_POOL_WAIT_MS),
                        permits.clone().acquire_owned()).await {
                        Ok(Ok(p)) => p,
                        _ => {
                            crate::unified_p2p::GOSSIP_POOL_SHED
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        }
                    };
                    let p2p_clone = p2p.clone();
                    tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        p2p_clone.handle_message(&from_peer, message);
                    });
                }
            }
        });

        // QoS bulk-lane worker — fully isolated from the consensus consumer.
        // Drains the bounded bulk channel; bounded-concurrency spawn_blocking
        // per message so heavy serve/decode never contends for consensus
        // cores. Lane drop counter is log-governed here (one summary / 30s)
        // so a flood does not spam logs. This task carries the entire
        // cold-sync serving cost; a flooding peer can saturate ONLY this
        // lane, never the chain.
        let blockchain_for_bulk = blockchain.clone();
        tokio::spawn(async move {
            const BULK_SERVE_CONCURRENCY: usize = 8;
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(BULK_SERVE_CONCURRENCY));
            let mut last_drop_log = std::time::Instant::now();
            let mut last_dropped: u64 = 0;
            while let Some((from_peer, message)) = quic_bulk_rx.recv().await {
                if last_drop_log.elapsed().as_secs() >= 30 {
                    let d = crate::unified_p2p::BULK_LANE_DROPPED
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if d > last_dropped && is_warn() {
                        println!("[WARN][QUIC] bulk_lane_shed total={} delta={} window=30s reason=lane_full_dos_bound",
                                 d, d - last_dropped);
                    }
                    last_dropped = d;
                    last_drop_log = std::time::Instant::now();
                }
                if let Some(ref p2p) = blockchain_for_bulk.unified_p2p {
                    let permit = match permits.clone().try_acquire_owned() {
                        Ok(p) => p,
                        Err(_) => {
                            // All serve slots busy → shed (bounded serving is
                            // the fairness guarantee; client re-requests).
                            crate::unified_p2p::BULK_LANE_DROPPED
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        }
                    };
                    let p2p_clone = p2p.clone();
                    tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        p2p_clone.handle_message(&from_peer, message);
                    });
                }
            }
        });

        // QoS finality drain — isolated from the gossip/bulk/consensus consumers. Carries only
        // non-redundant n−f frames, so a gossip/shred flood can no longer evict the votes that
        // assemble the finality QC (root-cause fix for the checkpoint wedge). ConsensusV2 dispatches
        // synchronously (route_inbound is µs-scale, byte-capped downstream); the crypto-heavy
        // Timeout*/Ready* types offload via spawn_blocking (keyed-idempotent, out-of-order safe).
        let blockchain_for_finality = blockchain.clone();
        tokio::spawn(async move {
            // Cap concurrent finality sig-verifies well below tokio's blocking pool so a
            // Timeout*/Ready* flood can never exhaust it and starve the block/shred apply path
            // (which shares that pool). acquire().await = backpressure (drain slows, the bounded
            // channel absorbs the burst / sheds at ingress); the drain itself NEVER drops a frame.
            const FINALITY_VERIFY_CONCURRENCY: usize = 48;
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(FINALITY_VERIFY_CONCURRENCY));
            let mut last_drop_log = std::time::Instant::now();
            let mut last_dropped: u64 = 0;
            while let Some((from_peer, message)) = quic_finality_rx.recv().await {
                if last_drop_log.elapsed().as_secs() >= 30 {
                    let d = crate::unified_p2p::FINALITY_LANE_DROPPED
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if d > last_dropped && is_warn() {
                        println!("[WARN][QUIC] finality_lane_shed total={} delta={} window=30s reason=lane_full_dos_bound",
                                 d, d - last_dropped);
                    }
                    last_dropped = d;
                    last_drop_log = std::time::Instant::now();
                }
                if let Some(ref p2p) = blockchain_for_finality.unified_p2p {
                    let needs_offload = matches!(&message,
                        crate::unified_p2p::NetworkMessage::TimeoutVote { .. }
                        | crate::unified_p2p::NetworkMessage::TimeoutCertificateBroadcast { .. }
                        | crate::unified_p2p::NetworkMessage::ProducerReady { .. }
                        | crate::unified_p2p::NetworkMessage::ReadyAck { .. }
                    );
                    if needs_offload {
                        // Backpressure on the bounded verify pool; released when the task completes.
                        let permit = match permits.clone().acquire_owned().await {
                            Ok(p) => p,
                            Err(_) => break, // semaphore closed → runtime shutting down
                        };
                        let p2p_clone = p2p.clone();
                        let from_peer_owned = from_peer.clone();
                        tokio::task::spawn_blocking(move || {
                            let _permit = permit;
                            p2p_clone.handle_message(&from_peer_owned, message);
                        });
                    } else {
                        p2p.handle_message(&from_peer, message);
                    }
                }
            }
        });

        // PRODUCTION v2.19.25: Start transaction receiver handler
        // Processes transactions received from P2P network and adds to mempool
        let blockchain_for_transactions = blockchain.clone();
        tokio::spawn(async move {
            // Generational seen-cache: two fixed sets, rotate whole generations O(1).
            // A hash is recorded at FIRST TOUCH regardless of validation outcome, so
            // a re-delivered echo never re-enters the pipeline (the old set recorded
            // only successes and cloned half of itself to shrink).
            const SEEN_GEN_CAP: usize = 200_000;
            let mut seen_cur: std::collections::HashSet<String> =
                std::collections::HashSet::with_capacity(SEEN_GEN_CAP);
            let mut seen_prev: std::collections::HashSet<String> =
                std::collections::HashSet::with_capacity(SEEN_GEN_CAP);
            
            // PRODUCTION v2.25.2: Batch accumulator for Ed25519 batch verification
            // Optimal: 1000 TX gives ~3x speedup from batch verify
            const BATCH_SIZE: usize = 1000;
            const BATCH_TIMEOUT_MS: u64 = 100; // Process batch every 100ms max (balance latency vs throughput)
            let mut tx_batch: Vec<(crate::unified_p2p::ReceivedTransaction, qnet_state::Transaction)> = 
                Vec::with_capacity(BATCH_SIZE);
            let mut last_batch_time = std::time::Instant::now();
            
            loop {
                // Try to receive with timeout for batch processing
                let received = tokio::time::timeout(
                    tokio::time::Duration::from_millis(BATCH_TIMEOUT_MS),
                    transaction_rx.recv()
                ).await;
                
                match received {
                    Ok(Some(received_tx)) => {
                // Seen at first touch: insert-or-skip before any work.
                if seen_cur.contains(&received_tx.tx_hash) || seen_prev.contains(&received_tx.tx_hash) {
                    continue;
                }
                if seen_cur.len() >= SEEN_GEN_CAP {
                    std::mem::swap(&mut seen_cur, &mut seen_prev);
                    seen_cur.clear();
                }
                seen_cur.insert(received_tx.tx_hash.clone());
                
                        // PRODUCTION v2.25: Deserialize transaction (bincode first, JSON fallback)
                        let tx_result: Result<qnet_state::Transaction, String> = 
                            bincode::deserialize::<qnet_state::Transaction>(&received_tx.tx_data)
                                .map_err(|e| e.to_string())
                                .or_else(|_| {
                                    serde_json::from_slice::<qnet_state::Transaction>(&received_tx.tx_data)
                                        .map_err(|e| e.to_string())
                                });
                        
                        match tx_result {
                            Ok(tx) => {
                                if is_debug() {
                                    println!("[DBG][TX-RECV] OK type={:?} sig={} from={}",
                                        std::mem::discriminant(&tx.tx_type),
                                        tx.signature.as_ref().map_or(0, |s| s.len()),
                                        received_tx.from_peer);
                                }
                            tx_batch.push((received_tx, tx));
                            }
                            Err(e) => {
                                if is_warn() {
                                    println!("[WARN][TX-RECV] deserialize_failed from={} err={}", 
                                        received_tx.from_peer, e);
                                }
                            }
                        }
                    }
                    Ok(None) => break, // Channel closed
                    Err(_) => {} // Timeout - process batch
                }
                
                // Process batch when full or timeout elapsed
                let should_process = tx_batch.len() >= BATCH_SIZE || 
                    (last_batch_time.elapsed().as_millis() as u64 >= BATCH_TIMEOUT_MS && !tx_batch.is_empty());
                
                if should_process {
                    // Authenticity is decided by validate_and_add_network_transaction below: the
                    // mandatory ML-DSA-65 verify for value classes plus the shared system-TX bind
                    // gate. No pre-filter here — a second, weaker gate can only drift from it.
                    let mut added = 0usize;
                    let mut rejected_val = 0usize;
                    for (received_tx, tx) in tx_batch.drain(..) {
                        // Full validation (nonce, balance, etc.) and add to mempool
                        match blockchain_for_transactions.validate_and_add_network_transaction(tx).await {
                            Ok(_hash) => { added += 1; }
                            Err(e) => {
                                rejected_val += 1;
                                // already_known is the echo fast-path, not a failure.
                                if is_debug() || (is_warn() && !e.to_string().contains("already_known")) {
                                    println!("[WARN][TX-SYNC] validation_failed hash={} err={}",
                                        &received_tx.tx_hash[..16], e);
                                }
                            }
                        }
                    }

                    if added > 0 || rejected_val > 0 {
                        if is_info() { println!("[INFO][TX-SYNC] batch_added count={} rejected_val={}", added, rejected_val); }
                    }

                    last_batch_time = std::time::Instant::now();
                }
            }
        });
        
        // ═══════════════════════════════════════════════════════════════════
        // L1 SYNC: Use SyncManager for initial sync (wave-based, adaptive)
        // Replaces ad-hoc sync chunk loop with production-grade sync manager
        // ═══════════════════════════════════════════════════════════════════
        if is_info() { println!("[INFO][SYNC] initial_sync_start"); }
        
        // Delegate sync to SyncManager (replaces 400+ lines of ad-hoc sync)
        let sync_handle_for_init = blockchain.sync_handle.clone();
        let coordinator_for_sync = coordinator_handle.clone();
        let storage_for_sync_check = blockchain.storage.clone();
        tokio::spawn(async move {
            // Wait for P2P connections to establish
            tokio::time::sleep(Duration::from_secs(3)).await;

            // Trigger initial sync via sync manager
            if let Some(ref sh) = sync_handle_for_init {
                sh.sync_to_network().await;
                // Wait for sync to complete (polls progress)
                let mut last_progress = 0u64;
                let mut stall_count = 0u32;
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if !sh.is_active() {
                        break;
                    }
                    let (progress, target) = sh.progress();
                    if progress == last_progress {
                        stall_count += 1;
                        if stall_count > 30 { // 60 seconds stall
                            if is_warn() { println!("[WARN][SYNC] stalled h={} target={}", progress, target); }
                            break;
                        }
                    } else {
                        stall_count = 0;
                        last_progress = progress;
                    }
                }
            }

            // Sync done — update flags. This loop can also exit on a 60s STALL below target, so gate
            // the Synchronized transition on the QC-verified frontier: a node must NOT declare synced
            // (and start producing/voting) below verified finality (the stale-low false-complete).
            // frontier==0 (h<90) ⇒ genesis bootstrap proceeds. Below the frontier: stay syncing —
            // sync_manager check_desync + the production-loop fast-sync keep driving and emit
            // SyncComplete (frontier-floored via detect_network_height) once the frontier is reached.
            let stored_h = storage_for_sync_check.get_chain_height().unwrap_or(0);
            let frontier = crate::node::qc_verified_frontier_height();
            if frontier == 0 || stored_h >= frontier {
                coordinator_for_sync.try_send(crate::consensus_state::ConsensusEvent::SyncComplete {
                    height: stored_h,
                });
                if is_info() { println!("[INFO][SYNC] initial_sync_complete h={}", stored_h); }
            } else if is_warn() {
                println!("[WARN][SYNC] initial_sync_below_frontier h={} frontier={} action=continue", stored_h, frontier);
            }
        });
        // ═══════════════════════════════════════════════════════════════════════════
        // NOTE: Legacy sync code (400+ lines) REMOVED — replaced by SyncManager.
        // See git history for the old ad-hoc sync logic.
        // ═══════════════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.31: Periodic macroblock integrity check
        // Runs every 60 seconds to ensure recent macroblocks are present
        // OPTIMIZED: Only checks last 10 macroblocks (O(1) vs O(n))
        // ═══════════════════════════════════════════════════════════════════════════
        let blockchain_for_macrocheck = blockchain.clone();
        tokio::spawn(async move {
            // Wait for initial sync to complete
            tokio::time::sleep(Duration::from_secs(30)).await;
            
            // Track last known good macroblock for efficient scanning
            let mut last_verified_macroblock: u64 = 0;
            
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                
                let current_height = *blockchain_for_macrocheck.height.read().await;
                if current_height < 90 {
                    continue; // No macroblocks expected yet
                }
                
                // A macroblock exists only for a QC-certified window, and production is allowed to run
                // up to the roster horizon past the seal - so a tip-derived expectation names objects
                // nobody ever created and re-reports them every pass for the whole horizon.
                let certified_mb = (crate::node::qc_verified_frontier_cached() / 90)
                    .max(blockchain_for_macrocheck.storage.last_sealed_mb_index());
                let expected_macroblocks = (current_height / 90).min(certified_mb);
                if expected_macroblocks == 0 { continue; }
                let storage = &blockchain_for_macrocheck.storage;
                
                // OPTIMIZATION: Only check last 10 macroblocks + any gaps since last verification
                // This makes the check O(1) instead of O(n) for high block counts
                // v2.66: Ensure check_from is always >= 1 (MacroBlock #0 doesn't exist)
                let check_from = if last_verified_macroblock > 0 {
                    // Check from last verified (to catch any gaps) but at least last 10
                    std::cmp::min(last_verified_macroblock, expected_macroblocks.saturating_sub(10)).max(1)
                } else {
                    // First run: check last 10 macroblocks
                    expected_macroblocks.saturating_sub(10).max(1)
                };
                
                let mut missing_macroblocks = Vec::new();
                
                for mb_index in check_from..=expected_macroblocks {
                    let has_macroblock = storage.get_macroblock_by_height(mb_index)
                        .map(|mb| mb.is_some())
                        .unwrap_or(false);
                    
                    if !has_macroblock {
                        missing_macroblocks.push(mb_index);
                    }
                }
                
                // Update last verified for next iteration
                if missing_macroblocks.is_empty() {
                    last_verified_macroblock = expected_macroblocks;
                }
                
                if !missing_macroblocks.is_empty() {
                    // Limit log output for large gaps
                    let display_missing: Vec<_> = missing_macroblocks.iter().take(10).collect();
                    let more_count = missing_macroblocks.len().saturating_sub(10);
                    
                    if more_count > 0 {
                        println!("[WARN][MB-CHECK] missing={} first_10={:?} more={}", 
                                 missing_macroblocks.len(), display_missing, more_count);
                    } else {
                        println!("[WARN][MB-CHECK] missing={} list={:?}", 
                                 missing_macroblocks.len(), display_missing);
                    }
                    
                    // v3.2: Request missing macroblocks from network
                    // CRITICAL FIX: Increased limit from 10 to 30 to recover faster from DESYNC
                    // Also clear pending queue for these indices to allow re-request
                    // Missing macroblocks detected → nudge the single sync coordinator; its bounded
                    // macroblock pass repairs the gap (honors below-frontier indices, deduped).
                    crate::sync_manager::nudge_sync_check();
                } else if current_height % 180 == 0 {
                    // Log health every 180 blocks (~3 minutes)
                    if is_info() { println!("[INFO][MB-CHECK] verified count={} range={}-{}", 
                             expected_macroblocks, check_from, expected_macroblocks); }
                }
            }
        });
        
        Ok(blockchain)
    }
    

    
    
    /// Start the blockchain node
    pub async fn start(&mut self) -> Result<(), QNetError> {
        println!("[INFO][NODE] starting");

        // Log only the runtimes actually on the hot path (broadcast + sigverify).
        let stats = crate::unified_p2p::get_runtime_stats();
        if is_info() {
            println!("[INFO][RUNTIME] cpus={} broadcast={}t sigverify={}t",
                     stats.cpu_count, stats.broadcast_threads, stats.sigverify_threads);
        }

        // ─────────────────────────────────────────────────────────────────
        // v16.1: INSTALL GENESIS PK ANCHORS BEFORE ANY P2P TRAFFIC
        // ─────────────────────────────────────────────────────────────────
        // Anchor map MUST be in place before:
        //   * The RPC server accepts incoming `VrfKeyAnnounce` / `NodeRegistration`
        //   * The P2P layer processes any `VrfLeaderClaim` (which auto-registers
        //     PKs in the consensus registry on first observation — see
        //     `unified_p2p.rs:12944, 13426`)
        //   * `initialize_wallet_identity` runs (which checks anchor for self)
        //
        // If the anchor file is missing this is an INFO log, not fatal: it is
        // the cold-boot path where the operator hasn't yet collected and
        // distributed PKs. After every node has run once (and produced its
        // own pk_hash via the [INFO][KEY] keypair_ready log), the operator
        // writes `genesis_anchors.json` and restarts the cluster — anchors
        // are then permanent for the lifetime of the network.
        //
        // v27 HOLE1: identity = binary-embedded GENESIS_CONSENSUS_PKS;
        // install unconditional + fail-closed (never returns 0). O(1).
        let anchors_installed = crate::genesis_constants::install_genesis_anchors_at_startup();
        if crate::node::is_info() {
            println!("[INFO][GENESIS] anchors_pinned count={} src=embedded", anchors_installed);
        }

        *self.is_running.write().await = true;
        
        // Start API server first to handle peer auth
        let should_start_api = !matches!(self.node_type, NodeType::Light);
        
        if should_start_api {
            // PRODUCTION: Start SINGLE unified server for both RPC and API (no port conflicts)
            // All nodes use standard port 8001
            let unified_port = std::env::var("QNET_API_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(8001); // EXISTING: All nodes use standard port 8001

            let node_clone_unified = self.clone();
            
            println!("[INFO][NODE] rpc_api_start port={} phase=before_p2p", unified_port);
            let rpc_handle = tokio::spawn(async move {
                crate::rpc::start_rpc_server(node_clone_unified, unified_port).await;
            });
            // Watchdog: if RPC server exits or panics → process::exit(1) → Docker restart
            // Same pattern as production_loop watchdog (Fix 5)
            tokio::spawn(async move {
                match rpc_handle.await {
                    Ok(_) => {
                        eprintln!("[CRIT][RPC] rpc_server port={} exited unexpectedly — restarting node", unified_port);
                        std::process::exit(1);
                    }
                    Err(e) => {
                        eprintln!("[CRIT][RPC] rpc_server port={} panicked: {:?} — restarting node", unified_port, e);
                        std::process::exit(1);
                    }
                }
            });
            
            // Wait for server readiness  
            println!("[INFO][NODE] waiting_for_server");
            // EXISTING: Use same wait time as Genesis coordination (8s for Genesis, 5s for regular)
            let api_wait_time = if std::env::var("QNET_BOOTSTRAP_ID").is_ok() { 8 } else { 5 };
            tokio::time::sleep(std::time::Duration::from_secs(api_wait_time)).await;
            
            // Health check to ensure API is ready
            let api_host = std::env::var("QNET_API_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
            let health_check_url = format!("http://{}:{}/api/v1/node/health", api_host, unified_port);
            println!("[INFO][NODE] api_health_check url={}", health_check_url);
            
            // Try health check with retries
            for attempt in 1..=API_HEALTH_CHECK_RETRIES {
                match reqwest::get(&health_check_url).await {
                    Ok(response) if response.status().is_success() => {
                        if is_info() { println!("[INFO][NODE] api_ok attempt={}", attempt); }
                        break;
                    }
                    _ => {
                        if attempt < API_HEALTH_CHECK_RETRIES {
                            println!("[INFO][NODE] api_not_ready retry_delay={}s attempt={}/{}", API_HEALTH_CHECK_DELAY_SECS, attempt, API_HEALTH_CHECK_RETRIES);
                            tokio::time::sleep(std::time::Duration::from_secs(API_HEALTH_CHECK_DELAY_SECS)).await;
                        } else {
                            println!("[WARN][NODE] API health check failed after {} attempts, continuing anyway", API_HEALTH_CHECK_RETRIES);
                        }
                    }
                }
            }
            
            // Store unified port for external access  
            std::env::set_var("QNET_CURRENT_RPC_PORT", unified_port.to_string());
            std::env::set_var("QNET_CURRENT_API_PORT", unified_port.to_string());
            
            println!("[INFO][NODE] api_ready port={}", unified_port);

            // API FIX: Set node start time for uptime calculation
            std::env::set_var("QNET_NODE_START_TIME", chrono::Utc::now().timestamp().to_string());

            // v14.8.5: STUCK-CHAIN WATCHDOG.
            // v15.15: ALERT-ONLY (no process::exit) — see detailed rationale
            //         at the alert site below.
            //
            // Original purpose: detect a stuck consensus engine on a single
            // peer. Original action was process::exit, relying on the
            // container supervisor to revive the runtime cleanly.
            //
            // Why we removed process::exit:
            //   On genesis cold-start the watchdog interpreted the legitimate
            //   bootstrap window (peer discovery + first-producer election +
            //   initial macroblock formation) as a fault and killed every node
            //   simultaneously. Each kill discarded in-progress consensus
            //   state (active commit-reveal round, partial commits, pending
            //   timeout votes). Containers were revived but consensus had to
            //   restart from zero every cycle — a deterministic permanent
            //   halt. The watchdog's "remedy" was the actual cause of the
            //   halt at scale.
            //
            //   Top-tier BFT chains never hard-kill the consensus process
            //   on a stuck-chain heuristic — they alert and let the existing
            //   sync / view-change machinery make progress while runtime
            //   state remains intact. We now follow that pattern.
            //
            // Current policy: every WATCHDOG_TICK_SECS, sample
            // LOCAL_BLOCKCHAIN_HEIGHT plus the cached network height. When
            // local height has not advanced by WATCHDOG_MIN_PROGRESS blocks
            // for WATCHDOG_STUCK_SECS AND the network is demonstrably ahead
            // of us (network_height ≥ our height + WATCHDOG_BEHIND_THRESHOLD),
            // emit a throttled [CRIT] alert. The alert is observability —
            // operator monitoring decides when manual intervention is
            // required. Consensus state is preserved.
            //
            // A healthy node that idles because the whole network is idle
            // (e.g. all peers offline) does NOT alert — network_height cache
            // won't show us behind. A healthy catching-up node advances at
            // hundreds of blocks/min and never trips this threshold.
            //
            // Scalability: two atomic loads per tick, negligible cost even
            // at tens of thousands of Super-nodes (this is a per-node task).
            // Alert log volume bounded by WATCHDOG_ALERT_REPEAT_SECS — at
            // 1000 nodes, max ~12 alerts/hour/node during sustained stall,
            // zero during normal operation.
            const WATCHDOG_TICK_SECS: u64 = 60;
            const WATCHDOG_STUCK_SECS: u64 = 300;       // 5 min
            const WATCHDOG_MIN_PROGRESS: u64 = 1;       // ≥ 1 block in 5 min = alive
            const WATCHDOG_BEHIND_THRESHOLD: u64 = 30;  // network must be ≥30 blocks ahead
            // v15.15: alert log throttle — emit one [CRIT] per WATCHDOG_STUCK_SECS
            // to avoid log-storm at 1000+ super-node scale (each runs its own
            // watchdog independently). Operators monitoring [CRIT][WATCHDOG]
            // see one alert per real stuck-window, not a flood per tick.
            const WATCHDOG_ALERT_REPEAT_SECS: u64 = WATCHDOG_STUCK_SECS;
            // A cluster-wide halt leaves every node at the SAME height, so the behind-the-network
            // test above can never fire — the 33-hour freeze at height 11 produced no alert and
            // could not have. Production is slot-driven (one microblock per second regardless of
            // load), so a frontier that does not move is a halt, not idle.
            const WATCHDOG_HALT_SECS: u64 = 300;
            tokio::spawn(async move {
                let mut last_progress_at = std::time::Instant::now();
                let mut last_height: u64 = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                    .load(std::sync::atomic::Ordering::Relaxed);
                let mut last_alert_at: Option<std::time::Instant> = None;
                let mut last_frontier: u64 = last_height;
                let mut last_frontier_at = std::time::Instant::now();
                let mut last_halt_alert_at: Option<std::time::Instant> = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(WATCHDOG_TICK_SECS)).await;

                    let h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                        .load(std::sync::atomic::Ordering::Relaxed);
                    // Canonical single source for the network view; also feeds the halt detector.
                    let (_, net_h, _) = crate::node::network_status();

                    // Frontier = the best height anyone is known to hold. Armed only after the chain
                    // has produced at least one block, so a cold start is never reported as a halt.
                    let frontier = h.max(net_h);
                    if frontier > last_frontier {
                        last_frontier = frontier;
                        last_frontier_at = std::time::Instant::now();
                        last_halt_alert_at = None;
                    } else if frontier > 0 {
                        let halted_for = last_frontier_at.elapsed().as_secs();
                        let due = last_halt_alert_at
                            .map_or(true, |t| t.elapsed().as_secs() >= WATCHDOG_ALERT_REPEAT_SECS);
                        if halted_for >= WATCHDOG_HALT_SECS && due {
                            last_halt_alert_at = Some(std::time::Instant::now());
                            println!(
                                "[CRIT][WATCHDOG] chain_halted frontier={} stuck={}s scope=network",
                                frontier, halted_for
                            );
                        }
                    }

                    if h.saturating_sub(last_height) >= WATCHDOG_MIN_PROGRESS {
                        last_height = h;
                        last_progress_at = std::time::Instant::now();
                        last_alert_at = None;  // chain advanced — clear alert state
                        continue;
                    }
                    let behind = net_h.saturating_sub(h);

                    if behind < WATCHDOG_BEHIND_THRESHOLD {
                        // Network is at our height (or we are ahead) — not a local lag. A genuine
                        // network-wide stop is reported by the frontier detector above.
                        last_progress_at = std::time::Instant::now();
                        last_alert_at = None;
                        continue;
                    }

                    let stuck_for = last_progress_at.elapsed().as_secs();
                    if stuck_for >= WATCHDOG_STUCK_SECS {
                        // No process::exit on chain_stuck. The old policy
                        // hard-killed via exit(2) every stuck-window; on
                        // genesis cold-start every node legitimately sits at
                        // h=0 past WATCHDOG_STUCK_SECS (peer discovery,
                        // handshake, NTP, committee election), so the watchdog
                        // killed the process, Docker restarted it, and in-
                        // memory consensus state was lost every cycle →
                        // deterministic permanent halt (no node survived to
                        // gather n−f for the first macroblock). Instead: a
                        // throttled [CRIT] alert (one per window) + stuck-timer
                        // reset; the pipeline/sync coordinator drives catch-up.
                        // Observability, not forced restart.
                        let should_alert = last_alert_at
                            .map(|t| t.elapsed().as_secs() >= WATCHDOG_ALERT_REPEAT_SECS)
                            .unwrap_or(true);

                        if should_alert {
                            eprintln!(
                                "[CRIT][WATCHDOG] chain_stuck h={} net_h={} behind={} stuck_for={}s threshold={}s — alert_only_no_kill (operator action may be required)",
                                h, net_h, behind, stuck_for, WATCHDOG_STUCK_SECS
                            );
                            last_alert_at = Some(std::time::Instant::now());
                        }

                        // Reset the stuck-timer so we do not re-evaluate the
                        // same stuck-window every WATCHDOG_TICK_SECS. The
                        // height-progress check at the top of the loop will
                        // re-arm the timer on real progress.
                        last_progress_at = std::time::Instant::now();
                    } else if crate::node::is_warn() {
                        println!(
                            "[WARN][WATCHDOG] no_progress h={} net_h={} behind={} stuck_for={}s (alert at {}s)",
                            h, net_h, behind, stuck_for, WATCHDOG_STUCK_SECS
                        );
                    }
                }
            });
        }
        
        // NOW connect to bootstrap peers AFTER API is ready
        if let Some(unified_p2p) = &self.unified_p2p {
            println!("[INFO][P2P] connections_start phase=post_api");
            // Bootstrap peers configured (logging removed for performance)

            // Unconditional: these must run whether or not the node has configured bootstrap peers.
            unified_p2p.start_required_background_tasks();
            unified_p2p.connect_to_bootstrap_peers(&self.bootstrap_peers);
            
            // Initial blockchain sync
            println!("[INFO][SYNC] waiting_for_peers_and_sync");
            
            // EXISTING: Bootstrap peer connections without initial sync delay
            // Sync will happen later after API servers are ready
        }
        
        // SYNC: Check if we need to sync with network after restart
        if let Err(e) = self.start_sync_if_needed().await {
            println!("[WARN][SYNC] Sync check failed: {}", e);
            // Continue anyway - sync can be retried later
        }
        
        // CONSENSUS: Recover consensus state if needed
        if let Err(e) = self.recover_consensus_state().await {
            println!("[WARN][CONS] Consensus recovery failed: {}", e);
            // Continue anyway - consensus will start fresh
        }
        
        // PRODUCTION: Start microblock production ONLY for nodes that can produce blocks
        // Light nodes should NOT enter the production loop - they only sync
        if !matches!(self.node_type, NodeType::Light) {
            // ========================================================================
            // NETWORK STARTUP SYNCHRONIZATION (v2.19.13)
            // ========================================================================
            // ALL producer nodes (Super only — v3.18: "Full" tier removed) must:
            // 1. Wait for minimum peers for Byzantine consensus (4 nodes)
            // 2. Ensure Genesis block exists before starting production
            // 3. Use REAL TCP connectivity checks, not deterministic lists
            //
            // This applies to:
            // - Bootstrap nodes (genesis_node_001-005) on first start
            // - Regular Super nodes joining the network
            // - Nodes restarting after crash
            // ========================================================================
            
            let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
            let local_height = self.storage.get_chain_height().unwrap_or(0);
            
            println!("[INFO][NODE] network_sync_start local_h={}", local_height);

            // ════════════════════════════════════════════════════════════════════════
            // v6.5 FIX: HTTP genesis block download for non-bootstrap nodes
            // PROBLEM: New nodes joining existing network deadlock in readiness loop
            //   because sync_blocks(0,0) via QUIC fails (genesis not stored as microblock).
            // SOLUTION: Download genesis block via HTTP REST API from any genesis node
            //   BEFORE entering the readiness loop. Standard L1 bootnode pattern.
            // ════════════════════════════════════════════════════════════════════════
            // v11.1: ALL nodes (including bootstrap) download genesis via HTTP when resyncing
            if local_height == 0 {
                let has_genesis_already = self.storage.load_microblock(0)
                    .map(|opt| opt.is_some())
                    .unwrap_or(false);

                if !has_genesis_already {
                    println!("[INFO][GEN] http_download_start source=genesis_nodes");
                    // Through load_genesis: it collects every fixed source and requires them to
                    // agree. Taking the first responder here would let one of them pin this node's
                    // write-once identity behind the vote's back.
                    let cfg = crate::genesis_config::GenesisConfig::from_env();
                    let genesis_downloaded = matches!(
                        crate::genesis_config::load_genesis(&self.storage, &cfg).await,
                        crate::genesis_config::GenesisResult::Loaded { .. }
                    );
                    if genesis_downloaded {
                        if let Ok(Ok(Some(g))) = tokio::task::spawn_blocking({
                            let s = self.storage.clone();
                            move || s.load_microblock_auto_format(0)
                        }).await {
                            {
                                let state_guard = self.state.write().await;
                                let _ = state_guard.apply_block_batch(&g.transactions);
                            }
                            crate::genesis_config::adopt_genesis_metadata(&g, &self.storage);
                            println!("[INFO][GEN] http_genesis_ready txs={}", g.transactions.len());
                        }
                    }

                    // Fallback: Try to get genesis via QUIC sync if HTTP failed
                    if !genesis_downloaded {
                        println!("[WARN][GEN] http_download_failed fallback=p2p_sync");
                    }
                }
            }

            // CRITICAL FIX: Register in global registry BEFORE waiting for peers
            // This allows other nodes to discover us via gossip during their sync
            if let Some(ref p2p) = self.unified_p2p {
                if !matches!(self.node_type, NodeType::Light) {
                    println!("[INFO][ACTIVE] early_registration phase=pre_sync");
                    p2p.register_as_active_node_async().await;
                }
            }
            
            if let Some(ref p2p) = self.unified_p2p {
                let mut wait_time = 0u64;
                const MAX_WAIT_SECS: u64 = 120; // 2 minutes max wait
                // Committee size at genesis (3f+1, f=1). The PEER floor is one less: quorum is
                // quorum_size(5)=4 NODES, i.e. this node plus 3 peers. Using the committee size as a
                // peer count demands the whole network and turns an f=1-tolerant set into all-or-nothing.
                const MIN_PEERS_FOR_CONSENSUS: usize = 4; // Byzantine: 3f+1 where f=1
                const MIN_PEERS_FOR_QUORUM: usize = MIN_PEERS_FOR_CONSENSUS - 1;
                
                loop {
                    // STEP 1: Check REAL peer connectivity (TCP check, not config list)
                    // CRITICAL: For Genesis nodes, we need EXACTLY 4 other peers (all 5 nodes connected)
                    let real_peer_count = p2p.get_peer_count(); // Actual connected peers (not including self)
                    
                    // For Genesis nodes: verify we have connections to all 4 other Genesis nodes
                    let genesis_peers_connected = if is_bootstrap_node {
                        p2p.verify_all_genesis_connectivity().await
                    } else {
                        true // Non-Genesis nodes don't need this check
                    };
                    
                    // STEP 2: Check Genesis block exists
                    // v3.21 FIX: Use lightweight check - just verify data exists, don't deserialize
                    // load_microblock returns raw bytes without heavy reconstruction (~1ms vs ~70-100ms)
                    let has_genesis = self.storage.load_microblock(0)
                        .map(|opt| opt.is_some())
                        .unwrap_or(false);
                    
                    // STEP 3: Determine if ready to start
                    // CRITICAL FIX: Genesis nodes MUST have exactly 4 peers (all other Genesis nodes)
                    // This prevents network split where nodes start with partial connectivity
                    let has_enough_peers = if is_bootstrap_node {
                        // Genesis nodes: MUST have 4 peers (all other Genesis nodes connected)
                        real_peer_count >= 4 && genesis_peers_connected
                    } else {
                        // Regular nodes: Need at least 3 peers for Byzantine consensus
                        real_peer_count >= MIN_PEERS_FOR_CONSENSUS - 1 // -1 because we don't count self
                    };
                    
                    let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
                    let is_genesis_creator = bootstrap_id == "001";
                    
                    // CRITICAL: Track when ALL peers connected for stabilization timing
                    // stabilization_time counts from when peers connected, NOT from startup
                    static PEERS_CONNECTED: std::sync::atomic::AtomicBool = 
                        std::sync::atomic::AtomicBool::new(false);
                    static STABILIZATION_START: std::sync::atomic::AtomicU64 = 
                        std::sync::atomic::AtomicU64::new(0);
                    
                    // CRITICAL: Mark when peers first connected (for stabilization timing)
                    // This should happen when has_enough_peers is true, BEFORE checking Genesis
                    if has_enough_peers && !PEERS_CONNECTED.load(std::sync::atomic::Ordering::Relaxed) {
                        PEERS_CONNECTED.store(true, std::sync::atomic::Ordering::Relaxed);
                        STABILIZATION_START.store(wait_time, std::sync::atomic::Ordering::Relaxed);
                        if is_info() { println!("[INFO][NODE] peers={} at={}s stabilizing", real_peer_count, wait_time); }
                    }
                    
                    // Calculate stabilization time from when peers connected
                    let stabilization_start = STABILIZATION_START.load(std::sync::atomic::Ordering::Relaxed);
                    let stabilization_time = if PEERS_CONNECTED.load(std::sync::atomic::Ordering::Relaxed) {
                        wait_time.saturating_sub(stabilization_start)
                    } else {
                        0 // Peers not connected yet
                    };
                    
                    // CRITICAL: ALL nodes (except 001) MUST have Genesis block before starting
                    // Node 001 creates Genesis, all others must receive it
                    let ready_to_start = has_enough_peers && (has_genesis || is_genesis_creator);
                    
                    if ready_to_start {
                        
                        if !has_genesis {
                            if is_genesis_creator {
                                // Node 001: Will create Genesis block after this loop
                                // Stabilization margin before 001 mints genesis so peers' block-receive
                                // paths are ready for the broadcast. The peer API (8001) has listened since
                                // boot — well before this timer starts (QUIC-connected to all 4) — so 30s is
                                // ample; a peer that still misses the broadcast fetches via the (now
                                // garbage-rejecting) HTTP path. Was 60 — halved to cut fresh-boot time.
                                const NETWORK_STABILIZATION_SECS: u64 = 30;
                                if stabilization_time < NETWORK_STABILIZATION_SECS {
                                    let remaining = NETWORK_STABILIZATION_SECS - stabilization_time;
                                    println!("[INFO][NODE] node_001_stabilizing peers={} remaining={}s",
                                             real_peer_count, remaining);
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    wait_time += 5;
                                    continue;
                                }
                                
                                println!("[INFO][NODE] node_001_stable peers={} stable={}s", real_peer_count, stabilization_time);
                                println!("[INFO][NODE] production_start genesis=pending");
                                break;
                            } else {
                                // Nodes 002-005 and regular nodes: MUST wait for Genesis
                                println!("[INFO][NODE] waiting_for_genesis peers={}", real_peer_count);
                                
                                // CRITICAL: Actively request Genesis from network
                                if let Err(e) = p2p.sync_blocks(0, 0).await {
                                    println!("[WARN][NODE] Failed to request Genesis: {}", e);
                                }
                                
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                wait_time += 5;
                                
                                // CRITICAL FIX v2.19.18: Genesis nodes (002-005) MUST wait INDEFINITELY for Genesis block
                                // Previous code would break after timeout, allowing nodes to start without Genesis
                                // This caused Node 005 to produce block #1 instead of waiting for Genesis from Node 001
                                if is_bootstrap_node {
                                    // Genesis nodes: NEVER start without Genesis block - reset timer and keep waiting
                                    if wait_time >= MAX_WAIT_SECS {
                                        println!("[WARN][NODE] Genesis node {} still waiting for Genesis block after {}s...", 
                                                 bootstrap_id, wait_time);
                                        println!("[INFO][NODE] timer_reset reason=genesis_required");
                                        wait_time = 0; // Reset timer - keep waiting indefinitely
                                    }
                                    continue;
                                } else {
                                    // Regular nodes: Can timeout (they join existing network)
                                    if wait_time < MAX_WAIT_SECS {
                                        continue;
                                    } else {
                                        println!("[ERR][NODE] CRITICAL: Timeout waiting for Genesis block!");
                                        println!("[ERR][NODE] Cannot start production without Genesis!");
                                        
                                        // STATE MACHINE: Genesis timeout error
                                        set_node_state(NodeState::Error {
                                            reason: "Timeout waiting for Genesis block".to_string(),
                                            recoverable: false,
                                        });
                                        
                                        // Regular nodes can fail - they're joining existing network
                                        break;
                                    }
                                }
                            }
                        } else {
                            // Genesis exists - ready to start!
                            // CRITICAL v2.19.20: Wait for network stabilization before production
                            // This ensures all peer APIs are fully ready to receive blocks
                            const NETWORK_STABILIZATION_SECS: u64 = 60;
                            if is_bootstrap_node && stabilization_time < NETWORK_STABILIZATION_SECS {
                                let remaining = NETWORK_STABILIZATION_SECS - stabilization_time;
                                if is_info() { println!("[INFO][NODE] net_ready peers={} genesis=yes", real_peer_count); }
                                println!("[INFO][NODE] stabilization_wait remaining={}s stabilized={}s", remaining, stabilization_time);
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                wait_time += 5;
                                continue;
                            }

                            // v32.11+v32.12: joiner deterministic stagger. Each
                            // joiner's wait = sha3(node_id)[0] mod RANGE + BASE,
                            // distributing N simultaneous starts across [BASE,
                            // BASE+RANGE] window. Prevents synchronized burst
                            // of activation TX broadcasts (1000 joiners at t+10s)
                            // that fixed-delay ramp-up would not solve.
                            const JOINER_RAMP_UP_BASE_SECS: u64 = 5;
                            const JOINER_RAMP_UP_RANGE_SECS: u64 = 30;
                            if !is_bootstrap_node {
                                use sha3::{Sha3_256, Digest};
                                let mut h = Sha3_256::new();
                                h.update(self.node_id.as_bytes());
                                let stagger_bytes = h.finalize();
                                let stagger = JOINER_RAMP_UP_BASE_SECS
                                    + ((u64::from_le_bytes(
                                        stagger_bytes[..8].try_into().unwrap_or([0u8; 8])
                                    )) % JOINER_RAMP_UP_RANGE_SECS);
                                if stabilization_time < stagger {
                                    let remaining = stagger - stabilization_time;
                                    if is_info() {
                                        println!(
                                            "[INFO][NODE] joiner_ramp_up remaining={}s stagger={}s peers={}",
                                            remaining, stagger, real_peer_count,
                                        );
                                    }
                                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                    wait_time += 2;
                                    continue;
                                }
                            }

                            // ══════════════════════════════════════════════════════════════
                            // v6.5 FIX: Early activation for non-bootstrap nodes
                            // v9.7: DEFERRED until sync completes — unsynced nodes MUST NOT
                            //   register as validators. NodeRegistration TX before sync →
                            //   VRF selects node as producer → node at h=100 can't produce
                            //   block at h=5220 → 5-second timeout → network stalls.
                            //
                            // NEW FLOW: Genesis downloaded → Sync → Sync complete →
                            //   Activate → NodeRegistration TX → VRF eligible
                            //
                            // The activation TX is now sent from the sync completion handler
                            // (see v9.7 sync re-check block) and from the periodic registration
                            // loop ONLY when NODE_IS_SYNCHRONIZED == true.
                            // ══════════════════════════════════════════════════════════════
                            // Registration ownership: the spawned convergence driver arms/re-arms the
                            // NodeRegistration behind its fail-closed frontier gate and re-collects when
                            // attest_epoch goes stale. This removes the old coordinator_is_synchronized
                            // sync-gate-on-production for UNREGISTERED joiners — safe because selection
                            // is srtr_-only (an unregistered node is never VRF-selected). Here: one-time
                            // LOCAL activation persist (sync-independent) + driver spawn.
                            if !is_bootstrap_node && self.node_type != NodeType::Light {
                                let activation_code = std::env::var("QNET_ACTIVATION_CODE").unwrap_or_default();
                                if !activation_code.is_empty()
                                    && !self.get_storage().is_node_registration_onchain(&self.get_node_id())
                                {
                                    let already_persisted = self.get_storage().load_activation_code()
                                        .map(|o| o.is_some()).unwrap_or(false);
                                    if !already_persisted {
                                        if let Err(e) = self.save_activation_code(&activation_code, self.node_type).await {
                                            // Local validation failed (bad mnemonic/burn env) — a config error
                                            // the driver cannot heal; retry here so the operator sees it.
                                            println!("[WARN][ACTIVATION] activation_persist_failed err={} — retry", e);
                                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                            wait_time += 5;
                                            continue;
                                        }
                                    }
                                    self.spawn_registration_convergence_driver(activation_code);
                                }
                            }

                            if is_info() { println!("[INFO][NODE] net_ready peers={} stable={}s", real_peer_count, stabilization_time); }
                            println!("[INFO][NODE] production_start");

                            // STATE MACHINE: Ready to produce
                            set_node_state(NodeState::Idle { last_height: 0 });

                            break;
                        }
                    }
                    
                    // Log progress
                    if is_bootstrap_node {
                        println!("[INFO][NODE] genesis_node_wait peers={} need=4 all_connected={} genesis={} elapsed={}s",
                                 real_peer_count, genesis_peers_connected,
                                 if has_genesis { "yes" } else { "no" }, wait_time);
                    } else {
                        println!("[INFO][NODE] peer_wait peers={} need={} genesis={} elapsed={}s",
                                 real_peer_count, MIN_PEERS_FOR_CONSENSUS - 1,
                                 if has_genesis { "yes" } else { "no" }, wait_time);
                    }
                    
                    // CRITICAL FIX: Actively try to connect to Genesis peers during wait
                    // This fixes race condition where all nodes start simultaneously
                    if is_bootstrap_node {
                        use crate::unified_p2p::get_genesis_bootstrap_ips;
                        let genesis_ips = get_genesis_bootstrap_ips();
                        let genesis_peers: Vec<String> = genesis_ips.iter()
                            .map(|ip| format!("{}:8001", ip))
                            .collect();

                        println!("[INFO][NODE] connecting_genesis_peers");
                        p2p.add_discovered_peers(&genesis_peers);

                        // Also re-register to propagate our presence
                        p2p.register_as_active_node_async().await;
                    }

                    // v5.6 FIX: Non-bootstrap nodes joining existing network MUST request genesis
                    // Without this, new super nodes deadlock: ready_to_start requires has_genesis,
                    // but genesis request was only inside the ready_to_start block
                    if !is_bootstrap_node && !has_genesis && has_enough_peers {
                        if is_info() { println!("[INFO][NODE] requesting_genesis peers={} wait={}s", real_peer_count, wait_time); }
                        if let Err(e) = p2p.sync_blocks(0, 0).await {
                            if is_warn() { println!("[WARN][NODE] genesis_request_fail err={}", e); }
                        }
                    }
                    
                    // Wait and retry
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    wait_time += 5;
                    
                    // Timeout check
                    if wait_time >= MAX_WAIT_SECS {
                        // CRITICAL FIX: For Genesis nodes, NEVER start without minimum peers
                        // This prevents network split where each node produces its own chain
                        // Against the QUORUM floor, not the committee size. At the committee size this
                        // reset the timer forever with 4 of 5 genesis nodes up - and everything after this
                        // loop (the BFT runtime, production, the halt monitor, the SIGTERM handler) is
                        // downstream of start() returning, so one absent node halted four healthy ones.
                        if is_bootstrap_node && real_peer_count < MIN_PEERS_FOR_QUORUM {
                            println!("[ERR][NODE] CRITICAL: Genesis node timeout with {} peers, quorum needs {}!",
                                     real_peer_count, MIN_PEERS_FOR_QUORUM);
                            println!("[ERR][NODE] Cannot start production - network would split!");
                            println!("[INFO][NODE] extending_wait reason=genesis_nodes_must_connect");
                            
                            // STATE MACHINE: Genesis node waiting for peers
                            set_node_state(NodeState::Error {
                                reason: format!("Genesis node needs {} peers, only have {}", MIN_PEERS_FOR_QUORUM, real_peer_count),
                                recoverable: true,
                            });
                            
                            // Reset wait time and continue trying
                            wait_time = 0;
                            continue;
                        }
                        
                        println!("[WARN][NODE] Timeout after {}s, proceeding with {} peers", 
                                wait_time, real_peer_count);
                        break;
                    }
                }
            } else {
                // No P2P - fallback wait
                println!("[WARN][NODE] No P2P available, waiting 30s for network...");
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
            
            if is_info() { println!("[INFO][NODE] net_sync_ok"); }
            
            // STEP 4: a restarting node with local data may be behind. Delegate catch-up to the SINGLE
            // sync coordinator (SyncManager) — nudge it to run a desync check now. The production HARD
            // GATE below (sync_active || !prod_unlocked || !node_synced) holds production until it has
            // caught up, so no inline pre-production fetch loop is needed here (that duplicated
            // execute_sync's pipelined catch-up and raced it for the same blocks).
            if local_height > 0 {
                crate::sync_manager::nudge_sync_check();
                if is_info() { println!("[INFO][NODE] boot_sync_delegated local={}", local_height); }
            }
            
        // Consensus v2: start the always-on Checkpoint-BFT runtime at BOOT (not at the
        // first window) so the inbound channel is live before any proposal — removes the
        // startup drop that stalled checkpoint 1. Committee starts empty; each window's
        // signal supplies the epoch (N-2) committee before that index is driven.
        if crate::consensus_v2_node::v2_enabled() {
            if let (Some(p2p), Some(rx)) = (self.unified_p2p.clone(), crate::consensus_v2_node::init_runtime()) {
                tokio::spawn(crate::consensus_v2_node::run(
                    self.node_id.clone(), Vec::new(), [0u8; 32], p2p, self.storage.clone(), rx,
                ));
                if is_info() { println!("[INFO][BFT2] runtime_boot node={}", self.node_id); }
            }
        }

        if is_info() { println!("[INFO][NODE] microblock_production_start interval=1s"); }
        self.start_microblock_production().await;
        } else {
            println!("[INFO][NODE] Light node: Sync-only mode (no block production)");
            // Light nodes will sync through P2P received blocks
        }
        
        // PRODUCTION: Start archive compliance enforcement (mandatory for Super nodes)
        // v3.18: Super node type removed
        if matches!(self.node_type, NodeType::Super) {
            println!("[INFO][ARCHIVE] compliance_monitoring_start");
            self.start_archive_compliance_monitoring().await;
            
            // Check network capacity and rebalance for small networks
            self.check_and_rebalance_small_network().await;
        }
        
        // PRODUCTION: Start storage monitoring for all nodes
        println!("[INFO][STORAGE] starting_monitoring");
        self.start_storage_monitoring().await;
        
        // v3.0: Start memory monitoring to detect leaks before OOM
        self.start_memory_monitoring().await;
        
        // CONSENSUS: Messages processed directly in macroblock phases (no separate handler needed)
        
        // PRODUCTION: All nodes participate in P2P network and microblock production
        // Byzantine consensus participation is determined dynamically during macroblock rounds
        if let Some(_unified_p2p) = &self.unified_p2p {
            println!("[INFO][NODE] Node ready for P2P networking and microblock production");
            println!("[INFO][NODE] Byzantine consensus will activate during macroblock rounds only");
        }
        
        // MOVED: API initialization moved to beginning of start() method
        // to ensure it's ready before P2P connections begin
        
        // API DEADLOCK FIX: Don't call sync_blockchain_height() here!
        // Background thread will handle synchronization (started in unified_p2p)
            if let Some(unified_p2p) = &self.unified_p2p {
            // Check if we have cached height (no blocking)
            if let Some(network_height) = unified_p2p.get_cached_network_height() {
                        let current_height = *self.height.read().await;
                if is_debug() { println!("[DBG][SYNC] h={} net_h={}", current_height, network_height); }
                
                if network_height > current_height && network_height > 0 {
                    println!("[INFO][SYNC] need_download blocks={}", network_height - current_height);
                        } else {
                    if is_info() { println!("[INFO][SYNC] synced_from_cache"); }
                        }
            } else {
                println!("[INFO][SYNC] no_cached_height background_sync_pending");
                    }
                }
        
        if self.node_type == NodeType::Light {
            // Light nodes: Use unified server too (for consistency)
            let node_clone_light = self.clone();
            let light_port = self.p2p_port; // Use node's p2p_port
            
            tokio::spawn(async move {
                crate::rpc::start_rpc_server(node_clone_light, light_port).await;
            });
            
            std::env::set_var("QNET_CURRENT_RPC_PORT", light_port.to_string());
            
            println!("[INFO][NODE] Unified server: port {} (Light node)", light_port);
            println!("[INFO][NODE] Light node: Mobile-optimized endpoints");
        }
        
        if is_info() { println!("[INFO][NODE] bringup_complete"); }

        // Bring-up is complete; process lifetime belongs to the caller. start() must RETURN —
        // blocking here made everything after it in main() dead code: the SIGTERM/SIGINT handler
        // (no storage flush on `docker stop`), the halt-height stop and post-API peer injection.
        crate::boot_contract::require(crate::boot_contract::names::DEVICE_MIGRATION_MONITOR);
        self.start_device_migration_monitor();

        // Grace exceeds the slowest required task's own start delay (peer cleanup: 60 s).
        crate::boot_contract::spawn_audit(Duration::from_secs(120));
        Ok(())
    }

    /// Operator-node device-migration watch. Genesis short-circuits inside the check.
    pub(super) fn start_device_migration_monitor(&self) {
        let node = self.clone();
        let is_running = self.is_running.clone();
        tokio::spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::DEVICE_MIGRATION_MONITOR);
            while *is_running.read().await {
                tokio::time::sleep(Duration::from_secs(30)).await;
                match node.check_device_deactivation().await {
                    Ok(true) => {
                        if let Err(e) = node.graceful_shutdown_due_to_migration().await {
                            println!("[ERR][MIGRATION] shutdown_failed err={}", e);
                        }
                        break;
                    }
                    Ok(false) => {}
                    Err(e) => println!("[WARN][MIGRATION] check_failed err={}", e),
                }
            }
        });
    }
    
    
    /// Two independent tasks run in parallel:
    /// - Task 1: per-subwindow Heartbeat emission (spread by per-node offset; v35)
    /// - Task 2: BitmapTX (Light-node eligibility bitmap, genesis-only, epoch-end window)
    pub(super) async fn start_commitment_tx_loop(&self) {
        // ═══════════════════════════════════════════════════════════════════════════
        // Task 1: Heartbeat emission loop (spread, unforgeable; tallied in heartbeat_slots)
        // ═══════════════════════════════════════════════════════════════════════════
        {
        let storage = self.storage.clone();
        let height = self.height.clone();
        let unified_p2p = self.unified_p2p.clone();
        let mempool = self.mempool.clone();
        let node_id = self.node_id.clone();
        let node_type = self.node_type.clone();
        let is_running = self.is_running.clone();
        // The node's own consensus identity: the heartbeat signature must come from the SAME key the
        // chain committed for this node_id, and the seed it derives from differs between operator nodes
        // (QNET_WALLET_SEED) and genesis nodes (QNET_GENESIS_SEED).
        let hb_identity = self.wallet_identity.clone();

        tokio::spawn(async move {
            const EMISSION_BLOCK_INTERVAL: u64 = 14400;

            if is_info() {
                println!("[INFO][HEARTBEAT-LOOP] heartbeat emission loop started (spread, unforgeable)");
            }

            // v36: (epoch, subwindow, emit_height) of this node's last Heartbeat emission. Dedup keys on
            // ON-CHAIN INCLUSION (own heartbeat_slots bit), not emission — a heartbeat that missed
            // inclusion is re-anchored and retried until the subwindow is recorded, so a transient
            // desync can never permanently drop a liveness subwindow (producer/reward eligibility).
            let mut last_hb_emit: Option<(u64, u64, u64)> = None;
            // Re-anchor cadence: well under HB_ANCHOR_MAX_LAG (90) so a retried heartbeat never goes stale.
            const HB_REEMIT_INTERVAL: u64 = 60;

            while *is_running.read().await {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;

                let current_height = *height.read().await;

                // v34: emit ONE unforgeable Heartbeat TX per ~1440-block subwindow (10/epoch) for
                // super/genesis nodes. Anchored to a recent block hash so it cannot be pre-signed or
                // backfilled. NOTE: that anchor check runs PRODUCER-SIDE ONLY (the block-build filter
                // below); receivers do not re-verify it. Liveness is tallied on-chain
                // in Account.heartbeat_slots (popcount ≥ 9). Skip while syncing: a heartbeat anchored
                // to our lagging height would be stale at the tip and the producer would reject it.
                if !matches!(node_type, NodeType::Light) && current_height >= 2 && !coordinator_is_syncing() {
                    // Derive epoch/subwindow from the ANCHOR (current_height-2) the heartbeat commits and
                    // the apply tallies, so the inclusion check tests exactly the bit the emit will set.
                    let anchor_h = current_height - 2;
                    let hb_epoch = anchor_h / EMISSION_BLOCK_INTERVAL;
                    let pos = anchor_h % EMISSION_BLOCK_INTERVAL;
                    let hb_subwindow = pos / 1440;
                    // Emit at a per-node offset inside the subwindow (not its boundary) so 100k+ nodes
                    // spread (~70/block) instead of bursting in one block.
                    let hb_offset = Self::heartbeat_offset(&node_id, hb_subwindow);
                    if (pos % 1440) >= hb_offset {
                        // Done once our own heartbeat for this subwindow is recorded on-chain.
                        let included = storage.load_account(&node_id).ok().flatten()
                            .map(|a| a.heartbeat_epoch == hb_epoch
                                  && (a.heartbeat_slots & (1u16 << hb_subwindow.min(9))) != 0)
                            .unwrap_or(false);
                        let first = !matches!(last_hb_emit, Some((e, s, _)) if e == hb_epoch && s == hb_subwindow);
                        let reanchor = matches!(last_hb_emit, Some((_, _, h)) if current_height.saturating_sub(h) >= HB_REEMIT_INTERVAL);
                        if !included && (first || reanchor) {
                            if let Some(hb_tx) = Self::create_heartbeat_tx_static(&storage, &node_id, current_height, hb_identity.as_deref()).await {
                                if let Ok(hb_bytes) = bincode::serialize(&hb_tx) {
                                    let hb_gp = hb_tx.gas_price;
                                    if mempool.add_binary_transaction(hb_bytes.clone(), hb_tx.hash.clone(), hb_gp) {
                                        if let Some(ref p2p) = unified_p2p {
                                            let _ = p2p.broadcast_transaction(hb_bytes);
                                        }
                                        last_hb_emit = Some((hb_epoch, hb_subwindow, current_height));
                                        if is_info() {
                                            println!("[INFO][HEARTBEAT] emitted node={} epoch={} subwindow={} at_h={}",
                                                     node_id, hb_epoch, hb_subwindow, current_height);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

            }
        });
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // Task 2: BitmapTX Loop (heavyweight, independent parallel pipeline)
        // Fresh height re-read + 3-block Gulf Stream forwarding
        // ═══════════════════════════════════════════════════════════════════════════
        {
        let storage = self.storage.clone();
        let height = self.height.clone();
        let unified_p2p = self.unified_p2p.clone();
        let mempool = self.mempool.clone();
        let node_id = self.node_id.clone();
        let node_type = self.node_type.clone();
        let bitmap_tracker = self.bitmap_commitment_tracker.clone();
        let is_running = self.is_running.clone();
        
        tokio::spawn(async move {
            const EMISSION_BLOCK_INTERVAL: u64 = 14400;
            const COMMITMENT_WINDOW_START: u64 = 50;
            const RETRY_AFTER_BLOCKS: u64 = 10;
            const MAX_RETRIES: u8 = 3;
            
            if is_info() {
                println!("[INFO][BITMAP-LOOP] BitmapTX loop started (independent task, parallel pipeline)");
            }
            
            while *is_running.read().await {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                
                let current_height = *height.read().await;
                let blocks_until_epoch_end = EMISSION_BLOCK_INTERVAL - (current_height % EMISSION_BLOCK_INTERVAL);
                let should_create_commitments = blocks_until_epoch_end <= COMMITMENT_WINDOW_START && blocks_until_epoch_end > 0;
                
                if !should_create_commitments {
                    continue;
                }
                
                let current_epoch = current_height / EMISSION_BLOCK_INTERVAL;
                
                if is_info() {
                    println!("[INFO][BITMAP-LOOP] Commitment window height={} epoch={} blocks_until_end={}", 
                             current_height, current_epoch, blocks_until_epoch_end);
                }

                // v8.0: LightNodeEligibilityBitmap TX (parallel pipeline)
                {
                    let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
                        .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
                        .unwrap_or(false);
                    
                    if !is_genesis_node {
                        if is_debug() {
                            println!("[DBG][LIGHT-BITMAP] Skipping - not a Genesis node");
                        }
                    } else {
                        // v7.0: Full confirmation + retry tracking (same as HeartbeatCommitment)
                        let should_send = if let Some(status) = bitmap_tracker.get(&current_epoch) {
                            if status.is_confirmed() {
                                // Skip-markers carry a sentinel tx_hash (no real TX emitted) — don't log as a confirmed TX.
                                if status.tx_hash.starts_with("no_") {
                                    if is_debug() {
                                        println!("[DBG][LIGHT-BITMAP] epoch={} skipped (no eligible light in shard) — no TX emitted", current_epoch);
                                    }
                                } else if is_info() {
                                    println!("[INFO][LIGHT-BITMAP] confirmed epoch={} block={} hash={}",
                                             current_epoch, status.confirmed_at_height.unwrap_or(0),
                                             &status.tx_hash[..status.tx_hash.len().min(16)]);
                                }
                                false
                            } else {
                                let blocks_since_sent = current_height.saturating_sub(status.sent_at_height);
                                if blocks_since_sent >= RETRY_AFTER_BLOCKS && status.retry_count < MAX_RETRIES {
                                    println!("[WARN][LIGHT-BITMAP] TX not confirmed after {} blocks, retry #{} epoch={}",
                                             blocks_since_sent, status.retry_count + 1, current_epoch);
                                    true
                                } else if status.retry_count >= MAX_RETRIES {
                                    println!("[ERR][LIGHT-BITMAP] Max retries ({}) reached epoch={}", MAX_RETRIES, current_epoch);
                                    false
                                } else {
                                    false
                                }
                            }
                        } else {
                            true
                        };

                        if !should_send {
                            // Skip — already confirmed or waiting
                        } else {
                            if is_info() {
                                println!("[INFO][LIGHT-BITMAP] Creating bitmap TX for epoch={}", current_epoch);
                            }
                            
                            if let Some(ref p2p) = unified_p2p {
                                // Get attestations for this epoch
                                // Uncapped per-epoch attested set (union of received + gossiped pings);
                                // not the 100k-capped attestation map, so the bitmap reflects all responders.
                                let attested_light_ids = p2p.get_light_eligible_for_epoch(current_epoch);

                                // Use ALL attestations for the epoch regardless of which genesis
                                // node received the FCM response. The light node device sends its
                                // signed reply to whichever genesis endpoint it reaches first
                                // (FCM → Google → device → any genesis HTTP). Eligibility is
                                // determined by shard membership below, not by pinger_id.
                                // pinger_id filter is kept only in PingCommitmentWithSampling
                                // (Merkle proof of "I personally pinged these nodes").

                                // Get total assigned Light nodes for this Genesis
                                // Genesis nodes divide Light nodes: each gets 1/5 of registry
                                let genesis_idx = std::env::var("QNET_BOOTSTRAP_ID")
                                    .ok()
                                    .and_then(|id| id.parse::<u32>().ok())
                                    .map(|id| id.saturating_sub(1))
                                    .unwrap_or(0);
                                
                                // Deterministic pre-epoch roster streamed ONCE (not materialized): one pass
                                // yields the full roster size and, for THIS genesis's hash-shard, the local
                                // index count + attested local indices. bit i in shard g = the i-th sorted-roster
                                // node with light_shard_of()==g — the IDENTICAL enumeration every reader (emission
                                // recompute, snapshot_light_eligible) uses ⇒ byte-identical committed bitmap.
                                // O(1) memory at 10M nodes (no O(roster) Vec) on this once-per-epoch genesis path.
                                let attested_set: std::collections::HashSet<&str> =
                                    attested_light_ids.iter().map(|s| s.as_str()).collect();
                                let mut total_light_nodes: u32 = 0;
                                let mut shard_members: u32 = 0;
                                // The bitmap is sized to the reg_index SPAN it must address, not to a
                                // member count: bit i is node reg_index i, so a member with a high
                                // index needs the array to reach it.
                                let mut index_span: u32 = 0;
                                let mut eligible_indices: Vec<u32> = Vec::new();
                                if let Some(s) = crate::node::try_get_storage() {
                                    let _ = s.light_roster_for_each(light_roster_cutoff(current_epoch), |id, _w, reg_index| {
                                        total_light_nodes += 1;
                                        if light_shard_of(id) == genesis_idx as usize {
                                            shard_members += 1;
                                            index_span = index_span.max(reg_index.saturating_add(1));
                                            if attested_set.contains(id) { eligible_indices.push(reg_index); }
                                        }
                                    });
                                }

                                // v2.95: Skip if no Light nodes registered (genesis rests when nothing to ping).
                                if total_light_nodes == 0 {
                                    let mut status = HeartbeatCommitmentStatus::new("no_light_nodes".to_string(), current_height);
                                    status.mark_confirmed(current_height);
                                    bitmap_tracker.insert(current_epoch, status);
                                    if is_debug() {
                                        println!("[DBG][LIGHT-BITMAP] No Light nodes registered - skipping epoch={}", current_epoch);
                                    }
                                } else {

                                if shard_members == 0 {
                                    let mut status = HeartbeatCommitmentStatus::new("no_assigned_nodes".to_string(), current_height);
                                    status.mark_confirmed(current_height);
                                    bitmap_tracker.insert(current_epoch, status);
                                    if is_info() {
                                        println!("[INFO][LIGHT-BITMAP] Genesis {} shard empty (total={}) - skip",
                                                 genesis_idx + 1, total_light_nodes);
                                    }
                                } else {

                                if is_info() {
                                    println!("[INFO][LIGHT-BITMAP] Genesis {} hash-shard → {} eligible / {} assigned Light nodes",
                                             genesis_idx + 1, eligible_indices.len(), shard_members);
                                }
                                
                                // Create bitmap TX
                                match Self::create_light_node_bitmap_tx(
                                    &node_id,
                                    current_epoch,
                                    &eligible_indices,
                                    index_span,
                                ) {
                                    Ok(mut tx) => {
                                        // Pure ML-DSA-65: sign the SINGLE canonical message the verifier uses
                                        // (Self::build_canonical_verify_message) so the bitmap content
                                        // (genesis_id/epoch/counts/bitmap) is bound, not just the header —
                                        // closes the unsigned-field forgery (P1). The former ephemeral Ed25519
                                        // leg proved no identity and is quantum-breakable — removed.
                                        let canonical_msg = Self::build_canonical_verify_message(&tx);

                                        // ML-DSA-65 signature (quantum-resistant, linked to node identity)
                                        if let Some(crypto) = try_get_quantum_crypto() {
                                            match crypto.create_consensus_signature(&node_id, &canonical_msg).await {
                                                Ok(dilithium_sig) => {
                                                    tx.dilithium_signature = Some(dilithium_sig.signature.into_bytes());
                                                    tx.dilithium_public_key = Some(node_id.clone().into_bytes());
                                                }
                                                Err(e) => {
                                                    if is_warn() {
                                                        println!("[WARN][LIGHT-BITMAP] Dilithium signing failed: {}", e);
                                                    }
                                                }
                                            }
                                        }

                                        tx.hash = tx.calculate_hash();

                                        if is_info() {
                                            let has_dil = tx.dilithium_signature.is_some();
                                            println!("[INFO][LIGHT-BITMAP] TX created hash={} sig=Dilithium3({})",
                                                     &tx.hash[..16], has_dil);
                                        }
                                        
                                        match bincode::serialize(&tx) {
                                            Ok(tx_bytes) => {
                                                let gas_price = tx.gas_price;
                                                let tx_bytes_for_broadcast = tx_bytes.clone();

                                                if is_info() {
                                                    println!("[INFO][LIGHT-BITMAP] TX size={} bytes", tx_bytes.len());
                                                }

                                                // v15.5: RETRY MEMPOOL CLEANUP — see HeartbeatCommitment site
                                                // for full rationale. Same pattern, same scalability profile,
                                                // same fix: drop stale retry attempts from the local mempool
                                                // before adding the new one so the next producer cannot pull
                                                // multiple versions of the same logical commitment into one
                                                // block.
                                                let stale_hashes: Vec<String> = bitmap_tracker
                                                    .get(&current_epoch)
                                                    .map(|e| e.all_tx_hashes.clone())
                                                    .unwrap_or_default();
                                                if !stale_hashes.is_empty() {
                                                    mempool.batch_remove_transactions(&stale_hashes);
                                                    if is_info() {
                                                        println!("[INFO][LIGHT-BITMAP] mempool_cleanup epoch={} removed={} (pre-retry)",
                                                                 current_epoch, stale_hashes.len());
                                                    }
                                                }

                                                if mempool.add_binary_transaction(tx_bytes, tx.hash.clone(), gas_price) {
                                                    let tx_hash_clone = tx.hash.clone();
                                                    if let Some(mut existing) = bitmap_tracker.get_mut(&current_epoch) {
                                                        existing.increment_retry();
                                                        existing.value_mut().sent_at_height = current_height;
                                                        existing.value_mut().tx_hash = tx_hash_clone.clone();
                                                        existing.value_mut().all_tx_hashes.push(tx_hash_clone.clone());
                                                        println!("[INFO][LIGHT-BITMAP] TX retry #{} submitted epoch={} hash={} total_hashes={}",
                                                                 existing.retry_count, current_epoch, &tx_hash_clone[..16], existing.all_tx_hashes.len());
                                                    } else {
                                                        bitmap_tracker.insert(
                                                            current_epoch,
                                                            HeartbeatCommitmentStatus::new(tx_hash_clone.clone(), current_height)
                                                        );
                                                        if is_info() {
                                                            println!("[INFO][LIGHT-BITMAP] TX submitted to mempool epoch={} hash={}",
                                                                     current_epoch, &tx_hash_clone[..16]);
                                                        }
                                                    }
                                                    
                                                    // v8.0: Fresh height re-read + 3-block Gulf Stream forwarding
                                                    // Re-read height AFTER heavy TX creation to target correct producer
                                                    let fresh_height = *height.read().await;
                                                    let mut forwarded_to_producer = false;
                                                    let mut sent_to: Vec<String> = Vec::new();

                                                    // 3-block landing zone: forward to producers of H+1, H+2, H+3
                                                    let target_heights = [fresh_height + 1, fresh_height + 2, fresh_height + 3];
                                                    
                                                    if is_info() {
                                                        println!("[INFO][GULF-STREAM] BitmapTX 3-block forwarding: fresh_h={} targets={:?}",
                                                                 fresh_height, target_heights);
                                                    }

                                                    for &target_h in &target_heights {
                                                        let producer = Self::select_microblock_producer(
                                                            target_h,
                                                            &unified_p2p,
                                                            &node_id,
                                                            node_type.clone(),
                                                            Some(&storage),
                                                        ).await;

                                                        if producer.is_empty() || producer == node_id || sent_to.contains(&producer) {
                                                            if producer == node_id && !sent_to.contains(&producer) {
                                                                if is_info() {
                                                                    println!("[INFO][GULF-STREAM] BitmapTX h={} - WE are the producer", target_h);
                                                                }
                                                            }
                                                            continue;
                                                        }

                                                        if let Some(producer_addr) = p2p.get_peer_addr_by_id(&producer) {
                                                            let tx_msg = NetworkMessage::Transaction { 
                                                                data: tx_bytes_for_broadcast.clone() 
                                                            };
                                                            match p2p.send_critical_tx_with_ack(&producer_addr, tx_msg).await {
                                                                Ok(()) => {
                                                                    forwarded_to_producer = true;
                                                                    sent_to.push(producer.clone());
                                                                    if is_info() {
                                                                        println!("[INFO][GULF-STREAM] BitmapTX ACK_CONFIRMED h={} producer={}", target_h, producer);
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    println!("[WARN][GULF-STREAM] BitmapTX ACK_FAILED h={} producer={} error={}", target_h, producer, e);
                                                                }
                                                            }
                                                        } else {
                                                            println!("[WARN][GULF-STREAM] BitmapTX producer_addr_not_found h={} producer={}", target_h, producer);
                                                        }
                                                    }

                                                    if is_info() && forwarded_to_producer {
                                                        println!("[INFO][LIGHT-BITMAP] TX forwarded to producers={:?} fresh_h={}", sent_to, fresh_height);
                                                    }

                                                    // Backup gossip (reliability - if producer fails or network issues)
                                                    if let Err(e) = p2p.broadcast_transaction(tx_bytes_for_broadcast) {
                                                        if is_warn() {
                                                            println!("[WARN][LIGHT-BITMAP] Broadcast failed epoch={} error={}", current_epoch, e);
                                                        }
                                                    } else {
                                                        if is_info() {
                                                            println!("[INFO][LIGHT-BITMAP] TX broadcast to network epoch={} hash={} direct_fwd={}",
                                                                     current_epoch, &tx_hash_clone[..16], forwarded_to_producer);
                                                        }
                                                    }
                                                } else {
                                                    if is_warn() {
                                                        println!("[WARN][LIGHT-BITMAP] Mempool rejected TX");
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                if is_warn() {
                                                    println!("[WARN][LIGHT-BITMAP] Serialize failed: {}", e);
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        if is_warn() {
                                            println!("[WARN][LIGHT-BITMAP] Create TX failed: {:?}", e);
                                        }
                                    }
                                }
                                } // Close else block for index_span > 0 (shard has nodes)
                                } // Close else block for total_light_nodes > 0
                            }
                        }
                    }
                    
                    // v7.0: CONFIRMATION CHECK — scan recent blocks for our BitmapTX
                    {
                        let pending_epochs: Vec<u64> = bitmap_tracker.iter()
                            .filter(|entry| !entry.value().is_confirmed())
                            .map(|entry| *entry.key())
                            .collect();

                        for epoch in pending_epochs {
                            if let Some(mut status) = bitmap_tracker.get_mut(&epoch) {
                                let scan_start = status.sent_at_height;
                                let scan_end = current_height.min(scan_start + 20);

                                for check_height in scan_start..=scan_end {
                                    if let Ok(Some(block_data)) = storage.load_microblock_auto_format(check_height) {
                                        for tx in &block_data.transactions {
                                            if let qnet_state::TransactionType::LightNodeEligibilityBitmap { genesis_id, .. } = &tx.tx_type {
                                                if genesis_id == &node_id && status.all_tx_hashes.contains(&tx.hash) {
                                                    status.mark_confirmed(check_height);
                                                    println!("[INFO][LIGHT-BITMAP] TX CONFIRMED epoch={} block={} hash={}",
                                                             epoch, check_height, &tx.hash[..16]);
                                                    break;
                                                }
                                            }
                                        }
                                        if status.is_confirmed() { break; }
                                    }
                                }
                            }
                        }

                        // Cleanup old epochs (keep last 10)
                        if current_epoch > 10 {
                            let min_epoch = current_epoch.saturating_sub(10);
                            let before_len = bitmap_tracker.len();
                            bitmap_tracker.retain(|epoch, _| *epoch >= min_epoch);
                            let removed = before_len.saturating_sub(bitmap_tracker.len());
                            if removed > 0 && is_info() {
                                println!("[INFO][LIGHT-BITMAP] cleanup removed={} epochs min_epoch={}", removed, min_epoch);
                            }
                        }
                    }
                }
            }
        });
        }
    }
    
}

//! Smart-contract WASM execution for the apply path (P3).
//!
//! `WASM_VM_ENABLED` is a COMPILE-TIME const (never an env var — a per-node env gate on
//! a consensus path would be a fork vector; a compile-time constant guarantees every node
//! runs identical consensus rules). ENABLED for the from-genesis launch: third parties can
//! deploy + call WASM contracts. This is a from-genesis consensus commitment — flipping it
//! requires a fresh genesis, and MUST be validated by a live multi-node equivalence run
//! (every node's state_root matches at every height; fuzzed traps revert identically; call
//! trees converge) before real value is at stake. Execution is deterministic by construction
//! (wasmi interpreter, fuel-metered, float/thread/simd-free per the deploy-time validator;
//! sorted BTreeMap storage). Compute is METERED: the sender pays the flat intrinsic PLUS
//! `fuel_consumed * effective_gas_price` — a SYMMETRIC account move (the gas refund drops and the
//! producer credit rises by the same amount, so QNC conservation holds), on top of the per-block
//! `BLOCK_FUEL_LIMIT` that bounds worst-case compute (anti-DoS). Applies at heights >=
//! GAS_METERING_ACTIVATION_HEIGHT; below it the flat gas_limit charge already covers reserved fuel.
//!
//! CROSS-CONTRACT MODEL (EIP-2930-style access list): a wasm ContractCall runs a
//! `qnet_vm::execute_call_tree` over a SNAPSHOT resolver built from the pre-loaded
//! working set. `apply_to_state` sees only the accounts `get_all_affected_addresses`
//! pre-loads, so the SIGNED tx DECLARES every contract it may reach (`accessList`) —
//! those addresses join the working set, so every node resolves the SAME contract set
//! and any call to an undeclared/absent contract fails deterministically
//! (`CALL_ERR_NOT_CONTRACT`). Per-contract write deltas + logs come back and the caller
//! commits them ONLY on a non-trap tree (call-level atomicity; a trap consumes the fee +
//! advances the nonce, commits nothing — anti-DoS + anti-replay hold). Cross-contract
//! reentrancy is forbidden and call depth is bounded inside the VM (`qnet_vm`).

use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use crate::account::Account;

/// P3 activation gate — ENABLED for the from-genesis contract launch. Wrapped in a fn so
/// the apply branches are not const-folded into dead-code lints. Same compile-time value on
/// every node ⇒ identical consensus rules (no per-node divergence). A change requires a
/// fresh genesis + a live multi-node state_root equivalence run.
const WASM_VM_ENABLED: bool = true;
#[inline]
pub fn wasm_vm_enabled() -> bool { WASM_VM_ENABLED }

/// Max contracts a single wasm call may declare in its access list (bounds the extra
/// pre-load work `get_all_affected_addresses` does; a call past the declared set fails
/// deterministically). Frozen as a consensus constant before activation.
pub const MAX_WASM_ACCESS_LIST: usize = 64;

/// Reserved contract_storage metadata keys — NOT part of the WASM data set, so they are
/// excluded from a contract's storage snapshot and never treated as key/value bytes.
/// (Collision-free by construction: VM keys are stored hex-encoded, and none of these
/// words are valid lowercase hex, so a hex-encoded data key can never equal one.)
const RESERVED_KEYS: &[&str] = &["type", "deployer", "code", "deployed_at"];

/// Decode a WASM contract's on-chain `String->String` storage into the byte map the VM
/// reads, skipping reserved metadata + any non-hex entry. Deterministic (BTreeMap).
pub fn base_from_storage(storage: &HashMap<String, String>) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let mut base = BTreeMap::new();
    for (k, v) in storage {
        if RESERVED_KEYS.contains(&k.as_str()) { continue; }
        if let (Ok(kb), Ok(vb)) = (hex::decode(k), hex::decode(v)) {
            base.insert(kb, vb);
        }
    }
    base
}

/// Fuel budget for a read-only RPC view call. Generous (views are off-consensus, never
/// hashed, and the RPC layer rate-limits them) yet still bounds a pathological contract.
pub const VIEW_CALL_FUEL: u64 = 50_000_000;

/// Read-only VIEW execution for RPC endpoints — OFF the consensus path (never hashed, no
/// persisted state change). Runs `method()` of a single WASM contract against its CURRENT
/// on-chain storage in a throwaway in-memory host and returns the entry's i64 result (the
/// WASM ABI's return channel). For byte/string data a contract exposes it via storage —
/// read that with `view_storage_get`. Errors on missing code / trap / no return value.
/// Determinism is irrelevant here (the result never enters a hash), but the same
/// deterministic VM (fuel-metered wasmi) is used regardless.
pub fn view_call(
    contract_addr: &str,
    account: &Account,
    method: &str,
    caller: &str,
    block_height: u64,
) -> Result<i64, String> {
    let code_hex = account.contract_storage.get("code")
        .ok_or_else(|| "contract has no wasm code (not a generic contract)".to_string())?;
    let code = hex::decode(code_hex).map_err(|_| "contract code is not valid hex".to_string())?;
    let mut host = qnet_vm::MemHost::new(
        caller.as_bytes().to_vec(),
        contract_addr.as_bytes().to_vec(),
        0,
        block_height,
    );
    for (k, v) in base_from_storage(&account.contract_storage) {
        host.seed(&k, &v);
    }
    let (outcome, _host) = qnet_vm::dry_run(&code, method, host, VIEW_CALL_FUEL)
        .map_err(|e| format!("vm error: {:?}", e))?;
    if outcome.trapped {
        return Err(format!("view '{}' reverted/trapped", method));
    }
    outcome.result.ok_or_else(|| format!("view '{}' returned no value", method))
}

/// Raw read of one contract-storage slot (the `getStorageAt` analogue) for RPC views.
/// `key` is the RAW (un-hex) key bytes the contract used with `storage_write`; returns the
/// raw value bytes, or None if absent. Reserved metadata keys (type/code/…) are stored
/// un-hex and are intentionally NOT reachable through this raw path.
pub fn view_storage_get(account: &Account, key: &[u8]) -> Option<Vec<u8>> {
    account.contract_storage.get(&hex::encode(key)).and_then(|v| hex::decode(v).ok())
}

// ── Off-consensus WASM event-log sink (RPC receipt store) ──────────────────────────────
// Contract `emit_log`s are captured here during a block's SEQUENTIAL tx apply
// (apply_block_to_state applies TXs one-by-one — no rayon/threads), then drained + persisted
// by the caller into a side CF for RPC `getLogs`. This is NOT consensus state: it is never
// hashed and never affects state_root — a node with logs disabled/missing still computes the
// identical state. Entry = (tx_hash, contract_addr_hex, raw_log_bytes) in emit order.
thread_local! {
    static WASM_LOG_SINK: std::cell::RefCell<Vec<(String, String, Vec<u8>)>> =
        std::cell::RefCell::new(Vec::new());
}

/// Append one emitted log (called from the ContractCall apply arm on a committed, non-trapped tree).
pub fn push_wasm_log(tx_hash: &str, contract_hex: &str, data: Vec<u8>) {
    WASM_LOG_SINK.with(|s| s.borrow_mut().push((tx_hash.to_string(), contract_hex.to_string(), data)));
}
/// Drain + return the current block's captured logs (emit order preserved). Caller persists them.
pub fn drain_wasm_logs() -> Vec<(String, String, Vec<u8>)> {
    WASM_LOG_SINK.with(|s| std::mem::take(&mut *s.borrow_mut()))
}
/// Clear the sink (call at the START of each block apply so a prior block's logs never leak).
pub fn clear_wasm_logs() {
    WASM_LOG_SINK.with(|s| s.borrow_mut().clear());
}

// Fuel the LAST-applied WASM ContractCall burned, published by the apply arm and read ONCE by the
// apply caller immediately after each tx (same thread, before the next tx / any await) to price the
// metered compute fee. Single slot (TXs apply sequentially); `take` resets it to 0 so a non-WASM tx
// reads 0. Off-consensus by itself — it only feeds the fee move (sender refund ↓ / producer credit ↑),
// which lands in state_root deterministically because wasmi fuel is an identical instruction count.
thread_local! {
    static LAST_TX_WASM_FUEL: std::cell::Cell<u64> = std::cell::Cell::new(0);
}
/// Record the fuel the just-executed WASM ContractCall burned (called from the apply arm — even on a
/// trap, since consumed work is still billed).
pub fn set_last_tx_wasm_fuel(fuel: u64) {
    LAST_TX_WASM_FUEL.with(|c| c.set(fuel));
}
/// Take (read + reset to 0) the fuel of the just-applied tx. MUST be called by the apply caller once
/// per tx, on the same thread, right after apply — so the next (possibly non-WASM) tx reads 0.
pub fn take_last_tx_wasm_fuel() -> u64 {
    LAST_TX_WASM_FUEL.with(|c| c.replace(0))
}

/// Canonical merkle leaf for one persisted log entry: `sha3(contract_hex || 0x00 || data)`.
/// Deterministic + collision-resistant across (contract, data) pairs — used both for the RPC
/// receipt view and (gated) the consensus logs_root over a window's ordered log list.
pub fn log_leaf(contract_hex: &str, data: &[u8]) -> Vec<u8> {
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(contract_hex.as_bytes());
    h.update([0u8]);
    h.update(data);
    h.finalize().to_vec()
}

/// Owned snapshot resolver for one call tree: contract address bytes → (code, storage).
/// Built from the PRE-LOADED accounts (bounded by the tx access list) so it is `'static`
/// (wasmi host data must be) and identical on every node.
struct SnapshotResolver {
    codes: BTreeMap<Vec<u8>, Vec<u8>>,
    stores: BTreeMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>,
}
impl qnet_vm::ContractResolver for SnapshotResolver {
    fn code(&self, a: &[u8]) -> Option<Vec<u8>> { self.codes.get(a).cloned() }
    fn storage(&self, a: &[u8]) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.stores.get(a).cloned().unwrap_or_default()
    }
}

/// Build the resolver from the working set for exactly the contracts in `set`. Only wasm
/// contracts (type=="wasm" with decodable code) are included; a call to anything else
/// deterministically returns `CALL_ERR_NOT_CONTRACT`.
fn build_resolver(accounts: &HashMap<String, Account>, set: &[String]) -> SnapshotResolver {
    let mut codes = BTreeMap::new();
    let mut stores = BTreeMap::new();
    for addr in set {
        let acc = match accounts.get(addr) { Some(a) => a, None => continue };
        if acc.contract_storage.get("type").map(|t| t == "wasm").unwrap_or(false) {
            if let Some(code) = acc.contract_storage.get("code").and_then(|h| hex::decode(h).ok()) {
                codes.insert(addr.as_bytes().to_vec(), code);
                stores.insert(addr.as_bytes().to_vec(), base_from_storage(&acc.contract_storage));
            }
        }
    }
    SnapshotResolver { codes, stores }
}

/// Outcome of a WASM contract-call tree, ready to commit into accounts.
pub struct WasmTreeResult {
    pub trapped: bool,
    pub fuel_consumed: u64,
    pub ret: Vec<u8>,
    /// Per-contract storage delta keyed by the contract's String address (deterministic
    /// order). EMPTY when the tree trapped — commit only when `!trapped`.
    pub writes: Vec<(String, Vec<(Vec<u8>, Vec<u8>)>)>,
    /// Ordered (contract_addr, log_data) across the tree (for logs_root at activation).
    pub logs: Vec<(String, Vec<u8>)>,
}

/// Execute a wasm ContractCall (possibly cross-contract) deterministically under a fuel
/// budget. PURE — mutates no account; returns the outcome. The caller commits `writes`
/// (hex-encoded into each contract's contract_storage) ONLY when `!trapped`. `call_set`
/// = entry contract + declared access list, all already in the pre-loaded `accounts`.
pub fn execute_wasm_calltree(
    accounts: &HashMap<String, Account>,
    entry_addr: &str,
    call_set: &[String],
    entry: &str,
    caller: &str,
    value: u64,
    block_height: u64,
    args: Vec<u8>,
    fuel: u64,
) -> WasmTreeResult {
    let resolver = build_resolver(accounts, call_set);
    let o = qnet_vm::execute_call_tree(
        Rc::new(resolver),
        entry_addr.as_bytes(), entry, caller.as_bytes(), value, block_height, args, fuel,
    );
    // Contract addresses are UTF-8 by construction (String account keys); drop any that
    // somehow are not (cannot happen for our keys) rather than panicking.
    let writes = o.writes.into_iter().filter_map(|(a, d)| {
        String::from_utf8(a).ok().map(|addr| (addr, d.into_iter().collect::<Vec<_>>()))
    }).collect();
    let logs = o.logs.into_iter().filter_map(|(a, d)| {
        String::from_utf8(a).ok().map(|addr| (addr, d))
    }).collect();
    WasmTreeResult { trapped: o.trapped, fuel_consumed: o.fuel_consumed, ret: o.ret, writes, logs }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a wasm contract account (type=wasm + hex code) from a WAT source.
    fn wasm_account(addr: &str, wat: &str) -> Account {
        let code = wat::parse_str(wat).unwrap();
        let mut a = Account::new(addr.to_string());
        a.is_contract = true;
        a.contract_storage.insert("type".to_string(), "wasm".to_string());
        a.contract_storage.insert("code".to_string(), hex::encode(&code));
        a
    }

    #[test]
    fn base_from_storage_skips_metadata_and_nonhex() {
        let mut s: HashMap<String, String> = HashMap::new();
        s.insert(hex::encode(b"k"), hex::encode(b"v"));       // data
        s.insert("type".to_string(), "wasm".to_string());    // metadata → skip
        s.insert("code".to_string(), "deadbeef".to_string()); // reserved → skip
        let base = base_from_storage(&s);
        assert_eq!(base.get(&b"k".to_vec()).map(|v| v.as_slice()), Some(b"v".as_slice()));
        assert_eq!(base.len(), 1);
    }

    #[test]
    fn gate_is_on_for_launch() {
        // Guards against an accidental revert: contracts are ENABLED from genesis. A change
        // here is a from-genesis consensus commitment (see the module doc), not a config tweak.
        assert!(wasm_vm_enabled(), "the contract VM ships ON for the genesis launch");
    }

    #[test]
    fn log_leaf_is_deterministic_domain_separated_and_stable() {
        // log_leaf is the consensus leaf hashed into the (gated) window logs_root. Its exact byte
        // format — sha3_256(contract_hex ++ 0x00 ++ data) — is a network-wide commitment once the
        // gate activates, so this test freezes it: an accidental change to the domain separator or
        // hash would fork every node at activation and must break here first.
        // 1) Deterministic + fixed 32-byte width.
        assert_eq!(log_leaf("ab", b"cd"), log_leaf("ab", b"cd"), "pure function of its inputs");
        assert_eq!(log_leaf("ab", b"cd").len(), 32, "sha3_256 → 32-byte leaf");
        // 2) The 0x00 separator makes the (contract, data) split unambiguous: without it,
        //    ("ab","cd") and ("abcd","") would both hash the byte string "abcd" and collide.
        assert_ne!(log_leaf("ab", b"cd"), log_leaf("abcd", b""), "separator prevents split-collision");
        assert_ne!(log_leaf("ab", b"cd"), log_leaf("a", b"bcd"), "separator prevents split-collision");
        // 3) Golden vector — locks the concrete encoding, not just its structural properties.
        assert_eq!(
            hex::encode(log_leaf("00", &[0x11u8, 0x22])),
            "c5cf8e215d3a5db4a8db9bccf2181c629728957456a67220a74fe3e19a8cf813",
        );
    }

    #[test]
    fn calltree_commits_delta_on_success() {
        // Single contract reads seeded "src" and writes it to "dst" (read-roundtrip).
        let mut c = wasm_account("c", r#"(module
            (import "env" "storage_read" (func $sr (param i32 i32 i32 i32)(result i32)))
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (memory (export "memory") 1)
            (data (i32.const 0) "srcdst")
            (func (export "run")(local $n i32)
                (local.set $n (call $sr (i32.const 0)(i32.const 3)(i32.const 64)(i32.const 32)))
                (call $sw (i32.const 3)(i32.const 3)(i32.const 64)(local.get $n))))"#);
        c.contract_storage.insert(hex::encode(b"src"), hex::encode(b"DATA"));
        let mut accts = HashMap::new();
        accts.insert("c".to_string(), c);
        let r = execute_wasm_calltree(&accts, "c", &["c".to_string()], "run", "caller", 0, 0, Vec::new(), 1_000_000);
        assert!(!r.trapped);
        assert!(r.fuel_consumed > 0);
        assert_eq!(r.writes, vec![("c".to_string(), vec![(b"dst".to_vec(), b"DATA".to_vec())])]);
    }

    #[test]
    fn calltree_trap_yields_no_delta() {
        // Contract writes then reverts → trapped, no delta committed.
        let c = wasm_account("c", r#"(module
            (import "env" "revert" (func $rev (param i32 i32)))
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (memory (export "memory") 1)
            (data (i32.const 0) "kvxx")
            (func (export "run")
                (call $sw (i32.const 0)(i32.const 1)(i32.const 1)(i32.const 1))
                (call $rev (i32.const 2)(i32.const 2))))"#);
        let mut accts = HashMap::new();
        accts.insert("c".to_string(), c);
        let r = execute_wasm_calltree(&accts, "c", &["c".to_string()], "run", "caller", 0, 0, Vec::new(), 1_000_000);
        assert!(r.trapped);
        assert!(r.writes.is_empty(), "a trapped tree commits NOTHING");
    }

    // B writes bk=bv. A calls B then writes ak=av.
    const B_WRITES: &str = r#"(module
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "bkbv")
        (func (export "run")
            (call $sw (i32.const 0)(i32.const 2)(i32.const 2)(i32.const 2))))"#;
    const A_CALLS_B: &str = r#"(module
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "Brunakav")
        (func (export "run")(local $n i32)
            (local.set $n (call $call
                (i32.const 0)(i32.const 1) (i32.const 1)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (call $sw (i32.const 4)(i32.const 2)(i32.const 6)(i32.const 2))))"#;

    #[test]
    fn calltree_cross_contract_commits_both_when_declared() {
        let mut accts = HashMap::new();
        accts.insert("A".to_string(), wasm_account("A", A_CALLS_B));
        accts.insert("B".to_string(), wasm_account("B", B_WRITES));
        let set = vec!["A".to_string(), "B".to_string()]; // B declared in the access list
        let r = execute_wasm_calltree(&accts, "A", &set, "run", "caller", 0, 0, Vec::new(), 5_000_000);
        assert!(!r.trapped);
        assert_eq!(r.writes, vec![
            ("A".to_string(), vec![(b"ak".to_vec(), b"av".to_vec())]),
            ("B".to_string(), vec![(b"bk".to_vec(), b"bv".to_vec())]),
        ], "both A's and B's deltas commit, addr-sorted");
    }

    #[test]
    fn calltree_undeclared_callee_is_unresolvable() {
        // Same contracts, but B is NOT in the access list → A's call to B returns
        // CALL_ERR_NOT_CONTRACT; A ignores it and still commits its own write.
        let mut accts = HashMap::new();
        accts.insert("A".to_string(), wasm_account("A", A_CALLS_B));
        accts.insert("B".to_string(), wasm_account("B", B_WRITES));
        let set = vec!["A".to_string()]; // B omitted
        let r = execute_wasm_calltree(&accts, "A", &set, "run", "caller", 0, 0, Vec::new(), 5_000_000);
        assert!(!r.trapped);
        assert_eq!(r.writes, vec![("A".to_string(), vec![(b"ak".to_vec(), b"av".to_vec())])]);
        assert!(r.writes.iter().all(|(a, _)| a != "B"), "undeclared B cannot be reached or written");
    }
}

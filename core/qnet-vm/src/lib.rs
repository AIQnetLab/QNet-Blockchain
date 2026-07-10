//! Deterministic on-chain smart-contract VM — Phase 1 (foundation, INERT).
//!
//! This crate is a LEAF: it depends on no consensus code and is NOT wired into
//! `apply_to_state`, so nothing here can change a `state_root` (zero fork risk).
//! P1 delivers the deploy-time module VALIDATOR — the determinism gate every
//! WASM contract must pass before it could ever execute (P2 dry-run, P3 cut-over).
//!
//! DETERMINISM CONTRACT enforced here (a single divergent byte across nodes forks
//! the chain, so the accepted feature set is deliberately minimal):
//!   - NO floating point (f32/f64 value types, params, locals, globals, or ops) —
//!     removes NaN-bit-pattern + rounding nondeterminism entirely.
//!   - NO threads/atomics, SIMD, reference-types, GC, tail-calls, exceptions,
//!     bulk-memory-beyond-MVP, etc. — rejected via a restricted feature set.
//!   - Bounded linear memory (page cap) and bounded module/code size.
//! The interpreter itself (P2) will additionally cap call-stack depth + meter fuel.

use wasmparser::{Parser, Payload, Validator, WasmFeatures};

/// Protocol-constant limits (P1 defaults; frozen as consensus constants before P3).
#[derive(Debug, Clone, Copy)]
pub struct VmLimits {
    /// Max linear-memory pages a module may declare/grow (64 KiB/page). 256 = 16 MiB.
    pub max_memory_pages: u32,
    /// Max total module size in bytes (anti-DoS on parse/instantiate).
    pub max_code_bytes: usize,
    /// Max number of functions in a module.
    pub max_functions: u32,
}

impl Default for VmLimits {
    fn default() -> Self {
        Self { max_memory_pages: 256, max_code_bytes: 512 * 1024, max_functions: 8_192 }
    }
}

/// Why a module was rejected at deploy-time validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VmError {
    /// Module exceeded a size/count bound.
    LimitExceeded(String),
    /// Module used a non-deterministic / disallowed feature (floats, threads, simd...).
    Nondeterministic(String),
    /// Structurally invalid / not decodable WASM under the restricted feature set.
    Invalid(String),
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VmError::LimitExceeded(m) => write!(f, "[REJECT][VM] limit_exceeded {}", m),
            VmError::Nondeterministic(m) => write!(f, "[REJECT][VM] nondeterministic {}", m),
            VmError::Invalid(m) => write!(f, "[REJECT][VM] invalid_module {}", m),
        }
    }
}
impl std::error::Error for VmError {}

/// The minimal, deterministic WASM feature set QNet contracts may use. Everything
/// off the deterministic core is DISABLED, so `validate_all` itself rejects any
/// module that uses it. Crucially FLOATS is left OFF: wasmparser then rejects ALL
/// float usage (value types AND every float operator) natively — authoritative and
/// exhaustive, so we don't hand-maintain a float-op list. Threads/atomics, SIMD,
/// reference-types, GC, tail-call, exceptions, relaxed-simd, memory64, etc. stay OFF.
fn deterministic_features() -> WasmFeatures {
    let mut f = WasmFeatures::empty();
    f.insert(WasmFeatures::MUTABLE_GLOBAL);
    f.insert(WasmFeatures::SIGN_EXTENSION);
    f.insert(WasmFeatures::MULTI_VALUE);
    f.insert(WasmFeatures::SATURATING_FLOAT_TO_INT); // int-only trunc_sat (no float result)
    f
}

/// Deploy-time validation: structural validity under the restricted (float-free)
/// feature set + protocol size/count limits. Returns Ok(()) only for a module safe
/// to (eventually) execute deterministically.
pub fn validate_wasm_module(bytes: &[u8], limits: &VmLimits) -> Result<(), VmError> {
    if bytes.len() > limits.max_code_bytes {
        return Err(VmError::LimitExceeded(format!(
            "code_bytes={} max={}", bytes.len(), limits.max_code_bytes)));
    }

    // 1) Structural validation with FLOATS + all non-deterministic proposals OFF:
    //    this alone rejects float usage, threads/atomics, simd, reference-types,
    //    gc, tail-call, exceptions, etc. Reclassify a float rejection as
    //    Nondeterministic (it is a determinism policy rejection, not a malformed
    //    module) so the reason is honest.
    Validator::new_with_features(deterministic_features())
        .validate_all(bytes)
        .map_err(|e| {
            let m = e.to_string();
            if m.contains("floating-point") {
                VmError::Nondeterministic(format!("float {}", m))
            } else {
                VmError::Invalid(m)
            }
        })?;

    // 2) Protocol limits not expressible as wasm features: memory-page cap and
    //    function-count cap. (Floats + disallowed proposals already rejected above.)
    let mut func_count: u32 = 0u32;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|e| VmError::Invalid(e.to_string()))?;
        match payload {
            Payload::MemorySection(reader) => {
                for m in reader {
                    let m = m.map_err(|e| VmError::Invalid(e.to_string()))?;
                    // Require an explicit maximum ≤ page cap. An absent maximum lets a
                    // runtime memory.grow reach the wasm32 ceiling, where success hinges on
                    // host RAM (allocator) → divergent state_root across nodes = fork.
                    let max = m.maximum.ok_or_else(|| VmError::LimitExceeded(
                        "memory_max=unbounded (explicit maximum required)".to_string()))?;
                    if max > limits.max_memory_pages as u64 {
                        return Err(VmError::LimitExceeded(format!(
                            "memory_pages={} max={}", max, limits.max_memory_pages)));
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                func_count = func_count.saturating_add(reader.count());
                if func_count > limits.max_functions {
                    return Err(VmError::LimitExceeded(format!(
                        "functions={} max={}", func_count, limits.max_functions)));
                }
            }
            Payload::ImportSection(reader) => {
                // Reject imported memory/table: they escape the MemorySection page-cap and the runtime
                // linker provides neither (host fns only) → forbid at deploy so every accepted module
                // is bounded by its own declarations. Handles all import-group encodings.
                fn is_mem_or_table(ty: &wasmparser::TypeRef) -> bool {
                    matches!(ty, wasmparser::TypeRef::Memory(_) | wasmparser::TypeRef::Table(_))
                }
                for group in reader {
                    let bad = match group.map_err(|e| VmError::Invalid(e.to_string()))? {
                        wasmparser::Imports::Single(_, imp) => is_mem_or_table(&imp.ty),
                        wasmparser::Imports::Compact2 { ty, .. } => is_mem_or_table(&ty),
                        wasmparser::Imports::Compact1 { items, .. } => {
                            let mut found = false;
                            for it in items {
                                if is_mem_or_table(&it.map_err(|e| VmError::Invalid(e.to_string()))?.ty) {
                                    found = true;
                                    break;
                                }
                            }
                            found
                        }
                    };
                    if bad {
                        return Err(VmError::LimitExceeded(
                            "imported_memory_or_table_forbidden".to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 (shadow/dry-run, OFF the consensus path): fuel-metered execution.
// This runs a validated module under a strict fuel budget and reports the fuel
// consumed + whether it trapped. NO host functions / state access yet (that is
// the next P2 step) and NOTHING here is wired into apply_to_state — so it cannot
// change a state_root. It exists to PROVE the interpreter is deterministic +
// haltable in our workspace before any of it approaches consensus.
// ─────────────────────────────────────────────────────────────────────────────

/// Outcome of a metered execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutcome {
    /// Fuel consumed (gas). Deterministic for a given (module, entry, arg).
    pub fuel_consumed: u64,
    /// True iff execution trapped (out-of-fuel, div-by-zero, OOB, unreachable...).
    /// On a trap the caller must revert ALL state (the overlay is dropped) — that
    /// atomic-rollback wiring lands with the host/state step, not here.
    pub trapped: bool,
    /// i64 return value when the entry returned one and did not trap.
    pub result: Option<i64>,
}

/// Deterministic interpreter config: fuel metering ON. Floats + non-deterministic
/// proposals are already rejected at deploy validation, so a module reaching here
/// is float-free; fuel guarantees halting within the budget.
fn deterministic_engine() -> wasmi::Engine {
    let mut cfg = wasmi::Config::default();
    cfg.consume_fuel(true);
    wasmi::Engine::new(&cfg)
}

/// Run a validated module's `entry(i64)->i64` under `fuel_budget`, no host imports.
/// Halting is guaranteed: fuel strictly decreases; exhaustion traps deterministically.
/// P2 smoke surface — the real dry-run (host functions + state overlay) builds on this.
pub fn execute_metered_smoke(
    wasm: &[u8],
    entry: &str,
    arg: i64,
    fuel_budget: u64,
) -> Result<ExecOutcome, VmError> {
    let engine = deterministic_engine();
    let module = wasmi::Module::new(&engine, wasm)
        .map_err(|e| VmError::Invalid(e.to_string()))?;
    let mut store = wasmi::Store::new(&engine, ());
    store.set_fuel(fuel_budget).map_err(|e| VmError::Invalid(e.to_string()))?;

    let linker = wasmi::Linker::<()>::new(&engine);
    let instance = match linker
        .instantiate(&mut store, &module)
        .and_then(|pre| pre.start(&mut store))
    {
        Ok(i) => i,
        // Instantiate/start can itself trap (e.g. out of fuel) — report it, not error.
        Err(_) => {
            let consumed = fuel_budget.saturating_sub(store.get_fuel().unwrap_or(0));
            return Ok(ExecOutcome { fuel_consumed: consumed, trapped: true, result: None });
        }
    };

    let func = instance
        .get_typed_func::<i64, i64>(&store, entry)
        .map_err(|e| VmError::Invalid(format!("entry {} {}", entry, e)))?;

    let call = func.call(&mut store, arg);
    let consumed = fuel_budget.saturating_sub(store.get_fuel().unwrap_or(0));
    match call {
        Ok(v) => Ok(ExecOutcome { fuel_consumed: consumed, trapped: false, result: Some(v) }),
        Err(_) => Ok(ExecOutcome { fuel_consumed: consumed, trapped: true, result: None }),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 host layer (OFF consensus): the deterministic syscall surface a contract may
// call, marshalled through the contract's own linear memory. STILL not wired into
// apply_to_state. The integration layer (P3) will implement `HostContext` over
// Account.contract_storage; P2 uses an in-mem impl for the dry-run harness + corpus.
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::BTreeMap;

/// A host-function failure — each becomes a DETERMINISTIC trap (whole-call revert).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostError {
    /// Storage entry-count / size cap hit.
    StorageLimit,
    /// Contract called `revert(msg)`.
    Reverted(Vec<u8>),
    /// Any other host-side rejection.
    Other(String),
}

/// The deterministic syscall surface. EVERY method must be deterministic across all
/// validators: no wall-clock, no entropy, no threads, no map-iteration-order leaking
/// into output. Addresses are opaque byte strings; amounts are native QNC nano-units.
pub trait HostContext {
    fn storage_read(&self, key: &[u8]) -> Option<Vec<u8>>;
    fn storage_write(&mut self, key: &[u8], val: &[u8]) -> Result<(), HostError>;
    fn caller(&self) -> &[u8];
    fn contract(&self) -> &[u8];
    fn value(&self) -> u64;
    /// Slot-anchored block height — the ONLY time-like source (never wall-clock).
    fn block_height(&self) -> u64;
    fn emit_log(&mut self, data: &[u8]);
}

/// In-memory `HostContext` for the P2 dry-run + determinism corpus. Storage is a
/// BTreeMap (SORTED → deterministic iteration, mirroring the state-layer discipline).
/// Captures writes + logs so a caller can inspect them — and DISCARD them when the
/// run trapped (the overlay-atomicity contract; P3 drops the account overlay instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemHost {
    storage: BTreeMap<Vec<u8>, Vec<u8>>,
    caller: Vec<u8>,
    contract: Vec<u8>,
    value: u64,
    block_height: u64,
    pub logs: Vec<Vec<u8>>,
    max_entries: usize,
}

impl MemHost {
    pub fn new(caller: Vec<u8>, contract: Vec<u8>, value: u64, block_height: u64) -> Self {
        Self { storage: BTreeMap::new(), caller, contract, value, block_height,
               logs: Vec::new(), max_entries: 50_000 }
    }
    /// Seed a pre-existing storage entry (e.g. state the contract reads).
    pub fn seed(&mut self, key: &[u8], val: &[u8]) { self.storage.insert(key.to_vec(), val.to_vec()); }
    pub fn storage(&self) -> &BTreeMap<Vec<u8>, Vec<u8>> { &self.storage }
}

impl HostContext for MemHost {
    fn storage_read(&self, key: &[u8]) -> Option<Vec<u8>> { self.storage.get(key).cloned() }
    fn storage_write(&mut self, key: &[u8], val: &[u8]) -> Result<(), HostError> {
        if !self.storage.contains_key(key) && self.storage.len() >= self.max_entries {
            return Err(HostError::StorageLimit);
        }
        self.storage.insert(key.to_vec(), val.to_vec());
        Ok(())
    }
    fn caller(&self) -> &[u8] { &self.caller }
    fn contract(&self) -> &[u8] { &self.contract }
    fn value(&self) -> u64 { self.value }
    fn block_height(&self) -> u64 { self.block_height }
    fn emit_log(&mut self, data: &[u8]) { self.logs.push(data.to_vec()); }
}

// A host-raised trap carrying a message. Becomes a deterministic wasm trap.
#[derive(Debug)]
struct HostTrap(String);
impl core::fmt::Display for HostTrap {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { write!(f, "{}", self.0) }
}
impl wasmi::core::HostError for HostTrap {}
fn trap(msg: impl core::fmt::Display) -> wasmi::Error { wasmi::Error::host(HostTrap(msg.to_string())) }

/// Charge the LOG-opcode-style fuel cost for emitting a `len`-byte event and enforce the
/// per-event size cap. Shared by the single-contract (dry-run) and multi-frame (apply) host
/// bindings so log pricing is byte-identical on every path. Deterministic: fuel is part of
/// the shared consensus execution budget, so every node charges and traps at the same point.
fn charge_log_fuel<T>(caller: &mut wasmi::Caller<'_, T>, len: usize) -> Result<(), wasmi::Error> {
    if len > MAX_LOG_DATA_BYTES { return Err(trap("emit_log LogTooLarge")); }
    let cost = LOG_FUEL_BASE.saturating_add((len as u64).saturating_mul(LOG_FUEL_PER_BYTE));
    let have = caller.get_fuel().unwrap_or(0);
    if have < cost { return Err(trap("emit_log OutOfFuel")); }
    let _ = caller.set_fuel(have.saturating_sub(cost));
    Ok(())
}

fn host_memory<H>(caller: &wasmi::Caller<'_, H>) -> Result<wasmi::Memory, wasmi::Error> {
    match caller.get_export("memory") {
        Some(wasmi::Extern::Memory(m)) => Ok(m),
        _ => Err(trap("no_exported_memory")),
    }
}
fn mem_read<H>(caller: &wasmi::Caller<'_, H>, mem: &wasmi::Memory, ptr: i32, len: i32) -> Result<Vec<u8>, wasmi::Error> {
    let len = len.max(0) as usize;
    let mut buf = vec![0u8; len];
    mem.read(caller, ptr.max(0) as usize, &mut buf).map_err(|_| trap("mem_read_oob"))?;
    Ok(buf)
}
fn mem_write<H>(caller: &mut wasmi::Caller<'_, H>, mem: &wasmi::Memory, ptr: i32, data: &[u8]) -> Result<(), wasmi::Error> {
    mem.write(caller, ptr.max(0) as usize, data).map_err(|_| trap("mem_write_oob"))
}

/// Run a validated module's `entry()` under `fuel_budget` with the host imports
/// bound (module "env"). Returns the outcome + the (possibly-mutated) host state:
/// on `trapped == true` the caller MUST DISCARD that host state (it may hold partial
/// writes) — that is the overlay-atomicity contract the P3 apply wiring enforces by
/// dropping the account overlay. OFF the consensus path; changes no state_root.
///
/// Host ABI (module "env", all pointers/lengths index the contract's linear memory):
///   storage_write(key_ptr,key_len,val_ptr,val_len)
///   storage_read(key_ptr,key_len,out_ptr,out_cap) -> i32  (-1 absent; else full value len)
///   get_caller(out_ptr,out_cap) -> i32                    (full addr len)
///   get_block_height() -> i64
///   get_value() -> i64
///   emit_log(data_ptr,data_len)
///   revert(msg_ptr,msg_len)                               (always traps)
pub fn dry_run<H: HostContext + Send + Sync + 'static>(
    wasm: &[u8],
    entry: &str,
    host: H,
    fuel_budget: u64,
) -> Result<(ExecOutcome, H), VmError> {
    let engine = deterministic_engine();
    let module = wasmi::Module::new(&engine, wasm).map_err(|e| VmError::Invalid(e.to_string()))?;
    let mut store = wasmi::Store::new(&engine, host);
    store.set_fuel(fuel_budget).map_err(|e| VmError::Invalid(e.to_string()))?;
    let mut linker = wasmi::Linker::<H>::new(&engine);

    linker.func_wrap("env", "storage_write",
        |mut caller: wasmi::Caller<'_, H>, kp: i32, kl: i32, vp: i32, vl: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let key = mem_read(&caller, &mem, kp, kl)?;
            let val = mem_read(&caller, &mem, vp, vl)?;
            caller.data_mut().storage_write(&key, &val).map_err(|e| trap(format!("storage_write {:?}", e)))
        }).map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "storage_read",
        |mut caller: wasmi::Caller<'_, H>, kp: i32, kl: i32, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let key = mem_read(&caller, &mem, kp, kl)?;
            match caller.data().storage_read(&key) {
                None => Ok(-1),
                Some(v) => {
                    let n = v.len().min(ocap.max(0) as usize);
                    mem_write(&mut caller, &mem, op, &v[..n])?;
                    Ok(v.len() as i32)
                }
            }
        }).map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "get_caller",
        |mut caller: wasmi::Caller<'_, H>, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let addr = caller.data().caller().to_vec();
            let n = addr.len().min(ocap.max(0) as usize);
            mem_write(&mut caller, &mem, op, &addr[..n])?;
            Ok(addr.len() as i32)
        }).map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "get_block_height",
        |caller: wasmi::Caller<'_, H>| -> i64 { caller.data().block_height() as i64 })
        .map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "get_value",
        |caller: wasmi::Caller<'_, H>| -> i64 { caller.data().value() as i64 })
        .map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "emit_log",
        |mut caller: wasmi::Caller<'_, H>, dp: i32, dl: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let data = mem_read(&caller, &mem, dp, dl)?;
            charge_log_fuel(&mut caller, data.len())?;
            caller.data_mut().emit_log(&data);
            Ok(())
        }).map_err(|e| VmError::Invalid(e.to_string()))?;

    linker.func_wrap("env", "revert",
        |caller: wasmi::Caller<'_, H>, mp: i32, ml: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let msg = mem_read(&caller, &mem, mp, ml)?;
            Err(trap(format!("revert:{}", String::from_utf8_lossy(&msg))))
        }).map_err(|e| VmError::Invalid(e.to_string()))?;

    // Instantiate (start may trap, e.g. out of fuel) then call the entry.
    let instance = match linker.instantiate(&mut store, &module).and_then(|p| p.start(&mut store)) {
        Ok(i) => i,
        Err(_) => {
            let consumed = fuel_budget.saturating_sub(store.get_fuel().unwrap_or(0));
            return Ok((ExecOutcome { fuel_consumed: consumed, trapped: true, result: None }, store.into_data()));
        }
    };
    let func = instance.get_typed_func::<(), ()>(&store, entry)
        .map_err(|e| VmError::Invalid(format!("entry {} {}", entry, e)))?;
    let call = func.call(&mut store, ());
    let consumed = fuel_budget.saturating_sub(store.get_fuel().unwrap_or(0));
    let trapped = call.is_err();
    Ok((ExecOutcome { fuel_consumed: consumed, trapped, result: None }, store.into_data()))
}

// ─────────────────────────────────────────────────────────────────────────────
// P5 cross-contract calls (VM CORE — OFF consensus; the apply-layer wiring is gated
// and additionally BLOCKED on a working-set loader redesign, see wasm_exec.rs). A
// contract may synchronously call ANOTHER contract's exported entry, passing args +
// a value context and receiving return bytes. Determinism + safety are enforced here:
//   - bounded call DEPTH (MAX_CALL_DEPTH) — no unbounded native recursion,
//   - REENTRANCY forbidden: a contract already on the call stack cannot be re-entered
//     (the conservative default — kills the classic reentrancy-drain at the VM layer),
//   - fuel is threaded across frames from ONE shared budget: a child spends the
//     parent's remaining fuel and the parent resumes with the child's leftover,
//   - per-frame overlay atomicity: a child's storage writes + logs COMMIT only when it
//     returns cleanly; a trapped child commits NOTHING and surfaces a negative error
//     code to its caller (which may itself revert or continue).
// Storage is per-contract (a frame reads/writes only ITS OWN contract's storage);
// cross-contract data flows solely through call args + return bytes. NO native value
// (QNC balance) moves here — balances live in the state layer; `value` is context only
// (`get_value`) until the apply layer models cross-call balance transfer.
// ─────────────────────────────────────────────────────────────────────────────

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

/// Max contracts on the call stack at once (frozen as a consensus constant before
/// activation). Bounds native recursion + total per-tx contract fan-in depth.
pub const MAX_CALL_DEPTH: usize = 8;
/// Max distinct storage writes a single frame invocation may make (anti-DoS).
const MAX_WRITES_PER_FRAME: usize = 50_000;

/// emit_log economic bound — the LOG-opcode pricing pattern. A single event's data is
/// hard-capped at MAX_LOG_DATA_BYTES (one emit can't blow the frame), and every emit
/// charges LOG_FUEL_BASE + LOG_FUEL_PER_BYTE·len fuel out of the tx's shared budget, so
/// total persisted log volume is paid for by gas (bounded by gas_limit) instead of being
/// near-free. Without this, host-side log bytes escape wasm fuel metering entirely and a
/// cheap ContractCall could persist unbounded data into the block-logs store.
const MAX_LOG_DATA_BYTES: usize = 16_384;
const LOG_FUEL_BASE: u64 = 375;
const LOG_FUEL_PER_BYTE: u64 = 8;

/// call_contract error codes (returned as negative i32 to the calling contract).
pub const CALL_ERR_NOT_CONTRACT: i32 = -1; // target has no code / is not a contract
pub const CALL_ERR_DEPTH_OR_REENTRANT: i32 = -2; // depth cap hit OR target already on stack
pub const CALL_ERR_TRAPPED: i32 = -3; // callee trapped (out-of-fuel, revert, OOB, ...)

/// Resolves a contract's validated code + committed storage for cross-contract calls.
/// The executor snapshots each contract's storage once (lazily, on first touch) and
/// overlays writes; `code` returns None for a non-contract target (→ CALL_ERR_NOT_CONTRACT).
pub trait ContractResolver {
    fn code(&self, addr: &[u8]) -> Option<Vec<u8>>;
    fn storage(&self, addr: &[u8]) -> BTreeMap<Vec<u8>, Vec<u8>>;
}

/// Result of executing a whole call tree rooted at the entry contract.
pub struct CallTreeOutcome {
    pub trapped: bool,
    pub fuel_consumed: u64,
    /// Entry frame's return bytes (empty on trap).
    pub ret: Vec<u8>,
    /// Committed storage DELTA per contract (addr → {key → val}); empty on entry trap.
    /// Contains only keys actually written by a successful frame, never the read base.
    pub writes: BTreeMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>,
    /// Ordered (contract_addr, log_data) across the tree (DFS emit order); empty on trap.
    pub logs: Vec<(Vec<u8>, Vec<u8>)>,
}

/// Shared, single-threaded state across every frame of one call tree.
struct CallState {
    resolver: Rc<dyn ContractResolver>,
    engine: wasmi::Engine,
    /// Lazily-loaded read-only base snapshot per contract (never mutated).
    base: BTreeMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>,
    /// Committed writes from SUCCESSFUL frames — the exported delta. Read overlays base.
    delta: BTreeMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>,
    loaded: BTreeSet<Vec<u8>>,
    /// Contracts currently executing (reentrancy + depth bound).
    stack: Vec<Vec<u8>>,
}

impl CallState {
    fn ensure_loaded(&mut self, addr: &[u8]) {
        if self.loaded.insert(addr.to_vec()) {
            let b = self.resolver.storage(addr);
            self.base.insert(addr.to_vec(), b);
        }
    }
    /// Committed value for (addr,key): frame-committed delta shadows the base.
    fn committed_read(&mut self, addr: &[u8], key: &[u8]) -> Option<Vec<u8>> {
        self.ensure_loaded(addr);
        if let Some(v) = self.delta.get(addr).and_then(|m| m.get(key)) { return Some(v.clone()); }
        self.base.get(addr).and_then(|m| m.get(key)).cloned()
    }
    fn commit_writes(&mut self, addr: &[u8], writes: BTreeMap<Vec<u8>, Vec<u8>>) {
        if writes.is_empty() { return; }
        self.delta.entry(addr.to_vec()).or_default().extend(writes);
    }
}

/// Per-frame host data: one contract's execution context + its uncommitted overlay.
struct FrameHost {
    state: Rc<RefCell<CallState>>,
    me: Vec<u8>,
    caller: Vec<u8>,
    value: u64,
    block_height: u64,
    args: Vec<u8>,
    ret: Vec<u8>,
    overlay: BTreeMap<Vec<u8>, Vec<u8>>,
    logs: Vec<(Vec<u8>, Vec<u8>)>,
    /// Store-level growth cap (memory/tables) so grow denials are host-RAM-independent.
    limits: wasmi::StoreLimits,
}

/// Consensus memory ceiling for an execution store: caps each linear memory at the page
/// limit so an over-cap memory.grow fails deterministically (returns -1 on every node)
/// instead of reaching the host allocator (RAM-dependent → state_root fork).
fn frame_store_limits() -> wasmi::StoreLimits {
    wasmi::StoreLimitsBuilder::new()
        .memory_size(VmLimits::default().max_memory_pages as usize * 65536)
        .build()
}

struct FrameResult {
    trapped: bool,
    ret: Vec<u8>,
    logs: Vec<(Vec<u8>, Vec<u8>)>,
    writes: BTreeMap<Vec<u8>, Vec<u8>>,
    fuel_left: u64,
}

/// Bind the deterministic host ABI (module "env") onto a per-frame linker. Every fn
/// marshals through the contract's own linear memory. Extends the single-contract ABI
/// (storage_read/write, get_caller, get_block_height, get_value, emit_log, revert) with:
///   get_contract(out_ptr,out_cap) -> i32               (this contract's own address)
///   get_call_args(out_ptr,out_cap) -> i32              (args passed by the caller)
///   set_return(ptr,len)                                (this frame's return bytes)
///   call_contract(addr_ptr,addr_len, entry_ptr,entry_len, args_ptr,args_len,
///                 value:i64, ret_ptr,ret_cap) -> i32   (>=0 full ret len; <0 CALL_ERR_*)
fn bind_frame_host(linker: &mut wasmi::Linker<FrameHost>) -> Result<(), wasmi::Error> {
    linker.func_wrap("env", "storage_write",
        |mut caller: wasmi::Caller<'_, FrameHost>, kp: i32, kl: i32, vp: i32, vl: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let key = mem_read(&caller, &mem, kp, kl)?;
            let val = mem_read(&caller, &mem, vp, vl)?;
            let h = caller.data_mut();
            if !h.overlay.contains_key(&key) && h.overlay.len() >= MAX_WRITES_PER_FRAME {
                return Err(trap("storage_write StorageLimit"));
            }
            h.overlay.insert(key, val);
            Ok(())
        })?;

    linker.func_wrap("env", "storage_read",
        |mut caller: wasmi::Caller<'_, FrameHost>, kp: i32, kl: i32, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let key = mem_read(&caller, &mem, kp, kl)?;
            let val = {
                let h = caller.data();
                if let Some(v) = h.overlay.get(&key) { Some(v.clone()) }
                else {
                    let (st, me) = (h.state.clone(), h.me.clone());
                    let found = st.borrow_mut().committed_read(&me, &key);
                    found
                }
            };
            match val {
                None => Ok(-1),
                Some(v) => {
                    let n = v.len().min(ocap.max(0) as usize);
                    mem_write(&mut caller, &mem, op, &v[..n])?;
                    Ok(v.len() as i32)
                }
            }
        })?;

    linker.func_wrap("env", "get_caller",
        |mut caller: wasmi::Caller<'_, FrameHost>, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let addr = caller.data().caller.clone();
            let n = addr.len().min(ocap.max(0) as usize);
            mem_write(&mut caller, &mem, op, &addr[..n])?;
            Ok(addr.len() as i32)
        })?;

    linker.func_wrap("env", "get_contract",
        |mut caller: wasmi::Caller<'_, FrameHost>, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let addr = caller.data().me.clone();
            let n = addr.len().min(ocap.max(0) as usize);
            mem_write(&mut caller, &mem, op, &addr[..n])?;
            Ok(addr.len() as i32)
        })?;

    linker.func_wrap("env", "get_call_args",
        |mut caller: wasmi::Caller<'_, FrameHost>, op: i32, ocap: i32| -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let args = caller.data().args.clone();
            let n = args.len().min(ocap.max(0) as usize);
            mem_write(&mut caller, &mem, op, &args[..n])?;
            Ok(args.len() as i32)
        })?;

    linker.func_wrap("env", "set_return",
        |mut caller: wasmi::Caller<'_, FrameHost>, p: i32, l: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let data = mem_read(&caller, &mem, p, l)?;
            caller.data_mut().ret = data;
            Ok(())
        })?;

    linker.func_wrap("env", "get_block_height",
        |caller: wasmi::Caller<'_, FrameHost>| -> i64 { caller.data().block_height as i64 })?;

    linker.func_wrap("env", "get_value",
        |caller: wasmi::Caller<'_, FrameHost>| -> i64 { caller.data().value as i64 })?;

    linker.func_wrap("env", "emit_log",
        |mut caller: wasmi::Caller<'_, FrameHost>, dp: i32, dl: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let data = mem_read(&caller, &mem, dp, dl)?;
            charge_log_fuel(&mut caller, data.len())?;
            let me = caller.data().me.clone();
            caller.data_mut().logs.push((me, data));
            Ok(())
        })?;

    linker.func_wrap("env", "revert",
        |caller: wasmi::Caller<'_, FrameHost>, mp: i32, ml: i32| -> Result<(), wasmi::Error> {
            let mem = host_memory(&caller)?;
            let msg = mem_read(&caller, &mem, mp, ml)?;
            Err(trap(format!("revert:{}", String::from_utf8_lossy(&msg))))
        })?;

    linker.func_wrap("env", "call_contract",
        |mut caller: wasmi::Caller<'_, FrameHost>,
         ap: i32, al: i32, ep: i32, el: i32, gp: i32, gl: i32, value: i64, rp: i32, rcap: i32|
         -> Result<i32, wasmi::Error> {
            let mem = host_memory(&caller)?;
            let target = mem_read(&caller, &mem, ap, al)?;
            let entry_bytes = mem_read(&caller, &mem, ep, el)?;
            let call_args = mem_read(&caller, &mem, gp, gl)?;
            let entry = match core::str::from_utf8(&entry_bytes) {
                Ok(s) => s.to_string(),
                Err(_) => return Ok(CALL_ERR_NOT_CONTRACT),
            };
            // Validate depth + reentrancy, resolve code, push the frame — brief borrow.
            let (code, my_addr) = {
                let h = caller.data();
                let (my_addr, st) = (h.me.clone(), h.state.clone());
                let mut s = st.borrow_mut();
                if s.stack.len() >= MAX_CALL_DEPTH { return Ok(CALL_ERR_DEPTH_OR_REENTRANT); }
                if s.stack.iter().any(|a| a.as_slice() == target.as_slice()) {
                    return Ok(CALL_ERR_DEPTH_OR_REENTRANT);
                }
                let code = match s.resolver.code(&target) {
                    Some(c) => c,
                    None => return Ok(CALL_ERR_NOT_CONTRACT),
                };
                s.stack.push(target.clone());
                (code, my_addr)
            };
            // Run the child with the parent's remaining fuel; thread the leftover back.
            let parent_fuel = caller.get_fuel().unwrap_or(0);
            let bh = caller.data().block_height;
            let st = caller.data().state.clone();
            let res = run_frame(st.clone(), &code, &entry, target.clone(), my_addr,
                                value as u64, bh, call_args, parent_fuel);
            st.borrow_mut().stack.pop();
            let _ = caller.set_fuel(res.fuel_left);
            if res.trapped { return Ok(CALL_ERR_TRAPPED); }
            // Commit child writes to the shared delta + bubble child logs into THIS frame.
            st.borrow_mut().commit_writes(&target, res.writes);
            caller.data_mut().logs.extend(res.logs);
            let n = res.ret.len().min(rcap.max(0) as usize);
            mem_write(&mut caller, &mem, rp, &res.ret[..n])?;
            Ok(res.ret.len() as i32)
        })?;

    Ok(())
}

/// Execute ONE contract frame in its own Store, recursively serving `call_contract`.
/// Returns the frame's outcome; on trap the writes/logs/ret are dropped (atomicity).
fn run_frame(
    state: Rc<RefCell<CallState>>,
    code: &[u8],
    entry: &str,
    me: Vec<u8>,
    caller: Vec<u8>,
    value: u64,
    block_height: u64,
    args: Vec<u8>,
    fuel: u64,
) -> FrameResult {
    let engine = state.borrow().engine.clone();
    let dead = |fuel_left: u64| FrameResult {
        trapped: true, ret: Vec::new(), logs: Vec::new(), writes: BTreeMap::new(), fuel_left,
    };
    let module = match wasmi::Module::new(&engine, code) { Ok(m) => m, Err(_) => return dead(fuel) };
    let host = FrameHost {
        state, me, caller, value, block_height, args,
        ret: Vec::new(), overlay: BTreeMap::new(), logs: Vec::new(),
        limits: frame_store_limits(),
    };
    let mut store = wasmi::Store::new(&engine, host);
    store.limiter(|h| &mut h.limits); // deterministic grow denial (see frame_store_limits)
    if store.set_fuel(fuel).is_err() { return dead(0); }
    let mut linker = wasmi::Linker::<FrameHost>::new(&engine);
    if bind_frame_host(&mut linker).is_err() { return dead(fuel); }
    let trapped = match linker.instantiate(&mut store, &module).and_then(|p| p.start(&mut store)) {
        Err(_) => true,
        Ok(instance) => match instance.get_typed_func::<(), ()>(&store, entry) {
            Err(_) => true, // missing / mismatched entry export ⇒ trap
            Ok(func) => func.call(&mut store, ()).is_err(),
        },
    };
    let fuel_left = store.get_fuel().unwrap_or(0);
    let h = store.into_data();
    if trapped { dead(fuel_left) }
    else { FrameResult { trapped: false, ret: h.ret, logs: h.logs, writes: h.overlay, fuel_left } }
}

/// Execute a cross-contract call tree from `entry_addr::entry_name(args)` under a
/// shared `fuel` budget. Deterministic + reentrancy-safe + depth-bounded. PURE: mutates
/// no external state — the caller commits `CallTreeOutcome.writes` (per contract) and the
/// `logs` ONLY when `!trapped`. OFF the consensus path; changes no state_root.
pub fn execute_call_tree(
    resolver: Rc<dyn ContractResolver>,
    entry_addr: &[u8],
    entry_name: &str,
    caller: &[u8],
    value: u64,
    block_height: u64,
    args: Vec<u8>,
    fuel: u64,
) -> CallTreeOutcome {
    let empty = |trapped: bool, fuel_consumed: u64| CallTreeOutcome {
        trapped, fuel_consumed, ret: Vec::new(), writes: BTreeMap::new(), logs: Vec::new(),
    };
    let engine = deterministic_engine();
    let code = match resolver.code(entry_addr) { Some(c) => c, None => return empty(true, 0) };
    let state = Rc::new(RefCell::new(CallState {
        resolver, engine, base: BTreeMap::new(), delta: BTreeMap::new(),
        loaded: BTreeSet::new(), stack: vec![entry_addr.to_vec()],
    }));
    let res = run_frame(state.clone(), &code, entry_name, entry_addr.to_vec(),
                        caller.to_vec(), value, block_height, args, fuel);
    let fuel_consumed = fuel.saturating_sub(res.fuel_left);
    if res.trapped { return empty(true, fuel_consumed); }
    // Commit the entry frame's own writes, then export the whole committed delta.
    state.borrow_mut().commit_writes(entry_addr, res.writes);
    let writes = std::mem::take(&mut state.borrow_mut().delta);
    CallTreeOutcome { trapped: false, fuel_consumed, ret: res.ret, writes, logs: res.logs }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Precompiled WASM fixtures (hand-assembled binaries). Kept as literal bytes so the
    // test has no wat/wasm-tools dependency.
    // INT_WASM  = (module (func (export "f") (param i32) (result i32) local.get 0))
    // FLOAT_WASM = (module (func (export "f") (result f32) f32.const 1.0))
    const INT_WASM: &[u8] = &[
        0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00, // magic + version
        0x01,0x06,0x01,0x60,0x01,0x7f,0x01,0x7f, // type: (i32)->(i32)
        0x03,0x02,0x01,0x00,                     // func: 1 func, type 0
        0x07,0x05,0x01,0x01,0x66,0x00,0x00,      // export "f" func 0
        0x0a,0x06,0x01,0x04,0x00,0x20,0x00,0x0b, // code: local.get 0; end
    ];
    const FLOAT_WASM: &[u8] = &[
        0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
        0x01,0x05,0x01,0x60,0x00,0x01,0x7d,       // type: ()->(f32)
        0x03,0x02,0x01,0x00,
        0x07,0x05,0x01,0x01,0x66,0x00,0x00,
        0x0a,0x09,0x01,0x07,0x00,0x43,0x00,0x00,0x80,0x3f,0x0b, // f32.const 1.0; end
    ];

    #[test]
    fn accepts_int_only_module() {
        assert!(validate_wasm_module(INT_WASM, &VmLimits::default()).is_ok());
    }

    #[test]
    fn rejects_float_result_type() {
        let e = validate_wasm_module(FLOAT_WASM, &VmLimits::default()).unwrap_err();
        assert!(matches!(e, VmError::Nondeterministic(_)), "expected nondeterministic, got {:?}", e);
    }

    #[test]
    fn rejects_oversized_module() {
        let limits = VmLimits { max_code_bytes: 8, ..VmLimits::default() };
        let e = validate_wasm_module(INT_WASM, &limits).unwrap_err();
        assert!(matches!(e, VmError::LimitExceeded(_)));
    }

    #[test]
    fn rejects_garbage() {
        assert!(validate_wasm_module(&[0, 1, 2, 3, 4, 5], &VmLimits::default()).is_err());
    }

    #[test]
    fn rejects_unbounded_memory() {
        // Memory with no declared maximum can grow to the wasm32 ceiling at runtime, where
        // success depends on host RAM → state_root fork. Deploy validation must reject it.
        let wasm = wat::parse_str(r#"(module (memory (export "memory") 1))"#).unwrap();
        let e = validate_wasm_module(&wasm, &VmLimits::default()).unwrap_err();
        assert!(matches!(e, VmError::LimitExceeded(_)), "unbounded memory must be rejected, got {:?}", e);
        // A declared maximum within the page cap is accepted.
        let ok = wat::parse_str(r#"(module (memory (export "memory") 1 16))"#).unwrap();
        assert!(validate_wasm_module(&ok, &VmLimits::default()).is_ok());
        // A declared maximum above the page cap is rejected.
        let over = wat::parse_str(r#"(module (memory (export "memory") 1 9999))"#).unwrap();
        assert!(matches!(validate_wasm_module(&over, &VmLimits::default()).unwrap_err(),
                         VmError::LimitExceeded(_)));
    }

    #[test]
    fn rejects_imported_memory_and_table() {
        // Imported memory/table escape the MemorySection page-cap (the runtime provides neither), so
        // they must be rejected at deploy — else a nominally-unbounded module could be stored.
        let mem = wat::parse_str(r#"(module (import "env" "memory" (memory 1)))"#).unwrap();
        assert!(matches!(validate_wasm_module(&mem, &VmLimits::default()).unwrap_err(),
                         VmError::LimitExceeded(_)), "imported memory must be rejected");
        let tbl = wat::parse_str(r#"(module (import "env" "t" (table 1 funcref)))"#).unwrap();
        assert!(matches!(validate_wasm_module(&tbl, &VmLimits::default()).unwrap_err(),
                         VmError::LimitExceeded(_)), "imported table must be rejected");
        // An imported host FUNCTION is still fine.
        let f = wat::parse_str(r#"(module (import "env" "f" (func)) (memory (export "memory") 1 4))"#).unwrap();
        assert!(validate_wasm_module(&f, &VmLimits::default()).is_ok());
    }

    // ADD1_WASM = (module (func (export "add1") (param i64) (result i64)
    //                       local.get 0 i64.const 1 i64.add))
    const ADD1_WASM: &[u8] = &[
        0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,       // magic + version
        0x01,0x06,0x01,0x60,0x01,0x7e,0x01,0x7e,       // type: (i64)->(i64)
        0x03,0x02,0x01,0x00,                           // func 0: type 0
        0x07,0x08,0x01,0x04,0x61,0x64,0x64,0x31,0x00,0x00, // export "add1" func 0
        0x0a,0x09,0x01,0x07,0x00,0x20,0x00,0x42,0x01,0x7c,0x0b, // local.get 0; i64.const 1; i64.add; end
    ];

    #[test]
    fn execute_add1_correct_and_meters() {
        // Sanity: the module passes the deploy validator (int-only) first.
        assert!(validate_wasm_module(ADD1_WASM, &VmLimits::default()).is_ok());
        let out = execute_metered_smoke(ADD1_WASM, "add1", 41, 1_000_000).unwrap();
        assert!(!out.trapped, "should not trap with ample fuel");
        assert_eq!(out.result, Some(42));
        assert!(out.fuel_consumed > 0, "execution must consume fuel");
    }

    #[test]
    fn execute_is_deterministic() {
        // Same (module, entry, arg) → identical fuel + result on every run. This is
        // the property the whole VM plan rests on (a divergent byte forks the chain).
        let a = execute_metered_smoke(ADD1_WASM, "add1", 7, 1_000_000).unwrap();
        let b = execute_metered_smoke(ADD1_WASM, "add1", 7, 1_000_000).unwrap();
        assert_eq!(a, b, "execution must be byte-deterministic");
        assert_eq!(a.result, Some(8));
    }

    #[test]
    fn execute_out_of_fuel_traps() {
        // Zero fuel → the first metered op traps deterministically (halting bound).
        let out = execute_metered_smoke(ADD1_WASM, "add1", 41, 0).unwrap();
        assert!(out.trapped, "zero fuel must trap");
        assert_eq!(out.result, None);
    }

    fn host() -> MemHost { MemHost::new(b"caller_addr".to_vec(), b"self_addr".to_vec(), 0, 100) }

    #[test]
    fn host_storage_write_and_log() {
        let wasm = wat::parse_str(r#"(module
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (import "env" "emit_log" (func $log (param i32 i32)))
            (memory (export "memory") 1 16)
            (data (i32.const 0) "keyval")
            (func (export "run")
                (call $sw (i32.const 0) (i32.const 3) (i32.const 3) (i32.const 3))
                (call $log (i32.const 0) (i32.const 6))))"#).unwrap();
        // Deploy-validate first, then dry-run.
        assert!(validate_wasm_module(&wasm, &VmLimits::default()).is_ok());
        let (out, h) = dry_run(&wasm, "run", host(), 1_000_000).unwrap();
        assert!(!out.trapped);
        assert_eq!(h.storage().get(&b"key".to_vec()).map(|v| v.as_slice()), Some(b"val".as_slice()));
        assert_eq!(h.logs, vec![b"keyval".to_vec()]);
        assert!(out.fuel_consumed > 0);
    }

    // Emit a log of `len` bytes from zero-initialized memory (2 pages = 128 KiB in-bounds).
    fn emit_len_wasm(len: usize) -> Vec<u8> {
        wat::parse_str(&format!(r#"(module
            (import "env" "emit_log" (func $log (param i32 i32)))
            (memory (export "memory") 2 16)
            (func (export "run") (call $log (i32.const 0) (i32.const {}))))"#, len)).unwrap()
    }

    #[test]
    fn emit_log_oversized_traps() {
        // A single event larger than the per-event cap must trap even with ample fuel — one
        // emit can never blow the frame (the hard half of the anti-DoS bound).
        let wasm = emit_len_wasm(MAX_LOG_DATA_BYTES + 1);
        let (out, h) = dry_run(&wasm, "run", host(), 100_000_000).unwrap();
        assert!(out.trapped, "over-cap log must trap regardless of fuel");
        assert!(h.logs.is_empty(), "a trapped over-cap emit persists no log");
    }

    #[test]
    fn emit_log_charges_fuel_per_byte() {
        // Log fuel scales with byte length, so total persisted log volume is paid for by gas
        // (the economic half of the bound). A tiny and a large in-cap log both succeed with
        // ample fuel, but the large one costs strictly more.
        let small = dry_run(&emit_len_wasm(8), "run", host(), 100_000_000).unwrap().0;
        let large = dry_run(&emit_len_wasm(8192), "run", host(), 100_000_000).unwrap().0;
        assert!(!small.trapped && !large.trapped, "in-cap logs succeed with ample fuel");
        assert!(large.fuel_consumed > small.fuel_consumed, "emit fuel scales with byte length");
        // A budget too small to pay for the log bytes traps → volume is gas-bounded.
        let starved = dry_run(&emit_len_wasm(8192), "run", host(), 500).unwrap().0;
        assert!(starved.trapped, "insufficient fuel for the log bytes must trap");
    }

    #[test]
    fn host_storage_read_roundtrip() {
        let wasm = wat::parse_str(r#"(module
            (import "env" "storage_read" (func $sr (param i32 i32 i32 i32) (result i32)))
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (memory (export "memory") 1 16)
            (data (i32.const 0) "srcdst")
            (func (export "run") (local $n i32)
                (local.set $n (call $sr (i32.const 0) (i32.const 3) (i32.const 64) (i32.const 32)))
                (call $sw (i32.const 3) (i32.const 3) (i32.const 64) (local.get $n))))"#).unwrap();
        let mut h0 = host();
        h0.seed(b"src", b"DATA");
        let (out, h) = dry_run(&wasm, "run", h0, 1_000_000).unwrap();
        assert!(!out.trapped);
        // Contract read src="DATA" (len 4 returned) and wrote dst <- those 4 bytes.
        assert_eq!(h.storage().get(&b"dst".to_vec()).map(|v| v.as_slice()), Some(b"DATA".as_slice()));
    }

    #[test]
    fn host_revert_traps() {
        let wasm = wat::parse_str(r#"(module
            (import "env" "revert" (func $rev (param i32 i32)))
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (memory (export "memory") 1 16)
            (data (i32.const 0) "keyvalnope")
            (func (export "run")
                (call $sw (i32.const 0) (i32.const 3) (i32.const 3) (i32.const 3))
                (call $rev (i32.const 6) (i32.const 4))))"#).unwrap();
        let (out, _h) = dry_run(&wasm, "run", host(), 1_000_000).unwrap();
        assert!(out.trapped, "revert() must trap; caller discards the host overlay");
    }

    #[test]
    fn dry_run_is_deterministic() {
        let wasm = wat::parse_str(r#"(module
            (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
            (memory (export "memory") 1 16)
            (data (i32.const 0) "keyval")
            (func (export "run")
                (call $sw (i32.const 0) (i32.const 3) (i32.const 3) (i32.const 3))))"#).unwrap();
        let (a, ha) = dry_run(&wasm, "run", host(), 1_000_000).unwrap();
        let (b, hb) = dry_run(&wasm, "run", host(), 1_000_000).unwrap();
        assert_eq!(a, b, "identical fuel + trap outcome across runs");
        assert_eq!(ha.storage(), hb.storage(), "identical resulting storage across runs");
    }
}

#[cfg(test)]
mod p5_cross_contract_tests {
    use super::*;
    use std::collections::HashMap;
    use std::rc::Rc;

    /// Address→code / address→storage map. `default_code` (if set) answers ANY address
    /// not in `codes` — used by the depth-chain test where every derived addr shares code.
    struct MapResolver {
        codes: HashMap<Vec<u8>, Vec<u8>>,
        stores: HashMap<Vec<u8>, BTreeMap<Vec<u8>, Vec<u8>>>,
        default_code: Option<Vec<u8>>,
    }
    impl MapResolver {
        fn new() -> Self { Self { codes: HashMap::new(), stores: HashMap::new(), default_code: None } }
        fn with(mut self, addr: &[u8], wat: &str) -> Self {
            self.codes.insert(addr.to_vec(), wat::parse_str(wat).unwrap());
            self
        }
    }
    impl ContractResolver for MapResolver {
        fn code(&self, a: &[u8]) -> Option<Vec<u8>> {
            self.codes.get(a).cloned().or_else(|| self.default_code.clone())
        }
        fn storage(&self, a: &[u8]) -> BTreeMap<Vec<u8>, Vec<u8>> {
            self.stores.get(a).cloned().unwrap_or_default()
        }
    }

    fn run(r: MapResolver, entry: &[u8]) -> CallTreeOutcome {
        execute_call_tree(Rc::new(r), entry, "run", b"tester", 0, 42, Vec::new(), 5_000_000)
    }
    fn get<'a>(o: &'a CallTreeOutcome, addr: &[u8], key: &[u8]) -> Option<&'a Vec<u8>> {
        o.writes.get(addr).and_then(|m| m.get(key))
    }

    // Callee B: writes bk=bv, emits "Blog", returns "BR".
    const B_OK: &str = r#"(module
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (import "env" "emit_log" (func $log (param i32 i32)))
        (import "env" "set_return" (func $ret (param i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "bkbvBlogBR")
        (func (export "run")
            (call $sw (i32.const 0)(i32.const 2)(i32.const 2)(i32.const 2))
            (call $log (i32.const 4)(i32.const 4))
            (call $ret (i32.const 8)(i32.const 2))))"#;

    // Caller A: log "Alog1"; call B; write ak=<B return>; log "Alog2"; return "AR".
    const A_CALLS_B: &str = r#"(module
        (import "env" "emit_log" (func $log (param i32 i32)))
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (import "env" "set_return" (func $ret (param i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "Alog1Brunak")
        (data (i32.const 16) "Alog2AR")
        (func (export "run") (local $n i32)
            (call $log (i32.const 0)(i32.const 5))
            (local.set $n (call $call
                (i32.const 5)(i32.const 1) (i32.const 6)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (call $sw (i32.const 9)(i32.const 2)(i32.const 64)(local.get $n))
            (call $log (i32.const 16)(i32.const 5))
            (call $ret (i32.const 21)(i32.const 2))))"#;

    #[test]
    fn cross_call_commits_child_writes_and_bubbles_logs_and_return() {
        let r = MapResolver::new().with(b"A", A_CALLS_B).with(b"B", B_OK);
        let o = run(r, b"A");
        assert!(!o.trapped);
        assert_eq!(get(&o, b"A", b"ak").map(|v| v.as_slice()), Some(b"BR".as_slice()), "A stored B's return");
        assert_eq!(get(&o, b"B", b"bk").map(|v| v.as_slice()), Some(b"bv".as_slice()), "B's write committed");
        assert_eq!(o.ret, b"AR".to_vec(), "entry return surfaced");
        // DFS emit order: A before the call, B during, A after.
        let logs: Vec<(&[u8], &[u8])> = o.logs.iter().map(|(a, d)| (a.as_slice(), d.as_slice())).collect();
        assert_eq!(logs, vec![
            (b"A".as_slice(), b"Alog1".as_slice()),
            (b"B".as_slice(), b"Blog".as_slice()),
            (b"A".as_slice(), b"Alog2".as_slice()),
        ]);
    }

    // Callee that writes then reverts (its write + log must be dropped).
    const B_REVERT: &str = r#"(module
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (import "env" "emit_log" (func $log (param i32 i32)))
        (import "env" "revert" (func $rev (param i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "bkbvBADLOG")
        (func (export "run")
            (call $sw (i32.const 0)(i32.const 2)(i32.const 2)(i32.const 2))
            (call $log (i32.const 4)(i32.const 6))
            (call $rev (i32.const 4)(i32.const 3))))"#;

    // Caller that calls B, IGNORES the error code, writes its own ok=v, succeeds.
    const A_CATCHES: &str = r#"(module
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "Brunokv")
        (func (export "run") (local $n i32)
            (local.set $n (call $call
                (i32.const 0)(i32.const 1) (i32.const 1)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (call $sw (i32.const 4)(i32.const 2)(i32.const 6)(i32.const 1))))"#;

    #[test]
    fn child_trap_reverts_only_child_caller_continues() {
        let r = MapResolver::new().with(b"A", A_CATCHES).with(b"B", B_REVERT);
        let o = run(r, b"A");
        assert!(!o.trapped, "the caller survives a callee trap");
        assert_eq!(get(&o, b"A", b"ok").map(|v| v.as_slice()), Some(b"v".as_slice()), "caller's own write commits");
        assert!(o.writes.get(b"B".as_slice()).is_none(), "reverted callee commits NOTHING");
        assert!(o.logs.is_empty(), "reverted callee's log is dropped");
    }

    // Self-calling contract: writes r2=y ONLY if the self-call returns the reentrancy code.
    const A_REENTER: &str = r#"(module
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "Arunr2y")
        (func (export "run") (local $n i32)
            (local.set $n (call $call
                (i32.const 0)(i32.const 1) (i32.const 1)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (if (i32.eq (local.get $n) (i32.const -2))
                (then (call $sw (i32.const 4)(i32.const 2)(i32.const 6)(i32.const 1))))))"#;

    #[test]
    fn reentrancy_into_on_stack_contract_is_rejected() {
        let r = MapResolver::new().with(b"A", A_REENTER);
        let o = run(r, b"A");
        assert!(!o.trapped);
        assert_eq!(get(&o, b"A", b"r2").map(|v| v.as_slice()), Some(b"y".as_slice()),
                   "self-call returned CALL_ERR_DEPTH_OR_REENTRANT (-2)");
    }

    // Chain contract: derives next = my_addr_byte + 1 and calls it; on the -2 depth code
    // it writes cap=y. Distinct addresses each hop ⇒ isolates the depth cap from reentrancy.
    const CHAIN: &str = r#"(module
        (import "env" "get_contract" (func $self (param i32 i32)(result i32)))
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1)
        (data (i32.const 8) "runcapy")
        (func (export "run") (local $n i32)
            (drop (call $self (i32.const 0)(i32.const 1)))
            (i32.store8 (i32.const 0) (i32.add (i32.load8_u (i32.const 0)) (i32.const 1)))
            (local.set $n (call $call
                (i32.const 0)(i32.const 1) (i32.const 8)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (if (i32.eq (local.get $n) (i32.const -2))
                (then (call $sw (i32.const 11)(i32.const 3)(i32.const 14)(i32.const 1))))))"#;

    #[test]
    fn call_depth_is_capped() {
        let mut r = MapResolver::new();
        r.default_code = Some(wat::parse_str(CHAIN).unwrap());
        let o = run(r, b"0");
        assert!(!o.trapped);
        // stack starts ["0"]; each hop pushes one distinct addr; the frame whose call would
        // exceed MAX_CALL_DEPTH gets -2. With cap 8 that frame's own addr is "7".
        let deepest = [(b'0' + (MAX_CALL_DEPTH as u8) - 1)]; // "7"
        assert_eq!(get(&o, &deepest, b"cap").map(|v| v.as_slice()), Some(b"y".as_slice()),
                   "depth cap surfaced -2 at the boundary frame");
    }

    #[test]
    fn unknown_entry_contract_traps() {
        let r = MapResolver::new().with(b"A", A_CALLS_B).with(b"B", B_OK);
        let o = execute_call_tree(Rc::new(r), b"NOPE", "run", b"tester", 0, 1, Vec::new(), 1_000_000);
        assert!(o.trapped, "resolver returns no code for the entry ⇒ trap");
        assert!(o.writes.is_empty());
    }

    #[test]
    fn call_tree_is_deterministic() {
        let mk = || MapResolver::new().with(b"A", A_CALLS_B).with(b"B", B_OK);
        let a = run(mk(), b"A");
        let b = run(mk(), b"A");
        assert_eq!(a.trapped, b.trapped);
        assert_eq!(a.fuel_consumed, b.fuel_consumed, "fuel is deterministic across the whole tree");
        assert_eq!(a.writes, b.writes);
        assert_eq!(a.logs, b.logs);
        assert_eq!(a.ret, b.ret);
    }
}

//! In-process host for unit tests on non-wasm targets. It follows the node's rules for one call:
//! reads see the call's own writes first, and writes, events and the return value are kept only
//! when the call finishes without reverting. Fuel is not modelled.
//!
//! ```
//! use qnet_contract::{mock, storage};
//!
//! mock::reset();
//! let out = mock::call(b"", || storage::write(b"k", b"v"));
//! assert_eq!(out.reverted, None);
//! assert_eq!(mock::storage(b"k"), Some(b"v".to_vec()));
//! ```

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::Once;

/// Caller address of a fresh mock.
pub const CALLER: &str = "0123456789abcdef012eon3456789abcdef01bf737966";
/// Contract address of a fresh mock.
pub const CONTRACT: &str = "fedcba9876543210fedeoncba9876543210fe684572d5";

/// The node refuses more events than this in one transaction.
const MAX_EVENTS: usize = 512;

type CallHandler = Box<dyn FnMut(&[u8], &str, &[u8], i64) -> Result<Vec<u8>, i32>>;

struct Host {
    storage: BTreeMap<Vec<u8>, Vec<u8>>,
    overlay: BTreeMap<Vec<u8>, Vec<u8>>,
    caller: Vec<u8>,
    contract: Vec<u8>,
    height: u64,
    value: i64,
    args: Vec<u8>,
    ret: Vec<u8>,
    events: Vec<Vec<u8>>,
    on_call: Option<CallHandler>,
}

impl Host {
    fn new() -> Host {
        Host {
            storage: BTreeMap::new(),
            overlay: BTreeMap::new(),
            caller: CALLER.as_bytes().to_vec(),
            contract: CONTRACT.as_bytes().to_vec(),
            height: 1,
            value: 0,
            args: Vec::new(),
            ret: Vec::new(),
            events: Vec::new(),
            on_call: None,
        }
    }
}

thread_local! {
    static HOST: RefCell<Host> = RefCell::new(Host::new());
}

fn with<R>(f: impl FnOnce(&mut Host) -> R) -> R {
    HOST.with(|h| f(&mut h.borrow_mut()))
}

/// What one call left behind.
#[derive(Debug, Default)]
pub struct Outcome {
    /// The revert message (or the panic text) when the call failed.
    pub reverted: Option<String>,
    pub ret: Vec<u8>,
    pub events: Vec<Vec<u8>>,
    /// Keys the call wrote; empty when it failed.
    pub writes: BTreeMap<Vec<u8>, Vec<u8>>,
}

/// Unwind payload of a revert or a host trap.
struct Revert(String);

/// Starts over: empty storage, [`CALLER`], [`CONTRACT`], height 1, value 0, no call handler.
pub fn reset() {
    with(|h| *h = Host::new());
}

pub fn set_caller(addr: &[u8]) {
    with(|h| h.caller = addr.to_vec());
}

pub fn set_contract(addr: &[u8]) {
    with(|h| h.contract = addr.to_vec());
}

pub fn set_height(height: u64) {
    with(|h| h.height = height);
}

pub fn set_value(value: i64) {
    with(|h| h.value = value);
}

/// Puts a committed value, as if an earlier transaction wrote it.
pub fn set_storage(key: &[u8], value: &[u8]) {
    with(|h| {
        h.storage.insert(key.to_vec(), value.to_vec());
    });
}

/// A committed value.
pub fn storage(key: &[u8]) -> Option<Vec<u8>> {
    with(|h| h.storage.get(key).cloned())
}

/// Answers `call_contract`: `(address, entry, args, value)` to the callee's return bytes, or a
/// negative host code. Without a handler every call answers `-1`.
pub fn on_call(f: impl FnMut(&[u8], &str, &[u8], i64) -> Result<Vec<u8>, i32> + 'static) {
    with(|h| h.on_call = Some(Box::new(f)));
}

/// Runs `entry` as one call with `args` and commits its writes when it succeeds.
pub fn call(args: &[u8], entry: impl FnOnce()) -> Outcome {
    quiet_reverts();
    with(|h| {
        h.args = args.to_vec();
        h.ret.clear();
        h.events.clear();
        h.overlay.clear();
    });
    let result = panic::catch_unwind(AssertUnwindSafe(entry));
    with(|h| {
        let ret = std::mem::take(&mut h.ret);
        let events = std::mem::take(&mut h.events);
        let writes = std::mem::take(&mut h.overlay);
        match result {
            Ok(()) => {
                h.storage.extend(writes.clone());
                Outcome {
                    reverted: None,
                    ret,
                    events,
                    writes,
                }
            }
            Err(payload) => Outcome {
                reverted: Some(message(payload)),
                ..Outcome::default()
            },
        }
    })
}

fn message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(Revert(m)) = payload.downcast_ref::<Revert>() {
        m.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    }
}

/// Reverts are expected results, not test failures: keep them off stderr.
fn quiet_reverts() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if info.payload().downcast_ref::<Revert>().is_none() {
                previous(info)
            }
        }));
    });
}

/// Host functions with the same signatures as the wasm imports in `crate::sys`.
///
/// # Safety
///
/// Every pointer must be valid for its length, as the node requires of contract memory.
#[allow(clippy::missing_safety_doc)]
pub mod sys {
    use super::{with, Revert, MAX_EVENTS};
    use crate::MAX_EVENT_BYTES;

    /// Negative lengths read as empty, like on the node.
    unsafe fn input<'a>(ptr: *const u8, len: i32) -> &'a [u8] {
        if len <= 0 {
            &[]
        } else {
            std::slice::from_raw_parts(ptr, len as usize)
        }
    }

    /// Copies `min(len, cap)` bytes and returns the full length.
    unsafe fn output(data: &[u8], ptr: *mut u8, cap: i32) -> i32 {
        let n = data.len().min(cap.max(0) as usize);
        if n > 0 {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, n);
        }
        data.len() as i32
    }

    fn trap(msg: String) -> ! {
        std::panic::panic_any(Revert(msg))
    }

    pub unsafe fn storage_read(key_ptr: *const u8, key_len: i32, out_ptr: *mut u8, out_cap: i32) -> i32 {
        let key = input(key_ptr, key_len);
        match with(|h| h.overlay.get(key).or_else(|| h.storage.get(key)).cloned()) {
            None => -1,
            Some(v) => output(&v, out_ptr, out_cap),
        }
    }

    pub unsafe fn storage_write(key_ptr: *const u8, key_len: i32, val_ptr: *const u8, val_len: i32) {
        let (key, val) = (input(key_ptr, key_len).to_vec(), input(val_ptr, val_len).to_vec());
        with(|h| {
            h.overlay.insert(key, val);
        });
    }

    pub unsafe fn get_caller(out_ptr: *mut u8, out_cap: i32) -> i32 {
        output(&with(|h| h.caller.clone()), out_ptr, out_cap)
    }

    pub unsafe fn get_contract(out_ptr: *mut u8, out_cap: i32) -> i32 {
        output(&with(|h| h.contract.clone()), out_ptr, out_cap)
    }

    pub unsafe fn get_call_args(out_ptr: *mut u8, out_cap: i32) -> i32 {
        output(&with(|h| h.args.clone()), out_ptr, out_cap)
    }

    pub unsafe fn set_return(ptr: *const u8, len: i32) {
        let data = input(ptr, len).to_vec();
        with(|h| h.ret = data);
    }

    pub unsafe fn get_block_height() -> i64 {
        with(|h| h.height as i64)
    }

    pub unsafe fn get_value() -> i64 {
        with(|h| h.value)
    }

    pub unsafe fn emit_log(ptr: *const u8, len: i32) {
        let data = input(ptr, len).to_vec();
        if data.len() > MAX_EVENT_BYTES {
            trap("emit_log LogTooLarge".to_string())
        }
        let full = with(|h| {
            if h.events.len() >= MAX_EVENTS {
                return true;
            }
            h.events.push(data);
            false
        });
        if full {
            trap("emit_log TooManyLogs".to_string())
        }
    }

    pub unsafe fn revert(msg_ptr: *const u8, msg_len: i32) {
        trap(String::from_utf8_lossy(input(msg_ptr, msg_len)).into_owned())
    }

    #[allow(clippy::too_many_arguments)]
    pub unsafe fn call_contract(
        addr_ptr: *const u8,
        addr_len: i32,
        entry_ptr: *const u8,
        entry_len: i32,
        args_ptr: *const u8,
        args_len: i32,
        value: i64,
        ret_ptr: *mut u8,
        ret_cap: i32,
    ) -> i32 {
        let Ok(entry) = std::str::from_utf8(input(entry_ptr, entry_len)) else {
            return -1;
        };
        let (addr, args) = (input(addr_ptr, addr_len), input(args_ptr, args_len));
        // Take the handler out so it may use the mock itself.
        let Some(mut handler) = with(|h| h.on_call.take()) else {
            return -1;
        };
        let result = handler(addr, entry, args, value);
        with(|h| h.on_call = Some(handler));
        match result {
            Ok(ret) => output(&ret, ret_ptr, ret_cap),
            Err(code) => code,
        }
    }
}

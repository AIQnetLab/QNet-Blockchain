//! Test fixture for the tool's VM tests: between them the entries use all 11 host functions
//! through `qnet-contract`. Not a template.
#![cfg_attr(target_arch = "wasm32", no_std)]

use qnet_contract::{
    args, block_height, call, call_value, caller, emit, entry, revert, set_return, storage, this_contract, CallError,
};

entry! {
    /// Stores the caller, own address, height and value under `caller`, `self`, `height`, `value`.
    fn probe_context() {
        storage::write(b"caller", caller().as_bytes());
        storage::write(b"self", this_contract().as_bytes());
        storage::write(b"height", &block_height().to_le_bytes());
        storage::write(b"value", &call_value().to_le_bytes());
    }

    /// Returns and emits its arguments.
    fn probe_echo() {
        let mut buf = [0u8; 256];
        let data = args(&mut buf).rest();
        set_return(data);
        emit(data);
    }

    /// Storage round trips; reverts on any mismatch.
    fn probe_storage() {
        if storage::read(b"k", &mut []).is_some() {
            revert(b"k present")
        }
        storage::write(b"k", b"value");
        let mut two = [0u8; 2];
        if storage::read(b"k", &mut two) != Some(5) || &two != b"va" {
            revert(b"read mismatch")
        }
        storage::write(b"empty", b"");
        if storage::read(b"empty", &mut two) != Some(0) {
            revert(b"empty mismatch")
        }
        storage::write_decimal(b"n", 1234);
        if storage::read_decimal(b"n") != Some(1234) {
            revert(b"decimal mismatch")
        }
    }

    /// Always reverts with `stop`.
    fn probe_revert() {
        revert(b"stop")
    }

    /// Panics; the helper's panic handler turns that into a revert.
    fn probe_panic() {
        panic!("probe")
    }

    /// Args: target address, then an entry name. Calls it with args `ping` and value 7; stores the
    /// result code (`rc`, i32 little-endian) and the return bytes as far as 2 fit (`ret`).
    fn probe_call() {
        let mut buf = [0u8; 128];
        let mut a = args(&mut buf);
        let target = a.address();
        let entry = match core::str::from_utf8(a.rest()) {
            Ok(s) => s,
            Err(_) => revert(b"entry not utf-8"),
        };
        let mut ret = [0u8; 2];
        let rc: i32 = match call(&target, entry, b"ping", 7, &mut ret) {
            Ok(n) => {
                storage::write(b"ret", &ret[..n.min(ret.len())]);
                n as i32
            }
            Err(CallError::NotContract) => -1,
            Err(CallError::DepthOrReentrant) => -2,
            Err(CallError::Failed) => -3,
        };
        storage::write(b"rc", &rc.to_le_bytes());
    }
}

//! Raw host imports of module `env`, with the exact wasm signatures the node binds
//! (core/qnet-vm, `bind_frame_host`). Pointers and lengths are offsets and byte counts in the
//! contract's own memory. Functions with an out buffer copy `min(full, cap)` bytes and return
//! the full length. Prefer the safe wrappers in the crate root.
//!
//! On wasm32 these are the real imports; on other targets `crate::mock` serves them.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// `-1` when the key is absent, else the full value length.
    pub fn storage_read(key_ptr: *const u8, key_len: i32, out_ptr: *mut u8, out_cap: i32) -> i32;
    pub fn storage_write(key_ptr: *const u8, key_len: i32, val_ptr: *const u8, val_len: i32);
    pub fn get_caller(out_ptr: *mut u8, out_cap: i32) -> i32;
    pub fn get_contract(out_ptr: *mut u8, out_cap: i32) -> i32;
    pub fn get_call_args(out_ptr: *mut u8, out_cap: i32) -> i32;
    pub fn set_return(ptr: *const u8, len: i32);
    pub fn get_block_height() -> i64;
    pub fn get_value() -> i64;
    pub fn emit_log(ptr: *const u8, len: i32);
    /// Never returns: the call ends and its writes and events are dropped.
    pub fn revert(msg_ptr: *const u8, msg_len: i32);
    /// `>= 0` the callee's full return length; `-1` not a callable contract, `-2` depth limit or
    /// re-entry, `-3` the callee failed.
    pub fn call_contract(
        addr_ptr: *const u8,
        addr_len: i32,
        entry_ptr: *const u8,
        entry_len: i32,
        args_ptr: *const u8,
        args_len: i32,
        value: i64,
        ret_ptr: *mut u8,
        ret_cap: i32,
    ) -> i32;
}

#[cfg(not(target_arch = "wasm32"))]
pub use crate::mock::sys::*;

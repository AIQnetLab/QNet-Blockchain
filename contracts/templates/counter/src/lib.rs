//! Counter: the Rust form of `development/qnet-contracts/examples/counter.wat`, with the same
//! storage and events.
//!
//! - `run`: adds one to the counter.
//! - `reset`: sets it back to zero.
//!
//! Storage: key `count` holds the counter as 8 bytes little-endian.
//! Events: every call emits the new value (8 bytes little-endian) followed by the caller address.
#![cfg_attr(target_arch = "wasm32", no_std)]

use qnet_contract::{caller, emit, entry, revert, storage, Buf, ADDRESS_LEN};

const KEY: &[u8] = b"count";

entry! {
    /// Adds one to the counter.
    fn run() {
        match load().checked_add(1) {
            Some(next) => store_and_log(next),
            None => revert(b"overflow"),
        }
    }

    /// Sets the counter back to zero.
    fn reset() {
        store_and_log(0);
    }
}

fn load() -> u64 {
    let mut b = [0u8; 8];
    match storage::read(KEY, &mut b) {
        Some(8) => u64::from_le_bytes(b),
        _ => 0,
    }
}

fn store_and_log(value: u64) {
    let bytes = value.to_le_bytes();
    storage::write(KEY, &bytes);
    emit(
        Buf::<{ 8 + ADDRESS_LEN }>::new()
            .push(&bytes)
            .push(caller().as_bytes())
            .as_bytes(),
    );
}

#[cfg(test)]
mod tests {
    use qnet_contract::mock;

    fn event(value: u64) -> Vec<u8> {
        [&value.to_le_bytes()[..], mock::CALLER.as_bytes()].concat()
    }

    #[test]
    fn run_counts_up_from_zero() {
        mock::reset();
        for expected in 1..=3u64 {
            let out = mock::call(&[], super::run);
            assert_eq!(out.reverted, None);
            assert_eq!(out.events, vec![event(expected)]);
        }
        assert_eq!(mock::storage(b"count"), Some(3u64.to_le_bytes().to_vec()));
    }

    #[test]
    fn reset_writes_zero() {
        mock::reset();
        mock::set_storage(b"count", &41u64.to_le_bytes());
        let out = mock::call(&[], super::reset);
        assert_eq!(out.reverted, None);
        assert_eq!(out.events, vec![event(0)]);
        assert_eq!(mock::storage(b"count"), Some(0u64.to_le_bytes().to_vec()));
    }

    #[test]
    fn a_value_of_another_length_counts_as_zero() {
        mock::reset();
        mock::set_storage(b"count", b"abc");
        let out = mock::call(&[], super::run);
        assert_eq!(out.events, vec![event(1)]);
    }

    #[test]
    fn overflow_reverts_and_keeps_the_old_value() {
        mock::reset();
        mock::set_storage(b"count", &u64::MAX.to_le_bytes());
        let out = mock::call(&[], super::run);
        assert_eq!(out.reverted.as_deref(), Some("overflow"));
        assert_eq!(mock::storage(b"count"), Some(u64::MAX.to_le_bytes().to_vec()));
    }
}

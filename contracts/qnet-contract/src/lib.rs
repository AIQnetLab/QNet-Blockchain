//! Helpers for QNet WASM contracts.
//!
//! - [`entry!`] declares entry points: exported `() -> ()` functions that a call selects by its
//!   `method` name.
//! - Safe wrappers for the 11 host functions of module `env` ([`sys`] holds the raw imports).
//! - [`Args`] decodes call arguments, [`Buf`] builds keys and events, [`storage`] persists data.
//!
//! There is no allocator: everything works on fixed-size buffers. Memory and globals start fresh
//! on every call, so persistent state lives only in [`storage`].
#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod sys;

#[cfg(not(target_arch = "wasm32"))]
pub mod mock;

/// Byte length of an address.
pub const ADDRESS_LEN: usize = 45;

/// Largest event the node takes from [`emit`].
pub const MAX_EVENT_BYTES: usize = 16_384;

/// Declares entry points. Each `fn name() { ... }` is exported under `name`.
///
/// ```
/// qnet_contract::entry! {
///     /// Emits `hello`.
///     fn run() {
///         qnet_contract::emit(b"hello");
///     }
/// }
/// # let out = qnet_contract::mock::call(b"", run);
/// # assert_eq!(out.events, [b"hello".to_vec()]);
/// ```
#[macro_export]
macro_rules! entry {
    ($($(#[$meta:meta])* fn $name:ident() $body:block)+) => {
        $(
            $(#[$meta])*
            #[cfg(target_arch = "wasm32")]
            #[no_mangle]
            pub extern "C" fn $name() $body

            // Host builds (unit tests): a plain function, so a revert can unwind into the mock.
            $(#[$meta])*
            #[cfg(not(target_arch = "wasm32"))]
            pub fn $name() $body
        )+
    };
}

/// An address: 19 hex digits, `eon`, 15 hex digits and an 8-digit checksum, all lowercase ASCII. The
/// checksum is the first 8 hex digits of SHA3-256 over the first 37 characters, as the node checks it.
/// An address read from arguments or parsed from a constant is checked for both, so a mistyped digit
/// never names an account that no key controls.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Address([u8; ADDRESS_LEN]);

impl Address {
    /// `None` unless `bytes` has the shape of an address and its checksum holds.
    pub const fn from_bytes(bytes: &[u8]) -> Option<Address> {
        if !is_address(bytes) || !checksum_holds(bytes) {
            return None;
        }
        let mut a = [0u8; ADDRESS_LEN];
        let mut i = 0;
        while i < ADDRESS_LEN {
            a[i] = bytes[i];
            i += 1;
        }
        Some(Address(a))
    }

    /// For constants: a malformed `s`, or one whose checksum fails, fails the build.
    pub const fn parse(s: &str) -> Address {
        match Address::from_bytes(s.as_bytes()) {
            Some(a) => a,
            None => panic!("not an address (its form or its checksum is wrong)"),
        }
    }

    pub const fn as_bytes(&self) -> &[u8; ADDRESS_LEN] {
        &self.0
    }
}

impl core::fmt::Debug for Address {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(core::str::from_utf8(&self.0).unwrap_or("?"))
    }
}

const fn is_address(b: &[u8]) -> bool {
    if b.len() != ADDRESS_LEN {
        return false;
    }
    let mut i = 0;
    while i < ADDRESS_LEN {
        let c = b[i];
        let ok = match i {
            19 => c == b'e',
            20 => c == b'o',
            21 => c == b'n',
            _ => c.is_ascii_digit() || (c >= b'a' && c <= b'f'),
        };
        if !ok {
            return false;
        }
        i += 1;
    }
    true
}

/// The last 8 characters are the first 4 bytes of SHA3-256 over the first 37, in lowercase hex.
const fn checksum_holds(b: &[u8]) -> bool {
    let digest = sha3_256_block(b, 37);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut i = 0;
    while i < 4 {
        if b[37 + 2 * i] != HEX[(digest[i] >> 4) as usize] || b[38 + 2 * i] != HEX[(digest[i] & 0x0f) as usize] {
            return false;
        }
        i += 1;
    }
    true
}

/// SHA3-256 (FIPS 202) of `data[..len]`, `len` at most 135 bytes: one block of the sponge, enough for
/// an address. A const fn, so [`Address::parse`] checks a constant while the contract is built.
const fn sha3_256_block(data: &[u8], len: usize) -> [u8; 32] {
    const RATE: usize = 136;
    assert!(len < RATE && len <= data.len());
    // Lanes are little-endian; the padding is 0x06 after the data and 0x80 in the block's last byte.
    let mut state = [0u64; 25];
    let mut i = 0;
    while i < len {
        state[i / 8] ^= (data[i] as u64) << (8 * (i % 8));
        i += 1;
    }
    state[len / 8] ^= 0x06 << (8 * (len % 8));
    state[RATE / 8 - 1] ^= 0x80 << 56;
    let state = keccak_f1600(state);
    let mut out = [0u8; 32];
    let mut j = 0;
    while j < 32 {
        out[j] = (state[j / 8] >> (8 * (j % 8))) as u8;
        j += 1;
    }
    out
}

const KECCAK_RC: [u64; 24] = [
    0x0000_0000_0000_0001, 0x0000_0000_0000_8082, 0x8000_0000_0000_808a, 0x8000_0000_8000_8000,
    0x0000_0000_0000_808b, 0x0000_0000_8000_0001, 0x8000_0000_8000_8081, 0x8000_0000_0000_8009,
    0x0000_0000_0000_008a, 0x0000_0000_0000_0088, 0x0000_0000_8000_8009, 0x0000_0000_8000_000a,
    0x0000_0000_8000_808b, 0x8000_0000_0000_008b, 0x8000_0000_0000_8089, 0x8000_0000_0000_8003,
    0x8000_0000_0000_8002, 0x8000_0000_0000_0080, 0x0000_0000_0000_800a, 0x8000_0000_8000_000a,
    0x8000_0000_8000_8081, 0x8000_0000_0000_8080, 0x0000_0000_8000_0001, 0x8000_0000_8000_8008,
];
/// Theta's column parity added to one row of five lanes.
macro_rules! theta_row {
    ($s:ident, $d:ident, $y:literal) => {
        $s[$y] ^= $d[0];
        $s[$y + 1] ^= $d[1];
        $s[$y + 2] ^= $d[2];
        $s[$y + 3] ^= $d[3];
        $s[$y + 4] ^= $d[4];
    };
}

/// Rho and pi: along the walk from lane 1, each `lane rotation` pair takes the lane before it, rotated.
macro_rules! rho_pi {
    ($s:ident, $($lane:literal $rot:literal),+) => {{
        let mut carried = $s[1];
        $(
            let next = $s[$lane];
            $s[$lane] = carried.rotate_left($rot);
            carried = next;
        )+
        let _ = carried;
    }};
}

/// Chi on one row of five lanes.
macro_rules! chi_row {
    ($s:ident, $y:literal) => {{
        let r = [$s[$y], $s[$y + 1], $s[$y + 2], $s[$y + 3], $s[$y + 4]];
        $s[$y] = r[0] ^ (!r[1] & r[2]);
        $s[$y + 1] = r[1] ^ (!r[2] & r[3]);
        $s[$y + 2] = r[2] ^ (!r[3] & r[4]);
        $s[$y + 3] = r[3] ^ (!r[4] & r[0]);
        $s[$y + 4] = r[4] ^ (!r[0] & r[1]);
    }};
}

/// Keccak-f[1600], unrolled within a round so that every lane index is a constant: a contract pays fuel for
/// each instruction, and a checked address costs one permutation.
const fn keccak_f1600(mut s: [u64; 25]) -> [u64; 25] {
    let mut round = 0;
    while round < 24 {
        let c = [
            s[0] ^ s[5] ^ s[10] ^ s[15] ^ s[20],
            s[1] ^ s[6] ^ s[11] ^ s[16] ^ s[21],
            s[2] ^ s[7] ^ s[12] ^ s[17] ^ s[22],
            s[3] ^ s[8] ^ s[13] ^ s[18] ^ s[23],
            s[4] ^ s[9] ^ s[14] ^ s[19] ^ s[24],
        ];
        let d = [
            c[4] ^ c[1].rotate_left(1),
            c[0] ^ c[2].rotate_left(1),
            c[1] ^ c[3].rotate_left(1),
            c[2] ^ c[4].rotate_left(1),
            c[3] ^ c[0].rotate_left(1),
        ];
        theta_row!(s, d, 0);
        theta_row!(s, d, 5);
        theta_row!(s, d, 10);
        theta_row!(s, d, 15);
        theta_row!(s, d, 20);
        rho_pi!(s, 10 1, 7 3, 11 6, 17 10, 18 15, 3 21, 5 28, 16 36, 8 45, 21 55, 24 2, 4 14, 15 27, 23 41, 19 56,
            13 8, 12 25, 2 43, 20 62, 14 18, 22 39, 9 61, 6 20, 1 44);
        chi_row!(s, 0);
        chi_row!(s, 5);
        chi_row!(s, 10);
        chi_row!(s, 15);
        chi_row!(s, 20);
        s[0] ^= KECCAK_RC[round];
        round += 1;
    }
    s
}

/// The account that made this call: the transaction sender, or the calling contract.
pub fn caller() -> Address {
    let mut b = [0u8; ADDRESS_LEN];
    let n = unsafe { sys::get_caller(b.as_mut_ptr(), ADDRESS_LEN as i32) };
    host_address(n, b, b"bad caller")
}

/// This contract's own address.
pub fn this_contract() -> Address {
    let mut b = [0u8; ADDRESS_LEN];
    let n = unsafe { sys::get_contract(b.as_mut_ptr(), ADDRESS_LEN as i32) };
    host_address(n, b, b"bad contract address")
}

/// The host hands out well-formed addresses, so only the length is checked (it saves fuel).
fn host_address(n: i32, b: [u8; ADDRESS_LEN], msg: &[u8]) -> Address {
    if n != ADDRESS_LEN as i32 {
        revert(msg)
    }
    Address(b)
}

/// Height of the block being applied: the only clock a contract has.
pub fn block_height() -> u64 {
    unsafe { sys::get_block_height() as u64 }
}

/// The `value` a calling contract passed to [`call`]; 0 for a transaction. Informational only:
/// no QNC moves with a call.
pub fn call_value() -> i64 {
    unsafe { sys::get_value() }
}

/// Reads this call's arguments into `buf`. Reverts with `args too long` when they do not fit.
pub fn args(buf: &mut [u8]) -> Args<'_> {
    let n = unsafe { sys::get_call_args(buf.as_mut_ptr(), buf.len() as i32) };
    if n < 0 || n as usize > buf.len() {
        revert(b"args too long")
    }
    Args::new(&buf[..n as usize])
}

/// Decodes fixed-layout arguments front to back: an address is its 45 ASCII bytes, a number
/// 8 bytes little-endian. Running short reverts with `args too short`.
pub struct Args<'a> {
    rest: &'a [u8],
}

impl<'a> Args<'a> {
    pub fn new(bytes: &'a [u8]) -> Args<'a> {
        Args { rest: bytes }
    }

    /// The next `n` bytes.
    pub fn bytes(&mut self, n: usize) -> &'a [u8] {
        if self.rest.len() < n {
            revert(b"args too short")
        }
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        head
    }

    /// The next 8 bytes as a little-endian u64.
    pub fn u64(&mut self) -> u64 {
        let mut a = [0u8; 8];
        a.copy_from_slice(self.bytes(8));
        u64::from_le_bytes(a)
    }

    /// The next 45 bytes as an address; reverts with `bad address` when malformed or when its checksum
    /// fails (a mistyped recipient is refused, never credited).
    pub fn address(&mut self) -> Address {
        match Address::from_bytes(self.bytes(ADDRESS_LEN)) {
            Some(a) => a,
            None => revert(b"bad address"),
        }
    }

    /// Everything not read yet.
    pub fn rest(&mut self) -> &'a [u8] {
        core::mem::take(&mut self.rest)
    }

    pub fn len(&self) -> usize {
        self.rest.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    /// Reverts with `too many args` when bytes are left over.
    pub fn end(self) {
        if !self.rest.is_empty() {
            revert(b"too many args")
        }
    }
}

/// Sets the bytes a calling contract receives from this call.
pub fn set_return(data: &[u8]) {
    unsafe { sys::set_return(data.as_ptr(), data.len() as i32) }
}

/// Appends an event (at most [`MAX_EVENT_BYTES`]). Events are kept only when the call succeeds.
pub fn emit(data: &[u8]) {
    unsafe { sys::emit_log(data.as_ptr(), data.len() as i32) }
}

/// Ends the call with an error. A transaction whose entry call reverts changes no storage and
/// keeps no events.
pub fn revert(msg: &[u8]) -> ! {
    unsafe { sys::revert(msg.as_ptr(), msg.len() as i32) };
    halt()
}

#[cfg(target_arch = "wasm32")]
fn halt() -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(not(target_arch = "wasm32"))]
fn halt() -> ! {
    unreachable!("the host returned from revert")
}

/// Why a [`call`] failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallError {
    /// Not a WASM contract, not in the transaction's access list, or the entry name is not UTF-8.
    NotContract,
    /// Eight contracts are already on the call stack, or the target is one of them.
    DepthOrReentrant,
    /// The callee failed.
    Failed,
}

/// Calls `entry` on another contract with `args`. The callee's return bytes are copied into
/// `ret` (as many as fit) and their full length is returned. The target must be listed in the
/// transaction's access list. `value` is informational: no QNC moves.
pub fn call(contract: &Address, entry: &str, args: &[u8], value: i64, ret: &mut [u8]) -> Result<usize, CallError> {
    let rc = unsafe {
        sys::call_contract(
            contract.0.as_ptr(),
            ADDRESS_LEN as i32,
            entry.as_ptr(),
            entry.len() as i32,
            args.as_ptr(),
            args.len() as i32,
            value,
            ret.as_mut_ptr(),
            ret.len() as i32,
        )
    };
    match rc {
        n if n >= 0 => Ok(n as usize),
        -1 => Err(CallError::NotContract),
        -2 => Err(CallError::DepthOrReentrant),
        _ => Err(CallError::Failed),
    }
}

/// This contract's storage. Keys and values are any bytes. There is no delete (an empty value
/// stays present) and no way to list keys, so choose keys a reader can rebuild.
pub mod storage {
    use crate::{format_decimal, parse_decimal, revert, sys};

    /// `None` when absent; otherwise the full value length, with as many bytes as fit copied
    /// into `out`.
    pub fn read(key: &[u8], out: &mut [u8]) -> Option<usize> {
        let n = unsafe { sys::storage_read(key.as_ptr(), key.len() as i32, out.as_mut_ptr(), out.len() as i32) };
        if n < 0 {
            None
        } else {
            Some(n as usize)
        }
    }

    pub fn write(key: &[u8], value: &[u8]) {
        unsafe { sys::storage_write(key.as_ptr(), key.len() as i32, value.as_ptr(), value.len() as i32) }
    }

    /// A number stored by [`write_decimal`]; `None` when absent. Reverts with `bad number` when
    /// the value is not canonical decimal text.
    pub fn read_decimal(key: &[u8]) -> Option<u64> {
        let mut b = [0u8; 20];
        let n = read(key, &mut b)?;
        match b.get(..n).and_then(parse_decimal) {
            Some(v) => Some(v),
            None => revert(b"bad number"),
        }
    }

    /// Stores `v` as decimal ASCII, so off-chain readers see plain text.
    pub fn write_decimal(key: &[u8], v: u64) {
        let mut b = [0u8; 20];
        write(key, format_decimal(v, &mut b));
    }
}

/// Writes `v` in decimal into `out` and returns the digits.
pub fn format_decimal(mut v: u64, out: &mut [u8; 20]) -> &[u8] {
    let mut i = out.len();
    loop {
        i -= 1;
        out[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            return &out[i..];
        }
    }
}

/// Parses canonical decimal: digits only, no leading zero except `0` itself. `None` otherwise or
/// on overflow.
pub fn parse_decimal(s: &[u8]) -> Option<u64> {
    if s.is_empty() || (s.len() > 1 && s[0] == b'0') {
        return None;
    }
    let mut v: u64 = 0;
    for &c in s {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((c - b'0') as u64)?;
    }
    Some(v)
}

/// A fixed-capacity byte buffer for keys and events. Overflowing it reverts with `buffer full`.
pub struct Buf<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    pub const fn new() -> Self {
        Buf { bytes: [0; N], len: 0 }
    }

    pub fn push(&mut self, data: &[u8]) -> &mut Self {
        let end = self.len + data.len();
        if end > N {
            revert(b"buffer full")
        }
        self.bytes[self.len..end].copy_from_slice(data);
        self.len = end;
        self
    }

    pub fn push_decimal(&mut self, v: u64) -> &mut Self {
        let mut d = [0u8; 20];
        self.push(format_decimal(v, &mut d))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(target_arch = "wasm32", feature = "panic-handler"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    revert(b"panic")
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = mock::CALLER;
    const B: &str = mock::CONTRACT;

    fn reverted(o: &mock::Outcome) -> Option<&str> {
        o.reverted.as_deref()
    }

    #[test]
    fn address_shape() {
        assert_eq!(A.len(), ADDRESS_LEN);
        assert!(Address::from_bytes(A.as_bytes()).is_some());
        assert!(Address::from_bytes(B.as_bytes()).is_some());
        assert_eq!(Address::parse(A).as_bytes(), A.as_bytes());
        assert!(Address::from_bytes(&A.as_bytes()[..44]).is_none());
        assert!(Address::from_bytes(A.to_uppercase().as_bytes()).is_none());
        assert!(Address::from_bytes(A.replace("eon", "eom").as_bytes()).is_none());
        assert!(Address::from_bytes(A.replacen('0', "g", 1).as_bytes()).is_none());
        assert!(Address::from_bytes(A.replacen('0', ":", 1).as_bytes()).is_none());
    }

    /// The wallet of the known-answer phrase, and the canonical burn address (an all-zero body).
    const GOLDEN: &str = "d9fa370374e24333242eon847d1d354dcd87fe873823e";
    const BURN: &str = "0000000000000000000eon00000000000000036877022";

    #[test]
    fn sha3_256_known_answers() {
        let hex = |d: [u8; 32]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(hex(sha3_256_block(b"", 0)), "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
        assert_eq!(hex(sha3_256_block(b"abc", 3)), "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
        // The longest input one block takes: the padding bits 0x06 and 0x80 share the last byte.
        assert_eq!(
            hex(sha3_256_block(&[b'a'; 135], 135)),
            "8094bb53c44cfb1e67b7c30447f9a1c33696d2463ecc1d9c92538913392843c9"
        );
    }

    // DEV-R2-06: a recipient with one digit wrong keeps the shape of an address; its checksum refuses it.
    #[test]
    fn address_checksum() {
        for good in [GOLDEN, BURN, A, B] {
            assert!(Address::from_bytes(good.as_bytes()).is_some(), "{good}");
        }
        for i in (0..ADDRESS_LEN).filter(|i| !(19..22).contains(i)) {
            let mut typo = GOLDEN.as_bytes().to_vec();
            typo[i] = if typo[i] == b'0' { b'1' } else { b'0' };
            assert!(Address::from_bytes(&typo).is_none(), "{}", String::from_utf8_lossy(&typo));
        }
        const PARSED: Address = Address::parse(GOLDEN);
        assert_eq!(PARSED.as_bytes(), GOLDEN.as_bytes());
        // The shape alone, with a zero checksum, as a hand-made test address would have it.
        assert!(Address::from_bytes(format!("{}00000000", &GOLDEN[..37]).as_bytes()).is_none());
    }

    #[test]
    fn a_mistyped_address_argument_reverts() {
        mock::reset();
        let mut typo = GOLDEN.as_bytes().to_vec();
        typo[10] = if typo[10] == b'0' { b'1' } else { b'0' };
        let o = mock::call(&typo, || {
            let mut buf = [0u8; ADDRESS_LEN];
            args(&mut buf).address();
        });
        assert_eq!(reverted(&o), Some("bad address"));
        let ok = mock::call(GOLDEN.as_bytes(), || {
            let mut buf = [0u8; ADDRESS_LEN];
            assert_eq!(args(&mut buf).address(), Address::parse(GOLDEN));
        });
        assert_eq!(reverted(&ok), None);
    }

    #[test]
    fn decimal_round_trip_and_strictness() {
        let mut b = [0u8; 20];
        for v in [0, 1, 9, 10, 1234, u64::MAX] {
            let s = format_decimal(v, &mut b).to_vec();
            assert_eq!(s, v.to_string().as_bytes());
            assert_eq!(parse_decimal(&s), Some(v));
        }
        for bad in ["", "01", "+1", "-1", "1a", " 1", "18446744073709551616"] {
            assert_eq!(parse_decimal(bad.as_bytes()), None, "{bad:?}");
        }
    }

    #[test]
    fn buf_builds_and_reverts_when_full() {
        let mut k = Buf::<16>::new();
        k.push(b"bal:").push_decimal(42);
        assert_eq!(k.as_bytes(), b"bal:42");
        mock::reset();
        let o = mock::call(&[], || {
            Buf::<4>::new().push(b"abc").push(b"de");
        });
        assert_eq!(reverted(&o), Some("buffer full"));
    }

    #[test]
    fn args_decode_in_order() {
        mock::reset();
        let mut input = A.as_bytes().to_vec();
        input.extend_from_slice(&7u64.to_le_bytes());
        input.extend_from_slice(b"tail");
        let o = mock::call(&input, || {
            let mut buf = [0u8; 64];
            let mut a = args(&mut buf);
            assert_eq!(a.len(), 57);
            assert_eq!(a.address(), Address::parse(A));
            assert_eq!(a.u64(), 7);
            assert_eq!(a.rest(), b"tail");
            assert!(a.is_empty());
            a.end();
        });
        assert_eq!(reverted(&o), None);
    }

    #[test]
    fn args_errors_revert() {
        mock::reset();
        let short = mock::call(&[1, 2, 3], || {
            let mut buf = [0u8; 8];
            args(&mut buf).u64();
        });
        assert_eq!(reverted(&short), Some("args too short"));
        let long = mock::call(&[0; 9], || {
            let mut buf = [0u8; 8];
            args(&mut buf);
        });
        assert_eq!(reverted(&long), Some("args too long"));
        let extra = mock::call(&[0; 9], || {
            let mut buf = [0u8; 16];
            let mut a = args(&mut buf);
            a.u64();
            a.end();
        });
        assert_eq!(reverted(&extra), Some("too many args"));
        let bad = mock::call(&[b'x'; ADDRESS_LEN], || {
            let mut buf = [0u8; ADDRESS_LEN];
            args(&mut buf).address();
        });
        assert_eq!(reverted(&bad), Some("bad address"));
    }

    #[test]
    fn storage_reads_copy_what_fits_and_report_the_full_length() {
        mock::reset();
        let o = mock::call(&[], || {
            assert_eq!(storage::read(b"k", &mut []), None);
            storage::write(b"k", b"value");
            let mut two = [0u8; 2];
            assert_eq!(storage::read(b"k", &mut two), Some(5));
            assert_eq!(&two, b"va");
            storage::write(b"empty", b"");
            assert_eq!(storage::read(b"empty", &mut two), Some(0));
            storage::write_decimal(b"n", 1234);
            assert_eq!(storage::read_decimal(b"n"), Some(1234));
            assert_eq!(storage::read_decimal(b"none"), None);
        });
        assert_eq!(reverted(&o), None);
        assert_eq!(mock::storage(b"k").as_deref(), Some(&b"value"[..]));
        assert_eq!(mock::storage(b"n").as_deref(), Some(&b"1234"[..]));
    }

    #[test]
    fn a_non_decimal_value_reverts_when_read_as_a_number() {
        mock::reset();
        mock::set_storage(b"n", &[1, 0, 0, 0, 0, 0, 0, 0]);
        let o = mock::call(&[], || {
            storage::read_decimal(b"n");
        });
        assert_eq!(reverted(&o), Some("bad number"));
    }

    #[test]
    fn a_revert_keeps_no_writes_or_events() {
        mock::reset();
        let o = mock::call(&[], || {
            storage::write(b"k", b"v");
            emit(b"event");
            set_return(b"r");
            revert(b"stop");
        });
        assert_eq!(reverted(&o), Some("stop"));
        assert!(o.writes.is_empty() && o.events.is_empty() && o.ret.is_empty());
        assert_eq!(mock::storage(b"k"), None);
    }

    #[test]
    fn context_comes_from_the_host() {
        mock::reset();
        mock::set_height(99);
        mock::set_value(5);
        let o = mock::call(&[], || {
            assert_eq!(caller(), Address::parse(A));
            assert_eq!(this_contract(), Address::parse(B));
            assert_eq!(block_height(), 99);
            assert_eq!(call_value(), 5);
            emit(b"e1");
            set_return(b"r1");
        });
        assert_eq!(reverted(&o), None);
        assert_eq!(o.events, vec![b"e1".to_vec()]);
        assert_eq!(o.ret, b"r1");

        mock::set_caller(b"not an address");
        let bad = mock::call(&[], || {
            caller();
        });
        assert_eq!(reverted(&bad), Some("bad caller"));
    }

    #[test]
    fn oversized_event_fails_the_call() {
        mock::reset();
        let o = mock::call(&[], || emit(&[0u8; MAX_EVENT_BYTES + 1]));
        assert!(o.reverted.is_some());
        let ok = mock::call(&[], || emit(&[0u8; MAX_EVENT_BYTES]));
        assert_eq!(reverted(&ok), None);
    }

    #[test]
    fn call_maps_host_results() {
        mock::reset();
        mock::on_call(|addr, entry, args, value| {
            assert_eq!(addr, B.as_bytes());
            assert_eq!(value, 3);
            match entry {
                "echo" => Ok(args.to_vec()),
                "missing" => Err(-1),
                "busy" => Err(-2),
                _ => Err(-3),
            }
        });
        let o = mock::call(&[], || {
            let target = Address::parse(B);
            let mut ret = [0u8; 2];
            assert_eq!(call(&target, "echo", b"ping", 3, &mut ret), Ok(4));
            assert_eq!(&ret, b"pi");
            assert_eq!(call(&target, "missing", b"", 3, &mut ret), Err(CallError::NotContract));
            assert_eq!(
                call(&target, "busy", b"", 3, &mut ret),
                Err(CallError::DepthOrReentrant)
            );
            assert_eq!(call(&target, "fails", b"", 3, &mut ret), Err(CallError::Failed));
        });
        assert_eq!(reverted(&o), None);
    }
}

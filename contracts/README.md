# QNet contracts

Rust sources for WebAssembly contracts on QNet, and a tool that checks every module against the
node's own deploy rules. This is a Cargo workspace of its own, separate from the node workspace
at the repository root; its only link to the node is a path dependency on `core/qnet-vm`.

| Folder | What it is |
| --- | --- |
| `qnet-contract/` | Helper crate (`no_std`, no allocator): bindings for the 11 host functions, `entry!`, argument decoding, fixed-size buffers, storage helpers, a panic handler that reverts, and a host mock for unit tests. |
| `templates/counter/` | Minimal contract: the Rust form of [`development/qnet-contracts/examples/counter.wat`](../development/qnet-contracts/examples/counter.wat), with the same storage and events. |
| `templates/game-items/` | Numbered game items: owner mint, transfer, balances, text storage keys and text events. |
| `tool/` | `qnet-contract-tool`: builds the templates and checks modules. `tool/tests/vm.rs` runs them in the node's VM; `tool/abi-probe/` is a test fixture, not a template. |

## Requirements

- Rust with the wasm32 target: `rustup target add wasm32-unknown-unknown`. Built and tested with
  rustc 1.93.1; another compiler version may need other flags, which the check below would show.
- Run every command from `contracts/`. The build flags live in `contracts/.cargo/config.toml`
  and apply only there. A `RUSTFLAGS` variable in the environment replaces them, so keep it unset.

## Build and check

```
cargo build-contracts                     # every template
cargo build-contracts game-items          # one template
cargo check-contract path/to/module.wasm  # any module built elsewhere
```

`game-items` reads its owner address at build time:

```
GAME_ITEMS_OWNER=<address> cargo build-contracts game-items          # POSIX shell
$env:GAME_ITEMS_OWNER = "<address>"; cargo build-contracts game-items  # PowerShell
```

A template declares such variables in `[package.metadata.qnet.env]`; one declared with `kind = "address"`
must be a valid QNet address, its SHA3-256 checksum included, or `cargo build-contracts` builds nothing. A
contract's code can never be replaced after deploy, so a mistyped owner would leave a contract that can never
mint. Unset, the variable only earns a note (a `game-items` built without it can never mint).

Modules land in `target/wasm32-unknown-unknown/release/`. The command fails when a module:

- is larger than **24,949 bytes**. A deploy carries the module hex-encoded and costs
  `500,000 + 10 × (2 × module bytes + 102)` gas, and no transaction may exceed 1,000,000 gas;
- is refused by `validate_wasm_module` from `core/qnet-vm`, the check every node runs at deploy;
- imports anything other than the host functions of module `env` with their exact types, exports
  no `memory`, or exports a function that is not `() -> ()`. The deploy does not check these: a
  wrong import or a missing `memory` makes every call fail, and an entry of another type can
  never be called.

Sizes from rustc 1.93.1:

| Module | Bytes | Deploy gas |
| --- | --- | --- |
| `counter.wasm` | 2,382 | 548,660 |
| `game_items.wasm` built with `GAME_ITEMS_OWNER` | 7,363 | 648,280 |
| `game_items.wasm` built without it (cannot mint) | 6,608 | 633,180 |

`game_items.wasm` is larger than `counter.wasm` mostly for the address checksum: `Args::address()` verifies
it (SHA3-256, one permutation, about 8,500 fuel per address), so a `transfer` costs about 18,100 fuel of
the 200,000 a client gives by default.

### Why the flags

Plain rustc output is refused at deploy: it uses bulk-memory and reference-type instructions,
encodes `call_indirect` in a form the validator rejects, and declares no memory maximum.
`.cargo/config.toml` turns those target features off and fixes the memory at 2 pages (128 KiB)
with a 32 KiB stack; the release profile adds link-time optimisation, which is required, and
optimises for size. To give a contract more memory, raise `--initial-memory` and
`--max-memory` together (multiples of 65,536, at most 16 MiB). rustc warns that
`bulk-memory-opt` and `call-indirect-overlong` are unknown features; they still take effect.

Floating point is refused at deploy: do not use `f32` or `f64`. Keep contracts `#![no_std]`:
standard-library collections and formatting quickly take a module past the 24,949-byte cap.

## Writing a contract

The whole counter template, `templates/counter/src/lib.rs` without its tests:

```rust
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
```

A new contract is a `cdylib` crate that depends on `qnet-contract`; add it to `members` in
`Cargo.toml` (under `templates/` for `cargo build-contracts` to pick it up).

- A call names the entry to run in its `method`. Arguments arrive as raw bytes (the transaction
  carries them hex-encoded in `args`); read them with `args(&mut buf)` and decode with `Args`.
  `Args::address()` reverts with `bad address` unless the address's form and checksum hold, so a mistyped
  recipient is refused. A client should check each address it puts into arguments with `isValidAddress`
  before the wallet signs, since the wallet shows arguments only as hex or text.
- Memory starts fresh on every call. Everything that must last goes through `storage`; there is
  no delete and no way to list keys, so pick keys a reader can rebuild.
- `revert(msg)` ends the call. A transaction whose call reverts changes no storage and keeps no
  events; its fee is still paid. A panic reverts with `panic`.
- `set_return` hands bytes to a calling contract; a transaction does not receive them.
- `emit` records an event, kept when the call succeeds. Emit one from every entry that changes
  state: events are how a client sees that a call took effect.
- No constructor runs at deploy and a contract cannot read who deployed it. Fix an owner at
  build time, as `game-items` does. An `init` entry that stores its first caller as owner can be
  called first by anyone, because the contract address follows from the deployer and nonce
  before the deploy lands.
- `call_value()` and the `value` of `call` are informational; no QNC moves with a call.
- `call` reaches another contract only when the transaction lists it in its access list.

## Templates

### counter

`run` adds one, `reset` sets zero. Key `count` holds the value as 8 bytes little-endian; every
call emits the new value followed by the caller address.

### game-items

| Entry | Arguments | Effect |
| --- | --- | --- |
| `mint` | to, item, amount | owner only: creates `amount` of `item` for `to` |
| `transfer` | to, item, amount | moves the caller's items to `to` |
| `balance` | holder, item | returns the count to a calling contract, 8 bytes little-endian |

Arguments are concatenated: an address is its 45 ASCII bytes, `item` and `amount` are 8 bytes
little-endian each. A zero amount, malformed arguments and a transfer beyond the balance revert.

Storage is text so it reads plainly off-chain: `bal:<address>:<item>` and `supply:<item>` hold
decimal counts. Events are text too: `mint:<to>:<item>:<amount>` and
`transfer:<from>:<to>:<item>:<amount>`.

## Reading contract state off-chain

- `GET /api/v1/account/<contract>` returns the contract's whole storage map, keys and values
  hex-encoded.
- `POST /api/v1/contract/call` with `"is_view": true`, `"method": "storageGet"` and
  `"args": ["<key>"]` (plus the other fields of a call body; no signature) returns one value as
  text, which suits the `game-items` keys and values.
- `GET /api/v1/logs?contract=<address>&from=<height>&to=<height>` returns events, data
  hex-encoded, for at most 501 heights per request.

## Gas for calls

A call pays intrinsic gas of `100,000 + 5 × length of the call data` plus the fuel it burns, at
1.5 times the gas price; unused fuel is refunded. Fuel measured in the VM tests: counter `run`
2,731; `game-items` `mint` 17,100 and `transfer` 18,104. A gas limit of intrinsic plus 30,000
covers these entries with room to spare; the clients' default fuel is 200,000.

## Tests

```
cargo test                   # everything below
cargo test -- --nocapture    # also prints module sizes and fuel
```

- Unit tests of `qnet-contract` and both templates run on the host against `qnet_contract::mock`,
  which keeps a call's writes and events only when it does not revert.
- `tool/tests/vm.rs` builds the templates and the ABI probe into `target/vm-test` (with a test
  `GAME_ITEMS_OWNER`), checks them, and runs them through `execute_call_tree` from `core/qnet-vm`,
  the executor block application uses. The Rust counter must leave the same storage and events as
  `counter.wat`; the probe exercises all 11 host functions, including nested calls and their
  error codes.
- Guards: the VM's dependency versions in `Cargo.lock` must equal the node's `Cargo.lock`, and a
  source check fails if the node's deploy gas constants or deploy payload change.

Format with `cargo fmt`, without `--all`: `--all` also reaches the node crates through the path
dependency.

The full contract reference is in [docs/developers/smart-contracts.md](../docs/developers/smart-contracts.md).

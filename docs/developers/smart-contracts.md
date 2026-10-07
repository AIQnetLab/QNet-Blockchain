# Smart contracts

QNet runs contracts in a deterministic WebAssembly interpreter (`core/qnet-vm`), called from block
application, and implements two token standards, QRC-20 (fungible) and QRC-721 (collections),
natively in the Rust apply code rather than as WebAssembly. This document describes the module a
contract must be, the host functions it can call, how it is deployed and called, what it costs, its
storage and events, how to read its state, and the Rust templates in `contracts/`.

The Rust workspace `contracts/` (helper crate, templates and a checking tool) is described in
[`contracts/README.md`](../../contracts/README.md); the `qnet` command that deploys and calls is in
[CLI](cli.md).

## The virtual machine

| Property | Value |
| --- | --- |
| Crate | `core/qnet-vm`, a leaf crate with no consensus dependencies |
| Engine | the `wasmi` 0.47.2 interpreter with fuel metering; `wasmparser` 0.252.0 for deploy validation |
| Called from | the `ContractCall` and `ContractDeploy` arms of `core/qnet-state/src/transaction.rs` |
| Enabled | on every node from genesis |

## Module rules

`validate_wasm_module` runs when a node receives a deploy and again when the deploy is applied. A
module is accepted only when:

| Rule | Limit |
| --- | --- |
| Size | at most 524,288 bytes (512 KiB); in practice a deploy carries at most 24,949 bytes ([Deploying](#deploying)) |
| Features | the base instruction set plus mutable globals, sign extension, multi-value and saturating float-to-int conversion. Floating-point types and instructions, bulk memory, reference types, SIMD, threads and atomics, tail calls, exceptions, multiple memories and 64-bit memory are refused |
| Memory | every memory declares a maximum, at most 256 pages (16 MiB) |
| Functions | at most 8,192 defined functions |
| Imports | functions only; an imported memory or table is refused |

A node does **not** check at deploy that the imports are host functions with the right types, that
the module exports `memory`, or that its entries have the right type. Such a module deploys and then
fails every call. `qnet check`, `qnet deploy` and `cargo check-contract` in `contracts/` check all of it
before anything is sent.

A module that can be called:

- exports its linear memory as `memory` (every host function reads and writes through it);
- exports each entry point as a function of type `() -> ()`, under any name; a call's `method` picks
  it, `run` when the call names none;
- imports only functions of module `env`, with the exact types below.

Each call instantiates the module afresh: linear memory and globals start from the module's own
initial state, a `start` function (if any) runs first, and only storage, events and the return bytes
outlive the call.

The smallest valid contract, in WebAssembly text:

```wat
(module
  (memory (export "memory") 1 1)
  (func (export "run")))
```

## Host functions

All in module `env`. Pointers and lengths are `i32` offsets and byte counts in the contract's own
memory; an access outside that memory stops the call. Functions marked "copies" write at most the
given capacity and return the full length, so a contract can size a buffer and ask again.

| Function | Type | Behaviour |
| --- | --- | --- |
| `storage_read` | `(key_ptr, key_len, out_ptr, out_cap: i32) -> i32` | this contract's value for the key: `-1` when absent, else its length (copies) |
| `storage_write` | `(key_ptr, key_len, val_ptr, val_len: i32)` | sets the key for this contract; an empty value is stored as empty (there is no delete) |
| `get_caller` | `(out_ptr, out_cap: i32) -> i32` | the transaction's sender in the entry call, the calling contract in a nested call: 45 ASCII bytes (copies) |
| `get_contract` | `(out_ptr, out_cap: i32) -> i32` | this contract's own address (copies) |
| `get_call_args` | `(out_ptr, out_cap: i32) -> i32` | the call's input bytes (copies) |
| `set_return` | `(ptr, len: i32)` | the bytes handed back to a calling contract |
| `get_block_height` | `() -> i64` | the height of the block applying the call; the only clock a contract has |
| `get_value` | `() -> i64` | always 0 in the entry call (a call carries no QNC); in a nested call, the informational `value` the caller passed |
| `emit_log` | `(ptr, len: i32)` | records an event ([Events](#events)) |
| `revert` | `(msg_ptr, msg_len: i32)` | stops the call; the message is not returned or stored anywhere |
| `call_contract` | `(addr_ptr, addr_len, entry_ptr, entry_len, args_ptr, args_len: i32, value: i64, ret_ptr, ret_cap: i32) -> i32` | calls `entry` of the contract at `addr` with `args`; `>= 0` is the callee's return length (copies), `-1` not a reachable WebAssembly contract, `-2` depth limit or re-entry, `-3` the callee stopped |

Safe Rust bindings for all eleven are in `contracts/qnet-contract` (`storage`, `caller`,
`this_contract`, `args`, `set_return`, `emit`, `revert`, `call`, and a panic handler that reverts).

**Contract-to-contract calls.** A contract can reach another contract only if the transaction lists
it in the access list of its calldata. `POST /api/v1/contract/call` builds the calldata from
`contract`, `method` and `args` only, so a call submitted today carries no access list and
`call_contract` returns `-1`. The call stack is at most 8 contracts deep and no contract may be
entered again while it is on the stack.

## Deploying

A deploy goes to `POST /api/v1/contract/deploy`, with the module base64-encoded, an empty
`constructor_args`, a gas limit the sender chooses and the public key always attached. The node
builds the deploy payload `{"code":"<module hex>","code_hash":"<SHA3-256 of the module>","wasm":true}`;
the signature covers `code_hash`. The exact text, body and answer are in
[Transactions](transactions.md#contract-deploy).

- **Gas and size.** A deploy's intrinsic gas is 500,000 + 10 per byte of the deploy payload, which is
  2 × module bytes + 102 bytes long. No transaction may carry more than 1,000,000 gas, so a module can
  be at most **24,949 bytes**. At the minimum price that deploy costs 0.015 QNC.
- **No constructor.** Deploying stores the validated code and runs nothing. A contract that needs an
  owner fixes it at build time (as the `game-items` template does); an `init` entry that stores its
  first caller could be called first by anyone, because the address is known before the deploy lands.
- **Immutable.** There is no upgrade, replacement or removal of code, and a second deploy to an
  address that holds a contract is refused.
- **Confirming it.** The route returns no transaction hash. The deploy is done when
  `GET /api/v1/account/{contract}` shows `is_contract: true`; `qnet deploy` waits for exactly that.

`POST /api/v1/wasm/deploy` also accepts a module (hex), but it fixes the gas limit at 200,000, below
any deploy's intrinsic gas, so a deploy sent through it cannot land. Use `/api/v1/contract/deploy`.

### Contract address

The chain derives the address from the deployer and the deploy's nonce; the deployer cannot choose it:

```
h        = hex(SHA3-256("qnet_contract_v1" || from || nonce as 8 bytes little-endian))
address  = h[0..19] + "eon" + h[19..34] + hex(SHA3-256(h[0..19] + "eon" + h[19..34]))[0..8]
```

It has the form and checksum of a wallet address. `deriveContractAddress(from, nonce)` in the builders
and the SDK computes it; for the transaction vectors, `d9fa370374e24333242eon847d1d354dcd87fe873823e`
at nonce 5 gives `6ce70dafadba812b808eon6216f3fb34b4696928abec9`.

## Calling

A call goes to `POST /api/v1/contract/call` with `method` and `args` (the call input as a hex string,
or `null`); the node builds the calldata `{"args":…,"contract":…,"method":…}` and the signature covers
its SHA3-256 ([Transactions](transactions.md#contract-call-and-token-transfer)). The contract reads
the decoded bytes with `get_call_args`.

- **Fuel.** The call runs on `gas_limit − (100,000 + 5 × calldata bytes)` of fuel. Fuel counts the
  interpreter's instructions; `emit_log` costs 1,500 + 8 per byte more. The sender pays the intrinsic
  gas plus the fuel burned, at 1.5 × the gas price; unused fuel is refunded.
- **Outcome.** When the call returns normally, its storage writes and events are committed. When it
  reverts, traps or runs out of fuel, nothing of it is kept, the fee and the burned fuel are paid and
  the nonce is used. The node records neither case, and the entry call's `set_return` bytes go
  nowhere: a client learns a call's effect from its events and storage.
- **No QNC out.** A call's `amount` is always 0, no host function sends QNC, and a contract cannot call a
  built-in token, so a contract can never send QNC or a built-in token on. A node's submit routes refuse a QNC
  transfer, a batch transfer, or a built-in token `transfer` or `transferFrom`, whose recipient account is a
  contract (`recipient_is_contract`; `recipient_unreadable` when the node could not read the recipient's
  account: ask again or ask another node). The check is made at the routes, not in the block rules: a block
  that carries such a transfer applies it, and the value stays in the contract account for good. Check that a
  recipient is not a contract before sending (`getAccount(to).isContract`); `qnet transfer` and
  `qnet token transfer` refuse one.
- **Block budget.** The fuel reserved by all calls of one block (their `gas_limit` minus intrinsic
  gas) is at most 50,000,000.

Fuel measured for the templates in the node's VM (`contracts/tool/tests/vm.rs`): counter `run` 2,731;
game-items `mint` 17,100 and `transfer` 18,104 (each decodes one address, whose checksum costs about
8,500). A gas limit of intrinsic plus 30,000 covers these entries with room to spare; the clients' default
fuel is 200,000.

## Storage

- Each contract has its own key-value storage, reached only by its own code. Keys and values are
  byte strings.
- On chain every entry is kept in the contract account's `contract_storage` map as
  `hex(key) → hex(value)`, lowercase. Four metadata entries are stored as plain text and cannot be
  reached from the contract: `type` (`wasm`), `code`, `deployer` and `deployed_at`.
- There is no delete and no way to list keys: choose keys a reader can rebuild, such as
  `bal:<address>:<item>`.
- A single call may write at most 50,000 distinct keys; a contract holds at most 50,000,000 entries.
  A call that would exceed either is not committed.
- Storage is part of the state commitment: each contract's entries form a Merkle tree whose root is
  in the contract's account leaf, which is in the checkpoint's `state_root`
  ([State](../architecture/state.md)).

## Events

`emit_log(ptr, len)` records an event of up to 16,384 bytes, tagged with the emitting contract's
address. One transaction may record at most 512 events in all. The payload is opaque: a contract
defines its own encoding (the templates use readable text). Events are kept only when the call
returns normally.

Events are committed in the checkpoint's `logs_root`: each event is a leaf
`SHA3-256(tx_hash || log_index as 4 bytes little-endian || contract || 0x00 || data)`, where
`log_index` is the event's position in its block's list; a Merkle tree per block and one per
90-block window lead to `logs_root`, which the committee certifies.

| Route | Answer |
| --- | --- |
| `GET /api/v1/logs?contract=&from=&to=` | `{success, from, to, oldest_available, pruned_below, count, logs[{height, log_index, tx_hash, contract, data}]}` with `data` as hex; at most 501 heights per request (`to` is cut to `from` + 500); `from` defaults to 0, which is long pruned, so always pass it |
| `GET /api/v1/logs/proof?tx_hash=&log_index=` | the leaf, its path to the block root and the block root's path to `logs_root`, for a window that is final; errors `window_not_finalized`, `window_pruned`, `Log not found in window` |

`log_index` is the position within the block, not within the transaction; each `/api/v1/logs` row
carries it, counted before the `contract` filter, so a row of a filtered page names the index its proof
takes. Nodes keep events as long as their block bodies (about a day on the testnet); `oldest_available`
says where that starts. `NodeClient.verifyLog` in the SDK checks a proof against a committee-certified
checkpoint; its `getLogs` rows carry that position as `logIndex` (`null` only for a filtered page from a
node whose rows lack it, when `verifyLog` finds it from the event's height).

## Reading contract state

| Read | Gives |
| --- | --- |
| `GET /api/v1/account/{contract}` | the whole account, including `is_contract`, `contract_code_hash` and the full `contract_storage` map (keys and values hex, the code under `code`) |
| `POST /api/v1/contract/call` with `"is_view": true`, `"method": "storageGet"`, `"args": ["<key>"]` | one value; the key is the UTF-8 bytes of the text given, and the value comes back as text, so it suits text keys and values (like the `game-items` storage). The other fields of a call body must be present; no signature |
| `GET /api/v1/logs` | the contract's events |

A read-only call of any other method runs it with no input and returns no value: the answer is
`"success": true` with `"result": {"error": "view '<method>' returned no value"}`. Contracts expose
data through storage and events instead.

`GET /api/v1/contract/{address}` and `GET /api/v1/contract/{address}/state` read a store that nothing
writes; they answer "not found" and `null` for every contract.

## Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `VmLimits::max_code_bytes` | 524,288 | module size the validator accepts |
| `MAX_WASM_CODE_BYTES` (builders) | 24,949 | module size one deploy can carry |
| `VmLimits::max_memory_pages` | 256 | 16 MiB of linear memory |
| `VmLimits::max_functions` | 8,192 | functions per module |
| `MAX_CALL_DEPTH` | 8 | contracts on the call stack |
| `MAX_WRITES_PER_FRAME` | 50,000 | distinct keys one call frame writes |
| `MAX_LOG_DATA_BYTES` | 16,384 | bytes in one event |
| `MAX_LOGS_PER_TX` | 512 | events of one transaction |
| `LOG_FUEL_BASE`, `LOG_FUEL_PER_BYTE` | 1,500, 8 | fuel of one event |
| `MAX_WASM_ACCESS_LIST` | 64 | contracts one call may declare |
| `MAX_CONTRACT_STORAGE_ENTRIES` | 50,000,000 | entries per contract |
| `gas_limits::MAX_GAS_LIMIT` | 1,000,000 | gas of one transaction |
| `gas_limits::BLOCK_FUEL_LIMIT` | 50,000,000 | fuel reserved by one block's calls |
| `VIEW_CALL_FUEL` | 50,000,000 | fuel of a read-only call |

## Building contracts in Rust

`contracts/` is a Cargo workspace of its own. Plain compiler output is refused at deploy (it uses
bulk-memory and reference-type instructions, a `call_indirect` encoding the validator rejects, and no
memory maximum); `contracts/.cargo/config.toml` turns those features off and fixes the memory at
2 pages with a 32 KiB stack, and the release profile adds the link-time optimisation that is required.
Built and tested with rustc 1.93.1:

```
rustup target add wasm32-unknown-unknown
cd contracts
cargo build-contracts                     # every template, each checked against the deploy rules
cargo check-contract path/to/module.wasm  # any module built elsewhere
cargo test
```

The build fails when a module is larger than 24,949 bytes, is refused by the node's own
`validate_wasm_module`, imports anything but the host functions with their exact types, exports no
`memory`, or exports a function that is not `() -> ()`. Keep contracts `#![no_std]` and free of
`f32`/`f64`: standard-library collections and formatting quickly pass the size cap, and floating
point is refused.

The whole counter template (`contracts/templates/counter/src/lib.rs` without its tests):

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

## Templates

| Template | Entries | Storage and events |
| --- | --- | --- |
| `counter` | `run` adds one, `reset` sets zero | key `count`, 8 bytes little-endian; each call emits the new value followed by the caller's address. The Rust form of `development/qnet-contracts/examples/counter.wat`, with the same storage and events |
| `game-items` | `mint(to, item, amount)` (owner only), `transfer(to, item, amount)`, `balance(holder, item)` (returns the count to a calling contract) | arguments concatenated: an address as its 45 ASCII bytes (its checksum must hold, `bad address` otherwise), `item` and `amount` as 8 bytes little-endian each; text keys `bal:<address>:<item>` and `supply:<item>`; text events `mint:<to>:<item>:<amount>` and `transfer:<from>:<to>:<item>:<amount>`. The owner is compiled in from `GAME_ITEMS_OWNER`; a build without it can never mint |

Sizes and deploy gas (rustc 1.93.1): `counter.wasm` 2,382 bytes, 548,660 gas; `game_items.wasm` with an
owner 7,363 bytes, 648,280 gas.

An address argument is read with `Args::address()`, which checks its form and its checksum (the first 8 hex
digits of SHA3-256 over the first 37 characters, as the node checks a wallet address) and reverts with
`bad address` otherwise. A mistyped recipient therefore reverts the call instead of crediting an address no
key controls; the check costs about 8,500 fuel per address (a `game-items` transfer about 18,100 in all). A
client should still check every address it encodes into call arguments with `isValidAddress` before asking the
wallet to sign, since the wallets show a call's arguments only as hex or text.

## Built-in tokens

QRC-20 and QRC-721 contracts are selected by `contract_storage["type"]` and run in the Rust apply code.
They use the same storage commitment, events and `logs_root` as WebAssembly contracts, and a
WebAssembly contract cannot call them.

**QRC-20.** Stored fields: `name`, `symbol`, `decimals` (default 9), optional `logo`, `mintable`,
`burnable`, `total_supply`, `total_minted`, `total_burned` (so `total_supply = total_minted −
total_burned`), and balances under `balance:{address}` and allowances under
`allowance:{owner}:{spender}` as decimal strings. Methods, called through `POST /api/v1/contract/call`
with an `args` array: `transfer [to, amount]`, `approve [spender, amount]`, `transferFrom` (or
`transfer_from`) `[from, to, amount]`, `mint [to, amount]` (the deployer, only if `mintable`), `burn
[amount]` (only if `burnable`). Amounts are base units, as a JSON number or a decimal string (use the
string). An unknown method is not applied.

- A transfer to the burn address `0000000000000000000eon00000000000000036877022` destroys the tokens,
  for any token.
- A new holder entry moves a refundable 0.01 QNC deposit from the payer to the escrow account
  `system_storage_rent_escrow`; whoever's operation removes the entry later receives it.
- Each move emits an event with the JSON payload `{"amt","from","kind","std","t":"xfer","tid","to"}`,
  which the token-transfer feeds (`/api/v1/account/{address}/token-transfers`,
  `/api/v1/token/{contract}/transfers`) index.

**QRC-721.** Stored fields `name`, `symbol`; per token `owner:{token_id}`, `approved:{token_id}`, per
holder `bal:{address}`. Methods: `mint` (the deployer only), `transfer`, `approve`, `transferFrom` (or
`transfer_from`); `token_id` is always a string.

**Reads.** `GET /api/v1/token/{contract}` (name, symbol, decimals, supply), `GET
/api/v1/token/{contract}/balance/{holder}`, `GET /api/v1/account/{address}/tokens`, and the view methods
of `POST /api/v1/contract/call` (`balanceOf`, `totalSupply`, `name`, `symbol`, `decimals`, `allowance`;
`ownerOf`, `getApproved`). A holder's QRC-20 balance also has a proof against the committee-certified
state root: `GET /api/v1/token/{contract}/{holder}/balance/proof`. Token names and symbols have no
proof.

**Deploying tokens.** `POST /api/v1/token/deploy` and `POST /api/v1/nft/deploy` fix the gas limit at
50,000, below any deploy's intrinsic gas, so a token or collection deploy sent through them cannot
land.

## Example sources

`development/qnet-contracts/examples/counter.wat` is the counter in WebAssembly text; the test
`example_counter_wat_is_deployable_and_runs` in `core/qnet-state/src/transaction.rs` deploys and calls
it through the apply path, and `contracts/tool/tests/vm.rs` checks that the Rust counter leaves the
same storage and events.

The Phase 1 burn program in the same tree runs on Solana: see [1DEV burn contract](1dev-burn-contract.md).

## Related documents

- [Transactions](transactions.md): the signed texts, gas, fees and status
- [CLI](cli.md): `qnet check`, `deploy`, `call`, `logs`
- [RPC API](rpc-api.md): every route
- [State](../architecture/state.md): accounts and the storage commitment
- [Consensus](../architecture/consensus.md): checkpoints and `logs_root`

# Contract examples

`counter.wat` is a complete contract for the QNet virtual machine: a `wasmi` WebAssembly
interpreter in `core/qnet-vm`, invoked from block application through
`core/qnet-state/src/wasm_exec.rs`. The example is assembled from WebAssembly text, passes the
deploy-time determinism validator unchanged, and is covered by the test
`example_counter_wat_is_deployable_and_runs` in `core/qnet-state/src/transaction.rs`, which deploys
it and calls it through the same apply path a block uses.

The full engine reference — fuel and gas accounting, address derivation, the storage commitment, the
event-log Merkle commitment, and the QRC-20 and QRC-721 native token standards — is
[docs/developers/smart-contracts.md](../../../docs/developers/smart-contracts.md).

## What the example does

`counter.wat` keeps one counter under the storage key `count`, held as an 8-byte little-endian
`i64`. It exports two entry points:

| Entry | Effect |
| --- | --- |
| `run` | reads the counter, adds one, writes it back, emits an event |
| `reset` | writes zero, emits an event |

The event payload is the new 8-byte value followed by the caller address bytes, which is how the
result is read back (see below).

## Host ABI

Every host function is imported from module `env`. All pointer and length arguments index the
calling contract's own linear memory.

| Function | Signature | Behaviour |
| --- | --- | --- |
| `storage_write` | `(key_ptr: i32, key_len: i32, val_ptr: i32, val_len: i32)` | writes one key into this contract's overlay |
| `storage_read` | `(key_ptr: i32, key_len: i32, out_ptr: i32, out_cap: i32) -> i32` | returns `-1` when the key is absent, otherwise the full stored length while copying at most `out_cap` bytes |
| `get_caller` | `(out_ptr: i32, out_cap: i32) -> i32` | caller address bytes; returns the full length, copies at most `out_cap` |
| `get_block_height` | `() -> i64` | height of the block applying the call |
| `get_value` | `() -> i64` | native QNC attached to the call, as context |
| `emit_log` | `(data_ptr: i32, data_len: i32)` | appends an opaque event payload and charges fuel |
| `revert` | `(msg_ptr: i32, msg_len: i32)` | always traps, carrying the message |

The multi-frame executor that runs on the apply path binds four more:

| Function | Signature | Behaviour |
| --- | --- | --- |
| `get_contract` | `(out_ptr: i32, out_cap: i32) -> i32` | this contract's own address; returns the full length |
| `get_call_args` | `(out_ptr: i32, out_cap: i32) -> i32` | argument bytes passed by the caller; returns the full length |
| `set_return` | `(ptr: i32, len: i32)` | sets this frame's return bytes |
| `call_contract` | `(addr_ptr: i32, addr_len: i32, entry_ptr: i32, entry_len: i32, args_ptr: i32, args_len: i32, value: i64, ret_ptr: i32, ret_cap: i32) -> i32` | `>= 0` is the callee's full return length, `< 0` is an error code: `-1` not a resolvable contract, `-2` depth cap or reentrancy, `-3` callee trapped |

The off-consensus read-only path (`qnet_vm::dry_run`, used by RPC views) binds only the seven
functions in the first table, so a module that imports one of the four above executes on the apply
path and traps on the view path.

Every out-buffer function returns the true byte length and copies at most `out_cap` bytes, so a
caller that passes a short buffer receives a truncated copy and a length larger than its capacity.
`counter.wat` clamps the `get_caller` result before using it as a log length.

## Required exports

- A linear memory exported under exactly the name `memory`. The host reads and writes every
  pointer through it.
- The entry function, exported under the name the transaction selects, typed `() -> ()`. A missing
  or differently typed export traps the frame.

## Arguments and return values

- **Entry name.** The call transaction's `data.method` selects the exported function, defaulting to
  `"run"`.
- **Arguments.** `data.args` is a JSON string of hex. It is hex-decoded into the bytes the contract
  reads with `get_call_args`. A JSON value of any other shape leaves the argument bytes empty.
- **Return values.** The entry itself returns nothing. A contract returns bytes to a calling
  contract with `set_return`, and exposes data to the outside world through storage and events.
- **Reachable contracts.** `data.accessList` declares, under the same signature, every contract the
  call may reach with `call_contract`, capped at 64 entries. A target outside the declared set
  returns `-1` on every node. The call endpoint below builds its calldata from `contract`, `method`
  and `args` only, so declaring an access list requires a client that builds and signs the
  transaction itself.

## Determinism rules enforced at deploy

`qnet_vm::validate_wasm_module` accepts a module only when all of the following hold. They are also
enforced by `POST /api/v1/wasm/deploy` before it submits the transaction.

1. The module is at most 512 KiB.
2. The module validates under a feature set containing only mutable globals, sign extension,
   multi-value and saturating float-to-int conversions. Floating-point value types and operators,
   threads and atomics, SIMD, reference types, GC, tail calls, exceptions and memory64 all fall
   outside that set and fail validation.
3. Every declared linear memory carries an explicit maximum of at most 256 pages. A memory with no
   declared maximum is rejected, because an unbounded `memory.grow` would resolve according to host
   RAM and split the state root. This is why `counter.wat` declares `(memory (export "memory") 1 16)`.
4. The module declares at most 8192 functions.
5. Imported memories and imported tables are rejected. Imported host functions are accepted — that
   is how the ABI above is provided.

## Deploying

Assemble the text into module bytes with any WAT assembler, then hex-encode those bytes:

```
wat2wasm counter.wat -o counter.wasm
```

Submit them to `POST /api/v1/wasm/deploy` (1 MiB body limit):

```json
{
  "from": "<deployer EON address>",
  "code": "<hex of counter.wasm>",
  "nonce": 1,
  "dilithium_signature": "<hex>",
  "dilithium_public_key": "<hex>"
}
```

The signature is ML-DSA-65 over `q{chain_id}|contract_deploy:{from}:{code_hash}:{nonce}`, where
`chain_id` is the node's compile-time `QNET_CHAIN_ID` (`q1337` on testnet) and `code_hash` is the hex
SHA3-256 of the module bytes. The contract address is derived on-chain from
the deployer address and the nonce and is returned as `contract.contract_address`; a caller-supplied
address is never used. Deployment stores the validated code and runs nothing — there is no
constructor, so a contract initialises its own state from its entry points.

## Calling

Submit `POST /api/v1/contract/call`:

```json
{
  "from": "<caller EON address>",
  "contract_address": "<contract EON address>",
  "method": "run",
  "args": "",
  "gas_limit": 1000000,
  "gas_price": 1000,
  "nonce": 2,
  "dilithium_signature": "<hex>",
  "dilithium_public_key": "<hex>"
}
```

The node builds the transaction calldata as the JSON object `{"args":…,"contract":…,"method":…}` —
keys in that order, no whitespace — and the ML-DSA-65 signature covers
`q{chain_id}|contract_call:{from}:{sha3_256(calldata bytes)}:{nonce}`. The signature binds the literal
calldata bytes, so a client must sign that exact serialisation. `method: "reset"` selects the
other entry point. The interpreter's fuel budget is `gas_limit` minus the intrinsic gas of the
transaction; fuel is consumed, and billed, whether or not the call succeeds. The gas settlement rules
are in [docs/developers/smart-contracts.md](../../../docs/developers/smart-contracts.md).

A call that traps commits no storage writes and no events; the fee is consumed and the nonce
advances.

## Reading the counter back

`GET /api/v1/logs?contract={address}&from={height}&to={height}` returns the events of a height range
with each payload hex-encoded, so the first eight bytes of a `counter.wat` event are the new value
in little-endian order. The range is capped at 500 blocks per request, and the response reports the
node's prune floor.

`POST /api/v1/contract/call` with `is_view: true` and `method: "storageGet"` reads one storage key
of a WASM contract directly from committed state, with `args` carrying the key. It needs no
signature and returns the stored bytes as text, so it fits contracts that store text values.

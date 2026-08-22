# Smart contracts

QNet executes smart contracts in a deterministic WebAssembly interpreter (`core/qnet-vm`) invoked from
block application, plus two token standards — QRC-20 and QRC-721 — implemented natively in the Rust
apply arms rather than as WASM modules. This document describes the execution engine, the deploy-time
determinism gate, the host ABI, the fuel and gas budgets, contract address derivation, the storage and
event-log models, and the transaction data formats and RPC paths used to deploy and call contracts.

## The virtual machine

| Property | Value |
| --- | --- |
| Crate | `core/qnet-vm` (workspace member, leaf crate — depends on no consensus code) |
| Engine | `wasmi` 0.47 interpreter, fuel metering enabled |
| Deploy validator | `wasmparser` 0.252 with a restricted feature set |
| Apply entry point | `execute_wasm_calltree`, called from the `ContractCall` arm in `core/qnet-state/src/transaction.rs` |

WASM contracts are live from genesis on every node.

## Determinism gate at deploy

`validate_wasm_module` runs before any module is stored. A module is accepted only when all of the
following hold. At runtime the consensus call-tree executor additionally enforces fuel, the store
memory limiter, `MAX_WRITES_PER_FRAME`, `MAX_LOG_DATA_BYTES`, `MAX_LOGS_PER_TX`, `MAX_CALL_DEPTH`, the
reentrancy ban, and `MAX_CONTRACT_STORAGE_ENTRIES` at commit. The off-consensus `dry_run` executor
behind RPC views runs one frame with its own budgets, described under
[read-only views](#read-only-views).

- The module validates under a feature set containing only `MUTABLE_GLOBAL`, `SIGN_EXTENSION`,
  `MULTI_VALUE` and `SATURATING_FLOAT_TO_INT`. Floating-point value types and operators, threads and
  atomics, SIMD and relaxed SIMD, reference types, GC, tail calls, exceptions and memory64 all fall
  outside that set and fail validation.
- Module size is at most `max_code_bytes`.
- Every declared linear memory has an explicit maximum, and that maximum is at most
  `max_memory_pages`. A memory with no declared maximum is rejected, because an unbounded
  `memory.grow` would resolve according to host RAM and split the state root.
- The function count is at most `max_functions`.
- Imported memories and imported tables are rejected. Imported host functions are accepted — that is
  how the ABI below is provided.

On the consensus call-tree path each frame's store carries a `StoreLimits` limiter capping each linear
memory at `max_memory_pages * 65536` bytes, so an over-cap `memory.grow` fails identically on every
node instead of reaching the host allocator. In the off-consensus `dry_run` store used by RPC views,
growth is bounded by the module's own deploy-validated maximum. Contract storage is a sorted
`BTreeMap`, so iteration order is fixed.

### Protocol limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `VmLimits::max_memory_pages` | 256 | 16 MiB of linear memory at 64 KiB per page |
| `VmLimits::max_code_bytes` | 524288 | 512 KiB module size |
| `VmLimits::max_functions` | 8192 | functions per module |
| `MAX_CALL_DEPTH` | 8 | contracts on the call stack at once |
| `MAX_WRITES_PER_FRAME` | 50000 | distinct storage writes per frame invocation |
| `MAX_LOG_DATA_BYTES` | 16384 | bytes in a single event |
| `MAX_LOGS_PER_TX` | 512 | events across the whole call tree of one transaction |
| `LOG_FUEL_BASE` | 1500 | fuel charged per `emit_log` |
| `LOG_FUEL_PER_BYTE` | 8 | fuel charged per logged byte |
| `MAX_WASM_ACCESS_LIST` | 64 | contracts a call may declare it will reach |
| `MAX_CONTRACT_STORAGE_ENTRIES` | 50000000 | entries per contract |
| `VIEW_CALL_FUEL` | 50000000 | fuel for an off-consensus RPC view |

## Fuel and gas

Gas and fuel are two separate budgets with two separate ceilings.

**Intrinsic gas.** `compute_gas_used()` is a pure function of the transaction type and data length:
`CONTRACT_DEPLOY` = 500000 plus 10 per byte of transaction data; `CONTRACT_CALL` = 100000 plus 5 per
byte. `MAX_GAS_LIMIT` is 1000000 per transaction. The effective gas price is `gas_price`, plus 50 per
cent for an ML-DSA-65-signed transaction (`effective_gas_price`).

**Fuel.** The interpreter receives `gas_limit - compute_gas_used()` as its fuel budget. Fuel is
`wasmi`'s instruction counter. The one explicit host-side fuel charge is `emit_log`, priced at
`LOG_FUEL_BASE + LOG_FUEL_PER_BYTE * len`; if the remaining fuel cannot pay it, or the event exceeds
`MAX_LOG_DATA_BYTES`, the frame traps. Fuel exhaustion is a deterministic trap.

**Settlement.** The sender prepays `gas_limit * effective_gas_price`. At heights at or above
`GAS_METERING_ACTIVATION_HEIGHT` (100000), `apply_gas_refund` credits back
`compute_gas_refund() - wasm_fuel_fee(fuel)`, i.e. the unused intrinsic gas minus the metered compute
fee `fuel * effective_gas_price`. The producer's fee credit adds exactly the same compute fee, so the
charge is a symmetric account move and total supply is unchanged. Fuel is billed even when the call
tree traps, because the work was performed. `reserved_fuel()` is non-zero only for `ContractCall`.

**Block ceilings.** Every validator independently sums, from signed fields alone and without
executing anything, the charged gas and the reserved fuel of a proposed block, and rejects the block
if either exceeds `BLOCK_GAS_LIMIT` (10000000000) or `BLOCK_FUEL_LIMIT` (50000000). This check runs
from genesis in `development/qnet-integration/src/block_pipeline.rs`.

## Host ABI

All imports live in module `env`. All pointer and length arguments index the calling contract's own
linear memory, which the module must export as `memory`. The entry function is called with no
arguments and returns nothing; results are returned through `set_return` (call-tree path) or through
contract storage.

Available in every execution context:

| Function | Signature | Behaviour |
| --- | --- | --- |
| `storage_write` | `(key_ptr, key_len, val_ptr, val_len)` | writes into this contract's overlay; traps past `MAX_WRITES_PER_FRAME` |
| `storage_read` | `(key_ptr, key_len, out_ptr, out_cap) -> i32` | returns `-1` when absent, otherwise the full value length; the value is truncated into `out_cap` bytes |
| `get_caller` | `(out_ptr, out_cap) -> i32` | caller address bytes, returns the full length |
| `get_block_height` | `() -> i64` | slot-anchored block height |
| `get_value` | `() -> i64` | native QNC attached to the call, as context |
| `emit_log` | `(data_ptr, data_len)` | appends an opaque event payload; charges fuel |
| `revert` | `(msg_ptr, msg_len)` | always traps, carrying the message |

Additionally available inside the multi-frame (cross-contract) executor:

| Function | Signature | Behaviour |
| --- | --- | --- |
| `get_contract` | `(out_ptr, out_cap) -> i32` | this contract's own address |
| `get_call_args` | `(out_ptr, out_cap) -> i32` | argument bytes passed by the caller |
| `set_return` | `(ptr, len)` | sets this frame's return bytes |
| `call_contract` | `(addr_ptr, addr_len, entry_ptr, entry_len, args_ptr, args_len, value: i64, ret_ptr, ret_cap) -> i32` | `>= 0` is the full return length, `< 0` is an error code |

`get_block_height` is the only time-like input to a contract.

### Cross-contract calls

`call_contract` runs the callee against the callee's own storage. Semantics:

- **Depth** is bounded by `MAX_CALL_DEPTH`.
- **Reentrancy is forbidden unconditionally**: if the target address is already anywhere on the call
  stack, the call returns `CALL_ERR_DEPTH_OR_REENTRANT` without executing.
- **One shared fuel budget** is threaded through the tree: a child spends the parent's remaining fuel
  and the parent resumes with whatever the child left.
- **Frame outcomes**: a frame that returns cleanly commits its storage writes into the tree-wide delta
  and hands its logs to its caller. A frame that traps discards its own writes and its own logs —
  including the logs its children handed up — and surfaces `CALL_ERR_TRAPPED` to its caller, which may
  itself revert or continue.
- **The storage delta is tree-wide**, one map shared by every frame, and reads see it: a write
  committed by a child that already returned is visible to later frames and stays in the delta even if
  the frame that made the call subsequently traps. What discards committed writes is a trap that
  reaches the entry frame, which drops the whole tree. A contract that must not keep a child's effects
  after a later step fails therefore propagates the failure — any frame can `revert` — rather than
  relying on the failing frame alone to unwind them.
- **`MAX_LOGS_PER_TX` counts the whole tree**: the counter lives on the shared call state, so a child's
  `emit_log` is counted in the caller's budget, and the cap bounds the events one transaction can
  contribute to `logs_root` regardless of cross-contract fan-out.
- **Value** is context only: the `value` argument is what the callee reads through `get_value`, and
  the VM result type carries storage writes and logs.

| Code | Value | Meaning |
| --- | --- | --- |
| `CALL_ERR_NOT_CONTRACT` | -1 | target has no code, is not a WASM contract in the resolved set, or the entry-name bytes are not valid UTF-8 |
| `CALL_ERR_DEPTH_OR_REENTRANT` | -2 | depth cap reached, or target already on the stack |
| `CALL_ERR_TRAPPED` | -3 | callee trapped |

The set of callable contracts is bounded. The apply layer builds its resolver from accounts in the
lazily pre-loaded working set whose `contract_storage["type"] == "wasm"` and whose `code` entry decodes
as hex. Those accounts come from an `accessList` array in the signed transaction data — the caller
declares, under signature, every contract the call may reach — which `get_all_affected_addresses` adds
to the working set, capped at `MAX_WASM_ACCESS_LIST`. Any target outside that set deterministically
returns `CALL_ERR_NOT_CONTRACT` on every node.

## Deploying a contract

The contract address is derived on-chain and never taken from a caller-supplied `to`:

```
sha3_256("qnet_contract_v1" || from || nonce_le)
```

The digest is rendered in EON form as `{hash[0..19]}eon{hash[19..34]}{checksum}`, where the checksum is
the first four bytes of `sha3_256` over the assembled body. A deployer therefore cannot squat an
address, and the address the RPC returns equals the address apply derives. Deploy is init-once: if an
account at the derived address is already a smart contract, the deploy is rejected.

Authorization is an ML-DSA-65 (Dilithium3) signature over the canonical message
`q{chain_id}|contract_deploy:{from}:{code_hash}:{nonce}`, where `code_hash` is read from the
transaction data and `q{chain_id}` is the chain tag (`q1337` on testnet).
The signature and public key are carried as hex-encoded raw bytes. See
[cryptography](../architecture/cryptography.md) for the signature scheme.

The WASM deploy branch validates the module and stores the code; state is initialised by the
contract's own methods after deployment.

### Deploy transaction data formats

| Form | Data JSON | Result at apply |
| --- | --- | --- |
| Executable WASM | `{"wasm": true, "code": "<hex>", "code_hash": "<hex>"}` | module validated, `type="wasm"`, `code=<hex>` stored |
| QRC-20 | `{"qrc20": true, "name", "symbol", "decimals", "logo", "initial_supply", "code_hash"}` | native token contract materialised |
| QRC-721 | `{"qrc721": true, "name", "symbol", "code_hash"}` | native NFT collection materialised |

## Calling a contract

A `ContractCall` transaction's `data` is the exact calldata bound by the signature: authorization is
an ML-DSA-65 signature over `q{chain_id}|contract_call:{from}:{sha3(raw tx.data)}:{nonce}`, so the literal
calldata bytes are committed and no re-serialisation can diverge. The public key may be omitted once
it is committed on-chain; the submit path rehydrates it.

Dispatch depends on the target account's `contract_storage["type"]`:

- `qrc20` and `qrc721` run the native apply arms described below.
- `wasm` runs the VM. The entry point name comes from `data.method`, defaulting to `"run"`. Arguments
  are supplied as `args`, a JSON string of hex, and are hex-decoded into the bytes the contract reads
  through `get_call_args`. `accessList`, if present, declares the reachable contract set.

Commit rules for a WASM call: the per-contract storage deltas are written into
`Account.contract_storage` only when the call tree did not trap and no touched contract would exceed
`MAX_CONTRACT_STORAGE_ENTRIES`. On a trap or a cap breach nothing is committed, the fee is consumed
and the nonce advances, and any `msg.value` credited to the target before execution is returned to the
sender.

### Endpoints

Full request and response shapes are in the [RPC API reference](rpc-api.md).

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/wasm/deploy` | deploy executable WASM (`from`, hex `code`, `nonce`, signature, public key); 1 MiB body limit; validates the module before submitting |
| `POST /api/v1/token/deploy` | deploy a QRC-20 token |
| `POST /api/v1/nft/deploy` | deploy a QRC-721 collection |
| `POST /api/v1/contract/call` | state-changing call (signature required) or, with `is_view: true`, a read-only query |
| `POST /api/v1/contract/estimate-gas` | gas estimate for a contract operation |
| `GET /api/v1/contract/{address}` | contract metadata |
| `GET /api/v1/contract/{address}/state` | read one or more raw storage keys |
| `GET /api/v1/logs` | event logs filtered by `contract`, `from`, `to` |
| `GET /api/v1/logs/proof` | two-level inclusion proof for one event |
| `GET /api/v1/token/{address}` | token metadata |
| `GET /api/v1/token/{address}/balance/{holder}` | token balance |
| `GET /api/v1/token/{contract}/{holder}/balance/proof` | trustless balance proof |
| `GET /api/v1/token/{contract}/transfers` | decoded transfer feed for a token |
| `GET /api/v1/account/{address}/tokens` | tokens held by an address |
| `GET /api/v1/account/{address}/token-transfers` | decoded transfer feed for an address |
| `GET /api/v1/token-transfers` | decoded transfers over a height range |

### Read-only views

`is_view: true` on `POST /api/v1/contract/call` answers off-consensus, from current committed state.
For `qrc20` and `qrc721` targets the handler reads the storage keys directly (`balanceOf`, `allowance`,
`ownerOf`, `getApproved`, `name`, `symbol`, and so on). For a WASM contract:

- `storageGet` / `storage_get` / `get` returns the raw stored value for one storage key, via
  `view_storage_get`. This is how a WASM contract exposes readable data: write it to storage and read
  the key back.
- Any other method name is executed by `view_call`, which runs the method through `qnet_vm::dry_run`
  against current on-chain storage with `VIEW_CALL_FUEL`.

`dry_run` is a single-frame executor. It binds the seven host functions available in every execution
context and runs the module against an in-memory `MemHost` seeded from the contract's committed
`contract_storage`. Its budgets are `VIEW_CALL_FUEL`, the same `emit_log` fuel charge and
`MAX_LOG_DATA_BYTES`, a cap of 50,000 distinct storage entries in the in-memory map, and linear-memory
growth bounded by the module's own deploy-validated maximum. The map and the logs are discarded when
the call returns, and a trap is reported to the caller as a reverted view.

Views are never hashed and change no state.

## Storage model

Contract code and contract state both live inside `Account.contract_storage`, a `String -> String`
map.

- VM keys and values are stored hex-encoded. The reserved metadata keys `type`, `deployer`, `code`
  and `deployed_at` are excluded from the byte map a contract sees, and any non-hex entry is skipped.
  Because none of the reserved words are valid lowercase hex, a hex-encoded data key can never collide
  with metadata.
- Contract state is consensus state. `compute_storage_root` builds a per-contract Merkle tree over the
  entire `contract_storage` map (one leaf per key, with domain-separated key and value hashing); that
  root is a field of the account leaf and so folds into `state_root`. See
  [state](../architecture/state.md).
- QRC-20 and QRC-721 entry creation charges `STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC` (10000000 nanoQNC,
  0.01 QNC), moved from the payer into the reserved escrow `system_storage_rent_escrow` and refunded
  when the entry is removed. It is an account move, never a mint or a burn. The refund goes to the
  caller of the operation that removes the entry, not to the account that created it — a QRC-721 burn
  refunds the owner pointer, a balance entry that reaches zero and any cleared approval to the burner.
  Design contracts on that basis: the deposit is a bond on the state entry, and whoever cleans the
  entry up collects it. Every refundable entry is charged on creation, so the escrow always covers a
  removal; a shortfall rejects the transaction identically on every node rather than paying short.

## Event logs

Both `emit_log` from WASM and the native token arms feed one thread-local per-block log sink. The sink
is drained per block, which is sound because block application is sequential; the producer's inline
apply path and the validator apply path bracket it identically (`clear_wasm_logs` /
`drain_wasm_logs`), and a rejected transaction's partial emissions are truncated back to a pre-apply
mark so only successful transactions contribute.

The commitment is two levels of Merkle tree with distinct domain separators, so a block sub-root can
never be reinterpreted as a leaf:

| Level | Input | Domains |
| --- | --- | --- |
| Leaf | `sha3_256(tx_hash \|\| u32le(log_index) \|\| contract_hex \|\| 0x00 \|\| data)` | — |
| 1 | one block's leaves, in emit order, to a per-block sub-root | `log-leaf` / `log-node` |
| 2 | the window's ordered per-block sub-roots to `logs_root` | `logw-leaf` / `logw-node` |

The window is the 90 microblocks of one macroblock window. `logs_root` is a field of `Checkpoint`,
hashed into `Checkpoint::hash()`, and therefore certified by the 2f+1 quorum certificate; the proposer
computes it and `content_ok` rejects any checkpoint whose `logs_root` it cannot reproduce. The
`logs_root_required` feature gate has activation height 0 and is active from genesis. See
[consensus](../architecture/consensus.md).

Binding `(tx_hash, log_index)` into the leaf means an inclusion proof commits to exact receipt
coordinates and cannot be replayed under a different transaction or index. A proof is therefore
O(one block) plus O(the window's sub-roots), never O(the whole window).

Per-block logs are persisted under `blocklogs_{height}` and the per-block sub-root under
`blocklogsroot_{height}`. Both are pruned below a watermark; `GET /api/v1/logs` and
`GET /api/v1/logs/proof` report that floor rather than return a partial, non-matching leaf set, and
the proof endpoint serves windows that are already finalized.

Log payloads are opaque bytes; the log query endpoint filters by contract address and height range.
The native token arms emit a structured, sorted-key JSON payload tagged `t:"xfer"`, which is what the
decoded transfer feeds index.

## Token standards

QRC-20 and QRC-721 are native Rust apply arms selected by `contract_storage["type"]`, sharing the same
log sink, the same `logs_root` and the same storage commitment as WASM contracts.

### QRC-20

Deploy stores `deployer`, `deployed_at`, `type`, `name`, `symbol`, `decimals` (default 9), optional
sanitised `logo`, `mintable`, `burnable`, `total_supply`, and the lifetime counters `total_minted`
(seeded at the initial supply) and `total_burned` (seeded at 0), which keep the invariant
`total_supply == total_minted - total_burned`. A non-zero initial supply also materialises
`balance:{deployer}` and charges its storage deposit. `mintable` and `burnable` both default to
`false`, so tokens deployed through `POST /api/v1/token/deploy` are fixed-supply. The signed
`code_hash` for that endpoint is `sha3_256("QRC20:" + name + ":" + symbol)`.

Methods: `transfer`, `approve`, `transferFrom` (also `transfer_from`), `mint`, `burn`. An unknown
method is rejected, so a typo cannot silently succeed after the fee was charged.

Storage keys: `balance:{address}`, `allowance:{owner}:{spender}`. Amounts are accepted as a JSON
number or a decimal string; the string form is exact beyond 2^53. Balances are read with checked
arithmetic and a present-but-unparseable entry is rejected rather than coerced to zero.

Two behaviours worth knowing:

- A transfer to the canonical burn address `0000000000000000000eon00000000000000036877022` is a real
  supply burn for any token, including a non-burnable one, and never credits the sink.
- A self-transfer cannot mint. The debit is written first and the credit re-reads the already-debited
  value from the live map, so the aliased case nets to a no-op.

### QRC-721

Deploy stores the base `deployer` and `deployed_at` metadata plus `type`, `name` and `symbol`; the
signed `code_hash` for `POST /api/v1/nft/deploy` is `sha3_256("QRC721:" + name + ":" + symbol)`.
Methods: `mint`, `transfer`, `approve`, `transferFrom` (also `transfer_from`); an unknown method is
rejected. Minting is gated to the recorded deployer, and an absent deployer entry rejects rather than
mints.

Storage keys: `owner:{token_id}` for per-token ownership, `bal:{address}` for a holder's count,
`approved:{token_id}` for approvals. `token_id` is always a string argument — a numeric id is rejected
so a float-lossy value can never alias another token's key. Mint cannot overwrite an existing owner,
and a transfer requires the owner or an approved address.

## Example sources

`development/qnet-contracts/examples/counter.wat` is a working contract for the VM described above —
a persistent counter with two entry points — alongside a README covering the host ABI, the required
exports and the deploy and call requests. It is covered by `example_counter_wat_is_deployable_and_runs`
in `core/qnet-state/src/transaction.rs`, which deploys and calls it through the apply path.

The Phase-1 burn contract in the same tree targets Solana's Anchor toolchain — see
[1DEV burn contract](1dev-burn-contract.md).

## Related documents

- [RPC API reference](rpc-api.md) — full request and response shapes
- [State](../architecture/state.md) — accounts, storage commitment, transaction types
- [Consensus](../architecture/consensus.md) — checkpoints, quorum certificates, `logs_root`
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65 signatures, SHA3-256, address format
- [Economics](../economics/overview.md) — fees and the producer fee credit
- [SDK](sdk.md) — client libraries

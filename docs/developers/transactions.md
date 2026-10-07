# Transactions

This document describes the four transactions a wallet, a server or the `qnet` command sends: a QNC
transfer, a built-in token transfer, a WebAssembly contract call and a contract deploy. It gives the
exact text each one signs, the gas it needs, what it costs, the request a node accepts and how to
follow it afterwards.

There is one implementation of these formats: `applications/qnet-mobile/src/crypto/TxBuilders.js`
(with the signed texts in `WalletIdentity.js`). The QNet app imports it, the browser extension's
bundle and `@aiqnet/sdk` compile it. Its known answers are in
`applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json`, checked by the app, the extension
and the SDK; `applications/qnet-mobile/__tests__/TxSourcePin.test.js` fails when the node's own
formats (`development/qnet-integration/src/node/transactions.rs`) change. Every example below is one
of those vectors, signed by the test wallet of the recovery phrase `abandon` × 11 `about`, address
`d9fa370374e24333242eon847d1d354dcd87fe873823e`.

A page does not build transactions: it asks the wallet ([dApp integration](dapp-integration.md)).

## The four kinds

| Kind | Route | Signed text starts | Gas limit |
| --- | --- | --- | --- |
| QNC transfer | `POST /api/v1/transaction` | `q1337\|transfer:` | 10,000 |
| Built-in token transfer | `POST /api/v1/contract/call` | `q1337\|contract_call:` | intrinsic: 100,000 + 5 × calldata bytes |
| WebAssembly contract call | `POST /api/v1/contract/call` | `q1337\|contract_call:` | intrinsic + fuel for the contract |
| Contract deploy | `POST /api/v1/contract/deploy` | `q1337\|contract_deploy:` | intrinsic: 500,000 + 10 × deploy-payload bytes |

A built-in token transfer is a contract call whose target is a built-in fungible token (`qrc20`) and
whose method is `transfer`; the node runs it natively, without the VM.

## Fields every transaction carries

| Field | Rule |
| --- | --- |
| `from` | the sender's EON address, lowercase, valid checksum |
| `nonce` | exactly the sender's committed nonce + 1 (an account's first transaction is 1). Read it from `GET /api/v1/account/{address}` (`nonce`) or, verifiably, from `GET /api/v1/account/{address}/balance/proof` |
| `gas_price` | nano-QNC per gas, at least 10. A node raises its own admission floor while its pool is long: × 2 from 5,000 waiting transactions, × 4 from 20,000, × 8 from 100,000; `GET /api/v1/gas/recommendations` reports the current prices |
| `gas_limit` | at least the kind's intrinsic gas, at most 1,000,000 |
| `dilithium_signature` | hex of the 3,309-byte ML-DSA-65 signature over the signed text (FIPS 204, empty context) |
| `dilithium_public_key` | hex of the 1,952-byte public key. Required on a deploy. On a transfer or call it is needed only until the chain holds the key: send it while `GET /api/v1/account/{address}` answers `has_dilithium_pk: false`, leave it out after |

The node checks that the public key derives `from` (the address is SHA-512 of the key in EON form) and
that the signature verifies over the text it rebuilds from the request. All integers are unsigned
64-bit; write them in the JSON body as bare integers from their digits (a JavaScript `number` loses
precision above 2^53).

## Signed texts

Every signed text starts with the chain tag `q1337|`. Integers are decimal digits with no leading
zeros.

### QNC transfer

```
q1337|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}
```

`amount` is in nano-QNC and above zero. Vector `transfer` (1.5 QNC, nonce 1):

```
q1337|transfer:d9fa370374e24333242eon847d1d354dcd87fe873823e:4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d:1500000000:1:10:10000
```

### Contract call and token transfer

```
q1337|contract_call:{from}:{sha3_256_hex(calldata)}:{nonce}:{gas_price}:{gas_limit}
```

The calldata is the JSON the node builds from the request, `{"args":…,"contract":…,"method":…}`, with
its keys in that (sorted) order and no whitespace. A client hashes exactly that text, so `args` may
hold only what serializes identically on both sides: `null`, a string, or an array of strings and
integers. `contractCallData(contract, method, args)` builds it.

- A token transfer has `method` `transfer` and `args` `[to, amount]`, the amount in the token's base
  units as a decimal string. Vector `tokenTransfer` (1 token of 9 decimals to `4c83…10d`, nonce 2):

  ```
  {"args":["4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d","1000000000"],"contract":"da401c47c976814aa4ceon0a63be8d36c9f0ff502bd06","method":"transfer"}
  q1337|contract_call:d9fa370374e24333242eon847d1d354dcd87fe873823e:7d63bcdf843212bef91a9867327aeb504e7274d6075ddc94b9d10f7693a1e075:2:10:100750
  ```

- A WebAssembly call has `args` as a hex string of the call input (`null` for none), which the
  contract reads as raw bytes. Vector `contractCall` (method `run`, input `01020304`, 50,000 fuel,
  nonce 4):

  ```
  {"args":"01020304","contract":"83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3","method":"run"}
  q1337|contract_call:d9fa370374e24333242eon847d1d354dcd87fe873823e:62c362278e533e99c54b2fddb6bf534ec6a8092588126a66151f76c78815b597:4:10:150465
  ```

The other methods of a built-in fungible token (`approve`, `transferFrom`, `mint`, `burn`) and of a
built-in collection use the same route with their own `args` arrays; see
[Smart contracts](smart-contracts.md#built-in-tokens).

### Contract deploy

```
q1337|contract_deploy:{from}:{code_hash}:{nonce}:{gas_price}:{gas_limit}
```

`code_hash` is the hex SHA3-256 of the module bytes. The node builds the deploy payload
`{"code":"<module hex>","code_hash":"<code_hash>","wasm":true}`, which is 2 × module bytes + 102 bytes
long. Vector `contractDeploy` (the 8-byte empty module `0061736d01000000`, nonce 5):

```
{"code":"0061736d01000000","code_hash":"76fcc948d12ff9ec24dcedd5e76c8fac29cfa916ecc2e1fd73e9d99cadb633ab","wasm":true}
q1337|contract_deploy:d9fa370374e24333242eon847d1d354dcd87fe873823e:76fcc948d12ff9ec24dcedd5e76c8fac29cfa916ecc2e1fd73e9d99cadb633ab:5:10:501180
```

The contract's address is fixed before the deploy is sent: it is derived from the sender and the
deploy's nonce ([Smart contracts](smart-contracts.md#contract-address)). For the vector it is
`6ce70dafadba812b808eon6216f3fb34b4696928abec9`.

## Gas and fees

| Kind | Intrinsic gas | Vector |
| --- | --- | --- |
| Transfer | 10,000 | 10,000 |
| Contract call | 100,000 + 5 × calldata bytes | token transfer: 150-byte calldata, 100,750 |
| Contract deploy | 500,000 + 10 × deploy-payload bytes | empty module: 118-byte payload, 501,180 |

- **Fuel.** A WebAssembly call runs on `gas_limit − intrinsic` of fuel. At exactly the intrinsic gas it
  has no fuel and stops at its first instruction. The builders default to 200,000 fuel
  (`WASM_DEFAULT_FUEL`) and refuse less than 10,000 (`WASM_MIN_FUEL`). A built-in token transfer runs no
  code and needs no fuel, so its gas limit is the intrinsic gas.
- **Price.** Every transaction signed with ML-DSA-65 pays `gas_price + gas_price / 2` per gas (integer
  division): 15 nano-QNC at the minimum price 10.
- **What is charged.** The sender's balance must cover `effective price × gas_limit` (plus the amount
  of a transfer) when the node admits it; after the transaction is applied the unused part comes back.
  A transfer pays its 10,000 gas, a deploy its intrinsic gas, a call its intrinsic gas plus the fuel
  it burned. The transfer vector costs 150,000 nano-QNC (0.00015 QNC); the most the token-transfer
  vector can cost is 1,511,250 nano-QNC and the most the call vector can cost is 2,256,975 nano-QNC.
- **Deposit.** A token transfer to a recipient that holds none of the token yet also moves a
  refundable 0.01 QNC (10,000,000 nano-QNC) storage deposit from the sender to escrow.
- **Deploy size.** 500,000 + 10 × (2 × N + 102) ≤ 1,000,000 gives N ≤ 24,949 bytes of module
  (`MAX_WASM_CODE_BYTES`).

`POST /api/v1/contract/estimate-gas` uses its own constants, which do not match these rules; compute
gas with the formulas above (`contractCallIntrinsicGas`, `contractDeployIntrinsicGas`).

## Request bodies

The builders write the exact JSON text (`transferRequestJson`, `contractCallRequestJson`,
`contractDeployRequestJson`; in the SDK `requestBody`). Field order does not matter to the node, but
a body that does not deserialize (a missing field, an integer written as a string, a number above the
64-bit range) is refused by the node's HTTP layer with a plain-text HTTP 400, not JSON. A body above a
route's limit gets HTTP 413: 64 KiB for a transfer, 128 KiB for a call, 2 MiB for a deploy.

Transfer (vector `transfer`, signature shortened; the public key is attached because the account has
not used it yet):

```json
{"from":"d9fa370374e24333242eon847d1d354dcd87fe873823e","to":"4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d","amount":1500000000,"dilithium_signature":"25aba85c…","gas_price":10,"gas_limit":10000,"nonce":1,"dilithium_public_key":"ee96d7a5…"}
```

Contract call (vector `contractCall`, no public key: the chain already holds it):

```json
{"from":"d9fa370374e24333242eon847d1d354dcd87fe873823e","contract_address":"83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3","method":"run","args":"01020304","gas_price":10,"gas_limit":150465,"nonce":4,"dilithium_signature":"6e6bae7a…"}
```

Contract deploy (vector `contractDeploy`; the module travels base64, `constructor_args` must be empty
because no constructor runs):

```json
{"from":"d9fa370374e24333242eon847d1d354dcd87fe873823e","code":"AGFzbQEAAAA=","constructor_args":null,"gas_limit":501180,"gas_price":10,"nonce":5,"dilithium_signature":"c5658e04…","dilithium_public_key":"ee96d7a5…"}
```

`POST /api/v1/contract/call` also requires every field of a call body (`args` may be `null`), so a
body without `args` is HTTP 400.

## Answers

Every submit body the node can read is answered with HTTP 200; the outcome is in the body.

| Route | Accepted | Refused |
| --- | --- | --- |
| `POST /api/v1/transaction` | `{"success":true,"tx_hash":"<64 hex>","signed_id":"<64 hex>","message":"Transaction submitted successfully"}` | `{"success":false,"error":…,"details":…}` |
| `POST /api/v1/contract/call` | `{"success":true,"tx_hash":…,"contract_address":…,"method":…,"gas_limit":…,"message":"Contract call submitted to mempool"}` | `{"success":false,"error":…,"details":…}` |
| `POST /api/v1/contract/deploy` | `{"success":true,"contract_address":…,"code_hash":…,"code_size":…,"gas_limit":…,"deployer":…,"message":"Contract deployment submitted to mempool","security":{…}}`, with no `tx_hash` | `{"success":false,"error":…,"details":…}` |

`details` carries the node's reason, such as `Invalid nonce: expected 3, got 2` or `pk_unresolved`
(the public key was left out but the chain does not hold it yet, or this node is a block behind: send it
again with the key). A transfer, a batch transfer or a QRC-20 `transfer`/`transferFrom` whose recipient
account is a contract is refused with `"code": "recipient_is_contract"`; `"code": "recipient_unreadable"`
means this node could not read the recipient's account: ask again or ask another node
([RPC API](rpc-api.md#submitting-a-transfer)). A
throttled request answers `{"success":false,"error":"Rate limit exceeded","retry_after_seconds":N,…}`;
submits are limited to 100 a minute per IP by default, deploys to 5 an hour.

## One transaction at a time

A node admits a transaction only at the committed nonce + 1 and keeps one pending version per
(`from`, `nonce`), so each account has at most one transaction waiting. Send the next one after the
previous one is in a block (about a second). The same signed body may be sent to several nodes: it is
one transaction, and at most one copy is applied.

- A body whose signed fields all equal the version pending at a node (sent again, or signed again on a
  retry) is answered with success and the pending version's `tx_hash`.
- A different version at the same nonce is refused (`nonce_already_pending ... (a replacement must pay a
  higher gas_price)`) unless its `gas_price` is higher; then it replaces the pending one.

## Identity and hash

The receiving node computes `tx_hash` over the whole transaction, including its `timestamp`, which the
signature does not cover. The same signed body sent to two nodes gets two hashes, a relay can re-stamp a
pending transaction into a copy with another hash, and a client cannot compute the hash in advance: the
returned `tx_hash` names the copy pending at the answering node, not necessarily the one that lands.

A transaction's identity is (`from`, `nonce`): the wallets return both, and the SDK waits by them. The
transfer and batch routes also answer `signed_id`, the hex SHA3-256 of the signed text followed by the raw
signature, the same for every copy. `GET /api/v1/transaction/by-nonce/{from}/{nonce}` answers the copy a
node holds for that nonce, pending or confirmed, with its `hash` and `signed_id`
([RPC API](rpc-api.md#rest-transactions-and-mempool)). A send whose returned hash is not found has landed
once the account's nonce reaches its nonce; it must not be sent again then.

## Status and outcome

`GET /api/v1/transaction/{hash}` answers with the node's own copy:

| Answer | Meaning |
| --- | --- |
| `"status":"found"`, `transaction.status` `pending` | in this node's pool (it looks through its first 1,000 waiting transactions) |
| `"status":"found"`, `transaction.status` `confirmed` | a stored block holds it, at `block_height`; `finality_indicators.level` is `InBlock`, `QuickConfirmed`, `NearFinal` or `FullyFinalized` (the height is at or below the committee-certified checkpoint) |
| `"status":"not_found"` | this node does not know this hash (another node's copy has another hash, or it is older than the node's 100,000-block index) |

Recorded from `https://node2.aiqnet.io` on 2026-09-25 (a reward payment):

```json
{"status":"found","transaction":{"amount":13942206823306,"block_height":2208291,"effective_gas_cost":0,"finality_indicators":{"confirmations":2622,"level":"FullyFinalized","risk_assessment":"safe_for_any_amount","safety_percentage":100.0,"time_to_finality":0},"from":"system_rewards_pool","gas_limit":0,"gas_price":0,"hash":"f7d6c1ea3936b29b399cdfcc3eaae2b68d78c54127ea775db430ece2f5ee2bea","is_quantum_signed":true,"nonce":0,"quantum_security":{"algorithm":"CRYSTALS-Dilithium3 (NIST FIPS 204)","dilithium_pubkey_present":true,"dilithium_signature_present":true,"gas_premium":"50%","quantum_resistant":true},"signature_type":"Dilithium3 (ML-DSA-65)","status":"confirmed","timestamp":1790358572,"to":"3ea41975abd7681e7e1eon5257cf41fa26cbf9bbd32ad","tx_type":"RewardDistribution"},"tx_hash":"f7d6c1ea3936b29b399cdfcc3eaae2b68d78c54127ea775db430ece2f5ee2bea"}
```

`confirmed` means "in a block", not "applied": the node stores no result. What happened follows from
the account and the contract:

| Case | The sender's nonce | Effect |
| --- | --- | --- |
| applied | reaches the transaction's nonce | the transfer, token move or deploy took place; a call's writes and events are committed |
| not applied (for example a token balance or deposit too small, an unknown token method, a gas limit below the intrinsic gas) | stays below it | nothing changed; the same nonce can be used again |
| a call whose contract reverted or ran out of fuel | reaches the transaction's nonce | the fee and the burned fuel are charged; no storage write and no event of the call is kept |

So: a transfer is done when the nonce passed it; a deploy when the contract exists at its address
(`GET /api/v1/account/{contract}` shows `is_contract: true`); a call when the contract's event for it
appears in `GET /api/v1/logs`. Contracts should emit an event from every entry that changes state.
The SDK's `waitForTransaction` and the `qnet` command apply these rules.

The nodes keep their transaction index for the last 100,000 blocks (about 28 hours). An older
transaction is in the site archive: `GET https://aiqnet.io/api/tx/{hash}`.

## System transactions

The node builds the system transactions of a block itself; a wallet never sends one. From the
`tx_target_bound` gate (height 2,851,200, [consensus](../architecture/consensus.md#consensus-feature-gates)) a
commitment-class system transaction carries, in each envelope field its signature leaves out, the one
value its builder writes (`check_commitment_envelope` in `core/qnet-state/src/transaction.rs`), so a relay's
copy has the same hash:

| Type | `nonce` | `gas_price` | `gas_limit` | `timestamp` |
| --- | --- | --- | --- | --- |
| Heartbeat | `(anchor_height / 14400) × 10 + (anchor_height % 14400) / 1440 + 1` | `u64::MAX` | 0 | 0 |
| Light eligibility bitmap | `epoch × 10 + shard_index + 1` (`shard_index` = N − 1 of `genesis_node_00N`) | `u64::MAX` | 0 | 0 |
| Node registration | 0 | 0 | 0 | signed |
| Node reactivation | `last_macroblock_index` | `u64::MAX` | 0 | signed |

A heartbeat's and a bitmap's `timestamp` is 0, before the gate too; the block's time is the time to show for
them. A node refuses a relayed copy of a pooled commitment before verifying it: `[REJECT][TX]
commitment_copy_pending` (with the prefix `already_known:` on gossip, where a copy of a pending value
transaction answers `already_known: signed_tx_pending`).

## Related documents

- [Smart contracts](smart-contracts.md): what a call runs, events, addresses
- [RPC API](rpc-api.md): every route
- [SDK](sdk.md) and [CLI](cli.md): the builders in code and on the command line
- [Cryptography](../architecture/cryptography.md): ML-DSA-65 and addresses

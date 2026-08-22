# SDK

The TypeScript SDK at `development/qnet-sdk` is the client library in this repository. Canonical
request and response shapes are always the node's, in the [RPC API reference](rpc-api.md).

## Package

| Property | Value |
| --- | --- |
| Location | `development/qnet-sdk` |
| Package name | `@qnet/sdk` |
| Language | TypeScript, `target: ES2020`, `strict: true` |
| Runtime dependencies | `axios`, `bs58` |
| Build | `tsc` plus `rollup` — CommonJS, ESM and a bundled `.d.ts` into `dist/` |
| Tests | `jest` with `ts-jest`, `src/client.test.ts` |

The package builds with npm, independently of the node's Rust build.

## Modules

| File | Contents |
| --- | --- |
| `src/client.ts` | `QNetClient`, an axios-based REST client, and `assertClaimMessageShape` |
| `src/wallet.ts` | `buildUnsignedTransfer`, `buildRewardClaimPayload`, `addressFromPublicKeyHash`. Key generation is deliberately excluded — private keys are expected to live in the mobile app or a secure enclave |
| `src/address.ts` | address validation and derivation helpers, `formatQNC` / `parseQNC` (9 decimals) |
| `src/contract.ts` | `ContractHandle`, `toHex` / `fromHex` for argument and payload bytes, contract parameter and result types |
| `src/subscription.ts` | `QNetSubscription`, a class-based polling subscription over blocks, macroblocks and per-address transactions |
| `src/poller.ts` | `pollBlocks`, `waitForHeight`, `waitForTransaction` — functional polling with exponential back-off |
| `src/errors.ts` | `QNetError` and six subclasses |
| `src/types.ts` | shared interfaces for blocks, transactions, balances, rewards, node and network status |
| `src/index.ts` | the public export surface |

Live updates are delivered by HTTP polling in `src/poller.ts` and `src/subscription.ts`.

## Building and testing

```bash
cd development/qnet-sdk
npm install
npm test
npm run build
```

## Constructing a client

The endpoint is operator-supplied — the base URL of a node's HTTP API. An API key, if the node
requires one, is sent as the `X-API-Key` header.

```typescript
import { QNetClient, formatQNC } from '@qnet/sdk';

const client = new QNetClient({
  endpoint: 'http://<your-node-host>:<api-port>',
  timeoutMs: 15_000,
});

const block = await client.getLatestBlock();
```

## Endpoint coverage

| SDK method | Node route |
| --- | --- |
| `getNodeStatus` | `GET /api/v1/node/status` |
| `getLatestBlock` | `GET /api/v1/block/latest` |
| `getBlock` | `GET /api/v1/block/{height}` |
| `quoteRewardClaim`, `submitRewardClaim`, `claimRewards` | `POST /api/v1/rewards/claim` |
| `deployContract` | `POST /api/v1/wasm/deploy` |
| `callContract`, `viewContract` | `POST /api/v1/contract/call` |
| `getContractLogs` | `GET /api/v1/logs` |

`getLatestBlock` and `getBlock` back the pollers and subscriptions. For every other route, use the
paths in the [RPC API reference](rpc-api.md) directly.

## Reward claims

The claim helper matches the node's handler. It is a two-step handshake against
`POST /api/v1/rewards/claim`:

1. `quoteRewardClaim` sends `node_id`, `wallet_address` and an ML-DSA-65 signature over
   `claim_rewards:{nodeId}:{wallet}` — the string `buildRewardClaimPayload` returns. The node replies
   with the claims payload, the message to sign, a timestamp, and the amount in nanoQNC as a decimal
   string.
2. `submitRewardClaim` echoes `claims_data` and `claim_timestamp` back unchanged, together with a
   second signature over the quoted message. Apply re-verifies the signature and every Merkle proof.

`claimRewards` performs both steps and returns `null` when there is nothing to claim. Before the
second signature it calls `assertClaimMessageShape`, which hands the node's string to the signing key
only when it has the exact form `qnet_claim_v1:{wallet}:{timestamp}:{64 hex chars}` — the node builds
precisely that message as `qnet_claim_v1:{to}:{timestamp}:{hex(sha3_256(claims_data))}`. Because the
same key signs transfers, this shape check is what keeps a claim response from steering the key into
signing anything else. The check pins the domain tag, the wallet, the timestamp and the digest shape;
a caller can additionally hash `quote.claimsData` with SHA3-256 and compare it against the digest
before signing.

## Amounts and addresses

`formatQNC` and `parseQNC` convert between nanoQNC and a human-readable `QNC` string at 9 decimals,
using `BigInt` throughout, and round-trip in the unit tests.

A QNet address is the 45-character EON form `{19 hex}eon{15 hex}{8 hex SHA3-256 checksum}`. Validate
addresses with the node's own endpoints, or against the format documented in
[cryptography](../architecture/cryptography.md).

A transfer signature is taken over the node's canonical message
`q{chain_id}|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}` (`q1337|` on testnet, the
node's compile-time `QNET_CHAIN_ID`). A contract call is signed over
`q{chain_id}|contract_call:{from}:{sha3_256(calldata bytes)}:{nonce}`, where the calldata is the JSON
object described in [smart contracts](smart-contracts.md); a WASM deploy is signed over
`q{chain_id}|contract_deploy:{from}:{sha3_256(module bytes)}:{nonce}`.

## Errors

`errors.ts` exports a typed hierarchy — `QNetApiError`, `QNetSyncError`, `QNetAddressError`,
`QNetTransactionError`, `QNetRewardError`, `QNetContractError`. `QNetClient` itself throws an `Error`
carrying the method, the path, the HTTP status and the node's error text, so client code should read
those fields rather than match on the class.

## Wire formats

Transactions, accounts and blocks are `bincode`-serialised Rust types in `core/qnet-state`, and the
canonical signing messages are built in `development/qnet-integration/src/node/transactions.rs`.

## Related documents

- [RPC API reference](rpc-api.md) — the authoritative endpoint list and request shapes
- [Smart contracts](smart-contracts.md) — contract deploy and call formats, token standards
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65 signing, address derivation
- [Mobile wallet](../applications/mobile-wallet.md) — the reference client implementation

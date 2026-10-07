# SDK

`@aiqnet/sdk` (`development/qnet-sdk`, version 2.0.0) is the developer kit in this repository: wallet
connection and sign-in for web pages, the transaction builders the wallets use, a client of the nodes'
HTTP API, encrypted key files, and the `qnet` command line ([CLI](cli.md)). It is written in
TypeScript and ships as ES modules with type declarations, for Node 20 or later and current browsers.

## Install

The package is not published to the npm registry, and no name there belongs to QNet until it is: do not run
`npm install @aiqnet/sdk`, or any other name, against the registry, since whoever holds that name would run code
beside your keys. Build the package file from this repository and install that file:

```
cd development/qnet-sdk
npm ci
npm pack                          # builds dist/ and writes aiqnet-sdk-2.0.0.tgz; note its SHA-256
npm install /path/to/aiqnet-sdk-2.0.0.tgz            # in your project
npm install --global /path/to/aiqnet-sdk-2.0.0.tgz   # the qnet command
```

`npm pack` first checks that the light-client pin compiled in (the mobile app's, in
`applications/qnet-mobile/src/config/genesisConsensus.js`) is at most 7 days old, and stops otherwise: pull a newer
revision of the repository, or refresh the pin with `node scripts/ws-pin.js --write` in `applications/qnet-mobile`.

## Entry points

| Import | Runs in | Holds |
| --- | --- | --- |
| `@aiqnet/sdk` | pages and Node | `findWallet` / `QNetWallet` (a page talks to the user's wallet), sign-in (`createSignInMessage`, `parseSignInMessage`, `verifySignIn`, `createNonceStore`, `createSignInNonce`), the transaction builders, `signTransaction`, `verifyTransactionSignature`, `requestBody`, `checkModule`, recovery-phrase keys, amounts |
| `@aiqnet/sdk/node` | Node | `NodeClient` (reads, verified balance, events, transaction lookup, submit, wait), key files (`createKey`, `unlockKey`, `listKeys`, `readKeyInfo`, `keystoreDir`) |
| `qnet` (bin) | Node | the command line |

`NodeClient` is in `@aiqnet/sdk/node`, the entry for servers and the command line (it also keeps keys in
files). A page asks the wallet for anything it signs or sends; public chain data it reads from the
nodes' public routes, which allow any origin ([RPC API](rpc-api.md#cors)), or from its own server.


## One source for the formats

The SDK copies no transaction format. `build.mjs` compiles, by path, the shared sources:
`applications/qnet-mobile/src/crypto/` (`TxBuilders`, `WalletIdentity`, `OffchainMessage`,
`QcLightClient`, `SmtFold`, `PasswordStrength`), `applications/qnet-mobile/src/config/`
(`fees`, `nodes`, `genesisConsensus`), `applications/qnet-mobile/src/utils/` (`strictJson`,
`boundedFetch`, `solanaFormat`), and the extension's key derivation and account-proof fold from
`applications/qnet-wallet/tools/crypto-bundle/src/`. The build fails on any other shared file, and its
tests check the result against the app's known answers
(`applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json`).

## In a page

```js
// development/qnet-sdk/README.md
import { findWallet } from '@aiqnet/sdk';

const wallet = await findWallet();                 // null when no QNet wallet is installed
const { qnet } = await wallet.connect();           // the user approves the site once
const sent = await wallet.sendTransfer({ to: '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d', amount: '1.5' });
// (sent.from, sent.nonce) is the transaction's identity; sent.txHash is one node's name for its copy.
const status = await wallet.getTransactionStatus({ from: sent.from, nonce: sent.nonce });
```

| `QNetWallet` member | Provider method | Returns |
| --- | --- | --- |
| `connect()` | `qnet_requestAccounts` | `{qnet, solana}` |
| `accounts()` | `qnet_accounts` | `{qnet, solana}` or `null` |
| `chainId()` | `qnet_chainId` | `{chainId, network}` |
| `disconnect()` | `qnet_disconnect` | — |
| `signMessage(message)` | `qnet_signMessage` | `{signature, publicKey, address}` |
| `signIn({nonce, statement?, ttlMs?, origin?})` | `qnet_requestAccounts`, `qnet_chainId`, `qnet_signMessage` | `{message, signature, publicKey, address}` for `verifySignIn` |
| `sendTransfer({to, amount})` | `qnet_sendTransaction`, `type: 'transfer'` | `{status, from, nonce, txHash}` |
| `sendTokenTransfer({token, to, amount})` | `qnet_sendTransaction`, `type: 'tokenTransfer'` | the same |
| `callContract({contract, method, args?, gasLimit?})` | `qnet_sendTransaction`, `type: 'contractCall'` | the same; `args` hex, `''` by default |
| `getTransactionStatus({from, nonce})` | `qnet_getTransactionStatus` | `{status, blockHeight, txHash}` |
| `on('accountsChanged' \| 'disconnect', listener)` | provider events | an unsubscribe function |

`findWallet({timeoutMs})` waits for the wallet's announcement (600 ms by default) and returns `null`
when none comes. Every wallet refusal is a `QNetProviderError` whose `providerCode` is the wallet's
code (4001, 4100, …) and whose `cooldown` is true for the rejection pause. What each method does is in
[dApp integration](dapp-integration.md).

## Sign-in

```js
// development/qnet-sdk/README.md
// Server: issue a nonce to the session that asks for it, and keep it until it is used.
import { createNonceStore, verifySignIn } from '@aiqnet/sdk';
const nonces = createNonceStore();
const nonce = nonces.issue(sessionId); // the id of this visitor's session: a random cookie your server set

// Page: the wallet signs the sign-in text for this page's origin.
const signed = await wallet.signIn({ nonce, statement: 'Sign in to play' });

// Server: the nonce must have been issued to this same session.
const { address } = await verifySignIn(signed, { origin: 'https://games.aiqnet.io', consumeNonce: (n) => nonces.consume(n, sessionId) });
```

The text, the checks, their error codes and the rules for the session and the verify request are in
[Sign-in](sign-in.md).

## Building and signing transactions

| Function | Does |
| --- | --- |
| `buildTransfer({from, to, amountNano, nonce, gasPrice?, gasLimit?})` | a QNC transfer |
| `buildTokenTransfer({from, token, to, amount, nonce, gasPrice?, gasLimit?})` | a built-in token transfer, `amount` in base units |
| `buildContractCall({from, contract, method, args?, nonce, gasPrice?, gasLimit?, fuel?})` | a WebAssembly call, `args` hex or `null`; `fuel` (default 200,000, at least 10,000) or an explicit `gasLimit`, not both |
| `buildContractDeploy({from, code, nonce, gasPrice?, gasLimit?})` | a deploy of `code` (a `Uint8Array`, at most 24,949 bytes); the result carries `contractAddress` |
| `signTransaction(tx, secretKey, publicKey)` | checks that the key is `tx.from`'s, rebuilds the signed text from the fields, signs it with ML-DSA-65 and verifies the signature |
| `verifyTransactionSignature(tx, signature, publicKey)` | the node's check: the key derives `from`, the transaction rebuilt from its own fields by the builders equals `tx` field for field (the signed text `preimage` included), and the signature verifies over that text; a transaction whose fields differ from what was signed is `false` |
| `requestBody(tx, signature, publicKey \| null)` | the exact JSON body of the route in `tx.path`; pass `null` once the chain holds the account's key (a deploy always needs it) |
| `contractCallData`, `contractCallIntrinsicGas`, `contractDeployData`, `contractDeployIntrinsicGas`, `deriveContractAddress`, `wasmCodeHash` | the pieces, for tools that need them |

Each builder returns a frozen object with every field as decimal text (`nonce`, `gasPrice`,
`gasLimit`, `maxFeeNano`, …), the route `path` and the signed text `preimage`. Invalid input throws a
`QNetError` with a stable code (`INVALID_ADDRESS`, `INVALID_AMOUNT`, `INVALID_GAS_LIMIT`, `CODE_TOO_LARGE`,
…); no address, amount or key is ever put in an error. Constants: `CHAIN_TAG` (`q1337|`), `MIN_GAS_PRICE`
(10), `TRANSFER_GAS` (10,000), `MAX_GAS_LIMIT` (1,000,000), `MAX_WASM_CODE_BYTES` (24,949),
`WASM_DEFAULT_FUEL`, `WASM_MIN_FUEL`, `TOKEN_ENTRY_DEPOSIT_NANO` (10,000,000), `CANONICAL_BURN_ADDRESS`,
`TX_ROUTES`. The formats themselves are in [Transactions](transactions.md).

Keys from a recovery phrase: `keypairFromRecoveryPhrase(phrase)` gives `{address, publicKey, secretKey}`
with the wallets' own derivation (the golden vector `abandon` × 11 `about` →
`d9fa370374e24333242eon847d1d354dcd87fe873823e`); `isValidRecoveryPhrase`, `generateEntropy`,
`recoveryPhraseToEntropy` and `keypairFromEntropy` are the parts. `parseUnits(text, decimals = 9)` and
`formatUnits(value, decimals = 9)` convert decimal text and base units exactly.

`checkModule(bytes)` runs the deploy checks on a WebAssembly module locally (size and deploy gas, the
node's feature and memory rules, imports of the host functions with their exact types, the `memory`
export, `() -> ()` entries) and returns `{ok, problems, report}`.

## Node client (servers and the command line)

```js
import { NodeClient } from '@aiqnet/sdk/node';

const client = new NodeClient();                   // the testnet's public nodes, https://node1..5.aiqnet.io
const account = await client.getAccount('4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d');
```

| Method | Route | Returns |
| --- | --- | --- |
| `height()` | `GET /api/v1/height` | the height |
| `getAccount(address)` | `GET /api/v1/account/{address}` | `{address, balanceNano, nonce, hasPublicKey, isContract, contractType}`, integers as exact decimal text |
| `nextNonce(address)` | the same | the nonce the next transaction must carry |
| `getVerifiedAccount(address, {maxAgeBlocks?})` | `GET /api/v1/account/{address}/balance/proof`, `GET /api/v1/height` on the other nodes, then the light client | `{balanceNano, nonce, blockHeight, tipHeight, behindBlocks, proofFolds, verified}`: `verified` when the proof folds to a state root that a committee-signed checkpoint holds and `blockHeight` is at most `maxAgeBlocks` (default `MAX_PROOF_AGE_BLOCKS`, 270: three macroblocks) below the tip. The balance and nonce are the account's as of `blockHeight`, not now |
| `getTokenInfo(contract)` | `GET /api/v1/token/{contract}` | `{standard, name, symbol, decimals, totalSupply, deployer, deployedAt}`, one node's answer |
| `getAgreedTokenInfo(contract)` | the same, from several nodes | the same, once two nodes give the same standard, decimals, symbol and name (the only node when one is configured); `NODES_DISAGREE` otherwise. Build a send from this: the decimals scale the amount |
| `getTokenBalance(contract, holder)` | `GET /api/v1/token/{contract}/balance/{holder}` | base units as text, one node's answer |
| `getLogs({contract?, from, to?})` | `GET /api/v1/logs` | one window of at most 501 heights (`LOG_WINDOW`); each row `{height, logIndex, txHash, contract, data}` |
| `verifyLog({txHash, logIndex?, height?, contract, data})` | `GET /api/v1/logs/proof`, then the light client | `'verified'`, `'consistent'` (proof holds, checkpoint not checkable yet), `'rejected'` or `'pending'` |
| `getTransaction(hash)` | `GET /api/v1/transaction/{hash}`, else `https://aiqnet.io/api/tx/{hash}` | `{status: 'pending' \| 'in_block' \| 'not_found', blockHeight, finality, from, to, nonce, txType, source}` |
| `submit(tx, signature, publicKey \| null, {publicKeyIfUnresolved?})` | the route in `tx.path` | `{txHash, contractAddress, node}`; a node that gives no answer, or refuses for a reason of its own, passes the same body to the next, and one that resets the connection is asked once more on a new one first |
| `waitForTransaction({from, nonce, txHash?}, {timeoutMs?})` | account, transaction and height reads | `{state: 'applied' \| 'not_applied' \| 'timeout', nonce, blockHeight}` |

- Integers the node sends as JSON numbers are read exactly, also above 2^53; every answer is limited
  in size (8 MiB by default).
- A checkpoint proves a balance as of its height, so a node that kept an old state could prove a balance
  the account has since spent. `getVerifiedAccount` therefore reads the tip from the configured nodes other
  than the one that gave the proof (the upper median of their answers, so one node can neither hide an old
  proof nor make a fresh one look old while three or more answer) and does not verify a proof more than
  `maxAgeBlocks` below it, nor one whose age no node can tell (`tipHeight: null`). With one node configured the
  tip comes from that node too, and a node that lies about both is not caught: configure several.
- Reads go round-robin over the nodes; a node that fails, is rate-limited or cannot be reached yields
  to the next.
- A node that refuses a submit for a reason of its own has not taken the body, and the next node is
  asked: it could not read the recipient's account (`recipient_unreadable`), its signature checks are at
  capacity (`Server busy`, `verify_overloaded`), the gas price is below the floor its own pool sets, or its
  state is behind the nonce sent (`Invalid nonce: expected N, got M` with N below it). A node that cannot
  resolve an elided public key (`pk_unresolved`, one a block behind the key's first use) is sent the same
  transaction once more with `publicKeyIfUnresolved` when it is given (the key only adds to the body; the
  signature does not cover it), and the nodes after it get the key too.
- Any other refusal of a submit is final (`NODE_REJECTED`, a `QNetNodeError` whose `reason` is the node's
  own text, `Invalid nonce: expected 3, got 2`, with the node's `code` in parentheses when it gives one,
  `(recipient_is_contract)`) only while no earlier node may hold the body. Once a node
  timed out, failed after the request could have reached it, or answered in a way that cannot be read,
  a later refusal (a used nonce, a duplicate) or no answer at all is `SUBMIT_UNCERTAIN`: that node's copy
  may still apply. Do not build a new transaction then. Wait with `waitForTransaction({from, nonce})`, or
  send again at the same nonce, since at most one transaction of an address applies at a nonce. A node
  that took the body but gave no hash answers with `txHash: null`.
- `waitForTransaction` answers `applied` when the account's nonce reaches the transaction's, and
  `not_applied` only when two nodes (the only one, when one is configured) each hold the hash in a block
  three blocks below their tip and each report the account's nonce exactly one below the transaction's,
  all three read from that same node. A node that is behind or reports another nonce counts for
  neither. A node answers the default account (nonce 0, balance 0) for an address it has no row for, and
  a node of an earlier release answers it for a storage read that failed too, where a current node
  answers HTTP 503 `account_unreadable`. Nonce 0 therefore proves nothing: for an account's first
  transaction (nonce 1) `waitForTransaction` answers `applied` or `timeout`, never `not_applied`. Without `txHash` it
  answers `applied` or `timeout` too. `applied` for a
  call means the nonce was used; whether the contract did what was asked shows in its events or storage.
- `logIndex` is the event's position among all events of its block, the index its leaf and
  `GET /api/v1/logs/proof` name, not its position within the transaction. `getLogs` fills it when the node
  gives it or when the page covers every contract; a page of one contract from a node that does not give it
  has `logIndex: null`, and `verifyLog` then takes the event's `height` and finds the position in that
  height's list.
- Options: `nodes` (HTTPS URLs, or plain HTTP on this machine), `archive` (`null` to skip the site
  archive), `timeoutMs`, `maxResponseBytes`, `walkTimeMs`, `onWalkProgress`, and `anchors` (`{load, save}`
  to keep the light client's verified checkpoints between runs).
- A verified read checks its checkpoint by walking the committee-signed lineage from the trust anchor in
  the release (or from a checkpoint the client kept), two macroblocks per step, one proof per step: a
  macroblock's committee comes from the checkpoint two below it, so even and odd macroblocks form two
  chains, each walked on its own. One light-client call walks at most 64 steps; the client calls again
  while the walk on the target's chain makes progress, for at most `walkTimeMs` (default
  `DEFAULT_WALK_TIME_MS`, 5 minutes). The light client walks one chain at a time: verified reads that run
  at once in one process on the same chain share that walk, and a read that waits for another's call goes
  on while that walk makes progress, so each gets its answer within its own `walkTimeMs`. `onWalkProgress({verified, target})` reports the highest macroblock verified on the way to
  the one the proof names. A read that stops early answers `verified: false` (`verifyLog`:
  `'consistent'`).
- The client keeps a ladder of the checkpoints its walks verified, for the whole process: on each chain
  the two newest, and the highest of each band of `LADDER_BAND` (64) macroblocks for the newest 128 bands,
  about eight and a half days. It hands the ladder to `anchors.save` after every call, and takes back what
  `anchors.load` returns before a read. A later read, in the same process or, from `anchors`, in a later
  one, starts from the kept checkpoint just below its own on its chain: one step for the newest, at most
  about 33 steps for an older one a walk passed, a whole walk for a chain no read walked yet. Without an
  anchors store every restart walks from the release's anchor again. The light client's memory of
  verified checkpoints is cleared and rooted on the ladder again after 128 new ones, at a moment no other
  read is walking, so a long-running server's memory stays bounded. The anchor is refreshed at each
  release: `npm pack` refuses an anchor more than 7 days old (its `prepack` runs `npm run check:pin`),
  since the first walk grows with the anchor's age, about 480 steps a day.
- The anchors store is a trust root, not a cache: what `load` returns
  is taken as verified, like the release's own anchor, so whoever can write it can make a forged state
  root read as verified. Keep it where only your program can write it; the `qnet` command ignores an
  anchors file other users of the computer can change.

A whole send from a server, as the `qnet` command does it (`development/qnet-sdk/src/cli.ts`):

```js
import { buildTransfer, signTransaction } from '@aiqnet/sdk';
import { NodeClient, unlockKey } from '@aiqnet/sdk/node';

const client = new NodeClient();
const pair = await unlockKey('default', password);   // the key file's password, read without echo
const account = await client.getAccount(pair.address);
const tx = buildTransfer({
  from: pair.address, to: '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d', amountNano: 1_500_000_000n,
  nonce: (BigInt(account.nonce) + 1n).toString(),
});
const signature = signTransaction(tx, pair.secretKey, pair.publicKey);
pair.secretKey.fill(0);
let txHash = null;
try {
  txHash = (await client.submit(tx, signature, account.hasPublicKey ? null : pair.publicKey,
    { publicKeyIfUnresolved: pair.publicKey })).txHash;
} catch (error) {
  // SUBMIT_UNCERTAIN: a node may hold it; wait by nonce, and never build a new transaction for it.
  if (error.code !== 'SUBMIT_UNCERTAIN') throw error;
}
const done = await client.waitForTransaction({ from: tx.from, nonce: tx.nonce, txHash });
```

## Key files

`createKey({name, entropy, password})` stores a key as `~/.qnet/keys/<name>.json` (or
`$QNET_HOME/keys`). The file holds the recovery-phrase entropy encrypted with AES-256-GCM under a key
Argon2id derives from the password with the browser extension's vault parameters (64 MiB, 3 passes,
1 lane, `KEYSTORE_KDF`); no option lowers them, and a file that names less memory or fewer passes is
refused as damaged (`KEYSTORE_CORRUPT`). The name, address, public key and parameters are bound to the
ciphertext, so a changed file does not open. The directory is created `0700` and the file `0600` where
the system has file modes, and a file others can read is refused (`KEY_FILE_PERMISSIONS`). The password
must pass the wallets' new-password rule, compiled from its one source: at least 8 characters
(`PASSWORD_MIN_CHARS`), nothing else (`WEAK_PASSWORD`).
`unlockKey(name, password)` returns `{address, publicKey, secretKey}` (wipe `secretKey` after use) or
throws `WRONG_PASSWORD`. `createKey` never overwrites a key (`KEY_EXISTS`), also when another process
stores one under the same name at the same moment: the file is written and synced under a temporary
name and then given its name by a hard link (an exclusive copy where the file system has none), which
fails when the name exists.

## Errors

Every failure is a `QNetError` with a stable `code` and a fixed message; `QNetNodeError` adds the node's
`reason` and `retryAfterSeconds`, `QNetProviderError` the wallet's `providerCode`. No key, recovery
phrase, password or signature is ever placed in an error.

## Build and test

```
cd development/qnet-sdk
npm ci
npm run build       # dist/, and the declarations
npm test            # builds, then runs test/*.test.mjs against dist/
npm run typecheck
```

The tests never reach a public node: a local mock node serves answers recorded from the testnet
(`test/fixtures/`) and the node handlers' own shapes. They cover the transaction vectors, sign-in,
the module check against the built templates in `contracts/`, key files (wrong password, six kinds
of tampering), the node client and the command line.

## Related documents

- [dApp integration](dapp-integration.md): the provider behind `QNetWallet`
- [Sign-in](sign-in.md) and [Transactions](transactions.md): the formats the SDK builds
- [CLI](cli.md): the `qnet` command
- [RPC API](rpc-api.md): the routes `NodeClient` reads

# @aiqnet/sdk

The QNet developer kit: wallet connection and sign-in for web pages, the transaction builders the wallets use, a
client for the nodes' HTTP API, encrypted key files, and the `qnet` command line. Version 2.0.0, ES modules with
type declarations, Node 20 or later and current browsers.

| Import | Runs in | What it holds |
| --- | --- | --- |
| `@aiqnet/sdk` | pages and Node | `findWallet` / `QNetWallet` (the page talks to the user's wallet), sign-in (`createSignInMessage`, `verifySignIn`, `createNonceStore`), transaction builders, `signTransaction`, `requestBody`, `checkModule`, amounts |
| `@aiqnet/sdk/node` | Node | `NodeClient` (reads, verified balance, events, transaction lookup, submit, wait), key files (`createKey`, `unlockKey`, `listKeys`) |
| `qnet` | Node | the command line (`qnet --help`) |

A page asks the wallet for anything it signs or sends (connect, sign a message, send, transaction status). Public
chain data it reads from the nodes' public routes, which allow any origin, or through its own server.

## Install

The package is not published to the npm registry, and no registry name is QNet's until it is: never run
`npm install @aiqnet/sdk` (or any other name) against the registry, since whoever holds that name would run code
beside your keys. Build it from this repository and install the file:

```
cd development/qnet-sdk
npm ci
npm pack                          # builds dist/ and writes aiqnet-sdk-2.0.0.tgz
sha256sum aiqnet-sdk-2.0.0.tgz    # keep the checksum with the file you copy (Windows: certutil -hashfile <file> SHA256)

cd /path/to/your/project
npm install /path/to/aiqnet-sdk-2.0.0.tgz        # the library
npm install --global /path/to/aiqnet-sdk-2.0.0.tgz   # the qnet command
```

`npm pack` first checks that the light-client pin compiled in (the mobile app's, in
`applications/qnet-mobile/src/config/genesisConsensus.js`) is at most 7 days old, and stops otherwise: pull a newer
revision of the repository, or refresh the pin with `node scripts/ws-pin.js --write` in `applications/qnet-mobile`.

The package name `@aiqnet/sdk` is what `import` names once it is installed from that file.

The transaction formats are not copied here. `build.mjs` compiles them from their one source,
`applications/qnet-mobile/src/crypto` (with the wallet extension's key derivation and account-proof fold from
`applications/qnet-wallet/tools/crypto-bundle/src`), and the tests check the build against the app's known answers
(`applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json`).

## In a page

```js
import { findWallet } from '@aiqnet/sdk';

const wallet = await findWallet();                 // null when no QNet wallet is installed
const { qnet } = await wallet.connect();           // the user approves the site once
const sent = await wallet.sendTransfer({ to: '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d', amount: '1.5' });
// (sent.from, sent.nonce) is the transaction's identity; sent.txHash is one node's name for its copy.
const status = await wallet.getTransactionStatus({ from: sent.from, nonce: sent.nonce });
```

`sendTokenTransfer({ token, to, amount })` moves a built-in token; `callContract({ contract, method, args, gasLimit })`
calls a WebAssembly contract with `args` as hex. A call carries no QNC, and the network records whether a call
reached a block, not what the contract did: read the contract's events or state for that.

## Sign-in

```js
// Server: issue a nonce to the session that asks for it, and keep it until it is used.
import { createNonceStore, verifySignIn } from '@aiqnet/sdk';
const nonces = createNonceStore();
const nonce = nonces.issue(sessionId); // the id of this visitor's session: a random cookie your server set

// Page: the wallet signs the sign-in text for this page's origin.
const signed = await wallet.signIn({ nonce, statement: 'Sign in to play' });

// Server: the text names this site and network, is inside its validity window, the key is the account's own,
// the signature verifies for this origin, and the nonce was issued to this session and is used for the first time.
const { address } = await verifySignIn(signed, { origin: 'https://games.aiqnet.io', consumeNonce: (n) => nonces.consume(n, sessionId) });
```

`createNonceStore` keeps nonces in one process, at most `max` (100,000 by default); when full it drops the oldest to
make room, so a flood cannot stop it issuing, and an issue costs the same whether the store is full or not. A flood
still pushes out nonces visitors have not used yet, sooner than they can sign in once it asks for `max` nonces within
a few minutes. Anyone can ask for a nonce, so rate-limit the route that issues them per client. Several servers need a shared store with the same rule: a nonce this server issued to this session, accepted once.

Each nonce belongs to the session that asked for it (`issue(sessionId)`, `consume(nonce, sessionId)`): a sign-in
someone made with his own wallet and replays into another visitor's browser carries a nonce issued to his session, and
is refused there. Accept the verify request only as `application/json` with your own `Origin`; the rules are in
docs/developers/sign-in.md, "Sessions and cross-site requests".

## Command line

```
qnet keys import                  # a 12- or 24-word recovery phrase, then a password; nothing secret is printed
qnet balance --verified
qnet transfer --to <address> --amount 1.5
qnet check contract.wasm          # the local check of the deploy rules
qnet deploy contract.wasm
qnet call <contract> run --args-utf8 "hello"
qnet logs <contract> --from 2210000
```

Every send shows what it will sign and asks first (under `--json` the review goes to standard error); `--dry-run`
prints the exact signed text and sends nothing, and `--yes` confirms without a terminal. When no node confirms a send
and one that gave no answer may have taken it, the command waits for the account's nonce instead of reporting a
failure, and says to send again only with `--nonce` set to the same nonce, so that at most one of the two can apply.
Keys are files in `~/.qnet/keys` (or `$QNET_HOME/keys`), encrypted with AES-256-GCM under an Argon2id key of the
password with the wallet extension's vault parameters, which are also the least a key file may name; readable by the
user only where the system has file modes. The light client's verified checkpoints (`~/.qnet/anchors-testnet.json`,
or `$QNET_HOME/anchors-testnet.json`, one level above the key files) are a trust root too: a file other users can
change is ignored, and the file is written only while its directory is the user's alone, never through a link.
`balance --verified` shows the balance as of the proof's height and how far that is below the chain's tip; a proof
more than 270 blocks below it is not verified. Its walk up the signed checkpoints shows its progress and keeps
checkpoints of what it verified as it goes; even and odd macroblocks form two chains of checkpoints, walked on their
own, so a run that stops early is continued by the next run whose proof is on the same chain, and the message says
whether the other chain has checkpoints kept yet. `transfer` and `token transfer` refuse a
contract recipient: no contract can send QNC or a built-in token on. `--network testnet` is the default and only
network. There is no QNC faucet: test QNC comes from a funded wallet.

A deploy goes to `POST /api/v1/contract/deploy` with gas 500,000 + 10 per byte of the deploy payload. No transaction
may carry more than 1,000,000 gas, so a module can be at most 24,949 bytes. The contract templates and their build
are in [`contracts/`](../../contracts/README.md).

## Build and test

```
npm ci
npm run build       # dist/, and the declarations
npm test            # builds, then runs test/*.test.mjs against dist/, one file at a time
npm run check:pin   # the light-client pin is at most 7 days old (npm pack runs it first)
npm run typecheck
```

The tests never reach a public node: they use a local mock node that serves answers recorded from the testnet
(`test/fixtures/`) and the node handlers' own shapes.

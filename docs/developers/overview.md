# Building on QNet

This is the starting point for developers: what the public testnet offers today, which pieces a web
page, a server and a contract author use, and where each one is described. Every statement here is
taken from the code in this repository; where a document and the code disagree, the code is
authoritative.

## The network in brief

| Property | Value |
| --- | --- |
| Network | public testnet, chain id `q1337` (`QNET_CHAIN_ID = 1337`); the text every transaction signs starts with the tag `q1337\|` |
| Blocks | one microblock per one-second slot; checkpoints are certified by a committee quorum certificate |
| Coin | QNC, 9 decimals: 1 QNC = 1,000,000,000 nano-QNC |
| Addresses | 45 lowercase characters, `{19 hex}eon{15 hex}{8 hex checksum}`, derived from the ML-DSA-65 public key |
| Signatures | ML-DSA-65 (FIPS 204): signature 3,309 bytes, public key 1,952 bytes |
| Public nodes | `https://node1.aiqnet.io` … `https://node5.aiqnet.io` |
| Site and archive | `https://aiqnet.io` (explorer, full transaction history) |

There is no public QNC faucet. Test QNC comes from a wallet that already holds some.

## Who talks to what

```
web page ── provider requests ──▶ QNet wallet (browser extension, or the app's in-app browser)
                                        │ builds, shows, signs
                                        ▼
your server / CLI ── HTTPS ─────▶ QNet node REST API ◀── wallet submits and reads
```

- **A web page talks to the wallet for everything it signs or sends.** A page connects to the user's
  wallet, asks it to sign a message or send a transaction, and asks it where that transaction stands.
  See [dApp integration](dapp-integration.md). The nodes' public routes allow any origin with no
  credentials, so a page may also read public chain data from them ([RPC API](rpc-api.md#cors)).

- **A server or a command line talks to the nodes.** Requests without an `Origin` header (servers,
  scripts, the `qnet` command) are served normally, within the per-IP rate limits. See the
  [RPC API](rpc-api.md) and the [SDK](sdk.md).
- **Keys stay with their owner.** A page never sees a key or a recovery phrase; the wallet builds
  every transaction from typed fields and shows it before signing. A server holds only its own keys,
  in the encrypted key files of the [CLI](cli.md).

## What you can build today

| Task | How | Document |
| --- | --- | --- |
| Connect a page to the user's wallet, react to account changes | provider announcement event, `qnet_requestAccounts`, `accountsChanged` | [dApp integration](dapp-integration.md) |
| Sign users in with their QNet address | a sign-in text the wallet signs for the page's origin, checked on your server | [Sign-in](sign-in.md) |
| Ask the user to send QNC, a built-in token or a contract call | `qnet_sendTransaction` with `type` `transfer`, `tokenTransfer` or `contractCall` | [dApp integration](dapp-integration.md), [Transactions](transactions.md) |
| Follow a transaction the user sent | `qnet_getTransactionStatus` by (`from`, `nonce`) | [dApp integration](dapp-integration.md) |
| Read balances, tokens, events and transactions from a server | node REST API, verified reads where a proof exists | [RPC API](rpc-api.md), [SDK](sdk.md) |
| Send transactions from a server or a terminal | `@aiqnet/sdk` builders and the `qnet` command | [SDK](sdk.md), [CLI](cli.md) |
| Write, build, check and deploy a WebAssembly contract | `contracts/` templates and tool, `qnet deploy` | [Smart contracts](smart-contracts.md), [CLI](cli.md) |

Where a page finds a wallet: the browser extension offers its provider on `https://aiqnet.io` and
`https://games.aiqnet.io` only; the QNet app's in-app browser offers it on every HTTPS page it opens. For
any page of `link.aiqnet.io`, and for the site's home page and its `/node`, `/activate`, `/wallet`, `/l`,
`/docs`, `/dao`, `/testnet` and `/qnet-wallet-extension` pages, the app opens `https://aiqnet.io/explorer`
instead ([dApp integration](dapp-integration.md#where-a-page-gets-a-provider)).

## Limits you design around

These are properties of the network as it runs today, not wallet choices.

- **One transaction in flight per account.** A node admits a transaction only at the committed
  nonce + 1. The next one can be sent when the previous one is in a block.
- **A transaction's identity is (`from`, `nonce`).** The hash is assigned by the node that received
  the transaction and covers the time it arrived, so two nodes can name the same signed transaction
  with two hashes. Track transactions by sender and nonce.
- **In a block is not the same as applied.** The node records no outcome: a transaction that failed
  at apply and a contract call that reverted both read as `confirmed`. A transfer shows its effect in
  the balances and nonce; a contract call shows it in the contract's events and storage.
- **Calls carry no QNC and cannot name other contracts.** A contract call's `amount` is always 0, and
  the call route cannot carry an access list, so a submitted call cannot reach another contract.
- **Read-only calls of a WebAssembly contract return no value.** Read contract state from storage and
  events instead ([Smart contracts](smart-contracts.md#reading-contract-state)).
- **A deploy carries at most 24,949 bytes of module.** The deploy gas grows with the module size and
  no transaction may carry more than 1,000,000 gas.
- **Nodes keep about a day of history.** The transaction index covers the last 100,000 blocks and the
  event store the retained block bodies; older transactions are in the site archive
  (`https://aiqnet.io/api/tx/{hash}`).

## Documents

| Document | Covers |
| --- | --- |
| [dApp integration](dapp-integration.md) | The wallet provider a page talks to: discovery, methods, results, errors, events |
| [Sign-in](sign-in.md) | Signing users in with a wallet signature and checking it on a server |
| [Transactions](transactions.md) | Transfer, token transfer, contract call and deploy: signed text, gas, fees, submit, status |
| [Smart contracts](smart-contracts.md) | The WebAssembly VM, host functions, limits, events, templates, deploying |
| [SDK](sdk.md) | `@aiqnet/sdk`: wallet connection, sign-in, builders, node client, key files |
| [CLI](cli.md) | The `qnet` command |
| [RPC API](rpc-api.md) | The HTTP routes a node serves; the light-node device and binding routes name their bodies and refusals in [light node messages](../protocols/light-node-messages.md) |
| [Security](security.md) | What a developer must do to keep users and servers safe |
| [1DEV burn contract](1dev-burn-contract.md) | The Solana program behind Phase 1 node activation |
| [QNet Link v1](../protocols/qnet-link-v1.md) | How aiqnet.io asks QNet Wallet for its addresses, its consent to a node or a move of the node balance, and the extension to activate a node |

# dApp integration

A web page never holds a QNet key. It finds the user's QNet wallet through a provider the wallet
injects into the page, asks it for the user's address, and asks it to sign or send; the wallet shows
every request to the user in its own window or sheet and does the signing itself. This document is
the page-facing contract of that provider, as the two wallets implement it:

- the browser extension (`applications/qnet-wallet`, contract in `applications/qnet-wallet/CONTRACTS.md`
  section 4, internals in [Browser wallet](../applications/browser-wallet.md#page-provider));
- the in-app browser of the QNet app (`applications/qnet-mobile/src/browser`, internals in
  [Mobile wallet](../applications/mobile-wallet.md#in-app-browser)).

Both announce the same provider with the same methods, parameters, results, errors and events.
Where they differ, the difference is listed under [Differences between the wallets](#differences-between-the-wallets).

## Where a page gets a provider

| Wallet | Pages | Announced `channel` |
| --- | --- | --- |
| Browser extension, store build | top frame of `https://aiqnet.io/*` and `https://games.aiqnet.io/*`, and no other site | `extension` |
| Browser extension, development build (`npm run build:dev` in `applications/qnet-wallet`) | the same, plus plain-HTTP `http://localhost/*` and `http://127.0.0.1/*` on any port | `extension` |
| QNet app, in-app browser | top frame of every HTTPS page it opens, except the pages it never loads: every page of `link.aiqnet.io`, the site's `/node`, `/activate`, `/wallet` and `/l` pages, and the pages the site keeps out of the app's view (its home page, `/docs`, `/dao`, `/testnet` and `/qnet-wallet-extension`); for those it opens `https://aiqnet.io/explorer` instead | `mobile` |

A page on any other host, or in a subframe, gets no provider.

## Finding the wallet

The wallet dispatches a `qnet:announceProvider` event on `window` when the page starts and again each
time the page dispatches `qnet:requestProvider`. The event's `detail` is frozen:

| Field | Value |
| --- | --- |
| `info.uuid` | a random id per page load |
| `info.name` | `'QNet Wallet'` |
| `info.icon` | a `data:` URI |
| `info.rdns` | `'io.aiqnet.wallet'` |
| `info.channel` | `'extension'` or `'mobile'` |
| `provider` | `{isQNet: true, request({method, params}), on(event, listener), removeListener(event, listener)}` |

The same object is also set as `window.qnet` (not writable). The announcement is the one to rely on:
the SDK's `findWallet` listens for it and falls back to `window.qnet` only when no announcement came.

```js
// What findWallet does (development/qnet-sdk/src/provider.ts), without the SDK:
window.addEventListener('qnet:announceProvider', (event) => {
  const { info, provider } = event.detail;
  if (info.rdns !== 'io.aiqnet.wallet' || typeof provider.request !== 'function') return;
  // info.channel is 'extension' or 'mobile'
});
window.dispatchEvent(new Event('qnet:requestProvider'));
```

The `rdns` and `channel` fields choose a wallet; they do not authenticate it. What protects the user
is the wallet's own approval, which shows the page's origin as the wallet reads it, never a name or
icon the page supplies.

`request({method, params})` returns a promise. It rejects with an `Error` that carries a numeric
`code` ([Errors](#errors)). A request whose JSON exceeds 16,384 characters is refused. There is no
timeout: an approval waits for the user, up to the wallet's own 10-minute limit.

## Methods

| Method | Params | Result | Opens an approval |
| --- | --- | --- | --- |
| `qnet_requestAccounts` | none | `{qnet, solana}` | when the site is not connected yet (the extension also opens one to unlock a locked wallet) |
| `qnet_accounts` | none | `{qnet, solana}`, or `{}` when the site is not connected or the wallet is locked | never |
| `qnet_chainId` | none | `{chainId: 'q1337', network: 'testnet'}` | never |
| `qnet_disconnect` | none | `true`; the site loses access and receives `accountsChanged {}` and `disconnect` | never |
| `qnet_signMessage` | `{message}` | `{signature, publicKey, address}` (hex, hex, EON address) | every time |
| `qnet_sendTransaction` | one of the forms under [Sending transactions](#sending-transactions) | see [Results](#results) | every time |
| `qnet_getTransactionStatus` | `{from, nonce}` | `{status, blockHeight, txHash}` | never |
| `qnet_activateNode` | `{nodeType: 'light' \| 'super'}` | see [QNet Link v1](../protocols/qnet-link-v1.md) section 10 | extension only, and only for `https://aiqnet.io` |
| `qnet_getActivation` | none | what the extension knows of the wallet's activation (its code, a burn on its way, or whether its search found none), see [QNet Link v1](../protocols/qnet-link-v1.md) section 10 | never; extension only, and only for `https://aiqnet.io` (a connected site, at most 30 reads a minute) |
| `qnet_claimNodeBalance` | none | the `claim` answer of [QNet Link v1](../protocols/qnet-link-v1.md) section 14.7, without `v` and `intent` | extension only, and only for `https://aiqnet.io`; moves the node balance of the wallet's own light node |
| `qnet_unlinkNodeDevice` | none | the `unlink` answer of [QNet Link v1](../protocols/qnet-link-v1.md) section 14.7, without `v` and `intent` | extension only, and only for `https://aiqnet.io`; ends the wallet's own light node on the device that runs it |

"None" means the params are absent, `null`, `[]` or `{}`; anything else is -32602.
`qnet_signMessage`, `qnet_sendTransaction` and `qnet_getTransactionStatus` need the site to be
connected first (else 4100). Any other method name is 4200.

`qnet_signMessage` signs text for this page's origin only. The message is 1 to 4,096 UTF-8 bytes; the
wallet refuses, before showing anything, a message that starts like a protocol message (such as a
transaction's `q1337|` tag), holds hidden or control characters, a carriage return not followed by a
line feed, typographic spaces the window would draw as nothing, or a lone surrogate. The signed bytes
and a server-side check are in [Sign-in](sign-in.md).

## Sending transactions

`qnet_sendTransaction` takes exactly one of these forms. Unknown keys are refused (-32602).

| Form | Fields |
| --- | --- |
| QNC transfer | `{to, amount}` or `{type: 'transfer', to, amount}`: `to` an EON address, `amount` QNC as canonical decimal text (`"1.5"`; no sign, exponent or leading zeros; at most 9 fraction digits), above zero |
| Built-in token transfer | `{type: 'tokenTransfer', token, to, amount}`: `token` the token contract's EON address, `amount` in the token's own units as decimal text (at most as many fraction digits as the token has decimals) |
| Contract call | `{type: 'contractCall', contract, method, args, gasLimit?}`: `contract` a WebAssembly contract's EON address; `method` matches `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; `args` the call input as hex of whole bytes, 0 to 4,096 bytes (`""` for none; either case, taken as lowercase); `gasLimit` an optional JSON integer |

A contract call that names `value` or `accessList` is refused with the error
`{code: -32602, message: 'Unsupported parameter', data: {reason: 'UNSUPPORTED_PARAM'}}`: the network
accepts neither on a call today. A page cannot deploy a contract through the wallet; deploys are done
with the [CLI](cli.md).

What the wallet does with a request:

- It sets the nonce, gas price and gas limit itself and builds every signed byte with the shared
  builders (`applications/qnet-mobile/src/crypto/TxBuilders.js`, described in
  [Transactions](transactions.md)).
- **Token transfer.** The wallet reads the token from the chain (`GET /api/v1/token/{contract}`, the
  same answer from two nodes): it must be a built-in fungible token (`qrc20`) with at most 18
  decimals, else -32602; an unreadable token is -32603. The amount becomes base units exactly. The gas
  limit is the call's intrinsic gas. A recipient that holds none of the token yet costs the sender a
  refundable 0.01 QNC storage deposit, which the approval shows. A transfer to the burn address
  `0000000000000000000eon00000000000000036877022` destroys the tokens, and the approval says so, as it
  does for a token that uses QNet's own name.
- **Contract call.** The extension reads the contract first and refuses an address that holds a
  built-in token or no contract (-32602); the in-app browser does not read it and names the contract
  in its sheet. The gas limit is the site's `gasLimit`, which must leave at least 10,000 fuel above the
  call's intrinsic gas and stay within 1,000,000, or by default the intrinsic gas plus 200,000 fuel.
  Fuel the call does not burn is refunded. The approval shows the contract with a warning that the
  wallet does not know it, the method, the input as hex with its size (and as text when it is readable
  text), the gas limit and the maximum fee, and that a call moves no QNC.
- The approval of every transaction arms its Confirm button 1.5 seconds after the window or sheet was
  last left untouched.

### Results

| Form | Result |
| --- | --- |
| QNC transfer | `{status, from, to, amount, nonce, txHash}` |
| Token transfer | `{status, from, token, to, amount, nonce, txHash}` |
| Contract call | `{status, from, contract, method, nonce, txHash}` |

- `status` is `'submitted'` when a node accepted the transaction and named its copy, `'unknown'`
  otherwise (the wallet keeps resending it). It never says that a call succeeded.
- `amount` is canonical decimal text (QNC, or the token's units).
- `nonce` is decimal text. With `from` it is the transaction's identity: at most one transaction of an
  account applies at a nonce.
- `txHash` is the hash one node gave its copy, or `null`. Another node can hold the same signed
  transaction under another hash, and that copy may be the one that lands. Match a transaction by
  (`from`, `nonce`), not by `txHash`.

### Transaction status

`qnet_getTransactionStatus` answers for the connected account only (another `from`, or a locked
wallet, is 4100) and opens nothing. `nonce` is decimal text above zero, as a result gives it.

| `status` | Meaning |
| --- | --- |
| `pending` | the account's nonce on chain is still below it, and the wallet still sends a transaction at it |
| `in_block` | the nonce is used and the nodes the wallet asks agree on the one transaction of `from` at it; `blockHeight` and `txHash` are filled when the nodes report them alike |
| `unknown` | anything else, including a read that failed |

`blockHeight` and `txHash` are `null` unless `status` is `in_block`. In a block does not mean applied:
the network records no outcome, so a call that reverted is also `in_block`. Confirm a call's effect
from the contract's events or storage. An answer is reused for 3 seconds, and one site may start at
most 20 status reads a minute (more: 4001).

```js
// development/qnet-sdk/README.md
const sent = await wallet.sendTransfer({ to: '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d', amount: '1.5' });
const status = await wallet.getTransactionStatus({ from: sent.from, nonce: sent.nonce });
```

The network admits one transaction per account at a time (the committed nonce + 1), so a page that
sends several transactions sends the next one after the previous one is `in_block`.

## Errors

| `code` | `message` | When |
| --- | --- | --- |
| 4001 | `User rejected the request` | rejected, window or sheet closed, approval timeout (10 minutes), too many requests from the site waiting, too many status reads |
| 4001 | `Too many rejected requests from this site, try again later` | the site is in its rejection pause ([Approvals and limits](#approvals-and-limits)) |
| 4100 | `Unauthorized` | the site is not connected, lost its connection while waiting, or asks about another account; in the app also a locked wallet |
| 4200 | `Unsupported method` | not a method of this wallet |
| 4900 | `Disconnected` | the wallet's side of the page went away |
| -32602 | `Invalid params` | params of the wrong shape, an invalid address or amount, a message the wallet will not sign, a token that is not a fungible built-in token, in the extension a call to a token or to no contract |
| -32602 | `Unsupported parameter`, with `data: {reason: 'UNSUPPORTED_PARAM'}` | a contract call that names `value` or `accessList`; the only error that carries `data` |
| -32603 | `Internal error` | anything else; a page learns nothing about balances or nodes from it |

An insufficient balance, a node refusal and a network failure all come back as -32603 or as
`status: 'unknown'`: the wallet tells the user, not the page.

## Events

| Event | Data | When |
| --- | --- | --- |
| `accountsChanged` | `{qnet, solana}`, or `{}` | the wallet unlocked or the site was connected; `{}` when the wallet locked, the site was disconnected or the wallet was removed |
| `disconnect` | `{code: 4900, message: 'Disconnected'}` | the site was disconnected, by the user or by `qnet_disconnect`, or the wallet was removed |

Events go only to pages of the connected origin. `on` and `removeListener` accept only these two
names (anything else throws `TypeError`).

## Approvals and limits

- One approval is on screen at a time. A site may have at most 3 waiting or shown; the extension
  holds at most 12 in all, the app 16. Past that the request is 4001.
- After the user rejects or closes an approval, the site opens no other approval for 30 seconds; the
  third such rejection within 10 minutes makes the pause 10 minutes. Requests that need no approval
  are still answered.
- Every approval a site opens counts until one of its requests is approved and performed: at most 3
  within a minute and 10 within 10 minutes. Past that, requests that need an approval get the pause
  message.
- The extension answers at most 16 unanswered requests per page connection; more are 4001.
- In the app, a page that is not on screen (another tab, the app in the background) gets 4001
  instead of a sheet.

## Reading chain data from a page

The nodes' public routes allow any origin and read no browser credential ([RPC API](rpc-api.md#cors)),
so a page may read public chain data from them with `fetch`, within the same per-address rate limits as
any caller; their answers are the node's word unless they carry a proof. The routes that answer only
local or genesis callers send no cross-origin headers and take a page's request as an outside one. The
site's own `https://aiqnet.io/api/*` routes set no cross-origin headers. A page:

- asks the wallet about its own transactions (`qnet_getTransactionStatus`), and for anything it signs or
  sends;
- reads other public chain data from a node's public routes, or asks its own server, which reads the
  nodes with `@aiqnet/sdk/node` or plain HTTPS ([SDK](sdk.md), [RPC API](rpc-api.md)).


## With the SDK

`@aiqnet/sdk` wraps all of the above for a page ([SDK](sdk.md)):

```js
// development/qnet-sdk/README.md
import { findWallet } from '@aiqnet/sdk';

const wallet = await findWallet();                 // null when no QNet wallet is installed
const { qnet } = await wallet.connect();           // the user approves the site once
const sent = await wallet.sendTransfer({ to: '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d', amount: '1.5' });
// (sent.from, sent.nonce) is the transaction's identity; sent.txHash is one node's name for its copy.
const status = await wallet.getTransactionStatus({ from: sent.from, nonce: sent.nonce });
```

`sendTokenTransfer({token, to, amount})` and `callContract({contract, method, args, gasLimit})` send
the other two forms; every refusal is a `QNetProviderError` whose `providerCode` is the wallet's code.

## Differences between the wallets

| Rule | Browser extension | In-app browser |
| --- | --- | --- |
| Pages | `aiqnet.io` and `games.aiqnet.io` | any HTTPS page |
| `qnet_activateNode` | on `https://aiqnet.io` only | not offered (4200) |
| `qnet_claimNodeBalance` | on `https://aiqnet.io` only | not offered (4200) |
| `qnet_unlinkNodeDevice` | on `https://aiqnet.io` only | not offered (4200) |
| Locked wallet | the approval window asks for the password first | 4100 at once |
| Confirming | a trusted click on the armed button | the armed button, then the password or the device's biometrics |
| An earlier transaction not yet in a block | Confirm stays off until it is in a block | the user chooses to replace it or to send after it |
| Contract call to a built-in token or to no contract | refused before the window (-32602) | shown and sent; the network does not apply it |
| Largest QNC transfer from a site | amount + fee within the 64-bit range | amount + fee at most 2^53 − 1 nano-QNC (about 9,007,199 QNC) |
| Requests held in all | 12 | 16 |

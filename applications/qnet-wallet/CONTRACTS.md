# QNet Wallet extension 3.1.0: contracts

This file is the single agreement between the modules of the rebuilt extension. The rebuild spec and the
three audit reports (ext-secrets, ext-surface, ext-crypto) are normative; this file turns them into
names, shapes and rules. The JSDoc in each module says the same thing in more detail. If the two ever
disagree, stop and get the contract fixed; do not pick one.

Machine-checked parts: `test/router.test.mjs` (message table, senders, schemas, result guard, provider
port), `test/skeleton.test.mjs` (manifest, shipped-file rules, mirrored constants, export surface,
dev overlay, worker wiring), `test/package.test.mjs` (the extension loads as shipped; the store zip)
and `test/integration.test.mjs` (every module wired as sw.js wires it, pages included). Changing any of
it is a contract change: update this file, the tests and the report together.

## 0. Areas and frozen files

Frozen (change only as a contract change): `dist/manifest.json`, `dist/background/config.js`,
`errors.js`, `amount.js`, `log.js`, `events.js`, `router.js`, `sw.js`, the export list of `dist/ui/common.js`,
`scripts/extension.mjs` (the shipped set and the load check), `scripts/build-dev.mjs`,
`scripts/package.mjs`, `test/helpers/chrome-mock.mjs` (you may add APIs; do not change existing
behaviour), `test/router.test.mjs`, `test/skeleton.test.mjs`.

Implementation areas:

| Area | Files |
|---|---|
| A. Vault and session | `background/vault.js`, `session.js`, `keys.js` |
| B. Chains and activation | `background/qnet.js`, `solana.js`, `activation.js`, `nodes.js` (the light node on the QNet network: its registration and the move of its node balance, section 4.10) |
| C. dApp | `background/provider.js`, `content/relay.js`, `inject/provider.js` |
| D. Pages | `ui/popup.*`, `ui/setup.*`, `ui/approve.*`, `ui/kit.js`, `ui/i18n/*`, `ui/qr.js`, the area-D functions of `ui/common.js`, `_locales/*` |

An area may export more helpers than listed here (tests may need them) but must keep every listed
export with its signature. Every exported function carries JSDoc (checked).

## 1. Conventions

**Code.** ES modules (content scripts are classic IIFEs), UTF-8 without BOM, LF, English identifiers,
short comments only for a non-obvious why. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, `eval`, `new Function`, string timers, `importScripts`, cleartext URLs, or `console.*`
(use `log` from `background/log.js`; it is silent in the store build). Pages build DOM only with
`el()`/`textContent` from `ui/common.js`. All of this is checked over every v3 file.

**Errors.** Modules throw `new WalletError(code)` with a key of `ERROR_MESSAGES` (errors.js). A
`CoreError` from qnet-core passes through with its code when that code is in `ERROR_MESSAGES`. Any
other error becomes `INTERNAL`. The router sends a fixed message per code, never the thrown text, so
an error can never carry a secret, address, amount or code. Extras: `BACKOFF` carries `retryAfterMs`;
`INVALID_PARAMS` carries `field`. The provider maps errors with `toProviderError` (section 4.5). A new
code is a contract change (add it to `ERROR_MESSAGES` in one small edit).

**Numbers and bytes.**

| Value | Form |
|---|---|
| QNC, lamports, 1DEV base units, nonces, fees, gas | u64 **decimal string** of base units (`"150000"`), parsed with BigInt; never a JS number, never a float |
| Amount typed by a user or dApp | canonical decimal string of the asset (`"1.5"`), converted with `amount.parseUnits(text, DECIMALS.X)` |
| Whole 1DEV burned, activation price | safe integer (`1500`) |
| Timestamps, deadlines | ms since epoch, safe integer |
| Bytes in results or events | lowercase hex string (signatures, public keys) |
| Bytes in storage | base64 string (vault record, session) |
| Bytes inside the worker | `Uint8Array` |

Decimals: QNC 9, SOL 9, 1DEV 6 (`config.DECIMALS`).

**Secrets.** The vault entropy, the recovery-phrase seed, the ML-DSA-65 secret key, xi, the Solana private key,
the vault key and the password live only in the worker, only as `Uint8Array` where they are bytes, and
only for the duration of one call (the vault key: for the session). A page holds a typed password or
phrase only until `call()` has sent it, then clears the field's `.value`, and a revealed phrase or code
only while shown. Zeroize with `core.zeroize()` (or `fill(0)`) in `finally`. Only
`keys.js` derives private keys; only `vault.js` decrypts; only `session.js` holds the vault key. No
secret is ever put in `chrome.storage.local`, `localStorage`, `sessionStorage`, a URL, a log line, an
error, a notification or a badge. A JS string cannot be wiped, so a derivation never turns a secret into
one: `core.entropyToSeed` builds the phrase's UTF-8 in a buffer and `core.walletXi` the seed string's
hex, both zeroized after use. The phrase exists as a string only where it must: setup's words, the
`vault.create` / `vault.import` / `vault.restore` params (the popup's restore field is emptied as the
request leaves), the `vault.reveal` result, the words the Copy button of setup or of the reveal puts on the
clipboard after an explicit click (section 8), and, in the worker only, the phrase `vault.migrate` reads out of the
earlier version's record or its pages' copy (its bytes decoded alone, never the keys beside it, the decrypted bytes
zeroized; section 5, Earlier version). `test/vault-session-heap.test.mjs` checks a heap snapshot after lock (R24).

**Results.** Every handler result and every event payload must be JSON data: `null`, booleans, finite
numbers, strings, arrays and plain objects, at most 8 levels deep; no `undefined` (use `null`), no
bigint, no `Uint8Array`, no class instances. None of these key names may appear at any depth:
`mnemonic, phrase, entropy, seed, xi, secretKey, privateKey, key, vaultKey, sitesKey, password,
newPassword, code`. The only exceptions: `vault.reveal` may return `mnemonic`, `vault.exportKey` may return
`privateKey` (decision 40), `activation.burn` and `activation.copy` may return `code`
(`RESULT_KEY_EXCEPTIONS`), and the dApp results of `qnet_activateNode` and `qnet_getActivation` may carry `code`
(`PROVIDER_RESULT_KEY_EXCEPTIONS`). The router enforces this and answers `INTERNAL` (UI) or `-32603` (dApp) instead
of an unsafe result. The light node's results (`activation.register`, `activation.registration`, `qnet_claimNodeBalance`, `node.unlinkView`,
`node.unlink`, `qnet_unlinkNodeDevice`) carry only public values (node id, states, amounts, hashes, the device's platform and
day) and need no exception.

**Text.** Every text a page shows comes from `ui/i18n/<language>.js` through `t()`; an error is shown as
`err_<CODE>` of those tables (`kit.errorText`), never as the router's English message (section 13).

**Lock.** The router calls `session.requireUnlocked()` before every type marked unlocked (section 2.3).
Every signing path calls it again right before deriving a key (`keys.*` do it themselves).

## 2. Extension-page messaging

### 2.1 Envelope

Page → worker, through `common.call(type, params)` only:

```
chrome.runtime.sendMessage({ type, id, params })
  type    string, /^[a-z]+\.[a-zA-Z]+$/, a key of UI_MESSAGES
  id      string /^[A-Za-z0-9_-]{1,64}$/ or a non-negative safe integer
  params  object (optional), exactly the fields of the type
  no other top-level key; whole message JSON <= LIMITS.UI_MESSAGE_MAX_CHARS (16384)
```

Worker → page: `{ id, ok: true, result }` or `{ id, ok: false, error: { code, message, retryAfterMs?,
field? } }`. `id` is echoed (null when the request had no valid id). `result` is `null` when the
handler returned nothing.

### 2.2 Senders

A runtime message is served only if `sender.id === chrome.runtime.id`, `sender.url` is this
extension's `ui/popup.html`, `ui/setup.html` or `ui/approve.html` (query and hash ignored),
`sender.origin` (when present) is the extension origin, `sender.frameId` (when present) is 0, and
`sender.tab.url` (when present) is an extension URL. Everything else, including this extension's own
content script, a compromised renderer, another extension, the worker, `ui/common.js` or a page outside
`ui/`, gets `FORBIDDEN_SENDER` before any parsing. Each type also names the pages allowed to send it.

### 2.3 Order of checks and handler call

sender → envelope (`INVALID_REQUEST`) → known type (`UNKNOWN_TYPE`) → page allowed
(`FORBIDDEN_SENDER`) → params (`INVALID_PARAMS`, unknown keys rejected, a fresh object with only the
declared fields is built; a field is a string, an integer, a boolean, one of a set of values, or a list: an array of at
most a stated number of distinct values of one such kind, copied) → cross-field check → `requireUnlocked()` when marked (`LOCKED`) →
`handler(params, meta)` with `meta = Object.freeze({ page, sender })` → result guard → `session.touch()`
when marked activity (a failed touch is only logged).

### 2.4 Message types

Pages: P popup, S setup, A approve. U: requires unlocked. T: a success extends the auto-lock deadline.
Field types: `password` string 1..1024; `mnemonic` string 1..1024; `qnetAddress` EON with valid
checksum; `solanaAddress` canonical base58 of 32 bytes; `qnc` canonical decimal > 0, at most 9
decimals, <= u64 nano; `u64` canonical u64 decimal string; `uuid` lowercase v4; `restoreToken` 64
lowercase hex characters.

| Type | Pages | U | T | Params | Result | Errors (besides router errors) |
|---|---|---|---|---|---|---|
| `vault.status` | PSA | | | none | `{exists, unlocked, lockDeadline: number\|null, addresses: {qnet, solana}\|null, signingEnabled, backoffUntil: number\|null, earlier: boolean}`; addresses only while unlocked; `earlier`: the wallet an earlier version of this extension kept is still in this browser (section 5, Earlier version) | |
| `vault.create` | S | | | `{mnemonic, password}` (phrase generated by setup, canonical, 12 or 24 words) | `{qnet, solana, lockDeadline}` | `VAULT_EXISTS, WEAK_PASSWORD, INVALID_MNEMONIC, VAULT_CORRUPT, ADDRESS_MISMATCH` |
| `vault.import` | S | | | `{mnemonic, password}` (12 or 24 words, any spacing and case; canonicalized) | `{qnet, solana, lockDeadline}` | same as create |
| `vault.migrate` | S | | | `{password, newPassword?}` (`password`: the earlier version's, as typed; section 5, Earlier version) | without `newPassword` `{checked: true}` (the password opens the earlier wallet; nothing written); with it `{qnet, solana, lockDeadline}` (this version's vault written from the earlier wallet's recovery phrase, read back, the session started; everything the earlier version left removed after that) | `VAULT_EXISTS, NO_VAULT` (no earlier wallet), `WEAK_PASSWORD, BACKOFF, BAD_PASSWORD, VAULT_CORRUPT` (it opens but holds no valid 12- or 24-word phrase), `ADDRESS_MISMATCH` |
| `vault.removeEarlier` | SP | U | | `{confirm: 'REMOVE'}` (the user confirmed it; never typed) | `{removed: true}`: every key the earlier version wrote to `chrome.storage.local` and its pages' IndexedDB database `QNetWallet` removed, both copies of its encrypted wallet among them; only while a vault of this version exists | `NO_VAULT, INTERNAL` (something stayed) |
| `vault.unlock` | PA | | | `{password}` | `{qnet, solana, lockDeadline}` | `NO_VAULT, BACKOFF, BAD_PASSWORD, KDF_BELOW_FLOOR, VAULT_CORRUPT, ADDRESS_MISMATCH`; `LOCKED` when the user, the OS screen lock or a browser start locked while the password was checked, or the screen is locked now (R3-ESM-03: no session starts behind a locked screen) |
| `vault.lock` | PA | | | none | `{locked: true}` | |
| `vault.changePassword` | P | U | T | `{password, newPassword}` | `{changed: true}` | `BACKOFF, BAD_PASSWORD, WEAK_PASSWORD` |
| `vault.reveal` | P | U | T | `{password}` | `{mnemonic}` (the only response with this vault's phrase) | `BACKOFF, BAD_PASSWORD` |
| `vault.exportKey` | P | U | T | `{password, network: 'qnet'\|'solana'}` (decision 40) | `{network, address, privateKey}`: QNet the 32-byte ML-DSA-65 KeyGen seed as 64 lowercase hex characters, Solana the 64-byte secret key (private seed, then public key) in base58; derived and checked against the session's address after a fresh password check (the only response with a private key) | `BACKOFF, BAD_PASSWORD, SIGNING_DISABLED, ADDRESS_MISMATCH, NO_VAULT` |
| `vault.wipe` | P | | | `{password, confirm: 'DELETE'}` | `{wiped: true}` | `NO_VAULT, BACKOFF, BAD_PASSWORD, INTERNAL` |
| `vault.restoreBegin` | P | | | `{}` | `{token: restoreToken, expiresAt}` (section 5, Restore) | `NO_VAULT` |
| `vault.restore` | P | | | `{token: restoreToken, mnemonic, password, confirm?: 'ERASE', replaceOther?: boolean}` (phrase canonicalized; `confirm`: the user confirmed the reset; `replaceOther`: the phrase is another wallet's, as the check answered) | `{status: 'restored', qnet, solana, lockDeadline: number\|null}` (`lockDeadline` null: the screen locked meanwhile and the new vault stays locked) or `{status: 'confirm', erased: {qnet, solana}\|null, restored: {qnet, solana}, otherWallet: boolean}` (no `confirm`, or another wallet without `replaceOther`: nothing erased, the token stays valid; `erased` null: the stored record does not parse) | `RESTORE_EXPIRED, WEAK_PASSWORD, INVALID_MNEMONIC, NO_VAULT, SIGNING_DISABLED, VAULT_CORRUPT, ADDRESS_MISMATCH, INTERNAL` |
| `wallet.addresses` | PA | U | | none | `{qnet, solana}` | |
| `wallet.cached` | P | U | | none | `{qnetBalance: QnetBalance\|null, qnetHistory: {items, cursor, pending}\|null, solanaBalances: SolanaBalances\|null, solanaHistory: {items, cursor}\|null, qnetTokens: TokenList\|null}`: the last answer of each this session served (decision 39: `qnet.balance`, `qnet.tokens`, `solana.balances`, and `qnet.history` / `solana.history` without a cursor), null for one not read yet; dropped by every lock and every new session. A balance view (`qnetBalance` when verified, `qnetTokens`, `solanaBalances`) not read in this session comes from the vault's chain cache, where the last one is kept across sessions (decision 40) | |
| `qnet.balance` | P | U | | none | `QnetBalance` | `NETWORK, BALANCE_UNCONFIRMED` |
| `qnet.history` | P | U | | `{cursor?: string\|null (printable ASCII <= 512), limit?: 1..50}` | `{items: HistoryItem[], cursor: string\|null, pending: HistoryItem[]}` | `NETWORK` |
| `qnet.tokens` | P | U | | none | `TokenList` (section 2.5; decision 40): the built-in QRC-20 tokens the wallet holds, each named by two nodes, each balance certified (decision 44) | `NETWORK` (no node listed the wallet's tokens) |
| `qnet.tokenPreview` | P | U | | `{token: qnetAddress, to: qnetAddress, amount}` (`amount`: a canonical decimal of the token's units, at most 18 decimals, > 0) | `TokenPreview` (section 2.5): `qnet.prepareCall` of the token transfer with the token's details, the recipient check and the reserved-name and burn-address flags; a recipient that is a contract gets no review | `NETWORK, BALANCE_UNCONFIRMED, BALANCE_FOREIGN_PENDING, NONCE_UNAVAILABLE, INVALID_PARAMS` (not a QRC-20 token), `INVALID_AMOUNT, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED` |
| `qnet.tokenSend` | P | U | T | `{token, to, amount, expectedFeeNano: u64, expectedDepositNano: u64, expectedNonce?: u64}` | `{txHash: string\|null, status: 'submitted'\|'unknown', nonce, from}` (`qnet.sendCall`, a site's token transfer's path and checks) | those of `qnet.sendCall`, `INVALID_PARAMS, INVALID_AMOUNT` |
| `qnet.txLookup` | P | U | | `{hash}` (16..128 letters and digits) | `{status: 'in_block'\|'unknown', blockHeight: number\|null}`: whether two pinned nodes list the transaction in a block at the same height (the History detail of an unverified row) | |
| `qnet.preview` | P | U | | `{to: qnetAddress, amount: qnc, replaceNonce?: u64}` (`replaceNonce`: review a transfer that replaces the outstanding one of that nonce) | `TransferPreview` with `recipient: RecipientCheck\|null`; a recipient that is a contract gets no review (`qnet.assertPayableRecipient`, EXT-R2A-01) | `NETWORK, BALANCE_UNCONFIRMED, BALANCE_FOREIGN_PENDING, NONCE_UNAVAILABLE, NONCE_CHANGED, INVALID_AMOUNT, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED` |
| `qnet.send` | P | U | T | `{to, amount: qnc, expectedFeeNano: u64, expectedNonce?: u64, replaceNonce?: u64}` | `{txHash: string\|null, status: 'submitted'\|'unknown', nonce}` (`txHash`: what one node returned, not shown or linked: R2-EXTQ-06) | `SIGNING_DISABLED, FEE_CHANGED, NONCE_CHANGED, NONCE_UNAVAILABLE, BALANCE_UNCONFIRMED, BALANCE_FOREIGN_PENDING, INSUFFICIENT_FUNDS, TOO_MANY_PENDING, NODE_REJECTED, NETWORK, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED` |
| `solana.balances` | P | U | | none | `SolanaBalances` | `SOLANA_UNAVAILABLE` |
| `solana.history` | P | U | | `{cursor?: string\|null (printable ASCII <= 512), limit?: 1..LIMITS.SOLANA_HISTORY_PAGE_MAX (25)}` (decision 39) | `{items: SolanaHistoryItem[], cursor: string\|null}`: the wallet's own Solana transactions, newest first, at confirmed (section 2.5) | `SOLANA_UNAVAILABLE`, `INVALID_PARAMS` (a cursor it did not give) |
| `solana.quote` | P | U | | `{asset: 'sol'\|'1dev', to: solanaAddress, amount, references?: solanaAddress[], memo?: string}`; amount > 0 with at most the asset's decimals; `references` and `memo`: a payment request's (decision 34), at most `PAYMENT_REQUEST.REFERENCES_MAX` (4) distinct addresses and a memo of `config.isPaymentRequestMemo` | `SolanaQuote` (with the recipient check and `shortfall`: why the send would fail as reviewed, which the review names and `solana.send` refuses; `references` and `memo` as the transaction carries them) | `SOLANA_UNAVAILABLE, INVALID_AMOUNT, INVALID_ADDRESS, TX_TOO_LARGE` (the signed transaction would exceed `SOLANA.TRANSACTION_MAX_BYTES`) |
| `solana.send` | P | U | T | quote params (the same `references` and `memo`) + `{expectedFeeLamports: u64, expectedRentLamports: u64}` | `{signature, status: 'finalized'\|'confirmed'\|'submitted', lastValidBlockHeight: number\|null}`: sent, and its status read once (`submitted`: not confirmed at that read; the popup follows it with `solana.status`); `lastValidBlockHeight` of its blockhash | `SIGNING_DISABLED, FEE_CHANGED, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS, AMOUNT_BELOW_RENT, SOL_BELOW_RENT, BLOCKHASH_EXPIRED` (simulation found the blockhash gone: nothing sent, review again), `SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE, TX_TOO_LARGE` |
| `solana.max` | P | U | | `{asset: 'sol'\|'1dev', to?: solanaAddress}` (the send form's Max; `to`: the recipient typed so far) | `{amount, amountRaw}`: SOL, the balance at confirmed less this transfer's fee (the account ends empty); a token, its whole balance | `SOLANA_UNAVAILABLE, INVALID_ADDRESS, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS, SOL_BELOW_RENT, AMOUNT_BELOW_RENT` |
| `solana.status` | P | U | | `{signature: base58 of 64 bytes, lastValidBlockHeight?: safe integer >= 0 \| null}` (from `solana.send`) | `{status: 'pending'\|'confirmed'\|'finalized'\|'failed'\|'expired'}`: `failed` only at confirmed or finalized; `expired`: no trace of it once the finalized height passed its `lastValidBlockHeight`, looked up again after that height was read (nothing spent) | `SOLANA_UNAVAILABLE` |
| `activation.status` | P | U | | none | `{activation: PublicActivation\|null, pending: PendingBurn\|null, busy: boolean, superseded: PublicBurn\|null, registration: RegistrationView\|null}` (`registration`: the light activation's record on the QNet network, section 4.10; null for none, a Super activation, or an activation of an earlier build) | |
| `activation.lookup` | P | U | | none | `ActivationLookup` (section 2.5; decision 35): the Activate tab's one view of the vault, aiqnet.io's record of the wallet's burn, the QNet network and the shared search of the wallet's own address; never a code | |
| `activation.price` | P | U | | none | `PriceQuote` | `PRICE_UNAVAILABLE` |
| `activation.burn` | P | U | T | `{nodeType: 'light'\|'super', expectedPrice: 1..1e9 integer}` (no password: the unlocked session and the popup's acknowledged press, decision 33) | `{status: 'finalized', code, activation: PublicActivation}` or `{status: 'pending', burnTx}` | `BURN_IN_PROGRESS, ALREADY_ACTIVATED, BURN_EXISTS, BURN_UNUSABLE, ACTIVATION_RECORDED, ACTIVATION_RESERVED, RECORD_UNAVAILABLE` (aiqnet.io's record of the wallet's burn, its reservation, or no answer from it: nothing signed or sent, decision 35), `NODE_EXISTS, NETWORK` (the QNet network could not vouch that the wallet has no node: nothing signed), `PRICE_UNAVAILABLE, PRICE_CHANGED, PHASE_UNSUPPORTED, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS, SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG, SIGNING_DISABLED` |
| `activation.recover` | P | U | T | none | `{found, complete, activation: PublicActivation\|null}` (no burn of the phrase's addresses and no pending burn: the burn the node's registration record names for the wallet's light node, section 4.10, then aiqnet.io's record of a burn of the wallet's own address, decision 35) | `BURN_IN_PROGRESS, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG, BURN_UNUSABLE` (only burns of this wallet no code derives from were found: R4-ESA-01) |
| `activation.copy` | P | U | T | none (no password: decision 33) | `{code}`: the code Settings shows (decision 43: the vault's, or that of aiqnet.io's record `activation.lookup` showed as the wallet's code) | `NOT_FOUND` |
| `activation.register` | P | U | T | none (no password: decision 33) | `{registration: RegistrationView\|null}`: Record on the network (`nodes.requestRecord`): the vault's light activation gets its registration queued (again, when it stopped: refused, the clock, or past the attempt cap), and one attempt runs now (section 4.10); a network answer is the record's state, never an error | `NOT_FOUND` (no light activation), `SIGNING_DISABLED` |
| `activation.registration` | PA | U | | none | `{registration: RegistrationView\|null}` (`nodes.getRegistration`): the popup's status line and the activation window after its answer read it; a due step starts in the background (an activation of an earlier build is looked up on chain, at most every `TIMINGS.REGISTRATION_CHECK_MS`) | |
| `node.unlinkView` | P | U | | none | `UnlinkView` (section 2.5; decision 38): the light node's device; nothing signed. No page sends it since decision 41 (the Activate tab has no Device card; the device is unlinked at aiqnet.io's request, `qnet_unlinkNodeDevice`, whose approval shows the same view); the entry stays in the frozen table | |
| `node.unlink` | P | U | T | none (no password: the unlocked session and the armed press, decision 33) | `{status: 'ok', qnet, nodeId, unbound: true}` (`nodes.unlinkForSite`, section 4.10). No page sends it since decision 41; the entry stays in the frozen table | `NOT_LINKED, NETWORK, UNLINK_REFUSED, SIGNING_DISABLED` |
| `sites.list` | P | U | | none | `{sites: [{origin, originDisplay, idn, grantedAt, chains}]}` | |
| `sites.revoke` | P | U | T | `{origin}` (canonical origin) | `{revoked: boolean}` | |
| `settings.get` | PSA | | | none | `{autoLockMinutes: 5\|15\|30\|60\|'never'\|null, language}` (null while locked); `language` is the stored one, else the browser's UI language (`chrome.i18n.getUILanguage()` through `config.languageForTag`) when the UI has it, else `'en'` | |
| `settings.set` | P | U | T | `{autoLockMinutes?: 5\|15\|30\|60\|'never', language?: SUPPORTED_LANGUAGES}`, at least one (`'never'`: no inactivity timer) | same as get | `VAULT_CORRUPT` |
| `approval.get` | A | | | `{id: uuid}` | `ApprovalView` | `NOT_FOUND` |
| `approval.resolve` | A | | T | `{id: uuid, approved: boolean, revision?: integer}` (no password for any kind: a `password` field is `INVALID_PARAMS`, the unlocked session and the armed press in the approval's own window confirm, section 4.8; `revision`: the `ApprovalView.revision` the page drew, required by a transaction's (`sendTransaction`, `tokenTransfer`, `contractCall`), an `activateNode`, a `claimNodeBalance` or an `unlinkNodeDevice` confirm: another one is `NONCE_CHANGED` / `PRICE_CHANGED` and the window reviews again) | `{resolved: true}`; for `activateNode` also `{status: 'ok'\|'exists'\|'pending'\|'error', error: code\|null}`, `nodeType: 'light'\|'super'` for `ok` and `exists` (the node type of the code the site received: the window adds the server's next step for a Super code, decision 36), and `registration: {nodeId, state, automatic, deferred}` after a light answer while the node has a record on the QNet network; for `claimNodeBalance` also `{status: 'ok'\|'empty'\|'error', error: code\|null}` and, for `ok`, `{amountNano, partial}`; for `unlinkNodeDevice` also `{status: 'ok'\|'error', error: code\|null}` (the wallet's own code, for the window's text) | `NOT_FOUND, LOCKED, INVALID_PARAMS`, errors of the approved action; `activateNode`: `LOCKED, PRICE_CHANGED` (the approval stays open) |
`LOCKED` can come from every U type. A dApp never reaches any of these types.

### 2.5 Result shapes

- `QnetBalance`: `{balanceNano, spendableNano, nonce, verified, verification: 'proof'|'none', blockHeight: number|null}`
  (decision 44). `'proof'`: the account proof folds to the state root of a macroblock whose committee certificate the
  light client verified, within 2 of the certified head, below or above it (`qnet.certifiedIndexStands`, R2-EXTQ-01);
  `balanceNano` and `nonce` are that certified state's and `blockHeight` its height. `'none'` (`verified` false): a
  figure whose proof folds only under the root its node named, shown with the line "This balance is not confirmed yet.",
  never a 0 and never kept across sessions; no figure at all is `NETWORK` (no node answered) or `BALANCE_UNCONFIRMED`.
  Two agreeing nodes verify nothing. `spendableNano`: the send rule's "available" (`qnet.transferSnapshot`, decision 44):
  the balance less what this wallet's own transactions since that state took and may still take, '0' while a nonce in
  between is none of its own.
- `TransferPreview`: `{from, to, amountNano, feeNano, totalNano, nonce, balanceNano, verified: true,
  verification: 'proof', outstanding: OutstandingTransfer[], replacesNonce: string|null, inFlight}`: a preview exists only
  on a certified balance (the send rule, decision 44; otherwise `NETWORK`, `BALANCE_UNCONFIRMED` or
  `BALANCE_FOREIGN_PENDING`); `balanceNano` is what that rule leaves to spend. `nonce` is the nonce the transfer will be
  signed with. `outstanding`: this wallet's earlier transactions not
  seen applied (`{nonce, to, amountNano, feeNano, createdAt, stale, refused, kind: 'transfer'|'call'}`; a call's `to` is
  its contract, and the popup names it as a contract call); their nonces and amounts are reserved, stale ones too.
  `inFlight`: one of them still holds the nonce before this one's (section 4.9). A transfer sent with `replaceNonce` takes that outstanding transfer's nonce, so only one of the two
  can ever apply (R2-EXTQ-03); the transfer it replaces is marked `superseded` in the write that stores the new one
  (no longer resent, still listed, reserved and decided by the chain) and its record goes only once a node took the
  new one or may hold it: a refusal from the only node sent the new one drops that one and puts the old one back as
  it was, so a replace can be retried and a transfer that may still apply is never dropped unseen (R4-EXTQ-01). A
  new send leaves one of the `LIMITS.PENDING_TRANSFERS_MAX` places free for such a replace. `duplicate`: a transfer of the same amount to the
  same address is outstanding, or this wallet signed one in the last 30 minutes (`VaultState.recentTransfers`,
  kept whatever became of it: R3-EXTQ-01); it holds when the archive is down, behind or flooded past its first
  page. The popup names the transfer a replace cancels by amount, recipient and nonce, and a replace whose target
  the chain decided meanwhile (`NONCE_CHANGED`) ends on a screen that says so, never on a review of an additional
  send (R3-EXTQ-03).
- `RecipientCheck` (`qnet.recipientCheck`, ES-01): `{known, lookalike, incomingOnly, historyRead}`. `known`:
  `to` is among the addresses this wallet signed transfers to (`VaultState.recipients` and the pending
  sends), never an incoming sender and never an explorer row. `lookalike`: not known, and it shares the
  first and last four characters with a known recipient or an address the newest archive page shows as
  paid. `incomingOnly`: not known, it sent to this wallet on that page and was never paid there.
  `historyRead`: the page was read. `recentSame`: with the amount given, that page shows a payment of it to
  `to` within 30 minutes. The archive (the site's own host) can only add warnings. `historyRead` false (or no check at
  all) is not described on screen (owner, 28.09); the duplicate warning still comes from the vault's own records
  (R3-EXTQ-01).
- Solana recipient check (`solana.recipientCheck`, R3-EXT-UI-03): `{known, lookalike}` in `SolanaQuote.recipient`
  (null when the vault could not be read). `known`: among the Solana addresses this wallet signed SOL or 1DEV
  transfers to (`VaultState.solanaRecipients`, written before the transaction leaves); `lookalike`: not known, and
  it shares the first and last four characters with one of them or the wallet's own address. The review shows the
  first-time and look-alike warnings the QNet send shows.
- `HistoryItem`: `{hash, direction: 'in'|'out'|'self', from, to, amountNano, feeNano, timestamp,
  status: 'included'|'unverified'|'pending'|'stale'|'replaced'|'unknown'|'refused'|'dropped', nonce: string|null, kind:
  'transfer'|'call'|'token'|'deploy'|'node_registration'|'node_activation'|'reward'|'swap', block?: number|null,
  nodeId?: string}`; a pending call also carries `method`, `recipient` (a token transfer's,
  else null) and `amountBase` (a token transfer's amount in the token's units, else null), its `to` is its contract and
  History shows it as a contract call or a send of that token (with its amount when the token list knows the token's
  decimals); an archive row's kind is its `tx_type` (`ContractCall` call, `ContractDeploy` deploy, `NodeRegistration`
  node_registration, `NodeActivation` node_activation, `RewardDistribution` reward: the node balance moved into the
  wallet, `Swap` swap, any other a transfer), and it carries the archive's `block`. A registration and a deploy may come
  with no `to` (decision 42): their row keeps `to: ''`; a registration is `included` when two pinned nodes list a
  registration with its hash, and carries `nodeId` when its hash is the one the vault's light node registration
  (`VaultState.registration.txHash`) recorded. An archive row of a built-in
  QRC-20 token (`source: 'token'`, decision 40) is `kind: 'token'` with `token: {contract, symbol, decimals, reserved}` (as
  the archive names it, shown only: the symbol as `TokenList` shows one, `reserved` as it marks one), `amountBase` (u128,
  the token's units) and `amountNano: '0'`; it is `included` when two pinned nodes list a contract call with its hash. `dropped` (decision 40): a transaction this wallet no longer sends
  (stale, or refused) whose nonce the last verified read shows free, past the node's mempool lifetime after it last went
  out (`max(createdAt, lastSubmitAt)` + 30 min + 5 min, the mobile `mayLandUntil`): no node can hold it, so it did not go
  through and never will by itself; the next transfer takes its nonce by default, its amount is no longer kept back from
  the send form's "available", and `resubmitPending` drops its record a day after it was dropped. An archive row is
  `included` (in a block) only when at least two pinned nodes list it alike (hash, both parties, amount) in their newest history
  (`/api/v1/transactions/history`, 100 rows), else `unverified` (older than their window, a batch row, or not theirs):
  the archive is the site's host, and the balance, which the wallet verifies, is the authority (R4-EXTQ-04). Listed is
  never "applied" in the worker: a node lists every transfer a block carries, one skipped at apply (a balance too low, a
  nonce already used) too, and its history carries no outcome (R5-EXTQ-01, needs the node). History names the states
  (owner, 28.09; 06.10): `included` Confirmed, `replaced` Failed, `dropped` Not found, `unverified` Unverified (never
  Pending for ever: an archive row of a chain the nodes no longer serve, or older than what they keep), every other state
  Pending; a row says its state only while it is not Confirmed, and its detail shows the badge of every state (decision
  42); no text on where the list comes from. Every row opens its detail (decision 40). `refused`: the only node sent it refused it (R5-EXTQ-02). A transfer of this wallet not
  seen applied has `hash: ''` (a node's hash is no identity: every node that took the body stamps its own copy,
  R2-EXTQ-06) and its nonce; `stale`: no longer resent after an hour, may still apply until its nonce is
  used; `replaced`: another transaction of this wallet used its nonce (R2-EXTQ-02); `unknown`: its nonce was used
  and no two pinned nodes list the same row at it yet (a verdict needs two agreeing nodes, R3-EXTQ-04); it is
  neither resent nor reserved, and is listed a day after it was seen so unless a later run decides it.
- `SolanaBalances`: `{address, lamports, oneDev: {mint, ata, exists, raw, decimals: 6}}`.
- `TokenList` (`qnet.listTokens`, decision 40): `{tokens: [{contract, name, symbol, decimals, balanceBase: string|null,
  reserved}], complete}`: the contracts two pinned nodes list as held (`GET /api/v1/account/{a}/tokens`, both lists
  together, kept `TOKEN_LIST_CACHE_MS` = 60 s), each read again: `readContract` (two pinned nodes alike: a QRC-20 token
  with at most 18 decimals, else left out) and `readTokenBalance` (u128 base units from the two-level token proof folded to
  a committee-certified state root, decision 44; `null` when no recent certified state gives it, a certified zero balance
  left out, except for the token of a vault pending token transfer not replaced, which stays listed so History names that
  send's token and amount), at most 20 tokens. The tokens of the wallet's own pending sends come first, so
  tokens sent to the wallet unasked never push them past the cut (L-13). `complete`: no QRC-20 token the nodes list as
  held was left out (past the 20, or no two nodes said what it is); a token whose balance is unread is listed, with a
  dash, and the popup says "Some tokens are not shown" under Assets and the Send picker while `complete` is false.
  `name` and `symbol` as a page shows them (`readContract`: every hidden or format character replaced by U+FFFD,
  `core.tokenLabel`; '' past 64 characters). `reserved` (M-5): the symbol or name, as deployed, is QNet's own in any
  spelling a reader takes for it, or carries a hidden or format character (`core.usesReservedName`, the app's rule:
  "qnc" or "qnet" inside the text once look-alike letters are read as the Latin ones, before NFKD and again after it,
  then case and everything but letters and digits (accents too) are dropped; the look-alikes are the Cyrillic and
  Greek letters a reader takes for Latin ones, the lunate sigma, small capitals, letterlike symbols such as the
  estimated sign, the Armenian, Lisu, Cherokee and Coptic letters that read as Q, N, C, E or T, and letters in a filled
  circle or square and the regional indicators).
- `TokenPreview` (`qnet.tokenPreview`): `CallPreview` of the token transfer (section 4.9) and `{token, name, symbol, decimals,
  amount (canonical decimal), reserved (`readContract`'s, as `TokenList`), burn (core.destroysTokens(to)), recipient:
  RecipientCheck|null}`. Its `tokenBalance` is the send rule's (section 4.9), and `tokenProblem` (`'NETWORK'` or
  `'BALANCE_UNCONFIRMED'`, else null) says why it is null; the review says it and keeps Send off.
- `SolanaHistoryItem` (`solana.history`, `solana.historyItem`, decision 39): `{signature, asset: 'sol'|'1dev', direction:
  'in'|'out'|'self', counterparty: string|null, amountRaw, feeLamports: string|null, timestamp: number|null, status:
  'confirmed'|'failed', burn}`. What moved for the wallet as the transaction's balances show it: 1DEV when its 1DEV balance
  changed or it burned 1DEV (`burn`), else SOL (less the fee); `self`: nothing moved but the fee it paid; a failed one shows
  what its own transfer asked to move. `counterparty`: the other side of the wallet's own transfer (a token account's
  owner), null for a burn or one not known; `feeLamports` only when the wallet paid it. A transaction that moved nothing for
  the wallet and that it did not pay for (someone else's that only names it) is no row. The page lists the transactions of
  the owner's address and of its 1DEV account, merged by slot, each read once with `getTransaction` (kept in worker memory and
  seeded from the session's view cache); the cursor names where each listing goes on.
- `UnlinkView` (`nodes.unlinkView`, decision 38): `{mode: 'confirm'|'unavailable', reason:
  'NOT_LINKED'|'UNSUPPORTED'|'NETWORK'|'SIGNING_DISABLED'|null, nodeId, platform: 'android'|'ios'|'unknown'|null, linkedSince:
  number|null}`: from the public status two pinned nodes report alike (`GET /api/v1/light-node/status`): off chain or its
  `device.state` `unlinked` → `NOT_LINKED`; no `unbind_wallet` in their `features` → `UNSUPPORTED`; no two alike →
  `NETWORK`; else `confirm` with the device's platform (an answer that names `android` or `ios` before one that says
  `unknown`) and `linked_since` (the UTC day of the binding, Unix s).
- `SolanaQuote`: `{asset, to, mint: string|null, decimals, amountRaw, feeLamports, createsRecipientAccount, rentLamports,
  totalLamports, balanceLamports, tokenRaw: string|null, rentFloorLamports, shortfall, references: string[], memo:
  string|null, recipient: {known, lookalike}|null}`; `solana.send` must be sent with this quote's `feeLamports` and
  `rentLamports`, and with the `references` and `memo` it was quoted with (the popup takes a quote only when they are
  the ones it asked for, and the review shows the quote's). `references` and `memo`: a payment request's parts the
  transaction carries (decision 34), `[]` and null for none. `mint` and `decimals`: the SPL token's
  mint and the decimals it reports on chain (SOL: null, 9); `createsRecipientAccount`: the recipient's associated token
  account does not exist, so the send creates it (CreateIdempotent) and the wallet pays `rentLamports`;
  `balanceLamports` and `tokenRaw`: the wallet's SOL and token balance at confirmed; `rentFloorLamports`: the least a
  plain account holds unless it is empty (the rent exemption of 0 bytes). `shortfall` is null or the code the send
  would fail with: `INSUFFICIENT_SOL` (SOL below the fee, the rent and a SOL amount), `INSUFFICIENT_TOKENS`,
  `AMOUNT_BELOW_RENT` (SOL to an address with no account, below the floor), `SOL_BELOW_RENT` (a funded wallet would keep
  less than the floor without being emptied, after the fee or at the end: the chain refuses that).
- `PublicActivation`: `{nodeType, burnTx, burnAmount, solanaAddress, cluster, createdAt, codeMasked, paidOnSite}`
  (`paidOnSite`: a light burn aiqnet.io's one-time payment key made for this wallet, section 4.10; `solanaAddress` is
  then that key)
  (`activation.maskCode`: node-type letter and last two characters visible).
- `RegistrationView` (`nodes.publicRegistration`): `{nodeId, state: 'queued'|'admitted'|'onchain'|'other_burn'|'refused'|'clock',
  attempts, lastError: string|null, txHash: string|null, updatedAt, automatic, deferred}`; `lastError` a short code (never
  shown as text); `automatic`: queued below `LIMITS.REGISTRATION_MAX_ATTEMPTS`, or admitted (its chain is read until the
  hold ends, past the cap too), so the wallet still tries on its own (otherwise the popup offers Record on the network);
  `deferred`: queued and automatic, its next attempt more than `TIMINGS.REGISTRATION_SOON_MS` away, which the popup shows
  as not recorded with Record on the network (the wallet keeps trying meanwhile). `other_burn`: the chain lists the node
  with a registration of another burn (section 4.10), so this burn recorded nothing; the popup and the activation window
  say so, never "Recorded", and offer no Record on the network.
- `PendingBurn`: `{burnTx, nodeType, burnAmount, solanaAddress, cluster, createdAt}`.
- `ActivationLookup` (`activation.lookup`, decision 35): `activation.status`'s fields and `{view, reason, record: RecordView|null,
  keptBurn: PublicBurn|null, network: 'none'|'exists'|'unknown'|null, search: 'none'|'found'|'pending'|'searching'|'unknown'|'unusable'|null}`.
  `view`: `activation` (the vault's, shown at once and recorded on aiqnet.io in the background); `record` (aiqnet.io's record
  is the wallet's code and the vault holds none of it: a light burn aiqnet.io's payment key made, or the other burn a record
  keeps instead of the vault's, whose burn is then `keptBurn`); `pending`; `busy` (an activation runs here); `checking`
  (the shared search runs); `elsewhere` (aiqnet.io holds a reservation or a burn on its way, of the extension or of a payment
  address, decision 36); `node` (the QNet network knows a node of this wallet, or aiqnet.io's record names a burn Solana does not
  show as it: no code known here); `unusable` (a burn no code derives from); `unavailable` (`reason` names the source that
  could not answer: `RECORD_UNAVAILABLE`, `NETWORK`, `SOLANA_UNAVAILABLE`, `HISTORY_TOO_LONG`); `none`, every source's
  "none", the only view that offers a burn. A record of a burn of the wallet's own address is stored as the activation
  once Solana shows its burn (`view` is then `activation`); a record's burn is always read back from Solana first
  (`validateBurnTx`, the burner as owner) and its code derived here, never taken from the answer.
- `RecordView`: `{state: 'reserved'|'sending'|'recorded', nodeType, way: 'extension'|'payment', burnTx: string|null,
  burnAmount, until: number|null, paidOnSite, codeMasked: string|null, createdAt: number|null}` (`codeMasked` and
  `createdAt` once a recorded burn was read back from Solana).
- `PriceQuote`: `{phase: 1|2, light: {cost}, super: {cost}, fetchedAt}`; `cost` is whole 1DEV in phase 1.
  Phase 2 is refused for burns (`PHASE_UNSUPPORTED`).
- `ApprovalView`: section 4.8.

## 3. Worker → page events

`router.broadcastToViews(event, data)` sends `{channel: 'qnet-event', event, data}` with
`runtime.sendMessage`. Pages subscribe with `common.onWalletEvent(handler)`, which accepts a message
only from this extension's worker (`sender.url === getURL('background/sw.js')`, no `sender.tab`).

| Event | When | data | Page reaction |
|---|---|---|---|
| `locked` | any lock | null | clear every input `.value`, drop secrets, show the lock screen |
| `unlocked` | unlock | null | refresh |
| `wiped` | wipe, restore | null | clear localStorage/sessionStorage of the page, drop the view, empty the clipboard (best effort), reload once (the popup running a `vault.restore` only clears, then shows the result). sw.js sends it when the wipe starts, before `vault.wipe` answers: the popup that asked for the delete reloads here, so the clipboard is emptied here, never after the answer (R16, R4-ESM-01) |
| `activation` | activation record, pending burn or the state of the light node's registration changed | null | refresh the Activate tab |
| `approval` | approval queue changed | null | approve page refreshes |
| `balance` | a send, token transfer, contract call, activation or claim a site asked for ran after its confirm (sent, burned, moved, or failed on the way) | null | the popup reads the balances, the token list or the history on screen again at once (section 9, Pages) |

Modules call `notifyViews(event)` from `background/events.js` (sw.js installs the router's broadcaster;
payloads are always null, pages re-read state). sw.js already maps `session.onLockChange` to
`locked`/`unlocked`/`wiped`; activation.js and nodes.js send `activation`, provider.js sends `approval` and
`balance`.

## 4. dApp provider protocol

Shared with the future mobile in-app browser: the same page API, methods, results, errors and events.

### 4.1 Page API (`inject/provider.js`, MAIN world, document_start)

- `window.dispatchEvent(new CustomEvent('qnet:announceProvider', {detail}))` at start and in answer to
  every `qnet:requestProvider` event. `detail = Object.freeze({info, provider})`,
  `info = Object.freeze({uuid: crypto.randomUUID() per page load, name: 'QNet Wallet', icon: <data URI>,
  rdns: 'io.aiqnet.wallet', channel: 'extension'})` (`config.PROVIDER.CHANNEL`; the mobile in-app
  browser announces `'mobile'`, QNet Link v1 section 11).
- `provider` is frozen: `{isQNet: true, request({method, params}), on(event, listener),
  removeListener(event, listener)}`; `on`/`removeListener` return the provider; unknown event names throw
  `TypeError`.
- `window.qnet = provider` via `Object.defineProperty` (not writable, not configurable) inside
  try/catch; the announcement is the trust anchor, `window.qnet` only a convenience.
- `request` rejects with an `Error` carrying numeric `code` (section 4.5). Invalid `args` → -32602
  locally. No timeout: approvals wait for the user; a lost worker answers 4900.

### 4.2 Page ↔ relay (`window.postMessage`, target origin `window.location.origin`, never `'*'`)

- Page → relay: `{target: 'qnet-relay', id, method, params}`; `id` string `[A-Za-z0-9_-]{1,64}` or
  non-negative safe integer; JSON <= 16384 chars.
- Relay → page: `{target: 'qnet-provider', id, ok: true, result}` / `{target: 'qnet-provider', id,
  ok: false, error: {code, message}}` / `{target: 'qnet-provider', event, data}`.
- Both sides accept only `event.source === window` and `event.origin === window.location.origin`.
- The relay forwards `{id, method, params}` unchanged (adds nothing, reads no storage), drops a request
  whose id is already pending, and answers every pending id with `{code: 4900, message:
  'Disconnected'}` when the port closes; it reconnects on the next request.
- An event for a page whose relay holds no open port (an idle MV3 worker stops after about 30 s and closes every port,
  EXT-F3) comes through the tab: the router sends `{target: 'qnet-provider-event', origin, event, data}`
  (`config.PROVIDER.TAB_EVENT`) with `chrome.tabs.sendMessage(tabId, message, {frameId: 0})` to every tab of that exact
  origin no port reached, found with `chrome.tabs.query({url})` over the relay patterns a host permission names (store:
  `https://aiqnet.io/*`; no `tabs` permission). The relay takes it only from this extension's service worker
  (`sender.id` its own, no `sender.tab`, `sender.url` the worker's), only for its own page's origin (a tab that navigated
  to another origin after the lookup gets nothing) and only an event of the list, and posts it to its page
  as a port event: the lock, the unlock and `accountsChanged` reach the cabinet whether or not it asked anything since.

### 4.3 Relay ↔ worker (`chrome.runtime.connect({name: 'qnet-provider'})`)

- The router keeps a port only when: name is `qnet-provider`; `sender.id` is this extension;
  `sender.tab.id` is set; `sender.frameId === 0`; `sender.documentLifecycle` (when present) is
  `active`; `sender.origin` is a canonical origin equal to
  `new URL(sender.url).origin`; and it matches the relay's `content_scripts` patterns from the manifest
  (store: exactly `https://aiqnet.io/*` and `https://games.aiqnet.io/*`, no wildcard host: `www.aiqnet.io` and
  `explorer.aiqnet.io` only redirect and get no provider, and the games host connects and sends but never activates a
  node, `router.isActivationOrigin`; the dev overlay adds loopback). A pattern without a port takes only the scheme's default port for
  https (another service on another port of the host never gets the provider), any port for the dev overlay's plain
  HTTP loopback (`router.originMatchesPattern`, R4-ERP-02); grants are valid for the same origins. Otherwise the port
  is disconnected at once.
- Relay → worker: `{id, method, params}`; no other key; JSON <= 16384. No valid id → ignored. More than
  `LIMITS.PORT_MAX_PENDING` (16) unanswered on one port → 4001 at once.
- Worker → relay: `{id, ok, result|error}` and events `{event, data}`.
- `ctx = Object.freeze({origin, tabId, portId})` is built from the sender and handed to
  `provider.handleRequest(ctx, method, params)`. No origin from a message is ever used.

### 4.4 Methods (allow-list; anything else → 4200)

| Method | Params | Result | Rules |
|---|---|---|---|
| `qnet_requestAccounts` | none (`undefined`, `null`, `[]`, `{}`) | `{qnet, solana}` | granted and unlocked → at once; otherwise a connect approval (unlock first when locked), then the grant is stored |
| `qnet_accounts` | none | `{qnet, solana}` or `{}` | `{}` unless granted and unlocked; never opens a window |
| `qnet_chainId` | none | `{chainId: 'q1337', network: 'testnet'}` | |
| `qnet_disconnect` | none | `true` | removes this origin's grant; emits `accountsChanged {}` and `disconnect` to it |
| `qnet_signMessage` | `{message: string}` | `{signature, publicKey, address}` (hex, hex, EON) | grant required (else 4100); message rejected by `core.buildOffchainMessage` (protocol prefixes including `register:` and `migrate:`, the payment key's owner bind `qnet_burn_owner_v2:` and aiqnet.io's records of a wallet, a burn record and a node reservation, however written: decision 36; hidden controls and format characters, a carriage return not followed by a line feed and the typographic spaces U+2000-U+200A, U+202F, U+205F that the approval draws as nothing or a sliver: R5-EXT-UI-01, lone surrogates, empty, > 4096 UTF-8 bytes) → -32602 before any window; approval shows the exact text; signature = `core.signOffchainMessage(origin, message, …)`: ML-DSA-65 with FIPS 204 context `QNET_OFFCHAIN_MSG_v1` over `"QNet Signed Message:\n" + origin + "\n" + byteLength + "\n" + message` |
| `qnet_sendTransaction` | `{to: qnetAddress, amount: qnc}`, the same with `type: 'transfer'`, `{type: 'tokenTransfer', token: qnetAddress, to: qnetAddress, amount}` or `{type: 'contractCall', contract: qnetAddress, method, args, gasLimit?}` (`router.normalizeTransaction`) | `{status: 'submitted'\|'unknown', from, to, amount, nonce, txHash: string\|null}`; a token transfer `{status, from, token, to, amount, nonce, txHash}`; a call `{status, from, contract, method, nonce, txHash}` (a transaction's identity is (`from`, `nonce`): at most one transaction of `from` applies at a nonce, so a dApp matches it by them; `txHash` is the hash one node gave its own copy, and another node's copy of the same signed transaction, with another hash, may be the one that lands: R2-EXTQ-06, R5-EXTQ-03; `submitted` only when a node took it and named its copy, as the mobile in-app browser answers, and never says a call succeeded: the node keeps no outcome, decision 25) | grant required; any other field → -32602; the wallet sets fee (`core.fees`), gas and nonce and builds every byte with the shared builders (`core.buildTokenTransfer`, `core.buildContractCall`); section 4.9 |
| `qnet_getTransactionStatus` | `{from: qnetAddress, nonce: u64 > 0}` | `{status: 'pending'\|'in_block'\|'unknown', blockHeight: number\|null, txHash: string\|null}` (height and hash only for `in_block`) | the connected, unlocked account only (anything else 4100); no window; `qnet.transactionStatus`, a failed read or an answer about another (`from`, `nonce`) is `unknown`; an answer is given again for 3 s without a read, and an origin starts at most 20 reads a minute (more: 4001), the mobile in-app browser's shape and limits; section 4.9 |
| `qnet_activateNode` | `{nodeType: 'light'\|'super'}` | `SiteActivationResult` (below), keys unchanged | `router.isActivationOrigin` only: exactly `https://aiqnet.io`, the dev build also plain-HTTP localhost / 127.0.0.1; any other origin → 4100 before the params are read (PROVIDER_METHODS `origins`), checked again in provider.js. No grant read or created, no `accountsChanged`. No vault → `{status: 'error', error: 'NO_WALLET'}` at once. Otherwise an `activateNode` approval (cooldown and queue as 4.8), its armed confirm (no password), then `activation.activateForSite`; a light activation is then recorded on the QNet network (section 4.10: queued with the burn's activation, or with the wallet's existing one not recorded yet), so the site reads the chain for "Registered" |
| `qnet_getActivation` | none | `SiteActivationRead` (below) | Decision 35. `router.isActivationOrigin` only (4100 for any other origin before the params). Read-only and never a window: no approval queue, budget or cooldown, no grant read-or-written besides the check, no `accountsChanged`, nothing signed for the site or burned; a burn the kept search finds is stored as `activation.recover` stores it (a Light activation's record on the QNet network then starts, as after Recover), and the vault's own burn may be recorded on aiqnet.io (`syncRecord`). At most `LIMITS.ACTIVATION_READS_PER_MINUTE` (30) a minute per origin (more: 4001). `{status: 'no_wallet'}` without a vault, `{status: 'locked'}`, `{status: 'not_connected'}` while this origin holds no valid grant of the session's wallet; otherwise `activation.siteActivation`, checked by provider.js before it leaves (the wallet's own addresses, a known status with exactly its keys, a well-formed burn, the code the node's derivation of it; anything else -32603) |
| `qnet_unlinkNodeDevice` | none | `SiteUnlinkResult` (below) | Decision 38. `router.isActivationOrigin` only (4100 for any other origin before the params). No grant read or created. No vault → `{status: 'error', error: 'NO_WALLET'}` at once. Otherwise an `unlinkNodeDevice` approval (cooldown and queue as 4.8) showing `nodes.unlinkView`; its armed confirm (no password, like every approval) runs `nodes.unlinkForSite` (section 4.10). The wallet's own light node only; an extension without the method answers 4200 |
| `qnet_claimNodeBalance` | none | `SiteClaimResult` (below) | `router.isActivationOrigin` only (4100 for any other origin before the params). No grant read or created. No vault → `{status: 'error', error: 'NO_WALLET'}` at once. Otherwise a `claimNodeBalance` approval (cooldown and queue as 4.8) showing `nodes.claimView`; its armed confirm (no password, like every approval) runs `nodes.claimForSite` (section 4.10). The wallet's own light node only |

`SiteActivationResult` (QNet Link v1 sections 7 and 10): `ok` and `exists` `{status, qnet, solana, nodeType,
burnTx, burnAmount, code}`; `pending` `{status, qnet, solana, nodeType, burnTx, burnAmount}`; `exists` may add
`supersededBurnTx` (section 7.1: the burn this device sent from the wallet's own address, final, that another device's
older burn of the phrase beat; only when its signature is not `burnTx` and both burns are the wallet's own address's);
`error` `{status: 'error', error}` with one of `PRICE_UNAVAILABLE, PHASE_UNSUPPORTED, PRICE_CHANGED, INSUFFICIENT_SOL,
INSUFFICIENT_TOKENS, SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE, HISTORY_TOO_LONG, NODE_EXISTS, BURN_UNUSABLE,
BURN_IN_PROGRESS, NO_WALLET, INTERNAL` (any other wallet code is sent as `INTERNAL`, `NETWORK` among them: the QNet network could not vouch that the wallet has no node, EXT-R1-01; `BURN_UNUSABLE`: the wallet already
burned in a form no code derives from, and burns no second time, R4-ESA-01, now a code of QNet Link v1 section 7:
XP-R5-01; `HISTORY_TOO_LONG`: a burn search its time budget cut short, which the next request continues, for the
signed-transactions search too: SRA-R2-02, R5-ESA-01). Before a result leaves,
provider.js checks it once more: the wallet's own addresses, a well-formed signature and amount, `ok` only for
the requested type, and `code === core.generateActivationCode(nodeType, solana, burnTx, burnAmount)`; anything
else becomes `INTERNAL`. A reject is 4001 like every approval.

`solana` of an `exists` or `pending` result is the address that burned, the wallet's own, so the site derives the code
from it: its only burner is the wallet's Solana address. A `pending` burn is one this wallet sent, or one Solana confirmed and has not finalized that
another device of the same phrase sent (QNet Link v1 sections 7 and 10, XP-R2-05); `BURN_IN_PROGRESS` is only an
activation already running in the extension. A vault activation aiqnet.io paid for (`paidOnSite`, section 4.10) is no
burn of the wallet's addresses: the window offers nothing (`unavailable`, `NODE_EXISTS`) and a confirm answers
`NODE_EXISTS`; the window says the node was paid on aiqnet.io and its code is in Settings (decision 43)
(`apActivatePaidOnSite`), not the `NODE_EXISTS` text that points to a Recover the tab does not offer then (EXT-R2-02).
A device whose own burn is not the wallet's oldest after both devices
burned in the same seconds (XP-R2-06) answers as the app does, `exists` with the oldest burn and its code, whatever
its node type (never `INTERNAL` once a burn went out), keeps its own burn as `VaultState.supersededBurn`, names it in
the approval window (`approval.resolve`'s `superseded`) and on the Activate tab, and names it to the site in
`supersededBurnTx` (protocol section 7.1, XP-R5-03): for the burn this request sent, and for a burn of an earlier request
that settles as such while this one is answered (`activation.activateForSite` compares `supersededBurn` before and after
the pending burn's check).

`SiteClaimResult` (QNet Link v1 section 14.10: the `claim` answer of section 14.7 without `v` and `intent`): `ok`
`{status, qnet, nodeId, amountNano, txHash, stoppedAtEpoch}` (`amountNano` decimal nano, at least `CLAIM_MIN_NANO`, or
above zero for a part of the balance; `txHash` 64 lowercase hex; `stoppedAtEpoch` the epoch the node's quote stopped at
when the move took part of the balance, decimal, or null);
`empty` `{status, qnet, nodeId}` (a balance below 1 QNC, or none); `error` `{status: 'error', error}` with one of
`NO_WALLET, NO_NODE, NETWORK, CLAIM_REFUSED, CLAIM_BUSY, INTERNAL` (`CLAIM_ERRORS`; any other code is `INTERNAL`). A
reject or a closed window is 4001. Before a result leaves, provider.js checks it once more: this wallet's address and
light node id, the amount, the hash and the stop epoch; anything else becomes `INTERNAL`.

`SiteUnlinkResult` (decision 38: the `unlink` answer of QNet Link v1 section 14.7 without `v` and `intent`): `ok` `{status, qnet,
nodeId, unbound: true}` (the network took the wallet key's unbind); `error` `{status: 'error', error}` with one of `NO_WALLET,
NOT_LINKED, NETWORK, UNLINK_REFUSED, INTERNAL` (`UNLINK_ERRORS`; any other code is `INTERNAL`, a network that lists no
`unbind_wallet` among them). A reject or a closed window is 4001. Before a result leaves, provider.js checks it once more: this
wallet's address and light node id and `unbound: true`; anything else becomes `INTERNAL`.

`SiteActivationRead` (decision 35): `{status: 'no_wallet'}`, `{status: 'locked'}`, `{status: 'not_connected'}`, or
`{status: 'searching'|'none'|'unusable', qnet, solana}`, `{status: 'unknown', qnet, solana, reason:
'SOLANA_UNAVAILABLE'|'HISTORY_TOO_LONG'}`, `{status: 'pending', qnet, solana, nodeType, burnTx, burnAmount}`, `{status: 'exists',
qnet, solana, nodeType, burnTx, burnAmount, code, paidOnSite}`. `qnet` and `solana` are the unlocked wallet's own. `exists`: the
vault's activation, `code = core.generateActivationCode(nodeType, solana, burnTx, burnAmount)`, or with `paidOnSite` (a light
burn aiqnet.io's payment key made) `core.walletActivationCode(qnet, burnTx, burnAmount)`; it is recorded on aiqnet.io in the
background. `pending`: the vault's pending burn, checked again in the background at most every `TIMINGS.ACTIVATE_RECHECK_MS`.
Otherwise the shared search of the wallet's own address (the kept search, with the confirmed page): a finalized burn it finds
is stored and answered `exists`, one on its way `pending`; `searching` while it runs (a read waits for it up to 3 s) or while an
activation runs here; `unknown` when it could not decide; `unusable` for a burn no code derives from; `none` only for a search
that finished with nothing within `TIMINGS.WALLET_SEARCH_FRESH_MS` (60 s). A search starts at most every
`TIMINGS.WALLET_SEARCH_SPACING_MS` (20 s) per wallet. An extension without the method answers 4200: the site then knows no
extension source and offers no burn through it.

`qnet_activateNode` and aiqnet.io's record (decision 35): the window offers `burn` only when the vault holds no activation and
no pending burn, the shared search finished with no burn (in flight and unusable counted: a burn it finds is stored and
shown, `exists` or `pending`; still running: the view `checking`, nothing to confirm), aiqnet.io's record says none
(`GET /api/cabinet/activation/{wallet}`: a record → `unavailable` `ACTIVATION_RECORDED`, a reservation or a burn on its way,
of either way → `ACTIVATION_RESERVED`, no answer → `RECORD_UNAVAILABLE`) and `refuseExistingNodes` passes.
`activateForSite` checks all of them again before `burnNow`, whose order is: the price again, the balances, aiqnet.io's
reservation (`POST /api/cabinet/activation/reserve`, the request signed by the wallet's key: `keys.signReservation`, decision
36), the blockhash, build and sign (only while `TIMINGS.SIGN_MARGIN_MS` of the
reservation is left), simulate, the announce with the burn record's proof (`POST .../announce`; nothing is sent without its
200), the vault's pending burn, the send, the settle, the record (`syncRecord`, best effort). A refusal before the send gives
the reservation back (`POST .../release`, best effort) and sends nothing. The new wallet codes reach the site as the section 7
codes they mean: `ACTIVATION_RECORDED` → `NODE_EXISTS`, `ACTIVATION_RESERVED` → `BURN_IN_PROGRESS`, `RECORD_UNAVAILABLE` →
`INTERNAL`; the window names each in its own words. The answer shapes and codes of QNet Link section 7 are unchanged.

Solana signing is not offered to dApps. A dApp verifier of `qnet_signMessage` must use the same bytes
and the same FIPS 204 context (`core.verifyOffchainMessage`).

### 4.5 Error codes

| Code | Message | When |
|---|---|---|
| 4001 | User rejected the request | rejected, window closed, approval timeout, per-origin queue full, port flood, the origin's 20 `qnet_getTransactionStatus` reads or 30 `qnet_getActivation` reads of the last minute spent |
| 4001 | Too many rejected requests from this site, try again later | the origin is in its approval cooldown (section 4.8); `WalletError('APPROVAL_COOLDOWN')`, the only other text a 4001 carries (`inject/provider.js` `COOLDOWN_MESSAGE`) |
| 4100 | Unauthorized | no grant for sign/send; grant revoked while waiting; `LOCKED`/`UNAUTHORIZED` from a module; `qnet_activateNode`, `qnet_getActivation`, `qnet_claimNodeBalance` or `qnet_unlinkNodeDevice` from any origin but `https://aiqnet.io` (dev: + loopback) |
| 4200 | Unsupported method | not in the allow-list |
| 4900 | Disconnected | port closed (sent by the relay) |
| -32602 | Invalid params | envelope or params invalid; `INVALID_*` (`INVALID_METHOD`, `INVALID_ARGS`, `INVALID_GAS_LIMIT` included), `PROTOCOL_PREFIX`, `MESSAGE_TOO_LONG`, `UNSUPPORTED_PARAM`, `RECIPIENT_IS_CONTRACT`; a token transfer of a contract that is no QRC-20 token or a call of one that is a token or no contract; a transfer or token transfer to a contract (section 4.9) |
| -32602 | Unsupported parameter, with `data: {reason: 'UNSUPPORTED_PARAM'}` | a `contractCall` naming `value` or `accessList`: the network accepts neither on a call today (errors.js `UNSUPPORTED_CALL_FIELDS`, `UNSUPPORTED_PARAM_MESSAGE`), refused before anything else is read; the only error that carries `data` and the one other text a -32602 carries, the mobile in-app browser's shape; the relay and `inject/provider.js` pass on exactly that shape (`error.data`, frozen) |
| -32603 | Internal error | anything else (a dApp learns nothing about balances or nodes); a `qnet_getActivation` answer that fails its check |

`WalletError` codes `USER_REJECTED`, `UNAUTHORIZED`, `UNSUPPORTED_METHOD`, `DISCONNECTED` map to their
numbers; `ProviderError(code)` passes as is.

### 4.6 Events

`accountsChanged` with `{qnet, solana}` (unlock, grant) or `{}` (lock, revoke, disconnect, wipe);
`disconnect` with `{code: 4900, message: 'Disconnected'}` (revoke, disconnect, wipe; the router fixes
this payload). Sent only to one granted origin, through `router.emitProviderEvent(origin, event, data)` (provider.js gets it
via `setEventSink`): to its open ports, and to the tabs of that origin no port reached (section 4.2, EXT-F3).

### 4.7 Grants

`chrome.storage.local['qnet_sites_v3'] = { [origin]: {grantedAt, chains: ['qnet', 'solana'],
walletId, mac} }`, `mac = base64(HMAC-SHA256(sitesKey, UTF-8(canonicalJson({origin, grantedAt,
chains, walletId}))))` with `vault.readSiteBinding()`. `provider.readSites()` uses an entry only if the
origin is canonical and matches the relay patterns, the fields are well formed, `walletId` is the
vault's and the MAC verifies (constant-time); it prunes the rest. Content scripts can write
`storage.local`, so a grant without a valid MAC is attacker data (R22). Revoke: Settings → Connected
sites (`sites.revoke`) or `qnet_disconnect`; a revoke first rotates the key (`vault.rotateSitesKey()`)
and then stores the remaining grants signed with the new one, so the revoked entry written back is
refused. Wipe deletes the vault (and with it `sitesKey`) and clears `storage.local`.

### 4.8 Approvals

- One window at a time: `chrome.windows.create({url: 'ui/approve.html?id=<uuid>', type: 'popup',
  focused: true, width: 400, height: 640, left, top})`; `left`/`top` under the extension's toolbar icon (decision 37): the
  top-right corner of ONE of the user's normal browser windows that are not minimized
  (`windows.getAll({windowTypes: ['normal']})`): the focused one, else one at random; `left = area.left + max(0,
  area.width - 400 - 16)`, `top = area.top + min(72, max(0, area.height - 640))` (`APPROVAL_EDGE`), so the whole approval
  lies inside a window of at least 400 × 640; never the box around several, which with displays of other sizes or
  offsets spans space no display covers (ERP-R5-01). No page can create, size or place a normal window; only when none can be read, the
  requesting tab's window if it is a normal one; else Chrome's default placement, which is also taken when Chrome
  refuses the place (less than half on a display) instead of failing the request. A page can open itself in a popup
  window of any size and place, so the corner is never taken from such a window (R4-ERP-01). A page may know the
  window's place; the approve page draws a random gap (0 to 96 px in 16 px steps) right above its actions with every
  view, so it still does not know where Confirm is, and Confirm arms only after its delay (R2-ERP-02, R4-ERP-01); FIFO
  across origins; at most 3 open per origin (shown or
  waiting); closed window, port closed or `TIMINGS.APPROVAL_TIMEOUT_MS` → 4001 and the next opens.
- Window budget (R2-ERP-01): every window of an origin counts from the moment it opens, however it ends,
  until an approved and performed action clears the origin's entry: at most `LIMITS.APPROVAL_BUDGET_SHORT`
  (5) within `TIMINGS.APPROVAL_BUDGET_SHORT_MS` (1 min) and `LIMITS.APPROVAL_BUDGET_LONG` (20) within
  `TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS` (10 min); past it a request that needs a window, and an approval that
  waited, fails with the cooldown 4001. A window `windows.create` still opened after its approval ended (the
  page went away meanwhile) is closed at once and counts too (R3-ERP-01).
- A window the user closes while its confirm runs ends the request as a closed window does (4001, a counted
  rejection) when that confirm ends in a retry the window would have offered (`FEE_CHANGED`, `NONCE_CHANGED`,
  `NONCE_UNAVAILABLE`, `BALANCE_UNCONFIRMED`, `BALANCE_FOREIGN_PENDING`, `LOCKED`; for an activation `PRICE_CHANGED`): it never waits
  in the queue without a window or a timer to pop up again later (R3-ERP-02). Any other outcome is the dApp's.
- No approval asks for the password (owner, 29.09). While the wallet is unlocked, the unlocked session and the press of
  the armed Confirm in the approval's window are the confirmation; while it is locked the window asks for the password
  once, to unlock (`vault.unlock`), then shows the request with its armed confirm and never asks again.
  `approval.resolve` refuses a `password` field for every kind (`INVALID_PARAMS`, at the router and again in
  provider.js).
- What binds a confirm to its window and its request: the router takes `approval.get` / `approval.resolve` only from
  this extension's `ui/approve.html` in a top frame (section 2.2), and provider.js only for the approval shown in the
  slot, named by its id (a random UUID the worker put in that window's URL when it opened it), from that window
  (`meta.sender.tab.windowId`, which Chrome reports and no page sets); otherwise `NOT_FOUND`. A confirm must name the
  revision of the view the page drew (`REVISIONED`), a second confirm while one runs is `NOT_FOUND` (`busy`), and a
  settled approval is gone (`NOT_FOUND`), so an id confirms once.
- Cooldown (anti prompt-spam, relaxed by the owner on 28.09): a user's rejection of an approval, or the close of its
  window, is counted; a single one bars nothing (`TIMINGS.APPROVAL_COOLDOWN_MS` 0: a person who declined once may
  try again at once), and the `LIMITS.APPROVAL_COOLDOWN_REJECTIONS`th (5th) within
  `TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS` (10 min) bars the origin for `TIMINGS.APPROVAL_COOLDOWN_LONG_MS` (1 min).
  Meanwhile a request that would need a window
  (`qnet_requestAccounts` without a grant or while locked, `qnet_signMessage`, `qnet_sendTransaction`,
  `qnet_activateNode`, `qnet_claimNodeBalance`, `qnet_unlinkNodeDevice`) fails at once with the cooldown 4001 (section 4.5); a counted rejection ends the origin's
  approvals already waiting with it; calls that need no window are served. An
  approved and performed approval of the origin clears its cooldown and its count. A port that closes
  while its approval's page has drawn the action (`approval.get` served) for at least `TIMINGS.CONFIRM_ARM_MS`
  counts as a rejection too (ES-03: a page that reloads itself to open focused window after window). A
  timeout, a wipe, a port closed sooner or while its approval only waits counts nothing the first time, and
  neither does an `activateNode` window that could not offer its action (view mode `unavailable`), whether
  its button, the window's close or its page going away ends it; from the origin's second window within the
  short budget period on, a port closed sooner and such an unavailable window count as rejections (R2-ERP-01).
  State: worker memory, mirrored to `chrome.storage.session[STORAGE_KEYS.APPROVAL_COOLDOWN]` =
  `{[origin]: {rejections: ms[], until: ms, windows: ms[]}}` (an entry without `windows` reads as none; read
  once per worker, entries shape-checked, `until` never more than the long cooldown ahead, at most
  `LIMITS.APPROVAL_COOLDOWN_ORIGINS_MAX` origins).
- `ApprovalView`: `{id, kind: 'connect'|'signMessage'|'sendTransaction'|'tokenTransfer'|'contractCall'|'activateNode'|'claimNodeBalance'|'unlinkNodeDevice', origin,
  originDisplay, idn, locked, queued, createdAt, revision, details}`; `revision` grows whenever the lock state
  or the details served change, and a send or burn confirm must name the one the page drew (R2-ERP-04); a read
  that finishes after a newer one started, or after a confirm started, stores nothing (R2-EXT-UI-03).
  details: connect `{alreadyGranted}`,
  signMessage `{message, byteLength}`, tokenTransfer `{token, to, amount, amountBase, name, symbol, decimals, reserved,
  burn, gasLimit, feeNano, depositNano, totalNano, nonce, balanceNano, verified, verification, balanceProblem, tokenBalance,
  tokenProblem, outstanding, duplicate, replaces, inFlight, recipient}` and contractCall `{contract, method, args, argsBytes,
  argsText, gasLimit, feeNano, totalNano, nonce, balanceNano, verified, verification, balanceProblem, outstanding, replaces,
  inFlight}` (section 4.9; the preview fields null until read), sendTransaction `{to, amountNano, feeNano, totalNano, nonce,
  balanceNano, verified, verification, balanceProblem, outstanding: number, duplicate: boolean, replaces, inFlight,
  recipient}` (`replaces`:
  `{nonce, to, amountNano, kind: 'transfer'|'call'}` of the refused transaction this one takes the place of, or null;
  `inFlight`: section 4.9; `outstanding`:
  this wallet's earlier sends not seen applied; `duplicate`: one of them, or a transfer this wallet signed in the
  last 30 minutes, has this recipient and amount: `TransferPreview.duplicate`, R3-EXTQ-01) (nonce and balance null
  until unlocked and until a certified balance was read; `verification` proof or none, not shown on screen (owner,
  28.09): only a committee-certified proof verifies a balance, EXT-CHAINS-04; `balanceProblem`: why no balance a send is
  decided by was read yet, `'NETWORK'`, `'BALANCE_UNCONFIRMED'` or `'BALANCE_FOREIGN_PENDING'` (the preview's refusal,
  decision 44), else null: the window says it in place of "Reading the account from the network…", keeps Confirm off
  and reads again; `tokenProblem` likewise for a null `tokenBalance`; `recipient` is
  `qnet.recipientCheck(to)` (`RecipientCheck`), read once per approval, null while locked or
  unreadable), activateNode `{nodeType, mode: 'burn'|'exists'|'pending'|'unavailable'|'checking'|null, reason,
  cost, activation: PublicActivation|null, pending: PendingBurn|null, balances: {lamports,
  oneDevRaw}|null, recorded: boolean|null, otherBurn: boolean|null, solanaAddress, mint, tokenProgram, cluster}`
  (`activation.siteView`, read on every `approval.get` while not busy; `mode`, `recorded` and `otherBurn` null while
  locked or before a first read; `recorded`: the QNet network lists the wallet's light activation's node with its
  registration of this burn (`onchain`), `otherBurn`: with a registration of another burn (`other_burn`, EXT-R2A-03),
  the only parts of the registration the window draws, so the registration's other steps never bump the revision nor
  redraw the window: EXT-FA1-02), claimNodeBalance `{mode:
  'claim'|'empty'|'unavailable'|null, reason: 'NO_NODE'|'NETWORK'|'SIGNING_DISABLED'|null, nodeId, wallet, amountNano}`
  (`nodes.claimView`, read on every `approval.get` while not busy, checked against this wallet's own light node; null
  while locked or before a first read), unlinkNodeDevice `{mode: 'confirm'|'unavailable'|null, reason, nodeId, wallet, platform,
  linkedSince}` (`nodes.unlinkView`, read on every `approval.get` while not busy, checked against this wallet's own light node;
  null while locked or before a first read). The worker signs exactly the last preview it served, and only when the page
  names that preview's revision.
- `activateNode` (QNet Link v1 section 10): the price of the first `burn` view is fixed for the
  approval's life (`siteView` gets it back as `known.cost`, and the burn re-checks it:
  `PRICE_CHANGED` resets it and the window reviews again); the network's word that the wallet has no node
  (`refuseExistingNodes`, section 9) is asked until it vouches once per approval (the burn asks again). The page shows, per mode: the burn (node type, amount, token and cluster, mint, SPL Token
  program, the burning Solana address and its balances, the warnings, an acknowledgement checkbox), or
  the wallet's activation (masked code) or pending burn, with what the site receives. No password field: Confirm arms
  after `CONFIRM_ARM_VALUE_MS` like a transaction and, for a burn, also needs the acknowledgement. A redraw (what the
  view shows changed) arms the confirm again from the start, and a burn's acknowledgement is given again (EXT-FA1-02).
  `approval.resolve {approved: true, revision}` runs `activation.activateForSite` with the shown price
  for a burn, `null` otherwise; `LOCKED` and `PRICE_CHANGED` keep the approval open. Every other outcome is the
  dApp's result (failures included, as `{status: 'error'}`), the page shows it (progress while it runs, with a
  `vault.status` keepalive every 20 s) and the window stays until closed, at most 30 s, titled by what happened (the code, a
  burn waiting for Solana, or no code; never "Done": EXT-F5). `checking` (decision 35: the shared search of the wallet's own
  address runs) shows "Checking this wallet: the QNet network, Solana and aiqnet.io…" with only Reject, and the page reads the
  view again every 3 s until another mode comes; a confirm then is `PRICE_CHANGED` (review again), and its close counts like an
  unavailable window's. `unavailable` shows the reason (`err_<reason>`) and one Close button
  that sends `approved: false`: the dApp gets `{status: 'error', error: reason}`. After a light `ok` or `exists` whose
  node is being recorded on the QNet network the window says so (the burn view before the confirm: "Then the wallet
  records its light node..."; an `exists` view of a light activation not listed yet: it is recorded too; one listed with
  another burn's registration: that, and that this burn recorded nothing) and, after the
  answer, reads `activation.registration` every `TIMINGS.REGISTRATION_POLL_MS`; the worker keeps it up to
  `TIMINGS.REGISTRATION_WINDOW_MS` instead of 30 s. Closing it never stops the registration. The page alerts on
  `recipient.lookalike` (address poisoning) and `recipient.incomingOnly` (an address that only sent to this
  wallet), and warns on a first send (`recipient.known` false) (MISS-03, ES-01).
- The page shows the origin from the view (Unicode host, a warning when `idn`), never page-supplied
  names or icons; the confirm button arms `TIMINGS.CONFIRM_ARM_MS` (`CONFIRM_ARM_VALUE_MS`, 1.5 s, for a transaction
  of any kind or a burn) after the window was last left alone: a press, release or key anywhere in the window before it
  armed starts the wait again, and a click counts only when its press began on the button after it armed
  (R2-ERP-02, the mobile `useArmedConfirm` rule). It acts only on a trusted pointer click (`detail >= 1`,
  pointer type mouse, pen or touch; Enter or Space on the focused button never confirms: ES-02) while
  `document.hasFocus()`. A message to sign shows its line count, and Sign stays off until the whole text has
  been in view (R2-ERP-05). A send names unconfirmed earlier sends and a same-amount payment to the same
  address (R2-EXTQ-03); a heartbeat calls `approval.get` every
  `TIMINGS.APPROVAL_HEARTBEAT_MS` and closes the window on `NOT_FOUND`. Locked: unlock first, then the request with its
  armed confirm and no password; a connect with `alreadyGranted` resolves right after the unlock.

- `claimNodeBalance`: the page shows the wallet's light node id, the node balance two pinned nodes agree on (labelled
  so), "Moves at 1 QNC or more" with the note that a large balance may move in parts below it, and the fee note; its
  confirm arms after `CONFIRM_ARM_VALUE_MS` like a transaction, names
  the revision it shows (`REVISIONED`; another one is `NONCE_CHANGED`: review again) and, like every approval, takes no
  password (refused with `INVALID_PARAMS`). A balance below 1 QNC (`empty`) or an `unavailable` view offers one Close that sends
  `approved: false`: the dApp gets `{status: 'empty', qnet, nodeId}` or `{status: 'error', error: reason}`
  (`SIGNING_DISABLED` as `INTERNAL`), counted like an unavailable activation (the first close counts nothing). The outcome
  (the amount moved, a part of the balance, or the error) stays until closed, at most 30 s.
- `unlinkNodeDevice` (decision 38): the page shows what happens (the node stops running on the device it runs on now; the node
  and its balance stay with the wallet, and it can run on any device later), the wallet's light node id, the device the network
  names (Android, iPhone or iPad, or an unknown device) and the day it was linked; its confirm arms after `CONFIRM_ARM_MS`,
  names the revision it shows (`REVISIONED`; another one is `NONCE_CHANGED`) and takes no password. An `unavailable` view
  (no device runs the node, a network that does not take the unlink yet, no two nodes alike, signing off) offers one Close that
  sends `approved: false`: the dApp gets `{status: 'error', error}` (`UNSUPPORTED` and `SIGNING_DISABLED` as `INTERNAL`),
  counted like an unavailable activation. The outcome (the device unlinked, or the reason) stays until closed, at most 30 s.

### 4.9 Token transfers, contract calls and transaction status

- **Params** (`router.normalizeTransaction`, strict: unknown keys -32602): `type` absent or `'transfer'`: `{to, amount}`
  as before. `'tokenTransfer'`: `token` and `to` EON, `amount` a canonical decimal above zero with at most 18 fraction
  digits. `'contractCall'`: `contract` EON, `method` `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`, `args` hex of whole bytes in
  either case, taken as lowercase, 0 to `router.CALL_ARGS_MAX_BYTES` (4096) bytes (`''`: no input; the calldata carries it
  as the empty string `""`, which the node decodes to no bytes), `gasLimit` an optional JSON integer from the call's
  intrinsic gas plus `core.WASM_MIN_FUEL` to `core.MAX_GAS_LIMIT`; the same shape as the mobile in-app browser
  (`browser/dappRequests.js`); `value` or `accessList` → `UNSUPPORTED_PARAM` (section 4.5). No deploy is offered to sites.
- **Before the window** (`provider.js`, after the grant and the cooldown checks): `qnet.readContract(address)` (two
  pinned nodes alike on `GET /api/v1/token/{address}`, kept a minute unless none): a token transfer needs a `qrc20`
  token of at most 18 decimals, and its amount becomes base units exactly (`amount.parseUnits`, u64); a call needs a
  contract that is no token. Anything else is -32602, an unreadable contract -32603.
- **A recipient that is a contract** (EXT-R2A-01, the SDK's `--to-contract` rule without an override): a contract
  account has no key and no contract can send QNC or a built-in token on, and the node credits such a transfer today, so
  what reaches one stays there for good. `qnet.assertPayableRecipient(to)` (`readContract`: `kind` other than `none`)
  refuses it: before the window of a `transfer` or a `tokenTransfer` (its `to`; the token contract itself included) with
  -32602 (`RECIPIENT_IS_CONTRACT`), a recipient no two nodes agree on with -32603 (`RECIPIENT_UNCHECKED`); and again in
  `prepareTransfer` / `sendTransfer` / `prepareCall` / `sendCall` for a token transfer, so neither the popup's review
  (`qnet.preview`: no review, the error in the form) nor any confirm signs one. The wallet's own address is not read.
- **What the wallet builds** (`qnet.prepareCall` for the view, `qnet.sendCall` for the confirm): `core.buildTokenTransfer`
  (gas limit = intrinsic gas) or `core.buildContractCall` (gas limit = the site's, or intrinsic gas + `core.WASM_DEFAULT_FUEL`);
  maximum fee = effective price × gas limit; a token transfer to a recipient that holds none of the token (its certified
  balance proven 0, or not readable) adds the refundable storage deposit (`core.fees.STORAGE_DEPOSIT_NANO`); the confirm
  re-reads both and refuses a changed fee or deposit (`FEE_CHANGED`), a token balance below the amount or a QNC balance
  below fee + deposit (`INSUFFICIENT_FUNDS`), a token balance that cannot be had (`NETWORK`: no node answered,
  `BALANCE_UNCONFIRMED`: none certified); the node's door checks neither, and a transaction skipped at apply holds its
  nonce. The token balance a send is decided by (`qnet.tokenSide`, decision 44): the sender's certified balance from the
  two-level token proof at the macroblock of the QNC proof the send rule used (one certified state), less the tokens its
  own token transfers took from that state's nonce up to the chain's and may still move (the unconfirmed ones, the one a
  replacement signs over left out); while a contract call of this wallet above that nonce is not taken in, what it moved
  is not known and no token balance is decided (`BALANCE_UNCONFIRMED`). Signed by `keys.signQnetTokenTransfer` / `signQnetContractCall` (the core builds the calldata and preimage from
  the typed fields and self-verifies), checked against the builder's preimage, sent as `core.contractCallRequestJson` to
  `core.TX_ROUTES.call.path`, and kept as a `PendingTransfer` of kind `call` (section 5) under the transfer rules.
- **One transaction in flight**: the node admits a transaction only at the committed nonce + 1. Every preview says
  `inFlight` when an earlier transaction of the wallet still holds the nonce before its own; a site's approval (all three
  kinds) keeps Confirm off and reads the view again every 4 s until it is in a block, and `sendTransfer` / `sendCall` with
  `oneInFlight` refuse any other nonce (`NONCE_CHANGED`, the window reviews again). The popup's own sends are unchanged.
- **Approval** (`ApprovalView` kinds `tokenTransfer`, `contractCall`, section 4.8): the confirm arms after
  `CONFIRM_ARM_VALUE_MS` and names the revision it shows, like a send. A token transfer shows the token's name and symbol
  as two nodes read them (labelled so; text the window cannot draw exactly, `core.isVisibleText`, is left out), a token
  named after QNet's coin (`core.usesReservedName`: "it is not QNC"), the contract, the recipient with the transfer
  warnings, the burn address (`core.destroysTokens`), the amount in the token's units, fee, deposit, QNC total and the
  token balance. A call shows the contract with the unknown-contract warning, the method, the input as hex with its
  size and, when it reads as text, as that text, the gas limit, the maximum fee, and that a call moves no QNC and its
  outcome is not seen.
- **`qnet_getTransactionStatus`** (`qnet.transactionStatus`): `pending` while the verified account nonce is below it and
  this wallet still sends a transaction there (pending or superseded; a refused one it no longer sends); `in_block` when
  the nonce is used and two pinned nodes list the same one transaction of `from` at it in their newest 100 sends, with the
  hash they list and the height two nodes report alike (`GET /api/v1/transaction/{hash}`), each null otherwise;
  `unknown` in every other case. In a block is never "applied": the node keeps no outcome (decision 25). The site gets
  `{status, blockHeight, txHash}` (`provider.js` `statusAnswer`): a failed read, or an answer about another (`from`,
  `nonce`), is `unknown`, and height and hash leave only with `in_block`.

### 4.10 The light node on the QNet network (`nodes.js`)

The messages are those of docs/protocols/light-node-messages.md section 4, built and signed by the core
(`core.signNodeConsent`, `signOwnerBind`, `signClaimQuote`, `signClaimPayload`, `signNodeStatus`: the node id and the proof are the
wallet's own, computed inside; ML-DSA-65 with an empty context, Ed25519 for the owner bind; and `signNodeUnbind`, decision
38). The extension never runs a node, never answers pings and sends no device evidence: after a light activation the
Activate tab names no next step, and its one line leads to aiqnet.io/node, where the node is linked to a phone or tablet
with the same recovery phrase (decision 41).

- **Registration record** (`VaultState.registration`, section 5): written in the same vault update as the light
  activation it records (`settleBurn`, `storeCanonical`), queued again by a confirmed `qnet_activateNode` for an existing
  light activation that stopped or has none, and by `activation.register`. A Super activation has none. An activation of
  an earlier build (no record) is never registered unasked: a read of `activation.registration` looks it up on chain at
  most every `TIMINGS.REGISTRATION_CHECK_MS` and records `onchain` when the chain lists it; otherwise the popup offers
  Record on the network. Recover stores the activation it finds with its registration queued; its card is its title
  ("Already burned?") and its button ("Recover my code"), with no text on how it works (owner, 28.09), and the registration
  shows on the Activate tab once the activation is stored, until the chain lists the node (decision 41).
- **Whose burn** (EXT-R2A-03): two nodes listing the node say that a registration holds it, not whose burn it names.
  Before a record becomes `onchain` (the chain read of an attempt, an `already_registered` answer, an activation of an
  earlier build) `nodes.registeredBurn` reads the burn from the signed status (two nodes alike): this record's burn →
  `onchain`; another burn (aiqnet.io's payment key registered this wallet's node first, say) → `other_burn`, which stops
  (no submit, no alarm; a retry never queues it; read again like `onchain` below, and queued from the start once two
  nodes no longer list the node); not known → no submit, `queued` with `lastError: 'burn_unknown'` after a retry's wait
  (an attempt, so the cap stops it). A network whose public status lists no `status_signed` (two nodes alike) has only
  the listing: `onchain`, as before.
- **The chain's word** is two pinned nodes' (`onChain`: `GET /api/v1/light-node/status?node_id=N`, `onchain_registered`
  as two report it alike), never one's: a stale row or a block a rollback took back would otherwise end the record for
  good (EXT-R1-02). A record `onchain` of the phrase's own burn is read again when the user or a confirmed
  `qnet_activateNode` asks, else at most every `TIMINGS.REGISTRATION_CHECK_MS` on a resume; two nodes that both no longer
  list the node queue it again from the start (`lastError: 'not_listed'`) and submit. A record of a burn aiqnet.io paid
  stays `onchain` (no owner bind here to submit again).
- **One attempt**, one at a time (a background resume asked while one waits is that one): unlocked, else nothing;
  the chain first (two nodes listing the node end it: `onchain`, no submit); an admitted registration waits
  `TIMINGS.REGISTRATION_ADMIT_HOLD_MS` (10 min) for a block, the chain read at most every
  `TIMINGS.REGISTRATION_ADMIT_CHECK_MS` meanwhile, past the attempt cap too (a hold that ends without a block at the cap
  stops it: `queued`, `lastError: 'not_in_block'`, Record on the network); then
  `keys.signNodeRegistration` with `T` = now (seconds) and `POST /api/v1/node-registration/submit` to ONE pinned node
  (never hedged: the node builds and hashes the transaction itself) within `TIMINGS.REGISTRATION_SUBMIT_TIMEOUT_MS`, the
  body in the app's field order: `from, node_id, node_type: 'light', wallet_address, registration_proof, timestamp,
  burn_tx_hash, burn_amount, burn_wallet, dilithium_signature, dilithium_public_key, owner_signature` (hex). The burner
  is the wallet's Solana address, whose key signs the owner bind.
- **Answers** (the node's stable `code` first, its text when it sends none): `success` with a 64-hex `tx_hash` →
  `admitted`; `already_registered` → `onchain` once two nodes list the node, else a retry (`lastError:
  'already_registered'`); `timestamp_window` → `clock` (stops; the next manual try signs afresh);
  `behind_chain`, `committee_unavailable`, `quorum_pending`, `mempool_rejected`, `rate_limited`, `bind_v2_pending` (an
  owner bind without a time, which the network takes only from its one-node gate on; its text "owner bind without a
  time is not accepted" when a node sends no code; the extension's own bind carries the time), no answer or an
  unreadable one → a retry after 15 s, 30 s, 60 s, then 2, 4, 8 ... minutes up to `TIMINGS.REGISTRATION_BACKOFF_MAX_MS`
  (6 h); `wallet_has_node` (the network's one-node rule: this wallet has a node of either type already; its text "wallet
  already has a node" when a node sends no code) → `refused` for good, never `onchain` and never retried; the popup says so
  (`recordRefusedWalletHasNode`) with no Record on the network, and so does the activation window's record line, which
  reads a registration the answer shows as `refused` once more (`activation.registration`: the answer's `registration`
  names no `lastError`) and polls one being made, decision 36; anything else (an
  HTTP refusal included) → `refused` (stops; the code is logged, never shown). After
  `LIMITS.REGISTRATION_MAX_ATTEMPTS` (12) automatic submits only the user's Record on the network tries again.
- **When it runs**: right after the activation is stored (`activation.setRegistrationHook`, wired by sw.js), after every
  unlock, on the `REGISTRATION_ALARM` (`qnet-register`, every minute while a record waits for an automatic attempt, and
  cleared otherwise and while the wallet is locked), on a page's `activation.registration`, and on `activation.register` (at once, whatever is due).
- **Moving the node balance** (`qnet_claimNodeBalance`, as the app moves it): the view reads `onchain_registered` for N
  (else `NO_NODE`; unknown `NETWORK`) and `GET /api/v1/rewards/pending/{N}` until two pinned nodes report the same
  `pending_rewards_nano` (else `NETWORK`); below `CLAIM_MIN_NANO` it is `empty`. The confirm signs the quote
  (`q1337|claim_rewards:{N}:{W}`) and posts `/api/v1/rewards/claim` (hedged; a node answering that it cannot serve an
  epoch, `stopped_reason` without a quote, hands over to the next pinned node, EXT-R1-07); the quote must parse, list
  claims strictly ascending above `last_claimed_epoch` with amounts summing to `amount_nano` (at least `CLAIM_MIN_NANO`
  for a full batch; above zero for a part, since the node caps a quote by size and a balance of many small epochs moves
  whole only in several claims: EXT-R1-03, decision 29),
  carry a `claim_timestamp`, a `stopped_at_epoch` (a part of the balance) above its last epoch, and name no other
  `sign_message` than the one the wallet builds. A part of the balance is quoted again by another pinned node with the
  same request (the claim_rewards signature carries no time; EXT-R3-01): both quotes pass the same checks and name the
  same `last_claimed_epoch`, and the one whose last epoch is lower is signed only when the other lists exactly its
  epochs and amounts up to that epoch (the other covers every epoch below its own stop, so an epoch left out between
  the first and last one shows); any difference is `CLAIM_REFUSED`, no second quote its refusal (`NETWORK` when no
  other node answers). Then other pinned nodes than the one whose quote is signed are asked, two first and then
  one at a time: every `first_unclaimed_epoch` they report must equal its first epoch (one disagreeing:
  `CLAIM_REFUSED`), and a full batch (no `stopped_at_epoch`) must reach the `pending_rewards_nano` two of them report
  alike, which can only under-report the claim path (below it: an epoch was skipped, `CLAIM_REFUSED`, EXT-R1-06); none
  answering, or for a full batch no two alike: `NETWORK`.
  Then the payload is signed over `q1337|qnet_claim_v1:{W}:{ts}:{sha3(claims_data)}` and sent back to the node that
  quoted the signed quote with `claims_data`, `claims_signature` and `claim_timestamp`. "Claim already in progress" is `CLAIM_BUSY`,
  "No claimable rewards" `empty`, "not registered on-chain" `NO_NODE`, any other refusal `CLAIM_REFUSED`.
- **Unlinking the node's device** (decision 38; light-node-messages.md section 4, the wallet form of the unbind): the wallet
  key ends the node on whatever device runs it, at aiqnet.io's request (`qnet_unlinkNodeDevice`; the popup offers it no
  longer, decision 41). `unlinkView` reads the public status (`UnlinkView`, section 2.5).
  `unlinkForSite` reads the signed status with the wallet key (as `registeredBurn`): the binding's sequence S is the
  `binding_seq` two pinned nodes report alike with `device_bound: true` (both `false` → `NOT_LINKED`, no two alike, or a
  sequence above `Number.MAX_SAFE_INTEGER` → `NETWORK`; nothing signed). Then `keys.signNodeUnbind` over
  `q1337|light_unbind_wallet:{N}:{S}:{ts}` (ML-DSA-65, empty context; `ts` now in Unix seconds) and `POST
  /api/v1/light-node/unbind` with exactly `{node_id, seq, ts, signer: 'wallet', sig, identity_pubkey}` (hex; `seq` a JSON
  number) to the node whose status gave S, then to the other node that agreed (in its place when the first did not answer).
  Answers: `{success: true, unbound: true}` from either → `ok`; `stale_seq` (another unbind or a newer binding came first) →
  the signed status is read again, two nodes saying no device is bound → `ok`, else `UNLINK_REFUSED`; any other refusal
  (`reason`) or an HTTP refusal → `UNLINK_REFUSED`; no answer from either → `NETWORK`. The genesis nodes copy the unbind to
  each other, and the device stops on its next status read or answer. The wallet form carries no device release.
- **A burn aiqnet.io paid** (owner decision of 2026-09-26: the cabinet's one-time payment key burns for the wallet, and
  the activation code names the wallet, not that key): no search of the phrase's addresses finds it, so Recover, when
  it found no burn of them and the vault holds neither an activation nor a pending burn, reads the node's registration
  record (`nodes.registeredBurn`): `keys.signNodeStatus` over `q1337|light_status:{N}:{ts}` (ML-DSA-65, empty context),
  `POST /api/v1/light-node/status` with `{node_id, ts, signer: 'wallet', sig, identity_pubkey}` (hex; the wallet key,
  which the chain vouches for on a node never linked to a device), and the `burn_tx` two pinned nodes report alike for
  `onchain_registered: true`. That burn is read from Solana at `finalized` and must be a light 1DEV burn
  (`solana.validateBurnTx`, its fee payer the burner). A burner of the phrase keeps the burner's code; any other burner
  is the payment key, and the activation keeps it as `solanaAddress` with the wallet's code
  `core.walletActivationCode(W, burnTx, amount)`: today's format with the wallet's QNet address in place of the
  burner's. Either is stored with its registration `onchain` (nothing is submitted); `PublicActivation.paidOnSite`
  marks the second: the activation window says the node was activated with a burn on aiqnet.io and `qnet_getActivation`
  carries it, while Settings shows its code as any other (decisions 41 and 43).

## 5. Vault (`vault.js`, worker only)

- IndexedDB `qnet-vault-v3`, version 1, object store `vault`: the record under key `main` (and, only while a
  Restore writes the new vault, its staged copy `restoreStaging`, gone with the replace); next to it
  `lightAnchors` = `{v: 1, anchors, mac}`, the light client's verified anchors with an
  HMAC-SHA256 under a key derived from the vault key (EXT-CHAINS-04: a program that can write the profile
  cannot make a walk start elsewhere; a new password invalidates them), and `burnScans` = `{v: 1, scans:
  {[owner or owner + ':signed']: state}, mac}`, what the burn searches of the wallet's Solana address listed
  and checked (`solana.findWalletBurns` over the 1DEV associated account: the valid burns found, the wallet's own burns no
  code derives from as `unusable` since search version 3, R4-ESA-01; `solana.findSignedBurns` over the owner's own
  address, `:signed`: its burns from any other token account, R5-ESA-01), with an HMAC-SHA256 under another key derived from the vault key
  (R2-ESA-02: a written-in state cannot make a search skip a candidate). Every write transaction commits with
  `{durability: 'strict'}`, so `complete` means on disk: a write reported done survives a crash right after it
  (EXT-VAULT-R2-03). Every open
  has `onupgradeneeded` (creates all stores), `onblocked`, `onversionchange` (close); every transaction
  settles its promise; a missing DB or record resolves to "no vault", never hangs (EXT-SEC-21).
- Record (`VaultRecord`):

```
{ v: 3,
  kdf: {alg: 'argon2id', m: 65536, t: 3, p: 1, salt}          // or {alg: 'pbkdf2-sha256', iterations: 600000, salt}
  iv:  base64(12 random bytes, fresh on every write),
  ct:  base64(AES-256-GCM ciphertext || 16-byte tag),
  aad: {v: 3, kdf, walletId, qnetAddress, solanaAddress, createdAt, activationNodeType: null|'light'|'super',
        legacy: null},                                           // a key of the format, always null
  sitesKey: base64(32 random bytes) }                          // grant MAC key, not in the AAD; new on every revoke
```

  A record of an earlier 3.0.0 build (no `legacy` key) opens as it is and the next unlock rewrites it; any other value
  of `aad.legacy` does not parse (`VAULT_CORRUPT`; Restore replaces such a record).

  `salt` is base64 of 16..32 fresh random bytes on every password set or change. AES-GCM
  `additionalData = UTF-8(canonicalJson(aad))`; `record.v` and `record.kdf` must equal `aad.v` and
  `aad.kdf`. `canonicalJson`: keys sorted, no whitespace, only null/booleans/strings/safe
  integers/arrays/plain objects.
- Earlier version (M-4; owner's choice of 2026-10-06: migrate, the option that protects the user). The store's 2.1.x
  kept its wallet in `chrome.storage.local` (`earlier.js`): under `encryptedWallet`, `{encrypted, salt, iv, version}`
  as byte arrays (some builds wrote it as a JSON string), AES-256-GCM of the wallet's JSON under PBKDF2-SHA256 of the
  password as typed (an `iterations` count when the record names one, else 600,000 for `version` 2 and 100,000 before),
  beside `walletExists`, `walletData`, `encryptedActivationCodes`, `wallet`, `isUnlocked`, `lastUnlockTime`,
  `currentNetwork`, `mainnet`, `auto_lock_timer` and `connected_sites` (`earlier.EARLIER_KEYS`), a second copy of the phrase that its setup and popup kept in
  IndexedDB `QNetWallet` / `vault` / `main` (`earlier.EARLIER_DB`: `{salt, encryptedSeedPhrase: {data, iv}, ...}`, base64
  of the bytes' UTF-8, AES-256-GCM of the phrase alone under PBKDF2-SHA256, 100,000 iterations; its password change
  re-encrypted only this copy, so after one only this copy opens with the password the user knows), and a copy of its
  password and addresses in the extension pages' `localStorage`. `vault.status` names a readable record or copy
  (`earlier`); the popup's first screen then says the
  earlier wallet is here and opens setup, which offers, before anything else,
  "Unlock your earlier wallet", "Use my recovery phrase instead" (Import) and "Create a new wallet". `vault.migrate` runs
  only while no vault of this version exists: the backoff of unlock (`session.checkBackoff`; a wrong password counts, a
  right one resets it), the decrypt (the record first, then the pages' copy; the first valid phrase wins), the recovery
  phrase read out of the decrypted bytes in place (the keys beside it are
  never decoded; a line break or tab of a pasted phrase, escaped in the record's JSON, reads as a space) and checked as
  an import checks one (12 or 24 words), the decrypted bytes and the password's bytes
  zeroized; without `newPassword` that is all. With it, `writeNewVault` writes this version's Argon2id vault from the
  phrase's entropy under the new password, reads it back, re-derives both addresses and starts the session, as an import
  does, and only then are the earlier keys and the pages' database removed. A wrong password, an unreadable record or a
  failed write removes nothing. "Use my recovery phrase instead" (or a new wallet) leaves both copies in place: setup's last screen and
  Settings offer to remove them behind one confirmation that says the earlier wallet then opens only with its own
  phrase (`vault.removeEarlier`, while a vault of this version exists and is unlocked). What 2.x left with nothing it
  can open (a placeholder, a copy without the phrase, or no wallet) goes with the first vault written; Delete wallet and
  a Forgot-password restore remove the pages' database with the rest of `chrome.storage.local`. Every extension page empties its own
  `localStorage` and `sessionStorage` when it starts (`common.clearPageStorage`). No secret of the earlier version is
  ever written anywhere by this version.
- KDF: Argon2id (`core.argon2idAsync`, dkLen 32) by default; `assertKdfFloor` refuses anything below
  `KDF_FLOOR` (argon2id m >= 65536 KiB, t >= 3, p = 1; pbkdf2-sha256 >= 600000) on every unlock.
  PBKDF2 only if Argon2id is measured too slow on low-end hardware (document the measurement).
  `core.argon2idAsync` is the pinned hash-wasm 4.12.0 WebAssembly build (R04 "packaged, pinned WASM"),
  compiled into the bundle (base64, no separate file); it gives @noble/hashes argon2id's output for the
  same inputs (`test/vault-session-kdf.test.mjs`, including the vault-parameter answer noble produced),
  so every v3 record opens unchanged. It needs `'wasm-unsafe-eval'` in `script-src` of
  `content_security_policy.extension_pages` (it allows WebAssembly compilation, no JS eval). Measured
  in Node 22 (Windows desktop CPU), m = 64 MiB, t = 3, p = 1: noble 2433 ms median (8.7 s the first,
  cold run), WebAssembly 284 ms; a full `vault.unlock` 2571 ms before, 311 ms after. hash-wasm's WASM
  memories are not zeroized (not reachable after the call and freed with it), like the JS strings the
  password arrives in.
- Plaintext bytes: `[3][entropy length 16|32][entropy][UTF-8 canonicalJson(state)]`, zeroized after
  encryption and after decoding.
- `VaultState = {activation: Activation|null, pendingBurn: PendingBurn|null, pendingTransfers:
  PendingTransfer[] (<= 16, oldest first), settings: {autoLockMinutes: 5|15|30|60|'never'}, recipients: string[],
  legacy: null, solanaRecipients: string[], recentTransfers: RecentTransfer[], exposedAdvice: boolean,
  supersededBurn: SupersededBurn|null, registration: PendingRegistration|null, spends: SpendRecord[]}`; `emptyState()`
  for a new vault. A state of an earlier build (the first four keys and any of the later ones, a pending burn without
  `lastValidBlockHeight`) reads as the same state with the missing keys empty (`[]`, `legacy: null`, `exposedAdvice:
  false`, `supersededBurn: null`, `registration: null`) and `lastValidBlockHeight: null`.
  - `SpendRecord = {nonce, qncNano, token: string|null, tokenAmount: string|null, tokenUnknown: boolean, settledAt:
    number|null}` (decision 44): the most one transaction this wallet signed can take, written in the vault update that
    stores it (`qnet.withSpends`): QNC its amount (a call: the storage deposit) plus its most fee, a token transfer's
    contract and amount, `tokenUnknown` for any other contract call. `settledAt`: when the chain's nonce reached it; a
    settled one goes an hour later, an unsettled one goes with its transaction when the vault no longer keeps it (its nonce
    was not used), at most `LIMITS.SPENDS_MAX` (64), the lowest nonces first; a chain the wallet no longer follows drops
    them all (`qnet.followChain`). The send rule counts the wallet's own transactions above a certified state by them and
    by the kept transactions, so a confirmed one whose record went is still known to a certified state a node still serves
    from before it.
  - `PendingRegistration = {nodeId, burnTx, burner, state: 'queued'|'admitted'|'onchain'|'other_burn'|'refused'|'clock', attempts,
    nextAt, txHash: string|null, admittedAt: number|null, lastError: string|null (a short code), updatedAt}`: public values
    only, no signature (every attempt signs afresh, section 4.10). It exists only next to a light activation whose burn
    and burner it names, for the wallet's own light node (`core.lightNodeId` of the AAD's QNet address); a restore and a
    wipe drop it with the activation.
  - `legacy` (always null) and `exposedAdvice` (a boolean nothing reads, false in every vault written now) are keys of
    the state format: a vault written by an earlier 3.x build opens unchanged.
  - `SupersededBurn = {burnTx, nodeType, burnAmount, solanaAddress, cluster, createdAt}`: this wallet's own finalized
    burn that another device's older burn of the phrase beat (the activation is that older one); its address is the
    wallet's, never the activation's burn (XP-R5-03).
  - `recipients`: the QNet addresses this wallet signed transfers to, oldest first, distinct, never its own,
    at most `vault.RECIPIENTS_MAX` (128; `vault.withRecipient`), the known recipients of ES-01.
  - `solanaRecipients`: the same for the Solana addresses it signed SOL or 1DEV transfers to
    (`vault.withSolanaRecipient`, R3-EXT-UI-03).
  - `recentTransfers`: `{to, amountNano, createdAt}` of every QNC transfer this wallet signed in the last
    `vault.RECENT_TRANSFER_MS` (30 min), at most 64 (`vault.withRecentTransfer`): the double-payment warning's
    own record, kept whatever became of the transfer (R3-EXTQ-01).
  - `PendingBurn` also carries `lastValidBlockHeight` (the blockhash's, `number|null`, EXT-CHAINS-03); the
    public view (`activation.status`, provider) leaves it out.
  - `Activation = {code, nodeType, burnTx, burnAmount, solanaAddress, cluster, createdAt}`, at most ONE
    per wallet (R15); `aad.activationNodeType` always equals `state.activation?.nodeType ?? null`; its
    `solanaAddress` (the burner) is the wallet's. `code` is the burner's code
    (`core.generateActivationCode`), except for a light burn aiqnet.io's one-time payment key made for this wallet
    (section 4.10): its burner is that key, its code the wallet's (`core.walletActivationCode` of the AAD's QNet
    address), and it exists only with its registration `onchain` (`isPaidOnSite`, checked with the AAD).
  - `PendingTransfer = {nonce, to, amountNano, feeNano, body, txHash: string|null, createdAt,
    lastSubmitAt, outcome: 'pending'|'replaced'|'passed'|'superseded'|'refused', kind: 'transfer'|'call', call}` (`kind`
    `call`: a site's token transfer or contract call, section 4.9: `to` its contract, `amountNano` the storage deposit it
    sets aside or `'0'`, `feeNano` its maximum fee, `body` POSTed to the call route, verdicts by a `contract_call` row to
    that contract; `call` = `{method, recipient: string|null, amount: string|null}`, a token transfer's recipient and base
    units, else both null; for a transfer `call` is null; a record of an earlier build without `kind` reads as a transfer,
    `vault.PENDING_KINDS`); `body` is the exact JSON POSTed; a retry
    resends it byte for byte, never re-signs, and a body a node accepted goes out again only every 10 minutes (each POST
    may add another copy with another hash: R5-EXTQ-03). `refused`: the only node sent it refused it, which is one
    node's word (R5-EXTQ-02): listed and reserved, never sent again by the wallet, decided by the chain like the others,
    and the next transfer takes its nonce by default (a replace), so it and the new one are never both paid. At each
    nonce the largest amount plus fee of the transfers there is reserved: at most one of them applies. A transfer of an earlier build (no `outcome`) reads as `pending`.
    `superseded`: a replacement at its nonce is being submitted (R4-EXTQ-01): not resent, still listed and reserved;
    it goes once a node took the replacement or may hold it, is `pending` again when the replacement is refused or
    gone, and is decided by the chain as a pending one once its nonce passed. `replaced`:
    another transaction took its nonce (its `lastSubmitAt` is when that was seen; listed a day, then dropped).
    A pending transfer is resent for an hour, then kept as stale (reserved, not resent) until the chain
    decides it by the history row at (from, nonce) that two pinned nodes list alike (R2-EXTQ-02, R3-EXTQ-04):
    this transfer → dropped, another one → replaced; its nonce passed but no such row yet → `passed` (not resent,
    not reserved, shown as outcome unknown; decided on a later run, or dropped a day after it was seen).
- Password: NFKC. A new password (`vault.normalizeNewPassword`, on every path that sets a vault password: create,
  import, restore, change) needs at least `core.PASSWORD_MIN_LENGTH` (8) characters as typed (`core.passwordTooShort`,
  the rule the app uses, compiled from the same source), nothing else; the pages show the rule live (the line
  "At least 8 characters" turns from × to ✓) and check that it was typed twice before sending. The password of an
  existing vault is only normalized (`normalizePassword`), so a vault opens with whatever password it was made with.
  Never stored, hashed or logged; verification = successful decrypt. Unlock always decrypts, even when already
  unlocked, then re-derives both addresses and compares them with the AAD (`ADDRESS_MISMATCH`).
- Create/import: 12 or 24 words and a password, nothing else; refuse when a vault exists (a vault is replaced only by
  wipe or Restore); write, read back, decrypt with the entered password, re-derive and compare addresses, only then
  start the session (EXT-SEC-M2).
- Reveal: `vault.reveal` decrypts with the password and answers the phrase (section 8 for its Copy button).
- Wipe: password check; then `session.lock('wipe')`, close connections, await `deleteDatabase` (success,
  blocked, error), reset the password backoff (memory and storage; only once the database is deleted),
  clear `chrome.storage.local` and `session`, verify the vault is gone (only the self-test pass, which is
  not wallet data, may be written again meanwhile).
- Restore ("Forgot password?" on the popup lock screen → Reset wallet): the popup says the extension cannot recover the
  password, gives one warning (the reset removes the wallet from this browser; only its recovery phrase brings it
  back) and takes the recovery phrase and a new password (checked in the page). No word is typed. On Continue,
  `vault.restoreBegin` issues a one-time token (32 random bytes, hex) bound to that popup document
  (`sender.url`, `sender.documentId`, `sender.tab.id`) for `TIMINGS.RESTORE_TOKEN_TTL_MS`, in worker
  memory only (a newer token replaces it). `vault.restore` takes the token first (any call spends it;
  wrong, expired, foreign or missing → `RESTORE_EXPIRED`), then checks the new password and the phrase
  (canonicalized, validated) and derives both addresses. It compares them with the replaced record's AAD
  (no password needed). Without `confirm: 'ERASE'` it only answers `{status: 'confirm', erased, restored, otherWallet}`,
  erases nothing and hands the token back: the popup's one confirmation names the wallet in this browser by its
  addresses (the same phrase: it opens again with the new password at the same addresses; another wallet
  (EXT-VAULT-R2-04): a danger notice and both wallets, the one removed and the one that takes its place) and one
  checkbox ("I understand the wallet in this browser will be replaced") arms Reset wallet, which repeats the call with
  the same token, `confirm: 'ERASE'` and, for another wallet, `replaceOther` (without it another wallet is only named
  again). A record that does not parse cannot be compared (`erased` null, said on the confirmation) and is replaced
  once confirmed (it cannot be opened: R2-ESM-05). Then the key
  and the sealed record, written BEFORE the old vault goes (EXT-VAULT-R3-04): staged under `restoreStaging` and
  read back, then one strict transaction clears the store (the old record, anchors, burn searches) and puts the new
  record, so the old vault or the new one is there whatever fails or crashes; then
  `session.lock('wipe')`, the final record read back, decrypted and its addresses compared (EXT-SEC-M2), the
  backoff reset, the old wallet's `chrome.storage` entries cleared (best effort: they open nothing of the new
  wallet), and the session started unless the screen locked meanwhile. Only the popup may send either type
  (router), and the handlers refuse any other page too. The popup checks the phrase and passwords before sending.
- Only `vault.js` opens `qnet-vault-v3`. `updateState` calls are serialized.

## 6. Session, lock and backoff (`session.js`)

- Memory: `{vaultKey: Uint8Array(32), walletId, qnetAddress, solanaAddress, autoLockMinutes,
  lockDeadline}`. Mirror: `chrome.storage.session['qnet_session_v3'] = {v: 3, key: base64(vaultKey),
  walletId, qnetAddress, solanaAddress, autoLockMinutes, lockDeadline}`. `initSession` first calls
  `chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})` (and the same on
  `storage.local`, best effort), then restores a mirror whose deadline is ahead, else clears it.
- Deadline = now + autoLockMinutes (default 15; choices 5/15/30/60 and `'never'`, `AUTO_LOCK_CHOICES`). One alarm
  `qnet-auto-lock`; the deadline is also checked on every `requireUnlocked`. `touch()` after activity
  types only; reads and polling never extend. Never (owner, 28.09): `lockDeadline` null and no alarm; the session
  still ends on Lock, the OS screen lock, a browser start, and when the browser closes (`storage.session` goes with it).
- Lock on: `vault.lock`, deadline, `runtime.onStartup`, `idle` state `locked`, wipe, and any error that
  makes the session doubtful (`'error'`). Lock zeroizes the key, clears memory and the mirror, clears
  the alarm and calls every `onLockChange` listener; it never throws. The unlock state is never a
  stored boolean. A session whose password check (Argon2id, about a second) began before a `user`, `idle` or
  `startup` lock, or that would start while `chrome.idle.queryState` reports `locked`, never starts
  (`session.lockMark()` taken before the KDF, `startSession({since})`: R3-ESM-03); an unlock then fails with
  `LOCKED`, and a vault just written (create, import, restore) stays locked (`lockDeadline` null).
- Backoff: `chrome.storage.session['qnet_backoff_v3'] = {failures, until}`; shared by every password
  check (unlock, reveal, wipe, change password; the burn and the code take none: decision 33); first 3 failures free, then 1 s
  doubling up to 5 min (`backoffDelayMs`); `BACKOFF` with `retryAfterMs`. The failures belong to the
  vault: a wipe or a restore resets them after the database is deleted, a refused restore keeps them.
- Crypto self-test (R18, `keys.startKeys` at worker start, after `initSession`): a pass is cached for the
  browser session in `chrome.storage.session['qnet_selftest_v3'] = {v: 1, bundle, passedAt}`, where
  `bundle` is `CORE_VERSION + ':' + SHA-256 hex` of the shipped `lib/qnet-core.js` (the worker fetches
  its own file); a worker that finds a pass for these exact bytes skips `core.selfTest()` (about 2 s cold).
  A failure is never cached; without a readable bundle nothing is cached. Signing (and address
  derivation) stays disabled until a pass: a request that arrives before the start settles runs the test
  synchronously (`initKeys`).

## 7. Storage map

| Area | Key | Content | Writer | Trust |
|---|---|---|---|---|
| IndexedDB `qnet-vault-v3` / `vault` | `main` | `VaultRecord` | vault.js | authenticated by decrypt; `sitesKey` by origin isolation |
| IndexedDB `qnet-vault-v3` / `vault` | `lightAnchors` | `{v: 1, anchors, mac}` verified light-client anchors | vault.js (for qnet.js) | HMAC under a key derived from the vault key; ignored when it does not verify |
| IndexedDB `qnet-vault-v3` / `vault` | `chainCache` | `{v: 1, cache: {chain?, headIndex?, views?: {qnetBalance?, qnetTokens?, solanaBalances?}}, mac}`: the build's chain identity (`core.chainIdentity`), the highest network head (macroblock index) the wallet saw, kept in steps of 10, and the last verified balances kept across sessions (decision 40) | vault.js (`updateChainCache`, for qnet.js and session.js) | HMAC under a key derived from the vault key; ignored when it does not verify; public data only; its read or write never locks the session |
| IndexedDB `qnet-vault-v3` / `vault` | `burnScans` | `{v: 1, scans: {[owner or owner + ':signed']: state}, mac}` the kept burn searches (both kinds of the wallet's Solana address; a state of an earlier search version is listed again) | vault.js (for activation.js) | HMAC under a key derived from the vault key; ignored when it does not verify |
| IndexedDB `qnet-vault-v3` / `vault` | `restoreStaging` | the new `VaultRecord` of a Restore, only between its write and the replacing transaction (EXT-VAULT-R3-04) | vault.js | read back before the replace; the replace clears it; a restore that fails before the replace deletes it, and one a stopped worker left goes at the next worker start or unlock (R5-ESM-03) |
| `chrome.storage.session` | `qnet_session_v3` | stored session | session.js | trusted contexts only |
| `chrome.storage.session` | `qnet_backoff_v3` | `{failures, until}` | session.js | trusted contexts only |
| `chrome.storage.session` | `qnet_selftest_v3` | `{v: 1, bundle, passedAt}` crypto self-test pass | keys.js | trusted contexts only; used only for the same bundle bytes |
| `chrome.storage.session` | `qnet_approval_cooldown_v3` | `{[origin]: {rejections, until, windows}}` | provider.js | trusted contexts only; shape-checked, capped |
| `chrome.storage.session` | `qnet_view_cache_v3` | `{walletId, values: {qnetBalance?, qnetHistory?, solanaBalances?, solanaHistory?, qnetTokens?}}` the popup's view cache (decision 39) | session.js (for the router) | trusted contexts only; public answers of the session's wallet only, read only for that wallet; removed by every lock and every new session |
| `chrome.storage.local` | `qnet_sites_v3` | grants with MAC | provider.js | untrusted until the MAC verifies |
| `chrome.storage.local` | `qnet_settings_v3` | `{language}`, a UI preference (`SUPPORTED_LANGUAGES`) | session.js | untrusted, allow-list validated; the worst a writer can do is change the UI language |
| IndexedDB `QNetWallet` / `vault` | `main` | what the store's 2.1.x pages kept: the recovery phrase and two keys, each sealed under its password (section 5, Earlier version) | never written by this version; never created (a read opens it only when `indexedDB.databases()` lists it, and aborts an upgrade from version 0) | read only by `vault.status` (`earlier`) and `vault.migrate`; deleted with the earlier keys (after a migration read its vault back, by `vault.removeEarlier`, with the first vault when it holds no phrase and no readable record is there, by Delete wallet and by a restore) |
| `chrome.storage.local` | `earlier.EARLIER_KEYS` (`encryptedWallet`, `walletExists`, `walletData`, `encryptedActivationCodes`, `wallet`, `isUnlocked`, `lastUnlockTime`, `currentNetwork`, `mainnet`, `auto_lock_timer`, `connected_sites`) | what the store's 2.1.x left: its encrypted wallet and the keys beside it (section 5, Earlier version) | never written by this version | read only by `vault.migrate` (a record that does not open moves nothing); removed after a migration read its vault back, by `vault.removeEarlier`, or with the first vault when no readable record is there |

Nothing else is stored: pages keep nothing in `localStorage` or `sessionStorage`, and empty both when they start (the
light node's registration lives
in the vault state; its alarm `qnet-register` holds no data). Approvals, the restore token, the burn single-flight, the registration's one-at-a-time lane,
the shared search's last verdict, what the last sync learnt of aiqnet.io's record, the `qnet_getActivation` read counts and the
Solana History's rows read so far (at most 500) live in worker memory (aiqnet.io keeps the record itself, decision 35); a
worker restart drops them (the relay answers 4900, the approve window closes on `NOT_FOUND`, a restore
answers `RESTORE_EXPIRED` before erasing anything, a sent burn survives as `pendingBurn`). The popup keeps
the worker up while a restore token exists, from Continue to the reset confirmation (`vault.status` every `TIMINGS.RESTORE_KEEPALIVE_MS`,
R2-ESM-06), as the approve window does with its heartbeat.

## 8. The recovery phrase on screen and on the clipboard (`ui/setup.js`, `ui/popup.js`)

- Where it shows: the setup screen of a new wallet (the word grid, behind Show the words, hidden again after
  `max(TIMINGS.REVEAL_AUTO_HIDE_MS, 2 min)`, on a screen lock, a hidden tab, a lost focus and ten idle minutes; the
  grid is never selected, copied, cut or dragged out) and Settings → Recovery phrase (owner, 06.10: after the warning and
  the password the words show at once, then Copy and Done; no press-and-hold and no timer; they leave the page with the
  screen: Done, another tab, a lock, the popup closing). Settings → Private key is the same: the chosen account's key at
  once, then Copy and Done, with no account or address block.
- Its Copy button (owner decision of 2026-09-28), on both screens while the words are shown: an explicit click
  only, never on its own; on the setup screen the warning next to it says that anyone who can read the clipboard can
  take the wallet and that the clipboard is cleared in 60 seconds if the page stays open (`phraseCopyWarn`); Settings
  shows no clipboard text (owner, 06.10) and clears it the same way, silently. It copies the canonical words in one line,
  as every import takes them (`common.copyText(words, {clearAfterMs: TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS, untilFocused:
  true})`), and says "Recovery phrase copied"; the key's Copy says "Private key copied".
- Clearing: after `TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS` (60 s) the page writes an empty clipboard if nothing was copied
  from it since (the page cannot read the clipboard: that needs the clipboardRead permission); a page without the focus
  then clears it as soon as it has the focus again. Setup clears it when the wallet is set up (`common.clearCopiedNow`),
  since the user may close the tab before that timer would run; a wallet deletion empties the clipboard whatever it holds (R16,
  section 3). A closed page cannot clear: the popup closes when the user clicks elsewhere, which the warning's "if the
  page stays open" covers.
- One line on the setup screen: anyone with the words controls the wallet (`setupWordsWarn`); the reveal has one line
  before its password (`revealWarn`), and the setup screen's copy line is `phraseCopyWarn` (owner, 28.09: one short line
  where an action is irreversible).
- Import and Restore take the 12 or 24 words and a new password, nothing else; a pasted phrase leaves the clipboard
  at once and again on every way out of the step (R3-EXT-UI-02).

## 9. Module APIs

Signatures in short; the JSDoc in each file is the full contract (params, returns, throws).

**config.js** (frozen constants): `DEV_BUILD, WALLET_VERSION, RELEASE_CHANNEL, QNET {CHAIN_ID, NETWORK,
NODES, EXPLORER_API, EXPLORER_TX_PATH}, SOLANA {CLUSTER, RPC_URLS, ONE_DEV_MINT, MEMO_V1_PROGRAM,
NODE_TYPE_MEMO, FEE_BUFFER_LAMPORTS, EXPLORER_TX_URL, EXPLORER_CLUSTER_QUERY, TRANSACTION_MAX_BYTES}, PAYMENT_REQUEST
{REFERENCES_MAX, MEMO_MAX_BYTES}, DECIMALS, UI_PAGES, PROVIDER, VIEW_EVENT_CHANNEL, VIEW_EVENTS, STORAGE_KEYS, VAULT_DB,
AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MINUTES, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, RTL_LANGUAGES, LIMITS, TIMINGS,
AUTO_LOCK_ALARM, REGISTRATION_ALARM, CLAIM_MIN_NANO`, pure `languageForTag(tag) → code|null` and
`isPaymentRequestMemo(text) → boolean` (decision 34). `PROVIDER` includes `CHANNEL`
(`'extension'`) and `ACTIVATION_ORIGIN`. `LIMITS` includes `REGISTRATION_MAX_ATTEMPTS`; `TIMINGS` includes
`REGISTRATION_SUBMIT_TIMEOUT_MS`, `REGISTRATION_ADMIT_HOLD_MS`, `REGISTRATION_ADMIT_CHECK_MS`, `REGISTRATION_SOON_MS`,
`REGISTRATION_FIRST_RETRY_MS`, `REGISTRATION_BACKOFF_MAX_MS`, `REGISTRATION_CHECK_MS`, `REGISTRATION_WINDOW_MS`,
`REGISTRATION_POLL_MS` (section 4.10). Decision 35: `RECORD_PATH` (`'/api/cabinet/activation/'`, the only path asked of
`QNET.EXPLORER_API` for aiqnet.io's record), `RECORD_ORIGIN` (`'https://aiqnet.io'`, the origin a burn record's proof names in
every build), `PROVIDER.TAB_EVENT` (`'qnet-provider-event'`, mirrored in `content/relay.js`), `LIMITS.ACTIVATION_READS_PER_MINUTE`
(30), `TIMINGS.RECORD_TIMEOUT_MS` (8 s), `RESERVATION_TTL_MS` (10 min), `SIGN_MARGIN_MS` (2 min), `WALLET_SEARCH_SPACING_MS` (20
s), `WALLET_SEARCH_FRESH_MS` (60 s), `ACTIVATE_RECHECK_MS` (5 s).
`STORAGE_KEYS` includes `SELF_TEST`, `APPROVAL_COOLDOWN`; `LIMITS` includes `APPROVAL_COOLDOWN_REJECTIONS`,
`APPROVAL_COOLDOWN_ORIGINS_MAX`, `APPROVAL_BUDGET_SHORT`, `APPROVAL_BUDGET_LONG`, `BURN_SCAN_PAGE_SIZE`,
`BURN_SCAN_MAX_PAGES`, `BURN_SCAN_MAX_UNCHECKED`, `BURN_SCAN_DEADLINE_MS`; `TIMINGS` includes `APPROVAL_COOLDOWN_MS`,
`APPROVAL_COOLDOWN_LONG_MS`, `APPROVAL_COOLDOWN_WINDOW_MS`, `APPROVAL_BUDGET_SHORT_MS`, `CONFIRM_ARM_VALUE_MS`,
`RESTORE_TOKEN_TTL_MS`, `RESTORE_KEEPALIVE_MS`, `CLIPBOARD_CLEAR_MS`, `PHRASE_CLIPBOARD_CLEAR_MS` (section 8),
`POPUP_REFRESH_MS` (section 9, Pages).

**errors.js**: `ERROR_MESSAGES`, `PROVIDER_ERROR_CODES`, `class WalletError(code, {retryAfterMs?, field?})`,
`class ProviderError(code)`, `toUiError(error) → {code, message, …}`, `toProviderError(error) → {code,
message}` (`APPROVAL_COOLDOWN` → `{code: 4001, message: ERROR_MESSAGES.APPROVAL_COOLDOWN}`; `UNSUPPORTED_PARAM` of a
`UNSUPPORTED_CALL_FIELDS` field → `{code: -32602, message: UNSUPPORTED_PARAM_MESSAGE, data: {reason: 'UNSUPPORTED_PARAM'}}`). Codes added
with the restore and the cooldown: `RESTORE_EXPIRED`, `APPROVAL_COOLDOWN`; with the resumable burn search: `HISTORY_TOO_LONG`; with the burns no code derives from: `BURN_UNUSABLE` (R4-ESA-01); with the
sites' token transfers and contract calls: `UNSUPPORTED_PARAM`, `INVALID_METHOD`, `INVALID_ARGS`, `INVALID_GAS_LIMIT`
(the last three are the shared builders' codes, `UNSUPPORTED_CALL_FIELDS` the fields of the first); with the light
node (section 4.10): `NO_NODE`, `CLAIM_REFUSED`, `CLAIM_BUSY`; with aiqnet.io's record (decision 35): `ACTIVATION_RECORDED`,
`ACTIVATION_RESERVED`, `RECORD_UNAVAILABLE`. Every other code the
builders throw (`INVALID_NONCE`, `INVALID_GAS_PRICE`, `REQUEST_TOO_LARGE`, ...) cannot come from what the wallet passes
them and reads as `INTERNAL`.

**amount.js**: `U64_MAX`, `DECIMALS`, `parseUnits(text, decimals) → bigint` (INVALID_AMOUNT),
`isPositiveAmount(text, decimals) → boolean`, `formatUnits(bigint|digits, decimals) → string`.

**log.js**: `log.{debug, info, warn, error}(tag, ...codes)`; pass codes and short tags only.

**events.js**: `setViewBroadcaster(fn)` (sw.js only), `notifyViews(event)` (never throws).

**router.js**: `createRouter({runtime?, handlers?, requireUnlocked?, touch?, providerRequest?,
providerPortClosed?, tabs?}) → {handleUiMessage, handleProviderConnect, emitProviderEvent(origin, event,
data) → number (the ports reached; the origin's other tabs get it through `tabs`, section 4.2), broadcastToViews(event, data?),
install(), openPorts()}`; tables `UI_MESSAGES`,
`PROVIDER_METHODS` (an entry may carry `origins(origin) → boolean`, checked before the params: 4100),
`SECRET_RESULT_KEYS`, `RESULT_KEY_EXCEPTIONS`, `PROVIDER_RESULT_KEY_EXCEPTIONS`, `CALL_ARGS_MAX_BYTES`; an entry's params
may be a normalizer (`normalizeTransaction(raw)` for `qnet_sendTransaction`, section 4.9); helpers `validateParams`,
`isSafeResult`, `isU64String`, `isCanonicalOrigin`, `isActivationOrigin(origin, dev = DEV_BUILD)`,
`uiPageOf`, `relayMatchPatterns`, `originMatchesPattern`, `providerOriginOf`.

**vault.js** (area A): `KDF_DEFAULT`, `KDF_FLOOR`, `PLAINTEXT_VERSION`, `VAULT_DB`, `emptyState()`,
`canonicalJson(value)`, `normalizePassword(pw, {isNew})`, `assertKdfFloor(kdf)`,
`encodePlaintext(entropy, state) → Uint8Array`, `decodePlaintext(bytes) → {entropy, state}`,
`deriveVaultKey(normalizedPw, kdf) → Promise<Uint8Array(32)>`, `vaultExists()`, handlers `getStatus()`,
`unlock(p)`, `changePassword(p)`, `reveal(p)`, `wipe(p)`, `beginRestore(p, meta) → {token, expiresAt}`,
`restoreVault(p, meta)`, `createVault(p)`, `importVault(p)`, `migrateEarlier(p)` (`vault.migrate`), `removeEarlier()`
(`vault.removeEarlier`); internal API `verifyPassword(pw)`, `readEntropy() →
Uint8Array`, `readState() → VaultState`, `updateState(mutator) → VaultState`, `writeNewVault(entropy, pw)`,
`withRecipient(state, address) → VaultState`,
`RECIPIENTS_MAX`, `readLightAnchors() / writeLightAnchors(anchors)`, `readChainCache() / updateChainCache(mutator)`
(decision 40; never lock the session) and `readBurnScan(owner) / writeBurnScan(owner, scan)` (MAC under the vault key;
need the session), `PENDING_OUTCOMES`, `PENDING_KINDS`, `readSiteBinding() → {walletId, sitesKey}|null`, `rotateSitesKey() → {walletId, sitesKey}|null` (works
while locked), `deleteVaultDatabase()`.

**earlier.js** (area A, M-4): `EARLIER_KEYS`, `EARLIER_DB`, `parseEarlierWallet(stored) → {encrypted, salt, iv,
iterations}|null` (the record), `parseEarlierCopy(stored)` (the pages' copy, same shape), `readEarlierWallet() →
{record, copy}|null`, `hasEarlierData()`, `deleteEarlierDatabase()`, `removeEarlierData()` (the keys and the database;
checks that nothing is left), `openEarlierWallet(parsed, password) → Uint8Array|null` (the record first, then the copy:
the first valid phrase's entropy; null for a wrong password; `VAULT_CORRUPT` when it opens a copy with no valid phrase).
Only vault.js calls it.

**session.js** (area A): `initSession()`, `startSession({vaultKey, walletId, qnetAddress, solanaAddress,
autoLockMinutes}) → {lockDeadline}`, `requireUnlocked() → {walletId, qnetAddress, solanaAddress,
lockDeadline}`, `isUnlocked()`, `withVaultKey(fn)` (vault.js only), `replaceVaultKey(key)`, `touch()`,
`lock(reason)`, `onLockChange(listener) → unsubscribe` (implemented), handlers `lockNow()`,
`getAddresses()`, `getSettings()`, `setSettings(patch)`, `cachedViews()` (`wallet.cached`), the view cache's
`rememberView(name, value)` (the router, decision 39; nothing while locked; a verified QNet balance, the token list and
the Solana balances also into the vault's chain cache, decision 40) and `forgetViews(names)` (qnet.js, a chain the wallet
no longer follows), listeners `onAlarm(alarm)`, `onIdleState(state)`,
backoff `checkBackoff()`, `recordPasswordFailure()`, `recordPasswordSuccess()`, `getBackoffUntil()`,
pure `backoffDelayMs(failures)`, `isAutoLockChoice(minutes)`.

**keys.js** (area A): `startKeys() → Promise<boolean>` (worker start: a cached self-test pass for this
bundle, else `core.selfTest()` and cache the pass; section 6), `initKeys() → boolean` (synchronous gate:
runs `core.selfTest()` if nothing decided yet; failure disables signing), `signingEnabled()`,
`deriveAddresses(entropy) → {qnetAddress, solanaAddress}`, handler `exportPrivateKey({password, network}) →
{network, address, privateKey}` (`vault.exportKey`, decision 40),
`signQnetTransfer(fields) → {preimage, signature, publicKey}`, `signQnetTokenTransfer({from, token, to, amount, nonce})`
and `signQnetContractCall({from, contract, method, args, nonce, gasLimit})` → `{tx, preimage, signature, publicKey}`
(`core.signTokenTransfer` / `core.signContractCall`), `signOffchain(origin, message) →
{signature, publicKey, address}`, `signSolanaMessage(messageBytes) → {signature, publicKey}`,
`getQnetPublicKey() → Uint8Array(1952)`; the light node (section 4.10): `signNodeRegistration({nodeId, wallet, burnTx, burner,
timestamp}) → {proof, consentSignature, ownerSignature, publicKey}` (`burnTx` and `burner` must be those of the vault's
light activation, burned from the wallet's Solana address, whose key signs the owner bind), `signNodeClaim({nodeId,
wallet}) → {signature, publicKey}`, `signClaimPayload({wallet, timestamp, claimsData}) → {signature, publicKey}`,
`signNodeStatus({nodeId, wallet, timestamp}) → {signature, publicKey}` (the signed status request of the wallet's own
light node), `signNodeUnbind({nodeId, wallet, seq, timestamp}) → {signature, publicKey}` (the wallet key's unbind of its own
node's device binding `seq`, decision 38: `core.signNodeUnbind` over `q1337|light_unbind_wallet:{N}:{seq}:{timestamp}`); decision 35: pure `burnRecordMessage({wallet, nodeType, burner, burnTx, burnAmount})` and `signBurnRecord(same) →
{pk, sig, solanaSig}` (the burn record's proof: ML-DSA-65 by the wallet key with the context `QNET_OFFCHAIN_MSG_v1` and Ed25519
by the burner key, both over `core.buildSiteRecord(RECORD_ORIGIN, burnRecordMessage(...))`, decision 36; base64url without
padding, base64url, base58; the wallet and burner must be the session's, the node type known, the signature well formed, the
amount whole); decision 36: pure `reservationMessage({wallet, nodeType, way, burner, time})` and `signReservation(same) →
{pk, sig, time}` (the wallet's request of aiqnet.io's reservation: ML-DSA-65 by the wallet key with the context
`QNET_OFFCHAIN_MSG_v1` over `core.buildSiteRecord(RECORD_ORIGIN, reservationMessage(...))`, `core.signSiteRecord`; base64url
without padding, the time in Unix seconds as given; the wallet and burner must be the session's, the way `'extension'`, the
node type known, the time a safe integer above zero). All signers re-check the session, derive, sign (the core
self-verifies) and zeroize.

**qnet.js** (area B): `nodeRequest(path, {method?, body?, headers?, timeoutMs?, nodes?, maxBytes?}) → {status, text, node}`
(pinned HTTPS nodes only, hedged like mobile `_hedged`; u64 fields read from the raw text; a 429 or 503 that asks for a
wait, by `Retry-After` or the typed body's `retry_after_seconds`, puts that node last in proof reads until then),
`siteRequest(method, path, body?)
→ {status, body}` (decision 35: `QNET.EXPLORER_API` under `RECORD_PATH` only, one host, no hedging, `credentials: 'omit'`,
JSON, `TIMINGS.RECORD_TIMEOUT_MS`; no answer is `RECORD_UNAVAILABLE`; the archive's `/api/address/` reads stay apart),
handlers `getBalance()`, `getHistory(p)`, `preview(p)`, `send(p)`; internal `resolveNonce(address) →
{nextNonce, pkBound, verified}` (the send rule's for the session's address, the certified nonce + 1 for another, never a
default; `pkBound` two pinned nodes' word),
`transferFeeNano()` (implemented), `prepareTransfer({to, amountNano}) → TransferPreview`,
`sendTransfer({to, amountNano, expectedFeeNano, expectedNonce?, replaceNonce?}) → {txHash, status, nonce, from}` (stores the
PendingTransfer before the first POST and its recipient in `VaultState.recipients`; reports submitted, never
confirmed; a refusal from the only node sent it keeps the transfer as `refused` and is `NODE_REJECTED`, "it may still
apply", and a transfer without `replaceNonce` takes the nonce of a refused one: R5-EXTQ-02),
`resubmitPending() → {resubmitted, confirmed, replaced, passed}` (a verdict needs the same row at
(from, nonce) from two pinned nodes, R3-EXTQ-04, and no node listing two transactions at that nonce, since the
history does not say which applied: R5-EXTQ-01), `recipientCheck(to, amountNano?) → RecipientCheck`
(ES-01), the sites' calls (section 4.9): `readContract(address) → {kind: 'token', standard, name, symbol,
decimals}|{kind: 'contract'}|{kind: 'none'}`, `assertPayableRecipient(to, from?)` (`RECIPIENT_IS_CONTRACT`,
`RECIPIENT_UNCHECKED`), `readTokenBalance(token, holder) → string|null` (u128 base units, certified, decision 44),
`prepareCall(request) → CallPreview`, `sendCall({request, expectedFeeNano, expectedDepositNano, expectedNonce?,
oneInFlight?}) → {txHash, status, nonce, from}` (shares `storeAndSubmit` with `sendTransfer`, whose `oneInFlight` is the
same rule), `transactionStatus({from, nonce}) → {status, from, nonce, txHash, blockHeight}`; `transferBody` is
`core.transferRequestJson`; `readAccount(address, {display?}) → {balanceNano, nonce, verified, verification, blockHeight,
index}` (decision 44: the certified account proof; `display`: the popup's balance waits for the committee check at most
1.5 s once a figure is read, then shows it as not verified while the walk goes on), pure `certifiedIndexStands(index,
head)` (R2-EXTQ-01); the wallet's tokens and the popup's token send (decision 40): `listTokens() →
TokenList` (`qnet.tokens`), `tokenPreview(p)` (`qnet.tokenPreview`), `tokenSend(p)` (`qnet.tokenSend`, through
`sendCall`), `txLookup({hash})` (`qnet.txLookup`); `followChain() → 'same'|'changed'|'unknown'` (decision 40). Every body a node, the archive or the RPC answers is read through `core.readBoundedText`: the
stream is cut once more than its cap (1 MiB for nodes and the archive, the RPC's own cap) has arrived, whatever the
headers say, so a chunked or compressed answer is never held whole (R4-EXTQ-03). Proofs walk from the
nearest trusted root on the index's parity chain (the pin, or anchors kept with `vault.writeLightAnchors` and
imported once per worker; EXT-CHAINS-04), at most the light client's `WALK_STEPS_PER_CALL` (64) steps per call,
each verified step kept at once (`hooks.onProgress`), so a walk longer than one call goes on over the next reads
instead of never starting (R3-EXTQ-02). Balance and token proofs are the certified form and the send rule of decision
44; a proof answer is capped at 64 KB.
Mobile references: `WalletManager.getQNCBalanceWithProof`, `getTokenBalanceWithProof`, `certifiedQncForSend`,
`checkedTokenBalance`, `services/PendingTx.spendableFrom`, `resolveNonce`, `sendQNC`, `_hedged`;
history like `WalletScreen` (`EXPLORER_API/api/address/{a}/history`).

**solana.js** (area B): `rpc(method, params, {timeoutMs?})`, handlers `getBalances()`, `getHistory({cursor?, limit?})`
(`solana.history`, decision 39) with its pure row reader `historyItem(signature, tx, owner, ata, blockTime?)`, `quote(p)`,
`send(p)`, `maxAmount(p)` (`solana.max`), `transferStatus(p)` (`solana.status`); the send's message
`transferMessage({owner, to, mint?, amountRaw, decimals, createAccount?, references?, memo?, recentBlockhash})` (SOL: one
System Transfer; an SPL token: TransferChecked from the owner's associated account at the mint's on-chain decimals, after
CreateIdempotent of the recipient's when `createAccount`; a payment request's `references` as read-only, unsigned
accounts after the transfer's own, and its `memo` as one SPL Memo with no account right before the transfer, after the
create; fee payer and only signer the owner; its keys in the order the instructions name them, the app's layout, so one
send is the same bytes in both wallets; `TX_TOO_LARGE` beyond `SOLANA.TRANSACTION_MAX_BYTES` signed,
`assertTransactionSize(message)`) and `assertSendInstructions(instructions, {references?, memo?})` (exactly [Transfer],
[TransferChecked] or [CreateIdempotent, TransferChecked], the transfer carrying exactly the request's references and a
request's memo right before it: a send never carries a burn, an approval, a memo it was not asked for or any other
instruction); builders `compileLegacyMessage({feePayer, recentBlockhash, instructions, order?})` (`order` 'client', the
default and the burn's: within a class the reference client's key order; 'listed', a send's: the order the instructions
name the keys), `serializeTransaction(message, signatures)`, `systemTransferInstruction`, `transferCheckedInstruction`
(both with `references?`), `createAtaIdempotentInstruction`, `burnInstruction` (SPL Burn, instruction 8, not
BurnChecked), `memoInstruction` (the burn's, its signer listed), `requestMemoInstruction(text)` (a payment request's, no
account), `buildBurnTransaction({nodeType, amountWhole, recentBlockhash}) → {transaction,
signature}`; `isOwnBurn(tx, owner, mint?) → boolean` (the wallet signed and paid for a successful Token-program burn of
the 1DEV mint with itself as authority, whatever the memo and the source account: the one-activation guard's test, as
the node reads neither; `validateBurnTx` stays the strict test a code needs, R4-ESA-01), `findSignedBurns(owner,
options)` (`findWalletBurns` over the owner's own address instead of its 1DEV account: every burn with the owner as
authority is a transaction it signed, so it lists there from whichever token account it burned, a closed one
included; kept and resumed under the vault kind `'signed'` within the same budget; no token account list and no count
cap, since anyone can create token accounts naming the owner or mention its address: R5-ESA-01, XP-R5-02);
`simulate(tx)` (sigVerify true), `sendAndConfirm(tx, {commitment?, timeoutMs?})` and
`signatureStatus(sig)` (an error counts as a failure only at confirmed or finalized; one at 'processed' may come
from a fork that is dropped, so it is polled on and reads `'processed'`: XP-R3-04, as mobile `failedForGood`),
`blockHeight(commitment)`; matcher `validateBurnTx(tx, expected)`,
`findWalletBurns(owner, {rpc?, now?, spacingMs?, store?, confirmed?, maxPages?, deadlineMs?, maxUnchecked?,
inFlightMaxPages?, inFlightDeadlineMs?, pageSize?}) → {burns, canonical, complete, listingComplete, exhausted,
reachedStart, oldestUnchecked, inFlight, unusable}` (`unusable`: the owner's own burns among the candidates that yield
no code, `isOwnBurn`, finalized or in flight, kept with the search: R4-ESA-01; candidates are fetched two at a time,
R4-ESA-03) (port of mobile `BurnMatcher`, R2-ESA-02, R3-ESA-01..03: lists the owner's 1DEV account at
'finalized', within `LIMITS.BURN_SCAN_DEADLINE_MS` and `BURN_SCAN_MAX_PAGES`, keeping at most
`BURN_SCAN_MAX_UNCHECKED` candidates waiting: the listing pauses mid-page at the candidate that does not fit, so a
kept search is never longer and never refused as such; with a `store` it resumes where the last call stopped, the
range above the kept head included (its top, cursor and candidates are kept; the head moves to its top once it
reached the old head); canonical = OLDEST valid burn once the listing reached the start and nothing older is
unchecked, never a burn inside an open range; `listingComplete`: the whole history, the range above the head
included, was listed; inside one slot the later listed is the older, whether the search was fresh or resumed;
`exhausted`: the budget ended it first (`HISTORY_TOO_LONG` for the caller); `inFlight` with `confirmed`: the
listing at 'confirmed' paged newest first down to the kept head (or the open range's top), every valid burn there
that the finalized snapshot has not found, confirmed or finalized after the snapshot (at most 20 pages and 30 s:
past them a complete search fails closed with `SOLANA_UNAVAILABLE` / `HISTORY_TOO_LONG`, an incomplete one answers
what it read, since every caller refuses a burn on it anyway: XP-R3-01); a history that cannot be read is an error,
never "no burn").

**activation.js** (area B): pure `maskCode(code)`, `publicActivation(activation)` (implemented), `parseRecord(body, wallet)`
(aiqnet.io's answer checked key by key);
handlers `getStatus()`, `getPrice()`, `burn(p)`, `recover()`, `copyCode()`, `lookup()` (`activation.lookup`, decision 35); for the
provider `siteActivation()` (`qnet_getActivation`); `syncRecord()` (sw.js after every unlock, and after a settle, a stored
search, Recover and a read that sees the vault's own burn: reads aiqnet.io's record and, unless it holds this burn or a payment
burn (recorded for good, decision 36), posts this burn with a fresh proof; a record of another burn it keeps is the wallet's code from
then on; once per burn, again a minute after one that could not finish; never throws); `resumeBurnSearches()` (sw.js, after
every unlock: a kept search a budget cut short goes on for at most 30 s per owner, only while the vault has neither
an activation nor a pending burn; a burn, Recover or site request meanwhile waits for it and goes on from where it
got: R4-ESA-03). Burn order (no password: decision 33):
single-flight (a running shared search or resumed search is waited for) → vault has activation or pending burn → the kept
burn search of the wallet's Solana address, with the confirmed page (`BURN_EXISTS` → Recover; EXT-CHAINS-03; `HISTORY_TOO_LONG` while a long history is still being read) → a burn of the same owner no code derives
from, in its search or from another of its token accounts (`findSignedBurns`; `BURN_UNUSABLE`: the node counts it for
an activation, so no second burn; Recover answers `BURN_UNUSABLE` rather than "no burn" when that is all it found;
R4-ESA-01, R5-ESA-01; the valid burns are looked at before a search that is incomplete refuses) →
the QNet network vouches that the wallet has no node (`refuseExistingNodes`, fail closed, EXT-R1-01: the searches of the
phrase's addresses are no complete evidence, since a light burn aiqnet.io's one-time payment key made for the wallet
leaves no trace there): `GET /api/v1/verify-activation` with header `x-qnet-wallet` for the wallet's QNet address, two
pinned nodes first and then one more at a time (`verified: true` → `NODE_EXISTS`; one
authoritative "no" goes on; a non-authoritative "no" is no proof, and no authoritative answer from any node is
`NETWORK`), then `nodes.lightNodeKnown(lightNodeId(W))`: every pinned node's public status at once, any one listing
the light node or holding its registration (`onchain_registered`, `registration_pending`) → `NODE_EXISTS`, fewer than
two answers → `NETWORK` (aiqnet.io's record is asked first, decision 35: `ACTIVATION_RECORDED`, `ACTIVATION_RESERVED`,
`RECORD_UNAVAILABLE`) → re-fetch price (phase 1,
integer, equal to `expectedPrice`) → 1DEV >= price → aiqnet.io's reservation → SOL >= `FEE_BUFFER_LAMPORTS` + fee → build, sign
(only with `SIGN_MARGIN_MS` of the reservation left), simulate, the announce with the burn record's proof (nothing is sent
without its 200; a failure before the send releases the reservation), the pending record with the blockhash's
`lastValidBlockHeight`, send, wait finalized (timeout →
`pendingBurn`) → `core.generateActivationCode` of the wallet's OLDEST finalized burn (normally this one;
another device of the phrase may have burned first; only candidates at or before its own slot can change that,
so a settle never waits for newer history: R2-ESA-01, but it waits while the range above the kept head is not
listed to its end, where an older burn may still lie: R3-ESA-02) → store the one record. A pending burn is cleared only
once the finalized block height passed its `lastValidBlockHeight` and the ledger still has no trace of it
(a record without the height: one hour). The burn amount never comes from a message.
For `qnet_activateNode`: `siteView(nodeType, {cost?, nodeChecked?}) → SiteView` (what the approval
shows: exists, pending, unavailable with a reason, or a burn at a price; never burns, and a pending
burn is checked as `getStatus` does) and
`activateForSite({nodeType, expectedPrice: number|null}) → {status: 'ok'|'exists', activation, superseded?} |
{status: 'pending', pending}` on the same path and single-flight lock
as `burn`, with no password (the unlocked session and the approval window's confirm authorize it, decision
32; `burn` takes none either, decision 33): what exists is answered instead of refused (the vault's record; a pending burn checked once; the
canonical burn of the scan, stored when finalized; a valid burn only confirmed yet, another device's, answered
`pending` and, from the wallet's own address, kept as the vault's `pendingBurn` with `lastValidBlockHeight:
null`, so `activation.status` settles it once final: XP-R2-05), `expectedPrice: null` never burns
(`PRICE_CHANGED`), and once the burn is sent the answer is `ok` or `pending` (`TX_FAILED` stays an error), or
`exists` with the older activation when another device's burn of the phrase beat this one, whatever its node type,
with this burn as `superseded` (kept as `VaultState.supersededBurn`, named in the approval window and on the Activate
tab; the site's answer carries only what QNet Link v1 section 7 defines: XP-R5-03). The canonical and in-flight burns
are answered before an incomplete search refuses (R5-ESA-01). Both share `burnNow`
with `burn`. `siteView` runs the same `refuseExistingNodes` before it offers a burn (`unavailable` with `NODE_EXISTS`
or `NETWORK`; `nodeChecked` only once the network vouched, and the next read asks again otherwise). A `NETWORK` refusal
reaches a site as `INTERNAL` (QNet Link v1 section 7 has no code for it); the extension's own windows name it.

activation.js also writes the light activation's registration record in the vault update that stores it
(`nodes.registrationFor`), answers it in `getStatus` and `siteView` (`registration`), queues it again for a confirmed
`activateForSite` of an existing light activation (a record on chain is read again then: `{recheck: true}`), and starts
it through `setRegistrationHook(fn)` (sw.js: `nodes.resumeRegistration(options)`; without a hook a queued registration
waits for the next resume). Recover stores the burn
`nodes.registeredBurn` names when the phrase's addresses show none (section 4.10); `publicActivation` marks a burn
aiqnet.io paid (`paidOnSite`), which `activateForSite` answers `NODE_EXISTS` and `siteView` shows `unavailable`.

**nodes.js** (area B, section 4.10): pure `registrationFor(current, activation, wallet, now?, {retry?})`,
`publicRegistration(record, now?) → RegistrationView|null`; `onChain(nodeId) → boolean|null` (two pinned nodes alike);
`lightNodeKnown(nodeId) → boolean|null` (the check before a burn: any pinned node listing the node or holding its
registration → true, at least two answering and none → false); `registeredBurn() →
string|null` (the burn the registration record names, two pinned nodes alike; throws `LOCKED`, `SIGNING_DISABLED`);
`resumeRegistration({recheck?})` (never throws), handlers `requestRecord()` (`activation.register`), `getRegistration()` (`activation.registration`); listener
`onAlarm(alarm)`; for the provider `claimView() → {mode, reason, nodeId, amountNano}` and `claimForSite() →
{status: 'ok', qnet, nodeId, amountNano, txHash, stoppedAtEpoch}|{status: 'empty', qnet, nodeId}` (throws `NO_NODE`,
`NETWORK`, `CLAIM_REFUSED`, `CLAIM_BUSY`, `LOCKED`, `SIGNING_DISABLED`); for the provider and the popup (decision 38)
`unlinkView() → UnlinkView` (`node.unlinkView`; throws `LOCKED`) and `unlinkForSite() → {status: 'ok', qnet, nodeId,
unbound: true}` (`node.unlink`; throws `NOT_LINKED`, `NETWORK`, `UNLINK_REFUSED`, `LOCKED`, `SIGNING_DISABLED`).

**provider.js** (area C): `setEventSink(emit)`, `eventSink()` (both implemented), `handleRequest(ctx,
method, params)`, `onPortClosed(ctx)`, `onWindowRemoved(windowId)`, `notifyLockChanged(change)`, handlers
`listSites()`, `revokeSite(p)`, `getApproval(p, meta)`, `resolveApproval(p, meta)`, internal
`readSites()`, `displayOrigin(origin) → {text, idn}`, `SITE_ERROR_CODES`, `CLAIM_ERROR_CODES`, `UNLINK_ERROR_CODES`; `qnet_getActivation` (decision 35)
is served in `createProviderService` from `activation.siteActivation`, with its per-origin read count. The approval cooldown
(section 4.8) lives in `createProviderService` (its `now` option drives it in tests; `activation` and `nodes` are among
its injected collaborators).

**ui/common.js** (area D): implemented `UiError`, `refuseFramed()`, `el(tag, props, ...children)`,
`clear(node)`, `hardenSecretInput(input)`, `wipeInputs(root)`, `shortAddress(address, keep)`,
`call(type, params)`, `onWalletEvent(handler)`, re-exports `DECIMALS, formatUnits, parseUnits, log`;
area D: `loadLocale(language)` (the table of `ui/i18n`, `<html lang dir>`), `currentLanguage()`,
`t(key, subs)` (bidi-isolates substitutions in right-to-left languages), `copyText(text, {clearAfterMs, untilFocused})`
(with `clearAfterMs` the page empties the clipboard after that delay if nothing was copied from it since and it has
the focus; with `untilFocused` too, a page without the focus then does it when it gets the focus back),
`clearCopiedNow()` (empties such a copy at once), `holdToReveal(control, target, secret, {autoHideMs, onExpire,
placeholder})` (no page uses it since decision 43), `openSetup()`, `clearPageStorage()` (decision 43: every page at start).
`ui/kit.js` adds `earlierRemoval({onRemoved})`: what an earlier version left, with Remove behind one confirmation
(setup's last screen and Settings).

**Pages** (area D): `popup.js`, `setup.js`, `approve.js` start with `refuseFramed()` (checked). The popup
tabs are Assets · Send · Receive · History · Activate · Settings with a QNet / Solana switch; no Node
tab. Once the wallet has its code (the vault's, or aiqnet.io's record's), the Activate tab shows only this (decisions 41
and 43; the code itself is in Settings, one plain row: masked, Show and Copy, no warning, no timer): for a light
activation of the vault, its record on the QNet network while the chain does not list the node: its node id, one line (read again every
`TIMINGS.REGISTRATION_POLL_MS` while it is being recorded) and, when the record waits for the user (none, refused, the
clock, past the attempt cap), Record on the network with one press (`activation.register`, no password: decision 33); the
card goes once the chain lists the node (`onchain`) and stays, with its line, in every other state (`other_burn` and the
one-node rule's refusal included); one line, "Manage the node at aiqnet.io/node", the tab's only link (`RECORD_ORIGIN/node`,
a new tab, `rel="noopener noreferrer"`); and a warning only when another burn is involved (this device's burn another
device's older burn beat, XP-R5-03; the vault's burn aiqnet.io's record of another burn beat), each with its Open in
Solana Explorer button. It shows no burn details (node type, amount, burn transaction, network, date) or their buttons, no
success banner, no paid-on-site line, no next step, no server settings and no Device card: aiqnet.io/node shows the node,
its device and its balance, and the device is unlinked on its Device tab, which asks this wallet through
`qnet_unlinkNodeDevice` (decision 38); the popup sends neither `node.unlinkView` nor `node.unlink`. Its lock screen offers "Forgot password?" (section 5, Restore): Reset wallet with one
warning, the phrase and a new password (checked in the page), `vault.restoreBegin` and a checking `vault.restore`, one
confirmation naming the wallet that is replaced with one checkbox (no typed word), the confirmed `vault.restore`, and the
resulting addresses with a pointer to Recover. Setup generates entropy in the page with
`core.generateEntropy(12)`, shows the words for writing down with the Copy button and its warning (section 8; no
download), verifies typed words, sends the phrase once, then drops every reference; its success screen stays until the
user presses Done, which closes the tab (no timer: owner, 28.09). Every seed, word, password and code input goes through
`hardenSecretInput`. The receive QR is drawn locally (no remote QR service); Receive says in one line what the address
takes (QNC and QNet tokens; SOL and Solana tokens), with no warning box. Every screen that shows this wallet's own QNet or
Solana address (the Assets card, Receive, a review's From, the setup and restore results) shows it whole,
on one line and never cut, and the address is itself the copy control (`kit.addressCopy`: a button, "Click to
copy" on hover, "Copied" after; the Assets card has no separate Copy button). Every other whole address (a review's To,
the 1DEV mint, the reset confirmation, the approval window's blocks) stays on one line too: in a list (`kit.kvList`) it
takes the row below its label, and its box is a size container whose address type is `clamp(10.5px, 100cqi / 27.2,
13px)`, the size at which 45 characters of the widest monospace advance (0.602 em) fill it (310 px boxes in the popup:
11.4 px, 10.8 px beside a 17 px scrollbar; a setup tab narrower than about 400 px wraps it). A size container gives its column
no width of its own, so the setup tab's column takes the tab's width up to 640 px. History lists the network the switch shows, apart like the balances (decision 39): QNet `qnet.history`, Solana
`solana.history` (pages of 10, More with the cursor); a row is the asset's icon (QNC, SOL, 1DEV), one line of what happened
and the amount that never wraps (scaled down as one, to half at most, when long), the badge and the date, and the other side;
every row opens its detail in place of the list (decision 40), with the explorer link there when it has a hash (no View
button). History shows "No transactions yet" when empty and one badge per row (section 2.5). What this
session read last (`wallet.cached` when the wallet opens, then every read) is drawn at once and read again behind it, and
after an open or an unlock the balances and first history pages the view on screen does not read itself are read in the
background, so a switch of network shows its numbers at once (decision 39), once the screen's own read is done; what is
drawn from the cache carries a quiet "Updating…" until that read ends (decision 40). No field takes the cursor on its own
(decision 40: `common.refuseAutoFocus`, no `focus()` in any page). The popup has no Refresh button: the view on screen gives its silent read
(`keepFresh`: the Assets token card, the send form's "Available", the QNet History rows listed so far in one
`qnet.history` request of that many rows), which runs when the view opens, every `TIMINGS.POPUP_REFRESH_MS` (15 s) while
the popup is visible (none while `document.hidden`, one read when it shows again), on the worker's `balance` event, and
on a change of network or wallet (the view opens again); one read at a time (a tick while one runs is skipped, an event
reads once more after it), a read that fails keeps what is shown, and only what changed is drawn again. History paged
past `LIMITS.HISTORY_PAGE_MAX` rows is not read again until the tab opens again. The Activate tab draws the view of
`activation.lookup` (decision 35): the checking line and no price card until every source answered, the Light and Super cards
(with Recover) only for `none`, a burn on its way or an activation starting elsewhere read again
every `TIMINGS.ACTIVATE_RECHECK_MS` while the popup is visible (no Check again button), a node (its warning and Recover), a
burn no code derives from, the source that could not answer with Retry, and a code (the vault's, or aiqnet.io's record's) as
above, one way or the other alike; the lead that invites a burn only while the wallet has no code. A burn in progress shows
its title, a progress bar and the time, no list of the steps inside, and its code screen has no Done button (EXT-F5): it is
the overview's, titled "Your activation code" (the warning of a burn another device beat above the code, the light node's
record, read at once and then once per poll, and the line). The popup's burn waits for its one acknowledgement, the activation code comes with one press (Show or
copy the code), and Record on the network with one; none asks for the password (decision 33). The Solana send: the token
(SOL or a listed SPL token, 1DEV), the recipient (a Solana address, or a payment request `solana:<address>?<parts>` pasted
or typed in: `kit.parseSolanaRecipient` reads it with the app's grammar, limits and decoding (decision 34): `amount`,
`spl-token` and `memo` once each, up to four distinct `reference` addresses, `label` and `message`, form-encoded, any
other part ignored; it fills the recipient, switches to its token when the wallet lists that mint, fills the amount, shows
the label, message and memo as plain text, never a link, and names how many references it carries, and the send carries
its references and memo while the recipient is its address; a malformed part, a once-only part given twice, a fifth or
repeated reference, an unlisted mint or an amount beyond the token's decimals fills nothing), the amount with Max
(`solana.max`) and "Available"; the review names from, to, the token and its mint, amount, network fee, the rent of a
recipient token account the send creates, the SOL spent in all, the cluster, the request's label and message, the memo the
transaction carries and how many references (`SolanaQuote.memo`, `references`), the recipient warnings and any `shortfall` in words with its numbers (Send stays
off); Send arms `TIMINGS.CONFIRM_ARM_VALUE_MS` after the review is drawn and asks no password; a changed fee or
`BLOCKHASH_EXPIRED` quotes again; after it, the transaction is pending (a spinner) until `solana.status` answers
confirmed (finalized reads so), failed or expired (Send again), read every 2 s while shown, and the balance of the token
sent is read again then. The QNet send takes QNet addresses only. Both recipient fields show a whole address in the
input. Auto-lock offers 5, 15, 30, 60 minutes and Never (section 6). The activation
code only by explicit button with a
warning and a clear after `TIMINGS.CLIPBOARD_CLEAR_MS`; the phrase only by its Copy button, with its warning and a clear
after `TIMINGS.PHRASE_CLIPBOARD_CLEAR_MS` (section 8).

## 10. Who may call what

- Pages → worker only through `common.call`; pages never import a background module other than
  `config.js`, `amount.js`, `log.js` (through common.js) and never hold a key. Pages may import
  `../lib/qnet-core.js` for pure checks and for setup's phrase generation (`generateEntropy`,
  `entropyToMnemonic`, `validateMnemonic`, `isValidQnetAddress`, `isValidSolanaAddress`); the worker
  validates everything again.
- `router` → handlers in the table; `provider.handleRequest`, `onPortClosed`; `session.rememberView` (the view cache,
  decision 39).
- `vault` → `session` (start, key, backoff), `keys.deriveAddresses`, `earlier` (the earlier version's record and pages' copy), core. `session` → `vault.updateState`
  / `readState` for settings, `vault.readChainCache` / `updateChainCache` for the balances kept across sessions.
- `router` → `keys.exportPrivateKey` (`vault.exportKey`).
- `keys` → `session.requireUnlocked`, `vault.readEntropy`, `vault.readState` (the light activation a registration
  signs for), core. Nothing else derives keys.
- `qnet` → `session` (and its `forgetViews`, decision 40), `vault.readState`/`updateState`/`withRecipient` (pending
  transfers, recipients), `vault.readLightAnchors`/`writeLightAnchors`, `vault.readChainCache`/`updateChainCache`, `keys.signQnetTransfer`, `keys.signQnetTokenTransfer`,
  `keys.signQnetContractCall`, `keys.getQnetPublicKey`, core light client and transaction builders.
- `solana` → `session` (and its `cachedViews`, decision 39), `keys.signSolanaMessage`, core.
- `activation` → `session`, `vault` (state), `solana`, `qnet.nodeRequest`, `qnet.siteRequest`, `keys.signingEnabled`,
  `keys.signBurnRecord`, `nodes.registrationFor` / `publicRegistration` (pure), core.
- `nodes` → `session`, `vault` (readState, updateState), `keys.signNodeRegistration`, `keys.signNodeClaim`,
  `keys.signClaimPayload`, `keys.signNodeStatus`, `keys.signNodeUnbind`, `keys.signingEnabled`, `qnet.nodeRequest` / `parseJsonLossless`,
  `chrome.alarms` (its own alarm), core. It never imports activation.js (activation.js starts it through
  `setRegistrationHook`, and Recover calls `nodes.registeredBurn`).
- `provider` → `session`, `vault.readSiteBinding`, `vault.rotateSitesKey`, `vault.vaultExists`, `keys.signOffchain`,
  `qnet.prepareTransfer`, `qnet.sendTransfer`, `qnet.recipientCheck`, `qnet.readContract`, `qnet.assertPayableRecipient`,
  `qnet.prepareCall`, `qnet.sendCall`, `qnet.transactionStatus`, `activation.siteView`,
  `activation.activateForSite`, `activation.siteActivation`, `nodes.claimView`, `nodes.claimForSite`, `nodes.getRegistration`,
  `nodes.unlinkView`, `nodes.unlinkForSite`,
  the event sink, `chrome.windows`.
- `router` → `chrome.tabs.query` / `sendMessage` for an event no port carried (section 4.2), given by sw.js.
- sw.js → `activation.setRegistrationHook(nodes.resumeRegistration)`, `nodes.resumeRegistration` and `activation.syncRecord`
  after every unlock, `nodes.onAlarm` from its one alarm listener, `createRouter({tabs: chrome.tabs})`.
- Network: only `qnet.nodeRequest` (QNET.NODES and EXPLORER_API), `qnet.siteRequest` (EXPLORER_API under `RECORD_PATH`) and
  `solana.rpc` (SOLANA.RPC_URLS);
  HTTPS only; no other host, no third-party QR, price or RPC service.

## 11. Tests each area adds (`test/<area>.test.mjs`, offline, `npm test`)

- A (round 2): strict durability of every write, an earlier record without the key `legacy` and any other value of it
  refused (`vault-session-vault`); restore only checks and names both wallets until it is confirmed, asks again before
  replacing another wallet without `replaceOther`, keeps the old vault through a failed write, replaces a malformed
  record (`vault-session-restore`); from the lock screen against the real worker, another wallet's phrase is named and
  Back keeps the old vault, and only the ticked checkbox replaces it (`integration`); the MAC'd burn searches.
- A: KDF floor refused; tampered AAD, ciphertext, IV or `record.kdf` → fail; wrong password →
  `BAD_PASSWORD` and backoff; create refuses an existing vault; whitespace/case import variants give the
  KAT addresses; one-activation invariant in `updateState`; lock clears memory and the mirror; the
  stored session restores only before its deadline; wipe leaves every storage empty; a V8 heap snapshot after lock
  holds no phrase, seed,
  entropy, password or vault key (`vault-session-heap`); the restore needs the popup's one-time token,
  leaves the old vault (and its password backoff) intact on an invalid phrase and replaces it on success
  without the old backoff, from the popup only (`vault-session-restore`); the self-test pass is cached per bundle and a failure never
  (`vault-session-selftest`); the WebAssembly Argon2id equals noble's (`vault-session-kdf`); the MAC'd light anchors and
  the recipients list (`vault-session-vault`). Use
  `test/helpers/chrome-mock.mjs` and the in-memory
  IndexedDB of `test/helpers/indexeddb-mock.mjs` (transactions inactive after an await, a failed request
  aborts its transaction, an aborted first upgrade leaves no database); WebCrypto is Node's.
- B: burn transaction bytes (instruction data, account order, memo signer); matcher on poisoned
  histories (foreign memo mentions, wrong mint, non-signer, fractional amounts, more than 1000
  signatures, several burns → oldest); price refusal (phase 2, non-integer, changed); fee/nonce change
  refusals; pending transfer resent byte for byte; `'confirmed'` burn scan, `lastValidBlockHeight` expiry and
  oldest-burn settle (`chains-activation-activation`); 1DEV only to a system-owned on-curve owner
  (`chains-activation-solana`); recipient check and anchors walk (`chains-activation-qnet`); fixtures in
  `test/fixtures/`.
- B, the Solana send (decisions 33, 34): its bytes for SOL and for TransferChecked with and without CreateIdempotent, and
  with a payment request's references and memo (SOL with references, 1DEV with references and a memo, a new recipient
  account with four references and a 200-byte memo, 753 bytes signed), against messages laid out by hand, the associated
  accounts derived with the test's own SHA-256, curve check and base58 (the recorded devnet burn's account among them),
  every key's signer and writable flag from the header, the signature checked with Node's own Ed25519; the same bytes as
  the app's `SolanaTx.transferMessage` (imported read-only from `applications/qnet-mobile/src`, 27 shapes) and its
  recorded vector; `assertSendInstructions` refusing a burn, an approval, a memo it was not asked for, a second or
  changed memo, a reference not the request's and every other list; `TX_TOO_LARGE`; the rent rules, Max,
  `BLOCKHASH_EXPIRED`, the single status read and `transferStatus` with its expiry (`chains-activation-solana`); the
  popup's burn, code and record without a password (`chains-activation-activation`, `nodes-registration`,
  `integration`, `router`).
- C: no grant → 4100; queue cap → 4001; revoke emits `accountsChanged {}` and `disconnect`; forged or
  foreign-wallet grant ignored; closed window → 4001; relay/provider behaviour with a DOM-less window
  mock (same-window/same-origin filter, duplicate id dropped, 4900 on disconnect); the approval cooldown,
  shared by every tab of the origin, a window closed after `CONFIRM_ARM_MS` counted (`provider-cooldown`); the
  recipient warning and verification row, confirm only by a pointer click (`provider-approve-page`); hidden
  characters and spaced prefixes in off-chain messages (`core`).
- C: `qnet_activateNode` (`provider-activate`): aiqnet.io only (4100 before params and before any window),
  no grant, NO_WALLET, the view and its fixed price, results of every status, failures as results, the
  result re-check, rejections toward the cooldown (the fifth bars), an unavailable view counts nothing, a confirm only
  from its own window for its own id and once, a password refused for every kind; the approval window's activation
  screens on the fake DOM with no password field, locked included (`provider-approve-page`).
- D: pure helpers (`t`, `holdToReveal` timing with fake timers, `copyText` clear, `untilFocused`, `clearCopiedNow`); no
  page test may need a real browser. Languages (`i18n`, section 13). The phrase's Copy button (section 8): an explicit
  click only, the warning, the clear after 60 s, on the next focus and at the end of setup (`ui-setup`), the reveal's
  button ending with the reveal and the clipboard emptied by a deletion (`ui-popup`). The payment-request parser: plain
  addresses, every part, form decoding, decimals, four and five references, 200- and 201-byte memos, unknown and repeated
  parts, junk, plain-text label and message, and the same answer as the app's `parseSolanaScan` (imported read-only)
  over a corpus (`ui-common`); the Solana send in the popup: review, arming, pending to confirmed, failed and expired,
  re-quotes, shortfalls, Max, pasted and refused requests, a request's memo and references named on the form and the
  review and quoted and sent as read, a quote that does not carry them refused, the QNet send's QNet-only field; the
  burn, code and record with no password field (`ui-popup`).
- Layout: `scripts/overflow-check.mjs` (`npm run check:overflow`, needs Chrome, outside `npm test`).
- Whole extension: `test/integration.test.mjs` runs sw.js with every real module and the real pages
  on the fake DOM against a scripted network that verifies each ML-DSA-65 and Ed25519 signature;
  `test/package.test.mjs` checks that `dist/` loads and that the store zip is exactly its shipped files, and that
  `scripts/package.mjs` refuses a light-client pin that is not the mobile source's (`genesisConsensus.js`, written only
  by `scripts/ws-pin.js`) or is older than `PIN_MAX_AGE_DAYS` (14; `scripts/extension.mjs checkLightClientPin`,
  R4-EXTQ-05): nodes strip the committee signatures of older macroblocks, and a walk from a stale pin never starts.
- Round 4: a refused replace keeps the transfer it was to replace (`chains-activation-qnet`); `isOwnBurn`, `unusable`,
  `BURN_UNUSABLE` and the
  resumed search (`chains-activation-solana`, `chains-activation-activation`, `ui-popup`); the shared `burnOrder`
  vectors through the real search, in one call and resumed (`chains-activation-solana`, XP-R4-05); bounded bodies
  (`core`); archive rows confirmed by two nodes (`chains-activation-qnet`, `ui-popup`, `integration`); placement over
  the normal windows and the random gap (`provider-cooldown`, `provider-approve-page`); aiqnet.io only and the default
  port (`router`, `static`, `skeleton`); the clipboard emptied before the reload a wipe causes (`ui-popup`); the
  clipboard wording (`ui-setup`).
- Developer platform (section 4.9): each `qnet_sendTransaction` type's strict shape, the legacy transfer, the gas bounds
  and `UNSUPPORTED_PARAM` with its data, `qnet_getTransactionStatus` params, the games host (`router`); the error data
  through the relay and the page script (`provider-scripts`), mirrored there (`skeleton`); token and contract checks
  before any window, the views, results, the in-flight wait, revoke, the status rules and budget (`provider-background`);
  the two approval bodies, their warnings and arming, the in-flight wait on the page (`provider-approve-page`); token and
  contract reads, the call preview, signed call bodies checked against the shared builders, refusals, the call route on
  resend and the call verdicts, the status answers (`chains-activation-qnet`); call records and their upgrade
  (`vault-session-vault`); calls in History and replace buttons (`ui-popup`); the token rules, with the look-alikes NFKD
  changes or keeps (the lunate sigma, small capitals, letterlike symbols, boxed letters) and accented letters, and the
  window's text rule (`core`); `supersededBurnTx` against the QNet Link v1 vectors and a burner other than the wallet's refused
  (`qnet-link-vectors`, `provider-activate`), a burn that settles as superseded while a site asks
  (`chains-activation-activation`).

- The light node (3.1.0, section 4.10): the registration machine against simulated nodes, every submit verified as the
  node verifies it (the fields in order, the id and proof, the consent under the wallet key with the empty context, the
  owner bind under the burner), the answers row by row, the hold, the cap, the
  lock, the lane, an earlier build's activation, the queueing by activation.js; the claim view and the quote checks
  (`nodes-registration`); `qnet_claimNodeBalance` through the router and the provider, its results against the shared
  vectors, its window on the fake DOM, and the activation window's record line and longer stay (`provider-node-claim`);
  the method and the two UI types (`router`); the record's shape and consistency (`vault-session-vault`); the status line
  and Record on the network (`ui-popup`); the burn recorded end to end (`integration`); the core's node signers against
  the shared vectors and the self-test's light node id (`light-node-vectors`). A burn aiqnet.io paid: Recover through
  the signed status (the request verified as the node verifies it), the wallet's code, the refusals of anything but a
  finalized light burn two nodes name alike, `NODE_EXISTS` to the site (`chains-activation-activation`); the vault's
  rule for it (`vault-session-vault`); `core.walletActivationCode` written out once more (`core`); the Activate tab
  (`ui-popup`).

- Decision 35 (one wallet, one code): aiqnet.io's record refusing a burn in every state, both node types, before anything is
  reserved or signed; a source that cannot answer (aiqnet.io down, busy or answering nonsense, Solana, the network) refusing
  it; two browsers of one wallet, one reservation and one burn; the order reserve → sign → simulate → announce → send, an
  announce refused or unanswered sending nothing and giving the reservation back, the sign margin; the announce's proof
  verified with the audited libraries over the contract's bytes; a reset and restore of the same phrase finding the old burn
  (the record, then the search); the sync of a vault activation, a payment record kept as the wallet's code, an older burn of the
  same address replacing a younger one; the window's `checking` view; every `qnet_getActivation` read; the Activate tab's views
  (`chains-activation-activation`, against `test/helpers/cabinet-server.mjs`); the proof signer (`vault-session-keys`);
  `qnet_getActivation` through the router and the provider: every status with no window, no budget and no grant, 4100 for other
  origins, `not_connected`, the result check, the read limit, and the site codes of the new refusals (`router`,
  `provider-activate`); the window's `checking`, the named refusals and the outcome title (`provider-approve-page`); the tab
  events and the relay's forwarding (`router`, `provider-scripts`); the Activate tab's views, its own re-read with no Check again
  button, no cards while checking, no Done after a burn (`ui-popup`); the record end to end (`integration`).
- Decision 36 (the wallet signs its reservation; a payment burn is permanent; one wallet, one node): the reserve body with its
  proof exactly, verified independently over the contract's bytes, one proof for one request (another node type, way, burner,
  wallet or time is none), aiqnet.io's refusals of an unsigned, forged, other-wallet or stale request (`invalid_proof`,
  `stale_proof`, a 400 read as `INTERNAL`), nothing asked while locked, the signatures counted apart (a reservation's request
  is signed before a burn is; nothing but it when aiqnet.io refuses the reservation), a payment burn on its way or recorded
  refusing a burn, `parseRecord` refusing `burned` (`chains-activation-activation`, with `test/helpers/cabinet-server.mjs`
  checking the request as the site does); `signReservation`'s bytes and checks (`vault-session-keys`); the new prefixes, the
  site-record signer and its refusals of any other text (`core`); `wallet_has_node` refused for good and never retried, by its
  code and by its text, and `bind_v2_pending` a retry by its code and by its text (`nodes-registration`); the popup's `wallet_has_node` line without Record on the network and the
  Super code's copy warnings (`ui-popup`; its server-steps link and the paid-on-site line went with decision 41); the approval window's Super line
  and, before a burn, where the node runs, a Light node in QNet Wallet on a phone or tablet, a Super node on a server, and
  after the answer a record the one-node rule refused said as that refusal although the answer's registration names no
  `lastError` (`provider-approve-page`); the reservation proof verified by the audited ML-DSA library itself over the bytes
  written out, and a page's message signer refusing both site-record texts (`vault-session-keys`); `approval.resolve`'s
  `nodeType` (`provider-activate`); QNet Wallet's signed `reserve` answer
  verified by `core.verifySiteRecord` and the payment key's v2 owner bind refused as a message, when the shared vectors
  carry them (`light-node-vectors`).
- Decision 38 (the wallet key unlinks the light node's device): the view from two nodes' public status, a platform one node
  names before another's `unknown`, `NOT_LINKED`, `UNSUPPORTED`, `NETWORK`, `SIGNING_DISABLED`; the action's signed status with
  the wallet key, the unbind body and signature verified as the node checks them (never the ping form's message), the two
  nodes that agreed, a silent first node, `stale_seq` read again, every other refusal `UNLINK_REFUSED`, nothing signed for
  `NOT_LINKED` or no agreement (`nodes-unlink`); `keys.signNodeUnbind` (`vault-session-keys`); the core's signer and its
  refusals against the shared vectors' `walletUnbind` (`light-node-vectors`, `core`); `qnet_unlinkNodeDevice` through the
  router and the provider: 4100 elsewhere, `NO_WALLET`, the view's checks, the reject and the cooldown, the unavailable
  reasons, the failures as results, the result check, and its window on the fake DOM (`router`, `provider-node-unlink`); the
  popup reading and offering nothing of the device in any view of the Activate tab, a burn just made included (`ui-popup`,
  decision 41); the screens in every language (`scripts/overflow-check.mjs`).
- Decision 39 (two histories, what was read shows at once, the cursor): the Solana rows read from transactions (SOL, 1DEV, a
  burn, a failed send, to itself, none for someone else's), the two listings merged by slot with the cursor to the end, each
  transaction read once, seeded from the view cache after a restart (`chains-activation-solana`); the view cache kept per
  wallet, read back by a restarted worker, dropped by a lock and a new session (`vault-session-session`); the popup's Solana
  list with its icons, More and the explorer link, one line per row, the cached balances drawn before the read answers, the
  other network read after the open, the explorer opened by the row (`ui-popup`); only the lock screen focusing its field
  (`ui-popup`, `provider-approve-page`); the largest amounts and the cached views in every language
  (`scripts/overflow-check.mjs`).
- Decision 37 (the approval under the toolbar icon): the exact corner of the requesting window, of a window on a display
  left of and above the primary one, of a window lower than 712 px and of one narrower than 416 px, each wholly inside it,
  and Chrome's default without a window; the normal window's corner, never a requesting popup window's, and Chrome's
  default when no normal window can be read; one window's corner across displays of other sizes and offsets, either at
  random, the focused one, and the refused place of a window hanging off its display (`provider-cooldown`); the random gap
  and the arm delay unchanged (`provider-approve-page`).
- Decision 44 (certified state proofs): the shared verifier's golden vectors of the node's `golden_vectors_for_clients`,
  every leaf field, the three proof kinds and their forgeries, the strict reading of certified account and token answers,
  the older token body, and the light client's root of a named macroblock (walked to that index only) and certified head
  (the second highest of at least three, the older nodes' sealed count) over a committee that signs for real
  (`certified-proofs`, `helpers/certified-net.mjs`); a certified proof folded to the root the light client verified and
  never to the one served, a certified absence and never an unverified 0, the older node's proof counted only on a certified
  root and marked old, a state far below the head refused, the nodes' account never moving a balance, no certified state
  refusing every send by its code, the send rule (the wallet's own transactions since the certified state counted, what
  arrived since never, another device's nonce refused, the spend records kept and settled), Retry-After, the 64 KB cap,
  the pinned index and `latest`, the token balance paired with the QNC proof and reduced by own token transfers, a token
  send after a contract call waiting, the older token proof (`chains-activation-qnet`); the spend records in the vault
  (`vault-session-vault`); the approval saying why no balance was read, and staying open on the send rule's refusal
  (`provider-approve-page`, `provider-background`); the popup's not-confirmed line (`ui-popup`); the certified balance
  end to end (`integration`).
- Decision 40 (the sandbox round): a silent node does not hold the account read, the popup's read waits at most 1.5 s for a
  proof's check, the chain check (a head far below the one seen drops the anchors, pending sends and cached QNet views; an
  anchor above the head goes; the light client's lineage reset drops the vault's copy of the kept anchors), the dropped transaction
  (status, default replace, freed amount, the day's expiry), token rows with their block and hash-based inclusion,
  `listTokens` (two nodes' lists together, each token named by two nodes, each balance certified since decision 44), `tokenPreview` / `tokenSend`
  through `prepareCall` / `sendCall`, `txLookup` (`chains-activation-qnet`); the chain cache's MAC, a planted or old-password
  cache read as none, the balances kept across sessions and never an unverified one (`vault-session-vault`); the export of
  both keys behind the password, the QNet seed making the same key pair with the audited library, the Solana secret key
  signing for the address (`vault-session-keys`); `vault.exportKey` and the token types in the table, only the key with its
  account and address (`router`); the cached balance with "Updating…" and the failed read's line, the unverified line,
  the token rows, the token picker, review and send, the detail of QNet, token, dropped, unverified and Solana rows, the key
  export screens, no focused field anywhere and the browser's first focus given back, the header and tab bar gutter
  (`ui-popup`); no cursor back in the approval window's field after a wrong password (`provider-approve-page`); every new
  screen in every language (`scripts/overflow-check.mjs`).
- Decision 41 (the Activate tab after the burn): the tab's parts top to bottom in every view with a code (the vault's Light
  and Super, aiqnet.io's record of a Light and a Super burn, right after a burn, after Recover, a burn that settled), every
  text and control on the screen exactly in those views and in the node's (its warning and Recover), so no line or button
  comes back beside the code unnoticed, the requests of every page a test opens checked against the router table, the
  record card off the screen once the chain lists the node (on the first read, after a poll and on an `activation` event,
  the code staying armed) and on it with its line in every other state, the manage line's one link, none of the burn's
  details, the server card, the paid-on-site line, the success banner or the device, the warnings of another burn with
  their explorer buttons, the code masked with one press, hold, the copy warning first, Cancel copying nothing, the
  clipboard cleared and the code nowhere in the page once forgotten, one record
  read per poll after a burn and none once the tab is left, no `node.unlinkView` or `node.unlink` from any page
  (`ui-popup`); `activateManage` naming aiqnet.io/node in every language (`i18n`).
- Decision 43 (06.10): the earlier version's record made with the 2.x algorithm (both versions, a JSON string, a
  placeholder): the status, a check that writes nothing, a wrong password counted toward the backoff and removing nothing,
  the move under a new password (the same addresses, an Argon2id vault, the earlier password opening nothing, every
  earlier key gone, no secret left in `chrome.storage.local`), a weak password, an existing vault and a record with no
  valid phrase refused with nothing removed, `vault.removeEarlier` only with a vault, the leftovers of no record removed
  with a new vault, the record parser's bounds; the pages' copy made with 2.x's own sealing: never created by a status
  read, a phrase with a line break or tab from a paste, moved alone, after a password change made in 2.x (the record with the first password, the copy with the current
  one), the copy taken when the record holds no valid phrase and the record winning when both do, deleted by the move,
  `vault.removeEarlier`, Delete wallet and a new vault when it holds no phrase, and its parser's bounds
  (`vault-session-earlier`); `vault.migrate` and `vault.removeEarlier` in the
  table (`router`); a hidden or format character shown as U+FFFD and marking the token, QNet's names in any spelling, the
  rows of `listTokens` and of History with `reserved`, the tokens of a send first, `complete` past 20 or with a token no
  two nodes read (`chains-activation-qnet`); the flag of the token as deployed in the approval (`provider-background`);
  `core.tokenLabel`, `core.contractShortId` and the hidden-character rule (`core`); the marked rows, contract ids, picker
  labels, History detail notice and "Some tokens are not shown", the phrase and the key shown at once with Copy and Done,
  the code in Settings (no warning, no timer, the silent clear) and not on the Activate tab, the Lock icon with its
  localized name, the page storage emptied at start, the earlier wallet's removal in Settings (`ui-popup`); setup's
  earlier-wallet screens, backoff, unreadable record, the removal offer after Import and the idle drop of the earlier
  password (`ui-setup`); the approval window's web storage emptied at start (`provider-approve-page`); the integration's
  code from Settings and the phrase at once (`integration`); every new screen in
  every language (`scripts/overflow-check.mjs`).

## 12. Decisions to confirm with the owner

These follow the audits where the spec text was silent or looser; each is small to reverse.

1. Auto-lock is stored inside the vault ciphertext, not `chrome.storage.local`: content scripts can
   write `storage.local`, and EXT-SEC-M4 / R22 forbid security settings there. `settings.get` returns
   `autoLockMinutes: null` while locked.
2. Site grants stay in `storage.local` under `qnet_sites_v3` as the spec says, but carry an HMAC keyed
   by a random `sitesKey` in the vault record, so a written-in grant is ignored (R22).
3. `qnet_chainId` returns `{chainId: 'q1337', network: 'testnet'}`; `qnet_sendTransaction` returns
   `{status, from, ..., nonce, txHash}` (section 4.4): a transaction's identity is (`from`, `nonce`), and `txHash` may be
   null because a submit can be unanswered (`status: 'unknown'`).
4. Types beyond the spec list: `qnet.preview` (the review screen shows the nonce, as the approval
   does), `solana.quote` (exact fee and rent before a send).
5. R15 asks Recover to use "a wallet ML-DSA-65 signature"; the code algorithm is fixed by the node
   (`generateActivationCode(type, solanaAddress, burnTx, amount)`), so Recover binds the code through the
   burn itself (fee payer and burn authority = this wallet). The server-side one-code rule is outside
   the extension.
6. The password backoff lives in `chrome.storage.session`, so a browser restart resets it; the KDF cost
   is the real barrier.
7. Only 12- and 24-word phrases are accepted (Core stage), as by the mobile app's import (XC-M2).
8. Import and Restore take the 12 or 24 words and a new password, nothing else. The premise of 2026-09-28 that no wallet
   of an earlier extension version exists was wrong: the store's 2.1.x has about 47 users, who update into this version
   under the same item. Their wallet is moved by `vault.migrate` (decision 43, section 5, Earlier version), and its
   phrase can still be imported.
9. A recipient is known only when this wallet signed a send to it (`VaultState.recipients`, newest 128);
   an address that only appears as a sender in the history is shown as "never sent to", and one that shares
   its first and last characters with a known one is a look-alike warning (ES-01). The popup review and the
   dApp approval show the same check; the history read is a hint, the vault list the authority.
10. The restore token is spent by any `vault.restore` call except one that answers `confirm` (nothing erased), so a
    refused restore (which the popup's own checks make rare) starts again from the lock screen.
    A restore with the same phrase also drops the activation record, a pending burn and unconfirmed transfers
    of the old vault, as a wipe does.
11. The approval cooldown counts a reject, a window closed, and a page that went away once its window had
    drawn the action for `CONFIRM_ARM_MS` (a timeout never counts); from the origin's second window within a
    minute a page gone sooner and a closed unavailable activation count too; the fifth within ten minutes bars the
    origin for a minute (one bars nothing: owner, 28.09), and every window counts against a budget of 5 a minute and
    20 in ten minutes until an approved action (R2-ERP-01). It ends the origin's
    approvals already waiting, and tells the dApp so with its own fixed 4001 text (ES-03). The wallet UI never
    shows it.
12. `qnet_activateNode`: the price of the first burn view is fixed for the approval (a later quote
    never changes what the user confirms; the burn's own two-node check refuses a change, and the window
    reviews again). The code, the pending burn and the addresses go to the site only after the confirm (the password
    until decision 32), also when nothing is burned (`exists`, `pending`). The unavailable reasons shown before the confirm
    also cover the balances (`INSUFFICIENT_TOKENS`, `INSUFFICIENT_SOL`) and a failed self-test
    (`SIGNING_DISABLED`, sent to the site as `INTERNAL`). The window stays on the outcome up to 30 s.
    The approval window is 400 px wide (it was 380) to match the width the layouts are checked at.
13. Languages: tab labels that are one long word carry a soft hyphen (`\u00ad`) and may take two lines;
    language names are shown in their own language; the typed confirmation `DELETE` stays English (a protocol value
    of `vault.wipe`; `ERASE`, the confirmation of `vault.restore`, is never shown or typed); dates follow the UI
    language; the choice is stored only after an unlock (`settings.set`), and before that the browser's
    UI language is used.
14. The recovery phrase may be copied by its Copy button, on the setup screen of a new wallet and in Settings →
    Recovery phrase, after an explicit click and with the warning next to it; the clipboard is emptied after 60 s,
    at the end of setup and on a deletion, as far as a page that is still open can (owner decision of 2026-09-28,
    section 8).
15. The vault record keeps the keys `aad.legacy` (always null) and `state.exposedAdvice` of its format, so a vault an
    earlier 3.x build wrote opens unchanged; a record with anything but null in `aad.legacy` or `state.legacy` does not
    open (`VAULT_CORRUPT`: Restore replaces it).
16. Approvals confirm only on a real pointer click (mouse, pen or touch); a keyboard press does not
    confirm (ES-02). This trades keyboard-only use for resistance to a page that times a key press.
17. A new password needs at least 8 characters and is typed twice, nothing else, as in the app (owner decision of
    2026-09-28: the rule both wallets had before; the complexity and guessability checks and their dictionaries are
    gone, which makes `lib/qnet-core.js` about 3.9 MB smaller).
18. The burn searches, the node check before a burn, Recover and the site's activation answers look at the wallet's own
    addresses only (and, for a burn aiqnet.io paid, at the node's registration record): the wallet has no other
    burner.
19. Change password protects copies of the profile made from then on only; the screen says so and advises a
    new wallet when the old password may be known (EXT-VAULT-R2-05). Rotating the recovery phrase is not
    offered from Settings.
20. Left to the owner (they need the node, the mobile app, the site or the protocol text, outside this
    extension; rounds 3 and 4): the `proof` balance tier needed the node to serve the account proof against the last
    certified macroblock's state root and index (R3-EXTQ-02, MOBNET-R4-04; served since, decision 44), and the registry keys of a committee
    without the whole snapshot (MOBNET-R4-05); the node should answer an error, not `{0, 0}`, for an account it cannot
    read (R4-EXTQ-02); the key naming this device's own burn when two devices burned and this one's is not the oldest
    (`supersededBurnTx` since decision 25: XP-R4-04, XP-R5-03) is QNet Link v1 section 7.1 now; whether a Full-node burn
    may be derived as a Light or Super code (the node accepts it; `BURN_UNUSABLE` is now a protocol code: XP-R5-01); the apply outcome of a listed transfer, which the node's history
    does not serve (R5-EXTQ-01), and a transaction hash derived from the signed fields only (R5-EXTQ-03); an
    authenticated answer channel (a short authentication string) is a protocol change (SITE-R3-01); `register:` /
    `migrate:` joined `PROTOCOL_PREFIXES` here, the mobile list and its vectors follow (XP-R3-05). The public
    documents (docs/applications/browser-wallet.md, docs/protocols/qnet-link-v1.md) and the mobile app's matcher
    follow this file (R4-XPD-03, R4-ERP-04, XP-R4-06, R4-MOBLINK-03, R4-SRA-02, R4-XPD-02).
21. The words written down, typed and copied are the canonical words every QNet wallet uses: import canonicalizes
    spacing and case, and the wallet derives its keys from the canonical phrase only.
22. A burn of the wallet no Light or Super code derives from (a Full-node memo, or a burn from another 1DEV token
    account) is the wallet's activation for the one-activation rule: no second burn is offered (`BURN_UNUSABLE`), and
    support is the way on (R4-ESA-01).
23. Round 4 contract changes to frozen files: `dist/manifest.json` (content scripts on `https://aiqnet.io/*` only),
    `router.js` (the default port), `errors.js` (`BURN_UNUSABLE`), `sw.js` (the resumed burn search), `scripts/package.mjs` and `scripts/extension.mjs` (the
    pin check), `test/router.test.mjs`, `test/skeleton.test.mjs`.
24. Round 5 (R5-*, ERP-R5-*, XP-R5-*): a word or phrase of any language is refused as a vault password (superseded by
    decision 17: a new password needs 8 characters, nothing else); a
    staged restore record never outlives its restore; the approval window opens inside one normal window; a lone carriage
    return and the near-invisible spaces are refused in a signed message (the mobile rule in
    `OffchainMessage.js` follows); History says "in a block", never "confirmed" (superseded by the owner's badges of
    2026-09-28: Confirmed, Failed, Pending, section 2.5); one node's refusal keeps the transfer as
    `refused` and the next send replaces it; `qnet_sendTransaction` answers (from, nonce); the one-activation search
    for burns no code derives from reads what the wallet signed, resumably, never the token accounts others can make; a
    burn beaten by another device's answers `exists`. Frozen files changed: `errors.js` (the `NODE_REJECTED` text),
    `sw.js` (`vault.discardRestoreStaging` at start), `test/router.test.mjs`.
25. Developer platform (owner decisions of 2026-09-26): sites send token transfers and WASM contract calls through
    `qnet_sendTransaction` and follow them with `qnet_getTransactionStatus` (section 4.9); a call carries no QNC value and
    no access list, which the network does not accept today (`UNSUPPORTED_PARAM`, the one error with data); status is
    `pending`, `in_block` or `unknown`, never a success, since the node keeps no outcome; a site's transaction waits in
    its window while an earlier one holds the nonce (the node admits committed + 1 only); `https://games.aiqnet.io/*`
    joins the content-script matches (connect and send only, no activation). A token's name, symbol and decimals are two
    pinned nodes' word; its balances are certified since decision 44 (the token proof and its verifier, the shared one the
    bundle compiles). XP-R5-03: the
    answer names a beaten burn in `supersededBurnTx`. A site sees the same answers
    from the extension and from the mobile in-app browser: the send results, `submitted` only with a hash, the status
    answer `{status, blockHeight, txHash}` with its 3 s reuse and 20 reads a minute, and the `UNSUPPORTED_PARAM` refusal
    (`Unsupported parameter`, `data: {reason: 'UNSUPPORTED_PARAM'}`). Frozen files changed:
    `dist/manifest.json` (the games host), `router.js` (`normalizeTransaction`, `qnet_getTransactionStatus`,
    `CALL_ARGS_MAX_BYTES`), `errors.js` (`UNSUPPORTED_PARAM`, `INVALID_METHOD`, `INVALID_ARGS`, `INVALID_GAS_LIMIT`,
    `UNSUPPORTED_CALL_FIELDS`, `UNSUPPORTED_PARAM_MESSAGE`, the error data), `test/router.test.mjs`, `test/skeleton.test.mjs`.

26. Unified direction (owner decisions of 2026-09-26, 3.1.0): the extension records the wallet's light node on the QNet
    network right after its own light burn and for a burn made earlier (Record on the network), so the activation code is
    a receipt. The cabinet's signer on a desktop is `qnet_activateNode` (burns and records, result keys unchanged) and
    `qnet_claimNodeBalance` (moves the node balance of the wallet's own light node, no password, the claim answer of QNet
    Link v1 section 14.7). No device linking, ping key, push token or "I'm back" here: that is the phone's. The consent
    method for a burn the cabinet paid (`qnet_consentNodeRegistration`) is deferred, and so is recording a Full-node
    burn (`BURN_UNUSABLE`: not recorded until decided). The node's stable submit `code` is read when present, its text
    otherwise. The defence-in-depth protocol prefixes for the untagged node messages (`client_node_reg:`,
    `claim_rewards:`, `qnet_claim_v1:`) and the device messages (`qnet_dev_`, the wallet-signed rebind among them) joined
    `PROTOCOL_PREFIXES` together with the app's list and its vectors. Frozen files changed: `dist/manifest.json` (version),
    `config.js` (`WALLET_VERSION`, the registration constants, `CLAIM_MIN_NANO`, `REGISTRATION_ALARM`), `errors.js`
    (`NO_NODE`, `CLAIM_REFUSED`, `CLAIM_BUSY`), `router.js` (`activation.register`, `activation.registration`,
    `qnet_claimNodeBalance`), `sw.js` (the hook, the resume, the alarm), `test/router.test.mjs`, `test/skeleton.test.mjs`.
27. A burn aiqnet.io paid (owner correction of 2026-09-26): the cabinet's one-time payment key burns for the user's
    wallet, and the activation code keeps today's format but names the wallet (its QNet address), not that key, so it
    reads as this wallet's code. Recover finds such a burn only through the node's registration record (burn_tx →
    wallet, the signed status the wallet key reads), keeps it as the wallet's one activation with its registration on
    chain, and never records or burns on top of it (`NODE_EXISTS` to the site). A desktop burn of the extension keeps
    the burner's code, as before. No frozen file changed.
28. Final audit, extension round 1 (2026-09-27): no burn until the QNet network vouches that the wallet has no node,
    since a burn the cabinet's payment key made leaves no trace in the phrase's history (EXT-R1-01: fail closed,
    `NETWORK`, which a site learns as `INTERNAL`); the chain's word on the registration is two pinned nodes', and a
    record on chain is read again on request and on a throttled resume (EXT-R1-02); an admitted record is read on chain
    past the attempt cap, and a far retry shows Record on the network (EXT-R1-04); Recover's card says it records the
    light node (EXT-R1-05); a full claim batch must reach the balance two other nodes agree on, and a node that cannot
    serve an epoch hands the quote over (EXT-R1-06, EXT-R1-07); the Super card and its burn warning say the server then
    holds this wallet's keys (EXT-R1-08; no text of the extension says it since decision 41 took the Super server card,
    `envSeedWarn`, off the Activate tab). A quote the node cuts below 1 QNC while the balance is above it (EXT-R1-03) is
    settled in decision 29. Frozen files changed: `config.js` (`REGISTRATION_ADMIT_CHECK_MS`,
    `REGISTRATION_SOON_MS`), `sw.js` (the registration hook passes its options on).
29. Final audit, extension round 2 (2026-09-27): the owner chose for EXT-R1-03 that a claim below 1 QNC moves when the
    node's quote is a part of the balance (`stopped_at_epoch` set: the node caps a quote by size, so a balance of many
    small epochs moves whole only in several claims). `nodes.checkedQuote` holds a full batch to `CLAIM_MIN_NANO` and a
    part to above zero, and `provider.claimResult` answers the site the same (EXT-R2-01); the view still offers a move
    only for a balance of at least 1 QNC, and the claim window says a large balance may move in parts below it. QNet
    Link v1 sections 14.2 and 14.7, the shared vectors, the site's answer check and the app change with it (outside this
    folder). The activation window of a node aiqnet.io paid for says its code is on the Activate tab instead of
    pointing to Recover (EXT-R2-02). No frozen file changed.
30. Final audit, extension round 3 (2026-09-28): a part of the balance (`stopped_at_epoch` set) is not held to the
    pending total, so a quoting node could leave out epochs between its first and last one and the claim would move the
    watermark over them for good; `nodes.claimForSite` now has another pinned node quote the same request and signs the
    quote that ends lower only when the other lists exactly its epochs and amounts up to its last epoch (EXT-R3-01). The
    light activation's next step names the site's Link a device button by the label aiqnet.io shows in Russian and
    Japanese too, checked against the site's tables in every language (EXT-R3-02; the next step went with decision 41). A weak-password test sample names no
    other chain (EXT-R3-03). No frozen file changed.
31. Owner decisions of 2026-09-28: the extension carries no wallet of an earlier version over, on the premise that none
    exists (decisions 8, 15, 18, 21); decision 43 corrects the premise (the store's 2.1.x wallets do exist) and moves them;
    and the recovery phrase has its Copy button (decision 14, section 8). Frozen files
    changed: `config.js` (`PHRASE_CLIPBOARD_CLEAR_MS`), `errors.js`, `router.js` (`vault.create` / `vault.import`
    handled by vault.js), `sw.js`, the export list of `ui/common.js` (`clearCopiedNow`), `test/router.test.mjs`,
    `test/skeleton.test.mjs`.
32. Owner decisions of 2026-09-29. No approval window asks for the password: the unlocked session confirms. While
    unlocked, the window shows the site and exactly what will happen, and
    the press of its Confirm, armed after `CONFIRM_ARM_MS` / `CONFIRM_ARM_VALUE_MS` at a random place, is the
    confirmation; locked, it asks for the password once to unlock and then shows the request without asking again. The
    arm delay, the random placement, the per-origin cooldown and window budget, the burn's acknowledgement, every check of
    what is signed and the result guards are unchanged, and the window binding of section 4.8 (the approve page, the
    approval's id, its window, the revision, once) is what ties a confirm to its request. `activation.activateForSite`
    takes no password. The popup keeps the password for its own actions that are no site's request: Reveal recovery
    phrase, Change password, Delete wallet, and also its own burn, showing the activation code and Record on the
    network (`activation.burn`, `activation.copy`, `activation.register`; until decision 33); Reset wallet takes the
    recovery phrase. The
    popup has no Refresh button: balances, the token list and the history read themselves again (section 9, Pages;
    event `balance`). Frozen files changed: `config.js` (`VIEW_EVENTS` gains `balance`, `TIMINGS.POPUP_REFRESH_MS`),
    `events.js` (the event name in its JSDoc), `router.js` (`approval.resolve` without `password`),
    `test/router.test.mjs`.
33. Owner decisions of 2026-09-29, later the same day. (a) No password while unlocked for a site-independent popup action
    that is no high-risk secret action: the popup's own burn (`activation.burn`: its acknowledgement "I understand that
    … 1DEV will be destroyed…" stays, it had no arm delay), showing the activation code (`activation.copy`: one press,
    the code in the page only while shown, as before) and Record on the network (`activation.register`: one press, no fee,
    nothing burned). A `password` sent with any of them is `INVALID_PARAMS`. The password stays for Reveal recovery phrase,
    Change password and Delete wallet; Reset wallet keeps taking the recovery phrase. This replaces that part of decision 32.
    (b) The extension sends on the Solana side as it does on the QNet side: SOL and the listed SPL tokens (1DEV), with
    `solana.max` for the form's Max and `solana.status` to follow a send the popup shows as pending (`solana.send` no longer
    waits up to a minute: it reads the status once). A send is exactly a System Transfer, or TransferChecked at the mint's
    on-chain decimals after the recipient's associated account is created idempotently (the wallet pays its rent), and
    never carries a burn (`assertSendInstructions`). The chain's rent rule is checked before signing (`AMOUNT_BELOW_RENT`,
    `SOL_BELOW_RENT`), and a blockhash simulation no longer finds is `BLOCKHASH_EXPIRED` (review again). The recipient
    field reads a pasted payment request of the address, amount, token, label and message parts only; any other part (a
    reference or memo, which this wallet does not add) refuses the whole request rather than paying without it. Send arms
    after `TIMINGS.CONFIRM_ARM_VALUE_MS` and asks no password (the unlocked session, as the QNet send). Frozen files
    changed: `router.js` (`solana.max`, `solana.status`, the three types without `password`), `errors.js`
    (`SOL_BELOW_RENT`, `AMOUNT_BELOW_RENT`, `BLOCKHASH_EXPIRED`, the `INSUFFICIENT_SOL` text), `test/router.test.mjs`,
    `test/integration.test.mjs`.
34. Owner direction of 2026-09-29 (payment flows work as on mainnet; the app and the extension behave the same), decided
    for the owner: the Solana send reads and pays a payment request exactly as the mobile app does
    (`utils/solanaRequest.js`, `crypto/SolanaTx.js`), so one request is read alike and signed to the same bytes in both.
    Why: a payee's request (the site's own `solana:<addr>?amount=1500&spl-token=<1DEV mint>&label=…` among them) must pay
    the same from either wallet, and a request whose reference or memo was refused could not be paid from the extension.
    `kit.parseSolanaRecipient` takes the app's grammar, limits and decoding: `amount` (up to 20 whole and 30 fraction
    digits, zero asks for no amount), `spl-token` and `memo` once each, up to four distinct `reference` addresses, `label`
    and `message` (shown as text, the first of each; the app ignores them), names and values form-encoded ('+' a space,
    %2B a plus), any other part ignored; a malformed part, a once-only part given twice, a fifth, repeated or invalid
    reference, or a memo that is empty, above 200 bytes of UTF-8 or holds a control character or a bidi mark refuses the
    whole request, and so does a memo that is not well-formed (a lone surrogate, which only pasted text can hold: its UTF-8
    would be U+FFFD, not the text shown; both wallets refuse it)
    (`config.PAYMENT_REQUEST` and `config.isPaymentRequestMemo`: one rule for the page, the router and the worker). The
    transaction attaches them as the app does: the references as read-only, unsigned accounts after the transfer's own, the
    memo as one SPL Memo that lists no account, right before the transfer and after the create; a send's keys come in the
    order its instructions name them (`compileLegacyMessage` 'listed': within a class a token send's keys now follow the
    app's order instead of the reference client's; the burn keeps the reference client's, byte for byte with the
    recorded devnet burn). `assertSendInstructions` allows exactly the three shapes, each with the request's references
    on the transfer and its memo before it, and refuses a burn, an approval, a memo it was not asked for, a second or
    changed memo and a reference the request did not name. `solana.quote` and `solana.send` take `references` and `memo`;
    the quote carries them back, the popup takes a quote only when they are the ones it asked for, the review shows the
    quote's memo as text and how many references it carries, and the send plans again from the same fields. A transaction
    above `SOLANA.TRANSACTION_MAX_BYTES` (1232) signed is `TX_TOO_LARGE` before anything is signed (the largest request, a
    new account with four references and a 200-byte memo, is 753 bytes). This replaces the part of decision 33 that
    refused a request with a reference or a memo. Frozen files changed: `config.js` (`SOLANA.TRANSACTION_MAX_BYTES`,
    `PAYMENT_REQUEST`, `isPaymentRequestMemo`), `errors.js` (`TX_TOO_LARGE`), `router.js` (the list field kind;
    `references` and `memo` of `solana.quote` and `solana.send`), `test/router.test.mjs`.
35. Owner decisions of 2026-09-29 (R1, R6): one wallet, one code, for a Light or a Super node, chosen once; a received code is
    always shown; a second burn is impossible through the payment address, the popup, a site, two browsers at once or a reset
    and restore. aiqnet.io keeps a verified record of every burn (both ways, both node types) keyed by the QNet wallet and at
    most one reservation per wallet (`/api/cabinet/activation/`, implemented by the site). The extension builds a burn only when
    every source answered "none": the vault, its pending burn, the kept search of the wallet's own address, aiqnet.io's record
    and the QNet network; a source that is loading, locked or unreachable means no burn, said so with a retry. It signs only
    under aiqnet.io's reservation (`reserve`, one atomic insert, 10 min, signed only with at least 2 min of it left), announces the burn
    with the wallet's proof before it is sent (`announce`: nothing is sent without its 200), gives a reservation back when
    anything fails before the send, and records a burn the vault holds (`record`, `activation.syncRecord`: after every unlock, a
    settle, a stored search, Recover, and a read that sees the vault's own burn). The proof (keys.signBurnRecord): with M =
    `QNet burn record v1\nwallet: W\nnode: T\nburner: S\nburn: TX\namount: A\ncluster: devnet` and E =
    `core.buildOffchainMessage('https://aiqnet.io', M)` (the origin constant in every build; the same bytes come from
    `core.buildSiteRecord` since decision 36), `{pk, sig, solanaSig}`: the wallet's
    ML-DSA-65 public key and its signature of E with the context `QNET_OFFCHAIN_MSG_v1` (base64url without padding), and the
    burner's Ed25519 signature of E (base58); it carries no time, may be sent again, and only both keys of the phrase make one,
    so nobody can plant a record for another wallet. aiqnet.io's answers map to wallet codes: a record or a burn it found →
    `ACTIVATION_RECORDED`, a reservation or a burn on its way elsewhere → `ACTIVATION_RESERVED`, a node → `NODE_EXISTS`, the
    network unavailable → `NETWORK`, no answer, 429 or any other 503 → `RECORD_UNAVAILABLE`, 400 → `INTERNAL`; a site learns them
    as `NODE_EXISTS`, `BURN_IN_PROGRESS` and `INTERNAL`. A record of a burn of the wallet's own address is stored as its
    activation once Solana shows the burn (a restore finds its code at once); a payment burn (light) is shown with the wallet's
    code and never stored or registered here; a record of another burn is the wallet's code and the vault's burn is shown as
    one that gives none. New provider method `qnet_getActivation` (section 4.4): aiqnet.io reads what the extension knows
    without an approval window and without a burn button. EXT-F1: the Activate tab offers its Light and Super cards only when
    every source said "none" (`activation.lookup`; checking, elsewhere, a node with Recover, a record's code, a source that
    cannot answer with Retry). EXT-F2: a burn on its way is read again on its own every 5 s while the popup is visible; no Check
    again button. EXT-F3: the lock, the unlock and `accountsChanged` reach a page whose port an idle worker closed, through its
    tab (section 4.2; the host permission is enough). EXT-F5: no Done after the popup's burn, and the approval's outcome is
    titled by what happened. EXT-F6: the lead that invites a burn only without a code, `err_BURN_EXISTS` names "Recover my code",
    the Korean particle, localized import placeholders. XC-03 and EXT-F7: section 4.10 and decision 24 describe what exists.
    What only the node can close is left to it: the one-wallet-one-node rule is its own, a burn made by hand outside these
    clients cannot be refused by Solana, and the node's own code generation and a super node's server read no record of
    aiqnet.io (reported to the owner). Frozen files changed: `config.js` (`RECORD_PATH`, `RECORD_ORIGIN`, `PROVIDER.TAB_EVENT`,
    `LIMITS.ACTIVATION_READS_PER_MINUTE`, `TIMINGS.RECORD_TIMEOUT_MS`, `RESERVATION_TTL_MS`, `SIGN_MARGIN_MS`,
    `WALLET_SEARCH_SPACING_MS`, `WALLET_SEARCH_FRESH_MS`, `ACTIVATE_RECHECK_MS`), `errors.js` (`ACTIVATION_RECORDED`,
    `ACTIVATION_RESERVED`, `RECORD_UNAVAILABLE`), `router.js` (`qnet_getActivation` and its result-key exception, the UI type
    `activation.lookup`, the `tabs` option and the tab events, which name their origin for the relay to check), `sw.js` (the
    sync after an unlock, `createRouter({tabs})`), `test/router.test.mjs` and `test/skeleton.test.mjs`;
    `test/helpers/chrome-mock.mjs` is untouched (the tests give their own `tabs`). What the Activate tab shows beside a
    code, the vault's or a record's alike: decision 41.
36. Owner decisions of 2026-09-29, evening (A1-A4). (A1) Only the wallet itself holds aiqnet.io's reservation: the reserve
    body is exactly `{wallet, nodeType, way: 'extension', burner, burnAmount, solana, proof}` with `proof` `{pk, sig, time}`,
    signed silently by the wallet's own key inside the burn the user already confirmed (the popup's acknowledged press or the
    approval's armed confirm; no new window): `keys.signReservation`, ML-DSA-65 with the context `QNET_OFFCHAIN_MSG_v1` over
    E = `core.buildSiteRecord(RECORD_ORIGIN, M)` with M = `QNet node reservation v1\nwallet: W\nnode: N\nway: extension\nburner:
    S\ntime: T\ncluster: devnet` (UTF-8, LF, no trailing LF, T in Unix seconds without leading zeros), `pk` and `sig` base64url
    without padding, `time` a JSON integer. aiqnet.io checks the key is the wallet's, the signature, and the time (at most 10
    minutes old, at most 5 minutes ahead; the payment way's request, which QNet Wallet signs, up to 24 hours and 10 minutes old)
    and refuses an unsigned, forged, other-wallet or stale request with a 400 (`invalid_proof`, `stale_proof`), which the
    extension reads as `INTERNAL` (`errors.js` unchanged: no new wallet code); nobody can hold a wallet or burn in its name.
    (C3) The protocol prefixes gain `qnet_burn_owner_v2:` (the payment key's owner bind), `qnetburnrecordv1` and
    `qnetnodereservationv1` (aiqnet.io's records of a wallet, as the prefix check folds them), the same list as the app's; so
    a page's `qnet_signMessage` can never obtain a record or a reservation proof through an approval. The wallet signs those
    records only through the core's site-record signer, `buildSiteRecord`/`signSiteRecord` (and `verifySiteRecord`): the
    envelope and context of `signOffchainMessage`, without the prefix refusal, for a message that starts with
    `QNet burn record v1\n` or `QNet node reservation v1\n` only (`SITE_RECORD_HEADS`; anything else `INVALID_MESSAGE`);
    `keys.signBurnRecord` moved to it (the same bytes). (A2, C5) A payment address's burn is permanent: announced with its
    owner bind before it is sent and `recorded` once final, like the extension's own burn; the record state `burned` and the
    24-hour hold are gone (`RECORD_STATES`, `parseRecord`, the popup's `activatePaymentWaiting` and its view); a payment burn
    on its way reads as an activation elsewhere (`ACTIVATION_RESERVED`), a recorded one as the wallet's code, never replaced by
    `syncRecord`. (A3, C7) The network's one-node rule (gate `wallet_one_node`) refuses a second node of either type for a
    wallet: the node's submit code `wallet_has_node` (its text "wallet already has a node") is `refused` for good, never
    `onchain` and never retried, with its own line (`recordRefusedWalletHasNode`) and no Record on the network. (A4) A Super
    node is activated only here, in the extension, and runs on the user's own server with the QNet node software: the Super
    card says so (`activateAbout_super`); the Super code's copy warning says that the code and the burn start nothing without
    the wallet's recovery phrase (the node checks the code against the phrase's own address) and that aiqnet.io shows the
    code for this wallet too (`codeCopyWarn1`, `codeCopyWarn2`, replacing "anyone with this code can activate a node as you");
    the server settings card linked every server step on aiqnet.io (`envGuide`, `envGuideOpen` →
    `RECORD_ORIGIN/docs/how-it-works?way=super`) until decision 41 took the card off the Activate tab (the server steps are
    on aiqnet.io/node, the tab's one line, and on Running a node); the approval window adds, after a Super `ok` or `exists`, that aiqnet.io
    shows the code, the burn and the server's settings on My node's Overview (`apOutcome_super`, with `approval.resolve`'s
    new `nodeType`); the paid-on-site line said the light node was paid with a one-time payment address and is finished on
    aiqnet.io/node from any browser and confirmed on a phone or tablet in QNet Wallet (`activatePaidOnSite`, gone with
    decision 41: the tab shows such a code as any other). Review of
    2026-09-30: an activation elsewhere names the one-time payment address on aiqnet.io beside another browser or device
    (`activateElsewhere`, `err_ACTIVATION_RESERVED`: a payment address's reservation or burn on its way reads so); the
    Light card says its node runs in QNet Wallet on a phone or tablet (`activateAbout_light`), and the activation window's
    burn shows the same line of the node type it burns for (`activateAbout_*`); after the answer the window reads a
    `refused` registration once more (`activation.registration`), since `approval.resolve`'s `registration` names no
    `lastError`, so a `wallet_has_node` refusal never reads "try again later"; the store description names both node types
    (`extDescription`: "Activates a QNet light or super node and records the light node", every locale); the layout check
    draws the one-node rule's line in the popup and in the window, the Super outcome's line and the record states aiqnet.io
    keeps now (`scripts/overflow-check.mjs`). Frozen files changed: none.
37. Owner decision of 2026-09-30: the approval window opens under the extension's toolbar icon, not at a random place in
    the middle of the screen: the top-right corner of the chosen normal browser window, 16 px from its right edge and 72 px
    below its top (`APPROVAL_EDGE`), the gap below the top cut so a window lower than 712 px still holds the whole approval
    (section 4.8). Which window is unchanged: the focused normal one, else one of them at random, only when none can be
    read the requesting tab's window if it is a normal one, else Chrome's default place, also taken when Chrome refuses
    the place (ERP-R5-01); a popup window a page opened itself is never the one (R4-ERP-01), since its corner would be a
    spot the page chose. Why it stays safe: the window's place was one layer against a click lure aimed at Confirm, and a
    page can often work out the corner of its own window; what keeps it from aiming is unchanged: the approve page draws
    the gap above its actions at random with every view (7 places), Confirm arms only `CONFIRM_ARM_MS` /
    `CONFIRM_ARM_VALUE_MS` after the window was last left alone (any press, release or key before that starts the wait
    again, a lost focus disarms it), and it confirms only on a trusted pointer click whose press began on the armed
    button in a focused window (R2-ERP-02, decision 16). This replaces the window's random place of section 4.8 and
    decision 32 (the Confirm's random place there stays). Frozen files changed: none.
38. Owner command of 2026-10-04 (wallet-key unbind, the shared contract of the node, the app, the site and this extension):
    the wallet key ends the light node on whatever device runs it, from any device that holds the wallet; one wallet, one node,
    one device at a time, and a lost device is unlinked from here. New provider method `qnet_unlinkNodeDevice` (section 4.4,
    `SiteUnlinkResult`): the activation origin only, no params, no grant; an approval `unlinkNodeDevice` (section 4.8) shows
    `nodes.unlinkView` and its armed confirm, with no password (decision 33), runs `nodes.unlinkForSite` (section 4.10). The
    popup offered the same on the Activate tab (`node.unlinkView`, `node.unlink`) while the view was `confirm`, until
    decision 41 took its Device card off: the device is unlinked on aiqnet.io's Device tab, through `qnet_unlinkNodeDevice`
    signed by this wallet, and the two UI types stay in the frozen table, sent by no page. The view needs
    `unbind_wallet` in two pinned nodes' `features` (the node's switch for the new forms), and reads the public status's new
    `device` (platform, `linked_since`, state); the action signs `q1337|light_unbind_wallet:{N}:{S}:{ts}` with the wallet key
    (`keys.signNodeUnbind`, `core.signNodeUnbind`, built by the app's `walletUnbindPreimage` the bundle compiles, as every node
    builder) at the `binding_seq` two nodes' signed status report alike. The protocol prefixes are unchanged: both wallets
    already refuse `q1337|` in a page's `signMessage`, so no page can obtain this signature. New wallet codes `NOT_LINKED`
    and `UNLINK_REFUSED`. QNet Link v1 (section 14) and the shared vectors (`walletUnbind`, the `unlink` cases and codes)
    change with it. Frozen files changed: `router.js` (`qnet_unlinkNodeDevice`, `node.unlinkView`, `node.unlink`), `errors.js`
    (`NOT_LINKED`, `UNLINK_REFUSED`), `test/router.test.mjs`, `test/skeleton.test.mjs` (the export lists).
39. Owner command of 2026-10-04 (History, speed, the cursor, the texts). (a) History lists the network the switch shows, apart
    like the balances, as the app does: the Solana side lists the wallet's own Solana transactions (`solana.history`,
    `SolanaHistoryItem`, section 2.5) instead of a button to the Solana explorer; every row shows the asset's own icon (QNC,
    SOL, 1DEV), keeps what happened and the amount on one line whatever the amount, and a row is itself the link to its
    explorer page (no View button; the key `historyView` is gone, `historyBurn` names a burn). (b) Switching QNet and Solana was
    slow: the router keeps each balance and first history page it serves in the session's view cache (`session.rememberView`,
    `chrome.storage.session` `qnet_view_cache_v3`, public answers of the session's wallet only, removed by every lock and every
    new session); the popup reads it once when the wallet opens (`wallet.cached`), draws what it holds at once and reads again
    behind it, and after an open or an unlock reads in the background the balances and first history pages the view on screen
    does not read itself. (c) Only the popup's lock screen takes the cursor on its own (the wallet is locked and typing the
    password is all there is to do); Reset wallet, Reveal recovery phrase, the setup tab's fields and the approval window's
    unlock (it opens at a site's request, focused, and keystrokes meant for that page would land in its password field) no
    longer do; a field that refused a password still takes the cursor back. (d) The audit's M23 (texts that call an activation
    a payment): the extension's paid-on-site lines now say what happened, a burn (`activatePaidOnSite`: the 1DEV were burned on
    aiqnet.io from a one-time payment address, the popup's line, gone with decision 41; `apActivatePaidOnSite`: activated with a burn on aiqnet.io); no text of the
    extension says a Super code is never needed, and the Light code's copy warning stays for a Light code only. Frozen files
    changed: `config.js` (`STORAGE_KEYS.VIEW_CACHE`, `LIMITS.SOLANA_HISTORY_PAGE_MAX`), `router.js` (`wallet.cached`,
    `solana.history`, the view cache's keeping of `qnet.balance`, `qnet.history`, `solana.balances`, `solana.history`),
    `test/router.test.mjs`, `test/skeleton.test.mjs`.
40. Owner command of 2026-10-06 (the sandbox round of the extension). (a) Balances load fast: the account is read from two
    nodes at once with the next one joining on a failure and every 700 ms of silence (the first two alike decide; two that
    differ bring in every node, as before), the network head is decided 700 ms after its second answer, and the popup's
    balance read (`readAccount(address, {display: true})`) waits for the proof's QC check at most 1.5 s once two nodes agree
    (the walk goes on, the next read takes the proof; since decision 44 once a figure is read, and two agreeing nodes verify
    nothing); the last verified QNet balance, the token list and the Solana
    balances are kept across sessions in the vault's chain cache (`chainCache`, MAC under the vault key) and drawn at once
    with "Updating…" until the read behind them ends ("Could not update…" when it fails), a balance no committee
    certificate verified says so and is never kept; the popup's background reads go after the screen's own read. (b) The chain the wallet
    follows (`qnet.followChain`, beside the popup's balance read, at most once a minute): a network head 10 macroblocks
    below the highest one the wallet saw is another chain (a restarted test network; the live one never goes back): the
    kept anchors, the pending transactions, the cached QNet balance, tokens and history go; a kept anchor that far above the
    head goes (before either drop every pinned node is asked again and the highest head any reports decides: two lagging
    nodes answering first never pass for another chain), and when the light client finds the anchors kept from an earlier session to be of another lineage (the first
    step above one refused by two nodes with `qc_invalid`, `pubkeys_unresolved`, `epoch_commitment_mismatch` or
    `registry_mismatch`: its `onLineageReset`, shared with the app) the vault's copy goes with them; a chain cache kept under
    another build's chain identity (`core.chainIdentity`, the pinned genesis identities) is another chain's; dropping costs
    a walk, never trust. (c) A
    pending row resolves: `dropped` (section 2.5) reads as Not found, is replaced by default, frees its amount and leaves
    the list a day later; an archive row no two pinned nodes list reads as Unverified, no longer Pending. (d) Any token of
    the QNet network can be sent: Assets lists the built-in QRC-20 tokens (`qnet.tokens`), the QNet send ("Send on QNet")
    picks QNC or a token, and a token goes through `qnet.tokenPreview` / `qnet.tokenSend`, the path and checks of a site's
    token transfer, with the approval window's warnings; archive token rows are listed in History. (e) A history row opens
    its detail (type, status, amount, token, both sides as copy controls, block, time, fee, nonce, hash or signature as a
    copy control, Open in explorer, Back to the list where it was); an unverified QNet row is looked up on two nodes
    (`qnet.txLookup`). (f) The private key of the QNet or the Solana account is exported as the phrase is
    (`vault.exportKey`, Settings → Private key: password, warning, press-and-hold, 45 s auto-hide, Copy with its warning and
    the 60 s clipboard clear): QNet the 32-byte ML-DSA-65 KeyGen seed in hex, Solana the 64-byte secret key in base58; no
    import by private key (the owner decides that separately). (g) No field of any page takes the cursor on its own, the
    lock screen's included, and a wrong password does not put it back (this replaces (c) of decision 39): no page calls
    `focus()`, and `common.refuseAutoFocus` gives back a focus the browser itself gives a text field before the user's first
    pointer or key press. (h) The header keeps a 16 px gutter and the tab bar a 12 px one; tabs keep their labels on one line,
    a language whose labels are wider than the bar has them set smaller together (`fitTabs`, to 80 % at most), and only
    past that the bar scrolls sideways. Frozen files changed: `router.js` (`vault.exportKey`,
    `qnet.tokens`, `qnet.tokenPreview`, `qnet.tokenSend`, `qnet.txLookup`, `RESULT_KEY_EXCEPTIONS`), `test/router.test.mjs`.
41. Owner command of 2026-10-06 ("cut the extension's Activate tab after activation, no extra information, no banners"):
    once the wallet has its code, the vault's or aiqnet.io's record's, of either node type, the Activate tab shows the code
    panel (masked, Show or copy the code, hold to show, Copy with its warning: unchanged), the light node's record on the
    QNet network only while the chain does not list the node (the card goes once it is `onchain`; Record on the network is
    still offered when it waits for the user), one line, "Manage the node at aiqnet.io/node" (`activateManage`, a link to
    `RECORD_ORIGIN/node` in a new tab), and a warning only when another burn is involved (`supersededNotice`,
    `keptBurnNotice`); the code screen right after a burn is the same, titled "Your activation code". A node with no code
    here keeps its warning and Recover. Gone from the popup: the burn's details (node type, amount, burn transaction,
    network, date, Open in Solana Explorer and Copy transaction), the Light next step (Link a device, decision 30), the
    Super server card (its environment names, the phrase warning of EXT-R1-08, decision 28, and its server-steps link,
    decision 36), the success banner that the wallet has its code, the paid-on-site line (decisions 35, 36, 39 (d)) and the
    Device card with Unlink the node's device (decision 38): aiqnet.io/node shows the node, its device and its balance,
    the server steps are there and on Running a node, and the device is unlinked on its Device tab through
    `qnet_unlinkNodeDevice`, signed by this wallet in the approval window (the provider and background code stay). The
    18 texts only those parts used are gone from every language (`copyTx`, `copiedTx`, `activateHasCode`,
    `activatePaidOnSite`, `activateCreated`, `activateUseLight`, `envTitle`, `envLead`, `envCode`, `envSeed`, `envSeedWarn`,
    `envGuide`, `envGuideOpen`, `deviceTitle`, `unlinkButton`, `unlinkTitle`, `unlinkIntro`, `unlinkConfirm`), and the popup
    sends `node.unlinkView` and `node.unlink` no longer. With it, the record card of a burn just made reads its record at
    once in place of the first poll instead of beside it (two timers read twice per poll, and the one no longer held read
    once after the view was gone). Frozen files changed: none (`router.js` keeps the two UI types, sent by no page).
42. Owner command of 2026-10-06 (History rows to the standard of a good wallet; the app gets the same design). Each row of
    either history is the asset's icon (QNC on QNet rows, the token's letter for a built-in token, SOL and 1DEV on Solana)
    with a small round badge of what happened at its lower corner (sent, received, to yourself, swap, node, contract,
    burn; the red failed mark when nothing moved: `replaced`, `dropped`, a failed Solana transaction), a disc in the
    amount's colour with the app's own glyph (its `HistoryTab.js` `BADGES`, a 24-unit vector whose box is the disc) drawn
    through a CSS mask (`popup.css`, base64 SVG of paths and circles only; no image file); then what happened
    ("Sent", "Received", "Sent to self", "Moved from node", "Node registered", "Node activated", "Contract call",
    "Contract deployed", "Swap", "Burned") over who it was with ("To:" or "From:" and the first and last six characters,
    "Node <id>" for a registration this wallet submitted, "From: node balance" for the node balance moved in) and the
    state of a row not confirmed; and the amount with its sign (incoming green, outgoing plain, to yourself blue, muted
    when nothing moved; none for a contract call, nor for a registration, activation or deploy the archive gives 0 for),
    written compactly by the app's rule (`compactAmount`: at most two decimals from 1,000, K/M/B/T from 100,000) in at
    most half the row, the exact figure in the detail.
    A token transfer this wallet sent reads "Sent" with the token's letter (the key `historyTokenTransfer` is gone). Rows
    are newest first under the header of their day (Today, Yesterday, the date in the UI language with its year when not
    this year, Earlier for a row with no time); each row's accessible name says what happened, the amount, who with, the
    state and when. The detail opens with the same icon and badge, larger. One transaction is one row: the archive's
    `NodeRegistration` row (from the wallet, `to: null`, amount 0) was left out by the worker, which took only rows with a
    `to` (the owner's screenshot of the app showed the same transaction as "Sent 0 QNC" beside "Node registered"); the
    worker now keeps it as `kind: 'node_registration'` (`to: ''`, confirmed by its hash), and History draws it as "Node
    registered", never as a transfer. A contract call or deploy names its contract ("Contract <id>"), and a send to the
    address that destroys what it receives (`core.destroysTokens`) reads "Burned", as the app's rows. 14 keys added in
    every language (`historyTo`, `historyFrom`, `historyNodeRegistered`, `historyNodeActivated`, `historyFromNode`,
    `historyFromNodeBalance`, `historyNode`, `historyNodeId`, `historyContractId`, `historyDeploy`, `historySwap`,
    `historyToday`, `historyYesterday`, `historyEarlier`), worded as the app's. Frozen files changed: none.

43. Owner command of 2026-10-06 (the audit of the uncommitted diff, extension items). (a) M-4, owner's choice: migrate.
    The store's 2.1.x wallets move into this version: the popup's first screen says the earlier wallet is here and opens
    setup, which offers "Unlock your earlier wallet" (its password with the
    backoff of unlock, then a new password: `vault.migrate`, section 5, Earlier version), "Use my recovery phrase instead"
    (Import) and "Create a new wallet"; the earlier keys go once the new vault was read back, or by `vault.removeEarlier`
    behind one confirmation (setup's last screen, Settings) once a vault exists; a wrong password removes nothing; the
    pages' copy 2.x kept in IndexedDB `QNetWallet` opens with the current password after a password change made in 2.x,
    and goes with the earlier keys; every page empties its own web storage at start (2.x kept a copy of its password
    there). The store release notes say so.
    (b) M-5: a token named after QNet's own coin is never drawn as if it were QNC: `listTokens` rows and History token
    rows carry `reserved` (`core.usesReservedName` on the symbol and name as deployed; a hidden or format character counts,
    the app's rule), a hidden or format character is shown as U+FFFD (`core.tokenLabel`), and the popup marks such a token
    with "⚠" before its symbol (Assets, the Send picker and amount label, History), shows the short contract id
    (`core.contractShortId`, as the app) under every token row, names each picker option "symbol · short contract", and
    adds the `apTokenReserved` danger notice to the token's History detail; the approval keeps the flag of the token as
    deployed. `tokenSafety.js` now takes its hidden-character rule from the app's `crypto/OffchainMessage.js`, which with
    `utils/solanaFormat.js` it imports joins the bundle's list of mobile sources. (c) L-13: the tokens of the wallet's own
    sends come first in `listTokens`; `complete` means no held token was left out, and the popup says "Some tokens are not
    shown" under Assets and the Send picker while it is false. (d) The recovery phrase and the private key show at once
    after the password, then Copy and Done: no press-and-hold, no account or address block, no clipboard text, no timer;
    the silent 60 s clipboard clear stays (this replaces decision 40 (f)'s press-and-hold and 45 s auto-hide). (e) The
    activation code moves from the Activate tab to Settings, beside the recovery phrase and the private key: one plain row,
    the code masked with Show and Copy (`activation.copy`, no password), no warning, no countdown; Copy copies at once and
    the clipboard is cleared after `TIMINGS.CLIPBOARD_CLEAR_MS` if nothing was copied since, silently; leaving Settings
    drops the code. The Activate tab after activation is the light node's record while the chain does not list it, the one
    line to aiqnet.io/node and a warning only when another burn is involved (decision 41 less its code panel); right after a
    burn it is the same, titled as the tab. (f) Lock in the header is a lock glyph in the header's text colour (a vector
    drawn through a CSS mask, as History's badges; the header's ghost size and padding) with "Lock" in the UI language as
    its tooltip and accessible label. (g) No field takes the cursor on its own (decision 40 (g)), the new screens included.
    Keys added in every language: `tokensNotAllShown`, `codeShow`, `earlierTitle`, `earlierLead`, `earlierRemoveButton`,
    `earlierRemoveWarn`, `earlierRemoveConfirm`, `earlierRemoved`, `setupEarlierTitle`, `setupEarlierLead`,
    `setupEarlierUnlock`, `setupEarlierUsePhrase`, `setupEarlierPasswordTitle`, `setupEarlierPasswordLead`,
    `setupEarlierChecking`, `setupEarlierUnreadable`, `setupEarlierMoveButton`; gone: `hidesIn`, `codeHold`, `codeUnlock`,
    `codeCopyWarnTitle`, `codeCopyWarn1`, `codeCopyWarn2`, `codeCopyWarnLight1`, `codeCopyWarnLight2`, `codeCopyWarn3`,
    `codeCopyConfirm`, `codeCopied`, `revealHold`, `revealHidden`, `revealExpired`, `revealAgain`, `exportHold`,
    `exportCopyWarn`, `exportExpired`; `activateRecordOther`, `apActivateShares_pending`, `apActivatePaidOnSite`,
    `apOutcome_pending` and `err_ACTIVATION_RECORDED` point to Settings for the code. Frozen files changed: `router.js`
    (`vault.migrate`, `vault.removeEarlier`), the export list of `ui/common.js` (`clearPageStorage`), `test/router.test.mjs`.
44. Owner command of 2026-10-07 (certified state proofs, the trust rule): every balance the wallet shows as verified or acts
    on is verified against the committee's certificate through the light client; never what nodes agree on, never one
    unverified node, never the figure on screen for a send. (a) Proofs: the account and token balance proofs are asked in
    their certified form, `GET /api/v1/account/{a}/balance/proof?mb=` and `GET /api/v1/token/{c}/{h}/balance/proof?mb=`
    (`latest`, or the newest macroblock this wallet verified while it is within 2 of the certified head read in the last
    minute, then `latest` when no node holds it; only `latest` for 10 minutes after the wallet's own transaction). The
    answer is read by the app's strict parse (`core.parseStrictJson`), capped at 64 KB, bound to the asked address
    (contract, holder), and its leaf rebuilt from every field (`core.readCertifiedAccount`, `readCertifiedToken`: the
    shared verifier compiled from the app's `crypto/SmtFold.js`, with the inclusion, absence and absence-in-bucket kinds);
    it folds to the state root of the macroblock it names as the light client verified it itself
    (`core.certifiedStateRootAt`, walking up to that index only), never to the root the node served; an index more than 2
    below or above the certified head is refused without a walk. The certified head (`core.certifiedHeadHint`) is the
    second highest `newest_certified_index` of at least three pinned nodes (`GET /api/v1/state/certified`; a node from
    before it reports `last_sealed_mb_index` of `/api/v1/debug/consensus-position`), cached a minute, never the applied
    tip; with fewer than three answers no proof is fresh. A body of the older shape (no `proof_format`, a boolean
    `proof_valid`, a numeric `block_height`, its proof arrays: `core.isLegacyProofBody`) marks its node old for 10 minutes
    (asked after the others, `core.markNodeOld`), and still counts when its live root is the certified root of the
    macroblock covering its height or one of the two before it (`core.certifiedStateRootIndex`), recent by the head (a
    height more than 2 macroblocks past the head is not walked to); its leaf takes every field it carries (a field it
    lacks is 0, as the app reads it); the older token body is `core.verifyLegacyTokenProof`. A typed rate limit (429, `{proof_format: 2, error: 'rate_limited'}`) is never taken for
    an old node, and a `Retry-After` puts its node last until then. Any answer without a verifiable proof is no answer: the
    next node is asked. An absence counts only with its proof; a 0 nothing verified is never shown. (b) There is no
    `agreement` tier: a balance is verified (`'proof'`) or not (`'none'`), and a send is never decided by one that is
    not. (c) The send rule (`qnet.transferSnapshot`, the app's `certifiedQncForSend` and `spendableFrom`): the certified
    base (a proof verified in the last 30 s is used again when its nonce is at least the nodes' nonce now, else one fresh
    verified read within `QC_VERIFY_BUDGET_MS`), and the account nonce the wallet's own transactions are counted up to:
    the highest nonce at least two pinned nodes report on `GET /api/v1/account/{a}` (by the nonce alone, as the app),
    never below the certified nonce nor the highest certified nonce
    this worker saw (without an agreement every own transaction above the certified nonce counts as pending). Every nonce
    in between must be one of this wallet's own known transactions (its kept transactions and `VaultState.spends`), else
    `BALANCE_FOREIGN_PENDING`: a transaction from another device is not confirmed yet; those took the most each could, the
    unconfirmed ones above it stay reserved, and anything received after the checkpoint never counts. The token side is
    section 4.9. (d) Messages, split as the app's: no node answered `NETWORK` ("The QNet nodes could not be reached. Try
    again."), `BALANCE_UNCONFIRMED` ("The balance is not confirmed yet. Try again in a minute."), `BALANCE_FOREIGN_PENDING`
    ("A transaction from another device is not confirmed yet. Try again in a minute."), in the popup's send and token
    review and in the approval window, which keeps a request open on either refusal and reads again; the Assets line
    under a balance not verified yet is "This balance is not confirmed yet." (e) The phrase warning before the password
    gains "Never enter them on a website and never share them." (the key's already says it). Keys added in every language:
    `err_BALANCE_UNCONFIRMED`, `err_BALANCE_FOREIGN_PENDING`; changed: `assetsUnverified`, `revealWarn`. Frozen files
    changed: `errors.js` (the two codes), `config.js` (`LIMITS.SPENDS_MAX`), `vault.js` (`spends`), the bundle's
    mobile sources (`utils/strictJson.js` joins them).

## 13. Languages (`ui/i18n`, `_locales`)

- UI languages: `config.SUPPORTED_LANGUAGES`, the mobile app's set (`en, zh-CN, ru, es, ko, ja, pt, fr, de,
  ar, it`); `RTL_LANGUAGES = ['ar']`. One module per language, `ui/i18n/<code>.js`, a frozen default export
  of key → text; `ui/i18n/index.js` loads one with a literal `import()` per language (so the load check
  sees every file) and names each language in itself (`LANGUAGE_NAMES`). English (`en.js`) is the
  source; every table has exactly its keys and `..` (checked).
- `common.loadLocale(code)` sets the table, `<html lang>` and `dir` (`rtl` for Arabic); a code outside the list
  or a table that fails to load means English. `t()` falls back to English for a missing key, which the
  tests forbid shipping. In a right-to-left language every substitution is wrapped in U+2068/U+2069, and
  addresses, codes, hashes, amounts and words are left-to-right isolates in CSS; inputs for addresses,
  amounts, words and phrases are `dir=ltr`.
- Never translated: the recovery phrase words, codes, addresses, hashes, the digits of amounts, QNet,
  Solana, 1DEV, QNC, SOL, SPL, Light, Super, aiqnet.io, `QNET_*` names, `DELETE` (checked).
- Pages: `popup`, `setup` and `approve` read `settings.get` at start (the approve window too) and set
  `document.title` from the table; Settings → Language is a `<select>` that stores the choice with
  `settings.set` and re-renders the popup.
- `_locales/<chrome locale>/messages.json` (`en, zh_CN, ru, es, ko, ja, pt_BR, pt_PT, fr, de, ar, it`) carry the
  manifest's `extName` and `extDescription` only (name at most 45, description at most 132 characters).
- The light node's texts say "record on the QNet network", "node balance" and "Move to wallet"; no text of the extension
  says mining, earn, reward or income. "Burn" and "activation code" stay: the extension is the desktop burn channel.
- Tests: `test/i18n.test.mjs` (languages equal the mobile app's, completeness, placeholder parity,
  tokens kept, the mobile terms for recovery phrase / activation code / node, error texts for every code,
  the manifest strings per locale, and a static scan of every string literal in `dist/ui` for text that
  does not come from a table). `scripts/overflow-check.mjs` renders every screen of the popup (360 px),
  the setup tab (360 and 800 px) and the approval window (400 and 360 px) in every language in headless
  Chrome and fails on any element whose content is wider or taller than its box (unless it scrolls), a
  placeholder or selected option wider than its field, a whole address on more than one line (the popup and the
  approval window at every width, the setup tab at 800 px), or a page error; `--mono 'Courier New'` renders the widest
  monospace advance and `--scrollbars` lets the scrollbars take their width.

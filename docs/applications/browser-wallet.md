# Browser wallet extension

This document describes the QNet Wallet browser extension in `applications/qnet-wallet`: a Manifest V3
extension for Chromium-based browsers (engine version 111 or later). From one
12- or 24-word recovery phrase it derives the same post-quantum QNet Blockchain account and the same Solana account as the
[mobile wallet](mobile-wallet.md). It keeps one encrypted vault in extension storage, signs QNC
transfers and transfers of the built-in tokens of QNet Blockchain it holds with ML-DSA-65, sends SOL and 1DEV, and is where a node's activation burn happens on a desktop; after
a Light burn it records the wallet's light node on QNet Blockchain. It never runs a node: a light node runs in QNet
Wallet on a phone or tablet linked from aiqnet.io, and a super node, which is activated only here, on the user's own server
with the QNet Blockchain node software. It can end the light node on whatever device runs it: the wallet key signs the node's
unbind when aiqnet.io's Device tab asks it. It also exposes a provider to aiqnet.io and games.aiqnet.io, so
that pages can connect to the wallet and ask for QNC transfers, built-in token transfers and contract calls, and, on
aiqnet.io itself, ask it to activate a node, to move the balance of the wallet's light or super node into the wallet
and to unlink the node's device. Its own popup offers no move of a node balance: aiqnet.io's My node asks for it, and
QNet Wallet's Node tab moves it too. Its windows speak the mobile wallet's eleven languages.

## Layout

| Path | Role |
| --- | --- |
| `dist/manifest.json` | Manifest V3 declaration of the store build |
| `dist/background/sw.js` | Service worker entry: registers every listener, then starts the session |
| `dist/background/router.js` | The only message entry: checks the sender and the exact shape of every message and every result |
| `dist/background/vault.js` | The encrypted vault in IndexedDB, and next to it the light client's anchors and the chain cache (both with a MAC of the vault key) and the genesis capsule the light client holds |
| `dist/background/session.js` | Unlock, lock, auto-lock, password backoff, the popup's view cache of the session and the balances kept across sessions |
| `dist/background/keys.js` | Per-operation key derivation and signing, the password-gated private key export |
| `dist/background/qnet.js` | QNet Blockchain node requests, the balance and nonce at a node's live tip and their certified check, QNC transfers, the wallet's built-in tokens and their transfers (the popup's and a site's), contract calls, history, the chain the wallet follows, the requests to aiqnet.io's record of burns |
| `dist/background/solana.js` | Solana RPC, SOL and 1DEV transfers, the Solana history, the burn transaction and the burn matcher |
| `dist/background/activation.js` | Activation price, the burn, the activation code, Recover, and aiqnet.io's record of the wallet's burn (its reservation, the proof, the sync) |
| `dist/background/nodes.js` | The wallet's nodes on QNet Blockchain: the light node's registration after the burn, the move of the balance of the light or super node aiqnet.io names, and the unlink of the light node's device |
| `dist/background/provider.js` | Site grants, the approval queue, provider methods and events |
| `dist/background/config.js`, `amount.js`, `errors.js`, `events.js`, `log.js` | Build constants of the release channel, integer amount parsing, fixed error codes, notices to open pages, the logger (silent in the store build) |
| `dist/content/relay.js` | Content script (isolated world) between the page and the service worker |
| `dist/inject/provider.js` | Content script in the page's world: the provider object |
| `dist/ui/popup.*`, `setup.*`, `approve.*` | The popup, the setup tab and the approval window |
| `dist/ui/common.js`, `kit.js`, `qr.js` | Safe DOM helpers and the language switch, UI components, the local QR encoder |
| `dist/ui/i18n/` | The texts of every page in each language (`en.js` is the source) and the loader |
| `dist/lib/qnet-core.js` | The crypto bundle, built by `tools/crypto-bundle` |
| `dist/_locales/`, `dist/icons/` | Extension name and description in each browser locale, icons |
| `tools/crypto-bundle/` | esbuild project that builds `dist/lib/qnet-core.js` from pinned packages |
| `scripts/` | Development build, store package, and the load check they share |
| `test/` | Offline test suite (`npm test`) and read-only network checks (`npm run test:live`) |

Every file is UTF-8 with LF line endings. The service worker and the pages are ES modules; the two
content scripts are classic scripts. `applications/qnet-wallet/CONTRACTS.md` is the agreement between
the modules: message types and their parameters, result shapes, the provider protocol, the vault
format and the storage keys.

## Build, test and package

```bash
cd applications/qnet-wallet
npm run bundle:install   # npm ci in tools/crypto-bundle (exact versions, lockfile)
npm run build            # dist/lib/qnet-core.js
npm test                 # offline tests
npm run test:live        # read-only checks against Solana devnet and the QNet Blockchain nodes
npm run build:dev        # dist-dev/: dist/ with the development overlay (git-ignored)
npm run package          # qnet-wallet-<version>.zip: the store package
npm run check:overflow   # every screen in every language in headless Chrome (needs Chrome)
```

`dist/` is the extension itself and loads unpacked as it is.

- **Crypto bundle.** `tools/crypto-bundle` compiles one ES module, `dist/lib/qnet-core.js`. Its
  sources are `@noble/post-quantum` (ML-DSA-65), `@noble/hashes` (SHA-2, SHA-3, SHAKE, HMAC,
  PBKDF2, BLAKE3), `hash-wasm` (Argon2id, as WebAssembly), `@noble/curves` (Ed25519), `@scure/bip39`
  and `@scure/base`, all at exact versions from the bundle's lockfile. It also compiles
  the mobile app's `WalletIdentity`, `TxBuilders`, `NodePreimages`, `PasswordStrength`,
  `QcLightClient`, `SmtFold`, `fees`, `genesisConsensus`, `tokenSafety` (with the `OffchainMessage` and `solanaFormat`
  modules it imports), `boundedFetch`, `strictJson`, `amountFormat`, `sendAmount` and `textEdit` modules straight from
  `applications/qnet-mobile/src`, so both apps share one derivation, one set of
  transaction builders, one set of light node messages, one password policy, one fee table and one way of writing and
  reading amounts; the packages those modules import (`js-sha3`, `buffer`) come from the same lockfile, and their
  `DilithiumCrypto` import is replaced by a shim over `@noble/post-quantum`. The build refuses any other mobile module and any output that contains a cleartext URL,
  `eval`, `new Function`, an HTML sink or a console call. The test suite rebuilds the bundle and
  requires it to be byte-identical to the shipped file.
- **Development build.** `npm run build:dev` copies the extension to `dist-dev/`. It adds
  `http://localhost/*` and `http://127.0.0.1/*` to both content-script entries, names the extension
  "QNet Wallet (dev)" and turns on the logger. The store manifest never carries these.
- **Store package.** `npm run package` first checks that `dist/` loads (see below), then writes a
  deterministic zip of exactly the shipped files: sorted entries and fixed timestamps, so the same
  `dist/` always gives the same bytes.
- **Load check.** `scripts/extension.mjs` checks every file the manifest names (service worker, popup,
  icons, content scripts, locale) and every file the pages reference. Each must exist and be shipped.
  Every module import must resolve to a shipped file, and the content scripts must stay classic
  scripts. Every shipped script and stylesheet must actually be loaded. For the store build,
  `DEV_BUILD` must be off.

The offline suite also runs the whole extension in one process: the real service worker with all its
modules and the real pages on a small DOM. The network is scripted and verifies every ML-DSA-65 and
Ed25519 signature the wallet produces. The run goes from setup through sends, the activation burn and
the dApp approvals to lock and delete. Static checks cover every shipped file: no `innerHTML`,
`eval`, `new Function`, string timers, cleartext URLs or raw console calls, and the manifest has no
`<all_urls>` and no web-accessible resources.

## Manifest

- `permissions`: `storage`, `alarms`, `idle`. No other permission.
- `host_permissions`: `https://node1.aiqnet.io/*` … `https://node5.aiqnet.io/*`,
  `https://aiqnet.io/*` (the explorer archive, aiqnet.io's record of wallet burns, and the tabs of aiqnet.io an event
  reaches when their port is closed) and the Solana RPC of the release channel (`https://api.devnet.solana.com/*`
  in the testnet build).
- Content security policy for extension pages: `default-src 'self'; script-src 'self'
  'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:`, `connect-src` limited to the origins
  above, and `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
  `'wasm-unsafe-eval'` is there only for the WebAssembly Argon2id of the vault key; no page or worker
  evaluates script text. Every page refuses to run inside a frame.
- Two content scripts, top frame only, at `document_start`, on `https://aiqnet.io/*` and
  `https://games.aiqnet.io/*` and on no other site (`www.aiqnet.io` and `explorer.aiqnet.io` only redirect to `aiqnet.io`, so no page there gets a
  provider). `inject/provider.js` runs in the page's world. `content/relay.js` runs in the isolated world.
- No `web_accessible_resources`: no extension file can be loaded or framed by a web page.

The release channel fixes every endpoint and the Solana cluster at build time
(`dist/background/config.js`). The testnet build uses Solana devnet and the 1DEV mint
`62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ` (6 decimals). None of this is a user setting.

## Identity and derivation

1. The recovery phrase is canonicalized: NFKD, lowercase, surrounding whitespace removed, words
   separated by single spaces. It is checked against the standard English 2048-word list and the
   phrase's checksum. 12 and 24 words are accepted. The vault stores the phrase's entropy, not the typed
   text.
2. Seed: `PBKDF2-HMAC-SHA512(phrase, "mnemonic", 2048 iterations, 64 bytes)`.
3. QNet Blockchain: the ML-DSA-65 (FIPS 204) keypair from the wallet seed of `WalletIdentity`
   (`SHAKE-256("QNET_WALLET_MLDSA65_v1:" + hex(seed))`, 32 bytes). The public key is 1952 bytes and a
   signature 3309 bytes. The EON address comes from the public key with its SHA3-256 checksum.
4. Solana: hardened Ed25519 key derivation at `m/44'/501'/0'/0'`.
5. Private key export (Settings → Private key): the account, one warning and the wallet password, then the key of that
   account at once in its compact form, with Copy and Done, as the recovery phrase (no press-and-hold, no timer, the
   same silent clipboard clearing). QNet Blockchain: the 32-byte ML-DSA-65 KeyGen seed of step 3 as 64 lowercase hex characters (the key pair, and so the
   address, follows from it alone; the 4032-byte expanded secret key is never exported). Solana: the 64-byte secret key
   (the Ed25519 private seed, then the public key) in base58, the form Solana tools take. The service worker derives the
   key pair, checks it against the unlocked wallet's address, and hands out the key once; nothing of it is logged or
   kept. The extension cannot import a wallet from a private key: only a recovery phrase creates one.

The phrase `abandon abandon … abandon about` gives the QNet Blockchain address
`d9fa370374e24333242eon847d1d354dcd87fe873823e` and the Solana address
`HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk`. The mobile wallet and the node derive the same
values from the canonical text only: the lowercase words separated by single spaces. The mobile wallet
canonicalizes an imported phrase exactly as the extension does (NFKD, lowercase, single spaces, nothing
around it), so a phrase typed with capitals, extra spaces or line breaks is the same wallet in both apps.
The node derives its keys from `QNET_WALLET_SEED` or the file of `QNET_WALLET_SEED_FILE` as written,
trimmed at both ends and NFKD-normalized, without the wordlist or checksum check, so any other spelling
there is silently another wallet. The crypto bundle carries a self-test: derivation, ML-DSA-65 sign and verify, Ed25519 sign
and verify, and the activation-code vector. When the service worker starts it runs the test, unless a
pass is already recorded in `chrome.storage.session` for this browser session and for these exact
bundle bytes (the bundle version and the SHA-256 of `lib/qnet-core.js`); a pass is recorded, a failure
never is. If the test fails, every signing path refuses with `SIGNING_DISABLED` for the worker's
lifetime, and the next worker start runs it again.

## Vault and session

- **Vault.** One record in the extension's IndexedDB database `qnet-vault-v3`. It is encrypted with
  AES-256-GCM under a fresh 12-byte IV on every write. The key comes from Argon2id (64 MiB, 3
  passes, 1 lane) over the NFKC-normalized password, with a fresh 16-byte salt on every password set
  or change. The KDF parameters are stored in the record, and every unlock refuses parameters below
  that floor. The associated data binds the format version, the KDF parameters, a random wallet id, both
  addresses, the creation time and the node type of the stored activation. The record's associated data is
  stored in the clear: the encryption authenticates it but does not hide it, so the profile shows those
  addresses without the password. The plaintext holds the entropy and the wallet state: the activation
  record, a pending burn, this device's own burn that another device's older burn beat (see Activate),
  the signed transactions the chain has not decided yet and those it took until the archive lists them, the most each
  recent transaction can take by nonce (see The send rule), the known recipients, the light node's registration record,
  and the auto-lock setting.
- **Password.** At least 8 characters, typed twice; nothing else is checked. It is never stored in any form: a successful decryption is
  the only check. Every password check (unlock, reveal, change password, delete) shares one backoff. The first three failures are free; after that the delay starts
  at 1 second and doubles up to 5 minutes.
- **Unlock** always decrypts, re-derives both addresses and compares them with the associated data.
  The service worker then keeps only the 32-byte vault key and the public addresses. It mirrors them
  to `chrome.storage.session` with access restricted to trusted contexts, so a restarted worker stays
  unlocked until the lock deadline.
- **Lock.** The auto-lock is 5, 15 (default), 30 or 60 minutes, or Never, and runs on `chrome.alarms`. Only
  actions extend it, never reads. Never sets no inactivity timer. Whatever the choice, the wallet also locks when
  the browser starts or closes, when the screen locks, and on the Lock button. Locking clears the key from memory and from session storage; open
  pages clear their fields, and the popup shows the lock screen.
- **Keys.** Private keys are derived for one operation, used, and overwritten with zeros. No page
  ever holds a private key, the entropy or the vault key.
- **First open.** With no wallet in the browser, the popup shows two buttons, **Create a new wallet** and **Import an
  existing wallet**. Each opens setup in its own tab straight at that step (`ui/setup.html?flow=create` or
  `?flow=import`), with no choice screen first; setup opened without a step starts at its choice of the two.
- **Setup** runs in its own tab and refuses to create or import while a wallet exists. Create shows
  12 new words for writing down, behind Show the words, with one line above them: anyone with the words
  controls the wallet. Three words at random positions must then be typed back.
  Import takes the 12 or 24 words and a password, nothing else; it accepts any spacing and capitalization and
  canonicalizes it, as the mobile wallet does (see Identity and derivation). The tab reports success only
  after the vault has been written, read back, decrypted with the new password and its addresses re-derived.
  The success screen shows both addresses and stays until the user presses Done, which closes the tab; no timer
  closes it. There is no download of the phrase.
- **A wallet of the earlier version.** The store's 2.1.x kept its wallet, encrypted with its password (PBKDF2-SHA256 and
  AES-GCM), in the extension's `chrome.storage.local`, and a second copy of its recovery phrase in the extension's
  IndexedDB; it updates into this version under the same store item. Its password change re-encrypted only the second
  copy, so the worker tries both: the current password and the first one both work. While
  that wallet is in the browser, the popup's first screen says so and opens setup, which first offers **Unlock your
  earlier wallet**, **Use my recovery phrase instead** and **Create a new wallet**. Unlock asks for the earlier password (with the same backoff as unlock; a wrong password
  removes nothing), then a new password: the worker takes only the wallet's recovery phrase, never the keys stored beside
  it, and writes this version's vault from it as Import does (the same addresses, Argon2id under the new password). The
  earlier copies are removed only after the new vault has been written and read back. With the recovery phrase instead
  (or a new wallet) the earlier copies stay until the user removes them: setup's last screen and Settings offer to, behind one
  confirmation that says the earlier wallet then opens only with its own recovery phrase. A copy of the earlier
  password and addresses that 2.x kept in the pages' own storage is removed as soon as any page of this version opens.
- **Reveal** of the phrase shows one warning line ("Anyone with these words controls your funds and your node activation.
  Never enter them on a website and never share them.") and asks for the password again; the words then show at once,
  with Copy and Done: no press-and-hold, no timer, no clipboard text. They leave the page with the screen (Done, another tab,
  a lock, the popup closing).
- **Copying the phrase.** The words cannot be selected, copied or dragged out of setup's word grid. Both screens that
  show them have a **Copy** button that copies only on an explicit click; on the setup screen the warning next to it
  says that anyone who can read the clipboard can take the wallet and that the clipboard is cleared in 60 seconds if the
  page stays open, and Settings clears it the same way without a text. The copy is the canonical words on one line. After 60 seconds the page empties the clipboard if nothing was
  copied from it since (a page without the focus then does it as soon as it has the focus again); setup also
  empties it when the wallet is set up, since the user may close the tab right after, and deleting or resetting the
  wallet empties it at once when it still holds a copy the popup made and has yet to clear (an activation code, the
  phrase or a private key); anything else on the clipboard stays, such as a phrase about to be imported after a reset.
  A page cannot read the clipboard, and a closed page cannot clear it: the popup closes as soon as the user clicks
  elsewhere.
- **Delete** needs the word `DELETE` typed and the password; Enter in the password field deletes as the button does,
  and a wrong password empties only the password field, so the typed `DELETE` stays. It deletes the vault database,
  clears `chrome.storage.local` (all but the chosen interface language, which holds no wallet data) and
  `chrome.storage.session`, takes the popup's own pending copy off the clipboard, disconnects every site, and the open
  pages reload.
- **Forgot password.** The lock screen offers "Forgot password?", which opens one screen, Reset wallet: the extension
  cannot recover the password, and setting a new one takes a reset; one danger warning says that the reset removes the
  wallet from this browser and that only its recovery phrase brings it back. It asks for no recovery phrase, no
  password and no typed word: Back returns to the lock screen, and **Reset wallet** erases the locked wallet, as
  Delete erases it (the vault database, `chrome.storage.local` but the interface language and
  `chrome.storage.session`, the earlier version's copies, the password backoff; every site is disconnected), whatever
  the stored record holds. The press first asks
  the service worker for a one-time token, bound to that popup and valid for one minute, then sends the reset with it
  and a fixed confirmation; only the popup may send either request, and no site, content script or other extension
  page can. The service worker resets only a locked wallet: one unlocked meanwhile (by an unlock that finished first,
  here or in another window) stays, and the popup opens it; "Forgot password?" is unavailable while an unlock runs.
  After a reset the popup shows its first screen, and the ordinary Import with the recovery phrase brings the wallet
  back at the same addresses under a new password (Recover finds an activation burn again).
Storage outside the vault's ciphertext. In the vault database, next to the record: the record's
associated data in the clear (see Vault above); the kept burn searches of the wallet's Solana address and
the light client's verified anchors (each with its certified roots, under the build's chain identity), public chain
data, each with an HMAC under a key derived from the vault key; and the genesis capsule the light client holds (see QNet Blockchain below), public chain data with no MAC, which is
verified again in full before it is used. A new record that the Forgot-password restore of versions 3.0.0 and 3.1.0 staged next to the old one, and left
when that version's service worker stopped in the middle, is deleted at the next start of the service worker or at
unlock. `chrome.storage.local` holds
the site grants (each carrying a MAC, see below) and the chosen language (a display preference only); a wallet of the
earlier version stays there (and its second copy in its own IndexedDB database), untouched, until it is moved or
removed; Delete wallet removes it too (see Vault and session).
`chrome.storage.session`, which the browser keeps in memory only, holds the unlocked session, the
password backoff counter, the self-test pass, the per-site approval cooldowns, the popup's view cache (gone with every
lock), and the light client's hints (the certified head it saw last
and until when no node is asked for a capsule), so that a service worker woken from sleep goes on from there. The extension pages keep
nothing in `localStorage` or `sessionStorage`, and empty both when they open. Nothing else is stored; `CONTRACTS.md` section 7 is the full
map.

## Messaging

Extension pages talk to the service worker only through `runtime.sendMessage({type, id, params})`.
The router serves a message only when its sender is one of this extension's three pages in a top
frame. Content scripts, other extensions and web pages are refused before parsing. Each type lists
the pages allowed to send it and the exact parameters it takes, with their types, lengths and
formats; unknown keys are refused. Types that need an unlocked wallet check the session first.
Before a result leaves the worker, the router checks that it is plain JSON data without a secret
field (`mnemonic`, `phrase`, `entropy`, `seed`, keys, passwords, `code` and the like, at any
depth). The only exceptions (`RESULT_KEY_EXCEPTIONS` and `PROVIDER_RESULT_KEY_EXCEPTIONS` in
`router.js`):

- `vault.reveal`: the recovery phrase, after the password (`vault.migrate`, which moves a wallet of the earlier version,
  answers only addresses; `vault.removeEarlier` removes what that version left, once confirmed);
- `vault.exportKey`: the private key of one account (QNet Blockchain or Solana), after the password;
- `activation.burn` and `activation.copy`: the activation code right after a burn (the popup does not draw it), or when
  the user asks to show or copy it in Settings;
- for a page, `qnet_activateNode`: the activation code in its result (see Activate from aiqnet.io);
- for a page, `qnet_getActivation`: the activation code the extension knows (see The wallet's activation for aiqnet.io).

Errors carry a fixed code and message, never the thrown text.

## QNet Blockchain

- **Nodes.** Requests go only to `https://node1.aiqnet.io` … `https://node5.aiqnet.io`. One node is
  asked first; a second joins after 700 ms of silence, and the first answer wins. A 5xx or 429 answer
  moves on to the next node. Balances, nonces and amounts are read from the raw JSON text, never
  through a floating-point number.
- **Balance and nonce.** The balance, incoming funds and every send check act at once on a pinned node's answer; the
  committee check runs in the background and never holds what the user does or sees, and the network refuses what is
  invalid. The live figure is `/api/v1/account/{address}/balance/proof` without `mb`: the node's live state and a proof
  of the account under its root, read strictly (a repeated key refuses it, at most 64 KB), the account leaf rebuilt from
  every field and folded to the root that node served, with that node's height. It shows at once with no line under it;
  a figure of a lower height than the one shown last (a node behind answering after one ahead) never takes its place.
  An account at least two pinned nodes answer they hold none of (a new wallet: no proof can show an absence there) shows
  0 at once, but only while the wallet knows no nonce of it above 0 taken: a node gives the same answer when it fails to
  read the account, so for an account the chain took a nonce of, that answer is no figure. Beside it the wallet asks
  the certified form, `…/balance/proof?mb=…`: the node names a committee-certified
  macroblock and proves the account (included, or absent from its bucket) under that macroblock's state root, and the
  wallet folds it to the state root of that macroblock as its own light client verified it (the committee's ML-DSA-65
  certificate, walked to that index only, from the release's pin, the macroblocks it verified before, kept with their
  certified roots so that they answer at their own index, or the genesis capsule below), never to the root the node
  served. The macroblock must be within 2 of the certified head, below or above it: the second highest newest certified
  index of at least three nodes (`/api/v1/state/certified`), cached a minute, never the height a node has applied. It
  asks `latest`, or first the newest macroblock it verified while that is in the window of the head it saw in the last
  minute (with no head seen: while that macroblock's checkpoint is at most 4 minutes old; no new certificate check), and
  only `latest` for 10 minutes after its own send. A node from before certified proofs answers with its live-root proof:
  that node is asked after the others for 10 minutes, and its proof counts only when its root is the certified root of
  the macroblock covering its height or one of the two before it. A rate limit, an error, another shape or a root not
  certified is no answer: the next node is asked, and one that asks for a wait (`Retry-After`) is asked last until then.
  The certified figure is waited for only when no live figure came, and takes the live figure's place only once verified
  at a state of its height or newer. With no live figure, a certified figure not verified yet shows with the line "This
  balance is not confirmed yet." and is never kept; a 0 nothing verified is never shown. While a long walk (more than 2
  steps to a macroblock that can stand) is why, that line and the error read "Checking the balance against QNet
  Blockchain: N steps left." instead. The screens show the balance only, not how it was verified.
- **Genesis capsule.** Before a walk of more than 16 steps (a fresh install, or a wallet long closed) the wallet asks the
  pinned nodes for the genesis capsule (`GET /api/v1/galc/capsule`, [GALC capsule v2](../protocols/galc-capsule-v2.md)): a
  macroblock signed by at least 4 of the 5 genesis keys built into the extension, for this network only, which roots the
  walk as the pin does once nodes serve the proofs of it and of the macroblock before it. A walk from the wallet's own
  macroblocks of at most 16 steps is taken instead, and a capsule naming another checkpoint than one verified here is
  refused or dropped. A capsule taken is kept next to the vault and verified again in full before a new service worker
  uses it. A node without one (today's nodes answer 405) is not asked again for 10 minutes, also by a service worker woken from sleep;
  without a capsule the walk goes on from the pin and the kept macroblocks.
- **Read speed.** A proof is read from one node, a second joining after 700 ms of silence. The certified read waits for
  its certificate check at most 1.5 seconds once a figure is read; the walk goes on in the background and the next read
  takes the proof from what it verified. A figure that waits only for a long walk ends the read, since every other node's
  proof waits for the same walk.
- **Follow.** While the wallet is unlocked an alarm (`qnet-follow`, every 30 seconds) keeps a verified macroblock at the
  certified head: each tick walks at most 16 steps toward it on one parity (both newest macroblocks for 10 minutes after
  the wallet's own send) and keeps what it verified, so the background checks (the balance's certified figure, a
  recipient's certified leaf) find it verified. It reads no balance. Locking stops it.
- **The send rule.** A send is decided on one live read of the wallet's account, never on a committee check: every
  transaction of the wallet at or below that figure's nonce is in its balance already, those above it that may still
  apply stay reserved (at each nonce the largest amount plus fee), and the nonce comes after both; what arrived counts at
  once, and the network refuses what the figure does not cover. A node a block or more behind may answer first, so the
  wallet keeps a floor: the highest nonce it knows the chain took (the nonce at least two nodes report alike for
  `/api/v1/account/{address}` or a certified read gave, the transactions it found the chain past, and its settled spend
  records). A figure below the floor does not end the read: the next node is asked, and the highest figure kept. One still
  below it has what the wallet's own transactions between its nonce and the floor took come off its balance, the most
  each could; the vault keeps that by nonce from the signing until an hour after the chain took it. No answer at all
  refuses the send with "QNet Blockchain could not be reached. Try again."; no proof of the account with "The balance is
  not confirmed yet. Try again in a minute."
- **Transfer.** The amount is entered in QNC and converted to nano-QNC as an integer. The recipient
  is an EON address with a valid checksum. Gas price (10) and gas limit (10,000) are fixed by the
  wallet, so the fee is 0.00015 QNC. The review screen shows sender, recipient, amount, fee, total,
  nonce and network. It also warns about the wallet's own address,
  a look-alike of a recent counterparty and a first-time recipient. The form's button is **Send**: while the review is
  read it stays busy over the line "Checking your balance on QNet Blockchain…", and the review's own button, **Confirm**,
  sends. A review that finishes after its form was left is kept and drawn the next time the Send tab opens on QNet
  Blockchain, with a short notice that it is ready; a newer review replaces it. When the Send tab opens it starts reading
  the certified head, and once a whole recipient address is typed that recipient's certified account leaf and the
  archive page the recipient warnings read (which a review reuses for 30 seconds). A recipient that is a contract
  account gets no review and is never signed for, since nothing can move what reaches one. The review decides it at
  once, beside its live read of the balance, by what at least two pinned nodes report of the address at their live
  state (`/api/v1/token/{address}`: a built-in token, another contract, or none), one read with the normal node timeout;
  an address no two nodes agree on is not signed for either ("The wallet could not check whether this address is a
  contract."). The recipient's certified account leaf (`is_contract`, its account proof folded to a verified certified
  root as a balance is) is read in the background only, one read at a time per address, and never holds a review; once
  it proves a contract, every later review and send to that address is refused at once. The signature is ML-DSA-65 over
  the node's preimage `q1337|transfer:{from}:{to}:{amountNano}:{nonce}:{gasPrice}:{gasLimit}`,
  checked against the public key before anything is sent. The body goes to `/api/v1/transaction`
  with the fields in the mobile wallet's order and the public key included. The sent screen (of a token transfer too)
  says Sent, with the nonce and "Waiting for QNet Blockchain to put it in a block…", and asks where the transaction
  stands by the nonce at least two nodes report live: every 2 seconds for the first 10 seconds, every 5 seconds to the
  first minute, then every 10 seconds, five minutes in all. It turns Confirmed once two pinned nodes list the transaction
  at its nonce, or says that another transaction took the nonce; Done opens History, which lists it at once.
- **Tokens.** Assets lists, after QNC, the built-in QRC-20 tokens the wallet holds: the contracts two nodes list for it
  (`/api/v1/account/{address}/tokens`, both lists together, kept a minute), each read again: what it is, as two nodes say
  alike (`/api/v1/token/{contract}`: a QRC-20 token with at most 18 decimals, else left out), and the wallet's balance in it
  at a node's live tip (`/api/v1/token/{contract}/{address}/balance/proof` without `mb`: the contract account under the
  root that node served, the holder's entry under the storage root that account commits to), with the certified
  two-level proof (`?mb=…`, folded to a committee-certified state root as the account's) read beside it, one per token
  at a time that a refresh joins (its walk can outlast the 15-second refresh), which stands in
  when no live figure comes and takes its place only when verified at a state of its height or newer; a zero balance is
  left out, one neither gives shows a dash). A token of a send of
  this wallet that History still lists stays, also at zero (all of it sent), so History names that send's token and
  amount. Every read of a token is hedged: a node that fails, and every 700 ms of silence, brings in the next, so a silent
  node never holds it. The balance is drawn as soon as it is read, the token rows when they are.
  At most 20 tokens; the tokens of the wallet's own unconfirmed sends come first, so tokens sent to the wallet unasked
  can never push them out, and while the list leaves held tokens out Assets and the Send picker say "Some tokens are not
  shown". A token has no image of its own: its row shows the first character of its symbol, and every token row shows
  the token's short contract id (the first six and last four characters, as in the mobile wallet) under its name.
  Anyone can deploy a token and name it after QNC: a token whose symbol or name is QNC or QNet in any spelling a reader takes for it (QNC, QNet, look-alike letters of other scripts, small capitals, letterlike symbols, letters in a filled
  circle or square, full-width forms, accented letters; the look-alikes are read as Latin letters before NFKD and again
  after it, so a letter NFKD changes, such as the lunate sigma, is still caught, and accents are dropped), or holds a
  hidden or format character such as a direction override, is marked with "⚠" before its symbol in Assets, the Send picker and History, and its History detail
  says that it is not QNC. Such a character is shown as U+FFFD wherever the token's name or symbol is drawn, so it can
  neither reorder nor hide anything, by the mobile wallet's own rule. The QNet Blockchain send form, titled Send on QNet Blockchain, has an
  Asset picker with QNC and these tokens, each named by its symbol and short contract id; the amount and what is
  available follow the asset. A token goes by the path and checks of a site's token transfer: the amount in the token's decimals (two
  nodes agreeing) as base units, the shared builder's call, its gas and the most it can cost as the fee in QNC, the
  refundable storage deposit for a recipient that does not hold the token yet, a recipient that is a contract refused.
  The review shows from, to, the token and its contract, the amount, the fee, the deposit, the QNC total, the token
  balance and the nonce, and warns about a token named after QNC, a burn address, earlier transactions not confirmed yet,
  the transaction it takes the place of and the recipient as for QNC; Confirm stays off while either balance does not cover
  it or the token balance could not be had (the review says why), and arms after 1.5 seconds. The token balance a send is
  decided by is the live one, from a block at or past the QNC figure the send rule used where a node has one, less what
  the wallet's own token transfers took after that figure's nonce up to the floor and may still move above it; after a
  contract call of the wallet (which may move tokens by an amount not known here) a token send waits, "not confirmed
  yet", until a figure past the call is read. It is signed, kept and
  resent like a site's.
- **Identity of a transfer.** A transfer is `(from, nonce)`: at most one transaction of an address applies
  at a nonce. Its hash is not its identity: the node that receives a transfer stamps its own copy with the
  time and hashes that, and the wallet sends to a second node when the first is slow, so another copy with
  another hash may be the one that lands.
- **Pending transfers.** The exact body is stored in the vault before the first submission; up to 16
  can be pending at once, one place kept free for a replace. The next nonce accounts for them, and their
  amounts stay reserved: at each nonce the largest amount plus fee, since only one transaction can apply
  there; a site's token transfers and contract calls are kept, resent and decided the same way. They are
  resent byte for byte, never re-signed, after unlock, when the history opens and when a sent screen finds one decided: at most
  every 30 seconds while no node has accepted the body, every 10 minutes once one has (each accepting node
  adds a copy of its own), and not after one hour, when a transfer shows as stale but stays listed and
  reserved until the chain decides it. A transfer that the only node it was sent to refused stays listed
  and reserved as refused: one node's refusal is not the chain's, and that node may have passed it on. The
  wallet never resends it, the send's error says it may still apply, and the next transfer takes its nonce
  by default, so the two can never both be paid. Once the nonce at least two nodes report alike passes a
  transfer's nonce, the row that two pinned nodes list alike at that nonce decides it: this transfer is confirmed and
  stays listed, Confirmed, until the archive lists its row, an hour at most. That row is the one with the hash those
  nodes list, of its kind first (a transfer, a token transfer's token row, a call; a token transfer that failed when
  applied wrote no event and has only its call's row); only when they list it under different hashes, one of its kind
  with its recipient and amount (and token) sent after it was signed whose hash no kept transaction holds.
  Each archive row stands for one transaction at most, so two equal payments a minute apart stay two rows while the
  archive lists only the first. The archive's row then reads Confirmed, and the kept record leaves once the nodes'
  listing (or the token row's proof) confirms that row too, so it never reads Unverified after Confirmed; another
  transaction replaced it; without such a row (or when a node lists two
  transactions at that nonce) its outcome stays unknown until a later check decides it, and leaves the list a day
  after it was seen so.
- **Dropped transfers.** A transfer the wallet no longer sends (stale, or refused by the only node sent it) whose nonce
  the chain's nonce last read shows still free, past the node's mempool lifetime after it last went out (30 minutes plus a 5-minute
  margin, the mobile wallet's rule), is held by no node: it did not go through and never will by itself. History shows it
  as Not found, the next transfer takes its nonce by default (so it does not hold every later send behind it) and its
  amount is no longer kept back, and it leaves the list a day after it was dropped. A pending row so resolves within
  about an hour and a half of its last send.
- **History.** Pages of `https://aiqnet.io/api/address/{address}/history` and this wallet's transfers not decided yet or
  taken by the chain and not in the archive yet,
  newest first under the header of their day (Today, Yesterday, then the date in the UI language, with its year when it
  is not this year; Earlier for a row with no time), under the title History and, when there are none, "No transactions
  yet". The archive's rows of built-in QRC-20 tokens are listed too, with the token and the amount in its units as the
  archive names them. A token row this wallet sent is confirmed at once when two pinned nodes list its contract call (a
  node lists a call only under the address that sent it). Every token row's own logs proof (`/api/v1/logs/proof`) is
  checked in the background and confirms any token row, a received one too: the event leaf the wallet builds from the
  row's own fields (its transaction, log index, contract and transfer event) must be the leaf the node proves, fold to
  its block's root and that to the window's logs root, and that root must be the one the committee certified for the
  macroblock closing the window; the event is written only when the transfer applied. One read starts at most 8 such
  checks, each only when its macroblock is at most 4 walk steps away, waits for none of them and shows their verdicts
  from the next read on; a row whose proof is another row's or folds to another root stays unverified for good, whatever
  the nodes list. Each row is one
  transaction, laid out and worded as the mobile wallet's History: the asset's icon (QNC, the token's letter for a
  built-in token) with a small round badge of what happened at its lower corner, a disc in the amount's colour with a
  dark glyph (sent: an arrow up and out, white; received: an arrow down, green; to yourself: a loop, swap: two arrows,
  node: a hexagon, all three blue; contract: code brackets, grey; burn: a flame, amber; a white cross on red when
  nothing moved), what happened ("Sent", "Received", "Sent to self", "Moved from node" for the node balance moved into
  the wallet, "Node registered", "Node activated", "Contract call", "Contract deployed", "Swap", "Burned" for a send to
  the address that destroys what it receives) over who it was with ("To:" or "From:" and the first and last six
  characters of the address; "Node" and its id for the light node registration this wallet submitted; "From: node
  balance"; "Contract" and its id for a contract call or deploy; nothing for a transfer to yourself), and the amount
  with its sign (incoming green, outgoing plain, to yourself blue, muted when nothing moved; none for a contract call,
  nor for a registration or deploy that moves no QNC), written compactly in the language's marks by the mobile wallet's rule (grouped below
  100,000 with at most two decimals from 1,000, four from 1 and eight below 1; K, M, B, T from 100,000 with at most two;
  powers of ten from 10^18) and its exact figure in the detail. The archive gives a node registration no recipient: it
  is one "Node registered" row, never a transfer of 0 QNC, confirmed when two pinned nodes list a registration with its
  hash. A row's detail says its state: Confirmed when two pinned nodes list it alike (a token row: its call, when this
  wallet sent it, or its logs proof verifies), Failed when another transaction took its nonce, Not found for a dropped
  transfer, Unverified for an archive row no two pinned nodes list (older than what they keep, or not on the chain they
  serve; a received token row not proven yet; a token row its proof contradicts),
  and Pending for every state that may still apply (unconfirmed, no longer
  resent, refused by a node, outcome unknown); the row itself says it after who it was with only while it is not
  confirmed. Each row's
  accessible name says what happened, the amount, who with, the state and when. Every pinned node's history is asked at
  once, and the read ends when all answered or 700 ms after the second answer, so a silent node does not hold the list.
  The list has no text on where it comes from. Two nodes listing a row says it is in a block, not that it applied: only
  the balance shows what arrived. History lists the network the switch shows, QNet Blockchain here and Solana on the Solana side, as the balances are apart. The amount takes at most half the row and its number is never scaled or cut:
  its symbol (shortened past ten characters, whole in the accessible name and the detail) goes under it when both do not
  fit on one line, and what happened wraps rather than overflow. The badges are the mobile wallet's own vector glyphs
  drawn through CSS masks in `popup.css`; no image file carries them.
- **History detail.** Every row opens its detail in place of the list; Back shows the list again where it was (it went
  on reading meanwhile). The detail opens with the row's icon and badge, larger, what happened and the amount, then the
  badge of its state (with one line for a dropped, unverified or replaced transaction), a line that a token named after the native coin of QNet Blockchain is not QNC, the token (QNC, or the token and its contract; the node of a registration this
  wallet submitted; on Solana SOL or 1DEV and its mint), both sides
  (each address a copy control), the block, the time, the fee, the nonce of a transfer not decided yet, and the
  transaction hash or signature as a copy control, with Open in explorer (the aiqnet.io explorer, or Solana Explorer on
  devnet) when there is a hash. An unverified QNet Blockchain row other than a token row is looked up on two nodes when
  its detail opens (`/api/v1/transaction/{hash}`): listed in a block at the same height there, it reads as Confirmed with
  that block. An unverified token row says that the wallet could not prove the transfer on QNet Blockchain yet.
- **Kept current.** The popup has no Refresh button. The balances and token list on Assets, the amount available on
  the QNet Blockchain send form and the History rows read themselves again: when the screen opens, every 15 seconds while the
  popup is visible (nothing while it is hidden, one read as soon as it shows again), right after a send, token
  transfer, contract call, activation or claim a site asked for finishes, and when the network or the wallet
  changes. One read runs at a time (a tick while one is out is skipped), a read that fails leaves what is shown, and
  only what changed is drawn again, so a typed amount or a scrolled list stays. History reads the rows listed so far
  in one request; a list paged past 50 rows is read again when the tab is opened again.
- **What was read shows at once.** The service worker keeps the last balances, the token list and the first history
  page of each network it served in this session (in `chrome.storage.session`, for this wallet only, gone with every
  lock). The last QNet Blockchain balance (read at a node's live tip, or verified), the token list and the Solana balances also
  outlive the session: they are kept in the vault's chain cache (IndexedDB, next to the vault record, with a MAC under a
  key derived from the vault key; a certified answer whose certificate was not verified is never kept), so the popup draws them at once right after an unlock too.
  What is drawn from the cache carries a quiet "Updating…" until the read behind it ends; a read that fails leaves the
  figure with "Could not update: this is the last balance the wallet read." The popup reads the other network's
  balances and both first history pages in the background once the screen's own read is done, so a switch between QNet Blockchain and Solana shows its numbers at once.
- **The chain the wallet follows.** The chain cache also keeps the highest network head the wallet saw (the head two
  nodes report, kept in steps of 10 macroblocks). A head 10 or more macroblocks below it means the nodes serve another
  chain (a restarted test network: the live network never goes back, and a lagging node is a few blocks behind): the
  wallet drops what it kept of the old chain (the light client's anchors, its pending transactions and what they can take,
  which no chain the nodes serve can decide, the genesis capsule, the nonces and the live figure it saw, and the
  cached QNet Blockchain balance, tokens and history) and follows the new head; so it does with a cache kept under
  another build's chain identity (a fingerprint of its network identity, the hash of block 0, and its pinned genesis
  identities). A cache kept by a build before the network identity was part of it, under the same genesis identities,
  is this chain's: its head stands and the identity is written again (anchors kept in the earlier format, without their
  roots and chain identity, read as none, so the next walk starts from the pin or the capsule). A kept anchor or a capsule that far above the
  head is dropped too; before either drop every node is asked again and the highest head any of them reports
  decides, so two lagging nodes that answer first never pass for another chain. Anchors kept from an earlier session that
  the light client finds to be of another lineage are dropped as well (the first step above one refused by two nodes for
  its committee's signatures, its keys or its registry, the rule the mobile wallet shares): the light client walks from the release's pin at once and the vault's copy
  goes with them. Dropping costs a walk, never trust. Checked beside the popup's balance read, at most once a minute.
- **The cursor.** No field of the extension takes the cursor on its own (owner, 06.10), the lock screen's password field
  included, and a wrong password does not put it back: a field is focused by a click or Tab only. The pages never call
  `focus()`, and until the user's first press of a pointer or a key on a page, a text field the browser itself focuses
  gives the focus back.
- **Receive.** Titled Receive, with one line (QNet Blockchain: the address for QNC and its tokens; Solana: for SOL and Solana tokens), the QR code drawn in the page, the address with its first and last characters set apart,
  and Copy. No warning box.
- **Address card.** Assets shows the whole QNet Blockchain or Solana address, never shortened, on one line. The address is
  itself the copy control: a button with "Click to copy" on hover that copies on a click, Enter or Space and then
  says "Copied". There is no separate Copy button. Every other screen that shows the wallet's own address
  (Receive, a review's From, Activate, the setup result) shows it whole the same way, and a click
  copies it. Every other whole address (a review's To, the 1DEV mint, the approval window)
  stays on one line too: its type size follows the width of its box, so the longest address (45 characters) fills
  it, about 11.4 px in the popup.

## Solana

The Solana side shows the SOL and 1DEV balances of the wallet's address at `finalized` commitment, with Send and
Receive. The mint's decimals are read on chain with `getTokenSupply` (1DEV must report 6).

- **History.** The wallet's own Solana transactions, newest first, at `confirmed`, in pages of 10 with Load more: the
  signatures listed for its address and for its 1DEV account, merged by slot, each transaction read once
  (`getTransaction`) and kept for the session. A row shows what moved for the wallet as the transaction's balances
  show it: 1DEV when its 1DEV balance changed (Burned for its activation burn), otherwise SOL less the fee; Sent to self
  when only the fee left; a failed transaction shows what it asked to move, marked Failed. A transaction that moved
  nothing for the wallet and that the wallet did not pay for is not listed. The rows read as the QNet Blockchain ones: the SOL or
  1DEV icon with its badge (received, sent, to yourself, a flame for the burn, the red mark for a failed one), "From:" or
  "To:" and the other address, the state of a failed one, newest first under the header of their day. A row opens its
  detail, with Open in Solana Explorer on the build's cluster.

- **Send form.** The token (SOL, or an SPL token the wallet lists: 1DEV), the recipient, and the amount with **Max** and
  the amount available. Max asks the service worker: for SOL the balance at `confirmed` less the network fee of this
  very transfer, which leaves the account empty; for a token its whole balance.
- **Recipient.** A Solana address (base58 of 32 bytes), or a payment request pasted (or typed) into the field:
  `solana:<address>?amount=<decimal>&spl-token=<mint>&reference=<address>&memo=<text>&label=<text>&message=<text>`,
  every part after the address optional. It is read exactly as the mobile wallet reads it, so a request means the same
  in both: names and values are form-encoded (`+` is a space, `%2B` a plus); `amount` (a plain decimal of the token's
  whole units; zero asks for no amount), `spl-token` and `memo` come at most once each; `reference` up to four times,
  each a different Solana address; any other part is ignored. The request fills the recipient, switches to the token of
  its mint when the wallet lists that mint, and fills the amount; its label and message (the first of each; the mobile
  wallet ignores both) and its memo are shown as plain text, never as a link (the label and message without control or
  bidirectional formatting characters and cut to 200 characters), with the number of references it carries. The
  transfer carries its references and memo while the recipient is still the request's address. The user still reviews
  and confirms. A mint the wallet does not list, an amount that is malformed or has more decimals than the token, a
  once-only part given twice, a fifth, repeated or invalid reference, and a memo that is empty, longer than 200 bytes of
  UTF-8 or holds a control character or a bidirectional mark refuse the whole request with a short message, and nothing
  is filled. So does a memo that is not well-formed text (a lone surrogate, which only pasted text can hold), whose
  bytes would not be the text shown; the mobile wallet refuses it too. Anything else that is not an address is refused
  when Send is pressed. The QNet Blockchain send takes QNet Blockchain addresses only. Both recipient fields show
  a whole address in the input.
- **Transaction.** Built in the service worker with its own legacy message compiler, the one that builds the burn: SOL
  is one System `Transfer`; a token is SPL `TransferChecked` of the amount at the mint's on-chain decimals from the
  wallet's associated token account to the recipient's, and when the recipient's associated token account does not
  exist yet, the idempotent create instruction of the associated token program comes first, paid by the wallet. The
  wallet is the fee payer and the only signer; the recent blockhash comes from the build's Solana RPC at `confirmed`
  (devnet on the testnet build). A payment request's references go on the transfer instruction as read-only, unsigned
  accounts after its own, in the request's order, and its memo is one Memo program instruction that lists no account,
  right before the transfer (after the create); the keys of a send come in the order its instructions name them. This
  is how the mobile wallet builds the same transfer, so one request gives the same bytes in both. Before it is compiled
  the instruction list must be exactly a transfer, a `TransferChecked`, or the create followed by a `TransferChecked`,
  the transfer carrying exactly the request's references and preceded by exactly its memo: a send never carries a burn,
  an approval, a memo it was not asked for or any other instruction. A transaction larger than a Solana node accepts
  (1232 bytes signed) is refused before it is signed; the largest request, four references and a 200-byte memo to a new
  token account, comes to 753 bytes. A token goes only to a wallet address (a key on the curve), never to a token account, a mint or a
  program address; SOL never to a token account or a mint.
- **Review.** From, to, the token and its mint, the amount, the network fee (`getFeeForMessage` of this message), the
  rent of the new token account when the send creates one, the SOL spent in all, the cluster, a payment request's label
  and message, the memo the transaction carries and how many references, with the first-time and look-alike warnings.
  The memo and the references shown are the ones the service worker quoted, and the review is drawn only when they are
  the request's. It also names, with the numbers, why the send cannot go as it is, and Confirm stays off: not enough SOL
  for the amount, the fee and the rent; not enough tokens; SOL to an address with no account below the least an account
  can hold (the rent exemption of an empty account, 0.00089088 SOL on the public clusters); or a funded wallet left
  below that floor without being emptied, after the fee or at the end, which the chain refuses. Confirm arms 1.5 seconds
  after the review is drawn and asks no password: the unlocked wallet confirms, as on the QNet Blockchain side.
- **Sending.** The service worker plans the transaction again from the same fields, the references and the memo
  included, and refuses it if the fee or the rent changed since the review (the review is drawn again with the new
  numbers), signs it, checks its own signature, and simulates it with signature verification. A blockhash the cluster
  no longer knows ends there: nothing is sent, and the review is drawn again with a fresh one. Then it sends and reads
  the status once. A transaction not confirmed at that read shows as pending, and the popup reads its status while the
  screen is shown, as often as a QNet Blockchain sent screen asks (every 2 seconds for the first 10 seconds, every 5
  seconds to the first minute, then every 10 seconds, five minutes at most), until it is confirmed (finalized reads as
  confirmed), failed (its fee was paid, nothing else moved) or expired: no trace of it once the finalized block height
  passed its blockhash's last valid height, looked up once more after that height was read. An expired transaction spent nothing and offers Send again.
  The balance of the token sent is read again when it settles. Errors are plain: not enough SOL for the fee or the rent,
  Solana could not be read (try again), the transaction expired before it was sent (review again), the transaction
  would be larger than Solana accepts.

## Activate

The Activate tab is where a node's activation code is obtained. Each wallet has exactly one code, for a Light or a
Super node: the node type is chosen once, and a wallet that has a burn never gets a second one, of either type, by any
way (CONTRACTS.md decision 35). A super node is activated only here, in the extension, and runs on the user's own server
with the QNet Blockchain node software; aiqnet.io's one-time payment address activates light nodes only, which run in QNet Wallet on
a phone or tablet (decision 36).

- **One wallet, one code.** aiqnet.io keeps a verified record of every burn made for a wallet, from the extension or
  through the cabinet's one-time payment address, and at most one reservation per wallet
  (`/api/cabinet/activation/{wallet}`). The extension builds a burn only when every source it has answered "none":
  its vault (no activation, no pending burn), the kept search of the wallet's own Solana address, aiqnet.io's record, and QNet Blockchain. A source that is still reading, locked or unreachable means no burn; the tab says which one and offers
  to try again. Before it signs, the extension asks aiqnet.io's reservation for this wallet with a request its wallet key
  signs at that moment (below), which one client at a time can hold (it expires after 10 minutes if no burn lands, and the
  burn is signed only while at least 2 minutes of it are left);
  it then announces the signed burn with a proof that it is this wallet's (below) and sends it only once aiqnet.io took
  that announce. Anything that fails before the send gives the reservation back and sends nothing, so two browsers or
  two devices of one wallet can never both burn. Once final, the burn is kept on aiqnet.io as the wallet's record, and a
  burn the vault holds that aiqnet.io does not hold yet (one made before this rule) is recorded there after the next
  unlock.
- **The reservation request.** Only the wallet itself holds aiqnet.io's reservation. For the wallet `W`, node type `N`,
  burner `S` (the wallet's own Solana address) and the current time `T` (Unix seconds), the text is
  `QNet node reservation v1`, `wallet: W`, `node: N`, `way: extension`, `burner: S`, `time: T` and `cluster: devnet` on
  seven lines joined by a line feed, and the request carries `{pk, sig, time}`: the wallet's ML-DSA-65 public key and its
  signature, with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, of the same envelope as the proof below. The extension
  signs it without a window, inside the burn the user already confirmed. aiqnet.io checks that the key is the wallet's,
  the signature, and that the request is at most 10 minutes old (and at most 5 minutes ahead); it refuses an unsigned,
  forged, other-wallet or stale request, which the extension reads as an internal error, so nobody can hold a wallet's
  reservation or burn in its name.
- **The proof.** For the wallet `W`, node type `T`, burner `S` (the wallet's own Solana address), burn signature `TX` and
  whole amount `A`, the text `M` is `QNet burn record v1`, `wallet: W`, `node: T`, `burner: S`, `burn: TX`, `amount: A` and
  `cluster: devnet` on seven lines joined by a line feed. Both signatures cover
  `"QNet Signed Message:\n" + "https://aiqnet.io" + "\n" + byteLength(M) + "\n" + M`: ML-DSA-65 by the wallet's QNet Blockchain key
  with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, and Ed25519 by the burner's key. aiqnet.io checks that the key is the
  wallet's, both signatures, and the burn itself on Solana. The proof carries no time; only the two keys of the recovery
  phrase make one, so nobody can plant a record for another wallet. The wallet signs a reservation request and a proof
  only through its site-record signer, which accepts no other text; a page's `qnet_signMessage` refuses both texts by
  their protocol prefix (below), so no approval can hand one to a page.
- **What a reset keeps.** Deleting the wallet or resetting it (Forgot password) and importing the same phrase again, or
  a second install with the same phrase, starts from an empty vault, while the chain and aiqnet.io's record keep the
  burn: the Activate tab reads aiqnet.io's record of the wallet's own burn, checks the burn on Solana and stores its code at once, and the search of the wallet's
  own address finds the burn too. No second burn starts either way.
- **What no client can stop.** Solana cannot refuse a burn made by hand outside the wallet. From the network's one-node
  rule (gate `wallet_one_node`) the network refuses a second node of either type for one wallet; before it the network
  refused only the same type, and the clients and the record kept out the other.
- **What the tab shows.** While the sources are read: "Checking this wallet: QNet Blockchain, Solana and aiqnet.io…"
  and no price card. Once the wallet has its code (its own burn's, or the one aiqnet.io's record holds for it, a light
  node paid from a one-time payment address included), only this: the light node's record on QNet Blockchain until the chain lists the node with this burn (below); one line, "Manage the node at aiqnet.io/node", which
  opens aiqnet.io/node in a new tab; and a warning only when another burn is involved (another device with the same
  recovery phrase burned first, or aiqnet.io keeps another burn of the wallet as its activation), with a button to that
  burn in Solana Explorer. The tab shows no burn details, no banner, no next step, no server settings and no device:
  aiqnet.io/node shows the node, its device, its balance and, for a Super node, the server's settings. The code itself is
  in Settings (below). Right after a burn the tab is the same. A burn on its way, or an activation
  starting in another browser, on another device or through a one-time payment address on aiqnet.io: said so, and read
  again every 5 seconds while the popup is open. A
  node QNet Blockchain knows with no code in this browser: "This wallet already has
  a node", with Recover. A burn no code derives from: said so. A source that could not answer: named, with Retry. The
  Light and Super cards with their prices only when every source answered "none", each with where its node runs (a
  Light node in QNet Wallet on a phone or tablet, a Super node on the user's own server with the QNet Blockchain node software),
  and then the lead that invites a burn.

- **Price.** `GET /api/v1/activation/price?type=light|super` from every pinned node at once, each waited for 4 seconds
  at most, as a whole number of 1DEV. At least two must answer and every answer must quote the same phase and cost: no
  proof serves the price, so it is the nodes' word, and the price cards, the burn confirmation and the approval window
  say "Price as reported by the nodes of QNet Blockchain." There are no fallback numbers: without a price (one node
  quoting otherwise included), activation is disabled and the reason is shown. Activation by burn is offered in phase 1
  only.
- **Get code.** Choose Light or Super, then confirm a screen showing the exact amount, the mint and
  the network. Its one confirmation line is the acknowledgement the user ticks (the 1DEV are destroyed
  and the wallet gets exactly one code); no password is asked while the wallet is unlocked. The service worker then:
  1. refuses if the vault already holds an activation or a pending burn;
  2. runs the burn search (below) for the wallet's Solana address, including a burn Solana has confirmed but not
     finalized
     (another device's): a valid burn refuses with `BURN_EXISTS` (Recover gives its code once it is
     final), and a search that did not reach the start of the history refuses with `HISTORY_TOO_LONG`
     (starting again continues) or `SOLANA_UNAVAILABLE`, never as "no burn"; a 1DEV burn of the
     wallet's own that yields no Light or Super code refuses with `BURN_UNUSABLE`, because the node counts
     it as the wallet's activation (it reads neither the memo nor the source account): one the search found
     with another memo (a Full node, `QNET_NODE_TYPE:FULL`), or one from another of the wallet's 1DEV
     token accounts (below); then it asks aiqnet.io's record (a record of this wallet refuses, and so does a
     reservation or a burn on its way there, of either way, or no answer), then
     `/api/v1/verify-activation` whether the wallet's QNet Blockchain address already runs a node, and the nodes whether they list
     its light node;
  3. fetches the price again as above and requires it to equal the price the user confirmed, and checks the 1DEV
     balance;
  4. asks aiqnet.io's reservation for the wallet with the request its wallet key signs then (refused while another
     browser or device holds one, when aiqnet.io knows a burn or a node of the wallet, or for a request it cannot
     verify), then checks SOL for the fee plus a 10,000-lamport reserve;
  5. builds a legacy transaction: SPL Token `Burn` of price × 10⁶ from the wallet's associated token
     account with the wallet as authority, plus a memo `QNET_NODE_TYPE:LIGHT` or
     `QNET_NODE_TYPE:SUPER` signed by the wallet, with the wallet as fee payer;
  6. signs it, simulates it with signature verification, announces it to aiqnet.io with the proof, stores it in the
     vault as the pending burn, sends it and waits for `finalized`;
  7. checks the finalized transaction, computes the code with the node's algorithm from node type,
     Solana address, burn signature and amount, stores it as the wallet's single activation, and records it on
     aiqnet.io.

  A burn that has not finalized within 90 seconds stays pending. The tab reads it again on its own every 5 seconds
  while the popup is open (there is no button to check it), stores the code once it finalizes, and clears the record if
  it failed or never reached the chain. Only one burn can be in progress. When another device with the same phrase burned first,
  the older burn is the wallet's one activation and its code is stored; this device's burn went through
  and gives no code, and the vault keeps it apart (`supersededBurn`), so the Activate tab and the approval
  window name it next to the activation.
- **The burn search** (`solana.findWalletBurns`, a port of the mobile wallet's matcher) lists the history
  of the wallet's 1DEV associated token account, where every genuine burn writes (transactions that touch
  only the wallet's Solana address, such as SOL transfers, are not listed there), at `finalized` in pages
  of 1,000, and
  fetches each entry that carries a node-type memo. One search has a budget of 400 pages and 90 seconds,
  and its listing pauses, never skips, while 4,000 candidates wait to be checked. What it listed and
  checked is kept next to the vault, with an HMAC under a key derived from the vault key, and the next
  search goes on from there, through entries added since as well. A history not searched to its start
  within the budget answers `HISTORY_TOO_LONG` (starting again continues), one that cannot be read
  `SOLANA_UNAVAILABLE`; neither is ever reported as "no burn". For Get code and a request from aiqnet.io it
  also pages the history at `confirmed` from its newest entry down to the part the finalized search holds,
  at most 20 pages and 30 seconds, so a burn another device just sent is seen before it is final; a check
  that cannot get that far fails closed (`SOLANA_UNAVAILABLE`, or `HISTORY_TOO_LONG` when its time ran
  out). A transaction is accepted only if it succeeded, has the wallet as fee payer and signer, has
  exactly one burn of the cluster's 1DEV mint from the wallet's token account with the wallet as
  authority, has the node-type memo, and burns a whole number of 1DEV at the mint's real decimals. The
  oldest valid burn (burn order, [QNet Link v1](../protocols/qnet-link-v1.md) section 3) is the wallet's
  code, the same rule the mobile wallet applies. A candidate that fails those checks but is still a
  successful 1DEV burn of the wallet's own (the wallet pays, signs and is the burn's authority, whatever
  the memo) is kept apart as a burn no code derives from.
- **Burns from other 1DEV token accounts.** A burn of the wallet's own may come from a 1DEV account other than
  the associated one. Every burn of the wallet's own is
  a transaction the wallet signed, so it lists in the history of the wallet's own Solana address, whichever
  token account it burned from (a closed one too). Get code, a request from aiqnet.io and Recover also run
  that second search, over the wallet's own address, kept and resumed like the first with its own budget;
  a burn of the wallet's own found there yields no code and blocks a new burn as above, and a new burn is
  refused until that search has reached the start of the history (`HISTORY_TOO_LONG` resumes it,
  `SOLANA_UNAVAILABLE`), never on "no burn".
- **Recover** runs the search for the wallet's Solana address; the oldest valid burn it finds is stored, with its
  code derived from that address. When it finds only burns no code derives from, it answers
  `BURN_UNUSABLE` rather than "no burn". When the search shows no burn it reads the node's registration record (below),
  then aiqnet.io's record of a burn of the wallet's own address, checked on Solana. Recover never replaces a code the
  vault already holds.
- **A node burned for on aiqnet.io.** The cabinet at aiqnet.io can burn the 1DEV of a Light node for this wallet from a
  one-time payment address of its own; no search of the wallet's addresses finds that burn. When they show none, Recover
  asks two nodes for the signed status of the wallet's light node (the wallet key signs
  `q1337|light_status:{node}:{T}`) and reads the burn the node's registration record names, checks it on Solana
  as a finalized Light burn of 1DEV, and keeps it as this wallet's activation, already recorded on QNet Blockchain. Its code keeps the usual format but names this wallet's QNet Blockchain address instead of the payment address,
  so it reads as this wallet's code. The Activate tab shows it as this wallet's activation, and Settings its code as any other's (a
  node not on QNet Blockchain yet is finished on aiqnet.io/node with QNet Wallet, from any browser); a request of
  `qnet_activateNode` answers `NODE_EXISTS`. Such a burn
  is permanent: the payment key signs its owner bind, naming the wallet and the burn, before the burn is sent, and
  aiqnet.io records the burn as the wallet's once it is final, never releasing the wallet. Before the node's record lists
  it, that record is shown the same way, checked on Solana; the extension never stores or registers it, and never records
  another burn over it.
- **The code** is in Settings, beside the recovery phrase and the private key: one plain row with the code masked,
  **Show** and **Copy**, no warning and no timer. The code comes into the page only when the user presses one of them
  (no password while the wallet is unlocked) and leaves it with Settings. Copy copies at once, and the popup clears the
  clipboard after 45 seconds if nothing was copied since and it is still open. A Light code is the
  burn's receipt: the wallet records the node on QNet Blockchain (below), and the node runs in QNet Wallet on a phone
  or tablet linked on aiqnet.io/node with the same recovery phrase; the node never needs the code. A Super node runs only on a server with the
  QNet Blockchain node software; nothing of it is linked to a phone. Its code goes into the server's environment variables with the
  burn transaction and the amount (`QNET_ACTIVATION_CODE`, `QNET_BURN_TX_HASH`, `QNET_BURN_AMOUNT`, and
  `QNET_WALLET_SEED_FILE`, a file on the server that holds the recovery phrase, preferred to `QNET_WALLET_SEED`;
  [Running a node](../operators/running-a-node.md) has every server step); aiqnet.io/node shows the code, the burn and the
  server's settings for the wallet. The code and the burn start nothing alone, since the server also needs the wallet's
  recovery phrase (the node checks the code against the phrase's own Solana address).
- **Record on QNet Blockchain.** A Light activation is stored with its registration queued, in the same vault
  write, and the service worker starts it at once. One attempt reads `/api/v1/light-node/status` from two nodes
  (either listing the node ends it), then signs the wallet's consent (ML-DSA-65, empty context, over
  `q1337|client_node_reg:{node}:{wallet}:{proof}:{T}` with `T` the current second) and the burner's owner bind
  (Ed25519, over `qnet_onchain_reg:…`, docs/protocols/light-node-messages.md section 4), and posts them with the
  burn to `/api/v1/node-registration/submit` on one node, never two: the node builds the transaction itself and
  collects the committee's burn attestations. An admitted registration is given 10 minutes to reach a block;
  "behind the chain", "quorum not yet reached", an owner bind without a time the network does not take yet
  (`bind_v2_pending`; the extension's own bind carries the time) and the other temporary answers are tried again after 15 s, 30 s,
  60 s and then doubling minutes up to 6 hours, at most 12 times on its own; a clock more than 5 minutes off and a
  refusal stop it. The network's one-node rule (`wallet_has_node`: this wallet already has a node of either type) stops it
  for good: the tab says so and offers no Record on QNet Blockchain. The tab's card shows the light node's id and one line
  (recording, not recorded yet, not accepted, one wallet one node, the clock, recorded with another burn) and,
  when the record waits for the user, **Record on QNet Blockchain**, which runs one attempt as above at once, with one press
  while the wallet is unlocked; while the node is being recorded the card reads its record again every 5 seconds, and
  each read looks an admitted registration up on chain, so the card goes at the first read after its block. Once
  the chain lists the node with this burn the card goes: aiqnet.io/node shows it from then on (listed with another burn,
  the card stays with its line). An
  activation stored without a registration record is looked up on chain and never submitted unasked.

### Activate from aiqnet.io

The activation page of aiqnet.io can ask the extension for the same thing with the provider method
`qnet_activateNode {nodeType}` ([QNet Link v1](../protocols/qnet-link-v1.md), section 10). The page
sends only the node type: it never sees or builds a transaction.

- **Who may ask.** Only the page origin `https://aiqnet.io`, as the browser reports it (the development
  build also plain-HTTP localhost and 127.0.0.1). Pages of `https://games.aiqnet.io` get the provider but
  never this method: the service worker answers 4100 to any other origin, even a connected one. No
  site grant is needed or created. A browser without a wallet answers
  `{status: 'error', error: 'NO_WALLET'}` at once.
- **The window.** An approval window like the others (cooldown, queue, under the toolbar icon, confirm armed
  1.5 seconds after the last press or key, pointer clicks only, unlock first; see Approvals below). It shows "Activate a Light node?" (or Super) with the price from
  the nodes, where the node runs (as on the Activate tab's cards), the exact amount burned, the token and cluster, the
  mint, the SPL Token program, the Solana address that burns and its balances, and the Activate tab's one confirmation
  line: the user ticks the
  acknowledgement and presses the armed Burn button; no password is asked while the wallet is unlocked. The burn is
  offered only when the wallet's own search, aiqnet.io's record and QNet Blockchain all answered "none"; while they
  are read the window says "Checking this wallet: QNet Blockchain, Solana and aiqnet.io…" with nothing to confirm. When
  the wallet already has its code, or a burn that Solana has not finalized (the search stores one it finds), the window
  says so instead and its armed button shares it. When the
  action is impossible (no price, phase 2, the wallet already runs a node, a burn aiqnet.io holds for it, an activation
  starting in another browser, on another device or through a one-time payment address on aiqnet.io, aiqnet.io or
  Solana or the network not answering, not enough 1DEV
  or SOL, an activation already running, signing disabled), the window shows why and its one button tells the site
  the reason (aiqnet.io's record as `NODE_EXISTS`, one starting elsewhere as `BURN_IN_PROGRESS`, no answer from
  aiqnet.io as `INTERNAL`). Ending the origin's first such window within a minute, by that button or by closing it, is
  not a rejection; a second window of the origin within that minute that ends unused counts as one (see
  Approvals below for the budget every window counts against).
- **The action** is the Activate tab's code path in `activation.js` under the same single-flight lock:
  the vault's code, or the pending burn, or the oldest valid burn found on Solana (stored) is answered
  without burning, and a burn the search found is answered before a search that could not finish refuses; otherwise
  aiqnet.io's record and the network are asked again, the price is read again as above and must equal the one the
  window showed, and the burn is reserved, built, simulated, announced, sent and awaited as above.
  The price shown is fixed for the approval; a change makes the window review again.
- **The answer.** `ok` or `exists` carry both addresses, the node type, the burn transaction, the
  amount and the code; `pending` the same without the code; failures come back as
  `{status: 'error', error}` with a code of the protocol (`PRICE_UNAVAILABLE`, `TX_FAILED`,
  `BURN_UNUSABLE`, ...), and any other wallet code as `INTERNAL`: the site then learns only that the
  request was not completed, while the window shows the reason. Before it leaves, the extension recomputes
  the code from the burn and checks that `qnet` is this wallet's address and `solana` the address that
  made the burn, this wallet's own. A burn this request sent that another device's older burn beat comes back
  as `exists` with that older activation, whatever its node type, never as an error; the window names this
  device's burn too. `exists` adds `supersededBurnTx` (section 7.1), the signature of this device's burn, when
  that burn went out from the wallet's own address and
  another device's older burn is the activation; this holds for the burn this request sent and for an
  earlier request's burn that settles so while this one is answered. A reject is 4001. The window shows
  the outcome, titled by what happened (the code, a burn waiting for Solana, or no code), until it is closed, at most 30
  seconds; after a Super code it adds that aiqnet.io shows the code, the burn and the server's settings on My node's
  Overview.
- **The record.** After a Light answer the wallet records the node on QNet Blockchain as the Activate tab does
  (an existing Light activation not recorded yet is queued by the confirmed request). The answer's keys do not change: the site reads the chain for "Registered". The window follows
  the record and stays up to 3 minutes; closing it never stops the registration. A record the network's one-node rule
  refused (`wallet_has_node`) is said as that refusal there too, never as one to try again later.

### The wallet's activation for aiqnet.io

`qnet_getActivation` (no params; [QNet Link v1](../protocols/qnet-link-v1.md), section 10) tells the cabinet what the
extension knows of the wallet's activation, so the page shows a received code in any browser and never offers a burn
the extension knows of, without an approval window and without the user pressing a burn button. Only
`https://aiqnet.io` may ask (4100 for any other origin), and one origin at most 30 times a minute (more: 4001). It
opens no window, spends no approval budget, creates no grant and sends no event; it signs nothing for the page and never
burns. A burn its search finds is stored as Recover stores it (a Light activation is then recorded on QNet Blockchain, as after Recover), and a read that sees the vault's own burn may record it on aiqnet.io's record in the background, as an
unlock does (One wallet, one code, above).

- `{status: 'no_wallet'}`, `{status: 'locked'}`, or `{status: 'not_connected'}` while the origin has no grant of the
  unlocked wallet.
- `{status: 'exists', qnet, solana, nodeType, burnTx, burnAmount, code, paidOnSite}`: the vault's activation. `code` is
  the node's code of the burn from `solana`, or with `paidOnSite` (a Light burn the cabinet's payment address made) the
  same code of `qnet`.
- `{status: 'pending', qnet, solana, nodeType, burnTx, burnAmount}`: a burn of the wallet on its way.
- Otherwise the kept search of the wallet's own Solana address answers: a burn it finds is stored and answered as
  above; `{status: 'searching', qnet, solana}` while it runs (ask again in 3 to 5 seconds); `{status: 'unknown', qnet,
  solana, reason}` with `SOLANA_UNAVAILABLE` or `HISTORY_TOO_LONG`; `{status: 'unusable', qnet, solana}` for a burn no
  code derives from; `{status: 'none', qnet, solana}` only for a search that finished with nothing within the last
  minute. One wallet's search starts at most every 20 seconds.

`qnet` and `solana` are always the unlocked wallet's own, and the extension checks the answer, the code included, before
it leaves. An extension without the method answers 4200.

### Unlink the node's device

The wallet key ends the light node on whatever device runs it, from any device that holds the wallet: one wallet runs one
node, on one device at a time, and a lost phone is unlinked from aiqnet.io/node in any browser where this wallet is
connected. The popup shows nothing of the device and has no Unlink of its own: the Activate tab's one line leads to
aiqnet.io/node, whose Device tab asks the extension with `qnet_unlinkNodeDevice` (only `https://aiqnet.io`, 4100
elsewhere; no grant, no params). An approval window shows what happens (the node stops on that device; the node and its
balance stay with the wallet, and it can run on any device later), the node, the device (Android, iPhone or iPad, or an
unknown device) and the day it was linked, while two pinned nodes' public status name a device that runs the node and
list the `unbind_wallet` feature; its confirm arms after 1 second and asks no password. A node that runs on no device, a
network that does not take the unlink yet, or nodes that disagree offer only Close.

The service worker reads the status signed with the wallet key; the binding's sequence is the `binding_seq` two pinned
nodes report alike for a bound device. It signs `q1337|light_unbind_wallet:{node}:{seq}:{ts}` (ML-DSA-65, empty context)
and posts `{node_id, seq, ts, signer: 'wallet', sig, identity_pubkey}` to `POST /api/v1/light-node/unbind` on the node
whose status gave the sequence, then on the other that agreed. A node that took it ends the unlink; `stale_seq` (another
unbind or a newer binding came first) is checked against the signed status again. The answer is `{status: 'ok', qnet,
nodeId, unbound: true}` or `{status: 'error', error}` with `NO_WALLET`, `NOT_LINKED` (no device runs the node),
`NETWORK`, `UNLINK_REFUSED` or `INTERNAL`; a reject is 4001. The genesis nodes pass the unbind to each other, and the
device stops at its next status read or answer.

### Move to wallet from aiqnet.io

`qnet_claimNodeBalance` ([QNet Link v1](../protocols/qnet-link-v1.md), section 14.10) moves the node balance of the node
aiqnet.io names, the wallet's own light or super node, into the wallet (CONTRACTS.md decision 47). Only `https://aiqnet.io` may ask
(4100 for any other origin); no grant is needed; its one param is `{nodeId}`, a light node id (`light_mobile_` and 16
hex) or a super node id (`super_node_` and 16 hex; a genesis node's id is refused with -32602 before any window). The
window checks the node against the unlocked wallet: its light node id and its super node id derive from its address (the
super id is `super_node_` and the first 16 hex of BLAKE3(`SUPER_NODE_PRIVACY_` and the address), as the node names it);
any other node is answered `WALLET_MISMATCH` and nothing is signed. It shows the node with its type and the balance two
nodes report alike, and its confirm arms like a transaction's; like every approval it asks for no password. Whether the
chain lists the node is read from two pinned nodes: a light node's public status, a super node's
`GET /api/v1/node/status`. The service worker signs the quote (`q1337|claim_rewards:{node}:{wallet}`), checks it as the
mobile wallet does (claims strictly ascending above the wallet's watermark, amounts summing to the total, a timestamp,
the batch held to a second pinned node's quote of the same request, the first epoch equal to what two other nodes
report, no other message to sign than the one it builds), signs the
payload over `q1337|qnet_claim_v1:{wallet}:{ts}:{sha3(claims_data)}` and sends it back to the node that quoted it. The
answer is `{status: 'ok', qnet, nodeId, amountNano, txHash, stoppedAtEpoch}` (at least 1 QNC for the whole balance; any
amount above zero for a part the node's quote stopped short of, with `stoppedAtEpoch` the first epoch it did not take),
`{status: 'empty', qnet, nodeId}` (below 1 QNC) or `{status: 'error', error}` with `NO_WALLET`, `WALLET_MISMATCH`,
`NO_NODE`, `NETWORK`, `CLAIM_REFUSED`, `CLAIM_BUSY` or `INTERNAL`; a reject is 4001. The network credits the move once
a block includes it. The popup itself has no move of a node balance; History shows a move as "From: node balance".

## Page provider

On `https://aiqnet.io` and `https://games.aiqnet.io`, and on no other site, the extension gives pages a
provider object. The object holds no authority: every decision is made in the service worker, which
learns the page's origin from the browser, never from a message.

- **Discovery.** `inject/provider.js` dispatches `qnet:announceProvider` on `window` with
  `detail = {info: {uuid, name: 'QNet Wallet', icon, rdns: 'io.aiqnet.wallet', channel: 'extension'},
  provider}`, once at start and again on every `qnet:requestProvider` event. `channel` tells a site
  which wallet answers (the mobile app's in-app browser announces `mobile`, see
  [QNet Link](../protocols/qnet-link-v1.md)); like `rdns` it is self-asserted and only picks what the
  site offers. `window.qnet` is the same frozen object when the name is free.
- **API.** `provider.request({method, params})` returns a promise. `provider.on(event, listener)` and
  `removeListener` handle the events `accountsChanged` and `disconnect`. `provider.isQNet` is `true`.
- **Path.** The page posts to the relay with `window.postMessage`, restricted to its own origin. The
  relay forwards to the service worker over a `runtime.connect` port named `qnet-provider`. The
  router keeps a port only from this extension's content script, in a tab's top frame, whose origin
  matches the manifest's content-script patterns.

| Method | Params | Result |
| --- | --- | --- |
| `qnet_requestAccounts` | none | `{qnet, solana}`; opens a connect approval the first time for an origin (unlock first when locked) |
| `qnet_accounts` | none | `{qnet, solana}` when the origin is connected and the wallet unlocked, else `{}` |
| `qnet_chainId` | none | `{chainId: 'q1337', network: 'testnet'}` |
| `qnet_disconnect` | none | `true`; removes the origin's grant |
| `qnet_signMessage` | `{message}` | `{signature, publicKey, address}` after an approval that shows the exact text |
| `qnet_sendTransaction` | `{to, amount}` or `{type: 'transfer', to, amount}` (amount in QNC as a decimal string); `{type: 'tokenTransfer', token, to, amount}` (amount in the token's decimals); `{type: 'contractCall', contract, method, args, gasLimit?}` (args lowercase or uppercase hex of whole bytes, at most 4096 bytes, '' for none) | `{status: 'submitted'\|'unknown', from, to, amount, nonce, txHash}`; a token transfer `{status, from, token, to, amount, nonce, txHash}`; a call `{status, from, contract, method, nonce, txHash}`, each after an approval (see Transactions below). `nonce` is a decimal string, `txHash` the hash one node gave its copy or `null` (then `status` is `unknown`); `submitted` never says a call succeeded |
| `qnet_getTransactionStatus` | `{from, nonce}` | `{status: 'pending'\|'in_block'\|'unknown', blockHeight, txHash}` for the connected, unlocked account only (else 4100), no window. `pending`: the nonce at least two pinned nodes report live is below it and the wallet still sends a transaction there; `in_block`: at least two pinned nodes list the same transaction of `from` at that nonce, with its hash and, when two nodes report it alike, its block height (both null otherwise); `unknown` otherwise, and for a read that failed. In a block never means applied: the node keeps no outcome. An answer is given again for 3 seconds without a read, and an origin starts at most 20 reads a minute (the mobile in-app browser's shape and limits) |
| `qnet_activateNode` | `{nodeType: 'light'\|'super'}` | `https://aiqnet.io` only. `{status: 'ok'\|'exists', qnet, solana, nodeType, burnTx, burnAmount, code}`, `{status: 'pending', qnet, solana, nodeType, burnTx, burnAmount}` or `{status: 'error', error}` after an approval (no password: its armed confirm); `exists` may add `supersededBurnTx`; a Light activation is then recorded on QNet Blockchain (see Activate from aiqnet.io) |
| `qnet_getActivation` | none | `https://aiqnet.io` only, no window. `{status: 'exists', qnet, solana, nodeType, burnTx, burnAmount, code, paidOnSite}`, `{status: 'pending', qnet, solana, nodeType, burnTx, burnAmount}`, `{status: 'searching'\|'none'\|'unusable', qnet, solana}`, `{status: 'unknown', qnet, solana, reason}`, `{status: 'no_wallet'\|'locked'\|'not_connected'}` (see The wallet's activation for aiqnet.io) |
| `qnet_claimNodeBalance` | `{nodeId}` | `https://aiqnet.io` only; the wallet's light or super node. `{status: 'ok', qnet, nodeId, amountNano, txHash, stoppedAtEpoch}`, `{status: 'empty', qnet, nodeId}` or `{status: 'error', error}` after an approval (see Move to wallet from aiqnet.io) |
| `qnet_unlinkNodeDevice` | none | `https://aiqnet.io` only. `{status: 'ok', qnet, nodeId, unbound: true}` or `{status: 'error', error}` after an approval (see Unlink the node's device) |

Errors reject with a numeric `code`:

| Code | Meaning |
| --- | --- |
| 4001 | The user rejected the request, closed the window, the approval timed out, the origin has too many waiting, or the origin started 20 `qnet_getTransactionStatus` reads, or 30 `qnet_getActivation` reads, within the last minute |
| 4100 | The origin is not connected, or the wallet is locked when signing; `qnet_getTransactionStatus` for any account but the connected, unlocked one; `qnet_activateNode`, `qnet_getActivation`, `qnet_claimNodeBalance` and `qnet_unlinkNodeDevice` from any origin but `https://aiqnet.io` |
| 4200 | The method is not offered |
| 4900 | The connection to the wallet closed |
| -32602 | Invalid parameters; a `contractCall` that names `value` or `accessList` is refused with the text `Unsupported parameter` and `data: {reason: 'UNSUPPORTED_PARAM'}`, since the network accepts neither on a call today (the only error with data) |
| -32603 | Internal error |

`accountsChanged` carries `{qnet, solana}` on unlock and connect, and `{}` on lock, revoke,
disconnect and delete. `disconnect` carries `{code: 4900, message: 'Disconnected'}`. An event reaches the pages of the
origin through their relay's port, or, when the service worker stopped while idle and closed every port, through their
tab (`chrome.tabs.sendMessage`, which the relay takes only from this extension's service worker and only for its own page's
origin, and hands to the page the same way): an unlock in the popup reaches the cabinet whether or not it asked anything
since.

- **Messages.** `qnet_signMessage` accepts UTF-8 text of up to 4096 bytes. It refuses text that starts
  with a protocol prefix (`q1337|`, `qnet_register:`, `qnet_onchain_reg:`, `delegate_ping:`,
  `token_refresh:`, `ping:`, `selfattest:`, `register:`, `migrate:`, `client_node_reg:`, `claim_rewards:`,
  `qnet_claim_v1:`, `qnet_dev_`, `qnet_burn_owner_v2:`, `qnetburnrecordv1`, `qnetnodereservationv1`), checked
  after every whitespace and invisible character anywhere in the text is removed and the rest folded (NFKC,
  lowercase), and text with hidden control characters, format characters or lone surrogates. The last three
  prefixes are the payment key's owner bind and aiqnet.io's records of a wallet, a burn record and a node
  reservation, as the fold writes them: `QNet burn record v1` is refused however a page spells it. It also refuses a carriage
  return not followed by a line feed (the window breaks a line only at a carriage return and line feed
  together, while a verifier that splits lines on a lone carriage return would see a break the user never
  saw) and the typographic spaces U+2000 to U+200A, U+202F and U+205F, which the window draws a sliver wide
  or less. The signature is ML-DSA-65 with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1` over
  `"QNet Signed Message:\n" + origin + "\n" + byteLength + "\n" + message`. A transaction is always
  signed with an empty context, so a message signature can never verify as a transaction. A verifier
  rebuilds the same bytes with the same context.
- **Transactions.** The wallet sets the fee, gas and nonce itself and builds every byte with the shared
  builders (`TxBuilders`, compiled into `lib/qnet-core.js`). A transfer names `to` and `amount`. A token
  transfer names a built-in token contract: its name, symbol and decimals come from two pinned nodes that agree, and the
  balances at a node's live tip (see Tokens above); the amount is converted to base
  units exactly, and a recipient that holds none of the token costs the refundable 0.01 QNC storage
  deposit, shown in the window; sending to the burn address is flagged. A transfer or token transfer whose recipient is
  a contract (the token itself included) is refused before any window with -32602, and one to an address no two nodes
  agree on with -32603, by the popup's recipient check (see Transfer above), made again at the confirm. A contract call
  names a contract that is not a built-in token, a method and its input as hex; the gas limit is the call's intrinsic gas
  plus a fuel budget (default 200,000, at least 10,000, at most the 1,000,000 gas cap), and the maximum fee
  is shown. The network admits one transaction per account at a time (the committed nonce + 1), so a
  site's transaction behind one not in a block yet waits in its window. A page matches the payment by
  `from` and `nonce`, the transfer's identity (see QNet Blockchain above), and a token transfer or a call the same
  way, not by `txHash`: another node's copy of the same signed transaction, with another hash, may be the
  one that lands.
- **Grants.** Stored in `chrome.storage.local` under `qnet_sites_v3`, keyed by origin, and bound to
  the wallet. Each grant carries an HMAC-SHA256 whose key sits in the vault record, which only the
  extension can read. A grant without a valid MAC is ignored and pruned. Revoking a site (Settings →
  Connected sites, or `qnet_disconnect`) replaces that key and signs the remaining grants again, so a
  revoked grant written back into storage is refused.
- **Approvals.** One approval window at a time (400 × 640), opened with `chrome.windows.create`. At most 3
  requests per origin and 12 in total can wait; more are rejected at once. The window shows the
  origin as the browser reported it, with its Unicode form and a warning for internationalized
  names, never a name or icon the page supplied. It opens under the extension's toolbar icon: the top-right
  corner of one of the user's normal browser windows (the focused one, otherwise one of them at random),
  16 px from its right edge and 72 px below its top, less when the window is lower, so the whole approval
  stays inside a window of at least 400 × 640. A normal window is one no page can create, size or move; a
  popup window a page opened itself is never used, since its corner would be a spot the page chose. With
  displays of different sizes the approval stays on that one window and so never lands where no display
  is; when no normal window can be read it takes the requesting tab's window if that is a normal one, else
  Chrome's default place, and when Chrome refuses the position it opens once more where Chrome places it by
  default. A page may work out where the window opens, but not where the confirm button is: every time the
  approval is drawn, a gap of random height (0 to 96 px) sits right above its buttons. The confirm button arms
  1 second after the window was last left alone, 1.5 seconds for every transaction and every node activation
  window: any press, release or key anywhere in the window before it armed starts the wait again, and the window
  losing focus or being hidden disarms it until it is back. It confirms only on a trusted pointer click (mouse, pen or touch) whose press began on the button
  after it armed, while the window has focus. Enter or Space on the focused button never confirms, so an
  approval cannot be given from the keyboard alone (CONTRACTS.md decision 16: a page cannot time a key
  press into it). A message to sign shows its size and line count, and Sign stays off until the whole
  message has been scrolled into view. A transaction's window shows the nonce and balance the send rule gives (see QNet Blockchain above); until it has them it says it is reading the account, or why there is none yet (no answer, not confirmed yet),
  keeps the confirm off and reads again; a confirm the send rule refuses before signing
  leaves the window open for a fresh review. An approval left for 10 minutes is rejected.
  A single rejected or closed approval bars nothing: the same origin may ask again at once. The fifth such
  rejection within 10 minutes bars the origin for 1 minute. A page that goes away while its window
  has been on screen for the confirm delay counts as a rejection too, and from the origin's second window
  within a minute so does one that goes away sooner or ends unused. Every window also counts against its
  origin's budget from the moment it opens, however it ends: at most 5 within a minute and 20 within 10
  minutes. Meanwhile every request of it that needs an approval fails at once with 4001, and an approval
  that is granted and carried out clears the cooldown and the budget.
  No approval asks for the password. While the wallet is unlocked, the unlocked session and the press of the armed
  button are the confirmation; when it is locked, the window asks for the password once, to unlock, then shows the
  request and its armed button without asking again. The service worker takes a confirm only from the approval
  window it opened for that request: from the extension's own approval page, for the approval's random id that only
  that window's address carries, from that window (the browser names the sender's window; no page can), for the view
  the window drew; an approval confirms once. In the popup, too, no password is asked while the wallet is unlocked
  for sends, the Activate tab's burn (it keeps its acknowledgement), showing the activation code and Record on QNet
  Blockchain. The password stays for revealing the recovery phrase, exporting a private key, changing the password and
  deleting the wallet; Reset wallet (Forgot password) takes none: it removes the wallet, which only its recovery
  phrase brings back. The worker signs exactly the preview it showed.

## Settings

Auto-lock (5, 15, 30 or 60 minutes, or Never), connected sites with revoke, reveal recovery phrase, export the private
key of the QNet Blockchain or the Solana account (see Identity and derivation), the activation code once the wallet has one (see
Activate), change password, language, about (version, release channel, networks, signing state), removal of what the
earlier version left while it is there (see Vault and session), and delete wallet.

The header (the logo, the QNet Blockchain/Solana switch, Lock) keeps a 16 px gutter at both edges and the tab bar a 12 px one; the
logo alone names the wallet there, with QNet Wallet as its accessible name and tooltip (the lock screen's title says QNet
Wallet too), so the switch fits the 360 px popup. The six tabs each keep their label on one line and share out the spare width; in a language whose labels are wider than
the bar they are set smaller together, to 80 % at most, so all six fit inside the gutter (German and Russian need it),
and only past that would the bar scroll sideways (no scrollbar drawn) and bring the chosen tab into view. Lock is a
lock glyph in the header's text colour, at the header's button size, named "Lock" in the chosen language as its tooltip
and for screen readers.

## Store release notes

3.1.2: the first screen offers **Create a new wallet** and **Import an existing wallet**, each going straight to its
step. Forgot password no longer asks for the recovery phrase: **Reset wallet** removes the wallet from this browser, and
importing its 12 or 24 words brings it back with a new password. The QNet Blockchain send has **Send** on the form and
**Confirm** on the review, with a line while the balance is checked, and the wallet keeps its certified balance current
while it is unlocked, so a send is reviewed sooner. aiqnet.io's My node can move the balance of a light or a super
node into the wallet. Token transfers in History are confirmed only by their own proof. The texts name QNet Blockchain.

3.1.0: a wallet created in version 2.1 moves into this version. Open the extension, choose **Unlock your earlier
wallet**, enter its password (the current one, or the first one if it was changed), then choose a new password; or
choose **Use my recovery phrase instead** and import its 12 or 24 words.

## Languages

The popup, the setup tab and the approval window are translated into the mobile wallet's languages:
English, Simplified Chinese, Russian, Spanish, Korean, Japanese, Portuguese (Brazil), French, German,
Arabic and Italian, with the mobile app's terms for wallet, recovery phrase, activation code and node.
The first start follows the browser's language when it is one of these, else English; Settings →
Language changes it, and the choice is kept as a display preference only. Arabic pages run right to
left, while addresses, codes, transaction hashes, amounts and recovery words stay left to right. Amounts take the
language's group and decimal marks (2,047,243.4405 in English, 2 047 243,4405 in Russian, 2.047.243,4405 in German;
Spanish and Italian leave a four-digit whole part ungrouped), every digit kept. An amount field holds the figure as
digits and one decimal point, with no more places than the asset has (the mobile wallet's rule): a typed comma is the
decimal mark, spaces and apostrophes are dropped, a comma and a point together take the last one as the decimal mark
and the other as grouping in threes, and a figure pasted in the language's format is read as written (a copied "1,000"
in English or "1.000" in German is 1000, while "1,000" typed is 1.000). Error
codes from the service worker are shown in the chosen language. Brand and token names (QNet Blockchain, Solana, 1DEV, QNC, SOL), the recovery words, addresses, codes and the environment variable names are never
translated. The extension's name and description in the browser and the store come from
`dist/_locales` in the same languages.

`test/i18n.test.mjs` checks that every language has every text with the same placeholders, keeps the
untranslatable names and the mobile terms, and that no page carries text of its own.
`npm run check:overflow` opens every screen of the popup (360 px wide), the setup tab (360 and 800 px)
and the approval window (400 and 360 px) in every language in headless Chrome and fails when anything
is wider or taller than its box.

## Related documents

- [Mobile wallet](mobile-wallet.md): the same derivation, the verifying light client, and the Node
  tab where the light node runs on a phone or tablet.
- [Node activation](../economics/node-activation.md): how nodes verify the burn and the code.
- [QNet Link v1](../protocols/qnet-link-v1.md): activation from aiqnet.io, with the extension or the
  mobile app; revision 2 (section 14) for the cabinet and the extension's methods.
- [Light node messages](../protocols/light-node-messages.md): what the wallet key and the burner sign for the
  registration, the move of the node balance and the unlink of the node's device.
- [Cryptography](../architecture/cryptography.md): ML-DSA-65 parameters and the address format.
- [RPC API](../developers/rpc-api.md): the node endpoints used here.

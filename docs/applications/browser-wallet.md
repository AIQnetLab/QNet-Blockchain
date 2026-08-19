# Browser wallet extension

This document describes the QNet browser extension in `applications/qnet-wallet`: a Manifest V3
extension that derives the same post-quantum QNet identity as the mobile wallet from a BIP39
mnemonic, keeps an encrypted vault in extension storage, signs native QNC transfers with ML-DSA-65,
and exposes a small provider API to web pages.

## Layout

| Path | Role |
| --- | --- |
| `dist/manifest.json` | Manifest V3 declaration |
| `dist/background.js` | Service worker: wallet state, crypto, node RPC, provider dispatch |
| `dist/popup.js`, `dist/popup.html` | Extension popup UI |
| `dist/setup.js`, `dist/setup.html` | Wallet creation and import flow |
| `dist/content.js` | Content script: relays page messages to the service worker |
| `dist/lib/` | Vendored libraries: the ML-DSA-65 bundle, tweetnacl, crypto-js, qrious, Solana helpers |
| `dist/src/crypto/`, `dist/src/security/` | The modules the HTML pages load directly |
| `tools/dilithium-wasm/` | esbuild script and entry point that produce the ML-DSA-65 bundle |

`dist/` is the loadable unpacked extension and is committed as-is; the build step covers only the
cryptography bundle. The pages that run — the popup and the setup flow — load
`src/crypto/DilithiumManager.js`, `src/crypto/Ed25519.js`, `src/crypto/ProductionBIP39.js` and
`src/security/SecureKeyManager.js`.

## Manifest and target browsers

- `manifest_version: 3`, with a `background.service_worker` entry. That form is Chromium-specific, so
  the extension targets Chrome and other Chromium browsers (Edge, Brave).
- Permissions: `storage`, `activeTab`, `tabs`. Host permissions: `<all_urls>`.
- Content security policy for extension pages: `script-src 'self'; object-src 'none'; style-src
  'self' 'unsafe-inline';`.
- One content script, `content.js`, injected into `<all_urls>` at `document_start`.
- `web_accessible_resources` exposes `setup.html`, `setup.js`, `app.html`, `app.js` and the
  `styles/`, `scripts/`, `src/`, `icons/` and `lib/` directories to all URLs.
- Localisation files exist for 11 languages under `dist/src/i18n/locales/`.

## Build

Only the cryptography bundle is built:

```bash
cd applications/qnet-wallet
npm install
npm run build          # runs tools/dilithium-wasm/build.js
```

`tools/dilithium-wasm/build.js` uses esbuild to bundle `@noble/post-quantum` ML-DSA-65 plus the
canonical wallet derivation into `dist/lib/noble-pq-ml-dsa.js` as an IIFE that sets the global
`QNetDilithiumLib`. The output is plain JavaScript. Build targets are `chrome89`, `firefox89` and
`safari15`. `tools/dilithium-wasm/compat_test.js` checks key and signature sizes, deterministic
keygen and the envelope wire format.

## Identity and derivation

The bundle owns the canonical derivation so the extension cannot drift from the node and the mobile
app:

1. BIP39 seed: `PBKDF2-HMAC-SHA512(mnemonic, "mnemonic" + passphrase, 2048 iterations, 64 bytes)`.
2. Keygen seed: `SHAKE-256("QNET_WALLET_MLDSA65_v1:" + hex(bip39_seed))` truncated to 32 bytes.
3. ML-DSA-65 (FIPS 204) keypair from that seed: 1952-byte public key, 4032-byte secret key,
   3309-byte signature, byte-compatible with the PQClean build used on mobile and with the Rust node.
4. EON address: `SHA512(public key)` formatted as 19 hex characters, `eon`, 15 hex characters and an
   8-hex SHA3-256 checksum.

A golden mnemonic-to-EON vector is recorded in a header comment in `tools/dilithium-wasm/entry.js`
and is asserted on the node side. A Solana Ed25519 keypair is derived separately from the same
mnemonic and is used only on the Solana side.

## Key storage

- The wallet is encrypted with AES-256-GCM using a PBKDF2-SHA256 key at 600,000 iterations. Each
  encryption draws a fresh 32-byte salt and 12-byte IV.
- The encrypted vault lives in `chrome.storage.local`. The unlocked flag is kept in
  `chrome.storage.session` so it does not survive a browser restart.
- Auto-lock is enabled by default with a 15-minute timeout in the service worker's settings.
- Signing happens inside the service worker; key material stays in extension storage.

## Talking to a node

The service worker holds five hardcoded genesis endpoints on TCP port 8001 and picks one at random
per request. It then discovers additional peers through `/api/v1/peers`, keeping only entries above a
minimum reputation, and caches that set.

Endpoints used by the shipped service worker:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/account/{address}/balance` | QNC balance in nanoQNC |
| `GET /api/v1/macroblock/{index}` | `state_root` for the balance cross-check |
| `GET /api/v1/node/{address}/info` | Node status shown on the node tab |
| `GET /api/v1/network/stats` | Network summary |
| `GET /api/v1/peers` | Peer discovery |
| `POST /api/v1/transaction` | Signed transaction submission |

Solana calls go to the public `api.mainnet-beta.solana.com` / `api.devnet.solana.com` JSON-RPC
endpoints.

### Transaction signing

A native transfer is signed locally with the account's ML-DSA-65 secret key over the canonical
message the node re-derives:

```
q{chain_id}|transfer:{from}:{to}:{amount_nano}:{nonce}:{gas_price}:{gas_limit}
```

`q{chain_id}` is the chain tag (`q1337` on testnet); it must byte-match the node's `QNET_CHAIN_ID`.

The nonce is read from the node when the caller does not supply one; the defaults are `gas_price = 10`
and `gas_limit = 21000`. The signature and public key are posted to `/api/v1/transaction`, with the
signature carried in the `dilithium_sig_{pk_hex}_{base64}` envelope emitted by the bundle's
`signQNet`.

### Balance cross-check

`VERIFY_QNC_BALANCE` queries `/api/v1/macroblock/{index}` on up to five discovered nodes and accepts
the `state_root` when at least two thirds of the responding nodes agree. The flag the popup shows
reports that agreement. Balances checked against a committee quorum certificate and a folded
sparse-Merkle proof are available in the [mobile wallet](mobile-wallet.md).

## Page provider API

`content.js` runs at `document_start` and relays a message protocol between the page and the service
worker. A page posts `{target: 'qnet-content', method, params, id}` on `window`; the content script
checks `event.source === window` and `event.origin`, matches a per-request id, passes the page origin
explicitly as the target origin, and times each request out after 30 seconds.

Methods dispatched by the service worker:

| Method | Behaviour |
| --- | --- |
| `connect`, `qnet_requestAccounts` | Opens setup if no wallet exists, otherwise returns accounts |
| `qnet_accounts` | Current accounts |
| `qnet_chainId` | `solana-devnet` or `qnet-mainnet`, depending on the selected network |
| `qnet_getBalance` | Balance for the given address |
| `qnet_sendTransaction` | Signs a transfer and posts it to the node |
| `qnet_signMessage` | Signs an arbitrary message |
| `qnet_switchNetwork` | Switches between the QNet and Solana views |

Any other method is rejected with `Unknown method`.

Node activation is performed from the [mobile wallet](mobile-wallet.md) or per
[node activation](../economics/node-activation.md).

## Related documents

- [Mobile wallet](mobile-wallet.md) — same derivation, plus the verifying light client.
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65 parameters and the address format.
- [RPC API](../developers/rpc-api.md) — the node endpoints used here.
- [SDK](../developers/sdk.md) — the supported way to build a QNet client.

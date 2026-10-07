# QNet browser wallet

Manifest V3 browser extension for QNet. One recovery phrase gives the same post-quantum QNet account
(ML-DSA-65) and the same Solana account as the QNet mobile app. The extension keeps one encrypted
vault, signs QNC transfers and transfers of the built-in QNet tokens it holds, sends SOL and 1DEV, exports either
account's private key behind the password as it shows the recovery phrase, burns 1DEV for a node's activation code (one code per
wallet), records the wallet's light node on the QNet network after that burn, and connects to aiqnet.io and
games.aiqnet.io through a per-site, approval-gated provider that lets a page ask for QNC transfers, built-in token
transfers and contract calls, and lets aiqnet.io ask for the burn, for a move of the node balance into the wallet and
for the unlink of the light node's device, each shown and confirmed in the wallet's own window. It never runs a node: a
light node runs in QNet Wallet on a phone or tablet, a super node on your own server with the QNet node software; the
wallet key can end the light node on whatever device runs it.

Full documentation: [docs/applications/browser-wallet.md](../../docs/applications/browser-wallet.md)

## Build

```bash
npm run bundle:install   # npm ci in tools/crypto-bundle (pinned lockfile)
npm run build            # dist/lib/qnet-core.js
npm test                 # offline tests: bundle, modules, pages, the whole extension, the package
npm run test:live        # read-only checks against Solana devnet and the QNet nodes
npm run build:dev        # dist-dev/: dist plus localhost content-script matches (git-ignored); again after every dist change, npm test refuses a stale one
npm run package          # qnet-wallet-3.1.0.zip: the store package (git-ignored)
npm run check:overflow   # headless Chrome: every screen in every language, nothing overflows
```

`dist/` is the extension and loads unpacked as it is. `dist/lib/qnet-core.js` is its only crypto
module (its Argon2id is hash-wasm's WebAssembly, which is why the extension CSP allows
`'wasm-unsafe-eval'`). `tools/crypto-bundle` compiles it from pinned packages and from the mobile app's
`WalletIdentity`, `TxBuilders`, `NodePreimages`, `PasswordStrength`, `QcLightClient`, `SmtFold`,
`fees`, `genesisConsensus`, `tokenSafety` and `boundedFetch` sources (one copy of each for both apps), and the tests
require the shipped file to be byte-identical to a rebuild. `npm run package` zips exactly the
files `scripts/extension.mjs` lists as shipped. It runs only after the same module's load check
passes: every file the manifest and pages name exists, every import resolves, and every shipped
script and stylesheet is loaded. [CONTRACTS.md](CONTRACTS.md) is the agreement between the
modules: message types, the provider protocol, the vault format and the storage keys.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).

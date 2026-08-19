# QNet browser wallet

Browser extension wallet for QNet. It stores keys locally, signs transactions, and talks to a
QNet node over HTTP.

Full documentation: [docs/applications/browser-wallet.md](../../docs/applications/browser-wallet.md)

## Build

```bash
npm install
npm run build
```

The build output is written to `dist/`, which is the directory loaded as an unpacked extension.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).

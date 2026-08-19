# QNet mobile wallet

React Native wallet and light client for QNet. It holds keys, sends transactions, verifies
account state against committee quorum certificates, and can activate and monitor a Light node.

Full documentation: [docs/applications/mobile-wallet.md](../../docs/applications/mobile-wallet.md)

## Build

```bash
npm install
npm test
```

Android release builds are signed with a keystore that is not committed. See
[android/KEYSTORE_INFO.md](android/KEYSTORE_INFO.md).

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).

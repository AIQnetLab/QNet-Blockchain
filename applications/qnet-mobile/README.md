# QNet mobile wallet

React Native wallet and light client for QNet, one app for iPhone, iPad, Android phones and tablets. It holds keys,
sends transactions, verifies account state against committee quorum certificates, and runs this wallet's Light node on
one device. A super node is set up only with the QNet browser extension on a computer and runs on its own server, which
registers it; the Node tab only shows it. A light node is registered on aiqnet.io/node (the site's cabinet burns with a one-time payment key it creates
in the browser, once the app has confirmed that the site may prepare the wallet's light node) or by the QNet browser
extension. The app gives the wallet's consent to that registration and links the node to this device, or moves the node
balance, on a sheet that a verified `https://link.aiqnet.io/l` link opens
([QNet Link](../../docs/protocols/qnet-link-v1.md) section 14); its Node tab runs the node on this device ("Use this
device", after the system's device check), stops it, and moves the node balance. One device runs one node. Its Browser
tab opens websites that can connect the wallet through the same provider as the QNet browser extension; every connection, signature and send is
confirmed on the app's own sheet. The WebView library is pinned and patched
(`patches/react-native-webview+14.0.1.patch`, applied by `patch-package` on install) so that only a page's top
frame can reach the wallet and its origin always comes from the platform.

Full documentation: [docs/applications/mobile-wallet.md](../../docs/applications/mobile-wallet.md)

## Build

```bash
npm install
npm test
```

Android release builds are signed with a keystore that is not committed. See
[android/KEYSTORE_INFO.md](android/KEYSTORE_INFO.md).

## Release: refresh the light-client pin

The wallet verifies balances against committee-certified checkpoints by walking the committee lineage up
from a pinned macroblock, `WS_CHECKPOINT` in `src/config/genesisConsensus.js`. A device walks from the pin
to the chain head on first use, one proof per macroblock (960 a day), and nodes prune old committee
signatures (after about 15 days), so the pin must be recent. Before every release:

```bash
node scripts/ws-pin.js --write
npm run check:release -- --online
npm test
npm run audit:prod
```

The script only reads: HTTPS GETs to `node1`…`node5.aiqnet.io`. It proves the new pin from the committed one:
every macroblock in between verifies exactly as the phone verifies it (committee, registry-bound keys, quorum of
ML-DSA-65 votes, epoch commitment), and every genesis node that answers (at least four) must serve identical data
for each. Whoever answers for those names at release time therefore cannot root the pin in keys of their own. The
new pin records the pin it was proven from (`provenFrom`). It walks every macroblock in between, so refresh the pin
for every release and at least every two weeks, while the nodes still keep the signatures to walk.

`npm run check:release` (scripts/release-check.js) refuses a release whose pin is more than 14 days old, was not
proven from a previous pin, or (with `--online`) lies further below the head than the nodes keep signatures for.
`--bootstrap` makes ws-pin.js take the base from genesis-node agreement instead, for a chain with no pin to prove
from; such a pin passes the check only with `--allow-bootstrap`. Commit the rewritten file with the release.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).

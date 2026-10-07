// The native known-answer tests hold the vectors' values as constants (a device test cannot read the repository): they
// must stay the values of docs/protocols/light-node.vectors.json.
const fs = require('fs');
const path = require('path');
const V = require('../../../docs/protocols/light-node.vectors.json');

it('the Android wallet-key test pins the seed strings and addresses of both vector phrases', () => {
  const kt = fs.readFileSync(path.join(__dirname, '../android/app/src/androidTest/java/com/qnetmobile/WalletKeyKatTest.kt'), 'utf8');
  const pairs = [...kt.matchAll(/"(QNET_WALLET_MLDSA65_v1:[0-9a-f]{128})"\s*to\s*"([0-9a-f]{19}eon[0-9a-f]{23})"/g)].map((m) => [m[1], m[2]]);
  expect(pairs).toEqual(V.wallets.map((w) => [w.seedString, w.address]));
});

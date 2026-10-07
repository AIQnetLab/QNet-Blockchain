// Pure-Dilithium genesis wallets: eon = SHA512(wallet ML-DSA-65 pk), byte-identical to the node's GENESIS_WALLETS.
// A genesis node is linked only to its own wallet.
export const GENESIS_WALLETS = Object.freeze({
  '001': '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d',
  '002': 'c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b',
  '003': '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff',
  '004': 'a60999a5a40637c1dd6eon975ca9618927edd7c19f38e',
  '005': '9dd783e0c65cf68467ceondfeaed5e1e47f0242f6aed9',
});

export function genesisWalletMatches(bootstrapId, qnetAddress) {
  const expected = GENESIS_WALLETS[bootstrapId];
  return !!expected && String(qnetAddress || '').toLowerCase() === expected;
}

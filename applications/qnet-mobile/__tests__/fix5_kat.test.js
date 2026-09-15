/**
 * Cross-language wallet KAT. The vector is the Rust node's
 * (genesis_key.rs::wallet_cross_client_kat_vector) and the extension pins the same numbers in
 * qnet-wallet/tools/dilithium-wasm/compat_test.js. What is pinned here is everything AROUND the
 * ML-DSA-65 KeyGen — the seed string it consumes, the address derived from its public key, and the
 * bytes a transfer signs. KeyGen itself is the native module and cannot run under Jest, so a native
 * bump still has to be checked on-device; a drift in any of the pure-JS halves is caught here.
 */
const { sha3_256, shake256 } = require('js-sha3');
const vector = require('./fixtures/wallet_kat.json');
// The SHIPPED derivation, not a copy of it.
const {
  walletSeedString, eonFromPublicKeyBytes, transferPreimage, QNET_CHAIN_TAG,
} = require('../src/crypto/WalletIdentity');

const seedBytes = Uint8Array.from(vector.bip39_seed_hex.match(/../g).map((h) => parseInt(h, 16)));
const pkBytes = Uint8Array.from(vector.pk_hex.match(/../g).map((h) => parseInt(h, 16)));

test('the canonical seed string SHAKE-256s to the golden keygen seed', () => {
  const s = walletSeedString(seedBytes);
  expect(s).toBe(vector.seed_string);
  // xi is what the native module feeds ML-DSA-65 KeyGen; the string is what this app builds.
  expect(shake256(s, 256)).toBe(vector.xi_shake256);
});

test('the golden public key is the one the node pins', () => {
  expect(pkBytes).toHaveLength(1952);
  expect(sha3_256(pkBytes)).toBe(vector.pk_sha3_256);
});

test('the EON address derived from that key matches the node byte for byte', () => {
  const eon = eonFromPublicKeyBytes(pkBytes);
  expect(eon).toBe(vector.eon_address);
  expect(eon).toHaveLength(45);
  expect(eon.slice(19, 22)).toBe('eon'); // positional tag the node checks
});

test('a one-bit change in the public key changes the address', () => {
  const flipped = Uint8Array.from(pkBytes);
  flipped[0] ^= 1;
  expect(eonFromPublicKeyBytes(flipped)).not.toBe(vector.eon_address);
});

// The node rebuilds this exact string and verifies the detached ML-DSA-65 signature against it, so an
// unbound or reordered preimage is indistinguishable from an invalid signature in the log.
test('a transfer signs the chain-bound canonical preimage', () => {
  const to = 'd9fa370374e24333242eon847d1d354dcd87fe873823f';
  const msg = transferPreimage(vector.eon_address, to, 1500000000, 1, 10, 21000);
  expect(msg).toBe(
    'q1337|transfer:' + vector.eon_address + ':' + to + ':1500000000:1:10:21000',
  );
  expect(msg.startsWith(QNET_CHAIN_TAG)).toBe(true);
});

test('the chain tag is part of the signed bytes, not a wrapper', () => {
  const a = transferPreimage('from', 'to', 1, 1, 10, 21000);
  const b = transferPreimage('from', 'to', 2, 1, 10, 21000);
  expect(a).not.toBe(b);
  expect(a.slice(QNET_CHAIN_TAG.length)).toBe('transfer:from:to:1:1:10:21000');
});

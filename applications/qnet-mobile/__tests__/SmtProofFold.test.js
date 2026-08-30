/**
 * Cross-language pin for the account-proof fold. The root and proof in the fixture are emitted by
 * the Rust side (`state::merkle_equiv_tests::smt_cross_language_vector_is_pinned`); the device folds
 * them in JS. Any divergence in bit order, leaf preimage or sibling ordering breaks every light
 * client silently, so both sides are pinned to the same numbers.
 */
const { sha3_256 } = require('js-sha3');
const vector = require('./fixtures/smt_account_proof.json');
// The SHIPPED fold, not a copy of it — a re-implementation would pin the fixture, not the code.
const { smtFold } = require('../src/crypto/SmtFold');

// Mirrors WalletManager._smtFold + its account leaf preimage without pulling in React Native.
function concatBytes(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}
function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function accountLeaf(address, balance, nonce) {
  return sha3_256(concatBytes(
    Buffer.from('QNET_ACCOUNT_V2:', 'utf8'),
    u64le(balance),
    u64le(nonce),
    Buffer.from(address, 'utf8'),
    Buffer.from([0]),
    Buffer.from('HB:', 'utf8'),
    u64le(0), Buffer.from([0, 0]), u64le(0), Buffer.from([0, 0]),
    Buffer.from('LCE:', 'utf8'), u64le(0),
    Buffer.from('BAN:', 'utf8'), u64le(0),
    Buffer.from('NODE:', 'utf8'), Buffer.from([0]),
  ));
}

const addrHash = sha3_256(concatBytes(Buffer.from('QNET_ADDR:', 'utf8'), Buffer.from(vector.address, 'utf8')));
const leaf = accountLeaf(vector.address, vector.balance, vector.nonce);

test('proof is a full-depth SMT proof', () => {
  expect(vector.proof).toHaveLength(40);
});

test('the shipped fold reproduces the Rust state_root', () => {
  expect(smtFold(leaf, addrHash, vector.proof, vector.state_root, sha3_256)).toBe(true);
});

test('a proof folded against the wrong root is rejected', () => {
  const wrong = 'ff'.repeat(32);
  expect(smtFold(leaf, addrHash, vector.proof, wrong, sha3_256)).toBe(false);
});

test('a tampered balance breaks the fold', () => {
  const bad = accountLeaf(vector.address, Number(vector.balance) + 1, vector.nonce);
  expect(smtFold(bad, addrHash, vector.proof, vector.state_root, sha3_256)).toBe(false);
});

test('a flipped is_right bit is rejected before hashing', () => {
  const tampered = vector.proof.map((p, i) => (i === 250 ? { ...p, is_right: !p.is_right } : p));
  expect(smtFold(leaf, addrHash, tampered, vector.state_root, sha3_256)).toBe(false);
});

/**
 * Cross-language pin for registry_root. The root is emitted by the Rust side
 * (`registry_lthash::tests::print_registry_root_cross_language_vector`); the device recomputes it in
 * JS from a served /registry/{h} dump. A preimage change on one side and not the other rejects every
 * registry proof — and therefore every committee pubkey the light client resolves — silently.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn() }));

const { recomputeRegistryRoot } = require('../src/crypto/QcLightClient');

// Exactly the rows the Rust emitter folds, in the same order.
const ENTRIES = [
  {
    node_id: 'genesis_node_001', wallet: 'wallet_g1', reg_height: 10, reg_index: 0,
    node_type: 'super', burn: 'burn_g1', vrf_pk_sha3: 'ab'.repeat(32),
  },
  {
    node_id: 'super_abc123', wallet: 'wallet_s1', reg_height: 4200, reg_index: 1,
    node_type: 'super', burn: 'burn_s1', vrf_pk_sha3: 'ab'.repeat(32),
  },
  {
    node_id: 'light_def456', wallet: 'wallet_l1', reg_height: 9001, reg_index: 2,
    node_type: 'light', burn: '', vrf_pk_sha3: '',
  },
];

const RUST_ROOT = 'a3b7cbb3aa2e3a4829e98569c2e6bc63ba4a1480c09845fc5525c511b9c4b30a';

test('JS registry_root matches the Rust root byte for byte', () => {
  expect(recomputeRegistryRoot(ENTRIES)).toBe(RUST_ROOT);
});

test('the fold is order-independent, as LtHash requires', () => {
  const reversed = [...ENTRIES].reverse();
  expect(recomputeRegistryRoot(reversed)).toBe(RUST_ROOT);
});

test('a flipped node_type changes the root', () => {
  // This is the hole v4 closed: before node_type entered the preimage, flipping a super to "light"
  // added it to the light roster while the root still matched.
  const flipped = ENTRIES.map((e, i) => (i === 1 ? { ...e, node_type: 'light' } : e));
  expect(recomputeRegistryRoot(flipped)).not.toBe(RUST_ROOT);
});

test('a shifted reg_index changes the root', () => {
  const shifted = ENTRIES.map((e, i) => (i === 2 ? { ...e, reg_index: 7 } : e));
  expect(recomputeRegistryRoot(shifted)).not.toBe(RUST_ROOT);
});

test('a missing reg_index is not silently treated as a match', () => {
  const stripped = ENTRIES.map(({ reg_index, ...rest }) => rest);
  expect(recomputeRegistryRoot(stripped)).not.toBe(RUST_ROOT);
});

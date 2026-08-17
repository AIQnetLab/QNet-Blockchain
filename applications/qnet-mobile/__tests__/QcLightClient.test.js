/**
 * The light client's trust root. These pin the one property the whole verifier rests on: committee
 * pubkeys are bound to a checkpoint the device has ALREADY verified, never to the checkpoint whose
 * QC those keys are about to authenticate.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn() }));

const { sha3_256 } = require('js-sha3');
const { resolvePubkeys, recomputeRegistryRoot, quorumSize } = require('../src/crypto/QcLightClient');

// A registry row binds a node to a pubkey by sha3(pk); the root is the LtHash over the rows.
function entry(nodeId, pkHex, regHeight = 90, regIndex = 0) {
  return {
    node_id: nodeId,
    wallet: 'w_' + nodeId,
    reg_height: regHeight,
    reg_index: regIndex,
    node_type: 'super',
    burn: '',
    vrf_pk_sha3: sha3_256(Buffer.from(pkHex, 'hex')),
  };
}

const COMMITTEE = ['n1', 'n2', 'n3', 'n4', 'n5'];
const HONEST = Object.fromEntries(COMMITTEE.map((id, i) => [id, (String(i + 1).repeat(2)).repeat(16)]));
const FORGED = Object.fromEntries(COMMITTEE.map((id, i) => [id, (String(9 - i).repeat(2)).repeat(16)]));

const honestEntries = COMMITTEE.map((id, i) => entry(id, HONEST[id], 90, i));
const forgedEntries = COMMITTEE.map((id, i) => entry(id, FORGED[id], 90, i));
const HONEST_ROOT = recomputeRegistryRoot(honestEntries);
const FORGED_ROOT = recomputeRegistryRoot(forgedEntries);

const need = quorumSize(COMMITTEE.length);

test('binds committee pubkeys when the served registry matches the anchor root', async () => {
  const fetchRegistry = async () => ({ entries: honestEntries });
  const pks = await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, HONEST, fetchRegistry, need);
  expect(pks).not.toBeNull();
  expect(Object.keys(pks).sort()).toEqual(COMMITTEE.slice().sort());
});

// THE regression. A server that mints its own keypairs can always publish a registry and a
// checkpoint whose registry_root matches that registry — the two are its own. It only fails
// because the root is taken from an ancestor the device already certified.
test('rejects a self-consistent forged registry + checkpoint pair', async () => {
  const fetchRegistry = async () => ({ entries: forgedEntries });
  expect(FORGED_ROOT).not.toEqual(HONEST_ROOT);
  // Server-supplied cp.registry_root would be FORGED_ROOT and would match its own registry.
  const pks = await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, FORGED, fetchRegistry, need);
  expect(pks).toBeNull();
});

test('rejects a pubkey that does not hash to its registry commitment', async () => {
  const fetchRegistry = async () => ({ entries: honestEntries });
  const swapped = { ...HONEST, n1: FORGED.n1 };
  // n1 is dropped (sha3 mismatch); 4 of 5 bound is below quorumSize(5) = 4? -> 4 >= 4 passes,
  // so require the full set to make the drop observable.
  const pks = await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, swapped, fetchRegistry, COMMITTEE.length);
  expect(pks).toBeNull();
});

// A committee member whose key the server cannot supply must not kill the macroblock: the walk is
// bottom-up, so one dead index makes every higher index on that parity chain unverifiable.
test('tolerates a missing key while the threshold is still reachable', async () => {
  const fetchRegistry = async () => ({ entries: honestEntries });
  const partial = { ...HONEST };
  delete partial.n5;
  const pks = await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, partial, fetchRegistry, need);
  expect(pks).not.toBeNull();
  expect(Object.keys(pks)).toHaveLength(4);
  expect(pks.n5).toBeUndefined();
});

test('fails closed once too few keys bind to reach the threshold', async () => {
  const fetchRegistry = async () => ({ entries: honestEntries });
  const partial = { n1: HONEST.n1, n2: HONEST.n2 };
  const pks = await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, partial, fetchRegistry, need);
  expect(pks).toBeNull();
});

test('fails closed when the registry fetch is unusable', async () => {
  const boom = async () => { throw new Error('offline'); };
  expect(await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, HONEST, boom, need)).toBeNull();
  const malformed = async () => ({});
  expect(await resolvePubkeys(COMMITTEE, HONEST_ROOT, 90, HONEST, malformed, need)).toBeNull();
});

// total_supply is nanoQNC and exceeds 2^53. The node MUST serve it as a JSON string; if it ever
// reverts to a number, JSON.parse rounds it and every checkpoint hash is wrong — a silent, total
// false-reject that would only surface years in (first halving). Pin both directions.
const { checkpointHash } = require('../src/crypto/QcLightClient');

function cpWith(totalSupply) {
  return {
    index: 7, parent_qc: null, window_head_height: 630,
    window_mb_hashes: ['11'.repeat(32)], state_root: '22'.repeat(32), beacon: '33'.repeat(32),
    epoch_commitment: '44'.repeat(32), reward_root: '55'.repeat(32), registry_root: '66'.repeat(32),
    logs_root: '77'.repeat(32), dilithium_pk_root: '88'.repeat(32), reward_epoch_root: '99'.repeat(32),
    total_supply: totalSupply, timestamp: 1700000000, proposer: 'genesis_node_001',
    recovery_anchor: null,
  };
}

test('checkpointHash folds total_supply exactly past 2^53', () => {
  // A post-halving-shaped value that is NOT representable as a double.
  const exact = '2305843009213693953'; // 2^61 + 1
  expect(Number.isSafeInteger(Number(exact))).toBe(false);
  const viaString = checkpointHash(cpWith(exact));
  const viaBigInt = checkpointHash(cpWith(BigInt(exact)));
  expect(viaString).toEqual(viaBigInt);
  // The rounded double a JSON-number wire format would produce must hash DIFFERENTLY — proving the
  // string form is load-bearing rather than incidentally equal.
  const viaRoundedDouble = checkpointHash(cpWith(Number(exact)));
  expect(viaRoundedDouble).not.toEqual(viaString);
});

test('checkpointHash is stable for ordinary in-range supplies', () => {
  const v = '251432340000000';
  expect(checkpointHash(cpWith(v))).toEqual(checkpointHash(cpWith(Number(v))));
});

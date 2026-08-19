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

// ── recovery anchor on device ──────────────────────────────────────────────
// The device applies the NODE's rule: a checkpoint carrying a recovery anchor is refused outright,
// and the bar a certificate must meet is always the strict quorum. Accepting a relaxed certificate
// would confirm a balance the chain never finalized — a verifying client that accepts what the
// network rejects is worse than a trusting one.
const { checkpointContentDigest, checkpointQuorum } = require('../src/crypto/QcLightClient');

function anchorCp(overrides) {
  return Object.assign({
    index: 17, parent_qc: null, window_head_height: 4 * 90,
    window_mb_hashes: [], state_root: '01'.repeat(32), beacon: '02'.repeat(32),
    epoch_commitment: '03'.repeat(32), reward_root: '00'.repeat(32),
    registry_root: '00'.repeat(32), logs_root: '00'.repeat(32),
    dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
    total_supply: '0', timestamp: 0, proposer: 'cs_0000', recovery_anchor: null,
  }, overrides || {});
}

test('content digest excludes the consensus position and the anchor', () => {
  const base = anchorCp();
  // A legal re-proposal of one window at a new index by another member digests IDENTICALLY: the
  // digest names WHAT a checkpoint commits, never where in the round order it sat.
  expect(checkpointContentDigest(anchorCp({ index: 25, proposer: 'cs_0003' })))
    .toEqual(checkpointContentDigest(base));
  // The anchor is outside it too — carrying one changes a checkpoint's admissibility, not its content.
  expect(checkpointContentDigest(anchorCp({ recovery_anchor: [3, 'ab'.repeat(32)] })))
    .toEqual(checkpointContentDigest(base));
  expect(checkpointContentDigest(anchorCp({ state_root: 'ff'.repeat(32) })))
    .not.toEqual(checkpointContentDigest(base));
});

// CROSS-LANGUAGE PARITY VECTOR for checkpointContentDigest and checkpointHash. The same checkpoints
// and the same hex strings are pinned in core/qnet-consensus/src/checkpoint_bft.rs
// (checkpoint_hash_matches_the_mobile_client_byte_for_byte). checkpointHash is the QC vote preimage:
// a drift in field order, the anchor tag byte, the length prefix on window_mb_hashes or u64
// endianness makes the device reject every honest checkpoint, with the chain running happily.
const KAT = {
  index: 4,
  parent_qc: { index: 3, checkpoint_hash: '02'.repeat(32) },
  window_head_height: 120,
  window_mb_hashes: ['01'.repeat(32)],
  state_root: '03'.repeat(32), beacon: '04'.repeat(32), epoch_commitment: '05'.repeat(32),
  reward_root: '00'.repeat(32), registry_root: '00'.repeat(32), logs_root: '00'.repeat(32),
  dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
  total_supply: 7, timestamp: 11, proposer: 'n1', recovery_anchor: null,
};

test('checkpoint digests match the Rust vectors byte for byte', () => {
  const pinned  = Object.assign({}, KAT, { recovery_anchor: [2, '08'.repeat(32)] });
  const zeroPin = Object.assign({}, KAT, { recovery_anchor: [0, '00'.repeat(32)] });

  // The anchor is NOT in the content digest, so all three digest identically. It IS in the hash,
  // which the QC signatures cover — which is why the device must fold it to check any signature.
  expect(checkpointContentDigest(KAT))
    .toEqual('5b9d0304967b92246400630f54df59d6ee2ae7388aa8cf0b7c25dd8d7360eba1');
  expect(checkpointContentDigest(pinned)).toEqual(checkpointContentDigest(KAT));
  expect(checkpointContentDigest(zeroPin)).toEqual(checkpointContentDigest(KAT));

  expect(checkpointHash(KAT))
    .toEqual('13fe6687b356572863ca25a3d0c225a30b904a03f5fed4a8574b22a80bf29be7');
  expect(checkpointHash(pinned))
    .toEqual('acc2f0a5102a91fc013b9e6f023ba77aa4843a2f056a2d97aa57ea1302993474');
  expect(checkpointHash(zeroPin))
    .toEqual('8a463e680bb577b1ffb0569f2f4576bae6d23d7a1b2a92fa7e5e6c9428bf14f7');
});

test('the bar is the strict quorum, and an anchored checkpoint has no bar at all', () => {
  const committee = Array.from({ length: 12 }, (_, i) => 'cs_' + String(i).padStart(4, '0'));
  expect(checkpointQuorum(anchorCp(), committee)).toEqual(quorumSize(committee.length));
  // n/2+1 was the old relaxed bar; nothing on the wire may select it any more.
  expect(checkpointQuorum(anchorCp(), committee)).toBeGreaterThan(committee.length / 2 + 1);
  // Any anchor refuses — well-formed or not. The device does not judge the pin, it rejects the
  // checkpoint, which is what every full node does.
  expect(checkpointQuorum(anchorCp({ recovery_anchor: [4, 'ab'.repeat(32)] }), committee)).toBeNull();
  expect(checkpointQuorum(anchorCp({ recovery_anchor: [0, '00'.repeat(32)] }), committee)).toBeNull();
});

// ── the refusal, end to end ────────────────────────────────────────────────
// A malicious server serving a well-formed, fully-signed checkpoint that carries a recovery anchor
// must not confirm a state_root. This is the finding: the chain rejects such a macroblock outright,
// so a device that accepted it would show a balance the network never finalized.
const {
  verifyMacroblockStateRoot, clearQcCache, epochCommitment,
} = require('../src/crypto/QcLightClient');
const { GENESIS_NODE_IDS } = require('../src/config/genesisConsensus');
const { verifyDilithium } = require('../src/crypto/DilithiumCrypto');

// bincode Vec<EligibleProducer>: u64le count, then per entry u64le len ++ utf8 id ++ u32le reputation.
function eligibleRawHex(ids) {
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(ids.length));
  const parts = [head];
  for (const id of ids) {
    const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(id.length));
    const r = Buffer.alloc(4); r.writeUInt32LE(7000);
    parts.push(l, Buffer.from(id, 'utf8'), r);
  }
  return Buffer.concat(parts).toString('hex');
}

// "dilithium_sig_<id>_<b64>" where b64 = u32le(len) ++ [3309-byte detached sig][msg].
function wireSig(nodeId) {
  const sig = Buffer.alloc(3309, 7);
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length);
  return 'dilithium_sig_' + nodeId + '_' + Buffer.concat([len, sig]).toString('base64');
}

const GENESIS_STATE_ROOT = 'aa'.repeat(32);
const ELIGIBLE_HEX = eligibleRawHex(GENESIS_NODE_IDS);

// Macroblock 2 sits in the genesis era, so the committee and its pubkeys are binary-pinned and the
// walk needs no served registry — the smallest proof that reaches the QC gate.
function genesisProof(recoveryAnchor) {
  const cp = {
    index: 2, parent_qc: null, window_head_height: 180, window_mb_hashes: [],
    state_root: GENESIS_STATE_ROOT, beacon: 'bb'.repeat(32),
    epoch_commitment: epochCommitment(Buffer.from(ELIGIBLE_HEX, 'hex'), GENESIS_NODE_IDS, []),
    reward_root: '00'.repeat(32), registry_root: '00'.repeat(32), logs_root: '00'.repeat(32),
    dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
    total_supply: '0', timestamp: 0, proposer: 'genesis_node_001',
    recovery_anchor: recoveryAnchor || null,
  };
  const signers = GENESIS_NODE_IDS.slice(0, quorumSize(GENESIS_NODE_IDS.length));
  return {
    index: 2, checkpoint: cp, eligible_raw: ELIGIBLE_HEX, banned: [],
    qc: { signers, sigs: signers.map(wireSig) },
  };
}

function serve(proof) {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => proof }));
  return () => 'http://server';
}

beforeEach(() => {
  clearQcCache();
  verifyDilithium.mockReset();
  verifyDilithium.mockResolvedValue(true); // every served signature is genuine
});

test('an honest genesis-era macroblock certifies its state_root', async () => {
  const boot = serve(genesisProof(null));
  await expect(verifyMacroblockStateRoot(GENESIS_STATE_ROOT, 180, boot)).resolves.toBe(true);
  expect(verifyDilithium).toHaveBeenCalled();
});

test('refuses an anchored checkpoint even when every committee signature verifies', async () => {
  const boot = serve(genesisProof([1, '08'.repeat(32)]));
  await expect(verifyMacroblockStateRoot(GENESIS_STATE_ROOT, 180, boot)).resolves.toBe(false);
  // Refused on the anchor alone: no signature is ever opened, so no signer count can rescue it.
  expect(verifyDilithium).not.toHaveBeenCalled();
});

test('refuses an anchored checkpoint signed by the WHOLE committee', async () => {
  const proof = genesisProof([1, '08'.repeat(32)]);
  proof.qc.signers = GENESIS_NODE_IDS.slice();
  proof.qc.sigs = proof.qc.signers.map(wireSig);
  const boot = serve(proof);
  await expect(verifyMacroblockStateRoot(GENESIS_STATE_ROOT, 180, boot)).resolves.toBe(false);
});

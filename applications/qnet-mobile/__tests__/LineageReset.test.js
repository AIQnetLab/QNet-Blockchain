// Anchors kept from an earlier session that are not this chain's lineage (06.10): the first step above such an anchor is
// refused by several nodes for what ties it to the anchor, so the kept anchors go and the walk roots at the pin at once,
// instead of every balance check failing against them for good. One node's refusal, or nodes that do not answer, drop
// nothing; the pin and macroblocks verified in this session are never dropped.
const { sha3_256 } = require('js-sha3');

let lc;
let GENESIS_NODE_IDS;
let GENESIS_CONSENSUS_PKS;
jest.isolateModules(() => {
  jest.doMock('../src/config/genesisConsensus', () => ({
    ...jest.requireActual('../src/config/genesisConsensus'),
    WS_CHECKPOINT: { index: 0, hash: '00'.repeat(32), anchors: {} },
  }));
  jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(async () => true) }));
  lc = require('../src/crypto/QcLightClient');
  ({ GENESIS_NODE_IDS, GENESIS_CONSENSUS_PKS } = require('../src/config/genesisConsensus'));
});

jest.setTimeout(120000);

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

function wireSig(nodeId) {
  const sig = Buffer.alloc(3309, 7);
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length);
  return 'dilithium_sig_' + nodeId + '_' + Buffer.concat([len, sig]).toString('base64');
}

const IDS = GENESIS_NODE_IDS.slice();
const ELIGIBLE = eligibleRawHex(IDS);
const ENTRIES = IDS.map((id, i) => ({
  node_id: id, wallet: 'w_' + id, reg_height: 90, reg_index: i, node_type: 'super', burn: '',
  vrf_pk_sha3: sha3_256(Buffer.from(GENESIS_CONSENSUS_PKS[id], 'hex')),
}));
const REG_ROOT = lc.recomputeRegistryRoot(ENTRIES);
const BEACON = 'bb'.repeat(32);
const stateRootOf = (j) => (j % 256).toString(16).padStart(2, '0').repeat(32);

// A proof of macroblock j of the chain the nodes serve (the LineageWalk harness).
function proofFor(j) {
  const committee = j < 3 ? IDS.slice() : lc.sampleCommittee([...IDS].sort(), j, BEACON);
  const cp = {
    index: j, parent_qc: null, window_head_height: j * 90, window_mb_hashes: [],
    state_root: stateRootOf(j), beacon: BEACON,
    epoch_commitment: lc.epochCommitment(Buffer.from(ELIGIBLE, 'hex'), committee, []),
    reward_root: '00'.repeat(32), registry_root: REG_ROOT, logs_root: '00'.repeat(32),
    dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
    total_supply: '0', timestamp: 0, proposer: IDS[0], recovery_anchor: null,
  };
  const signers = committee.slice(0, lc.quorumSize(committee.length));
  return {
    index: j, checkpoint: cp, eligible_raw: ELIGIBLE, banned: [],
    committee_pubkeys: Object.fromEntries(committee.map((id) => [id, GENESIS_CONSENSUS_PKS[id]])),
    qc: { signers, sigs: signers.map(wireSig) },
  };
}

// An anchor of another lineage: another eligible set, beacon and registry, as a chain that started again would leave.
const FOREIGN = { eligible_ids: ['other_node_a', 'other_node_b'], beacon: 'cc'.repeat(32), registry_root: 'dd'.repeat(32) };
const N1 = 'https://node1.aiqnet.io';
const N2 = 'https://node2.aiqnet.io';

let asked;
function serveChain({ down = [] } = {}) {
  asked = [];
  global.fetch = jest.fn(async (url) => {
    if (down.some((d) => url.startsWith(d))) throw new TypeError('Network request failed');
    const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
    if (m) {
      asked.push(Number(m[1]));
      return { ok: true, json: async () => proofFor(Number(m[1])) };
    }
    if (/\/registry\/height\//.test(url)) return { ok: true, json: async () => ({ entries: ENTRIES }) };
    throw new TypeError('Network request failed');
  });
}

beforeEach(() => lc.clearQcCache());

it('the harness: with nothing kept, the walk verifies from the root', async () => {
  serveChain();
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(24), 24 * 90, () => [N1, N2])).resolves.toBe(true);
  expect(asked[0]).toBe(2);
});

it('a kept anchor two nodes refuse the next step of goes, and the same call walks from the root and verifies', async () => {
  serveChain();
  expect(lc.importVerifiedAnchors({ 20: FOREIGN, 21: FOREIGN })).toBe(2);
  expect(lc.highestVerifiedIndex()).toBe(21);
  const resets = [];
  const ok = await lc.verifyMacroblockStateRoot(stateRootOf(24), 24 * 90, () => [N1, N2], { onLineageReset: () => resets.push(1) });
  expect(ok).toBe(true);
  expect(resets).toEqual([1]);
  // Step 22 was asked above the kept anchor first (both nodes; the walk fetches the next step ahead, so 24 may come
  // between), then the walk started again at the root.
  const fromRoot = asked.indexOf(2);
  expect(fromRoot).toBeGreaterThan(0);
  expect(asked.slice(0, fromRoot).filter((j) => j === 22)).toEqual([22, 22]);
  expect(asked.slice(0, fromRoot).every((j) => j > 20)).toBe(true);
  // Both kept anchors went (they came from one stored record); what this walk verified stays.
  expect(Object.keys(lc.exportVerifiedAnchors()).map(Number)).toEqual([24]);
  expect(lc.highestVerifiedIndex()).toBe(24);
});

it('one node refusing it drops nothing', async () => {
  serveChain();
  lc.importVerifiedAnchors({ 20: FOREIGN });
  const resets = [];
  const ok = await lc.verifyMacroblockStateRoot(stateRootOf(24), 24 * 90, () => [N1], { onLineageReset: () => resets.push(1) });
  expect(ok).toBe(false);
  expect(resets).toEqual([]);
  expect(lc.highestVerifiedIndex()).toBe(20);
});

it('nodes that do not answer drop nothing: an unreachable step says nothing about the anchor', async () => {
  serveChain({ down: [N1, N2] });
  lc.importVerifiedAnchors({ 20: FOREIGN });
  const resets = [];
  const ok = await lc.verifyMacroblockStateRoot(stateRootOf(24), 24 * 90, () => [N1, N2], { onLineageReset: () => resets.push(1) });
  expect(ok).toBe(false);
  expect(resets).toEqual([]);
  expect(lc.highestVerifiedIndex()).toBe(20);
});

it('a kept anchor of this lineage is resumed from as before, and nothing is dropped', async () => {
  serveChain();
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(20), 20 * 90, () => [N1])).resolves.toBe(true);
  const kept = lc.exportVerifiedAnchors();
  lc.clearQcCache();
  lc.importVerifiedAnchors(kept);
  asked.length = 0;
  const resets = [];
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(24), 24 * 90, () => [N1, N2], { onLineageReset: () => resets.push(1) }))
    .resolves.toBe(true);
  expect(asked).toEqual([22, 24]);
  expect(resets).toEqual([]);
});

it('the chain identity is a fingerprint of the pinned genesis identities', () => {
  const id = lc.chainIdentity();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  const ids = [...GENESIS_NODE_IDS].sort();
  expect(id).toBe(sha3_256(Buffer.from(ids.map((n) => `${n}:${GENESIS_CONSENSUS_PKS[n]}`).join('|'), 'utf8')).slice(0, 32));
  expect(lc.chainIdentity()).toBe(id);
});

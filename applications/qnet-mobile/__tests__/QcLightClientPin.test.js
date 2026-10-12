/**
 * Weak-subjectivity pin: rooting the inductive walk at K instead of genesis. Both parity chains must
 * root, a half-filled pin must fail closed, and the pinned index itself must stay unprovable.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn() }));

// eligible_raw is a bincode Vec<EligibleProducer>: u64le count, then per entry u64le len + utf8 id +
// u32le reputation. Build one so decodeEligibleNodeIds returns real ids.
function eligibleRawHex(ids) {
  const parts = [Buffer.alloc(8)];
  parts[0].writeBigUInt64LE(BigInt(ids.length));
  for (const id of ids) {
    const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(id.length));
    const r = Buffer.alloc(4); r.writeUInt32LE(7000);
    parts.push(l, Buffer.from(id, 'utf8'), r);
  }
  return Buffer.concat(parts).toString('hex');
}

const IDS = ['super_0001', 'super_0002', 'super_0003', 'super_0004', 'super_0005'];

function loadWithPin(pin) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../src/config/genesisConsensus', () => {
      const real = jest.requireActual('../src/config/genesisConsensus');
      return { ...real, WS_CHECKPOINT: pin };
    });
    mod = require('../src/crypto/QcLightClient');
  });
  return mod;
}

const INERT = { index: 0, hash: '00'.repeat(32), anchors: {} };

function goodPin(k) {
  const a = { eligible_raw: eligibleRawHex(IDS), beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) };
  return { index: k, hash: 'ef'.repeat(32), anchors: { [k]: a, [k - 1]: a } };
}

test('inert pin (WS=0) keeps the genesis-rooted trust floor', () => {
  const m = loadWithPin(INERT);
  expect(m.wsPinIsWellformed()).toBe(true);
  expect(m.trustFloorIndex()).toBe(1);
});

test('a well-formed pin roots the floor just above K', () => {
  const m = loadWithPin(goodPin(1000));
  expect(m.wsPinIsWellformed()).toBe(true);
  // K itself stays unprovable: the pin carries hash(MB_K), not its state_root.
  expect(m.trustFloorIndex()).toBe(1001);
});

test('a pin missing either parity anchor fails closed', () => {
  const full = goodPin(1000);
  const onlyK = { ...full, anchors: { 1000: full.anchors[1000] } };
  expect(loadWithPin(onlyK).wsPinIsWellformed()).toBe(false);
  const onlyPred = { ...full, anchors: { 999: full.anchors[999] } };
  expect(loadWithPin(onlyPred).wsPinIsWellformed()).toBe(false);
  const emptyField = {
    ...full,
    anchors: { 1000: { ...full.anchors[1000], registry_root: '' }, 999: full.anchors[999] },
  };
  expect(loadWithPin(emptyField).wsPinIsWellformed()).toBe(false);
  // K=1 has no predecessor macroblock to anchor the other parity.
  expect(loadWithPin({ ...full, index: 1 }).wsPinIsWellformed()).toBe(false);
});

// A pinned device must never fall back to a genesis walk: an unverifiable pin is refused, not ignored.
test('a malformed pin refuses verification instead of walking from genesis', async () => {
  const full = goodPin(1000);
  const m = loadWithPin({ ...full, anchors: { 1000: full.anchors[1000] } });
  const bootstrap = () => { throw new Error('must not fetch under a malformed pin'); };
  await expect(m.verifyMacroblockStateRoot('aa'.repeat(32), 1002 * 90, bootstrap)).resolves.toBe(false);
});
// The site's balance check walks from its own pin (applications/qnet-explorer/frontend/src/server/light/pin.ts, written by
// its scripts/light-pin.mjs, each step verified as here): the two pins lie on one lineage, the same macroblock with the
// same committee anchors, one proven from the other, or both proven from one pin. A device and the site then root at
// one chain, never at two.
test('the app\'s pin and the site\'s lie on one lineage', () => {
  const fs = require('fs');
  const path = require('path');
  const block = (file) => /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'))[0];
  const pinOf = (text) => {
    const from = /^\s*provenFrom: \{ index: (\d+), hash: '([0-9a-f]{64})' \},\r?$/m.exec(text);
    return {
      at: `${/^\s*index: (\d+),\r?$/m.exec(text)[1]}:${/^\s*hash: '([0-9a-f]{64})',\r?$/m.exec(text)[1]}`,
      from: from ? `${from[1]}:${from[2]}` : null,
      anchors: [...text.matchAll(/^\s*(\d+): \{\r?\n\s*eligible_raw: '([0-9a-f]+)',\r?\n\s*beacon: '([0-9a-f]{64})',\r?\n\s*registry_root: '([0-9a-f]{64})',/gm)]
        .map((m) => m.slice(1).join('|')),
    };
  };
  const app = pinOf(block('../src/config/genesisConsensus.js'));
  const site = pinOf(block('../../qnet-explorer/frontend/src/server/light/pin.ts'));
  expect(app.anchors).toHaveLength(2);
  expect(site.anchors).toHaveLength(2);
  const oneLineage = app.at === site.at || app.from === site.at || site.from === app.at || (app.from !== null && app.from === site.from);
  expect([app.at, app.from, site.at, site.from, oneLineage]).toEqual([app.at, app.from, site.at, site.from, true]);
  if (app.at === site.at) expect(app.anchors).toEqual(site.anchors);
  // The block parsed is the pin the light client roots at.
  const { WS_CHECKPOINT } = jest.requireActual('../src/config/genesisConsensus');
  expect(app.at).toBe(`${WS_CHECKPOINT.index}:${WS_CHECKPOINT.hash}`);
  expect(app.from).toBe(`${WS_CHECKPOINT.provenFrom.index}:${WS_CHECKPOINT.provenFrom.hash}`);
  expect(app.anchors.map((a) => Number(a.split('|')[0]))).toEqual([WS_CHECKPOINT.index, WS_CHECKPOINT.index - 1]);
});

// The same block carries NETWORK_ID and GALC_V2_MINT_INTERVAL (scripts/ws-pin.js writes them after WS_CHECKPOINT), so the
// note release-check.js and the extension's packaging read stays directly above WS_CHECKPOINT.
test('the ws-pin block carries NETWORK_ID and GALC_V2_MINT_INTERVAL after the pin', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '../src/config/genesisConsensus.js'), 'utf8');
  const block = /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/.exec(text)[0];
  const real = jest.requireActual('../src/config/genesisConsensus');
  expect(/^export const NETWORK_ID = '([0-9a-f]{64})';\r?$/m.exec(block)[1]).toBe(real.NETWORK_ID);
  expect(Number(/^export const GALC_V2_MINT_INTERVAL = (\d+);\r?$/m.exec(block)[1])).toBe(real.GALC_V2_MINT_INTERVAL);
  expect(real.GALC_V2_MINT_INTERVAL).toBe(10);
  expect(block.indexOf('export const NETWORK_ID')).toBeGreaterThan(block.indexOf('export const WS_CHECKPOINT'));
  expect(/Generated by scripts\/ws-pin\.js on (\d{4}-\d{2}-\d{2})\b[^\n]*\n\s*export const WS_CHECKPOINT = \{\s*index: (\d+),/.test(text)).toBe(true);
});

// GALC v2: a capsule roots walks only above the pin, and holding one never moves the trust floor.
test('a capsule at or below the pin is refused before any signature', () => {
  const m = loadWithPin(goodPin(1000));
  const { NETWORK_ID } = jest.requireActual('../src/config/genesisConsensus');
  const capsuleAt = (k) => ({
    version: 2, network_id: NETWORK_ID, mb_index: k, mb_hash: 'a1'.repeat(32), committee_digest_anchor: 'a2'.repeat(32),
    committee_digest_pred: 'a3'.repeat(32), minted_at_height: k * 90, cp_hash_anchor: 'a4'.repeat(32), cp_hash_pred: 'a5'.repeat(32),
    sigs: ['genesis_node_001', 'genesis_node_002', 'genesis_node_003', 'genesis_node_004'].map((id) => [id, `dilithium_sig_${id}_AAAA`]),
  });
  expect(m.capsuleProblem(capsuleAt(1000))).toBe('below_pin');
  expect(m.capsuleProblem(capsuleAt(990))).toBe('below_pin');
  expect(m.capsuleProblem(capsuleAt(1010))).toBeNull();
  expect(m.capsuleProblem(capsuleAt(1010), 1007)).toBe('above_head');
  expect(m.capsuleProblem(capsuleAt(1010), 1008)).toBeNull();
  expect(m.heldCapsuleIndex()).toBe(0);
  expect(m.trustFloorIndex()).toBe(1001);
});

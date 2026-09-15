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

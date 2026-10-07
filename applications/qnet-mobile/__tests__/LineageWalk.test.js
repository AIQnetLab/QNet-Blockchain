// The lineage walk is bounded and shared (MOBNET-R2-05): one walk per parity chain at a time, later callers wait
// for it instead of fetching and verifying the same steps again, and one call verifies at most
// WALK_STEPS_PER_CALL steps (what it verified is kept; the next call resumes). Every answer it reads has a size
// bound, and an oversized one is a failure of that node (MOBNET-R2-06).
const { sha3_256 } = require('js-sha3');

let lc;
let verifyDilithium;
let GENESIS_NODE_IDS;
let GENESIS_CONSENSUS_PKS;
jest.isolateModules(() => {
  jest.doMock('../src/config/genesisConsensus', () => ({
    ...jest.requireActual('../src/config/genesisConsensus'),
    WS_CHECKPOINT: { index: 0, hash: '00'.repeat(32), anchors: {} },
  }));
  jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(async () => true) }));
  lc = require('../src/crypto/QcLightClient');
  ({ verifyDilithium } = require('../src/crypto/DilithiumCrypto'));
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

// A proof of macroblock j that verifies: its committee is the genesis set before GENESIS_ERA_MAX_INDEX, then the
// sample over the eligible set and beacon of j-2 (the same set and beacon every step).
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

let asked;
function serveChain({ oversizedFrom = null } = {}) {
  asked = [];
  global.fetch = jest.fn(async (url) => {
    const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
    if (m) {
      asked.push(Number(m[1]));
      if (oversizedFrom && url.startsWith(oversizedFrom)) {
        return { ok: true, headers: { get: (h) => (h === 'content-length' ? String(64 * 1024 * 1024) : null) }, json: async () => ({}) };
      }
      return { ok: true, json: async () => proofFor(Number(m[1])) };
    }
    if (/\/registry\/height\//.test(url)) return { ok: true, json: async () => ({ entries: ENTRIES }) };
    throw new TypeError('Network request failed');
  });
}

beforeEach(() => {
  lc.clearQcCache();
  verifyDilithium.mockClear();
});

it('the synthetic chain verifies (the harness itself)', async () => {
  serveChain();
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => 'https://node1.aiqnet.io')).resolves.toBe(true);
  expect(asked).toEqual([2, 4, 6, 8, 10]);
});

it('one call verifies at most WALK_STEPS_PER_CALL steps, keeps them, and the next call resumes', async () => {
  serveChain();
  const target = 2 * (lc.WALK_STEPS_PER_CALL + 20); // WALK_STEPS_PER_CALL + 20 steps on the even chain
  const node = () => 'https://node1.aiqnet.io';
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, node)).resolves.toBe(false);
  expect(asked).toHaveLength(lc.WALK_STEPS_PER_CALL);
  asked.length = 0;
  await expect(lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, node)).resolves.toBe(true);
  expect(asked[0]).toBe(2 * (lc.WALK_STEPS_PER_CALL + 1)); // resumed above what the first call verified
  expect(asked).toHaveLength(20);
});

it('concurrent checks on one parity chain share one walk: no step is fetched twice', async () => {
  serveChain();
  const node = () => 'https://node1.aiqnet.io';
  const results = await Promise.all([30, 30, 28, 30, 26].map((j) => lc.verifyMacroblockStateRoot(stateRootOf(j), j * 90, node)));
  expect(results[0]).toBe(true);
  const counts = asked.reduce((m, j) => m.set(j, (m.get(j) || 0) + 1), new Map());
  expect([...counts.values()].every((n) => n === 1)).toBe(true);
  // Those that waited take what the walk verified.
  expect(results).toEqual([true, true, true, true, true]);
});

it('an oversized answer is that node\'s failure: the next node serves the step', async () => {
  const BAD = 'https://pool.example';
  serveChain({ oversizedFrom: BAD });
  const failures = [];
  const ok = await lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [BAD, 'https://node1.aiqnet.io'],
    { onNodeFailure: (base, reason) => failures.push([base, reason]) });
  expect(ok).toBe(true);
  expect(failures).toEqual(expect.arrayContaining([[BAD, 'oversized']]));
});

describe('boundedGetJson', () => {
  const { boundedGetJson, ResponseTooLargeError } = require('../src/utils/boundedFetch');

  it('refuses a declared or read length above the bound (fetch)', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => '2000' }, text: async () => '{}' }));
    await expect(boundedGetJson('https://x.example/a', { maxBytes: 1000 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => null }, text: async () => `"${'a'.repeat(2000)}"` }));
    await expect(boundedGetJson('https://x.example/a', { maxBytes: 1000 })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => '7' }, text: async () => '{"a":1}' }));
    await expect(boundedGetJson('https://x.example/a', { maxBytes: 1000 })).resolves.toEqual({ a: 1 });
  });

  it('in the app (XMLHttpRequest) asks for no compression and aborts as soon as more than the bound arrived', async () => {
    const made = [];
    class FakeXhr {
      constructor() { this.headers = {}; this.aborted = false; made.push(this); }
      open(method, url) { this.url = url; }
      setRequestHeader(k, v) { this.headers[k] = v; }
      getResponseHeader() { return null; }
      abort() { this.aborted = true; }
      send() {
        setTimeout(() => {
          this.readyState = 2; if (this.onreadystatechange) this.onreadystatechange();
          for (let loaded = 1000; loaded <= 50_000 && !this.aborted; loaded += 1000) if (this.onprogress) this.onprogress({ loaded });
          if (!this.aborted) { this.status = 200; this.responseText = '{}'; this.onload(); }
        }, 0);
      }
    }
    global.XMLHttpRequest = FakeXhr;
    try {
      await expect(boundedGetJson('https://pool.example/p', { maxBytes: 4096 })).rejects.toBeInstanceOf(ResponseTooLargeError);
      expect(made[0].aborted).toBe(true);
      expect(made[0].headers['Accept-Encoding']).toBe('identity');
    } finally {
      delete global.XMLHttpRequest;
    }
  });
});

// MOBNET-R5-01: an answer whose fields make the check throw is that node's failure — recorded, charged and skipped —
// and the next node serves the step; the walk does not end on it.
describe('a served proof that makes the check throw', () => {
  const BAD = 'https://pool.example';
  const GOOD = 'https://node1.aiqnet.io';
  const poisons = [
    ['checkpoint.index 1.5', (p) => { p.checkpoint.index = 1.5; }],
    ['total_supply "x"', (p) => { p.checkpoint.total_supply = 'x'; }],
    ['window_mb_hashes a number', (p) => { p.checkpoint.window_mb_hashes = 7; }],
    ['banned a number', (p) => { p.banned = 7; }],
    ['recovery_anchor [1.5, hash]', (p) => { p.checkpoint.recovery_anchor = [1.5, 'aa'.repeat(32)]; }],
    ['qc.signers a string', (p) => { p.qc = { signers: 'genesis_node_001', sigs: 'x' }; }],
  ];

  function serve(poison) {
    asked = [];
    global.fetch = jest.fn(async (url) => {
      const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
      if (m) {
        const p = proofFor(Number(m[1]));
        if (url.startsWith(BAD)) poison(p);
        asked.push([url.slice(0, url.indexOf('/api')), Number(m[1])]);
        return { ok: true, json: async () => p };
      }
      if (/\/registry\/height\//.test(url)) return { ok: true, json: async () => ({ entries: ENTRIES }) };
      throw new TypeError('Network request failed');
    });
  }

  it.each(poisons)('%s: the next node verifies the step, and the node is charged', async (_, poison) => {
    serve(poison);
    const failures = [];
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [BAD, GOOD],
      { onNodeFailure: (base, reason) => failures.push([base, reason]) });
    expect(ok).toBe(true);
    expect(failures).toEqual([[BAD, 'proof_malformed'], [BAD, 'proof_malformed']]);
    expect(asked.filter(([n]) => n === GOOD).map(([, j]) => j)).toEqual([2, 4]);
  });

  it('proofShapeProblem accepts every honest proof shape and names the field of a bad one', () => {
    expect(lc.proofShapeProblem(proofFor(6))).toBeNull();
    const p = proofFor(6);
    p.checkpoint.timestamp = -1;
    expect(lc.proofShapeProblem(p)).toBe('timestamp');
    expect(lc.proofShapeProblem({ ...proofFor(6), committee_pubkeys: { a: 5 } })).toBe('committee_pubkeys');
    expect(lc.proofShapeProblem(null)).toBe('proof');
  });
});

// MOBNET-R5-02: the registry snapshot a step binds keys to comes from the nodes named for it (the genesis names in
// the app), is bounded in entries, and a snapshot that cannot be had is no failure of the node that served the proof.
describe('the registry snapshot of a lineage step', () => {
  const POOL = 'https://pool.example';
  const GENESIS = 'https://node1.aiqnet.io';

  function serve({ registry = () => ({ entries: ENTRIES }) } = {}) {
    const registryAsked = [];
    global.fetch = jest.fn(async (url) => {
      const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
      if (m) return { ok: true, json: async () => proofFor(Number(m[1])) };
      if (/\/registry\/height\//.test(url)) {
        registryAsked.push(url.slice(0, url.indexOf('/api')));
        return { ok: true, json: async () => registry(url) };
      }
      throw new TypeError('Network request failed');
    });
    return registryAsked;
  }

  it('is read only from the nodes the caller names for it, never from the pool node that served the proof', async () => {
    const registryAsked = serve();
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(6), 6 * 90, () => [POOL, GENESIS], { registryNodes: () => [GENESIS] });
    expect(ok).toBe(true);
    expect(registryAsked.length).toBeGreaterThan(0);
    expect(new Set(registryAsked)).toEqual(new Set([GENESIS]));
  });

  it('one with more entries than the bound is refused unread; the proof\'s node is not charged for it', async () => {
    const huge = { entries: Array.from({ length: lc.REGISTRY_MAX_ENTRIES + 1 }, (_, i) => ({ node_id: `n${i}`, wallet: 'w', reg_height: 1 })) };
    serve({ registry: () => huge });
    const failures = [];
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [POOL],
      { registryNodes: () => [GENESIS], onNodeFailure: (base, reason) => failures.push([base, reason]) });
    expect(ok).toBe(false);
    expect(failures).toEqual([]); // not the pool node's answer that failed
    expect(verifyDilithium).toHaveBeenCalledTimes(lc.quorumSize(5)); // step 2 (genesis era) only; step 4 checked no signature
  });

  it('a malformed entry is refused before any hashing, and never throws out of the walk', async () => {
    serve({ registry: () => ({ entries: [...ENTRIES, null] }) });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [POOL], { registryNodes: () => [GENESIS] }))
      .resolves.toBe(false);
    serve({ registry: () => ({ entries: [{ ...ENTRIES[0], reg_height: 1.5 }, ...ENTRIES.slice(1)] }) });
    lc.clearQcCache();
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [POOL], { registryNodes: () => [GENESIS] }))
      .resolves.toBe(false);
  });

  // M13: the first snapshot whose root matches is taken, not the first that answers.
  it('a node whose snapshot is not the certified one gives way to the next node\'s that is', async () => {
    const OTHER = 'https://node2.aiqnet.io';
    lc.clearQcCache();
    const registryAsked = serve({
      registry: (url) => (url.startsWith(GENESIS) ? { entries: ENTRIES.slice(1) } : { entries: ENTRIES }),
    });
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [POOL], { registryNodes: () => [GENESIS, OTHER] });
    expect(ok).toBe(true);
    expect(registryAsked).toEqual([GENESIS, OTHER]);
    // Every node's snapshot wrong: the step fails as a mismatch, and the proof's node is not charged.
    lc.clearQcCache();
    serve({ registry: () => ({ entries: ENTRIES.slice(1) }) });
    const failures = [];
    expect(await lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [POOL],
      { registryNodes: () => [GENESIS, OTHER], onNodeFailure: (base, reason) => failures.push([base, reason]) })).toBe(false);
    expect(failures).toEqual([]);
  });

  it('the verified macroblocks kept are bounded, the newest of each parity chain always among them (M13)', async () => {
    lc.clearQcCache();
    serve();
    const top = lc.VERIFIED_CACHE_MAX * 2 + 6;
    // Two calls walk each chain past the bound (a call verifies at most WALK_STEPS_PER_CALL steps).
    for (const target of [top, top + 1]) {
      while (!(await lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, () => [POOL], { registryNodes: () => [GENESIS] }))) {
        // the next call resumes from what the last one verified
      }
    }
    const kept = Object.keys(lc.exportVerifiedAnchors()).map(Number).sort((a, b) => a - b);
    expect(kept).toEqual([top, top + 1]);
    expect(lc.highestVerifiedIndex()).toBe(top + 1);
    // Anything older than the bound was let go: a query at it is fetched and verified again; a recent one is not.
    const proofsAsked = () => global.fetch.mock.calls.filter(([url]) => /\/macroblock\/\d+\/proof$/.test(url)).map(([url]) => url);
    const before = proofsAsked().length;
    expect(await lc.verifyMacroblockStateRoot(stateRootOf(top), top * 90, () => [POOL], { registryNodes: () => [GENESIS] })).toBe(true);
    expect(proofsAsked().length).toBe(before);
    expect(await lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => [POOL], { registryNodes: () => [GENESIS] })).toBe(true);
    expect(proofsAsked().length).toBeGreaterThan(before);
  });

  it('the app names the genesis nodes for it', () => {
    jest.isolateModules(() => {
      const { WalletManager } = require('../src/components/WalletManager');
      const { GENESIS_NODES } = require('../src/config/nodes');
      const nodes = new WalletManager()._lineageHooks().registryNodes();
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((u) => GENESIS_NODES.includes(u))).toBe(true);
    });
  });
});

// R5-EXTQ-04: a QC is refused before any signature check when it lists more signers than the committee, or one twice;
// each signer is checked once at most.
describe('a QC padded with signers', () => {
  function serveQc(edit) {
    global.fetch = jest.fn(async (url) => {
      const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
      if (m) {
        const p = proofFor(Number(m[1]));
        edit(p);
        return { ok: true, json: async () => p };
      }
      if (/\/registry\/height\//.test(url)) return { ok: true, json: async () => ({ entries: ENTRIES }) };
      throw new TypeError('Network request failed');
    });
  }

  it('one signer repeated many times: refused with no signature checked', async () => {
    serveQc((p) => { p.qc = { signers: Array(1874).fill(IDS[0]), sigs: Array(1874).fill(wireSig(IDS[0])) }; });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(2), 2 * 90, () => 'https://node1.aiqnet.io')).resolves.toBe(false);
    expect(verifyDilithium).not.toHaveBeenCalled();
  });

  it('more signers than the committee has members: refused with no signature checked', async () => {
    serveQc((p) => {
      const extra = [...p.qc.signers, ...IDS.map((id) => `${id}x`)];
      p.qc = { signers: extra, sigs: extra.map(wireSig) };
    });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(2), 2 * 90, () => 'https://node1.aiqnet.io')).resolves.toBe(false);
    expect(verifyDilithium).not.toHaveBeenCalled();
  });

  it('invalid signatures: each signer is checked once, and never more than the committee', async () => {
    verifyDilithium.mockImplementation(async () => false);
    try {
      serveQc((p) => { p.qc = { signers: IDS.slice(), sigs: IDS.map(wireSig) }; });
      await expect(lc.verifyMacroblockStateRoot(stateRootOf(2), 2 * 90, () => 'https://node1.aiqnet.io')).resolves.toBe(false);
      expect(verifyDilithium.mock.calls.length).toBeLessThanOrEqual(IDS.length);
    } finally {
      verifyDilithium.mockImplementation(async () => true);
    }
  });
});

it('read-pool endpoints that answered oversized leave the pool for the session', () => {
  jest.isolateModules(() => {
    const { WalletManager } = require('../src/components/WalletManager');
    const wm = new WalletManager();
    WalletManager.discovered = [{ url: 'https://pool-a.example', confirmedAt: Math.floor(Date.now() / 1000) }];
    WalletManager.lastDiscoveryTime = Date.now();
    wm._lineageHooks().onNodeFailure('https://pool-a.example', 'oversized');
    expect(wm.getReadNodes(20)).not.toContain('https://pool-a.example');
    const { GENESIS_NODES } = require('../src/config/nodes');
    wm._lineageHooks().onNodeFailure(GENESIS_NODES[0], 'oversized');
    expect(wm.getReadNodes(20)).toContain(GENESIS_NODES[0]);
  });
});

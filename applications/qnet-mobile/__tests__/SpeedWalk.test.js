/**
 * The owner's 06.10 round on speed, the light client's part, with the trust rules unchanged:
 * - a target macroblock a node does not hold yet (HTTP 200 macroblock_not_found: it is certified some blocks after its
 *   height) is "not certified yet": one node asked, none charged, no 60-second skip;
 * - a balance proof's root counts when it is the certified root of idx, idx-1 or idx-2, and how recent it is goes by
 *   that certified index;
 * - the walk fetches the next proofs at once and still verifies them strictly in order; a forged one stops it there;
 * - each node's read budget (the node admits 300 reads a minute) and its rate-limit answers are kept, never charged;
 * - each committee key is hashed once, not at every step.
 */
const { sha3_256: realSha3 } = require('js-sha3');

let lc;
let verifyDilithium;
let GENESIS_NODE_IDS;
let GENESIS_CONSENSUS_PKS;
const pkHashes = { count: 0 };
jest.isolateModules(() => {
  jest.doMock('../src/config/genesisConsensus', () => ({
    ...jest.requireActual('../src/config/genesisConsensus'),
    WS_CHECKPOINT: { index: 0, hash: '00'.repeat(32), anchors: {} },
  }));
  jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(async () => true) }));
  // SHA3-256 as the light client calls it, counting the hashes of 1952-byte inputs (an ML-DSA-65 public key).
  jest.doMock('js-sha3', () => {
    const real = jest.requireActual('js-sha3');
    const sha3_256 = Object.assign((input, ...rest) => {
      if (input && input.length === 1952) pkHashes.count += 1;
      return real.sha3_256(input, ...rest);
    }, real.sha3_256);
    return { ...real, sha3_256 };
  });
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
  vrf_pk_sha3: realSha3(Buffer.from(GENESIS_CONSENSUS_PKS[id], 'hex')),
}));
const REG_ROOT = lc.recomputeRegistryRoot(ENTRIES);
const BEACON = 'bb'.repeat(32);
const stateRootOf = (j) => (j % 256).toString(16).padStart(2, '0').repeat(32);

function proofFor(j, edit = null) {
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
  const proof = {
    index: j, checkpoint: cp, eligible_raw: ELIGIBLE, banned: [],
    committee_pubkeys: Object.fromEntries(committee.map((id) => [id, GENESIS_CONSENSUS_PKS[id]])),
    qc: { signers, sigs: signers.map(wireSig) },
  };
  if (edit) edit(proof);
  return proof;
}

const N1 = 'https://node1.aiqnet.io';
const N2 = 'https://node2.aiqnet.io';
const N3 = 'https://node3.aiqnet.io';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// A chain served by every node: `top` the highest certified macroblock (above it: macroblock_not_found), `delay(j)` the
// time a proof takes, `answer(base, j)` a node's own answer in place of the honest proof.
let asked;
let inFlight;
let maxInFlight;
function serveChain({ top = Infinity, delay = () => 0, answer = null } = {}) {
  asked = [];
  inFlight = 0;
  maxInFlight = 0;
  global.fetch = jest.fn(async (url) => {
    const m = /^(https:\/\/[^/]+)\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(url);
    if (m) {
      const [base, j] = [m[1], Number(m[2])];
      asked.push([base, j]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const wait = delay(j);
        if (wait > 0) await sleep(wait);
      } finally {
        inFlight -= 1;
      }
      const own = answer ? answer(base, j) : undefined;
      if (own !== undefined) return own;
      if (j > top) return { ok: true, json: async () => ({ error: 'macroblock_not_found', index: j }) };
      return { ok: true, json: async () => proofFor(j) };
    }
    if (/\/registry\/height\//.test(url)) return { ok: true, json: async () => ({ entries: ENTRIES }) };
    throw new TypeError('Network request failed');
  });
}
const askedFor = (j) => asked.filter(([, k]) => k === j);

beforeEach(() => {
  lc.clearQcCache();
  verifyDilithium.mockReset();
  verifyDilithium.mockResolvedValue(true);
});

describe('a target macroblock not certified yet', () => {
  it('is asked of the first node and at most two more, charges none and is asked again at once, not after the failure TTL', async () => {
    serveChain({ top: 8 });
    const failures = [];
    const hooks = { onNodeFailure: (base, reason) => failures.push([base, reason]) };
    const N4 = 'https://node4.aiqnet.io';
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => [N1, N2, N3, N4], hooks)).resolves.toBe(false);
    // One lagging or hostile node cannot hold back a macroblock the others serve; three saying so end the step.
    expect(askedFor(10)).toEqual([[N1, 10], [N2, 10], [N3, 10]]);
    expect(failures).toEqual([]);
    // Below it the walk went on as ever: verified, and kept.
    expect(lc.highestVerifiedIndex()).toBe(8);
    asked.length = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => [N1, N2, N3, N4], hooks)).resolves.toBe(false);
    expect(askedFor(10)).toEqual([[N1, 10], [N2, 10], [N3, 10]]); // no 60-second skip of any of them
    expect(failures).toEqual([]);
  });

  it('a step below the target that a node does not hold is still that node\'s failure', async () => {
    serveChain({ answer: (base, j) => (base === N1 && j === 4 ? { ok: true, json: async () => ({ error: 'macroblock_not_found' }) } : undefined) });
    const failures = [];
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(6), 6 * 90, () => [N1, N2], { onNodeFailure: (b, r) => failures.push([b, r]) }))
      .resolves.toBe(true);
    expect(failures).toEqual([[N1, 'proof_malformed']]);
  });
});

describe('the certified index of a balance proof', () => {
  it('idx not certified yet: the root of idx-1 or idx-2 counts, judged by that index; idx-3 never does', async () => {
    serveChain({ top: 9 });
    // Tip in window 10, macroblock 10 not certified yet: the tip's root is that of macroblock 9.
    await expect(lc.certifiedStateRootIndex(stateRootOf(9), 10 * 90 + 17, () => [N1, N2])).resolves.toBe(9);
    // ... or of macroblock 8, verified on the way to 10.
    await expect(lc.certifiedStateRootIndex(stateRootOf(8), 10 * 90 + 17, () => [N1, N2])).resolves.toBe(8);
    // Macroblock 7 is certified too (verified on the way to 9), but three back is no tip's root.
    expect(lc.highestVerifiedIndex()).toBe(9);
    await expect(lc.certifiedStateRootIndex(stateRootOf(7), 10 * 90 + 17, () => [N1, N2])).resolves.toBeNull();
    // A root no certified checkpoint holds: refused.
    await expect(lc.certifiedStateRootIndex('ee'.repeat(32), 10 * 90 + 17, () => [N1, N2])).resolves.toBeNull();
  });

  it('checkpoints already certified answer with no fetch at all', async () => {
    serveChain();
    await expect(lc.certifiedStateRootIndex(stateRootOf(10), 10 * 90, () => [N1])).resolves.toBe(10);
    const before = global.fetch.mock.calls.length;
    await expect(lc.certifiedStateRootIndex(stateRootOf(10), 11 * 90 + 3, () => [N1])).resolves.toBe(10);
    await expect(lc.certifiedStateRootIndex(stateRootOf(10), 12 * 90 + 3, () => [N1])).resolves.toBe(10);
    expect(global.fetch.mock.calls.length).toBe(before);
  });

  it('idx certified with another root: no earlier checkpoint is walked to for it', async () => {
    serveChain();
    await expect(lc.certifiedStateRootIndex(stateRootOf(9), 10 * 90, () => [N1])).resolves.toBeNull();
    expect(askedFor(9)).toEqual([]); // the odd chain is not walked: a later root differs from every earlier one
  });

  it('the wallet judges freshness by the certified index', async () => {
    const { WalletManager } = require('../src/components/WalletManager');
    const { WS_CHECKPOINT } = require('../src/config/genesisConsensus');
    const K = WS_CHECKPOINT.index;
    const wm = new WalletManager();
    await expect(wm._indexIsFresh(K + 98, K + 100)).resolves.toBe(true);
    await expect(wm._indexIsFresh(K + 97, K + 100)).resolves.toBe(false);
    await expect(wm._indexIsFresh(K + 100, null)).resolves.toBe(false);
  });
});

describe('the walk fetches ahead and verifies in order', () => {
  it('proofs that arrive out of order are still verified bottom-up, each from the one below', async () => {
    // Later steps answer first: 10 at once, 2 last.
    serveChain({ delay: (j) => (12 - j) * 15 });
    const progress = [];
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => [N1], { onProgress: (j) => progress.push(j) });
    expect(ok).toBe(true);
    expect(progress).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeGreaterThanOrEqual(4); // fetched together
    expect(asked.map(([, j]) => j)).toEqual([2, 4, 6, 8, 10]); // each once, asked in order
  });

  it('a forged proof in the middle stops the walk there: nothing above it is taken', async () => {
    const honest = new Set([2, 4, 6, 8, 10].map((j) => 'QNET_BFT2_VOTE:' + lc.checkpointHash(proofFor(j).checkpoint)));
    verifyDilithium.mockImplementation(async (message) => honest.has(message));
    serveChain({
      answer: (base, j) => (j === 6 ? { ok: true, json: async () => proofFor(6, (p) => { p.checkpoint.state_root = 'ee'.repeat(32); }) } : undefined),
    });
    const failures = [];
    const progress = [];
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, () => [N1],
      { onNodeFailure: (b, r) => failures.push([b, r]), onProgress: (j) => progress.push(j) });
    expect(ok).toBe(false);
    expect(progress).toEqual([2, 4]);
    expect(failures).toEqual([[N1, 'qc_invalid']]);
    expect(lc.highestVerifiedIndex()).toBe(4);
    // 8 and 10 were fetched ahead, never verified: a query at 10 fetches and verifies again.
    expect(askedFor(8).length).toBe(1);
    await expect(lc.certifiedStateRootIndex(stateRootOf(8), 8 * 90, () => [N1])).resolves.toBeNull();
  });

  it('never fetches past the budget of one call', async () => {
    serveChain();
    const target = 2 * (lc.WALK_STEPS_PER_CALL + 10);
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, () => [N1])).resolves.toBe(false);
    expect(asked).toHaveLength(lc.WALK_STEPS_PER_CALL);
  });

  // The benchmark: twelve steps, every request answering after 300 ms, one proof at a time against the walk's depth.
  it('with a 300 ms round trip, fetching ahead is several times faster', async () => {
    const steps = 12;
    const target = 2 * steps;
    const RTT = 300;
    const timed = async (hooks) => {
      lc.clearQcCache();
      serveChain({ delay: () => RTT });
      const t0 = Date.now();
      await expect(lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, () => [N1, N2, N3], hooks)).resolves.toBe(true);
      return Date.now() - t0;
    };
    const oneAtATime = await timed({ prefetch: 1 });
    const ahead = await timed({});
    // eslint-disable-next-line no-console
    console.log(`[bench] ${steps} lineage steps at ${RTT} ms RTT: one at a time ${oneAtATime} ms, fetched ahead ${ahead} ms`);
    expect(oneAtATime).toBeGreaterThanOrEqual(steps * RTT);
    expect(ahead).toBeLessThan(oneAtATime / 2.5);
  });
});

describe('a node\'s read budget and rate limit', () => {
  const limitBody = { ok: true, json: async () => ({ success: false, error: 'Rate limit exceeded', retry_after_seconds: 30 }) };

  it('a rate-limit answer is no failure: the next node serves the step, and the limited node is left alone', async () => {
    let limited = false;
    let askedAfter = 0;
    serveChain({
      answer: (base) => {
        if (base !== N1) return undefined;
        if (limited) askedAfter += 1;
        limited = true;
        return limitBody;
      },
    });
    const failures = [];
    const ok = await lc.verifyMacroblockStateRoot(stateRootOf(16), 16 * 90, () => [N1, N2], { onNodeFailure: (b, r) => failures.push([b, r]) });
    expect(ok).toBe(true);
    expect(failures).toEqual([]);
    // Only the proofs fetched ahead before its first answer went to N1; nothing after it, while it waits.
    expect(asked.filter(([b]) => b === N1).length).toBeLessThanOrEqual(lc.WALK_PREFETCH);
    expect(askedAfter).toBeLessThanOrEqual(lc.WALK_PREFETCH - 1);
    expect(asked.filter(([b, j]) => b === N1 && j > 2 * lc.WALK_PREFETCH)).toEqual([]);
  });

  it('a proxy\'s 429 counts the same; with every node limited the walk pauses and resumes later, nothing charged', async () => {
    serveChain({ answer: () => ({ ok: false, status: 429, json: async () => ({}) }) });
    const failures = [];
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(4), 4 * 90, () => [N1, N2], { onNodeFailure: (b, r) => failures.push([b, r]) }))
      .resolves.toBe(false);
    expect(failures).toEqual([]);
  });

  it('a node is read at most NODE_READS_PER_MINUTE times a minute; the next node takes over', async () => {
    serveChain();
    const target = 2 * (lc.NODE_READS_PER_MINUTE + 20);
    const failures = [];
    let calls = 0;
    while (!(await lc.verifyMacroblockStateRoot(stateRootOf(target), target * 90, () => [N1, N2],
      { onNodeFailure: (b, r) => failures.push([b, r]) }))) {
      calls += 1;
      if (calls > 10) throw new Error('the walk did not finish');
    }
    const reads = (b) => global.fetch.mock.calls.filter(([url]) => url.startsWith(b)).length;
    expect(reads(N1)).toBeLessThanOrEqual(lc.NODE_READS_PER_MINUTE);
    expect(reads(N2)).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(lc.NODE_READS_PER_MINUTE).toBeLessThan(300);
  });

  it('isRateLimitBody knows the node\'s answer and nothing else', () => {
    expect(lc.isRateLimitBody({ success: false, error: 'Rate limit exceeded', retry_after_seconds: 3 })).toBe(true);
    expect(lc.isRateLimitBody({ error: 'macroblock_not_found' })).toBe(false);
    expect(lc.isRateLimitBody(null)).toBe(false);
    expect(lc.isRateLimitBody('Rate limit exceeded')).toBe(false);
  });
});

describe('committee keys', () => {
  it('each key is hashed once across the walk, not at every step', async () => {
    serveChain();
    pkHashes.count = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(20), 20 * 90, () => [N1])).resolves.toBe(true);
    // Ten steps, nine of them past the genesis era with five committee keys each: five hashes in all.
    expect(pkHashes.count).toBe(IDS.length);
  });

  it('a changed key is hashed again and refused when the registry holds another', async () => {
    const notSigning = [...IDS].sort()[IDS.length - 1]; // the quorum signs without the last member
    serveChain({
      answer: (base, j) => (j === 6 ? {
        ok: true,
        json: async () => proofFor(6, (p) => { p.committee_pubkeys[notSigning] = '01'.repeat(1952); }),
      } : undefined),
    });
    pkHashes.count = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(6), 6 * 90, () => [N1])).resolves.toBe(true);
    expect(pkHashes.count).toBe(IDS.length + 1);
  });
});

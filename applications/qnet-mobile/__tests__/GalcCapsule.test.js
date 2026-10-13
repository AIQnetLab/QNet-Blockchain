// GALC v2 capsules as a walk root (docs/protocols/galc-capsule-v2.md): the shared vectors (signed by TEST genesis keys,
// which stand in for the embedded ones here), the refusals, and the client on a synthetic chain: a capsule roots the walk
// a few steps below the head; 404, 405 and anything refused fall back to the pin exactly as before, a node probed at most
// once per TTL; the capsule survives the LRU and the lineage reset, a rewind clears it; log proofs below K still verify.
// Walk votes ("QNET_BFT2_VOTE:…") pass as in the other walk suites; capsule signatures are verified for real (ML-DSA-65).
const path = require('path');
const { spawnSync } = require('child_process');
const { sha3_256 } = require('js-sha3');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');

const REPO = path.join(__dirname, '../../..');
const V = require('../../../docs/protocols/galc-capsule-v2.vectors.json');

jest.setTimeout(120000);

const GENESIS_IDS = V.keys.filter((k) => k.id.startsWith('genesis_node_')).map((k) => k.id);
const KEYS = Object.fromEntries(V.keys.map((k) => [k.id, {
  publicKey: k.publicKey, secretKey: ml_dsa65.keygen(Uint8Array.from(Buffer.from(k.seed, 'hex'))).secretKey,
}]));
const TEST_PKS = Object.fromEntries(GENESIS_IDS.map((id) => [id, KEYS[id].publicKey]));
const INERT = { index: 0, hash: '00'.repeat(32), anchors: {} };

async function verify(message, sigHex, pkHex) {
  if (message.startsWith('QNET_BFT2_VOTE:')) return true;
  try {
    return ml_dsa65.verify(Buffer.from(sigHex, 'hex'), Buffer.from(message, 'utf8'), Buffer.from(pkHex, 'hex'));
  } catch (_) {
    return false;
  }
}

// The light client with the test genesis keys, the vectors' network id and `pin`.
function load(pin = INERT) {
  let lc;
  let dil;
  jest.isolateModules(() => {
    jest.doMock('../src/config/genesisConsensus', () => ({
      ...jest.requireActual('../src/config/genesisConsensus'),
      GENESIS_CONSENSUS_PKS: TEST_PKS,
      GENESIS_NODE_IDS: GENESIS_IDS,
      NETWORK_ID: V.networkId,
      GALC_V2_MINT_INTERVAL: V.constants.mintInterval,
      WS_CHECKPOINT: pin,
    }));
    jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(verify) }));
    lc = require('../src/crypto/QcLightClient');
    dil = require('../src/crypto/DilithiumCrypto');
  });
  return { lc, verifyDilithium: dil.verifyDilithium };
}

let { lc, verifyDilithium } = load();

const wireOf = (c) => ({ ...c, sigs: c.sigs.map(([id, name]) => [id, V.signatures[name]]) });
const lab = (s) => sha3_256(`galc-test/${s}`);

// ── the synthetic chain (the LineageWalk harness, with the committee list nodes serve) ──
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

function voteSig(nodeId) {
  const sig = Buffer.alloc(3309, 7);
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length);
  return 'dilithium_sig_' + nodeId + '_' + Buffer.concat([len, sig]).toString('base64');
}

const ELIGIBLE = eligibleRawHex(GENESIS_IDS);
const ENTRIES = GENESIS_IDS.map((id, i) => ({
  node_id: id, wallet: 'w_' + id, reg_height: 90, reg_index: i, node_type: 'super', burn: '',
  vrf_pk_sha3: sha3_256(Buffer.from(TEST_PKS[id], 'hex')),
}));
const REG_ROOT = lc.recomputeRegistryRoot(ENTRIES);
const BEACON = 'bb'.repeat(32);
const stateRootOf = (j) => (j % 256).toString(16).padStart(2, '0').repeat(32);
const N = ['https://node1.aiqnet.io', 'https://node2.aiqnet.io', 'https://node3.aiqnet.io', 'https://node4.aiqnet.io',
  'https://node5.aiqnet.io'];
const nodes = () => N;
const KC = 40; // the synthetic chain's capsule
const HEAD = KC + 11; // the walk to it from K-1 is the longest one a capsule leaves: 6 steps

// `timestamp`: another certified checkpoint of the same window (it hashes elsewhere).
function proofFor(j, { timestamp = 0 } = {}) {
  const committee = j < 3 ? GENESIS_IDS.slice() : lc.sampleCommittee([...GENESIS_IDS].sort(), j, BEACON);
  const cp = {
    index: j, parent_qc: null, window_head_height: j * 90, window_mb_hashes: [lab(`b/${j}/0`), lab(`b/${j}/1`)],
    state_root: stateRootOf(j), beacon: BEACON,
    epoch_commitment: lc.epochCommitment(Buffer.from(ELIGIBLE, 'hex'), committee, []),
    reward_root: lab(`reward/${j}`), registry_root: REG_ROOT, logs_root: '00'.repeat(32),
    dilithium_pk_root: '00'.repeat(32), reward_epoch_root: lab(`reward-epoch/${j}`),
    total_supply: '0', timestamp, proposer: GENESIS_IDS[0], recovery_anchor: null,
  };
  const signers = committee.slice(0, lc.quorumSize(committee.length));
  return {
    index: j, checkpoint: cp, eligible_raw: ELIGIBLE, banned: [], committee,
    committee_pubkeys: Object.fromEntries(committee.map((id) => [id, TEST_PKS[id]])),
    qc: { signers, sigs: signers.map(voteSig) },
  };
}

const partsOf = (p) => ({ index: p.index, checkpoint: p.checkpoint, eligible_raw: p.eligible_raw, committee: p.committee, banned: p.banned });

const signed = new Map();
function sigString(nameInString, keyId, text) {
  const key = `${keyId}|${text}`;
  if (!signed.has(key)) signed.set(key, Buffer.from(ml_dsa65.sign(Buffer.from(text, 'utf8'), KEYS[keyId].secretKey)));
  const sig = signed.get(key);
  const msg = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length + msg.length);
  const pkLen = Buffer.alloc(4); pkLen.writeUInt32LE(1952);
  return `dilithium_sig_${nameInString}_${Buffer.concat([len, sig, msg, pkLen, Buffer.from(KEYS[keyId].publicKey, 'hex')]).toString('base64')}`;
}

// A capsule of the synthetic chain at `k`, signed by `signers` over its own preimage.
function capsuleAt(k = KC, { over = {}, signers = GENESIS_IDS.slice(0, 4), timestamp = 0 } = {}) {
  const f = {
    version: 2, network_id: V.networkId, mb_index: k, mb_hash: lab(`mb/${k}`), committee_digest_anchor: lab(`dA/${k}`),
    committee_digest_pred: lab(`dP/${k}`), minted_at_height: k * 90,
    cp_hash_anchor: lc.checkpointHash(proofFor(k, { timestamp }).checkpoint),
    cp_hash_pred: lc.checkpointHash(proofFor(k - 1).checkpoint), ...over,
  };
  const text = lc.capsulePreimage(f);
  return { ...f, sigs: signers.map((id) => [id, sigString(id, id, text)]) };
}

const recordAt = (k = KC, opts = {}) => ({
  capsule: capsuleAt(k, opts),
  roots: { [k]: partsOf(proofFor(k, { timestamp: opts.timestamp || 0 })), [k - 1]: partsOf(proofFor(k - 1)) },
});

let calls;
const ok = (body) => ({ ok: true, json: async () => body });
// `capsule`: base -> a body, an HTTP status, or undefined (405, today's nodes); `proof(base, j)`: an answer in place of
// the chain's own.
function serve({ capsule = {}, proof = () => undefined, head = HEAD } = {}) {
  calls = [];
  global.fetch = jest.fn(async (url) => {
    const base = url.slice(0, url.indexOf('/api'));
    const p = url.slice(base.length);
    calls.push([base, p]);
    if (p === '/api/v1/state/certified') return ok({ proof_format: 2, newest_certified_index: head, views: [] });
    if (p === lc.CAPSULE_PATH) {
      const c = typeof capsule === 'function' ? capsule(base) : capsule[base];
      if (c === undefined) return { ok: false, status: 405, json: async () => ({}) };
      if (typeof c === 'number') return { ok: false, status: c, json: async () => ({ error: 'no_capsule' }) };
      return ok(c);
    }
    const m = /\/macroblock\/(\d+)\/proof$/.exec(p);
    if (m) {
      const j = Number(m[1]);
      if (j > head) return ok({ error: 'macroblock_not_found', index: j });
      return ok(proof(base, j) || proofFor(j));
    }
    if (/\/registry\/height\//.test(p)) return ok({ entries: ENTRIES });
    throw new TypeError('Network request failed');
  });
}

const capsuleAsks = () => calls.filter(([, p]) => p === lc.CAPSULE_PATH).map(([b]) => b);
const proofsAsked = () => calls.map(([b, p]) => [b, /\/macroblock\/(\d+)\/proof$/.exec(p)]).filter(([, m]) => m).map(([b, m]) => [b, Number(m[1])]);
const indicesAsked = () => proofsAsked().map(([, j]) => j);

function reset() {
  lc.clearQcCache();
  lc.clearCapsule();
  verifyDilithium.mockClear();
}

beforeEach(reset);

describe('the vector file', () => {
  it('is exactly what its generator writes', () => {
    const run = spawnSync(process.execPath, [path.join(REPO, 'docs/protocols/tools/galc-capsule-v2-vectors.mjs'), '--check'],
      { encoding: 'utf8', timeout: 120000 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('the golden preimages', () => {
    for (const p of V.preimages) expect(lc.capsulePreimage(p.fields)).toBe(p.preimage);
    expect(V.preimages[0].preimage.startsWith(`QNET_GENESIS_CHECKPOINT_v2:2:${V.networkId}:38960:`)).toBe(true);
  });

  it('the checkpoint hashes and epoch commitments of the roots', () => {
    for (const [j, root] of Object.entries(V.roots)) {
      expect(lc.checkpointHash(root.checkpoint)).toBe(V.checkpointHashes[j]);
      expect(lc.epochCommitment(Buffer.from(root.eligible_raw, 'hex'), root.committee, root.banned)).toBe(V.epochCommitments[j]);
    }
  });

  it.each(V.cases.map((c) => [c.name, c]))('%s', async (_, c) => {
    const capsule = wireOf(c.capsule);
    if (c.stage === 'checks') {
      expect(lc.capsuleProblem(capsule, c.headHint)).toBe(c.expect);
      expect(verifyDilithium).not.toHaveBeenCalled();
      return;
    }
    expect(lc.capsuleProblem(capsule, c.headHint)).toBeNull();
    const got = await lc.importCapsule({ capsule, roots: c.roots || V.roots });
    expect(got).toEqual(c.expect === 'accepted' ? { ok: true, index: capsule.mb_index } : { ok: false, reason: c.expect });
    expect(verifyDilithium.mock.calls.length).toBeLessThanOrEqual(capsule.sigs.length);
  });

  it('the accepted capsule in its wire form roots K and K-1 with their certified fields', async () => {
    const k = V.capsule.mb_index;
    expect(await lc.verifyCapsuleSignatures(V.capsule)).toEqual({ ok: true, valid: GENESIS_IDS.slice(0, 4) });
    await expect(lc.importCapsule({ capsule: V.capsule, roots: V.roots })).resolves.toEqual({ ok: true, index: k });
    expect(lc.heldCapsuleIndex()).toBe(k);
    expect(lc.highestVerifiedIndex()).toBe(k);
    const cp = V.roots[k].checkpoint;
    expect(lc.verifiedCheckpoint(k)).toEqual({
      index: k, stateRoot: cp.state_root, logsRoot: cp.logs_root, checkpointHash: V.checkpointHashes[k],
      registryRoot: cp.registry_root, beacon: cp.beacon, timestamp: cp.timestamp, windowMbHashes: cp.window_mb_hashes,
      rewardRoot: cp.reward_root, rewardEpochRoot: cp.reward_epoch_root,
    });
    expect(lc.verifiedCheckpoint(k - 1).checkpointHash).toBe(V.checkpointHashes[k - 1]);
    expect(lc.stepsToVerify(k)).toBe(0);
    expect(lc.stepsToVerify(k - 1)).toBe(0);
    // Under the build's own identity the vectors are another network's: refused before any signature.
    const real = jest.requireActual('../src/config/genesisConsensus');
    expect(real.NETWORK_ID).not.toBe(V.networkId);
  });
});

describe('on a chain whose nodes serve no capsule (404, 405)', () => {
  it('each node is asked once per TTL, and the walk goes on from the pin exactly as before', async () => {
    serve({ capsule: { [N[4]]: 404 } });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'no_capsule' });
    expect(capsuleAsks()).toEqual([N[0], N[1]]);
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'no_capsule' });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'no_capsule' });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'no_capsule' });
    expect(capsuleAsks()).toEqual(N);
    expect(lc.heldCapsuleIndex()).toBe(0);
    // The walk: from the root, as a client that never asked.
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(50), 50 * 90, nodes)).resolves.toBe(true);
    expect(indicesAsked()).toEqual(Array.from({ length: 25 }, (_, i) => 2 + 2 * i));
    // After the TTL the first two are asked again.
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + lc.CAPSULE_MISS_TTL_MS + 1);
    try {
      calls.length = 0;
      await lc.refreshCapsule(nodes, { force: true });
      expect(capsuleAsks()).toEqual([N[0], N[1]]);
    } finally {
      clock.mockRestore();
    }
  });

  it('a follow tick with no capsule walks one step from the pin and says how many are left', async () => {
    serve();
    const r = await lc.followStep(nodes);
    expect(r).toMatchObject({ ok: true, head: HEAD, verified: false, capsule: { ok: false, reason: 'no_capsule' } });
    expect(indicesAsked()).toEqual([1]);
    expect(r.stepsLeft).toBe((HEAD - 1) / 2);
  });
});

describe('a capsule on the synthetic chain', () => {
  it('roots the walk: at most ceil(interval / 2) + 1 steps to the head on either parity', async () => {
    const capsule = capsuleAt();
    serve({ capsule: { [N[0]]: capsule, [N[1]]: capsule } });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: true, index: KC });
    // K and K-1 each from two nodes.
    expect(proofsAsked()).toEqual([[N[0], KC], [N[1], KC], [N[0], KC - 1], [N[1], KC - 1]]);
    const most = Math.ceil(V.constants.mintInterval / 2) + 1;
    expect(lc.stepsToVerify(HEAD)).toBe(most);
    expect(lc.stepsToVerify(HEAD - 1)).toBe(most - 1);
    calls.length = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(HEAD), HEAD * 90, nodes)).resolves.toBe(true);
    expect(indicesAsked()).toEqual([41, 43, 45, 47, 49, 51]);
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(HEAD - 1), (HEAD - 1) * 90, nodes)).resolves.toBe(true);
    expect(indicesAsked().slice(6)).toEqual([42, 44, 46, 48, 50]);
    // K and K-1 answer at once, with no fetch.
    calls.length = 0;
    await expect(lc.certifiedStateRootAt(KC, nodes)).resolves.toEqual({ ok: true, index: KC, stateRoot: stateRootOf(KC) });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(KC - 1), (KC - 1) * 90, nodes)).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it('a follow tick refreshes it while the walk is long, then walks one step from it', async () => {
    const capsule = capsuleAt();
    serve({ capsule: { [N[0]]: capsule, [N[1]]: capsule } });
    const first = await lc.followStep(nodes);
    expect(first).toMatchObject({ ok: true, head: HEAD, verified: false, stepsLeft: 5, capsule: { ok: true, index: KC } });
    const second = await lc.followStep(nodes, { maxSteps: lc.WALK_STEPS_PER_CALL, both: true });
    expect(second).toMatchObject({ ok: true, verified: true, stepsLeft: 0, capsule: null });
    expect(second.targets.map((t) => t.index)).toEqual([HEAD, HEAD - 1]);
    expect(capsuleAsks()).toEqual([N[0], N[1]]);
  });

  it('three valid signatures of four entries are refused; the node waits out the TTL; no proof is fetched', async () => {
    const good = capsuleAt();
    const forged = { ...good, sigs: [...good.sigs.slice(0, 3), [GENESIS_IDS[3], good.sigs[0][1].replace(GENESIS_IDS[0], GENESIS_IDS[3])]] };
    serve({ capsule: { [N[0]]: forged } });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(proofsAsked()).toEqual([]);
    expect(lc.heldCapsuleIndex()).toBe(0);
    await lc.refreshCapsule(nodes);
    expect(capsuleAsks()).toEqual([N[0], N[1], N[2], N[3]]);
  });

  it.each([
    ['another network', { over: { network_id: lab('other') } }],
    ['K not a multiple of the interval', { k: KC + 1 }],
    ['K above the head + 2', { k: HEAD + 9 }],
  ])('%s: refused before any signature, the walk from the pin unchanged', async (_, { k = KC, over = {} }) => {
    serve({ capsule: { [N[0]]: capsuleAt(k, { over }) } });
    verifyDilithium.mockClear();
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(verifyDilithium).not.toHaveBeenCalled();
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(10), 10 * 90, nodes)).resolves.toBe(true);
    expect(indicesAsked()).toEqual([2, 4, 6, 8, 10]);
  });

  it('two nodes whose proofs of K hash to another checkpoint drop it, and it is not taken again within the TTL', async () => {
    const capsule = capsuleAt();
    serve({ capsule: () => capsule, proof: (base, j) => (j === KC ? proofFor(j, { timestamp: 7 }) : undefined) });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'conflict' });
    expect(lc.heldCapsuleIndex()).toBe(0);
    calls.length = 0;
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'conflict' });
    expect(proofsAsked()).toEqual([]);
  });

  it('an offer whose roots are not served yet leaves the next, lower one: the highest that roots is held', async () => {
    const higher = capsuleAt(KC + 10);
    serve({
      capsule: { [N[0]]: higher, [N[1]]: capsuleAt() },
      proof: (base, j) => (j === KC + 10 ? { error: 'macroblock_not_found', index: j } : undefined),
    });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: true, index: KC });
    expect(lc.heldCapsuleIndex()).toBe(KC);
  });

  it('a proof whose hashes are not lowercase hex is that node\'s failure; only lowercase roots are kept', async () => {
    // The checkpoint hash decodes hex in any case, so a registry root in capitals would verify and then be kept, and
    // compared two steps up, as served: every node refused there, for good.
    const upper = (p) => ({ ...p, checkpoint: { ...p.checkpoint, registry_root: p.checkpoint.registry_root.toUpperCase() } });
    serve({ proof: (base, j) => (base === N[0] ? upper(proofFor(j)) : undefined) });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(9), 9 * 90, nodes)).resolves.toBe(true);
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(13), 13 * 90, nodes)).resolves.toBe(true);
    expect(lc.verifiedCheckpoint(13).registryRoot).toBe(REG_ROOT);
    expect(lc.exportVerifiedAnchors()[13].registry_root).toBe(REG_ROOT);
    // A capsule root in capitals is refused the same way, and an unknown checkpoint field is never kept.
    const capsule = capsuleAt();
    const roots = { [KC]: { ...partsOf(upper(proofFor(KC))) }, [KC - 1]: partsOf(proofFor(KC - 1)) };
    reset();
    await expect(lc.importCapsule({ capsule, roots })).resolves.toEqual({ ok: false, reason: 'root_shape' });
    const padded = { ...partsOf(proofFor(KC)), checkpoint: { ...proofFor(KC).checkpoint, extra: 'x'.repeat(1000) } };
    await expect(lc.importCapsule({ capsule, roots: { ...roots, [KC]: padded } })).resolves.toEqual({ ok: true, index: KC });
    expect(lc.exportCapsule().roots[KC].checkpoint.extra).toBeUndefined();
  });

  it('one node serving another checkpoint of K is not enough: two others confirm it', async () => {
    const capsule = capsuleAt();
    serve({ capsule: () => capsule, proof: (base, j) => (j === KC && base === N[0] ? proofFor(j, { timestamp: 7 }) : undefined) });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: true, index: KC });
  });

  it('a signed checkpoint with an epoch commitment its eligible set does not match is not confirmed', async () => {
    const capsule = capsuleAt();
    const bad = (j) => ({ ...proofFor(j), eligible_raw: eligibleRawHex(GENESIS_IDS.slice(1)) });
    serve({ capsule: () => capsule, proof: (base, j) => (j === KC - 1 ? bad(j) : undefined) });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'unrooted' });
    expect(lc.heldCapsuleIndex()).toBe(0);
  });

  it('a capsule naming another checkpoint than one this device verified is refused', async () => {
    serve();
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(KC), KC * 90, nodes)).resolves.toBe(true);
    const other = capsuleAt(KC, { timestamp: 7 });
    serve({ capsule: () => other });
    await expect(lc.refreshCapsule(nodes, { force: true })).resolves.toEqual({ ok: false, reason: 'conflict' });
    await expect(lc.importCapsule(recordAt(KC, { timestamp: 7 }))).resolves.toEqual({ ok: false, reason: 'conflict' });
    expect(lc.heldCapsuleIndex()).toBe(0);
  });

  it('a walk from this device\'s own anchor through K that verifies another checkpoint drops the capsule', async () => {
    serve();
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(36), 36 * 90, nodes)).resolves.toBe(true);
    await expect(lc.importCapsule(recordAt(KC, { timestamp: 7 }))).resolves.toEqual({ ok: true, index: KC });
    const dropped = [];
    calls.length = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(44), 44 * 90, nodes, { onCapsuleDropped: () => dropped.push(1) }))
      .resolves.toBe(true);
    expect(indicesAsked()).toEqual([38, 40, 42, 44]); // the own anchor is 4 steps away: walked from it, not from the capsule
    expect(dropped).toEqual([1]);
    expect(lc.heldCapsuleIndex()).toBe(0);
  });

  it('is replaced only by a higher K; export and import verify it again', async () => {
    await expect(lc.importCapsule(recordAt(KC))).resolves.toEqual({ ok: true, index: KC });
    await expect(lc.importCapsule(recordAt(KC - 10))).resolves.toEqual({ ok: false, reason: 'stale' });
    await expect(lc.importCapsule(recordAt(KC))).resolves.toEqual({ ok: false, reason: 'stale' });
    const kept = lc.exportCapsule();
    expect(Object.keys(kept.roots).map(Number).sort()).toEqual([KC - 1, KC]);
    lc.clearCapsule();
    expect(lc.heldCapsuleIndex()).toBe(0);
    const tampered = JSON.parse(JSON.stringify(kept));
    tampered.roots[KC].checkpoint.state_root = 'ee'.repeat(32);
    await expect(lc.importCapsule(tampered)).resolves.toEqual({ ok: false, reason: 'cp_hash' });
    const resigned = JSON.parse(JSON.stringify(kept));
    resigned.capsule.sigs[3] = [GENESIS_IDS[3], sigString(GENESIS_IDS[3], GENESIS_IDS[4], lc.capsulePreimage(kept.capsule))];
    await expect(lc.importCapsule(resigned)).resolves.toEqual({ ok: false, reason: 'signatures' });
    await expect(lc.importCapsule({ ...kept, capsule: { ...kept.capsule, network_id: lab('other') } }))
      .resolves.toEqual({ ok: false, reason: 'network_id' });
    await expect(lc.importCapsule(null)).resolves.toEqual({ ok: false, reason: 'shape' });
    await expect(lc.importCapsule(kept)).resolves.toEqual({ ok: true, index: KC });
    // A higher one replaces it.
    await expect(lc.importCapsule(recordAt(KC + 10))).resolves.toEqual({ ok: true, index: KC + 10 });
    expect(lc.heldCapsuleIndex()).toBe(KC + 10);
  });

  it('while no newer capsule can exist, a refresh asks nobody', async () => {
    serve({ head: KC + 5 });
    await expect(lc.importCapsule(recordAt(KC))).resolves.toEqual({ ok: true, index: KC });
    await expect(lc.refreshCapsule(nodes)).resolves.toEqual({ ok: false, reason: 'current' });
    expect(capsuleAsks()).toEqual([]);
  });

  it('while this device\'s own anchor is a few steps away the walk starts there, not at the capsule', async () => {
    serve({ head: 61 });
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(46), 46 * 90, nodes)).resolves.toBe(true);
    await expect(lc.importCapsule(recordAt(50))).resolves.toEqual({ ok: true, index: 50 });
    expect(lc.stepsToVerify(60)).toBe(7);
    await expect(lc.refreshCapsule(nodes)).resolves.toMatchObject({ ok: false });
    calls.length = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(60), 60 * 90, nodes)).resolves.toBe(true);
    expect(indicesAsked()).toEqual([48, 50, 52, 54, 56, 58, 60]);
    expect(lc.heldCapsuleIndex()).toBe(50); // the walk verified the checkpoint it names
    // The odd parity has no own anchor: it roots at K-1.
    expect(lc.stepsToVerify(61)).toBe(6);
  });

  it('survives the LRU of verified macroblocks; clearQcCache keeps it, a rewind (clearCapsule) clears it', async () => {
    serve({ head: 400 });
    await expect(lc.importCapsule(recordAt(KC))).resolves.toEqual({ ok: true, index: KC });
    const top = KC + 2 * (lc.VERIFIED_CACHE_MAX + 6);
    while (!(await lc.verifyMacroblockStateRoot(stateRootOf(top), top * 90, nodes))) {
      // the next call resumes from what the last one verified
    }
    expect(indicesAsked()[0]).toBe(KC + 2);
    calls.length = 0;
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(KC), KC * 90, nodes)).resolves.toBe(true);
    expect(calls).toEqual([]);
    expect(lc.heldCapsuleIndex()).toBe(KC);
    lc.clearQcCache();
    expect(lc.heldCapsuleIndex()).toBe(KC);
    expect(lc.stepsToVerify(KC + 2)).toBe(1);
    lc.clearCapsule();
    expect(lc.heldCapsuleIndex()).toBe(0);
    expect(lc.exportCapsule()).toBeNull();
    expect(lc.stepsToVerify(KC + 2)).toBe(Infinity);
  });

  it('a root two nodes refuse the first step above goes; the walk then roots lower', async () => {
    // A capsule whose K-1 data are another lineage's (its eligible set signs nothing here): adopted offline, refused live.
    const foreignIds = ['other_node_a', 'other_node_b'];
    const foreign = (j) => {
      const p = proofFor(j);
      const raw = eligibleRawHex(foreignIds);
      const cp = { ...p.checkpoint, epoch_commitment: lc.epochCommitment(Buffer.from(raw, 'hex'), foreignIds, []) };
      return { ...p, checkpoint: cp, eligible_raw: raw, committee: foreignIds };
    };
    const f = capsuleAt(KC, { over: { cp_hash_pred: lc.checkpointHash(foreign(KC - 1).checkpoint) } });
    serve();
    await expect(lc.importCapsule({ capsule: f, roots: { [KC]: partsOf(proofFor(KC)), [KC - 1]: partsOf(foreign(KC - 1)) } }))
      .resolves.toEqual({ ok: true, index: KC });
    const dropped = [];
    await expect(lc.verifyMacroblockStateRoot(stateRootOf(45), 45 * 90, nodes, { onCapsuleDropped: () => dropped.push(1) }))
      .resolves.toBe(true);
    expect(dropped).toEqual([1]);
    expect(lc.heldCapsuleIndex()).toBe(0);
    const asked = indicesAsked();
    expect(asked.slice(0, asked.indexOf(1)).every((j) => j > KC)).toBe(true); // first above the capsule, then from the root
  });
});

describe('a pinned build', () => {
  const pinAt = (k) => {
    const a = { eligible_raw: ELIGIBLE, beacon: BEACON, registry_root: REG_ROOT };
    return { index: k, hash: 'ef'.repeat(32), anchors: { [k]: a, [k - 1]: a } };
  };

  it('refuses a capsule at or below the pin; the trust floor stays at the pin, and log proofs below K still verify', async () => {
    ({ lc, verifyDilithium } = load(pinAt(20)));
    try {
      serve();
      expect(lc.capsuleProblem(capsuleAt(20), HEAD)).toBe('below_pin');
      await expect(lc.importCapsule(recordAt(20))).resolves.toEqual({ ok: false, reason: 'below_pin' });
      await expect(lc.importCapsule(recordAt(KC))).resolves.toEqual({ ok: true, index: KC });
      expect(lc.trustFloorIndex()).toBe(21);
      await expect(lc.verifyMacroblockLogsRoot('00'.repeat(32), 30 * 90, nodes)).resolves.toBe(true);
      expect(indicesAsked()).toEqual([22, 24, 26, 28, 30]); // from the pin: K is above
      await expect(lc.verifyMacroblockLogsRoot('00'.repeat(32), 20 * 90, nodes)).resolves.toBe(false); // the pin itself
    } finally {
      ({ lc, verifyDilithium } = load());
    }
  });
});

/**
 * Certified state proofs (proof_format 2): a node names the committee-certified macroblock whose state root its proof
 * folds to, and the client folds to the root IT verified for that index, never to the one served.
 * - the shared verifier (src/crypto/SmtFold.js): every leaf field, the three proof kinds, strict reading;
 * - the light client: the root of a named macroblock (walking up to it only), the certified head, a node that says it
 *   holds no such macroblock, the walk's memory bound by bytes;
 * - the wallet: the certified form asked for, the older body of a node from before it, rate limits, never an unverified 0.
 * The proofs here come from a small reference tree built in this file the way the node builds its tree.
 */
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
  jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(async () => true), isDilithiumAvailable: () => true }));
  lc = require('../src/crypto/QcLightClient');
  ({ verifyDilithium } = require('../src/crypto/DilithiumCrypto'));
  ({ GENESIS_NODE_IDS, GENESIS_CONSENSUS_PKS } = require('../src/config/genesisConsensus'));
});
const smt = require('../src/crypto/SmtFold');

jest.setTimeout(120000);

// ── a reference sparse-Merkle tree: buckets of the leading 40 key bits, 40 tree levels above them ──
const hexb = (h) => Buffer.from(h, 'hex');
const H2 = (a, b) => sha3_256(Buffer.concat([hexb(a), hexb(b)]));
const ZERO = '00'.repeat(32);
const DEFAULTS = [ZERO];
for (let d = 1; d <= 256; d++) DEFAULTS.push(H2(DEFAULTS[d - 1], DEFAULTS[d - 1]));
const bitOf = (key, i) => (parseInt(key.substr((i >> 3) * 2, 2), 16) >> (7 - (i % 8))) & 1;
const tagged = (k, v) => sha3_256(Buffer.concat([Buffer.from([0xb5]), hexb(k), hexb(v)]));
const fold = (level) => {
  let cur = level;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? H2(cur[i], cur[i + 1]) : cur[i]);
    cur = next;
  }
  return cur[0];
};
const sorted = (entries) => [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
// The hash of the subtree at `depth` holding `entries` (all sharing its prefix).
function nodeHash(entries, depth) {
  if (depth === 216) return entries.length ? fold(sorted(entries).map(([k, v]) => tagged(k, v))) : DEFAULTS[216];
  if (entries.length === 0) return DEFAULTS[depth];
  const split = 256 - depth;
  return H2(nodeHash(entries.filter(([k]) => bitOf(k, split) === 0), depth - 1),
    nodeHash(entries.filter(([k]) => bitOf(k, split) === 1), depth - 1));
}
function tree(entries) {
  const all = sorted(entries);
  const root = nodeHash(all, 256);
  const prove = (key) => {
    const bucket = all.filter(([k]) => k.slice(0, 10) === key.slice(0, 10));
    const steps = [];
    const at = bucket.findIndex(([k]) => k === key);
    if (at >= 0) {
      let level = bucket.map(([k, v]) => tagged(k, v));
      let idx = at;
      while (level.length > 1) {
        if ((idx ^ 1) < level.length) steps.push({ sibling: level[idx ^ 1], is_right: (idx & 1) === 1 });
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? H2(level[i], level[i + 1]) : level[i]);
        level = next;
        idx = Math.floor(idx / 2);
      }
    }
    for (let depth = 216; depth < 256; depth++) {
      // The sibling subtree at `depth`: the key's leading 256-depth bits with the last of them flipped.
      const own = 255 - depth;
      const sib = all.filter(([k]) => {
        for (let i = 0; i < own; i++) if (bitOf(k, i) !== bitOf(key, i)) return false;
        return bitOf(k, own) !== bitOf(key, own);
      });
      steps.push({ sibling: nodeHash(sib, depth), is_right: bitOf(key, own) === 1 });
    }
    const kind = at >= 0 ? 'inclusion' : bucket.length ? 'absence_in_bucket' : 'absence';
    return { kind, steps, entries: at < 0 && bucket.length ? bucket.map(([k, v]) => ({ key: k, leaf: v })) : undefined };
  };
  return { root, prove };
}

const addrKey = (a) => smt.addressKeyHash(a, sha3_256);
const fieldsOf = (o = {}) => ({
  balance: '0', nonce: '0', is_contract: false, contract_code_hash: null, storage_root: null, heartbeat_epoch: '0',
  heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0', banned_at_height: '0',
  is_node: false, ...o,
});
const leafOf = (address, f) => smt.accountLeafHash(address, f, sha3_256);

// A certified account answer for `address` in the state `t` at macroblock `index`.
function accountAnswer(t, address, f, index, extra = {}) {
  const p = t.prove(addrKey(address));
  const fields = p.kind === 'inclusion' ? f : fieldsOf();
  return {
    proof_format: 2, address, macroblock_index: index, state_height: String(index * 90), state_root: t.root,
    exists: p.kind === 'inclusion', proof_kind: p.kind, ...fields, merkle_proof: p.steps,
    ...(p.entries ? { bucket_entries: p.entries } : {}), ...extra,
  };
}

// ── the golden accounts of the node's golden_vectors_for_clients ──
const PLAIN = 'eon_golden_plain';
const CONTRACT = 'eon_golden_contract';
const plainFields = fieldsOf({ balance: '5000000000', nonce: '3', heartbeat_epoch: '12', heartbeat_slots: 0x01ff, last_claimed_epoch: '10' });
const storage = tree([
  [smt.storageKeyHash('balance:' + PLAIN, sha3_256), smt.storageLeafValue('250', sha3_256)],
  [smt.storageKeyHash('total_supply', sha3_256), smt.storageLeafValue('1000', sha3_256)],
]);
const contractFields = fieldsOf({ is_contract: true, contract_code_hash: 'c0de'.repeat(16), storage_root: storage.root });
const state = tree([[addrKey(PLAIN), leafOf(PLAIN, plainFields)], [addrKey(CONTRACT), leafOf(CONTRACT, contractFields)]]);
const stepDigest = (steps) => sha3_256(Buffer.concat(steps.flatMap((s) => [hexb(s.sibling), Buffer.from([s.is_right ? 1 : 0])])));
const coBucket = (key) => key.slice(0, 62) + (parseInt(key.slice(62), 16) ^ 1).toString(16).padStart(2, '0');

describe('the shared verifier', () => {
  it('the account leaf covers every field and matches the node\'s leaf for a plain account', () => {
    const v = require('./fixtures/smt_account_proof.json');
    const leaf = leafOf(v.address, fieldsOf({ balance: String(v.balance), nonce: String(v.nonce) }));
    expect(smt.verifyInclusion(addrKey(v.address), leaf, v.proof, v.state_root, sha3_256)).toBe(true);
    // Each field moves the leaf: nothing is hardcoded to zero.
    const base = leafOf(PLAIN, plainFields);
    for (const [k, val] of [['heartbeat_epoch', '13'], ['heartbeat_slots', 1], ['heartbeat_final_epoch', '1'],
      ['heartbeat_final_slots', 2], ['last_claimed_epoch', '11'], ['banned_at_height', '9'], ['is_node', true],
      ['contract_code_hash', '']]) {
      expect(leafOf(PLAIN, { ...plainFields, [k]: val })).not.toBe(base);
    }
  });

  it('golden vectors: fixed inputs give fixed hex (the node\'s golden_vectors_for_clients inputs)', () => {
    const inc = state.prove(addrKey(PLAIN));
    const abs = state.prove(addrKey('eon_golden_absent'));
    const aib = state.prove(coBucket(addrKey(PLAIN)));
    expect(abs.kind).toBe('absence');
    expect(aib.kind).toBe('absence_in_bucket');
    const got = {
      plain_leaf: leafOf(PLAIN, plainFields),
      contract_leaf: leafOf(CONTRACT, contractFields),
      storage_leaf: smt.storageLeafValue('250', sha3_256),
      root: state.root,
      inclusion_steps: stepDigest(inc.steps),
      absence_steps: stepDigest(abs.steps),
      absence_in_bucket_steps: stepDigest(aib.steps),
    };
    expect(got).toEqual(GOLDEN);
  });

  it('inclusion, absence and absence in a shared bucket each fold exactly', () => {
    const inc = state.prove(addrKey(PLAIN));
    expect(smt.verifyInclusion(addrKey(PLAIN), leafOf(PLAIN, plainFields), inc.steps, state.root, sha3_256)).toBe(true);
    expect(smt.verifyInclusion(addrKey(PLAIN), ZERO, inc.steps, state.root, sha3_256)).toBe(false);
    const absKey = addrKey('eon_golden_absent');
    const abs = state.prove(absKey);
    expect(smt.verifyAbsence(absKey, abs.steps, state.root, sha3_256)).toBe(true);
    expect(smt.verifyAbsence(absKey, abs.steps.slice(1), state.root, sha3_256)).toBe(false);
    // Plain absence over a crowded bucket proves nothing.
    const key = coBucket(addrKey(PLAIN));
    const aib = state.prove(key);
    const entries = aib.entries.map((e) => [e.key, e.leaf]);
    expect(smt.verifyAbsenceInBucket(key, entries, aib.steps, state.root, sha3_256)).toBe(true);
    expect(smt.verifyAbsence(key, aib.steps, state.root, sha3_256)).toBe(false);
  });

  it('an absence in a shared bucket refuses every forgery', () => {
    const member = addrKey(PLAIN);
    // A crowded bucket: three more members around the asked key.
    const extra = [0, 1, 2].map((j) => [member.slice(0, 58) + (0x10 + j).toString(16) + member.slice(60), (0x40 + j).toString(16).repeat(32)]);
    const crowded = tree([[member, leafOf(PLAIN, plainFields)], ...extra]);
    const key = coBucket(member);
    const p = crowded.prove(key);
    const entries = p.entries.map((e) => [e.key, e.leaf]);
    const ok = (e, s = p.steps) => smt.verifyAbsenceInBucket(key, e, s, crowded.root, sha3_256);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(ok(entries)).toBe(true);
    expect(ok(sorted([...entries, [key, '01'.repeat(32)]]))).toBe(false); // the key among the entries
    expect(ok([entries[1], entries[0], ...entries.slice(2)])).toBe(false); // unsorted
    const outside = entries.map((e, i) => (i === 0 ? [(parseInt(e[0][0], 16) ^ 8).toString(16) + e[0].slice(1), e[1]] : e));
    expect(ok(sorted(outside))).toBe(false); // an entry outside the bucket
    expect(ok(entries.slice(1))).toBe(false); // a dropped entry
    expect(ok(entries.map((e, i) => (i === 0 ? [e[0], ZERO] : e)))).toBe(false); // a zero leaf
    const many = Array.from({ length: 65 }, (_, i) => [member.slice(0, 60) + 'ee' + i.toString(16).padStart(2, '0'), '01'.repeat(32)]);
    expect(ok(sorted(many))).toBe(false); // 65 entries
    expect(ok(entries, p.steps.slice(1))).toBe(false); // 39 steps
    expect(ok(entries, [...p.steps, { sibling: ZERO, is_right: false }])).toBe(false); // 41 steps
  });

  it('a certified account answer is read strictly and folds only to the root it is given', () => {
    const body = accountAnswer(state, PLAIN, plainFields, 7);
    const r = smt.readCertifiedAccount(body, PLAIN, sha3_256);
    expect(r).toMatchObject({ ok: true, index: 7, account: { exists: true, balance: '5000000000', nonce: '3' } });
    expect(r.fold(state.root)).toBe(true);
    expect(r.fold('ee'.repeat(32))).toBe(false);
    const read = (b, a = PLAIN) => smt.readCertifiedAccount(b, a, sha3_256);
    expect(read(body, CONTRACT).ok).toBe(false); // another address
    expect(read({ ...body, state_height: '631' }).ok).toBe(false); // the height is not 90 x index
    expect(read({ ...body, exists: false }).ok).toBe(false);
    expect(read({ ...body, proof_format: 1 }).ok).toBe(false);
    expect(read({ ...body, heartbeat_slots: 70000 }).ok).toBe(false);
    expect(read({ ...body, bucket_entries: [] }).ok).toBe(false);
    // A changed balance no longer folds.
    expect(read({ ...body, balance: '5000000001' }).fold(state.root)).toBe(false);
    // An absence counts only with its proof, and names nothing.
    const absent = accountAnswer(state, 'eon_golden_absent', null, 7);
    const a = read(absent, 'eon_golden_absent');
    expect(a).toMatchObject({ ok: true, account: { exists: false, balance: '0' } });
    expect(a.fold(state.root)).toBe(true);
    expect(read({ ...absent, balance: '5' }, 'eon_golden_absent').ok).toBe(false);
    expect(read({ ...absent, merkle_proof: absent.merkle_proof.slice(1) }, 'eon_golden_absent').ok).toBe(false);
  });

  it('a certified token answer proves the contract under the root and the holder under the contract\'s storage root', () => {
    const level1 = state.prove(addrKey(CONTRACT));
    const level2 = storage.prove(smt.storageKeyHash('balance:' + PLAIN, sha3_256));
    const body = {
      proof_format: 2, contract_address: CONTRACT, holder: PLAIN, macroblock_index: 9, state_height: 810, state_root: state.root,
      contract_status: 'contract', account_proof_kind: 'inclusion', account_proof: level1.steps,
      account_balance: '0', account_nonce: '0', contract_code_hash: contractFields.contract_code_hash, storage_root: storage.root,
      heartbeat_epoch: '0', heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0',
      banned_at_height: '0', is_node: false, storage_proof_kind: 'inclusion', token_balance: '250', storage_proof: level2.steps,
    };
    const read = (b, holder = PLAIN) => smt.readCertifiedToken(b, CONTRACT, holder, sha3_256);
    const r = read(body);
    expect(r).toMatchObject({ ok: true, index: 9, status: 'contract', balanceBase: '250' });
    expect(r.fold(state.root)).toBe(true);
    expect(read({ ...body, token_balance: '251' }).fold(state.root)).toBe(false);
    // The storage root is the one the proven contract leaf commits to.
    expect(read({ ...body, storage_root: 'ab'.repeat(32) }).fold(state.root)).toBe(false);
    expect(read(body, CONTRACT).ok).toBe(false); // another holder
    // A holder with no entry: '0', proven.
    const other = 'eon_no_balance';
    const none = storage.prove(smt.storageKeyHash('balance:' + other, sha3_256));
    const drained = read({
      ...body, holder: other, storage_proof_kind: none.kind, storage_proof: none.steps, token_balance: '0',
      ...(none.entries ? { storage_bucket_entries: none.entries } : {}),
    }, other);
    expect(drained).toMatchObject({ ok: true, balanceBase: '0' });
    expect(drained.fold(state.root)).toBe(true);
    // A contract that does not exist: 'absent' with its level-1 proof, no level 2; a status without it is no answer.
    const noContract = state.prove(addrKey('eon_no_contract'));
    const absentBody = {
      proof_format: 2, contract_address: 'eon_no_contract', holder: PLAIN, macroblock_index: 9, state_height: '810',
      contract_status: 'absent', account_proof_kind: noContract.kind, account_proof: noContract.steps, account_balance: '0',
      account_nonce: '0', contract_code_hash: null, storage_root: null, heartbeat_epoch: '0', heartbeat_slots: 0,
      heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0', banned_at_height: '0', is_node: false,
    };
    const absent = smt.readCertifiedToken(absentBody, 'eon_no_contract', PLAIN, sha3_256);
    expect(absent).toMatchObject({ ok: true, status: 'absent', balanceBase: '0' });
    expect(absent.fold(state.root)).toBe(true);
    expect(smt.readCertifiedToken({ ...absentBody, contract_status: 'contract' }, 'eon_no_contract', PLAIN, sha3_256).ok).toBe(false);
    // A plain account in the contract's place: 'not_contract' with its inclusion proof.
    const plainAsContract = smt.readCertifiedToken({
      ...absentBody, contract_address: PLAIN, contract_status: 'not_contract', account_proof_kind: 'inclusion',
      account_proof: state.prove(addrKey(PLAIN)).steps, account_balance: '5000000000', account_nonce: '3',
      heartbeat_epoch: '12', heartbeat_slots: 0x01ff, last_claimed_epoch: '10',
    }, PLAIN, PLAIN, sha3_256);
    expect(plainAsContract).toMatchObject({ ok: true, status: 'not_contract', balanceBase: '0' });
    expect(plainAsContract.fold(state.root)).toBe(true);
  });

  it('an older node is recognised by its positive shape only, never by a rate limit or an error', () => {
    const legacy = { balance: 1, nonce: 0, merkle_proof: [], state_root: 'ab', block_height: 900, proof_valid: true };
    expect(smt.isLegacyProofBody(legacy)).toBe(true);
    expect(smt.isLegacyProofBody({ ...legacy, proof_valid: false, error: 'account not found' })).toBe(true);
    expect(smt.isLegacyProofBody({ success: false, error: 'Rate limit exceeded', retry_after_seconds: 3 })).toBe(false);
    expect(smt.isLegacyProofBody({ proof_format: 2, error: 'rate_limited', retry_after_seconds: 3 })).toBe(false);
    expect(smt.isLegacyProofBody({ ...legacy, proof_format: 2 })).toBe(false);
    expect(smt.isLegacyProofBody({ ...legacy, block_height: '900' })).toBe(false);
    expect(smt.isLegacyProofBody({ token_balance: '0', error: 'token balance not provable', proof_valid: false }, 'token')).toBe(false);
    expect(smt.isLegacyProofBody({ account_proof: [], storage_proof: [], block_height: 9, proof_valid: true }, 'token')).toBe(true);
    expect(lc.isRateLimitBody({ proof_format: 2, error: 'rate_limited', retry_after_seconds: 5 })).toBe(true);
    expect(lc.isRateLimitBody({ proof_format: 2, error: 'busy' })).toBe(false);
  });
});

// ── a synthetic certified chain for the light client ──
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
function wireSig(nodeId, pad = 0) {
  const sig = Buffer.alloc(3309, 7);
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length);
  return 'dilithium_sig_' + nodeId + '_' + Buffer.concat([len, sig, Buffer.alloc(pad, 1)]).toString('base64');
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
function proofFor(j, { root = stateRootOf(j), pad = 0 } = {}) {
  const committee = j < 3 ? IDS.slice() : lc.sampleCommittee([...IDS].sort(), j, BEACON);
  const cp = {
    index: j, parent_qc: null, window_head_height: j * 90, window_mb_hashes: [], state_root: root, beacon: BEACON,
    epoch_commitment: lc.epochCommitment(Buffer.from(ELIGIBLE, 'hex'), committee, []),
    reward_root: ZERO, registry_root: REG_ROOT, logs_root: ZERO, dilithium_pk_root: ZERO, reward_epoch_root: ZERO,
    total_supply: '0', timestamp: 0, proposer: IDS[0], recovery_anchor: null,
  };
  const signers = committee.slice(0, lc.quorumSize(committee.length));
  return {
    index: j, checkpoint: cp, eligible_raw: ELIGIBLE, banned: [],
    committee_pubkeys: Object.fromEntries(committee.map((id) => [id, GENESIS_CONSENSUS_PKS[id]])),
    qc: { signers, sigs: signers.map((id) => wireSig(id, pad)) },
  };
}
const N1 = 'https://node1.aiqnet.io';
const N2 = 'https://node2.aiqnet.io';
const N3 = 'https://node3.aiqnet.io';
const N4 = 'https://node4.aiqnet.io';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let asked;
let inFlight;
let maxInFlight;
function serveChain({ top = Infinity, answer = null, delay = 0, pad = 0, roots = {} } = {}) {
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
      try { if (delay) await sleep(delay); } finally { inFlight -= 1; }
      const own = answer ? answer(base, j) : undefined;
      if (own !== undefined) return own;
      if (j > top) return { ok: true, json: async () => ({ error: 'macroblock_not_found', index: j }) };
      const body = proofFor(j, { root: roots[j], pad });
      const text = JSON.stringify(body);
      return { ok: true, headers: { get: () => null }, text: async () => text, json: async () => body };
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

describe('the root of a named macroblock', () => {
  it('walks up to that index only, never to the tip, and gives its verified state root', async () => {
    serveChain({ top: 30 });
    await expect(lc.certifiedStateRootAt(10, () => [N1, N2])).resolves.toEqual({ ok: true, index: 10, stateRoot: stateRootOf(10) });
    expect(Math.max(...asked.map(([, j]) => j))).toBe(10);
    // Verified once: no fetch the next time.
    const before = global.fetch.mock.calls.length;
    await expect(lc.certifiedStateRootAt(10, () => [N1])).resolves.toMatchObject({ ok: true });
    expect(global.fetch.mock.calls.length).toBe(before);
    await expect(lc.certifiedStateRootAt(0, () => [N1])).resolves.toEqual({ ok: false, reason: 'below_floor' });
    await expect(lc.certifiedStateRootAt(1.5, () => [N1])).resolves.toEqual({ ok: false, reason: 'below_floor' });
  });

  it('a hostile first node saying it holds no such macroblock is passed over, never charged', async () => {
    serveChain({ answer: (base, j) => (base === N1 && j === 10 ? { ok: true, json: async () => ({ error: 'macroblock_not_found' }) } : undefined) });
    const failures = [];
    const r = await lc.certifiedStateRootAt(10, () => [N1, N2, N3], { onNodeFailure: (b, why) => failures.push([b, why]) });
    expect(r).toEqual({ ok: true, index: 10, stateRoot: stateRootOf(10) });
    expect(askedFor(10).map(([b]) => b)).toEqual([N1, N2]);
    expect(failures).toEqual([]);
  });

  it('not certified yet: asked of the first node and at most two more, none charged, then said so', async () => {
    serveChain({ top: 8 });
    const failures = [];
    const r = await lc.certifiedStateRootAt(10, () => [N1, N2, N3, N4], { onNodeFailure: (b, why) => failures.push([b, why]) });
    expect(r).toEqual({ ok: false, reason: 'not_certified' });
    expect(askedFor(10).map(([b]) => b)).toEqual([N1, N2, N3]);
    expect(lc.NOT_FOUND_MORE_NODES).toBe(2);
    expect(failures).toEqual([]);
    expect(lc.highestVerifiedIndex()).toBe(8);
  });

  it('a root the committee certified for another index never stands for this one', async () => {
    serveChain({ roots: { 10: 'cd'.repeat(32) } });
    await expect(lc.certifiedStateRootAt(10, () => [N1])).resolves.toEqual({ ok: true, index: 10, stateRoot: 'cd'.repeat(32) });
    await expect(lc.certifiedStateRootAt(8, () => [N1])).resolves.toEqual({ ok: true, index: 8, stateRoot: stateRootOf(8) });
  });
});

describe('the walk\'s memory is bounded by bytes', () => {
  it('a 1000-member committee keeps at most two proofs in flight within 16 MB; a small one keeps five', () => {
    expect(lc.WALK_INFLIGHT_BYTES).toBe(16 * 1024 * 1024);
    const big = lc.prefetchShareBytes(1000);
    expect(big).toBeGreaterThanOrEqual(7 * 1024 * 1024);
    expect(Math.floor(lc.WALK_INFLIGHT_BYTES / big)).toBeLessThanOrEqual(2);
    expect(lc.prefetchShareBytes(5)).toBe(lc.PREFETCH_SHARE_MIN);
    expect(Math.floor(lc.WALK_INFLIGHT_BYTES / lc.PREFETCH_SHARE_MIN)).toBeGreaterThanOrEqual(lc.WALK_PREFETCH);
    // The largest proof the walk received raises every share after it.
    expect(lc.prefetchShareBytes(5, 3 * 1024 * 1024)).toBe(6 * 1024 * 1024);
    expect(lc.proofBytes(proofFor(9, { pad: 100_000 }))).toBeGreaterThan(lc.proofBytes(proofFor(9)) + 4 * 130_000);
  });

  it('within a lower bound, fewer proofs are in flight at once; with the default, the full depth', async () => {
    serveChain({ delay: 40 });
    await expect(lc.certifiedStateRootAt(20, () => [N1], { prefetchBytes: 2 * lc.PREFETCH_SHARE_MIN })).resolves.toMatchObject({ ok: true });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    lc.clearQcCache();
    serveChain({ delay: 40 });
    await expect(lc.certifiedStateRootAt(20, () => [N1])).resolves.toMatchObject({ ok: true });
    expect(maxInFlight).toBeGreaterThanOrEqual(4);
  });

  it('a proof fetched ahead that is larger than its share is fetched again by its step, and nobody is charged', async () => {
    // Every proof is over the smallest share (the signatures padded), so each prefetch is cut off at its share.
    serveChain({ pad: 200_000 });
    const failures = [];
    const r = await lc.certifiedStateRootAt(8, () => [N1, N2], { onNodeFailure: (b, why) => failures.push([b, why]) });
    expect(r).toMatchObject({ ok: true, stateRoot: stateRootOf(8) });
    expect(failures).toEqual([]);
  });
});

describe('the certified head', () => {
  const G = ['https://g1.example', 'https://g2.example', 'https://g3.example', 'https://g4.example', 'https://g5.example'];
  const serveHeads = (heads, { old = {} } = {}) => {
    global.fetch = jest.fn(async (url) => {
      const base = G.find((g) => url.startsWith(g + '/'));
      if (url.endsWith('/api/v1/height')) throw new Error('the applied tip is never read');
      if (base && url.endsWith('/api/v1/state/certified') && heads[base] !== undefined) {
        const body = { proof_format: 2, views: [], newest_certified_index: heads[base], finalized_height: 0, applied_height: 999999, capture: 'ok' };
        return { ok: true, json: async () => body };
      }
      if (base && url.endsWith('/api/v1/debug/consensus-position') && old[base] !== undefined) {
        return { ok: true, json: async () => ({ height: 999999, last_sealed_mb_index: old[base] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  };

  it('is the second highest certified frontier of at least three genesis answers; one far liar moves nothing', async () => {
    serveHeads({ [G[0]]: 900, [G[1]]: 300, [G[2]]: 299, [G[3]]: 298 });
    await expect(lc.certifiedHeadHint(() => G)).resolves.toBe(300);
    await expect(lc.certifiedHead(() => G)).resolves.toBe(300);
    expect(global.fetch.mock.calls.some(([u]) => u.endsWith('/api/v1/height'))).toBe(false);
    // Cached for a minute.
    const n = global.fetch.mock.calls.length;
    await expect(lc.certifiedHeadHint(() => G)).resolves.toBe(300);
    expect(global.fetch.mock.calls.length).toBe(n);
  });

  it('with fewer than three answers there is no head, and no proof can count as fresh', async () => {
    serveHeads({ [G[0]]: 300, [G[1]]: 300 });
    await expect(lc.certifiedHeadHint(() => G)).resolves.toBeNull();
    await expect(lc.certifiedHead(() => G)).resolves.toBeNull();
  });

  it('a node from before certified proofs gives its sealed-macroblock watermark, never its tip', async () => {
    serveHeads({ [G[0]]: 300 }, { old: { [G[1]]: 299, [G[2]]: 300, [G[3]]: 120 } });
    await expect(lc.certifiedHeadHint(() => G)).resolves.toBe(300);
  });

  it('the device\'s own verified macroblock raises the head', async () => {
    serveChain();
    await lc.certifiedStateRootAt(40, () => [N1]);
    serveHeads({ [G[0]]: 30, [G[1]]: 30, [G[2]]: 30 });
    await expect(lc.certifiedHead(() => G)).resolves.toBe(40);
  });
});

describe('nodes answering with the older proof', () => {
  it('are marked for ten minutes, after which they are asked as any other', () => {
    const t0 = 1_000_000;
    lc.markNodeOld(N1, t0);
    expect(lc.nodeMarkedOld(N1, t0 + 1)).toBe(true);
    expect(lc.nodeMarkedOld(N2, t0 + 1)).toBe(false);
    expect(lc.OLD_NODE_MARK_MS).toBe(10 * 60_000);
    expect(lc.nodeMarkedOld(N1, t0 + lc.OLD_NODE_MARK_MS)).toBe(false);
  });
});

describe('the wallet reads certified proofs', () => {
  let WalletManager;
  let GENESIS_NODES;
  let wlc;
  let AsyncStorage;
  jest.isolateModules(() => {
    jest.doMock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(async () => true), isDilithiumAvailable: () => true }));
    ({ WalletManager } = require('../src/components/WalletManager'));
    ({ GENESIS_NODES } = require('../src/config/nodes'));
    wlc = require('../src/crypto/QcLightClient');
    AsyncStorage = require('@react-native-async-storage/async-storage');
  });
  const reply = (status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text), headers: { get: (h) => headers[h.toLowerCase()] ?? null } };
  };
  const genesisOf = (url) => GENESIS_NODES.find((g) => url.startsWith(`${g}/`));
  const ME = PLAIN;
  const fresh = () => {
    const wm = new WalletManager();
    wm._certifiedRootFresh = jest.fn(async (index) => (index === 7 ? { ok: true, stateRoot: state.root } : { ok: false, reason: 'unconfirmed' }));
    return wm;
  };

  beforeEach(async () => {
    await AsyncStorage.clear();
    wlc.clearQcCache();
    WalletManager.nodeHealth = {};
    WalletManager.sendProofs.clear();
    WalletManager.sendReads.clear();
    WalletManager.retryAfterUntil.clear();
    WalletManager.lastOwnSendAt.clear();
  });

  it('asks for the certified form and folds to the root verified for the named macroblock', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(url); return reply(200, accountAnswer(state, ME, plainFields, 7)); });
    const wm = fresh();
    const r = await wm.getQNCBalanceWithProof(ME);
    expect(r).toMatchObject({ ok: true, verified: true, balanceNano: '5000000000', nonce: '3', index: 7, stateRoot: state.root });
    expect(urls[0]).toMatch(/\/api\/v1\/account\/eon_golden_plain\/balance\/proof\?mb=latest$/);
    expect(wm._certifiedRootFresh).toHaveBeenCalledWith(7);
    // Kept for the next send check, with its index.
    expect(WalletManager.sendProofs.get(`qnc|${ME}`)).toMatchObject({ index: 7, stateRoot: state.root });
  });

  it('a proof that folds only to the root its node served is not verified, and the next node is asked', async () => {
    const hosts = [];
    const otherState = tree([[addrKey(ME), leafOf(ME, { ...plainFields, balance: '9000000000' })]]);
    global.fetch = jest.fn(async (url) => {
      hosts.push(genesisOf(url));
      return reply(200, accountAnswer(otherState, ME, { ...plainFields, balance: '9000000000' }, 7));
    });
    const wm = fresh();
    const r = await wm.getQNCBalanceWithProof(ME);
    expect(r).toMatchObject({ ok: true, verified: false, balanceNano: '9000000000', reason: 'unconfirmed' });
    expect(new Set(hosts).size).toBe(3); // every genesis name was tried for one that verifies
    expect(hosts.every(Boolean)).toBe(true);
  });

  it('an absence counts only with its proof; a 0 nothing verified is never given as a balance', async () => {
    global.fetch = jest.fn(async () => reply(200, accountAnswer(state, 'eon_golden_absent', null, 7)));
    const wm = fresh();
    await expect(wm.getQNCBalanceWithProof('eon_golden_absent')).resolves.toMatchObject({ ok: true, verified: true, balanceNano: '0', exists: false });
    // The same absence, not certified: no figure at all.
    wm._certifiedRootFresh = jest.fn(async () => ({ ok: false, reason: 'unconfirmed' }));
    WalletManager.sendProofs.clear();
    await expect(wm.getQNCBalanceWithProof('eon_golden_absent')).resolves.toMatchObject({ ok: false, balance: null, reason: 'unconfirmed' });
    // A node's word without a proof: no figure either.
    global.fetch = jest.fn(async () => reply(200, { balance: 0, nonce: 0 }));
    await expect(wm.getQNCBalanceWithProof('eon_golden_absent')).resolves.toMatchObject({ ok: false, balance: null });
  });

  it('a node from before certified proofs: its proof still counts when its root is certified, and it is asked last', async () => {
    const legacy = { address: ME, balance: 5000000000, nonce: 3, heartbeat_epoch: 12, heartbeat_slots: 0x01ff, heartbeat_final_epoch: 0,
      heartbeat_final_slots: 0, last_claimed_epoch: 10, banned_at_height: 0, is_node: false,
      merkle_proof: state.prove(addrKey(ME)).steps, state_root: state.root, block_height: 700, proof_valid: true };
    const first = [];
    global.fetch = jest.fn(async (url) => { first.push(genesisOf(url)); return reply(200, legacy); });
    const wm = new WalletManager();
    wm._certifiedFresh = jest.fn(async (root, height) => root === state.root && height === 700);
    const r = await wm.getQNCBalanceWithProof(ME);
    expect(r).toMatchObject({ ok: true, verified: true, balanceNano: '5000000000', index: null });
    expect(wlc.nodeMarkedOld(first[0])).toBe(true);
    // The next read asks the nodes not marked first.
    const order = wm._proofOrder(GENESIS_NODES);
    expect(order[order.length - 1]).toBe(first[0]);
  });

  it('a new node\'s rate limit (429, typed) is no old node and no answer: the next node is asked, the wait honoured', async () => {
    let n = 0;
    const hosts = [];
    global.fetch = jest.fn(async (url) => {
      hosts.push(genesisOf(url));
      n += 1;
      if (n === 1) return reply(429, { proof_format: 2, error: 'rate_limited', retry_after_seconds: 30 }, { 'retry-after': '30' });
      return reply(200, accountAnswer(state, ME, plainFields, 7));
    });
    const wm = fresh();
    await expect(wm.getQNCBalanceWithProof(ME)).resolves.toMatchObject({ ok: true, verified: true });
    expect(wlc.nodeMarkedOld(hosts[0])).toBe(false);
    expect(WalletManager.retryAfterUntil.get(hosts[0])).toBeGreaterThan(Date.now() + 20_000);
    const order = wm._proofOrder(GENESIS_NODES);
    expect(order[order.length - 1]).toBe(hosts[0]);
  });

  it('no node answers: "unanswered"; answers that do not verify: "unconfirmed"', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    const wm = fresh();
    await expect(wm.getQNCBalanceWithProof(ME)).resolves.toMatchObject({ ok: false, reason: 'unanswered' });
    global.fetch = jest.fn(async () => reply(200, accountAnswer(state, ME, plainFields, 8)));
    await expect(wm.getQNCBalanceWithProof(ME)).resolves.toMatchObject({ ok: true, verified: false, reason: 'unconfirmed' });
  });

  it('an answer above the size bound is no answer', async () => {
    global.fetch = jest.fn(async () => reply(200, { ...accountAnswer(state, ME, plainFields, 7), pad: 'x'.repeat(70 * 1024) }));
    const wm = fresh();
    await expect(wm.getQNCBalanceWithProof(ME)).resolves.toMatchObject({ ok: false, reason: 'unanswered' });
  });

  it('pins the newest verified macroblock while it is fresh, and asks for the newest after the wallet\'s own send', async () => {
    serveChain();
    await wlc.certifiedStateRootAt(20, () => [N1]);
    const wm = new WalletManager();
    wm._headHint = { idx: 21, at: Date.now() };
    expect(wm._proofIndex(ME)).toBe(20);
    expect(wm._proofPasses(ME, null)).toEqual(['20', 'latest']);
    wm._headHint = { idx: 23, at: Date.now() };
    expect(wm._proofIndex(ME)).toBeNull(); // out of the window: the newest the node holds
    wm._headHint = { idx: 20, at: Date.now() };
    WalletManager.lastOwnSendAt.set(ME, Date.now());
    expect(wm._proofIndex(ME)).toBeNull();
    expect(wm._proofPasses(ME, 9)).toEqual(['9']);
  });

  it('freshness by the certified head: too old or past the head is never walked to', async () => {
    const wm = new WalletManager();
    wm._headHint = { idx: 50, at: Date.now() };
    const spy = jest.spyOn(wlc, 'certifiedStateRootAt');
    await expect(wm._certifiedRootFresh(47)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' });
    await expect(wm._certifiedRootFresh(53)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const quiet = new WalletManager();
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    await expect(quiet._certifiedRootFresh(50)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' });
  });

  it('the head is read from the certified frontier the genesis nodes report, never from the applied tip', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(url);
      if (url.endsWith('/api/v1/state/certified')) return reply(200, { proof_format: 2, views: [], newest_certified_index: 77, finalized_height: 0, applied_height: 99999, capture: 'ok' });
      return reply(404, {});
    });
    const wm = new WalletManager();
    await expect(wm._networkHeadIndex()).resolves.toBe(77);
    expect(urls.some((u) => u.endsWith('/api/v1/height'))).toBe(false);
  });

  it('a token balance: the certified form, both levels, the named macroblock asked for when the send check pairs it', async () => {
    const level1 = state.prove(addrKey(CONTRACT));
    const level2 = storage.prove(smt.storageKeyHash('balance:' + PLAIN, sha3_256));
    const body = {
      proof_format: 2, contract_address: CONTRACT, holder: PLAIN, macroblock_index: 7, state_height: 630, state_root: state.root,
      contract_status: 'contract', account_proof_kind: 'inclusion', account_proof: level1.steps, account_balance: '0',
      account_nonce: '0', contract_code_hash: contractFields.contract_code_hash, storage_root: storage.root,
      heartbeat_epoch: '0', heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0',
      banned_at_height: '0', is_node: false, storage_proof_kind: 'inclusion', token_balance: '250', storage_proof: level2.steps,
    };
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(url); return reply(200, body); });
    const wm = fresh();
    await expect(wm.getTokenBalanceWithProof(CONTRACT, PLAIN, 1, true, { index: 7 })).resolves
      .toMatchObject({ ok: true, verified: true, balanceBase: '250', balance: '25', index: 7 });
    expect(urls[0]).toMatch(/\/api\/v1\/token\/eon_golden_contract\/eon_golden_plain\/balance\/proof\?mb=7$/);
  });
});

// The golden hex of the node's golden_vectors_for_clients inputs, as computed by the client's verifier and the
// reference tree above (core/qnet-state/src/tree_proof.rs pins the same names).
const GOLDEN = {
  plain_leaf: '47f4cd00ad826f7c9691e514a4fed334c47500ac6ef6348f940e870aab861143',
  contract_leaf: '91853f19011f659eb002d4607613af2de14f0eff5a76cdec958e1d767096ebfd',
  storage_leaf: 'c6865e0b2be779fead42ae16e784ef8e8aa35faf3f73a8d759ae43adbb97c126',
  root: '466262ba15c449ca1c068c5ecf5a003ca64dba74a9e079787ac869531fba149b',
  inclusion_steps: 'b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947',
  absence_steps: 'f0870bc01ff5aa768bd7cfda24cbae6bd995a47e55c8656ff23db36b1133a8f1',
  absence_in_bucket_steps: 'b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947',
};

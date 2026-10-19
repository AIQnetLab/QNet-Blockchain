/**
 * The app's wiring of the light client's newer parts (wallet-galc plan 2.4, Part 3 and the P1 rows):
 * - the genesis capsule kept in plain storage, tagged with the network and the chain, verified again when read, left by
 *   a lineage reset of the anchors, dropped with the walk's onCapsuleDropped and when the chain goes back;
 * - the foreground follow tick: the head, one walk step (both parities after an own send, and catching up on a parity
 *   behind), the QNC proof, the capsule; the first proof read after a relaunch asks for the newest kept macroblock;
 * - a long walk refuses no send: the send check reads the genesis nodes' live tip, never a certified proof;
 * - the recipient kind from two genesis nodes at once, the certified account leaf confirming it in the background;
 * - the move of a node balance checked as the extension checks it: no batch that skips an epoch is ever signed;
 * - the rows of this wallet's history two genesis nodes list alike.
 * The light client's capsule and walk functions are stubbed: their own tests are GalcCapsule, LineageWalk, LineageReset.
 */
const { sha3_256 } = require('js-sha3');

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  verifyDilithium: jest.fn(async () => true),
  signWithDilithium: jest.fn(async () => 'sig'),
  signDetached: jest.fn(async () => 'ab'.repeat(8)),
}));
jest.mock('../src/crypto/QcLightClient', () => ({
  ...jest.requireActual('../src/crypto/QcLightClient'),
  importCapsule: jest.fn(async () => ({ ok: true, index: mockAt(106) })),
  exportCapsule: jest.fn(() => null),
  refreshCapsule: jest.fn(async () => ({ ok: false, reason: 'no_capsule' })),
  followStep: jest.fn(async () => ({ ok: true, head: mockAt(156), verified: true, stepsLeft: 0, targets: [], capsule: null })),
  clearCapsule: jest.fn(),
  heldCapsuleIndex: jest.fn(() => 0),
  stepsToVerify: jest.fn(() => 0),
  certifiedHeadHint: jest.fn(async () => mockAt(156)),
  certifiedStateRootAt: jest.fn(async (index) => ({ ok: true, index, stateRoot: (mockRoots[index] || '00'.repeat(32)) })),
}));
const mockRoots = {};
// Macroblocks above the build's pin, which every release moves: at(n) is the pin + n, the head at(156).
const mockPin = require('../src/config/genesisConsensus').WS_CHECKPOINT.index;
const mockAt = (n) => mockPin + n;
const at = mockAt;

const AsyncStorage = require('@react-native-async-storage/async-storage');
const lc = require('../src/crypto/QcLightClient');
const smt = require('../src/crypto/SmtFold');
const { signWithDilithium } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const { NETWORK_ID } = require('../src/config/genesisConsensus');
const { QNET_CHAIN_TAG, eonFromPublicKeyBytes } = require('../src/crypto/WalletIdentity');
const { listingKey } = require('../src/utils/txHistory');

jest.setTimeout(60000);

const W = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
const TO = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
const KEY = WalletManager.CAPSULE_KEY;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const record = (k) => ({ capsule: { version: 2, network_id: NETWORK_ID, mb_index: k }, roots: { [k]: {}, [k - 1]: {} } });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  lc.stepsToVerify.mockImplementation(() => 0);
  lc.heldCapsuleIndex.mockImplementation(() => 0);
  lc.certifiedHeadHint.mockImplementation(async () => at(156));
  lc.exportCapsule.mockImplementation(() => null);
  lc.importCapsule.mockImplementation(async () => ({ ok: true, index: at(106) }));
  WalletManager.liveFigures.clear();
  WalletManager.liveReads.clear();
  WalletManager.recipientKinds.clear();
  WalletManager.recipientReads.clear();
  WalletManager.lastOwnSendAt.clear();
  global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
});

describe('the genesis capsule on the device', () => {
  it('is kept in plain storage tagged with the network and the chain, once per capsule', async () => {
    const wm = new WalletManager();
    lc.exportCapsule.mockImplementation(() => record(at(106)));
    await wm._saveCapsule();
    expect(JSON.parse(await AsyncStorage.getItem(KEY))).toEqual({ network: NETWORK_ID, chain: lc.chainIdentity(), capsule: record(at(106)) });
    const set = AsyncStorage.setItem; // the storage mock's own jest.fn
    set.mockClear();
    await wm._saveCapsule();
    expect(set).not.toHaveBeenCalled(); // the same K: no second write
    lc.exportCapsule.mockImplementation(() => record(at(116)));
    await wm._saveCapsule();
    expect(set).toHaveBeenCalledTimes(1);
    // Nothing held: nothing written.
    lc.exportCapsule.mockImplementation(() => null);
    await new WalletManager()._saveCapsule();
    expect(JSON.parse(await AsyncStorage.getItem(KEY)).capsule.capsule.mb_index).toBe(at(116));
  });

  it('is verified again when read: one that no longer verifies, or of another chain, goes; a stale one stays', async () => {
    const wm = new WalletManager();
    const kept = { network: NETWORK_ID, chain: lc.chainIdentity(), capsule: record(at(106)) };
    await AsyncStorage.setItem(KEY, JSON.stringify(kept));
    await wm._loadCapsule();
    expect(lc.importCapsule).toHaveBeenCalledWith(record(at(106)));
    expect(await AsyncStorage.getItem(KEY)).not.toBeNull();
    lc.importCapsule.mockImplementation(async () => ({ ok: false, reason: 'stale' }));
    await wm._loadCapsule();
    expect(await AsyncStorage.getItem(KEY)).not.toBeNull();
    lc.importCapsule.mockImplementation(async () => ({ ok: false, reason: 'signatures' }));
    await wm._loadCapsule();
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    for (const bad of [{ ...kept, chain: 'f'.repeat(32) }, { ...kept, network: 'ab'.repeat(32) }, 'not json']) {
      lc.importCapsule.mockClear();
      await AsyncStorage.setItem(KEY, typeof bad === 'string' ? bad : JSON.stringify(bad));
      await wm._loadCapsule();
      await flush();
      expect([bad, await AsyncStorage.getItem(KEY), lc.importCapsule.mock.calls.length]).toEqual([bad, null, 0]);
    }
  });

  it('is read at unlock after the anchors, which it is checked against', async () => {
    const wm = new WalletManager();
    const order = [];
    wm._loadVerifiedAnchors = jest.fn(async () => { order.push('anchors'); });
    wm._loadCapsule = jest.fn(async () => { order.push('capsule'); });
    wm._openSession(null, 'v');
    await wm._anchorsReady;
    expect(order).toEqual(['anchors', 'capsule']);
    // A capsule that cannot be read never stops the session or the walk.
    const other = new WalletManager();
    other._loadVerifiedAnchors = jest.fn(async () => { throw new Error('x'); });
    other._loadCapsule = jest.fn(async () => { throw new Error('y'); });
    other._openSession(null, 'v');
    await expect(other._anchorsReady).resolves.toBeUndefined();
  });

  it('stays through a lineage reset of the anchors; goes with onCapsuleDropped and when the chain goes back', async () => {
    const wm = new WalletManager();
    await AsyncStorage.setItem(KEY, JSON.stringify({ network: NETWORK_ID, chain: lc.chainIdentity(), capsule: record(at(106)) }));
    wm._lineageHooks().onLineageReset();
    await flush();
    expect(await AsyncStorage.getItem(KEY)).not.toBeNull();
    wm._lineageHooks().onCapsuleDropped();
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    // The rewind rule: a certified head CHAIN_REWIND_MACROBLOCKS or more below the held capsule.
    lc.heldCapsuleIndex.mockImplementation(() => at(106));
    expect(wm._forgetCapsuleAbove(at(97))).toBe(false);
    expect(lc.clearCapsule).not.toHaveBeenCalled();
    await AsyncStorage.setItem(KEY, '{}');
    expect(wm._forgetCapsuleAbove(at(96))).toBe(true);
    await flush();
    expect(lc.clearCapsule).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it('is asked for before a long walk only, from the genesis names, its roots confirmed from the lineage nodes', async () => {
    const wm = new WalletManager();
    lc.stepsToVerify.mockImplementation(() => 16);
    await wm._capsuleFirst(at(155), at(156));
    expect(lc.refreshCapsule).not.toHaveBeenCalled();
    lc.stepsToVerify.mockImplementation(() => 17);
    lc.refreshCapsule.mockImplementation(async () => ({ ok: true, index: at(146) }));
    lc.exportCapsule.mockImplementation(() => record(at(146)));
    await wm._capsuleFirst(at(155), at(156));
    const [provider, opts] = lc.refreshCapsule.mock.calls[0];
    expect(provider().sort()).toEqual(require('../src/config/nodes').GENESIS_NODES.slice().sort());
    expect(opts.headHint).toBe(at(156));
    expect(typeof opts.proofNodes).toBe('function');
    expect(JSON.parse(await AsyncStorage.getItem(KEY)).capsule.capsule.mb_index).toBe(at(146));
    // Today's nodes have no capsule (405): the walk goes on as before; no head read: nothing asked.
    lc.refreshCapsule.mockClear();
    await wm._capsuleFirst(at(155), null);
    expect(lc.refreshCapsule).not.toHaveBeenCalled();
  });
});

describe('the foreground follow', () => {
  const opened = () => {
    const wm = new WalletManager();
    wm._session = { token: 't', dekKey: null, vaultId: 'v' };
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, balance: 1, blockHeight: at(155) * 90, index: at(155) }));
    return wm;
  };

  it('needs an open session', async () => {
    expect(await new WalletManager().followTick(W)).toBe(null);
    expect(lc.followStep).not.toHaveBeenCalled();
  });

  it('reads the head, walks one step toward it, reads the QNC proof, keeps the anchors; one tick at a time', async () => {
    const wm = opened();
    wm._saveVerifiedAnchors = jest.fn(async () => {});
    const [a, b] = await Promise.all([wm.followTick(W), wm.followTick(W)]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ ok: true, head: at(156), verified: true, walkSteps: null });
    expect(lc.followStep).toHaveBeenCalledTimes(1);
    const [nodes, opts] = lc.followStep.mock.calls[0];
    expect(typeof nodes).toBe('function');
    expect(opts).toMatchObject({ maxSteps: 1, both: false });
    expect(typeof opts.headNodes).toBe('function');
    expect(typeof opts.hooks.onCapsuleDropped).toBe('function');
    expect(wm.getQNCBalanceWithProof).toHaveBeenCalledWith(W, true);
    expect(wm._saveVerifiedAnchors).toHaveBeenCalled();
  });

  it('follows both parities for ten minutes after the wallet\'s own send, and keeps a capsule it rooted', async () => {
    const wm = opened();
    WalletManager.lastOwnSendAt.set(W, Date.now() - 9 * 60_000);
    lc.followStep.mockImplementationOnce(async () => ({ ok: true, head: at(156), verified: true, stepsLeft: 0, targets: [], capsule: { ok: true, index: at(156) } }));
    lc.exportCapsule.mockImplementation(() => record(at(156)));
    await wm.followTick(W);
    expect(lc.followStep.mock.calls[0][1].both).toBe(true);
    expect(JSON.parse(await AsyncStorage.getItem(KEY)).capsule.capsule.mb_index).toBe(at(156));
    WalletManager.lastOwnSendAt.set(W, Date.now() - 11 * 60_000);
    await wm.followTick(W);
    expect(lc.followStep.mock.calls[1][1].both).toBe(false);
  });

  it('catches up on a parity more than a step behind: both parities, FOLLOW_CATCH_UP_STEPS a call', async () => {
    const wm = opened();
    wm._saveVerifiedAnchors = jest.fn(async () => {});
    // The head's parity is current, the other one 40 steps back (the first read walked the other way).
    lc.stepsToVerify.mockImplementation((i) => (i === at(155) ? 40 : 1));
    await wm.followTick(W);
    expect(lc.followStep.mock.calls[0][1]).toMatchObject({ both: true, maxSteps: WalletManager.FOLLOW_CATCH_UP_STEPS });
    expect(WalletManager.FOLLOW_CATCH_UP_STEPS).toBe(16);
    lc.stepsToVerify.mockImplementation(() => 1);
    await wm.followTick(W);
    expect(lc.followStep.mock.calls[1][1]).toMatchObject({ both: false, maxSteps: 1 });
  });

  it('with no certified head says so; a head far below the held capsule drops it (another chain)', async () => {
    lc.certifiedHeadHint.mockImplementation(async () => null);
    expect(await opened().followTick(W)).toMatchObject({ ok: false });
    expect(lc.followStep).not.toHaveBeenCalled();
    lc.certifiedHeadHint.mockImplementation(async () => at(156));
    lc.heldCapsuleIndex.mockImplementation(() => at(256));
    await opened().followTick(W);
    expect(lc.clearCapsule).toHaveBeenCalledTimes(1);
  });

  it('reports the steps a long walk still takes', async () => {
    const wm = opened();
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: false, reason: 'unconfirmed' }));
    lc.stepsToVerify.mockImplementation(() => 480);
    expect(await wm.followTick(W)).toMatchObject({ ok: true, verified: false, walkSteps: 480 });
    lc.stepsToVerify.mockImplementation((i) => (i === at(155) ? 0 : 3)); // a checkpoint within the freshness window is held
    expect(wm.walkSteps()).toBe(null);
    lc.stepsToVerify.mockImplementation(() => WalletManager.LONG_WALK_STEPS);
    expect(wm.walkSteps()).toBe(null);
  });
});

describe('the first proof read after a relaunch', () => {
  const anchor = { eligible_ids: ['genesis_node_001'], beacon: 'bb'.repeat(32), registry_root: 'cc'.repeat(32),
    state_root: 'dd'.repeat(32), logs_root: '00'.repeat(32), checkpoint_hash: 'ee'.repeat(32) };
  afterEach(() => lc.clearQcCache());

  it('asks for the newest kept macroblock while its checkpoint is recent, before any head read; else the latest', () => {
    lc.importVerifiedAnchors({ [at(155)]: anchor });
    const wm = new WalletManager();
    wm._keptTop = { index: at(155), at: Date.now() - 60_000 };
    expect(wm._proofPasses(W, null)).toEqual([String(at(155)), 'latest']);
    wm._keptTop = { index: at(155), at: Date.now() - WalletManager.RECENT_VERIFIED_MS - 1000 };
    expect(wm._proofPasses(W, null)).toEqual(['latest']);
    // A head read in the last minute decides as before; right after the wallet's own send, the latest.
    wm._headHint = { idx: at(156), at: Date.now() };
    expect(wm._proofPasses(W, null)).toEqual([String(at(155)), 'latest']);
    WalletManager.lastOwnSendAt.set(W, Date.now());
    expect(wm._proofPasses(W, null)).toEqual(['latest']);
  });

  it('a kept macroblock a few minutes older waits for the certified head, which decides; an older one does not', () => {
    lc.importVerifiedAnchors({ [at(155)]: anchor });
    const wm = new WalletManager();
    const aged = (min) => { wm._keptTop = { index: at(155), at: Date.now() - min * 60_000 }; return wm._headDecidesIndex(W); };
    expect([aged(1), aged(5), aged(7)]).toEqual([false, true, false]);
    wm._keptTop = { index: at(155), at: Date.now() - 5 * 60_000 };
    wm._headHint = { idx: at(157), at: Date.now() };
    expect(wm._headDecidesIndex(W)).toBe(false);
    expect(wm._proofPasses(W, null)).toEqual([String(at(155)), 'latest']);
  });

  it('a pinned macroblock whose view no node keeps any more (410) goes on to the latest', async () => {
    const wm = new WalletManager();
    wm._hedged = jest.fn(async (path, opts) => (path.endsWith(`?mb=${at(155)}`)
      ? { ok: false, status: 410, data: '{"error":"view_not_retained"}', base: opts.nodes[0] }
      : { ok: true, status: 200, data: '{}', base: opts.nodes[0] }));
    const got = await wm._proofAnswers('/p', ['https://a', 'https://b'], [String(at(155)), 'latest'], async () => ({ verified: 'v' }));
    expect(got).toEqual({ verified: 'v' });
    expect(wm._hedged.mock.calls.map((c) => c[0])).toEqual([`/p?mb=${at(155)}`, '/p?mb=latest']);
    // No node reached at all: the next pass is not tried.
    wm._hedged = jest.fn(async () => { throw new Error('down'); });
    expect(await wm._proofAnswers('/p', ['https://a'], [String(at(155)), 'latest'], async () => ({ verified: 'v' })))
      .toMatchObject({ answered: false });
    expect(wm._hedged).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest verified macroblock and its checkpoint time with the anchors', () => {
    const wm = new WalletManager();
    lc.importVerifiedAnchors({ [at(155)]: anchor });
    wm._keptTop = { index: at(155), at: 1790000000000 };
    expect(wm._verifiedTime(at(155))).toBe(1790000000000);
    expect(wm._verifiedTime(at(154))).toBe(null);
    wm._dropStoredAnchors();
    expect(wm._keptTop).toBe(null);
  });
});

describe('the send check', () => {
  // Before, a send leaned on a certified QNC proof the follow kept by its macroblock, and while a long walk ran it was
  // refused as not confirmed, saying how many steps were left; now the walk decides nothing for a send (owner, 18.10).
  it('a long lineage walk refuses nothing: the live figure decides, and no certified read or head is asked', async () => {
    lc.stepsToVerify.mockImplementation(() => 57);
    const wm = new WalletManager();
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: false, reason: 'unconfirmed', balance: 1 }));
    wm.liveQncFigure = jest.fn(async () => ({ balance: 7, balanceNano: '7000000000', nonce: '5', blockHeight: 9000, figureClaimedEpoch: 0 }));
    await expect(wm.qncForSend(W, { nonce: 5 })).resolves.toMatchObject({ ok: true, balanceNano: '7000000000', accountNonce: 5 });
    expect(wm.getQNCBalanceWithProof).not.toHaveBeenCalled();
    expect(lc.certifiedHeadHint).not.toHaveBeenCalled();
    expect(wm.walkSteps()).toBe(null); // no head was read for it
  });
});

// A reference sparse-Merkle tree as the node builds it (CertifiedProofs.test.js holds the same builder).
const hexb = (h) => Buffer.from(h, 'hex');
const H2 = (a, b) => sha3_256(Buffer.concat([hexb(a), hexb(b)]));
const DEFAULTS = ['00'.repeat(32)];
for (let d = 1; d <= 256; d++) DEFAULTS.push(H2(DEFAULTS[d - 1], DEFAULTS[d - 1]));
const bitOf = (key, i) => (parseInt(key.substr((i >> 3) * 2, 2), 16) >> (7 - (i % 8))) & 1;
const tagged = (k, v) => sha3_256(Buffer.concat([Buffer.from([0xb5]), hexb(k), hexb(v)]));
const foldLevel = (level) => {
  let cur = level;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? H2(cur[i], cur[i + 1]) : cur[i]);
    cur = next;
  }
  return cur[0];
};
const sortedEntries = (entries) => [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
function nodeHash(entries, depth) {
  if (depth === 216) return entries.length ? foldLevel(sortedEntries(entries).map(([k, v]) => tagged(k, v))) : DEFAULTS[216];
  if (entries.length === 0) return DEFAULTS[depth];
  const split = 256 - depth;
  return H2(nodeHash(entries.filter(([k]) => bitOf(k, split) === 0), depth - 1),
    nodeHash(entries.filter(([k]) => bitOf(k, split) === 1), depth - 1));
}
function tree(entries) {
  const all = sortedEntries(entries);
  const prove = (key) => {
    const bucket = all.filter(([k]) => k.slice(0, 10) === key.slice(0, 10));
    const steps = [];
    const pos = bucket.findIndex(([k]) => k === key);
    if (pos >= 0) {
      let level = bucket.map(([k, v]) => tagged(k, v));
      let idx = pos;
      while (level.length > 1) {
        if ((idx ^ 1) < level.length) steps.push({ sibling: level[idx ^ 1], is_right: (idx & 1) === 1 });
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? H2(level[i], level[i + 1]) : level[i]);
        level = next;
        idx = Math.floor(idx / 2);
      }
    }
    for (let depth = 216; depth < 256; depth++) {
      const own = 255 - depth;
      const sib = all.filter(([k]) => {
        for (let i = 0; i < own; i++) if (bitOf(k, i) !== bitOf(key, i)) return false;
        return bitOf(k, own) !== bitOf(key, own);
      });
      steps.push({ sibling: nodeHash(sib, depth), is_right: bitOf(key, own) === 1 });
    }
    return { kind: pos >= 0 ? 'inclusion' : bucket.length ? 'absence_in_bucket' : 'absence', steps,
      entries: pos < 0 && bucket.length ? bucket.map(([k, v]) => ({ key: k, leaf: v })) : undefined };
  };
  return { root: nodeHash(all, 256), prove };
}
const fieldsOf = (o = {}) => ({
  balance: '0', nonce: '0', is_contract: false, contract_code_hash: null, storage_root: null, heartbeat_epoch: '0',
  heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0, last_claimed_epoch: '0', banned_at_height: '0',
  is_node: false, ...o,
});
const addrKey = (a) => smt.addressKeyHash(a, sha3_256);

describe('the recipient kind', () => {
  const CONTRACT = eonFromPublicKeyBytes(Uint8Array.of(1, 2, 3));
  const ABSENT = eonFromPublicKeyBytes(Uint8Array.of(4, 5, 6));
  const contractFields = fieldsOf({ is_contract: true, contract_code_hash: 'c0de'.repeat(16), storage_root: 'ee'.repeat(32) });
  const accountFields = fieldsOf({ balance: '5000000000', nonce: '3' });
  const state = tree([
    [addrKey(TO), smt.accountLeafHash(TO, accountFields, sha3_256)],
    [addrKey(CONTRACT), smt.accountLeafHash(CONTRACT, contractFields, sha3_256)],
  ]);
  const answer = (address) => {
    const f = address === TO ? accountFields : address === CONTRACT ? contractFields : fieldsOf();
    const p = state.prove(addrKey(address));
    return JSON.stringify({
      proof_format: 2, address, macroblock_index: at(155), state_height: String(at(155) * 90), state_root: state.root,
      exists: p.kind === 'inclusion', proof_kind: p.kind, ...(p.kind === 'inclusion' ? f : fieldsOf()), merkle_proof: p.steps,
      ...(p.entries ? { bucket_entries: p.entries } : {}),
    });
  };
  const manager = () => {
    mockRoots[at(155)] = state.root;
    const wm = new WalletManager();
    wm._hedged = jest.fn(async (path, opts) => {
      const address = /\/api\/v1\/account\/([^/]+)\/balance\/proof/.exec(path)[1];
      return { ok: true, status: 200, data: answer(address), base: opts.nodes[0] };
    });
    wm.agreedContractKind = jest.fn(async (address) => (address === CONTRACT ? 'contract' : 'none'));
    return wm;
  };

  // Before (owner, 18.10), a send waited up to 20 s for the certified leaf and was refused without one: a send to a
  // fresh recipient right after launch waited and failed. These two tests fail on that rule.
  it('two genesis nodes decide at once; the certified leaf runs beside, and a contract it proved is refused at once', async () => {
    const wm = manager();
    expect(await wm.payableRecipientProblem(CONTRACT, W)).toBe('contract');
    expect(await wm.payableRecipientProblem(TO, W)).toBe(null);
    expect(await wm.payableRecipientProblem(ABSENT, W)).toBe(null);
    expect(wm.agreedContractKind.mock.calls.map((c) => c[0])).toEqual([CONTRACT, TO, ABSENT]);
    expect(wm._hedged).toHaveBeenCalled(); // the certified reads, in the background
    await flush(10);
    expect(WalletManager.recipientKinds.get(CONTRACT)).toMatchObject({ kind: 'contract' });
    // What the certified leaf proved a contract is refused at once, whatever the nodes say now.
    wm.agreedContractKind = jest.fn(async () => 'none');
    expect(await wm.payableRecipientProblem(CONTRACT, W)).toBe('contract');
    expect(wm.agreedContractKind).not.toHaveBeenCalled();
  });

  it('a certified read that never ends delays nothing, and two checks share it; no agreement refuses as unchecked', async () => {
    const wm = manager();
    wm._hedged = jest.fn(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await wm.payableRecipientProblem(TO, W)).toBe(null);
    expect(await wm.payableRecipientProblem(TO, W)).toBe(null); // the second check, just before signing
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(WalletManager.recipientReads.size).toBe(1);
    wm.agreedContractKind = jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'TOKEN_UNAVAILABLE' }); });
    expect(await wm.payableRecipientProblem(TO, W)).toBe('unchecked');
    // The wallet's own address is never read.
    wm.agreedContractKind.mockClear();
    expect(await wm.payableRecipientProblem(W, W)).toBe(null);
    expect(wm.agreedContractKind).not.toHaveBeenCalled();
  });

  it('the certified leaf: a contract, an account or no account; kept while recent; a proof that does not fold says nothing', async () => {
    const wm = manager();
    expect(await wm.certifiedRecipientKind(CONTRACT)).toBe('contract');
    expect(await wm.certifiedRecipientKind(TO)).toBe('none');
    expect(await wm.certifiedRecipientKind(ABSENT)).toBe('none');
    // A contract stays one: asked again, nothing is read; an account's answer is used again while its macroblock is recent.
    const reads = wm._hedged.mock.calls.length;
    expect(await wm.certifiedRecipientKind(CONTRACT)).toBe('contract');
    expect(await wm.certifiedRecipientKind(TO)).toBe('none');
    expect(wm._hedged.mock.calls.length).toBe(reads);
    // Once the head moved on, the kept answer is not used: read again, and a proof of a macroblock no longer recent
    // says nothing.
    lc.certifiedHeadHint.mockImplementation(async () => at(166));
    const later = manager();
    expect(await later.certifiedRecipientKind(TO)).toBe(null);
    expect(later._hedged).toHaveBeenCalled();
    lc.certifiedHeadHint.mockImplementation(async () => at(156));
    WalletManager.recipientKinds.clear();
    const forged = manager();
    mockRoots[at(155)] = 'ff'.repeat(32);
    expect(await forged.certifiedRecipientKind(TO)).toBe(null);
  });
});

describe('the move of a node balance', () => {
  const NODES = ['https://a', 'https://b', 'https://c', 'https://d', 'https://e'];
  const NODE = 'light_mobile_83afab763b9058fd';
  const TS = 1790000000;
  const quote = (claims, over = {}) => {
    const claimsData = JSON.stringify({ claims: claims.map(([epoch, amount]) => ({ epoch, amount })) });
    const total = claims.reduce((s, [, a]) => s + BigInt(a), 0n).toString();
    return {
      success: false, needs_signature: true, claims_data: claimsData, last_claimed_epoch: 4, amount_nano: total,
      claim_timestamp: TS, epochs_claimed: claims.length, stopped_at_epoch: null,
      sign_message: `${QNET_CHAIN_TAG}qnet_claim_v1:${W}:${TS}:${sha3_256(claimsData)}`, ...over,
    };
  };
  // `quotes`: base -> step-1 answer; `pending`: base -> its node balance answer (or absent: no answer).
  const manager = (quotes, pending) => {
    const wm = new WalletManager();
    wm.loadWallet = async () => ({ qnetAddress: W });
    wm._walletDilithiumKeys = async () => ({ secretKey: 'sk', publicKey: 'pk' });
    wm.getTrustedNodes = () => NODES.slice();
    wm._hedged = jest.fn(async (path, opts) => {
      const base = opts.nodes[0];
      if (path === '/api/v1/rewards/claim') return { ok: true, status: 200, data: quotes[base] || quotes.any, base };
      if (pending[base]) return { ok: true, status: 200, data: JSON.stringify({ node_id: NODE, ...pending[base] }), base };
      throw new Error('down');
    });
    wm._submitClaim = jest.fn(async () => ({ ok: true, data: { success: true, tx_hash: 'cd'.repeat(32), amount_qnc: 3 } }));
    return wm;
  };
  const signedClaims = () => signWithDilithium.mock.calls.filter((c) => String(c[0]).includes('qnet_claim_v1'));
  const agreeing = (head, total) => Object.fromEntries(NODES.map((b) => [b, { first_unclaimed_epoch: head, pending_rewards_nano: total }]));

  it('a whole batch that other nodes\' head and node balance agree with is signed and submitted', async () => {
    const q = quote([[5, '1000000000'], [6, '1500000000'], [9, '500000000']]);
    const wm = manager({ any: q }, agreeing(5, 3000000000));
    const r = await wm.claimRewards('light', W, 'pw', 3_000_000_000, NODE);
    expect(r).toMatchObject({ success: true, amountNano: '3000000000', prevWatermark: 4, lastEpoch: 9, parts: [[5, '1000000000'], [6, '1500000000'], [9, '500000000']] });
    expect(signedClaims().map((c) => c[0])).toEqual([q.sign_message]);
    expect(wm._submitClaim).toHaveBeenCalledWith(expect.objectContaining({ claims_data: q.claims_data, claim_timestamp: TS }));
    // Signed by this wallet as a send is (owner, 18.10: before, a claim left the proof reads pinned to an older certified
    // macroblock): the next proof reads ask for the newest certified state.
    expect(WalletManager.lastOwnSendAt.get(W)).toBeGreaterThan(Date.now() - 5000);
  });

  it('a whole batch is held to a second node\'s quote too: one that left out a middle epoch is never signed', async () => {
    // The other nodes lack a shard past epoch 6, so the node balance they report stops there and under-reports: the total
    // check alone would pass a whole batch without epoch 6.
    const skipping = quote([[5, '1000000000'], [7, '1000000000'], [8, '1000000000']]);
    const honest = quote([[5, '1000000000'], [6, '1000000000'], [7, '1000000000'], [8, '1000000000']]);
    const wm = manager({ 'https://a': skipping, any: honest }, agreeing(5, 2000000000));
    await expect(wm.claimRewards('light', W, 'pw', 2_000_000_000, NODE)).rejects.toThrow(/different batches/);
    expect(signedClaims()).toEqual([]);
    expect(wm._submitClaim).not.toHaveBeenCalled();
    // No second node quoting: nothing is signed either.
    const alone = manager({ 'https://a': honest }, agreeing(5, 4000000000));
    await expect(alone.claimRewards('light', W, 'pw', 4_000_000_000, NODE)).rejects.toThrow();
    expect(signedClaims()).toEqual([]);
  });

  it('a whole batch below the node balance two other nodes report alike skipped an epoch: never signed', async () => {
    const q = quote([[5, '1000000000'], [9, '500000000']]); // epoch 6 left out
    const wm = manager({ any: q }, agreeing(5, 3000000000));
    await expect(wm.claimRewards('light', W, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/less than the node balance/);
    expect(signedClaims()).toEqual([]);
    expect(wm._submitClaim).not.toHaveBeenCalled();
  });

  it('a head another node reports differently, or no two totals alike, is never signed', async () => {
    const q = quote([[6, '1500000000'], [9, '1500000000']]);
    const heads = agreeing(5, 3000000000);
    await expect(manager({ any: q }, heads).claimRewards('light', W, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/starting at epoch 6, expected 5/);
    const q5 = quote([[5, '1500000000'], [9, '1500000000']]);
    const lone = { 'https://b': { first_unclaimed_epoch: 5, pending_rewards_nano: 3000000000 }, 'https://c': { first_unclaimed_epoch: 5, pending_rewards_nano: 2000000000 } };
    await expect(manager({ any: q5 }, lone).claimRewards('light', W, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/claim total/);
    await expect(manager({ any: q5 }, {}).claimRewards('light', W, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/claim head/);
    expect(signedClaims()).toEqual([]);
    // An answer for another node counts for nothing.
    const wm = manager({ any: q5 }, agreeing(5, 3000000000));
    wm._hedged.mockImplementation(async (path, opts) => (path === '/api/v1/rewards/claim'
      ? { ok: true, data: q5, base: opts.nodes[0] }
      : { ok: true, data: JSON.stringify({ node_id: 'light_mobile_other', first_unclaimed_epoch: 5, pending_rewards_nano: 3000000000 }) }));
    await expect(wm.claimRewards('light', W, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/claim head/);
  });

  it('a part of the balance is held to a second node\'s quote: the shorter is signed only when the other covers it', async () => {
    const heads = agreeing(5, 9000000000);
    const first = quote([[5, '1000000000'], [6, '1000000000'], [7, '1000000000']], { stopped_at_epoch: 8, stopped_reason: 'batch_full' });
    // The second node lists 5 and 7 but not 6, and stops later: the batches differ below the shorter one's end.
    const skipping = quote([[5, '1000000000'], [7, '1000000000'], [8, '1000000000']], { stopped_at_epoch: 9, stopped_reason: 'batch_full' });
    await expect(manager({ 'https://a': first, 'https://b': skipping }, heads).claimRewards('light', W, 'pw', 9_000_000_000, NODE))
      .rejects.toThrow(/different batches/);
    expect(signedClaims()).toEqual([]);
    // Another watermark: refused.
    const elsewhere = quote([[5, '1000000000']], { stopped_at_epoch: 6, last_claimed_epoch: 3, stopped_reason: 'batch_full' });
    await expect(manager({ 'https://a': first, 'https://b': elsewhere }, heads).claimRewards('light', W, 'pw', 9_000_000_000, NODE))
      .rejects.toThrow(/different watermarks/);
    // The second stops earlier and the first lists exactly its entries up to there: the second's batch is signed.
    const shorter = quote([[5, '1000000000'], [6, '1000000000']], { stopped_at_epoch: 7, stopped_reason: 'root_not_here' });
    const wm = manager({ 'https://a': first, 'https://b': shorter }, heads);
    const r = await wm.claimRewards('light', W, 'pw', 9_000_000_000, NODE);
    expect(r).toMatchObject({ success: true, amountNano: '2000000000', lastEpoch: 6, stoppedAtEpoch: 7, parts: [[5, '1000000000'], [6, '1000000000']] });
    expect(signedClaims().map((c) => c[0])).toEqual([shorter.sign_message]);
    expect(wm._submitClaim).toHaveBeenCalledWith(expect.objectContaining({ claims_data: shorter.claims_data }));
  });

  it('a node that cannot serve an epoch hands over to the next; a stop inside the batch is refused', async () => {
    const q = quote([[5, '3000000000']]);
    const cannot = { success: false, epochs_claimed: 0, stopped_at_epoch: 5, stopped_reason: 'root_not_here', error: 'This node cannot serve epoch 5' };
    const wm = manager({ 'https://a': cannot, 'https://b': q, 'https://c': q }, agreeing(5, 3000000000));
    expect(await wm.claimRewards('light', W, 'pw', 3_000_000_000, NODE)).toMatchObject({ success: true });
    // The quote from b, then the second quote it is held to: a hands over again, c quotes.
    expect(wm._hedged.mock.calls.filter((c) => c[0] === '/api/v1/rewards/claim').map((c) => c[1].nodes[0]))
      .toEqual(['https://a', 'https://b', 'https://a', 'https://c']);
    const inside = quote([[5, '1000000000'], [6, '1000000000']], { stopped_at_epoch: 6 });
    await expect(manager({ any: inside }, agreeing(5, 2000000000)).claimRewards('light', W, 'pw', 2_000_000_000, NODE))
      .rejects.toThrow(/stop inside its own batch/);
  });
});

describe('what genesis nodes list of this wallet\'s history', () => {
  it('a row counts once two genesis nodes list it alike: hash, both parties and the amount; a call by its hash', async () => {
    const wm = new WalletManager();
    wm.getTrustedNodes = () => ['https://a', 'https://b', 'https://c'];
    const transfer = { hash: 'H1', from: 'f'.repeat(45), to: W, amount: 2500000000, type: 'transfer' };
    const call = { hash: 'H2', from: W, to: 'c'.repeat(64), amount: 0, type: 'contract_call' };
    const lone = { hash: 'H3', from: 'f'.repeat(45), to: W, amount: 7, type: 'transfer' };
    const rows = {
      'https://a': [transfer, call, lone],
      'https://b': [{ ...transfer }, { ...call, to: 'other' }],
      'https://c': [{ ...transfer, amount: 2500000001 }],
    };
    wm._getJson = jest.fn(async (base) => ({ transactions: rows[base] }));
    const listed = await wm.agreedHistoryRows(W);
    const archive = (r) => ({ hash: r.hash, from: r.from, to: r.to, amountNano: String(r.amount), txType: r.type === 'contract_call' ? 'ContractCall' : 'Transfer' });
    expect(listed.has(listingKey(archive(transfer)))).toBe(true);
    expect(listed.has(listingKey(archive(call)))).toBe(true);
    expect(listed.has(listingKey(archive(lone)))).toBe(false);
    expect(wm._getJson.mock.calls[0][1]).toBe(`/api/v1/transactions/history?address=${W}&per_page=100`);
    // Fewer than two answers: nothing is known.
    wm._getJson = jest.fn(async (base) => (base === 'https://a' ? { transactions: rows[base] } : null));
    expect(await wm.agreedHistoryRows(W)).toBe(null);
  });
});

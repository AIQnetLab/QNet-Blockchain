/**
 * State the wallet shows as verified must be certified and recent. The release ships a real
 * weak-subjectivity pin (scripts/ws-pin.js), checkpoints this device verified persist sealed under the
 * vault's data key so later walks resume there, and a certified but old state counts as unverified.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WS_CHECKPOINT } = require('../src/config/genesisConsensus');
const lc = require('../src/crypto/QcLightClient');
const { WalletManager } = require('../src/components/WalletManager');
const { createVault, sealRecord, openRecord } = require('../src/crypto/Vault');

const K = WS_CHECKPOINT.index;
const anchor = (ids = ['genesis_node_001', 'genesis_node_002']) => ({ eligible_ids: ids, beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) });

beforeEach(() => lc.clearQcCache());

describe('the release pin', () => {
  it('is a real, well-formed pin from the live chain', () => {
    expect(K).toBeGreaterThan(20000);
    expect(WS_CHECKPOINT.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(WS_CHECKPOINT.hash).not.toBe('0'.repeat(64));
    expect(lc.wsPinIsWellformed()).toBe(true);
    for (const i of [K, K - 1]) {
      const ids = lc.decodeEligibleNodeIds(Buffer.from(WS_CHECKPOINT.anchors[i].eligible_raw, 'hex'));
      expect(ids).toEqual(expect.arrayContaining(['genesis_node_001', 'genesis_node_002', 'genesis_node_003', 'genesis_node_004', 'genesis_node_005']));
    }
    expect(lc.trustFloorIndex()).toBe(K + 1);
    expect(lc.highestVerifiedIndex()).toBe(K);
  });
});

describe('resuming from checkpoints verified earlier', () => {
  // Every proof request fails, so the first index asked for shows where the walk started.
  const firstAsked = async (idx) => {
    const asked = [];
    global.fetch = jest.fn(async (url) => {
      const m = /\/macroblock\/(\d+)\/proof$/.exec(url);
      if (m) asked.push(Number(m[1]));
      return { ok: true, json: async () => ({}) };
    });
    await lc.verifyMacroblockStateRoot('aa'.repeat(32), idx * 90, () => 'https://node1.aiqnet.io');
    return asked[0];
  };

  it('walks from the pin with nothing imported', async () => {
    expect(await firstAsked(K + 14)).toBe(K + 2);
    expect(await firstAsked(K + 15)).toBe(K + 1);
  });

  it('starts just above an imported anchor of the same parity', async () => {
    expect(lc.importVerifiedAnchors({ [K + 10]: anchor(), [K + 11]: anchor() })).toBe(2);
    expect(lc.highestVerifiedIndex()).toBe(K + 11);
    expect(await firstAsked(K + 14)).toBe(K + 12);
    expect(await firstAsked(K + 15)).toBe(K + 13);
    // An imported anchor carries no state root, so its own index is verified again.
    expect(await firstAsked(K + 10)).toBe(K + 2);
  });

  it('ignores anchors that are malformed or at or below the pin', () => {
    expect(lc.importVerifiedAnchors({
      [K]: anchor(), [K - 5]: anchor(), [K + 3]: { ...anchor(), beacon: 'zz' }, [K + 4]: { ...anchor(), eligible_ids: [] },
      [K + 5]: { ...anchor(), registry_root: 'CD'.repeat(32) }, foo: anchor(),
    })).toBe(0);
    expect(lc.highestVerifiedIndex()).toBe(K);
  });

  it('exports the highest anchor of each parity for the next session', () => {
    lc.importVerifiedAnchors({ [K + 10]: anchor(), [K + 11]: anchor(), [K + 20]: anchor(['x']) });
    const out = lc.exportVerifiedAnchors();
    expect(Object.keys(out).map(Number).sort()).toEqual([K + 11, K + 20]);
    expect(out[K + 20].eligible_ids).toEqual(['x']);
  });
});

describe('kept under the vault key', () => {
  it('a record sealed for one purpose cannot be opened as another', async () => {
    const { vault, dekKey } = await createVault('{}', 'pw-123456789');
    const rec = await sealRecord(dekKey, vault.id, { anchors: {} }, 'qc-anchors');
    await expect(openRecord(dekKey, rec, 'qc-anchors')).resolves.toEqual({ anchors: {} });
    await expect(openRecord(dekKey, rec)).rejects.toThrow();
  });

  it('a session reloads what an earlier one verified; a planted plaintext record is ignored', async () => {
    await AsyncStorage.clear();
    const { vault, dekKey } = await createVault('{}', 'pw-123456789');
    const wm = new WalletManager();
    wm._session = { token: 't', dekKey, vaultId: vault.id };
    lc.importVerifiedAnchors({ [K + 30]: anchor() });
    await wm._saveVerifiedAnchors();
    lc.clearQcCache();
    await wm._loadVerifiedAnchors();
    expect(lc.highestVerifiedIndex()).toBe(K + 30);

    lc.clearQcCache();
    await AsyncStorage.setItem(WalletManager.ANCHORS_KEY, JSON.stringify({ vault: vault.id, anchors: { [K + 900]: anchor() } }));
    await wm._loadVerifiedAnchors();
    expect(lc.highestVerifiedIndex()).toBe(K);
  });
});

describe('freshness', () => {
  // MOBNET-R1-04: tightened from ten macroblocks (about 15 min) to two.
  it('a certified state more than two macroblocks behind the head counts as unverified', async () => {
    const wm = new WalletManager();
    wm._headHint = { idx: K + 500, at: Date.now() };
    expect(await wm._proofIsFresh((K + 498) * 90)).toBe(true);
    expect(await wm._proofIsFresh((K + 497) * 90)).toBe(false);
  });

  it('the device’s own verified head bounds it too, when the reported head lags', async () => {
    const wm = new WalletManager();
    wm._headHint = { idx: 5, at: Date.now() };
    lc.importVerifiedAnchors({ [K + 100]: anchor() });
    expect(await wm._proofIsFresh((K + 98) * 90)).toBe(true);
    expect(await wm._proofIsFresh((K + 97) * 90)).toBe(false);
  });

  it('the head is the certified frontier at least three genesis nodes report; with none to be read, no proof counts', async () => {
    const { GENESIS_NODES } = require('../src/config/nodes');
    const heads = { [GENESIS_NODES[0]]: K + 900, [GENESIS_NODES[1]]: K + 300, [GENESIS_NODES[2]]: K + 299 };
    global.fetch = jest.fn(async (url) => {
      const base = GENESIS_NODES.find((g) => url.startsWith(`${g}/`));
      if (base && heads[base] && url.endsWith('/api/v1/state/certified')) {
        return { ok: true, status: 200, json: async () => ({ proof_format: 2, views: [], newest_certified_index: heads[base], applied_height: 1e9 }) };
      }
      throw new TypeError('Network request failed');
    });
    const wm = new WalletManager();
    // One node claiming a far head moves nothing: the second highest answer is the head; the applied tip is never read.
    expect(await wm._networkHeadIndex()).toBe(K + 300);
    expect(await wm._proofIsFresh((K + 298) * 90)).toBe(true);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/api/v1/height'))).toBe(false);
    const quiet = new WalletManager();
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    lc.clearQcCache(); // a new session: no head read within the last minute
    lc.importVerifiedAnchors({ [K + 100]: anchor() });
    expect(await quiet._networkHeadIndex()).toBe(null);
    expect(await quiet._proofIsFresh((K + 100) * 90)).toBe(false); // fails closed
  });
});

describe('lineage steps (MOBNET-R1-06)', () => {
  it('a step one node cannot serve is fetched from the next at once; only that node waits out its failure', async () => {
    const asked = [];
    global.fetch = jest.fn(async (url) => {
      const m = /^(https:\/\/[^/]+)\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(url);
      if (m) asked.push([m[1], Number(m[2])]);
      if (url.startsWith('https://pruned.example')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({}) }; // malformed everywhere else too: every node is asked once
    });
    const failed = [];
    const nodes = ['https://pruned.example', 'https://node1.aiqnet.io', 'https://node2.aiqnet.io'];
    await lc.verifyMacroblockStateRoot('aa'.repeat(32), (K + 2) * 90, () => nodes, { onNodeFailure: (b) => failed.push(b) });
    expect(asked.map(([b]) => b)).toEqual(nodes);
    expect(new Set(asked.map(([, j]) => j))).toEqual(new Set([K + 2]));
    expect(failed).toEqual(nodes);
    // Within the TTL none of them is asked again for that step; a new node is.
    asked.length = 0;
    await lc.verifyMacroblockStateRoot('aa'.repeat(32), (K + 2) * 90, () => [...nodes, 'https://node3.aiqnet.io']);
    expect(asked.map(([b]) => b)).toEqual(['https://node3.aiqnet.io']);
  });

  it('a verified step reports progress so it can be kept before the walk ends', async () => {
    const wm = new WalletManager();
    const hooks = wm._lineageHooks();
    const save = jest.spyOn(wm, '_saveVerifiedAnchors').mockResolvedValue(undefined);
    hooks.onProgress(K + 2);
    expect(save).toHaveBeenCalled();
    const before = WalletManager.nodeHealth['https://x.example'];
    hooks.onNodeFailure('https://x.example');
    expect(WalletManager.nodeHealth['https://x.example'].fails).toBe(((before && before.fails) || 0) + 1);
  });
});

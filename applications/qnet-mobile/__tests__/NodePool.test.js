/**
 * Eclipse resistance. A validator list is whatever the answering node says, and its endpoints were chosen
 * by operators, so: the genesis names are always in the pool and no answer removes them; an endpoint joins
 * only when two genesis nodes list it; a stored pool is re-checked when read; server reputation and a
 * far-future last_seen buy nothing; and everything but proof-checked reads goes to genesis names only.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  agreedEndpoints, mergeEndpoints, freshEndpoints, readPoolUrls, loadDiscovered, POOL_KEY, LEGACY_POOL_KEY,
  ENDPOINT_TTL_SECS,
} = require('../src/services/NodePool');
const { GENESIS_NODES } = require('../src/config/nodes');
const { WalletManager } = require('../src/components/WalletManager');

const NOW = 1_800_000_000;
const row = (address, extra = {}) => ({
  node_id: `super_node_${address.length}`, address, is_active: true, is_synced: true, last_seen: NOW - 10,
  reputation: 70, node_type: 'Super', ...extra,
});
const genesisRows = [
  row('http://154.38.160.39:8001'), row('http://62.171.157.44:8001'), row('http://161.97.86.81:8001'),
  row('http://5.189.130.160:8001'), row('http://162.244.25.114:8001'),
];
const answer = (...rows) => ({ validators: [...genesisRows, ...rows], merkle_root: 'ff'.repeat(32) });

describe('agreement between genesis answers', () => {
  it('takes an endpoint only when two genesis answers list it', () => {
    const honest = row('https://validator.example.org');
    const evil = row('https://evil.example');
    const out = agreedEndpoints([answer(honest, evil), answer(honest)], NOW);
    expect(out.map((e) => e.url)).toEqual(['https://validator.example.org']);
  });

  it('counts one answer once, however many times it repeats an endpoint', () => {
    const evil = row('https://evil.example');
    expect(agreedEndpoints([answer(evil, evil, evil)], NOW)).toEqual([]);
  });

  it('never lists a genesis name, a cleartext or IP endpoint, or an idle node', () => {
    const rows = [
      row('https://node1.aiqnet.io'), row('http://validator.example.org'), row('https://203.0.113.7'),
      row('https://validator.example.org:8443'), row('https://idle.example.org', { last_seen: NOW - 7200 }),
      row('https://off.example.org', { is_active: false }), row('https://lagging.example.org', { is_synced: false }),
    ];
    expect(agreedEndpoints([answer(...rows), answer(...rows)], NOW)).toEqual([]);
  });

  it('gives a far-future last_seen and a huge reputation no weight', () => {
    const r = row('https://validator.example.org', { last_seen: 9_999_999_999, reputation: 1e12 });
    const [e] = agreedEndpoints([answer(r), answer(r)], NOW);
    expect(e).toEqual({ url: 'https://validator.example.org', confirmedAt: NOW }); // this device's clock, nothing else
    expect(freshEndpoints([e], NOW + ENDPOINT_TTL_SECS)).toEqual([]);             // and it ages out like any other
  });
});

describe('the pool', () => {
  it('always holds the five genesis names, whatever was discovered or stored', () => {
    expect(readPoolUrls([], NOW)).toEqual(GENESIS_NODES);
    const hostile = [
      { url: 'http://evil.example', confirmedAt: NOW }, { url: 'https://node1.aiqnet.io', confirmedAt: NOW },
      { url: 'https://EVIL.example', confirmedAt: NOW }, { url: 'https://ok.example.org', confirmedAt: NOW + 10 ** 9 },
    ];
    const pool = readPoolUrls(hostile, NOW);
    expect(pool.slice(0, 5)).toEqual(GENESIS_NODES);
    expect(pool.slice(5)).toEqual(['https://ok.example.org']); // clamped to now, so still fresh for the TTL
  });

  it('merges a round into what it has instead of being replaced by it', () => {
    const a = { url: 'https://a.example.org', confirmedAt: NOW - 60 };
    const b = { url: 'https://b.example.org', confirmedAt: NOW };
    expect(mergeEndpoints([a], [b], NOW).map((e) => e.url).sort()).toEqual([a.url, b.url]);
    expect(mergeEndpoints([a], [], NOW + ENDPOINT_TTL_SECS)).toEqual([]);
  });

  it('drops the older builds’ pool and re-checks the stored one when loading', async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(LEGACY_POOL_KEY, JSON.stringify([{ url: 'https://evil.example', lastSeen: 9_999_999_999, reputation: 1 }]));
    await AsyncStorage.setItem(POOL_KEY, JSON.stringify([{ url: 'http://evil.example', confirmedAt: 1 }, { url: 'https://ok.example.org', confirmedAt: Math.floor(Date.now() / 1000) }]));
    expect((await loadDiscovered()).map((e) => e.url)).toEqual(['https://ok.example.org']);
    expect(await AsyncStorage.getItem(LEGACY_POOL_KEY)).toBeNull();
  });
});

describe('the wallet under a hostile validator list', () => {
  let hits;
  const genesisHost = (u) => GENESIS_NODES.some((g) => u.startsWith(`${g}/`));

  beforeEach(async () => {
    await AsyncStorage.clear();
    WalletManager.discovered = [];
    WalletManager.discoveredLoaded = false;
    WalletManager.lastDiscoveryTime = 0;
    WalletManager.nodeHealth = {};
    hits = [];
  });

  it('asks only genesis nodes for the list, and one hostile genesis answer adds nothing', async () => {
    const evil = { ...row('https://evil.example'), last_seen: 9_999_999_999, reputation: 1e9 };
    let n = 0;
    global.fetch = jest.fn(async (url) => {
      hits.push(url);
      n += 1;
      const body = n === 1 ? { validators: [evil, evil] } : { validators: genesisRows };
      return { ok: true, status: 200, json: async () => body };
    });
    const wm = new WalletManager();
    await wm.refreshNodeDiscovery();
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const u of hits) expect(genesisHost(u) && u.endsWith('/api/v1/validators/proof')).toBe(true);
    expect(WalletManager.discovered).toEqual([]);
    expect(wm.getReadNodes(10).sort()).toEqual([...GENESIS_NODES].sort());
  });

  it('keeps writes, unproven reads and device identifiers on genesis names even with a listed endpoint', async () => {
    WalletManager.discovered = [{ url: 'https://validator.example.org', confirmedAt: Math.floor(Date.now() / 1000) }];
    WalletManager.lastDiscoveryTime = Date.now();
    const wm = new WalletManager();
    for (let i = 0; i < 20; i++) {
      for (const u of wm.getTrustedNodes(5)) expect(GENESIS_NODES).toContain(u);
      expect(GENESIS_NODES).toContain(wm.trustedNodeUrl());
    }
    global.fetch = jest.fn(async (url) => { hits.push(url); return { ok: true, status: 200, json: async () => ({ tx_hash: 'h' }) }; });
    await wm._hedged('/api/v1/transaction', { method: 'POST', body: { x: 1 } });
    await wm.confirmServerNode('wallet', { nodeType: 'super' });
    for (const u of hits) expect(genesisHost(u)).toBe(true);
    // The listed endpoint is in the read pool, next to the genesis names, and nowhere else.
    expect(readPoolUrls(WalletManager.discovered)).toContain('https://validator.example.org');
  });

  // MOBNET-R1-10: a read that names the wallet (balance and token proofs, one before every send) never goes to a
  // third-party operator, who could tie this phone's IP to its address and see when it sends.
  it('reads that name the wallet go to genesis names only, even with a listed endpoint in the pool', async () => {
    WalletManager.discovered = [{ url: 'https://validator.example.org', confirmedAt: Math.floor(Date.now() / 1000) }];
    WalletManager.lastDiscoveryTime = Date.now();
    const wm = new WalletManager();
    wm.getReadNodes = () => ['https://validator.example.org', GENESIS_NODES[0]];
    global.fetch = jest.fn(async (url) => {
      hits.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ balance: 1, nonce: 0, merkle_proof: [], token_balance: '0' }), json: async () => ({}) };
    });
    for (let i = 0; i < 10; i++) {
      await wm.getQNCBalanceWithProof('addr');
      await wm.getTokenBalanceWithProof('c'.repeat(64), 'addr');
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const u of hits) expect(genesisHost(u)).toBe(true);
  });
});

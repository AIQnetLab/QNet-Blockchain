/**
 * The owner's 06.10 round on speed and the refused send, the wallet's reads:
 * - a hedged read counts only a 2xx answer whose body was read and is no rate-limit answer; anything else hands over to
 *   the next node at once, a body that stalls times out, and only when every node failed is the last failure returned;
 *   balance and token proofs ask up to three genesis names;
 * - a send is decided only by a committee-certified balance: one read a moment ago at the nonce the send is about to use,
 *   else one verified read within a single deadline; never one node's word, never what genesis nodes agree on;
 * - agreement reads settle as soon as the answers still out cannot change them, and never on anything else.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES } = require('../src/config/nodes');
const lc = require('../src/crypto/QcLightClient');

jest.setTimeout(60000);

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';
const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const TOKEN = 'c'.repeat(64);
const ROOT = 'ab'.repeat(32);
const RATE_LIMIT = { success: false, error: 'Rate limit exceeded', retry_after_seconds: 3, message: 'Too many requests.' };

const reply = (status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// A request that answers only when the caller gives up on it.
const hanging = (opts) => new Promise((_, reject) => {
  const signal = opts && opts.signal;
  if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
});
const genesisOf = (url) => GENESIS_NODES.find((g) => url.startsWith(`${g}/`));

beforeEach(async () => {
  await AsyncStorage.clear();
  WalletManager.nodeHealth = {};
  WalletManager.sendProofs.clear();
  WalletManager.sendReads.clear();
  WalletManager.nonceReads.clear();
  WalletManager.pkBound = {};
  lc.clearQcCache();
});

describe('a hedged read', () => {
  it('[429, 200]: the 429 is that node\'s failure, and the next node is asked at once', async () => {
    global.fetch = jest.fn(async (url) => (url.startsWith(A) ? reply(429, { error: 'busy' }) : reply(200, { nonce: 4 })));
    const wm = new WalletManager();
    const t0 = Date.now();
    const res = await wm._hedged('/api/v1/account/x', { nodes: [A, B], hedgeMs: 10_000, timeoutMs: 3000 });
    expect(res).toMatchObject({ ok: true, status: 200, data: { nonce: 4 }, base: B });
    expect(Date.now() - t0).toBeLessThan(2000); // not after the hedge timer
    expect(WalletManager.nodeHealth[A].fails).toBe(1);
    expect(WalletManager.nodeHealth[B].fails).toBe(0);
  });

  it('[502 x3]: the last failure, only once every node answered', async () => {
    const answered = [];
    global.fetch = jest.fn(async (url) => {
      const base = [A, B, C].find((b) => url.startsWith(b));
      await sleep({ [A]: 0, [B]: 40, [C]: 80 }[base]);
      answered.push(base);
      return reply(502, { error: 'bad gateway', from: base });
    });
    const wm = new WalletManager();
    const res = await wm._hedged('/api/v1/account/x', { nodes: [A, B, C], hedgeMs: 10_000, timeoutMs: 3000 });
    expect(answered).toEqual([A, B, C]);
    expect(res).toMatchObject({ ok: false, status: 502, base: C });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('[200 rate-limit body, 200]: the node\'s rate limit is no answer, raw or parsed', async () => {
    global.fetch = jest.fn(async (url) => (url.startsWith(A) ? reply(200, RATE_LIMIT) : reply(200, '{"balance":5,"nonce":1}')));
    const wm = new WalletManager();
    await expect(wm._hedged('/p', { nodes: [A, B], hedgeMs: 10_000 })).resolves.toMatchObject({ ok: true, base: B, data: { balance: 5 } });
    await expect(wm._hedged('/p', { nodes: [A, B], hedgeMs: 10_000, raw: true }))
      .resolves.toMatchObject({ ok: true, base: B, data: '{"balance":5,"nonce":1}' });
    // Only rate-limited answers: the last of them, marked, never an answer that counts.
    global.fetch = jest.fn(async () => reply(200, RATE_LIMIT));
    await expect(wm._hedged('/p', { nodes: [A, B], hedgeMs: 10_000 })).resolves.toMatchObject({ ok: false, rateLimited: true });
  });

  it('a body that stalls times out, and the next node is asked', async () => {
    const stalled = { ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) };
    global.fetch = jest.fn(async (url) => (url.startsWith(A) ? stalled : reply(200, { nonce: 9 })));
    const wm = new WalletManager();
    let t0 = Date.now();
    await expect(wm._hedged('/p', { nodes: [A], timeoutMs: 250 })).rejects.toThrow(/Timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
    t0 = Date.now();
    await expect(wm._hedged('/p', { nodes: [A, B], timeoutMs: 250, hedgeMs: 10_000 })).resolves.toMatchObject({ ok: true, base: B });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
  });

  it('an unreadable body is no answer either', async () => {
    global.fetch = jest.fn(async (url) => (url.startsWith(A) ? reply(200, '<html>gateway</html>') : reply(200, { nonce: 2 })));
    const wm = new WalletManager();
    await expect(wm._hedged('/p', { nodes: [A, B], hedgeMs: 10_000 })).resolves.toMatchObject({ ok: true, base: B });
  });

  it('a balance proof asks up to three genesis names, one after another as each fails', async () => {
    let n = 0;
    const hosts = [];
    global.fetch = jest.fn(async (url) => {
      hosts.push(genesisOf(url));
      n += 1;
      return n < 3 ? reply(502, {}) : reply(200, `{"balance":5000000000,"nonce":3,"merkle_proof":[{"sibling":"${'00'.repeat(32)}","is_right":true}],"state_root":"ab","block_height":9000}`);
    });
    const wm = new WalletManager();
    // The third answer's proof folds to the root its node served, which is not certified: a figure, not verified.
    wm.verifyMerkleProof = jest.fn(async () => true);
    wm._certifiedFresh = jest.fn(async () => false);
    await expect(wm.getQNCBalanceWithProof(ME)).resolves.toMatchObject({ ok: true, balanceNano: '5000000000', verified: false });
    expect(new Set(hosts).size).toBe(3);
    expect(hosts.every(Boolean)).toBe(true); // genesis names only
  });
});

describe('the balance a send is decided by', () => {
  const keep = (nonce, balanceNano = '7000000000') => WalletManager._keepSendProof(`qnc|${ME}`, {
    ok: true, verified: true, balanceNano, nonce: String(nonce), balance: Number(balanceNano) / 1e9,
  }, ROOT);

  it('a certified proof read a moment ago at the same nonce: no network read at all', async () => {
    const wm = new WalletManager();
    wm.getQNCBalanceWithProof = jest.fn();
    global.fetch = jest.fn(async () => { throw new TypeError('no network in this test'); });
    keep(7);
    await expect(wm.certifiedQncForSend(ME, { nonce: 7 })).resolves.toMatchObject({ ok: true, verified: true, balanceNano: '7000000000', cached: true });
    expect(wm.getQNCBalanceWithProof).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('the nonce moved (a spend made elsewhere), the proof aged past 30 s, or the nonce is unknown: one fresh read', async () => {
    const wm = new WalletManager();
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, balanceNano: '2000000000', nonce: '8', balance: 2 }));
    keep(7);
    const moved = await wm.certifiedQncForSend(ME, { nonce: 8 });
    expect(moved).toMatchObject({ ok: true, balanceNano: '2000000000', nonce: '8' });
    expect(moved.cached).toBeUndefined();
    keep(8);
    WalletManager.sendProofs.get(`qnc|${ME}`).at -= WalletManager.SEND_PROOF_MAX_AGE_MS + 1;
    await expect(wm.certifiedQncForSend(ME, { nonce: 8 })).resolves.not.toHaveProperty('cached');
    keep(8);
    await expect(wm.certifiedQncForSend(ME, { nonce: null })).resolves.not.toHaveProperty('cached');
    expect(wm.getQNCBalanceWithProof).toHaveBeenCalledTimes(3);
    expect(WalletManager.SEND_PROOF_MAX_AGE_MS).toBe(30_000);
  });

  it('without a nonce from the caller, the one genesis nodes agree on retires a kept proof, never stands for a balance', async () => {
    global.fetch = jest.fn(async (url) => (/\/api\/v1\/account\/[^/]+$/.test(url) ? reply(200, { nonce: 7, balance: 999e9 }) : reply(500, {})));
    const wm = new WalletManager();
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: false, verified: false }));
    keep(7);
    await expect(wm.certifiedQncForSend(ME)).resolves.toMatchObject({ ok: true, balanceNano: '7000000000', cached: true });
    expect(wm.getQNCBalanceWithProof).not.toHaveBeenCalled();
    WalletManager.sendProofs.clear();
    // Nothing certified to be had: refused, though every genesis node names the same balance.
    await expect(wm.certifiedQncForSend(ME)).resolves.toMatchObject({ ok: false, verified: false, balanceNano: null, error: 'unanswered' });
  });

  it('a walk that never ends does not hold the send check past its deadline', async () => {
    expect(WalletManager.SEND_CHECK_DEADLINE_MS).toBe(6000);
    global.fetch = jest.fn(async (url) => (url.includes('/balance/proof')
      ? reply(200, `{"balance":5000000000,"nonce":3,"merkle_proof":[{"sibling":"00","is_right":true}],"state_root":"${ROOT}","block_height":9000}`)
      : reply(200, { nonce: 3, height: 9000 })));
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => true);
    wm._certifiedFresh = jest.fn(() => new Promise(() => {})); // the lineage walk, never done
    const saved = WalletManager.SEND_CHECK_DEADLINE_MS;
    WalletManager.SEND_CHECK_DEADLINE_MS = 400;
    try {
      const t0 = Date.now();
      // A node answered and its walk did not end in time: the balance is not confirmed yet, which is not "no answer".
      await expect(wm.certifiedQncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: false, error: 'unconfirmed' });
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(390);
      expect(took).toBeLessThan(2500);
      // The nonce a send signs at waits no longer for it either: the agreed nonce stands within the same deadline.
      const t1 = Date.now();
      await expect(wm._confirmedAccountNonce(ME)).resolves.toBe(3);
      expect(Date.now() - t1).toBeLessThan(2500);
      // Nothing answering at all is "unanswered", within the same deadline.
      WalletManager.sendProofs.clear();
      global.fetch = jest.fn(async (url, opts) => (url.includes('/balance/proof') ? hanging(opts) : reply(200, { nonce: 3 })));
      await expect(wm.certifiedQncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: false, error: 'unanswered' });
    } finally {
      WalletManager.SEND_CHECK_DEADLINE_MS = saved;
    }
  });

  it('no path takes an unverified balance, one node\'s or what genesis nodes agree on', async () => {
    const wm = new WalletManager();
    // An answer no proof certified: refused, and never kept for the next check.
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/balance/proof')) return reply(200, `{"balance":9000000000,"nonce":3,"merkle_proof":[{"sibling":"00","is_right":true}],"state_root":"${ROOT}","block_height":9000}`);
      if (/\/api\/v1\/account\/[^/]+$/.test(url)) return reply(200, { nonce: 3, balance: 9000000000 });
      return reply(500, {});
    });
    wm.verifyMerkleProof = jest.fn(async () => true);
    wm._certifiedFresh = jest.fn(async () => false);
    await expect(wm.certifiedQncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: false, balanceNano: null });
    expect(WalletManager.sendProofs.size).toBe(0);
    // Every genesis node gives the same balance, so an agreement exists; the send check still refuses.
    await expect(wm.agreedGenesisBalance(ME)).resolves.toBe(9);
    await expect(wm.certifiedQncForSend(ME)).resolves.toMatchObject({ ok: false });
    // A certified proof older than the account's nonce shows (a spend after it): refused as well.
    wm._certifiedFresh = jest.fn(async () => true);
    await expect(wm.certifiedQncForSend(ME, { nonce: 5 })).resolves.toMatchObject({ ok: false });
    await expect(wm.certifiedQncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: true, verified: true, balanceNano: '9000000000' });
    // Tokens: unverified answers alike from every node are no balance.
    global.fetch = jest.fn(async () => reply(200, JSON.stringify({ token_balance: '9000000', block_height: 90, state_root: 'aa' })));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 6, { nonce: null })).resolves.toMatchObject({ ok: false, verified: false });
  });

  it('the send paths read only the certified balance', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const fresh = ws.slice(ws.indexOf('const freshQncNano = async () => {'), ws.indexOf('// Close Send Screen and go back to assets'));
    expect(fresh).toMatch(/walletManager\.certifiedQncForSend\(addr\)/);
    expect(fresh).toMatch(/r && r\.ok && r\.verified && /);
    expect(fresh).not.toMatch(/getQNCBalanceWithProof|agreedGenesisBalance/);
    const send = ws.slice(ws.indexOf('const handleSendTransaction = async () => {'), ws.indexOf('const pressSend = async'));
    expect(send).not.toMatch(/agreedGenesisBalance|getQNCBalanceWithProof|tokenBalances\.qnc/);
    const br = fs.readFileSync(path.join(__dirname, '../src/browser/BrowserScreen.js'), 'utf8');
    expect((br.match(/walletManager\.certifiedQncForSend\(from/g) || []).length).toBe(2);
    expect(br).not.toMatch(/getQNCBalanceWithProof|agreedGenesisBalance/);
    const wmSrc = fs.readFileSync(path.join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    const checked = wmSrc.slice(wmSrc.indexOf('  async checkedTokenBalance('), wmSrc.indexOf('  static stillSent('));
    expect(checked).not.toMatch(/MIN_GENESIS_AGREEMENT|getTrustedNodes/);
  });

  it('a token balance counts only beside the holder\'s certified QNC proof of the same state, which gives its nonce there', async () => {
    const wm = new WalletManager();
    wm.getTokenBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, balanceBase: '500', stateRoot: ROOT, index: null }));
    global.fetch = jest.fn(async () => { throw new TypeError('no network in this test'); });
    WalletManager._keepSendProof(`token|${TOKEN}|${ME}`, { balanceBase: '700' }, ROOT);
    // No certified QNC proof of the holder to be had: its nonce in that state is unknown, so no token balance either.
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 7 })).resolves.toMatchObject({ ok: false, balanceBase: null, error: 'unanswered' });
    expect(wm.getTokenBalanceWithProof).not.toHaveBeenCalled();
    keep(7);
    WalletManager._keepSendProof(`token|${TOKEN}|${ME}`, { balanceBase: '700' }, ROOT);
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 7 })).resolves.toMatchObject({ ok: true, balanceBase: '700', balance: '7', cached: true });
    expect(wm.getTokenBalanceWithProof).not.toHaveBeenCalled();
    // A token proof of another state than the QNC proof's is not paired with it: refused.
    WalletManager.sendProofs.delete(`token|${TOKEN}|${ME}`);
    wm.getTokenBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, balanceBase: '500', stateRoot: 'cd'.repeat(32), index: null }));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 7 })).resolves.toMatchObject({ ok: false, balanceBase: null });
    // The holder's nonce moved past the certified one by a transaction this wallet does not know (another device):
    // refused, though the token proof pairs.
    WalletManager._keepSendProof(`token|${TOKEN}|${ME}`, { balanceBase: '700' }, ROOT);
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 8 })).resolves.toMatchObject({ ok: false, balanceBase: null, error: 'foreign' });
  });

  it('two checks at once share one read', async () => {
    const wm = new WalletManager();
    let release;
    wm.getQNCBalanceWithProof = jest.fn(() => new Promise((r) => { release = () => r({ ok: true, verified: true, balanceNano: '1', nonce: '2' }); }));
    const both = Promise.all([wm.certifiedQncForSend(ME, { nonce: 2 }), wm.certifiedQncForSend(ME, { nonce: 2 })]);
    await sleep(10);
    release();
    const [x, y] = await both;
    expect(x).toMatchObject({ ok: true, balanceNano: '1' });
    expect(y).toMatchObject({ ok: true, balanceNano: '1' });
    expect(wm.getQNCBalanceWithProof).toHaveBeenCalledTimes(1);
  });
});

describe('agreement reads settle once the rest cannot change them', () => {
  const answering = (byIndex) => jest.fn((url, opts) => {
    const i = GENESIS_NODES.findIndex((g) => url.startsWith(`${g}/`));
    const a = byIndex(i);
    if (a === 'hang') return hanging(opts);
    if (a && typeof a.then === 'function') return a;
    return Promise.resolve(a === null ? reply(503, {}) : reply(200, a));
  });

  it('the account nonce: one node that never answers no longer delays it', async () => {
    global.fetch = answering((i) => (i === 4 ? 'hang' : { nonce: 4 }));
    const wm = new WalletManager();
    const t0 = Date.now();
    await expect(wm._agreedGenesisNonce(ME)).resolves.toBe(4);
    expect(Date.now() - t0).toBeLessThan(1500); // not the 4 s timeout of the fifth
  });

  it('the account nonce: never settled while a higher value can still reach an agreement', async () => {
    global.fetch = answering((i) => (i === 0 ? { nonce: 13 } : i === 4 ? sleep(300).then(() => reply(200, { nonce: 13 })) : { nonce: 4 }));
    const wm = new WalletManager();
    const t0 = Date.now();
    await expect(wm._agreedGenesisNonce(ME)).resolves.toBe(13); // what reading all five gives
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it('the certified head: one node that never answers no longer delays it; a split still waits for the last', async () => {
    const certified = (index) => ({ proof_format: 2, views: [], newest_certified_index: index, finalized_height: 0, applied_height: 999999, capture: 'ok' });
    global.fetch = answering((i) => (i === 4 ? 'hang' : certified(100)));
    const wm = new WalletManager();
    let t0 = Date.now();
    await expect(wm._networkHeadIndex()).resolves.toBe(100);
    expect(Date.now() - t0).toBeLessThan(1500);
    // The two highest answers in differ: the last one could move the head, so it is waited for.
    lc.clearQcCache();
    global.fetch = answering((i) => (i === 0 ? certified(110) : i === 4 ? sleep(300).then(() => reply(200, certified(110))) : certified(100)));
    const fresh = new WalletManager();
    t0 = Date.now();
    await expect(fresh._networkHeadIndex()).resolves.toBe(110);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/api/v1/height'))).toBe(false);
  });

  it('an agreement of three asked first: two alike do not wait for the third', async () => {
    global.fetch = answering((i) => (i === 1 ? 'hang' : { success: false, error: WalletManager.NO_TOKEN }));
    const wm = new WalletManager();
    const t0 = Date.now();
    await expect(wm.agreedContractKind(ME)).resolves.toBe('none');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('a send check and the nonce plan asking together share one nonce read', async () => {
    global.fetch = answering(() => ({ nonce: 4 }));
    const wm = new WalletManager();
    await Promise.all([wm._agreedGenesisNonce(ME), wm._agreedGenesisNonce(ME)]);
    expect(global.fetch).toHaveBeenCalledTimes(GENESIS_NODES.length);
  });
});

/**
 * The owner's 06.10 round on speed and the refused send, the wallet's reads:
 * - a hedged read counts only a 2xx answer whose body was read and is no rate-limit answer; anything else hands over to
 *   the next node at once, a body that stalls times out, and only when every node failed is the last failure returned;
 *   balance and token proofs ask up to three genesis names;
 * - a send is checked against the wallet's figure at a genesis node's live tip, its proof folded, in one read (a figure
 *   read a moment ago is taken as it is); the certified read decides nothing there (owner, 18.10);
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
  WalletManager.liveFigures.clear();
  WalletManager.liveReads.clear();
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
      // the certified head, read beside the proof (_balanceProofFrom): none here
      if (/\/api\/v1\/(state\/certified|debug\/consensus-position)$/.test(url)) return reply(404, {});
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

// Before (MB-R2-02), a send waited up to 20 s for a committee-certified balance and was refused when none came in time;
// now it is checked against the genesis nodes' live tip in one read, and the certified read decides nothing (owner, 18.10).
describe('the balance a send is checked against', () => {
  const LIVE_BODY = `{"balance":5000000000,"nonce":3,"merkle_proof":[{"sibling":"${'00'.repeat(32)}","is_right":true}],"state_root":"${ROOT}","block_height":9000}`;
  // A node that answers the live proof route, the account route and nothing else; `proofs` counts the proof reads.
  const answering = (counter = { proofs: 0, certified: 0 }) => jest.fn(async (url) => {
    if (url.includes('/balance/proof?mb=')) { counter.certified += 1; return reply(200, '{}'); }
    if (url.endsWith('/balance/proof')) { counter.proofs += 1; return reply(200, LIVE_BODY); }
    if (/\/api\/v1\/account\/[^/]+$/.test(url)) return reply(200, { nonce: 3, balance: 5000000000 });
    return reply(500, {});
  });

  it('one read of the live tip, its proof folded; no certified walk is waited for, none is even asked', async () => {
    const counter = { proofs: 0, certified: 0 };
    global.fetch = answering(counter);
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => true);
    wm._certifiedFresh = jest.fn(() => new Promise(() => {})); // a lineage walk that never ends
    wm.getQNCBalanceWithProof = jest.fn(() => new Promise(() => {}));
    const t0 = Date.now();
    await expect(wm.qncForSend(ME)).resolves.toMatchObject({ ok: true, balanceNano: '5000000000', nonce: '3', accountNonce: 3, pending: [] });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect([counter.proofs, counter.certified]).toEqual([1, 0]);
    expect(wm._certifiedFresh).not.toHaveBeenCalled();
    expect(wm.getQNCBalanceWithProof).not.toHaveBeenCalled();
    // The nonce a send signs at waits for no walk either.
    await expect(wm._confirmedAccountNonce(ME)).resolves.toBe(3);
  });

  it('a figure read within LIVE_SEND_REUSE_MS is taken as it is (the Send screen read it); an older one is read again', async () => {
    const counter = { proofs: 0, certified: 0 };
    global.fetch = answering(counter);
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => true);
    await wm.qncForSend(ME);
    await expect(wm.qncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: true, balanceNano: '5000000000' });
    expect(counter.proofs).toBe(1);
    WalletManager.liveFigures.get(ME).at -= WalletManager.LIVE_SEND_REUSE_MS + 1;
    await wm.qncForSend(ME, { nonce: 3 });
    expect(counter.proofs).toBe(2);
    expect(WalletManager.LIVE_SEND_REUSE_MS).toBe(15_000);
    // The screen's own read never takes a kept figure: it always reads anew.
    await wm.liveQncFigure(ME);
    expect(counter.proofs).toBe(3);
  });

  it('two checks at once share one read', async () => {
    const counter = { proofs: 0, certified: 0 };
    global.fetch = answering(counter);
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => true);
    const [x, y] = await Promise.all([wm.qncForSend(ME, { nonce: 3 }), wm.qncForSend(ME, { nonce: 3 })]);
    expect([x.ok, y.ok, counter.proofs]).toEqual([true, true, 1]);
  });

  it('no figure whose proof folds: refused as unanswered, at once, though every genesis node names a balance', async () => {
    global.fetch = answering();
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => false);
    const t0 = Date.now();
    await expect(wm.qncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: false, balanceNano: null, error: 'unanswered' });
    await expect(wm.agreedGenesisBalance(ME)).resolves.toBe(5);
    global.fetch = jest.fn(async (url, opts) => (url.endsWith('/balance/proof') ? reply(502, {}) : reply(200, { nonce: 3 })));
    await expect(wm.qncForSend(ME, { nonce: 3 })).resolves.toMatchObject({ ok: false, error: 'unanswered' });
    expect(Date.now() - t0).toBeLessThan(2500);
    // Tokens: an answer whose two levels do not fold is no balance either.
    global.fetch = jest.fn(async () => reply(200, JSON.stringify({ token_balance: '9000000', block_height: 90, state_root: 'aa' })));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 6, { nonce: null })).resolves.toMatchObject({ ok: false, balanceBase: null, error: 'unanswered' });
  });

  it('the send paths read the live base, and nothing of the certified send check is left', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const fresh = ws.slice(ws.indexOf('const freshQncNano = async () => {'), ws.indexOf('// Close Send Screen and go back to assets'));
    expect(fresh).toMatch(/walletManager\.qncForSend\(addr\)/);
    expect(fresh).not.toMatch(/getQNCBalanceWithProof|agreedGenesisBalance|verified/);
    const send = ws.slice(ws.indexOf('const handleSendTransaction = async () => {'), ws.indexOf('const pressSend = async'));
    expect(send).not.toMatch(/agreedGenesisBalance|getQNCBalanceWithProof|tokenBalances\.qnc/);
    const br = fs.readFileSync(path.join(__dirname, '../src/browser/BrowserScreen.js'), 'utf8');
    expect((br.match(/walletManager\.qncForSend\(from/g) || []).length).toBe(2);
    expect(br).not.toMatch(/getQNCBalanceWithProof|agreedGenesisBalance|certifiedQncForSend/);
    const wmSrc = fs.readFileSync(path.join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    const checked = wmSrc.slice(wmSrc.indexOf('  async checkedTokenBalance('), wmSrc.indexOf('  static stillSent('));
    expect(checked).not.toMatch(/MIN_GENESIS_AGREEMENT|getTokenBalanceWithProof|_certified/);
    expect(wmSrc).not.toMatch(/certifiedQncForSend|sendProofs|_sendBase|_certifiedQncBase|_keepSendProof/);
  });

  it('a token balance is read at the same moment as the holder\'s live QNC figure, from the same genesis names', async () => {
    const wm = new WalletManager();
    global.fetch = jest.fn(async () => reply(200, { nonce: 7 }));
    wm.liveTokenFigure = jest.fn(async () => ({ balanceBase: '700', balance: '7', blockHeight: 9000 }));
    wm.liveQncFigure = jest.fn(async () => ({ balance: 1, balanceNano: '1000000000', nonce: '7', blockHeight: 9000 }));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 7 })).resolves.toEqual({ ok: true, balanceBase: '700', pending: [], balance: '7' });
    const nodes = wm.liveTokenFigure.mock.calls[0][3].nodes;
    expect(nodes.length).toBeGreaterThan(0);
    // Read now, never a kept one: the token figure is of this moment too (SendAfterOwnSend.test.js).
    expect(wm.liveQncFigure.mock.calls[0][1]).toMatchObject({ nodes, maxAgeMs: 0 });
    // No live QNC figure of the holder: its nonce in that state is unknown, so no token balance either.
    wm.liveQncFigure = jest.fn(async () => null);
    await expect(wm.checkedTokenBalance(TOKEN, ME, 2, { nonce: 7 })).resolves.toMatchObject({ ok: false, balanceBase: null, error: 'unanswered' });
    // A recipient's balance (nonce null) is its live figure as it is.
    await expect(wm.checkedTokenBalance(TOKEN, 'x', 2, { nonce: null })).resolves.toEqual({ ok: true, balanceBase: '700', pending: [], balance: '7' });
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

/**
 * The app's Solana calls go straight to the cluster's endpoint, and through the site the wallet already uses once the
 * endpoint gave this device no answer at all (utils/solanaRoute, services/SolanaSend solanaRpc). The route is kept on the
 * device, so no call waits on the way it remembers as failed, a restart included; on the site route a direct
 * getBlockHeight is tried in the background, never waited for, and its answer puts the calls back on the endpoint. Each
 * case loads the app's modules anew, as a fresh JS run, over the one storage of this file, cleared before each case.
 */
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const mockStorage = require('@react-native-async-storage/async-storage');
const { EXPLORER_API } = require('../src/config/nodes');
const { base58Encode } = require('../src/crypto/SolanaTx');
const R = require('../src/utils/solanaRoute');

const ROUTE_KEY = 'qnet_solana_route_v1';
const DIRECT = 'https://api.devnet.solana.com';
const RELAY = `${EXPLORER_API}/api/cabinet/solana`;
const OWNER = base58Encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).publicKey);
const BALANCE = ['getBalance', [OWNER, { commitment: 'confirmed' }]];
const HASH = base58Encode(new Uint8Array(32).fill(0xb1));

const flush = () => new Promise((resolve) => { setImmediate(resolve); });
// The kept route as the storage holds it, read and set past the storage's call records, which count the app's own.
const kept = () => JSON.parse(mockStorage.__INTERNAL_MOCK_STORAGE__[ROUTE_KEY] || 'null');
const keep = (route) => { mockStorage.__INTERNAL_MOCK_STORAGE__[ROUTE_KEY] = JSON.stringify(route); };
const routeWrites = () => mockStorage.setItem.mock.calls.filter(([key]) => key === ROUTE_KEY).length;
const routeReads = () => mockStorage.getItem.mock.calls.filter(([key]) => key === ROUTE_KEY).length;
const reply = (status, payload) => ({
  ok: status >= 200 && status < 300, status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});
const result = (r) => reply(200, { jsonrpc: '2.0', id: 1, result: r });
const RESULTS = {
  getBalance: { context: { slot: 1 }, value: 1_500_000_000 },
  getBlockHeight: 900,
  getLatestBlockhash: { context: { slot: 1 }, value: { blockhash: HASH, lastValidBlockHeight: 1000 } },
  sendTransaction: 'accepted',
};

// The endpoint and the site's route, each answering as the case sets it: 'answer' (the method's result), 'reject' (no
// answer at all), 'hang' (nothing until the call's own timer aborts it), 'held' (nothing until the case answers it),
// 'garbage', an HTTP status, a response, a list taken one per request, or a function of the request giving one of these.
function network(over = {}) {
  const net = { ways: { [DIRECT]: 'answer', [RELAY]: 'answer', ...over }, calls: [], held: [] };
  global.fetch = jest.fn((url, init) => {
    const req = JSON.parse(init.body);
    net.calls.push({ url, body: init.body, method: req.method, params: req.params });
    if (!(url in net.ways)) return Promise.reject(new Error(`unexpected ${url}`));
    let way = net.ways[url];
    if (Array.isArray(way)) way = way.length > 1 ? way.shift() : way[0];
    if (typeof way === 'function') way = way(req);
    if (way === 'answer') return Promise.resolve(result(RESULTS[req.method]));
    if (way === 'reject') return Promise.reject(new TypeError('Network request failed'));
    if (way === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      });
    }
    if (way === 'held') return new Promise((resolve) => { net.held.push({ resolve, req }); });
    if (way === 'garbage') return Promise.resolve(reply(200, '<html>busy</html>'));
    if (typeof way === 'number') return Promise.resolve(reply(way, 'busy'));
    return Promise.resolve(way);
  });
  return net;
}

// The app's modules as a fresh JS run loads them, over this file's storage.
function freshApp(more = {}) {
  const app = {};
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => mockStorage);
    app.rn = require('react-native');
    app.send = require('../src/services/SolanaSend');
    app.wake = require('../src/services/NetworkWake');
    for (const [name, file] of Object.entries(more)) app[name] = require(file);
  });
  return app;
}

let info;
beforeEach(async () => {
  await mockStorage.clear();
  mockStorage.setItem.mockClear();
  mockStorage.getItem.mockClear();
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  jest.useRealTimers();
});
const routeLogs = () => info.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[SOLANA]'));

describe('the route rule (utils/solanaRoute), the one the extension compiles too', () => {
  const direct = { v: 1, via: 'direct', probeAt: 0 };

  it('reads a kept route strictly: anything but an exact site route is the direct one', () => {
    expect(R.solanaRouteOf({ v: 1, via: 'site', probeAt: 5 })).toEqual({ v: 1, via: 'site', probeAt: 5 });
    expect(R.solanaRouteOf({ probeAt: 0, via: 'site', v: 1 })).toEqual({ v: 1, via: 'site', probeAt: 0 });
    for (const bad of [undefined, null, 'site', 1, true, [], [1, 'site', 5], {}, { v: 1, via: 'direct', probeAt: 0 },
      { v: 1, via: 'direct', probeAt: 7 }, { v: 2, via: 'site', probeAt: 5 }, { v: '1', via: 'site', probeAt: 5 },
      { v: 1, via: 'Site', probeAt: 5 }, { v: 1, via: 'site' }, { v: 1, via: 'site', probeAt: -1 },
      { v: 1, via: 'site', probeAt: 1.5 }, { v: 1, via: 'site', probeAt: '5' }, { v: 1, via: 'site', probeAt: 2 ** 53 },
      { v: 1, via: 'site', probeAt: 5, at: 5 }]) {
      expect([bad, R.solanaRouteOf(bad)]).toEqual([bad, direct]);
    }
  });

  it('a direct try that got an answer goes direct; one that got none goes through the site from that moment', () => {
    expect(R.solanaRouteAfter(true, 1234)).toEqual(direct);
    expect(R.solanaRouteAfter(false, 1234)).toEqual({ v: 1, via: 'site', probeAt: 1234 });
    expect(R.solanaRouteOf(JSON.parse(JSON.stringify(R.solanaRouteAfter(false, 1234))))).toEqual({ v: 1, via: 'site', probeAt: 1234 });
    expect(R.solanaRouteAfter(false, NaN)).toEqual({ v: 1, via: 'site', probeAt: 0 });
  });

  it('after an attempt: the site with no usable answer hands over to the endpoint, the endpoint with none at all to the site', () => {
    const at = 1_700_000_000_000;
    for (const answer of ['none', 'unusable']) {
      expect([answer, R.solanaAttemptAfter('site', answer, at)]).toEqual([answer, { route: null, next: 'direct' }]);
    }
    expect(R.solanaAttemptAfter('site', 'usable', at)).toEqual({ route: null, next: 'site' });
    expect(R.solanaAttemptAfter('direct', 'usable', at)).toEqual({ route: direct, next: 'direct' });
    expect(R.solanaAttemptAfter('direct', 'none', at)).toEqual({ route: { v: 1, via: 'site', probeAt: at }, next: 'site' });
    expect(R.solanaAttemptAfter('direct', 'unusable', at)).toEqual({ route: null, next: 'direct' });
  });

  it('a direct try is due on the site route only: 300 s after the last one, after a network change, or when the clock went back', () => {
    expect(R.SOLANA_DIRECT_RETRY_MS).toBe(300_000);
    const site = R.solanaRouteAfter(false, 1_000_000);
    expect(R.solanaProbeDue(site, 1_299_999)).toBe(false);
    expect(R.solanaProbeDue(site, 1_300_000)).toBe(true);
    expect(R.solanaProbeDue(site, 1_000_005, 1_000_000)).toBe(false); // that network was there at the last try
    expect(R.solanaProbeDue(site, 1_000_005, 1_000_001)).toBe(true);
    expect(R.solanaProbeDue(site, 999_999)).toBe(true); // the last try is dated after now
    expect(R.solanaProbeDue(direct, 10 ** 13, 10 ** 13)).toBe(false);
    expect(R.solanaProbeDue(null, 10 ** 13)).toBe(false);
  });

  it('imports nothing and names no address, so the extension\'s bundle compiles the same file', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'solanaRoute.js'), 'utf8');
    expect(text).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe('the app\'s one Solana client (services/SolanaSend solanaRpc)', () => {
  it('a direct answer makes no site call and writes no route', async () => {
    const net = network();
    const { send } = freshApp();
    await expect(send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
    expect(net.calls.map((c) => c.url)).toEqual([DIRECT]);
    await flush();
    expect(routeWrites()).toBe(0);
    expect(routeLogs()).toEqual([]);
  });

  it('no answer at all from the endpoint: the same body goes to the site at once, the site route is kept, the next call goes there only', async () => {
    const net = network({ [DIRECT]: 'reject' });
    const { send } = freshApp();
    const before = Date.now();
    await expect(send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
    expect(net.calls.map((c) => c.url)).toEqual([DIRECT, RELAY]);
    expect(net.calls[1].body).toBe(net.calls[0].body);
    await flush();
    const site = kept();
    expect(site).toEqual({ v: 1, via: 'site', probeAt: expect.any(Number) });
    expect(site.probeAt).toBeGreaterThanOrEqual(before);
    expect(site.probeAt).toBeLessThanOrEqual(Date.now());
    expect(routeLogs()).toEqual(['[INFO][SOLANA] route_changed via=site reason=no_answer']);
    net.calls.length = 0;
    await expect(send.solanaRpc('getBlockHeight', [{ commitment: 'confirmed' }])).resolves.toBe(900);
    await send.solanaRpc(...BALANCE);
    expect(net.calls.map((c) => c.url)).toEqual([RELAY, RELAY]);
    // Read once per JS run, written once: the calls on the route it already holds change nothing.
    await flush();
    expect(routeWrites()).toBe(1);
    expect(routeReads()).toBe(1);
  });

  it('a direct call cut by its 8 s timer is no answer too; an attempt on the site gets 20 s', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const net = network({ [DIRECT]: 'hang', [RELAY]: 'hang' });
    const { send } = freshApp();
    let settled = false;
    const out = send.solanaRpc(...BALANCE).catch((e) => e).finally(() => { settled = true; });
    const urls = () => net.calls.map((c) => c.url);
    await flush();
    expect(urls()).toEqual([DIRECT]);
    jest.advanceTimersByTime(7999);
    await flush();
    expect(urls()).toEqual([DIRECT]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(urls()).toEqual([DIRECT, RELAY]);
    expect(kept().via).toBe('site');
    jest.advanceTimersByTime(19_999);
    await flush();
    expect([settled, urls()]).toEqual([false, [DIRECT, RELAY]]);
    jest.advanceTimersByTime(1);
    await flush();
    // Two attempts and no usable answer: the call fails as unanswered, as it did before the site route existed.
    expect(settled).toBe(true);
    expect(await out).toMatchObject({ code: 'SOL_RPC', unanswered: true });
    expect(urls()).toEqual([DIRECT, RELAY]);
  });

  it('a rate limit, a server error or an unreadable body is an answer: tried direct again, never the site, the route unchanged', async () => {
    for (const way of [429, 503, 'garbage']) {
      const net = network({ [DIRECT]: way });
      const { send } = freshApp();
      await expect(send.solanaRpc(...BALANCE)).rejects.toMatchObject({ code: 'SOL_RPC', unanswered: true });
      expect([way, net.calls.map((c) => c.url)]).toEqual([way, [DIRECT, DIRECT]]);
      await flush();
      expect([way, routeWrites()]).toEqual([way, 0]);
    }
    const net = network({ [DIRECT]: [429, 'answer'] });
    await expect(freshApp().send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
    expect(net.calls.map((c) => c.url)).toEqual([DIRECT, DIRECT]);
    // An error the endpoint answered is its refusal: thrown at once, the direct way kept.
    network({ [DIRECT]: reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } }) });
    await expect(freshApp().send.solanaRpc(...BALANCE)).rejects.toMatchObject({ rpcError: true, rpcCode: -32005, afterUnanswered: false });
    await flush();
    expect(routeWrites()).toBe(0);
  });

  it('a fresh JS run takes the kept route: the site first, with no direct wait', async () => {
    network({ [DIRECT]: 'reject' });
    await freshApp().send.solanaRpc(...BALANCE);
    await flush();
    const net = network({ [DIRECT]: 'hang' });
    const { send } = freshApp();
    await expect(send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
    expect(net.calls.map((c) => c.url)).toEqual([RELAY]);
  });

  it('the endpoint answering a call that went to it before another got no answer brings the calls back at once', async () => {
    const net = network({ [DIRECT]: (req) => (req.method === 'getBlockHeight' ? 'held' : 'reject') });
    const { send } = freshApp();
    const first = send.solanaRpc('getBlockHeight', [{ commitment: 'confirmed' }]);
    await flush();
    await expect(send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
    expect(net.calls.map((c) => [c.url, c.method])).toEqual([[DIRECT, 'getBlockHeight'], [DIRECT, 'getBalance'], [RELAY, 'getBalance']]);
    await flush();
    expect(kept().via).toBe('site');
    net.held[0].resolve(result(901));
    await expect(first).resolves.toBe(901);
    await flush();
    expect(kept()).toEqual({ v: 1, via: 'direct', probeAt: 0 });
    expect(routeLogs()).toEqual(['[INFO][SOLANA] route_changed via=site reason=no_answer', '[INFO][SOLANA] route_changed via=direct reason=answered']);
    net.ways[DIRECT] = 'answer';
    net.calls.length = 0;
    await send.solanaRpc(...BALANCE);
    expect(net.calls.map((c) => c.url)).toEqual([DIRECT]);
  });

  it('on the site route a network change runs a direct getBlockHeight beside the call, never waited for; its answer sends the next call direct', async () => {
    keep({ v: 1, via: 'site', probeAt: Date.now() - 1000 });
    const net = network({ [DIRECT]: 'held' });
    const app = freshApp();
    app.rn.NativeModules.QNetNetwork = { addListener: jest.fn(), removeListeners: jest.fn() };
    const stop = app.wake.watchWakes();
    try {
      await app.send.solanaRpc(...BALANCE);
      expect(net.calls.map((c) => c.url)).toEqual([RELAY]); // nothing due yet
      app.rn.DeviceEventEmitter.emit(app.wake.NETWORK_BACK_EVENT);
      net.calls.length = 0;
      await expect(app.send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
      // The call came back through the site while the direct try is still out.
      expect(net.calls.map((c) => [c.url, c.method, c.params])).toEqual([
        [DIRECT, 'getBlockHeight', [{ commitment: 'confirmed' }]], [RELAY, ...BALANCE],
      ]);
      expect(net.held).toHaveLength(1);
      // One try at a time.
      await app.send.solanaRpc(...BALANCE);
      expect(net.calls.filter((c) => c.url === DIRECT)).toHaveLength(1);
      net.ways[DIRECT] = 'answer';
      net.held[0].resolve(result(901));
      await flush();
      expect(kept()).toEqual({ v: 1, via: 'direct', probeAt: 0 });
      expect(routeLogs()).toEqual(['[INFO][SOLANA] route_changed via=direct reason=probe_answered']);
      net.calls.length = 0;
      await app.send.solanaRpc(...BALANCE);
      expect(net.calls.map((c) => c.url)).toEqual([DIRECT]);
    } finally {
      stop();
      delete app.rn.NativeModules.QNetNetwork;
    }
  });

  it('on the site route a site attempt with no usable answer is followed by one at the endpoint, whose answer brings the calls back', async () => {
    for (const way of [404, 503, 'garbage', 'reject']) {
      await mockStorage.clear();
      keep({ v: 1, via: 'site', probeAt: Date.now() });
      const net = network({ [RELAY]: way });
      const { send } = freshApp();
      info.mockClear();
      await expect(send.solanaRpc(...BALANCE)).resolves.toEqual(RESULTS.getBalance);
      expect([way, net.calls.map((c) => c.url)]).toEqual([way, [RELAY, DIRECT]]);
      expect(net.calls[1].body).toBe(net.calls[0].body);
      await flush();
      expect([way, kept()]).toEqual([way, { v: 1, via: 'direct', probeAt: 0 }]);
      expect(routeLogs()).toEqual(['[INFO][SOLANA] route_changed via=direct reason=answered']);
      net.calls.length = 0;
      await send.solanaRpc(...BALANCE);
      expect([way, net.calls.map((c) => c.url)]).toEqual([way, [DIRECT]]);
    }
  });

  it('the endpoint asked after the site is the one the calls use; only a direct attempt after a direct one takes the next', async () => {
    const NEXT = 'https://next-endpoint.example';
    keep({ v: 1, via: 'site', probeAt: Date.now() });
    const net = network({ [RELAY]: 404, [NEXT]: 'answer' });
    const app = freshApp({ nodes: '../src/config/nodes' });
    app.nodes.SOLANA_RPC_ENDPOINTS.push(NEXT);
    await app.send.solanaRpc(...BALANCE);
    expect(net.calls.map((c) => c.url)).toEqual([RELAY, DIRECT]);
    net.ways[DIRECT] = 429;
    net.calls.length = 0;
    await app.send.solanaRpc(...BALANCE);
    expect(net.calls.map((c) => c.url)).toEqual([DIRECT, NEXT]);
  });

  it('neither way answering keeps the site route, dated by the endpoint\'s try', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const T0 = 1_800_000_000_000;
    jest.setSystemTime(T0);
    keep({ v: 1, via: 'site', probeAt: T0 - 60_000 });
    const net = network({ [RELAY]: 404, [DIRECT]: 'reject' });
    const { send } = freshApp();
    await expect(send.solanaRpc(...BALANCE)).rejects.toMatchObject({ code: 'SOL_RPC', unanswered: true });
    expect(net.calls.map((c) => c.url)).toEqual([RELAY, DIRECT]);
    await flush();
    expect(kept()).toEqual({ v: 1, via: 'site', probeAt: T0 });
    expect(routeLogs()).toEqual([]);
  });

  it('a direct try with no answer keeps the site route from that moment, and the next one comes 300 s later', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const T0 = 1_800_000_000_000;
    jest.setSystemTime(T0);
    keep({ v: 1, via: 'site', probeAt: T0 - 300_000 });
    const net = network({ [DIRECT]: 'reject' });
    const { send } = freshApp();
    const call = async () => {
      net.calls.length = 0;
      await send.solanaRpc(...BALANCE);
      await flush();
      return net.calls.map((c) => [c.url, c.method]);
    };
    const probed = [[DIRECT, 'getBlockHeight'], [RELAY, 'getBalance']];
    expect(await call()).toEqual(probed);
    expect(kept()).toEqual({ v: 1, via: 'site', probeAt: T0 });
    jest.advanceTimersByTime(299_999);
    expect(await call()).toEqual([[RELAY, 'getBalance']]);
    jest.advanceTimersByTime(1);
    expect(await call()).toEqual(probed);
    expect(kept()).toEqual({ v: 1, via: 'site', probeAt: T0 + 300_000 });
    // A direct try the endpoint answers with no block height keeps the site route as well.
    jest.advanceTimersByTime(300_000);
    net.ways[DIRECT] = 429;
    expect(await call()).toEqual(probed);
    expect(kept()).toEqual({ v: 1, via: 'site', probeAt: T0 + 600_000 });
    expect(routeLogs()).toEqual([]);
  });

  it('a send the endpoint gave no answer goes to the site as the same signed bytes, and one the site gave no usable answer to the endpoint; a refusal after it is unknown, never signed again', async () => {
    const sender = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
    const from = base58Encode(sender.publicKey);
    const to = base58Encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2)).publicKey);
    const sign = jest.fn(async (message) => nacl.sign.detached(message, sender.secretKey));
    const quote = { symbol: 'SOL', mint: null, decimals: 9, from, to, amountBase: '1000000', references: [], memo: null };
    const gone = reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound' } } });
    let net = network({
      [DIRECT]: (req) => (req.method === 'sendTransaction' ? 'reject' : 'answer'),
      [RELAY]: (req) => (req.method === 'sendTransaction' ? gone : 'answer'),
    });
    let r = await freshApp().send.submitSolanaSend(quote, sign);
    expect(r).toMatchObject({ status: 'unknown', lastValidBlockHeight: 1000 });
    expect(sign).toHaveBeenCalledTimes(1);
    const sends = net.calls.filter((c) => c.method === 'sendTransaction');
    expect(sends.map((c) => c.url)).toEqual([DIRECT, RELAY]);
    expect(sends[1].body).toBe(sends[0].body);
    expect(sends[1].params[1]).toEqual({ encoding: 'base64', preflightCommitment: 'confirmed' });
    expect(r.signature).toBe(base58Encode(Buffer.from(sends[0].params[0], 'base64').subarray(1, 65)));
    // The site taking it is a send on its way.
    await mockStorage.clear();
    sign.mockClear();
    net = network({ [DIRECT]: (req) => (req.method === 'sendTransaction' ? 'reject' : 'answer') });
    r = await freshApp().send.submitSolanaSend(quote, sign);
    expect(r).toMatchObject({ status: 'pending' });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(net.calls.filter((c) => c.method === 'sendTransaction').map((c) => c.url)).toEqual([DIRECT, RELAY]);
    // On the site route a site with no usable answer passes the send on to the endpoint, the same signed bytes.
    await mockStorage.clear();
    sign.mockClear();
    keep({ v: 1, via: 'site', probeAt: Date.now() });
    net = network({ [RELAY]: (req) => (req.method === 'sendTransaction' ? 503 : 'answer') });
    r = await freshApp().send.submitSolanaSend(quote, sign);
    expect(r).toMatchObject({ status: 'pending' });
    expect(sign).toHaveBeenCalledTimes(1);
    const passed = net.calls.filter((c) => c.method === 'sendTransaction');
    expect(passed.map((c) => c.url)).toEqual([RELAY, DIRECT]);
    expect(passed[1].body).toBe(passed[0].body);
  });

  it('the SOL figure on Assets reads through the same client (WalletManager.getBalance), so it falls back too', async () => {
    const net = network({ [DIRECT]: 'reject' });
    const { WalletManager } = freshApp({ wm: '../src/components/WalletManager' }).wm;
    const wm = new WalletManager();
    await expect(wm.getBalance(OWNER)).resolves.toBe(1.5);
    expect(net.calls.map((c) => [c.url, c.method, c.params])).toEqual([[DIRECT, ...BALANCE], [RELAY, ...BALANCE]]);
    // Neither way answering is no figure (the last one stays), never 0.
    network({ [DIRECT]: 'reject', [RELAY]: 'reject' });
    await expect(wm.getBalance(OWNER)).resolves.toBe(null);
    // The route is this device's network, no wallet's: a wallet switch keeps it, erasing the app's data removes it.
    expect(WalletManager.WALLET_SCOPED_KEYS).not.toContain(ROUTE_KEY);
    expect(WalletManager.WALLET_SCOPED_PREFIXES.some((p) => ROUTE_KEY.startsWith(p))).toBe(false);
    expect(WalletManager.ERASE_ALLOW_LIST).not.toContain(ROUTE_KEY);
  });

  it('the site sees the app\'s requests as the app\'s: its route is one of the hosts the app names its build to, the endpoint is not', () => {
    const { namesItselfTo } = require('../src/utils/clientAgent');
    expect(namesItselfTo(RELAY)).toBe(true);
    expect(namesItselfTo(DIRECT)).toBe(false);
  });
});

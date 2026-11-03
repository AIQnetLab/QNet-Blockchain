// solana.rpc's two ways (CONTRACTS.md decision 56): the build's endpoint (SOLANA.RPC_URLS), and aiqnet.io's relay
// (QNET.EXPLORER_API + SOLANA.RELAY_PATH) once a direct attempt got no answer at all: the same call at once, the route
// kept in chrome.storage.local for a restarted worker, the back-off that stays with an endpoint that answered, and the
// probe that brings the calls back. The sends and the burn through the relay are tested beside their simulated networks
// (chains-activation-solana, chains-activation-activation). Offline: fetch is replaced, and each test runs a worker of
// its own over a storage of its own.
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const core = await import('../dist/lib/qnet-core.js');
const { SOLANA, STORAGE_KEYS } = await import('../dist/background/config.js');
const { createStorageArea, until } = await import('./helpers/chrome-mock.mjs');
const {
  RELAY_URL, installFetch, solanaRoute, relayRoute, unreachableEndpoint, routes, flush, freshSolana,
} = await import('./helpers/chains-activation-env.mjs');

const MANIFEST = JSON.parse(readFileSync(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
const KEY = STORAGE_KEYS.SOLANA_ROUTE;
const ENDPOINT = SOLANA.RPC_URLS[0];
const HEIGHT = [{ commitment: 'finalized' }];
const urls = (requests) => requests.map((r) => r.url);
const stored = () => globalThis.chrome.storage.local.dump()[KEY];
const keep = (route) => globalThis.chrome.storage.local.set({ [KEY]: route });
const rpcAnswer = (result) => ({ body: { jsonrpc: '2.0', id: 1, result } });

beforeEach(() => {
  globalThis.chrome = { storage: { local: createStorageArea() } };
});

describe('chains solana relay: the route', () => {
  it('a direct attempt nobody answered sends the same call to the relay at once, naming the build, and keeps that route', async () => {
    const solana = await freshSolana();
    const requests = installFetch(routes(unreachableEndpoint, relayRoute({ getBlockHeight: () => 42 })));
    const started = Date.now();
    // a back-off of 5 s would show: the relay is asked without one
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT, { backoffMs: 5000 }), 42);
    assert.ok(Date.now() - started < 2500, 'no wait before the relay');
    assert.deepEqual(urls(requests), [ENDPOINT, RELAY_URL]);
    const [direct, relayed] = requests;
    assert.equal(relayed.body, direct.body, 'the same JSON-RPC body');
    for (const option of ['method', 'credentials', 'cache', 'redirect', 'referrerPolicy']) {
      assert.equal(relayed.init[option], direct.init[option], option);
    }
    assert.equal(relayed.headers['Content-Type'], 'application/json');
    assert.equal(relayed.headers['x-qnet-client'], `QNetWallet-Extension/${MANIFEST.version}`);
    assert.equal(direct.headers['x-qnet-client'], undefined, 'the endpoint hears nothing of the build');
    await flush();
    assert.deepEqual(Object.keys(stored()).sort(), ['probeAt', 'v', 'via']);
    assert.deepEqual([stored().v, stored().via], [1, 'site']);
    assert.ok(Math.abs(stored().probeAt - Date.now()) < 5000);
    // from then on the relay only
    requests.length = 0;
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 42);
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 42);
    assert.deepEqual(urls(requests), [RELAY_URL, RELAY_URL]);
  });

  it('on the relay route a relay with no usable answer hands the same call to the endpoint at once, and its answer brings the calls back', async () => {
    const relays = [{ status: 404, body: '<!DOCTYPE html>' }, { status: 503, body: { error: 'unavailable' } },
      { status: 429, body: { error: 'rate_limited' } }, { status: 200, body: 'not json' }, null];
    for (const [i, relay] of relays.entries()) {
      globalThis.chrome = { storage: { local: createStorageArea() } };
      await keep({ v: 1, via: 'site', probeAt: Date.now() });
      const solana = await freshSolana();
      const requests = installFetch(routes((request) => {
        if (request.url !== RELAY_URL) return undefined;
        if (relay === null) throw new TypeError('connection reset');
        return relay;
      }, solanaRoute({ getBlockHeight: () => 42 })));
      const started = Date.now();
      // a back-off of 5 s would show: the endpoint is asked without one
      assert.equal(await solana.rpc('getBlockHeight', HEIGHT, { backoffMs: 5000 }), 42, `relay ${i}`);
      assert.ok(Date.now() - started < 2500, `relay ${i}: no wait before the endpoint`);
      assert.deepEqual(urls(requests), [RELAY_URL, ENDPOINT], `relay ${i}`);
      assert.equal(requests[1].body, requests[0].body, 'the same JSON-RPC body');
      assert.equal(requests[1].headers['x-qnet-client'], undefined, 'the endpoint hears nothing of the build');
      await flush();
      assert.deepEqual(stored(), { v: 1, via: 'direct', probeAt: 0 }, `relay ${i}`);
      requests.length = 0;
      assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 42);
      assert.deepEqual(urls(requests), [ENDPOINT], `relay ${i}`);
    }
  });

  it('neither way answering keeps the relay route, dated by the endpoint\'s try', async () => {
    const lastTry = Date.now() - 60_000;
    await keep({ v: 1, via: 'site', probeAt: lastTry });
    const solana = await freshSolana();
    const requests = installFetch(routes(unreachableEndpoint, (request) => (request.url === RELAY_URL ? { status: 404, body: '' } : undefined)));
    await assert.rejects(solana.rpc('getBlockHeight', HEIGHT, { backoffMs: 5 }), (error) => error.code === 'SOLANA_UNAVAILABLE');
    // each way is asked again after the other gave nothing
    assert.deepEqual(urls(requests), [RELAY_URL, ENDPOINT, RELAY_URL]);
    await flush();
    assert.equal(stored().via, 'site');
    assert.ok(stored().probeAt > lastTry, 'the endpoint\'s try is the last one kept');
  });

  it('a 429, a 5xx, an unreadable body and a retryable JSON-RPC code are answers: the endpoint again after the back-off, never the relay', async () => {
    const solana = await freshSolana();
    const answers = [{ status: 429, body: '' }, { status: 502, body: 'bad gateway' }, { status: 200, body: 'not json' },
      { body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'behind' } } }, rpcAnswer(7)];
    const at = [];
    const requests = installFetch(async () => {
      at.push(Date.now());
      return answers.shift();
    });
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT, { attempts: 5, backoffMs: 40 }), 7);
    assert.deepEqual(urls(requests), Array(5).fill(ENDPOINT));
    // 40, 80, 160 and 320 ms between the attempts
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 40 * 2 ** (i - 1) - 10, `wait ${i}: ${at[i] - at[i - 1]} ms`);
    await flush();
    assert.equal(stored(), undefined, 'the route never moved, so nothing was written');
  });

  it('the endpoint answering a call sent before another got no answer brings the calls back at once', async () => {
    const solana = await freshSolana();
    let answerHeld;
    const held = new Promise((resolve) => {
      answerHeld = resolve;
    });
    const requests = installFetch(async (request) => {
      if (request.url === RELAY_URL) return rpcAnswer('relayed');
      if (JSON.parse(request.body).method === 'getSlot') {
        await held;
        return rpcAnswer('direct');
      }
      throw new TypeError('connection reset');
    });
    const first = solana.rpc('getSlot', []);
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 'relayed');
    assert.equal(stored().via, 'site');
    answerHeld();
    assert.equal(await first, 'direct');
    await flush();
    assert.deepEqual(stored(), { v: 1, via: 'direct', probeAt: 0 });
    requests.length = 0;
    assert.equal(await solana.rpc('getSlot', []), 'direct');
    assert.deepEqual(urls(requests), [ENDPOINT]);
  });

  it('a restarted worker takes the kept route, with no wait on the endpoint; anything malformed there is the direct route', async () => {
    const network = () => installFetch(routes(solanaRoute({ getBlockHeight: () => 'direct' }), relayRoute({ getBlockHeight: () => 'relayed' })));
    await keep({ v: 1, via: 'site', probeAt: Date.now() });
    let requests = network();
    assert.equal(await (await freshSolana()).rpc('getBlockHeight', HEIGHT), 'relayed');
    assert.deepEqual(urls(requests), [RELAY_URL]);
    for (const junk of [{ v: 1, via: 'site' }, { v: 2, via: 'site', probeAt: 1 }, { v: 1, via: 'relay', probeAt: 1 },
      { v: 1, via: 'site', probeAt: -1 }, { v: 1, via: 'site', probeAt: 1, extra: true }, 'site', [1], null]) {
      await keep(junk);
      requests = network();
      assert.equal(await (await freshSolana()).rpc('getBlockHeight', HEIGHT), 'direct', JSON.stringify(junk));
      assert.deepEqual(urls(requests), [ENDPOINT]);
    }
  });

  it('with no storage the route lives in the worker alone', async () => {
    delete globalThis.chrome;
    const solana = await freshSolana();
    const requests = installFetch(routes(unreachableEndpoint, relayRoute({ getBlockHeight: () => 9 })));
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 9);
    assert.equal(await solana.rpc('getBlockHeight', HEIGHT), 9);
    assert.deepEqual(urls(requests), [ENDPOINT, RELAY_URL, RELAY_URL]);
  });
});

describe('chains solana relay: the probe of the endpoint', () => {
  it('on the relay route a direct getBlockHeight runs beside a call once 300 s passed, its time kept first; its number brings the calls back', async () => {
    const lastTry = Date.now() - core.SOLANA_DIRECT_RETRY_MS;
    await keep({ v: 1, via: 'site', probeAt: lastTry });
    const solana = await freshSolana();
    let answerProbe;
    const held = new Promise((resolve) => {
      answerProbe = resolve;
    });
    const probes = [];
    const requests = installFetch(routes(solanaRoute({
      getBlockHeight: async ([query]) => {
        probes.push({ query, kept: stored() });
        await held;
        return 100;
      },
      getSlot: () => 'direct',
    }), relayRoute({ getSlot: () => 'relayed' })));
    // the call does not wait for the probe, which the endpoint holds
    assert.equal(await solana.rpc('getSlot', []), 'relayed');
    await until(() => probes.length === 1);
    assert.deepEqual(probes[0].query, { commitment: 'confirmed' });
    assert.equal(probes[0].kept.via, 'site');
    assert.ok(probes[0].kept.probeAt > lastTry, 'the probe\'s time was kept before it went out');
    // neither a worker started meanwhile nor this one probes again while it runs
    assert.equal(await (await freshSolana()).rpc('getSlot', []), 'relayed');
    assert.equal(await solana.rpc('getSlot', []), 'relayed');
    assert.equal(probes.length, 1);
    answerProbe();
    await until(() => stored()?.via === 'direct');
    assert.deepEqual(stored(), { v: 1, via: 'direct', probeAt: 0 });
    requests.length = 0;
    assert.equal(await solana.rpc('getSlot', []), 'direct');
    assert.deepEqual(urls(requests), [ENDPOINT]);
  });

  it('a probe with no answer, a refusal or no number keeps the relay route, and the next one waits another 300 s', async () => {
    const endpoints = [
      unreachableEndpoint,
      (request) => (request.url === ENDPOINT ? { status: 429, body: '' } : undefined),
      solanaRoute({ getBlockHeight: () => ({ rpcError: { code: -32005, message: 'behind' } }) }),
      solanaRoute({ getBlockHeight: () => 'tall' }),
    ];
    for (const [i, endpoint] of endpoints.entries()) {
      globalThis.chrome = { storage: { local: createStorageArea() } };
      await keep({ v: 1, via: 'site', probeAt: Date.now() - core.SOLANA_DIRECT_RETRY_MS - 1 });
      const solana = await freshSolana();
      const requests = installFetch(routes(endpoint, relayRoute({ getSlot: () => 'relayed' })));
      const before = Date.now();
      assert.equal(await solana.rpc('getSlot', []), 'relayed');
      await until(() => requests.some((r) => r.url === ENDPOINT));
      await flush();
      for (let call = 0; call < 3; call++) assert.equal(await solana.rpc('getSlot', []), 'relayed');
      assert.equal(requests.filter((r) => r.url === ENDPOINT).length, 1, `endpoint ${i}: one probe`);
      assert.equal(stored().via, 'site', `endpoint ${i}`);
      assert.ok(stored().probeAt >= before, `endpoint ${i}`);
    }
  });
});

// The two content scripts in a DOM-less window (spec: dApp provider protocol; EXT-11, SITE-01): the MAIN
// world provider (frozen, provider announcement, request and events) and the isolated relay
// (same-window/same-origin filter, exact forwarding, duplicate ids, 4900 on disconnect), then both joined
// to the real router and provider state machine.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../dist/lib/qnet-core.js';
import { ERROR_MESSAGES } from '../dist/background/errors.js';
import { createEvent, until } from './helpers/chrome-mock.mjs';
import { ACCOUNTS, SITE, createWorld, joinedPorts, settleAll } from './helpers/provider-harness.mjs';

const RELAY = await readFile(new URL('../dist/content/relay.js', import.meta.url), 'utf8');
const INJECT = await readFile(new URL('../dist/inject/provider.js', import.meta.url), 'utf8');

/**
 * A page window both worlds share. postMessage structured-clones and delivers asynchronously to every
 * 'message' listener with source = this window and the page origin, as the browser does.
 */
function createPageWindow(origin = SITE) {
  const listeners = new Map();
  const win = {
    location: { origin, href: `${origin}/dapp` },
    posted: [],
    dispatched: [],
    reported: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      win.dispatched.push(event);
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
      return true;
    },
    postMessage(data, targetOrigin) {
      const copy = structuredClone(data);
      win.posted.push({ data: copy, targetOrigin });
      if (targetOrigin !== origin && targetOrigin !== '*') return;
      setImmediate(() => win.deliver({ source: win, origin, data: structuredClone(copy) }));
    },
    deliver(event) {
      for (const fn of [...(listeners.get('message') ?? [])]) fn(event);
    },
    reportError(error) {
      win.reported.push(error);
    },
  };
  return win;
}

function runRelay(win, chrome) {
  vm.runInContext(RELAY, vm.createContext({ window: win, chrome }), { filename: 'content/relay.js' });
}

// What the relay reads of chrome.runtime besides connect: this extension's id and URLs, and the tab messages the worker
// sends (chrome.tabs.sendMessage, EXT-F3).
const EXTENSION = 'lmnopabcdefghijklmnopabcdefghijk';
const runtimeBase = () => ({
  id: EXTENSION,
  getURL: (path) => `chrome-extension://${EXTENSION}/${path}`,
  onMessage: createEvent(),
});
const WORKER_SENDER = Object.freeze({ id: EXTENSION, url: `chrome-extension://${EXTENSION}/background/sw.js`, origin: `chrome-extension://${EXTENSION}` });

function runProvider(win) {
  const context = vm.createContext({ window: win, crypto: globalThis.crypto, CustomEvent: globalThis.CustomEvent });
  vm.runInContext(INJECT, context, { filename: 'inject/provider.js' });
  return context;
}

// chrome.runtime.connect for the relay: records ports; the test answers and closes them.
function relayChrome() {
  const ports = [];
  const chrome = {
    runtime: {
      ...runtimeBase(),
      lastError: undefined,
      connect({ name }) {
        const port = {
          name,
          sent: [],
          connected: true,
          onMessage: createEvent(),
          onDisconnect: createEvent(),
          postMessage(message) {
            if (!port.connected) throw new Error('Attempting to use a disconnected port object');
            port.sent.push(JSON.parse(JSON.stringify(message)));
          },
          disconnect() {
            port.connected = false;
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  const answer = (port, message) => port.onMessage.dispatch(JSON.parse(JSON.stringify(message)), port);
  const close = (port) => {
    port.connected = false;
    port.onDisconnect.dispatch(port);
  };
  return { chrome, ports, answer, close };
}

const toPage = (win) => win.posted.filter((p) => p.data.target === 'qnet-provider');
// Objects built inside the page world have that realm's prototypes; compare their JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const fromPage = (win, data, overrides = {}) => win.deliver({ source: win, origin: win.location.origin, data, ...overrides });

describe('relay (isolated world)', () => {
  it('connects lazily and forwards exactly {id, method, params}', async () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    assert.equal(rt.ports.length, 0, 'no port before the first request');
    fromPage(win, { target: 'qnet-relay', id: 'r1', method: 'qnet_signMessage', params: { message: 'hi' } });
    fromPage(win, { target: 'qnet-relay', id: 7, method: 'qnet_chainId' });
    assert.equal(rt.ports.length, 1);
    assert.equal(rt.ports[0].name, 'qnet-provider');
    assert.deepEqual(rt.ports[0].sent, [
      { id: 'r1', method: 'qnet_signMessage', params: { message: 'hi' } },
      { id: 7, method: 'qnet_chainId' },
    ]);
  });

  it('ignores other windows, other origins, foreign shapes, extra keys and oversize requests', () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    const ok = { target: 'qnet-relay', id: 'a', method: 'qnet_accounts' };
    fromPage(win, ok, { source: {} });
    fromPage(win, ok, { source: null });
    fromPage(win, ok, { origin: 'https://evil.example' });
    fromPage(win, ok, { origin: 'null' });
    for (const data of [
      null, 'qnet_accounts', [ok], { ...ok, target: 'qnet-provider' }, { ...ok, target: undefined },
      { ...ok, origin: 'https://aiqnet.io' }, { ...ok, sender: { url: SITE } }, { ...ok, id: 'has space' },
      { ...ok, id: -1 }, { ...ok, id: 1.5 }, { ...ok, id: 'x'.repeat(65) }, { ...ok, id: undefined },
      { ...ok, method: 7 }, { ...ok, method: undefined },
      { ...ok, method: 'qnet_signMessage', params: { message: 'x'.repeat(16384) } },
      Object.assign(Object.create({ inherited: true }), ok),
    ]) {
      fromPage(win, data);
    }
    assert.equal(rt.ports.length, 0);
    assert.equal(win.posted.length, 0, 'nothing is answered either');
  });

  it('drops a request whose id is still pending, and accepts it again once answered', () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    fromPage(win, { target: 'qnet-relay', id: 'dup', method: 'qnet_requestAccounts' });
    fromPage(win, { target: 'qnet-relay', id: 'dup', method: 'qnet_signMessage', params: { message: 'hijack' } });
    const [port] = rt.ports;
    assert.deepEqual(port.sent, [{ id: 'dup', method: 'qnet_requestAccounts' }]);
    rt.answer(port, { id: 'dup', ok: true, result: {} });
    fromPage(win, { target: 'qnet-relay', id: 'dup', method: 'qnet_accounts' });
    assert.equal(port.sent.length, 2);
    fromPage(win, { target: 'qnet-relay', id: 1, method: 'qnet_chainId' });
    fromPage(win, { target: 'qnet-relay', id: '1', method: 'qnet_chainId' });
    assert.equal(port.sent.length, 4, 'number and string ids are different ids');
  });

  it('posts answers and events to the page origin only, and drops unknown ids and events', () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    fromPage(win, { target: 'qnet-relay', id: 'a', method: 'qnet_accounts' });
    fromPage(win, { target: 'qnet-relay', id: 'b', method: 'qnet_signMessage', params: { message: 'x' } });
    fromPage(win, { target: 'qnet-relay', id: 'c', method: 'qnet_chainId' });
    const [port] = rt.ports;
    rt.answer(port, { id: 'a', ok: true, result: ACCOUNTS });
    rt.answer(port, { id: 'b', ok: false, error: { code: 4100, message: 'Unauthorized' } });
    rt.answer(port, { id: 'c', ok: 'maybe' });
    rt.answer(port, { id: 'zzz', ok: true, result: 1 });
    rt.answer(port, { id: 'a', ok: true, result: 'second answer' });
    rt.answer(port, { event: 'accountsChanged', data: {} });
    rt.answer(port, { event: 'disconnect', data: { code: 4900, message: 'Disconnected' } });
    rt.answer(port, { event: 'chainChanged', data: 'q1' });
    assert.ok(win.posted.every((p) => p.targetOrigin === SITE), 'never "*"');
    assert.deepEqual(toPage(win).map((p) => p.data), [
      { target: 'qnet-provider', id: 'a', ok: true, result: ACCOUNTS },
      { target: 'qnet-provider', id: 'b', ok: false, error: { code: 4100, message: 'Unauthorized' } },
      { target: 'qnet-provider', id: 'c', ok: false, error: { code: -32603, message: 'Internal error' } },
      { target: 'qnet-provider', event: 'accountsChanged', data: {} },
      { target: 'qnet-provider', event: 'disconnect', data: { code: 4900, message: 'Disconnected' } },
    ]);
  });

  it('answers every pending request 4900 when the port closes, then reconnects on the next request', () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    fromPage(win, { target: 'qnet-relay', id: 'p1', method: 'qnet_requestAccounts' });
    fromPage(win, { target: 'qnet-relay', id: 'p2', method: 'qnet_accounts' });
    const [first] = rt.ports;
    rt.answer(first, { id: 'p2', ok: true, result: {} });
    rt.close(first);
    assert.deepEqual(toPage(win).map((p) => p.data), [
      { target: 'qnet-provider', id: 'p2', ok: true, result: {} },
      { target: 'qnet-provider', id: 'p1', ok: false, error: { code: 4900, message: 'Disconnected' } },
    ]);
    fromPage(win, { target: 'qnet-relay', id: 'p1', method: 'qnet_accounts' });
    assert.equal(rt.ports.length, 2);
    assert.deepEqual(rt.ports[1].sent, [{ id: 'p1', method: 'qnet_accounts' }]);
    rt.answer(first, { id: 'p1', ok: true, result: 'from the dead port' });
    assert.equal(toPage(win).length, 2, 'an answer on another port does not settle the new request');
  });

  it('passes error data only as the one shape the worker sends: UNSUPPORTED_PARAM on a -32602', () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) fromPage(win, { target: 'qnet-relay', id, method: 'qnet_sendTransaction', params: { type: 'contractCall' } });
    const [port] = rt.ports;
    const data = { reason: 'UNSUPPORTED_PARAM' };
    const text = 'Unsupported parameter';
    rt.answer(port, { id: 'a', ok: false, error: { code: -32602, message: text, data } });
    rt.answer(port, { id: 'b', ok: false, error: { code: -32602, message: text, data: { reason: 'OTHER' } } });
    rt.answer(port, { id: 'c', ok: false, error: { code: -32602, message: text, data: { ...data, field: 'value' } } });
    rt.answer(port, { id: 'd', ok: false, error: { code: -32603, message: 'Internal error', data } });
    rt.answer(port, { id: 'e', ok: false, error: { code: -32602, message: 'Invalid params', data: 'UNSUPPORTED_PARAM' } });
    assert.deepEqual(toPage(win).map((p) => p.data.error), [
      { code: -32602, message: text, data },
      { code: -32602, message: text },
      { code: -32602, message: text },
      { code: -32603, message: 'Internal error' },
      { code: -32602, message: 'Invalid params' },
    ]);
  });

  // EXT-F3: after an idle worker closed its port, an event reaches the page through the tab; only this extension's worker
  // may send one, and only an event of the list.
  it('forwards an event the worker sends through the tab, from this extension\'s worker only', async () => {
    const win = createPageWindow();
    const rt = relayChrome();
    runRelay(win, rt.chrome);
    const tab = (message, sender = WORKER_SENDER) => rt.chrome.runtime.onMessage.dispatch(JSON.parse(JSON.stringify(message)), sender, () => {});
    const accounts = { qnet: core.KAT.qnetAddress, solana: core.KAT.solanaAddress };
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: accounts });
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'disconnect', data: { code: 4900, message: 'Disconnected' } });
    // another extension, a content script in a tab, another page of this extension, another tag or event: dropped
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: {} }, { ...WORKER_SENDER, id: 'ponmlkjihgfedcbaponmlkjihgfedcba' });
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: {} }, { ...WORKER_SENDER, tab: { id: 3 } });
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: {} }, { ...WORKER_SENDER, url: `chrome-extension://${EXTENSION}/ui/popup.html` });
    tab({ target: 'qnet-provider', origin: SITE, event: 'accountsChanged', data: {} });
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'chainChanged', data: {} });
    // an event for another origin (the tab navigated after the worker looked it up), or for none: dropped
    tab({ target: 'qnet-provider-event', origin: 'https://games.aiqnet.io', event: 'accountsChanged', data: accounts });
    tab({ target: 'qnet-provider-event', event: 'accountsChanged', data: accounts });
    tab({ target: 'qnet-provider-event', origin: SITE, event: 'accountsChanged', data: {}, extra: 1, id: 'x' });
    tab(null);
    await settleAll();
    assert.deepEqual(toPage(win).map((p) => plain(p.data)), [
      { target: 'qnet-provider', event: 'accountsChanged', data: accounts },
      { target: 'qnet-provider', event: 'disconnect', data: { code: 4900, message: 'Disconnected' } },
      { target: 'qnet-provider', event: 'accountsChanged', data: {} },
    ]);
    assert.ok(toPage(win).every((p) => p.targetOrigin === SITE), 'posted to the page origin only');
    assert.equal(rt.ports.length, 0, 'a tab event opens no port');
  });

  it('answers 4900 when the extension cannot be reached', () => {
    const win = createPageWindow();
    const chrome = { runtime: { ...runtimeBase(), connect: () => { throw new Error('Extension context invalidated.'); } } };
    runRelay(win, chrome);
    fromPage(win, { target: 'qnet-relay', id: 'x', method: 'qnet_accounts' });
    assert.deepEqual(toPage(win).map((p) => p.data), [
      { target: 'qnet-provider', id: 'x', ok: false, error: { code: 4900, message: 'Disconnected' } },
    ]);
  });
});

describe('provider (MAIN world)', () => {
  it('announces a frozen provider and defines window.qnet read-only', () => {
    const win = createPageWindow();
    runProvider(win);
    assert.equal(win.dispatched.length, 1);
    const [event] = win.dispatched;
    assert.equal(event.type, 'qnet:announceProvider');
    const { detail } = event;
    assert.ok(Object.isFrozen(detail) && Object.isFrozen(detail.info) && Object.isFrozen(detail.provider));
    assert.deepEqual(Object.keys(detail.info).sort(), ['channel', 'icon', 'name', 'rdns', 'uuid']);
    assert.equal(detail.info.channel, 'extension');
    assert.match(detail.info.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(detail.info.name, 'QNet Wallet');
    assert.equal(detail.info.rdns, 'io.aiqnet.wallet');
    assert.match(detail.info.icon, /^data:image\/svg\+xml;base64,/);
    const { provider } = detail;
    assert.deepEqual(Object.keys(provider).sort(), ['isQNet', 'on', 'removeListener', 'request']);
    assert.equal(provider.isQNet, true);
    assert.equal(win.qnet, provider);
    const descriptor = Object.getOwnPropertyDescriptor(win, 'qnet');
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.throws(() => { provider.request = () => 'stolen'; }, TypeError);
    assert.throws(() => { win.qnet = {}; }, TypeError);
  });

  it('answers every qnet:requestProvider with the same announcement', () => {
    const win = createPageWindow();
    runProvider(win);
    win.dispatchEvent(new CustomEvent('qnet:requestProvider'));
    win.dispatchEvent(new CustomEvent('qnet:requestProvider'));
    const announcements = win.dispatched.filter((e) => e.type === 'qnet:announceProvider');
    assert.equal(announcements.length, 3);
    assert.ok(announcements.every((e) => e.detail === announcements[0].detail));
  });

  it('still announces when window.qnet is already taken', () => {
    const win = createPageWindow();
    Object.defineProperty(win, 'qnet', { value: { impostor: true }, writable: false, configurable: false });
    runProvider(win);
    assert.equal(win.qnet.impostor, true);
    assert.equal(win.dispatched[0].detail.provider.isQNet, true);
  });

  it('request posts to the relay on the page origin and settles only on its own answer', async () => {
    const win = createPageWindow();
    runProvider(win);
    const { provider } = win.dispatched[0].detail;
    const outcome = [];
    provider.request({ method: 'qnet_accounts' }).then((r) => outcome.push(['ok', r]), (e) => outcome.push(['err', e]));
    provider.request({ method: 'qnet_signMessage', params: { message: 'x' } })
      .then((r) => outcome.push(['ok2', r]), (e) => outcome.push(['err2', e.code, e.message]));
    const [first, second] = win.posted;
    assert.equal(first.targetOrigin, SITE);
    assert.deepEqual(Object.keys(first.data).sort(), ['id', 'method', 'target']);
    assert.equal(first.data.target, 'qnet-relay');
    assert.equal(first.data.method, 'qnet_accounts');
    assert.deepEqual(second.data.params, { message: 'x' });
    const answer = { target: 'qnet-provider', id: first.data.id, ok: true, result: ACCOUNTS };
    fromPage(win, { ...answer, result: 'forged' }, { source: {} });
    fromPage(win, { ...answer, result: 'forged' }, { origin: 'https://evil.example' });
    fromPage(win, { ...answer, target: 'qnet-relay' });
    await settleAll();
    assert.deepEqual(outcome, []);
    fromPage(win, answer);
    fromPage(win, { target: 'qnet-provider', id: second.data.id, ok: false, error: { code: 4100, message: 'anything' } });
    await settleAll();
    assert.deepEqual(outcome[0], ['ok', ACCOUNTS]);
    assert.deepEqual(outcome[1], ['err2', 4100, 'Unauthorized']);
  });

  it('rejects malformed requests locally with -32602 and maps unknown error codes to -32603', async () => {
    const win = createPageWindow();
    runProvider(win);
    const { provider } = win.dispatched[0].detail;
    const invalid = [
      undefined, null, 'qnet_accounts', [], {}, { method: 7 }, { method: '' },
      { method: 'qnet_signMessage', params: { message: () => 1 } },
      { method: 'qnet_signMessage', params: { message: 'x'.repeat(16384) } },
      { method: 'qnet_signMessage', params: { big: 10n } },
    ];
    for (const args of invalid) {
      await assert.rejects(provider.request(args), (error) => error.code === -32602 && error.message === 'Invalid params');
    }
    assert.equal(win.posted.length, 0);
    const pending = provider.request({ method: 'qnet_chainId' });
    fromPage(win, { target: 'qnet-provider', id: win.posted[0].data.id, ok: false, error: { code: 1234, message: 'custom' } });
    await assert.rejects(pending, (error) => error.code === -32603 && error.message === 'Internal error');
  });

  it('a 4001 keeps its own text, except the fixed approval-cooldown text', async () => {
    const win = createPageWindow();
    runProvider(win);
    const { provider } = win.dispatched[0].detail;
    const cooldown = ERROR_MESSAGES.APPROVAL_COOLDOWN;
    const cases = [
      [{ code: 4001, message: cooldown }, 4001, cooldown],
      [{ code: 4001, message: 'Click here: evil.example' }, 4001, 'User rejected the request'],
      [{ code: 4100, message: cooldown }, 4100, 'Unauthorized'],
      [{ code: 4001 }, 4001, 'User rejected the request'],
    ];
    for (const [error, code, message] of cases) {
      const pending = provider.request({ method: 'qnet_requestAccounts' });
      fromPage(win, { target: 'qnet-provider', id: win.posted.at(-1).data.id, ok: false, error });
      await assert.rejects(pending, (e) => e.code === code && e.message === message, JSON.stringify(error));
    }
  });

  it('a -32602 for a contract call field the network does not accept has its own text and frozen data; nothing else does', async () => {
    const win = createPageWindow();
    runProvider(win);
    const { provider } = win.dispatched[0].detail;
    const unsupported = { reason: 'UNSUPPORTED_PARAM' };
    const cases = [
      [{ code: -32602, message: 'x', data: { reason: 'UNSUPPORTED_PARAM' } }, 'Unsupported parameter', unsupported],
      [{ code: -32602, message: 'x', data: { reason: 'UNSUPPORTED_PARAM', field: 'accessList' } }, 'Unsupported parameter', unsupported],
      [{ code: 4001, message: 'x', data: { reason: 'UNSUPPORTED_PARAM' } }, 'User rejected the request', undefined],
      [{ code: -32602, message: 'Unsupported parameter', data: { reason: 'OTHER' } }, 'Invalid params', undefined],
      [{ code: -32602, message: 'Unsupported parameter' }, 'Invalid params', undefined],
    ];
    for (const [error, message, data] of cases) {
      const pending = provider.request({ method: 'qnet_sendTransaction', params: { type: 'contractCall' } });
      fromPage(win, { target: 'qnet-provider', id: win.posted.at(-1).data.id, ok: false, error });
      await assert.rejects(pending, (e) => {
        assert.equal(e.message, message, JSON.stringify(error));
        assert.deepEqual(e.data === undefined ? undefined : plain(e.data), data, JSON.stringify(error));
        if (data !== undefined) assert.equal(Object.isFrozen(e.data), true);
        return true;
      });
    }
  });

  it('events: only accountsChanged and disconnect, listeners isolated from each other', async () => {
    const win = createPageWindow();
    runProvider(win);
    const { provider } = win.dispatched[0].detail;
    // errors of the page world belong to its realm: compare by name
    const typeError = (error) => error.name === 'TypeError';
    assert.throws(() => provider.on('chainChanged', () => {}), typeError);
    assert.throws(() => provider.on('accountsChanged', 'not a function'), typeError);
    assert.throws(() => provider.removeListener('message', () => {}), typeError);
    const seen = [];
    const boom = () => { throw new Error('listener bug'); };
    const keep = (data) => seen.push(['keep', data]);
    const gone = (data) => seen.push(['gone', data]);
    assert.equal(provider.on('accountsChanged', boom), provider);
    provider.on('accountsChanged', keep).on('accountsChanged', gone).on('disconnect', keep);
    assert.equal(provider.removeListener('accountsChanged', gone), provider);
    fromPage(win, { target: 'qnet-provider', event: 'accountsChanged', data: ACCOUNTS });
    fromPage(win, { target: 'qnet-provider', event: 'disconnect', data: { code: 4900, message: 'Disconnected' } });
    fromPage(win, { target: 'qnet-provider', event: 'chainChanged', data: 'x' });
    fromPage(win, { target: 'qnet-provider', event: 'accountsChanged', data: { qnet: 'forged' } }, { source: {} });
    assert.deepEqual(plain(seen), [['keep', ACCOUNTS], ['keep', { code: 4900, message: 'Disconnected' }]]);
    assert.ok(Object.isFrozen(seen[0][1]), 'one listener cannot change what the next one sees');
    assert.equal(win.reported.length, 1);
    assert.equal(win.reported[0].message, 'listener bug');
  });
});

describe('provider protocol end to end', () => {
  function page(world) {
    const win = createPageWindow(SITE);
    const joined = [];
    const chrome = {
      runtime: {
        ...runtimeBase(),
        lastError: undefined,
        connect: () => {
          const pair = joinedPorts(world, `${SITE}/dapp`);
          joined.push(pair);
          return pair.relaySide;
        },
      },
    };
    runProvider(win);
    runRelay(win, chrome);
    return { win, joined, provider: win.dispatched[0].detail.provider };
  }

  it('a page connects, signs and is told about the revoke, through relay, router and approvals', async () => {
    const world = createWorld();
    const { provider, joined } = page(world);
    assert.deepEqual(await provider.request({ method: 'qnet_chainId' }), { chainId: 'q1337', network: 'testnet' });
    assert.deepEqual(await provider.request({ method: 'qnet_accounts' }), {});
    await assert.rejects(provider.request({ method: 'other_requestAccounts' }), (e) => e.code === 4200);
    await assert.rejects(provider.request({ method: 'qnet_signMessage', params: { message: 'hi' } }), (e) => e.code === 4100);

    const changes = [];
    provider.on('accountsChanged', (data) => changes.push(data));
    provider.on('disconnect', (data) => changes.push(['disconnect', data.code]));
    const connecting = provider.request({ method: 'qnet_requestAccounts' });
    const connect = await world.shown();
    assert.equal((await connect.get()).result.origin, SITE);
    await connect.resolve(true);
    assert.deepEqual(await connecting, ACCOUNTS);

    const message = 'Sign in to aiqnet.io\nNonce: 7';
    const signing = provider.request({ method: 'qnet_signMessage', params: { message } });
    const sign = await world.shown({ after: connect.windowId });
    await sign.resolve(true);
    const signed = await signing;
    assert.equal(signed.address, ACCOUNTS.qnet);
    assert.equal(core.verifyOffchainMessage(SITE, message, core.hexToBytes(signed.signature), core.hexToBytes(signed.publicKey)), true);

    assert.equal((await world.popup('sites.revoke', { origin: SITE })).result.revoked, true);
    await until(() => changes.length === 3);
    assert.deepEqual(plain(changes), [ACCOUNTS, {}, ['disconnect', 4900]]);
    assert.equal(joined.length, 1, 'one port for the whole page');
  });

  it('a worker restart answers the waiting request 4900 and the next request reconnects', async () => {
    const world = createWorld();
    const { provider, joined } = page(world);
    const waiting = provider.request({ method: 'qnet_requestAccounts' });
    await world.shown();
    joined[0].workerSide.crash();
    await assert.rejects(waiting, (e) => e.code === 4900 && e.message === 'Disconnected');
    assert.deepEqual(await provider.request({ method: 'qnet_chainId' }), { chainId: 'q1337', network: 'testnet' });
    assert.equal(joined.length, 2);
  });
});

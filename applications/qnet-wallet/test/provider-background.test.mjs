// dApp provider in the worker (spec: dApp provider protocol; EXT-01, MISS-01, MISS-03, R22): grants bound to
// the wallet by a MAC, one approval window at a time with per-origin caps, the eight methods through the
// real router, events, lock behaviour, revoke, and how an origin is displayed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { LIMITS, TIMINGS } from '../dist/background/config.js';
import { WalletError } from '../dist/background/errors.js';
import { displayOrigin } from '../dist/background/provider.js';
import { contentScriptSender, pageSender, until } from './helpers/chrome-mock.mjs';
import {
  ACCOUNTS, APP, GAME, SITE, SITES_KEY, TOKEN, UUID_RE, WALLET_ID, ask, createWorld, eventsOf, grantEntry, manifestWithHosts, replyTo,
  settleAll,
} from './helpers/provider-harness.mjs';

const errorCode = (reply) => {
  assert.equal(reply.ok, false, `expected an error, got ${JSON.stringify(reply)}`);
  return reply.error.code;
};
const DISCONNECT = { event: 'disconnect', data: { code: 4900, message: 'Disconnected' } };

describe('provider: grants', () => {
  it('answers chainId to any relay origin and {} for accounts without a grant', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    assert.deepEqual((await ask(port, { id: 'c', method: 'qnet_chainId' })).result, { chainId: 'q1337', network: 'testnet' });
    assert.deepEqual((await ask(port, { id: 'a', method: 'qnet_accounts' })).result, {});
    assert.equal(w.log.windows.length, 0);
  });

  it('refuses signing and sending without a grant with 4100, before any window', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    const sign = await ask(port, { id: 's', method: 'qnet_signMessage', params: { message: 'hello' } });
    const send = await ask(port, { id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    assert.deepEqual(sign, { id: 's', ok: false, error: { code: 4100, message: 'Unauthorized' } });
    assert.equal(errorCode(send), 4100);
    await w.grant(APP);
    assert.equal(errorCode(await ask(port, { id: 's2', method: 'qnet_signMessage', params: { message: 'hi' } })), 4100,
      'a grant of another origin does not count');
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.signCalls, []);
  });

  it('connect: one window, the page approves, the dApp gets both addresses and a MACed grant is stored', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/wallet`);
    port.send({ id: 'c1', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    assert.equal(w.log.windows.length, 1);
    const [win] = w.log.windows;
    assert.match(shown.id, UUID_RE);
    assert.equal(win.url, w.chrome.runtime.getURL(`ui/approve.html?id=${shown.id}`));
    assert.deepEqual({ type: win.type, focused: win.focused, width: win.width, height: win.height },
      { type: 'popup', focused: true, width: 400, height: 640 });

    const view = await shown.get();
    assert.deepEqual(view.result, {
      id: shown.id, kind: 'connect', origin: SITE, originDisplay: SITE, idn: false, locked: false, queued: 0,
      createdAt: view.result.createdAt, revision: 1, details: { alreadyGranted: false },
    });
    assert.ok(Number.isSafeInteger(view.result.createdAt));
    assert.equal(port.posted.length, 0, 'nothing reaches the dApp before the user decides');

    assert.deepEqual(await shown.resolve(true), { id: 'ui-1', ok: true, result: { resolved: true } });
    assert.deepEqual(await replyTo(port, 'c1'), { id: 'c1', ok: true, result: ACCOUNTS });
    await until(() => eventsOf(port).length === 1);
    assert.deepEqual(eventsOf(port), [{ event: 'accountsChanged', data: ACCOUNTS }]);
    await until(() => w.log.removed.includes(shown.windowId));

    const stored = await w.storedSites();
    assert.deepEqual(Object.keys(stored), [SITE]);
    assert.deepEqual(stored[SITE].chains, ['qnet', 'solana']);
    assert.equal(stored[SITE].walletId, WALLET_ID);
    const expected = grantEntry(SITE, { sitesKey: w.state.sitesKey, grantedAt: stored[SITE].grantedAt });
    assert.deepEqual(stored[SITE], expected);

    assert.deepEqual((await ask(port, { id: 'a', method: 'qnet_accounts' })).result, ACCOUNTS);
    assert.deepEqual((await ask(port, { id: 'c2', method: 'qnet_requestAccounts' })).result, ACCOUNTS);
    assert.equal(w.log.windows.length, 1, 'a granted, unlocked origin gets its accounts without a window');
    const other = w.connect(`${APP}/`);
    assert.deepEqual((await ask(other, { id: 'o', method: 'qnet_accounts' })).result, {});
  });

  it('one approved connect answers the same origin\'s other waiting connects without more windows', async () => {
    const w = createWorld();
    const tab1 = w.connect(`${SITE}/one`);
    const tab2 = w.connect(`${SITE}/two`, contentScriptSender(`${SITE}/two`, { tabId: 12 }));
    tab1.send({ id: 'a', method: 'qnet_requestAccounts' });
    tab2.send({ id: 'b', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    await until(() => w.provider.snapshot().queued === 2);
    assert.equal((await shown.get()).result.queued, 1);
    await shown.resolve(true);
    assert.deepEqual((await replyTo(tab1, 'a')).result, ACCOUNTS);
    assert.deepEqual((await replyTo(tab2, 'b')).result, ACCOUNTS);
    await settleAll();
    assert.equal(w.log.windows.length, 1);
    assert.equal(w.provider.snapshot().queued, 0);
  });

  it('a rejected connect stores nothing and answers 4001', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    assert.equal((await shown.resolve(false)).ok, true);
    assert.deepEqual(await replyTo(port, 'c'), { id: 'c', ok: false, error: { code: 4001, message: 'User rejected the request' } });
    assert.equal(await w.storedSites(), undefined);
    await until(() => w.log.removed.includes(shown.windowId));
  });

  it('ignores and prunes forged, foreign-wallet, off-pattern and malformed grants', async () => {
    // b..h are allowed hosts here, so each entry is refused for its own defect, not for its origin.
    const w = createWorld({ manifest: manifestWithHosts(...'bcdefgh'.split('').map((x) => `https://${x}.aiqnet.io`)) });
    const { sitesKey } = w.state;
    const good = grantEntry(SITE, { sitesKey });
    const otherKey = core.sha256(core.utf8Encode('another wallet'));
    await w.chrome.storage.local.set({
      [SITES_KEY]: {
        [SITE]: good,
        [APP]: { grantedAt: good.grantedAt, chains: ['qnet', 'solana'], walletId: WALLET_ID },
        'https://b.aiqnet.io': { ...grantEntry('https://b.aiqnet.io', { sitesKey }), mac: good.mac },
        'https://c.aiqnet.io': grantEntry('https://c.aiqnet.io', { walletId: 'another-wallet', sitesKey: otherKey }),
        'https://d.aiqnet.io': grantEntry('https://d.aiqnet.io', { sitesKey: otherKey }),
        'https://e.aiqnet.io': { ...grantEntry('https://e.aiqnet.io', { sitesKey }), extra: true },
        'https://f.aiqnet.io': grantEntry('https://f.aiqnet.io', { sitesKey, chains: ['qnet'] }),
        'https://g.aiqnet.io': grantEntry('https://g.aiqnet.io', { sitesKey, grantedAt: 1.5 }),
        'https://h.aiqnet.io': { ...grantEntry('https://h.aiqnet.io', { sitesKey }), walletId: 'another-wallet' },
        'https://evil.example': grantEntry('https://evil.example', { sitesKey }),
        'https://app.aiqnet.io': grantEntry('https://app.aiqnet.io', { sitesKey }),
        'https://AIQNET.io': grantEntry('https://AIQNET.io', { sitesKey }),
        [`${SITE}/`]: grantEntry(`${SITE}/`, { sitesKey }),
      },
    });
    assert.deepEqual(Object.keys(await w.provider.readSites()), [SITE]);
    assert.deepEqual(await w.storedSites(), { [SITE]: good }, 'invalid entries are pruned from storage');
    for (const host of [APP, 'https://b.aiqnet.io', 'https://c.aiqnet.io', 'https://d.aiqnet.io', 'https://h.aiqnet.io']) {
      const port = w.connect(`${host}/`);
      assert.deepEqual((await ask(port, { id: 'a', method: 'qnet_accounts' })).result, {}, host);
      assert.equal(errorCode(await ask(port, { id: 's', method: 'qnet_signMessage', params: { message: 'x' } })), 4100, host);
    }
    const listed = await w.popup('sites.list', {});
    assert.deepEqual(listed.result.sites.map((s) => s.origin), [SITE]);

    await w.chrome.storage.local.set({ [SITES_KEY]: 'not an object' });
    assert.deepEqual(await w.provider.readSites(), {});
    assert.equal(await w.storedSites(), undefined);
  });

  it('binds grants to the wallet: a new vault or no vault sees none', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    assert.deepEqual((await ask(port, { id: 'a1', method: 'qnet_accounts' })).result, ACCOUNTS);
    w.state.walletId = '0b4a3a61-1f3e-4b8e-9a51-6f7b0c2d9e44';
    assert.deepEqual((await ask(port, { id: 'a2', method: 'qnet_accounts' })).result, {});
    assert.equal(errorCode(await ask(port, { id: 's', method: 'qnet_signMessage', params: { message: 'x' } })), 4100);
    assert.equal(await w.storedSites(), undefined);
    await w.grant(SITE);
    w.state.vaultExists = false;
    assert.deepEqual(await w.provider.readSites(), {});
    assert.equal(errorCode(await ask(port, { id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } })), 4100);
  });

  it('lists grants newest first with their display form', async () => {
    const w = createWorld({ manifest: manifestWithHosts('https://xn--mnchen-3ya.aiqnet.io') });
    const { sitesKey } = w.state;
    await w.chrome.storage.local.set({
      [SITES_KEY]: {
        [SITE]: grantEntry(SITE, { sitesKey, grantedAt: 1000 }),
        'https://xn--mnchen-3ya.aiqnet.io': grantEntry('https://xn--mnchen-3ya.aiqnet.io', { sitesKey, grantedAt: 3000 }),
        [APP]: grantEntry(APP, { sitesKey, grantedAt: 2000 }),
      },
    });
    const { result } = await w.popup('sites.list', {});
    assert.deepEqual(result.sites, [
      { origin: 'https://xn--mnchen-3ya.aiqnet.io', originDisplay: 'https://münchen.aiqnet.io', idn: true, grantedAt: 3000, chains: ['qnet', 'solana'] },
      { origin: APP, originDisplay: APP, idn: false, grantedAt: 2000, chains: ['qnet', 'solana'] },
      { origin: SITE, originDisplay: SITE, idn: false, grantedAt: 1000, chains: ['qnet', 'solana'] },
    ]);
  });
});

describe('provider: approval windows', () => {
  it('lets a page read and resolve only the approval shown in its own window', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 's1', method: 'qnet_signMessage', params: { message: 'first' } });
    port.send({ id: 's2', method: 'qnet_signMessage', params: { message: 'second' } });
    const shown = await w.shown();
    await until(() => w.provider.snapshot().queued === 2);
    const foreignWindow = w.approveSender(shown.windowId + 1, shown.id);
    const cases = [
      [foreignWindow, shown.id],
      [{ ...shown.sender, tab: undefined }, shown.id],
      [shown.sender, '0f8fad5b-d9cb-469f-a165-70867728950e'],
    ];
    for (const [sender, id] of cases) {
      assert.equal(errorCode(await w.ui(sender, 'approval.get', { id })), 'NOT_FOUND');
      assert.equal(errorCode(await w.ui(sender, 'approval.resolve', { id, approved: true })), 'NOT_FOUND');
    }
    assert.equal(errorCode(await w.ui(pageSender(w.chrome.runtime, 'popup'), 'approval.resolve', { id: shown.id, approved: true })),
      'FORBIDDEN_SENDER');
    assert.equal(errorCode(await w.ui(contentScriptSender(`${SITE}/`), 'approval.resolve', { id: shown.id, approved: true })),
      'FORBIDDEN_SENDER');
    assert.deepEqual(w.log.signCalls, []);
    const view = await shown.get();
    assert.equal(view.result.details.message, 'first');
    assert.equal(view.result.queued, 1);
    assert.equal(port.posted.length, 0);
  });

  it('caps each origin at 3 open approvals, opens one window at a time, FIFO across origins', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const site = w.connect(`${SITE}/`);
    const app = w.connect(`${APP}/`);
    for (let i = 1; i <= LIMITS.APPROVAL_QUEUE_PER_ORIGIN; i += 1) {
      site.send({ id: `s${i}`, method: 'qnet_signMessage', params: { message: `m${i}` } });
    }
    const first = await w.shown();
    await until(() => w.provider.snapshot().queued === 3);
    assert.deepEqual(await ask(site, { id: 's4', method: 'qnet_signMessage', params: { message: 'm4' } }),
      { id: 's4', ok: false, error: { code: 4001, message: 'User rejected the request' } });
    const flood = await ask(site, { id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    assert.equal(errorCode(flood), 4001, 'the cap counts every kind');
    assert.deepEqual((await ask(site, { id: 'c', method: 'qnet_requestAccounts' })).result, ACCOUNTS,
      'a granted, unlocked origin needs no approval, so the cap does not apply');
    app.send({ id: 'a1', method: 'qnet_signMessage', params: { message: 'from app' } });
    await until(() => w.provider.snapshot().queued === 4);
    assert.equal(w.log.windows.length, 1);

    // Approving (rejections count toward the origin's cooldown: provider-cooldown) moves the queue along.
    await first.resolve(true);
    assert.equal((await replyTo(site, 's1')).ok, true);
    const second = await w.shown({ after: first.windowId });
    assert.equal((await second.get()).result.details.message, 'm2');
    site.send({ id: 's5', method: 'qnet_signMessage', params: { message: 'm5' } });
    await until(() => w.provider.snapshot().queued === 4);
    await second.resolve(true);
    const third = await w.shown({ after: second.windowId });
    assert.equal((await third.get()).result.details.message, 'm3');
    await third.resolve(true);
    const fourth = await w.shown({ after: third.windowId });
    const view = await fourth.get();
    assert.equal(view.result.origin, APP, 'the other origin was queued before s5');
    assert.equal(view.result.details.message, 'from app');
    assert.equal(w.log.maxOpen, 1, 'never two approval windows at once');
  });

  it('a window the user closes rejects with 4001 and the next approval opens', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const port = w.connect(`${SITE}/`);
    const other = w.connect(`${APP}/`);
    port.send({ id: 'a', method: 'qnet_signMessage', params: { message: 'a' } });
    const first = await w.shown();
    other.send({ id: 'b', method: 'qnet_signMessage', params: { message: 'b' } });
    await until(() => w.provider.snapshot().queued === 2);
    await w.userCloses(first.windowId);
    assert.deepEqual(await replyTo(port, 'a'), { id: 'a', ok: false, error: { code: 4001, message: 'User rejected the request' } });
    const second = await w.shown({ after: first.windowId });
    assert.equal((await second.get()).result.details.message, 'b');
    assert.equal(errorCode(await first.get()), 'NOT_FOUND');
  });

  it('a closed port rejects its approvals and closes their window; other pages keep theirs', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const gone = w.connect(`${SITE}/`);
    const stays = w.connect(`${APP}/`);
    gone.send({ id: 'g1', method: 'qnet_signMessage', params: { message: 'g1' } });
    gone.send({ id: 'g2', method: 'qnet_signMessage', params: { message: 'g2' } });
    const first = await w.shown();
    stays.send({ id: 'k', method: 'qnet_signMessage', params: { message: 'kept' } });
    await until(() => w.provider.snapshot().queued === 3);
    gone.close();
    const next = await w.shown({ after: first.windowId });
    assert.ok(w.log.removed.includes(first.windowId));
    assert.equal((await next.get()).result.origin, APP);
    assert.equal(w.provider.snapshot().queued, 1);
    assert.deepEqual(w.log.signCalls, []);
  });

  it('a request whose port closes during its grant check opens no window', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const ctx = Object.freeze({ origin: SITE, tabId: 11, portId: 41 });
    const request = w.provider.handleRequest(ctx, 'qnet_signMessage', { message: 'late' });
    await w.provider.onPortClosed(ctx);
    await assert.rejects(request, (error) => error.code === 4001);
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    assert.equal(w.provider.snapshot().queued, 0);
  });

  it('an approval left open until the timeout is rejected with 4001 and its window closed', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    w.fireTimers(TIMINGS.APPROVAL_TIMEOUT_MS);
    assert.equal(errorCode(await replyTo(port, 'c')), 4001);
    await until(() => w.log.removed.includes(shown.windowId));
    assert.equal(errorCode(await shown.get()), 'NOT_FOUND');
  });

  it('broadcasts every queue change to the extension pages', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    const before = w.log.views.length;
    assert.ok(before >= 1);
    await shown.resolve(false);
    assert.ok(w.log.views.length > before);
    assert.ok(w.log.views.every((event) => event === 'approval'));
  });
});

describe('provider: qnet_signMessage', () => {
  it('signs the exact text for the port origin, never an origin named in the request', async () => {
    const w = createWorld();
    await w.grant(APP);
    const port = w.connect(`${APP}/login`);
    const message = `Sign in to ${SITE}\norigin: ${SITE}\nNonce: 42 ✓`;
    const spoofs = [
      { id: 'p1', method: 'qnet_signMessage', params: { message, origin: SITE } },
      { id: 'p2', method: 'qnet_signMessage', params: { message }, origin: SITE },
      { id: 'p3', method: 'qnet_signMessage', params: { message, ctx: { origin: SITE } } },
    ];
    for (const spoof of spoofs) assert.equal(errorCode(await ask(port, spoof)), -32602, spoof.id);
    assert.equal(w.log.windows.length, 0);

    port.send({ id: 's', method: 'qnet_signMessage', params: { message } });
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.origin, APP);
    assert.equal(view.kind, 'signMessage');
    assert.deepEqual(view.details, { message, byteLength: core.utf8Encode(message).length });
    await shown.resolve(true);
    const reply = await replyTo(port, 's');
    assert.equal(reply.ok, true);
    const { signature, publicKey, address } = reply.result;
    assert.deepEqual(Object.keys(reply.result).sort(), ['address', 'publicKey', 'signature']);
    assert.match(signature, /^[0-9a-f]{6618}$/);
    assert.match(publicKey, /^[0-9a-f]{3904}$/);
    assert.equal(address, ACCOUNTS.qnet);
    assert.deepEqual(w.log.signCalls, [{ origin: APP, message }]);
    const sig = core.hexToBytes(signature);
    const pk = core.hexToBytes(publicKey);
    assert.equal(core.verifyOffchainMessage(APP, message, sig, pk), true);
    assert.equal(core.verifyOffchainMessage(SITE, message, sig, pk), false, 'bound to the requesting origin');
    const asTransfer = { from: ACCOUNTS.qnet, to: ACCOUNTS.qnet, amountNano: 1, nonce: 1, gasPrice: 10, gasLimit: 10000 };
    assert.equal(core.verifyTransferSignature(asTransfer, sig, pk), false);
  });

  it('refuses protocol prefixes and hidden text before any window, even past the router', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const transfer = `q1337|transfer:${ACCOUNTS.qnet}:${ACCOUNTS.qnet}:1000000000:6:10:10000`;
    const bad = [
      ...core.PROTOCOL_PREFIXES.map((prefix) => `${prefix}payload`),
      transfer, `  ${transfer.toUpperCase()}`, 'PING:1', 'pay ‮evil', 'zero‎width', 'nul\u0000', '',
      'x'.repeat(core.OFFCHAIN_MESSAGE_MAX_BYTES + 1),
    ];
    for (const [i, message] of bad.entries()) {
      assert.equal(errorCode(await ask(port, { id: `b${i}`, method: 'qnet_signMessage', params: { message } })), -32602,
        JSON.stringify(message).slice(0, 40));
    }
    const ctx = Object.freeze({ origin: SITE, tabId: 1, portId: 99 });
    for (const message of [transfer, 'selfattest:x', 'a‮b']) {
      await assert.rejects(w.provider.handleRequest(ctx, 'qnet_signMessage', { message }),
        (error) => ['PROTOCOL_PREFIX', 'INVALID_MESSAGE'].includes(error.code));
    }
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.signCalls, []);
  });

  it('a grant revoked while the approval waits answers 4100 and signs nothing', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 's', method: 'qnet_signMessage', params: { message: 'hello' } });
    const shown = await w.shown();
    await w.chrome.storage.local.remove(SITES_KEY);
    assert.equal(errorCode(await shown.resolve(true)), 'UNAUTHORIZED');
    assert.deepEqual(await replyTo(port, 's'), { id: 's', ok: false, error: { code: 4100, message: 'Unauthorized' } });
    assert.deepEqual(w.log.signCalls, []);
  });
});

describe('provider: qnet_sendTransaction', () => {
  it('shows the wallet-set fee and nonce, and sends exactly the last preview served', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1.5' } });
    const shown = await w.shown();
    assert.deepEqual((await shown.get()).result.details, {
      to: ACCOUNTS.qnet, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000', nonce: '5',
      balanceNano: '10000000000', verified: true, verification: 'proof', balanceProblem: null, outstanding: 0, duplicate: false,
      replaces: null, inFlight: false, recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
    });
    w.state.nonce = '6';
    assert.equal(errorCode(await shown.resolve(true)), 'NONCE_CHANGED');
    assert.equal(port.posted.length, 0, 'the approval stays open for a new review');
    assert.equal(errorCode(await shown.resolve(true)), 'NONCE_UNAVAILABLE', 'no confirm without a fresh preview');
    assert.equal((await shown.get()).result.details.nonce, '6');
    assert.equal((await shown.resolve(true)).ok, true);
    // the transfer's identity: from and nonce (at most one transaction of from applies at a nonce); the hash is one
    // node's copy, which need not be the one that lands (R5-EXTQ-03)
    assert.deepEqual(await replyTo(port, 't'), {
      id: 't', ok: true,
      result: { status: 'submitted', from: ACCOUNTS.qnet, to: ACCOUNTS.qnet, amount: '1.5', nonce: '6', txHash: 'ab'.repeat(32) },
    });
    assert.deepEqual(w.log.sendCalls.at(-1), {
      to: ACCOUNTS.qnet, amountNano: '1500000000', expectedFeeNano: '150000', expectedNonce: '6', oneInFlight: true,
    });
    assert.equal(w.log.sendCalls.length, 2);
  });

  // The send rule refuses before signing when the balance is not certified yet or another device's transaction is not: the
  // approval stays open, reads the account again, and confirms once it can.
  it('a confirm the send rule refuses before signing keeps the approval open for a fresh review', async () => {
    for (const code of ['BALANCE_UNCONFIRMED', 'BALANCE_FOREIGN_PENDING']) {
      const w = createWorld();
      await w.grant(SITE);
      const port = w.connect(`${SITE}/`);
      port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
      const shown = await w.shown();
      assert.equal((await shown.get()).result.details.nonce, '5');
      w.state.sendError = new WalletError(code);
      assert.equal(errorCode(await shown.resolve(true)), code);
      assert.equal(port.posted.length, 0, `${code}: the approval stays open`);
      w.state.sendError = null;
      assert.equal((await shown.get()).result.details.nonce, '5');
      assert.equal((await shown.resolve(true)).ok, true);
      assert.equal((await replyTo(port, 't')).ok, true);
    }
  });

  it('gives the approval the recipient check once, for the first-time, look-alike and poisoning warnings (ES-01)', async () => {
    const w = createWorld();
    w.state.recipientError = new WalletError('NETWORK');
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const shown = await w.shown();
    const unreadable = (await shown.get()).result.details;
    assert.equal(unreadable.recipient, null, 'an unreadable check is unknown, not "first time"');
    assert.equal(unreadable.nonce, '5', 'the preview does not wait on the check');
    w.state.recipientError = null;
    w.state.recipient = { known: false, lookalike: true, incomingOnly: true, historyRead: true };
    assert.deepEqual((await shown.get()).result.details.recipient,
      { known: false, lookalike: true, incomingOnly: true, historyRead: true, recentSame: false });
    w.state.recipient = { known: true, lookalike: false, incomingOnly: false, historyRead: true };
    assert.deepEqual((await shown.get()).result.details.recipient,
      { known: false, lookalike: true, incomingOnly: true, historyRead: true, recentSame: false }, 'read once per approval');
    assert.deepEqual(w.log.recipientChecks, [ACCOUNTS.qnet, ACCOUNTS.qnet]);
    w.state.recipient = { known: 'yes', lookalike: false, incomingOnly: false, historyRead: true };
    w.state.unlocked = false;
    assert.equal((await shown.get()).result.details.recipient, null, 'nothing of the wallet while locked');
  });

  it('refuses a malformed recipient check rather than show a warning it cannot trust', async () => {
    const w = createWorld();
    w.state.recipient = { known: 'yes', lookalike: false, incomingOnly: false, historyRead: true };
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const shown = await w.shown();
    assert.equal((await shown.get()).result.details.recipient, null);
  });

  it('refuses an amount whose total with the fee does not fit u64, before any window', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const reply = await ask(port, { id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '18446744073.709551615' } });
    assert.equal(errorCode(reply), -32602);
    assert.equal(w.log.windows.length, 0);
  });

  it('shows only the static fee while locked and needs the unlock before sending', async () => {
    const w = createWorld({ unlocked: false });
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '0.000000001' } });
    const shown = await w.shown();
    const locked = (await shown.get()).result;
    assert.equal(locked.locked, true);
    assert.deepEqual(locked.details, {
      to: ACCOUNTS.qnet, amountNano: '1', feeNano: '150000', totalNano: '150001', nonce: null, balanceNano: null, verified: false,
      verification: 'none', balanceProblem: null, outstanding: 0, duplicate: false, replaces: null, inFlight: false, recipient: null,
    });
    assert.deepEqual(w.log.recipientChecks, [], 'nothing of the wallet is read while locked');
    assert.equal(errorCode(await shown.resolve(true)), 'LOCKED');
    assert.equal(port.posted.length, 0);
    w.state.unlocked = true;
    assert.equal((await shown.get()).result.details.nonce, '5');
    assert.equal((await shown.resolve(true)).ok, true);
    assert.equal((await replyTo(port, 't')).result.status, 'submitted');
  });

  it('a failed send reaches the dApp as -32603 and the page as its wallet error; the window stays to show it', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '2' } });
    const shown = await w.shown();
    await shown.get();
    w.state.sendError = new WalletError('INSUFFICIENT_FUNDS');
    assert.equal(errorCode(await shown.resolve(true)), 'INSUFFICIENT_FUNDS');
    assert.deepEqual(await replyTo(port, 't'), { id: 't', ok: false, error: { code: -32603, message: 'Internal error' } });
    assert.equal(w.log.removed.includes(shown.windowId), false);
    assert.equal(errorCode(await shown.resolve(true)), 'NOT_FOUND', 'one approval, one action');
    w.fireTimers(30000);
    await until(() => w.log.removed.includes(shown.windowId));
  });
});

describe('provider: a recipient that is a contract (EXT-R2A-01)', () => {
  it('a QNC transfer to a contract account is refused before any window, and one no two nodes can check too', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const send = (to, id) => ask(port, { id, method: 'qnet_sendTransaction', params: { type: 'transfer', to, amount: '100' } });
    // a game's "deposit" into its own contract: no host function could ever send that QNC on
    assert.deepEqual((await send(GAME, 'a')).error, { code: -32602, message: 'Invalid params' });
    assert.equal(errorCode(await send(TOKEN, 'b')), -32602, 'a token contract');
    w.state.contractError = new WalletError('NETWORK');
    assert.equal(errorCode(await send(ACCOUNTS.qnet, 'c')), -32603, 'a recipient no two nodes agree on is not offered');
    assert.deepEqual(w.log.recipientReads, [GAME, TOKEN, ACCOUNTS.qnet]);
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.sendCalls, []);
  });

  it('the confirm reads the recipient again: a contract there by then is refused, and the site learns -32602', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '2' } });
    const shown = await w.shown();
    await shown.get();
    w.state.sendError = new WalletError('RECIPIENT_IS_CONTRACT');
    assert.equal(errorCode(await shown.resolve(true)), 'RECIPIENT_IS_CONTRACT');
    assert.deepEqual(await replyTo(port, 't'), { id: 't', ok: false, error: { code: -32602, message: 'Invalid params' } });
  });

  it('a token transfer to a contract, the token itself included, is refused before any window', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const send = (to, id) => ask(port, { id, method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to, amount: '1' } });
    assert.equal(errorCode(await send(TOKEN, 'a')), -32602, 'the token contract itself');
    assert.equal(errorCode(await send(GAME, 'b')), -32602, 'another contract');
    assert.deepEqual(w.log.recipientReads, [TOKEN, GAME]);
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.callSends, []);
  });
});

describe('provider: qnet_sendTransaction tokenTransfer and contractCall', () => {
  it('tokenTransfer: the token\'s decimals turn the amount into base units; the view names the token as two nodes read it', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '2.50' } });
    const shown = await w.shown();
    const tx = core.buildTokenTransfer({ from: ACCOUNTS.qnet, token: TOKEN, to: ACCOUNTS.qnet, amount: '2500000', nonce: '5' });
    assert.deepEqual((await shown.get()).result.details, {
      token: TOKEN, to: ACCOUNTS.qnet, amount: '2.5', amountBase: '2500000', name: 'Gold Coin', symbol: 'GOLD', decimals: 6,
      reserved: false, burn: false, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano, totalNano: (BigInt(tx.maxFeeNano) + 10000000n).toString(),
      nonce: '5', balanceNano: '10000000000', verified: true, verification: 'proof', balanceProblem: null, outstanding: 0, replaces: null,
      inFlight: false, depositNano: '10000000', tokenBalance: '5000000000', tokenProblem: null, duplicate: false,
      recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: true, recentSame: false },
    });
    assert.deepEqual(w.log.contractReads, [TOKEN]);
    assert.deepEqual(w.log.recipientReads, [ACCOUNTS.qnet], 'the recipient is checked before the window too');
    assert.equal((await shown.resolve(true)).ok, true);
    assert.deepEqual(w.log.callSends.at(-1), {
      request: { kind: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amountBase: '2500000' },
      expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '10000000', expectedNonce: '5', oneInFlight: true,
    });
    assert.deepEqual(await replyTo(port, 't'), {
      id: 't', ok: true,
      result: { status: 'submitted', from: ACCOUNTS.qnet, token: TOKEN, to: ACCOUNTS.qnet, amount: '2.5', nonce: '5', txHash: 'cd'.repeat(32) },
    });
  });

  it('tokenTransfer: a token named after QNC and the burn address are flagged; its name is shown only as drawn exactly', async () => {
    const w = createWorld();
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc20', name: 'QNet Coin\u200b', symbol: 'QNC', decimals: 9 };
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: core.CANONICAL_BURN_ADDRESS, amount: '1' } });
    const shown = await w.shown();
    const { details } = (await shown.get()).result;
    assert.equal(details.name, '', 'a name with a hidden character is not shown');
    assert.equal(details.symbol, 'QNC');
    assert.equal(details.reserved, true);
    assert.equal(details.burn, true);
    assert.equal(details.amountBase, '1000000000');
  });

  // M-5: qnet.readContract shows a hidden or format character as U+FFFD and flags the token from its name as deployed
  // ("\u202eCNQ" reads as QNC); the approval keeps that flag, which the label alone would no longer show.
  it('tokenTransfer: the reserved flag of the token as deployed reaches the view, beside its label with U+FFFD', async () => {
    const w = createWorld();
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc20', name: 'Coin', symbol: '\ufffdCNQ', decimals: 0, reserved: true };
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '3' } });
    const shown = await w.shown();
    const { details } = (await shown.get()).result;
    assert.equal(details.symbol, '\ufffdCNQ');
    assert.equal(details.name, 'Coin');
    assert.equal(details.reserved, true);
    assert.equal(details.burn, false);
  });

  it('tokenTransfer: no QRC-20 token, an amount finer than its decimals or an unreadable token is refused before any window', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const send = (params, id) => ask(port, { id, method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', to: ACCOUNTS.qnet, ...params } });
    assert.equal(errorCode(await send({ token: GAME, amount: '1' }, 'a')), -32602, 'a contract that is no token');
    assert.equal(errorCode(await send({ token: ACCOUNTS.qnet, amount: '1' }, 'b')), -32602, 'no contract');
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc721', name: 'Items', symbol: 'ITM', decimals: 0 };
    assert.equal(errorCode(await send({ token: TOKEN, amount: '1' }, 'c')), -32602, 'a non-fungible token');
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc20', name: 'Wide', symbol: 'W', decimals: 19 };
    assert.equal(errorCode(await send({ token: TOKEN, amount: '1' }, 'd')), -32602, 'more decimals than an amount converts with');
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc20', name: 'Gold', symbol: 'G', decimals: 2 };
    assert.equal(errorCode(await send({ token: TOKEN, amount: '0.001' }, 'e')), -32602, 'finer than the token');
    assert.equal(errorCode(await send({ token: TOKEN, amount: '184467440737095516.16' }, 'f')), -32602, 'above u64 base units');
    w.state.contractError = new WalletError('NETWORK');
    assert.equal(errorCode(await send({ token: TOKEN, amount: '1' }, 'g')), -32603);
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.callSends, []);
  });

  it('contractCall: contract, method, input as hex and as text, the builder\'s gas; the result echoes the call', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const args = core.bytesToHex(core.utf8Encode('move e2e4'));
    port.send({ id: 'c', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'play', args } });
    const shown = await w.shown();
    const tx = core.buildContractCall({ from: ACCOUNTS.qnet, contract: GAME, method: 'play', args, nonce: '5' });
    assert.equal(Number(tx.gasLimit), Number(tx.intrinsicGas) + core.WASM_DEFAULT_FUEL, 'the default fuel');
    assert.deepEqual((await shown.get()).result.details, {
      contract: GAME, method: 'play', args, argsBytes: 9, argsText: 'move e2e4', gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano,
      totalNano: tx.maxFeeNano, nonce: '5', balanceNano: '10000000000', verified: true, verification: 'proof', balanceProblem: null,
      outstanding: 0, replaces: null, inFlight: false,
    });
    assert.equal((await shown.resolve(true)).ok, true);
    assert.deepEqual(w.log.callSends.at(-1), {
      request: { kind: 'contractCall', contract: GAME, method: 'play', args, gasLimit: null },
      expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0', expectedNonce: '5', oneInFlight: true,
    });
    assert.deepEqual(await replyTo(port, 'c'), {
      id: 'c', ok: true, result: { status: 'submitted', from: ACCOUNTS.qnet, contract: GAME, method: 'play', nonce: '5', txHash: 'cd'.repeat(32) },
    });
  });

  it('contractCall: input that does not read as text, an explicit gas limit, and a target that is a token or no contract', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', args: 'FF00E2', gasLimit: 500000 } });
    const shown = await w.shown();
    const { details } = (await shown.get()).result;
    assert.equal(details.args, 'ff00e2', 'taken as lowercase');
    assert.equal(details.argsText, null);
    assert.equal(details.argsBytes, 3);
    assert.equal(details.gasLimit, '500000');
    assert.equal(details.feeNano, String(15n * 500000n));
    await shown.resolve(false);
    const w2 = createWorld();
    await w2.grant(SITE);
    const port2 = w2.connect(`${SITE}/`);
    for (const contract of [TOKEN, ACCOUNTS.qnet]) {
      const reply = await ask(port2, { id: contract, method: 'qnet_sendTransaction', params: { type: 'contractCall', contract, method: 'run', args: '' } });
      assert.equal(errorCode(reply), -32602, contract);
    }
    assert.equal(w2.log.windows.length, 0);
  });

  it('a transaction behind one not in a block yet says so; every kind confirms only with the committed nonce + 1', async () => {
    const w = createWorld();
    w.state.inFlight = true;
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', args: '' } });
    const shown = await w.shown();
    assert.equal((await shown.get()).result.details.inFlight, true);
    w.state.inFlight = false;
    assert.equal((await shown.get()).result.details.inFlight, false);
    assert.equal((await shown.resolve(true)).ok, true);
    assert.equal(w.log.callSends.at(-1).oneInFlight, true);
  });

  it('a revoked grant rejects waiting token transfers and calls with 4100; a disconnect needs no approval', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'a', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', args: '' } });
    port.send({ id: 'b', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '1' } });
    await w.shown();
    await until(() => w.provider.snapshot().queued === 2);
    assert.equal((await ask(port, { id: 'd', method: 'qnet_disconnect' })).result, true);
    assert.equal(errorCode(await replyTo(port, 'a')), 4100);
    assert.equal(errorCode(await replyTo(port, 'b')), 4100);
    assert.deepEqual(w.log.callSends, []);
  });
});

describe('provider: qnet_getTransactionStatus', () => {
  it('answers the connected, unlocked account only, with no window', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    const status = (params, id) => ask(port, { id, method: 'qnet_getTransactionStatus', params });
    assert.equal(errorCode(await status({ from: ACCOUNTS.qnet, nonce: '1' }, 'a')), 4100, 'no grant');
    await w.grant(SITE);
    assert.equal(errorCode(await status({ from: core.deriveContractAddress(ACCOUNTS.qnet, 9), nonce: '1' }, 'b')), 4100, 'another account');
    w.state.status = { status: 'in_block', from: ACCOUNTS.qnet, nonce: '1', txHash: 'ef'.repeat(32), blockHeight: 2212409 };
    assert.deepEqual((await status({ from: ACCOUNTS.qnet, nonce: '1' }, 'c')).result,
      { status: 'in_block', blockHeight: 2212409, txHash: 'ef'.repeat(32) });
    w.state.unlocked = false;
    assert.equal(errorCode(await status({ from: ACCOUNTS.qnet, nonce: '2' }, 'd')), 4100, 'locked');
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual(w.log.statusReads, [{ from: ACCOUNTS.qnet, nonce: '1' }]);
  });

  it('gives an answer again for 3 s, starts at most 20 reads a minute per origin (then 4001), as the mobile browser', async () => {
    let now = 1_800_000_000_000;
    const w = createWorld({ now: () => now });
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const status = (nonce, id) => ask(port, { id, method: 'qnet_getTransactionStatus', params: { from: ACCOUNTS.qnet, nonce } });
    const UNKNOWN = { status: 'unknown', blockHeight: null, txHash: null };
    assert.deepEqual((await status('1', 'a')).result, { status: 'pending', blockHeight: null, txHash: null });
    assert.equal((await status('1', 'b')).result.status, 'pending');
    assert.equal(w.log.statusReads.length, 1, 'the second call gets the first read');
    now += 3000;
    await status('1', 'c');
    assert.equal(w.log.statusReads.length, 2);
    for (let n = 2; n <= 19; n += 1) assert.equal((await status(String(n), `n${n}`)).ok, true);
    assert.equal(w.log.statusReads.length, 20);
    assert.deepEqual((await status('20', 'x')).error, { code: 4001, message: 'User rejected the request' });
    now += 60_000 - 3000 - 1;
    assert.equal((await status('20', 'y')).error.code, 4001, 'the first read is still within the minute');
    now += 1;
    assert.equal((await status('20', 'z')).ok, true, 'the first read left the minute');
    // a malformed answer, one for another nonce, or a failed read is 'unknown'; a hash and a height only in a block
    now += 60_000;
    w.state.status = { status: 'confirmed', from: ACCOUNTS.qnet, nonce: '12', txHash: null, blockHeight: null };
    assert.deepEqual((await status('12', 'm')).result, UNKNOWN);
    w.state.status = { status: 'pending', from: ACCOUNTS.qnet, nonce: '13', txHash: null, blockHeight: null };
    assert.deepEqual((await status('14', 'o')).result, UNKNOWN);
    w.state.status = { status: 'pending', from: ACCOUNTS.qnet, nonce: '15', txHash: 'ef'.repeat(32), blockHeight: 7 };
    assert.deepEqual((await status('15', 'p')).result, { status: 'pending', blockHeight: null, txHash: null });
    w.state.status = null;
    w.state.statusError = new WalletError('NETWORK');
    assert.deepEqual((await status('16', 'q')).result, UNKNOWN);
  });
});
describe('provider: lock and unlock', () => {
  it('locked: accounts {} without a window, requestAccounts opens unlock-first, confirm waits for the unlock', async () => {
    const w = createWorld({ unlocked: false });
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    assert.deepEqual((await ask(port, { id: 'a', method: 'qnet_accounts' })).result, {});
    assert.equal(w.log.windows.length, 0);
    port.send({ id: 'r', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.locked, true);
    assert.deepEqual(view.details, { alreadyGranted: true });
    assert.equal(errorCode(await shown.resolve(true)), 'LOCKED');
    assert.equal(port.posted.some((m) => m.id === 'r'), false, 'the request still waits');
    w.state.unlocked = true;
    assert.equal((await shown.resolve(true)).ok, true);
    assert.deepEqual((await replyTo(port, 'r')).result, ACCOUNTS);
  });

  it('a wallet that locks at signing answers the dApp 4100', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 's', method: 'qnet_signMessage', params: { message: 'hello' } });
    const shown = await w.shown();
    w.state.lockAtSigning = true;
    assert.equal(errorCode(await shown.resolve(true)), 'LOCKED');
    assert.deepEqual(await replyTo(port, 's'), { id: 's', ok: false, error: { code: 4100, message: 'Unauthorized' } });
    assert.equal(errorCode(await shown.get()), 'NOT_FOUND');
  });

  it('lock and unlock reach granted origins only; unlock answers queued connects of granted origins', async () => {
    const w = createWorld({ unlocked: false });
    await w.grant(SITE);
    const granted = w.connect(`${SITE}/`);
    const stranger = w.connect(`${APP}/`);
    stranger.send({ id: 'x', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    granted.send({ id: 'g', method: 'qnet_requestAccounts' });
    await until(() => w.provider.snapshot().queued === 2);

    w.state.unlocked = true;
    await w.provider.notifyLockChanged({ locked: false, reason: 'unlock' });
    assert.deepEqual(await replyTo(granted, 'g'), { id: 'g', ok: true, result: ACCOUNTS });
    assert.deepEqual(eventsOf(granted), [{ event: 'accountsChanged', data: ACCOUNTS }]);
    assert.deepEqual(eventsOf(stranger), []);
    assert.equal(w.provider.snapshot().windowId, shown.windowId, "the stranger's approval still waits");

    w.state.unlocked = false;
    await w.provider.notifyLockChanged({ locked: true, reason: 'user' });
    assert.deepEqual(eventsOf(granted).at(-1), { event: 'accountsChanged', data: {} });
    assert.deepEqual(eventsOf(stranger), []);
  });

  it('wipe disconnects every page and rejects every approval with 4900', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const granted = w.connect(`${SITE}/`);
    const other = w.connect(`${APP}/`);
    assert.deepEqual((await ask(granted, { id: 'a', method: 'qnet_accounts' })).result, ACCOUNTS);
    other.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    await w.provider.notifyLockChanged({ locked: true, reason: 'wipe' });
    assert.deepEqual(await replyTo(other, 'c'), { id: 'c', ok: false, error: { code: 4900, message: 'Disconnected' } });
    assert.deepEqual(eventsOf(granted), [{ event: 'accountsChanged', data: {} }, DISCONNECT]);
    await until(() => w.log.removed.includes(shown.windowId));
    assert.equal(w.provider.snapshot().queued, 0);
  });
});

describe('provider: revoke and disconnect', () => {
  it('sites.revoke emits accountsChanged {} and disconnect to that origin only and rejects its waiting requests', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const site = w.connect(`${SITE}/`);
    const app = w.connect(`${APP}/`);
    site.send({ id: 's', method: 'qnet_signMessage', params: { message: 'pending' } });
    const shown = await w.shown();
    assert.deepEqual(await w.popup('sites.revoke', { origin: SITE }), { id: 'ui-1', ok: true, result: { revoked: true } });
    assert.deepEqual(await replyTo(site, 's'), { id: 's', ok: false, error: { code: 4100, message: 'Unauthorized' } });
    assert.deepEqual(eventsOf(site), [{ event: 'accountsChanged', data: {} }, DISCONNECT]);
    assert.deepEqual(eventsOf(app), []);
    await until(() => w.log.removed.includes(shown.windowId));
    assert.deepEqual(Object.keys(await w.storedSites()), [APP]);
    assert.deepEqual((await ask(site, { id: 'a', method: 'qnet_accounts' })).result, {});
    assert.deepEqual((await ask(app, { id: 'a', method: 'qnet_accounts' })).result, ACCOUNTS);

    assert.deepEqual((await w.popup('sites.revoke', { origin: SITE })).result, { revoked: false });
    assert.equal(eventsOf(site).length, 2, 'nothing to revoke, nothing sent');
    assert.equal(errorCode(await w.popup('sites.revoke', { origin: `${SITE}/` })), 'INVALID_PARAMS');
  });

  it('a revoked grant written back into storage.local is refused; the other grants survive the key rotation', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const old = await w.storedSites();
    const site = w.connect(`${SITE}/`);
    const app = w.connect(`${APP}/`);
    assert.equal((await w.popup('sites.revoke', { origin: SITE })).result.revoked, true);
    const after = await w.storedSites();
    assert.deepEqual(Object.keys(after), [APP]);
    assert.notEqual(after[APP].mac, old[APP].mac, 'the remaining grant is signed with the new key');
    await w.chrome.storage.local.set({ [SITES_KEY]: { ...after, [SITE]: old[SITE] } });
    assert.deepEqual((await ask(site, { id: 'a', method: 'qnet_accounts' })).result, {});
    assert.deepEqual((await ask(app, { id: 'a', method: 'qnet_accounts' })).result, ACCOUNTS);
    assert.deepEqual(Object.keys(await w.storedSites()), [APP], 'the replayed grant is pruned');
  });

  it('qnet_disconnect removes the grant of the calling origin and tells it', async () => {
    const w = createWorld();
    await w.grant(SITE, APP);
    const site = w.connect(`${SITE}/`);
    assert.deepEqual(await ask(site, { id: 'd', method: 'qnet_disconnect' }), { id: 'd', ok: true, result: true });
    assert.deepEqual(eventsOf(site), [{ event: 'accountsChanged', data: {} }, DISCONNECT]);
    assert.deepEqual(Object.keys(await w.storedSites()), [APP]);
    assert.equal(errorCode(await ask(site, { id: 's', method: 'qnet_signMessage', params: { message: 'x' } })), 4100);
    assert.deepEqual(await ask(site, { id: 'd2', method: 'qnet_disconnect' }), { id: 'd2', ok: true, result: true });
  });
});

describe('provider: results and origin display', () => {
  it('never hands a dApp more than addresses, signatures and a transaction hash', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    await ask(port, { id: 'a', method: 'qnet_accounts' });
    await ask(port, { id: 'c', method: 'qnet_chainId' });
    const text = JSON.stringify(port.posted);
    for (const word of ['abandon', 'secretKey', 'mnemonic', 'sitesKey', 'mac', 'walletId', WALLET_ID]) {
      assert.ok(!text.includes(word), word);
    }
  });

  it('shows the Unicode host with an IDN flag, and punycode that fails to decode as is', () => {
    const table = [
      [SITE, SITE, false],
      ['https://app.aiqnet.io:8443', 'https://app.aiqnet.io:8443', false],
      ['https://xn--mnchen-3ya.aiqnet.io', 'https://münchen.aiqnet.io', true],
      ['https://xn--80ak6aa92e.com', 'https://аррӏе.com', true],
      ['https://xn--fiqs8s.aiqnet.io', 'https://中国.aiqnet.io', true],
      ['https://xn--ls8h.la', 'https://💩.la', true],
      [`${'http'}://localhost:3000`, `${'http'}://localhost:3000`, false],
    ];
    for (const [origin, text, idn] of table) assert.deepEqual(displayOrigin(origin), { text, idn }, origin);
    assert.deepEqual(displayOrigin('https://xn--zz.aiqnet.io'), { text: 'https://xn--zz.aiqnet.io', idn: true });
    assert.deepEqual(displayOrigin('not a url'), { text: 'not a url', idn: false });
  });

  it('shows the IDN warning data in the approval view', async () => {
    const idnOrigin = 'https://xn--80ak6aa92e.aiqnet.io';
    const w = createWorld({ manifest: manifestWithHosts(idnOrigin) });
    const port = w.connect(`${idnOrigin}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const view = (await (await w.shown()).get()).result;
    assert.equal(view.origin, idnOrigin);
    assert.equal(view.originDisplay, 'https://аррӏе.aiqnet.io');
    assert.equal(view.idn, true);
    await settleAll();
  });
});

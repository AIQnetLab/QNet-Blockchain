// qnet_unlinkNodeDevice (CONTRACTS.md decision 38) through the real router and provider state machine: served to
// https://aiqnet.io only, no grant read or created, the approval's view (nodes.unlinkView: the device the network names
// for this wallet's own light node), an armed confirm without the password running nodes.unlinkForSite, the answer (ok
// with unbound, or one of the unlink codes) re-checked before it leaves, and the window's own screens on the fake DOM.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { ProviderError, WalletError } from '../dist/background/errors.js';
import { UNLINK_ERROR_CODES } from '../dist/background/provider.js';
import { until } from './helpers/chrome-mock.mjs';
import { createPage } from './helpers/provider-dom.mjs';
import {
  ACCOUNTS, APP, NODE_ID, PASSWORD, SITE, createWorld, eventsOf, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

const ERROR_LINGER_MS = 30000;
const COOLDOWN_TEXT = 'Too many rejected requests from this site, try again later';
const LINKED_DAY = 1_790_035_200;
const unlink = (port, id, params) => port.send({ id, method: 'qnet_unlinkNodeDevice', ...(params === undefined ? {} : { params }) });
const answered = (port, id) => port.posted.some((message) => message.id === id);
const OK = Object.freeze({ status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, unbound: true });

let pageSeq = 0;
async function openPage(world, shown) {
  const page = createPage({
    query: `?id=${shown.id}`,
    runtime: world.chrome.runtime,
    send: (message) => world.router.handleUiMessage(message, shown.sender),
  });
  Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
  pageSeq += 1;
  await import(`../dist/ui/approve.js?unlink=${pageSeq}`);
  return page;
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.chrome;
});

const texts = (page, className) => page.app.byClass(className).map((element) => element.textContent);

describe('provider: qnet_unlinkNodeDevice', () => {
  it('aiqnet.io: one window with the device; the armed confirm unlinks it and answers ok with unbound', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/node`);
    unlink(port, 'u');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.kind, 'unlinkNodeDevice');
    assert.equal(view.origin, SITE);
    assert.deepEqual(view.details, {
      mode: 'confirm', reason: null, nodeId: NODE_ID, wallet: ACCOUNTS.qnet, platform: 'android', linkedSince: LINKED_DAY,
    });
    // no approval takes a password
    assert.equal((await shown.resolve(true, { password: PASSWORD })).error.code, 'INVALID_PARAMS');
    assert.equal(w.log.unlinks, 0);
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'ok', error: null });
    assert.equal(w.log.unlinks, 1);
    assert.deepEqual((await replyTo(port, 'u')).result, OK);
    assert.equal(await w.storedSites(), undefined, 'no grant is read or created');
    assert.deepEqual(eventsOf(port), []);
    await settleAll();
    assert.equal(w.openWindows.has(shown.windowId), true, 'the window stays on the outcome');
    w.fireTimers(ERROR_LINGER_MS);
    await until(() => !w.openWindows.has(shown.windowId));
  });

  it('refuses every other origin with 4100 before any window, and answers NO_WALLET at once without a vault', async () => {
    const w = createWorld();
    const other = w.connect(`${APP}/node`);
    unlink(other, 'x');
    assert.equal((await replyTo(other, 'x')).error.code, 4100);
    await assert.rejects(w.provider.handleRequest(Object.freeze({ origin: APP, tabId: 1, portId: 77 }), 'qnet_unlinkNodeDevice', {}),
      (error) => error instanceof ProviderError && error.code === 4100);
    w.state.vaultExists = false;
    const port = w.connect(`${SITE}/`);
    unlink(port, 'n');
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'NO_WALLET' });
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    assert.equal(w.log.unlinkViews, 0);
  });

  it('a reject answers 4001 and counts toward the cooldown; a confirm of a view the page did not draw reviews again', async () => {
    const c = { now: 1_800_000_000_000 };
    const w = createWorld({ now: () => c.now });
    const port = w.connect(`${SITE}/`);
    unlink(port, 'r');
    let shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true, { revision: 999 })).error.code, 'NONCE_CHANGED');
    assert.equal(w.log.unlinks, 0);
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
    assert.equal((await replyTo(port, 'r')).error.code, 4001);
    for (let i = 2; i <= LIMITS.APPROVAL_COOLDOWN_REJECTIONS; i += 1) {
      c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS / 3;
      unlink(port, `r${i}`);
      shown = await w.shown({ after: shown.windowId });
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
      assert.equal((await replyTo(port, `r${i}`)).error.code, 4001);
    }
    await settleAll();
    assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN][SITE].rejections.length,
      LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    unlink(port, 'late');
    assert.deepEqual((await replyTo(port, 'late')).error, { code: 4001, message: COOLDOWN_TEXT });
    assert.equal(w.log.unlinks, 0);
  });

  it('a view that cannot offer the unlink answers its reason, the unlink codes only, and counts nothing the first time', async () => {
    for (const [reason, code] of [['NOT_LINKED', 'NOT_LINKED'], ['NETWORK', 'NETWORK'], ['UNSUPPORTED', 'INTERNAL'], ['SIGNING_DISABLED', 'INTERNAL']]) {
      const w = createWorld();
      w.state.unlinkView = { mode: 'unavailable', reason, platform: null, linkedSince: null };
      const port = w.connect(`${SITE}/`);
      unlink(port, 'u');
      const shown = await w.shown();
      assert.equal((await shown.get()).result.details.reason, reason);
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'error', error: code });
      assert.deepEqual((await replyTo(port, 'u')).result, { status: 'error', error: code });
      unlink(port, 'u2');
      await w.shown({ after: shown.windowId });
      assert.equal(answered(port, 'u2'), false, 'no cooldown after it');
      assert.equal(w.log.unlinks, 0);
    }
  });

  it('sends the unlink\'s failures as results, only the unlink codes, and re-checks what nodes.js answers', async () => {
    const failures = [
      [new WalletError('NOT_LINKED'), 'NOT_LINKED'], [new WalletError('NETWORK'), 'NETWORK'], [new WalletError('UNLINK_REFUSED'), 'UNLINK_REFUSED'],
      [new WalletError('SIGNING_DISABLED'), 'INTERNAL'], [new Error('boom'), 'INTERNAL'],
    ];
    for (const [error, code] of failures) {
      const w = createWorld();
      w.state.unlinkError = error;
      const port = w.connect(`${SITE}/`);
      unlink(port, 'f');
      const shown = await w.shown();
      await shown.get();
      const reply = (await shown.resolve(true)).result;
      assert.equal(reply.status, 'error');
      assert.deepEqual((await replyTo(port, 'f')).result, { status: 'error', error: code });
    }
    assert.deepEqual([...UNLINK_ERROR_CODES].sort(), ['INTERNAL', 'NETWORK', 'NOT_LINKED', 'NO_WALLET', 'UNLINK_REFUSED']);
    // an answer about another node or wallet, or one the network did not take, never reaches the site as ok
    for (const outcome of [
      { ...OK, nodeId: 'light_mobile_0000000000000000' }, { ...OK, qnet: 'x' }, { ...OK, unbound: false }, { status: 'ok' },
    ]) {
      const w = createWorld();
      w.state.unlinkOutcome = outcome;
      const port = w.connect(`${SITE}/`);
      unlink(port, 'k');
      const shown = await w.shown();
      await shown.get();
      await shown.resolve(true);
      assert.deepEqual((await replyTo(port, 'k')).result, { status: 'error', error: 'INTERNAL' }, JSON.stringify(outcome));
    }
  });

  it('a view nodes.js cannot give, or one about another node, is never shown', async () => {
    for (const view of [{ nodeId: 'light_mobile_0000000000000000' }, { platform: 'windows' }, { linkedSince: -1 }, { mode: 'unavailable' }]) {
      const w = createWorld();
      w.state.unlinkView = view;
      const port = w.connect(`${SITE}/`);
      unlink(port, 'v');
      const shown = await w.shown();
      assert.equal((await shown.get()).result.details.mode, null, JSON.stringify(view));
      assert.equal((await shown.resolve(true)).error.code, 'NONCE_CHANGED', 'nothing reviewed: nothing is unlinked');
      assert.equal(w.log.unlinks, 0);
    }
  });
});

describe('approve page: the light node\'s device', () => {
  it('shows the node, the device and the day it was linked, arms, and says the device is unlinked', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    unlink(port, 'u');
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Unlink') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Unlink the node’s device?']);
    const text = page.app.textContent;
    assert.ok(text.includes(NODE_ID));
    assert.ok(text.includes('Android'), text);
    assert.ok(text.includes('Linked since'), text);
    assert.ok(text.includes('the node and its balance stay with this wallet'), text);
    assert.ok(!/\bnull\b|\bundefined\b|\bNaN\b/.test(text) && !/reward|earn|mining/i.test(text), text);
    assert.equal(page.app.querySelectorAll('input').length, 0, 'no password');
    const confirm = page.app.button('Unlink');
    assert.equal(confirm.disabled, true);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(confirm.disabled, false);
    confirm.click({ detail: 0, pointerType: '' });
    await settleAll();
    assert.equal(answered(port, 'u'), false, 'a key never confirms');
    confirm.click();
    assert.deepEqual((await replyTo(port, 'u')).result, OK);
    await until(() => page.app.textContent.includes('The device is unlinked. The node runs on no device now.'));
    assert.deepEqual(texts(page, 'ap-title'), ['Device unlinked']);
    page.app.button('Close').click();
    await until(() => page.window.closed);
  });

  it('a node no device runs, and a network that does not take the unlink yet, offer one Close that tells the site', async () => {
    for (const [reason, line, code] of [
      ['NOT_LINKED', 'This wallet’s light node runs on no device.', 'NOT_LINKED'],
      ['UNSUPPORTED', 'The QNet network does not take an unlink from the wallet yet.', 'INTERNAL'],
    ]) {
      const w = createWorld();
      w.state.unlinkView = { mode: 'unavailable', reason, platform: null, linkedSince: null };
      const port = w.connect(`${SITE}/`);
      unlink(port, 'e');
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Close') !== null);
      assert.ok(page.app.textContent.includes(line), page.app.textContent);
      assert.equal(page.app.button('Unlink'), null);
      page.app.button('Close').click();
      assert.deepEqual((await replyTo(port, 'e')).result, { status: 'error', error: code });
      await until(() => page.window.closed);
      delete globalThis.window;
    }
  });

  it('a refused unlink says so and stays until closed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.unlinkError = new WalletError('UNLINK_REFUSED');
    w.state.unlinkView = { platform: 'ios', linkedSince: null };
    const port = w.connect(`${SITE}/`);
    unlink(port, 'r');
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Unlink') !== null);
    assert.ok(page.app.textContent.includes('iPhone or iPad'));
    assert.ok(!page.app.textContent.includes('Linked since'), 'no day when the network names none');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    page.app.button('Unlink').click();
    assert.deepEqual((await replyTo(port, 'r')).result, { status: 'error', error: 'UNLINK_REFUSED' });
    await until(() => page.app.textContent.includes('The QNet network refused to unlink the device.'));
    assert.ok(page.app.button('Close'));
  });
});

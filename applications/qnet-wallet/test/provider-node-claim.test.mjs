// qnet_claimNodeBalance (QNet Link v1 section 14.10) through the real router and provider state machine: served to
// https://aiqnet.io only, no grant read or created, the approval's view (nodes.claimView: this wallet's own light node
// and the balance two nodes agree on), an armed confirm without the password running nodes.claimForSite, the claim
// answer of section 14.7 (ok, empty, error) re-checked before it leaves, and the window's own screens on the fake DOM.
// The light activation window's registration line and its longer stay are checked here too.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LIMITS, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { ProviderError, WalletError } from '../dist/background/errors.js';
import { CLAIM_ERROR_CODES } from '../dist/background/provider.js';
import { until } from './helpers/chrome-mock.mjs';
import { createPage } from './helpers/provider-dom.mjs';
import {
  ACCOUNTS, APP, NODE_ID, PASSWORD, SITE, createWorld, eventsOf, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

const ERROR_LINGER_MS = 30000;
const COOLDOWN_TEXT = 'Too many rejected requests from this site, try again later';
const claim = (port, id, params) => port.send({ id, method: 'qnet_claimNodeBalance', ...(params === undefined ? {} : { params }) });
const answered = (port, id) => port.posted.some((message) => message.id === id);
const TX_HASH = 'ef'.repeat(32);

let pageSeq = 0;
async function openPage(world, shown) {
  const page = createPage({
    query: `?id=${shown.id}`,
    runtime: world.chrome.runtime,
    send: (message) => world.router.handleUiMessage(message, shown.sender),
  });
  Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
  pageSeq += 1;
  await import(`../dist/ui/approve.js?claim=${pageSeq}`);
  return page;
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.chrome;
});

const texts = (page, className) => page.app.byClass(className).map((element) => element.textContent);

describe('provider: qnet_claimNodeBalance', () => {
  it('aiqnet.io: one window with the balance; the armed confirm moves it and answers the claim result', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/node`);
    claim(port, 'c');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.kind, 'claimNodeBalance');
    assert.equal(view.origin, SITE);
    assert.deepEqual(view.details, { mode: 'claim', reason: null, nodeId: NODE_ID, wallet: ACCOUNTS.qnet, amountNano: '2500000000' });
    // no approval takes a password
    assert.equal((await shown.resolve(true, { password: PASSWORD })).error.code, 'INVALID_PARAMS');
    assert.equal(w.log.claims, 0);
    assert.deepEqual((await shown.resolve(true)).result, {
      resolved: true, status: 'ok', error: null, amountNano: '2500000000', partial: false,
    });
    assert.deepEqual(w.log.views.filter((event) => event === 'balance'), ['balance'], 'the pages read the balances again');
    assert.equal(w.log.claims, 1);
    assert.deepEqual((await replyTo(port, 'c')).result, {
      status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '2500000000', txHash: TX_HASH, stoppedAtEpoch: null,
    });
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
    claim(other, 'x');
    assert.equal((await replyTo(other, 'x')).error.code, 4100);
    await assert.rejects(w.provider.handleRequest(Object.freeze({ origin: APP, tabId: 1, portId: 77 }), 'qnet_claimNodeBalance', {}),
      (error) => error instanceof ProviderError && error.code === 4100);
    w.state.vaultExists = false;
    const port = w.connect(`${SITE}/`);
    claim(port, 'n');
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'NO_WALLET' });
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    assert.equal(w.log.claimViews, 0);
  });

  it('a reject answers 4001 and counts toward the cooldown; a confirm of a view the page did not draw reviews again', async () => {
    const c = { now: 1_800_000_000_000 };
    const w = createWorld({ now: () => c.now });
    const port = w.connect(`${SITE}/`);
    claim(port, 'r');
    let shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true, { revision: 999 })).error.code, 'NONCE_CHANGED');
    assert.equal(w.log.claims, 0);
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
    assert.equal((await replyTo(port, 'r')).error.code, 4001);
    // one rejection bars nothing (owner, 28.09): the next ones open, and the fifth within 10 minutes bars the site
    for (let i = 2; i <= LIMITS.APPROVAL_COOLDOWN_REJECTIONS; i += 1) {
      c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS / 3;
      claim(port, `r${i}`);
      shown = await w.shown({ after: shown.windowId });
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
      assert.equal((await replyTo(port, `r${i}`)).error.code, 4001);
    }
    await settleAll();
    assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN][SITE].rejections.length,
      LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    claim(port, 'late');
    assert.deepEqual((await replyTo(port, 'late')).error, { code: 4001, message: COOLDOWN_TEXT });
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    assert.equal(w.log.claims, 0);
  });

  it('a balance below 1 QNC and a node that is not there answer empty and the reason, and count nothing the first time', async () => {
    const w = createWorld();
    w.state.claimView = { mode: 'empty', amountNano: '999999999' };
    const port = w.connect(`${SITE}/`);
    claim(port, 'e');
    let shown = await w.shown();
    assert.equal((await shown.get()).result.details.mode, 'empty');
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'empty', error: null });
    assert.deepEqual((await replyTo(port, 'e')).result, { status: 'empty', qnet: ACCOUNTS.qnet, nodeId: NODE_ID });
    for (const reason of ['NO_NODE', 'NETWORK', 'SIGNING_DISABLED']) {
      const world = createWorld();
      world.state.claimView = { mode: 'unavailable', reason, amountNano: null };
      const p = world.connect(`${SITE}/`);
      claim(p, 'u');
      shown = await world.shown();
      assert.equal((await shown.get()).result.details.reason, reason);
      await shown.resolve(false);
      assert.deepEqual((await replyTo(p, 'u')).result, { status: 'error', error: reason === 'SIGNING_DISABLED' ? 'INTERNAL' : reason });
      claim(p, 'u2');
      await world.shown({ after: shown.windowId });
      assert.equal(answered(p, 'u2'), false, 'no cooldown after it');
    }
    assert.equal(w.log.claims, 0);
  });

  it('sends the move\'s failures as results, only the protocol\'s codes, and re-checks what nodes.js answers', async () => {
    const failures = [
      [new WalletError('CLAIM_BUSY'), 'CLAIM_BUSY'], [new WalletError('CLAIM_REFUSED'), 'CLAIM_REFUSED'],
      [new WalletError('NO_NODE'), 'NO_NODE'], [new WalletError('NETWORK'), 'NETWORK'], [new WalletError('SIGNING_DISABLED'), 'INTERNAL'],
      [new Error('boom'), 'INTERNAL'],
    ];
    for (const [error, code] of failures) {
      const w = createWorld();
      w.state.claimError = error;
      const port = w.connect(`${SITE}/`);
      claim(port, 'f');
      const shown = await w.shown();
      await shown.get();
      assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'error', error: code });
      assert.deepEqual((await replyTo(port, 'f')).result, { status: 'error', error: code });
    }
    assert.deepEqual([...CLAIM_ERROR_CODES].sort(), ['CLAIM_BUSY', 'CLAIM_REFUSED', 'INTERNAL', 'NETWORK', 'NO_NODE', 'NO_WALLET']);
    // an answer about another node, a full move below 1 QNC, a part of nothing, a stop epoch that is no u64 string or no
    // hash never reaches the site
    for (const outcome of [
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: 'light_mobile_0000000000000000', amountNano: '2500000000', txHash: TX_HASH, stoppedAtEpoch: null },
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '5', txHash: TX_HASH, stoppedAtEpoch: null },
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '0', txHash: TX_HASH, stoppedAtEpoch: '812' },
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '5', txHash: TX_HASH, stoppedAtEpoch: 812 },
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '5', txHash: TX_HASH },
      { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '2500000000', txHash: null, stoppedAtEpoch: null },
      { status: 'empty', qnet: 'x', nodeId: NODE_ID },
    ]) {
      const w = createWorld();
      w.state.claimOutcome = outcome;
      const port = w.connect(`${SITE}/`);
      claim(port, 'k');
      const shown = await w.shown();
      await shown.get();
      await shown.resolve(true);
      assert.deepEqual((await replyTo(port, 'k')).result, { status: 'error', error: 'INTERNAL' }, JSON.stringify(outcome));
    }
    // a part of the balance: the stop epoch as a decimal string
    const w = createWorld();
    w.state.claimOutcome = { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '1500000000', txHash: TX_HASH, stoppedAtEpoch: '812' };
    const port = w.connect(`${SITE}/`);
    claim(port, 'p');
    const shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true)).result.partial, true);
    assert.equal((await replyTo(port, 'p')).result.stoppedAtEpoch, '812');
    // EXT-R2-01: a part below 1 QNC reaches the site as it is (the whole balance moves in several claims)
    const small = createWorld();
    const part = { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '30000000', txHash: TX_HASH, stoppedAtEpoch: '8' };
    small.state.claimOutcome = part;
    const smallPort = small.connect(`${SITE}/`);
    claim(smallPort, 's');
    const smallShown = await small.shown();
    await smallShown.get();
    assert.deepEqual((await smallShown.resolve(true)).result, { resolved: true, status: 'ok', error: null, amountNano: '30000000', partial: true });
    assert.deepEqual((await replyTo(smallPort, 's')).result, part);
  });

  it('answers exactly the claim answers of the shared vectors, without v and intent (QNet Link v1 section 14.10)', async () => {
    const vectors = JSON.parse(await readFile(new URL('../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
    // every claim answer but the app's `rejected` (the extension answers a reject with 4001): the four of section 14.7,
    // and any further one the vectors add (a part below 1 QNC: EXT-R2-01)
    const cases = vectors.link.cases.filter((c) => c.intent === 'claim' && JSON.parse(c.plaintext).status !== 'rejected');
    for (const name of ['claim-ok', 'claim-ok-partial', 'claim-empty', 'claim-error']) {
      assert.ok(cases.some((c) => c.name === name), name);
    }
    for (const c of cases) {
      const { v, intent, ...answer } = JSON.parse(c.plaintext);
      assert.deepEqual([v, intent], [1, 'claim']);
      const w = createWorld();
      if (answer.status === 'error') w.state.claimError = new WalletError(answer.error);
      else w.state.claimOutcome = answer;
      const port = w.connect(`${SITE}/`);
      claim(port, 'q');
      const shown = await w.shown();
      await shown.get();
      await shown.resolve(true);
      assert.deepEqual((await replyTo(port, 'q')).result, answer, c.name);
    }
  });

  it('a view nodes.js cannot give, or one about another node, is never shown', async () => {
    const w = createWorld();
    w.state.claimView = { nodeId: 'light_mobile_0000000000000000' };
    const port = w.connect(`${SITE}/`);
    claim(port, 'v');
    const shown = await w.shown();
    assert.equal((await shown.get()).result.details.mode, null);
    assert.equal((await shown.resolve(true)).error.code, 'NONCE_CHANGED', 'nothing reviewed: nothing moves');
    assert.equal(w.log.claims, 0);
  });
});

describe('approve page: the node balance', () => {
  it('shows the node and its balance, arms like a transaction, and says what moved', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.claimOutcome = { status: 'ok', qnet: ACCOUNTS.qnet, nodeId: NODE_ID, amountNano: '1500000000', txHash: TX_HASH, stoppedAtEpoch: '9' };
    const port = w.connect(`${SITE}/`);
    claim(port, 'c');
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Move to wallet') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Move node balance to this wallet?']);
    const text = page.app.textContent;
    assert.ok(text.includes(NODE_ID));
    assert.ok(text.includes('2.5 QNC'), text);
    // the node and its balance, with no paragraph on how the balance is read or moved (owner, 28.09)
    assert.ok(!text.includes('Two QNet nodes report this balance alike.'));
    assert.ok(!text.includes('Moves at 1 QNC or more') && !text.includes('once a block includes it'));
    assert.ok(!/\bnull\b|\bundefined\b|NaN|reward|earn|mining/i.test(text), text);
    assert.equal(page.app.querySelectorAll('input').length, 0, 'no password');
    const confirm = page.app.button('Move to wallet');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(confirm.disabled, true, 'it arms like a transaction');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - TIMINGS.CONFIRM_ARM_MS);
    assert.equal(confirm.disabled, false);
    confirm.click({ detail: 0, pointerType: '' });
    await settleAll();
    assert.equal(answered(port, 'c'), false, 'a key never confirms');
    confirm.click();
    await replyTo(port, 'c');
    await until(() => page.app.textContent.includes('The move of 1.5 QNC was submitted'));
    assert.ok(!page.app.textContent.includes('once a block includes it'), 'no line on how the network credits it (owner, 28.09)');
    assert.ok(page.app.textContent.includes('Part of the balance moved'));
    page.app.button('Close').click();
    await until(() => page.window.closed);
  });

  it('a balance below 1 QNC offers one Close that tells the site', async () => {
    const w = createWorld();
    w.state.claimView = { mode: 'empty', amountNano: '100' };
    const port = w.connect(`${SITE}/`);
    claim(port, 'e');
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Close') !== null);
    assert.ok(page.app.textContent.includes('below 1 QNC'));
    assert.equal(page.app.button('Move to wallet'), null);
    page.app.button('Close').click();
    assert.deepEqual((await replyTo(port, 'e')).result, { status: 'empty', qnet: ACCOUNTS.qnet, nodeId: NODE_ID });
    await until(() => page.window.closed);
  });
});

describe('qnet_activateNode: the light node\'s record on the QNet network', () => {
  it('after a light answer the window shows the record and stays up to REGISTRATION_WINDOW_MS; the site result is unchanged', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.registration = { nodeId: NODE_ID, state: 'queued', attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true };
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const shown = await w.shown();
    await shown.get();
    const resolved = (await shown.resolve(true)).result;
    assert.deepEqual(resolved.registration, { nodeId: NODE_ID, state: 'queued', automatic: true, deferred: false });
    const result = (await replyTo(port, 'a')).result;
    assert.deepEqual(Object.keys(result).sort(), ['burnAmount', 'burnTx', 'code', 'nodeType', 'qnet', 'solana', 'status']);
    await settleAll();
    w.fireTimers(ERROR_LINGER_MS);
    await settleAll();
    assert.equal(w.openWindows.has(shown.windowId), true, 'not the short linger while it is recorded');
    w.fireTimers(TIMINGS.REGISTRATION_WINDOW_MS);
    await until(() => !w.openWindows.has(shown.windowId));
  });

  it('the page follows the record after the answer, with no line on it before the confirm', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.registration = { nodeId: NODE_ID, state: 'queued', attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true };
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Burn 1500 1DEV') !== null);
    assert.ok(!page.app.textContent.includes('Then the wallet records its light node on the QNet network'));
    const [ack] = page.app.querySelectorAll('input');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    ack.checked = true;
    ack.fire('change');
    page.app.button('Burn 1500 1DEV').click();
    await replyTo(port, 'a');
    await until(() => page.app.textContent.includes('Recording on the QNet network'));
    w.state.registration = { ...w.state.registration, state: 'onchain', automatic: false };
    t.mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await until(() => page.app.textContent.includes('Recorded on the QNet network for this wallet.'));
  });
});

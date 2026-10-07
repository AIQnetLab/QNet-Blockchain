// ui/approve.js against the real router and provider state machine, in a DOM stub (spec: Approvals;
// EXT-01, MISS-03, R13, anti-clickjacking): the origin from the worker with the IDN warning, the exact
// message, the wallet-set fee and nonce, unlock first, confirm armed after 1 s for trusted clicks in a
// focused window only and no password once unlocked, and the window closing when its approval ends.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../dist/lib/qnet-core.js';
import { formatUnits } from '../dist/background/amount.js';
import { SOLANA, TIMINGS } from '../dist/background/config.js';
import { WalletError } from '../dist/background/errors.js';
import { createRouter } from '../dist/background/router.js';
import { until } from './helpers/chrome-mock.mjs';
import { createPage } from './helpers/provider-dom.mjs';
import {
  ACCOUNTS, GAME, PASSWORD, SITE, TOKEN, activationRecord, createWorld, manifestWithHosts, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

let pageSeq = 0;

// Loads a fresh copy of approve.js as the page of the approval shown in `shown`'s window.
async function openPage(world, shown) {
  const page = createPage({
    query: `?id=${shown.id}`,
    runtime: world.chrome.runtime,
    send: (message) => world.router.handleUiMessage(message, shown.sender),
  });
  Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
  pageSeq += 1;
  await import(`../dist/ui/approve.js?page=${pageSeq}`);
  return page;
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.chrome;
});

const texts = (page, className) => page.app.byClass(className).map((element) => element.textContent);

const noStrayValues = (page) => assert.ok(!/\bnull\b|\bundefined\b|NaN/.test(page.app.textContent), page.app.textContent);
const answered = (port, id) => port.posted.some((message) => message.id === id);

describe('approve page', () => {
  it('connect: shows the origin and both addresses; confirm arms after 1 s and takes only trusted, focused clicks', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.textContent.includes(ACCOUNTS.solana));
    assert.deepEqual(texts(page, 'ap-title'), ['Connect this site?']);
    assert.deepEqual(texts(page, 'ap-origin-host'), [SITE]);
    assert.deepEqual(page.app.byClass('ap-warning'), []);
    assert.ok(page.app.textContent.includes(ACCOUNTS.qnet));
    noStrayValues(page);
    assert.ok(page.document.head.childNodes.some((node) => node.getAttribute('href') === 'approve.css'));

    const confirm = page.app.button('Connect');
    assert.equal(confirm.disabled, true);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS - 1);
    assert.equal(confirm.disabled, true);
    t.mock.timers.tick(1);
    assert.equal(confirm.disabled, false);

    confirm.click({ isTrusted: false });
    // ES-02: Enter or Space on the focused button is a trusted click too, but no pointer made it
    confirm.click({ detail: 0, pointerType: '' });
    confirm.click({ detail: 1, pointerType: '' });
    page.document.focused = false;
    confirm.click();
    await settleAll();
    assert.equal(answered(port, 'c'), false, 'synthetic, keyboard and unfocused clicks do nothing');

    page.document.focused = true;
    confirm.click();
    assert.deepEqual(await replyTo(port, 'c'), { id: 'c', ok: true, result: ACCOUNTS });
    await until(() => page.window.closed);
  });

  // R4-ERP-01: wherever the window opened, the gap above the actions is drawn at random with every view, so a page
  // that knows the window's place and the layout still does not know where Confirm is.
  it('empties the extension\'s web storage when it opens, as every page does (a copy of a 2.x password lived there, M-4)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const fakeStorage = (entries) => {
      const items = new Map(Object.entries(entries));
      return { get length() { return items.size; }, clear() { items.clear(); } };
    };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const local = fakeStorage({ qnet_wallet_password_hash: 'cGFzc3dvcmRxbmV0X3NhbHRfMjAyNQ==' });
    Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
    try {
      const w = createWorld();
      const port = w.connect(`${SITE}/`);
      port.send({ id: 'c', method: 'qnet_requestAccounts' });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.textContent.includes(ACCOUNTS.solana));
      assert.equal(local.length, 0);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      else delete globalThis.localStorage;
    }
  });

  it('draws a random gap right above the actions with every view', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    const gaps = new Set();
    for (let i = 0; i < 16; i += 1) {
      const page = await openPage(w, shown);
      await until(() => page.app.button('Connect') !== null);
      const shifts = page.app.byClass('ap-shift');
      assert.equal(shifts.length, 1);
      const [step] = shifts[0].className.split(/\s+/).filter((name) => /^ap-shift-[0-6]$/.test(name));
      assert.ok(step, shifts[0].className);
      gaps.add(step);
      const order = page.app.childNodes;
      const actions = order.findIndex((node) => node.className === 'ap-actions');
      assert.equal(order[actions - 1], shifts[0], 'the gap sits right above the actions');
      assert.equal(shifts[0].getAttribute('aria-hidden'), 'true');
    }
    assert.ok(gaps.size >= 3, [...gaps].join(' '));
    const css = await readFile(new URL('../dist/ui/approve.css', import.meta.url), 'utf8');
    for (let n = 0; n < 7; n += 1) {
      assert.match(css, new RegExp(`\\.ap-shift-${n} \\{ height: ${n === 0 ? '0' : `${n * 16}px`}; \\}`));
    }
  });

  it('losing focus disarms confirm; regaining it starts the delay again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Connect') !== null);
    const confirm = page.app.button('Connect');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(confirm.disabled, false);
    page.window.fire('blur');
    assert.equal(confirm.disabled, true);
    page.window.fire('focus');
    assert.equal(confirm.disabled, true);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(confirm.disabled, false);
    page.app.button('Reject').click();
    assert.equal((await replyTo(port, 'c')).error.code, 4001);
    await until(() => page.window.closed);
  });

  it('locked: unlock first with a hardened password field; a granted connect resolves right after the unlock', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld({ unlocked: false });
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.querySelectorAll('input').length === 1);
    const [input] = page.app.querySelectorAll('input');
    for (const [name, value] of Object.entries({
      type: 'password', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', 'data-gramm': 'false',
    })) {
      assert.equal(input.getAttribute(name), value, name);
    }
    // no cursor on its own: the window opens at a site's request, and keystrokes meant for that page must not land in
    // the password field (owner, 06.10: no field of any page takes the cursor on its own)
    assert.notEqual(page.document.activeElement, input);
    input.value = 'wrong password';
    page.app.button('Unlock').click();
    assert.equal(input.value, '', 'the field is emptied as soon as the password is sent');
    await until(() => page.app.textContent.includes('Wrong password.'));
    assert.notEqual(page.document.activeElement, input, 'a wrong password does not put the cursor back in the field (owner, 06.10)');
    assert.equal(answered(port, 'c'), false);

    input.value = PASSWORD;
    input.fire('keydown', { key: 'Enter' });
    assert.deepEqual(await replyTo(port, 'c'), { id: 'c', ok: true, result: ACCOUNTS });
    await until(() => page.window.closed);
    assert.deepEqual(w.log.unlockAttempts, ['wrong password', PASSWORD]);
  });

  // Locked, the window asks for the password once, to unlock; the request is then shown with its armed confirm and
  // never asks again (owner, 29.09).
  it('activateNode, locked: the unlock is the only password; the burn is then confirmed without it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld({ unlocked: false });
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Unlock') !== null);
    assert.equal(w.log.siteViews.length, 0, 'nothing read while locked');
    const [input] = page.app.querySelectorAll('input');
    assert.equal(input.getAttribute('type'), 'password');
    input.value = PASSWORD;
    page.app.button('Unlock').click();
    await until(() => page.app.button('Burn 1500 1DEV') !== null);
    assert.deepEqual(page.app.querySelectorAll('input').map((node) => node.getAttribute('type')), ['checkbox']);
    const [ack] = page.app.querySelectorAll('input');
    ack.checked = true;
    ack.fire('change');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Burn 1500 1DEV').click();
    await until(() => page.app.textContent.includes('The burn is finalized. The site received the activation code.'));
    assert.deepEqual(w.log.unlockAttempts, [PASSWORD]);
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: 1500 }]);
    assert.equal((await replyTo(port, 'a')).result.status, 'ok');
  });

  it('signMessage: the exact text and byte count under a warned IDN origin; reject answers 4001', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const idn = 'https://xn--80ak6aa92e.aiqnet.io';
    const w = createWorld({ manifest: manifestWithHosts(idn) });
    await w.grant(idn);
    const port = w.connect(`${idn}/`);
    const message = 'Line one\n  Line two\twith a tab';
    port.send({ id: 's', method: 'qnet_signMessage', params: { message } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.byClass('ap-message').length === 1);
    assert.deepEqual(texts(page, 'ap-title'), ['Sign this message?']);
    assert.deepEqual(texts(page, 'ap-origin-host'), ['https://аррӏе.aiqnet.io']);
    const [warning] = page.app.byClass('ap-warning');
    assert.ok(warning.textContent.includes(idn), 'the browser-reported form is shown next to the warning');
    assert.equal(warning.getAttribute('role'), 'alert');
    assert.deepEqual(texts(page, 'ap-message'), [message]);
    assert.ok(page.app.textContent.includes(`Size in bytes: ${Buffer.byteLength(message)}`));
    noStrayValues(page);
    page.app.button('Reject').click();
    assert.deepEqual(await replyTo(port, 's'), { id: 's', ok: false, error: { code: 4001, message: 'User rejected the request' } });
    await until(() => page.window.closed);
    assert.deepEqual(w.log.signCalls, []);
  });

  it('sendTransaction: wallet-set fee and nonce; a changed nonce asks for a new review before sending', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '2.5' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    const values = () => texts(page, 'ap-row-value');
    assert.deepEqual(values(), ['QNet testnet (q1337)', '2.5 QNC', '0.00015 QNC', '2.50015 QNC', '5', '10 QNC']);
    assert.ok(page.app.textContent.includes(ACCOUNTS.qnet), 'the full recipient address');
    // no always-on compare-the-characters line (owner, 28.09)
    assert.ok(!page.app.textContent.includes('first and last characters'));
    noStrayValues(page);

    w.state.nonce = '6';
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Send').click();
    await until(() => page.app.byClass('ap-notice').length === 1);
    assert.equal(values()[4], '6');
    assert.equal(answered(port, 't'), false);
    const again = page.app.button('Send');
    assert.equal(again.disabled, true, 'the new values get the full delay too');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    again.click();
    assert.deepEqual(await replyTo(port, 't'), {
      id: 't', ok: true,
      result: { status: 'submitted', from: ACCOUNTS.qnet, to: ACCOUNTS.qnet, amount: '2.5', nonce: '6', txHash: 'ab'.repeat(32) },
    });
    await until(() => page.window.closed);
    assert.deepEqual(w.log.sendCalls.map((call) => call.expectedNonce), ['5', '6']);
  });

  it('sendTransaction: a balance below the total keeps confirm disabled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.balanceNano = '2500000000';
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '2.5' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS * 3);
    assert.equal(page.app.button('Send').disabled, true);
    assert.ok(page.app.textContent.includes('The balance does not cover the amount and the fee.'));
    page.app.button('Reject').click();
    await until(() => page.window.closed);
  });

  // Owner, 28.09: the window shows the balance, never how it was verified (EXT-CHAINS-04); the worker previews only a
  // balance the committee certified, and refuses a send on any other.
  it('sendTransaction: shows the balance with no verification row, whatever backs it (EXT-CHAINS-04)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    for (const verification of ['proof', 'none']) {
      const w = createWorld();
      w.state.verification = verification;
      await w.grant(SITE);
      const port = w.connect(`${SITE}/`);
      port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Send') !== null);
      assert.equal(page.app.byClass('ap-row-value').at(-1).textContent, '10 QNC', verification);
      assert.ok(!/Verified|verified|proof|two nodes/.test(page.app.textContent), `${verification}: ${page.app.textContent}`);
      page.app.button('Reject').click();
      await until(() => page.window.closed);
    }
  });

  it('sendTransaction: a first send gets a note; a look-alike of a paid address or an incoming-only sender an alert (ES-01)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const check = (known, lookalike, incomingOnly) => ({ known, lookalike, incomingOnly, historyRead: true });
    for (const [recipient, expected, role] of [
      [check(false, false, false), 'has not sent to this address before', 'note'],
      [check(true, false, false), null, null],
      [check(false, true, false), 'address-poisoning', 'alert'],
      [check(false, false, true), 'only sent to this wallet', 'alert'],
    ]) {
      const w = createWorld();
      w.state.recipient = recipient;
      await w.grant(SITE);
      const port = w.connect(`${SITE}/`);
      port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Send') !== null);
      const warnings = page.app.byClass('ap-warning');
      if (expected === null) {
        assert.deepEqual(warnings, []);
      } else {
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].textContent.includes(expected), warnings[0].textContent);
        assert.equal(warnings[0].getAttribute('role'), role);
      }
      noStrayValues(page);
      page.app.button('Reject').click();
      assert.equal((await replyTo(port, 't')).error.code, 4001);
      await until(() => page.window.closed);
    }
  });

  // R3-EXTQ-01: the wallet's own records name a second payment the archive could not. An unread history is no longer
  // described on screen (owner, 28.09); the check is unchanged.
  it('sendTransaction: names a second payment from the wallet\'s records, with no text on an unread history (R3-EXTQ-01)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.recipient = { known: true, lookalike: false, incomingOnly: false, historyRead: false };
    w.state.duplicate = true;
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    const warning = page.app.byClass('ap-warning').map((node) => node.textContent).join(' ');
    assert.ok(!warning.includes('history could not be read'), warning);
    assert.ok(/twice/.test(warning), warning);
    page.app.button('Reject').click();
    await until(() => page.window.closed);
  });

  it('a failed action stays on screen until closed; the dApp gets -32603', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    w.state.sendError = new WalletError('NODE_REJECTED');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Send').click();
    await until(() => page.app.button('Close') !== null);
    assert.ok(page.app.textContent.includes('A node refused the transaction'));
    assert.equal((await replyTo(port, 't')).error.code, -32603);
    t.mock.timers.tick(TIMINGS.APPROVAL_HEARTBEAT_MS * 2);
    await settleAll();
    assert.equal(page.window.closed, false, 'the heartbeat stops once the outcome is shown');
    page.app.button('Close').click();
    assert.equal(page.window.closed, true);
  });

  it('the heartbeat closes the window once its approval is gone', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Connect') !== null);
    port.close();
    await until(() => w.provider.snapshot().queued === 0);
    t.mock.timers.tick(TIMINGS.APPROVAL_HEARTBEAT_MS);
    await until(() => page.window.closed);
  });

  it('activateNode: the burn and its one confirmation line, no password; confirm needs the acknowledgement, 1.5 s and a trusted click', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Burn 1500 1DEV') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Activate a Light node?']);
    assert.deepEqual(texts(page, 'ap-kicker'), ['Activation request']);
    assert.deepEqual(texts(page, 'ap-origin-host'), [SITE]);
    const text = page.app.textContent;
    for (const expected of ['1500 1DEV', SOLANA.ONE_DEV_MINT, core.SOLANA_PROGRAMS.TOKEN, ACCOUNTS.solana,
      'I understand that 1500 1DEV will be destroyed and that this wallet gets exactly one code.', 'The site receives both addresses']) {
      assert.ok(text.includes(expected), expected);
    }
    // the burn is irreversible: the acknowledgement is its one confirmation line, with no warning list (owner, 28.09)
    for (const removed of ['Read before you burn', 'Nobody receives them', 'cannot be undone', 'this wallet can never get another code',
      'records its light node on the QNet network']) {
      assert.ok(!text.includes(removed), removed);
    }
    assert.deepEqual(page.app.byClass('ap-warning'), []);
    noStrayValues(page);
    // the unlocked session confirms: the one input is the acknowledgement
    const inputs = page.app.querySelectorAll('input');
    assert.deepEqual(inputs.map((input) => input.getAttribute('type')), ['checkbox']);
    assert.ok(!page.app.textContent.includes('Wallet password'));
    const [ack] = inputs;
    const burn = page.app.button('Burn 1500 1DEV');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    assert.equal(burn.disabled, true, 'no acknowledgement');
    ack.checked = true;
    ack.fire('change');
    assert.equal(burn.disabled, false);
    burn.click({ isTrusted: false });
    burn.click({ detail: 0, pointerType: '' });
    await settleAll();
    assert.equal(w.log.activations.length, 0, 'a synthetic click or a key does nothing (ES-02)');
    let open = null;
    w.state.gates.unlock = new Promise((resolve) => {
      open = resolve;
    });
    burn.click();
    // while it burns: the title, a progress bar and the time, no list of what the wallet does inside (owner, 28.09)
    await until(() => page.app.textContent.includes('Burning 1500 1DEV'));
    assert.deepEqual(page.app.byClass('steps'), []);
    assert.ok(!/simulating|Deriving|no earlier burn|Checking the price/.test(page.app.textContent), page.app.textContent);
    open();
    w.state.gates.unlock = null;
    await until(() => page.app.textContent.includes('The burn is finalized. The site received the activation code.'));
    assert.ok(!page.app.textContent.includes('server’s settings'), 'a Light code has no server');
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: 1500 }]);
    assert.equal((await replyTo(port, 'a')).result.status, 'ok');
    assert.equal(page.window.closed, false, 'the outcome stays until closed');
    page.app.button('Close').click();
    assert.equal(page.window.closed, true);
  });

  it('activateNode: sharing the code takes the armed confirm alone, a changed price reviews again; a view that cannot offer the action tells the site why', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const record = activationRecord('super');
    const { code, ...rest } = record;
    w.state.siteView = { mode: 'exists', cost: null, activation: { ...rest, codeMasked: `${code.slice(0, 6)}•••` }, balances: null };
    w.state.activateOutcome = { status: 'exists', activation: record };
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'e', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Share the code') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Share your activation code?']);
    assert.ok(!page.app.textContent.includes(code), 'the window never shows the code');
    assert.equal(page.app.querySelectorAll('input').length, 0, 'no password');
    // the worker refuses the view the page drew (the price or the wallet changed): the window reviews again
    w.state.activateError = new WalletError('PRICE_CHANGED');
    const share = page.app.button('Share the code');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - 1);
    assert.equal(share.disabled, true, 'it arms like a transaction');
    t.mock.timers.tick(1);
    share.click();
    await until(() => page.app.byClass('ap-notice').length === 1);
    assert.deepEqual(texts(page, 'ap-notice'), ['The price or the wallet changed. Review this request again and confirm.']);
    assert.equal(answered(port, 'e'), false);
    w.state.activateError = null;
    const again = page.app.button('Share the code');
    assert.equal(again.disabled, true, 'the review arms from the start');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    again.click();
    await until(() => page.app.textContent.includes('The site received this wallet’s activation code.'));
    assert.equal((await replyTo(port, 'e')).result.code, code);
    assert.ok(!page.app.textContent.includes('Another device'), 'no burn of this window to name');
    // decision 36: a Super code goes to its server, and the site shows its settings
    assert.ok(page.app.textContent.includes('aiqnet.io shows the code, the burn and the server’s settings on My node’s Overview.'));

    const other = createWorld();
    other.state.siteView = { mode: 'unavailable', reason: 'INSUFFICIENT_TOKENS', cost: 1500, balances: { lamports: '5000', oneDevRaw: '1000000' } };
    const otherPort = other.connect(`${SITE}/`);
    otherPort.send({ id: 'u', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const otherPage = await openPage(other, await other.shown());
    await until(() => otherPage.app.button('Close') !== null);
    assert.deepEqual(texts(otherPage, 'ap-title'), ['Activation is not possible now']);
    assert.ok(otherPage.app.textContent.includes('Not enough 1DEV.'));
    assert.equal(otherPage.app.querySelectorAll('input').length, 0);
    assert.equal(otherPage.app.querySelectorAll('button').length, 1);
    otherPage.app.button('Close').click();
    assert.deepEqual((await replyTo(otherPort, 'u')).result, { status: 'error', error: 'INSUFFICIENT_TOKENS' });
    await until(() => otherPage.window.closed);
  });

  // EXT-R2-02: a node aiqnet.io paid for, whose code the vault holds, sends the user to the Activate tab where that code
  // is, not to a Recover it does not offer; the site still learns NODE_EXISTS
  it('activateNode: a node paid on aiqnet.io says where its code is, and the site learns NODE_EXISTS (EXT-R2-02)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { code, ...rest } = activationRecord('light');
    const paid = createWorld();
    paid.state.siteView = {
      mode: 'unavailable', reason: 'NODE_EXISTS', cost: null, balances: null,
      activation: { ...rest, codeMasked: `${code.slice(0, 6)}•••`, paidOnSite: true },
    };
    const port = paid.connect(`${SITE}/`);
    port.send({ id: 'n', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(paid, await paid.shown());
    await until(() => page.app.button('Close') !== null);
    const text = page.app.textContent;
    assert.ok(text.includes('This wallet’s node was activated with a burn on aiqnet.io, and its code is in Settings.'), text);
    assert.ok(!text.includes('Recover my code'), text);
    assert.ok(!text.includes(code), 'the window never shows the code');
    noStrayValues(page);
    assert.equal(page.app.querySelectorAll('input').length, 0);
    page.app.button('Close').click();
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'NODE_EXISTS' });
    await until(() => page.window.closed);
    // a node the network knows while the vault holds no activation still points to Recover, which the tab then offers
    const known = createWorld();
    known.state.siteView = { mode: 'unavailable', reason: 'NODE_EXISTS', cost: null, balances: null, activation: null };
    known.connect(`${SITE}/`).send({ id: 'm', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const knownPage = await openPage(known, await known.shown());
    await until(() => knownPage.app.button('Close') !== null);
    assert.ok(knownPage.app.textContent.includes('Use Recover my code on the Activate tab'), knownPage.app.textContent);
    assert.ok(!knownPage.app.textContent.includes('with a burn on aiqnet.io'));
  });

  // EXT-R2A-03: the node listed with another burn's registration: the window says so instead of "the wallet records it
  // too", and the line after the answer never says this burn is recorded
  it('activateNode: a light node the network lists with another burn says so, before and after the answer (EXT-R2A-03)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const other = {
      nodeId: core.lightNodeId(ACCOUNTS.qnet), state: 'other_burn', attempts: 1, lastError: null, txHash: null, updatedAt: 1,
      automatic: false, deferred: false,
    };
    const record = activationRecord('light');
    const { code, ...rest } = record;
    const w = createWorld();
    w.state.siteView = { mode: 'exists', cost: null, activation: { ...rest, codeMasked: `${code.slice(0, 6)}•••` }, balances: null, registration: other };
    w.state.activateOutcome = { status: 'exists', activation: record };
    w.state.registration = other;
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'o', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Share the code') !== null);
    const text = page.app.textContent;
    assert.ok(text.includes('recorded on the QNet network with another 1DEV burn'), text);
    assert.ok(!text.includes('the wallet records it too'), text);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Share the code').click();
    await until(() => page.app.textContent.includes('The site received this wallet’s activation code.'));
    assert.ok(page.app.textContent.includes('The burn made here recorded nothing'), page.app.textContent);
    assert.ok(!page.app.textContent.includes('Recorded on the QNet network for this wallet'));
    assert.equal((await replyTo(port, 'o')).result.status, 'exists');
  });

  // Decision 36: the burn says where the node runs before it is confirmed; a Super node only on the user's own server
  it('activateNode: the burn names where the node runs, a Light node in QNet Wallet on a phone or tablet, a Super node on a server', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    for (const [nodeType, title, line, not] of [
      ['light', 'Activate a Light node?', 'Runs in QNet Wallet on a phone or tablet.', 'own server'],
      ['super', 'Activate a Super node?', 'Runs on your own server with the QNet node software.', 'phone or tablet'],
    ]) {
      const w = createWorld();
      const port = w.connect(`${SITE}/activate`);
      port.send({ id: nodeType, method: 'qnet_activateNode', params: { nodeType } });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Burn 1500 1DEV') !== null);
      assert.deepEqual(texts(page, 'ap-title'), [title]);
      assert.ok(page.app.textContent.includes(line), `${nodeType}: ${page.app.textContent}`);
      assert.ok(!page.app.textContent.includes(not), nodeType);
      assert.equal(answered(port, nodeType), false);
    }
  });

  // Decision 36: a light registration the one-node rule refused (this wallet has a node of either type) is said as that
  // refusal after the answer, never as one to try again later, although the answer's registration names no lastError
  it('activateNode: after the answer, a record the one-node rule refused says so, and never "try again later"', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const refused = {
      nodeId: core.lightNodeId(ACCOUNTS.qnet), state: 'refused', attempts: 1, lastError: 'wallet_has_node', txHash: null, updatedAt: 1,
      automatic: false, deferred: false,
    };
    const record = activationRecord('light');
    const { code, ...rest } = record;
    const w = createWorld();
    w.state.siteView = { mode: 'exists', cost: null, activation: { ...rest, codeMasked: `${code.slice(0, 6)}•••` }, balances: null, registration: refused };
    w.state.activateOutcome = { status: 'exists', activation: record };
    w.state.registration = refused;
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'w', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Share the code') !== null);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Share the code').click();
    await until(() => page.app.textContent.includes('The QNet network refused the record: this wallet already has a node. One wallet, one node.'));
    assert.ok(!page.app.textContent.includes('Try again later'), page.app.textContent);
    assert.equal((await replyTo(port, 'w')).result.status, 'exists');
    // a refusal of another kind keeps its own line
    const other = createWorld();
    const stopped = { ...refused, lastError: 'http_500' };
    other.state.siteView = { ...w.state.siteView, registration: stopped };
    other.state.activateOutcome = { status: 'exists', activation: record };
    other.state.registration = stopped;
    const otherPort = other.connect(`${SITE}/`);
    otherPort.send({ id: 'r', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const otherPage = await openPage(other, await other.shown());
    await until(() => otherPage.app.button('Share the code') !== null);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    otherPage.app.button('Share the code').click();
    await until(() => otherPage.app.textContent.includes('The QNet network did not accept the record.'));
    await settleAll();
    assert.ok(!otherPage.app.textContent.includes('One wallet, one node'));
  });

  // EXT-FA1-02: a light activation's registration moving on (queued, admitted, deferred) while the confirm is armed
  // neither redraws the window nor disarms it; the node listed on chain changes the view the window reviews, and that
  // redraw arms the confirm again from the start. The window no longer describes the record (owner, 28.09).
  it('activateNode: the registration moving on never redraws the armed confirm; the node listed on chain arms it again (EXT-FA1-02)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const nodeId = core.lightNodeId(ACCOUNTS.qnet);
    const registration = (state, extra = {}) => ({
      nodeId, state, attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true, deferred: false, ...extra,
    });
    const record = activationRecord('light');
    const { code, ...rest } = record;
    const w = createWorld();
    w.state.siteView = {
      mode: 'exists', cost: null, activation: { ...rest, codeMasked: `${code.slice(0, 6)}•••` }, balances: null,
      registration: registration('queued', { deferred: true }),
    };
    w.state.activateOutcome = { status: 'exists', activation: record };
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'k', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Share the code') !== null);
    assert.ok(!page.app.textContent.includes('the wallet records it too'), 'no line on the record');
    const armed = page.app.button('Share the code');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    assert.equal(armed.disabled, false);

    for (const step of [registration('queued'), registration('admitted', { attempts: 1, txHash: 'ab'.repeat(32) })]) {
      w.state.siteView = { ...w.state.siteView, registration: step };
      const reads = w.log.siteViews.length;
      t.mock.timers.tick(TIMINGS.APPROVAL_HEARTBEAT_MS);
      await until(() => w.log.siteViews.length > reads);
      await settleAll();
      assert.equal(page.app.button('Share the code'), armed, `${step.state}: no redraw`);
      assert.equal(armed.disabled, false, `${step.state}: still armed`);
    }

    // the chain lists the node: the screen is drawn again and its confirm arms from the start
    w.state.siteView = { ...w.state.siteView, registration: registration('onchain', { automatic: false }) };
    t.mock.timers.tick(TIMINGS.APPROVAL_HEARTBEAT_MS);
    await until(() => page.app.button('Share the code') !== armed);
    const share = page.app.button('Share the code');
    assert.equal(share.disabled, true, 'the confirm arms again from the start');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    assert.equal(share.disabled, false);
    share.click();
    await until(() => page.app.textContent.includes('The site received this wallet’s activation code.'));
    assert.ok(!page.app.textContent.includes('The price or the wallet changed'));
    assert.equal((await replyTo(port, 'k')).result.code, code);
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: null }]);
  });

  it('shows every text in the wallet\'s language', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.router = createRouter({
      runtime: w.chrome.runtime,
      handlers: {
        'approval.get': w.provider.getApproval,
        'approval.resolve': w.provider.resolveApproval,
        'settings.get': async () => ({ autoLockMinutes: 15, language: 'de' }),
      },
      requireUnlocked: async () => {},
      touch: async () => {},
      providerRequest: w.provider.handleRequest,
      providerPortClosed: w.provider.onPortClosed,
    });
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'super' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Ablehnen') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Einen Super-Knoten aktivieren?']);
    assert.ok(page.app.button('1500 1DEV verbrennen') !== null);
    assert.equal(page.document.title, 'Anfrage an QNet Wallet');
    page.app.button('Ablehnen').click();
    assert.equal((await replyTo(port, 'a')).error.code, 4001);
  });

  it('presses before the confirm arms start the wait again, and a press that began before it armed confirms nothing (R2-ERP-02)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    const send = page.app.button('Send');
    // a burst of clicks meant for a page: each press anywhere in the window restarts the delay
    for (let i = 0; i < 5; i += 1) {
      t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - 100);
      page.window.fire('pointerdown', { pointerType: 'mouse' });
      assert.equal(send.disabled, true, `press ${i}`);
    }
    page.window.fire('keydown', { key: 'a' });
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - 1);
    assert.equal(send.disabled, true, 'a key press restarts it too');
    t.mock.timers.tick(1);
    assert.equal(send.disabled, false);
    // the release of a press that began before arming: its click is no confirm
    send.click({ press: false });
    await settleAll();
    assert.equal(answered(port, 't'), false);
    send.click();
    assert.equal((await replyTo(port, 't')).ok, true);
    await until(() => page.window.closed);
  });

  it('signMessage: confirm waits until the whole text has been in view, and the line count is shown (R2-ERP-05)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const message = `Sign in to aiqnet.io${'\n'.repeat(300)}I transfer my node registration to someone else`;
    port.send({ id: 's', method: 'qnet_signMessage', params: { message } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.byClass('ap-message').length === 1);
    const [box] = page.app.byClass('ap-message');
    assert.ok(page.app.textContent.includes('Lines: 301'));
    // the layout: 220 px of a 6000 px text are in view
    Object.assign(box, { scrollHeight: 6000, clientHeight: 220, scrollTop: 0 });
    box.fire('scroll');
    const sign = page.app.button('Sign');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS * 3);
    assert.equal(sign.disabled, true, 'not before the end was in view');
    assert.ok(page.app.textContent.includes('Scroll to the end of the message'));
    box.scrollTop = 6000 - 220;
    box.fire('scroll');
    assert.equal(sign.disabled, false);
    sign.click();
    assert.equal((await replyTo(port, 's')).ok, true);
    assert.deepEqual(w.log.signCalls.map((call) => call.message), [message]);
  });

  it('sendTransaction: names the unconfirmed sends and a second payment of the same amount (R2-EXTQ-03)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    // two outstanding sends of this wallet, one of them this very payment
    const base = { to: ACCOUNTS.qnet, amountNano: '1000000000', feeNano: '150000', createdAt: 1, stale: false };
    w.state.outstanding = [{ ...base, nonce: '4' }, { ...base, nonce: '5', amountNano: '7' }];
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    assert.ok(page.app.textContent.includes('Earlier transfers of this wallet are not confirmed yet: 2'));
    assert.ok(page.app.textContent.includes('A transfer of this amount to this address is not confirmed yet'));
    page.app.button('Reject').click();
    assert.equal((await replyTo(port, 't')).error.code, 4001);
  });

  // R5-EXTQ-02: a transfer a node refused may still apply; the new one takes its nonce by default, and the window says so.
  it('sendTransaction: names the refused transfer this one takes the place of (R5-EXTQ-02)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    w.state.outstanding = [{ to: ACCOUNTS.qnet, amountNano: '1000000000', feeNano: '150000', createdAt: 1, stale: false, refused: true, nonce: '5' }];
    w.state.replacesNonce = '5';
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const shown = await w.shown();
    assert.deepEqual((await shown.get()).result.details.replaces, { nonce: '5', to: ACCOUNTS.qnet, amountNano: '1000000000', kind: 'transfer' });
    const page = await openPage(w, shown);
    await until(() => page.app.button('Send') !== null);
    assert.ok(page.app.textContent.includes(`A node refused an earlier transfer of 1 QNC to ${ACCOUNTS.qnet} (nonce 5), but it may still go through`));
    page.app.button('Reject').click();
    assert.equal((await replyTo(port, 't')).error.code, 4001);
  });

  // XP-R5-03: the burn this window sent lost the race to another device's older burn: the window names it.
  it('activateNode: names the burn this window sent when another device\'s older burn is the activation (XP-R5-03)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const record = activationRecord('super', 6000);
    const own = core.base58Encode(new Uint8Array(64).fill(7));
    w.state.activateOutcome = {
      status: 'exists', activation: record,
      superseded: { burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1 },
    };
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Burn 1500 1DEV') !== null);
    const [ack] = page.app.querySelectorAll('input');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    ack.checked = true;
    ack.fire('change');
    page.app.button('Burn 1500 1DEV').click();
    await until(() => page.app.textContent.includes('Another device with this recovery phrase burned first'));
    assert.ok(page.app.textContent.includes(`The burn of 1500 1DEV this window sent (${own}) also went through`));
    assert.equal((await replyTo(port, 'a')).result.status, 'exists');
  });

  it('tokenTransfer: the token as two nodes name it, the recipient, the amount in its units, the deposit and both balances', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '2.5' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    assert.deepEqual(texts(page, 'ap-kicker'), ['Token transfer request']);
    assert.deepEqual(texts(page, 'ap-title'), ['Send tokens?']);
    const values = texts(page, 'ap-row-value');
    const tx = core.buildTokenTransfer({ from: ACCOUNTS.qnet, token: TOKEN, to: ACCOUNTS.qnet, amount: '2500000', nonce: '5' });
    const qnc = (nano) => `${formatUnits(BigInt(nano), 9)} QNC`;
    assert.deepEqual(values, [
      'QNet testnet (q1337)', '2.5 GOLD', qnc(tx.maxFeeNano), '0.01 QNC', qnc(BigInt(tx.maxFeeNano) + 10000000n), '5000 GOLD', '5',
      '10 QNC',
    ]);
    const text = page.app.textContent;
    assert.ok(text.includes(TOKEN) && text.includes(ACCOUNTS.qnet), 'the token contract and the recipient, whole');
    assert.ok(texts(page, 'ap-text').includes('Gold Coin (GOLD)'), 'the token as the nodes name it');
    // the deposit is its row; no paragraph on where the token's data comes from or how the deposit works (owner, 28.09)
    assert.ok(!text.includes('come from two QNet nodes that agree') && !text.includes('refundable deposit'));
    assert.ok(!text.includes('first and last characters'));
    assert.ok(!text.includes('It is not QNC') && !text.includes('destroys every token'));
    noStrayValues(page);
    const send = page.app.button('Send');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(send.disabled, true, 'a transaction arms after the value delay');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - TIMINGS.CONFIRM_ARM_MS);
    assert.equal(send.disabled, false);
    send.click();
    assert.equal((await replyTo(port, 't')).result.token, TOKEN);
    await until(() => page.window.closed);
  });

  it('tokenTransfer: a token named after QNC, the burn address and a token balance short of the amount', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.contracts[TOKEN] = { kind: 'token', standard: 'qrc20', name: 'QNet Coin', symbol: 'QNC', decimals: 9 };
    w.state.tokenBalance = '999999999';
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: core.CANONICAL_BURN_ADDRESS, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    const text = page.app.textContent;
    assert.ok(text.includes('named after QNet’s own coin, but it is not QNC'));
    assert.ok(text.includes('This address destroys every token sent to it'));
    assert.ok(text.includes('The token balance does not cover the amount.'));
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS * 2);
    assert.equal(page.app.button('Send').disabled, true);
    page.app.button('Reject').click();
    await until(() => page.window.closed);
  });

  // The send rule decides only by a committee-certified balance: when none can be had the window says why, as the app's
  // sheet does, and offers no confirm.
  it('sendTransaction: no certified balance says why (another device, not confirmed yet, no answer) and offers no confirm', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const why = {
      BALANCE_FOREIGN_PENDING: 'A transaction from another device is not confirmed yet. Try again in a minute.',
      BALANCE_UNCONFIRMED: 'The balance is not confirmed yet. Try again in a minute.',
      NETWORK: 'The QNet nodes could not be reached. Try again.',
    };
    for (const [code, text] of Object.entries(why)) {
      const w = createWorld();
      w.state.prepareError = new WalletError(code);
      await w.grant(SITE);
      const port = w.connect(`${SITE}/`);
      port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
      const shown = await w.shown();
      assert.equal((await shown.get()).result.details.balanceProblem, code);
      const page = await openPage(w, shown);
      await until(() => page.app.textContent.includes(text));
      assert.ok(!page.app.textContent.includes('Reading the account from the network'), code);
      t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS * 2);
      assert.ok(page.app.button('Send') === null || page.app.button('Send').disabled, code);
      // the balance certified again: the window reads it and offers the confirm
      w.state.prepareError = null;
      t.mock.timers.tick(10000);
      await until(() => page.app.button('Send') !== null && !page.app.textContent.includes(text));
      page.app.button('Reject').click();
      await until(() => page.window.closed);
    }
  });

  it('tokenTransfer: a token balance that cannot be had says why, and the send stays off', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.tokenBalance = null;
    w.state.tokenProblem = 'BALANCE_UNCONFIRMED';
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    assert.ok(page.app.textContent.includes('The balance is not confirmed yet. Try again in a minute.'));
    assert.ok(!page.app.textContent.includes('The token balance could not be read yet.'));
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS * 2);
    assert.equal(page.app.button('Send').disabled, true);
    page.app.button('Reject').click();
    await until(() => page.window.closed);
  });

  it('contractCall: the unknown-contract warning, method, input as hex with its size and as text, gas limit and maximum fee', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    const args = core.bytesToHex(core.utf8Encode('move e2e4'));
    port.send({ id: 'c', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'play', args } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Confirm') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Call this contract?']);
    assert.deepEqual(texts(page, 'ap-args'), [args, 'move e2e4']);
    const tx = core.buildContractCall({ from: ACCOUNTS.qnet, contract: GAME, method: 'play', args, nonce: '5' });
    const values = texts(page, 'ap-row-value');
    assert.deepEqual(values.slice(0, 2), ['QNet testnet (q1337)', tx.gasLimit]);
    assert.ok(texts(page, 'ap-mono').includes('play'), 'the method, whole');
    const text = page.app.textContent;
    assert.ok(text.includes(GAME));
    assert.ok(text.includes('The wallet does not know this contract'));
    assert.ok(text.includes('Size in bytes: 9'));
    assert.ok(!text.includes('the wallet cannot see whether a call succeeded'), 'no paragraph on how a call works');
    assert.equal(page.app.byClass('ap-warning').some((node) => node.getAttribute('role') === 'alert'), true);
    noStrayValues(page);
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    page.app.button('Confirm').click();
    assert.deepEqual((await replyTo(port, 'c')).result.contract, GAME);
    await until(() => page.window.closed);
  });

  it('contractCall without input says so; input that is no text shows as hex only', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'a', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', args: '' } });
    let page = await openPage(w, await w.shown());
    await until(() => page.app.button('Confirm') !== null);
    assert.ok(page.app.textContent.includes('No input'));
    assert.deepEqual(texts(page, 'ap-args'), []);
    page.app.button('Reject').click();
    await replyTo(port, 'a');
    await until(() => page.window.closed);
    const w2 = createWorld();
    await w2.grant(SITE);
    const port2 = w2.connect(`${SITE}/`);
    port2.send({ id: 'b', method: 'qnet_sendTransaction', params: { type: 'contractCall', contract: GAME, method: 'run', args: '00ff' } });
    page = await openPage(w2, await w2.shown());
    await until(() => page.app.button('Confirm') !== null);
    assert.deepEqual(texts(page, 'ap-args'), ['00ff']);
  });

  it('behind an earlier transaction not in a block yet, confirm waits and the window reads the account again until it is', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.inFlight = true;
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    port.send({ id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    assert.ok(page.app.textContent.includes('Waiting for your previous transaction to be confirmed.'));
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS * 2);
    assert.equal(page.app.button('Send').disabled, true);
    w.state.inFlight = false;
    t.mock.timers.tick(4000);
    await until(() => !page.app.textContent.includes('Waiting for your previous transaction'));
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    assert.equal(page.app.button('Send').disabled, false);
    page.app.button('Send').click();
    assert.equal((await replyTo(port, 't')).ok, true);
  });
  it('refuses an id that is not an approval uuid', async () => {
    const w = createWorld();
    const page = createPage({ query: '?id=../../popup', runtime: w.chrome.runtime, send: () => assert.fail('no request') });
    Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
    pageSeq += 1;
    await import(`../dist/ui/approve.js?page=${pageSeq}`);
    await until(() => page.window.closed);
    assert.equal(page.app.childNodes.length, 0);
  });
});

// Decision 35: the window offers a burn only once the QNet network, Solana and aiqnet.io all answered "none"; until then
// it says it is checking, and a burn another source knows is named for what it is.
describe('approve page: the one-code checks (decision 35)', () => {
  it('activateNode: while the wallet is checked there is nothing to confirm; the window reads again until a view comes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.siteView = { mode: 'checking', reason: null, cost: null, balances: null };
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'k', method: 'qnet_activateNode', params: { nodeType: 'super' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.textContent.includes('Checking this wallet: the QNet network, Solana and aiqnet.io…'));
    assert.deepEqual(page.app.querySelectorAll('button').map((button) => button.textContent), ['Reject']);
    assert.equal(page.app.querySelectorAll('input').length, 0, 'no acknowledgement, no burn');
    assert.ok(!/1500 1DEV/.test(page.app.textContent), 'no price while checking');
    noStrayValues(page);
    const reads = w.log.siteViews.length;
    for (let i = 0; i < 7; i += 1) {
      t.mock.timers.tick(3000);
      await settleAll();
    }
    assert.ok(w.log.siteViews.length >= reads + 6, 'read again every few seconds, past the retries of a missing view');
    w.state.siteView = null;
    t.mock.timers.tick(3000);
    await until(() => page.app.button('Burn 1500 1DEV') !== null);
    assert.equal(answered(port, 'k'), false);
  });

  it('activateNode: a burn aiqnet.io holds, one starting elsewhere and aiqnet.io unreachable are named; the site learns its codes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const cases = [
      ['ACTIVATION_RECORDED', 'This wallet already has its activation code: aiqnet.io holds its burn, and Settings shows its code.', 'NODE_EXISTS'],
      ['ACTIVATION_RESERVED', 'An activation of this wallet is starting in another browser, on another device or through a one-time payment address on aiqnet.io. Nothing is burned here.', 'BURN_IN_PROGRESS'],
      ['RECORD_UNAVAILABLE', 'aiqnet.io could not be reached, so it could not confirm that this wallet has no burn.', 'INTERNAL'],
    ];
    for (const [reason, text, siteCode] of cases) {
      const w = createWorld();
      w.state.siteView = { mode: 'unavailable', reason, cost: null, balances: null };
      const port = w.connect(`${SITE}/`);
      port.send({ id: 'u', method: 'qnet_activateNode', params: { nodeType: 'light' } });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Close') !== null);
      assert.deepEqual(texts(page, 'ap-title'), ['Activation is not possible now']);
      assert.ok(page.app.textContent.includes(text), page.app.textContent);
      assert.equal(page.app.querySelectorAll('button').length, 1);
      page.app.button('Close').click();
      assert.deepEqual((await replyTo(port, 'u')).result, { status: 'error', error: siteCode });
      await until(() => page.window.closed);
    }
  });

  it('activateNode: the outcome is titled by what happened, the code or the burn waiting for Solana, never "Done" (EXT-F5)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    for (const [outcome, title] of [[null, 'Your activation code'], ['pending', 'Burn waiting for Solana']]) {
      const w = createWorld();
      if (outcome === 'pending') {
        w.state.activateOutcome = {
          status: 'pending',
          pending: { burnTx: activationRecord('light').burnTx, nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1 },
        };
      }
      const port = w.connect(`${SITE}/`);
      port.send({ id: 'o', method: 'qnet_activateNode', params: { nodeType: 'light' } });
      const page = await openPage(w, await w.shown());
      await until(() => page.app.button('Burn 1500 1DEV') !== null);
      const [ack] = page.app.querySelectorAll('input');
      t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
      ack.checked = true;
      ack.fire('change');
      page.app.button('Burn 1500 1DEV').click();
      await until(() => page.app.button('Close') !== null);
      assert.deepEqual(texts(page, 'ap-title'), [title]);
      assert.ok(!texts(page, 'ap-title').includes('Done'));
      await replyTo(port, 'o');
    }
  });
});

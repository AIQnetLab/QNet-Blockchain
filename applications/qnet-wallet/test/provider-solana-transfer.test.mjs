// qnet_sendSolanaTransfer (decision 52) through the real router and provider state machine: aiqnet.io asks for one SOL or
// 1DEV transfer, no grant read or created; the approval's view is solana.quote of exactly that request, read-only; its
// armed confirm (no password) runs solana.send with the reviewed fee and rent once; the site gets {status: 'submitted',
// signature} or an error result that means nothing was transferred; and the window's own screens on the fake DOM.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { LIMITS, SOLANA, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { WalletError } from '../dist/background/errors.js';
import { TRANSFER_ERROR_CODES } from '../dist/background/provider.js';
import { until } from './helpers/chrome-mock.mjs';
import { openApprovePage, resetPageGlobals, texts } from './helpers/provider-dom.mjs';
import {
  ACCOUNTS, BURN_TX, COOLDOWN_TEXT, ERROR_LINGER_MS, PASSWORD, SITE, answered, createWorld, eventsOf, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

// approve.js PREVIEW_RETRY_MS: how soon the window reads a missing view again
const PREVIEW_RETRY_MS = 3000;
const peerSeed = core.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow');
// a payment address the site reads: a fresh wallet address of the cluster
const TO = core.deriveSolanaKeypair(peerSeed).address;
core.zeroize(peerSeed);
const ONE_DEV = Object.freeze({ to: TO, mint: SOLANA.ONE_DEV_MINT, amount: '500' });
const SOL = Object.freeze({ to: TO, mint: null, amount: '0.001' });
const transfer = (port, id, params = ONE_DEV) => port.send({ id, method: 'qnet_sendSolanaTransfer', params });

afterEach(resetPageGlobals);

describe('provider: qnet_sendSolanaTransfer', () => {
  it('aiqnet.io: one window with exactly the request and its quote; the armed confirm sends that quote once', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/node/activate`);
    transfer(port, 't');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.kind, 'solanaTransfer');
    assert.equal(view.origin, SITE);
    assert.deepEqual(view.details, {
      to: TO, asset: '1dev', mint: SOLANA.ONE_DEV_MINT, amount: '500', amountRaw: '500000000', feeLamports: '5000',
      rentLamports: '2039280', totalLamports: '2044280', balanceLamports: '2000000000', tokenRaw: '5000000000',
      rentFloorLamports: '890880', recipient: { known: false, lookalike: false }, shortfall: null, mode: 'confirm', reason: null,
    });
    assert.deepEqual(w.log.solanaQuotes, [{ asset: '1dev', to: TO, amount: '500' }]);
    // no approval takes a password
    assert.equal((await shown.resolve(true, { password: PASSWORD })).error.code, 'INVALID_PARAMS');
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'submitted', error: null, signature: BURN_TX });
    assert.deepEqual(w.log.solanaSends, [{ asset: '1dev', to: TO, amount: '500', expectedFeeLamports: '5000', expectedRentLamports: '2039280' }]);
    const reply = await replyTo(port, 't');
    assert.deepEqual(reply.result, { status: 'submitted', signature: BURN_TX });
    assert.deepEqual(Object.keys(reply.result).sort(), ['signature', 'status']);
    assert.deepEqual(w.log.views.filter((event) => event === 'balance'), ['balance'], 'the pages read the balances again');
    assert.equal(await w.storedSites(), undefined, 'no grant is read or created');
    assert.deepEqual(eventsOf(port), []);
    await settleAll();
    assert.equal(w.openWindows.has(shown.windowId), true, 'the window stays on the outcome');
    w.fireTimers(ERROR_LINGER_MS);
    await until(() => !w.openWindows.has(shown.windowId));
  });

  it('a SOL transfer maps to the send\'s asset, and the answer is exactly {status, signature} whatever solana.send adds', async () => {
    const w = createWorld();
    w.state.solanaSendAnswer = { signature: BURN_TX, status: 'submitted', lastValidBlockHeight: 7, note: 'extra' };
    const port = w.connect(`${SITE}/`);
    transfer(port, 's', SOL);
    const shown = await w.shown();
    const { details } = (await shown.get()).result;
    assert.deepEqual([details.asset, details.mint, details.amountRaw, details.rentLamports, details.totalLamports, details.tokenRaw],
      ['sol', null, '1000000', '0', '1005000', null]);
    await shown.resolve(true);
    assert.deepEqual(w.log.solanaSends, [{ asset: 'sol', to: TO, amount: '0.001', expectedFeeLamports: '5000', expectedRentLamports: '0' }]);
    assert.deepEqual((await replyTo(port, 's')).result, { status: 'submitted', signature: BURN_TX });
  });

  it('refuses every other origin with 4100 and the probe with -32602 before any window; NO_WALLET at once without a vault', async () => {
    const w = createWorld();
    const games = w.connect('https://games.aiqnet.io/');
    transfer(games, 'g');
    assert.equal((await replyTo(games, 'g')).error.code, 4100);
    const port = w.connect(`${SITE}/node/activate`);
    port.send({ id: 'probe', method: 'qnet_sendSolanaTransfer' });
    assert.equal((await replyTo(port, 'probe')).error.code, -32602);
    // the provider holds the request's form itself too
    for (const params of [{}, { ...ONE_DEV, mint: TO }, { ...ONE_DEV, amount: '0' }, { ...ONE_DEV, amount: '1.50' }, { ...SOL, amount: '1e3' }]) {
      await assert.rejects(w.provider.handleRequest(Object.freeze({ origin: SITE, tabId: 1, portId: 78 }), 'qnet_sendSolanaTransfer', params),
        (error) => error instanceof WalletError && ['INVALID_PARAMS', 'INVALID_AMOUNT'].includes(error.code), JSON.stringify(params));
    }
    w.state.vaultExists = false;
    transfer(port, 'n');
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'NO_WALLET' });
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    assert.deepEqual([w.log.solanaQuotes.length, w.log.solanaSends.length], [0, 0]);
  });

  it('the wallet\'s own address: -32602 before any window while unlocked; asked while locked, the window says so and its Close answers -32602', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    transfer(port, 'own', { ...SOL, to: ACCOUNTS.solana });
    assert.equal((await replyTo(port, 'own')).error.code, -32602);
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    w.state.unlocked = false;
    transfer(port, 'locked', { ...ONE_DEV, to: ACCOUNTS.solana });
    const shown = await w.shown();
    const locked = (await shown.get()).result;
    assert.deepEqual([locked.locked, locked.details.mode, locked.details.feeLamports], [true, null, null]);
    assert.equal(w.log.solanaQuotes.length, 0, 'nothing is read while locked');
    w.state.unlocked = true;
    const unlocked = (await shown.get()).result;
    assert.deepEqual([unlocked.details.mode, unlocked.details.reason], ['unavailable', 'INVALID_RECIPIENT']);
    assert.ok(unlocked.revision > locked.revision, 'the unlock is a new view');
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'error', error: 'INVALID_RECIPIENT' });
    assert.equal((await replyTo(port, 'locked')).error.code, -32602);
    assert.equal(w.log.solanaSends.length, 0);
  });

  it('a confirm of a view the page did not draw reviews again; FEE_CHANGED, BLOCKHASH_EXPIRED and LOCKED keep the window open', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    transfer(port, 'r');
    const shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true, { revision: 999 })).error.code, 'FEE_CHANGED');
    assert.equal(w.log.solanaSends.length, 0);
    for (const code of ['FEE_CHANGED', 'BLOCKHASH_EXPIRED', 'LOCKED']) {
      w.state.solanaSendError = new WalletError(code);
      await shown.get();
      assert.equal((await shown.resolve(true)).error.code, code);
      await settleAll();
      assert.equal(answered(port, 'r'), false, `${code}: the site waits`);
      assert.equal(w.openWindows.has(shown.windowId), true, `${code}: the window stays`);
      // the quote is read again before a confirm may send
      assert.equal((await shown.get()).result.details.mode, 'confirm');
    }
    w.state.solanaSendError = null;
    const sends = w.log.solanaSends.length;
    await shown.resolve(true);
    assert.equal(w.log.solanaSends.length, sends + 1);
    assert.deepEqual((await replyTo(port, 'r')).result, { status: 'submitted', signature: BURN_TX });
  });

  it('a reject answers 4001 and counts toward the cooldown, and the fifth within 10 minutes bars the site', async () => {
    const c = { now: 1_800_000_000_000 };
    const w = createWorld({ now: () => c.now });
    const port = w.connect(`${SITE}/`);
    let shown = null;
    for (let i = 1; i <= LIMITS.APPROVAL_COOLDOWN_REJECTIONS; i += 1) {
      c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS / 3;
      transfer(port, `r${i}`);
      shown = await w.shown(shown === null ? {} : { after: shown.windowId });
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
      assert.equal((await replyTo(port, `r${i}`)).error.code, 4001);
    }
    await settleAll();
    assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN][SITE].rejections.length,
      LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    transfer(port, 'late');
    assert.deepEqual((await replyTo(port, 'late')).error, { code: 4001, message: COOLDOWN_TEXT });
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    assert.equal(w.log.solanaSends.length, 0);
  });

  it('windows that end unused spend the site\'s window budget', async () => {
    const w = createWorld();
    w.state.lamports = '1000';
    const port = w.connect(`${SITE}/`);
    let shown = null;
    for (let i = 1; i <= LIMITS.APPROVAL_BUDGET_SHORT; i += 1) {
      transfer(port, `u${i}`);
      shown = await w.shown(shown === null ? {} : { after: shown.windowId });
      await shown.get();
      await shown.resolve(false);
      await replyTo(port, `u${i}`);
    }
    transfer(port, 'over');
    assert.deepEqual((await replyTo(port, 'over')).error, { code: 4001, message: COOLDOWN_TEXT });
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_BUDGET_SHORT);
  });

  it('a shortfall is a view that cannot send: its Close answers INSUFFICIENT_SOL or INSUFFICIENT_TOKENS, nothing signed, no rejection the first time', async () => {
    for (const [setup, params, error] of [
      [(w) => { w.state.oneDevRaw = '1'; }, ONE_DEV, 'INSUFFICIENT_TOKENS'],
      [(w) => { w.state.lamports = '1000'; }, SOL, 'INSUFFICIENT_SOL'],
      [(w) => { w.state.lamports = '1000'; }, ONE_DEV, 'INSUFFICIENT_SOL'],
    ]) {
      const w = createWorld();
      setup(w);
      const port = w.connect(`${SITE}/`);
      transfer(port, 'x', params);
      const shown = await w.shown();
      const { details } = (await shown.get()).result;
      assert.deepEqual([details.mode, details.reason, details.shortfall], ['unavailable', error, error]);
      assert.equal((await shown.resolve(true)).result.status, 'error', 'a confirm of a view that offers none tells the site the reason');
      assert.deepEqual((await replyTo(port, 'x')).result, { status: 'error', error });
      assert.equal(w.log.solanaSends.length, 0, 'nothing signed');
      await settleAll();
      assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN]?.[SITE]?.rejections.length ?? 0, 0);
    }
  });

  it('sends a failed send as a result with only the site\'s codes, and refuses a send answer it cannot check', async () => {
    const cases = [
      [new WalletError('INSUFFICIENT_SOL'), 'INSUFFICIENT_SOL'], [new WalletError('SOL_BELOW_RENT'), 'INSUFFICIENT_SOL'],
      [new WalletError('INSUFFICIENT_TOKENS'), 'INSUFFICIENT_TOKENS'], [new WalletError('SOLANA_UNAVAILABLE'), 'SOLANA_UNAVAILABLE'],
      [new WalletError('SIMULATION_FAILED'), 'TX_FAILED'], [new WalletError('TX_FAILED'), 'TX_FAILED'], [new WalletError('TX_TOO_LARGE'), 'TX_FAILED'],
      [new WalletError('AMOUNT_BELOW_RENT'), 'TX_FAILED'], [new WalletError('SIGNING_DISABLED'), 'INTERNAL'], [new Error('boom'), 'INTERNAL'],
      [null, 'INTERNAL', { signature: 'not-a-signature', status: 'confirmed' }],
      [null, 'INTERNAL', { signature: BURN_TX, status: 'failed' }],
    ];
    for (const [sendError, error, answer = null] of cases) {
      const w = createWorld();
      w.state.solanaSendError = sendError;
      w.state.solanaSendAnswer = answer;
      const port = w.connect(`${SITE}/`);
      transfer(port, 'f');
      const shown = await w.shown();
      await shown.get();
      assert.equal((await shown.resolve(true)).result.status, 'error', String(sendError?.code ?? answer?.signature));
      const reply = await replyTo(port, 'f');
      assert.deepEqual(reply.result, { status: 'error', error }, String(sendError?.code ?? answer?.signature));
      assert.ok(TRANSFER_ERROR_CODES.includes(reply.result.error));
    }
    assert.deepEqual([...TRANSFER_ERROR_CODES].sort(),
      ['INSUFFICIENT_SOL', 'INSUFFICIENT_TOKENS', 'INTERNAL', 'NO_WALLET', 'SOLANA_UNAVAILABLE', 'TX_FAILED']);
  });

  it('a quote that is not of exactly the request is never shown; Solana not answering says so and a later read offers the send', async () => {
    for (const quote of [{ to: ACCOUNTS.solana }, { amountRaw: '500000001' }, { decimals: 9 }, { mint: null }, { memo: 'x' },
      { references: [TO] }, { feeLamports: '-1' }, { shortfall: 'SOMETHING' }, { tokenRaw: null }]) {
      const w = createWorld();
      w.state.solanaQuote = quote;
      const port = w.connect(`${SITE}/`);
      transfer(port, 'q');
      const shown = await w.shown();
      const { details } = (await shown.get()).result;
      assert.deepEqual([details.mode, details.reason], ['unavailable', 'INTERNAL'], JSON.stringify(quote));
      assert.equal(details.feeLamports, null, JSON.stringify(quote));
    }
    const w = createWorld();
    w.state.solanaQuoteError = new WalletError('SOLANA_UNAVAILABLE');
    const port = w.connect(`${SITE}/`);
    transfer(port, 'later');
    const shown = await w.shown();
    assert.deepEqual((await shown.get()).result.details.reason, 'SOLANA_UNAVAILABLE');
    w.state.solanaQuoteError = null;
    assert.equal((await shown.get()).result.details.mode, 'confirm');
    await shown.resolve(true);
    assert.deepEqual((await replyTo(port, 'later')).result, { status: 'submitted', signature: BURN_TX });
  });
});

describe('approve page: qnet_sendSolanaTransfer', () => {
  it('shows the request read-only with its quote, arms like a transaction without a password, and stays on what was sent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    const port = w.connect(`${SITE}/node/activate`);
    transfer(port, 't');
    const page = await openApprovePage(w, await w.shown());
    await until(() => page.app.button('Send') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Send from your wallet']);
    assert.deepEqual(texts(page, 'ap-kicker'), ['Transfer request']);
    assert.deepEqual(texts(page, 'ap-origin-host'), [SITE], 'the origin the browser reported, from the view');
    const text = page.app.textContent;
    for (const shown of [TO, SOLANA.ONE_DEV_MINT, '500 1DEV', '0.000005 SOL', 'Rent of new 1DEV account', '0.00203928 SOL',
      '0.00204428 SOL', '2 SOL', '5,000 1DEV', 'This wallet has not sent to this address before']) {
      assert.ok(text.includes(shown), `${shown}: ${text}`);
    }
    assert.ok(!/\bnull\b|\bundefined\b|NaN/.test(text), text);
    // the popup's Send review rows (kit.solanaReviewRows), in its order, then the balances
    assert.deepEqual(texts(page, 'ap-label'), ['Requested by', 'To', 'Token mint']);
    assert.deepEqual(texts(page, 'ap-row-label'),
      ['Token', 'Amount', 'Network fee', 'Rent of new 1DEV account', 'Total SOL spent', 'Network', 'Balance', 'Balance']);
    assert.equal(page.app.querySelectorAll('input, textarea, select').length, 0, 'nothing to edit and no password');
    const send = page.app.button('Send');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_MS);
    assert.equal(send.disabled, true, 'it arms like a transaction');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS - TIMINGS.CONFIRM_ARM_MS);
    assert.equal(send.disabled, false);
    send.click({ detail: 0, pointerType: '' });
    await settleAll();
    assert.equal(answered(port, 't'), false, 'a key never confirms');
    send.click();
    assert.deepEqual((await replyTo(port, 't')).result, { status: 'submitted', signature: BURN_TX });
    await until(() => page.app.textContent.includes('The site received the transaction’s signature'));
    assert.deepEqual(texts(page, 'ap-title'), ['Sent']);
    assert.ok(page.app.textContent.includes(BURN_TX));
    page.app.button('Close').click();
    await until(() => page.window.closed);
  });

  it('a shortfall offers one Close that names it with its numbers and tells the site', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.oneDevRaw = '1';
    const port = w.connect(`${SITE}/`);
    transfer(port, 'x');
    const page = await openApprovePage(w, await w.shown());
    await until(() => page.app.button('Close') !== null);
    assert.ok(page.app.textContent.includes('Not enough tokens: the wallet holds 0.000001 1DEV.'), page.app.textContent);
    assert.equal(page.app.button('Send'), null);
    const reads = w.log.solanaQuotes.length;
    for (let i = 0; i < 3; i += 1) {
      t.mock.timers.tick(PREVIEW_RETRY_MS);
      await settleAll();
    }
    assert.equal(w.log.solanaQuotes.length, reads, 'a shortfall waits for the heartbeat, not the quick reads');
    page.app.button('Close').click();
    assert.deepEqual((await replyTo(port, 'x')).result, { status: 'error', error: 'INSUFFICIENT_TOKENS' });
    await until(() => page.window.closed);
  });

  it('Solana not answering says so and is read again within seconds, not at the heartbeat; the send then appears', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.solanaQuoteError = new WalletError('SOLANA_UNAVAILABLE');
    const port = w.connect(`${SITE}/`);
    transfer(port, 'u');
    const page = await openApprovePage(w, await w.shown());
    await until(() => page.app.button('Close') !== null);
    assert.ok(page.app.textContent.includes('Solana could not be read. Try again.'), page.app.textContent);
    assert.equal(page.app.button('Send'), null);
    w.state.solanaQuoteError = null;
    assert.ok(PREVIEW_RETRY_MS < TIMINGS.APPROVAL_HEARTBEAT_MS);
    t.mock.timers.tick(PREVIEW_RETRY_MS);
    await until(() => page.app.button('Send') !== null);
    assert.ok(page.app.textContent.includes('500 1DEV'), page.app.textContent);
    assert.equal(answered(port, 'u'), false, 'the site still waits for the user');
  });

  it('reads in every language with the one amount format', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.router = (await import('../dist/background/router.js')).createRouter({
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
    transfer(port, 'de');
    const page = await openApprovePage(w, await w.shown());
    await until(() => page.app.button('Senden') !== null);
    assert.deepEqual(texts(page, 'ap-title'), ['Aus Ihrem Wallet senden']);
    assert.ok(page.app.textContent.includes('5,000 1DEV'), page.app.textContent);
    page.app.button('Ablehnen').click();
    assert.equal((await replyTo(port, 'de')).error.code, 4001);
  });
});

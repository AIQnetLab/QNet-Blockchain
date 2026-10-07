/**
 * Final audit, mobile fixer round 4, the in-app browser (MOB-BR-R4-01 … MOB-BR-R4-03): an approval whose time runs out
 * while it signs and sends delivers its result, not a rejection; a site's send signs only at the confirmed nonce + 1, as
 * the extension's (it waits for an earlier transaction, or replaces the one there, and never goes in addition); and QNC
 * sent to the canonical burn address is said to be destroyed, as a token is.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { createDappProvider, CODES, TIMINGS } = require('../src/browser/dappProvider');
const DappSheet = require('../src/browser/DappSheet').default;
const { WalletManager } = require('../src/components/WalletManager');
const { CANONICAL_BURN_ADDRESS } = require('../src/crypto/TxBuilders');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://shop.example';
const QNC = 1_000_000_000n;
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const t = require('../src/i18n').makeT('en');

beforeEach(async () => { await AsyncStorage.clear(); });
afterEach(() => { jest.useRealTimers(); });

const entry = (nonce) => ({ nonce, state: 'accepted', kind: 'transfer', to: TO, amountNano: String(QNC), ageMs: 60000 });
function setup(over = {}) {
  const views = [];
  const grants = new Map([[SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: QNET }]]);
  const deps = {
    now: () => Date.now(),
    state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET }),
    grants: { get: async (o) => grants.get(o) || null, put: async () => {}, remove: async () => {} },
    feeNano: () => 150000,
    signMessage: jest.fn(),
    tokenInfo: jest.fn(),
    contractKind: jest.fn(async () => 'none'),
    prepareSend: jest.fn(async () => ({ nonce: 6, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO] })),
    recheckSend: jest.fn(async () => ({ balanceNano: String(10n * QNC) })),
    send: jest.fn(async (d) => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: d.nonce })),
    transactionStatus: jest.fn(),
    isCurrent: () => true,
    emit: () => {},
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = { origin: SITE, binding: { origin: SITE, doc: 'd', id: 'x', nav: 1 } };
  return { p, deps, ctx, views, shown: () => views[views.length - 1] };
}
const pay = (s, to = TO) => s.p.request(s.ctx, 'qnet_sendTransaction', { to, amount: '1' });

// Advances the fake clock in steps, letting promises run between them.
async function advance(ms, step = 1000) {
  for (let left = ms; left > 0; left -= step) await jest.advanceTimersByTimeAsync(Math.min(step, left));
}

describe('MOB-BR-R4-01: the approval timeout never ends an approval while it signs and sends', () => {
  it('a send confirmed just before the ten minutes delivers its result to the page, not 4001', async () => {
    jest.useFakeTimers({ now: 1790000000000 });
    let release;
    const s = setup({ send: jest.fn(() => new Promise((r) => { release = r; })) });
    let answer = null;
    const page = pay(s).then((r) => { answer = { r }; }, (e) => { answer = { e }; });
    await advance(10);
    const id = s.shown().id;
    await s.p.loadPreview(id);
    await advance(TIMINGS.APPROVAL_TIMEOUT_MS - 10_000);
    const approving = s.p.approve(id);
    await advance(1);
    expect(s.shown().busy).toBe(true);
    await advance(20_000);                                   // the ten minutes end while it sends
    expect(answer).toBe(null);
    expect(s.shown()).toMatchObject({ id, busy: true });     // the sheet stays on "Sending…"
    release({ txHash: 'b'.repeat(64), status: 'submitted', nonce: 6 });
    expect(await approving).toMatchObject({ status: 'done' });
    await page;
    expect(answer.r).toMatchObject({ status: 'submitted', nonce: '6', txHash: 'b'.repeat(64) });
    expect(s.shown().outcome).toMatchObject({ status: 'submitted' });
  });

  it('one that goes back to the sheet after its time ran out (nothing signed) ends as rejected then', async () => {
    jest.useFakeTimers({ now: 1790000000000 });
    let fail;
    const s = setup({ send: jest.fn(() => new Promise((r, j) => { fail = j; })) });
    let answer = null;
    pay(s).then((r) => { answer = { r }; }, (e) => { answer = { e }; });
    await advance(10);
    const id = s.shown().id;
    await s.p.loadPreview(id);
    await advance(TIMINGS.APPROVAL_TIMEOUT_MS - 5_000);
    const approving = s.p.approve(id);
    await advance(10_000);
    expect(answer).toBe(null);
    fail(Object.assign(new Error('moved'), { code: 'NONCE_CHANGED' }));
    expect(await approving).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
    await advance(1);
    expect(answer.e).toMatchObject({ code: CODES.USER_REJECTED });
  });

  it('an idle approval still ends at ten minutes', async () => {
    jest.useFakeTimers({ now: 1790000000000 });
    const s = setup();
    let answer = null;
    pay(s).then((r) => { answer = { r }; }, (e) => { answer = { e }; });
    await advance(TIMINGS.APPROVAL_TIMEOUT_MS + 1000);
    expect(answer.e).toMatchObject({ code: CODES.USER_REJECTED });
  });
});

describe('MOB-BR-R4-02: a site\'s send signs only at the confirmed nonce + 1', () => {
  it('never in addition: an append pick signs nothing, and the preview offers none', async () => {
    const s = setup({
      prepareSend: jest.fn(async () => ({
        nonce: null, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO],
        pending: [entry(6)], replaceNonce: 6, replaceHash: 'h6', appendNonce: 7, recent: [],
      })),
    });
    pay(s).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const id = s.shown().id;
    await s.p.loadPreview(id);
    expect(s.shown().preview).toMatchObject({ appendNonce: null, replaceNonce: 6, inFlight: false, confirmed: 5 });
    expect(await s.p.approve(id, 'append')).toEqual({ status: 'review' });
    expect(s.deps.send).not.toHaveBeenCalled();
    // In place of the one unconfirmed transaction at confirmed + 1: allowed.
    expect(await s.p.approve(id, 'replace')).toMatchObject({ status: 'done' });
    expect(s.deps.send).toHaveBeenCalledWith(expect.objectContaining({ nonce: 6, choice: { mode: 'replace', nonce: 6, bodyHash: 'h6' } }));
    s.p.dismiss(id);
  });

  it('two unconfirmed: the newest is above confirmed + 1, so nothing can be confirmed until they land', async () => {
    jest.useFakeTimers({ now: 1790000000000 });
    const later = { nonce: 6, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO], pending: [], recent: [] };
    const prepareSend = jest.fn(async () => ({
      nonce: null, confirmed: 4, balanceNano: String(10n * QNC), verified: true, counterparties: [TO],
      pending: [entry(5), entry(6)], replaceNonce: 6, replaceHash: 'h6', appendNonce: 7, recent: [],
    }));
    const s = setup({ prepareSend });
    pay(s).catch(() => {});
    await advance(10);
    const id = s.shown().id;
    await s.p.loadPreview(id);
    expect(s.shown().preview).toMatchObject({ replaceNonce: null, appendNonce: null, inFlight: true });
    expect(await s.p.approve(id, 'replace')).toEqual({ status: 'review' });
    expect(await s.p.approve(id, 'append')).toEqual({ status: 'review' });
    expect(s.deps.send).not.toHaveBeenCalled();
    // The preview is read again every few seconds; once they are in a block the send is offered at confirmed + 1.
    prepareSend.mockResolvedValue(later);
    await advance(TIMINGS.IN_FLIGHT_RECHECK_MS + 10, 100);
    expect(prepareSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.shown().preview).toMatchObject({ nonce: 6, inFlight: false, pending: [] });
    expect(await s.p.approve(id)).toMatchObject({ status: 'done' });
    expect(s.deps.send).toHaveBeenCalledWith(expect.objectContaining({ nonce: 6, choice: null }));
    const reads = prepareSend.mock.calls.length;
    await advance(TIMINGS.IN_FLIGHT_RECHECK_MS * 3, 500);
    expect(prepareSend.mock.calls.length).toBe(reads); // no reads once it settled
  });

  it('one unconfirmed above a gap (not at confirmed + 1) cannot be replaced either', async () => {
    const s = setup({
      prepareSend: jest.fn(async () => ({
        nonce: null, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO],
        pending: [entry(7)], replaceNonce: 7, replaceHash: 'h7', appendNonce: null, recent: [],
      })),
    });
    pay(s).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const id = s.shown().id;
    await s.p.loadPreview(id);
    expect(s.shown().preview).toMatchObject({ replaceNonce: null, inFlight: true });
    expect(await s.p.approve(id, 'replace')).toEqual({ status: 'review' });
    s.p.reject(id);
  });

  it('the wallet signs a site\'s send only at the confirmed nonce + 1 (oneInFlight), and the browser asks for that', async () => {
    const wm = new WalletManager();
    const sign = jest.fn(async () => { throw Object.assign(new Error('stop here'), { code: 'SIGNED' }); });
    wm.resolveNonce = async () => ({ nonce: 7, confirmed: 5, replaces: null });
    await expect(wm._signAndSubmit(QNET, sign, {}, { oneInFlight: true })).rejects.toMatchObject({ code: 'NONCE_CHANGED' });
    expect(sign).not.toHaveBeenCalled();
    wm.resolveNonce = async () => ({ nonce: 6, confirmed: 5, replaces: null });
    await expect(wm._signAndSubmit(QNET, sign, {}, { oneInFlight: true })).rejects.toMatchObject({ code: 'SIGNED' });
    expect(sign).toHaveBeenCalledWith(6);
    const browser = read('src/browser/BrowserScreen.js');
    expect(browser).toMatch(/const opts = \{ expectNonce: d\.nonce, choice: d\.choice, oneInFlight: true \};/);
    expect(browser).toMatch(/confirmed: plan\.confirmed,/);
    expect(browser).not.toMatch(/nonceForChoice\(plan, \{ mode: 'append' \}\)/);
    const wmSrc = read('src/components/WalletManager.js');
    expect((wmSrc.match(/oneInFlight: opts\.oneInFlight === true/g) || []).length).toBe(2);
    expect(wmSrc).toMatch(/\{ expectNonce, choice, oneInFlight \}\);/);
  });
});

describe('the sheet of a site\'s send while an earlier transaction is unconfirmed', () => {
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('\n');
  const buttons = (tree) => tree.root.findAllByType(TouchableOpacity)
    .map((b) => ({ label: b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(''), props: b.props }));
  const mounted = [];
  afterEach(async () => { await act(async () => { while (mounted.length) mounted.pop().unmount(); }); });
  const view = (preview) => ({
    id: 's1', kind: 'send', origin: SITE, busy: false, queued: 0, outcome: null, notice: null,
    details: { type: 'transfer', to: TO, amountNano: String(QNC), feeNano: '150000', totalNano: String(QNC + 150000n) },
    preview: {
      nonce: null, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO], paid: [], senders: [],
      recent: [], transferFeeNano: '150000', appendNonce: null, ...preview,
    },
  });
  async function mount(v) {
    const props = {
      view: v, t, authenticate: jest.fn(async () => true), accounts: { qnet: QNET, solana: SOL },
      actions: { approve: jest.fn(async () => ({ status: 'done' })), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() },
    };
    let tree;
    await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
    mounted.push(tree);
    return { tree, props };
  }

  it('in flight: says it waits, offers no choice and keeps Send off', async () => {
    const { tree } = await mount(view({ pending: [entry(6), entry(7)], replaceNonce: null, replaceHash: null, inFlight: true }));
    expect(texts(tree)).toContain(t('dapp_in_flight'));
    expect(tree.root.findAll((n) => n.props && n.props.testID === 'pick-replace')).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props && n.props.testID === 'pick-append')).toHaveLength(0);
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(buttons(tree).find((b) => b.label === t('dapp_send')).props.disabled).toBe(true);
  });

  it('one at confirmed + 1: Replace it, or wait; never "Send in addition"', async () => {
    const { tree } = await mount(view({ pending: [entry(6)], replaceNonce: 6, replaceHash: 'h6', inFlight: false }));
    expect(texts(tree)).toContain(t('dapp_replace_or_wait'));
    expect(tree.root.findAll((n) => n.props && n.props.testID === 'pick-replace').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props && n.props.testID === 'pick-append')).toHaveLength(0);
    expect(texts(tree)).not.toContain(t('pending_append'));
  });
});

describe('MOB-BR-R4-03: QNC sent to the burn address is said to be destroyed', () => {
  it('the transfer\'s details carry it, and the sheet shows the alert in place of the recipient warnings', async () => {
    const s = setup();
    pay(s, CANONICAL_BURN_ADDRESS).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(s.shown().details).toMatchObject({ type: 'transfer', to: CANONICAL_BURN_ADDRESS, destroys: true });
    const other = setup();
    pay(other, TO).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(other.shown().details.destroys).toBe(false);
    other.p.reject(other.shown().id);

    const props = {
      view: {
        id: 'b1', kind: 'send', origin: SITE, busy: false, queued: 0, outcome: null, notice: null, details: s.shown().details,
        preview: {
          nonce: 6, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [], paid: [], senders: [],
          pending: [], recent: [], transferFeeNano: '150000', replaceNonce: null, appendNonce: null, inFlight: false,
        },
      },
      t, authenticate: jest.fn(async () => true), accounts: { qnet: QNET, solana: SOL },
      actions: { approve: jest.fn(), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() },
    };
    let tree;
    await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
    const shown = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('\n');
    expect(shown).toContain(t('dapp_qnc_destroyed'));
    expect(shown).not.toContain(t('dapp_send_first_time'));
    await act(async () => { tree.unmount(); });
    s.p.reject(s.shown().id);
  });

  it('every language has the text, and none of them says "burn"', () => {
    for (const lang of ['en', 'ru', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh-CN', 'ar']) {
      const L = require(`../src/i18n/locales/${lang}.js`).default;
      for (const k of ['dapp_qnc_destroyed', 'dapp_in_flight', 'dapp_replace_or_wait', 'node_use_unknown']) {
        expect([lang, k, typeof L[k]]).toEqual([lang, k, 'string']);
      }
      expect(L.dapp_qnc_destroyed).toMatch(/QNC/);
      expect(L.dapp_qnc_destroyed).not.toMatch(/burn/i);
    }
  });
});

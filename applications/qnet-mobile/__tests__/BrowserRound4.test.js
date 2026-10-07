/**
 * Final audit, mobile fixer round 1, the in-app browser (MB-R1-01 … MB-R1-03): a site's QNC transfer is never signed on
 * a balance nobody read or one that does not cover it (the wallet's unconfirmed transfers counted), as the extension and
 * the app's own Send form refuse it; a wallet-only aiqnet.io page refused natively on Android says so and opens the same
 * page as on iOS; and a send every node refused for good is said as refused, and answered as the extension answers it.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { createDappProvider, CODES, previewShort, spendableNano } = require('../src/browser/dappProvider');
const DappSheet = require('../src/browser/DappSheet').default;
const { sendShort, sendUnread, SEND_ARM_MS } = require('../src/browser/DappSheet');
const { sendAnswer } = require('../src/browser/BrowserScreen');
const t = require('../src/i18n').makeT('en');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://shop.example';
const FEE = '150000';
const QNC = 1_000_000_000n;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => { await AsyncStorage.clear(); });

function setup(over = {}) {
  const views = [];
  const grants = new Map([[SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: QNET }]]);
  const deps = {
    now: () => Date.now(),
    state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET }),
    grants: { get: async (o) => grants.get(o) || null, put: async () => {}, remove: async () => {} },
    feeNano: () => Number(FEE),
    signMessage: jest.fn(),
    tokenInfo: jest.fn(),
    contractKind: jest.fn(async () => 'none'),
    prepareSend: jest.fn(async () => ({ nonce: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO] })),
    recheckSend: jest.fn(async () => ({ balanceNano: String(10n * QNC) })),
    send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: 5, refusal: null, refusalFinal: false })),
    transactionStatus: jest.fn(),
    isCurrent: () => true,
    emit: () => {},
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = { origin: SITE, binding: { origin: SITE, doc: 'd', id: 'x', nav: 1 } };
  return { p, deps, ctx, shown: () => views[views.length - 1] };
}
const pay = (s, amount) => s.p.request(s.ctx, 'qnet_sendTransaction', { to: TO, amount });

describe('MB-R1-01: a site\'s QNC transfer is refused when the balance is unread or short', () => {
  it('the rule: an unread balance, a short one, and what the unconfirmed transfers still take', () => {
    const d = { type: 'transfer', amountNano: String(50n * QNC), feeNano: FEE, totalNano: String(50n * QNC + 150000n) };
    expect(sendUnread('transfer', { balanceNano: null })).toBe(true);
    expect(sendShort('transfer', d, { balanceNano: null })).toBe(true);
    expect(sendShort('transfer', d, { balanceNano: String(10n * QNC) })).toBe(true);
    expect(sendShort('transfer', d, { balanceNano: String(60n * QNC) })).toBe(false);
    // 60 QNC, of which an unconfirmed 20 QNC transfer (and its fee) may still go: 50 more does not fit, unless it
    // replaces that transfer (at most one of the two can apply).
    const preview = {
      balanceNano: String(60n * QNC), transferFeeNano: FEE, replaceNonce: 7,
      pending: [{ nonce: 7, kind: 'transfer', amountNano: Number(20n * QNC) }, { nonce: 6, kind: 'call', amountNano: null }],
    };
    expect(spendableNano(preview)).toBe(40n * QNC - 150000n);
    expect(previewShort(d, preview, 'append')).toBe(true);
    expect(previewShort(d, preview, 'replace')).toBe(false);
    expect(spendableNano({ ...preview, balanceNano: '1' })).toBe(0n);
  });

  it('the approval signs nothing on an unread or a short balance', async () => {
    for (const balanceNano of [null, String(10n * QNC)]) {
      const s = setup();
      s.deps.prepareSend.mockResolvedValue({ nonce: 5, balanceNano, verified: true, counterparties: [TO] });
      pay(s, '50').catch(() => {});
      await tick();
      await s.p.loadPreview(s.shown().id);
      expect(await s.p.approve(s.shown().id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
      expect(s.deps.send).not.toHaveBeenCalled();
    }
  });

  it('the balance is read again before signing: spent meanwhile, the sheet reviews and nothing is signed', async () => {
    const s = setup();
    s.deps.recheckSend.mockResolvedValue({ balanceNano: String(1n * QNC) });
    pay(s, '5').catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(await s.p.approve(s.shown().id)).toEqual({ status: 'review' });
    expect(s.deps.recheckSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'transfer' }));
    expect(s.deps.send).not.toHaveBeenCalled();
    // Covered now: it goes.
    s.deps.recheckSend.mockResolvedValue({ balanceNano: String(10n * QNC) });
    await s.p.loadPreview(s.shown().id);
    expect((await s.p.approve(s.shown().id)).status).toBe('done');
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });

  // A site's send never goes in addition (MOB-BR-R4-02): an append signs nothing, whatever the balance.
  it('an append is never signed for a site; a replace of the unconfirmed transfer goes', async () => {
    const pending = [{ nonce: 6, state: 'accepted', kind: 'transfer', to: TO, amountNano: Number(8n * QNC), ageMs: 60000 }];
    const s = setup();
    s.deps.prepareSend.mockResolvedValue({
      nonce: null, confirmed: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO], pending, replaceNonce: 6, replaceHash: 'h', appendNonce: 7,
    });
    pay(s, '5').catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(s.shown().preview.transferFeeNano).toBe(FEE);
    expect(await s.p.approve(s.shown().id, 'append')).toEqual({ status: 'review' });
    expect(s.deps.send).not.toHaveBeenCalled();
    expect((await s.p.approve(s.shown().id, 'replace')).status).toBe('done');
    expect(s.deps.send).toHaveBeenCalledWith(expect.objectContaining({ nonce: 6, choice: expect.objectContaining({ mode: 'replace' }) }));
  });

  describe('the sheet', () => {
    const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('\n');
    const button = (tree, label) => tree.root.findAllByType(TouchableOpacity)
      .find((b) => b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('') === label);
    const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));
    const mounted = [];
    afterEach(async () => { await act(async () => { while (mounted.length) mounted.pop().unmount(); }); });
    async function mount(view) {
      const props = {
        view, t, accounts: { qnet: QNET, solana: SOL }, authenticate: jest.fn(async () => true),
        actions: { approve: jest.fn(async () => ({ status: 'done' })), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() },
      };
      let tree;
      await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
      mounted.push(tree);
      return { tree, props };
    }
    const base = { id: 't1', kind: 'send', origin: SITE, busy: false, queued: 0, outcome: null };
    const transfer = { type: 'transfer', to: TO, amountNano: String(50n * QNC), feeNano: FEE, totalNano: String(50n * QNC + 150000n) };

    it('a short or unread balance keeps Confirm off and says why', async () => {
      for (const [balanceNano, line] of [[String(10n * QNC), 'dapp_send_insufficient'], [null, 'dapp_send_preview_failed']]) {
        const { tree } = await mount({ ...base, id: `t-${line}`, details: transfer, preview: { nonce: 5, balanceNano, verified: true, counterparties: [TO] } });
        expect(texts(tree)).toContain(t(line));
        await wait(SEND_ARM_MS + 100);
        // Short: Send stays off. Unread: no Send at all, and Try again reads the balance again (MB-R2-03).
        if (balanceNano) expect(button(tree, t('dapp_send')).props.disabled).toBe(true);
        else expect([button(tree, t('dapp_send')), !!button(tree, t('dapp_retry'))]).toEqual([undefined, true]);
      }
    });

    it('a balance that covers the total but not with the unconfirmed transfers says that, until it replaces them', async () => {
      const preview = {
        nonce: null, confirmed: 5, balanceNano: String(60n * QNC), verified: true, counterparties: [TO], transferFeeNano: FEE,
        pending: [{ nonce: 6, state: 'accepted', kind: 'transfer', to: TO, amountNano: Number(20n * QNC), ageMs: 60000 }],
        replaceNonce: 6, appendNonce: null, inFlight: false, recent: [],
      };
      const { tree } = await mount({ ...base, details: transfer, preview });
      const pick = (v) => tree.root.find((n) => n.props.testID === `pick-${v}` && typeof n.props.onPress === 'function');
      expect(texts(tree)).toContain(t('dapp_send_insufficient_pending'));
      await wait(SEND_ARM_MS + 100);
      expect(button(tree, t('dapp_send')).props.disabled).toBe(true);
      await act(async () => { pick('replace').props.onPress(); });
      expect(texts(tree)).not.toContain(t('dapp_send_insufficient_pending'));
    });

    it('MB-R1-03: a final refusal is said as the Send form says it; one that may heal says it is sent again', async () => {
      const final = await mount({ ...base, id: 'f', details: transfer, preview: null, outcome: { error: CODES.INTERNAL, refusal: 'insufficient balance', final: true } });
      // The node's reason in the app's language, never its own words (L-12).
      expect(texts(final.tree)).toContain(t('tx_note_refused_final', { reason: t('tx_refusal_balance') }));
      expect(texts(final.tree)).not.toMatch(/insufficient balance/);
      expect(texts(final.tree)).not.toContain(t('dapp_send_unknown'));
      const heals = await mount({ ...base, id: 'h', details: transfer, preview: null, outcome: { status: 'unknown', refusal: 'mempool full', txHash: null } });
      expect(texts(heals.tree)).toContain(t('tx_note_refused', { reason: t('tx_refusal_busy') }));
      expect(texts(heals.tree)).not.toMatch(/mempool full/);
      const quiet = await mount({ ...base, id: 'q', details: transfer, preview: null, outcome: { status: 'unknown', txHash: null } });
      expect(texts(quiet.tree)).toContain(t('dapp_send_unknown'));
    });
  });
});

describe('MB-R1-03: a send every node refused for good is answered as the extension answers it', () => {
  it('the wallet\'s outcome as the provider takes it: final only when every node answered and waiting cannot heal it', () => {
    expect(sendAnswer({ success: true, txHash: 'h', nonce: 3 })).toEqual({ txHash: 'h', status: 'submitted', nonce: 3, refusal: null, refusalFinal: false });
    expect(sendAnswer({ success: false, nonce: 3, refusal: 'insufficient balance', refusalUncertain: false }))
      .toMatchObject({ status: 'unknown', refusal: 'insufficient balance', refusalFinal: true });
    expect(sendAnswer({ success: false, nonce: 3, refusal: 'insufficient balance', refusalUncertain: true })).toMatchObject({ refusalFinal: false });
    expect(sendAnswer({ success: false, nonce: 3, refusal: 'mempool full' })).toMatchObject({ refusalFinal: false });
    expect(sendAnswer({ success: false, nonce: 3 })).toMatchObject({ status: 'unknown', refusal: null, refusalFinal: false });
  });

  it('the page gets -32603 and the sheet the reason; a refusal that may heal keeps the extension\'s unknown', async () => {
    const s = setup();
    s.deps.send.mockResolvedValue({ txHash: null, status: 'unknown', nonce: 5, refusal: 'insufficient balance', refusalFinal: true });
    const asked = pay(s, '1');
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(await s.p.approve(s.shown().id)).toEqual({ status: 'failed', code: CODES.INTERNAL });
    await expect(asked).rejects.toMatchObject({ code: CODES.INTERNAL });
    expect(s.shown().outcome).toEqual({ error: CODES.INTERNAL, refusal: 'insufficient balance', final: true });

    const h = setup();
    h.deps.send.mockResolvedValue({ txHash: null, status: 'unknown', nonce: 5, refusal: 'mempool full', refusalFinal: false });
    const later = pay(h, '1');
    await tick();
    await h.p.loadPreview(h.shown().id);
    expect((await h.p.approve(h.shown().id)).status).toBe('done');
    const result = await later;
    expect(result).toMatchObject({ status: 'unknown', txHash: null, nonce: '5' });
    expect(result).not.toHaveProperty('refusal'); // the page's result keeps the extension's shape
    expect(h.shown().outcome).toMatchObject({ status: 'unknown', refusal: 'mempool full' });
  });
});

describe('MB-R1-02: a wallet-only page refused natively on Android is said and opened as on iOS', () => {
  const BrowserScreen = require('../src/browser/BrowserScreen').default;
  const { WebView } = require('react-native-webview');

  async function openShop() {
    let tree;
    await act(async () => {
      tree = renderer.create(React.createElement(BrowserScreen, {
        visible: true, wallet: null, credential: '', walletManager: {}, t: (k) => k, onSheet: () => {}, confirmAction: () => {},
      }));
    });
    const bookmark = tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && typeof n.props.onPress === 'function');
    await act(async () => { bookmark.props.onPress(); });
    // The address bar (it shows the explorer's address from the moment it is opened).
    const bar = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function' && /^browser-address/.test(n.props.testID || ''))[0];
    await act(async () => { bar.props.onPress(); });
    const field = tree.root.findAll((n) => n.props && typeof n.props.onSubmitEditing === 'function')[0];
    await act(async () => { field.props.onChangeText('shop.example/pay'); });
    await act(async () => { field.props.onSubmitEditing(); });
    const web = () => tree.root.findByType(WebView).props;
    expect(web().source).toEqual({ uri: 'https://shop.example/pay' });
    const shown = () => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('\n');
    return { tree, web, shown };
  }
  const settle = () => act(() => new Promise((r) => { setTimeout(r, 10); }));

  it('a link, a redirect or a form: the notice, and the explorer in its place', async () => {
    const { tree, web, shown } = await openShop();
    let allowed;
    await act(async () => {
      allowed = web().onShouldStartLoadWithRequest({ url: 'https://aiqnet.io/node/activate', walletOnly: true, committed: false, loaded: true, wentBack: false });
    });
    await settle();
    expect(allowed).toBe(false);
    expect(shown()).toContain('browser_blocked_site');
    expect(web().source).toEqual({ uri: 'https://aiqnet.io/explorer' });
    await act(async () => { tree.unmount(); });
  });

  it('the page\'s own history change: the notice; the explorer only when there was nothing to go back to', async () => {
    const a = await openShop();
    await act(async () => {
      a.web().onShouldStartLoadWithRequest({ url: 'https://aiqnet.io/docs', walletOnly: true, committed: true, loaded: false, wentBack: true });
    });
    await settle();
    expect(a.shown()).toContain('browser_blocked_site');
    expect(a.web().source).toEqual({ uri: 'https://shop.example/pay' }); // the native side went back
    await act(async () => { a.tree.unmount(); });
    const b = await openShop();
    await act(async () => {
      b.web().onShouldStartLoadWithRequest({ url: 'https://aiqnet.io/docs', walletOnly: true, committed: true, loaded: false, wentBack: false });
    });
    await settle();
    expect(b.web().source).toEqual({ uri: 'https://aiqnet.io/explorer' });
    await act(async () => { b.tree.unmount(); });
  });

  it('the patched Android client reports every such refusal, and the patch file carries it', () => {
    const ROOT = path.join(__dirname, '..');
    const client = fs.readFileSync(path.join(ROOT, 'node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java'), 'utf8');
    const patch = fs.readFileSync(path.join(ROOT, 'patches', 'react-native-webview+14.0.1.patch'), 'utf8');
    expect(client).toMatch(/private void reportWalletOnly\(WebView view, String url, boolean committed, boolean loaded, boolean wentBack\)/);
    expect(client).toMatch(/shouldOverrideUrlLoading\(WebView view, String url\) \{\s*if \(!isAllowedNavigation\(Uri\.parse\(url\), true\)\) \{\s*reportWalletOnly\(view, url, false, true, false\);\s*return true;/);
    expect(client).toMatch(/if \(request\.isForMainFrame\(\)\) reportWalletOnly\(view, request\.getUrl\(\)\.toString\(\), false, true, false\);/);
    expect(client).toMatch(/reportWalletOnly\(webView, url, true, url\.equals\(mStartedUrl\), back\);/);
    expect(client).toMatch(/new TopShouldStartLoadWithRequestEvent\(reactTag, event\)/);
    for (const line of ['+    private void reportWalletOnly(WebView view, String url, boolean committed, boolean loaded, boolean wentBack) {',
      '+        reportWalletOnly(webView, url, true, url.equals(mStartedUrl), back);', '+      mStartedUrl = url;']) {
      expect([line, patch.includes(line)]).toEqual([line, true]);
    }
  });
});

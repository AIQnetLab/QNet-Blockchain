/**
 * Final audit, mobile fixer round 2, the in-app browser (MBR2-01 … MBR2-04): a page that loads another document of its
 * own origin leaves its sheet as a page that went away (through the real screen, not a faked isCurrent); a token transfer
 * or a call reads its balances again before signing and is never signed on a balance nobody read or one node alone gave;
 * a transaction's block height is one two genesis nodes agree on; and the iOS WebView uses public WebKit policy only.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;
const { Platform } = require('react-native');
const { sha3_256 } = require('js-sha3');
const { providerScript, PAGE_OPENED_METHOD } = require('../src/browser/providerScript');
const { PageSession } = require('../src/browser/bridge');
const { createDappProvider, CODES, ARM_MS, TIMINGS } = require('../src/browser/dappProvider');
const { sendShort, sendUnread } = require('../src/browser/DappSheet');
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES } = require('../src/config/nodes');

const AsyncStorage = require('@react-native-async-storage/async-storage');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const TOKEN = eon('c');
const WASM = eon('d');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://shop.example';
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => { await AsyncStorage.clear(); });

describe('MBR2-01: a new document of the same origin is a new page', () => {
  it('the provider announces its document once at its start; a second injection announces nothing', () => {
    const posted = [];
    const target = new EventTarget();
    const ctx = {
      location: { protocol: 'https:', hostname: 'shop.example', origin: SITE, href: `${SITE}/pay` },
      addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target), CustomEvent, crypto: require('crypto').webcrypto,
      ReactNativeWebView: { postMessage: (s) => posted.push(s) },
    };
    ctx.window = ctx;
    ctx.top = ctx;
    vm.createContext(ctx);
    vm.runInContext(providerScript(), ctx);
    vm.runInContext(providerScript(), ctx);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0])).toMatchObject({ target: 'qnet-bridge', method: PAGE_OPENED_METHOD });
    expect(PAGE_OPENED_METHOD).toMatch(/^[A-Za-z0-9_]{1,64}$/);
  });

  it('PageSession: a committed document makes every older binding stale, the origin kept', () => {
    const s = new PageSession();
    s.navigated(SITE);
    s.sawRequest(SITE, 'd1');
    const b = s.bind({ origin: SITE, doc: 'd1', id: '1' });
    s.newDocument();
    expect(s.isCurrent(b)).toBe(false);
    expect(s.origin).toBe(SITE);
    // The new document's first message is learned without another change.
    expect(s.sawRequest(SITE, 'd2')).toBe(false);
    expect(s.isCurrent(s.bind({ origin: SITE, doc: 'd2', id: '2' }))).toBe(true);
  });

  describe('through the browser screen', () => {
    const BrowserScreen = require('../src/browser/BrowserScreen').default;
    const { WebView } = require('react-native-webview');
    const DOC_A = '8b3f1c2a-1d2e-4f3a-9b4c-5d6e7f8a9b0c';
    const DOC_B = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const OS = Platform.OS;
    afterEach(() => { Platform.OS = OS; jest.restoreAllMocks(); });

    async function mount() {
      WebView.calls.length = 0;
      const sheets = [];
      const store = new Map();
      const wm = {
        async getSealedRecord(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
        async putSealedRecord(key, obj) { store.set(key, JSON.stringify(obj)); return true; },
      };
      let tree;
      await act(async () => {
        tree = TestRenderer.create(React.createElement(BrowserScreen, {
          visible: true, wallet: { qnetAddress: QNET, solanaAddress: SOL }, credential: 'qnet-session:x', walletManager: wm,
          t: (k) => k, onSheet: (s) => sheets.push(s), confirmAction: () => {},
        }));
      });
      const bookmark = tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && typeof n.props.onPress === 'function');
      await act(async () => { bookmark.props.onPress(); });
      const web = () => tree.root.findByType(WebView).props;
      await act(async () => { web().onNavigationStateChange({ url: `${SITE}/pay`, title: 'Pay', loading: false }); });
      const send = async (doc, method, id = `id-${method}`) => {
        const data = JSON.stringify({ target: 'qnet-bridge', doc, id, method });
        await act(async () => { web().onMessage({ nativeEvent: { isMainFrame: true, frameOrigin: SITE, data } }); });
      };
      const injected = () => WebView.calls.filter(([m]) => m === 'injectJavaScript').map(([, code]) => code);
      return { tree, web, send, injected, sheets, last: () => sheets[sheets.length - 1] };
    }

    it('Android: the new document\'s first message closes the old one\'s sheet; its approval does nothing', async () => {
      Platform.OS = 'android';
      const m = await mount();
      await m.send(DOC_A, PAGE_OPENED_METHOD);
      expect(m.injected()).toEqual([]); // the announcement gets no answer
      await m.send(DOC_A, 'qnet_requestAccounts');
      const { view, actions } = m.last();
      expect(view.kind).toBe('connect');
      // location.reload(), a link or a form to another page of the same site: no origin change, no request yet.
      await act(async () => { m.web().onLoadStart({ nativeEvent: { url: `${SITE}/processing` } }); }); // Android: pushState too
      expect(m.last()).not.toBe(null);
      await m.send(DOC_B, PAGE_OPENED_METHOD);
      expect(m.last()).toBe(null);
      let r;
      await act(async () => { r = await actions.approve(view.id); });
      expect(r).toMatchObject({ status: 'failed' });
      await act(async () => { await tick(); });
      expect(m.injected().some((c) => c.includes('id-qnet_requestAccounts'))).toBe(false);
      await act(async () => { m.tree.unmount(); });
    });

    it('iOS: the committed load of a new document closes the sheet at once, before the new page says anything', async () => {
      Platform.OS = 'ios';
      const m = await mount();
      await m.send(DOC_A, 'qnet_requestAccounts');
      expect(m.last().view.kind).toBe('connect');
      await act(async () => { m.web().onLoadStart({ nativeEvent: { url: `${SITE}/processing`, navigationType: 'other' } }); });
      expect(m.last()).toBe(null);
      await act(async () => { m.tree.unmount(); });
    });

    // Each leave is a rejection; one holds nothing back (XC-06, the extension since 28.09), the fifth within 10 minutes
    // makes the next document wait out the cooldown. A minute or more between sheets keeps the sheet budget out of it.
    it('a page that leaves its armed sheet this way counts as a rejection: the fifth makes the new document wait', async () => {
      Platform.OS = 'android';
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const m = await mount();
      const doc = (i) => `8b3f1c2a-1d2e-4f3a-9b4c-5d6e7f8a9b${String(i).padStart(2, '0')}`;
      for (let i = 0; i < 5; i++) {
        if (i > 0) now += TIMINGS.SHEET_BUDGET_SHORT_MS;
        await m.send(doc(i), 'qnet_requestAccounts', `ask-${i}`);
        expect(m.last().view.kind).toBe('connect');
        now += ARM_MS + 50;
        await m.send(doc(i + 1), PAGE_OPENED_METHOD);
        expect(m.last()).toBe(null);
      }
      await m.send(doc(5), 'qnet_requestAccounts', 'again');
      const answer = m.injected().find((c) => c.includes('"id":"again"'));
      expect(answer).toContain(`"code":${CODES.USER_REJECTED}`);
      expect(answer).toContain('Too many rejected requests');
      await act(async () => { m.tree.unmount(); });
    });
  });
});

describe('MBR2-02: a token transfer or a call is signed only on balances read again and read for sure', () => {
  function setup(over = {}) {
    const views = [];
    const grants = new Map([[SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: QNET }]]);
    const deps = {
      now: () => Date.now(),
      state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET }),
      grants: { get: async (o) => grants.get(o) || null, put: async () => {}, remove: async () => {} },
      feeNano: () => 150000,
      signMessage: jest.fn(),
      tokenInfo: jest.fn(async () => ({ standard: 'qrc20', name: 'Game Gold', symbol: 'GOLD', decimals: 6 })),
      contractKind: jest.fn(async (a) => (a === WASM ? 'contract' : a === TOKEN ? 'token' : 'none')),
      prepareSend: jest.fn(async () => ({
        nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [TO],
        tokenBalanceBase: '9000000', tokenVerified: true, depositNano: '10000000', listed: true,
      })),
      recheckSend: jest.fn(async () => ({ balanceNano: '10000000000', tokenBalanceBase: '9000000', depositNano: '10000000' })),
      send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: 5 })),
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
  const tokenAsk = (s) => s.p.request(s.ctx, 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.5' });

  it('balances read again just before signing: the same send goes; nothing read, less now or a new deposit signs nothing', async () => {
    for (const [fresh, sent] of [
      [{ balanceNano: '10000000000', tokenBalanceBase: '9000000', depositNano: '10000000' }, true],
      [{ balanceNano: '10000000000', tokenBalanceBase: null, depositNano: '10000000' }, false],
      [{ balanceNano: null, tokenBalanceBase: '9000000', depositNano: '10000000' }, false],
      [{ balanceNano: '10000000000', tokenBalanceBase: '100', depositNano: '10000000' }, false], // spent meanwhile
      [{ balanceNano: '100', tokenBalanceBase: '9000000', depositNano: '10000000' }, false],
      [{ balanceNano: '10000000000', tokenBalanceBase: '9000000', depositNano: '0' }, false], // the total shown changed
      [null, false],
    ]) {
      const s = setup();
      s.deps.recheckSend.mockResolvedValue(fresh);
      tokenAsk(s).catch(() => {});
      await tick();
      await s.p.loadPreview(s.shown().id);
      const id = s.shown().id;
      const r = await s.p.approve(id);
      expect([fresh, s.deps.send.mock.calls.length > 0]).toEqual([fresh, sent]);
      expect(s.deps.recheckSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'tokenTransfer', amountBase: '2500000' }));
      if (!sent) {
        expect(r).toEqual({ status: 'review' });
        await tick();
        expect(s.shown()).toMatchObject({ id, notice: 'recheck' }); // the sheet stays, with a new preview to review
      }
    }
  });

  it('a call reads the QNC balance again; a page that left meanwhile ends as a page that left', async () => {
    const s = setup();
    s.deps.recheckSend.mockResolvedValue({ balanceNano: '1' });
    s.p.request(s.ctx, 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'play', args: '' }).catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(await s.p.approve(s.shown().id)).toEqual({ status: 'review' });
    expect(s.deps.send).not.toHaveBeenCalled();
    let current = true;
    const left = setup({ isCurrent: () => current });
    left.deps.recheckSend.mockImplementation(async () => { current = false; return { balanceNano: '10000000000' }; });
    const asked = left.p.request(left.ctx, 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'play', args: '' });
    await tick();
    await left.p.loadPreview(left.shown().id);
    expect(await left.p.approve(left.shown().id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
    await expect(asked).rejects.toMatchObject({ code: CODES.USER_REJECTED });
    expect(left.deps.send).not.toHaveBeenCalled();
  });

  it('a preview whose token or QNC balance could not be read offers no Send (the sheet and the provider alike)', async () => {
    const d = { type: 'tokenTransfer', amountBase: '1', feeNano: '1' };
    expect(sendUnread('tokenTransfer', { tokenBalanceBase: null, balanceNano: '5' })).toBe(true);
    expect(sendShort('tokenTransfer', d, { tokenBalanceBase: null, balanceNano: '5', depositNano: '0' })).toBe(true);
    expect(sendShort('contractCall', { feeNano: '1' }, { balanceNano: null })).toBe(true);
    expect(sendShort('tokenTransfer', d, { tokenBalanceBase: '5', balanceNano: '5', depositNano: '0' })).toBe(false);
    // A QNC transfer too (MB-R1-01): never signed and kept on a balance nobody read.
    expect(sendShort('transfer', { amountNano: '1', feeNano: '1' }, { balanceNano: null })).toBe(true);
    const s = setup();
    s.deps.prepareSend.mockResolvedValue({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [TO], tokenBalanceBase: null, depositNano: '0' });
    tokenAsk(s).catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(await s.p.approve(s.shown().id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
    expect(s.deps.recheckSend).not.toHaveBeenCalled();
    expect(s.deps.send).not.toHaveBeenCalled();
  });

  describe('a token balance to decide by', () => {
    const answerOf = (base) => (base === null ? null : JSON.stringify({ token_balance: base, block_height: 90, state_root: 'aa' }));
    const wallet = (byNode) => {
      global.fetch = jest.fn((url) => {
        const i = GENESIS_NODES.findIndex((b) => url.startsWith(b));
        const text = answerOf(byNode[i]);
        return Promise.resolve(text === null ? { ok: false, status: 503, text: async () => '' } : { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) });
      });
      return new WalletManager();
    };

    // The owner's rule: a send is decided only by a balance the committee certified. An answer no proof certifies never
    // counts, however many genesis nodes give it alike.
    it('an unverified answer never counts, not even when every genesis node gives the same balance', async () => {
      WalletManager.sendProofs.clear();
      expect(await wallet(['9000000', '1', '2', '3', '4']).checkedTokenBalance(TOKEN, QNET, 6))
        .toMatchObject({ ok: false });
      expect(await wallet(['9000000', '9000000', '9000000', '9000000', '9000000']).checkedTokenBalance(TOKEN, QNET, 6))
        .toMatchObject({ ok: false, balanceBase: null, verified: false });
      expect(await wallet([null, null, null, null, '5']).checkedTokenBalance(TOKEN, QNET, 6)).toMatchObject({ ok: false });
    });

    it('the browser reads it for the preview and again before signing', () => {
      const src = fs.readFileSync(path.join(__dirname, '../src/browser/BrowserScreen.js'), 'utf8');
      expect((src.match(/walletManager\.checkedTokenBalance\(d\.token, from, d\.decimals[,)]/g) || []).length).toBe(2);
      expect(src).not.toMatch(/getTokenBalanceWithProof/);
      expect(src).toMatch(/recheckSend: async \(d\) =>/);
    });
  });
});

describe('MBR2-03: a transaction\'s block height is one two genesis nodes agree on', () => {
  const H = '7'.repeat(64);
  it('one node\'s height alone is no height', async () => {
    const heights = [777, 778, 779, 780, 781];
    global.fetch = jest.fn((url) => {
      const i = GENESIS_NODES.findIndex((b) => url.startsWith(b));
      const h = heights[i];
      return Promise.resolve(h === null ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({ status: 'found', transaction: { hash: H, status: 'confirmed', block_height: h } }) });
    });
    const wm = new WalletManager();
    expect(await wm._agreedBlockHeight(H)).toBe(null);
    heights.splice(0, 5, 777, 777, 777, 777, 777);
    expect(await wm._agreedBlockHeight(H)).toBe(777);
    heights.splice(0, 5, 777, null, null, null, null);
    expect(await wm._agreedBlockHeight(H)).toBe(null);
  });
});

describe('MBR2-04: the iOS WebView uses public WebKit policy only', () => {
  it('neither the patch nor the installed library carries the private "allow without app link" value', () => {
    const root = path.join(__dirname, '..');
    const patch = fs.readFileSync(path.join(root, 'patches', 'react-native-webview+14.0.1.patch'), 'utf8');
    const impl = fs.readFileSync(path.join(root, 'node_modules', 'react-native-webview', 'apple', 'RNCWebViewImpl.m'), 'utf8');
    for (const text of [patch, impl]) {
      expect(text).not.toMatch(/QNetAllowWithoutAppLink|WKNavigationActionPolicyAllow \+ 2|AllowWithoutTryingAppLink/);
    }
    expect(patch).toContain('+                decisionHandler(WKNavigationActionPolicyAllow);');
    expect(patch).toContain('+    decisionHandler(WKNavigationActionPolicyAllow);');
  });
});

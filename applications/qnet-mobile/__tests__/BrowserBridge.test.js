// The in-app browser's bridge (spec mobile-browser "Origin integrity", audit R22): a request's origin is the one
// the WebView reported for the top frame, never anything in the message; a subframe or an unpatched library
// (no native origin) is refused; an answer reaches only the page that asked, and none after the page navigated.
// The page-side provider runs here in a sandboxed window, exactly as injected.
const vm = require('vm');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;
const { providerScript, PAGE_OPENED_METHOD } = require('../src/browser/providerScript');
const { readBridgeMessage, responseScript, eventScript, PageSession } = require('../src/browser/bridge');

class FakeMessageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.data = init.data;
    this.origin = init.origin;
    this.source = init.source;
  }
}

function page(href = 'https://dapp.example/app', { top = true, bridge = true } = {}) {
  const target = new EventTarget();
  const posted = [];
  const u = new URL(href);
  const ctx = {
    location: { protocol: u.protocol, hostname: u.hostname, origin: u.origin, href },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
    MessageEvent: FakeMessageEvent,
    crypto: require('crypto').webcrypto,
  };
  ctx.window = ctx;
  ctx.top = top ? ctx : {};
  if (bridge) ctx.ReactNativeWebView = { postMessage: (s) => posted.push(s) };
  vm.createContext(ctx);
  const announced = [];
  target.addEventListener('qnet:announceProvider', (e) => announced.push(e.detail));
  return { ctx, posted, announced, run: (code) => vm.runInContext(code, ctx) };
}

const settledWithin = (promise, ms = 30) => Promise.race([
  promise.then((v) => ({ value: v }), (e) => ({ error: e })),
  new Promise((r) => setTimeout(() => r('pending'), ms)),
]);

describe('the page-side provider', () => {
  it('announces the QNet wallet on channel mobile, with the extension\'s page API', () => {
    const p = page();
    p.run(providerScript());
    expect(p.announced).toHaveLength(1);
    const { info, provider } = p.announced[0];
    expect(info).toMatchObject({ name: 'QNet Wallet', rdns: 'io.aiqnet.wallet', channel: 'mobile' });
    expect(info.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Object.isFrozen(provider) && Object.isFrozen(info)).toBe(true);
    expect(provider.isQNet).toBe(true);
    expect(p.ctx.qnet).toBe(provider);
    // A second injection (both injection points run on Android) changes nothing.
    p.run(providerScript());
    expect(p.announced).toHaveLength(1);
    // Answers qnet:requestProvider.
    p.ctx.dispatchEvent(new CustomEvent('qnet:requestProvider'));
    expect(p.announced).toHaveLength(2);
  });

  it('is not installed in a subframe, on plain http (release), or twice', () => {
    const sub = page('https://dapp.example/', { top: false });
    sub.run(providerScript());
    expect(sub.announced).toHaveLength(0);
    expect(sub.ctx.qnet).toBeUndefined();
    const http = page('http://localhost:3000/');
    http.run(providerScript());
    expect(http.announced).toHaveLength(0);
    const dev = page('http://localhost:3000/');
    dev.run(providerScript({ dev: true }));
    expect(dev.announced).toHaveLength(1);
    const plain = page('http://example.com/');
    plain.run(providerScript({ dev: true }));
    expect(plain.announced).toHaveLength(0);
  });

  it('sends the method and params only; the answer the app delivers reaches this document and origin only', async () => {
    const p = page();
    p.run(providerScript());
    // The document announces itself once at its start (MBR2-01): a new page to the app, with no answer to wait for.
    const opened = JSON.parse(p.posted[0]);
    expect(opened).toMatchObject({ target: 'qnet-bridge', method: PAGE_OPENED_METHOD });
    const { provider } = p.announced[0];
    const pending = provider.request({ method: 'qnet_chainId' });
    const sent = JSON.parse(p.posted[1]);
    expect(Object.keys(sent).sort()).toEqual(['doc', 'id', 'method', 'target']);
    expect(sent).toMatchObject({ target: 'qnet-bridge', method: 'qnet_chainId', doc: opened.doc });

    const read = readBridgeMessage({ isMainFrame: true, frameOrigin: 'https://dapp.example', data: p.posted[1] });
    expect(read).toMatchObject({ ok: true, origin: 'https://dapp.example', id: sent.id, doc: sent.doc });
    const binding = new PageSession().bind(read);

    // Another origin's answer, or another document's, is not taken.
    p.run(responseScript({ ...binding, origin: 'https://evil.example' }, { ok: true, result: 'forged' }));
    p.run(responseScript({ ...binding, doc: '00000000-0000-4000-8000-000000000000' }, { ok: true, result: 'stale' }));
    expect(await settledWithin(pending)).toBe('pending');

    p.run(responseScript(binding, { ok: true, result: { chainId: 'q1337', network: 'testnet' } }));
    expect(await settledWithin(pending)).toEqual({ value: { chainId: 'q1337', network: 'testnet' } });
  });

  it('errors carry the extension\'s codes; without the app\'s bridge a request fails at once with 4900', async () => {
    const p = page();
    p.run(providerScript());
    const { provider } = p.announced[0];
    const pending = provider.request({ method: 'qnet_signMessage', params: { message: 'hi' } });
    const read = readBridgeMessage({ isMainFrame: true, frameOrigin: 'https://dapp.example', data: p.posted[p.posted.length - 1] });
    p.run(responseScript(new PageSession().bind(read), { ok: false, error: { code: 4100, message: 'Unauthorized' } }));
    const r = await settledWithin(pending);
    expect(r.error.code).toBe(4100);
    await expect(provider.request({ method: '' })).rejects.toMatchObject({ code: -32602 });

    const bare = page('https://dapp.example/', { bridge: false });
    bare.run(providerScript());
    await expect(bare.announced[0].provider.request({ method: 'qnet_chainId' })).rejects.toMatchObject({ code: 4900 });
  });

  it('a -32602 for a parameter the network does not accept carries only that reason; no other data reaches the page', async () => {
    const p = page();
    p.run(providerScript());
    const { provider } = p.announced[0];
    const answer = async (error) => {
      const pending = provider.request({ method: 'qnet_sendTransaction', params: {} });
      const read = readBridgeMessage({ isMainFrame: true, frameOrigin: 'https://dapp.example', data: p.posted[p.posted.length - 1] });
      p.run(responseScript(new PageSession().bind(read), { ok: false, error }));
      return (await settledWithin(pending)).error;
    };
    const unsupported = await answer({ code: -32602, message: 'x', data: { reason: 'UNSUPPORTED_PARAM', extra: 'secret' } });
    expect([unsupported.code, unsupported.message, unsupported.data]).toEqual([-32602, 'Unsupported parameter', { reason: 'UNSUPPORTED_PARAM' }]);
    expect(Object.isFrozen(unsupported.data)).toBe(true);
    for (const error of [{ code: -32602, data: { reason: 'OTHER' } }, { code: 4100, data: { reason: 'UNSUPPORTED_PARAM' } }]) {
      const e = await answer(error);
      expect([e.message, e.data]).toEqual([error.code === 4100 ? 'Unauthorized' : 'Invalid params', undefined]);
    }
  });

  it('events reach pages of their origin', () => {
    const p = page();
    p.run(providerScript());
    const seen = [];
    p.announced[0].provider.on('accountsChanged', (a) => seen.push(a));
    p.run(eventScript('https://evil.example', 'accountsChanged', { qnet: 'x' }));
    p.run(eventScript('https://dapp.example', 'accountsChanged', {}));
    expect(seen).toEqual([{}]);
    expect(() => eventScript('https://dapp.example', 'chainChanged', {})).toThrow();
  });
});

describe('reading a message: the origin comes from native only', () => {
  const doc = '8b3f1c2a-1d2e-4f3a-9b4c-5d6e7f8a9b0c';
  const body = (extra = {}) => JSON.stringify({ target: 'qnet-bridge', doc, id: 'r1', method: 'qnet_accounts', ...extra });

  it('takes the native origin, whatever the body says', () => {
    const r = readBridgeMessage({
      isMainFrame: true, frameOrigin: 'https://dapp.example', url: 'https://aiqnet.io/', data: body({ params: { origin: 'https://aiqnet.io' } }),
    });
    expect(r).toMatchObject({ ok: true, origin: 'https://dapp.example' });
    // A body that names an origin at all is refused (the envelope has no such field), and answered to the real one.
    expect(readBridgeMessage({ isMainFrame: true, frameOrigin: 'https://dapp.example', data: body({ origin: 'https://aiqnet.io' }) }))
      .toEqual({ ok: false, reason: 'keys', reply: { origin: 'https://dapp.example', doc, id: 'r1' } });
  });

  it('refuses a subframe, a message without the native fields (unpatched library), and non-https origins', () => {
    expect(readBridgeMessage({ isMainFrame: false, frameOrigin: 'https://dapp.example', data: body() }).reason).toBe('subframe');
    expect(readBridgeMessage({ frameOrigin: 'https://dapp.example', data: body() }).reason).toBe('subframe');
    expect(readBridgeMessage({ isMainFrame: true, url: 'https://dapp.example/', data: body() }).reason).toBe('origin');
    for (const o of ['http://dapp.example', 'null', 'https://dapp.example/path', 'file://', 'https://u@dapp.example']) {
      expect([o, readBridgeMessage({ isMainFrame: true, frameOrigin: o, data: body() }).reason]).toEqual([o, 'origin']);
    }
    expect(readBridgeMessage({ isMainFrame: true, frameOrigin: 'http://localhost:3000', data: body() }).reason).toBe('origin');
    expect(readBridgeMessage({ isMainFrame: true, frameOrigin: 'http://localhost:3000', data: body() }, { dev: true }).ok).toBe(true);
  });

  it('refuses malformed envelopes', () => {
    const base = { isMainFrame: true, frameOrigin: 'https://dapp.example' };
    expect(readBridgeMessage({ ...base, data: 'x'.repeat(16385) }).reason).toBe('size');
    expect(readBridgeMessage({ ...base, data: '{' }).reason).toBe('json');
    expect(readBridgeMessage({ ...base, data: body({ target: 'qnet-provider' }) }).reason).toBe('target');
    expect(readBridgeMessage({ ...base, data: body({ doc: 'nope' }) }).reason).toBe('doc');
    expect(readBridgeMessage({ ...base, data: body({ id: 'bad id' }) }).reason).toBe('id');
    expect(readBridgeMessage({ ...base, data: body({ method: 'x y' }) }).reason).toBe('method');
    expect(readBridgeMessage({ ...base, data: { target: 'qnet-bridge' } }).reason).toBe('size');
  });

  it('an answer script is plain data behind an origin check, whatever the payload holds', () => {
    const binding = { origin: 'https://dapp.example', doc, id: 'r1', nav: 1 };
    const code = responseScript(binding, { ok: true, result: { text: '</script>\u2028\u2029"\');alert(1)//' } });
    expect(code.startsWith('(function(){try{if(window.top!==window||window.location.origin!=="https://dapp.example")return;')).toBe(true);
    expect(code).not.toMatch(/[\u2028\u2029<]/);
    expect(() => new vm.Script(code)).not.toThrow();
  });
});

describe('page sessions', () => {
  it('an answer is bound to the page: another origin, another document or a user navigation drops it', () => {
    const s = new PageSession();
    s.navigated('https://a.example');
    s.sawRequest('https://a.example', 'd1');
    const b = s.bind({ origin: 'https://a.example', doc: 'd1', id: '1' });
    expect(s.isCurrent(b)).toBe(true);
    expect(s.sawRequest('https://a.example', 'd1')).toBe(false);
    expect(s.sawRequest('https://a.example', 'd2')).toBe(true); // a new document of the same origin
    expect(s.isCurrent(b)).toBe(false);
    const b2 = s.bind({ origin: 'https://a.example', doc: 'd2', id: '2' });
    expect(s.navigated('https://b.example')).toBe(true);
    expect(s.isCurrent(b2)).toBe(false);
    const b3 = s.bind({ origin: 'https://b.example', doc: null, id: '3' });
    s.reset();
    expect(s.isCurrent(b3)).toBe(false);
  });
});

describe('the browser screen', () => {
  const BrowserScreen = require('../src/browser/BrowserScreen').default;
  const { WebView } = require('react-native-webview');
  const QNET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
  const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const DOC = '8b3f1c2a-1d2e-4f3a-9b4c-5d6e7f8a9b0c';

  function fakeWalletManager() {
    const store = new Map();
    return {
      store,
      async getSealedRecord(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
      async putSealedRecord(key, obj) { store.set(key, JSON.stringify(obj)); return true; },
      signOffchainMessage: jest.fn(),
      sendQNC: jest.fn(),
      resolveNonce: jest.fn(async () => ({ nonce: 7 })),
      getQNCBalanceWithProof: jest.fn(async () => ({ ok: true, balanceNano: '5000000000', verified: true })),
    };
  }

  async function mount() {
    WebView.calls.length = 0;
    const sheets = [];
    const wm = fakeWalletManager();
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
    await act(async () => { web().onNavigationStateChange({ url: 'https://dapp.example/app', title: 'dApp', loading: false }); });
    const send = async (method, params, native = {}) => {
      const data = JSON.stringify({ target: 'qnet-bridge', doc: DOC, id: `id-${method}`, method, ...(params ? { params } : {}) });
      await act(async () => { web().onMessage({ nativeEvent: { isMainFrame: true, frameOrigin: 'https://dapp.example', data, ...native } }); });
    };
    const injected = () => WebView.calls.filter(([m]) => m === 'injectJavaScript').map(([, code]) => code);
    return { tree, web, send, injected, sheets, wm };
  }

  it('shows the sheet for the origin the WebView reported, and answers only that page', async () => {
    const m = await mount();
    await m.send('qnet_chainId');
    expect(m.injected().pop()).toContain('"id":"id-qnet_chainId","ok":true,"result":{"chainId":"q1337","network":"testnet"}');
    await m.send('qnet_requestAccounts', undefined, { url: 'https://aiqnet.io/' });
    const shown = m.sheets[m.sheets.length - 1];
    expect(shown.view).toMatchObject({ kind: 'connect', origin: 'https://dapp.example' });
    await act(async () => { m.tree.unmount(); });
  });

  it('a subframe message and a message without the native origin get nothing: no sheet, no answer', async () => {
    const m = await mount();
    const before = m.injected().length;
    await m.send('qnet_requestAccounts', undefined, { isMainFrame: false });
    await m.send('qnet_requestAccounts', undefined, { frameOrigin: undefined });
    expect(m.injected().length).toBe(before);
    expect(m.sheets.filter(Boolean)).toHaveLength(0);
    await act(async () => { m.tree.unmount(); });
  });

  it('a navigation while a request waits closes its sheet and drops its answer', async () => {
    const m = await mount();
    await m.send('qnet_requestAccounts');
    expect(m.sheets[m.sheets.length - 1].view.kind).toBe('connect');
    await act(async () => { m.web().onNavigationStateChange({ url: 'https://other.example/', loading: true }); });
    expect(m.sheets[m.sheets.length - 1]).toBe(null);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(m.injected().some((c) => c.includes('id-qnet_requestAccounts'))).toBe(false);
    await act(async () => { m.tree.unmount(); });
  });

  it('a connect the user confirms stores a grant and answers with both addresses', async () => {
    const m = await mount();
    await m.send('qnet_requestAccounts');
    const { view, actions } = m.sheets[m.sheets.length - 1];
    await act(async () => { await actions.approve(view.id); });
    const answer = m.injected().find((c) => c.includes('id-qnet_requestAccounts'));
    expect(answer).toContain(`"result":{"qnet":"${QNET}","solana":"${SOL}"}`);
    expect(JSON.parse(m.wm.store.get('qnet_dapp_sites')).sites['https://dapp.example']).toMatchObject({ walletId: QNET });
    await m.send('qnet_accounts');
    expect(m.injected().pop()).toContain(`"qnet":"${QNET}"`);
    await act(async () => { m.tree.unmount(); });
  });
});

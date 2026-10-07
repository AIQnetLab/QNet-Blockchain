// The in-app browser after the final audit (MB-01..MB-09): an approval right after Face ID is never dropped; a contract
// call goes only to a contract that is no token; the site's pages kept out of the app are refused by the app itself, on
// every platform and however they are reached; the whole message is seen before Sign arms; a late request gets no sheet
// over another page; a refused transaction is not "pending"; nothing the wallet cannot pay for is offered; no comment
// names another product.
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TouchableOpacity } from 'react-native';

const { sha3_256 } = require('js-sha3');
const { createDappProvider, CODES, ARM_MS, SEND_ARM_MS } = require('../src/browser/dappProvider');
const DappSheet = require('../src/browser/DappSheet').default;
const { navigationDecision, EXPLORER_PAGE, WALLET_ONLY_PATHS } = require('../src/browser/url');
const { WalletManager } = require('../src/components/WalletManager');
const t = require('../src/i18n').makeT('en');

const ROOT = path.join(__dirname, '..');
const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const TOKEN = eon('c');
const WASM = eon('d');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://games.example';
const outcome = (promise) => promise.then((result) => ({ result }), (e) => ({ code: e.code }));
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(over = {}) {
  const views = [];
  let current = true;
  const grants = new Map([[SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: QNET }]]);
  const deps = {
    now: () => 1_000_000,
    state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET }),
    grants: { get: async (o) => grants.get(o) || null, put: async () => {}, remove: async () => {} },
    feeNano: () => 150000,
    signMessage: jest.fn(),
    tokenInfo: jest.fn(async () => ({ standard: 'qrc20', name: 'Gold', symbol: 'GOLD', decimals: 6 })),
    contractKind: jest.fn(async (a) => (a === WASM ? 'contract' : a === TOKEN ? 'token' : 'none')),
    prepareSend: jest.fn(async () => ({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [] })),
    send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: 5 })),
    transactionStatus: jest.fn(),
    isCurrent: () => current,
    emit: () => {},
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = () => ({ origin: SITE, binding: { origin: SITE, doc: 'd', id: 'x', nav: 1 } });
  return { p, deps, ctx, shown: () => views[views.length - 1], views, leave: () => { current = false; } };
}
const call = (s) => s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'play', args: '' });

describe('MB-01: an approval right after Face ID or the passcode is never dropped', () => {
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
  const button = (tree, label) => tree.root.findAllByType(TouchableOpacity)
    .find((b) => b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('') === label);
  const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));
  let listeners;
  let state;
  beforeEach(() => {
    listeners = [];
    state = AppState.currentState;
    AppState.addEventListener.mockImplementation((type, fn) => {
      listeners.push(fn);
      return { remove: () => { listeners = listeners.filter((l) => l !== fn); } };
    });
  });
  afterEach(() => {
    AppState.currentState = state;
    AppState.addEventListener.mockImplementation(() => ({ remove: jest.fn() }));
  });

  async function connectSheet(approve) {
    const view = { id: 'c1', kind: 'connect', origin: SITE, details: {}, preview: null, outcome: null, busy: false, queued: 0 };
    const props = {
      view, t, accounts: { qnet: QNET, solana: SOL },
      // The system's check: iOS reports the app inactive while it is on screen, and replies before it is active again.
      authenticate: jest.fn(async () => { AppState.currentState = 'inactive'; return true; }),
      actions: { approve, reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() },
    };
    let tree;
    await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
    await wait(ARM_MS + 100);
    return { tree, props };
  }

  it('waits for the app to be active again before it approves', async () => {
    const approve = jest.fn(async () => ({ status: 'done' }));
    const { tree } = await connectSheet(approve);
    const confirm = button(tree, t('dapp_connect')).props;
    let pressed;
    await act(async () => { confirm.onPressIn(); pressed = confirm.onPress(); await tick(); });
    expect(approve).not.toHaveBeenCalled();
    AppState.currentState = 'active';
    await act(async () => { for (const l of [...listeners]) l('active'); await pressed; });
    expect(approve).toHaveBeenCalledWith('c1', null);
    await act(async () => { tree.unmount(); });
  });

  it('a confirm the approval refused says so, and the sheet stays', async () => {
    const approve = jest.fn(async () => ({ status: 'failed', code: 4001 }));
    const { tree } = await connectSheet(approve);
    const confirm = button(tree, t('dapp_connect')).props;
    await act(async () => {
      confirm.onPressIn();
      const pressed = confirm.onPress();
      await tick();
      AppState.currentState = 'active';
      for (const l of [...listeners]) l('active');
      await pressed;
    });
    expect(approve).toHaveBeenCalled();
    expect(texts(tree)).toContain(t('dapp_approve_again'));
    await act(async () => { tree.unmount(); });
  });

  it('the browser reads whether the app is in front when it is asked, not a state rendered earlier', () => {
    const screen = fs.readFileSync(path.join(ROOT, 'src/browser/BrowserScreen.js'), 'utf8');
    expect(screen).toMatch(/AppState\.addEventListener\('change', \(next\) => \{ appActive\.current = next === 'active'; \}\)/);
    // ...and whether the page that asked is the one on screen (its tab in front, on its page) at that moment too.
    expect(screen).toMatch(/interactive: unlocked && !!live\.current\.visible && appActive\.current && pageOnScreen\(binding\)/);
    expect(screen).toMatch(/return !!tab && tab\.id === s\.active && !tab\.home && tab\.source !== null && !overviewRef\.current;/);
    const wallet = fs.readFileSync(path.join(ROOT, 'src/screens/WalletScreen.js'), 'utf8');
    expect(wallet).toMatch(/visible=\{shown && !linkRequest\}/);
  });
});

describe('MB-02: a contract call goes only to a contract that is no token', () => {
  it('a token, a plain account and an unreadable target get no sheet', async () => {
    for (const [kind, code] of [['token', CODES.INVALID], ['none', CODES.INVALID]]) {
      const s = setup();
      s.deps.contractKind.mockResolvedValue(kind);
      expect([kind, await outcome(call(s))]).toEqual([kind, { code }]);
      expect(s.views.filter(Boolean)).toHaveLength(0);
    }
    const s = setup();
    s.deps.contractKind.mockRejectedValue(Object.assign(new Error('x'), { code: 'TOKEN_UNAVAILABLE' }));
    expect(await outcome(call(s))).toEqual({ code: CODES.INTERNAL });
    const ok = setup();
    call(ok);
    await tick();
    expect(ok.shown()).toMatchObject({ kind: 'send', details: { type: 'contractCall', contract: WASM } });
  });

  it('the wallet asks two genesis nodes what the address is', async () => {
    const wm = new WalletManager();
    const answers = [
      { success: false, error: WalletManager.NOT_A_TOKEN }, { success: false, error: WalletManager.NOT_A_TOKEN },
      { success: true, token: { contract_address: WASM, standard: 'qrc20', decimals: 0, name: 'x', symbol: 'x' } },
    ];
    let i = 0;
    wm._getJson = jest.fn(async () => answers[i++ % answers.length]);
    expect(await wm.agreedContractKind(WASM)).toBe('contract');
    expect(WalletManager.contractKindOf({ success: false, error: 'Token not found' }, WASM)).toBe('none');
    expect(WalletManager.contractKindOf({ success: true, token: { contract_address: WASM, standard: 'qrc721', decimals: 0 } }, WASM)).toBe('token');
    expect(WalletManager.contractKindOf({ success: false, error: 'busy' }, WASM)).toBe(null);
    wm._getJson = jest.fn(async () => { throw new Error('down'); });
    await expect(wm.agreedContractKind(WASM)).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
  });
});

describe('MB-03 and MB-04: the pages the site keeps out of the app are refused by the app itself', () => {
  it('its home, /docs, /dao, /testnet and the extension page go to the explorer, in any frame', () => {
    for (const u of ['https://aiqnet.io', 'https://aiqnet.io/', 'https://aiqnet.io/docs', 'https://aiqnet.io/docs/rpc-api',
      'https://www.aiqnet.io/dao', 'https://aiqnet.io/testnet', 'https://aiqnet.io/qnet-wallet-extension', 'https://aiqnet.io/%64ocs']) {
      expect([u, navigationDecision(u)]).toEqual([u, { allow: false, reason: 'site', redirect: EXPLORER_PAGE }]);
      expect([u, navigationDecision(u, { topFrame: false })]).toEqual([u, { allow: false, reason: 'site' }]);
    }
    for (const u of ['https://aiqnet.io/explorer', 'https://aiqnet.io/privacy?from=app', 'https://aiqnet.io/docsite',
      'https://games.aiqnet.io/', 'https://example.com/docs']) {
      expect([u, navigationDecision(u).allow]).toEqual([u, true]);
    }
  });

  // LNK-05: explorer.aiqnet.io serves the same site; its pages are refused there too, whatever the site redirects.
  it('the same pages on explorer.aiqnet.io are refused, its explorer opens, and other subdomains stay ordinary sites', () => {
    for (const u of ['https://explorer.aiqnet.io/', 'https://explorer.aiqnet.io/activate', 'https://explorer.aiqnet.io/wallet',
      'https://explorer.aiqnet.io/Node?x=1', 'https://EXPLORER.aiqnet.io./testnet']) {
      expect([u, navigationDecision(u)]).toEqual([u, { allow: false, reason: 'site', redirect: EXPLORER_PAGE }]);
      expect([u, navigationDecision(u, { topFrame: false })]).toEqual([u, { allow: false, reason: 'site' }]);
    }
    for (const u of ['https://explorer.aiqnet.io/explorer', 'https://explorer.aiqnet.io/explorer/tx/abc',
      'https://games.aiqnet.io/', 'https://games.aiqnet.io/node', 'https://node1.aiqnet.io/node']) {
      expect([u, navigationDecision(u).allow]).toEqual([u, true]);
    }
  });

  it('the list is the site\'s own', () => {
    const site = path.join(ROOT, '..', 'qnet-explorer', 'frontend', 'src', 'lib', 'activate-view.ts');
    if (!fs.existsSync(site)) return;
    const list = /IN_APP_EXCLUDED_PAGES = \[([^\]]+)\]/.exec(fs.readFileSync(site, 'utf8'))[1]
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    for (const page of list) {
      const u = `https://aiqnet.io${page}`;
      expect([u, navigationDecision(u).reason]).toEqual([u, 'site']);
    }
    expect(WALLET_ONLY_PATHS).toEqual(expect.arrayContaining(list.filter((p) => p !== '/').map((p) => p.slice(1))));
  });

  it('a move within the page to one of them (iOS pushState) leaves it at once and never shows its address', async () => {
    const BrowserScreen = require('../src/browser/BrowserScreen').default;
    const { WebView } = require('react-native-webview');
    WebView.calls.length = 0;
    let tree;
    await act(async () => {
      tree = renderer.create(React.createElement(BrowserScreen, {
        visible: true, wallet: { qnetAddress: QNET, solanaAddress: SOL }, credential: 'x', walletManager: {},
        t: (k) => k, onSheet: () => {}, confirmAction: () => {},
      }));
    });
    const bookmark = tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && typeof n.props.onPress === 'function');
    await act(async () => { bookmark.props.onPress(); });
    const web = () => tree.root.findByType(WebView).props;
    await act(async () => { web().onNavigationStateChange({ url: 'https://aiqnet.io/explorer', title: 'Explorer', canGoBack: false }); });
    await act(async () => { web().onNavigationStateChange({ url: 'https://aiqnet.io/node/cabinet', title: 'Cabinet', canGoBack: true }); });
    expect(WebView.calls.map(([m]) => m)).toEqual(expect.arrayContaining(['stopLoading', 'goBack']));
    const shown = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
    expect(shown).not.toContain('/node');
    await act(async () => { tree.unmount(); });
  });
});

describe('MB-05: Sign arms only once the whole message was on screen', () => {
  const button = (tree, label) => tree.root.findAllByType(TouchableOpacity)
    .find((b) => b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('') === label);
  const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));

  it('a message as tall as the box, border included, is not all shown; one that fits inside it is', async () => {
    for (const [content, armed] of [[220, false], [219, false], [218, true], [150, true]]) {
      const view = { id: `m${content}`, kind: 'sign', origin: SITE, details: { message: 'x', byteLength: 1 }, preview: null, outcome: null, busy: false, queued: 0 };
      let tree;
      await act(async () => {
        tree = renderer.create(<DappSheet view={view} t={t} accounts={null} authenticate={async () => true}
          actions={{ approve: jest.fn(), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() }} />);
      });
      const box = tree.root.findAll((n) => n.props && n.props.testID === 'sign-message' && typeof n.props.onScroll === 'function')[0];
      expect(box.props.contentContainerStyle).toMatchObject({ padding: 10 }); // the padding is part of what is measured
      await act(async () => {
        box.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
        box.props.onContentSizeChange(300, content);
      });
      await wait(ARM_MS + 150);
      expect([content, button(tree, t('dapp_sign')).props.disabled]).toEqual([content, !armed]);
      await act(async () => { tree.unmount(); });
    }
  });
});

describe('MB-06: a request whose page went away while it was read gets no sheet over another page', () => {
  it('ends as rejected, and counts against its origin', async () => {
    let release;
    const s = setup();
    s.deps.tokenInfo.mockImplementation(() => new Promise((r) => { release = r; }));
    const asked = outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '1' }));
    await tick();
    s.leave(); // the page navigated while the token was read
    release({ standard: 'qrc20', name: 'Gold', symbol: 'GOLD', decimals: 6 });
    expect(await asked).toEqual({ code: CODES.USER_REJECTED });
    expect(s.views.filter(Boolean)).toHaveLength(0);
  });
});

describe('MB-07: a transaction the wallet no longer sends is not pending', () => {
  it('refused for good or stopped: unknown; still sent: pending', () => {
    const now = Date.now();
    expect(WalletManager.stillSent({ nonce: 3, createdAt: now - 60_000, state: 'open' }, now)).toBe(true);
    expect(WalletManager.stillSent({ nonce: 3, createdAt: now - 60_000, state: 'open', refusal: 'insufficient balance' }, now)).toBe(false);
    expect(WalletManager.stillSent({ nonce: 3, createdAt: now - 60_000, state: 'open', stopped: true }, now)).toBe(false);
    // Signed 40 min ago (no longer sent again by itself), accepted 10 min ago: a node may still hold it.
    expect(WalletManager.stillSent({ nonce: 3, createdAt: now - 40 * 60_000, acceptedAt: now - 10 * 60_000, state: 'accepted' }, now)).toBe(true);
    expect(WalletManager.stillSent({ nonce: 3, createdAt: now - 3600_000, acceptedAt: now - 3600_000, state: 'accepted' }, now)).toBe(false);
    const src = fs.readFileSync(path.join(ROOT, 'src/components/WalletManager.js'), 'utf8');
    expect(src).toMatch(/if \(confirmed < nonce\) return kept && WalletManager\.stillSent\(kept\) \? \{ \.\.\.unknown, status: 'pending' \} : unknown;/);
  });
});

describe('MB-08: nothing the wallet cannot pay for is sent', () => {
  it('a call or a token transfer the preview shows short is refused at approve, and nothing is signed', async () => {
    const s = setup();
    s.deps.prepareSend.mockResolvedValue({ nonce: 5, balanceNano: '1', verified: true, counterparties: [] });
    const asked = call(s);
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(await s.p.approve(s.shown().id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
    expect(s.deps.send).not.toHaveBeenCalled();
    s.p.reject(s.shown().id);
    await outcome(asked);
    const token = setup();
    token.deps.prepareSend.mockResolvedValue({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [], tokenBalanceBase: '5', depositNano: '0' });
    token.p.request(token.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '1' }).catch(() => {});
    await tick();
    await tick();
    await token.p.loadPreview(token.shown().id);
    expect(await token.p.approve(token.shown().id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
    expect(token.deps.send).not.toHaveBeenCalled();
    expect(SEND_ARM_MS).toBeGreaterThan(0);
  });
});

describe('MB-09: no comment names another product', () => {
  it('the WebView patch describes the behaviour only', () => {
    const patch = fs.readFileSync(path.join(ROOT, 'patches', 'react-native-webview+14.0.1.patch'), 'utf8');
    expect(patch).not.toMatch(/\bChrome\b|\bFirefox\b/);
  });
});

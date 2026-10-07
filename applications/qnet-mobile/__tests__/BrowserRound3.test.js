// Round-3 in-app browser findings: a POST navigation meets the same wallet-only rule (MB3-01), a message is signed
// only once all of it was shown (MB3-02), a page cannot raise sheets in a loop by ending each early (MB3-03), and no
// page opens a file picker on iOS either (MB3-04).
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signDetached: jest.fn(async (message) => `sig(${message})`),
  verifyDilithium: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const { createDappProvider, CODES, COOLDOWN_MESSAGE, LIMITS, TIMINGS, ARM_MS } = require('../src/browser/dappProvider');
const DappSheet = require('../src/browser/DappSheet').default;
const t = require('../src/i18n').makeT('en');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const patch = read('patches/react-native-webview+14.0.1.patch');

describe('MB3-01: a POST navigation meets the wallet-only rule', () => {
  it('every request passes shouldInterceptRequest, which answers a wallet-only page with an empty 403', () => {
    const client = read('node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java');
    for (const src of [client, patch]) {
      expect(src).toMatch(/public WebResourceResponse shouldInterceptRequest\(WebView view, WebResourceRequest request\)/);
      expect(src).toMatch(/boolean walletOnly = web && uri\.getHost\(\) != null && isWalletOnlyPage\(uri\.getHost\(\), uri\.getPath\(\)\);/);
      expect(src).toMatch(/if \(walletOnly \|\| \(request\.isForMainFrame\(\) && web && !isAllowedNavigation\(uri, true\)\)\)/);
      expect(src).toMatch(/new WebResourceResponse\("text\/plain", "utf-8", 403, "Forbidden"/);
      // One that committed anyway is left at once and never becomes the page on screen.
      expect(src).toMatch(/mCommittedUrl = mAllowedCommittedUrl;/);
    }
  });
});

const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
const button = (tree, label) => tree.root.findAllByType(TouchableOpacity)
  .find((b) => b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('') === label);
const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));

describe('MB3-02: a message is signed only once all of it was shown', () => {
  async function mountSign(message) {
    const view = {
      id: `s${Math.random()}`, kind: 'sign', origin: 'https://app.dapp.example', details: { message, byteLength: message.length },
      preview: null, outcome: null, busy: false, queued: 0,
    };
    const actions = { reject: jest.fn(), approve: jest.fn(), loadPreview: jest.fn(), dismiss: jest.fn() };
    let tree;
    await act(async () => {
      tree = renderer.create(<DappSheet view={view} actions={actions} t={t} authenticate={jest.fn(async () => true)} accounts={null} />);
    });
    const box = tree.root.findAll((n) => n.props && n.props.testID === 'sign-message' && typeof n.props.onScroll === 'function')[0];
    return { tree, box };
  }

  it('a long message keeps Sign disarmed until its box was scrolled to the end', async () => {
    const { tree, box } = await mountSign(`Hello${'\n'.repeat(300)}I owe the site 1,000,000 QNC.`);
    await act(async () => {
      box.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
      box.props.onContentSizeChange(300, 6000);
    });
    await wait(ARM_MS + 150);
    expect(button(tree, 'Sign').props.disabled).toBe(true);
    expect(texts(tree)).toContain(t('dapp_sign_scroll'));
    await act(async () => {
      box.props.onScroll({ nativeEvent: { contentOffset: { y: 2000 }, layoutMeasurement: { height: 220 }, contentSize: { height: 6000 } } });
    });
    await wait(ARM_MS + 150);
    expect(button(tree, 'Sign').props.disabled).toBe(true); // halfway is not the end
    await act(async () => {
      box.props.onScroll({ nativeEvent: { contentOffset: { y: 5780 }, layoutMeasurement: { height: 220 }, contentSize: { height: 6000 } } });
    });
    expect(button(tree, 'Sign').props.disabled).toBe(true); // the arm time starts only now
    await wait(ARM_MS + 150);
    expect(button(tree, 'Sign').props.disabled).toBe(false);
    expect(texts(tree)).not.toContain(t('dapp_sign_scroll'));
    await act(async () => { tree.unmount(); });
  });

  it('a message that fits its box arms after the usual wait', async () => {
    const { tree, box } = await mountSign('Log in to dapp.example');
    await act(async () => {
      box.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
      box.props.onContentSizeChange(300, 40);
    });
    await wait(ARM_MS + 150);
    expect(button(tree, 'Sign').props.disabled).toBe(false);
    await act(async () => { tree.unmount(); });
  });
});

describe('MB3-03: a page cannot raise sheets in a loop by ending each early', () => {
  const eon = (seed) => {
    const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
    return body + sha3_256(body).slice(0, 8);
  };
  const QNET = eon('a');
  const SITE = 'https://dapp.example';

  function setup() {
    let now = 1_000_000;
    let doc = 1;
    const views = [];
    const deps = {
      now: () => now,
      state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' }, walletId: QNET }),
      grants: { get: async () => null, put: async () => {}, remove: async () => {} },
      canonicalAddress: (a) => a,
      feeNano: () => 150000,
      contractKind: async () => 'none',
      signMessage: jest.fn(),
      prepareSend: jest.fn(),
      send: jest.fn(),
      isCurrent: (binding) => binding.doc === doc,
      emit: () => {},
      onChange: (v) => views.push(v),
    };
    const p = createDappProvider(deps);
    return {
      p, views,
      ctx: () => ({ origin: SITE, binding: { origin: SITE, doc, id: 'x', nav: 1 } }),
      reload: () => { doc += 1; p.pageChanged({ userInitiated: false }); },
      advance: (ms) => { now += ms; },
    };
  }
  const outcome = (promise) => promise.then((result) => ({ result }), (e) => ({ code: e.code, message: e.message }));

  // Pairs of sheets a minute apart: in each the page ends its first sheet long before it arms (counting nothing) and a
  // second within the same minute (a rejection). One rejection holds nothing back (XC-06, the extension since 28.09);
  // the fifth within 10 minutes brings the cooldown.
  it('a second sheet ended before its confirm armed, within a minute of the first, counts as a rejection', async () => {
    const s = setup();
    for (let pair = 0; pair < 5; pair++) {
      if (pair > 0) s.advance(TIMINGS.SHEET_BUDGET_SHORT_MS + 1);
      for (let i = 0; i < 2; i++) {
        const asked = outcome(s.p.request(s.ctx(), 'qnet_requestAccounts'));
        await new Promise((r) => setTimeout(r, 0));
        expect(s.views[s.views.length - 1]).toMatchObject({ kind: 'connect' });
        s.advance(200);
        s.reload();
        expect(await asked).toMatchObject({ code: CODES.USER_REJECTED });
      }
    }
    // The origin is in cooldown now: no eleventh sheet.
    expect(await outcome(s.p.request(s.ctx(), 'qnet_requestAccounts'))).toEqual({ code: CODES.USER_REJECTED, message: COOLDOWN_MESSAGE });
    expect(s.views.filter(Boolean)).toHaveLength(10);
  });

  it('every sheet counts against the origin\'s budget, however it ends', async () => {
    const s = setup();
    for (let i = 0; i < LIMITS.SHEET_BUDGET_SHORT; i++) {
      const r = outcome(s.p.request(s.ctx(), 'qnet_requestAccounts'));
      await new Promise((res) => setTimeout(res, 0));
      s.p.cancelWhere(() => true, CODES.USER_REJECTED); // ended without the user, counting no rejection
      expect(await r).toMatchObject({ code: CODES.USER_REJECTED });
      s.advance(1000);
    }
    expect(await outcome(s.p.request(s.ctx(), 'qnet_requestAccounts'))).toEqual({ code: CODES.USER_REJECTED, message: COOLDOWN_MESSAGE });
    s.advance(TIMINGS.SHEET_BUDGET_SHORT_MS);
    const later = outcome(s.p.request(s.ctx(), 'qnet_requestAccounts'));
    await new Promise((res) => setTimeout(res, 0));
    expect(s.views[s.views.length - 1]).toMatchObject({ kind: 'connect' });
    s.p.cancelWhere(() => true, CODES.USER_REJECTED);
    await later;
  });
});

describe('MB3-04: no file picker on iOS either', () => {
  it('file inputs are stopped in every frame, and iOS 18.4+ asks the delegate, which cancels', () => {
    const impl = read('node_modules/react-native-webview/apple/RNCWebViewImpl.m');
    for (const src of [impl, patch]) {
      expect(src).toMatch(/runOpenPanelWithParameters:\(id\)parameters initiatedByFrame:\(WKFrameInfo \*\)frame completionHandler:/);
      expect(src).toMatch(/completionHandler\(nil\);[\s+]*\}[\s+]*#endif/);
      expect(src).toMatch(/WKUserScript \*noFilePicker = \[\[WKUserScript alloc\] initWithSource:noFilePickerSource injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO\];/);
    }
    // The Android half, unchanged: onShowFileChooser answers false.
    expect(patch).toMatch(/public boolean onShowFileChooser\([^)]*\) \{[\s\S]{0,900}?\n\+\s+return false;\n\s+\}/);
    expect(read('src/browser/BrowserScreen.js')).toMatch(/no downloads or file picker/);
  });
});

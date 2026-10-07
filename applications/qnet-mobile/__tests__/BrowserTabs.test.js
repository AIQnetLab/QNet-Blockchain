// The in-app browser's tabs: the tab model (open, switch, close, the cap, close all), each tab's own page session (an
// answer goes into the tab that asked; a tab not in front gets no sheet), a sheet on screen is modal, Android back in the
// tab in front, "Clear browsing data" over every tab, the navigation policy in every tab, and the browsing session a new
// tab joins without clearing it (Android's `incognito` wipes the app's one cookie store whenever a web view is created
// with it).
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Text, View, StyleSheet } from 'react-native';

const fs = require('fs');
const path = require('path');

// A WebView that keeps what each instance was asked to do (the shared mock keeps every instance's calls in one list).
jest.mock('react-native-webview', () => {
  const mockReact = require('react');
  const { View: MockView } = require('react-native');
  const WebView = mockReact.forwardRef((props, ref) => {
    const calls = mockReact.useRef([]).current;
    mockReact.useImperativeHandle(ref, () => {
      const methods = {};
      for (const m of ['goBack', 'goForward', 'reload', 'stopLoading', 'injectJavaScript', 'clearCache', 'clearHistory']) {
        methods[m] = (...args) => { calls.push([m, ...args]); };
      }
      return methods;
    });
    return mockReact.createElement(MockView, { ...props, testID: 'webview', calls });
  });
  return { __esModule: true, default: WebView, WebView };
});

const { WebView } = require('react-native-webview');
const BrowserScreen = require('../src/browser/BrowserScreen').default;
const {
  MAX_TABS, createTabs, addTab, selectTab, closeTab, closeAllTabs, openInTab, remountTab, startsSession, findTab, canAddTab,
  updateTab, loseTab, showNav,
} = require('../src/browser/tabs');
const { incognitoFor } = require('../src/browser/webViewEvents');
const { PageSession, PAUSE_MEDIA_SCRIPT } = require('../src/browser/bridge');
const { CODES } = require('../src/browser/dappProvider');
const { loadHistory, rememberPage, clearHistory } = require('../src/browser/history');
const AsyncStorage = require('@react-native-async-storage/async-storage');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const QNET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://dapp.example';
const OTHER = 'https://game.example';
const DOC_1 = '8b3f1c2a-1d2e-4f3a-9b4c-5d6e7f8a9b0c';
const DOC_2 = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OS = Platform.OS;

afterEach(() => { Platform.OS = OS; });

describe('the tab model', () => {
  const ids = (s) => s.tabs.map((x) => x.id);

  it('opens a tab on the start page in front, switches, and stops at the cap', () => {
    expect(MAX_TABS).toBe(8);
    let s = createTabs('a');
    expect([ids(s), s.active]).toEqual([['a'], 'a']);
    expect(s.tabs[0]).toMatchObject({ source: null, home: true, nav: { url: '', canGoBack: false } });
    s = addTab(s, 'b');
    expect([ids(s), s.active]).toEqual([['a', 'b'], 'b']);
    s = selectTab(s, 'a');
    expect(s.active).toBe('a');
    expect(selectTab(s, 'a')).toBe(s);
    expect(selectTab(s, 'nope')).toBe(s);
    for (let i = 0; i < 20; i++) s = addTab(s, `x${i}`);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(canAddTab(s)).toBe(false);
    expect(addTab(s, 'more')).toBe(s);
    expect(addTab(createTabs('a'), 'a').tabs).toHaveLength(1); // an id is never used twice
  });

  it('closing the tab in front brings the next one forward (the one before for the last); the only tab leaves a fresh one', () => {
    let s = addTab(addTab(addTab(createTabs('a'), 'b'), 'c'), 'd');
    s = selectTab(s, 'b');
    s = closeTab(s, 'b', 'fresh');
    expect([ids(s), s.active]).toEqual([['a', 'c', 'd'], 'c']);
    s = closeTab(s, 'a', 'fresh'); // a tab behind: the one in front stays
    expect([ids(s), s.active]).toEqual([['c', 'd'], 'c']);
    s = selectTab(s, 'd');
    s = closeTab(s, 'd', 'fresh');
    expect([ids(s), s.active]).toEqual([['c'], 'c']);
    s = openInTab(s, 'c', 'https://dapp.example/');
    s = closeTab(s, 'c', 'fresh');
    expect([ids(s), s.active]).toEqual([['fresh'], 'fresh']);
    expect(s.tabs[0]).toMatchObject({ source: null, home: true });
    expect(closeTab(s, 'nope', 'x')).toBe(s);
  });

  it('the page a tab was given, opened again after the page moved on, reaches the web view again every time (M12)', () => {
    const A = 'https://dapp.example/';
    let s = openInTab(createTabs('a'), 'a', A);
    const sources = [findTab(s, 'a').source];
    for (let i = 0; i < 3; i++) {
      s = showNav(s, 'a', { url: 'https://dapp.example/elsewhere', title: '', canGoBack: true, canGoForward: false, loading: false });
      s = openInTab(s, 'a', A);
      sources.push(findTab(s, 'a').source);
    }
    // A GET of the same address each time, never the value the prop held before (React Native passes only a change).
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i].uri).toBe(A);
      expect(sources[i]).not.toEqual(sources[i - 1]);
      expect([undefined, 'GET']).toContain(sources[i].method);
    }
  });

  it('close all leaves one fresh tab on the start page', () => {
    let s = addTab(openInTab(createTabs('a'), 'a', 'https://dapp.example/'), 'b');
    s = closeAllTabs('z');
    expect([ids(s), s.active]).toEqual([['z'], 'z']);
    expect(s.tabs[0]).toMatchObject({ source: null, home: true, wipeKey: null });
  });

  it('only the first page opened while no tab holds a page starts the browsing session; later tabs and remounts join it', () => {
    let s = addTab(createTabs('a'), 'b');
    s = openInTab(s, 'a', 'https://one.example/');
    expect(startsSession(findTab(s, 'a'))).toBe(true);
    s = openInTab(s, 'b', 'https://two.example/');
    expect(startsSession(findTab(s, 'b'))).toBe(false);
    s = openInTab(s, 'a', 'https://three.example/'); // the same web view: nothing is created again
    expect(startsSession(findTab(s, 'a'))).toBe(true);
    s = remountTab(s, 'a'); // its content process died: a new web view joins the session as it is
    expect(startsSession(findTab(s, 'a'))).toBe(false);
    // A remount opens the page it showed, in a web view with no history yet; a lost tab behind waits for it.
    s = updateTab(s, 'a', { nav: { url: 'https://three.example/deep', title: 'Deep', canGoBack: true, canGoForward: true, loading: false } });
    s = loseTab(s, 'a');
    expect(findTab(s, 'a').lost).toBe(true);
    s = remountTab(s, 'a', 'https://three.example/deep');
    expect(findTab(s, 'a')).toMatchObject({
      lost: false, source: { uri: 'https://three.example/deep' }, nav: { url: 'https://three.example/deep', canGoBack: false, canGoForward: false },
    });
    expect(startsSession(findTab(s, 'a'))).toBe(false);
    expect(loseTab(createTabs('z'), 'z')).toEqual(createTabs('z')); // a tab without a page has nothing to lose
    expect(remountTab(createTabs('z'), 'z', 'https://x.example/')).toEqual(createTabs('z'));
    s = closeTab(s, 'a', 'x');
    s = updateTab(s, 'b', { home: true }); // the start page shown: its page stays loaded, the session goes on
    s = addTab(s, 'c');
    s = openInTab(s, 'c', 'https://four.example/');
    expect(startsSession(findTab(s, 'c'))).toBe(false);
    // Once no tab holds a page the session is over: the next page starts a new, empty one.
    s = closeTab(closeTab(s, 'b', 'x'), 'c', 'd');
    s = openInTab(s, 'd', 'https://five.example/');
    expect(startsSession(findTab(s, 'd'))).toBe(true);
  });
});

describe('the browsing session a new tab joins', () => {
  it('Android: only the web view that starts the session is incognito; iOS: every tab is (a store of its own, in memory)', () => {
    Platform.OS = 'android';
    expect([incognitoFor(true), incognitoFor(false), incognitoFor(undefined)]).toEqual([true, false, false]);
    Platform.OS = 'ios';
    expect([incognitoFor(true), incognitoFor(false)]).toEqual([true, true]);
  });

  it('why: Android\'s incognito wipes the app\'s one cookie store and every site\'s storage whenever a web view is created with it', () => {
    const kt = read('node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt');
    const setIncognito = kt.slice(kt.indexOf('fun setIncognito'), kt.indexOf('fun setInjectedJavaScript('));
    expect(setIncognito).toMatch(/CookieManager\.getInstance\(\)\.removeAllCookies\(null\)/);
    expect(setIncognito).toMatch(/android\.webkit\.WebStorage\.getInstance\(\)\.deleteAllData\(\)/);
    expect(setIncognito).toMatch(/LOAD_NO_CACHE/);
    // A tab's web view without it is kept off the cache the same way.
    expect(kt).toMatch(/fun setCacheEnabled[\s\S]{0,200}?LOAD_NO_CACHE/);
    const patch = read('patches/react-native-webview+14.0.1.patch');
    expect(patch).toContain('+        android.webkit.WebStorage.getInstance().deleteAllData();');
    // iOS: a store of its own in memory with it; the persistent default store without it, so every iOS tab keeps it.
    const impl = read('node_modules/react-native-webview/apple/RNCWebViewImpl.m');
    expect(impl).toMatch(/if \(_incognito\) \{\s*wkWebViewConfig\.websiteDataStore = \[WKWebsiteDataStore nonPersistentDataStore\];/);
    expect(impl).toMatch(/\} else if \(_cacheEnabled\) \{\s*wkWebViewConfig\.websiteDataStore = \[WKWebsiteDataStore defaultDataStore\];/);
    // The screen asks webViewEvents, never the platform, and turns the cache off for every tab.
    const screen = read('src/browser/BrowserScreen.js');
    expect(screen).toMatch(/incognito=\{incognitoFor\(startsSession\(tab\)\)\}/);
    expect(screen).toMatch(/cacheEnabled=\{false\}/);
    expect(screen).not.toMatch(/\bPlatform\b/);
  });

  it('a binding names its tab: it is never current in another tab\'s session, whatever else matches', () => {
    const a = new PageSession('tab1');
    const b = new PageSession('tab2');
    for (const s of [a, b]) s.sawRequest(SITE, DOC_1);
    const binding = a.bind({ origin: SITE, doc: DOC_1, id: 'x' });
    expect(binding.tab).toBe('tab1');
    expect([a.isCurrent(binding), b.isCurrent(binding)]).toEqual([true, false]);
  });
});

// ── The browser screen with tabs ─────────────────────────────────────────────────────────────────────────────────────
function fakeWalletManager() {
  const store = new Map();
  return {
    store,
    async getSealedRecord(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async putSealedRecord(key, obj) { store.set(key, JSON.stringify(obj)); return true; },
  };
}

const WALLET = { qnetAddress: QNET, solanaAddress: SOL };

async function mount({ wallet = WALLET, confirm = true } = {}) {
  const sheets = [];
  const confirms = [];
  const ref = React.createRef();
  const wm = fakeWalletManager();
  const props = {
    visible: true, wallet, credential: wallet ? 'qnet-session:x' : '', walletManager: wm,
    t: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k),
    onSheet: (s) => sheets.push(s),
    confirmAction: (title, body, ok, label) => { confirms.push({ title, body, label }); if (confirm) ok(); },
  };
  let tree;
  await act(async () => { tree = TestRenderer.create(<BrowserScreen ref={ref} {...props} />); });
  const m = {
    tree, ref, sheets, wm, props, confirms,
    last: () => sheets[sheets.length - 1] || null,
    pressable: (testID) => tree.root.findAll((n) => n.props.testID === testID && typeof n.props.onPress === 'function')[0],
    press: async (testID) => { await act(async () => { await m.pressable(testID).props.onPress(); }); },
    // The WebViews, in tab order (a tab without a page has none); the hidden one that wipes a cleared session apart.
    webs: () => tree.root.findAllByType(WebView).filter((w) => w.props.testID !== 'browser-wiper'),
    wiper: () => tree.root.findAllByType(WebView).filter((w) => w.props.testID === 'browser-wiper'),
    calls: (w) => w.findAll((n) => Array.isArray(n.props.calls))[0].props.calls,
    // What was injected into a page, apart from the script that pauses its media (`paused`).
    injected: (w) => m.calls(w).filter(([k, code]) => k === 'injectJavaScript' && code !== PAUSE_MEDIA_SCRIPT).map(([, code]) => code),
    paused: (w) => m.calls(w).filter(([k, code]) => k === 'injectJavaScript' && code === PAUSE_MEDIA_SCRIPT).length,
    shownText: () => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string' || typeof c === 'number').join('')).join('\n'),
    overviewShown: () => tree.root.findAll((n) => n.props.testID === 'browser-tab-overview').length > 0,
    // One per tab (a touchable's inner view carries its testID too).
    tabRows: () => tree.root.findAll((n) => /^browser-tab-tab\d+$/.test(n.props.testID || '') && typeof n.props.onPress === 'function', { deep: false }),
    // The address typed on the start page of the tab in front.
    openAddress: async (text) => {
      const field = tree.root.findAll((n) => n.props && typeof n.props.onSubmitEditing === 'function')[0];
      await act(async () => { field.props.onChangeText(text); });
      await act(async () => { field.props.onSubmitEditing(); });
    },
    newTab: async () => { await m.press('browser-tabs'); await m.press('browser-new-tab'); },
    switchTo: async (i) => { await m.press('browser-tabs'); await act(async () => { m.tabRows()[i].props.onPress(); }); },
    nav: async (w, url, extra = {}) => {
      await act(async () => { w.props.onNavigationStateChange({ url, title: 'Page', loading: false, ...extra }); });
    },
    send: async (w, { origin = SITE, doc = DOC_1, method, id = `id-${method}`, params } = {}) => {
      const data = JSON.stringify({ target: 'qnet-bridge', doc, id, method, ...(params ? { params } : {}) });
      // Not awaited: a request that opens a sheet is answered only when the sheet ends.
      await act(async () => { w.props.onMessage({ nativeEvent: { isMainFrame: true, frameOrigin: origin, data } }); });
    },
    // A request whose answer waits (a slow grant read): { done } settles once it is answered.
    sendLater: async (w, { origin = SITE, doc = DOC_1, method, id = `id-${method}` } = {}) => {
      const data = JSON.stringify({ target: 'qnet-bridge', doc, id, method });
      let done;
      await act(async () => { done = w.props.onMessage({ nativeEvent: { isMainFrame: true, frameOrigin: origin, data } }); });
      return { done };
    },
    menuItem: async (label) => {
      await act(async () => { tree.root.find((n) => n.props.accessibilityLabel === 'browser_menu' && n.props.onPress).props.onPress(); });
      const item = tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.findAllByType(Text).some((x) => x.props.children === label))[0];
      await act(async () => { item.props.onPress(); });
    },
    count: () => m.pressable('browser-tabs').findByType(Text).props.children,
    unmount: async () => { await act(async () => { tree.unmount(); }); },
  };
  return m;
}

// Two tabs, both with a page of dapp.example (the second in front), or of `second` for the second.
async function twoTabs(second = SITE) {
  const m = await mount();
  await m.openAddress('dapp.example/one');
  await m.nav(m.webs()[0], `${SITE}/one`);
  await m.newTab();
  await m.openAddress(`${second.replace('https://', '')}/two`);
  await m.nav(m.webs()[1], `${second}/two`);
  return m;
}

describe('each tab has its own page, WebView and page session', () => {
  it('Android: the first page\'s web view starts the session; a page in a new tab joins it and clears nothing', async () => {
    Platform.OS = 'android';
    const m = await twoTabs();
    const [w1, w2] = m.webs();
    expect([w1.props.incognito, w2.props.incognito]).toEqual([true, false]);
    for (const w of [w1, w2]) {
      expect(w.props).toMatchObject({
        cacheEnabled: false, thirdPartyCookiesEnabled: false, sharedCookiesEnabled: false, allowFileAccess: false,
        allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false, setSupportMultipleWindows: false,
        javaScriptCanOpenWindowsAutomatically: false, geolocationEnabled: false, paymentRequestEnabled: false,
        mediaCapturePermissionGrantType: 'deny', mixedContentMode: 'never', originWhitelist: ['https://*'],
        injectedJavaScriptForMainFrameOnly: true, injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
        saveFormDataDisabled: true, webviewDebuggingEnabled: false,
      });
    }
    // A third tab: still only the first web view carries it.
    await m.newTab();
    await m.openAddress('game.example/');
    expect(m.webs().map((w) => w.props.incognito)).toEqual([true, false, false]);
    await m.unmount();
  });

  it('iOS: every tab\'s web view is incognito, each with a store of its own', async () => {
    Platform.OS = 'ios';
    const m = await twoTabs();
    expect(m.webs().map((w) => w.props.incognito)).toEqual([true, true]);
    await m.unmount();
  });

  it('only the page of the tab in front is shown and touchable; the others stay loaded, hidden from touch and screen readers', async () => {
    const m = await twoTabs();
    const holders = m.webs().map((w) => w.parent);
    expect(holders.map((h) => h.props.pointerEvents)).toEqual(['none', 'auto']);
    expect(holders.map((h) => h.props.importantForAccessibility)).toEqual(['no-hide-descendants', 'auto']);
    await m.switchTo(0);
    expect(m.webs().map((w) => w.parent.props.pointerEvents)).toEqual(['auto', 'none']);
    expect(m.webs().map((w) => w.props.source.uri)).toEqual([`${SITE}/one`, `${SITE}/two`]); // nothing reloaded
    await m.unmount();
  });

  it('an answer goes into the tab that asked: the same request id and document in another tab resolves nothing there', async () => {
    const m = await twoTabs();
    const [w1, w2] = m.webs();
    // The tab in front asks to connect: its sheet names its origin.
    await m.send(w2, { method: 'qnet_requestAccounts', id: 'same' });
    const { view, actions } = m.last();
    expect(view).toMatchObject({ kind: 'connect', origin: SITE });
    // The tab behind sends the very same request (id, document, origin): it gets its own answer, a refusal, and the
    // sheet of the tab in front stays, unanswered.
    await m.send(w1, { method: 'qnet_requestAccounts', id: 'same' });
    expect(m.injected(w1)).toHaveLength(1);
    expect(m.injected(w1)[0]).toContain(`"id":"same","ok":false,"error":{"code":${CODES.USER_REJECTED}`);
    expect(m.injected(w2)).toEqual([]);
    expect(m.last().view.id).toBe(view.id);
    // A request that needs no sheet is answered behind too, into that tab only.
    await m.send(w1, { method: 'qnet_chainId' });
    expect(m.injected(w1).pop()).toContain('"id":"id-qnet_chainId","ok":true,"result":{"chainId":"q1337"');
    expect(m.injected(w2)).toEqual([]);
    // The approval answers the tab that asked, and no other.
    await act(async () => { await actions.approve(view.id); });
    const answer = m.injected(w2).find((c) => c.includes('"id":"same"'));
    expect(answer).toContain(`"result":{"qnet":"${QNET}","solana":"${SOL}"}`);
    expect(m.injected(w1).some((c) => c.includes(`"result":{"qnet"`))).toBe(false);
    await m.unmount();
  });

  it('a tab not in front gets no sheet (4001, no cooldown); in front, the same page asks and gets its sheet', async () => {
    const m = await twoTabs(OTHER);
    const [w1] = m.webs();
    await m.send(w1, { method: 'qnet_requestAccounts', id: 'behind' });
    expect(m.sheets.filter(Boolean)).toHaveLength(0);
    expect(m.injected(w1).pop()).toContain(`"code":${CODES.USER_REJECTED},"message":"User rejected the request"`);
    await m.switchTo(0);
    await m.send(m.webs()[0], { method: 'qnet_requestAccounts', id: 'front' });
    expect(m.last().view).toMatchObject({ kind: 'connect', origin: SITE });
    await m.unmount();
  });

  it('a request still being read when its tab goes behind gets no sheet over the tab now in front', async () => {
    const m = await twoTabs(OTHER);
    const w2 = m.webs()[1];
    // A grant read that does not answer yet: the request waits in it.
    let release;
    const gate = new Promise((r) => { release = r; });
    const get = m.wm.getSealedRecord;
    m.wm.getSealedRecord = async (...a) => { await gate; return get(...a); };
    const asked = await m.sendLater(w2, { origin: OTHER, method: 'qnet_requestAccounts', id: 'late' });
    await m.switchTo(0);
    release();
    await act(async () => { await asked.done; });
    expect(m.sheets.filter(Boolean)).toHaveLength(0);
    expect(m.injected(w2).find((c) => c.includes('"id":"late"'))).toContain(`"code":${CODES.USER_REJECTED}`);
    await m.unmount();
  });

  it('a sheet on screen is modal: no tab overview, no new tab, no switch; once it ends the tabs work again', async () => {
    const m = await twoTabs();
    await m.send(m.webs()[1], { method: 'qnet_requestAccounts' });
    const { view, actions } = m.last();
    await m.press('browser-tabs');
    expect(m.overviewShown()).toBe(false);
    // The menu's New tab does nothing either.
    await m.menuItem('browser_new_tab');
    expect(m.count()).toBe(2);
    expect(m.last().view.id).toBe(view.id); // the sheet is still the one on screen
    await act(async () => { actions.reject(view.id); });
    expect(m.last()).toBe(null);
    await m.press('browser-tabs');
    expect(m.overviewShown()).toBe(true);
    await m.unmount();
  });

  it('with the tab overview open no page is on screen: a request gets no sheet', async () => {
    const m = await twoTabs();
    await m.press('browser-tabs');
    await m.send(m.webs()[1], { method: 'qnet_requestAccounts', id: 'under' });
    expect(m.sheets.filter(Boolean)).toHaveLength(0);
    expect(m.injected(m.webs()[1]).pop()).toContain(`"code":${CODES.USER_REJECTED}`);
    await m.unmount();
  });

  it('an event reaches every tab of the origin: a connect in one tab, then locking and unlocking', async () => {
    const m = await twoTabs();
    const [w1, w2] = m.webs();
    await m.send(w2, { method: 'qnet_requestAccounts' });
    const { view, actions } = m.last();
    await act(async () => { await actions.approve(view.id); });
    const changed = (w) => m.injected(w).filter((c) => c.includes('"event":"accountsChanged"'));
    expect(changed(w1)).toHaveLength(1);
    expect(changed(w1)[0]).toContain(`"qnet":"${QNET}"`);
    await act(async () => { m.tree.update(<BrowserScreen ref={m.ref} {...m.props} wallet={null} credential="" />); });
    expect([changed(w1).pop(), changed(w2).pop()].every((c) => c.includes('"data":{}'))).toBe(true);
    await act(async () => { m.tree.update(<BrowserScreen ref={m.ref} {...m.props} />); });
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    expect([changed(w1).pop(), changed(w2).pop()].every((c) => c.includes(`"qnet":"${QNET}"`))).toBe(true);
    await m.unmount();
  });
});

describe('Android back with tabs', () => {
  it('the tab in front goes back in its own history; from its first page back leaves the browser tab', async () => {
    const m = await twoTabs();
    const [w1, w2] = m.webs();
    await m.nav(w1, `${SITE}/one/deeper`, { canGoBack: true });
    expect(m.ref.current.handleBack()).toBe(false); // the tab in front is on its first page
    expect(m.calls(w1).filter(([k]) => k === 'goBack')).toHaveLength(0);
    await m.switchTo(0);
    let handled;
    await act(async () => { handled = m.ref.current.handleBack(); });
    expect(handled).toBe(true);
    expect(m.calls(m.webs()[0]).filter(([k]) => k === 'goBack')).toHaveLength(1);
    expect(m.calls(w2).filter(([k]) => k === 'goBack')).toHaveLength(0);
    // The tab overview closes first.
    await m.press('browser-tabs');
    await act(async () => { handled = m.ref.current.handleBack(); });
    expect([handled, m.overviewShown()]).toEqual([true, false]);
    await m.unmount();
  });
});

describe('the tab overview', () => {
  it('names each tab by title or host (the start page by name), marks the one in front, switches and closes', async () => {
    const m = await twoTabs(OTHER);
    await m.newTab(); // a third tab, on its start page
    await m.press('browser-tabs');
    const rows = m.tabRows();
    const rowText = (r) => r.findAllByType(Text).map((x) => [].concat(x.props.children).join(''));
    expect(rows.map(rowText)).toEqual([['Page', 'dapp.example'], ['Page', 'game.example'], ['browser_home']]);
    expect(rows.map((r) => r.props.accessibilityState.selected)).toEqual([false, false, true]);
    expect(m.shownText()).toContain('browser_tabs_count');
    // X closes the tab in front: the one before it comes forward (it was the last).
    await act(async () => { m.pressable(rows[2].props.testID.replace('browser-tab-', 'browser-tab-close-')).props.onPress(); });
    expect(m.tabRows().map((r) => r.props.accessibilityState.selected)).toEqual([false, true]);
    // Closing a tab with a page ends its requests and its WebView.
    const second = m.tabRows()[1].props.testID.replace('browser-tab-', 'browser-tab-close-');
    await act(async () => { m.pressable(second).props.onPress(); });
    expect(m.webs()).toHaveLength(1);
    await act(async () => { m.tabRows()[0].props.onPress(); });
    expect(m.overviewShown()).toBe(false);
    await m.unmount();
  });

  it('a closed tab\'s page is answered nothing, not even a request that was still being read', async () => {
    const m = await twoTabs(OTHER);
    const w2 = m.webs()[1];
    let release;
    const gate = new Promise((r) => { release = r; });
    const get = m.wm.getSealedRecord;
    m.wm.getSealedRecord = async (...a) => { await gate; return get(...a); };
    const calls2 = m.calls(w2);
    const asked = await m.sendLater(w2, { origin: OTHER, method: 'qnet_accounts', id: 'gone' });
    await m.press('browser-tabs');
    await act(async () => { m.pressable(m.tabRows()[1].props.testID.replace('browser-tab-', 'browser-tab-close-')).props.onPress(); });
    expect(m.webs()).toHaveLength(1);
    release();
    await act(async () => { await asked.done; });
    expect(calls2.some(([k, c]) => k === 'injectJavaScript' && c.includes('"id":"gone"'))).toBe(false);
    await m.unmount();
  });

  it('New tab stops at 8 with a note (the menu says so too); Close all tabs leaves one start page', async () => {
    const m = await mount();
    await m.openAddress('dapp.example/');
    for (let i = 1; i < MAX_TABS; i++) await m.newTab();
    await m.press('browser-tabs');
    expect(m.tabRows()).toHaveLength(MAX_TABS);
    expect(m.pressable('browser-new-tab').props.disabled).toBe(true);
    expect(m.shownText()).toContain('browser_tabs_full');
    await act(async () => { m.tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.findAllByType(Text).some((x) => x.props.children === 'common_done'))[0].props.onPress(); });
    expect(m.overviewShown()).toBe(false);
    await m.menuItem('browser_new_tab');
    expect([m.count(), m.shownText().includes('browser_tabs_full')]).toEqual([MAX_TABS, true]);
    await m.press('browser-tabs');
    await m.press('browser-close-all');
    expect(m.overviewShown()).toBe(false);
    expect(m.webs()).toHaveLength(0);
    expect(m.count()).toBe(1);
    expect(m.tree.root.findAll((n) => n.props.testID === 'bookmark-aiqnet')).not.toHaveLength(0);
    await m.unmount();
  });

  it('the count and every new string exist in all eleven languages', () => {
    const translations = require('../src/i18n/translations').default;
    const keys = [
      'browser_tabs_count', 'browser_new_tab', 'browser_close_tab', 'browser_close_all_tabs', 'browser_tabs_full',
      'browser_close_all_title', 'browser_close_all_body',
    ];
    expect(Object.keys(translations).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh-CN']);
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of keys) expect([lang, k, typeof table[k] === 'string' && table[k].length > 0]).toEqual([lang, k, true]);
      expect([lang, table.browser_tabs_count.includes('{count}'), table.browser_tabs_full.includes('{max}'), table.browser_close_tab.includes('{title}')])
        .toEqual([lang, true, true, true]);
    }
  });
});

describe('"Clear browsing data" and the rules every tab keeps', () => {
  beforeEach(() => AsyncStorage.clear());

  it('closes every tab, ends every request and forgets the recent pages; the next page starts a new session', async () => {
    Platform.OS = 'android';
    const m = await twoTabs(OTHER);
    const [w1, w2] = m.webs();
    await act(async () => { await w1.props.onLoadEnd({ nativeEvent: { url: `${SITE}/one`, title: 'One' } }); });
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    expect((await loadHistory()).map((e) => e.url)).toEqual([`${SITE}/one`]); // a page behind is remembered too
    await m.send(w2, { origin: OTHER, method: 'qnet_requestAccounts', id: 'open' });
    expect(m.last().view.kind).toBe('connect');
    const calls2 = m.calls(w2);
    // From the menu (the confirmation answers yes here).
    await m.menuItem('browser_clear');
    expect(m.last()).toBe(null);
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    // Its page is gone: the request ended and nothing is answered into it.
    expect(calls2.some(([k, c]) => k === 'injectJavaScript' && c.includes('"id":"open"'))).toBe(false);
    expect(m.webs()).toHaveLength(0);
    expect(m.count()).toBe(1);
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    expect(await loadHistory()).toEqual([]);
    expect(m.shownText()).toContain('browser_recent_empty');
    await m.press('bookmark-aiqnet');
    expect(m.webs()[0].props.incognito).toBe(true); // Android: this web view wipes what the old session left
    await m.unmount();
  });

  it('every tab keeps the navigation policy: http refused, a wallet-only aiqnet.io page opens the explorer in that tab', async () => {
    const m = await twoTabs(OTHER);
    const settle = () => act(() => new Promise((r) => { setTimeout(r, 10); }));
    let allowed;
    await act(async () => { allowed = m.webs()[1].props.onShouldStartLoadWithRequest({ url: 'http://game.example/', isTopFrame: true }); });
    expect(allowed).toBe(false);
    expect(m.shownText()).toContain('browser_blocked_insecure');
    await act(async () => { allowed = m.webs()[1].props.onShouldStartLoadWithRequest({ url: 'intent://x#Intent;end', isTopFrame: true }); });
    expect(allowed).toBe(false);
    await act(async () => { allowed = m.webs()[1].props.onShouldStartLoadWithRequest({ url: 'https://link.aiqnet.io/l/abc', isTopFrame: true }); });
    await settle();
    expect(allowed).toBe(false);
    expect(m.webs().map((w) => w.props.source.uri)).toEqual([`${SITE}/one`, 'https://aiqnet.io/explorer']);
    // Behind: refused and replaced the same way, in its own tab.
    await act(async () => { allowed = m.webs()[0].props.onShouldStartLoadWithRequest({ url: 'https://aiqnet.io/node', isTopFrame: true }); });
    await settle();
    expect(allowed).toBe(false);
    expect(m.webs().map((w) => w.props.source.uri)).toEqual(['https://aiqnet.io/explorer', 'https://aiqnet.io/explorer']);
    await m.unmount();
  });

  it('a wallet-only page reached within a page behind (pushState) is left in that tab and never becomes its address', async () => {
    const m = await twoTabs(OTHER);
    const w1 = m.webs()[0];
    await m.nav(w1, 'https://aiqnet.io/node/cabinet', { canGoBack: true });
    expect(m.calls(w1).map(([k]) => k)).toEqual(expect.arrayContaining(['stopLoading', 'goBack']));
    expect(m.calls(m.webs()[1]).map(([k]) => k)).not.toContain('goBack');
    await m.switchTo(0);
    expect(m.shownText()).not.toContain('/node');
    await m.unmount();
  });
});

// ── Review round: recent pages, the Android wipe, media, the overview for screen readers, close all, a lost renderer,
// the narrow toolbar, and the toolbar that follows the tab in front ──────────────────────────────────────────────────
const settle = () => act(() => new Promise((r) => { setTimeout(r, 10); }));

describe('the recent pages keep every page and outlive no clear', () => {
  beforeEach(() => AsyncStorage.clear());

  it('pages remembered at the same moment are all kept (no read-modify-write overwrites another)', async () => {
    await Promise.all([rememberPage(`${SITE}/a`, 'A'), rememberPage(`${OTHER}/b`, 'B'), rememberPage(`${SITE}/c`, 'C')]);
    expect((await loadHistory()).map((e) => e.url).sort()).toEqual([`${SITE}/a`, `${SITE}/c`, `${OTHER}/b`].sort());
  });

  it('a page being remembered when a clear is asked for is gone with it, on disk and in what it answers', async () => {
    await rememberPage(`${SITE}/old`, 'Old');
    const remembering = rememberPage(`${SITE}/late`, 'Late');
    const loading = loadHistory();
    await clearHistory();
    expect([await remembering, await loading]).toEqual([[], []]);
    expect(await loadHistory()).toEqual([]);
    expect(await AsyncStorage.getItem('qnet_browser_history')).toBe(null);
    // After the clear, pages are remembered again.
    expect((await rememberPage(`${SITE}/next`, 'Next')).map((e) => e.url)).toEqual([`${SITE}/next`]);
  });

  it('a load that finishes in a tab as "Clear browsing data" runs, or in a closed tab, brings nothing back', async () => {
    const m = await twoTabs(OTHER);
    const [w1, w2] = m.webs();
    const lateInClosedTab = w2.props.onLoadEnd;
    await act(async () => { await w1.props.onLoadEnd({ nativeEvent: { url: `${SITE}/one`, title: 'One' } }); });
    await settle();
    expect((await loadHistory()).map((e) => e.url)).toEqual([`${SITE}/one`]);
    // The tab behind finishes its next page; the clear comes before that page is written.
    await act(async () => {
      w1.props.onLoadEnd({ nativeEvent: { url: `${SITE}/later`, title: 'Later' } });
      m.ref.current.clearData();
    });
    await settle();
    expect(await loadHistory()).toEqual([]);
    expect(m.shownText()).toContain('browser_recent_empty');
    // A finish event of a tab that is gone (still queued when it closed) is not remembered.
    await act(async () => { await lateInClosedTab({ nativeEvent: { url: `${OTHER}/gone`, title: 'Gone' } }); });
    await settle();
    expect(await loadHistory()).toEqual([]);
    expect(m.shownText()).toContain('browser_recent_empty');
    await m.unmount();
  });
});

describe('"Clear browsing data" on Android wipes what the session left at once', () => {
  it('a hidden, script-less web view with incognito wipes it while no tab holds a page, then goes', async () => {
    Platform.OS = 'android';
    const m = await twoTabs(OTHER);
    expect(m.wiper()).toHaveLength(0);
    await m.menuItem('browser_clear');
    expect(m.webs()).toHaveLength(0);
    const [wiper] = m.wiper();
    expect(wiper.props).toMatchObject({
      incognito: true, source: { uri: 'about:blank' }, javaScriptEnabled: false, domStorageEnabled: false, cacheEnabled: false,
    });
    expect(wiper.props.onMessage).toBeUndefined();
    expect(wiper.props.injectedJavaScript).toBeUndefined();
    expect(wiper.props.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    expect(wiper.props.onShouldStartLoadWithRequest({ url: 'https://dapp.example/' })).toBe(false);
    expect(wiper.parent.props).toMatchObject({
      pointerEvents: 'none', importantForAccessibility: 'no-hide-descendants', accessibilityElementsHidden: true,
    });
    await act(async () => { wiper.props.onLoadEnd({ nativeEvent: { url: 'about:blank' } }); });
    expect(m.wiper()).toHaveLength(0);
    await m.unmount();
  });

  it('it never exists beside a page: opening one drops it, and that page\'s own web view starts the session', async () => {
    Platform.OS = 'android';
    const m = await twoTabs(OTHER);
    await m.menuItem('browser_clear');
    expect(m.wiper()).toHaveLength(1);
    await m.press('bookmark-aiqnet');
    expect(m.wiper()).toHaveLength(0);
    expect(m.webs().map((w) => w.props.incognito)).toEqual([true]);
    // Closing that page later does not bring the wiper back: only a clear does.
    await m.press('browser-tabs');
    await m.press('browser-close-all');
    expect([m.webs().length, m.wiper().length]).toEqual([0, 0]);
    await m.unmount();
  });

  it('iOS: no wiper (each tab\'s store was in memory and went with it)', async () => {
    Platform.OS = 'ios';
    const m = await twoTabs(OTHER);
    await m.menuItem('browser_clear');
    expect([m.webs().length, m.wiper().length]).toEqual([0, 0]);
    await m.unmount();
  });
});

describe('a page that leaves the screen stops playing', () => {
  it('the script pauses every audio and video element of the top document, its shadow roots and its own-origin frames', () => {
    expect(PAUSE_MEDIA_SCRIPT.endsWith('true;')).toBe(true);
    const media = [{ pause: jest.fn() }, { pause: jest.fn() }, { pause: jest.fn() }];
    const host = { shadowRoot: { querySelectorAll: (q) => (q === 'audio,video' ? [media[1]] : []) } };
    const doc = { querySelectorAll: (q) => (q === 'audio,video' ? [media[0]] : [host]) };
    const frame = { document: { querySelectorAll: (q) => (q === 'audio,video' ? [media[2]] : []) } };
    const foreign = { get document() { throw new Error('another origin'); } };
    const win = { frames: [foreign, frame] };
    // eslint-disable-next-line no-new-func
    new Function('document', 'window', PAUSE_MEDIA_SCRIPT)(doc, win);
    expect(media.map((x) => x.pause.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('switching or opening a tab pauses the one that went behind; Home pauses the page under the start page', async () => {
    const m = await twoTabs(OTHER);
    let [w1, w2] = m.webs();
    expect([m.paused(w1), m.paused(w2)]).toEqual([1, 0]); // the New tab that became the second sent the first behind
    await m.switchTo(0);
    [w1, w2] = m.webs();
    expect([m.paused(w1), m.paused(w2)]).toEqual([1, 1]);
    await m.switchTo(0); // the tab already in front: nothing goes behind
    expect([m.paused(w1), m.paused(w2)]).toEqual([1, 1]);
    await m.menuItem('browser_home');
    expect([m.paused(w1), m.paused(w2)]).toEqual([2, 1]);
    await m.unmount();
  });

  it('a hidden browser (another wallet tab, the lock screen) pauses every tab\'s page', async () => {
    const m = await twoTabs(OTHER);
    const before = m.webs().map(m.paused);
    await act(async () => { m.tree.update(<BrowserScreen ref={m.ref} {...m.props} visible={false} />); });
    expect(m.webs().map(m.paused)).toEqual(before.map((n) => n + 1));
    await m.unmount();
  });
});

describe('the tab overview for a screen reader, its close buttons, and close all', () => {
  const inside = (node, box) => {
    for (let p = node; p; p = p.parent) if (p === box) return true;
    return false;
  };

  it('while it is up, only the overview is reachable: the toolbar, the notices and the pages are hidden', async () => {
    const m = await twoTabs(OTHER);
    const chrome = () => m.tree.root.findAll((n) => n.props.testID === 'browser-chrome' && n.props.importantForAccessibility)[0];
    const menuButton = m.tree.root.find((n) => n.props.accessibilityLabel === 'browser_menu' && n.props.onPress);
    expect(inside(menuButton, chrome())).toBe(true);
    expect(inside(m.webs()[1], chrome())).toBe(true);
    expect(chrome().props).toMatchObject({ importantForAccessibility: 'auto', accessibilityElementsHidden: false });
    await m.press('browser-tabs');
    expect(chrome().props).toMatchObject({ importantForAccessibility: 'no-hide-descendants', accessibilityElementsHidden: true });
    const overview = m.tree.root.findAll((n) => n.props.testID === 'browser-tab-overview')[0];
    expect(overview.props.accessibilityViewIsModal).toBe(true);
    expect(inside(overview, chrome())).toBe(false);
    await m.unmount();
  });

  it('each × names the tab it closes', async () => {
    const m = await twoTabs(OTHER);
    await m.newTab();
    await m.press('browser-tabs');
    // One per tab (a touchable's inner view carries its testID too).
    const buttons = new Map(m.tree.root.findAll((n) => /^browser-tab-close-/.test(n.props.testID || '') && typeof n.props.onPress === 'function')
      .map((n) => [n.props.testID, n.props.accessibilityLabel]));
    const labels = [...buttons.values()];
    expect(labels).toEqual([
      'browser_close_tab{"title":"Page"}', 'browser_close_tab{"title":"Page"}', 'browser_close_tab{"title":"browser_home"}',
    ]);
    await m.unmount();
  });

  it('Close all tabs asks first while a tab holds a page (a No closes nothing); with none it just closes', async () => {
    const m = await mount({ confirm: false });
    await m.newTab();
    await m.press('browser-tabs');
    await m.press('browser-close-all'); // two start pages: nothing to lose, nothing asked
    expect([m.confirms.length, m.count()]).toEqual([0, 1]);
    await m.openAddress('dapp.example/');
    await m.newTab();
    await m.press('browser-tabs');
    await m.press('browser-close-all');
    expect(m.confirms).toEqual([{ title: 'browser_close_all_title', body: 'browser_close_all_body', label: 'browser_close_all_tabs' }]);
    expect([m.count(), m.webs().length]).toEqual([2, 1]); // answered No: every tab stays
    await m.unmount();
    // Answered yes: every tab closes.
    const y = await mount();
    await y.openAddress('dapp.example/');
    await y.press('browser-tabs');
    await y.press('browser-close-all');
    expect([y.confirms.length, y.count(), y.webs().length]).toEqual([1, 1, 0]);
    await y.unmount();
  });
});

describe('a lost render process (Android: one renderer for every tab)', () => {
  it('the tab in front reopens the page it showed; a tab behind drops its web view and reopens only when it comes forward', async () => {
    Platform.OS = 'android';
    const m = await twoTabs(OTHER);
    const [w1, w2] = m.webs();
    await m.nav(w1, `${SITE}/one/trade/123`, { canGoBack: true });
    await m.nav(w2, `${OTHER}/two/level/9`, { canGoBack: true });
    // Every tab's WebView reports it, the one behind first.
    await act(async () => { w1.props.onRenderProcessGone({ nativeEvent: { didCrash: false } }); });
    await act(async () => { w2.props.onRenderProcessGone({ nativeEvent: { didCrash: false } }); });
    // Only the tab in front has a WebView again, on the page it showed, joining the session (no wipe).
    expect(m.webs().map((w) => [w.props.source.uri, w.props.incognito])).toEqual([[`${OTHER}/two/level/9`, false]]);
    const back = m.tree.root.find((n) => n.props.accessibilityLabel === 'browser_back' && n.props.onPress);
    expect(back.props.disabled).toBe(true); // the new web view has no history yet
    await m.switchTo(0);
    expect(m.webs().map((w) => [w.props.source.uri, w.props.incognito]))
      .toEqual([[`${SITE}/one/trade/123`, false], [`${OTHER}/two/level/9`, false]]);
    await m.unmount();
  });

  it('closing the tab in front brings a lost tab forward with its new web view', async () => {
    Platform.OS = 'android';
    const m = await twoTabs(OTHER);
    await act(async () => { m.webs()[0].props.onRenderProcessGone({ nativeEvent: {} }); });
    expect(m.webs()).toHaveLength(1);
    await m.press('browser-tabs');
    await act(async () => { m.pressable(m.tabRows()[1].props.testID.replace('browser-tab-', 'browser-tab-close-')).props.onPress(); });
    expect(m.webs().map((w) => w.props.source.uri)).toEqual([`${SITE}/one`]);
    await m.unmount();
  });
});

describe('the toolbar', () => {
  const flat = (n) => StyleSheet.flatten(n.props.style) || {};
  const toolbarOf = (m) => m.tree.root.findAll((n) => n.type === View && typeof n.props.onLayout === 'function'
    && flat(n).flexDirection === 'row' && flat(n).paddingHorizontal === 4)[0];
  const tool = (m, label) => m.tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

  it('follows the tab in front: address, back and forward, stop or reload, and the progress bar', async () => {
    const m = await twoTabs(OTHER);
    const [w1, w2] = m.webs();
    await m.nav(w1, `${SITE}/one`, { canGoBack: true, canGoForward: false, loading: false });
    await m.nav(w2, `${OTHER}/two`, { canGoBack: false, canGoForward: true, loading: true });
    await act(async () => { w2.props.onLoadProgress({ nativeEvent: { progress: 0.4, loading: true } }); });
    await act(async () => { w1.props.onLoadProgress({ nativeEvent: { progress: 1, loading: false } }); });
    const bar = () => m.tree.root.findAll((n) => n.type === View && typeof flat(n).width === 'string' && flat(n).width.endsWith('%'))
      .map((n) => flat(n).width);
    const hostShown = () => ['dapp.example', 'game.example'].filter((h) => tool(m, h));
    const shown = () => ({
      host: hostShown(),
      back: tool(m, 'browser_back').props.disabled,
      forward: tool(m, 'browser_forward').props.disabled,
      stop: !!tool(m, 'browser_stop'),
      reload: !!tool(m, 'browser_reload'),
      bar: bar(),
    });
    const second = { host: ['game.example'], back: true, forward: false, stop: true, reload: false, bar: ['40%'] };
    expect(shown()).toEqual(second);
    await m.switchTo(0);
    expect(shown()).toEqual({ host: ['dapp.example'], back: false, forward: true, stop: false, reload: true, bar: [] });
    await m.switchTo(1);
    expect(shown()).toEqual(second);
    await m.unmount();
  });

  it('a tab behind says nothing (a refused navigation there shows no notice), and gets no event of another origin', async () => {
    const m = await twoTabs(OTHER);
    const [w1, w2] = m.webs();
    let allowed;
    await act(async () => { allowed = w1.props.onShouldStartLoadWithRequest({ url: 'http://dapp.example/', isTopFrame: true }); });
    expect(allowed).toBe(false);
    expect(m.shownText()).not.toContain('browser_blocked_insecure');
    // A connect in the tab of game.example: the tab of dapp.example is told nothing.
    await m.send(w2, { origin: OTHER, method: 'qnet_requestAccounts' });
    const { view, actions } = m.last();
    await act(async () => { await actions.approve(view.id); });
    expect(m.injected(w2).some((c) => c.includes('"event":"accountsChanged"'))).toBe(true);
    expect(m.injected(w1).some((c) => c.includes('"event"'))).toBe(false);
    await m.unmount();
  });

  it('on a 320 dp phone Forward moves into the menu, so the address keeps the room it had before the tabs button', async () => {
    const m = await twoTabs(OTHER);
    await m.nav(m.webs()[1], `${OTHER}/two`, { canGoForward: true });
    // One per tool (a touchable's inner view carries its label too).
    const tools = () => new Set(toolbarOf(m).findAll((n) => typeof n.props.onPress === 'function' && flat(n).width === 36)
      .map((n) => n.props.accessibilityLabel)).size;
    expect([tools(), !!tool(m, 'browser_forward')]).toEqual([5, true]);
    await act(async () => { toolbarOf(m).props.onLayout({ nativeEvent: { layout: { width: 320, height: 48 } } }); });
    expect([tools(), !!tool(m, 'browser_forward')]).toEqual([4, false]);
    // The room left for the address text at 320 dp: the toolbar's padding, the 36 dp tools, the address box's margins,
    // the pill's padding and the lock with its gap. About 121 dp, as before the tabs button (85 dp with five tools).
    const bar = flat(toolbarOf(m));
    const box = flat(m.tree.root.findAll((n) => n.type === View && flat(n).flex === 1 && flat(n).minWidth === 0 && flat(n).marginHorizontal === 2)[0]);
    const pill = flat(tool(m, 'game.example'));
    const room = (n) => 320 - 2 * bar.paddingHorizontal - n * 36 - 2 * box.marginHorizontal - 2 * pill.paddingHorizontal - 13 - pill.gap;
    expect([room(tools()), room(5)]).toEqual([121, 85]);
    // Forward is in the menu while there is a page to go forward to.
    await m.menuItem('browser_forward');
    expect(m.calls(m.webs()[1]).filter(([k]) => k === 'goForward')).toHaveLength(1);
    // A wider toolbar has the button again.
    await act(async () => { toolbarOf(m).props.onLayout({ nativeEvent: { layout: { width: 411, height: 48 } } }); });
    expect([tools(), !!tool(m, 'browser_forward')]).toEqual([5, true]);
    await m.unmount();
  });
});

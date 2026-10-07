// A tapped link opens at once, in its tab, with its address in the address bar. What was wrong:
//  - the address bar moved only when a navigation committed (the server's first answer), and on Android the loading
//    state too (its progress events carry no `loading`), so between a tap and the commit nothing changed on screen: the
//    same address, no progress bar, Reload in place of Stop; a page opened from the start page left the address empty;
//  - Android asks JS about every main-frame navigation while its UI thread waits (at most 250 ms); one JS did not
//    answer in time was refused (MB2-06) and JS's later "allow" went to a lock that no longer existed, so nothing loaded
//    it: a link tapped while the app was busy did nothing at all;
//  - a page given to a tab's WebView before, opened again once that WebView had moved on, loaded nothing (React Native
//    passes a prop to the native view only when its value changed), and the page on screen, opened again, neither.
// The address of a load in progress is shown without the lock or the bold domain; the page's origin, which requests and
// sheets are bound to, still follows the committed document only (MBL-02).
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, View, StyleSheet } from 'react-native';

const fs = require('fs');
const path = require('path');

// A WebView that keeps what each instance was asked to do.
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
  createTabs, openInTab, startLoad, showNav, dropPending, remountTab, findTab, updateTab, EMPTY_NAV,
} = require('../src/browser/tabs');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lib = (f) => read(path.join('node_modules', 'react-native-webview', f));
const ANDROID = 'android/src/main/java/com/reactnativecommunity/webview/';
const PATCH = 'patches/react-native-webview+14.0.1.patch';
const SITE = 'https://dapp.example';

describe('the tab model: the address a tab is loading', () => {
  const tab = (s) => findTab(s, 'a');

  it('an opened page shows its address at once; a page given before reaches the WebView again (a GET either way)', () => {
    let s = openInTab(createTabs('a'), 'a', `${SITE}/one`);
    expect(tab(s)).toMatchObject({ source: { uri: `${SITE}/one` }, pending: `${SITE}/one`, home: false, progress: 0 });
    s = showNav(s, 'a', { ...EMPTY_NAV, url: `${SITE}/one` });
    expect(tab(s).pending).toBe(null);
    s = showNav(s, 'a', { ...EMPTY_NAV, url: `${SITE}/two` }); // the page moved on by itself
    const before = tab(s).source;
    s = openInTab(s, 'a', `${SITE}/one`);
    expect(tab(s).source).toEqual({ uri: `${SITE}/one`, method: 'GET' });
    expect(tab(s).source).not.toEqual(before); // a changed value: React Native passes it to the native view
    s = openInTab(s, 'a', `${SITE}/one`);
    expect(tab(s).source).toEqual({ uri: `${SITE}/one` });
    expect(tab(openInTab(s, 'a', `${SITE}/three`)).source).toEqual({ uri: `${SITE}/three` });
  });

  it('a load in the top frame shows its address until the WebView says what is on screen; a move within the page does not', () => {
    expect(startLoad(createTabs('a'), 'a', `${SITE}/x`)).toEqual(createTabs('a')); // no page, no WebView
    let s = showNav(openInTab(createTabs('a'), 'a', `${SITE}/one`), 'a', { ...EMPTY_NAV, url: `${SITE}/one`, loading: false });
    s = updateTab(s, 'a', { progress: 1 });
    s = startLoad(s, 'a', 'https://game.example/');
    expect(tab(s)).toMatchObject({ pending: 'https://game.example/', progress: 0, nav: { url: `${SITE}/one` } });
    expect(startLoad(s, 'a', 'https://game.example/')).toBe(s); // the same load told twice
    s = showNav(s, 'a', { ...EMPTY_NAV, url: `${SITE}/one` }); // it ended without committing: the page on screen again
    expect(tab(s)).toMatchObject({ pending: null, nav: { url: `${SITE}/one` } });
    expect(startLoad(s, 'a', `${SITE}/one#part`)).toBe(s); // a fragment of the document on screen
    expect(tab(startLoad(s, 'a', `${SITE}/other#part`)).pending).toBe(`${SITE}/other#part`);
    expect(tab(startLoad(s, 'a', `${SITE}/one`)).pending).toBe(`${SITE}/one`); // the same page without a fragment loads
    expect(tab(dropPending(startLoad(s, 'a', `${SITE}/x`), 'a')).pending).toBe(null);
    expect(dropPending(s, 'a')).toBe(s);
    expect(tab(remountTab(startLoad(s, 'a', `${SITE}/x`), 'a', `${SITE}/one`)).pending).toBe(null);
  });
});

async function mount() {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(BrowserScreen, {
      visible: true, wallet: null, credential: '', walletManager: {}, t: (k) => k, onSheet: () => {}, confirmAction: () => {},
    }));
  });
  const flat = (n) => StyleSheet.flatten(n.props.style) || {};
  const pressable = (pred) => tree.root.findAll((n) => typeof n.props.onPress === 'function' && pred(n))[0];
  const m = {
    tree,
    web: () => tree.root.findAllByType(WebView)[0],
    calls: (name) => m.web().findAll((n) => Array.isArray(n.props.calls))[0].props.calls.filter(([k]) => k === name),
    // The address bar while a page is shown: its text, whether it is a load in progress, whether it has the lock.
    address: () => {
      const bar = pressable((n) => /^browser-address/.test(n.props.testID || ''));
      if (!bar) return null;
      const text = bar.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('');
      return {
        text,
        loading: bar.props.testID === 'browser-address-loading',
        lock: bar.findAll((n) => n.type && n.type.name === 'LockGlyph').length > 0,
      };
    },
    stop: () => !!pressable((n) => n.props.accessibilityLabel === 'browser_stop'),
    bar: () => tree.root.findAll((n) => n.type === View && typeof flat(n).width === 'string' && flat(n).width.endsWith('%')).map((n) => flat(n).width),
    notice: () => tree.root.findAllByType(Text).some((n) => /^browser_blocked/.test(String(n.props.children))),
    // Types an address and opens it (on a page, the address bar is tapped first).
    open: async (text) => {
      let field = tree.root.findAll((n) => n.props && typeof n.props.onSubmitEditing === 'function')[0];
      if (!field) {
        await act(async () => { pressable((n) => /^browser-address/.test(n.props.testID || '')).props.onPress(); });
        field = tree.root.findAll((n) => n.props && typeof n.props.onSubmitEditing === 'function')[0];
      }
      await act(async () => { field.props.onChangeText(text); });
      await act(async () => { field.props.onSubmitEditing(); });
    },
    tap: async (url, extra = {}) => {
      let allowed;
      await act(async () => { allowed = m.web().props.onShouldStartLoadWithRequest({ url, isTopFrame: true, navigationType: 'click', ...extra }); });
      return allowed;
    },
    nav: async (url, extra = {}) => {
      await act(async () => { m.web().props.onNavigationStateChange({ url, title: 'Page', loading: false, ...extra }); });
    },
    home: async () => {
      await act(async () => { tree.root.find((n) => n.props.accessibilityLabel === 'browser_menu' && n.props.onPress).props.onPress(); });
      const item = tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.findAllByType(Text).some((x) => x.props.children === 'browser_home'))[0];
      await act(async () => { item.props.onPress(); });
    },
    unmount: async () => { await act(async () => { tree.unmount(); }); },
  };
  return m;
}

describe('a tapped link opens at once, its address in the address bar', () => {
  it('the address shows the moment the link is let through, as loading (no lock), with Stop and the progress bar', async () => {
    const m = await mount();
    await m.open('dapp.example/one');
    // A page opened from the start page: its address at once, before the WebView reported anything.
    expect(m.address()).toEqual({ text: 'dapp.example', loading: true, lock: false });
    await m.nav(`${SITE}/one`);
    expect(m.address()).toEqual({ text: 'dapp.example', loading: false, lock: true });
    expect([m.stop(), m.bar()]).toEqual([false, []]);

    expect(await m.tap('https://game.example/start')).toBe(true);
    expect(m.address()).toEqual({ text: 'game.example', loading: true, lock: false });
    expect([m.stop(), m.bar()]).toEqual([true, ['5%']]);
    await act(async () => { m.web().props.onLoadProgress({ nativeEvent: { progress: 0.3 } }); }); // Android: no `loading`
    expect([m.stop(), m.bar()]).toEqual([true, ['30%']]);
    // The commit: the page's own address, with the lock.
    await m.nav('https://game.example/start', { loading: true });
    expect(m.address()).toEqual({ text: 'game.example', loading: false, lock: true });
    await m.unmount();
  });

  it('a navigation that ends without committing (a 204, a download, an error) puts back the page on screen', async () => {
    const m = await mount();
    await m.open('dapp.example/one');
    await m.nav(`${SITE}/one`);
    await m.tap('https://files.example/archive.zip');
    expect(m.address()).toMatchObject({ text: 'files.example', loading: true });
    // The finish event names the page still shown (the patched WebView on both platforms).
    await m.nav(`${SITE}/one`, { loading: false });
    expect(m.address()).toEqual({ text: 'dapp.example', loading: false, lock: true });
    expect(m.stop()).toBe(false);
    await m.unmount();
  });

  it('nothing that does not load in the top frame shows: a subframe, a refused address, a fragment of the page', async () => {
    const m = await mount();
    await m.open('dapp.example/one');
    await m.nav(`${SITE}/one`);
    const committed = { text: 'dapp.example', loading: false, lock: true };
    expect(await m.tap('https://ads.example/frame', { isTopFrame: false })).toBe(true);
    expect(m.address()).toEqual(committed);
    expect(await m.tap('data:text/html,x', { isTopFrame: false })).toBe(true); // a subframe judged as one
    expect(m.notice()).toBe(false);
    expect(await m.tap('http://game.example/')).toBe(false);
    expect(await m.tap('intent://x#Intent;end')).toBe(false);
    expect(m.address()).toEqual(committed);
    expect(await m.tap(`${SITE}/one#comments`)).toBe(true); // a move within the document: no load
    expect(await m.tap('about:blank')).toBe(true);
    expect(m.address()).toEqual(committed);
    expect(m.stop()).toBe(false);
    await m.unmount();
  });

  it('Stop drops the address being loaded and stops the page; back and reload drop it too', async () => {
    const m = await mount();
    await m.open('dapp.example/one');
    await m.nav(`${SITE}/one`, { canGoBack: true });
    await m.tap('https://game.example/');
    await act(async () => { m.tree.root.findAll((n) => n.props.accessibilityLabel === 'browser_stop' && n.props.onPress)[0].props.onPress(); });
    expect(m.address()).toEqual({ text: 'dapp.example', loading: false, lock: true });
    expect(m.calls('stopLoading')).toHaveLength(1);
    await m.tap('https://game.example/');
    await act(async () => { m.tree.root.findAll((n) => n.props.accessibilityLabel === 'browser_back' && n.props.onPress)[0].props.onPress(); });
    expect(m.address()).toMatchObject({ text: 'dapp.example', loading: false });
    expect(m.calls('goBack')).toHaveLength(1);
    await m.unmount();
  });

  it('the bookmark shows its address at once in a new tab', async () => {
    const m = await mount();
    await act(async () => { m.tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && n.props.onPress).props.onPress(); });
    expect(m.web().props.source).toEqual({ uri: 'https://aiqnet.io/explorer' });
    expect(m.address()).toEqual({ text: 'aiqnet.io', loading: true, lock: false });
    await m.unmount();
  });

  it('a page opened again loads: the one the tab was given (its WebView moved on), and the one on screen', async () => {
    const m = await mount();
    await m.open('dapp.example/one');
    await m.nav(`${SITE}/one`);
    await m.tap(`${SITE}/two`);
    await m.nav(`${SITE}/two`);
    await m.home();
    const given = m.web().props.source;
    await m.open('dapp.example/one');
    expect(m.web().props.source).toEqual({ uri: `${SITE}/one`, method: 'GET' });
    expect(m.web().props.source).not.toEqual(given);
    expect(m.address()).toEqual({ text: 'dapp.example', loading: true, lock: false });
    expect(m.calls('reload')).toHaveLength(0);
    await m.nav(`${SITE}/one`);
    // The page on screen, opened again (typed, or from the recent pages): a WebView never loads its own page again
    // from its source, so it is reloaded.
    await m.home();
    await m.open('dapp.example/one');
    expect(m.calls('reload')).toHaveLength(1);
    expect(m.address()).toMatchObject({ text: 'dapp.example', loading: true });
    await m.unmount();
  });
});

// Android: the UI thread waits at most 250 ms for JS's answer; a main-frame navigation not decided by then is refused
// natively and asked again without a lock, and the library's own JS loads it once the policy allows it.
describe('Android: a navigation JS answers late is loaded once the policy allows it', () => {
  const client = () => lib(`${ANDROID}RNCWebViewClient.java`);
  const method = (src, sig) => {
    const at = src.indexOf(sig);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf('\n    }\n', at));
  };

  it('the undecided main-frame navigation is refused and asked of JS again, without a lock; a subframe is allowed', () => {
    const ask = method(client(), 'private boolean askJsShouldOverride(WebView view, String url, boolean isMainFrame) {');
    // The locked event says which frame it is for (without it JS judged a subframe as the top frame).
    expect(ask).toMatch(/event\.putDouble\("lockIdentifier", lockIdentifier\);\s*event\.putBoolean\("isTopFrame", isMainFrame\);\s*rncWebView\.dispatchDirectShouldStartLoadWithRequest\(event\);/);
    const timeout = ask.slice(ask.indexOf('SHOULD_OVERRIDE_URL_LOADING_TIMEOUT) {'));
    expect(timeout).toMatch(/^[^]*?removeLock\(lockIdentifier\);\s*if \(isMainFrame\) askJsToLoad\(view, url\);\s*return isMainFrame;/);
    const interrupted = ask.slice(ask.indexOf('catch (InterruptedException e) {'));
    expect(interrupted).toMatch(/^[^]*?removeLock\(lockIdentifier\);\s*if \(isMainFrame\) askJsToLoad\(view, url\);\s*return isMainFrame;/);
    const again = method(client(), 'private void askJsToLoad(WebView view, String url) {');
    expect(again).toContain('dispatchEvent(new TopShouldStartLoadWithRequestEvent(reactTag, event));');
    expect(again).not.toContain('lockIdentifier');
    // The event class names the top frame for every event it carries.
    expect(lib(`${ANDROID}events/TopShouldStartLoadWithRequestEvent.kt`)).toContain('mData.putBoolean("isTopFrame", true)');
  });

  it('the library\'s JS loads a navigation asked without a lock once the policy allows it; a refusal loads nothing', async () => {
    // The Android wrapper Metro bundles (package.json "react-native": src/index.ts), and its build.
    expect(lib('src/WebView.android.tsx')).toMatch(/if \(lockIdentifier\) \{\s*RNCWebViewModule\.shouldStartLoadWithLockIdentifier\(shouldStart, lockIdentifier\);\s*\} else if \(shouldStart && webViewRef\.current\) \{\s*Commands\.loadUrl\(webViewRef\.current, url\);/);
    expect(JSON.parse(lib('package.json'))['react-native']).toBe('src/index.ts');
    const m = await mount();
    await m.open('dapp.example/one');
    await m.nav(`${SITE}/one`);
    const { createOnShouldStartLoadWithRequest } = jest.requireActual('react-native-webview/lib/WebViewShared');
    const loads = [];
    const handler = createOnShouldStartLoadWithRequest((ok, url, lock) => loads.push([ok, url, lock]), m.web().props.originWhitelist,
      (e) => m.web().props.onShouldStartLoadWithRequest(e));
    // The late answer to the lock (dropped natively) and the question asked again: one address, one load.
    await act(async () => { handler({ nativeEvent: { url: 'https://game.example/', isTopFrame: true, lockIdentifier: 7 } }); });
    await act(async () => { handler({ nativeEvent: { url: 'https://game.example/', isTopFrame: true } }); });
    expect(loads).toEqual([[true, 'https://game.example/', 7], [true, 'https://game.example/', undefined]]);
    expect(m.address()).toEqual({ text: 'game.example', loading: true, lock: false });
    await act(async () => { handler({ nativeEvent: { url: 'https://exa mple.com/', isTopFrame: true } }); });
    expect(loads[2]).toEqual([false, 'https://exa mple.com/', undefined]);
    await m.unmount();
  });

  it('the patch file carries it, and the installed client is exactly what the patch makes of the library\'s file', () => {
    const { parsePatchFile } = require('patch-package/dist/patch/parse');
    const patch = read(PATCH);
    expect(patch).not.toMatch(/\r/);
    const part = parsePatchFile(patch).find((p) => p.type === 'patch' && p.path.endsWith(`${ANDROID}RNCWebViewClient.java`));
    expect(part).toBeTruthy();
    for (const line of [
      '+            event.putBoolean("isTopFrame", isMainFrame);',
      '+                            if (isMainFrame) askJsToLoad(view, url);',
      '+                if (isMainFrame) askJsToLoad(view, url);',
      '+    private void askJsToLoad(WebView view, String url) {',
    ]) {
      expect([line, patch.includes(line)]).toEqual([line, true]);
    }
    // Every hunk's new side stands at its line in the installed file, and the lines between hunks are the library's
    // own: taking the hunks back out gives a file of the old side's length, and putting them in again gives the installed
    // file line for line.
    const installed = client().split('\n');
    let pristine = [];
    let at = 0;
    for (const h of part.hunks) {
      const newStart = h.header.patched.start - 1;
      const ctx = h.parts.filter((p) => p.type !== 'deletion').flatMap((p) => p.lines);
      const old = h.parts.filter((p) => p.type !== 'insertion').flatMap((p) => p.lines);
      expect([h.header.patched.start, installed.slice(newStart, newStart + ctx.length)]).toEqual([h.header.patched.start, ctx]);
      pristine = pristine.concat(installed.slice(at, newStart), old);
      at = newStart + ctx.length;
      expect(pristine.length - old.length + 1).toBe(h.header.original.start);
    }
    pristine = pristine.concat(installed.slice(at));
    let rebuilt = [];
    let from = 0;
    for (const h of part.hunks) {
      const oldStart = h.header.original.start - 1;
      rebuilt = rebuilt.concat(pristine.slice(from, oldStart), h.parts.filter((p) => p.type !== 'deletion').flatMap((p) => p.lines));
      from = oldStart + h.header.original.length;
    }
    expect(rebuilt.concat(pristine.slice(from))).toEqual(installed);
  });
});

// "No new windows": a link that asks for a new window (target=_blank) opens in its own tab, on both platforms.
it('a link that asks for a new window opens in the tab it was tapped in', async () => {
  const m = await mount();
  await m.open('dapp.example/one');
  const props = m.web().props;
  expect(props.setSupportMultipleWindows).toBe(false); // Android: the WebView loads it in place
  expect(props.onOpenWindow).toBeUndefined();
  // iOS: without an onOpenWindow handler the library loads the new window's request in the same web view.
  expect(lib('src/WebView.ios.tsx')).toContain('hasOnOpenWindowEvent={onOpenWindowProp !== undefined}');
  expect(lib('apple/RNCWebView.mm')).toMatch(/if \(newViewProps\.hasOnOpenWindowEvent\) \{\s*_view\.onOpenWindow = /);
  const impl = lib('apple/RNCWebViewImpl.m');
  const create = impl.slice(impl.indexOf('createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration'));
  expect(create.slice(0, 700)).toMatch(/if \(_onOpenWindow\) \{[\s\S]*?\} else \{\s*\[webView loadRequest:navigationAction\.request\];/);
  await m.unmount();
});

// The layout's direction follows the app's language as a whole (React Native's I18nManager, i18n/direction): right to
// left for Arabic, left to right for every other language, stored for the next start of the app's JS and turned by one
// restart at launch; the screens are written in start/end terms only, so nothing is turned twice.
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { I18nManager, StyleSheet, Text, View } from 'react-native';

jest.mock('../src/services/DeviceSecurity', () => ({ reloadApp: jest.fn(async () => true) }));
// The app's root waits for the window's insets, which the library's own mock gives at once.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('../src/screens/WalletScreen', () => {
  const { createElement } = require('react');
  const { Text: MockText } = require('react-native');
  return () => createElement(MockText, null, 'wallet screen');
});

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { reloadApp } = require('../src/services/DeviceSecurity');
const { applyLayoutDirection, layoutLags, settleLayoutDirection } = require('../src/i18n/direction');
const { LANGUAGES } = require('../src/i18n');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
// Promise turns only, for a test on fake timers.
const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };
// The running layout's direction, as the native side reported it when the JS started.
const runningRtl = (rtl, fn) => async () => {
  const was = I18nManager.isRTL;
  I18nManager.isRTL = rtl;
  try { await fn(); } finally { I18nManager.isRTL = was; }
};

let allow;
let force;
beforeEach(async () => {
  await AsyncStorage.clear();
  reloadApp.mockClear();
  reloadApp.mockImplementation(async () => true);
  allow = jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => {});
  force = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => {});
});
afterEach(() => { allow.mockRestore(); force.mockRestore(); });

describe('the direction of each language', () => {
  it('Arabic forces right to left; every other language turns it off, never on', () => {
    expect(LANGUAGES).toHaveLength(11);
    for (const { code } of LANGUAGES) {
      allow.mockClear();
      force.mockClear();
      applyLayoutDirection(code);
      const rtl = code === 'ar';
      expect([code, force.mock.calls]).toEqual([code, [[rtl]]]);
      expect([code, allow.mock.calls]).toEqual([code, [[rtl]]]);
    }
  });

  it('answers whether the running layout already has it', runningRtl(false, () => {
    expect(applyLayoutDirection('en')).toBe(true);
    expect(applyLayoutDirection('ar')).toBe(false);
    expect(layoutLags('ar')).toBe(true);
    expect(layoutLags('ru')).toBe(false);
  }));
});

describe('at launch', () => {
  it('a layout that already has the saved language\'s direction is drawn at once, no restart', runningRtl(true, async () => {
    await AsyncStorage.multiSet([['qnet_language', 'ar'], ['qnet_layout_restart', 'rtl']]);
    expect(await settleLayoutDirection()).toBe(true);
    expect(reloadApp).not.toHaveBeenCalled();
    expect(force).toHaveBeenLastCalledWith(true);
    await flush(1);
    expect(await AsyncStorage.getItem('qnet_layout_restart')).toBeNull();
  }));

  it('the other direction restarts once; a launch that still finds it so draws without a second', runningRtl(false, async () => {
    await AsyncStorage.setItem('qnet_language', 'ar');
    expect(await settleLayoutDirection()).toBe(false);
    expect(reloadApp).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('qnet_layout_restart')).toBe('rtl');
    // The restart did not turn it (a build without right-to-left support): no loop.
    expect(await settleLayoutDirection()).toBe(true);
    expect(reloadApp).toHaveBeenCalledTimes(1);
  }));

  it('a phone laid out right to left with the app in English restarts into left to right', runningRtl(true, async () => {
    await AsyncStorage.setItem('qnet_language', 'en');
    expect(await settleLayoutDirection()).toBe(false);
    expect(force).toHaveBeenLastCalledWith(false);
    expect(allow).toHaveBeenLastCalledWith(false);
    expect(reloadApp).toHaveBeenCalledTimes(1);
  }));

  it('without the native restart the screen is drawn in the running layout, and the next launch tries again', runningRtl(false, async () => {
    reloadApp.mockImplementation(async () => false);
    await AsyncStorage.setItem('qnet_language', 'ar');
    expect(await settleLayoutDirection()).toBe(true);
    await flush(1);
    expect(await AsyncStorage.getItem('qnet_layout_restart')).toBeNull();
    reloadApp.mockImplementation(async () => true);
    expect(await settleLayoutDirection()).toBe(false);
    expect(reloadApp).toHaveBeenCalledTimes(2);
  }));

  it('the wallet screen starts only once the direction is settled', runningRtl(false, async () => {
    jest.useFakeTimers();
    try {
      const App = require('../App').default;
      const shown = (tree) => tree.root.findAllByType(Text).some((n) => n.props.children === 'wallet screen');
      await AsyncStorage.setItem('qnet_language', 'en');
      let tree;
      await act(async () => { tree = renderer.create(<App />); });
      await settle();
      expect(shown(tree)).toBe(true);
      await act(async () => { tree.unmount(); });
      // Arabic on a left-to-right layout: the restart is under way, nothing of the wallet starts under it.
      await AsyncStorage.removeItem('qnet_layout_restart');
      await AsyncStorage.setItem('qnet_language', 'ar');
      await act(async () => { tree = renderer.create(<App />); });
      await settle();
      expect(reloadApp).toHaveBeenCalledTimes(1);
      expect(shown(tree)).toBe(false);
      // A restart that never replaces the JS leaves no blank screen.
      await act(async () => { jest.advanceTimersByTime(4000); });
      expect(shown(tree)).toBe(true);
      await act(async () => { tree.unmount(); });
    } finally {
      jest.useRealTimers();
    }
  }));
});

// The platforms align a text by its own script, so a line of Latin letters or digits stretched across the screen keeps to
// the left in Arabic: such lines take their own width at the start edge instead.
describe('a Latin line starts at the start edge in either direction', () => {
  it('the header\'s name, the figures, the screens\' names and the rows\' titles, notes and values', () => {
    const walletStyles = require('../src/screens/WalletScreen.styles').default;
    const { infoStyles } = require('../src/components/InfoRow');
    const { headStyles } = require('../src/components/ui/Head');
    const flat = (st) => StyleSheet.flatten(st) || {};
    expect(flat(walletStyles.wordmark)).toMatchObject({ marginEnd: 'auto' });
    expect(flat(walletStyles.wordmark).flex).toBeUndefined();
    for (const st of [walletStyles.display, walletStyles.txResultAmount, walletStyles.txDetailAmount, walletStyles.nodeFigure,
      infoStyles.fieldValue, headStyles.title]) {
      expect(flat(st).alignSelf).toBe('flex-start');
    }
    for (const st of [infoStyles.linkText, infoStyles.settingText, walletStyles.mgrRowInfo]) expect(flat(st).alignItems).toBe('flex-start');
  });
});

describe('the components that move along a line', () => {
  it('the switch\'s knob slides toward the end edge: leftwards right to left', runningRtl(true, async () => {
    const { Toggle } = require('../src/components/ui/Toggle');
    let tree;
    await act(async () => { tree = renderer.create(<Toggle value onValueChange={() => {}} />); });
    const knob = tree.root.findAll((n) => n.type === View && Array.isArray((StyleSheet.flatten(n.props.style) || {}).transform))[0];
    expect(StyleSheet.flatten(knob.props.style).transform[0].translateX).toBe(-18);
    await act(async () => { tree.unmount(); });
  }));
});

// Every stylesheet of the screens, components and the browser is direction-sensitive: what follows the reading direction
// is written start/end (paddingStart, marginEnd, borderStartWidth, start/end positions, flex alignment), so the layout
// mirrors as a whole. A left and a right both set alike (a full-bleed overlay, a symmetric reach) are direction-free.
describe('no left or right in the screens', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return /locales|overlays/.test(e.name) ? [] : files(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
  const STYLED = [...files(SRC), path.join(SRC, '..', 'App.tsx')]
    .filter((f) => /themed\(|StyleSheet\.create\(|style=\{/.test(fs.readFileSync(f, 'utf8')));
  const rel = (f) => path.relative(path.join(SRC, '..'), f).split(path.sep).join('/');

  it('covers the screens', () => {
    for (const f of ['src/screens/WalletScreen.styles.js', 'src/components/InfoRow.js', 'src/browser/BrowserScreen.js',
      'src/browser/DappSheet.js', 'src/components/SendReview.js', 'src/components/ui/Menu.js', 'src/components/ErrorBoundary.js']) {
      expect(STYLED.map(rel)).toContain(f);
    }
  });

  // A line that names a physical side, aligns text left or right, or turns the direction right to left. A position
  // (`left:` / `right:`) is looked for in style code only: a stylesheet, or a line that passes a style.
  const sideIssue = (line, styleCode = true) => {
    if (/\b(margin|padding)(Left|Right)\s*:/.test(line)) return true;
    if (/\bborder(Left|Right)\w*\s*:|\bborder(Top|Bottom)(Left|Right)Radius\s*:/.test(line)) return true;
    if (/textAlign:\s*['"](left|right)['"]/.test(line)) return true;
    if (/direction:\s*['"]rtl['"]|['"]row-reverse['"]|\bdirStyle\b/.test(line)) return true;
    if (!styleCode) return false;
    const sides = Object.fromEntries([...line.matchAll(/\b(left|right):\s*([^,}\s]+)/g)].map((m) => [m[1], m[2]]));
    return ('left' in sides || 'right' in sides) && sides.left !== sides.right;
  };

  it('no style names a physical side, aligns text left or right, or sets the direction right to left', () => {
    const found = [];
    for (const f of STYLED) {
      const lines = code(fs.readFileSync(f, 'utf8'));
      // A style module is style code throughout; elsewhere the stylesheet at the file's end.
      const sheetAt = /(\.styles|theme)\.js$/.test(f) ? 0 : lines.findIndex((l) => /themed\(|StyleSheet\.create\(/.test(l));
      lines.forEach((line, i) => {
        const styleCode = (sheetAt >= 0 && i >= sheetAt) || /style=\{|Style\s*=|hitSlop/.test(line);
        if (sideIssue(line, styleCode)) found.push(`${rel(f)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('the scan finds each kind it looks for', () => {
    const probe = ['  a: { marginLeft: 4 },', "  b: { textAlign: 'right' },", '  c: { left: 8 },', '  d: { borderRightWidth: 1 },',
      "  e: { direction: 'rtl' },", '  f: { top: 0, left: 0, right: 0, bottom: 0 },', '  g: { paddingStart: 4, end: 0 },'];
    expect(probe.filter(sideIssue).map((l) => l.trim()[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

/**
 * The live field as the platform's own view draws it (QNetHexField): the vectors written from components/ui/HexField.js
 * that the Android port replays bit for bit, the iOS port held to the module line for line, what the module hands that
 * view (an edit of the module, run again, registers it no second time), and the views' own rules (a view's clock runs
 * only while the field is live and on screen, and it draws again only when a cell changed).
 */
import { transformSync } from '@babel/core';
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, AppState, Dimensions, I18nManager, StyleSheet, Text, UIManager } from 'react-native';
import { color, glow } from '../src/theme';

// The app registers its own view: HexFieldView.js asks once, as HexField.js loads it, so the answer is set before.
const asked = UIManager.hasViewManagerConfig.getMockImplementation();
UIManager.hasViewManagerConfig.mockImplementation((name) => name === 'QNetHexField' || asked(name));
const {
  default: HexField, CELL, COLUMNS, GLYPHS, MIN_TRAIL, MAX_TRAIL, TICK_MS, HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S,
  MAX_CATCH_UP, FADE_FROM, PLAN, hash, glyphAt, another, brightness, columns, advance, shade, clockZero, clockAt,
} = require('../src/components/ui/HexField');
const { NATIVE_VIEW } = require('../src/components/ui/HexFieldView');

const APP = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures', 'hex_field_vectors.json');
const ANDROID = 'android/app/src/main/java/com/qnetmobile/';
const IOS = 'ios/QNetMobile/';
// The native ports of the module's steps.
const PORTS = [`${ANDROID}HexRain.kt`, `${IOS}HexRain.swift`];
// The field heights the vectors hold: a small phone's half window, and a 1366 pt tablet's.
const HEIGHTS = [16, 34];
const TICKS = 400;
const TONE = { [color.paper]: 'paper', [color.signalPale]: 'signalPale', [color.signal]: 'signal' };

// The clock sequences a port replays, each a list of [event, frame time in ms].
const frames = (n, at) => Array.from({ length: n }, (_, j) => ['frame', at(j + 1)]);
const CLOCKS = [
  // 60 frames a second.
  [['start', 1000], ...frames(120, (n) => 1000 + (n * 1000) / 60)],
  // 120 a second, a quarter of a millisecond early or late, at an uptime of 5e7 ms.
  [['start', 5e7], ...frames(240, (n) => 5e7 + (n * 1000) / 120 + (hash(n, 1) - 0.5) / 2)],
  // An hour's stall, then a clock set an hour back.
  [['start', 0], ...frames(3, (n) => 33 * n), ['frame', 3600099], ['frame', 3600132], ['frame', 132], ['frame', 165],
    ['frame', 198]],
  // Stopped after ten frames and started again much later.
  [['start', 500], ...frames(10, (n) => 500 + 33 * n), ['start', 90000], ...frames(3, (n) => 90000 + 33 * n)],
];

// Each event's [tick, zero] after it, as the module's clock takes them.
function replayClock(events) {
  let tick = 0;
  let zero = 0;
  const after = events.map(([kind, at]) => {
    if (kind === 'start') {
      zero = clockZero(tick, at);
    } else {
      const next = clockAt(tick, zero, at);
      tick = next.to;
      zero = next.zero;
    }
    return [tick, zero];
  });
  return { events, after };
}

// The ticks 1..TICKS of a field `rows` high: each column's head and glyphs, and which columns changed (a bitmask).
function replayField(rows) {
  let cols = columns(rows);
  return Array.from({ length: TICKS }, (_, n) => {
    const next = cols.map((c) => advance(c, n + 1));
    const changed = next.reduce((m, c, i) => (c === cols[i] ? m : m | (1 << i)), 0);
    cols = next;
    return { head: cols.map((c) => c.head), glyphs: cols.map((c) => c.glyphs.join('')), changed };
  });
}

function vectors() {
  const draws = [];
  for (let n = 0; n < GLYPHS.length; n += 1) draws.push(n / GLYPHS.length, (n + 1) / GLYPHS.length - 2 ** -40);
  draws.push(1 - 2 ** -32);
  const others = [];
  for (let n = 0; n < GLYPHS.length; n += 1) {
    // The glyph it would draw is the one it replaces (so it passes over it, from the last glyph to the first), then
    // one it is not.
    const r = (n + 0.5) / GLYPHS.length;
    for (const was of [GLYPHS[n], GLYPHS[(n + 1) % GLYPHS.length]]) others.push([was, r, another(was, r)]);
  }
  const bright = [];
  for (let len = MIN_TRAIL; len <= MAX_TRAIL; len += 1) {
    for (let k = 0; k < len; k += 1) bright.push([len, k, brightness(k, len)]);
  }
  const fields = HEIGHTS.map((rows) => {
    const plan = columns(rows);
    const after = replayField(rows);
    const shades = plan.flatMap((c) => [
      c.from, -1, 0, 1, Math.round(0.4 * rows) - 1, Math.floor(0.7 * rows), c.to - 1, c.to,
      ...[100, 200, 300].map((t) => after[t - 1].head[c.i]),
    ].map((head) => ({
      column: c.i, head, cells: Array.from({ length: c.len }, (_, k) => {
        const { tone, opacity } = shade({ ...c, head }, k);
        return [TONE[tone], opacity];
      }),
    })));
    return { rows, columns: plan.map((c) => ({ ...c, glyphs: c.glyphs.join('') })), after, shade: shades };
  });
  const A = [0, 1, 9, 256, 265, 521, 1033, 2147483647];
  // Past int32 too: the module's hash takes its operands as int32, as a port's own integers are cut.
  const B = [0, 1, 400, PLAN, PLAN + 23, 2147483647, 2147483648, 4294967303, Number.MAX_SAFE_INTEGER];
  return {
    constants: {
      GLYPHS, COLUMNS, MIN_TRAIL, MAX_TRAIL, TICK_MS, HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S, MAX_CATCH_UP, FADE_FROM,
      PLAN,
    },
    hash: A.flatMap((a) => B.map((b) => [a, b, hash(a, b)])),
    glyphAt: draws.map((r) => [r, glyphAt(r)]),
    another: others,
    brightness: bright,
    fields,
    clock: CLOCKS.map(replayClock),
  };
}

// One record a line, so that a change reads as the lines it changed.
function write(v) {
  const lines = (list) => `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]`;
  const field = (f) => [
    `{"rows":${f.rows}`, `"columns":${lines(f.columns)}`, `"after":${lines(f.after)}`, `"shade":${lines(f.shade)}}`,
  ].join(',\n');
  return [
    `{"constants":${JSON.stringify(v.constants)}`, `"hash":${lines(v.hash)}`, `"glyphAt":${lines(v.glyphAt)}`,
    `"another":${lines(v.another)}`, `"brightness":${lines(v.brightness)}`,
    `"fields":[\n${v.fields.map(field).join(',\n')}\n]`, `"clock":${lines(v.clock)}\n}\n`,
  ].join(',\n');
}

describe('the vectors the ports replay', () => {
  const want = vectors();

  it('are what HexField.js computes now (QNET_WRITE_VECTORS=1 writes them)', () => {
    if (process.env.QNET_WRITE_VECTORS === '1') fs.writeFileSync(FIXTURE, write(want));
    const text = fs.readFileSync(FIXTURE, 'utf8');
    expect(text.includes('\r')).toBe(false);
    expect(JSON.parse(text)).toEqual(want);
  });

  it('reach every path: every column of both heights steps, starts a new pass, flickers, swaps and rests; another() passes over the glyph it replaces and wraps from the last glyph to the first; shades hold whole, fading and gone cells', () => {
    for (const f of want.fields) {
      const seen = Array.from({ length: COLUMNS }, () => ({ step: 0, pass: 0, flicker: 0, swap: 0, rest: 0 }));
      let cols = columns(f.rows);
      for (let t = 1; t <= TICKS; t += 1) {
        cols = cols.map((c, i) => {
          const n = advance(c, t);
          const step = (t + c.phase) % c.every === 0;
          const kept = step ? c.glyphs.slice(0, -1) : c.glyphs.slice(1);
          seen[i].step += step ? 1 : 0;
          seen[i].pass += step && c.head >= c.to ? 1 : 0;
          seen[i].flicker += !step && n.glyphs[0] !== c.glyphs[0] ? 1 : 0;
          seen[i].swap += kept.some((g, k) => n.glyphs[k + 1] !== g) ? 1 : 0;
          seen[i].rest += n === c ? 1 : 0;
          return n;
        });
      }
      for (const [i, s] of seen.entries()) {
        expect([f.rows, i, Object.values(s).every((x) => x > 0)]).toEqual([f.rows, i, true]);
      }
    }
    const last = GLYPHS.length - 1;
    expect(want.another.filter(([was, r, g]) => was === glyphAt(r) && g !== was).length).toBe(GLYPHS.length);
    expect(want.another.find(([was, r]) => was === GLYPHS[last] && glyphAt(r) === was)[2]).toBe(GLYPHS[0]);
    expect(want.another.filter(([was, r, g]) => was !== glyphAt(r) && g === glyphAt(r)).length).toBe(GLYPHS.length);
    // The head's cell whole (the head high in the field), fading, and gone at the field's end.
    for (const f of want.fields) {
      const kinds = f.shade.map(({ column, cells: [[, o]] }) => {
        const whole = Math.round(Math.min(1, 1.4 * f.columns[column].a) * 100) / 100;
        return o === whole ? 'whole' : o === 0 ? 'gone' : 'fading';
      });
      expect([...new Set(kinds)].sort()).toEqual(['fading', 'gone', 'whole']);
    }
  });

  it('the clock takes the ticks due, MAX_CATCH_UP at most past where it stood, never steps back, and a restart goes on from where it stood', () => {
    const [even, jitter, stall, restart] = want.clock;
    // Frames shorter than a tick: tick 0 never moves and every frame takes the ticks due.
    for (const c of [even, jitter]) {
      const [, start] = c.events[0];
      c.events.forEach(([, at], j) => expect(c.after[j]).toEqual([Math.floor((at - start) / TICK_MS), start]));
    }
    // 3 ticks, an hour's stall that takes MAX_CATCH_UP and goes on from there, an hour back that takes none: tick 0
    // set again at both, and kept between.
    const ticks = stall.after.map(([t]) => t);
    const M = MAX_CATCH_UP;
    expect(ticks).toEqual([0, 1, 2, 3, 3 + M, 4 + M, 4 + M, 5 + M, 6 + M]);
    const zeros = stall.after.map(([, z]) => z);
    expect(zeros.slice(1).map((z, j) => z !== zeros[j])).toEqual([false, false, false, true, false, true, false, false]);
    // A start much later goes on from the tick the field stood at.
    expect(restart.after.slice(10).map(([t]) => t)).toEqual([10, 10, 11, 12, 13]);
  });

  // A power or a transcendental function is rounded as each runtime's library chooses; a product, a quotient and a
  // square root are rounded alike everywhere.
  it('the reference and the ports use only correctly rounded arithmetic', () => {
    const fns = 'exp|expm1|log|log1p|log2|log10|ln|ln1p|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|cbrt|hypot';
    const code = read('src/components/ui/HexField.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(new RegExp(`\\*\\*|Math\\.(pow|${fns})\\b`));
    expect(code).toMatch(/return x \* Math\.sqrt\(Math\.sqrt\(x\)\);/);
    for (const port of PORTS) {
      expect([port, new RegExp(`\\bpow\\b|\\b(${fns})\\s*\\(`).test(read(port))]).toEqual([port, false]);
    }
  });
});

describe('drawn by the platform\'s own view', () => {
  const ROWS = 20;
  const WINDOW = { width: 360, height: 2 * (ROWS * CELL + 7), scale: 2, fontScale: 1 };
  const flat = (st) => StyleSheet.flatten(st) || {};
  let shown;
  let raf;
  const mounted = [];
  const fieldOf = (tree) => tree.root.find((n) => n.props.testID === 'hex-field' && typeof n.type === 'string');
  // The one native view, and the instance React keeps for it (a new one is a new view).
  const viewOf = (tree) => {
    const views = fieldOf(tree).findAll((n) => n.type === NATIVE_VIEW);
    expect(views).toHaveLength(1);
    return views[0];
  };
  const tagOf = (tree) => viewOf(tree).parent.instance._nativeTag;
  const layout = async (tree, height) => {
    await act(async () => { fieldOf(tree).props.onLayout({ nativeEvent: { layout: { width: WINDOW.width, height } } }); });
  };
  const laidOut = async (el) => {
    let tree;
    await act(async () => { tree = renderer.create(el); });
    mounted.push(tree);
    await layout(tree, WINDOW.height / 2);
    return tree;
  };
  const listener = (mock, type) => mock.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn).pop();
  beforeAll(() => {
    shown = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    Dimensions.set({ window: WINDOW, screen: WINDOW });
  });
  afterAll(() => { Dimensions.set(shown); });
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    raf = jest.spyOn(global, 'requestAnimationFrame');
  });
  afterEach(() => {
    mounted.splice(0).forEach((tree) => act(() => { tree.unmount(); }));
    raf.mockRestore();
    jest.useRealTimers();
  });

  it('one QNetHexField fills the field\'s box with the cell\'s face and size, the three tones and the theme\'s glow; no glyph node, no JS clock', async () => {
    const tree = await laidOut(<HexField />);
    const { style, children, ...props } = viewOf(tree).props;
    expect([flat(style), children]).toEqual([{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, undefined]);
    // The theme's colours as they are (the view's config turns a colour prop into the platform's own once).
    expect(props).toEqual({
      rows: ROWS, live: true, rtl: false, paper: color.paper, signalPale: color.signalPale, signal: color.signal,
      glowColor: glow.textShadowColor, glowRadius: glow.textShadowRadius, cellSize: CELL, glyphSize: 14,
      fontName: 'MartianMono-Data',
    });
    // Opaque: the view gives a cell's opacity to its glyph and to the head's glow, as a Text's opacity does.
    for (const c of [color.paper, color.signalPale, color.signal, glow.textShadowColor]) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(flat(fieldOf(tree).props.style))
      .toMatchObject({ position: 'absolute', top: 0, height: WINDOW.height / 2, overflow: 'hidden' });
    expect(fieldOf(tree).findAll((n) => n.type === Text)).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(30 * TICK_MS); });
    expect([jest.getTimerCount(), raf.mock.calls.length]).toEqual([0, 0]);
  });

  it('live follows the app and the reduce-motion setting on the same view', async () => {
    const tree = await laidOut(<HexField />);
    const tag = tagOf(tree);
    const live = () => viewOf(tree).props.live;
    const change = listener(AppState.addEventListener, 'change');
    const reduce = listener(AccessibilityInfo.addEventListener, 'reduceMotionChanged');
    const seen = [live()];
    for (const state of ['background', 'active', 'inactive', 'active']) {
      await act(async () => { change(state); });
      seen.push(live());
    }
    await act(async () => { reduce(true); });
    seen.push(live());
    await act(async () => { reduce(false); });
    seen.push(live());
    expect(seen).toEqual([true, false, true, false, true, false, true]);
    expect(tagOf(tree)).toBe(tag);
  });

  it('a new window plans the field in a new view; the keyboard changes nothing', async () => {
    const tree = await laidOut(<HexField />);
    const tag = tagOf(tree);
    // The keyboard lays the room out again, a third shorter.
    await layout(tree, WINDOW.height / 3);
    expect([viewOf(tree).props.rows, tagOf(tree)]).toEqual([ROWS, tag]);
    const turned = { ...WINDOW, height: WINDOW.height + 4 * CELL };
    try {
      await act(async () => { Dimensions.set({ window: turned, screen: turned }); });
      expect(viewOf(tree).props.rows).toBe(ROWS + 2);
      expect(tagOf(tree)).not.toBe(tag);
    } finally {
      await act(async () => { Dimensions.set({ window: WINDOW, screen: WINDOW }); });
    }
  });

  it('rtl follows the running layout direction', async () => {
    const was = I18nManager.isRTL;
    try {
      I18nManager.isRTL = true;
      const tree = await laidOut(<HexField />);
      expect(viewOf(tree).props.rtl).toBe(true);
      I18nManager.isRTL = false;
      await act(async () => { tree.update(<HexField />); });
      expect(viewOf(tree).props.rtl).toBe(false);
    } finally {
      I18nManager.isRTL = was;
    }
  });

  // A module's code run again over the modules it imports as they stand, as a hot update runs an edited module.
  const runAgain = (file) => {
    const abs = path.join(APP, file);
    const { code } = transformSync(fs.readFileSync(abs, 'utf8'), { filename: abs, cwd: APP });
    const mod = { exports: {} };
    const need = (spec) => require(spec.startsWith('.') ? path.join(path.dirname(abs), spec) : spec);
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', code)(need, mod, mod.exports);
    return mod.exports;
  };

  it('an edit of HexField.js, run again as a hot update runs it, asks for no view a second time and draws the one registered', async () => {
    // React Native refuses a second view of one name, which would stop the update.
    const asks = jest.spyOn(require('react-native'), 'requireNativeComponent', 'get');
    try {
      const { default: Edited } = runAgain('src/components/ui/HexField.js');
      const tree = await laidOut(<Edited />);
      expect(asks).not.toHaveBeenCalled();
      expect(viewOf(tree).props.rows).toBe(ROWS);
    } finally {
      asks.mockRestore();
    }
  });
});

describe('the native views', () => {
  const kt = read(`${ANDROID}HexField.kt`);
  const rain = read(`${ANDROID}HexRain.kt`);
  const swiftRain = read(`${IOS}HexRain.swift`);
  const swiftView = read(`${IOS}HexField.swift`);
  const bridge = read(`${IOS}QNetHexField.m`);
  // The props the module hands the view.
  const passed = () => {
    let tree;
    act(() => { tree = renderer.create(<HexField />); });
    act(() => { tree.root.find((n) => n.props.testID === 'hex-field').props.onLayout({ nativeEvent: { layout: {} } }); });
    const { style, children, ...props } = tree.root.find((n) => n.type === NATIVE_VIEW).props;
    act(() => { tree.unmount(); });
    return props;
  };

  it('Android: HexField.kt draws HexRain, the port HexRainTest.kt replays these vectors against', () => {
    expect(read('android/app/src/test/java/com/qnetmobile/HexRainTest.kt'))
      .toContain('File("../../__tests__/fixtures/hex_field_vectors.json")');
    // Gradle keeps a test's result while its inputs stand: new vectors run it again.
    expect(read('android/app/build.gradle'))
      .toContain('inputs.file("../../__tests__/fixtures/hex_field_vectors.json").withPropertyName("hexFieldVectors")');
    expect(NATIVE_VIEW).toBe('QNetHexField');
    expect(kt).toContain('override fun getName(): String = "QNetHexField"');
    expect(kt).toContain('ReactFontManager.getInstance().getTypeface(name, Typeface.NORMAL, view.context.assets)');
    expect(kt.match(/PixelUtil\.toPixelFromDIP\(dp\)/g)).toHaveLength(2);
    // The glow's radius in raw pixels, as Text gives a shadow's radius to its paint.
    expect(kt).toContain('lead.setShadowLayer(glowRadius, 0f, 0f, glowColor)');
    expect(kt).toMatch(/HexRain\.opacity\(c, k\)[\s\S]*canvas\.drawText\(c\.glyphs, k, 1, x, Math\.round\(row \* cellPx\) \+ baseline, p\)/);
    // HexRain's constants are the module's; its imports are kotlin.math only.
    const consts = Object.fromEntries([...rain.matchAll(/^ {4}const val (\w+) = (.+)$/gm)]
      .map(([, name, v]) => [name, v.startsWith('"') ? JSON.parse(v) : Number(v.replace(/L$/, ''))]));
    expect(consts).toEqual({
      GLYPHS, COLUMNS, MIN_TRAIL, MAX_TRAIL, TICK_MS, HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S, MAX_CATCH_UP, FADE_FROM, PLAN,
    });
    const js = read('src/components/ui/HexField.js');
    for (const rate of ['(HEAD_FLICKER_PER_S * TICK_MS) / 1000', '(TRAIL_SWAP_PER_CELL_S * TICK_MS) / 1000']) {
      expect([rate, js.includes(rate), rain.includes(rate)]).toEqual([rate, true, true]);
    }
    expect([...rain.matchAll(/^import (\S+)$/gm)].map(([, m]) => m)).toEqual(['kotlin.math.floor', 'kotlin.math.max', 'kotlin.math.min']);
  });

  it('both register QNetHexField with exactly the props HexField.js passes, colours as colours', () => {
    const props = passed();
    const tones = [color.paper, color.signalPale, color.signal, glow.textShadowColor];
    const names = Object.keys(props).sort();
    const colours = names.filter((k) => tones.includes(props[k]));
    expect(colours).toEqual(['glowColor', 'paper', 'signal', 'signalPale']);
    // Android: a @ReactProp each, the colours as Color, the view manager in the app's package.
    const declared = [...kt.matchAll(/@ReactProp\(name = "(\w+)"(, customType = "Color")?\)/g)];
    expect(declared.map(([, name]) => name).sort()).toEqual(names);
    expect(declared.filter(([, , c]) => c).map(([, name]) => name).sort()).toEqual(colours);
    expect(read(`${ANDROID}DilithiumPackage.kt`))
      .toMatch(/override fun createViewManagers\(reactContext: ReactApplicationContext\): List<ViewManager<\*, \*>> \{\s*return listOf\(HexFieldManager\(\)\)\s*\}/);
    // iOS: an exported view property each, the colours as UIColor, each one a property of the view in the type the
    // bridge converts its prop to; React Native names a view manager by its class without "Manager".
    const exported = [...bridge.matchAll(/^RCT_EXPORT_VIEW_PROPERTY\((\w+), (\w+)\)$/gm)].map(([, name, type]) => [name, type]);
    expect(exported.map(([name]) => name).sort()).toEqual(names);
    expect(exported.filter(([, type]) => type === 'UIColor').map(([name]) => name).sort()).toEqual(colours);
    const objc = { Int: 'NSInteger', Bool: 'BOOL', CGFloat: 'CGFloat', 'UIColor?': 'UIColor', 'String?': 'NSString' };
    expect([...swiftView.matchAll(/^ {2}@objc var (\w+): (\S+) /gm)].map(([, name, type]) => [name, objc[type]]).sort())
      .toEqual([...exported].sort());
    expect(bridge).toMatch(/#import <React\/RCTViewManager\.h>\s*@interface RCT_EXTERN_MODULE\(QNetHexFieldManager, RCTViewManager\)/);
    expect(`${NATIVE_VIEW}Manager`).toBe('QNetHexFieldManager');
    expect(swiftView).toMatch(/@objc\(QNetHexFieldManager\)\s*final class QNetHexFieldManager: RCTViewManager \{[\s\S]*override func view\(\) -> UIView! \{\s*return QNetHexFieldView\(\)\s*\}/);
    // Built into the app: each file's reference in the app's group, its build file in the Sources phase, on ids of its own.
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    const group = (pbx.match(/\/\* QNetMobile \*\/ = \{\s*isa = PBXGroup;[\s\S]*?\);/) || [''])[0];
    const sources = (pbx.match(/\/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;[\s\S]*?\);/) || [''])[0];
    for (const f of ['HexRain.swift', 'HexField.swift', 'QNetHexField.m']) {
      const file = f.replace('.', '\\.');
      const ref = (pbx.match(new RegExp(`(\\w{24}) /\\* ${file} \\*/ = \\{isa = PBXFileReference;[^}]*? path = QNetMobile/${file};`)) || [])[1];
      const built = (pbx.match(new RegExp(`(\\w{24}) /\\* ${file} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `)) || [])[1];
      expect([f, group.includes(`${ref} /* ${f} */,`), sources.includes(`${built} /* ${f} in Sources */,`),
        pbx.split(ref).length - 1, pbx.split(built).length - 1]).toEqual([f, true, true, 3, 2]);
    }
  });

  it('the Android view runs its clock only while live, shown and planned, anchors it on its first frame, and draws again only on a change', () => {
    expect(kt).toMatch(/override fun onVisibilityAggregated\(isVisible: Boolean\) \{\s*super\.onVisibilityAggregated\(isVisible\)\s*shown = isVisible\s*run\(\)\s*\}/);
    expect(kt).toMatch(/var live = false\s*set\(value\) \{\s*field = value\s*run\(\)\s*\}/);
    expect(kt).toContain('val want = live && shown && cols.isNotEmpty()');
    expect(kt).toMatch(/if \(want\) \{\s*anchor = true\s*Choreographer\.getInstance\(\)\.postFrameCallback\(this\)\s*\} else \{\s*Choreographer\.getInstance\(\)\.removeFrameCallback\(this\)\s*\}/);
    expect(kt).toMatch(/if \(anchor\) \{\s*clock\.start\(at\)\s*anchor = false\s*\} else \{\s*val from = clock\.tick\s*if \(HexRain\.advanceTo\(cols, from, clock\.frame\(at\)\)\) invalidate\(\)\s*\}/);
    expect(kt).toContain('val at = frameTimeNanos / 1_000_000.0');
    // No log and no timer of its own: the display's frames are its only clock.
    expect(kt).not.toMatch(/android\.util\.Log|Handler|postDelayed|Timer/);
  });

  // No runner here replays the vectors through Swift: HexRain.swift is held to the module line by line instead. Each
  // part's lines, HexField.js's and HexRain.swift's for it, whitespace aside and in the same order: Math.floor is
  // rounded(.down), Math.round (only ever of a value of at least 0) rounded(), Math.imul and >>> UInt32's &* and >>.
  const SWIFT_STEPS = {
    hash: [
      ['let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;',
        'var h = ((UInt32(truncatingIfNeeded: a) ^ 0x9e3779b9) &* 0x85ebca6b) ^ UInt32(truncatingIfNeeded: b)'],
      ['h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);', 'h = (h ^ (h >> 16)) &* 0x85ebca6b'],
      ['h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);', 'h = (h ^ (h >> 13)) &* 0xc2b2ae35'],
      ['return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;', 'return Double(h ^ (h >> 16)) / 4_294_967_296'],
    ],
    glyphs: [
      ['export const glyphAt = (r) => GLYPHS[Math.floor(r * GLYPHS.length)];',
        'return GLYPHS[Int((r * Double(GLYPHS.count)).rounded(.down))]'],
      ['let n = Math.floor(r * GLYPHS.length);', 'var n = Int((r * Double(GLYPHS.count)).rounded(.down))'],
      ['while (GLYPHS[n] === was) n = (n + 1) % GLYPHS.length;', 'while GLYPHS[n] == was { n = (n + 1) % GLYPHS.count }'],
      ['return GLYPHS[n];', 'return GLYPHS[n]'],
    ],
    columns: [
      ['const out = [];', 'var out: [Column] = []'],
      ['for (let i = 0; i < COLUMNS; i += 1) {', 'for i in 0..<COLUMNS {'],
      ['const draw = (n) => hash(i, PLAN + n);', 'func draw(_ n: Int) -> Double { return hash(i, PLAN + n) }'],
      ['const len = MIN_TRAIL + Math.floor(draw(0) * (MAX_TRAIL - MIN_TRAIL + 1));',
        'let len = MIN_TRAIL + Int((draw(0) * Double(MAX_TRAIL - MIN_TRAIL + 1)).rounded(.down))'],
      ['const every = 2 + Math.floor(draw(1) * 4);', 'let every = 2 + Int((draw(1) * 4).rounded(.down))'],
      ['const from = -1 - Math.floor(draw(2) * rows * 0.6);',
        'let from = -1 - Int((draw(2) * Double(rows) * 0.6).rounded(.down))'],
      ['const head = Math.max(from, Math.round(draw(3) * rows * 0.8) - 1);',
        'let head = max(from, Int((draw(3) * Double(rows) * 0.8).rounded()) - 1)'],
      ['const glyphs = Array.from({ length: len }, (_, k) => glyphAt(draw(10 + k)));',
        'let glyphs = (0..<len).map { k in glyphAt(draw(10 + k)) }'],
      ['const phase = Math.floor(draw(4) * every);', 'let phase = Int((draw(4) * Double(every)).rounded(.down))'],
      ['out.push({ i, len, every, phase, beat: draw(6), a: 0.45 + draw(5) * 0.55, from, to: rows - 1, head, glyphs });',
        'out.append(Column(i: i, len: len, every: every, phase: phase, beat: draw(6), a: 0.45 + draw(5) * 0.55, '
          + 'from: from, to: rows - 1, head: head, glyphs: glyphs))'],
      ['return out;', 'return out'],
    ],
    advance: [
      ['const roll = (n) => hash(c.i + (n << 8), t);', 'func roll(_ n: Int) -> Double { return hash(i + (n << 8), t) }'],
      ['const inSight = (row) => row >= 0 && row < c.to;', 'func inSight(_ row: Int) -> Bool { return row >= 0 && row < to }'],
      ['const beat = Math.floor(t * FLICKER + c.beat) > Math.floor((t - 1) * FLICKER + c.beat);',
        'let beat = Int((Double(t) * FLICKER + c.beat).rounded(.down)) > Int((Double(t - 1) * FLICKER + c.beat).rounded(.down))'],
      ['if ((t + c.phase) % c.every === 0) {', 'if (t + c.phase) % c.every == 0 {'],
      ['head = head >= c.to ? c.from : head + 1;', 'c.head = c.head >= c.to ? c.from : c.head + 1'],
      ['glyphs = [another(glyphs[0], roll(0)), ...glyphs.slice(0, -1)];',
        'let was = c.glyphs[0] var k = c.len - 1 while k > 0 { c.glyphs[k] = c.glyphs[k - 1] k -= 1 } '
          + 'c.glyphs[0] = another(was, roll(0)) changed = true'],
      ['} else if (beat && inSight(head)) {', '} else if beat && inSight(c.head) {'],
      ['glyphs = [another(glyphs[0], roll(1)), ...glyphs.slice(1)];', 'c.glyphs[0] = another(c.glyphs[0], roll(1)) changed = true'],
      ['const lit = inSight(head) ? Math.min(c.len - 1, head) : 0;', 'let lit = inSight(c.head) ? min(c.len - 1, c.head) : 0'],
      ['const swaps = Math.floor(lit * SWAP + roll(2));', 'let swaps = Int((Double(lit) * SWAP + roll(2)).rounded(.down))'],
      ['for (let j = 0; j < swaps; j += 1) {', 'var j = 0 while j < swaps {'],
      ['const k = 1 + Math.floor(roll(3 + 2 * j) * lit);', 'let k = 1 + Int((roll(3 + 2 * j) * Double(lit)).rounded(.down))'],
      ['glyphs[k] = another(glyphs[k], roll(4 + 2 * j));', 'c.glyphs[k] = another(c.glyphs[k], roll(4 + 2 * j)) changed = true j += 1'],
      ['return head === c.head && glyphs === c.glyphs ? c : { ...c, head, glyphs };', 'return changed'],
    ],
    advanceTo: [
      ['for (let t = from + 1; t <= to; t += 1) next = next.map((c) => advance(c, t));',
        'var t = from + 1 while t <= to { for n in cols.indices { if advance(&cols[n], t) { changed = true } } t += 1 }'],
      ['return next.some((c, i) => c !== cols[i]) ? next : cols;', 'return changed'],
    ],
    brightness: [
      ['if (k === 0) return 1.4;', 'if k == 0 { return 1.4 }'],
      ['if (k < 3) return 1.05;', 'if k < 3 { return 1.05 }'],
      ['const x = 1 - k / len;', 'let x = 1 - Double(k) / Double(len)'],
      ['return x * Math.sqrt(Math.sqrt(x));', 'return x * x.squareRoot().squareRoot()'],
    ],
    tone: [['const tone = k === 0 ? color.paper : k < 3 ? color.signalPale : color.signal;', 'return k == 0 ? 0 : k < 3 ? 1 : 2']],
    opacity: [
      ['const fade = Math.min(1, Math.max(0, (c.to - c.head) / ((1 - FADE_FROM) * (c.to + 1))));',
        'let fade = min(1, max(0, Double(c.to - c.head) / ((1 - FADE_FROM) * Double(c.to + 1))))'],
      ['return { tone, opacity: Math.round(Math.min(1, brightness(k, c.len) * c.a) * fade * 100) / 100 };',
        'return (min(1, brightness(k, c.len) * c.a) * fade * 100).rounded() / 100'],
    ],
    clock: [
      ['export const clockZero = (tick, at) => at - tick * TICK_MS;', 'zero = at - Double(tick) * TICK_MS'],
      ['const due = Math.floor((at - zero) / TICK_MS);', 'let due = Int(((at - zero) / TICK_MS).rounded(.down))'],
      ['const to = Math.min(Math.max(due, from), from + MAX_CATCH_UP);', 'let to = min(max(due, tick), tick + MAX_CATCH_UP)'],
      ['return { to, zero: to === due ? zero : at - to * TICK_MS };',
        'if to != due { zero = at - Double(to) * TICK_MS } tick = to return to'],
    ],
  };
  // Each part's members in HexRain.swift, and their Swift that ports no line of HexField.js, in order: declarations and
  // braces, the column fields the steps read, and the flag that a cell changed (HexField.js returns a new column).
  const SWIFT_MEMBERS = {
    hash: ['hash'], glyphs: ['glyphAt', 'another'], columns: ['columns'], advance: ['advance'], advanceTo: ['advanceTo'],
    brightness: ['brightness'], tone: ['tone'], opacity: ['opacity'], clock: ['Clock'],
  };
  const SWIFT_SCAFFOLD = {
    hash: ['static func hash(_ a: Int, _ b: Int) -> Double {', '}'],
    glyphs: ['static func glyphAt(_ r: Double) -> UInt16 {', '}', 'static func another(_ was: UInt16, _ r: Double) -> UInt16 {', '}'],
    columns: ['static func columns(_ rows: Int) -> [Column] {', '}', '}'],
    advance: ['static func advance(_ c: inout Column, _ t: Int) -> Bool {', 'let i = c.i', 'let to = c.to', 'var changed = false',
      '}', '}', '}'],
    advanceTo: ['static func advanceTo(_ cols: inout [Column], _ from: Int, _ to: Int) -> Bool {', 'var changed = false', '}'],
    brightness: ['static func brightness(_ k: Int, _ len: Int) -> Double {', '}'],
    tone: ['static func tone(_ k: Int) -> Int {', '}'],
    opacity: ['static func opacity(_ c: Column, _ k: Int) -> Double {', '}'],
    clock: ['struct Clock {', 'private(set) var tick = 0', 'private(set) var zero = 0.0', 'mutating func start(_ at: Double) {', '}',
      'mutating func frame(_ at: Double) -> Int {', '}', '}'],
  };

  it('iOS: HexRain.swift keeps HexField.js\'s constants and its steps line for line, with Foundation its only import', () => {
    const js = read('src/components/ui/HexField.js');
    const { GLYPHS: glyphs, FLICKER: flicker, SWAP: swap, ...numbers } = Object.fromEntries(
      [...swiftRain.matchAll(/^ {2}static let (\w+)(?:: \[UInt16\])? = (.+)$/gm)].map(([, name, v]) => [name, v]));
    expect(glyphs).toBe(`Array("${GLYPHS}".utf16)`);
    expect(Object.fromEntries(Object.entries(numbers).map(([name, v]) => [name, Number(v)]))).toEqual({
      COLUMNS, MIN_TRAIL, MAX_TRAIL, TICK_MS, HEAD_FLICKER_PER_S, TRAIL_SWAP_PER_CELL_S, MAX_CATCH_UP, FADE_FROM, PLAN,
    });
    const rate = (name) => (js.match(new RegExp(`^const ${name} = (.+);$`, 'm')) || [])[1];
    expect([flicker, swap]).toEqual([rate('FLICKER'), rate('SWAP')]);
    const squash = (text) => text.replace(/\s+/g, ' ').trim();
    const ref = squash(js);
    // The port's members (its functions and structs), each from its declaration to its closing brace, comments stripped.
    const swift = swiftRain.replace(/\/\/.*$/gm, '');
    const members = {};
    for (const m of swift.matchAll(/^ {2}(?:static func (\w+)\(|struct (\w+) \{)/gm)) {
      let end = swift.indexOf('{', m.index);
      for (let depth = 0; ; end += 1) {
        if (swift[end] === '{') depth += 1;
        if (swift[end] === '}' && (depth -= 1) === 0) break;
      }
      members[m[1] || m[2]] = squash(swift.slice(m.index, end + 1));
    }
    // What is left of `text` once `pieces` are cut out of it, each found after the one before.
    const cut = (part, text, pieces) => {
      let rest = text;
      let at = 0;
      for (const piece of pieces.map(squash)) {
        at = rest.indexOf(piece, at);
        expect([part, piece, at >= 0]).toEqual([part, piece, true]);
        rest = `${rest.slice(0, at)} ${rest.slice(at + piece.length)}`;
      }
      return squash(rest);
    };
    for (const [part, lines] of Object.entries(SWIFT_STEPS)) {
      let inRef = -1;
      for (const [line] of lines) {
        inRef = ref.indexOf(squash(line), inRef + 1);
        expect([part, line, inRef >= 0]).toEqual([part, line, true]);
      }
      // A part's members hold its ported lines and its scaffolding in their order, and nothing else: an extra step, a
      // guard or an early return is left over.
      const port = SWIFT_MEMBERS[part].map((name) => members[name]).join(' ');
      const left = cut(part, cut(part, port, lines.map(([, ported]) => ported)), SWIFT_SCAFFOLD[part]);
      expect([part, left]).toEqual([part, '']);
    }
    // Every member is a part's, but the Column the steps share.
    expect(Object.keys(members).sort()).toEqual([...Object.values(SWIFT_MEMBERS).flat(), 'Column'].sort());
    expect([...swiftRain.matchAll(/^import (\S+)$/gm)].map(([, m]) => m)).toEqual(['Foundation']);
  });

  it('iOS: HexField.swift draws a cell as the module\'s Text does: the face by its name, the font\'s line centred in the cell, the head\'s glow in points, column 0 where the row lays it out', () => {
    // A face by its PostScript name, the system face where it is missing, said once a name.
    expect(swiftView).toContain('let made = UIFont(name: name, size: glyphSize) ?? missing(name)');
    expect(swiftView).toMatch(/if QNetHexFieldView\.warned\.insert\(name\)\.inserted \{\s*NSLog\("\[WARN\]\[FIELD\] font_missing name=%@", name\)\s*\}\s*return UIFont\.systemFont\(ofSize: glyphSize\)/);
    expect(swiftView).toContain('let baseline = (cellSize - font.lineHeight) / 2 + font.ascender');
    expect(swiftView).toContain('let x = (CGFloat(rtl ? HexRain.COLUMNS - 1 - c.i : c.i) + 0.5) * colW');
    expect(swiftView).toMatch(/let row = c\.head - k\s*if row < 0 \|\| CGFloat\(row\) \* cellSize >= bounds\.height \{ continue \}\s*let o = HexRain\.opacity\(c, k\)\s*guard o > 0, let fill = toneColor\(HexRain\.tone\(k\)\) else \{ continue \}/);
    expect(swiftView).toMatch(/case 0: return paper\s*case 1: return signalPale\s*default: return signal/);
    // The cell's opacity on its glyph and on the head's glow, as a Text's opacity is; the blur in points, as a Text's shadow's.
    expect(swiftView).toMatch(/ctx\.setAlpha\(CGFloat\(o\)\)\s*ctx\.setFillColor\(fill\.cgColor\)\s*if k == 0, let glow = glowColor \{\s*ctx\.setShadow\(offset: \.zero, blur: glowRadius, color: glow\.cgColor\)\s*\}/);
    expect(swiftView).toContain('ctx.textPosition = CGPoint(x: x - line.width / 2, y: CGFloat(row) * cellSize + baseline)');
    // One line a glyph, in the context's colour.
    expect(swiftView).toContain('NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true');
  });

  it('the iOS view runs its clock only while live, in a window, shown and in front, anchors it on its first frame, and draws again only on a change', () => {
    expect(swiftView).toContain('let want = live && window != nil && !isHidden && front && !cols.isEmpty');
    for (const watch of [
      /@objc var live: Bool = false \{\s*didSet \{ run\(\) \}/,
      /override var isHidden: Bool \{\s*didSet \{ run\(\) \}/,
      /override func didMoveToWindow\(\) \{\s*super\.didMoveToWindow\(\)\s*run\(\)\s*\}/,
      /@objc private func movedBack\(\) \{\s*front = false\s*run\(\)\s*\}/,
      /@objc private func movedFront\(\) \{\s*front = true\s*run\(\)\s*\}/,
      /#selector\(movedBack\), name: UIApplication\.didEnterBackgroundNotification/,
      /#selector\(movedFront\), name: UIApplication\.willEnterForegroundNotification/,
    ]) {
      expect(swiftView).toMatch(watch);
    }
    expect(swiftView).toContain('front = UIApplication.shared.applicationState != .background');
    // 30 frames a second asked of the display, in the common modes so that a scroll does not hold it.
    expect(swiftView).toMatch(/if want \{\s*anchor = true\s*let made = CADisplayLink\(target: FrameTarget\(self\), selector: #selector\(FrameTarget\.frame\(_:\)\)\)\s*made\.preferredFrameRateRange = CAFrameRateRange\(minimum: 30, maximum: 60, preferred: 30\)[\s\S]*?made\.add\(to: \.main, forMode: \.common\)\s*link = made\s*\} else \{\s*link\?\.invalidate\(\)\s*link = nil\s*\}/);
    expect(swiftView).toMatch(/let at = link\.timestamp \* 1000\s*if anchor \{\s*clock\.start\(at\)\s*anchor = false\s*return\s*\}\s*let from = clock\.tick\s*if HexRain\.advanceTo\(&cols, from, clock\.frame\(at\)\) \{ setNeedsDisplay\(\) \}/);
    // A new plan starts its clock at tick 0; the link's target holds the view weakly.
    expect(swiftView).toMatch(/cols = rows > 1 \? HexRain\.columns\(rows\) : \[\]\s*clock = HexRain\.Clock\(\)\s*anchor = true/);
    expect(swiftView).toContain('private weak var view: QNetHexFieldView?');
    // No timer of its own: the display's frames are its only clock.
    expect(swiftView).not.toMatch(/\bTimer\b|asyncAfter/);
  });
});

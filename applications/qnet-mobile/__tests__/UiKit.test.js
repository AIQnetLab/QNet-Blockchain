/**
 * The shared pieces every screen draws with (components/ui): an action in six kinds, the soft press, a section on its
 * card, a sheet at the bottom edge, the status words, the underlined tabs, the switch, the live field. A disabled action
 * is grey, never faded; a label that changes keeps the widest label's width; a sheet sits over everything at its level,
 * clear of the home indicator.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, ActivityIndicator, Animated, AppState, Dimensions, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import Action, { ActionPair } from '../src/components/ui/Action';
import Copyable, { COPIED_MS } from '../src/components/ui/Copyable';
import SecretCopy from '../src/components/ui/SecretCopy';
import { hasKey, tr } from '../src/i18n';
import Press, { PRESS_OPACITY, PRESS_SCALE } from '../src/components/ui/Press';
import Section, { SECTION_PAD } from '../src/components/ui/Section';
import Sheet from '../src/components/ui/Sheet';
import Status, { useReduceMotion } from '../src/components/ui/Status';
import Tabs from '../src/components/ui/Tabs';
import { Toggle } from '../src/components/ui/Toggle';
import HexField, {
  CELL, COLUMNS, GLYPHS, HEAD_FLICKER_PER_S, MAX_CATCH_UP, MAX_TRAIL, MIN_TRAIL, TICK_MS, TRAIL_SWAP_PER_CELL_S, advance, columns,
  shade,
} from '../src/components/ui/HexField';
import { InfoRow, LinkRow } from '../src/components/InfoRow';
import { card, color, glow, layer, motion, radius, size, tint } from '../src/theme';

const flat = (s) => StyleSheet.flatten(s) || {};
const draw = async (el) => {
  let tree;
  await act(async () => { tree = renderer.create(el); });
  return tree;
};
const pressable = (tree) => tree.root.find((n) => typeof n.props.onPress === 'function' && typeof n.props.style === 'function');
const boxOf = (tree, pressed = false) => flat(pressable(tree).props.style({ pressed }));
const fs = require('fs');
const path = require('path');
// An app source file, for what only its code shows.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('an action', () => {
  // Rounded buttons: the radius is half the height at least, so a one-line button is a pill.
  it('solid: Signal with an Ink label, a pill 48 high; pressed Paper; disabled grey with a Fog label, never faded', async () => {
    const tree = await draw(<Action kind="solid" label="Send" onPress={() => {}} />);
    expect(boxOf(tree)).toMatchObject({ backgroundColor: color.signal, borderRadius: radius.pill, minHeight: size.button });
    expect(radius.pill * 2).toBeGreaterThanOrEqual(size.button);
    expect(boxOf(tree, true).backgroundColor).toBe(color.paper);
    expect(flat(tree.root.findByType(Text).props.style).color).toBe(color.ink);
    const off = await draw(<Action kind="solid" label="Send" onPress={() => {}} disabled />);
    expect(boxOf(off)).toMatchObject({ backgroundColor: color.fillDisabled });
    expect(boxOf(off).opacity).toBeUndefined();
    expect(flat(off.root.findByType(Text).props.style).color).toBe(color.fog);
    expect(pressable(off).props.accessibilityState).toMatchObject({ disabled: true });
  });

  // A lesser action (Receive, Cancel) is an outlined box, never a word over a rule.
  it('text and destructive: the solid action\'s pill with no fill, drawn by an Edge or Ember outline; pressed brighter', async () => {
    const underline = (t) => t.root.findAll((n) => n.type === View && flat(n.props.style).borderBottomWidth);
    const tree = await draw(<Action kind="text" label="Receive" onPress={() => {}} align="center" />);
    expect(boxOf(tree)).toMatchObject({
      alignSelf: 'stretch', minHeight: size.button, borderRadius: radius.pill, borderWidth: 1, borderColor: color.edge,
      backgroundColor: color.clear, justifyContent: 'center',
    });
    expect(underline(tree)).toHaveLength(0);
    expect(flat(tree.root.findByType(Text).props.style)).toMatchObject({ color: color.paper, textAlign: 'center' });
    expect(boxOf(tree, true)).toMatchObject({ borderColor: color.paper, backgroundColor: color.fillPress });
    // At the start of its line it is as wide as its label.
    expect(boxOf(await draw(<Action kind="text" label="Copy" onPress={() => {}} />)).alignSelf).toBe('flex-start');
    const ember = await draw(<Action kind="destructive" label="Delete wallet" onPress={() => {}} />);
    expect(boxOf(ember)).toMatchObject({ borderColor: color.ember, borderRadius: radius.pill, minHeight: size.button });
    expect(flat(ember.root.findByType(Text).props.style).color).toBe(color.ember);
    expect(boxOf(ember, true)).toMatchObject({ borderColor: color.ember, backgroundColor: tint(color.ember, 0.1) });
    const off = await draw(<Action kind="text" label="Cancel" onPress={() => {}} disabled />);
    expect(boxOf(off)).toMatchObject({ borderColor: color.ruleStrong, backgroundColor: color.clear });
    expect(flat(off.root.findByType(Text).props.style).color).toBe(color.fog);
  });

  // A small act ("More" in the header, "Done", a tab's "Close") is its word alone, on its row's centre line: a drawn
  // outline would sit off the row.
  it('quiet: the word alone in Signal on a 44 dp target, no outline, never placed off its row; act keeps its rule', async () => {
    const bar = await draw(<Action kind="quiet" label="Back" onPress={() => {}} />);
    const box = boxOf(bar);
    expect(box).toMatchObject({ minHeight: size.rowMin, minWidth: size.rowMin, alignItems: 'center', justifyContent: 'center' });
    for (const k of ['borderWidth', 'borderRadius', 'backgroundColor', 'alignSelf']) expect([k, box[k]]).toEqual([k, undefined]);
    expect(pressable(bar).props.hitSlop).toBeUndefined();
    expect(flat(bar.root.findByType(Text).props.style)).toMatchObject({ color: color.signal, textAlign: 'center' });
    expect(boxOf(bar, true).backgroundColor).toBeUndefined();
    expect(flat(bar.root.findByType(Text).props.style).color).toBe(color.signal);
    expect(bar.root.findAll((n) => n.type === View && flat(n.props.style).borderBottomWidth)).toHaveLength(0);
    // In a row (a bar, a card) the row's centre line places it whatever `align` says; `center` centres it in a column.
    expect(boxOf(await draw(<Action kind="quiet" label="Close" onPress={() => {}} align="end" />)).alignSelf).toBeUndefined();
    expect(boxOf(await draw(<Action kind="quiet" label="Forgot?" onPress={() => {}} align="center" />)).alignSelf).toBe('center');
    const off = await draw(<Action kind="quiet" label="Back" onPress={() => {}} disabled />);
    expect(flat(off.root.findByType(Text).props.style).color).toBe(color.fog);
    const act = await draw(<Action kind="act" label="Max" onPress={() => {}} />);
    const rule = act.root.findAll((n) => n.type === View && flat(n.props.style).borderBottomWidth)[0];
    expect(flat(rule.props.style)).toMatchObject({ borderBottomWidth: 1, borderBottomColor: color.signalLine });
    expect(boxOf(act).borderWidth).toBeUndefined();
  });

  it('the browser\'s Back and More, the header\'s More, the tab overview\'s Done and a tab\'s Close are quiet acts', () => {
    const browser = read('src/browser/BrowserScreen.js');
    expect(browser).toMatch(/<Action kind="quiet" label=\{t\('browser_back'\)\}/);
    expect(browser).toMatch(/<Action kind="quiet" label=\{t\('common_more'\)\}/);
    expect(browser).toMatch(/<Action kind="quiet" label=\{t\('common_done'\)\}/);
    expect(browser).toMatch(/<Action\s+kind="quiet"\s+label=\{t\('common_close'\)\}/);
    expect(read('src/screens/WalletScreen.js')).toMatch(/<Action kind="quiet" label=\{t\('common_more'\)\} accessibilityLabel=\{t\('menu_open'\)\}/);
    // The four box kinds are pills; nothing but an act inside a line of data is drawn as a word over a rule.
    const src = read('src/components/ui/Action.js');
    expect(src).toMatch(/const pill = solid \|\| second \|\| outline;/);
    expect(src).toMatch(/if \(pill \|\| quiet\) return body;/);
  });

  it('a tab\'s Close stands inside its card on the title\'s line: the card\'s top, its 44 dp target centred on that line', () => {
    const { browserStyles: tabStyles } = require('../src/browser/BrowserScreen');
    const row = flat(tabStyles.tabRow);
    const main = flat(tabStyles.tabMain);
    const title = flat(tabStyles.tabTitle);
    expect([row.flexDirection, row.alignItems, row.overflow]).toEqual(['row', 'flex-start', 'hidden']);
    expect(main).toMatchObject({ flex: 1, alignSelf: 'stretch' });
    // The title's line centre and Close's (its 44 dp box from the card's top) within a point of each other.
    expect(Math.abs(main.paddingVertical + title.lineHeight / 2 - size.rowMin / 2)).toBeLessThanOrEqual(1);
    expect(flat(tabStyles.tabClose).position).toBeUndefined();
  });

  // The other way forward on the welcome and lock screens reads as a button: a box of the solid action's size.
  it('secondary: full width and 48 high on a Signal tone with a Signal border, a centred Paper label; pressed brighter', async () => {
    const tree = await draw(<Action kind="secondary" label="Import Existing Wallet" onPress={() => {}} />);
    expect(boxOf(tree)).toMatchObject({
      alignSelf: 'stretch', minHeight: size.button, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signalLine,
      backgroundColor: color.fillPress, justifyContent: 'center',
    });
    expect(flat(tree.root.findByType(Text).props.style)).toMatchObject({ color: color.paper, textAlign: 'center' });
    expect(tree.root.findAll((n) => n.type === View && flat(n.props.style).borderBottomWidth)).toHaveLength(0);
    expect(boxOf(tree, true)).toMatchObject({ borderColor: color.signal, backgroundColor: tint(color.signal, 0.14) });
    const off = await draw(<Action kind="secondary" label="Import Existing Wallet" onPress={() => {}} disabled />);
    expect(boxOf(off)).toMatchObject({ backgroundColor: color.fillDisabled, borderColor: color.ruleStrong });
    expect(flat(off.root.findByType(Text).props.style).color).toBe(color.fog);
  });

  it('busy: the waiting label with a spinner at its start, and no second press', async () => {
    const onPress = jest.fn();
    const tree = await draw(<Action kind="solid" label="Send" busyLabel="Sending…" busy busyTestID="send-busy" onPress={onPress} />);
    expect(tree.root.findByType(ActivityIndicator).props.testID).toBe('send-busy');
    expect(tree.root.findByType(Text).props.children).toBe('Sending…');
    expect(pressable(tree).props.disabled).toBe(true);
    expect(pressable(tree).props.accessibilityState).toMatchObject({ busy: true });
  });

  it('every kind presses through the soft press; every pill settles in size, a word alone (act, quiet) does not', async () => {
    for (const kind of ['solid', 'secondary', 'text', 'destructive', 'act', 'quiet']) {
      const tree = await draw(<Action kind={kind} label="Go" onPress={() => {}} />);
      const press = tree.root.findByType(Press);
      expect([kind, press.props.scale]).toEqual([kind, kind !== 'act' && kind !== 'quiet']);
    }
  });

  it('a pair: the way out at the start half, the action at the end half', async () => {
    const tree = await draw(<ActionPair start={{ label: 'Cancel', onPress: () => {} }} end={{ label: 'Confirm', onPress: () => {}, testID: 'ok' }} />);
    const [a, b] = tree.root.findAllByType(Action);
    expect([a.props.kind, a.props.label, b.props.kind, b.props.label]).toEqual(['text', 'Cancel', 'solid', 'Confirm']);
  });
});

describe('an ampersand in Archivo', () => {
  // The sign alone in the platform's sans face at the weight of the face around it; the words keep that face.
  const signOf = (tree) => tree.root.findAll((n) => n.type === Text && n.props.children === '&')[0];

  it('a button label, a sheet title and a screen title set it in the sans face at their own weight', async () => {
    const button = await draw(<Action label="Confirm & Create Wallet" onPress={() => {}} />);
    expect(flat(signOf(button).props.style)).toEqual({ fontWeight: '600', fontFamily: 'System' });
    const label = signOf(button).parent;
    expect(flat(label.props.style).fontFamily).toBe('Archivo-SemiBold');
    expect(label.props.children.filter((c) => typeof c === 'string')).toEqual(['Confirm ', ' Create Wallet']);
    const sheet = await draw(<Sheet title="Terms of Service & Privacy Policy" onClose={() => {}}><Text>x</Text></Sheet>);
    expect(flat(signOf(sheet).props.style)).toEqual({ fontWeight: '600', fontFamily: 'System' });
    const Head = require('../src/components/ui/Head').default;
    const head = await draw(<Head title="Terms & Policy" />);
    expect(flat(signOf(head).props.style)).toEqual({ fontWeight: '700', fontFamily: 'System' });
  });

  it('every text with an ampersand is drawn as a button label or a title, which set the sign apart', () => {
    const translations = require('../src/i18n/translations').default;
    const keys = new Set();
    for (const table of Object.values(translations)) for (const [k, v] of Object.entries(table)) if (String(v).includes('&')) keys.add(k);
    const files = ['src/screens', 'src/components', 'src/browser'].flatMap(function walk(dir) {
      return fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory()
        ? walk(`${dir}/${e.name}`) : (e.name.endsWith('.js') ? [`${dir}/${e.name}`] : [])));
    });
    const uses = [];
    for (const f of files) {
      const src = read(f);
      for (const k of keys) for (const m of src.matchAll(new RegExp(`(\\w+)=\\{t\\('${k}'\\)\\}|t\\('${k}'\\)`, 'g'))) uses.push([k, m[1] || 'other']);
    }
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter(([, prop]) => prop !== 'label' && prop !== 'title')).toEqual([]);
  });
});

// Every value that can be copied is copied as the address on Assets is, its mark turning to a Signal tick for a moment
// and back; no "Copy" word is drawn anywhere. The mark on the value's line, and "Copied" in the value's place as the
// Assets address says it.
describe('a copyable value', () => {
  const Clipboard = require('@react-native-clipboard/clipboard').default;
  const glyphs = (tree) => tree.root.findAll((n) => typeof n.type === 'string' && /^copy-glyph/.test(n.props.testID || ''))
    .map((n) => n.props.testID);
  beforeEach(() => { jest.useFakeTimers(); Clipboard.setString.mockClear(); });
  afterEach(() => { jest.useRealTimers(); });

  it('a tap anywhere on it copies it whole; for COPIED_MS the mark is the tick and Copied stands in the value\'s place', async () => {
    const { copyableStyles } = require('../src/components/ui/Copyable');
    const tree = await draw(<Copyable text="abc" testID="v"><Text>abc</Text></Copyable>);
    const words = () => tree.root.findAllByType(Text).map((n) => n.props.children);
    const value = () => tree.root.find((n) => n.type === Text && n.props.children === 'abc');
    expect([glyphs(tree), words()]).toEqual([['copy-glyph'], ['abc']]);
    const target = tree.root.find((n) => n.props.testID === 'v' && typeof n.props.onPress === 'function');
    expect(target.props.accessibilityRole).toBe('button');
    expect(target.props.accessibilityHint).toBe(tr('common_tap_to_copy'));
    await act(async () => { await target.props.onPress(); });
    expect(Clipboard.setString).toHaveBeenCalledWith('abc');
    expect([glyphs(tree), words()]).toEqual([['copy-glyph-done'], ['abc', tr('common_copied')]]);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(tr('common_copied'));
    // The value keeps its room, unseen, and the word is laid over it in the Assets address's face, in Signal.
    expect(flat(value().parent.props.style)).toEqual({ opacity: 0 });
    const copied = tree.root.find((n) => n.type === Text && n.props.children === tr('common_copied'));
    expect(flat(copied.parent.props.style)).toMatchObject({ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 });
    const walletStyles = require('../src/screens/WalletScreen.styles').default;
    expect(flat(copied.props.style)).toEqual({ ...flat(walletStyles.addressPillText), writingDirection: undefined, color: color.signal });
    expect(copied.props.style).toBe(copyableStyles.copied);
    // On the address's own line rule: one line shrunk to fit, a larger system text size counted up to 1.2 times only.
    const { ADDRESS_LINE } = require('../src/components/ui/Copyable');
    expect(copied.props).toMatchObject({ ...ADDRESS_LINE, numberOfLines: 1, adjustsFontSizeToFit: true, maxFontSizeMultiplier: 1.2 });
    expect(ADDRESS_LINE.minimumFontScale).toBe(0.45);
    await act(async () => { jest.advanceTimersByTime(COPIED_MS - 1); });
    expect(glyphs(tree)).toEqual(['copy-glyph-done']);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect([glyphs(tree), words()]).toEqual([['copy-glyph'], ['abc']]);
    expect(flat(value().parent.props.style)).toEqual({});
  });

  // A transaction's detail: the mark beside the value, not between the label and the value.
  it('a label stands above the value\'s line; the mark shares that line with the value alone, centred on it', async () => {
    const { copyableStyles } = require('../src/components/ui/Copyable');
    const tree = await draw(<Copyable text="abc" label={<Text>From</Text>} testID="v"><Text>abc</Text></Copyable>);
    const target = tree.root.find((n) => n.props.testID === 'v' && typeof n.type === 'string');
    const row = tree.root.find((n) => typeof n.type === 'string' && n.props.style === copyableStyles.line);
    expect(flat(row.props.style)).toMatchObject({ flexDirection: 'row', alignItems: 'center' });
    const inRow = (test) => row.findAll((n) => typeof n.type === 'string' && test(n)).length;
    const text = (s) => (n) => [].concat(n.props.children).join('') === s;
    expect([inRow((n) => n.props.testID === 'copy-glyph'), inRow(text('abc')), inRow(text('From'))]).toEqual([1, 1, 0]);
    // The element itself is a column: the label, then the line.
    expect(flat(target.props.style).flexDirection).toBeUndefined();
    expect(target.findAll((n) => typeof n.type === 'string' && text('From')(n))).toHaveLength(1);
  });

  // A secret (the recovery phrase, a private key) has its own Copy button under it, its label alone and no mark that
  // would repeat it; the secret itself copies nothing. Copied is in Signal and comes back after COPIED_MS, as every copy.
  it('a secret\'s Copy button: its label alone, the copy through copySecret, Copied in Signal for as long as any copy says it', async () => {
    const DS = require('../src/services/DeviceSecurity');
    const copySecret = jest.spyOn(DS, 'copySecret').mockResolvedValue(true);
    try {
      const tree = await draw(<SecretCopy secret="alpha beta" label="Copy phrase" testID="s" />);
      const target = () => tree.root.find((n) => n.props.testID === 's' && n.props.accessibilityRole === 'button'
        && typeof n.props.onPress === 'function');
      const words = () => tree.root.findAllByType(Text).map((n) => n.props.children);
      expect([target().props.accessibilityRole, target().props.accessibilityLabel, words(), glyphs(tree)])
        .toEqual(['button', 'Copy phrase', ['Copy phrase'], []]);
      // Drawn as the outlined action (components/ui/Action, the text kind), across its line.
      expect(tree.root.findByType(Action).props).toMatchObject({ kind: 'text', align: 'center' });
      const { actionStyles } = require('../src/components/ui/Action');
      expect(boxOf(tree)).toMatchObject({ ...flat(actionStyles.solid), ...flat(actionStyles.outline), flexDirection: 'row' });
      // Dark at rest: the outlined box in Edge, its word in Paper.
      const label = () => flat(tree.root.findAllByType(Text)[0].props.style).color;
      expect([boxOf(tree).borderColor, label()]).toEqual([color.edge, color.paper]);
      await act(async () => { await target().props.onPress(); });
      expect([copySecret.mock.calls, Clipboard.setString.mock.calls.length]).toEqual([[['alpha beta']], 0]);
      expect([words(), glyphs(tree), target().props.accessibilityLabel]).toEqual([[tr('common_copied')], [], tr('common_copied')]);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(tr('common_copied'));
      // Copied in Signal, the box's rule too, as a copied value says it (ui/Copyable).
      expect([boxOf(tree).borderColor, label()]).toEqual([color.signalLine, color.signal]);
      await act(async () => { jest.advanceTimersByTime(COPIED_MS - 1); });
      expect(words()).toEqual([tr('common_copied')]);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect([words(), glyphs(tree), boxOf(tree).borderColor, label()]).toEqual([['Copy phrase'], [], color.edge, color.paper]);
      // A copy that did not land shows nothing.
      copySecret.mockResolvedValueOnce(false);
      await act(async () => { await target().props.onPress(); });
      expect([words(), glyphs(tree)]).toEqual([['Copy phrase'], []]);
    } finally {
      copySecret.mockRestore();
    }
  });

  it('every copy in the app is made by it: no screen draws a Copy word or keeps a copied state of its own', () => {
    expect([hasKey('common_copy'), hasKey('tx_detail_copy_hash')]).toEqual([false, false]);
    const files = ['src/screens/WalletScreen.js', 'src/screens/HistoryTab.js', 'src/screens/TokenScreens.js', 'src/screens/NodeTab.js', 'src/screens/SolanaSend.js',
      'src/screens/QNetLinkScreen.js', 'src/components/InfoRow.js', 'src/components/TxResultCard.js', 'src/components/SendReview.js',
      'src/browser/BrowserScreen.js', 'src/browser/DappSheet.js'];
    for (const f of files) {
      const src = read(f);
      expect([f, /common_copy\b|tx_detail_copy_hash|CopyGlyph|copiedAddress|setCopied/.test(src)]).toEqual([f, false]);
    }
    // The sites that copy a value hand it to the one component.
    expect(read('src/components/InfoRow.js')).toMatch(/<Copyable text=\{copy\}/);
    const ws = read('src/screens/WalletScreen.js');
    for (const id of ['address-card', 'receive-address']) expect(ws).toMatch(new RegExp(`<Copyable[^>]*?testID="${id}"`, 's'));
    expect(read('src/screens/NodeTab.js')).toMatch(/<Copyable text=\{nodeId\}/);
    // A secret only through its Copy button, which shares the one copy's state.
    expect(ws).not.toMatch(/copySecret|<Copyable write=/);
    expect(read('src/components/ui/Copyable.js')).not.toMatch(/\bwrite = |hold = COPIED_MS, children/);
    const secret = read('src/components/ui/SecretCopy.js');
    expect(secret).toMatch(/const \[done, copy\] = useCopied\(COPIED_MS, t\);/);
    expect(secret).toMatch(/onPress=\{\(\) => copy\(\(\) => copySecret\(secret\)\)\}/);
    expect(read('src/components/TxResultCard.js')).toMatch(/copy=\{hash\}/);
    expect(read('src/screens/HistoryTab.js')).toMatch(/copy=\{value\}/);
    expect(read('src/screens/TokenScreens.js')).toMatch(/<InfoField key=\{key\} t=\{t\} label=\{label\} value=\{value\} mono fit copy=\{value\}/);
    // Only the copy mark's own component and Copyable draw it; a secret's Copy button says it in its label.
    expect(read('src/components/ui/Copyable.js')).toMatch(/<CopyGlyph done=\{done\} \/>/);
    expect(secret).not.toMatch(/CopyGlyph/);
  });
});

describe('the soft press', () => {
  const host = (tree) => tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'p')[0];
  let timing;
  beforeEach(() => { timing = jest.spyOn(Animated, 'timing'); });
  afterEach(() => { timing.mockRestore(); });

  it('settles smaller and dimmer while held and back on release, in motion.press on the native driver', async () => {
    const seen = [];
    const tree = await draw(<Press testID="p" onPress={() => {}} style={({ pressed }) => { seen.push(pressed); return { padding: 4 }; }} />);
    const style = flat(host(tree).props.style);
    expect(style.padding).toBe(4);
    expect(style.transform).toHaveLength(1);
    const node = tree.root.find((n) => n.props.testID === 'p' && typeof n.props.onPressIn === 'function');
    await act(async () => { node.props.onPressIn({}); });
    expect(timing.mock.calls.map(([, c]) => [c.toValue, c.duration, c.useNativeDriver])).toEqual([[1, motion.press, true]]);
    expect(seen[seen.length - 1]).toBe(true);
    await act(async () => { node.props.onPressOut({}); });
    expect(timing.mock.calls.map(([, c]) => c.toValue)).toEqual([1, 0]);
    expect(seen[seen.length - 1]).toBe(false);
    expect([motion.press, PRESS_SCALE, PRESS_OPACITY]).toEqual([120, 0.97, 0.85]);
  });

  it('keeps its size when asked (a text action) and under the system\'s reduce-motion setting, where it only dims', async () => {
    const still = await draw(<Press testID="p" scale={false} onPress={() => {}} />);
    expect(flat(host(still).props.style).transform).toBeUndefined();
    AccessibilityInfo.isReduceMotionEnabled.mockImplementationOnce(() => Promise.resolve(true));
    const reduced = await draw(<Press testID="p" onPress={() => {}} />);
    await act(async () => {});
    expect(flat(host(reduced).props.style).transform).toBeUndefined();
    expect(flat(host(reduced).props.style).opacity).toBeDefined();
  });
});

describe('a section', () => {
  it('is the one card: its kicker inside it, its rows running to its edges', async () => {
    const tree = await draw(<Section title="Status" testID="s"><InfoRow label="Node" value="Online" /></Section>);
    const box = tree.root.find((n) => n.type === View && n.props.testID === 's');
    expect(flat(box.props.style)).toMatchObject({ ...card, overflow: 'hidden' });
    expect(box.findAllByType(Text)[0].props.children).toBe('Status');
    const row = tree.root.find((n) => n.type === View && n.props.accessible === true);
    expect(flat(row.props.style)).toMatchObject({ marginHorizontal: -SECTION_PAD, paddingHorizontal: SECTION_PAD });
    // Outside a section the same row keeps to its column.
    const bare = await draw(<InfoRow label="Node" value="Online" />);
    expect(flat(bare.root.find((n) => n.type === View && n.props.accessible === true).props.style).marginHorizontal).toBeUndefined();
  });

  // Rows part themselves by a hairline (InfoRow above itself, a setting or a link under itself): the body clips the pixel
  // past each end, so no hairline ever runs along the card's top or bottom edge.
  it('draws no hairline along its top or bottom edge, whichever rows it holds', async () => {
    const tree = await draw(<Section testID="s"><LinkRow title="Lock" onPress={() => {}} /></Section>);
    const hosts = (n) => n.findAll((k) => typeof k.type === 'string' && k !== n);
    const box = tree.root.find((n) => typeof n.type === 'string' && n.props.testID === 's');
    const [body, rows] = hosts(box);
    expect(flat(body.props.style)).toMatchObject({ overflow: 'hidden', paddingHorizontal: SECTION_PAD });
    expect(flat(body.props.style).paddingVertical).toBeUndefined();
    expect(flat(rows.props.style)).toMatchObject({ marginVertical: -1 });
  });
});

// The wallet in blocks, not lines across the page, and rounded everywhere.
describe('the screens are built of sections and cards', () => {
  // Settings: each group's kicker over a strong rule and its rows on the page, not on a card.
  it('Settings\' groups are their kicker and rows, never cards; the transactions not settled on Assets are a section', () => {
    const ws = read('src/screens/WalletScreen.js');
    for (const key of ['general', 'security_options', 'sites_title', 'network', 'set_legal', 'danger_zone']) {
      expect([key, ws.includes(`<SettingGroup title={t('${key}')}>`), ws.includes(`<Section title={t('${key}')}>`)])
        .toEqual([key, true, false]);
    }
    const group = ws.slice(ws.indexOf('function SettingGroup('), ws.indexOf('function SettingGroup(') + 300);
    expect(group).toMatch(/<View style=\{styles\.settingGroup\}>\s*<Text style=\{styles\.settingGroupTitle\}>\{title\}<\/Text>/);
    expect(group).not.toMatch(/Section/);
    expect(ws).toMatch(/<Section title=\{t\('kept_title', \{ count: keptTxs\.length \}\)\}>/);
    // Its rows run to the card's edges by the section's one rule, as every row in a section does (components/InfoRow).
    expect(ws).toMatch(/style=\{\[styles\.tokenItem, sectionStyles\.bleed\]\}/);
    expect(flat(require('../src/components/ui/Section').sectionStyles.bleed))
      .toEqual({ marginHorizontal: -SECTION_PAD, paddingHorizontal: SECTION_PAD });
    expect(read('src/components/InfoRow.js')).not.toMatch(/^\s*bleed:/m);
    const styles = require('../src/screens/WalletScreen.styles').default;
    for (const gone of ['listKicker', 'nodeGroup', 'rewardsCard', 'rewardsTitle', 'nodeFigure', 'histRowPressed']) {
      expect([gone, gone in styles]).toEqual([gone, false]);
    }
    expect(flat(styles.settingGroupTitle)).toMatchObject({ color: color.fog, borderBottomWidth: 1, borderBottomColor: color.ruleStrong });
    expect(flat(styles.settingGroup).borderRadius).toBeUndefined();
    expect(flat(styles.settingSubtitle).paddingVertical).toBeUndefined();
    // The cards that are one target each are drawn on the same card: a History row, a token, the address.
    for (const name of ['histRow', 'tokenItemClickable', 'addressPill']) {
      expect([name, flat(styles[name])]).toEqual([name, expect.objectContaining(card)]);
    }
  });

  it('no corner is set by a number of its own: every radius is a theme token, so nothing turns square again', () => {
    const files = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return /locales/.test(e.name) ? [] : files(rel);
      return e.name.endsWith('.js') && rel !== 'src/theme.js' ? [rel] : [];
    });
    const literal = files('src').flatMap((f) => read(f).split('\n').map((line, i) => [f, i + 1, line]))
      .filter(([, , line]) => /\bborder\w*Radius\s*:\s*\d/.test(line)).map(([f, i]) => `${f}:${i}`);
    expect(literal).toEqual([]);
  });
});

describe('a sheet', () => {
  it('sits at the bottom edge over the screen at its level, Surface with a strong rule on top, clear of the home indicator', async () => {
    const tree = await draw(
      <SafeAreaInsetsContext.Provider value={{ top: 47, bottom: 34, left: 0, right: 0 }}>
        <Sheet title="Auto-lock" onClose={() => {}} closeLabel="Close" level="request"><Text>body</Text></Sheet>
      </SafeAreaInsetsContext.Provider>,
    );
    const overlay = tree.root.find((n) => n.type === View && flat(n.props.style).zIndex === layer.request.zIndex);
    expect(flat(overlay.props.style)).toMatchObject({ justifyContent: 'flex-end', position: 'absolute', elevation: layer.request.elevation });
    const panel = tree.root.findAll((n) => n.props.accessibilityViewIsModal === true && typeof n.type === 'string')[0];
    expect(flat(panel.props.style)).toMatchObject({
      backgroundColor: color.surface, borderTopWidth: 1, borderTopColor: color.ruleStrong, paddingBottom: 16 + 34, maxWidth: 560,
    });
    // Rounded at its top corners only: its bottom edge is the screen's.
    expect(flat(panel.props.style)).toMatchObject({ borderTopStartRadius: radius.sheet, borderTopEndRadius: radius.sheet });
    expect(flat(panel.props.style).borderRadius).toBeUndefined();
    const close = tree.root.findAllByType(Action).find((n) => n.props.label === 'Close');
    expect(close.props.kind).toBe('quiet');
    expect(tree.root.findAllByType(Sheet)[0].props.level).toBe('request');
  });

  it('an alert or a prompt by default, above the request sheets', async () => {
    const tree = await draw(<Sheet title="Delete wallet"><Text>x</Text></Sheet>);
    expect(tree.root.findAll((n) => n.type === View && flat(n.props.style).zIndex === layer.alert.zIndex)).toHaveLength(1);
    expect(layer.alert.zIndex).toBeGreaterThan(layer.request.zIndex);
    expect(tree.root.findAllByType(Action)).toHaveLength(0);
  });

  // A busy screen change (a wallet just deleted) delays the system's answer long enough to see a panel waiting on it.
  it('moves from its first frame on the reduce-motion setting the app already read, never waiting on the system', async () => {
    const ask = AccessibilityInfo.isReduceMotionEnabled;
    const asked = ask.getMockImplementation();
    const timing = jest.spyOn(Animated, 'timing');
    const Reader = () => { useReduceMotion(); return null; };
    const learn = async (answer) => {
      ask.mockImplementationOnce(() => Promise.resolve(answer));
      const reader = await draw(<Reader />);
      await act(async () => {});
      act(() => { reader.unmount(); });
    };
    // Opened while the system's next answer never comes: what its first frames are.
    const opened = async (reduce) => {
      await learn(reduce);
      ask.mockImplementation(() => new Promise(() => {}));
      timing.mockClear();
      const tree = await draw(<Sheet title="Delete wallet"><Text>x</Text></Sheet>);
      const panel = tree.root.findAll((n) => n.props.accessibilityViewIsModal === true && typeof n.type === 'string')[0];
      const drawn = { moves: timing.mock.calls.map(([, c]) => [c.toValue, c.duration, c.useNativeDriver]), at: flat(panel.props.style).transform };
      act(() => { tree.unmount(); });
      ask.mockImplementation(asked);
      return drawn;
    };
    try {
      expect((await opened(false)).moves).toEqual([[1, motion.sheet, true]]);
      expect(await opened(true)).toEqual({ moves: [], at: [{ translateY: 0 }] });
    } finally {
      timing.mockRestore();
      ask.mockImplementation(asked);
      await learn(false);
    }
  });
});

describe('status words, tabs and the switch', () => {
  it('a status is a word in its tone; live adds the dot; never a filled pill', async () => {
    const live = await draw(<Status tone="live" label="Online" />);
    expect(live.root.findAll((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal).length).toBeGreaterThan(0);
    for (const [tone, ink] of [['done', color.paper], ['ok', color.mint], ['quiet', color.fog], ['needs', color.ember]]) {
      const tree = await draw(<Status tone={tone} label="x" />);
      const word = tree.root.findByType(Text);
      expect([tone, flat(word.props.style).color, flat(word.props.style).backgroundColor]).toEqual([tone, ink, undefined]);
    }
  });

  it('underlined tabs: the chosen one in Paper over a Signal line; one item draws nothing', async () => {
    const onChange = jest.fn();
    const items = [{ key: 'qnet', label: 'QNet Blockchain' }, { key: 'sol', label: 'Solana' }];
    const tree = await draw(<Tabs items={items} value="qnet" onChange={onChange} />);
    const cells = tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'tab');
    expect(cells.map((c) => c.props.accessibilityState.selected)).toEqual([true, false]);
    expect(flat(cells[0].props.style).borderBottomColor).toBe(color.signal);
    expect(flat(cells[0].findByType(Text).props.style).color).toBe(color.paper);
    expect(flat(cells[1].findByType(Text).props.style).color).toBe(color.fog);
    await act(async () => { cells[1].props.onPress(); });
    expect(onChange).toHaveBeenCalledWith('sol');
    expect((await draw(<Tabs items={[items[0]]} value="qnet" onChange={onChange} />)).toJSON()).toBeNull();
  });

  it('the switch: a pill track with a round knob, on in Signal; it reports the flipped value', async () => {
    const onValueChange = jest.fn();
    const tree = await draw(<Toggle value={false} onValueChange={onValueChange} accessibilityLabel="Hide balances" />);
    const sw = tree.root.find((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    expect(sw.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => { sw.props.onPress(); });
    expect(onValueChange).toHaveBeenCalledWith(true);
    const on = await draw(<Toggle value onValueChange={() => {}} />);
    const track = on.root.findAll((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal);
    expect(track.length).toBeGreaterThan(0);
    expect(flat(track[0].props.style).borderRadius).toBe(radius.pill);
  });
});

describe('the live field and a chosen row', () => {
  const ROWS = 20;
  // A window whose top half holds ROWS cells and a few points more.
  const WINDOW = { width: 360, height: 2 * (ROWS * CELL + 7), scale: 2, fontScale: 1 };
  let shown;
  beforeAll(() => {
    shown = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    Dimensions.set({ window: WINDOW, screen: WINDOW });
  });
  afterAll(() => { Dimensions.set(shown); });
  const fieldOf = (tree) => tree.root.find((n) => n.props.testID === 'hex-field' && typeof n.type === 'string');
  // The field laid out in a room `height` high (its first layout starts it).
  const layout = async (tree, height) => {
    await act(async () => { fieldOf(tree).props.onLayout({ nativeEvent: { layout: { width: WINDOW.width, height } } }); });
  };
  // Unmounted after each test too: one that fails before its own unmount leaves no clock running into the next.
  const mounted = [];
  const laidOut = async (el) => {
    const tree = await draw(el);
    mounted.push(tree);
    await layout(tree, WINDOW.height / 2);
    return tree;
  };
  // Every column's cells as drawn, each a Text of its own at its grid row: its glyph, tone, opacity and the head's glow.
  const columnsOf = (tree) => fieldOf(tree).findAll((n) => n.type === View).map((col) => col.findAll((n) => n.type === Text)
    .map((g) => {
      const st = flat(g.props.style);
      return {
        row: st.top / CELL, ch: g.props.children, tone: st.color, opacity: st.opacity,
        glow: st.textShadowRadius === glow.textShadowRadius, runs: g.findAll((n) => n.type === Text && n !== g).length,
      };
    }));
  const headOf = (cells) => cells.find((c) => c.glow).row;
  // Each column's glyphs from the head up, as drawn.
  const glyphsOf = (cells) => [...cells].sort((x, y) => y.row - x.row).map((c) => c.ch);
  // The field's clock is never an interval (a slow render would queue ticks behind it): one step is pending at a time, a
  // timeout and then a frame, which here comes at once (no screen draws frames under Jest).
  let timing;
  let every;
  let frames;
  const pending = () => jest.getTimerCount();
  const tick = async (n = 1) => { await act(async () => { jest.advanceTimersByTime(n * TICK_MS); }); };
  const replay = (ticks, rows = ROWS) => {
    let cols = columns(rows);
    for (let t = 1; t <= ticks; t += 1) cols = cols.map((c) => advance(c, t));
    return cols;
  };
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    timing = jest.spyOn(Animated, 'timing');
    every = jest.spyOn(global, 'setInterval');
    frames = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((fn) => { fn(Date.now()); return 0; });
  });
  afterEach(() => {
    mounted.splice(0).forEach((tree) => act(() => { tree.unmount(); }));
    timing.mockRestore(); every.mockRestore(); frames.mockRestore(); jest.useRealTimers();
  });

  it('over the top half: a fixed grid per column, the head in Paper with the glow, two pale cells, the trail Signal fading', async () => {
    const tree = await laidOut(<HexField />);
    expect(flat(fieldOf(tree).props.style))
      .toMatchObject({ position: 'absolute', top: 0, height: WINDOW.height / 2, overflow: 'hidden' });
    const cols = columnsOf(tree);
    const plan = columns(ROWS);
    expect(cols).toHaveLength(COLUMNS);
    cols.forEach((cells, i) => {
      // One glyph per cell, on whole rows from the head up; no run of glyphs inside one Text.
      const drawn = [...cells].sort((x, y) => y.row - x.row);
      expect(drawn.map((c) => c.row)).toEqual(Array.from({ length: plan[i].len }, (_, k) => plan[i].head - k));
      for (const c of drawn) expect([GLYPHS.includes(c.ch), c.ch.length, c.runs]).toEqual([true, 1, 0]);
      expect(drawn.map((c) => c.tone)).toEqual([color.paper, color.signalPale, color.signalPale, ...Array(plan[i].len - 3).fill(color.signal)]);
      expect(drawn.map((c) => c.glow)).toEqual([true, ...Array(plan[i].len - 1).fill(false)]);
      for (let k = 4; k < drawn.length; k += 1) expect(drawn[k].opacity).toBeLessThanOrEqual(drawn[k - 1].opacity);
      expect(drawn[0].opacity).toBeGreaterThan(0);
    });
    await act(async () => { tree.unmount(); });
  });

  it('a column runs from above the field to its last row and starts in the upper part; at most COLUMNS x MAX_TRAIL glyphs', () => {
    const plan = columns(ROWS);
    expect(plan.reduce((n, c) => n + c.len, 0)).toBeLessThanOrEqual(COLUMNS * MAX_TRAIL);
    for (const c of plan) {
      expect([c.len >= MIN_TRAIL, c.len <= MAX_TRAIL, c.glyphs.length === c.len, [2, 3, 4, 5].includes(c.every)]).toEqual([true, true, true, true]);
      expect([c.from <= -1, c.to, c.head >= c.from, c.head <= 0.8 * ROWS]).toEqual([true, ROWS - 1, true, true]);
    }
    // Whole while the head is in the upper 40% of the field, gone on its last row: the middle of the screen.
    const c = plan[0];
    expect(shade({ ...c, head: 0.4 * ROWS - 1 }, 0).opacity).toBeCloseTo(Math.min(1, 1.4 * c.a), 2);
    expect(shade({ ...c, head: ROWS - 1 }, 0).opacity).toBe(0);
  });

  it('glyphs stay in their cells: the head writes a new glyph in each cell it enters and flickers HEAD_FLICKER_PER_S times a second between steps, each trail glyph in sight changes on its own TRAIL_SWAP_PER_CELL_S times a second', () => {
    const minute = Math.round(60000 / TICK_MS);
    const sec = TICK_MS / 1000;
    let cols = columns(ROWS);
    const zero = () => Array(COLUMNS).fill(0);
    // Per column: seconds with the head in sight and its glyph changes then; the same for ticks without a step (the
    // flicker); trail swaps and the seconds of trail cells in sight.
    const [shown, changes, between, flickers, swaps, cellSeconds] = [zero(), zero(), zero(), zero(), zero(), zero()];
    const written = Array.from({ length: COLUMNS }, () => new Set());
    const inSight = (c, row) => row >= 0 && row < c.to;
    const wrong = [];
    for (let t = 1; t <= minute; t += 1) {
      const next = cols.map((c) => advance(c, t));
      next.forEach((n, i) => {
        const c = cols[i];
        const step = (t + c.phase) % c.every === 0;
        if (n.head !== (!step ? c.head : (c.head >= c.to ? c.from : c.head + 1))) wrong.push(['head', t, i]);
        if (step) written[i].add(n.glyphs[0]);
        const flicked = n.glyphs[0] !== c.glyphs[0];
        if (step && !flicked) wrong.push(['the same glyph after a step', t, i]);
        if (!step && flicked && !inSight(c, c.head)) wrong.push(['a flicker out of sight', t, i]);
        // Every other glyph keeps its cell unless it is swapped, and only cells in sight are.
        const kept = step ? [n.glyphs[0], ...c.glyphs.slice(0, -1)] : [n.glyphs[0], ...c.glyphs.slice(1)];
        const lit = inSight(n, n.head) ? Math.min(n.len - 1, n.head) : 0;
        for (let k = 1; k < n.len; k += 1) {
          if (n.glyphs[k] === kept[k]) continue;
          if (k > lit) wrong.push(['a swap out of sight', t, i, k]);
          swaps[i] += 1;
        }
        cellSeconds[i] += lit * sec;
        if (!inSight(n, n.head)) return;
        shown[i] += sec;
        if (flicked) changes[i] += 1;
        if (!step) { between[i] += sec; if (flicked) flickers[i] += 1; }
      });
      cols = next;
    }
    expect(wrong).toEqual([]);
    const near = (x, want) => x > want * 0.8 && x < want * 1.2;
    for (let i = 0; i < COLUMNS; i += 1) {
      expect([
        i, changes[i] / shown[i] >= 10, near(flickers[i] / between[i], HEAD_FLICKER_PER_S),
        near(swaps[i] / cellSeconds[i], TRAIL_SWAP_PER_CELL_S), written[i].size > 12,
      ]).toEqual([i, true, true, true, true]);
    }
  });

  it('drawn: a step moves the head a cell down, the head flickers in place; the other glyphs keep their cells, a changed one its brightness', async () => {
    const tree = await laidOut(<HexField />);
    const nodes = columns(ROWS).reduce((n, c) => n + c.len, 0);
    let before = columnsOf(tree);
    let [steps, swaps, flickers] = [0, 0, 0];
    for (let n = 0; n < 90; n += 1) {
      await tick();
      const after = columnsOf(tree);
      // The same cells all along: nothing is added or taken away while the field runs.
      expect(after.flat()).toHaveLength(nodes);
      after.forEach((cells, i) => {
        const [h0, h1] = [headOf(before[i]), headOf(cells)];
        expect(h1 === h0 || h1 === h0 + 1 || h1 < h0).toBe(true);
        if (h1 === h0 + 1) steps += 1;
        const was = new Map(before[i].map((c) => [c.row, c]));
        let changed = 0;
        for (const c of cells) {
          const old = was.get(c.row);
          if (!old || c.row < 0 || old.ch === c.ch) continue;
          if (h1 === h0) expect([c.tone, c.opacity, c.glow]).toEqual([old.tone, old.opacity, old.glow]);
          if (c.row === h1) { if (h1 === h0) flickers += 1; continue; }
          changed += 1;
        }
        expect(changed).toBeLessThanOrEqual(1);
        swaps += changed;
      });
      before = after;
    }
    expect([steps > COLUMNS * 10, swaps > 0, flickers > COLUMNS * 10]).toEqual([true, true, true]);
    await act(async () => { tree.unmount(); });
  });

  // A low-end phone draws the field on the same thread as the wallet: one render of the field a tick, and a flicker or a
  // swap redraws its own Text, never the 8 to 14 of its column.
  it('cost: at most one render a tick; between steps only the cells whose glyph changed are drawn again', async () => {
    let commits = 0;
    const tree = await laidOut(<React.Profiler id="field" onRender={() => { commits += 1; }}><HexField /></React.Profiler>);
    // One pass over the field a tick. A Text drawn again gets new props; one left alone keeps the very same object.
    const read = () => fieldOf(tree).findAll((n) => n.type === View).map((col) => col.findAll((n) => n.type === Text)
      .map((g) => {
        const st = flat(g.props.style);
        return { props: g.props, ch: g.props.children, row: st.top / CELL, glow: st.textShadowRadius === glow.textShadowRadius };
      }));
    // Three seconds hold many steps of every column (a step every 2 to 5 ticks) and the flickers between them.
    const ticks = Math.round(3000 / TICK_MS);
    let cells = read();
    commits = 0;
    const wrong = [];
    for (let n = 0; n < ticks; n += 1) {
      await tick();
      const c = read();
      c.forEach((col, i) => {
        const redrawn = col.filter((x, j) => x.props !== cells[i][j].props).length;
        const glyphs = col.filter((x, j) => x.ch !== cells[i][j].ch).length;
        if (headOf(col) === headOf(cells[i]) ? redrawn !== glyphs : redrawn > col.length) wrong.push([n, i, redrawn, glyphs]);
      });
      cells = c;
    }
    expect([wrong, commits <= ticks]).toEqual([[], true]);
    await act(async () => { tree.unmount(); });
  });

  it('one clock for the whole field, no animation; it stops in the background and goes on from where it stood', async () => {
    const tree = await laidOut(<HexField />);
    expect([every.mock.calls.length, timing.mock.calls.length, pending()]).toEqual([0, 0, 1]);
    await tick(10);
    const stood = columnsOf(tree);
    expect(stood.map(glyphsOf)).toEqual(replay(10).map((c) => c.glyphs));
    const change = AppState.addEventListener.mock.calls.filter(([type]) => type === 'change').map(([, fn]) => fn).pop();
    await act(async () => { change('background'); });
    expect(pending()).toBe(0);
    await tick(30);
    expect(columnsOf(tree)).toEqual(stood);
    await act(async () => { change('active'); });
    expect(pending()).toBe(1);
    await tick();
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(11).map((c) => c.glyphs));
    await act(async () => { tree.unmount(); });
    expect([pending(), every.mock.calls.length]).toEqual([0, 0]);
  });

  // A phone whose render of the field takes longer than a tick: the ticks never queue behind it, so a tap waits behind at
  // most one render; each step waits as long again as that render took, and the next render draws the ticks it could
  // not, so the field keeps its speed. Every reading of the field's clock here comes WORK ms after the one before.
  it('a slow phone: one step pending at a time, each waiting at least as long as the last render took; the field keeps its speed', async () => {
    const WORK = 60;
    const readings = [];
    let behind = 0;
    const slow = () => {
      const at = Date.now() + behind;
      behind += WORK;
      readings.push(at);
      return at;
    };
    const timeouts = jest.spyOn(global, 'setTimeout');
    const tree = await laidOut(<HexField now={slow} />);
    for (let n = 0; n < 40; n += 1) {
      await act(async () => { jest.advanceTimersToNextTimer(); });
      expect(pending()).toBeLessThanOrEqual(1);
    }
    // The step after each render, never sooner than the render's work; each render waited for a frame.
    const steps = timeouts.mock.calls.map(([, ms]) => ms).slice(1);
    timeouts.mockRestore();
    expect([steps.length, frames.mock.calls.length]).toEqual([40, 40]);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(WORK);
    // The ticks drawn are the ticks due by the field's clock at the last render (its first reading of the two).
    const due = Math.floor((readings[readings.length - 2] - readings[0]) / TICK_MS);
    expect(due).toBeGreaterThan(steps.length * 2);
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(due).map((c) => c.glyphs));
    expect(every.mock.calls.length).toBe(0);
  });

  // A render that came much later than due (a stall, a clock set forward or back) draws MAX_CATCH_UP ticks at most, and
  // the field goes on from there at its own pace.
  it('after a stall it draws MAX_CATCH_UP ticks at most and goes on from there', async () => {
    let jump = 0;
    const clock = () => Date.now() + jump;
    const tree = await laidOut(<HexField now={clock} />);
    await tick(3);
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(3).map((c) => c.glyphs));
    jump = 3600_000;
    await tick();
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(3 + MAX_CATCH_UP).map((c) => c.glyphs));
    await tick();
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(4 + MAX_CATCH_UP).map((c) => c.glyphs));
    jump = -3600_000;
    await tick();
    await tick();
    expect(columnsOf(tree).map(glyphsOf)).toEqual(replay(5 + MAX_CATCH_UP).map((c) => c.glyphs));
  });

  it('a still frame under the system\'s reduce-motion setting', async () => {
    AccessibilityInfo.isReduceMotionEnabled.mockImplementationOnce(() => Promise.resolve(true));
    const tree = await laidOut(<HexField />);
    await act(async () => {});
    const still = columnsOf(tree);
    expect(still).toHaveLength(COLUMNS);
    await tick(30);
    expect([pending(), columnsOf(tree)]).toEqual([0, still]);
    await act(async () => { tree.unmount(); });
  });

  it('nothing in it for accessibility services, and no touch: it carries no information', async () => {
    const tree = await laidOut(<HexField />);
    expect(fieldOf(tree).props).toMatchObject({
      pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants',
    });
    await act(async () => { tree.unmount(); });
  });

  // A keyboard shrinks the room the field is drawn in (components/ui/StartScreen): the field is sized by the window, so
  // typing the password neither cuts it nor starts it over.
  it('sized by the window, never measured in its room: the keyboard lifting the screen starts nothing over', async () => {
    const { KeyboardAvoidingView, TextInput } = require('react-native');
    const StartScreen = require('../src/components/ui/StartScreen').default;
    const { StartField } = require('../src/components/ui/StartScreen');
    const tree = await laidOut(<StartScreen field><StartField placeholder="Password" /></StartScreen>);
    await tick(5);
    const drawn = columnsOf(tree);
    expect([drawn.length, pending()]).toEqual([COLUMNS, 1]);
    // The password's keyboard lifts the room and lays the field out again, a third shorter: it keeps the window's top
    // half and runs on.
    await act(async () => { tree.root.findByType(TextInput).props.onFocus({}); });
    await layout(tree, WINDOW.height / 3);
    expect(tree.root.findByType(KeyboardAvoidingView).props.enabled).toBe(true);
    expect(flat(fieldOf(tree).props.style).height).toBe(WINDOW.height / 2);
    expect([pending(), columnsOf(tree)]).toEqual([1, drawn]);
    await tick();
    expect(columnsOf(tree).map(headOf)).toEqual(replay(6).map((c) => c.head));
    // A new window (a turned tablet) plans the field anew.
    const turned = { ...WINDOW, height: WINDOW.height + 4 * CELL };
    await act(async () => { Dimensions.set({ window: turned, screen: turned }); });
    expect(flat(fieldOf(tree).props.style).height).toBe(turned.height / 2);
    expect(columnsOf(tree).map(headOf)).toEqual(columns(ROWS + 2).map((c) => c.head));
    // The field planned anew runs on its own clock; the old one's step is gone.
    expect(pending()).toBe(1);
    await tick();
    expect(columnsOf(tree).map(headOf)).toEqual(replay(1, ROWS + 2).map((c) => c.head));
    await act(async () => { Dimensions.set({ window: WINDOW, screen: WINDOW }); });
    await act(async () => { tree.unmount(); });
  });

  // A picker's rows sit in a sheet's scrolling body, which clips what is drawn past its edge.
  it('a chosen picker row draws its Signal bar inside the row, and choosing never moves a title', async () => {
    const row = async (selected) => {
      const tree = await draw(<LinkRow title="English" selected={selected} accessibilityRole="radio" onPress={() => {}} />);
      return { tree, box: flat(pressable(tree).props.style({ pressed: false })) };
    };
    const on = await row(true);
    const off = await row(false);
    const bar = on.tree.root.find((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal);
    expect(flat(bar.props.style).start).toBeGreaterThanOrEqual(0);
    expect(on.box.paddingStart).toBeGreaterThan(flat(bar.props.style).width);
    expect(off.box.paddingStart).toBe(on.box.paddingStart);
    const plain = await draw(<LinkRow title="Change password" onPress={() => {}} />);
    expect(flat(pressable(plain).props.style({ pressed: false })).paddingStart).toBeUndefined();
  });
});

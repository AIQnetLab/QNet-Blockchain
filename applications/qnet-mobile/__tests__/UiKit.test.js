/**
 * The shared pieces every screen draws with (components/ui): an action in six kinds, a sheet at the bottom edge, the
 * status words, the underlined tabs, the switch, the live field. A disabled action is grey, never faded; a label that changes keeps the
 * widest label's width; a sheet sits over everything at its level, clear of the home indicator.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, ActivityIndicator, Animated, AppState, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import Action, { ActionPair } from '../src/components/ui/Action';
import Sheet from '../src/components/ui/Sheet';
import Status from '../src/components/ui/Status';
import Tabs from '../src/components/ui/Tabs';
import { Toggle } from '../src/components/ui/Toggle';
import HexField, { CELL, COLUMNS, GLYPHS, columns } from '../src/components/ui/HexField';
import { LinkRow } from '../src/components/InfoRow';
import { color, glow, layer, radius, size, tint } from '../src/theme';

const flat = (s) => StyleSheet.flatten(s) || {};
const draw = async (el) => {
  let tree;
  await act(async () => { tree = renderer.create(el); });
  return tree;
};
const pressable = (tree) => tree.root.find((n) => typeof n.props.onPress === 'function' && typeof n.props.style === 'function');
const boxOf = (tree, pressed = false) => flat(pressable(tree).props.style({ pressed }));

describe('an action', () => {
  it('solid: Signal with an Ink label, square-cornered, 48 high; pressed Paper; disabled grey with a Fog label, never faded', async () => {
    const tree = await draw(<Action kind="solid" label="Send" onPress={() => {}} />);
    expect(boxOf(tree)).toMatchObject({ backgroundColor: color.signal, borderRadius: radius.box, minHeight: size.button });
    expect(boxOf(tree, true).backgroundColor).toBe(color.paper);
    expect(flat(tree.root.findByType(Text).props.style).color).toBe(color.ink);
    const off = await draw(<Action kind="solid" label="Send" onPress={() => {}} disabled />);
    expect(boxOf(off)).toMatchObject({ backgroundColor: color.fillDisabled });
    expect(boxOf(off).opacity).toBeUndefined();
    expect(flat(off.root.findByType(Text).props.style).color).toBe(color.fog);
    expect(pressable(off).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('text and destructive: no box, the label underlined by a rule (Signal, Ember), thicker while pressed', async () => {
    const tree = await draw(<Action kind="text" label="Import wallet" onPress={() => {}} />);
    expect(boxOf(tree).backgroundColor).toBeUndefined();
    const rule = (t) => flat(t.root.findAll((n) => n.type === View && flat(n.props.style).borderBottomWidth)[0].props.style);
    expect(rule(tree)).toMatchObject({ borderBottomWidth: 1, borderBottomColor: color.signalLine });
    expect(flat(tree.root.findByType(Text).props.style).color).toBe(color.paper);
    const ember = await draw(<Action kind="destructive" label="Delete wallet" onPress={() => {}} />);
    expect(rule(ember).borderBottomColor).toBe(color.ember);
    expect(flat(ember.root.findByType(Text).props.style).color).toBe(color.ember);
  });

  it('a label that changes keeps the widest label\'s width: the others hold it at no height, hidden from screen readers', async () => {
    const tree = await draw(<Action kind="act" label="Copy" labels={['Copy', 'Copied']} onPress={() => {}} />);
    const [shown, held] = tree.root.findAllByType(Text);
    expect([shown.props.children, held.props.children]).toEqual(['Copy', 'Copied']);
    expect(flat(held.props.style)).toMatchObject({ height: 0, opacity: 0 });
    expect(held.props.accessibilityElementsHidden).toBe(true);
    expect(held.props.importantForAccessibility).toBe('no-hide-descendants');
    const column = shown.parent;
    expect(column.findAllByType(Text)).toHaveLength(2);
  });

  // The other way forward on the welcome and lock screens reads as a button: a box of the solid action's size.
  it('secondary: full width and 48 high on a Signal tone with a Signal border, a centred Paper label; pressed brighter', async () => {
    const tree = await draw(<Action kind="secondary" label="Import Existing Wallet" onPress={() => {}} />);
    expect(boxOf(tree)).toMatchObject({
      alignSelf: 'stretch', minHeight: size.button, borderRadius: radius.box, borderWidth: 1, borderColor: color.signalLine,
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

  it('a pair: the way out at the start half, the action at the end half', async () => {
    const tree = await draw(<ActionPair start={{ label: 'Cancel', onPress: () => {} }} end={{ label: 'Confirm', onPress: () => {}, testID: 'ok' }} />);
    const [a, b] = tree.root.findAllByType(Action);
    expect([a.props.kind, a.props.label, b.props.kind, b.props.label]).toEqual(['text', 'Cancel', 'solid', 'Confirm']);
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
});

describe('status words, tabs and the switch', () => {
  it('a status is a word in its tone; live adds the dot; never a filled pill', async () => {
    const live = await draw(<Status tone="live" label="Online" />);
    expect(live.root.findAll((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal).length).toBeGreaterThan(0);
    for (const [tone, ink] of [['done', color.paper], ['quiet', color.fog], ['needs', color.ember]]) {
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

  it('the switch: a square track, on in Signal; it reports the flipped value', async () => {
    const onValueChange = jest.fn();
    const tree = await draw(<Toggle value={false} onValueChange={onValueChange} accessibilityLabel="Hide balances" />);
    const sw = tree.root.find((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    expect(sw.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => { sw.props.onPress(); });
    expect(onValueChange).toHaveBeenCalledWith(true);
    const on = await draw(<Toggle value onValueChange={() => {}} />);
    const track = on.root.findAll((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal);
    expect(track.length).toBeGreaterThan(0);
    expect(flat(track[0].props.style).borderRadius).toBe(radius.box);
  });
});

describe('the live field and a chosen row', () => {
  const ROWS = 20;
  const laidOut = async (el) => {
    const tree = await draw(el);
    const field = tree.root.find((n) => n.props.testID === 'hex-field' && n.props.onLayout);
    await act(async () => { field.props.onLayout({ nativeEvent: { layout: { width: 360, height: ROWS * CELL + 7 } } }); });
    return tree;
  };
  const rgbOf = (hex) => tint(hex, 1).replace(/, 1\)$/, '');
  const glyphColumns = (tree) => tree.root.findAll((n) => n.type === Text && flat(n.props.style).lineHeight === CELL);
  let timing;
  let stop;
  const glyphsOf = (col) => col.findAll((n) => n.type === Text && n !== col).map((g) => String(g.props.children)).join('');
  // The test double of the native side ends every animation after 16 ms; the clock is held so each pass ends on cue.
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    timing = jest.spyOn(Animated, 'timing');
    stop = jest.spyOn(Animated.Value.prototype, 'stopAnimation');
  });
  afterEach(() => { timing.mockRestore(); stop.mockRestore(); jest.useRealTimers(); });

  // Android draws a run inside a Text with its colour but ignores its opacity: the trail's fade is in the colour's alpha.
  it('over the top half: each column the head in Paper with the glow, two pale cells, the trail Signal fading to its end', async () => {
    const tree = await laidOut(<HexField />);
    expect(flat(tree.root.find((n) => n.props.testID === 'hex-field' && n.props.onLayout).props.style))
      .toMatchObject({ position: 'absolute', top: 0, height: '50%', overflow: 'hidden' });
    const cols = glyphColumns(tree);
    expect(cols).toHaveLength(COLUMNS);
    for (const col of cols) {
      const cells = col.findAll((n) => n.type === Text && n !== col);
      const drawn = cells.map((g) => {
        const st = flat(g.props.style);
        expect(st.opacity).toBeUndefined();
        expect(GLYPHS).toContain(String(g.props.children).trim());
        const [, rgb, alpha] = /^(rgba\(\d+, \d+, \d+), ([\d.]+)\)$/.exec(st.color);
        return { rgb, alpha: Number(alpha) };
      });
      const head = drawn.length - 1;
      expect(drawn.map((d) => d.rgb)).toEqual([...Array(head - 2).fill(rgbOf(color.signal)), rgbOf(color.signalPale),
        rgbOf(color.signalPale), rgbOf(color.paper)]);
      expect(flat(cells[head].props.style)).toMatchObject(glow);
      for (let k = 1; k < head - 2; k += 1) expect(drawn[k].alpha).toBeGreaterThanOrEqual(drawn[k - 1].alpha);
    }
    await act(async () => { tree.unmount(); });
  });

  it('a column is whole in the upper part and gone where its head reaches the field\'s end, the middle of the screen', () => {
    for (const c of columns(ROWS)) {
      expect(c.from + c.len * CELL).toBeLessThanOrEqual(0);
      expect(c.to + c.len * CELL).toBe(ROWS * CELL);
      expect(c.fade).toEqual([c.to - 0.6 * ROWS * CELL, c.to]);
      expect(c.at + c.len * CELL).toBeLessThanOrEqual(0.8 * ROWS * CELL + CELL);
      expect(c.at).toBeGreaterThanOrEqual(c.from);
    }
  });

  it('falls by native-driven timing only, a cell at a step, never holding interactions; stops in the background', async () => {
    const tree = await laidOut(<HexField />);
    await act(async () => {});
    expect(timing).toHaveBeenCalledTimes(COLUMNS);
    const plan = columns(ROWS);
    timing.mock.calls.forEach(([, config], i) => {
      expect(config).toMatchObject({ useNativeDriver: true, isInteraction: false, toValue: plan[i].to });
      // The first pass runs from where the column stands; every step is one cell.
      const cells = Math.round((plan[i].to - plan[i].at) / CELL);
      expect(config.duration).toBeCloseTo((cells * 1000) / plan[i].speed, 6);
      for (const t of [0, 0.13, 0.5, 0.77, 0.999, 1]) expect(config.easing(t) * cells).toBeCloseTo(Math.round(config.easing(t) * cells), 9);
      expect(config.easing(0.999)).toBeLessThan(1);
    });
    // A pass that ends starts the next one whole, from above the field, with new glyphs.
    const before = glyphColumns(tree).map(glyphsOf);
    await act(async () => { jest.advanceTimersByTime(16); });
    expect(timing).toHaveBeenCalledTimes(2 * COLUMNS);
    timing.mock.calls.slice(COLUMNS).forEach(([, config], i) => {
      expect(config.duration).toBeCloseTo((Math.round((plan[i].to - plan[i].from) / CELL) * 1000) / plan[i].speed, 6);
    });
    expect(glyphColumns(tree).map(glyphsOf)).not.toEqual(before);
    // In the background nothing runs; back in front it goes on.
    const change = AppState.addEventListener.mock.calls.filter(([type]) => type === 'change').map(([, fn]) => fn).pop();
    await act(async () => { change('background'); });
    expect(stop).toHaveBeenCalledTimes(COLUMNS);
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(timing).toHaveBeenCalledTimes(2 * COLUMNS);
    await act(async () => { change('active'); });
    expect(timing).toHaveBeenCalledTimes(3 * COLUMNS);
    await act(async () => { tree.unmount(); });
  });

  it('a still frame under the system\'s reduce-motion setting', async () => {
    AccessibilityInfo.isReduceMotionEnabled.mockImplementationOnce(() => Promise.resolve(true));
    const tree = await laidOut(<HexField />);
    await act(async () => {});
    expect(timing).not.toHaveBeenCalled();
    expect(glyphColumns(tree)).toHaveLength(COLUMNS);
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

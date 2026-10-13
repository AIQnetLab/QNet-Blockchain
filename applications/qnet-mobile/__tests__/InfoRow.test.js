/**
 * 11.10: a label with its value is drawn one way on every screen (components/InfoRow). A row keeps both on one line,
 * shrinking a little and following a larger system text size only up to its cap; a figure may shrink further while its
 * label keeps its size, and one too long for that goes under the label whole; a stacked field fits an address on one
 * line, shortens a hash in its middle or wraps a text read whole, and copies on a tap; a setting keeps its title and
 * value on one line. Only start and end sides, so a right-to-left language turns every row. The screens build their
 * rows from it and from nothing else (the hand-built rows of the Node tab, the History detail, the Send forms, the
 * review, the result card, the two sheets and Settings are gone): __tests__/I18nLayout.test.js holds each to one line in
 * every language at 320 dp and at a large text size.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  FIGURE_LINE, FIT_MIN_SCALE, FIT_ROOM, InfoField, InfoRow, LABEL_MIN_SCALE, ROW_FONT_CAP, SettingRow, TONES, figureFits,
  figureFitsIn, infoStyles,
} from '../src/components/InfoRow';
import { makeT } from '../src/i18n';

const t = makeT('en');
const flat = (s) => StyleSheet.flatten(s) || {};
const draw = (el) => {
  let tree;
  act(() => { tree = renderer.create(el); });
  return tree;
};
const textsOf = (tree) => tree.root.findAllByType(Text);
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('a row: the label and its value on one line', () => {
  it('both one line, shrinking to 80% at most, a larger text size counted up to 1.2 times; one element for a screen reader', () => {
    const tree = draw(<InfoRow label="Answered this epoch" value="Not yet" />);
    const [label, value] = textsOf(tree);
    for (const n of [label, value]) {
      expect(n.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: LABEL_MIN_SCALE, maxFontSizeMultiplier: ROW_FONT_CAP });
    }
    expect([label.props.children, value.props.children]).toEqual(['Answered this epoch', 'Not yet']);
    expect([LABEL_MIN_SCALE, ROW_FONT_CAP]).toEqual([0.8, 1.2]);
    // Shrunk to 80% at the cap, a text is no larger than at the normal size with no cap: what fits there fits here.
    expect(LABEL_MIN_SCALE * ROW_FONT_CAP).toBeLessThan(1);
    const row = tree.root.findAll((n) => n.type === View && n.props.accessible === true);
    expect(row).toHaveLength(1);
    expect(flat(row[0].props.style)).toMatchObject({ flexDirection: 'row', justifyContent: 'space-between' });
    // Both give way alike, so neither is cut while the other keeps room it does not need.
    expect([flat(label.props.style).flexShrink, flat(value.props.style).flexShrink]).toEqual([1, 1]);
  });

  it('a value can be selected (a long press copies a block number or an amount), a label not', () => {
    const [label, value] = textsOf(draw(<InfoRow label="Block" value="1234567" ltr fit />));
    expect([label.props.selectable, value.props.selectable]).toEqual([undefined, true]);
    const total = textsOf(draw(<InfoRow label="Total" value={['2.5 1DEV', '+ 0.00204428 SOL']} ltr fit total />));
    expect(total.slice(1).map((n) => n.props.selectable)).toEqual([true, true]);
  });

  it('one type per role: the label grey, the value white or in its tone, a total white and blue', () => {
    const label = flat(textsOf(draw(<InfoRow label="Node" value="Online" tone="ok" />))[0].props.style);
    expect(label).toMatchObject({ color: '#888888', fontSize: 14 });
    expect(TONES).toEqual({ default: '#ffffff', accent: '#00d4ff', ok: '#34c759', warn: '#ff9500', bad: '#ff3b30' });
    for (const tone of Object.keys(TONES)) {
      const value = flat(textsOf(draw(<InfoRow label="Node" value="x" tone={tone} />))[1].props.style);
      expect([tone, value.color, value.fontSize, value.fontWeight]).toEqual([tone, TONES[tone], 15, '600']);
    }
    const [tl, tv] = textsOf(draw(<InfoRow label="Total" value="1.50015 QNC" total />)).map((n) => flat(n.props.style));
    expect([tl.color, tl.fontWeight, tv.color, tv.fontWeight]).toEqual(['#ffffff', '600', TONES.accent, '700']);
  });

  it('a figure shrinks to half its size, its label giving way far less, left to right in every language', () => {
    const [label, value] = textsOf(draw(<InfoRow label="Node balance" value="1234.567891 QNC" tone="accent" ltr fit />));
    expect(value.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: FIT_MIN_SCALE, maxFontSizeMultiplier: ROW_FONT_CAP });
    expect(FIT_MIN_SCALE).toBe(0.5);
    expect(flat(value.props.style).writingDirection).toBe('ltr');
    // Space is taken from each in proportion to its width and its yield (the layout's flex shrink): with the label's at
    // 0.4 of the figure's, the label is at 80% exactly when the figure reaches half its size.
    const yieldRate = flat(label.props.style).flexShrink / flat(value.props.style).flexShrink;
    expect(1 - yieldRate * (1 - FIT_MIN_SCALE)).toBeCloseTo(LABEL_MIN_SCALE, 10);
  });

  it('a total in two currencies: a line for each, in order, at the row\'s end', () => {
    const tree = draw(<InfoRow label="Total" value={['2.5 1DEV', '+ 0.00204428 SOL']} ltr fit total />);
    const texts = textsOf(tree);
    expect(texts.map((n) => n.props.children)).toEqual(['Total', '2.5 1DEV', '+ 0.00204428 SOL']);
    for (const n of texts) expect(n.props.numberOfLines).toBe(1);
    const column = tree.root.findAll((n) => n.type === View && flat(n.props.style).alignItems === 'flex-end');
    expect(column).toHaveLength(1);
  });

  it(`a figure that would not fit beside its label at their smallest goes under it, whole, never cut (${FIT_ROOM} dp at 1.2)`, () => {
    const model = 'Foldable Model 6 Special Edition 5G 512 GB';
    expect(figureFits('Device', model)).toBe(false);
    const tree = draw(<InfoRow label="Device" value={model} ltr fit />);
    expect(tree.root.findAll((n) => n.type === View && n.props.style && flat(n.props.style).flexDirection === 'row')).toHaveLength(0);
    const value = textsOf(tree)[1];
    expect(value.props.children).toBe(model);
    expect(value.props.numberOfLines).toBeUndefined();
    // What fits stays beside its label; a long label leaves a figure less room.
    for (const [label, figure, fits] of [
      ['Device', 'Phone Model 13 Pro+', true], ['Node balance', '1234567.123456 QNC', true],
      ['Neuinhaber-Kaution', '0.01 QNC', true], ['Neuinhaber-Kaution', '123456789012.123456 QNC', false],
      ['新規保有者デポジット', '0.01 QNC', true], ['新規保有者デポジット', '1234567.123456789 QNC', false],
    ]) {
      expect([label, figure, figureFits(label, figure)]).toEqual([label, figure, fits]);
      const shown = textsOf(draw(<InfoRow label={label} value={figure} ltr fit />))[1];
      expect([label, figure, shown.props.numberOfLines === 1]).toEqual([label, figure, fits]);
    }
    // Every line of a total must fit for the total to stay beside its label.
    expect(textsOf(draw(<InfoRow label="Total" value={['2 1DEV', `+ ${'9'.repeat(40)} SOL`]} ltr fit total />)).length).toBe(2);
  });

  it('a figure kept beside something of a screen\'s own fits its box at half its size at the largest text size, or goes under', () => {
    // A token's balance on Assets: two fifths of a 320 dp screen's row (98 dp), 16 points.
    for (const [figure, fits] of [
      ['1234567.891234', true], ['123456789.12345', true], ['••••', true],
      ['0.000000000000000001', false], ['12345.123456789012345678', false],
    ]) expect([figure, figureFitsIn(figure, 98, 16)]).toEqual([figure, fits]);
    expect(FIGURE_LINE).toEqual({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: FIT_MIN_SCALE, maxFontSizeMultiplier: ROW_FONT_CAP });
  });

  it('nothing to show reads as a dash, never as an empty value', () => {
    expect(textsOf(draw(<InfoRow label="Fee" value={null} />))[1].props.children).toBe('—');
    expect(textsOf(draw(<InfoField label="Memo" value="" />))[1].props.children).toBe('—');
  });
});

describe('a field: the label over its value', () => {
  const ADDRESS = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';

  it('an address whole on one line, shrinking to half, in the monospace face, left to right; selectable', () => {
    const value = textsOf(draw(<InfoField label="Wallet" value={ADDRESS} mono fit testID="addr" />))[1];
    expect(value.props).toMatchObject({
      numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5, maxFontSizeMultiplier: 1.2, selectable: true, testID: 'addr',
    });
    expect(value.props.children).toBe(ADDRESS);
    expect(flat(value.props.style)).toMatchObject({ fontSize: 13, writingDirection: 'ltr' });
    expect(flat(value.props.style).fontFamily).toMatch(/mono|courier/i);
  });

  it('a hash shortened in its middle (not selectable, which would undo that), copied whole on a tap', () => {
    const onCopy = jest.fn();
    const hash = 'f'.repeat(64);
    const tree = draw(<InfoField t={t} label="Transaction" value={hash} mono middle onCopy={onCopy} copyTestID="copy" />);
    const value = textsOf(tree)[1];
    expect(value.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle', selectable: false });
    expect(value.props.children).toBe(hash);
    const button = tree.root.findAllByType(TouchableOpacity)[0];
    expect(button.props).toMatchObject({ accessibilityRole: 'button', accessibilityHint: t('common_tap_to_copy'), testID: 'copy' });
    act(() => { button.props.onPress(); });
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(textsOf(draw(<InfoField t={t} label="Transaction" value={hash} mono middle onCopy={onCopy} copied />))[0].props.children)
      .toBe(t('common_copied'));
  });

  it('a text read whole wraps; its label stays one line', () => {
    const [label, value] = textsOf(draw(<InfoField label="Memo" value="order 42 from the shop, paid in full" />));
    expect(label.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.8, maxFontSizeMultiplier: 1.2 });
    expect(value.props.numberOfLines).toBeUndefined();
    expect(flat(value.props.style)).toMatchObject({ color: '#ffffff', fontSize: 15, fontWeight: '600' });
  });

  it('a box of the caller\'s under the label (a recipient to confirm, a call\'s input), the label as every label', () => {
    const tree = draw(<InfoField label="To"><Text testID="box">d9fa 3703 74e2</Text></InfoField>);
    const [label, box] = textsOf(tree);
    expect(label.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.8, maxFontSizeMultiplier: 1.2 });
    expect(flat(label.props.style)).toMatchObject({ color: '#888888', fontSize: 14 });
    expect(box.props.testID).toBe('box');
    expect(textsOf(tree)).toHaveLength(2);
    // The box stays reachable for a screen reader: the field is not one element.
    expect(tree.root.findAll((n) => n.type === View && flat(n.props.style).paddingVertical === 10)[0].props.accessible).toBe(false);
  });
});

describe('a setting: its title and its value on one line', () => {
  it('both one line, shrinking to 80% at most, the larger text size counted up to 1.2 times; a line about it wraps under', () => {
    const onPress = jest.fn();
    const tree = draw(<SettingRow title="Auto-Lock" subtitle="Lock wallet after inactivity" value="15 minutes" onPress={onPress} />);
    const [title, note, value] = textsOf(tree);
    for (const n of [title, value]) {
      expect(n.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: LABEL_MIN_SCALE, maxFontSizeMultiplier: ROW_FONT_CAP });
    }
    expect(note.props.numberOfLines).toBeUndefined();
    expect(flat(title.props.style)).toMatchObject({ color: '#ffffff', fontSize: 16, fontWeight: '600' });
    expect(flat(value.props.style)).toMatchObject({ color: TONES.accent, fontSize: 14, fontWeight: '600' });
    const button = tree.root.findAllByType(TouchableOpacity)[0];
    expect(button.props.accessibilityRole).toBe('button');
    act(() => { button.props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
    // The title takes what the value's box leaves, the box at most half the row.
    expect(flat(infoStyles.settingText).flex).toBe(1);
    expect(flat(infoStyles.settingValueBox)).toMatchObject({ flexShrink: 1, maxWidth: '50%' });
  });

  it('a site\'s host shortened in its middle, its whole origin under it left to right; a setting with no value has no box', () => {
    const [host, origin] = textsOf(draw(
      <SettingRow title="accounts.example.com" host subtitle="https://accounts.example.com" subtitleLines={2} ltrSubtitle value="Disconnect" onPress={() => {}} />,
    ));
    expect(host.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP });
    expect(origin.props.numberOfLines).toBe(2);
    expect(flat(origin.props.style).writingDirection).toBe('ltr');
    const plain = draw(<SettingRow title="Current Network" subtitle="QNet Blockchain testnet" />);
    expect(plain.root.findAllByType(TouchableOpacity)).toHaveLength(0);
    expect(textsOf(plain)).toHaveLength(2);
  });
});

describe('right to left, and the one source of rows', () => {
  it('no style names a left or a right side: a right-to-left screen turns every row', () => {
    for (const [name, style] of Object.entries(infoStyles)) {
      const sided = Object.keys(flat(style)).filter((k) => /Left|Right|^left$|^right$/.test(k));
      expect([name, sided]).toEqual([name, []]);
    }
  });

  it('the screens build their rows from it; the hand-built rows and their styles are gone', () => {
    const uses = {
      'src/screens/NodeTab.js': /import \{ InfoField, InfoRow \} from '\.\.\/components\/InfoRow';/,
      'src/screens/HistoryTab.js': /import \{ InfoField, InfoRow \} from '\.\.\/components\/InfoRow';/,
      'src/screens/QNetLinkScreen.js': /import \{ InfoField, InfoRow \} from '\.\.\/components\/InfoRow';/,
      'src/browser/DappSheet.js': /import \{ InfoField, InfoRow \} from '\.\.\/components\/InfoRow';/,
      'src/components/SendReview.js': /import \{ InfoField, InfoRow \} from '\.\/InfoRow';/,
      'src/screens/SolanaSend.js': /import \{ InfoRow \} from '\.\.\/components\/InfoRow';/,
      'src/screens/WalletScreen.js': /import \{ FIGURE_LINE, InfoRow, SettingRow, figureFitsIn \} from '\.\.\/components\/InfoRow';/,
      'src/components/TxResultCard.js': /import \{ InfoField \} from '\.\/InfoRow';/,
    };
    for (const [file, re] of Object.entries(uses)) expect([file, re.test(read(file))]).toEqual([file, true]);
    expect(read('src/screens/NodeTab.js')).not.toMatch(/const Row =|rewardItem|rewardLabel|rewardValue|nodeMonitoringLabel|nodeMonitoringValue/);
    expect(read('src/screens/HistoryTab.js')).not.toMatch(/function Field\(|txDetailField|txDetailLabel|txDetailValue|txDetailMono/);
    for (const file of ['src/components/SendReview.js', 'src/browser/DappSheet.js', 'src/screens/QNetLinkScreen.js']) {
      expect([file, /const row = |const addressRow = |s\.rowLabel|rowLabel:/.test(read(file))]).toEqual([file, false]);
    }
    for (const file of ['src/screens/WalletScreen.js', 'src/screens/SolanaSend.js']) {
      expect([file, /sendFee|sendTotal|sendBalanceLabel|sendBalanceAmount/.test(read(file))]).toEqual([file, false]);
    }
    expect(read('src/screens/WalletScreen.js')).not.toMatch(/settingItem|settingInfo|settingTitle|settingDropdown|settingValue/);
    expect(read('src/components/TxResultCard.js')).not.toMatch(/shortMiddle|txHashLabel|txHashValue/);
    expect(read('src/components/SendReview.js')).not.toMatch(/toLabel/);
    expect(read('src/browser/DappSheet.js')).not.toMatch(/inputLabel/);
    const styles = require('../src/screens/WalletScreen.styles').default;
    for (const gone of ['rewardItem', 'rewardItemWrap', 'rewardLabel', 'rewardValue', 'nodeMonitoringLabel', 'nodeMonitoringValue',
      'sendFeeContainer', 'sendFeeLabel', 'sendFeeValue', 'sendTotalContainer', 'sendTotalLabel', 'sendTotalValue',
      'txDetailField', 'txDetailLabel', 'txDetailValue', 'txDetailMono', 'sendBalanceLabel', 'sendBalanceAmount', 'settingItem',
      'settingInfo', 'settingTitle', 'settingDropdown', 'settingValue', 'txHashLabel', 'txHashValue']) {
      expect([gone, gone in styles]).toEqual([gone, false]);
    }
  });

  it('the Node tab writes no block count and no glyph: the epoch\'s end in time alone, a ban in words with its reason under it', () => {
    const tab = read('src/screens/NodeTab.js');
    expect(tab).not.toMatch(/node_blocks_|toLocaleString|⚠/);
    expect(tab).toMatch(/t\('node_about', \{ time: /);
    expect(tab).toMatch(/\{banned \? <Text style=\{styles\.rewardHint\}>\{t\('node_banned_hint'\)\}<\/Text> : null\}/);
    const translations = require('../src/i18n/translations').default;
    for (const [lang, table] of Object.entries(translations)) {
      // No label of a row ends in a colon: the row itself sets the label apart.
      const colon = ['node_name', 'node_type', 'node_status_node', 'node_background', 'node_epoch_ends',
        'node_reputation', 'node_balance', 'node_answered', 'node_last_seen', 'node_heartbeats', 'node_missed']
        .filter((k) => /[:：]\s*$/.test(table[k]));
      expect([lang, colon]).toEqual([lang, []]);
      expect([lang, table.node_about.includes('{time}'), table.node_banned_hint.length > 0]).toEqual([lang, true, true]);
    }
  });
});

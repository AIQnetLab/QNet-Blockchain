/**
 * A label with its value, drawn the same way on every screen (owner, 11.10): the Node tab's cards, a send's form,
 * review and result, a site's request sheet, the QNet Link sheet, a transaction's detail and Settings all build their
 * rows from these, in one type per role, so no screen has a style of its own for them.
 *
 * InfoRow: the label at the line's start, the value at its end, on one line. Neither wraps or ends in an ellipsis: the
 * texts fit side by side at full size on a 320 dp screen in every language (__tests__/I18nLayout.test.js), a larger
 * system text size counts up to ROW_FONT_CAP times, and the two shrink together, to no less than 80% of their size,
 * where that is what it takes. A figure (`fit`: an amount) may shrink to half its size, its label giving way far less;
 * one that would not fit beside its label even so (figureFits) goes under it as an InfoField instead, whole. A total in
 * two currencies is a list (`value` an array): one line each, at the row's end. Start and end sides only, so a
 * right-to-left language turns the row.
 *
 * InfoField: the label over its value, for what is too long to share a line. `mono`: an id, an address or a hash, left
 * to right in the monospace face; `fit`: one line that shrinks to half its size (a whole address on a 320 dp screen);
 * `middle`: one line shortened in its middle (a 64-character hash, copied whole); otherwise the value wraps, for a text
 * that must be read whole (a memo). `onCopy`: a tap copies it, and the label says so after. With children in place of
 * a value: the label over a box of the caller's (a recipient to confirm, a call's input).
 *
 * SettingRow: a setting's title and what it is set to, on one line in the same way, the value in a box a tap opens (a
 * picker, or the one thing the row does); a line about the setting under the title wraps. `host`: the title is a site's
 * host, shortened in its middle if it must be (its whole origin is the line under it).
 *
 * A value stays selectable (a long press copies a block number or an amount), except a hash shortened in its middle.
 */
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { tr } from '../i18n';

// The largest system text size a row follows, as the whole addresses elsewhere do: more would only shrink it back.
export const ROW_FONT_CAP = 1.2;
// How far a label and a plain value shrink to share their line: below 1 / ROW_FONT_CAP (about 0.83), so a row that fits
// at the normal text size fits at the cap. A figure may shrink to half its size.
export const LABEL_MIN_SCALE = 0.8;
export const FIT_MIN_SCALE = 0.5;
const LABEL_SIZE = 14;
const VALUE_SIZE = 15;
const GAP = 12;
// A row on the narrowest screen (320 dp: the Node tab's cards leave 246 of it), where a figure and its label must fit at
// their smallest and at the largest text size, or the figure goes under its label.
export const FIT_ROOM = 240;
// Beside a figure the label gives way at this rate of the figure's, so it reaches its smallest just as the figure does.
const LABEL_YIELD = (1 - LABEL_MIN_SCALE) / (1 - FIT_MIN_SCALE);

export const TONES = Object.freeze({
  default: '#ffffff',
  accent: '#00d4ff',
  ok: '#34c759',
  warn: '#ff9500',
  bad: '#ff3b30',
});

const shown = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const line = (min) => ({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: min, maxFontSizeMultiplier: ROW_FONT_CAP });

// About how wide a text is, in em, rather over than under: a wide script a full em, a wide or capital letter more than
// the rest. Only to tell whether a figure can share its line at all; the layout itself measures the rest.
function ems(text) {
  let e = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2066 && c <= 0x2069)) continue;
    if (c >= 0x1f000) e += 1.2;
    else if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)) e += 1;
    else if (/[MWmwЖШЩЮжшщю]/.test(ch)) e += 0.82;
    else if (/[A-ZА-ЯЁ]/.test(ch)) e += 0.7;
    else e += 0.56;
  }
  return e;
}

// How wide a semibold figure of `size` points is at its smallest at the largest text size (its glyphs a twentieth wider).
const figureWidth = (value, size) => ems(String(value)) * size * 1.05 * ROW_FONT_CAP * FIT_MIN_SCALE;

/**
 * Whether the figure `value` fits beside `label` on the narrowest row at the largest text size, both at their smallest;
 * a figure that does not goes under its label.
 */
export function figureFits(label, value) {
  return ems(String(label)) * LABEL_SIZE * ROW_FONT_CAP * LABEL_MIN_SCALE + GAP + figureWidth(value, VALUE_SIZE) <= FIT_ROOM;
}

/**
 * Whether the figure `value`, `size` points, fits a box `room` dp wide at its smallest at the largest text size: a figure
 * kept beside something of a screen's own (a token's balance beside its name) goes under it when it does not.
 */
export function figureFitsIn(value, room, size = VALUE_SIZE) {
  return figureWidth(value, size) <= room;
}

// A figure that shares its line: one line, shrinking to half its size, following a larger text size up to the cap.
export const FIGURE_LINE = Object.freeze(line(FIT_MIN_SCALE));

export function InfoRow({ label, value, tone = 'default', ltr = false, fit = false, total = false, divider = true, testID }) {
  const parts = (Array.isArray(value) ? value : [value]).map(shown);
  if (fit && !parts.every((p) => figureFits(label, p))) {
    return <InfoField label={label} value={parts.join(' ')} tone={total ? 'accent' : tone} ltr={ltr} divider={divider} testID={testID} />;
  }
  const valueStyle = [s.value, { color: TONES[tone] || TONES.default }, total && s.totalValue, ltr && s.ltr];
  const values = parts.map((p, i) => (
    <Text key={i} style={valueStyle} {...line(fit ? FIT_MIN_SCALE : LABEL_MIN_SCALE)} selectable testID={i === 0 ? testID : undefined}>
      {p}
    </Text>
  ));
  return (
    <View style={[s.row, parts.length > 1 && s.rowTop, !divider && s.first]} accessible>
      <Text style={[s.label, fit && s.labelBesideFigure, total && s.totalLabel]} {...line(LABEL_MIN_SCALE)}>{label}</Text>
      {values.length > 1 ? <View style={s.values}>{values}</View> : values[0]}
    </View>
  );
}

export function InfoField({
  label, value, mono = false, fit = false, middle = false, tone = null, ltr = false, onCopy = null, copied = false,
  divider = true, t = tr, testID, copyTestID, children = null,
}) {
  // A shortened hash is not selectable: the system would show it whole only by dropping the shortening.
  const lines = fit ? line(FIT_MIN_SCALE) : (middle ? { numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP } : null);
  const boxed = children !== null && children !== undefined;
  const body = (
    <>
      <Text style={s.label} {...line(LABEL_MIN_SCALE)}>{copied ? t('common_copied') : label}</Text>
      {boxed ? children : (
        <Text
          style={[s.fieldValue, tone && { color: TONES[tone] }, (mono || ltr) && s.ltr, mono && s.mono]}
          selectable={!middle}
          {...lines}
          testID={testID}
        >
          {shown(value)}
        </Text>
      )}
    </>
  );
  const style = [s.field, !divider && s.first];
  // One element for a screen reader, unless the box is one of its own (a scrolled input stays reachable).
  return onCopy ? (
    <TouchableOpacity style={style} onPress={onCopy} accessibilityRole="button" accessibilityHint={t('common_tap_to_copy')} testID={copyTestID}>
      {body}
    </TouchableOpacity>
  ) : <View style={style} accessible={!boxed}>{body}</View>;
}

export function SettingRow({ title, subtitle, value, onPress, host = false, subtitleLines, ltrSubtitle = false, accessibilityLabel, testID }) {
  const titleLines = host ? { numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP } : line(LABEL_MIN_SCALE);
  return (
    <View style={s.setting}>
      <View style={s.settingText}>
        <Text style={s.settingTitle} {...titleLines}>{title}</Text>
        {subtitle ? <Text style={[s.settingNote, ltrSubtitle && s.ltr]} numberOfLines={subtitleLines}>{subtitle}</Text> : null}
      </View>
      {value !== undefined && value !== null ? (
        <TouchableOpacity style={s.settingValueBox} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
          testID={testID}>
          <Text style={s.settingValue} {...line(LABEL_MIN_SCALE)}>{value}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const DIVIDER = 'rgba(255, 255, 255, 0.08)';

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: GAP,
    minHeight: 44,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: DIVIDER,
  },
  // A value of two lines: the label beside the first.
  rowTop: {
    alignItems: 'flex-start',
  },
  // The first line of its card, right under a heading: no rule above it.
  first: {
    borderTopWidth: 0,
  },
  label: {
    flexShrink: 1,
    color: '#888888',
    fontSize: LABEL_SIZE,
  },
  labelBesideFigure: {
    flexShrink: LABEL_YIELD,
  },
  value: {
    flexShrink: 1,
    color: TONES.default,
    fontSize: VALUE_SIZE,
    fontWeight: '600',
    textAlign: 'right',
  },
  values: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  totalLabel: {
    color: '#ffffff',
    fontWeight: '600',
  },
  totalValue: {
    color: TONES.accent,
    fontWeight: '700',
  },
  // Addresses, hashes, amounts and models read left to right in every language.
  ltr: {
    writingDirection: 'ltr',
  },
  field: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: DIVIDER,
  },
  fieldValue: {
    marginTop: 3,
    color: TONES.default,
    fontSize: VALUE_SIZE,
    fontWeight: '600',
  },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 13,
    fontWeight: '400',
    textAlign: 'left',
  },
  // A setting: its title takes what the box of its value leaves (at most half the row).
  setting: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    color: TONES.default,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  settingNote: {
    color: '#888888',
    fontSize: 13,
  },
  settingValueBox: {
    flexShrink: 1,
    maxWidth: '50%',
    marginStart: 10,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: TONES.accent,
  },
  settingValue: {
    color: TONES.accent,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});

export const infoStyles = s;

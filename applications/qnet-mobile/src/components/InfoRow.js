/**
 * A label with its value, drawn the same way on every screen (owner, 11.10): the Node tab, a send's form, review and
 * result, a site's request sheet, the QNet Link sheet, a transaction's detail and Settings all build their rows from
 * these, in one type per role, rows parted by hairlines, no boxes.
 *
 * InfoRow: the label at the line's start, the value at its end, on one line. Neither wraps or ends in an ellipsis: the
 * texts fit side by side at full size on a 320 dp screen in every language (__tests__/I18nLayout.test.js), a larger
 * system text size counts up to ROW_FONT_CAP times, and the two shrink together, to no less than 80% of their size,
 * where that is what it takes. A figure (`fit`: an amount, in the mono face) may shrink to half its size, its label
 * giving way far less; one that would not fit beside its label even so (figureFits) goes under it as an InfoField,
 * whole. A total in two currencies is a list (`value` an array): one line each, at the row's end. Start and end sides
 * only, so a right-to-left language turns the row; a title, note or field value takes its own width at the start edge,
 * as the platforms align a text by its own script (a Latin one would keep to the left in Arabic).
 *
 * InfoField: the label over its value, for what is too long to share a line. `mono`: an id, an address or a hash, left
 * to right in the mono face; `fit`: one line that shrinks to half its size; `middle`: one line shortened in its middle
 * (a 64-character hash, copied whole); otherwise the value wraps. `onCopy`: a tap copies it, and the Copy act at the end
 * of the label line answers Copied. With children in place of a value: the label over a box of the caller's.
 *
 * SettingRow: a setting's title and what it is set to, on one line, the whole row a target that opens a picker or does
 * the row's one thing; the value in Signal at the end, a line about the setting under the title. `host`: the title is a
 * site's host, shortened in its middle if it must be (its whole origin is the line under it).
 *
 * LinkRow: a full-width row that does one thing (Manage tokens, Change password, a recent page, a picker's option): its
 * title, a note under it, a value or an act at its end. A chosen option has a Signal bar at its start.
 *
 * A value stays selectable (a long press copies a block number or an amount), except a hash shortened in its middle.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Action from './ui/Action';
import { tr } from '../i18n';
import { MONO_ADVANCE, color, size, space, themed } from '../theme';

// The largest system text size a row follows, as the whole addresses elsewhere do: more would only shrink it back.
export const ROW_FONT_CAP = 1.2;
// How far a label and a plain value shrink to share their line: below 1 / ROW_FONT_CAP (about 0.83), so a row that fits
// at the normal text size fits at the cap. A figure may shrink to half its size.
export const LABEL_MIN_SCALE = 0.8;
export const FIT_MIN_SCALE = 0.5;
const LABEL_SIZE = 14;
const VALUE_SIZE = 15;
const GAP = 12;
// A row on the narrowest screen (320 dp less the gutters and a group's inset), where a figure and its label must fit
// at their smallest and at the largest text size, or the figure goes under its label.
export const FIT_ROOM = 240;
// Beside a figure the label gives way at this rate of the figure's, so it reaches its smallest just as the figure does.
const LABEL_YIELD = (1 - LABEL_MIN_SCALE) / (1 - FIT_MIN_SCALE);

export const TONES = Object.freeze({
  default: color.paper,
  accent: color.signal,
  ok: color.paper,
  warn: color.ember,
  bad: color.ember,
});

const shown = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const line = (min) => ({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: min, maxFontSizeMultiplier: ROW_FONT_CAP });
const invisible = (c) => (c >= 0x200b && c <= 0x200f) || (c >= 0x2066 && c <= 0x2069);

// About how wide a text in a proportional face is, in em, rather over than under: a wide script a full em, a wide or
// capital letter more than the rest. Only to tell whether a figure can share its line at all.
function ems(text) {
  let e = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (invisible(c)) continue;
    if (c >= 0x1f000) e += 1.2;
    else if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)) e += 1;
    else if (/[MWmwЖШЩЮжшщю]/.test(ch)) e += 0.82;
    else if (/[A-ZА-ЯЁ]/.test(ch)) e += 0.7;
    else e += 0.56;
  }
  return e;
}

// How wide a figure of `size` points is at its smallest at the largest text size: amounts are set in the mono face,
// every glyph one advance wide.
function figureWidth(value, px) {
  let n = 0;
  for (const ch of String(value)) if (!invisible(ch.codePointAt(0))) n += 1;
  return n * MONO_ADVANCE.data * px * ROW_FONT_CAP * FIT_MIN_SCALE;
}

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
export function figureFitsIn(value, room, px = VALUE_SIZE) {
  return figureWidth(value, px) <= room;
}

// A figure that shares its line: one line, shrinking to half its size, following a larger text size up to the cap.
export const FIGURE_LINE = Object.freeze(line(FIT_MIN_SCALE));

export function InfoRow({ label, value, tone = 'default', ltr = false, fit = false, total = false, divider = true, testID }) {
  const parts = (Array.isArray(value) ? value : [value]).map(shown);
  if (fit && !parts.every((p) => figureFits(label, p))) {
    return <InfoField label={label} value={parts.join(' ')} tone={tone} ltr={ltr} figure divider={divider} testID={testID} />;
  }
  const valueStyle = [s.value, fit && s.figure, { color: TONES[tone] || TONES.default }, total && s.totalValue, ltr && s.ltr];
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
  figure = false, divider = true, t = tr, testID, copyTestID, children = null,
}) {
  // A shortened hash is not selectable: the system would show it whole only by dropping the shortening.
  const lines = fit ? line(FIT_MIN_SCALE) : (middle ? { numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP } : null);
  const boxed = children !== null && children !== undefined;
  const labelText = <Text style={[s.label, s.fieldLabel]} {...line(LABEL_MIN_SCALE)}>{label}</Text>;
  const body = (
    <>
      {onCopy ? (
        <View style={s.labelLine}>
          {labelText}
          <Action
            kind="act"
            label={copied ? t('common_copied') : t('common_copy')}
            labels={[t('common_copy'), t('common_copied')]}
            done={copied}
            onPress={onCopy}
            align="end"
            style={s.copy}
          />
        </View>
      ) : labelText}
      {boxed ? children : (
        <Text
          style={[s.fieldValue, figure && s.figure, tone && { color: TONES[tone] }, (mono || ltr || figure) && s.ltr, mono && s.mono]}
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
    <Pressable
      style={({ pressed }) => [style, pressed && s.pressed]}
      onPress={onCopy}
      accessibilityRole="button"
      accessibilityHint={t('common_tap_to_copy')}
      testID={copyTestID}
    >
      {body}
    </Pressable>
  ) : <View style={style} accessible={!boxed}>{body}</View>;
}

export function SettingRow({ title, subtitle, value, onPress, host = false, subtitleLines, ltrSubtitle = false, accessibilityLabel, testID }) {
  const titleLines = host ? { numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP } : line(LABEL_MIN_SCALE);
  const hasValue = value !== undefined && value !== null;
  const content = (
    <>
      <View style={s.settingText}>
        <Text style={s.settingTitle} {...titleLines}>{title}</Text>
        {subtitle ? <Text style={[s.settingNote, ltrSubtitle && s.ltr]} numberOfLines={subtitleLines}>{subtitle}</Text> : null}
      </View>
      {hasValue ? (
        <View style={s.settingValueBox}>
          <Text style={s.settingValue} {...line(LABEL_MIN_SCALE)}>{value}</Text>
        </View>
      ) : null}
    </>
  );
  if (!hasValue || !onPress) return <View style={s.setting}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [s.setting, pressed && s.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

export function LinkRow({
  title, note, value, end = null, onPress, onLongPress, selected = false, tone = 'default', titleLines, noteLines,
  ltrNote = false, middle = false, accessibilityLabel, accessibilityHint, accessibilityRole = 'button', testID,
}) {
  const titleProps = middle ? { numberOfLines: 1, ellipsizeMode: 'middle', maxFontSizeMultiplier: ROW_FONT_CAP } : { numberOfLines: titleLines };
  // A choice row keeps room for the Signal bar at its start, chosen or not, so its title never moves.
  const choice = accessibilityRole === 'radio';
  const content = (
    <>
      {selected ? <View style={s.chosen} /> : null}
      <View style={s.linkText}>
        <Text style={[s.linkTitle, { color: TONES[tone] || TONES.default }]} {...titleProps}>{title}</Text>
        {note ? <Text style={[s.settingNote, ltrNote && s.ltr]} numberOfLines={noteLines} ellipsizeMode={ltrNote ? 'middle' : undefined}>{note}</Text> : null}
      </View>
      {value !== undefined && value !== null ? <Text style={s.linkValue} {...line(LABEL_MIN_SCALE)}>{value}</Text> : null}
      {end}
    </>
  );
  if (!onPress && !onLongPress) return <View style={[s.link, choice && s.choice]} testID={testID}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [s.link, choice && s.choice, pressed && s.pressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

const s = themed((type) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: GAP,
    minHeight: size.rowMin,
    paddingVertical: space.s12,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },
  // A value of two lines: the label beside the first.
  rowTop: {
    alignItems: 'flex-start',
  },
  // The first line of its group, right under a heading: no rule above it.
  first: {
    borderTopWidth: 0,
  },
  label: {
    ...type('note', LABEL_SIZE),
    flexShrink: 1,
    color: color.fog,
  },
  labelBesideFigure: {
    flexShrink: LABEL_YIELD,
  },
  // Its own width at the row's end (space-between), so it ends at the end edge in either direction.
  value: {
    ...type('body', VALUE_SIZE),
    flexShrink: 1,
    color: TONES.default,
  },
  figure: {
    ...type('amount', VALUE_SIZE),
  },
  values: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  totalLabel: {
    ...type('row', LABEL_SIZE),
    color: color.paper,
  },
  totalValue: {
    ...type('amount', VALUE_SIZE),
    color: color.paper,
  },
  // Addresses, hashes, amounts and models read left to right in every language.
  ltr: {
    writingDirection: 'ltr',
  },
  field: {
    paddingVertical: space.s12,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },
  fieldLabel: {
    flexShrink: 1,
  },
  // The label and the Copy act share the line while both fit; otherwise the act takes the next line, at its end.
  labelLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: GAP,
  },
  copy: {
    minHeight: 0,
    marginStart: 'auto',
  },
  fieldValue: {
    ...type('body', VALUE_SIZE),
    marginTop: space.s4,
    color: TONES.default,
    alignSelf: 'flex-start',
  },
  mono: {
    ...type('data', 14),
  },
  pressed: {
    backgroundColor: color.fillPress,
  },
  // A setting: its title takes what its value leaves (at most half the row).
  setting: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: size.row,
    paddingVertical: space.s12,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  settingText: {
    flex: 1,
    alignItems: 'flex-start',
  },
  settingTitle: {
    ...type('row'),
    color: TONES.default,
  },
  settingNote: {
    ...type('note'),
    color: color.fog,
    marginTop: 2,
  },
  settingValueBox: {
    flexShrink: 1,
    maxWidth: '50%',
    marginStart: space.s12,
    alignItems: 'flex-end',
  },
  settingValue: {
    ...type('row'),
    color: TONES.accent,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s12,
    minHeight: size.row,
    paddingVertical: space.s12,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  // Inside the row: a sheet's scrolling body clips anything drawn past its edge.
  choice: {
    paddingStart: space.s12,
  },
  chosen: {
    position: 'absolute',
    start: 0,
    top: space.s12,
    bottom: space.s12,
    width: 2,
    backgroundColor: color.signal,
  },
  linkText: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
  },
  linkTitle: {
    ...type('row'),
  },
  linkValue: {
    ...type('row'),
    flexShrink: 1,
    maxWidth: '50%',
    color: TONES.accent,
  },
}));

export const infoStyles = s;

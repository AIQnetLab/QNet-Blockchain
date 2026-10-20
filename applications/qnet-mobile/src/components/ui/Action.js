/**
 * Every action of the app, in one of six kinds:
 * - solid: the one filled action of a view (Signal fill, Ink label);
 * - secondary: the other way forward beside it (welcome, lock): the same full-width box on a Signal tone with a Signal
 *   border and a Paper label, so it reads as a button;
 * - text: a lesser action, its label underlined by a thin Signal rule;
 * - destructive: the text kind in Ember (an action that cannot be undone is never solid);
 * - act: a short capitalised action inside a line of data (Copy, Scan, Max), underlined;
 * - quiet: an act that leaves or closes (Back, Cancel, Close).
 * Pressing fills (solid), brightens the box (secondary) or thickens the rule; a disabled action is drawn grey, never
 * faded. `labels` lists every label the action may show (Copy / Copied), so it keeps the widest one's width from the
 * start and nothing moves.
 */
import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { color, radius, size, space, themed, tint } from '../../theme';

const TARGET = { top: 8, bottom: 8, left: 8, right: 8 };

function Label({ label, labels, style, center }) {
  const others = (labels || []).filter((l) => l !== label);
  if (!others.length) return <Text style={style}>{label}</Text>;
  // The other labels hold the width at no height and are hidden from screen readers.
  return (
    <View style={[s.labels, center && s.labelsCenter]}>
      <Text style={style}>{label}</Text>
      {others.map((l) => (
        <Text key={l} style={[style, s.held]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{l}</Text>
      ))}
    </View>
  );
}

export default function Action({
  kind = 'solid', label, labels, onPress, onPressIn, onLongPress, disabled = false, busy = false, busyLabel, done = false,
  align = 'start', style, testID, busyTestID, accessibilityLabel, accessibilityHint, hitSlop,
}) {
  const solid = kind === 'solid';
  const second = kind === 'secondary';
  const boxed = solid || second;
  const line = kind === 'act' || kind === 'quiet';
  const shown = busy && busyLabel ? busyLabel : label;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      hitSlop={hitSlop || (boxed ? undefined : TARGET)}
      style={({ pressed }) => [
        boxed ? s.solid : s.plain,
        second && s.second,
        !boxed && (align === 'center' ? s.center : (align === 'end' ? s.end : s.start)),
        solid && pressed && s.solidPressed,
        second && pressed && s.secondPressed,
        solid && disabled && s.solidDisabled,
        second && disabled && s.secondDisabled,
        style,
      ]}
    >
      {({ pressed }) => {
        const labelStyle = [
          solid ? s.solidLabel : (second ? s.secondLabel : (line ? s.actLabel : s.textLabel)),
          kind === 'quiet' && s.quietLabel,
          kind === 'destructive' && s.emberLabel,
          done && s.doneLabel,
          disabled && (solid ? s.solidLabelDisabled : s.labelDisabled),
        ];
        const body = (
          <>
            {busy ? <ActivityIndicator size="small" color={solid ? color.ink : color.paper} style={s.spinner} testID={busyTestID} /> : null}
            <Label label={shown} labels={busy ? null : labels} style={labelStyle} center={boxed || align === 'center'} />
          </>
        );
        if (boxed) return body;
        return (
          <View
            style={[
              s.rule,
              line ? s.ruleAct : s.ruleText,
              kind === 'quiet' && s.ruleQuiet,
              kind === 'destructive' && s.ruleEmber,
              pressed && (kind === 'destructive' ? s.rulePressedEmber : s.rulePressed),
              done && s.ruleDone,
              disabled && s.ruleDisabled,
            ]}
          >
            {body}
          </View>
        );
      }}
    </Pressable>
  );
}

/**
 * Actions side by side while their labels fit, each at least two fifths of the row and sharing what is left; a label
 * too long for that takes a row of its own rather than break a word. Every row of answers is drawn by it: a pair, an
 * alert's answers, a request's answers.
 */
export function ActionRow({ children, style }) {
  return (
    <View style={[s.row, style]}>
      {React.Children.map(children, (child) => (child ? <View style={s.share}>{child}</View> : null))}
    </View>
  );
}

/** The answers of a request (a site's sheet, the QNet Link sheet): the solid one (`primary`) and text ones. */
export function Answers({ children, style }) {
  return <ActionRow style={[s.answers, style]}>{children}</ActionRow>;
}
export function Answer({ primary = false, ...props }) {
  return <Action kind={primary ? 'solid' : 'text'} align="center" {...props} />;
}

/** A choice of two: the way out (text) first, the action (solid) after it, on one row while both fit. */
export function ActionPair({ start, end, style }) {
  return (
    <ActionRow style={style}>
      <Action kind="text" align="center" {...start} />
      <Action kind="solid" {...end} style={[s.shareSolid, end && end.style]} />
    </ActionRow>
  );
}

const s = themed((type) => ({
  solid: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: size.button,
    paddingHorizontal: space.s12,
    paddingVertical: space.s8,
    borderRadius: radius.box,
    backgroundColor: color.signal,
  },
  solidPressed: { backgroundColor: color.paper },
  solidDisabled: { backgroundColor: color.fillDisabled },
  solidLabel: { ...type('button'), color: color.ink, textAlign: 'center', flexShrink: 1 },
  solidLabelDisabled: { color: color.fog },
  second: { backgroundColor: color.fillPress, borderWidth: 1, borderColor: color.signalLine },
  secondPressed: { backgroundColor: tint(color.signal, 0.14), borderColor: color.signal },
  secondDisabled: { backgroundColor: color.fillDisabled, borderColor: color.ruleStrong },
  secondLabel: { ...type('button'), color: color.paper, textAlign: 'center', flexShrink: 1 },
  plain: { minHeight: size.rowMin, justifyContent: 'center', maxWidth: '100%' },
  start: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  center: { alignSelf: 'stretch', alignItems: 'center' },
  end: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  // The label's underline: as wide as the label, which wraps inside the column rather than run past it.
  rule: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, borderBottomWidth: 1, borderBottomColor: color.signalLine },
  ruleText: { paddingBottom: 3 },
  ruleAct: { paddingBottom: 2 },
  ruleQuiet: { borderBottomColor: color.ruleStrong },
  ruleEmber: { borderBottomColor: color.ember },
  rulePressed: { borderBottomWidth: 2, borderBottomColor: color.signal, marginBottom: -1 },
  rulePressedEmber: { borderBottomWidth: 2, borderBottomColor: color.ember, marginBottom: -1 },
  ruleDone: { borderBottomColor: color.clear },
  ruleDisabled: { borderBottomColor: color.ruleStrong },
  textLabel: { ...type('button'), color: color.paper, flexShrink: 1 },
  actLabel: { ...type('act'), color: color.signal, flexShrink: 1 },
  quietLabel: { color: color.paper70 },
  emberLabel: { color: color.ember },
  doneLabel: { color: color.paper },
  labelDisabled: { color: color.fog },
  labels: { alignItems: 'flex-start' },
  labelsCenter: { alignItems: 'center' },
  held: { height: 0, opacity: 0 },
  spinner: { marginEnd: space.s8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.s12, rowGap: space.s8, alignSelf: 'stretch' },
  share: { flexGrow: 1, flexShrink: 1, minWidth: '40%' },
  shareSolid: { alignSelf: 'stretch' },
  answers: { marginTop: space.s16 },
}));

export const actionStyles = s;

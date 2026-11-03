/**
 * Every action of the app, in one of six kinds:
 * - solid: the one filled action of a view (Signal fill, Ink label);
 * - secondary: the other way forward beside it (welcome, lock): the same full-width box on a Signal tone with a Signal
 *   border and a Paper label, so it reads as a button;
 * - text: a lesser action standing on its own (Receive, Cancel), the same box drawn by its outline, Paper label;
 * - destructive: the text kind in Ember (an action that cannot be undone is never solid);
 * - quiet: a small act in a bar, a head or a card (Back, More, Done, Close, Forgot?): its word alone in Signal, no
 *   outline, on a target of 44 by 44 at least, on the centre line of the row it stands in;
 * - act: a short capitalised action inside a line of data (Scan, Max), underlined.
 * The four box kinds are pills. Pressing fills (solid), brightens the box (secondary, the outlined kinds), brightens the
 * word (quiet) or thickens the rule, and a pill settles softly under the finger (ui/Press); a disabled action is drawn
 * grey, never faded. `align` places the outlined kinds and act on their line (start, end; center stretches an outlined
 * box); a quiet act takes the place its row gives it, and `center` centres it in a column. `done`: an outlined action
 * whose copy just landed (ui/SecretCopy) turns Signal, its box and its word, as every copied value says Copied.
 */
import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Press from './Press';
import { plainAmp } from './amp';
import { color, radius, size, space, themed, tint } from '../../theme';

const TARGET = { top: 8, bottom: 8, left: 8, right: 8 };

export default function Action({
  kind = 'solid', label, onPress, onPressIn, onLongPress, disabled = false, busy = false, busyLabel, done = false,
  align = 'start', style, testID, busyTestID, accessibilityLabel, accessibilityHint, hitSlop,
}) {
  const solid = kind === 'solid';
  const second = kind === 'secondary';
  const ember = kind === 'destructive';
  const outline = kind === 'text' || ember;
  const quiet = kind === 'quiet';
  const pill = solid || second || outline;
  const copied = done && outline && !ember;
  const shown = busy && busyLabel ? busyLabel : label;
  return (
    <Press
      scale={pill}
      onPress={onPress}
      onPressIn={onPressIn}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      hitSlop={hitSlop || (pill || quiet ? undefined : TARGET)}
      style={({ pressed }) => [
        pill ? s.solid : (quiet ? s.quiet : s.plain),
        second && s.second,
        outline && s.outline,
        ember && s.outlineEmber,
        outline && align !== 'center' && (align === 'end' ? s.selfEnd : s.selfStart),
        quiet && align === 'center' && s.selfCenter,
        !pill && !quiet && (align === 'center' ? s.center : (align === 'end' ? s.end : s.start)),
        copied && s.outlineDone,
        solid && pressed && s.solidPressed,
        second && pressed && s.secondPressed,
        outline && pressed && (ember ? s.outlineEmberPressed : s.outlinePressed),
        solid && disabled && s.solidDisabled,
        second && disabled && s.secondDisabled,
        outline && disabled && s.outlineDisabled,
        style,
      ]}
    >
      {({ pressed }) => {
        const labelStyle = [
          solid ? s.solidLabel : (quiet ? s.quietLabel : (pill ? s.secondLabel : s.actLabel)),
          ember && s.emberLabel,
          copied && s.doneLabel,
          quiet && pressed && s.quietPressed,
          disabled && (solid ? s.solidLabelDisabled : s.labelDisabled),
        ];
        const body = (
          <>
            {busy ? <ActivityIndicator size="small" color={solid ? color.ink : color.paper} style={s.spinner} testID={busyTestID} /> : null}
            <Text style={labelStyle}>{pill || quiet ? plainAmp(shown, 'semibold') : shown}</Text>
          </>
        );
        if (pill || quiet) return body;
        return (
          <View style={[s.rule, pressed && s.rulePressed, disabled && s.ruleDisabled]}>
            {body}
          </View>
        );
      }}
    </Press>
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
    borderRadius: radius.pill,
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
  // The outlined kinds: the solid action's box with no fill, drawn by an Edge outline (Ember for what cannot be undone).
  outline: { backgroundColor: color.clear, borderWidth: 1, borderColor: color.edge },
  outlineEmber: { borderColor: color.ember },
  outlinePressed: { backgroundColor: color.fillPress, borderColor: color.paper },
  outlineEmberPressed: { backgroundColor: tint(color.ember, 0.1), borderColor: color.ember },
  outlineDisabled: { backgroundColor: color.clear, borderColor: color.ruleStrong },
  // A copy that landed: the box and the word in Signal, as a copied value's Copied (ui/Copyable).
  outlineDone: { backgroundColor: color.fillPress, borderColor: color.signalLine },
  doneLabel: { color: color.signal },
  // A small act: the word on a 44 dp target and no box, so it never sits off its row's centre line as a drawn box would;
  // narrow enough that the browser's bar keeps its address room at 320 dp with Back and More beside it.
  quiet: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '100%', minHeight: size.rowMin,
    minWidth: size.rowMin, paddingHorizontal: space.s4,
  },
  quietLabel: { ...type('button', 14), color: color.signal, textAlign: 'center', flexShrink: 1 },
  quietPressed: { color: color.paper },
  selfStart: { alignSelf: 'flex-start' },
  selfEnd: { alignSelf: 'flex-end' },
  selfCenter: { alignSelf: 'center' },
  plain: { minHeight: size.rowMin, justifyContent: 'center', maxWidth: '100%' },
  start: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  center: { alignSelf: 'stretch', alignItems: 'center' },
  end: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  // The act's underline: as wide as the label, which wraps inside the column rather than run past it.
  rule: {
    flexDirection: 'row', alignItems: 'center', flexShrink: 1, paddingBottom: 2, borderBottomWidth: 1,
    borderBottomColor: color.signalLine,
  },
  rulePressed: { borderBottomWidth: 2, borderBottomColor: color.signal, marginBottom: -1 },
  ruleDisabled: { borderBottomColor: color.ruleStrong },
  actLabel: { ...type('act'), color: color.signal, flexShrink: 1 },
  emberLabel: { color: color.ember },
  labelDisabled: { color: color.fog },
  spinner: { marginEnd: space.s8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.s12, rowGap: space.s8, alignSelf: 'stretch' },
  share: { flexGrow: 1, flexShrink: 1, minWidth: '40%' },
  shareSolid: { alignSelf: 'stretch' },
  answers: { marginTop: space.s16 },
}));

export const actionStyles = s;

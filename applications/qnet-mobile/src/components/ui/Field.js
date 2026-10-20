/**
 * An input with its label above it and its error line under it. The field is the one filled box a form has: a faint
 * fill and an Edge border, Signal while focused, Ember while what it holds is refused. `end` puts an act at the end of
 * the label's line (Scan on a recipient), as a copyable value carries Copy: the field keeps its whole width for the
 * text and its placeholder, whatever the act's word is in each language. Every TextInput prop passes through.
 */
import React, { forwardRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { color, radius, size, space, themed } from '../../theme';

const Field = forwardRef(function Field({
  label, error, invalid = false, end = null, multiline = false, style, inputStyle, onFocus, onBlur, labelTestID, ...input
}, ref) {
  const [focused, setFocused] = useState(false);
  const refused = invalid || !!error;
  return (
    <View style={[s.group, style]}>
      {end ? (
        <View style={s.labelLine}>
          <Text style={[s.label, s.labelBeside]} testID={labelTestID}>{label || ''}</Text>
          {end}
        </View>
      ) : null}
      {!end && label ? <Text style={s.label} testID={labelTestID}>{label}</Text> : null}
      <View>
        <TextInput
          ref={ref}
          placeholderTextColor={color.fog}
          selectionColor={color.signal}
          multiline={multiline}
          {...input}
          onFocus={(e) => { setFocused(true); if (onFocus) onFocus(e); }}
          onBlur={(e) => { setFocused(false); if (onBlur) onBlur(e); }}
          style={[s.input, multiline && s.multiline, focused && s.focused, refused && s.refused, inputStyle]}
        />
      </View>
      {typeof error === 'string' && error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
});

export default Field;

const s = themed((type) => ({
  group: { alignSelf: 'stretch', marginBottom: space.s16 },
  label: { ...type('label'), color: color.fog, marginBottom: space.s8 },
  input: {
    ...type('field'),
    color: color.paper,
    minHeight: size.field,
    paddingVertical: space.s12,
    paddingHorizontal: 14,
    backgroundColor: color.fillField,
    borderWidth: 1,
    borderColor: color.edge,
    borderRadius: radius.box,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  focused: { backgroundColor: color.fillFieldFocus, borderColor: color.signal },
  refused: { borderColor: color.ember },
  // The label at the start of its line, the act at its end, both over the field's start and end edges.
  labelLine: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', columnGap: space.s12 },
  labelBeside: { flexShrink: 1, marginBottom: space.s8 },
  error: { ...type('note'), color: color.ember, marginTop: space.s8 },
}));

export const fieldStyles = s;

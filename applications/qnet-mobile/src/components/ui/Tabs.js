/**
 * Underlined tabs over a strong rule: the chosen one in Paper with a Signal line over the rule, the others in Fog. The
 * row scrolls sideways when the tabs do not fit (a token switch). `role="radio"` makes the same row a choice. With one
 * item only nothing is drawn: there is nothing to choose. An item's `icon` (a token's) stands before its label.
 */
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { color, space, themed } from '../../theme';

export default function Tabs({ items, value, onChange, role = 'tab', scroll = false, style, testIDPrefix }) {
  if (!items || items.length < 2) return null;
  const cells = items.map((item) => {
    const selected = item.key === value;
    return (
      <Pressable
        key={item.key}
        onPress={() => onChange(item.key)}
        accessibilityRole={role}
        accessibilityLabel={item.accessibilityLabel}
        accessibilityState={role === 'radio' ? { checked: selected } : { selected }}
        testID={item.testID || (testIDPrefix ? `${testIDPrefix}-${item.key}` : undefined)}
        style={[s.tab, selected && s.tabOn]}
      >
        <View style={s.cell}>
          {item.icon || null}
          <Text style={[s.label, selected && s.labelOn, item.tone === 'warn' && s.labelWarn]} numberOfLines={role === 'radio' ? 2 : 1}>
            {item.label}
          </Text>
        </View>
      </Pressable>
    );
  });
  return (
    <View style={[s.bar, style]} accessibilityRole={role === 'radio' ? 'radiogroup' : 'tablist'}>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>{cells}</ScrollView>
      ) : <View style={[s.row, role === 'radio' && s.wrap]}>{cells}</View>}
    </View>
  );
}

const s = themed((type) => ({
  bar: { alignSelf: 'stretch', borderBottomWidth: 1, borderBottomColor: color.ruleStrong, marginBottom: space.s16 },
  row: { flexDirection: 'row', columnGap: space.s24 },
  wrap: { flexWrap: 'wrap' },
  tab: { paddingVertical: space.s12, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: color.clear, flexShrink: 1 },
  tabOn: { borderBottomColor: color.signal },
  // A token tab: its icon (item.icon) before its symbol.
  cell: { flexDirection: 'row', alignItems: 'center', columnGap: space.s8, flexShrink: 1 },
  label: { ...type('row', 15), color: color.fog },
  labelOn: { color: color.paper },
  labelWarn: { color: color.ember },
}));

export const tabStyles = s;

/**
 * The wallet's bottom bar: Assets, History, Browser, Node, Settings, each its name alone. The current tab's name is in
 * Paper with a Signal line along the top of its cell; every cell is its name alone (the node's live state is drawn in
 * the Node tab itself). Safe-area aware (gesture bar, home indicator), one name line that shrinks rather than wraps, and
 * a row that stays centred on tablets.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, size, themed } from '../theme';

export const BOTTOM_TABS = Object.freeze(['assets', 'history', 'browser', 'node', 'settings']);

/**
 * @param {{ active: string, onSelect: (tab: string) => void, t: (key: string) => string, hidden?: boolean }} props
 * `active` is the tab to light ('receive' lights Assets, where it lives).
 */
export default function BottomBar({ active, onSelect, t, hidden = false, onLayout }) {
  if (hidden) return null;
  const lit = active === 'receive' ? 'assets' : active;
  return (
    // The bottom inset (gesture bar, home indicator) comes from the SafeAreaProvider at the app's root (App.tsx).
    <SafeAreaView edges={['bottom']} style={s.bar} onLayout={onLayout} accessibilityRole="tablist">
      <View style={s.row}>
        {BOTTOM_TABS.map((tab) => {
          const selected = lit === tab;
          const label = t(`tab_${tab}`);
          return (
            <Pressable
              key={tab}
              testID={`tab-${tab}`}
              style={({ pressed }) => [s.item, pressed && s.pressed]}
              onPress={() => onSelect(tab)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              hitSlop={{ top: 4, bottom: 4 }}
            >
              <View style={[s.mark, selected && s.markOn]} testID={selected ? 'tab-current' : undefined} />
              <View style={s.name}>
                <Text style={[s.label, selected && s.labelOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                  {label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = themed((type) => ({
  bar: {
    backgroundColor: color.ink,
    borderTopWidth: 1,
    borderTopColor: color.ruleStrong,
  },
  row: { flexDirection: 'row', width: '100%', maxWidth: size.bar, alignSelf: 'center' },
  item: { flex: 1, minWidth: 0, alignItems: 'center', minHeight: size.tab },
  pressed: { backgroundColor: color.fillPress },
  mark: { width: '72%', height: 2, marginTop: -1, backgroundColor: color.clear },
  markOn: { backgroundColor: color.signal },
  name: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, maxWidth: '100%' },
  label: { ...type('tab'), color: color.paper70, flexShrink: 1 },
  labelOn: { color: color.paper },
}));

export const barStyles = s;

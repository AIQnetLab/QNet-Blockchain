/**
 * The wallet's bottom bar: Assets, History, Browser, Node, Settings, each its line icon over its name. The current tab's
 * icon is in Signal and its name in Paper, with a Signal line along the top of its cell; the others' icons
 * in Fog. The node's live state is drawn in the Node tab itself. Safe-area aware (gesture bar, home indicator), one name
 * line that shrinks rather than wraps, and a row that stays centred on tablets.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { color, size, themed } from '../theme';

export const BOTTOM_TABS = Object.freeze(['assets', 'history', 'browser', 'node', 'settings']);

// Each tab's icon on a 24 grid, outlines only, drawn in one stroke weight: a wallet, a clock, a globe, a server, a gear.
const ICONS = Object.freeze({
  assets: [
    'M6 6.5h12a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17V9A2.5 2.5 0 0 1 6 6.5Z',
    'M5.5 6.5l9.2-2.6a1.6 1.6 0 0 1 2 1.5v1.1',
    'M20.5 11H17a2 2 0 0 0 0 4h3.5',
  ],
  history: [
    'M20.5 12a8.5 8.5 0 1 1-17 0a8.5 8.5 0 1 1 17 0Z',
    'M12 7.5V12l3 2',
  ],
  browser: [
    'M20.5 12a8.5 8.5 0 1 1-17 0a8.5 8.5 0 1 1 17 0Z',
    'M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z',
    'M3.5 12h17',
  ],
  node: [
    'M5.5 4h13A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 9.5v-4A1.5 1.5 0 0 1 5.5 4Z',
    'M5.5 13h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4A1.5 1.5 0 0 1 5.5 13Z',
    'M7.8 7.5a.3.3 0 1 1-.6 0a.3.3 0 1 1 .6 0Z',
    'M7.8 16.5a.3.3 0 1 1-.6 0a.3.3 0 1 1 .6 0Z',
  ],
  settings: [
    'M10.14 5.05L10.61 2.7L13.39 2.7L13.86 5.05L15.6 5.76L17.59 4.44L19.56 6.41L18.24 8.4L18.95 10.14L21.3 10.61'
      + 'L21.3 13.39L18.95 13.86L18.24 15.6L19.56 17.59L17.59 19.56L15.6 18.24L13.86 18.95L13.39 21.3L10.61 21.3'
      + 'L10.14 18.95L8.4 18.24L6.41 19.56L4.44 17.59L5.76 15.6L5.05 13.86L2.7 13.39L2.7 10.61L5.05 10.14L5.76 8.4'
      + 'L4.44 6.41L6.41 4.44L8.4 5.76Z',
    'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0Z',
  ],
});
export const TAB_ICON = 22;
export const TAB_STROKE = 1.6;

/** A tab's icon at TAB_ICON dp in `tone`. */
export function TabIcon({ tab, tone }) {
  return (
    <Svg width={TAB_ICON} height={TAB_ICON} viewBox="0 0 24 24" fill="none" testID={`tab-icon-${tab}`}>
      {(ICONS[tab] || []).map((d) => (
        <Path key={d} d={d} stroke={tone} strokeWidth={TAB_STROKE} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

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
              <View style={s.icon}>
                <TabIcon tab={tab} tone={selected ? color.signal : color.fog} />
              </View>
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
  icon: { marginTop: 6, height: TAB_ICON, alignItems: 'center', justifyContent: 'center' },
  name: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, paddingTop: 3, paddingBottom: 6,
    maxWidth: '100%',
  },
  label: { ...type('tab'), color: color.paper70, flexShrink: 1 },
  labelOn: { color: color.paper },
}));

export const barStyles = s;

/**
 * The wallet's bottom bar: Assets, History, Browser, Node, Settings, each with its own drawn icon (react-native-
 * svg, the app's colours). The active tab lights its icon and label and carries a short bar over the icon.
 * Safe-area aware (gesture bar and home indicator), one label line that shrinks rather than wraps, and a row
 * that stays centred on tablets.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

export const BOTTOM_TABS = Object.freeze(['assets', 'history', 'browser', 'node', 'settings']);

const ACTIVE = '#00d4ff';
const IDLE = '#7d8799';

const common = (color) => ({
  stroke: color, strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round',
});

function WalletIcon({ color }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Path d="M4 7.5h14.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 17.5V6.5A2.5 2.5 0 0 1 5.5 4H16" {...common(color)} />
      <Rect x={14.5} y={11.5} width={6} height={4} rx={1.5} {...common(color)} />
      <Circle cx={17} cy={13.5} r={0.6} fill={color} />
    </Svg>
  );
}

function ClockIcon({ color }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={8.5} {...common(color)} />
      <Path d="M12 7.5V12l3 2" {...common(color)} />
    </Svg>
  );
}

function GlobeIcon({ color }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={8.5} {...common(color)} />
      <Path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z" {...common(color)} />
    </Svg>
  );
}

// A hexagon with its centre joined to three corners: the node and its links.
function NodeIcon({ color }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" {...common(color)} />
      <Path d="M12 12V3M12 12l7.8 4.5M12 12l-7.8 4.5" {...common(color)} strokeWidth={1.4} />
      <Circle cx={12} cy={12} r={2} fill={color} />
    </Svg>
  );
}

// Eight equal teeth on one centre (12, 12): outer radius 9.3, root radius 7.1, each tooth 18° wide at its tip; the hub
// is a circle of radius 3. Same 24 box and stroke as the other icons.
export const GEAR_PATH = 'M10.22 5.13L10.55 2.81A9.3 9.3 0 0 1 13.45 2.81L13.78 5.13A7.1 7.1 0 0 1 15.6 5.88L17.47 4.48'
  + 'A9.3 9.3 0 0 1 19.52 6.53L18.12 8.4A7.1 7.1 0 0 1 18.87 10.22L21.19 10.55A9.3 9.3 0 0 1 21.19 13.45L18.87 13.78'
  + 'A7.1 7.1 0 0 1 18.12 15.6L19.52 17.47A9.3 9.3 0 0 1 17.47 19.52L15.6 18.12A7.1 7.1 0 0 1 13.78 18.87L13.45 21.19'
  + 'A9.3 9.3 0 0 1 10.55 21.19L10.22 18.87A7.1 7.1 0 0 1 8.4 18.12L6.53 19.52A9.3 9.3 0 0 1 4.48 17.47L5.88 15.6'
  + 'A7.1 7.1 0 0 1 5.13 13.78L2.81 13.45A9.3 9.3 0 0 1 2.81 10.55L5.13 10.22A7.1 7.1 0 0 1 5.88 8.4L4.48 6.53'
  + 'A9.3 9.3 0 0 1 6.53 4.48L8.4 5.88A7.1 7.1 0 0 1 10.22 5.13Z';

function GearIcon({ color }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Path d={GEAR_PATH} {...common(color)} />
      <Circle cx={12} cy={12} r={3} {...common(color)} />
    </Svg>
  );
}

const ICONS = { assets: WalletIcon, history: ClockIcon, browser: GlobeIcon, node: NodeIcon, settings: GearIcon };

/**
 * @param {{ active: string, onSelect: (tab: string) => void, t: (key: string) => string, hidden?: boolean }} props
 * `active` is the tab to light ('receive' lights Assets, where it lives).
 */
export default function BottomBar({ active, onSelect, t, hidden = false, onLayout }) {
  if (hidden) return null;
  const lit = active === 'receive' ? 'assets' : active;
  return (
    // The bottom inset (gesture bar, home indicator) is added natively; no provider needed.
    <SafeAreaView edges={['bottom']} style={s.bar} onLayout={onLayout} accessibilityRole="tablist">
      <View style={s.row}>
        {BOTTOM_TABS.map((tab) => {
          const selected = lit === tab;
          const color = selected ? ACTIVE : IDLE;
          const Icon = ICONS[tab];
          const label = t(`tab_${tab}`);
          return (
            <TouchableOpacity
              key={tab}
              testID={`tab-${tab}`}
              style={s.item}
              onPress={() => onSelect(tab)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              hitSlop={{ top: 4, bottom: 4 }}
              activeOpacity={0.7}
            >
              <View style={[s.mark, selected && s.markOn]} />
              <Icon color={color} />
              <Text style={[s.label, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: '#16213e',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0, 212, 255, 0.45)',
  },
  row: { flexDirection: 'row', width: '100%', maxWidth: 600, alignSelf: 'center' },
  item: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingTop: 2, paddingBottom: 5, minHeight: 54 },
  mark: { width: 22, height: 3, borderRadius: 2, marginBottom: 5, backgroundColor: 'transparent' },
  markOn: { backgroundColor: ACTIVE },
  label: { fontSize: 11, fontWeight: '600', marginTop: 2, paddingHorizontal: 2, includeFontPadding: false },
});

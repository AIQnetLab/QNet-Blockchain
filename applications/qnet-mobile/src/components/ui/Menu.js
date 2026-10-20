/**
 * A More menu: a scrim that closes it, and a card at the end edge under the bar its More is on (`top`). An item is a row
 * that does one thing (`onPress`, in Ember with `warn`: what cannot be undone) or a setting with its switch (`toggle`:
 * { value, onValueChange }); `divider` rules it off from the item before. `level`: 'root' over the whole wallet screen
 * (theme.layer), 'pane' inside the pane it belongs to (the browser).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Toggle } from './Toggle';
import { color, layer, shadow, space, themed } from '../../theme';

export default function Menu({ items, onClose, closeLabel, top, level = 'root' }) {
  const pane = level === 'pane';
  return (
    <>
      <Pressable style={[s.backdrop, pane ? s.backdropPane : s.backdropRoot]} onPress={onClose} accessibilityLabel={closeLabel} />
      <View style={[s.card, pane ? s.cardPane : s.cardRoot, { top }]}>
        {items.map((item) => (
          <React.Fragment key={item.label}>
            {item.divider ? <View style={s.divider} /> : null}
            {item.toggle ? (
              <View style={s.item}>
                <Text style={s.text}>{item.label}</Text>
                <Toggle value={item.toggle.value} onValueChange={item.toggle.onValueChange} accessibilityLabel={item.label} />
              </View>
            ) : (
              <Pressable style={({ pressed }) => [s.item, pressed && s.pressed]} onPress={item.onPress} accessibilityRole="button">
                <Text style={[s.text, item.warn && s.warn]}>{item.label}</Text>
              </Pressable>
            )}
          </React.Fragment>
        ))}
      </View>
    </>
  );
}

const s = themed((type) => ({
  backdrop: { ...StyleSheet.absoluteFillObject },
  // Drawn in the order it is touched (theme.layer).
  backdropRoot: { ...layer.menuScrim },
  backdropPane: { zIndex: 50 },
  card: {
    position: 'absolute', end: space.s8, minWidth: 220, maxWidth: '90%', backgroundColor: color.surface, borderWidth: 1,
    borderColor: color.rule, paddingVertical: space.s4, ...shadow,
  },
  cardRoot: { ...layer.menu },
  cardPane: { zIndex: 51, elevation: 12 },
  item: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: space.s24, minHeight: 48,
    paddingHorizontal: space.gut,
  },
  text: { ...type('row', 15), flexShrink: 1, color: color.paper },
  warn: { color: color.ember },
  pressed: { backgroundColor: color.fillPress },
  divider: { height: 1, backgroundColor: color.rule },
}));

export const menuStyles = s;

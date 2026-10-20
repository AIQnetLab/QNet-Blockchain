/**
 * An on/off switch and a checkbox, both square-cornered. The switch's knob slides in 150 ms (transform only); off is
 * an Edge outline, on a Signal track with an Ink knob. The checkbox is an Edge square, Signal with an Ink tick when ticked.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, I18nManager, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, motion, radius, themed } from '../../theme';

const TRAVEL = 18;

export function Toggle({ value, onValueChange, accessibilityLabel, testID, disabled = false }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  // The knob starts at the start edge, so on slides it toward the end: leftwards in a right-to-left layout.
  const travel = I18nManager.isRTL ? -TRAVEL : TRAVEL;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0, duration: motion.toggle, easing: Easing.bezier(...motion.curve), useNativeDriver: true,
    }).start();
  }, [value, anim]);
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: !!value, disabled }}
      hitSlop={8}
      testID={testID}
    >
      <View style={[s.track, value && s.trackOn]}>
        <Animated.View
          style={[s.knob, value && s.knobOn, { transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }] }]}
        />
      </View>
    </Pressable>
  );
}

export function Checkbox({ checked, onPress, accessibilityLabel, testID }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: !!checked }}
      hitSlop={10}
      testID={testID}
      style={[s.box, checked && s.boxOn]}
    >
      {checked ? (
        <Svg width={14} height={14} viewBox="0 0 14 14"><Path d="M2.5 7.2l3 3 6-6.4" stroke={color.ink} strokeWidth={2} fill="none" /></Svg>
      ) : null}
    </Pressable>
  );
}

const s = themed(() => ({
  track: {
    width: 40, height: 22, padding: 3, borderRadius: radius.box, borderWidth: 1, borderColor: color.edge,
    justifyContent: 'center',
  },
  trackOn: { backgroundColor: color.signal, borderColor: color.signal },
  knob: { width: 14, height: 14, borderRadius: radius.box, backgroundColor: color.edge },
  knobOn: { backgroundColor: color.ink },
  box: {
    width: 22, height: 22, borderRadius: radius.box, borderWidth: 1, borderColor: color.edge,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: color.signal, borderColor: color.signal },
}));

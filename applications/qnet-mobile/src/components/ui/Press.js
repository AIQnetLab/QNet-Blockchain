/**
 * The one press of the app's buttons and cards: a Pressable that answers softly, settling a little smaller and dimmer
 * while held and back on release, in motion.press on the native driver (transform and opacity only). With the system's
 * reduce-motion setting on it only dims. `style` may be a function of { pressed }, as a Pressable's; `scale` false keeps
 * the size (a text action). Every Pressable prop passes through.
 */
import React, { useRef, useState } from 'react';
import { Animated, Easing, Pressable } from 'react-native';
import { motion } from '../../theme';
import { useReduceMotion } from './Status';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// How far a held element settles: a card or a button to 97% of its size, anything to 85% of its opacity.
export const PRESS_SCALE = 0.97;
export const PRESS_OPACITY = 0.85;

export default function Press({ style, scale = true, onPressIn, onPressOut, children, ...props }) {
  const reduce = useReduceMotion();
  const held = useRef(new Animated.Value(0)).current;
  const [pressed, setPressed] = useState(false);
  const settle = (to) => {
    Animated.timing(held, { toValue: to, duration: motion.press, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };
  const feel = { opacity: held.interpolate({ inputRange: [0, 1], outputRange: [1, PRESS_OPACITY] }) };
  if (scale && !reduce) feel.transform = [{ scale: held.interpolate({ inputRange: [0, 1], outputRange: [1, PRESS_SCALE] }) }];
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(e) => { setPressed(true); settle(1); if (onPressIn) onPressIn(e); }}
      onPressOut={(e) => { setPressed(false); settle(0); if (onPressOut) onPressOut(e); }}
      style={[typeof style === 'function' ? style({ pressed }) : style, feel]}
    >
      {children}
    </AnimatedPressable>
  );
}

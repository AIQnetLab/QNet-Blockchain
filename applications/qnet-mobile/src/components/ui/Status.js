/**
 * A status said in a word, never in a filled pill: live (a Signal dot with its slow ring, then the word), done (Paper),
 * quiet (Fog), needs (Ember: something to do or that went wrong), none (an empty ring). The word carries the meaning;
 * colour only repeats it. With the system's reduce-motion setting on, the ring stands still.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View } from 'react-native';
import { color, motion, radius, size, space, themed } from '../../theme';

// Whether the system's reduce-motion setting is on; true until it has been read, so nothing moves before.
export function useReduceMotion() {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(!!v); }, () => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; if (sub && sub.remove) sub.remove(); };
  }, []);
  return reduce;
}

/** The live dot: 7 dp of Signal, its ring growing and fading every two seconds. */
export function LiveDot({ style, testID }) {
  const reduce = useReduceMotion();
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return undefined;
    const loop = Animated.loop(Animated.timing(t, {
      toValue: 1, duration: motion.pulse, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }));
    loop.start();
    return () => { loop.stop(); t.setValue(0); };
  }, [reduce, t]);
  const ring = {
    opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 3.2] }) }],
  };
  return (
    <View style={[s.dotBox, style]} testID={testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {reduce ? null : <Animated.View style={[s.dot, s.ring, ring]} />}
      <View style={s.dot} />
    </View>
  );
}

export default function Status({ tone = 'quiet', label, style, textStyle, testID }) {
  const word = <Text style={[s.word, s[tone] || s.quiet, textStyle]} testID={testID}>{label}</Text>;
  if (tone !== 'live' && tone !== 'none') return word;
  return (
    <View style={[s.line, style]}>
      {tone === 'live' ? <LiveDot /> : <View style={s.empty} />}
      {word}
    </View>
  );
}

const s = themed((type) => ({
  line: { flexDirection: 'row', alignItems: 'center', columnGap: space.s8 },
  dotBox: { width: size.dot, height: size.dot, alignItems: 'center', justifyContent: 'center' },
  dot: { width: size.dot, height: size.dot, borderRadius: radius.dot, backgroundColor: color.signal },
  ring: { position: 'absolute' },
  empty: { width: size.dot, height: size.dot, borderRadius: radius.dot, borderWidth: 1.5, borderColor: color.fog },
  word: { ...type('note') },
  live: { color: color.paper },
  done: { color: color.paper },
  quiet: { color: color.fog },
  needs: { color: color.ember },
  none: { color: color.fog },
}));

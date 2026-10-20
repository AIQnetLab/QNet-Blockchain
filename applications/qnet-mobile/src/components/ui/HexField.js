/**
 * The live field over the top half of the two screens that hold no data (welcome and lock): a few columns of glyphs
 * falling cell by cell at their own speeds, the head Paper with a Signal glow, two pale cells behind it, the trail Signal
 * fading toward its end, each column fading out as its head nears the middle of the screen. Native-driven transforms
 * only: JS runs once per pass of a column (new glyphs while it is out of sight), never per frame. Stopped while the app
 * is in the background, a still frame under the system's reduce-motion setting; hidden from screen readers.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Text, View } from 'react-native';
import { color, glow, themed, tint } from '../../theme';
import { useReduceMotion } from './Status';

// The site's field: hex digits twice as often as the half-width kana.
export const GLYPHS = '0123456789abcdef0123456789abcdefｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂ';
export const CELL = 20;
export const COLUMNS = 10;
// A column is whole while its head is in the upper 40% of the field and gone where the field ends.
const FADE_FROM = 0.4;

// A small fixed-seed generator: the same field on every device and every start.
function random(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/**
 * The columns of a field `rows` cells high, in translateY of the column's top: a pass runs from `from` (out of sight,
 * `gap` cells above the field) to `to` (the head at the field's end); `at` is where it stands first and in the still
 * frame (the head in the upper 80%); `fade` is the stretch over which it fades out.
 */
export function columns(rows) {
  const next = random(0x2f6b9d13);
  const out = [];
  for (let i = 0; i < COLUMNS; i += 1) {
    const len = 6 + Math.floor(next() * 7);
    const speed = 6 + next() * 8;
    const a = 0.45 + next() * 0.55;
    const gap = Math.floor(next() * rows * 0.6);
    const from = -(len + gap) * CELL;
    const to = (rows - len) * CELL;
    const at = Math.max(from, (Math.round(next() * rows * 0.8) - len) * CELL);
    out.push({ i, len, speed, a, from, to, at, fade: [to - (1 - FADE_FROM) * rows * CELL, to] });
  }
  return out;
}

// The glyphs of one pass, tail first; the alphas are the site's (k cells behind the head).
export function trail(c, pass) {
  const next = random((c.i + 1) * 0x9e3779b1 + pass * 0x85ebca6b);
  const cells = [];
  for (let k = c.len - 1; k >= 0; k -= 1) {
    const ch = GLYPHS[Math.floor(next() * GLYPHS.length)];
    const [tone, shade] = k === 0 ? [color.paper, 1.4] : k < 3 ? [color.signalPale, 1.05] : [color.signal, (1 - k / c.len) ** 1.25];
    cells.push({ ch, color: tint(tone, Math.round(Math.min(1, shade * c.a) * 100) / 100) });
  }
  return cells;
}

// Moves the column one cell at a time, the field's own grid.
const steps = (n) => (t) => Math.floor(t * n) / n;

function Stream({ c, live }) {
  const value = useRef(new Animated.Value(c.at)).current;
  const at = useRef(c.at);
  const [pass, setPass] = useState(0);
  const cells = useMemo(() => trail(c, pass), [c, pass]);
  const motion = useMemo(() => ({
    opacity: value.interpolate({ inputRange: c.fade, outputRange: [1, 0], extrapolate: 'clamp' }),
    transform: [{ translateY: value }],
  }), [value, c]);
  useEffect(() => {
    if (!live) return undefined;
    let alive = true;
    const run = (from) => {
      const start = c.from + Math.round((from - c.from) / CELL) * CELL;
      const n = Math.max(1, Math.round((c.to - start) / CELL));
      value.setValue(start);
      Animated.timing(value, {
        toValue: c.to, duration: (n * 1000) / c.speed, easing: steps(n), useNativeDriver: true, isInteraction: false,
      }).start(({ finished }) => {
        if (!finished || !alive) return;
        setPass((p) => p + 1);
        run(c.from);
      });
    };
    run(at.current);
    // Resumes where it stood: the value is read back from the native side.
    return () => { alive = false; value.stopAnimation((v) => { at.current = v; }); };
  }, [live, c, value]);
  const last = cells.length - 1;
  return (
    <View style={s.slot}>
      <Animated.View style={motion}>
        <Text style={s.glyphs}>
          {cells.map((g, k) => (
            <Text key={k} style={k === last ? [s.head, { color: g.color }] : { color: g.color }}>{k === last ? g.ch : `${g.ch}\n`}</Text>
          ))}
        </Text>
      </Animated.View>
    </View>
  );
}

const awake = (state) => state !== 'background' && state !== 'inactive';
function useAwake() {
  const [on, setOn] = useState(() => awake(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setOn(awake(state)));
    return () => { if (sub && sub.remove) sub.remove(); };
  }, []);
  return on;
}

export default function HexField({ style }) {
  const [rows, setRows] = useState(0);
  const still = useReduceMotion();
  const live = useAwake() && !still;
  const cols = useMemo(() => (rows > 1 ? columns(rows) : []), [rows]);
  return (
    <View
      style={[s.field, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e) => setRows(Math.floor(e.nativeEvent.layout.height / CELL))}
      testID="hex-field"
    >
      {cols.map((c) => <Stream key={`${rows}:${c.i}`} c={c} live={live} />)}
    </View>
  );
}

const s = themed((type) => ({
  field: { position: 'absolute', top: 0, left: 0, right: 0, height: '50%', overflow: 'hidden', flexDirection: 'row' },
  slot: { flex: 1, alignItems: 'center' },
  glyphs: { ...type('data', 14), lineHeight: CELL, textAlign: 'center' },
  head: glow,
}));

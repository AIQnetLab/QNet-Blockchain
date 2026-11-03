/**
 * The live field over the top half of the welcome and lock screens: a fixed grid of glyphs per column, a head that writes
 * a new glyph in each cell it enters and flickers between steps, a fading trail whose every glyph changes on its own. One
 * clock for the whole field, paced so that a slow phone never queues it ahead of a tap; stopped in the background, a
 * still frame under reduce motion, hidden from screen readers. Where the app registers its own view (QNetHexField,
 * HexFieldView.js), that view draws the field from ports of this module's steps (Android's checked against vectors
 * written from it, iOS's held to its lines); this module draws it elsewhere.
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import { AppState, I18nManager, Text, View, useWindowDimensions } from 'react-native';
import { color, glow, themed } from '../../theme';
import NativeField from './HexFieldView';
import { useReduceMotion } from './Status';

// The site's field: hex digits twice as often as the half-width kana.
export const GLYPHS = '0123456789abcdef0123456789abcdefｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂ';
export const CELL = 20;
export const COLUMNS = 10;
// A trail's length in cells: the field draws at most COLUMNS x MAX_TRAIL glyphs, the same nodes for as long as it runs.
export const MIN_TRAIL = 8;
export const MAX_TRAIL = 14;
// The field's clock; a column steps one cell every 2 to 5 ticks (about 6 to 15 cells a second).
export const TICK_MS = 33;
// Between steps the head's glyph changes HEAD_FLICKER_PER_S times a second; each trail cell in sight changes its glyph on
// its own about TRAIL_SWAP_PER_CELL_S times a second (once in about 1.5 s), so a 13-cell trail changes about 8 a second.
export const HEAD_FLICKER_PER_S = 12;
export const TRAIL_SWAP_PER_CELL_S = 0.65;
const FLICKER = (HEAD_FLICKER_PER_S * TICK_MS) / 1000;
const SWAP = (TRAIL_SWAP_PER_CELL_S * TICK_MS) / 1000;
// A column is whole while its head is in the upper 40% of the field and gone where the field ends.
export const FADE_FROM = 0.4;

// A fixed integer hash: the same field on every device and every start, and a tick's draws without kept state.
export function hash(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}
export const PLAN = 0x7fff0000;
export const glyphAt = (r) => GLYPHS[Math.floor(r * GLYPHS.length)];
// A glyph other than `was`, so a swap always shows.
export function another(was, r) {
  let n = Math.floor(r * GLYPHS.length);
  while (GLYPHS[n] === was) n = (n + 1) % GLYPHS.length;
  return GLYPHS[n];
}

/**
 * The columns of a field `rows` cells high, in head rows: a pass runs from `from` (gap cells above the field) to `to`
 * (the field's last row); `head` starts in the upper 80%. `glyphs[k]` is the glyph k cells above the head.
 */
export function columns(rows) {
  const out = [];
  for (let i = 0; i < COLUMNS; i += 1) {
    const draw = (n) => hash(i, PLAN + n);
    const len = MIN_TRAIL + Math.floor(draw(0) * (MAX_TRAIL - MIN_TRAIL + 1));
    const every = 2 + Math.floor(draw(1) * 4);
    const from = -1 - Math.floor(draw(2) * rows * 0.6);
    const head = Math.max(from, Math.round(draw(3) * rows * 0.8) - 1);
    const glyphs = Array.from({ length: len }, (_, k) => glyphAt(draw(10 + k)));
    const phase = Math.floor(draw(4) * every);
    out.push({ i, len, every, phase, beat: draw(6), a: 0.45 + draw(5) * 0.55, from, to: rows - 1, head, glyphs });
  }
  return out;
}

/**
 * Column `c` at tick `t`: on its step the head enters the next cell with a new glyph and every other glyph stays in its
 * cell; between steps the head's glyph flickers, and each trail glyph in sight changes on its own. Only what is in sight
 * changes; the same object when nothing did, so a column at rest draws nothing.
 */
export function advance(c, t) {
  const roll = (n) => hash(c.i + (n << 8), t);
  const inSight = (row) => row >= 0 && row < c.to;
  let { head, glyphs } = c;
  // The flicker's beats fall where t x FLICKER + beat passes a whole number: a carried fraction, read off the clock.
  const beat = Math.floor(t * FLICKER + c.beat) > Math.floor((t - 1) * FLICKER + c.beat);
  if ((t + c.phase) % c.every === 0) {
    head = head >= c.to ? c.from : head + 1;
    glyphs = [another(glyphs[0], roll(0)), ...glyphs.slice(0, -1)];
  } else if (beat && inSight(head)) {
    glyphs = [another(glyphs[0], roll(1)), ...glyphs.slice(1)];
  }
  // The trail cells in sight, k from 1 to the head's own row: lit x SWAP swaps a tick on average (rounded at random),
  // each in a cell drawn at random, so every cell keeps its own rate whatever the trail's length.
  const lit = inSight(head) ? Math.min(c.len - 1, head) : 0;
  const swaps = Math.floor(lit * SWAP + roll(2));
  for (let j = 0; j < swaps; j += 1) {
    if (glyphs === c.glyphs) glyphs = glyphs.slice();
    const k = 1 + Math.floor(roll(3 + 2 * j) * lit);
    glyphs[k] = another(glyphs[k], roll(4 + 2 * j));
  }
  return head === c.head && glyphs === c.glyphs ? c : { ...c, head, glyphs };
}

// The brightness of the cell k behind the head in a trail of `len`, the trail's x to the power 1.25 (x = 1 - k / len)
// written as a product and two square roots: every runtime rounds those the same way, so the ports draw the same bits.
export function brightness(k, len) {
  if (k === 0) return 1.4;
  if (k < 3) return 1.05;
  const x = 1 - k / len;
  return x * Math.sqrt(Math.sqrt(x));
}

// The cell k behind the head: the head Paper, two pale cells, the trail Signal fading toward its end, all fading out as
// the head nears the field's end. The fade is the cell's own opacity, which no glyph change touches.
export function shade(c, k) {
  const fade = Math.min(1, Math.max(0, (c.to - c.head) / ((1 - FADE_FROM) * (c.to + 1))));
  const tone = k === 0 ? color.paper : k < 3 ? color.signalPale : color.signal;
  return { tone, opacity: Math.round(Math.min(1, brightness(k, c.len) * c.a) * fade * 100) / 100 };
}

// One cell, drawn again only when its own glyph, row or shade changes: a flicker or a swap redraws one Text, not a column.
const Cell = memo(function Cell({ ch, row, tone, opacity, lead }) {
  return (
    <Text allowFontScaling={false} style={[s.cell, { top: row * CELL, color: tone, opacity }, lead && s.head]}>{ch}</Text>
  );
});

// A column's cells in a ring of `len` slots: the cell the head enters takes the slot of the one the trail leaves, so a
// step changes props and never mounts, unmounts or reorders a node.
const Column = memo(function Column({ c }) {
  const cells = [];
  for (let slot = 0; slot < c.len; slot += 1) {
    const k = (((c.head - slot) % c.len) + c.len) % c.len;
    const { tone, opacity } = shade(c, k);
    cells.push(<Cell key={slot} ch={c.glyphs[k]} row={c.head - k} tone={tone} opacity={opacity} lead={k === 0} />);
  }
  return <View style={s.slot}>{cells}</View>;
});

// The field never queues a tick behind another (on a slow phone a growing line of them would hold back every tap):
// each render waits for a frame the system drew and then at least as long as its own work took, so the JS thread is
// free half the time at worst. The ticks a slow phone could not draw go into the next render (MAX_CATCH_UP at most), so
// the field keeps its speed; past that (a stall, a clock set back) it goes on from where it stood.
export const MAX_CATCH_UP = 8;
// When tick 0 fell, so that `tick` falls at `at`.
export const clockZero = (tick, at) => at - tick * TICK_MS;
// The tick a frame at `at` draws to from tick `from`: the ticks due, MAX_CATCH_UP at most and never back, with tick 0
// set again where those bounds held the clock.
export function clockAt(from, zero, at) {
  const due = Math.floor((at - zero) / TICK_MS);
  const to = Math.min(Math.max(due, from), from + MAX_CATCH_UP);
  return { to, zero: to === due ? zero : at - to * TICK_MS };
}

/** Ticks `from + 1` to `to` of the columns `cols` (the same array when nothing changed). */
export function advanceTo(cols, from, to) {
  let next = cols;
  for (let t = from + 1; t <= to; t += 1) next = next.map((c) => advance(c, t));
  return next.some((c, i) => c !== cols[i]) ? next : cols;
}

function Rain({ rows, live, now }) {
  const [cols, setCols] = useState(() => columns(rows));
  const clock = useRef(0);
  useEffect(() => {
    if (!live) return undefined;
    let timer = null;
    let frame = null;
    // The tick the field stood at falls now.
    let zero = clockZero(clock.current, now());
    const later = (ms) => {
      timer = setTimeout(() => {
        timer = null;
        frame = requestAnimationFrame(run);
      }, ms);
    };
    // One render: the ticks due since the last, drawn at once (on the old architecture the render runs inside setCols,
    // so `ended - began` is the JS work of the frame).
    const run = () => {
      frame = null;
      const began = now();
      const from = clock.current;
      const next = clockAt(from, zero, began);
      zero = next.zero;
      const { to } = next;
      if (to > from) {
        clock.current = to;
        setCols((prev) => advanceTo(prev, from, to));
      }
      const ended = now();
      later(Math.max(ended - began, zero + (to + 1) * TICK_MS - ended));
    };
    later(TICK_MS);
    return () => {
      clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [live, now]);
  return cols.map((c) => <Column key={c.i} c={c} />);
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

// `now`: the clock of this module's field (Date.now; a test gives one that runs as a slow phone's does).
export default function HexField({ style, now = Date.now }) {
  // The top half of the window, never of the room it is drawn in: a keyboard that shrinks the room neither cuts the field
  // nor starts it over. It starts once laid out.
  const half = useWindowDimensions().height / 2;
  const [laid, setLaid] = useState(false);
  const rows = laid ? Math.floor(half / CELL) : 0;
  const still = useReduceMotion();
  const live = useAwake() && !still;
  return (
    <View
      style={[s.field, { height: half }, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={() => setLaid(true)}
      testID="hex-field"
    >
      {rows > 1 ? (NativeField ? (
        <NativeField
          key={rows} style={s.fill} rows={rows} live={live} rtl={I18nManager.isRTL} paper={color.paper}
          signalPale={color.signalPale} signal={color.signal} glowColor={glow.textShadowColor}
          glowRadius={glow.textShadowRadius} cellSize={CELL} glyphSize={s.cell.fontSize} fontName={s.cell.fontFamily}
        />
      ) : <Rain key={rows} rows={rows} live={live} now={now} />) : null}
    </View>
  );
}

const s = themed((type) => ({
  field: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden', flexDirection: 'row' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  slot: { flex: 1 },
  cell: { ...type('data', 14), position: 'absolute', left: 0, right: 0, height: CELL, lineHeight: CELL, textAlign: 'center' },
  head: glow,
}));

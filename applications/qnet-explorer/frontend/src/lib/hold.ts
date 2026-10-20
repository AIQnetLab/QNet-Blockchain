// When a live list holds its newest rows, so nothing moves under a pointer or a finger (B-SPEC 3.6), and how it says
// what waits. A mouse or pen over the list and focus inside it hold it while they last; a touch holds it from the press
// until TOUCH_HOLD_MS after the last touch there, and after a touch a scroll while the list is on screen holds it the
// same way, so a row does not move between aiming at it and tapping it; a list scrolled away from its newest end holds
// until it is back there. Framework-free, so the rules are testable; components/ui/useHold.ts wires them to the page.

import { int } from './format.ts';

export const TOUCH_HOLD_MS = 3_000;

export interface HoldState {
  // A mouse or pen over the list.
  pointer: boolean;
  // Focus inside the list.
  focus: boolean;
  // A finger on the list now.
  pressed: boolean;
  // A touch or a scroll holds the list until this time (ms).
  touchUntil: number;
  // The list's own frame is scrolled away from its newest end (the explorer's block strip read sideways).
  away: boolean;
  // The list is sliding new rows in (src/lib/slide.ts): what comes meanwhile waits for the end, without a label.
  sliding: boolean;
}

export const IDLE: HoldState = { pointer: false, focus: false, pressed: false, touchUntil: 0, away: false, sliding: false };

export function held(s: HoldState, now: number): boolean {
  return s.pointer || s.focus || s.pressed || s.away || s.sliding || now < s.touchUntil;
}

// The rows that landed since the list last showed: keys the previous list did not have; none for the first list.
export function landed(before: ReadonlySet<string> | null, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (before) for (const k of keys) if (!before.has(k)) out.add(k);
  return out;
}

// The hold of a touch: it ends TOUCH_HOLD_MS after the last touch or scroll, never earlier than one already set.
export function touched(s: HoldState, now: number): HoldState {
  return { ...s, touchUntil: Math.max(s.touchUntil, now + TOUCH_HOLD_MS) };
}

// The rows the list holds back: the latest rows it does not show yet. When none of the shown rows is left in the latest
// (more arrived than the list holds), the count is a floor.
export function heldBack<T>(shown: readonly T[] | null, latest: readonly T[] | null, key: (row: T) => string): { count: number; more: boolean } {
  if (!shown || !latest || shown === latest) return { count: 0, more: false };
  const mine = new Set(shown.map(key));
  let count = 0;
  for (const row of latest) if (!mine.has(key(row))) count++;
  return { count, more: count > 0 && count === latest.length && shown.length > 0 };
}

// What the list's label says while it holds: what waits ("3 new", "12+ new"), or that it is paused.
export function heldText(back: { count: number; more: boolean }, touch: boolean): string {
  if (back.count > 0) return `${int(back.count)}${back.more ? '+' : ''} new`;
  return touch ? 'Paused' : 'Paused while you point at it';
}

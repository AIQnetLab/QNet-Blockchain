'use client';

// Clickable things do not move under the pointer or a finger (B-SPEC 3.6, rules in src/lib/hold.ts): while a mouse or
// pen is over a live list or focus is inside it, on a touch screen from the press on the list until 3 s after the
// last touch there (or a scroll while it is on screen), and while its frame is scrolled away from the newest end, the
// newest value is held and applied when the hold ends. One buffer, the latest value, never a growing queue; `back` says
// how many rows wait.

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type RefObject } from 'react';
import { IDLE, held, heldBack, landed, touched, type HoldState } from '@/lib/hold';

export interface Hold<T> {
  shown: T;
  holding: boolean;
  // The hold came from a touch or the list's own scroll (its label says "Paused", not "while you point at it").
  touch: boolean;
  back: { count: number; more: boolean };
  // The list's frame is (true) or is no longer (false) scrolled away from its newest end.
  away: (on: boolean) => void;
  // A slide runs (true) or ended (false): the next value waits for its end, and the label stays as it is.
  settle: (on: boolean) => void;
  handlers: {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onFocus: () => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
  };
}

// The page's last press was a touch: a scroll from then on can hold a list on screen. One flag for the page.
let touchPage = false;
let watching = false;
function watchPresses() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('pointerdown', (e) => { touchPage = e.pointerType === 'touch'; }, { capture: true, passive: true });
}

// `box`: the list's element, whose being on screen lets a scroll hold it; `key`: a row's identity, for what waits; `on`:
// false for a list that is not live (no listeners, nothing held).
export function useHold<R>(latest: readonly R[] | null, box: RefObject<HTMLElement | null>, key: (row: R) => string, on = true): Hold<readonly R[] | null> {
  const [shown, setShown] = useState(latest);
  const [holding, setHolding] = useState(false);
  const [touch, setTouch] = useState(false);
  const state = useRef<HoldState>(IDLE);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const timer = useRef<number | undefined>(undefined);

  const release = useCallback(() => {
    if (held(state.current, Date.now())) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
    setTouch(false);
    setShown(latestRef.current);
  }, []);

  // A new value shows at once unless held; one that comes after a touch hold ran out, before its timer, ends it.
  useEffect(() => { release(); }, [latest, release]);

  // A touch or a scroll: held until 3 s after it, checked again when that time comes.
  const touchHold = useCallback(() => {
    const now = Date.now();
    state.current = touched(state.current, now);
    setHolding(true);
    setTouch(true);
    window.clearTimeout(timer.current);
    const check = () => {
      const left = state.current.touchUntil - Date.now();
      if (left > 0 || state.current.pressed) timer.current = window.setTimeout(check, Math.max(left, 50));
      else release();
    };
    timer.current = window.setTimeout(check, state.current.touchUntil - now);
  }, [release]);

  // After a touch, a scroll of the page or of the list's own frame while the list is on screen holds it.
  useEffect(() => {
    const el = box.current;
    if (!el || !on) return;
    watchPresses();
    let visible = false;
    const view = new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; });
    view.observe(el);
    const onScroll = () => { if (touchPage && visible) touchHold(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      view.disconnect();
      window.removeEventListener('scroll', onScroll);
      el.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer.current);
    };
  }, [box, touchHold, on]);

  const handlers: Hold<readonly R[] | null>['handlers'] = {
    onPointerEnter: (e) => {
      // A finger is no hover: its press holds the list (onPointerDown).
      if (e.pointerType === 'touch') return;
      state.current = { ...state.current, pointer: true };
      setHolding(true);
    },
    onPointerLeave: () => {
      if (!state.current.pointer) return;
      state.current = { ...state.current, pointer: false };
      release();
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return;
      state.current = { ...state.current, pressed: true };
      touchHold();
    },
    onPointerUp: (e) => {
      if (e.pointerType !== 'touch') return;
      state.current = { ...state.current, pressed: false };
      touchHold();
    },
    onPointerCancel: (e) => {
      if (e.pointerType !== 'touch') return;
      state.current = { ...state.current, pressed: false };
      touchHold();
    },
    onFocus: () => {
      state.current = { ...state.current, focus: true };
      setHolding(true);
    },
    onBlur: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      state.current = { ...state.current, focus: false };
      release();
    },
  };
  const away = useCallback((on: boolean) => {
    if (state.current.away === on) return;
    state.current = { ...state.current, away: on };
    if (!on) return release();
    setHolding(true);
    setTouch(true);
  }, [release]);
  const settle = useCallback((on: boolean) => {
    state.current = { ...state.current, sliding: on };
    if (!on) release();
  }, [release]);
  const back = holding ? heldBack(shown, latest, key) : { count: 0, more: false };
  return { shown, holding, touch, back, away, settle, handlers };
}

// The keys of the rows that landed with the list shown now (tinted or flashed as they land); none for the first list.
export function useLanded<R>(shown: readonly R[] | null, key: (row: R) => string, on = true): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const out = useMemo(() => {
    const keys = (shown ?? []).map((r) => keyRef.current(r));
    return { keys: new Set(keys), landed: on ? landed(seen.current, keys) : new Set<string>() };
  }, [shown, on]);
  useEffect(() => {
    if (shown) seen.current = out.keys;
  }, [shown, out]);
  return out.landed;
}

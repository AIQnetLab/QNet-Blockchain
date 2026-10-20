'use client';

// An age that counts on by itself ("5s ago"): one clock for the whole page, ticking once a second while the tab is
// shown, so a table's ages refresh in place and the table itself never renders again for them.

import { useSyncExternalStore } from 'react';
import { ageText } from '@/lib/explorer-view';

const listeners = new Set<() => void>();
let tick = 0;
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tick += 1;
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const current = () => tick;
const onServer = () => 0;
const still = () => () => {};

// Renders the caller again once a second (only it, not its parent). `on` false holds it (a part out of view does no DOM
// work); turned on again, it catches up at the next tick.
export function useClock(on = true): void {
  useSyncExternalStore(on ? subscribe : still, current, onServer);
}

export default function Ago({ ts, on = true }: { ts: number | string | null | undefined; on?: boolean }) {
  useClock(on);
  // The server's age and the browser's differ by the time in between; the browser's replaces it at once.
  return <span className="num" suppressHydrationWarning>{ageText(ts, Date.now())}</span>;
}

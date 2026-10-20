'use client';

import { useEffect, useRef, useState } from 'react';

// The active node counts of the last settled epoch (/api/network/stats): read on load and again as the head moves, at
// most once a minute and only while the tab is shown, since they change once an epoch.

export interface NodeCounts {
  superNodes: number;
  lightNodes: number;
}

const NODE_COUNTS_MS = 60_000;

export function useNodeCounts(height: number): NodeCounts | null {
  const [counts, setCounts] = useState<NodeCounts | null>(null);
  const last = useRef(0);
  useEffect(() => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - last.current < NODE_COUNTS_MS) return;
    last.current = now;
    void (async () => {
      try {
        const res = await fetch('/api/network/stats', { cache: 'no-store' });
        const body = await res.json();
        if (body?.success && body.data) setCounts({ superNodes: Number(body.data.activeNodes) || 0, lightNodes: Number(body.data.activeLightNodes) || 0 });
      } catch {
        // The readouts keep "—" or their last counts; the next head asks again.
        last.current = 0;
      }
    })();
  }, [height]);
  return counts;
}

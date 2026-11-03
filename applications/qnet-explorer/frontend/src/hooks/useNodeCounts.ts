'use client';

import { useEffect, useRef, useState } from 'react';
import { siteRequest } from '@/lib/site-request';

// The active node counts of the last settled epoch (/api/network/stats): read on load and again as the head moves, at
// most once a minute and only while the tab is shown, since they change once an epoch. The super nodes are those the
// network admits, null while the server cannot tell which (src/server/node-counts.ts).

export interface NodeCounts {
  superNodes: number | null;
  lightNodes: number;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

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
        const res = await fetch('/api/network/stats', siteRequest());
        const body = await res.json();
        if (body?.success && body.data) setCounts({ superNodes: count(body.data.activeNodes), lightNodes: count(body.data.activeLightNodes) ?? 0 });
      } catch {
        // The readouts keep "—" or their last counts; the next head asks again.
        last.current = 0;
      }
    })();
  }, [height]);
  return counts;
}

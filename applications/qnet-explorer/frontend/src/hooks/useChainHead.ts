'use client';

import { useEffect, useRef, useState } from 'react';

// Live chain head for client components: one event stream per tab (shared by every subscriber),
// paused while the tab is hidden, falling back to a 15 s poll of /api/head when streaming fails.

export interface ChainHead {
  v: number;
  height: number;
  hash: string | null;
  timestamp: number;
  txTotal: number;
  txByType: Record<string, number>;
  blocksTotal: number;
  emissionTotal: string;
  sync: { head: number; prefix: number; nodeHeight: number; live: boolean };
  connected: boolean;
}

const EMPTY: ChainHead = { v: 0, height: 0, hash: null, timestamp: 0, txTotal: 0, txByType: {}, blocksTotal: 0, emissionTotal: '0', sync: { head: -1, prefix: -1, nodeHeight: 0, live: false }, connected: false };
const POLL_MS = 15_000;
const RECONNECT_MS = 20_000;

type Listener = (h: ChainHead) => void;
const listeners = new Set<Listener>();
let current: ChainHead = EMPTY;
let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function publish(next: Partial<ChainHead>) {
  current = { ...current, ...next };
  for (const l of listeners) l(current);
}

function parse(data: string): Partial<ChainHead> | null {
  try {
    const d = JSON.parse(data);
    if (typeof d?.height !== 'number') return null;
    return { v: d.v, height: d.height, hash: d.hash ?? null, timestamp: d.timestamp || 0, txTotal: d.txTotal || 0, txByType: d.txByType || {}, blocksTotal: d.blocksTotal || 0, emissionTotal: String(d.emissionTotal ?? '0'), sync: d.sync || current.sync };
  } catch { return null; }
}

async function pollOnce() {
  try {
    const res = await fetch('/api/head', { cache: 'no-store' });
    const j = await res.json();
    if (j?.success && j.data) { const p = parse(JSON.stringify(j.data)); if (p) publish(p); }
  } catch { /* next poll */ }
}

function startPolling() {
  if (pollTimer) return;
  void pollOnce();
  pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') void pollOnce(); }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function connect() {
  if (source || typeof EventSource === 'undefined') { if (!source) startPolling(); return; }
  const es = new EventSource('/api/stream');
  source = es;
  es.addEventListener('head', (ev: MessageEvent) => {
    const p = parse(ev.data);
    if (p) { stopPolling(); publish({ ...p, connected: true }); }
  });
  es.onopen = () => { publish({ connected: true }); };
  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    publish({ connected: false });
    startPolling();
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; if (document.visibilityState !== 'hidden') connect(); }, RECONNECT_MS);
  };
}

function disconnect() {
  if (source) { source.close(); source = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPolling();
  publish({ connected: false });
}

function ensure() {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') disconnect();
    else if (listeners.size > 0) connect();
  });
}

export function useChainHead(): ChainHead {
  const [head, setHead] = useState<ChainHead>(current);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    ensure();
    listeners.add(setHead);
    setHead(current);
    if (document.visibilityState !== 'hidden') connect();
    return () => {
      mounted.current = false;
      listeners.delete(setHead);
      if (listeners.size === 0) disconnect();
    };
  }, []);
  return head;
}

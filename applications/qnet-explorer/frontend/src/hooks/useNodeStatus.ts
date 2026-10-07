'use client';

// A node's reads for the cabinet, from the site's routes (src/server/cabinet/node-proxy.ts, wallet-node.ts): a light
// node's status and epochs, a super node's status, and whether a wallet has a node of either type. Read on load, when
// the page is shown again, and every half minute while it is shown. The answer is checked again here. Every part of a
// page that shows the same read shares one, and a section opened next shows the last answer while it reads again.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { parseHistoryView, parseStatusView, parseSuperStatus, type HistoryView, type NodeStatusView, type SuperStatusView } from '@/lib/cabinet/node-view';
import { parseWalletNode, type WalletNodeView } from '@/lib/cabinet/wallet-activation';

const REFRESH_MS = 30_000;
const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };

export type Loaded<T> = { phase: 'loading' } | { phase: 'ok'; value: T } | { phase: 'unavailable' };

const LOADING: Loaded<never> = { phase: 'loading' };

async function load<T>(url: string, parse: (body: unknown) => T | null): Promise<T | null> {
  try {
    const res = await fetch(url, REQUEST);
    return res.status === 200 ? parse(await res.json()) : null;
  } catch {
    return null;
  }
}

// One read of one route, shared by the components that show it.
interface SharedRead {
  state: Loaded<unknown>;
  seq: number;
  reading: boolean;
  listeners: Set<() => void>;
  pollers: number;
  timer: number | undefined;
  onVisible: (() => void) | undefined;
}

const reads = new Map<string, SharedRead>();

function shared(url: string): SharedRead {
  let entry = reads.get(url);
  if (!entry) {
    entry = { state: LOADING, seq: 0, reading: false, listeners: new Set(), pollers: 0, timer: undefined, onVisible: undefined };
    reads.set(url, entry);
  }
  return entry;
}

function publish(entry: SharedRead, state: Loaded<unknown>) {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

// `quiet` keeps what is shown until the answer; a quiet read that fails keeps it too, unless `keep` says the answer
// shown is no answer once a read fails.
async function read(url: string, parse: (body: unknown) => unknown, quiet: boolean, keep?: (value: unknown) => boolean) {
  const entry = shared(url);
  const mine = ++entry.seq;
  entry.reading = true;
  if (!quiet) publish(entry, LOADING);
  const value = await load(url, parse);
  if (mine !== entry.seq) return;
  entry.reading = false;
  if (value !== null) publish(entry, { phase: 'ok', value });
  else if (!quiet || entry.state.phase === 'loading' || (entry.state.phase === 'ok' && keep && !keep(entry.state.value))) {
    publish(entry, { phase: 'unavailable' });
  }
}

export function useSharedRead<T>(url: string | null, parse: (body: unknown) => T | null, refresh: boolean, keep?: (value: T) => boolean) {
  const kept = keep as ((value: unknown) => boolean) | undefined;
  // The shown answer follows the shared read, also one that lands between this component's render and its effects.
  const subscribe = useCallback((listener: () => void) => {
    if (!url) return () => {};
    const entry = shared(url);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [url]);
  const snapshot = useCallback(() => (url ? shared(url).state : LOADING), [url]);
  const state = useSyncExternalStore(subscribe, snapshot, () => LOADING) as Loaded<T>;

  useEffect(() => {
    if (!url) return;
    const entry = shared(url);
    // A read already on its way serves this component too; otherwise it reads, quietly when an answer is shown.
    if (!entry.reading) void read(url, parse, entry.state.phase === 'ok', kept);
    if (refresh && ++entry.pollers === 1) {
      const again = () => {
        if (document.visibilityState === 'visible') void read(url, parse, true, kept);
      };
      entry.onVisible = again;
      entry.timer = window.setInterval(again, REFRESH_MS);
      document.addEventListener('visibilitychange', again);
    }
    return () => {
      if (refresh && --entry.pollers === 0) {
        window.clearInterval(entry.timer);
        if (entry.onVisible) document.removeEventListener('visibilitychange', entry.onVisible);
        entry.timer = undefined;
        entry.onVisible = undefined;
      }
    };
  }, [url, parse, refresh, kept]);

  // retry shows "Checking" again; refresh keeps what the page shows until the new answer.
  const retry = useCallback(() => {
    if (url) void read(url, parse, false, kept);
  }, [url, parse, kept]);
  const again = useCallback(() => {
    if (url) void read(url, parse, true, kept);
  }, [url, parse, kept]);
  return { state, retry, refresh: again };
}

const nodeUrl = (nodeId: string | null, path = '') => (nodeId ? `/api/cabinet/node/${encodeURIComponent(nodeId)}${path}` : null);

export function useNodeStatus(nodeId: string | null) {
  return useSharedRead<NodeStatusView>(nodeUrl(nodeId), parseStatusView, true);
}

// A light or a super node's epochs.
export function useNodeHistory(nodeId: string | null) {
  return useSharedRead<HistoryView>(nodeUrl(nodeId, '/history'), parseHistoryView, false);
}

export function useSuperStatus(nodeId: string | null) {
  return useSharedRead<SuperStatusView>(nodeId ? `/api/cabinet/super/${encodeURIComponent(nodeId)}` : null, parseSuperStatus, true);
}

// A node the network listed stays shown through a read that fails; "no node" does not, so nothing is offered while the
// network cannot answer (R6).
const keepListed = (value: WalletNodeView) => value.state === 'registered';

export function useWalletNode(wallet: string | null) {
  return useSharedRead<WalletNodeView>(wallet ? `/api/cabinet/wallet-node/${encodeURIComponent(wallet)}` : null, parseWalletNode, true, keepListed);
}

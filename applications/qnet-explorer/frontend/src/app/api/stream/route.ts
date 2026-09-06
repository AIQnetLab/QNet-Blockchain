import { NextRequest } from 'next/server';
import { headHub, type HeadSnapshot } from '@/server/head-hub';
import { getClientIdentifier } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

// Server-sent head stream: one `head` event per committed block (height, hash, time, counters, sync
// state). Rows are not pushed; a client on the live page refetches its list from the process cache.
// Bounded per client IP; a heartbeat every 15 s keeps proxies from closing an idle stream.

const MAX_STREAMS_PER_IP = 6;
const HEARTBEAT_MS = 15_000;
const streamsPerIp = new Map<string, number>();

function headPayload(s: HeadSnapshot): string {
  const st = s.stats;
  return JSON.stringify({
    v: s.version,
    height: s.height,
    hash: s.hash,
    timestamp: s.timestamp,
    txTotal: st.tx_total,
    txByType: st.tx_by_type,
    blocksTotal: st.blocks_total,
    emissionTotal: st.emission_total,
    sync: { head: s.sync.last_height, prefix: s.sync.indexed_prefix, nodeHeight: s.sync.node_height, live: s.sync.ws_connected },
  });
}

export async function GET(request: NextRequest) {
  const ip = getClientIdentifier(request);
  const open = streamsPerIp.get(ip) || 0;
  if (open >= MAX_STREAMS_PER_IP) {
    return new Response('too many streams', { status: 429, headers: { 'Retry-After': '10' } });
  }
  streamsPerIp.set(ip, open + 1);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)); } catch { cleanup(); }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (unsubscribe) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        streamsPerIp.set(ip, Math.max(0, (streamsPerIp.get(ip) || 1) - 1));
        if ((streamsPerIp.get(ip) || 0) === 0) streamsPerIp.delete(ip);
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener('abort', cleanup);
      let snap: HeadSnapshot;
      try { snap = await headHub.snapshot(); } catch { cleanup(); return; }
      if (closed) return;
      send('head', headPayload(snap));
      let lastVersion = snap.version;
      unsubscribe = headHub.subscribe(s => {
        if (s.version === lastVersion) return;
        lastVersion = s.version;
        send('head', headPayload(s));
      });
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch { cleanup(); }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      streamsPerIp.set(ip, Math.max(0, (streamsPerIp.get(ip) || 1) - 1));
      if ((streamsPerIp.get(ip) || 0) === 0) streamsPerIp.delete(ip);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

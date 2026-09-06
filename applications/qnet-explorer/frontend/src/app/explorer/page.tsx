import ExplorerClient from './ExplorerClient';
import { headHub } from '@/server/head-hub';

// The list page renders from the process head snapshot: no per-request query, the HTML already carries
// the newest rows and counters; the client keeps it live over the head stream.
export const dynamic = 'force-dynamic';

export default async function ExplorerPage() {
  let initialData: Awaited<ReturnType<typeof headHub.snapshot>>['rows'] = [];
  let initialHeight = 0;
  let initialTotal = 0;
  try {
    const s = await headHub.snapshot();
    initialData = s.rows;
    initialHeight = Math.max(s.height, 0);
    initialTotal = s.stats.tx_total;
  } catch (err) {
    console.error(`[ERR][WEB] explorer_ssr_failed err=${err instanceof Error ? err.message : String(err)}`);
  }
  return <ExplorerClient initialData={initialData} initialHeight={initialHeight} initialTotal={initialTotal} />;
}

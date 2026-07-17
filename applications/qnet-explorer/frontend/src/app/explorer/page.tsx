// ============================================================================
// v4.0: SSR Explorer — data fetched on server, HTML arrives with table
// No client-side fetch needed for first paint. Instant load like top explorers.
// ============================================================================

import ExplorerClient from './ExplorerClient';
import { getTransactions } from '../../../lib/db';
import { enrichActivityRows } from '@/lib/enrich-activity';

// SSR on every request — fresh blockchain data (not cached at build time)
export const dynamic = 'force-dynamic';

const PER_PAGE = 50;

export default async function ExplorerPage() {
  // SSR: fetch data on the server — arrives in HTML, zero client wait
  let initialData: Array<{
    hash: string; type: string; from: string; to: string;
    amount: string; block: number; timestamp: number; time: string;
    tokenContract?: string; tokenSymbol?: string; tokenLogo?: string;
  }> = [];
  let initialHeight = 0;
  let initialTotal = 0;

  try {
    const { transactions, total, currentHeight } = await getTransactions(
      1, PER_PAGE, 'desc', undefined, undefined
    );
    initialHeight = currentHeight;
    initialTotal = total;

    // Enrich rows (token icon/symbol/amount/click-through) via the shared helper — the
    // /api/activity polling feed uses the SAME helper so refreshed/paginated rows match.
    initialData = await enrichActivityRows(transactions);
  } catch (err) {
    console.error('[Explorer SSR] DB fetch failed, client will retry:', err);
  }

  return (
    <ExplorerClient
      initialData={initialData}
      initialHeight={initialHeight}
      initialTotal={initialTotal}
    />
  );
}

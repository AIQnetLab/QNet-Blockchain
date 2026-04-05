// ============================================================================
// v4.0: SSR Explorer — data fetched on server, HTML arrives with table
// No client-side fetch needed for first paint. Instant load like top explorers.
// ============================================================================

import ExplorerClient from './ExplorerClient';
import { getTransactions } from '../../../lib/db';
import { mapTxType, formatAmount } from '@/lib/tx-mapping';

// SSR on every request — fresh blockchain data (not cached at build time)
export const dynamic = 'force-dynamic';

const PER_PAGE = 50;
const DEFAULT_FILTERS = ['Transfer', 'Reward', 'Swap'];

export default async function ExplorerPage() {
  // SSR: fetch data on the server — arrives in HTML, zero client wait
  let initialData: Array<{
    hash: string; type: string; from: string; to: string;
    amount: string; block: number; timestamp: number; time: string;
  }> = [];
  let initialHeight = 0;
  let initialTotal = 0;

  try {
    const { transactions, total, currentHeight } = await getTransactions(
      1, PER_PAGE, 'desc', undefined, DEFAULT_FILTERS
    );
    initialHeight = currentHeight;
    initialTotal = total;
    initialData = transactions.map(tx => ({
      hash: tx.hash,
      type: mapTxType(tx.tx_type, tx.from_address),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(tx.amount),
      block: tx.block,
      timestamp: tx.timestamp,
      time: '',
    }));
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

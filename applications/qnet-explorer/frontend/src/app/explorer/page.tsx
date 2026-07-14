// ============================================================================
// v4.0: SSR Explorer — data fetched on server, HTML arrives with table
// No client-side fetch needed for first paint. Instant load like top explorers.
// ============================================================================

import ExplorerClient from './ExplorerClient';
import { getTransactions, getContractDeployByAddress } from '../../../lib/db';
import { mapTxType, formatAmount } from '@/lib/tx-mapping';
import { sanitizeLogo } from '@/lib/sanitize-logo';
import { formatTokenAmountWithSymbol } from '@/lib/token-format';

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

    // Resolve token metadata for the QRC-20 contracts referenced by ContractCall rows on THIS page
    // (bounded: unique contracts per 50-row page). Best-effort — a miss just leaves the native display.
    const contractSet = new Set<string>();
    for (const tx of transactions) {
      if (tx.tx_type === 'ContractCall' && tx.to_address) contractSet.add(tx.to_address);
    }
    const tokenMeta = new Map<string, { symbol: string; logo: string; decimals: number }>();
    await Promise.all(Array.from(contractSet).map(async (c) => {
      try {
        const dep = await getContractDeployByAddress(c);
        if (!dep?.data) return;
        const o = JSON.parse(dep.data);
        if (o && o.qrc20 === true) {
          tokenMeta.set(c, {
            symbol: typeof o.symbol === 'string' ? o.symbol : '',
            logo: sanitizeLogo(o.logo),
            decimals: typeof o.decimals === 'number' ? o.decimals : (Number(o.decimals) || 9),
          });
        }
      } catch { /* skip this contract — its rows fall back to native display */ }
    }));

    initialData = transactions.map((tx) => {
      const base = {
        hash: tx.hash,
        type: mapTxType(tx.tx_type, tx.from_address, tx.data),
        from: tx.from_address,
        to: tx.to_address || 'N/A',
        amount: formatAmount(tx.amount),
        block: tx.block,
        timestamp: tx.timestamp,
        time: '',
      };
      // Token-interaction row: attach the token identity (for its icon) and show the TOKEN amount +
      // symbol instead of the native 0 the ContractCall carries. Guarded — any parse issue keeps native.
      const meta = tx.to_address ? tokenMeta.get(tx.to_address) : undefined;
      if (meta && tx.tx_type === 'ContractCall') {
        let amount = base.amount;
        try {
          const call = tx.data ? JSON.parse(tx.data) : null;
          const method = call && typeof call.method === 'string' ? call.method : '';
          const args = call && Array.isArray(call.args) ? call.args : [];
          // ONLY value-moving methods carry a transfer amount; approve/mint/etc. must not render their
          // arg as a moved amount (e.g. approve(spender,allowance) is NOT a transfer). This is calldata
          // intent — per-token pages use the effect-sourced token_transfers index for exact history.
          if (method === 'transfer' || method === 'transferFrom') {
            const rawAmt = method === 'transferFrom' ? args[2] : args[1];
            // Base-unit amount: a well-formed dApp sends it as a STRING (exact past 2^53). If it arrived as
            // a bare JSON number, JSON.parse already truncated any value above 2^53 — only render when the
            // value is exact (a digit string, or a safe-range number); otherwise keep the native display
            // rather than show a precision-lost magnitude.
            if (typeof rawAmt === 'string' && /^\d+$/.test(rawAmt)) {
              amount = formatTokenAmountWithSymbol(rawAmt, meta.decimals, meta.symbol);
            } else if (typeof rawAmt === 'number' && Number.isSafeInteger(rawAmt)) {
              amount = formatTokenAmountWithSymbol(String(rawAmt), meta.decimals, meta.symbol);
            }
          }
        } catch { /* keep the native amount */ }
        return { ...base, amount, tokenContract: tx.to_address as string, tokenSymbol: meta.symbol, tokenLogo: meta.logo };
      }
      return base;
    });
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

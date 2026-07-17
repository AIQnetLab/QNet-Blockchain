import { getTransactions, getContractDeployByAddress } from '../../lib/db';
import { mapTxType, formatAmount } from './tx-mapping';
import { sanitizeLogo } from './sanitize-logo';
import { formatTokenAmountWithSymbol } from './token-format';

// ============================================================================
// Shared activity-row enrichment — single source of truth for BOTH the SSR
// explorer page and the /api/activity polling feed, so a QRC-20 row keeps its
// token icon, symbol amount, click-through and "Token Transfer" label across the
// first paint, every 5s refresh, and pagination (they must produce identical rows).
// ============================================================================

type RawTx = Awaited<ReturnType<typeof getTransactions>>['transactions'][number];
type TokenMeta = { symbol: string; logo: string; decimals: number };

export interface EnrichedActivityRow {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  timestamp: number;
  time: string;
  tokenContract?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
}

// Deploy metadata is immutable, so cache resolved QRC-20 hits process-wide (bounded
// by the number of distinct tokens). Misses are NOT cached — a contract not yet
// indexed must resolve on a later poll rather than be pinned as non-token forever.
const metaCache = new Map<string, TokenMeta>();

async function resolveTokenMeta(contract: string): Promise<TokenMeta | undefined> {
  const cached = metaCache.get(contract);
  if (cached) return cached;
  try {
    const dep = await getContractDeployByAddress(contract);
    if (!dep?.data) return undefined;
    const o = JSON.parse(dep.data);
    if (o && o.qrc20 === true) {
      const meta: TokenMeta = {
        symbol: typeof o.symbol === 'string' ? o.symbol : '',
        logo: sanitizeLogo(o.logo),
        decimals: typeof o.decimals === 'number' ? o.decimals : (Number(o.decimals) || 9),
      };
      metaCache.set(contract, meta);
      return meta;
    }
  } catch { /* not resolvable now — native fallback, retry next poll */ }
  return undefined;
}

export async function enrichActivityRows(transactions: RawTx[]): Promise<EnrichedActivityRow[]> {
  // Resolve token metadata for the QRC-20 contracts referenced by ContractCall rows on
  // THIS page (bounded: unique contracts per page). Best-effort — a miss leaves native display.
  const contractSet = new Set<string>();
  for (const tx of transactions) {
    if (tx.tx_type === 'ContractCall' && tx.to_address) contractSet.add(tx.to_address);
  }
  const tokenMeta = new Map<string, TokenMeta>();
  await Promise.all(Array.from(contractSet).map(async (c) => {
    const meta = await resolveTokenMeta(c);
    if (meta) tokenMeta.set(c, meta);
  }));

  return transactions.map((tx) => {
    const base: EnrichedActivityRow = {
      hash: tx.hash,
      type: mapTxType(tx.tx_type, tx.from_address, tx.data),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(tx.amount),
      block: tx.block,
      timestamp: tx.timestamp,
      time: '',
    };
    // Token-interaction row: attach token identity (icon/click-through) and show the TOKEN
    // amount + symbol instead of the native 0 a ContractCall carries. Only value-moving
    // methods carry a transfer amount (approve/mint/etc. must not render their arg as moved).
    const meta = tx.to_address ? tokenMeta.get(tx.to_address) : undefined;
    if (meta && tx.tx_type === 'ContractCall') {
      let amount = base.amount;
      try {
        const call = tx.data ? JSON.parse(tx.data) : null;
        const method = call && typeof call.method === 'string' ? call.method : '';
        const args = call && Array.isArray(call.args) ? call.args : [];
        if (method === 'transfer' || method === 'transferFrom') {
          const rawAmt = method === 'transferFrom' ? args[2] : args[1];
          // Base-unit amount: exact only as a digit string or a safe-range number; otherwise
          // keep native rather than show a precision-lost magnitude (JSON already truncated >2^53).
          if (typeof rawAmt === 'string' && /^\d+$/.test(rawAmt)) {
            amount = formatTokenAmountWithSymbol(rawAmt, meta.decimals, meta.symbol);
          } else if (typeof rawAmt === 'number' && Number.isSafeInteger(rawAmt)) {
            amount = formatTokenAmountWithSymbol(String(rawAmt), meta.decimals, meta.symbol);
          }
        }
      } catch { /* keep native amount */ }
      return { ...base, amount, tokenContract: tx.to_address as string, tokenSymbol: meta.symbol, tokenLogo: meta.logo };
    }
    return base;
  });
}

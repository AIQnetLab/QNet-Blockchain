import { getContractDeployByAddress, type TransactionRow } from '../../lib/db';
import { mapTxType } from './tx-mapping';
import { sanitizeLogo } from './sanitize-logo';

// Shared activity-row enrichment for the SSR page, the head snapshot and /api/activity, so a QRC-20
// row keeps its token icon, symbol, amount and click-through identically on every path. Amounts are raw (nano QNC,
// token base units with the token's decimals); the page writes them exactly (src/lib/explorer-view.ts rowAmount).

type RawTx = TransactionRow;
type TokenMeta = { symbol: string; logo: string; decimals: number };

export interface EnrichedActivityRow {
  hash: string;
  type: string;
  from: string;
  to: string;
  // The QNC moved, in nano QNC (a digit string: the column is exact past 2^53).
  amount_raw: string;
  block: number;
  txIndex: number;
  timestamp: number;
  time: string;
  tokenContract?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
  // A token transfer's amount in the token's base units, and its decimals.
  tokenAmountRaw?: string;
  tokenDecimals?: number;
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
      amount_raw: String(tx.amount || '0'),
      block: tx.block,
      txIndex: tx.tx_index,
      timestamp: tx.timestamp,
      time: '',
    };
    // Token-interaction row: attach token identity (icon/click-through) and the TOKEN amount
    // instead of the native 0 a ContractCall carries. Only value-moving methods carry a
    // transfer amount (approve/mint/etc. must not render their arg as moved).
    const meta = tx.to_address ? tokenMeta.get(tx.to_address) : undefined;
    if (meta && tx.tx_type === 'ContractCall') {
      let tokenAmountRaw: string | undefined;
      try {
        const call = tx.data ? JSON.parse(tx.data) : null;
        const method = call && typeof call.method === 'string' ? call.method : '';
        const args = call && Array.isArray(call.args) ? call.args : [];
        if (method === 'transfer' || method === 'transferFrom') {
          const rawAmt = method === 'transferFrom' ? args[2] : args[1];
          // Base-unit amount: exact only as a digit string or a safe-range number; otherwise
          // keep native rather than show a precision-lost magnitude (JSON already truncated >2^53).
          if (typeof rawAmt === 'string' && /^\d+$/.test(rawAmt)) tokenAmountRaw = rawAmt;
          else if (typeof rawAmt === 'number' && Number.isSafeInteger(rawAmt)) tokenAmountRaw = String(rawAmt);
        }
      } catch { /* keep native amount */ }
      const token = { tokenContract: tx.to_address as string, tokenSymbol: meta.symbol, tokenLogo: meta.logo };
      return tokenAmountRaw === undefined ? { ...base, ...token } : { ...base, ...token, tokenAmountRaw, tokenDecimals: meta.decimals };
    }
    return base;
  });
}

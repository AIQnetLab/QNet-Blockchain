import { NextRequest, NextResponse } from 'next/server';
import { getTransactionsByAddress, getAddressTokenTransfers, getContractDeployByAddress, getBatchCreditsByAddress } from '../../../../../lib/db';
import { mapTxType, formatAmount } from '@/lib/tx-mapping';
import { formatTokenAmount } from '@/lib/token-format';
import { sanitizeLogo } from '@/lib/sanitize-logo';

// ============================================================================
// PRODUCTION v3.0: PostgreSQL-based address data
// ============================================================================

// System addresses
const SYSTEM_ADDRESSES = ['system_rewards_pool', 'system_emission', 'genesis'];

export interface AddressData {
  address: string;
  balance: string;
  txCount: number;
  firstSeen: number;
  lastActive: number;
  isSystem?: boolean;
  nodeInfo?: {
    nodeId: string;
    nodeType: 'SUPER' | 'LIGHT';  // v3.18: FULL removed
    reputation: number;
    activatedAt: number;
    isActive: boolean;
  };
  tokens: Array<{
    symbol: string;
    name: string;
    contract_address: string;
    decimals: number;
    balance: string;
  }>;
  transactions: Array<{
    hash: string;
    type: string;
    from: string;
    to: string;
    amount: string;
    fee?: string;
    timestamp: number;
    block: number;
    status: 'confirmed' | 'pending';
  }>;
  // Decoded QRC token transfers touching this address (effect-sourced, not calldata).
  tokenTransfers: Array<{
    hash: string;
    from: string;
    to: string;
    kind: string;              // transfer | mint | burn
    direction: 'in' | 'out';   // relative to this address
    symbol: string;
    contract: string;
    logo: string;
    std: string;               // qrc20 | qrc721
    token_id: string;          // NFT id (qrc721); '' for qrc20
    amount: string;            // qrc20: scaled by decimals; qrc721: "#<token_id>"
    block: number;
    timestamp: number;
  }>;
}

// QRC-20 metadata parsed from a contract's ContractDeploy `data` JSON
// ({symbol,decimals,logo,qrc20}). Used to render token transfers without a node round-trip.
interface DeployMeta {
  symbol: string;
  decimals: number;
  logo: string;
}

function parseDeployMeta(dataStr: string | null): DeployMeta {
  let symbol = '';
  let decimals = 9; // node default
  let logo = '';
  if (dataStr) {
    try {
      const d = JSON.parse(dataStr) as { symbol?: unknown; decimals?: unknown; logo?: unknown };
      if (typeof d.symbol === 'string') symbol = d.symbol;
      if (typeof d.decimals === 'number' && Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 30) {
        decimals = d.decimals;
      }
      logo = sanitizeLogo(d.logo);
    } catch { /* keep defaults */ }
  }
  return { symbol, decimals, logo };
}

// Mapped QRC-20 token holding for the address page. Balance is scaled by the
// token's OWN decimals (u64 base units → human string, exact BigInt math).
type AddressToken = AddressData['tokens'][number];

// Raw token entry as returned by the node: GET /api/v1/account/{addr}/tokens
// -> { tokens: [{ contract_address, balance, name, symbol, decimals }] }
interface NodeTokenEntry {
  contract_address?: string;
  balance?: string | number;
  name?: string;
  symbol?: string;
  decimals?: number;
}

// Fetch and map this address's QRC-20 holdings from the node. Returns [] on any
// error (never throws) so it can run in parallel with the balance/tx fetch
// without failing the whole address response.
async function fetchAddressTokens(
  address: string,
  nodeApi: string,
  nodeHeaders: Record<string, string>
): Promise<AddressToken[]> {
  try {
    const res = await fetch(`${nodeApi}/api/v1/account/${address}/tokens`, {
      headers: nodeHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    const rawList: unknown = body?.tokens;
    if (!Array.isArray(rawList)) return [];

    return rawList.map((raw): AddressToken => {
      const t = raw as NodeTokenEntry;
      // Each token scales by ITS OWN decimals (default 9 to match the node).
      const decimals = typeof t.decimals === 'number' ? t.decimals : 9;
      return {
        symbol: t.symbol || '',
        name: t.name || '',
        contract_address: t.contract_address || '',
        decimals,
        // Node returns u64 base units; format with this token's decimals (no float, no 1e9).
        balance: formatTokenAmount(t.balance, decimals),
      };
    // Drop entries with no contract address (cannot link/identify them).
    }).filter(t => t.contract_address);
  } catch {
    return [];
  }
}

// Create system address data
function createSystemAddressData(address: string): AddressData {
  const now = Date.now();
  return {
    address,
    balance: '∞',
    txCount: 0,
    firstSeen: now,
    lastActive: now,
    isSystem: true,
    tokens: [],
    transactions: [],
    tokenTransfers: [],
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  
  if (!address) {
    return NextResponse.json({ success: false, error: 'Address required' }, { status: 400 });
  }
  
  // System addresses
  const isSystem = SYSTEM_ADDRESSES.includes(address) || address.startsWith('system_');
  if (isSystem) {
    return NextResponse.json({
      success: true,
      source: 'system',
      data: createSystemAddressData(address),
    });
  }
  
  // Validate EON address format
  const isValidEon = address.length >= 38 && address.includes('eon');
  if (!isValidEon) {
    return NextResponse.json({ success: false, error: 'Invalid EON address' }, { status: 400 });
  }
  
  // v3.50: Node API is the single source of truth for balance; PostgreSQL for TX
  // history. NODE_API/headers are declared here (not inside the try) so the catch
  // path can still make a best-effort token fetch when the DB read fails.
  const NODE_API = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
  const API_KEY = process.env.QNET_API_KEY || '';
  const nodeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) nodeHeaders['X-API-Key'] = API_KEY;

  try {
    // Parallel: node balance + node QRC-20 token holdings + PostgreSQL TX history + token transfers
    const [accountResponse, tokens, txResult, tokenTransferRows] = await Promise.all([
      fetch(`${NODE_API}/api/v1/account/${encodeURIComponent(address)}`, {
        headers: nodeHeaders,
        signal: AbortSignal.timeout(10000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetchAddressTokens(address, NODE_API, nodeHeaders),
      getTransactionsByAddress(address, 1, 100),
      getBatchCreditsByAddress(address, 100),
      getAddressTokenTransfers(address, 50),
    ]);

    const { transactions, total } = txResult;

    // Resolve each unique contract's QRC-20 metadata once (symbol/decimals/logo) from its ContractDeploy.
    const uniqueContracts = Array.from(new Set(tokenTransferRows.map(t => t.contract)));
    const metaEntries = await Promise.all(uniqueContracts.map(async (c): Promise<[string, DeployMeta]> => {
      const dep = await getContractDeployByAddress(c).catch(() => null);
      return [c, parseDeployMeta(dep?.data ?? null)];
    }));
    const metaByContract = new Map<string, DeployMeta>(metaEntries);

    // Map transfers to response rows (direction relative to this address). NFTs
    // (qrc721) render as "#<token_id>" and are NOT scaled by decimals; qrc20 amounts
    // stay scaled by the token's own decimals (exact string math).
    const tokenTransfers = tokenTransferRows.map(t => {
      const meta = metaByContract.get(t.contract) ?? { symbol: '', decimals: 9, logo: '' };
      let ts = Number(t.timestamp) || 0;
      if (ts > 0 && ts < 1e12) ts = ts * 1000;
      const isNft = t.std === 'qrc721';
      return {
        hash: t.tx_hash,
        from: t.from_address,
        to: t.to_address,
        kind: t.kind,
        direction: (t.to_address === address ? 'in' : 'out') as 'in' | 'out',
        symbol: meta.symbol,
        contract: t.contract,
        logo: meta.logo,
        std: t.std,
        token_id: t.token_id,
        amount: isNft ? `#${t.token_id}` : formatTokenAmount(t.amount, meta.decimals),
        block: t.block,
        timestamp: ts > 946684800000 ? ts : 0,
      };
    });
    
    // Balance from node (nanoQNC) — authoritative source
    let balance = 0;
    if (accountResponse && typeof accountResponse.balance === 'number') {
      balance = accountResponse.balance;
    } else if (accountResponse && accountResponse.balance) {
      balance = Number(accountResponse.balance) || 0;
    }
    
    // Calculate first seen, last active from transactions
    let firstSeen = 0;
    let lastActive = 0;
    
    if (transactions.length > 0) {
      for (const tx of transactions) {
        // Track timestamps (handle both seconds and milliseconds)
        let txTsMs = Number(tx.timestamp) || 0;
        if (txTsMs > 0 && txTsMs < 1e12) {
          txTsMs = txTsMs * 1000; // Convert seconds to milliseconds
        }
        
        // Only use valid timestamps (after 2000-01-01)
        if (txTsMs > 946684800000) {
          if (firstSeen === 0 || txTsMs < firstSeen) {
            firstSeen = txTsMs;
          }
          if (txTsMs > lastActive) {
            lastActive = txTsMs;
          }
        }
      }
    }
    
    // Map transactions to response format
    const creditRows = batchCredits.map(c => ({
      hash: c.tx_hash,
      from_address: c.from_address,
      to_address: c.to_address,
      amount: c.amount,
      timestamp: c.timestamp,
      block: c.block,
      tx_type: 'BatchTransfers',
      data: null as string | null,
      status: 'confirmed',
    }));
    // Incoming batch credits merged in (the envelope's to_address is a marker,
    // so these rows never appear via the plain to_address query).
    const merged = [...transactions, ...creditRows]
      .sort((a, b) => Number(b.block) - Number(a.block))
      .slice(0, 100);
    const txData = merged.map(tx => ({
      hash: tx.hash,
      type: mapTxType(tx.tx_type, tx.from_address, tx.data),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(Number(tx.amount) || 0),
      // Convert timestamp to milliseconds if needed, and ensure it's valid
      timestamp: (() => {
        let ts = Number(tx.timestamp) || 0;
        if (ts > 0 && ts < 1e12) {
          ts = ts * 1000; // Convert seconds to milliseconds
        }
        // Only return valid timestamps (after 2000-01-01)
        return ts > 946684800000 ? ts : 0;
      })(),
      block: tx.block,
      status: tx.status || 'confirmed',
    }));
    
    return NextResponse.json({
      success: true,
      source: 'node+postgresql',
      data: {
        address,
        balance: formatAmount(balance),
        txCount: total,
        firstSeen: firstSeen,
        lastActive: lastActive,
        tokens,
        transactions: txData,
        tokenTransfers,
      },
    });
  } catch {
    // PostgreSQL TX-history read failed (DB down / mid-resync). Degrade gracefully:
    // the node is authoritative for balance, so still serve balance + token holdings
    // and flag history as temporarily unavailable — the address page renders with real
    // data instead of hard-failing. A transient DB blip must not blank the whole page.
    const [accountResponse, tokens] = await Promise.all([
      fetch(`${NODE_API}/api/v1/account/${encodeURIComponent(address)}`, {
        headers: nodeHeaders,
        signal: AbortSignal.timeout(10000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetchAddressTokens(address, NODE_API, nodeHeaders),
    ]);
    if (!accountResponse) {
      // Node also unreachable (DB down + node blip): balance is genuinely unknown. Don't fabricate a
      // 0 balance as authoritative under a "balance is current" banner — fail honestly instead.
      return NextResponse.json({ success: false, error: 'Address data temporarily unavailable' }, { status: 503 });
    }
    let balance = 0;
    if (typeof accountResponse.balance === 'number') balance = accountResponse.balance;
    else if (accountResponse.balance) balance = Number(accountResponse.balance) || 0;
    return NextResponse.json({
      success: true,
      source: 'node',
      data: {
        address,
        balance: formatAmount(balance),
        txCount: 0,
        firstSeen: 0,
        lastActive: 0,
        historyUnavailable: true,   // TX history could not be read; balance is still authoritative
        tokens,
        transactions: [],
        tokenTransfers: [],
      },
    });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { searchQrc20DeploysByText } from '../../../../lib/db';

// ============================================================================
// Unified search resolver: one box → tx | block | address | token.
// ============================================================================
// The separate Tokens nav existed only because search never resolved tokens.
// This folds token lookup into the SAME search: a contract-shaped query is
// validated against the node token endpoint; a symbol/name is matched over the
// explorer's own PG contract-deploy index (same source as /api/tokens). No new
// node endpoint — the node already exposes /api/v1/token/{c} per-contract.

const NODE_API = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
const API_KEY = process.env.QNET_API_KEY || '';

function nodeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

interface SearchResult { type: 'tx' | 'block' | 'address' | 'token'; href: string; }

// Is `q` a QRC-20 contract on-chain? 200 + {token:{...}} ⇒ token, else not.
async function isToken(q: string): Promise<boolean> {
  try {
    // encodeURIComponent so a crafted `q` (containing '/', '?', '#', whitespace) cannot inject extra
    // path/query segments into this server→node request (SSRF/path-manipulation on the internal API).
    const res = await fetch(`${NODE_API}/api/v1/token/${encodeURIComponent(q)}`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !!(body?.success && body.token);
  } catch {
    return false;
  }
}

// First QRC-20 token whose symbol/name/contract matches `q` (case-insensitive),
// from the PG contract-deploy index. Returns the contract address or null.
async function findTokenBySymbolOrName(q: string): Promise<string | null> {
  const needle = q.toLowerCase();
  let rows;
  try {
    // DB-side text filter (bounded) instead of loading the newest-N deploys — an older token is still
    // findable by symbol/name at scale. The JS below confirms the qrc20 flag + exact/substring match.
    rows = await searchQrc20DeploysByText(q, 50);
  } catch {
    return null;
  }
  for (const row of rows) {
    const contract = row.to_address || '';
    if (!contract || !row.data) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.qrc20 !== true) continue;
    const symbol = typeof obj.symbol === 'string' ? obj.symbol.toLowerCase() : '';
    const name = typeof obj.name === 'string' ? obj.name.toLowerCase() : '';
    if (symbol === needle || name === needle ||
        symbol.includes(needle) || name.includes(needle) ||
        contract.toLowerCase() === needle) {
      return contract;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q) {
    return NextResponse.json({ success: false, error: 'Empty query' }, { status: 400 });
  }

  let result: SearchResult;

  if (q.length === 64 && /^[0-9A-Fa-f]+$/.test(q)) {
    // 64-hex ⇒ transaction hash.
    result = { type: 'tx', href: `/explorer/tx/${q}` };
  } else if (/^\d+$/.test(q)) {
    // Pure digits ⇒ block height.
    result = { type: 'block', href: `/explorer/block/${q}` };
  } else if (q.length >= 38 && q.includes('eon')) {
    // Address-shaped: a contract token routes to the token page, else a wallet.
    result = (await isToken(q))
      ? { type: 'token', href: `/explorer/token/${q}` }
      : { type: 'address', href: `/explorer/address/${q}` };
  } else {
    // Free text ⇒ a token symbol/name; else fall back to a tx-hash lookup.
    const contract = await findTokenBySymbolOrName(q);
    result = contract
      ? { type: 'token', href: `/explorer/token/${contract}` }
      : { type: 'tx', href: `/explorer/tx/${q}` };
  }

  return NextResponse.json({ success: true, ...result });
}

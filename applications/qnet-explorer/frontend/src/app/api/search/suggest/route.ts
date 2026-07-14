import { NextRequest, NextResponse } from 'next/server';
import { sanitizeLogo } from '@/lib/sanitize-logo';
import {
  getTransactionByHash,
  getBlockByHash,
  getContractDeployByAddress,
  searchQrc20DeploysByText,
  type ContractDeployRow,
} from '../../../../../lib/db';

// ============================================================================
// Live search suggestions: one box → up to N ranked candidates as the user types.
// ============================================================================
// Unlike /api/search (single best-match redirect on Enter), this returns a LIST so
// the client can show a dropdown (token by symbol/name, tx/block disambiguated by
// hash, address, token-by-contract). Empty list ⇒ client shows "Nothing found"
// instead of routing to a broken /tx/{q}. Pure DB point-lookups (+ ILIKE token
// search) — no node round-trip, so it stays cheap enough to call on every keystroke.

export interface Suggestion {
  type: 'tx' | 'block' | 'address' | 'token';
  label: string;
  sublabel?: string;
  href: string;
  // Token rows carry these so the client renders a real icon (logo) or a generated avatar.
  symbol?: string;
  address?: string;
  logo?: string;
}

const MAX_RESULTS = 8;

function shorten(s: string): string {
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

// Parse a ContractDeploy row's `data` JSON; return {symbol,name} iff it is a QRC-20.
function parseQrc20(row: ContractDeployRow): { symbol: string; name: string; logo: string } | null {
  if (!row.data) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.data); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.qrc20 !== true) return null;
  return {
    symbol: typeof o.symbol === 'string' ? o.symbol : '',
    name: typeof o.name === 'string' ? o.name : '',
    // Logo from raw deploy calldata — sanitized to the node's on-chain rule (clean-https | emoji/label)
    // so it carries the same guarantee as the node value regardless of where it is later rendered.
    logo: sanitizeLogo(o.logo),
  };
}

export async function GET(request: NextRequest) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q || q.length < 1) {
    return NextResponse.json({ success: true, results: [] });
  }

  const results: Suggestion[] = [];
  const isDigits = /^\d+$/.test(q);
  const isHex64 = q.length === 64 && /^[0-9A-Fa-f]+$/.test(q);
  const isAddr = q.length >= 38 && q.toLowerCase().includes('eon');

  if (isDigits) {
    // Pure digits ⇒ block height.
    results.push({ type: 'block', label: `Block #${q}`, sublabel: 'Block height', href: `/explorer/block/${q}` });
  } else if (isHex64) {
    // 64-hex is ambiguous: a tx hash OR a block hash. Probe both and offer whatever exists.
    const [tx, blk] = await Promise.all([
      getTransactionByHash(q).catch(() => null),
      getBlockByHash(q).catch(() => null),
    ]);
    if (tx) results.push({ type: 'tx', label: 'Transaction', sublabel: shorten(q), href: `/explorer/tx/${q}` });
    if (blk) results.push({ type: 'block', label: `Block #${blk.height}`, sublabel: 'matched by hash', href: `/explorer/block/${blk.height}` });
    if (!tx && !blk) {
      // Neither indexed yet — most 64-hex queries are tx hashes; offer it as the best guess.
      results.push({ type: 'tx', label: 'Transaction', sublabel: `${shorten(q)} · not yet indexed`, href: `/explorer/tx/${q}` });
    }
  } else if (isAddr) {
    // Address-shaped: a QRC-20 contract routes to its token page; always also offer the address view.
    let deploy: ContractDeployRow | null = null;
    try { deploy = await getContractDeployByAddress(q); } catch { deploy = null; }
    const tok = deploy ? parseQrc20(deploy) : null;
    if (tok) {
      results.push({ type: 'token', label: tok.symbol || 'Token', sublabel: `${tok.name || 'QRC-20'} · ${shorten(q)}`, href: `/explorer/token/${q}`, symbol: tok.symbol, address: q, logo: tok.logo });
    }
    results.push({ type: 'address', label: 'Address', sublabel: shorten(q), href: `/explorer/address/${q}` });
  }

  // Free-text ⇒ token symbol/name matches (skip for the exact-shape cases handled above).
  if (!isDigits && !isHex64 && !isAddr && q.length >= 2) {
    let rows: ContractDeployRow[] = [];
    try { rows = await searchQrc20DeploysByText(q, 12); } catch { rows = []; }
    const needle = q.toLowerCase();
    const seen = new Set<string>();
    for (const row of rows) {
      const contract = row.to_address;
      if (!contract || seen.has(contract)) continue;
      const tok = parseQrc20(row);
      if (!tok) continue;
      const sym = tok.symbol.toLowerCase();
      const name = tok.name.toLowerCase();
      if (sym.includes(needle) || name.includes(needle) || contract.toLowerCase() === needle) {
        seen.add(contract);
        results.push({
          type: 'token',
          label: tok.symbol || 'Token',
          sublabel: `${tok.name || 'QRC-20'} · ${shorten(contract)}`,
          href: `/explorer/token/${contract}`,
          symbol: tok.symbol,
          address: contract,
          logo: tok.logo,
        });
        if (results.length >= MAX_RESULTS) break;
      }
    }
  }

  return NextResponse.json({ success: true, results: results.slice(0, MAX_RESULTS) });
}

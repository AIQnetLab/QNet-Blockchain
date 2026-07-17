import { NextResponse } from 'next/server';
import { formatTokenAmount } from '@/lib/token-format';

// ============================================================================
// Native QNC overview: node /api/v1/richlist (top-N holders + total/circulating
// supply). QNC is the native coin (no contract) — this is the coin's rich list,
// the analog of a SOL/ETH holders view, not a QRC-20 token page.
// ============================================================================

const NODE_API = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
const API_KEY = process.env.QNET_API_KEY || '';

function nodeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

// nanoQNC (u64 base units, 9 decimals) → exact QNC decimal string (BigInt, >2^53 safe).
const qnc = (raw: unknown): string =>
  formatTokenAmount(typeof raw === 'string' ? raw : String(raw ?? '0'), 9);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);

  try {
    const res = await fetch(`${NODE_API}/api/v1/richlist?limit=${limit}`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`node ${res.status}`);
    const body = await res.json();
    if (!body?.success) throw new Error(body?.error || 'richlist unavailable');

    const holders = Array.isArray(body.holders)
      ? body.holders.map((h: { address?: string; balance_raw?: string; percent?: string }) => ({
          address: h.address || '',
          balance: qnc(h.balance_raw),   // exact QNC, no unit — the page appends " QNC" + icon
          percent: h.percent || '0',
        }))
      : [];

    return NextResponse.json({
      success: true,
      total_supply: qnc(body.total_supply_raw),
      circulating: qnc(body.circulating_raw),
      burned: qnc(body.burned_raw),
      holder_count: typeof body.holder_count === 'number' ? body.holder_count : holders.length,
      holders,
      source: body.source || 'node',
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

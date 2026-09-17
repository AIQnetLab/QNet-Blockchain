import { NextRequest, NextResponse } from 'next/server';
import { getAddressHistoryPage, getContractDeployByAddress } from '../../../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../../../lib/rate-limit';
import { chainFeeNanoBig } from '@/lib/fee';
import { parseDeployMeta, type DeployMeta } from '@/lib/deploy-meta';

export const dynamic = 'force-dynamic';

// The wallet's history feed: everything the address sent or received, newest first, one keyset page at
// a time (`cursor` = the `next_cursor` of the previous page). Amounts are raw (nano QNC, or token base
// units with the token's declared decimals), so the client does its own exact formatting.

const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW = 60 * 1000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const rl = rateLimit(getClientIdentifier(request), RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetTime - Date.now()) / 1000)) } });
  }
  const { address } = await params;
  const q = new URL(request.url).searchParams;
  const limit = q.get('limit') === null ? 50 : Number(q.get('limit'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ success: false, error: 'limit must be an integer between 1 and 100' }, { status: 400 });
  }

  let page;
  try {
    page = await getAddressHistoryPage(address, q.get('cursor'), limit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/^Invalid |required/.test(msg)) return NextResponse.json({ success: false, error: msg }, { status: 400 });
    return NextResponse.json({ success: false, error: 'History is temporarily unavailable' }, { status: 503 });
  }

  const contracts = [...new Set(page.rows.filter(r => r.source === 'token' && r.contract).map(r => r.contract as string))];
  const metas = new Map<string, DeployMeta>(await Promise.all(contracts.map(async c =>
    [c, parseDeployMeta((await getContractDeployByAddress(c).catch(() => null))?.data ?? null)] as [string, DeployMeta])));

  const items = page.rows.map(r => {
    const ts = r.timestamp > 0 && r.timestamp < 1e12 ? r.timestamp * 1000 : r.timestamp;
    const systemSender = r.from_address.startsWith('system_') || r.from_address === 'genesis';
    const fee = r.source === 'tx' && !systemSender
      ? chainFeeNanoBig(BigInt(r.gas_price || '0'), BigInt(r.gas_limit || '0'), true).toString()
      : '0';
    const meta = r.contract ? metas.get(r.contract) : undefined;
    return {
      source: r.source,
      hash: r.hash,
      idx: r.idx,
      block: r.block,
      timestamp: ts > 946684800000 ? ts : 0,
      from: r.from_address,
      to: r.to_address,
      amount: r.amount,
      tx_type: r.tx_type,
      fee,
      ...(r.source === 'token' ? {
        contract: r.contract, kind: r.kind, std: r.std, token_id: r.token_id,
        symbol: meta?.symbol ?? '', decimals: meta?.decimals ?? 9, logo: meta?.logo ?? '',
      } : {}),
    };
  });

  return NextResponse.json(
    { success: true, address, items, next_cursor: page.nextCursor },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

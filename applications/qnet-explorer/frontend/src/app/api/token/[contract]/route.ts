import { NextRequest, NextResponse } from 'next/server';
import { getContractTokenTransfers } from '../../../../../lib/db';
import { formatTokenAmount } from '@/lib/token-format';
import { sanitizeLogo } from '@/lib/sanitize-logo';

// ============================================================================
// QRC-20 token detail: node /api/v1/token/{contract} + recent transfers
// ============================================================================
// Reuses the same NODE_API env + header pattern as the address route (single
// source of truth for on-chain token metadata). Recent transfers come from the
// explorer's effect-sourced token_transfers index (real transfer logs, not
// decoded calldata intent).

const NODE_API = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
const API_KEY = process.env.QNET_API_KEY || '';

function nodeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

// Node token metadata: GET /api/v1/token/{contract}
// -> { success, token: { contract_address, name, symbol, decimals, total_supply, deployer, deployed_at } }
interface TokenInfo {
  contract_address: string;
  standard: string;       // 'qrc20' | 'qrc721' — authoritative token standard from node state
  name: string;
  symbol: string;
  decimals: number;
  logo: string;           // on-chain logo (emoji / https URL); '' ⇒ client renders a generated avatar
  total_supply: string;   // formatted by the token's own decimals
  total_supply_raw: string;
  total_minted: string;   // lifetime minted, formatted
  total_burned: string;   // lifetime burned, formatted
  deployer: string;
  deployed_at: string;
}

interface TokenTransfer {
  hash: string;
  from: string;        // '' ⇒ mint
  to: string;          // '' ⇒ burn
  std: string;         // qrc20 | qrc721
  token_id: string;    // NFT id (qrc721); '' for qrc20
  amount: string;      // qrc20: formatted by decimals; qrc721: "#<token_id>"
  amountRaw: string;   // u64 base-unit digit string (exact)
  method: string;      // transfer | mint | burn
  block: number;
  timestamp: number;
  status: string;
  fee: string;         // effect rows carry no per-transfer gas
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contract: string }> }
) {
  const { contract } = await params;

  if (!contract) {
    return NextResponse.json({ success: false, error: 'Contract address required' }, { status: 400 });
  }

  // Recent-transfers page size (Load-more): default 50, capped at 500.
  const txLimit = Math.min(
    Math.max(parseInt(new URL(request.url).searchParams.get('tx') || '50', 10) || 50, 1),
    500,
  );

  // Fetch token metadata from the node (authoritative on-chain state).
  let info: TokenInfo | null = null;
  try {
    const res = await fetch(`${NODE_API}/api/v1/token/${encodeURIComponent(contract)}`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.success && body.token) {
        const t = body.token as {
          contract_address?: string; standard?: string; name?: string; symbol?: string; logo?: string;
          decimals?: number; total_supply?: number | string; deployer?: string; deployed_at?: string;
          total_minted?: number | string; total_burned?: number | string;
        };
        const decimals = typeof t.decimals === 'number' ? t.decimals : 9;
        // total_supply is a u64 base-unit amount. The node now emits it as a JSON
        // STRING, so res.json() hands us the exact digit string — pass it straight
        // to formatTokenAmount with NO Number() round-trip (>2^53 safe). A number
        // (legacy small values) is stringified without float error via toString.
        let totalSupplyRaw = '0';
        if (typeof t.total_supply === 'string') {
          totalSupplyRaw = t.total_supply.trim() || '0';
        } else if (typeof t.total_supply === 'number' && Number.isFinite(t.total_supply)) {
          totalSupplyRaw = Math.trunc(t.total_supply).toString();
        }
        // Lifetime emission counters (base-unit digit strings, u128-safe); same parse as supply.
        const rawStr = (v: number | string | undefined): string =>
          typeof v === 'string' ? (v.trim() || '0')
          : (typeof v === 'number' && Number.isFinite(v)) ? Math.trunc(v).toString() : '0';
        info = {
          contract_address: t.contract_address || contract,
          standard: t.standard || 'qrc20',
          name: t.name || '',
          symbol: t.symbol || '',
          logo: sanitizeLogo(t.logo),
          decimals,
          total_supply: formatTokenAmount(totalSupplyRaw, decimals),
          total_supply_raw: totalSupplyRaw,
          total_minted: formatTokenAmount(rawStr(t.total_minted), decimals),
          total_burned: formatTokenAmount(rawStr(t.total_burned), decimals),
          deployer: t.deployer || '',
          deployed_at: t.deployed_at || '',
        };
      }
    }
  } catch {
    // fall through — info stays null, handled below
  }

  if (!info) {
    return NextResponse.json(
      { success: false, error: 'Token not found or not a QRC-20 contract' },
      { status: 404 }
    );
  }

  // Recent transfers: real transfer logs from the effect-sourced token_transfers
  // index (success-gated). Amount is a u64 base-unit string, scaled by the token's
  // own decimals via the exact string helper.
  let transfers: TokenTransfer[] = [];
  try {
    const rows = await getContractTokenTransfers(contract, txLimit);
    transfers = rows.map((r): TokenTransfer => {
      let ts = Number(r.timestamp) || 0;
      if (ts > 0 && ts < 1e12) ts = ts * 1000;
      const isNft = r.std === 'qrc721';
      return {
        hash: r.tx_hash,
        from: r.from_address,
        to: r.to_address,
        std: r.std,
        token_id: r.token_id,
        // NFTs (qrc721) render as "#<token_id>", never scaled by decimals.
        amount: isNft ? `#${r.token_id}` : formatTokenAmount(r.amount, info!.decimals),
        amountRaw: r.amount,
        method: r.kind,
        block: r.block,
        timestamp: ts > 946684800000 ? ts : 0,
        status: 'confirmed',
        fee: '',
      };
    });
  } catch {
    // DB unavailable — return metadata with an empty transfer list rather than failing.
    transfers = [];
  }

  return NextResponse.json({
    success: true,
    source: 'node+postgresql',
    data: {
      ...info,
      transfers,
    },
  });
}

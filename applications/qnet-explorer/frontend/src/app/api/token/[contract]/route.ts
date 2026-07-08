import { NextRequest, NextResponse } from 'next/server';
import { getTransactionsByAddress } from '../../../../../lib/db';
import { formatTokenAmount } from '@/lib/token-format';

// ============================================================================
// QRC-20 token detail: node /api/v1/token/{contract} + recent transfers
// ============================================================================
// Reuses the same NODE_API env + header pattern as the address route (single
// source of truth for on-chain token metadata). Recent transfers come from the
// explorer's PostgreSQL index (getTransactionsByAddress on the contract address
// returns every ContractCall whose `to` is this contract).

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
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;   // formatted by the token's own decimals
  total_supply_raw: string;
  deployer: string;
  deployed_at: string;
}

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;          // transfer recipient (decoded from tx data), NOT the contract
  amount: string;      // formatted by the token's own decimals
  amountRaw: string;
  method: string;      // transfer | transferFrom | mint | burn | approve | ...
  block: number;
  timestamp: number;
  status: string;
}

// Decode a QRC-20 ContractCall `data` JSON ({ "method", "args": [...] }).
// Returns the human recipient + raw base-unit amount for value-moving methods.
// Non-value methods (approve, etc.) still surface method + best-effort fields.
function decodeTransfer(dataStr: string | null): { method: string; to: string; amountRaw: string } | null {
  if (!dataStr) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { method?: unknown; args?: unknown };
  const method = typeof obj.method === 'string' ? obj.method : '';
  const args = Array.isArray(obj.args) ? obj.args : [];

  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

  switch (method) {
    case 'transfer':          // args: [to, amount]
      return { method, to: str(args[0]), amountRaw: str(args[1]) };
    case 'transferFrom':      // args: [from, to, amount]
      return { method, to: str(args[1]), amountRaw: str(args[2]) };
    case 'mint':              // args: [to, amount]
      return { method, to: str(args[0]), amountRaw: str(args[1]) };
    case 'burn':              // args: [amount]
      return { method, to: '', amountRaw: str(args[0]) };
    default:
      return { method, to: '', amountRaw: '' };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contract: string }> }
) {
  const { contract } = await params;

  if (!contract) {
    return NextResponse.json({ success: false, error: 'Contract address required' }, { status: 400 });
  }

  // Fetch token metadata from the node (authoritative on-chain state).
  let info: TokenInfo | null = null;
  try {
    const res = await fetch(`${NODE_API}/api/v1/token/${contract}`, {
      headers: nodeHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.success && body.token) {
        const t = body.token as {
          contract_address?: string; name?: string; symbol?: string;
          decimals?: number; total_supply?: number | string; deployer?: string; deployed_at?: string;
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
        info = {
          contract_address: t.contract_address || contract,
          name: t.name || '',
          symbol: t.symbol || '',
          decimals,
          total_supply: formatTokenAmount(totalSupplyRaw, decimals),
          total_supply_raw: totalSupplyRaw,
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

  // Recent transfers: every ContractCall targeting this contract (to_address =
  // contract). getTransactionsByAddress matches from OR to; for a contract the
  // matches are its calls. Decode each with the token's own decimals.
  let transfers: TokenTransfer[] = [];
  try {
    const { transactions } = await getTransactionsByAddress(contract, 1, 50);
    transfers = transactions
      .map((tx): TokenTransfer | null => {
        const decoded = decodeTransfer(tx.data);
        if (!decoded) return null;
        // Only surface QRC-20 value/ownership methods; skip unrelated calls.
        if (!['transfer', 'transferFrom', 'mint', 'burn', 'approve'].includes(decoded.method)) {
          return null;
        }
        let ts = Number(tx.timestamp) || 0;
        if (ts > 0 && ts < 1e12) ts = ts * 1000;
        return {
          hash: tx.hash,
          from: tx.from_address,
          to: decoded.to,
          amount: formatTokenAmount(decoded.amountRaw, info!.decimals),
          amountRaw: decoded.amountRaw,
          method: decoded.method,
          block: tx.block,
          timestamp: ts > 946684800000 ? ts : 0,
          status: tx.status || 'confirmed',
        };
      })
      .filter((t): t is TokenTransfer => t !== null);
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

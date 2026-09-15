import { NextRequest, NextResponse } from 'next/server';
import { getContractDeploys, type ContractDeployRow } from '../../../../lib/db';
import { formatTokenAmount } from '@/lib/token-format';

// ============================================================================
// Token directory: browse ALL deployed QRC-20 tokens
// ============================================================================
// The node exposes token data per-contract and per-holder but has NO "list all
// tokens" index. The explorer, however, already ingests every transaction into
// PostgreSQL — including the ContractDeploy that creates each token. The node
// derives the contract address on-chain and stores it as the deploy tx
// `to_address`, and writes the QRC-20 metadata into the deploy tx `data` JSON:
//   {"qrc20":true,"name","symbol","decimals","initial_supply","code_hash"}
// (see rpc.rs handle_qrc20_deploy / derive_contract_address). So we can build
// the full directory straight from the tx index — no node round-trip, no
// address re-derivation, no hardcoded list.

// One row in the token directory.
interface TokenListEntry {
  contract_address: string;
  name: string;
  symbol: string;
  decimals: number;
  deployer: string;
  total_supply: string;      // scaled by the token's own decimals (human string)
  total_supply_raw: string;  // exact u64 base-unit digit string
  deployed_block: number;
  deployed_at: number;       // ms epoch (0 if unknown)
  deploy_hash: string;
}

// Parsed QRC-20 metadata from a ContractDeploy `data` JSON. Returns null when the
// deploy is not a QRC-20 token (e.g. a raw WASM / QRC-721 deploy) or is undecodable.
function parseQrc20Deploy(dataStr: string | null): {
  name: string; symbol: string; decimals: number; initialSupplyRaw: string;
} | null {
  if (!dataStr) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Only QRC-20 token deploys carry the "qrc20": true marker.
  if (obj.qrc20 !== true) return null;

  const name = typeof obj.name === 'string' ? obj.name : '';
  const symbol = typeof obj.symbol === 'string' ? obj.symbol : '';
  const decimals =
    typeof obj.decimals === 'number' && Number.isInteger(obj.decimals) && obj.decimals >= 0
      ? obj.decimals
      : 9; // node default

  // initial_supply is a u64 base-unit amount. It may arrive as a JSON string
  // (exact, >2^53 safe) or a JSON number (small values). Keep the exact digit
  // string — never route a token amount through Number().
  const rawSupply = obj.initial_supply;
  let initialSupplyRaw = '0';
  if (typeof rawSupply === 'string') {
    initialSupplyRaw = rawSupply.trim() || '0';
  } else if (typeof rawSupply === 'number' && Number.isFinite(rawSupply)) {
    // Integer base units; toString avoids scientific notation for safe ranges.
    initialSupplyRaw = Math.trunc(rawSupply).toString();
  }

  return { name, symbol, decimals, initialSupplyRaw };
}

// Normalize a deploy timestamp (seconds or ms) → ms epoch, 0 if invalid.
function toMs(ts: number): number {
  let t = Number(ts) || 0;
  if (t > 0 && t < 1e12) t = t * 1000; // seconds → ms
  return t > 946684800000 ? t : 0;     // after 2000-01-01, else 0
}

// Build the deduped, sorted token list from raw ContractDeploy rows.
// Dedupe by contract address: if a contract were ever redeployed, the earliest
// deploy (lowest block) is canonical. Rows arrive newest-first, so we keep the
// LAST-seen row per address (the oldest).
function buildTokenList(rows: ContractDeployRow[]): TokenListEntry[] {
  const byContract = new Map<string, TokenListEntry>();

  for (const row of rows) {
    const contract = row.to_address || '';
    if (!contract) continue; // cannot identify/link a token without its address

    const meta = parseQrc20Deploy(row.data);
    if (!meta) continue; // not a QRC-20 token deploy

    const entry: TokenListEntry = {
      contract_address: contract,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      deployer: row.from_address,
      total_supply: formatTokenAmount(meta.initialSupplyRaw, meta.decimals),
      total_supply_raw: meta.initialSupplyRaw,
      deployed_block: Number(row.block) || 0,
      deployed_at: toMs(row.timestamp),
      deploy_hash: row.hash,
    };

    const existing = byContract.get(contract);
    // Keep the earliest deploy (lowest block) as canonical.
    if (!existing || entry.deployed_block < existing.deployed_block) {
      byContract.set(contract, entry);
    }
  }

  // Newest tokens first.
  return Array.from(byContract.values()).sort(
    (a, b) => b.deployed_block - a.deployed_block
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Pagination (bounded).
  const pageRaw = parseInt(searchParams.get('page') || '1', 10);
  const perPageRaw = parseInt(searchParams.get('perPage') || '25', 10);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const perPage =
    Number.isInteger(perPageRaw) && perPageRaw >= 1 && perPageRaw <= 100 ? perPageRaw : 25;

  // Optional case-insensitive search over symbol / name / contract address.
  const search = (searchParams.get('search') || '').trim().toLowerCase();

  try {
    // Pull the indexed ContractDeploy rows and build the token list in JS
    // (the deploy `data` is a TEXT column, so parsing lives here, not in SQL).
    const rows = await getContractDeploys(1000);
    let tokens = buildTokenList(rows);

    if (search) {
      tokens = tokens.filter(
        t =>
          t.symbol.toLowerCase().includes(search) ||
          t.name.toLowerCase().includes(search) ||
          t.contract_address.toLowerCase().includes(search)
      );
    }

    const total = tokens.length;
    const start = (page - 1) * perPage;
    const pageTokens = tokens.slice(start, start + perPage);

    return NextResponse.json({
      success: true,
      source: 'postgresql',
      data: {
        tokens: pageTokens,
        total,
        page,
        perPage,
        hasMore: start + perPage < total,
      },
    });
  } catch {
    // DB unavailable — surface an explicit failure (no fake/empty-as-success list).
    return NextResponse.json(
      { success: false, error: 'Failed to load token directory' },
      { status: 503 }
    );
  }
}

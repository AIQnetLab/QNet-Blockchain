import { NextRequest, NextResponse } from 'next/server';
import { getContractDeployByAddress, getTransactionsByAddress } from '../../../../../../lib/db';
import { formatTokenAmount } from '@/lib/token-format';

// ============================================================================
// QRC-20 holders: derived OFF-CHAIN from the explorer's PG tx index.
// ============================================================================
// No top-L1 chain enumerates token holders on-chain; the standard is to replay
// Transfer/Mint/Burn from an indexer DB. We do exactly that: the deploy credits
// initial_supply to the deployer, then each ContractCall moves balances. Result
// is the live holder set (net > 0), sorted, with % of circulating supply.
// Replay is BigInt-exact and mirrors the node apply semantics (self-transfer
// nets to zero, drained holders drop out). Bounded scan (relaunch-scale interim;
// an incremental holders table is the endgame at millions of holders).

const MAX_REPLAY_TX = 20000;

function argStr(args: unknown, i: number): string {
  if (!Array.isArray(args)) return '';
  const v = args[i];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function toBig(s: string): bigint { try { return BigInt(s.trim() || '0'); } catch { return 0n; } }

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ contract: string }> }
) {
  const { contract } = await params;
  if (!contract) {
    return NextResponse.json({ success: false, error: 'Contract address required' }, { status: 400 });
  }
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10) || 100, 1), 500);

  try {
    // Deploy row → deployer + initial_supply + decimals (seeds the balance map). Point-lookup by
    // contract address (NOT the newest-N deploy window) so an older token still seeds correctly.
    const deploy = await getContractDeployByAddress(contract);
    let decimals = 9;
    let mintable = false;
    let burnable = false;
    const owner = deploy?.from_address || '';
    const balances = new Map<string, bigint>();
    if (deploy?.data) {
      try {
        const meta = JSON.parse(deploy.data) as Record<string, unknown>;
        if (meta.qrc20 === true) {
          if (typeof meta.decimals === 'number') decimals = meta.decimals;
          mintable = meta.mintable === true;
          burnable = meta.burnable === true;
          const init = toBig(String(meta.initial_supply ?? '0'));
          if (init > 0n && owner) balances.set(owner, init);
        }
      } catch { /* not a qrc20 deploy */ }
    }

    // Replay every ContractCall targeting this contract. Page in ≤500-row chunks (getTransactionsByAddress
    // caps perPage at 500) up to MAX_REPLAY_TX.
    const PAGE = 500;
    const firstPage = await getTransactionsByAddress(contract, 1, PAGE);
    const transactions = [...firstPage.transactions];
    // Truncated only when the true total EXCEEDS the cap; total == cap means we replay every row.
    const truncatedByCap = firstPage.total > MAX_REPLAY_TX;
    for (let page = 2; transactions.length < MAX_REPLAY_TX && transactions.length < firstPage.total; page++) {
      const { transactions: rows } = await getTransactionsByAddress(contract, page, PAGE);
      if (rows.length === 0) break;
      transactions.push(...rows);
      if (transactions.length >= MAX_REPLAY_TX) break;
    }
    const bal = (a: string) => balances.get(a) || 0n;
    const add = (addr: string, delta: bigint) => {
      if (!addr) return;
      balances.set(addr, bal(addr) + delta);
    };
    // allowance[owner][spender] — needed to replay transferFrom with the SAME validity the node enforces.
    const allowance = new Map<string, Map<string, bigint>>();
    const allow = (o: string, s: string) => allowance.get(o)?.get(s) || 0n;
    const setAllow = (o: string, s: string, v: bigint) => {
      if (!allowance.has(o)) allowance.set(o, new Map());
      allowance.get(o)!.set(s, v);
    };

    // Replay must MIRROR node apply semantics, not just block-inclusion: the node applies NO state
    // change for a call it rejects (insufficient balance / allowance / non-mintable / non-burnable /
    // wrong owner), yet stores it as 'confirmed'. Applying its delta anyway fabricates phantom holders,
    // vanishes real ones, or inflates supply. So we simulate each op under the same rules, in block
    // order, and skip anything the node would reject. Dedup by hash first (reorg re-index dupes).
    const seenTx = new Set<string>();
    // Replay in apply (chronological) order. The row column is `block`; the query returns block DESC,
    // so re-sort ASC. No in-block index exists, so tie-break timestamp→nonce→hash (deterministic).
    const ordered = transactions
      .filter((tx) => !tx.hash || (!seenTx.has(tx.hash) && (seenTx.add(tx.hash), true)))
      .sort((a, b) => (Number(a.block || 0) - Number(b.block || 0))
                   || (Number(a.timestamp || 0) - Number(b.timestamp || 0))
                   || (Number(a.nonce || 0) - Number(b.nonce || 0))
                   || String(a.hash || '').localeCompare(String(b.hash || '')));

    for (const tx of ordered) {
      const st = String((tx as { status?: string }).status || '').toLowerCase();
      if (st && ['failed', 'reverted', 'rejected', 'error', 'dropped', 'invalid'].includes(st)) continue;
      if (!tx.data) continue;
      let parsed: { method?: unknown; args?: unknown };
      try { parsed = JSON.parse(tx.data); } catch { continue; }
      const method = typeof parsed.method === 'string' ? parsed.method : '';
      const args = parsed.args;
      const sender = tx.from_address;
      switch (method) {
        case 'transfer': {          // [to, amount] from = sender
          const to = argStr(args, 0); const amt = toBig(argStr(args, 1));
          if (amt <= 0n || bal(sender) < amt) break;   // node rejects insufficient balance
          add(sender, -amt); add(to, amt);
          break;
        }
        case 'approve': {           // [spender, amount] — sets allowance, no balance move
          setAllow(sender, argStr(args, 0), toBig(argStr(args, 1)));
          break;
        }
        case 'transferFrom':
        case 'transfer_from': {     // [from, to, amount] — spender = sender
          const from = argStr(args, 0); const to = argStr(args, 1); const amt = toBig(argStr(args, 2));
          if (amt <= 0n || bal(from) < amt || allow(from, sender) < amt) break; // balance + allowance
          add(from, -amt); add(to, amt); setAllow(from, sender, allow(from, sender) - amt);
          break;
        }
        case 'mint': {              // [to, amount] — owner-only, mintable-only
          if (!mintable || sender !== owner) break;
          add(argStr(args, 0), toBig(argStr(args, 1)));
          break;
        }
        case 'burn': {              // [amount] from = sender, burnable-only
          const amt = toBig(argStr(args, 0));
          if (!burnable || amt <= 0n || bal(sender) < amt) break;
          add(sender, -amt);
          break;
        }
        default: break;             // other methods do not move balances
      }
    }

    // Live holders = net > 0; circulating = their sum (matches the node's total_supply).
    const live = Array.from(balances.entries()).filter(([, v]) => v > 0n);
    const circulating = live.reduce((s, [, v]) => s + v, 0n);
    live.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

    const holders = live.slice(0, limit).map(([address, raw]) => ({
      address,
      balance: formatTokenAmount(raw.toString(), decimals),
      balance_raw: raw.toString(),
      // basis points of circulating, as a percent string (avoids float on huge supplies)
      percent: circulating > 0n ? (Number((raw * 10000n) / circulating) / 100).toFixed(2) : '0.00',
    }));

    return NextResponse.json({
      success: true,
      source: 'postgresql',
      data: {
        contract_address: contract,
        holder_count: live.length,
        circulating_raw: circulating.toString(),
        holders,
        truncated: truncatedByCap,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to derive holders' }, { status: 503 });
  }
}

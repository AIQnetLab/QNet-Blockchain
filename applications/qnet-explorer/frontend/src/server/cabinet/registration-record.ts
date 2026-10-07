// GET /api/cabinet/registration/:wallet[?type=super]: the burn facts of a wallet's light or super node registration,
// from the explorer's archive of the chain (the NodeRegistration transaction's burn, burner and amount, which the indexer
// keeps; src/indexer/transform.ts), and whose burn it is (`burnBy`). The chain holds them publicly; the nodes' public
// status does not carry them, and the nodes prune old blocks. My node's Node details derive the node's one activation
// code from them. A light node's registration is sent from its wallet, a super node's from the node's own id
// (super_node_ and 16 hex of the wallet). A registration archived before the indexer kept these facts has none: the
// answer then says only that the archive holds none.
//
// Whose burn a light registration's is: the wallet's row in the activation registry that holds this burn names it (a
// payment address's, or the extension's from the wallet's own Solana address). Without one, no payment key of this site
// made it, since every payment address's burn is announced in the registry before it leaves (shared contract C4); it is
// the burner's own once Solana holds it final and valid with the archive's burner as its fee payer and burn authority
// (burn-scan.ts checkBurn): a burn of the QNet extension from before the registry, of an earlier QNet Wallet, or one QNet
// Wallet registered with its owner bind v1. Once known it is kept (a registration's burn never changes), and so is a burn
// Solana holds failed, or final but not as that burner's own valid burn (null, not asked again for as long); the Solana
// reads share a small budget a minute for the whole server, past which the answer is null and the page reads again
// later. A super node's burn is always from the wallet's own Solana address.

import { isEonAddress } from '../../lib/qnet-provider.ts';
import { isSolanaSignature, lightNodeId, superNodeId, type NodeType } from '../../lib/qnet-link.ts';
import { decodeKey } from '../../lib/solana-message.ts';
import { isWholeBurn } from '../../lib/cabinet/burn-tx.ts';
import type { ArchivedRecord, BurnBy, RegistrationRecord } from '../../lib/cabinet/code-check.ts';
import type { ActivationRow, BurnChecker } from './activation-registry.ts';
import { memo } from './cache.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';

export const RECORD_CACHE_MS = 30_000;
// A wallet has one light node; a few rows cover a super registration from the same wallet.
export const ROWS = 4;
// Whose burn a registration's is, kept this long once known.
export const BURN_BY_CACHE_MS = 86_400_000;
// The Solana checks of whose burn it is, at most this many a minute for the whole server.
export const BURN_BY_CHECKS_PER_MINUTE = 30;

export type RecordView = ArchivedRecord;

// The archive's rows of the registrations sent from an address (a wallet, or a super node's id), newest first: the block
// and the kept facts.
export type RecordLookup = (from: string) => Promise<{ block: unknown; data: unknown }[]>;

// The archive's registration of a wallet, before whose burn it is.
export type ArchiveRow = { found: true; record: RegistrationRecord } | { found: false };

// The wallet's row in the activation registry once it has a burn (activation-api.ts paymentRecord): null without one,
// 'unavailable' when the database cannot answer.
export type BurnRowReader = (wallet: string) => Promise<ActivationRow | null | 'unavailable'>;

// Whose burn the wallet's light registration is (createBurnByReader); null while it cannot be told.
export type BurnByReader = (wallet: string, record: RegistrationRecord) => Promise<BurnBy | null>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The newest row that is this wallet's node registration of `type` with its burn facts.
export function recordFrom(wallet: string, rows: { block: unknown; data: unknown }[], type: NodeType = 'light'): ArchiveRow {
  const nodeId = type === 'super' ? superNodeId(wallet) : lightNodeId(wallet);
  for (const row of rows) {
    const d = isObject(row.data) ? row.data : null;
    const height = typeof row.block === 'string' && /^\d{1,15}$/.test(row.block) ? Number(row.block) : row.block;
    if (!d || d.node_id !== nodeId || typeof d.node_type !== 'string' || d.node_type.toLowerCase() !== type) continue;
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) continue;
    if (!isSolanaSignature(d.burn_tx) || typeof d.burn_wallet !== 'string' || !decodeKey(d.burn_wallet) || !isWholeBurn(d.burn_amount)) continue;
    return { found: true, record: { height, burnTx: d.burn_tx, burner: d.burn_wallet, amount: d.burn_amount } };
  }
  return { found: false };
}

// Whose burn a light registration's is, from the wallet's registry row and the burn on Solana (the rule above); null when
// the registry or Solana cannot be read, or Solana does not hold that burn of that burner, final.
export async function resolveBurnBy(row: ActivationRow | null | 'unavailable', record: RegistrationRecord, check: BurnChecker): Promise<BurnBy | null> {
  if (row === 'unavailable') return null;
  if (row !== null && row.burnTx === record.burnTx) return row.way === 'payment' ? 'payment' : 'own';
  const got = await check(record.burnTx, { burner: record.burner, nodeType: 'light', amount: record.amount });
  return got?.kind === 'final' ? 'own' : null;
}

export interface BurnByOptions {
  row: BurnRowReader;
  check: BurnChecker;
  now?: () => number;
  perMinute?: number;
}

// One resolution in flight per registration, kept BURN_BY_CACHE_MS once known, and as long when Solana holds that burn
// failed or final but not as the burner's own valid one (`never`: a finalized transaction never changes, so it is not
// asked again); the Solana checks past the minute's budget answer nothing (not kept).
export function createBurnByReader({ row, check, now = Date.now, perMinute = BURN_BY_CHECKS_PER_MINUTE }: BurnByOptions): BurnByReader {
  const cache = memo<BurnBy | 'never' | null>(BURN_BY_CACHE_MS, now);
  const window = { start: 0, count: 0 };
  const budgeted: BurnChecker = (burnTx, expect) => {
    const t = now();
    if (t - window.start >= 60_000) Object.assign(window, { start: t, count: 0 });
    window.count += 1;
    return window.count <= perMinute ? check(burnTx, expect) : Promise.resolve(null);
  };
  return async (wallet, record) => {
    const got = await cache(`${wallet}:${record.burnTx}`, async () => {
      let settled = false;
      const checked: BurnChecker = async (burnTx, expect) => {
        const answer = await budgeted(burnTx, expect);
        settled = answer?.kind === 'invalid' || answer?.kind === 'failed';
        return answer;
      };
      try {
        return (await resolveBurnBy(await row(wallet), record, checked)) ?? (settled ? 'never' : null);
      } catch {
        return null;
      }
    }, (v) => v !== null);
    return got === 'never' ? null : got;
  };
}

export interface RecordReaderOptions extends GateOptions {
  gate?: Gate;
  lookup: RecordLookup;
  // Without it a light registration's `burnBy` is null.
  burnBy?: BurnByReader;
}

export interface RecordReader {
  read(request: Request, wallet: string, type?: string | null): Promise<Response>;
}

export function createRecordReader(options: RecordReaderOptions): RecordReader {
  const gate = options.gate ?? createGate(options);
  const cache = memo<RecordView | null>(RECORD_CACHE_MS, options.now ?? Date.now);
  const burnBy = options.burnBy ?? (async () => null);
  return {
    async read(request, wallet, type = null) {
      const refused = gate(request, 'registration');
      if (refused) return refused;
      if (!isEonAddress(wallet) || (type !== null && type !== 'light' && type !== 'super')) return cabinetJson(400, { error: 'invalid_request' });
      const nodeType: NodeType = type === 'super' ? 'super' : 'light';
      const view = await cache(`${nodeType}:${wallet}`, async (): Promise<RecordView | null> => {
        let row: ArchiveRow;
        try {
          row = recordFrom(wallet, await options.lookup(nodeType === 'super' ? superNodeId(wallet) : wallet), nodeType);
        } catch {
          return null;
        }
        if (!row.found) return row;
        return { found: true, record: row.record, burnBy: nodeType === 'super' ? 'own' : await burnBy(wallet, row.record).catch(() => null) };
      }, (v) => v !== null);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },
  };
}

// The explorer database's rows (the indexer's `transactions` table; the index on from_address, block serves it).
export const RECORD_SQL = `SELECT block::text AS block, tx_type_data AS data FROM transactions
 WHERE from_address = $1 AND tx_type = 'NodeRegistration' ORDER BY block DESC, tx_index DESC LIMIT ${ROWS}`;

const GLOBAL_KEY = Symbol.for('qnet.cabinetRecordReader');

// `owner`: the activation registry's row of a wallet and the burn's Solana check, for whose burn a light registration's is.
export function cabinetRecordReader(lookup: RecordLookup, owner?: { row: BurnRowReader; check: BurnChecker }): RecordReader {
  const holder = globalThis as unknown as Record<symbol, RecordReader | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createRecordReader({ gate: cabinetGate(), lookup, burnBy: owner ? createBurnByReader(owner) : undefined });
  holder[GLOBAL_KEY] = created;
  return created;
}

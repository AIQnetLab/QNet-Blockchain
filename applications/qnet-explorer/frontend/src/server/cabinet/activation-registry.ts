// The activation registry (unified plan R1 and R6; shared contracts C3 and C4): one row per QNet wallet in the explorer
// database (migrations/005_cabinet_activations.sql), so that a wallet gets exactly one activation burn and one code, for
// a light or a super node, chosen once, whichever browser, device or client starts it.
//
// A row is a reservation (one outstanding burn per wallet, RESERVATION_TTL_MS, made only with the wallet's own signed
// reservation, burn-record.ts verifyReservationProof; the payment key and the QNet extension sign a burn only under
// one), a burn on its way (`sending`: announced before it was sent, the extension's with the wallet's proof, a payment
// address's with the payment key's v2 owner bind of the reserved wallet), or the verified record of the wallet's burn
// (`recorded`): the burn final and valid on Solana (burn-scan.ts) with its proof, the wallet's own keys for a burn of the
// extension (burn-record.ts verifyBurnRecordProof), the wallet's signed reservation and the owner bind for a payment
// address's burn. A record is permanent: nothing releases a burn. Nobody can plant a record for another wallet. Each step
// is one statement that compares and sets (PgStore), so two browsers racing for one wallet cannot both hold it;
// MemoryStore is the same rules in memory, for the tests.

import { randomBytes } from 'node:crypto';
import {
  SETTLE_AFTER_MS, recordCode, verifyBurnRecordProof, type ActivationRecordView, type BurnFacts, type BurnWay, type RecordState, type ScanView,
} from '../../lib/cabinet/burn-record.ts';
import { verifyOwnerBindV2 } from '../../lib/cabinet/registration.ts';
import { MLDSA65_PUBLIC_KEY_BYTES, decodeB64url, type NodeType } from '../../lib/qnet-link.ts';
import type { BurnCheck, BurnExpectation } from './burn-scan.ts';

export type RowState = Exclude<RecordState, 'none'>;

export interface ActivationRow {
  wallet: string;
  state: RowState;
  nodeType: NodeType;
  way: BurnWay;
  burner: string;
  burnAmount: number;
  reservation: string | null;
  reservedAt: number | null;
  expiresAt: number | null;
  burnTx: string | null;
  announcedAt: number | null;
  burnSlot: number | null;
  burnedAt: number | null;
  recordedAt: number | null;
  proof: Record<string, unknown> | null;
}

// The database cannot be reached, or the table is missing (42P01): every route then answers `unavailable`, and no client
// burns.
export class StoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('store_unavailable', { cause });
    this.name = 'StoreUnavailable';
  }
}

// The burn another wallet's row holds already (the unique burn_tx).
export class BurnTaken extends Error {
  constructor() {
    super('burn_taken');
    this.name = 'BurnTaken';
  }
}

export interface ReserveInput {
  wallet: string;
  nodeType: NodeType;
  way: BurnWay;
  burner: string;
  burnAmount: number;
  reservation: string;
  // The wallet's signed reservation {pk, sig, time} (activation-api.ts checked it).
  proof: Record<string, unknown>;
}

export interface AnnounceInput {
  // Absent for a payment address's burn: its reservation names the wallet.
  wallet?: string;
  reservation: string;
  way: BurnWay;
  burner: string;
  burnAmount: number;
  burnTx: string;
  proof: Record<string, unknown> | null;
}

export type SettleNext = { state: 'recorded'; burnSlot: number | null; burnedAt: number | null };

export interface ActivationStore {
  get(wallet: string): Promise<ActivationRow | null>;
  // The row that holds this reservation, or null.
  byReservation(reservation: string): Promise<ActivationRow | null>;
  // One statement: a new reservation, or one in place of an expired reservation without a burn. Null when another client
  // holds the wallet.
  reserve(input: ReserveInput): Promise<{ reservation: string; expiresAt: number } | null>;
  // One statement: the reservation's row, still reserved, without a burn, not expired, of this way, burner and amount,
  // moves to `sending` with the burn. The wallet, or null.
  announce(input: AnnounceInput): Promise<{ wallet: string; announcedAt: number } | null>;
  // The `sending` row of that burn becomes `next`, or goes (null). False when it is no longer that row.
  settle(wallet: string, burnTx: string, next: SettleNext | null): Promise<boolean>;
  // The row becomes `next` only while it still is `expected` (null: no row). False when another step came first.
  record(next: ActivationRow, expected: ActivationRow | null): Promise<boolean>;
  // Deletes the row while it holds this reservation without a burn; a burn is never released.
  release(wallet: string, reservation: string): Promise<void>;
  // Reservations without a burn an hour after they expired.
  sweep(): Promise<void>;
  // Whether a row names this burner as a payment address (a payment reservation, or its burn).
  knowsPaymentBurner(burner: string): Promise<boolean>;
}

// ---------------------------------------------------------------- PostgreSQL

export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const COLUMNS = `wallet, state, node_type, way, burner, burn_amount::text AS burn_amount, reservation, reserved_at, expires_at, burn_tx,
 announced_at, burn_slot::text AS burn_slot, burned_at, recorded_at, proof`;

export const SQL = {
  get: `SELECT ${COLUMNS} FROM cabinet_activations WHERE wallet = $1`,
  byReservation: `SELECT ${COLUMNS} FROM cabinet_activations WHERE reservation = $1`,
  reserve: `INSERT INTO cabinet_activations (wallet, state, node_type, way, burner, burn_amount, reservation, reserved_at, expires_at, proof)
 VALUES ($1, 'reserved', $2, $3, $4, $5, $6, now(), now() + interval '10 minutes', $7)
 ON CONFLICT (wallet) DO UPDATE SET state = 'reserved', node_type = EXCLUDED.node_type, way = EXCLUDED.way, burner = EXCLUDED.burner,
 burn_amount = EXCLUDED.burn_amount, reservation = EXCLUDED.reservation, reserved_at = EXCLUDED.reserved_at, expires_at = EXCLUDED.expires_at,
 burn_tx = NULL, announced_at = NULL, proof = EXCLUDED.proof, burn_slot = NULL, burned_at = NULL, recorded_at = NULL
 WHERE cabinet_activations.state = 'reserved' AND cabinet_activations.burn_tx IS NULL AND cabinet_activations.expires_at < now()
 RETURNING reservation, expires_at`,
  announce: `UPDATE cabinet_activations SET state = 'sending', burn_tx = $2, announced_at = now(), proof = $3
 WHERE reservation = $1 AND state = 'reserved' AND burn_tx IS NULL AND expires_at > now() AND way = $4 AND burner = $5 AND burn_amount = $6`,
  settleRecorded: `UPDATE cabinet_activations SET state = 'recorded', burn_slot = $3, burned_at = to_timestamp($4 / 1000.0), recorded_at = now(),
 expires_at = NULL WHERE wallet = $1 AND state = 'sending' AND burn_tx = $2`,
  settleGone: `DELETE FROM cabinet_activations WHERE wallet = $1 AND state = 'sending' AND burn_tx = $2`,
  insert: `INSERT INTO cabinet_activations (wallet, state, node_type, way, burner, burn_amount, reservation, reserved_at, expires_at, burn_tx,
 announced_at, burn_slot, burned_at, recorded_at, proof)
 VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), $10, to_timestamp($11 / 1000.0), $12,
 to_timestamp($13 / 1000.0), to_timestamp($14 / 1000.0), $15)
 ON CONFLICT (wallet) DO NOTHING RETURNING wallet`,
  replace: `UPDATE cabinet_activations SET state = $2, node_type = $3, way = $4, burner = $5, burn_amount = $6, reservation = $7,
 reserved_at = to_timestamp($8 / 1000.0), expires_at = to_timestamp($9 / 1000.0), burn_tx = $10, announced_at = to_timestamp($11 / 1000.0),
 burn_slot = $12, burned_at = to_timestamp($13 / 1000.0), recorded_at = to_timestamp($14 / 1000.0), proof = $15
 WHERE wallet = $1 AND state = $16 AND burn_tx IS NOT DISTINCT FROM $17 AND reservation IS NOT DISTINCT FROM $18 RETURNING wallet`,
  release: `DELETE FROM cabinet_activations WHERE wallet = $1 AND reservation = $2 AND state = 'reserved' AND burn_tx IS NULL`,
  sweep: `DELETE FROM cabinet_activations WHERE state = 'reserved' AND burn_tx IS NULL AND expires_at < now() - interval '1 hour'`,
  // Served by the partial index of migration 007.
  paymentBurner: `SELECT 1 FROM cabinet_activations WHERE burner = $1 AND way = 'payment' LIMIT 1`,
} as const;

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : Number.NaN;
  return Number.isFinite(t) ? t : null;
};
const whole = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// A row as the database gives it.
export function rowFrom(r: Record<string, unknown>): ActivationRow {
  return {
    wallet: String(r.wallet),
    state: r.state as RowState,
    nodeType: r.node_type as NodeType,
    way: r.way as BurnWay,
    burner: String(r.burner),
    burnAmount: whole(r.burn_amount) ?? 0,
    reservation: text(r.reservation),
    reservedAt: ms(r.reserved_at),
    expiresAt: ms(r.expires_at),
    burnTx: text(r.burn_tx),
    announcedAt: ms(r.announced_at),
    burnSlot: whole(r.burn_slot),
    burnedAt: ms(r.burned_at),
    recordedAt: ms(r.recorded_at),
    proof: r.proof !== null && typeof r.proof === 'object' ? (r.proof as Record<string, unknown>) : null,
  };
}

const errorCode = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

// Every statement of C4 through `query` (lib/db.ts): a unique burn_tx taken by another row is BurnTaken, any other
// failure StoreUnavailable.
export function createPgStore(query: SqlQuery): ActivationStore {
  const run = async (sql: string, params: unknown[]) => {
    try {
      return await query(sql, params);
    } catch (err) {
      if (errorCode(err) === '23505') throw new BurnTaken();
      throw new StoreUnavailable(err);
    }
  };
  const values = (r: ActivationRow): unknown[] => [
    r.wallet, r.state, r.nodeType, r.way, r.burner, r.burnAmount, r.reservation, r.reservedAt, r.expiresAt, r.burnTx, r.announcedAt, r.burnSlot,
    r.burnedAt, r.recordedAt, r.proof === null ? null : JSON.stringify(r.proof),
  ];
  return {
    async get(wallet) {
      const { rows } = await run(SQL.get, [wallet]);
      return rows[0] ? rowFrom(rows[0]) : null;
    },
    async byReservation(reservation) {
      const { rows } = await run(SQL.byReservation, [reservation]);
      return rows[0] ? rowFrom(rows[0]) : null;
    },
    async reserve(input) {
      const { rows } = await run(SQL.reserve, [input.wallet, input.nodeType, input.way, input.burner, input.burnAmount, input.reservation, JSON.stringify(input.proof)]);
      const at = rows[0] ? ms(rows[0].expires_at) : null;
      return rows[0] && at !== null ? { reservation: String(rows[0].reservation), expiresAt: at } : null;
    },
    async announce(input) {
      const params: unknown[] = [input.reservation, input.burnTx, input.proof === null ? null : JSON.stringify(input.proof), input.way, input.burner, input.burnAmount];
      const scoped = input.wallet === undefined ? SQL.announce : `${SQL.announce} AND wallet = $7`;
      if (input.wallet !== undefined) params.push(input.wallet);
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await run(`${scoped} RETURNING wallet, announced_at`, params));
      } catch (err) {
        if (err instanceof BurnTaken) return null;
        throw err;
      }
      const at = rows[0] ? ms(rows[0].announced_at) : null;
      return rows[0] && at !== null ? { wallet: String(rows[0].wallet), announcedAt: at } : null;
    },
    async settle(wallet, burnTx, next) {
      const params: unknown[] = [wallet, burnTx];
      let sql: string = SQL.settleGone;
      if (next?.state === 'recorded') {
        sql = SQL.settleRecorded;
        params.push(next.burnSlot, next.burnedAt);
      }
      const { rows } = await run(`${sql} RETURNING wallet`, params);
      return rows.length > 0;
    },
    async record(next, expected) {
      if (expected === null) {
        const { rows } = await run(SQL.insert, values(next));
        return rows.length > 0;
      }
      const { rows } = await run(SQL.replace, [...values(next), expected.state, expected.burnTx, expected.reservation]);
      return rows.length > 0;
    },
    async release(wallet, reservation) {
      await run(SQL.release, [wallet, reservation]);
    },
    async sweep() {
      await run(SQL.sweep, []);
    },
    async knowsPaymentBurner(burner) {
      const { rows } = await run(SQL.paymentBurner, [burner]);
      return rows.length > 0;
    },
  };
}

// ---------------------------------------------------------------- memory (the tests)

// The same compare-and-set rules in memory, one step at a time per wallet.
export function createMemoryStore({ now = Date.now, ttlMs = 600_000 }: { now?: () => number; ttlMs?: number } = {}): ActivationStore & { rows: Map<string, ActivationRow> } {
  const rows = new Map<string, ActivationRow>();
  const chains = new Map<string, Promise<unknown>>();
  // One step at a time per wallet: each waits for the one before it.
  const serial = <T>(wallet: string, step: () => T): Promise<T> => {
    const before = chains.get(wallet) ?? Promise.resolve();
    const run = before.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(step()), 0)));
    chains.set(wallet, run.catch(() => undefined));
    return run;
  };
  const copy = (r: ActivationRow | undefined): ActivationRow | null => (r ? { ...r, proof: r.proof ? { ...r.proof } : null } : null);
  const burnTaken = (wallet: string, burnTx: string | null) => burnTx !== null && [...rows.values()].some((r) => r.wallet !== wallet && r.burnTx === burnTx);
  const same = (a: ActivationRow, b: ActivationRow) => a.state === b.state && a.burnTx === b.burnTx && a.reservation === b.reservation;
  return {
    rows,
    get: (wallet) => serial(wallet, () => copy(rows.get(wallet))),
    byReservation: (reservation) => {
      const wallet = [...rows.values()].find((r) => r.reservation === reservation)?.wallet;
      return wallet === undefined ? Promise.resolve(null) : serial(wallet, () => {
        const cur = rows.get(wallet);
        return cur && cur.reservation === reservation ? copy(cur) : null;
      });
    },
    reserve: (input) => serial(input.wallet, () => {
      const t = now();
      const cur = rows.get(input.wallet);
      const free = !cur || (cur.state === 'reserved' && cur.burnTx === null && (cur.expiresAt ?? 0) < t);
      if (!free) return null;
      rows.set(input.wallet, {
        wallet: input.wallet, state: 'reserved', nodeType: input.nodeType, way: input.way, burner: input.burner, burnAmount: input.burnAmount,
        reservation: input.reservation, reservedAt: t, expiresAt: t + ttlMs, burnTx: null, announcedAt: null, burnSlot: null, burnedAt: null,
        recordedAt: null, proof: { ...input.proof },
      });
      return { reservation: input.reservation, expiresAt: t + ttlMs };
    }),
    announce: (input) => {
      const wallet = input.wallet ?? [...rows.values()].find((r) => r.reservation === input.reservation)?.wallet;
      if (wallet === undefined) return Promise.resolve(null);
      return serial(wallet, () => {
        const t = now();
        const cur = rows.get(wallet);
        if (!cur || cur.reservation !== input.reservation || cur.state !== 'reserved' || cur.burnTx !== null || (cur.expiresAt ?? 0) <= t) return null;
        if (cur.way !== input.way || cur.burner !== input.burner || cur.burnAmount !== input.burnAmount || burnTaken(wallet, input.burnTx)) return null;
        rows.set(wallet, { ...cur, state: 'sending', burnTx: input.burnTx, announcedAt: t, proof: input.proof });
        return { wallet, announcedAt: t };
      });
    },
    settle: (wallet, burnTx, next) => serial(wallet, () => {
      const cur = rows.get(wallet);
      if (!cur || cur.state !== 'sending' || cur.burnTx !== burnTx) return false;
      if (next === null) rows.delete(wallet);
      else rows.set(wallet, { ...cur, state: 'recorded', burnSlot: next.burnSlot, burnedAt: next.burnedAt, recordedAt: now(), expiresAt: null });
      return true;
    }),
    record: (next, expected) => serial(next.wallet, () => {
      const cur = rows.get(next.wallet);
      if (expected === null ? cur !== undefined : !cur || !same(cur, expected)) return false;
      if (burnTaken(next.wallet, next.burnTx)) throw new BurnTaken();
      rows.set(next.wallet, { ...next });
      return true;
    }),
    release: (wallet, reservation) => serial(wallet, () => {
      const cur = rows.get(wallet);
      if (cur && cur.reservation === reservation && cur.state === 'reserved' && cur.burnTx === null) rows.delete(wallet);
    }),
    sweep: async () => {
      const t = now();
      for (const r of [...rows.values()]) {
        const gone = r.state === 'reserved' && r.burnTx === null && (r.expiresAt ?? 0) < t - 3_600_000;
        if (gone) await serial(r.wallet, () => rows.delete(r.wallet));
      }
    },
    knowsPaymentBurner: async (burner) => [...rows.values()].some((r) => r.way === 'payment' && r.burner === burner),
  };
}

// ---------------------------------------------------------------- the rules (C3.1-C3.5)

// A sweep at most this often per process, started by any activation route.
export const SWEEP_EVERY_MS = 600_000;

export type BurnChecker = (burnTx: string, expect: BurnExpectation) => Promise<BurnCheck | null>;

export interface RegistryOptions {
  store: ActivationStore;
  check: BurnChecker;
  now?: () => number;
  // 32 lowercase hex for a reservation.
  newReservation?: () => string;
}

export type Blocking = 'has_burn' | 'burn_pending' | 'reserved';

export type ReserveOutcome =
  | { ok: true; reservation: string; until: number }
  | { ok: false; error: Blocking; row: ActivationRow | null };

export type AnnounceOutcome = { ok: true; until: number } | { ok: false; error: 'reservation' | 'invalid_proof' };

export type PaymentAnnounceOutcome = { ok: true; wallet: string } | { ok: false; error: 'reservation' | 'invalid_proof' };

export type RecordOutcome =
  | { ok: true; row: ActivationRow }
  | { ok: false; error: 'invalid_proof' | 'invalid_burn' | 'not_final' | 'other_burn' | 'unavailable'; row?: ActivationRow | null };

export interface ActivationRegistry {
  // The wallet's row, a `sending` row settled against Solana first; null for none. Throws StoreUnavailable.
  current(wallet: string): Promise<ActivationRow | null>;
  view(wallet: string, row: ActivationRow | null, scan?: ScanView | null): ActivationRecordView;
  blocking(row: ActivationRow | null): Blocking | null;
  // The atomic reservation with the wallet's signed reservation (the checks of the proof and outside the store, such as
  // the network, are the caller's).
  reserve(input: Omit<ReserveInput, 'reservation'>): Promise<ReserveOutcome>;
  announceExtension(wallet: string, reservation: string, burnTx: string, proof: unknown): Promise<AnnounceOutcome>;
  // The payment address's burn under its reservation with the payment key's v2 owner bind (POST /api/cabinet/send).
  announcePayment(reservation: string, burner: string, burnAmount: number, burnTx: string, ownerSig: string): Promise<PaymentAnnounceOutcome>;
  recordExtension(facts: BurnFacts, proof: unknown): Promise<RecordOutcome>;
  // The wallet's burn, once it has one (sending or recorded, a `sending` row settled first), for the registration of a
  // payment address's burn (POST /api/cabinet/register); null without one.
  paymentRecord(wallet: string): Promise<ActivationRow | null>;
  release(wallet: string, reservation: string): Promise<void>;
  // Whether a reservation of this site named `burner` as its payment address: only such an address's refund earns a read
  // pass (solana-proxy.ts send). Throws StoreUnavailable.
  knowsPaymentBurner(burner: string): Promise<boolean>;
}

// A proven row's burn is the wallet's: a record, or a burn on its way (the extension's came with the wallet's proof, a
// payment address's with its owner bind of the reserved wallet).
const proven = (r: ActivationRow) => r.state === 'recorded' || r.state === 'sending';

export function createActivationRegistry({ store, check, now = Date.now, newReservation = () => randomBytes(16).toString('hex') }: RegistryOptions): ActivationRegistry {
  let sweptAt = Number.NEGATIVE_INFINITY;
  const sweepLater = () => {
    if (now() - sweptAt < SWEEP_EVERY_MS) return;
    sweptAt = now();
    void store.sweep().catch(() => undefined);
  };

  const live = (r: ActivationRow): boolean => r.state !== 'reserved' || (r.burnTx === null && (r.expiresAt ?? 0) > now());

  // C3.1: a `sending` row against Solana. Landed, final and valid: recorded, whichever way (its proof came with the
  // announce). Failed, not a valid burn, or not found SETTLE_AFTER_MS after the announce: the row goes. Anything else, and
  // a Solana that cannot be read, leave it.
  async function settle(row: ActivationRow): Promise<ActivationRow | null> {
    if (row.state !== 'sending' || row.burnTx === null) return row;
    const got = await check(row.burnTx, { burner: row.burner, nodeType: row.nodeType, amount: row.burnAmount });
    if (got === null || got.kind === 'pending') return row;
    if (got.kind === 'missing' && now() - (row.announcedAt ?? 0) < SETTLE_AFTER_MS) return row;
    let next: SettleNext | null = null;
    if (got.kind === 'final') next = { state: 'recorded', burnSlot: got.burn.slot, burnedAt: got.burn.blockTime };
    await store.settle(row.wallet, row.burnTx, next);
    return store.get(row.wallet);
  }

  async function current(wallet: string): Promise<ActivationRow | null> {
    sweepLater();
    const row = await store.get(wallet);
    return row ? settle(row) : null;
  }

  function view(wallet: string, row: ActivationRow | null, scan: ScanView | null = null): ActivationRecordView {
    const none: ActivationRecordView = {
      wallet, state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, until: null, recordedAt: null, scan,
    };
    if (!row || !live(row)) return none;
    const base = { wallet, state: row.state, nodeType: row.nodeType, way: row.way, burnAmount: row.burnAmount, scan: null };
    if (row.state === 'reserved') return { ...base, burner: null, burnTx: null, code: null, until: row.expiresAt, recordedAt: null };
    const burnTx = row.burnTx as string;
    if (row.state === 'recorded') {
      return {
        ...base, burner: row.burner, burnTx, code: recordCode(row.way, row.nodeType, wallet, row.burner, burnTx, row.burnAmount), until: null,
        recordedAt: row.recordedAt ?? row.burnedAt ?? 0,
      };
    }
    return { ...base, burner: row.burner, burnTx, code: null, until: (row.announcedAt ?? 0) + SETTLE_AFTER_MS, recordedAt: null };
  }

  function blocking(row: ActivationRow | null): Blocking | null {
    if (!row || !live(row)) return null;
    if (row.state === 'recorded') return 'has_burn';
    return row.state === 'reserved' ? 'reserved' : 'burn_pending';
  }

  // The row as `next` in place of `expected`, as long as `decide` allows it for the row as it stands; a step that came
  // first is read again, a few times.
  async function upsert(wallet: string, decide: (row: ActivationRow | null) => ActivationRow | 'same' | 'other'): Promise<RecordOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await current(wallet);
      const next = decide(row && live(row) ? row : row?.state === 'reserved' ? null : row);
      if (next === 'same') return { ok: true, row: row as ActivationRow };
      if (next === 'other') return { ok: false, error: 'other_burn', row };
      try {
        if (await store.record(next, row)) return { ok: true, row: next };
      } catch (err) {
        if (err instanceof BurnTaken) return { ok: false, error: 'other_burn', row };
        throw err;
      }
    }
    return { ok: false, error: 'unavailable' };
  }

  const finalBurn = async (burnTx: string, expect: BurnExpectation): Promise<RecordOutcome | { slot: number | null; burnedAt: number | null }> => {
    const got = await check(burnTx, expect);
    if (got === null) return { ok: false, error: 'unavailable' };
    if (got.kind === 'pending' || got.kind === 'missing') return { ok: false, error: 'not_final' };
    if (got.kind !== 'final') return { ok: false, error: 'invalid_burn' };
    return { slot: got.burn.slot, burnedAt: got.burn.blockTime };
  };

  return {
    current,
    view,
    blocking,

    async reserve(input) {
      const row = await current(input.wallet);
      const blocked = blocking(row);
      if (blocked) return { ok: false, error: blocked, row };
      const got = await store.reserve({ ...input, reservation: newReservation() });
      if (got) return { ok: true, reservation: got.reservation, until: got.expiresAt };
      return { ok: false, error: 'reserved', row: await store.get(input.wallet) };
    },

    async announceExtension(wallet, reservation, burnTx, proof) {
      const row = await store.get(wallet);
      // The same burn announced again: its answer again.
      if (row && row.way === 'extension' && row.burnTx === burnTx && (row.state === 'sending' || row.state === 'recorded') && row.reservation === reservation) {
        return { ok: true, until: (row.announcedAt ?? now()) + SETTLE_AFTER_MS };
      }
      if (!row || row.way !== 'extension' || row.reservation !== reservation || row.state !== 'reserved' || row.burnTx !== null || (row.expiresAt ?? 0) <= now()) {
        return { ok: false, error: 'reservation' };
      }
      if (!verifyBurnRecordProof({ wallet, nodeType: row.nodeType, burner: row.burner, burnTx, burnAmount: row.burnAmount }, proof)) {
        return { ok: false, error: 'invalid_proof' };
      }
      const moved = await store.announce({
        wallet, reservation, way: 'extension', burner: row.burner, burnAmount: row.burnAmount, burnTx, proof: proof as Record<string, unknown>,
      });
      return moved ? { ok: true, until: moved.announcedAt + SETTLE_AFTER_MS } : { ok: false, error: 'reservation' };
    },

    // C4: the reservation's row, still a live payment reservation without a burn of this burner and amount, with the
    // wallet's signed reservation; the payment key's v2 owner bind must verify for the wallet, the key of that signed
    // reservation and this burn. Then the burn is announced with both, in one statement that compares and sets.
    async announcePayment(reservation, burner, burnAmount, burnTx, ownerSig) {
      sweepLater();
      const row = await store.byReservation(reservation);
      if (!row || row.state !== 'reserved' || row.way !== 'payment' || row.burnTx !== null || (row.expiresAt ?? 0) <= now()) return { ok: false, error: 'reservation' };
      if (row.burner !== burner || row.burnAmount !== burnAmount) return { ok: false, error: 'reservation' };
      const held = row.proof;
      const pk = held ? decodeB64url(held.pk, MLDSA65_PUBLIC_KEY_BYTES) : null;
      if (!held || !pk) return { ok: false, error: 'reservation' };
      if (!verifyOwnerBindV2(row.wallet, pk, burnTx, burner, ownerSig)) return { ok: false, error: 'invalid_proof' };
      const moved = await store.announce({
        wallet: row.wallet, reservation, way: 'payment', burner, burnAmount, burnTx, proof: { pk: held.pk, sig: held.sig, time: held.time, ownerSig },
      });
      return moved ? { ok: true, wallet: moved.wallet } : { ok: false, error: 'reservation' };
    },

    // C3.5: the extension's proven burn. Allowed with no row, over a reservation without a burn and over its own burn on
    // its way; over another proven burn only when it is the same burner's older burn (the extension's rule: the oldest
    // burn is the code).
    async recordExtension(facts, proof) {
      if (!verifyBurnRecordProof(facts, proof)) return { ok: false, error: 'invalid_proof' };
      const burn = await finalBurn(facts.burnTx, { burner: facts.burner, nodeType: facts.nodeType, amount: facts.burnAmount });
      if ('ok' in burn) return burn;
      const next = (row: ActivationRow | null): ActivationRow => ({
        wallet: facts.wallet, state: 'recorded', nodeType: facts.nodeType, way: 'extension', burner: facts.burner, burnAmount: facts.burnAmount,
        reservation: row?.reservation ?? null, reservedAt: row?.reservedAt ?? null, expiresAt: null, burnTx: facts.burnTx,
        announcedAt: row?.burnTx === facts.burnTx ? row.announcedAt : null, burnSlot: burn.slot, burnedAt: burn.burnedAt, recordedAt: now(),
        proof: proof as Record<string, unknown>,
      });
      return upsert(facts.wallet, (row) => {
        if (!row) return next(null);
        if (row.burnTx === facts.burnTx) return row.state === 'recorded' ? 'same' : next(row);
        if (row.state === 'reserved' && row.burnTx === null) return next(row);
        if (proven(row) && row.burner === facts.burner && burn.slot !== null && (row.burnSlot === null ? row.state === 'sending' : burn.slot < row.burnSlot)) return next(row);
        return 'other';
      });
    },

    async paymentRecord(wallet) {
      const row = await current(wallet);
      return row && row.burnTx !== null && (row.state === 'sending' || row.state === 'recorded') ? row : null;
    },

    async release(wallet, reservation) {
      await store.release(wallet, reservation);
    },

    knowsPaymentBurner: (burner) => store.knowsPaymentBurner(burner),
  };
}

// The activation routes (shared contract C3): GET /api/cabinet/activation/{wallet}[?solana=] and POST
// /api/cabinet/activation/{reserve,announce,release,record}, over the registry (activation-registry.ts). The page, the
// QNet extension and QNet Wallet read a wallet's activation here from any browser or device, and the payment key and the
// extension hold a reservation before they sign a burn, so a wallet gets one burn and one code, for a light or a super
// node. A reservation is made only with the wallet's own signed reservation (C1): the extension signs it with the
// wallet's keys, and for a payment address QNet Wallet signs it before the address exists, so a stranger can neither hold
// a wallet nor burn in its name. Every answer is JSON with no-store; the origin rule takes the site and the extension
// (request-guard.ts activationOriginAllowed); each client is metered (limits.ts), each search of a Solana address is
// charged to the client first (burn-scan.ts), and a wallet's records once a proof verified. A database that cannot be reached, or a table not migrated yet, answers `unavailable`, and no client burns.

import { isSolanaSignature, type NodeType } from '../../lib/qnet-link.ts';
import { isEonAddress, isSolanaAddress } from '../../lib/qnet-provider.ts';
import {
  SCAN_CACHE_MS, isBurnAmount, isBurnWay, isNodeType, isReservationId, parseBurnProof, parseReservationProof, verifyBurnRecordProof, verifyReservationProof,
  type BurnFacts, type BurnWay,
} from '../../lib/cabinet/burn-record.ts';
import { activationOriginAllowed, readJsonPost, DEV_ORIGINS } from '../request-guard.ts';
import type { Rpc } from '../solana-rpc.ts';
import { sharedSolanaRpc } from '../solana-endpoint.ts';
import {
  StoreUnavailable, createActivationRegistry, createPgStore, type ActivationRegistry, type ActivationRow, type BurnChecker, type SqlQuery,
} from './activation-registry.ts';
import { checkBurn, createBurnScanner, type BurnCheck, type BurnScanner } from './burn-scan.ts';
import { memo } from './cache.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';
import { walletNode as sharedWalletNode, type WalletNode } from './wallet-node.ts';

// A reservation's search of the wallet's Solana address is no older than this. The reservation the wallet signs does not
// name that address (C1 reservationMessage: QNet Wallet and the extension sign it as it is), so anyone could name a busy
// one; the page's own recent finished search of it, kept by the scanner, answers the reservation instead of a new one
// (SITE H-5). A new search, when none is kept, is charged to the client like the page's.
export const RESERVE_SCAN_MAX_AGE_MS = SCAN_CACHE_MS;
// A burn's Solana check is reused this long (a page polling a burn on its way).
export const CHECK_CACHE_MS = 5_000;
const SMALL_BODY_MAX_BYTES = 1024;
// Two base64url ML-DSA-65 values and the rest: about 7.4 KB.
export const PROOF_BODY_MAX_BYTES = 12 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  isObject(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));

export interface ActivationApiOptions extends GateOptions {
  gate?: Gate;
  registry: ActivationRegistry;
  walletNode: (wallet: string) => Promise<WalletNode | null>;
  scan: BurnScanner;
}

export interface ActivationApi {
  get(request: Request, wallet: string): Promise<Response>;
  reserve(request: Request): Promise<Response>;
  announce(request: Request): Promise<Response>;
  release(request: Request): Promise<Response>;
  record(request: Request): Promise<Response>;
  // The payment key's burn under its reservation with its v2 owner bind (POST /api/cabinet/send): the wallet it holds,
  // null when the reservation does not allow it, 'invalid_proof' when the bind does not verify, 'unavailable' when the
  // database cannot answer.
  announcePayment(reservation: string, burner: string, burnAmount: number, burnTx: string, ownerSig: string): Promise<string | null | 'invalid_proof' | 'unavailable'>;
  // The wallet's burn for the registration of a payment address's burn (POST /api/cabinet/register): its row once it has
  // a burn, null without one, 'unavailable' when the database cannot answer.
  paymentRecord(wallet: string): Promise<ActivationRow | null | 'unavailable'>;
  // Whether a reservation named `burner` as a payment address (POST /api/cabinet/send: only its refund earns a read pass);
  // false when the database cannot answer.
  knowsPaymentBurner(burner: string): Promise<boolean>;
  registry: ActivationRegistry;
  // The search of a Solana address the reads use (its kept results shared): the registration of a burn made from the
  // wallet's own Solana address reads its burner's burns here (POST /api/cabinet/register), charged to the clients it
  // names.
  scan: BurnScanner;
}

const UNAVAILABLE = () => cabinetJson(503, { error: 'unavailable' });
const INVALID = () => cabinetJson(400, { error: 'invalid_request' });

export function createActivationApi(options: ActivationApiOptions): ActivationApi {
  const gate = options.gate ?? createGate(options);
  const devOrigins = options.devOrigins ?? DEV_ORIGINS;
  const { registry, scan } = options;
  // The server's clock (GateOptions.now): a reservation proof's time is checked against it.
  const now = options.now ?? Date.now;
  const read = (request: Request, max: number) => readJsonPost(request, max, devOrigins, activationOriginAllowed);
  const conflict = (error: string, wallet: string, row: ActivationRow | null | undefined, extra: Record<string, unknown> = {}) =>
    cabinetJson(409, { error, ...extra, activation: registry.view(wallet, row ?? null) });
  // The client a search is charged to (burn-scan.ts): the gate's key of the request.
  const clientsOf = (request: Request): string[] => {
    const client = gate.client(request);
    return client === null ? [] : [client];
  };

  // A route's work; the database's failure is `unavailable`.
  const guarded = async (work: () => Promise<Response>): Promise<Response> => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StoreUnavailable) return UNAVAILABLE();
      throw err;
    }
  };

  return {
    registry,
    scan,

    // C3.1
    async get(request, wallet) {
      const solana = new URL(request.url).searchParams.get('solana');
      const refused = gate(request, solana === null ? 'activation' : 'activationScan');
      if (refused) return refused;
      if (!isEonAddress(wallet) || (solana !== null && !isSolanaAddress(solana))) return INVALID();
      return guarded(async () => {
        const row = await registry.current(wallet);
        const shown = registry.view(wallet, row);
        if (shown.state !== 'none' || solana === null) return cabinetJson(200, shown);
        return cabinetJson(200, registry.view(wallet, row, await scan(solana, undefined, 'public', clientsOf(request))));
      });
    },

    // C3.2 with C1: the body, the gate, the fields, the wallet's signed reservation (its key is the wallet's and it signed
    // these very fields; then its time), then the record, the network and the payment's search, then the reservation.
    async reserve(request) {
      const body = await read(request, PROOF_BODY_MAX_BYTES);
      if (!body.ok) return cabinetJson(body.status, { error: body.error });
      const refused = gate(request, 'activationWrite');
      if (refused) return refused;
      const b = body.value;
      if (!exactKeys(b, ['wallet', 'nodeType', 'way', 'burner', 'burnAmount', 'solana', 'proof'])) return INVALID();
      if (!isEonAddress(b.wallet) || !isNodeType(b.nodeType) || !isBurnWay(b.way) || !isSolanaAddress(b.burner) || !isBurnAmount(b.burnAmount)) return INVALID();
      if (b.solana !== null && !isSolanaAddress(b.solana)) return INVALID();
      if (b.way === 'payment' && b.nodeType !== 'light') return INVALID();
      if (b.way === 'extension' && b.solana !== b.burner) return INVALID();
      const wallet = b.wallet;
      const nodeType: NodeType = b.nodeType;
      const way: BurnWay = b.way;
      const checked = verifyReservationProof({ wallet, nodeType, way, burner: b.burner as string }, b.proof, Math.floor(now() / 1000));
      if (checked === 'invalid') return cabinetJson(400, { error: 'invalid_proof' });
      if (checked === 'stale') return cabinetJson(400, { error: 'stale_proof' });
      const proof = parseReservationProof(b.proof) as { pk: string; sig: string; time: number };
      return guarded(async () => {
        const row = await registry.current(wallet);
        const blocked = registry.blocking(row);
        if (blocked) return conflict(blocked, wallet, row);
        const node = await options.walletNode(wallet);
        if (node === null) return cabinetJson(503, { error: 'network_unavailable' });
        if (node.state === 'registered') return cabinetJson(409, { error: 'has_node', nodeId: node.nodeId, nodeType: node.nodeType });
        if (b.way === 'payment' && typeof b.solana === 'string') {
          const found = await scan(b.solana, RESERVE_SCAN_MAX_AGE_MS, 'reserve', clientsOf(request));
          if (found.burns.length > 0) return cabinetJson(409, { error: 'burn_found', burns: found.burns });
          if (found.unusable) return cabinetJson(409, { error: 'burn_unusable' });
          if (!found.complete) return cabinetJson(503, { error: 'scan_incomplete' });
        }
        const got = await registry.reserve({
          wallet, nodeType, way, burner: b.burner as string, burnAmount: b.burnAmount as number, proof: { pk: proof.pk, sig: proof.sig, time: proof.time },
        });
        if (got.ok) return cabinetJson(200, { reservation: got.reservation, until: got.until });
        return conflict(got.error, wallet, got.row);
      });
    },

    // C3.3
    async announce(request) {
      const body = await read(request, PROOF_BODY_MAX_BYTES);
      if (!body.ok) return cabinetJson(body.status, { error: body.error });
      const refused = gate(request, 'activationWrite');
      if (refused) return refused;
      const b = body.value;
      if (!exactKeys(b, ['wallet', 'reservation', 'burnTx', 'proof'])) return INVALID();
      if (!isEonAddress(b.wallet) || !isReservationId(b.reservation) || !isSolanaSignature(b.burnTx)) return INVALID();
      if (!parseBurnProof(b.proof)) return cabinetJson(400, { error: 'invalid_proof' });
      const { wallet, reservation, burnTx, proof } = b as { wallet: string; reservation: string; burnTx: string; proof: unknown };
      return guarded(async () => {
        const got = await registry.announceExtension(wallet, reservation, burnTx, proof);
        if (got.ok) return cabinetJson(200, { ok: true, until: got.until });
        return got.error === 'invalid_proof' ? cabinetJson(400, { error: 'invalid_proof' }) : cabinetJson(409, { error: 'reservation' });
      });
    },

    // C3.4: always ok, whatever the row was.
    async release(request) {
      const body = await read(request, SMALL_BODY_MAX_BYTES);
      if (!body.ok) return cabinetJson(body.status, { error: body.error });
      const refused = gate(request, 'activationWrite');
      if (refused) return refused;
      const b = body.value;
      if (!exactKeys(b, ['wallet', 'reservation']) || !isEonAddress(b.wallet) || !isReservationId(b.reservation)) return INVALID();
      try {
        await registry.release(b.wallet, b.reservation);
      } catch {
        // an unreachable database holds nothing to release now; the reservation ends by itself
      }
      return cabinetJson(200, { ok: true });
    },

    // C3.5: the extension's burn with its proof; the wallet's own budget counts once the proof verified.
    async record(request) {
      const body = await read(request, PROOF_BODY_MAX_BYTES);
      if (!body.ok) return cabinetJson(body.status, { error: body.error });
      const refused = gate(request, 'activationWrite');
      if (refused) return refused;
      const b = body.value;
      if (!exactKeys(b, ['wallet', 'nodeType', 'burner', 'burnTx', 'burnAmount', 'proof'])) return INVALID();
      if (!isEonAddress(b.wallet) || !isNodeType(b.nodeType) || !isSolanaAddress(b.burner) || !isSolanaSignature(b.burnTx) || !isBurnAmount(b.burnAmount)) return INVALID();
      const facts: BurnFacts = { wallet: b.wallet, nodeType: b.nodeType, burner: b.burner, burnTx: b.burnTx, burnAmount: b.burnAmount };
      if (!verifyBurnRecordProof(facts, b.proof)) return cabinetJson(400, { error: 'invalid_proof' });
      const limited = gate.keyed('activationRecord', facts.wallet);
      if (limited) return limited;
      return guarded(async () => {
        const got = await registry.recordExtension(facts, b.proof);
        if (got.ok) return cabinetJson(200, registry.view(facts.wallet, got.row));
        if (got.error === 'not_final') return cabinetJson(409, { error: 'not_final' });
        if (got.error === 'other_burn') return conflict('other_burn', facts.wallet, got.row);
        if (got.error === 'invalid_burn' || got.error === 'invalid_proof') return cabinetJson(400, { error: got.error });
        return UNAVAILABLE();
      });
    },

    async announcePayment(reservation, burner, burnAmount, burnTx, ownerSig) {
      try {
        const got = await registry.announcePayment(reservation, burner, burnAmount, burnTx, ownerSig);
        if (got.ok) return got.wallet;
        return got.error === 'invalid_proof' ? 'invalid_proof' : null;
      } catch {
        return 'unavailable';
      }
    },

    async paymentRecord(wallet) {
      try {
        return await registry.paymentRecord(wallet);
      } catch {
        return 'unavailable';
      }
    },

    async knowsPaymentBurner(burner) {
      try {
        return await registry.knowsPaymentBurner(burner);
      } catch {
        return false;
      }
    },
  };
}

// A burn's Solana check, one in flight and reused a few seconds per burn and expectation.
export function cachedChecker(rpc: Rpc, now: () => number = Date.now): BurnChecker {
  const cache = memo<BurnCheck | null>(CHECK_CACHE_MS, now);
  return (burnTx, expect) => cache(`${burnTx}:${expect.burner}:${expect.nodeType ?? ''}:${expect.amount ?? ''}`, () => checkBurn(rpc, burnTx, expect), (v) => v !== null);
}

// The process's routes, on globalThis so every route bundle shares one registry, scanner and gate. `query`: the
// explorer database (lib/db.ts), passed by the routes so this module loads no database driver itself.
const GLOBAL_KEY = Symbol.for('qnet.cabinetActivationApi');

export function activationApi(query: SqlQuery): ActivationApi {
  const holder = globalThis as unknown as Record<symbol, ActivationApi | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const rpc = sharedSolanaRpc();
  const registry = createActivationRegistry({ store: createPgStore(query), check: cachedChecker(rpc) });
  const created = createActivationApi({
    gate: cabinetGate(), registry, scan: createBurnScanner({ rpc }), walletNode: (wallet) => sharedWalletNode().check(wallet, 'reserve'),
  });
  holder[GLOBAL_KEY] = created;
  return created;
}

// The activation page's Solana and price reads, and the one door it sends through (plan-site section 7): the page
// talks only to this origin, so each route takes one narrow shape and none relays anything else. The price comes
// from two genesis nodes that agree (the page burns by it); `send` forwards only the cabinet's burn and refund,
// signed by their payment address (src/lib/cabinet/burn-tx.ts), and a burn only under the wallet's reservation with the
// payment key's v2 owner bind of that wallet, announced in the activation registry before it leaves (shared contracts
// C3.3 and C4); every route meters the real client (limits.ts).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bs58 from 'bs58';
import { agreedQuote, sitePriceBody, type PriceQuote } from '../../lib/activation-price.ts';
import { READ_PASS_RE, classifyCabinetTx, oneDevAccountOf } from '../../lib/cabinet/burn-tx.ts';
import { ONE_DEV_MINT } from '../../lib/one-dev.ts';
import { isSolanaSignature } from '../../lib/qnet-link.ts';
import { decodeKey, parseLegacyTransaction, signaturesValid, PACKET_DATA_SIZE } from '../../lib/solana-message.ts';
import { readJsonPost } from '../request-guard.ts';
import { latestBlockhash, sendTransaction, statusOf, type Rpc, type Status } from '../solana-rpc.ts';
import { BATCH_WINDOW_MS, accountBatcher, sharedSolanaRpc } from '../solana-endpoint.ts';
import { parseBurn } from './burn-parse.ts';
import { memo } from './cache.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';

export { parseBurn, type ActivationBurn } from './burn-parse.ts';

export const PRICE_CACHE_MS = 15_000;
export const PAYMENT_CACHE_MS = 3_000;
export const BLOCKHASH_CACHE_MS = 2_000;
// A transaction's read is made of parts kept apart (SITE M-14): its status by signature and the block height (one for
// all) a couple of seconds each, and a finalized transaction's burn for good, since it never changes. The state that
// depends on the page's `lvh` (pending or expired) is worked out from them here, so a new `lvh` costs no Solana read.
export const TX_CACHE_MS = 2_000;
export const HEIGHT_CACHE_MS = 2_000;
export const FINAL_TX_CACHE_MS = 86_400_000;
// A page reads the state of its own burns and refunds with the read pass /send gave it for that signature. The pass is
// an HMAC of the signature under the server's CABINET_READ_KEY, so it outlives a restart of the site, and the server
// keeps no list of what it sent (SITE-R3-01). /send gives one only for a transaction the endpoint took or may have
// taken (one it refused cost nothing), and for a refund only when its payer is a payment address a reservation of this
// site named. Reads of any other signature, which anyone can make up by the thousand from many addresses, share a small
// budget a second for the whole server, each client at most its own share of it (CABINET_LIMITS.txOther), so that
// together they cannot use up the endpoint's rate for every visitor (SITE-R2-08); past it the route answers
// `unavailable` without asking Solana. Reads with a pass that go to Solana share OWN_TX_READS a second, a larger budget
// of their own, so pass holders cannot go past a fixed share of the endpoint's rate either.
export const OTHER_TX_READS = { max: 2, windowMs: 1_000 } as const;
export const OWN_TX_READS = { max: 10, windowMs: 1_000 } as const;
const READ_PASS_CONTEXT = 'qnet.cabinet.read-pass.v1:';

// The server's read pass key: CABINET_READ_KEY, 32 bytes or more in hex, set once in .env.local
// (deployment/deploy-aiqnet.sh); without it, a key of this process only, and a restart ends the passes it gave.
export function readPassKey(configured: string | undefined = process.env.CABINET_READ_KEY): Buffer {
  return typeof configured === 'string' && /^(?:[0-9a-fA-F]{2}){32,}$/.test(configured) ? Buffer.from(configured, 'hex') : randomBytes(32);
}

// A burn: exactly {"tx": base64 of at most 1232 bytes, "reservation": 32 hex, "ownerSig": 128 hex}; a refund: exactly {"tx"}.
const SEND_BODY_MAX_BYTES = 2048;
const RESERVATION_RE = /^[0-9a-f]{32}$/;
const OWNER_SIG_RE = /^[0-9a-f]{128}$/;

// The activation registry's announce of a payment address's burn with its v2 owner bind (activation-api.ts
// announcePayment): the wallet its reservation holds, null when the reservation does not allow this burn, 'invalid_proof'
// when the bind does not verify, 'unavailable' when the registry cannot answer.
export type PaymentAnnounce = (reservation: string, burner: string, burnAmount: number, burnTx: string, ownerSig: string) => Promise<string | null | 'invalid_proof' | 'unavailable'>;
// Whether a reservation of this site named `payer` as its payment address (activation-api.ts knowsPaymentBurner).
export type KnownPayer = (payer: string) => Promise<boolean>;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PaymentView {
  // Lamports and raw 1DEV units, as decimal strings.
  sol: string;
  oneDev: string;
  accountExists: boolean;
}

export type TxState = 'pending' | 'processed' | 'confirmed' | 'finalized' | 'failed' | 'expired';

export interface TxView {
  state: TxState;
  // For a finalized transaction: the light activation burn it holds, or null when it holds none.
  burn?: { payer: string; amount: number } | null;
}


const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const U64_RE = /^(?:0|[1-9][0-9]{0,19})$/;

// getMultipleAccounts([address, its 1DEV account], jsonParsed): the address's lamports and the token account's
// balance, when that account is the address's 1DEV account.
export function parsePaymentAccounts(result: unknown, owner: string): PaymentView | null {
  const value = isObject(result) ? result.value : null;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [system, token] = value;
  let sol = '0';
  if (system !== null) {
    if (!isObject(system) || typeof system.lamports !== 'number' || !Number.isSafeInteger(system.lamports) || system.lamports < 0) return null;
    sol = String(system.lamports);
  }
  if (token === null) return { sol, oneDev: '0', accountExists: false };
  const info = isObject(token) && isObject(token.data) && isObject(token.data.parsed) ? token.data.parsed.info : null;
  if (!isObject(info) || info.mint !== ONE_DEV_MINT || info.owner !== owner || !isObject(info.tokenAmount)) return null;
  const amount = info.tokenAmount.amount;
  if (typeof amount !== 'string' || !U64_RE.test(amount)) return null;
  return { sol, oneDev: amount, accountExists: true };
}

export interface SolanaProxyOptions extends GateOptions {
  rpc?: Rpc;
  gate?: Gate;
  quote?: () => Promise<PriceQuote | null>;
  // How long balance reads of different addresses wait to go out together (solana-endpoint.ts accountBatcher).
  batchWindowMs?: number;
  // The read pass key (readPassKey).
  readKey?: Uint8Array;
  // Without it no burn leaves.
  announce?: PaymentAnnounce;
  // Without it no refund earns a read pass.
  knownPayer?: KnownPayer;
}

export interface SolanaProxy {
  price(request: Request): Promise<Response>;
  payment(request: Request, address: string): Promise<Response>;
  blockhash(request: Request): Promise<Response>;
  // `announce`, `knownPayer`: the registry's, in place of the options' ones.
  send(request: Request, announce?: PaymentAnnounce, knownPayer?: KnownPayer): Promise<Response>;
  tx(request: Request, signature: string, lastValidBlockHeight: string | null, pass?: string | null): Promise<Response>;
}

function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !B64_RE.test(text)) return null;
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    return btoa(String.fromCharCode(...bytes)) === text ? bytes : null;
  } catch {
    return null;
  }
}

export function createSolanaProxy(options: SolanaProxyOptions = {}): SolanaProxy {
  const now = options.now ?? Date.now;
  const rpc = options.rpc ?? sharedSolanaRpc();
  const accounts = accountBatcher(rpc, { windowMs: options.batchWindowMs ?? BATCH_WINDOW_MS });
  const gate = options.gate ?? createGate(options);
  const quote = options.quote ?? (() => agreedQuote('light'));
  const priceCache = memo<PriceQuote | null>(PRICE_CACHE_MS, now, 1);
  const paymentCache = memo<PaymentView | null>(PAYMENT_CACHE_MS, now);
  const blockhashCache = memo<{ blockhash: string; lastValidBlockHeight: number } | null>(BLOCKHASH_CACHE_MS, now, 1);
  // The parts of a transaction's read (TX_CACHE_MS above): a status (a found one or none) by signature, the second look
  // past the last valid block by signature, the block height, and a finalized transaction's view.
  const statusCache = memo<{ status: Status } | null>(TX_CACHE_MS, now);
  const againCache = memo<{ status: Status } | null>(TX_CACHE_MS, now);
  const heightCache = memo<number | null>(HEIGHT_CACHE_MS, now, 1);
  const finalCache = memo<TxView | null>(FINAL_TX_CACHE_MS, now);
  const kept = <T>(v: T | null): boolean => v !== null;
  const readKey = options.readKey ?? readPassKey();
  const passOf = (signature: string): string =>
    createHmac('sha256', readKey).update(READ_PASS_CONTEXT).update(signature).digest().subarray(0, 16).toString('base64url');
  const passMatches = (signature: string, pass: string): boolean => timingSafeEqual(Buffer.from(passOf(signature)), Buffer.from(pass));
  // The server's windows of tx reads that go to Solana: with no pass (each client's share counted first), and with one.
  const windowed = (budget: { max: number; windowMs: number }) => {
    const w = { start: 0, count: 0 };
    return (): boolean => {
      const t = now();
      if (t - w.start >= budget.windowMs) Object.assign(w, { start: t, count: 0 });
      w.count += 1;
      return w.count <= budget.max;
    };
  };
  const otherReadAllowed = windowed(OTHER_TX_READS);
  const ownReadAllowed = windowed(OWN_TX_READS);

  const fetchStatus = async (signature: string): Promise<{ status: Status } | null> => {
    try {
      return { status: await statusOf(rpc, signature) };
    } catch {
      return null;
    }
  };

  // A transaction's view from its parts, each read only when not kept; `lvh` decides pending or expired here. `allowed`:
  // the read budget, asked once before the first part that goes to Solana; spent, the read answers null.
  async function loadTx(signature: string, lastValid: number | null, allowed: () => boolean): Promise<TxView | null> {
    let granted: boolean | null = null;
    const upstream = <T>(load: () => Promise<T | null>) => async (): Promise<T | null> => {
      if (granted === null) granted = allowed();
      return granted ? load() : null;
    };
    const first = await statusCache(signature, upstream(() => fetchStatus(signature)), kept);
    if (first === null) return null;
    let status = first.status;
    if (status === null) {
      if (lastValid === null) return { state: 'pending' };
      const height = await heightCache('height', upstream(async () => {
        try {
          const h = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
          return typeof h === 'number' ? h : null;
        } catch {
          return null;
        }
      }), kept);
      if (height === null) return null;
      if (height <= lastValid) return { state: 'pending' };
      // Past its last valid block: look once more, since it may have landed in that very block.
      const again = await againCache(signature, upstream(() => fetchStatus(signature)), kept);
      if (again === null) return null;
      status = again.status;
      if (status === null) return { state: 'expired' };
    }
    if (status.err) return { state: 'failed' };
    if (status.confirmationStatus !== 'finalized') {
      return { state: status.confirmationStatus === 'confirmed' ? 'confirmed' : 'processed' };
    }
    const final = await finalCache(signature, upstream(async (): Promise<TxView | null> => {
      try {
        const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (tx === null) return { state: 'confirmed' };
        const burn = parseBurn(tx, 'light');
        return { state: 'finalized', burn: burn && { payer: burn.payer, amount: burn.amount } };
      } catch {
        return null;
      }
    }), (v) => v?.state === 'finalized');
    return final;
  }

  return {
    // GET /api/cabinet/price: the light activation price two genesis nodes agree on.
    async price(request) {
      const refused = gate(request, 'price');
      if (refused) return refused;
      const q = await priceCache('light', quote, kept);
      return q ? cabinetJson(200, sitePriceBody('light', q)) : cabinetJson(503, { error: 'unavailable' });
    },

    // GET /api/cabinet/payment/:address
    async payment(request, address) {
      const refused = gate(request, 'payment');
      if (refused) return refused;
      if (!decodeKey(address)) return cabinetJson(400, { error: 'invalid_request' });
      // The pages polling at once share calls: this address's two accounts go out with the others'.
      const view = await paymentCache(address, async () => {
        try {
          return parsePaymentAccounts({ value: await accounts([address, oneDevAccountOf(address)]) }, address);
        } catch {
          return null;
        }
      }, kept);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },

    // GET /api/cabinet/blockhash
    async blockhash(request) {
      const refused = gate(request, 'blockhash');
      if (refused) return refused;
      const latest = await blockhashCache('latest', async () => {
        try {
          return await latestBlockhash(rpc);
        } catch {
          return null;
        }
      }, kept);
      return latest ? cabinetJson(200, latest) : cabinetJson(503, { error: 'unavailable' });
    },

    // POST /api/cabinet/send: a burn or a refund of the cabinet, validly signed by its payment address; a burn exactly
    // {tx, reservation, ownerSig}, with the reservation it was made under and the payment key's v2 owner bind of the
    // reserved wallet, a refund exactly {tx}. A burn sent earns its read pass; a refund only from a payment address a
    // reservation named (any funded key could send one, SITE M-14).
    async send(request, announce = options.announce, knownPayer = options.knownPayer) {
      const read = await readJsonPost(request, SEND_BODY_MAX_BYTES);
      if (!read.ok) return cabinetJson(read.status, { error: read.error });
      const body = read.value;
      const keys = isObject(body) ? Object.keys(body).sort().join(',') : '';
      const reservation = isObject(body) && typeof body.reservation === 'string' && RESERVATION_RE.test(body.reservation) ? body.reservation : null;
      const ownerSig = isObject(body) && typeof body.ownerSig === 'string' && OWNER_SIG_RE.test(body.ownerSig) ? body.ownerSig : null;
      const asBurn = keys === 'ownerSig,reservation,tx' && reservation !== null && ownerSig !== null;
      const wellFormed = isObject(body) && typeof body.tx === 'string' && (keys === 'tx' || asBurn);
      const wire = wellFormed ? decodeBase64(body.tx as string) : null;
      const parsed = wire && wire.length <= PACKET_DATA_SIZE ? parseLegacyTransaction(wire) : null;
      const shape = classifyCabinetTx(parsed);
      const refused = gate(request, 'send');
      if (refused) return refused;
      if (!wire || !parsed || !shape || !signaturesValid(parsed)) return cabinetJson(400, { error: 'invalid_request' });
      if ((shape.kind === 'refund') === asBurn) return cabinetJson(400, { error: 'invalid_request' });
      // Only once its payment address signed it: a junk body naming someone's address spends nothing of theirs.
      const limited = gate.keyed('send', shape.payer);
      if (limited) return limited;
      if (shape.kind === 'burn') {
        // Announced as the reserved wallet's, with its owner bind, before it leaves, or it does not leave at all (C4).
        const held = announce ? await announce(reservation as string, shape.payer, shape.whole, bs58.encode(parsed.signatures[0]), ownerSig as string) : null;
        if (held === 'unavailable') return cabinetJson(503, { error: 'unavailable' });
        if (held === 'invalid_proof') return cabinetJson(400, { error: 'invalid_proof' });
        if (held === null) return cabinetJson(409, { error: 'reservation' });
      }
      const sent = await sendTransaction(rpc, wire);
      if (sent.state === 'refused') return cabinetJson(200, { state: sent.state });
      const earns = shape.kind === 'burn' || (knownPayer !== undefined && (await knownPayer(shape.payer).catch(() => false)));
      return cabinetJson(200, earns ? { state: sent.state, pass: passOf(bs58.encode(parsed.signatures[0])) } : { state: sent.state });
    },

    // GET /api/cabinet/tx/:signature[?lvh=&pass=]: its state and, once finalized, the light burn it holds.
    async tx(request, signature, lastValidBlockHeight, pass = null) {
      const refused = gate(request, 'tx');
      if (refused) return refused;
      const lastValid = lastValidBlockHeight === null ? null : Number(lastValidBlockHeight);
      if (!isSolanaSignature(signature) || (lastValid !== null && (!Number.isSafeInteger(lastValid) || lastValid < 0 || !/^\d+$/.test(lastValidBlockHeight as string)))) {
        return cabinetJson(400, { error: 'invalid_request' });
      }
      if (pass !== null && !READ_PASS_RE.test(pass)) return cabinetJson(400, { error: 'invalid_request' });
      const own = pass !== null && passMatches(signature, pass);
      // Only a read that goes to Solana spends a budget: with a pass, the server's own-reads budget; another signature, this
      // client's share first, so that a client past it spends nothing of the server's budget.
      const allowed = own ? ownReadAllowed : () => gate(request, 'txOther') === null && otherReadAllowed();
      const view = await loadTx(signature, lastValid, allowed);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },
  };
}

// The process's proxy, on globalThis so every route bundle shares one cache, behind the cabinet's one gate.
const GLOBAL_KEY = Symbol.for('qnet.cabinetSolanaProxy');

export function solanaProxy(): SolanaProxy {
  const holder = globalThis as unknown as Record<symbol, SolanaProxy | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createSolanaProxy({ gate: cabinetGate() });
  holder[GLOBAL_KEY] = created;
  return created;
}

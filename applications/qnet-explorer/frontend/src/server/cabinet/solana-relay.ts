// The wallets' Solana relay, POST /api/cabinet/solana. QNet Wallet and the QNet extension call their Solana endpoint
// directly; only when it gives them no answer does the very same JSON-RPC call come here, one request object per POST.
// The method table is strict: the wallets' 14 methods with exactly the params they send, anything else refused before
// it reaches Solana. Reads come from caches and batches every client shares; a transaction goes on only in a shape the
// wallets build (src/lib/wallet-solana-tx.ts), validly signed by its fee payer, and the extension's activation burn only
// once the activation registry holds it announced. Keys never reach the site: only signed transactions travel. Each
// client is metered before its call costs anything (limits.ts), each of its calls that reaches Solana against its share
// of the lane the call goes on, under half of it; the relay's own calls to the endpoint keep to those lanes of the
// server's budget (upstream.ts), and nothing of a request is logged.

import bs58 from 'bs58';
import { ONE_DEV_MINT } from '../../lib/one-dev.ts';
import { isSolanaSignature, type NodeType } from '../../lib/qnet-link.ts';
import { decodeBase64, decodeKey, parseLegacyMessage, parseLegacyTransaction, signaturesValid } from '../../lib/solana-message.ts';
import { classifyWalletTx } from '../../lib/wallet-solana-tx.ts';
import { DEV_ORIGINS, activationOriginAllowed, readJsonPost } from '../request-guard.ts';
import { RpcError, sendTransaction, type Rpc, type Status } from '../solana-rpc.ts';
import { BATCH_WINDOW_MS, accountBatcher, isObject, statusBatcher, warnSolana, type KeysReader } from '../solana-endpoint.ts';
import { memo, type Memo } from './cache.ts';
import { cabinetJson, type Gate } from './limits.ts';
import { UPSTREAM_BUDGETS, type UpstreamBudget } from './upstream.ts';

export const RELAY_BODY_MAX_BYTES = 4096;
// The largest account a wallet reads parsed (a token account); an unknown account is first read this plus one byte,
// so the relay never pulls a large account for anyone.
export const ACCOUNT_DATA_MAX = 165;
export const ACCOUNT_SLICE_BYTES = ACCOUNT_DATA_MAX + 1;
// The supply figures and the rent of an account size, the same for every client and slow to change.
export const SUPPLY_CACHE_MS = 60_000;
export const RENT_CACHE_MS = 3_600_000;
// An answer every client shares (a supply, a rent, the latest blockhash, a block height) that the endpoint did not give
// is not asked for again within this, however many clients ask.
export const FAILED_SHARED_MS = 2_000;
// The large answers kept: finalized transactions (a day each), and of the other large ones, kept a few seconds, more
// than a read lane's window can fill. Each only while its JSON is at most KEEP_MAX_CHARS, so what they hold has a fixed
// bound; a larger answer is passed on and read again next time.
export const RELAY_TX_ENTRIES = 500;
export const LARGE_ENTRIES = 32;
export const KEEP_MAX_CHARS = 16 * 1024;
export const SIGNATURES_LIMIT_MAX = 1000;
// A listing of at most this many signatures (a page of the extension's history) is a read; a longer one is a scan.
export const SHORT_LISTING_MAX = 25;
// The rents the wallets ask: of a plain account and of a token account.
const RENT_SIZES: readonly number[] = [0, ACCOUNT_DATA_MAX];
// An upstream failure of one method is logged at most this often.
const FAILURE_LOG_MS = 60_000;

// The extension's announced burn of a signature (activation-api.ts announcedBurn).
export type AnnouncedBurn = (burnTx: string) => Promise<{ burner: string; burnAmount: number; nodeType: NodeType } | null | 'unavailable'>;

type Commitment = 'confirmed' | 'finalized';
type Lane = 'solanaRead' | 'solanaScan' | 'solanaSend';
const LANE_NAMES: Readonly<Record<Lane, string>> = { solanaRead: 'read', solanaScan: 'scan', solanaSend: 'send' };

export interface RelayParts {
  rpc: Rpc;
  gate: Gate;
  now: () => number;
  // The server's lanes on the endpoint at `endpoint` (solana-endpoint.ts solanaRpcUrl).
  budget: UpstreamBudget;
  endpoint: string;
  devOrigins?: boolean;
  batchWindowMs?: number;
  // The cabinet's cache times (solana-proxy.ts): an account read, a recent transaction read, a finalized transaction.
  cacheMs: { account: number; recent: number; final: number };
  // The cabinet's own shared answers: the latest blockhash, the block height by commitment (`onFail` hears why a read
  // the endpoint did not answer failed), a signature's status (its cache, shared with /api/cabinet/tx), and its parsed
  // account reads at confirmed.
  blockhash: (onFail: (err: unknown) => void) => Promise<{ blockhash: string; lastValidBlockHeight: number } | null>;
  height: (commitment: Commitment, onFail: (err: unknown) => void) => Promise<number | null>;
  statuses: Memo<{ status: Status } | null>;
  parsedConfirmed: KeysReader;
  announcedBurn?: AnnouncedBurn;
  log?: (line: string) => void;
}

export type Relay = (request: Request, announcedBurn?: AnnouncedBurn) => Promise<Response>;

const isAddress = (v: unknown): v is string => decodeKey(v) !== null;
const isCommitment = (v: unknown): v is Commitment => v === 'confirmed' || v === 'finalized';
const is = (expected: unknown) => (v: unknown): boolean => v === expected;
const isBoolean = (v: unknown): boolean => typeof v === 'boolean';
const isBase64 = (v: unknown): boolean => typeof v === 'string' && decodeBase64(v) !== null;

// Exactly these keys, each value passing its check; an `optional` key may be left out.
function fields(v: unknown, required: Record<string, (x: unknown) => boolean>, optional: Record<string, (x: unknown) => boolean> = {}): v is Record<string, unknown> {
  if (!isObject(v) || !Object.keys(required).every((k) => Object.hasOwn(v, k))) return false;
  return Object.keys(v).every((k) => (Object.hasOwn(required, k) ? required[k](v[k]) : Object.hasOwn(optional, k) && optional[k](v[k])));
}

type Upstream = { result: unknown } | { error: { code: number; message: string } } | null;
const holdsResult = (v: Upstream): boolean => v !== null && 'result' in v;
// What a large cache keeps: a result of at most KEEP_MAX_CHARS of JSON.
const holdsSmallResult = (v: Upstream): boolean =>
  holdsResult(v) && (JSON.stringify((v as { result: unknown }).result) ?? '').length <= KEEP_MAX_CHARS;

// One JSON-RPC 2.0 request object: exactly jsonrpc, id (an integer 0..2^31-1 or a string of at most 64), method, params.
function envelopeOf(body: unknown): { id: number | string; method: string; params: unknown[] } | null {
  if (!isObject(body) || Object.keys(body).length !== 4) return null;
  const { jsonrpc, id, method, params } = body;
  const idOk = (typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= 0x7fffffff) || (typeof id === 'string' && id.length <= 64);
  if (jsonrpc !== '2.0' || !idOk || typeof method !== 'string' || !Array.isArray(params)) return null;
  return { id: id as number | string, method, params };
}

const answer = (id: number | string, result: unknown) => cabinetJson(200, { jsonrpc: '2.0', id, result });
const failure = (id: number | string | null, code: number, message: string) => cabinetJson(200, { jsonrpc: '2.0', id, error: { code, message } });
const UNAVAILABLE = () => cabinetJson(503, { error: 'unavailable' });

// The size of an account's data as a base64 slice of it gives it, or null when the answer is not one.
function slicedSize(account: unknown): number | null {
  const data = isObject(account) && Array.isArray(account.data) ? account.data : null;
  if (!data || data.length !== 2 || data[1] !== 'base64' || typeof data[0] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data[0])) return null;
  return Buffer.from(data[0], 'base64').length;
}

// A lamports figure as the exact JSON parse keeps it: a safe integer, or the digits of a larger one.
function lamportsOf(account: unknown): unknown {
  const v = isObject(account) ? account.lamports : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  const raw = (JSON as unknown as { isRawJSON(x: unknown): boolean }).isRawJSON(v) ? JSON.stringify(v) : '';
  return /^\d{1,20}$/.test(raw) ? v : null;
}

export function createRelay(parts: RelayParts): Relay {
  const { rpc, gate, now, budget, endpoint } = parts;
  const devOrigins = parts.devOrigins ?? DEV_ORIGINS;
  const windowMs = parts.batchWindowMs ?? BATCH_WINDOW_MS;
  const log = parts.log ?? warnSolana;
  const warnedAt = new Map<string, number>();
  const warnOnce = (key: string, everyMs: number, line: string) => {
    const t = now();
    if (t - (warnedAt.get(key) ?? Number.NEGATIVE_INFINITY) < everyMs) return;
    warnedAt.set(key, t);
    log(line);
  };
  // A call of a lane may go now (and is counted); past the lane, logged once a window.
  const laneOpen = (lane: Lane): boolean => {
    if (budget(lane, endpoint)) return true;
    warnOnce(`lane:${lane}`, UPSTREAM_BUDGETS[lane].windowMs, `[WARN][SOLANA] relay_lane_spent lane=${LANE_NAMES[lane]}`);
    return false;
  };
  // An answer the endpoint did not give, by method, at most once a minute: no address, signature or body in it.
  const failed = (method: string, err: unknown) => {
    const message = err instanceof Error ? err.message : '';
    const reason = /^rpc_http_\d{3}$/.test(message) ? message.slice('rpc_'.length)
      : err instanceof Error && err.name === 'TimeoutError' ? 'timeout'
        : message.startsWith('rpc_malformed') ? 'malformed' : message === 'rpc_backoff' ? 'backoff' : 'transport';
    warnOnce(`fail:${method}`, FAILURE_LOG_MS, `[WARN][SOLANA] relay_upstream_failed method=${method} reason=${reason}`);
  };
  const laned = (lane: Lane): Rpc => async (method, params) => {
    if (!laneOpen(lane)) throw new Error('relay_lane_spent');
    return rpc(method, params);
  };
  // One call to the endpoint: its result, its JSON-RPC refusal, or null (no answer, or the lane is spent).
  const call = async (lane: Lane | null, method: string, params: unknown[]): Promise<Upstream> => {
    if (lane !== null && !laneOpen(lane)) return null;
    try {
      return { result: await rpc(method, params) };
    } catch (err) {
      if (err instanceof RpcError) return { error: { code: err.code, message: err.message } };
      failed(method, err);
      return null;
    }
  };
  const reply = (id: number | string, got: Upstream): Response => {
    if (got === null) return UNAVAILABLE();
    return 'error' in got ? failure(id, got.error.code, got.error.message) : answer(id, got.result);
  };

  // A = the first ACCOUNT_SLICE_BYTES of each account; B = the parsed account (at confirmed the cabinet's own reads).
  const read = laned('solanaRead');
  const sliced: Record<Commitment, KeysReader> = {
    confirmed: accountBatcher(read, { windowMs, commitment: 'confirmed', slice: ACCOUNT_SLICE_BYTES }),
    finalized: accountBatcher(read, { windowMs, commitment: 'finalized', slice: ACCOUNT_SLICE_BYTES }),
  };
  const parsedFinal = accountBatcher(read, { windowMs, commitment: 'finalized' });
  const statusRounds = statusBatcher(read, { windowMs });
  const { cacheMs } = parts;
  const slices = memo<{ account: unknown } | null>(cacheMs.account, now);
  const parsedAccounts = memo<{ account: unknown } | null>(cacheMs.account, now);
  const tokenAccounts = memo<Upstream>(cacheMs.account, now, LARGE_ENTRIES);
  const supplies = memo<Upstream>(SUPPLY_CACHE_MS, now, 2);
  const rents = memo<Upstream>(RENT_CACHE_MS, now, RENT_SIZES.length);
  const listings = memo<Upstream>(cacheMs.recent, now, LARGE_ENTRIES);
  const transactions: Record<Commitment, Memo<Upstream>> = {
    confirmed: memo<Upstream>(cacheMs.recent, now, LARGE_ENTRIES),
    finalized: memo<Upstream>(cacheMs.final, now, RELAY_TX_ENTRIES),
  };
  // A shared answer the endpoint did not give, kept FAILED_SHARED_MS by its key; an answer stays in its own cache.
  const failures = memo<unknown>(FAILED_SHARED_MS, now, 8);
  const shared = <T>(key: string, load: () => Promise<T>, answered: (v: T) => boolean): Promise<T> =>
    failures(key, load, (v) => !answered(v as T)) as Promise<T>;
  const keptAccount = (v: { account: unknown } | null) => v !== null;
  const loadAccount = (reader: KeysReader, address: string, method: string) => async (): Promise<{ account: unknown } | null> => {
    try {
      return { account: (await reader([address]))[0] };
    } catch (err) {
      if (!(err instanceof Error && err.message === 'relay_lane_spent')) failed(method, err);
      return null;
    }
  };

  interface Ctx {
    request: Request;
    id: number | string;
    // The client's share of `lane`, charged for each of its calls that reaches Solana on it (429 past it).
    share: (lane: Lane) => Response | null;
    announcedBurn?: AnnouncedBurn;
  }

  // A read through `cache` on `lane`: a key it holds or has in flight costs the client nothing, any other is charged first.
  async function through<T>(ctx: Ctx, lane: Lane, cache: Memo<T>, key: string, load: () => Promise<T>, keep: (v: T) => boolean): Promise<T | Response> {
    if (!cache.has(key)) {
      const refused = ctx.share(lane);
      if (refused) return refused;
    }
    return cache(key, load, keep);
  }

  const slice = (ctx: Ctx, commitment: Commitment, address: string) =>
    through(ctx, 'solanaRead', slices, `${commitment}:${address}`, loadAccount(sliced[commitment], address, 'getMultipleAccounts'), keptAccount);

  // A transaction or message of a wallet's shape, as the params carry it in base64.
  const transactionOf = (b64: string) => {
    const wire = decodeBase64(b64);
    const parsed = wire ? parseLegacyTransaction(wire) : null;
    const shape = classifyWalletTx(parsed);
    return parsed && shape && signaturesValid(parsed) ? { wire: wire as Uint8Array, parsed, shape } : null;
  };

  type Method = { params: (p: unknown[]) => boolean; run: (ctx: Ctx, p: unknown[]) => Promise<Response> };
  const COMMITMENT = { commitment: isCommitment };
  const CONFIRMED = { commitment: is('confirmed') };

  const METHODS: Record<string, Method> = {
    getBalance: {
      params: (p) => p.length === 2 && isAddress(p[0]) && fields(p[1], COMMITMENT),
      async run(ctx, [address, config]) {
        const got = await slice(ctx, (config as { commitment: Commitment }).commitment, address as string);
        if (got instanceof Response) return got;
        const lamports = got === null ? null : got.account === null ? 0 : lamportsOf(got.account);
        return lamports === null ? UNAVAILABLE() : answer(ctx.id, { value: lamports });
      },
    },
    getAccountInfo: {
      params: (p) => p.length === 2 && isAddress(p[0]) && fields(p[1], { encoding: is('jsonParsed'), commitment: isCommitment }),
      async run(ctx, [address, config]) {
        const commitment = (config as { commitment: Commitment }).commitment;
        const first = await slice(ctx, commitment, address as string);
        if (first instanceof Response) return first;
        if (first === null) return UNAVAILABLE();
        if (first.account === null) return answer(ctx.id, { value: null });
        const size = slicedSize(first.account);
        if (size === null) return UNAVAILABLE();
        if (size > ACCOUNT_DATA_MAX) return failure(ctx.id, -32602, 'account data too large');
        // At confirmed the cabinet's own batcher, so the lane counts this read itself.
        const reader: KeysReader = commitment === 'finalized' ? parsedFinal : async (keys) => {
          if (!laneOpen('solanaRead')) throw new Error('relay_lane_spent');
          return parts.parsedConfirmed(keys);
        };
        const got = await through(ctx, 'solanaRead', parsedAccounts, `${commitment}:${address}`, loadAccount(reader, address as string, 'getMultipleAccounts'), keptAccount);
        if (got instanceof Response) return got;
        return got === null ? UNAVAILABLE() : answer(ctx.id, { value: got.account });
      },
    },
    getTokenAccountsByOwner: {
      params: (p) => p.length === 3 && isAddress(p[0]) && fields(p[1], { mint: is(ONE_DEV_MINT) })
        && fields(p[2], { encoding: is('jsonParsed'), commitment: is('confirmed') }),
      async run(ctx, p) {
        const got = await through(ctx, 'solanaRead', tokenAccounts, p[0] as string, () => call('solanaRead', 'getTokenAccountsByOwner', p), holdsSmallResult);
        return got instanceof Response ? got : reply(ctx.id, got);
      },
    },
    getTokenSupply: {
      params: (p) => p.length === 2 && p[0] === ONE_DEV_MINT && fields(p[1], { commitment: is('finalized') }),
      run: async (ctx, p) => reply(ctx.id, await supplies('1dev', () => shared('getTokenSupply', () => call(null, 'getTokenSupply', p), holdsResult), holdsResult)),
    },
    getSupply: {
      params: (p) => p.length === 1 && fields(p[0], { commitment: is('confirmed'), excludeNonCirculatingAccountsList: is(true) }),
      run: async (ctx, p) => reply(ctx.id, await supplies('sol', () => shared('getSupply', () => call(null, 'getSupply', p), holdsResult), holdsResult)),
    },
    getMinimumBalanceForRentExemption: {
      params: (p) => p.length === 2 && RENT_SIZES.includes(p[0] as number) && fields(p[1], CONFIRMED),
      run: async (ctx, p) => reply(ctx.id, await rents(String(p[0]), () => shared(`rent:${p[0]}`, () => call(null, 'getMinimumBalanceForRentExemption', p), holdsResult), holdsResult)),
    },
    getLatestBlockhash: {
      params: (p) => p.length === 1 && fields(p[0], CONFIRMED),
      async run(ctx) {
        const latest = await shared('blockhash', () => parts.blockhash((err) => failed('getLatestBlockhash', err)), (v) => v !== null);
        return latest ? answer(ctx.id, { value: latest }) : UNAVAILABLE();
      },
    },
    getBlockHeight: {
      params: (p) => p.length === 1 && fields(p[0], COMMITMENT),
      async run(ctx, [config]) {
        const commitment = (config as { commitment: Commitment }).commitment;
        const height = await shared(`height:${commitment}`, () => parts.height(commitment, (err) => failed('getBlockHeight', err)), (v) => v !== null);
        return height === null ? UNAVAILABLE() : answer(ctx.id, height);
      },
    },
    getFeeForMessage: {
      params: (p) => p.length === 2 && isBase64(p[0]) && fields(p[1], CONFIRMED),
      async run(ctx, p) {
        if (!classifyWalletTx(parseLegacyMessage(decodeBase64(p[0] as string) as Uint8Array))) return failure(ctx.id, -32602, 'message not accepted');
        return ctx.share('solanaRead') ?? reply(ctx.id, await call('solanaRead', 'getFeeForMessage', p));
      },
    },
    simulateTransaction: {
      params: (p) => p.length === 2 && isBase64(p[0])
        && fields(p[1], { encoding: is('base64'), sigVerify: is(true), replaceRecentBlockhash: is(false), commitment: is('confirmed') }),
      async run(ctx, p) {
        // A simulation sends nothing, so a burn needs no announce for it.
        if (!transactionOf(p[0] as string)) return failure(ctx.id, -32602, 'transaction not accepted');
        return ctx.share('solanaSend') ?? reply(ctx.id, await call('solanaSend', 'simulateTransaction', p));
      },
    },
    sendTransaction: {
      params: (p) => p.length === 2 && isBase64(p[0]) && (fields(p[1], { encoding: is('base64'), preflightCommitment: is('confirmed') })
        || fields(p[1], { encoding: is('base64'), skipPreflight: is(false), preflightCommitment: is('confirmed'), maxRetries: is(5) })),
      async run(ctx, p) {
        const tx = transactionOf(p[0] as string);
        if (!tx) return failure(ctx.id, -32602, 'transaction not accepted');
        // Charged to the client that sends it, never to its payer: anyone can post a payer's landed transaction again.
        const refused = ctx.share('solanaSend');
        if (refused) return refused;
        const signature = bs58.encode(tx.parsed.signatures[0]);
        if (tx.shape.kind === 'burn') {
          // The extension announces its burn before it sends it, and only that burn goes on.
          const held = ctx.announcedBurn ? await ctx.announcedBurn(signature) : null;
          if (held === 'unavailable') return UNAVAILABLE();
          if (!held || held.burner !== tx.shape.payer || held.burnAmount !== tx.shape.whole || held.nodeType !== tx.shape.nodeType) {
            return failure(ctx.id, -32602, 'burn not announced');
          }
        }
        if (!laneOpen('solanaSend')) return UNAVAILABLE();
        const sent = await sendTransaction(rpc, tx.wire);
        if (sent.state === 'refused') return failure(ctx.id, sent.code, sent.error);
        if (sent.state === 'sent') return answer(ctx.id, signature);
        // Unanswered: it may have gone on, so the wallet follows it by its signature.
        failed('sendTransaction', sent.cause);
        return UNAVAILABLE();
      },
    },
    getSignatureStatuses: {
      params: (p) => p.length === 2 && Array.isArray(p[0]) && p[0].length === 1 && isSolanaSignature(p[0][0])
        && fields(p[1], { searchTransactionHistory: isBoolean }),
      async run(ctx, [signatures, config]) {
        const signature = (signatures as string[])[0];
        // The history searched for every caller: an answer of the recent statuses holds no more than it.
        const load = async (): Promise<{ status: Status } | null> => {
          try {
            const s = (await statusRounds([signature]))[0];
            return { status: isObject(s) ? (s as Status) : null };
          } catch (err) {
            if (!(err instanceof Error && err.message === 'relay_lane_spent')) failed('getSignatureStatuses', err);
            return null;
          }
        };
        const keep = (v: { status: Status } | null) => v !== null;
        let got: { status: Status } | null | Response;
        if ((config as { searchTransactionHistory: boolean }).searchTransactionHistory) {
          // A wallet's look in the history tells a send that can no longer land: only a found status, or a read made for
          // it, answers it, never a "not found" read before it was asked.
          const known = parts.statuses.has(signature) ? await parts.statuses(signature, load, keep) : null;
          got = known?.status ? known : ctx.share('solanaRead') ?? await parts.statuses.refresh(signature, load, keep);
        } else {
          got = await through(ctx, 'solanaRead', parts.statuses, signature, load, keep);
        }
        if (got instanceof Response) return got;
        return got === null ? UNAVAILABLE() : answer(ctx.id, { value: [got.status] });
      },
    },
    getSignaturesForAddress: {
      params: (p) => p.length === 2 && isAddress(p[0]) && fields(p[1], {
        limit: (v) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= SIGNATURES_LIMIT_MAX, commitment: isCommitment,
      }, { before: isSolanaSignature, until: isSolanaSignature }),
      async run(ctx, p) {
        const q = p[1] as { limit: number; commitment: Commitment; before?: string; until?: string };
        const key = [p[0], q.limit, q.commitment, q.before ?? '', q.until ?? ''].join('|');
        const lane: Lane = q.limit <= SHORT_LISTING_MAX ? 'solanaRead' : 'solanaScan';
        const got = await through(ctx, lane, listings, key, () => call(lane, 'getSignaturesForAddress', p), holdsSmallResult);
        return got instanceof Response ? got : reply(ctx.id, got);
      },
    },
    getTransaction: {
      params: (p) => p.length === 2 && isSolanaSignature(p[0])
        && fields(p[1], { encoding: is('jsonParsed'), commitment: isCommitment, maxSupportedTransactionVersion: is(0) }),
      async run(ctx, p) {
        const cache = transactions[(p[1] as { commitment: Commitment }).commitment];
        // A transaction not found yet is asked again next time.
        const keep = (v: Upstream) => holdsSmallResult(v) && (v as { result: unknown }).result !== null;
        const got = await through(ctx, 'solanaRead', cache, p[0] as string, () => call('solanaRead', 'getTransaction', p), keep);
        return got instanceof Response ? got : reply(ctx.id, got);
      },
    },
  };

  return async (request, announcedBurn = parts.announcedBurn) => {
    // Origin, media type, size and JSON, then the envelope, all before any limit counts the request.
    const body = await readJsonPost(request, RELAY_BODY_MAX_BYTES, devOrigins, activationOriginAllowed);
    if (!body.ok) return cabinetJson(body.status, { error: body.error });
    const rpcCall = envelopeOf(body.value);
    if (!rpcCall) return failure(null, -32600, 'invalid request');
    const refused = gate(request, 'solana');
    if (refused) return refused;
    const method = Object.hasOwn(METHODS, rpcCall.method) ? METHODS[rpcCall.method] : null;
    if (!method) return failure(rpcCall.id, -32601, 'method not found');
    if (!method.params(rpcCall.params)) return failure(rpcCall.id, -32602, 'invalid params');
    const share = (lane: Lane) => gate.spend(request, lane);
    return method.run({ request, id: rpcCall.id, share, announcedBurn }, rpcCall.params);
  };
}

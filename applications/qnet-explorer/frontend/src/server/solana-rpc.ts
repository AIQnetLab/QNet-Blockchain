// Solana JSON-RPC for the site's server (the faucet, the node cabinet and the wallets' relay): the latest blockhash,
// sending a signed transaction and confirming it, with plain fetch (no websocket, no RPC library).
// src/server/solana-tx.ts builds and signs.

import { readCappedBytes } from '../lib/capped-body.ts';
import { within } from '../lib/deadline.ts';
import { decodeKey } from './solana-tx.ts';

// The most of an answer one call reads, so no call can pull an unbounded body into the server: a page of signatures
// and an owner's token accounts are the largest answers the wallets' relay asks for.
export const ANSWER_MAX_BYTES: Readonly<Record<string, number>> = { getSignaturesForAddress: 2 * 1024 * 1024, getTokenAccountsByOwner: 256 * 1024 };
export const ANSWER_DEFAULT_MAX_BYTES = 1024 * 1024;
export const answerCap = (method: string): number => (Object.hasOwn(ANSWER_MAX_BYTES, method) ? ANSWER_MAX_BYTES[method] : ANSWER_DEFAULT_MAX_BYTES);

const INTEGER_RE = /^-?\d+$/;
type RawJson = { rawJSON(text: string): unknown };

// JSON whose integers past 2^53 stay their own digits (JSON.rawJSON): a reader that wants a number refuses them, and
// JSON.stringify writes them back byte for byte, as the endpoint sent them.
export function parseExactJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => (
    typeof value === 'number' && !Number.isSafeInteger(value) && typeof context?.source === 'string' && INTEGER_RE.test(context.source)
      ? (JSON as unknown as RawJson).rawJSON(context.source)
      : value
  ));
}

// The node answered the call with a JSON-RPC error: a definite refusal, not a lost request.
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export function solanaRpc(url: string, { fetchFn = fetch as FetchFn, timeoutMs = 15_000 } = {}): Rpc {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`rpc_http_${res.status}`);
    const bytes = await readCappedBytes(res, answerCap(method));
    if (bytes === null) throw new Error('rpc_malformed');
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    try {
      body = parseExactJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as typeof body;
    } catch {
      throw new Error('rpc_malformed');
    }
    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      const code = typeof body.error.code === 'number' ? body.error.code : 0;
      const message = typeof body.error.message === 'string' ? body.error.message.slice(0, 300) : 'rpc error';
      throw new RpcError(code, message);
    }
    if (!body || typeof body !== 'object' || !('result' in body)) throw new Error('rpc_malformed');
    return body.result;
  };
}

export async function latestBlockhash(rpc: Rpc): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as
    | { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }
    | null;
  const value = result?.value;
  if (!value || !decodeKey(value.blockhash) || !Number.isSafeInteger(value.lastValidBlockHeight)) {
    throw new Error('rpc_malformed_blockhash');
  }
  return { blockhash: value.blockhash as string, lastValidBlockHeight: value.lastValidBlockHeight as number };
}

// 'refused': the node answered with an error (its code and message), so the transaction was not forwarded. 'sent': it
// accepted it. 'unknown': no answer (timeout, transport, HTTP error; `cause`, for a log) — it may still have been
// forwarded, and only its signature status or the blockhash expiry can tell.
export async function sendTransaction(
  rpc: Rpc,
  wire: Uint8Array,
): Promise<{ state: 'sent' } | { state: 'unknown'; cause: unknown } | { state: 'refused'; error: string; code: number }> {
  try {
    await rpc('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    return { state: 'sent' };
  } catch (err) {
    if (err instanceof RpcError) return { state: 'refused', error: err.message, code: err.code };
    return { state: 'unknown', cause: err };
  }
}

export type Status = { err: unknown; confirmationStatus: unknown } | null;

// The signature's status from the node's history too; null when the node knows no such transaction.
export async function statusOf(rpc: Rpc, signature: string): Promise<Status> {
  const result = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])) as
    | { value?: unknown[] }
    | null;
  const s = Array.isArray(result?.value) ? result.value[0] : undefined;
  if (s === undefined) throw new Error('rpc_malformed_status');
  return s && typeof s === 'object' ? (s as Status) : null;
}

export type Confirmation =
  | { status: 'landed' }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason: string };

interface ConfirmOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// A confirmation reads the transfer's status this often.
export const CONFIRM_POLL_MS = 2_000;

// 'landed': confirmed or finalized. 'failed': it failed on chain, or its blockhash expired while it was
// nowhere (it can never land then). 'unknown': `timeoutMs` passed with the blockhash possibly still
// valid, so it may still land. A failing RPC read is skipped, never taken as an answer.
export async function confirmSignature(
  rpc: Rpc,
  signature: string,
  lastValidBlockHeight: number,
  { timeoutMs, pollMs = CONFIRM_POLL_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ConfirmOptions,
): Promise<Confirmation> {
  const deadline = now() + timeoutMs;
  const judge = (s: Status): Confirmation | null => {
    if (!s) return null;
    if (s.err) return { status: 'failed', reason: JSON.stringify(s.err).slice(0, 300) };
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { status: 'landed' };
    return null;
  };
  // One round of reads: a verdict, or null to look again.
  const round = async (): Promise<Confirmation | null> => {
    try {
      const verdict = judge(await statusOf(rpc, signature));
      if (verdict) return verdict;
      const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (typeof height === 'number' && height > lastValidBlockHeight) {
        // Past its last valid block: look once more, since it may have landed in that very block.
        const last = await statusOf(rpc, signature);
        const lastVerdict = judge(last);
        if (lastVerdict) return lastVerdict;
        if (!last) return { status: 'failed', reason: 'blockhash_expired' };
      }
    } catch {
      // A transient RPC failure: try again on the next tick.
    }
    return null;
  };
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return { status: 'unknown', reason: 'confirmation_timeout' };
    // A round still out at the deadline is not waited for, so the answer keeps to `timeoutMs` whatever the RPC does.
    const verdict = await within(left, round());
    if (verdict) return verdict;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

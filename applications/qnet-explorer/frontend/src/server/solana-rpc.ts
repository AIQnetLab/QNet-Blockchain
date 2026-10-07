// Solana JSON-RPC for the faucet: the latest blockhash, sending a signed transaction and confirming it,
// with plain fetch (no websocket, no RPC library). src/server/solana-tx.ts builds and signs.

import { decodeKey } from './solana-tx.ts';

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
    const body = (await res.json()) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
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

// 'refused': the node answered with an error, so the transaction was not forwarded. 'sent': it accepted
// it. 'unknown': no answer (timeout, transport, HTTP error) — it may still have been forwarded, and only
// its signature status or the blockhash expiry can tell.
export async function sendTransaction(
  rpc: Rpc,
  wire: Uint8Array,
): Promise<{ state: 'sent' | 'unknown' } | { state: 'refused'; error: string }> {
  try {
    await rpc('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    return { state: 'sent' };
  } catch (err) {
    if (err instanceof RpcError) return { state: 'refused', error: err.message };
    return { state: 'unknown' };
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
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// 'landed': confirmed or finalized. 'failed': it failed on chain, or its blockhash expired while it was
// nowhere (it can never land then). 'unknown': the deadline passed with the blockhash possibly still
// valid, so it may still land. A failing RPC read is skipped, never taken as an answer.
export async function confirmSignature(
  rpc: Rpc,
  signature: string,
  lastValidBlockHeight: number,
  { pollMs = 2_000, timeoutMs = 90_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ConfirmOptions = {},
): Promise<Confirmation> {
  const deadline = now() + timeoutMs;
  const judge = (s: Status): Confirmation | null => {
    if (!s) return null;
    if (s.err) return { status: 'failed', reason: JSON.stringify(s.err).slice(0, 300) };
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { status: 'landed' };
    return null;
  };
  for (;;) {
    try {
      const status = await statusOf(rpc, signature);
      const verdict = judge(status);
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
    if (now() >= deadline) return { status: 'unknown', reason: 'confirmation_timeout' };
    await sleep(pollMs);
  }
}

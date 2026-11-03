// The API reads the explorer's pages make, one path per read, and one reading of a record's answer: the server reads a
// path for the page's first paint (src/server/first-answer.ts) and the client the same path for every later answer.

export const QNC_PATH = '/api/qnc?limit=100';
export const QNC_TRANSFERS_PATH = '/api/activity?page=1&limit=15&types=Transfer,Reward';

// The token directory's page size.
export const TOKENS_PER_PAGE = 25;

export function tokensPath(page: number, search = ''): string {
  const params = new URLSearchParams({ page: String(page), perPage: String(TOKENS_PER_PAGE) });
  if (search.trim()) params.set('search', search.trim());
  return `/api/tokens?${params.toString()}`;
}

export const blockPath = (id: string): string => `/api/blocks/${encodeURIComponent(id)}`;
// The page of the block history that starts at height `top`.
export const blocksPath = (top: number): string => `/api/blocks?at=${top}`;
export const txPath = (hash: string): string => `/api/tx/${encodeURIComponent(hash)}`;
export const addressPath = (address: string): string => `/api/address/${encodeURIComponent(address)}`;

// A token's transfers (the newest `limit`) and holders; the page first shows this many of each.
export const TOKEN_TRANSFERS_FIRST = 50;
export const TOKEN_HOLDERS_FIRST = 100;
export const tokenPath = (contract: string, limit: number): string => `/api/token/${encodeURIComponent(contract)}?tx=${limit}`;
export const tokenHoldersPath = (contract: string, limit: number): string => `/api/token/${encodeURIComponent(contract)}/holders?limit=${limit}`;

// A record route's answer ({ success, data }), for the server's first answer and the client's later reads alike: the
// record, or why there is none (`missing` for the statuses by which the route says no such record exists).
export function readRecord<T>(status: number, body: unknown, missing: readonly number[] = [404]): { record: T | null; phase: 'ready' | 'missing' | 'failed' } {
  const result = body as { success?: boolean; data?: T } | null;
  if (result?.success && result.data) return { record: result.data, phase: 'ready' };
  return { record: null, phase: missing.includes(status) ? 'missing' : 'failed' };
}

// The node's answer about an account, as the address route reads it: none (no node answered in time), or an answer
// with the account's body (null for an answer without one: an address the chain has not seen).
export type NodeAccountRead = { answered: false } | { answered: true; account: { balance?: unknown; genesis_allocation?: unknown } | null };

// The address route's balance from that answer: with no answer the balance is unknown, never 0, and is marked unread so
// the page reads it again; the node's figure stays exact as a digit string (a number only up to 2^53).
export function accountView(read: NodeAccountRead): { balance_raw: string | null; genesisAllocation: boolean; nodeUnread?: true } {
  if (!read.answered) return { balance_raw: null, genesisAllocation: false, nodeUnread: true };
  const b = read.account?.balance;
  const balance = typeof b === 'string' && /^\d+$/.test(b) ? b : typeof b === 'number' && Number.isFinite(b) && b > 0 ? String(Math.trunc(b)) : '0';
  return { balance_raw: balance, genesisAllocation: read.account?.genesis_allocation === true };
}

// The node's own words for no token at a contract (development/qnet-integration/src/rpc/misc_api.rs handle_token_info):
// no contract there, or a contract that is no token.
const NODE_NO_TOKEN = new Set(['Token not found', 'Contract exists but is not a QRC-20/QRC-721 token']);

// The node's answer to GET /api/v1/token/{contract} as the token route reads it (`status` null: no node answered): the
// token's record, `missing` only for the node's own not-found, and `unavailable` for anything else (no answer, a failed
// node, a body that is not its answer), so an outage never reads as "no token".
export type NodeTokenRead = { kind: 'token'; token: Record<string, unknown> } | { kind: 'missing' } | { kind: 'unavailable' };

export function nodeTokenRead(status: number | null, body: unknown): NodeTokenRead {
  if (status === 404) return { kind: 'missing' };
  if (status === null || status < 200 || status > 299 || body === null || typeof body !== 'object') return { kind: 'unavailable' };
  const answer = body as { success?: unknown; token?: unknown; error?: unknown };
  if (answer.success === true && answer.token !== null && typeof answer.token === 'object' && !Array.isArray(answer.token)) {
    return { kind: 'token', token: answer.token as Record<string, unknown> };
  }
  return answer.success === false && typeof answer.error === 'string' && NODE_NO_TOKEN.has(answer.error) ? { kind: 'missing' } : { kind: 'unavailable' };
}

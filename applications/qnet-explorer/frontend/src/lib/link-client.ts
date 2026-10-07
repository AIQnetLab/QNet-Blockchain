// The page's side of the QNet Link relay (docs/protocols/qnet-link-v1.md sections 5, 9 and 14): open a
// session with its request, poll for the answer, read it. Same-origin requests only (CSP connect-src 'self').

import {
  POLL_INTERVAL_MS,
  SESSION_TTL_S,
  validateAnswer,
  validateResponseRequest,
  type AnswerContext,
  type LinkAnswer,
  type LinkIntent,
  type LinkRequest,
  type RelayAnswerBody,
} from './qnet-link.ts';
import { closeSiteSession, newSiteSession, openAnswer, sessionRequestBody, type SiteSession } from './qnet-link-crypto.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RelayClientOptions {
  fetchFn?: FetchLike;
  // Prefix of the relay paths: '' in the page (same origin).
  base?: string;
  now?: () => number;
  random?: (bytes: Uint8Array) => Uint8Array;
  subtle?: SubtleCrypto;
}

export type StartFailure = 'rate_limited' | 'busy' | 'network' | 'refused';
export type StartResult =
  | { ok: true; session: SiteSession; expiresAt: number }
  | { ok: false; failure: StartFailure; retryAfterS?: number };

const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };

function retryAfterSeconds(res: Response): number {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), SESSION_TTL_S) : 60;
}

// A new key pair and id per attempt; an id the relay already holds (409) is replaced once.
export async function startLinkSession(intent: LinkIntent, request: LinkRequest | null, options: RelayClientOptions = {}): Promise<StartResult> {
  const { fetchFn = fetch, base = '', now = Date.now, random, subtle } = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await newSiteSession(intent, request, { random, subtle });
    // Counted from before the request, so the page never waits past the relay's own expiry.
    const startedAt = now();
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/link/sessions`, {
        ...REQUEST,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sessionRequestBody(session),
      });
    } catch {
      closeSiteSession(session);
      return { ok: false, failure: 'network' };
    }
    if (res.status === 201) return { ok: true, session, expiresAt: startedAt + SESSION_TTL_S * 1000 };
    closeSiteSession(session);
    if (res.status === 409) continue;
    if (res.status === 429) return { ok: false, failure: 'rate_limited', retryAfterS: retryAfterSeconds(res) };
    if (res.status === 503) return { ok: false, failure: 'busy' };
    return { ok: false, failure: 'refused' };
  }
  return { ok: false, failure: 'refused' };
}

// The page ends its session early (cancelled, or replaced by a new request), so it stops holding a place of this
// address at the relay. Best effort: a session not released ends with its TTL.
export async function releaseLinkSession(id: string, options: RelayClientOptions = {}): Promise<void> {
  const { fetchFn = fetch, base = '' } = options;
  try {
    await fetchFn(`${base}/api/link/sessions/${id}`, { ...REQUEST, method: 'DELETE' });
  } catch {
    // the relay drops it at its TTL
  }
}

export type PollResult =
  | { kind: 'waiting' }
  | { kind: 'answered'; body: RelayAnswerBody }
  | { kind: 'expired' }
  | { kind: 'retry'; afterMs: number }
  | { kind: 'unreadable' };

// One poll: 204 waiting, 200 the answer body, 404 expired; anything else is retried later.
export async function pollAnswer(session: Pick<SiteSession, 'id' | 'intent'>, options: RelayClientOptions = {}): Promise<PollResult> {
  const { fetchFn = fetch, base = '' } = options;
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/link/sessions/${session.id}/response`, REQUEST);
  } catch {
    return { kind: 'retry', afterMs: POLL_INTERVAL_MS };
  }
  if (res.status === 204) return { kind: 'waiting' };
  if (res.status === 404) return { kind: 'expired' };
  if (res.status === 429) return { kind: 'retry', afterMs: retryAfterSeconds(res) * 1000 };
  if (res.status !== 200) return { kind: 'retry', afterMs: POLL_INTERVAL_MS };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'retry', afterMs: POLL_INTERVAL_MS };
  }
  const body = validateResponseRequest(text, session.intent);
  return body ? { kind: 'answered', body } : { kind: 'unreadable' };
}

// What the page checks an answer against besides the session: the clock, the consent window and the consent
// verifier (section 14.7).
export type ReadContext = Omit<AnswerContext, 'intent' | 'request'>;

export type ReadResult = { ok: true; answer: LinkAnswer; checkNumber: number } | { ok: false };

// Decrypt and check the answer; any failure is "the answer could not be read".
export async function readAnswer(session: SiteSession, body: RelayAnswerBody, context: ReadContext, subtle?: SubtleCrypto): Promise<ReadResult> {
  let opened;
  try {
    opened = await openAnswer(session, body, subtle);
  } catch {
    return { ok: false };
  }
  const checked = validateAnswer(opened.plaintext, { ...context, intent: session.intent, request: session.request });
  return checked.ok ? { ok: true, answer: checked.answer, checkNumber: opened.checkNumber } : { ok: false };
}

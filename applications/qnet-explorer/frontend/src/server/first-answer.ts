import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { within } from '@/lib/deadline';

// A page's first answer from one of the site's own API routes, read in-process while the server renders the page (B-SPEC
// 3.3): the page paints with exactly what its client would have read, so it has its final shape from the first paint.
// The visitor's request headers go with the read, so a route's per-visitor limits count it as the visitor's.

export interface FirstAnswer {
  status: number;
  body: unknown;
}

// A first answer never waits for a node: the route's request signal is aborted from the start, so a route that reads
// nodes answers from the explorer's index alone and marks what it left out (`nodeUnread`); the page's client reads that
// part. A route that has not answered within FIRST_ANSWER_MS is not waited for (its client reads it). An answer is kept
// FIRST_ANSWER_KEEP_MS by its path, so repeated loads and tab switches within a block cost one read.
export const FIRST_ANSWER_MS = 1_500;
export const FIRST_ANSWER_KEEP_MS = 1_000;
const KEPT_MAX = 500;

type Route<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>;

const kept = new Map<string, { at: number; answer: Promise<FirstAnswer | null> }>();

// null when the route could not answer in time or at all (it threw, or its body is not JSON), or found nothing without
// the nodes; the page then reads it from the client.
export async function firstAnswer<P extends Record<string, string>>(route: Route<P>, path: string, params?: P): Promise<FirstAnswer | null> {
  const now = Date.now();
  const hit = kept.get(path);
  if (hit && now - hit.at < FIRST_ANSWER_KEEP_MS) return hit.answer;
  if (kept.size >= KEPT_MAX) for (const [key, entry] of kept) if (now - entry.at >= FIRST_ANSWER_KEEP_MS) kept.delete(key);
  const answer = read(route, path, params);
  kept.set(path, { at: now, answer });
  const result = await answer;
  // Only an answer is kept: a failed or late read is asked again by the next page.
  if (!result && kept.get(path)?.answer === answer) kept.delete(path);
  return result;
}

async function read<P extends Record<string, string>>(route: Route<P>, path: string, params?: P): Promise<FirstAnswer | null> {
  try {
    const visitor = new Headers(await headers());
    const request = new NextRequest(new URL(path, 'http://localhost'), { headers: visitor, signal: AbortSignal.abort() });
    const answer = await within(FIRST_ANSWER_MS, (async () => {
      const res = await route(request, { params: Promise.resolve((params ?? {}) as P) });
      return { status: res.status, body: await res.json() };
    })());
    if (!answer) {
      console.warn(`[WARN][WEB] first_answer_late path=${path} wait_ms=${FIRST_ANSWER_MS}`);
      return null;
    }
    // Nothing found without the nodes is not "nothing there": the page's client asks them.
    const body = answer.body as { success?: unknown; nodeUnread?: unknown } | null;
    if (body?.nodeUnread === true && body.success !== true) return null;
    return answer;
  } catch (err) {
    console.error(`[ERR][WEB] first_answer_failed path=${path} err=${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// A route whose data only a node holds (the QNC rich list, a token's record): the page renders with the latest answer
// kept for its path and never waits for the node; an answer older than NODE_ANSWER_STALE_MS is read again in the
// background for the next page (the client keeps the shown one current). Until one is kept the page's client reads it,
// and a failed read keeps the last good answer.
export const NODE_ANSWER_STALE_MS = 10_000;
const nodeKept = new Map<string, { at: number; answer: FirstAnswer | null; reading: boolean }>();

export function nodeAnswer<P extends Record<string, string>>(route: Route<P>, path: string, params?: P): FirstAnswer | null {
  const now = Date.now();
  const entry = nodeKept.get(path);
  if (!entry || (!entry.reading && now - entry.at >= NODE_ANSWER_STALE_MS)) {
    if (!entry && nodeKept.size >= KEPT_MAX) {
      const oldest = [...nodeKept.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) nodeKept.delete(oldest[0]);
    }
    const held = entry ?? { at: 0, answer: null, reading: false };
    held.reading = true;
    nodeKept.set(path, held);
    void (async () => {
      try {
        const res = await route(new NextRequest(new URL(path, 'http://localhost')), { params: Promise.resolve((params ?? {}) as P) });
        const body = await res.json();
        if (res.status < 500) Object.assign(held, { answer: { status: res.status, body }, at: Date.now() });
        else console.warn(`[WARN][WEB] node_answer_failed path=${path} status=${res.status}`);
      } catch (err) {
        console.warn(`[WARN][WEB] node_answer_failed path=${path} err=${err instanceof Error ? err.message : String(err)}`);
      } finally {
        held.reading = false;
      }
    })();
  }
  return entry?.answer ?? null;
}

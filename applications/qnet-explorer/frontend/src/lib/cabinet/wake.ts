// "I'm back" (unified plan R8, docs/protocols/light-node-messages.md section 7): the cabinet asks the network to wake
// the device linked to a registered light node with one silent push. The node's route answers one of five reasons,
// the site passes it on, and the page then watches the node's status for the answer. Pure, shared by the site route
// (src/server/cabinet/wake.ts) and the page.

import { number, t, type MessageKey } from '../texts.ts';
import { isLightNodeId } from '../qnet-link.ts';
import type { NodeStatusView } from './node-view.ts';

export const WAKE_PATH = '/api/v1/light-node/wake';
export const WAKE_RESULTS = ['sent', 'already_answered', 'no_device', 'not_registered', 'cooldown'] as const;
export type WakeResult = (typeof WAKE_RESULTS)[number];
export const WAKE_BODY_MAX_BYTES = 256;
// After `sent`, how long and how often the page reads the status for the answer.
export const WAKE_WATCH_MS = 120_000;
export const WAKE_POLL_MS = 10_000;
// The longest wait in a `cooldown` the site reads (the node names at most the rest of an epoch); longer is no answer.
export const WAKE_RETRY_MAX_SECS = 86_400;

// A wake's answer: the reason, and with `cooldown` the seconds until the network takes the node's next wake when the
// answer names them.
export interface WakeAnswer {
  result: WakeResult;
  retryAfterSeconds: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isResult = (v: unknown): v is WakeResult => (WAKE_RESULTS as readonly unknown[]).includes(v);
const isWait = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= WAKE_RETRY_MAX_SECS;

// POST /api/cabinet/wake, exactly {"nodeId": N}.
export function checkWakeRequest(value: unknown): string | null {
  if (!isObject(value) || Object.keys(value).length !== 1 || !isLightNodeId(value.nodeId)) return null;
  return value.nodeId;
}

// The node's answer as its route writes it (light_push.rs WakeAnswer::to_json): {"success": true only for `sent`,
// "reason": one of the five, "node_id": the node asked about[, "retry_after_seconds": s]}. Other fields are ignored;
// anything else, an answer about another node included, is no answer (a node before the route).
export function parseNodeWake(body: unknown, nodeId: string): WakeAnswer | null {
  if (!isObject(body) || !isResult(body.reason) || body.success !== (body.reason === 'sent') || body.node_id !== nodeId) return null;
  const retry = body.retry_after_seconds ?? null;
  if (retry !== null && !isWait(retry)) return null;
  return { result: body.reason, retryAfterSeconds: body.reason === 'cooldown' ? retry : null };
}

// The site route's answer: {"result": ...}, and for a `cooldown` that names its wait, `retryAfterSeconds` too.
export function wakeView(answer: WakeAnswer): Record<string, string | number> {
  const wait = answer.result === 'cooldown' ? answer.retryAfterSeconds : null;
  return wait === null ? { result: answer.result } : { result: answer.result, retryAfterSeconds: wait };
}

// The site route's answer, exactly as wakeView writes it.
export function parseWakeView(body: unknown): WakeAnswer | null {
  if (!isObject(body) || !isResult(body.result)) return null;
  const keys = Object.keys(body).length;
  if (keys === 1) return { result: body.result, retryAfterSeconds: null };
  if (keys !== 2 || body.result !== 'cooldown' || !isWait(body.retryAfterSeconds)) return null;
  return { result: body.result, retryAfterSeconds: body.retryAfterSeconds };
}

// "I'm back" is offered only for a node that is not active: registered, its device Offline (the public status's
// `device.state`) and silent this epoch, once two genesis nodes list the wake route. Never for an Online node, a device
// linked less than an epoch ago that has not answered yet (`other_device_pending`), or no device (owner, 30.09 and
// 04.10). A node of an earlier version names no device: then a linked device the network asks to come back.
export function canWake(s: NodeStatusView): boolean {
  if (!s.registered || s.answeredThisEpoch || !s.features.includes('wake')) return false;
  const device = s.device ?? null;
  return device ? device.state === 'offline' : s.deviceBound && s.needsReactivation;
}

// What the page says for each result; `sent` is followed by the status watch.
export function wakeKey(result: WakeResult): MessageKey {
  switch (result) {
    case 'sent':
      return 'wake_waiting';
    case 'already_answered':
      return 'wake_already';
    case 'no_device':
      return 'wake_no_device';
    case 'not_registered':
      return 'no_node';
    default:
      return 'wake_cooldown';
  }
}

// The page's words for an answer: a `cooldown` that names its wait says when to try again, in whole minutes.
export function wakeText(answer: WakeAnswer): string {
  if (answer.result !== 'cooldown' || answer.retryAfterSeconds === null) return t(wakeKey(answer.result));
  return t('wake_cooldown_in', { minutes: number(Math.max(1, Math.ceil(answer.retryAfterSeconds / 60))) });
}

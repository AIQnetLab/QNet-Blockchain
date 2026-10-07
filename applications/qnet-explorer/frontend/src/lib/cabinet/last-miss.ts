// Why a light node was not counted in an epoch, and what its owner can do (owner, 05.10): the public status's
// `device.last_miss` (docs/protocols/light-node-messages.md section 7), the latest of the last few epochs the node was
// not counted in, as a genesis owning its light shard saw it: the epoch, the reason, and whether the wake reached the
// device. A reader takes, among the owners that answer, the miss of the highest epoch, at equal epochs the most
// specific reason, at equal reasons the record that knows whether the wake reached the device; a reason this site does
// not know is passed over, never shown. The keyless status shows no exact times, delays or what the app did with a
// wake: a node of an earlier version that still sends them is read for the delivery alone. The Overview names the miss
// only while it is newer than the node's last counted epoch and no answer came after it; the Device tab also names an
// earlier one that carries the device's own account of the wake, which reaches the network only with a later answer.
// Every answer belongs to its own epoch: nothing here says one counts for another. Pure, shared by the site route
// (src/server/cabinet/node-proxy.ts) and the page.

import { number, t, type MessageKey } from '../texts.ts';
import type { DevicePlatform, NodeStatusView } from './node-view.ts';

// Most specific first: no committed check of the node's shard (no node of it counted, whatever the device did), an
// answer after the commit, a wake that never reached the device, an answer refused, a push not answered, no way to wake
// the device, a wake the network did not get out (any owner that reached the device tells more), a device the network
// stopped waking. `not_committed` and `not_sent` are the network's miss: they never count toward the network's stopping
// to wake a device, and the device has nothing to change.
export const MISS_REASONS = [
  'not_committed', 'answered_late', 'not_delivered', 'answer_refused', 'woken_no_answer', 'no_push_address', 'not_sent', 'not_woken_inactive',
] as const;
export type MissReason = (typeof MISS_REASONS)[number];

// What an app of an earlier node version reported about a wake it got: any of them means the wake reached the device.
// Read for that alone, never shown.
const OLD_APP_OUTCOMES: readonly string[] = ['answered', 'not_opened_since_boot', 'swiped', 'after_commit', 'answer_failed', 'already_counted', 'no_key'];

export interface LastMiss {
  epoch: number;
  reason: MissReason;
  // Whether the wake of that epoch reached the device, by the device's own account; null when not known.
  delivered: boolean | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isReason = (v: unknown): v is MissReason => (MISS_REASONS as readonly unknown[]).includes(v);
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));

// Whether the wake reached the device, from a record of an earlier node version: a time it reached the device or an
// app outcome says it did, a wake that never arrived says it did not; anything else is not known.
function oldDelivery(v: Record<string, unknown>): boolean | null {
  if (isCount(v.delivered_at) || (typeof v.app_outcome === 'string' && OLD_APP_OUTCOMES.includes(v.app_outcome))) return true;
  return v.reason === 'not_delivered' ? false : null;
}

// A node's `last_miss`: null for none, for a reason this site does not know, or for a record it cannot read; the rest
// of the status stands either way. `delivered` as the node sends it; a node of an earlier version sends times and an
// app outcome instead, which give the delivery and are dropped.
export function parseNodeMiss(v: unknown): LastMiss | null {
  if (!isObject(v) || !isCount(v.epoch) || !isReason(v.reason)) return null;
  const sent = v.delivered;
  if (sent !== undefined && sent !== null && typeof sent !== 'boolean') return null;
  const delivered = typeof sent === 'boolean' ? sent : oldDelivery(v);
  return { epoch: v.epoch, reason: v.reason, delivered: v.reason === 'not_delivered' && delivered === null ? false : delivered };
}

const MISS_KEYS = ['epoch', 'reason', 'delivered'];

// The site's `lastMiss`, exactly: null, or its three fields.
export function isLastMiss(v: unknown): v is LastMiss | null {
  if (v === null) return true;
  if (!isObject(v) || !hasKeys(v, MISS_KEYS)) return false;
  return isCount(v.epoch) && isReason(v.reason) && (v.delivered === null || typeof v.delivered === 'boolean');
}

// The miss a reader takes: the highest epoch, at equal epochs the most specific reason, at equal reasons the record that
// knows whether the wake reached the device (the owner that took the device's account of it), else the first.
export function latestMiss(records: readonly (LastMiss | null | undefined)[]): LastMiss | null {
  let best: LastMiss | null = null;
  for (const r of records) {
    if (!r) continue;
    if (best === null || r.epoch > best.epoch) {
      best = r;
      continue;
    }
    if (r.epoch < best.epoch) continue;
    const rank = MISS_REASONS.indexOf(r.reason) - MISS_REASONS.indexOf(best.reason);
    if (rank < 0 || (rank === 0 && best.delivered === null && r.delivered !== null)) best = r;
  }
  return best;
}

// The miss the Overview names: newer than the last epoch the node was counted in, with no answer of that epoch or a
// later one since (as the app reads it).
export function shownMiss(s: NodeStatusView): LastMiss | null {
  const miss = s.registered ? s.device?.lastMiss ?? null : null;
  if (miss === null) return null;
  const counted = s.counted.lastCountedEpoch;
  if (counted !== null && counted >= miss.epoch) return null;
  const answered = s.device?.lastAnswerEpoch ?? null;
  return answered !== null && answered >= miss.epoch ? null : miss;
}

// Whether a miss carries the device's own account of the wake: that it never arrived, or whether it arrived.
export function hasDeviceAccount(miss: LastMiss): boolean {
  return miss.reason === 'not_delivered' || (miss.reason === 'woken_no_answer' && miss.delivered !== null);
}

// The miss the Device tab names: the Overview's, else the latest one when it carries the device's own account of the
// wake. The device sends that account with its next answer, which in a later epoch counts the node again.
export function deviceMiss(s: NodeStatusView): LastMiss | null {
  const shown = shownMiss(s);
  if (shown !== null) return shown;
  const miss = s.registered ? s.device?.lastMiss ?? null : null;
  return miss !== null && hasDeviceAccount(miss) ? miss : null;
}

// Whether a page's read also asks the shard's owners not asked yet: for a miss the Overview names (a shard with no
// committed check is the same at every owner and ranks first, so not for that one), and for a wake with no answer whose
// record lacks the device's account, which only the owner that took the device's next answer keeps.
export function asksOtherOwners(s: NodeStatusView): boolean {
  const shown = shownMiss(s);
  if (shown !== null) return shown.reason !== 'not_committed';
  const miss = s.registered ? s.device?.lastMiss ?? null : null;
  return miss !== null && miss.reason === 'woken_no_answer' && !hasDeviceAccount(miss);
}

// Where I'm back is for the node: on this page (the Overview), on the Overview (the Device tab), or not at all.
export type WakePlace = 'here' | 'overview' | null;

// What the page says: what happened, and what to do.
export interface MissNotice {
  what: MessageKey;
  todo: MessageKey;
}

const BACKGROUND: Record<DevicePlatform, MessageKey> = {
  android: 'miss_todo_background_android',
  ios: 'miss_todo_background_ios',
  unknown: 'miss_todo_background',
};

const WAKE: Record<'here' | 'overview', MessageKey> = {
  here: 'miss_todo_open_or_wake',
  overview: 'miss_todo_open_or_wake_overview',
};

export function missNotice(miss: LastMiss, platform: DevicePlatform | null, wake: WakePlace): MissNotice {
  const background = BACKGROUND[platform ?? 'unknown'];
  switch (miss.reason) {
    case 'woken_no_answer':
      return { what: 'miss_woken', todo: background };
    case 'not_delivered':
      return { what: 'miss_not_delivered', todo: background };
    case 'answered_late':
      return { what: 'miss_late', todo: background };
    case 'answer_refused':
      return { what: 'miss_refused', todo: 'miss_todo_run_again' };
    case 'no_push_address':
      return { what: 'miss_no_push', todo: 'miss_todo_open_once' };
    case 'not_sent':
      return { what: 'miss_not_sent', todo: 'miss_todo_network' };
    case 'not_committed':
      return { what: 'miss_not_committed', todo: 'miss_todo_network' };
    default:
      return { what: 'miss_inactive', todo: wake === null ? 'miss_todo_open' : WAKE[wake] };
  }
}

// Whether the wake reached the device, in one sentence, as far as the record tells; none for a wake that never
// reached the device or never went out, whose own words say so.
function deliveryLine(miss: LastMiss): MessageKey | null {
  if (miss.delivered === null || miss.reason === 'not_delivered' || miss.reason === 'not_sent') return null;
  return miss.delivered ? 'delivery_reached' : 'delivery_not_reached';
}

// The miss's one line: what happened in that epoch, whether the wake reached the device when known, what to do.
export function missText(miss: LastMiss, platform: DevicePlatform | null, wake: WakePlace): string {
  const notice = missNotice(miss, platform, wake);
  const parts = [t(notice.what, { epoch: number(miss.epoch) })];
  const delivery = deliveryLine(miss);
  if (delivery !== null) parts.push(t(delivery));
  parts.push(t(notice.todo));
  return parts.join(' ');
}

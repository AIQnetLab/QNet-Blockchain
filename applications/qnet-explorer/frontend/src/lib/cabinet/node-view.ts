// What the cabinet shows about a node, from the site's node routes (src/server/cabinet/node-proxy.ts): the
// answers' exact shapes, checked again in the page, and the one reading of them the app shares
// (docs/protocols/light-node-messages.md section 7; unified plan R9: Online = a device is linked and the network
// does not ask it to come back; Offline = it does; "answered this epoch" is its own row). The public status's
// `device` names the linked device's state, its platform and model as the device said them when it linked (display
// only), the UTC day it linked, the last epoch it answered in and its latest epoch not counted (last-miss.ts): epochs
// only, never the time of an answer or a wake; a node of an earlier version sends none (null), or no model.

import { t, type MessageKey } from '../texts.ts';
import { isLastMiss, type LastMiss } from './last-miss.ts';

// How long the site keeps a node's status (node-proxy.ts STATUS_CACHE_MS, about the page's poll interval, SITE M-12): a
// page that wants to see a link, an unlink or a move it reported reads the status again once that is over.
export const STATUS_KEPT_MS = 25_000;

export const DEVICE_STATES = ['online', 'offline', 'unlinked', 'other_device_pending'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];
export const DEVICE_PLATFORMS = ['android', 'ios', 'unknown'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

// A device's model as the node keeps it (development/qnet-integration light_binding::model_hint): 1 to 40 ASCII
// letters, digits, spaces and . , + ( ) / -, trimmed.
export const DEVICE_MODEL_MAX = 40;
const MODEL_RE = /^[A-Za-z0-9 .,+()/-]{1,40}$/;
export const isDeviceModel = (v: unknown): v is string => typeof v === 'string' && MODEL_RE.test(v) && v === v.trim();

export interface DeviceView {
  platform: DevicePlatform | null;
  // The model the device's binding named (QNet Wallet builds it; display only); null when not known.
  model: string | null;
  // Unix seconds of the UTC day the device linked; null for a binding from before the sequence.
  linkedSince: number | null;
  lastAnswerEpoch: number | null;
  state: DeviceState;
  // Its latest epoch not counted, with the reason the shard's owners give; null when none (last-miss.ts).
  lastMiss: LastMiss | null;
}

export interface NodeStatusView {
  registered: boolean;
  pending: boolean;
  deviceBound: boolean;
  answeredThisEpoch: boolean;
  needsReactivation: boolean;
  counted: { sinceRegistration: number; counted: number; lastCountedEpoch: number | null };
  // Features both genesis nodes list.
  features: string[];
  // Decimal nano QNC, or null when it could not be read.
  balanceNano: string | null;
  // The linked device as the first settling answer names it; null when the node does not name one.
  device: DeviceView | null;
}

// One epoch of the node (src/lib/cabinet/epochs.ts numbers them): counted and still in the node balance, counted and
// moved to the wallet, missed, the epoch the node was registered in and not counted, not checked (the network
// published no check of the node's group that epoch, so the node is not blamed), or not readable from the network now.
export const HISTORY_RESULTS = ['counted', 'moved', 'missed', 'joined', 'unchecked', 'unknown'] as const;
export type HistoryResult = (typeof HISTORY_RESULTS)[number];

export interface HistoryRow {
  epoch: number;
  result: HistoryResult;
  // QNC added to the node balance; null where nothing was added or the amount is not known.
  amountQnc: number | null;
  // When the epoch ended (its last block's successor, ms), from the explorer's archive; null when not known.
  endedAt: number | null;
  // The transaction that moved it to the wallet, from the explorer's archive; null when not moved or not known.
  claimTx: string | null;
}

export interface HistoryView {
  // The epoch of the node's registration, from the explorer's archive; null when not known (earlier epochs may then
  // show as missed).
  registeredEpoch: number | null;
  // Whether the explorer's archive answered (dates, the moves' transactions, the registration).
  archived: boolean;
  // The epochs the network reports one by one, newest first.
  rows: HistoryRow[];
  // Older epochs the archive knows only as moved to the wallet, newest first.
  earlier: HistoryRow[];
}

// The node proxy reads up to 4 pages of 100 epochs (node-proxy.ts HISTORY_PAGE, HISTORY_PAGES_MAX).
export const HISTORY_ROWS_MAX = 400;
export const EARLIER_ROWS_MAX = 200;

// `device_pending`: a device linked less than an epoch ago that has not answered yet, while nothing counted the node in
// this epoch or the two before.
export type NodeState = 'none' | 'pending' | 'no_device' | 'device_pending' | 'online' | 'offline';

export const MOVE_MIN_NANO = 1_000_000_000n;
const NANO_DIGITS = 9;
const FEATURE_RE = /^[a-z0-9_]{1,32}$/;
const NANO_RE = /^(?:0|[1-9][0-9]{0,19})$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));

export const isFeatureList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 64 && v.every((f) => typeof f === 'string' && FEATURE_RE.test(f));

const STATUS_KEYS = ['registered', 'pending', 'deviceBound', 'answeredThisEpoch', 'needsReactivation', 'counted', 'features', 'balanceNano', 'device'];
const DEVICE_KEYS = ['platform', 'model', 'linkedSince', 'lastAnswerEpoch', 'state', 'lastMiss'];

// The site's `device`, exactly: null, or its six fields.
export function isDeviceView(v: unknown): v is DeviceView | null {
  if (v === null) return true;
  if (!isObject(v) || !hasKeys(v, DEVICE_KEYS)) return false;
  if (v.platform !== null && !(DEVICE_PLATFORMS as readonly unknown[]).includes(v.platform)) return false;
  if (v.model !== null && !isDeviceModel(v.model)) return false;
  if (v.linkedSince !== null && !isCount(v.linkedSince)) return false;
  if (v.lastAnswerEpoch !== null && !isCount(v.lastAnswerEpoch)) return false;
  if (!isLastMiss(v.lastMiss)) return false;
  return (DEVICE_STATES as readonly unknown[]).includes(v.state);
}

// GET /api/cabinet/node/:id, exactly.
export function parseStatusView(body: unknown): NodeStatusView | null {
  if (!isObject(body) || !hasKeys(body, STATUS_KEYS)) return null;
  for (const k of ['registered', 'pending', 'deviceBound', 'answeredThisEpoch', 'needsReactivation']) {
    if (typeof body[k] !== 'boolean') return null;
  }
  const c = body.counted;
  if (!isObject(c) || !hasKeys(c, ['sinceRegistration', 'counted', 'lastCountedEpoch'])) return null;
  if (!isCount(c.sinceRegistration) || !isCount(c.counted) || c.counted > c.sinceRegistration) return null;
  if (c.lastCountedEpoch !== null && !isCount(c.lastCountedEpoch)) return null;
  if (!isFeatureList(body.features)) return null;
  if (body.balanceNano !== null && (typeof body.balanceNano !== 'string' || !NANO_RE.test(body.balanceNano))) return null;
  if (!isDeviceView(body.device) || (!body.registered && body.device !== null)) return null;
  return body as unknown as NodeStatusView;
}

// A super node as the site's super route reads it from the nodes (src/server/cabinet/node-proxy.ts superStatus):
// registered on the chain; online (the node's peer view or its on-chain heartbeat); when it was last seen (ms), from the
// nodes or the explorer archive's newest heartbeat, null when neither knows; its heartbeats this epoch against the number
// needed; barred by the network (a reputation below its floor); and the node balance in decimal nano QNC.
export interface SuperStatusView {
  registered: boolean;
  online: boolean;
  lastSeenAt: number | null;
  heartbeats: { current: number; required: number } | null;
  banned: boolean;
  balanceNano: string | null;
}

export type SuperState = 'none' | 'online' | 'offline';

const SUPER_KEYS = ['registered', 'online', 'lastSeenAt', 'heartbeats', 'banned', 'balanceNano'];

// GET /api/cabinet/super/:id, exactly.
export function parseSuperStatus(body: unknown): SuperStatusView | null {
  if (!isObject(body) || !hasKeys(body, SUPER_KEYS)) return null;
  if (typeof body.registered !== 'boolean' || typeof body.online !== 'boolean' || typeof body.banned !== 'boolean') return null;
  if (body.lastSeenAt !== null && !isCount(body.lastSeenAt)) return null;
  const h = body.heartbeats;
  if (h !== null && (!isObject(h) || !hasKeys(h, ['current', 'required']) || !isCount(h.current) || !isCount(h.required) || h.required < 1)) return null;
  if (body.balanceNano !== null && (typeof body.balanceNano !== 'string' || !NANO_RE.test(body.balanceNano))) return null;
  if (!body.registered && (body.online || body.lastSeenAt !== null || h !== null || body.banned || body.balanceNano !== null)) return null;
  return body as unknown as SuperStatusView;
}

export function superState(s: SuperStatusView): SuperState {
  if (!s.registered) return 'none';
  return s.online ? 'online' : 'offline';
}

const TX_RE = /^[A-Za-z0-9_-]{8,128}$/;

function isHistoryRow(r: unknown): boolean {
  if (!isObject(r) || !hasKeys(r, ['epoch', 'result', 'amountQnc', 'endedAt', 'claimTx']) || !isCount(r.epoch)) return false;
  if (!(HISTORY_RESULTS as readonly unknown[]).includes(r.result)) return false;
  if (r.amountQnc !== null && (typeof r.amountQnc !== 'number' || !Number.isFinite(r.amountQnc) || r.amountQnc < 0)) return false;
  if (r.endedAt !== null && !isCount(r.endedAt)) return false;
  return r.claimTx === null || (typeof r.claimTx === 'string' && TX_RE.test(r.claimTx));
}

// GET /api/cabinet/node/:id/history, exactly.
export function parseHistoryView(body: unknown): HistoryView | null {
  if (!isObject(body) || !hasKeys(body, ['registeredEpoch', 'archived', 'rows', 'earlier'])) return null;
  if (body.registeredEpoch !== null && !isCount(body.registeredEpoch)) return null;
  if (typeof body.archived !== 'boolean') return null;
  if (!Array.isArray(body.rows) || body.rows.length > HISTORY_ROWS_MAX || !body.rows.every(isHistoryRow)) return null;
  if (!Array.isArray(body.earlier) || body.earlier.length > EARLIER_ROWS_MAX || !body.earlier.every(isHistoryRow)) return null;
  return body as unknown as HistoryView;
}

// The node's state: the device's own state when the node names it, else read from the binding and the network's ask
// to come back (a node of an earlier version).
export function nodeState(s: NodeStatusView): NodeState {
  if (!s.registered) return s.pending ? 'pending' : 'none';
  const device = s.device ?? null;
  if (device) {
    if (device.state === 'unlinked') return 'no_device';
    if (device.state === 'other_device_pending') return 'device_pending';
    return device.state;
  }
  if (!s.deviceBound) return 'no_device';
  return s.needsReactivation ? 'offline' : 'online';
}

const PLATFORM_TEXT: Record<DevicePlatform, MessageKey> = {
  android: 'device_platform_android',
  ios: 'device_platform_ios',
  unknown: 'device_platform_unknown',
};
const PLATFORM_SHORT: Record<DevicePlatform, MessageKey | null> = {
  android: 'device_platform_android',
  ios: 'device_platform_ios_short',
  unknown: null,
};

// The linked device as the Device tab names it: its model, then its platform ("{model} · Android"); the model alone
// when the platform is not known, the platform alone when the model is not; null while no device is linked.
export function deviceName(d: Pick<DeviceView, 'platform' | 'model'>): string | null {
  if (d.platform === null) return null;
  const short = PLATFORM_SHORT[d.platform];
  if (d.model === null) return t(PLATFORM_TEXT[d.platform]);
  return short === null ? d.model : t('device_model_platform', { model: d.model, platform: t(short) });
}

// A device runs the node, or was just linked to run it.
export const isLinkedState = (state: NodeState): boolean => state === 'online' || state === 'offline' || state === 'device_pending';

export function canMove(balanceNano: string | null): boolean {
  return balanceNano !== null && BigInt(balanceNano) >= MOVE_MIN_NANO;
}

const GROUPED = new Intl.NumberFormat('en');

// Base units of a token with `decimals` places, exact: the whole part grouped as English writes it, the fraction
// without trailing zeros.
export function formatUnits(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = GROUPED.format(raw / unit);
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

// Nano QNC as QNC.
export function formatQnc(balanceNano: string): string {
  return formatUnits(BigInt(balanceNano), NANO_DIGITS);
}

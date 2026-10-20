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
// moved to the wallet, not counted, the epoch the node was registered in and not counted, not checked (the network
// published no check of the node's group that epoch, so the node is not blamed), not admitted (a super node outside the
// set the network admitted to the super node share that epoch: the network's admission, not missed heartbeats), or not
// readable from the network now.
export const HISTORY_RESULTS = ['counted', 'moved', 'missed', 'joined', 'unchecked', 'not_admitted', 'unknown'] as const;
export type HistoryResult = (typeof HISTORY_RESULTS)[number];

export interface HistoryRow {
  epoch: number;
  result: HistoryResult;
  // QNC added to the node balance; null where nothing was added or the amount is not known.
  amountQnc: number | null;
  // When the epoch began and ended (its first block and its successor's, ms), from the explorer's archive; null when
  // not known.
  startedAt: number | null;
  endedAt: number | null;
  // The transaction that moved it to the wallet, from the explorer's archive; null when not moved or not known.
  claimTx: string | null;
  // Why a light node's epoch not counted was missed, as its shard's owners keep it (last-miss.ts missesByEpoch); null for
  // any other result, for one not counted only because the wallet's super node earned nothing (node-proxy.ts
  // historyView), when no owner keeps that epoch's miss, and for an address only viewed (publicHistory).
  miss: LastMiss | null;
}

// What the wallet's node earned, as of one moment (node-proxy.ts historyView): the QNC every move took to the wallet
// (decimal nano, from the explorer archive's moves, which replay to the network's own watermark of moved epochs) and
// the node balance the node that gave the page reported just before it.
export interface HistoryEarned {
  movedNano: string;
  balanceNano: string;
}

// One page of the node's epochs (GET /api/cabinet/node/:id/history?page=N), newest first.
export interface HistoryView {
  // The epoch of the wallet's first node registration, where its epochs start, from the explorer's archive; null when
  // not known (epochs from before it may then be listed).
  registeredEpoch: number | null;
  // Whether the explorer's archive answered (dates, the moves' transactions, the registration).
  archived: boolean;
  rows: HistoryRow[];
  // Older epochs of the node follow on the next page.
  more: boolean;
  // The first page's: null on a later page, and when the archive or the nodes could not answer it for one moment.
  earned: HistoryEarned | null;
}

// The epochs of a page; a page after the first repeats the epoch before it (node-proxy.ts historyPath), so a page read
// a moment apart from the one before skips none.
export const HISTORY_PAGE_ROWS = 30;
export const HISTORY_PAGE_MAX = 1_000;
// How long the site keeps a page of a node's epochs (node-proxy.ts HISTORY_CACHE_MS).
export const HISTORY_KEPT_MS = 30_000;
// The epochs a node keeps the details of to serve their results (development/qnet-integration/src/node/rewards.rs
// SHARD_CACHE_RETAIN_EPOCHS): 256, about six weeks.
export const EPOCHS_KEPT = 256;

// `device_pending`: a device linked less than an epoch ago that has not answered yet, while nothing counted the node in
// this epoch or the two before.
export type NodeState = 'none' | 'pending' | 'no_device' | 'device_pending' | 'online' | 'offline';

export const MOVE_MIN_NANO = 1_000_000_000n;
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

// The status route, and its read for an address only viewed (`view`): GET /api/cabinet/node/:id?view=1 answers the same
// status with the device's details that are not the network's left out (publicStatus).
export function statusPath(nodeId: string, view: boolean): string {
  return `/api/cabinet/node/${encodeURIComponent(nodeId)}${view ? '?view=1' : ''}`;
}

// A status for a viewed address: the device's state and the epoch of its last answer are the network's; its platform,
// its model, the day it linked and its account of a missed epoch are the owner's device details, so none is passed on.
export function publicStatus(s: NodeStatusView): NodeStatusView {
  return s.device ? { ...s, device: { ...s.device, platform: null, model: null, linkedSince: null, lastMiss: null } } : s;
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

// A super node's admission as the node's status names it (development/qnet-integration/src/node/registration.rs
// super_admission_label): in the set the network admits to consensus and the super node share this epoch (one allowlist
// decides both), outside it (no super node share while outside), or no admission rule this epoch.
export const SUPER_ADMISSIONS = ['admitted', 'waiting', 'not_required'] as const;
export type SuperAdmission = (typeof SUPER_ADMISSIONS)[number];

// A super node as the site's super route reads it from the nodes (src/server/cabinet/node-proxy.ts superStatus):
// registered on the chain; online (the node's peer view or its on-chain heartbeat); when it was last seen (ms), from the
// nodes or the explorer archive's newest heartbeat, null when neither knows; its heartbeats this epoch against the number
// needed; barred by the network (a reputation below its floor); the node balance in decimal nano QNC; its admission as
// the node names it (null from a node that does not name it); for a node whose answer names none, whether the network's
// eligible set, the nodes its consensus admits, lists it (eligible-set.ts; null when that was not read or could not be);
// whether it is on pace to be counted this epoch (null when the node does not say); the network's height and the
// server's own (null when not known); and for a node not registered yet, whether the network sees its server.
export interface SuperStatusView {
  registered: boolean;
  online: boolean;
  lastSeenAt: number | null;
  heartbeats: { current: number; required: number } | null;
  banned: boolean;
  balanceNano: string | null;
  admission: SuperAdmission | null;
  admitted: boolean | null;
  onPace: boolean | null;
  networkHeight: number | null;
  serverHeight: number | null;
  connected: boolean;
}

// `waiting`: registered, its server answers, and outside the network's admission (the node's `admission`, else outside
// the eligible set): registered, not admitted to consensus yet (owner, 11.10).
export type SuperState = 'none' | 'online' | 'offline' | 'waiting';

// The server is in step with the network within this many blocks (the node's own rule for a synced peer,
// development/qnet-integration/src/node/registration.rs get_all_public_api_nodes).
export const SERVER_SYNC_BLOCKS = 5;

const SUPER_KEYS = ['registered', 'online', 'lastSeenAt', 'heartbeats', 'banned', 'balanceNano', 'admission', 'admitted', 'onPace', 'networkHeight', 'serverHeight',
  'connected'];
const isFlag = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean';
export const isSuperAdmission = (v: unknown): v is SuperAdmission => (SUPER_ADMISSIONS as readonly unknown[]).includes(v);

// GET /api/cabinet/super/:id, exactly.
export function parseSuperStatus(body: unknown): SuperStatusView | null {
  if (!isObject(body) || !hasKeys(body, SUPER_KEYS)) return null;
  if (typeof body.registered !== 'boolean' || typeof body.online !== 'boolean' || typeof body.banned !== 'boolean' || typeof body.connected !== 'boolean') return null;
  if (body.lastSeenAt !== null && !isCount(body.lastSeenAt)) return null;
  const h = body.heartbeats;
  if (h !== null && (!isObject(h) || !hasKeys(h, ['current', 'required']) || !isCount(h.current) || !isCount(h.required) || h.required < 1)) return null;
  if (body.balanceNano !== null && (typeof body.balanceNano !== 'string' || !NANO_RE.test(body.balanceNano))) return null;
  if (!isFlag(body.admitted) || !isFlag(body.onPace)) return null;
  if (body.admission !== null && !isSuperAdmission(body.admission)) return null;
  if ((body.networkHeight !== null && !isCount(body.networkHeight)) || (body.serverHeight !== null && !isCount(body.serverHeight))) return null;
  if (!body.registered && (body.online || body.lastSeenAt !== null || h !== null || body.banned || body.balanceNano !== null || body.admission !== null
    || body.admitted !== null || body.onPace !== null || body.networkHeight !== null || body.serverHeight !== null)) return null;
  if (body.registered && body.connected) return null;
  return body as unknown as SuperStatusView;
}

// Whether the network has not admitted the node: its own `admission` when the node names one, else outside the
// eligible set; null when neither is known.
const outsideAdmission = (s: Pick<SuperStatusView, 'admission' | 'admitted'>): boolean | null =>
  (s.admission !== null ? s.admission === 'waiting' : s.admitted === null ? null : !s.admitted);

// Offline first: the network also drops an admitted node from its eligible set once it misses the heartbeats of a
// window or its reputation falls below the floor (committee.rs inactivity shrink), so outside the set alone does not
// mean waiting, and a stopped server is the thing to fix before its admission; a barred node is told so by its own row.
export function superState(s: SuperStatusView): SuperState {
  if (!s.registered) return 'none';
  if (!s.online) return 'offline';
  return outsideAdmission(s) === true && !s.banned ? 'waiting' : 'online';
}

const TX_RE = /^[A-Za-z0-9_-]{8,128}$/;

function isHistoryRow(r: unknown): boolean {
  if (!isObject(r) || !hasKeys(r, ['epoch', 'result', 'amountQnc', 'startedAt', 'endedAt', 'claimTx', 'miss']) || !isCount(r.epoch)) return false;
  if (!(HISTORY_RESULTS as readonly unknown[]).includes(r.result)) return false;
  if (r.amountQnc !== null && (typeof r.amountQnc !== 'number' || !Number.isFinite(r.amountQnc) || r.amountQnc < 0)) return false;
  if (r.startedAt !== null && !isCount(r.startedAt)) return false;
  if (r.endedAt !== null && !isCount(r.endedAt)) return false;
  // A miss only on an epoch not counted, and of that epoch.
  if (!isLastMiss(r.miss) || (r.miss !== null && (r.result !== 'missed' || r.miss.epoch !== r.epoch))) return false;
  return r.claimTx === null || (typeof r.claimTx === 'string' && TX_RE.test(r.claimTx));
}

const isNano = (v: unknown): v is string => typeof v === 'string' && NANO_RE.test(v);
const isEarned = (v: unknown): boolean => v === null || (isObject(v) && hasKeys(v, ['movedNano', 'balanceNano']) && isNano(v.movedNano) && isNano(v.balanceNano));

// The history route's page N, and its read for an address only viewed (`view`: publicHistory), whose address no
// connected wallet's read shares.
export function historyPagePath(nodeId: string, page: number, view: boolean): string {
  const query = [page > 0 ? `page=${page}` : '', view ? 'view=1' : ''].filter((q) => q !== '').join('&');
  return `/api/cabinet/node/${encodeURIComponent(nodeId)}/history${query === '' ? '' : `?${query}`}`;
}

// A page for a viewed address: why an epoch was missed is the owner's account of the device (publicStatus), so none is
// passed on.
export function publicHistory(h: HistoryView): HistoryView {
  return h.rows.some((r) => r.miss !== null) ? { ...h, rows: h.rows.map((r) => ({ ...r, miss: null })) } : h;
}

// GET /api/cabinet/node/:id/history[?page=N][&view=1], exactly.
export function parseHistoryView(body: unknown): HistoryView | null {
  if (!isObject(body) || !hasKeys(body, ['registeredEpoch', 'archived', 'rows', 'more', 'earned'])) return null;
  if (body.registeredEpoch !== null && !isCount(body.registeredEpoch)) return null;
  if (typeof body.archived !== 'boolean' || typeof body.more !== 'boolean') return null;
  if (!Array.isArray(body.rows) || body.rows.length > HISTORY_PAGE_ROWS + 1 || !body.rows.every(isHistoryRow)) return null;
  if (!isEarned(body.earned)) return null;
  return body as unknown as HistoryView;
}

// "Total earned" (owner, 13.10): the moves plus the node balance, both of the history's one moment, so a move between
// two reads never counts twice or not at all. Shown while that balance is the one the page shows (`shown`, the status
// read's); while they differ (a move, or an epoch settled, between the two reads) the history is read again
// (`reading`), and once the page gave up on that (`gaveUp`) or without the history's answer it is unknown, with the
// balance the page shows: never a total from two moments.
export type EarnedView =
  | { kind: 'total'; totalNano: string; movedNano: string; balanceNano: string }
  | { kind: 'reading' }
  | { kind: 'unknown'; balanceNano: string | null };

export function earnedView(earned: HistoryEarned | null, shown: string | null, gaveUp = false): EarnedView {
  if (earned === null) return { kind: 'unknown', balanceNano: shown };
  if (shown !== null && shown !== earned.balanceNano) return gaveUp ? { kind: 'unknown', balanceNano: shown } : { kind: 'reading' };
  const { movedNano, balanceNano } = earned;
  return { kind: 'total', totalNano: (BigInt(movedNano) + BigInt(balanceNano)).toString(), movedNano, balanceNano };
}

// The pages read so far as one list, newest first, each epoch once (a page repeats the epoch before it, and one read
// after a new epoch settled repeats more); the first page's row wins.
export function joinPages(pages: readonly HistoryView[]): HistoryRow[] {
  const byEpoch = new Map<number, HistoryRow>();
  for (const page of pages) {
    for (const row of page.rows) if (!byEpoch.has(row.epoch)) byEpoch.set(row.epoch, row);
  }
  return [...byEpoch.values()].sort((a, b) => b.epoch - a.epoch);
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

// Amounts as the explorer writes them: exact, the whole part grouped as English writes it, no trailing zeros.
export { formatQnc, formatTokenAmount as formatUnits } from '../token-format.ts';

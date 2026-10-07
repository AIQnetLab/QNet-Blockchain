// The cabinet's reads of a node, through the site (the pages talk only to this origin): a light node's public status
// of docs/protocols/light-node-messages.md section 7 from two genesis nodes that must agree whether the node is
// registered (a "no" only from nodes at the network's height, and only while none lists it), the genesis that wakes
// the node's device asked first (lightShardOwners) and every owner of its shard asked for a miss the page names, the
// node balance, and the node's epochs one by one (the nodes' reward history, with the explorer's archive for the
// dates, the moves to the wallet and the registration: epoch-archive.ts), and a super node's status (online, last seen, its heartbeats, its
// standing and balance) from the nodes' server status. Each route takes only a node id, answers exact shapes
// (src/lib/cabinet/node-view.ts), caches per node for about the page's poll interval ("not registered" a little longer),
// shares one upstream round between concurrent readers of a node, meters every client (limits.ts) and, apart, each
// client's reads that miss the cache and go upstream, and asks each genesis node at most a set number of reads a second,
// whatever the clients do, an id nobody has seen registered on a small budget of its own (upstream.ts, known-nodes.ts).

import { blake3 } from '@noble/hashes/blake3';
import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { isLightNodeId, isSuperNodeId, lightNodeId, superNodeId } from '../../lib/qnet-link.ts';
import { isEonAddress } from '../../lib/qnet-provider.ts';
import { epochOfHeight, epochOfKey } from '../../lib/cabinet/epochs.ts';
import { asksOtherOwners, latestMiss, parseNodeMiss, type LastMiss } from '../../lib/cabinet/last-miss.ts';
import {
  DEVICE_PLATFORMS, DEVICE_STATES, EARLIER_ROWS_MAX, HISTORY_ROWS_MAX, STATUS_KEPT_MS, isDeviceModel, isFeatureList, type DevicePlatform, type DeviceState, type DeviceView, type HistoryResult,
  type HistoryRow, type HistoryView, type NodeStatusView, type SuperStatusView,
} from '../../lib/cabinet/node-view.ts';
import type { ArchiveFacts, EpochArchive } from './epoch-archive.ts';
import { memo } from './cache.ts';
import { knownNodes, type KnownNodes } from './known-nodes.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';
import { sharedUpstreamBudget, unbudgeted, type UpstreamBudget, type UpstreamKind } from './upstream.ts';

// A page reads a node's status every half minute (hooks/useNodeStatus.ts): an answer is kept about that long, and a
// settled "not registered, not being recorded" (or a super node "not registered") a little longer (SITE M-12). A
// reservation's read keeps its own answers a few seconds only.
export const STATUS_CACHE_MS = STATUS_KEPT_MS;
export const SUPER_CACHE_MS = 25_000;
export const NONE_CACHE_MS = 30_000;
export const RESERVE_CACHE_MS = 5_000;
export const HISTORY_CACHE_MS = 30_000;
// The epochs asked of a node per read (the node's own maximum), and how many pages of them are read for a node whose
// id derives from the wallet the node names: up to 400 epochs, about 66 days, so a node from before the cabinet shows
// its older epochs too. A made-up id costs one read per node.
export const HISTORY_PAGE = 100;
export const HISTORY_PAGES_MAX = 4;
const NODE_TIMEOUT_MS = 4_000;
const NODE_BODY_MAX_BYTES = 64 * 1024;

// The public status fields the cabinet reads; any other field of a node's answer is ignored.
export interface PublicStatus {
  onchain_registered: boolean;
  registration_pending: boolean;
  device_bound: boolean;
  answered_this_epoch: boolean;
  needs_reactivation: boolean;
  counted: { epochs_since_registration: number; counted: number; last_counted_epoch: number | null };
  features: string[];
  // False while the answering node is behind the network height it cached: its "not registered" and "not pending"
  // then settle nothing (section 7). A node from before the field is taken as authoritative.
  authoritative: boolean;
  // The linked device (section 7): null for a node not on the chain, or a node from before the field.
  device: PublicDevice | null;
}

export interface PublicDevice {
  platform: DevicePlatform | null;
  // `model` as read: null when absent (a node of an earlier version) or not a model as the node keeps it.
  model: string | null;
  linked_since: number | null;
  last_answer_epoch: number | null;
  state: DeviceState;
  // `last_miss` as read (last-miss.ts parseNodeMiss): its epoch, its reason and whether the wake reached the device;
  // null for none, an unknown reason or a record that cannot be read.
  last_miss: LastMiss | null;
}

const DEVICE_FIELDS = ['platform', 'linked_since', 'last_answer_epoch', 'state'];

// `device` of a public status: absent or null is none; anything else must carry the four fields the cabinet reads, each
// valid. `model` and `last_miss` are read on their own (one this site cannot read is none); any other field is ignored,
// as in the status itself. A node of an earlier version also sends the exact time of the last answer (`last_answer_at`,
// `last_answer`) and the times, delays and app outcome of a miss: none of it is kept, so neither the route's answer nor
// its shared cache ever holds it.
export function parsePublicDevice(v: unknown): PublicDevice | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObject(v) || !DEVICE_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(v, k))) return undefined;
  const { platform, linked_since: since, last_answer_epoch: last, state } = v;
  if (platform !== null && !(DEVICE_PLATFORMS as readonly unknown[]).includes(platform)) return undefined;
  if (since !== null && !isCount(since)) return undefined;
  if (last !== null && !isCount(last)) return undefined;
  if (!(DEVICE_STATES as readonly unknown[]).includes(state)) return undefined;
  return {
    platform: platform as DevicePlatform | null, model: isDeviceModel(v.model) ? v.model : null, linked_since: since as number | null,
    last_answer_epoch: last as number | null, state: state as DeviceState, last_miss: parseNodeMiss(v.last_miss),
  };
}

// The genesis nodes owning a light node's shard, as indexes into GENESIS_NODES (development/qnet-integration/src/
// node/mod.rs light_shard_of, light_shard_owners): the shard is blake3 of the node id, its first 8 bytes as a
// little-endian u64, mod 5; its owners are that genesis and the next two around the ring, the first the one that wakes
// the node's device while it runs. Only the owners keep the record of why an epoch was not counted (last-miss.ts).
export function lightShardOwners(nodeId: string): [number, number, number] {
  const h = blake3(new TextEncoder().encode(nodeId));
  const shard = Number(new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, true) % 5n);
  return [shard, (shard + 1) % 5, (shard + 2) % 5];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parsePublicStatus(body: unknown): PublicStatus | null {
  if (!isObject(body)) return null;
  for (const k of ['onchain_registered', 'registration_pending', 'device_bound', 'answered_this_epoch', 'needs_reactivation']) {
    if (typeof body[k] !== 'boolean') return null;
  }
  const c = body.counted;
  if (!isObject(c) || !isCount(c.epochs_since_registration) || !isCount(c.counted) || c.counted > c.epochs_since_registration) return null;
  const last = c.last_counted_epoch ?? null;
  if (last !== null && !isCount(last)) return null;
  if (!isFeatureList(body.features)) return null;
  const authoritative = body.authoritative === undefined ? true : body.authoritative;
  if (typeof authoritative !== 'boolean') return null;
  const device = parsePublicDevice(body.device);
  if (device === undefined) return null;
  return {
    onchain_registered: body.onchain_registered as boolean,
    registration_pending: body.registration_pending as boolean,
    device_bound: body.device_bound as boolean,
    answered_this_epoch: body.answered_this_epoch as boolean,
    needs_reactivation: body.needs_reactivation as boolean,
    counted: { epochs_since_registration: c.epochs_since_registration, counted: c.counted, last_counted_epoch: last },
    features: body.features,
    authoritative,
    device: body.onchain_registered ? device : null,
  };
}

// GET /api/v1/node/status?node_id= of a super node (development/qnet-integration/src/rpc/light_nodes.rs
// handle_server_node_status), the fields the cabinet reads: registered on the chain, online (the node's peer view or the
// on-chain heartbeat), when it was last seen (seconds; 0 when not known), its heartbeats this epoch and the number
// needed, its reputation. Null for an answer without them.
export interface ServerStatus {
  registered: boolean;
  online: boolean;
  lastSeen: number;
  heartbeats: { current: number; required: number } | null;
  reputation: number | null;
}

export function parseServerStatus(body: unknown): ServerStatus | null {
  if (!isObject(body) || body.success !== true) return null;
  const registered = typeof body.onchain_registered === 'boolean' ? body.onchain_registered : body.registered;
  if (typeof registered !== 'boolean') return null;
  const online = body.is_online === true;
  const lastSeen = isCount(body.last_seen) ? body.last_seen : 0;
  const heartbeats = isCount(body.heartbeat_count) && isCount(body.required_heartbeats) && body.required_heartbeats > 0
    ? { current: body.heartbeat_count, required: body.required_heartbeats } : null;
  const reputation = typeof body.reputation === 'number' && Number.isFinite(body.reputation) ? body.reputation : null;
  return { registered, online: registered && online, lastSeen, heartbeats, reputation };
}

// A node the network barred: reputation below the floor a node needs (the network keeps 70 for a node in good
// standing and 0 for a proven equivocation).
export const REPUTATION_FLOOR = 70;

// GET /api/v1/rewards/pending/{id}: the exact nano amount.
export function parsePending(body: unknown): string | null {
  if (!isObject(body) || !isCount(body.pending_rewards_nano)) return null;
  return String(body.pending_rewards_nano);
}

// A node's verdict on one epoch (rewards_api.rs reward_history_status): paid and not moved yet, paid and moved, not
// counted, the node's group not checked that epoch, or not servable by this node.
const NODE_STATUSES = ['claimable', 'claimed', 'not_eligible', 'shard_not_certified', 'unavailable'] as const;
type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeHistory {
  // The wallet the node resolves the node id to; null when it names none.
  wallet: string | null;
  // Newest first, by epoch key (epochs.ts).
  rows: { key: number; status: NodeStatus; amountQnc: number }[];
  // The node has older epochs past this page (its `pagination.has_more`).
  more?: boolean;
}

// GET /api/v1/rewards/history/{id}: every epoch the network settled, newest first, with the node's verdict; a status
// this site does not know is passed over.
export function parseHistory(body: unknown): NodeHistory | null {
  if (!isObject(body) || !Array.isArray(body.history) || body.history.length > 100) return null;
  const rows: NodeHistory['rows'] = [];
  for (const r of body.history) {
    if (!isObject(r) || !isCount(r.epoch) || typeof r.status !== 'string') return null;
    if (typeof r.amount_qnc !== 'number' || !Number.isFinite(r.amount_qnc) || r.amount_qnc < 0) return null;
    if ((NODE_STATUSES as readonly string[]).includes(r.status)) rows.push({ key: r.epoch, status: r.status as NodeStatus, amountQnc: r.amount_qnc });
  }
  const more = isObject(body.pagination) && body.pagination.has_more === true;
  return { wallet: isEonAddress(body.wallet) ? body.wallet : null, rows, more };
}

// A second node's answer fills the epochs the first could not serve; an answer for another wallet adds nothing.
export function mergeHistory(a: NodeHistory, b: NodeHistory): NodeHistory {
  if (a.wallet !== b.wallet) return a;
  const served = new Map(b.rows.filter((r) => r.status !== 'unavailable').map((r) => [r.key, r]));
  return { wallet: a.wallet, rows: a.rows.map((r) => (r.status === 'unavailable' ? served.get(r.key) ?? r : r)) };
}

const RESULTS: Record<NodeStatus, HistoryResult> = {
  claimable: 'counted',
  claimed: 'moved',
  not_eligible: 'missed',
  shard_not_certified: 'unchecked',
  unavailable: 'unknown',
};

// The page's epochs: the nodes' verdicts from the node's registration on (every epoch before it is left out; the
// registration's own epoch, not counted, is marked as such), with the archive's dates and moves; then the older epochs
// the archive knows as moved. Without the archive (`facts` null) nothing is dated and no epoch is left out.
export function historyView(node: NodeHistory, facts: ArchiveFacts | null): HistoryView {
  const registeredEpoch = facts && facts.registeredHeight !== null ? epochOfHeight(facts.registeredHeight) : null;
  const after = (epoch: number) => registeredEpoch === null || epoch >= registeredEpoch;
  const rows: HistoryRow[] = [];
  const seen = new Set<number>();
  let oldestKey = Number.POSITIVE_INFINITY;
  for (const r of node.rows) {
    const span = epochOfKey(r.key);
    if (!span || seen.has(r.key)) continue;
    seen.add(r.key);
    oldestKey = Math.min(oldestKey, r.key);
    if (!after(span.epoch)) continue;
    let result = RESULTS[r.status];
    if (result === 'missed' && span.epoch === registeredEpoch) result = 'joined';
    const paid = result === 'counted' || result === 'moved';
    rows.push({
      epoch: span.epoch,
      result,
      amountQnc: paid ? r.amountQnc : null,
      endedAt: facts?.times.get(span.end) ?? null,
      claimTx: result === 'moved' ? facts?.claims.get(r.key)?.tx ?? null : null,
    });
  }
  const earlier: HistoryRow[] = [];
  const moved = facts ? [...facts.claims].sort((a, b) => b[0] - a[0]) : [];
  for (const [key, claim] of moved) {
    const span = epochOfKey(key);
    if (!span || key >= oldestKey || !after(span.epoch)) continue;
    earlier.push({
      epoch: span.epoch,
      result: 'moved',
      amountQnc: claim.amountNano === null ? null : Number(claim.amountNano) / 1e9,
      endedAt: facts?.times.get(span.end) ?? null,
      claimTx: claim.tx,
    });
  }
  rows.sort((a, b) => b.epoch - a.epoch);
  return { registeredEpoch, archived: facts !== null, rows: rows.slice(0, HISTORY_ROWS_MAX), earlier: earlier.slice(0, EARLIER_ROWS_MAX) };
}

// The two answers that settle the registration (section 7), or null while the answers settle nothing yet: two that
// list the node; or, while none lists it, two authoritative ones that do not. A node behind the network
// (`authoritative: false`) that does not list the node settles nothing: its "no" may only be that it has not reached
// the registration yet, and a page that took it would burn, and sign an owner bind, for a wallet with a node.
export function settlingPair(got: readonly PublicStatus[]): [PublicStatus, PublicStatus] | null {
  const listed = got.filter((s) => s.onchain_registered);
  if (listed.length >= 2) return [listed[0], listed[1]];
  if (listed.length > 0) return null;
  const vouched = got.filter((s) => s.authoritative);
  return vouched.length >= 2 ? [vouched[0], vouched[1]] : null;
}

// How many more answers could still settle the registration: the listing answers two lack, or, while none lists the
// node, the authoritative ones two lack.
export function stillNeeded(got: readonly PublicStatus[]): number {
  const listed = got.filter((s) => s.onchain_registered).length;
  const have = listed > 0 ? listed : got.filter((s) => s.authoritative).length;
  return Math.max(1, 2 - have);
}

// The answers `seen`, settled by the pair `a`, `b` (settlingPair), as the cabinet shows them: the details of the
// first, the features both list, whether any answer saw a registration on its way (a node behind the network that saw
// one is right about it), and the latest miss any answer names (last-miss.ts latestMiss). Whether the node answered this epoch and needs reactivation are the word of `owners`, the answers of
// the genesis nodes owning its light shard that list it, those at the network's height when any is (a node behind
// reads an older epoch), else the pair's: answered when any of them says so, needs reactivation only when all do. An
// owner that missed the one relay of an answer (down or restarting when the device answered at another) is not the
// network's word; the device's state and its last answer's epoch follow. Null for anything settlingPair would not have
// settled.
export function mergeStatus(
  a: PublicStatus, b: PublicStatus, balanceNano: string | null, seen: readonly PublicStatus[] = [], owners: readonly PublicStatus[] = [],
): NodeStatusView | null {
  if (a.onchain_registered !== b.onchain_registered) return null;
  if (!a.onchain_registered && (!a.authoritative || !b.authoritative || seen.some((s) => s.onchain_registered))) return null;
  const listing = owners.filter((s) => s.onchain_registered);
  const current = listing.filter((s) => s.authoritative);
  const voters = !a.onchain_registered ? [a] : current.length > 0 ? current : listing.length > 0 ? listing : [a, b];
  const answered = voters.some((s) => s.answered_this_epoch);
  const needsReactivation = !answered && voters.every((s) => s.needs_reactivation);
  return {
    registered: a.onchain_registered,
    pending: !a.onchain_registered && [a, b, ...seen].some((s) => s.registration_pending),
    deviceBound: a.device_bound,
    answeredThisEpoch: answered,
    needsReactivation,
    counted: {
      sinceRegistration: a.counted.epochs_since_registration,
      counted: a.counted.counted,
      lastCountedEpoch: a.counted.last_counted_epoch,
    },
    features: a.features.filter((f) => b.features.includes(f)),
    balanceNano: a.onchain_registered ? balanceNano : null,
    device: a.device ? deviceView(a.device, [a, b, ...seen], voters, needsReactivation === a.needs_reactivation ? null : needsReactivation) : null,
  };
}

// The device as the first answer names it, with its last answer's epoch as `voters` (mergeStatus) have it; its state
// is the first answer's own unless `needsReactivation` (the voters' word, when it differs from the first answer's)
// turns it, by the node's own rule: a bound device is Online unless the node needs reactivation. The miss from every
// answer.
function deviceView(d: PublicDevice, answers: readonly PublicStatus[], voters: readonly PublicStatus[], needsReactivation: boolean | null): DeviceView {
  const waiting = (s: PublicStatus) => s.device?.state === 'offline' || s.device?.state === 'other_device_pending';
  const state: DeviceState = needsReactivation === null || d.state === 'unlinked' ? d.state
    : !needsReactivation ? 'online'
    : voters.find(waiting)?.device?.state ?? 'offline';
  const epochs = voters.map((s) => s.device?.last_answer_epoch ?? null).filter((e): e is number => e !== null);
  const lastAnswerEpoch = epochs.length > 0 ? Math.max(...epochs) : d.last_answer_epoch;
  return {
    platform: d.platform, model: d.model, linkedSince: d.linked_since, lastAnswerEpoch, state, lastMiss: latestMiss(answers.map((s) => s.device?.last_miss)),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface NodeProxyOptions extends GateOptions {
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  gate?: Gate;
  budget?: UpstreamBudget;
  // The ids seen registered (known-nodes.ts); the process's set by default.
  known?: KnownNodes;
}

// The explorer archive's newest heartbeat of a super node (epoch-archive.ts lastHeartbeat), its block time in ms.
export type LastHeartbeat = (nodeId: string) => Promise<number | null>;

export interface NodeProxy {
  status(request: Request, nodeId: string): Promise<Response>;
  // `archive`: the explorer's archive (epoch-archive.ts); without it the epochs come undated. A light or a super id.
  history(request: Request, nodeId: string, archive?: EpochArchive): Promise<Response>;
  // GET /api/cabinet/super/:id: a super node's status (SuperStatusView).
  superStatus(request: Request, nodeId: string, lastHeartbeat?: LastHeartbeat): Promise<Response>;
  // A light node's settled status (wallet-node.ts); null when not settled. A page's read shares the status route's cache
  // and read budget; a reservation's (`reserve`) has a cache and a budget of its own, so page reads never starve it.
  view(nodeId: string, kind?: 'read' | 'reserve'): Promise<NodeStatusView | null>;
}

export function createNodeProxy(options: NodeProxyOptions = {}): NodeProxy {
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const gate = options.gate ?? createGate(options);
  const budget = options.budget ?? unbudgeted;
  const known = options.known ?? knownNodes();
  const statusCache = memo<NodeStatusView | null>((v) => (v !== null && !v.registered && !v.pending ? NONE_CACHE_MS : STATUS_CACHE_MS), now);
  const reserveCache = memo<NodeStatusView | null>(RESERVE_CACHE_MS, now);
  const historyCache = memo<HistoryView | null>(HISTORY_CACHE_MS, now);
  const superCache = memo<SuperStatusView | null>((v) => (v !== null && !v.registered ? NONE_CACHE_MS : SUPER_CACHE_MS), now);
  // A page's read of an id: on the budget of ids seen registered, or on the small one of every other id.
  const pageKind = (nodeId: string): UpstreamKind => (known.has(nodeId) ? 'readKnown' : 'readUnknown');
  // A page's read that goes upstream counts against the client's own share (limits.ts CLIENT_BUDGETS.upstreamMiss).
  const spent = (request: Request, cached: boolean): Response | null => (cached ? null : gate.spend(request, 'upstreamMiss'));

  const shuffle = (list: readonly string[]): string[] => {
    const order = [...list];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  };
  const shuffled = (): string[] => shuffle(nodes);

  // The order a light node's status is asked in: the genesis that wakes its device, then the shard's other two owners,
  // then the rest, each group shuffled, so the answers carry the owners' record of a miss. Every genesis owns three of
  // the five shards and wakes one, so the reads spread over the nodes as evenly as in a random order. A list other
  // than the five genesis nodes is shuffled as a whole.
  const statusOrder = (nodeId: string): string[] => {
    if (nodes.length !== 5) return shuffled();
    const [first, ...backups] = lightShardOwners(nodeId);
    const rest = [0, 1, 2, 3, 4].filter((i) => i !== first && !backups.includes(i));
    return [nodes[first], ...shuffle(backups.map((i) => nodes[i])), ...shuffle(rest.map((i) => nodes[i]))];
  };
  const ownerBases = (nodeId: string): string[] => (nodes.length === 5 ? lightShardOwners(nodeId).map((i) => nodes[i]) : []);

  // A node's answer, or null; a node whose budget of `kind` this second is spent is not asked (upstream.ts).
  async function read(url: string, kind: UpstreamKind): Promise<unknown> {
    if (!budget(kind, url)) return null;
    try {
      const res = await fetchFn(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCappedBytes(res, NODE_BODY_MAX_BYTES);
      return bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
    } catch {
      return null;
    }
  }

  // Status answers of distinct nodes in the status order, two first, then as many more as could still settle the
  // registration, until two settle it (settlingPair) or no node is left: then the network could not be read. A page's
  // read whose answers name a miss the Overview shows, or a wake with no answer that lacks the device's account
  // (last-miss.ts asksOtherOwners), or whose owners call the device Offline, also asks the shard's owners not asked yet,
  // once, so the most telling record any owner keeps is the one shown and an owner holding the device's answer is
  // heard; a reservation's read does not. A page's read goes on the budget of its id (pageKind), and an id the network
  // lists as registered is noted as seen.
  async function loadStatus(nodeId: string, kind: 'read' | 'reserve' = 'read'): Promise<NodeStatusView | null> {
    const upstream: UpstreamKind = kind === 'reserve' ? 'reserve' : pageKind(nodeId);
    const view = await settleStatus(nodeId, kind, upstream);
    if (view?.registered) known.note(nodeId);
    return view;
  }

  async function settleStatus(nodeId: string, kind: 'read' | 'reserve', upstream: UpstreamKind): Promise<NodeStatusView | null> {
    const q = encodeURIComponent(nodeId);
    const statusUrl = (base: string) => `${base}/api/v1/light-node/status?node_id=${q}`;
    const order = statusOrder(nodeId);
    const got: PublicStatus[] = [];
    const baseOf = new Map<PublicStatus, string>();
    let pair = settlingPair(got);
    while (pair === null && order.length > 0) {
      const batch = order.splice(0, stillNeeded(got));
      const answered = await Promise.all(batch.map(async (base) => ({ base, value: parsePublicStatus(await read(statusUrl(base), upstream)) })));
      for (const { base, value } of answered) {
        if (value === null) continue;
        got.push(value);
        baseOf.set(value, base);
      }
      pair = settlingPair(got);
    }
    if (pair === null) return null;
    let balance: string | null = null;
    if (pair[0].onchain_registered) {
      for (const s of pair) {
        balance = parsePending(await read(`${baseOf.get(s)}/api/v1/rewards/pending/${q}`, upstream));
        if (balance !== null) break;
      }
    }
    const bases = ownerBases(nodeId);
    const ofOwners = (list: readonly PublicStatus[]) => list.filter((s) => bases.includes(baseOf.get(s) ?? ''));
    const view = mergeStatus(pair[0], pair[1], balance, got, ofOwners(got));
    const unasked = bases.filter((base) => order.includes(base));
    const offline = view?.registered === true && view.needsReactivation;
    if (view === null || kind !== 'read' || unasked.length === 0 || !(asksOtherOwners(view) || offline)) return view;
    const owners = await Promise.all(unasked.map(async (base) => ({ base, value: parsePublicStatus(await read(statusUrl(base), upstream)) })));
    const listed: PublicStatus[] = [];
    for (const { base, value } of owners) {
      if (value === null || !value.onchain_registered) continue;
      listed.push(value);
      baseOf.set(value, base);
    }
    const all = [...got, ...listed];
    return listed.length === 0 ? view : mergeStatus(pair[0], pair[1], balance, all, ofOwners(all));
  }

  const ownWallet = (wallet: string | null, nodeId: string) => wallet !== null && (lightNodeId(wallet) === nodeId || superNodeId(wallet) === nodeId);

  // One node's epochs, newest first: its first page, then, while it has more and names the wallet the id derives from,
  // older pages up to HISTORY_PAGES_MAX.
  async function nodeHistory(base: string, nodeId: string): Promise<NodeHistory | null> {
    const path = (offset: number) => `/api/v1/rewards/history/${encodeURIComponent(nodeId)}?limit=${HISTORY_PAGE}${offset > 0 ? `&offset=${offset}` : ''}`;
    const kind = pageKind(nodeId);
    let got = parseHistory(await read(`${base}${path(0)}`, kind));
    if (got === null || !ownWallet(got.wallet, nodeId)) return got;
    for (let page = 1; page < HISTORY_PAGES_MAX && got.more; page += 1) {
      const next = parseHistory(await read(`${base}${path(page * HISTORY_PAGE)}`, kind));
      if (next === null || next.wallet !== got.wallet) break;
      got = { wallet: got.wallet, rows: [...got.rows, ...next.rows], more: next.more };
    }
    return got;
  }

  // One node's history, and a second node's for the epochs the first could not serve; then the archive's facts for the
  // wallet the nodes name, when that wallet is the node's (its id derives from the wallet).
  async function loadHistory(nodeId: string, archive: EpochArchive | undefined): Promise<HistoryView | null> {
    const order = shuffled();
    let got: NodeHistory | null = null;
    let answered = 0;
    while (order.length > 0 && answered < 2 && (got === null || got.rows.some((r) => r.status === 'unavailable'))) {
      const value = await nodeHistory(order.shift() as string, nodeId);
      if (value === null) continue;
      answered += 1;
      got = got === null ? value : mergeHistory(got, value);
    }
    if (got === null) return null;
    const wallet = ownWallet(got.wallet, nodeId) ? got.wallet : null;
    let facts: ArchiveFacts | null = null;
    if (archive && wallet) {
      try {
        facts = await archive(wallet, nodeId, got.rows.map((r) => r.key));
      } catch {
        facts = null;
      }
    }
    return historyView(got, facts);
  }

  // A super node's status: one node that lists it registered answers "yes" (the details are its own); "no" needs two
  // nodes that do not list it (the page also asks the network whether the wallet has a node, wallet-node.ts). The node
  // balance from the answering node's rewards/pending; when the node knows no last-seen time, the explorer archive's
  // newest heartbeat of the node.
  async function loadSuper(nodeId: string, lastHeartbeat: LastHeartbeat | undefined): Promise<SuperStatusView | null> {
    const q = encodeURIComponent(nodeId);
    const order = shuffled();
    const kind = pageKind(nodeId);
    let no = 0;
    while (order.length > 0 && no < 2) {
      const batch = order.splice(0, Math.max(1, 2 - no));
      const answered = await Promise.all(batch.map(async (base) => ({ base, value: parseServerStatus(await read(`${base}/api/v1/node/status?node_id=${q}`, kind)) })));
      const yes = answered.find((a) => a.value?.registered);
      if (yes?.value) {
        const s = yes.value;
        known.note(nodeId);
        let balance = parsePending(await read(`${yes.base}/api/v1/rewards/pending/${q}`, kind));
        const other = answered.find((a) => a !== yes && a.value !== null);
        if (balance === null && other) balance = parsePending(await read(`${other.base}/api/v1/rewards/pending/${q}`, kind));
        let lastSeenAt: number | null = s.lastSeen > 0 ? s.lastSeen * 1000 : null;
        if (lastSeenAt === null && lastHeartbeat) {
          try {
            lastSeenAt = await lastHeartbeat(nodeId);
          } catch {
            lastSeenAt = null;
          }
        }
        return {
          registered: true, online: s.online, lastSeenAt, heartbeats: s.heartbeats,
          banned: s.reputation !== null && s.reputation < REPUTATION_FLOOR, balanceNano: balance,
        };
      }
      no += answered.filter((a) => a.value !== null).length;
    }
    return no >= 2 ? { registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null } : null;
  }

  return {
    async view(nodeId, kind = 'read') {
      if (!isLightNodeId(nodeId)) return null;
      if (kind === 'reserve') return reserveCache(nodeId, () => loadStatus(nodeId, 'reserve'), (v) => v !== null);
      return statusCache(nodeId, () => loadStatus(nodeId), (v) => v !== null);
    },

    // GET /api/cabinet/super/:id
    async superStatus(request, nodeId, lastHeartbeat) {
      const refused = gate(request, 'super');
      if (refused) return refused;
      if (!isSuperNodeId(nodeId)) return cabinetJson(400, { error: 'invalid_request' });
      const limited = spent(request, superCache.has(nodeId));
      if (limited) return limited;
      const view = await superCache(nodeId, () => loadSuper(nodeId, lastHeartbeat), (v) => v !== null);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },

    // GET /api/cabinet/node/:id
    async status(request, nodeId) {
      const refused = gate(request, 'node');
      if (refused) return refused;
      if (!isLightNodeId(nodeId)) return cabinetJson(400, { error: 'invalid_request' });
      const limited = spent(request, statusCache.has(nodeId));
      if (limited) return limited;
      const view = await statusCache(nodeId, () => loadStatus(nodeId), (v) => v !== null);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },

    // GET /api/cabinet/node/:id/history
    async history(request, nodeId, archive) {
      const refused = gate(request, 'node');
      if (refused) return refused;
      if (!isLightNodeId(nodeId) && !isSuperNodeId(nodeId)) return cabinetJson(400, { error: 'invalid_request' });
      const limited = spent(request, historyCache.has(nodeId));
      if (limited) return limited;
      const view = await historyCache(nodeId, () => loadHistory(nodeId, archive), (v) => v !== null);
      return view ? cabinetJson(200, view) : cabinetJson(503, { error: 'unavailable' });
    },
  };
}

// The process's proxy, on globalThis so every route bundle shares one cache, behind the cabinet's one gate.
const GLOBAL_KEY = Symbol.for('qnet.cabinetNodeProxy');

export function nodeProxy(): NodeProxy {
  const holder = globalThis as unknown as Record<symbol, NodeProxy | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createNodeProxy({ gate: cabinetGate(), budget: sharedUpstreamBudget() });
  holder[GLOBAL_KEY] = created;
  return created;
}

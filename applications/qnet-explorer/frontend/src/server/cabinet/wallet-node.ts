// Whether a QNet wallet has a node on the network, of either type (shared contract C3.7): the nodes' on-chain
// verify-activation (the wallet in the x-qnet-wallet header, never in a URL), two genesis nodes first, then one more at a
// time, and the wallet's light node through the status route's own reads (node-proxy.ts settlingPair: registered, or
// being recorded). A "yes" from any node settles it; a "no" needs a node at the network's height and the light node's
// settled "not registered, not being recorded"; anything less is not known, and no client burns then. The reservation
// route asks it before a wallet is held (activation-api.ts), with its own cache and its own upstream budget (`reserve`,
// upstream.ts), so that no flood of anonymous reads makes a reservation answer that the network could not be read; the
// page reads it through GET /api/cabinet/wallet-node/{wallet}, on the reads' budget: the budget of ids seen registered
// for a wallet whose node was seen, the small one of unknown ids otherwise (known-nodes.ts), and each client's read that
// goes upstream counts against its own share (limits.ts CLIENT_BUDGETS.upstreamMiss). The page's answer is kept about
// its poll interval, a "none" a little longer; a reservation's a few seconds only.

import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { lightNodeId, superNodeId, type NodeType } from '../../lib/qnet-link.ts';
import { isEonAddress } from '../../lib/qnet-provider.ts';
import type { NodeStatusView } from '../../lib/cabinet/node-view.ts';
import { memo } from './cache.ts';
import { knownNodes, type KnownNodes } from './known-nodes.ts';
import { cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';
import { NONE_CACHE_MS, RESERVE_CACHE_MS, STATUS_CACHE_MS, nodeProxy } from './node-proxy.ts';
import { sharedUpstreamBudget, unbudgeted, type UpstreamBudget, type UpstreamKind } from './upstream.ts';

export type CheckKind = 'read' | 'reserve';

export const WALLET_NODE_CACHE_MS = STATUS_CACHE_MS;
export const WALLET_NONE_CACHE_MS = NONE_CACHE_MS;
export const WALLET_RESERVE_CACHE_MS = RESERVE_CACHE_MS;
const NODE_TIMEOUT_MS = 4_000;
const NODE_BODY_MAX_BYTES = 16 * 1024;
const NODE_ID_RE = /^[a-z0-9_]{1,128}$/;

export type WalletNode = { state: 'registered'; nodeId: string; nodeType: NodeType } | { state: 'none' };

// One node's verify-activation answer: the wallet's node, or its absence as far as this node can vouch
// (`authoritative`: at the network's height); null for anything else, an error answer included.
export type Verdict = { verified: true; nodeId: string; nodeType: NodeType } | { verified: false; authoritative: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseVerifyActivation(body: unknown): Verdict | null {
  if (!isObject(body) || typeof body.verified !== 'boolean') return null;
  if (body.verified) {
    if (typeof body.node_id !== 'string' || !NODE_ID_RE.test(body.node_id)) return null;
    const light = body.node_id.startsWith('light_') || (typeof body.node_type === 'string' && /light/i.test(body.node_type));
    return { verified: true, nodeId: body.node_id, nodeType: light ? 'light' : 'super' };
  }
  if (body.error !== undefined) return null;
  return { verified: false, authoritative: body.authoritative === true };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WalletNodeOptions extends GateOptions {
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  budget?: UpstreamBudget;
  gate?: Gate;
  // The light node's settled status (node-proxy.ts view), read on the budget of `kind`.
  lightView?: (nodeId: string, kind: CheckKind) => Promise<NodeStatusView | null>;
  // The ids seen registered (known-nodes.ts); the process's set by default.
  known?: KnownNodes;
}

export interface WalletNodeCheck {
  // The wallet's node, none, or null when the network could not answer; `reserve` for a reservation's check.
  check(wallet: string, kind?: CheckKind): Promise<WalletNode | null>;
  // GET /api/cabinet/wallet-node/:wallet
  route(request: Request, wallet: string): Promise<Response>;
}

export function createWalletNode(options: WalletNodeOptions = {}): WalletNodeCheck {
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const budget = options.budget ?? unbudgeted;
  const gate = options.gate ?? createGate(options);
  const lightView = options.lightView ?? ((id: string, kind: CheckKind) => nodeProxy().view(id, kind));
  const known = options.known ?? knownNodes();
  const caches: Record<CheckKind, ReturnType<typeof memo<WalletNode | null>>> = {
    read: memo<WalletNode | null>((v) => (v?.state === 'none' ? WALLET_NONE_CACHE_MS : WALLET_NODE_CACHE_MS), options.now ?? Date.now),
    reserve: memo<WalletNode | null>(WALLET_RESERVE_CACHE_MS, options.now ?? Date.now),
  };
  // A page's read of a wallet whose light or super node was seen registered goes on the budget of known ids.
  const upstreamOf = (wallet: string, kind: CheckKind): UpstreamKind => {
    if (kind === 'reserve') return 'reserve';
    return known.has(lightNodeId(wallet)) || known.has(superNodeId(wallet)) ? 'readKnown' : 'readUnknown';
  };

  async function ask(base: string, wallet: string, kind: UpstreamKind): Promise<Verdict | null> {
    const url = `${base}/api/v1/verify-activation`;
    if (!budget(kind, url)) return null;
    try {
      const res = await fetchFn(url, {
        headers: { Accept: 'application/json', 'x-qnet-wallet': wallet },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCappedBytes(res, NODE_BODY_MAX_BYTES);
      return bytes ? parseVerifyActivation(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) : null;
    } catch {
      return null;
    }
  }

  async function load(wallet: string, kind: CheckKind): Promise<WalletNode | null> {
    const order = [...nodes];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let absent = false;
    let size = 2;
    const upstream = upstreamOf(wallet, kind);
    while (order.length > 0 && !absent) {
      const got = await Promise.all(order.splice(0, size).map((base) => ask(base, wallet, upstream)));
      const found = got.find((v): v is Extract<Verdict, { verified: true }> => v?.verified === true);
      if (found) {
        known.note(found.nodeId);
        return { state: 'registered', nodeId: found.nodeId, nodeType: found.nodeType };
      }
      absent = got.some((v) => v?.verified === false && v.authoritative);
      size = 1;
    }
    if (!absent) return null;
    const light = await lightView(lightNodeId(wallet), kind);
    if (light === null) return null;
    if (light.registered || light.pending) return { state: 'registered', nodeId: lightNodeId(wallet), nodeType: 'light' };
    return { state: 'none' };
  }

  const check = (wallet: string, kind: CheckKind = 'read') => caches[kind](wallet, () => load(wallet, kind), (v) => v !== null);

  return {
    check,
    async route(request, wallet) {
      const refused = gate(request, 'walletNode');
      if (refused) return refused;
      if (!isEonAddress(wallet)) return cabinetJson(400, { error: 'invalid_request' });
      // A read that goes upstream counts against the client's own share.
      const limited = caches.read.has(wallet) ? null : gate.spend(request, 'upstreamMiss');
      if (limited) return limited;
      const got = await check(wallet);
      return got ? cabinetJson(200, got) : cabinetJson(503, { error: 'unavailable' });
    },
  };
}

// The process's check, on globalThis so every route bundle shares one cache, behind the cabinet's one gate.
const GLOBAL_KEY = Symbol.for('qnet.cabinetWalletNode');

export function walletNode(): WalletNodeCheck {
  const holder = globalThis as unknown as Record<symbol, WalletNodeCheck | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createWalletNode({ gate: cabinetGate(), budget: sharedUpstreamBudget() });
  holder[GLOBAL_KEY] = created;
  return created;
}

// Where a wallet's activation stands, from every source the page has (unified plan R1, R4 and R6; shared contracts C0 and
// C9): the QNet network (the wallet's node of either type, its light node's status, its super node's status), the
// server's activation record with its search of the wallet's own Solana address, the QNet extension that holds the
// wallet (qnet_getActivation, never a window), the answer the extension gave in this browser before, and this browser's
// payment addresses. Pure: every page of My node shows the one state this gives, and none offers a burn unless it is
// `none`.
//
// Positive evidence wins: a node on the network, then a light registration being recorded, then a known burn (a payment
// address's final burn is the wallet's record like the extension's), then a burn on its way, then this browser's own
// final payment burn, then another browser's reservation. With none of them, anything still loading gives `loading`; the
// extension that holds the chosen wallet locked, or not connected to this site, gives `locked`; any source that did not
// answer gives `unknown`; `none` only when every source said none.

import { activationCode, superNodeId, type ExtensionFailure, type GetActivation, type NodeType } from '../qnet-link.ts';
import type { ActivationRecordView, BurnWay, ScanView } from './burn-record.ts';
import { isUnfinished, receiptCode, receiptOf, type PaymentRecord } from './flow.ts';
import type { KeptActivation } from './kept-activation.ts';
import { isLinkedState, nodeState, superState, type NodeState, type NodeStatusView, type SuperState, type SuperStatusView } from './node-view.ts';
import type { WalletChoice } from './wallet-choice.ts';

export type Read<T> = { phase: 'loading' } | { phase: 'ok'; value: T } | { phase: 'unavailable' };

// The network's answer to "has this wallet a node" (GET /api/cabinet/wallet-node/{wallet}).
export type WalletNodeView = { state: 'registered'; nodeId: string; nodeType: NodeType } | { state: 'none' };

const WALLET_NODE_KEYS = ['state', 'nodeId', 'nodeType'];
const NODE_ID_RE = /^[a-z0-9_]{1,128}$/;

// GET /api/cabinet/wallet-node/:wallet, exactly.
export function parseWalletNode(body: unknown): WalletNodeView | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.state === 'none') return Object.keys(b).length === 1 ? { state: 'none' } : null;
  if (b.state !== 'registered' || Object.keys(b).length !== 3 || !WALLET_NODE_KEYS.every((k) => k in b)) return null;
  if (typeof b.nodeId !== 'string' || !NODE_ID_RE.test(b.nodeId) || (b.nodeType !== 'light' && b.nodeType !== 'super')) return null;
  return { state: 'registered', nodeId: b.nodeId, nodeType: b.nodeType };
}

// The extension, when it holds the chosen wallet: not asked (`na`: the chosen wallet is not the extension's), being
// asked, its answer, or a call that failed (`unsupported`: an extension too old for qnet_getActivation).
export type ExtensionRead =
  | { phase: 'na' }
  | { phase: 'loading' }
  | { phase: 'ok'; value: GetActivation }
  | { phase: 'failed'; failure: ExtensionFailure };

export interface ActivationInputs {
  choice: WalletChoice | null;
  network: Read<WalletNodeView>;
  light: Read<NodeStatusView>;
  superStatus: Read<SuperStatusView>;
  server: Read<ActivationRecordView>;
  // The server's search of the wallet's own Solana address the page holds (no older than SCAN_CACHE_MS), null before
  // one; only when the page knows that address (the extension or QNet Wallet shared it).
  scan: ScanView | null;
  extension: ExtensionRead;
  // The extension's answer this browser kept (kept-activation.ts), and this browser's payment addresses (null: not read).
  kept: KeptActivation | null;
  records: PaymentRecord[] | null;
}

// C9, as the pages show them.
export const VIEW_STATES = ['loading', 'locked', 'unknown', 'none', 'reserved', 'sending', 'burned', 'recording', 'node'] as const;
export type ViewState = (typeof VIEW_STATES)[number];

// The checks `unknown` names: the QNet network, the server's record, the extension, the wallet's Solana history.
export type Check = 'network' | 'server' | 'extension' | 'solana';

// A burn the page knows is the wallet's, and where it knows it from (the code priority of D1 after the network's own
// registration, which Node details read from the archive: the server's record, the extension's answer, the server's
// search, the extension's answer kept in this browser, this browser's payment address).
export interface KnownBurn {
  nodeType: NodeType;
  burnTx: string;
  burnAmount: number;
  code: string | null;
  // null when the source does not say (an answer kept from before).
  way: BurnWay | null;
  burner: string | null;
  source: 'record' | 'extension' | 'scan' | 'kept' | 'browser';
}

export interface ActivationView {
  state: ViewState;
  // unknown: the checks that did not answer.
  missing: Check[];
  // reserved, sending: until when (ms), when known.
  until: number | null;
  // The wallet's light node on the network: pending (being recorded), no_device, device_pending (a device linked that has
  // not answered yet), online, offline; null without one.
  light: NodeState | null;
  // Its super node: online or offline; `registered` while the network lists it and its status is not read yet.
  superNode: SuperState | 'registered' | null;
  // The id the network lists the super node by (super_node_… or a genesis node's), when it lists one.
  superId: string | null;
  // The node types the network lists for the wallet: both only for a wallet registered with both before the network's
  // one-node rule.
  nodes: NodeType[];
  burn: KnownBurn | null;
  // reserved and sending: this browser holds that activation (its Activate page goes on with it).
  here: boolean;
  // The extension that holds the wallet is too old to answer without a window.
  extensionUpdate: boolean;
  // locked: whether the extension is locked, or has not approved this site for its wallet.
  lockedBy: 'locked' | 'not_connected' | null;
  // The wallet burned in a form no code comes from.
  unusable: boolean;
  // The network did not answer whether the wallet has a node: a page waiting for the record says so while it reads again.
  networkDown: boolean;
}

const BLANK: Omit<ActivationView, 'state'> = {
  missing: [], until: null, light: null, superNode: null, superId: null, nodes: [], burn: null, here: false, extensionUpdate: false, lockedBy: null, unusable: false,
  networkDown: false,
};

const isRegistered = (s: NodeState) => s === 'no_device' || isLinkedState(s);

// This browser's payment record whose burn, or whose live reservation, is for `wallet` (a record from before the
// reservations names it by its request).
function browserRecord(records: PaymentRecord[] | null, wallet: string): PaymentRecord | null {
  const mine = (records ?? []).filter((r) => r.stage !== 'closing' && r.stage !== 'otherBurn'
    && (receiptOf(r)?.qnet ?? r.submit?.qnet ?? r.hold?.wallet ?? r.reservation?.wallet ?? r.wallet ?? r.answer?.qnet ?? r.link?.named) === wallet);
  return mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

// The stages of a payment record whose burn is final and may still register the wallet's node: from the burn to the
// registration's outcome.
const HELD_BURN_STAGES: ReadonlySet<PaymentRecord['stage']> = new Set([
  'burnFinal', 'linkOpen', 'consentVerified', 'mismatch', 'consentStale', 'nodeExists', 'beneficiaryConfirmed', 'submitted', 'refused',
]);

// This browser's own final payment burn for the wallet, not registered yet: the wallet's burn even while the server's
// record cannot be read or never had it (a burn from before the record), so this browser never offers a second one
// (R1, R6).
function heldBurn(record: PaymentRecord | null): KnownBurn | null {
  if (!record?.burn || !HELD_BURN_STAGES.has(record.stage)) return null;
  return { nodeType: 'light', burnTx: record.burn.tx, burnAmount: record.burn.amount, code: receiptCode(record), way: 'payment', burner: record.pub, source: 'browser' };
}

// The burn the sources know, by the priority of D1 (the archive's registration aside).
export function knownBurn(inputs: ActivationInputs): { burn: KnownBurn | null; unusable: boolean } {
  const { choice, server, extension, scan, kept, records } = inputs;
  const wallet = choice?.qnet ?? null;
  if (server.phase === 'ok' && server.value.state === 'recorded') {
    const r = server.value;
    return {
      burn: { nodeType: r.nodeType as NodeType, burnTx: r.burnTx as string, burnAmount: r.burnAmount as number, code: r.code, way: r.way, burner: r.burner, source: 'record' },
      unusable: false,
    };
  }
  const ext = extension.phase === 'ok' && extension.value.status !== 'no_wallet' && extension.value.status !== 'locked'
    && extension.value.status !== 'not_connected' && extension.value.qnet === wallet ? extension.value : null;
  if (ext?.status === 'exists') {
    return {
      burn: {
        nodeType: ext.nodeType, burnTx: ext.burnTx, burnAmount: ext.burnAmount, code: ext.code, way: ext.paidOnSite ? 'payment' : 'extension',
        burner: ext.paidOnSite ? null : ext.solana, source: 'extension',
      },
      unusable: false,
    };
  }
  if (ext?.status === 'unusable') return { burn: null, unusable: true };
  const solana = choice?.solana ?? null;
  if (scan && solana && scan.burns.length > 0) {
    const b = scan.burns[0];
    return {
      burn: { nodeType: b.nodeType, burnTx: b.burnTx, burnAmount: b.burnAmount, code: activationCode(b.nodeType, solana, b.burnTx, b.burnAmount), way: 'extension', burner: solana, source: 'scan' },
      unusable: false,
    };
  }
  if (scan && solana && scan.unusable) return { burn: null, unusable: true };
  if (kept && kept.qnet === wallet && kept.status !== 'pending') {
    return { burn: { nodeType: kept.nodeType, burnTx: kept.burnTx, burnAmount: kept.burnAmount, code: kept.code ?? null, way: null, burner: null, source: 'kept' }, unusable: false };
  }
  const record = wallet ? browserRecord(records, wallet) : null;
  if (record?.burn && (record.stage === 'onChain' || record.stage === 'leftovers' || record.stage === 'done')) {
    return {
      burn: { nodeType: 'light', burnTx: record.burn.tx, burnAmount: record.burn.amount, code: receiptCode(record), way: 'payment', burner: record.pub, source: 'browser' },
      unusable: false,
    };
  }
  return { burn: null, unusable: false };
}

export function activationView(inputs: ActivationInputs): ActivationView {
  const { choice, network, light, superStatus, server, scan, extension, records } = inputs;
  if (!choice) return { ...BLANK, state: 'loading' };
  const wallet = choice.qnet;

  // The nodes on the network. A light node the network lists while its status still says "not registered" (one node's
  // listing reaches the page a read or two before two nodes agree on the status) is recorded with no device yet: the
  // page moves on to Link a device at once, never to an empty section.
  const lightState = light.phase === 'ok' ? nodeState(light.value) : null;
  const listed = network.phase === 'ok' && network.value.state === 'registered' ? network.value : null;
  const lightNode = lightState === 'none' && listed?.nodeType === 'light' ? 'no_device'
    : lightState !== null && lightState !== 'none' ? lightState : null;
  const superRead = superStatus.phase === 'ok' ? superStatus.value : null;
  let superNode: ActivationView['superNode'] = superRead?.registered ? (superState(superRead) as SuperState) : null;
  let superId: string | null = superRead?.registered ? superNodeId(wallet) : null;
  if (listed?.nodeType === 'super') {
    superId = listed.nodeId;
    if (superNode === null) superNode = 'registered';
  }
  const { burn, unusable } = knownBurn(inputs);
  const nodes: NodeType[] = [];
  if ((lightNode !== null && isRegistered(lightNode)) || (listed?.nodeType === 'light' && lightNode !== 'pending')) nodes.push('light');
  if (superNode !== null) nodes.push('super');
  const base = { ...BLANK, light: lightNode, superNode, superId, nodes, burn, unusable, networkDown: network.phase === 'unavailable' };

  if (nodes.length > 0) return { ...base, state: 'node' };
  if (lightNode === 'pending') return { ...base, state: 'recording' };
  if (burn || unusable) return { ...base, state: 'burned' };

  const record = browserRecord(records, wallet);
  const holds = (burnTx: string | null) => record !== null && isUnfinished(record) && (burnTx === null || record.burn?.tx === burnTx);
  const extPending = extension.phase === 'ok' && extension.value.status === 'pending' && extension.value.qnet === wallet ? extension.value : null;
  if (server.phase === 'ok' && server.value.state === 'sending') {
    return { ...base, state: 'sending', until: server.value.until, here: holds(server.value.burnTx) };
  }
  if (extPending) return { ...base, state: 'sending' };
  const held = heldBurn(record);
  if (held) return { ...base, burn: held, state: 'burned' };
  if (server.phase === 'ok' && server.value.state === 'reserved') {
    const mine = record !== null && isUnfinished(record) && record.reservation?.until === server.value.until;
    return { ...base, state: 'reserved', until: server.value.until, here: mine };
  }

  // No positive evidence: every source must answer none.
  const extensionUpdate = extension.phase === 'failed' && extension.failure === 'unsupported';
  const missing: Check[] = [];
  let loading = false;
  if (network.phase === 'loading') loading = true;
  else if (network.phase === 'unavailable') missing.push('network');
  if (server.phase === 'loading') loading = true;
  else if (server.phase === 'unavailable') missing.push('server');
  let extensionNone = false;
  let locked: 'locked' | 'not_connected' | null = null;
  if (extension.phase === 'loading') loading = true;
  else if (extension.phase === 'failed') missing.push('extension');
  else if (extension.phase === 'ok') {
    const v = extension.value;
    if (v.status === 'locked' || v.status === 'not_connected') locked = v.status;
    else if (v.status === 'no_wallet' || v.status === 'unknown') missing.push('extension');
    else if (v.qnet !== wallet || v.status === 'searching') loading = true;
    else if (v.status === 'none') extensionNone = true;
  }
  if (choice.solana && !extensionNone) {
    if (scan === null) loading = true;
    else if (!scan.complete) missing.push('solana');
  }
  if (loading) return { ...base, state: 'loading', extensionUpdate };
  if (locked) return { ...base, state: 'locked', lockedBy: locked, extensionUpdate };
  if (missing.length > 0) return { ...base, state: 'unknown', missing, extensionUpdate };
  return { ...base, state: 'none' };
}

// The C9 name of a view, as the tests and the documents name it: burned-light, recorded light running, and so on.
export function c9Name(view: ActivationView): string {
  switch (view.state) {
    case 'burned':
      return view.burn ? `burned-${view.burn.nodeType}` : 'burned';
    case 'node': {
      const names: string[] = [];
      if (view.light === 'online') names.push('light-running');
      else if (view.light === 'no_device') names.push('light-not-linked');
      else if (view.light === 'device_pending') names.push('light-linking');
      else if (view.light === 'offline') names.push('light-offline');
      if (view.superNode === 'online' || view.superNode === 'offline') names.push(`super-${view.superNode}`);
      else if (view.superNode === 'registered') names.push('super');
      return names.join('+') || 'node';
    }
    default:
      return view.state;
  }
}

// The node type the wallet's way goes on with: its node's, else its burn's; null while it has neither.
export function wayOf(view: ActivationView): NodeType | null {
  if (view.nodes.includes('light') || view.light === 'pending') return 'light';
  if (view.nodes.includes('super')) return 'super';
  return view.burn?.nodeType ?? null;
}

// A light node's state as a section shows it from its status read: recorded with no device yet for a node the view has
// that way while the status still says "not registered" (activationView), so the section leads with Link your phone
// instead of showing nothing. `device_pending` counts as linked wherever a section asks (isLinkedState).
export function lightSectionState(status: NodeStatusView, view: ActivationView): NodeState {
  const state = nodeState(status);
  return state === 'none' && view.state === 'node' && view.light === 'no_device' ? 'no_device' : state;
}

// The step the wallet is on, which every page leads with (owner, 30.09: the page moves on by itself and shows the
// steps): `record`, a light node's known burn or registration waiting for the network; `link`, a light node the network
// lists with no device on it; `answer`, a device just linked that has not answered yet; `wake`, a linked device the
// network asks to come back; `running`; `server`, a super node from its burn until the network counts its server online.
// Null before a burn, or while the node's status is not read.
export type NextStep = 'record' | 'link' | 'answer' | 'wake' | 'running' | 'server';

export function nextStep(view: ActivationView): NextStep | null {
  switch (view.state) {
    case 'recording':
      return 'record';
    case 'burned':
      return view.burn ? (view.burn.nodeType === 'super' ? 'server' : 'record') : null;
    case 'node':
      if (view.nodes.includes('light')) {
        if (view.light === 'no_device') return 'link';
        if (view.light === 'device_pending') return 'answer';
        if (view.light === 'offline') return 'wake';
        return view.light === 'online' ? 'running' : null;
      }
      return view.superNode === 'online' ? 'running' : 'server';
    default:
      return null;
  }
}

// How often the page reads the network again while the wallet waits on it, on top of the reads' own half-minute
// round, so it moves on by itself as soon as the network lists the node, its device or its server: every few seconds
// while a light node is being recorded (a record lands within seconds of its submit) or listed before its status is
// read; every ten seconds while a recorded light node waits for its phone or its new device's first answer, a super
// node's burn for its server, or a burn found only on Solana for QNet Wallet's consent to register it. Null once
// nothing is awaited: the watch stops.
export const WATCH_RECORD_MS = 5_000;
export const WATCH_NEXT_MS = 10_000;
// The watch reads that often for at most this long after the step it waits on began or the page was shown again;
// then only the reads' own half-minute round goes on: a page left open on a step does not read every few seconds for
// hours.
export const WATCH_MAX_MS = 600_000;

export function watchInterval(view: ActivationView): number | null {
  const step = nextStep(view);
  if (step === 'record') return view.state === 'burned' && view.burn?.source === 'scan' ? WATCH_NEXT_MS : WATCH_RECORD_MS;
  if (step === 'link' || step === 'answer') return WATCH_NEXT_MS;
  if (step === 'server') return view.state === 'burned' || view.superNode === 'registered' ? WATCH_NEXT_MS : null;
  if (view.state === 'node' && view.nodes.includes('light') && view.light === null) return WATCH_RECORD_MS;
  return null;
}

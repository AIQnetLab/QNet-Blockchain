// The build-time walk (scripts/light-pin.mjs): up to the certified head from the newest checkpoint the store holds, or
// from the pin, every step verified exactly as a request's walk verifies it (lineage.ts), rooted at a GALC v2 capsule
// (galc.ts) when the nodes serve one and the walk from the site's own checkpoints is long; what it reaches, and the
// capsule, go into the store, so the server started after the build resumes at the head. Asked for a new pin, it renders
// the pin block of a checkpoint a few below the head (or at the index asked), walked in that run from the committed pin
// by committee signatures alone (no store, no capsule), with block 0's hash every answering genesis node names, for
// src/server/light/pin.ts.
import jsSha3 from 'js-sha3';
import type { CapsuleRefresh } from './galc.ts';
import type { FetchText, LightClient, Pin } from './lineage.ts';
import type { StoredCheckpoint } from './store.ts';
import { isRecord, parseStrictJson, u64Text } from './strict-json.ts';

const { sha3_256 } = jsSha3;
const HEX32 = /^[0-9a-f]{64}$/;
const MACROBLOCK_MAX_BYTES = 4 * 1024 * 1024;
const HEADERS_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
// A walk cut short by the nodes' read budget waits this long before it goes on.
const TRANSIENT_PAUSE_MS = 15_000;
// Refusals in a row (every node refused a step, or the target is not certified yet) before the walk gives up.
const REFUSALS_MAX = 3;
// Steps per walk: the budget is looked at between walks, so a walk from an old pin is cut into pieces.
const WALK_CHUNK_STEPS = 64;
// Genesis nodes that must name the same MacroBlock::hash of a new pin, every node that answers agreeing.
export const PIN_HASH_ANSWERS = 3;
export const PIN_MARGIN = 4;

export interface WalkOptions {
  light: LightClient;
  budgetMs: number;
  /** Macroblocks below the certified head the walk stops at (0: the head and the one below). */
  margin?: number;
  /** The macroblock the walk stops at in place of `margin` (a new pin at the index the wallets pinned); none above the head. */
  index?: number;
  /** False: no capsule is asked for first (a new pin's walk). */
  capsule?: boolean;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}

export interface WalkResult {
  outcome: 'reached' | 'no_head' | 'above_head' | 'budget' | 'refused';
  head: number | null;
  targets: number[];
  highestBefore: number;
  highest: number;
  /** The capsule refresh before the walk (lineage.ts refreshCapsule); null when none was asked for. */
  capsule: CapsuleRefresh | null;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Walks both parity chains to `head - margin` (or `index`) and the one below, from the capsule when one roots them, then writes the store. */
export async function walkToHead(o: WalkOptions): Promise<WalkResult> {
  const now = o.now ?? Date.now;
  const pause = o.pause ?? wait;
  const { light } = o;
  await light.ready();
  const highestBefore = light.highestVerifiedIndex();
  const head = await light.certifiedHead();
  if (head === null) return { outcome: 'no_head', head, targets: [], highestBefore, highest: highestBefore, capsule: null };
  const k = o.index ?? head - (o.margin ?? 0);
  if (k > head) return { outcome: 'above_head', head, targets: [], highestBefore, highest: highestBefore, capsule: null };
  const capsule = o.capsule === false ? null : await light.refreshCapsule();
  const targets = [k, k - 1].filter((t) => t >= light.trustFloorIndex());
  const deadline = now() + o.budgetMs;
  const reach = async (t: number): Promise<WalkResult['outcome']> => {
    let refusals = 0;
    while (!light.verifiedCheckpoint(t)) {
      if (now() >= deadline) return 'budget';
      const outcome = await light.walk(Math.min(t, light.highestVerifiedIndex(t % 2) + 2 * WALK_CHUNK_STEPS));
      if (outcome === 'verified') { refusals = 0; continue; }
      if (outcome !== 'transient') refusals += 1;
      if (refusals >= REFUSALS_MAX) return 'refused';
      await pause(Math.max(0, Math.min(TRANSIENT_PAUSE_MS, deadline - now())));
    }
    return 'reached';
  };
  const outcomes = await Promise.all(targets.map(reach));
  await light.flush();
  const outcome = outcomes.find((x) => x !== 'reached') ?? 'reached';
  return { outcome, head, targets, highestBefore, highest: light.highestVerifiedIndex(), capsule };
}

/** MacroBlock::hash: SHA3-256(height ‖ timestamp ‖ previous_hash ‖ state_root ‖ micro_blocks), u64 little-endian. */
export function macroblockHash(mb: unknown): string | null {
  if (!isRecord(mb) || !Array.isArray(mb.micro_blocks)) return null;
  const height = u64Text(mb.height);
  const timestamp = u64Text(mb.timestamp);
  const hashes = [mb.previous_hash, mb.state_root, ...mb.micro_blocks];
  if (height === null || timestamp === null || !hashes.every((h) => typeof h === 'string' && HEX32.test(h))) return null;
  const u64 = (v: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  return sha3_256(Buffer.concat([u64(height), u64(timestamp), ...hashes.map((h) => Buffer.from(h as string, 'hex'))]));
}

/**
 * The MacroBlock::hash of `k` every answering node names, at least PIN_HASH_ANSWERS of them; else why not. With
 * `stateRoot` (the certified root the walk verified for k) a header carrying another root is no answer for k.
 */
export async function agreedMacroblockHash(k: number, nodes: readonly string[], fetchText: FetchText, stateRoot?: string): Promise<{ hash: string } | { error: string }> {
  const answers = await Promise.all(nodes.map(async (base) => {
    try {
      const got = await fetchText(`${base}/api/v1/macroblock/${k}`, MACROBLOCK_MAX_BYTES, FETCH_TIMEOUT_MS);
      if (got.status !== 200 || got.text === null) return null;
      const body = parseStrictJson(got.text);
      if (!isRecord(body) || body.index !== k) return 'malformed';
      if (stateRoot !== undefined && body.state_root !== stateRoot) return 'malformed';
      return macroblockHash(body) ?? 'malformed';
    } catch {
      return null;
    }
  }));
  const named = answers.filter((a): a is string => a !== null);
  if (named.length < PIN_HASH_ANSWERS) return { error: `${named.length} nodes answered for macroblock ${k}, ${PIN_HASH_ANSWERS} needed` };
  if (new Set(named).size !== 1 || named[0] === 'malformed') return { error: `the nodes disagree on macroblock ${k}` };
  return { hash: named[0] };
}

/** Block 0's hash from a /api/v1/blocks/headers?from=0&limit=1 answer, or null. */
export function networkIdOf(body: unknown): string | null {
  const item = isRecord(body) && Array.isArray(body.items) ? body.items[0] : null;
  return isRecord(item) && item.height === 0 && typeof item.hash === 'string' && HEX32.test(item.hash) ? item.hash : null;
}

/**
 * Block 0's hash (NETWORK_ID) every answering node names (GET /api/v1/blocks/headers?from=0&limit=1, never /block/0, tens
 * of MB), at least PIN_HASH_ANSWERS of them; else why not.
 */
export async function agreedNetworkId(nodes: readonly string[], fetchText: FetchText): Promise<{ networkId: string } | { error: string }> {
  const answers = await Promise.all(nodes.map(async (base) => {
    try {
      const got = await fetchText(`${base}/api/v1/blocks/headers?from=0&limit=1`, HEADERS_MAX_BYTES, FETCH_TIMEOUT_MS);
      if (got.status !== 200 || got.text === null) return null;
      return networkIdOf(parseStrictJson(got.text)) ?? 'malformed';
    } catch {
      return null;
    }
  }));
  const named = answers.filter((a): a is string => a !== null);
  if (named.length < PIN_HASH_ANSWERS) return { error: `${named.length} nodes answered for block 0, ${PIN_HASH_ANSWERS} needed` };
  if (new Set(named).size !== 1 || named[0] === 'malformed') return { error: 'the nodes disagree on block 0' };
  return { networkId: named[0] };
}

/**
 * The <ws-pin> block of pin.ts (the wallets' format), K's and K-1's anchors from checkpoints the walk verified, block 0's
 * hash and the capsule cadence.
 */
export function renderPinBlock(k: StoredCheckpoint, below: StoredCheckpoint, hash: string, provenFrom: { index: number; hash: string }, note: string,
  networkId: string, galcInterval: number): string {
  const entry = (c: StoredCheckpoint) => [
    `    ${c.index}: {`,
    `      eligible_raw: '${c.eligibleRaw}',`,
    `      beacon: '${c.beacon}',`,
    `      registry_root: '${c.registryRoot}',`,
    '    },',
  ].join('\n');
  return [
    '// <ws-pin>',
    `// ${note}`,
    'export const WS_CHECKPOINT = {',
    `  index: ${k.index},`,
    `  hash: '${hash}',`,
    `  provenFrom: { index: ${provenFrom.index}, hash: '${provenFrom.hash}' },`,
    '  anchors: {',
    entry(k),
    entry(below),
    '  },',
    '};',
    "// Block 0's hash, served alike by every answering genesis node: the network_id a GALC v2 capsule must name.",
    `export const NETWORK_ID = '${networkId}';`,
    "// Macroblocks between two genesis-signed capsules: the node's GALC_V2_MINT_INTERVAL.",
    `export const GALC_V2_MINT_INTERVAL = ${galcInterval};`,
    '// </ws-pin>',
  ].join('\n');
}

const PIN_BLOCK = /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/;

/** `source` with its <ws-pin> block replaced, or null when it has none. */
export function replacePinBlock(source: string, block: string): string | null {
  return PIN_BLOCK.test(source) ? source.replace(PIN_BLOCK, () => block) : null;
}

export interface NewPinOptions extends WalkOptions {
  nodes: readonly string[];
  fetchText: FetchText;
  /** The committed pin the new one is proven from. */
  pin: Pin & { hash: string };
  /** The committed NETWORK_ID: nodes naming another block 0 serve another chain. */
  networkId: string;
  /** GALC_V2_MINT_INTERVAL for the new block. */
  galcInterval: number;
  date?: string;
}

/**
 * A new pin `margin` macroblocks below the certified head (or at `index`), both of its anchors verified in this run by
 * the walk from the committed pin, and its hash named alike by the nodes for a header carrying the root the walk
 * verified; block 0's hash the nodes name must be the committed NETWORK_ID.
 */
export async function proveNewPin(o: NewPinOptions): Promise<{ block: string; index: number; walk: WalkResult } | { error: string; walk?: WalkResult }> {
  await o.light.ready();
  if (o.light.trustFloorIndex() !== o.pin.index + 1) return { error: `the light client is not rooted at the committed pin ${o.pin.index}` };
  // A committed pin rests on the pin before it alone: checkpoints read from a store, or a capsule's roots, would make
  // it rest on a local file or on the genesis keys instead of on committee signatures.
  if (o.light.heldCapsuleIndex() > 0) return { error: 'the light client holds a capsule: a new pin is walked from the committed pin by committee signatures alone' };
  if (o.light.highestVerifiedIndex() > o.pin.index) return { error: 'the light client holds checkpoints it did not verify in this run (a store): a new pin is walked from the committed pin' };
  if (!Number.isSafeInteger(o.galcInterval) || o.galcInterval < 1) return { error: 'the capsule cadence must be a whole number above 0' };
  if (o.index !== undefined && !Number.isSafeInteger(o.index)) return { error: 'the index must be a whole number' };
  // A pin whose anchors reach down to the committed one adds nothing: an index asked is refused before any node is read.
  const asRecent = `the committed pin ${o.pin.index} is as recent`;
  if (o.index !== undefined && o.index <= o.pin.index + 1) return { error: asRecent };
  const network = await agreedNetworkId(o.nodes, o.fetchText);
  if ('error' in network) return { error: network.error };
  if (network.networkId !== o.networkId) return { error: `the nodes serve block 0 ${network.networkId}, the committed NETWORK_ID is ${o.networkId}: another chain` };
  const walk = await walkToHead({ ...o, margin: o.margin ?? PIN_MARGIN, capsule: false });
  if (walk.outcome === 'above_head') return { error: `macroblock ${o.index} is above the certified head ${walk.head}`, walk };
  if (walk.outcome !== 'reached' || walk.targets.length !== 2) return { error: `walk ${walk.outcome}`, walk };
  const [k, below] = walk.targets.map((t) => o.light.verifiedCheckpoint(t));
  if (!k || !below || k.index !== below.index + 1) return { error: 'the anchors are not verified', walk };
  if (k.index <= o.pin.index + 1) return { error: asRecent, walk };
  const agreed = await agreedMacroblockHash(k.index, o.nodes, o.fetchText, k.stateRoot);
  if ('error' in agreed) return { error: agreed.error, walk };
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const note = `Generated by applications/qnet-explorer/frontend/scripts/light-pin.mjs on ${date} from ${o.nodes.length} genesis nodes `
    + `(certified head ${walk.head}; every macroblock QC-verified from the previous pin ${o.pin.index}).`;
  return { block: renderPinBlock(k, below, agreed.hash, { index: o.pin.index, hash: o.pin.hash }, note, network.networkId, o.galcInterval), index: k.index, walk };
}

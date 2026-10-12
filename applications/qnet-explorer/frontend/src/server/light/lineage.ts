// The site's light client: a macroblock's state root counts only once the macroblock's checkpoint is certified by a
// quorum of its committee's ML-DSA-65 signatures, the committee and its keys derived from the macroblock two below,
// walked up from the pin (pin.ts). The rules are the wallets' (applications/qnet-mobile/src/crypto/QcLightClient.js):
// committee drawn from the verified eligible set and beacon of j-2, keys bound to the registry root of j-2, the strict
// quorum, the epoch commitment that carries j's own eligible set forward. A node can withhold, delay or fail a step;
// it cannot make a root count that the committee did not sign. Server state: verified checkpoints in memory (the
// newest kept) and in the checkpoint store (store.ts), so a restart resumes where the walk was; one walk per parity
// chain at a time, shared by every request, running on after a request answers, and kept at the certified head by
// follow() while nobody asks. A GALC v2 capsule (galc.ts), signed by four of the five genesis keys and rooted at proofs
// of K and K-1 from two nodes, roots a walk from the site's own checkpoints is longer than OWN_ROOT_WALK_STEPS; it is
// held apart from them, kept in the store, refused when it names another checkpoint than one verified here, and with no
// capsule (nodes of today answer 405) every walk is what it was without.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import jsSha3 from 'js-sha3';
import {
  MACROBLOCK_INTERVAL, checkpointHash, checkpointQuorum, decodeEligibleNodeIds, epochCommitment, parseDilithiumSig,
  proofShapeProblem, recomputeRegistryRootYielding, registryEntryProblem, sampleCommittee,
  type MacroblockProof, type RegistryEntry,
} from './checkpoint.ts';
import {
  CAPSULE_MAX_BYTES, CAPSULE_MISS_TTL_MS, CAPSULE_PATH, CAPSULE_RECORD_MAX_BYTES, CAPSULE_ROOT_NODES, OWN_ROOT_WALK_STEPS, capsuleEtag,
  capsuleProblem, capsuleRootOf, capsuleSigned, capsuleWire, rootPartsOf,
  type Capsule, type CapsuleEntry, type CapsuleRecord, type CapsuleRefresh, type CapsuleRefreshReason, type CapsuleRootParts, type CapsuleRules,
} from './galc.ts';
import { GENESIS_CONSENSUS_PKS } from './genesis-keys.ts';
import { GALC_V2_MINT_INTERVAL, NETWORK_ID, WS_CHECKPOINT, type PinAnchor } from './pin.ts';
import type { CheckpointStore, PinRef, StoredCheckpoint, StoredLineage } from './store.ts';
import { isRecord, parseStrictJson } from './strict-json.ts';

const { sha3_256 } = jsSha3;

export const PROOF_MAX_BYTES = 8 * 1024 * 1024;
export const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
export const REGISTRY_MAX_ENTRIES = 100_000;
const STATE_CERTIFIED_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
// Verified checkpoints kept; never the highest of either parity chain, from which later walks start.
export const VERIFIED_CACHE_MAX = 64;
// A node that failed a step is not asked for that step again for this long.
const FAIL_TTL_MS = 60_000;
// Light reads per node a minute: a node admits 300 read-only calls a minute from one address.
export const NODE_READS_PER_MINUTE = 180;
const READ_WINDOW_MS = 60_000;
const STEP_WAIT_MAX_MS = 2000;
export const WALK_PREFETCH = 4;
// Nodes that must answer "not found" for the target before it counts as not certified yet.
const NOT_FOUND_ANSWERS = 3;
const HEAD_TTL_MS = 60_000;
const HEAD_RETRY_MS = 10_000;
// Answers a head hint needs, the second highest of them taken: of two, one node could lower it and let an old
// macroblock pass as recent.
const CERTIFIED_HEAD_ANSWERS = 3;
const LEGACY_HEAD_ANSWERS = 3;
const REGISTRY_CACHE_ROOTS = 4;
const PK_SHA_CACHE_MAX = 2048;
const SIG_HEX = 3309 * 2;
const PK_HEX = 1952 * 2;
const HEX32 = /^[0-9a-f]{64}$/;
// Stored checkpoints per parity chain: the top of each is where a restarted walk starts, the rest answer recent indexes.
export const PERSIST_PER_PARITY = 8;
// Verified steps are written at most this often: a long walk verifies hundreds a minute.
const SAVE_DELAY_MS = 5000;
// How often follow() looks at the certified head.
export const FOLLOW_INTERVAL_MS = 30_000;
const STORED_ELIGIBLE_MAX_HEX = 8 * 1024 * 1024;
// Refusals that tie a step to the anchor below it (its committee's signatures, its keys, its registry): distinct nodes
// refusing the first step above a capsule root so drop the capsule.
const LINEAGE_REASONS = new Set(['qc_invalid', 'pubkeys_unresolved', 'epoch_commitment_mismatch']);
export const LINEAGE_REFUSALS = 2;

export interface Fetched { status: number; text: string | null; retryAfterS: number | null }
/**
 * A bounded GET: the status and the body text (null past `maxBytes`), with `headers` sent along (If-None-Match for the
 * capsule). Throws on a transport failure or a timeout.
 */
export type FetchText = (url: string, maxBytes: number, timeoutMs: number, headers?: Readonly<Record<string, string>>) => Promise<Fetched>;

/** `hash` is MacroBlock::hash of K; `provenFrom` the pin K was proven from, whose stored checkpoints still count. */
export interface Pin {
  index: number;
  anchors: Record<string, PinAnchor | undefined>;
  hash?: string;
  provenFrom?: { index: number; hash: string } | null;
}

export interface LightOptions {
  /** The nodes proofs, registry snapshots, heads and capsules are read from, in order. */
  nodes: () => readonly string[];
  fetchText: FetchText;
  verifySignature?: (message: string, sigHex: string, pkHex: string) => boolean;
  now?: () => number;
  pin?: Pin;
  readsPerMinute?: number;
  prefetch?: number;
  /** Where verified checkpoints and the capsule are kept across restarts; without one they live in memory only. */
  store?: CheckpointStore;
  /** False: no capsule is asked for, read from the store or held (a new pin rests on committee signatures alone). */
  capsules?: boolean;
  /** What a capsule is checked against: genesis-keys.ts and pin.ts unless given (tests). */
  genesisKeys?: Readonly<Record<string, string>>;
  networkId?: string;
  capsuleInterval?: number;
}

export type RootAnswer = { root: string } | { pending: true } | { unprovable: 'no_pin' | 'below_floor' | 'not_certified' | 'unavailable' };
export type IndexAnswer = { index: number } | { pending: true } | { none: true };
export type Outcome = 'verified' | 'failed' | 'transient' | 'not_certified';

export interface LightClient {
  /** The committee-certified state root of macroblock `j`, waiting at most `waitMs` for the walk to reach it. */
  certifiedRootAt(j: number, waitMs: number): Promise<RootAnswer>;
  /** The index of the certified checkpoint (idx, idx-1 or idx-2 for idx = floor(height/90)) whose root is `stateRoot`. */
  certifiedIndexOfRoot(stateRoot: string, blockHeight: number, waitMs: number): Promise<IndexAnswer>;
  /** max(highest verified index, the certified head the nodes report), or null when no head could be read. */
  certifiedHead(): Promise<number | null>;
  /** The highest verified index or capsule root (of one parity chain when `parity` is given), the pin's anchor when there is none. */
  highestVerifiedIndex(parity?: number): number;
  trustFloorIndex(): number;
  /** Resolves once the stored checkpoints and capsule are read (at once without a store). */
  ready(): Promise<void>;
  /** Walks idx's parity chain up to idx, every step verified; joins a walk already going there. */
  walk(idx: number): Promise<Outcome>;
  /** Keeps both parity chains at the certified head, every `intervalMs`, the capsule refreshed first; returns the function that stops it. */
  follow(intervalMs?: number): () => void;
  /** Writes the verified checkpoints and the capsule to the store now. */
  flush(): Promise<void>;
  /** A checkpoint this client verified (or read from its store), or a root of the held capsule, with the anchors a pin needs. */
  verifiedCheckpoint(j: number): StoredCheckpoint | null;
  /**
   * Asks CAPSULE_ROOT_NODES nodes at once for their capsule (If-None-Match: the one held), takes the highest that passes
   * the cheap checks and four genesis signatures, roots it at proofs of K and K-1 from two nodes each, and holds it. No
   * request while no newer capsule can exist or the walk from the site's own checkpoints is short (`force` asks anyway);
   * a node answering 404, 405 or an unusable capsule is not asked again for CAPSULE_MISS_TTL_MS. One at a time.
   */
  refreshCapsule(opts?: { force?: boolean }): Promise<CapsuleRefresh>;
  /** K of the held capsule, or 0. */
  heldCapsuleIndex(): number;
}

interface Anchor { eligibleIds: string[]; beacon: string; registryRoot: string }
interface Entry extends Anchor { stateRoot: string; eligibleRaw: string; checkpointHash?: string }
type Got = { body: unknown } | { limited: true } | { error: string };
type CapsuleGot = { body: unknown } | { limited: true } | { unchanged: true } | { refused: string } | { miss: number };
interface Held { index: number; cpA: string; record: CapsuleRecord; entries: Map<number, Entry> }

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const yieldNow = () => new Promise<void>((resolve) => { setImmediate(resolve); });
// `p`, or `fallback` after `ms`, whichever comes first; the timer does not outlive the race.
function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function defaultVerify(message: string, sigHex: string, pkHex: string): boolean {
  if (sigHex.length !== SIG_HEX || pkHex.length !== PK_HEX || !/^[0-9a-fA-F]*$/.test(sigHex + pkHex)) return false;
  try {
    return ml_dsa65.verify(Buffer.from(sigHex, 'hex'), new TextEncoder().encode(message), Buffer.from(pkHex, 'hex'));
  } catch {
    return false;
  }
}

/** A node's rate-limit answer: HTTP 200 with {"error": "Rate limit exceeded", ...}. */
const isRateLimitBody = (body: unknown): boolean => isRecord(body) && typeof body.error === 'string' && /^rate limit exceeded/i.test(body.error);

function pinIsWellformed(pin: Pin): boolean {
  if (!Number.isSafeInteger(pin.index) || pin.index < 2) return false;
  return [pin.index, pin.index - 1].every((i) => {
    const a = pin.anchors[String(i)];
    return !!a && typeof a.eligible_raw === 'string' && HEX32.test(a.beacon) && HEX32.test(a.registry_root)
      && decodeEligibleNodeIds(Buffer.from(a.eligible_raw, 'hex')).length > 0;
  });
}

/** The pin's identity in the store: MacroBlock::hash when the pin carries it, else the digest of its anchors. */
export function pinIdentity(pin: Pin): PinRef {
  if (typeof pin.hash === 'string' && HEX32.test(pin.hash)) return { index: pin.index, id: pin.hash };
  const a = (i: number) => {
    const x = pin.anchors[String(i)];
    return x ? [x.eligible_raw, x.beacon, x.registry_root] : null;
  };
  return { index: pin.index, id: sha3_256(JSON.stringify([pin.index, a(pin.index), a(pin.index - 1)])) };
}

/** The highest `perParity` indexes of each parity chain, highest first. */
export function topPerParity(indexes: Iterable<number>, perParity: number): number[] {
  const kept = [0, 0];
  return [...new Set(indexes)].sort((a, b) => b - a).filter((j) => kept[j % 2]++ < perParity);
}

const stepsFrom = (root: number, idx: number) => (root < 0 ? Infinity : (idx - root) / 2);

export function createLightClient(opts: LightOptions): LightClient {
  const now = opts.now ?? Date.now;
  const verifySignature = opts.verifySignature ?? defaultVerify;
  const pin: Pin = opts.pin ?? { index: WS_CHECKPOINT.index, anchors: WS_CHECKPOINT.anchors as Record<string, PinAnchor | undefined>,
    hash: WS_CHECKPOINT.hash, provenFrom: WS_CHECKPOINT.provenFrom };
  const pinOk = pinIsWellformed(pin);
  const pinRef = pinIdentity(pin);
  const store = opts.store ?? null;
  const readsPerMinute = opts.readsPerMinute ?? NODE_READS_PER_MINUTE;
  const depth = opts.prefetch ?? WALK_PREFETCH;
  const rules: CapsuleRules = {
    networkId: opts.networkId ?? NETWORK_ID, interval: opts.capsuleInterval ?? GALC_V2_MINT_INTERVAL, pinIndex: pin.index,
    keys: opts.genesisKeys ?? GENESIS_CONSENSUS_PKS,
  };
  const capsulesOn = opts.capsules !== false && pinOk && HEX32.test(rules.networkId) && Number.isSafeInteger(rules.interval) && rules.interval >= 1;
  const verified = new Map<number, Entry>();
  const failed = new Map<string, number>();
  const walks = new Map<number, { target: number; promise: Promise<Outcome> }>();
  const registryByRoot = new Map<string, Map<string, string>>();
  const pkShaCache = new Map<string, { pkHex: string; sha: string }>();
  const reads = new Map<string, number[]>();
  const backoff = new Map<string, number>();
  let head: { value: number | null; at: number } | null = null;
  let headRead: Promise<number | null> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let dirty = false;
  // The held capsule: not in the verified cache (not evicted, not stored as checkpoints); replaced only by a higher K.
  let held: Held | null = null;
  // A capsule dropped for a conflict: not taken again within CAPSULE_MISS_TTL_MS.
  let refused: { index: number; cpA: string; at: number } | null = null;
  const capsuleMiss = new Map<string, number>();
  let refreshing: Promise<CapsuleRefresh> | null = null;

  const nodeList = () => [...new Set(opts.nodes().filter((u) => typeof u === 'string' && u.length > 0))];

  function remember(j: number, entry: Entry) {
    verified.delete(j);
    verified.set(j, entry);
    if (verified.size <= VERIFIED_CACHE_MAX) return;
    const top = [-1, -1];
    for (const k of verified.keys()) if (k > top[k % 2]) top[k % 2] = k;
    for (const k of verified.keys()) {
      if (verified.size <= VERIFIED_CACHE_MAX) break;
      if (k !== j && k !== top[0] && k !== top[1]) verified.delete(k);
    }
  }

  // A root of the held capsule (K or K-1), or undefined.
  const capsuleEntry = (j: number): Entry | undefined => (held && (j === held.index || j === held.index - 1) ? held.entries.get(j) : undefined);

  // A macroblock whose certified roots the site holds: verified by a walk (or read from the store), or a capsule root.
  const certifiedEntry = (j: number): Entry | undefined => verified.get(j) ?? capsuleEntry(j);

  function anchorFor(j: number): Anchor | null {
    const v = certifiedEntry(j);
    if (v) return v;
    const a = pinOk ? pin.anchors[String(j)] : undefined;
    if (!a || (j !== pin.index && j !== pin.index - 1)) return null;
    return { eligibleIds: decodeEligibleNodeIds(Buffer.from(a.eligible_raw, 'hex')), beacon: a.beacon, registryRoot: a.registry_root };
  }

  // Two entries of one macroblock name different checkpoints: by their checkpoint hashes when both carry one, else by
  // their state roots (a checkpoint stored before the hashes were kept).
  const differ = (a: Entry, b: Entry) => (a.checkpointHash !== undefined && b.checkpointHash !== undefined
    ? a.checkpointHash !== b.checkpointHash : a.stateRoot !== b.stateRoot);

  function dropCapsule() {
    if (!held) return;
    refused = { index: held.index, cpA: held.cpA, at: now() };
    held = null;
    scheduleSave();
  }

  // Macroblock j verified here as `e` while the held capsule names another checkpoint for it: the capsule is of another
  // lineage than what the site verified and goes; the verified data stays.
  function capsuleConflicts(j: number, e: Entry) {
    const c = capsuleEntry(j);
    if (!c || !differ(c, e)) return;
    console.error(`[ERR][GALC] capsule_conflict j=${j}`);
    dropCapsule();
  }

  // A stored lineage counts when it was walked from this pin or from the pin this one was proven from (the walk from
  // the older pin passed through this one's lineage); one from any other pin (another chain, a pin not proven from it)
  // is not read.
  function rootAccepted(r: PinRef): boolean {
    if (r.index === pinRef.index && r.id === pinRef.id) return true;
    const from = pin.provenFrom;
    return !!from && r.index === from.index && r.id === from.hash;
  }

  // A stored checkpoint as an entry, every field checked again: above the pin, well-formed roots, an eligible set that
  // decodes. Anything else is dropped.
  function storedEntry(c: StoredCheckpoint): Entry | null {
    if (!Number.isSafeInteger(c.index) || c.index <= pin.index) return null;
    if (![c.stateRoot, c.beacon, c.registryRoot].every((h) => HEX32.test(h))) return null;
    if (c.checkpointHash !== undefined && !HEX32.test(c.checkpointHash)) return null;
    if (c.eligibleRaw.length > STORED_ELIGIBLE_MAX_HEX || !/^(?:[0-9a-f]{2})+$/.test(c.eligibleRaw)) return null;
    const eligibleIds = decodeEligibleNodeIds(Buffer.from(c.eligibleRaw, 'hex'));
    if (eligibleIds.length === 0) return null;
    const entry: Entry = { stateRoot: c.stateRoot, eligibleIds, beacon: c.beacon, registryRoot: c.registryRoot, eligibleRaw: c.eligibleRaw };
    if (c.checkpointHash !== undefined) entry.checkpointHash = c.checkpointHash;
    return entry;
  }

  function storedEntries(lineage: StoredLineage | null): Map<number, Entry> {
    const out = new Map<number, Entry>();
    if (!lineage) return out;
    if (!rootAccepted(lineage.pin)) {
      console.warn(`[WARN][LIGHT] store_other_pin stored=${lineage.pin.index} pin=${pin.index}`);
      return out;
    }
    for (const c of lineage.checkpoints) {
      const e = storedEntry(c);
      if (e) out.set(c.index, e);
    }
    return out;
  }

  // The stored capsule record of a lineage this pin accepts, or null.
  const storedCapsule = (lineage: StoredLineage | null): CapsuleRecord | null =>
    (capsulesOn && lineage?.capsule && rootAccepted(lineage.pin) ? lineage.capsule : null);
  const recordIndex = (r: CapsuleRecord): number => (isRecord(r.capsule) && Number.isSafeInteger(r.capsule.mb_index) ? r.capsule.mb_index : 0);

  const loaded: Promise<void> = !store || !pinOk ? Promise.resolve() : store.load().then(async (lineage) => {
    const got = storedEntries(lineage);
    for (const [j, e] of [...got].sort((x, y) => x[0] - y[0])) remember(j, e);
    if (got.size > 0) console.log(`[INFO][LIGHT] store_loaded store=${store.name} checkpoints=${got.size} highest=${Math.max(...got.keys())}`);
    const record = storedCapsule(lineage);
    if (record) {
      const r = await importCapsule(record, false);
      if (!r.ok) console.warn(`[WARN][GALC] store_capsule_refused reason=${r.reason}`);
    }
  }).catch((e) => {
    console.warn(`[WARN][LIGHT] store_load_failed store=${store.name} err=${e instanceof Error ? e.message : String(e)}`);
  });

  // Merged with what the store holds now (the build-time walk, or a second process, may have gone further): their
  // checkpoints are taken in, unless one contradicts a checkpoint verified here, which keeps the store's out; a capsule
  // it holds above the one held here is taken in once verified again.
  async function persist(): Promise<void> {
    if (!store) return;
    dirty = false;
    const lineage = await store.load().catch(() => null);
    const stored = storedEntries(lineage);
    const conflict = [...stored].find(([j, e]) => verified.has(j) && differ(verified.get(j) as Entry, e));
    if (conflict) console.error(`[ERR][LIGHT] store_conflict j=${conflict[0]}: the stored checkpoints are replaced`);
    const merged = new Map<number, Entry>(conflict ? [] : stored);
    for (const [j, e] of merged) {
      if (verified.has(j)) continue;
      remember(j, e);
      capsuleConflicts(j, e);
    }
    for (const [j, e] of verified) merged.set(j, e);
    const record = conflict ? null : storedCapsule(lineage);
    if (record && recordIndex(record) > (held?.index ?? 0)) await importCapsule(record, false);
    const keep = topPerParity(merged.keys(), PERSIST_PER_PARITY);
    await store.save({
      pin: pinRef,
      checkpoints: keep.map((j) => {
        const e = merged.get(j) as Entry;
        const c: StoredCheckpoint = { index: j, stateRoot: e.stateRoot, eligibleRaw: e.eligibleRaw, beacon: e.beacon, registryRoot: e.registryRoot };
        if (e.checkpointHash !== undefined) c.checkpointHash = e.checkpointHash;
        return c;
      }),
      ...(held ? { capsule: held.record } : {}),
    });
  }

  function flush(): Promise<void> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saving = saving.then(() => loaded).then(() => (dirty ? persist() : undefined)).catch((e) => {
      console.warn(`[WARN][LIGHT] store_save_failed err=${e instanceof Error ? e.message : String(e)}`);
    });
    return saving;
  }

  function scheduleSave() {
    if (!store) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }

  const highestVerifiedIndex = (parity?: number) => {
    const of = (j: number) => parity === undefined || j % 2 === parity;
    let best = pinOk ? (of(pin.index) ? pin.index : pin.index - 1) : 0;
    for (const j of verified.keys()) if (j > best && of(j)) best = j;
    if (held) for (const j of [held.index, held.index - 1]) if (j > best && of(j)) best = j;
    return best;
  };
  const trustFloorIndex = () => (pinOk ? pin.index + 1 : Number.MAX_SAFE_INTEGER);

  // The highest index below `idx` on idx's parity chain the site's own data roots a walk at (a checkpoint it verified,
  // or the pin's K or K-1), or -1.
  function ownRoot(idx: number): number {
    let root = -1;
    const candidates = pinOk ? [...verified.keys(), pin.index, pin.index - 1] : [...verified.keys()];
    for (const j of candidates) if (j < idx && j > root && (idx - j) % 2 === 0 && (verified.has(j) || anchorFor(j))) root = j;
    return root;
  }

  // The root of the held capsule below `idx` on idx's parity chain (K or K-1), or -1.
  function capsuleRoot(idx: number): number {
    if (!held) return -1;
    for (const j of [held.index, held.index - 1]) if (j < idx && (idx - j) % 2 === 0) return j;
    return -1;
  }

  const failKey = (j: number, base: string) => `${j}|${base}`;
  const noteFailure = (j: number, base: string) => {
    const t = now();
    if (failed.size >= 4096) for (const [k, at] of failed) if (t - at >= FAIL_TTL_MS) failed.delete(k);
    failed.set(failKey(j, base), t);
  };
  const recentFailure = (j: number, base: string) => {
    const at = failed.get(failKey(j, base));
    if (at === undefined) return false;
    if (now() - at >= FAIL_TTL_MS) { failed.delete(failKey(j, base)); return false; }
    return true;
  };

  function readWait(base: string, t = now()): number {
    const until = backoff.get(base) ?? 0;
    if (until && until <= t) backoff.delete(base);
    const list = (reads.get(base) ?? []).filter((x) => t - x < READ_WINDOW_MS);
    reads.set(base, list);
    const budget = list.length < readsPerMinute ? 0 : list[list.length - readsPerMinute] + READ_WINDOW_MS - t;
    return Math.max(0, until - t, budget);
  }

  const limitFor = (base: string, retryAfterS: number | null) => {
    backoff.set(base, now() + Math.min(60_000, Math.max(1000, (retryAfterS ?? 1) * 1000)));
  };

  // One GET counted against the node's budget: the answer, or the failure of the transport.
  async function fetchCounted(base: string, path: string, maxBytes: number, headers?: Readonly<Record<string, string>>): Promise<Fetched | { error: string }> {
    const t = now();
    const list = (reads.get(base) ?? []).filter((x) => t - x < READ_WINDOW_MS);
    list.push(t);
    reads.set(base, list);
    try {
      return await opts.fetchText(base + path, maxBytes, FETCH_TIMEOUT_MS, headers);
    } catch (e) {
      return { error: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' };
    }
  }

  // One GET read strictly. A rate-limit answer leaves the node alone for the time it asks.
  async function nodeGet(base: string, path: string, maxBytes: number): Promise<Got> {
    const got = await fetchCounted(base, path, maxBytes);
    if ('error' in got) return got;
    if (got.status === 429 || got.status === 503) {
      limitFor(base, got.retryAfterS);
      return { limited: true };
    }
    if (got.text === null) return { error: 'oversized' };
    let body: unknown;
    try { body = parseStrictJson(got.text); } catch { return { error: 'malformed' }; }
    if (isRateLimitBody(body)) {
      const s = Number((body as Record<string, unknown>).retry_after_seconds);
      limitFor(base, Number.isFinite(s) ? s : 1);
      return { limited: true };
    }
    return { body };
  }

  function pkSha3(nodeId: string, pkHex: string): string {
    const kept = pkShaCache.get(nodeId);
    if (kept && kept.pkHex === pkHex) return kept.sha;
    const sha = sha3_256(Buffer.from(pkHex, 'hex'));
    pkShaCache.delete(nodeId);
    pkShaCache.set(nodeId, { pkHex, sha });
    while (pkShaCache.size > PK_SHA_CACHE_MAX) pkShaCache.delete(pkShaCache.keys().next().value as string);
    return sha;
  }

  async function registryProblem(body: unknown, root: string): Promise<string | null> {
    if (!isRecord(body) || !Array.isArray(body.entries)) return 'malformed';
    if (body.entries.length > REGISTRY_MAX_ENTRIES) return 'oversized';
    if (body.entries.some((e) => registryEntryProblem(e) !== null)) return 'malformed';
    return (await recomputeRegistryRootYielding(body.entries as RegistryEntry[])) === root ? null : 'mismatch';
  }

  // node id -> sha3 of its consensus key, from the registry snapshot whose root is `root` (a certified root). A node whose
  // snapshot hashed to another root is added to `mismatched`.
  async function registryAt(root: string, height: number, mismatched?: Set<string>): Promise<Map<string, string> | null> {
    const cached = registryByRoot.get(root);
    if (cached) {
      registryByRoot.delete(root);
      registryByRoot.set(root, cached);
      return cached;
    }
    for (const base of nodeList()) {
      if (readWait(base) > 0) continue;
      const got = await nodeGet(base, `/api/v1/registry/height/${height}`, REGISTRY_MAX_BYTES);
      if (!('body' in got)) continue;
      const problem = await registryProblem(got.body, root);
      if (problem) {
        console.warn(`[WARN][LIGHT] registry_refused height=${height} base=${base}`);
        if (problem === 'mismatch') mismatched?.add(base);
        continue;
      }
      const map = new Map<string, string>();
      for (const e of (got.body as { entries: RegistryEntry[] }).entries) {
        if (typeof e.vrf_pk_sha3 === 'string' && e.vrf_pk_sha3) map.set(e.node_id, e.vrf_pk_sha3);
      }
      registryByRoot.set(root, map);
      while (registryByRoot.size > REGISTRY_CACHE_ROOTS) registryByRoot.delete(registryByRoot.keys().next().value as string);
      return map;
    }
    return null;
  }

  // Distinct valid committee signatures over the vote message until the quorum is proven; each signer tried once.
  async function quorumSigned(proof: MacroblockProof, committee: string[], pubkeys: Record<string, string>, cpHash: string, quorum: number) {
    const signers = proof.qc?.signers ?? [];
    const sigs = proof.qc?.sigs ?? [];
    if (quorum === 0 || signers.length !== sigs.length) return false;
    if (signers.length > committee.length || new Set(signers).size !== signers.length) return false;
    const members = new Set(committee);
    const message = `QNET_BFT2_VOTE:${cpHash}`;
    const valid = new Set<string>();
    for (let i = 0; i < signers.length && valid.size < quorum; i++) {
      const signer = signers[i];
      const pk = pubkeys[signer];
      if (!members.has(signer) || !pk) continue;
      const sig = parseDilithiumSig(sigs[i]);
      if (!sig) continue;
      if (verifySignature(message, sig, pk)) valid.add(signer);
      await yieldNow();
    }
    return valid.size >= quorum;
  }

  // Verifies macroblock j from its served proof: { entry }, { reason } (this answer failed), { reason, blameless }
  // (the registry, not this answer, could not be had) or { transient } (the anchor below is not there yet). Nodes whose
  // registry snapshot hashed to another root than the anchor's go into `lineage`.
  async function verifyOne(j: number, proof: unknown, lineage?: Set<string>): Promise<{ entry?: Entry; reason?: string; blameless?: boolean; transient?: boolean }> {
    if (proofShapeProblem(proof)) return { reason: 'proof_malformed' };
    const p = proof as MacroblockProof;
    const cp = p.checkpoint;
    if (p.index !== j || Math.floor(Number(cp.window_head_height) / MACROBLOCK_INTERVAL) !== j) {
      return { reason: 'index_or_head_mismatch' };
    }
    if (![cp.state_root, cp.beacon, cp.registry_root, cp.epoch_commitment].every((h) => typeof h === 'string' && HEX32.test(h))) {
      return { reason: 'proof_malformed' };
    }
    const anchor = anchorFor(j - 2);
    if (!anchor) return { transient: true };
    // The committee window is j itself, never a served field.
    const committee = sampleCommittee([...anchor.eligibleIds].sort(), j, anchor.beacon);
    const cpHash = checkpointHash(cp);
    const quorum = checkpointQuorum(cp, committee);
    if (quorum === null) return { reason: 'recovery_anchor_refused' };
    const keys = await registryAt(anchor.registryRoot, (j - 2) * MACROBLOCK_INTERVAL, lineage);
    if (!keys) return { reason: 'registry_unavailable', blameless: true };
    const served = p.committee_pubkeys ?? {};
    const pubkeys: Record<string, string> = {};
    for (const id of committee) {
      const pk = served[id];
      const sha = keys.get(id);
      if (typeof pk === 'string' && pk.length === PK_HEX && /^[0-9a-f]+$/.test(pk) && sha && pkSha3(id, pk) === sha) pubkeys[id] = pk;
    }
    if (Object.keys(pubkeys).length < quorum) return { reason: 'pubkeys_unresolved' };
    if (!(await quorumSigned(p, committee, pubkeys, cpHash, quorum))) return { reason: 'qc_invalid' };
    const eligible = Buffer.from(p.eligible_raw ?? '', 'hex');
    if (epochCommitment(eligible, committee, p.banned ?? []) !== cp.epoch_commitment) return { reason: 'epoch_commitment_mismatch' };
    const entry: Entry = { stateRoot: cp.state_root, eligibleIds: decodeEligibleNodeIds(eligible), beacon: cp.beacon, registryRoot: cp.registry_root,
      eligibleRaw: eligible.toString('hex'), checkpointHash: cpHash };
    remember(j, entry);
    capsuleConflicts(j, entry);
    scheduleSave();
    return { entry };
  }

  // The proof of step j fetched ahead from the node the step asks first, or null when none is free now.
  function fetchAhead(j: number): { base: string; answer: Promise<Got> } | null {
    const order = rotated(j);
    const base = order.find((u) => !recentFailure(j, u) && readWait(u) === 0);
    return base ? { base, answer: nodeGet(base, `/api/v1/macroblock/${j}/proof`, PROOF_MAX_BYTES) } : null;
  }

  // The nodes in an order that moves with j, so consecutive steps spread over them.
  function rotated(j: number): string[] {
    const list = nodeList();
    if (list.length === 0) return list;
    const k = j % list.length;
    return [...list.slice(k), ...list.slice(0, k)];
  }

  // One step from the first node whose proof verifies. `lineage` collects the nodes that refused it for what ties it to
  // the anchor below (LINEAGE_REASONS, or a registry snapshot of another root).
  async function verifyStep(j: number, target: boolean, ahead: { base: string; answer: Promise<Got> } | null, lineage?: Set<string>): Promise<Outcome> {
    const tried = new Set<string>();
    let asked = 0;
    let limited = 0;
    let notFound = 0;
    let first = ahead && !recentFailure(j, ahead.base) ? ahead : null;
    for (;;) {
      let base: string;
      let got: Got;
      if (first) {
        base = first.base;
        got = await first.answer;
        first = null;
      } else {
        const open = rotated(j).filter((u) => !tried.has(u) && !recentFailure(j, u));
        if (open.length === 0) break;
        const t = now();
        const free = open.find((u) => readWait(u, t) === 0);
        if (!free) {
          const wait = Math.min(...open.map((u) => readWait(u, t)));
          if (wait > STEP_WAIT_MAX_MS) return 'transient';
          await sleep(wait);
          continue;
        }
        base = free;
        got = await nodeGet(base, `/api/v1/macroblock/${j}/proof`, PROOF_MAX_BYTES);
      }
      tried.add(base);
      if ('limited' in got) { limited += 1; continue; }
      asked += 1;
      if ('error' in got) {
        noteFailure(j, base);
        continue;
      }
      if (isRecord(got.body) && got.body.error === 'macroblock_not_found') {
        // Certified some blocks after its height: not a failure of the node, and not yet a verdict. Never held against
        // the node, so a walk past the head (an index a node named ahead) leaves the next macroblock askable.
        notFound += 1;
        if (target && notFound >= NOT_FOUND_ANSWERS) return 'not_certified';
        continue;
      }
      let r: Awaited<ReturnType<typeof verifyOne>>;
      try {
        r = await verifyOne(j, got.body, lineage);
      } catch {
        r = { reason: 'proof_malformed' };
      }
      if (r.entry) return 'verified';
      // The registry, not this answer, could not be had: no node is blamed, the next request tries again.
      if (r.transient || r.blameless) return 'transient';
      console.warn(`[WARN][LIGHT] step_refused j=${j} base=${base} reason=${r.reason}`);
      if (r.reason && LINEAGE_REASONS.has(r.reason)) lineage?.add(base);
      noteFailure(j, base);
    }
    if (asked === 0 && limited > 0) return 'transient';
    if (notFound > 0 && notFound === asked) return 'not_certified';
    return 'failed';
  }

  // Walks idx's parity chain up from its root: the highest anchor below it the site holds (a verified checkpoint, or the
  // pin's K or K-1), or the held capsule's root when that is higher and the walk from the site's own would take more
  // than OWN_ROOT_WALK_STEPS steps; a walk from the site's own anchor jumps to a capsule held meanwhile on the same
  // terms. The first step above a capsule root refused by LINEAGE_REFUSALS nodes for what ties it to that root drops
  // the capsule (no node blamed), and the walk roots at the site's own anchor at once.
  async function walkTo(idx: number): Promise<Outcome> {
    await loaded;
    let restarts = 0;
    for (;;) {
      const own = ownRoot(idx);
      const cap = capsuleRoot(idx);
      const fromCapsule = cap > own && stepsFrom(own, idx) > OWN_ROOT_WALK_STEPS;
      const root = fromCapsule ? cap : own;
      if (root < 0) return 'failed';
      const ahead = new Map<number, { base: string; answer: Promise<Got> } | null>();
      let restart = false;
      for (let j = root + 2; j <= idx; j += 2) {
        if (verified.has(j)) continue;
        for (let s = j, n = 0; s <= idx && n < depth; s += 2, n++) if (!ahead.has(s) && !verified.has(s)) ahead.set(s, fetchAhead(s));
        const first = ahead.get(j) ?? null;
        ahead.delete(j);
        const lineage = new Set<string>();
        const outcome = await verifyStep(j, j === idx, first, lineage);
        if (outcome === 'verified') {
          // Each restart follows a new capsule or a dropped one, so there are at most a few.
          if (!fromCapsule && restarts < 4 && capsuleRoot(idx) > j && stepsFrom(j, idx) > OWN_ROOT_WALK_STEPS) {
            console.log(`[INFO][GALC] walk_rerooted j=${j} root=${capsuleRoot(idx)} target=${idx}`);
            restart = true;
            break;
          }
          continue;
        }
        if (fromCapsule && j === root + 2 && lineage.size >= LINEAGE_REFUSALS && capsuleRoot(idx) === root && restarts < 4) {
          console.warn(`[WARN][GALC] capsule_root_refused root=${root} j=${j} refused=${lineage.size}`);
          dropCapsule();
          for (const key of [...failed.keys()]) if (key.startsWith(`${j}|`)) failed.delete(key);
          restart = true;
          break;
        }
        if (outcome !== 'not_certified') console.warn(`[WARN][LIGHT] walk_stopped j=${j} target=${idx} outcome=${outcome}`);
        return outcome;
      }
      if (restart) {
        restarts += 1;
        continue;
      }
      if (verified.has(idx)) console.log(`[INFO][LIGHT] macroblock_verified j=${idx}`);
      return certifiedEntry(idx) ? 'verified' : 'failed';
    }
  }

  // One walk per parity chain at a time: a request joins the walk that will reach its index, or queues one after it.
  function walkFor(idx: number): Promise<Outcome> {
    const parity = idx % 2;
    const running = walks.get(parity);
    if (running && running.target >= idx) return running.promise.then((o) => (certifiedEntry(idx) ? 'verified' : o));
    const promise = (running ? running.promise.catch(() => 'failed' as Outcome) : Promise.resolve('verified' as Outcome))
      .then(() => walkTo(idx))
      .catch(() => 'failed' as Outcome)
      .finally(() => { if (walks.get(parity)?.promise === promise) walks.delete(parity); });
    walks.set(parity, { target: idx, promise });
    return promise;
  }

  async function certifiedRootAt(j: number, waitMs: number): Promise<RootAnswer> {
    if (!pinOk) return { unprovable: 'no_pin' };
    if (!Number.isSafeInteger(j) || j < trustFloorIndex()) return { unprovable: 'below_floor' };
    await within(loaded, waitMs, undefined);
    const hit = verified.get(j);
    if (hit) {
      remember(j, hit);
      return { root: hit.stateRoot };
    }
    const root = capsuleEntry(j);
    if (root) return { root: root.stateRoot };
    const outcome = await within(walkFor(j), waitMs, 'pending' as const);
    const entry = certifiedEntry(j);
    if (entry) return { root: entry.stateRoot };
    if (outcome === 'pending' || outcome === 'transient') return { pending: true };
    return { unprovable: outcome === 'not_certified' ? 'not_certified' : 'unavailable' };
  }

  async function certifiedIndexOfRoot(stateRoot: string, blockHeight: number, waitMs: number): Promise<IndexAnswer> {
    if (!pinOk || !HEX32.test(stateRoot) || !Number.isSafeInteger(blockHeight) || blockHeight < 0) return { none: true };
    const idx = Math.floor(blockHeight / MACROBLOCK_INTERVAL);
    const candidates = [idx, idx - 1, idx - 2].filter((c) => c >= trustFloorIndex());
    const matches = (c: number) => candidates.includes(c) && certifiedEntry(c)?.stateRoot === stateRoot;
    const known = candidates.find(matches);
    if (known !== undefined) return { index: known };
    if (candidates.length === 0) return { none: true };
    const deadline = now() + waitMs;
    const left = () => Math.max(0, deadline - now());
    let pending = false;
    const ask = async (c: number) => {
      if (!candidates.includes(c) || certifiedEntry(c)) return;
      if ('pending' in (await certifiedRootAt(c, left()))) pending = true;
    };
    await ask(idx);
    if (matches(idx)) return { index: idx };
    if (matches(idx - 2)) return { index: idx - 2 };
    // A state that changed after a checkpoint is never that checkpoint's again: with idx certified under another
    // root, no earlier one but idx-2 (verified on the way) can hold it.
    if (certifiedEntry(idx)) return { none: true };
    await ask(idx - 1);
    if (matches(idx - 1)) return { index: idx - 1 };
    await ask(idx - 2);
    if (matches(idx - 2)) return { index: idx - 2 };
    return pending ? { pending: true } : { none: true };
  }

  // The second highest of the answers: one node alone can neither raise nor lower it.
  async function readHead(): Promise<number | null> {
    const nodes = nodeList();
    const certified = await Promise.all(nodes.map(async (base) => {
      const got = await nodeGet(base, '/api/v1/state/certified', STATE_CERTIFIED_MAX_BYTES);
      if (!('body' in got) || !isRecord(got.body) || got.body.proof_format !== 2) return null;
      const v = got.body.newest_certified_index;
      return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
    }));
    const c = certified.filter((v): v is number => v !== null).sort((a, b) => b - a);
    if (c.length >= CERTIFIED_HEAD_ANSWERS) return c[1];
    // Nodes from before certified state proofs report only their applied tip; its macroblock is at or above the
    // certified head, so a head read from it can only make a proof count as older, never as newer.
    const legacy = await Promise.all(nodes.map(async (base) => {
      const got = await nodeGet(base, '/api/v1/height', STATE_CERTIFIED_MAX_BYTES);
      if (!('body' in got) || !isRecord(got.body)) return null;
      const h = got.body.height;
      return Number.isSafeInteger(h) && (h as number) > 0 ? Math.floor((h as number) / MACROBLOCK_INTERVAL) : null;
    }));
    const l = legacy.filter((v): v is number => v !== null).sort((a, b) => b - a);
    return l.length >= LEGACY_HEAD_ANSWERS ? l[1] : null;
  }

  // The certified head as the nodes report it (readHead), read again once a minute.
  async function nodesHead(): Promise<number | null> {
    const t = now();
    if (!head || t - head.at >= (head.value === null ? HEAD_RETRY_MS : HEAD_TTL_MS)) {
      if (!headRead) {
        headRead = readHead().catch(() => null).finally(() => { headRead = null; });
      }
      const value = await headRead;
      head = { value, at: now() };
    }
    return head.value;
  }

  async function certifiedHead(): Promise<number | null> {
    const value = await nodesHead();
    return value === null ? null : Math.max(highestVerifiedIndex(), value);
  }

  // ── the capsule ──────────────────────────────────────────────────────────────

  const refusedNow = (c: Capsule) => !!refused && refused.index === c.mb_index && refused.cpA === c.cp_hash_anchor
    && now() - refused.at < CAPSULE_MISS_TTL_MS;

  // A capsule naming another checkpoint for K or K-1 than one verified here (by hash; by root once its entries are known).
  function verifiedConflict(c: Capsule, entries?: Map<number, Entry>): boolean {
    const want = new Map([[c.mb_index, c.cp_hash_anchor], [c.mb_index - 1, c.cp_hash_pred]]);
    for (const [j, cpHash] of want) {
      const mine = verified.get(j);
      if (!mine) continue;
      if (mine.checkpointHash !== undefined && mine.checkpointHash !== cpHash) return true;
      const theirs = entries?.get(j);
      if (theirs && differ(mine, theirs)) return true;
    }
    return false;
  }

  const entryOf = (e: CapsuleEntry): Entry => ({
    stateRoot: e.stateRoot, eligibleIds: e.eligibleIds, beacon: e.beacon, registryRoot: e.registryRoot, eligibleRaw: e.eligibleRaw,
    checkpointHash: e.checkpointHash,
  });

  function adopt(c: Capsule, roots: Record<string, CapsuleRootParts>, entries: Map<number, Entry>, save: boolean) {
    held = { index: c.mb_index, cpA: c.cp_hash_anchor, record: { capsule: capsuleWire(c), roots }, entries };
    console.log(`[INFO][GALC] capsule_adopted k=${c.mb_index}`);
    if (save) scheduleSave();
  }

  // The proof parts of macroblock j from CAPSULE_ROOT_NODES distinct nodes (two asked at a time, in order) whose proofs
  // hash to `cpHash`: { root, entry }; { conflict } once as many nodes' proofs of j hash to other checkpoints;
  // { problem } when the signed checkpoint itself is refused; else { unrooted } (too few answered now).
  async function confirmRoot(j: number, cpHash: string): Promise<{ root: CapsuleRootParts; entry: Entry } | { conflict: true } | { problem: string } | { unrooted: true }> {
    const confirmed: { root: CapsuleRootParts; entry: Entry }[] = [];
    const others = new Set<string>();
    const queue = rotated(j).filter((u) => readWait(u) === 0);
    while (confirmed.length < CAPSULE_ROOT_NODES && queue.length > 0) {
      const batch = queue.splice(0, CAPSULE_ROOT_NODES - confirmed.length);
      const answers = await Promise.all(batch.map(async (base) => ({ base, got: await nodeGet(base, `/api/v1/macroblock/${j}/proof`, PROOF_MAX_BYTES) })));
      for (const { base, got } of answers) {
        if (!('body' in got) || !isRecord(got.body) || got.body.error === 'macroblock_not_found') continue;
        const parts = rootPartsOf(got.body);
        const r = capsuleRootOf(j, parts, cpHash);
        if ('entry' in r) confirmed.push({ root: structuredClone(parts), entry: entryOf(r.entry) });
        else if (r.problem === 'cp_hash') others.add(base);
        else if (r.problem === 'recovery_anchor') return { problem: r.problem };
      }
      if (others.size >= CAPSULE_ROOT_NODES) {
        console.error(`[ERR][GALC] capsule_root_mismatch j=${j} nodes=${others.size}`);
        return { conflict: true };
      }
    }
    return confirmed.length >= CAPSULE_ROOT_NODES ? confirmed[0] : { unrooted: true };
  }

  // Roots a signed capsule at proofs of K and K-1 and holds it.
  async function rootCapsule(c: Capsule): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'recovery_anchor' | 'unrooted' | 'stale' }> {
    if (verifiedConflict(c)) return { ok: false, reason: 'conflict' };
    const k = c.mb_index;
    const roots: Record<string, CapsuleRootParts> = {};
    const entries = new Map<number, Entry>();
    for (const [j, cpHash] of [[k, c.cp_hash_anchor], [k - 1, c.cp_hash_pred]] as const) {
      const r = await confirmRoot(j, cpHash);
      if ('conflict' in r) return { ok: false, reason: 'conflict' };
      if ('problem' in r) return { ok: false, reason: 'recovery_anchor' };
      if ('unrooted' in r) return { ok: false, reason: 'unrooted' };
      roots[String(j)] = r.root;
      entries.set(j, r.entry);
    }
    if (held && held.index >= k) return { ok: false, reason: 'stale' }; // a higher one came meanwhile
    if (verifiedConflict(c, entries)) return { ok: false, reason: 'conflict' };
    adopt(c, roots, entries, true);
    return { ok: true };
  }

  // A capsule kept by the store, verified again with no network: the cheap checks (but the head), the roots of K and K-1
  // against the signed checkpoint hashes and epoch commitments, the genesis signatures.
  async function importCapsule(record: unknown, save: boolean): Promise<{ ok: true; index: number } | { ok: false; reason: string }> {
    try {
      if (!capsulesOn) return { ok: false, reason: 'disabled' };
      if (!isRecord(record) || JSON.stringify(record).length > CAPSULE_RECORD_MAX_BYTES) return { ok: false, reason: 'shape' };
      const problem = capsuleProblem(record.capsule, rules, null);
      if (problem) return { ok: false, reason: problem };
      const c = record.capsule as Capsule;
      if (JSON.stringify(c).length > CAPSULE_MAX_BYTES) return { ok: false, reason: 'shape' };
      const k = c.mb_index;
      if (held && k <= held.index) return { ok: false, reason: 'stale' };
      if (refusedNow(c) || verifiedConflict(c)) return { ok: false, reason: 'conflict' };
      const kept = isRecord(record.roots) ? record.roots : {};
      const roots: Record<string, CapsuleRootParts> = {};
      const entries = new Map<number, Entry>();
      for (const [j, cpHash] of [[k, c.cp_hash_anchor], [k - 1, c.cp_hash_pred]] as const) {
        const parts = kept[String(j)];
        const r = isRecord(parts) ? capsuleRootOf(j, rootPartsOf(parts), cpHash) : { problem: 'root_shape' };
        if (!('entry' in r)) return { ok: false, reason: r.problem };
        roots[String(j)] = structuredClone(rootPartsOf(parts as Record<string, unknown>));
        entries.set(j, entryOf(r.entry));
      }
      if (!(await capsuleSigned(c, rules.keys, verifySignature))) return { ok: false, reason: 'signatures' };
      if (held && k <= held.index) return { ok: false, reason: 'stale' };
      if (verifiedConflict(c, entries)) return { ok: false, reason: 'conflict' };
      adopt(c, roots, entries, save);
      return { ok: true, index: k };
    } catch (e) {
      console.warn(`[WARN][GALC] import_threw err=${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, reason: 'shape' };
    }
  }

  const missCapsule = (base: string, ms = CAPSULE_MISS_TTL_MS) => { capsuleMiss.set(base, now() + ms); };
  function capsuleMissed(base: string, t: number): boolean {
    const until = capsuleMiss.get(base);
    if (until === undefined) return false;
    if (until <= t) { capsuleMiss.delete(base); return false; }
    return true;
  }

  // One node's capsule: a body to judge, the held one unchanged (304), a rate limit, an unusable answer, or a miss with
  // the time the node is left alone for (404 and 405, no route yet: CAPSULE_MISS_TTL_MS; no answer: FAIL_TTL_MS).
  async function capsuleGet(base: string, etag: string | null): Promise<CapsuleGot> {
    const got = await fetchCounted(base, CAPSULE_PATH, CAPSULE_MAX_BYTES, etag ? { 'If-None-Match': etag } : undefined);
    if ('error' in got) return { miss: FAIL_TTL_MS };
    if (got.status === 304) return { unchanged: true };
    if (got.status === 404 || got.status === 405) return { miss: CAPSULE_MISS_TTL_MS };
    if (got.status === 429) {
      limitFor(base, got.retryAfterS);
      return { limited: true };
    }
    if (got.status !== 200) return { miss: FAIL_TTL_MS };
    if (got.text === null) return { refused: 'oversized' };
    let body: unknown;
    try { body = parseStrictJson(got.text); } catch { return { refused: 'malformed' }; }
    if (isRateLimitBody(body)) {
      const s = Number((body as Record<string, unknown>).retry_after_seconds);
      limitFor(base, Number.isFinite(s) ? s : 1);
      return { limited: true };
    }
    return { body };
  }

  // Whether the walk from the site's own data to the head, on either parity, is long enough for a capsule to help.
  const capsuleWanted = (h: number) => [h, h - 1].some((idx) => idx >= trustFloorIndex() && !certifiedEntry(idx)
    && stepsFrom(ownRoot(idx), idx) > OWN_ROOT_WALK_STEPS);

  async function refreshNow(force: boolean): Promise<CapsuleRefresh> {
    if (!capsulesOn) return { ok: false, reason: 'disabled' };
    await loaded;
    const h = await nodesHead();
    if (h === null) return { ok: false, reason: 'no_head' };
    const heldK = held?.index ?? 0;
    if (heldK > 0 && h < heldK + rules.interval) return { ok: false, reason: 'current' };
    if (!force && !capsuleWanted(h)) return { ok: false, reason: 'not_needed' };
    const t = now();
    const ask = nodeList().filter((u) => !capsuleMissed(u, t) && readWait(u, t) === 0).slice(0, CAPSULE_ROOT_NODES);
    if (ask.length === 0) return { ok: false, reason: 'no_capsule' };
    const etag = held ? capsuleEtag(held.index, held.cpA) : null;
    const answers = await Promise.all(ask.map(async (base) => ({ base, got: await capsuleGet(base, etag) })));
    let reason: CapsuleRefreshReason = 'no_capsule';
    const offers: { base: string; c: Capsule }[] = [];
    for (const { base, got } of answers) {
      if ('limited' in got) continue;
      if ('miss' in got) {
        missCapsule(base, got.miss);
        continue;
      }
      if ('unchanged' in got) {
        missCapsule(base);
        if (reason === 'no_capsule') reason = 'stale';
        continue;
      }
      const problem = 'refused' in got ? got.refused : capsuleProblem(got.body, rules, h);
      if (problem) {
        console.warn(`[WARN][GALC] capsule_refused base=${base} reason=${problem}`);
        missCapsule(base);
        reason = 'invalid';
        continue;
      }
      offers.push({ base, c: (got as { body: Capsule }).body });
    }
    // The highest offer that roots is taken: one that does not (its proofs not served yet, a conflict) leaves the next.
    offers.sort((a, b) => b.c.mb_index - a.c.mb_index);
    const seen = new Set<string>();
    let failed: CapsuleRefreshReason | null = null;
    for (const { base, c } of offers) {
      if (c.mb_index <= (held?.index ?? heldK)) {
        missCapsule(base);
        if (reason === 'no_capsule') reason = 'stale';
        continue;
      }
      const id = `${c.mb_index}:${c.cp_hash_anchor}:${c.cp_hash_pred}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (refusedNow(c)) {
        missCapsule(base);
        reason = 'conflict';
        continue;
      }
      if (!(await capsuleSigned(c, rules.keys, verifySignature))) {
        missCapsule(base);
        reason = 'invalid';
        continue;
      }
      const r = await rootCapsule(c);
      if (r.ok) return { ok: true, index: c.mb_index };
      if (r.reason === 'conflict' || r.reason === 'recovery_anchor') {
        refused = { index: c.mb_index, cpA: c.cp_hash_anchor, at: now() };
        missCapsule(base);
      }
      if (failed === null) failed = r.reason === 'recovery_anchor' ? 'invalid' : r.reason;
    }
    return { ok: false, reason: failed ?? reason };
  }

  function refreshCapsule(o: { force?: boolean } = {}): Promise<CapsuleRefresh> {
    if (refreshing) return refreshing;
    const run: Promise<CapsuleRefresh> = refreshNow(o.force === true)
      .catch((e) => {
        console.error(`[ERR][GALC] refresh_threw err=${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, reason: 'unrooted' } as CapsuleRefresh;
      })
      .finally(() => { if (refreshing === run) refreshing = null; });
    refreshing = run;
    return run;
  }

  // Both parity chains walked to the certified head, so a request finds the newest checkpoints verified already and a
  // restart (with the store) has nothing left to catch up. The capsule is refreshed every tick, before the walks and
  // also while a long walk still runs, which then jumps to it (no request while the walk from the site's own checkpoints
  // is short). A walk cut short by the nodes' read budget resumes next tick.
  function follow(intervalMs: number = FOLLOW_INTERVAL_MS): () => void {
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (stopped || !pinOk) return;
      const refreshed = refreshCapsule();
      if (busy) return;
      busy = true;
      try {
        await loaded;
        const h = await certifiedHead();
        if (h === null || stopped) return;
        await refreshed;
        if (stopped) return;
        const due = [h, h - 1].filter((t) => t >= trustFloorIndex() && !certifiedEntry(t));
        await Promise.all(due.map((t) => walkFor(t)));
      } catch {
        // the next tick asks again
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void tick(), 0);
    const timer = setInterval(() => void tick(), intervalMs);
    first.unref?.();
    timer.unref?.();
    return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
  }

  function verifiedCheckpoint(j: number): StoredCheckpoint | null {
    const e = certifiedEntry(j);
    if (!e) return null;
    const c: StoredCheckpoint = { index: j, stateRoot: e.stateRoot, eligibleRaw: e.eligibleRaw, beacon: e.beacon, registryRoot: e.registryRoot };
    if (e.checkpointHash !== undefined) c.checkpointHash = e.checkpointHash;
    return c;
  }

  return {
    certifiedRootAt, certifiedIndexOfRoot, certifiedHead, highestVerifiedIndex, trustFloorIndex,
    ready: () => loaded, walk: walkFor, follow, flush, verifiedCheckpoint, refreshCapsule,
    heldCapsuleIndex: () => held?.index ?? 0,
  };
}

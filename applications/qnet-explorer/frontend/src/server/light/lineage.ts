// The site's light client: a macroblock's state root counts only once the macroblock's checkpoint is certified by a
// quorum of its committee's ML-DSA-65 signatures, the committee and its keys derived from the macroblock two below,
// walked up from the pin (pin.ts). The rules are the wallets' (applications/qnet-mobile/src/crypto/QcLightClient.js):
// committee drawn from the verified eligible set and beacon of j-2, keys bound to the registry root of j-2, the strict
// quorum, the epoch commitment that carries j's own eligible set forward. A node can withhold, delay or fail a step;
// it cannot make a root count that the committee did not sign. Server state: verified checkpoints in memory (the
// newest kept), one walk per parity chain at a time, shared by every request, running on after a request answers.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import jsSha3 from 'js-sha3';
import {
  MACROBLOCK_INTERVAL, checkpointHash, checkpointQuorum, decodeEligibleNodeIds, epochCommitment, parseDilithiumSig,
  proofShapeProblem, recomputeRegistryRootYielding, registryEntryProblem, sampleCommittee,
  type MacroblockProof, type RegistryEntry,
} from './checkpoint.ts';
import { WS_CHECKPOINT, type PinAnchor } from './pin.ts';
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

export interface Fetched { status: number; text: string | null; retryAfterS: number | null }
/** A bounded GET: the status and the body text (null past `maxBytes`). Throws on a transport failure or a timeout. */
export type FetchText = (url: string, maxBytes: number, timeoutMs: number) => Promise<Fetched>;

export interface Pin { index: number; anchors: Record<string, PinAnchor | undefined> }

export interface LightOptions {
  /** The nodes proofs, registry snapshots and heads are read from, in order. */
  nodes: () => readonly string[];
  fetchText: FetchText;
  verifySignature?: (message: string, sigHex: string, pkHex: string) => boolean;
  now?: () => number;
  pin?: Pin;
  readsPerMinute?: number;
  prefetch?: number;
}

export type RootAnswer = { root: string } | { pending: true } | { unprovable: 'no_pin' | 'below_floor' | 'not_certified' | 'unavailable' };
export type IndexAnswer = { index: number } | { pending: true } | { none: true };

export interface LightClient {
  /** The committee-certified state root of macroblock `j`, waiting at most `waitMs` for the walk to reach it. */
  certifiedRootAt(j: number, waitMs: number): Promise<RootAnswer>;
  /** The index of the certified checkpoint (idx, idx-1 or idx-2 for idx = floor(height/90)) whose root is `stateRoot`. */
  certifiedIndexOfRoot(stateRoot: string, blockHeight: number, waitMs: number): Promise<IndexAnswer>;
  /** max(highest verified index, the certified head the nodes report), or null when no head could be read. */
  certifiedHead(): Promise<number | null>;
  highestVerifiedIndex(): number;
  trustFloorIndex(): number;
}

interface Anchor { eligibleIds: string[]; beacon: string; registryRoot: string }
interface Entry extends Anchor { stateRoot: string }
type Got = { body: unknown } | { limited: true } | { error: string };
type Outcome = 'verified' | 'failed' | 'transient' | 'not_certified';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const yieldNow = () => new Promise<void>((resolve) => { setImmediate(resolve); });

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

export function createLightClient(opts: LightOptions): LightClient {
  const now = opts.now ?? Date.now;
  const verifySignature = opts.verifySignature ?? defaultVerify;
  const pin: Pin = opts.pin ?? { index: WS_CHECKPOINT.index, anchors: WS_CHECKPOINT.anchors as Record<string, PinAnchor | undefined> };
  const pinOk = pinIsWellformed(pin);
  const readsPerMinute = opts.readsPerMinute ?? NODE_READS_PER_MINUTE;
  const depth = opts.prefetch ?? WALK_PREFETCH;
  const verified = new Map<number, Entry>();
  const failed = new Map<string, number>();
  const walks = new Map<number, { target: number; promise: Promise<Outcome> }>();
  const registryByRoot = new Map<string, Map<string, string>>();
  const pkShaCache = new Map<string, { pkHex: string; sha: string }>();
  const reads = new Map<string, number[]>();
  const backoff = new Map<string, number>();
  let head: { value: number | null; at: number } | null = null;
  let headRead: Promise<number | null> | null = null;

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

  function anchorFor(j: number): Anchor | null {
    const v = verified.get(j);
    if (v) return v;
    const a = pinOk ? pin.anchors[String(j)] : undefined;
    if (!a || (j !== pin.index && j !== pin.index - 1)) return null;
    return { eligibleIds: decodeEligibleNodeIds(Buffer.from(a.eligible_raw, 'hex')), beacon: a.beacon, registryRoot: a.registry_root };
  }

  const highestVerifiedIndex = () => {
    let best = pinOk ? pin.index : 0;
    for (const j of verified.keys()) if (j > best) best = j;
    return best;
  };
  const trustFloorIndex = () => (pinOk ? pin.index + 1 : Number.MAX_SAFE_INTEGER);

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

  // One GET counted against the node's budget, read strictly. A rate-limit answer leaves the node alone for the time it asks.
  async function nodeGet(base: string, path: string, maxBytes: number): Promise<Got> {
    const t = now();
    const list = (reads.get(base) ?? []).filter((x) => t - x < READ_WINDOW_MS);
    list.push(t);
    reads.set(base, list);
    let got: Fetched;
    try {
      got = await opts.fetchText(base + path, maxBytes, FETCH_TIMEOUT_MS);
    } catch (e) {
      return { error: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' };
    }
    if (got.status === 429 || got.status === 503) {
      backoff.set(base, now() + Math.min(60_000, Math.max(1000, (got.retryAfterS ?? 1) * 1000)));
      return { limited: true };
    }
    if (got.text === null) return { error: 'oversized' };
    let body: unknown;
    try { body = parseStrictJson(got.text); } catch { return { error: 'malformed' }; }
    if (isRateLimitBody(body)) {
      const s = Number((body as Record<string, unknown>).retry_after_seconds);
      backoff.set(base, now() + Math.min(60_000, Math.max(1000, Number.isFinite(s) ? s * 1000 : 1000)));
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

  // node id -> sha3 of its consensus key, from the registry snapshot whose root is `root` (a certified root).
  async function registryAt(root: string, height: number): Promise<Map<string, string> | null> {
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
      if (await registryProblem(got.body, root)) {
        console.warn(`[WARN][LIGHT] registry_refused height=${height} base=${base}`);
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
  // (the registry, not this answer, could not be had) or { transient } (the anchor below is not there yet).
  async function verifyOne(j: number, proof: unknown): Promise<{ entry?: Entry; reason?: string; blameless?: boolean; transient?: boolean }> {
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
    const keys = await registryAt(anchor.registryRoot, (j - 2) * MACROBLOCK_INTERVAL);
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
    const entry: Entry = { stateRoot: cp.state_root, eligibleIds: decodeEligibleNodeIds(eligible), beacon: cp.beacon, registryRoot: cp.registry_root };
    remember(j, entry);
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

  async function verifyStep(j: number, target: boolean, ahead: { base: string; answer: Promise<Got> } | null): Promise<Outcome> {
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
        r = await verifyOne(j, got.body);
      } catch {
        r = { reason: 'proof_malformed' };
      }
      if (r.entry) return 'verified';
      // The registry, not this answer, could not be had: no node is blamed, the next request tries again.
      if (r.transient || r.blameless) return 'transient';
      console.warn(`[WARN][LIGHT] step_refused j=${j} base=${base} reason=${r.reason}`);
      noteFailure(j, base);
    }
    if (asked === 0 && limited > 0) return 'transient';
    if (notFound > 0 && notFound === asked) return 'not_certified';
    return 'failed';
  }

  // Walks idx's parity chain up from the highest anchor below it (a verified checkpoint, or the pin's K or K-1).
  async function walkTo(idx: number): Promise<Outcome> {
    let root = -1;
    for (const j of [...verified.keys(), pin.index, pin.index - 1]) {
      if (j < idx && j > root && (idx - j) % 2 === 0 && anchorFor(j)) root = j;
    }
    if (root < 0) return 'failed';
    const ahead = new Map<number, { base: string; answer: Promise<Got> } | null>();
    for (let j = root + 2; j <= idx; j += 2) {
      if (verified.has(j)) continue;
      for (let s = j, n = 0; s <= idx && n < depth; s += 2, n++) if (!ahead.has(s) && !verified.has(s)) ahead.set(s, fetchAhead(s));
      const first = ahead.get(j) ?? null;
      ahead.delete(j);
      const outcome = await verifyStep(j, j === idx, first);
      if (outcome !== 'verified') {
        if (outcome !== 'not_certified') console.warn(`[WARN][LIGHT] walk_stopped j=${j} target=${idx} outcome=${outcome}`);
        return outcome;
      }
    }
    if (verified.has(idx)) console.log(`[INFO][LIGHT] macroblock_verified j=${idx}`);
    return verified.has(idx) ? 'verified' : 'failed';
  }

  // One walk per parity chain at a time: a request joins the walk that will reach its index, or queues one after it.
  function walkFor(idx: number): Promise<Outcome> {
    const parity = idx % 2;
    const running = walks.get(parity);
    if (running && running.target >= idx) return running.promise.then((o) => (verified.has(idx) ? 'verified' : o));
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
    const hit = verified.get(j);
    if (hit) {
      remember(j, hit);
      return { root: hit.stateRoot };
    }
    const outcome = await Promise.race([walkFor(j), sleep(waitMs).then(() => 'pending' as const)]);
    const entry = verified.get(j);
    if (entry) return { root: entry.stateRoot };
    if (outcome === 'pending' || outcome === 'transient') return { pending: true };
    return { unprovable: outcome === 'not_certified' ? 'not_certified' : 'unavailable' };
  }

  async function certifiedIndexOfRoot(stateRoot: string, blockHeight: number, waitMs: number): Promise<IndexAnswer> {
    if (!pinOk || !HEX32.test(stateRoot) || !Number.isSafeInteger(blockHeight) || blockHeight < 0) return { none: true };
    const idx = Math.floor(blockHeight / MACROBLOCK_INTERVAL);
    const candidates = [idx, idx - 1, idx - 2].filter((c) => c >= trustFloorIndex());
    const matches = (c: number) => candidates.includes(c) && verified.get(c)?.stateRoot === stateRoot;
    const known = candidates.find(matches);
    if (known !== undefined) return { index: known };
    if (candidates.length === 0) return { none: true };
    const deadline = now() + waitMs;
    const left = () => Math.max(0, deadline - now());
    let pending = false;
    const ask = async (c: number) => {
      if (!candidates.includes(c) || verified.has(c)) return;
      if ('pending' in (await certifiedRootAt(c, left()))) pending = true;
    };
    await ask(idx);
    if (matches(idx)) return { index: idx };
    if (matches(idx - 2)) return { index: idx - 2 };
    // A state that changed after a checkpoint is never that checkpoint's again: with idx certified under another
    // root, no earlier one but idx-2 (verified on the way) can hold it.
    if (verified.has(idx)) return { none: true };
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

  async function certifiedHead(): Promise<number | null> {
    const t = now();
    if (!head || t - head.at >= (head.value === null ? HEAD_RETRY_MS : HEAD_TTL_MS)) {
      if (!headRead) {
        headRead = readHead().catch(() => null).finally(() => { headRead = null; });
      }
      const value = await headRead;
      head = { value, at: now() };
    }
    return head.value === null ? null : Math.max(highestVerifiedIndex(), head.value);
  }

  return { certifiedRootAt, certifiedIndexOfRoot, certifiedHead, highestVerifiedIndex, trustFloorIndex };
}

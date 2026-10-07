// An account's balance as the site may call it verified: proven against the state root of a macroblock whose committee
// certificate the site's light client verified itself (lineage.ts), and recent by that macroblock's index. Asked of the
// pinned genesis nodes in the certified form (?mb=latest): the node names the macroblock, and the proof folds to the
// root the light client verified for it, never to a root the node served. A node from before that form answers the
// legacy proof against its live root; that counts only when the root is the certified root of the macroblock covering
// its height or one of the two before it. An answer without a proof that folds (a legacy "not found", an error, a rate
// limit, a timeout) is no answer: the next node is asked, and nothing unverified is reported as a balance or a zero.
import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { MACROBLOCK_INTERVAL } from './checkpoint.ts';
import { createLightClient, type FetchText, type LightClient } from './lineage.ts';
import {
  accountKey, accountLeafHash, verifyAbsence, verifyAbsenceInBucket, verifyInclusion, type AccountFields,
} from './smt.ts';
import { isRecord, parseStrictJson, u64Text } from './strict-json.ts';

export const PROOF_ANSWER_MAX_BYTES = 64 * 1024;
const PROOF_TIMEOUT_MS = 5000;
// The longest a request asks nodes one after another, so a few hanging nodes cannot hold it for minutes.
export const REQUEST_BUDGET_MS = 15_000;
// A node that answered the legacy form is asked after the others for this long (nodes upgrade during a roll).
export const OLD_NODE_MS = 10 * 60_000;
// A proof counts only when its macroblock is within this many of the certified head.
export const MAX_LAG_MACROBLOCKS = 2;
// How long a request waits for the light client to reach a macroblock it has not verified yet.
export const VERIFY_WAIT_MS = 6000;
const HEX32 = /^[0-9a-f]{64}$/;
const CODE_HASH_MAX = 1024;

export type BalanceResult =
  | {
    verified: true; exists: boolean; balanceNano: string; nonce: string;
    macroblockIndex: number; stateHeight: number; stateRoot: string; form: 'certified' | 'legacy';
  }
  | { verified: false; reason: 'not_confirmed_yet' | 'network_unavailable' };

export interface ProverOptions {
  light: LightClient;
  nodes: () => readonly string[];
  fetchText: FetchText;
  now?: () => number;
  waitMs?: number;
}

// One answer checked: a verified result, `later` (an honest answer that cannot count yet: a macroblock not verified or
// not recent yet, or a legacy proof of a state no certified root holds), or `refused` (not an answer).
type Checked = { result: Extract<BalanceResult, { verified: true }> } | { later: true } | { refused: string };

/** A body from a node that predates the certified form, recognised by its own shape and nothing else. */
export function isLegacyBody(body: unknown): boolean {
  return isRecord(body) && !('proof_format' in body) && typeof body.proof_valid === 'boolean'
    && typeof body.block_height === 'number' && Array.isArray(body.merkle_proof);
}

const u16 = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff ? (v as number) : null);
// A u64 the certified form serves as decimal text; a whole number is taken too, since the strict reader keeps any
// number past 2^53 as its exact text and the leaf hashes the value either way.
const decimal = (v: unknown): string | null => u64Text(v);

// The certified form's fields, every one of the type the node serves, or null.
function certifiedFields(b: Record<string, unknown>): AccountFields | null {
  const f = {
    balance: decimal(b.balance), nonce: decimal(b.nonce), heartbeatEpoch: decimal(b.heartbeat_epoch),
    heartbeatSlots: u16(b.heartbeat_slots), heartbeatFinalEpoch: decimal(b.heartbeat_final_epoch),
    heartbeatFinalSlots: u16(b.heartbeat_final_slots), lastClaimedEpoch: decimal(b.last_claimed_epoch),
    bannedAtHeight: decimal(b.banned_at_height),
  };
  if (Object.values(f).some((v) => v === null)) return null;
  if (typeof b.is_contract !== 'boolean' || typeof b.is_node !== 'boolean') return null;
  const code = b.contract_code_hash;
  if (!(code === null || (typeof code === 'string' && code.length <= CODE_HASH_MAX))) return null;
  const root = b.storage_root;
  if (b.is_contract ? !(typeof root === 'string' && HEX32.test(root)) : root !== null) return null;
  return { ...(f as Omit<AccountFields, 'isContract' | 'isNode' | 'contractCodeHash' | 'storageRoot'>),
    isContract: b.is_contract, isNode: b.is_node, contractCodeHash: code as string | null, storageRoot: root as string | null };
}

const isEmptyAccount = (f: AccountFields): boolean => f.balance === '0' && f.nonce === '0' && f.heartbeatEpoch === '0'
  && f.heartbeatSlots === 0 && f.heartbeatFinalEpoch === '0' && f.heartbeatFinalSlots === 0 && f.lastClaimedEpoch === '0'
  && f.bannedAtHeight === '0' && !f.isContract && !f.isNode && f.contractCodeHash === null && f.storageRoot === null;

export function createBalanceProver(opts: ProverOptions) {
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? VERIFY_WAIT_MS;
  const { light } = opts;
  const oldUntil = new Map<string, number>();
  const backoffUntil = new Map<string, number>();

  // The lowest index that is still recent: the certified head minus the lag, null when no head could be read.
  async function recentFloor(): Promise<number | null> {
    const head = await light.certifiedHead();
    return head === null ? null : head - MAX_LAG_MACROBLOCKS;
  }

  async function checkCertified(address: string, b: Record<string, unknown>, wait: number): Promise<Checked> {
    const j = b.macroblock_index;
    if (!Number.isSafeInteger(j) || (j as number) < 1) return { refused: 'macroblock_index' };
    const index = j as number;
    if (b.address !== address) return { refused: 'address' };
    if (b.state_height !== index * MACROBLOCK_INTERVAL) return { refused: 'state_height' };
    const kind = b.proof_kind;
    if (typeof b.exists !== 'boolean' || (kind === 'inclusion') !== b.exists) return { refused: 'exists' };
    if (kind !== 'inclusion' && kind !== 'absence' && kind !== 'absence_in_bucket') return { refused: 'proof_kind' };
    if ((kind === 'absence_in_bucket') !== ('bucket_entries' in b)) return { refused: 'bucket_entries' };
    const fields = certifiedFields(b);
    if (!fields) return { refused: 'fields' };
    if (kind !== 'inclusion' && !isEmptyAccount(fields)) return { refused: 'absence_fields' };
    if (index < light.trustFloorIndex()) return { later: true };
    const floor = await recentFloor();
    if (floor === null || index < floor) return { later: true };
    const answer = await light.certifiedRootAt(index, wait);
    if ('pending' in answer) return { later: true };
    // Not certified on the nodes asked yet, or no node could serve the walk now: honest lag, never a verdict.
    if (!('root' in answer)) return answer.unprovable === 'unavailable' || answer.unprovable === 'not_certified' ? { later: true } : { refused: answer.unprovable };
    const root = answer.root;
    const key = accountKey(address);
    let ok: boolean;
    if (kind === 'inclusion') {
      let leaf: string;
      try { leaf = accountLeafHash(address, fields); } catch { return { refused: 'fields' }; }
      ok = verifyInclusion(key, leaf, b.merkle_proof, root);
    } else if (kind === 'absence') {
      ok = verifyAbsence(key, b.merkle_proof, root);
    } else {
      ok = verifyAbsenceInBucket(key, b.bucket_entries, b.merkle_proof, root);
    }
    if (!ok) return { refused: 'fold' };
    // Recent by the head as it stands now, the macroblocks verified on the way included.
    const after = await recentFloor();
    if (after === null || index < after) return { later: true };
    return { result: { verified: true, exists: kind === 'inclusion', balanceNano: fields.balance, nonce: fields.nonce,
      macroblockIndex: index, stateHeight: index * MACROBLOCK_INTERVAL, stateRoot: root, form: 'certified' } };
  }

  // The legacy form proves against the answering node's live root and carries no contract fields: it counts only for a
  // plain account whose live root is a certified root of the last three macroblocks below its height.
  async function checkLegacy(address: string, b: Record<string, unknown>, wait: number): Promise<Checked> {
    if (b.address !== address) return { refused: 'address' };
    // A legacy "account not found" carries no proof: it says nothing either way.
    if (b.proof_valid !== true) return { later: true };
    const fields = {
      balance: u64Text(b.balance), nonce: u64Text(b.nonce),
      heartbeatEpoch: u64Text(b.heartbeat_epoch ?? 0), heartbeatSlots: u16(b.heartbeat_slots ?? 0),
      heartbeatFinalEpoch: u64Text(b.heartbeat_final_epoch ?? 0), heartbeatFinalSlots: u16(b.heartbeat_final_slots ?? 0),
      lastClaimedEpoch: u64Text(b.last_claimed_epoch ?? 0), bannedAtHeight: u64Text(b.banned_at_height ?? 0),
    };
    if (Object.values(fields).some((v) => v === null) || (b.is_node !== undefined && typeof b.is_node !== 'boolean')) return { refused: 'fields' };
    const root = b.state_root;
    const height = b.block_height as number;
    if (typeof root !== 'string' || !HEX32.test(root) || !Number.isSafeInteger(height)) return { refused: 'anchor' };
    let leaf: string;
    try {
      leaf = accountLeafHash(address, { ...(fields as Omit<AccountFields, 'isContract' | 'isNode' | 'contractCodeHash' | 'storageRoot'>),
        isContract: false, isNode: b.is_node === true, contractCodeHash: null, storageRoot: null });
    } catch {
      return { refused: 'fields' };
    }
    if (!verifyInclusion(accountKey(address), leaf, b.merkle_proof, root)) return { refused: 'fold' };
    const floor = await recentFloor();
    if (floor === null || Math.floor(height / MACROBLOCK_INTERVAL) < floor) return { later: true };
    const found = await light.certifiedIndexOfRoot(root, height, wait);
    if (!('index' in found)) return { later: true };
    const after = await recentFloor();
    if (after === null || found.index < after) return { later: true };
    return { result: { verified: true, exists: true, balanceNano: fields.balance as string, nonce: fields.nonce as string,
      macroblockIndex: found.index, stateHeight: found.index * MACROBLOCK_INTERVAL, stateRoot: root, form: 'legacy' } };
  }

  /** The verified balance of `address`, or why there is none: never an unverified figure. */
  async function provenBalance(address: string): Promise<BalanceResult> {
    if (await recentFloor() === null) return { verified: false, reason: 'network_unavailable' };
    const t = now();
    const listed = [...new Set(opts.nodes())].filter((u) => (backoffUntil.get(u) ?? 0) <= t);
    const start = listed.length > 0 ? Math.floor(Math.random() * listed.length) : 0;
    const spread = [...listed.slice(start), ...listed.slice(0, start)];
    // Nodes seen on the legacy form go last; the mark lapses, so an upgraded node is asked first again.
    const order = [...spread.filter((u) => (oldUntil.get(u) ?? 0) <= t), ...spread.filter((u) => (oldUntil.get(u) ?? 0) > t)];
    let later = false;
    // One wait for the whole request, however many nodes answer with a macroblock the walk has not reached yet.
    const deadline = now() + waitMs;
    const left = () => Math.max(0, deadline - now());
    const giveUp = now() + REQUEST_BUDGET_MS;
    for (const base of order) {
      if (now() >= giveUp) break;
      let got;
      try {
        got = await opts.fetchText(`${base}/api/v1/account/${encodeURIComponent(address)}/balance/proof?mb=latest`, PROOF_ANSWER_MAX_BYTES,
          Math.min(PROOF_TIMEOUT_MS, Math.max(1000, giveUp - now())));
      } catch {
        continue;
      }
      if (got.status !== 200) {
        if (got.retryAfterS !== null) backoffUntil.set(base, now() + Math.min(60, Math.max(1, got.retryAfterS)) * 1000);
        continue;
      }
      if (got.text === null) continue;
      let body: unknown;
      try { body = parseStrictJson(got.text); } catch { continue; }
      if (!isRecord(body)) continue;
      if (typeof body.error === 'string' && /^rate limit exceeded/i.test(body.error)) {
        // A legacy route's rate limit (HTTP 200): the node is left alone for the time it asks, and is not marked old.
        const s = Number(body.retry_after_seconds);
        backoffUntil.set(base, now() + Math.min(60, Math.max(1, Number.isFinite(s) ? s : 1)) * 1000);
        continue;
      }
      let checked: Checked;
      if (body.proof_format === 2) {
        oldUntil.delete(base);
        checked = await checkCertified(address, body, left());
      } else if (isLegacyBody(body)) {
        oldUntil.set(base, now() + OLD_NODE_MS);
        checked = await checkLegacy(address, body, left());
      } else {
        continue;
      }
      if ('result' in checked) return checked.result;
      if ('later' in checked) later = true;
      else console.warn(`[WARN][BALANCE-PROOF] answer_refused base=${base} reason=${checked.refused}`);
    }
    return { verified: false, reason: later ? 'not_confirmed_yet' : 'network_unavailable' };
  }

  return { provenBalance };
}

/** A bounded GET for the light client and the prover: Node's fetch, the body read up to the cap. */
export const fetchText: FetchText = async (url, maxBytes, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' }, cache: 'no-store' });
  const bytes = await readCappedBytes(res, maxBytes);
  const ra = res.headers.get('retry-after');
  return { status: res.status, text: bytes === null ? null : new TextDecoder().decode(bytes), retryAfterS: ra !== null && /^\d{1,6}$/.test(ra) ? Number(ra) : null };
};

const SHARED = Symbol.for('qnet.site.balanceProver');

/** The server's one prover and light client, reading the pinned genesis nodes. */
export function sharedBalanceProver(): ReturnType<typeof createBalanceProver> {
  const g = globalThis as typeof globalThis & { [SHARED]?: ReturnType<typeof createBalanceProver> };
  if (!g[SHARED]) {
    const nodes = () => GENESIS_NODES;
    g[SHARED] = createBalanceProver({ light: createLightClient({ nodes, fetchText }), nodes, fetchText });
  }
  return g[SHARED];
}

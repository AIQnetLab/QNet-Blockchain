// The state tree's proof checks, byte for byte as the node verifies them (core/qnet-state/src/state.rs
// verify_leaf_proof and hash_account, core/qnet-state/src/tree_proof.rs verify_leaf): the account leaf over every field,
// an inclusion fold, an absence fold over an empty bucket, and an absence fold over a shared bucket with all its
// entries. The tree collapses the low 216 key bits into buckets (leaves sharing the leading 40 bits, folded as a
// mini-merkle of tagged leaves sha3(0xB5 || key || value)) and hashes the top 40 levels. Every check here folds to a root
// the caller already holds from a committee-verified checkpoint; nothing here decides which root that is.
import jsSha3 from 'js-sha3';

const { sha3_256 } = jsSha3;

export const PROOF_DEPTH = 40;
const BUCKET_DEPTH = 216;
const BUCKET_STEPS_MAX = 64;
export const ABSENCE_BUCKET_ENTRIES_MAX = 64;
const ZERO32 = '0'.repeat(64);
const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = 0xffffffffffffffffn;

export interface ProofStep { sibling: string; is_right: boolean }
export interface BucketEntry { key: string; leaf: string }

/** Every field the node's account leaf hashes (u64 values as decimal text). */
export interface AccountFields {
  balance: string;
  nonce: string;
  isContract: boolean;
  contractCodeHash: string | null;
  storageRoot: string | null;
  heartbeatEpoch: string;
  heartbeatSlots: number;
  heartbeatFinalEpoch: string;
  heartbeatFinalSlots: number;
  lastClaimedEpoch: string;
  bannedAtHeight: string;
  isNode: boolean;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u64le(text: string): Uint8Array {
  const v = BigInt(text);
  if (v < 0n || v > U64_MAX) throw new RangeError('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function u16le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('u16 out of range');
  return Uint8Array.of(n & 0xff, n >> 8);
}

const h = (bytes: Uint8Array): string => sha3_256(bytes);
const node = (left: string, right: string): string => h(hexBytes(left + right));
const bucketLeaf = (key: string, leaf: string): string => h(hexBytes(`b5${key}${leaf}`));

let defaultBucket: string | null = null;
function defaultBucketHash(): string {
  if (defaultBucket) return defaultBucket;
  let d = ZERO32;
  for (let i = 0; i < BUCKET_DEPTH; i++) d = node(d, d);
  defaultBucket = d;
  return d;
}

// The key bit tree depth `depth` splits on: depth 255 on the first bit of the key, depth 216 on the 40th.
function keyBit(key: string, depth: number): boolean {
  const b = 255 - depth;
  return ((parseInt(key.substr((b >> 3) * 2, 2), 16) >> (7 - (b % 8))) & 1) === 1;
}

/** The SMT key of an account: sha3_256("QNET_ADDR:" + address). */
export const accountKey = (address: string): string => h(utf8(`QNET_ADDR:${address}`));
/** The SMT key of a contract storage entry. */
export const storageKey = (key: string): string => h(utf8(`QNET_STORAGE_KEY:${key}`));
/** The leaf of a contract storage value: the hash of the raw stored string. */
export const storageLeaf = (value: string): string => h(utf8(`QNET_STORAGE_VAL:${value}`));

/** The account leaf, QNET_ACCOUNT_V2, over every field the node hashes; throws on a value out of range. */
export function accountLeafHash(address: string, f: AccountFields): string {
  const parts = [utf8('QNET_ACCOUNT_V2:'), u64le(f.balance), u64le(f.nonce), utf8(address), Uint8Array.of(f.isContract ? 1 : 0)];
  if (f.contractCodeHash !== null) parts.push(utf8('CODE:'), utf8(f.contractCodeHash));
  if (f.isContract) {
    if (f.storageRoot === null || !HEX32.test(f.storageRoot)) throw new RangeError('a contract leaf needs its storage root');
    parts.push(utf8('SROOT:'), hexBytes(f.storageRoot));
  }
  parts.push(utf8('HB:'), u64le(f.heartbeatEpoch), u16le(f.heartbeatSlots), u64le(f.heartbeatFinalEpoch), u16le(f.heartbeatFinalSlots));
  parts.push(utf8('LCE:'), u64le(f.lastClaimedEpoch), utf8('BAN:'), u64le(f.bannedAtHeight), utf8('NODE:'), Uint8Array.of(f.isNode ? 1 : 0));
  return h(concat(parts));
}

const wellFormedSteps = (steps: unknown): steps is ProofStep[] => Array.isArray(steps) && steps.every((s) =>
  s !== null && typeof s === 'object' && typeof (s as ProofStep).sibling === 'string' && HEX32.test((s as ProofStep).sibling)
  && typeof (s as ProofStep).is_right === 'boolean');

// The last PROOF_DEPTH steps from a bucket hash to the root, each flag bound to the key's bit at its depth.
function foldTree(key: string, seed: string, steps: ProofStep[]): string | null {
  let current = seed;
  for (let i = 0; i < steps.length; i++) {
    const { sibling, is_right: right } = steps[i];
    if (right !== keyBit(key, BUCKET_DEPTH + i)) return null;
    current = right ? node(sibling, current) : node(current, sibling);
  }
  return current;
}

/** `leaf` (never zero) is the value of `key` in the tree whose root is `root`: the in-bucket path, then 40 tree steps. */
export function verifyInclusion(key: string, leaf: string, steps: unknown, root: string): boolean {
  if (!HEX32.test(key) || !HEX32.test(leaf) || leaf === ZERO32 || !HEX32.test(root) || !wellFormedSteps(steps)) return false;
  if (steps.length < PROOF_DEPTH || steps.length > PROOF_DEPTH + BUCKET_STEPS_MAX) return false;
  const inBucket = steps.length - PROOF_DEPTH;
  let current = bucketLeaf(key, leaf);
  for (let i = 0; i < inBucket; i++) {
    const { sibling, is_right: right } = steps[i];
    current = right ? node(sibling, current) : node(current, sibling);
  }
  return foldTree(key, current, steps.slice(inBucket)) === root;
}

/** `key` is in no leaf: its bucket is empty (the zero seed) and the walk is exactly 40 tree steps. */
export function verifyAbsence(key: string, steps: unknown, root: string): boolean {
  if (!HEX32.test(key) || !HEX32.test(root) || !wellFormedSteps(steps) || steps.length !== PROOF_DEPTH) return false;
  return foldTree(key, defaultBucketHash(), steps) === root;
}

/**
 * `key` is in no leaf of its bucket, which holds exactly `entries`: 1 to 64 of them, keys strictly ascending, all in
 * the key's bucket (its leading 40 bits), none equal to the key, no zero leaf; the bucket folds from them and the 40
 * tree steps from there.
 */
export function verifyAbsenceInBucket(key: string, entries: unknown, steps: unknown, root: string): boolean {
  if (!HEX32.test(key) || !HEX32.test(root) || !wellFormedSteps(steps) || steps.length !== PROOF_DEPTH) return false;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > ABSENCE_BUCKET_ENTRIES_MAX) return false;
  const bucket = key.slice(0, PROOF_DEPTH / 4);
  let prev = '';
  const leaves: string[] = [];
  for (const e of entries as unknown[]) {
    if (e === null || typeof e !== 'object') return false;
    const { key: k, leaf } = e as BucketEntry;
    if (typeof k !== 'string' || typeof leaf !== 'string' || !HEX32.test(k) || !HEX32.test(leaf)) return false;
    if (k.slice(0, PROOF_DEPTH / 4) !== bucket || k === key || leaf === ZERO32 || k <= prev) return false;
    prev = k;
    leaves.push(bucketLeaf(k, leaf));
  }
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return foldTree(key, level[0], steps) === root;
}

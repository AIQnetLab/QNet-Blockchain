// GALC v2 capsules as the site's light client takes them (docs/protocols/galc-capsule-v2.md), by the wallets' rules
// (applications/qnet-mobile/src/crypto/QcLightClient.js): a capsule names macroblock K, a multiple of the capsule
// cadence, and the checkpoint hashes of K and K-1, signed by at least quorum_size(5) = 4 of the five embedded genesis
// consensus keys (genesis-keys.ts) over a preimage built here from its fields. Its roots count once nodes serve proofs of
// K and K-1 whose checkpoints hash to the signed values and whose eligible sets match their epoch commitments
// (lineage.ts asks two nodes for each). The checks below are the pure part: the cheap refusals before any signature, the
// signatures, and one root against its signed hash. A capsule is a faster walk root, never a replacement of what the
// site verified: lineage.ts walks by committee signatures from its own checkpoints while that walk is short, refuses a
// capsule naming another checkpoint than one it verified, and keeps the trust floor at the pin.
import {
  MACROBLOCK_INTERVAL, checkpointHash, decodeEligibleNodeIds, epochCommitment, parseDilithiumSig, proofShapeProblem, quorumSize,
  type Checkpoint,
} from './checkpoint.ts';

export const CAPSULE_VERSION = 2;
const CAPSULE_DOMAIN = 'QNET_GENESIS_CHECKPOINT_v2';
export const CAPSULE_PATH = '/api/v1/galc/capsule';
// A body larger than this is refused unread.
export const CAPSULE_MAX_BYTES = 64 * 1024;
// A kept record (the capsule and the proof parts of K and K-1 that bind it).
export const CAPSULE_RECORD_MAX_BYTES = 1024 * 1024;
// A node that answered no capsule (404, 405), an unusable one or none newer than the held one is not asked again for
// this long: probing costs at most one request per node per TTL.
export const CAPSULE_MISS_TTL_MS = 10 * 60_000;
// A walk from the site's own checkpoint (or the pin) of at most this many steps is taken even when a capsule roots
// higher: the capsule shortens long walks, it never stands in for a lineage the site can still follow.
export const OWN_ROOT_WALK_STEPS = 16;
// Distinct nodes whose proofs of K, and of K-1, must hash to the signed checkpoint hashes; as many whose proofs hash to
// other checkpoints drop the capsule (no node is blamed).
export const CAPSULE_ROOT_NODES = 2;

const HEX32 = /^[0-9a-f]{64}$/;
const CAPSULE_HASHES = ['mb_hash', 'committee_digest_anchor', 'committee_digest_pred', 'cp_hash_anchor', 'cp_hash_pred'] as const;

export interface Capsule {
  version: number;
  network_id: string;
  mb_index: number;
  mb_hash: string;
  committee_digest_anchor: string;
  committee_digest_pred: string;
  minted_at_height: number;
  cp_hash_anchor: string;
  cp_hash_pred: string;
  sigs: [string, string][];
}

/** The parts of a served proof of macroblock j that bind it to a capsule. */
export interface CapsuleRootParts {
  index: number;
  checkpoint: Checkpoint;
  eligible_raw: string;
  committee: string[];
  banned: string[];
}

/** A capsule as the store keeps it; read back, every part is verified again (lineage.ts). */
export interface CapsuleRecord {
  capsule: Capsule;
  roots: Record<string, CapsuleRootParts>;
}

/** What a capsule is judged against: the build's network id and cadence, the pin, the genesis keys. */
export interface CapsuleRules {
  networkId: string;
  interval: number;
  pinIndex: number;
  keys: Readonly<Record<string, string>>;
}

/** The verified entry of a capsule root, every field inside the checkpoint hash the genesis keys signed. */
export interface CapsuleEntry {
  stateRoot: string;
  eligibleIds: string[];
  eligibleRaw: string;
  beacon: string;
  registryRoot: string;
  checkpointHash: string;
}

export type CapsuleRefreshReason = 'disabled' | 'no_head' | 'current' | 'not_needed' | 'no_capsule' | 'stale' | 'invalid' | 'conflict' | 'unrooted';
export type CapsuleRefresh = { ok: true; index: number } | { ok: false; reason: CapsuleRefreshReason };

export type VerifySignature = (message: string, sigHex: string, pkHex: string) => boolean;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const yieldNow = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** The text the genesis keys sign (docs/protocols/galc-capsule-v2.md section 3). */
export function capsulePreimage(c: Pick<Capsule, 'version' | 'network_id' | 'mb_index' | 'mb_hash' | 'committee_digest_anchor'
  | 'committee_digest_pred' | 'minted_at_height' | 'cp_hash_anchor' | 'cp_hash_pred'>): string {
  return [CAPSULE_DOMAIN, c.version, c.network_id, c.mb_index, c.mb_hash, c.committee_digest_anchor, c.committee_digest_pred,
    c.minted_at_height, c.cp_hash_anchor, c.cp_hash_pred].join(':');
}

/** The ETag a node serves with capsule K (section 6), sent as If-None-Match for the capsule held. */
export const capsuleEtag = (index: number, cpA: string): string => `"2-${index}-${cpA.slice(0, 8)}"`;

/**
 * Why a capsule is refused before any signature is checked, or null, in the order of section 7.1: 'shape', 'version',
 * 'network_id', 'index' (below 2), 'interval', 'minted_at_height' (not K*90), 'signature_count' (not 4 or 5 entries),
 * 'below_pin' or 'above_head' (K more than 2 above `headHint`, the certified head; left out when it is null, as for a
 * kept capsule).
 */
export function capsuleProblem(c: unknown, rules: CapsuleRules, headHint: number | null = null): string | null {
  if (!isObject(c)) return 'shape';
  if (c.version !== CAPSULE_VERSION) return 'version';
  if (c.network_id !== rules.networkId) return 'network_id';
  const k = c.mb_index;
  if (typeof k !== 'number' || !Number.isSafeInteger(k) || k < 2) return 'index';
  if (k % rules.interval !== 0) return 'interval';
  if (c.minted_at_height !== k * MACROBLOCK_INTERVAL) return 'minted_at_height';
  if (!CAPSULE_HASHES.every((f) => typeof c[f] === 'string' && HEX32.test(c[f] as string))) return 'shape';
  const n = Object.keys(rules.keys).length;
  if (!Array.isArray(c.sigs) || c.sigs.length < quorumSize(n) || c.sigs.length > n) return 'signature_count';
  if (!c.sigs.every((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && typeof s[1] === 'string')) return 'shape';
  if (k <= rules.pinIndex) return 'below_pin';
  if (headHint !== null && !(Number.isSafeInteger(headHint) && k <= headHint + 2)) return 'above_head';
  return null;
}

// The node id a "dilithium_sig_<id>_<base64>" string names, or null.
function sigNodeId(sig: string): string | null {
  if (!sig.startsWith('dilithium_sig_')) return null;
  const part = sig.slice('dilithium_sig_'.length);
  const sep = part.lastIndexOf('_');
  return sep > 0 ? part.slice(0, sep) : null;
}

/**
 * The genesis ids whose signatures of a capsule that passed capsuleProblem verify, up to the quorum: an entry counts
 * for an embedded genesis id only, when the id its signature string names is the same, and when its ML-DSA-65 signature
 * verifies over the preimage built here with that id's embedded key; an id counts once.
 */
export async function capsuleSigners(c: Capsule, keys: Readonly<Record<string, string>>, verify: VerifySignature): Promise<string[]> {
  const need = quorumSize(Object.keys(keys).length);
  const message = capsulePreimage(c);
  const valid = new Set<string>();
  for (const [gid, sig] of c.sigs) {
    if (valid.size >= need) break;
    if (valid.has(gid) || !Object.prototype.hasOwnProperty.call(keys, gid) || sigNodeId(sig) !== gid) continue;
    const detached = parseDilithiumSig(sig);
    if (!detached) continue;
    let ok = false;
    try { ok = verify(message, detached, keys[gid]); } catch { ok = false; }
    if (ok) valid.add(gid);
    await yieldNow();
  }
  return [...valid];
}

/** Whether at least quorum_size(5) = 4 distinct genesis keys signed the capsule. */
export async function capsuleSigned(c: Capsule, keys: Readonly<Record<string, string>>, verify: VerifySignature): Promise<boolean> {
  const need = quorumSize(Object.keys(keys).length);
  const valid = await capsuleSigners(c, keys, verify);
  if (valid.length < need) console.warn(`[WARN][GALC] capsule_signatures valid=${valid.length} need=${need}`);
  return need > 0 && valid.length >= need;
}

/** The parts of a served proof that bind it to a capsule (exactly these are kept). */
export function rootPartsOf(p: Record<string, unknown>): CapsuleRootParts {
  return {
    index: p.index as number, checkpoint: hashedCheckpointOf(p.checkpoint) as Checkpoint, eligible_raw: p.eligible_raw as string,
    committee: p.committee as string[], banned: (p.banned ?? []) as string[],
  };
}

// The fields checkpointHash reads: a kept root carries these only, never what else a node put in its answer.
const HASHED_CHECKPOINT_FIELDS = ['index', 'parent_qc', 'window_head_height', 'window_mb_hashes', 'state_root', 'beacon',
  'epoch_commitment', 'reward_root', 'registry_root', 'logs_root', 'dilithium_pk_root', 'reward_epoch_root', 'total_supply',
  'timestamp', 'proposer', 'recovery_anchor'];

function hashedCheckpointOf(cp: unknown): unknown {
  if (!isObject(cp)) return cp;
  const out: Record<string, unknown> = {};
  for (const k of HASHED_CHECKPOINT_FIELDS) if (cp[k] !== undefined) out[k] = cp[k];
  if (isObject(cp.parent_qc)) out.parent_qc = { checkpoint_hash: cp.parent_qc.checkpoint_hash, index: cp.parent_qc.index };
  return out;
}

/**
 * Whether `root` (rootPartsOf) is the checkpoint a capsule signed for macroblock j as `cpHash`: { entry }, or
 * { problem }: 'root_shape', 'root_index', 'cp_hash' (another checkpoint), 'recovery_anchor' (refused as every node
 * refuses it), 'epoch_commitment', 'eligible' (no eligible producers).
 */
export function capsuleRootOf(j: number, root: unknown, cpHash: string): { entry: CapsuleEntry } | { problem: string } {
  if (proofShapeProblem(root) !== null || !isObject(root) || !isStringList(root.committee)) return { problem: 'root_shape' };
  const cp = root.checkpoint as Checkpoint;
  if (root.index !== j || Math.floor(Number(cp.window_head_height) / MACROBLOCK_INTERVAL) !== j) return { problem: 'root_index' };
  const hash = checkpointHash(cp);
  if (hash !== cpHash) return { problem: 'cp_hash' };
  if (cp.recovery_anchor) return { problem: 'recovery_anchor' };
  if (![cp.state_root, cp.beacon, cp.registry_root, cp.epoch_commitment].every((h) => typeof h === 'string' && HEX32.test(h))) {
    return { problem: 'root_shape' };
  }
  const eligible = Buffer.from(typeof root.eligible_raw === 'string' ? root.eligible_raw : '', 'hex');
  const banned = isStringList(root.banned) ? root.banned : [];
  if (epochCommitment(eligible, root.committee, banned) !== cp.epoch_commitment) return { problem: 'epoch_commitment' };
  const eligibleIds = decodeEligibleNodeIds(eligible);
  if (eligibleIds.length === 0) return { problem: 'eligible' };
  return {
    entry: {
      stateRoot: cp.state_root, eligibleIds, eligibleRaw: eligible.toString('hex'), beacon: cp.beacon, registryRoot: cp.registry_root,
      checkpointHash: hash,
    },
  };
}

/** The capsule's own fields only, as the store keeps it. */
export function capsuleWire(c: Capsule): Capsule {
  return {
    version: c.version, network_id: c.network_id, mb_index: c.mb_index, mb_hash: c.mb_hash, committee_digest_anchor: c.committee_digest_anchor,
    committee_digest_pred: c.committee_digest_pred, minted_at_height: c.minted_at_height, cp_hash_anchor: c.cp_hash_anchor,
    cp_hash_pred: c.cp_hash_pred, sigs: c.sigs.map(([gid, sig]) => [gid, sig] as [string, string]),
  };
}

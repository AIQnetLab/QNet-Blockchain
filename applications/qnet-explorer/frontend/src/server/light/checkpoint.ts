// The committee-certificate checks of one macroblock, byte for byte as the wallets' light client runs them
// (applications/qnet-mobile/src/crypto/QcLightClient.js, mirroring core/qnet-consensus checkpoint_bft.rs and
// registry_lthash.rs): the checkpoint hash the committee signs, the committee drawn from the eligible set two
// macroblocks below, the registry root that binds the committee's keys, and the epoch commitment that carries the
// eligible set forward. A drift here makes the site refuse every honest checkpoint, never accept a forged one.
import jsSha3 from 'js-sha3';

const { sha3_256, shake256 } = jsSha3;

export const MACROBLOCK_INTERVAL = 90;
const COMMITTEE_THRESHOLD = 1000;
const COMMITTEE_SIZE = 1000;
const DILITHIUM_SIG_LEN = 3309;
const LANES = 1024;
const STATE_BYTES = LANES * 2;
const U64_MAX = 0xffffffffffffffffn;
const ZERO_ROOT = '0'.repeat(64);

export interface ParentQc { checkpoint_hash: string; index: number | string }
export interface Checkpoint {
  index: number | string;
  parent_qc?: ParentQc | null;
  window_head_height: number | string;
  window_mb_hashes?: string[] | null;
  state_root: string;
  beacon: string;
  epoch_commitment: string;
  reward_root: string;
  registry_root: string;
  logs_root?: string | null;
  dilithium_pk_root?: string | null;
  reward_epoch_root?: string | null;
  total_supply: number | string;
  timestamp: number | string;
  proposer: string;
  recovery_anchor?: [number | string, string] | null;
}
export interface MacroblockProof {
  index: number;
  checkpoint: Checkpoint;
  eligible_raw?: string | null;
  banned?: string[] | null;
  committee_pubkeys?: Record<string, string> | null;
  qc?: { signers?: string[]; sigs?: string[] } | null;
}
export interface RegistryEntry {
  node_id: string;
  wallet?: string | null;
  reg_height?: number | string | null;
  reg_index?: number | null;
  node_type?: string | null;
  burn?: string | null;
  vrf_pk_sha3?: string | null;
}

const utf8 = (s: unknown): Buffer => Buffer.from(String(s ?? ''), 'utf8');
const hexToBytes = (hex: unknown): Buffer => (typeof hex === 'string' ? Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex') : Buffer.alloc(0));

function u64le(n: unknown): Buffer {
  const v = typeof n === 'bigint' ? n : BigInt((n as number | string | null | undefined) ?? 0);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v & U64_MAX);
  return b;
}

function u32le(n: unknown): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}

/** quorum_size(n) = n - floor((n - 1) / 3). */
export function quorumSize(n: number): number {
  if (n <= 0) return 0;
  return n - Math.floor((n - 1) / 3);
}

/** Checkpoint::hash, the preimage of every committee vote ("QNET_BFT2_VOTE:" + this hex). */
export function checkpointHash(cp: Checkpoint): string {
  const parts = [utf8('qnet-checkpoint-v2'), u64le(cp.index)];
  if (cp.parent_qc) parts.push(hexToBytes(cp.parent_qc.checkpoint_hash), u64le(cp.parent_qc.index));
  parts.push(u64le(cp.window_head_height));
  for (const mh of cp.window_mb_hashes || []) parts.push(hexToBytes(mh));
  parts.push(hexToBytes(cp.state_root), hexToBytes(cp.beacon), hexToBytes(cp.epoch_commitment), hexToBytes(cp.reward_root),
    hexToBytes(cp.registry_root), hexToBytes(cp.logs_root || ZERO_ROOT), hexToBytes(cp.dilithium_pk_root || ZERO_ROOT),
    hexToBytes(cp.reward_epoch_root || ZERO_ROOT), u64le(cp.total_supply), u64le(cp.timestamp), utf8(cp.proposer));
  // The recovery anchor is folded tagged: 0 for none, 1 then (mb, hash).
  const ra = cp.recovery_anchor;
  if (ra && ra.length === 2) parts.push(Buffer.from([1]), u64le(ra[0]), hexToBytes(ra[1]));
  else parts.push(Buffer.from([0]));
  return sha3_256(Buffer.concat(parts));
}

/** The bar a checkpoint's certificate must meet, or null: a checkpoint carrying a recovery anchor is refused, as every node does. */
export function checkpointQuorum(cp: Checkpoint, committee: string[]): number | null {
  if (cp && cp.recovery_anchor) return null;
  return quorumSize(committee.length);
}

/** The detached ML-DSA-65 signature (hex) inside a node's "dilithium_sig_<node_id>_<base64>" string, or null. */
export function parseDilithiumSig(sigStr: unknown): string | null {
  if (typeof sigStr !== 'string' || !sigStr.startsWith('dilithium_sig_')) return null;
  const pos = sigStr.lastIndexOf('_');
  if (pos <= 13) return null;
  const payload = Buffer.from(sigStr.slice(pos + 1), 'base64');
  if (payload.length < 8) return null;
  const len = payload.readUInt32LE(0);
  if (payload.length < 4 + len) return null;
  const signed = payload.subarray(4, 4 + len);
  if (signed.length < DILITHIUM_SIG_LEN) return null;
  return Buffer.from(signed.subarray(0, DILITHIUM_SIG_LEN)).toString('hex');
}

/** sample_committee: all candidates up to the threshold, else the `size` lowest VRF scores in their original order. */
export function sampleCommittee(sortedCandidates: string[], window: number, seedHex: string,
  threshold = COMMITTEE_THRESHOLD, size = COMMITTEE_SIZE): string[] {
  if (sortedCandidates.length <= threshold) return sortedCandidates.slice();
  const seed = hexToBytes(seedHex);
  const scored = sortedCandidates.map((_, i) => ({ i, score: sha3_256(Buffer.concat([utf8('COMMITTEE_VRF_v3.36'), seed, u64le(window), u64le(i)])) }));
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
  scored.length = size;
  scored.sort((a, b) => a.i - b.i);
  return scored.map((s) => sortedCandidates[s.i]);
}

/** One registry row's LtHash lanes (registry_lthash.rs row_lanes, v4). */
export function ltHashRowLanes(entry: RegistryEntry): Uint16Array {
  const vrf = hexToBytes(entry.vrf_pk_sha3 || '');
  const nodeId = utf8(entry.node_id);
  const wallet = utf8(entry.wallet);
  const burn = utf8(entry.burn || '');
  const nodeType = utf8(entry.node_type || '');
  const seedHex = sha3_256(Buffer.concat([
    utf8('qnet-registry-row-v4'), u32le(nodeId.length), nodeId, u32le(wallet.length), wallet, u64le(entry.reg_height),
    u32le(entry.reg_index || 0), u32le(nodeType.length), nodeType, u32le(burn.length), burn, u32le(vrf.length), vrf,
  ]));
  const stream = Buffer.from(shake256.arrayBuffer(hexToBytes(seedHex), STATE_BYTES * 8));
  const lanes = new Uint16Array(LANES);
  for (let i = 0; i < LANES; i++) lanes[i] = stream[2 * i] | (stream[2 * i + 1] << 8);
  return lanes;
}

function registryRootOf(state: Uint16Array): string {
  const bytes = Buffer.alloc(STATE_BYTES);
  for (let i = 0; i < LANES; i++) { bytes[2 * i] = state[i] & 0xff; bytes[2 * i + 1] = (state[i] >> 8) & 0xff; }
  return sha3_256(Buffer.concat([utf8('qnet-registry-root-v2'), bytes]));
}

/** The registry root over served entries (lanes added with wrap-around). */
export function recomputeRegistryRoot(entries: RegistryEntry[]): string {
  const state = new Uint16Array(LANES);
  for (const e of entries || []) {
    const lanes = ltHashRowLanes(e);
    for (let i = 0; i < LANES; i++) state[i] = (state[i] + lanes[i]) & 0xffff;
  }
  return registryRootOf(state);
}

// The same root, giving the event loop back every 256 entries: a large snapshot never holds up the site's requests.
export async function recomputeRegistryRootYielding(entries: RegistryEntry[]): Promise<string> {
  const state = new Uint16Array(LANES);
  let n = 0;
  for (const e of entries) {
    const lanes = ltHashRowLanes(e);
    for (let i = 0; i < LANES; i++) state[i] = (state[i] + lanes[i]) & 0xffff;
    n += 1;
    if (n % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return registryRootOf(state);
}

/** epoch_commitment over the raw eligible bytes, the committee and the ban list. */
export function epochCommitment(eligibleRaw: Uint8Array, committee: string[], banned: string[]): string {
  const parts = [utf8('qnet-epoch-v2'), u64le(eligibleRaw.length), Buffer.from(eligibleRaw)];
  for (const c of [...committee].sort()) parts.push(utf8(c), Buffer.from([0]));
  parts.push(utf8('banned'), u64le((banned || []).length));
  for (const b of [...(banned || [])].sort()) parts.push(utf8(b), Buffer.from([0]));
  return sha3_256(Buffer.concat(parts));
}

/** The node ids of a bincode Vec<EligibleProducer{node_id: String, reputation: u32}>; [] when malformed. */
export function decodeEligibleNodeIds(raw: Uint8Array): string[] {
  const buf = Buffer.from(raw);
  if (buf.length < 8) return [];
  let off = 0;
  const count = buf.readBigUInt64LE(off); off += 8;
  const ids: string[] = [];
  for (let i = 0n; i < count; i++) {
    if (off + 8 > buf.length) return [];
    const len = buf.readBigUInt64LE(off); off += 8;
    if (BigInt(off) + len + 4n > BigInt(buf.length)) return [];
    const n = Number(len);
    ids.push(buf.subarray(off, off + n).toString('utf8'));
    off += n + 4;
  }
  return ids;
}

const isU64 = (v: unknown): boolean => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER)
  || (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= U64_MAX);
const isOptU64 = (v: unknown): boolean => v === undefined || v === null || isU64(v);
const isOptString = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string';
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why a served registry entry cannot be hashed, or null. */
export function registryEntryProblem(e: unknown): string | null {
  if (!isObject(e)) return 'entry';
  if (typeof e.node_id !== 'string' || !isOptString(e.wallet)) return 'ids';
  if (!isOptU64(e.reg_height)) return 'reg_height';
  const ri = e.reg_index;
  if (!(ri === undefined || ri === null || (Number.isInteger(ri) && (ri as number) >= 0 && (ri as number) <= 0xffffffff))) return 'reg_index';
  if (!isOptString(e.burn) || !isOptString(e.node_type) || !isOptString(e.vrf_pk_sha3)) return 'fields';
  return null;
}

/** Why a served macroblock proof cannot be read, or null: every field the checks hash or walk, of the type they use. */
export function proofShapeProblem(proof: unknown): string | null {
  if (!isObject(proof)) return 'proof';
  if (!Number.isSafeInteger(proof.index) || (proof.index as number) < 0) return 'index';
  const cp = proof.checkpoint;
  if (!isObject(cp)) return 'checkpoint';
  for (const k of ['index', 'window_head_height', 'total_supply', 'timestamp']) if (!isOptU64(cp[k])) return k;
  if (cp.parent_qc !== undefined && cp.parent_qc !== null) {
    const p = cp.parent_qc;
    if (!isObject(p) || typeof p.checkpoint_hash !== 'string' || !isOptU64(p.index)) return 'parent_qc';
  }
  if (!(cp.window_mb_hashes === undefined || cp.window_mb_hashes === null || isStringList(cp.window_mb_hashes))) return 'window_mb_hashes';
  for (const k of ['state_root', 'beacon', 'epoch_commitment', 'reward_root', 'registry_root', 'logs_root', 'dilithium_pk_root',
    'reward_epoch_root', 'proposer']) {
    if (!isOptString(cp[k])) return k;
  }
  const ra = cp.recovery_anchor;
  if (!(ra === undefined || ra === null || (Array.isArray(ra) && ra.length === 2 && isU64(ra[0]) && typeof ra[1] === 'string'))) return 'recovery_anchor';
  if (!isOptString(proof.eligible_raw)) return 'eligible_raw';
  if (!(proof.banned === undefined || proof.banned === null || isStringList(proof.banned))) return 'banned';
  const pks = proof.committee_pubkeys;
  if (!(pks === undefined || pks === null || (isObject(pks) && Object.values(pks).every((v) => typeof v === 'string')))) return 'committee_pubkeys';
  const qc = proof.qc;
  if (!(qc === undefined || qc === null || (isObject(qc) && (qc.signers === undefined || isStringList(qc.signers))
    && (qc.sigs === undefined || isStringList(qc.sigs))))) {
    return 'qc';
  }
  return null;
}

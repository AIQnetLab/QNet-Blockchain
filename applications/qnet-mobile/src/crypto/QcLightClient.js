/**
 * QcLightClient — post-quantum BFT light-client state-root verifier.
 *
 * Replaces the MITM-bypassable 2/3 peer-poll: a balance/reward `state_root` is
 * trusted ONLY when it sits inside a macroblock checkpoint certified by a valid
 * ≥quorum committee QC (ML-DSA-65 / FIPS-204), verified INDUCTIVELY from a
 * binary-pinned trust anchor. No node can forge it without breaking the
 * post-quantum signature or the SHA3/LtHash commitments — trustless at any
 * network size (≤1000 eligible, committee ≤100).
 *
 * Scale (10M wallets): proofs are immutable per macroblock index → cached
 * in-memory + CDN-served; per-QC we verify DISTINCT VALID committee signatures
 * until >= quorum is proven (early-exit; <=quorum≈67 ML-DSA opens worst-case).
 * The committee is derived ONLY from the already-verified M-2 eligible+beacon
 * (anchored via epoch_commitment), never from server-supplied data; the lineage
 * walks the macroblock's parity chain up from the genesis/WS anchor (cached).
 *
 * BYTE-EXACT to the Rust node (checkpoint_bft.rs / registry_lthash.rs /
 * genesis_constants.rs). Any drift here false-rejects honest state.
 */

import { sha3_256, shake256 } from 'js-sha3';
import { Buffer } from 'buffer';
import { verifyDilithium } from './DilithiumCrypto';
import {
  GENESIS_CONSENSUS_PKS,
  GENESIS_NODE_IDS,
  GENESIS_ERA_MAX_INDEX,
  WS_CHECKPOINT,
} from '../config/genesisConsensus';
import { boundedGetJson } from '../utils/boundedFetch';

// ── consensus constants (mirror checkpoint_bft.rs — MUST stay in lockstep with the node) ──
const COMMITTEE_THRESHOLD = 1000; // ≤1000 eligible ⇒ whole set is the committee
const COMMITTEE_SIZE = 1000;      // VRF subsample size when > threshold
const MACROBLOCK_INTERVAL = 90;  // microblocks per macroblock / epoch
const DILITHIUM_SIG_LEN = 3309;  // detached ML-DSA-65 signature bytes
const LANES = 1024;              // LtHash lanes (u16)
const STATE_BYTES = LANES * 2;   // serialized LtHash state

// In-memory cache of verified macroblock proofs, keyed by index → { stateRoot, checkpointHash }.
// Immutable per index; bounds inductive work across repeated balance checks. Bounded (M13): a catch-up walk from an old
// pin verifies thousands of macroblocks, each with its epoch's eligible set, so at most VERIFIED_CACHE_MAX are kept, the
// least recently used going first, never the highest one of either parity chain (later walks start from it). A walk
// needs only the step two below the one it verifies.
const _verifiedCache = new Map();
export const VERIFIED_CACHE_MAX = 64;

function rememberVerified(j, entry) {
  _verifiedCache.delete(j);
  _verifiedCache.set(j, entry);
  if (_verifiedCache.size <= VERIFIED_CACHE_MAX) return;
  const top = [-1, -1];
  for (const k of _verifiedCache.keys()) if (k > top[k % 2]) top[k % 2] = k;
  for (const k of _verifiedCache.keys()) {
    if (_verifiedCache.size <= VERIFIED_CACHE_MAX) break;
    if (k !== j && k !== top[0] && k !== top[1]) _verifiedCache.delete(k);
  }
}

// A verified entry, marked as used now (the LRU order).
function verifiedAt(j) {
  const e = _verifiedCache.get(j);
  if (e) {
    _verifiedCache.delete(j);
    _verifiedCache.set(j, e);
  }
  return e;
}

// Negative cache: "index|node" → { reason, at }. Without it a macroblock this device can never verify is
// re-fetched and re-verified on EVERY balance check — at committee 1000 that is ~501 ML-DSA opens per
// call, forever, and the caller only ever sees `false` with no reason. Keyed by the node that served the
// failing answer, because the cause is usually the SERVED proof (a node that pruned old QC signatures, a
// timeout, a forged answer), not the macroblock: the same step is tried on the other nodes at once, and only
// the node that failed it waits out the short TTL.
const _failedCache = new Map();
const FAIL_TTL_MS = 60_000;

// Macroblocks this device verified in an earlier session (importVerifiedAnchors): index →
// { eligibleIds, beacon, registryRoot }. Like the pin they root a walk; like the pin they carry no
// state_root, so a query at such an index itself is verified again.
const _resumeAnchors = new Map();
const HEX32 = /^[0-9a-f]{64}$/;

// ── weak-subjectivity pin ───────────────────────────────────────────────────
// A non-zero pin MUST carry the derivation anchors for BOTH K and K-1 (one per parity chain). A
// half-filled pin would root one parity and silently leave the other walking from genesis, so it is
// refused outright rather than partially honoured.
export function wsPinIsWellformed() {
  const k = WS_CHECKPOINT.index || 0;
  if (k === 0) return true; // inert: genesis-rooted, anchors unused
  if (k < 2) return false;  // K-1 must itself be a real macroblock
  const a = WS_CHECKPOINT.anchors || {};
  for (const i of [k, k - 1]) {
    const e = a[i];
    if (!e || !e.eligible_raw || !e.beacon || !e.registry_root) return false;
  }
  return true;
}

// Derivation data for a PINNED index, or null. Deliberately NOT seeded into _verifiedCache: the pin
// carries what j+2 needs to derive its committee, but NOT that index's own state_root/logs_root — a
// cache entry would let a state-root query be answered from a value nobody verified.
function pinnedAnchor(j) {
  if (!wsPinIsWellformed()) return null;
  const e = (WS_CHECKPOINT.anchors || {})[j];
  if (!e) return null;
  const ids = decodeEligibleNodeIds(hexToBytes(e.eligible_raw));
  if (!ids.length) return null;
  return { eligibleIds: ids, beacon: e.beacon, registryRoot: e.registry_root, pinned: true };
}

// THE anchor lookup: a macroblock this device verified itself (now or in an earlier session), else a
// binary-pinned one.
function anchorFor(j) {
  return verifiedAt(j) || _resumeAnchors.get(j) || pinnedAnchor(j);
}

// The highest index below `idx` on idx's parity chain that a walk to idx can start from, or -1.
function walkRoot(idx) {
  let best = -1;
  const consider = (j) => {
    if (j < idx && j > best && (idx - j) % 2 === 0 && anchorFor(j)) best = j;
  };
  for (const j of _verifiedCache.keys()) consider(j);
  for (const j of _resumeAnchors.keys()) consider(j);
  const k = WS_CHECKPOINT.index || 0;
  if (k > 0) { consider(k); consider(k - 1); }
  return best;
}

/**
 * The derivation data of the highest macroblock this device has verified on each parity chain, for the
 * caller to keep across sessions under its own integrity protection and hand back to importVerifiedAnchors.
 */
export function exportVerifiedAnchors() {
  const best = new Map();
  for (const [j, e] of [..._resumeAnchors, ..._verifiedCache]) {
    const cur = best.get(j % 2);
    if (!cur || j > cur[0]) best.set(j % 2, [j, e]);
  }
  const out = {};
  for (const [j, e] of best.values()) {
    out[j] = { eligible_ids: e.eligibleIds.slice(), beacon: e.beacon, registry_root: e.registryRoot };
  }
  return out;
}

/**
 * Roots later walks at macroblocks this device verified before (exportVerifiedAnchors), so a restart does
 * not walk again from the pin. Only for anchors the caller kept integrity-protected: an anchor is trusted
 * exactly like the pin. Anything malformed or at or below the pin is ignored. Returns how many were taken.
 */
export function importVerifiedAnchors(anchors) {
  const k = WS_CHECKPOINT.index || 0;
  let taken = 0;
  for (const [key, e] of Object.entries(anchors || {})) {
    const j = Number(key);
    if (!Number.isSafeInteger(j) || j <= k || j < 1) continue;
    if (!e || !Array.isArray(e.eligible_ids) || e.eligible_ids.length === 0
        || !e.eligible_ids.every((id) => typeof id === 'string' && id.length > 0)) continue;
    if (!HEX32.test(String(e.beacon)) || !HEX32.test(String(e.registry_root))) continue;
    _resumeAnchors.set(j, { eligibleIds: e.eligible_ids.slice(), beacon: e.beacon, registryRoot: e.registry_root });
    taken += 1;
  }
  return taken;
}

/**
 * The chain this build trusts, as a short fingerprint of its pinned genesis identities (node id and consensus key of
 * each). Anything kept on the device from chain reads (verified anchors, the last verified balance) carries it, so data
 * of another chain is never taken for this one's.
 */
let _chainIdentity = null;
export function chainIdentity() {
  if (!_chainIdentity) {
    const ids = [...GENESIS_NODE_IDS].sort();
    _chainIdentity = sha3_256(utf8(ids.map((id) => `${id}:${GENESIS_CONSENSUS_PKS[id]}`).join('|'))).slice(0, 32);
  }
  return _chainIdentity;
}

/** The highest macroblock index this device trusts: the pin, or above it one it verified itself. */
export function highestVerifiedIndex() {
  let best = WS_CHECKPOINT.index || 0;
  for (const j of _verifiedCache.keys()) if (j > best) best = j;
  for (const j of _resumeAnchors.keys()) if (j > best) best = j;
  return best;
}

// Lowest index this device can PROVE. Genesis-rooted: 1. Pinned at K: K+1 — K itself is trusted by
// hash, but the pin carries no state_root/logs_root for it, so answering a query at K would mean
// serving a value nobody verified.
export function trustFloorIndex() {
  const k = WS_CHECKPOINT.index || 0;
  return k > 0 ? k + 1 : 1;
}

const failKey = (j, node) => `${j}|${node}`;

function noteFailure(j, node, reason) {
  _failedCache.set(failKey(j, node), { reason, at: Date.now() });
  return null;
}

// The live failure reason for step `j` served by `node`, or null once it has aged out.
function recentFailure(j, node) {
  const key = failKey(j, node);
  const f = _failedCache.get(key);
  if (!f) return null;
  if (Date.now() - f.at >= FAIL_TTL_MS) { _failedCache.delete(key); return null; }
  return f.reason;
}

// The nodes a provider names, in its order: a single URL (older callers) or a list. A provider that throws
// names none.
function nodesFrom(provider) {
  let v;
  try { v = provider(); } catch (_) { return []; }
  const list = Array.isArray(v) ? v : [v];
  return list.filter((u, i) => typeof u === 'string' && u.length > 0 && list.indexOf(u) === i);
}

// ── node reads: a budget per node, and the node's own rate limit ─────────────
// A node admits 300 read-only calls a minute from one address; past that its limiter answers HTTP 200 with
// {"error": "Rate limit exceeded", "retry_after_seconds": n} (a proxy in front of it may answer 429). The light client
// spends at most NODE_READS_PER_MINUTE of them per node, about three a second, leaving the rest to the app's other reads.
// A rate-limit answer is no failure of the node: it is left alone for the time it asks (one second at least, one minute
// at most), never charged and never skipped for the failure TTL.
export const NODE_READS_PER_MINUTE = 180;
const READ_WINDOW_MS = 60_000;
const _nodeReads = new Map();   // base -> times of its reads in the last minute, oldest first
const _nodeBackoff = new Map(); // base -> until when it asked to be left alone

/**
 * Whether a node's answer is its rate limiter's: HTTP 200 with {"error": "Rate limit exceeded", ...} on the older
 * routes, or the certified routes' typed {"proof_format": 2, "error": "rate_limited"} (sent with HTTP 429).
 */
export function isRateLimitBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.error !== 'string') return false;
  return /^rate limit exceeded/i.test(body.error) || (body.proof_format === 2 && body.error === 'rate_limited');
}

function backoffMs(body) {
  const s = Number(body && body.retry_after_seconds);
  return Math.min(60_000, Math.max(1000, Number.isFinite(s) ? s * 1000 : 1000));
}

function recentReads(base, now) {
  const list = _nodeReads.get(base) || [];
  while (list.length && now - list[0] >= READ_WINDOW_MS) list.shift();
  if (list.length) _nodeReads.set(base, list); else _nodeReads.delete(base);
  return list;
}

// Milliseconds until `base` may be read again: 0 now.
function readWait(base, now = Date.now()) {
  const until = _nodeBackoff.get(base) || 0;
  if (until && until <= now) _nodeBackoff.delete(base);
  const list = recentReads(base, now);
  const budget = list.length < NODE_READS_PER_MINUTE ? 0 : list[list.length - NODE_READS_PER_MINUTE] + READ_WINDOW_MS - now;
  return Math.max(0, until - now, budget);
}

// One GET of `base + path`, counted against the node's budget: { body } (any answer but the rate limit's), { limited }
// (the node's rate limit: it is left alone for the time it asks) or { error }. Never throws.
async function nodeGet(base, path, maxBytes, timeoutMs = 10000) {
  const now = Date.now();
  const list = recentReads(base, now);
  list.push(now);
  _nodeReads.set(base, list);
  try {
    const body = await fetchJson(base + path, maxBytes, timeoutMs);
    if (!isRateLimitBody(body)) return { body };
    _nodeBackoff.set(base, Date.now() + backoffMs(body));
  } catch (e) {
    if (!(e && e.message === 'HTTP 429')) return { error: e };
    _nodeBackoff.set(base, Date.now() + backoffMs(null));
  }
  console.warn('[WARN][LIGHT] rate_limited base=' + base);
  return { limited: true };
}

// ── byte helpers ────────────────────────────────────────────────────────────
function u64le(n) {
  // n may exceed 2^53; accept number | bigint | numeric string.
  const v = typeof n === 'bigint' ? n : BigInt(n ?? 0);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v & 0xffffffffffffffffn);
  return b;
}
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}
function hexToBytes(hex) {
  if (typeof hex !== 'string') return Buffer.alloc(0);
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}
function utf8(s) {
  return Buffer.from(String(s ?? ''), 'utf8');
}
function concat(parts) {
  return Buffer.concat(parts);
}

// ── 1. quorum_size(n) = n - floor((n-1)/3) ──────────────────────────────────
export function quorumSize(n) {
  if (n <= 0) return 0;
  const f = Math.floor((n - 1) / 3);
  return n - f;
}

// ── 2. Checkpoint.hash() — SHA3-256 over consensus-critical fields ───────────
// Layout (checkpoint_bft.rs Checkpoint::hash): tag ++ index(u64LE)
//   ++ [parent_qc.checkpoint_hash(32) ++ parent_qc.index(u64LE)]?  ++ window_head_height(u64LE)
//   ++ window_mb_hashes[](32 each) ++ state_root(32) ++ beacon(32) ++ epoch_commitment(32)
//   ++ reward_root(32) ++ registry_root(32) ++ logs_root(32) ++ dilithium_pk_root(32)
//   ++ reward_epoch_root(32)
//   ++ total_supply(u64LE) ++ timestamp(u64LE) ++ proposer.utf8 → 32B hash.
// logs_root is CONSENSUS-ACTIVE from genesis (gate=0): the window's committed event logs (native
// QRC-20/721 transfers + WASM emit_log) merkle-rooted; [0;32] only for a window with no logs.
// dilithium_pk_root (FIX-5): LtHash digest of committed (address->ML-DSA-65 pk) bindings.
// reward_epoch_root: LtHash over certified (epoch, reward root) pairs; hashed AFTER
// dilithium_pk_root, BEFORE total_supply — MUST match checkpoint_bft.rs exactly or every cp is rejected.
// recovery_anchor is the LAST field and is folded TAGGED (0 = absent, 1 ++ mb(u64LE) ++ hash(32)),
// so null can never collide with (0, zeros). The tag byte is written unconditionally — an ordinary
// full-quorum checkpoint hashes a single 0x00, and omitting it here would diverge EVERY checkpoint.
export function checkpointHash(cp) {
  const parts = [utf8('qnet-checkpoint-v2'), u64le(cp.index)];
  if (cp.parent_qc) {
    parts.push(hexToBytes(cp.parent_qc.checkpoint_hash));
    parts.push(u64le(cp.parent_qc.index));
  }
  parts.push(u64le(cp.window_head_height));
  for (const mh of cp.window_mb_hashes || []) parts.push(hexToBytes(mh));
  parts.push(hexToBytes(cp.state_root));
  parts.push(hexToBytes(cp.beacon));
  parts.push(hexToBytes(cp.epoch_commitment));
  parts.push(hexToBytes(cp.reward_root));
  parts.push(hexToBytes(cp.registry_root));
  parts.push(hexToBytes(cp.logs_root || '0'.repeat(64)));
  parts.push(hexToBytes(cp.dilithium_pk_root || '0'.repeat(64)));
  parts.push(hexToBytes(cp.reward_epoch_root || '0'.repeat(64)));
  parts.push(u64le(cp.total_supply));
  parts.push(u64le(cp.timestamp));
  parts.push(utf8(cp.proposer));
  const ra = cp.recovery_anchor;
  if (ra && ra.length === 2) {
    parts.push(Buffer.from([1]));
    parts.push(u64le(ra[0]));
    parts.push(hexToBytes(ra[1]));
  } else {
    parts.push(Buffer.from([0]));
  }
  return sha3_256(concat(parts)); // lowercase hex (32B)
}

// ── checkpoint CONTENT digest (mirror of checkpoint_content_digest) ─────────
// The node's content identity for a checkpoint: everything it COMMITS, with the consensus-position
// fields (index, parent link, proposer) and the recovery anchor excluded, so a legal re-proposal of
// one window at a new index digests identically. Byte-order MUST match the node — the Rust KAT
// (checkpoint_hash_matches_the_mobile_client_byte_for_byte) pins this vector against this mirror.
export function checkpointContentDigest(cp) {
  const parts = [utf8('qnet-checkpoint-content-v2'), u64le(cp.window_head_height)];
  const mbh = cp.window_mb_hashes || [];
  parts.push(u64le(mbh.length));
  for (const mh of mbh) parts.push(hexToBytes(mh));
  parts.push(hexToBytes(cp.state_root));
  parts.push(hexToBytes(cp.beacon));
  parts.push(hexToBytes(cp.epoch_commitment));
  parts.push(hexToBytes(cp.reward_root));
  parts.push(hexToBytes(cp.registry_root));
  parts.push(hexToBytes(cp.logs_root || '0'.repeat(64)));
  parts.push(hexToBytes(cp.dilithium_pk_root || '0'.repeat(64)));
  parts.push(hexToBytes(cp.reward_epoch_root || '0'.repeat(64)));
  parts.push(u64le(cp.total_supply));
  parts.push(u64le(cp.timestamp));
  return sha3_256(concat(parts));
}

// ── QC admission on device ──────────────────────────────────────────────────
// The threshold a checkpoint's certificate must meet, or null to REFUSE the checkpoint outright.
// A recovery anchor is attacker-chosen wire data that used to select a lower bar; the node refuses
// any checkpoint carrying one (RC_ENABLED = false, node.rs v2_rc_disabled / check_content), so a
// device that accepted it would confirm state no full node ever finalized. The bar is ALWAYS strict.
export function checkpointQuorum(cp, committee) {
  if (cp && cp.recovery_anchor) return null;
  return quorumSize(committee.length);
}

// ── 3. Parse the ATTACHED dilithium sig string → detached sig hex ───────────
/**
 * P4: verify a token-transfer inclusion proof against a QC-anchored Checkpoint.logs_root.
 * `proof` = [{hash:<hex>, right:<bool>}] from GET /api/v1/logs/proof — byte-mirror of
 * checkpoint_bft::verify_logs_merkle_proof (sha3 "log-leaf"/"log-node"). The caller MUST first confirm
 * `rootHex` == the logs_root of a checkpoint it QC-verified for [window_start, window_end].
 */
export function verifyLogInclusion(leafHex, proof, rootHex) {
  const bytes = (h) => Buffer.from(String(h || ''), 'hex');
  let cur = sha3_256.create().update(Buffer.from('log-leaf')).update(bytes(leafHex)).hex();
  for (const step of (proof || [])) {
    const h = sha3_256.create().update(Buffer.from('log-node'));
    if (step && step.right) { h.update(bytes(cur)).update(bytes(step.hash)); }
    else { h.update(bytes(step && step.hash)).update(bytes(cur)); }
    cur = h.hex();
  }
  return cur === String(rootHex || '').toLowerCase();
}

/**
 * P4 LEVEL 2 (sharded logs): verify a block sub-root's inclusion in the window logs_root. Byte-mirror of
 * checkpoint_bft::verify_logs_window_proof (sha3 "logw-leaf"/"logw-node", domain-separated from level 1).
 * Pair with verifyLogInclusion (level 1: leaf→block_root) to prove one transfer against a QC-anchored
 * Checkpoint.logs_root — each level touches ONE block, never the whole window.
 */
export function verifyLogWindowInclusion(subRootHex, windowProof, windowRootHex) {
  const bytes = (h) => Buffer.from(String(h || ''), 'hex');
  let cur = sha3_256.create().update(Buffer.from('logw-leaf')).update(bytes(subRootHex)).hex();
  for (const step of (windowProof || [])) {
    const h = sha3_256.create().update(Buffer.from('logw-node'));
    if (step && step.right) { h.update(bytes(cur)).update(bytes(step.hash)); }
    else { h.update(bytes(step && step.hash)).update(bytes(cur)); }
    cur = h.hex();
  }
  return cur === String(windowRootHex || '').toLowerCase();
}

/**
 * P4 leaf-binding: recompute the canonical logs_root leaf for a decoded transfer row — a byte-exact
 * port of node wasm_exec::{encode_transfer_log, log_leaf}. The event JSON is serde_json with SORTED
 * keys (amt,from,kind,std,t,tid,to) and no spaces; leaf = sha3_256(utf8(tx_hash) || u32le(log_index) ||
 * utf8(contract) || 0x00 || utf8(json)), lowercase hex. Binding tx_hash+log_index means the proof commits
 * to the EXACT receipt, so a node can neither ride another transfer's proof NOR replay one real transfer
 * under duplicate/forged tx_hashes. Returns null on a bad row.
 */
export function transferLogLeaf(row) {
  if (!row || typeof row !== 'object') return null;
  const s = (v) => JSON.stringify(v == null ? '' : String(v)); // matches serde_json string escaping (ASCII)
  const json = '{"amt":' + s(row.amount) + ',"from":' + s(row.from) + ',"kind":' + s(row.kind) +
    ',"std":' + s(row.std) + ',"t":"xfer","tid":' + s(row.token_id) + ',"to":' + s(row.to) + '}';
  const li = Buffer.alloc(4);
  li.writeUInt32LE((Number(row.log_index) || 0) >>> 0, 0);
  return sha3_256.create()
    .update(Buffer.from(String(row.tx_hash == null ? '' : row.tx_hash), 'utf8'))
    .update(li)
    .update(Buffer.from(String(row.contract == null ? '' : row.contract), 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(json, 'utf8'))
    .hex();
}

// String: "dilithium_sig_<node_id>_<base64>". base64 decodes to [u32LE signed_msg_len][signed_msg]
//   where signed_msg = [detached_sig(3309)][msg]. We need only the detached sig and ALWAYS verify against
//   the TRUSTED committee pk. QC sigs are pk-compacted node-side (C-2) so there is NO trailing pk; a live
//   identity ping may still carry [u32LE pk_len][pk] which we simply ignore. Never assert a pk trailer's
//   presence — that would false-reject compact QC sigs.
export function parseDilithiumSig(sigStr) {
  if (typeof sigStr !== 'string' || !sigStr.startsWith('dilithium_sig_')) return null;
  const pos = sigStr.lastIndexOf('_'); // base64 alphabet has no '_' → last '_' is the separator
  if (pos <= 13) return null;          // "dilithium_sig" is 13 chars; need a node_id + sep after
  const b64 = sigStr.slice(pos + 1);
  let payload;
  try {
    payload = Buffer.from(b64, 'base64');
  } catch (_) {
    return null;
  }
  if (payload.length < 8) return null;
  const len1 = payload.readUInt32LE(0);
  if (payload.length < 4 + len1) return null;
  const signedMsg = payload.subarray(4, 4 + len1);
  if (signedMsg.length < DILITHIUM_SIG_LEN) return null;
  const detachedSig = signedMsg.subarray(0, DILITHIUM_SIG_LEN);
  return Buffer.from(detachedSig).toString('hex');
}

// ── 4. sample_committee — deterministic VRF subsample (byte-exact) ──────────
// sortedCandidates MUST already be sorted by node_id. ≤threshold ⇒ return all.
// Else score_i = SHA3-256(tag ++ seed(32) ++ window(u64LE) ++ i(u64LE)); take the
// `size` lowest scores (asc), then re-sort the survivors by original index.
export function sampleCommittee(sortedCandidates, window, seedHex, threshold = COMMITTEE_THRESHOLD, size = COMMITTEE_SIZE) {
  if (sortedCandidates.length <= threshold) return sortedCandidates.slice();
  const seed = hexToBytes(seedHex);
  const scored = sortedCandidates.map((_, i) => {
    const score = sha3_256(concat([utf8('COMMITTEE_VRF_v3.36'), seed, u64le(window), u64le(i)]));
    return { i, score };
  });
  // sort by score asc (lowercase-hex compare == byte compare for fixed 64-char hex)
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
  scored.length = size;
  scored.sort((a, b) => a.i - b.i); // re-sort survivors by original index
  return scored.map((s) => sortedCandidates[s.i]);
}

// ── 5a. LtHash per-row lane vector (byte-exact registry_lthash.rs::row_lanes, v4) ─
// vrfPkSha3 is the hex of sha3-256(consensus_pubkey); light/keyless rows pass ''.
export function ltHashRowLanes(entry) {
  const vrfBytes = hexToBytes(entry.vrf_pk_sha3 || '');
  const nodeId = utf8(entry.node_id);
  const wallet = utf8(entry.wallet);
  const burn = utf8(entry.burn || '');
  const nodeType = utf8(entry.node_type || '');
  // v4: reg_index (4-byte LE, NO length prefix — it mirrors reg_height) and a length-prefixed
  // node_type. reg_index is the node's permanent bitmap ordinal; node_type decides light-roster
  // membership, and without it in the preimage a flipped type folded to the SAME root.
  const seedHex = sha3_256(concat([
    utf8('qnet-registry-row-v4'),
    u32le(nodeId.length), nodeId,
    u32le(wallet.length), wallet,
    u64le(entry.reg_height),
    u32le(entry.reg_index || 0),
    u32le(nodeType.length), nodeType,
    u32le(burn.length), burn,
    u32le(vrfBytes.length), vrfBytes,
  ]));
  // SHAKE256(seed) → 2048 bytes → 1024 LE u16 lanes.
  const stream = Buffer.from(shake256.arrayBuffer(hexToBytes(seedHex), STATE_BYTES * 8));
  const lanes = new Uint16Array(LANES);
  for (let i = 0; i < LANES; i++) lanes[i] = stream[2 * i] | (stream[2 * i + 1] << 8);
  return lanes;
}

// ── 5b. recompute registry_root over served entries (byte-exact) ─────────────
// state = 1024 u16 lanes (start 0), component-wise wrapping-add per row, then
// registry_root = SHA3-256(tag ++ state_bytes(2048, u16 LE per lane)).
function registryRootOf(state) {
  const stateBytes = Buffer.alloc(STATE_BYTES);
  for (let i = 0; i < LANES; i++) {
    stateBytes[2 * i] = state[i] & 0xff;
    stateBytes[2 * i + 1] = (state[i] >> 8) & 0xff;
  }
  return sha3_256(concat([utf8('qnet-registry-root-v2'), stateBytes]));
}

export function recomputeRegistryRoot(entries) {
  const state = new Uint16Array(LANES); // wrapping-add is implicit (Uint16Array truncates mod 2^16)
  for (const e of entries || []) {
    const lanes = ltHashRowLanes(e);
    for (let i = 0; i < LANES; i++) state[i] = (state[i] + lanes[i]) & 0xffff;
  }
  return registryRootOf(state);
}

// The same root, yielding to the event loop every REGISTRY_YIELD_EVERY entries (MOBNET-R5-02): each entry costs a
// SHA3, a 2 KiB SHAKE256 and 1024 lane adds, and on the app's JS thread a long snapshot must not hold back taps, the
// auto-lock or the lock on leaving the app.
const REGISTRY_YIELD_EVERY = 256;
const yieldNow = () => new Promise((resolve) => { setTimeout(resolve, 0); });

async function recomputeRegistryRootYielding(entries) {
  const state = new Uint16Array(LANES);
  let n = 0;
  for (const e of entries) {
    const lanes = ltHashRowLanes(e);
    for (let i = 0; i < LANES; i++) state[i] = (state[i] + lanes[i]) & 0xffff;
    n += 1;
    if (n % REGISTRY_YIELD_EVERY === 0) await yieldNow();
  }
  return registryRootOf(state);
}

// A u64 as a node serves it: a non-negative whole number, or its decimal text.
const isU64 = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 18446744073709551615)
  || (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= 18446744073709551615n);
const isOptU64 = (v) => v === undefined || v === null || isU64(v);
const isOptString = (v) => v === undefined || v === null || typeof v === 'string';
const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Why a served registry entry cannot be hashed, or null: every field the row hash reads, of the type it reads. */
function registryEntryProblem(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entry';
  if (typeof e.node_id !== 'string' || !isOptString(e.wallet)) return 'ids';
  if (!isOptU64(e.reg_height)) return 'reg_height';
  if (!(e.reg_index === undefined || e.reg_index === null || (Number.isInteger(e.reg_index) && e.reg_index >= 0 && e.reg_index <= 0xffffffff))) {
    return 'reg_index';
  }
  if (!isOptString(e.burn) || !isOptString(e.node_type) || !isOptString(e.vrf_pk_sha3)) return 'fields';
  return null;
}

/**
 * Why a served macroblock proof cannot even be read, or null (MOBNET-R5-01): every field verifyOne hashes or walks,
 * of the type it uses, so a malformed answer is that node's failure and never an exception that ends the walk.
 */
export function proofShapeProblem(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return 'proof';
  if (!Number.isSafeInteger(proof.index) || proof.index < 0) return 'index';
  const cp = proof.checkpoint;
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) return 'checkpoint';
  for (const k of ['index', 'window_head_height', 'total_supply', 'timestamp']) if (!isOptU64(cp[k])) return k;
  if (cp.parent_qc !== undefined && cp.parent_qc !== null) {
    const p = cp.parent_qc;
    if (typeof p !== 'object' || Array.isArray(p) || typeof p.checkpoint_hash !== 'string' || !isOptU64(p.index)) return 'parent_qc';
  }
  if (!(cp.window_mb_hashes === undefined || cp.window_mb_hashes === null || isStringList(cp.window_mb_hashes))) return 'window_mb_hashes';
  for (const k of ['state_root', 'beacon', 'epoch_commitment', 'reward_root', 'registry_root', 'logs_root',
    'dilithium_pk_root', 'reward_epoch_root', 'proposer']) {
    if (!isOptString(cp[k])) return k;
  }
  const ra = cp.recovery_anchor;
  if (!(ra === undefined || ra === null || (Array.isArray(ra) && ra.length === 2 && isU64(ra[0]) && typeof ra[1] === 'string'))) {
    return 'recovery_anchor';
  }
  if (!isOptString(proof.eligible_raw)) return 'eligible_raw';
  if (!(proof.banned === undefined || proof.banned === null || isStringList(proof.banned))) return 'banned';
  const pks = proof.committee_pubkeys;
  if (!(pks === undefined || pks === null || (typeof pks === 'object' && !Array.isArray(pks)
      && Object.values(pks).every((v) => typeof v === 'string')))) {
    return 'committee_pubkeys';
  }
  const qc = proof.qc;
  if (!(qc === undefined || qc === null || (typeof qc === 'object' && !Array.isArray(qc)
      && (qc.signers === undefined || isStringList(qc.signers)) && (qc.sigs === undefined || isStringList(qc.sigs))))) {
    return 'qc';
  }
  return null;
}

// ── epoch_commitment (byte-exact checkpoint_bft.rs::epoch_commitment) ────────
// Binds this macroblock's epoch-transition data into the QC-signed checkpoint:
// tag ++ u64LE(len raw eligible bytes) ++ raw eligible bytes ++ for each sorted committee id:
// id.utf8 ++ 0x00 ++ b"banned" ++ u64LE(count banned) ++ for each sorted banned id: id.utf8 ++ 0x00.
export function epochCommitment(eligibleRawBytes, committee, banned) {
  const parts = [utf8('qnet-epoch-v2'), u64le(eligibleRawBytes.length), Buffer.from(eligibleRawBytes)];
  for (const c of [...committee].sort()) { parts.push(utf8(c)); parts.push(Buffer.from([0])); }
  parts.push(utf8('banned'));
  parts.push(u64le((banned || []).length));
  for (const b of [...(banned || [])].sort()) { parts.push(utf8(b)); parts.push(Buffer.from([0])); }
  return sha3_256(concat(parts));
}

// ── bincode decoder: Vec<EligibleProducer{node_id:String, reputation:u32}> ───
// bincode default = fixint LE, u64 lengths. Returns the node_id list (the VRF candidate set).
export function decodeEligibleNodeIds(eligibleRawBytes) {
  const buf = Buffer.from(eligibleRawBytes);
  if (buf.length < 8) return [];
  let off = 0;
  const count = Number(buf.readBigUInt64LE(off)); off += 8;
  const ids = [];
  for (let i = 0; i < count; i++) {
    if (off + 8 > buf.length) return [];
    const slen = Number(buf.readBigUInt64LE(off)); off += 8;
    if (off + slen + 4 > buf.length) return [];
    ids.push(buf.subarray(off, off + slen).toString('utf8')); off += slen + 4; // +4 = u32 reputation
  }
  return ids;
}

// ── QC signature verification (FULL — proves quorum, no sampling) ────────────
// Counts DISTINCT VALID committee-member signatures over the canonical vote message until the quorum is proven.
// pubkeysByNode: node_id → pk_hex to verify against (genesis map, registry-bound keys, or the keys a proof served,
// which the caller binds to the registry afterwards). { ok, valid: Set of the signers counted }.
// A QC listing more signers than the committee has members, or one signer twice, is refused before any signature is
// verified, and each signer is tried once at most, valid or not (R5-EXTQ-04): at most committee-size ML-DSA opens.
async function verifyQcFull(qc, committee, pubkeysByNode, checkpointHashHex, quorum) {
  // The threshold is CALLER-supplied for the same reason as on the node: a certificate must never
  // choose its own bar.
  const q = quorum == null ? quorumSize(committee.length) : quorum;
  const refused = { ok: false, valid: new Set() };
  if (q === 0) return refused;
  const signers = Array.isArray(qc.signers) ? qc.signers : [];
  const sigs = Array.isArray(qc.sigs) ? qc.sigs : [];
  if (signers.length !== sigs.length) {
    console.warn('[WARN][QC] len_mismatch signers=' + signers.length + ' sigs=' + sigs.length);
    return refused;
  }
  if (signers.length > committee.length || new Set(signers).size !== signers.length) {
    console.warn('[WARN][QC] signers_refused listed=' + signers.length + ' committee=' + committee.length);
    return refused;
  }
  const committeeSet = new Set(committee);
  const message = 'QNET_BFT2_VOTE:' + checkpointHashHex;
  // No sampling: sampling cannot PROVE quorum (it can miss invalid sigs among claimed signers). Verify until >= quorum
  // valid are found (early exit on a healthy QC), else reject.
  const validDistinct = new Set();
  const attempted = new Set();
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    if (typeof signer !== 'string' || !committeeSet.has(signer) || attempted.has(signer)) continue;
    const pkHex = pubkeysByNode[signer];
    if (typeof pkHex !== 'string' || !pkHex) continue;
    const detachedSigHex = parseDilithiumSig(sigs[i]);
    if (!detachedSigHex) continue;
    attempted.add(signer);
    let ok = false;
    try { ok = await verifyDilithium(message, detachedSigHex, pkHex); } catch (_) { ok = false; }
    if (ok) validDistinct.add(signer);
    if (validDistinct.size >= q) break;
  }
  if (validDistinct.size < q) {
    console.warn('[ERR][QC] below_quorum valid=' + validDistinct.size + ' need=' + q + ' committee=' + committee.length);
    return { ok: false, valid: validDistinct };
  }
  console.log('[DBG] qc_full_ok valid=' + validDistinct.size + ' quorum=' + q);
  return { ok: true, valid: validDistinct };
}

// ── trusted pubkeys for a macroblock's committee ────────────────────────────
// Genesis era (index < 3): committee = the 5 genesis ids, keys from the embedded
// map. Epoch ≥ 3: derive committee via sampleCommittee over the ALREADY-VERIFIED j-2
// eligible_producers + beacon, then bind each served pubkey to the ALREADY-VERIFIED j-2
// registry_root. Both the ids and the keys are therefore rooted in a certified ancestor.
//
// `anchorRoot` / `anchorHeight` MUST come from a checkpoint this device already verified, never
// from `cp`. Binding to cp.registry_root was circular: cp is the very object whose QC is being
// authenticated, so a server answering both the proof and the registry endpoint could mint
// keypairs for the (publicly derivable) committee ids, publish entries whose vrf_pk_sha3 matched
// them, set cp.registry_root to that set's root, and sign a forged state_root with its own keys —
// every check passed by construction. Every member of committee_j is drawn from eligible_of(j-2)
// and so is registered at or below (j-2)*90, which is exactly what the j-2 root covers.
//
// Missing or unbindable members are SKIPPED, not fatal: verifyQcFull needs `quorum` distinct valid
// signatures and already tolerates a per-signer gap, so demanding a key for every derived member
// only ever turns a verifiable macroblock into a dead one — and the walk is bottom-up, so one dead
// index kills every higher index on that parity chain. A skipped key cannot help an attacker; it
// strictly reduces the set of signatures that can count toward quorum.
// Registry snapshots already bound to a certified root, by that root (MOBNET-R3-06): node_id -> vrf_pk_sha3 only.
// Consecutive macroblocks share a registry root until a registration or removal lands between them, so a walk
// downloads and hashes a snapshot once per root instead of once per step. The last few roots are kept.
const REGISTRY_CACHE_ROOTS = 4;
const _registryByRoot = new Map();

function rememberRegistry(root, pkShaByNode) {
  _registryByRoot.delete(root);
  _registryByRoot.set(root, pkShaByNode);
  while (_registryByRoot.size > REGISTRY_CACHE_ROOTS) _registryByRoot.delete(_registryByRoot.keys().next().value);
}

// Entries a registry snapshot may hold before it is refused unread (MOBNET-R5-02): with the byte bound alone, a
// snapshot of minimal entries would cost minutes of hashing. A snapshot above it is `oversized`.
export const REGISTRY_MAX_ENTRIES = 100_000;

// Why a registry snapshot fetched at `anchorHeight` is not the one whose LtHash root is `anchorRoot`: 'malformed',
// 'oversized' or 'mismatch'; null when it is that one (hashed in yielding chunks).
async function registryProblem(registry, anchorRoot, anchorHeight) {
  if (!registry || !Array.isArray(registry.entries)) {
    console.warn('[WARN][REGISTRY] malformed height=' + anchorHeight);
    return 'malformed';
  }
  if (registry.entries.length > REGISTRY_MAX_ENTRIES) {
    console.warn('[WARN][REGISTRY] oversized height=' + anchorHeight + ' entries=' + registry.entries.length);
    return 'oversized';
  }
  if (registry.entries.some((e) => registryEntryProblem(e) !== null)) {
    console.warn('[WARN][REGISTRY] malformed_entry height=' + anchorHeight);
    return 'malformed';
  }
  if ((await recomputeRegistryRootYielding(registry.entries)) !== anchorRoot) {
    console.warn('[ERR][REGISTRY] root_mismatch height=' + anchorHeight);
    return 'mismatch';
  }
  return null;
}

// { map: node_id -> vrf_pk_sha3 } of the registry whose LtHash root is `anchorRoot`: from the cache, or fetched at
// `anchorHeight` and bound to the root first; else { reason }: 'unavailable' (not fetched), 'malformed', 'oversized',
// 'mismatch'. `registryFetch(height, accept)` may try several nodes and keep the first snapshot `accept` (an async
// check that answers a problem or null) takes, so one node's wrong snapshot never stands for the rest (M13).
async function registryAt(anchorRoot, anchorHeight, registryFetch) {
  const cached = _registryByRoot.get(anchorRoot);
  if (cached) {
    rememberRegistry(anchorRoot, cached);
    return { map: cached };
  }
  const bound = new WeakSet();
  const accept = async (snapshot) => {
    const problem = await registryProblem(snapshot, anchorRoot, anchorHeight);
    if (!problem && snapshot && typeof snapshot === 'object') bound.add(snapshot);
    return problem;
  };
  let registry;
  try {
    registry = await registryFetch(anchorHeight, accept);
  } catch (e) {
    if (e && typeof e.registryProblem === 'string') return { reason: e.registryProblem };
    console.warn('[WARN][REGISTRY] fetch_failed height=' + anchorHeight + ' err=' + (e && e.message));
    return { reason: e && e.code === 'RESPONSE_TOO_LARGE' ? 'oversized' : 'unavailable' };
  }
  const problem = registry && typeof registry === 'object' && bound.has(registry) ? null : await accept(registry);
  if (problem) return { reason: problem };
  const pkShaByNode = new Map();
  for (const e of registry.entries) {
    if (typeof e.vrf_pk_sha3 === 'string' && e.vrf_pk_sha3) pkShaByNode.set(e.node_id, e.vrf_pk_sha3);
  }
  rememberRegistry(anchorRoot, pkShaByNode);
  return { map: pkShaByNode };
}

// The SHA3-256 of each committee key seen, by node id: consecutive steps share most of their committee, and a
// 1952-byte key costs a SHA3 on the JS thread at every step otherwise. The key itself is compared, so a node whose key
// changed is hashed again. The oldest go first past PK_SHA_CACHE_MAX.
const PK_SHA_CACHE_MAX = 2048;
const _pkSha = new Map(); // node_id -> { pkHex, sha }

function pkSha3(nodeId, pkHex) {
  const kept = _pkSha.get(nodeId);
  if (kept && kept.pkHex === pkHex) return kept.sha;
  const sha = sha3_256(hexToBytes(pkHex));
  _pkSha.delete(nodeId);
  _pkSha.set(nodeId, { pkHex, sha });
  while (_pkSha.size > PK_SHA_CACHE_MAX) _pkSha.delete(_pkSha.keys().next().value);
  return sha;
}

// The keys of `keys` (node_id -> pk hex) whose SHA3 the certified registry holds for that node.
function boundKeys(committee, keys, pkShaByNode) {
  const pubkeys = {};
  for (const nodeId of committee) {
    const pkHex = keys[nodeId];
    const pkSha = pkShaByNode.get(nodeId);
    if (typeof pkHex !== 'string' || !pkHex || !pkSha) continue;
    if (pkSha3(nodeId, pkHex) !== pkSha) {
      console.warn('[ERR][REGISTRY] pk_sha3_mismatch node=' + nodeId);
      continue;
    }
    pubkeys[nodeId] = pkHex;
  }
  return pubkeys;
}

export async function resolvePubkeys(committee, anchorRoot, anchorHeight, servedPubkeys, registryFetch, needed) {
  const reg = await registryAt(anchorRoot, anchorHeight, registryFetch);
  if (!reg.map) return null;
  const pubkeys = boundKeys(committee, servedPubkeys || {}, reg.map);
  const bound = Object.keys(pubkeys).length;
  // Cheap pre-check only: verifyQcFull enforces the real threshold on VALID signatures. `needed` is
  // the threshold THIS checkpoint is judged at, supplied by the caller so no callee picks its own bar.
  if (bound < needed) {
    console.warn('[WARN][REGISTRY] bound_below_threshold bound=' + bound + ' need=' + needed + ' committee=' + committee.length);
    return null;
  }
  return pubkeys;
}

// ── fetch a macroblock proof / registry from a bootstrap node ───────────────
// Read-pool endpoints serve these, so every answer has a size bound (MOBNET-R2-06): an oversized one is a failure of
// that node, never an allocation the phone must survive. The bounds leave room for a committee's QC (a quorum of
// 3309-byte signatures, hex) and the eligible set of a large network.
export const PROOF_MAX_BYTES = 8 * 1024 * 1024;
export const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;

function fetchJson(url, maxBytes, timeoutMs = 10000) {
  return boundedGetJson(url, { timeoutMs, maxBytes });
}

// Verify a single macroblock j from its fetched proof. Committee = genesis-pinned (genesis era) OR
// sample_committee over the VERIFIED j-2 eligible+beacon from cache (NOT server-supplied). Verify the
// QC in full, then anchor j's OWN eligible+banned via the QC-signed epoch_commitment. Caches
// {stateRoot, checkpointHash, eligibleIds, beacon} so j+2 derives its committee from this.
// Returns { entry } or { reason } (the served proof failed), { reason, blameless: true } (the registry, not this
// node's answer, could not be had), or { transient: true } (nothing about j or the node).
async function verifyOne(j, proof, registryFetch) {
  const fail = (reason) => ({ reason });
  const shape = proofShapeProblem(proof);
  if (shape) {
    console.warn('[WARN][LIGHT] proof_malformed j=' + j + ' field=' + shape);
    return fail('proof_malformed');
  }
  const cp = proof.checkpoint;
  if (proof.index !== j || Math.floor((cp.window_head_height || 0) / MACROBLOCK_INTERVAL) !== j) {
    console.warn('[ERR][LIGHT] index_or_head_mismatch j=' + j + ' idx=' + proof.index + ' whh=' + cp.window_head_height);
    return fail('index_or_head_mismatch');
  }
  let committee, pubkeys = null, anchor = null;
  if (j < GENESIS_ERA_MAX_INDEX) {
    committee = GENESIS_NODE_IDS.slice();
    pubkeys = { ...GENESIS_CONSENSUS_PKS };
  } else {
    anchor = anchorFor(j - 2); // verified by the walk, or the binary WS pin at the root
    if (!anchor || !Array.isArray(anchor.eligibleIds) || !anchor.beacon) {
      // NOT cached: this is a consequence of an earlier step in THIS walk failing, not a fact about
      // j. Recording it would suppress j's own retry once the earlier step recovers.
      console.warn('[WARN][LINEAGE] anchor_missing j=' + j + ' need=' + (j - 2));
      return { transient: true };
    }
    // VRF window = the epoch, which is DETERMINISTICALLY the macroblock index j ((j*90-1)/90+1 == j) —
    // derive it from j (already bound via window_head_height/90==j), NEVER from the server-supplied
    // proof.epoch (an unbound seed would let an attacker grind the committee subset).
    committee = sampleCommittee([...anchor.eligibleIds].sort(), j, anchor.beacon);
  }
  const cpHash = checkpointHash(cp); // recompute, never trust a served hash
  // Refuse a checkpoint carrying a recovery anchor, exactly as every full node does. The bar is the
  // strict quorum over the committee derived above; nothing on the wire may lower it.
  const quorum = checkpointQuorum(cp, committee);
  if (quorum == null) {
    console.warn('[ERR][LIGHT] rc_pin_refused j=' + j);
    return fail('rc_pin_refused');
  }
  if (pubkeys) {
    if (!(await verifyQcFull(proof.qc || {}, committee, pubkeys, cpHash, quorum)).ok) {
      console.warn('[ERR][LIGHT] qc_invalid j=' + j);
      return fail('qc_invalid');
    }
  } else {
    if (!anchor.registryRoot) return fail('anchor_registry_root_missing');
    // The committee's keys are bound to the certified j-2 registry before any signature is checked (MOBNET-R5-02). The
    // snapshot comes from the nodes the caller names for it (the genesis names in the app), never necessarily from the
    // node that served this proof; it is bounded in entries, hashed in chunks that yield, and kept per root, so a walk
    // hashes it once per root, and a key the proof served that the registry does not hold costs no signature check.
    // A snapshot that cannot be had is not this node's answer failing (`blameless`).
    const reg = await registryAt(anchor.registryRoot, (j - 2) * MACROBLOCK_INTERVAL, registryFetch);
    if (!reg.map) return { reason: 'registry_' + reg.reason, blameless: true };
    pubkeys = boundKeys(committee, proof.committee_pubkeys || {}, reg.map);
    if (Object.keys(pubkeys).length < quorum) {
      console.warn('[WARN][REGISTRY] bound_below_threshold j=' + j + ' need=' + quorum + ' committee=' + committee.length);
      return fail('pubkeys_unresolved');
    }
    if (!(await verifyQcFull(proof.qc || {}, committee, pubkeys, cpHash, quorum)).ok) {
      console.warn('[ERR][LIGHT] qc_invalid j=' + j);
      return fail('qc_invalid');
    }
  }
  // Anchor j's epoch-transition data: recompute epoch_commitment over the served raw eligible bytes +
  // the (derived) committee + served banned; it MUST equal the QC-signed cp.epoch_commitment. This
  // proves the served eligible_raw is genuine before we carry it forward to derive j+2's committee.
  const eligibleBytes = hexToBytes(proof.eligible_raw || '');
  if (epochCommitment(eligibleBytes, committee, proof.banned || []) !== cp.epoch_commitment) {
    console.warn('[ERR][LIGHT] epoch_commitment_mismatch j=' + j);
    return fail('epoch_commitment_mismatch');
  }
  // registryRoot is retained because j+2 binds its committee's pubkeys to it. It is certified: the QC
  // over cpHash, which folds registry_root, has just been verified.
  const entry = { stateRoot: cp.state_root, logsRoot: cp.logs_root, checkpointHash: cpHash, eligibleIds: decodeEligibleNodeIds(eligibleBytes), beacon: cp.beacon, registryRoot: cp.registry_root };
  rememberVerified(j, entry);
  console.log('[INFO][LIGHT] macroblock_verified j=' + j + ' committee=' + committee.length);
  return { entry };
}

// The first answer of `nodes` for `path` that `accept` takes (an async check answering a problem or null), trying them
// in order; without `accept`, the first answer. When every answer came and was refused, the error names the last
// problem (`registryProblem`).
async function fetchFirst(nodes, path, maxBytes, accept = null) {
  let last = null;
  for (const base of nodes) {
    const got = await nodeGet(base, path, maxBytes);
    if (!('body' in got)) {
      last = got.error || new Error('Rate limited');
      continue;
    }
    const answer = got.body;
    const problem = accept ? await accept(answer) : null;
    if (!problem) return answer;
    last = Object.assign(new Error('Refused ' + problem), { registryProblem: problem });
  }
  throw last || new Error('no node');
}

// One step of a walk: macroblock j, from the first node in order that serves a proof which verifies. A node
// whose answer fails (unreachable, pruned, malformed, forged — including one whose fields make the check throw,
// MOBNET-R5-01) is skipped for this step for FAIL_TTL_MS and reported to `hooks.onNodeFailure`; the next node is asked
// at once. A registry snapshot that could not be had is no failure of the proof's node: the step is skipped on it
// for the TTL, but its health is not charged. `hooks.registryNodes()` names the nodes registry snapshots are read from
// (the app: the genesis names); without it, the step's own nodes. `tally.refused` counts the nodes whose proof arrived
// and was refused by a check that ties it to the anchor below (LINEAGE_REFUSALS).
// `ahead`: the step's proof already fetched from the node it asks first (fetchAhead), used before any other node.
// `target`: j is the macroblock the walk is for. A node answering that it holds no such macroblock yet
// (macroblock_not_found: it is certified some blocks after its height) is not charged, and the step passes to the
// next node, NOT_FOUND_MORE_NODES more at most: one lagging or hostile node cannot hold back a macroblock the others
// serve. Only then (or when no node is left) the step ends as not yet certified. A node at its read budget is waited
// for (STEP_WAIT_MAX_MS at most); one that answered with its rate limit is not asked again in this step and not
// charged.
// Returns a STEP outcome.
const STEP = { VERIFIED: 'verified', FAILED: 'failed', TRANSIENT: 'transient', NOT_CERTIFIED: 'not_certified' };
const STEP_WAIT_MAX_MS = 2000;
export const NOT_FOUND_MORE_NODES = 2;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const proofPath = (j) => '/api/v1/macroblock/' + j + '/proof';
const notCertifiedYet = (body) => !!body && typeof body === 'object' && body.error === 'macroblock_not_found';
// Targets the nodes said are not certified yet: index -> when. Lets a caller tell "not certified yet" from a walk
// that failed; read within FAIL_TTL_MS.
const _notCertified = new Map();

function notCertifiedRecently(j) {
  const at = _notCertified.get(j);
  if (at === undefined) return false;
  if (Date.now() - at >= FAIL_TTL_MS) { _notCertified.delete(j); return false; }
  return true;
}

async function verifyStep(j, nodesProvider, hooks, tally = null, ahead = null, target = false) {
  const nodes = nodesFrom(nodesProvider);
  const failed = (base, reason, blame = true) => {
    noteFailure(j, base, reason);
    if (blame && hooks && typeof hooks.onNodeFailure === 'function') {
      try { hooks.onNodeFailure(base, reason); } catch (_) { /* reporting never stops the walk */ }
    }
  };
  const registryNodes = hooks && typeof hooks.registryNodes === 'function' ? nodesFrom(hooks.registryNodes) : null;
  const tried = new Set();
  let asked = 0;
  let limited = 0;
  let notFound = 0;
  let first = ahead && !recentFailure(j, ahead.base) ? ahead : null;
  for (;;) {
    let base;
    let got;
    if (first) {
      ({ base } = first);
      got = await first.answer;
      const capped = Number.isSafeInteger(first.share) && first.share < PROOF_MAX_BYTES;
      first = null;
      // Fetched ahead under its share of the walk's byte budget and larger than that: asked again now with the full
      // bound, never charged for it.
      if (capped && got.error && got.error.code === 'RESPONSE_TOO_LARGE') got = await nodeGet(base, proofPath(j), PROOF_MAX_BYTES);
    } else {
      const now = Date.now();
      const open = nodes.filter((u) => !tried.has(u) && !recentFailure(j, u));
      if (open.length === 0) break;
      base = open.find((u) => readWait(u, now) === 0);
      if (!base) {
        const wait = Math.min(...open.map((u) => readWait(u, now)));
        if (wait > STEP_WAIT_MAX_MS) {
          console.warn('[WARN][LIGHT] walk_paused j=' + j + ' (every node at its read budget)');
          return STEP.TRANSIENT;
        }
        await sleep(wait);
        continue;
      }
      got = await nodeGet(base, proofPath(j), PROOF_MAX_BYTES);
    }
    tried.add(base);
    if (got.limited) {
      limited += 1;
      continue;
    }
    asked += 1;
    if (got.error) {
      const e = got.error;
      console.warn('[WARN][LIGHT] proof_fetch_failed j=' + j + ' err=' + (e && e.message));
      failed(base, e && e.code === 'RESPONSE_TOO_LARGE' ? 'oversized' : 'proof_fetch_failed');
      continue;
    }
    const proof = got.body;
    if (target && notCertifiedYet(proof)) {
      notFound += 1;
      if (notFound > NOT_FOUND_MORE_NODES) break;
      console.log('[INFO][LIGHT] not_found_next_node j=' + j + ' base=' + base);
      continue;
    }
    if (!proof || !proof.checkpoint || typeof proof.index !== 'number') {
      console.warn('[WARN][LIGHT] proof_malformed j=' + j);
      failed(base, 'proof_malformed');
      continue;
    }
    // The registry snapshot is bound to a certified root; it is read from the nodes named for it, else this step's.
    const from = registryNodes && registryNodes.length > 0 ? registryNodes : [base, ...nodes.filter((u) => u !== base)];
    const registryFetch = (height, accept) => fetchFirst(from, '/api/v1/registry/height/' + height, REGISTRY_MAX_BYTES, accept);
    let r;
    try {
      r = await verifyOne(j, proof, registryFetch);
    } catch (e) {
      // Whatever an answer makes the check throw on is that answer's failure, never the end of the walk.
      console.warn('[WARN][LIGHT] proof_threw j=' + j + ' err=' + (e && e.message));
      r = { reason: 'proof_malformed' };
    }
    if (r.entry) {
      _notCertified.delete(j);
      if (hooks && typeof hooks.onProgress === 'function') {
        try { hooks.onProgress(j); } catch (_) { /* keeping progress never stops the walk */ }
      }
      return STEP.VERIFIED;
    }
    if (r.transient) return STEP.TRANSIENT;
    if (tally && LINEAGE_REASONS.has(r.reason)) tally.refused += 1;
    failed(base, r.reason, !r.blameless);
  }
  if (notFound > 0) {
    console.log('[INFO][LIGHT] not_yet_certified j=' + j + ' nodes=' + notFound);
    _notCertified.set(j, Date.now());
    return STEP.NOT_CERTIFIED;
  }
  if (asked === 0 && limited > 0) return STEP.TRANSIENT;
  if (asked === 0) console.warn('[WARN][LIGHT] walk_halted j=' + j + ' (every node failed it recently; retries after TTL)');
  return STEP.FAILED;
}

// The proof of step j fetched now, ahead of its turn, from the node the step would ask first (not failed on it within
// the TTL, within its read budget), bounded to `share` bytes: { base, share, answer (the promise of nodeGet's result),
// bytes (its size once it arrived) }, or null when no node is free now (the step then fetches it itself).
function fetchAhead(j, nodesProvider, share = PROOF_MAX_BYTES) {
  const now = Date.now();
  const base = nodesFrom(nodesProvider).find((u) => !recentFailure(j, u) && readWait(u, now) === 0);
  if (!base) return null;
  const entry = { base, share, bytes: null, answer: null };
  entry.answer = nodeGet(base, proofPath(j), share).then((got) => {
    if (got && got.body) entry.bytes = proofBytes(got.body);
    return got;
  });
  return entry;
}

// ── the walk's memory: proofs in flight bounded by bytes ─────────────────────
// A proof carries a quorum of 3309-byte signatures and the committee's keys: about 7 MB at a 1000-member committee.
// Proofs fetched ahead are bounded by WALK_INFLIGHT_BYTES in all (hooks.prefetchBytes sets another bound), each
// reserving its share: twice the size expected for the committee of the walk's anchor or the largest proof the walk
// received, PREFETCH_SHARE_MIN at least and PROOF_MAX_BYTES at most. A proof fetched ahead that is larger than its
// share is fetched again by its step with the full bound.
export const WALK_INFLIGHT_BYTES = 16 * 1024 * 1024;
export const PREFETCH_SHARE_MIN = 512 * 1024;
const PROOF_BASE_BYTES = 16 * 1024;
const PROOF_BYTES_PER_MEMBER = 7680; // a key (3904 hex), a signature (about 4.5 KB base64) for 2 of 3, its id

/** The bytes a served macroblock proof takes, from the fields that grow with the committee. */
export function proofBytes(proof) {
  if (!proof || typeof proof !== 'object') return 0;
  let n = 1024;
  const add = (v) => { if (typeof v === 'string') n += v.length; };
  const each = (list) => { if (Array.isArray(list)) list.forEach(add); };
  add(proof.eligible_raw);
  each(proof.banned);
  if (proof.qc && typeof proof.qc === 'object') { each(proof.qc.sigs); each(proof.qc.signers); }
  const pks = proof.committee_pubkeys;
  if (pks && typeof pks === 'object') for (const [k, v] of Object.entries(pks)) { add(k); add(v); }
  if (proof.checkpoint && typeof proof.checkpoint === 'object') each(proof.checkpoint.window_mb_hashes);
  return n;
}

/** The bytes one proof fetched ahead reserves, for a committee of `members` and the largest proof seen. */
export function prefetchShareBytes(members, largestSeen = 0) {
  const expected = PROOF_BASE_BYTES + Math.min(Math.max(0, members), COMMITTEE_SIZE) * PROOF_BYTES_PER_MEMBER;
  return Math.min(PROOF_MAX_BYTES, Math.max(PREFETCH_SHARE_MIN, 2 * Math.max(expected, largestSeen)));
}

// One walk at a time per parity chain (MOBNET-R2-05): a caller that finds one running waits for it and takes what
// it verified, instead of starting a second walk through the same steps. A walk verifies at most
// WALK_STEPS_PER_CALL steps; what it verified is kept, and the next call resumes from there.
export const WALK_STEPS_PER_CALL = 64;
const _walks = new Map(); // parity -> the walk running now
// Proofs a walk keeps in flight: the step being verified and the ones after it, each fetched at once from the node it
// asks first (the app names a read-pool node first, drawn per step, so they spread over the pool). They are still
// verified strictly in order, each against the anchor the step before it verified; a fetched proof is never trusted
// for being there. `hooks.prefetch` sets another depth (1: one proof at a time). Their bytes are bounded too
// (WALK_INFLIGHT_BYTES): at a large committee fewer are kept in flight.
export const WALK_PREFETCH = 5;

// Refusals that tie a step to the anchor below it: the committee derived from that anchor did not sign it, its keys do
// not bind to that anchor's registry, or no node holds that anchor's registry at all. A fetch that failed, an answer too
// large, a malformed one or a registry no node served say nothing about the anchor and are not counted.
const LINEAGE_REASONS = new Set(['qc_invalid', 'pubkeys_unresolved', 'epoch_commitment_mismatch', 'registry_mismatch']);
// Distinct nodes that must refuse the first step above a kept anchor before that anchor is dropped.
export const LINEAGE_REFUSALS = 2;

async function verifyMacroblockAt(idx, nodesProvider, hooks = {}) {
  if (_verifiedCache.has(idx)) return verifiedAt(idx);
  const parity = idx % 2;
  const running = _walks.get(parity);
  if (running) {
    await running.catch(() => null);
    return _verifiedCache.get(idx) || null;
  }
  const walk = walkTo(idx, nodesProvider, hooks);
  _walks.set(parity, walk);
  try {
    return await walk;
  } finally {
    if (_walks.get(parity) === walk) _walks.delete(parity);
  }
}

// Verify macroblock `idx` by walking ITS PARITY CHAIN up from the genesis anchor (each committee is
// derived only from the node 2 macroblocks back, so even/odd chains are independent). Bottom-up so
// each step's j-2 anchor is already cached. Cached across calls.
async function walkTo(idx, nodesProvider, hooks) {
  // Walk root: the highest anchor below idx on its parity chain — a macroblock verified in this or an
  // earlier session, or the pin. WS=K roots this parity at K or K-1 (the pair the pin embeds), bounding
  // the walk to (idx - K)/2 steps instead of idx/2 on a mature chain. WS=0 with nothing verified yet ⇒
  // genesis era (committee pinned, first two indices use the embedded genesis set).
  const k = WS_CHECKPOINT.index || 0;
  if (k > 0 && !wsPinIsWellformed()) {
    console.warn('[ERR][LIGHT] ws_pin_malformed index=' + k + ' — refusing to verify');
    return null;
  }
  let steps = 0;
  const depth = hooks && Number.isSafeInteger(hooks.prefetch) && hooks.prefetch >= 1 ? hooks.prefetch : WALK_PREFETCH;
  const byteBudget = hooks && Number.isSafeInteger(hooks.prefetchBytes) && hooks.prefetchBytes >= 1
    ? hooks.prefetchBytes : WALK_INFLIGHT_BYTES;
  let largestSeen = 0;
  // Two passes at most: the second only after the first found its root, an anchor kept from an earlier session, to be
  // of another lineage, and rooted the walk lower instead (see below).
  for (let pass = 0; pass < 2; pass++) {
    const root = walkRoot(idx);
    const resumed = root >= 0 && _resumeAnchors.has(root) && !_verifiedCache.has(root);
    const start = root >= 0
      ? root + 2
      : k > 0
        ? (((idx - (k + 1)) % 2 === 0) ? k + 1 : k + 2)
        : ((idx % 2 === 0) ? 2 : 1);
    let reset = false;
    const ahead = new Map(); // step -> its proof fetched ahead (fetchAhead)
    // The committee size the walk expects: its anchor's eligible set, the genesis set below it.
    const rootAnchor = root >= 0 ? anchorFor(root) : null;
    const members = rootAnchor && Array.isArray(rootAnchor.eligibleIds) ? rootAnchor.eligibleIds.length : GENESIS_NODE_IDS.length;
    const held = () => {
      let sum = 0;
      for (const e of ahead.values()) {
        if (!e) continue;
        if (e.bytes !== null && e.bytes > largestSeen) largestSeen = e.bytes;
        sum += e.bytes !== null ? e.bytes : e.share;
      }
      return sum;
    };
    for (let j = start; j <= idx; j += 2) {
      if (_verifiedCache.has(j)) continue;
      // The budget of this call is spent: what was verified is kept (hooks.onProgress), the next call goes on.
      if (steps >= WALK_STEPS_PER_CALL) {
        console.warn('[WARN][LIGHT] walk_budget_spent j=' + j + ' target=' + idx);
        return null;
      }
      // This step and the next ones, up to `depth`, never past this call's budget nor the walk's byte bound, are
      // fetched now; the step itself always is.
      for (let s = j, n = 0, used = steps; s <= idx && n < depth && used < WALK_STEPS_PER_CALL; s += 2) {
        if (_verifiedCache.has(s)) continue;
        if (!ahead.has(s)) {
          const inFlight = held();
          const share = prefetchShareBytes(members, largestSeen);
          if (s !== j && inFlight + share > byteBudget) break;
          ahead.set(s, fetchAhead(s, nodesProvider, share));
        }
        n += 1;
        used += 1;
      }
      steps += 1;
      const first = ahead.get(j) || null;
      ahead.delete(j);
      // A step no node could serve stops the walk (j+2's committee is derived from j); each node that failed
      // it is not asked again for it until its TTL lapses, so a hopeless step costs no fetches and no
      // ML-DSA opens on every balance check. A target not certified yet stops it with no node charged.
      const tally = { refused: 0 };
      const outcome = await verifyStep(j, nodesProvider, hooks, tally, first, j === idx);
      if (first && first.bytes !== null && first.bytes > largestSeen) largestSeen = first.bytes;
      if (outcome === STEP.VERIFIED) continue;
      // The first step above an anchor kept from an earlier session, refused by several nodes for what ties it to that
      // anchor (its committee's signatures, its keys, its registry): the anchor is not this chain's lineage (a chain
      // that started again), and the walk would never get past it. The kept anchors go, the failures they caused are
      // forgotten, and the walk roots at the pin (or a lower anchor) at once. The pin and macroblocks verified in this
      // session are never dropped, so at worst this costs a longer walk, never trust.
      if (resumed && j === start && tally.refused >= LINEAGE_REFUSALS) {
        console.warn('[WARN][LINEAGE] resume_anchor_refused root=' + root + ' j=' + j + ' refused=' + tally.refused);
        _resumeAnchors.clear();
        for (const key of [..._failedCache.keys()]) if (key.startsWith(j + '|')) _failedCache.delete(key);
        if (hooks && typeof hooks.onLineageReset === 'function') {
          try { hooks.onLineageReset(); } catch (_) { /* the walk goes on */ }
        }
        reset = true;
        break;
      }
      return null;
    }
    if (!reset) return _verifiedCache.get(idx) || null;
  }
  return null;
}

// ── public entrypoint ───────────────────────────────────────────────────────
/**
 * Verify that `stateRoot` is the state_root of the macroblock at floor(blockHeight/90),
 * certified by a valid ≥quorum committee QC verified inductively from the trust anchor.
 *
 * @param {string} stateRoot  hex state_root from the balance/reward proof
 * @param {number} blockHeight microblock height the proof was anchored at
 * @param {function} getRandomBootstrapNode () => base URL string, or the list of base URLs to try in order
 * @param {object} [hooks] { onNodeFailure(base, reason), onProgress(index), registryNodes(), onLineageReset(), prefetch }:
 *   a node whose answer failed a step; a lineage step verified (so the caller can keep the progress); the nodes registry
 *   snapshots are read from; the anchors kept from an earlier session were found to be of another lineage and dropped
 *   (so the caller can drop its stored copy); the proofs a walk keeps in flight (WALK_PREFETCH)
 * @returns {Promise<boolean>} true ONLY if the state_root is QC-certified
 */
export async function verifyMacroblockStateRoot(stateRoot, blockHeight, getRandomBootstrapNode, hooks = {}) {
  if (!stateRoot || typeof stateRoot !== 'string') {
    console.warn('[WARN][LIGHT] no_state_root');
    return false;
  }
  if (typeof getRandomBootstrapNode !== 'function') {
    console.warn('[ERR][LIGHT] no_bootstrap_provider');
    return false;
  }

  const idx = Math.floor((blockHeight || 0) / MACROBLOCK_INTERVAL);
  // Fail closed below idx 1 (no finalized macroblock covers heights < 90 — macroblock 1 is the first)
  // AND at-or-below the weak-subjectivity pin: the pin carries hash(MB_K) and K's committee-derivation
  // data, NOT K's state_root, so indices up to K are trusted history this device cannot re-prove.
  const floor = trustFloorIndex();
  if (idx < floor) {
    console.warn('[WARN][LIGHT] below_floor idx=' + idx + ' floor=' + floor);
    return false;
  }

  try {
    const verified = await verifyMacroblockAt(idx, getRandomBootstrapNode, hooks);
    if (!verified) return false;
    if (verified.stateRoot !== stateRoot) {
      console.warn('[ERR][LIGHT] state_root_mismatch idx=' + idx +
        ' proof=' + String(stateRoot).slice(0, 16) + ' certified=' + String(verified.stateRoot).slice(0, 16));
      return false;
    }
    console.log('[INFO][LIGHT] state_root_certified idx=' + idx);
    return true;
  } catch (e) {
    console.warn('[ERR][LIGHT] verify_threw err=' + (e && e.message));
    return false;
  }
}

/**
 * The index of the macroblock whose committee-certified state_root is `stateRoot`: idx = floor(blockHeight/90), idx-1
 * or idx-2, or null. A node answers a balance proof with the state at its tip, and the macroblock covering the tip is
 * certified some blocks after its height (until then the node has none to serve); while nothing changed since an
 * earlier checkpoint, the tip's root is that checkpoint's certified root. Only certified roots are compared, and the
 * caller judges how recent the state is by the index returned, never by the height the node claimed.
 *
 * Checkpoints already verified answer at once, with no fetch. Otherwise idx is walked to (its walk verifies idx-2 on the
 * way); when idx is certified with another root, no earlier one can hold the tip's root either (a state that changed
 * after a checkpoint is never that checkpoint's state again), so only idx-2, already verified, is still compared; when
 * idx is not certified yet, idx-1 is walked to as well. Same arguments as verifyMacroblockStateRoot.
 * @returns {Promise<number|null>}
 */
export async function certifiedStateRootIndex(stateRoot, blockHeight, getRandomBootstrapNode, hooks = {}) {
  if (!stateRoot || typeof stateRoot !== 'string' || typeof getRandomBootstrapNode !== 'function') return null;
  const idx = Math.floor((blockHeight || 0) / MACROBLOCK_INTERVAL);
  const floor = trustFloorIndex();
  const candidates = [idx, idx - 1, idx - 2].filter((c) => c >= floor);
  const matches = (c) => candidates.includes(c) && !!_verifiedCache.get(c) && _verifiedCache.get(c).stateRoot === stateRoot;
  const certified = (c) => {
    verifiedAt(c);
    console.log('[INFO][LIGHT] state_root_certified idx=' + c + ' tip=' + idx);
    return c;
  };
  const known = candidates.find(matches);
  if (known !== undefined) return certified(known);
  if (candidates.length === 0) {
    console.warn('[WARN][LIGHT] below_floor idx=' + idx + ' floor=' + floor);
    return null;
  }
  try {
    const top = candidates.includes(idx) ? await verifyMacroblockAt(idx, getRandomBootstrapNode, hooks) : null;
    if (matches(idx)) return certified(idx);
    if (matches(idx - 2)) return certified(idx - 2);
    if (top) {
      console.warn('[ERR][LIGHT] state_root_mismatch idx=' + idx + ' proof=' + String(stateRoot).slice(0, 16));
      return null;
    }
    if (candidates.includes(idx - 1)) await verifyMacroblockAt(idx - 1, getRandomBootstrapNode, hooks);
    if (matches(idx - 1)) return certified(idx - 1);
    if (candidates.includes(idx - 2) && !_verifiedCache.has(idx - 2)) await verifyMacroblockAt(idx - 2, getRandomBootstrapNode, hooks);
    if (matches(idx - 2)) return certified(idx - 2);
    return null;
  } catch (e) {
    console.warn('[ERR][LIGHT] verify_threw err=' + (e && e.message));
    return null;
  }
}

// ── certified state proofs: the root of a named macroblock, and the certified head ──
/**
 * The committee-certified state root of macroblock `index`, for a proof that names it (a certified state proof,
 * proof_format 2): the walk goes up to `index` only, never to the tip. { ok: true, index, stateRoot } once the QC of
 * that macroblock is verified from the trust anchor; else { ok: false, reason }: 'below_floor' (at or below the pin, or
 * no index), 'not_certified' (the nodes do not hold it yet) or 'unverified' (it could not be verified now). The caller
 * folds the proof to this root, never to the one the node served. Same arguments as verifyMacroblockStateRoot.
 */
export async function certifiedStateRootAt(index, getRandomBootstrapNode, hooks = {}) {
  if (!Number.isSafeInteger(index) || index < trustFloorIndex()) return { ok: false, reason: 'below_floor' };
  if (typeof getRandomBootstrapNode !== 'function') return { ok: false, reason: 'unverified' };
  try {
    const verified = await verifyMacroblockAt(index, getRandomBootstrapNode, hooks);
    if (verified && HEX32.test(String(verified.stateRoot))) return { ok: true, index, stateRoot: verified.stateRoot };
  } catch (e) {
    console.warn('[ERR][LIGHT] verify_threw err=' + (e && e.message));
  }
  return { ok: false, reason: notCertifiedRecently(index) ? 'not_certified' : 'unverified' };
}

// The certified head: how far the committee has certified, as genesis nodes report it (GET /api/v1/state/certified,
// newest_certified_index). A node from before certified proofs reports its sealed-macroblock watermark instead
// (/api/v1/debug/consensus-position, last_sealed_mb_index). Never the applied tip: a proof is as recent as the
// checkpoint it folds to, and the frontier it is judged against must be a certified one too.
export const HEAD_HINT_TTL_MS = 60_000;
export const HEAD_HINT_MIN_ANSWERS = 3;
// A read that found too few answers is not repeated for this long: every proof answer of one balance read asks for the
// head, and each read waits out the timeouts of the nodes that do not answer.
const HEAD_HINT_MISS_MS = 10_000;
const HEAD_HINT_MAX_BYTES = 64 * 1024;
const HEAD_HINT_TIMEOUT_MS = 3000;
let _headHint = null; // { index, at }
let _headHintMissAt = 0;
let _headHintRead = null;

const frontierOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

// The certified frontier one node reports, or null.
async function nodeFrontier(base) {
  const got = await nodeGet(base, '/api/v1/state/certified', HEAD_HINT_MAX_BYTES, HEAD_HINT_TIMEOUT_MS);
  const b = got.body;
  if (b && typeof b === 'object' && b.proof_format === 2) {
    let top = frontierOf(b.newest_certified_index);
    if (top === null) return null;
    // Never below a view it serves (a belt over the node's own bookkeeping).
    for (const v of Array.isArray(b.views) ? b.views : []) {
      const i = v && frontierOf(v.macroblock_index);
      if (i !== null && i > top) top = i;
    }
    return top;
  }
  if (got.limited) return null;
  const old = await nodeGet(base, '/api/v1/debug/consensus-position', HEAD_HINT_MAX_BYTES, HEAD_HINT_TIMEOUT_MS);
  return old.body && typeof old.body === 'object' ? frontierOf(old.body.last_sealed_mb_index) : null;
}

// The second highest of the answers, once at least HEAD_HINT_MIN_ANSWERS came, as soon as the answers still out
// cannot move it; null when too few answer. One node claiming a far head moves nothing.
function settleHeadHint(reads) {
  return new Promise((resolve) => {
    const got = [];
    let left = reads.length;
    let done = false;
    const decide = () => {
      if (done) return;
      const s = got.filter((v) => v !== null).sort((a, b) => b - a);
      if (s.length + left < HEAD_HINT_MIN_ANSWERS) { done = true; resolve(null); return; }
      if (left > 0 && !(left === 1 && s.length >= HEAD_HINT_MIN_ANSWERS && s[0] === s[1])) return;
      done = true;
      resolve(s.length >= HEAD_HINT_MIN_ANSWERS ? s[1] : null);
    };
    if (left === 0) { decide(); return; }
    for (const p of reads) {
      Promise.resolve(p).catch(() => null).then((v) => { got.push(v); left -= 1; decide(); });
    }
  });
}

/**
 * The certified head as the nodes `nodesProvider` names report it (the genesis nodes): the second highest of their
 * certified frontiers, cached HEAD_HINT_TTL_MS; null when fewer than HEAD_HINT_MIN_ANSWERS answer. A hint: liars can
 * only make proofs count as older than they are.
 */
export function certifiedHeadHint(nodesProvider) {
  const now = Date.now();
  if (_headHint && now - _headHint.at < HEAD_HINT_TTL_MS) return Promise.resolve(_headHint.index);
  if (now - _headHintMissAt < HEAD_HINT_MISS_MS) return Promise.resolve(null);
  if (_headHintRead) return _headHintRead;
  const read = settleHeadHint(nodesFrom(nodesProvider).map((base) => nodeFrontier(base).catch(() => null)))
    .then((index) => {
      if (index !== null) _headHint = { index, at: Date.now() };
      else _headHintMissAt = Date.now();
      return index;
    })
    .finally(() => { if (_headHintRead === read) _headHintRead = null; });
  _headHintRead = read;
  return read;
}

/**
 * The certified head a proof's freshness is judged by: the higher of the newest macroblock this device verified and
 * the hint (certifiedHeadHint), or null without a hint (no proof then counts as fresh).
 */
export async function certifiedHead(nodesProvider) {
  const hint = await certifiedHeadHint(nodesProvider);
  return hint === null ? null : Math.max(highestVerifiedIndex(), hint);
}

// Nodes that answered a certified proof request with the older body (they ignore the query), until when: such a node
// is asked after the others for OLD_NODE_MARK_MS, then as any other (it may have been upgraded meanwhile).
export const OLD_NODE_MARK_MS = 10 * 60_000;
const _oldNodes = new Map();

export function markNodeOld(base, now = Date.now()) {
  if (typeof base === 'string' && base) _oldNodes.set(base, now + OLD_NODE_MARK_MS);
}

export function nodeMarkedOld(base, now = Date.now()) {
  const until = _oldNodes.get(base);
  if (until === undefined) return false;
  if (until <= now) { _oldNodes.delete(base); return false; }
  return true;
}

/**
 * P4: verify that `logsRoot` is the QC-certified Checkpoint.logs_root of the macroblock covering
 * `windowEnd` (a multiple of 90). Mirrors verifyMacroblockStateRoot; pair with verifyLogInclusion to
 * prove a token transfer against a committee-QC-anchored root.
 * Three outcomes so the caller can separate a proven forgery from an honest can't-prove-now:
 * @returns {Promise<true|'mismatch'|false>} true = QC-certified match; 'mismatch' = the committee-QC
 *   root for this window DIFFERS from the node-claimed root (a proven forgery → caller must reject);
 *   false = unprovable now (below trust floor / macroblock unreachable / threw → caller keeps pending).
 */
export async function verifyMacroblockLogsRoot(logsRoot, windowEnd, getRandomBootstrapNode, hooks = {}) {
  if (!logsRoot || typeof logsRoot !== 'string') return false;
  if (typeof getRandomBootstrapNode !== 'function') return false;
  const idx = Math.floor((windowEnd || 0) / MACROBLOCK_INTERVAL);
  const floor = trustFloorIndex();
  if (idx < floor) return false; // below the finalized/trust floor — unprovable, not a forgery
  try {
    const verified = await verifyMacroblockAt(idx, getRandomBootstrapNode, hooks);
    if (!verified) return false; // couldn't fetch/QC-verify the macroblock — unprovable, not a forgery
    if (verified.logsRoot !== logsRoot) {
      // QC-certified root ≠ node-claimed root: the node's (leaf,proof,root) triple is self-consistent
      // but the root itself is not what the committee signed → the transfer is forged/fork-served.
      console.warn('[ERR][LIGHT] logs_root_mismatch idx=' + idx);
      return 'mismatch';
    }
    return true;
  } catch (e) {
    console.warn('[ERR][LIGHT] verify_logs_threw err=' + (e && e.message));
    return false;
  }
}

/** Drop the in-memory verified-proof cache (e.g. on network switch). */
export function clearQcCache() {
  _verifiedCache.clear();
  // Both, or a network switch would keep refusing the walk on the OLD network's failures.
  _failedCache.clear();
  _resumeAnchors.clear();
  _registryByRoot.clear();
  _pkSha.clear();
  _nodeReads.clear();
  _nodeBackoff.clear();
  _notCertified.clear();
  _oldNodes.clear();
  _headHint = null;
  _headHintMissAt = 0;
  _headHintRead = null;
}

/*
 * SELF-TESTS (run with: node -e "require('./QcLightClient.test')" after stubbing
 * the native module; left as a reference vector list, not wired into Jest here):
 *
 *  quorumSize:   n=5→4, n=100→67, n=120→80, n=1→1, n=0→0, n=3→3, n=4→3, n=7→5.
 *  checkpointHash: for cp{index:1,parent_qc:null,window_head_height:90,
 *    window_mb_hashes:[],state_root:'00'.repeat(32),beacon:..,epoch_commitment:..,
 *    reward_root:..,registry_root:..,total_supply:0,timestamp:0,proposer:'genesis_node_001'}
 *    must equal the Rust Checkpoint::hash() over the same fields (compare against a
 *    node-emitted /macroblock/{idx}/proof: checkpointHash(proof.checkpoint) is the
 *    preimage of every QC vote message "QNET_BFT2_VOTE:"+hash).
 *  recomputeRegistryRoot: over registry.entries from /registry/epoch/{n2} must equal
 *    proof.checkpoint.registry_root (cross-checked live, byte-exact to registry_lthash.rs).
 *  parseDilithiumSig: round-trips a node "dilithium_sig_<id>_<b64>" to a 3309-byte (6618 hex)
 *    detached sig; verifyDilithium(message, that, trusted_pk) must be true for an honest QC.
 */

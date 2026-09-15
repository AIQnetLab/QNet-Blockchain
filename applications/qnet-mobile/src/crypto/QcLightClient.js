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

// ── consensus constants (mirror checkpoint_bft.rs — MUST stay in lockstep with the node) ──
const COMMITTEE_THRESHOLD = 1000; // ≤1000 eligible ⇒ whole set is the committee
const COMMITTEE_SIZE = 1000;      // VRF subsample size when > threshold
const MACROBLOCK_INTERVAL = 90;  // microblocks per macroblock / epoch
const DILITHIUM_SIG_LEN = 3309;  // detached ML-DSA-65 signature bytes
const LANES = 1024;              // LtHash lanes (u16)
const STATE_BYTES = LANES * 2;   // serialized LtHash state

// In-memory cache of verified macroblock proofs, keyed by index → { stateRoot, checkpointHash }.
// Immutable per index; bounds inductive work across repeated balance checks.
const _verifiedCache = new Map();

// Negative cache: index → { reason, at }. Without it a macroblock this device can never verify is
// re-fetched and re-verified on EVERY balance check — at committee 1000 that is ~501 ML-DSA opens per
// call, forever, and the caller only ever sees `false` with no reason. Short-lived on purpose: the
// cause is usually the SERVED proof, not the macroblock, so a different bootstrap node may well
// succeed — the TTL bounds the retry rate without ever making a failure permanent.
const _failedCache = new Map();
const FAIL_TTL_MS = 60_000;

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

// THE anchor lookup: a macroblock this device verified itself, else a binary-pinned one.
function anchorFor(j) {
  return _verifiedCache.get(j) || pinnedAnchor(j);
}

// Lowest index this device can PROVE. Genesis-rooted: 1. Pinned at K: K+1 — K itself is trusted by
// hash, but the pin carries no state_root/logs_root for it, so answering a query at K would mean
// serving a value nobody verified.
export function trustFloorIndex() {
  const k = WS_CHECKPOINT.index || 0;
  return k > 0 ? k + 1 : 1;
}

function noteFailure(j, reason) {
  _failedCache.set(j, { reason, at: Date.now() });
  return null;
}

// The live failure reason for `j`, or null once it has aged out.
function recentFailure(j) {
  const f = _failedCache.get(j);
  if (!f) return null;
  if (Date.now() - f.at >= FAIL_TTL_MS) { _failedCache.delete(j); return null; }
  return f.reason;
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
export function recomputeRegistryRoot(entries) {
  const state = new Uint16Array(LANES); // wrapping-add is implicit (Uint16Array truncates mod 2^16)
  for (const e of entries || []) {
    const lanes = ltHashRowLanes(e);
    for (let i = 0; i < LANES; i++) state[i] = (state[i] + lanes[i]) & 0xffff;
  }
  const stateBytes = Buffer.alloc(STATE_BYTES);
  for (let i = 0; i < LANES; i++) {
    stateBytes[2 * i] = state[i] & 0xff;
    stateBytes[2 * i + 1] = (state[i] >> 8) & 0xff;
  }
  return sha3_256(concat([utf8('qnet-registry-root-v2'), stateBytes]));
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
// Verifies a random sample of K committee signatures over the canonical vote
// message; requires ALL sampled sigs valid AND distinct signers ≥ quorum.
// pubkeysByNode: node_id → TRUSTED pk_hex (genesis map, or registry-verified).
async function verifyQcFull(qc, committee, pubkeysByNode, checkpointHashHex, quorum) {
  // The threshold is CALLER-supplied for the same reason as on the node: a certificate must never
  // choose its own bar.
  const q = quorum == null ? quorumSize(committee.length) : quorum;
  if (q === 0) return false;
  const signers = qc.signers || [];
  const sigs = qc.sigs || [];
  if (signers.length !== sigs.length) {
    console.warn('[WARN][QC] len_mismatch signers=' + signers.length + ' sigs=' + sigs.length);
    return false;
  }
  const committeeSet = new Set(committee);
  const message = 'QNET_BFT2_VOTE:' + checkpointHashHex;
  // Count DISTINCT VALID committee-member signatures. No sampling: sampling cannot PROVE quorum
  // (it can miss invalid sigs among claimed signers). Verify until >= quorum valid are found (early
  // exit on a healthy QC), else reject. <=100 committee ⇒ <=quorum (~67) ML-DSA opens worst-case.
  const validDistinct = new Set();
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    if (!committeeSet.has(signer) || validDistinct.has(signer)) continue;
    const pkHex = pubkeysByNode[signer];
    if (!pkHex) continue;
    const detachedSigHex = parseDilithiumSig(sigs[i]);
    if (!detachedSigHex) continue;
    let ok = false;
    try { ok = await verifyDilithium(message, detachedSigHex, pkHex); } catch (_) { ok = false; }
    if (ok) validDistinct.add(signer);
    if (validDistinct.size >= q) break;
  }
  if (validDistinct.size < q) {
    console.warn('[ERR][QC] below_quorum valid=' + validDistinct.size + ' need=' + q + ' committee=' + committee.length);
    return false;
  }
  console.log('[DBG] qc_full_ok valid=' + validDistinct.size + ' quorum=' + q);
  return true;
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
export async function resolvePubkeys(committee, anchorRoot, anchorHeight, servedPubkeys, registryFetch, needed) {
  let registry;
  try {
    registry = await registryFetch(anchorHeight);
  } catch (e) {
    console.warn('[WARN][REGISTRY] fetch_failed height=' + anchorHeight + ' err=' + (e && e.message));
    return null;
  }
  if (!registry || !Array.isArray(registry.entries)) {
    console.warn('[WARN][REGISTRY] malformed height=' + anchorHeight);
    return null;
  }
  if (recomputeRegistryRoot(registry.entries) !== anchorRoot) {
    console.warn('[ERR][REGISTRY] root_mismatch height=' + anchorHeight);
    return null;
  }
  const entryByNode = new Map(registry.entries.map((e) => [e.node_id, e]));
  const pubkeys = {};
  let bound = 0;
  for (const nodeId of committee) {
    const pkHex = servedPubkeys[nodeId];
    const entry = entryByNode.get(nodeId);
    if (!pkHex || !entry || !entry.vrf_pk_sha3) continue;
    if (sha3_256(hexToBytes(pkHex)) !== entry.vrf_pk_sha3) {
      console.warn('[ERR][REGISTRY] pk_sha3_mismatch node=' + nodeId);
      continue;
    }
    pubkeys[nodeId] = pkHex;
    bound += 1;
  }
  // Cheap pre-check only: verifyQcFull enforces the real threshold on VALID signatures. `needed` is
  // the threshold THIS checkpoint is judged at, supplied by the caller so no callee picks its own bar.
  if (bound < needed) {
    console.warn('[WARN][REGISTRY] bound_below_threshold bound=' + bound + ' need=' + needed + ' committee=' + committee.length);
    return null;
  }
  return pubkeys;
}

// ── fetch a macroblock proof / registry from a bootstrap node ───────────────
async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Verify a single macroblock j from its fetched proof. Committee = genesis-pinned (genesis era) OR
// sample_committee over the VERIFIED j-2 eligible+beacon from cache (NOT server-supplied). Verify the
// QC in full, then anchor j's OWN eligible+banned via the QC-signed epoch_commitment. Caches
// {stateRoot, checkpointHash, eligibleIds, beacon} so j+2 derives its committee from this.
async function verifyOne(j, proof, registryFetch) {
  const cp = proof.checkpoint;
  if (proof.index !== j || Math.floor((cp.window_head_height || 0) / MACROBLOCK_INTERVAL) !== j) {
    console.warn('[ERR][LIGHT] index_or_head_mismatch j=' + j + ' idx=' + proof.index + ' whh=' + cp.window_head_height);
    return noteFailure(j, 'index_or_head_mismatch');
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
      return null;
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
    return noteFailure(j, 'rc_pin_refused');
  }
  if (!pubkeys) {
    if (!anchor.registryRoot) return noteFailure(j, 'anchor_registry_root_missing');
    pubkeys = await resolvePubkeys(committee, anchor.registryRoot, (j - 2) * MACROBLOCK_INTERVAL,
                                   proof.committee_pubkeys || {}, registryFetch, quorum);
    if (!pubkeys) return noteFailure(j, 'pubkeys_unresolved');
  }
  if (!(await verifyQcFull(proof.qc || {}, committee, pubkeys, cpHash, quorum))) {
    console.warn('[ERR][LIGHT] qc_invalid j=' + j);
    return noteFailure(j, 'qc_invalid');
  }
  // Anchor j's epoch-transition data: recompute epoch_commitment over the served raw eligible bytes +
  // the (derived) committee + served banned; it MUST equal the QC-signed cp.epoch_commitment. This
  // proves the served eligible_raw is genuine before we carry it forward to derive j+2's committee.
  const eligibleBytes = hexToBytes(proof.eligible_raw || '');
  if (epochCommitment(eligibleBytes, committee, proof.banned || []) !== cp.epoch_commitment) {
    console.warn('[ERR][LIGHT] epoch_commitment_mismatch j=' + j);
    return noteFailure(j, 'epoch_commitment_mismatch');
  }
  // registryRoot is retained because j+2 binds its committee's pubkeys to it. It is certified: the QC
  // over cpHash, which folds registry_root, has just been verified.
  const entry = { stateRoot: cp.state_root, logsRoot: cp.logs_root, checkpointHash: cpHash, eligibleIds: decodeEligibleNodeIds(eligibleBytes), beacon: cp.beacon, registryRoot: cp.registry_root };
  _verifiedCache.set(j, entry);
  _failedCache.delete(j);
  console.log('[INFO][LIGHT] macroblock_verified j=' + j + ' committee=' + committee.length);
  return entry;
}

// Verify macroblock `idx` by walking ITS PARITY CHAIN up from the genesis anchor (each committee is
// derived only from the node 2 macroblocks back, so even/odd chains are independent). Bottom-up so
// each step's j-2 anchor is already cached. Cached across calls.
async function verifyMacroblockAt(idx, getRandomBootstrapNode) {
  if (_verifiedCache.has(idx)) return _verifiedCache.get(idx);
  const registryFetch = (height) => fetchJson(getRandomBootstrapNode() + '/api/v1/registry/height/' + height);
  // Walk root. WS=0 ⇒ genesis era (committee pinned, first two indices use the embedded genesis set).
  // WS=K ⇒ root at the pin: this parity's first derivable index is K+1 or K+2, whichever matches idx's
  // parity, because its N-2 anchor is then K-1 or K — the pair the pin embeds. That bounds the walk to
  // (idx - K)/2 steps instead of idx/2 on a mature chain.
  const k = WS_CHECKPOINT.index || 0;
  if (k > 0 && !wsPinIsWellformed()) {
    console.warn('[ERR][LIGHT] ws_pin_malformed index=' + k + ' — refusing to verify');
    return null;
  }
  const start = k > 0
    ? (((idx - (k + 1)) % 2 === 0) ? k + 1 : k + 2)
    : ((idx % 2 === 0) ? 2 : 1);
  for (let j = start; j <= idx; j += 2) {
    if (_verifiedCache.has(j)) continue;
    // A step that just failed is not re-verified until its TTL lapses. The walk still stops here —
    // j+2's committee is derived from j — but it stops WITHOUT re-running the fetch and the ~quorum
    // ML-DSA opens on every balance check, and the caller learns why.
    const stale = recentFailure(j);
    if (stale) {
      console.warn('[WARN][LIGHT] walk_halted j=' + j + ' reason=' + stale + ' (cached, retries after TTL)');
      return null;
    }
    let proof;
    try {
      proof = await fetchJson(getRandomBootstrapNode() + '/api/v1/macroblock/' + j + '/proof');
    } catch (e) {
      console.warn('[WARN][LIGHT] proof_fetch_failed j=' + j + ' err=' + (e && e.message));
      return noteFailure(j, 'proof_fetch_failed');
    }
    if (!proof || !proof.checkpoint || typeof proof.index !== 'number') {
      console.warn('[WARN][LIGHT] proof_malformed j=' + j);
      return noteFailure(j, 'proof_malformed');
    }
    if (!(await verifyOne(j, proof, registryFetch))) return null;
  }
  return _verifiedCache.get(idx) || null;
}

// ── public entrypoint ───────────────────────────────────────────────────────
/**
 * Verify that `stateRoot` is the state_root of the macroblock at floor(blockHeight/90),
 * certified by a valid ≥quorum committee QC verified inductively from the trust anchor.
 *
 * @param {string} stateRoot  hex state_root from the balance/reward proof
 * @param {number} blockHeight microblock height the proof was anchored at
 * @param {function} getRandomBootstrapNode () => base URL string
 * @returns {Promise<boolean>} true ONLY if the state_root is QC-certified
 */
export async function verifyMacroblockStateRoot(stateRoot, blockHeight, getRandomBootstrapNode) {
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
    const verified = await verifyMacroblockAt(idx, getRandomBootstrapNode);
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
 * P4: verify that `logsRoot` is the QC-certified Checkpoint.logs_root of the macroblock covering
 * `windowEnd` (a multiple of 90). Mirrors verifyMacroblockStateRoot; pair with verifyLogInclusion to
 * prove a token transfer against a committee-QC-anchored root.
 * Three outcomes so the caller can separate a proven forgery from an honest can't-prove-now:
 * @returns {Promise<true|'mismatch'|false>} true = QC-certified match; 'mismatch' = the committee-QC
 *   root for this window DIFFERS from the node-claimed root (a proven forgery → caller must reject);
 *   false = unprovable now (below trust floor / macroblock unreachable / threw → caller keeps pending).
 */
export async function verifyMacroblockLogsRoot(logsRoot, windowEnd, getRandomBootstrapNode) {
  if (!logsRoot || typeof logsRoot !== 'string') return false;
  if (typeof getRandomBootstrapNode !== 'function') return false;
  const idx = Math.floor((windowEnd || 0) / MACROBLOCK_INTERVAL);
  const floor = trustFloorIndex();
  if (idx < floor) return false; // below the finalized/trust floor — unprovable, not a forgery
  try {
    const verified = await verifyMacroblockAt(idx, getRandomBootstrapNode);
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

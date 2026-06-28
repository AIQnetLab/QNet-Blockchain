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

// ── consensus constants (mirror checkpoint_bft.rs) ──────────────────────────
const COMMITTEE_THRESHOLD = 120; // ≤120 eligible ⇒ whole set is the committee
const COMMITTEE_SIZE = 100;      // VRF subsample size when > threshold
const MACROBLOCK_INTERVAL = 90;  // microblocks per macroblock / epoch
const DILITHIUM_SIG_LEN = 3309;  // detached ML-DSA-65 signature bytes
const LANES = 1024;              // LtHash lanes (u16)
const STATE_BYTES = LANES * 2;   // serialized LtHash state

// In-memory cache of verified macroblock proofs, keyed by index → { stateRoot, checkpointHash }.
// Immutable per index; bounds inductive work across repeated balance checks.
const _verifiedCache = new Map();

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
//   ++ reward_root(32) ++ registry_root(32) ++ total_supply(u64LE) ++ timestamp(u64LE)
//   ++ proposer.utf8 → 32B hash.
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
  parts.push(u64le(cp.total_supply));
  parts.push(u64le(cp.timestamp));
  parts.push(utf8(cp.proposer));
  return sha3_256(concat(parts)); // lowercase hex (32B)
}

// ── 3. Parse the ATTACHED dilithium sig string → detached sig hex ───────────
// String: "dilithium_sig_<node_id>_<base64>". base64 decodes to
//   [u32LE signed_msg_len][signed_msg][u32LE pk_len][pk]; signed_msg = [detached_sig(3309)][msg].
// We need only the detached sig; the embedded pk is IGNORED (we use the TRUSTED pk).
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

// ── 5a. LtHash per-row lane vector (byte-exact registry_lthash.rs::row_lanes) ─
// vrfPkSha3 is the hex of sha3-256(consensus_pubkey); light/keyless rows pass ''.
export function ltHashRowLanes(entry) {
  const vrfBytes = hexToBytes(entry.vrf_pk_sha3 || '');
  const nodeId = utf8(entry.node_id);
  const wallet = utf8(entry.wallet);
  const burn = utf8(entry.burn || '');
  const seedHex = sha3_256(concat([
    utf8('qnet-registry-row-v3'),
    u32le(nodeId.length), nodeId,
    u32le(wallet.length), wallet,
    u64le(entry.reg_height),
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
async function verifyQcFull(qc, committee, pubkeysByNode, checkpointHashHex) {
  const q = quorumSize(committee.length);
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
// map. Epoch ≥ 3: derive committee via sampleCommittee over the served N-2
// eligible_producers + beacon, then verify each served committee pubkey against
// the QC-signed registry_root (recomputed from the served registry entries).
async function resolvePubkeys(committee, cp, servedPubkeys, registryFetch) {
  // Fetch the registry as of THIS macroblock's window head (where its registry_root is sealed),
  // recompute the LtHash root, require it == the QC-signed cp.registry_root, then bind each committee
  // member's served pubkey by sha3(pubkey)==entry.vrf_pk_sha3. Returns the trusted pubkey map or null.
  const regHeight = cp.window_head_height;
  let registry;
  try {
    registry = await registryFetch(regHeight);
  } catch (e) {
    console.warn('[WARN][REGISTRY] fetch_failed height=' + regHeight + ' err=' + (e && e.message));
    return null;
  }
  if (!registry || !Array.isArray(registry.entries)) {
    console.warn('[WARN][REGISTRY] malformed height=' + regHeight);
    return null;
  }
  if (recomputeRegistryRoot(registry.entries) !== cp.registry_root) {
    console.warn('[ERR][REGISTRY] root_mismatch height=' + regHeight);
    return null;
  }
  const entryByNode = new Map(registry.entries.map((e) => [e.node_id, e]));
  const pubkeys = {};
  for (const nodeId of committee) {
    const pkHex = servedPubkeys[nodeId];
    const entry = entryByNode.get(nodeId);
    if (!pkHex || !entry || !entry.vrf_pk_sha3) {
      console.warn('[WARN][REGISTRY] no_pk_or_entry node=' + nodeId);
      return null;
    }
    if (sha3_256(hexToBytes(pkHex)) !== entry.vrf_pk_sha3) {
      console.warn('[ERR][REGISTRY] pk_sha3_mismatch node=' + nodeId);
      return null;
    }
    pubkeys[nodeId] = pkHex;
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
    return null;
  }
  let committee, pubkeys;
  if (j < GENESIS_ERA_MAX_INDEX) {
    committee = GENESIS_NODE_IDS.slice();
    pubkeys = { ...GENESIS_CONSENSUS_PKS };
  } else {
    const anchor = _verifiedCache.get(j - 2); // populated by the bottom-up parity walk
    if (!anchor || !Array.isArray(anchor.eligibleIds) || !anchor.beacon) {
      console.warn('[WARN][LINEAGE] anchor_missing j=' + j + ' need=' + (j - 2));
      return null;
    }
    // VRF window = the epoch, which is DETERMINISTICALLY the macroblock index j ((j*90-1)/90+1 == j) —
    // derive it from j (already bound via window_head_height/90==j), NEVER from the server-supplied
    // proof.epoch (an unbound seed would let an attacker grind the committee subset).
    committee = sampleCommittee([...anchor.eligibleIds].sort(), j, anchor.beacon);
    pubkeys = await resolvePubkeys(committee, cp, proof.committee_pubkeys || {}, registryFetch);
    if (!pubkeys) return null;
  }
  const cpHash = checkpointHash(cp); // recompute, never trust a served hash
  if (!(await verifyQcFull(proof.qc || {}, committee, pubkeys, cpHash))) {
    console.warn('[ERR][LIGHT] qc_invalid j=' + j);
    return null;
  }
  // Anchor j's epoch-transition data: recompute epoch_commitment over the served raw eligible bytes +
  // the (derived) committee + served banned; it MUST equal the QC-signed cp.epoch_commitment. This
  // proves the served eligible_raw is genuine before we carry it forward to derive j+2's committee.
  const eligibleBytes = hexToBytes(proof.eligible_raw || '');
  if (epochCommitment(eligibleBytes, committee, proof.banned || []) !== cp.epoch_commitment) {
    console.warn('[ERR][LIGHT] epoch_commitment_mismatch j=' + j);
    return null;
  }
  const entry = { stateRoot: cp.state_root, checkpointHash: cpHash, eligibleIds: decodeEligibleNodeIds(eligibleBytes), beacon: cp.beacon };
  _verifiedCache.set(j, entry);
  console.log('[INFO][LIGHT] macroblock_verified j=' + j + ' committee=' + committee.length);
  return entry;
}

// Verify macroblock `idx` by walking ITS PARITY CHAIN up from the genesis anchor (each committee is
// derived only from the node 2 macroblocks back, so even/odd chains are independent). Bottom-up so
// each step's j-2 anchor is already cached. Cached across calls.
async function verifyMacroblockAt(idx, getRandomBootstrapNode) {
  if (_verifiedCache.has(idx)) return _verifiedCache.get(idx);
  const registryFetch = (height) => fetchJson(getRandomBootstrapNode() + '/api/v1/registry/height/' + height);
  // WS=0 ⇒ start in the genesis era (committee pinned). When a non-zero WS pin is shipped (binary
  // rotation, to bound the walk on a mature chain), the pinned macroblock's eligible+beacon must be
  // embedded so the first step's anchor exists; until then the walk is genesis-rooted.
  const start = (idx % 2 === 0) ? 2 : 1;
  for (let j = start; j <= idx; j += 2) {
    if (_verifiedCache.has(j)) continue;
    let proof;
    try {
      proof = await fetchJson(getRandomBootstrapNode() + '/api/v1/macroblock/' + j + '/proof');
    } catch (e) {
      console.warn('[WARN][LIGHT] proof_fetch_failed j=' + j + ' err=' + (e && e.message));
      return null;
    }
    if (!proof || !proof.checkpoint || typeof proof.index !== 'number') {
      console.warn('[WARN][LIGHT] proof_malformed j=' + j);
      return null;
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
  // AND below the weak-subjectivity anchor (outside the trust window).
  const floor = Math.max(1, WS_CHECKPOINT.index || 0);
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

/** Drop the in-memory verified-proof cache (e.g. on network switch). */
export function clearQcCache() {
  _verifiedCache.clear();
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

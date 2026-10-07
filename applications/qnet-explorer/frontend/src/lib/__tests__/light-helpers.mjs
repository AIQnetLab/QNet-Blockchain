// Fixtures of the light-client tests (light-client.test.mjs): a state tree built from first principles (the node's
// bucketed sparse tree: buckets of the leading 40 key bits, 40 hashed levels above them) that hands out proofs of the
// three kinds, and a certified chain whose checkpoints are signed with real ML-DSA-65 keys and built with the extension
// bundle's functions (an implementation of its own, compiled from the wallets' light client), served by scripted nodes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import jsSha3 from 'js-sha3';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

const { sha3_256 } = jsSha3;
export const REPO = new URL('../../../../../../', import.meta.url);
export const core = await import(new URL('applications/qnet-wallet/dist/lib/qnet-core.js', REPO).href);
const require = createRequire(import.meta.url);
export const { smtFold } = require(fileURLToPath(new URL('applications/qnet-mobile/src/crypto/SmtFold.js', REPO)));
export const read = (rel) => readFileSync(new URL(rel, REPO), 'utf8').replace(/\r\n/g, '\n');

const hx = (h) => Buffer.from(h, 'hex');
const H = (buf) => sha3_256(buf);
export const sha3Hex = (bytes) => sha3_256(bytes);
const pair = (l, r) => H(Buffer.concat([hx(l), hx(r)]));
const bucketLeaf = (k, v) => H(Buffer.concat([Buffer.from([0xb5]), hx(k), hx(v)]));
const DEFAULTS = (() => {
  const d = ['0'.repeat(64)];
  for (let i = 1; i <= 256; i++) d.push(pair(d[i - 1], d[i - 1]));
  return d;
})();
const bitAt = (key, i) => (parseInt(key[i >> 2], 16) >> (3 - (i & 3))) & 1;

/** A tree of {key, leaf} entries (hex), with its root and proofs as the node serves them. */
export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : 1));
  const bucketHash = (list) => {
    let level = list.map((e) => bucketLeaf(e.key, e.leaf));
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
      level = next;
    }
    return level[0];
  };
  // The node with the first `fixed` key bits of `list` in common (depth 256 - fixed), each computed once.
  const memo = new Map();
  const prefix = (key, n) => `${n}:${key.slice(0, n >> 2)}:${n & 3 ? parseInt(key[n >> 2], 16) >> (4 - (n & 3)) : ''}`;
  const nodeHash = (fixed, list) => {
    if (list.length === 0) return DEFAULTS[256 - fixed];
    const id = prefix(list[0].key, fixed);
    if (memo.has(id)) return memo.get(id);
    const h = fixed === 40 ? bucketHash(list)
      : pair(nodeHash(fixed + 1, list.filter((e) => bitAt(e.key, fixed) === 0)), nodeHash(fixed + 1, list.filter((e) => bitAt(e.key, fixed) === 1)));
    memo.set(id, h);
    return h;
  };
  const root = nodeHash(0, sorted);
  const treeSteps = (key) => {
    const steps = [];
    for (let i = 0; i < 40; i++) {
      const b = 39 - i;
      const sib = sorted.filter((e) => {
        for (let x = 0; x < b; x++) if (bitAt(e.key, x) !== bitAt(key, x)) return false;
        return bitAt(e.key, b) !== bitAt(key, b);
      });
      steps.push({ sibling: nodeHash(b + 1, sib), is_right: bitAt(key, b) === 1 });
    }
    return steps;
  };
  const bucketOf = (key) => sorted.filter((e) => e.key.slice(0, 10) === key.slice(0, 10));
  function prove(key) {
    const bucket = bucketOf(key);
    const at = bucket.findIndex((e) => e.key === key);
    if (at >= 0) {
      let level = bucket.map((e) => bucketLeaf(e.key, e.leaf));
      let idx = at;
      const path = [];
      while (level.length > 1) {
        const sib = idx ^ 1;
        if (sib < level.length) path.push({ sibling: level[sib], is_right: (idx & 1) === 1 });
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
        level = next;
        idx >>= 1;
      }
      return { kind: 'inclusion', leaf: bucket[at].leaf, steps: [...path, ...treeSteps(key)] };
    }
    if (bucket.length === 0) return { kind: 'absence', steps: treeSteps(key) };
    return { kind: 'absence_in_bucket', entries: bucket.map((e) => ({ key: e.key, leaf: e.leaf })), steps: treeSteps(key) };
  }
  return { root, prove };
}

/** A key in `key`'s bucket, not equal to it. */
export const coBucket = (key, flip = 1) => key.slice(0, 62) + ((parseInt(key.slice(62), 16) ^ flip) & 0xff).toString(16).padStart(2, '0');

/** The leaf the node hashes for an account (built here byte by byte from state.rs hash_account). */
export function accountLeaf(address, a) {
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const parts = [Buffer.from('QNET_ACCOUNT_V2:'), u64(a.balance), u64(a.nonce), Buffer.from(address), Buffer.from([a.is_contract ? 1 : 0])];
  if (a.contract_code_hash !== null) parts.push(Buffer.from('CODE:'), Buffer.from(a.contract_code_hash));
  if (a.is_contract) parts.push(Buffer.from('SROOT:'), hx(a.storage_root));
  parts.push(Buffer.from('HB:'), u64(a.heartbeat_epoch), u16(a.heartbeat_slots), u64(a.heartbeat_final_epoch), u16(a.heartbeat_final_slots));
  parts.push(Buffer.from('LCE:'), u64(a.last_claimed_epoch), Buffer.from('BAN:'), u64(a.banned_at_height), Buffer.from('NODE:'), Buffer.from([a.is_node ? 1 : 0]));
  return H(Buffer.concat(parts));
}
export const addressKey = (address) => H(Buffer.from(`QNET_ADDR:${address}`));

export function plainAccount(over = {}) {
  return {
    balance: '0', nonce: '0', heartbeat_epoch: '0', heartbeat_slots: 0, heartbeat_final_epoch: '0', heartbeat_final_slots: 0,
    last_claimed_epoch: '0', banned_at_height: '0', is_contract: false, is_node: false, contract_code_hash: null, storage_root: null, ...over,
  };
}

// ---------------------------------------------------------------------------------------------- a certified chain

const seed = (label) => new Uint8Array(createHash('sha256').update(label).digest());
export const IDS = ['cs_node_001', 'cs_node_002', 'cs_node_003', 'cs_node_004'];
export const KEYS = Object.fromEntries(IDS.map((id) => [id, ml_dsa65.keygen(seed(`light:${id}`))]));
export const ATTACKER = ml_dsa65.keygen(seed('light:attacker'));
const pkHex = (k) => Buffer.from(k.publicKey).toString('hex');

export function eligibleRawHex(ids) {
  const head = Buffer.alloc(8); head.writeBigUInt64LE(BigInt(ids.length));
  const parts = [head];
  for (const id of ids) {
    const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(id.length));
    const r = Buffer.alloc(4); r.writeUInt32LE(7000);
    parts.push(l, Buffer.from(id), r);
  }
  return Buffer.concat(parts).toString('hex');
}
export const ELIGIBLE = eligibleRawHex(IDS);
export const ENTRIES = IDS.map((id, i) => ({
  node_id: id, wallet: `w_${id}`, reg_height: 90, reg_index: i, node_type: 'super', burn: '', vrf_pk_sha3: sha3_256(KEYS[id].publicKey),
}));
export const REG_ROOT = core.recomputeRegistryRoot(ENTRIES);
export const beaconOf = (j) => H(Buffer.from(`beacon:${j}`));

export function wireSig(nodeId, sig) {
  const len = Buffer.alloc(4); len.writeUInt32LE(sig.length);
  return `dilithium_sig_${nodeId}_${Buffer.concat([len, Buffer.from(sig)]).toString('base64')}`;
}

/** The pin of a chain rooted at K. */
export const pinAt = (K) => ({
  index: K,
  anchors: Object.fromEntries([K, K - 1].map((i) => [String(i), { eligible_raw: ELIGIBLE, beacon: beaconOf(i), registry_root: REG_ROOT }])),
});

const signedCache = new Map();
/** The served proof of macroblock j, signed by a quorum of its committee; `edit` alters the checkpoint after signing. */
export function proofFor(j, stateRoot, { edit = null, signWith = null, anchor = null } = {}) {
  const key = `${j}|${stateRoot}|${anchor}`;
  let base = signedCache.get(key);
  if (!base) {
    const committee = core.sampleCommittee([...IDS].sort(), j, beaconOf(j - 2));
    const cp = {
      index: j, parent_qc: { index: j - 1, checkpoint_hash: H(Buffer.from(`cp:${j - 1}`)) }, window_head_height: j * 90,
      window_mb_hashes: [H(Buffer.from(`mb:${j}`))], state_root: stateRoot, beacon: beaconOf(j),
      epoch_commitment: core.epochCommitment(hx(ELIGIBLE), committee, []), reward_root: '00'.repeat(32), registry_root: REG_ROOT,
      logs_root: '00'.repeat(32), dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
      total_supply: '12000000000000000000', timestamp: 1_700_000_000 + j, proposer: IDS[0], recovery_anchor: anchor,
    };
    const message = new TextEncoder().encode(`QNET_BFT2_VOTE:${core.checkpointHash(cp)}`);
    const signers = committee.slice(0, core.quorumSize(committee.length));
    base = { index: j, checkpoint: cp, eligible_raw: ELIGIBLE, banned: [],
      committee_pubkeys: Object.fromEntries(IDS.map((id) => [id, pkHex(KEYS[id])])),
      qc: { signers, sigs: signers.map((id) => wireSig(id, ml_dsa65.sign(message, KEYS[id].secretKey))) } };
    signedCache.set(key, base);
  }
  const proof = structuredClone(base);
  if (signWith) {
    // An attacker's own keys for the committee's ids: valid signatures, keys the registry does not hold.
    const message = new TextEncoder().encode(`QNET_BFT2_VOTE:${core.checkpointHash(proof.checkpoint)}`);
    proof.committee_pubkeys = Object.fromEntries(IDS.map((id) => [id, pkHex(signWith)]));
    proof.qc.sigs = proof.qc.signers.map((id) => wireSig(id, ml_dsa65.sign(message, signWith.secretKey)));
  }
  if (edit) edit(proof);
  return proof;
}

const reply = (status, body, retryAfterS = null) => ({ status, text: body === undefined ? '' : JSON.stringify(body), retryAfterS });

/**
 * Scripted nodes: `handlers[base](path)` answers {status, body, retryAfterS} or a reply, else the honest chain does
 * (macroblock proofs up to `top`, the registry, /state/certified and /height). Every request is logged in `asked`.
 */
export function network({ nodes, top, stateRootOf, handlers = {}, legacyHeads = false }) {
  const asked = [];
  const honest = (path) => {
    let m;
    if ((m = /^\/api\/v1\/macroblock\/(\d+)\/proof$/.exec(path))) {
      const j = Number(m[1]);
      return j > top ? reply(200, { error: 'macroblock_not_found' }) : reply(200, proofFor(j, stateRootOf(j)));
    }
    if (/^\/api\/v1\/registry\/height\/\d+$/.test(path)) return reply(200, { entries: ENTRIES });
    if (path === '/api/v1/state/certified') {
      return legacyHeads ? reply(404, { error: 'not found' })
        : reply(200, { proof_format: 2, views: [], newest_certified_index: top, finalized_height: top * 90 + 30, applied_height: top * 90 + 80, capture: 'ok' });
    }
    if (path === '/api/v1/height') return reply(200, { height: top * 90 + 60 });
    return reply(404, { error: 'not found' });
  };
  const fetchText = async (url) => {
    const base = nodes.find((n) => url.startsWith(`${n}/`));
    if (!base) throw new TypeError(`not a node: ${url}`);
    const path = url.slice(base.length);
    asked.push([base, path]);
    const custom = handlers[base] ? await handlers[base](path, honest) : undefined;
    if (custom === 'throw') throw new TypeError('fetch failed');
    if (custom) return 'status' in custom && 'text' in custom ? custom : reply(custom.status ?? 200, custom.body, custom.retryAfterS ?? null);
    return honest(path);
  };
  return { fetchText, asked, honest, reply };
}

export const NODES = ['https://n1.test', 'https://n2.test', 'https://n3.test', 'https://n4.test', 'https://n5.test'];

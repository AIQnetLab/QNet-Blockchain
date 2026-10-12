#!/usr/bin/env node
// Known answers for the GALC v2 capsule (galc-capsule-v2.md): the preimage the genesis keys sign, the checkpoint hashes
// and epoch commitments of the two root proofs, a capsule signed by four genesis keys, and capsules each refused for one
// named reason, judged here by an implementation of the acceptance rules of its own (section 6). THE GENESIS KEYS OF THIS
// FILE ARE TEST KEYS, made from labels; no capsule in it verifies under the keys QNet Blockchain embeds. SHA3-256 comes
// from node:crypto, ML-DSA-65 (FIPS 204, deterministic, empty context) from the @noble/post-quantum a client package
// resolves. Checked by the app (__tests__/GalcCapsule.test.js) and, with the node release, by the node.
//
//   node docs/protocols/tools/galc-capsule-v2-vectors.mjs            write ../galc-capsule-v2.vectors.json
//   node docs/protocols/tools/galc-capsule-v2-vectors.mjs --check    exit 1 if the file differs from a fresh run

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../galc-capsule-v2.vectors.json');
// Packages whose @noble/post-quantum signs here; resolved from each package's directory.
const NOBLE_PACKAGES = ['applications/qnet-mobile', 'applications/qnet-wallet/tools/crypto-bundle', 'applications/qnet-explorer/frontend'];

// ---- constants (galc-capsule-v2.md sections 2 to 4) ----

const DOMAIN = 'QNET_GENESIS_CHECKPOINT_v2';
const VERSION = 2;
const MINT_INTERVAL = 10;
const MACROBLOCK_INTERVAL = 90;
const GENESIS_IDS = ['genesis_node_001', 'genesis_node_002', 'genesis_node_003', 'genesis_node_004', 'genesis_node_005'];
const QUORUM = GENESIS_IDS.length - Math.floor((GENESIS_IDS.length - 1) / 3);
const SIGNATURE_BYTES = 3309;
const PUBLIC_KEY_BYTES = 1952;
const CAPSULE_MAX_BYTES = 65536;
const OUTSIDER = 'super_node_vector';
const K = 38960;
const HEAD = K + 3;

const utf8 = (s) => Buffer.from(s, 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const sha3 = (b) => createHash('sha3-256').update(b).digest();
const label = (part) => hex(sha3(utf8(`qnet-galc-capsule-v2/vector/${part}`)));
const HEX32 = /^[0-9a-f]{64}$/;

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

// ---- ML-DSA-65 ----

async function loadMlDsa() {
  for (const p of NOBLE_PACKAGES) {
    const dir = join(REPO, p);
    if (!existsSync(join(dir, 'package.json'))) continue;
    let file;
    try {
      file = createRequire(join(dir, 'package.json')).resolve('@noble/post-quantum/ml-dsa.js');
    } catch {
      continue;
    }
    const { ml_dsa65: ml } = await import(pathToFileURL(file).href);
    return ml;
  }
  throw new Error('no @noble/post-quantum in the client packages: run npm ci in applications/qnet-mobile');
}

const ML = await loadMlDsa();

// Test keys: ML-DSA-65 key generation from SHA3-256("qnet-galc-capsule-v2/test-key/" + id).
const KEYS = Object.fromEntries([...GENESIS_IDS, OUTSIDER].map((id) => {
  const seed = sha3(utf8(`qnet-galc-capsule-v2/test-key/${id}`));
  const { publicKey, secretKey } = ML.keygen(Uint8Array.from(seed));
  return [id, { seed, publicKey: Buffer.from(publicKey), secretKey }];
}));

const rawSign = (keyId, text) => Buffer.from(ML.sign(utf8(text), KEYS[keyId].secretKey, { extraEntropy: false }));
const rawVerify = (keyId, text, sig) => ML.verify(Uint8Array.from(sig), utf8(text), Uint8Array.from(KEYS[keyId].publicKey));

// A consensus signature string as a node writes it: "dilithium_sig_<id>_" + base64([u32 LE len][detached sig][message]
// [u32 LE pk len][pk]); the compact form (HTTP only) drops the key trailer.
function sigString(nameInString, keyId, text, { compact = false } = {}) {
  const msg = utf8(text);
  const sig = rawSign(keyId, text);
  const parts = [u32(sig.length + msg.length), sig, msg];
  if (!compact) parts.push(u32(KEYS[keyId].publicKey.length), KEYS[keyId].publicKey);
  return `dilithium_sig_${nameInString}_${Buffer.concat(parts).toString('base64')}`;
}

// ---- checkpoints (checkpoint_bft.rs Checkpoint::hash, epoch_commitment) ----

function checkpointHash(cp) {
  const parts = [utf8('qnet-checkpoint-v2'), u64(cp.index)];
  if (cp.parent_qc) parts.push(unhex(cp.parent_qc.checkpoint_hash), u64(cp.parent_qc.index));
  parts.push(u64(cp.window_head_height));
  for (const h of cp.window_mb_hashes) parts.push(unhex(h));
  for (const f of ['state_root', 'beacon', 'epoch_commitment', 'reward_root', 'registry_root', 'logs_root', 'dilithium_pk_root',
    'reward_epoch_root']) {
    parts.push(unhex(cp[f]));
  }
  parts.push(u64(cp.total_supply), u64(cp.timestamp), utf8(cp.proposer));
  if (cp.recovery_anchor) parts.push(Buffer.from([1]), u64(cp.recovery_anchor[0]), unhex(cp.recovery_anchor[1]));
  else parts.push(Buffer.from([0]));
  return hex(sha3(Buffer.concat(parts)));
}

function epochCommitment(eligibleRawHex, committee, banned) {
  const raw = unhex(eligibleRawHex);
  const parts = [utf8('qnet-epoch-v2'), u64(raw.length), raw];
  for (const id of [...committee].sort()) parts.push(utf8(id), Buffer.from([0]));
  parts.push(utf8('banned'), u64(banned.length));
  for (const id of [...banned].sort()) parts.push(utf8(id), Buffer.from([0]));
  return hex(sha3(Buffer.concat(parts)));
}

// bincode Vec<EligibleProducer { node_id: String, reputation: u32 }>
function eligibleRaw(ids) {
  return hex(Buffer.concat([u64(ids.length), ...ids.flatMap((id) => [u64(utf8(id).length), utf8(id), u32(7000)])]));
}

function decodeEligible(rawHex) {
  const b = unhex(rawHex);
  if (b.length < 8) return [];
  const count = Number(b.readBigUInt64LE(0));
  const ids = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 8 > b.length) return [];
    const len = Number(b.readBigUInt64LE(off));
    off += 8;
    if (off + len + 4 > b.length) return [];
    ids.push(b.subarray(off, off + len).toString('utf8'));
    off += len + 4;
  }
  return ids;
}

const ELIGIBLE = [...GENESIS_IDS, OUTSIDER];

// The parts of a served proof of macroblock j that bind it to a capsule (section 6.4).
function rootOf(j, { banned = [], eligible = ELIGIBLE, recoveryAnchor = null } = {}) {
  const raw = eligibleRaw(ELIGIBLE);
  const cp = {
    index: j,
    parent_qc: { checkpoint_hash: label(`parent/${j}`), index: j - 1 },
    window_head_height: j * MACROBLOCK_INTERVAL,
    window_mb_hashes: [0, 1, 2].map((i) => label(`block/${j}/${i}`)),
    state_root: label(`state/${j}`),
    beacon: label(`beacon/${j}`),
    epoch_commitment: epochCommitment(raw, ELIGIBLE, banned),
    reward_root: label(`reward/${j}`),
    registry_root: label(`registry/${j}`),
    logs_root: label(`logs/${j}`),
    dilithium_pk_root: label(`pk/${j}`),
    reward_epoch_root: label(`reward-epoch/${j}`),
    total_supply: 1234567890123456,
    timestamp: 1790000000 + j,
    proposer: GENESIS_IDS[j % GENESIS_IDS.length],
    recovery_anchor: recoveryAnchor,
  };
  // `eligible` other than the committed set: the bytes a node serves do not match the commitment.
  return { index: j, checkpoint: cp, eligible_raw: eligibleRaw(eligible), committee: ELIGIBLE.slice(), banned };
}

function preimage(f) {
  return [DOMAIN, f.version, f.network_id, f.mb_index, f.mb_hash, f.committee_digest_anchor, f.committee_digest_pred,
    f.minted_at_height, f.cp_hash_anchor, f.cp_hash_pred].join(':');
}

// ---- the acceptance rules, judged independently of the clients (section 6) ----

function checksProblem(c, headHint, networkId) {
  if (c.version !== VERSION) return 'version';
  if (c.network_id !== networkId) return 'network_id';
  if (!Number.isSafeInteger(c.mb_index) || c.mb_index < 2) return 'index';
  if (c.mb_index % MINT_INTERVAL !== 0) return 'interval';
  if (c.minted_at_height !== c.mb_index * MACROBLOCK_INTERVAL) return 'minted_at_height';
  for (const f of ['mb_hash', 'committee_digest_anchor', 'committee_digest_pred', 'cp_hash_anchor', 'cp_hash_pred']) {
    if (!HEX32.test(String(c[f]))) return 'shape';
  }
  if (!Array.isArray(c.sigs) || c.sigs.length < QUORUM || c.sigs.length > GENESIS_IDS.length) return 'signature_count';
  if (Number.isSafeInteger(headHint) && c.mb_index > headHint + 2) return 'above_head';
  if (Buffer.byteLength(JSON.stringify(c)) > CAPSULE_MAX_BYTES) return 'shape';
  return null;
}

function validSigners(c) {
  const text = preimage(c);
  const valid = new Set();
  for (const [gid, s] of c.sigs) {
    if (valid.has(gid) || !GENESIS_IDS.includes(gid) || !s.startsWith('dilithium_sig_')) continue;
    const part = s.slice('dilithium_sig_'.length);
    const sep = part.lastIndexOf('_');
    if (part.slice(0, sep) !== gid) continue;
    const payload = Buffer.from(part.slice(sep + 1), 'base64');
    const len = payload.readUInt32LE(0);
    if (len < SIGNATURE_BYTES || payload.length < 4 + len) continue;
    if (rawVerify(gid, text, payload.subarray(4, 4 + SIGNATURE_BYTES))) valid.add(gid);
  }
  return valid;
}

// The 32-byte hashes of a root's checkpoint are lowercase hex (section 7.3), the eligible bytes hex: the checkpoint hash
// decodes hex in any case, so another spelling would hash the same and be kept as served.
const ROOT_HASHES = ['state_root', 'beacon', 'epoch_commitment', 'reward_root', 'registry_root', 'logs_root', 'dilithium_pk_root',
  'reward_epoch_root'];
function rootShapeOk(root) {
  const cp = root.checkpoint;
  return ROOT_HASHES.every((f) => HEX32.test(String(cp[f]))) && HEX32.test(String(cp.parent_qc.checkpoint_hash))
    && cp.window_mb_hashes.every((h) => HEX32.test(String(h))) && /^(?:[0-9a-f]{2})*$/.test(root.eligible_raw);
}

function rootProblem(j, root, cpHash) {
  const cp = root.checkpoint;
  if (!rootShapeOk(root)) return 'root_shape';
  if (root.index !== j || Math.floor(cp.window_head_height / MACROBLOCK_INTERVAL) !== j) return 'root_index';
  if (checkpointHash(cp) !== cpHash) return 'cp_hash';
  if (cp.recovery_anchor) return 'recovery_anchor';
  if (epochCommitment(root.eligible_raw, root.committee, root.banned) !== cp.epoch_commitment) return 'epoch_commitment';
  if (decodeEligible(root.eligible_raw).length === 0) return 'eligible';
  return null;
}

function judge(c, headHint, roots, networkId) {
  const problem = checksProblem(c, headHint, networkId);
  if (problem) return problem;
  if (validSigners(c).size < QUORUM) return 'signatures';
  for (const [j, cpHash] of [[c.mb_index, c.cp_hash_anchor], [c.mb_index - 1, c.cp_hash_pred]]) {
    const r = rootProblem(j, roots[j], cpHash);
    if (r) return r;
  }
  return 'accepted';
}

// ---- build ----

function build() {
  const networkId = label('network');
  const roots = { [K]: rootOf(K), [K - 1]: rootOf(K - 1, { banned: ['super_node_banned_vector'] }) };
  const cpA = checkpointHash(roots[K].checkpoint);
  const cpP = checkpointHash(roots[K - 1].checkpoint);
  const fields = (over = {}) => ({
    version: VERSION, network_id: networkId, mb_index: K, mb_hash: label(`mb/${K}`),
    committee_digest_anchor: label(`committee-digest/${K}`), committee_digest_pred: label(`committee-digest/${K - 1}`),
    minted_at_height: K * MACROBLOCK_INTERVAL, cp_hash_anchor: cpA, cp_hash_pred: cpP, ...over,
  });

  const F = fields();
  const otherPreimage = fields({ mb_index: K + MINT_INTERVAL, minted_at_height: (K + MINT_INTERVAL) * MACROBLOCK_INTERVAL });
  const cpFields = fields({ cp_hash_anchor: label('another-checkpoint') });
  const recoveryRoots = { ...roots, [K]: rootOf(K, { recoveryAnchor: [K - 6, label('recovery-anchor')] }) };
  const raFields = fields({ cp_hash_anchor: checkpointHash(recoveryRoots[K].checkpoint) });
  const epochRoots = { ...roots, [K - 1]: rootOf(K - 1, { banned: ['super_node_banned_vector'], eligible: GENESIS_IDS }) };
  // The same checkpoint of K with its registry root in capitals: it hashes to cpA all the same.
  const upperCheckpoint = { ...roots[K].checkpoint, registry_root: roots[K].checkpoint.registry_root.toUpperCase() };
  const upperRoots = { ...roots, [K]: { ...roots[K], checkpoint: upperCheckpoint } };

  const signatures = {};
  const add = (name, ...args) => { signatures[name] = sigString(...args); };
  for (const id of GENESIS_IDS) add(`capsule/${id}`, id, id, preimage(F));
  for (const id of GENESIS_IDS.slice(0, 4)) add(`capsule/${id}/compact`, id, id, preimage(F), { compact: true });
  add('capsule/genesis_node_004/named-genesis_node_005', 'genesis_node_005', 'genesis_node_004', preimage(F));
  add('capsule/genesis_node_005/named-genesis_node_004', 'genesis_node_004', 'genesis_node_005', preimage(F));
  add(`capsule/${OUTSIDER}`, OUTSIDER, OUTSIDER, preimage(F));
  add('other-preimage/genesis_node_004', 'genesis_node_004', 'genesis_node_004', preimage(otherPreimage));
  for (const id of GENESIS_IDS.slice(0, 4)) add(`cp-hash/${id}`, id, id, preimage(cpFields));
  for (const id of GENESIS_IDS.slice(0, 4)) add(`recovery/${id}`, id, id, preimage(raFields));

  const four = (prefix = 'capsule', suffix = '') => GENESIS_IDS.slice(0, 4).map((id) => [id, `${prefix}/${id}${suffix}`]);
  const g = (n) => [`genesis_node_00${n}`, `capsule/genesis_node_00${n}`];
  const caseOf = (name, stage, expect, f, sigs, { headHint = HEAD, caseRoots = null, httpOnly = false } = {}) => ({
    name, stage, expect, headHint, ...(httpOnly ? { httpOnly } : {}), capsule: { ...f, sigs }, ...(caseRoots ? { roots: caseRoots } : {}),
  });
  const cases = [
    caseOf('four genesis signatures', 'accepted', 'accepted', F, four()),
    caseOf('five genesis signatures, in any order', 'accepted', 'accepted', F, [g(5), g(3), g(1), g(4), g(2)]),
    caseOf('key trailers dropped (the HTTP form)', 'accepted', 'accepted', F, four('capsule', '/compact'), { httpOnly: true }),
    caseOf('an id listed twice, four distinct ids', 'accepted', 'accepted', F, [g(1), g(1), g(2), g(3), g(4)]),
    caseOf('K two above the head', 'accepted', 'accepted', F, four(), { headHint: K - 2 }),
    caseOf('version 1', 'checks', 'version', fields({ version: 1 }), four()),
    caseOf('another network', 'checks', 'network_id', fields({ network_id: label('other-network') }), four()),
    caseOf('K below 2', 'checks', 'index', fields({ mb_index: 0, minted_at_height: 0 }), four()),
    caseOf('K not a multiple of the interval', 'checks', 'interval',
      fields({ mb_index: K + 1, minted_at_height: (K + 1) * MACROBLOCK_INTERVAL }), four()),
    caseOf('minted_at_height not K*90', 'checks', 'minted_at_height', fields({ minted_at_height: K * MACROBLOCK_INTERVAL + 1 }), four()),
    caseOf('K three above the head', 'checks', 'above_head', F, four(), { headHint: K - 3 }),
    caseOf('three entries', 'checks', 'signature_count', F, four().slice(0, 3)),
    caseOf('six entries', 'checks', 'signature_count', F, [g(1), g(2), g(3), g(4), g(5), [OUTSIDER, `capsule/${OUTSIDER}`]]),
    caseOf('a hash in capitals', 'checks', 'shape', fields({ mb_hash: F.mb_hash.toUpperCase() }), four()),
    caseOf('an id listed twice, three distinct ids', 'signatures', 'signatures', F, [g(1), g(1), g(2), g(3)]),
    caseOf('the id in the signature string differs from the listed one', 'signatures', 'signatures', F,
      [g(1), g(2), g(3), ['genesis_node_004', 'capsule/genesis_node_004/named-genesis_node_005']]),
    caseOf('signed with another genesis key', 'signatures', 'signatures', F,
      [g(1), g(2), g(3), ['genesis_node_004', 'capsule/genesis_node_005/named-genesis_node_004']]),
    caseOf('a signer that is no genesis node', 'signatures', 'signatures', F, [g(1), g(2), g(3), [OUTSIDER, `capsule/${OUTSIDER}`]]),
    caseOf('a signature over another preimage', 'signatures', 'signatures', F,
      [g(1), g(2), g(3), ['genesis_node_004', 'other-preimage/genesis_node_004']]),
    caseOf('the proof of K hashes to another checkpoint', 'roots', 'cp_hash', cpFields, four('cp-hash')),
    caseOf('the eligible set of K-1 does not match its epoch commitment', 'roots', 'epoch_commitment', F, four(),
      { caseRoots: epochRoots }),
    caseOf('the signed checkpoint of K carries a recovery anchor', 'roots', 'recovery_anchor', raFields, four('recovery'),
      { caseRoots: recoveryRoots }),
    caseOf('a root hash of K in capitals', 'roots', 'root_shape', F, four(), { caseRoots: upperRoots }),
  ];

  const wire = (c) => ({ ...c, sigs: c.sigs.map(([id, name]) => [id, signatures[name]]) });
  return {
    about: 'Known answers for the GALC v2 capsule: the preimage the genesis keys sign, the checkpoint hashes and epoch '
      + 'commitments of the proofs of K and K-1 it binds, one accepted capsule in its wire form, and capsules each accepted '
      + 'or refused for one named reason. Checked by the app (__tests__/GalcCapsule.test.js) and, with the node release, by the node.',
    spec: 'docs/protocols/galc-capsule-v2.md',
    generator: 'docs/protocols/tools/galc-capsule-v2-vectors.mjs',
    testKeys: 'TEST KEYS. The five genesis keys and the outsider key below are made from labels (ML-DSA-65 key generation '
      + 'from SHA3-256 of "qnet-galc-capsule-v2/test-key/" + id); they are not the keys QNet Blockchain embeds, and no '
      + 'capsule here verifies under those. networkId is a label too, not the hash of block 0.',
    encodings: 'Hashes are lowercase hex. Signatures are consensus signature strings, "dilithium_sig_<id>_" + base64 of '
      + '[u32 LE length][ML-DSA-65 signature, 3309 bytes, deterministic, empty context][the preimage][u32 LE 1952][public key]; '
      + 'the compact form ends after the preimage. A case lists each signature by its name in `signatures`; `capsule` '
      + 'is the first case in the wire form. Case roots default to `roots`.',
    constants: {
      domain: DOMAIN, version: VERSION, mintInterval: MINT_INTERVAL, macroblockInterval: MACROBLOCK_INTERVAL,
      genesisCount: GENESIS_IDS.length, quorum: QUORUM, capsuleMaxBytes: CAPSULE_MAX_BYTES,
      mldsa65: { publicKeyBytes: PUBLIC_KEY_BYTES, signatureBytes: SIGNATURE_BYTES },
    },
    keys: [...GENESIS_IDS, OUTSIDER].map((id) => ({ id, seed: hex(KEYS[id].seed), publicKey: hex(KEYS[id].publicKey) })),
    networkId,
    headHint: HEAD,
    roots,
    checkpointHashes: { [K]: cpA, [K - 1]: cpP },
    epochCommitments: { [K]: roots[K].checkpoint.epoch_commitment, [K - 1]: roots[K - 1].checkpoint.epoch_commitment },
    preimages: [
      { fields: F, preimage: preimage(F) },
      { fields: fields({ mb_index: 10, minted_at_height: 900 }), preimage: preimage(fields({ mb_index: 10, minted_at_height: 900 })) },
    ],
    capsule: wire(cases[0].capsule),
    signatures,
    cases,
  };
}

function selfCheck(v) {
  if (QUORUM !== 4) throw new Error('quorum');
  for (const [j, h] of Object.entries(v.checkpointHashes)) {
    if (checkpointHash(v.roots[j].checkpoint) !== h) throw new Error(`checkpoint hash ${j}`);
  }
  const wire = (c) => ({ ...c, sigs: c.sigs.map(([id, name]) => [id, v.signatures[name]]) });
  for (const c of v.cases) {
    if (c.capsule.sigs.some(([, name]) => typeof v.signatures[name] !== 'string')) throw new Error(`${c.name}: unknown signature`);
    const got = judge(wire(c.capsule), c.headHint, c.roots || v.roots, v.networkId);
    if (got !== c.expect) throw new Error(`${c.name}: judged ${got}, expected ${c.expect}`);
  }
  if (JSON.stringify(v.capsule) !== JSON.stringify(wire(v.cases[0].capsule))) throw new Error('capsule');
}

function main(argv) {
  const vectors = build();
  selfCheck(vectors);
  const text = `${JSON.stringify(vectors, null, 2)}\n`;
  if (argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUT} differs from a fresh run`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUT} is up to date`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${vectors.cases.length} cases, ${Object.keys(vectors.signatures).length} signatures`);
}

main(process.argv.slice(2));

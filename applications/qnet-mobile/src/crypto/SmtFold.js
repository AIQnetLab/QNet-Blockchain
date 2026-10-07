/**
 * Account/storage SMT proof fold — the device half of a consensus rule.
 *
 * Mirrors Rust `StateMerkleTree::verify_leaf_proof`: the state tree collapses depths
 * 0..216 into BUCKETS (leaves sharing the leading 40 key bits, folded as a mini-merkle
 * of tagged leaves sha3(0xB5||key||value)), and hashes only the top 40 levels.
 * A proof is one continuous walk: (len-40) in-bucket steps with positional flags,
 * then exactly 40 tree steps whose flags MUST equal the key's leading bits
 * (tree depth d splits on key bit 255-d, i.e. bits 39..0 counted from the top).
 * An all-zero leaf value means ABSENCE: the seed is the default (empty) bucket hash
 * and the walk is exactly 40 steps.
 *
 * Lives in its own module with no React Native imports so the jest pin exercises THIS
 * function rather than a copy of it.
 */

const PROOF_DEPTH = 40;
const BUCKET_DEPTH = 216;
const BUCKET_TAG_HEX = 'b5';
const ZERO32 = '0'.repeat(64);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

let defaultBucketCache = null;
function defaultBucketHash(sha3_256) {
  if (defaultBucketCache) return defaultBucketCache;
  let d = ZERO32;
  for (let i = 0; i < BUCKET_DEPTH; i++) {
    d = sha3_256(concatBytes(hexToBytes(d), hexToBytes(d)));
  }
  defaultBucketCache = d;
  return d;
}

/**
 * @param {string} leafHashHex   hex leaf hash (all-zero = proof of absence)
 * @param {string} keyHashHex    hex 32-byte key the path is derived from
 * @param {Array}  proof         entries of {sibling: hex, is_right: bool}; length
 *                               40 + in-bucket steps (0 for a single-entry bucket)
 * @param {string} root          expected hex root
 * @param {Function} sha3_256    bytes-in/hex-out SHA3-256
 * @returns {boolean}
 */
function smtFold(leafHashHex, keyHashHex, proof, root, sha3_256) {
  if (!Array.isArray(proof)) return false;
  if (proof.length < PROOF_DEPTH || proof.length > PROOF_DEPTH + 64) return false;
  const bucketSteps = proof.length - PROOF_DEPTH;

  let current;
  if (leafHashHex === ZERO32) {
    if (bucketSteps !== 0) return false;
    current = defaultBucketHash(sha3_256);
  } else {
    current = sha3_256(hexToBytes(BUCKET_TAG_HEX + keyHashHex + leafHashHex));
  }

  for (let i = 0; i < proof.length; i++) {
    const isRight = proof[i].is_right;
    if (i >= bucketSteps) {
      const depth = BUCKET_DEPTH + (i - bucketSteps);
      const bit = 255 - depth;
      const byteIdx = bit >> 3;
      const bitIdx = 7 - (bit % 8);
      const kByte = parseInt(keyHashHex.substring(byteIdx * 2, byteIdx * 2 + 2), 16);
      const expectedBit = ((kByte >> bitIdx) & 1) === 1;
      if (isRight !== expectedBit) return false;
    }
    const sib = hexToBytes(proof[i].sibling);
    const cur = hexToBytes(current);
    current = sha3_256(concatBytes(isRight ? sib : cur, isRight ? cur : sib));
  }
  return current === root;
}

// ── Certified state proofs (proof_format 2) ─────────────────────────────────────────────────────────
// A node names the committee-certified macroblock whose state root its proof folds to. These checks read the
// answer strictly, rebuild every leaf from every field, and fold to the root the CALLER verified through the
// light client, never to the root the node served. Mirror of qnet-state tree_proof.rs (verify_leaf).

const ABSENCE_BUCKET_ENTRIES_MAX = 64;
const BUCKET_KEY_HEX = PROOF_DEPTH / 4; // a bucket is named by the leading 40 key bits: 10 hex characters
const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = 18446744073709551615n;
const CODE_HASH_MAX = 1024;
const CERTIFIED_PROOF_FORMAT = 2;
const PROOF_KINDS = new Set(['inclusion', 'absence', 'absence_in_bucket']);

function utf8Bytes(s) {
  const out = [];
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function concatAll(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u64Le(v) {
  let x = BigInt(v);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

const u16Le = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);

/** A u64 as a node serves it (decimal text, or a whole number within the safe range) as decimal text; else null. */
function u64Of(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(v)) return null;
  return BigInt(v) <= U64_MAX ? v : null;
}

const u16Of = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : null);

/** SMT key of an account: sha3_256("QNET_ADDR:" + address). */
function addressKeyHash(address, sha3) {
  return sha3(utf8Bytes('QNET_ADDR:' + address));
}

/** SMT key of a contract storage entry: sha3_256("QNET_STORAGE_KEY:" + key). */
function storageKeyHash(key, sha3) {
  return sha3(utf8Bytes('QNET_STORAGE_KEY:' + key));
}

/** Leaf of a stored contract value: sha3_256("QNET_STORAGE_VAL:" + raw value). */
function storageLeafValue(value, sha3) {
  return sha3(utf8Bytes('QNET_STORAGE_VAL:' + value));
}

/**
 * The account leaf over EVERY field the node hashes (hash_account, QNET_ACCOUNT_V2): nothing defaults to zero.
 * `f`: { balance, nonce, is_contract, contract_code_hash (string | null), storage_root (hex, contracts only),
 * heartbeat_epoch, heartbeat_slots, heartbeat_final_epoch, heartbeat_final_slots, last_claimed_epoch,
 * banned_at_height, is_node }; u64 values as decimal text or safe whole numbers.
 */
function accountLeafHash(address, f, sha3) {
  const parts = [
    utf8Bytes('QNET_ACCOUNT_V2:'), u64Le(f.balance), u64Le(f.nonce), utf8Bytes(address),
    Uint8Array.of(f.is_contract ? 1 : 0),
  ];
  if (typeof f.contract_code_hash === 'string') parts.push(utf8Bytes('CODE:'), utf8Bytes(f.contract_code_hash));
  if (f.is_contract) parts.push(utf8Bytes('SROOT:'), hexToBytes(f.storage_root));
  parts.push(
    utf8Bytes('HB:'), u64Le(f.heartbeat_epoch), u16Le(f.heartbeat_slots), u64Le(f.heartbeat_final_epoch),
    u16Le(f.heartbeat_final_slots),
    utf8Bytes('LCE:'), u64Le(f.last_claimed_epoch),
    utf8Bytes('BAN:'), u64Le(f.banned_at_height),
    utf8Bytes('NODE:'), Uint8Array.of(f.is_node ? 1 : 0),
  );
  return sha3(concatAll(parts));
}

const stepsWellFormed = (steps) => Array.isArray(steps)
  && steps.every((s) => s && typeof s === 'object' && HEX32.test(s.sibling) && typeof s.is_right === 'boolean');

// The PROOF_DEPTH tree steps from a bucket hash to the root, each flag bound to the key's own bit.
function foldTreeSteps(keyHashHex, seedHex, steps, sha3) {
  let current = seedHex;
  for (let i = 0; i < steps.length; i++) {
    const bit = 255 - (BUCKET_DEPTH + i);
    const kByte = parseInt(keyHashHex.substring((bit >> 3) * 2, (bit >> 3) * 2 + 2), 16);
    const expectedBit = ((kByte >> (7 - (bit % 8))) & 1) === 1;
    if (steps[i].is_right !== expectedBit) return null;
    const sib = hexToBytes(steps[i].sibling);
    const cur = hexToBytes(current);
    current = sha3(concatBytes(steps[i].is_right ? sib : cur, steps[i].is_right ? cur : sib));
  }
  return current;
}

// Mini-merkle over a bucket's sorted tagged leaves: pairwise H(l||r), an odd one promotes unchanged.
function bucketFold(level, sha3) {
  let cur = level;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? sha3(concatBytes(hexToBytes(cur[i]), hexToBytes(cur[i + 1]))) : cur[i]);
    }
    cur = next;
  }
  return cur[0];
}

/** The key holds `leafHex` (never zero: the zero value is the absence seed and has its own kind). */
function verifyInclusion(keyHashHex, leafHex, steps, root, sha3) {
  if (!HEX32.test(keyHashHex) || !HEX32.test(leafHex) || leafHex === ZERO32 || !stepsWellFormed(steps)) return false;
  return smtFold(leafHex, keyHashHex, steps, root, sha3);
}

/** The key's bucket is empty: the default bucket hash seeds exactly PROOF_DEPTH steps. */
function verifyAbsence(keyHashHex, steps, root, sha3) {
  if (!HEX32.test(keyHashHex) || !stepsWellFormed(steps) || steps.length !== PROOF_DEPTH) return false;
  return smtFold(ZERO32, keyHashHex, steps, root, sha3);
}

/**
 * The key's bucket holds exactly `entries` ([keyHex, leafHex] pairs, 1 to 64, strictly ascending, all in the key's
 * bucket, none the key itself, no zero leaf), so the key is not stored: their bucket fold seeds PROOF_DEPTH steps.
 */
function verifyAbsenceInBucket(keyHashHex, entries, steps, root, sha3) {
  if (!HEX32.test(keyHashHex) || !stepsWellFormed(steps) || steps.length !== PROOF_DEPTH) return false;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > ABSENCE_BUCKET_ENTRIES_MAX) return false;
  const bucket = keyHashHex.slice(0, BUCKET_KEY_HEX);
  let prev = null;
  for (const e of entries) {
    if (!Array.isArray(e) || e.length !== 2 || !HEX32.test(e[0]) || !HEX32.test(e[1])) return false;
    const [k, v] = e;
    if (k.slice(0, BUCKET_KEY_HEX) !== bucket || k === keyHashHex || v === ZERO32) return false;
    if (prev !== null && k <= prev) return false; // fixed-length lowercase hex: text order is byte order
    prev = k;
  }
  const seed = bucketFold(entries.map(([k, v]) => sha3(hexToBytes(BUCKET_TAG_HEX + k + v))), sha3);
  return foldTreeSteps(keyHashHex, seed, steps, sha3) === root;
}

// One proof as served: { kind, steps, entries } from `<prefix>_kind`-style fields, or null when malformed.
function servedProof(kind, steps, entries) {
  if (!PROOF_KINDS.has(kind) || !stepsWellFormed(steps)) return null;
  if (kind === 'inclusion' && (steps.length < PROOF_DEPTH || steps.length > PROOF_DEPTH + 64)) return null;
  if (kind !== 'inclusion' && steps.length !== PROOF_DEPTH) return null;
  if (kind === 'absence_in_bucket') {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > ABSENCE_BUCKET_ENTRIES_MAX) return null;
    const pairs = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object' || !HEX32.test(e.key) || !HEX32.test(e.leaf)) return null;
      pairs.push([e.key, e.leaf]);
    }
    return { kind, steps, entries: pairs };
  }
  if (entries !== undefined && entries !== null) return null;
  return { kind, steps, entries: null };
}

/** Whether `proof` (servedProof) proves `leafHex` (inclusion) or absence (leafHex null) of `keyHashHex` under `root`. */
function foldServed(proof, keyHashHex, leafHex, root, sha3) {
  if (!proof || !HEX32.test(String(root))) return false;
  if (proof.kind === 'inclusion') return leafHex !== null && verifyInclusion(keyHashHex, leafHex, proof.steps, root, sha3);
  if (leafHex !== null) return false;
  if (proof.kind === 'absence') return verifyAbsence(keyHashHex, proof.steps, root, sha3);
  return verifyAbsenceInBucket(keyHashHex, proof.entries, proof.steps, root, sha3);
}

// The macroblock index a certified answer names, with its state height bound to it, or null.
function certifiedIndexOf(body) {
  const index = body.macroblock_index;
  if (!Number.isSafeInteger(index) || index < 1) return null;
  const h = u64Of(body.state_height);
  return h !== null && BigInt(h) === BigInt(index) * 90n ? index : null;
}

// Every account field of a certified answer, read strictly with `prefix` on the u64 balance and nonce names
// ('' for an account answer, 'account_' for a token answer's contract): the fields, or null.
function accountFieldsOf(body, prefix, isContract) {
  const f = {
    balance: u64Of(body[prefix + 'balance']),
    nonce: u64Of(body[prefix + 'nonce']),
    heartbeat_epoch: u64Of(body.heartbeat_epoch),
    heartbeat_slots: u16Of(body.heartbeat_slots),
    heartbeat_final_epoch: u64Of(body.heartbeat_final_epoch),
    heartbeat_final_slots: u16Of(body.heartbeat_final_slots),
    last_claimed_epoch: u64Of(body.last_claimed_epoch),
    banned_at_height: u64Of(body.banned_at_height),
    is_node: body.is_node,
    is_contract: isContract,
    contract_code_hash: body.contract_code_hash === undefined ? null : body.contract_code_hash,
    storage_root: body.storage_root === undefined ? null : body.storage_root,
  };
  const numbers = ['balance', 'nonce', 'heartbeat_epoch', 'heartbeat_slots', 'heartbeat_final_epoch', 'heartbeat_final_slots',
    'last_claimed_epoch', 'banned_at_height'];
  if (numbers.some((k) => f[k] === null)) return null;
  if (typeof f.is_node !== 'boolean' || typeof f.is_contract !== 'boolean') return null;
  if (f.contract_code_hash !== null && (typeof f.contract_code_hash !== 'string' || f.contract_code_hash.length > CODE_HASH_MAX)) return null;
  if (isContract ? !HEX32.test(String(f.storage_root)) : f.storage_root !== null) return null;
  return f;
}

// An absent account's answer names nothing: every value zero, no code, no storage root.
function allZero(f) {
  return f.balance === '0' && f.nonce === '0' && f.heartbeat_epoch === '0' && f.heartbeat_slots === 0
    && f.heartbeat_final_epoch === '0' && f.heartbeat_final_slots === 0 && f.last_claimed_epoch === '0'
    && f.banned_at_height === '0' && !f.is_node && !f.is_contract && f.contract_code_hash === null && f.storage_root === null;
}

/**
 * A certified account answer (proof_format 2) for `address`, read strictly: { ok: true, index, account, fold(root) }
 * where `account` is { exists, balance, nonce, ...every leaf field } and `fold(root)` says whether the proof holds
 * under a root the caller verified for `index`; else { ok: false, reason }. An absence counts only with its proof.
 */
function readCertifiedAccount(body, address, sha3) {
  const no = (reason) => ({ ok: false, reason });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no('malformed');
  if (body.proof_format !== CERTIFIED_PROOF_FORMAT) return no('format');
  if (typeof address !== 'string' || body.address !== address) return no('address');
  const index = certifiedIndexOf(body);
  if (index === null) return no('index');
  const proof = servedProof(body.proof_kind, body.merkle_proof, body.bucket_entries);
  if (!proof || body.exists !== (proof.kind === 'inclusion')) return no('proof');
  if (typeof body.is_contract !== 'boolean') return no('fields');
  const f = accountFieldsOf(body, '', body.is_contract);
  if (!f) return no('fields');
  const key = addressKeyHash(address, sha3);
  let leaf = null;
  if (proof.kind === 'inclusion') leaf = accountLeafHash(address, f, sha3);
  else if (!allZero(f)) return no('fields');
  return {
    ok: true, index, account: { exists: proof.kind === 'inclusion', ...f },
    fold: (root) => foldServed(proof, key, leaf, root, sha3),
  };
}

/**
 * A certified token answer (proof_format 2) for (`contract`, `holder`): { ok: true, index, status, balanceBase,
 * contractNonce, fold(root) } — `status` 'absent' | 'not_contract' | 'contract', `balanceBase` the holder's raw
 * stored balance ('0' when the contract or the holder's entry is proven absent) — else { ok: false, reason }.
 * Level 1 proves the contract account under the root; level 2 proves the holder's entry under the storage root
 * that proven account commits to. A status counts only with its level-1 proof.
 */
function readCertifiedToken(body, contract, holder, sha3) {
  const no = (reason) => ({ ok: false, reason });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no('malformed');
  if (body.proof_format !== CERTIFIED_PROOF_FORMAT) return no('format');
  if (typeof contract !== 'string' || typeof holder !== 'string' || body.contract_address !== contract || body.holder !== holder) {
    return no('address');
  }
  const index = certifiedIndexOf(body);
  if (index === null) return no('index');
  const status = body.contract_status;
  const level1 = servedProof(body.account_proof_kind, body.account_proof, body.account_bucket_entries);
  if (!level1) return no('proof');
  const isContract = status === 'contract';
  const included = level1.kind === 'inclusion';
  const statusHolds = status === 'absent' ? !included : (status === 'not_contract' || isContract) && included;
  if (!statusHolds) return no('status');
  const f = accountFieldsOf(body, 'account_', isContract);
  if (!f) return no('fields');
  const contractKey = addressKeyHash(contract, sha3);
  const contractLeaf = level1.kind === 'inclusion' ? accountLeafHash(contract, f, sha3) : null;
  if (status === 'absent' && !allZero(f)) return no('fields');
  const level2Fields = ['storage_proof_kind', 'storage_proof', 'storage_bucket_entries', 'token_balance'];
  let level2 = null;
  let balanceBase = '0';
  let storageLeaf = null;
  if (isContract) {
    level2 = servedProof(body.storage_proof_kind, body.storage_proof, body.storage_bucket_entries);
    if (!level2 || typeof body.token_balance !== 'string' || body.token_balance.length > 64) return no('proof');
    if (level2.kind === 'inclusion') {
      balanceBase = body.token_balance;
      storageLeaf = storageLeafValue(body.token_balance, sha3);
    } else if (body.token_balance !== '0') {
      return no('fields');
    }
  } else if (level2Fields.some((k) => body[k] !== undefined && body[k] !== null)) {
    return no('status');
  }
  const storageKey = storageKeyHash('balance:' + holder, sha3);
  return {
    ok: true, index, status, balanceBase, contractNonce: f.nonce,
    fold: (root) => foldServed(level1, contractKey, contractLeaf, root, sha3)
      && (!isContract || foldServed(level2, storageKey, storageLeaf, f.storage_root, sha3)),
  };
}

/**
 * Whether a 200 answer of a balance proof route is the shape a node from before certified proofs serves (it ignores
 * the `mb` query): no proof_format, a boolean proof_valid, a numeric block_height and its proof arrays. Recognised
 * only by that positive shape: a rate limit, an error or anything else is never taken for an old node.
 */
function isLegacyProofBody(body, kind = 'account') {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.proof_format !== undefined) return false;
  if (typeof body.proof_valid !== 'boolean' || typeof body.block_height !== 'number') return false;
  return kind === 'token'
    ? Array.isArray(body.account_proof) && Array.isArray(body.storage_proof)
    : Array.isArray(body.merkle_proof);
}

module.exports = {
  smtFold,
  CERTIFIED_PROOF_FORMAT,
  ABSENCE_BUCKET_ENTRIES_MAX,
  addressKeyHash,
  storageKeyHash,
  storageLeafValue,
  accountLeafHash,
  verifyInclusion,
  verifyAbsence,
  verifyAbsenceInBucket,
  readCertifiedAccount,
  readCertifiedToken,
  isLegacyProofBody,
};

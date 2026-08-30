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

module.exports = { smtFold };

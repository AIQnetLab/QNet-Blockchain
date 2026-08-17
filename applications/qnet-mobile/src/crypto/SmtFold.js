/**
 * Account/storage SMT proof fold — the device half of a consensus rule.
 *
 * Mirrors Rust `StateMerkleTree::verify_proof` / `verify_raw_proof`: SHA3-256 over
 * sibling||current ordered by is_right, walking depth 0..255. Depth i splits on key bit 255-i
 * (`StateMerkleTree::level_bit`), which is what makes a subtree a contiguous key range on the
 * node side; reading bit i instead fails every proof.
 *
 * Lives in its own module with no React Native imports so the jest pin exercises THIS function
 * rather than a copy of it.
 */

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

/**
 * @param {string} leafHashHex   hex leaf hash to fold up
 * @param {string} keyHashHex    hex 32-byte key the path is derived from
 * @param {Array}  proof         256 entries of {sibling: hex, is_right: bool}
 * @param {string} root          expected hex root
 * @param {Function} sha3_256    hex-in/hex-out SHA3-256
 * @returns {boolean}
 */
function smtFold(leafHashHex, keyHashHex, proof, root, sha3_256) {
  if (!Array.isArray(proof)) return false;
  let current = leafHashHex;
  for (let i = 0; i < proof.length; i++) {
    const isRight = proof[i].is_right;
    const bit = 255 - i;
    const byteIdx = bit >> 3;
    const bitIdx = 7 - (bit % 8);
    const kByte = byteIdx < 32 ? parseInt(keyHashHex.substring(byteIdx * 2, byteIdx * 2 + 2), 16) : 0;
    const expectedBit = ((kByte >> bitIdx) & 1) === 1;
    if (isRight !== expectedBit) return false;
    const sib = hexToBytes(proof[i].sibling);
    const cur = hexToBytes(current);
    current = sha3_256(concatBytes(isRight ? sib : cur, isRight ? cur : sib));
  }
  return current === root;
}

module.exports = { smtFold };

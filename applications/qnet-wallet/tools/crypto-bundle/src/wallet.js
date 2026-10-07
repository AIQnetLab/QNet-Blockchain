import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { shake256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  WALLET_SEED_PREFIX,
  eonFromPublicKeyBytes,
  isValidQnetAddress,
  transferPreimage,
} from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
import { assertBytes, zeroize } from './bytes.js';
import { fail } from './errors.js';
import { ML_DSA65, signChecked } from './signing.js';
import { buildContractCall, buildTokenTransfer, toU64String } from './tx.js';

export {
  QNET_CHAIN_TAG, WALLET_SEED_PREFIX, contractCallPreimage, contractDeployPreimage,
} from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
export { eonFromPublicKeyBytes, isValidQnetAddress, transferPreimage };
export { ML_DSA65 };

const SEED_PREFIX_BYTES = utf8ToBytes(WALLET_SEED_PREFIX);
const HEX_DIGITS = utf8ToBytes('0123456789abcdef');

// UTF-8 of mobile walletSeedString(seed): the prefix, then the seed in lowercase hex. Built in a buffer
// because that hex is the seed itself, and a string of it could never be wiped.
function walletSeedBytes(seed) {
  const out = new Uint8Array(SEED_PREFIX_BYTES.length + seed.length * 2);
  out.set(SEED_PREFIX_BYTES);
  let offset = SEED_PREFIX_BYTES.length;
  for (const byte of seed) {
    out[offset++] = HEX_DIGITS[byte >> 4];
    out[offset++] = HEX_DIGITS[byte & 15];
  }
  return out;
}

/** Canonical 32-byte ML-DSA-65 KeyGen seed: SHAKE256(walletSeedString(seed)), as mobile and the node. */
export function walletXi(seed) {
  assertBytes(seed, 64);
  const seedString = walletSeedBytes(seed);
  try {
    return shake256(seedString, { dkLen: 32 });
  } finally {
    zeroize(seedString);
  }
}

/** { address, publicKey, secretKey } of the wallet's QNet identity. The caller zeroizes secretKey. */
export function deriveQnetKeypair(seed) {
  const xi = walletXi(seed);
  try {
    const { publicKey, secretKey } = ml_dsa65.keygen(xi);
    return { address: eonFromPublicKeyBytes(publicKey), publicKey, secretKey };
  } finally {
    zeroize(xi);
  }
}

export function qnetAddressFromPublicKey(publicKey) {
  return eonFromPublicKeyBytes(assertBytes(publicKey, ML_DSA65.PUBLIC_KEY_BYTES));
}

function transferFields(tx) {
  if (!tx || typeof tx !== 'object') fail('INVALID_TRANSFER');
  const { from, to } = tx;
  if (!isValidQnetAddress(from) || !isValidQnetAddress(to)) fail('INVALID_ADDRESS');
  const fields = {
    from,
    to,
    amountNano: toU64String(tx.amountNano),
    nonce: toU64String(tx.nonce),
    gasPrice: toU64String(tx.gasPrice),
    gasLimit: toU64String(tx.gasLimit),
  };
  if (fields.amountNano === '0' || fields.gasPrice === '0' || fields.gasLimit === '0') fail('INVALID_TRANSFER');
  return fields;
}

const preimageOf = (f) => transferPreimage(f.from, f.to, f.amountNano, f.nonce, f.gasPrice, f.gasLimit);

/**
 * Signs a QNC transfer: the preimage is built here from typed fields, never taken from a caller, and
 * the signature is checked under the account key before it is returned.
 * Returns { preimage, signature: Uint8Array(3309) }.
 */
export function signTransfer(tx, secretKey, publicKey) {
  const fields = transferFields(tx);
  const preimage = preimageOf(fields);
  return { preimage, signature: signChecked(fields.from, preimage, secretKey, publicKey) };
}

/**
 * Signs a built-in token transfer ({ from, token, to, amount, nonce, gasPrice?, gasLimit? }), built here by
 * buildTokenTransfer. Returns { tx, preimage, signature: Uint8Array(3309) }; the request is
 * contractCallRequestJson(tx, hex(signature), publicKeyHex or null).
 */
export function signTokenTransfer(fields, secretKey, publicKey) {
  const tx = buildTokenTransfer(fields);
  return { tx, preimage: tx.preimage, signature: signChecked(tx.from, tx.preimage, secretKey, publicKey) };
}

/** Signs a WASM contract call (buildContractCall fields), as signTokenTransfer. */
export function signContractCall(fields, secretKey, publicKey) {
  const tx = buildContractCall(fields);
  return { tx, preimage: tx.preimage, signature: signChecked(tx.from, tx.preimage, secretKey, publicKey) };
}

export function verifyTransferSignature(tx, signature, publicKey) {
  try {
    const fields = transferFields(tx);
    assertBytes(signature, ML_DSA65.SIGNATURE_BYTES);
    assertBytes(publicKey, ML_DSA65.PUBLIC_KEY_BYTES);
    if (eonFromPublicKeyBytes(publicKey) !== fields.from) return false;
    return ml_dsa65.verify(signature, utf8ToBytes(preimageOf(fields)), publicKey);
  } catch {
    return false;
  }
}

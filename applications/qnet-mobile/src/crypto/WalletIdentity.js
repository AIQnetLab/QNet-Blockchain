/**
 * Canonical wallet identity + signed-preimage construction, shared with the node
 * (crypto/genesis_key.rs, crypto/solana_derivation.rs, BlockchainNode::build_canonical_verify_message)
 * and the browser extension. Pure JS: the ML-DSA-65 KeyGen itself runs in the native module, but the
 * seed string it consumes, the address derived from its public key and the bytes this wallet signs all
 * live here, so one golden vector pins all three implementations (__tests__/fix5_kat.test.js).
 */

import { sha512 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Prefix of the canonical seed string the native module SHAKE-256s into the 32-byte KeyGen seed.
export const WALLET_SEED_PREFIX = 'QNET_WALLET_MLDSA65_v1:';

// Chain tag the node prefixes onto EVERY canonical transaction sign-preimage. MUST byte-match
// QNET_CHAIN_ID in core/qnet-state/src/transaction.rs, or every signature this wallet produces
// is rejected as an invalid signature.
export const QNET_CHAIN_TAG = 'q1337|';

/** Canonical seed string: prefix ++ lowercase hex of the 64-byte recovery-phrase seed. */
export function walletSeedString(seedBytes) {
  const hex = Array.from(seedBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return WALLET_SEED_PREFIX + hex;
}

/**
 * EON address from raw ML-DSA-65 public-key bytes: SHA512(pk) → 19 hex ++ "eon" ++ 15 hex, closed by
 * an 8-hex SHA3-256 checksum over those 37 chars. The node enforces eon(pk) == from on every value TX.
 */
export function eonFromPublicKeyBytes(pkBytes) {
  const full = bytesToHex(sha512(pkBytes)); // lowercase hex
  const part1 = full.substring(0, 19);
  const part2 = full.substring(19, 34);
  const checksum = bytesToHex(sha3_256(utf8ToBytes(part1 + 'eon' + part2))).substring(0, 8);
  return `${part1}eon${part2}${checksum}`;
}

const EON_RE = /^[0-9a-f]{19}eon[0-9a-f]{15}[0-9a-f]{8}$/;

/** An EON address as the node accepts it: lowercase, the "eon" marker and the 8-hex SHA3-256 checksum. */
export function isValidQnetAddress(address) {
  if (typeof address !== 'string' || !EON_RE.test(address)) return false;
  return bytesToHex(sha3_256(utf8ToBytes(address.slice(0, 37)))).slice(0, 8) === address.slice(37);
}

// The bytes each transaction kind signs (node/transactions.rs build_canonical_verify_message, pinned by
// __tests__/TxSourcePin.test.js and docs/protocols/tx-v2.vectors.json). Integers go in as decimal digits; TxBuilders.js
// builds and checks the fields. With `expiry` = { networkId, validUntil } a kind signs its V2 form: the chain tag, this
// chain instance's network id (hex of block 0's hash), "|", a `_v2` body that ends in the last height a block may carry it.

const NETWORK_ID_RE = /^[0-9a-f]{64}$/;
const HEIGHT_RE = /^[1-9][0-9]{0,15}$/;

/**
 * The V2 prefix and last height of `expiry` ({ networkId, validUntil: a safe positive integer or its digits }), checked:
 * { prefix, validUntil } with validUntil as digits. Throws TypeError for anything else, so nothing malformed is signed.
 */
export function v2Expiry(expiry) {
  const { networkId, validUntil } = expiry || {};
  const height = typeof validUntil === 'number' && Number.isSafeInteger(validUntil) ? String(validUntil) : validUntil;
  if (typeof networkId !== 'string' || !NETWORK_ID_RE.test(networkId)
      || typeof height !== 'string' || !HEIGHT_RE.test(height) || Number(height) > Number.MAX_SAFE_INTEGER) {
    throw new TypeError('WalletIdentity: invalid expiry');
  }
  return { prefix: `${QNET_CHAIN_TAG}${networkId}|`, validUntil: height };
}

/** The exact bytes a QNC transfer signs. `amountNano` is an integer nano-QNC (1 QNC = 1e9). */
export function transferPreimage(from, to, amountNano, nonce, gasPrice, gasLimit, expiry = null) {
  const fields = `${from}:${to}:${amountNano}:${nonce}:${gasPrice}:${gasLimit}`;
  if (!expiry) return `${QNET_CHAIN_TAG}transfer:${fields}`;
  const v2 = v2Expiry(expiry);
  return `${v2.prefix}transfer_v2:${fields}:${v2.validUntil}`;
}

/** The exact bytes a contract call signs: the calldata the node rebuilds is bound by its SHA3-256. */
export function contractCallPreimage(from, callData, nonce, gasPrice, gasLimit, expiry = null) {
  const dataHash = bytesToHex(sha3_256(utf8ToBytes(callData)));
  const fields = `${from}:${dataHash}:${nonce}:${gasPrice}:${gasLimit}`;
  if (!expiry) return `${QNET_CHAIN_TAG}contract_call:${fields}`;
  const v2 = v2Expiry(expiry);
  return `${v2.prefix}contract_call_v2:${fields}:${v2.validUntil}`;
}

/** The exact bytes a contract deploy signs: `codeHash` is the code_hash its deploy payload carries. */
export function contractDeployPreimage(from, codeHash, nonce, gasPrice, gasLimit, expiry = null) {
  const fields = `${from}:${codeHash}:${nonce}:${gasPrice}:${gasLimit}`;
  if (!expiry) return `${QNET_CHAIN_TAG}contract_deploy:${fields}`;
  const v2 = v2Expiry(expiry);
  return `${v2.prefix}contract_deploy_v2:${fields}:${v2.validUntil}`;
}

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
// __tests__/TxSourcePin.test.js). Integers go in as decimal digits; TxBuilders.js builds and checks the fields.

/** The exact bytes a QNC transfer signs. `amountNano` is an integer nano-QNC (1 QNC = 1e9). */
export function transferPreimage(from, to, amountNano, nonce, gasPrice, gasLimit) {
  return `${QNET_CHAIN_TAG}transfer:${from}:${to}:${amountNano}:${nonce}:${gasPrice}:${gasLimit}`;
}

/** The exact bytes a contract call signs: the calldata the node rebuilds is bound by its SHA3-256. */
export function contractCallPreimage(from, callData, nonce, gasPrice, gasLimit) {
  const dataHash = bytesToHex(sha3_256(utf8ToBytes(callData)));
  return `${QNET_CHAIN_TAG}contract_call:${from}:${dataHash}:${nonce}:${gasPrice}:${gasLimit}`;
}

/** The exact bytes a contract deploy signs: `codeHash` is the code_hash its deploy payload carries. */
export function contractDeployPreimage(from, codeHash, nonce, gasPrice, gasLimit) {
  return `${QNET_CHAIN_TAG}contract_deploy:${from}:${codeHash}:${nonce}:${gasPrice}:${gasLimit}`;
}

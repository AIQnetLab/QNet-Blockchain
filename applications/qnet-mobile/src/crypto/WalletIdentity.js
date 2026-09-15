/**
 * Canonical wallet identity + signed-preimage construction, shared with the node
 * (crypto/genesis_key.rs, crypto/solana_derivation.rs, BlockchainNode::build_canonical_verify_message)
 * and the browser extension. Pure JS: the ML-DSA-65 KeyGen itself runs in the native module, but the
 * seed string it consumes, the address derived from its public key and the bytes this wallet signs all
 * live here, so one golden vector pins all three implementations (__tests__/fix5_kat.test.js).
 */

import CryptoJS from 'crypto-js';
import { sha3_256 } from 'js-sha3';

// Prefix of the canonical seed string the native module SHAKE-256s into the 32-byte KeyGen seed.
export const WALLET_SEED_PREFIX = 'QNET_WALLET_MLDSA65_v1:';

// Chain tag the node prefixes onto EVERY canonical transaction sign-preimage. MUST byte-match
// QNET_CHAIN_ID in core/qnet-state/src/transaction.rs, or every signature this wallet produces
// is rejected as an invalid signature.
export const QNET_CHAIN_TAG = 'q1337|';

/** Canonical seed string: prefix ++ lowercase hex of the 64-byte BIP39 seed. */
export function walletSeedString(seedBytes) {
  const hex = Array.from(seedBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return WALLET_SEED_PREFIX + hex;
}

/**
 * EON address from raw ML-DSA-65 public-key bytes: SHA512(pk) → 19 hex ++ "eon" ++ 15 hex, closed by
 * an 8-hex SHA3-256 checksum over those 37 chars. The node enforces eon(pk) == from on every value TX.
 */
export function eonFromPublicKeyBytes(pkBytes) {
  const full = CryptoJS.SHA512(CryptoJS.lib.WordArray.create(pkBytes)).toString(CryptoJS.enc.Hex);
  const part1 = full.substring(0, 19).toLowerCase();
  const part2 = full.substring(19, 34).toLowerCase();
  const checksum = sha3_256(part1 + 'eon' + part2).substring(0, 8).toLowerCase();
  return `${part1}eon${part2}${checksum}`;
}

/** The exact bytes a QNC transfer signs. `amountNano` is an integer nano-QNC (1 QNC = 1e9). */
export function transferPreimage(from, to, amountNano, nonce, gasPrice, gasLimit) {
  return `${QNET_CHAIN_TAG}transfer:${from}:${to}:${amountNano}:${nonce}:${gasPrice}:${gasLimit}`;
}

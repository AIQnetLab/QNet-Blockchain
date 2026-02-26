/**
 * Bundle entry point for @noble/post-quantum ml_dsa65.
 * Exported as IIFE global: window.QNetDilithium
 *
 * Algorithm: ML-DSA-65 (NIST FIPS 204 / Dilithium3)
 * Sizes: PK=1952, SK=4032, SIG=3309
 * Byte-compatible with:
 *   Android: PQClean DILITHIUM3_CLEAN (CTILDEBYTES=48)
 *   iOS:     PQClean DILITHIUM3_CLEAN (CTILDEBYTES=48)
 *   Rust:    pqcrypto_mldsa::mldsa65
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

export const QNetDilithium = {
  /**
   * Generate a Dilithium-3 keypair.
   * seed (optional): 32-byte Uint8Array for deterministic generation.
   * Returns { publicKey: Uint8Array(1952), secretKey: Uint8Array(4032) }
   */
  keygen(seed) {
    return ml_dsa65.keygen(seed);
  },

  /**
   * Sign a message with Dilithium-3.
   * Returns a 3309-byte DETACHED signature.
   * Identical to PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature().
   */
  sign(message, secretKey) {
    return ml_dsa65.sign(message, secretKey);
  },

  /**
   * Verify a 3309-byte DETACHED Dilithium-3 signature.
   * Identical to PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify().
   * Returns true if valid.
   */
  verify(message, signature, publicKey) {
    return ml_dsa65.verify(signature, message, publicKey);
  },

  PK_SIZE:  1952,
  SK_SIZE:  4032,
  SIG_SIZE: 3309,
};

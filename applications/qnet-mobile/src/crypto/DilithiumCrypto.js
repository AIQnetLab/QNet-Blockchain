/**
 * QNet ML-DSA-65 (FIPS 204) Crypto Module for React Native
 *
 * Provides post-quantum ML-DSA-65 (FIPS 204) signatures via native module.
 * NIST FIPS 204 compliant. Supported on Android (NDK/JNI) and iOS (ObjC bridge).
 *
 * Architecture:
 *   - The wallet key derives from the recovery phrase (WalletIdentity.walletSeedString); the light
 *     node's ping key is random and lives in the Keychain
 *   - Signs light node registration and ping messages
 *   - Signature format matches backend's verify_dilithium_signature()
 *   - ML-DSA-65 (FIPS 204) for wallet TX and node identity (post-quantum)
 *   - Pure post-quantum: no Ed25519 hybrid
 *
 * Backend format expected:
 *   "dilithium_sig_{pseudonym}_{base64([sig_len_LE][signed_msg][pk_len_LE][pk])}"
 */

import { NativeModules, Platform } from 'react-native';
import 'react-native-get-random-values'; // polyfill getRandomValues
import logger from '../utils/logger';

const { DilithiumModule } = NativeModules;

/**
 * Sign a message with Dilithium3 and format for the backend.
 *
 * @param {string} message       - Message to sign
 * @param {string} secretKeyHex  - Hex-encoded Dilithium3 secret key
 * @param {string} publicKeyHex  - Hex-encoded Dilithium3 public key
 * @param {string} nodeId        - Privacy pseudonym (light_mobile_XXXXXXXX)
 * @returns {Promise<string>} Formatted signature: "dilithium_sig_{nodeId}_{base64}"
 */
export async function signWithDilithium(message, secretKeyHex, publicKeyHex, nodeId) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }
  const result = await DilithiumModule.sign(message, secretKeyHex, publicKeyHex, nodeId);
  return result.signature;
}

/**
 * FIX-5: sign a message and return the HEX of the RAW detached ML-DSA-65 signature (3309 bytes = 6618
 * hex chars) — no envelope, no base64, no embedded message, no pubkey. This is what the node's
 * raw-detached value-TX verifier (verify_user_tx_dilithium) expects on the wire.
 * @returns {Promise<string>} hex of the raw 3309-byte detached signature
 */
export async function signDetached(message, secretKeyHex) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }
  const result = await DilithiumModule.signDetached(message, secretKeyHex);
  return result.signature;
}

/**
 * Verify a Dilithium3 signature locally (for testing/debugging).
 */
export async function verifyDilithium(message, signatureHex, publicKeyHex) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }
  return DilithiumModule.verify(message, signatureHex, publicKeyHex);
}

/**
 * Generate a raw Dilithium3 keypair from seed (no AES encryption).
 * Used for ping delegation keys stored in Keychain (hardware-encrypted).
 * @param {string} seed - Deterministic seed string
 * @returns {Promise<{publicKey: string, secretKey: string}>} hex-encoded keys
 */
export async function generateRawDilithiumKeypair(seed) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }
  return DilithiumModule.generateKeypairFromSeed(seed);
}

/**
 * The public key alone for a seed (hex): the determinism check at wallet creation, which must not bring a second
 * copy of the secret key into JavaScript (MPLAT-R2-05). A native build without the method answers through its
 * keypair call, and the secret half is dropped at once.
 * @param {string} seed
 * @returns {Promise<string>}
 */
export async function derivePublicKeyFromSeed(seed) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }
  if (typeof DilithiumModule.publicKeyFromSeed === 'function') {
    const r = await DilithiumModule.publicKeyFromSeed(seed);
    return r && r.publicKey;
  }
  const kp = await DilithiumModule.generateKeypairFromSeed(seed);
  return kp && kp.publicKey;
}

/**
 * Check if Dilithium3 native module is available on this device.
 */
export function isDilithiumAvailable() {
  return (Platform.OS === 'android' || Platform.OS === 'ios') && !!DilithiumModule;
}

/**
 * Run BC vs pqcrypto compatibility test.
 */
export async function runCompatibilityTest() {
  if (!DilithiumModule) return;
  try {
    const result = await DilithiumModule.compatibilityTest();
    logger.log('[COMPAT] isPqclean=' + result.isPqclean + ' sigSize=' + result.sigSize + ' status=' + result.result);
  } catch (e) {
    logger.warn('[COMPAT] test failed:', e.message);
  }
}

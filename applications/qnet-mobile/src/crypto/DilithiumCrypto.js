/**
 * QNet Dilithium3 (ML-DSA-65) Crypto Module for React Native
 *
 * Provides post-quantum CRYSTALS-Dilithium3 signatures via native module.
 * NIST FIPS 204 compliant. Supported on Android (NDK/JNI) and iOS (ObjC bridge).
 *
 * Architecture:
 *   - Keypair deterministically derived from activation code
 *   - Signs light node registration and ping messages
 *   - Signature format matches backend's verify_dilithium_signature()
 *   - Ed25519 (nacl) used for wallet TX, Dilithium3 for node identity
 *   - HYBRID: both Ed25519 + Dilithium3 signatures sent for double security
 *
 * Backend format expected:
 *   "dilithium_sig_{pseudonym}_{base64([sig_len_LE][signed_msg][pk_len_LE][pk])}"
 */

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';

const { DilithiumModule } = NativeModules;

// Storage keys
const DILITHIUM_PK_KEY = 'qnet_dilithium_public_key';
const DILITHIUM_SK_KEY = 'qnet_dilithium_secret_key';

/**
 * Generate or load Dilithium3 keypair for a given activation code.
 * Keypair is deterministic from the code and cached in AsyncStorage.
 * 
 * @param {string} activationCode - QNET-XXXXXX-XXXXXX-XXXXXX format
 * @param {string} password - Wallet password for encrypting the secret key
 * @returns {Promise<{publicKey: string, secretKey: string}>} hex-encoded keys
 */
export async function getOrCreateDilithiumKeypair(activationCode, password) {
  if (!DilithiumModule) {
    throw new Error(
      `DilithiumModule native module not found on ${Platform.OS}. ` +
      'Rebuild the app with the native Dilithium module included.'
    );
  }

  // Check if we already have keys for this activation code
  const storedPk = await AsyncStorage.getItem(`${DILITHIUM_PK_KEY}_${activationCode}`);
  const storedSkEnc = await AsyncStorage.getItem(`${DILITHIUM_SK_KEY}_${activationCode}`);

  if (storedPk && storedSkEnc) {
    try {
      const decrypted = CryptoJS.AES.decrypt(storedSkEnc, password);
      const secretKey = decrypted.toString(CryptoJS.enc.Utf8);
      // Valid pqclean Dilithium3 SK: exactly 4032 raw bytes = 8064 hex chars
      const EXPECTED_SK_HEX_LEN = 4032 * 2;
      if (secretKey && secretKey.length === EXPECTED_SK_HEX_LEN && /^[0-9a-fA-F]+$/.test(secretKey)) {
        return { publicKey: storedPk, secretKey };
      }
      // SK format invalid (e.g. from old Bouncy Castle install) — regenerate
      console.warn('[Dilithium] Stored SK format invalid (length=' + (secretKey ? secretKey.length : 0) + '), regenerating from activation code');
    } catch (e) {
      // Decryption failed — wrong password or corrupted data
      console.warn('[Dilithium] Stored key decryption failed, regenerating');
    }
  }

  // Generate deterministic seed from activation code
  const seed = `QNET_DILITHIUM3_KEYPAIR_${activationCode}`;

  // Generate keypair via native module
  const result = await DilithiumModule.generateKeypairFromSeed(seed);

  // Store public key plaintext (it's public)
  await AsyncStorage.setItem(`${DILITHIUM_PK_KEY}_${activationCode}`, result.publicKey);

  // Encrypt and store secret key
  const encryptedSk = CryptoJS.AES.encrypt(result.secretKey, password).toString();
  await AsyncStorage.setItem(`${DILITHIUM_SK_KEY}_${activationCode}`, encryptedSk);

  console.log(`[Dilithium] Generated ML-DSA-65 keypair (pk=${result.publicKeySize}B, sk=${result.secretKeySize}B)`);

  return { publicKey: result.publicKey, secretKey: result.secretKey };
}

/**
 * Sign a message with Dilithium3 and format for the backend.
 * 
 * @param {string} message - Message to sign
 * @param {string} secretKeyHex - Hex-encoded Dilithium3 secret key
 * @param {string} publicKeyHex - Hex-encoded Dilithium3 public key
 * @param {string} nodeId - Privacy pseudonym (light_mobile_XXXXXXXX)
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
 * Verify a Dilithium3 signature locally (for testing/debugging).
 * 
 * @param {string} message - Original message
 * @param {string} signatureHex - Raw signature hex (not formatted)
 * @param {string} publicKeyHex - Hex-encoded public key
 * @returns {Promise<boolean>} Verification result
 */
export async function verifyDilithium(message, signatureHex, publicKeyHex) {
  if (!DilithiumModule) {
    throw new Error('DilithiumModule native module not found');
  }

  return await DilithiumModule.verify(message, signatureHex, publicKeyHex);
}

/**
 * Check if Dilithium3 native module is available on this device.
 * Supported: Android (NDK/JNI) and iOS (Objective-C bridge).
 * @returns {boolean}
 */
export function isDilithiumAvailable() {
  return (Platform.OS === 'android' || Platform.OS === 'ios') && !!DilithiumModule;
}

/**
 * Run BC vs pqcrypto compatibility test.
 * Outputs PK and SIG hex to logcat (DILITHIUM_COMPAT tag).
 */
export async function runCompatibilityTest() {
  if (!DilithiumModule) return;
  try {
    const result = await DilithiumModule.compatibilityTest();
    // result = { result: "OK:PK_LEN=1952:SIG_LEN=3309:SELF=OK", sigSize: 3309, isPqclean: true }
    console.log('[COMPAT] isPqclean=' + result.isPqclean + ' sigSize=' + result.sigSize + ' status=' + result.result);
  } catch (e) {
    console.warn('[COMPAT] test failed:', e.message);
  }
}

/**
 * Clear stored Dilithium keys for an activation code.
 * @param {string} activationCode 
 */
export async function clearDilithiumKeys(activationCode) {
  await AsyncStorage.removeItem(`${DILITHIUM_PK_KEY}_${activationCode}`);
  await AsyncStorage.removeItem(`${DILITHIUM_SK_KEY}_${activationCode}`);
}


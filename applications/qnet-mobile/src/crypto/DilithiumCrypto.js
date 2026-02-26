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
 *
 * Security:
 *   - Secret key encrypted with AES-256-GCM + PBKDF2 (600,000 iterations, SHA-256)
 *   - Unique random salt per keypair, stored alongside encrypted data
 *   - No CryptoJS — uses react-native-quick-crypto (native bindings) for AES-GCM
 */

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Use react-native-quick-crypto which exposes the Web Crypto API natively.
// Falls back to the global crypto if running in a Hermes/JSI environment
// that already polyfills it (Expo SDK 49+).
import 'react-native-get-random-values'; // polyfill getRandomValues
const subtle = crypto.subtle;

const { DilithiumModule } = NativeModules;

// Storage keys
const DILITHIUM_PK_KEY  = 'qnet_dilithium_public_key';
const DILITHIUM_SK_KEY  = 'qnet_dilithium_secret_key_enc'; // encrypted blob
const DILITHIUM_SALT_KEY = 'qnet_dilithium_salt';

// PBKDF2 parameters — OWASP 2024
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH       = 'SHA-256';
const AES_KEY_BITS      = 256;

// Valid pqclean Dilithium3 SK: 4032 raw bytes = 8064 hex chars
const EXPECTED_SK_HEX_LEN = 4032 * 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive AES-GCM-256 key from password + salt via PBKDF2.
 */
async function deriveAesKey(password, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);

  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt hex-encoded secret key with AES-GCM-256.
 * Returns JSON string: { iv, ciphertext } (both hex-encoded).
 */
async function encryptSecretKey(secretKeyHex, password, saltHex) {
  const key = await deriveAesKey(password, saltHex);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();

  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(secretKeyHex)
  );

  return JSON.stringify({
    iv:         bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(cipherBuf)),
  });
}

/**
 * Decrypt AES-GCM-256 encrypted secret key.
 * Returns hex-encoded secret key string.
 */
async function decryptSecretKey(encryptedJson, password, saltHex) {
  const { iv, ciphertext } = JSON.parse(encryptedJson);
  const key = await deriveAesKey(password, saltHex);

  const plainBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(iv) },
    key,
    hexToBytes(ciphertext)
  );

  return new TextDecoder().decode(plainBuf);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate or load Dilithium3 keypair for a given activation code.
 * Secret key is encrypted with AES-256-GCM + PBKDF2 (600K iterations).
 *
 * @param {string} activationCode - QNET-XXXXXX-XXXXXX-XXXXXX format
 * @param {string} password       - Wallet password (never stored)
 * @returns {Promise<{publicKey: string, secretKey: string}>} hex-encoded keys
 */
export async function getOrCreateDilithiumKeypair(activationCode, password) {
  if (!DilithiumModule) {
    throw new Error(
      `DilithiumModule native module not found on ${Platform.OS}. ` +
      'Rebuild the app with the native Dilithium module included.'
    );
  }

  const pkKey   = `${DILITHIUM_PK_KEY}_${activationCode}`;
  const skKey   = `${DILITHIUM_SK_KEY}_${activationCode}`;
  const saltKey = `${DILITHIUM_SALT_KEY}_${activationCode}`;

  const storedPk      = await AsyncStorage.getItem(pkKey);
  const storedSkEnc   = await AsyncStorage.getItem(skKey);
  const storedSaltHex = await AsyncStorage.getItem(saltKey);

  if (storedPk && storedSkEnc && storedSaltHex) {
    try {
      const secretKey = await decryptSecretKey(storedSkEnc, password, storedSaltHex);

      if (
        secretKey &&
        secretKey.length === EXPECTED_SK_HEX_LEN &&
        /^[0-9a-fA-F]+$/.test(secretKey)
      ) {
        return { publicKey: storedPk, secretKey };
      }

      console.warn('[Dilithium] Stored SK invalid (len=' + (secretKey?.length ?? 0) + '), regenerating');
    } catch (e) {
      console.warn('[Dilithium] Decryption failed (wrong password?), regenerating');
    }
  }

  // Generate deterministic seed from activation code
  const seed = `QNET_DILITHIUM3_KEYPAIR_${activationCode}`;
  const result = await DilithiumModule.generateKeypairFromSeed(seed);

  // Generate fresh random salt for this keypair
  const salt    = crypto.getRandomValues(new Uint8Array(32));
  const saltHex = bytesToHex(salt);

  // Store public key plaintext (it is public by definition)
  await AsyncStorage.setItem(pkKey, result.publicKey);

  // Encrypt secret key with AES-256-GCM + PBKDF2
  const encryptedSk = await encryptSecretKey(result.secretKey, password, saltHex);
  await AsyncStorage.setItem(skKey,   encryptedSk);
  await AsyncStorage.setItem(saltKey, saltHex);

  console.log(`[Dilithium] Generated ML-DSA-65 keypair (pk=${result.publicKeySize}B, sk=${result.secretKeySize}B)`);

  return { publicKey: result.publicKey, secretKey: result.secretKey };
}

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
    console.log('[COMPAT] isPqclean=' + result.isPqclean + ' sigSize=' + result.sigSize + ' status=' + result.result);
  } catch (e) {
    console.warn('[COMPAT] test failed:', e.message);
  }
}

/**
 * Clear stored Dilithium keys for an activation code.
 */
export async function clearDilithiumKeys(activationCode) {
  await AsyncStorage.multiRemove([
    `${DILITHIUM_PK_KEY}_${activationCode}`,
    `${DILITHIUM_SK_KEY}_${activationCode}`,
    `${DILITHIUM_SALT_KEY}_${activationCode}`,
  ]);
}

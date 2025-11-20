/**
 * QNet Dilithium3 WASM Wrapper for React Native
 * Production-ready post-quantum signatures
 */

import { Buffer } from 'buffer';

// WASM module will be loaded dynamically
let wasmModule = null;
let isInitialized = false;

/**
 * Initialize Dilithium WASM module
 * Must be called before using any crypto functions
 */
export async function initDilithium() {
  if (isInitialized) {
    return true;
  }
  
  try {
    // Dynamic import of WASM module
    // Note: Requires React Native 0.71+ with Hermes WASM support
    const wasm = await import('./wasm/qnet_dilithium_wasm');
    await wasm.default(); // Initialize WASM
    wasmModule = wasm;
    isInitialized = true;
    console.log('[Dilithium] ✅ WASM module initialized');
    return true;
  } catch (error) {
    console.error('[Dilithium] ❌ Failed to load WASM module:', error);
    console.error('[Dilithium] ⚠️ Falling back to Ed25519-only mode');
    return false;
  }
}

/**
 * Generate Dilithium3 keypair
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
export async function generateDilithiumKeypair() {
  if (!isInitialized) {
    await initDilithium();
  }
  
  if (!wasmModule) {
    throw new Error('Dilithium WASM module not available');
  }
  
  try {
    const keypair = new wasmModule.Dilithium3Keypair();
    return {
      publicKey: keypair.public_key,
      privateKey: keypair.secret_key
    };
  } catch (error) {
    console.error('[Dilithium] Keypair generation error:', error);
    throw error;
  }
}

/**
 * Sign message with Dilithium3
 * @param {Uint8Array} message - Message to sign
 * @param {string} secretKeyBase64 - Secret key (base64)
 * @returns {Promise<string>} Signature (base64)
 */
export async function signDilithium(message, secretKeyBase64) {
  if (!isInitialized) {
    await initDilithium();
  }
  
  if (!wasmModule) {
    throw new Error('Dilithium WASM module not available');
  }
  
  try {
    return wasmModule.dilithium3_sign(message, secretKeyBase64);
  } catch (error) {
    console.error('[Dilithium] Signing error:', error);
    throw error;
  }
}

/**
 * Verify Dilithium3 signature
 * @param {Uint8Array} message - Original message
 * @param {string} signatureBase64 - Signature (base64)
 * @param {string} publicKeyBase64 - Public key (base64)
 * @returns {Promise<boolean>} True if valid
 */
export async function verifyDilithium(message, signatureBase64, publicKeyBase64) {
  if (!isInitialized) {
    await initDilithium();
  }
  
  if (!wasmModule) {
    throw new Error('Dilithium WASM module not available');
  }
  
  try {
    return wasmModule.dilithium3_verify(message, signatureBase64, publicKeyBase64);
  } catch (error) {
    console.error('[Dilithium] Verification error:', error);
    return false;
  }
}

/**
 * Create hybrid signature (Ed25519 + Dilithium3)
 * @param {Uint8Array} message - Message to sign
 * @param {string} ed25519SigBase64 - Ed25519 signature (base64)
 * @param {string} dilithiumSecretKeyBase64 - Dilithium secret key (base64)
 * @returns {Promise<string>} Hybrid signature JSON
 */
export async function createHybridSignature(message, ed25519SigBase64, dilithiumSecretKeyBase64) {
  if (!isInitialized) {
    await initDilithium();
  }
  
  if (!wasmModule) {
    throw new Error('Dilithium WASM module not available');
  }
  
  try {
    return wasmModule.create_hybrid_signature(message, ed25519SigBase64, dilithiumSecretKeyBase64);
  } catch (error) {
    console.error('[Dilithium] Hybrid signature error:', error);
    throw error;
  }
}

/**
 * Check if Dilithium WASM is available
 * @returns {boolean}
 */
export function isDilithiumAvailable() {
  return isInitialized && wasmModule !== null;
}

/**
 * Get Dilithium3 parameters
 * @returns {Object} Key and signature sizes
 */
export function getDilithiumParams() {
  if (!wasmModule) {
    return {
      publicKeySize: 1952,
      privateKeySize: 4000,
      signatureSize: 3293
    };
  }
  
  return {
    publicKeySize: wasmModule.Dilithium3Keypair.public_key_size(),
    privateKeySize: wasmModule.Dilithium3Keypair.secret_key_size(),
    signatureSize: wasmModule.Dilithium3Keypair.signature_size()
  };
}

export default {
  initDilithium,
  generateDilithiumKeypair,
  signDilithium,
  verifyDilithium,
  createHybridSignature,
  isDilithiumAvailable,
  getDilithiumParams
};


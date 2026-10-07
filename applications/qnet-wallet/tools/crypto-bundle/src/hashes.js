// Primitives the extension needs outside the derivations (vault KDF, Solana PDAs), from the same pinned
// @noble/hashes the derivations use; Argon2id is the pinned hash-wasm WebAssembly build instead.
import { argon2id as wasmArgon2id } from 'hash-wasm';
import { fail } from './errors.js';

export { blake3 } from '@noble/hashes/blake3.js';
export { hmac } from '@noble/hashes/hmac.js';
export { pbkdf2, pbkdf2Async } from '@noble/hashes/pbkdf2.js';
export { sha256, sha512 } from '@noble/hashes/sha2.js';
export { sha3_256, shake256 } from '@noble/hashes/sha3.js';
export { randomBytes } from '@noble/hashes/utils.js';

const isCount = (value, min) => Number.isSafeInteger(value) && value >= min;

/**
 * Argon2id (RFC 9106, version 0x13, no secret, no associated data) in WebAssembly: the same output as
 * @noble/hashes argon2id for the same inputs (test/vault-session-kdf.test.mjs), several times faster.
 * Needs 'wasm-unsafe-eval' in the page and worker CSP.
 * @param {Uint8Array} password at least 1 byte
 * @param {Uint8Array} salt at least 8 bytes
 * @param {{m: number, t: number, p: number, dkLen: number}} options m in KiB (>= 8 * p)
 * @returns {Promise<Uint8Array>} dkLen bytes
 * @throws {CoreError} INVALID_KDF_PARAMS
 */
export async function argon2idAsync(password, salt, { m, t, p, dkLen } = {}) {
  const valid = password instanceof Uint8Array && password.length > 0 && salt instanceof Uint8Array && salt.length >= 8
    && isCount(p, 1) && p <= 255 && isCount(t, 1) && isCount(m, 8 * p) && m <= 4194304 && isCount(dkLen, 4) && dkLen <= 1024;
  if (!valid) fail('INVALID_KDF_PARAMS');
  const out = await wasmArgon2id({
    password, salt, parallelism: p, iterations: t, memorySize: m, hashLength: dkLen, outputType: 'binary',
  });
  if (!(out instanceof Uint8Array) || out.length !== dkLen) fail('INVALID_KDF_PARAMS');
  return out;
}

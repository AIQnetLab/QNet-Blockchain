import {
  bytesToHex as nobleBytesToHex,
  hexToBytes as nobleHexToBytes,
  concatBytes as nobleConcatBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { fail } from './errors.js';

export function assertBytes(value, length) {
  if (!(value instanceof Uint8Array)) fail('INVALID_BYTES');
  if (length !== undefined && value.length !== length) fail('INVALID_LENGTH');
  return value;
}

export const bytesToHex = (bytes) => nobleBytesToHex(assertBytes(bytes));

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) fail('INVALID_HEX');
  return nobleHexToBytes(hex);
}

export function utf8Encode(text) {
  if (typeof text !== 'string') fail('INVALID_TEXT');
  return utf8ToBytes(text);
}

export const concatBytes = (...parts) => nobleConcatBytes(...parts.map((p) => assertBytes(p)));

export const base58Encode = (bytes) => base58.encode(assertBytes(bytes));

export function base58Decode(text) {
  if (typeof text !== 'string' || text.length === 0) fail('INVALID_BASE58');
  try {
    return base58.decode(text);
  } catch {
    return fail('INVALID_BASE58');
  }
}

export const base64Encode = (bytes) => base64.encode(assertBytes(bytes));

export function base64Decode(text) {
  if (typeof text !== 'string') fail('INVALID_BASE64');
  try {
    return base64.decode(text);
  } catch {
    return fail('INVALID_BASE64');
  }
}

// Constant time in the contents for equal lengths; lengths are not secret here.
export function equalBytes(a, b) {
  assertBytes(a);
  assertBytes(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function zeroize(...buffers) {
  for (const b of buffers) if (b instanceof Uint8Array) b.fill(0);
}

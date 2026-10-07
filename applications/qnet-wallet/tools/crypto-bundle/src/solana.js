import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { assertBytes, concatBytes, zeroize } from './bytes.js';
import { CoreError, fail } from './errors.js';

// Account 0 of the Solana path the mobile app uses.
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export const SOLANA_PROGRAMS = {
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ASSOCIATED_TOKEN: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};

const HARDENED = 0x80000000;
const SLIP10_KEY = utf8ToBytes('ed25519 seed');
const PDA_MARKER = utf8ToBytes('ProgramDerivedAddress');

function parseHardenedPath(path) {
  if (typeof path !== 'string' || !/^m(\/[0-9]{1,10}')+$/.test(path)) fail('INVALID_PATH');
  return path.split('/').slice(1).map((segment) => {
    const index = Number(segment.slice(0, -1));
    if (index >= HARDENED) fail('INVALID_PATH');
    return index + HARDENED;
  });
}

/** ed25519 private key by hardened key derivation (hardened-only path). The caller zeroizes the result. */
export function slip10Ed25519(seed, path = SOLANA_DERIVATION_PATH) {
  assertBytes(seed);
  if (seed.length < 16 || seed.length > 64) fail('INVALID_SEED');
  const indices = parseHardenedPath(path);
  let node = hmac(sha512, SLIP10_KEY, seed);
  for (const index of indices) {
    const data = new Uint8Array(37);
    data.set(node.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, index, false);
    const next = hmac(sha512, node.subarray(32), data);
    zeroize(node, data);
    node = next;
  }
  const key = node.slice(0, 32);
  zeroize(node);
  return key;
}

export function solanaAddressFromPublicKey(publicKey) {
  return base58.encode(assertBytes(publicKey, 32));
}

/** 32 bytes of a canonically encoded base58 address, or CoreError INVALID_ADDRESS. */
export function solanaAddressToBytes(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) fail('INVALID_ADDRESS');
  let bytes;
  try {
    bytes = base58.decode(address);
  } catch {
    return fail('INVALID_ADDRESS');
  }
  if (bytes.length !== 32 || base58.encode(bytes) !== address) fail('INVALID_ADDRESS');
  return bytes;
}

export function isValidSolanaAddress(address) {
  try {
    solanaAddressToBytes(address);
    return true;
  } catch {
    return false;
  }
}

/** A transaction signature: canonical base58 of exactly 64 bytes. */
export function isValidSolanaSignature(signature) {
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 88) return false;
  try {
    const bytes = base58.decode(signature);
    return bytes.length === 64 && base58.encode(bytes) === signature;
  } catch {
    return false;
  }
}

/** { address, publicKey, privateKey } of the wallet's Solana account. The caller zeroizes privateKey. */
export function deriveSolanaKeypair(seed) {
  assertBytes(seed, 64);
  const privateKey = slip10Ed25519(seed, SOLANA_DERIVATION_PATH);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { address: base58.encode(publicKey), publicKey, privateKey };
}

/**
 * Ed25519 over a serialized Solana transaction message, verified before it is returned so a broken
 * signer can never emit bytes that leak or fail on chain.
 */
export function signSolanaMessage(message, privateKey) {
  assertBytes(message);
  assertBytes(privateKey, 32);
  const signature = ed25519.sign(message, privateKey);
  const publicKey = ed25519.getPublicKey(privateKey);
  if (!ed25519.verify(signature, message, publicKey)) fail('SIGNATURE_SELF_CHECK_FAILED');
  return signature;
}

export function verifySolanaSignature(signature, message, publicKey) {
  try {
    return ed25519.verify(assertBytes(signature, 64), assertBytes(message), assertBytes(publicKey, 32));
  } catch {
    return false;
  }
}

export function isOnEd25519Curve(bytes) {
  assertBytes(bytes, 32);
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Solana create_program_address: sha256(seeds || programId || marker). CoreError ON_CURVE when the hash
 * is a valid public key, which a program address must never be.
 */
export function createProgramAddress(seeds, programId) {
  if (!Array.isArray(seeds) || seeds.length > 16) fail('INVALID_SEEDS');
  for (const seed of seeds) if (assertBytes(seed).length > 32) fail('INVALID_SEEDS');
  const hash = sha256(concatBytes(...seeds, assertBytes(programId, 32), PDA_MARKER));
  if (isOnEd25519Curve(hash)) fail('ON_CURVE');
  return hash;
}

/** Solana find_program_address: the first off-curve address for bump 255 down to 0. */
export function findProgramAddress(seeds, programId) {
  if (!Array.isArray(seeds) || seeds.length > 15) fail('INVALID_SEEDS');
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return { address: createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump };
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== 'ON_CURVE') throw error;
    }
  }
  return fail('NO_PROGRAM_ADDRESS');
}

export function associatedTokenAddress(owner, mint, tokenProgram = SOLANA_PROGRAMS.TOKEN) {
  const { address } = findProgramAddress(
    [solanaAddressToBytes(owner), solanaAddressToBytes(tokenProgram), solanaAddressToBytes(mint)],
    solanaAddressToBytes(SOLANA_PROGRAMS.ASSOCIATED_TOKEN),
  );
  return base58.encode(address);
}

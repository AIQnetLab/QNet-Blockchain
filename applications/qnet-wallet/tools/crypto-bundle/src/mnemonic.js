import {
  entropyToMnemonic as scureEntropyToMnemonic,
  mnemonicToEntropy as scureMnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic as scureValidateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { assertBytes, zeroize } from './bytes.js';
import { fail } from './errors.js';

export const MNEMONIC_WORD_COUNTS = [12, 24];
const ENTROPY_BYTES = { 12: 16, 24: 32 };
const SEED_SALT = utf8ToBytes('mnemonic');
// The English words are ASCII, so their UTF-8 is already the NFKD form the recovery-phrase seed hashes.
const WORD_BYTES = wordlist.map((word) => utf8ToBytes(word));

// One spelling per phrase: whatever whitespace, case or compatibility forms the user pasted, the words that
// reach the seed derivation are single-spaced lower-case NFKD. Only that canonical form derives the same wallet everywhere:
// the mobile app canonicalizes an imported phrase the same way (R3-XPD-07), while a node derives from the raw
// text of QNET_WALLET_SEED(_FILE) after trimming its ends, so a phrase written there in two lines or with a
// capital is another wallet on the node (R4-XPD-03).
export function canonicalizeMnemonic(input) {
  if (typeof input !== 'string') fail('INVALID_MNEMONIC');
  return input.normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
}

export function validateMnemonic(input) {
  if (typeof input !== 'string') return false;
  const canonical = canonicalizeMnemonic(input);
  if (!MNEMONIC_WORD_COUNTS.includes(canonical.split(' ').length)) return false;
  return scureValidateMnemonic(canonical, wordlist);
}

/** The canonical phrase, or CoreError INVALID_MNEMONIC (wordlist, checksum, 12 or 24 words). */
export function parseMnemonic(input) {
  if (!validateMnemonic(input)) fail('INVALID_MNEMONIC');
  return canonicalizeMnemonic(input);
}

function assertEntropy(entropy) {
  assertBytes(entropy);
  if (entropy.length !== 16 && entropy.length !== 32) fail('INVALID_ENTROPY');
  return entropy;
}

export const mnemonicToEntropy = (input) => scureMnemonicToEntropy(parseMnemonic(input), wordlist);

export const entropyToMnemonic = (entropy) => scureEntropyToMnemonic(assertEntropy(entropy), wordlist);

/** 64-byte recovery-phrase seed, empty passphrase (as mobile and the node). */
export const mnemonicToSeed = (input) => mnemonicToSeedSync(parseMnemonic(input), '');

// The wordlist index of every word of `entropy` (entropy || checksum bits, 11 bits per word), in
// a buffer the caller zeroizes.
function wordIndices(entropy) {
  const words = (entropy.length * 3) / 4;
  const checksum = sha256(entropy);
  const bits = new Uint8Array(entropy.length + 1);
  bits.set(entropy);
  bits[entropy.length] = checksum[0];
  const indices = new Uint16Array(words);
  for (let w = 0; w < words; w++) {
    let index = 0;
    for (let pos = w * 11; pos < w * 11 + 11; pos++) index = (index << 1) | ((bits[pos >> 3] >> (7 - (pos & 7))) & 1);
    indices[w] = index;
  }
  zeroize(checksum, bits);
  return indices;
}

// UTF-8 of the phrase of `entropy` (single spaces, lower case), in a buffer the caller zeroizes: a JS string of
// the phrase could never be wiped.
function phraseBytes(entropy) {
  const indices = wordIndices(entropy);
  try {
    let length = indices.length - 1;
    for (const index of indices) length += WORD_BYTES[index].length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (let w = 0; w < indices.length; w++) {
      if (w > 0) out[offset++] = 0x20;
      const word = WORD_BYTES[indices[w]];
      out.set(word, offset);
      offset += word.length;
    }
    return out;
  } finally {
    indices.fill(0);
  }
}

/** mnemonicToSeed(entropyToMnemonic(entropy)), without the phrase ever existing as a string. */
export function entropyToSeed(entropy) {
  const phrase = phraseBytes(assertEntropy(entropy));
  try {
    return pbkdf2(sha512, phrase, SEED_SALT, { c: 2048, dkLen: 64 });
  } finally {
    zeroize(phrase);
  }
}

export function generateEntropy(wordCount = 12) {
  const length = ENTROPY_BYTES[wordCount];
  if (!length) fail('INVALID_WORD_COUNT');
  return randomBytes(length);
}

// The wallet an earlier version of this extension (2.x, the store's 2.1.x) kept in this browser: read once, to move its
// recovery phrase into the vault (vault.migrateEarlier), then removed (M-4). 2.x kept the phrase twice:
// - the record: chrome.storage.local `encryptedWallet`, {encrypted, salt, iv, version} as byte arrays (sometimes as a
//   JSON string): AES-256-GCM of the wallet's JSON under PBKDF2-SHA256 of the password as typed, 600,000 iterations for
//   version 2 and 100,000 before;
// - the pages' copy: IndexedDB EARLIER_DB, which its setup and popup wrote, {salt, encryptedSeedPhrase: {data, iv}, ...}
//   as base64 of the bytes' UTF-8: AES-256-GCM of the phrase alone under PBKDF2-SHA256 of the password (100,000
//   iterations). Its password change re-encrypted only this copy, so after one only this copy opens with the password
//   the user knows; the record still opens with the first one.
// Only the recovery phrase is taken; the keys both also hold are never decoded. Nothing of 3.x writes either.
import * as core from '../lib/qnet-core.js';
import { WalletError } from './errors.js';

/** Every chrome.storage.local key 2.x wrote (its worker, popup and setup). */
export const EARLIER_KEYS = Object.freeze([
  'encryptedWallet', 'walletExists', 'walletData', 'encryptedActivationCodes', 'wallet', 'isUnlocked', 'lastUnlockTime',
  'currentNetwork', 'mainnet', 'auto_lock_timer', 'connected_sites',
]);
/** The IndexedDB database 2.x's pages kept their copy of the wallet in. */
export const EARLIER_DB = Object.freeze({ NAME: 'QNetWallet', STORE: 'vault', KEY: 'main' });
const WALLET_KEY = 'encryptedWallet';
const ITERATIONS_V1 = 100000;
const ITERATIONS_V2 = 600000;
const ITERATIONS_PAGES = 100000;
const ITERATIONS_RANGE = Object.freeze({ min: 1000, max: 10000000 });
const CIPHERTEXT_MAX = 1 << 20;
const SALT_RANGE = Object.freeze({ min: 16, max: 64 });
const IV_BYTES = 12;
const TAG_BYTES = 16;
// 24 words of at most 8 letters and their spaces, with room for stray whitespace
const PHRASE_MAX_BYTES = 512;
const MNEMONIC_FIELD = new TextEncoder().encode('"mnemonic":"');
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SPACE = 0x20;
// n, r, t: the JSON escapes of a line feed, a carriage return and a tab
const JSON_SPACE_ESCAPES = new Set([0x6e, 0x72, 0x74]);
// A deletion blocked by a connection elsewhere is awaited this long (as the vault's own).
const DELETE_WAIT_MS = 10000;

const storageLocal = () => globalThis.chrome?.storage?.local ?? null;

function idbFactory() {
  const factory = globalThis.indexedDB;
  return factory && typeof factory.open === 'function' ? factory : null;
}

function bytesOf(list, min, max) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return null;
  for (const value of list) if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  return Uint8Array.from(list);
}

// Bytes as 2.x's pages wrote them: base64 of the UTF-8 of a string whose characters are the bytes; read back as its
// decoder did (the UTF-8 form, else the plain base64 bytes).
function binaryOf(text, min, max) {
  if (typeof text !== 'string' || text.length > 4 * Math.ceil((2 * max) / 3)) return null;
  let raw;
  try {
    raw = atob(text);
  } catch {
    return null;
  }
  let chars;
  try {
    chars = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(raw, (ch) => ch.charCodeAt(0)));
  } catch {
    chars = raw;
  }
  if (chars.length < min || chars.length > max) return null;
  const out = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i += 1) {
    const code = chars.charCodeAt(i);
    if (code > 255) return null;
    out[i] = code;
  }
  return out;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A 2.x wallet record as stored, checked: its ciphertext, salt, IV and PBKDF2 iteration count (an explicit `iterations`,
 * else by its version), or null for anything else (a placeholder 2.x wrote when a creation failed, a damaged copy).
 * @param {unknown} stored
 * @returns {{encrypted: Uint8Array, salt: Uint8Array, iv: Uint8Array, iterations: number}|null}
 */
export function parseEarlierWallet(stored) {
  let blob = stored;
  if (typeof blob === 'string') {
    if (blob.length > 8 * CIPHERTEXT_MAX) return null;
    try {
      blob = JSON.parse(blob);
    } catch {
      return null;
    }
  }
  if (!isRecord(blob)) return null;
  const encrypted = bytesOf(blob.encrypted, TAG_BYTES + 1, CIPHERTEXT_MAX);
  const salt = bytesOf(blob.salt, SALT_RANGE.min, SALT_RANGE.max);
  const iv = bytesOf(blob.iv, IV_BYTES, IV_BYTES);
  if (encrypted === null || salt === null || iv === null) return null;
  let iterations = blob.version === 2 ? ITERATIONS_V2 : ITERATIONS_V1;
  if (blob.iterations !== undefined) {
    if (!Number.isSafeInteger(blob.iterations) || blob.iterations < ITERATIONS_RANGE.min || blob.iterations > ITERATIONS_RANGE.max) return null;
    iterations = blob.iterations;
  }
  return { encrypted, salt, iv, iterations };
}

/**
 * The 2.x pages' copy as stored, checked: the sealed recovery phrase with its salt and IV, or null for anything else
 * (no phrase kept, a damaged copy).
 * @param {unknown} stored
 * @returns {{encrypted: Uint8Array, salt: Uint8Array, iv: Uint8Array, iterations: number}|null}
 */
export function parseEarlierCopy(stored) {
  if (!isRecord(stored) || !isRecord(stored.encryptedSeedPhrase)) return null;
  const encrypted = binaryOf(stored.encryptedSeedPhrase.data, TAG_BYTES + 1, TAG_BYTES + PHRASE_MAX_BYTES);
  const salt = binaryOf(stored.salt, SALT_RANGE.min, SALT_RANGE.max);
  const iv = binaryOf(stored.encryptedSeedPhrase.iv, IV_BYTES, IV_BYTES);
  if (encrypted === null || salt === null || iv === null) return null;
  return { encrypted, salt, iv, iterations: ITERATIONS_PAGES };
}

async function readRecord() {
  const local = storageLocal();
  if (local === null) return null;
  let stored;
  try {
    stored = (await local.get(WALLET_KEY))?.[WALLET_KEY];
  } catch {
    return null;
  }
  return stored === undefined || stored === null ? null : parseEarlierWallet(stored);
}

// The 2.x database, open, or null when there is none: never created here (an upgrade from version 0 is aborted, which
// leaves nothing behind). Every path settles.
function openEarlierDb(factory) {
  return new Promise((resolve) => {
    let request;
    try {
      request = factory.open(EARLIER_DB.NAME);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) request.transaction.abort();
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // already closed
  }
}

async function hasEarlierDatabase() {
  const factory = idbFactory();
  if (factory === null) return false;
  if (typeof factory.databases === 'function') {
    try {
      return (await factory.databases()).some((db) => db?.name === EARLIER_DB.NAME);
    } catch {
      // asked by opening instead
    }
  }
  const db = await openEarlierDb(factory);
  if (db !== null) closeQuietly(db);
  return db !== null;
}

// The pages' copy as stored, or undefined when there is none; the connection is closed again.
async function readCopyValue() {
  const factory = idbFactory();
  if (factory === null || !(await hasEarlierDatabase())) return undefined;
  const db = await openEarlierDb(factory);
  if (db === null) return undefined;
  try {
    if (!db.objectStoreNames.contains(EARLIER_DB.STORE)) return undefined;
    return await new Promise((resolve) => {
      try {
        const request = db.transaction(EARLIER_DB.STORE, 'readonly').objectStore(EARLIER_DB.STORE).get(EARLIER_DB.KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  } finally {
    closeQuietly(db);
  }
}

/**
 * The wallet 2.x kept in this browser, checked: its record (parseEarlierWallet) and its pages' copy (parseEarlierCopy),
 * either null when absent or unreadable; null when neither can be read.
 * @returns {Promise<{record: object|null, copy: object|null}|null>}
 */
export async function readEarlierWallet() {
  const [record, stored] = await Promise.all([readRecord(), readCopyValue().catch(() => undefined)]);
  const copy = stored === undefined ? null : parseEarlierCopy(stored);
  return record === null && copy === null ? null : { record, copy };
}

/**
 * Whether anything 2.x wrote is still in this browser: a key in chrome.storage.local (a wallet record or what it left
 * beside one) or its pages' database.
 * @returns {Promise<boolean>}
 */
export async function hasEarlierData() {
  const local = storageLocal();
  if (local !== null) {
    try {
      if (Object.keys((await local.get([...EARLIER_KEYS])) ?? {}).length > 0) return true;
    } catch {
      // asked again below
    }
  }
  return hasEarlierDatabase().catch(() => false);
}

/**
 * Deletes the 2.x pages' database (EARLIER_DB); nothing to do when there is none.
 * @returns {Promise<void>}
 * @throws {WalletError} INTERNAL when the deletion fails or stays blocked
 */
export function deleteEarlierDatabase() {
  return new Promise((resolve, reject) => {
    const factory = idbFactory();
    if (factory === null) {
      resolve();
      return;
    }
    let request;
    try {
      request = factory.deleteDatabase(EARLIER_DB.NAME);
    } catch {
      reject(new WalletError('INTERNAL'));
      return;
    }
    const timer = setTimeout(() => reject(new WalletError('INTERNAL')), DELETE_WAIT_MS);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(new WalletError('INTERNAL'));
    };
  });
}

/**
 * Removes everything 2.x wrote (every key of EARLIER_KEYS and its pages' database) and checks that nothing is left.
 * @returns {Promise<void>}
 * @throws {WalletError} INTERNAL
 */
export async function removeEarlierData() {
  const local = storageLocal();
  if (local === null) throw new WalletError('INTERNAL');
  await local.remove([...EARLIER_KEYS]);
  await deleteEarlierDatabase();
  if (Object.keys((await local.get([...EARLIER_KEYS])) ?? {}).length > 0 || await hasEarlierDatabase()) {
    throw new WalletError('INTERNAL');
  }
}

function indexOf(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j += 1;
    if (j === needle.length) return i;
  }
  return -1;
}

// The bytes of the wallet JSON's "mnemonic" value, copied out in place so the keys beside it are never decoded (a line
// break or tab 2.x kept from a pasted phrase, escaped in its JSON, reads as a space); null when it is missing, holds
// another escape or is too long. The caller zeroizes the copy.
function mnemonicBytes(plain) {
  const at = indexOf(plain, MNEMONIC_FIELD);
  if (at < 0) return null;
  const out = new Uint8Array(PHRASE_MAX_BYTES);
  let length = 0;
  for (let i = at + MNEMONIC_FIELD.length; i < plain.length && length < PHRASE_MAX_BYTES; i += 1) {
    let byte = plain[i];
    if (byte === QUOTE) return out.subarray(0, length);
    if (byte === BACKSLASH) {
      i += 1;
      if (!JSON_SPACE_ESCAPES.has(plain[i])) break;
      byte = SPACE;
    }
    out[length] = byte;
    length += 1;
  }
  core.zeroize(out);
  return null;
}

// The pages' copy is the phrase alone.
const phraseBytes = (plain) => (plain.length <= PHRASE_MAX_BYTES ? plain : null);

// The decrypted bytes of one copy, or null when the password does not open it (the tag refuses a wrong password and a
// changed copy alike).
async function decryptCopy(sealed, secret) {
  const { subtle } = globalThis.crypto;
  const base = await subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt: sealed.salt, iterations: sealed.iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.encrypted));
  } catch {
    return null;
  }
}

// The entropy of a valid 12- or 24-word phrase, else null.
function entropyOf(phrase) {
  if (phrase === null) return null;
  try {
    return core.mnemonicToEntropy(core.parseMnemonic(new TextDecoder('utf-8', { fatal: true }).decode(phrase)));
  } catch {
    return null;
  }
}

/**
 * Opens the 2.x wallet with its password (as typed: 2.x never normalized it), the record first, then its pages' copy,
 * and returns the entropy of the first valid 12- or 24-word recovery phrase; null when the password opens neither. The
 * decrypted bytes and the password bytes are zeroized. The caller zeroizes the entropy and counts the attempt.
 * @param {{record: object|null, copy: object|null}} parsed readEarlierWallet
 * @param {string} password
 * @returns {Promise<Uint8Array|null>}
 * @throws {WalletError} VAULT_CORRUPT when the password opens a copy but none holds a valid recovery phrase
 */
export async function openEarlierWallet(parsed, password) {
  if (typeof password !== 'string' || password.length === 0) return null;
  const secret = new TextEncoder().encode(password);
  let opened = false;
  try {
    for (const [sealed, phraseOf] of [[parsed?.record, mnemonicBytes], [parsed?.copy, phraseBytes]]) {
      if (!sealed) continue;
      const plain = await decryptCopy(sealed, secret);
      if (plain === null) continue;
      opened = true;
      let phrase = null;
      try {
        phrase = phraseOf(plain);
        const entropy = entropyOf(phrase);
        if (entropy !== null) return entropy;
      } finally {
        core.zeroize(plain, phrase);
      }
    }
  } finally {
    core.zeroize(secret);
  }
  if (opened) throw new WalletError('VAULT_CORRUPT');
  return null;
}

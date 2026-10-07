/**
 * Wallet vault, version 4: envelope encryption.
 *
 * A random 256-bit data key (DEK) encrypts the wallet with AES-256-GCM; the vault id is bound in through the
 * AAD. The DEK is wrapped by a key derived from the password (PBKDF2-SHA256, 600k) and, on Android, that wrap
 * is sealed again by a non-exportable Keystore key, so a copy of the app's storage is useless on any other
 * device even with the password. `vault.hw` names that key; a vault sealed by an older one moves to the current
 * one with resealDeviceWrap. Android biometric unlock keeps a second wrap of the DEK under a Keystore key
 * that needs a fingerprint for every use and dies when one is enrolled; it never holds the password.
 * Changing the password rewraps the DEK and leaves the wallet ciphertext as it is.
 *
 * `hw` and `bio` are sealers { name, seal(bytes), open(bytes) } backed by the native module; tests pass fakes.
 */

export const VAULT_V4 = 4;
export const KDF_ITERATIONS = 600_000;
export const DEK_BYTES = 32;

/**
 * Device-key answers that no retry can change (MVA-R3-02): the Keystore key is gone, invalidated, corrupted or not
 * the one that sealed this vault, or the vault names a sealer this build cannot use ('device_key'). Any other
 * failure (a busy or restarting keystore, StrongBox right after boot, a locked device) may open on the next try.
 */
export const PERMANENT_DEVICE_KEY_CODES = Object.freeze(['device_key', 'KEY_MISSING', 'KEY_INVALIDATED', 'KEY_CORRUPTED', 'KEY_MISMATCH']);

/**
 * The device key could not open a sealed key: never a wrong password. `permanent` only when the key can never open
 * it again; otherwise the next try may succeed, and nothing may offer to erase the wallet over it.
 */
export class DeviceKeyError extends Error {
  constructor(message, code = 'device_key') {
    super(message);
    this.name = 'DeviceKeyError';
    this.code = code;
    this.uncounted = true;
    this.permanent = PERMANENT_DEVICE_KEY_CODES.includes(code);
  }
}

/**
 * Stored vault data that is damaged, or not in a shape this build writes: says nothing about the password,
 * so it is never counted as a wrong one.
 */
export class VaultFormatError extends Error {
  constructor(message = 'Malformed vault field') {
    super(message);
    this.name = 'VaultFormatError';
    this.code = 'vault_format';
    this.uncounted = true;
  }
}

const utf8 = (s) => new Uint8Array(Buffer.from(String(s == null ? '' : s), 'utf8'));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

// `bytes`: the exact length the field must decode to, when it has one.
function unhex(h, bytes) {
  if (typeof h !== 'string' || h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new VaultFormatError();
  if (bytes !== undefined && h.length !== bytes * 2) throw new VaultFormatError();
  return new Uint8Array(Buffer.from(h, 'hex'));
}

const IV_BYTES = 12;
const SALT_BYTES = 32;
const WRAP_BYTES = DEK_BYTES + 16; // the DEK and its GCM tag

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

const payloadAad = (id) => utf8(`qnet-vault-v4|${id}`);
const dekAad = (id) => utf8(`qnet-vault-v4-dek|${id}`);
// `purpose` separates record kinds, so one kind of record can never be opened as another.
const recordAad = (id, purpose = 'record') => utf8(`qnet-${purpose}-v4|${id}`);

/** A non-extractable AES-256-GCM key from raw bytes. */
export function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function passwordKey(password, saltHex, iterations) {
  const salt = unhex(saltHex, SALT_BYTES);
  const material = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function gcmEncrypt(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  return { iv, ct };
}

async function gcmDecrypt(key, iv, ct, aad) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
}

export function isVaultV4(v) {
  return !!(v && v.version === VAULT_V4 && typeof v.id === 'string' && v.kdf && v.pw
    && typeof v.iv === 'string' && typeof v.encrypted === 'string');
}

async function wrapForPassword(vault, dek, password, hw) {
  const salt = hex(randomBytes(32));
  const kek = await passwordKey(password, salt, KDF_ITERATIONS);
  const { iv, ct } = await gcmEncrypt(kek, dek, dekAad(vault.id));
  const out = { ...vault, kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt }, pw: { iv: hex(iv) } };
  delete out.hw;
  if (hw) {
    out.pw.ct = hex(await hw.seal(ct));
    out.hw = hw.name;
  } else {
    out.pw.ct = hex(ct);
  }
  return out;
}

/** Encrypts `payload` (string) under the vault's DEK, keeping the id, wraps and biometric wrap. */
export async function sealPayload(vault, dekKey, payload) {
  const { iv, ct } = await gcmEncrypt(dekKey, utf8(payload), payloadAad(vault.id));
  return { ...vault, iv: hex(iv), encrypted: hex(ct), timestamp: Date.now() };
}

/** A new vault for `payload`: fresh id and DEK, wrapped for `password` (and sealed by `hw` when given). */
export async function createVault(payload, password, { hw = null } = {}) {
  const dek = randomBytes(DEK_BYTES);
  try {
    const shell = await wrapForPassword({ version: VAULT_V4, id: hex(randomBytes(16)) }, dek, password, hw);
    const dekKey = await aesKey(dek);
    return { vault: await sealPayload(shell, dekKey, payload), dekKey };
  } finally {
    dek.fill(0);
  }
}

/**
 * The raw DEK, for the caller to import and then zero. Throws on a wrong password (an AES-GCM tag failure),
 * DeviceKeyError when the device key that seals the wrap cannot open it, and VaultFormatError when the stored
 * wrap is damaged in a way no password could explain (checked before the password is tried).
 */
export async function unwrapWithPassword(vault, password, { hw = null } = {}) {
  if (!isVaultV4(vault)) throw new VaultFormatError('Not a version 4 vault');
  if (Number(vault.kdf.iterations) !== KDF_ITERATIONS || vault.kdf.name !== 'PBKDF2-SHA256') throw new VaultFormatError();
  unhex(vault.kdf.salt, SALT_BYTES);
  const iv = unhex(vault.pw.iv, IV_BYTES);
  let wrapped = unhex(vault.pw.ct, vault.hw ? undefined : WRAP_BYTES);
  if (vault.hw) {
    if (!hw || hw.name !== vault.hw) throw new DeviceKeyError('This wallet is sealed by a device key this build cannot use');
    try {
      wrapped = await hw.open(wrapped);
    } catch (e) {
      if (e && e.code === 'SEALED_DAMAGED') throw new VaultFormatError('The sealed key is damaged');
      // No code: not an answer from the Keystore about this key, so not a lost key either.
      throw new DeviceKeyError((e && e.message) || 'The device key could not open the vault', (e && e.code) || 'KEYSTORE');
    }
    if (!wrapped || wrapped.length !== WRAP_BYTES) throw new VaultFormatError();
  }
  const kek = await passwordKey(password, vault.kdf.salt, KDF_ITERATIONS);
  const dek = await gcmDecrypt(kek, iv, wrapped, dekAad(vault.id));
  if (dek.length !== DEK_BYTES) {
    dek.fill(0);
    throw new VaultFormatError('Malformed vault key');
  }
  return dek;
}

/** The raw DEK from the biometric wrap (the native prompt runs inside `bio.open`). */
export async function unwrapWithBio(vault, bio) {
  if (!isVaultV4(vault) || !vault.bio || !vault.bio.ct) throw new Error('Biometric unlock is not set up');
  let dek;
  try {
    dek = await bio.open(unhex(vault.bio.ct));
  } catch (e) {
    throw new DeviceKeyError((e && e.message) || 'Biometric unlock failed', (e && e.code) || 'bio');
  }
  if (!dek || dek.length !== DEK_BYTES) throw new DeviceKeyError('Biometric unlock returned no key', 'bio');
  return dek;
}

/** Decrypts the wallet payload (string); throws on tampering or a key of another vault. */
export async function openPayload(vault, dekKey) {
  const plain = await gcmDecrypt(dekKey, unhex(vault.iv, IV_BYTES), unhex(vault.encrypted), payloadAad(vault.id));
  return Buffer.from(plain).toString('utf8');
}

/**
 * The same vault with its password wrap moved from the device key `from` to `to` (MVA-R4-01): the wrap is opened by
 * `from` and sealed by `to`, and `to` must give back exactly those bytes before the result is returned. Neither the
 * password nor the DEK is needed or touched: the wrap stays encrypted under the password-derived key throughout.
 * Throws DeviceKeyError (with the Keystore's code) when `from` cannot open it or `to` fails the round trip.
 */
export async function resealDeviceWrap(vault, from, to) {
  if (!isVaultV4(vault) || !from || !to || vault.hw !== from.name) throw new VaultFormatError('Not sealed by that key');
  let inner;
  try {
    inner = await from.open(unhex(vault.pw.ct));
  } catch (e) {
    throw new DeviceKeyError((e && e.message) || 'The device key could not open the vault', (e && e.code) || 'KEYSTORE');
  }
  if (!inner || inner.length !== WRAP_BYTES) throw new VaultFormatError();
  try {
    let ct;
    let back;
    try {
      ct = await to.seal(inner);
      back = await to.open(ct);
    } catch (e) {
      throw new DeviceKeyError((e && e.message) || 'The new device key failed', (e && e.code) || 'KEYSTORE');
    }
    const same = !!back && back.length === inner.length && back.every((b, i) => b === inner[i]);
    if (back) back.fill(0);
    if (!same) throw new DeviceKeyError('The new device key did not give the wrap back', 'KEYSTORE');
    return { ...vault, pw: { ...vault.pw, ct: hex(ct) }, hw: to.name };
  } finally {
    inner.fill(0);
  }
}

/** Same DEK and payload under a new password (a new salt, a fresh seal). The biometric wrap is kept. */
export function rewrapPassword(vault, dek, newPassword, { hw = null } = {}) {
  return wrapForPassword(vault, dek, newPassword, hw);
}

/** Adds (or replaces) the biometric wrap of the DEK. */
export async function withBioWrap(vault, dek, bio) {
  return { ...vault, bio: { ct: hex(await bio.seal(dek)) } };
}

export function withoutBioWrap(vault) {
  const out = { ...vault };
  delete out.bio;
  return out;
}

/**
 * The recovery phrase, sealed apart from the wallet payload under the same DEK: opening the wallet (every
 * unlock and every signature) never decrypts it; only the reveal path does.
 */
export async function withMnemonic(vault, dekKey, mnemonic) {
  return { ...vault, seed: await sealRecord(dekKey, vault.id, { mnemonic }, 'mnemonic') };
}

/** The sealed recovery phrase, or null when this vault keeps none apart (an older one: it is in the payload). */
export async function openMnemonic(vault, dekKey) {
  if (!vault || !vault.seed || vault.seed.vault !== vault.id) return null;
  const r = await openRecord(dekKey, vault.seed, 'mnemonic');
  return r && typeof r.mnemonic === 'string' && r.mnemonic ? r.mnemonic : null;
}

/** A small record (the activation code, verified checkpoints) encrypted under the vault's DEK. */
export async function sealRecord(dekKey, vaultId, obj, purpose = 'record') {
  const { iv, ct } = await gcmEncrypt(dekKey, utf8(JSON.stringify(obj)), recordAad(vaultId, purpose));
  return { version: VAULT_V4, vault: vaultId, iv: hex(iv), encrypted: hex(ct) };
}

export async function openRecord(dekKey, record, purpose = 'record') {
  const plain = await gcmDecrypt(dekKey, unhex(record.iv), unhex(record.encrypted), recordAad(record.vault, purpose));
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}

// Encrypted key files for the command line and servers (Node only). A file holds the key's recovery-phrase entropy
// encrypted with AES-256-GCM under a key Argon2id derives from the password, with the parameters of the wallet
// extension's vault (64 MiB, 3 passes, 1 lane). Everything else in the file (name, address, public key, KDF and
// cipher parameters) is bound to the ciphertext as associated data, so a changed file does not open.
// Files live in ~/.qnet/keys (or $QNET_HOME/keys), private to the user where the system has file modes.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { argon2id } from 'hash-wasm';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PASSWORD_MIN_LENGTH, passwordTooShort } from '#mobile/crypto/PasswordStrength.js';
import { QNetError } from './errors.js';
import { keypairFromEntropy, type QNetKeypair } from './keys.js';

export const KEYSTORE_FORMAT = 'qnet-keystore';
export const KEYSTORE_VERSION = 1;
/**
 * The wallet extension's vault parameters (its KDF_DEFAULT): memory in KiB, passes, lanes. Every key file is made
 * with them, and they are also the floor: a file that names less memory or fewer passes is refused.
 */
export const KEYSTORE_KDF = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
// Stored parameters below the floor (KEYSTORE_KDF) or above the ceiling are refused before any KDF runs.
const KDF_CEILING = Object.freeze({ m: 1048576, t: 64, p: 16 });
/** The shortest new key password, in characters: the wallets' new-password rule, compiled from its one source. */
export const PASSWORD_MIN_CHARS: number = PASSWORD_MIN_LENGTH;
const PASSWORD_MAX_CHARS = 1024;
const NAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const POSIX = process.platform !== 'win32';

export interface KeyInfo {
  name: string;
  address: string;
  publicKey: string;
  createdAt: string;
  file: string;
}

interface KeyFile {
  format: string;
  version: number;
  name: string;
  address: string;
  publicKey: string;
  createdAt: string;
  kdf: { alg: string; m: number; t: number; p: number; salt: string };
  cipher: { alg: string; iv: string };
  ciphertext: string;
}

export interface KeystoreOptions {
  /** The QNet directory; default $QNET_HOME, else ~/.qnet. */
  home?: string;
}

export function keystoreDir({ home }: KeystoreOptions = {}): string {
  return path.join(home || process.env.QNET_HOME || path.join(homedir(), '.qnet'), 'keys');
}

function fileOf(name: string, options: KeystoreOptions): string {
  if (!NAME_RE.test(name) || name === '.' || name === '..') throw new QNetError('INVALID_KEY_NAME');
  return path.join(keystoreDir(options), `${name}.json`);
}

// JSON with sorted keys: the associated data is the same text for the same fields, whatever order a file has them in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const aadOf = (f: KeyFile): Buffer => Buffer.from(canonical({
  format: f.format, version: f.version, name: f.name, address: f.address, publicKey: f.publicKey, createdAt: f.createdAt,
  kdf: f.kdf, cipher: f.cipher,
}), 'utf8');

function normalizePassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_CHARS) throw new QNetError('WRONG_PASSWORD');
  return password.normalize('NFKC');
}

/** Refuses a new key password the wallets would refuse: shorter than PASSWORD_MIN_CHARS characters (WEAK_PASSWORD). */
export async function checkNewPassword(password: string): Promise<void> {
  normalizePassword(password);
  if (passwordTooShort(password)) throw new QNetError('WEAK_PASSWORD');
}

async function deriveKey(password: string, kdf: KeyFile['kdf']): Promise<Uint8Array> {
  const salt = Buffer.from(kdf.salt, 'base64');
  return argon2id({
    password: Buffer.from(normalizePassword(password), 'utf8'), salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m,
    hashLength: 32, outputType: 'binary',
  });
}

function parseKeyFile(text: string, expectedName: string): KeyFile {
  let f: KeyFile;
  try {
    f = JSON.parse(text);
  } catch {
    throw new QNetError('KEYSTORE_CORRUPT');
  }
  const b64 = (s: unknown, min: number, max: number) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
    const n = Buffer.from(s, 'base64').length;
    return n >= min && n <= max;
  };
  const kdf = f?.kdf;
  const ok = f && f.format === KEYSTORE_FORMAT && f.version === KEYSTORE_VERSION && f.name === expectedName
    && typeof f.address === 'string' && typeof f.publicKey === 'string' && /^[0-9a-f]{3904}$/.test(f.publicKey)
    && typeof f.createdAt === 'string'
    && kdf && kdf.alg === 'argon2id' && b64(kdf.salt, 16, 32)
    && Number.isSafeInteger(kdf.m) && Number.isSafeInteger(kdf.t) && Number.isSafeInteger(kdf.p)
    && kdf.m >= KEYSTORE_KDF.m && kdf.m >= 8 * kdf.p && kdf.m <= KDF_CEILING.m
    && kdf.t >= KEYSTORE_KDF.t && kdf.t <= KDF_CEILING.t && kdf.p >= KEYSTORE_KDF.p && kdf.p <= KDF_CEILING.p
    && f.cipher?.alg === 'aes-256-gcm' && b64(f.cipher.iv, 12, 12) && b64(f.ciphertext, 32, 48);
  if (!ok) throw new QNetError('KEYSTORE_CORRUPT');
  return f;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function assertPrivate(file: string): Promise<void> {
  if (!POSIX) return;
  const s = await stat(file);
  if ((s.mode & 0o077) !== 0) throw new QNetError('KEY_FILE_PERMISSIONS');
}

// The whole text on disk before the file is named, so a crash never leaves a partial key under its name.
async function writeNew(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Gives the finished file its name without ever replacing one there: a hard link fails when the name exists, even
// when another process created it a moment ago. A file system without hard links gets an exclusive copy instead.
async function placeNew(tmp: string, file: string): Promise<void> {
  try {
    await link(tmp, file);
    return;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') throw new QNetError('KEY_EXISTS');
  }
  try {
    await copyFile(tmp, file, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') throw new QNetError('KEY_EXISTS');
    throw error;
  }
}

/**
 * Stores the key of `entropy` (16 or 32 bytes of recovery-phrase entropy) as `name`, encrypted under `password`
 * (checked with checkNewPassword first) with the KEYSTORE_KDF parameters. Never overwrites a key, also when another
 * process stores one under the same name at the same time (KEY_EXISTS).
 */
export async function createKey(
  { name, entropy, password }: { name: string; entropy: Uint8Array; password: string },
  options: KeystoreOptions = {},
): Promise<KeyInfo> {
  const file = fileOf(name, options);
  if (await exists(file)) throw new QNetError('KEY_EXISTS');
  await checkNewPassword(password);
  const pair = keypairFromEntropy(entropy);
  pair.secretKey.fill(0);
  const params = KEYSTORE_KDF;
  const record: KeyFile = {
    format: KEYSTORE_FORMAT,
    version: KEYSTORE_VERSION,
    name,
    address: pair.address,
    publicKey: bytesToHex(pair.publicKey),
    createdAt: new Date().toISOString(),
    kdf: { alg: 'argon2id', m: params.m, t: params.t, p: params.p, salt: randomBytes(16).toString('base64') },
    cipher: { alg: 'aes-256-gcm', iv: randomBytes(12).toString('base64') },
    ciphertext: '',
  };
  const key = await deriveKey(password, record.kdf);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(record.cipher.iv, 'base64'));
    cipher.setAAD(aadOf(record));
    record.ciphertext = Buffer.concat([cipher.update(entropy), cipher.final(), cipher.getAuthTag()]).toString('base64');
  } finally {
    key.fill(0);
  }
  const dir = keystoreDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(dir, 0o700);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeNew(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await placeNew(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  await assertPrivate(file);
  return { name, address: record.address, publicKey: record.publicKey, createdAt: record.createdAt, file };
}

async function readRecord(name: string, options: KeystoreOptions): Promise<{ record: KeyFile; file: string }> {
  const file = fileOf(name, options);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new QNetError('KEY_NOT_FOUND');
  }
  const record = parseKeyFile(text, name);
  await assertPrivate(file);
  return { record, file };
}

/** A key's public side, without the password. */
export async function readKeyInfo(name: string, options: KeystoreOptions = {}): Promise<KeyInfo> {
  const { record, file } = await readRecord(name, options);
  return { name, address: record.address, publicKey: record.publicKey, createdAt: record.createdAt, file };
}

/** Every key file in the key directory, by name; a damaged file is listed with an empty address. */
export async function listKeys(options: KeystoreOptions = {}): Promise<KeyInfo[]> {
  let names: string[];
  try {
    names = (await readdir(keystoreDir(options))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => NAME_RE.test(n));
  } catch {
    return [];
  }
  const out: KeyInfo[] = [];
  for (const name of names.sort()) {
    try {
      out.push(await readKeyInfo(name, options));
    } catch {
      out.push({ name, address: '', publicKey: '', createdAt: '', file: fileOf(name, options) });
    }
  }
  return out;
}

/** Opens a key: WRONG_PASSWORD for a wrong password or a changed file. Wipe `secretKey` after use. */
export async function unlockKey(name: string, password: string, options: KeystoreOptions = {}): Promise<QNetKeypair> {
  const { record } = await readRecord(name, options);
  const key = await deriveKey(password, record.kdf);
  let entropy: Buffer;
  try {
    const box = Buffer.from(record.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.cipher.iv, 'base64'));
    decipher.setAAD(aadOf(record));
    decipher.setAuthTag(box.subarray(box.length - 16));
    entropy = Buffer.concat([decipher.update(box.subarray(0, box.length - 16)), decipher.final()]);
  } catch {
    throw new QNetError('WRONG_PASSWORD');
  } finally {
    key.fill(0);
  }
  try {
    if (entropy.length !== 16 && entropy.length !== 32) throw new QNetError('KEYSTORE_CORRUPT');
    const pair = keypairFromEntropy(new Uint8Array(entropy.buffer, entropy.byteOffset, entropy.length));
    if (pair.address !== record.address || bytesToHex(pair.publicKey) !== record.publicKey) {
      pair.secretKey.fill(0);
      throw new QNetError('KEYSTORE_CORRUPT');
    }
    return pair;
  } finally {
    entropy.fill(0);
  }
}

// Key files: the password policy, a round trip, a wrong password, every kind of changed file, and file permissions.
// Deriving a file's key takes seconds, so one key file is made and copied for each case that changes it.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import * as node from '../dist/node.js';
import { STRONG_PASSWORD, tempHome, V } from './helpers.mjs';

const POSIX = process.platform !== 'win32';
const golden = () => sdk.recoveryPhraseToEntropy(V.wallet.mnemonic);
let made;

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof sdk.QNetError ? error.code : `not a QNetError: ${error}`;
  }
  return 'no error';
}

// A copy of the key file made once, in a home of its own.
async function copyKey(name = 'dev') {
  const home = await tempHome();
  const dir = node.keystoreDir({ home });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.json`);
  await copyFile(made.info.file, file);
  if (POSIX) await chmod(file, 0o600);
  return { home, file, opts: { home } };
}

async function edit(file, change) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  change(record);
  await writeFile(file, JSON.stringify(record));
}

describe('key files', () => {
  before(async () => {
    const home = await tempHome();
    made = { home, info: await node.createKey({ name: 'dev', entropy: golden(), password: STRONG_PASSWORD }, { home }) };
  });

  it('refuse a password the wallets would refuse: shorter than 8 characters, nothing else', async () => {
    assert.equal(node.PASSWORD_MIN_CHARS, 8);
    for (const weak of ['short', '1234567', 'Wz9#qT!']) {
      assert.equal(await refusal(node.checkNewPassword(weak)), 'WEAK_PASSWORD', weak);
    }
    for (const accepted of ['12345678', 'password', STRONG_PASSWORD]) await node.checkNewPassword(accepted);
  });

  it('store a key that opens with its password and nothing else', async () => {
    const opts = { home: made.home };
    assert.equal(made.info.address, V.wallet.address);
    const pair = await node.unlockKey('dev', STRONG_PASSWORD, opts);
    assert.equal(pair.address, V.wallet.address);
    assert.equal(bytesToHex(pair.publicKey), V.wallet.publicKey);
    assert.equal(await refusal(node.unlockKey('dev', `${STRONG_PASSWORD}x`, opts)), 'WRONG_PASSWORD');
    assert.equal(await refusal(node.unlockKey('missing', STRONG_PASSWORD, opts)), 'KEY_NOT_FOUND');
    const listed = await node.listKeys(opts);
    assert.deepEqual(listed.map((k) => [k.name, k.address]), [['dev', V.wallet.address]]);
    assert.equal((await node.readKeyInfo('dev', opts)).publicKey, V.wallet.publicKey);
  });

  it('use the wallet extension\'s Argon2id parameters, which no option lowers', async () => {
    const home = await tempHome();
    // DEV-R1-14: an option that used to lower them for tests is ignored.
    const info = await node.createKey({ name: 'real', entropy: golden(), password: STRONG_PASSWORD }, { home, kdf: { m: 8, t: 1, p: 1 } });
    const record = JSON.parse(await readFile(info.file, 'utf8'));
    assert.deepEqual({ alg: record.kdf.alg, m: record.kdf.m, t: record.kdf.t, p: record.kdf.p }, { ...node.KEYSTORE_KDF });
    assert.equal(Buffer.from(record.kdf.salt, 'base64').length, 16);
    assert.equal(record.cipher.alg, 'aes-256-gcm');
    assert.equal((await node.unlockKey('real', STRONG_PASSWORD, { home })).address, V.wallet.address);
  });

  // DEV-R1-14: stored parameters below the extension vault's are the floor, refused before any KDF runs.
  it('refuse a file whose parameters are below the floor', async () => {
    for (const [what, change] of [
      ['memory', (r) => { r.kdf.m = 8; }],
      ['memory just below', (r) => { r.kdf.m = node.KEYSTORE_KDF.m - 1; }],
      ['passes', (r) => { r.kdf.t = 1; }],
    ]) {
      const { file, opts } = await copyKey();
      await edit(file, change);
      assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, opts)), 'KEYSTORE_CORRUPT', what);
      assert.equal(await refusal(node.readKeyInfo('dev', opts)), 'KEYSTORE_CORRUPT', what);
    }
  });

  it('never write the secret in the clear', async () => {
    const text = await readFile(made.info.file, 'utf8');
    assert.doesNotMatch(text, new RegExp(bytesToHex(golden())));
    for (const word of new Set(V.wallet.mnemonic.split(' '))) assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`));
  });

  it('refuse a changed file: ciphertext, address, public key, parameters, date', async () => {
    const changes = {
      ciphertext: (r) => {
        const box = Buffer.from(r.ciphertext, 'base64');
        box[0] ^= 1;
        r.ciphertext = box.toString('base64');
      },
      address: (r) => { r.address = sdk.keypairFromEntropy(new Uint8Array(16).fill(9)).address; },
      publicKey: (r) => { r.publicKey = r.publicKey.replace(/^./, (c) => (c === '0' ? '1' : '0')); },
      passes: (r) => { r.kdf.t += 1; },
      iv: (r) => { r.cipher.iv = Buffer.alloc(12, 1).toString('base64'); },
      date: (r) => { r.createdAt = '2000-01-01T00:00:00.000Z'; },
    };
    for (const [what, change] of Object.entries(changes)) {
      const { file, opts } = await copyKey();
      assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, opts)), 'no error', `copy opens before the ${what} change`);
      await edit(file, change);
      assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, opts)), 'WRONG_PASSWORD', what);
    }
  });

  it('refuse a damaged or misnamed file and parameters past the ceiling', async () => {
    const a = await copyKey();
    await writeFile(a.file, '{"format":"qnet-keystore"');
    assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, a.opts)), 'KEYSTORE_CORRUPT');
    const b = await copyKey();
    await rename(b.file, path.join(path.dirname(b.file), 'other.json'));
    assert.equal(await refusal(node.unlockKey('other', STRONG_PASSWORD, b.opts)), 'KEYSTORE_CORRUPT');
    const c = await copyKey();
    await edit(c.file, (r) => { r.kdf.m = 1 << 30; });
    assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, c.opts)), 'KEYSTORE_CORRUPT');
  });

  it('never overwrite a key, and take only plain names', async () => {
    const { opts } = await copyKey();
    const again = (name) => node.createKey({ name, entropy: golden(), password: STRONG_PASSWORD }, opts);
    assert.equal(await refusal(again('dev')), 'KEY_EXISTS');
    for (const name of ['', '../x', 'a/b', 'x'.repeat(33), '.', '..']) assert.equal(await refusal(again(name)), 'INVALID_KEY_NAME', name);
  });

  // DEV-R1-15: a key another process stores under the same name after this one looked is never replaced. The race is
  // made certain by hiding the file from every existence check (stat), so only the final step can see it.
  it('never overwrite a key that appears while another is being stored', async () => {
    const { file, opts } = await copyKey();
    const before = await readFile(file, 'utf8');
    const fsp = createRequire(import.meta.url)('node:fs/promises');
    const realStat = fsp.stat;
    fsp.stat = async (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(file)) throw Object.assign(new Error('hidden by the test'), { code: 'ENOENT' });
      return realStat.call(fsp, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const other = new Uint8Array(16).fill(5);
      assert.equal(await refusal(node.createKey({ name: 'dev', entropy: other, password: STRONG_PASSWORD }, opts)), 'KEY_EXISTS');
    } finally {
      fsp.stat = realStat;
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await node.unlockKey('dev', STRONG_PASSWORD, opts)).address, V.wallet.address);
    const left = (await fsp.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });

  it('keep the file private to the user', { skip: POSIX ? false : 'no file modes on Windows' }, async () => {
    assert.equal((await stat(made.info.file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(made.info.file))).mode & 0o777, 0o700);
    const { file, opts } = await copyKey();
    await chmod(file, 0o644);
    assert.equal(await refusal(node.unlockKey('dev', STRONG_PASSWORD, opts)), 'KEY_FILE_PERMISSIONS');
  });
});

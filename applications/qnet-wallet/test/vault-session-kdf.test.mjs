// The real vault KDFs (R04), without the cheap Argon2id stand-in the other vault-session tests load. The
// bundle's Argon2id is hash-wasm (WebAssembly); @noble/hashes argon2id, which it replaced, is the
// reference: noble reproduces RFC 9106, and the bundle gives noble's output on every vector below. The
// fixed vault-parameter answer was produced by noble before the switch, so v3 vaults written by 3.0.0
// still open. This file runs one full-cost Argon2id (64 MiB, t=3) through the bundle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as core from '../dist/lib/qnet-core.js';
import * as vault from '../dist/background/vault.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const PASSWORD = 'correct horse battery staple';
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);

// The reference comes from the bundle's own pinned dependencies (npm run bundle:install).
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/hashes/argon2.js', import.meta.url);
const noble = existsSync(NOBLE) ? await import(NOBLE.href) : null;
const needsNoble = noble ? {} : { skip: 'run npm run bundle:install' };

// Deterministic inputs over the parameter space: memory, passes and lanes, short and long outputs (over
// 64 bytes Argon2's H' chains BLAKE2b), password and salt lengths.
const PARAMS = [
  [8, 1, 1], [16, 2, 2], [32, 3, 4], [64, 1, 1], [100, 3, 1], [256, 2, 2], [1024, 3, 1], [2048, 1, 4], [4096, 3, 1],
];
const DK_LENS = [4, 16, 32, 64, 65, 100];
const VECTORS = PARAMS.flatMap(([m, t, p], i) => DK_LENS.map((dkLen, j) => {
  const n = i * DK_LENS.length + j;
  const password = core.sha512(Uint8Array.of(1, n)).slice(0, 1 + ((n * 7) % 64));
  const salt = core.sha512(Uint8Array.of(2, n)).slice(0, 8 + ((n * 5) % 25));
  return { m, t, p, dkLen, password, salt };
}));

describe('vault KDF (real cost)', () => {
  it('the noble reference reproduces the RFC 9106 Argon2id test vector', needsNoble, () => {
    const options = {
      m: 32, t: 3, p: 4, dkLen: 32, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4),
    };
    assert.equal(hex(noble.argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), options)),
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('the bundle Argon2id (WebAssembly) gives the noble output on every vector', needsNoble, async () => {
    assert.equal(VECTORS.length, PARAMS.length * DK_LENS.length);
    for (const { m, t, p, dkLen, password, salt } of VECTORS) {
      const expected = hex(noble.argon2id(password, salt, { m, t, p, dkLen }));
      assert.equal(hex(await core.argon2idAsync(password, salt, { m, t, p, dkLen })), expected, `m=${m} t=${t} p=${p} dkLen=${dkLen}`);
    }
    const unicode = core.utf8Encode('pässwörd ключ 密码 🔑'.normalize('NFKC'));
    assert.equal(hex(await core.argon2idAsync(unicode, SALT, { m: 64, t: 3, p: 1, dkLen: 32 })),
      hex(noble.argon2id(unicode, SALT, { m: 64, t: 3, p: 1, dkLen: 32 })));
  });

  it('deriveVaultKey runs Argon2id with m=64 MiB, t=3, p=1 over the UTF-8 password (the noble answer)', async () => {
    const kdf = { ...vault.KDF_DEFAULT, salt: core.base64Encode(SALT) };
    const started = performance.now();
    const key = await vault.deriveVaultKey(PASSWORD, kdf);
    const elapsed = performance.now() - started;
    assert.equal(hex(key), '0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e');
    assert.ok(elapsed < 20000, `took ${elapsed.toFixed(0)} ms`);
  });

  it('the bundle Argon2id refuses malformed parameters before running', async () => {
    const ok = { m: 8, t: 1, p: 1, dkLen: 32 };
    const password = Uint8Array.of(1);
    for (const [pw, salt, options] of [
      [new Uint8Array(0), SALT, ok], ['text', SALT, ok], [password, new Uint8Array(7), ok], [password, SALT, { ...ok, m: 7 }],
      [password, SALT, { ...ok, m: 16, p: 3 }], [password, SALT, { ...ok, t: 0 }], [password, SALT, { ...ok, dkLen: 3 }],
      [password, SALT, { ...ok, m: 8.5 }], [password, SALT, {}],
    ]) {
      await assert.rejects(core.argon2idAsync(pw, salt, options), { name: 'CoreError', code: 'INVALID_KDF_PARAMS' });
    }
  });

  it('deriveVaultKey runs PBKDF2-SHA256 at the stored iterations for a fallback record', async () => {
    const kdf = { alg: 'pbkdf2-sha256', iterations: 600000, salt: core.base64Encode(SALT) };
    const key = await vault.deriveVaultKey(PASSWORD, kdf);
    assert.equal(hex(key), pbkdf2Sync(Buffer.from(PASSWORD, 'utf8'), SALT, 600000, 32, 'sha256').toString('hex'));
  });

  it('refuses a KDF below the floor or above the ceiling without running it', async () => {
    const salt = core.base64Encode(SALT);
    const started = performance.now();
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { ...vault.KDF_DEFAULT, m: 8, salt }), { code: 'KDF_BELOW_FLOOR' });
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { ...vault.KDF_DEFAULT, t: 2, salt }), { code: 'KDF_BELOW_FLOOR' });
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { ...vault.KDF_DEFAULT, p: 2, salt }), { code: 'KDF_BELOW_FLOOR' });
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { alg: 'pbkdf2-sha256', iterations: 1000, salt }),
      { code: 'KDF_BELOW_FLOOR' });
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { ...vault.KDF_DEFAULT, m: 2 ** 31, salt }), { code: 'VAULT_CORRUPT' });
    await assert.rejects(vault.deriveVaultKey(PASSWORD, { ...vault.KDF_DEFAULT, salt: 'AAAA' }), { code: 'VAULT_CORRUPT' });
    assert.ok(performance.now() - started < 5000, 'nothing was derived');
  });
});

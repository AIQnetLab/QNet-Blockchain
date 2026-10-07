// The shipped bundle is exactly what the pinned sources build, and the sources keep the house rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WALLET = path.resolve(HERE, '..');
const TOOL = path.join(WALLET, 'tools/crypto-bundle');
const BUNDLE = path.join(WALLET, 'dist/lib/qnet-core.js');

function filesUnder(dir, pattern) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

describe('crypto bundle build', () => {
  const installed = existsSync(path.join(TOOL, 'node_modules/esbuild'));

  it('rebuilds byte-identical to dist/lib/qnet-core.js', installed ? {} : { skip: 'run npm run bundle:install' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qnet-core-'));
    try {
      const out = path.join(dir, 'qnet-core.js');
      const run = spawnSync(process.execPath, [path.join(TOOL, 'build.js'), '--out', out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(readFileSync(out).equals(readFileSync(BUNDLE)), 'dist/lib/qnet-core.js is stale: npm run build');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins exact dependency versions with a lockfile', () => {
    const pkg = JSON.parse(readFileSync(path.join(TOOL, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'qnet-crypto-bundle');
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(version, /^\d+\.\d+\.\d+$/, name);
    }
    const lock = JSON.parse(readFileSync(path.join(TOOL, 'package-lock.json'), 'utf8'));
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (name) assert.match(entry.integrity || '', /^sha512-/, name);
    }
  });

  it('keeps sources UTF-8 without BOM and LF-only, and the bundle source free of console and unsafe sinks', () => {
    const shipped = filesUnder(path.join(TOOL, 'src'), /\.js$/);
    const all = [...shipped, path.join(TOOL, 'build.js'), path.join(TOOL, 'package.json'), ...filesUnder(HERE, /\.m?js$/)];
    assert.ok(shipped.length >= 10);
    for (const file of all) {
      const text = readFileSync(file, 'utf8');
      assert.notEqual(text.charCodeAt(0), 0xfeff, file);
      assert.equal(text.includes('\r'), false, file);
    }
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/http:\/\//, /\beval\s*\(/, /new\s+Function\s*\(/, /innerHTML/, /insertAdjacentHTML/,
        /document\.write/, /\bconsole\./]) {
        assert.doesNotMatch(text, pattern, file);
      }
    }
  });
});

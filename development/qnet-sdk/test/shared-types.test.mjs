// The declarations of the shared sources (src/shared/) name only values those sources export: a declaration its source
// no longer backs would type-check the SDK against a function the build cannot find.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const SHARED = path.join(ROOT, 'development/qnet-sdk/src/shared');
const SOURCES = { mobile: 'applications/qnet-mobile/src', 'wallet-core': 'applications/qnet-wallet/tools/crypto-bundle/src' };

const declared = (text) => [...text.matchAll(/^export (?:declare )?(?:const|function|class|let|enum) ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const exports = (text) => new Set([
  ...[...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
  ...[...text.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)),
]);

describe('shared-source declarations', () => {
  const files = readdirSync(SHARED, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => f.endsWith('.d.ts'));

  it('cover the shared sources the SDK compiles', () => {
    assert.ok(files.length >= 10, files.join(', '));
  });

  for (const file of files) {
    it(`${file} declares only what its source exports`, () => {
      const [tree, ...rest] = file.split('/');
      const source = path.join(ROOT, SOURCES[tree], rest.join('/').replace(/\.d\.ts$/, '.js'));
      const has = exports(readFileSync(source, 'utf8'));
      const names = declared(readFileSync(path.join(SHARED, file), 'utf8'));
      assert.ok(names.length > 0, file);
      assert.deepEqual(names.filter((n) => !has.has(n)), [], `${path.relative(ROOT, source)} does not export these`);
    });
  }

  it('catch a declaration the source lost', () => {
    assert.deepEqual(declared('export function passwordTooWeak(p: string): boolean;\nexport const A: number;\n'), ['passwordTooWeak', 'A']);
    const has = exports('export const PASSWORD_MIN_LENGTH = 8;\nexport function passwordTooShort(p) {}\nexport { a as b, c };\n');
    assert.deepEqual([...has].sort(), ['PASSWORD_MIN_LENGTH', 'b', 'c', 'passwordTooShort']);
    assert.ok(!has.has('passwordTooWeak'));
  });
});

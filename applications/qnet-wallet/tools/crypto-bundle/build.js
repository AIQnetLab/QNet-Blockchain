#!/usr/bin/env node
// Builds dist/lib/qnet-core.js: one ESM file, compiled from src/ and from the mobile modules it imports by
// relative path. Usage: node build.js [--dev] [--out <file>]
//   store (default): minified, console calls dropped, no sourcemap
//   --dev:           readable, console kept, inline sourcemap (never packaged)
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WALLET = path.resolve(HERE, '../..');
const MOBILE_SRC = path.resolve(WALLET, '../qnet-mobile/src');
const ENTRY = path.join(HERE, 'src/index.js');
const DILITHIUM_SHIM = path.join(HERE, 'src/shims/DilithiumCrypto.js');
const FETCH_SHIM = path.join(HERE, 'src/shims/fetch.js');

// The only mobile sources the bundle may compile; anything else they reach fails the build.
const MOBILE_MODULES = new Set([
  'crypto/WalletIdentity.js',
  'crypto/TxBuilders.js',
  // the new-password rule (length only)
  'crypto/PasswordStrength.js',
  'crypto/QcLightClient.js',
  'crypto/SmtFold.js',
  // the light node messages (identity, consent, owner bind, claim)
  'crypto/NodePreimages.js',
  'config/fees.js',
  'config/genesisConsensus.js',
  // the reserved-name and burn-address rules a token transfer's approval shows
  'utils/tokenSafety.js',
  // tokenSafety's hidden-character rule (hasHiddenCharacter), and the Solana address shape that module imports
  'crypto/OffchainMessage.js',
  'utils/solanaFormat.js',
  // QcLightClient's bounded JSON read (its fetch is this bundle's shims/fetch.js, bounded again)
  'utils/boundedFetch.js',
  // the strict reader of balance and token proof answers (a repeated key refuses one)
  'utils/strictJson.js',
].map((p) => path.join(MOBILE_SRC, p)));

// Text the shipped bundle must never contain.
const FORBIDDEN = [/http:\/\//, /\beval\s*\(/, /new\s+Function\s*\(/, /innerHTML/, /document\.write/];

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const outIndex = args.indexOf('--out');
const outfile = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(WALLET, 'dist/lib/qnet-core.js');

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const sourcesPlugin = {
  name: 'qnet-core-sources',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (a) => {
      if (a.kind === 'entry-point' || a.pluginData?.pinned) return undefined;
      const fromMobile = inside(a.importer, MOBILE_SRC);
      if (fromMobile && /^\.\/DilithiumCrypto(\.js)?$/.test(a.path)) return { path: DILITHIUM_SHIM };
      const relative = a.path.startsWith('.');
      if (!fromMobile && !(relative && inside(a.importer, path.join(HERE, 'src')))) return undefined;
      // Packages a mobile module imports come from this bundle's lockfile, never from qnet-mobile.
      const resolveDir = fromMobile && !relative ? HERE : a.resolveDir;
      const r = await b.resolve(a.path, { kind: a.kind, importer: a.importer, resolveDir, pluginData: { pinned: true } });
      if (r.errors.length > 0) return { errors: r.errors };
      if (inside(r.path, MOBILE_SRC) && !MOBILE_MODULES.has(r.path)) {
        return { errors: [{ text: `mobile module not allowed in qnet-core: ${path.relative(MOBILE_SRC, r.path)}` }] };
      }
      return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
    });
  },
};

if (!existsSync(path.join(HERE, 'node_modules'))) {
  console.error('[ERR][BUILD] run "npm ci" in tools/crypto-bundle first');
  process.exit(1);
}

const result = await build({
  absWorkingDir: HERE,
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome111'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  drop: dev ? [] : ['console', 'debugger'],
  legalComments: 'eof',
  metafile: true,
  write: false,
  logLevel: 'warning',
  // every free `fetch` of the compiled sources (the mobile light client) is the bounded one (R2-EXTQ-05)
  inject: [FETCH_SHIM],
  plugins: [sourcesPlugin],
});

const inputs = Object.keys(result.metafile.inputs).map((input) => path.resolve(HERE, input));
for (const file of inputs) {
  if (!inside(file, HERE) && !MOBILE_MODULES.has(file)) {
    console.error(`[ERR][BUILD] unexpected input ${file}`);
    process.exit(1);
  }
}

const code = result.outputFiles[0].text;
// The dev build keeps the comments esbuild preserves (a dependency's "// src: http://…" note): its check reads the
// code without whole-line comments. The store build has none.
const checked = dev ? code.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n') : code;
for (const pattern of dev ? FORBIDDEN.slice(0, 1) : [...FORBIDDEN, /\bconsole\./]) {
  if (pattern.test(checked)) {
    console.error(`[ERR][BUILD] output contains ${pattern}`);
    process.exit(1);
  }
}

await mkdir(path.dirname(outfile), { recursive: true });
await writeFile(outfile, code);
const sha256 = createHash('sha256').update(code).digest('hex');
const mobileInputs = inputs.filter((file) => MOBILE_MODULES.has(file)).map((file) => path.relative(MOBILE_SRC, file));
console.log(`[INFO][BUILD] ${path.relative(WALLET, outfile)} ${dev ? 'dev' : 'store'} ${(code.length / 1024).toFixed(1)} KiB sha256=${sha256}`);
console.log(`[INFO][BUILD] mobile sources: ${mobileInputs.join(', ')}`);

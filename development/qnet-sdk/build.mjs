#!/usr/bin/env node
// Builds dist/: index.js (web pages and Node), node.js (servers), cli.js (the qnet command), the chunks they share,
// and the type declarations. The transaction builders and the rest of the shared crypto are compiled from their one
// source by path (the mobile app's src and the wallet extension's crypto core), never copied: '#mobile/...' and
// '#wallet-core/...' name them, and anything else those files reach fails the build.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MOBILE_SRC = path.join(ROOT, 'applications/qnet-mobile/src');
const WALLET_CORE = path.join(ROOT, 'applications/qnet-wallet/tools/crypto-bundle/src');
const DILITHIUM_SHIM = path.join(WALLET_CORE, 'shims/DilithiumCrypto.js');
const ALIASES = { '#mobile/': MOBILE_SRC, '#wallet-core/': WALLET_CORE };

// The only shared sources the SDK may compile.
const SHARED = new Set([
  ...[
    'crypto/WalletIdentity.js',
    'crypto/TxBuilders.js',
    'crypto/OffchainMessage.js',
    'crypto/PasswordStrength.js',
    'crypto/QcLightClient.js',
    'crypto/SmtFold.js',
    'config/fees.js',
    'config/nodes.js',
    'config/genesisConsensus.js',
    'utils/boundedFetch.js',
    'utils/strictJson.js',
    'utils/solanaFormat.js',
  ].map((p) => path.join(MOBILE_SRC, p)),
  ...['wallet.js', 'signing.js', 'mnemonic.js', 'lightclient.js', 'tx.js', 'bytes.js', 'errors.js', 'shims/DilithiumCrypto.js']
    .map((p) => path.join(WALLET_CORE, p)),
]);

// Runtime dependencies stay imports (the package's dependencies); everything else is compiled in.
const pkg = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const DEPENDENCIES = Object.keys(pkg.dependencies ?? {});
const isDependency = (spec) => DEPENDENCIES.some((d) => spec === d || spec.startsWith(`${d}/`));
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const sharedDir = (file) => inside(file, MOBILE_SRC) || inside(file, WALLET_CORE);

const sharedSources = {
  name: 'qnet-shared-sources',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (a) => {
      if (a.kind === 'entry-point' || a.pluginData?.pinned) return undefined;
      const alias = Object.keys(ALIASES).find((prefix) => a.path.startsWith(prefix));
      const fromShared = sharedDir(a.importer);
      if (!alias && !fromShared) return undefined;
      if (fromShared && inside(a.importer, MOBILE_SRC) && /^\.\/DilithiumCrypto(\.js)?$/.test(a.path)) return { path: DILITHIUM_SHIM };
      const relative = a.path.startsWith('.');
      if (!alias && !relative) {
        if (BUILTINS.has(a.path)) return { path: a.path, external: true };
        if (isDependency(a.path)) return { path: a.path, external: true };
      }
      // Packages a shared file imports come from this package's lockfile, never from the app's or the extension's.
      const target = alias ? path.join(ALIASES[alias], a.path.slice(alias.length)) : a.path;
      const resolveDir = alias || !relative ? HERE : a.resolveDir;
      const r = await b.resolve(alias ? target : a.path, { kind: a.kind, importer: a.importer, resolveDir, pluginData: { pinned: true } });
      if (r.errors.length > 0) return { errors: r.errors };
      if (sharedDir(r.path) && !SHARED.has(r.path)) {
        return { errors: [{ text: `shared source not allowed in the SDK: ${path.relative(ROOT, r.path)}` }] };
      }
      return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
    });
  },
};

await rm(path.join(HERE, 'dist'), { recursive: true, force: true });

const result = await build({
  absWorkingDir: HERE,
  entryPoints: { index: 'src/index.ts', node: 'src/node.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022', 'node20'],
  external: DEPENDENCIES.flatMap((d) => [d, `${d}/*`]),
  // The shared sources log for the app; a library prints nothing of its own.
  drop: ['console', 'debugger'],
  legalComments: 'eof',
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: 'warning',
  plugins: [sharedSources],
});

const fail = (message) => {
  console.error(`[ERR][BUILD] ${message}`);
  process.exit(1);
};

for (const input of Object.keys(result.metafile.inputs)) {
  const file = path.resolve(HERE, input);
  if (!inside(file, path.join(HERE, 'src')) && !inside(file, path.join(HERE, 'node_modules')) && !SHARED.has(file)) {
    fail(`unexpected input ${file}`);
  }
}

// What a web page loads must not reach Node's own modules.
const outputs = result.metafile.outputs;
const seen = new Set();
const walk = (out) => {
  if (seen.has(out)) return;
  seen.add(out);
  for (const imp of outputs[out]?.imports ?? []) {
    if (imp.external && BUILTINS.has(imp.path)) fail(`dist/index.js reaches ${imp.path} through ${out}`);
    if (!imp.external && imp.kind !== 'dynamic-import') walk(imp.path);
  }
};
walk('dist/index.js');

const tsc = spawnSync(process.execPath, [path.join(HERE, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: HERE, stdio: 'inherit' });
if (tsc.status !== 0) fail('type declarations');
// The published declarations describe the SDK's own types only.
for (const d of (await readdir(path.join(HERE, 'dist'), { recursive: true })).filter((f) => f.endsWith('.d.ts'))) {
  const text = await readFile(path.join(HERE, 'dist', d), 'utf8');
  if (/#mobile\/|#wallet-core\//.test(text)) fail(`dist/${d} names a shared source`);
}

const mobile = Object.keys(result.metafile.inputs).map((i) => path.resolve(HERE, i)).filter((f) => SHARED.has(f)).map((f) => path.relative(ROOT, f));
console.log(`[INFO][BUILD] dist/ built; shared sources: ${mobile.join(', ')}`);

#!/usr/bin/env node
// Writes dist-dev/: the extension from dist/ plus a development overlay (extension.mjs devOverlay), for loading
// unpacked while the site runs locally. Never packaged, git-ignored. The overlay:
//   - adds localhost and 127.0.0.1 (plain HTTP, any port) to both content-script entries, so the provider
//     and relay run on a local site; the router reads these patterns from the manifest at run time;
//   - names the extension DEV_NAME;
//   - sets DEV_BUILD = true in background/config.js, which turns the logger on.
// Every other file is dist/'s as it is now, so run it again after every change to dist/: the tests refuse a
// dist-dev/ that is behind dist/ (checkDevBuild, EXT-FA1-01).
// Usage: node scripts/build-dev.mjs [--out <dir>]
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_NAME, SHIPPED, checkDevBuild, devOverlay, verifyExtension } from './extension.mjs';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WALLET, 'dist');

function fail(message) {
  console.error(`[ERR][BUILD-DEV] ${message}`);
  process.exit(1);
}

const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The output is deleted first, so it must be empty, missing, or a previous dev build.
async function assertReplaceable(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0) return;
  let name = null;
  try {
    ({ name } = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')));
  } catch {
    // not a build
  }
  if (name !== DEV_NAME) fail(`${dir} is not empty and not a previous dev build`);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex >= 0 && !args[outIndex + 1]) fail('--out needs a directory');
const OUT = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(WALLET, 'dist-dev');
if (within(OUT, DIST) || within(DIST, OUT)) fail('the output must be outside dist/ and must not contain it');

await assertReplaceable(OUT);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const entry of SHIPPED) {
  await cp(path.join(DIST, entry), path.join(OUT, entry), { recursive: true });
}

const manifestPath = path.join(OUT, 'manifest.json');
const configPath = path.join(OUT, 'background/config.js');
let overlay;
try {
  overlay = devOverlay({ manifestText: await readFile(manifestPath, 'utf8'), configText: await readFile(configPath, 'utf8') });
} catch (error) {
  fail(error.message);
}
await writeFile(manifestPath, overlay.manifestText);
await writeFile(configPath, overlay.configText);

const { problems } = await verifyExtension(OUT, { store: false });
if (problems.length > 0) fail(`the dev build does not load:\n  ${problems.join('\n  ')}`);
const drift = await checkDevBuild(DIST, OUT);
if (drift.length > 0) fail(`the dev build is not dist/ with the overlay:\n  ${drift.join('\n  ')}`);

console.log(`[INFO][BUILD-DEV] ${path.relative(WALLET, OUT) || OUT}: ${SHIPPED.length} entries, dev matches added`);

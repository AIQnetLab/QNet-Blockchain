// What the extension ships, and the check that it loads as Chrome would: every file the manifest and
// the pages name exists and is shipped, every module import resolves inside the shipped set, content
// scripts stay classic scripts, and no shipped script or stylesheet is left unreferenced. Every manifest icon is a PNG of
// the size it is declared at, and no two shipped pictures are one image. Also the dev overlay (devOverlay) and the check
// that a dev build is the overlay of the current dist/ (checkDevBuild). Used by build-dev.mjs, package.mjs and the tests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The shipped entries of dist/, in the order they are copied. */
export const SHIPPED = Object.freeze([
  'manifest.json', 'background', 'content', 'inject', 'ui', '_locales', 'icons', 'lib/qnet-core.js',
]);

/** The name of the development build (scripts/build-dev.mjs), which marks a directory as one. */
export const DEV_NAME = 'QNet Wallet (dev)';
// Assembled from parts so the source holds no cleartext URL literal (the static checks look for one).
const DEV_MATCHES = Object.freeze(['localhost', '127.0.0.1'].map((host) => `${'http'}://${host}/*`));
const DEV_FLAG_OFF = 'export const DEV_BUILD = false;';
const DEV_FLAG_ON = 'export const DEV_BUILD = true;';
/** The two files the dev overlay changes; every other shipped file of a dev build is dist/'s, byte for byte. */
export const DEV_OVERLAID = Object.freeze(['manifest.json', 'background/config.js']);

/**
 * The dev overlay of dist/'s manifest.json and background/config.js: the extension named DEV_NAME, localhost and
 * 127.0.0.1 (plain HTTP, any port) added to every content-script entry, DEV_BUILD true (the logger on).
 * @param {{manifestText: string, configText: string}} dist the two files of dist/, as text
 * @returns {{manifestText: string, configText: string}} the dev build's
 * @throws {Error} when config.js does not hold the DEV_BUILD line exactly once
 */
export function devOverlay({ manifestText, configText }) {
  const manifest = JSON.parse(manifestText);
  manifest.name = DEV_NAME;
  for (const script of manifest.content_scripts ?? []) {
    script.matches = [...script.matches, ...DEV_MATCHES.filter((m) => !script.matches.includes(m))];
  }
  if (configText.split(DEV_FLAG_OFF).length !== 2) throw new Error('background/config.js must contain the DEV_BUILD line exactly once');
  return { manifestText: `${JSON.stringify(manifest, null, 2)}\n`, configText: configText.replace(DEV_FLAG_OFF, DEV_FLAG_ON) };
}

/**
 * Whether the dev build under `devRoot` is the overlay of the extension under `distRoot` as it is now (EXT-FA1-01): the
 * same shipped files, each byte-identical to dist/'s except DEV_OVERLAID, which must be exactly devOverlay of dist/'s.
 * A dist/ change the dev build does not have yet is a problem: a test run against it would not be the shipped code.
 * @param {string} distRoot
 * @param {string} devRoot
 * @returns {Promise<string[]>} problems; empty when the dev build is current
 */
export async function checkDevBuild(distRoot, devRoot) {
  const dist = await listShippedFiles(distRoot);
  const dev = await listShippedFiles(devRoot);
  const problems = [...dist.problems.map((p) => `dist: ${p}`), ...dev.problems.map((p) => `dev build: ${p}`)];
  const inDev = new Set(dev.files);
  const inDist = new Set(dist.files);
  for (const file of dist.files) if (!inDev.has(file)) problems.push(`${file}: in dist/ but not in the dev build`);
  for (const file of dev.files) if (!inDist.has(file)) problems.push(`${file}: in the dev build but not in dist/`);
  let overlay = null;
  try {
    overlay = devOverlay({
      manifestText: await readFile(path.join(distRoot, 'manifest.json'), 'utf8'),
      configText: await readFile(path.join(distRoot, 'background/config.js'), 'utf8'),
    });
  } catch (error) {
    problems.push(`dist: no dev overlay (${error.message})`);
  }
  const expected = overlay === null ? {} : { 'manifest.json': overlay.manifestText, 'background/config.js': overlay.configText };
  for (const file of dist.files.filter((f) => inDev.has(f))) {
    const have = await readFile(path.join(devRoot, file));
    if (DEV_OVERLAID.includes(file)) {
      if (overlay !== null && have.toString('utf8') !== expected[file]) problems.push(`${file}: not the dev overlay of dist/'s`);
    } else if (!have.equals(await readFile(path.join(distRoot, file)))) {
      problems.push(`${file}: differs from dist/`);
    }
  }
  return problems;
}

/**
 * How old the light-client pin may be when the extension is packaged (R4-EXTQ-05). Nodes strip the committee
 * signatures of macroblocks older than QC_SIG_RETENTION_MB (14,880 macroblocks, about 15 days at one block a
 * second); a walk from an older pin starts only where an archive still serves the signed copy.
 */
export const PIN_MAX_AGE_DAYS = 14;
const PIN_RE = /Generated by scripts\/ws-pin\.js on (\d{4}-\d{2}-\d{2})\b[^\n]*\n\s*export const WS_CHECKPOINT = \{\s*index: (\d+),/;
const DAY_MS = 86_400_000;

/**
 * The weak-subjectivity pin qnet-mobile/src/config/genesisConsensus.js holds (scripts/ws-pin.js writes it, with the
 * day it was generated), or null when the file has no generated pin.
 * @param {string} source the text of genesisConsensus.js
 * @returns {{index: number, generated: string}|null} generated: YYYY-MM-DD
 */
export function pinOfSource(source) {
  const match = typeof source === 'string' ? PIN_RE.exec(source) : null;
  if (!match) return null;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) ? { index, generated: match[1] } : null;
}

/**
 * Whether the light-client pin compiled into the bundle may ship (R4-EXTQ-05): the bundle carries the pin of the
 * mobile source (its trust floor is the pin's index + 1, as the light client counts it), and the pin is at most
 * `maxAgeDays` old on `today`. ws-pin.js stays the only writer of the pin.
 * @param {{source: string, bundleTrustFloor: number, today: string, maxAgeDays?: number}} input
 * @returns {string[]} problems; empty when the pin may ship
 */
export function checkLightClientPin({ source, bundleTrustFloor, today, maxAgeDays = PIN_MAX_AGE_DAYS }) {
  const pin = pinOfSource(source);
  if (pin === null) return ['genesisConsensus.js: no pin generated by scripts/ws-pin.js'];
  const problems = [];
  if (bundleTrustFloor !== pin.index + 1) {
    problems.push(`lib/qnet-core.js: its pin (trust floor ${bundleTrustFloor}) is not the source's ${pin.index}: build the bundle again`);
  }
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${pin.generated}T00:00:00Z`)) / DAY_MS;
  if (!Number.isFinite(age)) problems.push(`the pin date ${pin.generated} or today ${today} is not a date`);
  else if (age > maxAgeDays) {
    problems.push(`the light-client pin is from ${pin.generated}, ${age} days old (at most ${maxAgeDays}): run scripts/ws-pin.js --write in qnet-mobile and build again`);
  }
  return problems;
}

/**
 * Whether `bundle` is exactly what tools/crypto-bundle builds now from its sources and the shared mobile modules
 * (EXT-R2A-02): another lane may change a shared module after the bundle was built, and a store package of the old
 * bundle would ship code, and text, the sources no longer hold. Builds into a temporary file and compares bytes.
 * @param {{wallet: string, bundle: string}} paths the wallet's root and the bundle to check
 * @returns {Promise<string[]>} problems; empty when the bundle is current
 */
export async function checkBundleFresh({ wallet, bundle }) {
  const tool = path.join(wallet, 'tools/crypto-bundle');
  if (!existsSync(path.join(tool, 'node_modules/esbuild'))) return ['tools/crypto-bundle is not installed: npm run bundle:install'];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qnet-core-'));
  try {
    const out = path.join(dir, 'qnet-core.js');
    const run = spawnSync(process.execPath, [path.join(tool, 'build.js'), '--out', out], { encoding: 'utf8' });
    if (run.status !== 0) return [`the crypto bundle does not build: ${(run.stderr || run.stdout || '').trim().split('\n')[0]}`];
    const [fresh, shipped] = await Promise.all([readFile(out), readFile(bundle).catch(() => null)]);
    return shipped !== null && fresh.equals(shipped) ? [] : [`${BUNDLE} is not what its sources build now: npm run build`];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLEARTEXT = `${'http'}:`;
const BUNDLE = 'lib/qnet-core.js';
const IMPORT_RE = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const BARE_IMPORT_RE = /^\s*import\s*(['"])([^'"]+)\1/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g;
const HTML_REF_RE = /\b(?:src|href)\s*=\s*"([^"]*)"/g;
const SCRIPT_TAG_RE = /<script\b([^>]*)>/g;
const JS_ASSET_RE = /\b(?:href|src):\s*'([^'$`]+)'/g;
const GET_URL_RE = /\bgetURL\(\s*'([^'$`]+)'\s*\)/g;
const MSG_RE = /__MSG_([A-Za-z0-9_@]+)__/g;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PICTURE_RE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/**
 * The width and height a PNG's IHDR chunk declares, or null when `data` is not a PNG.
 * @param {Buffer} data
 * @returns {{width: number, height: number}|null}
 */
export function pngSize(data) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const posix = (file) => file.split(path.sep).join('/');

async function walk(root, rel, out, problems) {
  const full = path.join(root, rel);
  let info;
  try {
    info = await lstat(full);
  } catch {
    problems.push(`${rel}: listed in SHIPPED but missing`);
    return;
  }
  if (info.isSymbolicLink()) {
    problems.push(`${rel}: symbolic link`);
    return;
  }
  if (!info.isDirectory()) {
    out.push(posix(rel));
    return;
  }
  for (const name of (await readdir(full)).sort()) await walk(root, path.join(rel, name), out, problems);
}

/**
 * The shipped files under `root`, as sorted posix paths relative to it.
 * @param {string} root the extension directory (dist/ or a copy of it)
 * @returns {Promise<{files: string[], problems: string[]}>}
 */
export async function listShippedFiles(root) {
  const files = [];
  const problems = [];
  for (const entry of SHIPPED) await walk(root, entry, files, problems);
  files.sort();
  for (const file of files) {
    if (path.posix.basename(file).startsWith('.')) problems.push(`${file}: hidden file`);
  }
  return { files, problems };
}

// A reference from `from` (a shipped file) to `target`, resolved against `base` ('file' or 'root').
function resolveRef(from, target, base = 'file') {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/')) return null;
  const clean = target.split(/[?#]/)[0];
  const dir = base === 'root' ? '' : path.posix.dirname(from);
  const resolved = path.posix.normalize(path.posix.join(dir, clean));
  return resolved.startsWith('../') || resolved === '..' ? null : resolved;
}

function specifiers(source) {
  const found = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const match of source.matchAll(re)) found.push(match[2]);
  }
  return found;
}

/**
 * Checks that the extension under `root` loads: see the header of this file.
 * @param {string} root
 * @param {{store?: boolean}} [options] store: also require the store build (no cleartext match patterns,
 *   DEV_BUILD false)
 * @returns {Promise<{files: string[], problems: string[]}>} problems is empty when the extension loads
 */
export async function verifyExtension(root, { store = true } = {}) {
  const { files, problems } = await listShippedFiles(root);
  const shipped = new Set(files);
  const text = new Map();
  const read = async (file) => {
    if (!text.has(file)) text.set(file, await readFile(path.join(root, file), 'utf8'));
    return text.get(file);
  };
  const need = (from, file, what) => {
    if (file === null) problems.push(`${from}: ${what} points outside the extension`);
    else if (!shipped.has(file)) problems.push(`${from}: ${what} ${file} is not shipped`);
    return file !== null && shipped.has(file);
  };

  let manifest;
  try {
    manifest = JSON.parse(await read('manifest.json'));
  } catch {
    problems.push('manifest.json: missing or not JSON');
    return { files, problems };
  }
  if (manifest.manifest_version !== 3) problems.push('manifest.json: manifest_version is not 3');

  const worker = manifest.background?.service_worker;
  if (typeof worker !== 'string') problems.push('manifest.json: no background.service_worker');
  else need('manifest.json', resolveRef('manifest.json', worker, 'root'), 'service worker');
  if (manifest.background?.type !== 'module') problems.push('manifest.json: the service worker is not a module');

  const pages = [manifest.action?.default_popup, manifest.options_page, manifest.side_panel?.default_path]
    .filter((p) => typeof p === 'string');
  for (const page of pages) need('manifest.json', resolveRef('manifest.json', page, 'root'), 'page');
  // An icon is drawn at the size it is declared for: a picture of another size or shape is scaled, blurred, by the
  // browser (EXT-R4-02). action.default_icon may also be one path, for every size.
  const defaultIcon = manifest.action?.default_icon;
  const icons = [...Object.entries(manifest.icons ?? {}),
    ...(typeof defaultIcon === 'string' ? [[null, defaultIcon]] : Object.entries(defaultIcon ?? {}))];
  const iconsChecked = new Set();
  for (const [size, icon] of icons) {
    const file = resolveRef('manifest.json', icon, 'root');
    if (!need('manifest.json', file, 'icon') || size === null || iconsChecked.has(`${size} ${file}`)) continue;
    iconsChecked.add(`${size} ${file}`);
    const dimensions = pngSize(await readFile(path.join(root, file)));
    if (dimensions === null) problems.push(`manifest.json: icon ${file} is not a PNG`);
    else if (dimensions.width !== Number(size) || dimensions.height !== Number(size)) {
      problems.push(`manifest.json: icon ${file} is ${dimensions.width}x${dimensions.height}, declared ${size}x${size}`);
    }
  }
  // one picture under two names draws two things alike (the QNC and 1DEV rows once shared one, EXT-R4-02)
  const pictures = new Map();
  for (const file of files.filter((f) => PICTURE_RE.test(f))) {
    const digest = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    if (pictures.has(digest)) problems.push(`${file}: the same picture as ${pictures.get(digest)}`);
    else pictures.set(digest, file);
  }
  const contentScripts = new Set();
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) {
      const file = resolveRef('manifest.json', js, 'root');
      if (need('manifest.json', file, 'content script')) contentScripts.add(file);
    }
    for (const css of entry.css ?? []) need('manifest.json', resolveRef('manifest.json', css, 'root'), 'content style');
  }
  for (const group of manifest.web_accessible_resources ?? []) {
    for (const resource of group.resources ?? []) need('manifest.json', resolveRef('manifest.json', resource, 'root'), 'resource');
  }
  const manifestText = await read('manifest.json');
  if (manifest.default_locale || manifestText.includes('__MSG_')) {
    const locale = `_locales/${manifest.default_locale}/messages.json`;
    if (need('manifest.json', locale, 'default locale')) {
      let messages = {};
      try {
        messages = JSON.parse(await read(locale));
      } catch {
        problems.push(`${locale}: not JSON`);
      }
      for (const [, key] of manifestText.matchAll(MSG_RE)) {
        if (typeof messages[key]?.message !== 'string') problems.push(`manifest.json: __MSG_${key}__ has no message in ${locale}`);
      }
    }
  }
  if (store) {
    if (manifestText.includes(CLEARTEXT)) problems.push('manifest.json: cleartext URL in the store manifest');
    if (!/^export const DEV_BUILD = false;$/m.test(await read('background/config.js').catch(() => ''))) {
      problems.push('background/config.js: DEV_BUILD is not false in the store build');
    }
  }

  // Module graph from the worker and the pages' scripts; classic content scripts must not import.
  const referenced = new Set([...contentScripts]);
  const queue = [];
  const enqueue = (file) => {
    if (!referenced.has(file)) {
      referenced.add(file);
      queue.push(file);
    }
  };
  if (typeof worker === 'string' && shipped.has(resolveRef('manifest.json', worker, 'root'))) {
    enqueue(resolveRef('manifest.json', worker, 'root'));
  }
  for (const page of files.filter((f) => f.endsWith('.html'))) {
    referenced.add(page);
    const html = await read(page);
    for (const [, attrs] of html.matchAll(SCRIPT_TAG_RE)) {
      if (/\bsrc\s*=/.test(attrs) && !/\btype\s*=\s*"module"/.test(attrs)) problems.push(`${page}: a classic <script> in a page`);
    }
    for (const [, ref] of html.matchAll(HTML_REF_RE)) {
      const file = resolveRef(page, ref);
      if (!need(page, file, `reference "${ref}"`)) continue;
      if (file.endsWith('.js')) enqueue(file);
      else referenced.add(file);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === BUNDLE) continue;
    const source = await read(file);
    for (const spec of specifiers(source)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        problems.push(`${file}: import "${spec}" is not a relative path`);
        continue;
      }
      const target = resolveRef(file, spec);
      if (need(file, target, `import "${spec}"`)) enqueue(target);
    }
    for (const [, ref] of source.matchAll(JS_ASSET_RE)) {
      const target = resolveRef(file, ref);
      if (need(file, target, `asset "${ref}"`)) referenced.add(target);
    }
    for (const [, ref] of source.matchAll(GET_URL_RE)) {
      const target = resolveRef(file, ref, 'root');
      if (need(file, target, `extension URL "${ref}"`)) referenced.add(target);
    }
  }
  for (const file of contentScripts) {
    const source = await read(file);
    if (/^\s*(?:import|export)\s/m.test(source) || specifiers(source).length > 0) {
      problems.push(`${file}: content scripts must be classic scripts`);
    }
  }
  for (const file of files) {
    if (/\.(?:js|css|html)$/.test(file) && !referenced.has(file)) problems.push(`${file}: shipped but never loaded`);
  }
  return { files, problems };
}

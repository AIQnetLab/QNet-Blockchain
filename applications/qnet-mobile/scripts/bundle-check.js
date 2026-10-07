#!/usr/bin/env node
/**
 * The Metro half of the bundle scan (plan-mobile 10.1; __tests__/BundleContent.test.js holds the static half over the
 * sources and the translation tables): the release JavaScript that ships, one bundle per platform, must carry none of
 * the removed flows, and the iOS bundle none of Android's own texts, which name Google Play. Neither carries the old
 * Android package's move notice: its texts and its link to the site's download page exist only in that package's last
 * update, built with metro.legacy.config.js (SD-12). The translation tables
 * the static half scans must be the ones in the bundle. Run before every release build (android/app/build.gradle
 * qnetBundleCheck) and in the iOS workflow.
 *
 *   node scripts/bundle-check.js [--platform android|ios|all] [--legacy] [--bundle <file>]
 *
 * With --bundle the named file is scanned as the one platform given; without it Metro builds the bundles first.
 * --legacy (Android only; android/app/build.gradle passes it with -PqnetLegacyMove) builds with metro.legacy.config.js
 * and scans that update's bundle the other way round for the notice: its texts and its link must be there, Android's own
 * texts too, and FORBIDDEN still not (M15).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Strings that survive minification (property names, literals) and belong only to removed flows.
const FORBIDDEN = [
  'activateWithCode', 'recoverActivationCode', 'checkActivationCode', 'deriveActivationCode', 'parseActivationCode',
  'getCanonicalActivation', 'storeActivationCode', 'exportActivationCode', 'createBurnInstruction', 'buildBurnTransaction',
  'signBurnTransaction', 'registerNodeWithCode', 'createAndSubmitNodeRegistrationTx', 'NODE_TYPE_MEMO', 'QNET_NODE_TYPE',
  'QNET-BOOT-', 'act_source_extension', 'link_title_activate', 'link_auth_activate', 'export_activation_code',
  'node_code_needed', 'owner_signature', 'Activate on this phone', 'Recover code', 'Enter activation code',
];

// The values of a translation table file: `key: 'text'` or `key: "text"` lines.
function tableValues(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const m of text.matchAll(/^\s*([a-zA-Z0-9_]+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),?\s*$/gm)) {
    out[m[1]] = (m[2] !== undefined ? m[2] : m[3]).replace(/\\(['"\\])/g, '$1');
  }
  return out;
}

const overlayDir = path.join(ROOT, 'src', 'i18n', 'overlays', 'android');
const androidTexts = () => fs.readdirSync(overlayDir).flatMap((f) => Object.values(tableValues(path.join(overlayDir, f))));
// The move notice of the old package's last update: its texts and the site page it links to.
const legacyDir = path.join(ROOT, 'src', 'i18n', 'overlays', 'legacy');
const legacyTexts = () => fs.readdirSync(legacyDir).flatMap((f) => Object.values(tableValues(path.join(legacyDir, f))));
const LEGACY_LINKS = ['aiqnet.io/wallet'];

// Minified code writes non-ASCII as it is or escaped (\xNN below 256, \uNNNN above); both forms are looked for.
const escaped = (s) => s.replace(/[^\x20-\x7e]/g, (c) => {
  const n = c.charCodeAt(0);
  return n < 256 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
});
const holds = (bundle, s) => bundle.includes(s) || bundle.includes(escaped(s));

/**
 * The problems of one platform's bundle text, [] when it may ship. `legacy`: the old package's last update (Android),
 * which must carry the move notice that every other bundle must not.
 */
function scanBundle(platform, bundle, { legacy = false } = {}) {
  const problems = [];
  if (legacy && platform !== 'android') return [`${platform}: the old package's last update is an Android build only`];
  for (const s of FORBIDDEN) if (holds(bundle, s)) problems.push(`${platform}: carries "${s}"`);
  // The notice's texts are read once, for every language, from the tables the legacy overlay merges.
  const notice = [...LEGACY_LINKS, ...legacyTexts()];
  for (const s of notice) {
    if (legacy && !holds(bundle, s)) problems.push(`${platform}: the old package's move notice is missing "${s.slice(0, 40)}"`);
    if (!legacy && holds(bundle, s)) problems.push(`${platform}: carries the old package's move notice "${s.slice(0, 40)}"`);
  }
  // The tables the static half scanned are the ones that ship: a text of each language is in the bundle.
  const locales = path.join(ROOT, 'src', 'i18n', 'locales');
  for (const f of fs.readdirSync(locales)) {
    const t = tableValues(path.join(locales, f));
    const probe = t.node_none || t.node_title;
    if (!probe || !holds(bundle, probe)) problems.push(`${platform}: the ${f} table is not the one in the bundle`);
  }
  const android = androidTexts();
  if (platform === 'ios') {
    for (const s of [...android, 'Google Play', 'play.google.com', 'QNetAppBuild']) {
      if (holds(bundle, s)) problems.push(`ios: carries Android's own "${s.slice(0, 40)}"`);
    }
  } else if (!android.every((s) => holds(bundle, s))) {
    problems.push('android: Android\'s own texts are missing, so the scan cannot see them');
  }
  return problems;
}

function build(platform, dir, { legacy = false } = {}) {
  const out = path.join(dir, `${platform}.bundle.js`);
  const cli = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'react-native.cmd' : 'react-native');
  execFileSync(cli, ['bundle', '--platform', platform, '--dev', 'false', '--minify', 'true', '--entry-file', 'index.js',
    '--bundle-output', out, '--assets-dest', path.join(dir, `${platform}-assets`), '--reset-cache',
    ...(legacy ? ['--config', path.join(ROOT, 'metro.legacy.config.js')] : [])],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  return fs.readFileSync(out, 'utf8');
}

function main(argv) {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const legacy = argv.includes('--legacy');
  const which = at('--platform') || (legacy ? 'android' : 'all');
  const platforms = which === 'all' ? ['android', 'ios'] : [which];
  if (!platforms.every((p) => p === 'android' || p === 'ios')) throw new Error(`unknown platform ${which}`);
  if (legacy && which !== 'android') throw new Error('--legacy scans the Android bundle only');
  const given = at('--bundle');
  if (given && platforms.length !== 1) throw new Error('--bundle scans one platform: give --platform');
  const dir = given ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-bundle-'));
  const problems = [];
  try {
    for (const p of platforms) {
      problems.push(...scanBundle(p, given ? fs.readFileSync(given, 'utf8') : build(p, dir, { legacy }), { legacy }));
    }
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    console.error(`Bundle scan failed:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log(`Bundle scan: ${platforms.join(', ')}${legacy ? ' (the old package last update)' : ''} clean`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`Bundle scan could not run: ${e.message}`);
    process.exitCode = 2;
  }
}

module.exports = { scanBundle, tableValues, FORBIDDEN };

// Static checks over what the extension ships (spec "Tests: static checks"; R10, R21, R23, R24): no HTML
// sinks, dynamic code, cleartext URLs or raw console calls; a manifest without <all_urls> or
// web-accessible HTML; pages that reference only shipped files. The shipped set is the list
// scripts/build-dev.mjs copies and scripts/package.mjs zips.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED } from '../scripts/extension.mjs';

const WALLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WALLET, 'dist');
const rel = (file) => path.relative(DIST, file).split(path.sep).join('/');

async function walk(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const out = [];
  for (const entry of await readdir(target)) out.push(...(await walk(path.join(target, entry))));
  return out;
}

const FILES = (await Promise.all(SHIPPED.map((entry) => walk(path.join(DIST, entry))))).flat();
const TEXT_FILES = FILES.filter((file) => /\.(js|mjs|html|css|json)$/.test(file));
const SOURCES = new Map(await Promise.all(TEXT_FILES.map(async (file) => [file, await readFile(file, 'utf8')])));
const MANIFEST = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
const CLEARTEXT = `${'http'}://`;

const BANNED = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\.write/],
  ['eval', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['string timer', /set(?:Timeout|Interval)\(\s*['"`]/],
  ['cleartext URL', new RegExp(CLEARTEXT.replace(/\//g, '\\/'))],
  ['console', /\bconsole\./],
  ['importScripts', /importScripts/],
];

describe('static: shipped files', () => {
  it('the shipped set is the v3 extension and includes the crypto bundle', () => {
    assert.deepEqual(SHIPPED, ['manifest.json', 'background', 'content', 'inject', 'ui', '_locales', 'icons', 'lib/qnet-core.js']);
    const names = FILES.map(rel);
    for (const required of ['manifest.json', 'background/sw.js', 'ui/popup.html', 'ui/setup.html', 'ui/approve.html', 'lib/qnet-core.js']) {
      assert.ok(names.includes(required), required);
    }
    assert.ok(TEXT_FILES.length > 30);
  });

  it('contain no innerHTML, eval, new Function, cleartext URL or console call (only the guarded logger)', async () => {
    for (const file of TEXT_FILES) {
      const text = SOURCES.get(file);
      for (const [name, pattern] of BANNED) {
        if (name === 'console' && rel(file) === 'background/log.js') continue;
        assert.ok(!pattern.test(text), `${rel(file)}: ${name}`);
      }
    }
    const logger = await readFile(path.join(DIST, 'background/log.js'), 'utf8');
    assert.match(logger, /const sink = DEV_BUILD \? globalThis\.console : null;/, 'the logger is gated by DEV_BUILD');
    assert.match(await readFile(path.join(DIST, 'background/config.js'), 'utf8'), /^export const DEV_BUILD = false;$/m);
  });

  it('pages keep nothing in web storage and write the clipboard only through common.copyText', async () => {
    for (const file of TEXT_FILES.filter((f) => rel(f).startsWith('ui/') && f.endsWith('.js'))) {
      const text = SOURCES.get(file);
      assert.ok(!/(localStorage|sessionStorage)\.setItem|indexedDB/.test(text), `${rel(file)} stores data`);
      if (rel(file) !== 'ui/common.js') assert.ok(!/navigator\.clipboard/.test(text), `${rel(file)} touches the clipboard`);
    }
  });

  // CROSS-08, updated with QNet Link revision 2: the mobile app burns nothing, and aiqnet.io's one-time payment key burns
  // for a wallet too, so the extension is never "the one client that burns".
  it('never tell the extension apart as the one client that burns: aiqnet.io\'s payment key burns too, the app never (CROSS-08)', async () => {
    const stale = /\b(?:the\s+)?(?:one|only)\s+client\s+that\s+(?:makes|signs|sends)\b|\bapp\s+burns\s+too\b/i;
    for (const file of TEXT_FILES) assert.ok(!stale.test(SOURCES.get(file)), rel(file));
    for (const doc of ['CONTRACTS.md', 'README.md']) {
      const text = await readFile(path.join(WALLET, doc), 'utf8').catch(() => '');
      assert.ok(!stale.test(text), doc);
    }
    const header = SOURCES.get(path.join(DIST, 'background/activation.js')).split('\nimport ')[0];
    assert.match(header, /mobile app never burns/);
    assert.match(header, /one-time payment key made for this wallet/);
    assert.ok(stale.test('the extension is the one client that makes activation burns'), 'the pattern still catches the old text');
  });

  it('pages, page scripts and the worker reference only shipped files', async () => {
    const shipped = new Set(FILES.map(rel));
    for (const file of TEXT_FILES.filter((f) => /\.(js|html)$/.test(f) && !rel(f).startsWith('lib/'))) {
      const text = SOURCES.get(file);
      const references = [
        ...[...text.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
        ...[...text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+'([^']+)'/gm)].map((m) => m[1]),
        ...[...text.matchAll(/\bimport\s+'([^']+)'/g)].map((m) => m[1]),
        ...[...text.matchAll(/'(\.\.\/icons\/[^']+)'/g)].map((m) => m[1]),
        ...[...text.matchAll(/'([a-z0-9]+-token\.png)'/g)].map((m) => `../icons/${m[1]}`),
      ];
      for (const reference of references) {
        if (/^https:\/\//.test(reference)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel(file)), reference));
        assert.ok(shipped.has(target), `${rel(file)} references ${reference}, which is not shipped`);
      }
    }
  });
});

describe('static: manifest', () => {
  it('has no <all_urls>, no wildcard host and no web-accessible HTML', () => {
    const text = JSON.stringify(MANIFEST);
    assert.ok(!text.includes('<all_urls>'));
    assert.ok(!text.includes('*://*/*'));
    assert.ok(!text.includes(CLEARTEXT));
    const resources = MANIFEST.web_accessible_resources ?? [];
    assert.deepEqual(resources, [], 'no web-accessible resources at all');
    for (const entry of resources) assert.ok(!(entry.resources ?? []).some((name) => /\.html?$/i.test(name) || name.includes('*')));
    for (const origin of MANIFEST.host_permissions) assert.match(origin, /^https:\/\/[a-z0-9.-]+\/\*$/);
    assert.deepEqual([...MANIFEST.permissions].sort(), ['alarms', 'idle', 'storage']);
  });

  // www.aiqnet.io and explorer.aiqnet.io only redirect: they serve no page the provider could run in (R4-ERP-02); the games
  // host serves the games that connect and send
  it('runs content scripts on aiqnet.io and games.aiqnet.io only, top frame only', () => {
    for (const entry of MANIFEST.content_scripts) {
      assert.deepEqual(entry.matches, ['https://aiqnet.io/*', 'https://games.aiqnet.io/*']);
      assert.ok(entry.matches.every((pattern) => !pattern.includes('*.')), 'no wildcard host');
      assert.equal(entry.all_frames, false);
    }
  });

  it('has a CSP with no inline or eval script and no framing', () => {
    const csp = MANIFEST.content_security_policy.extension_pages;
    // WebAssembly compilation (the Argon2id KDF) only: 'wasm-unsafe-eval' allows no JS eval.
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-inline|'unsafe-eval'/.test(csp));
  });
});

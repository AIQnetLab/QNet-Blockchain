// Static checks of the activation and QNet Link code paths: nothing a session holds (the link, the key, an
// answer) is written anywhere but the page's memory, except the one kept session of link-store.ts; /l reads its
// own URL only through the strict parser and sends it nowhere. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Comments may name what the code must not do; only code is checked.
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CLIENT_FILES = [
  'components/cabinet/ExtensionActivate.tsx',
  'components/cabinet/NodeClaim.tsx',
  'components/cabinet/LinkDevice.tsx',
  'components/cabinet/UnlinkDevice.tsx',
  'components/cabinet/WakePanel.tsx',
  'app/l/LinkButtons.tsx',
  'hooks/useLinkSession.ts',
  'lib/link-client.ts',
  'lib/link-store.ts',
  'lib/qnet-link.ts',
  'lib/qnet-link-crypto.ts',
  'lib/activation-price.ts',
  'lib/qr.ts',
];

test('the activation page and the link modules keep sessions in memory, or in link-store.ts only', () => {
  const forbidden = [
    /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\b(pushState|replaceState)\b|window\.history/, /location\.hash/,
    /location\.(assign|replace|href\s*=)/, /console\./, /innerHTML/, /dangerouslySetInnerHTML/, /\beval\(/, /new Function/,
    /Math\.random/,
  ];
  for (const file of CLIENT_FILES) {
    const src = code(file);
    for (const pattern of forbidden) {
      if (file === 'lib/activation-price.ts' && pattern.source === 'Math\\.random') continue; // node order only
      if (file === 'lib/link-store.ts' && pattern.source === 'indexedDB') continue; // the one kept session
      assert.doesNotMatch(src, pattern, `${file}: ${pattern}`);
    }
  }
});

test('link-store.ts keeps one record per page in its own database: a non-extractable key and public fields', () => {
  const src = code('lib/link-store.ts');
  assert.deepEqual(src.match(/indexedDB\.\w+/g), ['indexedDB.open']);
  assert.match(src, /const DB_NAME = 'qnet-link';/);
  assert.match(src, /const STORE = 'sessions';/);
  // The record is exactly these fields; the key goes in only when WebCrypto made it non-extractable.
  assert.match(src, /area\.put\(slot, \{ id: s\.id, intent: s\.intent, request: s\.request, sitePub: s\.sitePub, privateKey: s\.key\.privateKey, expiresAt \}\)/);
  assert.match(src, /if \(s\.key\.kind !== 'webcrypto' \|\| s\.closed\) return false;/);
  assert.match(src, /value\.type === 'private' && value\.extractable === false && value\.algorithm\.name === 'X25519'/);
  // Only the hook stores a session, and the crypto module makes the key non-extractable.
  assert.match(code('hooks/useLinkSession.ts'), /if \(slot\) await saveSession\(slot, started\.session, started\.expiresAt\);/);
  assert.match(code('lib/qnet-link-crypto.ts'), /subtle\.generateKey\(\{ name: 'X25519' \}, false, \['deriveBits'\]\)/);
});

test('the pages call only this origin', () => {
  let calls = 0;
  for (const file of ['components/cabinet/ExtensionActivate.tsx', 'components/cabinet/WakePanel.tsx', 'lib/link-client.ts']) {
    for (const m of code(file).matchAll(/fetch(?:Fn)?\(\s*[`']([^`']*)[`']/g)) {
      assert.match(m[1], /^(\$\{base\})?\/api\//, `${file}: ${m[1]}`);
      calls += 1;
    }
  }
  assert.ok(calls >= 5, `${calls} calls`);
});

test('/l is a server page; only LinkButtons reads the URL, as a whole, through the parser, and sends nothing', () => {
  const page = code('app/l/page.tsx');
  assert.doesNotMatch(page, /['"]use client['"]/);
  assert.doesNotMatch(page, /location|hash|<script|useEffect/);
  assert.doesNotMatch(page, /\/activate/);

  const buttons = code('app/l/LinkButtons.tsx');
  // One read of the whole URL, straight into the parser; the fragment is never taken apart by hand.
  assert.deepEqual(buttons.match(/location\.\w+/g), ['location.href']);
  assert.match(buttons, /const here = window\.location\.href;\s*if \(isAndroid\(window\.navigator\) && parseLink\(here\)\) setLink\(here\);/);
  assert.doesNotMatch(buttons, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bpostMessage\(|window\.open\(|<form/);
  // The URL goes only into the one intent: URL of the one Android package, falling back to the wallet page.
  assert.deepEqual(buttons.match(/androidIntentUrl\([^)]*\)/g), ['androidIntentUrl(link, WALLET_PAGE)']);
});

// Unified plan SITE-8: /activate is a permanent (308) redirect to the cabinet's activation, where the extension's
// path lives (components/cabinet/ExtensionActivate.tsx); links in the extension's texts keep working.
test('/activate is only the redirect to /node/activate', () => {
  assert.equal(existsSync(new URL('../../app/activate', import.meta.url)), false);
  const config = readFileSync(new URL('../../../next.config.js', import.meta.url), 'utf8');
  assert.match(config, /\{ source: '\/activate', destination: '\/node\/activate', permanent: true \},/);
  // The extension's activation asks no QNet Link request.
  assert.doesNotMatch(code('components/cabinet/ExtensionActivate.tsx'), /useLinkSession|androidIntentUrl|qrMatrix/);
});

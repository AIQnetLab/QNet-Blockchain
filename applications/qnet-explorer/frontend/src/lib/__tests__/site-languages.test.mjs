// Wherever the site lists the languages of QNet Wallet, it lists the app's own, in the app's order and with the app's
// names (owner, 19.10). Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES } from '../languages.ts';
import { SRC, code } from './source.mjs';

const APP_I18N = new URL('../../../../../qnet-mobile/src/i18n/index.js', import.meta.url);

test('the site\'s list is the app\'s LANGUAGES: the same order, the same names', () => {
  const app = readFileSync(APP_I18N, 'utf8').replace(/\r\n/g, '\n');
  const at = app.indexOf('export const LANGUAGES');
  const block = app.slice(at, app.indexOf(']);', at));
  const appList = [...block.matchAll(/\{ code: '([^']+)', name: '([^']+)' \}/g)].map((m) => ({ code: m[1], name: m[2] }));
  assert.equal(appList.length, 11);
  assert.deepEqual(LANGUAGES.map((l) => ({ code: l.code, name: l.name })), appList);
  assert.deepEqual(LANGUAGES.map((l) => l.name), ['English', '中文', 'Русский', 'Español', '한국어', '日本語', 'Português', 'Français', 'Deutsch', 'العربية', 'Italiano']);
});

test('one component lists them, each item in its own language, and no page writes its own list', () => {
  const list = code('components/ui/LanguageList.tsx');
  assert.match(list, /\{LANGUAGES\.map\(\(l\) => <li key=\{l\.code\} lang=\{l\.code\}>\{l\.name\}<\/li>\)\}/);
  assert.match(code('app/HomeClient.tsx'), /<LanguageList \/>/);
  const sources = readdirSync(new URL('app/', SRC), { recursive: true }).map((n) => `app/${n.replace(/\\/g, '/')}`)
    .concat(readdirSync(new URL('components/', SRC), { recursive: true }).map((n) => `components/${n.replace(/\\/g, '/')}`))
    .filter((n) => /\.tsx?$/.test(n));
  for (const file of sources) {
    // A second list would carry the app's names in another order or under other names (简体中文, "Chinese").
    assert.doesNotMatch(code(file), /简体中文|Русский|한국어/, file);
  }
});

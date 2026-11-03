// The site's languages (src/i18n): every catalog has exactly the English keys and the same {placeholders}, the words
// that are never translated stand unchanged in every language, QNet Blockchain is always written whole, and a catalog
// whose translation has begun has every sentence in its language. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { AREAS, areaTexts, inArea } from '../../i18n/areas.ts';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { LAST_RESORT } from '../../i18n/last-resort.ts';
import { LOCALES } from '../languages.ts';
import { TEXTS as en } from './texts-helper.mjs';
import { SRC, code, read, sourceFiles } from './source.mjs';

const KEYS = Object.keys(en);
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

// Names, units, stores and standards written the same in every language (the glossary's do-not-translate list).
const FIXED_TERMS = [
  'QNet Blockchain', 'QNet Wallet', 'QNet Link', 'QNC', '1DEV', 'SOL', 'Solana', 'Google Play', 'App Store', 'TestFlight',
  'Chrome Web Store', 'Apple', 'Android', 'iPhone', 'iPad', 'iOS', 'Firebase', 'GitHub', 'Orrery Group LLC', 'Apache-2.0',
  'ML-DSA-65', 'ML-KEM-768', 'X25519', 'QUIC', 'TLS', 'RPC', 'API', 'QR', 'IP', 'NFT', 'DAO', 'APK', 'IMEI', 'RAM',
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TERM = new RegExp(`(?<![A-Za-z0-9])(?:${[...FIXED_TERMS].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9])`, 'g');
// Addresses and identifiers (aiqnet.io/node, qnet.lang, io.aiqnet.wallet), code (snake_case, CONSTANT_NAMES, a path)
// and every number exactly as English writes it (10,000, 1.3): one format in every language.
const CODE = /[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w/.-]*[\w/])?|\b[a-z]+(?:_[a-z]+)+\b|\b[A-Z]+(?:_[A-Z]+)+\b|(?<![\w.])\/[a-z][\w/-]*|\d+(?:[.,]\d+)*/g;

const fixedTokens = (text) => [...new Set([...text.matchAll(TERM), ...text.matchAll(CODE)].map((m) => m[0]))];

// The words of a text a translation must change: what is left once placeholders and fixed tokens are taken out.
const prose = (text) => text.replace(/\{\w+\}/g, ' ').replace(TERM, ' ').replace(CODE, ' ');
const needsWords = (text) => /[A-Za-z]{3,}/.test(prose(text));

// Keys a language writes exactly as English does (a word it takes over unchanged), listed with its translation so that
// every other key is checked.
const SAME_AS_ENGLISH = { 'zh-CN': [], ru: [], es: ['blk_bytes', 'ui_app_time_min', 'col_token'], ko: [], ja: [], pt: ['hdr_menu', 'blk_bytes', 'ui_app_time_min', 'col_token', 'col_status'], fr: ['ui_app_time_min', 'support_contact_title', 'hdr_testnet', 'hdr_menu', 'docs_title', 'tx_type_activation', 'list_page', 'sugg_tx_note', 'col_tx', 'col_type', 'col_transactions', 'col_hash', 'blk_sig', 'blk_version', 'tx_title_n', 'tx_nonce', 'home_phase', 'dao_docs_link', 'docs_sec_architecture', 'docs_architecture_consensus', 'docs_developers_transactions', 'docs_developers_sdk', 'docs_developers_cli', 'docs_operators_configuration', 'docs_operators_maintenance', 'docs_sec_applications', 'wp_activation_title', 'xp_install_title', 'privacy_sent_1_b'], de: ['account_server', 'ro_status', 'badge_online', 'badge_offline', 'ui_app_link_wallet', 'support_contact_community', 'hdr_explorer', 'hdr_wallet', 'hdr_testnet', 'ftr_block', 'live', 'col_token', 'col_status', 'tx_type_system', 'genesis', 'sugg_block', 'col_block', 'col_hash', 'blk_title_n', 'details', 'blk_version', 'col_reputation', 'tx_nonce', 'col_name', 'tok_standard', 'tokens_symbol', 'home_phase', 'docs_developers_sdk', 'docs_developers_cli', 'docs_applications_explorer', 'docs_whitepaper', 'xp_install_title', 'xp_req_browser'], ar: [], it: ['ui_app_time_min', 'badge_online', 'badge_offline', 'hdr_explorer', 'hdr_testnet', 'hdr_privacy', 'hdr_menu', 'col_token', 'col_hash', 'tx_nonce', 'docs_applications_explorer', 'docs_whitepaper', 'xp_req_browser'] };

// The keys of a catalog that still read as English although the catalog is being translated.
function untranslated(catalog, same = []) {
  return KEYS.filter((key) => needsWords(en[key]) && catalog[key] === en[key] && !same.includes(key));
}

test('every catalog has every English key and nothing more, each a text with the same placeholders', () => {
  assert.deepEqual(Object.keys(CATALOGS), [...LOCALES]);
  assert.ok(KEYS.length > 1000, `${KEYS.length} keys`);
  for (const locale of LOCALES) {
    const catalog = CATALOGS[locale];
    assert.deepEqual(Object.keys(catalog).sort(), [...KEYS].sort(), locale);
    for (const key of KEYS) {
      assert.equal(typeof catalog[key], 'string', `${locale} ${key}`);
      assert.ok(catalog[key].trim() !== '', `${locale} ${key} is empty`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${locale} ${key}: placeholders`);
    }
  }
});

test('the words never translated stand unchanged in every catalog, numbers in the one format', () => {
  for (const locale of LOCALES) {
    for (const key of KEYS) {
      const text = CATALOGS[locale][key];
      for (const token of fixedTokens(en[key])) assert.ok(text.includes(token), `${locale} ${key}: "${token}" as written in English`);
      // Latin digits in every language: no Arabic-Indic, Persian or full-width ones.
      assert.doesNotMatch(text, /[\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19]/, `${locale} ${key}: digits`);
    }
  }
  // The check itself: a changed name, a number in another format and a dropped address are each caught.
  assert.deepEqual(fixedTokens('Send 10,000 QNC to aiqnet.io/node with QNet Wallet (TLS 1.3, code_verified).').sort(),
    ['1.3', '10,000', 'QNC', 'QNet Wallet', 'TLS', 'aiqnet.io/node', 'code_verified'].sort());
  assert.equal(fixedTokens('10,000 QNC').every((t) => '10.000 QNC'.includes(t)), false);
  assert.equal(fixedTokens('Open QNet Wallet').every((t) => 'Open the QNet wallet'.includes(t)), false);
});

test('QNet is always QNet Blockchain, QNet Wallet or QNet Link: whole, together and in that order', () => {
  for (const locale of LOCALES) {
    for (const key of KEYS) {
      const text = CATALOGS[locale][key];
      const all = (text.match(/QNet/g) ?? []).length;
      const whole = (text.match(/QNet (?:Blockchain|Wallet|Link)(?![A-Za-z0-9-])/g) ?? []).length;
      assert.equal(whole, all, `${locale} ${key}: ${text.slice(0, 80)}`);
      assert.doesNotMatch(text, /Blockchain\s+QNet/, `${locale} ${key}`);
    }
  }
});

test('a catalog whose translation has begun has every sentence in its language', () => {
  // English is the source; a catalog that differs from it in any key is being translated, and then every key whose
  // English has words must differ too (a key left in English shows English in that language's page).
  assert.deepEqual(Object.keys(SAME_AS_ENGLISH), LOCALES.filter((l) => l !== 'en'));
  for (const locale of LOCALES.filter((l) => l !== 'en' && KEYS.some((k) => CATALOGS[l][k] !== en[k]))) {
    assert.deepEqual(untranslated(CATALOGS[locale], SAME_AS_ENGLISH[locale]), [], `${locale}: keys still in English`);
    for (const key of SAME_AS_ENGLISH[locale]) assert.equal(CATALOGS[locale][key], en[key], `${locale} ${key} is listed as English`);
  }
  // The check itself, on a catalog translated but for one sentence: that sentence is named unless it is listed, and a
  // key made only of fixed words (a name, a number) is not.
  assert.ok(KEYS.some((k) => !needsWords(en[k])), 'a key of fixed words only');
  const partial = Object.fromEntries(KEYS.map((k) => [k, needsWords(en[k]) ? `«${en[k]}»` : en[k]]));
  partial.hdr_explorer = en.hdr_explorer;
  assert.deepEqual(untranslated(partial), ['hdr_explorer']);
  assert.deepEqual(untranslated(partial, ['hdr_explorer']), []);
});

test('the server loads every catalog and hands the browser its page\'s texts of one, in the page\'s data', () => {
  const serverCatalogs = read('i18n/catalogs.ts');
  for (const locale of LOCALES) {
    const name = locale === 'zh-CN' ? 'zhCN' : locale;
    assert.match(serverCatalogs, new RegExp(`import ${name} from '\\./locales/${escape(locale)}\\.ts';`), locale);
    // Every catalog is typed as the English keys, so a missing or extra key fails the build's type check as well.
    if (locale !== 'en') assert.match(read(`i18n/locales/${locale}.ts`), new RegExp(`const ${name}: Catalog = \\{`), locale);
  }
  // A client module imported by the root layout would ship in every page's scripts, all eleven of them: the layout
  // passes the shell's texts of the page's catalog as data instead, and no client module imports a catalog.
  const layout = code('app/layout.tsx');
  assert.match(layout, /const \{ locale, dir, t \} = await getI18n\(\);/);
  assert.match(layout, /<I18nProvider locale=\{locale\} messages=\{areaTexts\(t\.catalog, 'shell'\)\}>/);
  assert.doesNotMatch(layout, /i18n\/locales|i18n\/catalogs/);
  // The shared text module names the English catalog only as a type: no catalog rides along with it.
  assert.match(read('lib/texts.ts'), /^import type en from '\.\.\/i18n\/locales\/en\.ts';$/m);
  for (const file of sourceFiles()) {
    if (!/^'use client';/.test(read(file))) continue;
    assert.doesNotMatch(code(file), /from '[^']*i18n\/(locales|catalogs)[^']*'/, `${file} imports a catalog`);
  }
  // The last-resort error page has no layout above it: it reads its language from its address and its words from the
  // texts it carries for every language (i18n/last-resort.ts), so its first frame is already in that language and it
  // loads nothing; a server render, which has no address there, says English and the first browser render switches.
  const lastResort = code('app/global-error.tsx');
  assert.match(lastResort, /const addressLocale = \(\): Locale => splitLocale\(window\.location\.pathname\)\.locale \?\? DEFAULT_LOCALE;/);
  assert.match(lastResort, /const locale = useSyncExternalStore\(unchanging, addressLocale, serverLocale\);\s*const say = LAST_RESORT\[locale\];/);
  assert.match(lastResort, /<html lang=\{locale\} dir=\{isRtl\(locale\) \? 'rtl' : 'ltr'\}>/);
  for (const word of ['title', 'lead', 'reload']) assert.match(lastResort, new RegExp(`\\{say\\.${word}\\}`), word);
  assert.doesNotMatch(lastResort, /import\(|CATALOG|translator|fetch\(|useEffect/);
  assert.deepEqual(Object.keys(LAST_RESORT).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    for (const word of ['title', 'lead', 'reload']) assert.ok(LAST_RESORT[locale][word].trim() !== '', `${locale} ${word}`);
    if (locale !== 'en') for (const word of ['lead', 'reload']) assert.notEqual(LAST_RESORT[locale][word], LAST_RESORT.en[word], `${locale} ${word} in its language`);
  }
  // The page under the layout shows the shell's error texts, which every page holds, and its Reload from that one table.
  const pageError = code('app/error.tsx');
  assert.match(pageError, /<PageHead title=\{t\('error_title'\)\} lead=\{t\('error_lead'\)\}>/);
  assert.match(pageError, /\{LAST_RESORT\[t\.locale\]\.reload\}/);
  for (const key of ['error_title', 'error_lead', 'try_again']) assert.ok(inArea(key, 'shell'), key);
});

// The words a page shows outside the catalogs: every text of its markup and every attribute a reader sees or hears (a
// label, a title, a hint, an image's words) that has words left once names, code, addresses and numbers are taken out,
// unless it stands in an element marked translate="no". Only files a page reaches: a route file or one imported.
const ts = createRequire(import.meta.url)('typescript');
const SHOWN = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt', 'label']);
const EMAIL = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;
const ROUTE = /^app\/(?:.*\/)?(?:page|layout|error|global-error|not-found|loading|template)\.tsx$/;

function englishOutsideCatalogs(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const kept = (node) => {
    for (let n = node; n; n = n.parent) {
      if (ts.isJsxElement(n) && n.openingElement.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'translate'
        && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === 'no')) return true;
    }
    return false;
  };
  const check = (node, text) => {
    if (needsWords(text.replace(EMAIL, ' ')) && !kept(node)) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${text.trim()}`);
  };
  // The literals of an attribute's value: a call's arguments (a catalog key, a value) left out, markup in it checked as
  // markup.
  const literals = (node) => {
    if (ts.isCallExpression(node) || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    ts.forEachChild(node, literals);
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) check(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression) && !ts.isJsxAttribute(node.parent)) check(node, node.expression.text);
    else if (ts.isJsxAttribute(node) && SHOWN.has(node.name.getText()) && node.initializer) literals(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test('every word a page shows comes from its language\'s catalog, or is a name or value marked as never translated', () => {
  const files = sourceFiles();
  const imported = new Set(files.flatMap((f) => [...read(f).matchAll(/(?:from |import\()'([^']+)'/g)].map((m) => m[1].split('/').pop().replace(/\.tsx?$/, ''))));
  const pages = files.filter((f) => f.endsWith('.tsx') && (ROUTE.test(f) || imported.has(f.split('/').pop().replace(/\.tsx$/, ''))));
  assert.ok(pages.length > 100, `${pages.length} files`);
  assert.deepEqual(pages.flatMap((f) => englishOutsideCatalogs(f, read(f))), []);
  // The check itself: a text, a label and an image's words in English are each named; a name, an address, a value
  // marked translate="no" and a catalog lookup are not.
  const sample = [
    '<p>Connect<span className="c-long"> wallet</span></p>',
    '<img alt={symbol ? `${symbol} logo` : \'token logo\'} />',
    '<button aria-label="Close menu" />',
    '<p>QNet Wallet 1DEV aiqnet.io/node support@aiqnet.io</p>',
    '<p translate="no">VERIFY</p>',
    '<button aria-label={t(\'hdr_close\')} title={t(\'copy_named\', { name: \'Long name\' })}>{t(\'hdr_close\')}</button>',
  ].join('\n');
  assert.deepEqual(englishOutsideCatalogs('sample.tsx', sample).map((s) => s.split(' ')[0]), ['sample.tsx:1', 'sample.tsx:1', 'sample.tsx:2', 'sample.tsx:2', 'sample.tsx:3']);
  assert.match(code('components/wallet/connect-wallet-button.tsx'), /<div className="acct-views" role="tablist" aria-label=\{t\('account_views'\)\}>/);
});

// The keys a module looks up: every quoted key, and a key built from a template whose words meet its values at an
// underscore (`link_${x}`, `${a}_failure_${b}`; not `${n}px`) as every key it can make.
const KEY_SET = new Set(KEYS);
const once = (f) => { const kept = new Map(); return (file) => { if (!kept.has(file)) kept.set(file, f(file)); return kept.get(file); }; };
const lookups = once((file) => {
  const src = code(file);
  const found = new Set([...src.matchAll(/['"]([a-z0-9]+(?:_[a-z0-9]+)*)['"]/g)].map((m) => m[1]).filter((k) => KEY_SET.has(k)));
  for (const [, body] of src.matchAll(/`([a-z0-9_]*(?:\$\{[^`}]+\}[a-z0-9_]*)+)`/g)) {
    const parts = body.split(/\$\{[^}]+\}/);
    const keyShaped = parts.some((p) => /[a-z]{2}/.test(p))
      && parts.every((p, i) => p === '' || ((i === 0 || p.startsWith('_')) && (i === parts.length - 1 || p.endsWith('_'))));
    if (!keyShaped) continue;
    // A value may be a code in capitals (`link_error_${answer.error}` makes link_error_NO_WALLET).
    const made = new RegExp(`^${parts.join('[A-Za-z0-9_]+')}$`);
    for (const k of KEYS) if (made.test(k)) found.add(k);
  }
  return found;
});

// The site's modules a file imports ('@/' or relative), stylesheets and the catalogs left out.
const importsOf = once((file) => {
  const dir = file.split('/').slice(0, -1);
  return [...code(file).matchAll(/(?:from|import\()\s*'([^']+)'/g)].flatMap(([, spec]) => {
    if (!spec.startsWith('@/') && !spec.startsWith('.')) return [];
    const base = spec.startsWith('@/') ? spec.slice(2) : posix.normalize([...dir, spec].join('/'));
    const found = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext)
      .find((p) => /\.tsx?$/.test(p) && existsSync(new URL(p, SRC)) && statSync(new URL(p, SRC)).isFile());
    return found && !/^i18n\/(locales\/|catalogs\.ts$)/.test(found) ? [found] : [];
  });
});
const isClient = once((file) => /^'use client';/.test(read(file)));

// The keys a route file's browser code looks up: a 'use client' module and everything it imports; a server module's
// own lookups read the whole catalog on the server.
function clientKeys(entry) {
  const keys = new Set();
  const seen = new Set();
  const stack = [[entry, false]];
  while (stack.length) {
    const [file, above] = stack.pop();
    const client = above || isClient(file);
    if (seen.has(`${file} ${client}`)) continue;
    seen.add(`${file} ${client}`);
    if (client) for (const k of lookups(file)) keys.add(k);
    for (const next of importsOf(file)) stack.push([next, client]);
  }
  return keys;
}

// The areas over a route file: the shell, each layout above it that adds one, and its own (a layout's wraps only the
// pages below it).
const areaIn = (file) => /<AreaTexts area="(\w+)">/.exec(code(file))?.[1];
function areasOver(file) {
  const dirs = file.split('/').slice(0, -1);
  const areas = ['shell'];
  for (let i = 2; i <= dirs.length; i++) {
    const layout = [...dirs.slice(0, i), 'layout.tsx'].join('/');
    if (layout !== file && existsSync(new URL(layout, SRC)) && areaIn(layout)) areas.push(areaIn(layout));
  }
  if (!file.endsWith('/layout.tsx') && areaIn(file)) areas.push(areaIn(file));
  return areas;
}

test('a page carries the texts its browser code looks up, and the legal texts reach only their own pages', () => {
  const routes = sourceFiles().filter((f) => ROUTE.test(f) && !f.startsWith('app/api/') && f !== 'app/global-error.tsx');
  assert.ok(routes.length > 40, `${routes.length} route files`);
  const gaps = (areasOf) => routes.flatMap((file) => {
    const gets = areasOf(file);
    return [...clientKeys(file)].filter((k) => !gets.some((a) => inArea(k, a))).map((k) => `${file}: ${k}`);
  });
  assert.deepEqual(gaps(areasOver), []);
  // A layout's area wraps the pages below it and nothing of its own.
  for (const file of routes.filter((f) => f.endsWith('/layout.tsx') && areaIn(f))) {
    assert.match(code(file), /<AreaTexts area="\w+">\{children\}<\/AreaTexts>/, file);
  }
  // The check itself: My node's pages without their area miss its texts, a key built from a template among them.
  const node = gaps((file) => areasOver(file).filter((a) => a !== 'node'));
  assert.ok(node.includes('app/node/page.tsx: act_payment_title') && node.includes('app/node/page.tsx: transfer_failure_timeout'), node.slice(0, 5).join('\n'));
  // Every entry names a key or starts some; no area repeats one.
  for (const [area, entries] of Object.entries(AREAS)) {
    assert.equal(new Set(entries).size, entries.length, area);
    for (const e of entries) assert.ok(e.endsWith('_') ? KEYS.some((k) => k.startsWith(e)) : KEY_SET.has(e), `${area} ${e}`);
  }
  // The privacy policy and the terms, a third of a catalog, only on their pages; the terms take the policy's lead.
  for (const area of Object.keys(AREAS)) {
    for (const key of KEYS.filter((k) => /^(privacy|terms)_/.test(k))) {
      const own = key.startsWith('privacy_') ? area === 'privacy' || (area === 'terms' && key === 'privacy_lead') : area === 'terms';
      assert.equal(inArea(key, area), own, `${area} ${key}`);
    }
  }
  // An explorer page carries a small part of the catalog: under a fifth of its bytes in every language.
  for (const locale of LOCALES) {
    const bytes = (texts) => Buffer.byteLength(JSON.stringify(texts));
    const share = bytes({ ...areaTexts(CATALOGS[locale], 'shell'), ...areaTexts(CATALOGS[locale], 'explorer') }) / bytes(CATALOGS[locale]);
    assert.ok(share < 0.2, `${locale} ${share}`);
  }
  // A part's texts join the shell's in the browser (src/i18n/area.tsx, client.tsx).
  assert.match(code('i18n/area.tsx'), /return <I18nArea messages=\{areaTexts\(CATALOGS\[await getLocale\(\)\], area\)\}><>\{children\}<\/><\/I18nArea>;/);
  assert.match(code('i18n/client.tsx'), /makeI18n\(outer\.locale, \{ \.\.\.outer\.t\.catalog, \.\.\.messages \}, named\)/);
  assert.deepEqual(Object.keys(areaTexts(CATALOGS.ru, 'support')), KEYS.filter((k) => k.startsWith('support_')));
});

// A text no page looks up is never shown and only waits to drift from the page it once served: every key of the
// catalogs is looked up by some module of the site (tests and the catalogs themselves left out).
test('every key of the catalogs is one some page looks up', () => {
  const used = new Set();
  for (const file of sourceFiles().filter((f) => !/^i18n\/(locales\/|catalogs\.ts$)/.test(f))) for (const k of lookups(file)) used.add(k);
  assert.deepEqual(KEYS.filter((k) => !used.has(k)), []);
});

test('an error the page shows is the catalog\'s words for the server\'s reason, never the server\'s own text', () => {
  const page = code('app/explorer/address/[address]/AddressClient.tsx');
  assert.doesNotMatch(page, /data\.error|err\.message|error\.message/);
  assert.match(page, /data\.reason === 'not_confirmed_yet' \? t\('proof_not_confirmed'\) : data\.reason === 'network_unavailable' \? t\('proof_network_down'\)/);
  // The reasons are the route's, the one place it names them.
  assert.match(read('app/api/address/[address]/balance-proof/route.ts'), /const MESSAGES: Record<'not_confirmed_yet' \| 'network_unavailable', string>/);
});

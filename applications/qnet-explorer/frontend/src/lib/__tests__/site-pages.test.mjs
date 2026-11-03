// The site's other pages: the wallet and extension pages, the testnet faucet, the
// documentation, How it works, the DAO, Support, Privacy, Terms, the error and 404 pages and the link pages. One title
// band and one h1 each, the shared rows and fields, every request in three visible states, nothing that swaps after
// load, and nothing on them that is not true. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EN, TEXTS, english } from './texts-helper.mjs';
import { readFileSync } from 'node:fs';
import { clockAt } from '../format.ts';
import { LANGUAGES } from '../languages.ts';
import { EXTENSION_STORE_URL } from '../qnet-provider.ts';
import { pageTitle, translator } from '../texts.ts';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { allSheets, code, read } from './source.mjs';

const PAGES = {
  wallet: 'app/wallet/page.tsx',
  extension: 'app/qnet-wallet-extension/page.tsx',
  testnet: 'app/testnet/page.tsx',
  docs: 'app/docs/page.tsx',
  guide: 'components/cabinet/NodeGuide.tsx',
  dao: 'app/dao/page.tsx',
  support: 'app/support/page.tsx',
  privacy: 'app/privacy/page.tsx',
  terms: 'app/terms/page.tsx',
  error: 'app/error.tsx',
  lost: 'app/not-found.tsx',
};
const LINK_PAGES = ['app/l/page.tsx', 'app/send/page.tsx'];

test('every page has the title band and its one h1, and none of the old cards, boxes or inline colours', () => {
  for (const [name, file] of Object.entries(PAGES)) {
    const src = code(file);
    assert.match(src, /<PageHead\b/, name);
    // The title band holds the page's only h1; the page itself writes none.
    assert.doesNotMatch(src, /<h1\b/, name);
    assert.doesNotMatch(src, /explorer-section|explorer-header|section-title|content-card|privacy-section|tool-card-large|tools-grid-large|explorer-card|activate-card|qnet-button|qnet-input/, name);
    assert.doesNotMatch(src, /style=\{\{|#[0-9a-fA-F]{3,6}\b|rgba?\(/, name);
  }
  // The link pages render alone: the same band and h1, written in place, without the field or any script of the site's.
  for (const file of LINK_PAGES) {
    const src = code(file);
    assert.equal(src.match(/<h1 className="page-title">/g)?.length, 1, file);
    assert.doesNotMatch(src, /PageHead|Field|activate-card|explorer-section/, file);
  }
  const sheet = read('styles/pages.css');
  assert.match(sheet, /\.pg-bare \.page-head \{ padding-top: clamp\(36px, 5vw, 72px\); \}/);
});

test('the old rules of these pages are gone with the sheets from before the rebuild', () => {
  const sheets = allSheets();
  for (const cls of ['page-wallet', 'page-docs', 'page-dao', 'page-privacy', 'content-card', 'privacy-section', 'tool-card-large', 'tools-grid-large',
    'explorer-card', 'explorer-tabs', 'tabs-nav', 'block-list', 'block-item', 'status-indicator', 'create-proposal-card', 'activation-card',
    'activation-content', 'faucet-heading', 'page-link', 'link-open', 'guide-switch', 'guide-steps', 'guide-step', 'guide-connect']) {
    assert.doesNotMatch(sheets, new RegExp(`\\.${cls}(?![\\w-])`), cls);
  }
});

test('Privacy and Terms: sections with anchors, and the contents beside them list exactly those, in order', () => {
  for (const file of [PAGES.privacy, PAGES.terms]) {
    const src = read(file);
    // Each section's title is a key of the page's language, the same key its line in the contents names.
    const sections = [...src.matchAll(/<section className="doc-sec prose" id="([a-z-]+)">\s*<h2>\{(?:t|say)\('([a-z0-9_]+)'\)\}<\/h2>/g)].map((m) => [m[1], m[2]]);
    const toc = [...src.slice(src.indexOf('const TOC')).matchAll(/\['([a-z-]+)', '([a-z0-9_]+)'\]/g)].map((m) => [m[1], m[2]]);
    assert.ok(sections.length >= 12, `${file}: ${sections.length} sections`);
    assert.deepEqual(toc, sections, file);
    for (const [, key] of sections) assert.ok(TEXTS[key], key);
    assert.match(src, /<DocToc items=\{TOC\.map\(\(\[id, title\]\) => \[id, t\(title\)\] as const\)\} \/>/, file);
    // The date of the version, as a day in the page's language.
    assert.match(src, /const EFFECTIVE = Date\.UTC\(\d{4}, \d{1,2}, \d{1,2}\);/, file);
    assert.match(src, /<p className="doc-date">\{t\('legal_effective', \{ date: dayUtc\(EFFECTIVE, t\) \}\)\}<\/p>/, file);
  }
  // The anchors other pages link land on their sections.
  assert.match(read(PAGES.terms), /id="device-rules"/);
  assert.match(read(PAGES.privacy), /id="device-check"/);
  assert.match(read(PAGES.support), /id="device-check"/);
  // The contents are quieter than the text's links and leave the reading column alone below 960 px.
  assert.match(code('components/DocToc.tsx'), /<a className="toc-link" href=\{`#\$\{id\}`\}>/);
  assert.match(read('styles/pages.css'), /@media \(max-width: 960px\) \{\n {2}\.doc-main \{ grid-column: 1 \/ -1; \}\n {2}\.doc-aside \{ grid-column: 1 \/ -1; grid-row: auto; position: static;[^}]*\}\n {2}\.doc-aside\.toc-aside \{ display: none; \}/);
});

test('Support: the contact rows that appear once the wallet is detected sit beside the answers, or after them, never above', () => {
  const src = code(PAGES.support);
  const main = src.slice(src.indexOf('<div className="doc-main">'), src.indexOf('<aside className="doc-aside">'));
  const aside = src.slice(src.indexOf('<aside className="doc-aside">'));
  assert.ok(main.length > 0 && aside.length > 0);
  assert.doesNotMatch(main, /support_contact_/);
  for (const key of ['support_contact_email', 'support_contact_bugs', 'support_contact_community', 'support_contact_docs', 'support_never_share']) {
    assert.match(aside, new RegExp(`'${key}'`), key);
  }
  // Same-site links are client-side, so a tap never loads the page and detects the wallet again.
  assert.doesNotMatch(src, /<a href="\//);
  assert.doesNotMatch(code(PAGES.terms), /<a href="\//);
});

test('the wallet page: its languages in the app\'s order, its links client-side, nothing it repeats from elsewhere', () => {
  const src = code(PAGES.wallet);
  assert.match(src, /<LanguageList \/>/);
  assert.equal(LANGUAGES.length, 11);
  assert.doesNotMatch(src, /<a href="\//);
  // AUDIT 4.3: the home page's post-quantum and open-source sections, the footer's policies and Support's move from
  // the older Android app are not repeated here; Get QNet Wallet already lists the extension's store.
  assert.doesNotMatch(src, /Post-quantum keys|>Open source<|Policies and support|An earlier Android build|EXTENSION_URL/);
  // The extension's page is offered on a computer only.
  assert.match(src, /<Action href="\/qnet-wallet-extension" className="desk-only">/);
  assert.match(read('styles/pages.css'), /\[data-device='ios'\] \.desk-only, \[data-device='android'\] \.desk-only \{ display: none; \}/);
});

test('the extension page: the store on a computer at the manifest\'s browser version, the app on a phone, no emoji or other browser', () => {
  const src = code(PAGES.extension);
  assert.doesNotMatch(src, /['"]use client['"]/);
  assert.match(src, /<Action kind="solid" href=\{EXTENSION_STORE_URL\} external>\{t\('get_install_extension'\)\}<\/Action>/);
  assert.equal(TEXTS.get_install_extension, 'Install from the Chrome Web Store');
  // The site path in its text is a link to that page, as on the wallet page.
  assert.match(src, /\{rich\('xp_activation_p', \{ node: <Link href="\/node" translate="no">aiqnet\.io\/node<\/Link> \}\)\}/);
  assert.match(TEXTS.xp_activation_p, /^Its Activate tab, or \{node\}, burns 1DEV on Solana/);
  assert.match(EXTENSION_STORE_URL, /^https:\/\/chromewebstore\.google\.com\//);
  const manifest = JSON.parse(readFileSync(new URL('../../../../../qnet-wallet/dist/manifest.json', import.meta.url), 'utf8'));
  assert.match(src, new RegExp(`const MIN_BROWSER_VERSION = ${manifest.minimum_chrome_version};`));
  assert.match(src, /<p className="body phone-only" data-field-dim="0\.1">/);
  const words = Object.entries(TEXTS).filter(([k]) => k.startsWith('xp_')).map(([, v]) => v).join(' ');
  assert.doesNotMatch(src + words, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(src + words, /\bEdge\b|Chromium|Firefox|Safari|Download Extension|No Registration|bg-gradient|className="[^"]*\b(?:text|bg|px|py|mb|mt)-\d/);
});

test('the DAO page says what exists: no proposals, no counts, no votes', () => {
  const src = code(PAGES.dao);
  assert.doesNotMatch(src, /['"]use client['"]|useState|forVotes|againstVotes|Vote Yes|Vote No|Demo Mode|Pool #4|Treasury|audits scheduled/i);
  assert.match(src, /<PageHead title=\{say\('dao_title'\)\} lead=\{say\('dao_lead'\)\} \/>/);
  assert.equal(TEXTS.dao_lead, 'No governance runs on QNet Blockchain yet, so this page lists no proposals and takes no votes.');
  for (const key of Object.keys(TEXTS).filter((k) => k.startsWith('dao_'))) assert.doesNotMatch(TEXTS[key], /Vote Yes|Vote No|Demo Mode|Pool #4|Treasury|audits scheduled/i, key);
  // What the page says matches the vote route and the consensus document.
  assert.match(read('app/api/dao/vote/route.ts'), /process\.env\.DAO_ENABLED !== '1'/);
  const consensus = readFileSync(new URL('../../../../../../docs/architecture/consensus.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(consensus, /Because the heights live in the binary, agreement needs no on-chain governance vote\./);
});

test('the documentation index: a server page, every document a row that opens it on GitHub', () => {
  const src = code(PAGES.docs);
  assert.doesNotMatch(src, /['"]use client['"]/);
  assert.match(src, /<a className="rowlink" href=\{href\} target="_blank" rel="noopener noreferrer">/);
  assert.match(src, /<DocRow key=\{d\.path\} href=\{`\$\{DOCS\}\/\$\{d\.path\}`\} name=\{say\(d\.key\)\} what=\{say\(d\.what\)\} \/>/);
  // Every row's name and description in the page's language.
  for (const m of src.matchAll(/\{ key: '([a-z0-9_]+)', what: '([a-z0-9_]+)', path: '[^']+' \}/g)) assert.ok(TEXTS[m[1]] && TEXTS[m[2]], m[1]);
  assert.ok(readFileSync(new URL('../../../../../../QNet_Whitepaper.md', import.meta.url), 'utf8').length > 0);
});

test('the faucet: three visible states under the form, no dialog over the page, its times through the formats module', () => {
  const src = english(PAGES.testnet);
  assert.doesNotMatch(src, /position: 'fixed'|zIndex|showFaucetAlert|showSuccessAlert|explorer\.solana\.com|Intl\.DateTimeFormat/);
  // Waiting and failed through the site's one request-line component, in the slot under the form.
  assert.match(src, /\{isLoading && <Waiting>Sending the tokens on Solana devnet<\/Waiting>\}/);
  assert.match(src, /\{errorMessage && <Failed>\{errorMessage\}<\/Failed>\}/);
  assert.match(src, /import \{ Failed, Waiting \} from '@\/components\/ui\/RequestState';/);
  // Tokens that went through show a green check and "Test tokens sent" with the amounts, the address and
  // each transaction, announced, until the visitor closes it (or claims again).
  assert.match(src, /<section className="faucet-sent" role="status" aria-labelledby="faucet-sent">/);
  assert.match(src, /<svg className="faucet-sent-mark" viewBox="0 0 24 24" aria-hidden="true">/);
  assert.match(src, /<h3 className="faucet-sent-title" id="faucet-sent">Test tokens sent<\/h3>/);
  assert.match(src, /<Action kind="quiet" onClick=\{\(\) => setSent\(null\)\}>Close<\/Action>/);
  // Each token sent on a line of its own with its icon, only those that went through.
  assert.match(src, /<dt>Sent<\/dt>\s*<dd className="faucet-amts">\s*\{sent\.dev && <Amount value=\{number\(FAUCET_DEV\)\} solana="1DEV" \/>\}\s*\{sent\.sol && <Amount value=\{number\(FAUCET_SOL\)\} solana="SOL" \/>\}\s*<\/dd>/);
  assert.match(src, /<dt>To<\/dt>\s*<dd className="mono" translate="no">\{sent\.address\}<\/dd>/);
  assert.match(src, /dev: Boolean\(devData\.success\),\s*sol: Boolean\(solData\.success\),\s*address,/);
  // Nothing else takes the panel down: no timer, and only Close and a new claim clear it.
  assert.doesNotMatch(src, /setTimeout|setInterval/);
  assert.equal(src.match(/setSent\(null\)/g).length, 2);
  const css = read('styles/pages.css');
  assert.match(css, /\.faucet-sent-mark \{[^}]*stroke: var\(--mint\);/);
  assert.match(css, /\.faucet-sent-title \{[^}]*color: var\(--mint\);/);
  assert.match(src, /<EntityLink kind="solana-tx" value=\{sent\.devTx\} \/>/);
  assert.match(src, /<EntityLink kind="solana-tx" value=\{sent\.solTx\} \/>/);
  // The button keeps its width while it sends.
  assert.match(src, /<span className="swap">\s*<span data-on=\{!isLoading\}>Get test tokens<\/span>\s*<span data-on=\{isLoading\} aria-hidden=\{!isLoading\}>Sending…<\/span>/);
  // A field with a visible label, at 16 px so a phone does not zoom.
  assert.match(src, /<label className="label form-label" htmlFor="faucet-address">/);
  assert.match(read('styles/base.css'), /\.form-row \.field \{[^}]*font-size: 16px;/);
  // 14:05 within the next twelve hours, the day as well beyond them.
  const now = new Date(2026, 9, 19, 10, 0).getTime();
  assert.equal(clockAt(new Date(2026, 9, 19, 14, 5).getTime(), now, EN), '14:05');
  assert.equal(clockAt(new Date(2026, 9, 20, 14, 5).getTime(), now, EN), 'Oct 20, 14:05');
});

test('How it works: the way shown first comes from the request, so the steps are in the first paint and never swap', () => {
  const page = code('app/docs/how-it-works/page.tsx');
  assert.match(page, /const phone = installTarget\(\(await headers\(\)\)\.get\('user-agent'\)\) !== 'desktop';/);
  const guide = code(PAGES.guide);
  assert.doesNotMatch(guide, /useDeviceKind|if \(!device\) return null|useEffect/);
  assert.match(guide, /const way: Way = picked \?\? \(phone \? 'phone' : 'computer'\);/);
  // The three ways are underlined tabs with arrow keys; the steps are numbered rows beside their pictures.
  assert.match(guide, /<ViewTabs items=\{WAYS\.map/);
  assert.match(code('components/ui/ViewTabs.tsx'), /role="tablist"/);
  // The arrow toward the end of the line moves on: right in a left-to-right page, left in Arabic.
  assert.match(code('components/ui/ViewTabs.tsx'), /const step = e\.key === 'ArrowRight' \? 1 : e\.key === 'ArrowLeft' \? -1 : 0;\n\s*const next = step \? at \+ \(dir === 'rtl' \? -step : step\) : e\.key === 'Home' \? 0 : e\.key === 'End' \? items\.length - 1 : null;/);
  // A row wider than its column wraps, and a long label wraps inside its tab: no tab or word is cut or scrolled away.
  assert.match(read('styles/base.css'), /\.tabs \{ display: flex; flex-wrap: wrap; column-gap: 28px; border-bottom: 1px solid var\(--rule\); \}/);
  assert.match(read('styles/base.css'), /\.tab \{\n {2}position: relative; flex: 0 1 auto; min-width: 0; min-height: 44px;[^}]*text-align: start; overflow-wrap: break-word;/);
  assert.doesNotMatch(read('styles/base.css'), /\.tabs[^{]*\{[^}]*overflow-x|\.tab \{[^}]*white-space: nowrap/);
  // The site's one numbered-steps primitive (the activation's), with the picture as a third column here.
  assert.match(guide, /<ol className="cab-steps guide-list">/);
  assert.match(code(PAGES.extension), /<ol className="cab-steps">/);
  assert.doesNotMatch(read('styles/pages.css'), /\.nsteps?\b/);
});

test('the guide\'s pictures draw in the site\'s tokens: the site\'s buttons sentence case and squared, the pressed one ringed without a glow', () => {
  const art = code('components/cabinet/GuideArt.tsx');
  const colours = art.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
  // White and black only, for the pattern that stands for a QR code.
  assert.deepEqual(colours.sort(), ['#000000', '#ffffff']);
  assert.match(art, /cyan: 'var\(--signal\)'/);
  assert.doesNotMatch(art, /toUpperCase\(\)|opacity=\{0\.2\}|Inter,/);
  assert.match(art, /const radius = b\.site \? 2 : 5;/);
});

test('the home page\'s rate limits say exactly what they are: per IP at each node\'s API, never throughput', () => {
  const home = code('app/HomeClient.tsx');
  assert.doesNotMatch(home + Object.values(TEXTS).join(' '), /tx \/ min|per-address/i);
  assert.match(home, /<Feature datum=\{t\('home_rate_datum'\)\} title=\{t\('home_rate_title'\)\}>\{t\('home_rate_body'\)\}<\/Feature>/);
  assert.deepEqual([TEXTS.home_rate_datum, TEXTS.home_rate_title], ['Per-IP limits', 'Rate limiting']);
  const text = TEXTS.home_rate_body;
  assert.match(text, /Each node's public API limits every IP address \(an IPv6 address by its \/64\): 100 transaction submissions and 300 reads a minute, and 5 activations an hour, with a pause after a limit is passed\./);
  assert.match(text, /Incoming transactions are checked in a separate, bounded verification pool, and block validation keeps a pool of its own\./);
});

// The security model's datum: equal nodes and faults proven on chain, each language naming the node with the word its
// own body uses.
test('the home page\'s reputation datum says equal nodes and proven faults, in each language\'s word for a node', () => {
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<Feature datum=\{t\('home_rep_datum'\)\} title=\{t\('home_rep_title'\)\}>\{t\('home_rep_body'\)\}<\/Feature>/);
  assert.deepEqual([TEXTS.home_rep_datum, TEXTS.home_rep_title], ['Equal nodes, proven faults', 'Reputation-based security']);
  const node = { en: 'node', ru: 'нод', es: 'nodo', fr: 'nœud', de: 'knoten', it: 'nodi', pt: 'nós', ja: 'ノード', ko: '노드', 'zh-CN': '节点', ar: 'عقد' };
  assert.deepEqual(Object.keys(node).sort(), Object.keys(CATALOGS).sort());
  for (const [locale, word] of Object.entries(node)) {
    const { home_rep_datum: datum, home_rep_body: body } = CATALOGS[locale];
    assert.ok(datum.toLowerCase().includes(word) && body.toLowerCase().includes(word), `${locale}: ${datum}`);
  }
});

// On a phone (28 px, 328 px of line at 360 px wide) a datum breaks only between its two phrases, never inside a word of
// any script: its lines balanced, CJK words kept whole, each phrase within one line (20 mono letters; a CJK or Hangul
// character is as wide as two).
test('the home page\'s two-phrase datum breaks only at its comma, each phrase within a phone\'s line, in every language', () => {
  const rule = /\.feat-k \{([^}]*)\}/.exec(read('styles/home.css'));
  assert.ok(rule, 'the .feat-k rule');
  assert.match(rule[1], /text-wrap: balance;/);
  assert.match(rule[1], /word-break: keep-all;/);
  const width = (text) => [...text].reduce((w, ch) => w + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : /\p{M}/u.test(ch) ? 0 : 1), 0);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const phrases = catalog.home_rep_datum.split(/(?<=[,،、，])\s*/);
    assert.equal(phrases.length, 2, `${locale}: two phrases`);
    for (const phrase of phrases) assert.ok(width(phrase.trim()) <= 20, `${locale}: ${phrase}`);
  }
});

// The open-source section stays, the big VERIFY word included. A reveal element whose class React recomputes loses
// the "in" the reveal adds by hand and stays invisible.
test('the home page keeps VERIFY with its two links, and every element that fades in has a static class', () => {
  const home = english('app/HomeClient.tsx');
  assert.match(home, /<p className="verify-word rv" data-text="VERIFY" aria-hidden="true" translate="no">VERIFY<\/p>/);
  assert.match(home, /<h2 id="source-h" className="h2 rv">100% open source code<\/h2>/);
  assert.match(home, /href="https:\/\/github\.com\/AIQnetLab\/QNet-Blockchain\/tree\/testnet"[^>]*>\s*<span className="vlink-t">Check source code<\/span>/);
  assert.match(home, /href="https:\/\/github\.com\/AIQnetLab\/QNet-Blockchain\/actions"[^>]*>\s*<span className="vlink-t">Verify build<\/span>/);
  assert.match(home, /e\.target\.classList\.add\('in'\);/);
  assert.doesNotMatch(home, /className=\{`[^`]*\brv\b/);
  // The scan runs from the stylesheet and pauses with its section's "off" mark.
  const sheet = read('styles/home.css');
  assert.match(sheet, /\.verify-word::after \{[^}]*animation: scan 7s/);
  assert.doesNotMatch(sheet, /\.verify-word\.scan/);
  assert.match(home, /<section id="source" className=\{`sec verify\$\{sourceNear \? '' : ' off'\}`\}/);
  assert.match(read('styles/base.css'), /\.off \*, \.off \*::before, \.off \*::after \{ animation-play-state: paused !important; \}/);
});

// A link card of the site (Open Graph, the X card) says of it what the home page says, in the page's language.
test('the link cards describe the site with the home page\'s own line', () => {
  const layout = code('app/layout.tsx');
  assert.equal(layout.match(/\n\s*description: t\('home_deck'\),\n/g)?.length, 2, 'the Open Graph card and the X card');
  assert.match(code('app/HomeClient.tsx'), /<p className="deck" data-field-dim="0\.1">\{t\('home_deck'\)\}<\/p>/);
  for (const [locale, catalog] of Object.entries(CATALOGS)) assert.equal(catalog.meta_og_description, undefined, locale);
});

// The home page's transfer rate: the measured rate, with no link, and the validator-hardware figure, in every language.
test('the home page\'s transfer rate is the measured rate with no link, and the validator-hardware figure', () => {
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<Readout label=\{t\('home_tps'\)\} value="13,000" sub=\{t\('home_tps_sub'\)\} wide \/>/);
  assert.doesNotMatch(home, /LOAD_TEST_RESULTS|qnet-loadtest|home_tps_measured/);
  assert.equal(TEXTS.home_tps, 'Transfers/sec');
  assert.equal(TEXTS.home_tps_sub, 'Measured end-to-end on a 5-node testnet; 40,000–80,000 on validator hardware');
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    assert.match(catalog.home_tps_sub, /40,000.80,000/, locale);
    assert.doesNotMatch(catalog.home_tps_sub, /\{measured\}|90.109|430.450/, locale);
  }
});

test('the 404 page: the explorer\'s own search in the title band, a way to the explorer, and no wallet state', () => {
  // Its tab's title in the page's language, as every page's (i18n/server.ts pageMetadata: the title, then the site's name).
  assert.match(code(PAGES.lost), /export const generateMetadata = \(\) => pageMetadata\(\['notfound_title'\], 'notfound_lead'\);/);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    assert.equal(pageTitle(translator(locale, catalog), 'notfound_title'), `${catalog.notfound_title} - QNet Blockchain`, locale);
    if (locale !== 'en') assert.notEqual(catalog.notfound_title, CATALOGS.en.notfound_title, locale);
  }
  const page = english(PAGES.lost);
  // One search component for the site: the explorer's, not a second one for this page.
  assert.match(page, /<PageHead title="This page does not exist"[^>]*>\s*<ExplorerSearch \/>\s*<\/PageHead>/);
  assert.match(page, /import ExplorerSearch from '@\/components\/explorer\/ExplorerSearch';/);
  assert.match(page, /<Action href="\/explorer">Open the explorer<\/Action>/);
  assert.doesNotMatch(page + code('components/explorer/ExplorerSearch.tsx'), /useWallet|useActivationContent|AppContext/);
});

test('the link page keeps the room of its Android button from the first paint', () => {
  const buttons = code('app/l/LinkButtons.tsx');
  assert.match(buttons, /return \(\s*<div className="link-slot">\s*\{open && \(/);
  const sheet = read('styles/pages.css');
  assert.match(sheet, /\.link-slot \{ display: none; \}/);
  assert.match(sheet, /\[data-device='android'\] \.link-slot \{[^}]*min-height: 200px;/);
});

// No arrows: the economic model's phases are a plain sequence: two columns in reading order (one under the other on a phone), each under a top
// rule, and Phase 2 says in words when it starts, as docs/economics/tokenomics-1dev.md defines it.
test('the economic model shows its two phases in sequence with no drawn arrow', () => {
  const home = english('app/HomeClient.tsx');
  assert.doesNotMatch(home, /phase-link|Transition at/);
  const phases = home.slice(home.indexOf('<div className="phases rv">'), home.indexOf('<div className="eco-charts">'));
  assert.equal(phases.match(/<article className="phase">/g)?.length, 2);
  assert.ok(phases.indexOf("t('home_phase', { n: 1 })") < phases.indexOf("t('home_phase', { n: 2 })"));
  assert.equal(TEXTS.home_phase, 'Phase {n}');
  assert.match(phases, /<p className="note phase-when">Starts when 90% of the original 1DEV supply is burned or five years after the genesis block, whichever comes first\.<\/p>/);
  const doc = readFileSync(new URL('../../../../../../docs/economics/tokenomics-1dev.md', import.meta.url), 'utf8');
  assert.match(doc, /90% or more of the original 1DEV supply burned, or\n- five years/);
  const css = read('styles/home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /phase-link/);
  assert.match(css, /\.phase \{ grid-column: span 6; padding-top: 20px; border-top: 1px solid var\(--rule-strong\); \}/);
  // No drawn arrowhead anywhere on the page: a rotated corner of two borders.
  assert.doesNotMatch(css, /border-(top|right|bottom|left): 1px solid var\(--fog\);[^}]*rotate\(/);
});

// Support's "never send your recovery phrase" stands above the contact rows that appear once the wallet check ends, so
// they never move it.
test('Support: the warning stands above the contact rows that appear late, so nothing moves', () => {
  const page = code('app/support/page.tsx');
  const contact = page.slice(page.indexOf('id="contact"'));
  assert.ok(contact.indexOf("say('support_never_share')") > 0);
  assert.ok(contact.indexOf("say('support_never_share')") < contact.indexOf('<ul>'));
  assert.equal(page.match(/support_never_share/g)?.length, 1);
});

// The address page says "Address" once: a wallet address has no kicker; a system account keeps its "System account".
test('the address page names an address once', () => {
  const page = english('app/explorer/address/[address]/AddressClient.tsx');
  assert.match(page, /kicker=\{system \? 'System account' : isAddressShape\(address\) \? undefined : 'Address'\}/);
  // The whole address in the title, under the word, and written once: under it only Copy.
  assert.match(page, /title=\{name \?\? \(isAddressShape\(address\) \? <>Address<span className="ex-title-addr" translate="no"><AddressParts value=\{address\} \/><\/span><\/> : address\)\}/);
  assert.match(page, /isAddressShape\(address\) \? <Copy value=\{address\} ariaLabel="Copy address" \/> : <Whole value=\{null\}/);
  assert.doesNotMatch(page, /short\('address', address\)/);
  assert.match(read('styles/explorer.css'), /^\.ex-title-addr \{ display: block;/m);
});

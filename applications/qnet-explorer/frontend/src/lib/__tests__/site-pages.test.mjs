// The site's other pages in concept B (B-SPEC 6.8 to 6.12): the wallet and extension pages, the testnet faucet, the
// documentation, How it works, the DAO, Support, Privacy, Terms, the error and 404 pages and the link pages. One title
// band and one h1 each, the shared rows and fields, every request in three visible states, nothing that swaps after
// load, and nothing on them that is not true. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clockAt } from '../format.ts';
import { LANGUAGES } from '../languages.ts';
import { EXTENSION_STORE_URL } from '../qnet-provider.ts';
import { code, read } from './source.mjs';

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

test('the old rules of these pages are gone from the legacy sheets', () => {
  const legacy = read('app/globals.css') + read('app/mobile-fixes.css');
  for (const cls of ['page-wallet', 'page-docs', 'page-dao', 'page-privacy', 'content-card', 'privacy-section', 'tool-card-large', 'tools-grid-large',
    'explorer-card', 'explorer-tabs', 'tabs-nav', 'block-list', 'block-item', 'status-indicator', 'create-proposal-card', 'activation-card',
    'activation-content', 'faucet-heading', 'page-link', 'link-open', 'guide-switch', 'guide-steps', 'guide-step', 'guide-art', 'guide-faq', 'guide-connect']) {
    assert.doesNotMatch(legacy, new RegExp(`\\.${cls}\\b`), cls);
  }
});

test('Privacy and Terms: sections with anchors, and the contents beside them list exactly those, in order', () => {
  for (const file of [PAGES.privacy, PAGES.terms]) {
    const src = read(file);
    const sections = [...src.matchAll(/<section className="doc-sec prose" id="([a-z-]+)">\s*<h2>([^<]+)<\/h2>/g)].map((m) => [m[1], m[2]]);
    const toc = [...src.slice(src.indexOf('const TOC')).matchAll(/\['([a-z-]+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]]);
    assert.ok(sections.length >= 12, `${file}: ${sections.length} sections`);
    assert.deepEqual(toc, sections, file);
    assert.match(src, /<DocToc items=\{TOC\} \/>/, file);
    assert.match(src, /<p className="doc-date">Effective: [A-Z][a-z]+ \d{1,2}, \d{4}<\/p>/, file);
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
  assert.match(src, /<Action kind="solid" href=\{EXTENSION_STORE_URL\} external>Install from the Chrome Web Store<\/Action>/);
  // The site path in its text is a link to that page, as on the wallet page.
  assert.match(src, /Its Activate tab, or <Link href="\/node">aiqnet\.io\/node<\/Link>, burns 1DEV on Solana/);
  assert.match(EXTENSION_STORE_URL, /^https:\/\/chromewebstore\.google\.com\//);
  const manifest = JSON.parse(readFileSync(new URL('../../../../../qnet-wallet/dist/manifest.json', import.meta.url), 'utf8'));
  assert.match(src, new RegExp(`const MIN_BROWSER_VERSION = ${manifest.minimum_chrome_version};`));
  assert.match(src, /<p className="body phone-only" data-field-dim="0\.1">/);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(src, /\bEdge\b|Chromium|Firefox|Safari|Download Extension|No Registration|bg-gradient|className="[^"]*\b(?:text|bg|px|py|mb|mt)-\d/);
});

test('the DAO page says what exists: no proposals, no counts, no votes', () => {
  const src = code(PAGES.dao);
  assert.doesNotMatch(src, /['"]use client['"]|useState|forVotes|againstVotes|Vote Yes|Vote No|Demo Mode|Pool #4|Treasury|audits scheduled/i);
  assert.match(src, /lead="No governance runs on QNet Blockchain yet, so this page lists no proposals and takes no votes\."/);
  // What the page says matches the vote route and the consensus document.
  assert.match(read('app/api/dao/vote/route.ts'), /process\.env\.DAO_ENABLED !== '1'/);
  const consensus = readFileSync(new URL('../../../../../../docs/architecture/consensus.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(consensus, /Because the heights live in the binary, agreement needs no on-chain governance vote\./);
});

test('the documentation index: a server page, every document a row that opens it on GitHub', () => {
  const src = code(PAGES.docs);
  assert.doesNotMatch(src, /['"]use client['"]/);
  assert.match(src, /<a className="rowlink" href=\{href\} target="_blank" rel="noopener noreferrer">/);
  assert.match(src, /<DocRow key=\{d\.path\} href=\{`\$\{DOCS\}\/\$\{d\.path\}`\} name=\{d\.name\} what=\{d\.what\} \/>/);
  assert.ok(readFileSync(new URL('../../../../../../QNet_Whitepaper.md', import.meta.url), 'utf8').length > 0);
});

test('the faucet: three visible states under the form, no dialog over the page, its times through the formats module', () => {
  const src = code(PAGES.testnet);
  assert.doesNotMatch(src, /position: 'fixed'|zIndex|showFaucetAlert|showSuccessAlert|explorer\.solana\.com|Intl\.DateTimeFormat/);
  // Waiting and failed through the site's one request-line component, in the slot under the form.
  assert.match(src, /\{isLoading && <Waiting>Sending the tokens on Solana devnet<\/Waiting>\}/);
  assert.match(src, /\{errorMessage && <Failed>\{errorMessage\}<\/Failed>\}/);
  assert.match(src, /import \{ Failed, Waiting \} from '@\/components\/ui\/RequestState';/);
  // Owner 20.10: tokens that went through show a green check and "Test tokens sent" with the amounts, the address and
  // each transaction, announced, until the visitor closes it (or claims again).
  assert.match(src, /<section className="faucet-sent" role="status" aria-labelledby="faucet-sent">/);
  assert.match(src, /<svg className="faucet-sent-mark" viewBox="0 0 24 24" aria-hidden="true">/);
  assert.match(src, /<h3 className="faucet-sent-title" id="faucet-sent">Test tokens sent<\/h3>/);
  assert.match(src, /<Action kind="quiet" onClick=\{\(\) => setSent\(null\)\}>Close<\/Action>/);
  assert.match(src, /<dt>Sent<\/dt>\s*<dd>\{sent\.amounts\}<\/dd>/);
  assert.match(src, /<dt>To<\/dt>\s*<dd className="mono">\{sent\.address\}<\/dd>/);
  assert.match(src, /amounts: \[devData\.success && '1,500 1DEV', solData\.success && `\$\{FAUCET_SOL\} SOL`\]\.filter\(Boolean\)\.join\(' \+ '\),\s*address,/);
  // Nothing else takes the panel down: no timer, and only Close and a new claim clear it.
  assert.doesNotMatch(src, /setTimeout|setInterval/);
  assert.equal(src.match(/setSent\(null\)/g).length, 2);
  const css = read('styles/pages.css');
  assert.match(css, /\.faucet-sent-mark \{[^}]*stroke: var\(--mint\);/);
  assert.match(css, /\.faucet-sent-title \{[^}]*color: var\(--mint\);/);
  assert.match(src, /<EntityLink kind="solana-tx" value=\{sent\.devTx\} \/>/);
  assert.match(src, /<EntityLink kind="solana-tx" value=\{sent\.solTx\} \/>/);
  // The button keeps its width while it sends.
  assert.match(src, /<span className="swap">\s*<span data-on=\{!isLoading\}>\{t\('ui_faucet_button'\)\}<\/span>\s*<span data-on=\{isLoading\} aria-hidden=\{!isLoading\}>Sending…<\/span>/);
  // A field with a visible label, at 16 px so a phone does not zoom.
  assert.match(src, /<label className="label form-label" htmlFor="faucet-address">/);
  assert.match(read('styles/base.css'), /\.form-row \.field \{[^}]*font-size: 16px;/);
  // 14:05 within the next twelve hours, the day as well beyond them.
  const now = new Date(2026, 9, 19, 10, 0).getTime();
  assert.equal(clockAt(new Date(2026, 9, 19, 14, 5).getTime(), now), '14:05');
  assert.equal(clockAt(new Date(2026, 9, 20, 14, 5).getTime(), now), 'Oct 20, 14:05');
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
  assert.match(code('components/ui/ViewTabs.tsx'), /e\.key === 'ArrowRight' \? at \+ 1 : e\.key === 'ArrowLeft' \? at - 1/);
  assert.match(read('styles/base.css'), /\.tab \{\n {2}position: relative; flex: none; min-height: 44px;/);
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

test('the home page\'s rate limits say exactly what they are (owner 19.10): per IP at each node\'s API, never throughput', () => {
  const home = code('app/HomeClient.tsx');
  assert.doesNotMatch(home, /tx \/ min|per-address/i);
  assert.match(home, /<Feature datum="Per-IP limits" title="Rate limiting">/);
  const text = home.slice(home.indexOf('title="Rate limiting">'), home.indexOf('</Feature>', home.indexOf('title="Rate limiting">'))).replace(/\s+/g, ' ');
  assert.match(text, /Each node&apos;s public API limits every IP address \(an IPv6 address by its \/64\): 100 transaction submissions and 300 reads a minute, and 5 activations an hour, with a pause after a limit is passed\./);
  assert.match(text, /Incoming transactions are checked in a separate, bounded verification pool, and block validation keeps a pool of its own\./);
});

// Owner 19.10: the open-source section stays, the big VERIFY word included. A reveal element whose class React
// recomputes loses the "in" the reveal adds by hand and stays invisible, as VERIFY did while it toggled "scan".
test('the home page keeps VERIFY with its two links, and every element that fades in has a static class', () => {
  const home = code('app/HomeClient.tsx');
  assert.match(home, /<p className="verify-word rv" data-text="VERIFY" aria-hidden="true">VERIFY<\/p>/);
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

test('the 404 page: the explorer\'s own search in the title band, a way to the explorer, and no wallet state', () => {
  const page = code(PAGES.lost);
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

// REAL.md 7.9 (owner 19.10, no arrows): the economic model drew a connector with an arrowhead from Phase 1 to Phase 2.
// The phases are now a plain sequence: two columns in reading order (one under the other on a phone), each under a top
// rule, and Phase 2 says in words when it starts, as docs/economics/tokenomics-1dev.md defines it.
test('the economic model shows its two phases in sequence with no drawn arrow', () => {
  const home = code('app/HomeClient.tsx');
  assert.doesNotMatch(home, /phase-link|Transition at/);
  const phases = home.slice(home.indexOf('<div className="phases rv">'), home.indexOf('<div className="eco-charts">'));
  assert.equal(phases.match(/<article className="phase">/g)?.length, 2);
  assert.ok(phases.indexOf('Phase 1') < phases.indexOf('Phase 2'));
  assert.match(phases, /<p className="note phase-when">Starts when 90% of the original 1DEV supply is burned or five years after the genesis block, whichever comes first\.<\/p>/);
  const doc = readFileSync(new URL('../../../../../../docs/economics/tokenomics-1dev.md', import.meta.url), 'utf8');
  assert.match(doc, /90% or more of the original 1DEV supply burned, or\n- five years/);
  const css = read('styles/home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /phase-link/);
  assert.match(css, /\.phase \{ grid-column: span 6; padding-top: 20px; border-top: 1px solid var\(--rule-strong\); \}/);
  // No drawn arrowhead anywhere on the page: a rotated corner of two borders.
  assert.doesNotMatch(css, /border-(top|right|bottom|left): 1px solid var\(--fog\);[^}]*rotate\(/);
});

// REAL.md 7.3: Support's "never send your recovery phrase" sat under the contact rows that appear once the wallet check
// ends, and moved down with them (CLS 0.0066 at 1440). It now stands above them.
test('Support: the warning stands above the contact rows that appear late, so nothing moves', () => {
  const page = code('app/support/page.tsx');
  const contact = page.slice(page.indexOf('id="contact"'));
  assert.ok(contact.indexOf("t('support_never_share')") > 0);
  assert.ok(contact.indexOf("t('support_never_share')") < contact.indexOf('<ul>'));
  assert.equal(page.match(/support_never_share/g)?.length, 1);
});

// REAL.md 7.6: the address page said "Address" twice, as the kicker and in the title. A wallet address has no kicker
// now; a system account keeps its "System account".
test('the address page names an address once', () => {
  const page = code('app/explorer/address/[address]/AddressClient.tsx');
  assert.match(page, /kicker=\{system \? 'System account' : isAddressShape\(address\) \? undefined : 'Address'\}/);
  // The whole address in the title, under the word, and written once: under it only Copy (owner 20.10).
  assert.match(page, /title=\{name \?\? \(isAddressShape\(address\) \? <>Address<span className="ex-title-addr"><AddressParts value=\{address\} \/><\/span><\/> : address\)\}/);
  assert.match(page, /isAddressShape\(address\) \? <Copy value=\{address\} ariaLabel="Copy address" \/> : <Whole value=\{null\}/);
  assert.doesNotMatch(page, /short\('address', address\)/);
  assert.match(read('styles/explorer.css'), /^\.ex-title-addr \{ display: block;/m);
});

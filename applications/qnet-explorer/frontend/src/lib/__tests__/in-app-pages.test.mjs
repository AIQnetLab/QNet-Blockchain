// The QNet app's view of the site (src/lib/activate-view.ts): its in-app browser, a page it opened with
// ?from=app, and every page before the wallet is detected (the server's render included). The header, the
// footer and each page reachable there (IN_APP_NAV and the explorer) are walked for links and for text
// about activation or its cost; the pages about those subjects leave the app's view. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { IN_APP_EXCLUDED_PAGES, IN_APP_HOME, IN_APP_NAV, keepFromApp } from '../activate-view.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\s*\}/g, '');

// The source as the app's view renders it: imports dropped, and every `{full && …}` block (shown only
// outside that view) removed, braces matched.
function inAppView(src) {
  let out = src.replace(/^import .*$/gm, '');
  for (;;) {
    const at = out.indexOf('{full && ');
    if (at < 0) return out;
    let depth = 0;
    let end = at;
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}' && --depth === 0) break;
    }
    assert.ok(end < out.length, 'balanced guard');
    out = out.slice(0, at) + out.slice(end + 1);
  }
}

// The view with the text of every key it shows (a page that shows src/lib/texts.ts names keys, not words).
function withTexts(view) {
  const keys = [...view.matchAll(/\b(?:t|rich)\('([a-z0-9_]+)'/g)].map((m) => m[1]);
  for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, key), key);
  return [view, ...keys.map((key) => TEXTS[key])].join('\n');
}

const IN_APP_PATHS = new Set(IN_APP_NAV.map((l) => l.href));
// Text that points to activation or states its cost. Activation lives on the node pages (/node/activate) and the
// testnet faucet funds it (SITE-7): their addresses are pointers too.
const ACTIVATION_POINTERS = [
  /aiqnet\.io\/activate/i, /\/activate\b/, /aiqnet\.io\/docs/i, /Activate tab/, /what activation costs/i,
  /activation (cost|price)/i, /\b\d[\d,.]*\s*(1DEV|QNC)\b/, /get the extension|chromewebstore|builds are shared/i,
  /\/node\b/, /aiqnet\.io\/(node|testnet)/i, /\/testnet\b/,
];
// Links whose landing page describes activation and its cost: the repository's front page and its docs.
const REPOSITORY_PAGES = /github\.com\/AIQnetLab\/QNet-Blockchain(\/(tree|blob)[^"'`\s]*)?["'`]/;

test('the header in the app\'s view: the explorer and the policies, the marker kept, nothing else before detection', () => {
  const header = code('components/Header.tsx');
  assert.match(header, /const inApp = !useActivationContent\(\);/);
  assert.match(header, /const navLinks = inApp\s*\? IN_APP_NAV\.map\(\(link\) => \(\{ \.\.\.link, href: keepFromApp\(link\.href, fromApp\) \}\)\)\s*: MAIN_NAV;/);
  assert.match(header, /<Link href=\{inApp \? keepFromApp\(IN_APP_HOME, fromApp\) : '\/'\} className="qnet-logo">QNET<\/Link>/);
  assert.doesNotMatch(header, /isInAppBrowser/, 'the header uses the one rule, not the channel alone');
  // Every header link is a same-origin path (no second host of the site).
  for (const m of header.matchAll(/href: '([^']*)'/g)) assert.match(m[1], /^\/[a-z-]+(\/[a-z-]+)*$/, m[1]);
  // Outside the app's view: Explorer, My node, Wallet, Testnet and the Docs menu (owner, 29.09); the Docs menu is never in it.
  assert.match(header, /\{!inApp && <DocsMenu pathname=\{pathname\} \/>\}/);
  assert.equal(header.match(/<DocsMenu /g)?.length, 1);
  assert.doesNotMatch(header, /<a\s/);
  assert.equal(IN_APP_HOME, '/explorer');
  for (const excluded of IN_APP_EXCLUDED_PAGES) assert.equal(IN_APP_PATHS.has(excluded), false, excluded);
});

// R3-XPD-02: the header's wallet control is shown in the app's view too. In a phone browser without a wallet
// (a page the app opened with ?from=app) an install fallback would do a full navigation to /wallet without
// the marker, and the next page would be the full site. There the control shows nothing instead. Outside that
// view it has one way to connect, My node's; the install pointer lives on My node's connect screen.
test('the header wallet control offers no install target, and leads to My node only outside the app\'s view', () => {
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /const fullView = useActivationContent\(\);/);
  assert.doesNotMatch(button, /installTarget|window\.open|location\.assign/);
  // Every link to My node is inside the branch that runs outside the app's view; the app's view past it shows
  // nothing without a wallet.
  const full = button.indexOf('if (fullView) {');
  const rest = button.indexOf("if (providerStatus === 'missing') return null;");
  assert.ok(full > 0 && rest > full);
  const links = [...button.matchAll(/href=\{?[`'"]\/node/g)].map((m) => m.index);
  assert.equal(links.length, 2);
  for (const at of links) assert.ok(at > full && at < rest, 'a link to /node outside the full view');
  assert.ok(button.indexOf("if (providerStatus === 'detecting')") < full);
});

test('the footer links no repository page in the app\'s view', () => {
  const footer = code('components/Footer.tsx');
  assert.match(footer, /const full = useActivationContent\(\);/);
  assert.doesNotMatch(inAppView(footer), REPOSITORY_PAGES);
});

test('Privacy, Terms and Support in the app\'s view: no pointer to activation or its cost, links only inside that view', () => {
  for (const [path, file] of [['/privacy', 'app/privacy/page.tsx'], ['/terms', 'app/terms/page.tsx'], ['/support', 'app/support/page.tsx']]) {
    assert.ok(IN_APP_PATHS.has(path), path);
    const view = inAppView(code(file));
    // Support shows its texts by key: their words are checked with the page.
    const words = withTexts(view);
    for (const pattern of ACTIVATION_POINTERS) assert.doesNotMatch(words, pattern, `${file}: ${pattern}`);
    assert.doesNotMatch(view, REPOSITORY_PAGES, `${file}: repository page`);
    // Same-site links carry the marker, and lead only to pages of the app's view.
    assert.doesNotMatch(view, /href="\//, `${file}: a same-site link without the marker`);
    for (const m of view.matchAll(/(?:keepFromApp|here)\('([^']+)'/g)) {
      assert.ok(IN_APP_PATHS.has(m[1]), `${file} links ${m[1]}`);
    }
  }
  // The privacy policy names the node pages' and the faucet's addresses only outside the app's view (SITE-7).
  const privacy = code('app/privacy/page.tsx');
  assert.match(privacy, /const full = useActivationContent\(\);/);
  assert.match(privacy, /The node pages\{full && ' \(aiqnet\.io\/node\)'\} send the server/);
  assert.match(privacy, /The faucet\{full && ' on aiqnet\.io\/testnet'\} sends test tokens/);
  // Support shows the documentation link, and the move from the older Android app, only outside the app's view.
  const support = code('app/support/page.tsx');
  assert.match(support, /\{full && <li>\{rich\('support_contact_docs', \{ link: <a href="\/docs">aiqnet\.io\/docs<\/a> \}\)\}<\/li>\}/);
  assert.match(support, /\{full && \(\s*<div className="privacy-section" id="new-app">\s*<h3>\{t\('support_move_title'\)\}<\/h3>\s*<p>\{rich\('support_move', \{ walletPage: <a href="\/wallet">\{t\('support_move_wallet_link'\)\}<\/a> \}\)\}<\/p>\s*<\/div>\s*\)\}/);
  assert.doesNotMatch(inAppView(support), /support_move/);
});

// R4-XPD-06: Support linked the repository's issue tracker (its front page describes activation and its
// cost, its Releases hold the APK) and the Telegram channel (where the site says Android builds are shared),
// and the footer linked Telegram and X, also in the app's view. There the only way off the site is the
// support address.
test('in the app\'s view the footer, Privacy, Terms and Support link nowhere off the site but the support address', () => {
  for (const file of ['components/Footer.tsx', 'app/privacy/page.tsx', 'app/terms/page.tsx', 'app/support/page.tsx']) {
    const view = inAppView(code(file));
    const offSite = [...view.matchAll(/href=(?:"([^"]*)"|'([^']*)'|\{[`'"]([^`'"]*)[`'"]\})/g)]
      .map((m) => m[1] ?? m[2] ?? m[3]).filter((href) => !href.startsWith('/') || href.startsWith('//'));
    for (const href of offSite) assert.equal(href, 'mailto:support@aiqnet.io', `${file} links ${href}`);
    const words = withTexts(view);
    assert.doesNotMatch(words, /https?:\/\/(?!aiqnet\.io\b)[a-z0-9.-]+/i, `${file}: an address off the site`);
    assert.doesNotMatch(words, /t\.me\/|x\.com\/|github\.com\//i, file);
  }
  // Outside that view they are all still there.
  const support = code('app/support/page.tsx');
  assert.match(support, /\{full && <li>\{rich\('support_contact_bugs', \{ link: <a href="https:\/\/github\.com\/AIQnetLab\/QNet-Blockchain\/issues"/);
  assert.match(support, /\{full && <li>\{rich\('support_contact_community', \{ link: <a href="https:\/\/t\.me\/AiQnetLab"/);
  assert.match(support, /<li>\{rich\('support_contact_email', \{ address: <a href="mailto:support@aiqnet\.io">support@aiqnet\.io<\/a> \}\)\}<\/li>/);
  assert.equal(TEXTS.support_contact_bugs, 'Bugs and feature requests: {link}');
  assert.equal(TEXTS.support_contact_community, 'Community: {link}');
  assert.equal(TEXTS.support_contact_email, 'Email: {address}');
  const footer = code('components/Footer.tsx');
  for (const target of ['https://x.com/AIQnetLab', 'https://t.me/AiQnetLab', 'https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet']) {
    assert.ok(footer.includes(`{full && (<a href="${target}"`), target);
  }
});

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) out.push(...files(new URL(`${name}/`, dir)));
    else if (/\.tsx?$/.test(name)) out.push(url);
  }
  return out;
}

test('the explorer (the in-app browser\'s bookmark) links only within the explorer', () => {
  for (const url of files(new URL('app/explorer/', SRC))) {
    const src = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of src.matchAll(/href=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const target = m[1] ?? m[2];
      assert.match(target, /^\/explorer(\/|$)/, `${url.pathname.split('/src/')[1]} links ${target}`);
    }
    for (const m of src.matchAll(/router\.push\(keep\(`([^`]*)`/g)) assert.match(m[1], /^\/explorer\//);
    assert.doesNotMatch(src, REPOSITORY_PAGES);
    for (const pattern of ACTIVATION_POINTERS) assert.doesNotMatch(src, pattern, `${url.pathname}: ${pattern}`);
  }
});

// SD-11: the explorer is the in-app browser's bookmark and the store listing's marketing page. In the app's view its
// type chips, type badges and system accounts carry no reward, activation, emission or burn word (src/lib/tx-labels.ts;
// L-14). A part of a page shown only outside that view (`{full && (...)}`) may name them. The token page's own burn
// wording (a token contract's burn() and its burned supply) stays as it is until the owner decides (L-14).
test('the explorer in the app\'s view names reward and activation types by what they change', async () => {
  const { txTypeLabel, txPartyLabel } = await import('../tx-labels.ts');
  const WORDS = /reward|activation|emission|burn/i;
  const TOKEN_WORDS = /reward|activation|emission/i;
  for (const type of ['Transfer', 'Reward', 'Swap', 'Heartbeat', 'Light Eligibility', 'Registration', 'Activation', 'Contract', 'System', 'RewardDistribution', 'SystemEmission', 'NodeActivation']) {
    assert.doesNotMatch(txTypeLabel(type, false), WORDS, type);
    assert.equal(txTypeLabel(type, true), type, 'outside the app\'s view the chain\'s names stay');
  }
  assert.equal(txTypeLabel('Reward', false), 'Node balance');
  assert.equal(txTypeLabel('Activation', false), 'Node status');
  for (const party of ['system_rewards_pool', 'system_emission', 'emission_pool', 'SystemEmission']) {
    assert.doesNotMatch(txPartyLabel(party, false), WORDS, party);
    assert.equal(txPartyLabel(party, true), party);
  }
  const explorer = code('app/explorer/ExplorerClient.tsx');
  assert.match(explorer, /\{TX_TYPES\.map\(type => \([\s\S]*?\{txTypeLabel\(type, full\)\}/);
  const TX_PAGES = ['app/explorer/ExplorerClient.tsx', 'app/explorer/tx/[hash]/page.tsx', 'app/explorer/block/[hash]/page.tsx', 'app/explorer/address/[address]/page.tsx'];
  for (const file of [...TX_PAGES, 'app/explorer/qnc/page.tsx', 'app/explorer/token/[contract]/page.tsx']) {
    const src = code(file);
    assert.match(src, /const full = useActivationContent\(\);/, file);
    // Every transaction type badge and every system account shown by name goes through the labels.
    if (TX_PAGES.includes(file)) {
      for (const m of src.matchAll(/className=\{`type-badge [^`]*`\}>\{([^}]*)\}<\/span>/g)) assert.match(m[1], /^txTypeLabel\(/, `${file}: ${m[1]}`);
    }
    for (const m of src.matchAll(/<span className="(?:addr|address-link)">\{([^}]*\|\| 'N\/A'[^}]*)\}<\/span>/g)) assert.match(m[1], /txPartyLabel\(\w+(?:\.\w+)? \|\| 'N\/A', full\)$/, `${file}: ${m[1]}`);
    // No text node of the page says it, outside the parts shown only in the full view.
    const shown = src.replace(/\{full && \([\s\S]*?\n\s*\)\}/g, '');
    const words = file === 'app/explorer/token/[contract]/page.tsx' ? TOKEN_WORDS : WORDS;
    for (const m of shown.matchAll(/>([^<>{}]+)</g)) assert.doesNotMatch(m[1], words, `${file}: ${m[1].trim()}`);
  }
  const block = code('app/explorer/block/[hash]/page.tsx');
  assert.match(block, /\{full \? 'Pool 3 Activations' : 'Pool 3 total'\}/);
  assert.match(block, /<h2 className="card-title">\{full \? 'Consensus Data \(Emission Window\)' : 'Consensus Data'\}<\/h2>/);
  assert.match(code('app/explorer/qnc/page.tsx'), /\{full && \(\s*<div className="detail-row">\s*<span className="detail-label">Burned<\/span>/);
});

// SITE-R2-01: the indexer stores a registration's burn facts in tx_type_data, and the transaction page drew every key
// of it, so a registration opened from the app (?from=app) or in its in-app browser showed 'Burn Tx', 'Burn Wallet'
// and 'Burn Amount 1500'. In the app's view the data card shows only the neutral facts.
test('the transaction data card shows no burn fact in the app\'s view', async () => {
  const { txDataEntries } = await import('../tx-labels.ts');
  const { showsActivationContent } = await import('../activate-view.ts');
  const registration = { node_id: 'light_abc', node_type: 'Light', burn_tx: '5sig', burn_wallet: 'SoLwallet', burn_amount: 1500 };
  const views = [
    ['opened with ?from=app', showsActivationContent('available', 'extension', true)],
    ['the in-app browser', showsActivationContent('available', 'mobile', false)],
    ['before detection', showsActivationContent('detecting', null, false)],
  ];
  for (const [name, full] of views) {
    assert.equal(full, false, name);
    const shown = txDataEntries(registration, full);
    assert.deepEqual(shown.map(([k]) => k), ['node_id', 'node_type'], name);
    assert.doesNotMatch(JSON.stringify(shown), /burn|1500|reward|activation/i, name);
    // A key nobody listed (a node's own field) stays out of that view too.
    assert.deepEqual(txDataEntries({ reward_pool: 7, activation_price: 1500, epoch: 3 }, full), [['epoch', 3]], name);
  }
  // The bitmap and batch facts stay, and outside the app's view every key is still shown.
  assert.deepEqual(txDataEntries({ genesis_id: 'g1', epoch: 2, eligible_count: 9 }, false).length, 3);
  assert.deepEqual(txDataEntries({ batch_id: 'b', transfer_count: 4 }, false).length, 2);
  assert.equal(txDataEntries(registration, showsActivationContent('available', 'extension', false)).length, 5);
  assert.deepEqual(txDataEntries(null, false), []);
  // The page draws the card from these entries only.
  const page = code('app/explorer/tx/[hash]/page.tsx');
  assert.match(page, /const entries = txDataEntries\(tx\.tx_type_data, full\);\s*return entries\.length > 0 \?/);
  assert.equal(page.match(/Object\.entries\(tx\.tx_type_data\)/g), null);
});

// R5-XPD-06: explorer pages the store builds open (/explorer/tx/<hash>?from=app) linked every address, block,
// token and transaction without the marker, so after one tap a reload or a new tab showed the full site. Every
// link, push and navigation between explorer pages now keeps it.
test('every link and navigation of the explorer keeps the app\'s marker', () => {
  let links = 0;
  for (const url of files(new URL('app/explorer/', SRC))) {
    const name = url.pathname.split('/src/')[1];
    const src = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
    // No plain Next.js link, anchor or router call that could drop it.
    assert.doesNotMatch(src, /from 'next\/link'|<Link[\s>]|<a\s/, name);
    for (const m of src.matchAll(/router\.(push|replace)\(([^)]*)/g)) assert.match(m[2], /^keep\(/, `${name}: ${m[0]}`);
    for (const m of src.matchAll(/window\.location(?:\.href)?\s*=\s*([^;]+);/g)) assert.match(m[1], /^keep\(/, `${name}: ${m[0]}`);
    assert.doesNotMatch(src, /window\.location\.(assign|replace)\(/, name);
    if (/<ExplorerLink[\s>]/.test(src)) assert.match(src, /^import ExplorerLink from '@\/components\/ExplorerLink';$/m, name);
    if (/\bkeep\(/.test(src)) assert.match(src, /const keep = useKeepFromApp\(\);/, name);
    // Every href is on an ExplorerLink.
    for (const m of src.matchAll(/<(\w+)\s[^>]*?\bhref=/g)) assert.equal(m[1], 'ExplorerLink', `${name}: <${m[1]} href=`);
    links += (src.match(/<ExplorerLink[\s>]/g) ?? []).length;
  }
  assert.ok(links >= 37, `${links} explorer links`);
  // ExplorerLink puts the marker on through the one rule (keepFromApp), with the visit's flag.
  const component = code('components/ExplorerLink.tsx');
  assert.match(component, /const keep = useKeepFromApp\(\);\s*return <Link href=\{keep\(href\)\} \{\.\.\.rest\} \/>;/);
  const context = code('contexts/AppContext.tsx');
  assert.match(context, /export function useKeepFromApp\(\): \(href: string\) => string \{\s*const \{ fromApp \} = useWallet\(\);\s*return useCallback\(\(href: string\) => keepFromApp\(href, fromApp\), \[fromApp\]\);/);
  assert.equal(keepFromApp('/explorer/address/abc', true), '/explorer/address/abc?from=app');
  assert.equal(keepFromApp('/explorer/address/abc', false), '/explorer/address/abc');
});

test('the pages about activation, the node cabinet, the faucet, the DAO, the extension and the docs leave the app\'s view', () => {
  // Unified plan SITE-8: the cabinet, the old activation page and the wallet page join the list.
  assert.deepEqual([...IN_APP_EXCLUDED_PAGES], ['/', '/docs', '/dao', '/testnet', '/qnet-wallet-extension', '/node', '/activate', '/wallet']);
  const home = code('app/page.tsx');
  assert.match(home, /<InAppGuard>\s*<HomeClient initialStats=\{initialStats\} \/>\s*<\/InAppGuard>/);
  for (const route of IN_APP_EXCLUDED_PAGES.filter((r) => r !== '/' && r !== '/node' && r !== '/activate')) {
    const layout = `app${route}/layout.tsx`;
    assert.ok(existsSync(new URL(layout, SRC)), layout);
    assert.match(code(layout), /return <InAppGuard>\{children\}<\/InAppGuard>;/, layout);
  }
  // /activate has no page: it redirects to /node/activate (next.config.js), which the cabinet's guard covers.
  assert.equal(existsSync(new URL('app/activate', SRC)), false);
  assert.match(readFileSync(new URL('../next.config.js', SRC), 'utf8'), /\{ source: '\/activate', destination: '\/node\/activate', permanent: true \}/);
  // Every cabinet page renders inside the guard, the wallet around it.
  const cabinet = code('app/node/layout.tsx');
  assert.match(cabinet, /return \(\s*<InAppGuard>\s*<CabinetProvider phoneFlows=\{phoneFlowsEnabled\(\)\}>\s*<>\{children\}<\/>\s*<\/CabinetProvider>\s*<\/InAppGuard>\s*\);/);
  assert.equal(cabinet.match(/\{children\}/g)?.length, 1);
  // No cabinet page is in the app's navigation, and the site's header leads to it only outside that view.
  assert.equal(IN_APP_NAV.some((l) => l.href.startsWith('/node')), false);
  assert.match(code('components/Header.tsx'), /\{ href: '\/node', label: 'My node' \}/);
  const guard = code('components/InAppGuard.tsx');
  assert.match(guard, /const inApp = fromApp \|\| isInAppBrowser\(providerChannel\);/);
  assert.match(guard, /if \(inApp\) router\.replace\(keepFromApp\(IN_APP_HOME, fromApp\)\);/);
  assert.match(guard, /if \(inApp\) return null;/);
});

// SITE-R3-CSP-02: these pages follow the site's one rule too. Before the wallet is detected (the server's
// render included) their text is in the page but hidden, so the app's in-app browser paints none of it
// while its provider has not announced itself yet; it is displayed only once the page knows it may.
test('the excluded pages display nothing before the wallet is detected, the server\'s render included', () => {
  const guard = code('components/InAppGuard.tsx');
  assert.match(guard, /const show = useActivationContent\(\);/);
  assert.match(guard, /<div hidden=\{!show\} style=\{show \? \{ display: 'contents' \} : undefined\}>\s*\{children\}\s*<\/div>/);
  // The children are rendered only inside that wrapper.
  assert.equal(guard.match(/\{children\}/g)?.length, 1);
  // useActivationContent is false while detecting and in the app's view (activate-view.test.mjs); the
  // provider status starts as 'detecting', on the server as in the browser.
  const context = code('contexts/AppContext.tsx');
  assert.match(context, /useState<ProviderStatus>\('detecting'\)/);
});

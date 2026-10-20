// The site's navigation (owner, 29.09): the logo is Home; the header has Explorer, My node, Wallet, Testnet (its own
// tab on a testnet release, where the faucet is) and a Docs menu (Documentation, How it works, DAO, Support) and the
// wallet control; Privacy, Terms and Support are in the footer. The phone's menu has the same grouping. Every page of
// before is still reachable, and the QNet app's view keeps its own short header. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { IN_APP_NAV } from '../activate-view.ts';
import { ACTIVATION_NETWORK } from '../one-dev.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const links = (block) => [...block.matchAll(/\{ href: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
const HEADER = code('components/Header.tsx');
const section = (name) => HEADER.slice(HEADER.indexOf(`const ${name}`), HEADER.indexOf('];', HEADER.indexOf(`const ${name}`)));

test('the header: Explorer, My node, Wallet, Testnet and the Docs menu; the logo is Home', () => {
  assert.deepEqual(links(section('MAIN_NAV')), [['/explorer', 'Explorer'], ['/node', 'My node'], ['/wallet', 'Wallet'], ['/testnet', 'Testnet']]);
  assert.deepEqual(links(section('DOCS_MENU')), [
    ['/docs', 'Documentation'], ['/docs/how-it-works', 'How it works'], ['/dao', 'DAO'], ['/support', 'Support'],
  ]);
  // Testnet is its own tab, only on a testnet release (the faucet sends test tokens only there).
  assert.match(section('MAIN_NAV'), /\.\.\.\(ACTIVATION_NETWORK === 'testnet' \? \[\{ href: '\/testnet', label: 'Testnet' \}\] : \[\]\),/);
  assert.equal(ACTIVATION_NETWORK, 'testnet');
  // SITE-F14: on a mainnet release the page is not found and the sitemap leaves it out.
  assert.match(code('app/testnet/layout.tsx'), /if \(ACTIVATION_NETWORK !== 'testnet'\) notFound\(\);\s*return <InAppGuard>\{children\}<\/InAppGuard>;/);
  assert.match(code('app/sitemap.ts'), /const pages = ACTIVATION_NETWORK === 'testnet' \? \[\.\.\.PAGES\.slice\(0, 9\), '\/testnet', \.\.\.PAGES\.slice\(9\)\] : PAGES;/);
  // Home is the wordmark, the name together ("Blockchain" a weight lighter, B-SPEC 5.1); Privacy and Terms are no header
  // links.
  assert.match(HEADER, /const NAME = 'QNet Blockchain';\s*const \[MARK, WORD\] = NAME\.split\(' '\);/);
  assert.match(HEADER, /<Link href=\{inApp \? IN_APP_HOME : '\/'\} className="brand" aria-label=\{NAME\} data-field-clear>/);
  assert.match(HEADER, /<span className="brand-name" aria-hidden="true"><b>\{MARK\}<\/b> \{WORD\}<\/span>/);
  assert.doesNotMatch(HEADER, />QNET</);
  assert.doesNotMatch(section('MAIN_NAV') + section('DOCS_MENU'), /'\/privacy'|'\/terms'|label: 'Home'/);
  // One Docs menu, only outside the app's view, inside the one nav the phone's menu opens too. One wallet control, in the
  // header row at every width, never a second one inside the menu.
  const nav = HEADER.slice(HEADER.indexOf('<nav'), HEADER.indexOf('</nav>'));
  assert.match(nav, /\{navLinks\.map\(\(link\) => \(/);
  assert.match(nav, /aria-current=\{isCurrent\(pathname, link\.href\) \? 'page' : undefined\}/);
  assert.match(nav, /\{!inApp && <DocsMenu pathname=\{pathname\} \/>\}/);
  assert.doesNotMatch(nav, /ConnectWalletButton/);
  assert.equal(HEADER.match(/<ConnectWalletButton \/>/g)?.length, 1);
  assert.match(HEADER, /<div className="hdr-acct" data-field-clear>\s*<WalletBoundary><ConnectWalletButton \/><\/WalletBoundary>/);
});

test('the Docs menu: a button that opens its list, closing on a link, outside, Escape and a new page', () => {
  const menu = HEADER.slice(HEADER.indexOf('function DocsMenu('), HEADER.indexOf('const HeaderComponent'));
  assert.match(menu, /<button\s+ref=\{button\}\s+type="button"\s+className="nav-link docs-btn"\s+aria-expanded=\{open\}\s+aria-controls=\{listId\}/);
  assert.match(menu, /<div className="docs-menu" id=\{listId\} hidden=\{!open\}>/);
  assert.match(menu, /useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[pathname\]\);/);
  // Escape closes it and puts focus back on its button.
  assert.match(menu, /if \(e\.key !== 'Escape'\) return;\s*setOpen\(false\);\s*button\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(menu, /if \(root\.current && !root\.current\.contains\(e\.target as Node\)\) setOpen\(false\);/);
  assert.match(menu, /aria-current=\{pathname === link\.href \? 'page' : undefined\}/);
  // A link in the phone's menu closes the whole menu (the nav's click handler).
  assert.match(HEADER, /if \(\(e\.target as HTMLElement\)\.closest\('a'\)\) setIsMenuOpen\(false\);/);
  // On a wide screen the list drops under the button; inside the phone's full-screen menu it stands in place.
  const css = read('styles/shell.css');
  assert.match(css, /\.docs-menu \{\n {2}position: absolute;/);
  const phone = css.slice(css.indexOf('@media (max-width: 860px) {'), css.indexOf('/* ---------- Footer ---------- */'));
  assert.match(phone, /\.docs-menu \{ position: static;/);
  assert.match(phone, /\.menu-btn \{ display: inline-flex;/);
  assert.match(phone, /\.nav \{\n {4}position: fixed; top: var\(--hdr\);/);
  // The phone's menu locks the page's scrolling and gives focus back to Menu on Escape; on a computer no menu shifts the
  // page, since the scrollbar's room is always kept.
  assert.match(HEADER, /html\.style\.overflow = 'hidden';/);
  assert.match(HEADER, /setIsMenuOpen\(false\);\s*menuButton\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(read('styles/base.css'), /html \{[^}]*scrollbar-gutter: stable;/);
  // The header is opaque Ink once scrolled, never blurred over the moving field: nothing scrolled under it shows through
  // (owner 20.10, the faucet line under it on a phone).
  assert.match(css, /\.hdr\[data-scrolled\] \{ background: var\(--ink\); border-bottom-color: var\(--rule\); \}/);
  assert.doesNotMatch(read('styles/tokens.css'), /--ink-92/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(read('app/globals.css') + read('app/mobile-fixes.css'), /\.qnet-header|\.nav-menu-list|\.mobile-menu-button/);
});

test('the footer: Privacy and Terms on every page, in the small line under it', () => {
  const footer = code('components/Footer.tsx');
  assert.deepEqual(links(footer.slice(footer.indexOf('const FOOTER_LINKS'), footer.indexOf('];', footer.indexOf('const FOOTER_LINKS')))), [
    ['/privacy', 'Privacy'], ['/terms', 'Terms'],
  ]);
  // Owner, 12.10: Support lives in the Docs menu, not twice; the legal links sit in one small line with the copyright.
  assert.match(footer, /<div className="ftr-legal">\s*<span className="ftr-copyright">© 2026 Orrery Group LLC<\/span>\s*<nav className="ftr-links"/);
  assert.match(footer, /<Link key=\{link\.href\} href=\{link\.href\} className="ftr-link">\{link\.label\}<\/Link>/);
  // Shown in the app's view too: the policies are pages of that view.
  assert.doesNotMatch(footer, /\{full && \(?<nav className="ftr-links"/);
  // The head block's height, a link to its page, joins the chain's stream only while the footer is near the screen.
  assert.match(footer, /<span className="ftr-height"><LiveDot \/>Block \{near \? <LiveHeight \/> : <span className="dash">—<\/span>\}<\/span>/);
  assert.match(footer, /return head\.height > 0 \? <EntityLink kind="block" value=\{head\.height\} \/> :/);
  for (const [href] of [['/privacy'], ['/terms'], ['/support']]) assert.ok(IN_APP_NAV.some((l) => l.href === href), href);
  // Owner, 05.10 and 11.10: the live Android listing as its official store badge, off the app's view like every other
  // off-site link. The iOS badge beside it, the same size and with no caption, opens the App Store listing only, and
  // until it is live is shown without a link (owner, 12.10: a badge never opens a placeholder); iPhone and iPad then
  // install from a TestFlight link named as such. One group a phone wraps whole.
  const badges = footer.slice(footer.indexOf('{full && (<div className="store-badges">'), footer.indexOf('</div>)}', footer.indexOf('className="store-badges"')));
  assert.ok(badges.length > 0, 'the store badges in one group, off the app\'s view');
  assert.match(badges, /<a href=\{ANDROID_PLAY_URL\} target="_blank" rel="noopener noreferrer" className="google-play-badge">\s*<img src="\/badges\/google-play\.png" alt=\{t\('store_badge_android'\)\} width=\{646\} height=\{250\} \/>\s*<\/a>/);
  assert.match(badges, /\{IOS_APP_STORE_URL \? \(\s*<a href=\{IOS_APP_STORE_URL\} target="_blank" rel="noopener noreferrer" className="app-store-badge">\s*<img src="\/badges\/app-store\.svg" alt=\{t\('store_badge_ios'\)\} className="store-badge" width=\{120\} height=\{40\} \/>\s*<\/a>\s*\) : \(\s*<span className="app-store-badge">\s*<img src="\/badges\/app-store\.svg" alt=\{t\('store_badge_ios'\)\} className="store-badge" width=\{120\} height=\{40\} \/>\s*<\/span>\s*\)\}/);
  assert.doesNotMatch(footer, /IOS_INSTALL_URL|IOS_TESTFLIGHT_URL\} target="_blank" rel="noopener noreferrer" className="app-store-badge"|soon/i);
  assert.match(footer, /\{full && !IOS_APP_STORE_URL && \(\s*<a href=\{IOS_TESTFLIGHT_URL\} target="_blank" rel="noopener noreferrer" className="ftr-link">TestFlight<\/a>\s*\)\}/);
  assert.equal(TEXTS.store_soon, undefined);
  assert.doesNotMatch(footer, />Google Play<\/a>/);
  assert.match(read('lib/app-links.ts'), /export const ANDROID_PLAY_URL = `https:\/\/play\.google\.com\/store\/apps\/details\?id=\$\{ANDROID_PLAY_PACKAGE\}`;/);
  assert.match(read('lib/app-links.ts'), /export const IOS_APP_STORE_URL: string \| null = null;/);
  assert.match(read('lib/app-links.ts'), /export const IOS_INSTALL_URL: string = IOS_APP_STORE_URL \?\? IOS_TESTFLIGHT_URL;/);
  for (const file of ['google-play.png', 'app-store.svg']) assert.ok(existsSync(new URL(`../public/badges/${file}`, SRC)), file);
  // The row wraps on a narrow phone instead of being cut at the page's edge, and keeps its height in the app's view,
  // where it is empty, so nothing moves when the wallet is detected.
  assert.match(footer, /<div className="ftr-row">/);
  const css = read('styles/shell.css');
  assert.match(css, /\.ftr-row \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 44px;/);
  // One line needs the marks, the TestFlight link and the badges (about 553 px of row, measured): two lines up to 640 px.
  assert.match(css, /@media \(max-width: 640px\) \{\n {2}\.ftr-row \{ min-height: 96px; \}\n {2}\.store-badges \{ margin-left: 0; \}/);
  // No rule stretches every link to the store: an inline link to it stays in its sentence. Both badges at one visible
  // height (the Google Play artwork carries its own clear space), kept together when the row wraps.
  assert.doesNotMatch(read('app/globals.css') + css, /^a\[href\*="play\.google\.com"\]/m);
  assert.match(css, /\.app-store-badge img \{ display: block; height: 40px; width: auto; \}/);
  assert.match(css, /\.google-play-badge img \{ display: block; height: 60px; width: auto; margin-block: -10px; \}/);
  assert.match(css, /\.store-badges \{ display: flex; align-items: center; gap: 12px; flex: none;/);
  assert.match(css, /\.app-store-badge, \.google-play-badge \{ display: flex; align-items: center; min-height: 44px; \}/);
});

test('every page of before is still there, and the app\'s view keeps its short header', () => {
  for (const page of ['page.tsx', 'explorer/page.tsx', 'node/page.tsx', 'dao/page.tsx', 'testnet/page.tsx', 'wallet/page.tsx', 'docs/page.tsx', 'privacy/page.tsx', 'terms/page.tsx', 'support/page.tsx', 'docs/how-it-works/page.tsx']) {
    assert.ok(existsSync(new URL(`app/${page}`, SRC)), page);
  }
  assert.deepEqual(IN_APP_NAV.map((l) => l.href), ['/explorer', '/privacy', '/terms', '/support']);
  assert.match(HEADER, /const navLinks = inApp \? IN_APP_NAV : MAIN_NAV;/);
});

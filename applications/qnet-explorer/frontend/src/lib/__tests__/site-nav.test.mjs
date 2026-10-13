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
  // Home is the logo; Privacy and Terms are no header links.
  assert.match(HEADER, /<Link href=\{inApp \? IN_APP_HOME : '\/'\} className="qnet-logo">QNET<\/Link>/);
  assert.doesNotMatch(section('MAIN_NAV') + section('DOCS_MENU'), /'\/privacy'|'\/terms'|label: 'Home'/);
  // One Docs menu, only outside the app's view, inside the one nav the phone's menu opens too.
  const nav = HEADER.slice(HEADER.indexOf('<nav className={`qnet-nav'), HEADER.indexOf('</nav>'));
  assert.match(nav, /\{navLinks\.map\(link => \(/);
  assert.match(nav, /\{!inApp && <DocsMenu pathname=\{pathname\} \/>\}/);
  assert.match(nav, /<div className="header-right-mobile">\s*<WalletBoundary><ConnectWalletButton \/><\/WalletBoundary>/);
});

test('the Docs menu: a button that opens its list, closing on a link, outside, Escape and a new page', () => {
  const menu = HEADER.slice(HEADER.indexOf('function DocsMenu('), HEADER.indexOf('const HeaderComponent'));
  assert.match(menu, /<button\s+type="button"\s+className="nav-button nav-menu-button"\s+aria-expanded=\{open\}\s+aria-controls=\{listId\}/);
  assert.match(menu, /<div className="nav-menu-list" id=\{listId\} hidden=\{!open\}>/);
  assert.match(menu, /useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[pathname\]\);/);
  assert.match(menu, /if \(e\.key === 'Escape'\) setOpen\(false\);/);
  assert.match(menu, /if \(root\.current && !root\.current\.contains\(e\.target as Node\)\) setOpen\(false\);/);
  assert.match(menu, /aria-current=\{pathname === link\.href \? 'page' : undefined\}/);
  // A link in the phone's menu closes the whole menu (the nav's click handler).
  assert.match(HEADER, /if \(\(e\.target as HTMLElement\)\.closest\('a'\)\) setIsMenuOpen\(false\);/);
  // On a wide screen the list drops under the button; inside the phone's menu it stands in place.
  const css = read('app/globals.css');
  assert.match(css, /\.nav-menu-list \{\n {2}position: absolute;/);
  const phone = css.slice(css.indexOf('@media (max-width: 860px) {'), css.indexOf('/* == 3. MOBILE PHONES == */'));
  assert.match(phone, /\.nav-menu-list \{\n {4}position: static;/);
  assert.match(phone, /\.mobile-menu-button \{\n {4}display: flex;/);
  assert.match(read('app/mobile-fixes.css'), /@media \(max-width: 860px\) \{\n {2}\.qnet-header \{ height: 60px; \}/);
  assert.doesNotMatch(css + read('app/mobile-fixes.css'), /@media \(max-width: 1200px\) \{\n {2}\.qnet-header/);
});

test('the footer: Privacy and Terms on every page, in the small line under it', () => {
  const footer = code('components/Footer.tsx');
  assert.deepEqual(links(footer.slice(footer.indexOf('const FOOTER_LINKS'), footer.indexOf('];', footer.indexOf('const FOOTER_LINKS')))), [
    ['/privacy', 'Privacy'], ['/terms', 'Terms'],
  ]);
  // Owner, 12.10: Support lives in the Docs menu, not twice; the legal links sit in one small line with the copyright.
  assert.match(footer, /<div className="footer-legal">\s*<span className="footer-copyright">© 2026 Orrery Group LLC<\/span>\s*<nav className="footer-links"/);
  assert.match(footer, /<Link key=\{link\.href\} href=\{link\.href\} className="footer-link">\{link\.label\}<\/Link>/);
  // Shown in the app's view too: the policies are pages of that view.
  assert.doesNotMatch(footer, /\{full && \(?<nav className="footer-links"/);
  for (const [href] of [['/privacy'], ['/terms'], ['/support']]) assert.ok(IN_APP_NAV.some((l) => l.href === href), href);
  // Owner, 05.10 and 11.10: the live Android listing as its official store badge, off the app's view like every other
  // off-site link. Owner, 12.10: the iOS badge shows now beside it, the same size and with no caption, not a link until
  // IOS_APP_STORE_URL names the live listing. Both sit in one group that a phone wraps whole under the icons.
  const badges = footer.slice(footer.indexOf('{full && (<div className="store-badges">'), footer.indexOf('</div>)}', footer.indexOf('className="store-badges"')));
  assert.ok(badges.length > 0, 'the store badges in one group, off the app\'s view');
  assert.match(badges, /<a href=\{ANDROID_PLAY_URL\} target="_blank" rel="noopener noreferrer" className="google-play-badge">\s*<img src="\/badges\/google-play\.png" alt=\{t\('store_badge_android'\)\} width=\{646\} height=\{250\} \/>\s*<\/a>/);
  assert.match(badges, /\{IOS_APP_STORE_URL \? \(<a href=\{IOS_APP_STORE_URL\} target="_blank" rel="noopener noreferrer" className="app-store-badge">\s*<img src="\/badges\/app-store\.svg" alt=\{t\('store_badge_ios'\)\} className="store-badge" width=\{120\} height=\{40\} \/>/);
  const ios = badges.match(/\) : \((<span className="app-store-badge">[\s\S]*?<\/span>)\)\}/);
  assert.ok(ios, 'the iOS badge before its listing');
  assert.match(ios[1], /^<span className="app-store-badge">\s*<img src="\/badges\/app-store\.svg" alt=\{t\('store_badge_ios'\)\} className="store-badge" width=\{120\} height=\{40\} \/>\s*<\/span>$/);
  assert.doesNotMatch(ios[1], /href|<a\b|onClick|soon/i);
  assert.equal(TEXTS.store_soon, undefined);
  assert.doesNotMatch(footer, />Google Play<\/a>/);
  assert.match(read('lib/app-links.ts'), /export const ANDROID_PLAY_URL = `https:\/\/play\.google\.com\/store\/apps\/details\?id=\$\{ANDROID_PLAY_PACKAGE\}`;/);
  assert.match(read('lib/app-links.ts'), /export const IOS_APP_STORE_URL: string \| null = null;/);
  for (const file of ['google-play.png', 'app-store.svg']) assert.ok(existsSync(new URL(`../public/badges/${file}`, SRC)), file);
  // The row wraps on a narrow phone instead of being cut at the page's edge.
  assert.match(footer, /className="social-links badge-row">/);
  assert.match(read('app/globals.css'), /@media \(max-width: 768px\) \{[\s\S]*?\.badge-row \{\n {4}flex-wrap: wrap;/);
  // No rule stretches every link to the store: an inline link to it stays in its sentence.
  const css = read('app/globals.css');
  assert.doesNotMatch(css, /^a\[href\*="play\.google\.com"\]/m);
  assert.match(css, /\.google-play-badge img \{\n {2}height: 66px !important;/);
  assert.match(css, /\.app-store-badge \{\n {2}display: flex;\n {2}align-items: center;\n {2}min-height: 44px;\n\}/);
  assert.match(css, /\.store-badges \{\n {2}display: flex;\n {2}align-items: center;\n {2}gap: 0\.75rem;\n\}/);
});

test('every page of before is still there, and the app\'s view keeps its short header', () => {
  for (const page of ['page.tsx', 'explorer/page.tsx', 'node/page.tsx', 'dao/page.tsx', 'testnet/page.tsx', 'wallet/page.tsx', 'docs/page.tsx', 'privacy/page.tsx', 'terms/page.tsx', 'support/page.tsx', 'docs/how-it-works/page.tsx']) {
    assert.ok(existsSync(new URL(`app/${page}`, SRC)), page);
  }
  assert.deepEqual(IN_APP_NAV.map((l) => l.href), ['/explorer', '/privacy', '/terms', '/support']);
  assert.match(HEADER, /const navLinks = inApp \? IN_APP_NAV : MAIN_NAV;/);
});

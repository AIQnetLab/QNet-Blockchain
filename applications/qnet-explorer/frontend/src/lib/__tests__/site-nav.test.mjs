// The site's navigation (owner, 29.09): the logo is Home; the header has Explorer, My node, Wallet, Testnet (its own
// tab on a testnet release, where the faucet is) and a Docs menu (Documentation, How it works, DAO, Support) and the
// wallet control; Privacy, Terms and Support are in the footer. The phone's menu has the same grouping. Every page of
// before is still reachable, and the QNet app's view keeps its own short header. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { IN_APP_NAV } from '../activate-view.ts';
import { ACTIVATION_NETWORK } from '../one-dev.ts';

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
  assert.match(HEADER, /<Link href=\{inApp \? keepFromApp\(IN_APP_HOME, fromApp\) : '\/'\} className="qnet-logo">QNET<\/Link>/);
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

test('the footer: Privacy, Terms and Support on every page, with the app\'s marker in its view', () => {
  const footer = code('components/Footer.tsx');
  assert.deepEqual(links(footer.slice(footer.indexOf('const FOOTER_LINKS'), footer.indexOf('];', footer.indexOf('const FOOTER_LINKS')))), [
    ['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/support', 'Support'],
  ]);
  assert.match(footer, /<Link key=\{link\.href\} href=\{keepFromApp\(link\.href, fromApp\)\} className="footer-link">\{link\.label\}<\/Link>/);
  // Shown in the app's view too: the policies are pages of that view.
  assert.doesNotMatch(footer, /\{full && \(?<nav className="footer-links"/);
  for (const [href] of [['/privacy'], ['/terms'], ['/support']]) assert.ok(IN_APP_NAV.some((l) => l.href === href), href);
  // Owner, 05.10: the live Google Play listing, off the app's view like every other off-site link.
  assert.match(footer, /\{full && \(<a href=\{ANDROID_PLAY_URL\} target="_blank" rel="noopener noreferrer" className="footer-link">Google Play<\/a>\)\}/);
  assert.match(read('lib/app-links.ts'), /export const ANDROID_PLAY_URL = `https:\/\/play\.google\.com\/store\/apps\/details\?id=\$\{ANDROID_PLAY_PACKAGE\}`;/);
});

test('every page of before is still there, and the app\'s view keeps its short header', () => {
  for (const page of ['page.tsx', 'explorer/page.tsx', 'node/page.tsx', 'dao/page.tsx', 'testnet/page.tsx', 'wallet/page.tsx', 'docs/page.tsx', 'privacy/page.tsx', 'terms/page.tsx', 'support/page.tsx', 'docs/how-it-works/page.tsx']) {
    assert.ok(existsSync(new URL(`app/${page}`, SRC)), page);
  }
  assert.deepEqual(IN_APP_NAV.map((l) => l.href), ['/explorer', '/privacy', '/terms', '/support']);
  assert.match(HEADER, /const navLinks = inApp\s*\? IN_APP_NAV\.map\(\(link\) => \(\{ \.\.\.link, href: keepFromApp\(link\.href, fromApp\) \}\)\)\s*: MAIN_NAV;/);
});

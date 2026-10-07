// The site's shell and its public routes: the link page renders outside the shell, and no debug route or
// unchecked provenance claim is served. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { LINK_PAGE_PATH } from '../hosts.ts';

const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) out.push(...files(new URL(`${name}/`, dir)));
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(url);
  }
  return out;
}

// SITE-R3-CSP-03: link.aiqnet.io serves only the link page (protocol section 4), and the extension does not
// run there. Inside the site's shell the page ran provider discovery, ended in 'missing', offered the store
// ("QNet Wallet is not installed") to a visitor who has the extension, and showed the site's navigation, with
// every site script running beside the request in the URL. It now renders alone, on every host.
test('the link page renders without the wallet context, the wallet control, the navigation or the footer', () => {
  assert.equal(LINK_PAGE_PATH, '/l');
  assert.ok(existsSync(new URL('app/l/page.tsx', SRC)));

  const layout = code('app/layout.tsx');
  assert.match(layout, /<SiteShell onLinkHost=\{onLinkHost\}>\{children\}<\/SiteShell>/);
  assert.doesNotMatch(layout, /AppProvider|<Header|<Footer|<MatrixRain|ConnectWalletButton/);

  const shell = code('components/SiteShell.tsx');
  assert.match(shell, /const pathname = usePathname\(\);/);
  const at = shell.indexOf('if (onLinkHost || pathname === LINK_PAGE_PATH) {');
  assert.ok(at > 0, 'the link page branch');
  const linkBranch = shell.slice(at, shell.indexOf('\n  }\n', at));
  assert.match(linkBranch, /return \(\s*<div className="app-wrapper">\s*<main className="qnet-container">\{children\}<\/main>\s*<\/div>\s*\);/);
  assert.doesNotMatch(linkBranch, /AppProvider|Header|Footer|MatrixRain|Wallet/);
  // Everything else gets the shell, with the wallet context around the header and the page.
  const siteBranch = shell.slice(shell.indexOf('\n  }\n', at));
  assert.match(siteBranch, /<AppProvider>\s*<div className="app-wrapper">\s*<MatrixRain \/>\s*<Header \/>\s*<main className="qnet-container">\{children\}<\/main>\s*<Footer \/>\s*<\/div>\s*<\/AppProvider>/);

  // The shell is the one place that mounts the wallet context.
  for (const url of files(SRC)) {
    const rel = url.pathname.split('/src/')[1];
    if (rel.startsWith('lib/__tests__/') || rel === 'contexts/AppContext.tsx') continue;
    if (/<AppProvider\b/.test(readFileSync(url, 'utf8'))) assert.equal(rel, 'components/SiteShell.tsx', rel);
  }

  // The link page itself imports nothing of the site's wallet state.
  for (const file of ['app/l/page.tsx', 'app/l/LinkButtons.tsx']) {
    assert.doesNotMatch(code(file), /AppContext|useWallet|ConnectWalletButton|Header|Footer/, file);
  }
});

// SITE-R4-CSP-01: /icon-1.png (any number passed the host rule) and /_next/staticx (nginx handed it to the
// app as Host 127.0.0.1:3000, a "local run") rendered the site's 404 page with the whole shell on
// link.aiqnet.io: provider discovery ending in "not installed", Connect wallet, the navigation. The link
// host now serves only its exact files and every other path there goes to the site (hosts.test.mjs), nginx
// passes the Host on every location (deploy-config.test.mjs), and any page rendered for that host at all
// renders without the shell.
test('the link host renders nothing inside the site\'s shell, its 404 page included', () => {
  // The root layout decides from the request's own Host, on every page and on the 404 page.
  const layout = code('app/layout.tsx');
  assert.match(layout, /const onLinkHost = requestHost\(\(await headers\(\)\)\.get\('host'\)\) === LINK_HOST;/);
  assert.match(layout, /import \{ LINK_HOST, requestHost \} from '@\/lib\/hosts';/);
  const shell = code('components/SiteShell.tsx');
  assert.match(shell, /export default function SiteShell\(\{ children, onLinkHost \}: \{ children: React\.ReactNode; onLinkHost: boolean \}\)/);
  // The bare branch is the first statement after the pathname: nothing of the shell renders before it.
  assert.match(shell, /const pathname = usePathname\(\);\s*if \(onLinkHost \|\| pathname === LINK_PAGE_PATH\) \{\s*return \(\s*<div className="app-wrapper">\s*<main className="qnet-container">\{children\}<\/main>\s*<\/div>\s*\);\s*\}/);
  // A not-found page of the site's own, if one is added, brings no part of the shell with it.
  for (const file of ['app/not-found.tsx', 'app/global-error.tsx', 'app/error.tsx']) {
    if (existsSync(new URL(file, SRC))) assert.doesNotMatch(code(file), /AppProvider|<Header|<Footer|ConnectWalletButton|useWallet/, file);
  }
});

// SITE-R3-CSP-04: /api/verify-build answered "verified" and "This build corresponds to the code on GitHub"
// without checking anything, and hashed the source tree on every request; /test was a debug page.
test('no debug page and no unchecked build-provenance route', () => {
  assert.equal(existsSync(new URL('app/test', SRC)), false);
  assert.equal(existsSync(new URL('app/api/verify-build', SRC)), false);
  for (const url of files(SRC)) {
    const rel = url.pathname.split('/src/')[1];
    if (rel.startsWith('lib/__tests__/')) continue;
    const text = readFileSync(url, 'utf8');
    assert.doesNotMatch(text, /verify-build|corresponds to the code on GitHub|status: 'verified'/, rel);
  }
  const deploy = ['deploy.sh', 'deploy.bat'].map((f) => readFileSync(new URL(`../${f}`, SRC), 'utf8'));
  for (const text of deploy) assert.doesNotMatch(text, /verify-build/);
});

// SITE-15: a stray empty file named like the mobile app's WalletManager sat among the site's components. No source
// file of the site is empty, and that one is gone.
test('no empty source file, and no stray copy of the mobile app\'s files', () => {
  assert.equal(existsSync(new URL('components/WalletManager.js', SRC)), false);
  for (const url of files(SRC)) assert.ok(statSync(url).size > 0, url.pathname.split('/src/')[1]);
});
// The hosts (src/lib/hosts.ts, used by src/proxy.ts): aiqnet.io is the site's one origin; link.aiqnet.io
// serves the link page and the app-association files; every other path there, and every path on any other
// host, goes to the same path on aiqnet.io. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { LINK_HOST, LINK_ORIGIN, LINK_PAGE_PATH, SITE_HOST, SITE_ICONS, SITE_ORIGIN, hostRedirect, requestHost } from '../hosts.ts';
import { LINK_PREFIX } from '../qnet-link.ts';

test('the link host is its own host; the site stays on aiqnet.io', () => {
  assert.equal(SITE_HOST, 'aiqnet.io');
  assert.equal(SITE_ORIGIN, 'https://aiqnet.io');
  assert.equal(LINK_HOST, 'link.aiqnet.io');
  assert.equal(LINK_ORIGIN, 'https://link.aiqnet.io');
  assert.equal(LINK_PAGE_PATH, '/l');
  assert.ok(LINK_PREFIX.startsWith(`${LINK_ORIGIN}${LINK_PAGE_PATH}#`));
});

test('the link host serves the link page and the app-association files itself', () => {
  for (const path of [LINK_PAGE_PATH, '/.well-known/assetlinks.json', '/.well-known/apple-app-site-association', '/manifest.json', '/icon-32.png']) {
    assert.equal(hostRedirect(LINK_HOST, path, ''), null, path);
    assert.equal(hostRedirect(LINK_HOST, path, '', true), null, `${path} (development build)`);
  }
  // A Next.js data request for the page keeps its query.
  assert.equal(hostRedirect(LINK_HOST, '/l', '?_rsc=abc'), null);
});

// SITE-R4-CSP-01: the rule let /icon-<any digits>.png through, and a path without a file there rendered the
// site's 404 page, shell and all, on the link host. It serves exactly the icons the page head names.
test('the link host serves exactly the icons the page head and the manifest name, each a file of the site', () => {
  const layout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
  const named = new Set([...layout.matchAll(/'(\/icon-\d+\.png|\/favicon\.ico)'/g)].map((m) => m[1]));
  const manifest = JSON.parse(readFileSync(new URL('../../../public/manifest.json', import.meta.url), 'utf8'));
  for (const icon of manifest.icons) named.add(icon.src);
  assert.deepEqual([...named].sort(), [...SITE_ICONS].sort());
  for (const icon of SITE_ICONS) {
    assert.ok(existsSync(new URL(`../../../public${icon}`, import.meta.url)), icon);
    assert.equal(hostRedirect(LINK_HOST, icon, ''), null, icon);
  }
  for (const path of ['/icon-1.png', '/icon-0.png', '/icon-999.png', '/icon-016.png', '/icon-16.png/', '/icon-16.PNG', '/icon-.png', '/_next/staticx', '/_next/static', '/_next/staticfoo/a.js']) {
    assert.equal(hostRedirect(LINK_HOST, path, ''), `${SITE_ORIGIN}${path}`, path);
    assert.equal(hostRedirect(LINK_HOST, path, '', true), `${SITE_ORIGIN}${path}`, `${path} (development build)`);
  }
});

test('every other path on the link host goes to the site, query included, in every build', () => {
  for (const [path, search] of [
    ['/', ''], ['/activate', ''], ['/wallet', '?x=1'], ['/l/', ''], ['/L', ''], ['/lx', ''], ['/.well-known/other', ''],
    ['/api/link/sessions', ''], ['/api/link/sessions/0123/response', ''], ['//evil.example', ''], ['/icon-1.png', ''],
    ['/manifest.json/', ''], ['/_next/image', '?url=x'],
  ]) {
    for (const dev of [false, true]) {
      const to = hostRedirect(LINK_HOST, path, search, dev);
      assert.equal(to, `${SITE_ORIGIN}${path}${search}`, path);
      assert.equal(new URL(to).origin, SITE_ORIGIN, path);
    }
  }
});

test('aiqnet.io and a local run serve every path', () => {
  for (const host of [SITE_HOST, 'localhost', '127.0.0.1']) {
    for (const path of ['/', '/activate', '/l', '/api/link/sessions', '/api/faucet/claim', '/explorer']) {
      assert.equal(hostRedirect(host, path, '?x=1'), null, `${host} ${path}`);
    }
  }
});

// SITE-R3-CSP-01 / SITE-R3-02: www., explorer. or any other Host header would be a second origin running
// the whole site (Connect wallet, /activate, /l, the relay, the faucet) that the rest of the system does
// not know. A production build sends each of them to the same path on aiqnet.io.
test('every other host goes to the same path on aiqnet.io, API routes included', () => {
  const hosts = ['www.aiqnet.io', 'explorer.aiqnet.io', 'evil.example', '', 'aiqnet.io.', 'aiqnet.io.evil.example',
    'link.aiqnet.io.evil.example', 'xaiqnet.io', 'a.www.aiqnet.io', '195.246.231.53', '[::1]', 'localhost.evil.example'];
  for (const host of hosts) {
    for (const [path, search] of [['/activate', ''], ['/l', ''], ['/explorer', '?q=1'], ['/api/link/sessions', ''],
      ['/api/link/sessions/00112233445566778899aabbccddeeff/response', ''], ['/api/faucet/claim', ''], ['/', '']]) {
      const to = hostRedirect(host, path, search);
      assert.equal(to, `${SITE_ORIGIN}${path}${search}`, `${host} ${path}`);
      assert.equal(new URL(to).origin, SITE_ORIGIN, `${host} ${path}`);
    }
  }
  // A development build (next dev, opened on the LAN by its address) serves any host but the link host.
  for (const host of hosts) assert.equal(hostRedirect(host, '/activate', '', true), null, host);
});

test('requestHost: lowercase, without a port', () => {
  assert.equal(requestHost('LINK.aiqnet.io'), 'link.aiqnet.io');
  assert.equal(requestHost('link.aiqnet.io:443'), 'link.aiqnet.io');
  assert.equal(requestHost('WWW.AiQnet.io:8443'), 'www.aiqnet.io');
  assert.equal(requestHost('localhost:3100'), 'localhost');
  assert.equal(requestHost(null), '');
});

test('the proxy applies it to every host, and its API matcher covers every host but aiqnet.io', () => {
  const src = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8');
  assert.match(src, /hostRedirect\(requestHost\(request\.headers\.get\('host'\)\), pathname, search, DEV\)/);
  assert.match(src, /NextResponse\.redirect\(elsewhere, 308\)/);
  assert.match(src, /const DEV = process\.env\.NODE_ENV !== 'production';/);
  // Next.js reads the matcher statically, so the host is a literal there: a regular expression, dots escaped.
  const escaped = SITE_HOST.replace(/\./g, '\\\\\\\\\\.');
  assert.match(src, new RegExp(`source: '/api/:path\\*', has: \\[\\{ type: 'host', value: '\\(\\?!${escaped}\\$\\)\\.\\*' \\}\\]`));
});

test('the header links the explorer on this origin, never another host', () => {
  const header = readFileSync(new URL('../../components/Header.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(header, /explorer\.aiqnet\.io|https:\/\/aiqnet\.io|isExplorerDomain/);
  assert.match(header, /\{ href: '\/explorer', label: 'Explorer' \}/);
});

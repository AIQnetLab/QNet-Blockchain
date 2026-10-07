// Which requests reach src/proxy.ts (the site's proxy, Next.js 16's name for middleware), decided by Next.js's
// own matcher code on the proxy's config:
// every page request, prefetch and router requests included, gets the nonce CSP and the host routing, and
// every request to a host other than aiqnet.io but its build assets reaches the host routing (a 308 to
// aiqnet.io, except the link host's own files and a local run). Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LINK_HOST, SITE_ORIGIN, hostRedirect, requestHost } from '../hosts.ts';

const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js');
const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher.js');

// The exported config is a plain object literal (Next.js reads it statically); evaluate that literal.
const src = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const literal = /export const config = (\{[\s\S]*?\n\});/.exec(src);
assert.ok(literal, 'proxy config literal');
const config = new Function(`return (${literal[1]});`)();
// The site's own next.config.js: a basePath or i18n there would change the matcher.
const nextConfig = require('../../../next.config.js');
const reaches = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, nextConfig));

const PREFETCH = [
  {},
  { purpose: 'prefetch' },
  { 'next-router-prefetch': '1', rsc: '1' },
  { 'next-router-prefetch': '1', purpose: 'prefetch', rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' },
  { rsc: '1' },
];

const request = (host, headers = {}) => ({ headers: { host, ...headers } });

test('every page request reaches the proxy on the site, prefetch or not', () => {
  for (const path of ['/', '/wallet', '/activate', '/explorer/tx/abc', '/privacy', '/l', '/manifest.json', '/icon-32.png', '/_next/image', '/_next/data/x/y.json']) {
    for (const headers of PREFETCH) {
      assert.equal(reaches(path, request('aiqnet.io', headers), {}), true, `${path} ${JSON.stringify(headers)}`);
    }
  }
});

// Plan-site section 8: every node cabinet page reaches the proxy, and its policy adds no worker, no frame, a manifest
// from this origin only and, in production, upgrade-insecure-requests.
test('every node cabinet page reaches the proxy and gets the cabinet\'s stricter policy', async () => {
  for (const path of ['/node', '/node/activate', '/node/code', '/node/devices', '/node/claim', '/node/history', '/node/guide']) {
    for (const headers of PREFETCH) assert.equal(reaches(path, request('aiqnet.io', headers), {}), true, `${path} ${JSON.stringify(headers)}`);
  }
  assert.match(src, /const CABINET_EXTRA = \["worker-src 'none'", "frame-src 'none'", "manifest-src 'self'"\];/);
  assert.match(src, /function isCabinetPath\(pathname: string\): boolean \{\s*return pathname === '\/node' \|\| pathname\.startsWith\('\/node\/'\);\s*\}/);
  assert.match(src, /\.\.\.\(cabinet \? \[\.\.\.CABINET_EXTRA, \.\.\.\(DEV \? \[\] : \['upgrade-insecure-requests'\]\)\] : \[\]\),/);
  assert.match(src, /const csp = policy\(newNonce\(\), isCabinetPath\(pathname\)\);/);
  // The old activation page is a permanent (308) redirect to the cabinet's (next.config.js).
  const redirects = await nextConfig.redirects();
  assert.deepEqual(redirects.find((r) => r.source === '/activate'), { source: '/activate', destination: '/node/activate', permanent: true });
});

test('on the link host every path but the build assets reaches it, and all but the link page go to the site', () => {
  // SITE-R4-CSP-01: /icon-1.png and /_next/staticx rendered the site's 404 page there, shell and all.
  for (const path of ['/', '/activate', '/wallet', '/faucet', '/_next/image', '/explorer', '/api/link/sessions', '/api/activation/price',
    '/icon-1.png', '/icon-999.png', '/_next/staticx', '/_next/staticfoo', '/_next/static']) {
    for (const headers of PREFETCH) {
      assert.equal(reaches(path, request(`${LINK_HOST}:443`, headers), {}), true, `${path} ${JSON.stringify(headers)}`);
    }
    // What the proxy then does with it: a 308 to the same path on the site.
    assert.equal(hostRedirect(requestHost(`${LINK_HOST}:443`), path, ''), `${SITE_ORIGIN}${path}`, path);
  }
  for (const path of ['/l', '/.well-known/assetlinks.json', '/.well-known/apple-app-site-association']) {
    assert.equal(reaches(path, request(LINK_HOST, { purpose: 'prefetch' }), {}), true, path);
    assert.equal(hostRedirect(LINK_HOST, path, ''), null, path);
  }
});

// SITE-R3-02: the relay and the faucet answer only on aiqnet.io. On www., explorer. or any other host an API
// request reaches the proxy, which sends it to aiqnet.io, so no nginx block of another name can hand the
// relay a client's own X-Real-IP or log its session ids.
test('on every other host API routes and pages reach it, and all go to the site', () => {
  for (const host of ['www.aiqnet.io', 'explorer.aiqnet.io:443', 'evil.example', 'aiqnet.io.evil.example', 'xaiqnet.io', 'AIQNET.IO.evil.example']) {
    for (const path of ['/api/link/sessions', '/api/link/sessions/00112233445566778899aabbccddeeff/response', '/api/faucet/claim', '/api/activation/price', '/activate', '/l', '/']) {
      for (const headers of PREFETCH) {
        assert.equal(reaches(path, request(host, headers), {}), true, `${host} ${path} ${JSON.stringify(headers)}`);
      }
      assert.equal(hostRedirect(requestHost(host), path, ''), `${SITE_ORIGIN}${path}`, `${host} ${path}`);
    }
  }
});

test('the site\'s API routes and the build assets skip it', () => {
  for (const headers of PREFETCH) {
    for (const host of ['aiqnet.io', 'aiqnet.io:443', 'AIQNET.IO']) {
      assert.equal(reaches('/api/link/sessions', request(host, headers), {}), false, host);
      assert.equal(reaches('/api/stream', request(host, headers), {}), false, host);
    }
    assert.equal(reaches('/_next/static/chunks/main.js', request('aiqnet.io', headers), {}), false);
    assert.equal(reaches('/_next/static/chunks/main.js', request(LINK_HOST, headers), {}), false);
    assert.equal(reaches('/_next/static/chunks/main.js', request('www.aiqnet.io', headers), {}), false);
  }
  // A local run's API routes reach it and pass through untouched (their own headers).
  assert.equal(reaches('/api/link/sessions', request('127.0.0.1:3100'), {}), true);
  assert.equal(hostRedirect(requestHost('127.0.0.1:3100'), '/api/link/sessions', ''), null);
  assert.match(src, /if \(pathname\.startsWith\('\/api\/'\)\) return NextResponse\.next\(\);/);
});

test('the config has no header condition that lets a request skip the policy', () => {
  for (const m of config.matcher) {
    assert.equal(m.missing, undefined, JSON.stringify(m));
    for (const h of m.has ?? []) assert.equal(h.type, 'host', JSON.stringify(m));
  }
  assert.doesNotMatch(literal[1], /_next\/image/);
});

// SITE-R5-CSP-01: Next.js 16 names the file proxy and runs it on Node.js; the deprecated middleware.ts is gone,
// so the CSP and the host routing have one entry.
test('the proxy is src/proxy.ts alone, exporting proxy', () => {
  assert.equal(existsSync(new URL('../../middleware.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../../middleware.ts', import.meta.url)), false);
  assert.match(src, /^export function proxy\(request: NextRequest\) \{$/m);
  assert.doesNotMatch(src, /export (function|const) middleware\b|export const runtime/);
});

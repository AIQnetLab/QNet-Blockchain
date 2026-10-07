// Token logos served from the site (src/server/logo-proxy.ts, GET /api/token/:contract/logo): the server
// fetches only public https hosts on port 443, connects only to the address it checked, follows no redirect,
// reads a bounded body, and passes on only a PNG, JPEG, WebP or GIF; memory and concurrency are bounded.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_RE,
  MAX_LOGO_BYTES,
  createLogoCache,
  createLogoService,
  fetchLogoImage,
  guardedLookup,
  isPublicAddress,
  logoUrl,
  sniffImage,
} from '../../server/logo-proxy.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);
const GIF = new TextEncoder().encode('GIF89a....');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode('<!doctype html><html></html>');
const CONTRACT = `${'a'.repeat(19)}eon${'b'.repeat(15)}${'c'.repeat(8)}`;

test('only public addresses may be reached', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1',
    '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '100::1',
    '2001::1', '2001:db8::1', '2002:7f00:1::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', 'localhost', '',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('the logo URL: https, no user info, the default port, a real host name or a public address', () => {
  for (const u of ['https://raw.githubusercontent.com/x/y/logo.png', 'https://example.com:443/a.png?x=1', 'https://8.8.8.8/l.png']) {
    assert.ok(logoUrl(u), u);
  }
  for (const u of [
    'http://example.com/a.png', 'https://user:pw@example.com/a.png', 'https://example.com:8443/a.png', 'https://localhost/a.png',
    'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://10.0.0.5/a.png', 'https://169.254.169.254/latest', 'https://intranet/a.png',
    'https://a.localhost/x', 'https://example.com./a.png', 'ftp://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'not a url',
  ]) {
    assert.equal(logoUrl(u), null, u);
  }
});

test('the connection resolves once and refuses a host with any non-public address', async () => {
  const resolver = (answers) => (host, opts, cb) => {
    assert.deepEqual(opts, { all: true, verbatim: true });
    const a = answers[host];
    if (!a) cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    else cb(null, a);
  };
  const lookup = guardedLookup(resolver({
    'good.example': [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }],
    'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'internal.example': [{ address: '10.0.0.7', family: 4 }],
    'empty.example': [],
  }));
  const call = (host, opts) => new Promise((resolve) => lookup(host, opts, (err, address, family) => resolve({ err, address, family })));
  const all = await call('good.example', { all: true });
  assert.equal(all.err, null);
  assert.deepEqual(all.address.map((a) => a.address), ['93.184.216.34', '2606:2800:220:1::1']);
  const one = await call('good.example', {});
  assert.deepEqual([one.err, one.address, one.family], [null, '93.184.216.34', 4]);
  for (const host of ['rebind.example', 'internal.example', 'empty.example', 'missing.example']) {
    const r = await call(host, { all: true });
    assert.ok(r.err, host);
  }
});

test('node:https connects through that lookup: a host resolving to a private address is never connected', async () => {
  const asked = [];
  const lookup = guardedLookup((host, opts, cb) => { asked.push(host); cb(null, [{ address: '127.0.0.1', family: 4 }]); });
  const started = Date.now();
  assert.equal(await fetchLogoImage(new URL('https://probe.invalid/logo.png'), { lookup, timeoutMs: 3_000 }), null);
  assert.deepEqual(asked, ['probe.invalid']);
  assert.ok(Date.now() - started < 2_500, 'refused at lookup, not by the deadline');
});

test('sniffing: PNG, JPEG, WebP and GIF by their own bytes; never SVG or HTML', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(GIF), 'image/gif');
  for (const bytes of [SVG, HTML, new Uint8Array(0), PNG.slice(0, 7), new TextEncoder().encode('RIFF....AVI ')]) assert.equal(sniffImage(bytes), null);
});

// A fake https.request: records the options, answers with `status`, `headers` and the body in chunks.
function fakeRequest({ status = 200, headers = {}, chunks = [PNG], hang = false } = {}) {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      if (hang) return;
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers;
        onResponse(res);
        for (const c of chunks) { if (!req.destroyed) res.emit('data', Buffer.from(c)); }
        if (!req.destroyed) res.emit('end');
      });
    };
    return req;
  };
  return { request, calls };
}

test('one GET: port 443, the checked lookup, no agent, no visitor detail; any failure is no logo', async () => {
  const lookup = guardedLookup((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  const ok = fakeRequest({ chunks: [PNG.slice(0, 5), PNG.slice(5)] });
  const logo = await fetchLogoImage(new URL('https://logo.example/a/b.png?v=2'), { request: ok.request, lookup });
  assert.deepEqual(logo, { type: 'image/png', body: PNG });
  const o = ok.calls[0];
  assert.equal(o.hostname, 'logo.example');
  assert.equal(o.port, 443);
  assert.equal(o.path, '/a/b.png?v=2');
  assert.equal(o.method, 'GET');
  assert.equal(o.agent, false);
  assert.equal(o.lookup, lookup);
  assert.equal(o.servername, 'logo.example');
  assert.deepEqual(Object.keys(o.headers).sort(), ['accept', 'accept-encoding', 'user-agent']);
  assert.equal(o.headers['accept-encoding'], 'identity');

  for (const [name, fake] of [
    ['redirect', fakeRequest({ status: 302, headers: { location: 'https://127.0.0.1/' } })],
    ['not found', fakeRequest({ status: 404 })],
    ['declared too large', fakeRequest({ headers: { 'content-length': String(MAX_LOGO_BYTES + 1) } })],
    ['too large', fakeRequest({ chunks: [PNG, new Uint8Array(MAX_LOGO_BYTES)] })],
    ['svg', fakeRequest({ chunks: [SVG], headers: { 'content-type': 'image/png' } })],
    ['html', fakeRequest({ chunks: [HTML] })],
  ]) {
    assert.equal(await fetchLogoImage(new URL('https://logo.example/x'), { request: fake.request, lookup }), null, name);
  }
  // A private address literal never gets a request.
  const never = fakeRequest();
  assert.equal(await fetchLogoImage(new URL('https://10.0.0.1/x.png'), { request: never.request, lookup }), null);
  assert.equal(never.calls.length, 0);
  // A server that never answers is given up at the deadline.
  const slow = fakeRequest({ hang: true });
  assert.equal(await fetchLogoImage(new URL('https://logo.example/x'), { request: slow.request, lookup, timeoutMs: 20 }), null);
});

test('memory: logos and misses expire, and the cache holds a bounded number and size', () => {
  let t = 0;
  const cache = createLogoCache({ maxEntries: 3, maxBytes: 30, ttlMs: 100, missTtlMs: 10, now: () => t });
  const logo = (n) => ({ type: 'image/png', body: new Uint8Array(n) });
  cache.set('a', logo(10));
  cache.set('none', null);
  assert.equal(cache.get('a').body.length, 10);
  assert.equal(cache.get('none'), null);
  t = 11;
  assert.equal(cache.get('none'), undefined, 'a miss is forgotten sooner');
  assert.ok(cache.get('a'));
  t = 101;
  assert.equal(cache.get('a'), undefined);
  t = 0;
  for (const k of ['p', 'q', 'r', 's']) cache.set(k, logo(5));
  assert.equal(cache.size(), 3);
  assert.equal(cache.get('p'), undefined, 'least recently used goes first');
  cache.set('big', logo(25));
  assert.ok(cache.bytes() <= 30);
  cache.set('huge', logo(31));
  assert.equal(cache.get('huge'), undefined, 'larger than the whole cache: not kept');
});

test('the service: the URL comes from the nodes, one fetch per contract at a time, a cap on fetches at once', async () => {
  const fetched = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const service = createLogoService({
    source: async (c) => ({ a: 'https://logo.example/a.png', b: 'http://logo.example/b.png', c: null, d: 'unavailable', e: 'https://10.0.0.1/e.png' })[c] ?? null,
    fetchImage: async (url) => { fetched.push(url.href); await gate; return { type: 'image/png', body: PNG }; },
    maxConcurrent: 1,
  });
  const first = service.get('a');
  const again = service.get('a');
  assert.deepEqual(await service.get('x'), { kind: 'busy' }, 'the cap: no second fetch at once');
  release();
  assert.equal((await first).kind, 'logo');
  assert.equal((await again).kind, 'logo');
  assert.deepEqual(fetched, ['https://logo.example/a.png'], 'one fetch for both requests');
  assert.equal((await service.get('a')).kind, 'logo');
  assert.equal(fetched.length, 1, 'served from memory');
  assert.deepEqual(await service.get('b'), { kind: 'none' }, 'not https');
  assert.deepEqual(await service.get('c'), { kind: 'none' });
  assert.deepEqual(await service.get('d'), { kind: 'busy' }, 'no node answered: not remembered as missing');
  assert.deepEqual(await service.get('e'), { kind: 'none' }, 'a private address');
  assert.equal(fetched.length, 1);
});

test('the route takes only a contract address, and the page loads logos only from it', () => {
  assert.equal(CONTRACT_RE.test(CONTRACT), true);
  for (const bad of ['', '../x', `${CONTRACT}/../../x`, CONTRACT.toUpperCase(), `${CONTRACT}0`, 'https://logo.example/a.png']) assert.equal(CONTRACT_RE.test(bad), false, bad);
  const route = readFileSync(new URL('../../app/api/token/[contract]/logo/route.ts', import.meta.url), 'utf8');
  assert.match(route, /if \(typeof contract !== 'string' \|\| !CONTRACT_RE\.test\(contract\)\) return plain\(400\);/);
  assert.match(route, /rateLimit\(`logo:\$\{ip\.ip\}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW\)/);
  assert.match(route, /const logo = sanitizeLogo\(body\.token\.logo\);/);
  // Nothing of the request reaches the fetch but the contract.
  assert.doesNotMatch(route, /request\.(url|headers)|searchParams/);
  const icon = readFileSync(new URL('../../components/TokenIcon.tsx', import.meta.url), 'utf8');
  assert.match(icon, /const CONTRACT_RE = \/\^\[0-9a-f\]\{19\}eon\[0-9a-f\]\{15\}\[0-9a-f\]\{8\}\$\/;/);
  assert.match(icon, /if \(isUrl && contract && !imgFailed\)/);
});

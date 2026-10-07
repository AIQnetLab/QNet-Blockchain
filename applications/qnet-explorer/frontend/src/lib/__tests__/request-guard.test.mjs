// The checks every state-changing route makes before its body (src/server/request-guard.ts), and that the
// faucet and the relay make them: another site's page cannot send a claim with its visitors' IP
// addresses, because it cannot send JSON without a preflight and its Origin is refused.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchSiteAllowed, isJsonRequest, originAllowed, readJsonPost } from '../../server/request-guard.ts';

const URL_ = 'https://aiqnet.io/api/faucet/claim';
const claim = JSON.stringify({ walletAddress: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: 1500, tokenType: '1DEV' });
const post = (headers, body = claim) => new Request(URL_, { method: 'POST', headers: { host: 'aiqnet.io', ...headers }, body });

test('a cross-site no-cors POST (text/plain, foreign Origin) is refused before the body is read', async () => {
  // fetch(url, {method: 'POST', mode: 'no-cors', body: JSON.stringify(...)}) from another page.
  const res = await readJsonPost(post({ origin: 'https://evil.example', 'content-type': 'text/plain;charset=UTF-8' }), 1024, false);
  assert.deepEqual(res, { ok: false, status: 403, error: 'forbidden_origin' });
  // Even a page that somehow sent JSON is refused on its Origin.
  assert.equal((await readJsonPost(post({ origin: 'https://evil.example', 'content-type': 'application/json' }), 1024, false)).status, 403);
  for (const origin of ['null', 'http://aiqnet.io', 'https://www.aiqnet.io', 'https://link.aiqnet.io', 'https://aiqnet.io.evil.example', 'http://localhost:3000']) {
    assert.equal((await readJsonPost(post({ origin, 'content-type': 'application/json' }), 1024, false)).status, 403, origin);
  }
});

test('a same-site or scripted POST must still be JSON, small and well formed', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const headers = { origin: 'https://aiqnet.io', ...(type ? { 'content-type': type } : {}) };
    assert.deepEqual(await readJsonPost(post(headers), 1024, false), { ok: false, status: 415, error: 'unsupported_media_type' }, String(type));
  }
  const ok = await readJsonPost(post({ origin: 'https://aiqnet.io', 'content-type': 'application/json; charset=utf-8' }), 1024, false);
  assert.deepEqual(ok, { ok: true, value: JSON.parse(claim) });
  // No Origin: the SDK, curl, a server. Its own IP address is what gets limited.
  assert.equal((await readJsonPost(post({ 'content-type': 'application/json' }), 1024, false)).ok, true);
  assert.equal((await readJsonPost(post({ 'content-type': 'application/json' }, 'x'.repeat(2000)), 1024, false)).status, 413);
  assert.equal((await readJsonPost(post({ 'content-type': 'application/json', 'content-length': '5000' }), 1024, false)).status, 413);
  assert.equal((await readJsonPost(post({ 'content-type': 'application/json' }, '{"a":'), 1024, false)).status, 400);
  assert.equal((await readJsonPost(post({ 'content-type': 'application/json' }, new Uint8Array([0x7b, 0xff, 0x7d])), 1024, false)).status, 400);
  // localhost pages only in development, or when the request itself came to localhost.
  assert.equal(originAllowed(post({ origin: 'http://localhost:3000' }), true), true);
  assert.equal(originAllowed(post({ origin: 'http://localhost:3000', host: 'localhost:3000' }), false), true);
  assert.equal(isJsonRequest(post({ 'content-type': 'Application/JSON' })), true);
});

// R4-SRA-01: Fetch Metadata. A browser request that no page of this origin made is refused on any method,
// also without an Origin (a GET by <img>, <script> or a frame); the app and scripts send no Sec-Fetch-Site.
test('Sec-Fetch-Site: absent or same-origin only', async () => {
  const get = (headers) => new Request(URL_, { headers: { host: 'aiqnet.io', ...headers } });
  assert.equal(fetchSiteAllowed(get({})), true, 'the app, curl, a server');
  assert.equal(fetchSiteAllowed(get({ 'sec-fetch-site': 'same-origin' })), true, 'this site\'s pages');
  for (const site of ['cross-site', 'same-site', 'none', 'CROSS-SITE', '', 'same-origin, cross-site']) {
    assert.equal(fetchSiteAllowed(get({ 'sec-fetch-site': site })), false, site);
    assert.equal(originAllowed(get({ 'sec-fetch-site': site }), false), false, site);
    assert.equal(originAllowed(get({ 'sec-fetch-site': site }), true), false, `${site} (development)`);
    // A POST too, even with this site's Origin.
    const res = await readJsonPost(post({ origin: 'https://aiqnet.io', 'content-type': 'application/json', 'sec-fetch-site': site }), 1024, false);
    assert.deepEqual(res, { ok: false, status: 403, error: 'forbidden_origin' }, site);
  }
  assert.equal(originAllowed(get({ 'sec-fetch-site': 'same-origin', origin: 'https://aiqnet.io' }), false), true);
  const ok = await readJsonPost(post({ origin: 'https://aiqnet.io', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }), 1024, false);
  assert.equal(ok.ok, true);
});

// Comments may name what the code must not do; only code is checked.
const code = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the faucet reads its body only through readJsonPost, first thing in POST; the relay uses the same checks', () => {
  const faucet = code('app/api/faucet/claim/route.ts');
  assert.doesNotMatch(faucet, /request\.(json|text|formData|arrayBuffer|blob)\(/);
  const post = faucet.slice(faucet.indexOf('export async function POST'));
  assert.match(post, /^export async function POST\(request: NextRequest\) \{\s*try \{\s*const read = await readJsonPost\(request, FAUCET_BODY_MAX_BYTES\);/);
  const relay = code('server/link-relay.ts');
  assert.match(relay, /from '\.\/request-guard\.ts'/);
  assert.doesNotMatch(relay, /function (originAllowed|isJsonRequest|readBody)\(/, 'one copy of each check');
});

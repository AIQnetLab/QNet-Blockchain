// The QNet Link relay (src/server/link-relay.ts): revision 2 validation, the request and its hash, per-intent
// caps, first-write-wins, TTL, the store caps, origins and the per-IP limits, driven through its handlers with
// web-standard Requests. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS, MAX_LINK_PER_IP, MAX_LINK_SESSIONS, MAX_LIVE_PER_IP, MAX_SESSIONS, READ_GRACE_S, createLinkRelay, linkRelay } from '../../server/link-relay.ts';
import { rateLimit } from '../../../lib/rate-limit.ts';
import { LINK, VECTORS } from './link-helpers.mjs';

const BASE = 'https://aiqnet.io/api/link/sessions';
const LINKED = LINK.cases.find((c) => c.name === 'link-ok-check');
const CONNECT = LINK.cases.find((c) => c.name === 'connect-ok');
const CLAIM = LINK.cases.find((c) => c.name === 'claim-ok');
const RESERVE = LINK.cases.find((c) => c.name === 'reserve-ok');
const BY_INTENT = { link: LINKED, connect: CONNECT, claim: CLAIM };
let scopes = 0;

function relay(options = {}) {
  let t = 1_000_000;
  const r = createLinkRelay({
    now: () => t,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.1' }),
    scope: `test${(scopes += 1)}`,
    devOrigins: false,
    ...options,
  });
  return { r, advance: (ms) => { t += ms; } };
}

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'aiqnet.io', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const get = (url, headers = {}) => new Request(url, { headers: { host: 'aiqnet.io', ...headers } });

async function json(res) {
  return JSON.parse(await res.text());
}

async function created(r, c = LINKED, headers = {}) {
  const res = await r.createSession(post(BASE, c.sessionRequest, headers));
  assert.equal(res.status, 201, c.name);
  return res;
}

// A session body of the intent with a fresh id.
const withId = (c, n) => ({ ...c.sessionRequest, id: n.toString(16).padStart(32, '0') });

test('a session is created once and read back with its request and hash; every answer is no-store JSON', async () => {
  const { r, advance } = relay();
  const res = await created(r);
  assert.deepEqual(await json(res), { expiresIn: 600 });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  const again = await r.createSession(post(BASE, LINKED.sessionRequest));
  assert.equal(again.status, 409);
  assert.deepEqual(await json(again), { error: 'conflict' });

  advance(88_500);
  const s = await r.getSession(get(`${BASE}/${LINKED.sessionId}`), LINKED.sessionId);
  assert.equal(s.status, 200);
  assert.deepEqual(await json(s), { ...LINKED.sessionView, answered: false, expiresIn: 511 });

  for (const c of [CONNECT, CLAIM]) {
    await created(r, c);
    const view = await json(await r.getSession(get(`${BASE}/${c.sessionId}`), c.sessionId));
    assert.deepEqual(view, { ...c.sessionView, answered: false, expiresIn: 600 }, c.name);
  }
  const connect = await json(await r.getSession(get(`${BASE}/${CONNECT.sessionId}`), CONNECT.sessionId));
  assert.equal('request' in connect || 'reqHash' in connect, false);
});

test('the relay computes the hash from the request, whatever the order of its keys', async () => {
  const { r } = relay();
  const { burnTx, walletHash, check } = LINKED.request;
  const body = JSON.stringify({ intent: 'link', request: { check, walletHash, burnTx }, sitePub: LINKED.sessionRequest.sitePub, id: LINKED.sessionId });
  assert.equal((await r.createSession(post(BASE, body))).status, 201);
  const view = await json(await r.getSession(get(`${BASE}/${LINKED.sessionId}`), LINKED.sessionId));
  assert.equal(view.reqHash, LINKED.reqHash);
  assert.equal(JSON.stringify(view.request), LINKED.requestText);
});

test('invalid session bodies get 400, oversized 413, wrong media type 415; activate is refused', async () => {
  const { r } = relay();
  for (const n of LINK.invalidSessionRequests) {
    const res = await r.createSession(post(BASE, n.body));
    assert.equal(res.status, n.reason === 'size' ? 413 : 400, n.reason);
  }
  assert.ok(LINK.invalidSessionRequests.some((n) => n.reason.startsWith('activate')));
  for (const c of VECTORS.cases.filter((x) => x.intent === 'activate')) {
    assert.equal((await r.createSession(post(BASE, c.sessionRequest))).status, 400, c.name);
  }
  assert.equal((await r.createSession(post(BASE, LINKED.sessionRequest, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await r.createSession(post(BASE, LINKED.sessionRequest, { 'content-type': 'application/json; charset=utf-8' }))).status, 201);
  const noType = new Request(BASE, { method: 'POST', headers: { host: 'aiqnet.io' }, body: new Uint8Array([123, 125]) });
  assert.equal((await r.createSession(noType)).status, 415);
  const badUtf8 = new Request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) });
  assert.equal((await r.createSession(badUtf8)).status, 400);
  // A declared length over the cap is refused before the body is read.
  const declared = post(BASE, CONNECT.sessionRequest, { 'content-length': '5000' });
  assert.equal((await r.createSession(declared)).status, 413);
  assert.equal(r.size(), 1);
});

test('the first answer wins; the same bytes again are a retry, anything else a conflict', async () => {
  const { r } = relay();
  await created(r);
  const url = `${BASE}/${LINKED.sessionId}/response`;
  const poll = () => r.getAnswer(get(url), LINKED.sessionId);

  const waiting = await poll();
  assert.equal(waiting.status, 204);
  assert.equal(await waiting.text(), '');
  assert.equal(waiting.headers.get('cache-control'), 'no-store');

  const first = await r.postAnswer(post(url, LINKED.responseRequest), LINKED.sessionId);
  assert.equal(first.status, 201);
  assert.deepEqual(await json(first), { ok: true });
  const retry = await r.postAnswer(post(url, LINKED.responseRequest), LINKED.sessionId);
  assert.equal(retry.status, 200);
  const other = await r.postAnswer(post(url, CONNECT.responseRequest), LINKED.sessionId);
  assert.equal(other.status, 409);

  const answered = await poll();
  assert.equal(answered.status, 200);
  assert.deepEqual(await json(answered), LINKED.responseRequest);
  const s = await json(await r.getSession(get(`${BASE}/${LINKED.sessionId}`), LINKED.sessionId));
  assert.equal(s.answered, true);
});

test('answers are held to their session\'s intent: a link answer is too big for connect and claim', async () => {
  const { r } = relay();
  let n = 0;
  const from = () => ({ 'x-test-ip': `192.0.2.${(n += 1)}` });
  for (const c of [LINKED, CONNECT, CLAIM]) await created(r, c);
  for (const c of [CONNECT, CLAIM]) {
    const res = await r.postAnswer(post(`${BASE}/${c.sessionId}/response`, LINKED.responseRequest, from()), c.sessionId);
    assert.equal(res.status, 413, c.name);
    assert.equal((await r.postAnswer(post(`${BASE}/${c.sessionId}/response`, c.responseRequest, from()), c.sessionId)).status, 201, c.name);
  }
  assert.equal((await r.postAnswer(post(`${BASE}/${LINKED.sessionId}/response`, LINKED.responseRequest, from()), LINKED.sessionId)).status, 201);
});

test('invalid answers get 400 or 413, unknown sessions 404, malformed ids 400', async () => {
  const { r } = relay();
  for (const c of [LINKED, CONNECT, CLAIM]) await created(r, c);
  // Each from its own address: the answer route has a per-IP limit.
  let n = 0;
  const from = () => ({ 'x-test-ip': `192.0.2.${(n += 1)}` });
  for (const bad of LINK.invalidResponseRequests) {
    const c = BY_INTENT[bad.intent];
    assert.equal((await r.postAnswer(post(`${BASE}/${c.sessionId}/response`, bad.body, from()), c.sessionId)).status, 400, bad.reason);
  }
  const url = `${BASE}/${LINKED.sessionId}/response`;
  const huge = JSON.stringify({ ...LINKED.responseRequest, ct: 'A'.repeat(12_300) });
  assert.equal((await r.postAnswer(post(url, huge, from()), LINKED.sessionId)).status, 413);
  assert.equal((await r.postAnswer(post(url, LINKED.responseRequest, { ...from(), 'content-type': 'text/plain' }), LINKED.sessionId)).status, 415);
  for (const c of [LINKED, CONNECT, CLAIM]) {
    assert.equal((await r.getAnswer(get(`${BASE}/${c.sessionId}/response`), c.sessionId)).status, 204, `${c.name}: nothing stored`);
  }

  const unknown = LINK.cases.find((c) => c.name === 'link-linked').sessionId;
  assert.equal((await r.getSession(get(`${BASE}/${unknown}`), unknown)).status, 404);
  assert.equal((await r.getAnswer(get(`${BASE}/${unknown}/response`), unknown)).status, 404);
  assert.equal((await r.postAnswer(post(`${BASE}/${unknown}/response`, CONNECT.responseRequest, from()), unknown)).status, 404);
  for (const id of [LINKED.sessionId.toUpperCase(), LINKED.sessionId.slice(1), `${LINKED.sessionId}0`, '../x', '']) {
    assert.equal((await r.getSession(get(BASE), id)).status, 400, id);
    assert.equal((await r.getAnswer(get(BASE), id)).status, 400, id);
    assert.equal((await r.postAnswer(post(BASE, LINKED.responseRequest, from()), id)).status, 400, id);
  }
});

test('a session and its answer are gone after 600 s, and the id can be used again', async () => {
  const { r, advance } = relay();
  await created(r);
  const url = `${BASE}/${LINKED.sessionId}/response`;
  assert.equal((await r.postAnswer(post(url, LINKED.responseRequest), LINKED.sessionId)).status, 201);
  advance(599_999);
  assert.equal((await r.getAnswer(get(url), LINKED.sessionId)).status, 200);
  const last = await json(await r.getSession(get(`${BASE}/${LINKED.sessionId}`), LINKED.sessionId));
  assert.equal(last.expiresIn, 0);
  advance(1);
  assert.equal((await r.getAnswer(get(url), LINKED.sessionId)).status, 404);
  assert.equal((await r.getSession(get(`${BASE}/${LINKED.sessionId}`), LINKED.sessionId)).status, 404);
  assert.equal((await r.postAnswer(post(url, LINKED.responseRequest), LINKED.sessionId)).status, 404);
  assert.equal(r.size(), 0);
  assert.equal(r.linkLiveFor('203.0.113.1'), 0);
  await created(r);
});

test('the store holds at most maxSessions live sessions; expired ones make room', async () => {
  const { r, advance } = relay({ maxSessions: 3 });
  const cases = LINK.cases.slice(0, 4);
  for (const c of cases.slice(0, 3)) await created(r, c);
  const full = await r.createSession(post(BASE, cases[3].sessionRequest));
  assert.equal(full.status, 503);
  assert.deepEqual(await json(full), { error: 'unavailable' });
  advance(600_000);
  r.purge();
  assert.equal(r.size(), 0);
  await created(r, cases[3]);
});

test('link sessions: at most maxLinkPerIp per address and maxLinkSessions in all; other intents are not held back', async () => {
  const { r, advance } = relay({ maxLinkPerIp: 2, maxLinkSessions: 3 });
  const from = (n) => ({ 'x-test-ip': `198.51.100.${n}` });
  for (const i of [1, 2]) assert.equal((await r.createSession(post(BASE, withId(LINKED, i), from(1)))).status, 201);
  const capped = await r.createSession(post(BASE, withId(LINKED, 3), from(1)));
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get('retry-after'), '60');
  assert.equal(r.linkLiveFor('198.51.100.1'), 2);
  // The same address may still open other requests.
  assert.equal((await r.createSession(post(BASE, withId(CLAIM, 4), from(1)))).status, 201);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 5), from(2)))).status, 201);
  const full = await r.createSession(post(BASE, withId(LINKED, 6), from(3)));
  assert.equal(full.status, 503);
  assert.equal((await r.createSession(post(BASE, withId(CONNECT, 7), from(3)))).status, 201);
  advance(600_000);
  r.purge();
  assert.equal(r.linkLiveFor('198.51.100.1'), 0);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 8), from(3)))).status, 201);
  assert.ok(MAX_LINK_SESSIONS === 5000 && MAX_LINK_PER_IP === 10);
});

// A `reserve` answer carries an ML-DSA-65 key and signature too (the wallet's signed reservation): its sessions are
// capped with the `link` ones, and its answer takes the same larger caps.
test('reserve sessions are capped with the link sessions, and take a link-sized answer', async () => {
  const { r } = relay({ maxLinkPerIp: 2, maxLinkSessions: 3 });
  const from = (n) => ({ 'x-test-ip': `198.51.100.${n}` });
  assert.equal((await r.createSession(post(BASE, withId(RESERVE, 21), from(1)))).status, 201);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 22), from(1)))).status, 201);
  assert.equal(r.linkLiveFor('198.51.100.1'), 2);
  assert.equal((await r.createSession(post(BASE, withId(RESERVE, 23), from(1)))).status, 429);
  // The answer of the vectors' case, posted by the app, is taken and read back.
  const { r: open } = relay();
  const session = RESERVE.sessionRequest;
  assert.equal((await open.createSession(post(BASE, session))).status, 201);
  const answer = new Request(`${BASE}/${session.id}/response`, { method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json' }, body: JSON.stringify(RESERVE.responseRequest) });
  assert.equal((await open.postAnswer(answer, session.id)).status, 201);
  // A reserve request without a wallet, or with no payment address, is no session at all.
  for (const request of [{ ...RESERVE.request, walletHash: null }, { walletHash: RESERVE.request.walletHash }]) {
    assert.equal((await open.createSession(post(BASE, { ...withId(RESERVE, 24), request }))).status, 400, JSON.stringify(request));
  }
});

// SITE-8: a session whose answer its page read, or that its page released, stops holding a place of that address:
// many people behind one carrier NAT address are not locked out by finished or cancelled requests. A read one ends
// READ_GRACE_S after the read (SITE-R1-01), a released one at once.
test('a read answer frees the address\'s place after the grace, a release at once; only the creating address releases', async () => {
  const { r, advance } = relay({ maxLinkPerIp: 2 });
  const from = (n) => ({ 'x-test-ip': `198.51.100.${n}` });
  const del = (id, headers = {}) => new Request(`${BASE}/${id}`, { method: 'DELETE', headers: { host: 'aiqnet.io', ...headers } });
  const a = withId(LINKED, 11);
  const b = withId(LINKED, 12);
  assert.equal((await r.createSession(post(BASE, a, from(1)))).status, 201);
  assert.equal((await r.createSession(post(BASE, b, from(1)))).status, 201);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 13), from(1)))).status, 429);
  // The app answers the first; its page reads the answer: the app's retry still works during the grace.
  const url = `${BASE}/${a.id}/response`;
  assert.equal((await r.postAnswer(post(url, { ...LINKED.responseRequest }), a.id)).status, 201);
  assert.equal((await r.getAnswer(get(url, from(1)), a.id)).status, 200);
  assert.equal(r.linkLiveFor('198.51.100.1'), 2, 'held until its grace ends');
  advance(READ_GRACE_S * 1000 - 1);
  assert.equal((await r.postAnswer(post(url, { ...LINKED.responseRequest }), a.id)).status, 200, 'a retry after a lost reply');
  assert.equal((await r.getAnswer(get(url, from(1)), a.id)).status, 200, 'read twice, the grace counted from the first read');
  advance(1);
  assert.equal((await r.getAnswer(get(url, from(1)), a.id)).status, 404, 'ended with its grace');
  assert.equal((await r.postAnswer(post(url, { ...LINKED.responseRequest }), a.id)).status, 404);
  assert.equal(r.linkLiveFor('198.51.100.1'), 1);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 14), from(1)))).status, 201);
  // Another address cannot release it (the answer an unknown id gets); its own address can.
  assert.equal((await r.releaseSession(del(b.id, from(2)), b.id)).status, 404);
  assert.equal((await r.getSession(get(`${BASE}/${b.id}`), b.id)).status, 200);
  const released = await r.releaseSession(del(b.id, from(1)), b.id);
  assert.equal(released.status, 204);
  assert.equal((await r.getSession(get(`${BASE}/${b.id}`), b.id)).status, 404);
  assert.equal(r.linkLiveFor('198.51.100.1'), 1);
  assert.equal((await r.releaseSession(del(b.id, from(1)), b.id)).status, 404);
  assert.equal((await r.releaseSession(del('nope', from(1)), 'nope')).status, 400);
  assert.equal((await r.releaseSession(del(a.id, { origin: 'https://evil.example' }), a.id)).status, 403);
  // The store's own count follows the sessions it holds: the read one went with its grace, the released one at once.
  assert.equal(r.size(), 1);
  // The page releases a session it cancels or replaces, never one that ended by itself.
  const hook = readFileSync(new URL('../../hooks/useLinkSession.ts', import.meta.url), 'utf8');
  assert.match(hook, /if \(release\) void releaseLinkSession\(r\.session\.id\);/);
  assert.match(hook, /const start = useCallback\(async \(intent: LinkIntent, request: LinkRequest \| null = null\) => \{\s*stop\(true\);/);
  assert.match(hook, /const cancel = useCallback\(\(\) => \{\s*attempt\.current \+= 1;\s*stop\(true\);/);
  assert.match(hook, /const finish = \(next: LinkState\) => \{\s*if \(run\.current === r\) stop\(\);/);
  assert.match(readFileSync(new URL('../../app/api/link/sessions/[id]/route.ts', import.meta.url), 'utf8'), /export async function DELETE\([^)]*\): Promise<Response> \{\s*const \{ id \} = await params;\s*return linkRelay\(\)\.releaseSession\(request, id\);/);
});

// SITE-R1-01: reading its own answer released the address's place while the session stayed in the store until its TTL,
// so one address could create, answer with junk, read, and repeat up to the create limit: about 120 live link sessions
// from one address, and some 42 addresses kept all 5,000 link places full (every cabinet link request got 503).
test('answer-then-read from one address never holds more than its caps in the store', async () => {
  const { r, advance } = relay({ maxLinkSessions: 50 });
  const attacker = { 'x-test-ip': '198.51.100.66' };
  let n = 0;
  const answerFrom = () => ({ 'x-test-ip': `192.0.2.${(n += 1) % 250}` });
  const statuses = [];
  for (let i = 0; i < 40; i += 1) {
    const body = withId(LINKED, 1000 + i);
    const res = await r.createSession(post(BASE, body, attacker));
    statuses.push(res.status);
    if (res.status !== 201) continue;
    const url = `${BASE}/${body.id}/response`;
    // Bytes the page could never open: the relay only checks their shape.
    assert.equal((await r.postAnswer(post(url, { ...LINKED.responseRequest, ct: 'A'.repeat(64) }, answerFrom()), body.id)).status, 201);
    assert.equal((await r.getAnswer(get(url, attacker), body.id)).status, 200);
  }
  assert.equal(statuses.filter((s) => s === 201).length, MAX_LINK_PER_IP);
  assert.ok(statuses.slice(MAX_LINK_PER_IP).every((s) => s === 429));
  assert.equal(r.linkLiveFor('198.51.100.66'), MAX_LINK_PER_IP);
  assert.equal(r.size(), MAX_LINK_PER_IP);
  // Everyone else still gets a place.
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 2000), { 'x-test-ip': '198.51.100.67' }))).status, 201);
  // The read sessions end with their grace and give every place back, in the store and of the address.
  advance(READ_GRACE_S * 1000);
  r.purge();
  assert.equal(r.linkLiveFor('198.51.100.66'), 0);
  assert.equal(r.size(), 1);
  assert.equal((await r.createSession(post(BASE, withId(LINKED, 3000), attacker))).status, 201);

  // The same for every intent against MAX_LIVE_PER_IP, and a session read near its TTL ends once.
  const all = relay({ maxLivePerIp: 3 });
  const ids = [4000, 4001, 4002].map((k) => withId(CONNECT, k));
  for (const body of ids) {
    assert.equal((await all.r.createSession(post(BASE, body, attacker))).status, 201);
    assert.equal((await all.r.postAnswer(post(`${BASE}/${body.id}/response`, CONNECT.responseRequest, answerFrom()), body.id)).status, 201);
  }
  all.advance(599_000);
  for (const body of ids) assert.equal((await all.r.getAnswer(get(`${BASE}/${body.id}/response`, attacker), body.id)).status, 200);
  assert.equal((await all.r.createSession(post(BASE, withId(CONNECT, 4003), attacker))).status, 429);
  all.advance(1_000);
  all.r.purge();
  assert.equal(all.r.liveFor('198.51.100.66'), 0);
  assert.equal(all.r.size(), 0);
  all.advance(READ_GRACE_S * 1000);
  all.r.purge();
  assert.equal(all.r.liveFor('198.51.100.66'), 0, 'dropped once, never counted below zero');
  for (let k = 0; k < 3; k += 1) assert.equal((await all.r.createSession(post(BASE, withId(CONNECT, 4010 + k), attacker))).status, 201);
  assert.equal((await all.r.createSession(post(BASE, withId(CONNECT, 4020), attacker))).status, 429);
});

test('origins: none, or aiqnet.io; localhost only for development or a local host', async () => {
  const { r } = relay();
  const withOrigin = (origin, host = 'aiqnet.io') => r.createSession(post(BASE, LINKED.sessionRequest, { origin, host }));
  for (const origin of [
    'https://evil.example', 'http://aiqnet.io', 'https://www.aiqnet.io', 'https://link.aiqnet.io', 'https://aiqnet.io.evil.example',
    'null', 'http://localhost:3000',
  ]) {
    const res = await withOrigin(origin);
    assert.equal(res.status, 403, origin);
    assert.deepEqual(await json(res), { error: 'forbidden_origin' });
  }
  assert.equal((await withOrigin('http://localhost:3000', 'localhost:3000')).status, 201, 'a production build run locally');
  assert.equal((await r.getSession(get(BASE, { origin: 'https://evil.example' }), LINKED.sessionId)).status, 403);
  assert.equal((await r.getSession(get(BASE, { origin: 'https://aiqnet.io' }), LINKED.sessionId)).status, 200);
  assert.equal((await r.getSession(get(BASE), LINKED.sessionId)).status, 200, 'the app sends no Origin');

  const dev = relay({ devOrigins: true }).r;
  assert.equal((await dev.createSession(post(BASE, LINKED.sessionRequest, { origin: 'http://127.0.0.1:3000' }))).status, 201);
  assert.equal((await dev.createSession(post(BASE, CONNECT.sessionRequest, { origin: 'http://localhost.evil:3000' }))).status, 403);
});

// R4-SRA-01: a GET that another page makes from a visitor's browser (new Image().src = '…/response') carries
// no Origin. It spent the visitor's poll and session windows, so the page's own polls got 429 and the app's
// session read failed. The browser names such a request in Sec-Fetch-Site; it is refused before any limit.
test('a browser request that no page of this origin made is refused before any limit counts it', async () => {
  const counted = [];
  const { r } = relay({
    limit: (id) => { counted.push(id); return { allowed: true, remaining: 1, resetTime: 0 }; },
  });
  const id = LINKED.sessionId;
  const from = { 'x-test-ip': '198.51.100.77' };
  for (const site of ['cross-site', 'same-site', 'none', 'Cross-Site', 'same-origin, cross-site', '']) {
    const headers = { ...from, 'sec-fetch-site': site };
    for (const res of [
      await r.getAnswer(get(`${BASE}/${id}/response`, headers), id),
      await r.getSession(get(`${BASE}/${id}`, headers), id),
      await r.createSession(post(BASE, LINKED.sessionRequest, headers)),
      await r.postAnswer(post(`${BASE}/${id}/response`, LINKED.responseRequest, headers), id),
    ]) {
      assert.equal(res.status, 403, site);
      assert.deepEqual(await json(res), { error: 'forbidden_origin' });
    }
  }
  assert.deepEqual(counted, [], 'no limiter was touched');
  assert.equal(r.size(), 0);

  // The site's own pages (same-origin) and the app (no such header) go on as before, and are counted.
  assert.equal((await r.createSession(post(BASE, LINKED.sessionRequest, { ...from, 'sec-fetch-site': 'same-origin', origin: 'https://aiqnet.io' }))).status, 201);
  assert.equal((await r.getSession(get(`${BASE}/${id}`, from), id)).status, 200);
  assert.equal((await r.getAnswer(get(`${BASE}/${id}/response`, { ...from, 'sec-fetch-site': 'same-origin' }), id)).status, 204);
  assert.deepEqual(counted.map((key) => key.split(':').slice(1).join(':')), ['create', 'session', 'poll'].map((route) => `${route}:198.51.100.77`));
});

test('a page polling cross-site from the visitor\'s browser does not use up the poll window', async () => {
  const { r } = relay();
  await created(r);
  const id = LINKED.sessionId;
  const visitor = { 'x-test-ip': '198.51.100.78' };
  for (let i = 0; i < LIMITS.poll.max + 50; i += 1) {
    assert.equal((await r.getAnswer(get(`${BASE}/${id}/response`, { ...visitor, 'sec-fetch-site': 'cross-site' }), id)).status, 403);
  }
  for (let i = 0; i < LIMITS.session.max + 10; i += 1) {
    assert.equal((await r.getSession(get(`${BASE}/${id}`, { ...visitor, 'sec-fetch-site': 'cross-site' }), id)).status, 403);
  }
  assert.equal((await r.getAnswer(get(`${BASE}/${id}/response`, { ...visitor, 'sec-fetch-site': 'same-origin' }), id)).status, 204);
  assert.equal((await r.getSession(get(`${BASE}/${id}`, visitor), id)).status, 200);
});

test('per-IP limits per route, with Retry-After; one IP does not use up another\'s', async () => {
  const { r } = relay({ maxLivePerIp: 1000 });
  const ip = (n) => ({ 'x-test-ip': `198.51.100.${n}` });
  // 120 creates per 10 minutes: many phones share one carrier NAT address.
  for (let i = 0; i < LIMITS.create.max; i += 1) {
    assert.notEqual((await r.createSession(post(BASE, '{}', ip(1)))).status, 429, `create ${i + 1}`);
  }
  const limited = await r.createSession(post(BASE, LINKED.sessionRequest, ip(1)));
  assert.equal(limited.status, 429);
  assert.deepEqual(await json(limited), { error: 'rate_limited' });
  const retry = Number(limited.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 600, `Retry-After ${retry}`);
  assert.equal((await r.createSession(post(BASE, LINKED.sessionRequest, ip(2)))).status, 201);

  const id = LINKED.sessionId;
  for (let i = 0; i < LIMITS.answer.max; i += 1) await r.postAnswer(post(`${BASE}/${id}/response`, '{}', ip(3)), id);
  assert.equal((await r.postAnswer(post(`${BASE}/${id}/response`, LINKED.responseRequest, ip(3)), id)).status, 429);
  for (let i = 0; i < LIMITS.session.max; i += 1) await r.getSession(get(BASE, ip(4)), id);
  assert.equal((await r.getSession(get(BASE, ip(4)), id)).status, 429);
  for (let i = 0; i < LIMITS.poll.max; i += 1) await r.getAnswer(get(BASE, ip(5)), id);
  assert.equal((await r.getAnswer(get(BASE, ip(5)), id)).status, 429);
  assert.equal((await r.getAnswer(get(BASE, ip(6)), id)).status, 204);
});

test('the limits leave room for carrier NAT: 20 pages polling at once from one address, 100 phones a minute', () => {
  assert.ok(LIMITS.poll.max >= 20 * 30, 'a page polls 30 times a minute');
  assert.ok(LIMITS.session.max >= 100 && LIMITS.answer.max >= 50);
  assert.ok(LIMITS.create.max >= MAX_LIVE_PER_IP && MAX_LIVE_PER_IP >= 50);
  // Filling the store takes this many addresses at once (about 84 with the old 5000 sessions).
  assert.ok(MAX_SESSIONS / MAX_LIVE_PER_IP >= 1500, `${MAX_SESSIONS / MAX_LIVE_PER_IP}`);
  assert.ok(MAX_LINK_SESSIONS / MAX_LINK_PER_IP >= 500);
});

test('one address holds at most maxLivePerIp live sessions; they come back as its sessions expire', async () => {
  const { r, advance } = relay({ maxLivePerIp: 3 });
  const from = (n) => ({ 'x-test-ip': `198.51.100.${n}` });
  const [a, b, c, d] = LINK.cases.slice(0, 4);
  for (const x of [a, b, c]) assert.equal((await r.createSession(post(BASE, x.sessionRequest, from(1)))).status, 201);
  const capped = await r.createSession(post(BASE, d.sessionRequest, from(1)));
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get('retry-after'), '60');
  assert.equal(r.liveFor('198.51.100.1'), 3);
  // Another address is not affected, and the store itself is not full.
  assert.equal((await r.createSession(post(BASE, d.sessionRequest, from(2)))).status, 201);
  advance(600_000);
  r.purge();
  assert.equal(r.liveFor('198.51.100.1'), 0);
  assert.equal(r.size(), 0);
  assert.equal((await r.createSession(post(BASE, a.sessionRequest, from(1)))).status, 201);
  assert.equal(r.liveFor('198.51.100.1'), 1);
});

test('a flood of explorer keys never locks the relay: it has its own limiter, and a full limiter evicts', async () => {
  // Push the explorer limiter far past its size with distinct keys, as a crowd of visitors would.
  for (let i = 0; i < 60_000; i += 1) rateLimit(`activity:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 600, 60_000);
  assert.equal(rateLimit('activity:192.0.2.201', 600, 60_000).allowed, true, 'a new visitor of the explorer too');
  const r = createLinkRelay({ scope: `test${(scopes += 1)}`, devOrigins: false });
  const res = await r.getAnswer(get(BASE, { 'x-real-ip': '192.0.2.200' }), LINKED.sessionId);
  assert.equal(res.status, 404, 'a new visitor reaches the relay');
});

test('no client IP means 503, not one shared bucket', async () => {
  const { r } = relay({ clientKey: () => ({ ok: false, reason: 'no address' }) });
  const res = await r.createSession(post(BASE, LINKED.sessionRequest));
  assert.equal(res.status, 503);
  assert.deepEqual(await json(res), { error: 'unavailable' });
});

test('the default IP source is X-Real-IP from nginx; a client\'s X-Forwarded-For changes nothing', async () => {
  const r = createLinkRelay({ scope: `test${(scopes += 1)}`, devOrigins: false });
  let n = 0;
  // Every request names a new X-Forwarded-For, as a client rotating it would.
  const from = (realIp) => r.getAnswer(get(BASE, { 'x-real-ip': realIp, 'x-forwarded-for': `10.9.${(n += 1) % 250}.1` }), LINKED.sessionId);
  for (let i = 0; i < LIMITS.poll.max; i += 1) assert.equal((await from('192.0.2.7')).status, 404);
  assert.equal((await from('192.0.2.7')).status, 429);
  assert.equal((await from('192.0.2.8')).status, 404);
  // A malformed X-Real-IP is no address at all.
  assert.equal((await r.getAnswer(get(BASE, { 'x-real-ip': '192.0.2.9, 192.0.2.10' }), LINKED.sessionId)).status, 503);
  // Without X-Real-IP (not through nginx): the socket address Next.js records in X-Forwarded-For.
  assert.equal((await r.getAnswer(get(BASE, { 'x-forwarded-for': '127.0.0.1' }), LINKED.sessionId)).status, 404);
});

test('the process relay is one instance on globalThis', () => {
  assert.equal(linkRelay(), linkRelay());
  assert.equal(globalThis[Symbol.for('qnet.linkRelay')], linkRelay());
});

test('the relay logs nothing a request carries', () => {
  const source = readFileSync(new URL('../../server/link-relay.ts', import.meta.url), 'utf8');
  const logs = source.match(/console\.\w+\([^)]*\)/g) ?? [];
  assert.deepEqual(logs, ["console.warn('[WARN][LINK] relay_unavailable reason=no_client_ip')"]);
});

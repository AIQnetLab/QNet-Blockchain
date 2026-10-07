// The page's relay client end to end in one process: the page (link-client.ts) opens a session with its
// request on the relay (link-relay.ts), an app written with node:crypto reads it from the link, checks the
// request against the link's hash and answers, the page polls, decrypts and checks the answer and gets the check
// number. A session kept in the browser (link-store.ts) comes back after a reload. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { createLinkRelay } from '../../server/link-relay.ts';
import { pollAnswer, readAnswer, startLinkSession } from '../link-client.ts';
import { clearSession, loadSession, purgeSessions, saveSession } from '../link-store.ts';
import { lightNodeId, parseLink } from '../qnet-link.ts';
import { openAnswer } from '../qnet-link-crypto.ts';
import { LINK, appSeal, bodyOf } from './link-helpers.mjs';
import { verifyReserveAnswer } from '../cabinet/burn-record.ts';

const ORIGIN = 'https://aiqnet.io';
const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const NOW = { nowS: Math.floor(Date.now() / 1000), consent24h: true };
let scopes = 0;

// fetch() of the page and of the app, routed to the relay's handlers like the Next.js routes do.
function world() {
  const relay = createLinkRelay({
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.9' }),
    scope: `client${(scopes += 1)}`,
    devOrigins: false,
  });
  const requests = [];
  const fetchFn = async (url, init = {}) => {
    const request = new Request(new URL(url, ORIGIN), init);
    requests.push({ url: request.url, method: request.method, init });
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path.length === 3) return relay.createSession(request);
    if (path.length === 4) return relay.getSession(request, path[3]);
    return request.method === 'POST' ? relay.postAnswer(request, path[3]) : relay.getAnswer(request, path[3]);
  };
  return { relay, fetchFn, requests };
}

// The app: parse the link it was opened with, read the session, require it to match (the request by its hash,
// recomputed from the request bytes in the protocol's key order), answer.
async function app(fetchFn, link, answer) {
  const parsed = parseLink(link);
  assert.ok(parsed, 'the app parses the link');
  const session = await (await fetchFn(`${ORIGIN}/api/link/sessions/${parsed.id}`)).json();
  assert.equal(session.sitePub, parsed.sitePub);
  assert.equal(session.intent, parsed.intent);
  assert.equal(session.reqHash, parsed.reqHash);
  if (parsed.reqHash) {
    const keys = parsed.intent === 'link' ? ['burnTx', 'walletHash', 'check'] : ['walletHash'];
    const bytes = JSON.stringify(Object.fromEntries(keys.map((k) => [k, session.request[k]])));
    assert.equal(createHash('sha256').update(bytes).digest('base64url'), parsed.reqHash);
  }
  assert.equal(session.answered, false);
  const plaintext = JSON.stringify({ v: 1, intent: parsed.intent, ...answer });
  const sealed = appSeal({ id: parsed.id, intent: parsed.intent, sitePub: parsed.sitePub, plaintext, reqHash: parsed.reqHash ?? null });
  const res = await fetchFn(`${ORIGIN}/api/link/sessions/${parsed.id}/response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyOf(sealed)),
  });
  return { status: res.status, body: bodyOf(sealed), checkNumber: sealed.checkNumber };
}

test('connect: session, app answer, poll, decrypt, check; the page asks only its own origin', async () => {
  const { fetchFn, requests } = world();
  const started = await startLinkSession('connect', null, { fetchFn });
  assert.equal(started.ok, true);
  const { session } = started;
  assert.equal(session.key.kind, 'webcrypto');
  assert.ok(started.expiresAt <= Date.now() + 600_000);
  assert.equal((await pollAnswer(session, { fetchFn })).kind, 'waiting');

  const answered = await app(fetchFn, session.link, { status: 'ok', qnet: WALLET, solana: SOLANA });
  assert.equal(answered.status, 201);
  const polled = await pollAnswer(session, { fetchFn });
  assert.equal(polled.kind, 'answered');
  const read = await readAnswer(session, polled.body, NOW);
  assert.deepEqual(read, { ok: true, answer: { v: 1, intent: 'connect', status: 'ok', qnet: WALLET, solana: SOLANA }, checkNumber: answered.checkNumber });

  for (const r of requests) assert.ok(r.url.startsWith(`${ORIGIN}/api/link/sessions`), r.url);
  const create = requests.find((r) => r.method === 'POST');
  assert.equal(create.init.credentials, 'omit');
  assert.equal(create.init.redirect, 'error');
  assert.equal(create.init.cache, 'no-store');
});

test('link with a known wallet: the request travels, a linked answer for another wallet is refused', async () => {
  const { fetchFn } = world();
  const request = { burnTx: null, walletHash: '74940b0126365748', check: false };
  const started = await startLinkSession('link', request, { fetchFn });
  assert.equal(started.ok, true);
  assert.deepEqual(started.session.request, request);
  const other = '60b4f3e026e24dcc7d8eonfda2b095a258ab95c1db2c0';
  await app(fetchFn, started.session.link, { status: 'linked', qnet: other, nodeId: lightNodeId(other), seq: '1790086400' });
  assert.deepEqual(await readAnswer(started.session, (await pollAnswer(started.session, { fetchFn })).body, NOW), { ok: false });

  const second = await startLinkSession('link', request, { fetchFn });
  const linked = { status: 'linked', qnet: WALLET, nodeId: lightNodeId(WALLET), seq: '1790086400' };
  const answered = await app(fetchFn, second.session.link, linked);
  const read = await readAnswer(second.session, (await pollAnswer(second.session, { fetchFn })).body, NOW);
  assert.deepEqual(read, { ok: true, answer: { v: 1, intent: 'link', ...linked }, checkNumber: answered.checkNumber });
});

// Owner decision 27.09 (EXT-R1-03 option (a)): below 1 QNC only for a capped claim (stoppedAtEpoch set), never zero.
test('claim: an answer with a stoppedAtEpoch may move less than 1 QNC; a full claim may not', async () => {
  const { fetchFn } = world();
  const read = async (answer) => {
    const { session } = await startLinkSession('claim', { walletHash: null }, { fetchFn });
    await app(fetchFn, session.link, answer);
    return readAnswer(session, (await pollAnswer(session, { fetchFn })).body, NOW);
  };
  const ok = { status: 'ok', qnet: WALLET, nodeId: lightNodeId(WALLET), amountNano: '1000000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: '155' };
  assert.equal((await read(ok)).ok, true);
  const capped = await read({ ...ok, amountNano: '400000000' });
  assert.equal(capped.ok, true);
  assert.equal(capped.answer.amountNano, '400000000');
  assert.equal(capped.answer.stoppedAtEpoch, '155');
  assert.deepEqual(await read({ ...ok, amountNano: '999999999', stoppedAtEpoch: null }), { ok: false });
  assert.deepEqual(await read({ ...ok, amountNano: '0' }), { ok: false });
  assert.deepEqual(await read({ ...ok, amountNano: '0', stoppedAtEpoch: null }), { ok: false });
});

test('a second device answering first: the real app gets 409, the page reads the first answer', async () => {
  const { fetchFn } = world();
  const { session } = await startLinkSession('claim', { walletHash: null }, { fetchFn });
  assert.equal((await app(fetchFn, session.link, { status: 'rejected' })).status, 201);
  const late = appSeal({ id: session.id, intent: 'claim', sitePub: session.sitePub, plaintext: '{"v":1,"intent":"claim","status":"rejected"}', reqHash: session.reqHash });
  const res = await fetchFn(`${ORIGIN}/api/link/sessions/${session.id}/response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyOf(late)),
  });
  assert.equal(res.status, 409);
  const read = await readAnswer(session, (await pollAnswer(session, { fetchFn })).body, NOW);
  assert.equal(read.ok, true);
  assert.deepEqual(read.answer, { v: 1, intent: 'claim', status: 'rejected' });
});

test('an answer sealed for another session, another request or swapped by the relay is unreadable', async () => {
  const { fetchFn } = world();
  const request = { burnTx: null, walletHash: null, check: true };
  const a = (await startLinkSession('link', request, { fetchFn })).session;
  const b = (await startLinkSession('link', request, { fetchFn })).session;
  const { body } = await app(fetchFn, b.link, { status: 'rejected' });
  assert.deepEqual(await readAnswer(a, body, NOW), { ok: false });
  assert.deepEqual(await readAnswer({ ...b, reqHash: a.reqHash === b.reqHash ? 'A'.repeat(43) : a.reqHash }, body, NOW), { ok: false });
  const flipped = { ...body, ct: `${body.ct.slice(0, -2)}${body.ct.slice(-2) === 'AA' ? 'BA' : 'AA'}` };
  assert.deepEqual(await readAnswer(b, flipped, NOW), { ok: false });
  assert.equal((await readAnswer(b, body, NOW)).ok, true);
});

test('the vectors\' answers read through the client, check number included', async () => {
  for (const c of LINK.cases.filter((x) => x.intent !== 'link' || JSON.parse(x.plaintext).status !== 'ok')) {
    const { siteSession } = await import('../qnet-link-crypto.ts');
    const s = siteSession(c.sessionId, c.intent, c.request, Uint8Array.from(Buffer.from(c.sitePrivateKey, 'hex')));
    // A `reserve` answer is read with the site's verifier of the wallet's signed reservation, as the activation page does.
    const read = await readAnswer(s, c.responseRequest, { nowS: Number(c.context.now), consent24h: c.context.consent24h, verifyReservation: verifyReserveAnswer });
    assert.deepEqual(read, { ok: true, answer: JSON.parse(c.plaintext), checkNumber: Number(c.checkNumber) }, c.name);
  }
});

test('a kept session comes back after a reload and still reads its answer; nothing else is kept', async () => {
  const { fetchFn } = world();
  const area = new Map();
  const store = { get: async (k) => area.get(k), put: async (k, v) => { area.set(k, v); }, delete: async (k) => { area.delete(k); }, slots: async () => [...area.keys()] };
  const request = { burnTx: null, walletHash: null, check: true };
  const started = await startLinkSession('link', request, { fetchFn });
  assert.equal(await saveSession('devices', started.session, started.expiresAt, store), true);
  const kept = area.get('devices');
  assert.deepEqual(Object.keys(kept).sort(), ['expiresAt', 'id', 'intent', 'privateKey', 'request', 'sitePub']);
  assert.equal(kept.privateKey.extractable, false);

  const answered = await app(fetchFn, started.session.link, { status: 'rejected' });
  // The tab was discarded: the page starts again from what it kept.
  const restored = await loadSession('devices', Date.now(), store);
  assert.ok(restored);
  assert.equal(restored.session.link, started.session.link);
  assert.equal(restored.expiresAt, started.expiresAt);
  const read = await readAnswer(restored.session, (await pollAnswer(restored.session, { fetchFn })).body, NOW);
  assert.deepEqual(read, { ok: true, answer: { v: 1, intent: 'link', status: 'rejected' }, checkNumber: answered.checkNumber });
  await clearSession('devices', store);
  assert.equal(area.size, 0);

  // A key in memory only is never kept; an expired or tampered record is dropped when read.
  const { newSiteSession } = await import('../qnet-link-crypto.ts');
  const inMemory = await newSiteSession('connect', null, { subtle: null });
  assert.equal(await saveSession('home', inMemory, Date.now() + 60_000, store), false);
  assert.equal(area.size, 0);
  await saveSession('old', started.session, Date.now() - 1, store);
  assert.equal(await loadSession('old', Date.now(), store), null);
  assert.equal(area.has('old'), false);
  await saveSession('odd', started.session, Date.now() + 60_000, store);
  area.set('odd', { ...area.get('odd'), request: { burnTx: null, walletHash: null, check: 'yes' } });
  assert.equal(await loadSession('odd', Date.now(), store), null);
  assert.equal(area.has('odd'), false);
  assert.equal(await loadSession('none', Date.now(), store), null);
  // A page that opens deletes what any page left expired or unreadable, and keeps a live one.
  await saveSession('live', started.session, Date.now() + 60_000, store);
  await saveSession('stale', started.session, Date.now() - 1, store);
  area.set('junk', { id: 'x' });
  await purgeSessions(Date.now(), store);
  assert.deepEqual([...area.keys()], ['live']);
  area.clear();
  // SITE-R3-02: each activation keeps its request under its own slot (NodeActivate: activate.<payment address>), so one
  // tab's request for activation A never takes the place of B's, and each comes back with its own request.
  const requestA = { burnTx: bs58.encode(new Uint8Array(64).fill(5)), walletHash: null, check: false };
  const requestB = { burnTx: bs58.encode(new Uint8Array(64).fill(4)), walletHash: null, check: false };
  const sessionA = await startLinkSession('link', requestA, { fetchFn });
  const sessionB = await startLinkSession('link', requestB, { fetchFn });
  await saveSession('activate.A', sessionA.session, sessionA.expiresAt, store);
  await saveSession('activate.B', sessionB.session, sessionB.expiresAt, store);
  assert.deepEqual((await loadSession('activate.B', Date.now(), store)).session.request, requestB);
  assert.deepEqual((await loadSession('activate.A', Date.now(), store)).session.request, requestA);
  await clearSession('activate.A', store);
  assert.deepEqual([...area.keys()], ['activate.B']);
  area.clear();
  // Storage that throws keeps nothing and breaks nothing.
  const blocked = async () => { throw new Error('blocked'); };
  const broken = { get: blocked, put: blocked, delete: blocked, slots: blocked };
  assert.equal(await saveSession('x', started.session, Date.now() + 60_000, broken), false);
  assert.equal(await loadSession('x', Date.now(), broken), null);
  await clearSession('x', broken);
  await purgeSessions(Date.now(), broken);
  // The restored session opens nothing once closed, like any other.
  restored.session.closed = true;
  await assert.rejects(openAnswer(restored.session, answered.body), /closed/);
});

test('an id the relay already holds is replaced once with a new key pair', async () => {
  const { fetchFn } = world();
  const first = await startLinkSession('connect', null, { fetchFn });
  let calls = 0;
  // The first draw repeats the existing id; the second is fresh.
  const random = (bytes) => {
    calls += 1;
    if (calls === 1) return bytes.set(Buffer.from(first.session.id, 'hex')), bytes;
    return crypto.getRandomValues(bytes);
  };
  const second = await startLinkSession('connect', null, { fetchFn, random });
  assert.equal(second.ok, true);
  assert.notEqual(second.session.id, first.session.id);
});

test('relay failures map to what the page says', async () => {
  const status = (code, headers = {}) => async () => new Response(null, { status: code, headers });
  assert.deepEqual(await startLinkSession('connect', null, { fetchFn: status(429, { 'Retry-After': '120' }) }), { ok: false, failure: 'rate_limited', retryAfterS: 120 });
  assert.deepEqual(await startLinkSession('connect', null, { fetchFn: status(503) }), { ok: false, failure: 'busy' });
  assert.deepEqual(await startLinkSession('connect', null, { fetchFn: status(403) }), { ok: false, failure: 'refused' });
  assert.deepEqual(await startLinkSession('connect', null, { fetchFn: status(409) }), { ok: false, failure: 'refused' });
  assert.deepEqual(await startLinkSession('connect', null, { fetchFn: async () => { throw new TypeError('offline'); } }), { ok: false, failure: 'network' });

  const s = { id: '0'.repeat(32), intent: 'connect' };
  assert.deepEqual(await pollAnswer(s, { fetchFn: status(404) }), { kind: 'expired' });
  assert.deepEqual(await pollAnswer(s, { fetchFn: status(429, { 'Retry-After': '7' }) }), { kind: 'retry', afterMs: 7000 });
  assert.deepEqual(await pollAnswer(s, { fetchFn: status(502) }), { kind: 'retry', afterMs: 2000 });
  assert.deepEqual(await pollAnswer(s, { fetchFn: async () => { throw new TypeError('offline'); } }), { kind: 'retry', afterMs: 2000 });
  assert.deepEqual(await pollAnswer(s, { fetchFn: async () => new Response('{"appPub":"x"}', { status: 200 }) }), { kind: 'unreadable' });
  // A body within the link caps is too big for a connect session.
  const linkBody = JSON.stringify(LINK.cases.find((c) => c.name === 'link-ok-check').responseRequest);
  assert.deepEqual(await pollAnswer(s, { fetchFn: async () => new Response(linkBody, { status: 200 }) }), { kind: 'unreadable' });
  assert.equal((await pollAnswer({ ...s, intent: 'link' }, { fetchFn: async () => new Response(linkBody, { status: 200 }) })).kind, 'answered');
});

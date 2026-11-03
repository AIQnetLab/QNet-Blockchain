// The /testnet faucet's admission (src/server/faucet-guard.ts) and its global budget (src/server/faucet-budget.ts).
// Every claim keeps its per-address cooldown and its windows per IP and per network block, each token its own, so one
// script cannot empty the faucet wallet or crowd the shared Solana send lane; and most of the hour is kept for claims with
// the faucet pass the node cabinet gets for the wallet it activates (src/server/faucet-pass.ts), one claim of each token
// per wallet a day, so a few addresses scripting claims at the start of an hour cannot shut it to people activating.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  LEGACY_COOLDOWN_MS, LEGACY_HOURLY, LEGACY_PER_IP, PASS_SHARE, PER_NETWORK, createLegacyFaucetGuard, legacyFaucetGuard, networkOf, passPlaces,
} from '../../server/faucet-guard.ts';
import { createFaucetBudget } from '../../server/faucet-budget.ts';
import { createFaucetCooldowns } from '../../server/faucet-cooldown.ts';
import {
  FAUCET_PASSES_PER_IP, FAUCET_PASSES_PER_NETWORK, FAUCET_PASS_PER_IP, FAUCET_PASS_TTL_S, checkFaucetPass, createFaucetPassRoute, faucetPassKey, mintFaucetPass,
  sharedFaucetPassKey,
} from '../../server/faucet-pass.ts';
import {
  FAUCET_PASS_RE, PASS_HANDOVER_KEY, PASS_MARGIN_MS, PASS_RETRY_MS, PASS_WAIT_MS, createFaucetPasses, handOverPass, requestFaucetPass, retryAt,
  takeHandedPass,
} from '../faucet-handover.ts';
import { OFFCHAIN_CONTEXT, burnRecordEnvelope, reservationMessage } from '../cabinet/burn-record.ts';
import { encodeB64url, eonOfPublicKey } from '../qnet-link.ts';
import { createRateLimiter } from '../../../lib/rate-limit.ts';
import { repo } from './source.mjs';

const HOUR = 60 * 60 * 1000;

function guard(options = {}) {
  let t = 10 * HOUR;
  const now = () => t;
  const limiter = createRateLimiter({ now });
  const g = createLegacyFaucetGuard({
    now,
    cooldowns: createFaucetCooldowns({ cooldownMs: LEGACY_COOLDOWN_MS, now }),
    limit: (id, max, windowMs) => limiter.limit(id, max, windowMs),
    ...options,
  });
  return { g, advance: (ms) => { t += ms; } };
}

const ip = (n) => ({ ok: true, ip: `198.51.100.${n}` });
let seq = 0;
const addr = () => `Addr${(seq += 1).toString().padStart(38, 'x')}`;

test('one claim of each token per address a day; the page\'s parallel 1DEV and SOL pair both pass', () => {
  const { g, advance } = guard();
  const a = addr();
  assert.equal(g.admit(a, '1DEV', ip(1)).ok, true);
  assert.equal(g.admit(a, 'SOL', ip(1)).ok, true);
  const again = g.admit(a, '1DEV', ip(2));
  assert.equal(again.ok, false);
  assert.equal(again.status, 429);
  assert.equal(again.nextClaimTime, 10 * HOUR + LEGACY_COOLDOWN_MS);
  advance(LEGACY_COOLDOWN_MS);
  assert.equal(g.admit(a, '1DEV', ip(3)).ok, true);
});

test('one client IP gets LEGACY_PER_IP.max claims of each token an hour, whatever addresses it names', () => {
  const { g, advance } = guard();
  // A script at 10 requests a second for an hour, each for a new address.
  let admitted = 0;
  let refused = null;
  for (let i = 0; i < 36_000; i += 1) {
    const r = g.admit(addr(), i % 2 ? 'SOL' : '1DEV', ip(7));
    if (r.ok) admitted += 1;
    else refused ??= r;
  }
  assert.equal(admitted, 2 * LEGACY_PER_IP.max, 'each token its own window');
  assert.equal(refused.status, 429);
  assert.ok(refused.retryAfterS >= 1 && refused.retryAfterS <= 3600);
  assert.equal(g.admit(addr(), '1DEV', ip(8)).ok, true, 'another client is not affected');
  advance(LEGACY_PER_IP.windowMs);
  assert.equal(g.admit(addr(), '1DEV', ip(7)).ok, true);
  assert.deepEqual(LEGACY_PER_IP, { max: 5, windowMs: HOUR });
});

test('an hourly budget per token for everyone: many clients cannot take more, and the next hour opens again', () => {
  const { g, advance } = guard({ hourly: { '1DEV': 3, SOL: 2 } });
  // With a pass each wallet takes a place of the pass share first, then of the open share.
  for (let i = 0; i < 3; i += 1) assert.equal(g.admit(addr(), '1DEV', ip(10 + i), `wallet-budget-${i}`).ok, true);
  const full = g.admit(addr(), '1DEV', ip(20), 'wallet-budget-x');
  assert.equal(full.ok, false);
  assert.equal(full.status, 503);
  assert.ok(full.retryAfterS >= 1 && full.retryAfterS <= 3600);
  // A refusal by the budget does not spend the client's window.
  for (let i = 0; i < 2; i += 1) assert.equal(g.admit(addr(), 'SOL', ip(20), `wallet-sol-${i}`).ok, true, 'each token has its own budget');
  assert.equal(g.admit(addr(), 'SOL', ip(21), 'wallet-sol-x').status, 503);
  assert.equal(g.admit(addr(), 'NOPE', ip(22)).status, 503);
  advance(HOUR);
  assert.equal(g.admit(addr(), '1DEV', ip(30)).ok, true);
  assert.deepEqual({ ...LEGACY_HOURLY }, { '1DEV': 30, SOL: 30 });
  assert.equal(g.admit(addr(), 'QNC', ip(31)).status, 503, 'the faucet hands out no QNC');
});

test('a claim that cannot land gives its address and its budget place back; after the hour it changes nothing', () => {
  // One place an hour: the open one.
  const { g, advance } = guard({ hourly: { '1DEV': 1, SOL: 1 } });
  const a = addr();
  const first = g.admit(a, '1DEV', ip(40));
  assert.equal(first.ok, true);
  assert.equal(g.admit(addr(), '1DEV', ip(41)).status, 503);
  first.release();
  const second = g.admit(a, '1DEV', ip(42));
  assert.equal(second.ok, true, 'address and place are free again');
  advance(HOUR);
  const next = g.admit(addr(), '1DEV', ip(43));
  assert.equal(next.ok, true);
  second.release();
  assert.equal(g.admit(addr(), '1DEV', ip(44)).status, 503, 'last hour\'s place is not this hour\'s');
});

test('without the client\'s address it fails closed', () => {
  const { g } = guard();
  const r = g.admit(addr(), '1DEV', { ok: false, reason: 'no address' });
  assert.deepEqual(r, { ok: false, status: 503, error: 'Service misconfigured: no address' });
});

test('the route admits every claim through the guard on every network, before it sends', () => {
  const route = readFileSync(new URL('../../app/api/faucet/claim/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /environment !== 'testnet'|environment === 'testnet'/, 'no network skips a limit');
  const admit = route.indexOf('const admission = legacyFaucetGuard().admit(walletAddress, tokenType, getRateLimitKey(request), wallet);');
  const send = route.indexOf('const result = await sendTokens(tokenType, amount, walletAddress, deadline);');
  assert.ok(admit > 0 && send > admit);
  assert.match(route, /if \(result\.releasable === true\) admission\.release\(\);/);
  // One table of test-token amounts, and no amounts at all off testnet; that refusal comes before anything
  // is admitted or sent, and the network is the release's (src/server/faucet-config.ts), never a setting.
  assert.match(route, /const FAUCET_AMOUNTS = \{ '1DEV': 1500, SOL: 0\.01 \} as const;/);
  assert.match(route, /const faucetAmounts = \(environment: 'testnet' \| 'mainnet'\): typeof FAUCET_AMOUNTS \| null => \(environment === 'mainnet' \? null : FAUCET_AMOUNTS\);/);
  assert.doesNotMatch(route, /mainnet: \{|SOL: 0\.1\b/);
  const refuse = route.indexOf("return NextResponse.json({ success: false, error: 'The faucet sends test tokens only' }, { status: 404 });");
  assert.ok(refuse > 0 && refuse < admit, 'refused off testnet before the guard');
  // Devnet 1DEV and SOL only: no node serves a QNC faucet, and the route names no node.
  assert.doesNotMatch(route, /QNC|faucet\/claim`|:8001/);
  assert.equal(legacyFaucetGuard(), legacyFaucetGuard());
});

test('a budget: fixed windows on the epoch, a place given back only in its window, zero means closed', () => {
  let t = 5_500;
  const b = createFaucetBudget({ max: 2, windowMs: 1_000, now: () => t });
  const w = b.take();
  assert.equal(w, 5);
  assert.equal(b.take(), 5);
  assert.equal(b.full(), true);
  assert.equal(b.take(), null);
  assert.equal(b.resetTime(), 6_000);
  b.giveBack(w);
  assert.equal(b.used(), 1);
  t = 6_000;
  assert.equal(b.used(), 0);
  b.giveBack(w);
  assert.equal(b.used(), 0);
  assert.equal(createFaucetBudget({ max: 0, windowMs: 1_000 }).take(), null);
  assert.throws(() => createFaucetBudget({ max: -1, windowMs: 1_000 }), RangeError);
  assert.throws(() => createFaucetBudget({ max: 1, windowMs: 0 }), RangeError);
});

// ---------------------------------------------------------------- the faucet pass

const seed = (label) => createHash('sha256').update(label).digest();
const T0 = 1_790_000_000_000;
function walletOf(label) {
  const { secretKey, publicKey } = ml_dsa65.keygen(seed(`qnet:${label}`));
  return { sk: secretKey, pk: publicKey, qnet: eonOfPublicKey(publicKey), solana: bs58.encode(ed25519.getPublicKey(seed(`solana:${label}`))) };
}
// The wallet's signed reservation of a payment address's light burn at `time` (Unix seconds), as the record's hold.
function holdFor(w, burner, time) {
  const env = burnRecordEnvelope(reservationMessage(w.qnet, 'light', 'payment', burner, time));
  return { pk: encodeB64url(w.pk), sig: encodeB64url(ml_dsa65.sign(env, w.sk, { context: new TextEncoder().encode(OFFCHAIN_CONTEXT) })), time };
}

test('three to six IP addresses at the start of an hour take only the open share; activations keep theirs', () => {
  const { g, advance } = guard();
  assert.equal(PASS_SHARE, 0.8);
  assert.deepEqual(passPlaces(30), { pass: 24, open: 6 });
  assert.deepEqual(passPlaces(1), { pass: 0, open: 1 });
  assert.deepEqual(passPlaces(0), { pass: 0, open: 0 });
  // Six IP addresses, each in its own /24, firing a hundred claims of each token at :00 without a pass.
  let taken = 0;
  for (let n = 0; n < 6; n += 1) {
    for (let i = 0; i < 100; i += 1) {
      for (const token of ['1DEV', 'SOL']) if (g.admit(addr(), token, { ok: true, ip: `203.0.${n}.9` }).ok) taken += 1;
    }
  }
  assert.equal(taken, 2 * passPlaces(30).open, 'the open share of both tokens, no more');
  const open = g.admit(addr(), '1DEV', ip(60));
  assert.equal(open.status, 503);
  assert.ok(open.retryAfterS >= 1 && open.retryAfterS <= 3600, 'it says when to try again');
  // People activating a node, each with its wallet's pass, still get both tokens this hour.
  for (let i = 0; i < passPlaces(30).pass; i += 1) {
    const a = addr();
    assert.equal(g.admit(a, '1DEV', { ok: true, ip: `192.0.${i}.1` }, `wallet-${i}`).ok, true, `claim ${i}`);
    assert.equal(g.admit(a, 'SOL', { ok: true, ip: `192.0.${i}.1` }, `wallet-${i}`).ok, true);
  }
  assert.equal(g.admit(addr(), '1DEV', ip(61), 'wallet-late').status, 503, 'past both shares');
  advance(HOUR);
  assert.equal(g.admit(addr(), '1DEV', ip(62)).ok, true, 'the next hour opens again');
});

// The places kept for passes are kept pro rata through the hour: those claims with a pass have not taken by their share
// of the hour so far open to anyone, so the hour is not lost while no one activates; and however hard others claim, a
// claim with a pass later in the hour still finds its part.
test('the places kept for passes open pro rata through the hour; a claim with a pass later still finds its part', () => {
  const { g, advance } = guard();
  const open = (token, n) => g.admit(addr(), token, { ok: true, ip: `203.1.${n}.9` });
  // :00, no one activating: the open share, then a refusal that names when the next place opens (a 24th of the hour).
  for (let n = 0; n < 6; n += 1) assert.equal(open('1DEV', n).ok, true);
  const shut = open('1DEV', 6);
  assert.equal(shut.status, 503);
  assert.match(shut.error, /people activating a node/);
  assert.equal(shut.retryAfterS, HOUR / 24 / 1000);
  // Half the hour later the unused half of the kept places is open to anyone; the other half is still kept, and claims
  // with a pass take it to the last place.
  advance(HOUR / 2);
  let taken = 0;
  for (let n = 10; n < 40; n += 1) if (open('1DEV', n).ok) taken += 1;
  assert.equal(taken, 12);
  for (let i = 0; i < 12; i += 1) assert.equal(g.admit(addr(), '1DEV', { ok: true, ip: `192.0.${i}.2` }, `wallet-half-${i}`).ok, true, `pass ${i}`);
  const full = g.admit(addr(), '1DEV', { ok: true, ip: '192.0.99.2' }, 'wallet-half-x');
  assert.equal(full.status, 503);
  assert.match(full.error, /sent all it sends this hour/);
  // Steady activations under a flood: the claims with a pass a quarter of the way in count against what is kept, so the
  // flood gets nothing more then; three quarters in it takes what has opened, and claims with a pass still get their part.
  const { g: s, advance: on } = guard();
  for (let n = 0; n < 6; n += 1) assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: `203.2.${n}.9` }).ok, true);
  on(HOUR / 4);
  for (let i = 0; i < 6; i += 1) assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: `192.1.${i}.2` }, `wallet-q-${i}`).ok, true);
  for (let n = 10; n < 40; n += 1) assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: `203.2.${n}.9` }).ok, false, `flood ${n}`);
  on(HOUR / 2);
  let flood = 0;
  for (let n = 0; n < 40; n += 1) if (s.admit(addr(), 'SOL', { ok: true, ip: `203.3.${n}.9` }).ok) flood += 1;
  assert.equal(flood, 12);
  const late = [];
  for (let i = 0; i < 6; i += 1) {
    const got = s.admit(addr(), 'SOL', { ok: true, ip: `192.1.${50 + i}.2` }, `wallet-late-${i}`);
    assert.equal(got.ok, true, `late pass ${i}`);
    late.push(got);
  }
  assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: '192.1.99.2' }, 'wallet-late-x').status, 503);
  // A claim with a pass that cannot land gives back its place and its count: the place stays kept for a pass.
  late[0].release();
  assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: '203.4.0.9' }).ok, false);
  assert.equal(s.admit(addr(), 'SOL', { ok: true, ip: '192.1.98.2' }, 'wallet-late-again').ok, true);
});

test('one claim of each token per wallet a day with a pass, whatever address it names; per network block too', () => {
  const { g, advance } = guard();
  const first = g.admit(addr(), '1DEV', ip(70), 'wallet-daily');
  assert.equal(first.ok, true);
  assert.equal(g.admit(addr(), 'SOL', ip(70), 'wallet-daily').ok, true, 'the other token');
  const again = g.admit(addr(), '1DEV', ip(71), 'wallet-daily');
  assert.equal(again.status, 429);
  assert.equal(again.nextClaimTime, 10 * HOUR + LEGACY_COOLDOWN_MS);
  // A claim that cannot land gives the wallet's day back.
  first.release();
  assert.equal(g.admit(addr(), '1DEV', ip(72), 'wallet-daily').ok, true);
  advance(LEGACY_COOLDOWN_MS);
  assert.equal(g.admit(addr(), '1DEV', ip(73), 'wallet-daily').ok, true, 'a day later');
  // One /24: PER_NETWORK.max claims of a token an hour across its addresses; another block is not touched.
  const { g: net } = guard();
  let admitted = 0;
  for (let i = 1; i <= 60; i += 1) if (net.admit(addr(), '1DEV', { ok: true, ip: `198.18.7.${i}` }, `wallet-net-${i}`).ok) admitted += 1;
  assert.equal(admitted, PER_NETWORK.max);
  assert.equal(net.admit(addr(), '1DEV', { ok: true, ip: '198.18.8.1' }, 'wallet-net-other').ok, true);
  assert.deepEqual(PER_NETWORK, { max: 15, windowMs: HOUR });
  assert.equal(networkOf('198.18.7.200'), '198.18.7.0/24');
  assert.equal(networkOf('2001:db8:aa:bb::/64'), '2001:db8:aa::/48');
});

test('the faucet pass: the wallet and its end under the server key, checked in constant time, short-lived', () => {
  const key = faucetPassKey('33'.repeat(32));
  assert.deepEqual([...key], Array(32).fill(0x33));
  assert.equal(faucetPassKey('33'.repeat(31)).length, 32, 'too short: a key of the process');
  assert.notDeepEqual([...faucetPassKey(undefined)], [...faucetPassKey(undefined)]);
  assert.equal(sharedFaucetPassKey(), sharedFaucetPassKey(), 'one key for the pass route and the claim route');
  const w = walletOf('m13-pass');
  const { pass, until } = mintFaucetPass(key, w.qnet, T0);
  assert.match(pass, FAUCET_PASS_RE);
  assert.equal(until, T0 / 1000 + FAUCET_PASS_TTL_S);
  assert.equal(FAUCET_PASS_TTL_S, 3_600);
  assert.equal(checkFaucetPass(key, pass, T0), w.qnet);
  assert.equal(checkFaucetPass(key, pass, until * 1000 - 1), w.qnet);
  assert.equal(checkFaucetPass(key, pass, until * 1000), null, 'ended');
  assert.equal(checkFaucetPass(faucetPassKey('44'.repeat(32)), pass, T0), null, 'another key');
  const [wallet, end, mac] = pass.split('.');
  const other = walletOf('m13-other').qnet;
  assert.equal(checkFaucetPass(key, `${other}.${end}.${mac}`, T0), null, 'another wallet');
  assert.equal(checkFaucetPass(key, `${wallet}.${Number(end) + 60}.${mac}`, T0), null, 'a later end');
  assert.equal(checkFaucetPass(key, `${wallet}.${end}.${'A'.repeat(22)}`, T0), null);
  const far = mintFaucetPass(key, w.qnet, T0 + 86_400_000).pass;
  assert.equal(checkFaucetPass(key, far, T0), null, 'an end further off than a pass lasts');
  for (const junk of [null, 42, '', 'x.y.z', `${pass}x`]) assert.equal(checkFaucetPass(key, junk, T0), null, String(junk));
  const src = readFileSync(new URL('../../server/faucet-pass.ts', import.meta.url), 'utf8');
  assert.match(src, /expected\.length === given\.length && timingSafeEqual\(expected, given\)/);
  assert.match(src, /export function faucetPassKey\(configured: string \| undefined = process\.env\.FAUCET_PASS_KEY\): Buffer \{/);
  // The claim route checks it with the shared key and admits the claim under its wallet; a refusal names when.
  const route = readFileSync(new URL('../../app/api/faucet/claim/route.ts', import.meta.url), 'utf8');
  assert.match(route, /const wallet = checkFaucetPass\(sharedFaucetPassKey\(\), pass, Date\.now\(\)\);/);
  assert.match(route, /\.\.\.\(admission\.retryAfterS \? \{ retryAfterS: admission\.retryAfterS \} : \{\}\),/);
  // The deploy script makes the key and the explorer doc names it.
  assert.match(repo('deployment/deploy-aiqnet.sh'), /echo FAUCET_PASS_KEY=\\\$\(openssl rand -hex 32\) >> \$SITE_ENV/);
  assert.match(repo('docs/applications/explorer.md'), /\| `FAUCET_PASS_KEY` \|/);
});

test('POST /api/faucet/pass gives a pass only for the wallet\'s own signed reservation, on testnet, a few per client', async () => {
  let t = T0;
  const key = faucetPassKey('55'.repeat(32));
  const limiter = createRateLimiter({ now: () => t });
  let testnet = true;
  const route = createFaucetPassRoute({
    now: () => t, key, limit: (id, max, windowMs) => limiter.limit(id, max, windowMs), testnet: () => testnet, devOrigins: false,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.30' }),
  });
  const post = (body, ipAddr) => new Request('https://aiqnet.io/api/faucet/pass', {
    method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', ...(ipAddr ? { 'x-test-ip': ipAddr } : {}) }, body: JSON.stringify(body),
  });
  const json = async (res) => ({ status: res.status, body: JSON.parse(await res.text()) });
  const w = walletOf('m13-route');
  const payment = walletOf('m13-payment').solana;
  const good = { wallet: w.qnet, burner: payment, proof: holdFor(w, payment, T0 / 1000) };
  const got = await json(await route(post(good)));
  assert.equal(got.status, 200);
  assert.equal(checkFaucetPass(key, got.body.pass, t), w.qnet);
  assert.equal(got.body.until, T0 / 1000 + FAUCET_PASS_TTL_S);
  // Another wallet's key, another payment address than it signed, an old reservation, extra fields: no pass.
  const thief = walletOf('m13-thief');
  assert.deepEqual(await json(await route(post({ ...good, proof: holdFor(thief, payment, T0 / 1000) }, '203.0.113.31'))), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await json(await route(post({ ...good, burner: walletOf('m13-elsewhere').solana }, '203.0.113.31'))), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await json(await route(post({ ...good, proof: holdFor(w, payment, T0 / 1000 - 90_000) }, '203.0.113.31'))), { status: 400, body: { error: 'stale_proof' } });
  assert.deepEqual(await json(await route(post({ ...good, extra: 1 }, '203.0.113.31'))), { status: 400, body: { error: 'invalid_request' } });
  // A few per client IP, then a refusal that names when; another client is not touched.
  for (let i = 0; i < FAUCET_PASS_PER_IP.max; i += 1) await route(post(good, '203.0.113.40'));
  const limited = await json(await route(post(good, '203.0.113.40')));
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retryAfterS >= 1 && limited.body.retryAfterS <= 600);
  assert.equal((await route(post(good, '203.0.113.41'))).status, 200);
  // Off testnet the faucet sends nothing, and gives no pass.
  testnet = false;
  assert.equal((await route(post(good, '203.0.113.42'))).status, 404);
  // The route is the release's: testnet from BURN_CLUSTER (faucet-config.ts), the shared key.
  const file = readFileSync(new URL('../../app/api/faucet/pass/route.ts', import.meta.url), 'utf8');
  assert.match(file, /createFaucetPassRoute\(\{ clientKey: getRateLimitKey, testnet: \(\) => faucetEnvironment\(\) === 'testnet' \}\)/);
});

// A QNet wallet costs nothing, so anyone can sign reservations for throwaway wallets: a pass is scarce only by the few each
// client IP and each network block get an hour, counted once the reservation verified. Without them five addresses would
// take every place kept for passes.
test('a pass costs its client one of a few an hour, and its network block one of a few more', async () => {
  let t = T0;
  const key = faucetPassKey('77'.repeat(32));
  const limiter = createRateLimiter({ now: () => t });
  const route = createFaucetPassRoute({
    now: () => t, key, limit: (id, max, windowMs) => limiter.limit(id, max, windowMs), testnet: () => true, devOrigins: false,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') }),
  });
  const post = (body, ipAddr) => new Request('https://aiqnet.io/api/faucet/pass', {
    method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', 'x-test-ip': ipAddr }, body: JSON.stringify(body),
  });
  const throwaway = (label) => {
    const w = walletOf(label);
    const pay = walletOf(`${label}-pay`).solana;
    return { wallet: w.qnet, burner: pay, proof: holdFor(w, pay, Math.floor(t / 1000)) };
  };
  assert.deepEqual(FAUCET_PASSES_PER_IP, { max: 3, windowMs: HOUR });
  assert.deepEqual(FAUCET_PASSES_PER_NETWORK, { max: 10, windowMs: HOUR });
  // One IP, a fresh wallet each time: three passes an hour, then a refusal that names when.
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await route(post(throwaway(`m13-throw-${i}`), '198.51.100.7'))).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
  const refused = await route(post(throwaway('m13-throw-x'), '198.51.100.7'));
  const body = JSON.parse(await refused.text());
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retryAfterS >= 1 && body.retryAfterS <= 3600);
  // A reservation that does not verify costs none of them.
  for (let i = 0; i < 5; i += 1) {
    const bad = { ...throwaway(`m13-bad-${i}`), proof: holdFor(walletOf('m13-forger'), walletOf(`m13-bad-${i}-pay`).solana, Math.floor(t / 1000)) };
    assert.equal((await route(post(bad, '198.51.101.7'))).status, 400);
  }
  for (let i = 0; i < 3; i += 1) assert.equal((await route(post(throwaway(`m13-after-bad-${i}`), '198.51.101.7'))).status, 200);
  // One /24: ten passes an hour across its addresses; another block is not touched.
  const block = [];
  for (let n = 1; n <= 12; n += 1) block.push((await route(post(throwaway(`m13-block-${n}`), `198.18.9.${n}`))).status);
  assert.deepEqual(block, [...Array(10).fill(200), 429, 429]);
  assert.equal((await route(post(throwaway('m13-block-other'), '198.18.10.1'))).status, 200);
  // IPv6: the /64s of one /48 share its count.
  const six = [];
  for (let n = 0; n < 12; n += 1) six.push((await route(post(throwaway(`m13-six-${n}`), `2001:db8:7:${n.toString(16)}::/64`))).status);
  assert.deepEqual(six, [...Array(10).fill(200), 429, 429]);
  // An hour later each count is back.
  t += HOUR;
  assert.equal((await route(post(throwaway('m13-next-hour'), '198.51.100.7'))).status, 200);
});

test('the payment card asks for the pass with its hold and hands it over; the Testnet page sends it and says when to try again', async () => {
  // The client: the hold and its payment address go to the pass route; anything but a pass is none.
  const w = walletOf('m13-client');
  const hold = { wallet: w.qnet, pk: 'pk', sig: 'sig', time: 1 };
  const asked = [];
  const ok = mintFaucetPass(faucetPassKey('66'.repeat(32)), w.qnet, T0).pass;
  const fetchFn = async (url, init) => { asked.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ pass: ok, until: 1 }), { status: 200 }); };
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', fetchFn, T0), { pass: ok });
  assert.deepEqual(asked, [{ url: '/api/faucet/pass', body: { wallet: w.qnet, burner: 'PayAddr', proof: { pk: 'pk', sig: 'sig', time: 1 } } }]);
  // A refused confirmation is never asked again, past the hourly passes not before the refusal's time, and a failure
  // to reach the site or an answer that is no pass leaves the next press free to ask.
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => new Response('{"error":"invalid_proof"}', { status: 400 }), T0), { pass: null, retryAt: Infinity });
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => new Response('{"error":"not_found"}', { status: 404 }), T0), { pass: null, retryAt: Infinity });
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => new Response('{"error":"rate_limited","retryAfterS":900}', { status: 429 }), T0), { pass: null, retryAt: T0 + 900_000 });
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => new Response('', { status: 429 }), T0), { pass: null, retryAt: T0 + PASS_RETRY_MS });
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => new Response('{"pass":"nope"}', { status: 200 }), T0), { pass: null, retryAt: null });
  assert.deepEqual(await requestFaucetPass(hold, 'PayAddr', async () => { throw new Error('offline'); }, T0), { pass: null, retryAt: null });
  // Kept in this tab's session storage, read once and removed, as the address is.
  const area = new Map();
  const storage = { getItem: (k) => area.get(k) ?? null, setItem: (k, v) => area.set(k, v), removeItem: (k) => area.delete(k) };
  handOverPass(ok, storage);
  assert.deepEqual([...area.entries()], [[PASS_HANDOVER_KEY, ok]]);
  assert.equal(takeHandedPass(storage), ok);
  assert.equal(takeHandedPass(storage), null, 'once');
  handOverPass('not a pass', storage);
  assert.equal(area.size, 0);
  assert.equal(takeHandedPass(null), null);
  // When to try again: the faucet's seconds, or the time an address or wallet may claim again.
  assert.equal(retryAt({ retryAfterS: 90 }, T0), T0 + 90_000);
  assert.equal(retryAt({ nextClaimTime: new Date(T0 + 3_600_000).toISOString() }, T0), T0 + 3_600_000);
  assert.equal(retryAt({ nextClaimTime: new Date(T0 - 1).toISOString() }, T0), null);
  assert.equal(retryAt({ error: 'x' }, T0), null);
  assert.equal(retryAt(null, T0), null);
  const strip = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const steps = strip('components/cabinet/ActivateSteps.tsx');
  // The card asks for a pass only when its faucet link is followed, never as it shows: the server gives few passes an
  // hour.
  assert.doesNotMatch(steps, /requestFaucetPass|useEffect\([^;]*faucetPasses/);
  assert.match(steps, /const hold = ACTIVATION_NETWORK === 'testnet' \? record\.hold \?\? null : null;/);
  assert.match(steps, /\s*if \(walletSolana\) handOver\(walletSolana\);\s*if \(!hold\) return;\s*const kept = faucetPasses\.ready\(hold\);\s*if \(kept\) handOverPass\(kept\);/);
  // While the pass is asked for the link is busy and takes no second click; the move to the faucet happens only if the
  // card is still shown at the address it was clicked on, so a visitor gone elsewhere meanwhile stays there.
  assert.match(steps, /const toFaucet = \(event: MouseEvent<HTMLAnchorElement>\) => \{\s*if \(passWait\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/);
  assert.match(steps, /event\.preventDefault\(\);\s*const from = window\.location\.href;\s*setPassWait\(true\);\s*void faucetPasses\.obtain\(hold, record\.pub, PASS_WAIT_MS\)\.then\(\(got\) => \{\s*if \(got\) handOverPass\(got\);\s*if \(!shown\.current\) return;\s*setPassWait\(false\);\s*if \(window\.location\.href === from\) router\.push\(FAUCET_HREF\);/);
  assert.match(steps, /useEffect\(\(\) => \{\s*shown\.current = true;\s*return \(\) => \{\s*shown\.current = false;\s*\};\s*\}, \[\]\);/);
  assert.match(steps, /<Link href=\{FAUCET_HREF\} onClick=\{toFaucet\} aria-busy=\{passWait \|\| undefined\}>/);
  assert.equal(steps.match(/router\.push\(/g)?.length, 1);
  assert.match(strip('styles/base.css'), /\.btn\[aria-busy='true'\], a\[aria-busy='true'\] \{ cursor: progress; \}/);
  const page = strip('app/testnet/page.tsx');
  assert.match(page, /setFaucetPass\(takeHandedPass\(\)\);/);
  assert.match(page, /const withPass = faucetPass \? \{ pass: faucetPass \} : \{\};/);
  assert.equal(page.match(/tokenType: '(?:1DEV|SOL)', \.\.\.withPass \}/g).length, 2);
  // The time through the site's one formats module (14:05, or Oct 20, 14:05 beyond the next twelve hours).
  assert.match(page, /return ` \$\{t\('faucet_try_at', \{ time: clockAt\(at, now, t\) \}\)\}`;/);
  assert.doesNotMatch(page, /Intl\.DateTimeFormat/);
  assert.match(page, /setErrorMessage\(err \+ tryAgain\(both, answered, t\)\);/);
});

// A pass is asked for only when the faucet link is followed, once per wallet's confirmation while it lasts, and never
// while a refusal holds.
test('the faucet pass: asked for once per confirmation while it lasts, shared by presses meanwhile, never during a refusal', async () => {
  let t = T0;
  const w = walletOf('pass-once');
  const hold = { wallet: w.qnet, pk: 'pk', sig: 'sig', time: 1 };
  const key = faucetPassKey('77'.repeat(32));
  let answer = () => new Response(JSON.stringify(mintFaucetPass(key, w.qnet, t)), { status: 200 });
  let asked = 0;
  let release = null;
  const fetchFn = async () => {
    asked += 1;
    if (release !== null) await new Promise((resolve) => { const go = release; release = null; go(resolve); });
    return answer();
  };
  const passes = createFaucetPasses(fetchFn, () => t);
  assert.equal(passes.ready(hold), null, 'nothing asked for before the link is followed');
  assert.equal(asked, 0);
  // Two presses at once share one request.
  const [a, b] = await Promise.all([passes.obtain(hold, 'PayAddr'), passes.obtain(hold, 'PayAddr')]);
  assert.equal(a, b);
  assert.equal(checkFaucetPass(key, a, t), w.qnet);
  assert.equal(asked, 1);
  // Kept while it lasts: no request on the next presses or visits.
  t += FAUCET_PASS_TTL_S * 1000 - PASS_MARGIN_MS - 1;
  assert.equal(passes.ready(hold), a);
  assert.equal(await passes.obtain(hold, 'PayAddr'), a);
  assert.equal(asked, 1);
  // Too close to its end: a new one.
  t += 1;
  assert.equal(passes.ready(hold), null);
  const c = await passes.obtain(hold, 'PayAddr');
  assert.notEqual(c, a);
  assert.equal(asked, 2);
  // Another confirmation of the wallet (asked again) is another pass.
  answer = () => new Response(JSON.stringify({ error: 'rate_limited', retryAfterS: 600 }), { status: 429 });
  const again = { ...hold, time: 2 };
  assert.equal(await passes.obtain(again, 'PayAddr'), null);
  assert.equal(asked, 3);
  // A refusal holds until its time: presses meanwhile ask nothing and go on at once.
  for (let i = 0; i < 5; i += 1) assert.equal(await passes.obtain(again, 'PayAddr'), null);
  assert.equal(asked, 3);
  t += 600_000;
  answer = () => new Response(JSON.stringify(mintFaucetPass(key, w.qnet, t)), { status: 200 });
  assert.equal(checkFaucetPass(key, await passes.obtain(again, 'PayAddr'), t), w.qnet);
  assert.equal(asked, 4);
  // A press waits only so long; the pass that comes later is kept for the next one.
  const late = { ...hold, time: 3 };
  let go;
  release = (resolve) => { go = resolve; };
  assert.equal(await passes.obtain(late, 'PayAddr', 10), null);
  go();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checkFaucetPass(key, passes.ready(late), t), w.qnet);
  assert.equal(asked, 5);
  // A pass that comes in time leaves no timer of the wait behind.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const quick = { ...hold, time: 5 };
  const before = timers();
  assert.equal(checkFaucetPass(key, await passes.obtain(quick, 'PayAddr', 60_000), t), w.qnet);
  assert.equal(timers(), before, 'the wait\'s timer went with the answer');
  assert.equal(asked, 6);
  // A refused confirmation is never asked again.
  answer = () => new Response(JSON.stringify({ error: 'stale_proof' }), { status: 400 });
  const stale = { ...hold, time: 4 };
  assert.equal(await passes.obtain(stale, 'PayAddr'), null);
  t += 30 * 24 * HOUR;
  assert.equal(await passes.obtain(stale, 'PayAddr'), null);
  assert.equal(asked, 7);
  // explorer.md states the card's rules with these numbers.
  const doc = repo('docs/applications/explorer.md').replace(/\s+/g, ' ');
  assert.equal(PASS_MARGIN_MS, 60_000, 'explorer.md: "until a minute before it ends"');
  for (const claim of [`the click waits at most ${PASS_WAIT_MS / 1000} s for the pass (\`PASS_WAIT_MS\`)`, `(${PASS_RETRY_MS / 1000} s when it names none)`]) {
    assert.ok(doc.includes(claim), claim);
  }
});

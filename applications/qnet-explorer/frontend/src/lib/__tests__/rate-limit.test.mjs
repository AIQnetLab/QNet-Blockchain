// The client IP behind every per-IP limit of the site (lib/rate-limit.ts): X-Real-IP from nginx, else the
// socket address; a client's X-Forwarded-For is never the key. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, getClientIdentifier, getRateLimitKey, normalizeIp, rateLimit, rateLimitKeyForIp, resolveClientIp } from '../../../lib/rate-limit.ts';

const req = (headers) => new Request('https://aiqnet.io/api/activity', { headers });

test('X-Real-IP (nginx: $remote_addr) is the client, whatever X-Forwarded-For says', () => {
  assert.equal(resolveClientIp(req({ 'x-real-ip': '203.0.113.5' })), '203.0.113.5');
  assert.equal(resolveClientIp(req({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1, 203.0.113.5' })), '203.0.113.5');
  assert.equal(resolveClientIp(req({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '1.1.1.1' })), '203.0.113.5');
  assert.equal(resolveClientIp(req({ 'x-real-ip': '2001:DB8::1' })), '2001:db8::1');
  assert.deepEqual(getRateLimitKey(req({ 'x-real-ip': '203.0.113.5' })), { ok: true, ip: '203.0.113.5' });
});

test('a malformed X-Real-IP is no address; nothing else is consulted', () => {
  for (const bad of ['', 'unknown', '203.0.113.5, 198.51.100.1', '203.0.113.256', '203.0.113.5:443', 'localhost', '::g']) {
    assert.equal(resolveClientIp(req({ 'x-real-ip': bad, 'x-forwarded-for': '198.51.100.1' })), null, bad);
    assert.equal(getRateLimitKey(req({ 'x-real-ip': bad })).ok, false, bad);
  }
});

test('without X-Real-IP (not through nginx) the key is the socket address Next.js records, one address only', () => {
  // Next.js sets X-Forwarded-For to the socket address when the request carries none.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '127.0.0.1' })), '127.0.0.1');
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '::1' })), '::1');
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '::ffff:192.0.2.4' })), '192.0.2.4');
  // A chain is not a socket address.
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.1, 127.0.0.1' })), null);
  assert.equal(resolveClientIp(req({})), null);
  const none = getRateLimitKey(req({}));
  assert.equal(none.ok, false);
  assert.match(none.reason, /X-Real-IP/);
  assert.equal(getClientIdentifier(req({})), 'unmetered');
});

test('the proxy flag no longer decides anything', () => {
  const previous = process.env.RATE_LIMIT_TRUSTED_PROXY;
  try {
    for (const flag of [undefined, '1']) {
      if (flag === undefined) delete process.env.RATE_LIMIT_TRUSTED_PROXY;
      else process.env.RATE_LIMIT_TRUSTED_PROXY = flag;
      assert.equal(resolveClientIp(req({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1' })), '203.0.113.5');
    }
  } finally {
    if (previous === undefined) delete process.env.RATE_LIMIT_TRUSTED_PROXY;
    else process.env.RATE_LIMIT_TRUSTED_PROXY = previous;
  }
});

test('normalizeIp: bare IPv4 or IPv6 only', () => {
  assert.equal(normalizeIp(' 192.0.2.1 '), '192.0.2.1');
  assert.equal(normalizeIp('::FFFF:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIp('FE80::1'), 'fe80::1');
  for (const bad of [null, '', '192.0.2', '192.0.2.1.5', 'x'.repeat(50), '[::1]', '192.0.2.1/24']) assert.equal(normalizeIp(bad), null, String(bad));
});

test('rotating X-Forwarded-For does not escape a limit keyed on X-Real-IP', () => {
  const scope = `rl-test-${Date.now()}`;
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) {
    const key = getRateLimitKey(req({ 'x-real-ip': '203.0.113.77', 'x-forwarded-for': `10.0.0.${i}` }));
    if (rateLimit(`${scope}:${key.ip}`, 5, 60_000).allowed) allowed += 1;
  }
  assert.equal(allowed, 5);
});

test('a full limiter evicts the key whose window started first and never refuses a new key', () => {
  let t = 0;
  const limiter = createRateLimiter({ maxEntries: 3, now: () => t });
  for (const k of ['a', 'b', 'c']) assert.equal(limiter.limit(k, 2, 60_000).allowed, true);
  assert.equal(limiter.limit('a', 2, 60_000).allowed, true);
  assert.equal(limiter.limit('a', 2, 60_000).allowed, false, 'a is over its limit');
  // Full: a new key gets in, and the oldest window ('a', started first) is the one that goes.
  assert.equal(limiter.limit('d', 2, 60_000).allowed, true);
  assert.equal(limiter.size(), 3);
  assert.equal(limiter.limit('a', 2, 60_000).remaining, 1, 'a starts a fresh window');
  // A key that starts a new window goes to the back of the line.
  t = 60_000;
  assert.equal(limiter.limit('b', 2, 60_000).remaining, 1);
  limiter.limit('e', 2, 60_000);
  assert.equal(limiter.limit('b', 2, 60_000).remaining, 0, 'b was not the one evicted');
  limiter.sweep();
  assert.ok(limiter.size() <= 3);
  assert.throws(() => createRateLimiter({ maxEntries: 0 }));
});

test('ten thousand new addresses a minute do not lock out the next one', () => {
  const limiter = createRateLimiter({ maxEntries: 10_000 });
  for (let i = 0; i < 25_000; i += 1) limiter.limit(`10.0.${i >> 8}.${i & 255}`, 90, 60_000);
  assert.equal(limiter.limit('192.0.2.1', 90, 60_000).allowed, true);
  assert.equal(limiter.size(), 10_000);
});

test('IPv6 clients are keyed by their /64; IPv4 as is', () => {
  assert.equal(rateLimitKeyForIp('203.0.113.5'), '203.0.113.5');
  assert.equal(rateLimitKeyForIp('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKeyForIp('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKeyForIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKeyForIp('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitKeyForIp('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
  const a = getRateLimitKey(req({ 'x-real-ip': '2001:DB8:1:2::aaaa' }));
  const b = getRateLimitKey(req({ 'x-real-ip': '2001:db8:1:2:ffff:ffff:ffff:ffff' }));
  assert.deepEqual(a, { ok: true, ip: '2001:db8:1:2::/64' });
  assert.deepEqual(a, b, 'one subscriber rotating its own addresses stays one key');
  assert.notDeepEqual(getRateLimitKey(req({ 'x-real-ip': '2001:db8:1:3::1' })), a);
});

// The testnet faucet's cooldown store (src/server/faucet-cooldown.ts): one claim per (address, token) per
// cooldown, kept in memory only for as long as the cooldown and bounded in size, as the privacy policy
// says. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFaucetCooldowns } from '../../server/faucet-cooldown.ts';

const DAY = 24 * 60 * 60 * 1000;

test('one claim per key per cooldown; a released slot is free again', () => {
  let t = 1_000;
  const c = createFaucetCooldowns({ cooldownMs: DAY, now: () => t });
  assert.deepEqual(c.check('a:1DEV'), { allowed: true });
  c.reserve('a:1DEV');
  assert.deepEqual(c.check('a:1DEV'), { allowed: false, nextClaimTime: 1_000 + DAY });
  assert.deepEqual(c.check('a:SOL'), { allowed: true }, 'each token has its own slot');
  t += DAY - 1;
  assert.equal(c.check('a:1DEV').allowed, false);
  t += 1;
  assert.deepEqual(c.check('a:1DEV'), { allowed: true });
  assert.equal(c.size(), 0, 'dropped once its cooldown has passed');
  c.reserve('b:1DEV');
  c.release('b:1DEV');
  assert.deepEqual(c.check('b:1DEV'), { allowed: true });
});

test('nothing is kept past its cooldown: the sweep drops every expired entry', () => {
  let t = 0;
  const c = createFaucetCooldowns({ cooldownMs: DAY, now: () => t });
  for (let i = 0; i < 50; i++) c.reserve(`addr${i}:1DEV`);
  t = DAY / 2;
  for (let i = 50; i < 60; i++) c.reserve(`addr${i}:1DEV`);
  t = DAY;
  c.sweep();
  assert.equal(c.size(), 10);
  t = DAY + DAY / 2;
  c.sweep();
  assert.equal(c.size(), 0);
});

test('bounded: a full store makes room by dropping the claim made longest ago, never refusing', () => {
  let t = 0;
  const c = createFaucetCooldowns({ cooldownMs: DAY, maxEntries: 3, now: () => t });
  for (const k of ['a', 'b', 'c']) { c.reserve(k); t += 1; }
  c.reserve('d');
  assert.equal(c.size(), 3);
  assert.equal(c.check('a').allowed, true, 'the oldest claim made room');
  assert.equal(c.check('d').allowed, false);
  // Expired entries go first, before any live one.
  t = DAY + 2;
  c.reserve('e');
  assert.equal(c.check('d').allowed, false, 'still inside its cooldown');
  assert.throws(() => createFaucetCooldowns({ cooldownMs: 0 }), RangeError);
  assert.throws(() => createFaucetCooldowns({ cooldownMs: DAY, maxEntries: 0 }), RangeError);
});

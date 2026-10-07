// The activation price proxy's parsing (src/lib/activation-price.ts): no fallback numbers, nothing but a
// whole-1DEV phase-1 price or phase 2. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_NODES, parseNodePrice, parseSitePrice, quoteFromNodes, sitePriceBody } from '../activation-price.ts';

// The node's phase-1 answer (registration_api.rs handle_activation_price).
const NODE_OK = {
  phase: 1, node_type: 'light', cost: 1500, currency: '1DEV', base_cost: 1500, min_cost: 300,
  burn_percentage: 0.5, savings: 0, savings_percent: 0, mechanism: 'burn', universal_price: true,
};

test('a node answer: phase 1 whole 1DEV, or phase 2; anything else is unavailable', () => {
  assert.deepEqual(parseNodePrice(NODE_OK, 'light'), { phase: 1, cost: 1500 });
  assert.deepEqual(parseNodePrice({ ...NODE_OK, node_type: undefined }, 'super'), { phase: 1, cost: 1500 });
  assert.deepEqual(parseNodePrice({ phase: 2, node_type: 'super', cost: 5000, currency: 'QNC' }, 'super'), { phase: 2 });
  for (const bad of [
    { ...NODE_OK, node_type: 'super' },
    { ...NODE_OK, cost: 1500.5 },
    { ...NODE_OK, cost: '1500' },
    { ...NODE_OK, cost: 0 },
    { ...NODE_OK, cost: 1_000_000_001 },
    { ...NODE_OK, currency: 'QNC' },
    { ...NODE_OK, phase: 3 },
    { error: 'Activation price unavailable: supply', retryable: true },
    { ...NODE_OK, error: 'x' },
    [NODE_OK],
    null,
    'x',
  ]) assert.equal(parseNodePrice(bad, 'light'), null, JSON.stringify(bad));
});

test('the site route answer is read strictly', () => {
  assert.deepEqual(parseSitePrice(sitePriceBody('super', { phase: 1, cost: 1200 }), 'super'), { phase: 1, cost: 1200 });
  assert.deepEqual(parseSitePrice(sitePriceBody('light', { phase: 2 }), 'light'), { phase: 2 });
  assert.equal(parseSitePrice(sitePriceBody('light', { phase: 1, cost: 1200 }), 'super'), null);
  assert.equal(parseSitePrice({ ...sitePriceBody('light', { phase: 1, cost: 1200 }), extra: 1 }, 'light'), null);
  assert.equal(parseSitePrice({ type: 'light', phase: 1, cost: -1, currency: '1DEV' }, 'light'), null);
  assert.equal(parseSitePrice({ error: 'unavailable' }, 'light'), null);
});

test('quoteFromNodes asks the pinned HTTPS nodes in turn and takes the first valid quote', async () => {
  assert.deepEqual(PRICE_NODES, [1, 2, 3, 4, 5].map((n) => `https://node${n}.aiqnet.io`));
  const asked = [];
  const answers = [
    () => { throw new TypeError('down'); },
    () => new Response('not json', { status: 200 }),
    () => new Response(JSON.stringify({ error: 'x' }), { status: 200 }),
    () => new Response(JSON.stringify(NODE_OK), { status: 200 }),
  ];
  const fetchFn = async (url, init) => {
    asked.push({ url, init });
    return answers[asked.length - 1]();
  };
  assert.deepEqual(await quoteFromNodes('light', fetchFn), { phase: 1, cost: 1500 });
  assert.equal(asked.length, 4);
  for (const { url, init } of asked) {
    assert.match(url, /^https:\/\/node[1-5]\.aiqnet\.io\/api\/v1\/activation\/price\?type=light$/);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(new Set(asked.map((a) => a.url)).size, 4, 'each node once');
});

test('no node, no price', async () => {
  let calls = 0;
  const down = async () => {
    calls += 1;
    return new Response('', { status: 502 });
  };
  assert.equal(await quoteFromNodes('super', down), null);
  assert.equal(calls, 5);
  const huge = async () => new Response(JSON.stringify({ ...NODE_OK, pad: 'x'.repeat(9000) }), { status: 200 });
  assert.equal(await quoteFromNodes('light', huge), null);
});

// SITE-R3-03: a node that streams an endless body (compromised, misrouted) must cost the site at most the
// 8 KiB cap: the stream is read chunk by chunk and cancelled once past it, never buffered whole.
const NODE = ['https://node1.aiqnet.io'];

function endlessBody(chunkBytes = 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      seen.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

// A reader that buffers the whole body never returns here: the timeout turns that into a failure.
test('an endless node body is cancelled just past the cap, never buffered', { timeout: 10_000 }, async () => {
  const { stream, seen } = endlessBody();
  const answer = await quoteFromNodes('light', async () => new Response(stream, { status: 200 }), NODE);
  assert.equal(answer, null);
  assert.equal(seen.cancelled, true);
  assert.ok(seen.pulled <= 8 * 1024 + 2 * 1024, `read ${seen.pulled} bytes`);
});

test('a declared Content-Length over the cap is refused before its body is read; other statuses are released', async () => {
  const big = endlessBody();
  const headers = { 'content-length': String(50 * 1024 * 1024) };
  assert.equal(await quoteFromNodes('light', async () => new Response(big.stream, { status: 200, headers }), NODE), null);
  assert.equal(big.seen.pulled, 0);
  assert.equal(big.seen.cancelled, true);
  const failed = endlessBody();
  assert.equal(await quoteFromNodes('light', async () => new Response(failed.stream, { status: 502 }), NODE), null);
  assert.equal(failed.seen.cancelled, true);
});

test('a valid answer under the cap still gives the quote, also in chunks; a body that is not UTF-8 does not', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(NODE_OK));
  const chunked = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  assert.deepEqual(await quoteFromNodes('light', async () => new Response(chunked, { status: 200 }), NODE), { phase: 1, cost: 1500 });
  const bad = new Uint8Array([...new TextEncoder().encode('{"phase":1,"cost":1500,"currency":"1DEV","x":"'), 0xff, ...new TextEncoder().encode('"}')]);
  assert.equal(await quoteFromNodes('light', async () => new Response(bad, { status: 200 }), NODE), null);
});

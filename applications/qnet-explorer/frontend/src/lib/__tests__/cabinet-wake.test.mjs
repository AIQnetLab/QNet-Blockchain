// "I'm back" (unified plan R8, SITE-7; src/lib/cabinet/wake.ts, src/server/cabinet/wake.ts,
// components/cabinet/WakePanel.tsx): the exact request, the node's reply read as its route writes it (light_push.rs
// WakeAnswer::to_json: success, reason, node_id and a cooldown's retry_after_seconds), the owners of the node's light
// shard asked in rank order (the next only when one gave no answer), the client's and the node's limits, a hold for a
// push sent or a cooldown named, and the page's offer, its waiting and its watch through the page's one status read.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CABINET_LIMITS, KEYED_LIMITS } from '../../server/cabinet/limits.ts';
import { lightShardOwners } from '../../server/cabinet/node-proxy.ts';
import { HANDOFF_MS, NODE_TIMEOUT_MS, WAKE_TOTAL_MS, createWake, wakeOrder } from '../../server/cabinet/wake.ts';
import { UPSTREAM_BUDGETS, createUpstreamBudget } from '../../server/cabinet/upstream.ts';
import {
  WAKE_PATH,
  WAKE_POLL_MS,
  WAKE_RESULTS,
  WAKE_RETRY_MAX_SECS,
  WAKE_WATCH_MS,
  canWake,
  checkWakeRequest,
  parseNodeWake,
  parseWakeView,
  wakeKey,
  wakeText,
  wakeView,
} from '../cabinet/wake.ts';
import { TEXTS } from '../texts.ts';

const NODE = 'light_mobile_6526ab8fd00ff8ca';
const OTHER = 'light_mobile_0123456789abcdef';
const REPO = new URL('../../../../../../', import.meta.url);
const repo = (path) => readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n');
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let scopes = 0;

// The node's reply about `nodeId`, exactly as its route writes it (serde_json, keys in order).
const reply = (reason, { nodeId = NODE, retry } = {}) => JSON.stringify(
  retry === undefined ? { node_id: nodeId, reason, success: reason === 'sent' } : { node_id: nodeId, reason, retry_after_seconds: retry, success: reason === 'sent' },
);

const view = (over = {}) => ({
  registered: true, pending: false, deviceBound: true, answeredThisEpoch: false, needsReactivation: true,
  counted: { sinceRegistration: 3, counted: 1, lastCountedEpoch: 150 }, features: ['wake', 'uptime'], balanceNano: null, ...over,
});

test('the request is exactly {"nodeId": N}; the node\'s reply is read as its route writes it, and the site\'s answer exactly', () => {
  assert.equal(checkWakeRequest({ nodeId: NODE }), NODE);
  for (const bad of [null, [], {}, { nodeId: NODE, x: 1 }, { nodeId: 'light_mobile_XYZ' }, { node_id: NODE }, { nodeId: `${NODE}0` }, 'x']) {
    assert.equal(checkWakeRequest(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([...WAKE_RESULTS], ['sent', 'already_answered', 'no_device', 'not_registered', 'cooldown']);
  for (const r of WAKE_RESULTS) {
    assert.deepEqual(parseNodeWake(JSON.parse(reply(r)), NODE), { result: r, retryAfterSeconds: null }, r);
    assert.deepEqual(parseNodeWake({ ...JSON.parse(reply(r)), extra: 1 }, NODE), { result: r, retryAfterSeconds: null }, 'the node may add fields');
    // `success` is true for `sent` alone; a reply that says otherwise is no reply.
    assert.equal(parseNodeWake({ ...JSON.parse(reply(r)), success: r !== 'sent' }, NODE), null, `${r}: success contradicts the reason`);
    assert.equal(parseNodeWake({ ...JSON.parse(reply(r)), success: undefined }, NODE), null, `${r}: no success`);
    // A reply about another node, or naming none, is no reply about this one.
    assert.equal(parseNodeWake(JSON.parse(reply(r, { nodeId: OTHER })), NODE), null, `${r}: another node`);
    assert.equal(parseNodeWake({ success: r === 'sent', reason: r }, NODE), null, `${r}: no node_id`);
  }
  // A cooldown's wait is read; any other reason's is ignored; a wait that is no whole number of seconds up to a day,
  // or the shape of a node before the route, is no reply.
  assert.deepEqual(parseNodeWake(JSON.parse(reply('cooldown', { retry: 42 })), NODE), { result: 'cooldown', retryAfterSeconds: 42 });
  assert.deepEqual(parseNodeWake(JSON.parse(reply('cooldown', { retry: 0 })), NODE), { result: 'cooldown', retryAfterSeconds: 0 });
  assert.deepEqual(parseNodeWake({ ...JSON.parse(reply('cooldown')), retry_after_seconds: null }, NODE), { result: 'cooldown', retryAfterSeconds: null });
  assert.deepEqual(parseNodeWake(JSON.parse(reply('sent', { retry: 42 })), NODE), { result: 'sent', retryAfterSeconds: null });
  for (const retry of [-1, 1.5, '60', WAKE_RETRY_MAX_SECS + 1, true]) {
    assert.equal(parseNodeWake(JSON.parse(reply('cooldown', { retry })), NODE), null, String(retry));
  }
  for (const bad of [{ result: 'sent' }, { success: false, reason: 'paused', node_id: NODE }, { success: false, error: 'Rate limit exceeded', retry_after_seconds: 60 }, null, [], 'sent']) {
    assert.equal(parseNodeWake(bad, NODE), null, JSON.stringify(bad));
  }
  // The site's answer: {"result"}, with a cooldown's known wait as retryAfterSeconds; read back exactly.
  for (const r of WAKE_RESULTS) {
    assert.deepEqual(wakeView({ result: r, retryAfterSeconds: null }), { result: r });
    assert.deepEqual(parseWakeView({ result: r }), { result: r, retryAfterSeconds: null });
    assert.equal(parseWakeView({ result: r, extra: 1 }), null, 'the site answers exactly');
  }
  assert.deepEqual(wakeView({ result: 'cooldown', retryAfterSeconds: 42 }), { result: 'cooldown', retryAfterSeconds: 42 });
  assert.deepEqual(wakeView({ result: 'sent', retryAfterSeconds: 42 }), { result: 'sent' });
  assert.deepEqual(parseWakeView({ result: 'cooldown', retryAfterSeconds: 42 }), { result: 'cooldown', retryAfterSeconds: 42 });
  assert.equal(parseWakeView({ result: 'sent', retryAfterSeconds: 42 }), null);
  assert.equal(parseWakeView({ result: 'cooldown', retryAfterSeconds: -1 }), null);
  assert.equal(parseWakeView({ result: 'cooldown', retry_after_seconds: 42 }), null);
  assert.equal(WAKE_PATH, '/api/v1/light-node/wake');
});

// The contract: the node's route (development/qnet-integration/src/rpc/light_push.rs) writes every reply, its address
// limit's included, with WakeAnswer::to_json; a reason or a field renamed there fails here.
test('contract: the reasons and the reply\'s fields are the ones the node\'s route writes', () => {
  const push = repo('development/qnet-integration/src/rpc/light_push.rs');
  const start = push.indexOf('impl WakeAnswer');
  const block = push.slice(start, push.indexOf('fn parse(', start));
  assert.ok(start >= 0 && block.length > 0, 'impl WakeAnswer');
  const reasons = [...block.matchAll(/WakeAnswer::\w+ => "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(reasons.sort(), [...WAKE_RESULTS].sort());
  assert.match(push, /json!\(\{\s*"success":\s*self == WakeAnswer::Sent,\s*"reason":\s*self\.as_str\(\),\s*"node_id":\s*node_id\s*\}\)/);
  assert.match(push, /if let Some\(s\) = retry_after \{ v\["retry_after_seconds"\] = json!\(s\); \}/);
  // Its address limit and every answer of the handler go through to_json (a forwarded one through forward_wake's).
  const from = push.indexOf('pub(super) async fn handle_light_node_wake');
  const handler = push.slice(from, push.indexOf('\n}\n', from));
  assert.ok(from >= 0 && handler.length > 0, 'handle_light_node_wake');
  assert.match(handler, /WakeAnswer::Cooldown\.to_json\(&req\.node_id, Some\(retry\)\)/);
  assert.doesNotMatch(handler, /rate_limit_body|"result"/);
  const replies = handler.split('\n').filter((line) => /\breply\(/.test(line) && !/let reply =/.test(line));
  assert.ok(replies.length >= 5, 'the handler\'s answers');
  for (const line of replies) assert.match(line, /reply\((?:(?:WakeAnswer::\w+|a|answer)\.to_json\(|v,)/, line.trim());
  const forward = push.slice(push.indexOf('async fn forward_wake'), push.indexOf('\n}\n', push.indexOf('async fn forward_wake')));
  assert.match(forward, /Some\(answer\.to_json\(node_id, v\["retry_after_seconds"\]\.as_u64\(\)\)\)/);
  // The time a backup takes to hand the wake to an owner above it that it cannot reach fits in the site's HANDOFF_MS.
  const forwardSecs = Number(push.match(/const WAKE_FORWARD_SECS: u64 = (\d+);/)?.[1]);
  assert.ok(forwardSecs > 0 && forwardSecs * 1000 + 1000 <= HANDOFF_MS, `WAKE_FORWARD_SECS ${forwardSecs}`);
  assert.match(forward, /\.timeout\(std::time::Duration::from_secs\(WAKE_FORWARD_SECS\)\)/);
  // The node's own words for each, read by the site: the exact JSON of a push sent and of a cooldown with its wait.
  assert.deepEqual(parseNodeWake(JSON.parse(`{"node_id":"${NODE}","reason":"sent","success":true}`), NODE), { result: 'sent', retryAfterSeconds: null });
  assert.deepEqual(parseNodeWake(JSON.parse(`{"node_id":"${NODE}","reason":"cooldown","retry_after_seconds":540,"success":false}`), NODE),
    { result: 'cooldown', retryAfterSeconds: 540 });
  assert.deepEqual(parseNodeWake(JSON.parse(`{"node_id":"${NODE}","reason":"already_answered","success":false}`), NODE), { result: 'already_answered', retryAfterSeconds: null });
  // The owners a backup hands the wake to first: the ranks above it (wake_plan), the order the site asks in.
  assert.match(push, /Some\(rank\) => \(owners\[\.\.rank\]\.to_vec\(\), true\),/);
});

test('I\'m back is offered only for a node that is not active: a linked device the network asks back, no answer this epoch', () => {
  assert.equal(canWake(view()), true);
  // Online (the network does not ask the device back): never offered, also before its answer of this epoch.
  assert.equal(canWake(view({ needsReactivation: false })), false);
  assert.equal(canWake(view({ needsReactivation: false, answeredThisEpoch: true })), false);
  assert.equal(canWake(view({ answeredThisEpoch: true })), false);
  assert.equal(canWake(view({ deviceBound: false })), false);
  assert.equal(canWake(view({ registered: false })), false);
  assert.equal(canWake(view({ features: ['uptime'] })), false);
  // Once the node names its device (contract of 04.10): Offline and silent this epoch only; never a device linked less
  // than an epoch ago that has not answered yet, never Online, never with no device.
  const device = (state, over = {}) => view({ device: { platform: 'android', linkedSince: 1_790_000_000, lastAnswerEpoch: 150, state }, ...over });
  assert.equal(canWake(device('offline')), true);
  assert.equal(canWake(device('offline', { answeredThisEpoch: true })), false);
  assert.equal(canWake(device('other_device_pending')), false);
  assert.equal(canWake(device('online')), false);
  assert.equal(canWake(device('unlinked')), false);
  assert.equal(canWake(device('offline', { features: ['uptime'] })), false);
  // Each result has its words; not_registered is the page's "no node"; a cooldown that names its wait, when to try again.
  for (const r of WAKE_RESULTS) assert.ok(Object.prototype.hasOwnProperty.call(TEXTS, wakeKey(r)), r);
  assert.equal(wakeKey('not_registered'), 'no_node');
  assert.equal(wakeKey('cooldown'), 'wake_cooldown');
  assert.equal(wakeText({ result: 'cooldown', retryAfterSeconds: null }), 'The network cannot wake the device right now. Try again in a few minutes.');
  for (const [secs, minutes] of [[0, 1], [42, 1], [60, 1], [61, 2], [600, 10], [601, 11], [14_400, 240]]) {
    assert.equal(wakeText({ result: 'cooldown', retryAfterSeconds: secs }), `The network cannot wake the device right now. Try again in ${minutes} min.`, String(secs));
  }
  assert.equal(wakeText({ result: 'already_answered', retryAfterSeconds: null }), TEXTS.wake_already);
  assert.match(TEXTS.wake_no_answer, /^No answer yet\. Open QNet Wallet on the linked device: a device does not wake an app that was closed from the app switcher\.$/);
  assert.equal(WAKE_WATCH_MS, 120_000);
  assert.equal(WAKE_POLL_MS, 10_000);
});

// Five genesis nodes, NODE's light shard owned by node2 (it wakes the device), node3 and node4 (lightShardOwners).
const NODES = [1, 2, 3, 4, 5].map((n) => `https://node${n}.aiqnet.io`);
const OWNERS = lightShardOwners(NODE).map((i) => new URL(NODES[i]).host);

function wake(answers, options = {}) {
  const calls = [];
  const w = createWake({
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (next === undefined || next instanceof Error) throw next ?? new TypeError('unreachable');
      if (typeof next === 'object') return new Response(next.body, { status: next.status });
      return new Response(typeof next === 'number' ? '{}' : next, { status: typeof next === 'number' ? next : 200 });
    },
    nodes: NODES,
    random: () => 0.5,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.5' }),
    scope: `wake${(scopes += 1)}`,
    devOrigins: false,
    ...options,
  });
  return { w, calls, hosts: () => calls.map((c) => new URL(c.url).host) };
}

const post = (body, headers = {}) => new Request('https://aiqnet.io/api/cabinet/wake', {
  method: 'POST',
  headers: { host: 'aiqnet.io', origin: 'https://aiqnet.io', 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const json = async (res) => JSON.parse(await res.text());

test('the owner that wakes the device is asked first, with {"node_id": N}; its reason is passed on exactly', async () => {
  assert.deepEqual(lightShardOwners(NODE), [1, 2, 3]);
  assert.deepEqual(wakeOrder(NODE, NODES, () => 0.5), lightShardOwners(NODE).map((i) => NODES[i]));
  const { w, calls, hosts } = wake([reply('sent')]);
  const res = await w.wake(post({ nodeId: NODE }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await json(res), { result: 'sent' });
  assert.deepEqual(hosts(), [OWNERS[0]]);
  assert.equal(calls[0].url, `${NODES[1]}${WAKE_PATH}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { node_id: NODE });
  // A cooldown is passed on with the wait the node named.
  const cool = wake([reply('cooldown', { retry: 540 })]);
  assert.deepEqual(await json(await cool.w.wake(post({ nodeId: NODE }))), { result: 'cooldown', retryAfterSeconds: 540 });
  // A list other than the five genesis nodes: up to three of it, from a random one on.
  assert.deepEqual(wakeOrder(NODE, ['a', 'b', 'c', 'd'], () => 0.5), ['c', 'd', 'a']);
  assert.deepEqual(wakeOrder(NODE, ['a', 'b'], () => 0.9), ['b', 'a']);
});

test('the backups in rank order, each only when the one before gave no answer; none at all is 503', async () => {
  let t = wake([new TypeError('down'), reply('already_answered')]);
  assert.deepEqual(await json(await t.w.wake(post({ nodeId: NODE }))), { result: 'already_answered' });
  assert.deepEqual(t.hosts(), OWNERS.slice(0, 2));

  // Not reached, a node before the route (404, an answer in an older shape), a reply about another node: no answer.
  t = wake([404, JSON.stringify({ result: 'sent' }), reply('sent', { nodeId: OTHER })]);
  const res = await t.w.wake(post({ nodeId: NODE }));
  assert.equal(res.status, 503);
  assert.deepEqual(await json(res), { error: 'unavailable' });
  assert.deepEqual(t.hosts(), OWNERS, 'the three owners, never a fourth genesis');

  t = wake(['not json', new TypeError('down'), reply('no_device')]);
  assert.deepEqual(await json(await t.w.wake(post({ nodeId: NODE }))), { result: 'no_device' });
  assert.deepEqual(t.hosts(), OWNERS);

  // An owner behind the network answers 503 (with a cooldown in its body): passed over, the next owner sends it.
  t = wake([{ status: 503, body: reply('cooldown', { retry: 60 }) }, reply('sent')]);
  assert.deepEqual(await json(await t.w.wake(post({ nodeId: NODE }))), { result: 'sent' });
  assert.deepEqual(t.hosts(), OWNERS.slice(0, 2));

  // Each owner has the time to hand the wake to the ones ranked above it first (light_push.rs wake_plan), the three of
  // them within the total, under the proxy's 60 s.
  assert.equal(NODE_TIMEOUT_MS, 8_000);
  assert.equal(HANDOFF_MS, 4_000);
  assert.equal(WAKE_TOTAL_MS, 40_000);
  assert.ok(3 * NODE_TIMEOUT_MS + (0 + 1 + 2) * HANDOFF_MS <= WAKE_TOTAL_MS && WAKE_TOTAL_MS < 60_000);
  const route = read('server/cabinet/wake.ts');
  assert.match(route, /const answer = await ask\(base, nodeId, Math\.min\(NODE_TIMEOUT_MS \+ rank \* HANDOFF_MS, remaining\)\);/);
  assert.match(route, /signal: AbortSignal\.timeout\(timeoutMs\),/);
});

test('refused before the node: another page, another body, too many from one client', async () => {
  const { w, calls } = wake(Array.from({ length: 10 }, () => reply('no_device')));
  assert.equal((await w.wake(post({ nodeId: NODE }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await w.wake(post({ nodeId: NODE }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await w.wake(post({ nodeId: NODE }, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await w.wake(post('x'.repeat(300)))).status, 413);
  assert.equal((await w.wake(post({ nodeId: 'nope' }, { 'x-test-ip': '198.51.100.1' }))).status, 400);
  assert.equal(calls.length, 0);

  // Three per client per 10 minutes, whatever the node (a node's own hold counts only what the network said: below).
  const ip = { 'x-test-ip': '198.51.100.9' };
  const nodes = [OTHER, 'light_mobile_1111111111111111', 'light_mobile_2222222222222222', 'light_mobile_3333333333333333'];
  const statuses = [];
  const many = wake(nodes.map((n) => reply('no_device', { nodeId: n })));
  for (const n of nodes) statuses.push((await many.w.wake(post({ nodeId: n }, ip))).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(many.calls.length, 3);
  assert.deepEqual(CABINET_LIMITS.wake, { max: 3, windowMs: 600_000 });
  assert.deepEqual(KEYED_LIMITS.wake, { max: 1, windowMs: 600_000 });
});

// SITE-R2-07: a node id is public, so a request proves nothing. The node's one wake per window was spent by any request
// before the node was even asked, so anyone could keep a node's owner at 429 with one request every ten minutes. Now
// only a push the network sent holds the node, and within the hold every request hears `cooldown`, the node's own
// answer then, with the wait left; a cooldown the node named holds it for that wait the same way.
test('only a push or the node\'s own cooldown holds a node; within the hold whoever asks hears cooldown and the wait, never 429', async () => {
  let t = 1_790_000_000_000;
  const answers = [reply('no_device'), new TypeError('down'), reply('already_answered'), reply('sent'), reply('sent', { nodeId: OTHER }), reply('sent')];
  const { w, calls } = wake(answers, { now: () => t });
  const ask = async (nodeId, ip) => {
    const res = await w.wake(post({ nodeId }, { 'x-test-ip': ip }));
    return [res.status, await json(res)];
  };
  // Requests that sent nothing, or reached no owner, hold nothing: the next one asks the network again.
  assert.deepEqual(await ask(NODE, '198.51.100.20'), [200, { result: 'no_device' }]);
  assert.deepEqual(await ask(NODE, '198.51.100.21'), [200, { result: 'already_answered' }]);
  // A push: for ten minutes, whoever asks hears `cooldown` with the wait left, without the network being asked.
  assert.deepEqual(await ask(NODE, '198.51.100.22'), [200, { result: 'sent' }]);
  assert.equal(calls.length, 4);
  assert.deepEqual(await ask(NODE, '198.51.100.23'), [200, { result: 'cooldown', retryAfterSeconds: 600 }]);
  t += 59_500;
  assert.deepEqual(await ask(NODE, '198.51.100.24'), [200, { result: 'cooldown', retryAfterSeconds: 541 }]);
  assert.equal(calls.length, 4);
  // Another node is not affected; after the window the node is woken again.
  assert.deepEqual(await ask(OTHER, '198.51.100.25'), [200, { result: 'sent' }]);
  t += KEYED_LIMITS.wake.windowMs;
  assert.deepEqual(await ask(NODE, '198.51.100.26'), [200, { result: 'sent' }]);
  assert.equal(calls.length, 6);

  // The node's own cooldown with its wait: held for that wait, then the network is asked again.
  let s = 1_790_000_000_000;
  const cool = wake([reply('cooldown', { retry: 120 }), reply('cooldown'), reply('sent')], { now: () => s });
  const coolAsk = async (ip) => json(await cool.w.wake(post({ nodeId: NODE }, { 'x-test-ip': ip })));
  assert.deepEqual(await coolAsk('198.51.100.30'), { result: 'cooldown', retryAfterSeconds: 120 });
  s += 30_000;
  assert.deepEqual(await coolAsk('198.51.100.31'), { result: 'cooldown', retryAfterSeconds: 90 });
  assert.equal(cool.calls.length, 1);
  s += 90_000;
  // A cooldown that names no wait holds nothing.
  assert.deepEqual(await coolAsk('198.51.100.32'), { result: 'cooldown' });
  assert.deepEqual(await coolAsk('198.51.100.33'), { result: 'sent' });
  assert.equal(cool.calls.length, 3);
  const route = read('server/cabinet/wake.ts');
  assert.match(route, /const refused = gate\(request, 'wake'\);/);
  assert.doesNotMatch(route, /route: 'wake', key/);
});

// Owner, 05.10: the page shows that it waits, then the card shows the device Online once the status read again says it
// answered; the watch reads through the page's one shared status read, never a read of its own.
test('the route and the page: one wake route, the offer only when canWake, waiting then Online through the shared read', () => {
  assert.match(read('app/api/cabinet/wake/route.ts'), /return cabinetWake\(\)\.wake\(request\);/);
  const panel = read('components/cabinet/WakePanel.tsx');
  assert.match(panel, /const offered = canWake\(status\);/);
  assert.match(panel, /body: JSON\.stringify\(\{ nodeId \}\),/);
  assert.match(panel, /const answer = parseWakeView\(await res\.json\(\)\);/);
  assert.match(panel, /text: wakeText\(answer\)/);
  assert.match(panel, /\{ phase: 'watching', until: Date\.now\(\) \+ WAKE_WATCH_MS \}/);
  assert.match(panel, /\{state\.phase === 'watching' && <p className="activate-status" aria-live="polite">\{t\('wake_waiting'\)\}<\/p>\}/);
  // While watching: the shared read again every WAKE_POLL_MS, and "answered" only from the status it brings.
  assert.match(panel, /const timer = window\.setInterval\(\(\) => refreshRef\.current\(\), WAKE_POLL_MS\);/);
  assert.match(panel, /const answered = status\.answeredThisEpoch;/);
  assert.match(panel, /if \(answered && state\.phase === 'watching'\) setState/);
  assert.doesNotMatch(panel, /\/api\/cabinet\/node\//);
  // One place only: the Overview's status card (owner, 04.10), given the shared read's refresh; the Device tab links
  // there. Once the status says it answered, the device rows show Online and the panel goes.
  const home = read('components/cabinet/NodeHome.tsx');
  assert.match(home, /\{wake && <WakePanel nodeId=\{nodeId\} status=\{status\} refresh=\{refresh\} \/>\}/);
  assert.match(home, /const wake = state === 'offline' && canWake\(status\);/);
  assert.doesNotMatch(read('components/cabinet/NodeDevices.tsx'), /<WakePanel/);
});

// SITE-R2-09: each genesis node gets at most UPSTREAM_BUDGETS.wake wakes a second from the site; past it the next owner
// is asked, and with none left the route answers that the network could not be reached, asking nobody.
test('each genesis node takes a bounded number of wakes a second', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const ids = Array.from({ length: 7 }, (_, i) => `light_mobile_100000000000000${i + 1}`);
  // A list of three: every id is asked of the same three nodes, from b on.
  const answers = ids.map((id) => reply('sent', { nodeId: id }));
  const { w, hosts } = wake(answers, { now, budget: createUpstreamBudget({ now }), nodes: ['https://a.example', 'https://b.example', 'https://c.example'] });
  const statuses = [];
  for (const [i, id] of ids.entries()) statuses.push((await w.wake(post({ nodeId: id }, { 'x-test-ip': `198.51.100.${40 + i}` }))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 503]);
  assert.deepEqual(hosts(), ['b.example', 'b.example', 'c.example', 'c.example', 'a.example', 'a.example']);
  // The seventh id's answer is still queued: past the second, it is asked and answered.
  t += UPSTREAM_BUDGETS.wake.windowMs;
  assert.equal((await w.wake(post({ nodeId: ids[6] }, { 'x-test-ip': '198.51.100.50' }))).status, 200);
});

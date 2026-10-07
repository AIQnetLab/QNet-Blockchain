// The node cabinet's reads through the site (src/server/cabinet/node-proxy.ts, limits.ts): exact shapes, two
// genesis nodes that must agree for "no node" (both at the network's height, none listing it) and for "registered",
// the features both list, the node balance, the node's epochs one by one (a second node for the epochs the first could
// not serve, the explorer archive's registration, dates and moves: epoch-archive.ts), caching and one upstream round
// per node, the per-client gate; a super node's status, and whether a wallet has a node of either type (wallet-node.ts).
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsSha3 from 'js-sha3';
import { CABINET_LIMITS, CLIENT_BUDGETS, createGate } from '../../server/cabinet/limits.ts';
import {
  NONE_CACHE_MS, RESERVE_CACHE_MS, STATUS_CACHE_MS, SUPER_CACHE_MS, createNodeProxy, historyView, lightShardOwners, mergeHistory, mergeStatus, parseHistory, parsePending,
  parsePublicStatus, settlingPair, stillNeeded,
} from '../../server/cabinet/node-proxy.ts';
import { createKnownNodes } from '../../server/cabinet/known-nodes.ts';
import {
  CLAIMS_SQL, TIMES_SQL, claimsFrom, createEpochArchive, movedEpochs, registrationHeight, timesFrom,
} from '../../server/cabinet/epoch-archive.ts';
import { RECORD_SQL } from '../../server/cabinet/registration-record.ts';
import { epochOfHeight, epochOfKey } from '../cabinet/epochs.ts';
import { UPSTREAM_BUDGETS, createUpstreamBudget } from '../../server/cabinet/upstream.ts';
import { parseHistoryView, parseStatusView } from '../cabinet/node-view.ts';
import { GENESIS_NODES } from '../genesis-nodes.ts';
import { PRICE_NODES } from '../activation-price.ts';

const NODE = 'light_mobile_6526ab8fd00ff8ca';
const BASE = `https://aiqnet.io/api/cabinet/node/${NODE}`;
let scopes = 0;

const status = (over = {}) => ({
  onchain_registered: true,
  registration_pending: false,
  device_bound: true,
  answered_this_epoch: true,
  needs_reactivation: false,
  counted: { epochs_since_registration: 6, counted: 5, last_counted_epoch: 155 },
  features: ['bind_v2', 'consent_24h', 'uptime', 'wake'],
  device_tag_h: '0123456789abcdef',
  ...over,
});

// Genesis nodes that answer from a table per host: a function of the path, or a status code.
function network(table) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: `${u.pathname}${u.search}`, init });
    const answer = table[u.host]?.(`${u.pathname}${u.search}`);
    if (answer === undefined) throw new TypeError('unreachable');
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status: 200 });
  };
  return { fetchFn, calls };
}

const host = (n) => `node${n}.aiqnet.io`;
const everyNode = (answer) => Object.fromEntries([1, 2, 3, 4, 5].map((n) => [host(n), answer]));
const reads = (s, pending = { pending_rewards_nano: 12_500_000_000 }) => (path) =>
  path.startsWith('/api/v1/light-node/status') ? s : path.startsWith('/api/v1/rewards/pending/') ? pending : undefined;

function proxy(table, options = {}) {
  let t = 1_000_000;
  const net = network(table);
  const p = createNodeProxy({
    fetchFn: net.fetchFn,
    random: () => 0.5,
    now: () => t,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.5' }),
    scope: `cabinet${(scopes += 1)}`,
    devOrigins: false,
    ...options,
  });
  return { p, calls: net.calls, advance: (ms) => { t += ms; } };
}

const get = (url = BASE, headers = {}) => new Request(url, { headers: { host: 'aiqnet.io', ...headers } });
const json = async (res) => JSON.parse(await res.text());

// Contract of 04.10, section 2: the public status names the linked device (its state, the platform it said when it
// linked, the UTC day it linked, its last answer's epoch), null for a node not on the chain; the site reads it strictly,
// takes a node of an earlier version (no field) as naming none, and passes the first settling answer's on. A field it
// does not read is ignored, as in the status itself; the exact time of the last answer an earlier node still sends
// (`last_answer_at`, `last_answer`) is never kept (H-1, 06.10).
test('the public status\'s device: read strictly, none from an earlier node, passed on from the first settling answer', async () => {
  const device = { platform: 'ios', linked_since: 1_790_000_000 - (1_790_000_000 % 86_400), last_answer_epoch: 155, state: 'online' };
  const none = { model: null, last_miss: null };
  assert.deepEqual(parsePublicStatus(status({ device })).device, { ...device, ...none });
  assert.deepEqual(parsePublicStatus(status({ device: { ...device, extra: 1, last_answer_at: 1_790_000_100, last_answer: { at: 1_790_000_100, delivery_delay_secs: 4 } } })).device,
    { ...device, ...none });
  assert.equal(parsePublicStatus(status()).device, null, 'a node of an earlier version names none');
  assert.equal(parsePublicStatus(status({ device: null })).device, null);
  for (const state of ['online', 'offline', 'unlinked', 'other_device_pending']) assert.equal(parsePublicStatus(status({ device: { ...device, state } })).device.state, state);
  for (const platform of ['android', 'ios', 'unknown', null]) assert.equal(parsePublicStatus(status({ device: { ...device, platform } })).device.platform, platform);
  for (const bad of [{ ...device, state: 'paused' }, { ...device, platform: 'ipados' }, { ...device, linked_since: -1 }, { ...device, last_answer_epoch: '155' },
    { platform: 'ios', linked_since: null, state: 'online' }, [], 'online']) {
    assert.equal(parsePublicStatus(status({ device: bad })), null, JSON.stringify(bad));
  }
  // A node not on the chain names no device, whatever it sends.
  assert.equal(parsePublicStatus(status({ onchain_registered: false, device })).device, null);
  // The route passes the first settling answer's device in the page's words; the page reads it exactly.
  const { p } = proxy(everyNode(reads(status({ device: { ...device, state: 'other_device_pending', last_answer_epoch: null } }))));
  const body = await json(await p.status(get(), NODE));
  assert.deepEqual(body.device, { platform: 'ios', model: null, linkedSince: device.linked_since, lastAnswerEpoch: null, state: 'other_device_pending', lastMiss: null });
  assert.deepEqual(parseStatusView(body), body);
  assert.equal(parseStatusView({ ...body, device: { ...body.device, state: 'paused' } }), null);
  assert.equal(parseStatusView({ ...body, device: undefined }), null, 'the key is always there');
  const old = await json(await proxy(everyNode(reads(status()))).p.status(get(), NODE));
  assert.equal(old.device, null);
  const a = parsePublicStatus(status({ device }));
  const b = parsePublicStatus(status({ device: { ...device, state: 'offline' } }));
  assert.deepEqual(mergeStatus(a, b, null).device, { platform: 'ios', model: null, linkedSince: device.linked_since, lastAnswerEpoch: 155, state: 'online', lastMiss: null });
});

test('the genesis nodes are the price nodes: one list', () => {
  assert.equal(PRICE_NODES, GENESIS_NODES);
  assert.deepEqual(GENESIS_NODES, [1, 2, 3, 4, 5].map((n) => `https://${host(n)}`));
});

test('a registered node: two agreeing nodes, the features both list, the balance, an exact answer the page accepts', async () => {
  const table = everyNode(reads(status()));
  table[host(3)] = reads(status({ features: ['bind_v2', 'uptime'] }));
  const { p, calls } = proxy(table);
  const res = await p.status(get(), NODE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await json(res);
  assert.deepEqual(parseStatusView(body), body, 'the page takes it as it is');
  assert.equal(body.registered, true);
  assert.equal(body.balanceNano, '12500000000');
  assert.deepEqual(body.counted, { sinceRegistration: 6, counted: 5, lastCountedEpoch: 155 });
  // Two status reads of two distinct nodes, then one balance read; every read asks HTTPS, no redirect, no store.
  const statusCalls = calls.filter((c) => c.path.startsWith('/api/v1/light-node/status'));
  assert.equal(statusCalls.length, 2);
  assert.notEqual(statusCalls[0].host, statusCalls[1].host);
  for (const c of statusCalls) assert.equal(c.path, `/api/v1/light-node/status?node_id=${NODE}`);
  assert.equal(calls.filter((c) => c.path === `/api/v1/rewards/pending/${NODE}`).length, 1);
  for (const c of calls) {
    assert.equal(c.init.redirect, 'error');
    assert.equal(c.init.cache, 'no-store');
  }
  // The device tag and any other field of a node's answer never reach the page.
  assert.equal(JSON.stringify(body).includes('device_tag'), false);
  const featured = statusCalls.map((c) => c.host).includes(host(3));
  assert.deepEqual(body.features, featured ? ['bind_v2', 'uptime'] : ['bind_v2', 'consent_24h', 'uptime', 'wake']);
});

test('"no node" only when two nodes agree; one node or two that disagree is unreachable', async () => {
  const none = status({ onchain_registered: false, device_bound: false, answered_this_epoch: false, counted: { epochs_since_registration: 0, counted: 0, last_counted_epoch: null } });
  const agreed = await proxy(everyNode(reads(none))).p.status(get(), NODE);
  const body = await json(agreed);
  assert.equal(body.registered, false);
  assert.equal(body.balanceNano, null, 'no balance read for a node not on the chain');

  // Only one node answers.
  const lonely = { [host(1)]: reads(none) };
  assert.equal((await proxy(lonely).p.status(get(), NODE)).status, 503);
  // Two answer and disagree.
  const answers = { [host(1)]: reads(none), [host(2)]: reads(status()) };
  const disagree = await proxy(answers).p.status(get(), NODE);
  assert.equal(disagree.status, 503);
  assert.deepEqual(await json(disagree), { error: 'unavailable' });
});

// SITE-R4-01: every status answer carries `authoritative`, false while the answering node is behind the network height
// it cached; its "not registered" and "not pending" then settle nothing, and the client asks another node
// (docs/protocols/light-node-messages.md section 7). The proxy dropped the field and took the first two answers that
// agreed, so two genesis nodes catching up after a restart answered "no node" for a wallet that had one: the page burned
// for it and had the payment key sign the owner bind that pins the burn to that wallet.
const unlisted = (over = {}) => status({
  onchain_registered: false, device_bound: false, answered_this_epoch: false,
  counted: { epochs_since_registration: 0, counted: 0, last_counted_epoch: null }, ...over,
});
const behind = (over = {}) => unlisted({ authoritative: false, ...over });
const statusReads = (calls) => calls.filter((c) => c.path.startsWith('/api/v1/light-node/status')).map((c) => c.host);
// random() = 0.999 keeps each group of nodes in its order: the owners of NODE's light shard first (the one that wakes
// its device leading), then the rest; nth(1) is asked first.
const inOrder = { random: () => 0.999 };
const ASKED = [...lightShardOwners(NODE), ...[0, 1, 2, 3, 4].filter((i) => !lightShardOwners(NODE).includes(i))];
const nth = (n) => host(ASKED[n - 1] + 1);

// F13 (05.10): an answer reaches the other two owners of the node's light shard by one relay, which an owner that was
// down or restarting misses; then the first owner asked said "not answered" and Offline while the other two counted the
// device. "Answered this epoch" is now true when any owner listing the node says so, and "needs reactivation" (the
// device Offline) only when every one of them does; owners behind the network give way to the ones at its height.
test('answered and needs reactivation are the shard owners\' word: answered when any says so, Offline only when all do', async () => {
  const device = (state, last) => ({ platform: 'android', linked_since: 1_789_948_800, last_answer_epoch: last, state });
  const parsed = (over) => parsePublicStatus(status(over));
  const offline = parsed({ answered_this_epoch: false, needs_reactivation: true, device: device('offline', 150) });
  const relayed = parsed({ answered_this_epoch: true, needs_reactivation: false, device: device('online', 160) });
  const counted = parsed({ answered_this_epoch: false, needs_reactivation: false, device: device('online', 159) });
  // The owner asked first missed the relay; the backup that holds the answer counts: answered, Online, its epoch.
  let v = mergeStatus(offline, offline, null, [offline, relayed], [offline, relayed]);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state, v.device.lastAnswerEpoch], [true, false, 'online', 160]);
  assert.deepEqual(parseStatusView(v), v);
  // Every owner says the device needs to come back: Offline.
  v = mergeStatus(offline, offline, null, [], [offline, offline, offline]);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state, v.device.lastAnswerEpoch], [false, true, 'offline', 150]);
  // One owner counts it from the committed epochs, no answer yet this epoch: not Offline.
  v = mergeStatus(offline, counted, null, [], [offline, counted]);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state, v.device.lastAnswerEpoch], [false, false, 'online', 159]);
  // While owners answer, another genesis's word does not count: the first answer, from a non-owner, said answered.
  v = mergeStatus(relayed, offline, null, [relayed, offline], [offline]);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state, v.device.lastAnswerEpoch], [false, true, 'offline', 150]);
  // An owner behind the network reads an older epoch: the ones at its height decide; with only such owners, theirs.
  const lagging = parsed({ authoritative: false, answered_this_epoch: true, needs_reactivation: false, device: device('online', 140) });
  v = mergeStatus(offline, offline, null, [], [offline, lagging]);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state], [false, true, 'offline']);
  assert.equal(mergeStatus(offline, offline, null, [], [lagging]).answeredThisEpoch, true);
  // An owner that does not list the node has no word; with no owner's answer, the settling pair's.
  assert.equal(mergeStatus(offline, offline, null, [], [parsePublicStatus(unlisted())]).needsReactivation, true);
  v = mergeStatus(offline, relayed, null);
  assert.deepEqual([v.answeredThisEpoch, v.needsReactivation, v.device.state], [true, false, 'online']);
  // No device stays no device; a new device waiting for its first answer stays waiting while every owner asks it back.
  const unlinked = parsed({ device_bound: false, answered_this_epoch: false, needs_reactivation: true, device: { ...device('unlinked', null), platform: null } });
  assert.equal(mergeStatus(unlinked, unlinked, null, [], [unlinked, relayed]).device.state, 'unlinked');
  const fresh = parsed({ answered_this_epoch: false, needs_reactivation: true, device: device('other_device_pending', null) });
  assert.equal(mergeStatus(fresh, fresh, null, [], [fresh, offline]).device.state, 'other_device_pending');
  assert.equal(mergeStatus(fresh, fresh, null, [], [fresh, relayed]).device.state, 'online');

  // Through the route: the owner that wakes the device missed the relay, the second owner holds the answer.
  const read = (s) => reads(s);
  const missed = proxy({ [nth(1)]: read(status({ answered_this_epoch: false, needs_reactivation: true, device: device('offline', 150) })), [nth(2)]: read(status({ device: device('online', 160) })) }, inOrder);
  let body = await json(await missed.p.status(get(), NODE));
  assert.deepEqual([body.answeredThisEpoch, body.needsReactivation, body.device.state], [true, false, 'online']);
  assert.deepEqual(statusReads(missed.calls), [nth(1), nth(2)], 'Online: no third read');
  // The two owners asked call it Offline: the third is asked once, and it holds the answer.
  const off = status({ answered_this_epoch: false, needs_reactivation: true, device: device('offline', 150) });
  const third = proxy({ [nth(1)]: read(off), [nth(2)]: read(off), [nth(3)]: read(status({ device: device('online', 160) })), [nth(4)]: read(off) }, inOrder);
  body = await json(await third.p.status(get(), NODE));
  assert.deepEqual([body.answeredThisEpoch, body.device.state, body.device.lastAnswerEpoch], [true, 'online', 160]);
  assert.deepEqual(statusReads(third.calls), [nth(1), nth(2), nth(3)]);
  // All three say Offline: Offline, after the three owners and no other genesis.
  const all = proxy(everyNode(read(off)), inOrder);
  body = await json(await all.p.status(get(), NODE));
  assert.deepEqual([body.answeredThisEpoch, body.needsReactivation, body.device.state], [false, true, 'offline']);
  assert.deepEqual(statusReads(all.calls), [nth(1), nth(2), nth(3)]);
  // The owner that wakes the device is down: its two backups settle it, and either one's answer counts.
  const down = proxy({ [nth(2)]: read(off), [nth(3)]: read(status({ device: device('online', 160) })), [nth(4)]: read(off) }, inOrder);
  body = await json(await down.p.status(get(), NODE));
  assert.deepEqual([body.answeredThisEpoch, body.device.state], [true, 'online']);
  assert.deepEqual(statusReads(down.calls), [nth(1), nth(2), nth(3)]);
});

test('a "no" from nodes behind the network settles nothing: the proxy asks on, and 503 when no two authoritative nodes say it', async () => {
  // Only the two nodes behind the network answer: not known, never "no node".
  const lagging = proxy({ [nth(1)]: reads(behind()), [nth(2)]: reads(behind()) }, inOrder);
  const res = await lagging.p.status(get(), NODE);
  assert.equal(res.status, 503);
  assert.deepEqual(await json(res), { error: 'unavailable' });
  assert.deepEqual(statusReads(lagging.calls), [nth(1), nth(2), nth(3), nth(4), nth(5)], 'every remaining node was asked');
  // One authoritative "no" beside them is one node's word, not two.
  const one = proxy({ [nth(1)]: reads(behind()), [nth(2)]: reads(behind()), [nth(3)]: reads(unlisted()) }, inOrder);
  assert.equal((await one.p.status(get(), NODE)).status, 503);
  assert.deepEqual(statusReads(one.calls), [nth(1), nth(2), nth(3), nth(4), nth(5)]);
  // Two authoritative ones, asked after the two behind: no node.
  const table = { [nth(1)]: reads(behind()), [nth(2)]: reads(behind()), [nth(3)]: reads(unlisted({ authoritative: true })), [nth(4)]: reads(unlisted()) };
  const settled = proxy(table, inOrder);
  const body = await json(await settled.p.status(get(), NODE));
  assert.equal(body.registered, false);
  assert.equal(body.pending, false);
  assert.deepEqual(statusReads(settled.calls), [nth(1), nth(2), nth(3), nth(4)]);
});

test('the wallet\'s node while the first two nodes asked are behind: the others are asked and the node is registered', async () => {
  const table = { [nth(1)]: reads(behind()), [nth(2)]: reads(behind()), [nth(3)]: reads(status()), [nth(4)]: reads(status()), [nth(5)]: reads(status()) };
  const { p, calls } = proxy(table, inOrder);
  const res = await p.status(get(), NODE);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.registered, true);
  assert.equal(body.balanceNano, '12500000000');
  assert.deepEqual(statusReads(calls), [nth(1), nth(2), nth(3), nth(4)]);
  assert.deepEqual(calls.filter((c) => c.path.startsWith('/api/v1/rewards/pending/')).map((c) => c.host), [nth(3)], 'the balance of a node that listed it');
  // A node behind the network that lists the node is right about it: listing answers settle whatever their height.
  const listedBehind = proxy({ [nth(1)]: reads(status({ authoritative: false })), [nth(2)]: reads(status()) }, inOrder);
  assert.equal((await json(await listedBehind.p.status(get(), NODE))).registered, true);
});

test('a node that lists it vetoes "no node"; a registration on its way that a node behind saw still counts', async () => {
  // One listing answer, the rest authoritative "no": the nodes disagree on the chain, so nothing is known.
  const table = { [nth(1)]: reads(status()), [nth(2)]: reads(unlisted()), [nth(3)]: reads(unlisted()), [nth(4)]: reads(unlisted()), [nth(5)]: reads(unlisted()) };
  const veto = proxy(table, inOrder);
  assert.equal((await veto.p.status(get(), NODE)).status, 503);
  assert.deepEqual(statusReads(veto.calls), [nth(1), nth(2), nth(3), nth(4), nth(5)], 'asked on for a second listing answer');
  // A node behind that holds the registration in its pending set: the node is being recorded.
  const pending = proxy({ [nth(1)]: reads(behind({ registration_pending: true })), [nth(2)]: reads(unlisted()), [nth(3)]: reads(unlisted()) }, inOrder);
  const body = await json(await pending.p.status(get(), NODE));
  assert.equal(body.registered, false);
  assert.equal(body.pending, true);
});

test('the settling rule itself: parse, pair, how many more to ask, and no merge of what it does not settle', () => {
  const parsed = (over) => parsePublicStatus(status(over));
  // A node from before the field is authoritative; anything but a boolean is a bad answer.
  assert.equal(parsed({}).authoritative, true);
  assert.equal(parsed({ authoritative: true }).authoritative, true);
  assert.equal(parsed({ authoritative: false }).authoritative, false);
  for (const bad of [null, 'false', 0, 1, {}]) assert.equal(parsed({ authoritative: bad }), null, JSON.stringify(bad));
  const yes = parsed({});
  const no = parsePublicStatus(unlisted());
  const lag = parsePublicStatus(behind());
  assert.equal(settlingPair([lag, lag]), null);
  assert.equal(settlingPair([lag, no]), null);
  assert.deepEqual(settlingPair([lag, no, no]), [no, no]);
  assert.equal(settlingPair([yes, no, no]), null, 'a listing answer leaves only "registered" to settle');
  assert.deepEqual(settlingPair([no, yes, lag, yes]), [yes, yes]);
  assert.equal(stillNeeded([]), 2);
  assert.equal(stillNeeded([lag, lag]), 2);
  assert.equal(stillNeeded([lag, no]), 1);
  assert.equal(stillNeeded([yes, no]), 1);
  // mergeStatus refuses what settlingPair would not settle.
  assert.equal(mergeStatus(lag, no, null), null);
  assert.equal(mergeStatus(no, lag, null), null);
  assert.equal(mergeStatus(no, no, null, [no, no, yes]), null);
  assert.equal(mergeStatus(no, no, null, [no, no]).registered, false);
  assert.equal(mergeStatus(no, no, null, [parsePublicStatus(behind({ registration_pending: true })), no, no]).pending, true);
  assert.equal(mergeStatus(yes, parsed({ authoritative: false }), '5').registered, true);
});

test('a node that fails, answers badly or in the old shape is passed over for the next one', async () => {
  const table = {
    [host(1)]: () => 500,
    [host(2)]: () => '{not json',
    [host(3)]: reads({ onchain_registered: true, is_active: true, needs_reactivation: false }),
    [host(4)]: reads(status()),
    [host(5)]: reads(status()),
  };
  const { p, calls } = proxy(table, { random: () => 0.999 });
  const res = await p.status(get(), NODE);
  assert.equal(res.status, 200);
  assert.ok(calls.filter((c) => c.path.startsWith('/api/v1/light-node/status')).length >= 2);
  // No second good node: unreachable.
  const bad = proxy({ ...table, [host(5)]: () => 404 }).p;
  assert.equal((await bad.status(get(), NODE)).status, 503);
});

test('the balance: from either agreeing node, null when neither gives it', async () => {
  const table = everyNode(reads(status(), 500));
  const res = await proxy(table).p.status(get(), NODE);
  assert.equal((await json(res)).balanceNano, null);
  const odd = everyNode(reads(status(), { pending_rewards_nano: -1 }));
  assert.equal((await json(await proxy(odd).p.status(get(), NODE))).balanceNano, null);
});

test('status answers are cached per node for a few seconds and share one upstream round', async () => {
  const { p, calls, advance } = proxy(everyNode(reads(status())));
  const [a, b] = await Promise.all([p.status(get(), NODE), p.status(get(), NODE)]);
  assert.deepEqual(await json(a), await json(b));
  const first = calls.length;
  assert.equal(first, 3, 'two status reads and one balance read for both');
  await p.status(get(), NODE);
  assert.equal(calls.length, first, 'cached');
  advance(STATUS_CACHE_MS);
  await p.status(get(), NODE);
  assert.equal(calls.length, first * 2);
  // A failure is not cached: the next reader asks again.
  const down = proxy({});
  await down.p.status(get(), NODE);
  await down.p.status(get(), NODE);
});

test('only a light node id: anything else is 400 before a node is asked', async () => {
  const { p, calls } = proxy(everyNode(reads(status())));
  for (const id of ['light_mobile_6526AB8FD00FF8CA', 'light_mobile_6526ab8fd00ff8c', 'super_node_1', '../status', `${NODE}?x=1`, '']) {
    const res = await p.status(get(), id);
    assert.equal(res.status, 400, id);
    assert.deepEqual(await json(res), { error: 'invalid_request' });
    assert.equal((await p.history(get(), id)).status, 400, id);
  }
  assert.equal(calls.length, 0);
});

// The wallet whose light node NODE is (lightNodeId).
const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
// The key the network settles epoch N under (src/lib/cabinet/epochs.ts), and the block the epoch ends with.
const key = (epoch) => 160 * (epoch + 1);
const endOf = (epoch) => (epoch + 1) * 14_400;
const TX = (c) => c.repeat(64);

test('epochs: key 160 * (N + 1) settles epoch N, blocks N * 14,400 to (N + 1) * 14,400; anything else is no key', () => {
  assert.deepEqual(epochOfKey(160), { epoch: 0, start: 0, end: 14_400 });
  assert.deepEqual(epochOfKey(key(156)), { epoch: 156, start: 156 * 14_400, end: 157 * 14_400 });
  for (const bad of [0, 1, 159, 161, 320.5, -160, Number.MAX_SAFE_INTEGER + 1]) assert.equal(epochOfKey(bad), null, String(bad));
  assert.equal(epochOfHeight(14_399), 0);
  assert.equal(epochOfHeight(14_400), 1);
});

test('the history: every epoch a node settled, a second node for the ones the first could not serve, the archive for dates and moves', async () => {
  const first = {
    node_id: NODE,
    wallet: WALLET,
    last_claimed_epoch: key(150),
    history: [
      { epoch: key(156), status: 'claimable', amount_qnc: 1.25, shard_certified: null },
      { epoch: key(155), status: 'not_eligible', amount_qnc: 0, shard_certified: true },
      { epoch: key(154), status: 'unavailable', amount_qnc: 0, shard_certified: null },
      { epoch: key(153), status: 'shard_not_certified', amount_qnc: 0, shard_certified: false },
      { epoch: key(152), status: 'a_status_to_come', amount_qnc: 0 },
      { epoch: key(151), status: 'unavailable', amount_qnc: 0, shard_certified: null },
      { epoch: key(150), status: 'claimed', amount_qnc: 2, shard_certified: null },
      { epoch: 100, status: 'claimable', amount_qnc: 9 },
    ],
  };
  // Another node serves epoch 154 (and not 151).
  const second = { ...first, history: first.history.map((r) => (r.epoch === key(154) ? { ...r, status: 'claimed', amount_qnc: 0.5 } : r)) };
  const table = everyNode((path) => (path.startsWith('/api/v1/rewards/history/') ? second : undefined));
  table[host(1)] = (path) => (path.startsWith('/api/v1/rewards/history/') ? first : undefined);
  const asked = [];
  const archive = async (wallet, nodeId, keys) => {
    asked.push({ wallet, nodeId, keys });
    return {
      registeredHeight: 140 * 14_400 + 500,
      claims: new Map([[key(154), { tx: TX('a'), amountNano: '500000000' }], [key(150), { tx: TX('b'), amountNano: '2000000000' }], [key(142), { tx: TX('c'), amountNano: '3500000000' }], [key(120), { tx: TX('d'), amountNano: '1' }]]),
      times: new Map([[endOf(156), 1_790_000_000_000], [endOf(142), 1_789_000_000_000]]),
    };
  };
  const { p, calls, advance } = proxy(table);
  const res = await p.history(get(`${BASE}/history`), NODE, archive);
  assert.equal(res.status, 200);
  const body = await json(res);
  const row = (epoch, result, amountQnc = null, claimTx = null, endedAt = null) => ({ epoch, result, amountQnc, endedAt, claimTx });
  assert.deepEqual(body, {
    registeredEpoch: 140,
    archived: true,
    rows: [
      row(156, 'counted', 1.25, null, 1_790_000_000_000),
      row(155, 'missed'),
      row(154, 'moved', 0.5, TX('a')),
      row(153, 'unchecked'),
      row(151, 'unknown'),
      row(150, 'moved', 2, TX('b')),
    ],
    // Older than the nodes' oldest epoch, from the registration on: the archive's moves.
    earlier: [row(142, 'moved', 3.5, TX('c'), 1_789_000_000_000)],
  });
  assert.deepEqual(parseHistoryView(body), body);
  assert.equal(JSON.stringify(body).includes('eon'), false, 'the wallet the node names is not passed on');
  // Two nodes, a page of 100 epochs each (neither has more); the archive for the wallet the nodes name, which is the node's.
  assert.deepEqual(calls.map((c) => c.path), [`/api/v1/rewards/history/${NODE}?limit=100`, `/api/v1/rewards/history/${NODE}?limit=100`]);
  assert.deepEqual(asked, [{ wallet: WALLET, nodeId: NODE, keys: first.history.filter((r) => r.status !== 'a_status_to_come').map((r) => r.epoch) }]);
  await p.history(get(`${BASE}/history`), NODE, archive);
  assert.equal(calls.length, 2, 'cached');
  advance(30_000);
  await p.history(get(`${BASE}/history`), NODE, archive);
  assert.equal(calls.length, 4);
  assert.equal((await proxy({}).p.history(get(`${BASE}/history`), NODE)).status, 503);
});

test('the history without the archive, or for a wallet that is not the node\'s: undated, nothing left out, one node when it serves all', async () => {
  const answer = { node_id: NODE, wallet: WALLET, history: [{ epoch: key(10), status: 'not_eligible', amount_qnc: 0 }, { epoch: key(9), status: 'claimed', amount_qnc: 1 }] };
  const { p, calls } = proxy(everyNode((path) => (path.startsWith('/api/v1/rewards/history/') ? answer : undefined)));
  let archived = 0;
  const failing = async () => {
    archived += 1;
    throw new Error('db');
  };
  const body = await json(await p.history(get(`${BASE}/history`), NODE, failing));
  assert.deepEqual(body, {
    registeredEpoch: null,
    archived: false,
    rows: [{ epoch: 10, result: 'missed', amountQnc: null, endedAt: null, claimTx: null }, { epoch: 9, result: 'moved', amountQnc: 1, endedAt: null, claimTx: null }],
    earlier: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(archived, 1);
  // A node that names another wallet: the archive is not asked.
  const body19 = `${'1'.repeat(19)}eon${'2'.repeat(15)}`;
  const otherWallet = `${body19}${jsSha3.sha3_256(body19).slice(0, 8)}`;
  const other = proxy(everyNode((path) => (path.startsWith('/api/v1/rewards/history/') ? { ...answer, wallet: otherWallet } : undefined)));
  await other.p.history(get(`${BASE}/history`), NODE, failing);
  assert.equal(archived, 1);
});

// S10, 04.10: a node from before the cabinet has more epochs than one page: its older pages are read, up to four, for the
// wallet the id derives from; a made-up id costs one read per node.
test('the history of an older node: its older pages with offset, while the node has more, for the node\'s own wallet only', async () => {
  const page = (offset, more, wallet = WALLET) => ({
    node_id: NODE, wallet,
    pagination: { offset, limit: 100, total_epochs: 350, has_more: more },
    history: Array.from({ length: offset === 300 ? 50 : 100 }, (_, i) => ({ epoch: key(400 - offset - i), status: 'claimable', amount_qnc: 1 })),
  });
  const answer = (path) => {
    if (!path.startsWith('/api/v1/rewards/history/')) return undefined;
    const offset = Number(new URL(path, 'https://x').searchParams.get('offset') ?? 0);
    return page(offset, offset < 300);
  };
  const { p, calls } = proxy(everyNode(answer));
  const body = await json(await p.history(get(`${BASE}/history`), NODE));
  assert.equal(body.rows.length, 350);
  assert.equal(body.rows[0].epoch, 400);
  assert.equal(body.rows[349].epoch, 51);
  assert.deepEqual(calls.map((c) => c.path), [0, 100, 200, 300].map((o) => `/api/v1/rewards/history/${NODE}?limit=100${o ? `&offset=${o}` : ''}`));
  assert.deepEqual(parseHistoryView(body), body);
  // A node that names no wallet for the id (a made-up one): one page, no more.
  const made = proxy(everyNode((path) => (path.startsWith('/api/v1/rewards/history/') ? { ...page(0, true), wallet: '' } : undefined)));
  await made.p.history(get(`${BASE}/history`), NODE);
  assert.equal(made.calls.filter((c) => c.path.includes('offset=')).length, 0);
});

test('the epochs from the registration on: its own epoch, not counted, is marked; the archive\'s older moves follow', () => {
  const node = { wallet: WALLET, rows: [key(12), key(11), key(10), key(9)].map((k, i) => ({ key: k, status: i === 0 ? 'claimable' : 'not_eligible', amountQnc: i === 0 ? 1 : 0 })) };
  const facts = {
    registeredHeight: 10 * 14_400 + 7_000,
    claims: new Map([[key(8), { tx: TX('e'), amountNano: '1' }], [key(12), { tx: TX('f'), amountNano: '1000000000' }]]),
    times: new Map(),
  };
  const view = historyView(node, facts);
  assert.deepEqual(view.rows.map((r) => [r.epoch, r.result]), [[12, 'counted'], [11, 'missed'], [10, 'joined']]);
  assert.equal(view.rows[0].claimTx, null, 'counted, not moved: no move');
  assert.deepEqual(view.earlier, [], 'the move of epoch 8 is from before the registration');
  assert.equal(view.registeredEpoch, 10);
  // A counted epoch the node reports and the archive lists as moved is still what the node says.
  assert.deepEqual(historyView({ wallet: WALLET, rows: [] }, { registeredHeight: null, claims: new Map([[key(3), { tx: TX('g'), amountNano: null }]]), times: new Map() }).earlier,
    [{ epoch: 3, result: 'moved', amountQnc: null, endedAt: null, claimTx: TX('g') }]);
  // A second node's answer fills only what the first could not serve, and only for the same wallet.
  const a = { wallet: WALLET, rows: [{ key: key(2), status: 'unavailable', amountQnc: 0 }, { key: key(1), status: 'claimable', amountQnc: 1 }] };
  const b = { wallet: WALLET, rows: [{ key: key(2), status: 'claimed', amountQnc: 3 }, { key: key(1), status: 'not_eligible', amountQnc: 0 }] };
  assert.deepEqual(mergeHistory(a, b).rows, [{ key: key(2), status: 'claimed', amountQnc: 3 }, { key: key(1), status: 'claimable', amountQnc: 1 }]);
  assert.equal(mergeHistory(a, { ...b, wallet: null }), a);
});

test('the archive: the registration row of the node, the moves to the wallet with their epochs, the block times', async () => {
  assert.match(CLAIMS_SQL, /WHERE to_address = \$1 AND tx_type = 'RewardDistribution' AND from_address = 'system_rewards_pool'\s+ORDER BY block DESC, tx_index DESC LIMIT 32/);
  assert.match(TIMES_SQL, /FROM blocks WHERE height = ANY\(\$1::bigint\[\]\)/);
  const rows = [
    { block: '9', data: { node_id: 'light_mobile_0000000000000000', node_type: 'Light' } },
    { block: '8', data: { node_id: NODE, node_type: 'Super' } },
    { block: '7', data: { node_id: NODE, node_type: 'Light' } },
    { block: '6', data: { node_id: NODE, node_type: 'Light' } },
  ];
  assert.equal(registrationHeight(NODE, rows), 7);
  assert.equal(registrationHeight(NODE, [{ block: 'x', data: { node_id: NODE, node_type: 'Light' } }, { block: 5, data: null }]), null);
  // A move's payload, whole or cut short by the archive; amounts stay exact.
  const payload = JSON.stringify({ claims: [{ amount: 18446744073709551615, epoch: key(4), proof: [['ab', true]] }, { epoch: key(5), amount: 2, proof: [] }] }).replace('18446744073709552000', '18446744073709551615');
  assert.deepEqual(movedEpochs(payload), [{ key: key(4), amountNano: '18446744073709551615' }, { key: key(5), amountNano: '2' }]);
  assert.deepEqual(movedEpochs(payload.slice(0, payload.indexOf(`"epoch":${key(5)}`))), [{ key: key(4), amountNano: '18446744073709551615' }]);
  assert.deepEqual(movedEpochs(null), []);
  assert.deepEqual(movedEpochs('{"claims":[{"epoch":1600}]}'), [{ key: 1600, amountNano: null }]);
  const claims = claimsFrom([
    { hash: TX('1'), data: JSON.stringify({ claims: [{ epoch: key(6), amount: 5 }, { epoch: 7, amount: 1 }] }) },
    { hash: TX('2'), data: JSON.stringify({ claims: [{ epoch: key(6), amount: 4 }, { epoch: key(5), amount: 3 }] }) },
    { hash: 'bad hash!', data: JSON.stringify({ claims: [{ epoch: key(1), amount: 1 }] }) },
  ]);
  assert.deepEqual([...claims], [[key(6), { tx: TX('1'), amountNano: '5' }], [key(5), { tx: TX('2'), amountNano: '3' }]]);
  assert.deepEqual([...timesFrom([{ height: '14400', ts: '1790000000000' }, { height: 'x', ts: '1' }, { height: '28800', ts: '0' }])], [[14_400, 1_790_000_000_000]]);
  // Three reads: the registration and the moves by the wallet, then the times of the epochs' ends.
  const queries = [];
  const query = async (text, params) => {
    queries.push({ text, params });
    if (text === RECORD_SQL) return { rows: [{ block: '1000', data: { node_id: NODE, node_type: 'Light' } }] };
    if (text === CLAIMS_SQL) return { rows: [{ hash: TX('3'), block: '2000', data: JSON.stringify({ claims: [{ epoch: key(2), amount: 7 }] }) }] };
    return { rows: [{ height: String(endOf(2)), ts: '1790000000000' }] };
  };
  const facts = await createEpochArchive(query)(WALLET, NODE, [key(3), key(2), 5]);
  assert.deepEqual(queries.map((q) => q.params), [[WALLET], [WALLET], [[endOf(3), endOf(2)]]]);
  assert.deepEqual(facts, { registeredHeight: 1000, claims: new Map([[key(2), { tx: TX('3'), amountNano: '7' }]]), times: new Map([[endOf(2), 1_790_000_000_000]]) });
  // Nothing to date: no third read.
  const none = [];
  await createEpochArchive(async (text, params) => {
    none.push(params);
    return { rows: [] };
  })(WALLET, NODE, []);
  assert.equal(none.length, 2);
});

test('the parsers take only the fields they know, in their forms', () => {
  assert.equal(parsePublicStatus(null), null);
  assert.equal(parsePublicStatus({ ...status(), device_bound: 'yes' }), null);
  assert.equal(parsePublicStatus({ ...status(), counted: { epochs_since_registration: 2, counted: 3, last_counted_epoch: 1 } }), null);
  assert.equal(parsePublicStatus({ ...status(), counted: { epochs_since_registration: 2, counted: 1, last_counted_epoch: -1 } }), null);
  assert.equal(parsePublicStatus({ ...status(), features: ['Bind'] }), null);
  assert.equal(parsePublicStatus({ ...status(), features: 'bind_v2' }), null);
  assert.deepEqual(parsePublicStatus(status()).counted, { epochs_since_registration: 6, counted: 5, last_counted_epoch: 155 });
  assert.equal(parsePending({ pending_rewards_nano: 1.5 }), null);
  assert.equal(parsePending({ pending_rewards_nano: 2 ** 53 }), null);
  assert.equal(parsePending({ pending_rewards_nano: 0 }), '0');
  assert.equal(parseHistory({ history: [{ epoch: 1, status: 'claimed', amount_qnc: -1 }] }), null);
  assert.equal(parseHistory({ history: 'x' }), null);
  assert.equal(mergeStatus(parsePublicStatus(status()), parsePublicStatus(status({ onchain_registered: false })), null), null);
  // The page refuses anything but the route's exact shape.
  const view = mergeStatus(parsePublicStatus(status()), parsePublicStatus(status()), '1');
  assert.deepEqual(parseStatusView(view), view);
  assert.equal(parseStatusView({ ...view, extra: 1 }), null);
  assert.equal(parseStatusView({ ...view, balanceNano: 1 }), null);
  assert.equal(parseStatusView({ ...view, balanceNano: '01' }), null);
  const epochs = { registeredEpoch: 3, archived: true, rows: [{ epoch: 4, result: 'missed', amountQnc: null, endedAt: 1, claimTx: null }], earlier: [] };
  assert.deepEqual(parseHistoryView(epochs), epochs);
  for (const bad of [
    { ...epochs, extra: 1 },
    { ...epochs, archived: 'yes' },
    { ...epochs, registeredEpoch: -1 },
    { ...epochs, rows: [{ ...epochs.rows[0], result: 'not_counted' }] },
    { ...epochs, rows: [{ ...epochs.rows[0], endedAt: -5 }] },
    { ...epochs, rows: [{ ...epochs.rows[0], amountQnc: -1 }] },
    { ...epochs, rows: [{ ...epochs.rows[0], claimTx: '<b>' }] },
    { ...epochs, earlier: [{ epoch: 1 }] },
    { lastClaimedEpoch: 1, rows: [] },
  ]) {
    assert.equal(parseHistoryView(bad), null, JSON.stringify(bad));
  }
});

test('the gate: origins first, then a per-client limit of the route; a client IP is required', async () => {
  const counted = [];
  const gate = createGate({
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.7' }),
    limit: (id, max) => { counted.push(id); return { allowed: counted.length <= max, remaining: 0, resetTime: 30_000 }; },
    now: () => 0,
    scope: 'gate',
    devOrigins: false,
  });
  for (const site of ['cross-site', 'same-site', 'none']) {
    const res = gate(get(BASE, { 'sec-fetch-site': site }), 'node');
    assert.equal(res.status, 403, site);
  }
  assert.equal(gate(get(BASE, { origin: 'https://evil.example' }), 'node').status, 403);
  assert.deepEqual(counted, [], 'refused before any limit counts it');
  assert.equal(gate(get(BASE, { 'sec-fetch-site': 'same-origin' }), 'node'), null);
  for (let i = 1; i < CABINET_LIMITS.node.max; i += 1) assert.equal(gate(get(), 'node'), null);
  const limited = gate(get(), 'node');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.deepEqual(counted.at(-1), 'gate:node:203.0.113.7');
  const noIp = createGate({ clientKey: () => ({ ok: false, reason: 'none' }), devOrigins: false });
  assert.equal(noIp(get(), 'node').status, 503);
});

test('the routes are thin: every read goes through the proxy, which logs nothing', () => {
  const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  for (const [file, call] of [['app/api/cabinet/node/[id]/route.ts', 'status\\(request, id\\)'], ['app/api/cabinet/node/[id]/history/route.ts', 'history\\(request, id, archive\\)']]) {
    const text = src(file);
    assert.match(text, /export const runtime = 'nodejs';/);
    assert.match(text, /export const dynamic = 'force-dynamic';/);
    assert.match(text, new RegExp(`return nodeProxy\\(\\)\\.${call};`));
  }
  // The history's archive reads the explorer database with the read side's one pool.
  assert.match(src('app/api/cabinet/node/[id]/history/route.ts'), /const archive = createEpochArchive\(\(text, params\) => query\(text, params\)\);/);
  assert.doesNotMatch(src('server/cabinet/epoch-archive.ts'), /console\./);
  for (const file of ['server/cabinet/node-proxy.ts', 'server/cabinet/limits.ts']) assert.doesNotMatch(src(file), /console\./, file);
});

// SITE-R2-09: every cabinet read and write goes to the five genesis nodes, and the explorer server may be on their
// whitelist, which skips their own per-address limits. However many clients ask, each genesis node now gets at most
// UPSTREAM_BUDGETS reads (and submits, and wakes) a second from the site; a call beyond it is not made and counts as that
// node not answering. The kinds are kept apart, so reads cannot starve a registration or a wake.
test('each genesis node gets a bounded number of calls a second from the site, whatever the clients do', async () => {
  let t = 1_000_000;
  const now = () => t;
  const net = network(everyNode(reads(status({ onchain_registered: false }))));
  const p = createNodeProxy({
    fetchFn: net.fetchFn, now, budget: createUpstreamBudget({ now }), scope: `cabinet${(scopes += 1)}`, devOrigins: false,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') }), known: createKnownNodes({ now }),
  });
  // Two hundred light node ids nobody saw registered, from two hundred clients within one second: the small budget of
  // unknown ids only.
  const ids = Array.from({ length: 200 }, (_, i) => `light_mobile_${i.toString(16).padStart(16, '0')}`);
  const answers = await Promise.all(ids.map((id, i) => p.status(get(`https://aiqnet.io/api/cabinet/node/${id}`, { 'x-test-ip': `198.51.${i >> 8}.${i & 255}` }), id)));
  const perHost = {};
  for (const c of net.calls) perHost[c.host] = (perHost[c.host] ?? 0) + 1;
  assert.deepEqual(Object.values(perHost), Array(5).fill(UPSTREAM_BUDGETS.readUnknown.max), JSON.stringify(perHost));
  const served = answers.filter((r) => r.status === 200).length;
  assert.ok(served > 0 && served <= (5 * UPSTREAM_BUDGETS.readUnknown.max) / 2, `${served} served`);
  assert.equal(answers.filter((r) => r.status === 503).length, 200 - served, 'the rest: the network could not be reached');
  // The next second the nodes are asked again.
  t += UPSTREAM_BUDGETS.readUnknown.windowMs;
  const later = `light_mobile_${'f'.repeat(16)}`;
  assert.equal((await p.status(get(`https://aiqnet.io/api/cabinet/node/${later}`, { 'x-test-ip': '192.0.2.200' }), later)).status, 200);
  // The kinds are budgeted apart, per node.
  const budget = createUpstreamBudget({ now });
  for (let i = 0; i < UPSTREAM_BUDGETS.readUnknown.max; i += 1) assert.equal(budget('readUnknown', 'https://node1.aiqnet.io/x'), true);
  assert.equal(budget('readUnknown', 'https://node1.aiqnet.io/y'), false);
  assert.equal(budget('readKnown', 'https://node1.aiqnet.io/y'), true, 'unknown ids leave the known ones their budget');
  assert.equal(budget('readUnknown', 'https://node2.aiqnet.io/y'), true);
  assert.equal(budget('submit', 'https://node1.aiqnet.io/submit'), true);
  assert.equal(budget('wake', 'https://node1.aiqnet.io/wake'), true);
  // A reservation's check that the wallet has no node has a budget of its own (audit M6).
  assert.equal(budget('reserve', 'https://node1.aiqnet.io/x'), true);
  assert.equal(budget('readKnown', 'not a url'), false);
  assert.deepEqual(UPSTREAM_BUDGETS, {
    readKnown: { max: 16, windowMs: 1_000 }, readUnknown: { max: 4, windowMs: 1_000 }, reserve: { max: 10, windowMs: 1_000 }, submit: { max: 2, windowMs: 1_000 },
    wake: { max: 2, windowMs: 1_000 },
  });
  assert.equal(UPSTREAM_BUDGETS.readKnown.max + UPSTREAM_BUDGETS.readUnknown.max, 20, 'a genesis node is asked no more than before');
  // The process's routes share one budget.
  const src = (name) => readFileSync(new URL(`../../server/cabinet/${name}`, import.meta.url), 'utf8');
  assert.match(src('node-proxy.ts'), /createNodeProxy\(\{ gate: cabinetGate\(\), budget: sharedUpstreamBudget\(\) \}\)/);
  assert.match(src('register.ts'), /createRegister\(\{ gate: cabinetGate\(\), budget: sharedUpstreamBudget\(\), verifyConsent, paymentRecord, \.\.\.own \}\)/);
  assert.match(src('wallet-node.ts'), /createWalletNode\(\{ gate: cabinetGate\(\), budget: sharedUpstreamBudget\(\) \}\)/);
  assert.match(src('wallet-node.ts'), /const url = `\$\{base\}\/api\/v1\/verify-activation`;\s*if \(!budget\(kind, url\)\) return null;/);
  assert.match(src('activation-api.ts'), /walletNode: \(wallet\) => sharedWalletNode\(\)\.check\(wallet, 'reserve'\)/);
  assert.match(src('wake.ts'), /createWake\(\{ gate: cabinetGate\(\), budget: sharedUpstreamBudget\(\) \}\)/);
  assert.match(src('node-proxy.ts'), /async function read\(url: string, kind: UpstreamKind\): Promise<unknown> \{\s*if \(!budget\(kind, url\)\) return null;/);
});
// R4: a super node's status for My node: one node that lists it registered answers "yes" with its details; "no" needs
// two nodes; the balance from rewards/pending; a last-seen time from the nodes, else the archive's newest heartbeat;
// a reputation below the floor bars it. The answer's shape is exact, and only a super node id is taken.
test('the super node status: a yes from one node, a no from two, last seen, heartbeats, the bar and the balance', async () => {
  const { parseServerStatus, REPUTATION_FLOOR } = await import('../../server/cabinet/node-proxy.ts');
  const { parseSuperStatus } = await import('../cabinet/node-view.ts');
  const { superNodeId } = await import('../qnet-link.ts');
  const { LAST_HEARTBEAT_SQL, createLastHeartbeat, lastHeartbeatFrom } = await import('../../server/cabinet/epoch-archive.ts');
  const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const ID = superNodeId(WALLET);
  const server = (over = {}) => ({
    success: true, registered: true, onchain_registered: true, node_id: ID, node_type: 'Super', is_online: true, last_seen: 1_790_000_000,
    heartbeat_count: 7, required_heartbeats: 9, reputation: 70, pending_rewards: 2_500_000_000, ...over,
  });
  const at = (s) => (path) => (path.startsWith('/api/v1/node/status') ? s : path.startsWith('/api/v1/rewards/pending/') ? { pending_rewards_nano: 2_500_000_000 } : undefined);
  const url = `https://aiqnet.io/api/cabinet/super/${ID}`;
  const { p, calls } = proxy(everyNode(at(server())));
  const yes = await json(await p.superStatus(get(url), ID));
  assert.deepEqual(yes, { registered: true, online: true, lastSeenAt: 1_790_000_000_000, heartbeats: { current: 7, required: 9 }, banned: false, balanceNano: '2500000000' });
  assert.deepEqual(parseSuperStatus(yes), yes);
  assert.equal(calls.filter((c) => c.path.startsWith('/api/v1/node/status')).length, 2, 'two asked at once, one yes is enough');
  // Not registered: two nodes say so.
  const none = proxy(everyNode(at(server({ registered: false, onchain_registered: false, is_online: false, last_seen: 0, reputation: null }))));
  assert.deepEqual(await json(await none.p.superStatus(get(url), ID)), { registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null });
  // One node answering "no" and the rest unreachable settles nothing.
  const lone = proxy({ [host(1)]: at(server({ registered: false, onchain_registered: false })) });
  assert.equal((await lone.p.superStatus(get(url), ID)).status, 503);
  // No last-seen time from the nodes: the archive's newest heartbeat; a barred node.
  const offline = proxy(everyNode(at(server({ is_online: false, last_seen: 0, reputation: 0 }))));
  const got = await json(await offline.p.superStatus(get(url), ID, async (id) => (id === ID ? 1_789_000_000_000 : null)));
  assert.equal(got.lastSeenAt, 1_789_000_000_000);
  assert.equal(got.online, false);
  assert.equal(got.banned, true);
  assert.equal(REPUTATION_FLOOR, 70);
  // Only a super node id (or a genesis node's), and the gate.
  for (const bad of ['light_mobile_6526ab8fd00ff8ca', 'super_node_XYZ', 'genesis_node_009']) assert.equal((await p.superStatus(get(url), bad)).status, 400, bad);
  assert.equal((await p.superStatus(get(url), 'genesis_node_001')).status, 200);
  assert.equal((await p.superStatus(get(url, { origin: 'https://evil.example' }), ID)).status, 403);
  assert.deepEqual(CABINET_LIMITS.super, { max: 120, windowMs: 60_000 });
  // The nodes' answer as read: an error answer or a missing field is none.
  assert.equal(parseServerStatus({ success: false }), null);
  assert.equal(parseServerStatus({ success: true }), null);
  assert.deepEqual(parseServerStatus({ success: true, registered: false }), { registered: false, online: false, lastSeen: 0, heartbeats: null, reputation: null });
  // The archive's newest heartbeat of the node, by its block time.
  assert.match(LAST_HEARTBEAT_SQL, /WHERE t\.from_address = \$1 AND t\.tx_type IN \('HeartbeatCommitment', 'Heartbeat'\) ORDER BY t\.block DESC, t\.tx_index DESC LIMIT 1/);
  assert.equal(lastHeartbeatFrom([{ ts: '1789000000000' }]), 1_789_000_000_000);
  assert.equal(lastHeartbeatFrom([]), null);
  const asked = [];
  const last = createLastHeartbeat(async (text, params) => { asked.push(params); return { rows: [{ ts: '5' }] }; });
  assert.equal(await last(ID), 5);
  assert.deepEqual(asked, [[ID]]);
});

// C3.7: whether a wallet has a node of either type: verify-activation with the wallet in a header, never in the URL;
// any "yes" settles it, a "no" needs a node at the network's height and the light node's settled "none".
test('the wallet\'s node: verify-activation in a header, a yes from any node, a no only from an authoritative one', async () => {
  const { createWalletNode, parseVerifyActivation } = await import('../../server/cabinet/wallet-node.ts');
  const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const light = (over = {}) => ({ registered: false, pending: false, deviceBound: false, answeredThisEpoch: false, needsReactivation: false, counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null, ...over });
  const make = (answer, lightView = async () => light()) => {
    const net = network(everyNode((path) => (path === '/api/v1/verify-activation' ? answer : undefined)));
    const w = createWalletNode({ fetchFn: net.fetchFn, random: () => 0.5, lightView, scope: `wn${(scopes += 1)}`, devOrigins: false, clientKey: () => ({ ok: true, ip: '203.0.113.60' }) });
    return { w, calls: net.calls };
  };
  const yes = make({ verified: true, source: 'storage_index', node_id: 'super_node_0123456789abcdef', node_type: 'super', wallet_address: WALLET });
  assert.deepEqual(await yes.w.check(WALLET), { state: 'registered', nodeId: 'super_node_0123456789abcdef', nodeType: 'super' });
  assert.equal(yes.calls[0].init.headers['x-qnet-wallet'], WALLET);
  assert.ok(yes.calls.every((c) => !c.path.includes(WALLET)), 'the wallet never in the URL');
  const no = make({ verified: false, authoritative: true, wallet_address: WALLET });
  assert.deepEqual(await no.w.check(WALLET), { state: 'none' });
  // A node behind the network settles nothing; nor does a light node the site cannot read.
  assert.equal(await make({ verified: false, authoritative: false }).w.check(WALLET), null);
  assert.equal(await make({ verified: false, authoritative: true }, async () => null).w.check(WALLET), null);
  // A light registration being recorded is a node.
  assert.deepEqual(await make({ verified: false, authoritative: true }, async () => light({ pending: true })).w.check(WALLET), { state: 'registered', nodeId: 'light_mobile_6526ab8fd00ff8ca', nodeType: 'light' });
  assert.equal(parseVerifyActivation({ verified: false, error: 'Missing wallet_address parameter' }), null);
  assert.deepEqual(parseVerifyActivation({ verified: true, node_id: 'genesis_node_001', node_type: 'super' }), { verified: true, nodeId: 'genesis_node_001', nodeType: 'super' });
  // The route: an EON address only, exact answers.
  const route = await no.w.route(get(`https://aiqnet.io/api/cabinet/wallet-node/${WALLET}`), WALLET);
  assert.deepEqual(await json(route), { state: 'none' });
  assert.equal((await no.w.route(get('https://aiqnet.io/api/cabinet/wallet-node/x'), 'x')).status, 400);
  assert.deepEqual(CABINET_LIMITS.walletNode, { max: 60, windowMs: 60_000 });
});

// Audit M6: a reservation's check that the wallet has no node never shares a budget or a cache with anonymous reads:
// page reads that spent every node's read budget leave the reservation's check its own.
test('the reservation\'s has-node check has its own upstream budget and cache', async () => {
  const { createWalletNode } = await import('../../server/cabinet/wallet-node.ts');
  const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  let t = 1_000_000;
  const now = () => t;
  const budget = createUpstreamBudget({ now });
  const kinds = [];
  const net = network(everyNode((path) => (path === '/api/v1/verify-activation' ? { verified: false, authoritative: true } : undefined)));
  const lightView = async (id, kind) => {
    kinds.push(kind);
    return { registered: false, pending: false, deviceBound: false, answeredThisEpoch: false, needsReactivation: false, counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null, device: null };
  };
  const known = createKnownNodes({ now });
  const w = createWalletNode({ fetchFn: net.fetchFn, random: () => 0.5, budget, lightView, now, known, scope: `wn${(scopes += 1)}`, devOrigins: false, clientKey: () => ({ ok: true, ip: '203.0.113.61' }) });
  // Anonymous reads spend every node's read budgets this second.
  for (const n of [1, 2, 3, 4, 5]) for (const kind of ['readKnown', 'readUnknown']) while (budget(kind, `https://${host(n)}/x`));
  assert.equal(await w.check(WALLET), null, 'a page read now: the network could not be read');
  assert.deepEqual(await w.check(WALLET, 'reserve'), { state: 'none' }, 'the reservation is still answered');
  assert.deepEqual(kinds, ['reserve']);
  // The node proxy's status view keeps the same apart: its own cache and budget.
  const seen = [];
  const counting = (kind, url) => { seen.push(kind); return budget(kind, url); };
  t += 1_000;
  const p = createNodeProxy({ fetchFn: network(everyNode(reads(status()))).fetchFn, random: () => 0.5, now, budget: counting, known, scope: `cabinet${(scopes += 1)}`, devOrigins: false });
  assert.equal((await p.view(NODE, 'reserve')).registered, true);
  assert.ok(seen.length > 0 && seen.every((k) => k === 'reserve'), JSON.stringify(seen));
  assert.equal(known.has(NODE), true, 'seen registered');
  seen.length = 0;
  assert.equal((await p.view(NODE)).registered, true);
  assert.ok(seen.length > 0 && seen.every((k) => k === 'readKnown'), 'a page read does not take the reservation\'s cache or budget');
});

// SITE M-12: made-up light ids cost nothing and always miss the per-id cache. Each client's reads that go upstream count
// against its own share across the node, super and wallet-node routes (a cached answer costs nothing), ids nobody saw
// registered read on a small budget of their own, so registered owners keep theirs, and answers are kept about the
// page's poll interval, "not registered" and "none" a little longer.
test('a client\'s cache misses are its own share across routes; made-up ids cannot starve registered owners; caches follow the poll', async () => {
  const { createWalletNode, WALLET_NODE_CACHE_MS, WALLET_NONE_CACHE_MS } = await import('../../server/cabinet/wallet-node.ts');
  const { superNodeId } = await import('../qnet-link.ts');
  let t = 1_000_000;
  const now = () => t;
  assert.deepEqual(CLIENT_BUDGETS.upstreamMiss, { max: 30, windowMs: 60_000 });
  assert.equal(STATUS_CACHE_MS, 25_000);
  assert.equal(SUPER_CACHE_MS, 25_000);
  assert.equal(NONE_CACHE_MS, 30_000);
  assert.equal(RESERVE_CACHE_MS, 5_000);
  assert.equal(WALLET_NODE_CACHE_MS, STATUS_CACHE_MS);
  assert.equal(WALLET_NONE_CACHE_MS, NONE_CACHE_MS);
  // One gate for every route, as the process's routes share one.
  const gate = createGate({ now, clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.70' }), scope: `m12${(scopes += 1)}`, devOrigins: false });
  const known = createKnownNodes({ now });
  const net = network(everyNode((path) => {
    if (path.startsWith('/api/v1/light-node/status')) return status({ onchain_registered: path.includes(NODE) });
    if (path.startsWith('/api/v1/rewards/pending/')) return { pending_rewards_nano: 0 };
    if (path.startsWith('/api/v1/node/status')) return { success: true, onchain_registered: false };
    if (path === '/api/v1/verify-activation') return { verified: false, authoritative: true };
    return undefined;
  }));
  const budget = createUpstreamBudget({ now });
  const p = createNodeProxy({ fetchFn: net.fetchFn, now, gate, budget, known, random: () => 0.5 });
  const w = createWalletNode({ fetchFn: net.fetchFn, now, gate, budget, known, random: () => 0.5, lightView: (id, kind) => p.view(id, kind) });
  const made = (i) => `light_mobile_${(0xa000 + i).toString(16).padStart(16, '0')}`;
  // One client: 30 reads that go upstream a minute, whichever route; then 429 before any node is asked.
  const attacker = { 'x-test-ip': '198.51.100.66' };
  const codes = [];
  for (let i = 0; i < 20; i += 1) codes.push((await p.status(get(`https://aiqnet.io/api/cabinet/node/${made(i)}`, attacker), made(i))).status);
  for (let i = 0; i < 6; i += 1) codes.push((await p.superStatus(get(`https://aiqnet.io/api/cabinet/super/x`, attacker), `super_node_${(0xb000 + i).toString(16).padStart(16, '0')}`)).status);
  t += 1_000;
  for (let i = 0; i < 4; i += 1) codes.push((await w.route(get(`https://aiqnet.io/api/cabinet/wallet-node/x`, attacker), walletOf(i))).status);
  assert.equal(codes.filter((c) => c === 429).length, 0, JSON.stringify(codes));
  const before = net.calls.length;
  const refused = await p.status(get(`https://aiqnet.io/api/cabinet/node/${made(99)}`, attacker), made(99));
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal(net.calls.length, before, 'no node asked past the share');
  assert.equal((await p.status(get(`https://aiqnet.io/api/cabinet/node/${made(0)}`, attacker), made(0))).status, 200, 'a cached answer costs nothing');
  // Another client is not touched; an owner's node, seen registered once, reads on the known budget even while made-up
  // ids spent every node's unknown budget this second.
  assert.equal((await p.status(get(`https://aiqnet.io/api/cabinet/node/${NODE}`, { 'x-test-ip': '203.0.113.71' }), NODE)).status, 200);
  assert.equal(known.has(NODE), true);
  t += STATUS_CACHE_MS;
  for (const n of [1, 2, 3, 4, 5]) while (budget('readUnknown', `https://${host(n)}/x`));
  assert.equal((await p.status(get(`https://aiqnet.io/api/cabinet/node/${NODE}`, { 'x-test-ip': '203.0.113.71' }), NODE)).status, 200, 'the owner still reads');
  assert.equal((await p.status(get(`https://aiqnet.io/api/cabinet/node/${made(200)}`, { 'x-test-ip': '203.0.113.72' }), made(200))).status, 503, 'an unknown id waits');
  // Caches: a registered status about the poll interval, "not registered" and a super "not registered" a little longer.
  t += 60_000;
  const calls = () => net.calls.length;
  const owner = { 'x-test-ip': '203.0.113.73' };
  const fresh = made(300);
  await p.status(get(`https://aiqnet.io/api/cabinet/node/${fresh}`, owner), fresh);
  const once = calls();
  t += STATUS_CACHE_MS;
  await p.status(get(`https://aiqnet.io/api/cabinet/node/${fresh}`, owner), fresh);
  assert.equal(calls(), once, '"not registered" is still kept past the status cache');
  t += NONE_CACHE_MS - STATUS_CACHE_MS;
  await p.status(get(`https://aiqnet.io/api/cabinet/node/${fresh}`, owner), fresh);
  assert.ok(calls() > once, 'and read again after it');
  const sup = superNodeId(walletOf(7));
  await p.superStatus(get('https://aiqnet.io/api/cabinet/super/x', owner), sup);
  const superOnce = calls();
  t += SUPER_CACHE_MS;
  await p.superStatus(get('https://aiqnet.io/api/cabinet/super/x', owner), sup);
  assert.equal(calls(), superOnce, 'a super "not registered" is kept as long');
  const wallet = walletOf(8);
  await w.route(get('https://aiqnet.io/api/cabinet/wallet-node/x', owner), wallet);
  const walletOnce = calls();
  t += WALLET_NODE_CACHE_MS;
  await w.route(get('https://aiqnet.io/api/cabinet/wallet-node/x', owner), wallet);
  assert.equal(calls(), walletOnce, 'a wallet\'s "none" too');
});

// A valid EON address per index, for the wallet route (its checksum computed).
function walletOf(i) {
  const head = `${(0x1000 + i).toString(16).padStart(19, '0')}eon${'a'.repeat(15)}`;
  return `${head}${jsSha3.sha3_256(head).slice(0, 8)}`;
}

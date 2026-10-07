// Why a light node was not counted, on the cabinet (owner, 05.10; src/lib/cabinet/last-miss.ts): the public status's
// `device.last_miss` read from the genesis nodes owning the node's light shard, as the keyless status gives it (its
// epoch, its reason and whether the wake reached the device), and as a node of an earlier version still sends it during
// the roll (exact times, delays and an app outcome, which the site never keeps or shows); the record a reader takes
// (the highest epoch, at equal epochs the most specific reason, at equal reasons the record that knows the delivery); a
// reason the site does not know passed over; a node without the field showing nothing; the one line the Device tab and
// the Overview show (what happened in that epoch, whether the wake reached the device, what to do), nothing on the
// Overview once the node is counted again, and on the Device tab an earlier miss that carries the device's own account
// of the wake. Every answer belongs to its own epoch: no text says one counts for another.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MISS_REASONS, asksOtherOwners, deviceMiss, hasDeviceAccount, isLastMiss, latestMiss, missNotice, missText, parseNodeMiss, shownMiss,
} from '../cabinet/last-miss.ts';
import { parseStatusView } from '../cabinet/node-view.ts';
import { createNodeProxy, lightShardOwners, mergeStatus, parsePublicStatus } from '../../server/cabinet/node-proxy.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NODE = 'light_mobile_6526ab8fd00ff8ca';
// 14:05 UTC on 05.10.2026.
const AT = Date.UTC(2026, 9, 5, 14, 5) / 1000;
const REACHED = AT + 900;

// The keyless form the nodes give now, and the form of a node of an earlier version.
const miss = (over = {}) => ({ epoch: 200, reason: 'woken_no_answer', delivered: null, ...over });
const oldMiss = (over = {}) => ({ epoch: 200, reason: 'woken_no_answer', woken_at: AT, answered_at: null, delivery_delay_secs: null, refused: null, ...over });
const device = (over = {}) => ({ platform: 'android', linked_since: 1_790_000_000 - (1_790_000_000 % 86_400), last_answer_epoch: 198, state: 'offline', ...over });
const status = (over = {}) => ({
  onchain_registered: true,
  registration_pending: false,
  device_bound: true,
  answered_this_epoch: false,
  needs_reactivation: true,
  counted: { epochs_since_registration: 12, counted: 10, last_counted_epoch: 198 },
  features: ['bind_v2', 'uptime', 'wake'],
  ...over,
});
const view = (lastMiss, over = {}) => ({
  registered: true, pending: false, deviceBound: true, answeredThisEpoch: false, needsReactivation: true,
  counted: { sinceRegistration: 12, counted: 10, lastCountedEpoch: 198 }, features: ['wake'], balanceNano: '0',
  device: { platform: 'android', model: null, linkedSince: 1_789_948_800, lastAnswerEpoch: 198, state: 'offline', lastMiss },
  ...over,
});
const site = (over = {}) => ({ epoch: 200, reason: 'woken_no_answer', delivered: null, ...over });
// The device's account of the wake, as the owner that took its next answer keeps it: it reached the device.
const told = (over = {}) => site({ delivered: true, ...over });
// Counted again in a later epoch.
const countedAgain = { counted: { sinceRegistration: 12, counted: 11, lastCountedEpoch: 201 } };

test('last_miss: each reason read with its epoch and whether the wake reached the device; an unknown reason or an unreadable record is none', () => {
  for (const reason of MISS_REASONS) assert.equal(parseNodeMiss(miss({ reason })).reason, reason, reason);
  assert.deepEqual(parseNodeMiss(miss({ delivered: true })), told());
  assert.deepEqual(parseNodeMiss(miss({ delivered: false })), site({ delivered: false }));
  assert.deepEqual(parseNodeMiss({ epoch: 7, reason: 'answer_refused' }), site({ epoch: 7, reason: 'answer_refused' }));
  // A wake that never reached the device says so itself.
  assert.deepEqual(parseNodeMiss(miss({ reason: 'not_delivered' })), site({ reason: 'not_delivered', delivered: false }));
  // Any other field is dropped, the record stands.
  assert.deepEqual(parseNodeMiss(miss({ refused: 'device_refused', extra: 1 })), site());
  for (const reason of ['paused', 'WOKEN_NO_ANSWER', 'NOT_DELIVERED', '', null, 3]) assert.equal(parseNodeMiss(miss({ reason })), null, String(reason));
  for (const bad of [miss({ epoch: -1 }), miss({ epoch: '200' }), miss({ delivered: 'yes' }), miss({ delivered: 1 }), null, undefined, [], 'woken_no_answer']) {
    assert.equal(parseNodeMiss(bad), null, JSON.stringify(bad));
  }
});

// H-1 (06.10): during the roll a node of an earlier version still sends the exact times, the wake's delay and the app's
// outcome. They give whether the wake reached the device, and nothing of them is kept.
test('last_miss from a node of an earlier version: the delivery read from it, the times, delays and app outcome dropped', () => {
  assert.deepEqual(parseNodeMiss(oldMiss()), site());
  assert.deepEqual(parseNodeMiss(oldMiss({ reason: 'answered_late', answered_at: AT + 60, delivery_delay_secs: 8_400 })), site({ reason: 'answered_late' }));
  assert.deepEqual(parseNodeMiss(oldMiss({ delivered_at: REACHED, delivery_delay_secs: 900 })), told());
  for (const outcome of ['answered', 'not_opened_since_boot', 'swiped', 'after_commit', 'answer_failed', 'already_counted', 'no_key']) {
    const got = parseNodeMiss(oldMiss({ app_outcome: outcome }));
    assert.deepEqual(got, told(), outcome);
    assert.equal(JSON.stringify(got).includes(outcome), false, outcome);
  }
  // An outcome this site does not know says nothing, and is never shown.
  for (const outcome of ['asleep', 'SWIPED', '', 3]) assert.deepEqual(parseNodeMiss(oldMiss({ app_outcome: outcome })), site(), String(outcome));
  assert.deepEqual(parseNodeMiss(oldMiss({ reason: 'not_delivered', delivered_at: null, app_outcome: null })), site({ reason: 'not_delivered', delivered: false }));
  // Malformed old fields are dropped with the rest; `delivered` from a node that sends it decides.
  assert.deepEqual(parseNodeMiss(oldMiss({ woken_at: -5, delivered_at: '1790000000' })), site());
  assert.deepEqual(parseNodeMiss(oldMiss({ delivered_at: REACHED, delivered: false })), site({ delivered: false }));
  const kept = JSON.stringify(parseNodeMiss(oldMiss({ delivered_at: REACHED, delivery_delay_secs: 900, app_outcome: 'swiped', answered_at: AT + 9 })));
  for (const field of ['wokenAt', 'woken_at', 'answeredAt', 'deliveredAt', 'deliveryDelaySecs', 'appOutcome', String(AT), String(REACHED), '900']) {
    assert.equal(kept.includes(field), false, field);
  }
});

test('the reader rule: the highest epoch, at equal epochs the most specific reason, then the record that knows the delivery', () => {
  const r = (epoch, reason) => site({ epoch, reason });
  assert.equal(latestMiss([]), null);
  assert.equal(latestMiss([null, undefined]), null);
  assert.deepEqual(latestMiss([r(199, 'answered_late'), r(200, 'not_woken_inactive'), null]), r(200, 'not_woken_inactive'), 'a newer epoch wins');
  // not_committed > answered_late > not_delivered > answer_refused > woken_no_answer > no_push_address > not_sent >
  // not_woken_inactive, in any order of answers: a shard with no committed check counted no node of it, whatever the
  // device did; any owner that reached the device tells more than one whose wake did not go out.
  const order = ['not_committed', 'answered_late', 'not_delivered', 'answer_refused', 'woken_no_answer', 'no_push_address', 'not_sent', 'not_woken_inactive'];
  assert.deepEqual([...MISS_REASONS], order);
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      assert.equal(latestMiss([r(200, order[j]), r(200, order[i])]).reason, order[i], `${order[i]} over ${order[j]}`);
      assert.equal(latestMiss([r(200, order[i]), r(200, order[j])]).reason, order[i], `${order[i]} over ${order[j]}, first`);
    }
  }
  // The same wake with no answer: the owner that took the device's account tells more, in either order; a newer epoch
  // still wins over it, and a wake that never arrived over a wake not answered.
  assert.deepEqual(latestMiss([site(), told()]), told());
  assert.deepEqual(latestMiss([told(), site()]), told());
  assert.deepEqual(latestMiss([site({ delivered: false }), told()]), site({ delivered: false }), 'equal knowledge: the first');
  assert.deepEqual(latestMiss([told(), site({ epoch: 201 })]), site({ epoch: 201 }));
  assert.deepEqual(latestMiss([told(), site({ reason: 'not_delivered' })]).reason, 'not_delivered');
});

// Owners asked first: the genesis that wakes the device, then the other two owners. A reason one owner names that the
// site does not know is passed over for the others' records; a node of an earlier version may name none.
test('the site route: the owners\' records merged by the reader rule, old and new forms alike; an unknown reason passed over', () => {
  const answer = (d) => parsePublicStatus(status({ device: device(d) }));
  const a = answer({ last_miss: oldMiss({ reason: 'woken_no_answer' }), last_answer: { at: AT - 14_400, delivery_delay_secs: 9, handling_secs: 1 }, last_answer_at: AT - 14_400 });
  const b = answer({ last_miss: miss({ reason: 'answered_late' }) });
  const merged = mergeStatus(a, b, '0');
  assert.deepEqual(merged.device.lastMiss, site({ reason: 'answered_late' }));
  assert.equal('lastAnswer' in merged.device, false, 'no last answer\'s time reaches the page');
  assert.equal(JSON.stringify(merged).includes(String(AT - 14_400)), false);
  assert.deepEqual(parseStatusView(merged), merged, 'the page takes it exactly');
  // The owner that took the device's account of the wake: its record is the one shown, whichever answered first, in
  // the old form or the new.
  for (const account of [answer({ last_miss: oldMiss({ delivered_at: REACHED, app_outcome: 'not_opened_since_boot' }) }), answer({ last_miss: miss({ delivered: true }) })]) {
    const refined = mergeStatus(a, a, '0', [account]);
    assert.deepEqual(refined.device.lastMiss, told());
    assert.deepEqual(parseStatusView(refined), refined);
    assert.equal(JSON.stringify(refined).includes('not_opened_since_boot'), false);
    assert.deepEqual(mergeStatus(account, a, '0').device.lastMiss, told());
  }
  const lost = answer({ last_miss: miss({ reason: 'not_delivered' }) });
  assert.equal(mergeStatus(a, a, '0', [lost]).device.lastMiss.reason, 'not_delivered');
  // An older epoch's record loses to a newer one, whatever its reason.
  const older = answer({ last_miss: miss({ epoch: 199, reason: 'answered_late' }) });
  assert.equal(mergeStatus(older, a, '0').device.lastMiss.epoch, 200);
  // An unknown reason, a newer epoch: passed over, never shown raw.
  const unknown = answer({ last_miss: miss({ epoch: 201, reason: 'phone_asleep' }) });
  assert.deepEqual(mergeStatus(unknown, a, '0').device.lastMiss, site());
  assert.equal(mergeStatus(unknown, unknown, '0').device.lastMiss, null);
  assert.equal(JSON.stringify(mergeStatus(unknown, a, '0')).includes('phone_asleep'), false);
  // A node without the field: nothing to show; nor from a node not on the chain.
  const old = answer({});
  const none = mergeStatus(old, old, '0');
  assert.equal(none.device.lastMiss, null);
  assert.equal(shownMiss(none), null);
  assert.equal(deviceMiss(none), null);
  assert.equal(parsePublicStatus(status({ onchain_registered: false, device: device({ last_miss: miss() }) })).device, null);
  // The page's exact shape: every key always there, nothing else; no time, delay or outcome is taken.
  assert.equal(parseStatusView({ ...merged, device: { ...merged.device, lastMiss: undefined } }), null);
  assert.equal(parseStatusView({ ...merged, device: { ...merged.device, lastAnswer: null } }), null);
  assert.equal(parseStatusView({ ...merged, device: { ...merged.device, lastMiss: { ...merged.device.lastMiss, reason: 'phone_asleep' } } }), null);
  assert.equal(parseStatusView({ ...merged, device: { ...merged.device, lastMiss: { ...merged.device.lastMiss, wokenAt: AT } } }), null);
  assert.equal(isLastMiss(null), true);
  assert.equal(isLastMiss(told()), true);
  assert.equal(isLastMiss(site({ delivered: false })), true);
  assert.equal(isLastMiss({ ...site(), refused: 'x' }), false);
  assert.equal(isLastMiss({ ...told(), appOutcome: 'swiped' }), false);
  assert.equal(isLastMiss({ ...told(), delivered: 'yes' }), false);
  const { delivered: _gone, ...two } = told();
  assert.equal(isLastMiss(two), false);
});

// Genesis nodes that answer from a table per host.
function network(table) {
  const calls = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: `${u.pathname}${u.search}` });
    const answer = table[u.host]?.(`${u.pathname}${u.search}`);
    if (answer === undefined) throw new TypeError('unreachable');
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { fetchFn, calls };
}
const host = (i) => `node${i + 1}.aiqnet.io`;
const reads = (s) => (path) => (path.startsWith('/api/v1/light-node/status') ? s : path.startsWith('/api/v1/rewards/pending/') ? { pending_rewards_nano: 0 } : undefined);
let scopes = 0;
const proxyOf = (table) => {
  const net = network(table);
  const p = createNodeProxy({ fetchFn: net.fetchFn, random: () => 0.5, now: () => 1_000_000, clientKey: () => ({ ok: true, ip: '203.0.113.9' }), scope: `miss${(scopes += 1)}`, devOrigins: false });
  return { p, statusHosts: () => net.calls.filter((c) => c.path.startsWith('/api/v1/light-node/status')).map((c) => c.host) };
};
const get = () => new Request(`https://aiqnet.io/api/cabinet/node/${NODE}`, { headers: { host: 'aiqnet.io' } });
const everyone = (s) => Object.fromEntries([0, 1, 2, 3, 4].map((i) => [host(i), reads(s)]));

test('the shard\'s owners: the published hash of nothing gives shard 3; a miss the page shows, or one the device\'s account may still tell, is read from the third owner too', async () => {
  // BLAKE3 of the empty input begins af1349b9f5f9a1a6: as a little-endian u64, 0xa6a1f9f5b94913af, which is 3 mod 5.
  assert.deepEqual(lightShardOwners(''), [3, 4, 0]);
  const owners = lightShardOwners(NODE);
  assert.deepEqual(owners, [1, 2, 3]);
  const table = everyone(status({ device: device() }));
  table[host(owners[0])] = reads(status({ device: device({ last_miss: miss() }) }));
  table[host(owners[2])] = reads(status({ device: device({ last_miss: oldMiss({ reason: 'answered_late', answered_at: AT + 9_000, delivery_delay_secs: 8_700 }) }) }));
  const shown = proxyOf(table);
  const body = await (await shown.p.status(get(), NODE)).json();
  assert.deepEqual(shown.statusHosts(), owners.map(host), 'the waking owner, a second owner, then the third for the miss');
  assert.deepEqual(body.device.lastMiss, site({ reason: 'answered_late' }));
  assert.equal(JSON.stringify(body).includes('8700'), false, 'the delay stays out of the answer');
  // Counted since, a wake with no answer and no account of it: the owner that took the device's next answer may hold
  // the account, so the third owner is asked, and its record is the one the Device tab names.
  const counted = (d) => status({ answered_this_epoch: true, needs_reactivation: false, counted: { epochs_since_registration: 12, counted: 11, last_counted_epoch: 200 },
    device: device({ last_answer_epoch: 201, state: 'online', ...d }) });
  const later = everyone(counted({ last_miss: miss({ epoch: 199 }) }));
  later[host(owners[2])] = reads(counted({ last_miss: miss({ epoch: 199, delivered: true }) }));
  const asked = proxyOf(later);
  const told199 = (await (await asked.p.status(get(), NODE)).json()).device.lastMiss;
  assert.deepEqual(asked.statusHosts(), owners.map(host));
  assert.deepEqual(told199, told({ epoch: 199 }));
  // Counted since, with the account already in hand, or a miss no account tells more of: no third read.
  for (const d of [{ last_miss: miss({ epoch: 199, delivered: true }) }, { last_miss: oldMiss({ epoch: 199, delivered_at: REACHED, app_outcome: 'swiped' }) },
    { last_miss: miss({ epoch: 199, reason: 'no_push_address' }) }, { last_miss: miss({ epoch: 199, reason: 'not_delivered' }) }, { last_miss: null }]) {
    const quiet = proxyOf(everyone(counted(d)));
    await (await quiet.p.status(get(), NODE)).json();
    assert.deepEqual(quiet.statusHosts(), owners.slice(0, 2).map(host), JSON.stringify(d));
  }
  // A reservation's read never asks for it.
  const reserve = proxyOf(table);
  assert.equal((await reserve.p.view(NODE, 'reserve')).device.lastMiss.reason, 'woken_no_answer');
  assert.deepEqual(reserve.statusHosts(), owners.slice(0, 2).map(host));
});

test('the Overview: shown only while newer than the last counted epoch, with no answer of that epoch or a later one; never for a node off the chain', () => {
  assert.deepEqual(shownMiss(view(site())), site());
  assert.equal(shownMiss(view(null)), null);
  assert.equal(shownMiss(view(site(), { device: null })), null, 'a node of an earlier version');
  assert.equal(shownMiss(view(site(), { counted: { sinceRegistration: 12, counted: 11, lastCountedEpoch: 200 } })), null, 'counted in that epoch');
  assert.equal(shownMiss(view(site(), countedAgain)), null, 'counted since');
  assert.equal(shownMiss(view(told(), countedAgain)), null, 'counted since, even with the device\'s account');
  assert.deepEqual(shownMiss(view(site(), { counted: { sinceRegistration: 12, counted: 0, lastCountedEpoch: null } })), site(), 'never counted lately');
  const answered = view(site());
  answered.device.lastAnswerEpoch = 201;
  assert.equal(shownMiss(answered), null, 'it answered in a later epoch');
  answered.device.lastAnswerEpoch = 200;
  assert.equal(shownMiss(answered), null, 'it answered in that epoch: the app hides it alike');
  answered.device.lastAnswerEpoch = 199;
  assert.deepEqual(shownMiss(answered), site());
  assert.equal(shownMiss(view(site(), { registered: false })), null);
});

// The device's account of a wake reaches the network only with its next answer, which in a later epoch counts the node
// again: the Device tab keeps naming that miss, the Overview does not.
test('the Device tab: the Overview\'s miss, else an earlier one that carries the device\'s own account of the wake', () => {
  assert.deepEqual(deviceMiss(view(site())), site(), 'the Overview\'s');
  assert.deepEqual(deviceMiss(view(told(), countedAgain)), told());
  assert.deepEqual(deviceMiss(view(site({ delivered: false }), countedAgain)), site({ delivered: false }));
  assert.deepEqual(deviceMiss(view(site({ reason: 'not_delivered' }), countedAgain)), site({ reason: 'not_delivered' }));
  for (const old of [site(), site({ reason: 'answered_late', delivered: true }), site({ reason: 'answer_refused', delivered: true }), site({ reason: 'no_push_address' }),
    site({ reason: 'not_woken_inactive' })]) {
    assert.equal(deviceMiss(view(old, countedAgain)), null, JSON.stringify(old));
  }
  assert.equal(deviceMiss(view(told(), { ...countedAgain, registered: false })), null);
  assert.equal(deviceMiss(view(told(), { ...countedAgain, device: null })), null);
  assert.equal(hasDeviceAccount(site()), false);
  assert.equal(hasDeviceAccount(told()), true);
  // The third owner's read: for the Overview's miss, and for a wake with no answer still without the account.
  assert.equal(asksOtherOwners(view(site())), true);
  assert.equal(asksOtherOwners(view(site(), countedAgain)), true);
  assert.equal(asksOtherOwners(view(told(), countedAgain)), false);
  assert.equal(asksOtherOwners(view(site({ reason: 'no_push_address' }), countedAgain)), false);
  assert.equal(asksOtherOwners(view(null)), false);
  assert.equal(asksOtherOwners(view(site(), { ...countedAgain, registered: false })), false);
  // A wake that did not go out at one owner: another may have reached the device. A shard with no committed check is
  // the same at every owner and ranks first: no third read for it.
  assert.equal(asksOtherOwners(view(site({ reason: 'not_sent' }))), true);
  assert.equal(asksOtherOwners(view(site({ reason: 'not_committed' }))), false);
  // Neither is the device's account of a wake, so neither stays on the Device tab once the node is counted again.
  for (const reason of ['not_sent', 'not_committed']) {
    assert.equal(hasDeviceAccount(site({ reason })), false, reason);
    assert.equal(deviceMiss(view(site({ reason }), countedAgain)), null, reason);
    assert.deepEqual(deviceMiss(view(site({ reason }))), site({ reason }), reason);
  }
});

test('each reason\'s line: what happened in that epoch, whether the wake reached the device when known, and what to do; never a time', () => {
  const line = (over, platform = 'android', wake = null) => missText(site(over), platform, wake);
  const background = TEXTS.miss_todo_background_android;
  assert.equal(line({}), `Epoch 200 was not counted: the network sent the device a wake, and no answer came before that epoch's check closed. ${background}`);
  assert.equal(line({ reason: 'answered_late' }), `Epoch 200 was not counted: the device answered after that epoch's check had closed. ${background}`);
  assert.equal(line({ reason: 'answered_late', delivered: true }, 'ios'),
    `Epoch 200 was not counted: the device answered after that epoch's check had closed. The wake reached the device. ${TEXTS.miss_todo_background_ios}`);
  assert.equal(line({ reason: 'answered_late' }, null), `${TEXTS.miss_late.replace('{epoch}', '200')} ${TEXTS.miss_todo_background}`);
  assert.equal(line({ reason: 'answer_refused' }), `Epoch 200 was not counted: the device answered, but the network did not accept the answer. ${TEXTS.miss_todo_run_again}`);
  assert.equal(line({ reason: 'no_push_address' }), `${TEXTS.miss_no_push.replace('{epoch}', '200')} ${TEXTS.miss_todo_open_once}`);
  // A device the network stopped waking after two epochs without an answer: open the app, or I'm back where it is.
  const inactive = { reason: 'not_woken_inactive' };
  const stopped = 'Epoch 200 was not counted: the device had not answered in the two epochs before it, so the network stopped waking it.';
  assert.equal(line(inactive), `${stopped} Open QNet Wallet on that device.`);
  assert.equal(line(inactive, 'android', 'here'), `${stopped} Open QNet Wallet on that device, or press I'm back.`);
  assert.equal(line(inactive, 'android', 'overview'), `${stopped} Open QNet Wallet on that device, or press I'm back on the Overview.`);
  assert.doesNotMatch(TEXTS.miss_inactive, /several/);
  assert.equal(missNotice(site(inactive), 'ios', 'here').todo, 'miss_todo_open_or_wake');
  // Large epochs grouped as the texts write numbers.
  assert.match(missText(site({ epoch: 12_345 }), 'android', null), /^Epoch 12,345 was not counted/);
  // No line carries a time of day or a delay, whatever the record.
  for (const reason of MISS_REASONS) {
    for (const delivered of [true, false, null]) {
      assert.doesNotMatch(missText(site({ reason, delivered }), 'android', null), /\d{1,2}:\d{2}|\bmin\b|\bh\b|within a minute|after it was sent/, `${reason} ${delivered}`);
    }
  }
});

// Owner, 05.10: a miss the network caused never counts against the device. A wake the network did not get out
// (`not_sent`: the provider refused it, the pacing shed it, no anchor, the owner was down) and a shard with no committed
// check (`not_committed`) say so, and that nothing on the device needs changing, wherever I'm back is.
test('the network\'s misses: what happened, and nothing to change on the device', () => {
  const network = TEXTS.miss_todo_network;
  assert.equal(network, 'That was the network\'s miss: nothing needs changing on that device or in QNet Wallet.');
  for (const platform of ['android', 'ios', null]) {
    for (const wake of [null, 'here', 'overview']) {
      assert.equal(missText(site({ reason: 'not_sent' }), platform, wake),
        `Epoch 200 was not counted: the network did not get its wake out to the device in that epoch. ${network}`);
      assert.equal(missText(site({ reason: 'not_committed' }), platform, wake),
        `Epoch 200 was not counted: the network published no check of this node's group in that epoch, so no node of the group was counted in it. ${network}`);
    }
  }
  assert.deepEqual(missNotice(site({ reason: 'not_sent' }), 'ios', 'here'), { what: 'miss_not_sent', todo: 'miss_todo_network' });
  assert.deepEqual(missNotice(site({ reason: 'not_committed' }), 'android', null), { what: 'miss_not_committed', todo: 'miss_todo_network' });
  // A wake that never went out has no delivery to tell; a shard not checked may still tell that an answered wake came.
  assert.equal(missText(site({ reason: 'not_sent', delivered: true }), 'android', null),
    `Epoch 200 was not counted: the network did not get its wake out to the device in that epoch. ${network}`);
  assert.equal(missText(site({ reason: 'not_committed', delivered: true }), 'android', null),
    `Epoch 200 was not counted: the network published no check of this node's group in that epoch, so no node of the group was counted in it. The wake reached the device. ${network}`);
  // Read from the node as any other reason, and on the Overview beside an Offline state like any other miss.
  for (const reason of ['not_sent', 'not_committed']) {
    assert.deepEqual(parseNodeMiss(miss({ reason })), site({ reason }), reason);
    assert.deepEqual(shownMiss(view(site({ reason }))), site({ reason }), reason);
  }
  // At one epoch, the shard's missing check over whatever an owner saw of the device; any record that reached the
  // device over a wake that did not go out at another owner.
  assert.equal(latestMiss([site({ reason: 'answered_late' }), site({ reason: 'not_committed' })]).reason, 'not_committed');
  assert.equal(latestMiss([site({ reason: 'not_sent' }), site({ reason: 'woken_no_answer' })]).reason, 'woken_no_answer');
  assert.equal(latestMiss([site({ reason: 'not_woken_inactive' }), site({ reason: 'not_sent' })]).reason, 'not_sent');
});

// The device's own account (owner, 05.10; H-1, 06.10): whether the wake reached the device, and the platform's generic
// advice. What QNet Wallet did with the wake (swiped away, not opened since a restart) is no longer public, so the hint
// for a wake with no answer is the same for every account.
test('the device\'s account: whether the wake reached the device, or that it never arrived, with the generic advice for a wake with no answer', () => {
  const head = 'Epoch 200 was not counted: the network sent the device a wake, and no answer came before that epoch\'s check closed.';
  const background = TEXTS.miss_todo_background_android;
  assert.equal(missText(told(), 'android', null), `${head} The wake reached the device. ${background}`);
  assert.equal(missText(told(), 'ios', null), `${head} The wake reached the device. ${TEXTS.miss_todo_background_ios}`);
  assert.equal(missText(site({ delivered: false }), 'android', null), `${head} The wake did not reach the device. ${background}`);
  assert.equal(missText(site(), 'android', null), `${head} ${background}`);
  for (const delivered of [true, false, null]) assert.equal(missNotice(site({ delivered }), 'android', null).todo, 'miss_todo_background_android', String(delivered));
  // A miss read from a node of an earlier version gives the same line, whatever outcome it carried.
  for (const outcome of ['swiped', 'not_opened_since_boot', 'no_key', 'answer_failed']) {
    assert.equal(missText(parseNodeMiss(oldMiss({ app_outcome: outcome, delivered_at: REACHED })), 'android', null), `${head} The wake reached the device. ${background}`, outcome);
  }
  // A wake that never reached the device: the push service or the device held it.
  assert.equal(missText(site({ reason: 'not_delivered', delivered: false }), 'android', null),
    `Epoch 200 was not counted: the wake the network sent never reached the device. The push service or the device held it. ${background}`);
  assert.equal(missText(site({ reason: 'not_delivered', delivered: false }), 'ios', null),
    `Epoch 200 was not counted: the wake the network sent never reached the device. The push service or the device held it. ${TEXTS.miss_todo_background_ios}`);
});

// One line with the device rows: on the Device tab for an Online or Offline device (its own miss: the Overview's, else
// one the device told about), on the Overview beside the Offline state where I'm back follows. No row names the time of
// an answer. A typed address (view only) shows the platform, the state and the epochs only. I'm back itself stays on the
// Overview only.
test('the pages: the miss line in the device rows, no answer time, a typed address shown by its platform, state and epochs only', () => {
  const rows = code('components/cabinet/NodeStatus.tsx');
  assert.match(rows, /const miss = full \? deviceMiss\(status\) : shownMiss\(status\);\s*if \(!miss\) return null;\s*return <p>\{missText\(miss, status\.device\?\.platform \?\? null, wake\)\}<\/p>;/);
  assert.match(rows, /const missed = !viewOnly && \(state === 'offline' \|\| \(full && state === 'online'\)\);/);
  assert.match(rows, /const named = device && viewOnly \? \{ platform: device\.platform, model: null \} : device;/);
  assert.match(rows, /\{full && named && deviceName\(named\) && <p>\{deviceName\(named\)\}<\/p>\}/);
  assert.match(rows, /\{full && !viewOnly && device\?\.linkedSince != null && /);
  assert.match(rows, /const wake: WakePlace = state === 'offline' && canWake\(status\) \? \(full \? 'overview' : 'here'\) : null;/);
  assert.match(rows, /\{missed && <MissLine status=\{status\} wake=\{wake\} full=\{full\} \/>\}\s*<\/>/);
  assert.doesNotMatch(rows, /lastAnswer\b|answerText|Date\.now\(\)\)\}<\/p>/);
  assert.equal(rows.match(/<MissLine /g)?.length, 1);
  assert.doesNotMatch(rows, /WakePanel/);
  assert.match(code('components/cabinet/NodeHome.tsx'), /<DeviceRows status=\{status\} viewOnly=\{viewOnly\} \/>\s*\{wake && <WakePanel /);
  assert.match(code('components/cabinet/NodeDevices.tsx'), /<DeviceRows status=\{status\} full viewOnly=\{viewOnly\} \/>/);
  assert.match(code('server/cabinet/node-proxy.ts'), /kind !== 'read' \|\| unasked\.length === 0 \|\| !\(asksOtherOwners\(view\) \|\| offline\)\) return view;/);
  // The site keeps none of the precise fields anywhere: not in the route's parser, not in its cache.
  const proxy = code('server/cabinet/node-proxy.ts');
  assert.doesNotMatch(proxy, /last_answer_at|parseNodeAnswer|latestAnswer|lastAnswer\b|woken_at|delivered_at|app_outcome/);
  assert.doesNotMatch(code('lib/cabinet/last-miss.ts'), /wokenAt|answeredAt|deliveredAt|deliveryDelaySecs|appOutcome|missTime/);
});

test('the texts: self-service, no contact to write to, no other names, no word for earnings, no time', () => {
  const keys = Object.keys(TEXTS).filter((k) => /^(miss|delivery)_/.test(k));
  assert.equal(keys.length, 19);
  for (const key of keys) {
    assert.doesNotMatch(TEXTS[key], /support|write to|contact|e-?mail|reward|\bearn|mining|\bburn|price|activat/i, key);
    assert.doesNotMatch(TEXTS[key], /Google|Apple|Firebase|Samsung|Xiaomi|Huawei/, key);
    assert.doesNotMatch(TEXTS[key], /\b(fault|blame|your fault|our fault|failure of)\b/i, key);
    assert.doesNotMatch(TEXTS[key], /\{time\}|\{delay\}|\{minutes\}|\{hours\}/, key);
  }
  for (const key of keys.filter((k) => k.startsWith('miss_todo_'))) assert.match(TEXTS[key], /QNet Wallet/, key);
  assert.equal(keys.some((k) => k.startsWith('miss_outcome_')), false, 'what the app did with a wake is never named');
  assert.equal('device_answered_at' in TEXTS, false);
});

// Owner, 05.10: an answer in an epoch belongs to that epoch, never to the next; an answer after the epoch's check counts
// for nothing.
test('no site text says an answer counts for another epoch', () => {
  for (const [key, text] of Object.entries(TEXTS)) {
    if (typeof text !== 'string') continue;
    assert.doesNotMatch(text, /\b(next|following|later|another|coming) epoch/i, key);
    assert.doesNotMatch(text, /\b(covered|carried|moved|deferred|counts?) (by|over|to|into|for) the (app's )?next\b/i, key);
  }
  assert.match(TEXTS.support_epochs_sleep, /before the epoch's check closes/);
  assert.match(TEXTS.support_epochs_sleep, /An answer after that counts for no epoch, not the next one either\.$/);
  assert.doesNotMatch(TEXTS.support_epochs_sleep, /covered by|back online/);
});

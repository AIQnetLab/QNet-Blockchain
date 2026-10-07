// The cabinet moves on by itself (owner, 30.09): the Overview stayed on "Recording your node on the QNet network" while
// the wallet's light node was already on the network. Once the network lists the node, every page leads with the next
// step (Link your phone for a light node without a device, the server for a super node), whichever way the wallet was
// connected; a listing that reaches the page before two nodes agree on the status is recorded, never an empty section;
// while the record, the phone or the server is awaited the network is read every few seconds, and the watch stops once
// nothing is (src/lib/cabinet/wallet-activation.ts nextStep, watchInterval, lightSectionState; the provider and the
// pages that follow them). Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WATCH_MAX_MS, WATCH_NEXT_MS, WATCH_RECORD_MS, activationView, c9Name, lightSectionState, nextStep, watchInterval,
} from '../cabinet/wallet-activation.ts';
import { journey } from '../cabinet/tabs.ts';
import { recordCode } from '../cabinet/burn-record.ts';
import { lightNodeId, superNodeId } from '../qnet-link.ts';
import { TEXTS } from '../texts.ts';

const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const W = V.wallets[0].address;
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const TX = V.node[0].burnTx;
const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ok = (value) => ({ phase: 'ok', value });
const LOADING = { phase: 'loading' };
const DOWN = { phase: 'unavailable' };
const light = (over = {}) => ({
  registered: false, pending: false, deviceBound: false, answeredThisEpoch: false, needsReactivation: false,
  counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null, ...over,
});
const superS = (over = {}) => ({ registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null, ...over });
const recorded = (nodeType = 'light', way = 'extension') => ({
  wallet: W, state: 'recorded', nodeType, way, burner: SOL, burnTx: TX, burnAmount: 1500, code: recordCode(way, nodeType, W, SOL, TX, 1500), until: null,
  recordedAt: 1, scan: null,
});
const LISTED_LIGHT = ok({ state: 'registered', nodeId: lightNodeId(W), nodeType: 'light' });

// The owner's wallet on 30.09: the extension's burn in the site's record, the node not on the network yet.
const inputs = (over = {}) => ({
  choice: { qnet: W, source: 'extension', solana: SOL },
  network: ok({ state: 'none' }),
  light: ok(light()),
  superStatus: ok(superS()),
  server: ok(recorded()),
  scan: null,
  extension: ok({ status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: recorded().code, paidOnSite: false }),
  kept: null,
  records: [],
  ...over,
});
const view = (over) => activationView(inputs(over));

test('burned, then recorded: the step moves from the record to Link your phone as soon as the network lists the node', () => {
  const waiting = view({});
  assert.equal(waiting.state, 'burned');
  assert.equal(nextStep(waiting), 'record');
  // The network holds the registration: still the record.
  assert.equal(nextStep(view({ light: ok(light({ pending: true })) })), 'record');
  // The status the nodes settled lists it: Link your phone.
  const linked = view({ light: ok(light({ registered: true })) });
  assert.deepEqual([linked.state, linked.light, nextStep(linked), c9Name(linked)], ['node', 'no_device', 'link', 'light-not-linked']);
  assert.deepEqual(journey(true, linked), { done: 2, current: 2, nodeType: 'light' });
  // Then running, or I'm back for a device the network asks to come back.
  assert.equal(nextStep(view({ light: ok(light({ registered: true, deviceBound: true })) })), 'running');
  assert.equal(nextStep(view({ light: ok(light({ registered: true, deviceBound: true, needsReactivation: true })) })), 'wake');
  // Contract of 04.10: the node names its device. A device linked less than an epoch ago that has not answered yet is
  // linked (never Offline, never I'm back): the step waits for its first answer, and the page watches for it.
  const device = (state) => ({ platform: 'android', linkedSince: 1_790_000_000, lastAnswerEpoch: null, state });
  const pending = view({ light: ok(light({ registered: true, deviceBound: true, needsReactivation: true, device: device('other_device_pending') })) });
  assert.deepEqual([pending.light, nextStep(pending), c9Name(pending), watchInterval(pending)], ['device_pending', 'answer', 'light-linking', WATCH_NEXT_MS]);
  assert.deepEqual(journey(true, pending), { done: 3, current: 3, nodeType: 'light' });
  assert.ok(pending.nodes.includes('light'));
  assert.equal(nextStep(view({ light: ok(light({ registered: true, deviceBound: true, needsReactivation: true, device: device('offline') })) })), 'wake');
  assert.equal(nextStep(view({ light: ok(light({ registered: true, deviceBound: true, device: device('online') })) })), 'running');
  assert.equal(nextStep(view({ light: ok(light({ registered: true, deviceBound: false, device: device('unlinked') })) })), 'link');
});

test('the root cause: one node\'s listing ahead of the settled status is recorded with no device, never an empty section', () => {
  // The wallet-node check (one node's verify-activation) lists the node while two nodes still settle "not registered":
  // the view had the node (state `node`) with no light state, and the Overview, Device and History handed the section to
  // the no-node card, which shows nothing for a wallet with a node.
  const ahead = view({ network: LISTED_LIGHT, light: ok(light()) });
  assert.deepEqual([ahead.state, ahead.light, nextStep(ahead)], ['node', 'no_device', 'link']);
  assert.equal(lightSectionState(light(), ahead), 'no_device');
  assert.deepEqual(journey(true, ahead), { done: 2, current: 2, nodeType: 'light' });
  // Whichever way the wallet was connected: QNet Wallet on this device, a QR answer, an address typed to look.
  for (const choice of [{ qnet: W, source: 'app', solana: SOL }, { qnet: W, source: 'app-qr' }, { qnet: W, source: 'entered' }]) {
    const v = view({ choice, network: LISTED_LIGHT, extension: { phase: 'na' } });
    assert.deepEqual([v.state, nextStep(v)], ['node', 'link'], choice.source);
  }
  // Without a listing the settled "not registered" stays what it is; a registration being recorded stays the record.
  assert.equal(lightSectionState(light(), view({})), 'none');
  assert.equal(view({ network: LISTED_LIGHT, light: ok(light({ pending: true })) }).state, 'recording');
  // Listed, its status not read: nothing past Activate is shown as done, and the step waits for the status.
  const unread = view({ network: LISTED_LIGHT, light: LOADING });
  assert.deepEqual([unread.state, unread.light, nextStep(unread)], ['node', null, null]);
  assert.deepEqual(journey(true, unread), { done: 2, current: null, nodeType: 'light' });
});

test('the watch: every few seconds while the record is awaited, ten seconds for the phone or the server, none after', () => {
  assert.equal(watchInterval(view({})), WATCH_RECORD_MS);
  assert.equal(watchInterval(view({ light: ok(light({ pending: true })) })), WATCH_RECORD_MS);
  assert.equal(watchInterval(view({ network: LISTED_LIGHT, light: LOADING })), WATCH_RECORD_MS);
  assert.equal(watchInterval(view({ light: ok(light({ registered: true })) })), WATCH_NEXT_MS);
  // Running or offline: nothing awaited (I'm back reads the status itself); nothing burned: nothing to watch.
  assert.equal(watchInterval(view({ light: ok(light({ registered: true, deviceBound: true })) })), null);
  assert.equal(watchInterval(view({ light: ok(light({ registered: true, deviceBound: true, needsReactivation: true })) })), null);
  const none = view({ server: ok({ ...recorded(), state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, recordedAt: null }), extension: ok({ status: 'none', qnet: W, solana: SOL }), scan: { complete: true, unusable: false, burns: [] } });
  assert.deepEqual([none.state, nextStep(none), watchInterval(none)], ['none', null, null]);
  // A super node: its server from the burn until the network counts it online.
  const burnedSuper = view({ server: ok(recorded('super')), extension: { phase: 'na' } });
  assert.deepEqual([nextStep(burnedSuper), watchInterval(burnedSuper)], ['server', WATCH_NEXT_MS]);
  const listedSuper = view({ server: ok(recorded('super')), network: ok({ state: 'registered', nodeId: superNodeId(W), nodeType: 'super' }), superStatus: LOADING });
  assert.deepEqual([listedSuper.state, nextStep(listedSuper), watchInterval(listedSuper)], ['node', 'server', WATCH_NEXT_MS]);
  const online = view({ server: ok(recorded('super')), superStatus: ok(superS({ registered: true, online: true })) });
  assert.deepEqual([nextStep(online), watchInterval(online)], ['running', null]);
  assert.equal(watchInterval(view({ server: ok(recorded('super')), superStatus: ok(superS({ registered: true })) })), null);
  // A network that does not answer is said on the record's card, and the watch goes on.
  const down = view({ network: DOWN });
  assert.deepEqual([down.state, down.networkDown, watchInterval(down)], ['burned', true, WATCH_RECORD_MS]);
  assert.equal(view({}).networkDown, false);
});

test('the provider watches the network while the wallet waits, and every page leads with the step it is on', () => {
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /const watch = watchInterval\(view\);/);
  // Modest (05.10): the watch's few seconds last at most WATCH_MAX_MS from the step's start or the page's return; then
  // only the reads' own half-minute round goes on.
  assert.equal(WATCH_MAX_MS, 600_000);
  assert.equal(WATCH_RECORD_MS, 5_000);
  assert.equal(WATCH_NEXT_MS, 10_000);
  assert.match(provider, /if \(watch === null\) return;\s*let until = Date\.now\(\) \+ WATCH_MAX_MS;/);
  assert.match(provider, /if \(document\.visibilityState === 'visible'\) until = Date\.now\(\) \+ WATCH_MAX_MS;/);
  assert.match(provider, /const timer = window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'visible' \|\| Date\.now\(\) > until\) return;\s*refreshNetwork\(\);\s*refreshLight\(\);/);
  assert.match(provider, /window\.clearInterval\(timer\);\s*document\.removeEventListener\('visibilitychange', onVisible\);\s*\};\s*\}, \[watch, step, watchSuper, refreshNetwork, refreshLight, refreshSuper\]\);/);
  assert.match(provider, /const step = nextStep\(view\);/);
  assert.match(code('hooks/useNodeStatus.ts'), /const REFRESH_MS = 30_000;/);
  // The Overview: Link your phone first, before the node's card; the sections take the listing's word.
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /const state = lightSectionState\(status, view\);/);
  assert.ok(home.indexOf("{state === 'no_device' && <LinkPhone onLinked={reread} />}") < home.indexOf("t('overview_title')"));
  for (const file of ['components/cabinet/NodeDevices.tsx', 'components/cabinet/NodeHistory.tsx']) {
    assert.match(code(file), /const s = lightSectionState\(status, view\);/, file);
  }
  // Link your phone: the steps so far, the phone's now, then the numbered steps with Link a device.
  const steps = code('components/cabinet/NextSteps.tsx');
  const linkPhone = steps.slice(steps.indexOf('export function LinkPhone('), steps.indexOf('export function NodeNext('));
  assert.match(linkPhone, /<Step at="done">\{t\('next_step_burn'\)\}<\/Step>\s*<Step at="done">\{t\('next_step_record'\)\}<\/Step>\s*<Step at="now">\{t\('next_step_link'\)\}<\/Step>/);
  assert.match(linkPhone, /<p className="activate-result" role="status">\{t\('next_link_lead'\)\}<\/p>/);
  // The Activate page and the extension's answer follow the listing too.
  assert.match(code('components/cabinet/NodeActivate.tsx'), /\{!extensionAnswered && \(view\.state === 'node' \? <NodeNext \/> : <NoNode pending=\{view\.state === 'recording'\} overview \/>\)\}/);
  const next = steps.slice(steps.indexOf('export function NodeNext('));
  assert.match(next, /if \(step === 'link'\) return <LinkPhone \/>;/);
  const ext = code('components/cabinet/ExtensionActivate.tsx');
  assert.match(ext, /const listed = choice\?\.qnet === qnet && view\.nodes\.includes\('light'\);/);
  // The record's card: what needs no record goes on meanwhile, and it says when the network does not answer.
  const recording = steps.slice(steps.indexOf('export function Recording('), steps.indexOf('function PhoneReady('));
  assert.match(recording, /\{askAgain && \(\s*<>\s*<p>\{t\('next_phone_ready'\)\}<\/p>\s*<ol className="activate-facts">\s*<PhoneReady \/>/);
  assert.match(recording, /\{view\.networkDown && choice\?\.qnet === qnet && <p className="activate-note" role="status">\{t\('next_network_down'\)\}<\/p>\}/);
  assert.match(TEXTS.next_recording, /every few seconds and moves on to linking your phone as soon as the network lists the node\.$/);
  assert.doesNotMatch(TEXTS.next_recording, /half minute/);
});

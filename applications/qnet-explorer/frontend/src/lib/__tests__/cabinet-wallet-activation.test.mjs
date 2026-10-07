// Where a wallet's activation stands (src/lib/cabinet/wallet-activation.ts, shared contract C9), as every page of My
// node shows it: the table of every state from the network, the site's record with its search of the wallet's Solana
// address, the QNet extension (qnet_getActivation) and this browser; a burn is offered only in `none`, never while any
// source is loading, locked or unreachable; positive evidence wins; the sections and the progress follow the state
// (src/lib/cabinet/tabs.ts). Also the extension's read-only answer checked exactly (qnet-link.ts validateGetActivation).
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIEW_STATES, activationView, c9Name, knownBurn, parseWalletNode, wayOf } from '../cabinet/wallet-activation.ts';
import { journey, journeySteps, landingTab, visibleTabs } from '../cabinet/tabs.ts';
import { activationCode, lightNodeId, superNodeId, validateGetActivation } from '../qnet-link.ts';
import { parseSuperStatus, superState } from '../cabinet/node-view.ts';
import { recordCode } from '../cabinet/burn-record.ts';

const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const W = V.wallets[0].address;
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const TX = V.node[0].burnTx;
const OTHER_TX = V.node[1]?.burnTx ?? 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx';

const ok = (value) => ({ phase: 'ok', value });
const LOADING = { phase: 'loading' };
const DOWN = { phase: 'unavailable' };
const light = (over = {}) => ({
  registered: false, pending: false, deviceBound: false, answeredThisEpoch: false, needsReactivation: false,
  counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null, ...over,
});
const superS = (over = {}) => ({ registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null, ...over });
const record = (over = {}) => ({
  wallet: W, state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, until: null, recordedAt: null, scan: null, ...over,
});
const CLEAN_SCAN = { complete: true, unusable: false, burns: [] };
const ext = (value) => ({ phase: 'ok', value });
const EXT_NONE = ext({ status: 'none', qnet: W, solana: SOL });

// Every source says none, for a wallet the extension holds.
const base = (over = {}) => ({
  choice: { qnet: W, source: 'extension', solana: SOL },
  network: ok({ state: 'none' }),
  light: ok(light()),
  superStatus: ok(superS()),
  server: ok(record()),
  scan: CLEAN_SCAN,
  extension: EXT_NONE,
  kept: null,
  records: [],
  ...over,
});
const stateOf = (over) => activationView(base(over)).state;

test('none only when every source says none; any loading source is loading, never none', () => {
  assert.equal(stateOf({}), 'none');
  // A wallet QNet Wallet shared: the server's search of its Solana address stands in for the extension's.
  assert.equal(stateOf({ choice: { qnet: W, source: 'app', solana: SOL }, extension: { phase: 'na' } }), 'none');
  for (const [name, over] of [
    ['network', { network: LOADING }],
    ['server', { server: LOADING }],
    ['extension', { extension: LOADING }],
    ['extension searching', { extension: ext({ status: 'searching', qnet: W, solana: SOL }) }],
    ['search not read yet', { choice: { qnet: W, source: 'app', solana: SOL }, extension: { phase: 'na' }, scan: null }],
  ]) assert.equal(stateOf(over), 'loading', name);
});

test('a burn is refused while any one source cannot answer: the view names it', () => {
  const unknown = (over) => activationView(base(over));
  assert.deepEqual(unknown({ network: DOWN }).missing, ['network']);
  assert.deepEqual(unknown({ server: DOWN }).missing, ['server']);
  assert.deepEqual(unknown({ extension: { phase: 'failed', failure: 'timeout' } }).missing, ['extension']);
  assert.deepEqual(unknown({ extension: ext({ status: 'unknown', qnet: W, solana: SOL, reason: 'HISTORY_TOO_LONG' }) }).missing, ['extension']);
  assert.deepEqual(unknown({ choice: { qnet: W, source: 'app', solana: SOL }, extension: { phase: 'na' }, scan: { complete: false, unusable: false, burns: [] } }).missing, ['solana']);
  for (const over of [{ network: DOWN }, { server: DOWN }, { extension: { phase: 'failed', failure: 'failed' } }]) assert.equal(stateOf(over), 'unknown');
  // An extension too old for qnet_getActivation (4200): its source is not known, and the page asks for an update.
  const old = unknown({ extension: { phase: 'failed', failure: 'unsupported' } });
  assert.equal(old.state, 'unknown');
  assert.equal(old.extensionUpdate, true);
  // The extension's complete search stands for the Solana source even when the server's search did not finish.
  assert.equal(stateOf({ scan: { complete: false, unusable: false, burns: [] } }), 'none');
});

test('locked or not connected: nothing is offered, unless something positive is known', () => {
  const locked = activationView(base({ extension: ext({ status: 'locked' }) }));
  assert.equal(locked.state, 'locked');
  assert.equal(locked.lockedBy, 'locked');
  assert.equal(activationView(base({ extension: ext({ status: 'not_connected' }) })).lockedBy, 'not_connected');
  assert.equal(stateOf({ extension: ext({ status: 'no_wallet' }) }), 'unknown');
  const burned = record({ state: 'recorded', nodeType: 'light', way: 'extension', burner: SOL, burnTx: TX, burnAmount: 1500, code: recordCode('extension', 'light', W, SOL, TX, 1500), recordedAt: 1 });
  assert.equal(stateOf({ extension: ext({ status: 'locked' }), server: ok(burned) }), 'burned');
});

test('positive evidence wins over unknown: node > recording > burned > sending > reserved', () => {
  const registered = light({ registered: true, deviceBound: true });
  assert.equal(stateOf({ light: ok(registered), server: DOWN, extension: { phase: 'failed', failure: 'timeout' } }), 'node');
  assert.equal(stateOf({ light: ok(light({ pending: true })), server: DOWN }), 'recording');
  assert.equal(stateOf({ network: ok({ state: 'registered', nodeId: superNodeId(W), nodeType: 'super' }), superStatus: LOADING }), 'node');
  assert.equal(stateOf({ server: ok(record({ state: 'reserved', nodeType: 'light', way: 'payment', burnAmount: 1500, until: 5 })) }), 'reserved');
  assert.equal(stateOf({ server: ok(record({ state: 'sending', nodeType: 'super', way: 'extension', burner: SOL, burnTx: TX, burnAmount: 1500, until: 9 })) }), 'sending');
  assert.equal(stateOf({ extension: ext({ status: 'pending', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500 }) }), 'sending');
  // A2: a payment address's final burn is the wallet's record like the extension's, whatever the network says.
  const paid = record({ state: 'recorded', nodeType: 'light', way: 'payment', burner: SOL, burnTx: TX, burnAmount: 1500, code: recordCode('payment', 'light', W, SOL, TX, 1500), recordedAt: 1 });
  assert.equal(stateOf({ server: ok(paid), network: DOWN }), 'burned');
  assert.deepEqual([activationView(base({ server: ok(paid) })).burn.source, activationView(base({ server: ok(paid) })).burn.way], ['record', 'payment']);
  assert.deepEqual(VIEW_STATES, ['loading', 'locked', 'unknown', 'none', 'reserved', 'sending', 'burned', 'recording', 'node']);
});

test('every C9 state, by name', () => {
  const name = (over) => c9Name(activationView(base(over)));
  const recorded = (nodeType, way = 'extension') => record({
    state: 'recorded', nodeType, way, burner: SOL, burnTx: TX, burnAmount: 1500, code: recordCode(way, nodeType, W, SOL, TX, 1500), recordedAt: 1,
  });
  assert.equal(name({}), 'none');
  assert.equal(name({ server: ok(recorded('light')) }), 'burned-light');
  assert.equal(name({ server: ok(recorded('super')) }), 'burned-super');
  assert.equal(name({ extension: ext({ status: 'exists', qnet: W, solana: SOL, nodeType: 'super', burnTx: TX, burnAmount: 1500, code: activationCode('super', SOL, TX, 1500), paidOnSite: false }) }), 'burned-super');
  assert.equal(name({ choice: { qnet: W, source: 'app', solana: SOL }, extension: { phase: 'na' }, scan: { complete: true, unusable: false, burns: [{ burnTx: TX, nodeType: 'light', burnAmount: 1500 }] } }), 'burned-light');
  assert.equal(name({ extension: ext({ status: 'unusable', qnet: W, solana: SOL }) }), 'burned');
  assert.equal(name({ light: ok(light({ pending: true })) }), 'recording');
  assert.equal(name({ light: ok(light({ registered: true, deviceBound: true })) }), 'light-running');
  assert.equal(name({ light: ok(light({ registered: true })) }), 'light-not-linked');
  assert.equal(name({ light: ok(light({ registered: true, deviceBound: true, needsReactivation: true })) }), 'light-offline');
  assert.equal(name({ superStatus: ok(superS({ registered: true, online: true })) }), 'super-online');
  assert.equal(name({ superStatus: ok(superS({ registered: true })) }), 'super-offline');
  // A wallet with both nodes on the chain (registered with both before the network's one-node rule) shows both, and is
  // offered nothing.
  assert.equal(name({ light: ok(light({ registered: true, deviceBound: true })), superStatus: ok(superS({ registered: true, online: true })) }), 'light-running+super-online');
  for (const over of [{ server: DOWN }, { extension: ext({ status: 'locked' }) }, { network: LOADING }]) assert.notEqual(name(over), 'none');
});

test('the code a burned wallet shows: the server\'s record, then the extension, the search, the kept answer, this browser', () => {
  const code = activationCode('super', SOL, TX, 1500);
  const exists = ext({ status: 'exists', qnet: W, solana: SOL, nodeType: 'super', burnTx: TX, burnAmount: 1500, code, paidOnSite: false });
  const rec = record({ state: 'recorded', nodeType: 'light', way: 'payment', burner: SOL, burnTx: OTHER_TX, burnAmount: 1500, code: recordCode('payment', 'light', W, SOL, OTHER_TX, 1500), recordedAt: 1 });
  assert.equal(knownBurn(base({ server: ok(rec), extension: exists })).burn.source, 'record');
  assert.equal(knownBurn(base({ extension: exists })).burn.code, code);
  const paid = ext({ status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: activationCode('light', W, TX, 1500), paidOnSite: true });
  assert.equal(knownBurn(base({ extension: paid })).burn.way, 'payment');
  const kept = { status: 'ok', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: activationCode('light', SOL, TX, 1500), at: 1 };
  assert.equal(knownBurn(base({ kept, extension: { phase: 'na' }, choice: { qnet: W, source: 'app' } })).burn.source, 'kept');
  assert.equal(knownBurn(base()).burn, null);
});

test('sending and reserved: in the browser that holds the activation it goes on; elsewhere the page says where', () => {
  const held = { v: 1, pub: SOL, key: {}, network: 'testnet', createdAt: 1, updatedAt: 2, stage: 'burnSent', burn: { tx: TX, lastValidBlockHeight: 5, amount: 1500 }, link: null, answer: null, submit: null, refund: null, reservation: { id: 'a'.repeat(32), wallet: W, until: 9, amount: 1500 } };
  const sending = record({ state: 'sending', nodeType: 'light', way: 'payment', burner: SOL, burnTx: TX, burnAmount: 1500, until: 99 });
  assert.equal(activationView(base({ server: ok(sending), records: [held] })).here, true);
  assert.equal(activationView(base({ server: ok(sending), records: [] })).here, false);
  // A record waiting for QNet Wallet's confirmation names its wallet, but holds no reservation of its own yet.
  const confirming = { ...held, stage: 'walletConfirm', burn: null, reservation: undefined, wallet: W };
  assert.equal(activationView(base({ server: ok(record({ state: 'reserved', nodeType: 'light', way: 'payment', burnAmount: 1500, until: 7 })), records: [confirming] })).here, false);
  const reserved = record({ state: 'reserved', nodeType: 'light', way: 'payment', burnAmount: 1500, until: 9 });
  const funded = { ...held, stage: 'funded', burn: null };
  assert.equal(activationView(base({ server: ok(reserved), records: [funded] })).here, true);
  assert.equal(activationView(base({ server: ok(reserved), records: [] })).here, false);
});

test('this browser\'s own final payment burn is the wallet\'s burn while the server does not show it, never a second offer', () => {
  const held = { v: 1, pub: SOL, key: {}, network: 'testnet', createdAt: 1, updatedAt: 2, stage: 'burnFinal', burn: { tx: TX, lastValidBlockHeight: 5, amount: 1500 }, link: null, answer: null, submit: null, refund: null, reservation: { id: 'a'.repeat(32), wallet: W, until: 9, amount: 1500 } };
  // The server has no record of it (a burn from before the record), another browser reserved the wallet since, or the
  // server cannot answer.
  for (const [name, over] of [
    ['server none', {}],
    ['another reservation', { server: ok(record({ state: 'reserved', nodeType: 'light', way: 'payment', burnAmount: 1500, until: 99 })) }],
    ['server down', { server: DOWN }],
    ['network loading', { network: LOADING }],
  ]) {
    const v = activationView(base({ records: [held], ...over }));
    assert.equal(v.state, 'burned', name);
    assert.equal(c9Name(v), 'burned-light', name);
    assert.deepEqual({ source: v.burn.source, way: v.burn.way, burnTx: v.burn.burnTx, code: v.burn.code }, { source: 'browser', way: 'payment', burnTx: TX, code: activationCode('light', W, TX, 1500) }, name);
  }
  // Every stage from the burn to the registration's outcome holds it, with the code of the wallet it was reserved for.
  for (const stage of ['linkOpen', 'consentVerified', 'mismatch', 'consentStale', 'nodeExists', 'beneficiaryConfirmed', 'submitted', 'refused']) {
    assert.equal(stateOf({ records: [{ ...held, stage }] }), 'burned', stage);
  }
  const bound = { ...held, stage: 'submitted', submit: { qnet: W, nodeId: lightNodeId(W), ts: 1, attempts: 1, txHash: null, admittedAt: null, lastCode: null } };
  assert.equal(activationView(base({ records: [bound] })).burn.code, activationCode('light', W, TX, 1500));
  // A record from before the reservations names its wallet by its request.
  const older = { ...held, reservation: undefined, link: { qr: false, held: true, named: W, request: { burnTx: TX, walletHash: null, check: false } } };
  assert.equal(stateOf({ records: [older] }), 'burned');
  // A burn given up, one another burn overtook, or one for another wallet is not this wallet's.
  for (const other of [{ ...held, stage: 'closing' }, { ...held, stage: 'otherBurn' }, { ...held, reservation: { ...held.reservation, wallet: V.wallets[1].address } }]) {
    assert.equal(stateOf({ records: [other] }), 'none', other.stage);
  }
  // The server's record of that burn comes first: the wallet's record, the same burn.
  const paid = record({ state: 'recorded', nodeType: 'light', way: 'payment', burner: SOL, burnTx: TX, burnAmount: 1500, code: recordCode('payment', 'light', W, SOL, TX, 1500), recordedAt: 1 });
  const shown = activationView(base({ server: ok(paid), records: [held] }));
  assert.deepEqual([shown.state, shown.burn.source, shown.burn.burnTx], ['burned', 'record', TX]);
});

test('sections and progress follow the state: Activate only in none; a known burn marks Activate done; super steps', () => {
  const v = (over) => activationView(base(over));
  assert.deepEqual(visibleTabs('none', false, 'overview'), ['overview', 'activate', 'device', 'history']);
  for (const state of ['loading', 'locked', 'unknown', 'reserved', 'sending', 'burned', 'recording', 'node']) {
    assert.deepEqual(visibleTabs(state, false, 'overview'), ['overview', 'device', 'history'], state);
  }
  assert.deepEqual(visibleTabs('burned', true, 'overview'), ['overview', 'activate', 'device', 'history'], 'an unfinished activation of this browser');
  assert.equal(landingTab('none', false), 'activate');
  assert.equal(landingTab('none', true), 'overview');
  assert.equal(landingTab('loading', false), null);
  for (const state of ['locked', 'unknown', 'burned', 'node', 'reserved']) assert.equal(landingTab(state, false), 'overview', state);
  assert.deepEqual(journey(false, null), { done: 0, current: 0, nodeType: null });
  assert.deepEqual(journey(true, v({})), { done: 1, current: 1, nodeType: null });
  const burnedSuper = v({ extension: ext({ status: 'exists', qnet: W, solana: SOL, nodeType: 'super', burnTx: TX, burnAmount: 1500, code: activationCode('super', SOL, TX, 1500), paidOnSite: false }) });
  assert.deepEqual(journey(true, burnedSuper), { done: 2, current: 2, nodeType: 'super' });
  assert.deepEqual(journeySteps('super'), ['connect', 'activate', 'server', 'running']);
  assert.deepEqual(journeySteps('light'), ['connect', 'activate', 'link', 'running']);
  assert.deepEqual(journey(true, v({ light: ok(light({ registered: true })) })), { done: 2, current: 2, nodeType: 'light' });
  assert.deepEqual(journey(true, v({ superStatus: ok(superS({ registered: true, online: true })) })), { done: 4, current: null, nodeType: 'super' });
  assert.equal(wayOf(v({ light: ok(light({ pending: true })) })), 'light');
});

test('the extension\'s read-only answer is checked exactly (C5), its code against its burn', () => {
  const codeOwn = activationCode('light', SOL, TX, 1500);
  const good = [
    { status: 'no_wallet' }, { status: 'locked' }, { status: 'not_connected' },
    { status: 'searching', qnet: W, solana: SOL }, { status: 'unknown', qnet: W, solana: SOL, reason: 'SOLANA_UNAVAILABLE' },
    { status: 'unusable', qnet: W, solana: SOL }, { status: 'none', qnet: W, solana: SOL },
    { status: 'pending', qnet: W, solana: SOL, nodeType: 'super', burnTx: TX, burnAmount: 1500 },
    { status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: codeOwn, paidOnSite: false },
    { status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: activationCode('light', W, TX, 1500), paidOnSite: true },
  ];
  for (const g of good) assert.deepEqual(validateGetActivation(g), g, g.status);
  const bad = [
    { status: 'none' }, { status: 'locked', qnet: W }, { status: 'unknown', qnet: W, solana: SOL, reason: 'X' },
    { status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1500, code: codeOwn, paidOnSite: true },
    { status: 'exists', qnet: W, solana: SOL, nodeType: 'super', burnTx: TX, burnAmount: 1500, code: activationCode('super', W, TX, 1500), paidOnSite: true },
    { status: 'exists', qnet: W, solana: SOL, nodeType: 'light', burnTx: TX, burnAmount: 1501, code: codeOwn, paidOnSite: false },
    { status: 'pending', qnet: W, solana: SOL, nodeType: 'full', burnTx: TX, burnAmount: 1500 },
    { status: 'none', qnet: W, solana: SOL, extra: 1 }, null, 'none', { status: 'toString' },
  ];
  for (const b of bad) assert.equal(validateGetActivation(b), null, JSON.stringify(b));
});

test('the network\'s and the super node\'s answers are read exactly', () => {
  assert.deepEqual(parseWalletNode({ state: 'none' }), { state: 'none' });
  assert.deepEqual(parseWalletNode({ state: 'registered', nodeId: lightNodeId(W), nodeType: 'light' }), { state: 'registered', nodeId: lightNodeId(W), nodeType: 'light' });
  for (const bad of [{ state: 'none', x: 1 }, { state: 'registered', nodeId: 'X Y', nodeType: 'light' }, { state: 'registered', nodeId: 'a', nodeType: 'full' }, null]) assert.equal(parseWalletNode(bad), null);
  const online = superS({ registered: true, online: true, lastSeenAt: 1_790_000_000_000, heartbeats: { current: 7, required: 9 }, balanceNano: '2500000000' });
  assert.deepEqual(parseSuperStatus(online), online);
  assert.equal(superState(online), 'online');
  assert.equal(superState(superS({ registered: true })), 'offline');
  for (const bad of [{ ...online, extra: 1 }, { ...online, heartbeats: { current: 1, required: 0 } }, superS({ online: true }), { ...online, balanceNano: '01' }]) {
    assert.equal(parseSuperStatus(bad), null, JSON.stringify(bad));
  }
});

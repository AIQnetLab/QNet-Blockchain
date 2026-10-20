// My node in concept B (B-SPEC 5.18-5.20, 6.7): the sections from one list for the rail, the thumb bar and the header's
// account menu; the journey only while a step after Activate is open; the activation's four numbered steps; the last 12
// epochs and what each epoch added; every entity a link; a layout whose size does not wait for its data.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { accountRows, nodeLines } from '../account-menu.ts';
import { ACTIVATE_STEPS, activationStep, stepAt } from '../cabinet/activate-steps.ts';
import { BAR_EPOCHS, STRIP_EPOCHS, lastEpochs, perEpochBars, stripRest } from '../cabinet/epoch-strip.ts';
import { STAGES } from '../cabinet/flow.ts';
import { TAB_HREF, navItems, showJourney } from '../cabinet/tabs.ts';
import { at, clockAgo, clockAt } from '../format.ts';
import { TEXTS } from '../texts.ts';
import { SRC, code, read } from './source.mjs';

const ok = (value) => ({ phase: 'ok', value });
const LOADING = { phase: 'loading' };
const NANO = (qnc) => String(BigInt(Math.round(qnc * 1e6)) * 1000n);
const DEVICE = { platform: 'android', model: 'Pixel 8', linkedSince: 1_789_948_800, lastAnswerEpoch: 281, state: 'online', lastMiss: null };
const light = (over = {}) => ({
  registered: true, pending: false, deviceBound: true, answeredThisEpoch: true, needsReactivation: false,
  counted: { sinceRegistration: 10, counted: 9, lastCountedEpoch: 280 }, features: [], balanceNano: NANO(10478.743462), device: DEVICE, ...over,
});
const NO_LIGHT = { ...light(), registered: false, device: null, balanceNano: null };
const superNode = (over = {}) => ({
  registered: true, online: true, lastSeenAt: 1, heartbeats: null, banned: false, balanceNano: NANO(3), admission: 'admitted', admitted: true,
  onPace: true, networkHeight: 10, serverHeight: 10, connected: false, ...over,
});
const NO_SUPER = { ...superNode(), registered: false, online: false, balanceNano: null, connected: true };
const row = (epoch, result, amountQnc = null) => ({ epoch, result, amountQnc, startedAt: null, endedAt: null, claimTx: null, miss: null });
const history = (rows) => ok({ registeredEpoch: 1, archived: true, rows, more: false, earned: null });

const reads = (over = {}) => ({ network: ok({ state: 'registered', nodeId: 'light_mobile_1', nodeType: 'light' }), light: ok(light()), superNode: ok(NO_SUPER), history: history([row(281, 'counted', 1.13)]), ...over });

test('the sections: one list for the rail and the bar, its data from the account menu\'s own rows', () => {
  const rows = accountRows(reads());
  const items = navItems('node', false, 'overview', false, rows, null);
  assert.deepEqual(items.map((i) => [i.tab, i.href, i.label, i.datum, i.tone]), [
    ['overview', TAB_HREF.overview, 'Overview', '10,478.743462 QNC', 'signal'],
    ['device', TAB_HREF.device, 'Device', 'Pixel 8 · Android', null],
    ['history', TAB_HREF.history, 'History', 'Epoch 281', null],
  ]);
  // The rail and the account menu say the same: the menu's balance, device and newest epoch are the sections' data.
  const menu = Object.fromEntries(rows.map((r) => [r.key, r.datum]));
  assert.deepEqual(items.map((i) => i.datum), [menu.balance, menu.device, menu.history]);
  // An epoch not counted is Ember in both.
  const missed = navItems('node', false, 'history', false, accountRows(reads({ history: history([row(282, 'missed')]) })), null);
  assert.equal(missed.find((i) => i.tab === 'history').tone, 'ember');
  // Under 1 QNC the balance is not Signal.
  const low = navItems('node', false, 'overview', false, accountRows(reads({ light: ok(light({ balanceNano: NANO(0.5) })) })), null);
  assert.equal(low[0].tone, null);
  // Not read yet: a dash in place ("—"), never a guess.
  assert.deepEqual(navItems(null, false, 'overview', false, accountRows({ network: LOADING, light: LOADING, superNode: LOADING, history: LOADING }), null).map((i) => i.datum), [null, null, null]);
});

test('a wallet without a node lists Overview and Activate (its step in Ember); Device and History join once a node exists', () => {
  const rows = accountRows(reads({ network: ok({ state: 'none' }), light: ok(NO_LIGHT), history: LOADING }));
  const items = navItems('none', false, 'activate', false, rows, 1);
  assert.deepEqual(items.map((i) => [i.tab, i.datum, i.tone]), [['overview', 'No node yet', null], ['activate', 'Step 2 of 4', 'ember']]);
  // The menu's Activate row says the same step.
  assert.equal(rows.find((r) => r.key === 'activate').datum, items[1].datum);
  // A burn on its way or being recorded: still no node, Overview only (Activate while this browser's activation is open).
  for (const state of ['reserved', 'sending', 'burned', 'recording']) {
    assert.deepEqual(navItems(state, false, 'overview', false, rows, 2).map((i) => i.tab), ['overview'], state);
    assert.deepEqual(navItems(state, true, 'overview', false, rows, 2).map((i) => i.tab), ['overview', 'activate'], state);
  }
  // A page opened directly stays listed, so the current section is always marked.
  assert.deepEqual(navItems('none', false, 'device', false, rows, 1).map((i) => i.tab), ['overview', 'activate', 'device']);
  // An address only viewed is offered no Activate.
  assert.deepEqual(navItems('none', false, 'overview', true, rows, 1).map((i) => i.tab), ['overview']);
});

test('a super node: the server\'s state stands where a device would; both nodes: each with its own line, light first', () => {
  const sup = reads({ network: ok({ state: 'registered', nodeId: 'super_node_1', nodeType: 'super' }), light: ok(NO_LIGHT), superNode: ok(superNode()) });
  const items = navItems('node', false, 'device', false, accountRows(sup), null);
  assert.deepEqual(items.map((i) => i.datum), ['3 QNC', 'Server online', 'Epoch 281']);
  assert.deepEqual(nodeLines(sup), [{ nodeType: 'super', words: 'Super node · Online', mark: 'live' }]);
  const both = reads({ superNode: ok(superNode({ online: false, lastSeenAt: null, heartbeats: null })) });
  const lines = nodeLines(both);
  assert.deepEqual(lines.map((l) => l.nodeType), ['light', 'super']);
  assert.equal(lines[0].words, 'Light node · Online');
  assert.equal(accountRows(both)[0].datum, 'Light and super node');
  assert.deepEqual(nodeLines(reads({ light: ok(NO_LIGHT) })), []);
});

test('the device\'s datum: its name, or its state where the name is not known; an unlinked device is no device', () => {
  const device = (d, over = {}) => accountRows(reads({ light: ok(light({ device: { ...DEVICE, ...d }, ...over })) })).find((r) => r.key === 'device').datum;
  assert.equal(device({}), 'Pixel 8 · Android');
  // An address only viewed reads no platform or model (node-view.ts publicStatus): the state, never "No device".
  assert.equal(device({ platform: null, model: null }), 'Online');
  assert.equal(device({ platform: null, model: null, state: 'offline' }), 'Offline');
  assert.equal(device({ state: 'other_device_pending' }), 'Pixel 8 · Android');
  // A device the network unlinked runs nothing, whatever it said it was.
  assert.equal(device({ state: 'unlinked' }), 'No device');
  // A node of an earlier version names no device: its binding decides.
  assert.equal(accountRows(reads({ light: ok(light({ device: null })) })).find((r) => r.key === 'device').datum, 'Online');
  assert.equal(accountRows(reads({ light: ok(light({ device: null, deviceBound: false })) })).find((r) => r.key === 'device').datum, 'No device');
});

// B-SPEC 5.18: one progress indicator at a time.
test('the journey shows only while a step after Activate is open: never on Activate, never once running', () => {
  const view = (over) => ({ state: 'node', missing: [], until: null, light: null, superNode: null, superConnected: false, superId: null, nodes: [], burn: null, here: false, extensionUpdate: false, lockedBy: null, unusable: false, networkDown: false, ...over });
  const linkNow = view({ nodes: ['light'], light: 'no_device' });
  assert.equal(showJourney('overview', true, linkNow), true);
  assert.equal(showJourney('device', true, linkNow), true);
  assert.equal(showJourney('activate', true, linkNow), false, 'its numbered steps say where it is');
  assert.equal(showJourney('overview', true, view({ nodes: ['light'], light: 'offline' })), true);
  assert.equal(showJourney('overview', true, view({ nodes: ['super'], superNode: 'waiting' })), true);
  assert.equal(showJourney('overview', true, view({ nodes: ['light'], light: 'online' })), false, 'running');
  assert.equal(showJourney('overview', true, view({ nodes: ['super'], superNode: 'online' })), false, 'running');
  assert.equal(showJourney('overview', true, view({ state: 'none' })), false, 'Activate is the step');
  assert.equal(showJourney('overview', false, null), false, 'connect is the step');
  // The steps under it carry no list of checks of their own.
  assert.doesNotMatch(code('components/cabinet/NextSteps.tsx'), /next_step_|cabinet-checks|<Steps/);
});

test('the activation\'s four numbered steps: each stage at its step, the stages outside them without steps', () => {
  assert.equal(ACTIVATE_STEPS, 4);
  const expected = {
    walletConfirm: 1, funding: 2, funded: 3, burnSent: 3, burnUnknown: 3, burnFailed: 3, burnFinal: 4, linkOpen: 4, consentVerified: 4, mismatch: 4,
    consentStale: 4, nodeExists: 4, beneficiaryConfirmed: 4, submitted: 4, refused: 4, onChain: 4, done: 5, otherBurn: null, leftovers: null, closing: null,
  };
  for (const stage of STAGES) assert.equal(activationStep(stage), expected[stage], stage);
  assert.deepEqual(Object.keys(expected).sort(), [...STAGES].sort());
  assert.deepEqual([1, 2, 3, 4].map((n) => stepAt(n, 3)), ['done', 'done', 'now', 'ahead']);
  assert.deepEqual([1, 2, 3, 4].map((n) => stepAt(n, 5)), ['done', 'done', 'done', 'done']);
  // The page draws the four steps from that mark; the burn waits, disabled, with the line that says when it opens.
  const page = code('components/cabinet/NodeActivate.tsx');
  assert.match(page, /const now = activationStep\(stage\);/);
  for (const n of [1, 2, 3, 4]) assert.match(page, new RegExp(`<Step n=\\{${n}\\} at=\\{stepAt\\(${n}, now\\)\\}`), String(n));
  assert.match(page, /<Action kind="solid" disabled>\{t\('act_burn'\)\}<\/Action>\s*<p className="note">\{t\('act_burn_opens'\)\}<\/p>/);
  assert.equal(TEXTS.act_burn_opens, 'Opens once both amounts have arrived.');
  // "Cancel this activation" is never the solid action.
  assert.match(page, /<Action kind="text" onClick=\{\(\) => void cancel\(\)\} disabled=\{working\}>\{t\('act_discard'\)\}<\/Action>/);
});

test('the last 12 epochs: oldest first, counted Paper, not counted Ember, the network\'s own an outline; the line names the newest miss', () => {
  const rows = [row(290, 'counted', 1), row(289, 'missed'), row(288, 'moved', 1), row(287, 'unchecked'), ...Array.from({ length: 20 }, (_, i) => row(286 - i, 'counted', 1))];
  const cells = lastEpochs(rows);
  assert.equal(STRIP_EPOCHS, 12);
  assert.equal(cells.length, 12);
  assert.deepEqual([cells[0].epoch, cells[11].epoch], [279, 290]);
  assert.deepEqual(cells.slice(-4).map((c) => c.tone), ['quiet', 'counted', 'missed', 'counted']);
  assert.equal(stripRest(cells).epoch, 289, 'the newest epoch not counted');
  assert.equal(stripRest(lastEpochs([row(5, 'counted', 1), row(4, 'counted', 1)])).epoch, 5, 'else the newest');
  assert.equal(stripRest([]), null);
  // Fewer than 12: the strip keeps its 12 cells (empty ones first), so it never changes size.
  const strip = code('components/cabinet/EpochCharts.tsx');
  assert.match(strip, /\{Array\.from\(\{ length: STRIP_EPOCHS - cells\.length \}, \(_, i\) => <i key=\{`pad-\$\{i\}`\} className="cab-cell" aria-hidden="true" \/>\)\}/);
  // Each cell is a button that names its epoch and result; the line under the strip says it.
  assert.match(strip, /aria-label=\{cellWords\(cell\)\}/);
  assert.equal(TEXTS.strip_epoch, 'Epoch {epoch} · {result}');
});

test('added per epoch: bars to the tallest, moved in Fog, a tick for not counted, a marker after the newest move; none without amounts', () => {
  assert.equal(BAR_EPOCHS, 16);
  assert.equal(perEpochBars([row(3, 'missed'), row(2, 'unchecked')]), null, 'nothing added: no picture');
  const bars = perEpochBars([row(10, 'counted', 2), row(9, 'missed'), row(8, 'moved', 1), row(7, 'moved', 0.5), row(6, 'unchecked'), row(5, 'joined')]);
  assert.equal(bars.max, 2);
  assert.deepEqual(bars.bars.map((b) => [b.epoch, b.kind, b.height]), [[5, 'none', 0], [6, 'quiet', 0], [7, 'moved', 0.25], [8, 'moved', 0.5], [9, 'missed', 0], [10, 'balance', 1]]);
  assert.equal(bars.marker, 3, 'after epoch 8, the newest moved');
  assert.equal(perEpochBars([row(2, 'counted', 1)]).marker, null);
  assert.equal(perEpochBars(Array.from({ length: 30 }, (_, i) => row(100 - i, 'counted', 1))).bars.length, 16);
});

test('every entity in My node is a link in the one look: node ids, blocks, transactions, Solana burns', () => {
  // The node id: its wallet's address page (B-SPEC 5.7), in the rail's head, the details and the head of each node.
  assert.match(code('components/cabinet/CabinetNav.tsx'), /<EntityLink kind="node" value=\{id\} address=\{wallet\} \/>/);
  assert.match(code('components/cabinet/NodeDetails.tsx'), /<EntityLink kind="node" value=\{nodeId\} address=\{choice\?\.qnet \?\? null\} full \/>/);
  assert.match(code('components/cabinet/NodeHome.tsx'), /<EntityLink kind="node" value=\{nodeId\} address=\{choice\?\.qnet \?\? null\} \/>/);
  // "Recorded at block N" and a server's heights: the block page.
  assert.match(code('components/cabinet/NodeDetails.tsx'), /rich\('code_status_recorded_at', \{ height: <EntityLink kind="block" value=\{height\} \/> \}\)/);
  assert.match(code('components/cabinet/NodeStatus.tsx'), /const height = <EntityLink kind="block" value=\{server\} \/>;/);
  // Each epoch's move to the wallet: its transaction page; an amount's unit: the QNC page.
  assert.match(code('components/cabinet/NodeHistory.tsx'), /<EntityLink kind="tx" value=\{row\.claimTx\} \/>/);
  assert.match(code('components/cabinet/NodeHistory.tsx'), /<Amount value=\{AMOUNT\.format\(row\.amountQnc\)\} \/>/);
  // The wallet a node is for, wherever a sentence names it, and the address only viewed: its address page.
  const activate = code('components/cabinet/NodeActivate.tsx');
  for (const key of ['act_reserve_lead', 'act_reserve_done', 'act_link_named']) {
    assert.match(activate, new RegExp(`rich\\('${key}', \\{ wallet: <EntityLink kind="address" value=\\{named\\} /> \\}\\)`), key);
  }
  assert.doesNotMatch(activate, /t\('act_(reserve_lead|reserve_done|link_named)', \{ wallet: shortAddress/);
  assert.match(code('components/cabinet/CabinetNav.tsx'), /rich\('view_line', \{ wallet: <EntityLink kind="address" value=\{wallet\} \/> \}\)/);
  // Burns on Solana leave the site (↗), never a bare hash.
  for (const file of ['NodeDetails', 'ActivateSteps', 'ExtensionActivate']) {
    const src = code(`components/cabinet/${file}.tsx`);
    assert.match(src, /<EntityLink kind="solana-tx" value=\{/, file);
    assert.doesNotMatch(src, /solanaTxUrl\(/, file);
  }
  // Copy is the site's one Copy; the cabinet keeps no copy button of its own.
  assert.equal(existsSync(new URL('components/cabinet/CopyButton.tsx', SRC)), false);
  for (const file of ['NodeDetails', 'ActivateSteps', 'ExtensionActivate', 'NextSteps']) assert.match(code(`components/cabinet/${file}.tsx`), /import Copy from '@\/components\/ui\/Copy';/, file);
});

test('nothing jumps: the area keeps its room, the Overview its geometry while it is read, the readouts two lines each', () => {
  const sheet = read('styles/cabinet.css');
  // A whole screen, uncapped: a 1366 px tall tablet saw the footer pushed down as the section filled in.
  assert.match(sheet, /\.cab \{\n[^}]*min-height: calc\(100svh - var\(--hdr\)\);/);
  assert.match(sheet, /\.cab \.readouts \{ --ro-sub-lines: 2; \}/);
  // The per-epoch chart stands as an empty frame of its final height while the epochs are read (a tablet in portrait saw
  // the epochs table pushed down when it filled); only an answer with nothing to draw leaves it out.
  const charts = code('components/cabinet/EpochCharts.tsx');
  assert.match(charts, /if \(!data && state\.phase !== 'loading'\) return null;/);
  assert.match(charts, /const cols = \{ '--n': data \? bars\.length : BAR_EPOCHS \} as CSSProperties;/);
  assert.match(charts, /<figure className="cab-pe" aria-busy=\{data \? undefined : true\}>/);
  // The rail's data keep their box: a datum that arrives moves nothing beside it.
  assert.match(sheet, /\.cab-nav-d \{\n {2}justify-self: end; min-width: 18ch;/);
  assert.match(sheet, /\.cab-id \{ display: grid; gap: 14px; min-height: 50px;/);
  // While the node is read, its readouts and its epochs' rows stand in place (dashes, empty rows at their height).
  const home = code('components/cabinet/NodeHome.tsx');
  assert.match(home, /<StatusGate state=\{state\} retry=\{retry\} loading=\{<Reading nodeId=\{nodeId\} \/>\}>/);
  assert.match(home, /if \(view\.state === 'loading'\) return <Reading nodeId=\{null\} \/>;/);
  assert.match(code('components/cabinet/NodeDevices.tsx'), /<StatusGate state=\{state\} retry=\{retry\} loading=\{<Reading \/>\}>/);
  assert.match(code('components/cabinet/NodeHistory.tsx'), /return view && nodeId \? <AllEpochs nodeId=\{nodeId\} first=\{view\} \/> : <Table rows=\{null\} loading=\{10\} \/>;/);
  // The epoch's reading follows the chain's head alone; the rest of the Overview does not re-render every block.
  assert.equal(home.match(/useChainHead\(\)/g)?.length, 1);
  assert.match(home, /function ThisEpoch\(\{ value \}: \{ value: string \| null \}\) \{\s*const \{ height \} = useChainHead\(\);\s*return <EpochReadout height=\{height\} reading=\{\{ label: epochLabel, value \}\} \/>;/);
  // A request's QR code has its box from the start; an expired one leaves the box in place.
  assert.match(code('components/cabinet/LinkWaiting.tsx'), /<svg className="cab-qr" width=\{size\} height=\{size\}/);
  assert.match(sheet, /\.cab-req-gone \{ width: 168px; height: 168px;/);
  // A row's line under it (why an epoch was not counted) is the shared table's, so History keeps fixed rows.
  assert.match(code('components/ui/DataTable.tsx'), /\{more && \(\s*<tr className="tbl-detail">\s*<td colSpan=\{columns\.length\}><div className="tbl-detail-in">\{more\}<\/div><\/td>/);
});

test('times in one form: a time to come and a time gone by, the day added past twelve hours', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0);
  assert.match(clockAt(now + 3_600_000, now), /^\d\d:\d\d$/);
  assert.equal(clockAt(now + 13 * 3_600_000, now), at(now + 13 * 3_600_000));
  assert.match(clockAgo(now - 3_600_000, now), /^\d\d:\d\d$/);
  assert.equal(clockAgo(now - 13 * 3_600_000, now), at(now - 13 * 3_600_000));
  assert.match(at(now), /^[A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/);
  // The cabinet has no date formatter of its own but the UTC day a device linked.
  for (const file of ['NodeStatus', 'NodeHistory', 'NextSteps']) {
    const formatters = code(`components/cabinet/${file}.tsx`).match(/new Intl\.DateTimeFormat\(/g)?.length ?? 0;
    assert.equal(formatters, file === 'NodeStatus' ? 1 : 0, file);
  }
});

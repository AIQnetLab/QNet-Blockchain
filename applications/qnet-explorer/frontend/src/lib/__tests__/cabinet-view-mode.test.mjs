// View by address (owner, 13.10): a typed address is a read-only view, never a connection. It is kept for the tab apart
// from the connected wallet, the header and the progress never show it as connected, no action that needs the wallet is
// offered, and neither the page nor the site's status and history routes carry the device details that are the owner's,
// not the network's (the platform, the model, the day it linked, its account of a missed epoch).
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  VIEW_KEY, WALLET_KEY, loadViewing, parseChoice, saveChoice, saveViewing, shownWallet,
} from '../cabinet/wallet-choice.ts';
import { TABS, visibleTabs } from '../cabinet/tabs.ts';
import { historyPagePath, parseHistoryView, parseStatusView, publicHistory, publicStatus, statusPath } from '../cabinet/node-view.ts';
import { createNodeProxy, viewRead } from '../../server/cabinet/node-proxy.ts';

const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const EON = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const OTHER = '60b4f3e026e24dcc7d8eonfda2b095a258ab95c1db2c0';
const SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const NODE = 'light_mobile_6526ab8fd00ff8ca';

function memory() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('a view never sets the connected state: no connected wallet, read only, and no extension taken up meanwhile', () => {
  const accounts = { qnet: EON, solana: SOL };
  // Only an address viewed: nothing connected, the address shown read only.
  for (const channel of ['extension', null]) {
    const shown = shownWallet(null, OTHER, channel, channel ? accounts : null, false);
    assert.equal(shown.connected, null, String(channel));
    assert.equal(shown.taken, null, 'the extension\'s wallet is not taken up while an address is viewed');
    assert.equal(shown.viewOnly, true);
    assert.deepEqual(shown.current, { qnet: OTHER, source: 'entered' });
  }
  // Without a view, the extension's approved wallet is taken up as before.
  assert.deepEqual(shownWallet(null, null, 'extension', accounts, false), {
    taken: { qnet: EON, source: 'extension', solana: SOL }, connected: { qnet: EON, source: 'extension', solana: SOL },
    current: { qnet: EON, source: 'extension', solana: SOL }, viewOnly: false,
  });
  assert.deepEqual(shownWallet(null, null, 'extension', accounts, true), { taken: null, connected: null, current: null, viewOnly: false });
  // A connected wallet is never shown as a view.
  const app = { qnet: EON, source: 'app', solana: SOL };
  assert.deepEqual(shownWallet(app, OTHER, null, null, false), { taken: null, connected: app, current: app, viewOnly: false });
  // The provider and the header read the one rule; the header shows only the connected wallet.
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /const \{ taken, connected, current, viewOnly \} = useMemo\(\s*\(\) => shownWallet\(choice, viewing, loaded \? channel : null, accounts, disconnected\),/);
  assert.match(provider, /return shownWallet\(kept\.choice, kept\.viewing, channel, accounts, kept\.disconnected\)\.connected\?\.qnet \?\? null;/);
  // The extension's activation is asked, and kept answers read, for a connected wallet only.
  assert.match(provider, /const applies = channel === 'extension' && connected !== null && \(connected\.source === 'extension' \|\| accounts\?\.qnet === connected\.qnet\);/);
  assert.match(provider, /const kept = connected \? activations\[connected\.qnet\] \?\? null : null;/);
});

test('the view is kept for this tab apart from the wallet, and a wallet connected with a tap ends it', () => {
  assert.equal(VIEW_KEY, 'qnet.cabinet.view');
  assert.notEqual(VIEW_KEY, WALLET_KEY);
  const tab = memory();
  saveViewing(tab, OTHER);
  assert.deepEqual([...tab.map], [[VIEW_KEY, OTHER]]);
  assert.equal(loadViewing(tab), OTHER);
  saveViewing(tab, null);
  assert.equal(tab.map.size, 0);
  tab.setItem(VIEW_KEY, `${OTHER.slice(0, -1)}1`);
  assert.equal(loadViewing(tab), null, 'not an address');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(loadViewing(blocked), null);
  assert.doesNotThrow(() => saveViewing(blocked, OTHER));
  // A typed address remembered as the wallet by an earlier version is no connected wallet.
  const area = memory();
  area.setItem(WALLET_KEY, JSON.stringify({ qnet: OTHER, source: 'entered' }));
  assert.equal(parseChoice(area.getItem(WALLET_KEY)), null);
  saveChoice(area, { qnet: EON, source: 'app', solana: SOL });
  assert.deepEqual(parseChoice(area.getItem(WALLET_KEY)), { qnet: EON, source: 'app', solana: SOL });
  // The provider keeps the view in session storage, in the one step that writes, and a connected wallet ends it.
  const provider = code('components/cabinet/CabinetProvider.tsx');
  assert.match(provider, /return window\.sessionStorage;/);
  assert.match(provider, /if \(change\.choice\) next\.viewing = null;/);
  assert.match(provider, /if \(change\.choice \|\| change\.viewing !== undefined\) saveViewing\(tabStore\(\), next\.viewing\);/);
  assert.equal(provider.match(/saveChoice\(/g)?.length, 1);
  // A wallet connected in another tab ends this tab's view too.
  assert.match(provider, /const now = storedHeld\(\);\s*if \(now\.choice\) saveViewing\(tabStore\(\), null\);/);
  // View by address starts a view, never a connected wallet.
  const choice = code('components/cabinet/WalletChoice.tsx');
  assert.match(choice, /if \(!isEonAddress\(value\)\) \{\s*setInvalid\(true\);\s*return;\s*\}\s*viewAddress\(value\);/);
  assert.doesNotMatch(choice, /source: 'entered'/);
});

test('the page while viewing: the line that it is viewed read only with Stop viewing, no progress, no wallet card, no Activate', () => {
  const frame = code('components/cabinet/CabinetFrame.tsx');
  assert.match(frame, /\{viewOnly \? <ViewingCard qnet=\{choice\.qnet\} \/> : \(\s*<>\s*<CabinetProgress connected view=\{view\} \/>\s*<WalletCard choice=\{choice\} \/>/);
  const viewing = frame.slice(frame.indexOf('function ViewingCard('), frame.indexOf('function Dashboard('));
  assert.match(viewing, /\{t\('view_line', \{ wallet: shortAddress\(qnet\) \}\)\}/);
  assert.match(viewing, /onClick=\{stopViewing\}>\{t\('view_stop'\)\}/);
  assert.doesNotMatch(viewing, /forget|disconnect|wallet_label|SOURCE_TEXT|CabinetProgress/);
  // The wallet card is a connected wallet's only.
  assert.match(frame, /function WalletCard\(\{ choice \}: \{ choice: WalletChoice \}\) \{[\s\S]*?if \(choice\.source === 'entered'\) return null;/);
  // No Activate section for a view, except on its own page.
  for (const state of ['none', 'node', null]) assert.deepEqual(visibleTabs(state, true, 'overview', true), TABS.filter((t) => t !== 'activate'), String(state));
  assert.deepEqual(visibleTabs('none', false, 'overview', false), [...TABS], 'a connected wallet keeps it');
  // The header never shows a view as the connected wallet (cabinet-reconnect.test.mjs has the rule on plain inputs): it
  // offers Connect wallet, which ends the view so that the connect card shows; connecting the extension from there ends
  // it as any tap does.
  const button = code('components/wallet/connect-wallet-button.tsx');
  assert.match(button, /const held = useHeldWallet\(\);/);
  assert.match(button, /function toConnect\(event: MouseEvent<HTMLAnchorElement>\) \{\s*endView\(\);\s*const card = document\.getElementById\(CONNECT_ID\);/);
  assert.match(code('components/cabinet/CabinetProvider.tsx'), /export function endView\(\): void \{\s*if \(\(heldHere \?\? storedHeld\(\)\)\.viewing\) hold\(\{ viewing: null \}\);\s*\}/);
});

test('the device details that are the owner\'s are left out of a view: the route\'s answer and the page alike', async () => {
  const device = { platform: 'android', model: 'Pixel 8', linkedSince: 1_789_948_800, lastAnswerEpoch: 155, state: 'online', lastMiss: { epoch: 150, reason: 'not_delivered', delivered: false } };
  const view = {
    registered: true, pending: false, deviceBound: true, answeredThisEpoch: true, needsReactivation: false,
    counted: { sinceRegistration: 6, counted: 5, lastCountedEpoch: 155 }, features: ['bind_v2'], balanceNano: '12500000000', device,
  };
  const shown = publicStatus(view);
  assert.deepEqual(shown.device, { platform: null, model: null, linkedSince: null, lastAnswerEpoch: 155, state: 'online', lastMiss: null });
  assert.deepEqual({ ...shown, device: null }, { ...view, device: null }, 'every other field is the network\'s and stays');
  assert.deepEqual(parseStatusView(shown), shown);
  assert.equal(publicStatus({ ...view, device: null }).device, null);
  assert.equal(view.device.platform, 'android', 'the cached answer itself is untouched');
  // The page's read of a view is its own address, so no connected wallet's answer is shared with it.
  assert.equal(statusPath(NODE, false), `/api/cabinet/node/${NODE}`);
  assert.equal(statusPath(NODE, true), `/api/cabinet/node/${NODE}?view=1`);
  assert.match(code('hooks/useNodeStatus.ts'), /export function useNodeStatus\(nodeId: string \| null, view: boolean\) \{\s*return useSharedRead<NodeStatusView>\(nodeId \? statusPath\(nodeId, view\) : null, parseStatusView, true\);/);
  // Every status read of the cabinet says whether it is for a view.
  const dir = new URL('components/cabinet/', SRC);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    for (const call of code(`components/cabinet/${name}`).match(/useNodeStatus\([^;]*?\)(?=\.state|;)/g) ?? []) {
      assert.match(call, /, viewOnly\)$/, `${name}: ${call}`);
    }
  }
  // History likewise (batch 18.10): a view's page carries no reason an epoch was missed, every other field stays, and its
  // read is its own address too.
  const why = { epoch: 150, reason: 'not_delivered', delivered: false };
  const page = {
    registeredEpoch: 140, archived: true, more: false, earned: null,
    rows: [
      { epoch: 151, result: 'counted', amountQnc: 1, startedAt: null, endedAt: null, claimTx: null, miss: null },
      { epoch: 150, result: 'missed', amountQnc: null, startedAt: null, endedAt: null, claimTx: null, miss: why },
    ],
  };
  const viewedPage = publicHistory(page);
  assert.deepEqual(viewedPage, { ...page, rows: page.rows.map((r) => ({ ...r, miss: null })) });
  assert.deepEqual(parseHistoryView(viewedPage), viewedPage);
  assert.equal(page.rows[1].miss, why, 'the cached page itself is untouched');
  assert.equal(historyPagePath(NODE, 0, false), `/api/cabinet/node/${NODE}/history`);
  assert.equal(historyPagePath(NODE, 0, true), `/api/cabinet/node/${NODE}/history?view=1`);
  assert.equal(historyPagePath(NODE, 2, false), `/api/cabinet/node/${NODE}/history?page=2`);
  assert.equal(historyPagePath(NODE, 2, true), `/api/cabinet/node/${NODE}/history?page=2&view=1`);
  const hooks = code('hooks/useNodeStatus.ts');
  assert.match(hooks, /export function useNodeHistory\(nodeId: string \| null, view: boolean\) \{\s*return useSharedRead<HistoryView>\(nodeId \? historyPagePath\(nodeId, 0, view\) : null, parseHistoryView, false\);/);
  assert.match(hooks, /void load\(historyPagePath\(nodeId, older\.length \+ 1, view\), parseHistoryView\)/);
  assert.doesNotMatch(hooks, /\/history/);
  const history = code('components/cabinet/NodeHistory.tsx');
  assert.equal(history.match(/useNodeHistory\(nodeId, viewOnly\)/g)?.length, 2);
  assert.match(history, /const list = useEpochList\(nodeId, first, viewOnly\);/);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    for (const call of code(`components/cabinet/${name}`).match(/use(?:NodeHistory|EpochList)\([^;]*?\)(?=;)/g) ?? []) {
      assert.match(call, /, viewOnly\)$/, `${name}: ${call}`);
    }
  }
  // The rows: the network's facts only for a view (no platform, no model, no day it linked, no miss).
  const rows = code('components/cabinet/NodeStatus.tsx');
  assert.match(rows, /const named = viewOnly \? null : device;/);
  assert.match(rows, /\{full && named && deviceName\(named\) && <p>\{deviceName\(named\)\}<\/p>\}/);
  assert.match(rows, /\{full && !viewOnly && device\?\.linkedSince != null && /);
  assert.match(rows, /const missed = !viewOnly && \(state === 'offline' \|\| \(full && state === 'online'\)\);/);
});

test('the status route: ?view=1 answers without the device\'s own details from the same cached read; anything else is 400', async () => {
  const status = {
    onchain_registered: true, registration_pending: false, device_bound: true, answered_this_epoch: true, needs_reactivation: false,
    counted: { epochs_since_registration: 6, counted: 5, last_counted_epoch: 155 }, features: ['bind_v2'],
    device: { platform: 'android', model: 'Pixel 8', linked_since: 1_789_948_800, last_answer_epoch: 155, state: 'online' },
  };
  const calls = [];
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.startsWith('/api/v1/light-node/status')) return new Response(JSON.stringify(status), { status: 200 });
    if (path.startsWith('/api/v1/rewards/pending/')) return new Response(JSON.stringify({ pending_rewards_nano: 12_500_000_000 }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const p = createNodeProxy({
    fetchFn, random: () => 0.5, now: () => 1_000_000, clientKey: () => ({ ok: true, ip: '203.0.113.9' }), scope: 'view-mode', devOrigins: false,
  });
  const get = (query = '') => new Request(`https://aiqnet.io/api/cabinet/node/${NODE}${query}`, { headers: { host: 'aiqnet.io' } });
  const full = await (await p.status(get(), NODE)).json();
  assert.equal(full.device.platform, 'android', 'a connected wallet\'s read keeps the platform');
  assert.equal(full.device.model, 'Pixel 8');
  const upstream = calls.length;
  const res = await p.status(get('?view=1'), NODE);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /android|Pixel|1789948800/);
  const viewed = JSON.parse(text);
  assert.deepEqual(viewed.device, { platform: null, model: null, linkedSince: null, lastAnswerEpoch: 155, state: 'online', lastMiss: null });
  assert.equal(viewed.balanceNano, '12500000000');
  assert.deepEqual(parseStatusView(viewed), viewed);
  assert.equal(calls.length, upstream, 'the same cached read, no second round upstream');
  for (const bad of ['?view=0', '?view=true', '?view=']) {
    const refused = await p.status(get(bad), NODE);
    assert.equal(refused.status, 400, bad);
    assert.deepEqual(await refused.json(), { error: 'invalid_request' });
  }
  assert.equal(viewRead(get()), false);
  assert.equal(viewRead(get('?view=1')), true);
  assert.equal(viewRead(get('?view=yes')), null);
});

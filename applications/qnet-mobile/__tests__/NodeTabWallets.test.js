/**
 * The Node tab of the real wallet screen for every node type. The wallet's node is the genesis nodes' word on it
 * (WalletManager.walletNode over verify-activation): the first answer that names it shows it at once, a second confirms
 * it, and only two authoritative answers that it has none take a node off the tab; the app keeps no table of genesis
 * wallets. A server node's card reads its node by id, and only an answer about that node replaces its status: any other
 * keeps the last good one, marked stale, and the wallet's record keeps that status with no expiry. A wallet with a super
 * and a light node on the chain shows both cards, the server's first, the light one only where it runs; what aiqnet.io
 * records of a super node is said only once two genesis nodes say the wallet has none. The app only
 * reads: nothing here burns, shows a code or opens a page.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
// The wallet of genesis node 001 on the live chain, which the app knows from the genesis nodes' answers alone.
const GENESIS_WALLET = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
const mockSUPER = 'super_node_5555666677778888';
const mockState = {};
const mockLinks = {};

jest.mock('../src/components/WalletManager', () => {
  // The genesis nodes' word on the wallet's node and the wallet's record of it run as the app runs them, over fetch and
  // AsyncStorage (WalletManager.walletNode, confirmServerNode, saveWalletNode).
  const Real = jest.requireActual('../src/components/WalletManager').WalletManager;
  const real = (name) => function realMethod(...args) { return Real.prototype[name].apply(this, args); };
  const { fakeWalletManager, walletManagerModule } = require('../test-support/walletMocks');
  class FakeWalletManager extends fakeWalletManager({ qnet: mockQNET, sol: mockSOL, light: mockLIGHT, superNode: mockSUPER }) {
    async loadWallet() { return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockState.qnet }; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (the live figure less this wallet's own unsettled spends): the same figure.
    async qncForSend() { return { ok: true, balanceNano: '1000000000', nonce: '4', pending: [] }; }
    async getTokenHoldings() { return []; }
    // A move's claim: which node it names, and the node's refusal (nothing to move), so nothing is in transit.
    async claimRewards(nodeType, wallet, credential, balanceNano, nodeId) {
      mockState.claims.push({ nodeType, wallet, balanceNano, nodeId });
      return { success: false, code: 'NO_REWARDS' };
    }
  }
  for (const name of ['walletNode', 'confirmServerNode', '_fromGenesis', '_verifyActivation', 'saveWalletNode', 'loadWalletNode',
    'forgetWalletNode']) {
    FakeWalletManager.prototype[name] = real(name);
  }
  return walletManagerModule(FakeWalletManager);
});

jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  readNodeStatus: jest.fn(async () => mockState.lightStatus),
  readLinkPending: jest.fn(async () => null),
  dropLinkPending: jest.fn(async () => {}),
}));

jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => ({ capable: true, platform: 'android', flags: '', report: null })),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
}));

jest.mock('../src/services/PushService', () => require('../test-support/walletMocks').pushServiceModule({
  // One genesis node's status answer by the wallet: the server card's hint that the wallet's node has another id.
  checkServerNodeStatus: jest.fn(async () => mockState.byWallet),
  getWalletNodeEvents: jest.fn(async () => mockState.events),
  getNodeEpochs: jest.fn(async (nodeId, opts) => { mockState.epochCalls.push([nodeId, opts]); return { counted: 7, missed: 2 }; }),
}));

jest.mock('../src/services/NodeRecordRead', () => ({
  ...jest.requireActual('../src/services/NodeRecordRead'),
  readNodeRecordState: jest.fn(async () => mockState.record),
}));

// The linking schedule's reads come at once here, so a test sees the next one without waiting ten seconds.
// The linking schedule's wait: 50 ms, or what a test sets in mockState.paceMs.
jest.mock('../src/utils/requestPace', () => ({ ...jest.requireActual('../src/utils/requestPace'), linkingReadMs: () => mockState.paceMs || 50 }));

jest.mock('../src/services/HistoryCache', () => ({ loadCachedHistory: jest.fn(async () => []), saveCachedHistory: jest.fn(async () => {}) }));
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View); };
});
// The link's relay session and the delivery of its answer are the test's; what the sheet offers is the app's own.
jest.mock('../src/services/QNetLink', () => ({
  ...jest.requireActual('../src/services/QNetLink'),
  parseLink: jest.fn((url) => mockLinks[url] || null),
  openSession: jest.fn(async () => ({ expiresAt: Date.now() + 600_000, request: {} })),
  prepareOffer: jest.fn((...args) => jest.requireActual('../src/services/QNetLink').prepareOffer(...args)),
  deliverAnswer: jest.fn(async () => 'delivered'),
  markHandled: jest.fn(async () => {}),
  otherNodeHint: jest.fn(async () => null),
}));

const { makeT, hasKey } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { GENESIS_NODES } = require('../src/config/nodes');
const { serverStatusOf } = require('../src/services/LightNode');
const QNetLink = require('../src/services/QNetLink');
const { fakeLinkInbox } = require('../test-support/linkInbox');
const { NODE_STATUS_MS } = require('../src/utils/requestPace');
const WalletScreen = require('../src/screens/WalletScreen').default;

// What the server card said for a node the network says is not registered, before only an answer about the node counted.
const GENERIC = "This wallet's super node is set up and managed on its server";
// A genesis node's verify-activation answer: the wallet's node by its id and type, or that it has none (authoritative).
const yes = (nodeId, nodeType = 'super') => ({ verified: true, source: 'storage_index', node_id: nodeId, node_type: nodeType });
const NO = { verified: false, authoritative: true };
const allSay = (answer) => GENESIS_NODES.map(() => answer);
// A genesis node's GET /api/v1/node/status answer for node `id` (light_nodes.rs handle_server_node_status).
const nodeAnswer = (id, over = {}) => ({
  success: true, node_id: id, node_type: 'super', registered: true, onchain_registered: true, status: 'active', is_online: true,
  last_seen: 1790000000, last_seen_ago_seconds: 30, heartbeat_count: 5, required_heartbeats: 9, pending_rewards: 4e9,
  reputation: 70, ...over,
});
const statusOf = (id, over) => serverStatusOf(nodeAnswer(id, over));
// The genesis nodes as the test has them answer (GENESIS_NODES order): verify-activation for the wallet
// (mockState.activation, undefined: no answer) and a server node's status by its id (mockState.byId).
const answered = (body) => (body === undefined ? Promise.reject(new Error('no answer'))
  : Promise.resolve({ ok: true, status: 200, json: async () => body }));
function genesisFetch(url) {
  const u = String(url);
  const i = GENESIS_NODES.findIndex((g) => u.startsWith(`${g}/`));
  if (i >= 0 && u === `${GENESIS_NODES[i]}/api/v1/verify-activation`) return answered(mockState.activation[i]);
  const byId = i >= 0 ? /\/api\/v1\/node\/status\?node_id=([^&]+)$/.exec(u) : null;
  if (byId) return answered(mockState.byId(decodeURIComponent(byId[1]), i));
  return Promise.reject(new Error('offline in tests'));
}
const statusReadsOf = (id) => global.fetch.mock.calls.filter(([u]) => String(u).endsWith(`/api/v1/node/status?node_id=${id}`)).length;
const stale = (tree) => tree.root.findAll((n) => n.type === Text && n.props.testID === 'node-server-stale').length > 0;
const kept = async () => JSON.parse((await AsyncStorage.getItem('qnet_wallet_node')) || 'null');

// Two owners' device-bound answer (contract 4) follows the first owner's unless a test names it.
const lightStatus = (over = {}) => {
  const s = {
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: null, needsReactivation: false,
    counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, ...over,
  };
  if (!('deviceBoundAgreed' in over)) s.deviceBoundAgreed = s.onChain === true ? s.deviceBound : null;
  return s;
};
// The chain's registrations of both the wallet's nodes, the super node's first.
const bothRegistered = () => ({
  success: true,
  nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 2_000_123 }, { nodeId: mockLIGHT, nodeType: 'light', height: 2_100_000 }],
});
const { flush, texts, pressText, pressId, networkFree } = require('../test-support/screen');

const mounted = [];
async function nodeTab() {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  mounted.push(tree);
  await flush(6);
  const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('enter_password'))[0];
  await act(async () => { field.props.onChangeText('abcdefghijk'); });
  const unlock = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('unlock_wallet'))).pop();
  await act(async () => { await unlock.props.onPress(); });
  await flush(6);
  await act(async () => { tree.root.find((n) => n.props.testID === 'tab-node' && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(12);
  return tree;
}

// The open tab's status refresh (every NODE_STATUS_MS, requestPace), run now; `every` spies on setInterval.
async function statusTick(every) {
  const [tick] = every.mock.calls.filter(([, ms]) => ms === NODE_STATUS_MS).pop();
  await act(async () => { tick(); });
  await flush(12);
}
// The app comes back to the front: the listeners of the app's state added since call `from` hear it.
async function resume(from) {
  const handlers = AppState.addEventListener.mock.calls.slice(from).filter((c) => c[0] === 'change').map((c) => c[1]);
  await act(async () => { await Promise.all(handlers.map((h) => Promise.resolve().then(() => h('active')).catch(() => {}))); });
  await flush(12);
}
async function pull(tree) {
  const control = tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
    && typeof n.props.refreshControl.props.onRefresh === 'function').pop();
  await act(async () => { await control.props.refreshControl.props.onRefresh(); });
  await flush(12);
}

beforeAll(() => {
  global.fetch = jest.fn(genesisFetch);
});
beforeEach(async () => {
  await AsyncStorage.clear();
  global.fetch.mockClear();
  Object.assign(mockState, {
    qnet: mockQNET, claims: [], epochCalls: [], record: null,
    // Unless a test names a node: two genesis nodes say the wallet has none, and no node answers by id or by wallet.
    activation: allSay(NO), byId: () => undefined, byWallet: { success: false, error: 'network' },
    events: { success: true, nodes: [] }, lightStatus: lightStatus({ onChain: false }),
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
});

describe('the wallet\'s nodes on the Node tab', () => {
  it('a light node of the wallet never stands in the way of its super node: both cards show, the server\'s first', async () => {
    Object.assign(mockState, {
      // The genesis nodes name the super node (the chain's rows of a wallet: its super id before its light one), online by
      // its id; the chain's registrations name both.
      activation: allSay(yes(mockSUPER)), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined),
      byWallet: statusOf(mockSUPER), events: bothRegistered(),
      // The light node is bound to this device: the network names this device's binding.
      lightStatus: lightStatus({ bindingSeqAgreed: 1790000000 }),
    });
    require('../src/services/PushService').localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null } : null));
    try {
      const tree = await nodeTab();
      // Kept as the wallet's node record, with its status.
      expect(await kept()).toMatchObject({ owner: mockQNET, nodeId: mockSUPER, nodeType: 'super', status: { nodeId: mockSUPER, isOnline: true } });
      const text = texts(tree);
      expect(text).toContain(mockSUPER);
      expect(text).toContain(mockLIGHT);
      expect(text.indexOf(mockSUPER)).toBeLessThan(text.indexOf(mockLIGHT));
      expect(text).toContain(t('node_last_seen'));
      expect(text).toContain(t('node_heartbeats_of', { n: 5, m: 9 }));
      // The epochs are read from the super node's registration on (node-events), never before it.
      expect(mockState.epochCalls).toContainEqual([mockSUPER, { walletAddress: mockQNET, registeredHeight: 2_000_123 }]);
      // Neither card counts or names missed epochs, or names a device model: the site's cabinet does (owner, 11.10, 18.10).
      expect(text).not.toMatch(/Counted epochs|Missed|\bDevice\b/);
    } finally {
      require('../src/services/PushService').localBinding.mockImplementation(async () => null);
    }
  });

  // Under the super node's card it says where the light node runs, with no balance or move of its own.
  it('the light node bound to another device shows under the super node\'s card, which alone holds the balance', async () => {
    Object.assign(mockState, {
      activation: allSay(yes(mockSUPER)), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined),
      events: bothRegistered(), lightStatus: lightStatus(),
    });
    const tree = await nodeTab();
    const text = texts(tree);
    expect(text).toContain(mockSUPER);
    expect(text.indexOf(mockSUPER)).toBeLessThan(text.indexOf(mockLIGHT));
    expect(text).toContain(t('node_elsewhere'));
    expect(text).not.toContain(t('node_none'));
    expect(text.split(t('node_balance')).length - 1).toBe(1);
    expect(tree.root.findAll((n) => n.props.testID === 'node-use')).toEqual([]);
    // The super node's card, its balance and its move, on every device that holds the wallet.
    const moves = tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function');
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((n) => n.props.onPress)).size).toBe(1); // one card's button
  });

  // The tab reads a light node under a server node again only while its card shows there (NodeTab.lightNodeShown).
  it('under the super node\'s card, the light node on another device is read again with the tab\'s statuses', async () => {
    const { readNodeStatus } = require('../src/services/LightNode');
    const saved = AppState.currentState;
    AppState.currentState = 'active'; // the tab reads in front only
    const every = jest.spyOn(global, 'setInterval');
    try {
      Object.assign(mockState, {
        activation: allSay(yes(mockSUPER)), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined),
        events: bothRegistered(), lightStatus: lightStatus(),
      });
      const tree = await nodeTab();
      expect(texts(tree)).toContain(t('node_elsewhere'));
      const reads = () => readNodeStatus.mock.calls.filter(([id]) => id === mockLIGHT).length;
      const before = reads();
      await statusTick(every);
      expect(reads()).toBe(before + 1);
    } finally {
      every.mockRestore();
      AppState.currentState = saved;
    }
  });

  // Which node is the wallet's is the genesis nodes' verify-activation answer alone: node-events (registration heights)
  // and one genesis node's answer by the wallet link nothing.
  it('a super node only node-events and the by-wallet answer name is not linked: the light card alone, as the network records it', async () => {
    Object.assign(mockState, {
      activation: allSay(yes(mockLIGHT, 'light')), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined),
      byWallet: statusOf(mockSUPER), events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] },
      lightStatus: lightStatus(),
    });
    const tree = await nodeTab();
    expect(await kept()).toMatchObject({ nodeId: mockLIGHT, nodeType: 'light' });
    expect(texts(tree)).not.toContain(mockSUPER);
    expect(statusReadsOf(mockSUPER)).toBe(0);
    // Its light node is bound to another device whose model the status does not name: the card says that, with the node,
    // its status and the balance, and offers nothing to run it here.
    expect(texts(tree)).toContain(t('node_elsewhere'));
    expect(texts(tree)).toContain(mockLIGHT);
    expect(texts(tree)).toContain(t('node_balance'));
    expect(tree.root.findAll((n) => n.props.testID === 'node-use')).toEqual([]);
  });

  // The node balance is the wallet's and shows on the card of a node on another device, so it is read for that node too.
  it('a light node on another device: its model, and the node balance read for it', async () => {
    const Push = require('../src/services/PushService');
    Push.getPendingRewards.mockImplementation(async () => ({ success: true, pendingRewards: 3e9 }));
    try {
      const device = { platform: 'ios', model: 'iPhone 15 Pro', linkedSince: 1790035200, lastAnswerEpoch: 151, state: 'online' };
      Object.assign(mockState, { activation: allSay(yes(mockLIGHT, 'light')), lightStatus: lightStatus({ device }) });
      const tree = await nodeTab();
      expect(texts(tree)).toContain(t('node_runs_on', { model: 'iPhone 15 Pro' }));
      expect(texts(tree)).toContain(`${t('node_balance')}\n3 QNC`);
      expect(Push.getPendingRewards).toHaveBeenCalledWith(mockLIGHT);
      expect(tree.root.findAll((n) => n.props.testID === 'node-use')).toEqual([]);
    } finally {
      Push.getPendingRewards.mockImplementation(async () => ({ success: true, pendingRewards: 0 }));
    }
  });

  // Screenshots and screen recordings without the node's name, as with the balances.
  it('the header\'s More hides node names beside the balances: the Node tab masks the name, kept on the device', async () => {
    Object.assign(mockState, { activation: allSay(yes(mockLIGHT, 'light')), lightStatus: lightStatus({ bindingSeqAgreed: 1790000000 }) });
    const Push = require('../src/services/PushService');
    Push.localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null } : null));
    try {
      let tree = await nodeTab();
      const nodeId = () => tree.root.find((n) => n.type === Text && n.props.testID === 'node-id').props.children;
      expect(nodeId()).toBe(mockLIGHT);
      expect(await AsyncStorage.getItem('qnet_hide_node_names')).toBe(null);
      await act(async () => { tree.root.find((n) => n.props.testID === 'header-more' && typeof n.props.onPress === 'function').props.onPress(); });
      await flush(2);
      // The switch sits right under Hide balances, off by default.
      const menu = texts(tree);
      expect(menu.indexOf(t('tok_hide_balances'))).toBeLessThan(menu.indexOf(t('node_hide_names')));
      const toggle = () => tree.root.findAll((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === t('node_hide_names'))[0];
      expect(toggle().props.accessibilityState.checked).toBe(false);
      await act(async () => { toggle().props.onPress(); });
      await flush(4);
      expect(toggle().props.accessibilityState.checked).toBe(true);
      expect(await AsyncStorage.getItem('qnet_hide_node_names')).toBe('1');
      expect(nodeId()).toBe('••••');
      expect(texts(tree)).not.toContain(mockLIGHT);
      // The balances stay as they were: one switch each.
      expect(await AsyncStorage.getItem('qnet_hide_balances')).toBe(null);
      // Opened again, the wallet reads it back.
      await act(async () => { mounted.pop().unmount(); });
      tree = await nodeTab();
      expect(nodeId()).toBe('••••');
    } finally {
      Push.localBinding.mockImplementation(async () => null);
    }
  });

  it('Use this device holds the background verification while it binds the node here, and lets it go after', async () => {
    const Push = require('../src/services/PushService');
    // Bound here before devices had a key of their own: the card offers Use this device.
    Object.assign(mockState, {
      activation: allSay(yes(mockLIGHT, 'light')), lightStatus: lightStatus({ bindingSeqAgreed: 1790000000, features: ['device_v1'] }),
    });
    Push.localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null } : null));
    let bound = null;
    Push.bindThisDevice.mockImplementationOnce(() => new Promise((resolve) => { bound = resolve; }));
    try {
      const tree = await nodeTab();
      await pressId(tree, 'node-use');
      await pressText(tree, t('node_use'));
      const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('password'))[0];
      await act(async () => { field.props.onChangeText('abcdefghijk'); });
      await pressText(tree, t('common_confirm'));
      expect([typeof bound, await networkFree()]).toEqual(['function', false]);
      await act(async () => { bound({ ok: true }); });
      await flush(8);
      expect(await networkFree()).toBe(true);
    } finally {
      Push.localBinding.mockImplementation(async () => null);
    }
  });

  it('once two genesis nodes say the wallet has no node, a super node aiqnet.io recorded is said; a light one not bound here is not; an unreadable record changes nothing', async () => {
    mockState.record = { state: 'recorded', nodeType: 'super' };
    let tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_not_on_network_super'));
    expect(texts(tree)).not.toContain(t('node_none'));
    await act(async () => { mounted.pop().unmount(); });

    // A light node aiqnet.io recorded is bound to no device yet: not this device's to show (owner, 11.10).
    mockState.record = { state: 'sending', nodeType: 'light' };
    tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_none'));
    expect(texts(tree)).not.toMatch(/light node is not on the QNet network/);
    await act(async () => { mounted.pop().unmount(); });

    mockState.record = null; // the site could not be read
    tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_none'));
    expect(texts(tree)).not.toMatch(/not on the QNet network yet|has not joined/);
  });
});

// One source for the wallet's node, every type: the genesis nodes' verify-activation answers. One that names a node shows
// it at once, a second confirms it; only two authoritative "no" take it off the tab. The server card reads that node by
// its id: only an answer about it replaces its status, anything else keeps the last good one marked stale.
describe('the wallet\'s node from the genesis nodes\' answers', () => {
  const G1 = 'genesis_node_001';
  let every;
  let savedState;
  beforeEach(() => {
    savedState = AppState.currentState;
    AppState.currentState = 'active'; // the tab reads in front only
    every = jest.spyOn(global, 'setInterval');
  });
  afterEach(() => {
    every.mockRestore();
    AppState.currentState = savedState;
    require('../src/services/PushService').getPendingRewards.mockImplementation(async () => ({ success: true, pendingRewards: 0 }));
  });

  it('the app holds no table of genesis wallets', () => {
    const src = path.join(__dirname, '..', 'src');
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(js|ts|tsx)$/.test(e.name)) files.push(p);
    });
    walk(src);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /GENESIS_WALLETS|genesisWallet/.test(fs.readFileSync(f, 'utf8')))).toEqual([]);
    expect(fs.existsSync(path.join(src, 'config', 'genesisWallets.js'))).toBe(false);
  });

  it('a genesis node kept on the device that two genesis nodes say the wallet does not have goes: no server card, no record', async () => {
    Object.assign(mockState, {
      qnet: GENESIS_WALLET, activation: allSay(NO),
      // As a chain where this wallet has no node answers: the genesis node online by its id, "no node" by the wallet.
      byId: (id) => (id === G1 ? nodeAnswer(id, { heartbeat_count: 4 }) : undefined),
      byWallet: { success: true, registered: false, nodeId: null, isOnline: false, message: 'Node not registered on-chain yet.' },
    });
    await AsyncStorage.setItem('qnet_wallet_node', JSON.stringify({
      owner: GENESIS_WALLET, nodeId: G1, nodeType: 'super', status: statusOf(G1), at: Date.now() - 60_000,
    }));
    const tree = await nodeTab();
    const text = texts(tree);
    expect(text).not.toContain(G1);
    expect(text).toContain(t('node_none'));
    expect(text).not.toContain(GENERIC);
    expect(await kept()).toBe(null);
  });

  it('a genesis node the genesis nodes name, online by its id while the wallet read says "no node": its card on open, on the tick and back in the app', async () => {
    Object.assign(mockState, {
      qnet: GENESIS_WALLET, activation: allSay(yes(G1)),
      byId: (id) => (id === G1 ? nodeAnswer(id, { heartbeat_count: 4 }) : undefined),
      byWallet: { success: true, registered: false, nodeId: null, isOnline: false, message: 'Node not registered on-chain yet.' },
    });
    const since = AppState.addEventListener.mock.calls.length;
    const tree = await nodeTab();
    const card = () => {
      const text = texts(tree);
      return [text.includes(G1), text.includes(t('node_active')), text.includes(t('node_heartbeats_of', { n: 4, m: 9 })),
        text.includes(GENERIC) || text.includes(t('node_super_server')), stale(tree)];
    };
    expect(card()).toEqual([true, true, true, false, false]);
    const reads = statusReadsOf(G1);
    await statusTick(every);
    expect(card()).toEqual([true, true, true, false, false]);
    expect(statusReadsOf(G1)).toBeGreaterThan(reads);
    await resume(since);
    expect(card()).toEqual([true, true, true, false, false]);
    expect(hasKey('node_super_server_sub')).toBe(false);
  });

  it('a genesis node two genesis nodes name for a wallet the app has no table of is its node, linked at once', async () => {
    Object.assign(mockState, {
      activation: [undefined, yes('genesis_node_003'), yes('genesis_node_003'), undefined, undefined],
      byId: (id) => (id === 'genesis_node_003' ? nodeAnswer(id) : undefined),
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain('genesis_node_003');
    expect(texts(tree)).toContain(t('node_active'));
    expect(await kept()).toMatchObject({ owner: mockQNET, nodeId: 'genesis_node_003', nodeType: 'super' });
  });

  it.each([
    ['that the node is not registered', (id) => nodeAnswer(id, { registered: false, onchain_registered: false, is_online: false, status: 'onboarding' }),
      { success: true, registered: false, nodeId: mockSUPER, isOnline: false }],
    ['no node at all', () => ({ success: true, registered: false, node_id: null, is_online: false, message: 'Node not registered on-chain yet.' }),
      { success: true, registered: false, nodeId: null, isOnline: false }],
  ])('after a good status, answers that say %s keep the card, marked stale', async (_, laterById, laterByWallet) => {
    Object.assign(mockState, {
      activation: allSay(yes(mockSUPER)), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined), byWallet: statusOf(mockSUPER),
      events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] },
    });
    const tree = await nodeTab();
    expect([texts(tree).includes(t('node_active')), stale(tree)]).toEqual([true, false]);
    Object.assign(mockState, { byId: laterById, byWallet: laterByWallet });
    await statusTick(every);
    const text = texts(tree);
    expect([text.includes(mockSUPER), text.includes(t('node_active')), stale(tree)]).toEqual([true, true, true]);
    expect(text).not.toContain(GENERIC);
    expect(tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function').length).toBeGreaterThan(0);
    // The good status stays the wallet's record; an answer that says the node is not registered is never kept.
    expect(await kept()).toMatchObject({ nodeId: mockSUPER, status: { nodeId: mockSUPER, isOnline: true } });
  });

  it('the genesis nodes not answering on the wallet\'s node and no light node on the chain: being checked, never "no node"', async () => {
    Object.assign(mockState, { activation: [], lightStatus: lightStatus({ onChain: false }) });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_checking'));
    expect(texts(tree)).not.toContain(t('node_none'));
    // The poll asks again while they have not said; two authoritative "no" settle it.
    mockState.activation = allSay(NO);
    await statusTick(every);
    expect(texts(tree)).toContain(t('node_none'));
  });

  it('a super node aiqnet.io recorded that the genesis nodes name: its card, never "has not joined", whatever its status read does', async () => {
    Object.assign(mockState, {
      record: { state: 'recorded', nodeType: 'super' }, activation: allSay(yes(mockSUPER)), byId: () => undefined,
      events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] },
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_unreachable'));
    expect(texts(tree)).not.toContain(t('node_not_on_network_super'));
    mockState.byId = (id) => (id === mockSUPER ? nodeAnswer(id) : undefined);
    await pull(tree);
    expect(texts(tree)).toContain(t('node_active'));
    expect(texts(tree)).not.toContain(t('node_not_on_network_super'));
  });

  it('the last good status kept on the device shows at once however old it is, marked stale once a read cannot be made', async () => {
    await AsyncStorage.setItem('qnet_wallet_node', JSON.stringify({
      owner: mockQNET, nodeId: mockSUPER, nodeType: 'super', status: statusOf(mockSUPER), at: Date.now() - 11 * 60_000,
    }));
    Object.assign(mockState, { activation: [], byId: () => undefined });
    const tree = await nodeTab();
    const text = texts(tree);
    expect([text.includes(mockSUPER), text.includes(t('node_active')), text.includes(t('node_heartbeats_of', { n: 5, m: 9 })), stale(tree)])
      .toEqual([true, true, true, true]);
  });

  it('the wallet\'s node record survives the crash screen\'s Clear cache: its card shows again at once', async () => {
    const ErrorBoundary = require('../src/components/ErrorBoundary').default;
    const { Alert } = require('react-native');
    Object.assign(mockState, { activation: allSay(yes(mockSUPER)), byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined) });
    let tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_active'));
    await act(async () => { mounted.pop().unmount(); });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const boundary = new ErrorBoundary({});
      boundary.setState = () => {};
      await boundary.handleClearCache();
    } finally {
      alert.mockRestore();
    }
    // Opened again with the network silent: the node and its last status from the record.
    Object.assign(mockState, { activation: [], byId: () => undefined });
    tree = await nodeTab();
    expect([texts(tree).includes(mockSUPER), texts(tree).includes(t('node_active'))]).toEqual([true, true]);
  });

  it('a status that says the node is not registered is never kept on the device', async () => {
    Object.assign(mockState, {
      activation: allSay(yes(mockSUPER)),
      byId: (id) => nodeAnswer(id, { registered: false, onchain_registered: false, is_online: false }),
      byWallet: statusOf(mockSUPER, { registered: false, onchain_registered: false }),
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(t('node_checking'));
    const all = await AsyncStorage.multiGet(await AsyncStorage.getAllKeys());
    expect(all.filter(([, v]) => /"registered":false/.test(String(v))).map(([k]) => k)).toEqual([]);
    expect(await kept()).toMatchObject({ nodeId: mockSUPER, status: null });
  });

  it('Move to wallet moves the balance of the node the genesis nodes name, which one answer names at once', async () => {
    const OTHER = 'super_node_9999000011112222';
    await AsyncStorage.setItem('qnet_wallet_node', JSON.stringify({ owner: mockQNET, nodeId: OTHER, nodeType: 'super', status: null, at: 1 }));
    require('../src/services/PushService').getPendingRewards.mockImplementation(async () => ({ success: true, pendingRewards: 4e9 }));
    Object.assign(mockState, {
      activation: [yes(mockSUPER), undefined, undefined, undefined, undefined],
      byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined), byWallet: statusOf(mockSUPER),
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(mockSUPER);
    expect(texts(tree)).not.toContain(OTHER);
    const move = tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function')[0];
    await act(async () => { await move.props.onPress(); });
    await flush(8);
    expect(mockState.claims).toEqual([{ nodeType: 'super', wallet: mockQNET, balanceNano: 4e9, nodeId: mockSUPER }]);
  });

  it('another id one genesis node gives by the wallet is taken only once two genesis nodes name it', async () => {
    const OTHER = 'super_node_9999000011112222';
    Object.assign(mockState, {
      activation: allSay(yes(mockSUPER)), byId: (id) => nodeAnswer(id), byWallet: statusOf(OTHER),
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(mockSUPER);
    expect(texts(tree)).not.toContain(OTHER);
    // Two genesis nodes name it now: the tab follows.
    mockState.activation = allSay(yes(OTHER));
    await statusTick(every);
    await statusTick(every);
    expect(texts(tree)).toContain(OTHER);
    expect(await kept()).toMatchObject({ nodeId: OTHER });
  });

  it('a QNet Link reserve on a wallet whose node the genesis nodes name as a super node answers NODE_OTHER', async () => {
    const inbox = fakeLinkInbox();
    const URL = 'https://link.aiqnet.io/l#reserve';
    mockLinks[URL] = { id: 'r'.repeat(32), sitePub: 'd'.repeat(43), intent: 'reserve', reqHash: 'f'.repeat(43) };
    try {
      Object.assign(mockState, {
        activation: [yes(mockSUPER), undefined, undefined, undefined, undefined],
        byId: (id) => (id === mockSUPER ? nodeAnswer(id) : undefined),
      });
      const tree = await nodeTab();
      expect(texts(tree)).toContain(mockSUPER);
      QNetLink.prepareOffer.mockClear();
      await inbox.deliver(URL);
      await flush(6);
      expect(QNetLink.prepareOffer).toHaveBeenCalled();
      expect(await QNetLink.prepareOffer.mock.results[0].value).toEqual({ kind: 'unavailable', error: 'NODE_OTHER' });
      expect(texts(tree)).toContain(t('link_err_NODE_OTHER'));
    } finally {
      delete mockLinks[URL];
      inbox.remove();
    }
  });
});

// A binding of "Use this device" or the link sheet sent with no answer (PushService readUnconfirmedBinding) waits beside
// this device's current binding until the network names one; the tab reads for it and shows it as being linked here.
describe('a binding sent with no answer, on the Node tab', () => {
  const Push = require('../src/services/PushService');
  const { readNodeStatus } = require('../src/services/LightNode');
  const OLD = 1790000000;
  const WAITING = OLD + 100;
  const record = () => ({ nodeId: mockLIGHT, walletAddress: mockQNET, seq: WAITING, enrolled: false, at: Date.now() - 60_000 });
  afterEach(() => {
    Push.readUnconfirmedBinding.mockImplementation(async () => null);
    Push.settleUnconfirmedBinding.mockImplementation(async () => false);
    Push.localBinding.mockImplementation(async () => null);
  });

  it('every read while it waits is signed, and it is settled before the check that would end the binding it replaces', async () => {
    Push.localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: OLD, pushType: 'fcm', hw: false, boundAt: null } : null));
    Push.readUnconfirmedBinding.mockImplementation(async (id) => (id === mockLIGHT ? record() : null));
    // The network names the waiting binding: it becomes this device's, and the tab reads again.
    let settled = false;
    Push.settleUnconfirmedBinding.mockImplementation(async () => {
      if (settled) return false;
      settled = true;
      return true;
    });
    mockState.lightStatus = lightStatus({ bindingSeqAgreed: WAITING });
    readNodeStatus.mockClear();
    Push.forgetIfReplaced.mockClear();
    await nodeTab();
    const first = Push.settleUnconfirmedBinding.mock.calls[0];
    expect(first[0]).toBe(mockLIGHT);
    expect(first[1]).toMatchObject({ bindingSeqAgreed: WAITING });
    expect(Push.forgetIfReplaced).toHaveBeenCalled();
    expect(Push.settleUnconfirmedBinding.mock.invocationCallOrder[0]).toBeLessThan(Push.forgetIfReplaced.mock.invocationCallOrder[0]);
    const lightReads = readNodeStatus.mock.calls.filter(([id]) => id === mockLIGHT);
    expect(lightReads.length).toBeGreaterThanOrEqual(2);
    expect(lightReads.every(([, o]) => o && typeof o.signStatus === 'function')).toBe(true);
  });

  it('on a phone with no binding: "being linked here" while the owners name the binding before or none, and read again soon', async () => {
    const saved = AppState.currentState;
    AppState.currentState = 'active'; // the linking schedule reads in front only
    Push.readUnconfirmedBinding.mockImplementation(async (id) => (id === mockLIGHT ? record() : null));
    try {
      await waitingShown();
    } finally {
      AppState.currentState = saved;
    }
  });
  async function waitingShown() {
    for (const B of [OLD, null]) {
      mockState.lightStatus = lightStatus({ bindingSeqAgreed: B });
      readNodeStatus.mockClear();
      const tree = await nodeTab();
      const text = texts(tree);
      expect([B, text.includes(mockLIGHT), text.includes(t('node_linked_waiting'))]).toEqual([B, true, true]);
      expect(text).not.toContain(t('node_device_again'));
      // The linking schedule runs from when it went out: another read follows without the five-minute wait.
      const before = readNodeStatus.mock.calls.filter(([id]) => id === mockLIGHT).length;
      await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
      expect(readNodeStatus.mock.calls.filter(([id]) => id === mockLIGHT).length).toBeGreaterThan(before);
      await act(async () => { mounted.pop().unmount(); });
    }
  }
});

// A shard owner that does not answer, or a device check or an attestation that takes long, holds nothing back: the card
// shows on the owners' agreed verdict and before the upkeep; a status that could not be read is said as such and read
// again soon, never as "This wallet has no node.".
describe('the light card on a slow or silent network', () => {
  const Push = require('../src/services/PushService');
  const { readNodeStatus } = require('../src/services/LightNode');
  const real = readNodeStatus.getMockImplementation();
  afterEach(() => {
    readNodeStatus.mockImplementation(real);
    Push.localBinding.mockImplementation(async () => null);
    Push.refreshLeaseFromTab.mockImplementation(async () => false);
  });

  it('shows as soon as two owners agree, while the third is still out', async () => {
    Object.assign(mockState, { activation: allSay(yes(mockLIGHT, 'light')), lightStatus: lightStatus() });
    readNodeStatus.mockImplementation(async (id, opts = {}) => {
      if (id === mockLIGHT && opts.onAgreed) opts.onAgreed(mockState.lightStatus);
      return new Promise(() => {});
    });
    const tree = await nodeTab();
    expect(texts(tree)).toContain(mockLIGHT);
    expect(texts(tree)).toContain(t('node_elsewhere'));
    expect(texts(tree)).not.toContain(t('node_checking'));
  });

  it('shows before a lease refresh with its device check is done', async () => {
    Object.assign(mockState, { activation: allSay(yes(mockLIGHT, 'light')), lightStatus: lightStatus({ bindingSeqAgreed: 1790000000 }) });
    Push.localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: true, boundAt: null } : null));
    Push.refreshLeaseFromTab.mockImplementation(() => new Promise(() => {}));
    const tree = await nodeTab();
    expect(Push.refreshLeaseFromTab).toHaveBeenCalledWith(mockLIGHT);
    expect(texts(tree)).toContain(mockLIGHT);
    expect(texts(tree)).toContain(t('node_status_online'));
    expect(texts(tree)).not.toContain(t('node_checking'));
  });

  it('a status that could not be read is never "no node": it says so and is read again soon', async () => {
    const saved = AppState.currentState;
    AppState.currentState = 'active'; // the schedule reads in front only
    // A wait no test outlasts: the test runs each read the schedule arms itself, never racing the real clock.
    mockState.paceMs = 3_600_000;
    const armedAt = jest.spyOn(global, 'setTimeout');
    const cleared = jest.spyOn(global, 'clearTimeout');
    try {
      mockState.lightStatus = lightStatus({ onChain: null, reachable: false });
      readNodeStatus.mockClear();
      const tree = await nodeTab();
      expect(texts(tree)).toContain(t('node_unreachable'));
      expect(texts(tree)).not.toContain(t('node_none'));
      expect(texts(tree)).not.toContain(t('node_title_light'));
      const reads = () => readNodeStatus.mock.calls.filter(([id]) => id === mockLIGHT).length;
      // The schedule's armed reads: [callback, timer id], newest last.
      const armed = () => armedAt.mock.calls.map((c, i) => [c, armedAt.mock.results[i].value])
        .filter(([c]) => c[1] === mockState.paceMs).map(([c, id]) => [c[0], id]);
      const runArmed = async () => {
        const [fn, id] = armed().pop();
        clearTimeout(id);
        await act(async () => { fn(); });
        await flush(6);
      };
      const before = reads();
      await runArmed();
      expect(reads()).toBeGreaterThan(before);
      // Once two owners say the wallet has no node, the tab says so and the read armed after it is withdrawn.
      mockState.lightStatus = lightStatus({ onChain: false });
      await runArmed();
      expect(texts(tree)).toContain(t('node_none'));
      const [, last] = armed().pop();
      expect(cleared.mock.calls.some(([id]) => id === last)).toBe(true);
    } finally {
      armedAt.mockRestore();
      cleared.mockRestore();
      mockState.paceMs = null;
      AppState.currentState = saved;
    }
  });
});

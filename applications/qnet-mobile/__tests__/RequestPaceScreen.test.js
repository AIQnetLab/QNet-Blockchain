/**
 * The owner's 05.10 ping audit (F12) on the real wallet screen: the address socket names this wallet's address only,
 * comes back no sooner than 5 minutes after a refusal and closes in the background; Assets and History ask less often
 * while it is open, History asks the explorer only on opening; the Node tab reads its statuses every 5 minutes, the
 * node balance once per epoch, and gives its Background row a button to the system settings.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, RefreshControl, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
const mockState = {};

jest.mock('../src/components/WalletManager', () => {
  class VaultCorruptError extends Error {}
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  class FakeWalletManager {
    constructor() {
      return new Proxy(this, {
        get: (target, prop) => {
          if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
          return async () => null;
        },
      });
    }
    async prepareInstall() {}
    async vaultState() { return 'sealed'; }
    async isBiometricEnabled() { return false; }
    async isBiometricSupported() { return false; }
    async getPasswordLockStatus() { return { locked: false }; }
    async unlockWithPassword() { return { ok: true, token: 'session-token' }; }
    async checkPassword() { return { ok: true }; }
    async loadWallet() { return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    getBIP39WordList() { return words; }
    getTrustedNodes() { return ['https://node1.aiqnet.io']; }
    trustedNodeUrl() { return 'https://node1.aiqnet.io'; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (a committee-certified balance): the same figure.
    async certifiedQncForSend() { return { ok: true, verified: true, balanceNano: '1000000000', nonce: '4' }; }
    async getTokenHoldings() { return []; }
    async loadNodeRecord() { return null; }
    async saveNodeRecord() {}
    async confirmServerNode() { return null; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return mockLIGHT; }
    generateSuperNodePseudonym() { return 'super_node_5555666677778888'; }
    sessionOpen() { return true; }
    closeSession() {}
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  return { __esModule: true, default: FakeWalletManager, WalletManager: FakeWalletManager, VaultCorruptError };
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
  showPlayDialog: jest.fn(async () => 'ok'),
}));

jest.mock('../src/services/BackgroundPriority', () => ({
  readBackground: jest.fn(async () => ({
    priority: 'restricted', changeable: true, exempt: false, bucket: 'rare', userRestricted: false, refresh: null,
  })),
  openBackgroundSettings: jest.fn(async () => true),
}));

jest.mock('../src/services/PushService', () => ({
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  readdressIfOwed: jest.fn(async () => false),
  localBinding: jest.fn(async () => mockState.local),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  checkServerNodeStatus: jest.fn(async () => ({ success: false, error: 'network' })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [] })),
  getNodeEpochs: jest.fn(async () => null),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 2e9 })),
  refreshFcmTokenOnServer: jest.fn(async () => ({})),
  isTokenRefreshNeeded: jest.fn(async () => false),
  teardownLightNode: jest.fn(async () => {}),
  teardownLightNodeIfForeign: jest.fn(async () => {}),
  resendPendingBinding: jest.fn(async () => false),
  enrolAgainIfUnleased: jest.fn(async () => false),
  nodeCheckState: jest.fn(async () => null),
  endExpiredLink: jest.fn(async () => false),
  settleUnansweredKey: jest.fn(async () => null),
  refreshLeaseFromTab: jest.fn(async () => false),
}));

jest.mock('../src/services/NodeRecordRead', () => ({
  ...jest.requireActual('../src/services/NodeRecordRead'),
  readNodeRecordState: jest.fn(async () => null),
}));
jest.mock('../src/services/HistoryCache', () => ({ loadCachedHistory: jest.fn(async () => []), saveCachedHistory: jest.fn(async () => {}) }));
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View); };
});
jest.mock('../src/services/QNetLink', () => ({
  parseLink: jest.fn(() => null),
  takeInitialUrl: jest.fn(async () => null),
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Push = require('../src/services/PushService');
const Bg = require('../src/services/BackgroundPriority');
const WalletScreen = require('../src/screens/WalletScreen').default;

// The address socket: a stand-in that records what the screen opens and closes.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.closed = 0;
    FakeSocket.all.push(this);
  }

  close() {
    this.closed += 1;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.all = [];

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text)
  .map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');
const press = async (tree, testID) => {
  await act(async () => { tree.root.find((n) => n.props.testID === testID && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(8);
};

let listeners;
let timeouts;
let intervals;
let fetched;
let savedState;
let savedSocket;
const mounted = [];
// The setTimeout calls with this delay since `from` (an index into the spy's calls).
const waits = (ms, from = 0) => timeouts.mock.calls.slice(from).filter((c) => c[1] === ms);
// Runs a scheduled call now, the timer it was set with cleared (no copy of it runs later).
const fire = async (call) => {
  clearTimeout(timeouts.mock.results[timeouts.mock.calls.indexOf(call)].value);
  await act(async () => { call[0](); });
};
const appGoes = async (next) => {
  AppState.currentState = next;
  await act(async () => { for (const h of [...listeners]) h(next); });
  await flush(6);
};

async function unlocked() {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  mounted.push(tree);
  await flush(6);
  const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('enter_password'))[0];
  await act(async () => { field.props.onChangeText('abcdefghijk'); });
  const unlock = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('unlock_wallet'))).pop();
  await act(async () => { await unlock.props.onPress(); });
  await flush(10);
  return tree;
}

beforeAll(() => {
  savedSocket = global.WebSocket;
  global.WebSocket = FakeSocket;
});
afterAll(() => { global.WebSocket = savedSocket; });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  FakeSocket.all = [];
  listeners = [];
  fetched = [];
  savedState = AppState.currentState;
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') listeners.push(handler);
    return { remove: () => { listeners = listeners.filter((h) => h !== handler); } };
  });
  timeouts = jest.spyOn(global, 'setTimeout');
  intervals = jest.spyOn(global, 'setInterval');
  global.fetch = jest.fn(async (url) => { fetched.push(String(url)); throw new Error('offline in tests'); });
  Object.assign(mockState, {
    // This device's binding of the node: the tab shows it running here.
    local: { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null },
    lightStatus: {
      reachable: true, onChain: true, registrationPending: false, deviceBound: true, deviceBoundAgreed: true, answered: true,
      needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null,
      bindingSeqAgreed: null,
    },
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  timeouts.mockRestore();
  intervals.mockRestore();
  AppState.addEventListener.mockRestore();
  AppState.currentState = savedState;
});

describe('the address socket', () => {
  it('names this wallet\'s address only, waits at least 5 minutes after a refusal, and closes in the background', async () => {
    const tree = await unlocked();
    expect(FakeSocket.all).toHaveLength(1);
    const [first] = FakeSocket.all;
    expect(first.url).toBe(`wss://node1.aiqnet.io/ws/subscribe?channels=${encodeURIComponent(`account:${mockQNET}`)}`);
    expect(first.url).not.toMatch(/blocks/);

    // Refused (closed before it opened): the next try 5 to 10 minutes later.
    let mark = timeouts.mock.calls.length;
    await act(async () => { first.onerror(); });
    const refused = timeouts.mock.calls.slice(mark).map((c) => c[1]).filter((ms) => ms >= 1000);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeGreaterThanOrEqual(300000);
    expect(refused[0]).toBeLessThan(600000);

    // In the background: nothing scheduled runs; back in front: not before the wait it had.
    await appGoes('background');
    mark = timeouts.mock.calls.length;
    await appGoes('active');
    expect(FakeSocket.all).toHaveLength(1);
    const resumed = timeouts.mock.calls.slice(mark).map((c) => c[1]).filter((ms) => ms >= 290000);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toBeLessThanOrEqual(refused[0]);

    // The wait over, it opens again; open, Assets reads every 60 s instead of 30; the background closes it, for good.
    await fire(timeouts.mock.calls.slice(mark).find((c) => c[1] >= 290000));
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1];
    await act(async () => { second.onopen(); });
    const tick = [...waits(30000)].pop();
    expect(tick).toBeDefined(); // the Assets read set while the socket was not open
    mark = timeouts.mock.calls.length;
    await fire(tick);
    expect(waits(60000, mark).length).toBeGreaterThan(0);
    await appGoes('background');
    expect(second.closed).toBe(1);
    await flush(4);
    expect(FakeSocket.all).toHaveLength(2);
    expect(texts(tree)).toBeTruthy();
  });
});

describe('the tabs\' reads', () => {
  it('Assets never polls every 15 s; History asks the explorer on opening only, then a node at the socket\'s pace', async () => {
    const tree = await unlocked();
    expect(intervals.mock.calls.filter((c) => c[1] === 15000)).toEqual([]);
    const mark = timeouts.mock.calls.length;
    const marked = intervals.mock.calls.length;
    const explorer = () => fetched.filter((u) => u.includes('/api/address/')).length;
    const loaded = explorer(); // the wallet's own load at the unlock
    await press(tree, 'tab-history');
    expect(explorer()).toBe(loaded + 1);
    const tick = [...waits(30000, mark)].pop();
    expect(tick).toBeDefined();
    const nodeReads = fetched.length;
    await fire(tick);
    await flush(6);
    expect(explorer()).toBe(loaded + 1);
    expect(fetched.length).toBeGreaterThan(nodeReads); // the node's newest rows
    // No interval reads the history (the kept-transaction sweep looks at this device's own list first).
    expect(intervals.mock.calls.slice(marked).filter((c) => (c[1] === 10000 || c[1] === 15000) && c[0].name !== 'sweep')).toEqual([]);
  });

  it('the Node tab: statuses every 5 minutes, the balance once per epoch, and the Background row\'s button', async () => {
    const tree = await unlocked();
    await press(tree, 'tab-node');
    await flush(8);
    expect(intervals.mock.calls.some((c) => c[1] === 300000)).toBe(true);
    expect(intervals.mock.calls.some((c) => c[1] === 30000)).toBe(false);
    const balanceReads = () => Push.getPendingRewards.mock.calls.length;
    expect(balanceReads()).toBe(3);
    // Back in front: the statuses again, the balance not (the same epoch).
    await appGoes('background');
    await appGoes('active');
    expect(balanceReads()).toBe(3);
    // Pull to refresh reads it now.
    await act(async () => { await tree.root.findAllByType(RefreshControl).pop().props.onRefresh(); });
    await flush(8);
    expect(balanceReads()).toBe(6);
    // The Background row, restricted, with its one button to the system settings.
    expect(texts(tree)).toContain(t('node_background_restricted'));
    await press(tree, 'node-background');
    expect(Bg.openBackgroundSettings).toHaveBeenCalledTimes(1);
  });
});

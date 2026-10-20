/**
 * 29.09, the Node tab of the real wallet screen for both node types (R4): a light node record an older build kept on this
 * device never keeps the wallet's super node from being linked (gap b); a wallet with a super and a light node on the
 * chain shows both cards, the server's first (gap a), the light one only on the device it is bound to (owner, 11.10);
 * and before the network lists a super node, what aiqnet.io records of it is said, while a record that cannot be read
 * leaves the tab as it was (gap d). The app only reads: nothing here burns, shows a code or opens a page.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
const mockSUPER = 'super_node_5555666677778888';
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
    getTrustedNodes() { return []; }
    trustedNodeUrl() { return 'https://node.invalid'; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (the live figure less this wallet's own unsettled spends): the same figure.
    async qncForSend() { return { ok: true, balanceNano: '1000000000', nonce: '4', pending: [] }; }
    async getTokenHoldings() { return []; }
    async loadNodeRecord() { return mockState.node; }
    async saveNodeRecord(record) { mockState.saved.push(record); }
    async confirmServerNode(wallet, query) { mockState.confirmed.push(query); return mockState.confirm; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return mockLIGHT; }
    generateSuperNodePseudonym() { return mockSUPER; }
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
}));

jest.mock('../src/services/PushService', () => ({
  readUnconfirmedBinding: jest.fn(async () => null),
  settleUnconfirmedBinding: jest.fn(async () => false),
  BG_REFRESH_STATUS_KEY: 'qnet_bg_refresh_status',
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  readdressIfOwed: jest.fn(async () => false),
  localBinding: jest.fn(async () => null),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  // By id, or by the wallet (the node resolves a wallet to its super node first, as the chain does).
  checkServerNodeStatus: jest.fn(async (nodeId, wallet) => (nodeId === mockSUPER || (!nodeId && wallet === mockQNET) ? {
    success: true, registered: true, nodeId: mockSUPER, nodeType: 'super', isOnline: true, lastSeen: 1790000000,
    lastSeenAgoSeconds: 30, heartbeatCount: 5, requiredHeartbeats: 9, pendingRewards: 4e9, reputation: 70,
  } : { success: false, error: 'network' })),
  getAllNodesByWallet: jest.fn(async () => mockState.byWallet),
  getWalletNodeEvents: jest.fn(async () => mockState.events),
  getNodeEpochs: jest.fn(async (nodeId, opts) => { mockState.epochCalls.push([nodeId, opts]); return { counted: 7, missed: 2 }; }),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 0 })),
  refreshFcmTokenOnServer: jest.fn(async () => ({})),
  isTokenRefreshNeeded: jest.fn(async () => false),
  teardownLightNode: jest.fn(async () => {}),
  teardownLightNodeIfForeign: jest.fn(async () => {}),
  resendPendingBinding: jest.fn(async () => false),
  enrolAgainIfUnleased: jest.fn(async () => false),
  endExpiredLink: jest.fn(async () => false),
  settleUnansweredKey: jest.fn(async () => null),
  refreshLeaseFromTab: jest.fn(async () => false),
}));

jest.mock('../src/services/NodeRecordRead', () => ({
  ...jest.requireActual('../src/services/NodeRecordRead'),
  readNodeRecordState: jest.fn(async () => mockState.record),
}));

// The linking schedule's reads come at once here, so a test sees the next one without waiting ten seconds.
jest.mock('../src/utils/requestPace', () => ({ ...jest.requireActual('../src/utils/requestPace'), linkingReadMs: () => 50 }));

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
const WalletScreen = require('../src/screens/WalletScreen').default;

// Two owners' device-bound answer (contract 4) follows the first owner's unless a test names it.
const lightStatus = (over = {}) => {
  const s = {
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: null, needsReactivation: false,
    counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, ...over,
  };
  if (!('deviceBoundAgreed' in over)) s.deviceBoundAgreed = s.onChain === true ? s.deviceBound : null;
  return s;
};
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text)
  .map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');

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

beforeAll(() => {
  global.fetch = jest.fn(async () => { throw new Error('offline in tests'); });
});
beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(mockState, {
    node: null, saved: [], confirmed: [], confirm: true, epochCalls: [], record: null,
    byWallet: { success: true, nodes: [] }, events: { success: true, nodes: [] }, lightStatus: lightStatus({ onChain: false }),
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
});

describe('the wallet\'s nodes on the Node tab', () => {
  it('a light node record an older build kept here never stands in the way: the super node is linked, both cards show', async () => {
    Object.assign(mockState, {
      node: { nodeType: 'light', pseudonym: mockLIGHT },
      // The by-wallet answer lists only the light node; the chain's registrations name the super node too.
      byWallet: { success: true, nodes: [{ node_id: mockLIGHT, node_type: 'light', status: 'online' }] },
      events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 2_000_123 }, { nodeId: mockLIGHT, nodeType: 'light', height: 2_100_000 }] },
      // The light node is bound to this device: the network names this device's binding.
      lightStatus: lightStatus({ bindingSeqAgreed: 1790000000 }),
    });
    require('../src/services/PushService').localBinding.mockImplementation(async (id) => (id === mockLIGHT
      ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null } : null));
    try {
      const tree = await nodeTab();
      // Linked only on two genesis nodes' word, and kept as the wallet's node record.
      expect(mockState.confirmed).toContainEqual({ nodeType: 'super', nodeId: mockSUPER });
      expect(mockState.saved).toContainEqual({ nodeType: 'super', pseudonym: mockSUPER, walletAddress: mockQNET });
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

  it('the light node bound to another device has no card here, under the super node or alone (owner, 11.10)', async () => {
    Object.assign(mockState, {
      node: { nodeType: 'light', pseudonym: mockLIGHT },
      events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 2_000_123 }, { nodeId: mockLIGHT, nodeType: 'light', height: 2_100_000 }] },
      lightStatus: lightStatus(),
    });
    const tree = await nodeTab();
    const text = texts(tree);
    expect(text).toContain(mockSUPER);
    expect(text).not.toContain(mockLIGHT);
    expect(text).not.toContain(t('node_none')); // nothing under the super node's card
    expect(tree.root.findAll((n) => n.props.testID === 'node-use')).toEqual([]);
    // The super node's card, its balance and its move, on every device that holds the wallet.
    const moves = tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function');
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((n) => n.props.onPress)).size).toBe(1); // one card's button
  });

  it('a super node two genesis nodes do not confirm is not linked: the light card alone, as the network records it', async () => {
    Object.assign(mockState, {
      node: { nodeType: 'light', pseudonym: mockLIGHT }, confirm: null,
      events: { success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] },
      lightStatus: lightStatus(),
    });
    const tree = await nodeTab();
    expect(mockState.saved.filter((r) => r.nodeType === 'super')).toEqual([]);
    expect(texts(tree)).not.toContain(mockSUPER);
    // Its light node is bound to another device: the tab says that, and nothing else of it.
    expect(texts(tree)).toContain(t('node_elsewhere'));
    expect(texts(tree)).not.toContain(mockLIGHT);
  });

  it('before the network lists it, a super node aiqnet.io recorded is said; a light one not bound here is not; an unreadable record changes nothing', async () => {
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
    const { AppState } = require('react-native');
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

/**
 * The owner's 06.10 question "can balances load faster?", on the real wallet screen: the last verified figures show the
 * moment the wallet opens, with no line under them while this session's first read runs; each figure lands as
 * soon as its own source answers (QNC as soon as its proof folded, before the lineage walk); one read serves the unlock
 * and the Assets tab; a figure nobody read is a dash, never 0; a first read that finds nothing says so.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
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
    async loadWallet() { return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    getBIP39WordList() { return words; }
    getTrustedNodes() { return ['https://node1.aiqnet.io']; }
    trustedNodeUrl() { return 'https://node1.aiqnet.io'; }
    async getTokenHoldings() { return []; }
    async loadNodeRecord() { return null; }
    async deviceAuthAvailable() { return false; }
    async agreedGenesisBalance() { return null; }
    async keptTransactions() { return []; }
    async pendingTransactions() { return []; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return 'light_mobile_1111222233334444'; }
    sessionOpen() { return true; }
    closeSession() {}
    // The reads under test: each counted, each answered when the test says.
    async loadBalanceSnapshot(owner) { return mockState.snapshot && mockState.snapshot.owner === owner ? mockState.snapshot : null; }
    async saveBalanceSnapshot(s) { mockState.saved.push(s); return true; }
    getBalance() { mockState.calls.sol += 1; return mockState.gate('sol'); }
    getTokenBalance() { mockState.calls.oneDev += 1; return mockState.gate('oneDev'); }
    getQNCBalanceWithProof(addr, verify, opts) {
      mockState.calls.qnc += 1;
      mockState.onFigure = opts && opts.onFigure;
      return mockState.gate('qnc');
    }
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  return { __esModule: true, default: FakeWalletManager, WalletManager: FakeWalletManager, VaultCorruptError };
});

jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  readNodeStatus: jest.fn(async () => null),
  readLinkPending: jest.fn(async () => null),
  dropLinkPending: jest.fn(async () => {}),
}));
jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => ({ capable: true, platform: 'android', flags: '', report: null })),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
  showPlayDialog: jest.fn(async () => 'ok'),
}));
jest.mock('../src/services/PushService', () => ({
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  readdressIfOwed: jest.fn(async () => false),
  localBinding: jest.fn(async () => null),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  checkServerNodeStatus: jest.fn(async () => ({ success: false, error: 'network' })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [] })),
  getNodeEpochs: jest.fn(async () => null),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 0 })),
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
const WalletScreen = require('../src/screens/WalletScreen').default;
const styles = require('../src/screens/WalletScreen.styles').default;
const { dateTime } = require('../src/screens/HistoryTab');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('');
const texts = (tree) => tree.root.findAllByType(Text).map(textOf).join('\n');
// The QNC row's figure: the first amount of the Assets list (QNet is the side shown first).
const qncFigure = (tree) => textOf(tree.root.findAll((n) => n.type === Text && n.props.style === styles.tokenAmount)[0]);
const statusLine = (tree) => {
  const line = tree.root.findAll((n) => n.type === Text && n.props.testID === 'balance-status');
  return line.length ? textOf(line[0]) : null;
};

let resolvers;
let savedState;
const mounted = [];
const answer = async (what, value) => {
  const pending = resolvers[what].splice(0);
  await act(async () => { pending.forEach((r) => r(value)); });
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
    && n.findAllByType(Text).some((x) => textOf(x) === t('unlock_wallet'))).pop();
  await act(async () => { await unlock.props.onPress(); });
  await flush(10);
  return tree;
}

const SNAP = { owner: mockQNET, qnc: 12.5, qncNano: '12500000000', blockHeight: 9000, sol: 0.75, oneDev: 3, tokens: [], at: Date.UTC(2026, 9, 5, 9, 30), chain: 'x' };

beforeEach(async () => {
  await AsyncStorage.clear();
  resolvers = { sol: [], oneDev: [], qnc: [] };
  Object.assign(mockState, {
    snapshot: null,
    saved: [],
    calls: { sol: 0, oneDev: 0, qnc: 0 },
    onFigure: null,
    gate: (what) => new Promise((r) => { resolvers[what].push(r); }),
  });
  savedState = AppState.currentState;
  AppState.currentState = 'active';
  global.fetch = jest.fn(async () => { throw new Error('offline in tests'); });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  AppState.currentState = savedState;
});

it('the last verified figures show at once, with no line while the read runs; one read serves the unlock and the tab', async () => {
  mockState.snapshot = SNAP;
  const tree = await unlocked();
  // Nothing answered yet: the kept figures, and nothing said about the read (the owner, 06.10).
  expect(qncFigure(tree)).toBe('12.5');
  expect(statusLine(tree)).toBeNull();
  // The unlock and the Assets tab asked at once; they share one read of each source.
  expect(mockState.calls).toEqual({ sol: 1, oneDev: 1, qnc: 1 });

  // The QNC answer folded: on screen before the walk decides, still with no line.
  await act(async () => { mockState.onFigure({ balance: 20, balanceNano: '20000000000', nonce: '1', blockHeight: 9090, folded: true }); });
  await flush(2);
  expect(qncFigure(tree)).toBe('20');
  expect(statusLine(tree)).toBeNull();

  // The walk decided (verified): still no line, and the figures are kept for the next session.
  await answer('qnc', { ok: true, balance: 20, balanceNano: '20000000000', verified: true, blockHeight: 9090 });
  await answer('sol', 0.5);
  await answer('oneDev', 4);
  expect(statusLine(tree)).toBeNull();
  expect(qncFigure(tree)).toBe('20');
  expect(mockState.saved).toHaveLength(1);
  expect(mockState.saved[0]).toMatchObject({ owner: mockQNET, qnc: 20, qncNano: '20000000000', blockHeight: 9090, sol: 0.5, oneDev: 4 });
});

it('an unverified lower figure does not lower the kept verified one', async () => {
  mockState.snapshot = SNAP;
  const tree = await unlocked();
  await act(async () => { mockState.onFigure({ balance: 5, balanceNano: '5000000000', nonce: '1', blockHeight: 9090, folded: true }); });
  await flush(2);
  expect(qncFigure(tree)).toBe('12.5');
  await answer('qnc', { ok: true, balance: 5, balanceNano: '5000000000', verified: false, blockHeight: 9090 });
  expect(qncFigure(tree)).toBe('12.5');
  expect(mockState.saved).toHaveLength(0); // nothing a proof did not certify is kept
});

it('with nothing kept, a figure nobody read is a dash; a first read that finds nothing says so', async () => {
  const tree = await unlocked();
  expect(qncFigure(tree)).toBe('—');
  expect(statusLine(tree)).toBeNull();
  await answer('qnc', { ok: false, balance: null, verified: false });
  expect(qncFigure(tree)).toBe('—');
  expect(statusLine(tree)).toBe(t('balance_unavailable'));
});

it('kept figures and a first read that finds nothing: the figures stay, with when they were read', async () => {
  mockState.snapshot = SNAP;
  const tree = await unlocked();
  await answer('qnc', { ok: false, balance: null, verified: false });
  expect(qncFigure(tree)).toBe('12.5');
  expect(statusLine(tree)).toBe(t('balance_stale', { time: dateTime(SNAP.at) }));
});

it('a figure this session read is never replaced by the kept one arriving later', async () => {
  let release;
  mockState.snapshot = SNAP;
  const slowSnapshot = new Promise((r) => { release = r; });
  const WM = require('../src/components/WalletManager').default;
  const original = WM.prototype.loadBalanceSnapshot;
  WM.prototype.loadBalanceSnapshot = async function slow(owner) { await slowSnapshot; return original.call(this, owner); };
  try {
    const tree = await unlocked();
    await answer('qnc', { ok: true, balance: 30, balanceNano: '30000000000', verified: true, blockHeight: 9100 });
    expect(qncFigure(tree)).toBe('30');
    await act(async () => { release(); });
    await flush(6);
    expect(qncFigure(tree)).toBe('30');
    expect(statusLine(tree)).toBeNull();
  } finally {
    WM.prototype.loadBalanceSnapshot = original;
  }
});

it('a call while a read has run for a while (a feed event, a pull, a confirmed send) gets one more read after it', async () => {
  const tree = await unlocked();
  expect(mockState.calls.qnc).toBe(1);
  await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
  const pull = () => tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
    && typeof n.props.refreshControl.props.onRefresh === 'function')[0].props.refreshControl.props.onRefresh;
  await act(async () => { pull()(); pull()(); });
  await flush(2);
  expect(mockState.calls.qnc).toBe(1); // still the one read: the calls wait for it
  await answer('sol', 0.5);
  await answer('oneDev', 4);
  await answer('qnc', { ok: true, balance: 20, balanceNano: '20000000000', verified: true, blockHeight: 9090 });
  expect(mockState.calls).toEqual({ sol: 2, oneDev: 2, qnc: 2 }); // one more read, however many calls came
  await answer('sol', 0.5);
  await answer('oneDev', 4);
  await answer('qnc', { ok: true, balance: 21, balanceNano: '21000000000', verified: true, blockHeight: 9180 });
  expect(mockState.calls.qnc).toBe(2);
  expect(qncFigure(tree)).toBe('21');
});

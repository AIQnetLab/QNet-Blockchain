/**
 * The owner's 06.10 question "can balances load faster?", on the real wallet screen: the last verified figures show the
 * moment the wallet opens, with no line under them while this session's first read runs; each figure lands as
 * soon as its own source answers (QNC as soon as its proof folded, before the lineage walk); one read serves the unlock
 * and the Assets tab; a figure nobody read is a dash, and a wallet with nothing in it shows 0; the line under the figures
 * never flashes with the reads (owner, 11.10): it comes after reads failed for a sustained time, or says the network
 * stopped certifying.
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
    // Whether the network stopped certifying (WalletManager.networkPause): what the test says.
    async networkPause() { return mockState.pause; }
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
  readUnconfirmedBinding: jest.fn(async () => null),
  settleUnconfirmedBinding: jest.fn(async () => false),
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
    pause: null,
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

// One read of every source, each answered: the read is over, so the next call starts a new one.
const pullOf = (tree) => tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
  && typeof n.props.refreshControl.props.onRefresh === 'function')[0].props.refreshControl.props.onRefresh;
const readOnce = async (tree, qnc, { pull = true } = {}) => {
  if (pull) { await act(async () => { pullOf(tree)(); }); await flush(2); }
  await answer('sol', 0.5);
  await answer('oneDev', 4);
  await answer('qnc', qnc);
};
const FAILED = { ok: false, balance: null, verified: false, reason: 'unanswered' };

it('with nothing kept, a figure nobody read is a dash, and one read that finds nothing says nothing yet', async () => {
  const tree = await unlocked();
  expect(qncFigure(tree)).toBe('—');
  expect(statusLine(tree)).toBeNull();
  await answer('qnc', FAILED);
  expect(qncFigure(tree)).toBe('—');
  expect(statusLine(tree)).toBeNull();
});

// Owner, 11.10: a wallet with nothing in it shows 0, never a dash, as soon as a folded 0 comes (WalletManager now
// gives it: CertifiedProofs.test.js), with no line, verified or not.
it('a wallet with nothing in it shows 0 as soon as its folded 0 comes, with no line', async () => {
  const tree = await unlocked();
  await act(async () => { mockState.onFigure({ balance: 0, balanceNano: '0', nonce: '0', blockHeight: 9090, folded: true, figureClaimedEpoch: 0 }); });
  await flush(2);
  expect(qncFigure(tree)).toBe('0');
  expect(statusLine(tree)).toBeNull();
  await answer('qnc', { ok: true, balance: 0, balanceNano: '0', verified: false, blockHeight: 9090, exists: false, reason: 'unconfirmed' });
  expect(qncFigure(tree)).toBe('0');
  expect(statusLine(tree)).toBeNull();
});

// Owner, 11.10: the "Not updated" line never flashes. Before, it went with every read that started and came back with
// every one that found nothing (a wallet whose reads kept failing saw it blink at each read); now it comes only after
// two failures in a row over two minutes at least, stays through the reads that follow, and goes with the first that
// lands.
describe('the line under the figures, over reads that keep failing', () => {
  const clock = { offset: 0 };
  let nowSpy;
  beforeEach(async () => {
    clock.offset = 0;
    const real = Date.now.bind(Date);
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => real() + clock.offset);
    // The clock jumps minutes ahead here: the wallet must not lock itself meanwhile.
    await AsyncStorage.setItem('qnet_autolock_time', 'never');
  });
  afterEach(() => { nowSpy.mockRestore(); });

  it('comes only after two failures over two minutes, stays while reads start and fail, and goes with the first that lands', async () => {
    mockState.snapshot = SNAP;
    const tree = await unlocked();
    const seen = [];
    const look = () => { seen.push(statusLine(tree)); return seen[seen.length - 1]; };
    await readOnce(tree, FAILED, { pull: false });
    expect(look()).toBeNull(); // one failure
    await act(async () => { pullOf(tree)(); });
    await flush(2);
    expect(look()).toBeNull(); // a read that starts says nothing
    await readOnce(tree, FAILED, { pull: false });
    expect(look()).toBeNull(); // two in a row, but not two minutes yet
    clock.offset = 2 * 60_000 + 1000;
    await readOnce(tree, FAILED);
    const stale = t('balance_stale', { time: dateTime(SNAP.at) });
    expect(look()).toBe(stale);
    expect(qncFigure(tree)).toBe('12.5'); // the kept figures stay under it
    // Steady: a read that starts, and one more that fails, change nothing.
    await act(async () => { pullOf(tree)(); });
    await flush(2);
    expect(look()).toBe(stale);
    await readOnce(tree, FAILED, { pull: false });
    expect(look()).toBe(stale);
    // The first read that lands takes it away, a 0 not verified as well as any other figure.
    await readOnce(tree, { ok: true, balance: 0, balanceNano: '0', verified: false, blockHeight: 9180, reason: 'unconfirmed' });
    expect(look()).toBeNull();
    // Over the whole run the line came once and went once: it never blinked.
    const changes = seen.filter((v, i) => i > 0 && v !== seen[i - 1]).length;
    expect(changes).toBe(2);
  });

  it('with nothing kept, the sustained failure says the figures could not be read', async () => {
    const tree = await unlocked();
    await readOnce(tree, FAILED, { pull: false });
    clock.offset = 2 * 60_000 + 1000;
    await readOnce(tree, FAILED);
    expect(statusLine(tree)).toBe(t('balance_unavailable'));
    expect(qncFigure(tree)).toBe('—');
  });

});

// Owner, 11.10: when the network itself stopped certifying, the line says so with the time of its last certified state,
// steadily, whatever the reads give; it goes once the certified head moves again.
it('a network that stopped certifying: one steady line with the time of its last certified state', async () => {
  const since = Date.UTC(2026, 9, 10, 19, 23);
  mockState.pause = { index: 38948, since };
  const tree = await unlocked();
  await readOnce(tree, { ok: true, balance: 2, balanceNano: '2000000000', verified: true, blockHeight: 3505320 }, { pull: false });
  const paused = t('balance_network_paused', { time: dateTime(since) });
  expect(statusLine(tree)).toBe(paused);
  expect(qncFigure(tree)).toBe('2');
  await readOnce(tree, FAILED);
  expect(statusLine(tree)).toBe(paused);
  // A head that cannot be read now keeps what was known.
  mockState.pause = undefined;
  await readOnce(tree, FAILED);
  expect(statusLine(tree)).toBe(paused);
  mockState.pause = null;
  await readOnce(tree, { ok: true, balance: 2, balanceNano: '2000000000', verified: true, blockHeight: 3505410 });
  expect(statusLine(tree)).toBeNull();
});

// The time named is the one the head's checkpoint names once this device verified it; before that no time is named,
// never the time this device first saw the head (WalletManager.networkPause `since` null).
it('a network that stopped certifying, its last certified time not verified here: the line names no time', async () => {
  mockState.pause = { index: 38948, since: null };
  const tree = await unlocked();
  await readOnce(tree, { ok: true, balance: 2, balanceNano: '2000000000', verified: true, blockHeight: 3505320 }, { pull: false });
  expect(statusLine(tree)).toBe(t('balance_network_paused_untimed'));
  // Verified since: the time comes, once.
  const since = Date.UTC(2026, 9, 10, 19, 23);
  mockState.pause = { index: 38948, since };
  await readOnce(tree, FAILED);
  expect(statusLine(tree)).toBe(t('balance_network_paused', { time: dateTime(since) }));
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

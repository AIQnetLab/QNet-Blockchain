/**
 * The owner's 06.10 round on speed, on the real wallet screen:
 * - no "Updating…" line: while a read runs the last figures stay without a word (only a read that found nothing says so);
 * - a tap on Send is taken at once (busy, with a spinner), the checks before the review run together, and a second tap
 *   reads nothing again;
 * - one balance refresh that changes nothing renders the screen only a few times;
 * - History checks token transfers after the balance read, two at a time.
 */
import fs from 'fs';
import path from 'path';
import React, { Profiler } from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
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
    async sentRecipients() { return []; }
    async recentSettledTransactions() { return []; }
    async loadBalanceSnapshot() { return null; }
    async saveBalanceSnapshot() { return true; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return 'light_mobile_1111222233334444'; }
    sessionOpen() { return true; }
    closeSession() {}
    async getBalance() { return mockState.read('sol', 0.5); }
    async getTokenBalance() { return mockState.read('oneDev', 4); }
    async getQNCBalanceWithProof(addr, verify, opts) {
      const r = await mockState.read('qnc', { ok: true, balance: 20, balanceNano: '20000000000', nonce: '3', verified: true, blockHeight: 9090 });
      if (opts && opts.onFigure && r && r.ok) opts.onFigure({ balance: r.balance, balanceNano: r.balanceNano, nonce: r.nonce, blockHeight: 9090, folded: true });
      return r;
    }
    // The send's checks, each counted and answered when the test says.
    certifiedQncForSend() { return mockState.check('balance', { ok: true, verified: true, balanceNano: '20000000000', nonce: '3' }); }
    payableRecipientProblem() { return mockState.check('recipient', null); }
    pendingTransactions() { return mockState.check('kept', []); }
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  FakeWalletManager.recipientAddress = (a) => {
    if (!/^[0-9a-f]{19}eon[0-9a-f]{23}$/.test(String(a))) throw Object.assign(new Error('not an account'), { code: 'HEX_RECIPIENT' });
    return a;
  };
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

// The screen's state changes, counted where an update gives another value than the one held (a merge that returns the
// previous object changes nothing). Each setter keeps one wrapper, so setters stay as stable as React makes them.
const stateChanges = { on: false, count: 0 };
const ReactModule = require('react');
const realUseState = ReactModule.useState;
const wrappedSetters = new WeakMap();
ReactModule.useState = function useStateCounted(init) {
  const pair = realUseState(init);
  let setter = wrappedSetters.get(pair[1]);
  if (!setter) {
    const set = pair[1];
    setter = (update) => set((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      if (stateChanges.on && !Object.is(next, prev)) stateChanges.count += 1;
      return next;
    });
    wrappedSetters.set(set, setter);
  }
  return [pair[0], setter];
};

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;

jest.setTimeout(120000);

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('');
const texts = (tree) => tree.root.findAllByType(Text).map(textOf).join('\n');
const byTestId = (tree, id) => tree.root.findAll((n) => n.props && n.props.testID === id);

let savedState;
let commits;
const mounted = [];

async function unlocked() {
  let tree;
  const onRender = () => { commits += 1; };
  await act(async () => { tree = renderer.create(<Profiler id="wallet" onRender={onRender}><WalletScreen /></Profiler>); });
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

async function sendForm() {
  const tree = await unlocked();
  const send = tree.root.findAll((n) => n.props.testID === 'assets-send' && typeof n.props.onPress === 'function')[0];
  await act(async () => { send.props.onPress(); });
  await flush(2);
  const to = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('send_placeholder_eon'))[0];
  await act(async () => { to.props.onChangeText(TO); });
  await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('0.5'); });
  await flush(2);
  return tree;
}

const sendButton = (tree) => byTestId(tree, 'send-button').find((n) => typeof n.props.onPress === 'function');

beforeEach(async () => {
  await AsyncStorage.clear();
  commits = 0;
  Object.assign(mockState, {
    calls: [],
    held: { balance: [], recipient: [], kept: [] },
    gated: false,
    read: async (what, value) => value,
    check(what, value) {
      this.calls.push(what);
      if (!this.gated) return Promise.resolve(value);
      return new Promise((resolve) => { this.held[what].push(() => resolve(value)); });
    },
  });
  savedState = AppState.currentState;
  AppState.currentState = 'active';
  global.fetch = jest.fn(async () => { throw new Error('offline in tests'); });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  AppState.currentState = savedState;
});

describe('no "Updating…"', () => {
  it('no table has the line, and while the first read runs nothing is said under the figures', async () => {
    for (const loc of ['en', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh-CN', 'ar']) {
      expect(require(`../src/i18n/locales/${loc}`).default.balance_updating).toBeUndefined();
    }
    mockState.read = (what, value) => (what === 'qnc' ? new Promise(() => {}) : Promise.resolve(value));
    const tree = await unlocked();
    expect(byTestId(tree, 'balance-status')).toEqual([]);
    expect(texts(tree)).not.toMatch(/Updating/);
  });
});

describe('the Send button', () => {
  it('is busy at once on a tap; the checks run together; a second tap reads nothing again', async () => {
    const tree = await sendForm();
    mockState.gated = true;
    mockState.calls = [];
    await act(async () => { sendButton(tree).props.onPress(); });
    await flush(1);
    // Taken at once: a spinner, and the button off, before any check answered.
    expect(byTestId(tree, 'send-busy').length).toBeGreaterThan(0);
    expect(sendButton(tree).props.disabled).toBe(true);
    expect(sendButton(tree).props.accessibilityState).toEqual({ busy: true });
    // The balance, the recipient and the kept transactions are all asked before any answers.
    expect([...mockState.calls].sort()).toEqual(['balance', 'kept', 'recipient']);
    // A second tap, even one that lands before the screen turned busy, starts nothing.
    await act(async () => { sendButton(tree).props.onPress(); });
    await flush(1);
    expect(mockState.calls).toHaveLength(3);
    // The checks answer: the review opens, the button stays busy until the send is over.
    await act(async () => { for (const k of ['balance', 'recipient', 'kept']) mockState.held[k].splice(0).forEach((go) => go()); });
    await flush(6);
    expect(texts(tree)).toContain(t('send_review_title'));
    expect(byTestId(tree, 'send-busy').length).toBeGreaterThan(0);
  });

  it('a balance the committee did not certify in time refuses the send, saying the network did not answer', async () => {
    const tree = await sendForm();
    mockState.check = function check(what, value) {
      this.calls.push(what);
      return Promise.resolve(what === 'balance' ? { ok: false, verified: false, balanceNano: null, error: 'unanswered' } : value);
    };
    await act(async () => { sendButton(tree).props.onPress(); });
    await flush(6);
    expect(texts(tree)).toContain(t('send_balance_unreadable'));
    expect(t('send_balance_unreadable')).toMatch(/network did not answer/);
    expect(texts(tree)).not.toContain(t('send_review_title'));
    // Over: the button is free again.
    expect(byTestId(tree, 'send-busy')).toEqual([]);
  });

  it('the wait before the review is the slowest check, not the sum of them', async () => {
    const tree = await sendForm();
    const DELAY = 600;
    let inFlight = 0;
    let most = 0;
    mockState.check = function check(what, value) {
      this.calls.push(what);
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise((resolve) => { setTimeout(() => { inFlight -= 1; resolve(value); }, DELAY); });
    };
    const t0 = Date.now();
    await act(async () => { sendButton(tree).props.onPress(); });
    while (!texts(tree).includes(t('send_review_title'))) {
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      if (Date.now() - t0 > 20_000) throw new Error('no review');
    }
    const took = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[bench] three checks of ${DELAY} ms each before the review: ${took} ms`);
    // All three were waiting at once, so the wait is one check's, whatever the machine's speed adds to it.
    expect(most).toBe(3);
    expect([...mockState.calls].sort()).toEqual(['balance', 'kept', 'recipient']);
  });
});

describe('one balance refresh', () => {
  it('that changes nothing renders the screen only a few times', async () => {
    const tree = await unlocked();
    await flush(6);
    // Past the moment a new call would share the unlock's read (BALANCE_SHARE_MS).
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    const pull = tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
      && typeof n.props.refreshControl.props.onRefresh === 'function')[0].props.refreshControl.props.onRefresh;
    // Each source answers on its own, as over a network: SOL, then 1DEV, then QNC (its figure, then its proof).
    const held = { sol: [], oneDev: [], qnc: [] };
    mockState.read = (what, value) => new Promise((resolve) => { held[what].push(() => resolve(value)); });
    const before = commits;
    stateChanges.count = 0;
    stateChanges.on = true;
    try {
      await act(async () => { pull(); });
      for (const what of ['sol', 'oneDev', 'qnc']) {
        await act(async () => { held[what].splice(0).forEach((go) => go()); });
        await flush(2);
      }
      await flush(6);
    } finally {
      stateChanges.on = false;
    }
    const renders = commits - before;
    // eslint-disable-next-line no-console
    console.log(`[bench] one balance refresh with nothing changed: ${stateChanges.count} state changes, ${renders} commits`);
    // The pull's own spinner on and off, and the time the QNC figure was read: SOL, 1DEV, the token list and the kept
    // transactions, unchanged, change nothing.
    expect(stateChanges.count).toBeLessThanOrEqual(3);
    expect(renders).toBeLessThanOrEqual(4);
    expect(renders).toBeGreaterThan(0);
  });
});

describe('History', () => {
  it('checks token transfers after the balance read in flight, two at a time', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    expect(ws).toMatch(/const HISTORY_PROOF_CONCURRENCY = 2;/);
    const p4 = ws.slice(ws.indexOf('const provable = tokenTxs.filter'), ws.indexOf('// The next older explorer page'));
    const waits = p4.indexOf('await balanceRead.promise.catch(() => {});');
    const proves = p4.indexOf('walletManager.verifyTokenTransferInclusion(row)');
    expect(waits).toBeGreaterThan(0);
    expect(proves).toBeGreaterThan(waits);
    expect(p4).toMatch(/await Promise\.all\(Array\.from\(\{ length: Math\.min\(HISTORY_PROOF_CONCURRENCY, provable\.length\) \}, proveRows\)\);/);
    expect(p4).not.toMatch(/provable\.map\(async/);
  });
});

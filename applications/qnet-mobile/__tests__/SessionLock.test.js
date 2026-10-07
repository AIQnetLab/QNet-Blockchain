// The wallet screen's locks, rendered: a recovery phrase typed for import never outlives leaving the app (MS1-02),
// the time away is measured on the boot clock as well as the wall clock, which the holder of the phone can set back
// (MS1-04), and the phrase is not shown or typed before the apps that can read the screen are named (MS1-06).
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockState = {};
const mockClock = { mono: 1_000_000 };
const mockReaders = { list: [] };

jest.mock('../src/services/DeviceSecurity', () => ({
  ...jest.requireActual('../src/services/DeviceSecurity'),
  bootClock: jest.fn(async () => ({ mono: mockClock.mono, wall: Date.now() })),
  screenReaderApps: jest.fn(async () => mockReaders.list),
}));

jest.mock('../src/components/WalletManager', () => {
  class VaultCorruptError extends Error {}
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  class FakeWalletManager {
    constructor() {
      mockState.instances.push(this);
      return new Proxy(this, {
        get: (target, prop) => {
          if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
          return async () => null;
        },
      });
    }
    async prepareInstall() {}
    async purgeLegacyBiometric() { return false; }
    async legacyBiometricNotice() { return false; }
    async vaultState() { return mockState.vault; }
    async isBiometricEnabled() { return !!mockState.bio; }
    async confirmWithBiometrics(reason, note) { mockState.bioCalls.push([reason, note]); return mockState.bioAnswer; }
    async isBiometricSupported() { return false; }
    async getPasswordLockStatus() { return { locked: false }; }
    async unlockWithPassword() { return { ok: true, token: 'session-token' }; }
    async checkPassword() { return { ok: true }; }
    async canStoreNewWallet() { return true; }
    async loadWallet() { return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    async generateWallet() { mockState.generated += 1; return { mnemonic: words.join(' '), address: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    async revealMnemonic() { return { ok: true, mnemonic: words.join(' ') }; }
    getBIP39WordList() { return [...words, 'zebra', 'zero', 'zone', 'zoo']; }
    getTrustedNodes() { return []; }
    trustedNodeUrl() { return 'https://node.invalid'; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (a committee-certified balance): the same figure.
    async certifiedQncForSend() { return { ok: true, verified: true, balanceNano: '1000000000', nonce: '4' }; }
    async getTokenHoldings() { return []; }
    async pendingTransactions() { return mockState.pending; }
    async recentSettledTransactions() { return mockState.recent; }
    async previewSend() { return mockState.preview; }
    async sendTransaction(...args) { mockState.sends.push(args); return { success: true, txHash: 'f'.repeat(64) }; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return 'light_x'; }
    generateSuperNodePseudonym() { return 'super_x'; }
    sessionOpen() { return true; }
    closeSession() { mockState.closed += 1; }
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  // The real rule (MOBNET-R4-01): value goes only to a checksummed EON address; 64 hex is a contract or a hash.
  FakeWalletManager.recipientAddress = (a) => {
    if (!/^[0-9a-f]{19}eon[0-9a-f]{23}$/.test(String(a))) throw Object.assign(new Error('not an account'), { code: 'HEX_RECIPIENT' });
    return a;
  };
  return { __esModule: true, default: FakeWalletManager, WalletManager: FakeWalletManager, VaultCorruptError };
});

jest.mock('../src/services/PushService', () => ({
  BG_REFRESH_STATUS_KEY: 'qnet_bg_refresh_status',
  checkNodeStatus: jest.fn(async () => null),
  readdressIfOwed: jest.fn(async () => false),
  selfAttestIfNeeded: jest.fn(async () => true),
  checkServerNodeStatus: jest.fn(async () => ({ success: false })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [] })),
  getNodeEpochs: jest.fn(async () => null),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 0 })),
  refreshFcmTokenOnServer: jest.fn(async () => ({})),
  isTokenRefreshNeeded: jest.fn(async () => false),
  teardownLightNode: jest.fn(async () => {}),
  teardownLightNodeIfForeign: jest.fn(async () => {}),
}));
jest.mock('../src/services/HistoryCache', () => ({ loadCachedHistory: jest.fn(async () => []), saveCachedHistory: jest.fn(async () => {}) }));
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View); };
});
// A link URL of the tests (mockLinks) parses to its link; any other URL is no link.
const mockLinks = {};
jest.mock('../src/services/QNetLink', () => ({
  parseLink: jest.fn((url) => mockLinks[url] || null),
  takeInitialUrl: jest.fn(async () => null),
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');
function pressable(tree, text) {
  const all = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('').includes(text)));
  if (!all.length) throw new Error(`nothing to press labelled "${text}"`);
  return all[all.length - 1];
}
const press = async (tree, key) => { await act(async () => { await pressable(tree, t(key)).props.onPress(); }); await flush(); };
// For a press whose handler waits on a dialog the test answers next.
const tap = async (tree, key) => { await act(async () => { pressable(tree, t(key)).props.onPress(); }); await flush(); };
const input = (tree, key) => tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t(key))[0];
const type = async (tree, key, value) => { await act(async () => { input(tree, key).props.onChangeText(value); }); await flush(1); };

let appStateListeners;
let appStateBefore;
let now;
const emit = async (state) => { await act(async () => { appStateListeners.slice().forEach((fn) => fn(state)); }); await flush(); };

let mounted = [];
async function mount() {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  await flush(6);
  mounted.push(tree);
  return tree;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(mockState, {
    vault: 'none', instances: [], closed: 0, generated: 0, pending: [], recent: [], preview: null, sends: [],
    bio: false, bioCalls: [], bioAnswer: { ok: false, fallback: true },
  });
  mockClock.mono = 1_000_000;
  mockReaders.list = [];
  appStateListeners = [];
  // The app is in front, as it is whenever the lock screen or a send form is on screen (MA-R2-02 reads the real state).
  appStateBefore = AppState.currentState;
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'change') appStateListeners.push(fn);
    return { remove: () => { appStateListeners = appStateListeners.filter((f) => f !== fn); } };
  });
  now = Date.UTC(2026, 8, 25, 10, 0, 0);
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  jest.restoreAllMocks();
  AppState.currentState = appStateBefore;
});

async function toImportPhrase(tree) {
  await press(tree, 'import_wallet');
  await type(tree, 'enter_password', 'Otter-Canyon-58');
  await type(tree, 'confirm_password', 'Otter-Canyon-58');
  await press(tree, 'common_next');
}

describe('a new wallet password: at least 8 characters, typed twice, nothing else (the rule both wallets had)', () => {
  it('shows the length line from × to ✓ and the match, refuses 7 characters and takes any 8 at import', async () => {
    const line = t('pw_min_chars', { min: 8 });
    const tree = await mount();
    await press(tree, 'import_wallet');
    expect(texts(tree)).toContain(`× ${line}`);
    await type(tree, 'enter_password', '1234567');
    await type(tree, 'confirm_password', '1234567');
    await press(tree, 'common_next');
    expect(texts(tree)).toContain(t('pw_too_short', { min: 8, left: 1 }));
    expect(input(tree, 'import_placeholder')).toBeUndefined();
    await type(tree, 'enter_password', '12345678');
    expect(texts(tree)).toContain(`✓ ${line}`);
    expect(texts(tree)).toContain(t('pw_mismatch'));
    await type(tree, 'confirm_password', '12345678');
    expect(texts(tree)).toContain(`✓ ${t('pw_match')}`);
    await press(tree, 'common_next');
    expect(input(tree, 'import_placeholder')).toBeDefined();
  });
});

describe('a recovery phrase typed for import (MS1-02)', () => {
  it('is gone the moment the app goes to the background', async () => {
    const tree = await mount();
    await toImportPhrase(tree);
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    await type(tree, 'import_placeholder', phrase);
    expect(input(tree, 'import_placeholder').props.value).toBe(phrase);
    await emit('background');
    expect(input(tree, 'import_placeholder').props.value).toBe('');
  });

  it('a pasted phrase leaves the clipboard on every exit: background, Back, a failed import (MPLAT-R2-03)', async () => {
    const Clipboard = require('@react-native-clipboard/clipboard').default;
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    // Background.
    let tree = await mount();
    await toImportPhrase(tree);
    Clipboard.setString.mockClear();
    await type(tree, 'import_placeholder', phrase);
    await emit('background');
    expect(Clipboard.setString).toHaveBeenCalledWith('');
    await act(async () => { tree.unmount(); });
    mounted.pop();
    // Back on the phrase step.
    tree = await mount();
    await toImportPhrase(tree);
    Clipboard.setString.mockClear();
    await type(tree, 'import_placeholder', phrase);
    await press(tree, 'common_back');
    expect(Clipboard.setString).toHaveBeenCalledWith('');
    await act(async () => { tree.unmount(); });
    mounted.pop();
    // A failed import keeps the text for a fix, not the clipboard.
    tree = await mount();
    await toImportPhrase(tree);
    Clipboard.setString.mockClear();
    await type(tree, 'import_placeholder', phrase);
    const wm = mockState.instances[mockState.instances.length - 1];
    wm.importWallet = async () => { throw new Error('bad checksum'); };
    await press(tree, 'terms_of_service');
    await press(tree, 'accept');
    await press(tree, 'import_title');
    await flush(4);
    expect(Clipboard.setString).toHaveBeenCalledWith('');
    expect(input(tree, 'import_placeholder').props.value).toBe(phrase);
  });

  it('is left alone by a brief visit to the notification shade (inactive), which never shows it elsewhere', async () => {
    const tree = await mount();
    await toImportPhrase(tree);
    await type(tree, 'import_placeholder', 'abandon ability');
    await emit('inactive');
    await emit('active');
    expect(input(tree, 'import_placeholder').props.value).toBe('abandon ability');
  });
});

describe('the time away (MS1-04)', () => {
  async function unlocked() {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    return tree;
  }

  // A user report (29.09) against 1.1.7: the phrase shown from Settings stayed up after the screen went off and was
  // there, above the password screen, the next morning. It goes the moment the app leaves the front (the screen going
  // off included), and a lock on return shows the password screen with no phrase.
  it('the phrase shown from Settings goes when the app leaves the front, and never shows above the lock', async () => {
    const tree = await unlocked();
    const shown = async () => {
      await press(tree, 'tab_settings');
      await press(tree, 'export_recovery_phrase');
      await type(tree, 'password', 'Otter-Canyon-58');
      await press(tree, 'show');
      expect(texts(tree)).toContain('absurd');
    };
    await shown();
    await emit('inactive');
    expect(texts(tree)).not.toContain('absurd');
    await emit('active');
    await shown();
    await emit('background');
    expect(texts(tree)).not.toContain('absurd');
    mockClock.mono += 12 * 3600_000;
    now += 12 * 3600_000;
    await emit('active');
    await flush(6);
    expect(texts(tree)).not.toContain('absurd');
    expect(texts(tree)).toContain(t('unlock_wallet'));
  });

  // APP-PHRASE-01: the vault opens in seconds (key derivation). A phrase that arrives after the app left the front, or
  // after the wallet locked, is not put on screen: not on return within the grace time, not after the next unlock.
  const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  async function showDeferred(tree, wm) {
    let release = null;
    wm.revealMnemonic = () => new Promise((resolve) => { release = () => resolve({ ok: true, mnemonic: WORDS }); });
    await press(tree, 'tab_settings');
    await press(tree, 'export_recovery_phrase');
    await type(tree, 'password', 'Otter-Canyon-58');
    await tap(tree, 'show'); // the handler waits on the vault, which the test opens later
    await flush(4);
    expect(typeof release).toBe('function');
    return release;
  }

  it('a phrase whose vault opens after the app left the front is not shown on return', async () => {
    const tree = await unlocked();
    const wm = mockState.instances[mockState.instances.length - 1];
    const release = await showDeferred(tree, wm);
    AppState.currentState = 'background'; // emit() only calls the listeners
    await emit('background');
    await act(async () => { release(); });
    await flush(4);
    mockClock.mono += 5_000;
    now += 5_000;
    AppState.currentState = 'active';
    await emit('active');
    await flush(6);
    expect(texts(tree)).not.toContain(t('unlock_wallet')); // within the grace time: still open
    expect(texts(tree)).not.toContain('absurd');
    expect(input(tree, 'password')).toBeUndefined(); // the export dialog is closed
  });

  it('a phrase whose vault opens after the wallet locked is not shown after the next unlock', async () => {
    const tree = await unlocked();
    const wm = mockState.instances[mockState.instances.length - 1];
    // The session as the real manager keeps it: each unlock a new token, a lock drops it.
    let token = 'session-token';
    let unlocks = 0;
    wm.unlockWithPassword = async () => { unlocks += 1; token = `session-${unlocks}`; return { ok: true, token }; };
    wm.sessionOpen = (x) => x === token;
    wm.closeSession = () => { mockState.closed += 1; token = null; };
    const release = await showDeferred(tree, wm);
    AppState.currentState = 'background';
    await emit('background');
    mockClock.mono += 12 * 3600_000;
    now += 12 * 3600_000;
    AppState.currentState = 'active';
    await emit('active');
    await flush(6);
    expect(texts(tree)).toContain(t('unlock_wallet'));
    await act(async () => { release(); }); // the derivation resumes after the lock and finishes
    await flush(4);
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    expect(unlocks).toBe(1);
    expect(texts(tree)).not.toContain(t('unlock_wallet'));
    expect(texts(tree)).not.toContain('absurd');
  });

  it('locks when the boot clock says the grace time passed, though the wall clock was set back', async () => {
    const tree = await unlocked();
    expect(texts(tree)).not.toContain(t('unlock_wallet'));
    await emit('background');
    await flush();
    // Four hours later on the boot clock; the wall clock was set back to 30 s after leaving.
    mockClock.mono += 4 * 3600_000;
    now += 30_000;
    await emit('active');
    await flush(6);
    expect(mockState.closed).toBeGreaterThan(0);
    expect(texts(tree)).toContain(t('unlock_wallet'));
  });

  it('does not lock within the grace time on both clocks', async () => {
    const tree = await unlocked();
    const closed = mockState.closed;
    await emit('background');
    await flush();
    mockClock.mono += 20_000;
    now += 20_000;
    await emit('active');
    await flush(6);
    expect(mockState.closed).toBe(closed);
    expect(texts(tree)).not.toContain(t('unlock_wallet'));
  });

  it('a wall clock that jumps past the grace time still locks at once', async () => {
    const tree = await unlocked();
    await emit('background');
    await flush();
    mockClock.mono += 5_000;
    now += 2 * 3600_000;
    await emit('active');
    await flush(6);
    expect(texts(tree)).toContain(t('unlock_wallet'));
  });
});

describe('a longer auto-lock takes the password again on Android (MVA-R2-07)', () => {
  it('1 → 30 minutes is saved only after a fresh password; a shorter time needs none', async () => {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    await act(async () => { tree.root.find((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush(4);
    await press(tree, 'autolock_1');
    await tap(tree, 'autolock_30');
    await flush(4);
    expect(texts(tree)).toContain(t('fresh_title'));
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBeNull();
    await press(tree, 'cancel');
    await flush(4);
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBeNull();

    await press(tree, 'autolock_1');
    await tap(tree, 'autolock_30');
    await flush(4);
    await type(tree, 'password', 'Otter-Canyon-58');
    await press(tree, 'common_confirm');
    await flush(6);
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBe('30');

    await press(tree, 'autolock_30');
    await tap(tree, 'autolock_1');
    await flush(4);
    expect(texts(tree)).not.toContain(t('fresh_title'));
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBe('1');
  });
});

describe('apps that can read the screen are named first (MS1-06)', () => {
  it('before a new wallet\'s phrase is shown', async () => {
    mockReaders.list = ['Totally Helpful Reader'];
    const tree = await mount();
    await press(tree, 'create_new_wallet');
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await type(tree, 'confirm_password', 'Otter-Canyon-58');
    await press(tree, 'terms_of_service');
    await press(tree, 'accept');
    await tap(tree, 'create_wallet');
    expect(texts(tree)).toContain(t('readers_title'));
    expect(texts(tree)).toContain('Totally Helpful Reader');
    expect(mockState.generated).toBe(0);
    await press(tree, 'readers_continue');
    await flush(6);
    expect(mockState.generated).toBe(1);
    expect(texts(tree)).toContain(t('seed_save_title'));
  });

  it('before the phrase is typed for import, and Cancel stays on the password step', async () => {
    mockReaders.list = ['Totally Helpful Reader'];
    const tree = await mount();
    await press(tree, 'import_wallet');
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await type(tree, 'confirm_password', 'Otter-Canyon-58');
    await tap(tree, 'common_next');
    expect(texts(tree)).toContain(t('readers_title'));
    expect(input(tree, 'import_placeholder')).toBeUndefined();
    await press(tree, 'cancel');
    expect(input(tree, 'import_placeholder')).toBeUndefined();
    await tap(tree, 'common_next');
    await press(tree, 'readers_continue');
    expect(input(tree, 'import_placeholder')).toBeDefined();
  });
});

describe('a send while this wallet has an unconfirmed transaction (MOBNET-R1-01)', () => {
  const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
  const pendingView = { nonce: 5, state: 'open', held: false, kind: 'transfer', to: TO, amountNano: 500_000_000, method: null, ageMs: 120_000, bodyHash: 'h5' };

  async function confirmPassword(tree) {
    await type(tree, 'password', 'Otter-Canyon-58');
    await press(tree, 'common_confirm');
    await flush(6);
  }

  // The review of the send (MPLAT-R5-01): it arms once it stayed untouched; its Confirm goes on to the fresh check.
  async function review(tree) {
    expect(texts(tree)).toContain(t('send_review_title'));
    expect(mockState.sends).toEqual([]);
    const { SEND_ARM_MS } = require('../src/browser/dappProvider');
    await act(async () => { await new Promise((r) => { setTimeout(r, SEND_ARM_MS + 100); }); });
    const confirm = tree.root.findAll((n) => n.props && n.props.testID === 'send-review-confirm' && typeof n.props.onPress === 'function')[0];
    await act(async () => { confirm.props.onPressIn(); confirm.props.onPress(); });
    await flush(4);
  }

  async function sendForm(to = TO) {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    await press(tree, 'assets_send');
    await type(tree, 'send_placeholder_eon', to);
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('0.5'); });
    await flush(1);
    return tree;
  }

  it('names it, and signs nothing until the user chooses; Replace signs at its nonce', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false, recent: [] };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    const shown = texts(tree);
    expect(shown).toContain(t('pending_dialog_title'));
    expect(shown).toContain(`0.5 QNC to ${TO}`);
    expect(shown).toContain(t('send_repeat_body', { minutes: 2 })); // the same payment, two minutes ago
    expect(shown).toContain(t('pending_append_unavailable'));
    expect(mockState.sends).toEqual([]);
    expect(() => pressable(tree, t('pending_append'))).toThrow(); // not offered over a transaction no node holds
    await tap(tree, 'pending_replace');
    await flush(4);
    await review(tree);
    expect(mockState.sends).toEqual([]); // the fresh password first (MPLAT-R2-01)
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    expect(mockState.sends[0][5]).toEqual({ choice: { mode: 'replace', nonce: 5, bodyHash: 'h5' } });
  });

  it('every send asks for the password again; without it nothing is signed (MPLAT-R2-01)', async () => {
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    expect(texts(tree)).toContain(t('fresh_title'));
    expect(texts(tree)).toContain(t('send_confirm_reason', { amount: '0.5 QNC' }));
    // The whole recipient is on the prompt that approves the send (MPLAT-R5-01).
    expect(texts(tree)).toContain(require('../src/utils/addressDisplay').groupAddress(TO));
    expect(mockState.sends).toEqual([]);
    await press(tree, 'cancel');
    await flush(4);
    expect(mockState.sends).toEqual([]);
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
  });

  it('after a send, the held expected balance carries no proof label (MOBNET-R2-07; the screens show none)', async () => {
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    await press(tree, 'common_done');
    // The next refresh (here the return from a short trip away) reads a verified proof of the old balance while
    // the screen holds the expected one.
    await emit('background');
    await emit('active');
    await flush(8);
    const shown = texts(tree);
    expect(shown).not.toMatch(/verified by proof/i);
    expect(shown).not.toContain('✓ ');
  });

  it('Cancel sends nothing', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false, recent: [] };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await press(tree, 'cancel');
    await flush(4);
    expect(mockState.sends).toEqual([]);
  });

  it('with nothing unconfirmed, the same payment settled minutes ago is named before anything is signed', async () => {
    mockState.recent = [{ nonce: 4, kind: 'transfer', to: TO, amountNano: 500_000_000, method: null, settledAt: now - 5 * 60_000 }];
    const tree = await sendForm();
    await tap(tree, 'send_button');
    expect(texts(tree)).toContain(t('send_repeat_body', { minutes: 5 }));
    expect(mockState.sends).toEqual([]);
    await tap(tree, 'send_repeat_send_anyway');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    expect(mockState.sends[0][5]).toEqual({ choice: null });
  });

  // MOBNET-R4-01: no key controls a 64-hex account, so value sent there is gone for good.
  it('a 64-hex recipient (a pasted contract, a transaction id) is refused before anything is asked or signed', async () => {
    for (const to of ['c'.repeat(64), 'C'.repeat(64)]) {
      const tree = await sendForm(to);
      await tap(tree, 'send_button');
      await flush(4);
      expect(texts(tree)).toContain(t('send_invalid_address'));
      expect(texts(tree)).not.toContain(t('fresh_title'));
      expect(mockState.sends).toEqual([]);
      await act(async () => { tree.unmount(); });
      mounted.pop();
    }
    expect(t('send_invalid_address')).not.toMatch(/or hex/i);
  });

  // MPLAT-R4-01: an accessibility service that reads or types the password gains nothing it can use unseen.
  it('names the apps that can read the screen on the fresh prompt of every send', async () => {
    mockReaders.list = ['Totally Helpful Reader'];
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    expect(texts(tree)).toContain(t('fresh_title'));
    expect(texts(tree)).toContain(t('readers_confirm_note', { apps: 'Totally Helpful Reader' }));
    expect(mockState.sends).toEqual([]);
  });

  it('with biometric unlock on, the system prompt bound to the vault key confirms; nothing is typed', async () => {
    mockState.bio = true;
    mockState.bioAnswer = { ok: true };
    mockReaders.list = ['Totally Helpful Reader'];
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(6);
    await review(tree);
    expect(mockState.bioCalls).toEqual([[t('send_confirm_reason', { amount: '0.5 QNC' }),
      t('readers_confirm_note', { apps: 'Totally Helpful Reader' })]]);
    expect(texts(tree)).not.toContain(t('fresh_title'));
    expect(mockState.sends).toHaveLength(1);
  });

  it('"Use password" on the system prompt falls back to the typed password; a refused prompt sends nothing', async () => {
    mockState.bio = true;
    mockState.bioAnswer = { ok: false, fallback: true };
    let tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    expect(mockState.bioCalls).toHaveLength(1);
    expect(texts(tree)).toContain(t('fresh_title'));
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    await act(async () => { tree.unmount(); });
    mounted.pop();

    mockState.sends = [];
    mockState.bioAnswer = { ok: false };
    tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    expect(texts(tree)).not.toContain(t('fresh_title'));
    expect(mockState.sends).toEqual([]);
  });
});

describe('apps that can read the screen are named on the lock screen (MPLAT-R4-01)', () => {
  it('every time it is up, not only before a recovery phrase', async () => {
    mockReaders.list = ['Totally Helpful Reader'];
    mockState.vault = 'ok';
    const tree = await mount();
    expect(texts(tree)).toContain(t('unlock_wallet'));
    expect(texts(tree)).toContain(t('readers_lock_note', { apps: 'Totally Helpful Reader' }));
    mockReaders.list = [];
    const clean = await mount();
    expect(texts(clean)).not.toContain(t('readers_lock_note', { apps: '' }).split(':')[0]);
  });
});

// R4-MOBLINK-01: another app can start the wallet with a link of its own at any moment. Once the user has a request in
// front of them, a different link never takes its place: it waits until that one is closed and then says it is another
// request.
describe('a QNet Link request on screen is never swapped for another one', () => {
  const { Linking } = require('react-native');
  const QNetLink = require('../src/services/QNetLink');
  const A = { id: 'a'.repeat(32), sitePub: 'b'.repeat(43), intent: 'connect' };
  const B = { id: 'c'.repeat(32), sitePub: 'd'.repeat(43), intent: 'connect' };
  const URL_A = 'https://link.aiqnet.io/l#a';
  const URL_B = 'https://link.aiqnet.io/l#b';
  let urlListeners;
  const deliver = async (url) => { await act(async () => { urlListeners.forEach((fn) => fn({ url })); }); await flush(6); };
  const opened = () => QNetLink.openSession.mock.calls.map((c) => c[0].id);
  // The link screen's Confirm: the button with a press-in handler (utils/useArmedConfirm), pressed as a finger does.
  const pressConfirm = async (tree) => {
    const b = tree.root.findAll((n) => typeof n.props.onPress === 'function' && typeof n.props.onPressIn === 'function'
      && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('link_confirm')));
    await act(async () => { b[b.length - 1].props.onPressIn(); b[b.length - 1].props.onPress(); });
    await flush(4);
  };

  beforeEach(() => {
    urlListeners = [];
    jest.spyOn(Linking, 'addEventListener').mockImplementation((type, fn) => {
      if (type === 'url') urlListeners.push(fn);
      return { remove: () => {} };
    });
    Object.assign(mockLinks, { [URL_A]: A, [URL_B]: B });
    QNetLink.openSession.mockReset();
    QNetLink.openSession.mockImplementation(async () => ({ expiresAt: now + 600_000 }));
    QNetLink.prepareOffer.mockReset();
    QNetLink.prepareOffer.mockImplementation(async () => ({ kind: 'connect', addresses: { qnet: mockQNET, solana: mockSOL } }));
    QNetLink.performIntent.mockReset();
    QNetLink.deliverAnswer.mockReset();
    QNetLink.deliverAnswer.mockImplementation(async () => 'delivered');
    QNetLink.markHandled.mockReset();
    QNetLink.markHandled.mockImplementation(async () => {});
  });

  async function unlockedWallet() {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    return tree;
  }

  it('a link that arrives while one is on screen waits, and comes after it with a note', async () => {
    const tree = await unlockedWallet();
    await deliver(URL_A);
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).toContain(t('link_title_connect'));
    await deliver(URL_B);
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).not.toContain(t('link_after_other'));
    await press(tree, 'link_reject');
    await flush(4);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(A, expect.anything(), { status: 'rejected' }, expect.anything());
    await press(tree, 'link_close');
    await flush(6);
    expect(opened()).toEqual([A.id, B.id]);
    expect(texts(tree)).toContain(t('link_after_other'));
  });

  it('a link that arrives while the user authenticates the request on screen does not take its place', async () => {
    const tree = await unlockedWallet();
    await deliver(URL_A);
    await act(() => new Promise((r) => { setTimeout(r, 1100); })); // Confirm arms
    await pressConfirm(tree);
    expect(texts(tree)).toContain(t('fresh_title'));
    expect(texts(tree)).toContain(t('link_auth_connect'));
    await deliver(URL_B);
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).toContain(t('link_auth_connect')); // the prompt is still the one for A, over A
    await press(tree, 'cancel');
    await flush(4);
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).toContain(t('link_title_connect'));
  });

  // MOBLINK-R5-01: the password prompt of the wallet's own send, open when a link arrives, is ended by it: a password
  // typed "for aiqnet.io" never resumes that send.
  it('a link ends the password prompt a send left open; nothing is sent', async () => {
    const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const tree = await unlockedWallet();
    await press(tree, 'assets_send');
    await type(tree, 'send_placeholder_eon', TO);
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('0.5'); });
    await flush(1);
    await tap(tree, 'send_button');
    await flush(4);
    const { SEND_ARM_MS } = require('../src/browser/dappProvider');
    await act(async () => { await new Promise((r) => { setTimeout(r, SEND_ARM_MS + 100); }); });
    const confirm = tree.root.findAll((n) => n.props && n.props.testID === 'send-review-confirm' && typeof n.props.onPress === 'function')[0];
    await act(async () => { confirm.props.onPressIn(); confirm.props.onPress(); });
    await flush(4);
    expect(texts(tree)).toContain(t('send_confirm_reason', { amount: '0.5 QNC' }));
    await deliver(URL_A);
    expect(texts(tree)).not.toContain(t('send_confirm_reason', { amount: '0.5 QNC' }));
    expect(texts(tree)).toContain(t('link_title_connect'));
    expect(input(tree, 'password')).toBeUndefined();
    expect(mockState.sends).toEqual([]);
  });

  it('the same link twice is one request, and a request not seen yet (behind the lock screen) may be replaced', async () => {
    mockState.vault = 'ok';
    const tree = await mount();
    await deliver(URL_A);
    await deliver(URL_B);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    expect(opened()).toEqual([B.id]);
    await deliver(URL_B);
    expect(opened()).toEqual([B.id]);
    expect(texts(tree)).not.toContain(t('link_after_other'));
  });
});

describe('the recovery phrase\'s Copy (an explicit tap only)', () => {
  const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const lines = (tree) => texts(tree).split('\n');
  // No native module here: the copy's JS timer is stopped, as Delete wallet would.
  afterEach(async () => { await require('../src/services/DeviceSecurity').clearSecretCopy(); });
  const pressExact = async (tree, text) => {
    const all = tree.root.findAll((n) => typeof n.props.onPress === 'function'
      && n.findAllByType(Text).some((x) => [].concat(x.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('') === text));
    if (!all.length) throw new Error(`nothing to press labelled exactly "${text}"`);
    await act(async () => { await all[all.length - 1].props.onPress(); });
    await flush();
  };

  it('on a new wallet\'s phrase: the warning next to it, nothing copied until the tap, then the words and "Copied"', async () => {
    const DS = require('../src/services/DeviceSecurity');
    const copy = jest.spyOn(DS, 'copySecret');
    const tree = await mount();
    await press(tree, 'create_new_wallet');
    await type(tree, 'enter_password', '12345678');
    await type(tree, 'confirm_password', '12345678');
    await press(tree, 'terms_of_service');
    await press(tree, 'accept');
    await press(tree, 'create_wallet');
    expect(texts(tree)).toContain(t('seed_save_title'));
    expect(texts(tree)).toContain(t('seed_copy_warning', { seconds: 60 }));
    expect(copy).not.toHaveBeenCalled();
    await pressExact(tree, t('seed_copy'));
    expect(copy).toHaveBeenCalledWith(PHRASE);
    expect(lines(tree)).toContain(t('common_copied'));
  });

  it('on the phrase shown again from Settings: shown at once with the same button, no clipboard text (owner, 06.10)', async () => {
    const DS = require('../src/services/DeviceSecurity');
    const copy = jest.spyOn(DS, 'copySecret');
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    for (const wm of mockState.instances) wm.revealMnemonic = async () => ({ ok: true, mnemonic: PHRASE });
    await act(async () => { tree.root.find((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush();
    await press(tree, 'export_recovery_phrase');
    // The one warning, before the password (owner, 07.10).
    expect(texts(tree)).toContain(t('recovery_phrase_warning'));
    await type(tree, 'password', 'Otter-Canyon-58');
    await pressExact(tree, t('show'));
    // After it: only the words, Copy and Done.
    expect(texts(tree)).not.toContain(t('recovery_phrase_warning'));
    for (const word of PHRASE.split(' ')) expect(lines(tree)).toContain(word);
    expect(texts(tree)).not.toContain(t('seed_copy_warning', { seconds: 60 }));
    expect(copy).not.toHaveBeenCalled();
    await pressExact(tree, t('seed_copy'));
    expect(copy).toHaveBeenCalledWith(PHRASE);
    expect(lines(tree)).toContain(t('common_copied'));
    await pressExact(tree, t('common_done'));
    for (const word of PHRASE.split(' ')) expect(lines(tree)).not.toContain(word);
  });
});

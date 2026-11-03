// The wallet screen's locks, rendered: a recovery phrase typed for import never outlives leaving the app (MS1-02),
// the time away is measured on the boot clock as well as the wall clock, which the holder of the phone can set back
// (MS1-04), and the phrase is not shown or typed before the apps that can read the screen are named (MS1-06).
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Linking, Text, TextInput } from 'react-native';

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
  const { WORDS, fakeWalletManager, walletManagerModule, recipientAddress } = require('../test-support/walletMocks');
  class FakeWalletManager extends fakeWalletManager({ qnet: mockQNET, sol: mockSOL, light: 'light_x', superNode: 'super_x' }) {
    constructor() {
      super();
      mockState.instances.push(this);
    }
    async purgeLegacyBiometric() { return false; }
    async legacyBiometricNotice() { return false; }
    async vaultState() { return mockState.vault; }
    // A wallet under the screen lock (mockState.lock): its prompt opens it at once.
    async deviceAuthState() { return mockState.lock ? 'yes' : 'no'; }
    async unlockWithBiometrics() { return mockState.lock ? { ok: true, token: 'session-token' } : null; }
    async isBiometricEnabled() { return !!mockState.bio; }
    async confirmWithBiometrics(reason, note) { mockState.bioCalls.push([reason, note]); return mockState.bioAnswer; }
    async canStoreNewWallet() { return true; }
    async generateWallet() { mockState.generated += 1; return { mnemonic: WORDS.join(' '), address: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    async revealMnemonic() { return { ok: true, mnemonic: WORDS.join(' ') }; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (the live figure less this wallet's own unsettled spends): the same figure.
    // A test that holds the check (mockState.checkGate) finds it still running until it lets it go.
    async qncForSend() {
      if (mockState.checkGate) await mockState.checkGate;
      return { ok: true, balanceNano: '1000000000', nonce: '4', pending: [] };
    }
    async getTokenHoldings() { return []; }
    // An added token's balance (mockState.token: its read, as the token list and a send's check take it), its units,
    // its transfer's QNC, and the transfer itself, each sent counted.
    async getTokenBalanceOf() { return mockState.token ? { ok: true, balanceBaseUnits: mockState.token.base, balance: mockState.token.balance } : null; }
    async checkedTokenBalance() { return mockState.token ? { ok: true, balanceBase: mockState.token.base, pending: [], balance: mockState.token.balance } : null; }
    toBaseUnits(v, d) { const [whole, frac = ''] = String(v).split('.'); return BigInt(whole + frac.padEnd(d, '0')).toString(); }
    _formatBaseUnits(base, decimals) { return require('../src/browser/dappRequests').formatUnits(base, decimals); }
    qrc20TransferFeeNano() { return 150000; }
    async qrc20TransferQncNeedNano() { return { feeNano: 150000, depositNano: 0, needNano: 150000 }; }
    async qrc20Transfer(...args) { mockState.tokenSends.push(args); return { tx_hash: 'f'.repeat(64), submitNonce: 5 }; }
    async pendingTransactions() { return mockState.pending; }
    // This wallet's kept transactions as Assets lists them (WalletManager.keptTransactions).
    async keptTransactions() { return mockState.kept; }
    // The wallet's figure at a genesis node's live tip: what the test says (none by default).
    async liveQncFigure() { return mockState.live; }
    // A test that holds the read of the unconfirmed transactions (previewGate) or the submit (sendGate) lets it go itself.
    async previewSend() {
      if (mockState.previewGate) await mockState.previewGate;
      return mockState.preview;
    }
    async sendTransaction(...args) {
      mockState.sends.push(args);
      if (mockState.sendGate) await mockState.sendGate;
      return { success: true, txHash: 'f'.repeat(64), ...mockState.sent };
    }
    // The chain's answer at a send's nonce: the test's, else nothing decided.
    async resolveSubmitByNonce() { return mockState.nonceAnswer; }
    closeSession() { mockState.closed += 1; }
  }
  FakeWalletManager.deviceAuthCredential = (reason) => Object.freeze({ reason });
  FakeWalletManager.isSessionToken = (x) => x === 'session-token';
  FakeWalletManager.recipientAddress = recipientAddress;
  return walletManagerModule(FakeWalletManager);
});

jest.mock('../src/services/PushService', () => require('../test-support/walletMocks').pushServiceModule({
  selfAttestIfNeeded: jest.fn(async () => true),
  checkServerNodeStatus: jest.fn(async () => ({ success: false })),
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
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  readOffer: jest.requireActual('../src/services/QNetLink').readOffer,
  otherNodeHint: jest.fn(async () => null),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;
const { flush, pressId, openQncSend, explorerAction, networkFree } = require('../test-support/screen');

// What the screen shows: an action's other label, held at no height to keep its width (components/ui/Action), is not.
const texts = (tree) => tree.root.findAllByType(Text).filter((n) => !n.props.accessibilityElementsHidden)
  .map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');
function pressable(tree, text) {
  const all = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('').includes(text)));
  if (!all.length) throw new Error(`nothing to press labelled "${text}"`);
  return all[all.length - 1];
}
const press = async (tree, key) => { await act(async () => { await pressable(tree, t(key)).props.onPress(); }); await flush(); };
// For a press whose handler waits on a dialog the test answers next.
const tap = async (tree, key) => { await act(async () => { pressable(tree, t(key)).props.onPress(); }); await flush(); };
const pressTab = async (tree, tab) => {
  await act(async () => { tree.root.find((n) => n.props.testID === `tab-${tab}` && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(2);
};
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
    vault: 'none', instances: [], closed: 0, generated: 0, pending: [], preview: null, sends: [],
    bio: false, bioCalls: [], bioAnswer: { ok: false, fallback: true }, lock: false, kept: [], live: null, sent: null,
    checkGate: null, previewGate: null, sendGate: null, nonceAnswer: null, token: null, tokenSends: [],
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

  // `open` opens the QNC Send form: Send's token picker on Assets, or the QNC token's own screen and its Send.
  async function sendForm(to = TO, open = openQncSend, amount = '0.5') {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    await open(tree);
    await type(tree, 'send_placeholder_eon', to);
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText(amount); });
    await flush(1);
    return tree;
  }
  // A send the user confirmed, its submit held until the test lets it go (the returned function).
  async function confirmedSend(tree) {
    let release;
    mockState.sendGate = new Promise((r) => { release = r; });
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    return async () => { await act(async () => { release(); }); await flush(6); };
  }
  const resultUp = (tree) => tree.root.findAll((n) => n.props.testID === 'tx-result-done').length > 0;
  const sendBusy = (tree) => tree.root.findAll((n) => n.props.testID === 'send-busy').length > 0;

  it('names it, and signs nothing until the user chooses; Replace signs at its nonce', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    const shown = texts(tree);
    expect(shown).toContain(t('pending_dialog_title'));
    expect(shown).toContain(`0.5 QNC to ${TO}`);
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

  it('a recipient pasted with spaces or a line break around it is the bare address in every check', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false };
    const tree = await sendForm(`  ${TO}\n`);
    expect(input(tree, 'send_placeholder_eon').props.value).toBe(TO);
    await tap(tree, 'send_button');
    await tap(tree, 'pending_replace');
    await flush(4);
    await review(tree);
    expect(texts(tree)).toContain(require('../src/utils/addressDisplay').groupAddress(TO));
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    expect(mockState.sends[0][1]).toBe(TO);
  });

  it('a figure pasted as the app writes it is the figure it says; a comma typed alone is the decimal point', async () => {
    const tree = await sendForm();
    const field = () => tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0];
    await act(async () => { field().props.onChangeText('1,234'); });
    expect(field().props.value).toBe('1234');
    await act(async () => { field().props.onChangeText('1234,'); });
    expect(field().props.value).toBe('1234.');
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

  // The result card says the state at the top, keeps the details on one card and Done at its foot.
  it('the result of a send: Pending at the top, the recipient, the fee reviewed and the hash on its card, Done at the foot', async () => {
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    const status = tree.root.findAll((n) => n.type === Text && n.props.testID === 'tx-result-status-pending');
    expect(status.map((n) => n.props.children)).toEqual([t('hist_status_pending')]);
    const card = tree.root.find((n) => n.props.testID === 'tx-result-details' && typeof n.type === 'string');
    const onCard = card.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
    expect(onCard).toEqual(expect.arrayContaining([t('tx_to'), TO, t('tx_detail_fee'), '0.00015 QNC', t('tx_label'), 'f'.repeat(64)]));
    const foot = tree.root.find((n) => n.props.testID === 'tx-result-actions' && typeof n.type === 'string');
    expect(foot.findAll((n) => n.props.testID === 'tx-result-done' && typeof n.props.onPress === 'function').length).toBeGreaterThan(0);
    expect(texts(tree)).not.toContain('Waiting for confirmation.');
    await press(tree, 'common_done');
    expect(tree.root.findAll((n) => n.props.testID === 'tx-result-actions')).toHaveLength(0);
  });

  // Done leads to the same place wherever the send began: Assets' token list, never back to a token's own screen.
  it('Done on a send the network took opens Assets\' token list, for a send begun on a token\'s own screen too', async () => {
    const fromToken = async (tree) => {
      await pressId(tree, 'qnet-row-QNC');
      expect(texts(tree)).toContain(t('tok_information'));
      await pressId(tree, 'token-send');
    };
    for (const open of [fromToken, openQncSend]) {
      const tree = await sendForm(TO, open);
      await tap(tree, 'send_button');
      await flush(4);
      await review(tree);
      await confirmPassword(tree);
      expect(tree.root.findAll((n) => n.props.testID === 'tx-result-done').length).toBeGreaterThan(0);
      await press(tree, 'common_done');
      expect(texts(tree)).not.toContain(t('tok_information'));
      expect(texts(tree)).not.toContain(t('send_title', { symbol: 'QNC' }));
      expect(texts(tree)).toContain(t('assets_send'));
      await act(async () => { mounted.pop().unmount(); });
      mockState.sends = [];
    }
  });

  // Send's picker on Assets offers QNC and every QNet token Assets shows; the form sends the one chosen there, a token
  // through its own transfer in its own units, its fee in QNC.
  it('a QNet token chosen in Send\'s picker is sent as that token: its contract, the recipient and the amount in its units', async () => {
    const C = 'c'.repeat(64);
    await AsyncStorage.setItem('qnet_custom_tokens', JSON.stringify([{ contract_address: C, symbol: 'TKN', name: 'Token', decimals: 2 }]));
    mockState.token = { base: '1000', balance: '10' };
    const pick = async (tree) => {
      await pressId(tree, 'assets-send');
      expect(['pick-QNC', `pick-${C.slice(0, 12)}`].map((id) => tree.root.findAll((n) => n.props.testID === id).length > 0)).toEqual([true, true]);
      await pressId(tree, `pick-${C.slice(0, 12)}`);
    };
    const tree = await sendForm(TO, pick, '2.5');
    expect(texts(tree)).toContain(t('send_title', { symbol: 'TKN' }));
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.tokenSends).toEqual([[C, TO, '250', expect.anything(), { choice: null }]]);
    expect(mockState.sends).toEqual([]);
  });

  // The review waits for the user, so it holds nothing (utils/userAction).
  it('a send holds the background verification while it is checked and while it is sent, not while it is reviewed', async () => {
    let checked;
    let sent;
    mockState.checkGate = new Promise((r) => { checked = r; });
    mockState.sendGate = new Promise((r) => { sent = r; });
    const tree = await sendForm();
    expect(await networkFree()).toBe(true);
    await tap(tree, 'send_button');
    expect(await networkFree()).toBe(false);
    await act(async () => { checked(); });
    await flush(4);
    expect([texts(tree).includes(t('send_review_title')), await networkFree()]).toEqual([true, true]);
    await review(tree);
    await confirmPassword(tree);
    expect([mockState.sends.length, await networkFree()]).toEqual([1, false]);
    await act(async () => { sent(); });
    await flush(6);
    expect([resultUp(tree), await networkFree()]).toEqual([true, true]);
  });

  it('the Assets tab leaves a Send form whose send is still being checked: no review comes up and nothing is signed', async () => {
    let release;
    mockState.checkGate = new Promise((r) => { release = r; });
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await pressTab(tree, 'assets');
    expect(texts(tree)).not.toContain(t('send_title', { symbol: 'QNC' }));
    await act(async () => { release(); });
    await flush(6);
    expect(texts(tree)).not.toContain(t('send_review_title'));
    expect(mockState.sends).toEqual([]);
    expect(texts(tree)).toContain(t('assets_send'));
  });

  it('a send whose form closed while it was checked asks nothing: no Unconfirmed transactions dialog over the token list', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false };
    // Closed while the balance was read, and while the unconfirmed transactions were read for the dialog.
    for (const gate of ['checkGate', 'previewGate']) {
      let release;
      mockState[gate] = new Promise((r) => { release = r; });
      const tree = await sendForm();
      await tap(tree, 'send_button');
      await pressTab(tree, 'assets');
      await act(async () => { release(); });
      await flush(6);
      expect([gate, texts(tree).includes(t('pending_dialog_title'))]).toEqual([gate, false]);
      expect(texts(tree)).toContain(t('assets_send'));
      await act(async () => { mounted.pop().unmount(); });
      mockState[gate] = null;
    }
  });

  it('Back while a short send is checked, then another form: no refusal of the old send, and the new form is not busy', async () => {
    let release;
    mockState.checkGate = new Promise((r) => { release = r; });
    const tree = await sendForm(TO, openQncSend, '5');
    await tap(tree, 'send_button');
    expect(sendBusy(tree)).toBe(true);
    await press(tree, 'common_back');
    await openQncSend(tree);
    expect(texts(tree)).toContain(t('send_title', { symbol: 'QNC' }));
    expect(sendBusy(tree)).toBe(false);
    await act(async () => { release(); });
    await flush(6);
    expect(texts(tree)).not.toContain(t('send_cannot_title'));
    expect(resultUp(tree)).toBe(false);
    // The same short send on a form that stays open is refused, saying why.
    await type(tree, 'send_placeholder_eon', TO);
    await act(async () => { tree.root.findAll((n) => n.type === TextInput && n.props.keyboardType === 'decimal-pad')[0].props.onChangeText('5'); });
    await tap(tree, 'send_button');
    await flush(4);
    expect(texts(tree)).toContain(t('send_cannot_title'));
  });

  it('a send the network refused after the user confirmed it is said, though its form closed meanwhile', async () => {
    mockState.sent = { success: false, error: 'refused', code: 'NONCE_TAKEN' };
    const tree = await sendForm();
    const submit = await confirmedSend(tree);
    await pressTab(tree, 'assets');
    await submit();
    expect(texts(tree)).toContain(t('tx_failed_title'));
    expect(resultUp(tree)).toBe(true);
  });

  it('the Assets tab with a send\'s result up removes the card and opens the token list', async () => {
    const tree = await sendForm();
    const submit = await confirmedSend(tree);
    await submit();
    expect(resultUp(tree)).toBe(true);
    await pressTab(tree, 'assets');
    expect(resultUp(tree)).toBe(false);
    expect(texts(tree)).not.toContain(t('send_title', { symbol: 'QNC' }));
    expect(texts(tree)).toContain(t('assets_send'));
  });

  it('a result that arrived while the Browser tab was open: the Assets tab shows it first, a second press opens the token list', async () => {
    const tree = await sendForm();
    const submit = await confirmedSend(tree);
    await pressTab(tree, 'browser');
    await submit();
    expect(resultUp(tree)).toBe(false);
    await pressTab(tree, 'assets');
    expect(resultUp(tree)).toBe(true);
    await pressTab(tree, 'assets');
    expect(resultUp(tree)).toBe(false);
    expect(texts(tree)).toContain(t('assets_send'));
  });

  // Every tab, tapped, opens its first page: History, Node, Settings and Browser leave no result card up over it, and
  // Browser does not hide one until the next tab.
  it('every other tab tapped over a send\'s result opens its own first page; the card goes as its Done makes it go', async () => {
    const lit = (tree) => tree.root.findAll((n) => /^tab-[a-z]+$/.test(n.props.testID || '') && typeof n.props.onPress === 'function'
      && n.props.accessibilityState.selected).map((n) => n.props.testID);
    for (const tab of ['history', 'node', 'settings', 'browser']) {
      const tree = await sendForm();
      const submit = await confirmedSend(tree);
      await submit();
      expect(resultUp(tree)).toBe(true);
      await pressTab(tree, tab);
      expect([tab, resultUp(tree), lit(tree)]).toEqual([tab, false, [`tab-${tab}`]]);
      // Done's rule ran (a send the network took leaves Assets on its token list), and nothing comes back over Assets.
      await pressTab(tree, 'assets');
      expect([tab, resultUp(tree), texts(tree).includes(t('send_title', { symbol: 'QNC' })), texts(tree).includes(t('assets_send'))])
        .toEqual([tab, false, false, true]);
      await act(async () => { mounted.pop().unmount(); });
      mockState.sends = [];
    }
  });

  // The timers the screen starts from now on: the newest one of `ms` (its handle), and whether a handle was cleared.
  const watchTimers = () => {
    const set = jest.spyOn(global, 'setTimeout');
    const clear = jest.spyOn(global, 'clearTimeout');
    const newestAt = (ms) => set.mock.calls.map((c) => c[1]).lastIndexOf(ms);
    return {
      newest: (ms) => set.mock.results[newestAt(ms)].value,
      cleared: (handle) => clear.mock.calls.some((c) => c[0] === handle),
      // The newest of them run now, cleared first so it does not run again later.
      fire: async (ms) => {
        const at = newestAt(ms);
        clearTimeout(set.mock.results[at].value);
        await act(async () => { await set.mock.calls[at][0](); });
        await flush(6);
      },
    };
  };

  // A send's settle by nonce (180 s, then every 30 s for half an hour) and its 2 s hash poll end with the screen, never
  // with a change of tab: leaving Assets does not end the poll of a send still on its way.
  it('a send\'s follow-up goes on whichever tab is open, and ends with the screen: its poll and its settle by nonce', async () => {
    const timers = watchTimers();
    const tree = await sendForm();
    const submit = await confirmedSend(tree);
    await submit();
    const poll = timers.newest(2000);
    const settle = timers.newest(180000);
    await pressTab(tree, 'history');
    expect([timers.cleared(poll), timers.cleared(settle)]).toEqual([false, false]);
    await act(async () => { mounted.pop().unmount(); });
    expect([timers.cleared(poll), timers.cleared(settle)]).toEqual([true, true]);
  });

  // The chain's answer at the send's nonce settles its card (its settle by nonce, due 3 minutes on, run now): a send no
  // block took keeps its hash with no explorer page; one bound to nothing names the transaction that applied there.
  async function settledBy(answer) {
    const timers = watchTimers();
    mockState.sent = { from: mockQNET, to: TO, nonce: 5, amountNano: 500_000_000 };
    const tree = await sendForm();
    const submit = await confirmedSend(tree);
    await submit();
    mockState.nonceAnswer = answer;
    await timers.fire(180000);
    return tree;
  }

  it('a send the chain says expired keeps its hash and offers no explorer', async () => {
    const tree = await settledBy({ known: true, landed: false, expired: true });
    expect(texts(tree)).toContain(t('tx_expired_title'));
    expect([texts(tree).includes('f'.repeat(64)), !!explorerAction(tree)]).toEqual([true, false]);
  });

  it('a send another transaction of the wallet replaced keeps its hash and offers no explorer', async () => {
    const tree = await settledBy({ known: true, landed: false, replaced: true });
    expect(texts(tree)).toContain(t('tx_not_applied_title'));
    expect([texts(tree).includes('f'.repeat(64)), !!explorerAction(tree)]).toEqual([true, false]);
  });

  it('a send bound to nothing at its nonce opens the transaction that applied there in the explorer', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const applied = 'e'.repeat(64);
    const tree = await settledBy({ known: true, landed: false, unbound: true, txHash: applied });
    expect(texts(tree)).toContain(t('tx_unbound_title'));
    expect(texts(tree).includes(applied)).toBe(true);
    await act(async () => { explorerAction(tree).props.onPress(); });
    expect(open).toHaveBeenCalledWith(require('../src/config/nodes').explorerTxUrl(applied));
  });

  it('a pull whose read ends first leaves no spinner timer behind, and a one-shot timer of the screen ends with it', async () => {
    const timers = watchTimers();
    const tree = await sendForm();
    await press(tree, 'common_back');
    const onRefresh = tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
      && typeof n.props.refreshControl.props.onRefresh === 'function')[0].props.refreshControl.props.onRefresh;
    await act(async () => { await onRefresh(); });
    expect(timers.cleared(timers.newest(3000))).toBe(true);
    // The lock screen's "Incorrect password" goes after 3 s: a screen that went before then clears that timer too.
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    await flush(2);
    await press(tree, 'lock_wallet');
    await press(tree, 'unlock_wallet');
    expect(texts(tree)).toContain(t('incorrect_password'));
    const message = timers.newest(3000);
    expect(timers.cleared(message)).toBe(false);
    await act(async () => { mounted.pop().unmount(); });
    expect(timers.cleared(message)).toBe(true);
  });

  it('the Browser tab keeps the page it shows when switched to, and goes to its start page when tapped while open', async () => {
    const tree = await sendForm();
    await pressTab(tree, 'browser');
    const field = tree.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === t('browser_address_label'))[0];
    await act(async () => { field.props.onChangeText('dapp.example'); });
    await act(async () => { field.props.onSubmitEditing(); });
    const web = () => tree.root.findAll((n) => n.props.testID === 'webview' && typeof n.type === 'string');
    await act(async () => { web()[0].props.onNavigationStateChange({ url: 'https://dapp.example/', title: 'Page', loading: false }); });
    const onStart = () => tree.root.findAll((n) => n.props.testID === 'bookmark-aiqnet').length > 0;
    expect(onStart()).toBe(false);
    await pressTab(tree, 'history');
    await pressTab(tree, 'browser');
    expect(onStart()).toBe(false);
    await pressTab(tree, 'browser');
    // The start page, the page still loaded under it.
    expect([onStart(), web().length]).toEqual([true, 1]);
  });

  it('a lock over the Unconfirmed transactions dialog ends that check: after the unlock the form\'s Send is free again', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    expect(texts(tree)).toContain(t('pending_dialog_title'));
    await emit('background');
    mockClock.mono += 4 * 3600_000;
    now += 4 * 3600_000;
    await emit('active');
    await flush(6);
    expect(texts(tree)).toContain(t('unlock_wallet'));
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    expect(texts(tree)).toContain(t('send_title', { symbol: 'QNC' }));
    expect(texts(tree)).not.toContain(t('pending_dialog_title'));
    expect(sendBusy(tree)).toBe(false);
    await tap(tree, 'send_button');
    expect(texts(tree)).toContain(t('pending_dialog_title'));
    expect(mockState.sends).toEqual([]);
  });

  // A transfer link waits for a send under way, whether or not its form is still open, and for its result on screen.
  describe('a transfer link meanwhile', () => {
    const SOL_LINK = 'https://link.aiqnet.io/send#to=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&amount=0.001';
    const { fakeLinkInbox } = require('../test-support/linkInbox');
    const solanaForm = (tree) => tree.root.findAll((n) => n.props.testID === 'solana-send').length > 0;
    let inbox;
    beforeEach(() => { inbox = fakeLinkInbox(); });
    afterEach(() => { inbox.remove(); });

    it('the Assets tab during the submit: the link waits for the result and its Done, then its form opens and stays', async () => {
      const tree = await sendForm();
      const submit = await confirmedSend(tree);
      await pressTab(tree, 'assets');
      await inbox.deliver(SOL_LINK);
      expect(solanaForm(tree)).toBe(false);
      expect(inbox.waiting()).toEqual([SOL_LINK]);
      await submit();
      expect(resultUp(tree)).toBe(true);
      expect(inbox.waiting()).toEqual([SOL_LINK]);
      await press(tree, 'common_done');
      await flush(6);
      expect(solanaForm(tree)).toBe(true);
      expect(inbox.waiting()).toEqual([]);
    });

    it('Back during the submit, the link arriving once the result is up: the result stays until Done', async () => {
      const tree = await sendForm();
      const submit = await confirmedSend(tree);
      await press(tree, 'common_back');
      await submit();
      expect(resultUp(tree)).toBe(true);
      await inbox.deliver(SOL_LINK);
      expect(resultUp(tree)).toBe(true);
      expect(solanaForm(tree)).toBe(false);
      expect(inbox.waiting()).toEqual([SOL_LINK]);
      await press(tree, 'common_done');
      await flush(6);
      expect(solanaForm(tree)).toBe(true);
      expect(inbox.waiting()).toEqual([]);
    });
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

  // Before, the expected balance stood for up to two minutes whenever money came in with the send: a figure above it was
  // taken for one of before the send, though its nonce showed the send applied.
  it('after a send, a figure whose nonce shows the send applied is shown at once, money received with it too', async () => {
    mockState.sent = { nonce: 5 };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await flush(4);
    await review(tree);
    await confirmPassword(tree);
    expect(mockState.sends).toHaveLength(1);
    await press(tree, 'common_done');
    const refresh = async () => { await emit('background'); await emit('active'); await flush(8); };
    const lines = () => texts(tree).split('\n');
    // A node that has not applied the send (nonce 4) with 0.7 QNC received: the expected balance stands.
    mockState.live = { balance: 1.2, balanceNano: '1200000000', nonce: '4', blockHeight: 100, figureClaimedEpoch: 0 };
    await refresh();
    expect(lines()).not.toContain('1.2');
    // The send applied (nonce 5) in a state that holds the 0.7 QNC too: that figure, at once.
    mockState.live = { balance: 1.2, balanceNano: '1200000000', nonce: '5', blockHeight: 101, figureClaimedEpoch: 0 };
    await refresh();
    expect(lines()).toContain('1.2');
  });

  // Before, Assets called the two-argument line of the browser's sheet with the entry alone, and the tab fell into the
  // error screen whenever a kept transaction was listed (right after any send, until it settled).
  it('Assets lists a kept transaction with its line, its status and Stop sending', async () => {
    mockState.vault = 'ok';
    mockState.kept = [{
      ...pendingView, held: false, sending: true, sendsUntil: now + 25 * 60_000, canStop: true, mayLandUntil: null, stopLandsUntil: null,
    }];
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    const shown = texts(tree);
    expect(shown).toContain(t('kept_title', { count: 1 }));
    expect(shown).toContain(`${t('pending_line_transfer', { amount: '0.5 QNC', to: TO })} · ${t('time_min', { n: 2 })}`);
    expect(shown).toContain(t('kept_sending', { minutes: 25 }));
    expect(shown).toContain(t('kept_stop'));
  });

  it('Cancel sends nothing', async () => {
    mockState.pending = [{ nonce: 5 }];
    mockState.preview = { confirmed: 4, nonce: null, live: [pendingView], replace: pendingView, canAppend: false };
    const tree = await sendForm();
    await tap(tree, 'send_button');
    await press(tree, 'cancel');
    await flush(4);
    expect(mockState.sends).toEqual([]);
  });

  it('with nothing unconfirmed, a send goes straight to its review: no question about an earlier payment', async () => {
    const tree = await sendForm();
    await tap(tree, 'send_button');
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

// R4-MOBLINK-01: another app can start the wallet with a link of its own at any moment. While the user has a request to
// decide in front of them, a different link never takes its place: it waits until that one is decided or closed, and
// then says it is another request. A decided request gives way to it at once, its answer still on its way.
describe('a QNet Link request on screen is never swapped for another one', () => {
  const { fakeLinkInbox } = require('../test-support/linkInbox');
  const QNetLink = require('../src/services/QNetLink');
  const A = { id: 'a'.repeat(32), sitePub: 'b'.repeat(43), intent: 'connect' };
  const B = { id: 'c'.repeat(32), sitePub: 'd'.repeat(43), intent: 'connect' };
  const URL_A = 'https://link.aiqnet.io/l#a';
  const URL_B = 'https://link.aiqnet.io/l#b';
  let inbox;
  const opened = () => QNetLink.openSession.mock.calls.map((c) => c[0].id);
  // The link screen's Confirm: the button with a press-in handler (utils/useArmedConfirm), pressed as a finger does.
  const pressConfirm = async (tree) => {
    const b = tree.root.findAll((n) => typeof n.props.onPress === 'function' && typeof n.props.onPressIn === 'function'
      && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('link_confirm')));
    await act(async () => { b[b.length - 1].props.onPressIn(); b[b.length - 1].props.onPress(); });
    await flush(4);
  };

  afterEach(() => { inbox.remove(); });
  beforeEach(() => {
    inbox = fakeLinkInbox();
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

  it('a link that arrives while one waits for the user waits; once that one is decided it takes its place at once', async () => {
    const tree = await unlockedWallet();
    let deliveredA;
    QNetLink.deliverAnswer.mockImplementationOnce(() => new Promise((resolve) => { deliveredA = resolve; }));
    await inbox.deliver(URL_A);
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).toContain(t('link_title_connect'));
    await inbox.deliver(URL_B);
    expect(opened()).toEqual([A.id]);
    expect(texts(tree)).not.toContain(t('link_after_other'));
    await press(tree, 'link_reject');
    await flush(6);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(A, expect.anything(), { status: 'rejected' }, expect.anything());
    // No Close: B is on screen at once, saying another request arrived and that A's answer is still on its way.
    expect(opened()).toEqual([A.id, B.id]);
    expect(texts(tree)).not.toContain(t('link_result_rejected'));
    expect(texts(tree)).toContain(t('link_after_other'));
    expect(texts(tree)).toContain(t('link_previous_sending'));
    await act(async () => { deliveredA('delivered'); });
    await flush(2);
    expect(texts(tree)).not.toContain(t('link_previous_sending'));
    expect(texts(tree)).toContain(t('link_after_other'));
  });

  it('a decided request behind the lock screen gives way to a link that came meanwhile: the new one shows after the unlock', async () => {
    const tree = await unlockedWallet();
    await inbox.deliver(URL_A);
    await press(tree, 'link_reject');
    await flush(4);
    expect(texts(tree)).toContain(t('link_result_rejected'));
    await emit('background');
    mockClock.mono += 12 * 3600_000;
    now += 12 * 3600_000;
    await emit('active');
    await flush(6);
    expect(texts(tree)).toContain(t('unlock_wallet'));
    await inbox.deliver(URL_B);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    expect(opened()).toEqual([A.id, B.id]);
    expect(texts(tree)).toContain(t('link_title_connect'));
    expect(texts(tree)).toContain(t('link_after_other'));
    expect(texts(tree)).not.toContain(t('link_result_rejected'));
    expect(inbox.waiting()).toEqual([URL_B]);
  });

  it('a link that arrives while the user authenticates the request on screen does not take its place', async () => {
    const tree = await unlockedWallet();
    await inbox.deliver(URL_A);
    await act(() => new Promise((r) => { setTimeout(r, 1100); })); // Confirm arms
    await pressConfirm(tree);
    expect(texts(tree)).toContain(t('fresh_title'));
    expect(texts(tree)).toContain(t('link_auth_connect'));
    await inbox.deliver(URL_B);
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
    await openQncSend(tree);
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
    await inbox.deliver(URL_A);
    expect(texts(tree)).not.toContain(t('send_confirm_reason', { amount: '0.5 QNC' }));
    expect(texts(tree)).toContain(t('link_title_connect'));
    expect(input(tree, 'password')).toBeUndefined();
    expect(mockState.sends).toEqual([]);
  });

  it('requests behind the lock screen come in their order, the next saying another arrived; the same link twice is one', async () => {
    mockState.vault = 'ok';
    const tree = await mount();
    // A's session cannot be read: its request is closed with no decision.
    QNetLink.openSession.mockImplementationOnce(async () => { throw new Error('offline'); });
    await inbox.deliver(URL_A);
    await inbox.deliver(URL_B);
    await inbox.deliver(URL_A);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    expect(opened()).toEqual([A.id]);
    expect(inbox.waiting()).toEqual([URL_A, URL_B]);
    await press(tree, 'link_close');
    await flush(6);
    expect(opened()).toEqual([A.id, B.id]);
    expect(texts(tree)).toContain(t('link_after_other'));
    // The link of the request on screen again is that request.
    await inbox.deliver(URL_B);
    expect(opened()).toEqual([A.id, B.id]);
    expect(inbox.waiting()).toEqual([URL_B]);
  });
});

// A secret is copied by its own Copy button under it (its label alone, Copied while the copy may be on the clipboard),
// at creation and at export alike; a tap on the words or the key copies nothing.
describe('a secret\'s copy (its Copy button only)', () => {
  const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const lines = (tree) => texts(tree).split('\n');
  const button = (tree, id) => tree.root.find((n) => n.props.testID === id && n.props.accessibilityRole === 'button'
    && typeof n.props.onPress === 'function');
  const tapPhrase = async (tree) => {
    await act(async () => { await button(tree, 'seed-copy').props.onPress(); });
    await flush();
  };
  // Nothing that can be pressed holds a word of the phrase (or the key): the secret is drawn apart from its button.
  const pressableHolding = (tree, text) => tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).flat(Infinity).join('') === text));
  // The button says what it does in its label alone: no copy mark repeats it.
  const expectCopyButton = (tree, id, labelKey) => {
    expect(button(tree, id).findAllByType(Text).map((x) => [].concat(x.props.children).join(''))).toEqual([t(labelKey)]);
    expect(button(tree, id).findAll((n) => typeof n.type === 'string' && /^copy-glyph/.test(n.props.testID || ''))).toHaveLength(0);
  };
  // No native module here: the copy's JS timer is stopped, as Delete wallet would.
  afterEach(async () => { await require('../src/services/DeviceSecurity').clearSecretCopy(); });
  const pressExact = async (tree, text) => {
    const all = tree.root.findAll((n) => typeof n.props.onPress === 'function'
      && n.findAllByType(Text).some((x) => [].concat(x.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('') === text));
    if (!all.length) throw new Error(`nothing to press labelled exactly "${text}"`);
    await act(async () => { await all[all.length - 1].props.onPress(); });
    await flush();
  };

  it('on a new wallet\'s phrase: Copy phrase under the words, the warning next to it, nothing copied until its tap', async () => {
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
    expectCopyButton(tree, 'seed-copy', 'secret_copy_phrase');
    for (const word of PHRASE.split(' ')) expect([word, pressableHolding(tree, word).length]).toEqual([word, 0]);
    expect(copy).not.toHaveBeenCalled();
    await tapPhrase(tree);
    expect(copy).toHaveBeenCalledWith(PHRASE);
    expectCopyButton(tree, 'seed-copy', 'common_copied');
    expect(lines(tree)).toContain(t('common_copied'));
    expect(lines(tree)).not.toContain(t('secret_copy_phrase'));
  });

  it('on the phrase shown again from Settings: shown at once, copied the same way, no clipboard text', async () => {
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
    // After it: only the words, their Copy button and Done.
    expect(texts(tree)).not.toContain(t('recovery_phrase_warning'));
    for (const word of PHRASE.split(' ')) expect(lines(tree)).toContain(word);
    for (const word of PHRASE.split(' ')) expect([word, pressableHolding(tree, word).length]).toEqual([word, 0]);
    expectCopyButton(tree, 'seed-copy', 'secret_copy_phrase');
    expect(texts(tree)).not.toContain(t('seed_copy_warning', { seconds: 60 }));
    expect(copy).not.toHaveBeenCalled();
    await tapPhrase(tree);
    expect(copy).toHaveBeenCalledWith(PHRASE);
    expectCopyButton(tree, 'seed-copy', 'common_copied');
    await pressExact(tree, t('common_done'));
    for (const word of PHRASE.split(' ')) expect(lines(tree)).not.toContain(word);
  });

  it('on a private key shown from Settings: Copy key under its box, the box copying nothing', async () => {
    const KEY = '5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6';
    const DS = require('../src/services/DeviceSecurity');
    const copy = jest.spyOn(DS, 'copySecret');
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    for (const wm of mockState.instances) wm.revealPrivateKeys = async () => ({ ok: true, qnet: { address: mockQNET, key: KEY } });
    await act(async () => { tree.root.find((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush();
    await press(tree, 'export_private_key');
    await type(tree, 'password', 'Otter-Canyon-58');
    await pressExact(tree, t('show'));
    expect(lines(tree)).toContain(KEY);
    expect(pressableHolding(tree, KEY)).toHaveLength(0);
    expectCopyButton(tree, 'key-copy-qnet', 'secret_copy_key');
    expect(copy).not.toHaveBeenCalled();
    await act(async () => { await button(tree, 'key-copy-qnet').props.onPress(); });
    await flush();
    expect(copy).toHaveBeenCalledWith(KEY);
    expectCopyButton(tree, 'key-copy-qnet', 'common_copied');
    await pressExact(tree, t('common_done'));
    expect(lines(tree)).not.toContain(KEY);
  });

  // Copied lasts COPIED_MS, as every copy of the app; the clipboard is still cleared after the minute seed_copy_warning
  // names under the button.
  it('Copied turns back to the button\'s label after as long as any copy of the app says it', async () => {
    const { COPIED_MS } = require('../src/components/ui/Copyable');
    const tree = await mount();
    await press(tree, 'create_new_wallet');
    await type(tree, 'enter_password', '12345678');
    await type(tree, 'confirm_password', '12345678');
    await press(tree, 'terms_of_service');
    await press(tree, 'accept');
    await press(tree, 'create_wallet');
    const timers = jest.spyOn(global, 'setTimeout');
    await tapPhrase(tree);
    expectCopyButton(tree, 'seed-copy', 'common_copied');
    // The last timer of that length is the label's.
    const at = timers.mock.calls.map((c) => c[1]).lastIndexOf(COPIED_MS);
    expect(at).toBeGreaterThan(-1);
    clearTimeout(timers.mock.results[at].value);
    await act(async () => { timers.mock.calls[at][0](); });
    expectCopyButton(tree, 'seed-copy', 'secret_copy_phrase');
  });
});

describe('Export on Settings: one check at a time, and the screen lock\'s answers are its own', () => {
  const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const pressShow = async (tree) => {
    await act(async () => { pressable(tree, t('show')).props.onPress(); });
    await flush();
  };
  const toExport = async (tree) => {
    await act(async () => { tree.root.find((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush();
    await press(tree, 'export_recovery_phrase');
  };

  it('a second tap on Show while the check runs does nothing, and the button says it is verifying', async () => {
    mockState.vault = 'ok';
    const tree = await mount();
    await type(tree, 'enter_password', 'Otter-Canyon-58');
    await press(tree, 'unlock_wallet');
    await flush(6);
    let finish;
    let calls = 0;
    for (const wm of mockState.instances) {
      wm.revealMnemonic = () => { calls += 1; return new Promise((r) => { finish = r; }); };
    }
    await toExport(tree);
    await type(tree, 'password', 'Otter-Canyon-58');
    await pressShow(tree);
    expect(calls).toBe(1);
    expect(texts(tree)).toContain(t('verifying'));
    await act(async () => { pressable(tree, t('verifying')).props.onPress(); });
    await flush();
    expect(calls).toBe(1);
    await act(async () => { finish({ ok: true, mnemonic: PHRASE }); });
    await flush();
    expect(texts(tree)).not.toContain(t('verifying'));
    expect(texts(tree).split('\n')).toContain('abandon');
  });

  it('under the screen lock a failed prompt is not a wrong password, iOS\'s "not now" is silent, and a gone secret offers the way back', async () => {
    mockState.vault = 'ok';
    mockState.lock = true;
    const tree = await mount();
    await flush(6);
    expect(input(tree, 'enter_password')).toBeUndefined(); // opened by the screen lock
    let answer = null;
    for (const wm of mockState.instances) wm.revealMnemonic = async () => answer;
    await toExport(tree);
    expect(input(tree, 'password')).toBeUndefined();
    answer = { ok: false, failed: true };
    await pressShow(tree);
    expect(texts(tree)).toContain(t('unlock_failed'));
    expect(texts(tree)).not.toContain(t('incorrect_password'));
    await press(tree, 'common_ok');
    answer = { ok: false, failed: true, notNow: true };
    await pressShow(tree);
    expect(texts(tree)).not.toContain(t('unlock_failed'));
    expect(texts(tree)).not.toContain(t('incorrect_password'));
    answer = { ok: false, gone: true };
    await pressShow(tree);
    expect(texts(tree)).toContain(t('auth_secret_gone_open_body'));
    expect(texts(tree)).not.toContain(t('incorrect_password'));
  });

  it('a fresh check under the screen lock whose prompt failed says so; a cancelled one is silent', async () => {
    const DS = require('../src/services/DeviceSecurity');
    const auth = jest.spyOn(DS, 'deviceAuthenticate');
    mockState.vault = 'ok';
    mockState.lock = true;
    const tree = await mount();
    await flush(6);
    await act(async () => { tree.root.find((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush(4);
    auth.mockResolvedValueOnce({ ok: false, code: 'cancelled' });
    await press(tree, 'autolock_1');
    await tap(tree, 'autolock_30');
    await flush(4);
    expect(texts(tree)).not.toContain(t('device_unlock_unavailable'));
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBeNull();
    auth.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await press(tree, 'autolock_1');
    await tap(tree, 'autolock_30');
    await flush(4);
    expect(texts(tree)).toContain(t('device_unlock_unavailable'));
    expect(await AsyncStorage.getItem('qnet_autolock_time')).toBeNull();
  });
});

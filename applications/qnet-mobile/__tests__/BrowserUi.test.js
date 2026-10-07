// The bottom bar (every tab on a 320 dp phone, the active one lit, Receive under Assets), the confirmation sheet
// (armed after a second, the password or device authentication before anything, Reject performs nothing, the
// origin and its warnings), Android back in the browser (its own history first), and the grants and recent
// pages the browser keeps.
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity, BackHandler } from 'react-native';

const BottomBar = require('../src/components/BottomBar').default;
const { BOTTOM_TABS } = require('../src/components/BottomBar');
const DappSheet = require('../src/browser/DappSheet').default;
const { formatNano, looksLikeKnownAddress, ARM_MS } = require('../src/browser/DappSheet');

const t = require('../src/i18n').makeT('en'); // the app's translator: English, placeholders filled
const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string' || typeof c === 'number').join('')).join('\n');
const buttons = (tree) => tree.root.findAllByType(TouchableOpacity)
  .map((b) => ({ label: b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(''), props: b.props }));
const button = (tree, label) => buttons(tree).find((b) => b.label === label);
// The sheet's arming is timed on the clock: the tests move a fake clock (timers and Date together) rather than wait on the
// real one, so a slow machine never decides whether a press came before or after arming (M16).
const wait = (ms) => act(async () => { jest.advanceTimersByTime(ms); });

describe('the bottom bar', () => {
  it('has Assets, History, Browser, Node and Settings, each labelled for screen readers', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<BottomBar active="assets" onSelect={() => {}} t={t} />); });
    const tabs = tree.root.findAllByType(TouchableOpacity);
    expect(tabs.map((n) => n.props.testID)).toEqual(BOTTOM_TABS.map((k) => `tab-${k}`));
    expect(tabs.map((n) => n.props.accessibilityLabel)).toEqual(['Assets', 'History', 'Browser', 'Node', 'Settings']);
    expect(tabs.map((n) => n.props.accessibilityState.selected)).toEqual([true, false, false, false, false]);
  });

  it('fits a 320 dp phone: five equal shares, one label line that may shrink, never wrap', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<BottomBar active="browser" onSelect={() => {}} t={t} />); });
    const share = 320 / BOTTOM_TABS.length; // the narrowest phone the app supports
    for (const label of tree.root.findAllByType(Text)) {
      const { numberOfLines, adjustsFontSizeToFit, minimumFontScale } = label.props;
      expect([numberOfLines, adjustsFontSizeToFit]).toEqual([1, true]);
      // Measured-width heuristic: an average glyph is ~0.6 em; the label must fit its share at the smallest scale.
      const text = [].concat(label.props.children).join('');
      expect(text.length * 11 * 0.6 * minimumFontScale).toBeLessThanOrEqual(share - 4);
    }
    const items = tree.root.findAllByType(TouchableOpacity);
    for (const item of items) {
      const style = [].concat(item.props.style).reduce((a, b) => ({ ...a, ...b }), {});
      expect(style).toMatchObject({ flex: 1, minWidth: 0 });
      expect(style.width).toBeUndefined();
    }
  });

  it('lights Assets for Receive, reports the tab pressed, and steps aside for the keyboard', async () => {
    const onSelect = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<BottomBar active="receive" onSelect={onSelect} t={t} />); });
    const tab = (k) => tree.root.findAllByType(TouchableOpacity).find((n) => n.props.testID === `tab-${k}`);
    expect(tab('assets').props.accessibilityState.selected).toBe(true);
    await act(async () => { tab('browser').props.onPress(); });
    expect(onSelect).toHaveBeenCalledWith('browser');
    await act(async () => { tree.update(<BottomBar active="assets" onSelect={onSelect} t={t} hidden />); });
    expect(tree.toJSON()).toBe(null);
  });
});

describe('the confirmation sheet', () => {
  const QNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const actions = () => ({
    approve: jest.fn(async () => ({ status: 'done' })), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn(),
  });

  const mounted = [];
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
  afterEach(async () => {
    await act(async () => { while (mounted.length) mounted.pop().unmount(); });
    jest.useRealTimers();
  });

  async function mount(view, extra = {}) {
    const props = { view, actions: actions(), t, authenticate: jest.fn(async () => true), accounts: { qnet: QNET, solana: SOL }, ...extra };
    let tree;
    await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
    mounted.push(tree);
    return { tree, props };
  }

  const connect = { id: 'a1', kind: 'connect', origin: 'https://app.dapp.example', busy: false, queued: 0, details: {}, preview: null, outcome: null };

  it('names the origin with its registrable domain and shows both addresses', async () => {
    const { tree } = await mount(connect);
    const shown = texts(tree);
    for (const s of ['Request from', 'app.', 'dapp.example', 'https://app.dapp.example', 'Connect this site', QNET, SOL]) {
      expect(shown).toContain(s);
    }
    expect(shown).not.toMatch(/activat|burn|1DEV/i);
  });

  it('warns about an international name and shows its real form', async () => {
    const { tree } = await mount({ ...connect, origin: 'https://xn--80ak6aa92e.com' });
    expect(texts(tree)).toContain('аррӏе.com');
    expect(texts(tree)).toContain('It is really xn--80ak6aa92e.com.');
  });

  // A real press: the finger goes down, then the press ends. Only one that began after arming counts.
  const press = async (p) => { if (p.onPressIn) p.onPressIn(); await p.onPress(); };

  it('Confirm does nothing for a second, then only after the authentication', async () => {
    const { tree, props } = await mount(connect);
    const confirm = () => button(tree, 'Connect').props;
    expect(confirm().disabled).toBe(true);
    await act(async () => { await press(confirm()); });
    expect(props.authenticate).not.toHaveBeenCalled();
    await wait(ARM_MS + 50);
    expect(confirm().disabled).toBe(false);
    props.authenticate.mockResolvedValueOnce(false);
    await act(async () => { await press(confirm()); });
    expect(props.actions.approve).not.toHaveBeenCalled();
    await act(async () => { await press(confirm()); });
    expect(props.authenticate).toHaveBeenCalledTimes(2);
    expect(props.authenticate.mock.calls[1][0]).toBe('Connect app.dapp.example to this wallet');
    expect(props.actions.approve).toHaveBeenCalledWith('a1', null);
  });

  // MBL-05: a site that keeps the user tapping cannot turn a tap into an approval.
  it('touches before it arms start the wait again, and a press already under way at arming does nothing', async () => {
    const { tree, props } = await mount(connect);
    const root = tree.root.findAll((n) => n.props && typeof n.props.onTouchStart === 'function')[0];
    await wait(ARM_MS - 300);
    await act(async () => { root.props.onTouchStart(); });
    await wait(ARM_MS - 300);
    expect(button(tree, 'Connect').props.disabled).toBe(true);
    await act(async () => { button(tree, 'Connect').props.onPressIn(); });
    await wait(ARM_MS);
    expect(button(tree, 'Connect').props.disabled).toBe(false);
    await act(async () => { await button(tree, 'Connect').props.onPress(); });
    expect(props.authenticate).not.toHaveBeenCalled();
  });

  // A site's send replaces the one unconfirmed transaction at the confirmed nonce + 1, or waits; it never goes in
  // addition (MOB-BR-R4-02).
  it('a send arms later than a connect, and not before the choice about the unconfirmed transaction is made', async () => {
    const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const { SEND_ARM_MS } = require('../src/browser/DappSheet');
    const preview = {
      nonce: null, confirmed: 6, balanceNano: '9000000000', verified: true, counterparties: [TO],
      pending: [{ nonce: 7, state: 'accepted', kind: 'transfer', to: TO, amountNano: 1500000000, method: null, ageMs: 120000 }],
      replaceNonce: 7, replaceHash: 'h7', appendNonce: null, inFlight: false, recent: [],
    };
    const view = {
      ...connect, kind: 'send', details: { to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000' }, preview,
    };
    const { tree, props } = await mount(view);
    const shown = texts(tree);
    expect(shown).toContain('Transactions from this wallet not confirmed yet: 1');
    expect(shown).toContain('1.5 QNC to 02dca74ef2eae3be97feon499504db891ae0c60e364a8 · 2 min');
    expect(shown).toContain('This wallet sent the same amount to this address 2 min ago.');
    await wait(SEND_ARM_MS + 100);
    expect(button(tree, 'Send').props.disabled).toBe(true); // no choice yet
    const pick = (v) => tree.root.findAll((n) => n.props && n.props.testID === `pick-${v}` && typeof n.props.onPress === 'function')[0];
    expect(pick('append')).toBeUndefined();
    await act(async () => { pick('replace').props.onPress(); });
    expect(texts(tree)).toContain(t('pending_replace_note'));
    expect(texts(tree)).not.toContain('Transaction number'); // the nonce it signs at is not shown
    await wait(ARM_MS + 50);
    expect(button(tree, 'Send').props.disabled).toBe(true); // still within the send delay
    await wait(SEND_ARM_MS - ARM_MS + 100);
    expect(button(tree, 'Send').props.disabled).toBe(false);
    await act(async () => { await press(button(tree, 'Send').props); });
    expect(props.actions.approve).toHaveBeenCalledWith('a1', 'replace');
  });

  it('Reject and the back button reject without any authentication', async () => {
    const { tree, props } = await mount(connect);
    await act(async () => { button(tree, 'Reject').props.onPress(); });
    expect(props.actions.reject).toHaveBeenCalledWith('a1');
    await act(async () => { BackHandler.mockPressBack ? BackHandler.mockPressBack() : null; });
    expect(props.authenticate).not.toHaveBeenCalled();
    expect(props.actions.approve).not.toHaveBeenCalled();
  });

  it('shows the exact message to sign', async () => {
    const message = 'Log in to dapp.example\nNonce: 42\nمرحبا';
    const { tree } = await mount({ ...connect, kind: 'sign', details: { message, byteLength: 43 } });
    expect(texts(tree)).toContain(message);
    expect(texts(tree)).toContain('43 bytes');
    expect(button(tree, 'Sign')).toBeTruthy();
  });

  it('a send waits for the nonce, then shows the fee, total, balance and recipient warnings (never the nonce)', async () => {
    const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const send = {
      ...connect, kind: 'send',
      details: { to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000' },
    };
    const first = await mount(send);
    expect(first.props.actions.loadPreview).toHaveBeenCalledWith('a1');
    expect(texts(first.tree)).toContain(t('common_loading'));
    await wait(1600);
    expect(button(first.tree, 'Send').props.disabled).toBe(true); // no nonce yet

    const lookAlike = `${TO.slice(0, 4)}${'f'.repeat(37)}${TO.slice(-4)}`;
    const ready = await mount({ ...send, preview: { nonce: 7, balanceNano: '1000000000', verified: true, counterparties: [lookAlike] } });
    const shown = texts(ready.tree);
    expect(texts(ready.tree)).not.toMatch(/Transaction number|verified/i);
    for (const s of [TO, '1.5 QNC', '0.00015 QNC', '1.50015 QNC', 'Balance', '1 QNC',
      'This address looks like one you used before but is different. Check every character.',
      'The balance is lower than the total.']) {
      expect(shown).toContain(s);
    }
    const fresh = await mount({ ...send, preview: { nonce: 7, balanceNano: '9000000000', verified: false, counterparties: [] } });
    expect(texts(fresh.tree)).toContain('This wallet has never sent to this address.');
    expect(texts(fresh.tree)).toContain(t('dapp_send_balance'));
    expect(texts(fresh.tree)).not.toMatch(/verified/i);
  });

  // MOBNET-R2-03 / MB2-02 / CROSS-R2-03: known means an address this wallet signed transfers to. An incoming dust
  // sender never becomes known, and a flood of incoming rows never pushes the real payee out of the look-alike base.
  it('a dust sender is not known: first-time and "only ever sent to you" warnings, and the look-alike still fires', async () => {
    const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const send = { ...connect, kind: 'send', details: { to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000' } };
    const dust = await mount({ ...send, preview: { nonce: 7, balanceNano: '9000000000', verified: true, counterparties: [], paid: [], senders: [TO] } });
    const shown = texts(dust.tree);
    expect(shown).toContain('This wallet has never sent to this address.');
    expect(shown).toContain('This address has only ever sent to this wallet');
    const payee = `${TO.slice(0, 4)}${'e'.repeat(37)}${TO.slice(-4)}`;
    const flooded = await mount({ ...send, preview: { nonce: 7, balanceNano: '9000000000', verified: true, counterparties: [payee], paid: [], senders: [TO] } });
    expect(texts(flooded.tree)).toContain('This address looks like one you used before but is different. Check every character.');
    const known = await mount({ ...send, preview: { nonce: 7, balanceNano: '9000000000', verified: true, counterparties: [TO], paid: [], senders: [TO] } });
    expect(texts(known.tree)).not.toContain('This wallet has never sent to this address.');
    expect(texts(known.tree)).not.toContain('This address has only ever sent to this wallet');
  });

  it('the known list comes from the sealed recipients, never from incoming history rows', async () => {
    const { recipientContext } = require('../src/browser/BrowserScreen');
    const HistoryCache = require('../src/services/HistoryCache');
    const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
    const PAYEE = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const eonOf = (i) => `${i.toString(16).padStart(19, '0')}eon${'1'.repeat(23)}`;
    const rows = Array.from({ length: 600 }, (_, i) => ({ from: eonOf(i + 1), to: ME, hash: `h${i}` }));
    const spy = jest.spyOn(HistoryCache, 'loadCachedHistory').mockResolvedValue(rows);
    try {
      const r = await recipientContext(ME, [PAYEE], [{ kind: 'transfer', to: eonOf(9999) }]);
      expect(r.counterparties.sort()).toEqual([PAYEE, eonOf(9999)].sort());
      expect(r.senders).toHaveLength(600);
      expect(r.counterparties).not.toContain(eonOf(1));
      expect(r.paid).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('formats nano amounts and spots look-alike addresses like the extension', () => {
    expect(formatNano('1500000000')).toBe('1.5');
    expect(formatNano('1')).toBe('0.000000001');
    expect(formatNano('12000000000000')).toBe('12000');
    expect(formatNano('x')).toBe('—');
    expect(looksLikeKnownAddress('abcd1234567890wxyz', ['abcdXXXXXXXXXXwxyz'])).toBe(true);
    expect(looksLikeKnownAddress('abcd1234567890wxyz', ['abcd1234567890wxyz'])).toBe(false);
    expect(looksLikeKnownAddress('abcd1234567890wxyz', ['abceXXXXXXXXXXwxyz'])).toBe(false);
  });
});

describe('Android back in the browser', () => {
  const BrowserScreen = require('../src/browser/BrowserScreen').default;
  const { WebView } = require('react-native-webview');

  it('goes back in the page history first, and leaves the tab only from the first page', async () => {
    WebView.calls.length = 0;
    const ref = React.createRef();
    let tree;
    await act(async () => {
      tree = renderer.create(<BrowserScreen ref={ref} visible wallet={null} credential="" walletManager={{}} t={t} onSheet={() => {}} confirmAction={() => {}} />);
    });
    expect(ref.current.handleBack()).toBe(false); // start page: nothing to go back to here
    const bookmark = tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && typeof n.props.onPress === 'function');
    await act(async () => { bookmark.props.onPress(); });
    const web = () => tree.root.findByType(WebView).props;
    await act(async () => { web().onNavigationStateChange({ url: 'https://aiqnet.io/explorer/block/1', canGoBack: true, loading: false }); });
    let handled;
    await act(async () => { handled = ref.current.handleBack(); });
    expect(handled).toBe(true);
    expect(WebView.calls.filter(([m]) => m === 'goBack')).toHaveLength(1);
    await act(async () => { web().onNavigationStateChange({ url: 'https://aiqnet.io/explorer', canGoBack: false, loading: false }); });
    expect(ref.current.handleBack()).toBe(false);
    await act(async () => { tree.unmount(); });
  });
});

describe('what the browser keeps', () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  const { rememberPage, loadHistory, clearHistory, HISTORY_MAX } = require('../src/browser/history');
  const { createGrantStore, SITES_KEY } = require('../src/browser/grants');
  const { WalletManager } = require('../src/components/WalletManager');

  beforeEach(() => AsyncStorage.clear());

  it('recent pages: https only, without query or fragment, at most 20, clearable', async () => {
    await rememberPage('https://dapp.example/play?session=SECRET#t', 'Game');
    await rememberPage('http://insecure.example/', 'x');
    await rememberPage('https://dapp.example/play', 'Game again');
    expect(await loadHistory()).toEqual([{ url: 'https://dapp.example/play', title: 'Game again', at: expect.any(Number) }]);
    expect(await AsyncStorage.getItem('qnet_browser_history')).not.toContain('SECRET');
    for (let i = 0; i < 25; i++) await rememberPage(`https://site${i}.example/`, '');
    expect((await loadHistory()).length).toBe(HISTORY_MAX);
    await clearHistory();
    expect(await loadHistory()).toEqual([]);
  });

  it('grants are sealed under the vault key: plaintext storage shows no origin, another wallet reads none', async () => {
    const wm = new WalletManager();
    const token = await wm.storeWallet({ address: 'SoL1', qnetAddress: 'q1', qnetKeypair: { publicKey: [1], privateKey: [2] } }, 'pw-long-enough-1');
    const store = createGrantStore(wm, () => token);
    await store.put('https://dapp.example', 'q1');
    expect(await store.get('https://dapp.example')).toMatchObject({ walletId: 'q1', chains: ['qnet', 'solana'] });
    expect(await AsyncStorage.getItem(SITES_KEY)).not.toContain('dapp.example');
    expect(await store.list()).toEqual([{ origin: 'https://dapp.example', grantedAt: expect.any(Number) }]);
    // Tampering is not a grant.
    const sealed = JSON.parse(await AsyncStorage.getItem(SITES_KEY));
    sealed.encrypted = sealed.encrypted.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    await AsyncStorage.setItem(SITES_KEY, JSON.stringify(sealed));
    expect(await store.get('https://dapp.example')).toBe(null);
    await store.put('https://dapp.example', 'q1');
    // A different wallet on the phone (its vault gone first: a stored vault is never replaced): the grants are
    // cleared with its scope and could not be read anyway.
    await AsyncStorage.multiRemove(['qnet_wallet', 'qnet_wallet.bak']);
    const other = await wm.storeWallet({ address: 'SoL2', qnetAddress: 'q2', qnetKeypair: { publicKey: [3], privateKey: [4] } }, 'pw-long-enough-2');
    expect(await AsyncStorage.getItem(SITES_KEY)).toBe(null);
    expect(await createGrantStore(wm, () => other).get('https://dapp.example')).toBe(null);
    await createGrantStore(wm, () => other).put('https://game.example', 'q2');
    // The first wallet's session ended when the second one opened: its token opens nothing (MVA-R4-03: a session is an
    // object compared by identity, and no string, whatever its prefix, is taken for one).
    await expect(createGrantStore(wm, () => token).get('https://game.example')).rejects.toThrow(/locked/);
    await expect(createGrantStore(wm, () => ({ ...token })).get('https://game.example')).rejects.toThrow(/locked/);
  });
});

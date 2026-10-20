/**
 * QNet Wallet's transfer link (services/transferLink, qnet-link-v1 section 15): aiqnet.io's payment address buttons on
 * a phone ask for one transfer with https://link.aiqnet.io/send#to=..[&mint=..]&amount=.., a verified link only this
 * app opens. When the OS hands one over, the Solana Send screen opens filled in by the scan's own reader
 * (utils/solanaRequest): recipient, token by mint, amount. The user reviews and confirms; nothing is sent by itself. A
 * locked wallet opens it after the unlock, an open Send screen is never replaced, and a request that cannot be read
 * says why. No build takes a solana: request: the app registers no custom URL scheme.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput, StyleSheet } from 'react-native';

const fs = require('fs');
const path = require('path');

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockInitial = { url: null };

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
    async getTokenHoldings() { return []; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return 'light_mobile_1111222233334444'; }
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
  readNodeStatus: jest.fn(async () => ({ onChain: false, features: [], deviceTags: [] })),
  readLinkPending: jest.fn(async () => null),
}));
jest.mock('../src/services/HistoryCache', () => ({ loadCachedHistory: jest.fn(async () => []), saveCachedHistory: jest.fn(async () => {}) }));
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View); };
});
jest.mock('../src/services/QNetLink', () => ({
  parseLink: jest.fn(() => null),
  takeInitialUrl: jest.fn(async () => mockInitial.url),
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { Linking } = require('react-native');
const { makeT } = require('../src/i18n');
const { ONE_DEV_MINT } = require('../src/config/nodes');
const QNetLink = require('../src/services/QNetLink');
const { isTransferLink, parseTransferLink, readTransferLink } = require('../src/services/transferLink');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;

const t = makeT('en');
const PAYEE = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SEND = 'https://link.aiqnet.io/send#';
// The payment address's two buttons.
const ONE_DEV_LINK = `${SEND}to=${PAYEE}&mint=${ONE_DEV_MINT}&amount=1500`;
const SOL_LINK = `${SEND}to=${PAYEE}&amount=0.001`;
const SOLANA_REQUEST = `solana:${PAYEE}?amount=0.001&label=QNet%20Blockchain%20node%20activation`;

describe('the transfer link, read', () => {
  it('the two buttons\' links give the recipient, the token by its mint and the amount asked, a fraction exactly', () => {
    expect(parseTransferLink(ONE_DEV_LINK)).toEqual({ to: PAYEE, mint: ONE_DEV_MINT, amount: '1500' });
    expect(parseTransferLink(SOL_LINK)).toEqual({ to: PAYEE, mint: null, amount: '0.001' });
    const request = { address: PAYEE, references: [], memo: null };
    expect(readTransferLink(ONE_DEV_LINK)).toEqual({ value: { address: PAYEE, symbol: '1DEV', amount: '1500', request } });
    expect(readTransferLink(SOL_LINK)).toEqual({ value: { address: PAYEE, symbol: 'SOL', amount: '0.001', request } });
    expect(readTransferLink(`${SEND}to=${PAYEE}&mint=${ONE_DEV_MINT}&amount=0.5`).value.amount).toBe('0.5');
    expect(readTransferLink(`${SEND}to=${PAYEE}&mint=${ONE_DEV_MINT}&amount=0.000001`).value.amount).toBe('0.000001');
  });

  it('a link not exactly in that form cannot be read: the keys once, in order, no other; a plain decimal fitting the token', () => {
    const refused = [
      'https://link.aiqnet.io/send', SEND, 'https://link.aiqnet.io/send?to=x', 'https://link.aiqnet.io/send/x',
      `https://link.aiqnet.io/send?to=${PAYEE}&amount=1`,
      `${SEND}to=${PAYEE}`, `${SEND}amount=1`, `${SEND}to=${PAYEE}&to=${PAYEE}&amount=1`,
      `${SEND}amount=1&to=${PAYEE}`, `${SEND}to=${PAYEE}&amount=1&mint=${ONE_DEV_MINT}`, `${SEND}mint=${ONE_DEV_MINT}&to=${PAYEE}&amount=1`,
      `${SEND}to=${PAYEE}&amount=1&memo=x`, `${SEND}to=${PAYEE}&label=x`, `${SEND}to=${PAYEE}&amount=1&`, `${SEND}To=${PAYEE}&amount=1`,
      `${SEND}to=${PAYEE}&amount`, `${SEND}to=${PAYEE}&amount=1=2`, `${SEND}to=abc&amount=1`, `${SEND}to=${PAYEE}&mint=abc&amount=1`,
      `${SEND}to=${PAYEE}&amount=1%2E5`,
      ...['0', '0.0', '1,500', '1e3', '1.50', '-1', '+1', '.5', '5.', '01', ' 1', '1 ', '0x10', '١٥٠٠'].map((a) => `${SEND}to=${PAYEE}&amount=${a}`),
      // More decimals than the token has: 1DEV has 6, SOL 9.
      `${SEND}to=${PAYEE}&mint=${ONE_DEV_MINT}&amount=0.0000001`, `${SEND}to=${PAYEE}&amount=0.0000000001`,
      `${SEND}to=${PAYEE}&mint=${ONE_DEV_MINT}&amount=1${'0'.repeat(200)}`,
    ];
    for (const url of refused) expect([url, readTransferLink(url)]).toEqual([url, { note: 'scan_request_invalid' }]);
  });

  it('another mint is a token the wallet does not list', () => {
    expect(readTransferLink(`${SEND}to=${PAYEE}&mint=${PAYEE}&amount=5`)).toEqual({ note: 'scan_token_not_held' });
  });

  it('anything else is no transfer request: QNet Link, other hosts and paths, and solana:', () => {
    for (const url of [
      'https://link.aiqnet.io/l#v1.x', `https://link.aiqnet.io/sender#to=${PAYEE}&amount=1`, `https://aiqnet.io/send#to=${PAYEE}&amount=1`,
      `http://link.aiqnet.io/send#to=${PAYEE}&amount=1`, `https://LINK.aiqnet.io/send#to=${PAYEE}&amount=1`,
      SOLANA_REQUEST, `SOLANA:${PAYEE}?amount=1`, null, undefined, 42,
    ]) {
      expect([url, isTransferLink(url), readTransferLink(url)]).toEqual([url, false, null]);
    }
  });

  it('a build on another Solana cluster reads no solana: request either: no build registers the scheme', () => {
    // Neither platform declares a custom scheme (QNetLink.test.js: the Android App Link filter, iOS's Universal Links).
    jest.isolateModules(() => {
      jest.doMock('../src/config/nodes', () => ({ ...jest.requireActual('../src/config/nodes'), SOLANA_CLUSTER: 'mainnet' }));
      const mainnet = require('../src/services/transferLink');
      expect(mainnet.readTransferLink(SOLANA_REQUEST)).toBe(null);
      expect(mainnet.readTransferLink(SOL_LINK).value.symbol).toBe('SOL');
    });
    jest.dontMock('../src/config/nodes');
  });
});

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text)
  .map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');

let urlListeners;
const mounted = [];
beforeAll(() => { global.fetch = jest.fn(async () => { throw new Error('offline in tests'); }); });
beforeEach(async () => {
  await AsyncStorage.clear();
  mockInitial.url = null;
  QNetLink.parseLink.mockClear();
  urlListeners = [];
  jest.spyOn(Linking, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'url') urlListeners.push(fn);
    return { remove: () => {} };
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  jest.restoreAllMocks();
});

const deliver = async (url) => { await act(async () => { urlListeners.forEach((fn) => fn({ url })); }); await flush(6); };

async function mount({ unlock = true } = {}) {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  mounted.push(tree);
  await flush(6);
  if (unlock) await unlockWallet(tree);
  return tree;
}
async function unlockWallet(tree) {
  const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('enter_password'))[0];
  await act(async () => { field.props.onChangeText('abcdefghijk'); });
  const button = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('unlock_wallet'))).pop();
  await act(async () => { await button.props.onPress(); });
  await flush(8);
}
const pressText = async (tree, label) => {
  await act(async () => { tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === label))[0].props.onPress(); });
};
const back = async (tree) => {
  await act(async () => { tree.root.findAll((n) => n.props.testID === 'solana-send')[0].findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('').includes(t('common_back'))))[0].props.onPress(); });
  await flush(6);
};

// The Solana Send screen on screen: its token, recipient and amount, and whether the from-a-link line shows.
function sendScreen(tree) {
  const form = tree.root.findAll((n) => n.props.testID === 'solana-send');
  if (form.length === 0) return null;
  const field = (id) => tree.root.find((n) => n.type === TextInput && n.props.testID === id).props.value;
  const chosen = tree.root.findAll((n) => /^solana-token-/.test(n.props.testID || '') && n.props.accessibilityState
    && n.props.accessibilityState.selected && typeof n.props.onPress === 'function');
  return {
    symbol: chosen.length ? chosen[0].props.testID.slice('solana-token-'.length) : null,
    to: field('solana-send-address'),
    amount: field('solana-send-amount'),
    fromLink: tree.root.findAll((n) => n.props.testID === 'solana-send-from-link' && n.type === Text).length > 0,
  };
}

describe('a transfer link the OS hands to QNet Wallet', () => {
  it('the payment address\'s 1DEV and SOL buttons open the Solana Send screen filled in; the user still confirms', async () => {
    const tree = await mount();
    await deliver(ONE_DEV_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(texts(tree)).toContain(t('send_from_link'));
    expect(QNetLink.parseLink).not.toHaveBeenCalled();
    // Nothing went anywhere: no review, no signature, no request to the Solana network.
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/solana/i), expect.anything());
    // Back closes it, on the Assets tab; the next button's link opens SOL.
    await back(tree);
    expect(sendScreen(tree)).toBe(null);
    await deliver(SOL_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
  });

  it('a request that cannot be read says why, and opens nothing', async () => {
    const tree = await mount();
    await deliver(`${SEND}to=${PAYEE}&amount=1e3`);
    expect(texts(tree)).toContain(t('scan_request_invalid'));
    expect(sendScreen(tree)).toBe(null);
    await pressText(tree, t('common_ok'));
    await deliver(`${SEND}to=${PAYEE}&mint=${PAYEE}&amount=5`);
    expect(texts(tree)).toContain(t('scan_token_not_held'));
    expect(sendScreen(tree)).toBe(null);
    expect(QNetLink.parseLink).not.toHaveBeenCalled();
  });

  it('a locked wallet opens it after the unlock, as the link that started the app', async () => {
    mockInitial.url = SOL_LINK;
    const tree = await mount({ unlock: false });
    expect(sendScreen(tree)).toBe(null);
    await unlockWallet(tree);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
  });

  it('a Send screen the user has open is never replaced: the request waits until it closes', async () => {
    const tree = await mount();
    await deliver(SOL_LINK);
    const typed = tree.root.find((n) => n.type === TextInput && n.props.testID === 'solana-send-amount');
    await act(async () => { typed.props.onChangeText('0.002'); });
    await deliver(ONE_DEV_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.002', fromLink: true });
    await back(tree);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
  });

  it('a QNet Link URL still goes to the QNet Link parser, and a solana: request is not a link here', async () => {
    const tree = await mount();
    await deliver('https://link.aiqnet.io/l#v1.x');
    expect(QNetLink.parseLink).toHaveBeenCalledWith('https://link.aiqnet.io/l#v1.x');
    await pressText(tree, t('common_ok'));
    await deliver(SOLANA_REQUEST);
    expect(QNetLink.parseLink).toHaveBeenCalledWith(SOLANA_REQUEST);
    expect(texts(tree)).toContain(t('link_invalid'));
    expect(sendScreen(tree)).toBe(null);
  });
});

describe('one parser and one entry for every request', () => {
  const src = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith('.js')) files.push(path.join(dir, e.name));
    }
  };
  walk(src);
  const callers = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(src, f)).sort();

  it('the scan and the OS link read a request through utils/solanaRequest only; the link through services/transferLink', () => {
    expect(callers(/parseSolanaScan\(/)).toEqual([path.join('utils', 'solanaRequest.js')]);
    expect(callers(/solana:\/i\.test\(/)).toEqual([path.join('utils', 'solanaRequest.js')]);
    expect(callers(/readTransferLink\(/)).toEqual([path.join('screens', 'WalletScreen.js'), path.join('services', 'transferLink.js')]);
    const ws = fs.readFileSync(path.join(src, 'screens', 'WalletScreen.js'), 'utf8');
    expect(ws.match(/solanaScanToForm\(/g)).toHaveLength(1); // the QR scan
    expect(ws.match(/openTransferLink\(url\)/g)).toHaveLength(1); // the OS link
    // The in-app browser opens no transfer request: the payment address's page never loads there.
    expect(fs.readFileSync(path.join(src, 'browser', 'BrowserScreen.js'), 'utf8')).not.toMatch(/transferLink|solanaRequest|SolanaRequest|solana:/);
    // The from-a-link line keeps its style in one place: a quiet note, start-aligned with the form.
    const line = StyleSheet.flatten(require('../src/screens/WalletScreen.styles').default.sendFromLink);
    expect(line).toMatchObject({ color: require('../src/theme').color.fog });
    expect(line.textAlign).toBeUndefined();
  });
});

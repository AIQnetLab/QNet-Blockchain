/**
 * QNet Wallet's transfer link (services/transferLink, qnet-link-v1 section 15): aiqnet.io's payment address buttons on
 * a phone ask for one transfer with https://link.aiqnet.io/send#to=..[&mint=..]&amount=.., a verified link only this
 * app opens. When the OS hands one over, the Solana Send screen opens filled in by the scan's own reader
 * (utils/solanaRequest): recipient, token by mint, amount. The user reviews and confirms; nothing is sent by itself. A
 * locked wallet opens it after the unlock, it takes the place of an open Send form unless a send is under way there,
 * and a request that cannot be read says why. No build takes a solana: request: the app registers no custom URL scheme.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput, StyleSheet } from 'react-native';

const fs = require('fs');
const path = require('path');

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

jest.mock('../src/components/WalletManager', () => {
  const { fakeWalletManager, walletManagerModule } = require('../test-support/walletMocks');
  class FakeWalletManager extends fakeWalletManager({
    qnet: mockQNET, sol: mockSOL, light: 'light_mobile_1111222233334444', superNode: 'super_node_5555666677778888',
  }) {
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    async getTokenHoldings() { return []; }
  }
  return walletManagerModule(FakeWalletManager);
});
jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  readNodeStatus: jest.fn(async () => ({ onChain: false, features: [], deviceTags: [] })),
  readLinkPending: jest.fn(async () => null),
}));
jest.mock('../src/services/HistoryCache', () => ({ loadCachedHistory: jest.fn(async () => []), saveCachedHistory: jest.fn(async () => {}) }));
// The Solana quote, held open by a test while a send is under way.
jest.mock('../src/services/SolanaSend', () => {
  const actual = jest.requireActual('../src/services/SolanaSend');
  return { ...actual, quoteSolanaSend: jest.fn((...args) => actual.quoteSolanaSend(...args)) };
});
jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return function QRCode() { return require('react').createElement(View); };
});
jest.mock('../src/services/QNetLink', () => ({
  parseLink: jest.fn(() => null),
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  readOffer: jest.requireActual('../src/services/QNetLink').readOffer,
  otherNodeHint: jest.fn(async () => null),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { fakeLinkInbox } = require('../test-support/linkInbox');
const { makeT } = require('../src/i18n');
const { ONE_DEV_MINT } = require('../src/config/nodes');
const QNetLink = require('../src/services/QNetLink');
const SolanaSendService = require('../src/services/SolanaSend');
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

const { flush, texts, networkFree } = require('../test-support/screen');

let inbox;
const mounted = [];
beforeAll(() => { global.fetch = jest.fn(async () => { throw new Error('offline in tests'); }); });
beforeEach(async () => {
  await AsyncStorage.clear();
  QNetLink.parseLink.mockClear();
  inbox = fakeLinkInbox();
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  inbox.remove();
  jest.restoreAllMocks();
});


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
  // The form's title names its token (the form switches none).
  const title = tree.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header')
    .map((n) => [].concat(n.props.children).join(''));
  return {
    symbol: ['SOL', '1DEV'].find((sym) => title.includes(t('send_title', { symbol: sym }))) || null,
    to: field('solana-send-address'),
    amount: field('solana-send-amount'),
    fromLink: tree.root.findAll((n) => n.props.testID === 'solana-send-from-link' && n.type === Text).length > 0,
  };
}

describe('a transfer link the OS hands to QNet Wallet', () => {
  it('the payment address\'s 1DEV and SOL buttons open the Solana Send screen filled in; the user still confirms', async () => {
    const tree = await mount();
    await inbox.deliver(ONE_DEV_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(texts(tree)).toContain(t('send_from_link'));
    expect(QNetLink.parseLink).not.toHaveBeenCalled();
    // Nothing went anywhere: no review, no signature, no request to the Solana network.
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/solana/i), expect.anything());
    // Back closes it, on the Assets tab; the next button's link opens SOL.
    await back(tree);
    expect(sendScreen(tree)).toBe(null);
    await inbox.deliver(SOL_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
  });

  // The form a link opened is said through the native inbox, which writes it in every build (noteLink); each arrival is
  // a development line, the native inbox saying link_received in every build.
  it('the log says each link\'s kind as it arrives and the transfer form it opened, never an address or the link itself', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const note = jest.fn();
    inbox.module.note = note;
    try {
      const tree = await mount();
      await inbox.deliver(SOL_LINK);
      expect(sendScreen(tree)).not.toBe(null);
      await back(tree);
      await inbox.deliver('https://link.aiqnet.io/l#v1.x');
      const lines = info.mock.calls.map((x) => x.join(' ')).filter((x) => x.includes('[LINK]'));
      expect(lines).toEqual([
        '[INFO][LINK] link_arrived kind=transfer waited=0', '[INFO][LINK] link_arrived kind=invalid waited=0',
      ]);
      expect(note.mock.calls).toEqual([['transfer_form_opened', { token: 'SOL' }]]);
      expect(lines.join('\n') + JSON.stringify(note.mock.calls)).not.toContain(PAYEE);
    } finally {
      info.mockRestore();
    }
  });

  it('a request that cannot be read says why, and opens nothing', async () => {
    const tree = await mount();
    await inbox.deliver(`${SEND}to=${PAYEE}&amount=1e3`);
    expect(texts(tree)).toContain(t('scan_request_invalid'));
    expect(sendScreen(tree)).toBe(null);
    await pressText(tree, t('common_ok'));
    await inbox.deliver(`${SEND}to=${PAYEE}&mint=${PAYEE}&amount=5`);
    expect(texts(tree)).toContain(t('scan_token_not_held'));
    expect(sendScreen(tree)).toBe(null);
    expect(QNetLink.parseLink).not.toHaveBeenCalled();
  });

  it('a locked wallet opens it after the unlock, as the link that started the app', async () => {
    inbox.arrive(SOL_LINK, { event: false });
    const tree = await mount({ unlock: false });
    expect(sendScreen(tree)).toBe(null);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    await unlockWallet(tree);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('a request takes the place of a Send form the user has open: it is what the user asked for last', async () => {
    const tree = await mount();
    await inbox.deliver(SOL_LINK);
    const typed = tree.root.find((n) => n.type === TextInput && n.props.testID === 'solana-send-amount');
    await act(async () => { typed.props.onChangeText('0.002'); });
    await inbox.deliver(ONE_DEV_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('a send under way on the open form ends first; the request opens right after it', async () => {
    const tree = await mount();
    await inbox.deliver(SOL_LINK);
    // The form reports a send it is making (SolanaSend onBusy): the request that comes now waits for it.
    const form = tree.root.findAll((n) => typeof n.props.onBusy === 'function')[0];
    await act(async () => { form.props.onBusy(true); });
    await inbox.deliver(ONE_DEV_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(inbox.waiting()).toEqual([ONE_DEV_LINK]);
    await act(async () => { form.props.onBusy(false); });
    await flush(4);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('a lock while a send is under way leaves it under way: a request that comes meanwhile opens once it ended', async () => {
    const tree = await mount();
    await inbox.deliver(SOL_LINK);
    // Send: the quote is still being read when the wallet locks from Settings.
    let failQuote = null;
    SolanaSendService.quoteSolanaSend.mockImplementationOnce(() => new Promise((_, reject) => { failQuote = reject; }));
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'solana-send-button' && typeof n.props.onPress === 'function').pop().props.onPress(); });
    await flush(2);
    expect(failQuote).toEqual(expect.any(Function));
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    await flush(4);
    await pressText(tree, t('lock_wallet'));
    await flush(4);
    await inbox.deliver(ONE_DEV_LINK);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    // Unlocked: the form of the send under way, which still shows it; the request waits for it.
    await unlockWallet(tree);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(tree.root.findAll((n) => n.props.testID === 'solana-send-button' && n.props.busy === true).length).toBeGreaterThan(0);
    expect(inbox.waiting()).toEqual([ONE_DEV_LINK]);
    // The send ends (refused, nothing sent): its result first, then the request once that is closed.
    await act(async () => { failQuote(Object.assign(new Error('offline'), { code: 'SOL_RPC' })); });
    await flush(4);
    expect(inbox.waiting()).toEqual([ONE_DEV_LINK]);
    await act(async () => { tree.root.findAll((n) => typeof n.props.onAction === 'function')[0].props.onAction(); });
    await flush(6);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('a Solana send holds the background verification while it is under way, and lets it go when it ends', async () => {
    const tree = await mount();
    await inbox.deliver(SOL_LINK);
    expect(await networkFree()).toBe(true);
    let failQuote = null;
    SolanaSendService.quoteSolanaSend.mockImplementationOnce(() => new Promise((_, reject) => { failQuote = reject; }));
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'solana-send-button' && typeof n.props.onPress === 'function').pop().props.onPress(); });
    await flush(2);
    expect([typeof failQuote, await networkFree()]).toEqual(['function', false]);
    await act(async () => { failQuote(Object.assign(new Error('offline'), { code: 'SOL_RPC' })); });
    await flush(4);
    expect(await networkFree()).toBe(true);
  });

  it('a QNet Link URL still goes to the QNet Link parser, and a solana: request is not a link here', async () => {
    const tree = await mount();
    await inbox.deliver('https://link.aiqnet.io/l#v1.x');
    expect(QNetLink.parseLink).toHaveBeenCalledWith('https://link.aiqnet.io/l#v1.x');
    await pressText(tree, t('common_ok'));
    await inbox.deliver(SOLANA_REQUEST);
    expect(QNetLink.parseLink).toHaveBeenCalledWith(SOLANA_REQUEST);
    expect(texts(tree)).toContain(t('link_invalid'));
    expect(sendScreen(tree)).toBe(null);
  });
});

// A link the OS delivered waits in the link inbox until the screen that shows it is done with it (services/LinkInbox):
// Android's Back finishes the activity and the next link makes a new one in the same JS, with no link event; the lock
// screen may go with its activity; the same link must still open exactly once.
describe('a link is never lost, and opens once', () => {
  const A = { id: 'a'.repeat(32), sitePub: 'b'.repeat(43), intent: 'connect' };
  const URL_A = 'https://link.aiqnet.io/l#a';
  const remount = async (tree, options) => {
    await act(async () => { tree.unmount(); });
    mounted.splice(mounted.indexOf(tree), 1);
    return mount(options);
  };
  afterEach(() => { QNetLink.parseLink.mockImplementation(() => null); });

  it('Back finished the activity: the screen made anew opens the link that came for it, filled in', async () => {
    const first = await mount();
    await act(async () => { first.unmount(); });
    mounted.splice(mounted.indexOf(first), 1);
    inbox.arrive(SOL_LINK, { event: false });
    const tree = await mount();
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('a request waiting behind the lock screen outlives the screen; it opens filled right after the unlock', async () => {
    let tree = await mount({ unlock: false });
    await inbox.deliver(SOL_LINK);
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    tree = await remount(tree, { unlock: false });
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    expect(sendScreen(tree)).toBe(null);
    await unlockWallet(tree);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
  });

  it('two requests behind the lock screen open in their order, the second once the form of the first is closed', async () => {
    const tree = await mount({ unlock: false });
    await inbox.deliver(SOL_LINK);
    await inbox.deliver(ONE_DEV_LINK);
    expect(inbox.waiting()).toEqual([SOL_LINK, ONE_DEV_LINK]);
    await unlockWallet(tree);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(inbox.waiting()).toEqual([ONE_DEV_LINK]);
    await back(tree);
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
  });

  it('once opened, neither the platform\'s cue again nor a screen made anew opens it again', async () => {
    let tree = await mount();
    await inbox.deliver(SOL_LINK);
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    await back(tree);
    await act(async () => { inbox.cue(); });
    await flush(6);
    expect(sendScreen(tree)).toBe(null);
    tree = await remount(tree);
    expect(sendScreen(tree)).toBe(null);
    expect(inbox.module.done).toHaveBeenCalledTimes(1);
  });

  it('waits behind a QNet Link request the user has to decide; a decided one gives way to it at once, its answer going on', async () => {
    QNetLink.parseLink.mockImplementation((url) => (url === URL_A ? A : null));
    QNetLink.openSession.mockImplementation(async () => ({ expiresAt: Date.now() + 600_000 }));
    QNetLink.prepareOffer.mockImplementation(async () => ({ kind: 'connect', addresses: { qnet: mockQNET, solana: mockSOL } }));
    QNetLink.markHandled.mockImplementation(async () => {});
    let delivered;
    QNetLink.deliverAnswer.mockImplementation(() => new Promise((resolve) => { delivered = resolve; }));
    const tree = await mount();
    await inbox.deliver(URL_A);
    await flush(4);
    expect(texts(tree)).toContain(t('link_title_connect'));
    await inbox.deliver(SOL_LINK);
    expect(sendScreen(tree)).toBe(null);
    await pressText(tree, t('link_reject'));
    await flush(6);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(A, expect.anything(), { status: 'rejected' }, expect.anything());
    // No Close: the form is on screen, the decided sheet gone, and the wallet says the answer is still on its way.
    expect(sendScreen(tree)).toEqual({ symbol: 'SOL', to: PAYEE, amount: '0.001', fromLink: true });
    expect(texts(tree)).not.toContain(t('link_result_rejected'));
    expect(tree.root.findAll((n) => n.props.testID === 'answer-away' && n.type === Text)).toHaveLength(1);
    expect(texts(tree)).toContain(t('link_working_send'));
    expect(inbox.waiting()).toEqual([]);
    await act(async () => { delivered('delivered'); });
    await flush(2);
    expect(texts(tree)).not.toContain(t('link_working_send'));
    for (const fn of ['openSession', 'prepareOffer', 'markHandled', 'deliverAnswer']) QNetLink[fn].mockReset();
  });

  // A decided sheet over a send's result gives way to a transfer link at once; the result stays until its Done, which
  // opens the link's form.
  it('over a send\'s result, a decided request gives way to a transfer link at once; the result stays, and its Done opens the form filled', async () => {
    const QNetLinkScreen = require('../src/screens/QNetLinkScreen').default;
    QNetLink.parseLink.mockImplementation((url) => (url === URL_A ? A : null));
    QNetLink.openSession.mockImplementation(async () => ({ expiresAt: Date.now() + 600_000 }));
    QNetLink.prepareOffer.mockImplementation(async () => ({ kind: 'connect', addresses: { qnet: mockQNET, solana: mockSOL } }));
    QNetLink.markHandled.mockImplementation(async () => {});
    let delivered;
    QNetLink.deliverAnswer.mockImplementation(() => new Promise((resolve) => { delivered = resolve; }));
    const tree = await mount();
    // A send's result on screen: the Solana network could not be asked, nothing was sent.
    await inbox.deliver(SOL_LINK);
    SolanaSendService.quoteSolanaSend.mockImplementationOnce(async () => { throw Object.assign(new Error('offline'), { code: 'SOL_RPC' }); });
    await act(async () => { await tree.root.findAll((n) => n.props.testID === 'solana-send-button' && typeof n.props.onPress === 'function').pop().props.onPress(); });
    await flush(4);
    expect(texts(tree)).toContain(t('err_SOL_RPC'));
    // A QNet Link request over it, decided; its answer is still on its way.
    await inbox.deliver(URL_A);
    await flush(4);
    expect(texts(tree)).toContain(t('link_title_connect'));
    await pressText(tree, t('link_reject'));
    await flush(6);
    expect(tree.root.findAllByType(QNetLinkScreen)).toHaveLength(1);
    // The transfer link: the decided sheet goes at once, the result stays, the answer goes on and the wallet says so.
    await inbox.deliver(ONE_DEV_LINK);
    expect(tree.root.findAllByType(QNetLinkScreen)).toHaveLength(0);
    expect(texts(tree)).toContain(t('err_SOL_RPC'));
    expect(tree.root.findAll((n) => n.props.testID === 'answer-away' && n.type === Text)).toHaveLength(1);
    expect(inbox.waiting()).toEqual([ONE_DEV_LINK]);
    // The result's Done opens the transfer's form, filled.
    await act(async () => { tree.root.findAll((n) => typeof n.props.onAction === 'function')[0].props.onAction(); });
    await flush(6);
    expect(texts(tree)).not.toContain(t('err_SOL_RPC'));
    expect(sendScreen(tree)).toEqual({ symbol: '1DEV', to: PAYEE, amount: '1500', fromLink: true });
    expect(inbox.waiting()).toEqual([]);
    await act(async () => { delivered('delivered'); });
    await flush(2);
    expect(texts(tree)).not.toContain(t('link_working_send'));
    for (const fn of ['openSession', 'prepareOffer', 'markHandled', 'deliverAnswer']) QNetLink[fn].mockReset();
  });

  // "A request ... is waiting" on the lock screen only for a request the user has not decided, never for a decided one.
  it('the lock screen says a request waits only while one waits for the user; a decided one\'s answer on its way is said instead', async () => {
    QNetLink.parseLink.mockImplementation((url) => (url === URL_A ? A : null));
    QNetLink.openSession.mockImplementation(async () => ({ expiresAt: Date.now() + 600_000 }));
    QNetLink.prepareOffer.mockImplementation(async () => ({ kind: 'connect', addresses: { qnet: mockQNET, solana: mockSOL } }));
    QNetLink.markHandled.mockImplementation(async () => {});
    let delivered;
    QNetLink.deliverAnswer.mockImplementation(() => new Promise((resolve) => { delivered = resolve; }));
    const tree = await mount();
    await inbox.deliver(URL_A);
    await flush(4);
    await pressText(tree, t('link_reject'));
    await flush(6);
    await act(async () => { tree.root.findAll((n) => n.props.testID === 'tab-settings' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    await flush(4);
    await pressText(tree, t('lock_wallet'));
    await flush(4);
    expect(texts(tree)).toContain(t('unlock_wallet'));
    expect(texts(tree)).not.toContain(t('link_waiting_unlock'));
    expect(texts(tree)).toContain(t('link_working_send'));
    await act(async () => { delivered('delivered'); });
    await flush(2);
    expect(texts(tree)).not.toContain(t('link_working_send'));
    expect(texts(tree)).not.toContain(t('link_waiting_unlock'));
    for (const fn of ['openSession', 'prepareOffer', 'markHandled', 'deliverAnswer']) QNetLink[fn].mockReset();
  });

  it('a QNet Link request behind the lock screen outlives the screen and opens once after the unlock', async () => {
    QNetLink.parseLink.mockImplementation((url) => (url === URL_A ? A : null));
    QNetLink.openSession.mockImplementation(() => new Promise(() => {}));
    let tree = await mount({ unlock: false });
    await inbox.deliver(URL_A);
    tree = await remount(tree, { unlock: false });
    expect(texts(tree)).toContain(t('link_waiting_unlock'));
    expect(QNetLink.openSession).not.toHaveBeenCalled();
    await unlockWallet(tree);
    expect(QNetLink.openSession.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(texts(tree)).toContain(t('link_title_connect'));
    // Not decided yet: it still waits for whichever screen is up.
    expect(inbox.waiting()).toEqual([URL_A]);
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
    expect(ws.match(/openTransferLink\(url, release, waited\)/g)).toHaveLength(1); // the OS link
    // The in-app browser opens no transfer request: the payment address's page never loads there.
    expect(fs.readFileSync(path.join(src, 'browser', 'BrowserScreen.js'), 'utf8')).not.toMatch(/transferLink|solanaRequest|SolanaRequest|solana:/);
    // The from-a-link line keeps its style in one place: a quiet note, start-aligned with the form.
    const line = StyleSheet.flatten(require('../src/screens/WalletScreen.styles').default.sendFromLink);
    expect(line).toMatchObject({ color: require('../src/theme').color.fog });
    expect(line.textAlign).toBeUndefined();
  });
});

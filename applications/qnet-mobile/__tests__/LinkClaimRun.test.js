/**
 * Move to wallet from aiqnet.io, on the real wallet screen: a QNet Link claim sheet runs the Node tab's
 * own run (WalletScreen startMove over services/MoveRun), each part in transit and the next one sent once the wallet's
 * live figure shows the part before in the wallet; the Node tab's Move to wallet starts nothing meanwhile; and the sheet
 * answers once, at the end, with the run's total, its last claim and where that one stopped when the run ended short (a
 * refusal, a lock, the session's time). QNetLink is real but for the relay's session and the delivery.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockSUPER = 'super_node_5555666677778888';
const mockState = {};
const mockLinks = {};
// The super node's status as a genesis node answers it, by its id and by the wallet alike.
const mockServerStatus = () => ({
  success: true, registered: true, nodeId: mockSUPER, nodeType: 'super', isOnline: true, lastSeen: 0,
  heartbeatCount: 0, requiredHeartbeats: 9, pendingRewards: 0, reputation: 70,
});

jest.mock('../src/components/WalletManager', () => {
  const { fakeWalletManager, walletManagerModule } = require('../test-support/walletMocks');
  class FakeWalletManager extends fakeWalletManager({ qnet: mockQNET, sol: mockSOL, light: 'light_mobile_1111222233334444', superNode: mockSUPER }) {
    async getQNCBalanceWithProof() { return { ok: true, verified: true, balance: 1, balanceNano: '1000000000', blockHeight: 9000, lastClaimedEpoch: 100, figureClaimedEpoch: 100 }; }
    async liveQncFigure() { return mockState.live || null; }
    async networkPause() { return null; }
    // Each claim's answer in turn (an Error is thrown).
    async claimRewards(nodeType, wallet, credential, balanceNano, nodeId, { after = null } = {}) {
      mockState.claims.push({ nodeType, wallet, credential, balanceNano, nodeId, after });
      const next = mockState.claimResults.shift();
      if (next instanceof Error) throw next;
      return next;
    }
    // Every genesis node names the wallet's super node.
    async walletNode(owner, { onNamed = null } = {}) {
      const node = { nodeId: mockSUPER, nodeType: 'super', confirmed: true };
      if (onNamed) onNamed(node);
      return node;
    }
  }
  return walletManagerModule(FakeWalletManager);
});
jest.mock('../src/services/PushService', () => require('../test-support/walletMocks').pushServiceModule({
  checkServerNodeStatus: jest.fn(async () => mockServerStatus()),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] })),
  // The node balance every genesis node gives: 9 QNC above watermark 100.
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 9e9, firstUnclaimedEpoch: 101 })),
}));
// The server card's read of the super node by its id: every genesis node gives its status.
jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  readServerNodeListed: jest.fn(async (nodeId, { onStatus = null } = {}) => {
    if (onStatus && nodeId === mockSUPER) onStatus(mockServerStatus());
    return nodeId === mockSUPER;
  }),
}));
jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => ({ capable: true, platform: 'android', flags: '', report: null })),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
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
// The link's relay session and the delivery of its answer are the test's; what Confirm does is the app's own.
jest.mock('../src/services/QNetLink', () => ({
  ...jest.requireActual('../src/services/QNetLink'),
  parseLink: jest.fn((url) => mockLinks[url] || null),
  openSession: jest.fn(),
  prepareOffer: jest.fn(),
  deliverAnswer: jest.fn(async () => 'delivered'),
  markHandled: jest.fn(async () => {}),
  otherNodeHint: jest.fn(async () => null),
}));

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const QNetLink = require('../src/services/QNetLink');
const { lightNodeId } = require('../src/crypto/NodePreimages');
const { fakeLinkInbox } = require('../test-support/linkInbox');
const { flush, textOf, texts, pressText, tab, moveButton, transitTick } = require('../test-support/screen');
const { H1, H2, sentPart: part, liveAt } = require('../test-support/moveRun');
const WalletScreen = require('../src/screens/WalletScreen').default;

const LIGHT = lightNodeId(mockQNET);
const CLAIM = { id: 'e'.repeat(32), sitePub: 'd'.repeat(43), intent: 'claim', reqHash: 'f'.repeat(43) };
const URL = 'https://link.aiqnet.io/l#claim';

const typeInto = async (tree, placeholder, value) => {
  const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === placeholder)[0];
  await act(async () => { field.props.onChangeText(value); });
};
// The answers the sheet gave, as the relay would carry them.
const answers = () => QNetLink.deliverAnswer.mock.calls.map((c) => c[2]);

const mounted = [];
let inbox;
let nowSpy;
const clock = { offset: 0 };
beforeAll(() => { global.fetch = jest.fn(async () => { throw new Error('offline in tests'); }); });
beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('qnet_autolock_time', 'never');
  clock.offset = 0;
  const real = Date.now.bind(Date);
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => real() + clock.offset);
  jest.spyOn(global, 'setInterval');
  jest.spyOn(global, 'setTimeout');
  AppState.currentState = 'active';
  Object.assign(mockState, { claims: [], claimResults: [], live: null });
  Object.assign(mockLinks, { [URL]: CLAIM });
  inbox = fakeLinkInbox();
  QNetLink.deliverAnswer.mockClear();
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  inbox.remove();
  nowSpy.mockRestore();
  global.setInterval.mockRestore();
  global.setTimeout.mockRestore();
});

// The wallet open on its Node tab, a claim request of its light node's 9 QNC confirmed with the password, its session
// ending `left` ms from now.
async function confirmed(left = 600_000) {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  mounted.push(tree);
  await flush(6);
  await typeInto(tree, t('enter_password'), 'abcdefghijk');
  await pressText(tree, t('unlock_wallet'));
  await tab(tree, 'node');
  QNetLink.openSession.mockImplementation(async () => ({ expiresAt: Date.now() + left, request: { walletHash: 'w', nodeId: LIGHT } }));
  QNetLink.prepareOffer.mockImplementation(async () => ({ kind: 'claim', nodeId: LIGHT, nodeType: 'light', qnet: mockQNET, amountNano: 9e9 }));
  await inbox.deliver(URL);
  expect(texts(tree)).toContain(t('link_title_claim'));
  await act(() => new Promise((r) => { setTimeout(r, 1100); })); // Confirm arms
  const confirm = tree.root.findAll((n) => typeof n.props.onPress === 'function' && typeof n.props.onPressIn === 'function'
    && n.findAllByType(Text).some((x) => textOf(x) === t('link_confirm'))).pop();
  await act(async () => { confirm.props.onPressIn(); confirm.props.onPress(); });
  await flush(4);
  await typeInto(tree, t('password'), 'abcdefghijk');
  await pressText(tree, t('common_confirm'));
  await flush(8);
  return tree;
}

describe('a QNet Link claim sheet runs the Node tab\'s move and answers once', () => {
  it('two parts: the second once the first is in the wallet, from its last epoch; one answer with the total and the last hash', async () => {
    mockState.claimResults = [part('5000000000', 100, 612, H1, 'batch_full'), part('4000000000', 612, 700, H2)];
    const tree = await confirmed();
    expect(mockState.claims).toEqual([{ nodeType: 'light', wallet: mockQNET, credential: 'session-token', balanceNano: 9e9, nodeId: LIGHT, after: null }]);
    // The next part is to go: the sheet says to keep the app open, nothing is answered yet, and the Node tab's own Move
    // to wallet starts nothing while the run holds the balance.
    expect(texts(tree)).toContain(t('link_claim_parts'));
    expect(answers()).toEqual([]);
    await act(async () => { moveButton(tree).props.onPress(); });
    await flush(4);
    expect(mockState.claims).toHaveLength(1);
    // Not before the first part is in the wallet.
    mockState.live = liveAt(1, 100);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
    mockState.live = liveAt(6, 612);
    await transitTick();
    expect(mockState.claims.map((c) => [c.balanceNano, c.after])).toEqual([[9e9, null], [null, 612]]);
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toMatchObject({ status: 'ok', qnet: mockQNET, nodeId: LIGHT, amountNano: '9000000000', txHash: H2, stoppedAtEpoch: null });
    // The sheet's done screen: the total, two transactions; the second part is in transit as one from the Node tab.
    expect(texts(tree)).toContain(t('link_result_claim', { amount: '9 QNC' }));
    expect(tree.root.findAll((n) => n.props.testID === 'link-claim-parts' && n.props.value === '2')).not.toHaveLength(0);
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
  });

  it('the next part refused: the answer is the first part, with where it stopped', async () => {
    mockState.claimResults = [part('5000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('refused'), { code: 'RATE_LIMITED' })];
    await confirmed();
    mockState.live = liveAt(6, 612);
    await transitTick();
    expect(mockState.claims).toHaveLength(2);
    expect(answers()).toEqual([expect.objectContaining({ status: 'ok', amountNano: '5000000000', txHash: H1, stoppedAtEpoch: '613' })]);
  });

  it('a lock after the first part: no next part, and the answer goes before the session ends, the part still in transit', async () => {
    mockState.claimResults = [part('5000000000', 100, 612, H1, 'batch_full'), part('4000000000', 612, 700, H2)];
    const tree = await confirmed();
    await tab(tree, 'settings');
    await pressText(tree, t('lock_wallet'));
    expect(texts(tree)).toContain(t('unlock_wallet'));
    expect(answers()).toEqual([]);
    // CLAIM_ANSWER_MARGIN_S before the session ends, the run stops waiting for the part's block.
    const deadline = global.setTimeout.mock.calls.filter((c) => c[1] > 400_000 && c[1] <= 450_000).pop();
    expect(deadline).toBeDefined();
    clock.offset += 451_000;
    clearTimeout(global.setTimeout.mock.results[global.setTimeout.mock.calls.indexOf(deadline)].value);
    await act(async () => { deadline[0](); });
    await flush(12);
    expect(mockState.claims).toHaveLength(1);
    expect(answers()).toEqual([expect.objectContaining({ status: 'ok', amountNano: '5000000000', txHash: H1, stoppedAtEpoch: '613' })]);
  });

  it('with less than CLAIM_ANSWER_MARGIN_S of the session left, the first part goes and no next one', async () => {
    mockState.claimResults = [part('5000000000', 100, 612, H1, 'batch_full'), part('4000000000', 612, 700, H2)];
    await confirmed(140_000);
    expect(mockState.claims).toHaveLength(1);
    expect(answers()).toEqual([expect.objectContaining({ status: 'ok', amountNano: '5000000000', txHash: H1, stoppedAtEpoch: '613' })]);
    mockState.live = liveAt(6, 612);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
  });
});

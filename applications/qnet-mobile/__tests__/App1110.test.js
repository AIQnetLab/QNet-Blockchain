/**
 * The owner's decisions of 11.10 on the real wallet screen: a move of a node balance is in transit until the wallet's
 * live figure (a genesis node's live tip, its proof folded) shows it in the wallet (owner, 18.10; "Moving X" with the
 * button off on the Node tab, "Moving" on its History row, never the amount in two places nor in none), whichever tab
 * the user stays on, however long it takes: no clock and no node's answer of the node balance ends it (owner, 12.10);
 * the certified read settles its record later, in the background; the node balance after it only from nodes not behind
 * the wallet's watermark, for good; a super node registered and not admitted yet waits for admission
 * rather than reading Offline; deleting or erasing the wallet says first that its node stops on this device. The unit
 * rules are ClaimTransit.test.js, NodeTab.test.js and BalanceFirstPaint.test.js.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Linking, StyleSheet, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
const mockSUPER = 'super_node_5555666677778888';
const mockHASH = 'ab'.repeat(32);
const mockState = {};
// The claim transaction as a genesis node lists it in the wallet's history.
const mockClaimRow = { hash: mockHASH, tx_type: 'RewardDistribution', from: 'system_rewards_pool', to: mockQNET, amount: 4e9, timestamp: 1791000000, fee: 0 };
// The super node's status as a genesis node answers it, by its id and by the wallet alike.
const mockServerStatus = () => ({
  success: true, registered: true, nodeId: mockSUPER, nodeType: 'super', isOnline: mockState.online, lastSeen: 0,
  heartbeatCount: 0, requiredHeartbeats: 9, pendingRewards: 0, reputation: 70, admission: mockState.admission,
});

jest.mock('../src/components/WalletManager', () => {
  const { fakeWalletManager, walletManagerModule } = require('../test-support/walletMocks');
  class FakeWalletManager extends fakeWalletManager({ qnet: mockQNET, sol: mockSOL, light: mockLIGHT, superNode: mockSUPER }) {
    getTrustedNodes() { return mockState.nodes || []; }
    async getBalance() { return 0.5; }
    async getTokenBalance() { return 4; }
    // The QNC read: what the test says, its figure early too when it folded.
    async getQNCBalanceWithProof(addr, verify, opts) {
      mockState.qncReads += 1;
      const r = mockState.qnc;
      if (r && r.ok && opts && opts.onFigure) opts.onFigure({ ...r, folded: true });
      return r;
    }
    // What two genesis nodes list alike of the wallet's history (listing keys), or nothing read.
    async agreedHistoryRows() { return mockState.listed || null; }
    // The chain's answer by nonce about a send of this wallet: the one the test holds, else nothing decided.
    resolveSubmitByNonce() { mockState.nonceAsks += 1; return mockState.nonceAnswer || Promise.resolve(null); }
    // The wallet's figure at a genesis node's live tip: what the test says (none by default).
    async liveQncFigure() { mockState.liveReads += 1; return mockState.live || null; }
    async networkPause() { return null; }
    // The foreground follow's round (WalletManager.followTick): what the test says (nothing by default).
    async followTick() { return mockState.follow; }
    // Each claim's answer: the next of mockState.claimResults while there is one (an Error is thrown), else claimResult;
    // a test that holds the claim (mockState.claimGate) finds it still being sent until it lets it go.
    async claimRewards(nodeType, wallet, credential, balanceNano, nodeId, { after = null } = {}) {
      mockState.claims.push({ nodeType, wallet, balanceNano, nodeId });
      mockState.afters.push(after);
      if (mockState.claimGate) await mockState.claimGate;
      const next = mockState.claimResults.length ? mockState.claimResults.shift() : mockState.claimResult;
      if (next instanceof Error) throw next;
      return next;
    }
    // One node's holdings answer and an added token's figure at a genesis node's live tip: what the test says.
    async getTokenHoldings() { return mockState.holdings || []; }
    async liveTokenFigure() { return mockState.liveToken || null; }
    _formatBaseUnits(base, decimals) { return require('../src/browser/dappRequests').formatUnits(base, decimals); }
    // An added token's balance read: what the test says (balance null: the read failed).
    async getTokenBalanceOf() { return mockState.tokenBalance || { balance: null }; }
    // The genesis nodes' word on the wallet's node: the node the test names, every one alike, else none.
    async walletNode(owner, { onNamed = null } = {}) {
      const n = mockState.node;
      if (!n) return 'none';
      const node = { nodeId: n.pseudonym, nodeType: n.nodeType, confirmed: true };
      if (onNamed) onNamed(node);
      return node;
    }
  }
  return walletManagerModule(FakeWalletManager);
});

jest.mock('../src/services/LightNode', () => ({
  ...jest.requireActual('../src/services/LightNode'),
  readNodeStatus: jest.fn(async () => ({
    reachable: true, onChain: false, registrationPending: false, deviceBound: null, deviceBoundAgreed: null, answered: null,
    needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null,
  })),
  readLinkPending: jest.fn(async () => null),
  dropLinkPending: jest.fn(async () => {}),
  // The server card's read of the super node by its id: every genesis node gives its status.
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

jest.mock('../src/services/PushService', () => require('../test-support/walletMocks').pushServiceModule({
  localBinding: jest.fn(async (id) => (mockState.bound && id === mockLIGHT ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm' } : null)),
  localNode: jest.fn(async () => (mockState.bound ? { nodeId: mockLIGHT, walletAddress: mockQNET } : null)),
  checkServerNodeStatus: jest.fn(async () => mockServerStatus()),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] })),
  // The node balance as each genesis answer gives it (mockState.pending: one call's answer, by its order).
  getPendingRewards: jest.fn(async () => { mockState.pendingCalls += 1; return mockState.pending(mockState.pendingCalls); }),
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
  openSession: jest.fn(), prepareOffer: jest.fn(), performIntent: jest.fn(), deliverAnswer: jest.fn(), markHandled: jest.fn(),
  LinkRefusal: class LinkRefusal extends Error {},
}));

const { makeT } = require('../src/i18n');
const t = makeT('en');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const WalletScreen = require('../src/screens/WalletScreen').default;
const styles = require('../src/screens/WalletScreen.styles').default;
const { flush, textOf, texts, pressText, tab, moveButton, explorerAction, networkFree, transitTick } = require('../test-support/screen');
const { H1, H2, H3, sentPart: part, liveAt } = require('../test-support/moveRun');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const qncFigure = (tree) => textOf(tree.root.findAll((n) => n.type === Text && n.props.style === styles.tokenAmount)[0]);
const historyMoving = (tree) => tree.root.findAll((n) => n.type === Text && n.props.testID === 'history-badge-moving').length;
const transitLine = (tree) => {
  const line = tree.root.findAll((n) => n.type === Text && n.props.testID === 'qnc-transit');
  return line.length ? textOf(line[0]) : null;
};
const pull = async (tree) => {
  const onRefresh = tree.root.findAll((n) => n.props.refreshControl && n.props.refreshControl.props
    && typeof n.props.refreshControl.props.onRefresh === 'function')[0].props.refreshControl.props.onRefresh;
  await act(async () => { await onRefresh(); });
  await flush(12);
};

const mounted = [];
async function unlocked() {
  let tree;
  await act(async () => { tree = renderer.create(<WalletScreen />); });
  mounted.push(tree);
  await flush(6);
  const field = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('enter_password'))[0];
  await act(async () => { field.props.onChangeText('abcdefghijk'); });
  await pressText(tree, t('unlock_wallet'));
  await flush(6);
  return tree;
}

// The wallet's QNC as a certified read gives it, with its claim watermark (the figure's, and the certified one).
const certified = (qnc, lastClaimedEpoch) => ({
  ok: true, verified: true, balance: qnc, balanceNano: String(Math.round(qnc * 1e9)), blockHeight: 9000, lastClaimedEpoch,
  figureClaimedEpoch: lastClaimedEpoch,
});
// The node's answers: before the move every node holds 4 QNC unclaimed above watermark 100. After it, a node that
// applied the whole move has nothing left to claim, and says so as the node does: 0 with no first unclaimed epoch.
const BEFORE = () => ({ success: true, pendingRewards: 4e9, firstUnclaimedEpoch: 101 });
const APPLIED = () => ({ success: true, pendingRewards: 0, firstUnclaimedEpoch: null });
// A scheduled call run now, its timer cleared first (no copy of it runs later, after the test).
const fireTimeout = async (call) => {
  clearTimeout(global.setTimeout.mock.results[global.setTimeout.mock.calls.indexOf(call)].value);
  await act(async () => { await call[0](); });
  await flush(12);
};
// The result card's next look at the claim by its hash (WalletScreen followMove: first after 2 s), run now.
const followTick = async () => {
  const timer = global.setTimeout.mock.calls.filter((c) => c[1] === 2000).pop();
  if (!timer) throw new Error('no claim follow is scheduled');
  await fireTimeout(timer);
};
// The app comes back to the front: every listener of the app's state hears it (from call `from` on: only those added
// since then, so a screen an earlier test left behind does not answer too).
const resume = async (from = 0) => {
  const handlers = AppState.addEventListener.mock.calls.slice(from).filter((c) => c[0] === 'change').map((c) => c[1]);
  await act(async () => { await Promise.all(handlers.map((h) => Promise.resolve().then(() => h('active')).catch(() => {}))); });
  await flush(12);
};

let nowSpy;
const clock = { offset: 0 };
beforeAll(() => {
  // Offline but for the wallet's history on a genesis node, which lists the claim once it was sent.
  global.fetch = jest.fn(async (url) => {
    if (mockState.claimListed && /\/api\/v1\/account\/[^/]+\/transactions/.test(String(url))) {
      return { ok: true, json: async () => ({ transactions: [mockClaimRow] }) };
    }
    if (mockState.received && /\/api\/v1\/account\/[^/]+\/transactions/.test(String(url))) {
      return { ok: true, json: async () => ({ transactions: [mockState.received] }) };
    }
    // The chain's height, once the test names one.
    if (mockState.tip && String(url).endsWith('/api/v1/height')) return { ok: true, json: async () => ({ height: mockState.tip }) };
    // A genesis node's lookup of the claim, once the test puts it in a block.
    if (mockState.claimInBlock && String(url).endsWith(`/api/v1/transaction/${mockHASH}`)) {
      return { ok: true, json: async () => ({ status: 'found', transaction: { hash: mockHASH, status: 'confirmed', block_height: mockState.claimInBlock } }) };
    }
    throw new Error('offline in tests');
  });
});
beforeEach(async () => {
  await AsyncStorage.clear();
  // The clock jumps minutes ahead in some tests: the wallet must not lock itself meanwhile.
  await AsyncStorage.setItem('qnet_autolock_time', 'never');
  clock.offset = 0;
  const real = Date.now.bind(Date);
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => real() + clock.offset);
  jest.spyOn(global, 'setInterval');
  jest.spyOn(global, 'setTimeout');
  AppState.currentState = 'active';
  Object.assign(mockState, {
    node: { nodeType: 'super', pseudonym: mockSUPER }, online: true, admission: undefined, bound: false,
    qnc: certified(1, 100), qncReads: 0, claims: [], afters: [], claimResults: [], pendingCalls: 0, pending: BEFORE,
    claimListed: false, tokenBalance: null,
    live: null, liveReads: 0, nodes: [], claimInBlock: null, received: null, listed: null, holdings: null, liveToken: null, tip: null,
    nonceAsks: 0, nonceAnswer: null, follow: null, claimGate: null,
    claimResult: { success: true, amount: 4, amountNano: '4000000000', prevWatermark: 100, lastEpoch: 103, txHash: mockHASH, pending: true },
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  nowSpy.mockRestore();
  global.setInterval.mockRestore();
  global.setTimeout.mockRestore();
});

// Move the super node's 4 QNC from the Node tab, and close the result card.
async function moved(tree) {
  await tab(tree, 'node');
  expect(texts(tree)).toContain(`${t('node_balance')}\n4 QNC`);
  await act(async () => { await moveButton(tree).props.onPress(); });
  await flush(8);
  expect(mockState.claims).toEqual([{ nodeType: 'super', wallet: mockQNET, balanceNano: 4e9, nodeId: mockSUPER }]);
  expect(texts(tree)).toContain(t('claim_submitted_title'));
  await pressText(tree, t('common_done'));
}

describe('a move of a node balance in transit (owner, 11.10 and 18.10)', () => {
  // Before 11.10 nothing was held: the node balance kept its old figure with Move on, and Assets showed nothing of the
  // move: the amount was in two places or in none. Before 18.10 only a certified read ended it, minutes after Assets
  // already showed the QNC (the live figure). This test fails on either.
  it('is "Moving X" on the Node tab until the live figure shows it, never a line under QNC, then the node balance of the nodes that applied it', async () => {
    const tree = await unlocked();
    expect(qncFigure(tree)).toBe('1');
    expect(transitLine(tree)).toBe(null);
    await moved(tree);
    // The Node tab: Moving 4 QNC, the button off, the rest of the balance (0) — never the 4 QNC again.
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
    expect(moveButton(tree).props.disabled).toBe(true);
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    // Assets: the QNC figure alone, never the amount in transit (owner, 14.10: History says Moving).
    await tab(tree, 'assets');
    expect(transitLine(tree)).toBe(null);
    expect(qncFigure(tree)).toBe('1');
    // The live figure with the watermark at the batch's last epoch holds the amount: the move ends in the same update,
    // while the certified read still shows the state before it. One genesis node still lags behind the move (the old
    // 4 QNC unclaimed): its answer no longer counts; the others applied the whole move and answer as the node does.
    mockState.live = liveAt(5, 103);
    mockState.pending = (n) => (n % 3 === 1 ? BEFORE() : APPLIED());
    await pull(tree);
    expect(qncFigure(tree)).toBe('5');
    expect(transitLine(tree)).toBe(null);
    await tab(tree, 'node');
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    expect(textOf(moveButton(tree).findByType(Text))).toBe(t('node_move'));
    // Every later read keeps judging by the wallet's watermark (103, the live one): a pull while that node still lags
    // never brings the moved amount back, not even when it is the only one to answer.
    mockState.pending = () => BEFORE();
    await pull(tree);
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    expect(texts(tree)).not.toContain(`${t('node_balance')}\n4 QNC`);
    // The record stays for the certified read, which settles it later in the background and changes nothing on screen.
    expect(JSON.parse(await AsyncStorage.getItem('qnet_claim_transit_v1')).wallets[mockQNET].moves).toHaveLength(1);
    mockState.qnc = certified(5, 103);
    await tab(tree, 'assets');
    await pull(tree);
    const kept = JSON.parse(await AsyncStorage.getItem('qnet_claim_transit_v1')).wallets[mockQNET];
    expect([kept.moves, kept.floor, 'liveLce' in kept]).toEqual([[], 103, false]); // the live watermark is never written
    await tab(tree, 'node');
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
  });

  it('the Assets tab over the move\'s result dismisses it as its Done does: the node balance is read again', async () => {
    const tree = await unlocked();
    await tab(tree, 'node');
    await act(async () => { await moveButton(tree).props.onPress(); });
    await flush(8);
    expect(texts(tree)).toContain(t('claim_submitted_title'));
    const { checkServerNodeStatus } = require('../src/services/PushService');
    const before = checkServerNodeStatus.mock.calls.length;
    await tab(tree, 'assets');
    expect(texts(tree)).not.toContain(t('claim_submitted_title'));
    expect(checkServerNodeStatus.mock.calls.length).toBeGreaterThan(before);
  });

  // Before, a move ended only by a certified read the Assets tab ran: a user who stayed on the Node tab never saw it end.
  it('ends by the live figure wherever the user stays: it is read every 15 seconds while a move is in transit', async () => {
    const tree = await unlocked();
    await moved(tree);
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
    mockState.live = liveAt(5, 103);
    mockState.pending = () => APPLIED();
    const reads = mockState.liveReads;
    const qncReads = mockState.qncReads;
    await transitTick();
    expect(mockState.liveReads).toBeGreaterThan(reads);
    expect(mockState.qncReads).toBe(qncReads); // a light read: no certified read for it
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    // Long after, back in the app: still the balance the move left.
    clock.offset = 70 * 60_000;
    await resume();
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
  });

  it('back in the app with the Node tab open, the wallet is read for the move', async () => {
    const tree = await unlocked();
    await moved(tree);
    mockState.live = liveAt(5, 103);
    mockState.pending = () => APPLIED();
    await resume();
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    await tab(tree, 'assets');
    expect(qncFigure(tree)).toBe('5');
    expect(transitLine(tree)).toBe(null);
  });

  it('its History row says Moving while it is in transit, and Confirmed once the live figure shows it', async () => {
    const tree = await unlocked();
    await moved(tree);
    mockState.claimListed = true;
    await tab(tree, 'history');
    expect(historyMoving(tree)).toBe(1);
    mockState.live = liveAt(5, 103);
    mockState.pending = () => APPLIED();
    await transitTick();
    expect(historyMoving(tree)).toBe(0);
  });

  // Before, the card said "Credited once confirmed." whatever happened after; nothing followed the claim's hash.
  it('the card follows the claim by its hash and says the amount is in the wallet once the live figure shows it', async () => {
    mockState.nodes = ['https://node.invalid'];
    const tree = await unlocked();
    await tab(tree, 'node');
    await act(async () => { await moveButton(tree).props.onPress(); });
    await flush(8);
    expect(texts(tree)).toContain(t('claim_credited_on_block'));
    // The card says the move's state at the top (Moving, then Confirmed), and on its details' card where the amount came
    // from and, once known, its block.
    const status = () => tree.root.findAll((n) => n.type === Text && /^tx-result-status-/.test(n.props.testID || ''))
      .map((n) => [n.props.testID, textOf(n)]);
    const card = () => tree.root.find((n) => n.props.testID === 'tx-result-details' && typeof n.type === 'string')
      .findAllByType(Text).map(textOf);
    expect(status()).toEqual([['tx-result-status-moving', t('hist_status_moving')]]);
    expect(card()).toEqual(expect.arrayContaining([t('tx_detail_from'), t('tx_detail_from_node_balance'), t('tx_label')]));
    expect(card()).not.toContain('9099');
    // A genesis node has the claim in a block, and the live figure read at once holds it.
    mockState.claimInBlock = 9099;
    mockState.live = liveAt(5, 103);
    mockState.pending = () => APPLIED();
    await followTick();
    expect(texts(tree)).toContain(t('claim_note_done'));
    expect(texts(tree)).not.toContain(t('claim_credited_on_block'));
    expect(status()).toEqual([['tx-result-status-confirmed', t('hist_status_confirmed')]]);
    expect(card()).toEqual(expect.arrayContaining([t('tx_detail_block'), '9099']));
  });

  // Before, the Node tab's card wrote the amount moved to four decimals, while the QNet Link sheet wrote it exact.
  it('the card writes the amount moved exact to the nano, as the QNet Link sheet does', async () => {
    mockState.claimResult = { ...mockState.claimResult, amount: 1.234567891, amountNano: '1234567891' };
    const tree = await unlocked();
    await tab(tree, 'node');
    await act(async () => { await moveButton(tree).props.onPress(); });
    await flush(8);
    const amount = tree.root.findAll((n) => n.type === Text && [].concat(n.props.style).includes(styles.txResultAmount));
    expect(amount.map(textOf)).toEqual(['1.234567891 QNC']);
    expect(texts(tree)).toContain(t('node_moving', { amount: '1.234567891 QNC' }));
  });

  it('kept across a restart of the app: the next session still shows it in transit', async () => {
    let tree = await unlocked();
    await moved(tree);
    await act(async () => { mounted.pop().unmount(); });
    tree = await unlocked();
    await tab(tree, 'node');
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
  });

  // Before, 35 minutes on, the wallet asked three genesis nodes' live state and said the move did not go through when
  // most still held the batch: a verdict nothing on chain gave, on a transaction with no consensus expiry that can still
  // be included later. Only a watermark that shows it ends it, however long that takes.
  it('however long no figure shows it, and whatever the nodes say of the node balance, it stays in transit', async () => {
    const since = AppState.addEventListener.mock.calls.length; // this screen's listeners, not an earlier test's
    const tree = await unlocked();
    await moved(tree);
    mockState.live = liveAt(1, 100); // the live tip before the claim is in a block
    for (const [offset, pending] of [[36 * 60_000, BEFORE], [6 * 3600_000, APPLIED], [26 * 3600_000, BEFORE]]) {
      mockState.pending = pending;
      clock.offset = offset;
      const asked = mockState.pendingCalls;
      await tab(tree, 'assets');
      await pull(tree);
      expect(transitLine(tree)).toBe(null);
      expect(qncFigure(tree)).toBe('1');
      await tab(tree, 'node');
      await transitTick();
      await resume(since);
      expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
      expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
      expect(moveButton(tree).props.disabled).toBe(true);
      // No node is asked of the move's fate: the node balance is not even read while it is in transit.
      expect(mockState.pendingCalls).toBe(asked);
    }
    // The figure that shows it, however late: it went through.
    mockState.live = liveAt(5, 103, 9200);
    mockState.pending = () => APPLIED();
    await transitTick();
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
    await tab(tree, 'assets');
    expect(qncFigure(tree)).toBe('5');
    expect(transitLine(tree)).toBe(null);
  });

  // Before, the live watermark was written to the device and only ever raised: one genesis node's live answer of a
  // branch the chain left ended the move for good, and judged every node balance answer after it.
  it('a certified read of the live figure\'s height or later that shows less puts the move back in transit', async () => {
    const tree = await unlocked();
    await moved(tree);
    mockState.live = liveAt(5, 103, 9100);
    mockState.pending = () => APPLIED();
    await transitTick();
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    expect(JSON.parse(await AsyncStorage.getItem('qnet_claim_transit_v1')).wallets[mockQNET]).not.toHaveProperty('liveLce');
    // A certified state older than that figure only lags: the move stays ended.
    mockState.qnc = certified(1, 100);
    await tab(tree, 'assets');
    await pull(tree);
    await tab(tree, 'node');
    expect(texts(tree)).not.toContain(t('node_moving', { amount: '4 QNC' }));
    // One of that figure's height or later still at 100: that figure was of a branch the chain left.
    mockState.qnc = { ...certified(1, 100), blockHeight: 9180 };
    mockState.live = liveAt(1, 100, 9180);
    await tab(tree, 'assets');
    await pull(tree);
    await tab(tree, 'node');
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
    expect(moveButton(tree).props.disabled).toBe(true);
  });

  it('a second move of the node waits for the one in transit', async () => {
    const tree = await unlocked();
    await moved(tree);
    await act(async () => { await moveButton(tree).props.onPress(); });
    await flush(4);
    expect(mockState.claims).toHaveLength(1);
  });

  // Every tab opens its first page: a tab pressed again does not leave the move's card up over its page.
  it('the Node tab over the move\'s result opens the Node page; the card goes as its Done makes it go', async () => {
    const tree = await unlocked();
    await tab(tree, 'node');
    await act(async () => { await moveButton(tree).props.onPress(); });
    await flush(8);
    expect(texts(tree)).toContain(t('claim_submitted_title'));
    const { checkServerNodeStatus } = require('../src/services/PushService');
    const before = checkServerNodeStatus.mock.calls.length;
    await tab(tree, 'node');
    expect(texts(tree)).not.toContain(t('claim_submitted_title'));
    expect(texts(tree)).toContain(t('node_moving', { amount: '4 QNC' }));
    expect(checkServerNodeStatus.mock.calls.length).toBeGreaterThan(before);
  });
});

// One press moves the balance shown, each part once the one before is in the wallet: a claim holds one quote, which
// stops at 512 epochs or 128 KiB of proofs (rewards_api.rs).
describe('Move to wallet in one press', () => {
  const shown = (nano) => () => ({ success: true, pendingRewards: nano, firstUnclaimedEpoch: 101 });
  const cardAmount = (tree) => tree.root.findAll((n) => n.type === Text && [].concat(n.props.style).includes(styles.txResultAmount)).map(textOf);
  // The value of the card's Transactions row, or null without one.
  const partsRow = (tree) => tree.root.findAll((n) => n.type === Text && n.props.testID === 'tx-result-parts').map(textOf)[0] ?? null;
  const status = (tree) => tree.root.findAll((n) => n.type === Text && /^tx-result-status-/.test(n.props.testID || '')).map((n) => n.props.testID);
  // The press, not awaited: a move in parts runs on while each part waits for the live figure the test gives it.
  const press = async (tree) => {
    await tab(tree, 'node');
    await act(async () => { moveButton(tree).props.onPress(); });
    await flush(8);
  };

  it('two parts: the second goes once the first is in the wallet, from its last epoch; one card says the total and the count', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'quote_byte_budget'), part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await press(tree);
    // The first part, checked against the balance shown; the card says the next one follows, no prompt between them.
    expect(mockState.claims.map((c) => c.balanceNano)).toEqual([5e9]);
    expect([cardAmount(tree), partsRow(tree), status(tree)]).toEqual([['3 QNC'], '1', ['tx-result-status-moving']]);
    expect(texts(tree)).toContain(t('claim_parts_next'));
    // While a part waits for its block, the background downloads go on: only a claim being signed and sent holds them.
    let free = false;
    require('../src/utils/userAction').afterUserActions().then(() => { free = true; });
    await flush(2);
    expect(free).toBe(true);
    // Not before the first is in the wallet.
    mockState.live = liveAt(1, 100);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect([mockState.claims.length, mockState.afters, mockState.claims[1].balanceNano]).toEqual([2, [null, 612], null]);
    expect([cardAmount(tree), partsRow(tree)]).toEqual([['5 QNC'], '2']);
    expect(texts(tree)).toContain(t('claim_credited_on_block'));
    mockState.live = liveAt(6, 700);
    mockState.pending = () => APPLIED();
    await transitTick();
    expect([texts(tree).includes(t('claim_note_done')), status(tree)]).toEqual([true, ['tx-result-status-confirmed']]);
    expect(mockState.claims).toHaveLength(2);
  });

  it('three parts, the card dismissed after the first: the run goes on and every part goes from the one before', async () => {
    mockState.pending = shown(9e9);
    mockState.claimResults = [
      part('3000000000', 100, 612, H1, 'batch_full'), part('3000000000', 612, 1124, H2, 'batch_full'), part('3000000000', 1124, 1300, H3),
    ];
    const tree = await unlocked();
    await press(tree);
    await pressText(tree, t('common_done'));
    mockState.live = liveAt(4, 612);
    await transitTick();
    mockState.live = liveAt(7, 1124);
    await transitTick();
    expect(mockState.afters).toEqual([null, 612, 1124]);
    expect(texts(tree)).toContain(t('node_moving', { amount: '3 QNC' }));
    // A part that went through is said nowhere twice: no card came back for it.
    expect(texts(tree)).not.toContain(t('claim_submitted_title'));
    mockState.live = liveAt(10, 1300);
    mockState.pending = () => APPLIED();
    await transitTick();
    expect(mockState.claims).toHaveLength(3);
    expect(texts(tree)).toContain(`${t('node_balance')}\n0 QNC`);
  });

  it('a second part the network refused: the card says what is in the wallet, that the rest stays, and why', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('refused'), { code: 'RATE_LIMITED' })];
    const tree = await unlocked();
    await press(tree);
    // Dismissed meanwhile: a part that was not sent brings the card back, so it is said.
    await pressText(tree, t('common_done'));
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect(mockState.claims).toHaveLength(2);
    expect(texts(tree)).toContain(`${t('claim_note_partial', { amount: '3 QNC' })} ${t('err_RATE_LIMITED')}`);
    expect([cardAmount(tree), partsRow(tree), status(tree)]).toEqual([['3 QNC'], '1', ['tx-result-status-confirmed']]);
    // The button is free again for the rest.
    await pressText(tree, t('common_done'));
    expect(moveButton(tree).props.disabled).toBe(false);
  });

  it('nothing left for the next part is the whole balance moved; a second part nobody answered may have gone', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('5000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('none'), { code: 'NO_REWARDS' })];
    let tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(6, 612);
    await transitTick();
    expect(texts(tree)).toContain(t('claim_note_done'));
    expect(texts(tree)).not.toContain(t('claim_note_partial', { amount: '5 QNC' }));
    await act(async () => { mounted.pop().unmount(); });
    await AsyncStorage.removeItem('qnet_claim_transit_v1');
    Object.assign(mockState, { claims: [], afters: [], live: null, pending: shown(5e9) });
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('late'), { unknown: true })];
    tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect(texts(tree)).toContain(`${t('claim_parts_in_wallet', { amount: '3 QNC' })} ${t('claim_note_unknown')}`);
  });

  // A run that left nothing to quote names no stop on its card, so a part put back in transit (a certified read that
  // shows less) never reads as a rest left on the node.
  it('the card of a run that left nothing to quote speaks of no stop, its part back in transit too', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('none'), { code: 'NO_REWARDS' })];
    const tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect([mockState.claims.length, texts(tree).includes(t('claim_note_done'))]).toEqual([2, true]);
    // The foreground follow's certified read (WalletScreen FOLLOW_MS) of the live figure's height still at 100: that
    // figure was of a branch the chain left, so the part is in transit again.
    mockState.follow = { ok: true, verified: true, balance: { ...certified(1, 100), blockHeight: 9180 } };
    const round = global.setInterval.mock.calls.filter((c) => c[1] === 90_000).pop();
    await act(async () => { round[0](); });
    await flush(8);
    expect(texts(tree)).toContain(t('claim_credited_on_block'));
    expect(texts(tree)).not.toContain(t('claim_stopped_at', { epoch: 613 }));
  });

  // Hide balances masks every amount the card shows, its note's too.
  it('with balances hidden, the card\'s note says what is in the wallet masked', async () => {
    const { MASK } = require('../src/utils/amountFormat');
    await AsyncStorage.setItem('qnet_hide_balances', '1');
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('refused'), { code: 'RATE_LIMITED' })];
    const tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect(texts(tree)).toContain(`${t('claim_note_partial', { amount: MASK })} ${t('err_RATE_LIMITED')}`);
    expect(texts(tree)).not.toContain('3 QNC');
  });

  it('a part holds the background verification while it is sent, not while it waits for its block', async () => {
    let release;
    mockState.claimGate = new Promise((r) => { release = r; });
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await press(tree);
    expect([mockState.claims.length, await networkFree()]).toEqual([1, false]);
    await act(async () => { release(); });
    await flush(8);
    expect([texts(tree).includes(t('claim_parts_next')), await networkFree()]).toEqual([true, true]);
  });

  it('a second press before the screen draws again starts nothing: one run, one card', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await tab(tree, 'node');
    await act(async () => { const b = moveButton(tree); b.props.onPress(); b.props.onPress(); });
    await flush(8);
    expect(mockState.claims).toHaveLength(1);
    expect(texts(tree)).toContain(t('claim_parts_next'));
  });

  it('a part no block took by its last height ends the run, and its card comes back to say the whole of it stays', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [{ ...part('3000000000', 100, 612, H1, 'batch_full'), validUntil: 9150 }, part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await press(tree);
    await pressText(tree, t('common_done'));
    mockState.live = liveAt(1, 100, 9200);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
    expect(texts(tree)).toContain(t('claim_note_expired'));
    expect(status(tree)).toEqual(['tx-result-status-failed']);
    // The amount that stays on the node, and the hash no block holds, which has no explorer page.
    expect([cardAmount(tree), texts(tree).includes(H1), !!explorerAction(tree)]).toEqual([['3 QNC'], true, false]);
  });

  // A part the run waited for that no block took by its last height: the card counts and names the parts before it, as
  // the QNet Link answer does, and its explorer opens the last one a block holds.
  it('a second part no block took by its last height: the card says the first part\'s amount, hash and explorer page', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      mockState.pending = shown(9e9);
      mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'),
        { ...part('2000000000', 612, 700, H2, 'batch_full'), validUntil: 9150 }, part('4000000000', 700, 900, H3)];
      const tree = await unlocked();
      await press(tree);
      mockState.live = liveAt(4, 612);
      await transitTick();
      expect([mockState.claims.length, cardAmount(tree), partsRow(tree)]).toEqual([2, ['5 QNC'], '2']);
      // A figure of a block past its last height with the watermark still at its start: it expired.
      mockState.live = liveAt(4, 612, 9200);
      await transitTick();
      expect([mockState.claims.length, cardAmount(tree), partsRow(tree), status(tree)])
        .toEqual([2, ['3 QNC'], '2', ['tx-result-status-confirmed']]);
      expect(texts(tree)).toContain(t('claim_note_partial', { amount: '3 QNC' }));
      expect([texts(tree).includes(H1), texts(tree).includes(H2)]).toEqual([true, false]);
      await act(async () => { explorerAction(tree).props.onPress(); });
      expect(open).toHaveBeenCalledWith(require('../src/config/nodes').explorerTxUrl(H1));
    } finally {
      open.mockRestore();
    }
  });

  // The last part, which the run did not wait for, expires after the run ended: the card's amount and hash follow its
  // record, as its status and note do.
  it('a last part no block took after the run ended: the card counts the parts before it, as its note says', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), { ...part('2000000000', 612, 700, H2), validUntil: 9150 }];
    const tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect([mockState.claims.length, cardAmount(tree), status(tree)]).toEqual([2, ['5 QNC'], ['tx-result-status-moving']]);
    mockState.live = liveAt(4, 612, 9200);
    await transitTick();
    expect([cardAmount(tree), status(tree)]).toEqual([['3 QNC'], ['tx-result-status-confirmed']]);
    expect(texts(tree)).toContain(t('claim_note_partial', { amount: '3 QNC' }));
    expect([texts(tree).includes(H1), texts(tree).includes(H2), !!explorerAction(tree)]).toEqual([true, false, true]);
  });

  it('a quote that stopped at an epoch the nodes cannot serve moves that part alone and keeps its honest note', async () => {
    mockState.pending = shown(5e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'root_not_here'), part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await press(tree);
    expect([texts(tree).includes(t('claim_stopped_at')), partsRow(tree)]).toEqual([true, null]);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
    expect(texts(tree)).toContain(t('claim_note_done'));
  });

  it('the run ends with the balance shown: a part that covers it moves no further, whatever its quote stopped at', async () => {
    mockState.pending = shown(3e9);
    mockState.claimResults = [part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)];
    const tree = await unlocked();
    await press(tree);
    mockState.live = liveAt(4, 612);
    await transitTick();
    expect(mockState.claims).toHaveLength(1);
    expect(partsRow(tree)).toBe(null);
  });
});

// Before, received QNC said "Not credited yet" until the certified read covered its block, while Assets already showed
// the money (the live figure).
describe('received QNC in History (owner, 18.10)', () => {
  const badges = (tree, status) => tree.root.findAll((n) => n.type === Text && n.props.testID === `history-badge-${status}`).length;
  // A transfer to the wallet in block 9150, listed alike by two genesis nodes.
  const receivedIn9150 = () => {
    const { listingKeysOfNodeRow } = require('../src/utils/txHistory');
    mockState.received = { hash: 'cd'.repeat(32), tx_type: 'Transfer', from: 'e'.repeat(45), to: mockQNET, amount: 2e9,
      timestamp: 1791000000, fee: 0, block_height: 9150 };
    mockState.listed = new Set(listingKeysOfNodeRow({ ...mockState.received, type: 'transfer' }));
  };

  it('is in the balance once the wallet\'s live figure covers its block; the History read asks for that figure', async () => {
    receivedIn9150();
    const tree = await unlocked();
    await tab(tree, 'history');
    // In a block as two genesis nodes list it; the certified read covers 9000 only.
    expect(badges(tree, 'included')).toBe(1);
    mockState.live = liveAt(3, 100, 9160);
    const reads = mockState.liveReads;
    await pull(tree);
    expect(mockState.liveReads).toBeGreaterThan(reads);
    expect([badges(tree, 'included'), badges(tree, 'pending'), badges(tree, 'unverified')]).toEqual([0, 0, 0]);
  });

  // A send of this wallet no source lists yet is asked about by its nonce only once the read's rows are on screen: a nonce
  // read that has not answered holds back neither a received transfer nor the live figure, and is asked once at a time.
  it('a pending send whose nonce read has not answered holds back no row; its answer goes on its row when it comes', async () => {
    const HistoryCache = require('../src/services/HistoryCache');
    const other = 'e'.repeat(45);
    const sent = { hash: 'ef'.repeat(32), from: mockQNET, to: other, amount: 1, fee: 0.0001, status: 'pending', timestamp: Date.now() - 60_000,
      type: 'send', settle: { from: mockQNET, nonce: 4, kind: 'transfer', to: other, amountNano: '1000000000' } };
    let answer;
    mockState.nonceAnswer = new Promise((resolve) => { answer = resolve; });
    HistoryCache.loadCachedHistory.mockImplementation(async () => [sent]);
    try {
      const tree = await unlocked();
      // A transfer to the wallet comes in while the send waits for its answer.
      receivedIn9150();
      const reads = mockState.liveReads;
      await tab(tree, 'history');
      expect([badges(tree, 'included'), badges(tree, 'pending')]).toEqual([1, 1]);
      expect(mockState.liveReads).toBeGreaterThan(reads);
      await pull(tree);
      expect(mockState.nonceAsks).toBe(1);
      // The chain's height passed its last height with its nonce free.
      await act(async () => { answer({ landed: false, known: true, expired: true }); });
      await flush(8);
      expect([badges(tree, 'included'), badges(tree, 'pending'), badges(tree, 'expired')]).toEqual([1, 0, 1]);
    } finally {
      HistoryCache.loadCachedHistory.mockImplementation(async () => []);
    }
  });

  // Before, one live answer naming a block far ahead counted every received transfer in the balance for the session.
  it('a live figure of a block the chain has not reached counts nothing in the balance', async () => {
    receivedIn9150();
    mockState.tip = 9200;
    const tree = await unlocked();
    await tab(tree, 'history');
    expect(badges(tree, 'included')).toBe(1);
    mockState.live = liveAt(3, 100, 900_000_000);
    await pull(tree);
    expect(badges(tree, 'included')).toBe(1);
    mockState.live = liveAt(3, 100, 9160);
    await pull(tree);
    expect(badges(tree, 'included')).toBe(0);
  });
});

// Before, a node being linked was read again only every 5 minutes (NODE_STATUS_MS) while the tab said "linking", and
// the registration in the pool went unsaid.
describe('a light node being linked (owner, 18.10)', () => {
  it('its status is read every 10 s for two minutes after the link, then every minute, and the pool is named', async () => {
    const LightNode = require('../src/services/LightNode');
    const linkedAt = Date.now();
    mockState.node = { nodeType: 'light', pseudonym: mockLIGHT };
    LightNode.readLinkPending.mockImplementation(async () => ({ nodeId: mockLIGHT, T: Math.floor(linkedAt / 1000), createdAt: linkedAt, expired: false }));
    LightNode.readNodeStatus.mockImplementation(async () => ({
      reachable: true, onChain: false, registrationPending: true, deviceBound: null, deviceBoundAgreed: null, answered: null,
      needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null,
    }));
    try {
      const tree = await unlocked();
      await tab(tree, 'node');
      expect(texts(tree)).toContain(t('node_linking_pool'));
      const soon = global.setTimeout.mock.calls.filter((c) => c[1] === 10_000).pop();
      expect(soon).toBeDefined();
      const reads = LightNode.readNodeStatus.mock.calls.length;
      clock.offset = 3 * 60_000; // past the first two minutes
      await fireTimeout(soon);
      expect(LightNode.readNodeStatus.mock.calls.length).toBeGreaterThan(reads);
      expect(global.setTimeout.mock.calls.filter((c) => c[1] === 60_000).length).toBeGreaterThan(0);
    } finally {
      LightNode.readLinkPending.mockImplementation(async () => null);
      LightNode.readNodeStatus.mockImplementation(async () => ({
        reachable: true, onChain: false, registrationPending: false, deviceBound: null, deviceBoundAgreed: null, answered: null,
        needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null,
      }));
    }
  });
});

describe('a move from a QNet Link claim sheet is in transit as one from the Node tab', () => {
  it('the sheet\'s actions run the screen\'s move, each part in transit, and wait while one is in transit', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    // The sheet moves only the wallet's own nodes: the ids derived from its address.
    const { lightNodeId } = require('../src/crypto/NodePreimages');
    const light = lightNodeId(mockQNET);
    const result = { success: true, amount: 2, amountNano: '2000000000', prevWatermark: 7, lastEpoch: 9, txHash: mockHASH };
    const walletManager = { claimRewards: jest.fn(async () => result) };
    // The screen's run (WalletScreen startMove; through the screen: LinkClaimRun.test.js), its parts put in transit.
    const record = jest.fn(() => true);
    const run = require('../test-support/moveRun').sheetMove(walletManager, { walletAddress: mockQNET, credential: 'pw', record });
    const onMoved = jest.fn();
    let busy = false;
    const a = nodeLinkActions({ walletManager, credential: 'pw', claimBusy: () => busy || run.claimBusy(), move: run.move, onMoved });
    const r = await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 2_500_000_000 });
    expect([r.status, r.amountNano, r.txHash, r.stoppedAtEpoch]).toEqual(['ok', '2000000000', mockHASH, null]);
    expect(record).toHaveBeenCalledWith(light, result, 2_500_000_000);
    expect(onMoved).toHaveBeenCalledTimes(1);
    busy = true;
    expect(a.claimBusy()).toBe(true);
    expect(await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    // A refusal moves nothing, and the screen reads nothing for it.
    busy = false;
    walletManager.claimRewards.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'NO_REWARDS' }));
    onMoved.mockClear();
    expect(await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 1 })).toEqual({ status: 'empty' });
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('the sheet\'s node balance counts only nodes not behind the wallet\'s certified watermark', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    let floor = null;
    const a = nodeLinkActions({ walletManager: {}, credential: 'pw', claimFloor: () => floor });
    mockState.pending = (n) => (n % 3 === 1 ? BEFORE() : APPLIED());
    expect(await a.balance(mockLIGHT)).toBe(4e9); // no certified watermark known: the largest answer
    floor = 103;
    expect(await a.balance(mockLIGHT)).toBe(0);
    mockState.pending = () => BEFORE();
    expect(await a.balance(mockLIGHT)).toBe(null); // only nodes behind it answered: no figure, never the moved amount
  });
});

// Owner, 11.10: a 0 is shown only when a node answered it or a proof folded to it. Before, an added token whose read
// failed showed 0, and one that showed a figure flipped to 0 on a failed read and back.
describe('an added token whose read failed is never a 0 nobody read (owner, 11.10)', () => {
  const amounts = (tree) => tree.root.findAll((n) => n.type === Text && n.props.style === styles.tokenAmount).map(textOf);
  it('a dash while nothing was read, then the figure read, kept through a failed read', async () => {
    await AsyncStorage.setItem('qnet_custom_tokens', JSON.stringify([{ contract_address: 'c'.repeat(64), symbol: 'TKN', name: 'Token', decimals: 2 }]));
    mockState.tokenBalance = { balance: null };
    const tree = await unlocked();
    expect(amounts(tree)).toEqual(['1', '—']);
    mockState.tokenBalance = { balance: '12.5' };
    await pull(tree);
    expect(amounts(tree)).toEqual(['1', '12.5']);
    mockState.tokenBalance = { balance: null };
    await pull(tree);
    expect(amounts(tree)).toEqual(['1', '12.5']);
    // A 0 that was read is a 0.
    mockState.tokenBalance = { balance: '0' };
    await pull(tree);
    expect(amounts(tree)).toEqual(['1', '0']);
  });

  // Before, every token load rebuilt the row from one node's holdings answer: the figure after a send, proven for block
  // 9200, went back to the holdings figure of before it, and a live figure a block behind could not correct it.
  it('a figure proven for a state stays through a holdings answer from before it and a live figure a block behind', async () => {
    const contract = 'c'.repeat(64);
    await AsyncStorage.setItem('qnet_custom_tokens', JSON.stringify([{ contract_address: contract, symbol: 'TKN', name: 'Token', decimals: 2 }]));
    mockState.holdings = [{ contract, name: 'Token', symbol: 'TKN', decimals: 2, logo: '', balance: '10', balanceBase: '1000' }];
    mockState.liveToken = { balanceBase: '750', balance: '7.5', blockHeight: 9200 };
    const tree = await unlocked();
    expect(amounts(tree)).toEqual(['1', '7.5']);
    mockState.liveToken = { balanceBase: '1000', balance: '10', blockHeight: 9199 };
    await pull(tree);
    expect(amounts(tree)).toEqual(['1', '7.5']);
    // A figure of a newer state replaces it.
    mockState.liveToken = { balanceBase: '700', balance: '7', blockHeight: 9201 };
    await pull(tree);
    expect(amounts(tree)).toEqual(['1', '7']);
  });
});

describe('a super node registered and not admitted to consensus yet (owner, 11.10)', () => {
  it('says it is registered and not admitted to consensus yet, never Offline, and its balance moves', async () => {
    Object.assign(mockState, { online: false, admission: 'waiting' });
    const tree = await unlocked();
    await tab(tree, 'node');
    const text = texts(tree);
    expect(text).toContain(t('node_waiting_admission'));
    // Said once, as the node's status in Ember under its identity.
    expect(tree.root.findAll((n) => n.props.testID === 'node-status' && n.props.tone === 'needs'
      && n.props.label === t('node_waiting_admission'))).toHaveLength(1);
    expect(text).not.toContain(t('node_server_offline'));
    expect(text).not.toContain(t('node_status_offline'));
    expect(moveButton(tree).props.disabled).toBe(false);
  });
});

describe('deleting the wallet says first that its node stops on this device (owner, 11.10)', () => {
  const deleteAlert = async (tree) => {
    await tab(tree, 'settings');
    await pressText(tree, t('delete_wallet'));
    return texts(tree);
  };

  it('with this wallet\'s node bound here: the one sentence, then the confirmation; cancel keeps everything', async () => {
    mockState.bound = true;
    const tree = await unlocked();
    const text = await deleteAlert(tree);
    expect(text).toContain(`${t('node_stops_here')}\n\n${t('delete_wallet_confirm')}`);
    await pressText(tree, t('cancel'));
    expect(require('../src/services/PushService').stopLightNode).not.toHaveBeenCalled();
  });

  it('with no node here: the confirmation alone', async () => {
    const tree = await unlocked();
    const text = await deleteAlert(tree);
    expect(text).toContain(t('delete_wallet_confirm'));
    expect(text).not.toContain(t('node_stops_here'));
  });

  // The erase screen (Forgot? Reset the wallet, on the lock screen) says the same when it opens.
  const eraseScreen = async () => {
    let tree;
    await act(async () => { tree = renderer.create(<WalletScreen />); });
    mounted.push(tree);
    await flush(6);
    await act(async () => { tree.root.find((n) => n.props.testID === 'unlock-forgot' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush(6);
    return tree;
  };

  it('"Forgot? Reset the wallet" sits in the lock column under the unlock, clear of the system bar, and a press opens the erase screen', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<WalletScreen />); });
    mounted.push(tree);
    await flush(6);
    const forgot = tree.root.find((n) => n.props.testID === 'unlock-forgot' && typeof n.props.onPress === 'function');
    const ancestors = [];
    for (let n = forgot.parent; n; n = n.parent) ancestors.push(n);
    expect(ancestors.some((n) => n.props.testID === 'lock-column')).toBe(true);
    expect(ancestors.find((n) => Array.isArray(n.props.edges)).props.edges).toContain('bottom');
    await act(async () => { forgot.props.onPress(); });
    await flush(6);
    expect(texts(tree)).toContain(t('erase_title'));
  });

  // The app's icon on the loading and lock screens with no name written under it: one mark, always in one place and of
  // one size (the launch screen's, at the window's centre), never at the foot on one screen and the middle on another;
  // the welcome screen writes "QNet Wallet" under it.
  it('every screen without data draws the one mark at the window\'s centre at the launch size; only the welcome names the app', async () => {
    const { Image } = require('react-native');
    const { START_MARK, START_MARK_SOURCE, START_EDGES, startStyles } = require('../src/components/ui/StartScreen');
    let tree;
    await act(async () => { tree = renderer.create(<WalletScreen />); });
    mounted.push(tree);
    await flush(6);
    // The lock screen: the mark and the unlock, no name.
    const mark = tree.root.find((n) => n.props.testID === 'start-mark' && typeof n.type === 'string');
    expect(StyleSheet.flatten(mark.props.style)).toMatchObject({
      position: 'absolute', top: '50%', height: START_MARK.box, marginTop: -START_MARK.box / 2, left: 0, right: 0, alignItems: 'center',
    });
    const [image] = mark.findAllByType(Image);
    expect(image.props.source).toBe(START_MARK_SOURCE);
    expect(StyleSheet.flatten(image.props.style)).toEqual({ width: START_MARK.box, height: START_MARK.box });
    expect(texts(tree)).not.toContain(t('qnet_wallet'));
    // The lock screen keeps the live field over its top half, as the welcome screen does.
    expect(tree.root.findAll((n) => n.props.testID === 'lock-column').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props.testID === 'hex-field' && typeof n.type === 'string')).toHaveLength(1);
    // The root the mark is placed in is the whole window (no padding), the column under it keeps clear of the bars.
    const root = tree.root.findAll((n) => Array.isArray(n.props.edges)).find((n) => n.props.edges === START_EDGES);
    expect(root).toBeDefined();
    expect(StyleSheet.flatten(startStyles.under).marginTop).toBe(START_MARK.drawn / 2 + 16);
    // The launch screen draws the same image, by the same name, at the same box, centred, on both platforms.
    expect(START_MARK_SOURCE).toEqual({ uri: 'splash_logo' });
    const story = read('ios/QNetMobile/LaunchScreen.storyboard');
    expect(story).toMatch(/image="splash_logo"/);
    expect(story.match(/firstAttribute="(width|height)" constant="192"/g)).toHaveLength(2);
    expect(story).toMatch(/firstAttribute="centerY" secondItem="Ze5-6b-2t3" secondAttribute="centerY"/);
    const set = JSON.parse(read('ios/QNetMobile/Images.xcassets/splash_logo.imageset/Contents.json'));
    expect(set.images.map((i) => i.scale)).toEqual(['1x', '2x', '3x']);
    for (const i of set.images) expect(fs.existsSync(path.join(__dirname, '..', 'ios/QNetMobile/Images.xcassets/splash_logo.imageset', i.filename))).toBe(true);
    expect(read('android/app/src/main/res/drawable/launch_screen.xml'))
      .toMatch(/android:width="192dp"\s+android:height="192dp"\s+android:drawable="@drawable\/splash_logo"\s+android:gravity="center"/);
    // Android 12 and later: the system splash shows that mark too, at 192 of its 288 dp canvas, on the same background.
    expect(read('android/app/src/main/res/drawable/splash_icon.xml')).toMatch(/android:drawable="@drawable\/splash_logo"\s+android:inset="48dp"/);
    const theme = read('android/app/src/main/res/values/styles.xml');
    expect(theme).toMatch(/<item name="android:windowSplashScreenAnimatedIcon" tools:targetApi="31">@drawable\/splash_icon<\/item>/);
    expect(theme).toMatch(/<item name="android:windowSplashScreenBackground" tools:targetApi="31">@color\/splash_background_color<\/item>/);
    // First read, loading, welcome and lock all draw it, and nothing else draws a mark of its own or moves this one.
    const src = read('src/screens/WalletScreen.js');
    expect(src.match(/<StartScreen[\s>]/g)).toHaveLength(4);
    expect(src.match(/edges=\{START_EDGES\}/g)).toHaveLength(4);
    // It takes no style: no screen can resize or move the mark.
    expect(read('src/components/ui/StartScreen.js')).toMatch(/export default function StartScreen\(\{ field = false, head = null, children = null, testID \}\)/);
    expect(src).not.toMatch(/AppMark|lockLogo|<HexField/);
    expect('lockLogo' in styles).toBe(false);
    expect('fieldColumn' in styles).toBe(false);
    // Only the welcome screen writes the name, in its own centred title; the lines under the mark are centred too.
    const starts = src.split('<StartScreen').slice(1).map((s) => s.slice(0, s.indexOf('</SafeAreaView>')));
    expect(starts.filter((s) => /t\('qnet_wallet'\)/.test(s))).toHaveLength(1);
    expect(starts.filter((s) => /t\('qnet_wallet'\)/.test(s))[0]).toMatch(/welcome_subtitle/);
    const lines = starts.flatMap((s) => s.match(/<Text style=\{\[?styles\.subtitle[^}]*\}/g) || []);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/style=\{\[styles\.subtitle, styles\.markLine\]\}/);
    expect(StyleSheet.flatten(styles.markLine)).toEqual({ textAlign: 'center', marginBottom: 16 });
  });

  // "QNet Wallet" on the welcome screen in the system face, bold, at 28 (styles `title`), in the accent colour, centred,
  // and the line "Get started with QNet Blockchain" under it.
  it('the welcome screen: the mark, "QNet Wallet" in the system face, bold, at 28 in Signal, centred, its line, then the two ways in', () => {
    const { color, setThemeLanguage } = require('../src/theme');
    const shown = StyleSheet.flatten(styles.welcomeTitle);
    expect(shown).toMatchObject({ fontSize: 28, fontWeight: '700', color: color.signal, textAlign: 'center' });
    expect([shown.fontFamily, shown.textTransform, shown.letterSpacing]).toEqual([undefined, undefined, undefined]);
    // The same face in every script.
    try {
      for (const lang of ['ru', 'ja', 'ar']) {
        setThemeLanguage(lang);
        expect([lang, StyleSheet.flatten(styles.welcomeTitle)]).toEqual([lang, shown]);
      }
    } finally {
      setThemeLanguage('en');
    }
    expect(t('welcome_subtitle')).toBe('Get started with QNet Blockchain');
    expect(makeT('ru')('welcome_subtitle')).toBe('Начните работу с QNet Blockchain');
    const src = read('src/screens/WalletScreen.js');
    const welcome = src.slice(src.indexOf('<StartScreen\n            field'), src.indexOf('</StartScreen>', src.indexOf('<StartScreen\n            field')));
    expect(welcome).toMatch(/<Text style=\{styles\.welcomeTitle\} accessibilityRole="header">\{t\('qnet_wallet'\)\}<\/Text>\s*<Text style=\{\[styles\.subtitle, styles\.markLine\]\}>\{t\('welcome_subtitle'\)\}<\/Text>/);
    expect(welcome.indexOf("t('create_new_wallet')")).toBeLessThan(welcome.indexOf("t('import_wallet')"));
    expect(welcome.indexOf('head={')).toBeLessThan(welcome.indexOf("t('create_new_wallet')"));
    // The whole of it fits under the mark on a 568 dp screen (the smallest phone), the two ways in at the foot.
    const { START_MARK, startStyles } = require('../src/components/ui/StartScreen');
    const { size } = require('../src/theme');
    const f = (s) => StyleSheet.flatten(s);
    const title = f(styles.welcomeTitle);
    const line = f([styles.subtitle, styles.markLine]);
    const need = title.lineHeight + title.marginBottom + line.lineHeight + line.marginBottom
      + size.button + f(styles.formAction).marginBottom + size.button + f(startStyles.column).paddingBottom;
    expect(need).toBeLessThanOrEqual(568 / 2 - f(startStyles.under).marginTop);
    expect(f(startStyles.under).marginTop).toBe(START_MARK.drawn / 2 + 16);
  });

  // No text over the mark on any screen without data (welcome, loading, deleting, lock), whatever the inset, text size
  // or keyboard: a column hung from half of the room would rise by half a bottom inset (under a 48 dp navigation bar,
  // 8 dp into the mark's outer ring).
  it('nothing under the mark reaches its rings: the column hangs from the mark\'s own line, START_GAP under the drawn ring', async () => {
    const { KeyboardAvoidingView, ScrollView } = require('react-native');
    const shots = require('../scripts/store-screenshots');
    const zlib = require('zlib');
    const { Buffer } = require('buffer');
    const StartScreen = require('../src/components/ui/StartScreen').default;
    const { START_MARK, START_GAP, startStyles } = require('../src/components/ui/StartScreen');
    let tree;
    await act(async () => {
      tree = renderer.create(<StartScreen field head={<Text>QNet Wallet</Text>}><Text>Unlock</Text></StartScreen>);
    });
    mounted.push(tree);
    const f = (n) => StyleSheet.flatten(n.props.style) || {};
    // The room is the root less an open keyboard (the forms' keyboard rule); the mark and the column's frame are both
    // placed in it from its middle, the frame running to its foot, so no inset or sibling shifts one against the other.
    const kav = tree.root.findByType(KeyboardAvoidingView);
    expect([kav.props.behavior, f(kav)]).toEqual(['padding', { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }]);
    const room = tree.root.find((n) => typeof n.type === 'string' && n.props.style === startStyles.room);
    expect(f(room)).toEqual({ flex: 1 });
    const mark = room.children.find((c) => c.props.testID === 'start-mark');
    const frame = room.children.find((c) => Array.isArray(c.props.edges));
    expect([f(mark).top, f(frame)]).toEqual(['50%', { position: 'absolute', top: '50%', bottom: 0, left: 0, right: 0 }]);
    // The column starts START_GAP under the drawn ring, and nothing in it is placed or pulled up out of its flow.
    const column = frame.findByType(ScrollView);
    expect(START_GAP).toBeGreaterThan(0);
    expect(f(column).marginTop).toBe(START_MARK.drawn / 2 + START_GAP);
    const pulled = column.findAll((n) => typeof n.type === 'string').filter((n) => {
      const st = f(n);
      return st.position === 'absolute' || st.transform
        || ['top', 'bottom', 'margin', 'marginTop', 'marginVertical'].some((k) => typeof st[k] === 'number' && st[k] < 0);
    });
    expect(pulled.map((n) => n.type)).toEqual([]);
    // START_MARK.drawn is the launch image's rings: every pixel at least half covered, in every density, lies inside it.
    const set = JSON.parse(read('ios/QNetMobile/Images.xcassets/splash_logo.imageset/Contents.json'));
    const bitmaps = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]
      .map(([d, k]) => [`android/app/src/main/res/drawable-${d}/splash_logo.png`, k])
      .concat(set.images.map((i) => [`ios/QNetMobile/Images.xcassets/splash_logo.imageset/${i.filename}`, parseInt(i.scale, 10)]));
    for (const [file, k] of bitmaps) {
      const png = fs.readFileSync(path.join(__dirname, '..', file));
      const info = shots.pngInfo(png);
      expect([file, info.colorType, info.bitDepth, info.interlace, info.width, info.height])
        .toEqual([file, 6, 8, 0, START_MARK.box * k, START_MARK.box * k]);
      const stride = info.width * 4;
      const raw = zlib.inflateSync(Buffer.concat(shots.pngChunks(png).filter((c) => c.type === 'IDAT').map((c) => c.data)));
      const c = info.width / 2;
      let prev = Buffer.alloc(stride);
      let reach = 0;
      for (let y = 0; y < info.height; y++) {
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        shots.unfilter(raw[y * (stride + 1)], line, prev, 4);
        for (let x = 0; x < info.width; x++) {
          if (line[x * 4 + 3] >= 128) reach = Math.max(reach, c - x, x + 1 - c, c - y, y + 1 - c);
        }
        prev = line;
      }
      expect([file, reach / k <= START_MARK.drawn / 2, reach / k > START_MARK.drawn / 2 - 1]).toEqual([file, true, true]);
    }
  });

  // Only a field of the screen's own column lifts the mark with its keyboard: a sheet's field over the screen (ERASE in
  // the erase sheet) leaves the room the mark is centred in as it is.
  it('a field of the column lifts the mark while it has focus, until it loses it or is gone; a field over it never', async () => {
    const { KeyboardAvoidingView, View } = require('react-native');
    const StartScreen = require('../src/components/ui/StartScreen').default;
    const { StartField } = require('../src/components/ui/StartScreen');
    const Field = require('../src/components/ui/Field').default;
    const screen = (own) => (
      <View>
        <StartScreen>{own ? <StartField placeholder="Password" /> : null}</StartScreen>
        <Field placeholder="ERASE" />
      </View>
    );
    let tree;
    await act(async () => { tree = renderer.create(screen(true)); });
    mounted.push(tree);
    const lift = () => tree.root.findByType(KeyboardAvoidingView).props.enabled;
    const input = (p) => tree.root.find((n) => n.type === TextInput && n.props.placeholder === p);
    expect(lift()).toBe(false);
    await act(async () => { input('ERASE').props.onFocus({}); });
    expect(lift()).toBe(false);
    await act(async () => { input('Password').props.onFocus({}); });
    expect(lift()).toBe(true);
    await act(async () => { input('Password').props.onBlur({}); });
    expect(lift()).toBe(false);
    // Gone while it had focus (a lockout puts its line in the field's place): the next keyboard lifts nothing.
    await act(async () => { input('Password').props.onFocus({}); });
    await act(async () => { tree.update(screen(false)); });
    expect(lift()).toBe(false);
  });

  it('the lock screen: its password lifts the mark with its keyboard; typing ERASE in the erase sheet over it moves nothing', async () => {
    const { KeyboardAvoidingView } = require('react-native');
    const { startStyles } = require('../src/components/ui/StartScreen');
    let tree;
    await act(async () => { tree = renderer.create(<WalletScreen />); });
    mounted.push(tree);
    await flush(6);
    const lift = () => tree.root.find((n) => n.type === KeyboardAvoidingView && n.props.style === startStyles.window).props.enabled;
    const input = (p) => tree.root.find((n) => n.type === TextInput && n.props.placeholder === p);
    expect(lift()).toBe(false);
    await act(async () => { input(t('enter_password')).props.onFocus({}); });
    expect(lift()).toBe(true);
    await act(async () => { input(t('enter_password')).props.onBlur({}); });
    await act(async () => { tree.root.find((n) => n.props.testID === 'unlock-forgot' && typeof n.props.onPress === 'function').props.onPress(); });
    await flush(6);
    await act(async () => { input('ERASE').props.onFocus({}); });
    await act(async () => { input('ERASE').props.onChangeText('ERASE'); });
    expect([texts(tree).includes(t('erase_title')), lift()]).toEqual([true, false]);
  });

  it('the erase screen with this wallet\'s node bound here says it stops; without one it does not', async () => {
    mockState.bound = true;
    let tree = await eraseScreen();
    expect(tree.root.findAll((n) => n.type === Text && n.props.testID === 'erase-node-here').map(textOf)).toEqual([t('node_stops_here')]);
    expect(texts(tree)).toContain(t('erase_title'));
    await act(async () => { mounted.pop().unmount(); });
    mockState.bound = false;
    tree = await eraseScreen();
    expect(texts(tree)).toContain(t('erase_title'));
    expect(tree.root.findAll((n) => n.type === Text && n.props.testID === 'erase-node-here')).toEqual([]);
  });

  // The screen that comes next says it is done: a notice over it only covered its own actions.
  it('a delete ends on the welcome screen and an erase on the import, with no notice over either', async () => {
    const Sheet = require('../src/components/ui/Sheet').default;
    const ending = (tree, title) => [texts(tree).includes(title), tree.root.findAllByType(Sheet).length];
    let tree = await unlocked();
    await tab(tree, 'settings');
    await pressText(tree, t('delete_wallet'));
    await pressText(tree, t('common_delete'));
    const password = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === t('password'))[0];
    await act(async () => { password.props.onChangeText('abcdefghijk'); });
    await pressText(tree, t('delete_wallet'));
    expect(require('../src/services/PushService').stopLightNode).toHaveBeenCalled();
    expect(ending(tree, t('create_new_wallet'))).toEqual([true, 0]);
    await act(async () => { mounted.pop().unmount(); });
    tree = await eraseScreen();
    const word = tree.root.findAll((n) => n.type === TextInput && n.props.placeholder === 'ERASE')[0];
    await act(async () => { word.props.onChangeText('ERASE'); });
    await pressText(tree, t('erase_button'));
    expect(ending(tree, t('import_title'))).toEqual([true, 0]);
  });
});

// The Node tab's title is pinned from the scroll view's very edge, so no band above it shows a section scrolled under it.
describe('the Node tab\'s title is pinned at the scroll view\'s edge', () => {
  it('the scroll\'s first child is pinned, its ink band from the scroll view\'s edge; the scroll pads no top; at rest it sits as every tab\'s title', async () => {
    const { ScrollView } = require('react-native');
    const { color, space } = require('../src/theme');
    const { headStyles } = require('../src/components/ui/Head');
    const tree = await unlocked();
    await tab(tree, 'node');
    const scroll = tree.root.findAllByType(ScrollView).find((n) => n.props.stickyHeaderIndices !== undefined);
    expect(scroll.props.stickyHeaderIndices).toEqual([0]);
    expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({ padding: space.gut, paddingTop: 0 });
    expect([].concat(scroll.props.children).filter(Boolean)[0].props.style).toBe(styles.stickyHead);
    expect(StyleSheet.flatten(styles.stickyHead)).toEqual({ backgroundColor: color.ink, paddingTop: space.gut });
    const pinned = scroll.findAll((n) => n.props.style === styles.stickyHead)[0];
    expect(pinned.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header').map(textOf)).toEqual([t('node_title')]);
    const above = (s) => StyleSheet.flatten(s).paddingTop + StyleSheet.flatten(headStyles.head).paddingTop;
    expect(above(styles.stickyHead)).toBe(StyleSheet.flatten(styles.content).padding + StyleSheet.flatten(headStyles.head).paddingTop);
    expect(above(styles.stickyHead)).toBe(32);
  });
});

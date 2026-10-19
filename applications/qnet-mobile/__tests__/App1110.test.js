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
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
const mockSUPER = 'super_node_5555666677778888';
const mockHASH = 'ab'.repeat(32);
const mockState = {};
// The claim transaction as a genesis node lists it in the wallet's history.
const mockClaimRow = { hash: mockHASH, tx_type: 'RewardDistribution', from: 'system_rewards_pool', to: mockQNET, amount: 4e9, timestamp: 1791000000, fee: 0 };

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
    getTrustedNodes() { return mockState.nodes || []; }
    trustedNodeUrl() { return 'https://node.invalid'; }
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
    // The wallet's figure at a genesis node's live tip: what the test says (none by default).
    async liveQncFigure() { mockState.liveReads += 1; return mockState.live || null; }
    async networkPause() { return null; }
    async claimRewards(nodeType, wallet, credential, balanceNano, nodeId) {
      mockState.claims.push({ nodeType, wallet, balanceNano, nodeId });
      return mockState.claimResult;
    }
    // One node's holdings answer and an added token's figure at a genesis node's live tip: what the test says.
    async getTokenHoldings() { return mockState.holdings || []; }
    async liveTokenFigure() { return mockState.liveToken || null; }
    _formatBaseUnits(base, decimals) { return require('../src/browser/dappRequests').formatUnits(base, decimals); }
    // An added token's balance read: what the test says (balance null: the read failed).
    async getTokenBalanceOf() { return mockState.tokenBalance || { balance: null }; }
    async loadNodeRecord() { return mockState.node; }
    async saveNodeRecord() {}
    async confirmServerNode() { return true; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return mockLIGHT; }
    generateSuperNodePseudonym() { return mockSUPER; }
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
  readNodeStatus: jest.fn(async () => ({
    reachable: true, onChain: false, registrationPending: false, deviceBound: null, deviceBoundAgreed: null, answered: null,
    needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null,
  })),
  readLinkPending: jest.fn(async () => null),
  dropLinkPending: jest.fn(async () => {}),
}));

jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => ({ capable: true, platform: 'android', flags: '', report: null })),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
}));

jest.mock('../src/services/PushService', () => ({
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  readdressIfOwed: jest.fn(async () => false),
  localBinding: jest.fn(async (id) => (mockState.bound && id === mockLIGHT ? { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm' } : null)),
  localNode: jest.fn(async () => (mockState.bound ? { nodeId: mockLIGHT, walletAddress: mockQNET } : null)),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  checkServerNodeStatus: jest.fn(async () => ({
    success: true, registered: true, nodeId: mockSUPER, nodeType: 'super', isOnline: mockState.online, lastSeen: 0,
    heartbeatCount: 0, requiredHeartbeats: 9, pendingRewards: 0, reputation: 70, consensusAdmitted: mockState.admitted,
  })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [{ nodeId: mockSUPER, nodeType: 'super', height: 5 }] })),
  getNodeEpochs: jest.fn(async () => null),
  // The node balance as each genesis answer gives it (mockState.pending: one call's answer, by its order).
  getPendingRewards: jest.fn(async () => { mockState.pendingCalls += 1; return mockState.pending(mockState.pendingCalls); }),
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

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('');
const texts = (tree) => tree.root.findAllByType(Text).map(textOf).join('\n');
const qncFigure = (tree) => textOf(tree.root.findAll((n) => n.type === Text && n.props.style === styles.tokenAmount)[0]);
const historyMoving = (tree) => tree.root.findAll((n) => n.type === Text && n.props.testID === 'history-badge-moving').length;
const transitLine = (tree) => {
  const line = tree.root.findAll((n) => n.type === Text && n.props.testID === 'qnc-transit');
  return line.length ? textOf(line[0]) : null;
};
const moveButton = (tree) => tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function')[0];
const pressText = async (tree, text) => {
  const target = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => textOf(x) === text)).pop();
  if (!target) throw new Error(`nothing to press labelled "${text}"`);
  await act(async () => { await target.props.onPress(); });
  await flush(8);
};
const tab = async (tree, name) => {
  await act(async () => { tree.root.find((n) => n.props.testID === `tab-${name}` && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(12);
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
// The live read the screen runs every 15 seconds while a move is in transit (requestPace LIVE_READ_MS), run now; not the
// kept-transaction sweep of the same pace.
const transitTick = async () => {
  const timer = global.setInterval.mock.calls.filter((c) => c[1] === 15_000 && c[0].name !== 'sweep').pop();
  if (!timer) throw new Error('no live read is scheduled');
  await act(async () => { timer[0](); });
  await flush(12);
};
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
    node: { nodeType: 'super', pseudonym: mockSUPER }, online: true, admitted: undefined, bound: false,
    qnc: certified(1, 100), qncReads: 0, claims: [], pendingCalls: 0, pending: BEFORE, claimListed: false, tokenBalance: null,
    live: null, liveReads: 0, nodes: [], claimInBlock: null, received: null, listed: null, holdings: null, liveToken: null, tip: null,
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

// The wallet's live figure (a genesis node's live tip, its proof folded) with its claim watermark.
const liveAt = (qnc, figureClaimedEpoch, blockHeight = 9100) => ({
  balance: qnc, balanceNano: String(Math.round(qnc * 1e9)), nonce: '3', blockHeight, figureClaimedEpoch,
});

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
    // A genesis node has the claim in a block, and the live figure read at once holds it.
    mockState.claimInBlock = 9099;
    mockState.live = liveAt(5, 103);
    mockState.pending = () => APPLIED();
    await followTick();
    expect(texts(tree)).toContain(t('claim_note_done'));
    expect(texts(tree)).not.toContain(t('claim_credited_on_block'));
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
  it('the sheet\'s actions hand the move to the screen once the network took it, and wait while one is in transit', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    // The sheet moves only the wallet's own nodes: the ids derived from its address.
    const { lightNodeId } = require('../src/crypto/NodePreimages');
    const light = lightNodeId(mockQNET);
    const result = { success: true, amount: 2, amountNano: '2000000000', prevWatermark: 7, lastEpoch: 9, txHash: mockHASH };
    const walletManager = { claimRewards: jest.fn(async () => result) };
    const onClaimed = jest.fn();
    let busy = false;
    const a = nodeLinkActions({ walletManager, credential: 'pw', claimBusy: () => busy, onClaimed });
    expect(await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 2_500_000_000 }))
      .toEqual({ status: 'ok', amountNano: '2000000000', txHash: mockHASH, stoppedAtEpoch: null });
    expect(onClaimed).toHaveBeenCalledWith(light, result, 2_500_000_000);
    busy = true;
    expect(a.claimBusy()).toBe(true);
    expect(await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    // A refusal hands nothing over.
    busy = false;
    walletManager.claimRewards.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'NO_REWARDS' }));
    onClaimed.mockClear();
    expect(await a.claim({ nodeId: light, qnet: mockQNET, amountNano: 1 })).toEqual({ status: 'empty' });
    expect(onClaimed).not.toHaveBeenCalled();
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
  it('says it waits for network admission, never Offline, and its balance moves', async () => {
    Object.assign(mockState, { online: false, admitted: false });
    const tree = await unlocked();
    await tab(tree, 'node');
    const text = texts(tree);
    expect(text).toContain(t('node_waiting_admission'));
    expect(text).toContain(t('node_badge_waiting'));
    expect(text).not.toContain(t('node_server_offline'));
    expect(text).not.toContain(t('node_badge_offline'));
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
});

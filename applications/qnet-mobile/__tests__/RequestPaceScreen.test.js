/**
 * The owner's 05.10 ping audit (F12) on the real wallet screen: the address socket names this wallet's address only,
 * comes back no sooner than 5 minutes after a refusal and closes in the background; its account events (the node's
 * BalanceUpdate) start a live read and make it live, and only a live socket slows Assets and History (owner, 18.10);
 * Assets' live figure every 15 s otherwise, History asks the explorer only on opening; the Node tab reads its statuses
 * every 5 minutes, the node balance once per epoch, and gives its Background row a button to the system settings.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, RefreshControl, Text, TextInput } from 'react-native';

const mockQNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const mockSOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const mockLIGHT = 'light_mobile_1111222233334444';
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
    async checkPassword() { return { ok: true }; }
    async loadWallet() { return { address: mockSOL, solanaAddress: mockSOL, publicKey: mockSOL, qnetAddress: mockQNET }; }
    getBIP39WordList() { return words; }
    getTrustedNodes() { return ['https://node1.aiqnet.io']; }
    trustedNodeUrl() { return 'https://node1.aiqnet.io'; }
    async getQNCBalanceWithProof() { return { ok: true, balance: 1, balanceNano: '1000000000', verified: true }; }
    // The send check's read (the live figure less this wallet's own unsettled spends): the same figure.
    async qncForSend() { return { ok: true, balanceNano: '1000000000', nonce: '4', pending: [] }; }
    // The wallet's figure at a genesis node's live tip: mockState.liveFigure, none by default. Each read the network gets
    // is counted; one read within `maxAgeMs` is taken as it is, as WalletManager.liveQncFigure takes it.
    async liveQncFigure(address, { maxAgeMs = 0 } = {}) {
      if (maxAgeMs > 0 && mockState.liveAt !== null && Date.now() - mockState.liveAt <= maxAgeMs) return null;
      mockState.liveReads += 1;
      mockState.liveAt = Date.now();
      return mockState.liveFigure ? { ...mockState.liveFigure } : null;
    }
    // The token rows' read (it starts with the holdings): counted.
    async getTokenHoldings() { mockState.tokenReads += 1; return []; }
    // The kept transactions' sweep (the one now due sent again): counted.
    async sendDuePending() { mockState.keptSweeps += 1; return false; }
    async loadNodeRecord() { return null; }
    async saveNodeRecord() {}
    async confirmServerNode() { return null; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return mockQNET; }
    generateLightNodePseudonym() { return mockLIGHT; }
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
  readNodeStatus: jest.fn(async () => mockState.lightStatus),
  readLinkPending: jest.fn(async () => null),
  dropLinkPending: jest.fn(async () => {}),
}));

jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(async () => ({ capable: true, platform: 'android', flags: '', report: null })),
  isThisDevice: jest.fn(async () => null),
  settleByTag: jest.fn(async () => null),
  showPlayDialog: jest.fn(async () => 'ok'),
}));

jest.mock('../src/services/BackgroundPriority', () => ({
  readBackground: jest.fn(async () => ({
    priority: 'restricted', changeable: true, exempt: false, bucket: 'rare', userRestricted: false, refresh: null,
  })),
  openBackgroundSettings: jest.fn(async () => true),
}));

jest.mock('../src/services/PushService', () => ({
  readUnconfirmedBinding: jest.fn(async () => null),
  settleUnconfirmedBinding: jest.fn(async () => false),
  LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
  readdressIfOwed: jest.fn(async () => false),
  localBinding: jest.fn(async () => mockState.local),
  forgetIfReplaced: jest.fn(async () => false),
  signStatusWithPingKey: jest.fn(async () => null),
  stopLightNode: jest.fn(async () => ({ unbound: true })),
  bindThisDevice: jest.fn(async () => ({ ok: true })),
  selfAttestIfNeeded: jest.fn(async () => false),
  checkServerNodeStatus: jest.fn(async () => ({ success: false, error: 'network' })),
  getAllNodesByWallet: jest.fn(async () => ({ success: true, nodes: [] })),
  getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [] })),
  getNodeEpochs: jest.fn(async () => null),
  getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 2e9 })),
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
const Push = require('../src/services/PushService');
const Bg = require('../src/services/BackgroundPriority');
const WalletScreen = require('../src/screens/WalletScreen').default;

// The address socket: a stand-in that records what the screen opens and closes.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.closed = 0;
    FakeSocket.all.push(this);
  }

  close() {
    this.closed += 1;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.all = [];

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const texts = (tree) => tree.root.findAllByType(Text)
  .map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('')).join('\n');
const press = async (tree, testID) => {
  await act(async () => { tree.root.find((n) => n.props.testID === testID && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(8);
};

let listeners;
let nowSpy;
const clock = { offset: 0 };
let timeouts;
let intervals;
let fetched;
let savedState;
let savedSocket;
const mounted = [];
// The setTimeout calls with this delay since `from` (an index into the spy's calls).
const waits = (ms, from = 0) => timeouts.mock.calls.slice(from).filter((c) => c[1] === ms);
// Runs a scheduled call now, the timer it was set with cleared (no copy of it runs later).
const fire = async (call) => {
  clearTimeout(timeouts.mock.results[timeouts.mock.calls.indexOf(call)].value);
  await act(async () => { call[0](); });
};
const appGoes = async (next) => {
  AppState.currentState = next;
  await act(async () => { for (const h of [...listeners]) h(next); });
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
    && n.findAllByType(Text).some((x) => [].concat(x.props.children).join('') === t('unlock_wallet'))).pop();
  await act(async () => { await unlock.props.onPress(); });
  await flush(10);
  return tree;
}

beforeAll(() => {
  savedSocket = global.WebSocket;
  global.WebSocket = FakeSocket;
});
afterAll(() => { global.WebSocket = savedSocket; });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  FakeSocket.all = [];
  listeners = [];
  fetched = [];
  savedState = AppState.currentState;
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') listeners.push(handler);
    return { remove: () => { listeners = listeners.filter((h) => h !== handler); } };
  });
  clock.offset = 0;
  const real = Date.now.bind(Date);
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => real() + clock.offset);
  timeouts = jest.spyOn(global, 'setTimeout');
  intervals = jest.spyOn(global, 'setInterval');
  global.fetch = jest.fn(async (url) => { fetched.push(String(url)); throw new Error('offline in tests'); });
  Object.assign(mockState, {
    liveReads: 0,
    liveAt: null,
    liveFigure: null,
    keptSweeps: 0,
    tokenReads: 0,
    // This device's binding of the node: the tab shows it running here.
    local: { nodeId: mockLIGHT, seq: 1790000000, pushType: 'fcm', hw: false, boundAt: null },
    lightStatus: {
      reachable: true, onChain: true, registrationPending: false, deviceBound: true, deviceBoundAgreed: true, answered: true,
      needsReactivation: false, counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null,
      bindingSeqAgreed: null,
    },
  });
});
afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); });
  nowSpy.mockRestore();
  timeouts.mockRestore();
  intervals.mockRestore();
  AppState.addEventListener.mockRestore();
  AppState.currentState = savedState;
});

describe('the address socket', () => {
  it('names this wallet\'s address only, waits at least 5 minutes after a refusal, and closes in the background', async () => {
    const tree = await unlocked();
    expect(FakeSocket.all).toHaveLength(1);
    const [first] = FakeSocket.all;
    expect(first.url).toBe(`wss://node1.aiqnet.io/ws/subscribe?channels=${encodeURIComponent(`account:${mockQNET}`)}`);
    expect(first.url).not.toMatch(/blocks/);

    // Refused (closed before it opened): the next try 5 to 10 minutes later.
    let mark = timeouts.mock.calls.length;
    await act(async () => { first.onerror(); });
    const refused = timeouts.mock.calls.slice(mark).map((c) => c[1]).filter((ms) => ms >= 1000);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeGreaterThanOrEqual(300000);
    expect(refused[0]).toBeLessThan(600000);

    // In the background: nothing scheduled runs; back in front: not before the wait it had.
    await appGoes('background');
    mark = timeouts.mock.calls.length;
    await appGoes('active');
    expect(FakeSocket.all).toHaveLength(1);
    const resumed = timeouts.mock.calls.slice(mark).map((c) => c[1]).filter((ms) => ms >= 290000);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toBeLessThanOrEqual(refused[0]);

    // The wait over, it opens again; open with no account event yet (an older node sends none), Assets still reads every
    // 30 s (before, an open socket alone slowed it to 60 s); the background closes it, for good.
    await fire(timeouts.mock.calls.slice(mark).find((c) => c[1] >= 290000));
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1];
    await act(async () => { second.onopen(); });
    const tick = [...waits(30000)].pop();
    expect(tick).toBeDefined(); // the Assets read set while the socket was not open
    mark = timeouts.mock.calls.length;
    await fire(tick);
    expect([waits(30000, mark).length > 0, waits(60000, mark)]).toEqual([true, []]);
    await appGoes('background');
    expect(second.closed).toBe(1);
    await flush(4);
    expect(FakeSocket.all).toHaveLength(2);
    expect(texts(tree)).toBeTruthy();
  });
});

// The node's account event (owner, 18.10): {"type":"BalanceUpdate","data":{"address","block_height"}} after each block
// that touched the wallet. Before, an event read the whole balance at 1.2 s and an open socket alone set the pace.
describe('the address socket\'s account events', () => {
  const send = (socket, frame) => act(async () => { socket.onmessage({ data: JSON.stringify(frame) }); });
  const event = (socket, address, height) => send(socket, { type: 'BalanceUpdate', data: { address, block_height: height } });
  const nodeHistoryReads = () => fetched.filter((u) => u.includes(`/api/v1/account/${mockQNET}/transactions`)).length;
  const opened = async () => {
    const tree = await unlocked();
    const [socket] = FakeSocket.all;
    await act(async () => { socket.onopen(); });
    return { tree, socket };
  };

  it('an event for this wallet reads the live figure a second later, again while it is of a state before the block, then History', async () => {
    const { socket } = await opened();
    const reads = mockState.liveReads;
    const history = nodeHistoryReads();
    const sweeps = mockState.keptSweeps;
    const tokens = mockState.tokenReads;
    // A hint: nothing is read at once, and a second event within the second raises the block the follow waits for.
    let mark = timeouts.mock.calls.length;
    await event(socket, mockQNET, 119);
    await event(socket, mockQNET, 120);
    expect(mockState.liveReads).toBe(reads);
    const first = waits(1000, mark);
    expect(first).toHaveLength(1);
    // A genesis node a block behind the newest event: read again a second later.
    mockState.liveFigure = { balance: 5, blockHeight: 119 };
    mark = timeouts.mock.calls.length;
    await fire(first[0]);
    await flush(8);
    expect(mockState.liveReads).toBe(reads + 1);
    expect([nodeHistoryReads(), mockState.keptSweeps, mockState.tokenReads]).toEqual([history, sweeps, tokens]);
    const again = waits(1000, mark);
    expect(again).toHaveLength(1);
    // The figure of the event's block: no further read; the token rows, History's newest rows and the kept transaction
    // now due (a send "in addition" goes once the one before applied).
    mockState.liveFigure = { balance: 7, blockHeight: 120 };
    mark = timeouts.mock.calls.length;
    await fire(again[0]);
    await flush(8);
    expect(mockState.liveReads).toBe(reads + 2);
    expect(waits(1000, mark)).toEqual([]);
    expect([nodeHistoryReads(), mockState.keptSweeps, mockState.tokenReads]).toEqual([history + 1, sweeps + 1, tokens + 1]);

    // No figure of that block at all: three reads, then History all the same.
    mockState.liveFigure = null;
    mark = timeouts.mock.calls.length;
    await event(socket, mockQNET, 200);
    for (let i = 0; i < 3; i++) {
      const step = waits(1000, mark);
      expect(step).toHaveLength(1);
      mark = timeouts.mock.calls.length;
      await fire(step[0]);
      await flush(8);
    }
    expect(waits(1000, mark)).toEqual([]);
    expect(mockState.liveReads).toBe(reads + 5);
    expect(nodeHistoryReads()).toBe(history + 2);

    // The background closes the socket and ends the follow of an event: nothing is read behind the app.
    const cleared = jest.spyOn(global, 'clearTimeout');
    try {
      mark = timeouts.mock.calls.length;
      await event(socket, mockQNET, 300);
      const pending = waits(1000, mark)[0];
      await appGoes('background');
      expect(cleared).toHaveBeenCalledWith(timeouts.mock.results[timeouts.mock.calls.indexOf(pending)].value);
    } finally {
      cleared.mockRestore();
    }
  });

  // Before, every event cleared the follow's timer and took it over: on a wallet touched in consecutive blocks (an event
  // about every second) no follow reached the token rows, History or the kept transactions, while the live socket kept
  // Assets and History at 60 s.
  it('events 900 ms apart: the follow still ends, with the token rows, History and the kept transactions', async () => {
    const { socket } = await opened();
    const [reads, history, sweeps, tokens] = [mockState.liveReads, nodeHistoryReads(), mockState.keptSweeps, mockState.tokenReads];
    const cleared = jest.spyOn(global, 'clearTimeout');
    // The follow's timers on a clock of the test's own: each due ACCOUNT_EVENT_MS after it was set, run when the clock
    // passes it unless the screen cleared it first.
    const due = [];
    let seen = timeouts.mock.calls.length;
    let now = 0;
    const note = () => {
      timeouts.mock.calls.slice(seen).forEach((c, i) => {
        if (c[1] === 1000) due.push({ call: c, handle: timeouts.mock.results[seen + i].value, at: now + 1000, fired: false });
      });
      seen = timeouts.mock.calls.length;
    };
    const pending = (d) => !d.fired && !cleared.mock.calls.some(([h]) => h === d.handle);
    const until = async (to) => {
      for (;;) {
        const next = due.filter(pending).sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > to) break;
        next.fired = true;
        now = next.at;
        clock.offset = now;
        await fire(next.call);
        await flush(8);
        note();
      }
      now = to;
      clock.offset = to;
    };
    try {
      mockState.liveFigure = { balance: 1, blockHeight: 10 }; // the genesis nodes a block or more behind every event
      for (let k = 0; k < 5; k++) {
        await until(k * 900);
        await event(socket, mockQNET, 11 + k);
        note();
      }
      // The follow set at 0 ms read at 1, 2 and 3 s, its newest block still ahead, and ended there; the event at 3.6 s
      // started the next one.
      expect(mockState.liveReads - reads).toBe(3);
      expect([nodeHistoryReads() - history, mockState.keptSweeps - sweeps, mockState.tokenReads - tokens]).toEqual([1, 1, 1]);
      expect(due.filter(pending)).toHaveLength(1);
      await appGoes('background'); // ends that follow with the socket
      expect(due.filter(pending)).toEqual([]);
    } finally {
      cleared.mockRestore();
    }
  });

  it('another address or another frame reads nothing and leaves the pace; an event makes the socket live until it closes', async () => {
    const { tree, socket } = await opened();
    const live = intervals.mock.calls.filter((c) => c[1] === 15000);
    expect(live).toHaveLength(1);
    let mark = timeouts.mock.calls.length;
    await event(socket, 'a'.repeat(41) + 'eon0', 10);
    await send(socket, { type: 'connected', rate_limit: { max_per_ip: 5, max_account_channels: 20 } });
    expect(waits(1000, mark)).toEqual([]);
    let reads = mockState.liveReads;
    clock.offset = 15000;
    await act(async () => { live[0][0](); });
    await flush(4);
    expect(mockState.liveReads).toBe(reads + 1); // not live: the 15 s read

    // An event: live. The 15 s read stops (the events ask for the figure) and the next Assets read is 60 s away.
    await event(socket, mockQNET, 50);
    mockState.liveFigure = { balance: 1, blockHeight: 50 };
    await fire([...waits(1000)].pop());
    await flush(8);
    reads = mockState.liveReads;
    clock.offset = 30000;
    await act(async () => { live[0][0](); });
    await flush(4);
    expect(mockState.liveReads).toBe(reads);
    mark = timeouts.mock.calls.length;
    await fire([...waits(30000)].pop()); // the Assets read set before the event
    await flush(6);
    expect([waits(60000, mark).length, waits(30000, mark).length]).toEqual([1, 0]);

    // History while live: its newest rows every 60 s.
    mark = timeouts.mock.calls.length;
    await press(tree, 'tab-history');
    const historyTick = [...waits(60000, mark)].pop();
    expect(historyTick).toBeDefined();
    expect(waits(30000, mark)).toEqual([]);

    // Closed (a drop): not live any more; the next waits are the shorter ones, and the 15 s read on Assets is back.
    await act(async () => { socket.close(); });
    mark = timeouts.mock.calls.length;
    await fire(historyTick);
    await flush(6);
    expect([waits(30000, mark).length, waits(60000, mark).length]).toEqual([1, 0]);
    const marked = intervals.mock.calls.length;
    await press(tree, 'tab-assets');
    const back = intervals.mock.calls.slice(marked).filter((c) => c[1] === 15000);
    expect(back).toHaveLength(1);
    reads = mockState.liveReads;
    clock.offset = 60000;
    await act(async () => { back[0][0](); });
    await flush(4);
    expect(mockState.liveReads).toBe(reads + 1);
  });
});

describe('the tabs\' reads', () => {
  it('Assets reads the live figure every 15 s; History asks the explorer on opening only, then a node every 30 s', async () => {
    const tree = await unlocked();
    // One 15 s interval while Assets is in front, a light read of the live figure and nothing else.
    const live = intervals.mock.calls.filter((c) => c[1] === 15000);
    expect(live).toHaveLength(1);
    const reads = mockState.liveReads;
    clock.offset = 15000;
    await act(async () => { live[0][0](); });
    await flush(4);
    expect(mockState.liveReads).toBe(reads + 1);
    const mark = timeouts.mock.calls.length;
    const marked = intervals.mock.calls.length;
    const explorer = () => fetched.filter((u) => u.includes('/api/address/')).length;
    const loaded = explorer(); // the wallet's own load at the unlock
    await press(tree, 'tab-history');
    expect(explorer()).toBe(loaded + 1);
    const tick = [...waits(30000, mark)].pop();
    expect(tick).toBeDefined();
    const nodeReads = fetched.length;
    await fire(tick);
    await flush(6);
    expect(explorer()).toBe(loaded + 1);
    expect(fetched.length).toBeGreaterThan(nodeReads); // the node's newest rows
    // No interval reads the history (the kept-transaction sweep looks at this device's own list first).
    expect(intervals.mock.calls.slice(marked).filter((c) => (c[1] === 10000 || c[1] === 15000) && c[0].name !== 'sweep')).toEqual([]);
  });

  // Before, the 15 s read and the balance read every 30 s each read anew: three live reads or more in 30 s on an open
  // Assets, on the genesis nodes alone.
  it('an open Assets asks for the live figure twice in 30 s, whichever of its two timers fires first', async () => {
    await unlocked();
    const live = intervals.mock.calls.filter((c) => c[1] === 15000);
    expect(live).toHaveLength(1);
    const at = async (ms, run) => { clock.offset = ms; await run(); await flush(6); };
    const balanceRead = () => fire([...waits(30000)].pop());
    const tick = () => act(async () => { live[0][0](); });
    const count = async (steps) => {
      const before = mockState.liveReads;
      for (const [ms, run] of steps) await at(ms, run);
      return mockState.liveReads - before;
    };
    // The balance read at the unlock was at 0. The 15 s read just before each balance read: that one takes its figure.
    expect(await count([[14500, tick], [29500, tick], [30000, balanceRead], [44500, tick], [59500, tick],
      [60000, balanceRead]])).toBe(4);
    // The 15 s read just after each balance read: it skips.
    expect(await count([[61000, tick], [76000, tick], [90000, balanceRead], [91000, tick], [106000, tick],
      [120000, balanceRead]])).toBe(4);
  });

  it('the Node tab: statuses every 5 minutes, the balance once per epoch, and the Background row\'s button', async () => {
    const tree = await unlocked();
    await press(tree, 'tab-node');
    await flush(8);
    expect(intervals.mock.calls.some((c) => c[1] === 300000)).toBe(true);
    expect(intervals.mock.calls.some((c) => c[1] === 30000)).toBe(false);
    const balanceReads = () => Push.getPendingRewards.mock.calls.length;
    expect(balanceReads()).toBe(3);
    // Back in front: the statuses again, the balance not (the same epoch).
    await appGoes('background');
    await appGoes('active');
    expect(balanceReads()).toBe(3);
    // Pull to refresh reads it now.
    await act(async () => { await tree.root.findAllByType(RefreshControl).pop().props.onRefresh(); });
    await flush(8);
    expect(balanceReads()).toBe(6);
    // The Background row, restricted, with its one button to the system settings.
    expect(texts(tree)).toContain(t('node_background_restricted'));
    await press(tree, 'node-background');
    expect(Bg.openBackgroundSettings).toHaveBeenCalledTimes(1);
  });
});

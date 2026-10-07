/**
 * The owner's 05.10 ping audit, the app's part: a rate-limited read of the chain is a failure with its wait, never silence
 * (F10); a background answer reads as little as it can, only a polling device asks for its next ping, and a launch in
 * the background reads no status (F12); the owners' word joined (F13); the network's own misses said as such
 * (`not_sent`, `not_committed`); Android's backup wake in every epoch; and the background priority: the state each
 * answer and push receipt reports, the Node tab's row and its one button, the same rule on both platforms.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Linking, NativeModules, Platform, Text } from 'react-native';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn().mockResolvedValue('ab'.repeat(8)),
}));
jest.mock('../src/services/TaskState', () => ({ closedByUser: jest.fn(async () => false) }));
jest.mock('../src/services/DeviceSecurity', () => ({
  ...jest.requireActual('../src/services/DeviceSecurity'),
  bootMark: jest.fn(async () => null),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const BackgroundFetch = require('react-native-background-fetch').default;
const TaskState = require('../src/services/TaskState');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const Receipts = require('../src/services/PushReceipts');
const Bg = require('../src/services/BackgroundPriority');
const Pace = require('../src/utils/requestPace');
const { readNodeStatus, latestMiss, MISS_REASONS, NETWORK_MISSES } = require('../src/services/LightNode');
const NodeTab = require('../src/screens/NodeTab').default;
const { missText, nodeView, backgroundView } = require('../src/screens/NodeTab');
const { makeT } = require('../src/i18n');
const translations = require('../src/i18n/translations').default;

const t = makeT('en');
const NODE = 'light_mobile_83afab763b9058fd';
const OWNERS = lightShardOwnerUrls(NODE);
const SEQ = 1790000000;
const E = 14400;
const HASH = 'ab'.repeat(32);
const EPOCH = 200;
const at = (offset, epoch = EPOCH) => epoch * E + offset;
const HOLD = 'qnet_self_attest_hold';
// The backup point of an epoch: its closing gap (155 blocks before its end) less 1,800 blocks.
const POINT = E - 150 - 5 - 1800;
const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const hold = async () => JSON.parse(await AsyncStorage.getItem(HOLD));
const posts = () => calls.filter((c) => c.url.endsWith('/api/v1/light-node/ping-response'));
const gets = () => calls.filter((c) => !c.body).map((c) => c.url);
const settle = () => new Promise((r) => setTimeout(r, 50));
const scheduled = (taskId) => BackgroundFetch.scheduleTask.mock.calls.map((c) => c[0]).filter((c) => c.taskId === taskId);

let calls;
let answers;
let resume = null;
let Push;
let platform;
let appState;

beforeAll(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') resume = handler;
    return { remove: jest.fn() };
  });
  Push = require('../src/services/PushService');
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  platform = Platform.OS;
  appState = AppState.currentState;
  AppState.currentState = 'background';
  TaskState.closedByUser.mockResolvedValue(false);
  BackgroundFetch.status.mockResolvedValue(2);
  Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
  delete NativeModules.QNetBackground;
  calls = [];
  answers = (url) => (url.endsWith('/api/v1/height') ? { height: at(1000) }
    : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : { success: true }));
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body);
    if (a instanceof Error) return Promise.reject(a);
    if (a && a.status) return reply(a.body, a.status);
    return reply(a);
  });
});
afterEach(() => {
  Platform.OS = platform;
  AppState.currentState = appState;
  delete NativeModules.QNetBackground;
});

const linked = async (pushType = 'fcm') => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType, seq: SEQ })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, 'pk'],
    [`qnet_ping_cert_${NODE}`, `v2.${SEQ}.cert`],
    // The push token the owners hold already: no wake sends it again.
    ['qnet_last_sent_fcm_token', 'test-fcm-token'],
  ]);
};
const chainAt = (height, ping = () => ({ success: true })) => {
  answers = (url, body) => {
    if (url.endsWith('/api/v1/height')) return { height };
    if (url.includes('/microblock/')) return { previous_hash: new Array(32).fill(7) };
    if (url.endsWith('/ping-response')) return ping(url, body);
    return { onchain_registered: true };
  };
};

describe('F10: a refused read of the chain is a failure with its wait, never silence', () => {
  it('a rate-limited height read sets the next try at the wait it names, and records why', async () => {
    await linked();
    Platform.OS = 'android';
    answers = (url) => (url.endsWith('/api/v1/height')
      ? { success: false, error: 'Rate limit exceeded', retry_after_seconds: 90 } : { success: true });
    const before = Date.now();
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(posts()).toEqual([]);
    const h = await hold();
    expect(h).toMatchObject({ nodeId: NODE, kind: 'retry', tries: 1, reason: 'rate_limited', wake: true });
    expect(h.until).toBeGreaterThanOrEqual(before + 90000);
    const [retry] = scheduled(Push.ANSWER_RETRY_TASK);
    expect(retry).toMatchObject({ periodic: false, forceAlarmManager: true, enableHeadless: true });
    expect(retry.delay).toBeGreaterThanOrEqual(89000);
    // Within the wait a background wake sends nothing; a delivered push still answers at once.
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(calls).toEqual([]);
    chainAt(at(1000));
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${at(1000)}:${HASH}` })).toBe(true);
  });

  it('a 429, a reply with no height and a rate-limited block read are failures to retry too, each with its reason', async () => {
    await linked();
    answers = (url) => (url.endsWith('/api/v1/height') ? { status: 429, body: { error: 'Too many requests' } } : {});
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry', reason: 'rate_limited' });

    await AsyncStorage.removeItem(HOLD);
    answers = (url) => (url.endsWith('/api/v1/height') ? { is_syncing: true } : {});
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry', reason: 'no_height' });

    await AsyncStorage.removeItem(HOLD);
    answers = (url) => {
      if (url.endsWith('/api/v1/height')) return { height: at(1000) };
      if (url.includes('/microblock/')) return { success: false, error: 'Rate limit exceeded', retry_after_seconds: 30 };
      return { onchain_registered: true };
    };
    const before = Date.now();
    await Push.selfAttestIfNeeded(NODE);
    const h = await hold();
    expect(h).toMatchObject({ kind: 'retry', reason: 'rate_limited', epoch: EPOCH });
    expect(h.until).toBeGreaterThanOrEqual(before + 30000);
    expect(posts()).toEqual([]);
  });
});

describe('F12: a background answer reads as little as it can', () => {
  it('the registration read only before the first answer of the binding; after it, the height and one block', async () => {
    await linked();
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(gets().some((u) => u.includes('/api/v1/light-node/status?node_id='))).toBe(true);
    await AsyncStorage.removeItem(HOLD);
    chainAt(at(1000, EPOCH + 1));
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(gets().map((u) => u.split('/api/v1/')[1].replace(/\d+$/, 'N'))).toEqual(['height', 'microblock/N']);
    expect(posts()).toHaveLength(1);
  });

  it('only a polling device asks for its next ping time after an answer', async () => {
    await linked('fcm');
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    await settle();
    expect(calls.some((c) => c.url.includes('/light-node/next-ping'))).toBe(false);
    await AsyncStorage.clear();
    await linked('polling');
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    await settle();
    expect(calls.filter((c) => c.url.includes('/light-node/next-ping'))).toHaveLength(1);
  });

  it('a launch in the background reads no status; the first return to the app reads it, and arms the periodic wake again', async () => {
    await linked();
    // Answered in an earlier epoch: a round reads no registration status, so every status read here is the launch's.
    await AsyncStorage.setItem('qnet_last_self_attest_epoch', String(EPOCH - 1));
    await Push.initializePushService();
    await settle();
    expect(calls.some((c) => c.url.endsWith('/api/v1/height'))).toBe(true); // the launch's own answer
    expect(calls.filter((c) => c.url.includes('/light-node/status'))).toEqual([]);
    expect(typeof resume).toBe('function');
    BackgroundFetch.configure.mockClear();
    AppState.currentState = 'active';
    resume('active');
    await settle();
    expect(calls.filter((c) => c.url.includes('/light-node/status')).map((c) => c.url.split('/api/')[0]))
      .toEqual(expect.arrayContaining(OWNERS));
    expect(BackgroundFetch.configure).toHaveBeenCalledTimes(1);
    // The next return reads no status again: the launch's was owed once.
    calls = [];
    resume('active');
    await settle();
    expect(calls.filter((c) => c.url.includes('/light-node/status'))).toEqual([]);
  });
});

describe('Android: one backup wake in every epoch, before its commit, only while the epoch is not counted', () => {
  const near = (ms, expected) => expect(Math.abs(ms - expected)).toBeLessThan(3000);

  it('an epoch counted arms the next one\'s backup at its point, once', async () => {
    await linked();
    Platform.OS = 'android';
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    const [backup] = scheduled(Push.EPOCH_BACKUP_TASK);
    expect(backup).toMatchObject({ periodic: false, forceAlarmManager: true, enableHeadless: true, stopOnTerminate: false });
    near(backup.delay, (E - 1000 + POINT) * 1000);
    expect(Push.epochBackupAt(at(1000), 0, true)).toBe((E - 1000 + POINT) * 1000);
    expect(Push.EPOCH_BACKUP_LEAD_BLOCKS).toBe(1800);
    // A later round of the same epoch (it finds the epoch counted) sets nothing new.
    BackgroundFetch.scheduleTask.mockClear();
    await AsyncStorage.removeItem(HOLD);
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(scheduled(Push.EPOCH_BACKUP_TASK)).toEqual([]);
  });

  it('a failure arms the epoch read\'s own backup while its point is ahead; none after it, on a refusal, a closed epoch or iOS', async () => {
    await linked();
    Platform.OS = 'android';
    chainAt(at(1000), () => new Error('down'));
    await Push.selfAttestIfNeeded(NODE);
    near(scheduled(Push.EPOCH_BACKUP_TASK)[0].delay, (POINT - 1000) * 1000);
    expect(scheduled(Push.ANSWER_RETRY_TASK)).toHaveLength(1);

    for (const [height, ping] of [
      [at(POINT + 500), () => new Error('down')], // past the point: its retries answer it
      [at(1000), () => ({ success: false, error: 'Invalid quantum signature' })], // a refusal for good
      [at(14300), () => ({ success: true })], // inside the closing gap
    ]) {
      await AsyncStorage.clear();
      await linked();
      BackgroundFetch.scheduleTask.mockClear();
      chainAt(height, ping);
      expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
      expect([height % E, scheduled(Push.EPOCH_BACKUP_TASK)]).toEqual([height % E, []]);
    }

    await AsyncStorage.clear();
    await linked();
    Platform.OS = 'ios';
    BackgroundFetch.scheduleTask.mockClear();
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
  });

  it('the backup wake asks the answer rule and the holds as every wake does, and goes with the binding', async () => {
    await linked();
    Platform.OS = 'android';
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    // Counted: the wake costs no request.
    calls = [];
    await Push.onBackgroundFetch(Push.EPOCH_BACKUP_TASK);
    expect(calls).toEqual([]);
    expect(BackgroundFetch.finish).toHaveBeenCalledWith(Push.EPOCH_BACKUP_TASK);
    // Swiped away since it was last opened: nothing at all, whatever the epoch.
    await AsyncStorage.removeItem(HOLD);
    await AsyncStorage.removeItem('qnet_last_self_attest_epoch');
    TaskState.closedByUser.mockResolvedValue(true);
    await Push.onBackgroundFetch(Push.EPOCH_BACKUP_TASK);
    expect(calls).toEqual([]);
    // Not counted and allowed: it answers.
    TaskState.closedByUser.mockResolvedValue(false);
    await Push.onBackgroundFetch(Push.EPOCH_BACKUP_TASK);
    expect(posts()).toHaveLength(1);
    await Push.teardownLightNode();
    expect(BackgroundFetch.stop).toHaveBeenCalledWith(Push.EPOCH_BACKUP_TASK);
    expect(await AsyncStorage.getItem('qnet_epoch_backup')).toBeNull();
  });
});

describe('the background priority: what the system allows, read the same way on both platforms', () => {
  it('Android: unrestricted only when exempted from battery optimization and not restricted by the user or its bucket', () => {
    expect(Bg.androidPriority({ exempt: true, bucket: 10, userRestricted: false }))
      .toEqual({ priority: 'unrestricted', changeable: true, exempt: true, bucket: 'active', userRestricted: false, refresh: null });
    expect(Bg.androidPriority({ exempt: true, bucket: 5 }).priority).toBe('unrestricted');
    expect(Bg.androidPriority({ exempt: false, bucket: 10, userRestricted: false }).priority).toBe('restricted');
    expect(Bg.androidPriority({ exempt: true, bucket: 10, userRestricted: true }).priority).toBe('restricted');
    for (const b of [40, 45, 50]) expect(Bg.androidPriority({ exempt: true, bucket: b }).priority).toBe('restricted');
    expect(Bg.androidPriority({ exempt: true, bucket: 33 }).bucket).toBe('33');
    expect(Bg.androidPriority({ bucket: 10 })).toBeNull();
    expect(Bg.androidPriority(null)).toBeNull();
  });

  it('iOS: Background App Refresh on is unrestricted; off by the user can be changed, off by a profile cannot', () => {
    expect(Bg.iosPriority(2)).toMatchObject({ priority: 'unrestricted', changeable: true, refresh: 'available' });
    expect(Bg.iosPriority(1)).toMatchObject({ priority: 'restricted', changeable: true, refresh: 'denied' });
    expect(Bg.iosPriority(0)).toMatchObject({ priority: 'restricted', changeable: false, refresh: 'restricted' });
    expect(Bg.iosPriority(7)).toBeNull();
  });

  it('reads the native module on Android, the refresh status on iOS (the last one kept when it cannot), nothing without either', async () => {
    Platform.OS = 'android';
    expect(await Bg.readBackground()).toBeNull();
    NativeModules.QNetBackground = { state: jest.fn(async () => ({ exempt: false, bucket: 40, userRestricted: false })) };
    expect(await Bg.readBackground()).toMatchObject({ priority: 'restricted', bucket: 'rare', exempt: false });
    NativeModules.QNetBackground.state.mockRejectedValueOnce(new Error('no'));
    expect(await Bg.readBackground()).toBeNull();
    Platform.OS = 'ios';
    BackgroundFetch.status.mockResolvedValueOnce(1);
    expect(await Bg.readBackground()).toMatchObject({ priority: 'restricted', refresh: 'denied' });
    BackgroundFetch.status.mockRejectedValueOnce(new Error('no'));
    expect(await Bg.readBackground()).toBeNull();
    await AsyncStorage.setItem(Bg.BG_REFRESH_STATUS_KEY, '0');
    BackgroundFetch.status.mockRejectedValueOnce(new Error('no'));
    expect(await Bg.readBackground()).toMatchObject({ priority: 'restricted', refresh: 'restricted', changeable: false });
  });

  it('the button opens the app\'s system page: the native module on Android, the app\'s Settings page on iOS', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    try {
      Platform.OS = 'android';
      NativeModules.QNetBackground = { openSettings: jest.fn(async () => true) };
      expect(await Bg.openBackgroundSettings()).toBe(true);
      expect(NativeModules.QNetBackground.openSettings).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      NativeModules.QNetBackground.openSettings.mockResolvedValueOnce(false);
      expect(await Bg.openBackgroundSettings()).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      Platform.OS = 'ios';
      expect(await Bg.openBackgroundSettings()).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });

  it('the background state stays on the device: no answer and no receipt it reports carries it', async () => {
    await linked();
    Platform.OS = 'android';
    NativeModules.QNetBackground = { state: jest.fn(async () => ({ exempt: false, bucket: 40, userRestricted: false })) };
    chainAt(at(1000));
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${at(1000)}:${HASH}`, sent_at: '1800000000' })).toBe(true);
    const body = posts()[0].body;
    expect(Object.keys(body).filter((k) => k.startsWith('bg_'))).toEqual([]);
    for (const v of Object.values(body)) expect(typeof v).toBe('string');
    // The next epoch's push came while the app was swiped away: the answer after reports it, with no background state.
    NativeModules.QNetBackground.state.mockResolvedValue({ exempt: true, bucket: 10, userRestricted: false });
    TaskState.closedByUser.mockResolvedValue(true);
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${at(1000, EPOCH + 1)}:${HASH}` })).toBe(false);
    TaskState.closedByUser.mockResolvedValue(false);
    await AsyncStorage.removeItem(HOLD);
    chainAt(at(1000, EPOCH + 2));
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
    const report = JSON.parse(posts()[0].body.push_receipts);
    expect(report.pushes).toEqual([{
      epoch: EPOCH, sent_at: 1800000000, received_at: expect.any(Number), outcome: 'answered',
    }, {
      epoch: EPOCH + 1, sent_at: null, received_at: expect.any(Number), outcome: 'swiped',
    }]);
  });

  it('a full report still fits the node\'s 2,048 bytes, and keeps nothing but the times and the outcome', async () => {
    for (let e = 9_999_990; e < 9_999_996; e++) {
      await Receipts.noteReceived(NODE, e, { sentAt: 1_800_000_000, receivedAt: 1_800_000_000 }, { bg_priority: 'restricted' });
      await Receipts.noteOutcome(NODE, e, 'not_opened_since_boot');
    }
    const report = await Receipts.reportFor(NODE, 9_999_996);
    expect(report.pushes).toHaveLength(6);
    for (const p of report.pushes) expect(Object.keys(p).sort()).toEqual(['epoch', 'outcome', 'received_at', 'sent_at']);
    expect(JSON.stringify(report).length).toBeLessThan(2048);
    const rec = JSON.parse(await AsyncStorage.getItem(Receipts.PUSH_RECEIPTS_KEY));
    for (const e of rec.epochs) expect(e.bg).toBeUndefined();
  });
});

describe('F13: any owner that sees the node on the chain counts', () => {
  const pub = (over = {}) => ({
    onchain_registered: true, registration_pending: false, device_bound: true, answered_this_epoch: false,
    needs_reactivation: true, counted: { epochs_since_registration: 6, counted: 4, last_counted_epoch: 150 },
    device: { platform: 'android', linked_since: 20000, last_answer_epoch: 150, state: 'offline' }, features: ['bind_v2'], ...over,
  });
  const serve = (byOwner) => {
    global.fetch = jest.fn((url) => reply(byOwner[OWNERS.findIndex((o) => url.startsWith(o))]));
  };

  it('answered and online when one owner says so (it took the answer while the primary was down); offline only when all do', async () => {
    serve([pub(), pub({
      answered_this_epoch: true, needs_reactivation: false,
      counted: { epochs_since_registration: 6, counted: 5, last_counted_epoch: 151 },
      device: { platform: 'android', linked_since: 20000, last_answer_epoch: 151, state: 'online' },
    }), pub()]);
    const s = await readNodeStatus(NODE);
    expect(s).toMatchObject({ onChain: true, answered: true, needsReactivation: false, counted: { since: 6, counted: 5, last: 151 } });
    expect(s.device).toMatchObject({ platform: 'android', state: 'online', lastAnswerEpoch: 151 });
    serve([pub(), pub(), pub()]);
    expect(await readNodeStatus(NODE)).toMatchObject({ answered: false, needsReactivation: true, device: { state: 'offline' } });
    // An owner that cannot be reached decides nothing: the two that answer must both say so.
    global.fetch = jest.fn((url) => (url.startsWith(OWNERS[2]) ? Promise.reject(new Error('down')) : reply(pub())));
    expect((await readNodeStatus(NODE)).needsReactivation).toBe(true);
  });
});

describe('the network\'s own misses: said as such, nothing asked of the device', () => {
  const status = (lastMiss) => ({
    reachable: true, onChain: true, deviceBound: true, deviceBoundAgreed: true, answered: false, needsReactivation: false,
    counted: { since: 20, counted: 18, last: 205 }, device: { platform: 'ios', linkedSince: null, lastAnswerEpoch: 205, state: 'online' },
    deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, lastMiss,
  });
  const miss = (reason, epoch = 210) => ({ epoch, reason, wokenAt: null, answeredAt: null, deliveryDelaySecs: null, refused: null });

  it('not_sent and not_committed read as the network\'s, with nothing to do here and no button', () => {
    expect([...NETWORK_MISSES].sort()).toEqual(['not_committed', 'not_sent']);
    expect(missText(t, status(miss('not_sent')))).toBe(`${t('node_miss_not_sent')} ${t('node_miss_do_nothing')}`);
    expect(missText(t, status(miss('not_committed')))).toBe(`${t('node_miss_not_committed')} ${t('node_miss_do_nothing')}`);
    const L = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: false };
    for (const reason of ['not_sent', 'not_committed']) {
      expect(nodeView({ status: status(miss(reason)), local: L, height: at(3000, 211) })).toMatchObject({ state: 'here', offerUse: false });
    }
  });

  it('at one epoch, not_committed explains the miss whole; not_sent yields to every reason about the device', () => {
    expect(MISS_REASONS[0]).toBe('not_committed');
    expect(latestMiss([miss('answered_late'), miss('not_committed')]).reason).toBe('not_committed');
    expect(latestMiss([miss('not_sent'), miss('woken_no_answer')]).reason).toBe('woken_no_answer');
    expect(latestMiss([miss('not_sent'), miss('no_push_address')]).reason).toBe('no_push_address');
    expect(latestMiss([miss('not_woken_inactive'), miss('not_sent')]).reason).toBe('not_sent');
    expect(latestMiss([miss('not_committed', 209), miss('not_sent', 210)]).reason).toBe('not_sent');
  });

  it('the status reads both reasons strictly, like every other', async () => {
    const pub = (reason) => ({
      onchain_registered: true, device_bound: true, features: [],
      device: { platform: 'ios', state: 'online', last_answer_epoch: 205, last_miss: { epoch: 210, reason } },
    });
    for (const reason of ['not_sent', 'not_committed']) {
      global.fetch = jest.fn(() => reply(pub(reason)));
      expect((await readNodeStatus(NODE)).lastMiss).toMatchObject({ epoch: 210, reason });
    }
  });

  it('every language says them, with no word of a price, a payout, a fault or a phone', () => {
    const keys = ['node_miss_not_sent', 'node_miss_not_committed', 'node_miss_do_nothing', 'node_background',
      'node_background_unrestricted', 'node_background_restricted', 'node_background_open'];
    expect(Object.keys(translations)).toHaveLength(11);
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of keys) expect([lang, k, typeof table[k] === 'string' && table[k].length > 0]).toEqual([lang, k, true]);
      if (lang !== 'en') {
        for (const k of ['node_miss_not_sent', 'node_miss_not_committed', 'node_miss_do_nothing', 'node_background_open']) {
          expect([lang, k, table[k] !== translations.en[k]]).toEqual([lang, k, true]);
        }
      }
    }
    expect(keys.map((k) => translations.en[k]).join(' ')).not.toMatch(/reward|burn|price|mining|\bcode\b|support|fault|blame|\bphone/i);
    expect(translations.en.node_bg_refresh_off).toBeUndefined();
  });
});

describe('the Node tab\'s Background row and its one button', () => {
  const L = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: false };
  const status = {
    reachable: true, onChain: true, deviceBound: true, deviceBoundAgreed: true, answered: true, needsReactivation: false,
    counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, lastMiss: null,
  };
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
  const mount = async (background, onOpenBackground) => {
    let tree;
    const light = { nodeId: NODE, status, local: L, pending: null, check: null, answeredAt: null, balanceNano: 0, device: null, background };
    await act(async () => {
      tree = renderer.create(<NodeTab t={t} light={light} height={at(3000, 211)} onMove={() => {}} onUse={() => {}}
        onCopy={() => {}} onOpenBackground={onOpenBackground} nodeTitle={() => ''} />);
    });
    return tree;
  };
  const button = (tree) => tree.root.findAll((n) => n.props.testID === 'node-background' && typeof n.props.onPress === 'function');

  it('maps the state to one row, with the button only while restricted and the user can change it', () => {
    expect(backgroundView(Bg.androidPriority({ exempt: true }))).toEqual({ key: 'node_background_unrestricted', color: '#34c759', open: false });
    expect(backgroundView(Bg.androidPriority({ exempt: false }))).toEqual({ key: 'node_background_restricted', color: '#ff9500', open: true });
    expect(backgroundView(Bg.iosPriority(0))).toMatchObject({ key: 'node_background_restricted', open: false });
    expect(backgroundView(null)).toBeNull();
  });

  it('restricted: the row and the button, which opens the system page; unrestricted or unknown: the row or nothing', async () => {
    const open = jest.fn();
    let tree = await mount(Bg.iosPriority(1), open);
    expect(texts(tree)).toEqual(expect.arrayContaining([t('node_background'), t('node_background_restricted')]));
    expect(button(tree).length).toBeGreaterThan(0);
    await act(async () => { button(tree)[0].props.onPress(); });
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); });

    tree = await mount(Bg.androidPriority({ exempt: true, bucket: 10 }), open);
    expect(texts(tree)).toEqual(expect.arrayContaining([t('node_background'), t('node_background_unrestricted')]));
    expect(button(tree)).toEqual([]);
    await act(async () => { tree.unmount(); });

    tree = await mount(null, open);
    expect(texts(tree)).not.toContain(t('node_background'));
    await act(async () => { tree.unmount(); });
  });
});

describe('the pace of the open app\'s requests', () => {
  it('the address socket: full jitter up to 5 minutes after a drop, at least 5 minutes after a refusal', () => {
    expect(Pace.socketRetryMs(0, { random: () => 0 })).toBe(1000);
    expect(Pace.socketRetryMs(0, { random: () => 0.999 })).toBeLessThan(5000);
    expect(Pace.socketRetryMs(3, { random: () => 0.999 })).toBeLessThan(40000);
    expect(Pace.socketRetryMs(30, { random: () => 0.999 })).toBeLessThan(300000);
    expect(Pace.socketRetryMs(30, { random: () => 0.999 })).toBeGreaterThan(299000);
    expect(Pace.socketRetryMs(0, { opened: false, random: () => 0 })).toBe(300000);
    expect(Pace.socketRetryMs(0, { opened: false, random: () => 0.999 })).toBeLessThan(600000);
    // Drawn per device: a thousand devices refused together come back spread over five minutes.
    const waits = Array.from({ length: 1000 }, () => Pace.socketRetryMs(0, { opened: false }));
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(300000);
    expect(Math.max(...waits) - Math.min(...waits)).toBeGreaterThan(200000);
  });

  it('Assets and History ask less often while the socket is open; the Node tab every 5 minutes', () => {
    expect([Pace.assetsPollMs(true), Pace.assetsPollMs(false)]).toEqual([60000, 30000]);
    expect([Pace.historyPollMs(true), Pace.historyPollMs(false)]).toEqual([60000, 30000]);
    expect(Pace.NODE_STATUS_MS).toBe(300000);
  });

  it('the epoch clock counts on from one read, at most 10 minutes past it', () => {
    expect(Pace.estimatedHeight({ height: 1000, at: 0 }, 59_999)).toBe(1059);
    expect(Pace.estimatedHeight({ height: 1000, at: 0 }, 3_600_000)).toBe(1600);
    expect(Pace.estimatedHeight({ height: 1000, at: 5000 }, 0)).toBe(1000);
    expect(Pace.estimatedHeight({ height: 0, at: 0 }, 1)).toBe(0);
    expect(Pace.estimatedHeight(null)).toBe(0);
  });

  it('a node balance once per epoch and node, and every 5 minutes while the epoch is not known', () => {
    const read = Pace.balanceRead(NODE, at(100), 0);
    expect(Pace.balanceDue(read, NODE, at(9000), 3_600_000)).toBe(false);
    expect(Pace.balanceDue(read, NODE, at(10, EPOCH + 1), 60_000)).toBe(true);
    expect(Pace.balanceDue(read, 'light_mobile_other', at(100), 0)).toBe(true);
    expect(Pace.balanceDue(null, NODE, at(100), 0)).toBe(true);
    const blind = Pace.balanceRead(NODE, 0, 0);
    expect(Pace.balanceDue(blind, NODE, 0, 299_999)).toBe(false);
    expect(Pace.balanceDue(blind, NODE, 0, 300_000)).toBe(true);
  });
});

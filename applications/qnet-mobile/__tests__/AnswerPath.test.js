/**
 * The light node's answer to the network (05.10 owner round): no 30-120 minute waits after a failure, only short retries
 * before the epoch's commit (B-1); every answer belongs to its own epoch: none inside an epoch's closing gap and nothing
 * carried into the next one (G-1); every push of an owner's rounds answered while the epoch is not counted, none after
 * (R-a, P-1); a lost push address sent again (P-2); every answer to a push carrying when it was sent, taken and answered
 * (E-1), and the record of the pushes before it (F-2); and the Node tab saying why the last missed epoch was missed (the
 * status contract's device.last_miss and device.last_answer).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Platform, Text } from 'react-native';

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
const messaging = require('@react-native-firebase/messaging').default;
const { lightShardOwnerUrls } = require('../src/config/nodes');
const Push = require('../src/services/PushService');
const { readNodeStatus, latestMiss, latestAnswer, freshMiss, MISS_REASONS } = require('../src/services/LightNode');
const NodeTab = require('../src/screens/NodeTab').default;
const { missText, nodeView } = require('../src/screens/NodeTab');
const { makeT } = require('../src/i18n');
const translations = require('../src/i18n/translations').default;

const t = makeT('en');
const NODE = 'light_mobile_83afab763b9058fd'; // shard 3: owners 004, 005, 001
const OWNERS = lightShardOwnerUrls(NODE);
const SEQ = 1790000000;
const E = 14400;
const HASH = 'ab'.repeat(32);
const EPOCH = 200;
const at = (offset, epoch = EPOCH) => epoch * E + offset;
const HOLD = 'qnet_self_attest_hold';
const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const hold = async () => JSON.parse(await AsyncStorage.getItem(HOLD));
const posts = () => calls.filter((c) => c.url.endsWith('/api/v1/light-node/ping-response'));
const sec = (ms = Date.now()) => Math.floor(ms / 1000);

let calls;
// What a genesis answers: (url, body) => a JSON body, an Error (no connection), or { status, body }.
let answers;
let platform;
let appState;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  platform = Platform.OS;
  appState = AppState.currentState;
  AppState.currentState = 'background';
  Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
  calls = [];
  answers = (url) => (url.endsWith('/api/v1/height') ? { height: at(1000) }
    : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : { success: true }));
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body);
    if (a instanceof Error) return Promise.reject(a);
    if (a && a.hang) {
      return new Promise((_, reject) => opts && opts.signal && opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (a && a.slow) return new Promise((resolve) => setTimeout(() => resolve(reply(a.body)), a.slow));
    if (a && a.status) return reply(a.body, a.status);
    return reply(a);
  });
});
afterEach(() => {
  Platform.OS = platform;
  AppState.currentState = appState;
  jest.restoreAllMocks();
});

const linked = async () => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType: 'fcm', seq: SEQ })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, 'pk'],
    [`qnet_ping_cert_${NODE}`, `v2.${SEQ}.cert`],
  ]);
};
const push = (offset, more = {}) => Push.handlePushMessage({ action: 'epoch', anchor: `${at(offset)}:${HASH}`, ...more });
const refuseAll = () => {
  answers = (url) => (url.endsWith('/ping-response') ? { success: false, error: 'Invalid quantum signature' }
    : (url.endsWith('/api/v1/height') ? { height: at(1000) } : { previous_hash: new Array(32).fill(7) }));
};
const downAll = () => { answers = () => new Error('Network request failed'); };

describe('B-1: no long hold after a failure, short retries, no blind retries after a refusal', () => {
  it('a failure that may pass is tried again in 1, 2, 4, then every 2.5 to 5 minutes, never the old 30 minutes to 2 hours', async () => {
    await linked();
    downAll();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const waits = [];
    for (let i = 0; i < 6; i++) {
      await Push.selfAttestIfNeeded(NODE);
      const h = await hold();
      expect(h).toMatchObject({ nodeId: NODE, kind: 'retry', tries: i + 1 });
      waits.push(h.until - h.at);
      // The wait is over: the next wake tries again.
      await AsyncStorage.setItem(HOLD, JSON.stringify({ ...h, at: Date.now() - 1, until: Date.now() - 1 }));
    }
    expect(waits.map((w) => Math.round(w / 1000))).toEqual([60, 120, 240, 300, 300, 300]);
    expect(Push.retryWaitMs(1, () => 1)).toBe(48000); // up to a fifth sooner, drawn per device
    expect(Push.retryWaitMs(4, () => 1)).toBe(150000); // from the fourth try, 2.5 to 5 minutes
    expect(Math.max(...[1, 2, 3, 4, 9, 50].map((n) => Push.retryWaitMs(n, Math.random)))).toBeLessThanOrEqual(5 * 60000);
    expect(Math.min(...[4, 9, 50].map((n) => Push.retryWaitMs(n, Math.random)))).toBeGreaterThanOrEqual(150000);
  });

  it('within the wait a background wake sends nothing; the wait over, it tries again', async () => {
    await linked();
    downAll();
    await Push.selfAttestIfNeeded(NODE);
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a hold an older build wrote after a failure (up to 2 hours) is void: the next wake answers', async () => {
    await linked();
    await AsyncStorage.setItem(HOLD, JSON.stringify({ nodeId: NODE, at: Date.now() - 1000, until: Date.now() + 7000000, failures: 3 }));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it('a delivered push is answered at once through a failure\'s wait and through a refusal\'s', async () => {
    await linked();
    for (const kind of ['retry', 'refused']) {
      await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
      await AsyncStorage.setItem(HOLD, JSON.stringify({ nodeId: NODE, kind, epoch: EPOCH, at: Date.now(), until: Date.now() + 3600000, tries: 2 }));
      calls = [];
      expect(await push(1000)).toBe(true);
      expect(posts()).toHaveLength(1);
      expect(posts()[0].body.challenge).toBe(`selfattest:${at(1000)}:${HASH}`);
    }
  });

  it('a refusal for good waits for the next push or an open, with no retry scheduled', async () => {
    await linked();
    Platform.OS = 'android';
    refuseAll();
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    // Every owner and the node that answered the height read refused it: a refusal, not a failure to retry.
    expect(posts().map((c) => c.url.split('/api/')[0])).toEqual(expect.arrayContaining(OWNERS));
    expect(await hold()).toMatchObject({ kind: 'refused' });
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false); // a background wake
    expect(calls).toEqual([]);
    // An open within a minute of the refusal sends nothing new; later it answers again.
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(false);
    expect(calls).toEqual([]);
    const h = await hold();
    await AsyncStorage.setItem(HOLD, JSON.stringify({ ...h, at: Date.now() - 61000 }));
    answers = (url) => (url.endsWith('/api/v1/height') ? { height: at(1000) } : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : { success: true }));
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
  });

  it('one owner refusing while another cannot be reached is a failure to retry soon, not a refusal', async () => {
    await linked();
    answers = (url) => {
      if (url.endsWith('/api/v1/height')) return { height: at(1000) };
      if (url.includes('/microblock/')) return { previous_hash: new Array(32).fill(7) };
      return url.startsWith(OWNERS[0]) ? { success: false, error: 'Invalid quantum signature' } : new Error('down');
    };
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry', tries: 1 });
  });

  it('a server error is a failure to retry; a rate limit waits at least what it asks', async () => {
    await linked();
    answers = (url) => (url.endsWith('/ping-response') ? { status: 503, body: { success: false, error: 'Invalid quantum signature' } }
      : (url.endsWith('/api/v1/height') ? { height: at(1000) } : { previous_hash: new Array(32).fill(7) }));
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry' });
    await AsyncStorage.removeItem(HOLD);
    answers = (url) => (url.endsWith('/ping-response') ? { success: false, error: 'Rate limit exceeded', retry_after_seconds: 900 }
      : (url.endsWith('/api/v1/height') ? { height: at(1000) } : { previous_hash: new Array(32).fill(7) }));
    const before = Date.now();
    await Push.selfAttestIfNeeded(NODE);
    const h = await hold();
    expect(h.kind).toBe('retry');
    expect(h.until - before).toBeGreaterThanOrEqual(900000);
  });

  it('the counted hold stays: nothing more is sent in an epoch this device was counted in', async () => {
    await linked();
    expect(await push(1000)).toBe(true);
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(await push(1060)).toBe(false);
    expect(posts()).toEqual([]);
    expect(await hold()).toMatchObject({ kind: 'counted', epoch: EPOCH });
  });

  it('Android sets a one-shot wake for the next try and drops it once counted; iOS has none', async () => {
    await linked();
    Platform.OS = 'android';
    downAll();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await Push.selfAttestIfNeeded(NODE);
    expect(BackgroundFetch.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: Push.ANSWER_RETRY_TASK, periodic: false, forceAlarmManager: true, enableHeadless: true, stopOnTerminate: false,
    }));
    const delay = BackgroundFetch.scheduleTask.mock.calls[0][0].delay;
    expect(delay).toBeGreaterThan(55000);
    expect(delay).toBeLessThanOrEqual(60000);
    answers = (url) => (url.endsWith('/ping-response') ? { success: true } : {});
    expect(await push(1000)).toBe(true);
    expect(BackgroundFetch.stop).toHaveBeenCalledWith(Push.ANSWER_RETRY_TASK);
    BackgroundFetch.scheduleTask.mockClear();
    Platform.OS = 'ios';
    await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
    downAll();
    await Push.selfAttestIfNeeded(NODE);
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
  });

  it('an owner that does not answer costs a push only a few seconds: the next owner is asked meanwhile', async () => {
    await linked();
    answers = (url) => (url.startsWith(OWNERS[0]) && url.endsWith('/ping-response') ? { hang: true } : { success: true });
    const started = Date.now();
    expect(await push(1000)).toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(Push.HEDGE_MS - 50);
    expect(elapsed).toBeLessThan(Push.HEDGE_MS + 2000);
    expect(posts().map((c) => c.url.split('/api/')[0])).toEqual([OWNERS[0], OWNERS[1]]);
    // One signature for every owner asked.
    expect(posts()[0].body.signature).toBe(posts()[1].body.signature);
  });

  it('once a try failed, the next owner is asked later (HEDGE_RETRY_MS), still within one wake', async () => {
    await linked();
    await AsyncStorage.setItem(HOLD, JSON.stringify({ nodeId: NODE, kind: 'retry', epoch: EPOCH, tries: 2, at: Date.now() - 2, until: Date.now() - 1 }));
    let first = true;
    answers = (url) => {
      if (!url.endsWith('/ping-response')) return url.endsWith('/api/v1/height') ? { height: at(1000) } : { previous_hash: new Array(32).fill(7) };
      if (url.startsWith(OWNERS[0]) && first) { first = false; return { slow: 3500, body: { success: true } }; }
      return { success: true };
    };
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(posts().map((c) => c.url.split('/api/')[0])).toEqual([OWNERS[0]]);
  });

  it('a 503 that names Retry-After is a rate limit: its wait is kept, within the epoch', async () => {
    await linked();
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/ping-response')) {
        return Promise.resolve({ ok: false, status: 503, headers: { get: (k) => (k === 'Retry-After' ? '120' : null) }, json: () => Promise.resolve({}) });
      }
      return reply(url.endsWith('/api/v1/height') ? { height: at(1000) } : { previous_hash: new Array(32).fill(7) });
    });
    const before = Date.now();
    await Push.selfAttestIfNeeded(NODE);
    const h = await hold();
    expect(h).toMatchObject({ kind: 'retry' });
    expect(h.until - before).toBeGreaterThanOrEqual(120000);
  });

  it('after RETRY_MAX_TRIES failed tries no wake is set; a push still answers', async () => {
    await linked();
    Platform.OS = 'android';
    downAll();
    await AsyncStorage.setItem(HOLD, JSON.stringify({ nodeId: NODE, kind: 'retry', epoch: null, tries: Push.RETRY_MAX_TRIES, at: Date.now() - 2, until: Date.now() - 1 }));
    BackgroundFetch.scheduleTask.mockClear();
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry', tries: Push.RETRY_MAX_TRIES + 1, wake: false });
    expect(BackgroundFetch.scheduleTask.mock.calls.filter((c) => c[0].taskId === Push.ANSWER_RETRY_TASK)).toEqual([]);
    answers = (url) => (url.endsWith('/ping-response') ? { success: true } : {});
    expect(await push(1000)).toBe(true);
  });
});

describe('R-a, P-1: every push of the rounds answered while not counted, none after, no storm', () => {
  it('three pushes of a round that arrive together send one answer; later pushes of the counted epoch send none', async () => {
    await linked();
    // A round's pushes are 15 slots apart; a system that held them back delivers them together.
    const r = await Promise.all([push(1000), push(1900), push(2800)]);
    expect(r.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(posts()).toHaveLength(1);
    calls = [];
    // The retry round an hour after the first push, and the backup owner's round.
    for (const offset of [4600, 5500, 6400]) expect(await push(offset)).toBe(false);
    expect(posts()).toEqual([]);
  });

  it("a push launch's own round reading the chain does not hold the push's answer back, nor undo it", async () => {
    await linked();
    answers = (url) => (url.endsWith('/api/v1/height') ? { hang: true } : { success: true });
    const launch = Push.selfAttestIfNeeded(NODE); // the launch's round, stuck on its height read
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    expect(await push(1000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(posts()).toHaveLength(1);
    expect(await launch).toBe(false); // its read timed out
    expect(await hold()).toMatchObject({ kind: 'counted', epoch: EPOCH });
  });

  it('each push of a round is answered while the earlier ones failed', async () => {
    await linked();
    downAll();
    expect(await push(1000)).toBe(false);
    const sent = posts().length;
    expect(sent).toBeGreaterThan(0);
    answers = (url) => (url.endsWith('/ping-response') ? { success: true } : {});
    calls = [];
    expect(await push(1060)).toBe(true); // a later push, answered after the earlier one failed, through the failure's wait
    expect(posts()).toHaveLength(1);
  });
});

describe('G-1: every answer belongs to its own epoch; inside the closing gap nothing is answered, and nothing is carried', () => {
  const GAP = E - Push.COMMIT_WINDOW_BLOCKS - Push.GAP_MARGIN_BLOCKS; // the gap's first block in an epoch
  const chainAt = (height) => {
    answers = (url) => (url.endsWith('/api/v1/height') ? { height }
      : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : { success: true }));
  };
  // The chain at `height`, every answer failing on its way; `readAt` when the height was last read.
  let readAt = 0;
  const answersFail = (height) => {
    answers = (url) => {
      if (url.endsWith('/api/v1/height')) {
        readAt = Date.now();
        return { height };
      }
      return url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : new Error('down');
    };
  };
  // Every timer longer than any request's cap: a wake set for later (the answer's timer).
  const longTimers = (spy) => spy.mock.calls.map((c) => c[1]).filter((ms) => Number.isFinite(ms) && ms > 30000);

  it('the gap is the commit window plus the margin, to the epoch\'s end', () => {
    expect(Push.COMMIT_WINDOW_BLOCKS).toBe(150);
    expect(Push.inAnswerGap(at(GAP - 1))).toBe(false);
    expect(Push.inAnswerGap(at(GAP))).toBe(true);
    expect(Push.inAnswerGap(at(E - 1))).toBe(true);
    expect(Push.inAnswerGap(at(0, EPOCH + 1))).toBe(false);
    expect(Push.GAP_JITTER_MS).toBeUndefined(); // no wait past the next epoch's start exists any more
  });

  it('a wake inside the gap answers nothing and sets, holds and schedules nothing for the next epoch', async () => {
    await linked();
    Platform.OS = 'android';
    AppState.currentState = 'active';
    const timers = jest.spyOn(global, 'setTimeout');
    chainAt(at(14300));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(posts()).toEqual([]);
    expect(await hold()).toBeNull();
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
    expect(longTimers(timers)).toEqual([]);
    expect(await AsyncStorage.getItem('qnet_last_self_attest_epoch')).toBeNull();
    expect(await AsyncStorage.getItem(Push.LAST_ANSWER_KEY)).toBeNull();
    // An open, a background fetch and a push of the closing epoch inside the gap: nothing goes out either.
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(false);
    await Push.onBackgroundFetch('t-gap');
    expect(await push(14300)).toBe(false);
    expect(posts()).toEqual([]);
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
    expect(longTimers(timers)).toEqual([]);
  });

  it('the next epoch is answered by a wake inside it, with a block of that epoch', async () => {
    await linked();
    chainAt(at(14300));
    await Push.selfAttestIfNeeded(NODE);
    chainAt(at(70, EPOCH + 1));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.challenge).toBe(`selfattest:${at(68, EPOCH + 1)}:${'07'.repeat(32)}`);
    expect(await AsyncStorage.getItem('qnet_last_self_attest_epoch')).toBe(String(EPOCH + 1));
  });

  it('a hold an older build wrote to answer after the next epoch started is void', async () => {
    await linked();
    await AsyncStorage.setItem(HOLD, JSON.stringify({ nodeId: NODE, kind: 'gap', epoch: EPOCH, at: Date.now(), until: Date.now() + 100000 }));
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it('a pushed anchor inside the gap is not answered; one before it is', async () => {
    await linked();
    expect(await push(14260)).toBe(false);
    expect(posts()).toEqual([]);
    expect(await hold()).toBeNull();
    expect(await push(14200)).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it('an owner\'s word that the epoch is closed ends the round: nothing counted, no other owner, nothing set for later', async () => {
    await linked();
    Platform.OS = 'android';
    // `epoch_closed`, and `epoch_closing` from a genesis of an earlier release, whose next-epoch height is not read.
    for (const r of [{ success: false, counted: false, reason: 'epoch_closed' },
      { success: false, counted: false, reason: 'epoch_closing', next_epoch_height: (EPOCH + 1) * E, retry_after_seconds: 40 },
      { success: true, reason: 'epoch_closing', next_epoch_height: (EPOCH + 1) * E }]) {
      await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch', Push.LAST_ANSWER_KEY]);
      answers = (url) => (url.endsWith('/ping-response') ? r : {});
      calls = [];
      expect(await push(14200)).toBe(false);
      expect(posts()).toHaveLength(1);
      expect(await hold()).toBeNull();
      expect(await AsyncStorage.getItem('qnet_last_self_attest_epoch')).toBeNull();
      expect(await AsyncStorage.getItem(Push.LAST_ANSWER_KEY)).toBeNull();
      expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
    }
    // A reply that names a next epoch and no closing is an ordinary answer: its height is not read.
    await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
    answers = (url) => (url.endsWith('/ping-response') ? { success: true, next_epoch_height: (EPOCH + 1) * E } : {});
    expect(await push(14200)).toBe(true);
    expect(await hold()).toMatchObject({ kind: 'counted', epoch: EPOCH });
  });

  it('no answer ever goes for an epoch other than the chain\'s, and none while the chain is inside the gap', async () => {
    await linked();
    let tip = 0;
    const seen = [];
    answers = (url, body) => {
      if (url.endsWith('/api/v1/height')) return { height: tip };
      if (url.includes('/microblock/')) return { previous_hash: new Array(32).fill(7) };
      if (url.endsWith('/ping-response')) {
        const anchored = Number(body.challenge.split(':')[1]);
        seen.push({ anchorEpoch: Math.floor(anchored / E), chainEpoch: Math.floor(tip / E), gap: Push.inAnswerGap(tip) });
      }
      return { success: true };
    };
    const offsets = [3, 1000, 7000, 14000, GAP - 30, GAP - 1, GAP, GAP + 40, 14399];
    for (const epoch of [EPOCH, EPOCH + 1]) {
      for (const off of offsets) {
        tip = at(off, epoch);
        await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
        await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true });
        await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
        await Push.handlePushMessage({ action: 'epoch', anchor: `${tip - 2}:${HASH}` });
        await AsyncStorage.multiRemove([HOLD, 'qnet_last_self_attest_epoch']);
        await Push.selfAttestIfNeeded(NODE, true); // "I'm back"
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(2 * 3 * 6);
    for (const s of seen) expect(s).toEqual({ anchorEpoch: s.chainEpoch, chainEpoch: s.chainEpoch, gap: false });
  });

  it('a retry comes before the gap, the last one just before it, also when a rate limit asks for longer; none past it', async () => {
    await linked();
    Platform.OS = 'android';
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const delays = () => BackgroundFetch.scheduleTask.mock.calls.map((c) => c[0].delay);
    // 45 blocks before the gap: the 60 s wait is cut to the last moment before it.
    answersFail(at(GAP - 45));
    await Push.selfAttestIfNeeded(NODE);
    let h = await hold();
    expect(h).toMatchObject({ kind: 'retry', wake: true });
    // At one block a second from the height read, the gap starts 45 s later at the earliest.
    expect(h.until - readAt).toBeLessThanOrEqual(45000 - Push.RETRY_GAP_LEAD_MS + 50);
    expect(h.until - readAt).toBeGreaterThanOrEqual(45000 - Push.RETRY_GAP_LEAD_MS - 50);
    expect(delays()[0]).toBeLessThanOrEqual(45000 - Push.RETRY_GAP_LEAD_MS);
    // 5 blocks before the gap: no try fits, none is set.
    BackgroundFetch.scheduleTask.mockClear();
    await AsyncStorage.removeItem(HOLD);
    answersFail(at(GAP - 5));
    await Push.selfAttestIfNeeded(NODE);
    expect(await hold()).toMatchObject({ kind: 'retry', wake: false });
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
    // A rate limit that asks past the gap: the epoch's last try still comes before it (an answer of this epoch belongs
    // to it), at a time drawn per device within LAST_TRY_SPREAD_MS of the last moment.
    await AsyncStorage.removeItem(HOLD);
    answers = (url) => (url.endsWith('/ping-response') ? { success: false, error: 'Rate limit exceeded', retry_after_seconds: 900 }
      : (url.endsWith('/api/v1/height') ? { height: at(14000) } : { previous_hash: new Array(32).fill(7) }));
    const before = Date.now();
    await Push.selfAttestIfNeeded(NODE);
    h = await hold();
    expect(h).toMatchObject({ kind: 'retry', wake: true });
    const lastTry = (GAP - 14000) * 1000 - Push.RETRY_GAP_LEAD_MS;
    expect(h.until - before).toBeLessThanOrEqual(lastTry + 50);
    expect(h.until - before).toBeGreaterThanOrEqual(Math.min(lastTry - Push.LAST_TRY_SPREAD_MS, 60000) - 50);
    expect(BackgroundFetch.scheduleTask).toHaveBeenCalledTimes(1);
    BackgroundFetch.scheduleTask.mockClear();
    // Far from the gap the waits stay as they are.
    await AsyncStorage.removeItem(HOLD);
    answersFail(at(1000));
    await Push.selfAttestIfNeeded(NODE);
    expect(delays()[0]).toBeGreaterThan(55000);
  });

  it('a fresh read at an epoch\'s first blocks answers with a block of that epoch, never the one before', async () => {
    await linked();
    answers = (url) => (url.endsWith('/api/v1/height') ? { height: at(1, EPOCH + 1) }
      : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : { success: true }));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    expect(calls.some((c) => c.url.endsWith(`/api/v1/microblock/${at(0, EPOCH + 1) + 1}`))).toBe(true);
    expect(posts()[0].body.challenge.startsWith(`selfattest:${at(0, EPOCH + 1)}:`)).toBe(true);
  });

  it('a push the provider held past its epoch is answered for the epoch the chain is in, with nothing held from the old one', async () => {
    await linked();
    // Sent in the epoch before, taken now; the owner refuses its anchor as stale.
    answers = (url, body) => {
      if (url.endsWith('/api/v1/height')) return { height: at(500, EPOCH + 1) };
      if (url.includes('/microblock/')) return { previous_hash: new Array(32).fill(7) };
      return body.challenge.startsWith(`selfattest:${at(14000)}:`)
        ? { success: false, reason: 'anchor_not_current', error: 'Invalid or stale self-attest anchor' } : { success: true };
    };
    const sent = sec() - 3 * 3600;
    expect(await push(14000, { sent_at: String(sent) })).toBe(true);
    const anchors = posts().map((p) => Number(p.body.challenge.split(':')[1]));
    expect(anchors[0]).toBe(at(14000));
    expect(anchors[anchors.length - 1]).toBe(at(498, EPOCH + 1));
    expect(anchors.every((a) => a === at(14000) || a === at(498, EPOCH + 1))).toBe(true);
    expect(await AsyncStorage.getItem('qnet_last_self_attest_epoch')).toBe(String(EPOCH + 1));
  });

  it('the counted hold a held push leaves ends by the push\'s own send time, not by when it came', async () => {
    await linked();
    // Taken now, sent two hours ago at block 1000: the epoch can end in about 1.7 h, not 3.7 h.
    const sent = sec() - 7200;
    expect(await push(1000, { sent_at: String(sent) })).toBe(true);
    const h = await hold();
    expect(h.kind).toBe('counted');
    expect(h.until - h.at).toBeLessThanOrEqual((E - 1002 - 7200) * 1000 + 2000);
  });
});

describe('E-1: every answer to a push says when the push was sent, taken and answered', () => {
  it('the push\'s sent_at, the time this device took it and the time it answered, as strings', async () => {
    await linked();
    const before = sec();
    expect(await push(1000, { sent_at: '1800000000' })).toBe(true);
    const body = posts()[0].body;
    expect(body.sent_at).toBe('1800000000');
    expect(typeof body.received_at).toBe('string');
    expect(typeof body.answered_at).toBe('string');
    expect(Number(body.received_at)).toBeGreaterThanOrEqual(before);
    expect(Number(body.answered_at)).toBeGreaterThanOrEqual(Number(body.received_at));
    // The route reads a flat map of strings: nothing else rides along.
    for (const v of Object.values(body)) expect(typeof v).toBe('string');
  });

  it('a push without a readable sent_at sends the other two; an answer to no push sends none', async () => {
    for (const sentAt of [undefined, '12abc', '-5', '']) {
      await AsyncStorage.clear();
      await linked();
      calls = [];
      await push(1000, sentAt === undefined ? {} : { sent_at: sentAt });
      const body = posts()[0].body;
      expect(body.sent_at).toBeUndefined();
      expect(body.received_at).toMatch(/^\d+$/);
      expect(body.answered_at).toMatch(/^\d+$/);
    }
    await AsyncStorage.clear();
    await linked();
    calls = [];
    await Push.onBackgroundFetch('t1');
    const body = posts()[0].body;
    expect([body.sent_at, body.received_at, body.answered_at]).toEqual([undefined, undefined, undefined]);
  });

  it('a stamped challenge pushed by an older node carries it too', async () => {
    await linked();
    const stamp = '0'.repeat(32) + (sec() + 600).toString(16).padStart(16, '0') + '0'.repeat(32);
    await Push.handlePushMessage({ action: 'ping_response', challenge: stamp, node_id: NODE, response_url: OWNERS[1], sent_at: 1800000123 });
    expect(posts()[0].body).toMatchObject({ challenge: stamp, sent_at: '1800000123' });
    expect(posts()[0].url.startsWith(OWNERS[1])).toBe(true);
  });

  it('pushEvidence reads the push\'s own field and this device\'s clock', () => {
    expect(Push.pushEvidence({ sent_at: '1800000000' }, 1800000005999)).toEqual({ sentAt: 1800000000, receivedAt: 1800000005 });
    expect(Push.pushEvidence({ sent_at: 1800000000 }, 1000)).toEqual({ sentAt: 1800000000, receivedAt: 1 });
    expect(Push.pushEvidence({}, 1000)).toEqual({ sentAt: null, receivedAt: 1 });
    expect(Push.pushEvidence({ sent_at: '1e9' }, 1000).sentAt).toBeNull();
  });
});

describe('F-2: the pushes this device took, and what came of each, go with its next answer', () => {
  const Receipts = require('../src/services/PushReceipts');
  const { closedByUser } = require('../src/services/TaskState');
  const { bootMark } = require('../src/services/DeviceSecurity');
  const record = async () => JSON.parse(await AsyncStorage.getItem(Receipts.PUSH_RECEIPTS_KEY));
  const pushAt = (offset, epoch, more = {}) => Push.handlePushMessage({ action: 'epoch', anchor: `${at(offset, epoch)}:${HASH}`, ...more });
  const chainAt = (height, ping = () => ({ success: true })) => {
    answers = (url, body) => (url.endsWith('/api/v1/height') ? { height }
      : (url.includes('/microblock/') ? { previous_hash: new Array(32).fill(7) } : ping(url, body)));
  };
  const receiptsOf = (body) => (body.push_receipts === undefined ? undefined : JSON.parse(body.push_receipts));

  it('records each push with when it was sent and taken, and what came of it; the next answer reports the epochs before it', async () => {
    await linked();
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true); // the first read: the record covers the epochs after it
    expect(await record()).toMatchObject({ nodeId: NODE, since: EPOCH + 1 });
    const sent = (e) => String(1800000000 + e);
    // Swiped away since it was last opened.
    closedByUser.mockResolvedValue(true);
    expect(await pushAt(1000, EPOCH + 1, { sent_at: sent(1) })).toBe(false);
    closedByUser.mockResolvedValue(false);
    // EPOCH + 2: no push reached this device.
    // Not opened since the device started.
    bootMark.mockResolvedValue({ boot: 1, mono: 5, boots: 7 });
    expect(await pushAt(1000, EPOCH + 3, { sent_at: sent(3) })).toBe(false);
    bootMark.mockResolvedValue(null);
    // Taken inside its epoch's closing gap.
    expect(await pushAt(14300, EPOCH + 4, { sent_at: sent(4) })).toBe(false);
    // No owner took the answer.
    chainAt(at(1000, EPOCH + 5), () => ({ success: false, error: 'Rate limit exceeded', retry_after_seconds: 60 }));
    expect(await pushAt(1000, EPOCH + 5, { sent_at: sent(5) })).toBe(false);
    // Answered; a later push of the same epoch keeps it so.
    chainAt(at(1000, EPOCH + 6));
    expect(await pushAt(1000, EPOCH + 6, { sent_at: sent(6) })).toBe(true);
    expect(await pushAt(1060, EPOCH + 6, { sent_at: sent(66) })).toBe(false);
    const outcomes = Object.fromEntries((await record()).epochs.filter((e) => e.push).map((e) => [e.epoch - EPOCH, e.outcome]));
    expect(outcomes).toEqual({ 1: 'swiped', 3: 'not_opened_since_boot', 4: 'after_commit', 5: 'answer_failed', 6: 'answered' });
    // The next answer, of the epoch after, by an open of the app.
    await AsyncStorage.removeItem(HOLD);
    chainAt(at(2000, EPOCH + 7));
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
    const body = posts()[0].body;
    const report = receiptsOf(body);
    expect(report.since).toBe(EPOCH + 1);
    expect(report.pushes.map((p) => [p.epoch - EPOCH, p.outcome])).toEqual([
      [1, 'swiped'], [3, 'not_opened_since_boot'], [4, 'after_commit'], [5, 'answer_failed'], [6, 'answered'],
    ]);
    // The first push of an epoch dates it; this device's clock with the answer's own time, so a genesis cancels it out.
    expect(report.pushes.find((p) => p.epoch === EPOCH + 6).sent_at).toBe(1800000006);
    for (const p of report.pushes) expect(p.received_at).toBeLessThanOrEqual(Number(body.answered_at));
    expect(body.answered_at).toMatch(/^\d+$/);
    // A flat map of strings, as every genesis takes it; one of an earlier release ignores the field.
    for (const v of Object.values(body)) expect(typeof v).toBe('string');
    expect(body.push_receipts.length).toBeLessThan(2048);
  });

  it('a push taken after the chain left its epoch is reported after_commit by the answer of the epoch the chain is in', async () => {
    await linked();
    chainAt(at(1000));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(true);
    await AsyncStorage.removeItem(HOLD);
    const stale = `selfattest:${at(1000, EPOCH + 1)}:`;
    chainAt(at(500, EPOCH + 2), (url, body) => (body.challenge.startsWith(stale)
      ? { success: false, reason: 'anchor_not_current', error: 'Invalid or stale self-attest anchor' } : { success: true }));
    calls = [];
    expect(await pushAt(1000, EPOCH + 1, { sent_at: '1800000000' })).toBe(true);
    const fresh = posts().filter((p) => !p.body.challenge.startsWith(stale));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].body.challenge.startsWith(`selfattest:${at(498, EPOCH + 2)}:`)).toBe(true);
    expect(receiptsOf(fresh[0].body).pushes).toEqual([{
      epoch: EPOCH + 1, sent_at: 1800000000, received_at: expect.any(Number), outcome: 'after_commit',
    }]);
    expect((await record()).epochs.find((e) => e.epoch === EPOCH + 1).outcome).toBe('after_commit');
  });

  it('a push of an epoch already counted here is already_counted; one with no ping key here is no_key', async () => {
    await linked();
    await AsyncStorage.setItem('qnet_last_self_attest_epoch', String(EPOCH));
    expect(await push(1000)).toBe(false);
    expect((await record()).epochs).toEqual([{
      epoch: EPOCH, push: { sentAt: null, receivedAt: expect.any(Number) }, outcome: 'already_counted',
    }]);
    Keychain.getGenericPassword.mockResolvedValue(null);
    expect(await pushAt(1000, EPOCH + 1)).toBe(false);
    expect((await record()).epochs.find((e) => e.epoch === EPOCH + 1).outcome).toBe('no_key');
  });

  it('an answer reports nothing before the first epoch it read, nor when every epoch it covers was answered here', async () => {
    await linked();
    chainAt(at(1000));
    await Push.selfAttestIfNeeded(NODE);
    expect(receiptsOf(posts()[0].body)).toBeUndefined();
    expect(posts()[0].body.answered_at).toBeUndefined();
    // EPOCH + 1 answered by its push, EPOCH + 2 by an open: every covered epoch answered, nothing to report.
    expect(await pushAt(1000, EPOCH + 1)).toBe(true);
    expect(receiptsOf(posts()[1].body)).toBeUndefined();
    await AsyncStorage.removeItem(HOLD);
    chainAt(at(1000, EPOCH + 2));
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
    expect(receiptsOf(posts()[2].body)).toBeUndefined();
    expect(posts()[2].body.answered_at).toBeUndefined();
    // EPOCH + 3 neither pushed nor answered here: the answer in EPOCH + 4 says no push of it reached this device.
    await AsyncStorage.removeItem(HOLD);
    chainAt(at(1000, EPOCH + 4));
    expect(await Push.selfAttestIfNeeded(NODE, false, undefined, null, { opened: true })).toBe(true);
    expect(receiptsOf(posts()[3].body)).toEqual({
      since: EPOCH + 1,
      pushes: [{
        epoch: EPOCH + 1, sent_at: null, received_at: expect.any(Number), outcome: 'answered',
      }],
    });
  });

  it('a stamped challenge an older node pushes carries no record', async () => {
    await linked();
    await Receipts.noteEpochSeen(NODE, EPOCH - 3);
    const stamp = '0'.repeat(32) + (sec() + 600).toString(16).padStart(16, '0') + '0'.repeat(32);
    await Push.handlePushMessage({ action: 'ping_response', challenge: stamp, node_id: NODE, response_url: OWNERS[1] });
    expect(posts()[0].body.push_receipts).toBeUndefined();
    expect((await record()).epochs).toEqual([]);
  });

  it('the record is small and bounded, never claims an epoch it may have missed, and goes with the binding', async () => {
    await linked();
    await Receipts.noteEpochSeen(NODE, 99);
    await Receipts.noteEpochSeen(NODE, 500); // a record exists: a later read changes nothing
    expect(await record()).toMatchObject({ since: 100, epochs: [] });
    for (let e = 100; e < 130; e++) await Receipts.noteReceived(NODE, e, { sentAt: 1800000000 + e, receivedAt: 1800000100 + e });
    const rec = await record();
    expect(rec.epochs.length).toBeLessThanOrEqual(Receipts.REPORT_EPOCHS + 1);
    expect(rec.since).toBe(129 - Receipts.REPORT_EPOCHS);
    // A wake that ended before its outcome was noted reads as an answer that did not get through.
    const report = await Receipts.reportFor(NODE, 130);
    expect(report.since).toBe(130 - Receipts.REPORT_EPOCHS);
    expect(report.pushes).toHaveLength(Receipts.REPORT_EPOCHS);
    expect(report.pushes.every((p) => p.outcome === 'answer_failed' && p.epoch < 130)).toBe(true);
    // 'answered' is the last word of its epoch.
    await Receipts.noteAnswered(NODE, 128);
    await Receipts.noteOutcome(NODE, 128, 'swiped');
    await Receipts.noteReceived(NODE, 128, { sentAt: null, receivedAt: 1 });
    expect((await record()).epochs.find((e) => e.epoch === 128)).toMatchObject({ outcome: 'answered', push: { sentAt: 1800000128 } });
    // An outcome nobody defined, or another node's record, is not taken.
    await Receipts.noteOutcome(NODE, 127, 'battery');
    expect((await record()).epochs.find((e) => e.epoch === 127).outcome).toBeNull();
    expect(await Receipts.reportFor('light_mobile_other', 130)).toBeNull();
    // A record with an entry that cannot be read claims nothing: a push left out of it would read as one that never came.
    const kept = await record();
    await AsyncStorage.setItem(Receipts.PUSH_RECEIPTS_KEY, JSON.stringify({ ...kept, epochs: [...kept.epochs, { epoch: 129, push: 'x' }] }));
    expect(await Receipts.reportFor(NODE, 130)).toBeNull();
    await AsyncStorage.setItem(Receipts.PUSH_RECEIPTS_KEY, JSON.stringify(kept));
    expect((await Receipts.reportFor(NODE, 130)).since).toBe(124);
    // Unbinding ends it.
    await Push.teardownLightNode();
    expect(await AsyncStorage.getItem(Receipts.PUSH_RECEIPTS_KEY)).toBeNull();
  });
});

describe('P-2: a lost push address is sent again', () => {
  const miss = (reason, epoch = 210) => ({
    onChain: true, counted: { since: 20, counted: 10, last: 205 }, device: { lastAnswerEpoch: 205, state: 'online' },
    lastMiss: { epoch, reason, wokenAt: null, answeredAt: null, deliveryDelaySecs: null, refused: null },
  });

  it('a token the owners lost is replaced by a new one, which goes to the shard owners', async () => {
    await linked();
    await AsyncStorage.multiSet([['qnet_last_sent_fcm_token', 'tok-old'], ['qnet_last_token_refresh_ts', String(sec() - 7200)]]);
    messaging().getToken.mockResolvedValueOnce('tok-old').mockResolvedValueOnce('tok-new');
    expect(await Push.readdressIfOwed(NODE, miss('no_push_address'))).toBe(true);
    expect(messaging().deleteToken).toHaveBeenCalled();
    const refresh = calls.find((c) => c.url.endsWith('/api/v1/light-node/token-refresh'));
    expect(refresh.url.startsWith(OWNERS[0])).toBe(true);
    expect(refresh.body.device_token).toBe('tok-new');
    expect(await AsyncStorage.getItem('qnet_last_sent_fcm_token')).toBe('tok-new');
    expect(await AsyncStorage.getItem(Push.PUSH_READDRESS_KEY)).toBeNull();
  });

  it("an owner's signed push_reregister sends the token again before any epoch is missed", async () => {
    await linked();
    await AsyncStorage.multiSet([['qnet_last_sent_fcm_token', 'tok-old'], ['qnet_last_token_refresh_ts', String(sec() - 7200)]]);
    messaging().getToken.mockResolvedValueOnce('tok-old').mockResolvedValueOnce('tok-new');
    const status = {
      onChain: true, counted: { since: 20, counted: 19, last: 210 }, device: { lastAnswerEpoch: 210, state: 'online' },
      lastMiss: null, pushReregister: true,
    };
    expect(await Push.readdressIfOwed(NODE, status)).toBe(true);
    const refresh = calls.find((c) => c.url.endsWith('/api/v1/light-node/token-refresh'));
    expect(refresh.body.device_token).toBe('tok-new');
    expect(await AsyncStorage.getItem(Push.PUSH_READDRESS_KEY)).toBeNull();
    calls = [];
    expect(await Push.readdressIfOwed(NODE, { ...status, pushReregister: false })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the signed status says push_reregister when an owner that took it cannot push this device', async () => {
    const pub = { onchain_registered: true, device_bound: true, features: ['status_signed'], device: null };
    const sign = async () => ({ signer: 'ping', sig: 'ab' });
    for (const [flags, want] of [[[false, true, false], true], [[false, false, false], false]]) {
      global.fetch = jest.fn((url, opts) => {
        const i = OWNERS.findIndex((o) => url.startsWith(o));
        return reply(opts && opts.method === 'POST' ? { ...pub, success: true, binding_seq: SEQ, push_reregister: flags[i] } : pub);
      });
      expect((await readNodeStatus(NODE, { signStatus: sign })).pushReregister).toBe(want);
    }
    global.fetch = jest.fn(() => reply(pub));
    expect((await readNodeStatus(NODE)).pushReregister).toBeNull();
  });

  it('a polling binding sends a token when one is there now; a miss older than the last counted epoch asks nothing', async () => {
    await linked();
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType: 'polling', seq: SEQ }));
    expect(await Push.readdressIfOwed(NODE)).toBe(true);
    expect(JSON.parse(await AsyncStorage.getItem('qnet_light_node_info')).pushType).toBe('fcm');
    calls = [];
    expect(await Push.readdressIfOwed(NODE, miss('no_push_address', 200))).toBe(false);
    expect(calls).toEqual([]);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
  });
});

describe('the status contract: device.last_miss and device.last_answer, read strictly', () => {
  const view = (lastMiss, lastAnswer) => ({
    onchain_registered: true, device_bound: true, features: [],
    device: { platform: 'android', linked_since: 1790000000 - 3600, last_answer_epoch: 205, state: 'online', last_miss: lastMiss, last_answer: lastAnswer },
  });
  const read = async (byOwner) => {
    global.fetch = jest.fn((url) => reply(byOwner[OWNERS.findIndex((o) => url.startsWith(o))]));
    return readNodeStatus(NODE);
  };

  it('takes the highest epoch, the most specific at equal epochs, and the latest answer', async () => {
    const s = await read([
      view({ epoch: 210, reason: 'woken_no_answer', woken_at: 1800000000, answered_at: null, delivery_delay_secs: null, refused: null },
        { at: 1800000100, delivery_delay_secs: 4, handling_secs: 1 }),
      view({ epoch: 210, reason: 'answered_late', woken_at: 1800000000, answered_at: 1800009000, delivery_delay_secs: 8040, refused: null },
        { at: 1800009000, delivery_delay_secs: 8040, handling_secs: 2 }),
      view({ epoch: 209, reason: 'answer_refused', woken_at: null, answered_at: 1799990000, delivery_delay_secs: 3, refused: 'bad_signature' }, null),
    ]);
    expect(s.lastMiss).toEqual({
      epoch: 210, reason: 'answered_late', wokenAt: 1800000000, answeredAt: 1800009000, deliveryDelaySecs: 8040, refused: null,
      deliveredAt: null, appOutcome: null,
    });
    expect(s.lastAnswer).toEqual({ at: 1800009000, deliveryDelaySecs: 8040, handlingSecs: 2 });
    // The network's own misses: not_committed explains a miss whole, not_sent ranks under every reason about the device.
    expect(MISS_REASONS).toEqual(['not_committed', 'answered_late', 'not_delivered', 'answer_refused', 'woken_no_answer',
      'no_push_address', 'not_sent', 'not_woken_inactive']);
  });

  it('reads when the wake reached the device and what the app did with it; not_delivered ranks above a refusal', async () => {
    const s = await read([
      view({ epoch: 210, reason: 'woken_no_answer', woken_at: 1800000000, answered_at: null, delivery_delay_secs: 300,
        refused: null, delivered_at: 1800000300, app_outcome: 'not_opened_since_boot' }, null),
      view({ epoch: 210, reason: 'answer_refused', woken_at: null, answered_at: 1800000400, delivery_delay_secs: null, refused: 'superseded' }, null),
      view({ epoch: 209, reason: 'answered_late', woken_at: null, answered_at: 1799990000, delivery_delay_secs: null, refused: null }, null),
    ]);
    expect(s.lastMiss).toEqual({
      epoch: 210, reason: 'answer_refused', wokenAt: null, answeredAt: 1800000400, deliveryDelaySecs: null, refused: 'superseded',
      deliveredAt: null, appOutcome: null,
    });
    const t2 = await read([
      view({ epoch: 210, reason: 'woken_no_answer', woken_at: 1800000000, answered_at: null, delivery_delay_secs: 300,
        refused: null, delivered_at: 1800000300, app_outcome: 'swiped' }, null),
      view({ epoch: 210, reason: 'not_delivered', woken_at: 1800000000, answered_at: null, delivery_delay_secs: null,
        refused: null, delivered_at: null, app_outcome: null }, null),
      view({ epoch: 210, reason: 'answer_refused', woken_at: null, answered_at: 1800000400, delivery_delay_secs: null, refused: 'superseded' }, null),
    ]);
    expect(t2.lastMiss).toMatchObject({ epoch: 210, reason: 'not_delivered' });
    const one = await read([
      view({ epoch: 211, reason: 'woken_no_answer', woken_at: 1800000000, answered_at: null, delivery_delay_secs: 300,
        refused: null, delivered_at: 1800000300, app_outcome: 'swiped' }, null), view(null, null), view(null, null),
    ]);
    expect(one.lastMiss).toMatchObject({ reason: 'woken_no_answer', deliveredAt: 1800000300, deliveryDelaySecs: 300, appOutcome: 'swiped' });
    // An outcome of a later release is left out and the record kept; a field of another type refuses the record.
    const later = await read([view({ epoch: 211, reason: 'woken_no_answer', app_outcome: 'battery_saver' }, null), view(null, null), view(null, null)]);
    expect(later.lastMiss).toMatchObject({ reason: 'woken_no_answer', appOutcome: null });
    for (const bad of [{ app_outcome: 7 }, { delivered_at: 'noon' }, { delivered_at: -5 }]) {
      const r = await read([view({ epoch: 211, reason: 'woken_no_answer', ...bad }, null), view(null, null), view(null, null)]);
      expect(r.lastMiss).toBeNull();
    }
  });

  it('at an equal epoch and reason, the owner that took the account of the device wins: delivered_at first, then app_outcome', async () => {
    const plain = { epoch: 210, reason: 'woken_no_answer', woken_at: 1800000000, answered_at: null, delivery_delay_secs: null, refused: null };
    const outcomeOnly = { ...plain, app_outcome: 'swiped' };
    const dated = { ...plain, delivered_at: 1800000300, delivery_delay_secs: 300 };
    expect((await read([view(plain, null), view(outcomeOnly, null), view(null, null)])).lastMiss).toMatchObject({ appOutcome: 'swiped' });
    expect((await read([view(outcomeOnly, null), view(dated, null), view(plain, null)])).lastMiss)
      .toMatchObject({ deliveredAt: 1800000300, appOutcome: null });
    expect((await read([view(dated, null), view(outcomeOnly, null), view(plain, null)])).lastMiss).toMatchObject({ deliveredAt: 1800000300 });
    // The reason still decides first, and a later epoch before that.
    const late = { ...plain, reason: 'answered_late', answered_at: 1800009000 };
    expect((await read([view(dated, null), view(late, null), view(null, null)])).lastMiss).toMatchObject({ reason: 'answered_late' });
    expect((await read([view(dated, null), view({ ...plain, epoch: 211 }, null), view(null, null)])).lastMiss)
      .toMatchObject({ epoch: 211, deliveredAt: null });
  });

  it('an unknown reason, a field of another type, or none at all (an older node) gives nothing', async () => {
    for (const bad of [
      { epoch: 210, reason: 'phone_asleep' },
      { epoch: '210', reason: 'woken_no_answer' },
      { epoch: 210, reason: 'woken_no_answer', delivery_delay_secs: -1 },
      { epoch: 210, reason: 'woken_no_answer', woken_at: 'noon' },
      { epoch: 210, reason: 'answer_refused', refused: 'Bad Signature!' },
      [210, 'woken_no_answer'],
    ]) {
      const s = await read([view(bad, { at: 'x' }), view(bad, { at: 5, handling_secs: 1.5 }), view(undefined, undefined)]);
      expect(s.lastMiss).toBeNull();
      expect(s.lastAnswer).toBeNull();
    }
    expect(latestMiss([null, null])).toBeNull();
    expect(latestAnswer([])).toBeNull();
  });
});

describe('the Node tab\'s one line for the last missed epoch', () => {
  const status = (lastMiss, over = {}) => ({
    reachable: true, onChain: true, deviceBound: true, deviceBoundAgreed: true, answered: false, needsReactivation: false,
    counted: { since: 20, counted: 18, last: 205 }, device: { platform: 'ios', linkedSince: null, lastAnswerEpoch: 205, state: 'online' },
    deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, lastMiss, ...over,
  });
  const miss = (reason, over = {}) => ({ epoch: 210, reason, wokenAt: null, answeredAt: null, deliveryDelaySecs: null, refused: null, ...over });
  const local = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  it('says what happened, at the local time, how long the wake took to reach this device, and what to do', () => {
    const late = missText(t, status(miss('answered_late', { wokenAt: 1800000000, answeredAt: 1800009000, deliveryDelaySecs: 8040 })));
    expect(late).toBe([
      t('node_miss_late_at', { time: local(1800009000 * 1000) }), t('node_miss_delay', { n: 134 }), t('node_miss_do_background'),
    ].join(' '));
    expect(missText(t, status(miss('woken_no_answer', { wokenAt: 1800000000 }))))
      .toBe(`${t('node_miss_woken_at', { time: local(1800000000 * 1000) })} ${t('node_miss_do_background')}`);
    expect(missText(t, status(miss('answer_refused', { deliveryDelaySecs: 12 }))))
      .toBe(`${t('node_miss_refused')} ${t('node_miss_delay_short')} ${t('node_miss_do_use')}`);
    expect(missText(t, status(miss('not_woken_inactive')))).toBe(`${t('node_miss_inactive')} ${t('node_miss_do_open')}`);
    expect(missText(t, status(miss('no_push_address')))).toBe(`${t('node_miss_no_address')} ${t('node_miss_do_open_once')}`);
  });

  it('a wake the app\'s report accounted for says when it reached this device, how long it took, and why there was no answer', () => {
    const at0 = 1800000000;
    const reached = (over) => missText(t, status(miss('woken_no_answer', { wokenAt: at0, ...over })));
    const why = {
      not_opened_since_boot: 'node_miss_why_not_opened', swiped: 'node_miss_why_swiped', after_commit: 'node_miss_why_after_commit',
      answer_failed: 'node_miss_why_answer_failed', already_counted: 'node_miss_why_already_counted', no_key: 'node_miss_why_no_key',
    };
    for (const [outcome, key] of Object.entries(why)) {
      expect(reached({ deliveredAt: at0 + 600, deliveryDelaySecs: 600, appOutcome: outcome }))
        .toBe(t('node_miss_reached_after', { time: local((at0 + 600) * 1000), n: 10, why: t(key) }));
    }
    expect(reached({ deliveredAt: at0 + 20, deliveryDelaySecs: 20, appOutcome: 'swiped' }))
      .toBe(t('node_miss_reached_soon', { time: local((at0 + 20) * 1000), why: t('node_miss_why_swiped') }));
    expect(reached({ deliveredAt: at0 + 20, deliveryDelaySecs: null, appOutcome: 'swiped' }))
      .toBe(t('node_miss_reached_at', { time: local((at0 + 20) * 1000), why: t('node_miss_why_swiped') }));
    expect(reached({ deliveredAt: null, deliveryDelaySecs: null, appOutcome: 'swiped' }))
      .toBe(t('node_miss_reached', { why: t('node_miss_why_swiped') }));
    expect(t('node_miss_reached_after', { time: '14:05', n: 3, why: t('node_miss_why_not_opened') })).toBe(
      'The wake reached this device at 14:05, 3 min after it was sent, and the app did not answer: QNet Wallet had not been opened '
      + 'since the device restarted. Open it once after every restart.');
    // The app answered that wake: never said as "did not answer", and nothing for this device to change.
    expect(reached({ deliveredAt: at0 + 20, deliveryDelaySecs: 20, appOutcome: 'answered' })).toBe(t('node_miss_answered'));
    expect(t('node_miss_answered')).toBe('This device answered the wake, but the network did not count the answer in that epoch. '
      + 'Nothing needs doing on this device.');
    // The app's record shows no push of that epoch reached it.
    expect(missText(t, status(miss('not_delivered', { wokenAt: at0 }))))
      .toBe(`${t('node_miss_not_delivered')} ${t('node_miss_do_background')}`);
    expect(t('node_miss_not_delivered')).toBe('The wake never reached this device: the push service or the device held it.');
  });

  it('a wake this device could not answer for want of the node\'s key offers Use this device', () => {
    const L = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true };
    const view = (appOutcome) => nodeView({
      nodeId: NODE, status: status(miss('woken_no_answer', { appOutcome })), local: L, pending: null, check: null, height: at(3000, 211),
    });
    expect(view('no_key')).toMatchObject({ state: 'here', offerUse: true });
    expect(view('swiped')).toMatchObject({ state: 'here', offerUse: false });
  });

  it('nothing once the node was counted or answered in that epoch or later, and nothing without a record', () => {
    expect(missText(t, status(miss('woken_no_answer', { epoch: 205 })))).toBeNull();
    expect(missText(t, status(miss('woken_no_answer'), { device: { lastAnswerEpoch: 211, state: 'online' } }))).toBeNull();
    expect(missText(t, status(null))).toBeNull();
    expect(freshMiss(status(miss('woken_no_answer')))).toMatchObject({ epoch: 210 });
  });

  it('a miss this device accounted for stays once counted again, under its epoch and with the day of a time not today', () => {
    const at0 = 1800000000;
    const counted = { device: { platform: 'ios', linkedSince: null, lastAnswerEpoch: 212, state: 'online' }, counted: { since: 20, counted: 19, last: 211 } };
    const past = (over) => missText(t, status(miss('woken_no_answer', { wokenAt: at0, ...over }), counted), (at0 + 600) * 1000);
    const lead = t('node_miss_past', { epoch: 210 });
    expect(lead).toBe('Epoch 210 was not counted.');
    expect(past({ deliveredAt: at0 + 600, deliveryDelaySecs: 600, appOutcome: 'swiped' }))
      .toBe(`${lead} ${t('node_miss_reached_after', { time: local((at0 + 600) * 1000), n: 10, why: t('node_miss_why_swiped') })}`);
    const d = new Date((at0 + 600) * 1000);
    const dayOf = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(missText(t, status(miss('woken_no_answer', { wokenAt: at0, deliveredAt: at0 + 600, appOutcome: 'swiped' }), counted),
      (at0 + 3 * 86400) * 1000)).toBe(`${lead} ${t('node_miss_reached_at', { time: `${dayOf} ${local((at0 + 600) * 1000)}`, why: t('node_miss_why_swiped') })}`);
    expect(past({ appOutcome: 'answered' })).toBe(`${lead} ${t('node_miss_answered')}`);
    expect(missText(t, status(miss('not_delivered', { wokenAt: at0 }), counted), at0 * 1000))
      .toBe(`${lead} ${t('node_miss_not_delivered')} ${t('node_miss_do_background')}`);
    // Without the account of the device a miss counted since says nothing, nor does it offer Use this device.
    expect(past({})).toBeNull();
    for (const reason of ['answered_late', 'answer_refused', 'no_push_address', 'not_woken_inactive']) {
      expect(missText(t, status(miss(reason, { deliveredAt: at0 + 600, appOutcome: 'swiped' }), counted))).toBeNull();
    }
    const L = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true };
    expect(nodeView({ nodeId: NODE, status: status(miss('woken_no_answer', { appOutcome: 'no_key' }), counted), local: L, pending: null,
      check: null, height: at(3000, 212) })).toMatchObject({ state: 'here', offerUse: false });
    // A fresh miss keeps its words, with no epoch in front.
    expect(missText(t, status(miss('woken_no_answer', { wokenAt: at0, deliveredAt: at0 + 20, deliveryDelaySecs: 20, appOutcome: 'swiped' }))))
      .toBe(t('node_miss_reached_soon', { time: local((at0 + 20) * 1000), why: t('node_miss_why_swiped') }));
  });

  it('the line shows on this device\'s card, and a refused answer offers Use this device', async () => {
    const L = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: false };
    const light = { nodeId: NODE, status: status(miss('answer_refused')), local: L, pending: null, check: null, answeredAt: null, balanceNano: 0, device: null };
    expect(nodeView({ ...light, height: at(3000, 211) })).toMatchObject({ state: 'here', offerUse: true });
    let tree;
    await act(async () => {
      tree = renderer.create(<NodeTab t={t} light={light} height={at(3000, 211)} onMove={() => {}} onUse={() => {}} onCopy={() => {}} nodeTitle={() => ''} />);
    });
    const line = tree.root.find((n) => n.props.testID === 'node-miss' && n.type === Text);
    expect(line.props.children).toBe(`${t('node_miss_refused')} ${t('node_miss_do_use')}`);
    expect(tree.root.findAll((n) => n.props.testID === 'node-use' && typeof n.props.onPress === 'function').length).toBeGreaterThan(0);
    await act(async () => { tree.unmount(); });
  });

  it('every language has every text of the line, with the same placeholders, and no word of a price or a payout', () => {
    const keys = Object.keys(translations.en).filter((k) => k.startsWith('node_miss_'));
    expect(keys.length).toBe(30);
    const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of keys) {
        expect([lang, k, typeof table[k]]).toEqual([lang, k, 'string']);
        expect([lang, k, holes(table[k])]).toEqual([lang, k, holes(translations.en[k])]);
      }
    }
    expect(Object.keys(translations).length).toBe(11);
    const en = keys.map((k) => translations.en[k]).join(' ');
    expect(en).not.toMatch(/reward|burn|price|mining|\bcode\b|support|fault|blame|\bphone/i);
    // The sentence the app's report completes keeps its {why} in every language.
    for (const table of Object.values(translations)) {
      for (const k of ['node_miss_reached', 'node_miss_reached_at', 'node_miss_reached_after', 'node_miss_reached_soon']) {
        expect(table[k]).toContain('{why}');
      }
    }
  });
});

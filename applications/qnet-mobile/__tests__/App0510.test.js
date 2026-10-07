/**
 * The owner's 05.10 round on the app: "Log out" is Lock Wallet and locks at once (B1); no text asks the user to write to
 * support (B2); and one rule on every phone and tablet decides whether the light node answers (B3): only while the app
 * runs after it was opened since the device last started, and not swiped away since (services/AnswerGate).
 */
import fs from 'fs';
import path from 'path';
import { AppState } from 'react-native';

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

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const BackgroundFetch = require('react-native-background-fetch').default;
const TaskState = require('../src/services/TaskState');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const Gate = require('../src/services/AnswerGate');
const Push = require('../src/services/PushService');
const { makeT } = require('../src/i18n');

const t = makeT('en');
const LANGS = ['en', 'ru', 'de', 'es', 'fr', 'it', 'pt', 'ja', 'ko', 'zh-CN', 'ar'];
const NODE = 'light_mobile_83afab763b9058fd';
const SEQ = 1790000000;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const settle = () => new Promise((r) => setTimeout(r, 50));
const ANCHOR = `120:${'a'.repeat(64)}`;

// A device that started at wall time 1 000 000 000 000 and has run `mono` ms since; `boots` its start count.
const BOOT_AT = 1_000_000_000_000;
const clock = (mono, boots = 7, bootAt = BOOT_AT) => ({ boot: bootAt, mono, boots });
let calls;
let state;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  TaskState.closedByUser.mockResolvedValue(false);
  DeviceSecurity.bootMark.mockResolvedValue(clock(60_000));
  Keychain.getGenericPassword.mockResolvedValue(false);
  state = AppState.currentState;
  AppState.currentState = 'background';
  calls = [];
  global.fetch = jest.fn((url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return reply({ success: true });
  });
});
afterEach(() => { AppState.currentState = state; });

const linked = async () => {
  Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType: 'fcm', seq: SEQ, boundAt: SEQ })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, 'pk'],
    [`qnet_ping_cert_${NODE}`, `v2.${SEQ}.cert`],
  ]);
};
const answered = () => calls.some((c) => c.url.endsWith('/light-node/ping-response'));

describe('B1: Lock Wallet', () => {
  it('is the button\'s name in every language, and no "log out" text is left', () => {
    const names = {
      en: 'Lock Wallet', ru: 'Заблокировать кошелёк', de: 'Wallet sperren', es: 'Bloquear cartera',
      fr: 'Verrouiller le portefeuille', it: 'Blocca portafoglio', pt: 'Bloquear carteira', ja: 'ウォレットをロック',
      ko: '지갑 잠금', 'zh-CN': '锁定钱包', ar: 'قفل المحفظة',
    };
    for (const lang of LANGS) {
      const table = require(`../src/i18n/locales/${lang}`).default;
      expect([lang, table.lock_wallet]).toEqual([lang, names[lang]]);
      expect([lang, Object.keys(table).filter((k) => /logout/.test(k))]).toEqual([lang, []]);
    }
  });

  it('locks at once, the same lock as auto-lock, with no dialog and no line under it', () => {
    const ws = read('src/screens/WalletScreen.js');
    const from = ws.indexOf("{t('danger_zone')}");
    const button = ws.slice(from, ws.indexOf("{t('delete_wallet')}", from));
    expect(button).toMatch(/onPress=\{\(\) => lockSession\(\)\}\s*>\s*<Text style=\{\[styles\.actionButtonText, \{color: '#ff4444'\}\]\}>\{t\('lock_wallet'\)\}<\/Text>\s*<\/TouchableOpacity>/);
    expect(button).not.toMatch(/showAlert/);
  });
});

describe('B2: self-service, nothing to write to anyone', () => {
  it('no language asks the user to write to support or quote a reference', () => {
    for (const lang of LANGS) {
      const table = require(`../src/i18n/locales/${lang}`).default;
      const left = Object.keys(table).filter((k) => /support_ref|check_support/.test(k) || table[k].includes('{ref}'));
      expect([lang, left]).toEqual([lang, []]);
    }
    expect(t('node_paused', { date: '2026-10-05' })).toBe('The node is paused on this device until 2026-10-05.');
  });
});

describe('B3: the node answers only while the app runs, opened since the device started and not swiped away', () => {
  describe('sameBoot', () => {
    const mark = clock(60_000);

    it('two start counts decide exactly, whatever the wall clock did', () => {
      expect(Gate.sameBoot(mark, clock(3_600_000))).toBe(true);
      expect(Gate.sameBoot(mark, clock(3_600_000, 7, BOOT_AT + 5 * 60_000))).toBe(true); // a time correction
      expect(Gate.sameBoot(mark, clock(3_600_000, 8))).toBe(false); // started again
    });

    it('a boot clock below the mark\'s is a new boot, counts or not', () => {
      expect(Gate.sameBoot(mark, clock(59_999))).toBe(false);
      expect(Gate.sameBoot({ ...mark, boots: -1 }, clock(59_999, -1))).toBe(false);
    });

    it('without two counts, the two starts within the tolerance', () => {
      const a = { ...mark, boots: -1 };
      expect(Gate.sameBoot(a, clock(86_400_000, -1, BOOT_AT + Gate.BOOT_TOLERANCE_MS))).toBe(true);
      expect(Gate.sameBoot(a, clock(86_400_000, -1, BOOT_AT - Gate.BOOT_TOLERANCE_MS))).toBe(true);
      expect(Gate.sameBoot(a, clock(86_400_000, -1, BOOT_AT + Gate.BOOT_TOLERANCE_MS + 1))).toBe(false);
      // A restart a day later, with a longer uptime than the mark's: its start is a day later.
      expect(Gate.sameBoot(a, clock(120_000, -1, BOOT_AT + 86_400_000))).toBe(false);
      // One side without a count falls back to the starts.
      expect(Gate.sameBoot(mark, clock(120_000, -1, BOOT_AT + 1000))).toBe(true);
    });

    // L-8: iOS keeps no start count but names the boot by its session id, so a clock set by more than the tolerance
    // no longer stops the node there either.
    it('two boot ids decide exactly, whatever the wall clock did, as two counts do', () => {
      const ID = 'ab'.repeat(16);
      const ios = (mono, bootAt, bootId) => ({ ...clock(mono, -1, bootAt), bootId });
      const a = ios(60_000, BOOT_AT, ID);
      expect(Gate.sameBoot(a, ios(3_600_000, BOOT_AT + 10 * 60_000, ID))).toBe(true); // clock set ten minutes on
      expect(Gate.sameBoot(a, ios(3_600_000, BOOT_AT - 86_400_000, ID))).toBe(true); // or a day back
      expect(Gate.sameBoot(a, ios(3_600_000, BOOT_AT + 1000, 'cd'.repeat(16)))).toBe(false); // started again
      expect(Gate.sameBoot(a, ios(59_999, BOOT_AT, ID))).toBe(false); // a boot clock below the mark's
      // A mark noted before the boot id, or an id that is not one, falls back to the starts.
      expect(Gate.sameBoot({ ...a, bootId: null }, ios(3_600_000, BOOT_AT + 1000, ID))).toBe(true);
      expect(Gate.sameBoot({ ...a, bootId: null }, ios(3_600_000, BOOT_AT + Gate.BOOT_TOLERANCE_MS + 1, ID))).toBe(false);
      expect(Gate.sameBoot({ ...a, bootId: 'x' }, ios(3_600_000, BOOT_AT + Gate.BOOT_TOLERANCE_MS + 1, 'x'))).toBe(false);
    });

    it('the boot id is read from the native clock only in its own form, and iOS reads the boot session id', async () => {
      const native = { bootClock: jest.fn(async () => ({ mono: 5, wall: 10, bootId: 'ab'.repeat(16) })) };
      let actual;
      jest.isolateModules(() => {
        jest.doMock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: { QNetSecurity: native } }));
        actual = jest.requireActual('../src/services/DeviceSecurity');
        jest.dontMock('react-native');
      });
      expect(await actual.bootMark()).toEqual({ boot: 5, mono: 5, boots: -1, bootId: 'ab'.repeat(16) });
      native.bootClock.mockResolvedValue({ mono: 5, wall: 10, boots: 3, bootId: 'not-an-id' });
      expect(await actual.bootMark()).toEqual({ boot: 5, mono: 5, boots: 3, bootId: null });
      native.bootClock.mockResolvedValue({ mono: 5, wall: 10, boots: 3 });
      expect(await actual.bootMark()).toEqual({ boot: 5, mono: 5, boots: 3, bootId: null });
      const m = read('ios/QNetMobile/QNetSecurityModule.m');
      expect(m).toMatch(/sysctlbyname\("kern\.bootsessionuuid"/);
      const clockFn = m.slice(m.indexOf('RCT_EXPORT_METHOD(bootClock:'), m.indexOf('RCT_EXPORT_METHOD(deviceModel:'));
      expect(clockFn).toMatch(/reading\[@"bootId"\] = bootId/);
    });

    it('anything unreadable is not the same boot', () => {
      expect(Gate.sameBoot(null, clock(1))).toBe(false);
      expect(Gate.sameBoot(mark, null)).toBe(false);
      expect(Gate.sameBoot(7, clock(1))).toBe(false);
      expect(Gate.sameBoot({ boot: 'x', mono: 1 }, clock(1))).toBe(false);
    });
  });

  describe('mayAnswer', () => {
    it('the app in front answers and notes this boot as opened', async () => {
      AppState.currentState = 'active';
      expect(await Gate.mayAnswer()).toBe(true);
      expect(JSON.parse(await AsyncStorage.getItem(Gate.OPENED_BOOT_KEY))).toEqual(clock(60_000));
      expect(TaskState.closedByUser).not.toHaveBeenCalled();
    });

    it('in the background: only after an open in this boot', async () => {
      expect(await Gate.mayAnswer()).toBe(false); // never opened (a restart, or an update never opened)
      await Gate.noteOpen();
      DeviceSecurity.bootMark.mockResolvedValue(clock(7_200_000));
      expect(await Gate.mayAnswer()).toBe(true); // in the background, behind the lock: the same boot
      DeviceSecurity.bootMark.mockResolvedValue(clock(30_000, 8, BOOT_AT + 9_000_000));
      expect(await Gate.mayAnswer()).toBe(false); // started again, not opened since
      await Gate.noteOpen();
      expect(await Gate.mayAnswer()).toBe(true);
    });

    it('swiped away since the last open: no answer, whatever the boot', async () => {
      await Gate.noteOpen();
      TaskState.closedByUser.mockResolvedValue(true);
      expect(await Gate.mayAnswer()).toBe(false);
    });

    it('a build whose boot clock does not answer cannot tell, so the node answers; nothing is noted then', async () => {
      DeviceSecurity.bootMark.mockResolvedValue(null);
      expect(await Gate.mayAnswer()).toBe(true);
      AppState.currentState = 'active';
      await Gate.mayAnswer();
      expect(await AsyncStorage.getItem(Gate.OPENED_BOOT_KEY)).toBe(null);
      DeviceSecurity.bootMark.mockRejectedValue(new Error('no module'));
      AppState.currentState = 'background';
      expect(await Gate.mayAnswer()).toBe(true);
    });

    it('a mark that cannot be read is no open', async () => {
      await AsyncStorage.setItem(Gate.OPENED_BOOT_KEY, '{broken');
      expect(await Gate.mayAnswer()).toBe(false);
    });
  });

  describe('every answer path asks', () => {
    it('after a restart a push and a background wake send nothing until the app is opened; then they answer', async () => {
      await linked();
      AppState.currentState = 'active';
      await Gate.noteOpen();
      AppState.currentState = 'background';
      DeviceSecurity.bootMark.mockResolvedValue(clock(30_000, 8, BOOT_AT + 9_000_000)); // restarted
      expect(await Push.handlePushMessage({ action: 'wake', anchor: ANCHOR })).toBe(false);
      expect(await Push.handlePushMessage({ action: 'ping_response', challenge: 'ab'.repeat(40), node_id: NODE })).toBe(false);
      await Push.onBackgroundFetch('task-1');
      expect(BackgroundFetch.finish).toHaveBeenCalledWith('task-1');
      expect(await Push.selfAttestIfNeeded(NODE, true)).toBe(false);
      expect(await Push.respondToChallenge(NODE, 'ab'.repeat(40), null)).toBe(false);
      expect(calls).toEqual([]);
      // A refused round leaves no back-off: the first round after the open runs.
      expect(await AsyncStorage.getItem('qnet_self_attest_hold')).toBe(null);
      await Gate.noteOpen();
      await Push.handlePushMessage({ action: 'wake', anchor: ANCHOR });
      expect(answered()).toBe(true);
    });

    // The first launch in this file: the return-to-app subscription is registered once per process.
    it('a launch in the background holds its answer and upkeep until the app comes to the front', async () => {
      await linked();
      let resume = null;
      const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
        if (type === 'change') resume = handler;
        return { remove: jest.fn() };
      });
      try {
        await Push.initializePushService(); // iOS: a push launched the app after a restart
        await settle();
        expect(BackgroundFetch.configure).toHaveBeenCalled(); // the wakes stay configured
        expect(calls).toEqual([]);
        expect(typeof resume).toBe('function');
        AppState.currentState = 'active';
        resume('active');
        await settle();
        expect(JSON.parse(await AsyncStorage.getItem(Gate.OPENED_BOOT_KEY))).toEqual(clock(60_000));
        expect(calls.some((c) => c.url.endsWith('/api/v1/height'))).toBe(true); // the held self-attest
        expect(calls.some((c) => c.url.includes('/light-node/status'))).toBe(true); // the held status read
      } finally {
        spy.mockRestore();
      }
    });

    it('a launch the rule allows runs its work at once, as before', async () => {
      await linked();
      await Gate.noteOpen(); // opened earlier in this boot; the system ended the process meanwhile
      await Push.initializePushService();
      await settle();
      expect(calls.some((c) => c.url.endsWith('/api/v1/height'))).toBe(true);
    });

    it('a launch in front is an open, with no node linked yet', async () => {
      AppState.currentState = 'active';
      await Push.initializePushService();
      expect(JSON.parse(await AsyncStorage.getItem(Gate.OPENED_BOOT_KEY))).toEqual(clock(60_000));
      AppState.currentState = 'background';
      await AsyncStorage.clear();
      await Push.initializePushService();
      expect(await AsyncStorage.getItem(Gate.OPENED_BOOT_KEY)).toBe(null);
    });

    it('no wake survives a restart on Android: the app configures them again when it is opened', async () => {
      await linked();
      AppState.currentState = 'active';
      await Push.initializePushService();
      expect(BackgroundFetch.configure).toHaveBeenCalledWith(
        expect.objectContaining({ stopOnTerminate: false, startOnBoot: false, enableHeadless: true }), expect.any(Function), expect.any(Function),
      );
    });
  });

  describe('the boot clock', () => {
    it('DeviceSecurity.bootMark: the start from wall minus mono, the count where the system keeps one, null without a clock', async () => {
      expect(await jest.requireActual('../src/services/DeviceSecurity').bootMark()).toBe(null); // no native module here
      const bootClock = jest.fn(async () => ({ mono: 5000, wall: 1_000_005_000, boots: 12 }));
      let bootMark;
      jest.isolateModules(() => {
        require('react-native').NativeModules.QNetSecurity = { bootClock };
        ({ bootMark } = jest.requireActual('../src/services/DeviceSecurity'));
      });
      expect(await bootMark()).toEqual({ boot: 1_000_000_000, mono: 5000, boots: 12, bootId: null });
      bootClock.mockResolvedValueOnce({ mono: 5000, wall: 1_000_005_000 });
      expect(await bootMark()).toEqual({ boot: 1_000_000_000, mono: 5000, boots: -1, bootId: null });
      bootClock.mockResolvedValueOnce({ mono: -1, wall: 1_000_005_000 });
      expect(await bootMark()).toBe(null);
      bootClock.mockRejectedValueOnce(new Error('no'));
      expect(await bootMark()).toBe(null);
    });

    it('Android reports the system\'s start count with the boot clock; iOS has the clock that counts in sleep', () => {
      const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
      expect(kt).toMatch(/^import android\.provider\.Settings$/m);
      expect(kt).toMatch(/fun bootClock\(promise: Promise\) \{[\s\S]*?map\.putDouble\("mono", SystemClock\.elapsedRealtime\(\)\.toDouble\(\)\)[\s\S]*?Settings\.Global\.getInt\(reactContext\.contentResolver, Settings\.Global\.BOOT_COUNT, -1\)[\s\S]*?map\.putDouble\("boots", boots\.getOrDefault\(-1\)\.toDouble\(\)\)\s*promise\.resolve\(map\)/);
      const m = read('ios/QNetMobile/QNetSecurityModule.m');
      expect(m).toMatch(/clock_gettime\(CLOCK_MONOTONIC, &ts\);/);
      // Reading the boot clock is declared for its one use: elapsed time between the app's own events.
      const privacy = read('ios/QNetMobile/PrivacyInfo.xcprivacy');
      expect(privacy).toMatch(/NSPrivacyAccessedAPICategorySystemBootTime<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>35F9\.1<\/string>/);
    });

    it('the same rule on both platforms: one gate, asked by the shared push service', () => {
      const push = read('src/services/PushService.js');
      expect(push).toMatch(/^import \{ mayAnswer, noteOpen \} from '\.\/AnswerGate';$/m);
      expect(push).not.toMatch(/closedByUser/);
      expect(push.match(/if \(!\(await mayAnswer\(\)\)\)/g)).toHaveLength(4);
      expect(fs.existsSync(path.join(ROOT, 'src/services/AnswerGate.android.js'))).toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'src/services/AnswerGate.ios.js'))).toBe(false);
    });
  });
});

describe('B4: the node balance never reads 0 from a refusal', () => {
  it('a refusal body or an answer without the figure is a failed read, a real answer is taken', async () => {
    global.fetch = jest.fn(() => reply({ success: false, error: 'rate limited' }));
    expect((await Push.getPendingRewards(NODE)).success).toBe(false);
    global.fetch = jest.fn(() => reply({ is_claimable: true }));
    expect((await Push.getPendingRewards(NODE)).success).toBe(false);
    global.fetch = jest.fn(() => reply({ pending_rewards_nano: 4714356375000, is_claimable: true }));
    expect(await Push.getPendingRewards(NODE)).toMatchObject({ success: true, pendingRewards: 4714356375000, isClaimable: true });
  });
});

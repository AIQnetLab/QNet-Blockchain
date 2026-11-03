/**
 * The owner's 04.10 round on the app: a swiped-away app answers nothing (A6), a deleted wallet's node stops for good
 * (A2), the lock screen offers no erase next to Unlock (A1), History is split by network with one compact row and a
 * detail screen (A4), and the Node tab decides where the node runs by the binding sequence (A5).
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { NativeModules, Text, TouchableOpacity } from 'react-native';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn().mockResolvedValue('ab'.repeat(8)),
}));
jest.mock('../src/services/TaskState', () => ({ closedByUser: jest.fn(async () => false) }));

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const BackgroundFetch = require('react-native-background-fetch').default;
const messaging = require('@react-native-firebase/messaging').default;
const TaskState = require('../src/services/TaskState');
const Push = require('../src/services/PushService');
const { makeT } = require('../src/i18n');

const t = makeT('en');
const NODE = 'light_mobile_83afab763b9058fd';
const SEQ = 1790000000;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
let calls;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  TaskState.closedByUser.mockResolvedValue(false);
  Keychain.getGenericPassword.mockResolvedValue(false);
  calls = [];
  global.fetch = jest.fn((url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return reply({ success: true });
  });
});

const linked = async (seq = SEQ) => {
  Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType: 'fcm', seq, boundAt: seq })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, 'pk'],
    [`qnet_ping_cert_${NODE}`, `v2.${seq}.cert`],
  ]);
};

describe('A6: an app swiped away from the recent apps answers nothing until it is opened', () => {
  it('a push and a background wake send nothing while the mark is set; once opened they answer again', async () => {
    await linked();
    TaskState.closedByUser.mockResolvedValue(true);
    expect(await Push.handlePushMessage({ action: 'wake', anchor: `120:${'a'.repeat(64)}` })).toBe(false);
    expect(await Push.handlePushMessage({ action: 'ping_response', challenge: 'ab'.repeat(40), node_id: NODE })).toBe(false);
    await Push.onBackgroundFetch('task-1');
    expect(BackgroundFetch.finish).toHaveBeenCalledWith('task-1');
    expect(calls).toEqual([]);
    // Opened again: the same push is answered (the device self-attests over the pushed anchor).
    TaskState.closedByUser.mockResolvedValue(false);
    await Push.handlePushMessage({ action: 'wake', anchor: `120:${'a'.repeat(64)}` });
    expect(calls.some((c) => c.url.endsWith('/light-node/ping-response'))).toBe(true);
  });

  it('Android keeps the mark natively: set by the task watch or the record of a removed task, cleared on open', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/TaskState.kt');
    // The watch's removal is a swipe only if its process then ends: the system's trim of the recent apps also calls
    // onTaskRemoved and ends no process (RemovalMarks, android/app/src/test/.../TaskStateTest.kt).
    expect(kt).toMatch(/override fun onTaskRemoved\(rootIntent: Intent\?\) \{\s*TaskState\.removed\(this\)/);
    expect(kt).toMatch(/fun removed\(context: Context\) \{\s*marks\(context\)\.mark\(\)\s*\}/);
    expect(kt).toMatch(/private fun markClosed\(context: Context\)/);
    expect(kt.match(/markClosed\(context\)/g)).toHaveLength(1);
    // The exit record: the user asked for it, and its own sub-reason or, without one, its description says so
    // (removedTaskExit, android/app/src/test/.../TaskStateTest.kt).
    expect(kt).toMatch(/it\.timestamp > since && removedTaskExit\(it\.reason, it\.toString\(\), it\.description\)/);
    expect(kt).toMatch(/internal const val EXIT_SUBREASON_REMOVE_TASK = 22/);
    expect(kt).toMatch(/override fun getName\(\): String = "QNetTaskState"/);
    expect(kt).toMatch(/if \(inFront\) return false/);
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(activity).toMatch(/TaskState\.opened\(this\)\s*TaskState\.watch\(this\)/);
    expect(activity).toMatch(/super\.onPause\(\)\s*TaskState\.left\(\)/);
    // One way to start the watch, for the open app and for every answer path in the background.
    expect(activity).not.toMatch(/startService/);
    expect(kt.match(/startService\(/g)).toHaveLength(1);
    expect(kt).toMatch(/val closed = TaskState\.closedByUser\(reactApplicationContext\)\s*if \(!closed\) TaskState\.watch\(reactApplicationContext\)/);
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/<service\s+android:name="\.TaskWatchService"\s+android:exported="false"\s+android:stopWithTask="false" \/>/);
    expect(read('android/app/src/main/java/com/qnetmobile/DilithiumPackage.kt')).toMatch(/TaskStateModule\(reactContext\)/);
  });

  it('Android 7-10: a finishing activity whose task left the recent apps, in a process that then ended, is a swipe', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/TaskState.kt');
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(activity).toMatch(/override fun onDestroy\(\) \{\s*if \(isFinishing && !isChangingConfigurations\) TaskState\.finished\(this\)\s*super\.onDestroy\(\)/);
    const finished = kt.slice(kt.indexOf('fun finished(activity: Activity)'), kt.indexOf('private fun taskGone'));
    expect(finished).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R\) return/);
    // The mark is made first; Back (the task still listed) takes it back at once.
    expect(finished.indexOf('marks(context).mark()')).toBeGreaterThan(-1);
    expect(finished.indexOf('marks(context).mark()')).toBeLessThan(finished.indexOf('taskGone(context)'));
    expect(finished).toMatch(/if \(!taskGone\(context\)\) mark\.delete\(\)/);
    // One way to make a mark, for the watch and the activity: a process that outlives the settle time takes it back.
    expect(kt.match(/createNewFile\(\)/g)).toHaveLength(1);
    expect(kt).toMatch(/later\(REMOVAL_SETTLE_MS\) \{ mark\.delete\(\) \}/);
    expect(kt).toMatch(/Handler\(Looper\.getMainLooper\(\)\)\.postDelayed\(takeBack, ms\)/);
    // Only a mark another process left counts, on every version, and opening the app clears every one.
    expect(kt).toMatch(/if \(swipedAway\(\{ removalOutlived\(context\) \}, \{ endedWithRemovedTask\(context, p\.getLong\(OPENED_AT, 0L\)\) \}\)\) \{\s*markClosed\(context\)/);
    expect(kt).toMatch(/fun opened\(context: Context\) \{[^}]*marks\(context\)\.clear\(\)/);
    // Android 7 sets no background limit: a watch only background answers started stops itself after the minute.
    expect(kt).toMatch(/if \(watchStopsItself\(Build\.VERSION\.SDK_INT, startedInFront\)\) main\.postDelayed\(stop, BACKGROUND_WATCH_MS\)/);
    expect(kt).toMatch(/startedInFront = startedInFront \|\| TaskState\.inFront/);
  });

  // A swipe that cannot be told for sure is answered. A task missing from the recent apps is what the system's own trim
  // leaves too, and some phones trim within minutes of the app leaving the front.
  it('Android: a task missing from the recent apps alone is never a swipe; only the two sure signs are', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/TaskState.kt');
    expect(kt).toMatch(/internal fun swipedAway\(removalMark: \(\) -> Boolean, removedTaskRecord: \(\) -> Boolean\): Boolean =\s*removalMark\(\) \|\| removedTaskRecord\(\)/);
    // An ask never reads the recent apps; only a finishing activity on Android 7 to 10 does, for its removal mark.
    const ask = kt.slice(kt.indexOf('fun closedByUser('), kt.indexOf('fun removed('));
    expect(ask).not.toMatch(/taskGone|appTasks/);
    expect(kt.match(/taskGone\(context\)/g)).toHaveLength(1);
    expect(kt.match(/appTasks/g)).toHaveLength(1);
    // Nothing notes when the app left the front but the activity's own flag, and no recent-apps setting is read.
    expect(kt).not.toMatch(/LEFT_AT|LEFT_BOOTS|KeepWindow|recentsKeepMs|activeTaskDuration|maxNumVisibleRecentTasks|getRecentTasks/);
    expect(kt).toMatch(/fun left\(\) \{\s*inFront = false\s*\}/);
  });

  it('one JS reader on both platforms answers the native mark; a build without it, or an error, never stops a node', async () => {
    // The same module, QNetTaskState, on Android (TaskState.kt) and iOS (TaskState.swift): no per-platform JS file.
    expect(fs.readdirSync(path.join(ROOT, 'src/services')).filter((f) => f.startsWith('TaskState'))).toEqual(['TaskState.js']);
    const { closedByUser } = jest.requireActual('../src/services/TaskState');
    NativeModules.QNetTaskState = { closedByUser: jest.fn(async () => true) };
    try {
      expect(await closedByUser()).toBe(true);
      NativeModules.QNetTaskState.closedByUser.mockResolvedValueOnce(false);
      expect(await closedByUser()).toBe(false);
      NativeModules.QNetTaskState.closedByUser.mockRejectedValueOnce(new Error('no'));
      expect(await closedByUser()).toBe(false);
    } finally {
      delete NativeModules.QNetTaskState;
    }
    expect(await closedByUser()).toBe(false);
  });

  // Why the app's last process ended, for the node's logs: Android 11+ keeps a record of it; iOS keeps none, and nothing
  // is made up for it.
  it('why the app\'s last process ended: Android\'s record in the fixed words with its API level, nothing elsewhere', async () => {
    const { lastExit, EXIT_REASONS } = jest.requireActual('../src/services/TaskState');
    expect(EXIT_REASONS).toEqual(['crash', 'anr', 'low_memory', 'system_killed', 'user_closed', 'swiped', 'other', 'unknown']);
    NativeModules.QNetTaskState = { lastExit: jest.fn(async () => ({ reason: 'anr', at: 1_800_000_000_000, api: 34 })) };
    try {
      expect(await lastExit(5)).toEqual({ reason: 'anr', at: 1_800_000_000_000, api: 34 });
      expect(NativeModules.QNetTaskState.lastExit).toHaveBeenCalledWith(5);
      for (const bad of [null, { reason: 'killed_by_magic', at: 1, api: 34 }, { reason: 'crash', at: 1.5, api: 34 }, { reason: 'crash', at: 1 }]) {
        NativeModules.QNetTaskState.lastExit.mockResolvedValueOnce(bad);
        expect(await lastExit()).toBe(null);
      }
      NativeModules.QNetTaskState.lastExit.mockRejectedValueOnce(new Error('no'));
      expect(await lastExit()).toBe(null);
      // iOS's module answers closedByUser only.
      NativeModules.QNetTaskState = { closedByUser: jest.fn(async () => false) };
      expect(await lastExit()).toBe(null);
    } finally {
      delete NativeModules.QNetTaskState;
    }
    const kt = read('android/app/src/main/java/com/qnetmobile/TaskState.kt');
    // One reader of the exit records, for the swipe and for this; the newest only, newer than the last one taken.
    expect(kt.match(/getHistoricalProcessExitReasons\(/g)).toHaveLength(1);
    expect(kt).toMatch(/exitRecords\(context, 1\)\.firstOrNull\(\)\?\.takeIf \{ it\.timestamp > sinceMs \}/);
    expect(kt).toMatch(/putInt\("api", Build\.VERSION\.SDK_INT\)/);
    const mapping = kt.slice(kt.indexOf('internal fun exitReasonName('), kt.indexOf('internal const val EXIT_SUBREASON_REMOVE_TASK'));
    expect([...new Set([...mapping.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))].sort()).toEqual([...EXIT_REASONS].sort());
    expect(read('ios/QNetMobile/QNetTaskState.m')).not.toMatch(/lastExit/);
  });

  it('iOS: a background launch after a close from the app switcher answers nothing; the app in front, and once opened, it does', async () => {
    const { AppState } = require('react-native');
    const gate = require('../src/services/AnswerGate');
    const state = AppState.currentState;
    // The gate asks the native module itself through the real TaskState.js.
    TaskState.closedByUser.mockImplementation(jest.requireActual('../src/services/TaskState').closedByUser);
    const mark = { closed: true };
    NativeModules.QNetTaskState = { closedByUser: jest.fn(async () => mark.closed) };
    try {
      AppState.currentState = 'background';
      expect(await gate.mayAnswer()).toBe(false);
      expect(await gate.heldBecause()).toBe('swiped');
      // In front it answers whatever the mark says; the scene's activation then clears the mark natively.
      AppState.currentState = 'active';
      expect(await gate.mayAnswer()).toBe(true);
      mark.closed = false;
      AppState.currentState = 'background';
      expect(await gate.heldBecause()).toBe(null);
      expect(await gate.mayAnswer()).toBe(true);
    } finally {
      AppState.currentState = state;
      delete NativeModules.QNetTaskState;
      TaskState.closedByUser.mockImplementation(async () => false);
    }
  });

  it('iOS keeps the mark natively: set when UIKit reports the closed scene, cleared when the scene becomes active', () => {
    const app = read('ios/QNetMobile/AppDelegate.swift');
    // A report that comes once the user's open is already active is no close (TaskState.kt's inFront, here).
    expect(app).toMatch(/func application\(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>\) \{\s*guard application\.applicationState != \.active else \{ return \}\s*QNetTaskState\.markClosed\(\)\s*\}/);
    const scene = read('ios/QNetMobile/SceneDelegate.swift');
    expect(scene).toMatch(/func sceneDidBecomeActive\(_ scene: UIScene\) \{[^}]*QNetTaskState\.opened\(\)\s*\}/);
    expect(`${app}\n${scene}`.match(/QNetTaskState\.(markClosed|opened)\(\)/g)).toEqual(['QNetTaskState.markClosed()', 'QNetTaskState.opened()']);
    // Kept across processes in the app's own defaults, one key; the module has Android's name and shape.
    const swift = read('ios/QNetMobile/TaskState.swift');
    expect(swift).toMatch(/@objc\(QNetTaskState\)\s*class QNetTaskState: NSObject \{/);
    expect(swift.match(/"qnet_closed_by_user"/g)).toHaveLength(1);
    expect(swift).toMatch(/static func markClosed\(\) \{\s*UserDefaults\.standard\.set\(true, forKey: closedKey\)/);
    expect(swift).toMatch(/static func opened\(\) \{\s*UserDefaults\.standard\.set\(false, forKey: closedKey\)/);
    expect(swift).toMatch(/@objc\(closedByUser:rejecter:\)\s*func closedByUser\(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock\) \{\s*resolve\(UserDefaults\.standard\.bool\(forKey: QNetTaskState\.closedKey\)\)/);
    const m = read('ios/QNetMobile/QNetTaskState.m');
    expect(m).toMatch(/@interface RCT_EXTERN_MODULE\(QNetTaskState, NSObject\)/);
    expect(m).toMatch(/RCT_EXTERN_METHOD\(closedByUser:\(RCTPromiseResolveBlock\)resolve\s*rejecter:\(RCTPromiseRejectBlock\)reject\)/);
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    for (const f of ['SceneDelegate.swift', 'TaskState.swift', 'QNetTaskState.m']) {
      expect([f, pbx.includes(`/* ${f} in Sources */,`)]).toEqual([f, true]);
    }
    // The app has no wake other than the push and the periodic fetch (no VoIP push).
    const plist = read('ios/QNetMobile/Info.plist');
    const modes = /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
    expect([...modes.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).sort()).toEqual(['fetch', 'remote-notification']);
    expect(plist).not.toMatch(/voip|PushKit/i);
  });
});

describe('A2: deleting the wallet stops its node for good', () => {
  it('the ping key signs the unbind, then the device stops at once: keys, device key, token and wakes, before the answer', async () => {
    await linked();
    let answer;
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return url.endsWith('/light-node/unbind') ? new Promise((resolve) => { answer = resolve; }) : reply({ success: true });
    });
    const forget = jest.spyOn(require('../src/services/NodeDeviceKey'), 'forgetKeys');
    const r = await Push.stopLightNode({ waitForNetwork: false, forgetDevice: true });
    expect(r.unbound).toBe(null);
    // Signed and on its way; meanwhile nothing of the node is left here.
    expect(calls.find((c) => c.url.endsWith('/light-node/unbind')).body).toMatchObject({ node_id: NODE, seq: SEQ, signer: 'ping' });
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBe(null);
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: `qnet_ping_sk_${NODE}` });
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(BackgroundFetch.stop).toHaveBeenCalled();
    expect(forget).toHaveBeenCalled();
    answer({ ok: true, json: async () => ({ success: true, unbound: true }) });
    expect(await r.sent).toBe(true);
    forget.mockRestore();
  });

  it('a push token Firebase is slow to give back never holds the delete', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      await linked();
      messaging().deleteToken.mockImplementationOnce(() => new Promise(() => {}));
      let done = false;
      Push.teardownLightNode().then(() => { done = true; });
      for (let i = 0; i < 20 && !done; i++) {
        await jest.advanceTimersByTimeAsync(500);
      }
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the screen: progress first, the local wipe before the network\'s answer, then the next screen with no notice', () => {
    const ws = read('src/screens/WalletScreen.js');
    const erase = ws.slice(ws.indexOf('const eraseWallet = async'), ws.indexOf('// Settings → Delete wallet'));
    expect(erase).toMatch(/setErasing\(true\);[\s\S]*stopLightNode\(\{ waitForNetwork: false, forgetDevice: true \}\)[\s\S]*eraseAllData\(\)[\s\S]*await Promise\.resolve\(sent\)/);
    expect(erase).toMatch(/finally \{\s*setErasing\(false\);/);
    expect(ws).toMatch(/\{erasing \? <Text style=\{\[styles\.subtitle, styles\.markLine\]\}>\{t\('deleting_wallet'\)\}<\/Text> : null\}/);
    // Delete (the screen lock, the password) ends on the welcome screen, erase on the import.
    const doors = ws.slice(ws.indexOf('// Settings → Delete wallet'), ws.indexOf('// Terms of Service Modal'));
    expect(doors.match(/await eraseWallet\(\);\s*\} catch/g)).toHaveLength(3);
    expect(doors).toMatch(/return;\s*\}\s*\/\/[^\n]*\n\s*await startImport\(\);\s*\};/);
    expect(['wallet_deleted', 'erased_title', 'erased_body'].filter(require('../src/i18n').hasKey)).toEqual([]);
  });
});

describe('A1: the lock screen', () => {
  const ws = read('src/screens/WalletScreen.js');
  const lock = ws.slice(ws.indexOf('  if (!wallet) {\n    const lockoutSec'), ws.indexOf('  const renderTabContent = () => {'));

  it('no erase choice next to Unlock; a small "Forgot?" link opens its own confirmation, never under the system prompt', () => {
    expect(lock).not.toMatch(/erase_and_restore/);
    expect(lock).toMatch(/\{deviceAuth && unlockPrompting \? null : \(\s*<Action\s+kind="quiet"\s+align="center"\s+label=\{t\('unlock_forgot_reset'\)\}\s+onPress=\{\(\) => \{ setEraseText\(''\); setShowEraseConfirm\(true\); \}\}/);
    expect(lock).toMatch(/\{unlockPrompting \? null : \(/);
    expect(t('unlock_forgot_reset')).toBe('Forgot? Reset the wallet');
  });

  it('the system prompt opens by itself at every start and every lock; the welcome screen never shows before the wallet is read', () => {
    // The field with the focus lets go of it first (06.10: nothing is focused by itself), then the session closes.
    expect(ws).toMatch(/const lockSession = \(\) => \{\s*(\/\/[^\n]*\n\s*)*Keyboard\.dismiss\(\);\s*walletManager\.closeSession\(\);[\s\S]{0,200}setUnlockPrompting\(true\);/);
    expect(ws).toMatch(/if \(erasing \|\| !walletKnown\) \{/);
    expect(ws).toMatch(/later\(\(\) => \{\s*if \(autoUnlockOwedRef\.current && AppState\.currentState === 'active' && autoUnlockRef\.current\) autoUnlockRef\.current\(\);\s*\}, AUTO_UNLOCK_RECHECK_MS\);/);
  });
});

describe('A4: History', () => {
  const H = require('../src/screens/HistoryTab');
  const QNET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
  const OTHER = 'e'.repeat(45);
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join(''));

  it('amounts are written in the one amount format with few decimals, never a suffix, and never cut', () => {
    expect(H.compactAmount(0)).toBe('0');
    expect(H.compactAmount(1.5)).toBe('1.5');
    expect(H.compactAmount(12.345678)).toBe('12.3457');
    expect(H.compactAmount(0.000123456)).toBe('0.00012346');
    expect(H.compactAmount(0.000000001)).toBe('<0.00000001');
    expect(H.compactAmount(98765.4321)).toBe('98,765.43');
    expect(H.compactAmount(999.12341)).toBe('999.1234');
    expect(H.compactAmount(1234.5)).toBe('1,234.5');
    expect(H.compactAmount(123456.7)).toBe('123,456.7');
    expect(H.compactAmount(1234567.12345)).toBe('1,234,567');
    expect(H.compactAmount(9007199254.740993)).toBe('9,007,199,255');
    expect(H.compactAmount(4.2e15)).toBe('4,200,000,000,000,000');
    expect(H.compactDecimalText('1,234,567.891234')).toBe('1,234,568');
    for (const n of [0.12345678, 1e-9, 99999.9999, 123456789012.345, 1e18]) expect(H.compactAmount(n)).not.toMatch(/[KMBTe]/);
  });

  it('a row: what happened over its status and whom with, and the amount beside the title; the number shrinks only to fit', async () => {
    // A number that sits beside the title in a History card, its symbol on its line (HistoryTab fitsBeside).
    const tx = { hash: 'p'.repeat(64), from: QNET, to: OTHER, amount: 12345, fee: 0.00015, status: 'pending', timestamp: Date.UTC(2026, 9, 4, 12), type: 'send' };
    const onOpen = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<H.HistoryRow tx={tx} t={t} hideAmounts={false} onOpen={onOpen} />); });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([t('hist_sent'), '−12,345', ' QNC', t('hist_status_pending')]));
    expect(H.fitsBeside(H.describeTx(tx).legs[0])).toBe(true);
    const amount = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === '−12,345');
    expect(amount.props.numberOfLines).toBe(1);
    expect(tree.root.find((n) => n.props.testID === 'history-row-top' && typeof n.type === 'string').findAllByType(Text)).toContain(amount);
    const symbol = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === ' QNC');
    expect(symbol.props.ellipsizeMode).toBe('tail');
    await act(async () => { tree.root.find((n) => n.props.testID === 'history-row' && typeof n.props.onPress === 'function').props.onPress(); });
    expect(onOpen).toHaveBeenCalledWith(tx);
    // A Solana send is named by its symbol (no icon); a confirmed row shows no status line.
    const sol = { hash: 's'.repeat(88), chain: 'solana', from: 'a', to: 'b', solSymbol: 'SOL', solAmount: '0.5', solFee: '0.000005', status: 'confirmed', timestamp: 1, type: 'send' };
    await act(async () => { tree.update(<H.HistoryRow tx={sol} t={t} hideAmounts={false} onOpen={onOpen} />); });
    expect(tree.root.findAll((n) => n.props && n.props.source)).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['−0.5', ' SOL']));
    expect(texts(tree)).not.toContain(t('hist_status_confirmed'));
  });

  it('the detail screen: every field the app holds, the explorer for a QNet transaction in a block and a Solana one that ran', async () => {
    const tx = { hash: 'c'.repeat(64), from: QNET, to: OTHER, amount: 1234567.12345, fee: 0.00015, status: 'confirmed', timestamp: Date.UTC(2026, 9, 4, 12), type: 'send', block: 2345678 };
    const onExplorer = jest.fn();
    const onBack = jest.fn();
    const Clipboard = require('@react-native-clipboard/clipboard').default;
    let tree;
    await act(async () => { tree = renderer.create(<H.TxDetail tx={tx} t={t} onBack={onBack} onExplorer={onExplorer} />); });
    const shown = texts(tree).join('\n');
    for (const s of ['−1,234,567.12345 QNC', t('tx_detail_fee'), '0.00015 QNC', t('tx_detail_from'), QNET, t('tx_detail_to'), OTHER,
      t('tx_detail_time'), t('tx_label'), tx.hash, t('tx_detail_block'), '2345678', t('hist_status_confirmed')]) {
      expect([s, shown.includes(s)]).toEqual([s, true]);
    }
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-explorer').props.onPress(); });
    expect(onExplorer).toHaveBeenCalledWith(tx.hash, 'qnet');
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-back').props.onPress(); });
    expect(onBack).toHaveBeenCalled();
    const sol = { hash: 's'.repeat(88), chain: 'solana', from: 'a', to: 'b', solSymbol: '1DEV', solAmount: '12.5', solFee: '0.000005', status: 'confirmed', timestamp: 1, type: 'send' };
    await act(async () => { tree.update(<H.TxDetail tx={sol} t={t} onBack={onBack} onExplorer={onExplorer} />); });
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-explorer').props.onPress(); });
    expect(onExplorer).toHaveBeenLastCalledWith(sol.hash, 'solana');
    expect(require('../src/config/nodes').solanaExplorerTxUrl(sol.hash)).toBe(`https://explorer.solana.com/tx/${sol.hash}?cluster=devnet`);
    // A Solana send that expired unrun (no fee charged) never reached the ledger, and one still pending is not there yet:
    // no explorer; its hash is copied by a tap on it, as every field is.
    for (const notRun of [{ ...sol, status: 'failed', solFee: null }, { ...sol, status: 'pending' }]) {
      await act(async () => { tree.update(<H.TxDetail tx={notRun} t={t} onBack={onBack} onExplorer={onExplorer} />); });
      expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer')).toHaveLength(0);
    }
    await act(async () => { await tree.root.find((n) => n.props.testID === 'tx-detail-copy-hash' && n.props.onPress).props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(sol.hash);
    // A pending QNet transaction is not in the explorer yet.
    await act(async () => { tree.update(<H.TxDetail tx={{ ...tx, status: 'pending' }} t={t} onBack={onBack} onExplorer={onExplorer} />); });
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer')).toHaveLength(0);
    await act(async () => { tree.unmount(); });
  });

  it('the tab: the same QNet · Solana selector as Assets, no filter chips', () => {
    const ws = read('src/screens/WalletScreen.js');
    const tab = ws.slice(ws.indexOf("      case 'history': {"), ws.indexOf("      case 'node': {"));
    expect(tab).toMatch(/<Tabs\s+items=\{\[\{ key: 'qnet', label: CHAIN_NAME \}, \{ key: 'solana', label: 'Solana' \}\]\}/);
    expect(tab).toMatch(/onChange=\{setSelectedNetwork\}/);
    expect(tab).not.toMatch(/historyChip|assetChips|matchesAsset/);
    // One row per transaction under a header for its day, from the one list a token's own screen reads too.
    expect(tab).toMatch(/const listed = historySections\(historyOn\(selectedNetwork\)\);/);
    expect(ws).toMatch(/const historyOn = \(network\) => historyEntries\(network === 'qnet'/);
    expect(tab).toMatch(/renderItem=\{\(\{ item \}\) => \(item\.dayHeader \? <DayHeader item=\{item\} t=\{t\} \/>\s*: <HistoryRow tx=\{item\} onOpen=\{openTxDetail\}/);
  });
});

describe('M10: the crash screen\'s Clear cache', () => {
  const { Alert } = require('react-native');
  const ErrorBoundary = require('../src/components/ErrorBoundary').default;
  const { CACHE_KEYS } = require('../src/components/ErrorBoundary');

  it('removes the caches the app reads again by itself, by exact key, and says success only when one was there', async () => {
    expect([...CACHE_KEYS].sort()).toEqual(['qnet_node_pool', 'qnet_node_rewards', 'qnet_tx_history']);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.multiSet([['qnet_node_rewards', '{}'], ['qnet_tx_history', '[]'], ['qnet_wallet', 'vault'], ['qnet_language', 'en'],
      ['qnet_wallet_node', '{"owner":"w","nodeId":"super_node_5555666677778888","nodeType":"super","status":null,"at":1}']]);
    const boundary = new ErrorBoundary({});
    boundary.setState = () => {};
    await boundary.handleClearCache();
    expect(await AsyncStorage.getItem('qnet_node_rewards')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_tx_history')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe('vault'); // the wallet, its node record and the settings stay
    expect(await AsyncStorage.getItem('qnet_wallet_node')).toContain('super_node_5555666677778888');
    expect(await AsyncStorage.getItem('qnet_language')).toBe('en');
    expect(alert.mock.calls[0].slice(0, 2)).toEqual([t('crash_cache_cleared_title'), t('crash_cache_cleared_body')]);
    await boundary.handleClearCache();
    expect(alert.mock.calls[1].slice(0, 2)).toEqual(['', t('crash_cache_empty')]);
    alert.mockRestore();
  });
});

describe('M11: a batch payment shows once', () => {
  it('a node\'s reported row goes when the archive holds the same hash under another key', () => {
    const { mergeHistory } = require('../src/utils/txHistory');
    const me = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
    const reported = { hash: 'h'.repeat(64), from: 'x', to: me, amount: 1, status: 'reported', timestamp: 2000, type: 'receive' };
    const archived = { hash: 'h'.repeat(64), batchIndex: 3, from: 'x', to: me, amount: 1, status: 'confirmed', timestamp: 2000, type: 'receive' };
    const merged = mergeHistory([], [archived, reported], { myAddress: me, coveredFromMs: 0, nowMs: 10000, nodeEventsOk: true });
    expect(merged).toEqual([archived]);
    // Alone, a node's row still shows (Pending) until the archive has it.
    expect(mergeHistory([], [reported], { myAddress: me, coveredFromMs: 0, nowMs: 10000, nodeEventsOk: true })).toEqual([reported]);
  });
});

describe('A5: the Node tab after Use this device', () => {
  const ws = read('src/screens/WalletScreen.js');
  it('reads the status again while the node has not answered, on this tab and in the front only', () => {
    expect(ws).toMatch(/const USE_REREAD_MS = \[5000, 15000, 30000, 60000\];/);
    expect(ws).toMatch(/if \(answered \|\| activeTabRef\.current !== 'node' \|\| AppState\.currentState !== 'active'\) \{ stopRereads\(\); return; \}/);
    expect(ws).toMatch(/if \(r\.ok\) rereadAfterUse\(\);/);
    expect(ws).toMatch(/await loadLightNodeStatus\(\{ fresh: true \}\);\s*\} \},/);
  });

  it('a missing or refused ping key asks with the open wallet\'s key, and a read without a sequence keeps the last verdict', () => {
    expect(ws).toMatch(/const pingOrWallet = async \(id, ts\) => \(await signStatusWithPingKey\(id, ts\)\) \|\| walletSign\(id, ts\);/);
    expect(ws).toMatch(/if \(sign && status\.keyOurs === false && walletOpen\(\)\) \{\s*status = await readNodeStatus\(nodeId, \{ signStatus: walletSign \}\);/);
    expect(ws).toMatch(/status = \{ \.\.\.status, \.\.\.kept\.verdict \};/);
    // No key to sign with never reads as "another device key".
    expect(ws).not.toMatch(/tagOurs: status\.noStatusKey \? false/);
  });
});

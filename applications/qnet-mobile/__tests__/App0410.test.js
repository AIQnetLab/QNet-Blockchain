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
    expect(kt).toMatch(/override fun onTaskRemoved\(rootIntent: Intent\?\) \{\s*TaskState\.markClosed\(this\)/);
    expect(kt).toMatch(/ApplicationExitInfo\.REASON_USER_REQUESTED/);
    expect(kt).toMatch(/contains\("remove task", ignoreCase = true\)/);
    expect(kt).toMatch(/override fun getName\(\): String = "QNetTaskState"/);
    expect(kt).toMatch(/if \(inFront\) return false/);
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(activity).toMatch(/TaskState\.opened\(this\)\s*runCatching \{ startService\(Intent\(this, TaskWatchService::class\.java\)\) \}/);
    expect(activity).toMatch(/TaskState\.left\(\)/);
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/<service\s+android:name="\.TaskWatchService"\s+android:exported="false"\s+android:stopWithTask="false" \/>/);
    expect(read('android/app/src/main/java/com/qnetmobile/DilithiumPackage.kt')).toMatch(/TaskStateModule\(reactContext\)/);
  });

  it('Android\'s swipes it cannot see are written down, and the node answers then; recent tasks are never read (L-7)', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/TaskState.kt');
    // A trimmed recents list is no swipe: reading it would stop honest nodes.
    expect(kt).not.toMatch(/appTasks|getAppTasks|getRecentTasks/);
    expect(kt).toMatch(/What Android cannot see \(L-7\), so the node answers then/);
    expect(kt).toMatch(/API 26-29/);
    const gate = read('src/services/AnswerGate.js');
    expect(gate).toMatch(/Android cannot see every swipe \(L-7\)/);
    expect(gate).not.toMatch(/appTasks/);
  });

  it('the Android module answers the mark; a build without it, or an error, never stops a node', async () => {
    const { closedByUser } = jest.requireActual('../src/services/TaskState.android');
    NativeModules.QNetTaskState = { closedByUser: jest.fn(async () => true) };
    expect(await closedByUser()).toBe(true);
    NativeModules.QNetTaskState.closedByUser.mockRejectedValueOnce(new Error('no'));
    expect(await closedByUser()).toBe(false);
    delete NativeModules.QNetTaskState;
    expect(await closedByUser()).toBe(false);
  });

  it('iOS: a force-quit app gets no background push and no fetch, and has no other wake; nothing to refuse there', async () => {
    const { closedByUser } = jest.requireActual('../src/services/TaskState');
    expect(await closedByUser()).toBe(false);
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

  it('the screen: progress first, the local wipe before the network\'s answer, a word when it is done', () => {
    const ws = read('src/screens/WalletScreen.js');
    const erase = ws.slice(ws.indexOf('const eraseWallet = async'), ws.indexOf('// Settings → Delete wallet'));
    expect(erase).toMatch(/setErasing\(true\);[\s\S]*stopLightNode\(\{ waitForNetwork: false, forgetDevice: true \}\)[\s\S]*eraseAllData\(\)[\s\S]*await Promise\.resolve\(sent\)/);
    expect(erase).toMatch(/finally \{\s*setErasing\(false\);/);
    expect(ws).toMatch(/\{erasing \? <Text style=\{styles\.subtitle\}>\{t\('deleting_wallet'\)\}<\/Text> : null\}/);
    expect(ws.match(/showAlert\('', t\('wallet_deleted'\)\)/g)).toHaveLength(2);
    expect(t('wallet_deleted')).toBe('The wallet was deleted from this device.');
  });
});

describe('A1: the lock screen', () => {
  const ws = read('src/screens/WalletScreen.js');
  const lock = ws.slice(ws.indexOf('  if (!wallet) {\n    const lockoutSec'), ws.indexOf('  const renderTabContent = () => {'));

  it('no erase choice next to Unlock; a small "Forgot?" link opens its own confirmation, never under the system prompt', () => {
    expect(lock).not.toMatch(/erase_and_restore/);
    expect(lock).toMatch(/\{deviceAuth && unlockPrompting \? null : \(\s*<TouchableOpacity\s+style=\{styles\.lockForgot\}\s+onPress=\{\(\) => \{ setEraseText\(''\); setShowEraseConfirm\(true\); \}\}/);
    expect(lock).toMatch(/\{unlockPrompting \? null : \(/);
    expect(t('unlock_forgot_reset')).toBe('Forgot? Reset the wallet');
  });

  it('the system prompt opens by itself at every start and every lock; the welcome screen never shows before the wallet is read', () => {
    // The field with the focus lets go of it first (06.10: nothing is focused by itself), then the session closes.
    expect(ws).toMatch(/const lockSession = \(\) => \{\s*(\/\/[^\n]*\n\s*)*Keyboard\.dismiss\(\);\s*walletManager\.closeSession\(\);[\s\S]{0,200}setUnlockPrompting\(true\);/);
    expect(ws).toMatch(/if \(erasing \|\| !walletKnown\) \{/);
    expect(ws).toMatch(/setTimeout\(\(\) => \{\s*if \(autoUnlockOwedRef\.current && AppState\.currentState === 'active' && autoUnlockRef\.current\) autoUnlockRef\.current\(\);\s*\}, AUTO_UNLOCK_RECHECK_MS\);/);
  });
});

describe('A4: History', () => {
  const H = require('../src/screens/HistoryTab');
  const QNET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
  const OTHER = 'e'.repeat(45);
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join(''));

  it('amounts are written compactly, never longer than 11 characters, and never cut', () => {
    expect(H.compactAmount(0)).toBe('0');
    expect(H.compactAmount(1.5)).toBe('1.5');
    expect(H.compactAmount(12.345678)).toBe('12.3457');
    expect(H.compactAmount(0.000123456)).toBe('0.00012346');
    expect(H.compactAmount(0.000000001)).toBe('<0.00000001');
    expect(H.compactAmount(98765.4321)).toBe('98,765.43');
    expect(H.compactAmount(999.12341)).toBe('999.1234');
    expect(H.compactAmount(1234.5)).toBe('1,234.5');
    expect(H.compactAmount(123456.7)).toBe('123.46K');
    expect(H.compactAmount(1234567.12345)).toBe('1.23M');
    expect(H.compactAmount(9007199254.740993)).toBe('9.01B');
    expect(H.compactAmount(4.2e15)).toBe('4200T');
    expect(H.compactDecimalText('1,234,567.891234')).toBe('1.23M');
    for (const n of [0.12345678, 1e-9, 99999.9999, 123456789012.345, 1e18]) expect(H.compactAmount(n).length).toBeLessThanOrEqual(11);
  });

  it('a row: what happened over its status and whom with, and the amount; the number never shrinks, only the symbol may', async () => {
    const tx = { hash: 'p'.repeat(64), from: QNET, to: OTHER, amount: 1234567.12345, fee: 0.00015, status: 'pending', timestamp: Date.UTC(2026, 9, 4, 12), type: 'send' };
    const onOpen = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<H.HistoryRow tx={tx} t={t} hideAmounts={false} onOpen={onOpen} />); });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([t('hist_sent'), '−1.23M', ' QNC', t('hist_status_pending')]));
    const amount = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === '−1.23M');
    expect(amount.props.numberOfLines).toBe(1);
    expect(amount.props.adjustsFontSizeToFit).toBeFalsy();
    const symbol = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === ' QNC');
    expect(symbol.props.ellipsizeMode).toBe('tail');
    await act(async () => { tree.root.findByType(TouchableOpacity).props.onPress(); });
    expect(onOpen).toHaveBeenCalledWith(tx);
    // A Solana send carries its token's own icon; a confirmed row shows no status line.
    const sol = { hash: 's'.repeat(88), chain: 'solana', from: 'a', to: 'b', solSymbol: 'SOL', solAmount: '0.5', solFee: '0.000005', status: 'confirmed', timestamp: 1, type: 'send' };
    await act(async () => { tree.update(<H.HistoryRow tx={sol} t={t} hideAmounts={false} onOpen={onOpen} />); });
    expect(tree.root.findAll((n) => n.props && n.props.source && n.props.source.uri === require('../src/components/TokenIcons').tokenIconUri('SOL'))).not.toHaveLength(0);
    expect(texts(tree)).not.toContain(t('hist_status_confirmed'));
  });

  it('the detail screen: every field the app holds, the explorer for a QNet transaction in a block and a Solana one that ran', async () => {
    const tx = { hash: 'c'.repeat(64), from: QNET, to: OTHER, amount: 1234567.12345, fee: 0.00015, status: 'confirmed', timestamp: Date.UTC(2026, 9, 4, 12), type: 'send', block: 2345678 };
    const onExplorer = jest.fn();
    const onCopy = jest.fn();
    const onBack = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<H.TxDetail tx={tx} t={t} onBack={onBack} onCopy={onCopy} onExplorer={onExplorer} />); });
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
    await act(async () => { tree.update(<H.TxDetail tx={sol} t={t} onBack={onBack} onCopy={onCopy} onExplorer={onExplorer} />); });
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-explorer').props.onPress(); });
    expect(onExplorer).toHaveBeenLastCalledWith(sol.hash, 'solana');
    expect(require('../src/config/nodes').solanaExplorerTxUrl(sol.hash)).toBe(`https://explorer.solana.com/tx/${sol.hash}?cluster=devnet`);
    // A Solana send that expired unrun (no fee charged) never reached the ledger, and one still pending is not there yet:
    // the hash is copied.
    for (const notRun of [{ ...sol, status: 'failed', solFee: null }, { ...sol, status: 'pending' }]) {
      await act(async () => { tree.update(<H.TxDetail tx={notRun} t={t} onBack={onBack} onCopy={onCopy} onExplorer={onExplorer} />); });
      expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer')).toHaveLength(0);
    }
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-copy').props.onPress(); });
    expect(onCopy).toHaveBeenCalledWith(sol.hash, 'detail-hash');
    // A pending QNet transaction is not in the explorer yet: its hash is copied too.
    await act(async () => { tree.update(<H.TxDetail tx={{ ...tx, status: 'pending' }} t={t} onBack={onBack} onCopy={onCopy} onExplorer={onExplorer} />); });
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer')).toHaveLength(0);
  });

  it('the tab: the same QNet · Solana selector as Assets, no filter chips', () => {
    const ws = read('src/screens/WalletScreen.js');
    const tab = ws.slice(ws.indexOf("      case 'history': {"), ws.indexOf("      case 'node': {"));
    expect(tab).toMatch(/\[\['qnet', 'QNet'\], \['solana', 'Solana'\]\]\.map/);
    expect(tab).toMatch(/onPress=\{\(\) => setSelectedNetwork\(key\)\}/);
    expect(tab).not.toMatch(/historyChip|assetChips|matchesAsset/);
    // One row per transaction under a header for its day (06.10).
    expect(tab).toMatch(/const listed = historySections\(historyEntries\(onQnet/);
    expect(tab).toMatch(/renderItem=\{\(\{ item \}\) => \(item\.dayHeader \? <DayHeader item=\{item\} t=\{t\} \/>\s*: <HistoryRow tx=\{item\} onOpen=\{openTxDetail\}/);
  });
});

describe('M10: the crash screen\'s Clear cache', () => {
  const { Alert } = require('react-native');
  const ErrorBoundary = require('../src/components/ErrorBoundary').default;
  const { CACHE_KEYS } = require('../src/components/ErrorBoundary');

  it('removes the caches the app reads again by itself, by exact key, and says success only when one was there', async () => {
    expect([...CACHE_KEYS].sort()).toEqual(['qnet_cached_server_status', 'qnet_node_pool', 'qnet_node_rewards', 'qnet_tx_history']);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await AsyncStorage.multiSet([['qnet_node_rewards', '{}'], ['qnet_tx_history', '[]'], ['qnet_wallet', 'vault'], ['qnet_language', 'en']]);
    const boundary = new ErrorBoundary({});
    boundary.setState = () => {};
    await boundary.handleClearCache();
    expect(await AsyncStorage.getItem('qnet_node_rewards')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_tx_history')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe('vault'); // the wallet and the settings stay
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

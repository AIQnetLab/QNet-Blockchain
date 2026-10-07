// Round-5 mobile findings: a Keystore read that fails never replaces or deletes the vault's seal key (MVA-R5-01); an
// approval's biometric prompt needs a deliberate press (MVA-R5-02); a send is reviewed with its whole recipient, which
// the fresh check shows too (MPLAT-R5-01); a touch through another app's window is dropped even when the window covers
// only part of the screen (MPLAT-R5-02); the recents snapshot is secure below API 33 (MPLAT-R5-03); the store of kept
// transactions is never taken for empty when it cannot be read (MOBNET-R5-04); a server node's id changes only on two
// genesis confirmations (MOBACT-R5-02); a QNet Link request ends the wallet's own open confirmations (MOBLINK-R5-01)
// and a decided one outlives a lock (MOBLINK-R5-02). The lineage-walk findings (MOBNET-R5-01/02, R5-EXTQ-04) are in
// LineageWalk.test.js.
jest.mock('../src/services/PushService', () => ({ checkNodeStatus: jest.fn() }));

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { Platform } = require('react-native');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const { WalletManager } = require('../src/components/WalletManager');
const P = require('../src/services/PendingTx');
const logger = require('../src/utils/logger').default;

jest.setTimeout(180000);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KT = () => read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
const SCREEN = () => read('src/screens/WalletScreen.js');
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
const stored = async (k) => JSON.parse(await AsyncStorage.getItem(k));
const t = require('../src/i18n').makeT('en');

// A Keystore key stand-in: AES-256-GCM under a key of its own.
function fakeSealer(name) {
  const key = nodeCrypto.randomBytes(32);
  return {
    name,
    seal: async (bytes) => {
      const iv = nodeCrypto.randomBytes(12);
      const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
      return new Uint8Array(Buffer.concat([iv, c.update(Buffer.from(bytes)), c.final(), c.getAuthTag()]));
    },
    open: async (bytes) => {
      const b = Buffer.from(bytes);
      const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
    },
  };
}

const spies = [];
const spy = (obj, name) => { const s = jest.spyOn(obj, name); spies.push(s); return s; };
const swaps = [];
const swap = (obj, name, value) => { swaps.push([obj, name, obj[name]]); obj[name] = value; return value; };
afterEach(() => {
  while (spies.length) spies.pop().mockRestore();
  while (swaps.length) { const [obj, name, orig] = swaps.pop(); obj[name] = orig; }
});

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
  swap(WalletManager, 'DEVICE_AUTH', false); // the Android password vault
});

describe('MVA-R5-01: a Keystore read that fails never replaces or deletes the key that seals the vault', () => {
  it('only the probe makes a seal key, and only after an answered listing shows there is none (MA-R2-01)', () => {
    const kt = KT();
    const probe = kt.slice(kt.indexOf('fun hwAvailable('), kt.indexOf('fun hwSeal('));
    expect(probe).toMatch(/secretKey\(SEAL_ALIAS\)\s*\} catch \(_: KeyGoneException\) \{\s*made = true\s*generateKey\(SEAL_ALIAS, biometric = false\)/);
    expect(probe).toMatch(/if \(made\) deleteKey\(SEAL_ALIAS\)/);
    // A null read is absence only when an answered listing leaves the alias out (KeyPresence, KeyPresenceTest).
    const entry = kt.slice(kt.indexOf('private fun <T : Any> entry('), kt.indexOf('private fun secretKey('));
    expect(entry).toMatch(/readKeystoreEntry\(/);
    expect(entry).toMatch(/aliasListing\(alias, PROBE_ALIAS/);
    expect(entry).toMatch(/KeyRead\.Absent -> throw KeyGoneException\(\)/);
    expect(entry).toMatch(/KeyRead\.Unanswered -> throw KeystoreUnansweredException\(\)/);
    // No read of the Keystore that swallows its errors decides anything.
    expect(kt).not.toMatch(/containsAlias\(/);
    expect(kt).not.toMatch(/existingKey\(/);
    const gen = kt.slice(kt.indexOf('private fun generateKey('), kt.indexOf('private fun seal('));
    expect(gen).not.toMatch(/existed/);
    // Sealing never makes a key: a rotation of a vault on this key seals with the key that opened it.
    const seal = kt.slice(kt.indexOf('fun hwSeal('), kt.indexOf('fun hwOpen('));
    expect(seal).toMatch(/val key = secretKey\(SEAL_ALIAS\)/);
    expect(seal).not.toMatch(/generateKey/);
    const open = kt.slice(kt.indexOf('private fun openWith('), kt.indexOf('fun bioAvailable('));
    expect(open).toMatch(/val key = secretKey\(alias\)/);
  });

  function sealers() {
    const current = fakeSealer('android-keystore-v2');
    const make = spy(DeviceSecurity, 'deviceSealer').mockResolvedValue(current);
    spy(DeviceSecurity, 'deviceSealerFor').mockImplementation((n) => (n === current.name ? current : null));
    return { current, make };
  }

  it('the owed data-key rotation of a vault on the current key keeps that key and runs no Keystore probe', async () => {
    const { current, make } = sealers();
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    wm.closeSession();
    const before = await stored('qnet_wallet');
    expect(before.hw).toBe('android-keystore-v2');
    await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1');
    // The probe would now answer with a key that is not the one sealing the vault (a busy keystore made a new one).
    make.mockClear();
    make.mockResolvedValue(fakeSealer('android-keystore-v2'));
    const r = await wm.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    expect(make).not.toHaveBeenCalled();
    const after = await stored('qnet_wallet');
    expect(after.hw).toBe('android-keystore-v2');
    expect(after.encrypted).not.toBe(before.encrypted); // rotated
    expect(await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY)).toBeNull();
    wm.closeSession();
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    expect(await wm.revealMnemonic(PW)).toEqual({ ok: true, mnemonic: MNEMONIC });
    expect(current).toBeDefined();
  });

  it('a rotation whose write fails leaves the stored vault opening, keeps the flag, and says so in the log', async () => {
    sealers();
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    wm.closeSession();
    const before = await AsyncStorage.getItem('qnet_wallet');
    await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1');
    const multiSet = AsyncStorage.multiSet;
    let failed = 0;
    swap(AsyncStorage, 'multiSet', jest.fn(async (pairs) => {
      if (failed === 0 && pairs.some(([k]) => k === WalletManager.VAULT_KEY)) { failed += 1; throw new Error('SQLITE_FULL'); }
      return multiSet(pairs);
    }));
    const warn = spy(logger, 'warn');
    const r = await wm.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    expect(failed).toBe(1);
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe(before);
    expect(await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY)).toBe('1');
    expect(warn.mock.calls.some((c) => /owed data-key rotation failed/.test(String(c[0])))).toBe(true);
    wm.closeSession();
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true); // and rotates now
    expect(await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY)).toBeNull();
    expect(await wm.revealMnemonic(PW)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('an unsealed vault or one on the legacy key still moves to the current key at rotation', () => {
    const wm = read('src/components/WalletManager.js');
    const rotate = wm.slice(wm.indexOf('async _rotateDek('), wm.indexOf('async _resealRecords('));
    // The current key of either platform (Android Keystore v2, iOS Secure Enclave) is kept; nothing probes for it.
    expect(rotate).toMatch(/const hw = isCurrentDeviceSealer\(vault\.hw\) && own \? own : \(\(await deviceSealer\(\)\) \|\| own\);/);
  });
});

describe('MVA-R5-02: an approval\'s biometric prompt needs a deliberate press; unlock does not', () => {
  const V = require('../src/crypto/Vault');

  async function withBio() {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const opened = await wm._openVault(PW);
    const bio = fakeSealer('android-biometric');
    await wm._writeVault(await V.withBioWrap(opened.vault, opened.dek, bio));
    opened.dek.fill(0);
    return { wm, bio };
  }

  it('confirmWithBiometrics asks with confirm: true and the recipient as the system-drawn description', async () => {
    swap(Platform, 'OS', 'android');
    const { wm, bio } = await withBio();
    const sealer = spy(DeviceSecurity, 'biometricSealer').mockReturnValue(bio);
    expect(await wm.confirmWithBiometrics('Confirm sending 5 QNC', 'Apps …', 'To: 02dc a74e')).toEqual({ ok: true });
    expect(sealer).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Confirm sending 5 QNC', subtitle: 'Apps …', description: 'To: 02dc a74e', confirm: true,
    }));
    // Unlock is re-authentication, not an approval: no confirmation press.
    wm.closeSession();
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    expect(sealer.mock.calls[sealer.mock.calls.length - 1][0].confirm).not.toBe(true);
  });

  it('the native prompt takes the flag from the caller and never hard-codes it', () => {
    const kt = KT();
    expect(kt).not.toMatch(/\.setConfirmationRequired\(false\)/);
    expect(kt).toMatch(/\.setConfirmationRequired\(confirm\)/);
    expect(kt).toMatch(/fun bioOpen\(blobB64: String, title: String, subtitle: String, description: String, cancel: String, confirm: Boolean, promise: Promise\)/);
    expect(kt).toMatch(/if \(description\.isNotEmpty\(\)\) setDescription\(description\)/);
  });

  it('DeviceSecurity hands the description and the flag to the native module, false unless asked', async () => {
    const calls = [];
    let DS;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'android' },
        NativeModules: {
          QNetSecurity: {
            hwSeal: jest.fn(),
            bioSeal: jest.fn(async (b) => b),
            bioOpen: jest.fn(async (b, ...rest) => { calls.push(rest); return b; }),
          },
        },
      }));
      DS = require('../src/services/DeviceSecurity');
      jest.dontMock('react-native');
    });
    await DS.biometricSealer({ title: 'T', subtitle: 'S', description: 'D', cancel: 'C', confirm: true }).open(new Uint8Array([1]));
    await DS.biometricSealer({ title: 'U' }).open(new Uint8Array([1]));
    expect(calls).toEqual([['T', 'S', 'D', 'C', true], ['U', '', '', '', false]]);
  });
});

describe('MPLAT-R5-01: a send is reviewed with its whole recipient, which the fresh check shows too', () => {
  const SendReview = require('../src/components/SendReview').default;
  const { recipientWarnings } = require('../src/components/SendReview');
  const { groupAddress } = require('../src/utils/addressDisplay');
  const { SEND_ARM_MS } = require('../src/browser/dappProvider');
  const KNOWN = '0123456789abcdef012eon0123456789abcde0a1b2c3d';
  const LOOKALIKE = `${KNOWN.slice(0, 4)}ffffffffffffffffeon${KNOWN.slice(23, -4)}${KNOWN.slice(-4)}`;
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
  const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));

  it('groups an address in fours, whole', () => {
    expect(groupAddress(B.qnet)).toBe('02dc a74e f2ea e3be 97fe on49 9504 db89 1ae0 c60e 364a 8');
    expect(groupAddress(B.qnet).replace(/ /g, '')).toBe(B.qnet);
    expect(groupAddress(null)).toBe('');
  });

  it('warns about a recipient never paid, one like a known one, and one that only ever paid this wallet', () => {
    const ctx = { counterparties: [KNOWN], paid: [], senders: [] };
    expect(recipientWarnings(KNOWN, B.qnet, ctx)).toEqual({ firstTime: false, lookAlike: false, incomingOnly: false });
    expect(recipientWarnings(LOOKALIKE, B.qnet, ctx)).toMatchObject({ lookAlike: true, firstTime: false });
    expect(recipientWarnings(B.qnet, B.qnet, ctx)).toEqual({ firstTime: false, lookAlike: false, incomingOnly: false });
    const stranger = 'fedcba9876543210fedeonfedcba9876543210a1b2c3d';
    expect(recipientWarnings(stranger, B.qnet, { ...ctx, senders: [stranger] })).toEqual({ firstTime: true, lookAlike: false, incomingOnly: true });
  });

  it('the review shows the whole recipient and arms only after it stayed untouched; a press begun before does nothing', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const review = { to: LOOKALIKE, network: 'QNet', amount: '900 QNC', fee: '0.00015 QNC', total: '900.00015 QNC',
      warnings: { lookAlike: true } };
    let tree;
    await act(async () => { tree = renderer.create(<SendReview review={review} t={t} onCancel={onCancel} onConfirm={onConfirm} />); });
    const shown = texts(tree);
    expect(shown).toContain(groupAddress(LOOKALIKE));
    expect(shown).toContain(t('dapp_send_lookalike'));
    expect(shown).toContain('900 QNC');
    const confirm = () => tree.root.findAll((n) => n.props && n.props.testID === 'send-review-confirm' && typeof n.props.onPress === 'function')[0];
    expect(confirm().props.disabled).toBe(true);
    confirm().props.onPressIn();
    await wait(SEND_ARM_MS + 100);
    expect(confirm().props.disabled).toBe(false);
    await act(async () => { confirm().props.onPress(); }); // the finger went down before it armed
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { confirm().props.onPressIn(); confirm().props.onPress(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); });
  });

  it('every send is reviewed before its fresh check, and the recipient goes on the fresh check itself', () => {
    const s = SCREEN();
    const send = s.slice(s.indexOf('const handleSendTransaction = async'), s.indexOf('// Claim rewards for Server nodes'));
    const review = send.indexOf('const reviewed = await reviewSend({');
    const fresh = send.indexOf("if (!(await confirmFresh(t('send_confirm_reason'");
    expect(review).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(review);
    expect(send).toMatch(/if \(!reviewed\) return;/);
    expect(send).toMatch(/\}\), null, sendAddress\)\)\) return;/);
    expect(send).toMatch(/warnings = recipientWarnings\(sendAddress, senderQnet, context\);/);
    const fn = s.slice(s.indexOf('const confirmFresh = async'), s.indexOf('const resolveFresh ='));
    expect(fn).toMatch(/const detail = recipient \? t\('fresh_to', \{ to: groupAddress\(recipient\) \}\) : '';/);
    expect(fn).toMatch(/confirmWithBiometrics\(reason, note, detail\)/);
    expect(fn).toMatch(/setFreshPrompt\(\{ reason, note, recipient: recipient \? groupAddress\(recipient\) : null \}\)/);
    expect(s).toMatch(/\{freshPrompt\.recipient \? \(/);
    // A site's send in the browser puts its recipient on the check too.
    expect(read('src/browser/DappSheet.js')).toMatch(/authenticate\(authReason\(\), null, recipient\)/);
  });

  it('the apps that can read the screen are named with their package, not only their chosen label', () => {
    const kt = KT();
    expect(kt).toMatch(/"\$label \(\$\{service\.packageName\}\)"/);
  });
});

describe('MPLAT-R5-02: a touch through another app\'s window is dropped, even one that covers only part of it', () => {
  it('the guard wraps the window\'s touch dispatch and drops obscured and partially obscured gestures', () => {
    const kt = KT();
    const filter = kt.slice(kt.indexOf('private fun obscured('), kt.indexOf('override fun onHostPause'));
    expect(filter).toMatch(/MotionEvent\.FLAG_WINDOW_IS_OBSCURED/);
    expect(filter).toMatch(/Build\.VERSION_CODES\.Q && flags and MotionEvent\.FLAG_WINDOW_IS_PARTIALLY_OBSCURED != 0/);
    expect(filter).toMatch(/if \(!dropping && guardOn && obscured\(event\)\)/);
    expect(filter).toMatch(/cancel\.action = MotionEvent\.ACTION_CANCEL/); // a press already under way does not complete
    expect(kt).toMatch(/guardOn = guard\s*\n\s*if \(guard\) watchObscuredTouches\(activity\)/);
    expect(kt).toMatch(/if \(texts\.hasKey\("obscuredTouch"\)\)/);
    expect(SCREEN()).toMatch(/obscuredTouch: t\('native_obscured_touch'\)/);
  });
});

describe('MPLAT-R5-03: below API 33 the recents snapshot is taken of a secure window', () => {
  it('FLAG_SECURE on the way to the background, cleared on return unless a secret screen holds it', () => {
    const main = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(main).toMatch(/override fun onPause\(\) \{\s*if \(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU\) window\.addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)\s*super\.onPause\(\)/);
    expect(main).toMatch(/Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU && !SecurityModule\.secretScreenOn/);
    expect(main).toMatch(/setRecentsScreenshotEnabled\(false\)/);
    expect(KT()).toMatch(/secureOn = on\s*\n\s*secretScreenOn = on/);
  });
});

describe('MOBNET-R5-04: a store of kept transactions that cannot be read is never taken for an empty one', () => {
  const FROM = B.qnet;
  const entry = (nonce) => ({ from: FROM, nonce, path: '/api/v1/transaction', body: { nonce }, pk: null, summary: {}, createdAt: Date.now() });

  it('a read that fails twice refuses the mutation and writes nothing', async () => {
    await P.putSigned(entry(5));
    const before = await AsyncStorage.getItem(P.PENDING_KEY);
    const getItem = AsyncStorage.getItem;
    swap(AsyncStorage, 'getItem', jest.fn(async (k) => { if (k === P.PENDING_KEY) throw new Error('SQLITE_IOERR'); return getItem(k); }));
    await expect(P.settle(FROM, 3)).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    await expect(P.putSigned(entry(6))).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    await expect(P.pendingFor(FROM)).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    AsyncStorage.getItem = getItem;
    expect(await AsyncStorage.getItem(P.PENDING_KEY)).toBe(before);
    // One failure then a good read: nothing lost.
    let once = true;
    swap(AsyncStorage, 'getItem', jest.fn(async (k) => { if (k === P.PENDING_KEY && once) { once = false; throw new Error('busy'); } return getItem(k); }));
    expect((await P.settle(FROM, 3)).map((e) => e.nonce)).toEqual([5]);
  });

  it('a value that does not parse keeps every send back until nothing it held can still land', async () => {
    const t0 = 1_900_000_000_000;
    await AsyncStorage.setItem(P.PENDING_KEY, '{"me":[{"nonce":5');
    await expect(P.settle(FROM, 3, t0)).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    const until = t0 + P.NODE_MEMPOOL_TTL_MS + P.LANDING_MARGIN_MS;
    await expect(P.settle(FROM, 3, t0 + 60_000)).rejects.toMatchObject({ code: 'PENDING_UNREADABLE', until });
    expect(await P.pendingFor(FROM)).toEqual([]); // readable again: the marker only
    await expect(P.settle(FROM, 3, until - 1)).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    expect(await P.settle(FROM, 3, until)).toEqual([]);
    expect(await AsyncStorage.getItem(P.PENDING_KEY)).toBeNull(); // the marker went with its time
  });

  it('a send on such a store is refused before anything is signed, as "nothing sent"', async () => {
    const wm = manager();
    await AsyncStorage.setItem(P.PENDING_KEY, 'not json');
    wm._confirmedAccountNonce = jest.fn(async () => 3);
    const sign = jest.fn();
    await expect(wm._signAndSubmit(FROM, sign, { kind: 'transfer', to: 'x' })).rejects.toMatchObject({ code: 'PENDING_UNREADABLE' });
    expect(sign).not.toHaveBeenCalled();
    expect(SCREEN()).toMatch(/'NONCE_CHANGED',\s*'PENDING_UNREADABLE'\];/);
    expect(t('err_PENDING_UNREADABLE')).toMatch(/Nothing was sent/);
  });

  it('what a node answered stands when the kept copy cannot be updated right now', async () => {
    const wm = manager();
    await P.putSigned(entry(5));
    wm.getTrustedNodes = () => ['https://node1.aiqnet.io', 'https://node2.aiqnet.io'];
    wm._hedged = jest.fn(async () => ({ ok: true, data: { tx_hash: 'h' }, answers: [{ base: 'https://node1.aiqnet.io' }] }));
    const getItem = AsyncStorage.getItem;
    swap(AsyncStorage, 'getItem', jest.fn(async (k) => { if (k === P.PENDING_KEY) throw new Error('SQLITE_IOERR'); return getItem(k); }));
    expect(await wm._sendPending(entry(5))).toEqual({ accepted: true, data: { tx_hash: 'h' } });
  });
});

describe('MOBNET-R5-03: the committed light-client pin passes the release gate', () => {
  it('was written by ws-pin, proven from the pin before it, and passes the gate on the day it was made', () => {
    const { checkPin, pinOfSource } = require('../scripts/release-check');
    const src = read('src/config/genesisConsensus.js');
    const pin = pinOfSource(src);
    expect(pin.provenFrom).toEqual({ index: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(pin.provenFrom.index).toBeLessThan(pin.index);
    expect(checkPin({ source: src, today: pin.generated })).toEqual([]);
  });
});

describe('MOBACT-R5-02: the monitored server node changes only on two genesis confirmations', () => {
  it('a by-wallet answer naming another id is adopted only when confirmServerNode says so; else the linked one is shown', () => {
    const s = SCREEN();
    const load = s.slice(s.indexOf('const loadServerNodeStatus = async'), s.indexOf('const loadAllUserNodes = async'));
    expect(load).toMatch(/const confirmed = await walletManager\.confirmServerNode\(walletAddress, \{\s*nodeType: activatedNodeType, nodeId: status\.nodeId,\s*\}\)/);
    expect(load).toMatch(/if \(confirmed === true\) \{\s*adopt = status\.nodeId;/);
    expect(load).toMatch(/const own = linked \? responses\.find\(\(r\) => r\.nodeId === linked\) : null;/);
    expect(load).toMatch(/if \(adopt\) \{\s*setNodePseudonym\(adopt\);/);
    expect(load).not.toMatch(/status\.isOnline \|\| !nodePseudonym/);
    // A move of a server node's balance claims for the linked node.
    const move = s.slice(s.indexOf('const handleClaimServerNodeRewards = '), s.indexOf('const handleMoveLightBalance = '));
    expect(move).toMatch(/nodeId: nodePseudonym \|\| serverNodeStatus\?\.nodeId \|\| null,/);
  });
});

describe('MOBLINK-R5-01: a QNet Link request ends the wallet\'s own confirmations that were open', () => {
  it('its arrival resolves any other prompt and the send review with false, and a foreign prompt never opens over it', () => {
    const s = SCREEN();
    expect(s).toMatch(/if \(freshResolveRef\.current && freshOwnerRef\.current !== `link:\$\{linkKey\}`\) resolveFresh\(false\);/);
    expect(s).toMatch(/if \(sendReviewResolveRef\.current\) resolveSendReview\(false\);/);
    expect(s).toMatch(/\}, \[linkKey\]\);/);
    const fn = s.slice(s.indexOf('const confirmFresh = async'), s.indexOf('const resolveFresh ='));
    expect(fn).toMatch(/const foreign = \(\) => !!linkRequestRef\.current && owner !== `link:\$\{linkRequestRef\.current\.key\}`;/);
    expect(fn.match(/if \(foreign\(\)\) return false;/g)).toHaveLength(2); // at the start, and before a password prompt opens
    expect(fn).toMatch(/if \(bio\.ok\) return !foreign\(\);/);
    expect(s).toMatch(/if \(!sendReview \|\| !wallet \|\| linkRequest\) return null;/);
  });

  it('the send review ranks like the request sheets: under the prompts and the alerts, drawn where it is touched', () => {
    const { sendReviewStyles } = require('../src/components/SendReview');
    const { sheetStyles } = require('../src/browser/DappSheet');
    const walletStyles = require('../src/screens/WalletScreen.styles').default;
    expect([sendReviewStyles.overlay.zIndex, sendReviewStyles.overlay.elevation]).toEqual([sheetStyles.overlay.zIndex, sheetStyles.overlay.elevation]);
    expect(walletStyles.modalOverlay.zIndex).toBeGreaterThan(sendReviewStyles.overlay.zIndex);
    const s = SCREEN();
    const tail = s.slice(s.lastIndexOf('{renderSendReview()}'));
    expect(tail.indexOf('{renderSendReview()}')).toBeLessThan(tail.indexOf('{renderFreshPrompt()}'));
  });
});

// MVA-R5-03 / R5-XPD-04: the public description of the mobile wallet says what the code does, not what earlier rounds
// removed.
describe('the mobile wallet document describes the shipped behaviour', () => {
  const doc = fs.readFileSync(path.join(ROOT, '..', '..', 'docs', 'applications', 'mobile-wallet.md'), 'utf8').replace(/\s+/g, ' ');

  it('drops what the code no longer does', () => {
    for (const gone of [
      /rewraps the data key only/,
      /used once and replaced by that key/,
      /stored in the keychain item `com\.qnet\.wallet\.biometric`/,
      /\(balance, token and macroblock proofs, registry snapshots\)/,
      /an address in this wallet's history/,
      /Confirm arms one second after the request is ready/,
      /declares the two things a light-node registration leaves/,
      /\(or a 64-character hex address\)/,
      /proof-checked reads pick from the genesis names and the agreed endpoints/,
    ]) {
      expect([String(gone), gone.test(doc)]).toEqual([String(gone), false]);
    }
  });

  it('names what it does now', () => {
    for (const now of [
      'Changing the password gives the vault a new data key', '`qnet_vault_seal_v2`', 'is deleted at launch with its key, never read',
      '`com.qnetmobile.vault-secret`', '`com.qnetmobile.vault-secret.next`', 'come from the genesis names',
      'the addresses this wallet signed transfers to', 'one and a half for a send', 'answers `BIND_REFUSED`',
      'other financial info', '`FLAG_WINDOW_IS_PARTIALLY_OBSCURED`', '`PENDING_UNREADABLE`', 'records as `provenFrom`',
    ]) {
      expect([now, doc.includes(now)]).toEqual([now, true]);
    }
    expect(WalletManager.DEVICE_AUTH_SERVICE).toBe('com.qnetmobile.vault-secret');
    expect(WalletManager.DEVICE_AUTH_NEXT_SERVICE).toBe('com.qnetmobile.vault-secret.next');
    expect(KT()).toMatch(/SEAL_ALIAS = "qnet_vault_seal_v2"/);
  });
});

describe('MOBLINK-R5-02: a decided request outlives a lock', () => {
  it('locking keeps the request, which comes back with its outcome', () => {
    const s = SCREEN();
    const lock = s.slice(s.indexOf('const lockSession = () => {'), s.indexOf('const nextQueuedLink = (r) =>'));
    expect(lock).not.toMatch(/setLinkRequest\(/);
    expect(s).toMatch(/settled=\{!!linkRequest\.settled\}/);
    expect(s).toMatch(/settledOutcome=\{linkRequest\.outcome \|\| null\}/);
    expect(s).toMatch(/onOutcome=\{\(outcome\) => setLinkRequest\(\(r\) => \(r && r\.key === key \? \{ \.\.\.r, settled: true, outcome \} : r\)\)\}/);
  });
});

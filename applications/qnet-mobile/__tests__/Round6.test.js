/**
 * Final audit, mobile fixer round 2 (MA-R2-01 … MA-R2-04, MB-R2-01 … MB-R2-03, SD-R2-10): a Keystore read that fails is
 * never taken for a key that is gone, so no key is made or deleted over it and no lost-key screen follows it; the iOS
 * lock screen's own prompt waits for the app to be in front; an iOS Secure Enclave failure for now is a "try again"; a
 * screen-lock write that failed for now asks again rather than promising a password; a site's send is sent again
 * whatever tab is open; the Send form checks what the wallet may still spend, read now; the sheet offers to read an
 * unread balance again; and the submission notes say what is there.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const fs = require('fs');
const path = require('path');
const { NativeModules, Platform } = require('react-native');

// The Android screen-lock key as the native module answers: what `device` says for the check and the write.
const device = { available: true, availableError: null, sealError: null };
NativeModules.QNetSecurity = {
  devAuthAvailable: jest.fn(async () => {
    if (device.availableError) throw Object.assign(new Error('keystore'), { code: device.availableError });
    return device.available;
  }),
  devAuthSeal: jest.fn(async (b64) => {
    if (device.sealError) throw Object.assign(new Error('refused'), { code: device.sealError });
    return `sealed:${b64}`;
  }),
  devAuthOpen: jest.fn(async (blob) => blob.slice('sealed:'.length)),
};

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');
const DeviceAuthStore = require('../src/services/DeviceAuthStore');
const { DeviceKeyError } = require('../src/crypto/Vault');
const { spendableNano } = require('../src/browser/dappProvider');
const { TRANSFER_FEE_NANO } = require('../src/config/fees');
const DappSheet = require('../src/browser/DappSheet').default;

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(b, i + a.length);
  return src.slice(i, j < 0 ? undefined : j);
};
const t = require('../src/i18n').makeT('en');

const OS = Platform.OS;
beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(device, { available: true, availableError: null, sealError: null });
});
afterEach(() => { Platform.OS = OS; });

describe('MA-R2-01: a Keystore read that fails is never a key that is gone', () => {
  const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');

  it('every read of a key the vault may depend on goes through the answered-listing check', () => {
    // containsAlias, getCertificate and (below Android 12) getKey answer null for a failed read as well: none of them
    // alone decides that a key is absent (KeyPresence.kt, KeyPresenceTest).
    expect(kt).not.toMatch(/containsAlias\(/);
    expect(kt).not.toMatch(/as\? SecretKey \?: throw KeyGoneException|\?: return answer\(false, "not_set"\)/);
    for (const fn of ['fun hwSeal(', 'private fun openWith(', 'fun hwSealLegacy(', 'fun bioOpen(']) {
      expect([fn, /secretKey\((SEAL_ALIAS|LEGACY_SEAL_ALIAS|BIO_ALIAS|alias)\)/.test(between(kt, fn, '@ReactMethod'))]).toEqual([fn, true]);
    }
    expect(between(kt, 'private fun devAuthDecryptCipher(', '// The secret of')).toMatch(/val pub = existingDevAuthPublicKey\(\)[\s\S]*val key = privateKey\(DEV_AUTH_ALIAS\)/);
    expect(between(kt, 'private fun existingDevAuthPublicKey(', 'private fun devAuthKeyId(')).toMatch(/entry\(DEV_AUTH_ALIAS\) \{ it\.getCertificate\(DEV_AUTH_ALIAS\) \}/);
  });

  it('sealing never makes a key, and a screen-lock key it could not read is neither deleted nor replaced', () => {
    expect(between(kt, 'fun hwSeal(', 'fun hwOpen(')).not.toMatch(/generateKey/);
    const pub = between(kt, 'private fun devAuthPublicKey(', 'private fun devAuthKeyInvalidated(');
    // KeystoreUnansweredException is not caught here: the seal fails, the key stays.
    expect(pub).toMatch(/catch \(_: KeyGoneException\) \{ null \}/);
    expect(pub).not.toMatch(/catch \(_: (Throwable|Exception|KeystoreUnansweredException)\)/);
    // An unanswered check is not "no screen lock": the JS side asks again instead of sending a new wallet to a password.
    expect(between(kt, 'fun devAuthAvailable(', '@ReactMethod')).toMatch(/if \(t is KeystoreUnansweredException \|\| code == "KEYSTORE_BUSY"\) promise\.reject\(code, t\.message, t\)/);
    expect(kt).toMatch(/deleteKey\(DEV_AUTH_ALIAS\)\s*deleteKey\(PROBE_ALIAS\)/);
  });

  it('iOS seals only with the key that exists, as Android', () => {
    const m = read('ios/QNetMobile/QNetSecurityModule.m');
    const seal = between(m, 'RCT_EXPORT_METHOD(hwSeal:', 'RCT_EXPORT_METHOD(hwOpen:');
    expect(seal).toMatch(/QNetCopySealKey\(NO, &status\)/);
    expect(seal).not.toMatch(/QNetCopySealKey\(YES/);
    expect(between(m, 'RCT_EXPORT_METHOD(hwAvailable:', 'RCT_EXPORT_METHOD(hwSeal:')).toMatch(/QNetCopySealKey\(YES, NULL\)/);
  });

  it('what the JS side makes of the answers: only a key that is gone is permanent', () => {
    expect(new DeviceKeyError('x', 'KEYSTORE').permanent).toBe(false);
    expect(new DeviceKeyError('x', 'KEYSTORE_BUSY').permanent).toBe(false);
    expect(new DeviceKeyError('x', 'KEY_MISSING').permanent).toBe(true);
  });
});

describe('MA-R2-02: the lock screen\'s own prompt waits for the app to be in front', () => {
  it('iOS: a read refused because the app is not in front is "not now", and says nothing about the item', async () => {
    Platform.OS = 'ios';
    const get = Keychain.getGenericPassword.getMockImplementation();
    const has = Keychain.hasGenericPassword.getMockImplementation();
    try {
      Keychain.getGenericPassword.mockImplementation(async () => { throw Object.assign(new Error('User interaction is not allowed.'), { code: '-25308' }); });
      Keychain.hasGenericPassword.mockImplementation(async () => false);
      Keychain.hasGenericPassword.mockClear();
      const r = await DeviceAuthStore.read(['svc'], 'Unlock');
      expect(r).toEqual({ ok: false, reason: 'failed', code: '-25308', notNow: true });
      expect(Keychain.hasGenericPassword).not.toHaveBeenCalled();
    } finally {
      Keychain.getGenericPassword.mockImplementation(get);
      Keychain.hasGenericPassword.mockImplementation(has);
    }
  });

  it('the unlock answers "not now", which the screen owes to the next activation instead of an error', async () => {
    const wm = Object.assign(new WalletManager(), {
      usesDeviceAuth: async () => true,
      _deviceAuthItem: async () => ({ ok: false, reason: 'failed', code: '-25308', notNow: true }),
    });
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, failed: true, notNow: true });
    const ws = read('src/screens/WalletScreen.js');
    expect(ws).toMatch(/const \[appActive, setAppActive\] = useState\(\(\) => AppState\.currentState === 'active'\);/);
    const bio = between(ws, 'const handleBiometricUnlock = async', 'const offerBiometricReenroll');
    expect(bio).toMatch(/else if \(r\.notNow\) autoUnlockOwedRef\.current = true;\s*\/\/[^\n]*\n\s*else if \(r\.gone\)/);
    const auto = between(ws, 'autoUnlockRef.current = () => {', '// A password wallet moves to the screen lock');
    // Owed while not in front (looked at again shortly at a cold start, A1), opened at once in front.
    expect(auto).toMatch(/if \(AppState\.currentState !== 'active'\) \{\s*autoUnlockOwedRef\.current = true;[\s\S]*?return;\s*\}\s*handleBiometricUnlock\(\);/);
    // The owed prompt opens once, when the app comes to the front; the prompt's own trip out of the app owes nothing.
    expect(ws).toMatch(/if \(next === 'active' && autoUnlockOwedRef\.current && autoUnlockRef\.current\) autoUnlockRef\.current\(\);/);
    expect(auto.indexOf('autoUnlockOwedRef.current = false;')).toBeLessThan(auto.indexOf('handleBiometricUnlock()'));
  });
});

describe('MA-R2-03: an iOS Secure Enclave failure for now is a "try again"', () => {
  it('only a ciphertext this key did not seal is KEY_MISMATCH; a locked device and any other answer may open next time', () => {
    const m = read('ios/QNetMobile/QNetSecurityModule.m');
    const map = between(m, 'static NSString *QNetSealOpenErrorCode(', 'RCT_EXPORT_METHOD(hwOpen:');
    expect(map).toMatch(/if \(error == NULL\) return @"KEYSTORE";/);
    expect(map).toMatch(/if \(code == -3\) return @"KEY_MISMATCH";/);
    expect(map).toMatch(/if \(code == -9\) return @"DEVICE_LOCKED";/);
    expect(map).toMatch(/if \(code == errSecInteractionNotAllowed\) return @"DEVICE_LOCKED";/);
    expect(map).toMatch(/if \(code == errSecParam \|\| code == errSecDecode\) return @"KEY_MISMATCH";/);
    // Anything else, an unknown domain included, ends the function as KEYSTORE.
    const body = map.slice(0, map.indexOf('\n}\n') + 3);
    expect(body.trim().endsWith('return @"KEYSTORE";\n}')).toBe(true);
    const open = between(m, 'RCT_EXPORT_METHOD(hwOpen:', 'RCT_EXPORT_METHOD(deleteKeys:');
    expect(open).toMatch(/NSString \*code = QNetSealOpenErrorCode\(error\);/);
    expect(open).not.toMatch(/else reject\(@"KEY_MISMATCH"/);
  });
});

describe('MA-R2-04: a screen-lock write that failed for now asks again, never promises a password', () => {
  const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
  const store = (wm) => wm.storeWalletWithDeviceAuth({ address: 'a', publicKey: 'a', qnetAddress: 'q' }, 'Unlock');
  beforeEach(() => { Platform.OS = 'android'; });

  it('a busy Keystore at the write is DEVICE_LOCK_RETRY, and the next attempt uses the screen lock again', async () => {
    device.sealError = 'KEYSTORE_BUSY';
    const wm = manager();
    await expect(store(wm)).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(await wm.deviceAuthAvailable()).toBe(true);
    device.sealError = 'KEYSTORE';
    await expect(store(wm)).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
  });

  it('a check the device did not answer is DEVICE_LOCK_RETRY; only a definite no is DEVICE_LOCK', async () => {
    const wm = manager();
    device.availableError = 'KEYSTORE';
    await expect(store(wm)).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(await wm.deviceAuthAvailable()).toBe(false); // a caller that needs a yes gets none
    device.availableError = null;
    device.available = false;
    await expect(store(wm)).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    device.available = true;
    device.sealError = 'NOT_SET';
    await expect(store(wm)).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    expect(await DeviceAuthStore.availability()).toBe('yes');
  });
});

describe('MB-R2-01: a kept transaction is sent again whatever tab is open', () => {
  it('a sweep away from the Assets tab, while the app is in front and something is left to send', () => {
    const ws = read('src/screens/WalletScreen.js');
    const sweep = between(ws, '// A kept transaction the wallet still sends by itself goes out again whatever tab is open', 'useEffect(() => { activeTabRef.current');
    expect(sweep).toMatch(/if \(!address \|\| !appActive \|\| activeTab === 'assets'\) return undefined;/);
    expect(sweep).toMatch(/const kept = await walletManager\.pendingTransactions\(address\);\s*if \(!live \|\| !kept\.some\(\(e\) => autoSendable\(e\)\)\) return;\s*await walletManager\.sendDuePending\(address\);/);
    expect(sweep).toMatch(/const timer = setInterval\(sweep, KEPT_SWEEP_MS\);/);
    expect(sweep).toMatch(/return \(\) => \{ live = false; clearInterval\(timer\); \};/);
    expect(ws).toMatch(/const KEPT_SWEEP_MS = 15_000;/);
  });
});

describe('MB-R2-02: the Send form checks what the wallet may still spend, read now', () => {
  const ws = read('src/screens/WalletScreen.js');

  it('a balance no certified proof gave refuses the send, saying why; the figure on screen never stands in for it', () => {
    const fresh = between(ws, 'const freshQncNano = async () => {', '};');
    expect(fresh).not.toMatch(/tokenBalances/);
    expect(fresh).toMatch(/r && r\.ok && r\.verified && \/\^\\d\+\$\/\.test\(String\(r\.balanceNano\)\) \? r : \{ error: \(r && r\.error\) \|\| 'unanswered' $/m);
    const send = between(ws, 'const handleSendTransaction = async () => {', 'setSendingTransaction(true);');
    expect(send).toMatch(/if \(isQnetSend && qncCheck\.error\) \{\s*setTxResult\(\{ success: false, title: t\('send_cannot_title'\), error: sendCheckError\(qncCheck\.error\) \}\);\s*return;/);
    // A token send is checked against the token balance read again, and its QNC fee against what may still be spent.
    expect(send).toMatch(/walletManager\.checkedTokenBalance\(sendingToken\.contract, myQnetAddress, sendingToken\.decimals\)/);
    expect(send).not.toMatch(/amount > sendingToken\.balance/);
    // What may still be spent: the checked balance less what the wallet's unconfirmed transactions may still take, the
    // one a replacement signs over excepted.
    expect(send).toMatch(/const replaceNonce = pendingChoice && pendingChoice\.mode === 'replace' \? pendingChoice\.nonce : null;\s*spendable = afterPending\(qncNano, qncCheck\.pending, replaceNonce\);/);
    expect(ws).toMatch(/if \(spendable === null \|\| BigInt\(need\.needNano\) > spendable\) \{/);
    expect(t('send_balance_unreadable')).toBe('The network did not answer, so nothing was sent. Try again.');
    expect(t('balance_unconfirmed')).toBe('The balance is not confirmed yet. Try again in a minute.');
  });

  it('the finding\'s case: 10 QNC, 8 QNC unconfirmed, 5 QNC "in addition" is refused; replacing the 8 is not', () => {
    const p = {
      balanceNano: String(10e9), transferFeeNano: String(TRANSFER_FEE_NANO), replaceNonce: 7,
      pending: [{ nonce: 7, kind: 'transfer', amountNano: 8e9 }],
    };
    const need = BigInt(5e9 + TRANSFER_FEE_NANO);
    expect(spendableNano(p, null) < need).toBe(true);
    expect(spendableNano(p, 'replace') < need).toBe(false);
  });
});

describe('MB-R2-03: the sheet offers to read an unread balance again', () => {
  const QNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
  const labels = (tree) => tree.root.findAllByType(TouchableOpacity)
    .map((b) => ({ label: b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(''), props: b.props }));

  it('a preview without the balance shows Try again, which reads it again; Reject stays a rejection', async () => {
    const actions = { approve: jest.fn(), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() };
    const view = {
      id: 'a1', kind: 'send', origin: 'https://app.dapp.example', busy: false, queued: 0, outcome: null, previewError: null,
      details: { to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000' },
      preview: { nonce: 8, balanceNano: null, verified: false, counterparties: [], pending: [], recent: [], replaceNonce: null, appendNonce: null },
    };
    let tree;
    await act(async () => {
      tree = renderer.create(<DappSheet view={view} actions={actions} t={t} authenticate={jest.fn(async () => true)} accounts={{ qnet: QNET, solana: '' }} />);
    });
    const retry = labels(tree).find((b) => b.label === t('dapp_retry'));
    expect(retry).toBeTruthy();
    await act(async () => { retry.props.onPress(); });
    expect(actions.loadPreview).toHaveBeenCalledWith('a1');
    expect(actions.reject).not.toHaveBeenCalled();
    // With the balance read, Send is offered again in its place.
    await act(async () => { tree.update(<DappSheet view={{ ...view, preview: { ...view.preview, balanceNano: '9000000000' } }} actions={actions} t={t}
      authenticate={jest.fn(async () => true)} accounts={{ qnet: QNET, solana: '' }} />); });
    expect(labels(tree).some((b) => b.label === t('dapp_retry'))).toBe(false);
    await act(async () => { tree.unmount(); });
  });
});

describe('SD-R2-10: the submission notes say what is there', () => {
  it('no screenshot set that no longer exists, and one Data safety answer for device IDs', () => {
    const play = read('store-listing/google-play-description.txt');
    expect(play).not.toMatch(/predates the Node tab|icon, phone screenshots/);
    expect(play).toMatch(/fastlane\/metadata\/android\/en-US\/images\/\s+\(the icon only; no screenshots yet, see below\)/);
    const images = path.join(ROOT, '..', '..', 'fastlane', 'metadata', 'android', 'en-US', 'images');
    expect(fs.readdirSync(images).filter((f) => !f.startsWith('.'))).toEqual(['icon.png']);
    const readme = read('store-listing/README.md');
    expect(readme).not.toMatch(/gossip a hash of the push token|answer "shared"/);
    expect(readme).toMatch(/\| Device or other IDs \| Collected \*\*only while a node is linked\*\*:[^|]*\*\*Not shared\*\*/);
  });
});

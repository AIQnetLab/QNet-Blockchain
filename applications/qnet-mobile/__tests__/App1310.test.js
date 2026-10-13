// The sweep of 13.10 on both platforms: a new wallet's screen lock that keeps failing offers a wallet password (and logs
// why), turning on biometric unlock tells a refused prompt from a failure, and Delete wallet or a reinstall resets only
// the Keychain items the app itself writes.
const fs = require('fs');
const path = require('path');
const { Platform } = require('react-native');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');

jest.setTimeout(120000);

const ROOT = path.join(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'src/screens/WalletScreen.js'), 'utf8');
const between = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a) + a.length));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });

const MOCKED = ['setGenericPassword', 'getGenericPassword', 'resetGenericPassword', 'hasGenericPassword',
  'isPasscodeAuthAvailable', 'getAllGenericPasswordServices'];
const DEFAULTS = {};
const OS = Platform.OS;
beforeAll(() => { for (const k of MOCKED) DEFAULTS[k] = Keychain[k].getMockImplementation(); });
afterEach(() => {
  for (const k of MOCKED) Keychain[k].mockImplementation(DEFAULTS[k]);
  Platform.OS = OS;
  jest.restoreAllMocks();
});
beforeEach(async () => { await AsyncStorage.clear(); });

describe('a new wallet whose screen lock fails for now (create, import)', () => {
  it('says why in the log, and a password chosen instead sends the next attempt to the password step', async () => {
    Platform.OS = 'ios';
    const items = new Map();
    Keychain.isPasscodeAuthAvailable.mockImplementation(async () => true);
    Keychain.setGenericPassword.mockImplementation(async (u, p, o) => { items.set(o.service, p); return true; });
    Keychain.hasGenericPassword.mockImplementation(async (o) => items.has(o.service));
    Keychain.resetGenericPassword.mockImplementation(async (o) => { items.delete(o.service); return true; });
    // The prompt passes or not, and the read fails with the item still there: a failure for now.
    Keychain.getGenericPassword.mockImplementation(async () => {
      throw Object.assign(new Error('Authentication failed'), { code: '-25293' });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const wm = new WalletManager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(warn).toHaveBeenCalledWith('[WARN][DEVAUTH] retry stage=read code=-25293');
    // Nothing secret in what was logged.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/[0-9a-f]{32}|abandon/);
    expect(await wm.deviceAuthAvailable()).toBe(true);

    await wm.useWalletPassword();
    expect(await wm.deviceAuthAvailable()).toBe(false);
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    expect(await AsyncStorage.getItem(WalletManager.VAULT_KEY)).toBeNull();
  });

  it('a write the device refuses for now is logged with its stage and code', async () => {
    Platform.OS = 'ios';
    Keychain.isPasscodeAuthAvailable.mockImplementation(async () => true);
    Keychain.setGenericPassword.mockImplementation(async () => {
      throw Object.assign(new Error('Internal error'), { code: '-34018' });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new WalletManager().storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(warn).toHaveBeenCalledWith('[WARN][DEVAUTH] retry stage=write code=-34018');
  });

  it('the screen offers Use password with the error, and from the second failure in a row asks it as the question', () => {
    expect(screen).toMatch(/useEffect\(\(\) => \{ deviceLockRetriesRef\.current = 0; \}, \[showCreateOptions\]\);/);
    const fn = between(screen, 'const offerPasswordAfterRetry = ', '\n  };\n');
    expect(fn).toMatch(/deviceLockRetriesRef\.current \+= 1;/);
    expect(fn).toMatch(/text: t\('bio_use_password'\),\s*onPress: async \(\) => \{\s*deviceLockRetriesRef\.current = 0;\s*await walletManager\.useWalletPassword\(\);\s*refreshDeviceAuthAvail\(\);/);
    expect(fn).toMatch(/if \(deviceLockRetriesRef\.current >= 2\) \{\s*showAlert\(t\('device_lock_title'\), t\('device_lock_retry_offer'\), \[\{ text: t\('cancel'\), style: 'cancel' \}, usePassword\]\);/);
    expect(fn).toMatch(/showAlert\(t\('error'\), t\('device_unlock_unavailable'\), \[\{ text: t\('common_ok'\), style: 'cancel' \}, usePassword\]\);/);
    // Import goes on to its password step; create starts again with a password (its wallet was made without one).
    const imp = between(screen, 'const importWalletSteps = async', 'const importWallet = async');
    expect(imp).toMatch(/if \(e\.code === 'DEVICE_LOCK_RETRY'\) \{\s*offerPasswordAfterRetry\(\);\s*return;/);
    const create = between(screen, 'const confirmSeedPhrase = async', 'const _startLockoutCountdown');
    expect(create).toMatch(/offerPasswordAfterRetry\(\(\) => showAlert\(t\('device_lock_title'\), t\('device_lock_body'\)\)\);/);
    const en = require('../src/i18n/locales/en').default;
    expect(en.device_lock_retry_offer).not.toMatch(/\bwe\b/i);
  });
});

describe('turning on biometric unlock (Android)', () => {
  const load = (seal) => {
    let WM;
    jest.isolateModules(() => {
      jest.doMock('../src/services/DeviceSecurity', () => ({
        ...jest.requireActual('../src/services/DeviceSecurity'),
        biometricSealer: () => ({ name: 'android-biometric', seal, open: async () => { throw new Error('not used'); } }),
        biometricKeyAvailable: async () => true,
      }));
      WM = require('../src/components/WalletManager').WalletManager;
    });
    const wm = new WM();
    wm.usesDeviceAuth = async () => false;
    wm._openVault = async () => ({ vault: { version: 4, id: 'v' }, dek: new Uint8Array(32).fill(7) });
    wm._writeVault = jest.fn(async () => {});
    return wm;
  };

  it('tells a refused prompt from a failure, and from a device that cannot', async () => {
    const ok = load(async () => new Uint8Array(48));
    expect(await ok.enableBiometricUnlock('pw')).toEqual({ ok: true });
    expect(ok._writeVault).toHaveBeenCalledTimes(1);
    const refused = load(async () => { throw Object.assign(new Error('cancelled'), { code: 'BIO_CANCELLED' }); });
    expect(await refused.enableBiometricUnlock('pw')).toEqual({ ok: false, cancelled: true });
    expect(refused._writeVault).not.toHaveBeenCalled();
    const failed = load(async () => { throw Object.assign(new Error('sensor'), { code: 'BIO_ERROR' }); });
    expect(await failed.enableBiometricUnlock('pw')).toEqual({ ok: false });
    const lock = load(async () => new Uint8Array(48));
    lock.usesDeviceAuth = async () => true;
    expect(await lock.enableBiometricUnlock('pw')).toEqual({ ok: false, unavailable: true });
  });

  it('the screen: nothing on a refused prompt, "not available" only for a device that cannot, else the setting failed', () => {
    const fn = between(screen, 'const handleConfirmBiometricEnable = async', 'const resetWalletScopedState');
    expect(fn).toMatch(/if \(on && on\.ok\) \{\s*setBiometricEnabled\(true\);/);
    expect(fn).toMatch(/\} else if \(on && on\.unavailable\) \{\s*showAlert\(t\('error'\), t\('biometric_unavailable'\)\);/);
    expect(fn).toMatch(/\} else if \(!\(on && on\.cancelled\)\) \{\s*\/\/[^\n]*\n\s*showAlert\(t\('error'\), t\('err_save_setting'\)\);/);
  });
});

describe('Delete wallet and a reinstall reset only the app\'s own Keychain items', () => {
  it('another SDK\'s items in the app\'s Keychain groups stay', async () => {
    const OWN = ['qnet_ping_sk_light_mobile_1', 'qnet_pw_limiter', 'qnet_node_device_key_v1', 'com.qnet.wallet.biometric',
      'com.qnetmobile.vault-secret', 'com.qnetmobile.vault-secret.next', 'com.qnetmobile.older-item'];
    const OTHER = ['com.example.sdk.installations', 'com.example.push.token', 'io.aiqnet.wallet', ''];
    Keychain.getAllGenericPasswordServices.mockImplementation(async () => [...OWN, ...OTHER]);
    Keychain.resetGenericPassword.mockClear();
    await new WalletManager()._wipeKeychain();
    const reset = Keychain.resetGenericPassword.mock.calls.map(([o]) => o.service);
    expect(reset).toEqual(expect.arrayContaining(OWN));
    for (const s of OTHER) expect(reset).not.toContain(s);
    // The screen-lock items, which a listing that never prompts skips, are named.
    expect(reset).toEqual(expect.arrayContaining([WalletManager.DEVICE_AUTH_SERVICE, WalletManager.DEVICE_AUTH_NEXT_SERVICE]));
  });

  it('a listing that fails still resets the app\'s named items', async () => {
    Keychain.getAllGenericPasswordServices.mockImplementation(async () => { throw new Error('no listing'); });
    Keychain.resetGenericPassword.mockClear();
    await new WalletManager()._wipeKeychain();
    const reset = Keychain.resetGenericPassword.mock.calls.map(([o]) => o.service).sort();
    expect(reset).toEqual(['com.qnet.wallet.biometric', 'com.qnetmobile.vault-secret', 'com.qnetmobile.vault-secret.next',
      'qnet_node_device_key_v1', 'qnet_pw_limiter']);
  });
});

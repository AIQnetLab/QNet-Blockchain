// MS1-01: builds before 1.2.0 kept the wallet password itself in the Android Keychain behind a fingerprint key
// with a 5-second validity window that a newly enrolled fingerprint does not invalidate. That item is unsafe on
// sight: it is deleted with its key at launch, never read, never counted as "biometric unlock on", and the user is
// asked once to turn biometric unlock on again (the per-use biometric key).
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { Platform } = require('react-native');
const { WalletManager } = require('../src/components/WalletManager');
const { createVault } = require('../src/crypto/Vault');

// An Android password wallet: the vault's own biometric wrap, not the screen lock.
const OS = Platform.OS;
beforeAll(() => { Platform.OS = 'android'; });
afterAll(() => { Platform.OS = OS; });

const SERVICE = 'com.qnet.wallet.biometric';

async function withVault(extra = {}) {
  const { vault } = await createVault(JSON.stringify({ address: 'x' }), 'pw-123456789');
  const v = { ...vault, ...extra };
  await AsyncStorage.multiSet([['qnet_wallet', JSON.stringify(v)], ['qnet_wallet.bak', JSON.stringify(v)]]);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
  Keychain.hasGenericPassword.mockResolvedValue(false);
});

it('on iOS, and for a wallet under the screen lock, the same Keychain service is left alone', async () => {
  Keychain.hasGenericPassword.mockResolvedValue(true);
  Platform.OS = 'ios';
  try {
    expect(await new WalletManager().purgeLegacyBiometric()).toBe(false);
  } finally {
    Platform.OS = 'android';
  }
  await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_FLAG, '1');
  expect(await new WalletManager().purgeLegacyBiometric()).toBe(false);
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
});

it('an older build\'s biometric item is deleted with its key, and biometric unlock reads as off', async () => {
  await withVault();
  Keychain.hasGenericPassword.mockResolvedValue(true);
  const wm = new WalletManager();
  expect(await wm.purgeLegacyBiometric()).toBe(true);
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: SERVICE });
  expect(await wm.isBiometricEnabled()).toBe(false); // the item is never taken for "on"
  expect(Keychain.getGenericPassword).not.toHaveBeenCalledWith(expect.objectContaining({ service: SERVICE }));
  // Owed once: the next password unlock offers to turn it on again.
  expect(await wm.legacyBiometricNotice({ clear: true })).toBe(true);
  expect(await wm.legacyBiometricNotice()).toBe(false);
});

it('biometric unlock never reads the older item: without a biometric wrap it is off, and the item goes', async () => {
  await withVault();
  Keychain.hasGenericPassword.mockResolvedValue(true);
  Keychain.getGenericPassword.mockResolvedValue({ username: 'qnet_wallet', password: 'pw-123456789' });
  const wm = new WalletManager();
  const r = await wm.unlockWithBiometrics();
  expect(r).toEqual({ ok: false, cancelled: true });
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: SERVICE });
  expect(wm._session).toBeNull();
});

it('with a biometric wrap of its own the vault keeps biometric unlock on, and no notice is owed', async () => {
  await withVault({ bio: { v: 1, iv: 'aa', ct: 'bb' } });
  Keychain.hasGenericPassword.mockResolvedValue(true);
  const wm = new WalletManager();
  expect(await wm.purgeLegacyBiometric()).toBe(true);
  expect(await wm.isBiometricEnabled()).toBe(true);
  expect(await wm.legacyBiometricNotice()).toBe(false);
});

it('nothing to do when no older item exists', async () => {
  await withVault();
  Keychain.hasGenericPassword.mockResolvedValue(false);
  const wm = new WalletManager();
  expect(await wm.purgeLegacyBiometric()).toBe(false);
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  expect(await wm.legacyBiometricNotice()).toBe(false);
});

it('the lock screen removes it before it asks whether biometric unlock is on', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  // (On iOS the Keychain items move to the app's own group first: migrateKeychainGroup, MVA-R2-05.)
  expect(src).toMatch(/prepareInstall\(\)\s*\.then\(\(\) => walletManager\.migrateKeychainGroup\(\)\)\s*\.then\(\(\) => walletManager\.purgeLegacyBiometric\(\)\)[\s\S]{0,200}isBiometricEnabled\(\)/);
  // After a password unlock: the move to the screen lock comes first (O2, D1), the re-enrol notice otherwise.
  expect(src).toMatch(/await _openSession\(r\.token\);\s*if \(!\(await moveToDeviceUnlock\(pw\)\)\) offerBiometricReenroll\(\)/);
});

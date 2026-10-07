// A password wallet on iOS has a device seal as on Android (final audit MA-5): its password wrap is sealed to a Secure
// Enclave key, so a copy of the app's files (a device image of an iPhone without a passcode) cannot be guessed at off
// the device. The native side makes a P-256 key in the Secure Enclave, this device only, no user authentication.
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NativeModules, Platform } = require('react-native');

// The Secure Enclave key in memory: sealing and opening ask nothing; a deleted key opens nothing.
const enclave = { key: null, available: true, calls: [] };
const seal = (b64) => {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', enclave.key, iv);
  return Buffer.concat([iv, c.update(Buffer.from(b64, 'base64')), c.final(), c.getAuthTag()]).toString('base64');
};
NativeModules.QNetSecurity = {
  hwAvailable: jest.fn(async () => {
    if (enclave.available && !enclave.key) enclave.key = nodeCrypto.randomBytes(32);
    return enclave.available;
  }),
  hwSeal: jest.fn(async (b64) => {
    enclave.calls.push('seal');
    if (!enclave.key) enclave.key = nodeCrypto.randomBytes(32);
    return seal(b64);
  }),
  hwOpen: jest.fn(async (b64) => {
    enclave.calls.push('open');
    if (!enclave.key) throw Object.assign(new Error('gone'), { code: 'KEY_MISSING' });
    const b = Buffer.from(b64, 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', enclave.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('base64');
  }),
  deleteKeys: jest.fn(async () => { enclave.key = null; }),
};

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const { DeviceKeyError } = require('../src/crypto/Vault');

jest.setTimeout(240000);

const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: 'abandon '.repeat(11) + 'about' });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });

const OS = Platform.OS;
beforeEach(async () => {
  Platform.OS = 'ios';
  await AsyncStorage.clear();
  Object.assign(enclave, { key: null, available: true, calls: [] });
});
afterEach(() => { Platform.OS = OS; });

const storedVault = async () => JSON.parse(await AsyncStorage.getItem(WalletManager.VAULT_KEY));

it('a new password wallet on iOS is sealed by the Secure Enclave key, and opens only with it', async () => {
  expect((await DeviceSecurity.deviceSealer()).name).toBe(DeviceSecurity.IOS_DEVICE_SEALER);
  const wm = manager();
  await wm.storeWallet(walletB(), PW);
  expect((await storedVault()).hw).toBe('ios-secure-enclave-v1');
  expect(await wm.hardwareSealState()).toBe('sealed');
  wm.closeSession();
  expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
  expect(enclave.calls).toContain('open');
  // The files alone, without the enclave's key, open nothing: never a wrong password, and never counted as one.
  enclave.key = null;
  await expect(wm.unlockWithPassword(PW)).rejects.toBeInstanceOf(DeviceKeyError);
  expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
});

it('an iOS password wallet sealed before this build gets the seal at its next password unlock', async () => {
  enclave.available = false;
  const wm = manager();
  await wm.storeWallet(walletB(), PW);
  expect((await storedVault()).hw).toBeUndefined();
  expect(await wm.hardwareSealState()).toBe('unsealed');
  enclave.available = true;
  wm.closeSession();
  expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
  expect((await storedVault()).hw).toBe('ios-secure-enclave-v1');
  expect(await wm.hardwareSealState()).toBe('sealed');
});

it('Android names stay Android\'s: the iOS key is never asked for on Android, nor Android\'s on iOS', () => {
  expect(DeviceSecurity.deviceSealerFor('android-keystore-v2')).toBeNull();
  Platform.OS = 'android';
  expect(DeviceSecurity.deviceSealerFor('ios-secure-enclave-v1')).toBeNull();
  expect(DeviceSecurity.isCurrentDeviceSealer('ios-secure-enclave-v1')).toBe(true);
  expect(DeviceSecurity.isCurrentDeviceSealer('android-keystore')).toBe(false);
});

it('deleting the wallet deletes the enclave key', async () => {
  await DeviceSecurity.deviceSealer();
  expect(enclave.key).not.toBeNull();
  await DeviceSecurity.deleteDeviceKeys();
  expect(enclave.key).toBeNull();
});

it('the native key lives in the Secure Enclave, on this device only, with no user authentication', () => {
  const m = fs.readFileSync(path.join(__dirname, '../ios/QNetMobile/QNetSecurityModule.m'), 'utf8');
  expect(m).toMatch(/kSecAttrTokenIDSecureEnclave/);
  expect(m).toMatch(/kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAccessControlPrivateKeyUsage/);
  expect(m).not.toMatch(/kSecAccessControlUserPresence|kSecAccessControlBiometry|kSecAttrAccessibleWhenPasscodeSet/);
  expect(m).toMatch(/kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM/);
  for (const method of ['hwAvailable:', 'hwSeal:', 'hwOpen:', 'deleteKeys:']) expect(m).toContain(`RCT_EXPORT_METHOD(${method}`);
  // Opening never makes a key: a new one would not open the old seal.
  const open = m.slice(m.indexOf('RCT_EXPORT_METHOD(hwOpen:'), m.indexOf('RCT_EXPORT_METHOD(deleteKeys:'));
  expect(open).toMatch(/QNetCopySealKey\(NO, &status\)/);
});

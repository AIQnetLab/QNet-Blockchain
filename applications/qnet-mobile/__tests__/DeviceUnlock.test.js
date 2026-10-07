// One unlock rule on every device (O2): the wallet opens with the device's screen lock (Face ID, Touch ID, a fingerprint
// or the device passcode) when the device can hold a secret behind it, and with a wallet password otherwise, the same on
// iOS and Android. A password wallet keeps working and may move to the screen lock; the move never leaves the stored
// vault without a secret that opens it.
const nodeCrypto = require('crypto');
const { NativeModules, Platform } = require('react-native');

// The Android screen-lock key: sealing asks nothing; opening is one system prompt, which the user may refuse.
const device = { available: true, refuse: false, prompts: [] };
const KEY = nodeCrypto.randomBytes(32);
NativeModules.QNetSecurity = {
  devAuthAvailable: jest.fn(async () => device.available),
  devAuthSeal: jest.fn(async (b64) => {
    if (!device.available) throw Object.assign(new Error('no screen lock'), { code: 'NOT_SET' });
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', KEY, iv);
    return Buffer.concat([iv, c.update(Buffer.from(b64, 'base64')), c.final(), c.getAuthTag()]).toString('base64');
  }),
  devAuthOpen: jest.fn(async (blob, title) => {
    device.prompts.push(title);
    if (device.refuse) throw Object.assign(new Error('cancelled'), { code: 'BIO_CANCELLED' });
    const b = Buffer.from(blob, 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('base64');
  }),
};

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');

jest.setTimeout(240000);

const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });

// The iOS Keychain in memory; an item behind the screen lock is read through one prompt the user may refuse.
let items;
const DEFAULTS = {};
const MOCKED = ['setGenericPassword', 'getGenericPassword', 'resetGenericPassword', 'hasGenericPassword', 'isPasscodeAuthAvailable'];
beforeAll(() => { for (const k of MOCKED) DEFAULTS[k] = Keychain[k].getMockImplementation(); });
afterAll(() => { for (const k of MOCKED) Keychain[k].mockImplementation(DEFAULTS[k]); });

const OS = Platform.OS;
beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(device, { available: true, refuse: false, prompts: [] });
  items = new Map();
  Keychain.setGenericPassword.mockImplementation(async (u, p, o) => {
    if (o.accessControl && !device.available) throw new Error('errSecAuthFailed');
    items.set(o.service, p);
    return true;
  });
  Keychain.getGenericPassword.mockImplementation(async (o) => {
    if (!items.has(o.service)) return false;
    if (o.authenticationPrompt) {
      device.prompts.push(o.authenticationPrompt.title);
      if (device.refuse) throw new Error('User canceled the operation.');
    }
    return { username: 'qnet_wallet', password: items.get(o.service) };
  });
  Keychain.resetGenericPassword.mockImplementation(async (o) => { items.delete(o.service); return true; });
  Keychain.hasGenericPassword.mockImplementation(async (o) => items.has(o.service));
  Keychain.isPasscodeAuthAvailable.mockImplementation(async () => device.available);
});
afterEach(() => { Platform.OS = OS; });

// Where each platform keeps the item under `service`, as stored (never read through the prompt here).
const storedItem = (service) => (Platform.OS === 'ios' ? items.get(service) : AsyncStorage.getItem(`qnet_devauth_${service}`));

describe.each(['ios', 'android'])('%s', (os) => {
  beforeEach(() => { Platform.OS = os; });

  it('with a screen lock, a new wallet opens with it: no password, one prompt per unlock', async () => {
    const wm = manager();
    expect(await wm.deviceAuthAvailable()).toBe(true);
    const token = await wm.storeWalletWithDeviceAuth(walletB());
    expect(wm.sessionOpen(token)).toBe(true);
    expect(await wm.usesDeviceAuth()).toBe(true);
    expect(await wm.isBiometricEnabled()).toBe(true);
    expect(await wm.isBiometricSupported()).toBe(false); // no second biometric option beside the screen lock
    const kept = await storedItem(WalletManager.DEVICE_AUTH_SERVICE);
    expect(typeof kept).toBe('string');
    wm.closeSession();
    device.prompts = [];
    const r = await wm.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    expect(device.prompts).toHaveLength(1);
    expect(await wm.revealMnemonic(WalletManager.deviceAuthCredential('Show'))).toEqual({ ok: true, mnemonic: MNEMONIC });
    // A refused prompt opens nothing and counts nothing.
    wm.closeSession();
    device.refuse = true;
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, cancelled: true });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
  });

  it('without a screen lock, the wallet has a password, and nothing is kept behind a lock', async () => {
    device.available = false;
    const wm = manager();
    expect(await wm.deviceAuthAvailable()).toBe(false);
    await expect(wm.storeWalletWithDeviceAuth(walletB())).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    expect(await AsyncStorage.getItem(WalletManager.VAULT_KEY)).toBeNull();
    await wm.storeWallet(walletB(), PW);
    expect(await wm.usesDeviceAuth()).toBe(false);
    wm.closeSession();
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    expect((await wm.unlockWithPassword('Otter-Canyon-58')).ok).toBe(false);
  });

  it('a password wallet holds no screen-lock secret, even one a refused attempt left behind', async () => {
    const wm = manager();
    expect(await wm.enableDeviceAuthUnlock(wm.generateVaultPassword())).toBe(true); // the attempt that then failed
    expect(await storedItem(WalletManager.DEVICE_AUTH_SERVICE)).toBeTruthy();
    await wm.storeWallet(walletB(), PW);
    expect(await storedItem(WalletManager.DEVICE_AUTH_SERVICE)).toBeFalsy();
    expect(await manager().usesDeviceAuth()).toBe(false);
  });

  it('an existing password wallet keeps its password until it moves, and then the screen lock alone opens it', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    wm.closeSession();
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    // A wrong password moves nothing and is counted.
    expect(await wm.switchToDeviceAuth('Otter-Canyon-58', 'Turn on')).toMatchObject({ ok: false });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(1);
    // A refused prompt moves nothing: the password still opens it and no item is left.
    device.refuse = true;
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: false, cancelled: true });
    device.refuse = false;
    expect(await wm.usesDeviceAuth()).toBe(false);
    expect(await storedItem(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeFalsy();
    expect((await wm.checkPassword(PW)).ok).toBe(true);
    // The move: one prompt reads the new secret back before anything changes.
    device.prompts = [];
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: true });
    expect(device.prompts).toEqual(['Turn on']);
    expect(await wm.usesDeviceAuth()).toBe(true);
    expect(await storedItem(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeFalsy();
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: false, unavailable: true });
    const fresh = manager();
    expect((await fresh.checkPassword(PW)).ok).toBe(false); // the password opens nothing stored now
    const r = await fresh.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    expect((await fresh.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect(await fresh.revealMnemonic(WalletManager.deviceAuthCredential('Show'))).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('a move that stopped after the flag went up still opens: the staging item holds the password', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const write = AsyncStorage.multiSet;
    AsyncStorage.multiSet = jest.fn(async (pairs) => {
      if (pairs.some(([k]) => k === WalletManager.VAULT_KEY)) throw new Error('killed');
      return write(pairs);
    });
    try {
      await expect(wm.switchToDeviceAuth(PW, 'Turn on')).rejects.toThrow('killed');
    } finally {
      AsyncStorage.multiSet = write;
    }
    expect(await wm.usesDeviceAuth()).toBe(true);
    const fresh = manager();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
    expect(await storedItem(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeFalsy(); // settled into the current item
    fresh.closeSession();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
  });

  it('a device whose screen lock cannot hold a secret is never offered the move', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    device.available = false;
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: false, unavailable: true });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
    expect((await wm.checkPassword(PW)).ok).toBe(true);
  });
});

describe('a wallet an older build sealed under the screen lock', () => {
  it('on iOS keeps opening with it when its flag is missing: the flag follows its item', async () => {
    Platform.OS = 'ios';
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    await AsyncStorage.removeItem(WalletManager.DEVICE_AUTH_FLAG);
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(true);
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBe('1');
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
  });

  it('a password wallet on iOS is never taken for one', async () => {
    Platform.OS = 'ios';
    await manager().storeWallet(walletB(), PW);
    expect(await manager().usesDeviceAuth()).toBe(false);
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBeNull();
  });
});

describe('the screen', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');

  it('decides by what the device and the stored wallet can do, never by platform', () => {
    expect(src).toMatch(/const deviceAuth = hasWallet \? walletDeviceAuth : deviceAuthAvail;/);
    expect(src).not.toMatch(/Platform\.OS[^\n]*deviceAuth|deviceAuth[^\n]*Platform\.OS/);
    expect(src).toMatch(/walletManager\.switchToDeviceAuth\(pw, t\('auth_device_unlock'\)\)/);
  });
});

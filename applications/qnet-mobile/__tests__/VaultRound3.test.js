// Round-3 vault findings: the install wipe runs only on a definite "no wallet" (MVA-R3-01), a Keystore that did not
// answer is never a lost key (MVA-R3-02), the iOS vault secret stays out of the screen and is replaced daily without
// ever leaving the Keychain unable to open what is stored (MVA-R3-03), and a device with no passcode confirms
// nothing that moves value (MVA-R3-04).
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const V = require('../src/crypto/Vault');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const { WalletManager, VaultCorruptError } = require('../src/components/WalletManager');

jest.setTimeout(240000);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });

// Spies are restored one by one: jest.restoreAllMocks would also strip the AsyncStorage and Keychain mocks.
const spies = [];
const spy = (obj, name) => { const s = jest.spyOn(obj, name); spies.push(s); return s; };
const swaps = [];
const swap = (obj, name, fn) => { swaps.push([obj, name, obj[name]]); obj[name] = fn; return fn; };

// An in-memory Keychain (service -> password); a write deletes first, as react-native-keychain does on iOS.
let items;
const DEFAULTS = {};
beforeAll(() => {
  for (const k of ['setGenericPassword', 'getGenericPassword', 'resetGenericPassword', 'getAllGenericPasswordServices']) {
    DEFAULTS[k] = Keychain[k].getMockImplementation();
  }
});
beforeEach(async () => {
  await AsyncStorage.clear();
  items = new Map();
  Keychain.setGenericPassword.mockImplementation(async (username, password, o) => { items.set(o.service, password); return true; });
  Keychain.getGenericPassword.mockImplementation(async (o) => (items.has(o.service) ? { username: 'qnet_wallet', password: items.get(o.service) } : false));
  Keychain.resetGenericPassword.mockImplementation(async (o) => { items.delete(o.service); return true; });
  Keychain.getAllGenericPasswordServices.mockImplementation(async () => [...items.keys()]);
});
afterEach(() => {
  while (spies.length) spies.pop().mockRestore();
  while (swaps.length) { const [obj, name, orig] = swaps.pop(); obj[name] = orig; }
});
afterAll(() => {
  for (const [k, impl] of Object.entries(DEFAULTS)) Keychain[k].mockImplementation(impl);
});

describe('MVA-R3-01: the install wipe needs a definite "no wallet"', () => {
  it('a vault that cannot be read at the first launch keeps every key and gets no marker', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    await AsyncStorage.removeItem(WalletManager.INSTALL_MARKER);
    items.set(WalletManager.DEVICE_AUTH_SERVICE, 'the-only-secret');
    const wipe = spy(DeviceSecurity, 'deleteDeviceKeys');
    const orig = AsyncStorage.multiGet;
    // The marker reads (absent: the first launch of this build); the vault's read fails.
    const reads = swap(AsyncStorage, 'multiGet', jest.fn(async (keys) => {
      if (keys.includes(WalletManager.VAULT_KEY)) throw new Error('SQLITE_IOERR');
      return orig(keys);
    }));
    await wm.prepareInstall();
    expect(reads.mock.calls.some(([keys]) => keys.includes(WalletManager.VAULT_KEY))).toBe(true);
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe('the-only-secret');
    expect(wipe).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(WalletManager.INSTALL_MARKER)).toBeNull();
    // Readable again: a stored vault is an update, marked, nothing wiped.
    AsyncStorage.multiGet = orig;
    await wm.prepareInstall();
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe('the-only-secret');
    expect(wipe).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(WalletManager.INSTALL_MARKER)).toBe('1');
  });

  it('a damaged vault is not a fresh install either', async () => {
    await AsyncStorage.multiSet([['qnet_wallet', '{not json'], ['qnet_wallet.bak', '{not json']]);
    items.set(WalletManager.DEVICE_AUTH_SERVICE, 'the-only-secret');
    await manager().prepareInstall();
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe('the-only-secret');
    expect(await AsyncStorage.getItem(WalletManager.INSTALL_MARKER)).toBeNull();
  });

  it('only a definite "none" wipes what an uninstall left in the Keychain', async () => {
    items.set(WalletManager.DEVICE_AUTH_SERVICE, 'left-from-before');
    items.set(WalletManager.DEVICE_AUTH_NEXT_SERVICE, 'left-from-before');
    const wipe = spy(DeviceSecurity, 'deleteDeviceKeys');
    await manager().prepareInstall();
    expect(items.size).toBe(0);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(WalletManager.INSTALL_MARKER)).toBe('1');
  });
});

function sealer(behaviour) {
  const key = nodeCrypto.randomBytes(32);
  return {
    name: 'android-keystore',
    seal: async (bytes) => {
      const iv = nodeCrypto.randomBytes(12);
      const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
      return new Uint8Array(Buffer.concat([iv, c.update(Buffer.from(bytes)), c.final(), c.getAuthTag()]));
    },
    open: async (bytes) => {
      const code = behaviour.code;
      if (code) throw Object.assign(new Error('keystore said no'), { code });
      const b = Buffer.from(bytes);
      const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
    },
  };
}

describe('MVA-R3-02: a Keystore that did not answer is not a lost key', () => {
  it('classifies the native codes: only a gone, invalidated, corrupted or replaced key is permanent', () => {
    for (const code of ['device_key', 'KEY_MISSING', 'KEY_INVALIDATED', 'KEY_CORRUPTED', 'KEY_MISMATCH']) {
      expect([code, new V.DeviceKeyError('x', code).permanent]).toEqual([code, true]);
    }
    for (const code of ['KEYSTORE', 'KEYSTORE_BUSY', 'DEVICE_LOCKED']) {
      expect([code, new V.DeviceKeyError('x', code).permanent]).toEqual([code, false]);
    }
  });

  it('a busy Keystore fails the unlock uncounted and retryable, and the next try opens', async () => {
    const behaviour = { code: null };
    const hw = sealer(behaviour);
    spy(DeviceSecurity, 'deviceSealer').mockResolvedValue(hw);
    const wm = manager();
    wm._sealerFor = () => hw;
    await wm.storeWallet(walletB(), PW);
    for (const code of ['KEYSTORE_BUSY', 'DEVICE_LOCKED', 'KEYSTORE']) {
      behaviour.code = code;
      const e = await wm.unlockWithPassword(PW).catch((x) => x);
      expect(e).toBeInstanceOf(V.DeviceKeyError);
      expect([code, e.permanent]).toEqual([code, false]);
    }
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
    behaviour.code = null;
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    behaviour.code = 'KEY_MISSING';
    const lost = await wm.unlockWithPassword(PW).catch((x) => x);
    expect(lost.permanent).toBe(true);
    // A blob too short to be sealed data is damage of the vault, not a device-key answer.
    behaviour.code = 'SEALED_DAMAGED';
    await expect(wm.unlockWithPassword(PW)).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it('the recovery screen, with its Erase, is for a permanent loss only; the native side reports transient failures apart', () => {
    const screen = read('src/screens/WalletScreen.js');
    const handler = screen.slice(screen.indexOf('const handleVaultError'), screen.indexOf('const handleBiometricUnlock'));
    expect(handler).toMatch(/if \(error\.permanent\) setVaultProblem\('device_key'\);\s*else showAlert\(t\('qnet_wallet'\), t\('vault_device_busy'\)\);/);
    const kotlin = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kotlin).toMatch(/isTransientFailure\) return "KEYSTORE_BUSY"/);
    expect(kotlin).toMatch(/ERROR_KEY_DOES_NOT_EXIST -> return "KEY_MISSING"/);
    expect(kotlin).toMatch(/is AEADBadTagException \}\) return "KEY_MISMATCH"/);
    expect(kotlin).not.toMatch(/t is IllegalStateException\) "KEY_MISSING"/);
  });
});

describe('MVA-R3-03: the screen-lock vault secret stays in the wallet manager and is replaced daily', () => {
  // A device with a passcode: the wallet opens with the screen lock.
  beforeEach(() => { Keychain.isPasscodeAuthAvailable.mockResolvedValue(true); });
  afterEach(() => { Keychain.isPasscodeAuthAvailable.mockResolvedValue(false); });

  it('a new wallet is sealed under a secret the screen never sees', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB());
    expect(wm.sessionOpen(token)).toBe(true);
    expect(await wm.usesDeviceAuth()).toBe(true);
    const secret = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    expect(typeof secret).toBe('string');
    expect(Buffer.from(secret, 'base64')).toHaveLength(32);
    expect(await AsyncStorage.getItem(WalletManager.VAULT_SECRET_AT_KEY)).toMatch(/^\d+$/);
    // A second wallet never takes the place of a stored one, nor its Keychain secret.
    await expect(wm.storeWalletWithDeviceAuth(walletB())).rejects.toMatchObject({ code: 'WALLET_EXISTS' });
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe(secret);
    // The screen asks with a credential, not with the secret.
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).not.toMatch(/generateVaultPassword\(/);
    expect(screen).not.toMatch(/deviceAuthSecret\(/);
    expect(screen).toMatch(/WalletManager\.deviceAuthCredential\(reason\)/);
    expect(screen).toMatch(/storeWalletWithDeviceAuth\(tempWallet, t\('auth_device_unlock'\)\)/);
    expect(screen).toMatch(/storeWalletWithDeviceAuth\(imported, t\('auth_device_unlock'\)\)/);
  });

  it('a device that refuses the secret (no passcode) gets no vault', async () => {
    // The passcode went between the check and the write: asked again, the device says there is none.
    Keychain.isPasscodeAuthAvailable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    Keychain.setGenericPassword.mockImplementationOnce(async () => { throw new Error('errSecParam'); });
    await expect(manager().storeWalletWithDeviceAuth(walletB())).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    expect(await AsyncStorage.getItem('qnet_wallet')).toBeNull();
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBeNull();
    // A write refused while the device still has its passcode is for now (MA-R2-04): the same step asks again.
    Keychain.setGenericPassword.mockImplementationOnce(async () => { throw new Error('errSecInteractionNotAllowed'); });
    await expect(manager().storeWalletWithDeviceAuth(walletB())).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(await AsyncStorage.getItem('qnet_wallet')).toBeNull();
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBeNull();
  });

  it('the phrase is revealed behind the credential, and a refused prompt counts nothing', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    const r = await wm.revealMnemonic(WalletManager.deviceAuthCredential('Show the recovery phrase'));
    expect(r).toEqual({ ok: true, mnemonic: MNEMONIC });
    const secret = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    // No item to read (iOS removed it with the passcode): nothing is read, nothing counted, and the answer says the secret
    // is gone rather than that a prompt was cancelled (final audit MA-1).
    items.delete(WalletManager.DEVICE_AUTH_SERVICE);
    expect(await wm.checkPassword(WalletManager.deviceAuthCredential('x'))).toEqual({ ok: false, gone: true });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
    items.set(WalletManager.DEVICE_AUTH_SERVICE, secret);
  });

  it('a day after the last one, an unlock replaces the secret; the old one opens nothing stored after it', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    const old = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    wm.closeSession();
    // Within the day: the same secret.
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe(old);
    wm.closeSession();
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now() - WalletManager.VAULT_SECRET_MAX_AGE_MS - 1000));
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    const next = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    expect(next).not.toBe(old);
    expect(items.has(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBe(false);
    // The copy of the old secret someone took from memory opens nothing now; the payload and phrase stayed.
    const fresh = manager();
    expect((await fresh.checkPassword(old)).ok).toBe(false);
    expect((await fresh.revealMnemonic(next)).mnemonic).toBe(MNEMONIC);
  });

  it('a rotation that stopped halfway leaves a Keychain that still opens the stored vault', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    const old = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    wm.closeSession();
    // Stopped after the staging item, before the vault was written.
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now() - WalletManager.VAULT_SECRET_MAX_AGE_MS - 1000));
    const write = AsyncStorage.multiSet;
    swap(AsyncStorage, 'multiSet', jest.fn(async (pairs) => {
      if (pairs.some(([k]) => k === WalletManager.VAULT_KEY)) throw new Error('killed'); // the app died writing the vault
      return write(pairs);
    }));
    expect((await wm.unlockWithBiometrics()).ok).toBe(true); // the unlock itself succeeds
    AsyncStorage.multiSet = write;
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe(old);
    expect(JSON.parse(items.get(WalletManager.DEVICE_AUTH_NEXT_SERVICE))).toMatchObject({ s: old });
    wm.closeSession();
    // The next unlock reads the staging item first, opens with the old secret, and settles.
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now()));
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe(old);
    expect(items.has(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBe(false);
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
  });

  it('stopped after the vault was written, before the current item took the new secret: the staging item opens it', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    const old = items.get(WalletManager.DEVICE_AUTH_SERVICE);
    wm.closeSession();
    await AsyncStorage.setItem(WalletManager.VAULT_SECRET_AT_KEY, String(Date.now() - WalletManager.VAULT_SECRET_MAX_AGE_MS - 1000));
    // The current item's write fails (after the vault was rewrapped for the new secret).
    const set = Keychain.setGenericPassword.getMockImplementation();
    Keychain.setGenericPassword.mockImplementation(async (u, p, o) => {
      if (o.service === WalletManager.DEVICE_AUTH_SERVICE) { items.delete(o.service); throw new Error('add failed'); }
      return set(u, p, o);
    });
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    Keychain.setGenericPassword.mockImplementation(set);
    expect(items.has(WalletManager.DEVICE_AUTH_SERVICE)).toBe(false); // deleted by the failed replace
    const staged = JSON.parse(items.get(WalletManager.DEVICE_AUTH_NEXT_SERVICE));
    expect(staged.s).toBe(old);
    wm.closeSession();
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toBe(staged.n);
    expect(items.has(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBe(false);
  });
});

describe('MVA-R3-04: no passcode confirms nothing that moves value', () => {
  it('confirmFresh refuses "not_set" and locks; only Delete and Erase keep their own rule', () => {
    const screen = read('src/screens/WalletScreen.js');
    const fresh = screen.slice(screen.indexOf('const confirmFresh = async'), screen.indexOf('const resolveFresh'));
    expect(fresh).not.toMatch(/return auth\.ok \|\| auth\.code === 'not_set'/);
    expect(fresh).toMatch(/if \(auth\.ok\) return true;/);
    // Refused, and the wallet locks unless its open session protects it again right now (final audit MA-1): the one
    // way left to a vault whose screen-lock secret went with the screen lock.
    expect(fresh).toMatch(/if \(auth\.code === 'not_set'\) deviceSecretGone\(\);/);
    const gone = fresh.slice(fresh.indexOf('const deviceSecretGone = async'));
    expect(gone).toMatch(/text: t\('reprotect_later'\), style: 'cancel', onPress: \(\) => \{\s*lockSession\(\);/);
    expect(fresh).toMatch(/return false;/);
    // Delete wallet and Erase: the vault may already be unopenable, so a device with no passcode can still remove it.
    expect(screen.match(/auth\.code !== 'not_set'/g)).toHaveLength(2);
  });
});

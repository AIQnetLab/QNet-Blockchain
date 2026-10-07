// A wallet under the screen lock whose secret the device deleted (the screen lock removed, maybe set again since), and
// the moves between a password and the screen lock (final audit MA-1, MA-3, MA-4, MA-6, MA-7): the lock screen says the
// secret is gone instead of doing nothing; an open session can protect the wallet again; the typed password is never
// kept behind the screen lock; a new wallet's secret is read back through the screen lock before the vault is written.
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NativeModules, Platform } = require('react-native');

// Android's screen-lock key, as the Keystore behaves: sealing asks nothing; opening is one system prompt; removing the
// screen lock deletes the key, and a key made after that is another key (its blobs name the key that sealed them).
const device = { available: true, refuse: false, error: null, prompts: [], keyId: 1 };
const KEYS = new Map([[1, nodeCrypto.randomBytes(32)]]);
const sealWith = (id, plain) => {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', KEYS.get(id), iv);
  return Buffer.concat([Buffer.from([id]), iv, c.update(plain), c.final(), c.getAuthTag()]);
};
const openBlob = (b) => {
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', KEYS.get(b[0]), b.subarray(1, 13));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]);
};
NativeModules.QNetSecurity = {
  devAuthAvailable: jest.fn(async () => device.available && device.keyId !== null),
  devAuthSeal: jest.fn(async (b64) => {
    if (!device.available) throw Object.assign(new Error('no screen lock'), { code: 'NOT_SET' });
    return sealWith(device.keyId, Buffer.from(b64, 'base64')).toString('base64');
  }),
  devAuthOpen: jest.fn(async (blob, title) => {
    if (!device.available) throw Object.assign(new Error('no screen lock'), { code: 'NOT_SET' });
    const b = Buffer.from(blob, 'base64');
    if (device.keyId === null || b[0] !== device.keyId) throw Object.assign(new Error('another key'), { code: 'KEY_MISSING' });
    device.prompts.push(title);
    if (device.refuse) throw Object.assign(new Error('cancelled'), { code: 'BIO_CANCELLED' });
    if (device.error) throw Object.assign(new Error('prompt failed'), { code: device.error });
    return openBlob(b).toString('base64');
  }),
  devAuthUsable: jest.fn(async (blob) => (device.available && Buffer.from(blob, 'base64')[0] === device.keyId ? 'ok' : 'gone')),
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

// The iOS Keychain in memory: an item behind the screen lock is read through one prompt, and iOS removes every such
// item with the passcode.
let items;
const DEFAULTS = {};
const MOCKED = ['setGenericPassword', 'getGenericPassword', 'resetGenericPassword', 'hasGenericPassword', 'isPasscodeAuthAvailable'];
beforeAll(() => { for (const k of MOCKED) DEFAULTS[k] = Keychain[k].getMockImplementation(); });
afterAll(() => { for (const k of MOCKED) Keychain[k].mockImplementation(DEFAULTS[k]); });

const OS = Platform.OS;
// A screen-lock path that takes the secret and cannot give it back (MA-6): Android's prompt passes and the key still does
// not open (UserNotAuthenticated); an iOS item that is gone at its first read. A prompt that fails for now is not one.
const breakReadBack = () => {
  if (Platform.OS === 'android') device.error = 'DEVICE_LOCKED';
  else device.broken = true;
};
beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(device, { available: true, refuse: false, error: null, broken: false, prompts: [], keyId: 1 });
  items = new Map();
  Keychain.setGenericPassword.mockImplementation(async (u, p, o) => {
    if (o.accessControl && !device.available) throw new Error('errSecAuthFailed');
    items.set(o.service, { password: p, locked: !!o.accessControl });
    return true;
  });
  Keychain.getGenericPassword.mockImplementation(async (o) => {
    if (!items.has(o.service)) return false;
    if (o.authenticationPrompt) {
      device.prompts.push(o.authenticationPrompt.title);
      if (device.refuse) throw Object.assign(new Error('User canceled the operation.'), { code: '-128' });
      if (device.error) throw Object.assign(new Error('Authentication failed'), { code: '-25293' });
      // A Keychain that took the item and cannot give it back: it is gone at the first read.
      if (device.broken) {
        items.delete(o.service);
        throw Object.assign(new Error('The specified item could not be found in the keychain.'), { code: '-25300' });
      }
    }
    return { username: 'qnet_wallet', password: items.get(o.service).password };
  });
  Keychain.resetGenericPassword.mockImplementation(async (o) => { items.delete(o.service); return true; });
  Keychain.hasGenericPassword.mockImplementation(async (o) => items.has(o.service));
  Keychain.isPasscodeAuthAvailable.mockImplementation(async () => device.available);
});
afterEach(() => { Platform.OS = OS; });

// The screen lock goes: iOS deletes its items, Android's keystore its key.
function removeScreenLock() {
  device.available = false;
  device.keyId = null;
  for (const [service, item] of [...items]) if (item.locked) items.delete(service);
}
// A new screen lock: a new Android key; iOS items stay gone.
function setScreenLockAgain() {
  device.available = true;
  const id = Math.max(...KEYS.keys()) + 1;
  KEYS.set(id, nodeCrypto.randomBytes(32));
  device.keyId = id;
}
// The secret an item holds, as stored (never through a prompt).
async function storedSecret(service) {
  if (Platform.OS === 'ios') return items.has(service) ? items.get(service).password : null;
  const blob = await AsyncStorage.getItem(`qnet_devauth_${service}`);
  return blob ? openBlob(Buffer.from(blob, 'base64')).toString('utf8') : null;
}

describe.each(['ios', 'android'])('%s: a screen lock removed while the wallet uses it (MA-1)', (os) => {
  beforeEach(() => { Platform.OS = os; });

  it('the lock screen learns the secret is gone: no silent cancel, and nothing is counted', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    wm.closeSession();
    removeScreenLock();
    expect(await wm.deviceAuthSecretState()).toBe('gone');
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, gone: true });
    setScreenLockAgain(); // a new screen lock brings nothing back
    expect(await wm.deviceAuthSecretState()).toBe('gone');
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, gone: true });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
  });

  it('a refused prompt is still a cancel, and a secret that is there reads as present', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    wm.closeSession();
    expect(await wm.deviceAuthSecretState()).toBe('present');
    device.refuse = true;
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, cancelled: true });
    device.refuse = false;
    device.error = 'BIO_ERROR';
    expect(await wm.unlockWithBiometrics()).toEqual({ ok: false, failed: true });
  });

  it('while open, a new wallet password protects it again, and the password alone opens it afterwards', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    removeScreenLock();
    await expect(wm.reprotectWithPassword(token, 'short')).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    expect(await wm.reprotectWithPassword(token, PW)).toEqual({ ok: true });
    expect(wm.sessionOpen(token)).toBe(true); // the open session keeps working
    expect(await wm.usesDeviceAuth()).toBe(false);
    for (const s of [WalletManager.DEVICE_AUTH_SERVICE, WalletManager.DEVICE_AUTH_NEXT_SERVICE]) expect(await storedSecret(s)).toBeNull();
    const fresh = manager();
    const r = await fresh.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    expect((await fresh.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect(await fresh.revealMnemonic(PW)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('with a screen lock set again, the screen lock protects it again through one prompt', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    removeScreenLock();
    expect(await wm.reprotectWithDeviceAuth(token, 'Protect again')).toEqual({ ok: false, unavailable: true });
    setScreenLockAgain();
    device.refuse = true;
    expect(await wm.reprotectWithDeviceAuth(token, 'Protect again')).toEqual({ ok: false, cancelled: true });
    device.refuse = false;
    device.prompts = [];
    expect(await wm.reprotectWithDeviceAuth(token, 'Protect again')).toEqual({ ok: true });
    expect(device.prompts).toEqual(['Protect again']);
    expect(await wm.deviceAuthSecretState()).toBe('present');
    const fresh = manager();
    const r = await fresh.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    expect((await fresh.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
  });

  it('a move to a password that stopped after its vault write opens with the password, not the lost screen lock', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    removeScreenLock();
    const remove = AsyncStorage.removeItem;
    AsyncStorage.removeItem = jest.fn(async (k) => {
      if (k === WalletManager.DEVICE_AUTH_FLAG) throw new Error('killed');
      return remove(k);
    });
    try {
      await expect(wm.reprotectWithPassword(token, PW)).rejects.toThrow('killed');
    } finally {
      AsyncStorage.removeItem = remove;
    }
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBe('1');
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(false); // the stored vault has the new wrap: the move is settled
    expect((await fresh.unlockWithPassword(PW)).ok).toBe(true);
  });

  it('a move to a password whose vault write never happened changes nothing', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    const write = AsyncStorage.multiSet;
    AsyncStorage.multiSet = jest.fn(async (pairs) => {
      if (pairs.some(([k]) => k === WalletManager.VAULT_KEY)) throw new Error('killed');
      return write(pairs);
    });
    try {
      await expect(wm.reprotectWithPassword(token, PW)).rejects.toThrow('killed');
    } finally {
      AsyncStorage.multiSet = write;
    }
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(true);
    expect(await AsyncStorage.getItem(WalletManager.PASSWORD_MOVE_KEY)).toBeNull();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
  });

  // iOS writes a multiSet key by key and reports a failed key only at the end (MA-R3-01): the primary under the new
  // password written, the backup refused, `times` vault writes.
  const primaryOnly = (times, onError = () => {}) => {
    const write = AsyncStorage.multiSet;
    let left = times;
    AsyncStorage.multiSet = jest.fn(async (pairs) => {
      if (left <= 0 || !pairs.some(([k]) => k === WalletManager.VAULT_KEY)) return write(pairs);
      left -= 1;
      for (const pair of pairs) if (pair[0] !== WalletManager.VAULT_BACKUP_KEY) await write([pair]);
      onError();
      throw new Error('Failed to write value.');
    });
    return () => { AsyncStorage.multiSet = write; };
  };

  it('a move to a password whose write reports an error after storing the new vault stands (MA-R3-01)', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    removeScreenLock();
    const restore = primaryOnly(2);
    try {
      expect(await wm.reprotectWithPassword(token, PW)).toEqual({ ok: true });
    } finally {
      restore();
    }
    expect((await wm.loadWallet(token)).qnetAddress).toBe(B.qnet); // the open session opens the stored payload
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBeNull();
    expect(await AsyncStorage.getItem(WalletManager.PASSWORD_MOVE_KEY)).toBeNull();
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(false);
    expect((await fresh.unlockWithPassword(PW)).ok).toBe(true);
  });

  it('a move whose stored copies cannot be read after the error keeps its marker, and the next read settles it (MA-R3-01)', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    removeScreenLock();
    let unreadable = 0;
    const restore = primaryOnly(1, () => { unreadable = 4; }); // the rotation's three reads back, then the settle in the catch
    const read = AsyncStorage.multiGet;
    AsyncStorage.multiGet = jest.fn(async (keys) => {
      if (unreadable > 0 && keys.includes(WalletManager.VAULT_KEY)) {
        unreadable -= 1;
        throw new Error('storage busy');
      }
      return read(keys);
    });
    try {
      await expect(wm.reprotectWithPassword(token, PW)).rejects.toMatchObject({ unsettled: true });
    } finally {
      restore();
      AsyncStorage.multiGet = read;
    }
    expect(await AsyncStorage.getItem(WalletManager.PASSWORD_MOVE_KEY)).not.toBeNull();
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(false); // settled: the stored vault has the new wrap
    expect(await AsyncStorage.getItem(WalletManager.PASSWORD_MOVE_KEY)).toBeNull();
    expect((await fresh.unlockWithPassword(PW)).ok).toBe(true);
  });
});

describe.each(['ios', 'android'])('%s: a new wallet under the screen lock (MA-6)', (os) => {
  beforeEach(() => { Platform.OS = os; });

  it('its secret is read back through the screen lock once before the vault is written', async () => {
    const wm = manager();
    const token = await wm.storeWalletWithDeviceAuth(walletB(), 'Protect this wallet');
    expect(device.prompts).toEqual(['Protect this wallet']);
    expect(wm.sessionOpen(token)).toBe(true);
    expect(await wm.usesDeviceAuth()).toBe(true);
  });

  it('a prompt that cannot give the secret back writes no wallet, and the device then counts as one without a screen lock', async () => {
    breakReadBack();
    const wm = manager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    expect(await AsyncStorage.getItem(WalletManager.VAULT_KEY)).toBeNull();
    expect(await storedSecret(WalletManager.DEVICE_AUTH_SERVICE)).toBeNull();
    expect(await wm.deviceAuthAvailable()).toBe(false); // the next attempt uses a password
    device.error = null;
    device.broken = false;
    await wm.storeWallet(walletB(), PW);
    wm.closeSession();
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
  });

  // MA2-02: a prompt that fails this time (a timeout, the sensor unavailable, a busy Keystore; on iOS any error with the
  // item still there) keeps nothing and marks nothing: the same step asks again, with the screen lock.
  it('a prompt that fails for now writes no wallet and leaves the screen lock usable', async () => {
    device.error = os === 'android' ? 'BIO_ERROR' : 'failed';
    const wm = manager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(await AsyncStorage.getItem(WalletManager.VAULT_KEY)).toBeNull();
    expect(await storedSecret(WalletManager.DEVICE_AUTH_SERVICE)).toBeNull();
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY)).toBeNull();
    expect(await wm.deviceAuthAvailable()).toBe(true);
    for (const code of ['KEYSTORE_BUSY', 'NO_ACTIVITY']) {
      if (os !== 'android') break;
      device.error = code;
      await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    }
    device.error = null;
    expect(wm.sessionOpen(await wm.storeWalletWithDeviceAuth(walletB(), 'Protect'))).toBe(true);
    expect(await wm.usesDeviceAuth()).toBe(true);
  });

  it('a refused prompt writes no wallet and changes nothing else: the same button asks again', async () => {
    device.refuse = true;
    const wm = manager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_CANCELLED' });
    expect(await AsyncStorage.getItem(WalletManager.VAULT_KEY)).toBeNull();
    expect(await wm.deviceAuthAvailable()).toBe(true);
    device.refuse = false;
    expect(wm.sessionOpen(await wm.storeWalletWithDeviceAuth(walletB(), 'Protect'))).toBe(true);
  });
});

describe.each(['ios', 'android'])('%s: a move from a password never keeps the password behind the screen lock (MA-3, MA-4)', (os) => {
  beforeEach(() => { Platform.OS = os; });

  it('a long passphrase in any script moves, as on every platform', async () => {
    const long = 'Ледяной-ветер-над-тихой-рекой-несёт-запах-сосны-и-старого-дерева-2026'; // 70 characters, 130+ bytes
    const wm = manager();
    await wm.storeWallet(walletB(), long);
    expect(await wm.switchToDeviceAuth(long, 'Turn on')).toEqual({ ok: true });
    expect((await manager().unlockWithBiometrics()).ok).toBe(true);
  });

  it('a move that stopped after its flag ends at the next unlock: the password is never the current item', async () => {
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
    const staging = JSON.parse(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE));
    expect(staging).toMatchObject({ v: 1, s: PW, m: 1 }); // the move's mark: "s" is the typed password
    const fresh = manager();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
    expect(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeNull();
    expect(await storedSecret(WalletManager.DEVICE_AUTH_SERVICE)).toBe(staging.n);
    expect((await fresh.checkPassword(PW)).ok).toBe(false); // the vault no longer opens with the password
    fresh.closeSession();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
  });

  it('a move whose prompt cannot give the secret back keeps the password, and no later unlock asks again', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    breakReadBack();
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: false, unavailable: true });
    expect(await wm.deviceAuthAvailable()).toBe(false);
    expect(await wm.usesDeviceAuth()).toBe(false);
    expect((await manager().unlockWithPassword(PW)).ok).toBe(true);
  });

  it('a move whose prompt fails for now keeps the password and is offered again (MA2-02)', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    device.error = os === 'android' ? 'BIO_ERROR' : 'failed';
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: false, unavailable: true });
    expect(await wm.deviceAuthAvailable()).toBe(true);
    expect(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeNull();
    device.error = null;
    expect(await wm.switchToDeviceAuth(PW, 'Turn on')).toEqual({ ok: true });
  });

  it('a staging item a move left before its flag goes at the next password unlock', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const flag = AsyncStorage.setItem;
    AsyncStorage.setItem = jest.fn(async (k, v) => {
      if (k === WalletManager.DEVICE_AUTH_FLAG) throw new Error('killed');
      return flag(k, v);
    });
    try {
      await expect(wm.switchToDeviceAuth(PW, 'Turn on')).rejects.toThrow('killed');
    } finally {
      AsyncStorage.setItem = flag;
    }
    if (os === 'android') {
      // No flag and no adoption (iOS adopts the move from its item and ends it, the test above): a password wallet.
      expect(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toContain(PW);
      const fresh = manager();
      expect((await fresh.unlockWithPassword(PW)).ok).toBe(true);
      expect(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeNull();
    } else {
      const fresh = manager();
      expect(await fresh.usesDeviceAuth()).toBe(true);
      expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
      expect(await storedSecret(WalletManager.DEVICE_AUTH_NEXT_SERVICE)).toBeNull();
      expect(await storedSecret(WalletManager.DEVICE_AUTH_SERVICE)).not.toBe(PW);
    }
  });
});

describe('no way to the raw secret outside the manager (MA-7)', () => {
  it('the manager has no public secret getter', () => {
    expect(new WalletManager().deviceAuthSecret).toBeUndefined();
    const src = fs.readFileSync(path.join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    expect(src).not.toMatch(/async deviceAuthSecret\(/);
  });
});

describe('the native side and the screen (MA-1, MA-2, MA-3)', () => {
  const kt = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/com/qnetmobile/SecurityModule.kt'), 'utf8');
  const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  const en = require('../src/i18n/locales/en').default;
  const between = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a) + a.length));

  it('Android seals any length: a random AES key seals the secret, and only that key goes through RSA', () => {
    const seal = between(kt, 'fun devAuthSeal(', '@ReactMethod');
    expect(seal).toMatch(/SecretKeySpec\(key, "AES"\)/);
    expect(seal).toMatch(/RSA_OAEP\)\.apply \{ init\(Cipher\.ENCRYPT_MODE, pub, OAEP_SPEC\) \}\.doFinal\(key\)/);
    expect(seal).not.toMatch(/OAEP_SPEC\) \}\.doFinal\((data|input)\)/);
    expect(kt).toMatch(/devAuthKeyId\(pub\)/);
  });

  it('Android tells a removed screen lock without a prompt, and never stands a plain prompt in for the key', () => {
    const auth = between(kt, 'fun authenticate(', '// The system prompt for the screen-lock key');
    expect(auth).not.toMatch(/authenticateDevice\(activity, null/);
    // No key: 'not_set' only when an answered listing leaves it out (KeyGoneException -> KEY_MISSING); a Keystore
    // that did not answer is 'failed' (MA-R2-01).
    expect(auth).toMatch(/val pub = existingDevAuthPublicKey\(\)\s*val key = privateKey\(DEV_AUTH_ALIAS\)/);
    expect(auth).toMatch(/if \(code == "KEY_INVALIDATED" \|\| code == "KEY_MISSING"\) "not_set" else "failed"/);
    const usable = between(kt, 'fun devAuthUsable(', '/**');
    expect(usable).toMatch(/"KEY_MISSING", "KEY_INVALIDATED"/);
    // Opening never makes a key: a new one would not open the old secret anyway.
    expect(between(kt, 'private fun devAuthDecryptCipher(', '// The secret of')).not.toMatch(/devAuthPublicKey\(\)/);
  });

  it('the screen offers the way back while the wallet is open, and the lock screen says why nothing opens', () => {
    const fresh = between(ws, 'const confirmFresh = async', 'const deviceSecretGone');
    expect(fresh).toMatch(/deviceAuthSecretState\(\)[\s\S]*deviceSecretGone\(\)/);
    expect(fresh).toMatch(/if \(auth\.code === 'not_set'\) deviceSecretGone\(\);/);
    expect(ws).toMatch(/else if \(r\.gone\) setUnlockError\(t\('auth_secret_gone'\)\);/);
    expect(ws).toMatch(/walletManager\.reprotectWithPassword\(password, newPassword\)/);
    expect(ws).toMatch(/walletManager\.reprotectWithDeviceAuth\(token, t\('auth_device_unlock'\)\)/);
    // The return from the background within the grace time finds a secret that went meanwhile.
    expect(ws).toMatch(/walletManager\.deviceAuthSecretState\(\)\s*\.then\(\(s\) => \{ if \(s === 'gone'\) deviceSecretGone\(\); \}\)/);
  });

  it('the texts say the truth: after the screen lock goes, only the recovery phrase opens the wallet', () => {
    expect(en.auth_passcode_off_body).not.toMatch(/unlock the wallet again/i);
    for (const k of ['auth_passcode_off_body', 'auth_secret_gone', 'auth_secret_gone_open_body', 'create_protected', 'device_unlock_offer_body']) {
      expect([k, /recovery phrase/i.test(en[k])]).toEqual([k, true]);
    }
  });

  it('a password wallet moves at its next password unlock where the screen lock can hold it (O2, D1)', () => {
    expect(ws).toMatch(/if \(!\(await moveToDeviceUnlock\(pw\)\)\) offerBiometricReenroll\(\)/);
    expect(ws).not.toMatch(/DEVICE_UNLOCK_OFFERED_KEY|device_unlock_offer_no/);
    const move = between(ws, 'const moveToDeviceUnlock = async', 'const unlockWallet');
    expect(move).toMatch(/walletManager\.deviceAuthAvailable\(\)/);
    expect(move).toMatch(/switchDeviceUnlock\(pw\)/);
  });
});

// MOBAUTH-R1-02: only a failure after the prompt passed can say this device's screen lock cannot give a secret back, and
// even that is not held for ever: one Keystore hiccup must never turn the screen lock off on this device for good.
describe('android: a Keystore failure for a moment never counts the screen lock as broken for good (MOBAUTH-R1-02)', () => {
  beforeEach(() => { Platform.OS = 'android'; });
  const kt = fs.readFileSync(path.join(__dirname, '../android/app/src/main/java/com/qnetmobile/SecurityModule.kt'), 'utf8');
  const between = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a) + a.length));

  it('a failure before the prompt (PRE_PROMPT) is for now: no mark, and the next attempt uses the screen lock', async () => {
    device.error = 'PRE_PROMPT';
    const wm = manager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK_RETRY' });
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY)).toBeNull();
    expect(await wm.deviceAuthAvailable()).toBe(true);
    device.error = null;
    expect(wm.sessionOpen(await wm.storeWalletWithDeviceAuth(walletB(), 'Protect'))).toBe(true);
    expect(await wm.usesDeviceAuth()).toBe(true);
  });

  it('a failure after the prompt marks the device for seven days, and then the screen lock is offered again', async () => {
    breakReadBack();
    const wm = manager();
    await expect(wm.storeWalletWithDeviceAuth(walletB(), 'Protect')).rejects.toMatchObject({ code: 'DEVICE_LOCK' });
    const at = Number(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY));
    expect(at).toBeGreaterThan(0);
    expect(await wm.deviceAuthAvailable()).toBe(false);
    const now = Date.now;
    try {
      Date.now = () => at + WalletManager.DEVICE_AUTH_BROKEN_MS - 1;
      expect(await wm.deviceAuthAvailable()).toBe(false);
      Date.now = () => at + WalletManager.DEVICE_AUTH_BROKEN_MS;
      expect(await wm.deviceAuthAvailable()).toBe(true);
    } finally {
      Date.now = now;
    }
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY)).toBeNull();
    // An older build's mark ('1') has no time: it has lapsed.
    await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_BROKEN_KEY, '1');
    expect(await wm.deviceAuthAvailable()).toBe(true);
  });

  it('a screen-lock unlock that works clears the mark', async () => {
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB(), 'Protect');
    wm.closeSession();
    await AsyncStorage.setItem(WalletManager.DEVICE_AUTH_BROKEN_KEY, String(Date.now()));
    expect((await wm.unlockWithBiometrics()).ok).toBe(true);
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_BROKEN_KEY)).toBeNull();
    expect(await wm.deviceAuthAvailable()).toBe(true);
  });

  it('the native module answers PRE_PROMPT for any failure before the prompt, keeping only a gone key\'s own code', () => {
    const open = between(kt, 'fun devAuthOpen(', '@ReactMethod');
    expect(open).toMatch(/promise\.reject\(if \(code in DEV_AUTH_GONE_CODES\) code else "PRE_PROMPT", t\.message, t\)/);
    expect(open).not.toMatch(/promise\.reject\(errorCode\(t\), t\.message, t\)/);
    expect(kt).toMatch(/DEV_AUTH_GONE_CODES = setOf\("KEY_MISSING", "KEY_INVALIDATED", "KEY_CORRUPTED", "SEALED_DAMAGED"\)/);
    expect(WalletManager.DEVICE_AUTH_BROKEN_CODES.has('PRE_PROMPT')).toBe(false);
  });
});

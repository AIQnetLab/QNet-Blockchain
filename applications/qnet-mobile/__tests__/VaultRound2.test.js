// Round-2 vault findings: damage is never a wrong password and never "no wallet" (MVA-R2-03), a vault the
// Keystore could not seal is sealed at a later unlock (MVA-R2-04), a new password (or a re-enrolled biometric)
// brings a new data key (MVA-R2-06), and a new password needs at least 8 characters and nothing else.
const nodeCrypto = require('crypto');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const V = require('../src/crypto/Vault');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const { WalletManager, VaultCorruptError } = require('../src/components/WalletManager');

jest.setTimeout(180000);

const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
const stored = async (k) => JSON.parse(await AsyncStorage.getItem(k));

function fakeSealer(name = 'android-keystore') {
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

// Spies are restored one by one: jest.restoreAllMocks would also strip the AsyncStorage and Keychain mocks.
const spies = [];
const spy = (obj, name) => { const s = jest.spyOn(obj, name); spies.push(s); return s; };
// AsyncStorage's methods are mocks already (a spy would be the same function): swapped, then put back.
const swaps = [];
const swap = (obj, name, fn) => { swaps.push([obj, name, obj[name]]); obj[name] = fn; return fn; };
afterEach(() => {
  while (spies.length) spies.pop().mockRestore();
  while (swaps.length) { const [obj, name, orig] = swaps.pop(); obj[name] = orig; }
});

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
});

describe('MVA-R2-03: damage is not a wrong password, and unreadable storage is not "no wallet"', () => {
  it('the right password on a vault whose payload is damaged reports corruption, counted nowhere', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const vault = await stored('qnet_wallet');
    const flip = (h) => h.slice(0, -2) + (h.endsWith('00') ? '01' : '00');
    const damaged = JSON.stringify({ ...vault, encrypted: flip(vault.encrypted) });
    await AsyncStorage.multiSet([['qnet_wallet', damaged], ['qnet_wallet.bak', damaged]]);
    expect(await wm.vaultState()).toBe('ok');
    for (let i = 0; i < 5; i++) {
      await expect(wm.unlockWithPassword(PW)).rejects.toBeInstanceOf(VaultCorruptError);
    }
    expect(await wm.getPasswordLockStatus()).toMatchObject({ locked: false, attempts: 0 });
    // A wrong password on the same damaged vault is still a wrong password.
    expect(await wm.unlockWithPassword('wrong-password-9')).toMatchObject({ ok: false, attempts: 1 });
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe(damaged); // nothing deleted or rewritten
  });

  it('a malformed field or iteration count is damage, not a wrong password', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const vault = await stored('qnet_wallet');
    for (const bad of [
      { ...vault, pw: { ...vault.pw, iv: 'zz' + vault.pw.iv.slice(2) } },
      { ...vault, pw: { ...vault.pw, ct: vault.pw.ct.slice(0, -2) } },
      { ...vault, kdf: { ...vault.kdf, iterations: 1000 } },
      { ...vault, iv: vault.iv.slice(0, 10) },
      { version: 4, id: vault.id },
    ]) {
      const text = JSON.stringify(bad);
      await AsyncStorage.multiSet([['qnet_wallet', text], ['qnet_wallet.bak', text]]);
      await expect(wm.unlockWithPassword(PW)).rejects.toBeInstanceOf(VaultCorruptError);
    }
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
  });

  it('storage that cannot be read is "unreadable", never "none"', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const orig = AsyncStorage.multiGet;
    const failing = swap(AsyncStorage, 'multiGet', jest.fn(async () => { throw new Error('SQLITE_IOERR'); }));
    expect(await wm.vaultState({ retryMs: 1 })).toBe('unreadable');
    expect(failing.mock.calls.length).toBe(3);
    AsyncStorage.multiGet = orig;
    expect(await wm.vaultState()).toBe('ok');
  });

  it('a new wallet never overwrites a stored vault, nor one storage cannot rule out', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const before = await AsyncStorage.getItem('qnet_wallet');
    await expect(wm.storeWallet(walletB(), 'another-strong-pass-7')).rejects.toMatchObject({ code: 'WALLET_EXISTS' });
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe(before);
    expect(await wm.canStoreNewWallet()).toBe(false);

    await AsyncStorage.clear();
    const orig = AsyncStorage.multiGet;
    swap(AsyncStorage, 'multiGet', jest.fn(async () => { throw new Error('SQLITE_IOERR'); }));
    await expect(wm.storeWallet(walletB(), PW)).rejects.toMatchObject({ code: 'WALLET_EXISTS' });
    AsyncStorage.multiGet = orig;
    expect(await wm.canStoreNewWallet()).toBe(true);
  });

  it('the screen-lock secret of a stored vault is never replaced by an onboarding flow', async () => {
    const Keychain = require('react-native-keychain');
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    Keychain.isPasscodeAuthAvailable.mockResolvedValue(true);
    try {
      Keychain.setGenericPassword.mockClear();
      expect(await wm.enableDeviceAuthUnlock('a-new-generated-secret')).toBe(false);
      expect(Keychain.setGenericPassword).not.toHaveBeenCalledWith('qnet_wallet', expect.anything(), expect.anything());
    } finally {
      Keychain.isPasscodeAuthAvailable.mockResolvedValue(false);
    }
  });
});

describe('MVA-R2-04: a vault written without the device seal is sealed at a later unlock', () => {
  it('seals the same data key with the device key once one can be made, and keeps unlocking', async () => {
    const wm = manager();
    const sealer = spy(DeviceSecurity, 'deviceSealer').mockResolvedValue(null); // Keystore probe fails
    await wm.storeWallet(walletB(), PW);
    const plain = await stored('qnet_wallet');
    expect(plain.hw).toBeUndefined();
    // Still no key: the vault stays as it is.
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    expect((await stored('qnet_wallet')).hw).toBeUndefined();

    const hw = fakeSealer();
    sealer.mockResolvedValue(hw);
    spy(DeviceSecurity, 'deviceSealerFor').mockImplementation((name) => (name === hw.name ? hw : null));
    const r = await wm.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    const sealed = await stored('qnet_wallet');
    expect(sealed.hw).toBe('android-keystore');
    expect(sealed.encrypted).toBe(plain.encrypted); // same data key
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe(JSON.stringify(sealed));
    // The password alone (a copy of the storage on another device) no longer opens it.
    await expect(V.unwrapWithPassword(sealed, PW)).rejects.toBeInstanceOf(V.DeviceKeyError);
    expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
  });
});

describe('MVA-R2-06: a new password brings a new data key', () => {
  it('the old data key opens nothing written after the change; phrase, records and session carry over', async () => {
    const wm = manager();
    const session = await wm.storeWallet(walletB(), 'Kite-Marble-73');
    await wm.putSealedRecord('qnet_dapp_sites', { v: 1, sites: { 'https://dapp.example': { walletId: B.qnet } } }, 'dapp-sites', session);
    const before = await stored('qnet_wallet');
    const oldDek = await V.unwrapWithPassword(before, 'Kite-Marble-73');
    const oldKey = await V.aesKey(oldDek);

    await wm.changePassword('Kite-Marble-73', 'Otter-Canyon-58');

    const after = await stored('qnet_wallet');
    await expect(V.openPayload(after, oldKey)).rejects.toBeDefined();
    await expect(V.openMnemonic(after, oldKey)).rejects.toBeDefined();
    await expect(V.openRecord(oldKey, await stored('qnet_dapp_sites'), 'dapp-sites')).rejects.toBeDefined();
    // Everything is still there under the new key, and the open session moved with it.
    expect(await wm.revealMnemonic('Otter-Canyon-58')).toEqual({ ok: true, mnemonic: MNEMONIC });
    expect(await wm.getSealedRecord('qnet_dapp_sites', 'dapp-sites', session))
      .toEqual({ v: 1, sites: { 'https://dapp.example': { walletId: B.qnet } } });
    expect((await wm.loadWallet(session)).qnetAddress).toBe(B.qnet);
  });

  it('the biometric wrap of the old key goes with it, and the screen is told', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), 'Kite-Marble-73');
    const opened = await wm._openVault('Kite-Marble-73');
    await wm._writeVault(await V.withBioWrap(opened.vault, opened.dek, fakeSealer('android-biometric')));
    opened.dek.fill(0);
    expect(await wm.changePassword('Kite-Marble-73', 'Otter-Canyon-58')).toEqual({ biometricOff: true });
    expect((await stored('qnet_wallet')).bio).toBeUndefined();
  });

  it('after the biometric key was invalidated, the next password unlock rotates the data key', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const before = await stored('qnet_wallet');
    const oldKey = await V.aesKey(await V.unwrapWithPassword(before, PW));
    await AsyncStorage.setItem(WalletManager.DEK_ROTATE_KEY, '1');
    const r = await wm.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    const after = await stored('qnet_wallet');
    expect(after.id).toBe(before.id);
    await expect(V.openPayload(after, oldKey)).rejects.toBeDefined();
    expect(await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY)).toBeNull();
    expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect(await wm.revealMnemonic(PW)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });
});

describe('a new password: at least 8 characters and nothing else, on every path (the rule both wallets had)', () => {
  it('create/import (storeWallet) and change refuse a short password and take any 8 characters', async () => {
    await expect(manager().storeWallet(walletB(), 'short-1')).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT', params: { min: 8 } });
    expect(await AsyncStorage.getItem('qnet_wallet')).toBeNull();
    for (const pw of ['12345678', 'password', 'qwertyui', '11111111', 'Otter-Canyon-58']) {
      expect(await WalletManager.newPasswordProblem(pw)).toBeNull();
    }
    const wm = manager();
    await wm.storeWallet(walletB(), '12345678');
    await expect(wm.changePassword('12345678', '1234567')).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    // Refused before the password is checked: nothing counted, nothing changed.
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
    await wm.changePassword('12345678', 'qwertyui');
    wm.closeSession();
    expect((await wm.unlockWithPassword('qwertyui')).ok).toBe(true);
  });

  it('an existing wallet keeps opening with the password it was made with, whatever its length', async () => {
    const make = spy(WalletManager, 'newPasswordProblem').mockResolvedValue(null); // a wallet an older build sealed
    const wm = manager();
    await wm.storeWallet(walletB(), 'abc');
    make.mockRestore();
    wm.closeSession();
    expect((await wm.unlockWithPassword('abc')).ok).toBe(true);
    expect(await wm.revealMnemonic('abc')).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('the rule is one module the extension compiles too, with nothing in it but the length', () => {
    const rule = require('../src/crypto/PasswordStrength');
    expect(Object.keys(rule).sort()).toEqual(['PASSWORD_MIN_LENGTH', 'passwordTooShort']);
    expect(rule.PASSWORD_MIN_LENGTH).toBe(8);
    expect(WalletManager.MIN_PASSWORD_LENGTH).toBe(8);
    expect([rule.passwordTooShort('1234567'), rule.passwordTooShort('12345678'), rule.passwordTooShort(null)]).toEqual([true, false, true]);
    const fs = require('fs');
    const path = require('path');
    const bundle = path.join(__dirname, '../../qnet-wallet/tools/crypto-bundle');
    expect(fs.readFileSync(path.join(bundle, 'src/password.js'), 'utf8'))
      .toContain("export * from '../../../../qnet-mobile/src/crypto/PasswordStrength.js';");
    expect(fs.existsSync(path.join(__dirname, '../src/crypto/strength.js'))).toBe(false);
  });
});

describe('MOBNET-R2-03: the recipients this wallet signed transfers to', () => {
  it('are kept sealed under the data key, distinct, never the wallet itself, and read only while unlocked', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const TO = '02dca74ef2eae3be97feon499504db891ae0c60e36aaa';
    await wm._rememberRecipient(TO, B.qnet);
    await wm._rememberRecipient(TO.toUpperCase(), B.qnet);
    await wm._rememberRecipient(B.qnet, B.qnet);
    expect(await wm.sentRecipients()).toEqual([TO]);
    expect(await AsyncStorage.getItem('qnet_sent_recipients')).not.toContain(TO);
    wm.closeSession();
    expect(await wm.sentRecipients()).toEqual([]);
  });

  it('a transfer records its recipient before it is sent', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    const body = src.slice(src.indexOf('async _signAndSubmit('), src.indexOf('async _sendPending('));
    expect(body.indexOf('this._rememberRecipient(')).toBeGreaterThan(body.indexOf('await putSigned(entry);'));
    expect(body.indexOf('this._rememberRecipient(')).toBeLessThan(body.indexOf('await this._sendPending(entry)'));
  });
});

describe('MVA-R2-06: every record sealed under the data key moves to the new key', () => {
  it('the registry names every sealed record the code writes', () => {
    const { SITES_KEY, SITES_PURPOSE } = require('../src/browser/grants');
    const reg = WalletManager.SEALED_RECORDS.map((r) => `${r.key}|${r.purpose}`).sort();
    expect(reg).toEqual([[SITES_KEY, SITES_PURPOSE], [WalletManager.ANCHORS_KEY, 'qc-anchors'],
      [WalletManager.SENT_RECIPIENTS_KEY, 'sent-recipients'], [WalletManager.BALANCE_CACHE_KEY, 'balance-cache']]
      .map(([k, p]) => `${k}|${p}`).sort());
    // Every purpose passed to sealRecord in the app is one the rotation knows (the phrase is re-sealed apart).
    const wmSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    const purposes = new Set([...wmSrc.matchAll(/sealRecord\([^)]*?,\s*'([a-z-]+)'\)/g)].map((m) => m[1]));
    for (const p of purposes) expect([p, [...WalletManager.SEALED_RECORDS.map((r) => r.purpose), 'mnemonic'].includes(p)]).toEqual([p, true]);
  });
});

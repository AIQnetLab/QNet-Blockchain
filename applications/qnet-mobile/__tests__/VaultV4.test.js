// The wallet vault, version 4: a random data key encrypts the wallet, the password (and on Android a
// Keystore key) wraps the data key, biometrics wrap it separately and never hold the password. Older vaults
// stay readable and are rewritten as version 4 at their first unlock. Tagged for an on-device check by the
// owner before release: the Keystore and BiometricPrompt halves run only on a phone.
const nodeCrypto = require('crypto');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const V = require('../src/crypto/Vault');
const { WalletManager, VaultCorruptError } = require('../src/components/WalletManager');

jest.setTimeout(120000);

const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYLOAD = JSON.stringify({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });

// A stand-in for a Keystore key: AES-256-GCM under a key that exists only in this object.
function fakeSealer(name = 'android-keystore') {
  const key = nodeCrypto.randomBytes(32);
  const sealer = {
    name,
    alive: true,
    seal: async (bytes) => {
      const iv = nodeCrypto.randomBytes(12);
      const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
      return new Uint8Array(Buffer.concat([iv, c.update(Buffer.from(bytes)), c.final(), c.getAuthTag()]));
    },
    open: async (bytes) => {
      if (!sealer.alive) throw Object.assign(new Error('The device key is gone'), { code: 'KEY_MISSING' });
      const b = Buffer.from(bytes);
      const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
    },
  };
  return sealer;
}

// What older builds wrote.
function legacyGcm(version, plaintext, password) {
  const iterations = version === 3 ? 600000 : 100000;
  const salt = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(12);
  const key = nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return { version, salt: salt.toString('hex'), iv: iv.toString('hex'), encrypted: ct.toString('hex') };
}

// Version 1, as CryptoJS wrote it: PBKDF2-SHA256 (10,000) → AES-256-CBC, PKCS#7, hex salt and IV, base64
// ciphertext (CryptoJS's format for an explicit key: no "Salted__" header).
function legacyCbc(plaintext, password) {
  const salt = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(16);
  const key = nodeCrypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256');
  const c = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), encrypted };
}

const stored = async (k) => JSON.parse(await AsyncStorage.getItem(k));

// The payloads here carry no ML-DSA key, and deriving one needs the native module.
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
  jest.clearAllMocks();
});

describe('the vault format', () => {
  it('seals the wallet under a data key that only the password unwraps', async () => {
    const { vault, dekKey } = await V.createVault(PAYLOAD, 'pw-1234567');
    expect(vault).toMatchObject({ version: 4, kdf: { name: 'PBKDF2-SHA256', iterations: 600000 } });
    expect(JSON.stringify(vault)).not.toContain('abandon');
    expect(await V.openPayload(vault, dekKey)).toBe(PAYLOAD);

    const dek = await V.unwrapWithPassword(vault, 'pw-1234567');
    expect(dek).toHaveLength(32);
    expect(await V.openPayload(vault, await V.aesKey(dek))).toBe(PAYLOAD);
    await expect(V.unwrapWithPassword(vault, 'not-the-password')).rejects.toBeDefined();

    // The id is bound into the ciphertext: another vault's payload, or a changed id, does not open.
    const other = (await V.createVault('{"x":1}', 'pw-1234567')).vault;
    await expect(V.openPayload({ ...vault, iv: other.iv, encrypted: other.encrypted }, await V.aesKey(dek))).rejects.toBeDefined();
    await expect(V.openPayload({ ...vault, id: other.id }, await V.aesKey(dek))).rejects.toBeDefined();
  });

  it('a device-sealed wrap opens only with that device key; a lost key is not a wrong password', async () => {
    const hw = fakeSealer();
    const { vault } = await V.createVault(PAYLOAD, 'pw-1234567', { hw });
    expect(vault.hw).toBe('android-keystore');
    // The password alone (a copied storage file on another device) opens nothing.
    await expect(V.unwrapWithPassword(vault, 'pw-1234567')).rejects.toBeInstanceOf(V.DeviceKeyError);
    await expect(V.unwrapWithPassword(vault, 'pw-1234567', { hw: fakeSealer() })).rejects.toBeInstanceOf(V.DeviceKeyError);
    expect(await V.unwrapWithPassword(vault, 'pw-1234567', { hw })).toHaveLength(32);
    hw.alive = false;
    const lost = await V.unwrapWithPassword(vault, 'pw-1234567', { hw }).catch((e) => e);
    expect(lost).toBeInstanceOf(V.DeviceKeyError);
    expect(lost.uncounted).toBe(true);
  });

  it('a new password rewraps the data key: same ciphertext, same biometric wrap, old password refused', async () => {
    const hw = fakeSealer();
    const bio = fakeSealer('android-biometric');
    const { vault } = await V.createVault(PAYLOAD, 'old-password-1', { hw });
    const dek = await V.unwrapWithPassword(vault, 'old-password-1', { hw });
    const withBio = await V.withBioWrap(vault, dek, bio);
    expect(JSON.stringify(withBio.bio)).not.toContain('old-password-1');

    const changed = await V.rewrapPassword(withBio, dek, 'new-password-2', { hw });
    expect(changed.encrypted).toBe(vault.encrypted);
    expect(changed.bio).toEqual(withBio.bio);
    await expect(V.unwrapWithPassword(changed, 'old-password-1', { hw })).rejects.toBeDefined();
    const again = await V.unwrapWithPassword(changed, 'new-password-2', { hw });
    expect(Buffer.from(again).equals(Buffer.from(dek))).toBe(true);
    const viaBio = await V.unwrapWithBio(changed, bio);
    expect(await V.openPayload(changed, await V.aesKey(viaBio))).toBe(PAYLOAD);

    // A biometric key invalidated by a new enrolment is reported, not treated as a wrong password.
    const dead = { ...bio, open: async () => { throw Object.assign(new Error('invalidated'), { code: 'KEY_INVALIDATED' }); } };
    const err = await V.unwrapWithBio(changed, dead).catch((e) => e);
    expect(err).toBeInstanceOf(V.DeviceKeyError);
    expect(err.code).toBe('KEY_INVALIDATED');
  });
});

describe('older vaults stay readable and become version 4 at their first unlock', () => {
  it('version 3 moves under a data key; what an older build kept for activation goes with the launch cleanup', async () => {
    await AsyncStorage.multiSet([
      ['qnet_wallet', JSON.stringify(legacyGcm(3, PAYLOAD, 'old-password-1'))],
      ['qnet_activation_codes', JSON.stringify({ light: { ...legacyGcm(3, 'code', 'old-password-1'), nodeType: 'light' } })],
      ['qnet_activation_meta_light', JSON.stringify({ burnTxHash: 'tx', burnAmount: 1500, walletAddress: B.sol })],
    ]);
    const wm = manager();
    const r = await wm.unlockWithPassword('old-password-1');
    expect(r).toMatchObject({ ok: true, migratedFrom: 3 });

    const vault = await stored('qnet_wallet');
    expect(V.isVaultV4(vault)).toBe(true);
    expect(vault).not.toHaveProperty('salt');
    expect(vault.seed).toMatchObject({ version: 4, vault: vault.id }); // the phrase sealed apart from the payload
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe(await AsyncStorage.getItem('qnet_wallet'));
    expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect(await wm.revealMnemonic('old-password-1')).toEqual({ ok: true, mnemonic: MNEMONIC });

    await wm.cleanupActivationStorage();
    expect(await AsyncStorage.getItem('qnet_activation_codes')).toBeNull();
    expect(await AsyncStorage.getItem('qnet_activation_meta_light')).toBeNull();
    expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
  });

  it('the cleanup keeps a node record\'s node and drops its code and burn; a genesis node is known by its id', async () => {
    const wm = manager();
    await AsyncStorage.multiSet([
      [WalletManager.NODE_RECORD_KEY, JSON.stringify({ nodeType: 'super', pseudonym: 'genesis_node_003', code: 'c', burnTxHash: 'tx' })],
      ['qnet_burn_scan', '{}'], ['qnet_update_cache', '{}'], ['qnet_testnet', 'true'], ['node_pseudonym_x', 'y'],
      ['qnet_onchain_reg_pending', '{}'], [`qnet_onchain_reg_pending_${B.qnet}`, '{}'], ['qnet_language', 'ru'],
    ]);
    await wm.cleanupActivationStorage();
    expect(await stored(WalletManager.NODE_RECORD_KEY))
      .toEqual({ nodeType: 'super', pseudonym: 'genesis_node_003', isGenesis: true, bootstrapId: '003' });
    for (const k of ['qnet_burn_scan', 'qnet_update_cache', 'qnet_testnet', 'node_pseudonym_x', 'qnet_onchain_reg_pending',
      `qnet_onchain_reg_pending_${B.qnet}`]) {
      expect([k, await AsyncStorage.getItem(k)]).toEqual([k, null]);
    }
    expect(await AsyncStorage.getItem('qnet_language')).toBe('ru');
    await wm.cleanupActivationStorage(); // idempotent
    expect((await stored(WalletManager.NODE_RECORD_KEY)).bootstrapId).toBe('003');
  });

  it('versions 1 (AES-CBC) and 2 (PBKDF2 100k) open with their password and are rewritten', async () => {
    for (const [version, legacy] of [[1, legacyCbc(PAYLOAD, 'old-password-1')], [2, legacyGcm(2, PAYLOAD, 'old-password-1')]]) {
      await AsyncStorage.setItem('qnet_wallet', JSON.stringify(legacy));
      await AsyncStorage.removeItem('qnet_wallet.bak');
      const wm = manager();
      expect((await wm.unlockWithPassword('wrong-password-9')).ok).toBe(false);
      expect(await AsyncStorage.getItem('qnet_wallet')).toBe(JSON.stringify(legacy)); // a wrong password rewrites nothing
      const r = await wm.unlockWithPassword('old-password-1');
      expect(r).toMatchObject({ ok: true, migratedFrom: version });
      expect(V.isVaultV4(await stored('qnet_wallet'))).toBe(true);
      expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    }
  });
});

describe('the recovery phrase is sealed apart from the wallet', () => {
  it('a new vault keeps no phrase in its payload: opening the wallet never decrypts it', async () => {
    const wm = manager();
    const session = await wm.storeWallet({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC }, 'Lantern-Quartz-Oriole-4');
    const vault = await stored('qnet_wallet');
    expect(vault.seed).toMatchObject({ version: 4, vault: vault.id });
    const dekKey = await V.aesKey(await V.unwrapWithPassword(vault, 'Lantern-Quartz-Oriole-4'));
    expect(JSON.parse(await V.openPayload(vault, dekKey))).not.toHaveProperty('mnemonic');
    expect(await V.openMnemonic(vault, dekKey)).toBe(MNEMONIC);
    expect(await wm.loadWallet(session)).not.toHaveProperty('mnemonic');
    expect(await wm.revealMnemonic('Lantern-Quartz-Oriole-4')).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it("an older version 4 vault's phrase moves out of its payload at the next open, under the same data key", async () => {
    const { vault } = await V.createVault(PAYLOAD, 'Lantern-Quartz-Oriole-4'); // PAYLOAD still carries the phrase
    await AsyncStorage.multiSet([['qnet_wallet', JSON.stringify(vault)], ['qnet_wallet.bak', JSON.stringify(vault)]]);
    const wm = manager();
    const r = await wm.unlockWithPassword('Lantern-Quartz-Oriole-4');
    expect(r.ok).toBe(true);
    expect(await wm.loadWallet(r.token)).not.toHaveProperty('mnemonic');

    const after = await stored('qnet_wallet');
    expect(after.id).toBe(vault.id);
    expect(after.pw).toEqual(vault.pw); // same data key, same wrap
    const dekKey = await V.aesKey(await V.unwrapWithPassword(after, 'Lantern-Quartz-Oriole-4'));
    expect(JSON.parse(await V.openPayload(after, dekKey))).not.toHaveProperty('mnemonic');
    expect(await V.openMnemonic(after, dekKey)).toBe(MNEMONIC);
    expect(await wm.revealMnemonic('Lantern-Quartz-Oriole-4')).toEqual({ ok: true, mnemonic: MNEMONIC });
  });
});

describe('one password check, one lockout', () => {
  it('unlock, reveal, change and delete share the lockout; a session token is never a password', async () => {
    const wm = manager();
    const session = await wm.storeWallet({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC }, 'Lantern-Quartz-Oriole-4');
    expect(await wm.checkPassword(session)).toMatchObject({ ok: false });
    await wm._limiter.seed(3);
    expect(await wm.checkPassword('wrong-password-9')).toMatchObject({ ok: false, locked: true });
    // Locked: even the right password is not tried until the wait is over.
    expect(await wm.unlockWithPassword('Lantern-Quartz-Oriole-4')).toMatchObject({ ok: false, locked: true });
    expect(await wm.revealMnemonic('Lantern-Quartz-Oriole-4')).toMatchObject({ ok: false, locked: true });
    await expect(wm.changePassword('Lantern-Quartz-Oriole-4', 'Otter-Canyon-58')).rejects.toMatchObject({ lockout: { locked: true } });
    expect((await wm.getPasswordLockStatus()).locked).toBe(true);
  });

  it('a vault whose device key is gone reports that and counts no failure', async () => {
    const hw = fakeSealer();
    const { vault } = await V.createVault(PAYLOAD, 'Lantern-Quartz-Oriole-4', { hw });
    await AsyncStorage.setItem('qnet_wallet', JSON.stringify(vault));
    const wm = manager();
    wm._sealerFor = () => hw;
    expect((await wm.unlockWithPassword('Lantern-Quartz-Oriole-4')).ok).toBe(true);
    hw.alive = false;
    await expect(wm.unlockWithPassword('Lantern-Quartz-Oriole-4')).rejects.toBeInstanceOf(V.DeviceKeyError);
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
  });
});

describe('the vault is never deleted by the app', () => {
  it('a damaged copy is read from its twin and repaired; two damaged copies are kept and reported', async () => {
    const wm = manager();
    await wm.storeWallet({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC }, 'Lantern-Quartz-Oriole-4');
    const good = await AsyncStorage.getItem('qnet_wallet');
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe(good);

    await AsyncStorage.setItem('qnet_wallet', '{"version":4,"id":"trun');
    expect(await wm.vaultState()).toBe('ok');
    expect((await wm.unlockWithPassword('Lantern-Quartz-Oriole-4')).ok).toBe(true);
    // The twin is written back over both copies, at a new generation (MOBAUTH-R1-01).
    const { gen: repairedGen, ...repaired } = JSON.parse(await AsyncStorage.getItem('qnet_wallet'));
    const { gen: goodGen, ...original } = JSON.parse(good);
    expect(repaired).toEqual(original);
    expect(repairedGen).toBeGreaterThan(goodGen);
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe(await AsyncStorage.getItem('qnet_wallet'));

    await AsyncStorage.multiSet([['qnet_wallet', 'garbage'], ['qnet_wallet.bak', '{also garbage']]);
    expect(await wm.walletExists()).toBe(true);
    expect(await wm.vaultState()).toBe('corrupt');
    await expect(wm.unlockWithPassword('Lantern-Quartz-Oriole-4')).rejects.toBeInstanceOf(VaultCorruptError);
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe('garbage');
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe('{also garbage');
  });
});

describe('what the screen holds and what Delete leaves', () => {
  it('the screen gets addresses and public keys, never a private key or the phrase', () => {
    const w = {
      address: B.sol, qnetAddress: B.qnet, secretKey: [1, 2], mnemonic: MNEMONIC, password: 'x',
      qnetKeypair: { publicKey: [3], privateKey: [4], path: 'p' }, evmKeypair: { publicKey: 'aa', privateKey: 'bb', path: 'e' },
    };
    const shown = WalletManager.publicWallet(w);
    expect(shown).toEqual({ address: B.sol, qnetAddress: B.qnet, qnetKeypair: { publicKey: [3], path: 'p' },
      evmKeypair: { publicKey: 'aa', path: 'e' } });
  });

  it('Delete wallet leaves only the language, and resets every Keychain item', async () => {
    const wm = manager();
    const session = await wm.storeWallet({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC }, 'Lantern-Quartz-Oriole-4');
    await AsyncStorage.multiSet([
      ['qnet_language', 'ru'], ['qnet_testnet', 'true'], ['qnet_autolock_time', '5'], ['qnet_fcm_token', 't'],
      ['qnet_device_id', 'd'], [`qnet_tx_history_${B.qnet}`, '[]'], ['qnet_light_node_info', '{}'], ['qnet_error_logs', '[]'],
      [WalletManager.DEVICE_AUTH_FLAG, '1'], [`qnet_devauth_${WalletManager.DEVICE_AUTH_SERVICE}`, 'sealed'],
    ]);
    Keychain.getAllGenericPasswordServices.mockResolvedValueOnce(['qnet_ping_sk_light_mobile_1', 'com.qnet.wallet.biometric']);

    await wm.eraseAllData();

    expect((await AsyncStorage.getAllKeys()).sort()).toEqual(['qnet_language']);
    const reset = Keychain.resetGenericPassword.mock.calls.map(([o]) => o.service);
    expect(reset).toEqual(expect.arrayContaining(['qnet_ping_sk_light_mobile_1', 'com.qnet.wallet.biometric', 'qnet_pw_limiter']));
    await expect(wm.loadWallet(session)).rejects.toBeDefined();
  });

  it('a reinstall wipes the Keychain items the previous install left; an update keeps them', async () => {
    const fresh = manager();
    await fresh.prepareInstall();
    expect(Keychain.resetGenericPassword).toHaveBeenCalled();
    expect(await AsyncStorage.getItem('qnet_install_marker')).toBe('1');

    jest.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('qnet_wallet', '{"version":4}');
    await manager().prepareInstall();
    expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('qnet_install_marker')).toBe('1');
  });
});

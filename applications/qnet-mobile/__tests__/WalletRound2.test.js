/**
 * Final audit, mobile fixer round 2, the wallet (MA2-01 … MA2-04, MN2-03, SD-R2-03, SD-R2-04, SD-R2-11, SD-R2-12): a
 * password wallet unlocked by its biometric moves to the screen lock too, and a move that stopped leaves no password
 * behind; a prompt that fails for now never turns the screen lock off for good, and an invalidated screen-lock key is
 * made again; the screen-lock prompt shows the whole recipient; every unlock answer is said; a capped claim below 1 QNC
 * is answered; no reward wording reaches the screen through an error; the rooted-device text says what is true; the
 * import screen has no lone "Step 2"; no Russian text reads as earning.
 */
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NativeModules, Platform } = require('react-native');

// Android's screen-lock key, as in DeviceSecretGone.test.js: sealing asks nothing, opening is one system prompt.
const device = { available: true, refuse: false, error: null, prompts: [] };
const KEY = nodeCrypto.randomBytes(32);
NativeModules.QNetSecurity = {
  devAuthAvailable: jest.fn(async () => device.available),
  devAuthSeal: jest.fn(async (b64) => {
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', KEY, iv);
    return Buffer.concat([iv, c.update(Buffer.from(b64, 'base64')), c.final(), c.getAuthTag()]).toString('base64');
  }),
  devAuthOpen: jest.fn(async (blob, title) => {
    device.prompts.push(title);
    if (device.refuse) throw Object.assign(new Error('cancelled'), { code: 'BIO_CANCELLED' });
    if (device.error) throw Object.assign(new Error('prompt failed'), { code: device.error });
    const b = Buffer.from(blob, 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('base64');
  }),
  devAuthUsable: jest.fn(async () => 'ok'),
};

const AsyncStorage = require('@react-native-async-storage/async-storage');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const DeviceAuthStore = require('../src/services/DeviceAuthStore');
const { WalletManager } = require('../src/components/WalletManager');
const Vault = require('../src/crypto/Vault');
const { nodeLinkActions } = require('../src/services/NodeLinkActions');
const { buildPlaintext, plaintextProblem } = require('../src/services/QNetLink');
const translations = require('../src/i18n/translations').default;

jest.setTimeout(240000);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCREEN = () => read('src/screens/WalletScreen.js');
const between = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a) + a.length));
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
const NEXT = WalletManager.DEVICE_AUTH_NEXT_SERVICE;
const CURRENT = WalletManager.DEVICE_AUTH_SERVICE;
const blob = (service) => AsyncStorage.getItem(`qnet_devauth_${service}`);

// The vault's biometric wrap under a stand-in of the Keystore's per-use biometric key.
function fakeBio() {
  const key = nodeCrypto.randomBytes(32);
  return {
    name: 'android-biometric',
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

const restores = [];
const swap = (obj, name, value) => { restores.push([obj, name, obj[name]]); obj[name] = value; return value; };
const spy = (obj, name) => { const s = jest.spyOn(obj, name); restores.push([null, null, s]); return s; };
afterEach(() => {
  while (restores.length) {
    const [obj, name, orig] = restores.pop();
    if (obj) obj[name] = orig; else orig.mockRestore();
  }
});
beforeEach(async () => {
  await AsyncStorage.clear();
  Object.assign(device, { available: true, refuse: false, error: null, prompts: [] });
});

// An Android password wallet that unlocks with its biometric wrap.
async function bioWallet() {
  swap(Platform, 'OS', 'android');
  const wm = manager();
  await wm.storeWallet(walletB(), PW);
  const opened = await wm._openVault(PW);
  const bio = fakeBio();
  await wm._writeVault(await Vault.withBioWrap(opened.vault, opened.dek, bio));
  opened.dek.fill(0);
  const sealer = spy(DeviceSecurity, 'biometricSealer').mockReturnValue(bio);
  wm.closeSession();
  return { wm, bio, sealer };
}

describe('MA2-01: a password wallet unlocked by its biometric moves to the screen lock too', () => {
  it('a biometric unlock drops a staging item a move left before its flag (it holds the typed password)', async () => {
    const { wm } = await bioWallet();
    await DeviceAuthStore.write(NEXT, JSON.stringify({ v: 1, s: PW, n: 'x'.repeat(40), m: 1 }));
    expect(await blob(NEXT)).toBeTruthy();
    const r = await wm.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    expect(await blob(NEXT)).toBeNull();
  });

  it('the move takes a fresh biometric and one screen-lock prompt, no password; afterwards the screen lock alone opens it', async () => {
    const { wm, sealer } = await bioWallet();
    const r = await wm.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    sealer.mockClear();
    expect(await wm.switchToDeviceAuthWithBiometric('Turn on', 'Unlock with the screen lock')).toEqual({ ok: true });
    expect(sealer).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unlock with the screen lock', confirm: true }));
    expect(device.prompts).toEqual(['Turn on']);
    expect(await wm.usesDeviceAuth()).toBe(true);
    expect(wm.sessionOpen(r.token)).toBe(true); // the open session moved to the new data key
    expect((await wm.loadWallet(r.token)).qnetAddress).toBe(B.qnet);
    expect(await blob(NEXT)).toBeNull();
    const fresh = manager();
    expect((await fresh.checkPassword(PW)).ok).toBe(false); // the password opens nothing stored now
    const u = await fresh.unlockWithBiometrics();
    expect(u.ok).toBe(true);
    expect(await fresh.revealMnemonic(WalletManager.deviceAuthCredential('Show'))).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('a refused biometric or screen-lock prompt moves nothing, and the password still opens it', async () => {
    const { wm, bio, sealer } = await bioWallet();
    sealer.mockReturnValue({ ...bio, open: async () => { throw Object.assign(new Error('c'), { code: 'BIO_CANCELLED' }); } });
    expect(await wm.switchToDeviceAuthWithBiometric('Turn on', 'Use')).toEqual({ ok: false, cancelled: true });
    expect(device.prompts).toEqual([]); // no screen-lock prompt without the biometric first
    sealer.mockReturnValue(bio);
    device.refuse = true;
    expect(await wm.switchToDeviceAuthWithBiometric('Turn on', 'Use')).toEqual({ ok: false, cancelled: true });
    expect(await wm.usesDeviceAuth()).toBe(false);
    expect(await blob(NEXT)).toBeNull();
    expect((await manager().unlockWithPassword(PW)).ok).toBe(true);
  });

  it('crash-safe: a vault write that fails leaves no flag (they go in one write), and the password opens it', async () => {
    const { wm } = await bioWallet();
    const multiSet = AsyncStorage.multiSet;
    swap(AsyncStorage, 'multiSet', jest.fn(async (pairs) => {
      if (pairs.some(([k]) => k === WalletManager.VAULT_KEY)) throw new Error('killed');
      return multiSet(pairs);
    }));
    await expect(wm.switchToDeviceAuthWithBiometric('Turn on', 'Use')).rejects.toThrow('killed');
    AsyncStorage.multiSet = multiSet;
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBeNull();
    const fresh = manager();
    expect(await fresh.usesDeviceAuth()).toBe(false);
    expect((await fresh.unlockWithPassword(PW)).ok).toBe(true);
    expect(await blob(NEXT)).toBeNull(); // the stray staging item went with that unlock
  });

  it('crash-safe: stopped after the vault write, the staging item opens it and becomes the current item', async () => {
    const { wm } = await bioWallet();
    const setItem = AsyncStorage.setItem;
    swap(AsyncStorage, 'setItem', jest.fn(async (k, v) => {
      if (k === `qnet_devauth_${CURRENT}`) throw new Error('killed');
      return setItem(k, v);
    }));
    await expect(wm.switchToDeviceAuthWithBiometric('Turn on', 'Use')).rejects.toThrow('killed');
    AsyncStorage.setItem = setItem;
    expect(await AsyncStorage.getItem(WalletManager.DEVICE_AUTH_FLAG)).toBe('1');
    const fresh = manager();
    const u = await fresh.unlockWithBiometrics();
    expect(u.ok).toBe(true);
    expect(await blob(NEXT)).toBeNull();
    expect(await blob(CURRENT)).toBeTruthy();
    fresh.closeSession();
    expect((await fresh.unlockWithBiometrics()).ok).toBe(true);
  });

  it('only on Android, only for a password wallet with a biometric wrap', async () => {
    swap(Platform, 'OS', 'ios');
    expect(await manager().switchToDeviceAuthWithBiometric('Turn on', 'Use')).toEqual({ ok: false, unavailable: true });
    swap(Platform, 'OS', 'android');
    const wm = manager();
    await wm.storeWallet(walletB(), PW); // no biometric wrap
    expect(await wm.switchToDeviceAuthWithBiometric('Turn on', 'Use')).toEqual({ ok: false, unavailable: true });
  });

  it('the screen offers the move after a biometric unlock of a password wallet', () => {
    const src = SCREEN();
    const bioUnlock = between(src, 'const handleBiometricUnlock = async', 'const offerBiometricReenroll');
    expect(bioUnlock).toMatch(/if \(!walletDeviceAuth\) moveToDeviceUnlock\(null\)/);
    const move = between(src, 'const switchDeviceUnlock = async', 'const moveToDeviceUnlock');
    expect(move).toMatch(/walletManager\.switchToDeviceAuthWithBiometric\(t\('auth_device_unlock'\), t\('set_device_unlock'\)\)/);
  });
});

describe('MA2-02: an invalidated screen-lock key is made again, never sealed to', () => {
  const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');

  it('the key is replaced when the Keystore says it was permanently invalidated, and only then', () => {
    const pub = between(kt, 'private fun devAuthPublicKey(', 'private fun existingDevAuthPublicKey(');
    // Made only when an answered listing shows there is none (KeyGoneException), replaced only when invalidated; a key
    // the Keystore failed to read is neither deleted nor replaced (MA-R2-01).
    expect(pub).toMatch(/val now = try \{ existingDevAuthPublicKey\(\) \} catch \(_: KeyGoneException\) \{ null \}/);
    expect(pub).toMatch(/if \(now != null && !devAuthKeyInvalidated\(\)\) return now\s*if \(now != null\) deleteKey\(DEV_AUTH_ALIAS\)\s*generateDevAuthKey\(\)/);
    const check = between(kt, 'private fun devAuthKeyInvalidated(', 'private fun existingDevAuthPublicKey(');
    expect(check).toMatch(/Cipher\.getInstance\(RSA_OAEP\)\.init\(Cipher\.DECRYPT_MODE, key, OAEP_SPEC\)/);
    expect(check).toMatch(/any \{ it is KeyPermanentlyInvalidatedException \}/);
    // Sealing and the availability probe both go through it.
    expect(between(kt, 'fun devAuthSeal(', '@ReactMethod')).toMatch(/val pub = devAuthPublicKey\(\)/);
    expect(between(kt, 'fun devAuthAvailable(', '@ReactMethod')).toMatch(/devAuthPublicKey\(\)/);
  });

  it('a failure for now is told apart from a device whose prompt cannot give the secret back', () => {
    const verdict = (back) => WalletManager._readBackVerdict(back, (s) => s === 'S');
    swap(Platform, 'OS', 'android');
    expect(verdict({ ok: true, secret: 'S' })).toBe('ok');
    expect(verdict({ ok: true, secret: 'other' })).toBe('broken');
    expect(verdict({ ok: false, reason: 'cancelled' })).toBe('cancelled');
    for (const code of ['BIO_ERROR', 'KEYSTORE_BUSY', 'NO_ACTIVITY', 'STORAGE', '']) {
      expect([code, verdict({ ok: false, reason: 'failed', code })]).toEqual([code, 'retry']);
    }
    for (const code of ['DEVICE_LOCKED', 'KEYSTORE', 'KEY_MISMATCH']) {
      expect([code, verdict({ ok: false, reason: 'failed', code })]).toEqual([code, 'broken']);
    }
    expect(verdict({ ok: false, reason: 'gone' })).toBe('broken');
    swap(Platform, 'OS', 'ios');
    expect(verdict({ ok: false, reason: 'failed', code: '-25293' })).toBe('retry');
  });

  it('the new wallet screens keep the screen lock after a failure for now, and say so', () => {
    const src = SCREEN();
    expect((src.match(/DEVICE_LOCK_RETRY/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/e\.code === 'DEVICE_LOCK_RETRY'[\s\S]{0,200}device_unlock_unavailable/);
  });
});

describe('MA2-03: the screen-lock prompt shows the whole recipient and the apps that can read the screen', () => {
  it('DeviceSecurity puts them in the Android prompt\'s own lines; iOS takes them after the reason', async () => {
    const run = async (os, native) => {
      let DS;
      jest.isolateModules(() => {
        jest.doMock('react-native', () => ({ Platform: { OS: os }, NativeModules: { QNetSecurity: native } }));
        DS = require('../src/services/DeviceSecurity');
        jest.dontMock('react-native');
      });
      return DS.deviceAuthenticate('Send 5 QNC', { subtitle: 'Apps: X', description: 'To: 0f3a 91bc' });
    };
    const android = { authenticate: jest.fn(async () => ({ ok: true, code: 'ok' })), authenticateWith: jest.fn(async () => ({ ok: true, code: 'ok' })) };
    expect(await run('android', android)).toEqual({ ok: true, code: 'ok' });
    expect(android.authenticateWith).toHaveBeenCalledWith('Send 5 QNC', 'Apps: X', 'To: 0f3a 91bc');
    expect(android.authenticate).not.toHaveBeenCalled();
    const ios = { authenticate: jest.fn(async () => ({ ok: true, code: 'ok' })) };
    await run('ios', ios);
    expect(ios.authenticate).toHaveBeenCalledWith('Send 5 QNC\nApps: X\nTo: 0f3a 91bc');
  });

  it('the native prompt takes the subtitle and the description; the title is the reason alone', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kt).toMatch(/fun authenticate\(reason: String, promise: Promise\) = authenticateWith\(reason, "", "", promise\)/);
    expect(kt).toMatch(/fun authenticateWith\(reason: String, subtitle: String, description: String, promise: Promise\)/);
    expect(between(kt, 'fun authenticateWith(', '// The system prompt for the screen-lock key'))
      .toMatch(/authenticateDevice\(activity, BiometricPrompt\.CryptoObject\(cipher\), reason, subtitle, description, true, refused\)/);
  });

  it('the fresh check and the lock screen of a screen-lock wallet name the apps that can read the screen', () => {
    const src = SCREEN();
    const fresh = between(src, 'const confirmFresh = async', 'const reviewSend');
    expect(fresh).toMatch(/deviceAuthenticate\(reason, \{ subtitle: readersNote, description: detail \}\)/);
    expect(fresh).not.toMatch(/deviceAuthenticate\(detail \?/);
    expect(src).toMatch(/t\(deviceAuth \? 'readers_confirm_note' : 'readers_lock_note', \{ apps: lockReaders\.join\(', '\) \}\)/);
    expect(src).toMatch(/if \(wallet \|\| !hasWallet \|\| !appActive\) return undefined;\s*let live = true;\s*screenReaderApps\(\)/);
  });
});

describe('MA2-04: every unlock answer is said, and a flag that cannot be read never shows a password field', () => {
  it('the biometric unlock says an attempt it could not record, and a refusal that is not a cancel', () => {
    const bioUnlock = between(SCREEN(), 'const handleBiometricUnlock = async', 'const offerBiometricReenroll');
    expect(bioUnlock).toMatch(/else if \(r\.unrecorded\) setUnlockError\(t\('unlock_unrecorded'\)\);/);
    expect(bioUnlock).toMatch(/else if \(!r\.cancelled\) setUnlockError\(t\('unlock_failed'\)\);/);
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, typeof table.unlock_unrecorded === 'string' && table.unlock_unrecorded.length > 20]).toEqual([lang, true]);
    }
  });

  it('"Lock the wallet" says the truth when a screen lock was set again', () => {
    const gone = between(SCREEN(), 'const deviceSecretGone = async', 'const reprotectWithScreenLock');
    expect(gone).toMatch(/if \(lockAgain\) showAlert\(t\('auth_secret_gone_title'\), t\('auth_secret_gone_locked_body'\)\);\s*else showAlert\(t\('auth_passcode_off_title'\), t\('auth_passcode_off_body'\)\);/);
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, typeof table.auth_secret_gone_locked_body === 'string', table.auth_secret_gone_locked_body !== table.auth_passcode_off_body])
        .toEqual([lang, true, true]);
    }
  });

  it('the lock flag is read with retries; storage that cannot be read is unknown, never "no password needed"', async () => {
    swap(Platform, 'OS', 'android');
    const wm = manager();
    await wm.storeWalletWithDeviceAuth(walletB());
    const getItem = AsyncStorage.getItem;
    let failures = 1;
    swap(AsyncStorage, 'getItem', jest.fn(async (k) => {
      if (k === WalletManager.DEVICE_AUTH_FLAG && failures > 0) { failures -= 1; throw new Error('SQLITE_BUSY'); }
      return getItem(k);
    }));
    expect(await wm.deviceAuthState({ retryMs: 1 })).toBe('yes'); // one failed read, then the flag
    failures = 99;
    expect(await wm.deviceAuthState({ retryMs: 1 })).toBe('unknown');
    expect(await wm.usesDeviceAuth()).toBe(false);
    const check = between(SCREEN(), 'const checkWalletExists = async', 'const validatePassword');
    expect(check).toMatch(/const lock = state === 'none' \? 'no' : await walletManager\.deviceAuthState\(\);/);
    expect(check).toMatch(/if \(lock === 'unknown' && state === 'ok'\) state = 'unreadable';/);
    expect(check).toMatch(/setWalletDeviceAuth\(lock === 'yes'\);/);
  });
});

describe('MN2-03: a claim the node\'s quote capped may be below 1 QNC (owner decision 6)', () => {
  const W = require('../../../docs/protocols/light-node.vectors.json').wallets[0];
  const view = { intent: 'claim', request: { walletHash: W.walletHash } };
  const ok = (over) => ({ status: 'ok', qnet: W.address, nodeId: W.nodeId, txHash: 'ab'.repeat(32), ...over });

  it('a capped part below 1 QNC is answered as sent; an uncapped one below 1 QNC, or nothing, is not', () => {
    const text = buildPlaintext(view, ok({ amountNano: '400000000', stoppedAtEpoch: '160' }));
    expect(JSON.parse(text)).toMatchObject({ amountNano: '400000000', stoppedAtEpoch: '160' });
    expect(plaintextProblem(text, view)).toBe(null);
    expect(() => buildPlaintext(view, ok({ amountNano: '400000000', stoppedAtEpoch: null }))).toThrow(/amountNano/);
    expect(() => buildPlaintext(view, ok({ amountNano: '0', stoppedAtEpoch: '160' }))).toThrow(/amountNano/);
    expect(JSON.parse(buildPlaintext(view, ok({ amountNano: '1000000000', stoppedAtEpoch: null })))).toMatchObject({ amountNano: '1000000000' });
  });
});

describe('SD-R2-03: no reward wording reaches the screen through an error', () => {
  it('a node\'s refusal becomes a code; its words never become the message', () => {
    const cases = [
      [{ success: false, error: 'No claimable rewards' }, null, 'NO_REWARDS'],
      [{ success: false, error: 'Node not registered on-chain. Registration TX required before claiming rewards.' }, null, 'NOT_REGISTERED'],
      [{ success: false, error: 'Claim already in progress for this node. Please wait and retry.' }, null, 'CLAIM_BUSY'],
      [{ success: false, error: 'slow down' }, 429, 'RATE_LIMITED'],
      [{ success: false, error: 'Invalid Dilithium3 signature for reward claim' }, null, 'CLAIM_REFUSED'],
      [null, 500, 'CLAIM_REFUSED'],
    ];
    for (const [answer, status, code] of cases) {
      const e = WalletManager.claimRefusal(answer, status);
      expect([code, e.code, /reward|claim/i.test(e.message)]).toEqual([code, code, false]);
    }
  });

  it('the QNet Link claim says "empty" or "busy" for those codes, not a refusal', async () => {
    const actions = (err) => nodeLinkActions({ walletManager: { claimRewards: async () => { throw err; } }, credential: 'c' });
    const claim = (err) => actions(err).claim({ nodeId: 'n', qnet: 'q', amountNano: 1 });
    expect(await claim(Object.assign(new Error('x'), { code: 'NO_REWARDS' }))).toEqual({ status: 'empty' });
    expect(await claim(Object.assign(new Error('x'), { code: 'CLAIM_BUSY' }))).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    expect(await claim(Object.assign(new Error('x'), { code: 'NOT_REGISTERED' }))).toEqual({ status: 'error', error: 'CLAIM_REFUSED' });
  });

  it('the move\'s failure card shows the code\'s text or "Nothing was submitted.", never the words in the error', () => {
    const src = SCREEN();
    const move = between(src, 'const moveNodeBalance = async', 'const handleClaimServerNodeRewards');
    expect(move).not.toMatch(/errorText\(/);
    expect((move.match(/claimErrorText\(/g) || []).length).toBe(2);
    expect(src).toMatch(/const claimErrorText = \(error\) => t\(\(error && CLAIM_TEXT\[error\.code\]\) \|\| 'claim_failed'\);/);
    // Each code's text is the Node tab's own, in every language: none of the QNet Link screen's texts, which appear only
    // on that screen (BuildParity).
    const keys = [...between(src, 'const CLAIM_TEXT = {', '};').matchAll(/: '([A-Za-z_]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const lang of Object.keys(translations)) {
      for (const k of keys) expect([lang, k, k.startsWith('link_'), typeof translations[lang][k]]).toEqual([lang, k, false, 'string']);
    }
  });

  // The English words the store rules keep out of the app, in any sentence the code itself writes (a log tag in
  // brackets excepted); comments are not shipped as text.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/(^|[^:\\'"`])\/\/.*$/, '$1')).join('\n');
  const LIT = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const sentences = (text) => (strip(text).match(LIT) || []).map((m) => m.slice(1, -1)).filter((s) => /\s/.test(s) && !s.startsWith('['));
  const WORDS = /reward|activat|mining/i;

  it('no sentence in the code speaks of rewards, activation or mining', () => {
    const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'App.tsx'), path.join(ROOT, 'index.js')]
      .filter((f) => !f.includes(`${path.sep}i18n${path.sep}`) && /\.(js|tsx?)$/.test(f));
    const found = files.flatMap((f) => sentences(fs.readFileSync(f, 'utf8')).filter((s) => WORDS.test(s))
      .map((s) => `${path.relative(ROOT, f)}: ${s.slice(0, 80)}`));
    expect(found).toEqual([]);
  });

  it('the scan sees what it must catch, and leaves paths, keys and log tags', () => {
    expect(sentences("throw new Error('Failed to claim rewards');").filter((s) => WORDS.test(s))).toHaveLength(1);
    expect(sentences("const u = '/api/v1/rewards/claim'; logger.warn('[claimRewards] refused:', x); // Claim rewards").filter((s) => WORDS.test(s)))
      .toEqual([]);
  });
});

describe('SD-R2-04, SD-R2-11, SD-R2-12: what the texts say', () => {
  const OLD_ROOTED = {
    en: 'Nothing about the device is sent anywhere.', de: 'Nichts über das Gerät wird irgendwohin gesendet.',
    es: 'No se envía nada sobre el dispositivo a ningún sitio.', fr: "Rien sur l'appareil n'est envoyé nulle part.",
    it: 'Nulla sul dispositivo viene inviato altrove.', pt: 'Nada sobre o dispositivo é enviado a lugar nenhum.',
    ru: 'Никакие данные об устройстве никуда не отправляются.', ja: 'デバイスに関する情報はどこにも送信されません。',
    ko: '기기에 관한 정보는 어디에도 전송되지 않습니다.', 'zh-CN': '不会向任何地方发送有关设备的信息。',
    ar: 'لا يُرسَل أي شيء عن الجهاز إلى أي مكان.',
  };

  it('SD-R2-04: the rooted-device warnings say the local check\'s result is not sent, not that nothing about the device is', () => {
    expect(Object.keys(OLD_ROOTED).sort()).toEqual(Object.keys(translations).sort());
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of ['set_rooted_warning', 'rooted_body_phrase']) {
        expect([lang, k, table[k].includes(OLD_ROOTED[lang])]).toEqual([lang, k, false]);
      }
    }
    expect(translations.en.set_rooted_warning).toMatch(/This check runs on the device, and its result is not sent anywhere\.$/);
    expect(translations.en.rooted_body_phrase).toMatch(/This check runs on the device, and its result is not sent anywhere\.$/);
  });

  it('SD-R2-11: under the screen lock the import screen\'s only step has no number', () => {
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, typeof table.import_step_phrase === 'string' && !/\d/.test(table.import_step_phrase)]).toEqual([lang, true]);
    }
    expect(SCREEN()).toMatch(/t\(deviceAuth \? 'import_step_phrase' : 'import_step2'\)/);
  });

  it('SD-R2-12: the Russian Node tab says the node starts working, never that it earns', () => {
    const ru = translations.ru;
    for (const k of ['node_linking', 'node_next_epoch']) {
      expect([k, ru[k].startsWith('Нода начнёт работать'), /заработ|доход/i.test(ru[k])]).toEqual([k, true, false]);
    }
  });
});

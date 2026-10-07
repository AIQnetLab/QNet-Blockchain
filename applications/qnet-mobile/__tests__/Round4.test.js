// Round-4 mobile findings: the device seal survives removing the screen lock (MVA-R4-01), a session is no string a
// password could pass for (MVA-R4-03), password fields keep their text from accessibility and a fresh check can be the
// system's biometric prompt (MPLAT-R4-01), value goes only to an address a key controls (MOBNET-R4-01), a kept
// transaction is "not gone through" only once no node can hold it (MOBNET-R4-02), an optimistic token balance carries
// no proof mark (MOBNET-R4-03), the light-client pin ships only when proven from the previous one and recent
// (MOBNET-R4-07, R4-EXTQ-05, MOBNET-R4-06).
jest.mock('../src/services/PushService', () => ({ checkNodeStatus: jest.fn() }));

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { Platform } = require('react-native');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const V = require('../src/crypto/Vault');
const DeviceSecurity = require('../src/services/DeviceSecurity');
const { WalletManager } = require('../src/components/WalletManager');
const P = require('../src/services/PendingTx');
const { optimisticTokenRow } = require('../src/utils/balanceMerge');
const { GENESIS_NODES } = require('../src/config/nodes');

jest.setTimeout(180000);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const TO = '02dca74ef2eae3be97feon499504db891ae0c60e36aaa';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Lantern-Quartz-Oriole-4';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
const stored = async (k) => JSON.parse(await AsyncStorage.getItem(k));

// A Keystore key stand-in: AES-256-GCM under a key of its own; `alive = false` is the key keystore2 deleted.
function fakeSealer(name) {
  const key = nodeCrypto.randomBytes(32);
  const sealer = {
    name,
    alive: true,
    seal: async (bytes) => {
      if (!sealer.alive) throw Object.assign(new Error('The device key is gone'), { code: 'KEY_MISSING' });
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

// Spies are restored one by one: jest.restoreAllMocks would also strip the AsyncStorage and Keychain mocks.
const spies = [];
const spy = (obj, name) => { const s = jest.spyOn(obj, name); spies.push(s); return s; };
const swaps = [];
const swap = (obj, name, value) => { swaps.push([obj, name, obj[name]]); obj[name] = value; return value; };
afterEach(() => {
  while (spies.length) spies.pop().mockRestore();
  while (swaps.length) { const [obj, name, orig] = swaps.pop(); obj[name] = orig; }
});

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
  swap(WalletManager, 'DEVICE_AUTH', false); // the Android password vault
});

describe('MVA-R4-01: removing the screen lock never makes the vault unopenable', () => {
  it('no Keystore key of the vault is bound to the screen lock, and the first seal key is never made again', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kt).not.toMatch(/setUnlockedDeviceRequired\(/);
    expect(kt).toMatch(/private const val SEAL_ALIAS = "qnet_vault_seal_v2"/);
    expect(kt).toMatch(/private const val LEGACY_SEAL_ALIAS = "qnet_vault_seal_v1"/);
    expect(kt).not.toMatch(/generateKey\(LEGACY_SEAL_ALIAS/);
    expect(kt).toMatch(/val key = secretKey\(LEGACY_SEAL_ALIAS\)/);
    expect(kt).toMatch(/fun deleteKeys\(promise: Promise\) \{\s*deleteKey\(SEAL_ALIAS\)\s*deleteKey\(LEGACY_SEAL_ALIAS\)/);
    expect(DeviceSecurity.DEVICE_SEALER).toBe('android-keystore-v2');
    expect(DeviceSecurity.LEGACY_DEVICE_SEALER).toBe('android-keystore');
  });

  it('resealDeviceWrap moves the password wrap to another key without the password, round trip checked', async () => {
    const legacy = fakeSealer('android-keystore');
    const current = fakeSealer('android-keystore-v2');
    const { vault } = await V.createVault('{"w":1}', PW, { hw: legacy });
    const moved = await V.resealDeviceWrap(vault, legacy, current);
    expect(moved).toMatchObject({ hw: 'android-keystore-v2', id: vault.id, encrypted: vault.encrypted, kdf: vault.kdf });
    const dek = await V.unwrapWithPassword(moved, PW, { hw: current });
    expect(dek).toHaveLength(32);
    await expect(V.unwrapWithPassword(moved, PW, { hw: legacy })).rejects.toBeInstanceOf(V.DeviceKeyError);
    // A new key that does not give the wrap back yields nothing to write.
    const broken = { ...current, open: async () => new Uint8Array(48) };
    await expect(V.resealDeviceWrap(vault, legacy, broken)).rejects.toBeInstanceOf(V.DeviceKeyError);
    await expect(V.resealDeviceWrap(vault, current, legacy)).rejects.toBeInstanceOf(V.VaultFormatError); // not its key
  });

  function sealers() {
    const legacy = fakeSealer('android-keystore');
    const current = fakeSealer('android-keystore-v2');
    const make = spy(DeviceSecurity, 'deviceSealer').mockResolvedValue(legacy); // an older build sealed with v1
    spy(DeviceSecurity, 'deviceSealerFor').mockImplementation((n) => ({ [legacy.name]: legacy, [current.name]: current }[n] || null));
    const del = spy(DeviceSecurity, 'deleteLegacyDeviceKey').mockResolvedValue(undefined);
    return { legacy, current, make, del };
  }

  it('a vault the first key sealed moves to the current key at the next password unlock, and outlives that key', async () => {
    const { legacy, current, make, del } = sealers();
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const before = await stored('qnet_wallet');
    expect(before.hw).toBe('android-keystore');

    make.mockResolvedValue(current);
    const r = await wm.unlockWithPassword(PW);
    expect(r.ok).toBe(true);
    const after = await stored('qnet_wallet');
    expect(after).toMatchObject({ hw: 'android-keystore-v2', id: before.id, encrypted: before.encrypted });
    expect(await AsyncStorage.getItem('qnet_wallet.bak')).toBe(JSON.stringify(after));
    expect(del).toHaveBeenCalledTimes(1);

    // The screen lock is removed: keystore2 deletes the first key. The right password still opens the wallet.
    legacy.alive = false;
    wm.closeSession();
    const again = await wm.unlockWithPassword(PW);
    expect(again.ok).toBe(true);
    expect((await wm.loadWallet(again.token)).qnetAddress).toBe(B.qnet);
    expect(await wm.revealMnemonic(PW)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('while the current key cannot be made, the vault stays on the first key and keeps opening', async () => {
    const { make, del } = sealers();
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    make.mockResolvedValue(null);
    expect((await wm.unlockWithPassword(PW)).ok).toBe(true);
    expect((await stored('qnet_wallet')).hw).toBe('android-keystore');
    expect(del).not.toHaveBeenCalled();
  });

  it('a biometric unlock moves it too, and keeps the biometric wrap', async () => {
    const { current, make } = sealers();
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const opened = await wm._openVault(PW);
    const bio = fakeSealer('android-biometric');
    await wm._writeVault(await V.withBioWrap(opened.vault, opened.dek, bio));
    opened.dek.fill(0);
    const withBio = await stored('qnet_wallet');
    spy(DeviceSecurity, 'biometricSealer').mockReturnValue(bio);
    make.mockResolvedValue(current);
    const r = await wm.unlockWithBiometrics();
    expect(r.ok).toBe(true);
    const after = await stored('qnet_wallet');
    expect(after.hw).toBe('android-keystore-v2');
    expect(after.bio).toEqual(withBio.bio);
    expect((await V.unwrapWithPassword(after, PW, { hw: current }))).toHaveLength(32);
  });
});

describe('MVA-R4-03: a session is no string, so no typed password can pass for one', () => {
  it('a password that starts like an old session token seals the vault and opens it again', async () => {
    const wm = manager();
    const pw = 'qnet-session:Kite-Marble-73';
    expect(await WalletManager.newPasswordProblem(pw)).toBeNull();
    const token = await wm.storeWallet(walletB(), pw);
    expect(typeof token).toBe('object');
    expect(Object.isFrozen(token)).toBe(true);
    expect(JSON.stringify(token)).toBe('{}'); // nothing of it reaches a log or a string
    wm.closeSession();
    const r = await wm.unlockWithPassword(pw);
    expect(r.ok).toBe(true);
    expect(await wm.checkPassword(pw)).toMatchObject({ ok: true });
    expect(await wm.revealMnemonic(pw)).toEqual({ ok: true, mnemonic: MNEMONIC });
    await wm.changePassword(pw, 'qnet-session:Otter-Canyon-58');
    expect(await wm.checkPassword('qnet-session:Otter-Canyon-58')).toMatchObject({ ok: true });
  });

  it('a token is never a password, a copy of one opens nothing, and a closed one is locked', async () => {
    const wm = manager();
    const token = await wm.storeWallet(walletB(), PW);
    expect(await wm.checkPassword(token)).toMatchObject({ ok: false, locked: false });
    expect((await wm.getPasswordLockStatus()).attempts).toBe(0);
    expect((await wm.loadWallet(token)).qnetAddress).toBe(B.qnet);
    await expect(wm.loadWallet({ ...token })).rejects.toThrow(/locked/);
    wm.closeSession();
    await expect(wm.loadWallet(token)).rejects.toThrow(/locked/);
    // The screen keeps the token in its password state: the text fields never show or count it.
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/const typedPassword = typeof password === 'string' \? password : '';/);
    expect(screen).not.toMatch(/value=\{password\}/);
  });
});

describe('MPLAT-R4-01: what an accessibility service can read or do at a password prompt', () => {
  it('every password field and the phrase field hide their text and refuse set-text on every API level', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kt).toMatch(/override fun onHostResume\(\) \{[\s\S]*?watchSecretFields\(activity\)/);
    expect(kt).toMatch(/addOnGlobalLayoutListener \{ guardSecretFields\(decor\) \}/);
    const guard = kt.slice(kt.indexOf('private class SecretFieldGuard'), kt.indexOf('override fun onHostPause'));
    expect(guard).toMatch(/info\.text = null/);
    for (const marker of ['TYPE_VIEW_TEXT_CHANGED', 'TYPE_VIEW_TEXT_SELECTION_CHANGED', 'ACTION_SET_TEXT', 'ACTION_PASTE',
      'override fun dispatchPopulateAccessibilityEvent', 'override fun performAccessibilityAction']) {
      expect(guard).toContain(marker);
    }
    expect(guard).not.toMatch(/SDK_INT/);
    const secret = kt.slice(kt.indexOf('private fun isSecretField'), kt.indexOf('private val delegateField'));
    expect(secret).toMatch(/TYPE_TEXT_VARIATION_PASSWORD/);
    expect(secret).toMatch(/SEED_NATIVE_ID/);
    const { PASSWORD_INPUT_PROPS } = require('../src/utils/sensitiveInput');
    expect(PASSWORD_INPUT_PROPS.secureTextEntry).toBe(true); // an EditText of TYPE_TEXT_VARIATION_PASSWORD
    // The comments no longer rest the guarantee on a typed password alone.
    expect(read('src/services/DeviceSecurity.js')).toMatch(/every password field, on every screen and API level, MPLAT-R4-01/);
  });

  it('confirmWithBiometrics answers ok only when the biometric key gives this session\'s own data key', async () => {
    swap(Platform, 'OS', 'android');
    const wm = manager();
    await wm.storeWallet(walletB(), PW);
    const opened = await wm._openVault(PW);
    const bio = fakeSealer('android-biometric');
    await wm._writeVault(await V.withBioWrap(opened.vault, opened.dek, bio));
    const plain = opened.vault;
    opened.dek.fill(0);
    const sealer = spy(DeviceSecurity, 'biometricSealer').mockReturnValue(bio);
    expect(await wm.confirmWithBiometrics('Send 1 QNC', 'Apps that can read the screen …')).toEqual({ ok: true });
    expect(sealer).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Send 1 QNC', subtitle: 'Apps that can read the screen …' }));

    // "Use password" or a dismissed prompt: the caller asks for the password.
    sealer.mockReturnValue({ ...bio, open: async () => { throw Object.assign(new Error('cancelled'), { code: 'BIO_CANCELLED' }); } });
    expect(await wm.confirmWithBiometrics('Send 1 QNC')).toEqual({ ok: false, fallback: true });

    // A biometric wrap of some other key is no confirmation.
    sealer.mockReturnValue(bio);
    await wm._writeVault(await V.withBioWrap(plain, new Uint8Array(nodeCrypto.randomBytes(32)), bio));
    expect(await wm.confirmWithBiometrics('Send 1 QNC')).toEqual({ ok: false, fallback: true });

    // A new fingerprint was enrolled: the key is dead, biometric unlock goes off, the next unlock rotates the data key.
    sealer.mockReturnValue({ ...bio, open: async () => { throw Object.assign(new Error('invalidated'), { code: 'KEY_INVALIDATED' }); } });
    expect(await wm.confirmWithBiometrics('Send 1 QNC')).toEqual({ ok: false, fallback: true });
    expect(await AsyncStorage.getItem(WalletManager.DEK_ROTATE_KEY)).toBe('1');

    // Locked: nothing to confirm against.
    sealer.mockReturnValue(bio);
    wm.closeSession();
    expect(await wm.confirmWithBiometrics('Send 1 QNC')).toEqual({ ok: false, fallback: true });
  });

  it('every fresh check names the apps that can read the screen and tries the biometric prompt first', () => {
    const screen = read('src/screens/WalletScreen.js');
    const fresh = screen.slice(screen.indexOf('const confirmFresh = async'), screen.indexOf('const resolveFresh ='));
    expect(fresh).toMatch(/const readers = await screenReaderApps\(\);/);
    // (MPLAT-R5-01 added what the approval approves as the third argument.)
    expect(fresh).toMatch(/if \(biometricEnabled\) \{\s*const bio = await walletManager\.confirmWithBiometrics\(reason, note(, detail)?\)/);
    // Sends, a site's approvals and QNet Link requests all go through it.
    expect(screen).toMatch(/if \(!\(await confirmFresh\(t\('send_confirm_reason'/);
    expect(screen).toMatch(/authenticate=\{confirmFresh\}/);
    expect(screen).toMatch(/authenticate=\{\(reason\) => confirmFresh\(reason, owner\)\}/);
  });
});

describe('MOBNET-R4-01: value goes only to an address a key controls', () => {
  const HEX = 'c'.repeat(64);
  const TX_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  it('a recipient is a checksummed EON address; 64 hex is refused, and stays only a call target', () => {
    expect(WalletManager.recipientAddress(B.qnet.toUpperCase())).toBe(B.qnet);
    for (const hex of [HEX, HEX.toUpperCase(), TX_HASH]) {
      expect(() => WalletManager.recipientAddress(hex)).toThrow(expect.objectContaining({ code: 'HEX_RECIPIENT' }));
      expect(WalletManager.canonicalAddress(hex)).toBe(hex.toLowerCase());
    }
    const typo = `${B.qnet.slice(0, 5)}${B.qnet[5] === '0' ? '1' : '0'}${B.qnet.slice(6)}`;
    expect(() => WalletManager.recipientAddress(typo)).toThrow(expect.objectContaining({ code: 'ADDRESS_CHECKSUM' }));
  });

  it('QNC, token and NFT sends refuse a 64-hex recipient before the wallet is even opened', async () => {
    const wm = manager();
    wm.loadWallet = jest.fn();
    const contract = 'd'.repeat(64);
    await expect(wm.sendQNC(HEX, 1, 'pw')).rejects.toMatchObject({ code: 'HEX_RECIPIENT' });
    await expect(wm.sendQNC(TX_HASH, 1, 'pw', { amountNano: 5 })).rejects.toMatchObject({ code: 'HEX_RECIPIENT' });
    expect(await wm.sendTransaction(B.qnet, contract, 1, 'QNC', 'pw')).toMatchObject({ success: false, code: 'HEX_RECIPIENT' });
    for (const call of [
      () => wm.qrc20Transfer(contract, contract, '5', 'pw'),
      () => wm.qrc20Approve(contract, HEX, '5', 'pw'),
      () => wm.qrc20TransferFrom(contract, B.qnet, HEX, '5', 'pw'),
      () => wm.nftTransfer(contract, TX_HASH, '1', 'pw'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'HEX_RECIPIENT' });
    }
    expect(wm.loadWallet).not.toHaveBeenCalled();
  });

  it('the screens check it before anything is asked, and say hex is not an account', () => {
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/recipientOk = !!WalletManager\.recipientAddress\(sendAddress\)/);
    expect(screen).not.toMatch(/isValidHex/);
    const en = require('../src/i18n/translations').default.en;
    expect(en.send_invalid_address).toMatch(/64-character hex value .* is not an account/);
    expect(en.send_invalid_address).not.toMatch(/or hex/);
  });
});

describe('MOBNET-R4-02: a kept transaction may land for as long as a node may hold it', () => {
  const FROM = B.qnet;
  const entry = (nonce, over = {}) => ({
    from: FROM, nonce, path: '/api/v1/transaction', body: { nonce, to: TO }, pk: null,
    summary: { kind: 'transfer', to: TO, amountNano: 50_000_000_000, method: null }, createdAt: Date.now(), ...over,
  });

  it('follows the node\'s mempool lifetime: 30 min from the last acceptance or send, plus a margin', () => {
    expect(P.NODE_MEMPOOL_TTL_MS).toBe(30 * 60_000);
    const t0 = 1_900_000_000_000;
    const e = { nonce: 5, state: 'accepted', acceptedAt: t0, createdAt: t0 - 1000, lastSentAt: t0, summary: {} };
    // At minute 12 a node surely still holds it: no "not accepted yet", no Stop.
    expect(P.pendingView(e, t0 + 12 * 60_000)).toMatchObject({ held: true, mayLand: true });
    expect(P.stoppable([e], 5, t0 + 12 * 60_000)).toBe(false);
    expect(P.pendingView(e, t0 + P.HELD_MS + 1)).toMatchObject({ held: false, mayLand: true });
    expect(P.mayLandUntil(e)).toBe(t0 + 30 * 60_000 + P.LANDING_MARGIN_MS);
    // A resend after the node dropped it admits it for another half hour.
    expect(P.mayLandUntil({ ...e, lastSentAt: t0 + 20 * 60_000 })).toBe(t0 + 50 * 60_000 + P.LANDING_MARGIN_MS);
    expect(P.pendingView(e, P.mayLandUntil(e))).toMatchObject({ mayLand: false });
  });

  it('Stop is refused while a node holds it; a stopped one is remembered until it can no longer land', async () => {
    const wm = new WalletManager();
    await P.putSigned(entry(5, { createdAt: Date.now() - P.HELD_MS - 60_000 }));
    await P.updateEntry(FROM, 5, { state: 'accepted', acceptedAt: Date.now() - 12 * 60_000, lastSentAt: Date.now() - 12 * 60_000 });
    let [v] = await wm.keptTransactions(FROM);
    expect(v).toMatchObject({ held: true, canStop: false, mayLand: true });
    expect(await wm.stopPendingTransaction(FROM, 5, v.bodyHash)).toBe(false);

    const acceptedAt = Date.now() - P.HELD_MS - 1000;
    await P.updateEntry(FROM, 5, { acceptedAt, lastSentAt: acceptedAt });
    [v] = await wm.keptTransactions(FROM);
    expect(v).toMatchObject({ held: false, canStop: true, mayLand: true });
    expect(v.stopLandsUntil).toBe(acceptedAt + P.NODE_MEMPOOL_TTL_MS + P.LANDING_MARGIN_MS);
    expect(await wm.stopPendingTransaction(FROM, 5, v.bodyHash)).toBe(true);
    expect(await P.pendingFor(FROM)).toEqual([]);
    expect(await P.stoppedUntil(FROM, 5)).toBe(v.stopLandsUntil);

    // The result card of that send still says it can go through, until then.
    wm._hedged = jest.fn(async () => ({ ok: true, data: { nonce: 4 } }));
    wm.rebroadcastPending = jest.fn(async () => false);
    expect(await wm.resolveSubmitByNonce(FROM, 5, { toAddress: TO, amountNano: 50_000_000_000 }))
      .toMatchObject({ landed: false, known: true, sending: false, mayLandUntil: v.stopLandsUntil });
    // Once the nonce is consumed, the memory goes.
    await P.settle(FROM, 5);
    expect(await P.stoppedUntil(FROM, 5)).toBeNull();
  });

  it('a refusal while another node\'s copy went unanswered is not final, and is sent again', async () => {
    const wm = new WalletManager();
    wm.getTrustedNodes = () => GENESIS_NODES.slice();
    const refusal = { ok: false, status: 400, data: { error: 'Insufficient balance: have 1, need 2' } };
    wm._hedged = jest.fn(async (p, o) => ({ ...refusal, base: o.nodes[0], answers: [{ ...refusal, base: o.nodes[0] }], unanswered: 1 }));
    await P.putSigned(entry(5));
    const out = await wm._sendPending(await P.pendingEntry(FROM, 5));
    expect(out).toMatchObject({ accepted: false, uncertain: true });
    const kept = await P.pendingEntry(FROM, 5);
    expect(kept.stopped).toBeUndefined();
    expect(kept.refusalUncertain).toBe(true);
    expect(P.autoSendable(kept)).toBe(true);
    // With every node answering, the same refusal is final.
    wm._hedged = jest.fn(async (p, o) => ({ ...refusal, base: o.nodes[0], answers: [{ ...refusal, base: o.nodes[0] }], unanswered: 0 }));
    await wm._sendPending(await P.pendingEntry(FROM, 5));
    expect(await P.pendingEntry(FROM, 5)).toMatchObject({ stopped: 'refused', refusalUncertain: false });
  });

  describe('a hedged submit', () => {
    const [N1, N2] = GENESIS_NODES;
    const took = (r) => !!(r && r.data && r.data.tx_hash);
    let aborted;
    const install = (second) => {
      aborted = [];
      swap(global, 'fetch', jest.fn((url, opts) => new Promise((resolve, reject) => {
        if (url.startsWith(N1)) {
          resolve({ ok: false, status: 400, json: async () => ({ error: 'nonce too low' }) });
          return;
        }
        let finished = false;
        opts.signal.addEventListener('abort', () => {
          if (finished) return;
          finished = true;
          aborted.push(url);
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
        setTimeout(() => {
          if (finished) return;
          finished = true;
          if (second === 'accept') resolve({ ok: true, status: 200, json: async () => ({ tx_hash: 'h2' }) });
          else reject(new TypeError('Network request failed'));
        }, 30);
      })));
    };

    it('a refusal from one node does not cut off the other node\'s copy; its acceptance settles', async () => {
      install('accept');
      const wm = new WalletManager();
      const res = await wm._hedged('/api/v1/transaction', { method: 'POST', body: { a: 1 }, nodes: [N1, N2], hedgeMs: 5, settleOn: took });
      expect(res.data.tx_hash).toBe('h2');
      expect(aborted).toEqual([]);
      expect(res.answers.map((a) => a.base)).toEqual([N1, N2]);
    });

    it('a refusal next to a request that never came back is reported with the unanswered one', async () => {
      install('silent');
      const wm = new WalletManager();
      const res = await wm._hedged('/api/v1/transaction', { method: 'POST', body: { a: 1 }, nodes: [N1, N2], hedgeMs: 5, settleOn: took });
      expect(res).toMatchObject({ ok: false, unanswered: 1 });
      expect(res.answers.map((a) => a.base)).toEqual([N1]);
    });
  });

  it('the screens say "can still go through" until no node can hold it', () => {
    const en = require('../src/i18n/translations').default.en;
    expect(en.kept_stop_body).toMatch(/can still go through for about \{minutes\} more min/);
    expect(en.tx_note_stopped_may_land).toMatch(/can still go through for about \{minutes\} more min/);
    expect(en.kept_stopped_may_land).toMatch(/\{minutes\}/);
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/if \(landing > 0\) return t\('kept_stopped_may_land', \{ minutes: landing \}\);\s*return t\('kept_stopped'\);/);
    expect(screen).toMatch(/if \(Date\.now\(\) >= giveUpAt && landing === 0\)/);
  });
});

describe('MOBNET-R4-03: an optimistic token balance carries no proof mark', () => {
  it('the row after a send shows current minus sent, unverified; other rows and a send to itself keep theirs', () => {
    const wm = new WalletManager();
    const C = 'c'.repeat(64);
    const row = { contract: C, symbol: 'TK', balance: '1000', verified: true };
    const next = optimisticTokenRow(row, C, false, wm.toBaseUnits('900', 9), 9, wm);
    expect(next).toMatchObject({ contract: C, verified: false, balance: wm._formatBaseUnits(wm.toBaseUnits('100', 9), 9) });
    expect(optimisticTokenRow(row, C, true, '900', 9, wm)).toBe(row);
    const other = { ...row, contract: 'e'.repeat(64) };
    expect(optimisticTokenRow(other, C, false, '900', 9, wm)).toBe(other);
    expect(optimisticTokenRow({ ...row, balance: 'x' }, C, false, 'not-a-number', 9, wm).verified).toBe(false);
    expect(read('src/screens/WalletScreen.js'))
      .toMatch(/setQrcTokens\(\(prev\) => prev\.map\(\(row\) => optimisticTokenRow\(row, sendingToken\.contract, toSelf, amountBaseUnits, decimals, walletManager\)\)\)/);
  });
});

describe('MOBNET-R4-07 / R4-EXTQ-05 / MOBNET-R4-06: the light-client pin ships proven from the last one, and recent', () => {
  const { checkPin, pinOfSource, PIN_MAX_AGE_DAYS, QC_SIG_RETENTION_MB } = require('../scripts/release-check');
  const H = (c) => c.repeat(64);
  const block = (date, provenFrom, index = 23400) => [
    '// <ws-pin>',
    `// Generated by scripts/ws-pin.js on ${date} from 5 genesis nodes (head ${index * 90}; 99 macroblocks QC-verified from the previous pin 23301).`,
    'export const WS_CHECKPOINT = {',
    `  index: ${index},`,
    `  hash: '${H('a')}',`,
    provenFrom ? `  provenFrom: { index: ${provenFrom}, hash: '${H('b')}' },` : '  provenFrom: null,',
    '  anchors: {',
  ].join('\n');

  it('passes a recent pin proven from the previous one', () => {
    expect(pinOfSource(block('2026-09-25', 23301))).toEqual({ generated: '2026-09-25', index: 23400, hash: H('a'), provenFrom: { index: 23301, hash: H('b') } });
    expect(checkPin({ source: block('2026-09-25', 23301), today: '2026-09-30' })).toEqual([]);
    expect(checkPin({ source: block('2026-09-25', 23301), today: '2026-09-30', head: 23400 * 90 + 900 })).toEqual([]);
  });

  it('refuses a bootstrap pin unless the release says it is one, a stale pin, a bad link and a pin past retention', () => {
    expect(checkPin({ source: block('2026-09-25', null), today: '2026-09-25' })).toEqual([expect.stringMatching(/not proven from a previous pin/)]);
    expect(checkPin({ source: block('2026-09-25', null), today: '2026-09-25', allowBootstrap: true })).toEqual([]);
    expect(PIN_MAX_AGE_DAYS).toBe(14);
    expect(checkPin({ source: block('2026-09-01', 23301), today: '2026-09-25' })).toEqual([expect.stringMatching(/days old/)]);
    expect(checkPin({ source: block('2026-09-25', 23400), today: '2026-09-25' })).toEqual([expect.stringMatching(/not below it/)]);
    expect(checkPin({ source: block('2026-09-25', 23301), today: '2026-09-25', head: (23400 + QC_SIG_RETENTION_MB + 10) * 90 }))
      .toEqual([expect.stringMatching(/below the head/)]);
    expect(checkPin({ source: '// no pin here', today: '2026-09-25' })).toEqual([expect.stringMatching(/ws-pin\.js --write/)]);
  });

  it('ws-pin proves the new pin from the committed one by default and records the link in the format checked', () => {
    const wsPin = read('scripts/ws-pin.js');
    expect(wsPin).toMatch(/const bootstrap = flag\('bootstrap'\);\s*const fromCurrent = !bootstrap;/);
    expect(wsPin).toMatch(/base = CURRENT_PIN\.index;/);
    expect(wsPin).toMatch(/anchors\[j\] = await verifyStep\(j, proof, anchors\[j - 2\]/);
    expect(wsPin).toContain("provenFrom ? `  provenFrom: { index: ${provenFrom.index}, hash: '${provenFrom.hash}' },` : '  provenFrom: null,'");
    expect(wsPin).toContain('`Generated by scripts/ws-pin.js on ${new Date().toISOString().slice(0, 10)} from ${nodes.length} genesis nodes `');
    expect(JSON.parse(read('package.json')).scripts['check:release']).toBe('node scripts/release-check.js');
  });
});

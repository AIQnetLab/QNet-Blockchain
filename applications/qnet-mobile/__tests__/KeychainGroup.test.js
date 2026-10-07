// iOS Keychain items live in the app's own group (MVA-R2-05 / MPLAT-R2-06): the entitlement's first group is the
// app's identifier, items an older build wrote to the group named after com.qnet.mobile move out of it (the vault
// secret only after it is written under its new name), and a lockout item a failed write removed is not a clean
// slate (MVA-R2-01).
const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');
const { UNREADABLE_FAILURES } = require('../src/utils/passwordLimiter');

jest.setTimeout(120000);

// An in-memory Keychain: service -> { username, password, group }. Writes delete first, then add to the default
// group, as react-native-keychain does on iOS.
let items;
let log;
const DEFAULTS = {};
beforeAll(() => {
  for (const k of ['setGenericPassword', 'getGenericPassword', 'resetGenericPassword', 'getAllGenericPasswordServices']) {
    DEFAULTS[k] = Keychain[k].getMockImplementation();
  }
});
beforeEach(async () => {
  await AsyncStorage.clear();
  items = new Map();
  log = [];
  Keychain.setGenericPassword.mockImplementation(async (username, password, o) => {
    log.push(['set', o.service]);
    items.set(o.service, { username, password, group: 'own' });
    return true;
  });
  Keychain.getGenericPassword.mockImplementation(async (o) => {
    log.push(['get', o.service]);
    return items.has(o.service) ? { username: items.get(o.service).username, password: items.get(o.service).password } : false;
  });
  Keychain.resetGenericPassword.mockImplementation(async (o) => { log.push(['reset', o.service]); items.delete(o.service); return true; });
  Keychain.getAllGenericPasswordServices.mockImplementation(async () => [...items.keys()]);
});
afterAll(() => {
  for (const [k, impl] of Object.entries(DEFAULTS)) Keychain[k].mockImplementation(impl);
});

it('the entitlement puts every new item in the app\'s own group, the old one kept second for the move', () => {
  const ent = fs.readFileSync(path.join(__dirname, '../ios/QNetMobile/QNetMobile.entitlements'), 'utf8');
  const groups = [.../<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(ent)[1].matchAll(/<string>([^<]+)<\/string>/g)]
    .map((m) => m[1]);
  expect(groups).toEqual(['$(AppIdentifierPrefix)com.qnetmobile', '$(AppIdentifierPrefix)com.qnet.mobile']);
  const pbx = fs.readFileSync(path.join(__dirname, '../ios/QNetMobile.xcodeproj/project.pbxproj'), 'utf8');
  expect(pbx).toMatch(/PRODUCT_BUNDLE_IDENTIFIER = com\.qnetmobile;/);
});

it('the lockout and the ping keys are written again at launch, once', async () => {
  items.set('qnet_pw_limiter', { username: 'lockout', password: '{"failures":2}', group: 'old' });
  items.set('qnet_ping_sk_light_1', { username: 'ping_key_light_1', password: 'sk', group: 'old' });
  items.set('com.qnet.wallet.biometric', { username: 'qnet_wallet', password: 'secret', group: 'old' });
  const wm = new WalletManager();
  await wm.migrateKeychainGroup();
  expect(items.get('qnet_pw_limiter')).toEqual({ username: 'lockout', password: '{"failures":2}', group: 'own' });
  expect(items.get('qnet_ping_sk_light_1')).toEqual({ username: 'ping_key_light_1', password: 'sk', group: 'own' });
  // The vault secret needs Face ID to read: it is not touched at launch.
  expect(items.get('com.qnet.wallet.biometric').group).toBe('old');
  const writes = log.filter(([op]) => op === 'set').length;
  await wm.migrateKeychainGroup();
  expect(log.filter(([op]) => op === 'set').length).toBe(writes);
});

it('the vault secret moves at the next unlock: written under its new name before the old item goes', async () => {
  const wm = Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
  const secret = wm.generateVaultPassword();
  await wm.storeWallet({ address: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', qnetAddress: '02dca74ef2eae3be97feon499504db891ae0c60e364a8' }, secret,
    { deviceAuth: true });
  items.set('com.qnet.wallet.biometric', { username: 'qnet_wallet', password: secret, group: 'old' });
  log = [];
  const r = await wm.unlockWithBiometrics();
  expect(r.ok).toBe(true);
  expect(items.get(WalletManager.DEVICE_AUTH_SERVICE)).toEqual({ username: 'qnet_wallet', password: secret, group: 'own' });
  expect(items.has('com.qnet.wallet.biometric')).toBe(false);
  const setAt = log.findIndex(([op, s]) => op === 'set' && s === WalletManager.DEVICE_AUTH_SERVICE);
  const resetAt = log.findIndex(([op, s]) => op === 'reset' && s === 'com.qnet.wallet.biometric');
  expect(setAt).toBeGreaterThanOrEqual(0);
  expect(resetAt).toBeGreaterThan(setAt);
  // From now on the new item alone opens it.
  expect((await wm.unlockWithBiometrics()).ok).toBe(true);
  expect(await wm._deviceAuthItem('Unlock')).toEqual({ ok: true, service: WalletManager.DEVICE_AUTH_SERVICE, secret });
  // No public way to the raw secret (MA-7): the screen passes deviceAuthCredential.
  expect(wm.deviceAuthSecret).toBeUndefined();
});

it('a secret that does not open the vault is not moved, and the old item stays', async () => {
  const wm = Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
  await wm.storeWallet({ address: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', qnetAddress: '02dca74ef2eae3be97feon499504db891ae0c60e364a8' },
    wm.generateVaultPassword(), { deviceAuth: true });
  items.set('com.qnet.wallet.biometric', { username: 'qnet_wallet', password: 'not-this-vaults-secret', group: 'old' });
  expect((await wm.unlockWithBiometrics()).ok).toBe(false);
  expect(items.has(WalletManager.DEVICE_AUTH_SERVICE)).toBe(false);
  expect(items.get('com.qnet.wallet.biometric').password).toBe('not-this-vaults-secret');
});

it('a lockout item gone after failures were recorded counts as the most failures', async () => {
  const wm = new WalletManager();
  await wm.checkPassword('wrong-password-1'); // no vault: a counted failure all the same
  expect(await AsyncStorage.getItem('qnet_pw_limiter_counted')).toBe('1');
  items.delete('qnet_pw_limiter'); // a write that deleted the item and then failed to add it
  const next = new WalletManager();
  expect((await next.getPasswordLockStatus()).attempts).toBe(UNREADABLE_FAILURES);
  // A clean slate is only a lockout never counted.
  await AsyncStorage.clear();
  expect((await new WalletManager().getPasswordLockStatus()).attempts).toBe(0);
});

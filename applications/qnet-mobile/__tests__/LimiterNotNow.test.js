// MOBAUTH-R4-01: a silent push or background task can start the app while the iPhone is locked. The lockout's Keychain
// item (when unlocked, this device only) is then refused with errSecInteractionNotAllowed. That refusal is no answer:
// it must never be kept as "unreadable" (the most failures), which would turn the next wrong password into a 30-minute
// lockout. An item that is missing although failures were counted still reads as unreadable.
const { Platform } = require('react-native');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');
const { UNREADABLE_FAILURES } = require('../src/utils/passwordLimiter');

const OS = Platform.OS;
let items;
let refuse;
const DEFAULTS = {};
beforeAll(() => {
  for (const k of ['setGenericPassword', 'getGenericPassword']) DEFAULTS[k] = Keychain[k].getMockImplementation();
});
beforeEach(async () => {
  Platform.OS = 'ios';
  await AsyncStorage.clear();
  items = new Map();
  refuse = false;
  const notNow = () => Object.assign(new Error('User interaction is not allowed.'), { code: '-25308' });
  Keychain.setGenericPassword.mockImplementation(async (u, password, o) => {
    if (refuse) throw notNow();
    items.set(o.service, password);
    return true;
  });
  Keychain.getGenericPassword.mockImplementation(async (o) => {
    if (refuse) throw notNow();
    return items.has(o.service) ? { username: 'lockout', password: items.get(o.service) } : false;
  });
});
afterEach(() => { Platform.OS = OS; });
afterAll(() => {
  for (const [k, impl] of Object.entries(DEFAULTS)) Keychain[k].mockImplementation(impl);
});

it('a locked iPhone at a background launch leaves the free attempts in place', async () => {
  items.set('qnet_pw_limiter', JSON.stringify({ failures: 1, until: 0, lockMs: 0, boot: 0 }));
  await AsyncStorage.setItem('qnet_pw_limiter_counted', '1');
  const wm = new WalletManager();
  refuse = true;                                   // the app woke for a push while the phone is locked
  const bg = await wm.getPasswordLockStatus();
  expect(bg).toMatchObject({ locked: false, unknown: true });
  expect(bg.attempts).not.toBe(UNREADABLE_FAILURES);
  refuse = false;                                  // the user unlocks the phone and opens the app
  expect(await wm.getPasswordLockStatus()).toMatchObject({ locked: false, attempts: 1 });
  // A wrong password now is the second of the three free attempts, not a 30-minute lockout.
  const r = await wm._checked('Wrong-Password-1', async () => { throw new Error('bad tag'); });
  expect(r).toMatchObject({ ok: false, locked: false, attempts: 2 });
});

it('a check while the read is refused runs nothing and is retried once the phone is unlocked', async () => {
  const wm = new WalletManager();
  refuse = true;
  const open = jest.fn(async () => {});
  expect(await wm._checked('Some-Password-1', open)).toMatchObject({ ok: false, unrecorded: true, notNow: true });
  expect(open).not.toHaveBeenCalled();
  refuse = false;
  expect(await wm._checked('Some-Password-1', open)).toEqual({ ok: true });
});

it('an item that is missing although failures were counted still reads as the most failures', async () => {
  await AsyncStorage.setItem('qnet_pw_limiter_counted', '1');
  const wm = new WalletManager();
  expect((await wm.getPasswordLockStatus()).attempts).toBe(UNREADABLE_FAILURES);
});

it('on Android any refused read stays fail-closed', async () => {
  Platform.OS = 'android';
  Keychain.getGenericPassword.mockImplementation(async () => { throw Object.assign(new Error('x'), { code: '-25308' }); });
  const wm = new WalletManager();
  expect((await wm.getPasswordLockStatus()).attempts).toBe(UNREADABLE_FAILURES);
});

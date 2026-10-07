// MOBAUTH-R1-01: iOS writes an AsyncStorage multiSet key by key, so a password change can stop between the vault's two
// copies. Every vault write carries a generation, the newest copy decides, and a password the newer copy refuses never
// opens, or repairs from, the older one: the old password does not come back, and the new one keeps working.
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { WalletManager } = require('../src/components/WalletManager');

jest.setTimeout(480000);

const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OLD_PW = 'Lantern-Quartz-Oriole-4';
const NEW_PW = 'Harbor-Violet-Cinder-81';
const walletB = () => ({ address: B.sol, publicKey: B.sol, qnetAddress: B.qnet, mnemonic: MNEMONIC });
const manager = () => Object.assign(new WalletManager(), { migrateQNetAddress: async (w) => w });
const copies = async () => (await AsyncStorage.multiGet([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]))
  .map(([, v]) => JSON.parse(v));

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
afterAll(() => {
  for (const [k, impl] of Object.entries(DEFAULTS)) Keychain[k].mockImplementation(impl);
});

// A multiSet that writes its pairs one at a time and stops (the app killed) after `n` of them, once: the call never
// returns, as nothing of the app runs after a kill. `stopped` resolves once the pairs are written.
function stopAfter(n) {
  const write = AsyncStorage.multiSet;
  let done;
  const stopped = new Promise((r) => { done = r; });
  AsyncStorage.multiSet = jest.fn(async (pairs) => {
    if (!pairs.some(([k]) => k === WalletManager.VAULT_KEY)) return write(pairs);
    AsyncStorage.multiSet = write;
    for (const pair of pairs.slice(0, n)) await write([pair]);
    done();
    return new Promise(() => {});
  });
  return { stopped, restore: () => { AsyncStorage.multiSet = write; } };
}

// iOS (MA-R3-01): a multiSet goes on writing after a key fails and reports the error only at the end. The pairs whose
// keys `failing` names are not written (the old value stays, as an atomic file write leaves it), the rest are, for the
// next `times` vault writes.
function failKeys(failing, times = 1) {
  const write = AsyncStorage.multiSet;
  let left = times;
  AsyncStorage.multiSet = jest.fn(async (pairs) => {
    if (left <= 0 || !pairs.some(([k]) => k === WalletManager.VAULT_KEY)) return write(pairs);
    left -= 1;
    for (const pair of pairs) if (!failing.includes(pair[0])) await write([pair]);
    throw new Error('Failed to write value.');
  });
  return () => { AsyncStorage.multiSet = write; };
}

describe('MOBAUTH-R1-01: a password change stopped between the two copies', () => {
  it('every write carries a generation above the stored one', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), OLD_PW);
    const [a, b] = await copies();
    expect(a.gen).toBeGreaterThan(0);
    expect(b).toEqual(a);
    await wm.changePassword(OLD_PW, NEW_PW);
    const [c, d] = await copies();
    expect(c.gen).toBeGreaterThan(a.gen);
    expect(d).toEqual(c);
  });

  it('the old password opens nothing and repairs nothing; the new one opens and repairs', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), OLD_PW);
    const kill = stopAfter(1); // the primary under the new password, the backup still under the old one
    try {
      wm.changePassword(OLD_PW, NEW_PW).catch(() => {});
      await kill.stopped;
    } finally {
      kill.restore();
    }
    const [primary, backup] = await copies();
    expect(primary.gen).toBeGreaterThan(backup.gen);
    expect(primary.pw.ct).not.toBe(backup.pw.ct);

    // Whoever holds the phone and knows the old password: a wrong password, counted, and the copies stay as they are.
    const thief = manager();
    const r = await thief.unlockWithPassword(OLD_PW);
    expect(r.ok).toBe(false);
    expect((await thief.getPasswordLockStatus()).attempts).toBe(1);
    const [p2, b2] = await copies();
    expect(p2).toEqual(primary);
    expect(b2).toEqual(backup);

    // The owner's new password opens the newer copy and repairs the older one from it.
    const owner = manager();
    const ok = await owner.unlockWithPassword(NEW_PW);
    expect(ok.ok).toBe(true);
    expect((await owner.loadWallet(ok.token)).qnetAddress).toBe(B.qnet);
    const [p3, b3] = await copies();
    expect(b3).toEqual(p3);
    expect(p3.pw.ct).toBe(primary.pw.ct);
    expect(p3.gen).toBeGreaterThan(primary.gen);
    owner.closeSession();
    expect((await manager().unlockWithPassword(OLD_PW)).ok).toBe(false);
  });

  it('a newer copy that is damaged still lets the older one open, and the repair gives both a new generation', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), OLD_PW);
    const [good] = await copies();
    // A newer copy that parses but is no vault the password can be tried on (damage before the password).
    await AsyncStorage.setItem(WalletManager.VAULT_KEY, JSON.stringify({ version: 4, gen: good.gen + 5, broken: true }));
    const r = await manager().unlockWithPassword(OLD_PW);
    expect(r.ok).toBe(true);
    const [p, b] = await copies();
    expect(b).toEqual(p);
    expect(p.pw.ct).toBe(good.pw.ct);
    expect(p.gen).toBeGreaterThan(good.gen + 5);
  });

  it('what reads the stored vault without a password sees the newest copy only', async () => {
    const wm = manager();
    await wm.storeWallet(walletB(), OLD_PW);
    const [good] = await copies();
    await AsyncStorage.setItem(WalletManager.VAULT_BACKUP_KEY, JSON.stringify({ ...good, gen: good.gen - 1, bio: { stale: true } }));
    const newest = await wm._vaultCandidates();
    expect(newest).toHaveLength(1);
    expect(newest[0].vault.bio).toBeUndefined();
    expect(await wm.isBiometricEnabled()).toBe(false);
    expect(await wm._vaultCandidates({ all: true })).toHaveLength(2);
  });
});

describe('MA-R3-01: a password change whose write reports an error after storing part of it (iOS)', () => {
  const signs = async (wm, token) => {
    const w = await wm.loadWallet(token);
    expect(w.qnetAddress).toBe(B.qnet);
    return w;
  };

  it('the new vault stored in one copy: the change stands, the session moves to the new key, the rest is written again', async () => {
    const wm = manager();
    const token = await wm.storeWallet(walletB(), OLD_PW);
    const restore = failKeys([WalletManager.VAULT_BACKUP_KEY]); // the primary written, the backup refused, once
    try {
      await expect(wm.changePassword(OLD_PW, NEW_PW)).resolves.toEqual({ biometricOff: false });
    } finally {
      restore();
    }
    await signs(wm, token); // the open session opens the stored payload
    const [p, b] = await copies();
    expect(b).toEqual(p); // written again
    const fresh = manager();
    expect((await fresh.unlockWithPassword(OLD_PW)).ok).toBe(false);
    const r = await fresh.unlockWithPassword(NEW_PW);
    expect(r.ok).toBe(true);
    await signs(fresh, r.token);
  });

  it('the rest failing again still leaves the change standing: the newer copy decides', async () => {
    const wm = manager();
    const token = await wm.storeWallet(walletB(), OLD_PW);
    const restore = failKeys([WalletManager.VAULT_BACKUP_KEY], 2);
    try {
      await wm.changePassword(OLD_PW, NEW_PW);
    } finally {
      restore();
    }
    await signs(wm, token);
    const [p, b] = await copies();
    expect(p.gen).toBeGreaterThan(b.gen);
    expect(p.pw.ct).not.toBe(b.pw.ct);
    wm.closeSession();
    expect((await manager().unlockWithPassword(OLD_PW)).ok).toBe(false);
    expect((await manager().unlockWithPassword(NEW_PW)).ok).toBe(true);
  });

  it('neither copy stored: the change is refused, the old password and the open session keep working', async () => {
    const wm = manager();
    const token = await wm.storeWallet(walletB(), OLD_PW);
    const before = await copies();
    const restore = failKeys([WalletManager.VAULT_KEY, WalletManager.VAULT_BACKUP_KEY]);
    try {
      await expect(wm.changePassword(OLD_PW, NEW_PW)).rejects.toThrow('Failed to write value.');
    } finally {
      restore();
    }
    expect(await copies()).toEqual(before);
    await signs(wm, token);
    expect((await manager().unlockWithPassword(NEW_PW)).ok).toBe(false);
    expect((await manager().unlockWithPassword(OLD_PW)).ok).toBe(true);
  });

  it('the iOS storage module drops a value whose file write failed, so a read after the error sees what is stored', () => {
    const fs = require('fs');
    const path = require('path');
    const patch = fs.readFileSync(path.join(__dirname, '..', 'patches', '@react-native-async-storage+async-storage+2.2.0.patch'), 'utf8');
    expect(patch).toMatch(/-    \[RCTGetCache\(\) setObject:value forKey:key cost:value\.length\];\r?\n     if \(error\) \{/);
    expect(patch).toMatch(/\+        \[RCTGetCache\(\) removeObjectForKey:key\];/);
    const pkg = require('../package.json');
    expect(pkg.scripts.postinstall).toBe('patch-package');
    expect(pkg.dependencies['@react-native-async-storage/async-storage']).toMatch(/2\.2\.0$/);
  });
});

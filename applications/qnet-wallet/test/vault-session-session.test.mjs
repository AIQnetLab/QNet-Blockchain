// Session, lock and backoff (CONTRACTS.md section 6; spec Session; R07, R08, EXT-SEC-09, M1, M4): the key
// lives in memory and in chrome.storage.session only, a mirror resumes only before its deadline, every
// lock path clears memory, mirror and alarm, the auto-lock setting lives in the vault, and the backoff is
// shared and survives a failing storage write.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KAT_EON, KAT_MNEMONIC, KAT_SOLANA, PASSWORD, fakeClock, loadWorker, rejectsWith, reset,
} from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, core, config } = w;
const { STORAGE_KEYS, AUTO_LOCK_ALARM } = config;

const WALLET_ID = '6f1c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const T0 = 2_000_000_000_000;
const MINUTE = 60000;

let env;
beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
  env.alarms = [];
  env.chrome.alarms.create = async (name, info) => {
    env.alarms.push({ op: 'create', name, when: info.when });
  };
  env.chrome.alarms.clear = async (name) => {
    env.alarms.push({ op: 'clear', name });
    return true;
  };
});
after(() => env?.unsubscribe());

const key = (fill = 7) => new Uint8Array(32).fill(fill);
const start = (vaultKey = key(), autoLockMinutes = 15) => session.startSession({
  vaultKey, walletId: WALLET_ID, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA, autoLockMinutes,
});
const mirror = () => env.chrome.storage.session.dump()[STORAGE_KEYS.SESSION];

let restarts = 0;
// The module as a restarted worker loads it: new module state, the same storage.
async function restartedSession() {
  restarts += 1;
  const fresh = await import(`../dist/background/session.js?restart=${restarts}`);
  const changes = [];
  fresh.onLockChange((change) => changes.push(change));
  return { fresh, changes };
}

function storedSession(overrides = {}) {
  return {
    v: 3, key: core.base64Encode(key(9)), walletId: WALLET_ID, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA,
    autoLockMinutes: 15, lockDeadline: Date.now() + 10 * MINUTE, ...overrides,
  };
}

describe('session: start and lock', () => {
  it('asks for TRUSTED_CONTEXTS on storage.session (and storage.local) at start', async () => {
    await session.initSession();
    assert.equal(env.chrome.storage.session.accessLevel(), 'TRUSTED_CONTEXTS');
    assert.equal(env.chrome.storage.local.accessLevel(), 'TRUSTED_CONTEXTS');
  });

  it('keeps the key in memory and the mirror, with the deadline, and arms one alarm', async () => {
    const clock = fakeClock(T0);
    try {
      const { lockDeadline } = await start();
      assert.equal(lockDeadline, T0 + 15 * MINUTE);
      assert.deepEqual(mirror(), {
        v: 3, key: core.base64Encode(key()), walletId: WALLET_ID, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA,
        autoLockMinutes: 15, lockDeadline,
      });
      assert.deepEqual(env.alarms, [{ op: 'create', name: AUTO_LOCK_ALARM, when: lockDeadline }]);
      assert.deepEqual(await session.requireUnlocked(),
        { walletId: WALLET_ID, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA, lockDeadline });
      assert.deepEqual(await session.getAddresses(), { qnet: KAT_EON, solana: KAT_SOLANA });
      assert.deepEqual(env.changes, [{ locked: false, reason: 'unlock' }]);
      assert.deepEqual(env.chrome.storage.local.dump(), {}, 'no unlock flag anywhere in storage.local (EXT-SEC-09)');
    } finally {
      clock.restore();
    }
  });

  it('refuses malformed input and zeroizes the key it was handed', async () => {
    const short = new Uint8Array(31).fill(5);
    await rejectsWith(session.startSession({ vaultKey: short, walletId: WALLET_ID, qnetAddress: KAT_EON,
      solanaAddress: KAT_SOLANA, autoLockMinutes: 15 }), 'INTERNAL');
    const good = key(5);
    await rejectsWith(session.startSession({ vaultKey: good, walletId: WALLET_ID, qnetAddress: KAT_EON,
      solanaAddress: KAT_SOLANA, autoLockMinutes: 0 }), 'INTERNAL');
    assert.deepEqual(good, new Uint8Array(32));
    assert.equal(await session.isUnlocked(), false);
  });

  it('lock zeroizes the key, clears memory, mirror and alarm, and tells every listener', async () => {
    const vaultKey = key();
    await start(vaultKey);
    env.alarms.length = 0;
    const reasons = [];
    const unsubscribe = session.onLockChange(() => {
      throw new Error('a broken listener does not stop the others');
    });
    const unsubscribe2 = session.onLockChange((change) => reasons.push(change.reason));
    try {
      for (const reason of ['user', 'timeout', 'idle', 'startup', 'wipe', 'error', 'nonsense']) await session.lock(reason);
    } finally {
      unsubscribe();
      unsubscribe2();
    }
    assert.deepEqual(vaultKey, new Uint8Array(32), 'the key buffer is zeroized');
    assert.equal(mirror(), undefined);
    assert.equal(await session.isUnlocked(), false);
    assert.deepEqual(env.alarms[0], { op: 'clear', name: AUTO_LOCK_ALARM });
    assert.deepEqual(reasons, ['user', 'timeout', 'idle', 'startup', 'wipe', 'error', 'error']);
    await rejectsWith(session.requireUnlocked(), 'LOCKED');
    await rejectsWith(session.getAddresses(), 'LOCKED');
    await rejectsWith(session.withVaultKey(() => 1), 'LOCKED');
    assert.deepEqual(await session.lockNow(), { locked: true });
  });

  it('lock never throws, even when storage and alarms fail (EXT-SEC-M1)', async () => {
    const vaultKey = key();
    await start(vaultKey);
    env.chrome.storage.session.remove = () => {
      throw new Error('storage gone');
    };
    env.chrome.alarms.clear = async () => {
      throw new Error('alarms gone');
    };
    await session.lock('user');
    assert.equal(await session.isUnlocked(), false);
    assert.deepEqual(vaultKey, new Uint8Array(32));
    assert.equal(env.changes.at(-1).reason, 'user');
  });

  it('a lock that overtakes a start wins: no unlock event, no mirror left', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const realSet = env.chrome.storage.session.set;
    env.chrome.storage.session.set = (items) => realSet(items).then(() => gate);
    const starting = start();
    await new Promise((resolve) => setImmediate(resolve));
    await session.lock('user');
    release();
    await rejectsWith(starting, 'LOCKED');
    assert.equal(mirror(), undefined);
    assert.deepEqual(env.changes.map((c) => c.reason), ['user']);
    assert.equal(await session.isUnlocked(), false);
  });

  it('locks when the mirror cannot be written', async () => {
    env.chrome.storage.session.set = async () => {
      throw new Error('quota');
    };
    const vaultKey = key();
    await rejectsWith(start(vaultKey), 'INTERNAL');
    assert.equal(await session.isUnlocked(), false);
    assert.deepEqual(vaultKey, new Uint8Array(32));
  });
});

describe('session: deadline', () => {
  it('locks at the deadline on the next privileged call, and touch extends only an unlocked session', async () => {
    const clock = fakeClock(T0);
    try {
      await start(key(), 5);
      clock.tick(4 * MINUTE);
      await session.touch();
      assert.equal(mirror().lockDeadline, T0 + 9 * MINUTE);
      assert.deepEqual(env.alarms.at(-1), { op: 'create', name: AUTO_LOCK_ALARM, when: T0 + 9 * MINUTE });
      clock.tick(5 * MINUTE - 1);
      assert.equal((await session.requireUnlocked()).lockDeadline, T0 + 9 * MINUTE);
      clock.tick(1);
      await rejectsWith(session.requireUnlocked(), 'LOCKED');
      assert.equal(env.changes.at(-1).reason, 'timeout');
      assert.equal(mirror(), undefined);
      await session.touch();
      assert.equal(mirror(), undefined, 'touch never revives a locked session');
    } finally {
      clock.restore();
    }
  });

  it('treats a deadline further ahead than the auto-lock allows as a clock that went back', async () => {
    const clock = fakeClock(T0);
    try {
      await start(key(), 15);
      clock.set(T0 - 60 * MINUTE);
      await rejectsWith(session.requireUnlocked(), 'LOCKED');
    } finally {
      clock.restore();
    }
  });

  it('the alarm locks after the deadline and re-arms before it; other alarms are ignored', async () => {
    const clock = fakeClock(T0);
    try {
      const { lockDeadline } = await start(key(), 15);
      await session.onAlarm({ name: 'something-else' });
      await session.onAlarm({ name: AUTO_LOCK_ALARM });
      assert.equal(await session.isUnlocked(), true);
      assert.deepEqual(env.alarms.at(-1), { op: 'create', name: AUTO_LOCK_ALARM, when: lockDeadline });
      clock.set(lockDeadline - 500);
      await session.onAlarm({ name: AUTO_LOCK_ALARM });
      assert.equal(await session.isUnlocked(), false, 'an alarm a moment early still locks');
      assert.equal(env.changes.at(-1).reason, 'timeout');
      const count = env.changes.length;
      await session.onAlarm({ name: AUTO_LOCK_ALARM });
      assert.equal(env.changes.length, count, 'a stale alarm with no session emits nothing');
    } finally {
      clock.restore();
    }
  });

  it('locks on the idle state "locked" only', async () => {
    await start();
    await session.onIdleState('idle');
    await session.onIdleState('active');
    assert.equal(await session.isUnlocked(), true);
    await session.onIdleState('locked');
    assert.equal(await session.isUnlocked(), false);
    assert.equal(env.changes.at(-1).reason, 'idle');
  });
});

// Owner, 28.09: auto-lock Never. No deadline and no alarm; the wallet still locks on Lock, on the OS screen lock and when
// the browser closes (chrome.storage.session is gone then, and runtime.onStartup locks).
describe('session: auto-lock Never', () => {
  it('has no deadline and no alarm, never times out, and still locks on Lock and the screen lock', async () => {
    const clock = fakeClock(T0);
    try {
      const { lockDeadline } = await start(key(), 'never');
      assert.equal(lockDeadline, null);
      assert.equal(mirror().autoLockMinutes, 'never');
      assert.equal(mirror().lockDeadline, null);
      assert.deepEqual(env.alarms, [{ op: 'clear', name: AUTO_LOCK_ALARM }], 'no alarm armed, a previous one cleared');
      clock.tick(365 * 24 * 60 * MINUTE);
      assert.equal((await session.requireUnlocked()).lockDeadline, null, 'a year later: still unlocked');
      await session.touch();
      assert.equal(mirror().lockDeadline, null, 'activity sets no deadline');
      assert.ok(env.alarms.every((entry) => entry.op === 'clear'), 'never an alarm');
      await session.onAlarm({ name: AUTO_LOCK_ALARM });
      assert.equal(await session.isUnlocked(), true, 'a stale alarm does not lock it');
      await session.lockNow();
      assert.equal(await session.isUnlocked(), false);
      assert.equal(mirror(), undefined);
      await start(key(), 'never');
      await session.onIdleState('locked');
      assert.equal(await session.isUnlocked(), false, 'the OS screen lock still locks');
      assert.equal(env.changes.at(-1).reason, 'idle');
    } finally {
      clock.restore();
    }
  });

  it('switches between a time and Never at once, both ways, and keeps the choice in the vault', async () => {
    const clock = fakeClock(T0);
    try {
      await vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
      assert.deepEqual(await session.setSettings({ autoLockMinutes: 'never' }), { autoLockMinutes: 'never', language: 'en' });
      assert.equal((await vault.readState()).settings.autoLockMinutes, 'never');
      assert.equal(mirror().lockDeadline, null);
      assert.deepEqual(env.alarms.at(-1), { op: 'clear', name: AUTO_LOCK_ALARM });
      await session.lock('user');
      assert.equal((await vault.unlock({ password: PASSWORD })).lockDeadline, null, 'the next unlock uses Never');
      clock.tick(MINUTE);
      await session.setSettings({ autoLockMinutes: 5 });
      assert.equal(mirror().lockDeadline, T0 + MINUTE + 5 * MINUTE);
      assert.deepEqual(env.alarms.at(-1), { op: 'create', name: AUTO_LOCK_ALARM, when: T0 + MINUTE + 5 * MINUTE });
      clock.tick(5 * MINUTE);
      await rejectsWith(session.requireUnlocked(), 'LOCKED');
      for (const value of ['Never', 'NEVER', '', true]) {
        await rejectsWith(session.setSettings({ autoLockMinutes: value }), 'INVALID_PARAMS');
      }
    } finally {
      clock.restore();
    }
  });

  it('a restarted worker resumes a Never session; a deadline that does not match its choice is refused', async () => {
    await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: storedSession({ autoLockMinutes: 'never', lockDeadline: null }) });
    const { fresh, changes } = await restartedSession();
    await fresh.initSession();
    assert.equal((await fresh.requireUnlocked()).lockDeadline, null);
    assert.deepEqual(changes, []);
    const bad = {
      'Never with a deadline': storedSession({ autoLockMinutes: 'never', lockDeadline: Date.now() + MINUTE }),
      'a time without a deadline': storedSession({ lockDeadline: null }),
      'Never spelled otherwise': storedSession({ autoLockMinutes: 'Never', lockDeadline: null }),
    };
    for (const [name, stored] of Object.entries(bad)) {
      await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: stored });
      const restarted = await restartedSession();
      assert.equal(await restarted.fresh.isUnlocked(), false, name);
      assert.equal(mirror(), undefined, name);
    }
  });
});

describe('session: a restarted worker', () => {
  it('resumes a stored session only while its deadline is ahead', async () => {
    await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: storedSession() });
    const { fresh, changes } = await restartedSession();
    await fresh.initSession();
    const info = await fresh.requireUnlocked();
    assert.equal(info.walletId, WALLET_ID);
    assert.deepEqual(await fresh.withVaultKey((k) => k.slice()), key(9));
    assert.deepEqual(changes, [], 'resuming is not a new unlock');

    await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: storedSession({ lockDeadline: Date.now() - 1 }) });
    const expired = await restartedSession();
    await rejectsWith(expired.fresh.requireUnlocked(), 'LOCKED');
    assert.equal(mirror(), undefined, 'the expired mirror is cleared');
    assert.deepEqual(expired.changes, [{ locked: true, reason: 'timeout' }]);
  });

  it('refuses a malformed or implausible mirror', async () => {
    const bad = {
      'extra key': storedSession({ unlocked: true }),
      'short key': storedSession({ key: core.base64Encode(new Uint8Array(31)) }),
      'bad address': storedSession({ qnetAddress: 'x' }),
      'auto-lock outside the choices': storedSession({ autoLockMinutes: 1440, lockDeadline: Date.now() + 1000 * MINUTE }),
      'deadline beyond the auto-lock': storedSession({ lockDeadline: Date.now() + 120 * MINUTE }),
      'version': storedSession({ v: 2 }),
    };
    for (const [name, stored] of Object.entries(bad)) {
      await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: stored });
      const { fresh } = await restartedSession();
      assert.equal(await fresh.isUnlocked(), false, name);
      assert.equal(mirror(), undefined, name);
    }
  });

  it('a lock before the restore (runtime.onStartup) leaves nothing to resume', async () => {
    await env.chrome.storage.session.set({ [STORAGE_KEYS.SESSION]: storedSession() });
    const { fresh, changes } = await restartedSession();
    await fresh.lock('startup');
    await fresh.initSession();
    assert.equal(await fresh.isUnlocked(), false);
    assert.equal(mirror(), undefined);
    assert.deepEqual(changes, [{ locked: true, reason: 'startup' }]);
  });
});

describe('session: vault key handling', () => {
  it('lends a copy of the key and zeroizes it after use', async () => {
    await start(key(3));
    let lent;
    const result = await session.withVaultKey((k) => {
      lent = k;
      k.fill(1);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(lent, new Uint8Array(32), 'the copy is zeroized afterwards');
    assert.deepEqual(await session.withVaultKey((k) => k.slice()), key(3), 'the session key is untouched');
  });

  it('replaces the key after a password change, zeroizing the old one', async () => {
    const old = key(3);
    const { lockDeadline } = await start(old);
    await session.replaceVaultKey(key(4));
    assert.deepEqual(old, new Uint8Array(32));
    assert.equal(mirror().key, core.base64Encode(key(4)));
    assert.equal(mirror().lockDeadline, lockDeadline);
    await session.lock('user');
    const orphan = key(6);
    await rejectsWith(session.replaceVaultKey(orphan), 'LOCKED');
    assert.deepEqual(orphan, new Uint8Array(32));
  });
});

describe('session: settings', () => {
  it('reads the language from storage.local by allow-list and the auto-lock from the session', async () => {
    assert.deepEqual(await session.getSettings(), { autoLockMinutes: null, language: 'en' });
    for (const stored of [{ language: 'xx' }, { language: 'en', autoLock: 'never' }, 'en', null]) {
      await env.chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: stored });
      assert.equal((await session.getSettings()).language, 'en');
    }
    await start(key(), 30);
    assert.equal((await session.getSettings()).autoLockMinutes, 30);
  });

  it('stores the auto-lock inside the vault and applies it at once (EXT-SEC-M4)', async () => {
    const clock = fakeClock(T0);
    try {
      await rejectsWith(session.setSettings({ autoLockMinutes: 5 }), 'LOCKED');
      await vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
      clock.tick(MINUTE);
      assert.deepEqual(await session.setSettings({ autoLockMinutes: 60 }), { autoLockMinutes: 60, language: 'en' });
      assert.equal((await vault.readState()).settings.autoLockMinutes, 60);
      assert.equal(mirror().autoLockMinutes, 60);
      assert.equal(mirror().lockDeadline, T0 + MINUTE + 60 * MINUTE);
      assert.deepEqual(env.chrome.storage.local.dump(), {}, 'no security setting in storage.local');
      await session.setSettings({ language: 'en' });
      assert.deepEqual(env.chrome.storage.local.dump(), { [STORAGE_KEYS.SETTINGS]: { language: 'en' } });
      await rejectsWith(session.setSettings({ autoLockMinutes: 0 }), 'INVALID_PARAMS');
      await rejectsWith(session.setSettings({ language: 'xx' }), 'INVALID_PARAMS');
      await session.lock('user');
      const { lockDeadline } = await vault.unlock({ password: PASSWORD });
      assert.equal(lockDeadline, T0 + MINUTE + 60 * MINUTE, 'the next unlock uses the stored choice');
    } finally {
      clock.restore();
    }
  });
});

describe('session: password backoff', () => {
  it('has three free attempts, then 1 s doubling up to 5 min', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 12, 13, 14, 100].map((n) => session.backoffDelayMs(n));
    assert.deepEqual(delays, [0, 0, 0, 0, 1000, 2000, 4000, 256000, 300000, 300000, 300000]);
    for (const n of [-1, 1.5, NaN, '4']) assert.equal(session.backoffDelayMs(n), 0);
    assert.equal(session.isAutoLockChoice(15), true);
    assert.equal(session.isAutoLockChoice('never'), true);
    assert.equal(session.isAutoLockChoice(0), false);
    assert.equal(session.isAutoLockChoice('15'), false);
  });

  it('stores failures in storage.session and keeps counting in memory when the write fails', async () => {
    const clock = fakeClock(T0);
    try {
      for (let i = 0; i < 4; i += 1) await session.recordPasswordFailure();
      assert.deepEqual(env.chrome.storage.session.dump()[STORAGE_KEYS.BACKOFF], { failures: 4, until: T0 + 1000 });
      const error = await rejectsWith(session.checkBackoff(), 'BACKOFF');
      assert.equal(error.retryAfterMs, 1000);
      assert.equal(await session.getBackoffUntil(), T0 + 1000);
      clock.tick(1000);
      await session.checkBackoff();
      env.chrome.storage.session.set = async () => {
        throw new Error('storage gone');
      };
      await session.recordPasswordFailure();
      await rejectsWith(session.checkBackoff(), 'BACKOFF');
      await session.recordPasswordSuccess();
      assert.equal(await session.getBackoffUntil(), null);
      await session.checkBackoff();
    } finally {
      clock.restore();
    }
  });

  it('caps a stored wait at five minutes, so a clock set back cannot lock the user out', async () => {
    const clock = fakeClock(T0);
    try {
      await env.chrome.storage.session.set({ [STORAGE_KEYS.BACKOFF]: { failures: 9, until: T0 + 24 * 60 * MINUTE } });
      const error = await rejectsWith(session.checkBackoff(), 'BACKOFF');
      assert.equal(error.retryAfterMs, 300000);
      await env.chrome.storage.session.set({ [STORAGE_KEYS.BACKOFF]: { failures: 'x', until: -5 } });
      await session.checkBackoff();
    } finally {
      clock.restore();
    }
  });
});

// The popup's view cache (decision 39): public answers of this session only, in memory and storage.session, bound to the
// session's wallet, dropped by every lock and every new session.
describe('session: the view cache', () => {
  const BALANCE = { balanceNano: '12500000000', spendableNano: '12500000000', nonce: '3', verified: true, verification: 'proof', blockHeight: 9 };
  const NONE = { qnetBalance: null, qnetHistory: null, solanaBalances: null, solanaHistory: null, qnetTokens: null };
  const stored = () => env.chrome.storage.session.dump()[STORAGE_KEYS.VIEW_CACHE];

  // the views kept only for the session (the history pages); the balances kept across sessions, in the vault's chain
  // cache, are tested with a vault (vault-session-vault: the chain cache)
  it('keeps each view of the session, for its wallet, and a restarted worker reads it back', async () => {
    const HISTORY = { items: [], cursor: null, pending: [] };
    await start();
    assert.deepEqual(await session.cachedViews(), NONE);
    await session.rememberView('qnetHistory', HISTORY);
    await session.rememberView('solanaHistory', { items: [], cursor: null });
    assert.deepEqual(await session.cachedViews(), { ...NONE, qnetHistory: HISTORY, solanaHistory: { items: [], cursor: null } });
    assert.deepEqual(stored(), { walletId: WALLET_ID, values: { qnetHistory: HISTORY, solanaHistory: { items: [], cursor: null } } });
    await assert.rejects(session.rememberView('secret', 'x'), TypeError);
    const { fresh } = await restartedSession();
    assert.deepEqual((await fresh.cachedViews()).qnetHistory, HISTORY);
    // a stored cache of another wallet is never read as this one's
    await env.chrome.storage.session.set({ [STORAGE_KEYS.VIEW_CACHE]: { ...stored(), walletId: '00000000-0000-4000-8000-000000000000' } });
    const other = await restartedSession();
    assert.deepEqual(await other.fresh.cachedViews(), NONE);
  });

  it('every lock and every new session drop it; nothing is kept or read while locked', async () => {
    await start();
    await session.rememberView('qnetHistory', { items: [], cursor: null, pending: [] });
    await session.lock('user');
    assert.equal(stored(), undefined, 'gone from storage.session with the lock');
    await rejectsWith(session.cachedViews(), 'LOCKED');
    await session.rememberView('qnetBalance', BALANCE);
    assert.equal(stored(), undefined, 'nothing kept while locked');
    await start(key(8));
    assert.deepEqual(await session.cachedViews(), NONE, 'a new session starts empty');
  });
});

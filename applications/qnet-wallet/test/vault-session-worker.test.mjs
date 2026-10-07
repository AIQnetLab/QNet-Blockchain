// Worker wiring of the vault-session area (sw.js; R08, R16, R17, EXT-SEC-M1): the listeners lock on
// browser start, screen lock and the auto-lock alarm; every lock change reaches the open extension pages; the
// router serves the area's handlers. Runs offline: fetch fails.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageSender, until } from './helpers/chrome-mock.mjs';
import { KAT_MNEMONIC, PASSWORD, fakeClock, loadWorker, rejectsWith } from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, config } = w;
const { VIEW_EVENT_CHANNEL, AUTO_LOCK_ALARM } = config;

const fetches = [];
const realFetch = globalThis.fetch;
const { chrome } = globalThis;
const WAIT_MS = 20000;

before(async () => {
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    throw new TypeError('offline test');
  };
  await import('../dist/background/sw.js');
  await session.initSession();
});
after(() => {
  globalThis.fetch = realFetch;
});

// Page events are {channel, event, data}; other areas broadcast too (provider: 'approval').
const viewEvents = () => chrome.runtime.sent.filter((m) => m.channel === VIEW_EVENT_CHANNEL).map((m) => m.event);

/** Runs `action` and waits until the pages were sent `event` after it. */
async function expectEvent(event, action) {
  const mark = viewEvents().length;
  const result = await action();
  try {
    await until(() => viewEvents().slice(mark).includes(event), WAIT_MS);
  } catch {
    assert.fail(`expected the pages to get ${event}; events since: ${viewEvents().slice(mark).join(', ')}`);
  }
  return result;
}

const unlock = () => expectEvent('unlocked', () => vault.unlock({ password: PASSWORD }));

describe('worker wiring', () => {
  it('asked for trusted-only session storage at start', () => {
    assert.equal(chrome.storage.session.accessLevel(), 'TRUSTED_CONTEXTS');
  });

  it('locks on browser start, screen lock and the alarm, and tells the pages each time', async () => {
    await expectEvent('unlocked', () => vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD }));

    await expectEvent('locked', () => chrome.runtime.onStartup.dispatch());
    assert.equal(await session.isUnlocked(), false);

    await unlock();
    await expectEvent('locked', () => chrome.idle.onStateChanged.dispatch('locked'));
    assert.equal(await session.isUnlocked(), false);

    const clock = fakeClock(Date.now());
    try {
      const { lockDeadline } = await unlock();
      clock.set(lockDeadline);
      await expectEvent('locked', () => chrome.alarms.onAlarm.dispatch({ name: AUTO_LOCK_ALARM }));
      await rejectsWith(session.requireUnlocked(), 'LOCKED');
    } finally {
      clock.restore();
    }
  });

  it('the router serves the vault-session handlers, and their results pass its guard', async () => {
    const call = (page, type, params) => new Promise((resolve) => {
      chrome.runtime.onMessage.dispatch({ type, id: 'r1', params }, pageSender(chrome.runtime, page), resolve);
    });
    const status = await call('popup', 'vault.status');
    assert.equal(status.ok, true);
    assert.equal(status.result.exists, true);
    assert.deepEqual(await call('popup', 'vault.lock'), { id: 'r1', ok: true, result: { locked: true } });
    const unlocked = await call('approve', 'vault.unlock', { password: PASSWORD });
    assert.equal(unlocked.ok, true);
    assert.deepEqual(Object.keys(unlocked.result).sort(), ['lockDeadline', 'qnet', 'solana']);
    assert.deepEqual((await call('popup', 'vault.reveal', { password: PASSWORD })).result, { mnemonic: KAT_MNEMONIC });
    assert.deepEqual((await call('popup', 'settings.set', { autoLockMinutes: 30 })).result, { autoLockMinutes: 30, language: 'en' });
    // auto-lock Never passes the router's allow-list; the unlock result then carries no deadline
    assert.deepEqual((await call('popup', 'settings.set', { autoLockMinutes: 'never' })).result, { autoLockMinutes: 'never', language: 'en' });
    const never = (await call('popup', 'vault.status')).result;
    assert.deepEqual([never.unlocked, never.lockDeadline], [true, null]);
    assert.deepEqual((await call('popup', 'settings.set', { autoLockMinutes: 30 })).result, { autoLockMinutes: 30, language: 'en' });
    assert.equal((await call('popup', 'wallet.addresses')).ok, true);
    assert.equal((await call('popup', 'vault.changePassword', { password: PASSWORD, newPassword: 'short' })).error.code,
      'WEAK_PASSWORD');
    const wrong = await call('popup', 'vault.unlock', { password: 'not the password' });
    assert.deepEqual(wrong.error, { code: 'BAD_PASSWORD', message: 'Wrong password' });
  });

  it('a wipe reaches the pages as "wiped"', async () => {
    await expectEvent('wiped', () => vault.wipe({ password: PASSWORD, confirm: 'DELETE' }));
    // The only fetch is the worker reading its own bundle for the self-test cache key.
    const own = chrome.runtime.getURL('lib/qnet-core.js');
    assert.deepEqual(fetches.filter((url) => url !== own), [], 'nothing went to the network');
  });
});

// One lockout for every password check, kept in the Keychain and timed on the boot clock: moving the wall
// clock back never shortens it, a reboot restarts the remaining wait in full, and parallel guesses cannot
// slip past it.
const { createPasswordLimiter, lockoutMs, MAX_LOCKOUT_MS, UNREADABLE_FAILURES } = require('../src/utils/passwordLimiter');

function rig({ mono = 1_000_000, wall = 1_790_000_000_000 } = {}) {
  const clock = { mono, wall };
  let saved = null;
  const make = () => createPasswordLimiter({
    load: async () => (saved ? JSON.parse(saved) : null),
    save: async (s) => { saved = JSON.stringify(s); },
    clock: async () => ({ ...clock }),
  });
  const advance = (ms) => { clock.mono += ms; clock.wall += ms; };
  return { limiter: make(), reload: make, clock, advance };
}

const wrong = async () => false;
const right = async () => true;

// n wrong passwords, each after any lockout the previous one started has run out.
async function failTimes(r, n) {
  for (let i = 0; i < n; i++) {
    const s = await r.limiter.status();
    if (s.locked) r.advance(s.remainingMs + 1);
    await r.limiter.check(wrong);
  }
}

it('two free attempts, then 1 s from the third, doubling up to 30 minutes', () => {
  expect([0, 1, 2].map(lockoutMs)).toEqual([0, 0, 0]);
  expect([3, 4, 5, 6].map(lockoutMs)).toEqual([1000, 2000, 4000, 8000]);
  expect(lockoutMs(40)).toBe(MAX_LOCKOUT_MS);
});

it('locks after repeated failures, refuses without checking while locked, and a success resets', async () => {
  const { limiter, advance } = rig();
  expect(await limiter.check(wrong)).toMatchObject({ ok: false, locked: false, attempts: 1 });
  expect(await limiter.check(wrong)).toMatchObject({ ok: false, locked: false, attempts: 2 });
  expect(await limiter.check(wrong)).toMatchObject({ ok: false, locked: true, remainingMs: 1000, attempts: 3 });
  const verify = jest.fn(right);
  expect(await limiter.check(verify)).toMatchObject({ ok: false, locked: true });
  expect(verify).not.toHaveBeenCalled();
  advance(1001);
  expect(await limiter.check(wrong)).toMatchObject({ locked: true, remainingMs: 2000, attempts: 4 });
  advance(2001);
  expect(await limiter.check(right)).toEqual({ ok: true });
  expect(await limiter.status()).toMatchObject({ locked: false, attempts: 0 });
});

it('moving the wall clock back does not shorten a lockout', async () => {
  const r = rig();
  await failTimes(r, 8);                                           // 32 s lockout
  r.clock.wall -= 3600_000;                                        // the user sets the clock back an hour
  const s = await r.limiter.status();
  expect(s.locked).toBe(true);
  expect(s.remainingMs).toBe(32_000);                              // restarted in full, never shorter
});

it('survives a restart of the app and restarts the remaining wait in full after a reboot', async () => {
  const r = rig();
  await failTimes(r, 6);                                           // 8 s lockout
  r.advance(5000);
  // The app restarts: same boot, the stored state still locks for the rest.
  expect((await r.reload().status()).remainingMs).toBe(3000);
  // A reboot: the boot clock starts again from zero.
  r.clock.mono = 10_000;
  r.clock.wall += 60_000;
  expect(await r.reload().status()).toMatchObject({ locked: true, remainingMs: 8000, attempts: 6 });
});

it('parallel guesses are checked one at a time', async () => {
  const r = rig();
  await failTimes(r, 3);
  r.advance(1001);
  const verifyRight = jest.fn(right);
  const [first, second] = await Promise.all([r.limiter.check(wrong), r.limiter.check(verifyRight)]);
  expect(first).toMatchObject({ ok: false, locked: true, attempts: 4 });
  expect(second).toMatchObject({ ok: false, locked: true });
  expect(verifyRight).not.toHaveBeenCalled();
});

it('a lost device key is reported, not counted as a wrong password', async () => {
  const { limiter } = rig();
  const gone = Object.assign(new Error('device key gone'), { uncounted: true });
  await expect(limiter.check(async () => { throw gone; })).rejects.toBe(gone);
  expect((await limiter.status()).attempts).toBe(0);
  await limiter.check(async () => { throw new Error('bad tag'); });
  expect((await limiter.status()).attempts).toBe(1);
});

it('carries the failure count of the older AsyncStorage counter over, never lowering it', async () => {
  const { limiter } = rig();
  await limiter.seed(5);
  expect((await limiter.status()).attempts).toBe(5);
  await limiter.seed(2);
  expect((await limiter.status()).attempts).toBe(5);
  expect(await limiter.check(wrong)).toMatchObject({ locked: true, attempts: 6 });
});

// MVA-R2-01: the lockout fails closed.
it('a check whose failure cannot be written first is refused without checking the password', async () => {
  const verify = jest.fn(right);
  const limiter = createPasswordLimiter({
    load: async () => null,
    save: async () => { throw new Error('ENOSPC'); },
    clock: async () => ({ mono: 1, wall: 2 }),
  });
  expect(await limiter.check(verify)).toEqual({ ok: false, locked: false, remainingMs: 0, attempts: 0, unrecorded: true });
  expect(verify).not.toHaveBeenCalled();
});

it('the failure is on storage before the password is checked, so a restart mid-check keeps it', async () => {
  const r = rig();
  await failTimes(r, 2);
  let seenDuringCheck = null;
  let savedNow = null;
  const limiter = createPasswordLimiter({
    load: async () => (savedNow ? JSON.parse(savedNow) : { failures: 2, until: 0, lockMs: 0, boot: 0 }),
    save: async (s) => { savedNow = JSON.stringify(s); },
    clock: async () => ({ ...r.clock }),
  });
  await limiter.check(async () => { seenDuringCheck = JSON.parse(savedNow); return false; });
  expect(seenDuringCheck).toMatchObject({ failures: 3, lockMs: 1000 });
});

it('a thief whose storage refuses writes gets no free guesses per restart', async () => {
  const r = rig();
  let writable = false;
  let stored = { failures: 3, until: 0, lockMs: 0, boot: 0 };     // three wrong passwords so far
  const make = () => createPasswordLimiter({
    load: async () => stored,
    save: async (s) => { if (!writable) throw new Error('ENOSPC'); stored = s; },
    clock: async () => ({ ...r.clock }),
  });
  writable = true;
  await make().check(wrong);                                      // 4 failures
  writable = false;                                               // storage fills up
  const verify = jest.fn(wrong);
  for (let restart = 0; restart < 5; restart++) {
    r.advance(10 * 60_000);
    expect(await make().check(verify)).toMatchObject({ ok: false, unrecorded: true });
  }
  expect(verify).not.toHaveBeenCalled();
  expect(stored.failures).toBe(4);
});

it('a stored state that cannot be read counts as the most failures, not as none', async () => {
  const saves = [];
  const limiter = createPasswordLimiter({
    load: async () => { throw new Error('keychain unavailable'); },
    save: async (s) => { saves.push(s); },
    clock: async () => ({ mono: 1, wall: 2 }),
  });
  expect(await limiter.status()).toMatchObject({ locked: false, attempts: UNREADABLE_FAILURES });
  expect(await limiter.check(wrong)).toMatchObject({ ok: false, locked: true, remainingMs: MAX_LOCKOUT_MS });
  // A right password (after the wait) resets it.
  const later = createPasswordLimiter({
    load: async () => { throw new Error('keychain unavailable'); },
    save: async (s) => { saves.push(s); },
    clock: async () => ({ mono: 1, wall: 2 }),
  });
  expect(await later.check(right)).toEqual({ ok: true });
  expect(saves[saves.length - 1]).toMatchObject({ failures: 0 });
});

it('an uncounted error gives the charged failure back', async () => {
  const r = rig();
  await failTimes(r, 1);
  const gone = Object.assign(new Error('device key gone'), { uncounted: true });
  await expect(r.limiter.check(async () => { throw gone; })).rejects.toBe(gone);
  expect((await r.reload().status()).attempts).toBe(1);
});

// MOBAUTH-R4-01: iOS refuses the read of a phone that is locked (the app woke in the background) only for now. That is
// no answer: nothing is kept, the next call reads the item again, and the free attempts are still there.
it('a read refused only for now is not taken as unreadable, and the next call reads again', async () => {
  let locked = true;
  let saved = JSON.stringify({ failures: 0, until: 0, lockMs: 0, boot: 0 });
  const verify = jest.fn(right);
  const limiter = createPasswordLimiter({
    load: async () => {
      if (locked) throw Object.assign(new Error('not now'), { notNow: true });
      return JSON.parse(saved);
    },
    save: async (s) => { if (locked) throw Object.assign(new Error('not now'), { notNow: true }); saved = JSON.stringify(s); },
    clock: async () => ({ mono: 1_000, wall: 1_790_000_000_000 }),
  });
  const s = await limiter.status();
  expect(s).toMatchObject({ locked: false, unknown: true, notNow: true });
  expect(s.attempts).toBeUndefined();
  // A check while the read is refused runs nothing and charges nothing.
  expect(await limiter.check(verify)).toMatchObject({ ok: false, unrecorded: true, notNow: true });
  expect(verify).not.toHaveBeenCalled();
  locked = false;
  // The phone is unlocked: the stored count is read, and one wrong password is one of the three free attempts.
  expect(await limiter.status()).toMatchObject({ locked: false, attempts: 0 });
  expect(await limiter.check(wrong)).toMatchObject({ ok: false, locked: false, attempts: 1 });
  expect(JSON.parse(saved).failures).toBe(1);
});

it('a stored lockout read after a refusal still locks', async () => {
  let refusals = 1;
  const limiter = createPasswordLimiter({
    load: async () => {
      if (refusals-- > 0) throw Object.assign(new Error('not now'), { notNow: true });
      return { failures: 9, until: 1_000 + 64_000, lockMs: 64_000, boot: 1_790_000_000_000 - 1_000 };
    },
    save: async () => {},
    clock: async () => ({ mono: 1_000, wall: 1_790_000_000_000 }),
  });
  expect((await limiter.status()).unknown).toBe(true);
  expect(await limiter.check(right)).toMatchObject({ ok: false, locked: true, remainingMs: 64_000, attempts: 9 });
});

/**
 * One lockout for every password check: unlock, reveal, password change, biometric enrolment, delete.
 *
 * The failure count and the end of the lockout live in the Keychain, not in AsyncStorage. The end is measured
 * on the clock that counts from boot, which the user cannot set: moving the wall clock back never shortens a
 * lockout. A reboot, or a wall clock that jumped, restarts the remaining wait in full instead of dropping it.
 *
 * It fails closed. A failure is written before the password is checked, and a check whose failure cannot be
 * written is not run: a device that refuses the write (full storage, a broken Keychain) never turns the lockout
 * into free guesses per restart. A stored state that exists but cannot be read counts as the most failures, so
 * each try waits the longest lockout until a right password resets it.
 *
 * A read the device refused only for the moment (iOS: the phone is locked while the app runs in the background) is
 * no answer: `load` throws an error marked `notNow`, nothing is kept, and the next call reads the item again. Until
 * then a status says `unknown` and a check is refused without running, as one whose failure cannot be written.
 */

export const FREE_ATTEMPTS = 3;
export const MAX_LOCKOUT_MS = 30 * 60_000;
const BOOT_TOLERANCE_MS = 5_000;

/** The wait after `failures` wrong passwords: none for the first three, then 1 s doubling to 30 minutes. */
export function lockoutMs(failures) {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(1000 * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
}

const EMPTY = { failures: 0, until: 0, lockMs: 0, boot: 0 };
// The failure count an unreadable stored state stands for: every wrong password from there locks the maximum.
export const UNREADABLE_FAILURES = FREE_ATTEMPTS + 11;

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return { failures: Math.floor(n(raw.failures)), until: n(raw.until), lockMs: n(raw.lockMs), boot: n(raw.boot) };
}

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.load   reads the stored state
 * @param {(state: object) => Promise<void>} deps.save  writes it
 * @param {() => Promise<{mono: number, wall: number}>} deps.clock  ms since boot, and wall-clock ms
 */
export function createPasswordLimiter({ load, save, clock }) {
  let state = null;
  let queue = Promise.resolve();

  // Checks run one at a time, so two parallel guesses cannot both slip past one lockout.
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function now() {
    if (!state) {
      try {
        state = normalize(await load());
      } catch (e) {
        if (e && e.notNow) throw e;
        state = { ...EMPTY, failures: UNREADABLE_FAILURES };
      }
    }
    const { mono, wall } = await clock();
    const boot = wall - mono;
    if (state.lockMs > 0 && Math.abs(boot - state.boot) > BOOT_TOLERANCE_MS) {
      state = { ...state, until: mono + state.lockMs, boot };
      await persist();
    }
    return mono;
  }

  // A write that may fail without harm: the stricter state is already in memory, and anything that relaxes the
  // lockout never depends on it.
  async function persist() {
    try { await save({ ...state }); } catch (_) { /* the in-memory state still holds for this session */ }
  }

  const failureAt = (failures, mono, wall) => {
    const lockMs = lockoutMs(failures);
    return { failures, lockMs, until: lockMs > 0 ? mono + lockMs : 0, boot: wall - mono };
  };

  async function statusNow() {
    const mono = await now();
    const remainingMs = Math.max(0, state.until - mono);
    return { locked: remainingMs > 0, remainingMs, attempts: state.failures };
  }

  // A read refused for the moment answers `answer` instead; any other error is thrown on.
  const unlessNotNow = (fn, answer) => async () => {
    try {
      return await fn();
    } catch (e) {
      if (e && e.notNow) return { ...answer };
      throw e;
    }
  };
  const UNKNOWN = { locked: false, remainingMs: 0, unknown: true, notNow: true };
  const REFUSED = { ok: false, locked: false, remainingMs: 0, unknown: true, notNow: true, unrecorded: true };

  return {
    status: () => serial(unlessNotNow(statusNow, UNKNOWN)),

    /**
     * Runs `verify` unless locked. Returns { ok: true } or { ok: false, locked, remainingMs, attempts }, and
     * { ok: false, unrecorded: true, … } without running `verify` when the failure it would count cannot be
     * written first, or the stored count cannot be read right now (`unknown`, `notNow`). A `verify` that throws
     * counts as a wrong password, except an error marked `uncounted` (a device key that is gone says nothing about
     * the password), which is rethrown with the count given back.
     */
    check: (verify) => serial(async () => {
      const before = await unlessNotNow(statusNow, REFUSED)();
      if (before.unknown) return before;
      if (before.locked) return { ok: false, ...before };
      const previous = { ...state };
      const t0 = await clock();
      const charged = failureAt(previous.failures + 1, t0.mono, t0.wall);
      try {
        await save({ ...charged });
      } catch (_) {
        return { ok: false, locked: false, remainingMs: 0, attempts: previous.failures, unrecorded: true };
      }
      state = charged;
      let ok = false;
      try {
        ok = (await verify()) === true;
      } catch (e) {
        if (e && e.uncounted) {
          state = previous;
          await persist();
          throw e;
        }
        ok = false;
      }
      const { mono, wall } = await clock();
      if (ok) {
        state = { ...EMPTY };
        await persist();
        return { ok: true };
      }
      // The wait runs from the answer, not from the start of the check.
      state = failureAt(charged.failures, mono, wall);
      await persist();
      const remainingMs = Math.max(0, state.until - mono);
      return { ok: false, locked: remainingMs > 0, remainingMs, attempts: state.failures };
    }),

    /** Carries a failure count over from older storage, never lowering the current one. */
    seed: (failures) => serial(async () => {
      await now();
      const f = Math.floor(Number(failures) || 0);
      if (f > state.failures) {
        state = { ...state, failures: f };
        await persist();
      }
    }),

    /** Forget everything (wallet deleted). */
    reset: () => serial(async () => { state = { ...EMPTY }; await persist(); }),
  };
}

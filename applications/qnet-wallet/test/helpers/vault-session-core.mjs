// The real qnet-core bundle with two stand-ins: argon2idAsync runs Argon2id at a few KiB instead of the
// vault's 64 MiB (see vault-session-loader.mjs), and selfTest is the real one, counted, which a test can
// make fail as a broken bundle would. The Argon2id stand-in still depends on m, t, p and the salt, so a
// record whose KDF parameters change derives a different key, and it records every call.
import * as real from '../../dist/lib/qnet-core.js';

export * from '../../dist/lib/qnet-core.js';
export default real.default;

export const kdfCalls = [];
// kdfControl.during: an async step run while a KDF call is in progress (a test locks the screen there).
export const kdfControl = { during: null };

export async function argon2idAsync(password, salt, options) {
  kdfCalls.push({ m: options.m, t: options.t, p: options.p, dkLen: options.dkLen, saltBytes: salt.length });
  if (typeof kdfControl.during === 'function') {
    const step = kdfControl.during;
    kdfControl.during = null;
    await step();
  }
  const tag = new TextEncoder().encode(`test-argon2id:${options.m}:${options.t}:${options.p}`);
  return real.argon2idAsync(password, real.concatBytes(salt, tag), { m: 8, t: 1, p: 1, dkLen: options.dkLen });
}

export const selfTestControl = { calls: 0, fail: false };

export function selfTest() {
  selfTestControl.calls += 1;
  if (selfTestControl.fail) throw new real.CoreError('SELF_TEST_FAILED');
  return real.selfTest();
}

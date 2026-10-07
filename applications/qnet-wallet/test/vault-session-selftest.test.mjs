// The crypto self-test at worker start (R18): a pass is cached in chrome.storage.session for the browser
// session, keyed by the bundle version and the SHA-256 of the shipped bundle, so a restarted worker skips
// the test; a failure is never cached and signing stays disabled until a pass. Each "worker" is a fresh
// instance of keys.js over the same storage.
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadWorker, rejectsWith, reset } from './helpers/vault-session-env.mjs';
import { selfTestControl } from './helpers/vault-session-core.mjs';

const w = await loadWorker();
const { core, config } = w;
const KEY = config.STORAGE_KEYS.SELF_TEST;
const BUNDLE = readFileSync(new URL('../dist/lib/qnet-core.js', import.meta.url));
const BUNDLE_ID = `${core.CORE_VERSION}:${createHash('sha256').update(BUNDLE).digest('hex')}`;

let env;
let instance = 0;
let fetches;
const freshWorker = () => {
  instance += 1;
  return import(`../dist/background/keys.js?worker=${instance}`);
};
const stored = () => env.chrome.storage.session.dump()[KEY];
const entropy = () => core.mnemonicToEntropy(core.KAT.mnemonic);

// The worker reads its own bundle through fetch(chrome.runtime.getURL(...)); nothing else is served.
function serveBundle({ readable = true } = {}) {
  const own = env.chrome.runtime.getURL('lib/qnet-core.js');
  fetches = [];
  globalThis.fetch = async (input) => {
    fetches.push(String(input));
    if (!readable || String(input) !== own) throw new TypeError('offline test');
    return new Response(BUNDLE);
  };
}

beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
  selfTestControl.calls = 0;
  selfTestControl.fail = false;
  serveBundle();
});

describe('crypto self-test cache', () => {
  it('the first worker runs the test and caches the pass for this exact bundle; the next worker skips it', async () => {
    const first = await freshWorker();
    assert.equal(await first.startKeys(), true);
    assert.equal(selfTestControl.calls, 1);
    const pass = stored();
    assert.deepEqual(Object.keys(pass).sort(), ['bundle', 'passedAt', 'v']);
    assert.equal(pass.v, 1);
    assert.equal(pass.bundle, BUNDLE_ID);
    assert.ok(Number.isSafeInteger(pass.passedAt) && pass.passedAt > 0);
    assert.deepEqual(fetches, [env.chrome.runtime.getURL('lib/qnet-core.js')], 'only its own bundle is read');

    const restarted = await freshWorker();
    assert.equal(await restarted.startKeys(), true);
    assert.equal(await restarted.startKeys(), true, 'idempotent');
    assert.equal(restarted.signingEnabled(), true);
    assert.equal(restarted.deriveAddresses(entropy()).qnetAddress, core.KAT.qnetAddress);
    assert.equal(selfTestControl.calls, 1, 'the cached pass stands for the test');
    assert.deepEqual(stored(), pass, 'a cache hit writes nothing');
  });

  it('a failure is never cached and keeps signing disabled until a pass', async () => {
    selfTestControl.fail = true;
    const broken = await freshWorker();
    assert.equal(await broken.startKeys(), false);
    assert.equal(stored(), undefined);
    assert.equal(broken.signingEnabled(), false);
    assert.throws(() => broken.deriveAddresses(entropy()), { code: 'SIGNING_DISABLED' });
    assert.equal(broken.initKeys(), false);
    assert.equal(selfTestControl.calls, 1, 'once per worker');

    selfTestControl.fail = false;
    const next = await freshWorker();
    assert.equal(await next.startKeys(), true, 'the next worker runs the test again');
    assert.equal(selfTestControl.calls, 2);
    assert.equal(stored().bundle, BUNDLE_ID);
  });

  it('a pass cached for another bundle, or malformed, is not trusted', async () => {
    const good = { v: 1, bundle: BUNDLE_ID, passedAt: 1_800_000_000_000 };
    const cases = [
      { ...good, bundle: `${core.CORE_VERSION}:${'00'.repeat(32)}` },
      { ...good, bundle: `3.0.0:${BUNDLE_ID.split(':')[1]}` },
      { ...good, v: 2 },
      { ...good, passedAt: 0 },
      { ...good, passedAt: '1' },
      { ...good, extra: true },
      { bundle: BUNDLE_ID, passedAt: 1 },
      [good],
      true,
    ];
    for (const [index, value] of cases.entries()) {
      await env.chrome.storage.session.set({ [KEY]: value });
      const worker = await freshWorker();
      assert.equal(await worker.startKeys(), true);
      assert.equal(selfTestControl.calls, index + 1, JSON.stringify(value));
      assert.equal(stored().bundle, BUNDLE_ID, 'replaced by a real pass');
    }
  });

  it('without a readable bundle the test runs and nothing is cached', async () => {
    serveBundle({ readable: false });
    const worker = await freshWorker();
    assert.equal(await worker.startKeys(), true);
    assert.equal(selfTestControl.calls, 1);
    assert.equal(stored(), undefined);
  });

  it('a request before the start settles runs the test once; the start then caches that pass', async () => {
    const worker = await freshWorker();
    assert.equal(worker.initKeys(), true);
    assert.equal(await worker.startKeys(), true);
    assert.equal(selfTestControl.calls, 1);
    assert.equal(stored().bundle, BUNDLE_ID);
  });

  it('signing paths wait for the start and refuse while the test has failed', async () => {
    selfTestControl.fail = true;
    const worker = await freshWorker();
    await rejectsWith(worker.signSolanaMessage(Uint8Array.of(1)), 'SIGNING_DISABLED');
    assert.equal(selfTestControl.calls, 1);
  });
});

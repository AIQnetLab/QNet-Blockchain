// Shared setup of the vault-session tests: registers the cheap-KDF resolution hook, then loads the worker
// modules (dynamically, so they resolve through the hook). reset() gives each test a fresh chrome.* and
// IndexedDB and a locked session with no backoff; module state is per test file (node --test runs every
// file in its own process).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createChrome } from './chrome-mock.mjs';
import { createIndexedDB } from './indexeddb-mock.mjs';

register('./vault-session-loader.mjs', import.meta.url);

export const KAT_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const KAT_EON = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
export const KAT_SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
export const PASSWORD = 'correct horse battery staple';
export const NEW_PASSWORD = 'quantum otter lantern meadow';

/** The worker modules, loaded once per test file through the hook. */
export async function loadWorker() {
  globalThis.chrome ??= createChrome();
  globalThis.indexedDB ??= createIndexedDB();
  const [vault, session, keys, core, wrapper, config] = await Promise.all([
    import('../../dist/background/vault.js'),
    import('../../dist/background/session.js'),
    import('../../dist/background/keys.js'),
    import('../../dist/lib/qnet-core.js'),
    import('./vault-session-core.mjs'),
    import('../../dist/background/config.js'),
  ]);
  assert.equal(core.argon2idAsync, wrapper.argon2idAsync, 'the cheap-KDF hook is active');
  return { vault, session, keys, core, config, kdfCalls: wrapper.kdfCalls };
}

/**
 * Fresh browser state for one test: a new chrome mock and IndexedDB, the session locked, the backoff
 * reset, no KDF calls recorded. Returns the new mocks and the lock changes seen from now on.
 */
export async function reset(worker) {
  await worker.session.lock('user');
  const chrome = createChrome();
  const idb = createIndexedDB();
  globalThis.chrome = chrome;
  globalThis.indexedDB = idb;
  await worker.session.recordPasswordSuccess();
  worker.kdfCalls.length = 0;
  const changes = [];
  const unsubscribe = worker.session.onLockChange((change) => changes.push(change));
  return { chrome, idb, changes, unsubscribe };
}

/** Asserts that `promise` rejects with an error carrying `code`; returns the error. */
export async function rejectsWith(promise, code) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}, but it resolved`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code ?? caught}`);
  return caught;
}

/**
 * Replaces Date.now (the only clock the worker modules read) until restore(); the IndexedDB mock's
 * scheduling is untouched.
 * @param {number} start ms epoch
 */
export function fakeClock(start) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    tick(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

/** The raw vault record as stored, or null. */
export function storedRecord(idb, config) {
  const dump = idb.dump(config.VAULT_DB.NAME);
  return dump?.stores?.[config.VAULT_DB.STORE]?.[config.VAULT_DB.KEY] ?? null;
}

/** Replaces the stored vault record (as local malware with profile access could). */
export async function overwriteRecord(idb, config, record) {
  const dump = idb.dump(config.VAULT_DB.NAME);
  idb.seed(config.VAULT_DB.NAME, dump.version, { [config.VAULT_DB.STORE]: { [config.VAULT_DB.KEY]: record } });
}

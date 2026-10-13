// Forgot password (lock screen → "Forgot password?" → Reset wallet, owner 11.10): the password cannot be recovered, so the
// wallet leaves this browser without it, locked as it is, and only its recovery phrase brings it back (Import). Only the
// popup may start and finish a reset; the erase needs the one-time token vault.resetBegin issued to that popup document
// and the fixed confirmation, and it erases what Delete wallet erases, only while the wallet is locked. Runs through the
// real router.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRouter } from '../dist/background/router.js';
import {
  OTHER_EXTENSION_ID, contentScriptSender, createPort, createRuntime, pageSender, until,
} from './helpers/chrome-mock.mjs';
import {
  KAT_EON, KAT_MNEMONIC, KAT_SOLANA, NEW_PASSWORD, PASSWORD, fakeClock, loadWorker, overwriteRecord, reset, storedRecord,
} from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, core, config } = w;
const { STORAGE_KEYS, TIMINGS } = config;
const BURN_TX = core.KAT.activation.burnTx;

let env;
let router;
beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
  router = createRouter({ runtime: env.chrome.runtime });
});
after(() => env?.unsubscribe());

const record = () => storedRecord(env.idb, config);
const popup = (documentId = 'popup-document-1') => ({ ...pageSender(env.chrome.runtime, 'popup'), documentId });
const send = async (sender, type, params) => router.handleUiMessage({ type, id: 'r1', params }, sender);
const errorCode = (reply) => {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  return reply.error.code;
};
const begin = async (sender = popup()) => {
  const reply = await send(sender, 'vault.resetBegin', {});
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result.token;
};
// The call the press of Reset wallet sends after vault.resetBegin.
const resetWith = (token, { sender = popup() } = {}) => send(sender, 'vault.reset', { token, confirm: 'ERASE' });

// The wallet of this browser before the reset, locked: the KAT phrase, an activation, a grant, a language and a key the
// earlier version left.
async function oldWallet() {
  await vault.importVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
  await vault.updateState((state) => ({
    ...state,
    activation: {
      code: core.generateActivationCode('light', KAT_SOLANA, BURN_TX, 1500),
      nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500, solanaAddress: KAT_SOLANA, cluster: 'devnet', createdAt: 1_700_000_000_000,
    },
  }));
  await env.chrome.storage.local.set({
    [STORAGE_KEYS.SITES]: { 'https://aiqnet.io': { any: 'grant' } }, [STORAGE_KEYS.SETTINGS]: { language: 'en' }, walletExists: true,
  });
  await session.lock('user');
  env.changes.length = 0;
  return structuredClone(record());
}

// Nothing was erased: the same record, still locked, still opening with its password.
async function assertOldVaultIntact(before) {
  assert.deepEqual(record(), before, 'the old record is untouched');
  assert.equal(await session.isUnlocked(), false);
  assert.equal(env.chrome.storage.local.dump()[STORAGE_KEYS.SETTINGS].language, 'en');
  await session.recordPasswordSuccess();
  assert.equal((await vault.unlock({ password: PASSWORD })).qnet, KAT_EON);
  assert.equal((await vault.readState()).activation.nodeType, 'light');
  await session.lock('user');
}

// Everything Delete wallet erases is gone.
async function assertErased() {
  assert.deepEqual(await env.idb.databases(), [], 'the vault database is deleted');
  assert.deepEqual(env.chrome.storage.local.dump(), {}, "grants, settings and the earlier version's keys are gone");
  assert.deepEqual(Object.keys(env.chrome.storage.session.dump()).filter((key) => key !== STORAGE_KEYS.SELF_TEST), []);
  assert.equal(await session.isUnlocked(), false);
  assert.equal((await send(popup(), 'vault.status', {})).result.exists, false);
}

describe('forgot password: reset the wallet', () => {
  it('erases the locked wallet without a password, as Delete wallet erases it, and its password backoff with it', async () => {
    await oldWallet();
    // a forgotten password: enough failed unlocks for a delay (recorded as the unlock handler does)
    for (let i = 0; i < 8; i += 1) await session.recordPasswordFailure();
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'BACKOFF');
    const token = await begin();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(env.changes, [], 'a token erases nothing');
    const reply = await resetWith(token);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result, { wiped: true });
    assert.deepEqual(env.changes.map((c) => [c.locked, c.reason]), [[true, 'wipe']], "one lock, reason 'wipe': the pages hear 'wiped'");
    await assertErased();
    assert.equal(await session.getBackoffUntil(), null, 'the erased vault took its failed attempts with it');
    assert.equal(errorCode(await resetWith(token)), 'RESET_EXPIRED', 'the token is spent');
    assert.equal(errorCode(await send(popup(), 'vault.resetBegin', {})), 'NO_VAULT');
  });

  it('refuses an unlocked wallet: its password is known, Delete wallet takes it', async () => {
    const before = await oldWallet();
    await vault.unlock({ password: PASSWORD });
    assert.equal(errorCode(await send(popup(), 'vault.resetBegin', {})), 'UNLOCKED');
    // a token taken while locked, then an unlock in another view before the press: still refused
    await session.lock('user');
    const token = await begin();
    await vault.unlock({ password: PASSWORD });
    env.changes.length = 0;
    assert.equal(errorCode(await resetWith(token)), 'UNLOCKED');
    assert.equal(await session.isUnlocked(), true, 'the session goes on');
    assert.deepEqual(env.changes, [], 'nothing was locked or erased');
    await session.lock('user');
    await assertOldVaultIntact(before);
    assert.equal(errorCode(await resetWith(token)), 'RESET_EXPIRED', 'the refused call spent the token');
  });

  it('an unlock still running when Reset wallet is pressed finishes first, and the reset is refused', async () => {
    const before = await oldWallet();
    const token = await begin();
    const unlocking = send(popup(), 'vault.unlock', { password: PASSWORD });
    const resetting = resetWith(token);
    assert.equal((await unlocking).ok, true);
    assert.equal(errorCode(await resetting), 'UNLOCKED');
    assert.equal(await session.isUnlocked(), true);
    await session.lock('user');
    await assertOldVaultIntact(before);
  });

  it('only the recovery phrase brings it back: Import after the reset, the same addresses, the new password', async () => {
    await oldWallet();
    assert.equal((await resetWith(await begin())).ok, true);
    const imported = await send(pageSender(env.chrome.runtime, 'setup'), 'vault.import', { mnemonic: KAT_MNEMONIC, password: NEW_PASSWORD });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.deepEqual([imported.result.qnet, imported.result.solana], [KAT_EON, KAT_SOLANA]);
    assert.equal((await vault.readState()).activation, null, 'the activation record went with the old vault (Recover finds the burn)');
    await session.lock('user');
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'BAD_PASSWORD');
    assert.equal((await send(popup(), 'vault.unlock', { password: NEW_PASSWORD })).result.qnet, KAT_EON);
  });

  it('needs the token the worker issued to this popup: none, a wrong, reused, expired or foreign one erases nothing', async () => {
    const before = await oldWallet();
    assert.equal(errorCode(await resetWith('ab'.repeat(32))), 'RESET_EXPIRED', 'no token issued');
    const token = await begin();
    assert.equal(errorCode(await resetWith('cd'.repeat(32))), 'RESET_EXPIRED', 'wrong token');
    assert.equal(errorCode(await resetWith(token)), 'RESET_EXPIRED', 'one use: the failed attempt spent it');

    const other = await begin(popup('popup-document-1'));
    assert.equal(errorCode(await resetWith(other, { sender: popup('popup-document-2') })), 'RESET_EXPIRED', 'another popup document');

    const replaced = await begin();
    const latest = await begin();
    assert.notEqual(latest, replaced);
    assert.equal(errorCode(await resetWith(replaced)), 'RESET_EXPIRED', 'a newer token replaces an older one');

    const clock = fakeClock(Date.now());
    try {
      const late = await begin();
      clock.tick(TIMINGS.RESET_TOKEN_TTL_MS);
      assert.equal(errorCode(await resetWith(late)), 'RESET_EXPIRED', 'expired');
    } finally {
      clock.restore();
    }
    assert.deepEqual(env.changes, [], 'nothing was locked or erased');
    await assertOldVaultIntact(before);
  });

  it('needs the fixed confirmation and takes nothing else: no password, no phrase', async () => {
    const before = await oldWallet();
    const token = await begin();
    const refused = [
      { token }, { token, confirm: 'erase' }, { token, confirm: 'DELETE' }, { token, confirm: true },
      { token, confirm: 'ERASE', password: PASSWORD }, { token, confirm: 'ERASE', mnemonic: KAT_MNEMONIC },
      { confirm: 'ERASE' }, { token: token.toUpperCase(), confirm: 'ERASE' },
    ];
    for (const params of refused) {
      assert.equal(errorCode(await send(popup(), 'vault.reset', params)), 'INVALID_PARAMS', JSON.stringify(params));
    }
    // the router refused those before the handler, so the token is still good here; the handler refuses on its own too
    await assert.rejects(vault.resetVault({ token }, { page: 'popup', sender: popup() }), { code: 'INVALID_PARAMS' });
    assert.equal(errorCode(await resetWith(token)), 'RESET_EXPIRED', 'the refused call spent the token');
    assert.deepEqual(env.changes, []);
    await assertOldVaultIntact(before);
  });

  it('only the popup may start or finish a reset', async () => {
    const before = await oldWallet();
    const token = await begin();
    const senders = {
      setup: pageSender(env.chrome.runtime, 'setup'),
      approve: pageSender(env.chrome.runtime, 'approve', { query: '?id=0f8fad5b-d9cb-469f-a165-70867728950e' }),
      'content script': contentScriptSender('https://aiqnet.io/'),
      'other extension': { ...popup(), id: OTHER_EXTENSION_ID },
      subframe: { ...pageSender(env.chrome.runtime, 'popup', { tab: true }), frameId: 1 },
      worker: pageSender(env.chrome.runtime, 'background/sw.js', { tab: false }),
    };
    for (const [name, sender] of Object.entries(senders)) {
      assert.equal(errorCode(await send(sender, 'vault.resetBegin', {})), 'FORBIDDEN_SENDER', name);
      assert.equal(errorCode(await resetWith(token, { sender })), 'FORBIDDEN_SENDER', name);
    }
    // the handlers refuse another page on their own too, without spending the popup's token
    const setupMeta = { page: 'setup', sender: senders.setup };
    await assert.rejects(vault.beginReset({}, setupMeta), { code: 'FORBIDDEN_SENDER' });
    await assert.rejects(vault.resetVault({ token, confirm: 'ERASE' }, setupMeta), { code: 'FORBIDDEN_SENDER' });
    assert.deepEqual(env.changes, []);
    assert.deepEqual(record(), before);
    assert.equal((await resetWith(token)).ok, true, 'refused senders did not spend the popup token');
    await assertErased();
  });

  it('no site reaches it: the provider has no such method', async () => {
    const before = await oldWallet();
    const token = await begin();
    const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
    const siteRouter = createRouter({
      runtime: createRuntime({ manifest }),
      providerRequest: async () => {
        throw new Error('the provider was reached');
      },
    });
    const port = createPort({ sender: contentScriptSender('https://aiqnet.io/') });
    siteRouter.handleProviderConnect(port);
    assert.equal(port.disconnected, false, 'the site holds a provider port');
    const methods = ['vault.reset', 'vault.resetBegin', 'vault_reset', 'resetVault', 'beginReset'];
    methods.forEach((method, id) => port.send({ id, method, params: { token, confirm: 'ERASE' } }));
    await until(() => port.posted.length === methods.length);
    for (const reply of port.posted) assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.deepEqual(env.changes, []);
    assert.deepEqual(record(), before);
    assert.equal((await resetWith(token)).ok, true, 'the site spent nothing');
  });

  it('refuses without a vault', async () => {
    assert.equal(errorCode(await send(popup(), 'vault.resetBegin', {})), 'NO_VAULT');
    await oldWallet();
    const token = await begin();
    await vault.wipe({ password: PASSWORD, confirm: 'DELETE' });
    assert.equal(errorCode(await resetWith(token)), 'NO_VAULT');
  });

  it('a stored record that does not parse goes too, instead of blocking every way out (R2-ESM-05)', async () => {
    await oldWallet();
    const broken = structuredClone(record());
    broken.unexpected = 1;
    await overwriteRecord(env.idb, config, broken);
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'VAULT_CORRUPT');
    assert.equal((await resetWith(await begin())).ok, true);
    await assertErased();
  });
});

// The vault database's object store as it is now.
const stores = () => env.idb.dump(config.VAULT_DB.NAME).stores[config.VAULT_DB.STORE];

// R5-ESM-03: the forgot-password restore of 3.0.0 and 3.1.0 staged an Argon2id copy of a typed phrase next to the vault;
// one its worker left when it stopped between that write and the replace must not stay for good.
describe('a staged record an earlier version left (R5-ESM-03)', () => {
  it('goes at the next worker start and at unlock, and nothing else does', async () => {
    const before = await oldWallet();
    const leftover = structuredClone(before);
    const seed = async () => {
      const dump = env.idb.dump(config.VAULT_DB.NAME);
      env.idb.seed(config.VAULT_DB.NAME, dump.version, { [config.VAULT_DB.STORE]: { ...dump.stores[config.VAULT_DB.STORE], restoreStaging: leftover } });
      assert.equal(Object.hasOwn(stores(), 'restoreStaging'), true);
    };
    await seed();
    await vault.discardRestoreStaging();
    assert.equal(Object.hasOwn(stores(), 'restoreStaging'), false, 'worker start');
    assert.deepEqual(record(), before, 'the vault record stays');
    await seed();
    await vault.unlock({ password: PASSWORD });
    assert.equal(Object.hasOwn(stores(), 'restoreStaging'), false, 'unlock');
    await session.lock('user');
    await assertOldVaultIntact(before);
  });
});

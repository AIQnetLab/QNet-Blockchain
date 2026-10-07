// Forgot password (lock screen → "Forgot password?" → Reset wallet): only the popup may start and finish it,
// the replace needs the one-time token vault.restoreBegin issued to that popup document and the confirmation
// literal (a call without it only checks the phrase and names both wallets), the old vault is erased only after
// the new phrase and password passed their checks, and the new vault is read back and its addresses compared
// before the session starts. Runs through the real router.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../dist/background/router.js';
import { OTHER_EXTENSION_ID, contentScriptSender, pageSender } from './helpers/chrome-mock.mjs';
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
  const reply = await send(sender, 'vault.restoreBegin', {});
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result.token;
};
// The popup's first call: the phrase is checked and both wallets named, nothing is erased.
const check = (token, { mnemonic = KAT_MNEMONIC, password = NEW_PASSWORD, sender = popup(), ...extra } = {}) => send(sender,
  'vault.restore', { token, mnemonic, password, ...extra });
// The call the confirmation sends.
const restore = (token, { mnemonic = KAT_MNEMONIC, password = NEW_PASSWORD, sender = popup(), ...extra } = {}) => send(sender,
  'vault.restore', { token, mnemonic, password, confirm: 'ERASE', ...extra });

// The wallet of this browser before the restore: the KAT phrase, an activation, a grant, a language.
async function oldWallet() {
  await vault.importVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
  await vault.updateState((state) => ({
    ...state,
    activation: {
      code: core.generateActivationCode('light', KAT_SOLANA, BURN_TX, 1500),
      nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500, solanaAddress: KAT_SOLANA, cluster: 'devnet', createdAt: 1_700_000_000_000,
    },
  }));
  await env.chrome.storage.local.set({ [STORAGE_KEYS.SITES]: { 'https://aiqnet.io': { any: 'grant' } }, [STORAGE_KEYS.SETTINGS]: { language: 'en' } });
  await session.lock('user');
  env.changes.length = 0;
  return structuredClone(record());
}

async function assertOldVaultIntact(before) {
  assert.deepEqual(record(), before, 'the old record is untouched');
  assert.equal(await session.isUnlocked(), false);
  await session.recordPasswordSuccess();
  const unlocked = await vault.unlock({ password: PASSWORD });
  assert.equal(unlocked.qnet, KAT_EON);
  assert.equal((await vault.readState()).activation.nodeType, 'light');
  await session.lock('user');
}

describe('forgot password: restore from the recovery phrase', () => {
  it('needs the token the worker issued: none, a wrong, reused, expired or foreign one changes nothing', async () => {
    const before = await oldWallet();
    assert.equal(errorCode(await restore('ab'.repeat(32))), 'RESTORE_EXPIRED', 'no token issued');

    const token = await begin();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(errorCode(await restore('cd'.repeat(32))), 'RESTORE_EXPIRED', 'wrong token');
    assert.equal(errorCode(await restore(token)), 'RESTORE_EXPIRED', 'one use: the failed attempt spent it');

    const other = await begin(popup('popup-document-1'));
    assert.equal(errorCode(await restore(other, { sender: popup('popup-document-2') })), 'RESTORE_EXPIRED', 'another page');

    const replaced = await begin();
    const latest = await begin();
    assert.notEqual(latest, replaced);
    assert.equal(errorCode(await restore(replaced)), 'RESTORE_EXPIRED', 'a newer token replaces an older one');

    const clock = fakeClock(Date.now());
    try {
      const late = await begin();
      clock.tick(TIMINGS.RESTORE_TOKEN_TTL_MS);
      assert.equal(errorCode(await restore(late)), 'RESTORE_EXPIRED', 'expired');
    } finally {
      clock.restore();
    }
    assert.deepEqual(env.changes, [], 'nothing was locked, erased or unlocked');
    await assertOldVaultIntact(before);
  });

  it('an invalid phrase or a weak password leaves the old vault intact', async () => {
    const before = await oldWallet();
    const invalid = [
      KAT_MNEMONIC.replace(/about$/, 'abandon'),
      KAT_MNEMONIC.split(' ').slice(0, 11).join(' '),
      'not a recovery phrase at all',
    ];
    for (const mnemonic of invalid) {
      assert.equal(errorCode(await restore(await begin(), { mnemonic })), 'INVALID_MNEMONIC', mnemonic);
    }
    assert.equal(errorCode(await restore(await begin(), { password: 'short' })), 'WEAK_PASSWORD');
    assert.deepEqual(env.changes, [], 'nothing was locked or erased');
    assert.equal(env.chrome.storage.local.dump()[STORAGE_KEYS.SETTINGS].language, 'en');
    await assertOldVaultIntact(before);
  });

  it('success replaces the vault: a new wallet, the new password, no old activation, grants or settings', async () => {
    const before = await oldWallet();
    const entropy = core.generateEntropy(24);
    const mnemonic = core.entropyToMnemonic(entropy);
    const seed = core.entropyToSeed(entropy);
    const expected = { qnet: core.deriveQnetKeypair(seed).address, solana: core.deriveSolanaKeypair(seed).address };
    const token = await begin();
    // spacing and capitals of a typed phrase are canonicalized
    const typed = `  ${mnemonic.toUpperCase().replaceAll(' ', '\n ')} `;
    // another wallet than the stored one: both pairs are named and nothing is erased (EXT-VAULT-R2-04)
    const named = { status: 'confirm', erased: { qnet: KAT_EON, solana: KAT_SOLANA }, restored: expected, otherWallet: true };
    const asked = await check(token, { mnemonic: typed });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.deepEqual(asked.result, named);
    // confirmed without replaceOther (the check's answer not acknowledged): asked again, still nothing erased
    const again = await restore(token, { mnemonic: typed });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.result, named);
    assert.deepEqual(env.changes, [], 'nothing was locked or erased');
    assert.deepEqual(record(), before);
    // the confirmed call, with the same token
    const reply = await restore(token, { mnemonic: typed, replaceOther: true });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(Object.keys(reply.result).sort(), ['lockDeadline', 'qnet', 'solana', 'status']);
    assert.equal(reply.result.status, 'restored');
    assert.equal(reply.result.qnet, expected.qnet);
    assert.equal(reply.result.solana, expected.solana);
    assert.deepEqual(env.changes.map((c) => [c.locked, c.reason]), [[true, 'wipe'], [false, 'unlock']]);

    const now = record();
    assert.notEqual(now.aad.walletId, before.aad.walletId);
    assert.equal(now.aad.qnetAddress, expected.qnet);
    assert.equal(now.aad.activationNodeType, null);
    assert.deepEqual(await session.requireUnlocked().then((s) => s.qnetAddress), expected.qnet);
    assert.equal((await vault.readState()).activation, null, 'the old activation record went with the old vault');
    assert.deepEqual(env.chrome.storage.local.dump(), {}, 'grants and settings are gone');
    assert.deepEqual(Object.keys(env.chrome.storage.session.dump()).filter((k) => k !== STORAGE_KEYS.SELF_TEST),
      [STORAGE_KEYS.SESSION]);
    assert.equal(errorCode(await restore(token, { mnemonic, replaceOther: true })), 'RESTORE_EXPIRED', 'the token is spent');

    await session.lock('user');
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'BAD_PASSWORD');
    assert.equal((await send(popup(), 'vault.unlock', { password: NEW_PASSWORD })).result.qnet, expected.qnet);
    assert.equal((await send(popup(), 'vault.reveal', { password: NEW_PASSWORD })).result.mnemonic, mnemonic);
  });

  it('the same phrase: the check names this wallet and erases nothing; confirmed, the addresses stay and the activation record goes (Recover finds it)', async () => {
    const before = await oldWallet();
    const token = await begin();
    const asked = await check(token);
    assert.equal(asked.ok, true, JSON.stringify(asked));
    const pair = { qnet: KAT_EON, solana: KAT_SOLANA };
    assert.deepEqual(asked.result, { status: 'confirm', erased: pair, restored: pair, otherWallet: false });
    assert.deepEqual(env.changes, [], 'a check locks and erases nothing');
    assert.deepEqual(record(), before);
    // the confirmation, with the same token
    const reply = await restore(token);
    assert.equal(reply.result.status, 'restored', JSON.stringify(reply));
    assert.deepEqual([reply.result.qnet, reply.result.solana], [KAT_EON, KAT_SOLANA]);
    assert.equal((await vault.readState()).activation, null);
    assert.equal(errorCode(await restore(token)), 'RESTORE_EXPIRED', 'the replace spent the token');
  });

  it("the erased vault's password backoff does not carry over; a refused restore keeps it", async () => {
    await oldWallet();
    // A forgotten password: enough failed unlocks for a delay (recorded as the unlock handler does).
    for (let i = 0; i < 8; i += 1) await session.recordPasswordFailure();
    const until = await session.getBackoffUntil();
    assert.ok(until > Date.now());
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'BACKOFF');

    // Nothing erased: the delay still guards the kept vault.
    assert.equal(errorCode(await restore(await begin(), { mnemonic: 'not a recovery phrase at all' })), 'INVALID_MNEMONIC');
    assert.equal(errorCode(await restore('ab'.repeat(32))), 'RESTORE_EXPIRED');
    assert.equal(await session.getBackoffUntil(), until, 'a refused restore leaves the backoff');

    assert.equal((await restore(await begin())).ok, true);
    assert.equal(await session.getBackoffUntil(), null, 'the erased vault took its failed attempts with it');
    await session.lock('user');
    assert.equal((await send(popup(), 'vault.unlock', { password: NEW_PASSWORD })).ok, true, 'no delay on the new vault');
  });

  it('only the popup may start or finish a restore', async () => {
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
      assert.equal(errorCode(await send(sender, 'vault.restoreBegin', {})), 'FORBIDDEN_SENDER', name);
      assert.equal(errorCode(await check(token, { sender })), 'FORBIDDEN_SENDER', name);
      assert.equal(errorCode(await restore(token, { sender })), 'FORBIDDEN_SENDER', name);
    }
    // The handler refuses a non-popup meta on its own too.
    await assert.rejects(vault.beginRestore({}, { page: 'setup', sender: senders.setup }), { code: 'FORBIDDEN_SENDER' });
    assert.deepEqual(env.changes, []);
    const reply = await restore(token);
    assert.equal(reply.ok, true, 'refused senders did not spend the popup token');
    assert.notDeepEqual(record(), before);
  });

  it('refuses to start without a vault', async () => {
    assert.equal(errorCode(await send(popup(), 'vault.restoreBegin', {})), 'NO_VAULT');
  });
});

// The vault database's object store as it is now.
const stores = () => env.idb.dump(config.VAULT_DB.NAME).stores[config.VAULT_DB.STORE];

// R5-ESM-03: a restore that failed after its staged write, or that a stopped worker left between the staged write
// and the replacing transaction, kept an Argon2id copy of the typed phrase under the restore password for good.
describe('forgot password: no staged copy outlives its restore (R5-ESM-03)', () => {
  it('a staged record whose read-back fails is deleted, and the old vault stays', async () => {
    const before = await oldWallet();
    const token = await begin();
    // gets: the replaced record, then the staged read-back
    env.idb.inject('get', 'UnknownError', { skip: 1 });
    const reply = await restore(token);
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.equal(Object.hasOwn(stores(), 'restoreStaging'), false);
    await assertOldVaultIntact(before);
  });

  it('a staged record a stopped worker left goes at the next worker start and at unlock, and nothing else does', async () => {
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

describe('forgot password: failed writes and damaged records (EXT-VAULT-R3-04, R2-ESM-05)', () => {
  // EXT-VAULT-R3-04: the new record is written and read back before the old vault goes; a failure anywhere
  // before the one replacing transaction commits leaves the old vault as it was.
  it('writes the new vault before the old one goes: a failed write or replace keeps the old vault (EXT-VAULT-R3-04)', async () => {
    const before = await oldWallet();
    for (const [op, skip] of [['put', 0], ['clear', 0], ['commit', 1]]) {
      env.idb.inject(op, 'UnknownError', { skip });
      const reply = await restore(await begin());
      assert.equal(reply.ok, false, `${op}: ${JSON.stringify(reply)}`);
      assert.deepEqual(record(), before, `${op}: the old vault is untouched`);
      // R5-ESM-03: no second sealed copy of the typed phrase stays behind a failed restore
      assert.equal(Object.hasOwn(stores(), 'restoreStaging'), false, `${op}: the staged copy is deleted again`);
    }
    await assertOldVaultIntact(before);
    const reply = await restore(await begin());
    assert.equal(reply.result.status, 'restored', JSON.stringify(reply));
    assert.equal(reply.result.qnet, KAT_EON);
    assert.equal(Object.hasOwn(stores(), 'restoreStaging'), false, 'the staged copy went with the replace');
  });

  it('a malformed stored record is replaced instead of blocking every way out (R2-ESM-05)', async () => {
    await oldWallet();
    const broken = structuredClone(record());
    broken.unexpected = 1;
    await overwriteRecord(env.idb, config, broken);
    assert.equal(errorCode(await send(popup(), 'vault.unlock', { password: PASSWORD })), 'VAULT_CORRUPT');
    const token = await begin();
    // its addresses cannot be read: the check names only the phrase's wallet, and erases nothing
    const asked = await check(token);
    assert.deepEqual(asked.result, { status: 'confirm', erased: null, restored: { qnet: KAT_EON, solana: KAT_SOLANA }, otherWallet: false });
    assert.deepEqual(record(), broken);
    const reply = await restore(token);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.status, 'restored');
    assert.equal(reply.result.qnet, KAT_EON);
    assert.equal((await vault.readState()).activation, null);
  });
});

// The wallet the store's 2.1.x kept in this browser (M-4, owner's choice: migrate): its record in chrome.storage.local and
// its pages' copy in IndexedDB. vault.migrate opens it with its password (PBKDF2-SHA256 at its count, AES-GCM), keeps only
// its recovery phrase and writes this version's vault from it under a new password; what 2.x left goes only once that
// vault was read back, or by vault.removeEarlier once a vault exists and the user confirmed it. A wrong password never
// removes anything. The records are made here with the 2.x algorithms (2.1.3 background.js encryptWalletData, and its
// pages' key manager, whose password change re-encrypted only their copy).
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KAT_EON, KAT_MNEMONIC, KAT_SOLANA, NEW_PASSWORD, PASSWORD, loadWorker, rejectsWith, reset, storedRecord,
} from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, config } = w;
const earlier = await import('../dist/background/earlier.js');

const OLD_PASSWORD = 'my password of 2.1.3';
// every key 2.1.3 wrote to chrome.storage.local (its background.js, popup.js and setup.js)
const KEYS_2X = ['encryptedWallet', 'walletExists', 'walletData', 'encryptedActivationCodes', 'wallet', 'isUnlocked', 'lastUnlockTime',
  'currentNetwork', 'mainnet', 'auto_lock_timer', 'connected_sites'];

let env;
beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
});
after(() => env?.unsubscribe());

// 2.x: PBKDF2-SHA256 over the password as typed (100,000 iterations, 600,000 for version 2, which also took a 32-byte salt),
// AES-256-GCM of the wallet's JSON, every byte array written as an array of numbers.
async function encryptAs2x(wallet, password, { version = 1 } = {}) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(version === 2 ? 32 : 16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: version === 2 ? 600000 : 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(wallet)));
  return { encrypted: Array.from(new Uint8Array(encrypted)), salt: Array.from(salt), iv: Array.from(iv), version };
}

// The wallet 2.1.3 encrypted: its phrase beside both accounts' keys (stand-in bytes here).
const wallet2x = (mnemonic = KAT_MNEMONIC) => ({
  version: 1,
  mnemonic,
  accounts: [{
    index: 0,
    solanaKeypair: { publicKey: Array(32).fill(1), secretKey: Array(64).fill(7), address: KAT_SOLANA },
    qnetAddress: KAT_EON,
    qnetKeypair: { publicKey: Array(32).fill(2), privateKey: Array(32).fill(9), path: 'account 0' },
  }],
  networks: ['solana', 'qnet'],
  createdAt: 1_700_000_000_000,
});

// chrome.storage.local as 2.1.3 left it: the encrypted wallet and the keys it wrote beside it.
async function seed2x(blob, extra = {}) {
  await env.chrome.storage.local.set({
    walletExists: true, encryptedWallet: blob, currentNetwork: 'solana', encryptedActivationCodes: { [KAT_EON]: { encrypted: [1, 2, 3] } },
    walletData: { nodeStatus: { active: false } }, isUnlocked: true, lastUnlockTime: 1_700_000_000_000, mainnet: false,
    auto_lock_timer: '15', connected_sites: ['https://aiqnet.io'], ...extra,
  });
}

const localKeys = async () => Object.keys(await env.chrome.storage.local.get(null)).sort();
const localText = async () => JSON.stringify(await env.chrome.storage.local.get(null));

describe('vault: the wallet of an earlier version (M-4)', () => {
  it('status names an earlier wallet while one is stored, a placeholder or none is not one', async () => {
    assert.equal((await vault.getStatus()).earlier, false);
    await seed2x('wallet_created');
    assert.equal((await vault.getStatus()).earlier, false, 'a placeholder 2.x wrote when a creation failed opens nothing');
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    const status = await vault.getStatus();
    assert.equal(status.exists, false);
    assert.equal(status.earlier, true);
    // stored as a JSON string, as some 2.x builds did
    await seed2x(JSON.stringify(await encryptAs2x(wallet2x(), OLD_PASSWORD)));
    assert.equal((await vault.getStatus()).earlier, true);
  });

  it('the password alone only checks it: a wrong one counts toward the backoff and removes nothing; the right one writes nothing', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    const before = await localText();
    await rejectsWith(vault.migrateEarlier({ password: 'wrong' }), 'BAD_PASSWORD');
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD.normalize('NFKD').toUpperCase() }), 'BAD_PASSWORD');
    assert.equal(await localText(), before, 'a wrong password never removes anything');
    assert.deepEqual(await vault.migrateEarlier({ password: OLD_PASSWORD }), { checked: true });
    assert.equal(await vault.vaultExists(), false, 'a check writes no vault');
    assert.equal(storedRecord(env.idb, config), null);
    assert.equal(await localText(), before, 'and removes nothing');
    assert.equal(await session.isUnlocked(), false);
  });

  it('keeps to the backoff of unlock, shared with it', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    for (let i = 0; i < config.LIMITS.BACKOFF_FREE_ATTEMPTS + 1; i += 1) {
      await rejectsWith(vault.migrateEarlier({ password: `wrong ${i}` }), 'BAD_PASSWORD');
    }
    const refused = await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD }), 'BACKOFF');
    assert.ok(refused.retryAfterMs > 0);
    assert.ok((await vault.getStatus()).backoffUntil > Date.now(), 'the status reports it, as for unlock');
    assert.deepEqual(await env.chrome.storage.local.get('encryptedWallet').then((r) => Object.keys(r)), ['encryptedWallet']);
  });

  it('moves it: only its recovery phrase, a new password, this version\'s vault read back, then the earlier keys go', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD), { unrelated: 'kept' });
    const result = await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(result.qnet, KAT_EON, 'the same wallet: its phrase gives the same QNet address');
    assert.equal(result.solana, KAT_SOLANA, 'and the same Solana address');
    assert.equal(await vault.vaultExists(), true);
    assert.equal(await session.isUnlocked(), true, 'the session starts, as after an import');
    assert.deepEqual(await localKeys(), ['unrelated'], 'every key 2.x wrote is gone, nothing else');
    assert.equal((await vault.getStatus()).earlier, false);
    assert.doesNotMatch(await localText(), /abandon|secretKey|privateKey/, 'no secret is left in chrome.storage.local');
    // an Argon2id vault under the new password; the earlier password opens nothing
    const record = storedRecord(env.idb, config);
    assert.equal(record.kdf.alg, 'argon2id');
    await session.lock('user');
    await rejectsWith(vault.unlock({ password: OLD_PASSWORD }), 'BAD_PASSWORD');
    assert.equal((await vault.unlock({ password: NEW_PASSWORD })).qnet, KAT_EON);
    assert.equal((await vault.reveal({ password: NEW_PASSWORD })).mnemonic, KAT_MNEMONIC);
  });

  it('opens a version-2 record (600,000 iterations, 32-byte salt) and one stored as a JSON string', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD, { version: 2 }));
    assert.equal((await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD })).qnet, KAT_EON);
    assert.deepEqual(await localKeys(), []);
    env.unsubscribe();
    env = await reset(w);
    await seed2x(JSON.stringify(await encryptAs2x(wallet2x(), OLD_PASSWORD)));
    assert.equal((await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD })).solana, KAT_SOLANA);
    assert.deepEqual(await localKeys(), []);
  });

  it('a phrase 2.x kept with a line break or tab from a paste reads as the same words; another escape does not', async () => {
    const words = KAT_MNEMONIC.split(' ');
    await seed2x(await encryptAs2x(wallet2x(`${words.slice(0, 6).join(' ')}\r\n${words.slice(6).join('\t')}`), OLD_PASSWORD));
    assert.equal((await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD })).qnet, KAT_EON);
    env.unsubscribe();
    env = await reset(w);
    await seed2x(await encryptAs2x(wallet2x(`${words.slice(0, 11).join(' ')} "about"`), OLD_PASSWORD));
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD }), 'VAULT_CORRUPT');
  });

  it('refuses a weak new password, a vault that exists and a missing record before anything is written or removed', async () => {
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD }), 'NO_VAULT');
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    const before = await localText();
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: 'short' }), 'WEAK_PASSWORD');
    assert.equal(await vault.vaultExists(), false);
    await vault.importVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD }), 'VAULT_EXISTS');
    assert.equal(await localText(), before, 'the earlier keys stay until the user confirms their removal');
  });

  it('a record that opens but holds no valid recovery phrase is refused as unreadable, and kept', async () => {
    for (const mnemonic of ['abandon abandon abandon', `${'abandon '.repeat(11)}zoo`, undefined]) {
      env.unsubscribe();
      env = await reset(w);
      const wallet = wallet2x(mnemonic);
      if (mnemonic === undefined) delete wallet.mnemonic;
      await seed2x(await encryptAs2x(wallet, OLD_PASSWORD));
      const before = await localText();
      await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD }), 'VAULT_CORRUPT');
      assert.equal(await vault.vaultExists(), false, String(mnemonic));
      assert.equal(await localText(), before, `${mnemonic}: nothing removed`);
      assert.equal(await vault.getStatus().then((s) => s.backoffUntil), null, 'the password was right: no backoff');
    }
  });

  it('removeEarlier removes what 2.x left only once a vault exists; Import alone keeps it', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    await rejectsWith(vault.removeEarlier(), 'NO_VAULT');
    assert.equal((await localKeys()).length, KEYS_2X.length - 1, 'nothing removed without a vault (wallet was never written)');
    await vault.importVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
    const status = await vault.getStatus();
    assert.equal(status.exists, true);
    assert.equal(status.earlier, true, 'an import keeps the earlier wallet until the user confirms its removal');
    assert.deepEqual(await vault.removeEarlier(), { removed: true });
    assert.deepEqual(await localKeys(), []);
    assert.equal((await vault.getStatus()).earlier, false);
  });

  it('what 2.x left with no wallet record it can open goes with the new vault', async () => {
    await env.chrome.storage.local.set({ mainnet: false, currentNetwork: 'solana', encryptedWallet: 'wallet_created' });
    await vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
    assert.deepEqual(await localKeys(), []);
  });

  it('parses only the 2.x record shape, at a bounded iteration count', () => {
    const bytes = (n, value = 1) => Array(n).fill(value);
    const good = { encrypted: bytes(40), salt: bytes(16), iv: bytes(12), version: 1 };
    assert.equal(earlier.parseEarlierWallet(good).iterations, 100000);
    assert.equal(earlier.parseEarlierWallet({ ...good, version: 2 }).iterations, 600000);
    assert.equal(earlier.parseEarlierWallet({ ...good, iterations: 310000 }).iterations, 310000);
    for (const bad of [null, 'wallet_created', '', [], { ...good, iv: bytes(16) }, { ...good, salt: bytes(4) }, { ...good, encrypted: bytes(8) },
      { ...good, encrypted: [...bytes(39), 256] }, { ...good, iterations: 999 }, { ...good, iterations: 1e9 }, { ...good, iterations: '100000' }]) {
      assert.equal(earlier.parseEarlierWallet(bad), null, JSON.stringify(bad)?.slice(0, 60));
    }
    assert.deepEqual([...earlier.EARLIER_KEYS].sort(), [...KEYS_2X].sort());
  });
});

// 2.x pages' bytes: base64 of the UTF-8 of a string whose characters are the bytes (their safeBase64Encode).
const pagesBase64 = (bytes) => btoa(unescape(encodeURIComponent(String.fromCharCode(...bytes))));

// The copy 2.1.3's setup and popup kept in IndexedDB 'QNetWallet' (store 'vault', key 'main'): the phrase and the keys,
// each sealed with AES-256-GCM under PBKDF2-SHA256 (100,000 iterations) of the password; phrase null for a copy without it.
async function pagesCopy(phrase, password, { salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const seal = async (text) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text)));
    return { data: pagesBase64(sealed), iv: pagesBase64(iv), timestamp: 1_700_000_000_000 };
  };
  return {
    version: '4.0.0',
    addresses: { eon: 'eonAAAAAAAAAAA', solana: KAT_SOLANA },
    encryptedKeys: await seal(JSON.stringify({ eon: pagesBase64(Array(32).fill(3)), solana: pagesBase64(Array(32).fill(4)) })),
    encryptedSeedPhrase: phrase === null ? null : await seal(phrase),
    salt: pagesBase64(salt),
    iterations: 100000,
    algorithm: 'AES-GCM-256',
  };
}

const PAGES_DB = 'QNetWallet';
const seedPages = (copy) => env.idb.seed(PAGES_DB, 1, { vault: { main: copy } });
const pagesLeft = () => env.idb.dump(PAGES_DB) !== null;

describe('vault: the pages\' copy of the earlier wallet (M-4)', () => {
  it('a status read never creates the database; the copy alone is named, moved by its password, and both copies go', async () => {
    assert.equal((await vault.getStatus()).earlier, false);
    assert.equal(pagesLeft(), false, 'asking creates no database');
    seedPages(await pagesCopy(KAT_MNEMONIC, OLD_PASSWORD));
    assert.equal((await vault.getStatus()).earlier, true);
    // closed once its read transaction completes
    for (let i = 0; i < 5 && env.idb.openConnections(PAGES_DB) > 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.idb.openConnections(PAGES_DB), 0, 'the read closes its connection');
    await rejectsWith(vault.migrateEarlier({ password: 'wrong' }), 'BAD_PASSWORD');
    assert.equal(pagesLeft(), true, 'a wrong password removes nothing');
    const result = await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(result.qnet, KAT_EON);
    assert.equal(result.solana, KAT_SOLANA);
    assert.equal(pagesLeft(), false, 'the pages\' database is deleted with the move');
    assert.equal((await vault.getStatus()).earlier, false);
    assert.equal((await vault.reveal({ password: NEW_PASSWORD })).mnemonic, KAT_MNEMONIC);
  });

  it('after a password change made in 2.x the record opens with the first password and the copy with the current one', async () => {
    const CHANGED = 'changed in 2.1.3';
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    seedPages(await pagesCopy(KAT_MNEMONIC, CHANGED));
    const before = await localText();
    assert.deepEqual(await vault.migrateEarlier({ password: CHANGED }), { checked: true });
    assert.deepEqual(await vault.migrateEarlier({ password: OLD_PASSWORD }), { checked: true });
    await rejectsWith(vault.migrateEarlier({ password: 'neither' }), 'BAD_PASSWORD');
    assert.equal(await localText(), before);
    assert.equal(pagesLeft(), true);
    assert.equal((await vault.migrateEarlier({ password: CHANGED, newPassword: NEW_PASSWORD })).qnet, KAT_EON);
    assert.deepEqual(await localKeys(), []);
    assert.equal(pagesLeft(), false);
  });

  it('a record that opens with no valid phrase falls back to the copy; the record wins when both hold one', async () => {
    await seed2x(await encryptAs2x(wallet2x('abandon abandon abandon'), OLD_PASSWORD));
    seedPages(await pagesCopy(KAT_MNEMONIC, OLD_PASSWORD));
    assert.equal((await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD })).qnet, KAT_EON);
    env.unsubscribe();
    env = await reset(w);
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    seedPages(await pagesCopy(`${'abandon '.repeat(23)}art`, OLD_PASSWORD));
    assert.equal((await vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD })).qnet, KAT_EON);
    env.unsubscribe();
    env = await reset(w);
    seedPages(await pagesCopy('not a phrase', OLD_PASSWORD));
    await rejectsWith(vault.migrateEarlier({ password: OLD_PASSWORD, newPassword: NEW_PASSWORD }), 'VAULT_CORRUPT');
    assert.equal(pagesLeft(), true, 'an unreadable copy is kept');
  });

  it('removeEarlier and a wipe delete the pages\' database too; a copy without a phrase goes with a new vault', async () => {
    await seed2x(await encryptAs2x(wallet2x(), OLD_PASSWORD));
    seedPages(await pagesCopy(KAT_MNEMONIC, OLD_PASSWORD));
    await vault.importVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
    assert.equal(pagesLeft(), true, 'an import keeps both copies until the user confirms');
    assert.deepEqual(await vault.removeEarlier(), { removed: true });
    assert.deepEqual(await localKeys(), []);
    assert.equal(pagesLeft(), false);
    seedPages(await pagesCopy(KAT_MNEMONIC, OLD_PASSWORD));
    assert.deepEqual(await vault.wipe({ password: PASSWORD, confirm: 'DELETE' }), { wiped: true });
    assert.equal(pagesLeft(), false, 'Delete wallet leaves no earlier copy behind');
    seedPages(await pagesCopy(null, OLD_PASSWORD));
    assert.equal((await vault.getStatus()).earlier, false, 'a copy without the phrase opens nothing');
    await vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
    assert.equal(pagesLeft(), false);
  });

  it('parses only the copy\'s shape: base64 of the bytes\' UTF-8, bounded', () => {
    const salt = Uint8Array.from([0, 1, 0x7f, 0x80, 0xc3, 0xff, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    const sealed = { data: pagesBase64(Array(40).fill(0xe9)), iv: pagesBase64(Array(12).fill(0x80)) };
    const good = { salt: pagesBase64(salt), encryptedSeedPhrase: sealed };
    const parsed = earlier.parseEarlierCopy(good);
    assert.deepEqual([...parsed.salt], [...salt], 'bytes from 0x80 up come back from their UTF-8 form');
    assert.deepEqual([...parsed.iv], Array(12).fill(0x80));
    assert.equal(parsed.iterations, 100000);
    const wide = btoa(unescape(encodeURIComponent('Ā'.repeat(16))));
    for (const bad of [null, [], {}, { ...good, encryptedSeedPhrase: null }, { ...good, salt: pagesBase64(Array(8).fill(1)) },
      { ...good, salt: wide }, { ...good, salt: '!!not base64!!' }, { ...good, encryptedSeedPhrase: { ...sealed, iv: pagesBase64(Array(16).fill(1)) } },
      { ...good, encryptedSeedPhrase: { ...sealed, data: pagesBase64(Array(600).fill(1)) } },
      { ...good, encryptedSeedPhrase: { ...sealed, data: 42 } }]) {
      assert.equal(earlier.parseEarlierCopy(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
    assert.deepEqual({ ...earlier.EARLIER_DB }, { NAME: PAGES_DB, STORE: 'vault', KEY: 'main' });
  });
});

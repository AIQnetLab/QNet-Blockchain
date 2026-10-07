// Vault (CONTRACTS.md section 5; spec Vault; R01-R05, R15, R16, R20, EXT-SEC-M2, M3, 21): the record
// format, KDF floor, tamper and wrong-password refusal, backoff, the one-activation invariant, password
// change, reveal and wipe. Argon2id runs through the cheap stand-in of helpers/vault-session-core.mjs;
// test/vault-session-kdf.test.mjs checks the real one.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KAT_EON, KAT_MNEMONIC, KAT_SOLANA, NEW_PASSWORD, PASSWORD, fakeClock, loadWorker, overwriteRecord, rejectsWith, reset,
  storedRecord,
} from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, keys, core, config } = w;
const { VAULT_DB, STORAGE_KEYS, LIMITS } = config;

// A second valid EON (genesis wallet 001) and Solana address, for records that name another wallet.
const OTHER_EON = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const OTHER_SOLANA = core.KAT.activation.solanaAddress;
const BURN_TX = core.KAT.activation.burnTx;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let env;
beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
});
after(() => env?.unsubscribe());

const record = () => storedRecord(env.idb, config);
const b64 = (text) => core.base64Decode(text);
const create = () => vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });

function activation(nodeType = 'light', solanaAddress = KAT_SOLANA, burnAmount = 1500) {
  return {
    code: core.generateActivationCode(nodeType, solanaAddress, BURN_TX, burnAmount),
    nodeType,
    burnTx: BURN_TX,
    burnAmount,
    solanaAddress,
    cluster: 'devnet',
    createdAt: 1_700_000_000_000,
  };
}

function pendingTransfer(nonce) {
  return {
    nonce: String(nonce),
    to: OTHER_EON,
    amountNano: '1500000000',
    feeNano: '315000',
    body: `{"nonce":${nonce}}`,
    txHash: null,
    createdAt: 1_700_000_000_000,
    lastSubmitAt: 1_700_000_000_000,
    outcome: 'pending',
    kind: 'transfer',
    call: null,
  };
}

async function tamper(mutate) {
  const copy = structuredClone(record());
  mutate(copy);
  await overwriteRecord(env.idb, config, copy);
}

function flipByte(text, index = 0) {
  const bytes = b64(text);
  bytes[index] ^= 1;
  return core.base64Encode(bytes);
}

describe('vault: pure parts', () => {
  it('canonicalJson sorts keys and refuses what JSON cannot carry exactly', () => {
    assert.equal(vault.canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":-2,"z":0}}');
    for (const bad of [1.5, 2 ** 53, 1n, undefined, () => 1, new Date(0), Uint8Array.of(1), { a: undefined }]) {
      assert.throws(() => vault.canonicalJson(bad), { code: 'INTERNAL' });
    }
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => vault.canonicalJson(cycle), { code: 'INTERNAL' });
  });

  // The rule of both wallets (owner decision of 2026-09-28): a new password needs 8 characters as typed, nothing else;
  // the password of an existing vault is only normalized.
  it('normalizes passwords with NFKC; a new one needs 8 characters and nothing else', () => {
    assert.equal(vault.normalizePassword('ﬁle ＡＢＣ'), 'file ABC');
    assert.equal(vault.normalizePassword('short'), 'short', 'an existing password is only normalized');
    assert.throws(() => vault.normalizePassword(''), { code: 'BAD_PASSWORD' });
    assert.throws(() => vault.normalizePassword('x'.repeat(1025)), { code: 'BAD_PASSWORD' });
    for (const bad of ['', 'seven77', '1234567', null, undefined, 12345678, 'x'.repeat(1025)]) {
      assert.throws(() => vault.normalizeNewPassword(bad), { code: 'WEAK_PASSWORD' }, String(bad));
    }
    for (const password of [
      '12345678', 'password', 'aaaaaaaa', ' '.repeat(8), 'qwertyuiop12', 'Metallica123', 'P@ssw0rd2024', 'Здравствуйте',
      'ichliebedich', '🔑🔑🔑🔑', PASSWORD,
    ]) {
      assert.equal(vault.normalizeNewPassword(password), password.normalize('NFKC'), password);
    }
    assert.equal(vault.normalizeNewPassword('ｑｕａｎｔｕｍ ｏｔｔｅｒ'), 'quantum otter');
  });

  it('takes any password of 8 characters on every path that sets one, and refuses a shorter one first', async () => {
    await rejectsWith(vault.createVault({ mnemonic: KAT_MNEMONIC, password: 'seven77' }), 'WEAK_PASSWORD');
    await rejectsWith(vault.importVault({ mnemonic: KAT_MNEMONIC, password: 'seven77' }), 'WEAK_PASSWORD');
    await rejectsWith(vault.writeNewVault(core.mnemonicToEntropy(KAT_MNEMONIC), 'seven77'), 'WEAK_PASSWORD');
    assert.equal(await vault.vaultExists(), false);
    await vault.createVault({ mnemonic: KAT_MNEMONIC, password: '12345678' });
    assert.equal(await session.isUnlocked(), true);
    await rejectsWith(vault.changePassword({ password: '12345678', newPassword: 'seven77' }), 'WEAK_PASSWORD');
    assert.deepEqual(await vault.changePassword({ password: '12345678', newPassword: 'Metallica123' }), { changed: true });
    await session.lock('user');
    await vault.unlock({ password: 'Metallica123' });
    assert.equal(await session.isUnlocked(), true);
  });

  it('opens an existing vault with the password it was made with, whatever its length', async () => {
    await create();
    const original = record();
    const kdf = { ...vault.KDF_DEFAULT, salt: core.base64Encode(new Uint8Array(16).fill(7)) };
    const key = await vault.deriveVaultKey(vault.normalizePassword('abc'), kdf);
    const sealed = await vault.sealRecord(key, {
      kdf, walletId: original.aad.walletId, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA,
      createdAt: original.aad.createdAt, sitesKey: original.sitesKey,
    }, core.mnemonicToEntropy(KAT_MNEMONIC), vault.emptyState());
    await overwriteRecord(env.idb, config, sealed);
    await session.lock('user');
    await vault.unlock({ password: 'abc' });
    assert.equal(await session.isUnlocked(), true);
  });

  it('refuses KDF parameters below the floor on every path', () => {
    const salt = core.base64Encode(new Uint8Array(16));
    vault.assertKdfFloor({ ...vault.KDF_DEFAULT, salt });
    vault.assertKdfFloor({ alg: 'pbkdf2-sha256', iterations: 600000, salt });
    for (const kdf of [
      { ...vault.KDF_DEFAULT, m: 32768, salt },
      { ...vault.KDF_DEFAULT, t: 2, salt },
      { ...vault.KDF_DEFAULT, p: 2, salt },
      { ...vault.KDF_DEFAULT },
      { alg: 'pbkdf2-sha256', iterations: 599999, salt },
      { alg: 'scrypt', N: 1 << 20, r: 8, p: 1, salt },
      null,
    ]) {
      assert.throws(() => vault.assertKdfFloor(kdf), { code: 'KDF_BELOW_FLOOR' }, JSON.stringify(kdf));
    }
    assert.deepEqual({ ...vault.KDF_DEFAULT }, { alg: 'argon2id', m: 65536, t: 3, p: 1 });
  });

  it('encodes the plaintext as version, entropy and canonical state, and decodes it strictly', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const state = { ...vault.emptyState(), activation: activation() };
    const bytes = vault.encodePlaintext(entropy, state);
    assert.equal(bytes[0], vault.PLAINTEXT_VERSION);
    assert.equal(bytes[1], 16);
    assert.deepEqual(bytes.slice(2, 18), entropy);
    const decoded = vault.decodePlaintext(bytes);
    assert.deepEqual(decoded.entropy, entropy);
    assert.deepEqual(decoded.state, state);

    const text = new TextDecoder().decode(bytes.subarray(18));
    const variant = (json, head = bytes.subarray(0, 18)) => {
      const tail = new TextEncoder().encode(json);
      const out = new Uint8Array(head.length + tail.length);
      out.set(head);
      out.set(tail, head.length);
      return out;
    };
    const rejects = (b) => assert.throws(() => vault.decodePlaintext(b), { code: 'VAULT_CORRUPT' });
    rejects(variant(text.replace(':', ': ')));
    rejects(variant(text.replace('"settings"', '"extra":1,"settings"')));
    rejects(variant(text.replace(activation().code, activation('super').code)));
    rejects(variant(`${text}x`));
    rejects(variant(text, Uint8Array.of(2, 16, ...entropy)));
    rejects(variant(text, Uint8Array.of(3, 20, ...entropy, 0, 0, 0, 0)));
    assert.throws(() => vault.encodePlaintext(new Uint8Array(20), vault.emptyState()), { code: 'INTERNAL' });
    assert.throws(() => vault.encodePlaintext(entropy, { ...vault.emptyState(), extra: 1 }), { code: 'INTERNAL' });
  });

  it('reads the state of an earlier 3.0.0 build with empty recipients and no burn height', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const { code: _code, ...burn } = activation('super');
    // a pending transfer of that build had no outcome and no kind yet: it reads as a QNC transfer still pending
    const { outcome: _outcome, kind: _kind, call: _call, ...transfer } = pendingTransfer(1);
    const before = { activation: null, pendingBurn: burn, pendingTransfers: [transfer], settings: { autoLockMinutes: 30 } };
    const bytes = Uint8Array.of(vault.PLAINTEXT_VERSION, 16, ...entropy, ...new TextEncoder().encode(vault.canonicalJson(before)));
    assert.deepEqual(vault.decodePlaintext(bytes).state, {
      ...before, pendingBurn: { ...burn, lastValidBlockHeight: null }, pendingTransfers: [pendingTransfer(1)], recipients: [],
      legacy: null, solanaRecipients: [], recentTransfers: [], exposedAdvice: false, supersededBurn: null, registration: null, spends: [],
    });
    // a state of the build before the Solana recipients and the recent transfers (R3-EXT-UI-03, R3-EXTQ-01), and before
    // the key exposedAdvice, the superseded burn (XP-R5-03) and the spend records
    const six = { ...vault.emptyState(), recipients: [OTHER_EON] };
    delete six.solanaRecipients;
    delete six.recentTransfers;
    delete six.exposedAdvice;
    delete six.supersededBurn;
    delete six.registration;
    delete six.spends;
    const older = Uint8Array.of(vault.PLAINTEXT_VERSION, 16, ...entropy, ...new TextEncoder().encode(vault.canonicalJson(six)));
    assert.deepEqual(vault.decodePlaintext(older).state,
      { ...six, solanaRecipients: [], recentTransfers: [], exposedAdvice: false, supersededBurn: null, registration: null, spends: [] });
  });

  // What a send counts above a certified state: the most each recent transaction of this wallet can take, by nonce.
  it('keeps the spend records of recent transactions and refuses malformed ones', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const spend = (fields = {}) => ({
      nonce: '7', qncNano: '1000150000', token: null, tokenAmount: null, tokenUnknown: false, settledAt: null, ...fields,
    });
    const spends = [spend(), spend({ nonce: '8', qncNano: '1511025', token: OTHER_EON, tokenAmount: '2500000', settledAt: 1700000000000 }),
      spend({ nonce: '9', qncNano: '4507800', tokenUnknown: true })];
    const state = { ...vault.emptyState(), spends };
    assert.deepEqual(vault.decodePlaintext(vault.encodePlaintext(entropy, state)).state, state);
    const tooMany = Array.from({ length: LIMITS.SPENDS_MAX + 1 }, (_, i) => spend({ nonce: String(i + 1) }));
    for (const bad of [[spend({ nonce: '07' })], [spend({ qncNano: '-1' })], [spend({ token: OTHER_EON })], [spend({ tokenAmount: '5' })],
      [spend({ token: 'nope', tokenAmount: '5' })], [spend({ tokenUnknown: 'yes' })], [spend({ token: OTHER_EON, tokenAmount: '5', tokenUnknown: true })],
      [spend({ settledAt: -1 })], [{ ...spend(), extra: 1 }], tooMany, null]) {
      assert.throws(() => vault.encodePlaintext(entropy, { ...vault.emptyState(), spends: bad }), { code: 'INTERNAL' }, JSON.stringify(bad)?.slice(0, 120));
      const text = vault.canonicalJson({ ...vault.emptyState(), spends: bad });
      assert.throws(() => vault.decodePlaintext(Uint8Array.of(vault.PLAINTEXT_VERSION, 16, ...entropy, ...new TextEncoder().encode(text))),
        { code: 'VAULT_CORRUPT' });
    }
  });

  it('checks the exposedAdvice key, the superseded burn and the refused outcome (XP-R5-03, R5-EXTQ-02)', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const { code: _code, ...burn } = activation('light');
    const superseded = { ...burn, burnTx: burn.burnTx };
    const good = {
      ...vault.emptyState(), exposedAdvice: true, supersededBurn: superseded,
      pendingTransfers: [{ ...pendingTransfer(1), outcome: 'refused' }],
    };
    assert.deepEqual(vault.decodePlaintext(vault.encodePlaintext(entropy, good)).state, good);
    for (const bad of [
      { exposedAdvice: 'yes' },
      { supersededBurn: { ...superseded, lastValidBlockHeight: 1 } },
      { supersededBurn: { ...superseded, burnAmount: 0 } },
      { supersededBurn: { ...superseded, nodeType: 'full' } },
    ]) {
      assert.throws(() => vault.encodePlaintext(entropy, { ...good, ...bad }), { code: 'INTERNAL' }, JSON.stringify(bad).slice(0, 80));
    }
  });

  it('reads a pending record of the build before calls as a transfer, and checks a call record\'s own part', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const { kind: _kind, call: _call, ...before } = { ...pendingTransfer(1), outcome: 'refused' };
    const earlier = { ...vault.emptyState(), pendingTransfers: [before] };
    const bytes = Uint8Array.of(vault.PLAINTEXT_VERSION, 16, ...entropy, ...new TextEncoder().encode(vault.canonicalJson(earlier)));
    assert.deepEqual(vault.decodePlaintext(bytes).state.pendingTransfers, [{ ...pendingTransfer(1), outcome: 'refused' }]);
    const tokenCall = { ...pendingTransfer(2), amountNano: '10000000', kind: 'call', call: { method: 'transfer', recipient: OTHER_EON, amount: '5' } };
    const wasmCall = { ...pendingTransfer(3), amountNano: '0', kind: 'call', call: { method: 'play_move', recipient: null, amount: null } };
    const good = { ...vault.emptyState(), pendingTransfers: [tokenCall, wasmCall] };
    assert.deepEqual(vault.decodePlaintext(vault.encodePlaintext(entropy, good)).state, good);
    assert.deepEqual(vault.PENDING_KINDS, ['transfer', 'call']);
    for (const bad of [
      { ...pendingTransfer(1), kind: 'deploy' },
      { ...pendingTransfer(1), call: wasmCall.call },
      { ...wasmCall, call: null },
      { ...wasmCall, call: { ...wasmCall.call, method: '1bad' } },
      { ...wasmCall, call: { ...wasmCall.call, recipient: OTHER_EON } },
      { ...tokenCall, call: { ...tokenCall.call, amount: '0' } },
      { ...tokenCall, call: { ...tokenCall.call, extra: 1 } },
    ]) {
      assert.throws(() => vault.encodePlaintext(entropy, { ...good, pendingTransfers: [bad] }), { code: 'INTERNAL' }, JSON.stringify(bad.call));
    }
  });

  it('checks the Solana recipients, the recent transfers and the passed outcome (R3-EXT-UI-03, R3-EXTQ-01, R3-EXTQ-04)', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const recent = { to: OTHER_EON, amountNano: '5', createdAt: 1_700_000_000_000 };
    const good = {
      ...vault.emptyState(), solanaRecipients: [OTHER_SOLANA], recentTransfers: [recent],
      pendingTransfers: [{ ...pendingTransfer(1), outcome: 'passed' }],
    };
    assert.deepEqual(vault.decodePlaintext(vault.encodePlaintext(entropy, good)).state, good);
    for (const bad of [
      { solanaRecipients: [OTHER_SOLANA, OTHER_SOLANA] },
      { solanaRecipients: [OTHER_EON] },
      { recentTransfers: [{ ...recent, extra: 1 }] },
      { recentTransfers: [{ ...recent, amountNano: '-1' }] },
      { recentTransfers: Array.from({ length: vault.RECENT_TRANSFERS_MAX + 1 }, () => recent) },
      { pendingTransfers: [{ ...pendingTransfer(1), outcome: 'confirmed' }] },
    ]) {
      assert.throws(() => vault.encodePlaintext(entropy, { ...good, ...bad }), { code: 'INTERNAL' }, JSON.stringify(bad).slice(0, 80));
    }
    // the newest recent transfers, none older than RECENT_TRANSFER_MS
    let state = vault.emptyState();
    state = vault.withRecentTransfer(state, { to: OTHER_EON, amountNano: '1', createdAt: 1000 });
    state = vault.withRecentTransfer(state, { to: OTHER_EON, amountNano: '2', createdAt: 1000 + vault.RECENT_TRANSFER_MS + 1 });
    assert.deepEqual(state.recentTransfers.map((r) => r.amountNano), ['2'], 'the old one went');
    assert.deepEqual(vault.withSolanaRecipient(vault.withSolanaRecipient(vault.emptyState(), OTHER_SOLANA), OTHER_SOLANA).solanaRecipients, [OTHER_SOLANA]);
  });

  it('checks the recipients, and keeps the key legacy null (ES-01)', () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i);
    const good = { ...vault.emptyState(), recipients: [OTHER_EON] };
    assert.deepEqual(vault.decodePlaintext(vault.encodePlaintext(entropy, good)).state, good);
    for (const bad of [
      { recipients: [OTHER_EON, OTHER_EON] },
      { recipients: ['not an address'] },
      { recipients: Array.from({ length: vault.RECIPIENTS_MAX + 1 }, () => OTHER_EON) },
      { legacy: { qnetAddress: OTHER_EON, solanaAddress: OTHER_SOLANA } },
      { legacy: {} },
    ]) {
      assert.throws(() => vault.encodePlaintext(entropy, { ...good, ...bad }), { code: 'INTERNAL' }, JSON.stringify(bad).slice(0, 80));
    }
  });

  it('keeps the newest recipients, each once, own address never (ES-01)', () => {
    let state = vault.emptyState();
    state = vault.withRecipient(state, OTHER_EON);
    state = vault.withRecipient(state, KAT_EON);
    state = vault.withRecipient(state, OTHER_EON);
    assert.deepEqual(state.recipients, [KAT_EON, OTHER_EON], 'moved to the end, not repeated');
    assert.deepEqual(vault.emptyState().recipients, [], 'the input is not changed');
    let many = vault.emptyState();
    const fake = (i) => `recipient-${i}`;
    for (let i = 0; i < vault.RECIPIENTS_MAX + 5; i += 1) many = vault.withRecipient(many, fake(i));
    assert.equal(many.recipients.length, vault.RECIPIENTS_MAX);
    assert.equal(many.recipients.at(-1), fake(vault.RECIPIENTS_MAX + 4));
    assert.equal(many.recipients.includes(fake(0)), false, 'the oldest drop out');
  });
});

describe('vault: create and import', () => {
  it('writes one AAD-bound record with the default Argon2id and starts the session', async () => {
    const before = Date.now();
    const result = await create();
    assert.equal(result.qnet, KAT_EON);
    assert.equal(result.solana, KAT_SOLANA);
    assert.ok(result.lockDeadline >= before + 15 * 60000 && result.lockDeadline <= Date.now() + 15 * 60000);

    const stored = record();
    assert.deepEqual(Object.keys(stored).sort(), ['aad', 'ct', 'iv', 'kdf', 'sitesKey', 'v']);
    assert.equal(stored.v, 3);
    assert.deepEqual({ ...stored.kdf, salt: undefined }, { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: undefined });
    assert.equal(b64(stored.kdf.salt).length, 16);
    assert.equal(b64(stored.iv).length, 12);
    assert.equal(b64(stored.sitesKey).length, 32);
    assert.deepEqual(Object.keys(stored.aad).sort(),
      ['activationNodeType', 'createdAt', 'kdf', 'legacy', 'qnetAddress', 'solanaAddress', 'v', 'walletId']);
    assert.equal(stored.aad.legacy, null, 'a key of the record format, always null');
    assert.deepEqual(stored.aad.kdf, stored.kdf);
    assert.equal(stored.aad.qnetAddress, KAT_EON);
    assert.equal(stored.aad.solanaAddress, KAT_SOLANA);
    assert.equal(stored.aad.activationNodeType, null);
    assert.match(stored.aad.walletId, UUID_RE);
    assert.deepEqual(w.kdfCalls, [{ m: 65536, t: 3, p: 1, dkLen: 32, saltBytes: 16 }], 'one KDF run per create');

    const text = JSON.stringify(stored);
    for (const secret of ['abandon', PASSWORD, core.base64Encode(new Uint8Array(16)), '00000000000000000000000000000000']) {
      assert.ok(!text.includes(secret), `record must not contain ${secret}`);
    }
    assert.deepEqual(env.chrome.storage.local.dump(), {}, 'nothing in storage.local');
    const mirror = env.chrome.storage.session.dump()[STORAGE_KEYS.SESSION];
    assert.deepEqual(Object.keys(mirror).sort(),
      ['autoLockMinutes', 'key', 'lockDeadline', 'qnetAddress', 'solanaAddress', 'v', 'walletId']);
    assert.ok(!JSON.stringify(env.chrome.storage.session.dump()).includes('abandon'));
    assert.deepEqual(await session.requireUnlocked(),
      { walletId: stored.aad.walletId, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA, lockDeadline: result.lockDeadline });
    assert.deepEqual(env.changes, [{ locked: false, reason: 'unlock' }]);
    assert.deepEqual(env.idb.uncaught, []);
  });

  it('create takes the setup phrase as it is; import canonicalizes whitespace and case to the same wallet', async () => {
    await assert.rejects(vault.createVault({ mnemonic: ` ${KAT_MNEMONIC}`, password: PASSWORD }), { code: 'INVALID_MNEMONIC' });
    await assert.rejects(vault.createVault({ mnemonic: KAT_MNEMONIC.replace('about', 'abandon'), password: PASSWORD }),
      { code: 'INVALID_MNEMONIC' });
    await assert.rejects(vault.importVault({ mnemonic: KAT_MNEMONIC.split(' ').slice(0, 11).join(' '), password: PASSWORD }),
      { code: 'INVALID_MNEMONIC' });
    for (const variant of [
      KAT_MNEMONIC.toUpperCase(),
      `\n ${KAT_MNEMONIC.split(' ').join('\r\n')}\t`,
      KAT_MNEMONIC.split(' ').join('   '),
    ]) {
      env.unsubscribe();
      env = await reset(w);
      const result = await vault.importVault({ mnemonic: variant, password: PASSWORD });
      assert.deepEqual([result.qnet, result.solana], [KAT_EON, KAT_SOLANA]);
      assert.equal((await vault.reveal({ password: PASSWORD })).mnemonic, KAT_MNEMONIC, 'the canonical phrase is stored');
    }
  });

  it('accepts a 24-word phrase', async () => {
    const entropy = core.generateEntropy(24);
    const phrase = core.entropyToMnemonic(entropy);
    const expected = keys.deriveAddresses(entropy);
    const result = await vault.createVault({ mnemonic: phrase, password: PASSWORD });
    assert.deepEqual([result.qnet, result.solana], [expected.qnetAddress, expected.solanaAddress]);
    assert.deepEqual(await vault.readEntropy(), entropy);
  });

  it('refuses to create or import over an existing vault and leaves it untouched (R11)', async () => {
    await create();
    const before = record();
    await session.lock('user');
    await rejectsWith(create(), 'VAULT_EXISTS');
    await rejectsWith(vault.importVault({ mnemonic: KAT_MNEMONIC, password: NEW_PASSWORD }), 'VAULT_EXISTS');
    const entropy = core.mnemonicToEntropy(KAT_MNEMONIC);
    await rejectsWith(vault.writeNewVault(entropy, NEW_PASSWORD), 'VAULT_EXISTS');
    assert.deepEqual(record(), before);
    assert.equal(await session.isUnlocked(), false);
  });

  it('refuses a short password before anything is written', async () => {
    await rejectsWith(vault.createVault({ mnemonic: KAT_MNEMONIC, password: 'seven77' }), 'WEAK_PASSWORD');
    assert.deepEqual(await env.idb.databases(), []);
    assert.equal(w.kdfCalls.length, 0);
  });

  it('fails closed when the write does not commit or cannot be read back (EXT-SEC-M2)', async () => {
    env.idb.inject('commit', 'QuotaExceededError');
    await rejectsWith(create(), 'INTERNAL');
    assert.equal(record(), null);
    assert.equal(await session.isUnlocked(), false);

    // gets: vaultExists, the existence check inside the write, then the read-back
    env.idb.inject('get', 'UnknownError', { skip: 2 });
    await rejectsWith(create(), 'INTERNAL');
    assert.equal(record(), null, 'a record that failed its check is removed again');
    assert.equal(await session.isUnlocked(), false);

    await create();
    assert.equal(await session.isUnlocked(), true);
  });
});

describe('vault: unlock', () => {
  it('decrypts with the right password, re-derives the addresses and starts the session', async () => {
    await create();
    await session.lock('user');
    w.kdfCalls.length = 0;
    const result = await vault.unlock({ password: PASSWORD });
    assert.deepEqual([result.qnet, result.solana], [KAT_EON, KAT_SOLANA]);
    assert.equal(w.kdfCalls.length, 1);
    assert.equal(await session.isUnlocked(), true);
  });

  it('always decrypts, also while unlocked: a wrong password never passes (EXT-SEC-M3)', async () => {
    await create();
    w.kdfCalls.length = 0;
    await rejectsWith(vault.unlock({ password: 'not the password' }), 'BAD_PASSWORD');
    assert.equal(w.kdfCalls.length, 1, 'the wrong password went through the KDF and the decrypt');
    await rejectsWith(vault.unlock({ password: `${PASSWORD} ` }), 'BAD_PASSWORD');
  });

  it('answers NO_VAULT without a vault', async () => {
    await rejectsWith(vault.unlock({ password: PASSWORD }), 'NO_VAULT');
    assert.deepEqual(await env.idb.databases(), [], 'asking does not create the database');
  });

  it('backs off after three free failures, shared by every password check, and resets on success', async () => {
    const clock = fakeClock(1_800_000_000_000);
    try {
      await create();
      await session.lock('user');
      for (let i = 0; i < 4; i += 1) await rejectsWith(vault.unlock({ password: 'wrong password!' }), 'BAD_PASSWORD');
      const calls = w.kdfCalls.length;
      const error = await rejectsWith(vault.unlock({ password: PASSWORD }), 'BACKOFF');
      assert.equal(error.retryAfterMs, 1000);
      await rejectsWith(vault.verifyPassword(PASSWORD), 'BACKOFF');
      assert.equal(w.kdfCalls.length, calls, 'no KDF work while backing off');
      assert.equal((await vault.getStatus()).backoffUntil, 1_800_000_001_000);
      clock.tick(1000);
      await rejectsWith(vault.verifyPassword('wrong again!!'), 'BAD_PASSWORD');
      const second = await rejectsWith(vault.unlock({ password: PASSWORD }), 'BACKOFF');
      assert.equal(second.retryAfterMs, 2000, 'the delay doubles');
      clock.tick(2000);
      await vault.unlock({ password: PASSWORD });
      assert.equal((await vault.getStatus()).backoffUntil, null);
      assert.equal(env.chrome.storage.session.dump()[STORAGE_KEYS.BACKOFF], undefined);
    } finally {
      clock.restore();
    }
  });

  it('refuses a record whose KDF is below the floor before running it', async () => {
    await create();
    await session.lock('user');
    await tamper((r) => {
      r.kdf.m = 32768;
      r.aad.kdf.m = 32768;
    });
    w.kdfCalls.length = 0;
    await rejectsWith(vault.unlock({ password: PASSWORD }), 'KDF_BELOW_FLOOR');
    await rejectsWith(vault.verifyPassword(PASSWORD), 'KDF_BELOW_FLOOR');
    assert.equal(w.kdfCalls.length, 0);
  });

  it('fails on any change to the AAD, ciphertext, IV or KDF parameters (R03)', async () => {
    await create();
    await session.lock('user');
    const original = record();
    const authFailures = {
      'aad.qnetAddress': (r) => {
        r.aad.qnetAddress = OTHER_EON;
      },
      'aad.solanaAddress': (r) => {
        r.aad.solanaAddress = OTHER_SOLANA;
      },
      'aad.walletId': (r) => {
        r.aad.walletId = '6f1c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
      },
      'aad.createdAt': (r) => {
        r.aad.createdAt += 1;
      },
      'aad.activationNodeType': (r) => {
        r.aad.activationNodeType = 'light';
      },
      ct: (r) => {
        r.ct = flipByte(r.ct, 5);
      },
      'ct tag': (r) => {
        r.ct = flipByte(r.ct, b64(r.ct).length - 1);
      },
      iv: (r) => {
        r.iv = flipByte(r.iv);
      },
      'kdf raised in record and aad': (r) => {
        r.kdf.t = 4;
        r.aad.kdf.t = 4;
      },
      'kdf salt in record and aad': (r) => {
        r.kdf.salt = flipByte(r.kdf.salt);
        r.aad.kdf.salt = r.kdf.salt;
      },
    };
    for (const [name, mutate] of Object.entries(authFailures)) {
      await overwriteRecord(env.idb, config, original);
      await tamper(mutate);
      await rejectsWith(vault.unlock({ password: PASSWORD }), 'BAD_PASSWORD').catch((e) => assert.fail(`${name}: ${e.message}`));
      assert.equal(await session.isUnlocked(), false, name);
      await session.recordPasswordSuccess();
    }
    const malformed = {
      'record.kdf differs from aad.kdf': (r) => {
        r.kdf.t = 4;
      },
      'unknown record key': (r) => {
        r.extra = 1;
      },
      'record version': (r) => {
        r.v = 2;
      },
      'short sitesKey': (r) => {
        r.sitesKey = core.base64Encode(new Uint8Array(16));
      },
      'short iv': (r) => {
        r.iv = core.base64Encode(new Uint8Array(8));
      },
      'invalid address in aad': (r) => {
        r.aad.qnetAddress = `${KAT_EON.slice(0, -1)}0`;
      },
      'absurd KDF cost': (r) => {
        r.kdf.m = 2 ** 31;
        r.aad.kdf.m = 2 ** 31;
      },
    };
    for (const [name, mutate] of Object.entries(malformed)) {
      await overwriteRecord(env.idb, config, original);
      await tamper(mutate);
      await rejectsWith(vault.unlock({ password: PASSWORD }), 'VAULT_CORRUPT').catch((e) => assert.fail(`${name}: ${e.message}`));
    }
    await overwriteRecord(env.idb, config, original);
    await vault.unlock({ password: PASSWORD });
  });

  it('refuses a record whose AAD names addresses the entropy does not derive (R20)', async () => {
    await create();
    const original = record();
    const kdf = { ...vault.KDF_DEFAULT, salt: core.base64Encode(new Uint8Array(16).fill(9)) };
    const key = await vault.deriveVaultKey(PASSWORD, kdf);
    const forged = await vault.sealRecord(key, {
      kdf, walletId: original.aad.walletId, qnetAddress: OTHER_EON, solanaAddress: KAT_SOLANA,
      createdAt: original.aad.createdAt, sitesKey: original.sitesKey,
    }, core.mnemonicToEntropy(KAT_MNEMONIC), vault.emptyState());
    await overwriteRecord(env.idb, config, forged);
    await rejectsWith(vault.unlock({ password: PASSWORD }), 'ADDRESS_MISMATCH');
    assert.equal(await session.isUnlocked(), false, 'the running session is locked too');
    assert.equal(env.changes.at(-1).reason, 'error');
  });

  it('treats a missing database, a store-less database or a missing record as no vault, without hanging (EXT-SEC-21)', async () => {
    assert.equal(await vault.vaultExists(), false);
    assert.deepEqual(await env.idb.databases(), []);
    env.idb.seed(VAULT_DB.NAME, 1, {});
    assert.equal(await vault.vaultExists(), false);
    env.idb.seed(VAULT_DB.NAME, 1, { [VAULT_DB.STORE]: {} });
    assert.equal(await vault.vaultExists(), false);
    await rejectsWith(vault.unlock({ password: PASSWORD }), 'NO_VAULT');
    env.idb.seed(VAULT_DB.NAME, 2, { [VAULT_DB.STORE]: {} });
    await rejectsWith(vault.vaultExists(), 'VAULT_CORRUPT');
  });
});

describe('vault: the session key', () => {
  it('reads entropy and state only while unlocked', async () => {
    await create();
    assert.deepEqual(await vault.readEntropy(), new Uint8Array(16));
    assert.deepEqual(await vault.readState(), vault.emptyState());
    await session.lock('user');
    await rejectsWith(vault.readState(), 'LOCKED');
    await rejectsWith(vault.readEntropy(), 'LOCKED');
    await rejectsWith(vault.updateState((s) => s), 'LOCKED');
  });

  it('locks when the record stops decrypting or belongs to another wallet', async () => {
    await create();
    const original = record();
    await tamper((r) => {
      r.ct = flipByte(r.ct, 3);
    });
    await rejectsWith(vault.readState(), 'VAULT_CORRUPT');
    assert.equal(await session.isUnlocked(), false);
    assert.equal(env.changes.at(-1).reason, 'error');

    await overwriteRecord(env.idb, config, original);
    await vault.unlock({ password: PASSWORD });
    await tamper((r) => {
      r.aad.walletId = '6f1c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
    });
    await rejectsWith(vault.readEntropy(), 'VAULT_CORRUPT');
    assert.equal(await session.isUnlocked(), false);
  });
});

describe('vault: state updates (R15)', () => {
  it('stores one activation, binds its node type into the AAD and never replaces or removes it', async () => {
    await create();
    const ivBefore = record().iv;
    const stored = await vault.updateState((s) => ({ ...s, activation: activation('light') }));
    assert.deepEqual(stored.activation, activation('light'));
    assert.equal(record().aad.activationNodeType, 'light');
    assert.notEqual(record().iv, ivBefore, 'a fresh IV on every write');

    await rejectsWith(vault.updateState((s) => ({ ...s, activation: activation('super') })), 'ALREADY_ACTIVATED');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: activation('light', KAT_SOLANA, 300) })), 'ALREADY_ACTIVATED');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: null })), 'ALREADY_ACTIVATED');
    await rejectsWith(vault.updateState((s) => ({
      ...s, pendingBurn: { ...activation('super'), code: undefined },
    })), 'INTERNAL');
    const { code: _code, ...rest } = activation('super');
    const burn = { ...rest, lastValidBlockHeight: 1000 };
    await rejectsWith(vault.updateState((s) => ({ ...s, pendingBurn: burn })), 'ALREADY_ACTIVATED');

    const next = await vault.updateState((s) => ({ ...s, settings: { autoLockMinutes: 30 } }));
    assert.deepEqual(next.activation, activation('light'));
    await session.lock('user');
    await vault.unlock({ password: PASSWORD });
    assert.deepEqual((await vault.readState()).activation, activation('light'));
  });

  it('accepts only an activation of this wallet whose code matches its burn', async () => {
    await create();
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: activation('light', OTHER_SOLANA) })), 'INTERNAL');
    const wrongCode = { ...activation('light'), code: activation('super').code.replace('QNET-S', 'QNET-L') };
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: wrongCode })), 'INTERNAL');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: { ...activation(), extra: true } })), 'INTERNAL');
    assert.equal(record().aad.activationNodeType, null);
  });

  it('keeps the registration of the light activation of this wallet\'s own node only, and survives a relock', async () => {
    await create();
    const registration = {
      nodeId: core.lightNodeId(KAT_EON), burnTx: BURN_TX, burner: KAT_SOLANA, state: 'queued', attempts: 0, nextAt: 1,
      txHash: null, admittedAt: null, lastError: null, updatedAt: 1,
    };
    await rejectsWith(vault.updateState((s) => ({ ...s, registration })), 'INTERNAL', 'no registration without its activation');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: activation('super'), registration })), 'INTERNAL', 'never a super one');
    const stored = await vault.updateState((s) => ({ ...s, activation: activation('light'), registration }));
    assert.deepEqual(stored.registration, registration);
    for (const bad of [
      { nodeId: core.lightNodeId(OTHER_EON) }, { burner: OTHER_SOLANA }, { burnTx: 'x' }, { state: 'done' }, { attempts: -1 },
      { txHash: '' }, { lastError: 'Not A Code' }, { extra: 1 },
    ]) {
      await rejectsWith(vault.updateState((s) => ({ ...s, registration: { ...registration, ...bad } })), 'INTERNAL', JSON.stringify(bad));
    }
    const admitted = { ...registration, state: 'admitted', attempts: 1, txHash: 'ab'.repeat(32), admittedAt: 5, lastError: null };
    await vault.updateState((s) => ({ ...s, registration: admitted }));
    await session.lock('user');
    await vault.unlock({ password: PASSWORD });
    assert.deepEqual((await vault.readState()).registration, admitted);
    // dropping the record is allowed (the activation stays)
    assert.equal((await vault.updateState((s) => ({ ...s, registration: null }))).registration, null);
  });

  it('keeps a light burn aiqnet.io paid for this wallet only with the wallet\'s code and its registration on chain', async () => {
    await create();
    // the payment key burned; the code names this wallet (core.walletActivationCode), found through the registration record
    const paid = { ...activation('light', OTHER_SOLANA), code: core.walletActivationCode(KAT_EON, BURN_TX, 1500) };
    const registration = {
      nodeId: core.lightNodeId(KAT_EON), burnTx: BURN_TX, burner: OTHER_SOLANA, state: 'onchain', attempts: 0, nextAt: 1,
      txHash: null, admittedAt: null, lastError: null, updatedAt: 1,
    };
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: paid })), 'INTERNAL', 'not without its registration');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: paid, registration: { ...registration, state: 'queued' } })),
      'INTERNAL', 'only one the chain lists');
    const otherWallet = { ...paid, code: core.walletActivationCode(OTHER_EON, BURN_TX, 1500) };
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: otherWallet, registration })), 'INTERNAL', 'another wallet\'s code');
    const ownAddress = { ...activation('light'), code: paid.code };
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: ownAddress, registration: { ...registration, burner: KAT_SOLANA } })),
      'INTERNAL', 'a burn of the wallet\'s own address keeps the burner\'s code');
    const superPaid = { ...activation('super', OTHER_SOLANA), code: paid.code.replace('QNET-L', 'QNET-S') };
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: superPaid })), 'INTERNAL', 'never a super one');

    const stored = await vault.updateState((s) => ({ ...s, activation: paid, registration }));
    assert.deepEqual([stored.activation, stored.registration], [paid, registration]);
    await rejectsWith(vault.updateState((s) => ({ ...s, registration: null })), 'INTERNAL', 'its registration stays');
    await rejectsWith(vault.updateState((s) => ({ ...s, registration: { ...registration, state: 'queued' } })), 'INTERNAL');
    await session.lock('user');
    await vault.unlock({ password: PASSWORD });
    assert.deepEqual((await vault.readState()).activation, paid);
  });

  it('keeps one pending burn until it resolves into the activation', async () => {
    await create();
    const { code: _code, ...rest } = activation('super');
    const burn = { ...rest, lastValidBlockHeight: 250_000_000 };
    await rejectsWith(vault.updateState((s) => ({ ...s, pendingBurn: rest })), 'INTERNAL', 'a new pending burn keeps its lastValidBlockHeight');
    await vault.updateState((s) => ({ ...s, pendingBurn: burn }));
    await rejectsWith(vault.updateState((s) => ({ ...s, pendingBurn: { ...burn, burnAmount: 300 } })), 'BURN_IN_PROGRESS');
    await rejectsWith(vault.updateState((s) => ({ ...s, activation: activation('super') })), 'ALREADY_ACTIVATED');
    const done = await vault.updateState((s) => ({ ...s, pendingBurn: null, activation: activation('super') }));
    assert.equal(done.pendingBurn, null);
    assert.equal(record().aad.activationNodeType, 'super');
  });

  it('validates the new state, serializes concurrent updates and skips writes that change nothing', async () => {
    await create();
    await rejectsWith(vault.updateState((s) => ({ ...s, extra: 1 })), 'INTERNAL');
    await rejectsWith(vault.updateState((s) => ({ ...s, settings: { autoLockMinutes: 0 } })), 'INTERNAL');
    await rejectsWith(vault.updateState((s) => ({ ...s, recipients: [KAT_EON] })), 'INTERNAL', 'never its own address');
    await rejectsWith(vault.updateState((s) => ({ ...s, legacy: { qnetAddress: OTHER_EON, solanaAddress: OTHER_SOLANA } })), 'INTERNAL',
      'the key legacy stays null');
    await rejectsWith(vault.updateState((s) => ({
      ...s, pendingTransfers: Array.from({ length: 17 }, (_, i) => pendingTransfer(i + 1)),
    })), 'INTERNAL');
    await rejectsWith(vault.updateState(() => {
      throw new Error('mutator failed');
    }).catch((error) => {
      throw Object.assign(error, { code: 'MUTATOR' });
    }), 'MUTATOR');

    const push = (nonce) => vault.updateState(async (s) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { ...s, pendingTransfers: [...s.pendingTransfers, pendingTransfer(nonce)] };
    });
    await Promise.all([push(1), push(2), push(3)]);
    assert.deepEqual((await vault.readState()).pendingTransfers.map((p) => p.nonce), ['1', '2', '3']);

    const iv = record().iv;
    await vault.updateState((s) => s);
    assert.equal(record().iv, iv, 'no write for an unchanged state');
  });
});

describe('vault: password change, reveal, wipe', () => {
  it('changes the password with a fresh salt, key and IV, keeping identity and session (EXT-SEC-18)', async () => {
    await create();
    const before = record();
    const mirrorBefore = env.chrome.storage.session.dump()[STORAGE_KEYS.SESSION];
    await rejectsWith(vault.changePassword({ password: PASSWORD, newPassword: 'short' }), 'WEAK_PASSWORD');
    await rejectsWith(vault.changePassword({ password: 'wrong password', newPassword: NEW_PASSWORD }), 'BAD_PASSWORD');
    assert.deepEqual(record(), before);

    assert.deepEqual(await vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD }), { changed: true });
    const after = record();
    for (const field of ['walletId', 'qnetAddress', 'solanaAddress', 'createdAt', 'activationNodeType']) {
      assert.equal(after.aad[field], before.aad[field], field);
    }
    assert.equal(after.sitesKey, before.sitesKey);
    assert.notEqual(after.kdf.salt, before.kdf.salt);
    assert.notEqual(after.iv, before.iv);
    assert.notEqual(env.chrome.storage.session.dump()[STORAGE_KEYS.SESSION].key, mirrorBefore.key);
    assert.deepEqual(await vault.readState(), vault.emptyState(), 'the session key was swapped');

    await session.lock('user');
    await rejectsWith(vault.unlock({ password: PASSWORD }), 'BAD_PASSWORD');
    await vault.unlock({ password: NEW_PASSWORD });
    await session.lock('user');
    await rejectsWith(vault.changePassword({ password: NEW_PASSWORD, newPassword: PASSWORD }), 'LOCKED');
  });

  it('restores the old record when the new one cannot be read back', async () => {
    await create();
    const before = record();
    env.idb.inject('get', 'UnknownError', { skip: 1 });
    await rejectsWith(vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD }), 'INTERNAL');
    assert.deepEqual(record(), before);
    assert.deepEqual(await vault.readState(), vault.emptyState());
  });

  it('reveals the canonical phrase only after a fresh password check, and only while unlocked (R12)', async () => {
    await create();
    await rejectsWith(vault.reveal({ password: 'wrong password' }), 'BAD_PASSWORD');
    assert.deepEqual(await vault.reveal({ password: PASSWORD }), { mnemonic: KAT_MNEMONIC });
    await session.lock('user');
    await rejectsWith(vault.reveal({ password: PASSWORD }), 'LOCKED');
  });

  it('wipes the vault and every storage area after the password, and only then (R16, R24)', async () => {
    await create();
    await env.chrome.storage.local.set({ [STORAGE_KEYS.SITES]: { 'https://aiqnet.io': {} }, [STORAGE_KEYS.SETTINGS]: { language: 'en' } });
    const walletId = record().aad.walletId;
    await rejectsWith(vault.wipe({ password: 'wrong password', confirm: 'DELETE' }), 'BAD_PASSWORD');
    assert.ok(record());
    assert.equal(await session.isUnlocked(), true);

    assert.deepEqual(await vault.wipe({ password: PASSWORD, confirm: 'DELETE' }), { wiped: true });
    assert.deepEqual(await env.idb.databases(), []);
    assert.deepEqual(env.chrome.storage.local.dump(), {});
    assert.deepEqual(env.chrome.storage.session.dump(), {});
    assert.equal(await session.isUnlocked(), false);
    assert.equal(env.changes.at(-1).reason, 'wipe');
    assert.equal(await vault.vaultExists(), false);
    await rejectsWith(vault.wipe({ password: PASSWORD, confirm: 'DELETE' }), 'NO_VAULT');

    await create();
    assert.notEqual(record().aad.walletId, walletId, 'a new wallet is a new identity');
  });
});

describe('vault: durability and earlier records (EXT-VAULT-R2-03)', () => {
  it('every write commits with strict durability, reads with the default', async () => {
    await create();
    await vault.updateState((s) => ({ ...s, settings: { autoLockMinutes: 30 } }));
    await vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD });
    await vault.rotateSitesKey();
    const own = env.idb.transactions.filter((t) => t.name === VAULT_DB.NAME);
    assert.ok(own.some((t) => t.mode === 'readwrite'));
    for (const t of own) assert.equal(t.durability, t.mode === 'readwrite' ? 'strict' : 'default', JSON.stringify(t));
  });

  it('a record without the key legacy in its AAD opens, the unlock brings it up to date, and any other value is corrupt', async () => {
    await create();
    // an earlier 3.0.0 build's record: the same plaintext under an AAD without `legacy`
    const key = await vault.deriveVaultKey(vault.normalizePassword(PASSWORD), record().kdf);
    const opened = await vault.openRecord(record(), key);
    const old = await vault.sealRecord(key, {
      kdf: record().kdf, walletId: record().aad.walletId, qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA,
      createdAt: record().aad.createdAt, sitesKey: record().sitesKey,
    }, opened.entropy, opened.state);
    delete old.aad.legacy;
    // re-encrypt under the old AAD shape, as that build did
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = vault.encodePlaintext(opened.entropy, opened.state);
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(vault.canonicalJson(old.aad)), tagLength: 128 },
      cryptoKey, plaintext);
    await overwriteRecord(env.idb, config, { ...old, iv: core.base64Encode(iv), ct: core.base64Encode(new Uint8Array(ct)) });
    await session.lock('user');
    assert.equal(Object.hasOwn(record().aad, 'legacy'), false);
    await vault.unlock({ password: PASSWORD });
    assert.equal(record().aad.legacy, null, 'the unlock wrote the current AAD');
    assert.equal((await vault.readState()).legacy, null);
    for (const legacy of [{ qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA }, {}, false]) {
      assert.throws(() => vault.parseRecord({ ...record(), aad: { ...record().aad, legacy } }), { code: 'VAULT_CORRUPT' }, JSON.stringify(legacy));
    }
  });
});

// R3-ESM-03: the OS screen locks while the KDF of an unlock (or of a new vault) runs. lock('idle') finds no
// session then; the session must still never start behind the locked screen.
describe('vault: a screen lock while the password is checked (R3-ESM-03)', () => {
  it('an idle, user or startup lock during the KDF keeps the session from starting', async () => {
    const { kdfControl } = await import('./helpers/vault-session-core.mjs');
    await create();
    await session.lock('user');
    for (const reason of ['idle', 'user', 'startup']) {
      kdfControl.during = () => session.lock(reason);
      await rejectsWith(vault.unlock({ password: PASSWORD }), 'LOCKED');
      assert.equal(await session.isUnlocked(), false, reason);
      assert.equal(env.chrome.storage.session.dump()[STORAGE_KEYS.SESSION], undefined, 'no key mirrored behind the lock');
    }
    // a wipe-style or error lock of another request does not count; a later unlock works
    await vault.unlock({ password: PASSWORD });
    assert.equal(await session.isUnlocked(), true);
  });

  it('a screen the OS reports locked keeps the session from starting; a new vault is written and stays locked', async () => {
    env.chrome.idle.queryState = (seconds, callback) => callback('locked');
    try {
      const result = await create();
      assert.equal(result.lockDeadline, null);
      assert.equal(await vault.vaultExists(), true, 'the new vault is written');
      assert.equal(await session.isUnlocked(), false);
      await rejectsWith(vault.unlock({ password: PASSWORD }), 'LOCKED');
      env.chrome.idle.queryState = (seconds, callback) => callback('active');
      await vault.unlock({ password: PASSWORD });
      assert.equal(await session.isUnlocked(), true);
    } finally {
      delete env.chrome.idle.queryState;
    }
  });
});

describe('vault: kept burn searches (R2-ESA-02)', () => {
  it('keeps a search per owner under a MAC of the vault key; a foreign write or a new password drops it', async () => {
    await create();
    const scan = { v: 1, owner: KAT_SOLANA, found: [], unchecked: [{ signature: 'sig', slot: 5, seq: 1, blockTime: null }] };
    assert.equal(await vault.readBurnScan(KAT_SOLANA), null);
    await vault.writeBurnScan(KAT_SOLANA, scan);
    assert.deepEqual(await vault.readBurnScan(KAT_SOLANA), scan);
    await vault.writeBurnScan(OTHER_SOLANA, { v: 1, owner: OTHER_SOLANA });
    assert.deepEqual(await vault.readBurnScan(KAT_SOLANA), scan, 'two owners side by side');
    // a program with profile access skips a candidate: the MAC no longer verifies
    const dump = env.idb.dump(VAULT_DB.NAME).stores[VAULT_DB.STORE];
    const tampered = structuredClone(dump.burnScans);
    tampered.scans[KAT_SOLANA].unchecked = [];
    env.idb.seed(VAULT_DB.NAME, env.idb.dump(VAULT_DB.NAME).version, { [VAULT_DB.STORE]: { ...dump, burnScans: tampered } });
    assert.equal(await vault.readBurnScan(KAT_SOLANA), null);
    await vault.writeBurnScan(KAT_SOLANA, scan);
    await vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(await vault.readBurnScan(KAT_SOLANA), null, 'a new vault key starts every search again');
    await session.lock('user');
    await rejectsWith(vault.readBurnScan(KAT_SOLANA), 'LOCKED');
  });
});

describe('vault: status and site binding', () => {
  it('reports existence, lock state and addresses without the password', async () => {
    // earlier: no wallet of an earlier version is in this browser (vault-session-earlier has the rest)
    assert.deepEqual(await vault.getStatus(), {
      exists: false, unlocked: false, lockDeadline: null, addresses: null, signingEnabled: true, backoffUntil: null, earlier: false,
    });
    const { lockDeadline } = await create();
    assert.deepEqual(await vault.getStatus(), {
      exists: true, unlocked: true, lockDeadline, addresses: { qnet: KAT_EON, solana: KAT_SOLANA }, signingEnabled: true,
      backoffUntil: null, earlier: false,
    });
    await session.lock('user');
    const locked = await vault.getStatus();
    assert.equal(locked.unlocked, false);
    assert.equal(locked.addresses, null);
  });

  it('gives provider.js the wallet id and grant MAC key, also while locked', async () => {
    assert.equal(await vault.readSiteBinding(), null);
    await create();
    await session.lock('user');
    const binding = await vault.readSiteBinding();
    assert.equal(binding.walletId, record().aad.walletId);
    assert.deepEqual(binding.sitesKey, b64(record().sitesKey));
  });
});

describe('vault: time', () => {
  it('uses the stored auto-lock choice for the next unlock', async () => {
    const clock = fakeClock(1_900_000_000_000);
    try {
      await create();
      await vault.updateState((s) => ({ ...s, settings: { autoLockMinutes: 5 } }));
      await session.lock('user');
      const { lockDeadline } = await vault.unlock({ password: PASSWORD });
      assert.equal(lockDeadline, 1_900_000_000_000 + 5 * 60000);
    } finally {
      clock.restore();
    }
  });
});

describe('vault: the light client anchors', () => {
  it('keeps the verified anchors next to the vault under a MAC of its key, never without a session (EXT-CHAINS-04)', async () => {
    const anchor = { eligible_ids: ['node_001', 'node_002'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) };
    const anchors = { 23401: anchor };
    await rejectsWith(vault.writeLightAnchors(anchors), 'LOCKED');
    await create();
    assert.equal(await vault.readLightAnchors(), null, 'none kept yet');
    await vault.writeLightAnchors(anchors);
    assert.deepEqual(await vault.readLightAnchors(), anchors);
    for (const bad of [null, [], { 1: anchor, 2: anchor, 3: anchor }, { 1: { ...anchor, extra: 1 } }, { 1: { ...anchor, eligible_ids: [7] } }]) {
      await assert.rejects(vault.writeLightAnchors(bad), { code: 'INTERNAL' }, JSON.stringify(bad));
    }
    await session.lock('user');
    await rejectsWith(vault.readLightAnchors(), 'LOCKED');
    await vault.unlock({ password: PASSWORD });
    // written into the profile by anything but this vault's key: ignored, the walk starts from the pin
    const store = () => env.idb.dump(VAULT_DB.NAME).stores[VAULT_DB.STORE];
    const planted = structuredClone(store().lightAnchors);
    planted.anchors[23401].beacon = 'ee'.repeat(32);
    env.idb.seed(VAULT_DB.NAME, env.idb.dump(VAULT_DB.NAME).version, { [VAULT_DB.STORE]: { ...store(), lightAnchors: planted } });
    assert.equal(await vault.readLightAnchors(), null);
    await vault.writeLightAnchors(anchors);
    await vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(await vault.readLightAnchors(), null, 'a new password, a new MAC key');
    await vault.wipe({ password: NEW_PASSWORD, confirm: 'DELETE' });
    await rejectsWith(vault.readLightAnchors(), 'LOCKED');
  });
});

// Owner, 06.10: the popup draws the last verified balances at once, also right after an unlock: they are kept in the
// vault's chain cache with a MAC of its key, with the head of the chain the wallet follows; reading or writing it never
// locks the session.
describe('vault: the chain cache (owner, 06.10)', () => {
  const BALANCE = { balanceNano: '12500000000', spendableNano: '12500000000', nonce: '3', verified: true, verification: 'proof', blockHeight: null };

  it('keeps public chain data under a MAC of the vault key; a planted or old-password cache reads as none', async () => {
    await rejectsWith(vault.readChainCache(), 'LOCKED');
    await create();
    assert.deepEqual(await vault.readChainCache(), {}, 'none kept yet');
    assert.deepEqual(await vault.updateChainCache((cache) => ({ ...cache, headIndex: 1200 })), { headIndex: 1200 });
    assert.deepEqual(await vault.readChainCache(), { headIndex: 1200 });
    await assert.rejects(vault.updateChainCache(() => ({ big: 'x'.repeat(70000) })), { code: 'INTERNAL' });
    await assert.rejects(vault.updateChainCache(() => [1]), { code: 'INTERNAL' });
    const store = () => env.idb.dump(VAULT_DB.NAME).stores[VAULT_DB.STORE];
    const planted = structuredClone(store().chainCache);
    planted.cache.headIndex = 5;
    env.idb.seed(VAULT_DB.NAME, env.idb.dump(VAULT_DB.NAME).version, { [VAULT_DB.STORE]: { ...store(), chainCache: planted } });
    assert.deepEqual(await vault.readChainCache(), {}, "written without this vault's key: ignored");
    await vault.updateChainCache((cache) => ({ ...cache, headIndex: 1300 }));
    await vault.changePassword({ password: PASSWORD, newPassword: NEW_PASSWORD });
    assert.deepEqual(await vault.readChainCache(), {}, 'a new password, a new MAC key');
    await vault.wipe({ password: NEW_PASSWORD, confirm: 'DELETE' });
    await rejectsWith(vault.readChainCache(), 'LOCKED');
  });

  it('the last verified balances outlive the session: wallet.cached draws them after an unlock, never an unverified one', async () => {
    await create();
    await session.rememberView('qnetBalance', BALANCE);
    await session.rememberView('solanaBalances', { address: 'x', lamports: '5', oneDev: { raw: '0' } });
    await session.rememberView('qnetHistory', { items: [], cursor: null, pending: [] });
    await session.lock('user');
    await vault.unlock({ password: PASSWORD });
    const cached = await session.cachedViews();
    assert.deepEqual(cached.qnetBalance, BALANCE, 'drawn at once after the unlock');
    assert.deepEqual(cached.solanaBalances, { address: 'x', lamports: '5', oneDev: { raw: '0' } });
    assert.equal(cached.qnetHistory, null, "a history page is this session's only");
    // a balance no committee certificate verified is never kept, and a chain the wallet no longer follows takes its views along
    await session.rememberView('qnetBalance', { ...BALANCE, balanceNano: '1', verified: false, verification: 'none' });
    await session.lock('user');
    await vault.unlock({ password: PASSWORD });
    assert.deepEqual((await session.cachedViews()).qnetBalance, BALANCE);
    await session.forgetViews(['qnetBalance', 'qnetTokens', 'qnetHistory']);
    assert.equal((await session.cachedViews()).qnetBalance, null);
    assert.ok((await session.cachedViews()).solanaBalances !== null, 'the Solana balances stay');
  });
});

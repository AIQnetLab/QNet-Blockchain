// R24 (best effort): once the wallet locks, a V8 heap snapshot of the worker holds no recovery phrase,
// seed, entropy, password or vault key. The real worker modules (with the cheap KDF of the other vault
// tests) import a random wallet, unlock, sign with every signer, reveal and lock; then the snapshot is
// searched for text forms of those secrets. The test keeps the secrets only as bytes and builds the
// search strings after the snapshot, so it never holds one itself while the snapshot is taken. Byte
// buffers are not in a heap snapshot, which is why the worker zeroizes them instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { KAT_EON, loadWorker, reset } from './helpers/vault-session-env.mjs';

const worker = await loadWorker();
const { vault, session, keys, core, config } = worker;

const hexOf = (bytes) => Buffer.from(bytes).toString('hex');

describe('vault heap', () => {
  it('holds no phrase, seed, entropy, password or vault key after lock', async () => {
    const { chrome } = await reset(worker);
    const entropy = core.generateEntropy(12);
    const passwordBytes = crypto.getRandomValues(new Uint8Array(16));
    const probeBytes = crypto.getRandomValues(new Uint8Array(16));
    // A fresh flat string per call, dropped by the caller once the call is done. (A snapshot shows a
    // concatenation as its parts, so every search string here is one flat piece.)
    const password = () => hexOf(passwordBytes);
    const vaultKeys = [];
    const store = chrome.storage.session.set;
    chrome.storage.session.set = async (items) => {
      const mirrored = items[config.STORAGE_KEYS.SESSION];
      if (mirrored) vaultKeys.push(Buffer.from(mirrored.key, 'base64'));
      return store(items);
    };

    await vault.importVault({ mnemonic: core.entropyToMnemonic(entropy), password: password() });
    const { qnetAddress } = await session.requireUnlocked();
    await keys.signQnetTransfer({ from: qnetAddress, to: KAT_EON, amountNano: '1', nonce: '1', gasPrice: '10', gasLimit: '10000' });
    await keys.signSolanaMessage(Uint8Array.of(1, 2, 3));
    await keys.signOffchain('https://aiqnet.io', 'heap check');
    await session.lock('user');
    await vault.unlock({ password: password() });
    assert.equal(typeof (await vault.reveal({ password: password() })).mnemonic, 'string');
    await session.lock('user');
    assert.equal(await session.isUnlocked(), false);
    assert.ok(vaultKeys.length >= 2, 'the session mirror was written');
    // The positive control: a string the test does keep must be found.
    globalThis.heapProbe = hexOf(probeBytes);

    await new Promise((resolve) => setImmediate(resolve));
    const file = path.join(os.tmpdir(), `qnet-wallet-${process.pid}-${Date.now()}.heapsnapshot`);
    writeHeapSnapshot(file);
    let snapshot;
    try {
      snapshot = readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }

    assert.notEqual(snapshot.indexOf(hexOf(probeBytes)), -1, 'the snapshot shows the strings the process holds');
    const phrase = core.entropyToMnemonic(entropy);
    const seed = core.entropyToSeed(entropy);
    const solanaKey = core.deriveSolanaKeypair(seed).privateKey;
    const needles = {
      phrase,
      'first three words': phrase.split(' ').slice(0, 3).join(' '),
      'seed hex': hexOf(seed),
      'ML-DSA seed hex': hexOf(core.walletXi(seed)),
      'Solana key hex': hexOf(solanaKey),
      'Solana key base58': core.base58Encode(solanaKey),
      'entropy hex': hexOf(entropy),
      password: password(),
    };
    vaultKeys.forEach((key, index) => {
      needles[`vault key ${index} base64`] = key.toString('base64');
      needles[`vault key ${index} hex`] = key.toString('hex');
    });
    for (const [name, needle] of Object.entries(needles)) {
      assert.equal(snapshot.indexOf(needle), -1, `${name} is still in the heap after lock`);
    }
  });
});

// The faucet's own Solana transactions (src/server/solana-tx.ts, faucet-tx.ts, solana-rpc.ts), which replace
// @solana/web3.js and @solana/spl-token in the process holding FAUCET_PRIVATE_KEY. The vectors were made by
// those libraries (web3.js 1.95.3, spl-token 0.4.8): addresses, message and signed wire bytes must be equal.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  PACKET_DATA_SIZE,
  associatedTokenAddress,
  compileLegacyMessage,
  decodeKey,
  findProgramAddress,
  signLegacyTransaction,
  signerFromSecretKey,
  toBaseUnits,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '../../server/solana-tx.ts';
import { ONE_DEV_DECIMALS, SOL_DECIMALS, oneDevTransferInstructions, solTransferInstructions } from '../../server/faucet-tx.ts';
import { RpcError, confirmSignature, latestBlockhash, sendTransaction, solanaRpc } from '../../server/solana-rpc.ts';

const VECTORS = JSON.parse(readFileSync(new URL('./solana-tx.vectors.json', import.meta.url), 'utf8'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function secretKeyOf(seedHex) {
  const seed = Uint8Array.from(Buffer.from(seedHex, 'hex'));
  return [...seed, ...ed25519.getPublicKey(seed)];
}

test('associated token addresses and bumps equal spl-token\'s', () => {
  assert.equal(VECTORS.ata.length, 64);
  assert.ok(VECTORS.ata.some((v) => v.bump < 255), 'the vectors include bumps below 255');
  for (const v of VECTORS.ata) {
    assert.equal(associatedTokenAddress(v.mint, v.owner), v.ata, v.owner);
    const seeds = [decodeKey(v.owner), decodeKey(TOKEN_PROGRAM_ID), decodeKey(v.mint)];
    assert.equal(findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM_ID).bump, v.bump);
  }
});

test('the faucet\'s 1DEV and SOL transactions are byte-for-byte what web3.js and spl-token built', () => {
  assert.equal(VECTORS.txs.length, 6);
  for (const v of VECTORS.txs) {
    const signer = signerFromSecretKey(secretKeyOf(v.faucetSeed));
    assert.ok(signer);
    assert.equal(signer.publicKey, v.faucetPublicKey);
    const instructions = v.kind === '1DEV'
      ? oneDevTransferInstructions(signer.publicKey, v.recipient, toBaseUnits(v.amount, ONE_DEV_DECIMALS))
      : solTransferInstructions(signer.publicKey, v.recipient, toBaseUnits(v.amount, SOL_DECIMALS));
    assert.equal(b64(compileLegacyMessage(instructions, signer.publicKey, v.blockhash)), v.message, `${v.kind} ${v.amount} message`);
    const { wire, signature } = signLegacyTransaction(instructions, signer, v.blockhash);
    assert.equal(b64(wire), v.wire, `${v.kind} ${v.amount} wire`);
    assert.equal(signature, v.signature);
    assert.ok(wire.length <= PACKET_DATA_SIZE);
    // The signature verifies over the message with the faucet's public key.
    const message = Buffer.from(v.message, 'base64');
    assert.ok(ed25519.verify(bs58.decode(signature), message, decodeKey(signer.publicKey)));
  }
});

test('the secret key must be 64 bytes whose second half is the first half\'s public key', () => {
  const good = secretKeyOf(createHash('sha256').update('k').digest('hex'));
  assert.ok(signerFromSecretKey(good));
  const otherPub = [...good.slice(0, 32), ...good.slice(32).map((b, i) => (i === 0 ? b ^ 1 : b))];
  for (const bad of [
    null, 'x', good.slice(0, 63), [...good, 0], otherPub, good.map((b, i) => (i === 3 ? 256 : b)),
    good.map((b, i) => (i === 3 ? 1.5 : b)), good.map((b, i) => (i === 3 ? -1 : b)), good.map((b, i) => (i === 3 ? '7' : b)),
  ]) {
    assert.equal(signerFromSecretKey(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('keys and amounts are checked before anything is built', () => {
  assert.equal(decodeKey('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk').length, 32);
  for (const bad of ['', '0OIl', '1111', 'x'.repeat(45), null, 42, 'z'.repeat(44)]) {
    assert.equal(decodeKey(bad), null, String(bad));
  }
  assert.equal(toBaseUnits(1500, 6), 1_500_000_000n);
  assert.equal(toBaseUnits(0.001, 9), 1_000_000n);
  for (const bad of [0, -1, Number.NaN, Infinity, 1e-12, '5', 1e30]) assert.equal(toBaseUnits(bad, 9), null, String(bad));
  const signer = signerFromSecretKey(secretKeyOf('11'.repeat(32)));
  assert.throws(() => compileLegacyMessage(solTransferInstructions(signer.publicKey, 'not-a-key', 1n), signer.publicKey, VECTORS.txs[0].blockhash));
  assert.throws(() => oneDevTransferInstructions(signer.publicKey, 'not-a-key', 1n));
  assert.throws(() => compileLegacyMessage([], signer.publicKey, VECTORS.txs[0].blockhash));
  assert.throws(() => compileLegacyMessage(solTransferInstructions(signer.publicKey, VECTORS.txs[0].recipient, 1n), signer.publicKey, 'bad'));
  assert.throws(() => solTransferInstructions(signer.publicKey, VECTORS.txs[0].recipient, -1n));
  assert.throws(() => solTransferInstructions(signer.publicKey, VECTORS.txs[0].recipient, 1n << 64n));
});

// A scripted RPC: each method answers from its queue (a function, a value, or an Error to throw).
function scripted(answers) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    const queue = answers[method];
    if (!queue || queue.length === 0) throw new Error(`unexpected ${method}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(params) : next;
  };
  return { rpc, calls };
}

const status = (confirmationStatus, err = null) => ({ value: [{ confirmationStatus, err }] });
const none = { value: [null] };
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};

test('confirmation: confirmed lands, an on-chain error fails, expiry with no trace fails, a deadline is unknown', async () => {
  const sig = VECTORS.txs[0].signature;
  let { rpc } = scripted({ getSignatureStatuses: [none, status('processed'), status('confirmed')], getBlockHeight: [100] });
  assert.deepEqual(await confirmSignature(rpc, sig, 200, clock()), { status: 'landed' });

  ({ rpc } = scripted({ getSignatureStatuses: [status('processed', { InstructionError: [3, 'Custom'] })], getBlockHeight: [100] }));
  assert.equal((await confirmSignature(rpc, sig, 200, clock())).status, 'failed');

  ({ rpc } = scripted({ getSignatureStatuses: [none], getBlockHeight: [201] }));
  assert.deepEqual(await confirmSignature(rpc, sig, 200, clock()), { status: 'failed', reason: 'blockhash_expired' });

  // Landed in its last valid block: seen on the second look after the expiry.
  ({ rpc } = scripted({ getSignatureStatuses: [none, status('confirmed')], getBlockHeight: [201] }));
  assert.deepEqual(await confirmSignature(rpc, sig, 200, clock()), { status: 'landed' });

  // Processed but not confirmed at expiry: not a failure yet; it then confirms.
  ({ rpc } = scripted({ getSignatureStatuses: [status('processed'), status('processed'), status('finalized')], getBlockHeight: [201] }));
  assert.deepEqual(await confirmSignature(rpc, sig, 200, clock()), { status: 'landed' });

  // The RPC keeps failing: never taken as an answer; the deadline makes it unknown.
  ({ rpc } = scripted({ getSignatureStatuses: [new Error('down')], getBlockHeight: [new Error('down')] }));
  assert.deepEqual(await confirmSignature(rpc, sig, 200, { ...clock(), timeoutMs: 10_000 }), { status: 'unknown', reason: 'confirmation_timeout' });

  // Still valid and nowhere at the deadline: unknown, because it may still land.
  ({ rpc } = scripted({ getSignatureStatuses: [none], getBlockHeight: [150] }));
  assert.equal((await confirmSignature(rpc, sig, 200, { ...clock(), timeoutMs: 10_000 })).status, 'unknown');
});

test('sending: a JSON-RPC error is a refusal; no answer is unknown, never a refusal', async () => {
  const wire = Uint8Array.of(1, 2, 3);
  let { rpc, calls } = scripted({ sendTransaction: ['sig'] });
  assert.deepEqual(await sendTransaction(rpc, wire), { state: 'sent' });
  assert.deepEqual(calls[0].params, ['AQID', { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }]);
  ({ rpc } = scripted({ sendTransaction: [new RpcError(-32002, 'Transaction simulation failed')] }));
  assert.deepEqual(await sendTransaction(rpc, wire), { state: 'refused', error: 'Transaction simulation failed' });
  ({ rpc } = scripted({ sendTransaction: [new Error('timeout')] }));
  assert.deepEqual(await sendTransaction(rpc, wire), { state: 'unknown' });
});

test('the RPC client: JSON-RPC errors, HTTP errors and malformed answers are told apart', async () => {
  const seen = [];
  const answer = (status, body) => async (url, init) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  let rpc = solanaRpc('https://rpc.example', { fetchFn: answer(200, { jsonrpc: '2.0', id: 1, result: 7 }) });
  assert.equal(await rpc('getBlockHeight', [{ commitment: 'confirmed' }]), 7);
  assert.deepEqual(JSON.parse(seen[0].init.body), { jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] });
  assert.equal(seen[0].init.redirect, 'error');

  rpc = solanaRpc('https://rpc.example', { fetchFn: answer(200, { error: { code: -32002, message: 'nope' } }) });
  await assert.rejects(rpc('sendTransaction', []), (e) => e instanceof RpcError && e.code === -32002);
  rpc = solanaRpc('https://rpc.example', { fetchFn: answer(503, 'busy') });
  await assert.rejects(rpc('sendTransaction', []), (e) => !(e instanceof RpcError));
  rpc = solanaRpc('https://rpc.example', { fetchFn: answer(200, { jsonrpc: '2.0', id: 1 }) });
  await assert.rejects(rpc('getBlockHeight', []), (e) => !(e instanceof RpcError));

  rpc = solanaRpc('https://rpc.example', {
    fetchFn: answer(200, { result: { value: { blockhash: VECTORS.txs[0].blockhash, lastValidBlockHeight: 99 } } }),
  });
  assert.deepEqual(await latestBlockhash(rpc), { blockhash: VECTORS.txs[0].blockhash, lastValidBlockHeight: 99 });
  rpc = solanaRpc('https://rpc.example', { fetchFn: answer(200, { result: { value: { blockhash: 'x', lastValidBlockHeight: 99 } } }) });
  await assert.rejects(latestBlockhash(rpc));
});

test('no server code imports @solana/web3.js or @solana/spl-token', () => {
  const route = readFileSync(new URL('../../app/api/faucet/claim/route.ts', import.meta.url), 'utf8');
  for (const src of [route, ...['solana-tx.ts', 'solana-rpc.ts', 'faucet-tx.ts'].map((f) => readFileSync(new URL(`../../server/${f}`, import.meta.url), 'utf8'))]) {
    assert.doesNotMatch(src, /from ['"]@solana\/|import\(['"]@solana\/|require\(['"]@solana\//);
  }
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  for (const name of ['@solana/web3.js', '@solana/spl-token']) {
    assert.equal(pkg.dependencies[name], undefined, name);
    assert.equal(pkg.devDependencies[name], undefined, name);
  }
});

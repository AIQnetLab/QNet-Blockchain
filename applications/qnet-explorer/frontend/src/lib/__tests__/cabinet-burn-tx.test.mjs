// The node cabinet's Solana transactions (src/lib/cabinet/burn-tx.ts, src/lib/solana-message.ts,
// src/lib/cabinet/payment-key.ts): the burn and the refund equal what @solana/web3.js builds and signs
// (cabinet-tx.vectors.json), the payment key signs them under WebCrypto (a burn only under the wallet's reservation of
// that amount, with enough of it left), and the site reads each back as its shape and nothing else; a transfer from the
// faucet wallet into a payment address (the vectors' `fundings`) is no cabinet shape.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { compileLegacyMessage, parseLegacyTransaction, signaturesValid, singleSignerWire, associatedTokenAddress } from '../solana-message.ts';
import { BURN_FEE_LAMPORTS, burnInstructions, classifyCabinetTx, refundInstructions, refundLamports, oneDevAccountOf } from '../cabinet/burn-tx.ts';
import { ONE_DEV_MINT } from '../one-dev.ts';
import { signBurn, signRefund } from '../cabinet/payment-key.ts';
import { SIGN_MARGIN_MS } from '../cabinet/burn-record.ts';

const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const NOW = 1_790_000_000_000;
// The wallet's reservation the burn is made under.
const held = (amount, over = {}) => ({ id: 'a'.repeat(32), wallet: WALLET, until: NOW + 600_000, amount, ...over });

const V = JSON.parse(readFileSync(new URL('./cabinet-tx.vectors.json', import.meta.url), 'utf8'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (text) => Uint8Array.from(Buffer.from(text, 'base64'));
const seedOf = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const subtle = globalThis.crypto.subtle;

// A WebCrypto Ed25519 key from a test seed, non-extractable, as the payment key is.
async function paymentKey(seedHex) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
  return subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

// The wallet's signed reservation the record holds (its form only: the site checks the signature).
const hold = { wallet: WALLET, pk: 'p', sig: 's', time: 1 };
const record = async (seedHex, pub, stage) => ({
  v: 1, pub, key: await paymentKey(seedHex), network: 'testnet', createdAt: 1, updatedAt: 1, stage,
  burn: null, link: null, answer: null, submit: null, refund: null, wallet: WALLET, hold,
});

test('the burn equals web3.js\'s: message, wire and id, signed with noble and with the WebCrypto payment key', async () => {
  assert.equal(V.burns.length, 4);
  for (const v of V.burns) {
    const seed = seedOf(v.payerSeed);
    assert.equal(bs58.encode(ed25519.getPublicKey(seed)), v.payer);
    assert.equal(oneDevAccountOf(v.payer), v.payerAccount);
    const message = compileLegacyMessage(burnInstructions(v.payer, v.whole), v.payer, v.blockhash);
    assert.equal(b64(message), v.message, v.payer);
    const wire = singleSignerWire(ed25519.sign(message, seed), message);
    assert.equal(b64(wire), v.wire);
    const signed = await signBurn({ ...await record(v.payerSeed, v.payer, 'funded'), reservation: held(v.whole) }, v.whole, v.blockhash, subtle, NOW);
    assert.equal(b64(signed.wire), v.wire);
    assert.equal(signed.signature, v.signature);
  }
  // Only a funded record burns, and only a whole amount within the node's bound.
  const v = V.burns[0];
  await assert.rejects(signBurn({ ...await record(v.payerSeed, v.payer, 'funding'), reservation: held(v.whole) }, v.whole, v.blockhash, subtle, NOW), /stage/);
  // R6 and A1: the payment key signs a burn only under the reservation of the wallet that signed the record's hold, of
  // that very amount, with at least SIGN_MARGIN_MS of it left: none, one about to end or ended, another amount, no wallet
  // in it, another wallet than the hold's, or no hold, and nothing is signed.
  const funded = await record(v.payerSeed, v.payer, 'funded');
  for (const [name, reservation] of [
    ['none', undefined],
    ['about to end', held(v.whole, { until: NOW + SIGN_MARGIN_MS - 1 })],
    ['ended', held(v.whole, { until: NOW - 1 })],
    ['another amount', held(v.whole + 1)],
    ['no wallet', held(v.whole, { wallet: '' })],
    ['another wallet than the hold\'s', held(v.whole, { wallet: 'e'.repeat(64) })],
  ]) await assert.rejects(signBurn({ ...funded, reservation }, v.whole, v.blockhash, subtle, NOW), /reservation/, name);
  await assert.rejects(signBurn({ ...funded, hold: undefined, reservation: held(v.whole) }, v.whole, v.blockhash, subtle, NOW), /reservation/, 'no hold');
  assert.equal((await signBurn({ ...funded, reservation: held(v.whole, { until: NOW + SIGN_MARGIN_MS }) }, v.whole, v.blockhash, subtle, NOW)).signature, v.signature);
  for (const bad of [0, 1.5, 1_000_000_001, -1]) assert.throws(() => burnInstructions(v.payer, bad), RangeError);
  // The fee the page waits for: one signature and the priority fee of 60 000 units at 20 000 micro-lamports.
  assert.equal(BURN_FEE_LAMPORTS, 6_200n);
});

test('the refund equals web3.js\'s in each case, with what it leaves for the SOL transfer', async () => {
  for (const v of V.refunds) {
    const plan = { oneDevRaw: BigInt(v.plan.oneDevRaw), accountExists: v.plan.accountExists, lamports: BigInt(v.plan.lamports), destAccountExists: v.plan.destAccountExists };
    assert.equal(String(refundLamports(plan)), v.transferLamports);
    const message = compileLegacyMessage(refundInstructions(v.payer, v.dest, plan), v.payer, v.blockhash);
    assert.equal(b64(message), v.message, v.dest);
    const signed = await signRefund(await record(v.payerSeed, v.payer, 'leftovers'), v.dest, plan, v.blockhash, subtle);
    assert.equal(b64(signed.wire), v.wire);
    assert.equal(signed.signature, v.signature);
  }
  const v = V.refunds[0];
  await assert.rejects(signRefund(await record(v.payerSeed, v.payer, 'onChain'), v.dest, { oneDevRaw: 1n, accountExists: true, lamports: 1n, destAccountExists: true }, v.blockhash, subtle), /stage/);
  assert.throws(() => refundInstructions(v.payer, v.payer, { oneDevRaw: 1n, accountExists: true, lamports: 9_000_000n, destAccountExists: true }), RangeError);
  assert.throws(() => refundInstructions(v.payer, v.dest, { oneDevRaw: 0n, accountExists: false, lamports: 5_000n, destAccountExists: true }), RangeError);
});

test('read back: each vector parses, its signature verifies, and it is its shape; a faucet transfer is no cabinet shape', () => {
  for (const v of V.burns) {
    const tx = parseLegacyTransaction(fromB64(v.wire));
    assert.ok(tx && signaturesValid(tx));
    assert.equal(tx.feePayer, v.payer);
    assert.equal(tx.blockhash, v.blockhash);
    assert.equal(b64(tx.message), v.message);
    assert.deepEqual(classifyCabinetTx(tx), { kind: 'burn', payer: v.payer, whole: v.whole });
  }
  for (const v of V.refunds) {
    const tx = parseLegacyTransaction(fromB64(v.wire));
    assert.ok(tx && signaturesValid(tx));
    const shape = classifyCabinetTx(tx);
    assert.equal(shape.kind, 'refund');
    assert.equal(shape.dest, v.dest);
    assert.equal(shape.oneDevRaw, BigInt(v.plan.oneDevRaw));
    assert.equal(shape.lamports, BigInt(v.transferLamports));
  }
  // 1DEV and SOL from the faucet wallet into a payment address, in one transaction: the send route forwards none.
  const funding = parseLegacyTransaction(fromB64(V.fundings[0].wire));
  assert.ok(funding && signaturesValid(funding));
  assert.equal(funding.feePayer, V.fundings[0].faucet);
  assert.equal(classifyCabinetTx(funding), null);
  // A flipped bit in the message breaks the signature; trailing bytes, a truncation or a versioned message do not parse.
  const wire = fromB64(V.burns[0].wire);
  const flipped = wire.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.equal(signaturesValid(parseLegacyTransaction(flipped)), false);
  assert.equal(parseLegacyTransaction(Uint8Array.of(...wire, 0)), null);
  assert.equal(parseLegacyTransaction(wire.slice(0, wire.length - 1)), null);
  const versioned = wire.slice();
  versioned[65] = 0x80;
  assert.equal(parseLegacyTransaction(versioned), null);
  assert.equal(parseLegacyTransaction(new Uint8Array(1233)), null);
});

test('the 1DEV accounts are the associated token accounts of the one mint', () => {
  for (const v of V.burns) assert.equal(oneDevAccountOf(v.payer), associatedTokenAddress(ONE_DEV_MINT, v.payer));
});

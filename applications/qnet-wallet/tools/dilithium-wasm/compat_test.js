/**
 * Cross-implementation contract test for the extension's ML-DSA-65 bundle.
 *
 * Pins the two things the node actually checks on a QNet value TX:
 *   1. the SIGNED BYTES  — the chain-bound canonical preimage
 *                          `q{chain}|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}`
 *                          (node: BlockchainNode::build_canonical_verify_message, Transfer arm)
 *   2. the WIRE FORMAT   — hex of the RAW 3309-byte detached signature (6618 hex chars), which the
 *                          node hex-decodes and feeds to verify_detached_signature.
 * Plus the golden wallet-derivation vector shared with the Rust node
 * (genesis_key.rs::wallet_cross_client_kat_vector) and the mobile app.
 *
 * Run: node tools/dilithium-wasm/compat_test.js   (from the qnet-wallet root)
 */
'use strict';

const { webcrypto } = require('node:crypto');
const nodeCrypto = webcrypto || globalThis.crypto;

const fs   = require('fs');
const vm   = require('vm');
const code = fs.readFileSync(__dirname + '/../../dist/lib/noble-pq-ml-dsa.js', 'utf8');
const ctx  = { QNetDilithiumLib: null, crypto: nodeCrypto, TextEncoder, TextDecoder, btoa, atob };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const lib = ctx.QNetDilithiumLib.QNetDilithium;
let passed = 0, failed = 0;

function check(label, got, expected) {
    if (got === expected) {
        console.log('[PASS] ' + label + ': ' + got);
        passed++;
    } else {
        console.error('[FAIL] ' + label + ': got=' + got + ' expected=' + expected);
        failed++;
    }
}

// ── Sizes (FIPS 204 ML-DSA-65) ────────────────────────────────────────────────
check('PK_SIZE', lib.PK_SIZE, 1952);
check('SK_SIZE', lib.SK_SIZE, 4032);
check('SIG_SIZE', lib.SIG_SIZE, 3309);

// ── Deterministic keygen ──────────────────────────────────────────────────────
const seed = new Uint8Array(32).fill(77);
const kA   = lib.keygen(seed);
const kB   = lib.keygen(seed);
check('keygen_deterministic',
      Buffer.from(kA.publicKey).equals(Buffer.from(kB.publicKey)), true);
check('keygen_pk_size', kA.publicKey.length, 1952);
check('keygen_sk_size', kA.secretKey.length, 4032);

// ── Golden wallet derivation (must match the Rust node + mobile) ──────────────
const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = lib.deriveWallet(TEST_MNEMONIC);
check('kat_xi', wallet.xi,
      '5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6');
check('kat_eon', wallet.address, 'd9fa370374e24333242eon847d1d354dcd87fe873823e');
check('kat_address_from_pk', lib.addressFromPublicKey(wallet.publicKey), wallet.address);

// ── Canonical transfer preimage + wire format ─────────────────────────────────
// Byte-identical to the string background.js signs and the node rebuilds.
const CHAIN_TAG = 'q1337|';
const from      = wallet.address;
const to        = 'd9fa370374e24333242eon847d1d354dcd87fe873823f';
const amount    = 1500000000;   // integer nano-QNC
const nonce     = 1;            // committed account nonce + 1
const gasPrice  = 10;
const gasLimit  = 21000;
const message   = `${CHAIN_TAG}transfer:${from}:${to}:${amount}:${nonce}:${gasPrice}:${gasLimit}`;

check('preimage_chain_bound', message.startsWith('q1337|transfer:'), true);

const sigHex = lib.signQNet(message, wallet.secretKey, wallet.publicKey);
check('wire_is_hex', /^[0-9a-f]+$/.test(sigHex), true);
check('wire_hex_len', sigHex.length, 6618);            // 3309 raw bytes, hex-encoded
check('wire_has_no_envelope', sigHex.includes('_'), false);

const rawSig = Uint8Array.from(Buffer.from(sigHex, 'hex'));
check('wire_raw_len', rawSig.length, 3309);
const msgBytes = new TextEncoder().encode(message);
check('verify_detached_valid',
      lib.verify(msgBytes, rawSig, Uint8Array.from(Buffer.from(wallet.publicKey, 'hex'))), true);

// Tampered amount must not verify — this is what binds the transfer to its fields.
const tampered = new TextEncoder().encode(
    `${CHAIN_TAG}transfer:${from}:${to}:${amount + 1}:${nonce}:${gasPrice}:${gasLimit}`);
check('verify_tampered_amount_rejected',
      lib.verify(tampered, rawSig, Uint8Array.from(Buffer.from(wallet.publicKey, 'hex'))), false);

// A signature made without the chain tag must not verify against the chain-bound message.
const unbound = new TextEncoder().encode(message.slice(CHAIN_TAG.length));
check('verify_chain_tag_stripped_rejected',
      lib.verify(unbound, rawSig, Uint8Array.from(Buffer.from(wallet.publicKey, 'hex'))), false);

// Wrong key must not verify.
check('verify_wrong_pk_rejected',
      lib.verify(msgBytes, rawSig, lib.keygen(new Uint8Array(32).fill(1)).publicKey), false);

// signQNet self-verifies: a pk that does not match the sk must throw, never emit bad bytes.
let mismatchThrew = false;
try {
    lib.signQNet(message, wallet.secretKey,
                 Buffer.from(lib.keygen(new Uint8Array(32).fill(9)).publicKey).toString('hex'));
} catch (e) {
    mismatchThrew = true;
}
check('signQNet_rejects_key_mismatch', mismatchThrew, true);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n=== SUMMARY ===');
console.log('Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) process.exit(1);

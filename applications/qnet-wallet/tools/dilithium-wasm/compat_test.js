/**
 * Wire format compatibility test.
 * Verifies that DilithiumManager's sign/verify matches Android DilithiumModule.kt format.
 */
'use strict';

const { webcrypto } = require('node:crypto');
// Node 22 has built-in globalThis.crypto; use it directly
const nodeCrypto = webcrypto || globalThis.crypto;

const fs   = require('fs');
const vm   = require('vm');
const code = fs.readFileSync(__dirname + '/../../dist/lib/noble-pq-ml-dsa.js', 'utf8');
const ctx  = { QNetDilithiumLib: null, crypto: nodeCrypto };
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

// Test 1: Sizes
check('PK_SIZE', lib.PK_SIZE, 1952);
check('SK_SIZE', lib.SK_SIZE, 4032);
check('SIG_SIZE', lib.SIG_SIZE, 3309);

// Test 2: Keygen from seed (deterministic)
const seed = new Uint8Array(32).fill(77);
const kA   = lib.keygen(seed);
const kB   = lib.keygen(seed);
const pkMatch = JSON.stringify([...kA.publicKey.slice(0,8)]) === JSON.stringify([...kB.publicKey.slice(0,8)]);
check('keygen_deterministic', pkMatch, true);
check('keygen_pk_size', kA.publicKey.length, 1952);
check('keygen_sk_size', kA.secretKey.length, 4032);

// Test 3: Wire format (mirrors Android DilithiumModule.kt)
const walletAddr = 'AbcDef1234567890abcdef';
const txBytes    = new TextEncoder().encode('transfer:100:QNET:receiver123');
const keys       = lib.keygen(new Uint8Array(32).fill(55));

// BUILD signature (mirrors DilithiumManager.signTransactionData)
const detachedSig = lib.sign(txBytes, keys.secretKey);
check('sign_detached_size', detachedSig.length, 3309);

// Construct SignedMessage = sig + msg (identical to Android: val signedMessage = sigBytes + messageBytes)
const signedMessage = new Uint8Array(detachedSig.length + txBytes.length);
signedMessage.set(detachedSig, 0);
signedMessage.set(txBytes, detachedSig.length);

// Build payload [4 LE: signedLen] [sig+msg] [4 LE: pkLen] [pk] (identical to Android putU32LE)
const pk      = keys.publicKey;
const payload = new Uint8Array(4 + signedMessage.length + 4 + pk.length);
const view    = new DataView(payload.buffer);
let   off     = 0;
view.setUint32(off, signedMessage.length, true); off += 4;
payload.set(signedMessage, off);                  off += signedMessage.length;
view.setUint32(off, pk.length, true);            off += 4;
payload.set(pk, off);

const base64Payload = Buffer.from(payload).toString('base64');
const sigStr        = 'dilithium_sig_' + walletAddr + '_' + base64Payload;

check('sigStr_prefix', sigStr.startsWith('dilithium_sig_'), true);

// PARSE (mirrors quantum_crypto.rs + DilithiumManager.verifySignature)
const lastUnderscore = sigStr.lastIndexOf('_');
const b64part        = sigStr.slice(lastUnderscore + 1);
const rawBytes       = Buffer.from(b64part, 'base64');
const dv             = new DataView(rawBytes.buffer, rawBytes.byteOffset);
let   cursor         = 0;
const signedLen      = dv.getUint32(cursor, true); cursor += 4;
const signedBytes    = rawBytes.slice(cursor, cursor + signedLen); cursor += signedLen;
const pkLen          = dv.getUint32(cursor, true); cursor += 4;
const pkParsed       = rawBytes.slice(cursor, cursor + pkLen);

check('wire_signedLen', signedLen, 3309 + txBytes.length);
check('wire_pkLen', pkLen, 1952);

const msgFromWire    = signedBytes.slice(3309);
check('msg_recovered', Buffer.from(msgFromWire).equals(Buffer.from(txBytes)), true);

const detachedFromWire = signedBytes.slice(0, 3309);
const verify_valid   = lib.verify(new Uint8Array(txBytes), new Uint8Array(detachedFromWire), new Uint8Array(pkParsed));
check('verify_valid', verify_valid, true);

const tampered = new TextEncoder().encode('transfer:100:QNET:HACKER');
const verify_tampered = lib.verify(tampered, new Uint8Array(detachedFromWire), new Uint8Array(pkParsed));
check('verify_tampered_rejected', verify_tampered, false);

const keys2 = lib.keygen(new Uint8Array(32).fill(1));
const verify_wrongKey = lib.verify(new Uint8Array(txBytes), new Uint8Array(detachedFromWire), keys2.publicKey);
check('verify_wrong_pk_rejected', verify_wrongKey, false);

// Summary
console.log('\n=== SUMMARY ===');
console.log('Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) process.exit(1);

// The shared light node vectors (docs/protocols/light-node.vectors.json), the site's side: QNet Link revision 2 with
// the site's primitives (X25519 from @noble/curves, HKDF, AES-GCM and SHA-256 from WebCrypto), the request hash, the
// check number and the AAD; the wallet hash and the EON addresses (js-sha3, WebCrypto SHA-512); the preimages the
// cabinet reads or signs, the owner binds (v1, and the payment key's v2) under WebCrypto Ed25519, the payment key's
// algorithm, and a `reserve` answer's signed reservation. The BLAKE3 and ML-DSA-65 checks run once the site declares
// @noble/hashes and @noble/post-quantum. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519';
import jsSha3 from 'js-sha3';

const { sha3_256 } = jsSha3;
const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const PKG = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const declared = (name) => Object.hasOwn(PKG.dependencies ?? {}, name);
const subtle = globalThis.crypto.subtle;
const C = V.constants.link;
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const utf8 = (s) => new TextEncoder().encode(s);
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
const wallet = (name) => V.wallets.find((w) => w.name === name);

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, key, length * 8));
}

async function decrypt(keyBytes, iv, aad, ct) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, ct));
}

const aadOf = (id, intent, reqHash) => `${C.aadPrefix}${id}|${intent}${reqHash ? `|${reqHash}` : ''}`;
const requestText = (intent, r) => JSON.stringify(Object.fromEntries(C.requestKeys[intent].map((k) => [k, r[k]])));

async function eonOf(publicKey) {
  const full = hex(await subtle.digest('SHA-512', publicKey));
  const head = `${full.slice(0, 19)}eon${full.slice(19, 34)}`;
  return `${head}${sha3_256(head).slice(0, 8)}`;
}

test('the vectors carry the revision 2 constants the cabinet relies on', () => {
  assert.equal(C.prefix, 'https://link.aiqnet.io/l#v1.');
  assert.deepEqual(C.intents, ['connect', 'link', 'claim', 'reserve', 'unlink']);
  assert.equal(C.androidPackage, 'io.aiqnet.wallet');
  assert.equal(C.sessionBodyMaxBytes, 2048);
  assert.deepEqual(C.caps.link, { plaintext: 8192, ct: 8208, body: 12288 });
  assert.deepEqual(C.caps.reserve, { plaintext: 8192, ct: 8208, body: 12288 });
  assert.deepEqual(C.requestKeys.reserve, ['walletHash', 'burner']);
  assert.deepEqual(C.caps.unlink, { plaintext: 1024, ct: 1040, body: 4096 });
  assert.deepEqual(C.requestKeys.unlink, ['walletHash']);
  assert.deepEqual(C.errors.unlink, ['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']);
  assert.deepEqual(C.reserveWindow, { pastSeconds: 900, futureSeconds: 300 });
  assert.deepEqual(V.constants.siteRecord, { origin: 'https://aiqnet.io', header: 'QNet Signed Message:\n', context: 'QNET_OFFCHAIN_MSG_v1', cluster: 'devnet' });
  assert.equal(C.consentWindow.pastSeconds, 86400);
  const re = new RegExp(C.pattern);
  for (const c of V.link.cases) assert.match(c.link, re, c.name);
  for (const n of V.link.invalidLinks.filter((l) => l.reason.startsWith('activate'))) assert.doesNotMatch(n.link, re, n.reason);
});

test('every link case: keys, check number, request hash, AAD and answer, with the site\'s primitives', async () => {
  for (const c of V.link.cases) {
    assert.equal(hex(x25519.getPublicKey(bytes(c.sitePrivateKey))), c.sitePublicKey, c.name);
    const shared = x25519.getSharedSecret(bytes(c.sitePrivateKey), bytes(c.appPublicKey));
    assert.equal(hex(shared), c.sharedSecret, c.name);
    const key = await hkdf(shared, bytes(c.sessionId), C.hkdfInfo, 32);
    assert.equal(hex(key), c.key, c.name);
    const n = Buffer.from(await hkdf(shared, bytes(c.sessionId), C.sasInfo, 4)).readUInt32BE(0) % 1000000;
    assert.equal(String(n).padStart(6, '0'), c.checkNumber, c.name);
    assert.equal(c.checkNumberDisplay, `${c.checkNumber.slice(0, 3)} ${c.checkNumber.slice(3)}`);
    assert.equal(c.checkNumberShown, c.request?.check === true, c.name);
    if (c.request) {
      assert.equal(requestText(c.intent, c.request), c.requestText, c.name);
      assert.equal(b64u(await subtle.digest('SHA-256', utf8(c.requestText))), c.reqHash, c.name);
    } else {
      assert.equal(c.reqHash, null, c.name);
    }
    assert.equal(aadOf(c.sessionId, c.intent, c.reqHash), c.aad, c.name);
    assert.equal(JSON.stringify(c.sessionRequest), JSON.stringify({ id: c.sessionId, sitePub: b64u(bytes(c.sitePublicKey)), intent: c.intent, ...(c.request ? { request: c.request } : {}) }));
    assert.equal(await decrypt(key, fromB64u(c.responseRequest.iv), c.aad, fromB64u(c.responseRequest.ct)), c.plaintext, c.name);
  }
});

test('the answers that must not decrypt do not', async () => {
  for (const f of V.link.cryptoMustFail) {
    const shared = x25519.getSharedSecret(bytes(f.sitePrivateKey), fromB64u(f.appPub));
    const key = await hkdf(shared, bytes(f.sessionId), C.hkdfInfo, 32);
    await assert.rejects(decrypt(key, fromB64u(f.iv), aadOf(f.sessionId, f.intent, f.reqHash), fromB64u(f.ct)), f.name);
  }
});

test('wallet addresses, wallet hashes and the consent answer\'s key', async () => {
  for (const w of V.wallets) {
    assert.equal(await eonOf(bytes(w.publicKey)), w.address, w.name);
    assert.equal(sha3_256(bytes(w.publicKey)), w.publicKeySha3, w.name);
    assert.equal(sha3_256(`${C.walletHashPrefix}${w.address}`).slice(0, 16), w.walletHash, w.name);
  }
  for (const c of V.link.cases.filter((x) => x.intent === 'link' && JSON.parse(x.plaintext).status === 'ok')) {
    const a = JSON.parse(c.plaintext);
    assert.equal(await eonOf(fromB64u(a.consent.pk)), a.qnet, c.name);
  }
});

test('the consent and owner bind preimages, and the owner bind under WebCrypto Ed25519', async () => {
  const key = await subtle.importKey('raw', bytes(V.burner.publicKey), { name: 'Ed25519' }, false, ['verify']);
  for (const n of V.node) {
    const w = wallet(n.wallet);
    const consent = n.messages.find((m) => m.name === 'consent');
    const i = consent.inputs;
    assert.equal(consent.preimage, `${V.constants.chainTag}client_node_reg:${i.nodeId}:${i.wallet}:${i.proof}:${i.ts}`);
    const bind = n.messages.find((m) => m.name === 'ownerBind');
    const b = bind.inputs;
    assert.equal(bind.preimage, `qnet_onchain_reg:${b.nodeId}:${b.wallet}:${b.proof}:${b.ts}:${sha3_256(bytes(w.publicKey))}:${b.burnTx}`);
    assert.equal(await subtle.verify({ name: 'Ed25519' }, key, bytes(bind.signature), utf8(bind.preimage)), true, n.wallet);
    assert.equal(await subtle.verify({ name: 'Ed25519' }, key, bytes(bind.signature), utf8(`${bind.preimage}x`)), false, n.wallet);
  }
});

// C4: the payment key's v2 owner bind, with no time, under WebCrypto Ed25519 (the payment key's algorithm).
test('the v2 owner bind preimage, and its signature under WebCrypto Ed25519', async () => {
  const key = await subtle.importKey('raw', bytes(V.burner.publicKey), { name: 'Ed25519' }, false, ['verify']);
  for (const n of V.node) {
    const w = wallet(n.wallet);
    const bind = n.messages.find((m) => m.name === 'ownerBindV2');
    const b = bind.inputs;
    assert.deepEqual(Object.keys(b), ['nodeId', 'wallet', 'proof', 'walletPublicKeySha3', 'burnTx']);
    assert.equal(bind.preimage, `qnet_burn_owner_v2:${b.nodeId}:${b.wallet}:${b.proof}:${sha3_256(bytes(w.publicKey))}:${b.burnTx}`);
    assert.equal(bind.signer, 'burner');
    assert.equal(await subtle.verify({ name: 'Ed25519' }, key, bytes(bind.signature), utf8(bind.preimage)), true, n.wallet);
    // The v1 bind's signature never stands for it.
    assert.equal(await subtle.verify({ name: 'Ed25519' }, key, bytes(n.messages.find((m) => m.name === 'ownerBind').signature), utf8(bind.preimage)), false, n.wallet);
  }
});

test('node ids and proofs (BLAKE3)', declared('@noble/hashes') ? {} : { skip: 'the site declares @noble/hashes with the cabinet' }, async () => {
  const { blake3 } = await import('@noble/hashes/blake3.js');
  for (const w of V.wallets) assert.equal(`light_mobile_${hex(blake3(utf8(`LIGHT_NODE_PRIVACY_${w.address}`))).slice(0, 16)}`, w.nodeId);
  for (const n of V.node) assert.equal(hex(blake3(utf8(`${n.burnTx}:${n.nodeId}:${wallet(n.wallet).address}`))).slice(0, 32), n.proof);
});

const withPq = declared('@noble/post-quantum') && declared('@noble/hashes');
test('the consent signatures (ML-DSA-65, empty context)', withPq ? {} : { skip: 'the site declares @noble/post-quantum with the cabinet' }, async () => {
  const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js');
  const { blake3 } = await import('@noble/hashes/blake3.js');
  for (const c of V.link.cases.filter((x) => x.intent === 'link' && JSON.parse(x.plaintext).status === 'ok')) {
    const a = JSON.parse(c.plaintext);
    const proof = hex(blake3(utf8(`${c.request.burnTx}:${a.nodeId}:${a.qnet}`))).slice(0, 32);
    const preimage = `${V.constants.chainTag}client_node_reg:${a.nodeId}:${a.qnet}:${proof}:${a.consent.ts}`;
    assert.equal(ml_dsa65.verify(fromB64u(a.consent.sig), utf8(preimage), fromB64u(a.consent.pk)), true, c.name);
  }
  for (const n of V.node) {
    const consent = n.messages.find((m) => m.name === 'consent');
    assert.equal(ml_dsa65.verify(bytes(consent.signature), utf8(consent.preimage), bytes(wallet(n.wallet).publicKey)), true);
  }
  // A `reserve` answer: the wallet's signature over the site-record envelope of its reservation, with the context
  // QNET_OFFCHAIN_MSG_v1 (an empty context does not verify).
  const S = V.constants.siteRecord;
  for (const c of V.link.cases.filter((x) => x.intent === 'reserve' && JSON.parse(x.plaintext).status === 'ok')) {
    const a = JSON.parse(c.plaintext);
    const message = `QNet node reservation v1\nwallet: ${a.qnet}\nnode: light\nway: payment\nburner: ${c.request.burner}\ntime: ${a.time}\ncluster: ${S.cluster}`;
    const envelope = utf8(`${S.header}${S.origin}\n${utf8(message).length}\n${message}`);
    assert.equal(ml_dsa65.verify(fromB64u(a.sig), envelope, fromB64u(a.pk), { context: utf8(S.context) }), true, c.name);
    assert.equal(ml_dsa65.verify(fromB64u(a.sig), envelope, fromB64u(a.pk)), false, `${c.name}: an empty context`);
    assert.equal(await eonOf(fromB64u(a.pk)), a.qnet, c.name);
  }
});
